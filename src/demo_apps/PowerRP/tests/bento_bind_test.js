/**
 * BENTO CELL BINDING (web/bentoBind.js) — the write, in BARE NODE.
 *
 * THE FEATURE IS ONE SENTENCE: bind a widget to a cell, MOVE THE BENTO, and the
 * widget followed. Everything else here is the boundary conditions around that
 * one assertion — which point lands where under rotation/scale, what is refused,
 * that the aim is one press and the bind is one write, and that the equations the
 * handler produces are the ones the evaluator actually resolves (they are built as
 * STRINGS, so a grammar mistake would otherwise only show up as a red Inspector
 * row at paint time).
 *
 * Runs with `node tests/bento_bind_test.js` — no browser, no Vite. That is the
 * point of keeping the handler DOM-free at import.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import * as T from "../core/transform.js";
import { createRegistry } from "../core/registry.js";
// builtinRoster(), NOT allPlugins: this file SWEEPS "every shipped widget", and
// allPlugins is only the SOURCE-MODULE half of the roster — the five batch-1 widgets
// (donut, progress_bar, number, both clocks) moved to the built-in plugin-asset
// library and silently left every such sweep. See plugins/index.js builtinRoster.
import { builtinRoster, registerPlugins } from "../plugins/index.js";

const roster = builtinRoster();
import { newDocument, withNewItem, keyframed, foldState, itemFallbackName } from "../core/document.js";
import { evaluateState, isEquationValue } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { bentoCellAnchorId, bentoCellCorners, bentoCellNear } from "../plugins/bento.js";
import {
  bindLeader, bindRefusal, bindableTargets, cellMarks, centreOnAnchorExpr, centreOnAnchorPairs,
  currentAim, currentHover, mergedOverlay, nodeCentre, sameHover, BENTO_BIND_HANDLER,
} from "../web/bentoBind.js";
import { activations, canvasModes, handlerFor, migrationPlan, validatedModeCursors } from "../web/widget_handlers.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

const registry = createRegistry();
registerPlugins(registry); // BOTH halves of the roster: source modules + the built-in plugin-asset library
const bentoPlugin = registry.get("bento");

// A 300x200 2x3 bento at (100, 100) with no gaps and no padding: cell centres are
// exact round numbers, so every expectation below is written out rather than
// recomputed by the same code under test.
const BENTO = { ...bentoPlugin.defaults, x: 100, y: 100, w: 300, h: 200, rows: 2, cols: 3, rowGap: 0, colGap: 0, padding: 0, active: true };

/** Query. A fresh document holding the bento plus one widget of `type`. */
function docWith(type, extra = {}) {
  let doc = newDocument();
  let bentoId, itemId;
  [doc, bentoId] = withNewItem(doc, 0, { ...BENTO });
  [doc, itemId] = withNewItem(doc, 0, { ...registry.get(type).defaults, x: 0, y: 0, w: 40, h: 20, active: true, ...extra });
  return { doc, bentoId, itemId };
}

/** Query. A widget's WORLD box centre on slide 0 — what "sits in that cell" means. */
function worldCentre(doc, itemId) {
  const { state, errors } = evaluateState(foldState(doc, 0, 1), registry);
  assert.equal(errors.size, 0, `expression errors: ${[...errors.values()].join("; ")}`);
  const node = deriveRenderTree(state, registry).find((n) => n.itemId === itemId);
  return T.apply(node.world, (node.state.w ?? 0) / 2, (node.state.h ?? 0) / 2);
}

/** Command. Applies the handler's own pairs as keyframes (what commitPreview does). */
function bound(doc, itemId, type, bentoId, cell) {
  let out = doc;
  for (const [path, value] of bindPairs(itemId, type, bentoId, cell))
    out = keyframed(out, 0, path, value);
  return out;
}

/** Pure function. The handler's own pairs for a cell, resolved through the grid
 *  widget's DECLARED descriptor exactly as the handler resolves them. */
function bindPairs(itemId, type, bentoId, cell) {
  return centreOnAnchorPairs(itemId, registry.get(type), bentoId, bentoPlugin.cellGrid.anchorId(cell, "cm"));
}

// ── the anchor id grammar ────────────────────────────────────────────────────

test("bentoCellAnchorId is the published grammar, and rejects an id that is not", () => {
  assert.equal(bentoCellAnchorId(1, 2), "c1x2cm");
  assert.equal(bentoCellAnchorId(0, 0, "tl"), "c0x0tl");
  // Every id it can mint must be an anchor the widget actually publishes.
  const published = new Set(bentoPlugin.anchors(BENTO).map((a) => a.id));
  for (const suffix of ["tl", "tm", "tr", "ml", "cm", "mr", "bl", "bm", "br"])
    assert.ok(published.has(bentoCellAnchorId(1, 2, suffix)), `published: ${suffix}`);
  assert.throws(() => bentoCellAnchorId(0, 0, "middle"), /not a standard bbox anchor id/);
  // NO UNDERSCORE, ever: an "_" would be mis-split by the ref grammar and the id
  // would be unreferenceable (the bento file docstring's rule).
  assert.ok(!bentoCellAnchorId(11, 22).includes("_"));
});

test("bentoCellNear: the containing cell inside, the nearest cell in a gutter or outside", () => {
  const gapped = { ...BENTO, rowGap: 20, colGap: 20 };
  const inside = bentoCellNear(BENTO, 250, 150);
  assert.deepEqual([inside.r, inside.c], [1, 2]);
  // Dead centre of the vertical gutter between col 0 and col 1 → the nearer of the
  // two (a tie resolves to the earlier cell in bentoCellRects order).
  const w = (300 - 2 * 20) / 3;
  const gutter = bentoCellNear(gapped, w + 10, 30);
  assert.deepEqual([gutter.r, gutter.c], [0, 0]);
  // Far outside the widget entirely → still a cell, never null.
  const far = bentoCellNear(BENTO, -9999, -9999);
  assert.deepEqual([far.r, far.c], [0, 0]);
  assert.deepEqual([bentoCellNear(BENTO, 9999, 9999).r, bentoCellNear(BENTO, 9999, 9999).c], [1, 2]);
});

// ── the equations ────────────────────────────────────────────────────────────

test("centreOnAnchorPairs writes BOTH coordinates, by item id, with the centre offset", () => {
  const pairs = centreOnAnchorPairs("w1", { defaults: { scale: 1 } }, "b1", "c0x1cm");
  assert.deepEqual(pairs, [
    [["items", "w1", "x"], "@b1_c0x1cm.x - self.w * self.scale / 2"],
    [["items", "w1", "y"], "@b1_c0x1cm.y - self.h * self.scale / 2"],
  ]);
  // A widget that declares no `scale` gets the scale-free form rather than a
  // reference that would throw at evaluation (the magnifier is the one such widget).
  assert.equal(centreOnAnchorExpr("b1", "c0x0cm", { key: "x", sizeKey: "w", coord: "x" }, { defaults: {} }), "@b1_c0x0cm.x - self.w / 2");
  assert.equal(registry.get("magnifier").defaults.scale, undefined, "the scale-free branch has a real consumer");
});

test("the pairs land on NUMERIC slots, so a bare string IS the equation", () => {
  for (const [path, value] of bindPairs("w1", "rect", "b1", { r: 0, c: 0 }))
    assert.ok(isEquationValue(registry.get("rect"), [path[2]], value), `${path[2]} reads as an equation`);
});

// ── THE FEATURE ──────────────────────────────────────────────────────────────

test("THE FEATURE: bound to a cell, the widget follows the bento when it MOVES", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  const b = bound(doc, itemId, "rect", bentoId, { r: 1, c: 2 });
  // cell (1,2) centre = (100 + 250, 100 + 150)
  assert.deepEqual(worldCentre(b, itemId), { x: 350, y: 250 });
  let moved = keyframed(b, 0, ["items", bentoId, "x"], 500);
  moved = keyframed(moved, 0, ["items", bentoId, "y"], 700);
  assert.deepEqual(worldCentre(moved, itemId), { x: 750, y: 850 }, "the widget FOLLOWED");
  // …and when it RESIZES (the cell centre moves with the grid, no re-run needed).
  const wider = keyframed(b, 0, ["items", bentoId, "w"], 600);
  assert.deepEqual(worldCentre(wider, itemId), { x: 600, y: 250 });
  // …and when its GRID SHAPE changes (arrangeSelectionIntoGrid's flagged follow-up:
  // editing rows/cols in the Inspector AUTO-reflows a bound widget).
  // 4 rows over 200 → row 1's centre is 100 + 50 · 1.5 = 175, not the 150 it was.
  const reshaped = keyframed(b, 0, ["items", bentoId, "rows"], 4);
  assert.deepEqual(worldCentre(reshaped, itemId), { x: 350, y: 175 });
});

test("the WIDGET's own centre is what lands, at any rotation and any scale", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  let b = bound(doc, itemId, "rect", bentoId, { r: 1, c: 2 });
  b = keyframed(b, 0, ["items", itemId, "rotation"], Math.PI / 5);
  b = keyframed(b, 0, ["items", itemId, "scale"], 2.5);
  const c = worldCentre(b, itemId);
  assert.ok(Math.abs(c.x - 350) < 1e-9 && Math.abs(c.y - 250) < 1e-9, `rotated+scaled centre ${JSON.stringify(c)}`);
});

test("a ROTATED bento carries the bound widget to the rotated cell centre", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  let b = bound(doc, itemId, "rect", bentoId, { r: 1, c: 2 });
  b = keyframed(b, 0, ["items", bentoId, "rotation"], Math.PI / 2);
  // The bento pivots about its own centre (250, 200); rotating (350, 250) by 90°
  // about it gives (200, 300).
  const c = worldCentre(b, itemId);
  assert.ok(Math.abs(c.x - 200) < 1e-9 && Math.abs(c.y - 300) < 1e-9, `${JSON.stringify(c)}`);
});

test("a cell that stops existing fails LOUDLY, it does not silently drift", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  let b = bound(doc, itemId, "rect", bentoId, { r: 1, c: 2 });
  b = keyframed(b, 0, ["items", bentoId, "cols"], 2); // c1x2 is gone
  const { errors } = evaluateState(foldState(b, 0, 1), registry);
  const text = [...errors.values()].join("\n");
  assert.ok(errors.size > 0 && /no anchor "c1x2cm"/.test(text), `errors: ${text}`);
});

// ── the refusals ─────────────────────────────────────────────────────────────

test("REFUSED: a widget with no x/y (an endpoint widget) — the plugin's own declaration is the gate", () => {
  assert.equal(bindRefusal({ itemId: "r1", plugin: registry.get("rect") }, new Map(), "Box"), null);
  const arrow = bindRefusal({ itemId: "a1", plugin: registry.get("arrow") }, new Map(), "Arrow");
  assert.ok(arrow && /has no x \/ y to bind/.test(arrow), arrow);
});

test("REFUSED: a GROUP MEMBER — the refusal still stands, but its stated reason no longer holds", () => {
  const refusal = bindRefusal({ itemId: "w1", plugin: registry.get("rect") }, new Map([["w1", "g1"]]), "Box");
  assert.ok(refusal && /group member/.test(refusal), refusal);
  // ── THIS ASSERTION USED TO MEASURE A DEFECT, AND THE DEFECT IS FIXED ────────
  // It read `{x: 410}` — "60px past the cell" — and that overshoot WAS the
  // refusal's whole justification: web/bentoBind.js bindRefusal says verbatim
  // "a grouped widget's x / y are read in its group's frame, while a cell anchor
  // evaluates in world, so it would land off by the group's influence."
  //
  // The 60 was the group's influence being applied TWICE: core/expressions.js
  // anchorValue composed it into the cell-anchor read, and core/derive.js
  // applyGroupParenting composed it again onto the reading member's own world.
  // core/expressions.js inReaderFrame (89e1ca8) removes the second application,
  // so a bound group member now lands EXACTLY on its cell.
  //
  // HANDED BACK, NOT DECIDED HERE: whether the refusal should now be lifted is a
  // change to bento's user-visible behaviour and belongs to whoever owns
  // web/bentoBind.js. The refusal is still shipped and its first assertion above
  // still passes; only the claim that it is justified by a miscalculation has
  // stopped being true, and a test asserting a wrong number to defend a refusal
  // is exactly the ratification trap. So this measures what is TRUE now and says
  // plainly that the premise is gone.
  const { doc, bentoId, itemId } = docWith("rect");
  let b = bound(doc, itemId, "rect", bentoId, { r: 1, c: 2 });
  let gid;
  [b, gid] = withNewItem(b, 0, { ...registry.get("group").defaults, x: 0, y: 0, w: 10, h: 10, members: [itemId], active: true });
  b = keyframed(b, 0, ["items", gid, "x"], 60);
  assert.deepEqual(worldCentre(b, itemId), { x: 350, y: 250 },
    "a bound group member now lands ON its cell — the influence is applied once, not twice");
});

// ── the declaration wiring ───────────────────────────────────────────────────

test("the bento DECLARES the activation, so the double-click resolves and the bar announces it", () => {
  assert.equal(bentoPlugin.activate, "bento_bind_cell");
  assert.equal(handlerFor("activate", bentoPlugin).id, "bento_bind_cell");
  const chip = activations().find((a) => a.handlerId === "bento_bind_cell");
  assert.ok(chip, "activations() carries it — that IS the HintBar's double-click feed");
  assert.equal(chip.label, "Bind widgets to grid cells");
});

test("the CONTENT descriptor is `cellGrid`, so `claims` is a SHAPE test, not a type check", () => {
  // The handler asks the WIDGET three pure questions and imports no named plugin:
  // that is what lets a second grid widget declare `cellGrid` and get this
  // activation with no edit in web/, and it is why `claims` is not `type === "bento"`
  // (the literal type check the handler registry exists to have removed).
  const grid = bentoPlugin.cellGrid;
  for (const fn of ["at", "corners", "anchorId"]) assert.equal(typeof grid[fn], "function", fn);
  const cell = grid.at(BENTO, 250, 150);
  assert.deepEqual([cell.r, cell.c], [1, 2]);
  assert.equal(grid.anchorId(cell, "cm"), "c1x2cm");
  assert.equal(grid.corners(cell).length, 4);
  assert.equal(BENTO_BIND_HANDLER.claims({ cellGrid: { at: () => null } }), true);
  assert.equal(BENTO_BIND_HANDLER.claims({ type: "bento" }), false, "a bare type name claims NOTHING");
  // And the descriptor without the one-line declaration is a REPORTED gap, not a
  // widget that silently does nothing when double-clicked.
  assert.deepEqual(
    migrationPlan([{ type: "probe_grid", cellGrid: { at: () => null } }]).map((r) => [r.type, r.handlerId, r.edit]),
    [["probe_grid", "bento_bind_cell", 'activate: "bento_bind_cell"']],
  );
  assert.deepEqual(migrationPlan(roster), [], "…and every shipped widget declares what its shape asks for");
});

test("the mode declares two NARRATED steps and an overlay, and canvasModes() sees them", () => {
  const mode = canvasModes().find((m) => m.handlerId === "bento_bind_cell");
  assert.ok(mode, "canvasModes() carries it — that IS the HintBar's mode feed");
  assert.equal(mode.phase, "activate");
  assert.equal(mode.steps.length, 2);
  for (const s of mode.steps) assert.ok(s.hint, "every step narrates itself");
  assert.notEqual(mode.steps[0].hint, mode.steps[1].hint);
  assert.equal(typeof BENTO_BIND_HANDLER.mode.onPick, "function");
  assert.equal(BENTO_BIND_HANDLER.mode.onPan, undefined, "onPick outranks onPan; declaring both would be ambiguous");
});

test("cellMarks draws the cell as a CLOSED WORLD ring (correct under rotation)", () => {
  const CORNERS = bentoPlugin.cellGrid.corners;
  const cell = { x: 0, y: 0, w: 10, h: 20 };
  assert.deepEqual(bentoCellCorners(cell), [[0, 0], [10, 0], [10, 20], [0, 20]]);
  const quarter = cellMarks({ x: 0, y: 0, rotation: Math.PI / 2, scale: 1 }, cell, CORNERS, true);
  assert.equal(quarter.chains.length, 1);
  assert.equal(quarter.chains[0].closed, true);
  const [x, y] = quarter.chains[0].points[1]; // (10, 0) rotated 90° → (0, 10)
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 10) < 1e-9, `${x},${y}`);
  // THE PRIMARY MARK is the cell CENTRE — the anchor the equation targets, and the
  // one dot that cannot be confused with the grid's own resize handles.
  const flat = cellMarks({ x: 0, y: 0, rotation: 0, scale: 1 }, cell, CORNERS, true);
  assert.deepEqual(flat.dots[0], { x: 5, y: 10, hot: true });
  assert.equal(flat.dots.length, 5);
  assert.deepEqual(mergedOverlay([]), { chains: [], rects: [], dots: [] });
});

test("TWO STATES, TWO READINGS: a hover candidate is GHOST, a committed aim is HOT", () => {
  const CORNERS = bentoPlugin.cellGrid.corners;
  const cell = { x: 0, y: 0, w: 10, h: 20 };
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const aimed = cellMarks(world, cell, CORNERS, true);
  const hovered = cellMarks(world, cell, CORNERS, false);
  // The distinction the aim-ring defect taught: assert they DIFFER, do not eyeball it.
  assert.ok(aimed.dots.every((d) => d.hot), "the committed aim is hot (--a-guide)");
  assert.ok(hovered.dots.every((d) => !d.hot), "the hover candidate is ghost (--a-ghost)");
  assert.notDeepEqual(aimed.dots, hovered.dots);
  // …and the geometry is identical, so the ONLY difference is the reading.
  assert.deepEqual(aimed.chains, hovered.chains);
});

test("bindLeader states the bind as the two points it makes coincide", () => {
  assert.deepEqual(bindLeader({ x: 0, y: 0 }, [10, 20]).chains, [{ points: [[0, 0], [10, 20]], closed: false }]);
  assert.deepEqual(bindLeader({ x: 0, y: 0 }, [10, 20]).dots, [{ x: 0, y: 0, hot: false }, { x: 10, y: 20, hot: false }]);
  // nodeCentre reads the WORLD centre, so a scaled widget reports where it really is.
  assert.deepEqual(nodeCentre({ state: { w: 10, h: 20 }, world: { x: 0, y: 0, rotation: 0, scale: 2 } }), { x: 10, y: 20 });
});

test("sameHover compares the THING, not the record — the per-mousemove repaint guard", () => {
  // cellGrid.at returns a FRESH object per call, so an object comparison would report
  // a change on every mousemove and defeat the whole guard.
  const a = bentoPlugin.cellGrid.at(BENTO, 250, 150);
  const b = bentoPlugin.cellGrid.at(BENTO, 251, 151);
  assert.notEqual(a, b, "fresh objects");
  assert.equal(sameHover({ kind: "cell", cell: a }, { kind: "cell", cell: b }), true);
  assert.equal(sameHover({ kind: "cell", cell: a }, { kind: "cell", cell: bentoPlugin.cellGrid.at(BENTO, 10, 10) }), false);
  assert.equal(sameHover({ kind: "widget", itemId: "w1" }, { kind: "widget", itemId: "w1" }), true);
  assert.equal(sameHover({ kind: "widget", itemId: "w1" }, { kind: "cell", cell: a }), false);
  assert.equal(sameHover(null, null), true);
  assert.equal(sameHover(null, { kind: "cell", cell: a }), false);
});

test("the CURSOR names each step's question, and an unknown name is a BOOT failure", () => {
  const mode = canvasModes().find((m) => m.handlerId === "bento_bind_cell");
  // Standard CSS keywords, one per step: `cell` IS "select a cell of a grid" and
  // `alias` IS "the action creates a link" — which is what a cell binding is.
  assert.deepEqual(mode.cursors, ["cell", "alias"]);
  assert.equal(mode.cursors.length, mode.steps.length, "one cursor per step");
  assert.notEqual(mode.cursors[0], mode.cursors[1], "two questions, two cursors");
  // A name with no `.overlay.cursor-<name>` rule would leave the pointer silently
  // default, so it throws where canvasModes() runs — at boot.
  assert.throws(() => validatedModeCursors("x", ["eyedropper"]), /no .*cursor-eyedropper.* rule/);
  assert.throws(() => validatedModeCursors("x", []), /non-empty array/);
  assert.deepEqual(validatedModeCursors("x", undefined), [], "a mode may keep the default pointer");
  // And every declared name really does have a rule in the stylesheet.
  const css = readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  for (const name of mode.cursors)
    assert.ok(css.includes(`.overlay.cursor-${name}`), `app.css ships .overlay.cursor-${name}`);
});

// ── the gesture, driven through the handler with a fake app ───────────────────

/** Query. The live derived render tree for slide 0 — what app.nodes() returns. */
function liveNodes(doc) {
  return deriveRenderTree(evaluateState(foldState(doc, 0, 1), registry).state, registry);
}

/**
 * Command. A minimal app stand-in recording what the handler asked for.
 *
 * `displayName` is the REAL rule, not a stub: the app's own `name`-else-
 * itemFallbackName, calling the same shared helper. A stub returning the id would
 * make the "never a raw uuid" assertion below vacuous, which is the class of test
 * that passes while the feature is broken.
 */
function fakeApp(doc, nodes) {
  const byId = new Map(nodes.map((n) => [n.itemId, n]));
  return {
    doc, nodes: () => nodes, previews: [], commits: 0, steps: [], selection: null,
    displayName(id) {
      const n = byId.get(id);
      if (!n) return id;
      return n.state.name ?? itemFallbackName(registry.get(n.state.type).title, id);
    },
    setPreview(pairs) { this.previews.push(pairs); },
    commitPreview() { this.commits++; },
    setCanvasModeStep(s) { this.steps.push(s); },
  };
}

test("the GESTURE: press 1 aims a cell, press 2 binds — ONE write, ONE commit", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  const { state } = evaluateState(foldState(doc, 0, 1), registry);
  const nodes = deriveRenderTree(state, registry);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);
  const rectNode = nodes.find((n) => n.itemId === itemId);
  const app = fakeApp(doc, nodes);
  const ctx = { app, node: bentoNode, plugin: bentoPlugin };
  const { onPick } = BENTO_BIND_HANDLER.mode;

  BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });
  assert.equal(app.selection, bentoId);

  // PRESS 1 — inside cell (1,2). Read as a POINT in the bento's frame, so it aims
  // even though the hit-test would have handed back some other widget.
  onPick(ctx, { node: rectNode, world: { x: 350, y: 250 }, local: { x: 250, y: 150 } });
  assert.deepEqual(app.previews, [], "aiming writes NOTHING to the document");
  assert.deepEqual(app.steps, [1], "the bar moves to the bind step");
  assert.ok(BENTO_BIND_HANDLER.mode.overlay(ctx).chains.length === 1, "the aimed cell is drawn");

  // PRESS 2 — on the widget. Binds it.
  onPick(ctx, { node: rectNode, world: { x: 0, y: 0 }, local: { x: -100, y: -100 } });
  assert.equal(app.previews.length, 1, "ONE setPreview → ONE undo unit");
  assert.equal(app.commits, 1);
  assert.deepEqual(app.previews[0], bindPairs(itemId, "rect", bentoId, { r: 1, c: 2 }));
  assert.deepEqual(app.steps, [1, 0], "and back to aiming, ready for the next cell");
  assert.equal(BENTO_BIND_HANDLER.mode.list(ctx), null, "the aim is spent, so the list has nothing to act on");
  assert.deepEqual(BENTO_BIND_HANDLER.mode.overlay(ctx).chains, [], "the aim is cleared");
});

test("a bind-step press on the BENTO re-aims instead of binding it to itself", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  const { state } = evaluateState(foldState(doc, 0, 1), registry);
  const nodes = deriveRenderTree(state, registry);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);
  const app = fakeApp(doc, nodes);
  const ctx = { app, node: bentoNode, plugin: bentoPlugin };
  BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: bentoNode, world: {}, local: { x: 250, y: 150 } });
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: bentoNode, world: {}, local: { x: 50, y: 50 } });
  assert.deepEqual(app.previews, [], "nothing bound");
  const ring = BENTO_BIND_HANDLER.mode.overlay(ctx).chains[0].points;
  // Re-aimed onto cell (0,0): its top-left corner is the bento's own origin.
  assert.deepEqual(ring[0], [100, 100]);
  // A press on EMPTY canvas re-aims too, so no press is ever inert.
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: null, world: {}, local: { x: 250, y: 150 } });
  // local (250,150) is cell (1,2); its top-left corner is local (200,100) → world (300,200).
  assert.deepEqual(BENTO_BIND_HANDLER.mode.overlay(ctx).chains[0].points[0], [300, 200]);
  assert.deepEqual(app.previews, []);
});

test("a REFUSED target writes nothing and leaves the aim intact", () => {
  const { doc, bentoId } = docWith("arrow", { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } });
  const { state } = evaluateState(foldState(doc, 0, 1), registry);
  const nodes = deriveRenderTree(state, registry);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);
  const arrowNode = nodes.find((n) => n.type === "arrow");
  const app = fakeApp(doc, nodes);
  const ctx = { app, node: bentoNode, plugin: bentoPlugin };
  BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: arrowNode, world: {}, local: { x: 250, y: 150 } }); // aim
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: arrowNode, world: {}, local: { x: 0, y: 0 } });     // refused
  assert.deepEqual(app.previews, []);
  assert.equal(app.commits, 0);
  assert.equal(BENTO_BIND_HANDLER.mode.overlay(ctx).chains.length, 1, "still aimed — try another widget");
});

// ── hover (TARGET feedback) ──────────────────────────────────────────────────

test("HOVER previews the cell BEFORE the press, and writes NOTHING", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  const nodes = liveNodes(doc);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);
  const app = fakeApp(doc, nodes);
  const ctx = { app, node: bentoNode, plugin: bentoPlugin };
  const { onHover, onHoverLeave, overlay } = BENTO_BIND_HANDLER.mode;
  BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });

  // Nothing aimed, pointer over cell (1,2): the press would AIM, so the CELL is the
  // candidate — drawn ghost, and the document is untouched.
  assert.equal(onHover(ctx, { node: null, world: {}, local: { x: 250, y: 150 } }), true);
  assert.deepEqual(currentHover(), { kind: "cell", cell: bentoPlugin.cellGrid.at(BENTO, 250, 150) });
  assert.deepEqual(app.previews, [], "hovering writes NOTHING");
  assert.equal(currentAim().cell, null, "…and aims nothing");
  const hov = overlay(ctx);
  assert.equal(hov.chains.length, 1);
  assert.ok(hov.dots.every((d) => !d.hot), "a hover candidate is ghost, never hot");

  // MOVING WITHIN the same cell reports NO change, so the overlay is not reassigned
  // on every mousemove — the guard, asserted rather than assumed.
  assert.equal(onHover(ctx, { node: null, world: {}, local: { x: 251, y: 151 } }), false);
  // CROSSING into another cell does.
  assert.equal(onHover(ctx, { node: null, world: {}, local: { x: 10, y: 10 } }), true);
  assert.deepEqual([currentHover().cell.r, currentHover().cell.c], [0, 0]);
  assert.notDeepEqual(overlay(ctx).chains[0].points, hov.chains[0].points, "the highlight MOVED");

  // Leaving the canvas drops it — no preview outlives the pointer.
  assert.equal(onHoverLeave(), true);
  assert.equal(currentHover(), null);
  assert.equal(onHoverLeave(), false, "…idempotent, so no repaint is asked for twice");
  assert.deepEqual(overlay(ctx), { chains: [], rects: [], dots: [] });
  assert.deepEqual(app.previews, []);
});

test("with a cell AIMED, hovering a widget previews the BIND as a leader to the cell", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  const nodes = liveNodes(doc);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);
  const rectNode = nodes.find((n) => n.itemId === itemId);
  const app = fakeApp(doc, nodes);
  const ctx = { app, node: bentoNode, plugin: bentoPlugin };
  BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: null, world: {}, local: { x: 250, y: 150 } }); // aim (1,2)

  assert.equal(BENTO_BIND_HANDLER.mode.onHover(ctx, { node: rectNode, world: {}, local: { x: -99, y: -99 } }), true);
  assert.equal(currentHover().kind, "widget");
  const ov = BENTO_BIND_HANDLER.mode.overlay(ctx);
  // The aimed cell (hot) PLUS the leader (ghost) — both, so the user sees the pairing.
  assert.ok(ov.dots.some((d) => d.hot), "the committed aim is still hot");
  assert.ok(ov.dots.some((d) => !d.hot), "the hover leader is ghost");
  const leader = ov.chains.find((c) => c.closed === false);
  assert.ok(leader, "an OPEN 2-point chain is the leader");
  assert.deepEqual(leader.points[0], [nodeCentre(rectNode).x, nodeCentre(rectNode).y]);
  assert.deepEqual(leader.points[1], [350, 250], "…and it ends at the aimed cell centre");
  assert.deepEqual(app.previews, [], "still writes NOTHING");
  // Over the GRID instead, the press would re-aim, so the preview is a cell again.
  BENTO_BIND_HANDLER.mode.onHover(ctx, { node: bentoNode, world: {}, local: { x: 10, y: 10 } });
  assert.equal(currentHover().kind, "cell");
});

// ── the LIST (step 1's second input path) ────────────────────────────────────

test("the list is ABSENT until a cell is aimed, then names the aimed cell's anchor", () => {
  const { doc, bentoId } = docWith("rect");
  const nodes = liveNodes(doc);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);
  const app = fakeApp(doc, nodes);
  const ctx = { app, node: bentoNode, plugin: bentoPlugin };
  BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });
  assert.equal(BENTO_BIND_HANDLER.mode.list(ctx), null, "no cell aimed → nothing to bind into");
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: null, world: {}, local: { x: 250, y: 150 } });
  const list = BENTO_BIND_HANDLER.mode.list(ctx);
  // The REFERENCEABLE anchor id, because that exact string is what the Inspector
  // shows in the equation afterwards.
  assert.equal(list.label, "c1x2cm");
  assert.equal(typeof list.pick, "function");
  assert.equal(typeof list.hover, "function");
});

test("bindableTargets: the GRID is absent (a cycle), refusals are PRESENT and greyed", () => {
  let doc = newDocument();
  let bentoId, rectId, arrowId, memberId, groupId, otherBentoId;
  [doc, bentoId] = withNewItem(doc, 0, { ...BENTO });
  [doc, rectId] = withNewItem(doc, 0, { ...registry.get("rect").defaults, x: 0, y: 0, w: 40, h: 20, name: "Card", active: true });
  [doc, arrowId] = withNewItem(doc, 0, { ...registry.get("arrow").defaults, active: true });
  [doc, memberId] = withNewItem(doc, 0, { ...registry.get("rect").defaults, x: 0, y: 0, w: 10, h: 10, active: true });
  [doc, groupId] = withNewItem(doc, 0, { ...registry.get("group").defaults, x: 0, y: 0, w: 10, h: 10, members: [memberId], active: true });
  [doc, otherBentoId] = withNewItem(doc, 0, { ...BENTO, x: 900 });
  const app = fakeApp(doc, liveNodes(doc));
  const rows = bindableTargets(app, { itemId: bentoId });
  const byId = new Map(rows.map((r) => [r.itemId, r]));

  assert.equal(byId.has(bentoId), false, "the GRID ITSELF is not offered — binding it to its own cell is a cycle");
  assert.equal(byId.get(rectId).refusal, null, "an ordinary widget is pickable");
  assert.equal(byId.get(rectId).name, "Card", "…named by the item's own name, never a raw uuid");
  // AVAILABILITY GREYS, IT DOES NOT HIDE (the palette's ruling): both refusals are
  // PRESENT with a reason, because a widget silently absent from the list would leave
  // the user hunting for something that is right there on the canvas.
  assert.ok(byId.has(arrowId) && /has no x \/ y to bind/.test(byId.get(arrowId).refusal));
  assert.ok(byId.has(memberId) && /group member/.test(byId.get(memberId).refusal));
  // THE CAMERA: greyed with its reason, never hidden — FLAGGED for ratification (see
  // bindRefusal). The gate is the document model's own `purgeable: false`, the same
  // marker Delete and Purge read, so it is not a type check invented here.
  const cameraRow = rows.find((r) => r.node.type === "camera");
  assert.ok(cameraRow, "the camera is PRESENT (never hidden)");
  assert.match(cameraRow.refusal, /is the view, not content/);
  // ANOTHER grid IS offered — a sub-grid inside a panel cell is a real layout, so
  // excluding it would be an invented restriction.
  assert.equal(byId.get(otherBentoId).refusal, null);
  // A widget with no `name` still reads as something human: the shared
  // "<Type> (id-prefix)" fallback, never a bare uuid.
  assert.match(byId.get(arrowId).name, /^Arrow \(/, `fallback name: ${byId.get(arrowId).name}`);
});

test("BOTH INPUT PATHS PRODUCE THE SAME BINDING — same pairs, one commit each", () => {
  const cell = { r: 1, c: 2 };
  /** Command. Runs one full aim+bind through `viaList` or the canvas, returning the
   *  fake app so the two can be compared leaf for leaf. */
  const runPath = (viaList) => {
    const { doc, bentoId, itemId } = docWith("rect");
    const nodes = liveNodes(doc);
    const bentoNode = nodes.find((n) => n.itemId === bentoId);
    const rectNode = nodes.find((n) => n.itemId === itemId);
    const app = fakeApp(doc, nodes);
    const ctx = { app, node: bentoNode, plugin: bentoPlugin };
    BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });
    BENTO_BIND_HANDLER.mode.onPick(ctx, { node: null, world: {}, local: { x: 250, y: 150 } });
    if (viaList) BENTO_BIND_HANDLER.mode.list(ctx).pick(rectNode);
    else BENTO_BIND_HANDLER.mode.onPick(ctx, { node: rectNode, world: {}, local: { x: -99, y: -99 } });
    return { app, itemId, bentoId };
  };
  const canvas = runPath(false);
  const list = runPath(true);
  // Ids differ per document, so compare the pairs with each run's OWN ids substituted
  // out — what must match is the SHAPE and the values, i.e. the binding itself.
  const normalize = (r) => JSON.stringify(r.app.previews).split(r.itemId).join("<ITEM>").split(r.bentoId).join("<GRID>");
  assert.equal(normalize(list), normalize(canvas), "the list pick and the canvas click write the IDENTICAL binding");
  assert.equal(list.app.commits, 1, "ONE undo unit from the list");
  assert.equal(canvas.app.commits, 1, "ONE undo unit from the canvas");
  assert.deepEqual(list.app.steps, canvas.app.steps, "…and both leave the bar in the same place");
});

test("the list's pick REFUSES a greyed target through the same guard, writing nothing", () => {
  const { doc, bentoId } = docWith("arrow", { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } });
  const nodes = liveNodes(doc);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);
  const arrowNode = nodes.find((n) => n.type === "arrow");
  const app = fakeApp(doc, nodes);
  const ctx = { app, node: bentoNode, plugin: bentoPlugin };
  BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: null, world: {}, local: { x: 250, y: 150 } });
  assert.equal(BENTO_BIND_HANDLER.mode.list(ctx).pick(arrowNode), false, "refused");
  assert.deepEqual(app.previews, []);
  assert.equal(app.commits, 0);
  assert.ok(BENTO_BIND_HANDLER.mode.list(ctx), "…and the cell stays aimed, so another row can be tried");
});

test("a list row's hover feeds the SAME record the canvas hover does", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  const nodes = liveNodes(doc);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);
  const rectNode = nodes.find((n) => n.itemId === itemId);
  const app = fakeApp(doc, nodes);
  const ctx = { app, node: bentoNode, plugin: bentoPlugin };
  BENTO_BIND_HANDLER.run({ app, node: bentoNode, enterMode() {} });
  BENTO_BIND_HANDLER.mode.onPick(ctx, { node: null, world: {}, local: { x: 250, y: 150 } });
  const { hover } = BENTO_BIND_HANDLER.mode.list(ctx);
  assert.equal(hover(rectNode), true);
  // Byte-for-byte the record a CANVAS hover of the same widget produces — one
  // concept, so a row's highlight IS the canvas highlight.
  assert.deepEqual(currentHover(), { kind: "widget", itemId, centre: nodeCentre(rectNode) });
  assert.equal(hover(rectNode), false, "no repaint asked for when nothing changed");
  assert.equal(hover(null), true);
  assert.equal(currentHover(), null, "leaving the row clears it");
  assert.deepEqual(app.previews, [], "row hover writes NOTHING");
});

// ── the way out ──────────────────────────────────────────────────────────────

test("UNBINDING is the EXISTING freeze: an equation on x/y is recognised as bound", () => {
  const { doc, bentoId, itemId } = docWith("rect");
  const b = bound(doc, itemId, "rect", bentoId, { r: 1, c: 2 });
  const raw = foldState(b, 0, 1);
  const rect = registry.get("rect");
  // This is exactly the predicate App.svelte's cameraFreezeWrite filters on, so
  // "Unbind Position & Size (freeze x/y/w/h to numbers)" enables and freezes a cell
  // binding with no new command — it is deliberately not camera-specific.
  for (const key of ["x", "y"]) assert.ok(isEquationValue(rect, [key], raw.items[itemId][key]), key);
  const { state } = evaluateState(raw, registry);
  assert.equal(state.items[itemId].x, 350 - 40 / 2);
  assert.equal(state.items[itemId].y, 250 - 20 / 2);
});

console.log(`\n${passed} bento-bind tests passed`);
