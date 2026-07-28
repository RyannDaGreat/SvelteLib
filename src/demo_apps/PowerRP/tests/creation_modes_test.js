/**
 * CREATION MODES guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/creation_modes_test.js
 *
 * The step-sequencing capability behind the two multi-gesture placements — a
 * polygon's click-click-click and the telescopic magnifier's two drags — plus the
 * registry wiring that makes them exist. Everything here is DOM-free by design
 * (web/creationSteps.js, web/polygonDraw.js and web/telescopicRig.js import only
 * pure plugin geometry), which is the whole reason a node suite can cover the
 * decisions and the browser probe only has to cover the pointer plumbing.
 *
 * WHAT IT PROVES
 *   (1) a malformed step list throws AT DECLARATION (unknown gesture, missing hint,
 *       an unreachable step after a repeating one, a box step with no click extent);
 *   (2) both flows' session logic: N clicks → N vertices, Shift axis-locks against
 *       the PREVIOUS vertex, a click on the first vertex closes the loop (and only
 *       once a loop can enclose an area), a repeated click adds nothing (which is
 *       what makes double-click-to-finish work), two boxes complete the rig;
 *   (3) finalize writes the document EXACTLY ONCE, and ABANDONS below the minimum
 *       (a 1-vertex polygon, a 1-box rig) rather than leaving a ghost;
 *   (4) the HintBar narrates each step and NOTHING else does — step 0's wording
 *       cannot show at step 1, and each step's declared modifiers get their chips;
 *   (5) the rig's rect-parameterized equations really put the lens ON the second
 *       dragged box at t=1 and ON the source at t=0 (evaluated, not string-matched).
 */

import assert from "node:assert/strict";
import { newDocument, withNewItem, keyframed, foldState } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { createShortcuts, MOUSE_DOUBLE_TOKEN } from "../core/shortcuts.js";
import {
  handShortcutEntries, hintProbeContexts, canvasModeStepAxis,
} from "../core/shortcut_entries.js";
import { DRAG_KINDS, DRAG_KIND_MODIFIERS } from "../web/canvas/dragKinds.js";
import { activations, canvasModes, findHandler, handlerFor, handlerIds, phaseNames } from "../web/widget_handlers.js";
import { CREATION_GESTURES, creationPointer, currentStepIndex, validatedSteps } from "../web/creationSteps.js";
import { POLYGON_CHAIN_HANDLER, closesLoop, constrainedVertex, repeatsLastVertex } from "../web/polygonDraw.js";
import { TELESCOPIC_RIG_HANDLER } from "../web/telescopicRig.js";
import { polygonPlugin } from "../plugins/polygon.js";
import {
  TELESCOPIC, telescopicDefaultRects, telescopicSourceOverrides,
  telescopicLensOverrides, telescopicTangentOverrides, rectCenter,
} from "../plugins/tangent_lines.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The grab radius every session call uses here — SNAP_PX at zoom 1, the value
 *  CanvasView passes (SNAP_PX / viewport.zoom). */
const TOL = 8;
const NO_MODS = { uniform: false, symmetric: false };
const SHIFT = { uniform: true, symmetric: false };

/** Command (allocates). A recording stand-in for the app store: the two document
 *  writes a finalize may make, counted. */
function fakeApp() {
  const calls = { addItem: [], rig: [] };
  return {
    calls,
    addItem(state) { calls.addItem.push(state); },
    insertTelescopicMagnifier(shapeKind, source, lens) { calls.rig.push({ shapeKind, source, lens }); },
  };
}

/** Command (allocates). The creation context a host builds, with `finish()` as the
 *  deferred REQUEST it really is. */
function ctxFor(app, { plugin = null, params = {} } = {}) {
  const ctx = { app, plugin, params, finishRequested: false, finish() { ctx.finishRequested = true; } };
  return ctx;
}

/** Command. Drives a polygon session through a list of [world, mods] clicks,
 *  hovering before each one exactly as the host does. Returns {session, ctx}. */
function drawPolygon(app, clicks) {
  const mode = POLYGON_CHAIN_HANDLER.mode;
  const session = mode.begin({});
  let ctx = ctxFor(app, { plugin: polygonPlugin });
  for (const [world, mods] of clicks) {
    const p = creationPointer(world, mods, TOL, null);
    mode.onHover(session, p);
    ctx = ctxFor(app, { plugin: polygonPlugin });
    mode.onStep(ctx, session, p);
    if (ctx.finishRequested) break;
  }
  return { session, ctx };
}

// ── (1) DECLARATION-TIME VALIDATION ──────────────────────────────────────────
test("validatedSteps: a malformed step list throws at declaration, naming the fix", () => {
  assert.throws(() => validatedSteps("x", []), /non-empty array/);
  assert.throws(() => validatedSteps("x", [{ gesture: "blob", hint: "?" }]), /unknown gesture "blob"/);
  assert.throws(() => validatedSteps("x", [{ gesture: "point" }]), /no `hint`/);
  assert.throws(
    () => validatedSteps("x", [{ gesture: "point", hint: "a", repeat: true }, { gesture: "point", hint: "b" }]),
    /unreachable/,
  );
  assert.throws(() => validatedSteps("x", [{ gesture: "box", hint: "a" }]), /must declare .clickSize/);
  assert.throws(() => validatedSteps("x", [{ gesture: "box", hint: "a", clickSize: { w: 0, h: 5 } }]), /must declare .clickSize/);
  // The two SHIPPED step lists are well-formed (they are validated at import, so
  // this is really asserting the modules loaded — kept explicit so a future step
  // list that only breaks under a lazy import still fails here).
  assert.deepEqual(POLYGON_CHAIN_HANDLER.mode.steps.map((s) => s.gesture), ["point"]);
  assert.deepEqual(TELESCOPIC_RIG_HANDLER.mode.steps.map((s) => s.gesture), ["box", "box"]);
  for (const { steps } of canvasModes())
    for (const s of steps) assert.ok(CREATION_GESTURES.includes(s.gesture));
});

test("currentStepIndex: a repeating final step never runs out; a fixed list clamps", () => {
  const two = [{ gesture: "box", hint: "a" }, { gesture: "box", hint: "b" }];
  assert.equal(currentStepIndex(two, 0), 0);
  assert.equal(currentStepIndex(two, 1), 1);
  assert.equal(currentStepIndex(two, 9), 1); // the last gesture is still in flight
  assert.equal(currentStepIndex([{ gesture: "point", hint: "a", repeat: true }], 7), 0);
});

// ── REGISTRY WIRING ──────────────────────────────────────────────────────────
test("handler ids are globally unique, so app.canvasMode's id resolves one handler", () => {
  const all = phaseNames().flatMap((p) => handlerIds(p));
  assert.deepEqual([...new Set(all)].sort(), [...all].sort());
  assert.equal(findHandler("polygon_chain").phase, "create");
  assert.equal(findHandler("telescopic_rig").phase, "create");
  assert.equal(findHandler("navigate_interior").phase, "activate");
  assert.throws(() => findHandler("nope"), /no handler "nope" in any phase/);
});

test("the polygon plugin DECLARES the click-click-click flow, and its Add command is unchanged", () => {
  assert.equal(polygonPlugin.placement, "polygon_chain");
  assert.equal(handlerFor("create", polygonPlugin).id, "polygon_chain");
  assert.ok(handlerFor("create", polygonPlugin).mode, "the resolved create handler must declare a mode");
  // ONE entry point, and it still just arms the crosshair — the flow changed by
  // DECLARATION, so no second command id was added (the registry throws on a
  // duplicate, and two ids for one action is what the one-owner convention forbids).
  const adds = polygonPlugin.commands.filter((c) => c.id === "add-polygon");
  assert.equal(polygonPlugin.commands.length, 1);
  assert.equal(adds.length, 1);
  let armed = null;
  adds[0].run({ armCrosshairPlacement: (p) => { armed = p; } });
  assert.equal(armed, polygonPlugin);
});

test("canvasModes walks BOTH phases and carries each mode's steps + finish key", () => {
  const byId = Object.fromEntries(canvasModes().map((m) => [m.handlerId, m]));
  assert.deepEqual(byId.polygon_chain.steps.map((s) => s.hint), ["Click each corner"]);
  assert.deepEqual(byId.polygon_chain.finish, { keys: ["Enter"], label: "Finish shape" });
  assert.deepEqual(byId.telescopic_rig.steps.map((s) => s.hint),
    ["Drag the region to magnify", "Now drag where the magnified view goes"]);
  // A FIXED-length sequence finalizes itself, so it declares no finalize key —
  // offering Enter there would chip a key that does nothing.
  assert.equal(byId.telescopic_rig.finish, null);
  assert.equal(byId.navigate_interior.finish, null);
});

// ── (2)+(3) POLYGON SESSION LOGIC ────────────────────────────────────────────
test("constrainedVertex: Shift axis-locks against the PREVIOUS vertex, not the origin", () => {
  assert.deepEqual(constrainedVertex([], { x: 10, y: 9 }, SHIFT), { x: 10, y: 9 }); // nothing to anchor to
  assert.deepEqual(constrainedVertex([[0, 0]], { x: 10, y: 9 }, NO_MODS), { x: 10, y: 9 });
  const locked = constrainedVertex([[100, 100]], { x: 200, y: 108 }, SHIFT);
  assert.ok(Math.abs(locked.y - 100) < 1e-9, `axis-locked to the horizontal through (100,100), got y=${locked.y}`);
  // Length preserved along the lock (angleSnappedPoint's contract).
  assert.ok(Math.abs(locked.x - (100 + Math.hypot(100, 8))) < 1e-9);
});

test("closesLoop: only the FIRST vertex, and only once a loop can enclose an area", () => {
  const tri = [[0, 0], [50, 0], [50, 50]];
  assert.equal(closesLoop(tri, { x: 3, y: 4 }, TOL), true);
  assert.equal(closesLoop(tri, { x: 50, y: 48 }, TOL), false); // the LAST vertex is not the loop
  assert.equal(closesLoop([[0, 0], [50, 0]], { x: 1, y: 1 }, TOL), false); // 2 points fill nothing
  assert.equal(closesLoop([], { x: 0, y: 0 }, TOL), false);
});

test("repeatsLastVertex: two presses at one spot are ONE vertex (double-click-to-finish)", () => {
  assert.equal(repeatsLastVertex([[0, 0], [50, 0]], { x: 51, y: 1 }, TOL), true);
  assert.equal(repeatsLastVertex([[0, 0], [50, 0]], { x: 90, y: 0 }, TOL), false);
  assert.equal(repeatsLastVertex([], { x: 0, y: 0 }, TOL), false);
});

test("polygon: N clicks land N vertices, and the step never runs out", () => {
  const app = fakeApp();
  const { session } = drawPolygon(app, [
    [{ x: 0, y: 0 }, NO_MODS], [{ x: 100, y: 0 }, NO_MODS], [{ x: 100, y: 100 }, NO_MODS], [{ x: 0, y: 100 }, NO_MODS],
  ]);
  assert.deepEqual(session.points, [[0, 0], [100, 0], [100, 100], [0, 100]]);
  assert.equal(session.closed, false);
  assert.equal(POLYGON_CHAIN_HANDLER.mode.step(session), 0);
  assert.deepEqual(app.calls.addItem, [], "MID-FLOW THE DOCUMENT IS UNTOUCHED — nothing is written until finalize");
});

test("polygon: the double-click's second press adds no duplicate vertex", () => {
  const app = fakeApp();
  const { session } = drawPolygon(app, [
    [{ x: 0, y: 0 }, NO_MODS], [{ x: 100, y: 0 }, NO_MODS],
    [{ x: 100, y: 100 }, NO_MODS], [{ x: 102, y: 101 }, NO_MODS], // within TOL of the last
  ]);
  assert.deepEqual(session.points, [[0, 0], [100, 0], [100, 100]]);
});

test("polygon: a click on the first vertex CLOSES the loop and asks to finalize", () => {
  const app = fakeApp();
  const { session, ctx } = drawPolygon(app, [
    [{ x: 0, y: 0 }, NO_MODS], [{ x: 100, y: 0 }, NO_MODS], [{ x: 100, y: 100 }, NO_MODS], [{ x: 2, y: 3 }, NO_MODS],
  ]);
  assert.equal(session.closed, true);
  assert.equal(ctx.finishRequested, true);
  assert.deepEqual(session.points, [[0, 0], [100, 0], [100, 100]], "the closing click adds no vertex");
});

test("polygon: the close-loop affordance is visible BEFORE the click", () => {
  const mode = POLYGON_CHAIN_HANDLER.mode;
  const app = fakeApp();
  const { session } = drawPolygon(app, [
    [{ x: 0, y: 0 }, NO_MODS], [{ x: 100, y: 0 }, NO_MODS], [{ x: 100, y: 100 }, NO_MODS],
  ]);
  mode.onHover(session, creationPointer({ x: 60, y: 60 }, NO_MODS, TOL, null));
  assert.equal(mode.overlay(session).dots.filter((d) => d.hot).length, 0);
  mode.onHover(session, creationPointer({ x: 3, y: 3 }, NO_MODS, TOL, null));
  const hot = mode.overlay(session).dots.filter((d) => d.hot);
  assert.deepEqual(hot, [{ x: 0, y: 0, hot: true }], "hovering the first vertex marks it HOT before any click");
});

test("polygon overlay: the committed chain PLUS the live segment, one dot per vertex", () => {
  const mode = POLYGON_CHAIN_HANDLER.mode;
  const app = fakeApp();
  const { session } = drawPolygon(app, [[{ x: 0, y: 0 }, NO_MODS], [{ x: 100, y: 0 }, NO_MODS]]);
  mode.onHover(session, creationPointer({ x: 100, y: 60 }, NO_MODS, TOL, null));
  const o = mode.overlay(session);
  assert.deepEqual(o.chains, [{ points: [[0, 0], [100, 0], [100, 60]], closed: false }]);
  assert.equal(o.dots.length, 2);
  assert.deepEqual(o.rects, []);
});

test("polygon finalize: ONE addItem, box fitted to the hull, plugin defaults spread", () => {
  const app = fakeApp();
  const { session } = drawPolygon(app, [
    [{ x: 10, y: 20 }, NO_MODS], [{ x: 110, y: 20 }, NO_MODS], [{ x: 110, y: 120 }, NO_MODS],
  ]);
  POLYGON_CHAIN_HANDLER.mode.finalize(ctxFor(app, { plugin: polygonPlugin }), session);
  assert.equal(app.calls.addItem.length, 1, "exactly one document write");
  const s = app.calls.addItem[0];
  assert.equal(s.type, "polygon");
  assert.deepEqual([s.x, s.y, s.w, s.h], [10, 20, 100, 100]);
  assert.deepEqual(s.points, [[0, 0], [1, 0], [1, 1]]);
  assert.equal(s.closed, false);
  assert.equal(s.fill, polygonPlugin.defaults.fill, "the plugin's own defaults come through");
});

test("polygon finalize: fewer than 2 vertices ABANDONS — no ghost item", () => {
  const app = fakeApp();
  const { session } = drawPolygon(app, [[{ x: 10, y: 20 }, NO_MODS]]);
  POLYGON_CHAIN_HANDLER.mode.finalize(ctxFor(app, { plugin: polygonPlugin }), session);
  assert.deepEqual(app.calls.addItem, []);
  const empty = POLYGON_CHAIN_HANDLER.mode.begin({});
  POLYGON_CHAIN_HANDLER.mode.finalize(ctxFor(app, { plugin: polygonPlugin }), empty);
  assert.deepEqual(app.calls.addItem, []);
});

// ── (2)+(3) TELESCOPIC RIG SESSION LOGIC ─────────────────────────────────────
test("telescopic: two boxes, the first stays drawn, the second asks to finalize", () => {
  const mode = TELESCOPIC_RIG_HANDLER.mode;
  const app = fakeApp();
  const session = mode.begin({ shapeKind: "circle" });
  const box1 = { x: 100, y: 100, w: 80, h: 60 };
  const box2 = { x: 500, y: 200, w: 320, h: 240 };

  mode.onHover(session, creationPointer({ x: 180, y: 160 }, NO_MODS, TOL, box1));
  assert.deepEqual(mode.overlay(session).rects, [box1], "the live box paints while dragging");
  const c1 = ctxFor(app, { params: { shapeKind: "circle" } });
  mode.onStep(c1, session, creationPointer({ x: 180, y: 160 }, NO_MODS, TOL, box1));
  assert.equal(c1.finishRequested, false, "one box is not a rig");
  assert.equal(mode.step(session), 1, "the sequence advances, so the HintBar re-words");
  assert.deepEqual(mode.overlay(session).rects, [box1], "box 1 stays on screen as a reference");

  mode.onHover(session, creationPointer({ x: 820, y: 440 }, NO_MODS, TOL, box2));
  assert.deepEqual(mode.overlay(session).rects, [box1, box2], "both boxes paint during step 2");
  const c2 = ctxFor(app, { params: { shapeKind: "circle" } });
  mode.onStep(c2, session, creationPointer({ x: 820, y: 440 }, NO_MODS, TOL, box2));
  assert.equal(c2.finishRequested, true);
  assert.deepEqual(app.calls.rig, [], "MID-FLOW nothing is written — finalize alone writes");

  mode.finalize(ctxFor(app, { params: { shapeKind: "circle" } }), session);
  assert.deepEqual(app.calls.rig, [{ shapeKind: "circle", source: box1, lens: box2 }]);
});

test("telescopic finalize: one box ABANDONS — half a rig is not a rig", () => {
  const mode = TELESCOPIC_RIG_HANDLER.mode;
  const app = fakeApp();
  const session = mode.begin({ shapeKind: "box" });
  mode.onStep(ctxFor(app, { params: { shapeKind: "box" } }), session,
    creationPointer({ x: 0, y: 0 }, NO_MODS, TOL, { x: 0, y: 0, w: 10, h: 10 }));
  mode.finalize(ctxFor(app, { params: { shapeKind: "box" } }), session);
  assert.deepEqual(app.calls.rig, []);
});

// ── (4) THE HINTBAR NARRATES EACH STEP, AND ONLY ITS OWN STEP ────────────────
const modes = canvasModes();
const registry = createShortcuts();
for (const e of handShortcutEntries({ app: {}, canvasModes: modes, dragKindModifiers: DRAG_KIND_MODIFIERS, activations: activations() }))
  registry.add(e);
const contexts = hintProbeContexts({
  dragKinds: DRAG_KINDS,
  canvasModeIds: [null, ...modes.map((m) => m.handlerId)],
  canvasModeSteps: canvasModeStepAxis(modes),
  activationIds: activations().map((a) => a.handlerId),
  app: {},
});
/** Query. The visible [combo, label] pairs in the plain in-mode context for a
 *  (handlerId, step) — nothing else held, nothing else armed. */
function chipsAt(handlerId, step) {
  const ctx = contexts.find((c) => c.mode === "edit" && c.canvasMode === handlerId && c.canvasModeStep === step
    && !c.dragKind && !c.crosshairArmed && !c.modalActive && !c.typingTarget && !c.dialogOpen && !c.paletteOpen
    && !c.hasSelection && !c.numericField);
  assert.ok(ctx, `no probe context for ${handlerId} step ${step}`);
  return registry.hints(ctx).map(([keys, label]) => [keys.join("+"), label]);
}

test("canvasModeStepAxis is DERIVED from the declared step lists", () => {
  assert.deepEqual(canvasModeStepAxis([]), [0]);
  assert.deepEqual(canvasModeStepAxis([{ steps: [] }, { steps: [{}, {}] }]), [0, 1]);
  assert.deepEqual(canvasModeStepAxis(modes), [0, 1]); // the rig's two boxes are the longest sequence
});

test("the polygon bar names the click, the axis lock, Enter and Escape", () => {
  const chips = chipsAt("polygon_chain", 0);
  assert.ok(chips.some(([k, l]) => k === "mouse_left" && l === "Click each corner"), JSON.stringify(chips));
  assert.ok(chips.some(([k, l]) => k === "Shift" && l === "Axis lock"),
    `the Shift constraint must be announced with the EXISTING house wording. Got ${JSON.stringify(chips)}`);
  assert.ok(chips.some(([k, l]) => k === "Enter" && l === "Finish shape"), JSON.stringify(chips));
  // THE OTHER finalize gesture the request names ("I hit enter to finalize or
  // double click to finalize"). It was declared on `mouse_left` and hidden, so it
  // showed nowhere and its glyph would have been a SINGLE click; on its own token
  // it collides with nothing and is visible. Two "Finish shape" chips on different
  // glyphs is the modal transform's two-"Confirm" precedent, not a duplicate.
  assert.ok(chips.some(([k, l]) => k === MOUSE_DOUBLE_TOKEN && l === "Finish shape"),
    `the polygon must ANNOUNCE its double-click finish, not just perform it. Got ${JSON.stringify(chips)}`);
  assert.deepEqual(chips.filter(([k]) => k === "Escape").map(([, l]) => l), ["Exit draw polygon"]);
});

test("the rig bar narrates STEP BY STEP — and step 1's wording cannot show at step 0", () => {
  const first = chipsAt("telescopic_rig", 0).filter(([k]) => k === "mouse_left").map(([, l]) => l);
  const second = chipsAt("telescopic_rig", 1).filter(([k]) => k === "mouse_left").map(([, l]) => l);
  assert.deepEqual(first, ["Drag the region to magnify"]);
  assert.deepEqual(second, ["Now drag where the magnified view goes"]);
  // Both steps read the box modifiers, so both announce them — the multiresize rule.
  for (const step of [0, 1]) {
    const chips = chipsAt("telescopic_rig", step);
    assert.ok(chips.some(([k, l]) => k === "Shift" && l === "Uniform scale"), `step ${step}: ${JSON.stringify(chips)}`);
    assert.ok(chips.some(([k, l]) => k === "Cmd" && l === "Symmetric resize"), `step ${step}: ${JSON.stringify(chips)}`);
  }
  // A fixed-length sequence offers no Enter (it finalizes itself).
  assert.deepEqual(chipsAt("telescopic_rig", 0).filter(([k]) => k === "Enter"), []);
});

test("a creation mode's bar carries NO ordinary editor chip (the takeover rule)", () => {
  for (const [handlerId, step] of [["polygon_chain", 0], ["telescopic_rig", 0], ["telescopic_rig", 1]]) {
    const chips = chipsAt(handlerId, step);
    assert.ok(!chips.some(([, l]) => l === "Select / drag"), `${handlerId}/${step}: ${JSON.stringify(chips)}`);
    assert.ok(!chips.some(([, l]) => l === "Click or drag to place"),
      `${handlerId}/${step}: the one-gesture placement hint must yield to the mode's own steps. ${JSON.stringify(chips)}`);
    // One key, one meaning: no combo appears twice with different words.
    const byCombo = new Map();
    for (const [combo, label] of chips) {
      assert.ok(!byCombo.has(combo) || byCombo.get(combo) === label,
        `${handlerId}/${step}: "${combo}" shows as both "${byCombo.get(combo)}" and "${label}"`);
      byCombo.set(combo, label);
    }
  }
});

// ── (5) THE RIG'S RECT-PARAMETERIZED EQUATIONS, EVALUATED ────────────────────
const rigRegistry = createRegistry();
registerAll(rigRegistry, createCommands());

/**
 * Query. Builds the rig from two rects the way insertTelescopicMagnifier does,
 * evaluates it at tween `t`, and returns the folded lens/source/tangent states.
 */
function rigAt(shapeKind, source, lens, t) {
  const withDefaults = (ov, z) => ({ ...rigRegistry.get(ov.type).defaults, ...ov, active: true, z });
  let doc = keyframed(newDocument(), 0, ["vars", TELESCOPIC.TWEEN_VAR], t);
  let sourceId; [doc, sourceId] = withNewItem(doc, 0, withDefaults(telescopicSourceOverrides({ shapeKind, source }), 3));
  let lensId; [doc, lensId] = withNewItem(doc, 0, withDefaults(telescopicLensOverrides({ sourceId, shapeKind, source, lens }), 1));
  let tangentId; [doc, tangentId] = withNewItem(doc, 0, withDefaults(telescopicTangentOverrides({ sourceId, lensId, shapeKind }), 2));
  const { state, errors } = evaluateState(foldState(doc, 0, 1), rigRegistry);
  const mine = [...errors.keys()].filter((k) => [sourceId, lensId, tangentId].some((id) => k.includes(id)));
  assert.deepEqual(mine, [], `t=${t}: eval errors ${mine.map((k) => `${k}: ${errors.get(k)}`).join("; ")}`);
  return { source: state.items[sourceId], lens: state.items[lensId], tangent: state.items[tangentId] };
}

test("rig equations: at t=0 the lens IS the source box (identity, magnification 1)", () => {
  const source = { x: 100, y: 400, w: 120, h: 60 };
  const lens = { x: 700, y: 90, w: 300, h: 200 };
  const r = rigAt("box", source, lens, 0);
  assert.deepEqual([r.source.x, r.source.y, r.source.w, r.source.h], [100, 400, 120, 60]);
  for (const [k, want] of [["w", 120], ["h", 60]]) assert.ok(Math.abs(r.lens[k] - want) < 1e-9, `lens ${k} = ${r.lens[k]}`);
  const sc = rectCenter(source);
  assert.ok(Math.abs(r.lens.x + r.lens.w / 2 - sc.x) < 1e-9, `lens centre x = ${r.lens.x + r.lens.w / 2}`);
  assert.ok(Math.abs(r.lens.y + r.lens.h / 2 - sc.y) < 1e-9, `lens centre y = ${r.lens.y + r.lens.h / 2}`);
  assert.ok(Math.abs(r.lens.magnificationX - 1) < 1e-9 && Math.abs(r.lens.magnificationY - 1) < 1e-9);
});

test("rig equations: at t=1 the lens IS the SECOND DRAGGED BOX, exactly", () => {
  const source = { x: 100, y: 400, w: 120, h: 60 };
  const lens = { x: 700, y: 90, w: 300, h: 200 };
  const r = rigAt("box", source, lens, 1);
  for (const k of ["x", "y", "w", "h"])
    assert.ok(Math.abs(r.lens[k] - lens[k]) < 1e-9, `lens ${k} = ${r.lens[k]}, dragged ${lens[k]}`);
  // The zoom EMERGES per axis from the two boxes (300/120 vs 200/60) — anisotropic
  // because the dragged pair is, which is why `h` needed its own equation.
  assert.ok(Math.abs(r.lens.magnificationX - 300 / 120) < 1e-9, `magX = ${r.lens.magnificationX}`);
  assert.ok(Math.abs(r.lens.magnificationY - 200 / 60) < 1e-9, `magY = ${r.lens.magnificationY}`);
  assert.notEqual(r.lens.magnificationX, r.lens.magnificationY);
  // The tangents track both shapes' real half-extents, so they still resolve.
  for (const v of [r.tangent.a.x, r.tangent.a.halfW, r.tangent.b.x, r.tangent.b.halfH])
    assert.ok(Number.isFinite(v), `tangent slot did not resolve: ${JSON.stringify(v)}`);
});

test("rig equations: a lens SMALLER than the source, or pulled up-left, still parses", () => {
  const source = { x: 500, y: 500, w: 200, h: 200 };
  const lens = { x: 40, y: 30, w: 80, h: 80 }; // negative grow AND negative pull
  const r = rigAt("circle", source, lens, 1);
  for (const k of ["x", "y", "w", "h"])
    assert.ok(Math.abs(r.lens[k] - lens[k]) < 1e-9, `lens ${k} = ${r.lens[k]}, dragged ${lens[k]}`);
});

test("telescopicDefaultRects: the drop-in-place rig the constants describe", () => {
  const { source, lens } = telescopicDefaultRects();
  assert.deepEqual(source, { x: 382, y: 452, w: 96, h: 96 });
  assert.deepEqual(lens, { x: 700, y: 80, w: 340, h: 340 });
  // The two boxes' centres differ by exactly the declared pull — the property the
  // rects and the constants must agree on.
  assert.deepEqual(
    [rectCenter(lens).x - rectCenter(source).x, rectCenter(lens).y - rectCenter(source).y],
    [TELESCOPIC.PULL_X, TELESCOPIC.PULL_Y],
  );
  // Each rig step's CLICK extent comes from these, not from an invented constant.
  assert.deepEqual(TELESCOPIC_RIG_HANDLER.mode.steps.map((s) => s.clickSize),
    [{ w: source.w, h: source.h }, { w: lens.w, h: lens.h }]);
});

console.log(`\n${passed} creation-mode tests passed`);
