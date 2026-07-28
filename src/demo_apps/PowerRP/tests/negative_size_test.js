/**
 * THE NEGATIVE-EXTENT CONTRACT, pinned across EVERY registered widget.
 *
 * The user's ruling: "make sure there are no widgets that don't support negative
 * height/width or crash on that....it's a standard...u can document it in the widget
 * base class they must support that". The contract itself is written down in
 * core/registry.js's plugin docblock; this suite is what makes it true rather than
 * aspirational.
 *
 * WHAT IT ASSERTS AND WHY THAT SHAPE. A negative extent is a REFLECTION (commit
 * 76fd076 — the pose is a similarity, which cannot carry one), and the sign is
 * resolved at ONE map, core/geometry.js unsignedState. Because the flip is an
 * involution, unsigning a flipped box returns the original box byte-for-byte, so the
 * four sign combinations of the SAME footprint must be geometrically
 * INDISTINGUISHABLE: identical derived state, identical world, identical bounds,
 * identical anchors, identical snap features, identical cull answer, identical IR
 * shape. That equivalence — not a list of expected numbers — is the property that
 * makes the representation safe across every widget and every backend, so it is what
 * is asserted, per widget, mechanically.
 *
 * DATA-DRIVEN OFF THE LIVE REGISTRY, deliberately: there is no per-type list here to
 * fall out of sync, so a widget added next year is covered the moment it registers.
 * (A hand-maintained mirror of another module's shape is a known recurring defect in
 * this codebase; this suite must not become one.)
 *
 * EXPECTED NOISE. Instantiating every widget means instantiating the latex and
 * mermaid ones, whose rasterizers need a DOM and a font loader. They REPORT that
 * loudly in bare node (correctly — they must not fail silently) and emit nothing,
 * which is a fine answer for a sign test. Those two lines are not failures.
 *
 * Run: node src/demo_apps/PowerRP/tests/negative_size_test.js
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { newDocument, foldState, withNewItem } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import {
  deriveRenderTree, nodeAnchors, nodeFeatures, nodeModifierPoints, modifierWrite,
  constraintPull, pointInNodeBox, pickNode, standardBBoxAnchors,
} from "../core/derive.js";
import { flippedBox, unsignedState, normalizedBox } from "../core/geometry.js";
import { localBoundsOf, rotatedBBoxAABB, effectInclusiveAABB, canSkipNode } from "../core/view.js";
import { bandSelectable, selectInBox } from "../core/bandselect.js";
import { effectBoundsOf } from "../render_gpu/effects.js";
import { sceneIR } from "../render_gpu/ports.js";
import { isReflected } from "../render_gpu/ir.js";

let n = 0;
const test = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };
const eq = (a, b, msg) => assert.deepEqual(a, b, msg);
const registry = createRegistry();
registerAll(registry, createCommands());

// ONE footprint, four spellings. The box is asymmetric (w ≠ h) and off-origin so a
// sign error cannot hide behind a symmetry, and every number is an integer so an
// exact deep-equal is the right comparison (no float slop to excuse).
const BOX = { x: 400, y: 300, w: 240, h: 140, rotation: 0, scale: 1 };
const SIGN_SPELLINGS = [
  ["+w+h", BOX],
  ["-w+h", { ...BOX, ...flippedBox(BOX, "x") }],
  ["+w-h", { ...BOX, ...flippedBox(BOX, "y") }],
  ["-w-h", { ...BOX, ...flippedBox(BOX, "x"), ...flippedBox(BOX, "y") }],
];
// A view rect that comfortably contains the footprint, so "is it culled" has one
// obviously correct answer (no) and any sign-blind AABB test flips it to yes.
const VIEW_RECT = { x: 0, y: 0, w: 1600, h: 900 };
const CENTER = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2 };
const CAMERA_Z = registry.get("camera").defaults.z ?? 0;

/**
 * Query (reads the registry). The derived render node for ONE instance of `type`
 * spelled with the given box, built from the plugin's OWN defaults so every hook
 * meets the values it was authored against.
 *
 * @param {string} type - a registered widget type
 * @param {object} box - {x, y, w, h, rotation, scale}, any sign
 * @returns {{node: object, nodes: object[]}} the item's node + the whole tree
 *
 * @example // nodeFor("rect", {x: 0, y: 0, w: -10, h: 5}).node.state.w  // 10 (unsigned)
 */
function nodeFor(type, box) {
  const defaults = registry.get(type).defaults;
  let doc = newDocument(), id;
  // z above THE camera's, so the z-then-id tie-break cannot reorder the two nodes
  // between builds and make a whole-scene comparison depend on a fresh uuid.
  [doc, id] = withNewItem(doc, 0, { ...defaults, type, active: true, z: CAMERA_Z + 1, ...box });
  const state = evaluateState(foldState(doc, 0, 1), registry).state;
  const nodes = deriveRenderTree(state, registry);
  return { node: nodes.find((x) => x.itemId === id) ?? null, nodes, itemId: id };
}

/**
 * Pure function. An answer made comparable ACROSS documents: JSON with every
 * occurrence of this build's item uuid replaced by a fixed token. Snap feature ids
 * and several IR ops embed the node id, which is freshly generated per document, so
 * without this the comparison would measure uuid churn instead of geometry.
 *
 * @param {*} value - any JSON-serializable hook answer
 * @param {string} itemId - the uuid to erase
 * @returns {string}
 *
 * @example scrubbed({id: "abc:ml", x: 1}, "abc") // '{"id":"ITEM:ml","x":1}'
 * @example scrubbed([1, 2], "abc") // '[1,2]'
 */
function scrubbed(value, itemId) {
  return JSON.stringify(value ?? null).split(itemId).join("ITEM");
}

/** Query. Every registered type whose state HAS a box (capabilities.bbox). */
const BBOX_TYPES = registry.all().filter((p) => p.capabilities.bbox).map((p) => p.type);

/**
 * Pure function. A rect's fields as a plain comparable record, or the string "null"
 * for an unboundable widget — so "identical across all four spellings" is one
 * deepEqual regardless of which case a widget is in.
 *
 * @example rectKey({x: 1, y: 2, w: 3, h: 4}) // {x: 1, y: 2, w: 3, h: 4}
 * @example rectKey(null) // "null"
 */
function rectKey(rect) {
  return rect === null || rect === undefined ? "null" : { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/** Pure function. Asserts a bounds rect never reports a negative extent.
 *  @example assertNonNegative({x: 0, y: 0, w: 2, h: 3}, "rect", "localBounds") // undefined */
function assertNonNegative(rect, type, hook) {
  if (rect === null || rect === undefined) return;
  assert.ok(Number.isFinite(rect.w) && rect.w >= 0, `${type}: ${hook} returned w = ${rect.w} (must be finite and >= 0)`);
  assert.ok(Number.isFinite(rect.h) && rect.h >= 0, `${type}: ${hook} returned h = ${rect.h} (must be finite and >= 0)`);
}

// ── THE MAP ITSELF ────────────────────────────────────────────────────────────
test("unsignedState: an unsigned state is returned as the SAME OBJECT (derive's sign test)", () => {
  const s = { x: 1, y: 2, w: 3, h: 4 };
  assert.equal(unsignedState(s), s);
  assert.equal(unsignedState({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }).w, undefined);
  const zero = { x: 0, y: 0, w: 0, h: 0 };
  assert.equal(unsignedState(zero), zero, "0 is a value, not a sign — a zero-extent box must not clone");
});
test("unsignedState: agrees with normalizedBox on every signed spelling, and preserves the rest", () => {
  for (const [, box] of SIGN_SPELLINGS) {
    const norm = normalizedBox(box);
    const out = unsignedState({ ...box, fill: "#abcdef" });
    eq({ x: out.x, y: out.y, w: out.w, h: out.h }, { x: norm.x, y: norm.y, w: norm.w, h: norm.h });
    assert.equal(out.fill, "#abcdef", "non-box properties must ride through untouched");
  }
});
test("unsignedState: every spelling of the footprint unsigns to the SAME box (involution)", () => {
  const keys = SIGN_SPELLINGS.map(([, box]) => rectKey(unsignedState(box)));
  for (const k of keys) eq(k, { x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h });
});

// ── THE MASTER INVARIANT ──────────────────────────────────────────────────────
// Every geometry hook is a pure function of (state, world) — sometimes plus sibling
// nodes — so if derivation hands all four spellings the SAME state and the SAME
// world, then EVERY hook is answered identically by construction and no plugin can
// get the sign wrong because no plugin can see it. That is the whole contract, and
// this is the assertion that carries it. The per-hook tests below are not
// redundant with it: they prove the hooks are actually reachable and that nothing
// reads the sign from somewhere other than `state`.
test("derive: all four sign spellings produce IDENTICAL state and world — for EVERY bbox widget", () => {
  assert.ok(BBOX_TYPES.length > 20, `expected many bbox widget types, got ${BBOX_TYPES.length}`);
  const failures = [];
  for (const type of BBOX_TYPES) {
    const derived = SIGN_SPELLINGS.map(([label, box]) => [label, nodeFor(type, box).node]);
    for (const [label, node] of derived)
      if (!node) failures.push(`${type} [${label}]: did not derive at all`);
    if (failures.length) continue;
    const [[, base]] = derived;
    for (const [label, node] of derived.slice(1)) {
      try {
        eq(node.state, base.state, `${type} [${label}]: derived state differs from +w+h`);
        eq(node.world, base.world, `${type} [${label}]: derived world differs from +w+h`);
      } catch (err) {
        failures.push(`${type} [${label}]: ${err.message.split("\n")[0]}`);
      }
    }
    // The sign is not lost, it is MOVED: it survives as node.mirror and nowhere else.
    eq(derived[0][1].mirror, undefined, `${type}: an unsigned box must carry no mirror mark`);
    eq(derived[1][1].mirror, { x: true, y: false }, `${type}: -w must mirror x only`);
    eq(derived[2][1].mirror, { x: false, y: true }, `${type}: -h must mirror y only`);
    eq(derived[3][1].mirror, { x: true, y: true }, `${type}: -w-h must mirror both`);
  }
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

// ── THE FULL HOOK SURFACE, PER WIDGET ─────────────────────────────────────────
// The hooks core/registry.js's docblock declares, every one of them, run under all
// four spellings. Three things are asserted of each: it does not throw, any rect it
// returns has non-negative extents, and its answer is IDENTICAL across the four.
test("hooks: the WHOLE declared hook surface is sign-blind for EVERY bbox widget", () => {
  const failures = [];
  const report = (type, label, hook, err) => failures.push(`${type} [${label}] ${hook}: ${err.message.split("\n")[0]}`);
  for (const type of BBOX_TYPES) {
    const answers = new Map(); // hook → [scrubbed answer per spelling]
    let currentItemId = null;
    const record = (hook, value) => {
      if (!answers.has(hook)) answers.set(hook, []);
      answers.get(hook).push(scrubbed(value, currentItemId));
    };
    for (const [label, box] of SIGN_SPELLINGS) {
      const { node, nodes, itemId } = nodeFor(type, box);
      currentItemId = itemId;
      const plugin = node.plugin;
      // BOUNDS FAMILY — the hooks a negative rect would break SILENTLY rather than
      // loudly: `x < rx + rw && x + w > rx` is simply false when w < 0, so a
      // sign-blind AABB would make a flipped widget unselectable by rubber band and
      // wrongly culled. A wrong answer is worse than a crash, hence these first.
      for (const [hook, fn] of [
        ["localBounds", () => localBoundsOf(node)],
        ["rotatedBBoxAABB", () => rotatedBBoxAABB(node)],
        ["effectInclusiveAABB", () => effectInclusiveAABB(node)],
      ]) {
        try {
          const rect = fn();
          assertNonNegative(rect, type, hook);
          record(hook, rectKey(rect));
        } catch (err) { report(type, label, hook, err); }
      }
      try {
        const { bbox } = effectBoundsOf(node);
        assertNonNegative(bbox, type, "effectBounds.bbox");
        record("effectBounds", rectKey(bbox));
      } catch (err) {
        // A widget that answers neither localBounds nor bbox has no effect substrate
        // and effectBoundsOf throws BY DESIGN — but every type here declares bbox,
        // so reaching this is a real defect, not an exemption.
        report(type, label, "effectBounds", err);
      }
      try {
        record("cullMargin", plugin.cullMargin ? plugin.cullMargin(node.state) : null);
        record("canSkip", canSkipNode(node, VIEW_RECT));
      } catch (err) { report(type, label, "canSkip/cullMargin", err); }
      // ANCHORS + SNAP: geometric NAMES. A flip does not move the silhouette, so
      // `ml` stays the left edge and a bound arrow must not budge (76fd076).
      try { record("anchors", nodeAnchors(node)); } catch (err) { report(type, label, "anchors", err); }
      try { record("snapFeatures", nodeFeatures(node)); } catch (err) { report(type, label, "snapFeatures", err); }
      try {
        // `apply`/`constrain` are functions, so compare only the geometry + ids.
        const mps = nodeModifierPoints(node);
        record("modifierPoints", mps.map((m) => ({ id: m.id, x: m.x, y: m.y, active: m.active })));
        // THE HANDLE-CONSTRAINT PROTOCOL: the projection and the write it composes
        // with must both survive, since a signed box would have reached them through
        // `state` had the seam leaked.
        record("constrain", mps.map((m) => constraintPull(m, node.state, { x: CENTER.x, y: CENTER.y })));
        record("modifierWrite", mps.map((m) => (m.apply ? modifierWrite(m, node.state, { x: 1, y: 2 }) : null)));
      } catch (err) { report(type, label, "modifierPoints/constrain", err); }
      try {
        if (plugin.editPoints) {
          const byId = new Map(nodes.map((x) => [x.itemId, x]));
          record("editPoints", plugin.editPoints(node, byId).map((p) => ({ x: p.x, y: p.y })));
        }
      } catch (err) { report(type, label, "editPoints", err); }
      // EMIT, through the real render walk (universal effects seam included), so a
      // sign-dependent branch inside any emit() shows up as a differing op sequence.
      // The DRAWING ops must match exactly; the TRANSFORM ops deliberately do not,
      // because a mirrored node's walk inserts one extra reflected push — that IS
      // the reflection, and it is asserted separately below.
      try {
        const ir = sceneIR(nodes);
        const drawOps = ir.filter((c) => c.op !== "pushTransform" && c.op !== "popTransform").map((c) => c.op);
        record("emit", drawOps);
        // A GHOST (group with no members, anchor point, an asset widget with no
        // source) emits nothing, and there is nothing to reflect — sceneIR returns
        // before the mirror wrap. So the reflection is required exactly of the signed
        // spellings THAT DRAW; requiring it of a ghost would be requiring a transform
        // around no content.
        if (drawOps.length > 0)
          assert.equal(
            ir.some((c) => c.op === "pushTransform" && isReflected(c)),
            label !== "+w+h",
            `${type} [${label}]: exactly the signed spellings must emit a REFLECTED transform`,
          );
      } catch (err) { report(type, label, "emit", err); }
      // HIT TESTING: the box grab region, and the plugin's own silhouette test.
      try {
        assert.ok(pointInNodeBox(box, CENTER.x, CENTER.y), `pointInNodeBox missed the box centre`);
        record("pick", pickNode(nodes, CENTER.x, CENTER.y)?.itemId === node.itemId);
        record("bandSelectable", bandSelectable(node));
        record("selectInBox", selectInBox(nodes, VIEW_RECT, "inner").includes(node.itemId));
      } catch (err) { report(type, label, "hitTest/bandSelect", err); }
    }
    for (const [hook, values] of answers)
      for (let i = 1; i < values.length; i++)
        if (values[i] !== values[0])
          failures.push(`${type} [${SIGN_SPELLINGS[i][0]}] ${hook}: differs from +w+h\n      +w+h: ${values[0].slice(0, 300)}\n      here: ${values[i].slice(0, 300)}`);
  }
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

// ── THE TWO PRE-DERIVATION READERS (the holes this suite was written to close) ──
// The equation pass runs BEFORE any render node exists, so it is the one place a
// plugin geometry hook can still be handed a RAW, possibly-signed state. Both of
// these were measurably wrong before core/geometry.unsignedState was routed through
// them, and both are silent wrong answers rather than crashes.
test("REGRESSION: an anchor-bound arrow does NOT jump when its target flips", () => {
  // THE DEFECT: `@item.ml` was evaluated against the RAW box, whose local origin is
  // the RIGHT edge once w is negative — so the equation returned x 640 while the
  // `ml` glyph the user clicked to write it was drawn at x 400. The arrow moved the
  // full 240-wide width of a widget whose silhouette had not moved at all.
  const positions = SIGN_SPELLINGS.map(([, box]) => {
    let doc = newDocument(), rectId, arrowId;
    [doc, rectId] = withNewItem(doc, 0, { ...registry.get("rect").defaults, type: "rect", active: true, ...box });
    [doc, arrowId] = withNewItem(doc, 0, {
      ...registry.get("arrow").defaults, type: "arrow", active: true,
      from: { x: `=@${rectId}_ml.x`, y: `=@${rectId}_ml.y` }, to: { x: 1200, y: 800 },
    });
    const state = evaluateState(foldState(doc, 0, 1), registry).state;
    const drawn = nodeAnchors(deriveRenderTree(state, registry).find((x) => x.itemId === rectId));
    return { equation: state.items[arrowId].from, glyph: drawn.find((a) => a.id === "ml") };
  });
  for (const { equation, glyph } of positions) {
    eq(equation, { x: BOX.x, y: BOX.y + BOX.h / 2 }, "the equation must resolve to the geometric LEFT edge");
    eq({ x: glyph.x, y: glyph.y }, equation, "the drawn glyph and the equation it writes must agree");
  }
});
test("REGRESSION: a closest-rim solve answers the same rim point under every sign", () => {
  // THE DEFECT: closestPointOnRoundedRect clamps into [0..h], and a negative h makes
  // that range EMPTY, so a vertically-flipped 140-tall rect answered its BOTTOM edge
  // (y 440) for a target level with its middle (y 370) — 70 units off, silently.
  const TARGET = { x: 1400, y: CENTER.y };
  const answers = SIGN_SPELLINGS.map(([, box]) => {
    let doc = newDocument(), rectId, arrowId;
    [doc, rectId] = withNewItem(doc, 0, { ...registry.get("rect").defaults, type: "rect", active: true, ...box, radius: 0 });
    [doc, arrowId] = withNewItem(doc, 0, {
      ...registry.get("arrow").defaults, type: "arrow", active: true,
      from: { x: `=@${rectId}_closest.x`, y: `=@${rectId}_closest.y` }, to: TARGET,
    });
    return evaluateState(foldState(doc, 0, 1), registry).state.items[arrowId].from;
  });
  for (const from of answers) eq(from, { x: BOX.x + BOX.w, y: CENTER.y });
});
test("REGRESSION: a group with a signed box moves its members the SAME way in both passes", () => {
  // THE DEFECT: applyGroupParenting reads the group's ALREADY-unsigned node.state
  // while the expression pass read the RAW one, so a group with w = -200 placed its
  // members 200 units from where the renderer drew them — the two halves of group
  // parenting disagreeing about the same group.
  const MEMBER = { x: 200, y: 200, w: 100, h: 100, rotation: 0, scale: 1 };
  for (const groupW of [200, -200]) {
    let doc = newDocument(), memberId, groupId, arrowId;
    [doc, memberId] = withNewItem(doc, 0, { ...registry.get("rect").defaults, type: "rect", active: true, ...MEMBER });
    [doc, groupId] = withNewItem(doc, 0, {
      ...registry.get("group").defaults, type: "group", active: true, members: [memberId],
      x: 150, y: 100, w: groupW, h: 200, rotation: 0, scale: 1, bind: { x: 100, y: 100, rotation: 0, scale: 1 },
    });
    [doc, arrowId] = withNewItem(doc, 0, {
      ...registry.get("arrow").defaults, type: "arrow", active: true,
      from: { x: `=@${memberId}_tl.x`, y: `=@${memberId}_tl.y` }, to: { x: 1200, y: 1200 },
    });
    const state = evaluateState(foldState(doc, 0, 1), registry).state;
    const memberWorld = deriveRenderTree(state, registry).find((x) => x.itemId === memberId).world;
    eq(state.items[arrowId].from, { x: memberWorld.x, y: memberWorld.y },
      `group w=${groupW}: the equation pass and the render must place the member identically`);
  }
});

// ── ROTATION AND SCALE, since the flip formula carries both ────────────────────
test("derive: sign-blindness holds at every rotation and scale, for EVERY bbox widget", () => {
  // flippedBox's origin shift is scale·w with NO rotation term (the pivot re-derives
  // to the same point, cancelling it — 76fd076). That claim is asserted there for a
  // bare box; here it is asserted for real widgets through the real derivation.
  const POSES = [
    { rotation: 0, scale: 1 }, { rotation: Math.PI / 6, scale: 1 },
    { rotation: Math.PI / 2, scale: 2 }, { rotation: -1.234, scale: 0.375 },
  ];
  const failures = [];
  for (const type of BBOX_TYPES)
    for (const pose of POSES) {
      const posed = { ...BOX, ...pose };
      const spellings = [
        posed,
        { ...posed, ...flippedBox(posed, "x") },
        { ...posed, ...flippedBox(posed, "y") },
        { ...posed, ...flippedBox(posed, "x"), ...flippedBox(posed, "y") },
      ];
      const nodes = spellings.map((box) => nodeFor(type, box).node);
      for (let i = 1; i < nodes.length; i++)
        try {
          eq(nodes[i].state, nodes[0].state);
          eq(nodes[i].world, nodes[0].world);
          eq(rectKey(rotatedBBoxAABB(nodes[i])), rectKey(rotatedBBoxAABB(nodes[0])));
          eq(nodeAnchors(nodes[i]), nodeAnchors(nodes[0]));
        } catch (err) {
          failures.push(`${type} rotation=${pose.rotation} scale=${pose.scale} spelling ${i}: ${err.message.split("\n")[0]}`);
        }
    }
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
});

// ── THE BAND-SELECT CLAIM, CONCRETELY ─────────────────────────────────────────
test("bandselect: a band that overlaps a FLIPPED widget really does select it", () => {
  // A negative-width rect silently fails naive AABB intersection, which would make a
  // flipped widget unselectable by rubber band — a wrong answer with no error. The
  // seam prevents it; this is the proof, in both modes, with a control that fails.
  for (const [label, box] of SIGN_SPELLINGS) {
    const { node, nodes } = nodeFor("rect", box);
    const enclosing = { x: BOX.x - 10, y: BOX.y - 10, w: BOX.w + 20, h: BOX.h + 20 };
    const overlapping = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2, w: 1000, h: 1000 };
    const missing = { x: BOX.x + BOX.w + 50, y: BOX.y, w: 10, h: 10 };
    assert.ok(selectInBox(nodes, enclosing, "inner").includes(node.itemId), `${label}: INNER band must enclose it`);
    assert.ok(selectInBox(nodes, overlapping, "outer").includes(node.itemId), `${label}: OUTER band must touch it`);
    assert.ok(!selectInBox(nodes, missing, "outer").includes(node.itemId), `${label}: a band beside it must NOT select it`);
  }
});

// ── THE SHARED ANCHOR IMPLEMENTATION ──────────────────────────────────────────
test("standardBBoxAnchors: never asked for a signed box, and geometric if it is", () => {
  // 20+ plugins share this one implementation, so it is worth stating plainly what it
  // does and does not promise: it is written against an UNSIGNED box (the seam's
  // guarantee) and simply mirrors the ids if handed a signed one. That is why the
  // sign must stop upstream of it rather than be handled here — the alternative is
  // every one of those plugins learning about flips.
  eq(standardBBoxAnchors({ w: 240, h: 140 }).find((a) => a.id === "ml"), { id: "ml", x: 0, y: 70 });
  eq(standardBBoxAnchors(unsignedState({ x: 640, y: 300, w: -240, h: 140 })).find((a) => a.id === "ml"), { id: "ml", x: 0, y: 70 });
  assert.equal(standardBBoxAnchors({ w: -240, h: 140 }).find((a) => a.id === "mr").x, -240);
});

console.log(`\nnegative-size tests: ${n} passed  (${BBOX_TYPES.length} bbox widget types swept)`);
