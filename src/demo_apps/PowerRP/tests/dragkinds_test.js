/**
 * dragKinds.js — the extracted pure drag geometry (manifest UNDEFERRAL SWEEP:
 * CanvasView drag-machine extraction). Node assert tests (no framework), mirror
 * of the module's doctests plus the rotation-aware scale invariants that the
 * live multiresize_place_probe checks end-to-end.
 *
 * Run: node src/demo_apps/PowerRP/tests/dragkinds_test.js
 */
import assert from "node:assert/strict";
import * as T from "../core/transform.js";
import { worldTransform, deriveRenderTree, pickNode, pointInNodeBox } from "../core/derive.js";
import { diffState } from "../core/deltas.js";
import { newDocument, foldState, withNewItem } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import {
  translationPairs, resizeAnchors, resizedBox,
  scaledBoxAboutPoint, scaleMemberPairs, scalePairs, groupResizeState,
  creationRect, creationEndpoint,
} from "../web/canvas/dragKinds.js";

let n = 0;
const test = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };
const eq = (a, b) => assert.deepEqual(a, b);
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── translationPairs ──────────────────────────────────────────────────────
test("translationPairs: bbox writes plain x/y", () => {
  eq(translationPairs({ itemId: "r", plugin: {}, startX: 10, startY: 20 }, 5, 3),
    [[["items", "r", "x"], 15], [["items", "r", "y"], 23]]);
});
test("translationPairs: moveBy widget delegates to the plugin hook", () => {
  const plugin = { moveBy: (raw, dx, dy) => [[["from", "x"], raw.from.x + dx], [["to", "x"], raw.to.x + dx]] };
  eq(translationPairs({ itemId: "a", plugin, rawItem: { from: { x: 0 }, to: { x: 100 } } }, 5, 0),
    [[["items", "a", "from", "x"], 5], [["items", "a", "to", "x"], 105]]);
});

// ── Equation-preservation: an interaction commits ONLY the axes it moved, so a
// stored "=equation" on an untouched axis is never clobbered (the reported bug:
// moving/resizing on one axis destroyed equations on the axes left alone).
test("translationPairs: pure-horizontal move writes x ONLY (y's equation survives)", () => {
  // Item's stored y is the equation "=100+shape_2.x" (resolved to startY=20 at
  // grab). A dy===0 drag must NOT emit a y pair — commit leaves y's raw string.
  eq(translationPairs({ itemId: "r", plugin: {}, startX: 10, startY: 20 }, 5, 0),
    [[["items", "r", "x"], 15]]);
  // Vertical-only is the mirror; a zero-delta move writes nothing at all.
  eq(translationPairs({ itemId: "r", plugin: {}, startX: 10, startY: 20 }, 0, 7),
    [[["items", "r", "y"], 27]]);
  eq(translationPairs({ itemId: "r", plugin: {}, startX: 10, startY: 20 }, 0, 0), []);
});
// ── R6-18.1: a coordinate that is NOT A FREE NUMBER is not translated ────────
// The clone home (paste + Duplicate) routes its offset through THIS rule, and it
// hands over the RAW stored state, where a coordinate may be ABSENT (an arrow
// stores its position in from/to and has no x at all) or an EQUATION STRING. The
// drag callers only ever pass resolved numbers (CanvasView's `n.state.x ?? 0`),
// so this is invisible to them — but the old rule answered `undefined + 16` =
// NaN and `"circle.x + 10" + 16` = a concatenated string, and the clone home's
// private `x: clone.x ?? 0` bypass turned the first of those into a FABRICATED
// x/y that gave an arrow a non-identity `world` (ink +16, handles +0 — the
// reported detached-handles bug).
test("translationPairs: an ABSENT coordinate is not invented (no phantom x/y)", () => {
  eq(translationPairs({ itemId: "a", plugin: {}, rawItem: {} }, 16, 16), []);
});
test("translationPairs: an EQUATION coordinate stays verbatim (never concatenated)", () => {
  eq(translationPairs({ itemId: "r", plugin: {}, startX: "circle.x + 10", startY: 20 }, 16, 16),
    [[["items", "r", "y"], 36]]);
});

test("resize commit (east handle): delta has w ONLY — not x/y/h (their equations survive)", () => {
  // Replays resizeDrag's UNROTATED geometry math, then diffs vs the resolved
  // start (drag.startState) exactly as the commit does. Start x/y/h may hold
  // equations; only `w` (the grabbed axis) must appear in the committed delta.
  const s = { x: 300, y: 200, w: 100, h: 50 };
  const world = worldTransform({ ...s, rotation: 0, scale: 1 });
  const box = resizedBox([0, 0, s.w, s.h], { x: 20, y: 0 }, { east: true }, {}); // grow width by 20
  const ww = box[2] - box[0], hh = box[3] - box[1];
  const o = T.apply(world, 0, 0), p = T.apply(world, box[0], box[1]);
  const next = { x: s.x + (p.x - o.x), y: s.y + (p.y - o.y), w: ww, h: hh };
  eq(diffState(s, next, ["x", "y", "w", "h"]), { w: 120 });
});
test("resize commit (north handle): delta has y+h — not x/w", () => {
  // North moves the top edge: stored y AND h change; x and w (their equations)
  // are left untouched.
  const s = { x: 300, y: 200, w: 100, h: 50 };
  const world = worldTransform({ ...s, rotation: 0, scale: 1 });
  const box = resizedBox([0, 0, s.w, s.h], { x: 0, y: -10 }, { north: true }, {}); // raise top by 10
  const ww = box[2] - box[0], hh = box[3] - box[1];
  const o = T.apply(world, 0, 0), p = T.apply(world, box[0], box[1]);
  const next = { x: s.x + (p.x - o.x), y: s.y + (p.y - o.y), w: ww, h: hh };
  eq(diffState(s, next, ["x", "y", "w", "h"]), { y: 190, h: 60 });
});

// ── resizeAnchors / resizedBox ────────────────────────────────────────────
test("resizeAnchors: corner drag anchors at the opposite corner", () => {
  const a = resizeAnchors([0, 0, 100, 50], { east: true, south: true }, {});
  eq({ gx: a.gx, gy: a.gy, fx: a.fx, fy: a.fy, cx: a.cx, cy: a.cy, xActive: a.xActive, yActive: a.yActive },
    { gx: 100, gy: 50, fx: 0, fy: 0, cx: 50, cy: 25, xActive: true, yActive: true });
});
test("resizeAnchors: symmetric anchors at the center", () => {
  assert.equal(resizeAnchors([0, 0, 100, 50], { east: true }, { symmetric: true }).fx, 50);
});
test("resizedBox: plain east, symmetric, uniform-corner", () => {
  eq(resizedBox([0, 0, 100, 50], { x: 20, y: 0 }, { east: true }, {}), [0, 0, 120, 50]);
  eq(resizedBox([0, 0, 100, 50], { x: 20, y: 0 }, { east: true }, { symmetric: true }), [-20, 0, 120, 50]);
  eq(resizedBox([0, 0, 100, 50], { x: 100, y: 0 }, { east: true, south: true }, { uniform: true }), [0, 0, 180, 90]);
});
// THE FLIP-BY-DRAG (the removed inversion clamp — see resizedBox's "CORRECTING THE
// RECORD"). Dragging a handle THROUGH the opposite edge must keep tracking the
// cursor and come out inverted; zero is a point it passes, not a wall.
test("resizedBox: dragging east PAST the west edge inverts the box (flip by drag)", () => {
  eq(resizedBox([0, 0, 100, 50], { x: -100, y: 0 }, { east: true }, {}), [0, 0, 0, 50]); // exactly on the anchor
  eq(resizedBox([0, 0, 100, 50], { x: -200, y: 0 }, { east: true }, {}), [0, 0, -100, 50]);
  // The FIXED (west) edge stays fixed at 0 the whole way through — the flip is
  // anchored, so the widget does not jump when it inverts.
  eq(resizedBox([0, 0, 100, 50], { x: -350, y: 0 }, { east: true }, {})[0], 0);
});
test("resizedBox: west/north handles invert symmetrically", () => {
  eq(resizedBox([0, 0, 100, 50], { x: 200, y: 0 }, { west: true }, {}), [200, 0, 100, 50]);
  eq(resizedBox([0, 0, 100, 50], { x: 0, y: 100 }, { north: true }, {}), [0, 100, 100, 50]);
});
test("resizedBox: uniform corner past the anchor point-reflects (BOTH axes flip)", () => {
  eq(resizedBox([0, 0, 100, 50], { x: -200, y: -100 }, { east: true, south: true }, { uniform: true }), [0, 0, -100, -50]);
});
test("resizedBox: symmetric east past the center inverts about the center", () => {
  // base center x = 50; dragging east to x = -50 puts the east edge 100 left of
  // center, so the mirrored west edge lands 100 right of it.
  eq(resizedBox([0, 0, 100, 50], { x: -150, y: 0 }, { east: true }, { symmetric: true }), [150, 0, -50, 50]);
});

// ── scaledBoxAboutPoint / scaleMemberPairs / scalePairs ────────────────────
const member = (over = {}) => {
  const state = { x: 300, y: 300, w: 200, h: 120, rotation: Math.PI / 4, scale: 1.5, ...over };
  return { itemId: "r", plugin: {}, rawItem: { w: state.w, h: state.h }, startWorld: worldTransform(state), startW: state.w, startH: state.h, startX: state.x, startY: state.y, _state: state };
};
const cornerSet = (world, w, h) => [[0, 0], [w, 0], [w, h], [0, h]].map(([lx, ly]) => T.apply(world, lx, ly));

test("scaledBoxAboutPoint: unrotated is the plain proportional scale", () => {
  const m = member({ rotation: 0, scale: 1 });
  eq(scaledBoxAboutPoint(m, 2, 2, 0, 0), { x: 600, y: 600, w: 400, h: 240 });
});
test("scaledBoxAboutPoint: 45° UNIFORM scale is EXACT (world corners map about the anchor)", () => {
  // The house standard: analytic asserts at 45°. After scaling by k about c,
  // every world corner p must land at c + k·(p − c).
  for (const k of [2, 0.5, 1.75])
    for (const c of [{ x: 250, y: 260 }, { x: 300, y: 300 }]) {
      const m = member();
      const before = cornerSet(m.startWorld, m.startW, m.startH);
      const nb = scaledBoxAboutPoint(m, k, k, c.x, c.y);
      const after = cornerSet(worldTransform({ ...m._state, x: nb.x, y: nb.y, w: nb.w, h: nb.h }), nb.w, nb.h);
      for (let i = 0; i < 4; i++) {
        approx(after[i].x, c.x + k * (before[i].x - c.x));
        approx(after[i].y, c.y + k * (before[i].y - c.y));
      }
    }
});
test("scaledBoxAboutPoint: per-axis (kx≠ky) unrotated maps corners about the anchor", () => {
  const m = member({ rotation: 0, scale: 1 });
  const before = cornerSet(m.startWorld, m.startW, m.startH);
  const [kx, ky, ax, ay] = [2, 3, 100, 100];
  const nb = scaledBoxAboutPoint(m, kx, ky, ax, ay);
  const after = cornerSet(worldTransform({ ...m._state, x: nb.x, y: nb.y, w: nb.w, h: nb.h }), nb.w, nb.h);
  for (let i = 0; i < 4; i++) {
    approx(after[i].x, ax + kx * (before[i].x - ax));
    approx(after[i].y, ay + ky * (before[i].y - ay));
  }
});
test("scaleMemberPairs: bbox writes x/y/w/h; touch suppresses an axis", () => {
  const m = member({ rotation: 0, scale: 1, x: 10, y: 20, w: 100, h: 50 });
  eq(scaleMemberPairs(m, 2, 2, 0, 0),
    [[["items", "r", "x"], 20], [["items", "r", "y"], 40], [["items", "r", "w"], 200], [["items", "r", "h"], 100]]);
  eq(scaleMemberPairs(m, 2, 1, 0, 0, { x: true, y: false }),
    [[["items", "r", "x"], 20], [["items", "r", "w"], 200]]);
});
test("scaleMemberPairs: single-axis multi-resize (ky=1) on an unrotated member writes x/w ONLY", () => {
  // Dragging only the east edge of a multi-selection ⇒ kx≠1, ky===1. The still
  // y-axis must NOT be rewritten, so a stored equation on y/h survives (the
  // reported bug: a one-axis resize destroyed the other axis's equations).
  const m = member({ rotation: 0, scale: 1, x: 10, y: 20, w: 100, h: 50 });
  eq(scaleMemberPairs(m, 2, 1, 0, 0),
    [[["items", "r", "x"], 20], [["items", "r", "w"], 200]]);
});
test("scaleMemberPairs: moveBy scales free endpoints about the anchor", () => {
  const plugin = { moveBy: () => [] }; // presence of moveBy selects the endpoint branch
  const m = { itemId: "a", plugin, rawItem: { from: { x: 0, y: 0 }, to: { x: 100, y: 0 } } };
  eq(scaleMemberPairs(m, 2, 2, 0, 0),
    [[["items", "a", "from", "x"], 0], [["items", "a", "from", "y"], 0], [["items", "a", "to", "x"], 200], [["items", "a", "to", "y"], 0]]);
});
test("scalePairs: adapter — uniform about c, axis constraint suppresses the other axis", () => {
  const m = member({ rotation: 0, scale: 1, x: 10, y: 20, w: 100, h: 50 });
  eq(scalePairs(m, 2, { x: 0, y: 0 }),
    [[["items", "r", "x"], 20], [["items", "r", "y"], 40], [["items", "r", "w"], 200], [["items", "r", "h"], 100]]);
  eq(scalePairs(m, 2, { x: 0, y: 0 }, "x"),
    [[["items", "r", "x"], 20], [["items", "r", "w"], 200]]);
});

// ── creationRect / creationEndpoint (manifest ROUND 13.2 CREATION-DRAG
// MODIFIERS) — mirrors of the module's own doctests, plus the quadrant-
// direction cases that motivated a dedicated point-anchored function instead
// of reusing resizedBox with a collapsed base box (see the docstring: a
// collapsed base makes resizedBox's gx/gy/fx/fy all coincide, so its uniform
// branch finds a zero drive vector and silently falls through to a plain,
// non-aspect-locked move — verified during design, not just asserted here).
test("creationRect: plain drag in all four quadrants", () => {
  eq(creationRect(100, 100, 300, 50, {}), [100, 50, 300, 100]); // down-right in x, up in y
  eq(creationRect(100, 100, 50, 40, {}), [50, 40, 100, 100]); // up-left quadrant
  eq(creationRect(100, 100, 300, 150, {}), [100, 100, 300, 150]); // down-right quadrant
});
test("creationRect: uniform (Shift) locks aspect to a square, any quadrant", () => {
  eq(creationRect(100, 100, 300, 130, { uniform: true }), [100, 100, 300, 300]); // dx dominates
  eq(creationRect(100, 100, 50, 40, { uniform: true }), [40, 40, 100, 100]); // dy dominates, up-left
});
test("creationRect: symmetric (Cmd) grows both sides about the start", () => {
  eq(creationRect(100, 100, 300, 150, { symmetric: true }), [-100, 50, 300, 150]);
  eq(creationRect(100, 100, 50, 150, { symmetric: true }), [50, 50, 150, 150]);
});
test("creationRect: uniform+symmetric composes (aspect-locked AND centered)", () => {
  eq(creationRect(100, 100, 300, 130, { uniform: true, symmetric: true }), [-100, -100, 300, 300]);
});
test("creationEndpoint: plain drag is a straight from-start to-pointer segment", () => {
  eq(creationEndpoint(100, 100, 300, 130, {}), { from: { x: 100, y: 100 }, to: { x: 300, y: 130 } });
});
test("creationEndpoint: uniform (Shift) axis-locks to the dominant direction", () => {
  eq(creationEndpoint(100, 100, 300, 130, { uniform: true }), { from: { x: 100, y: 100 }, to: { x: 300, y: 100 } });
  eq(creationEndpoint(100, 100, 130, 300, { uniform: true }), { from: { x: 100, y: 100 }, to: { x: 100, y: 300 } });
});
test("creationEndpoint: symmetric (Cmd) mirrors both endpoints about the start", () => {
  eq(creationEndpoint(100, 100, 300, 130, { symmetric: true }), { from: { x: -100, y: 70 }, to: { x: 300, y: 130 } });
});

// ── groupResizeState (manifest 15.7 GROUP RESIZE — uniform scale + x/y) ────────
test("groupResizeState: doctest — BR corner ×2 about the fixed top-left", () => {
  eq(groupResizeState({ x: 100, y: 100, w: 200, h: 100, rotation: 0, scale: 1 }, { x: 100, y: 100, rotation: 0, scale: 1 }, { east: true, south: true }, {}, { x: 200, y: 100 }),
    { scale: 2, x: 100, y: 100 });
});
test("groupResizeState: TL corner drag scales about the fixed bottom-right, x/y move", () => {
  // Fixed corner = BR world (300,200). Shrink by dragging TL inward → scale 0.5.
  const gs = groupResizeState({ x: 100, y: 100, w: 200, h: 100, rotation: 0, scale: 1 }, { x: 100, y: 100, rotation: 0, scale: 1 }, { west: true, north: true }, {}, { x: 100, y: 50 });
  approx(gs.scale, 0.5);
  approx(gs.x, 200); approx(gs.y, 150); // the new box origin (world) after shrinking to BR
});
test("groupResizeState: an existing group scale multiplies (not overwrites)", () => {
  // A group already at scale 2, resized ×1.5 about TL → 3.
  const gs = groupResizeState({ x: 0, y: 0, w: 100, h: 100, rotation: 0, scale: 2 }, { x: 0, y: 0, rotation: 0, scale: 2 }, { east: true, south: true }, {}, { x: 50, y: 50 });
  approx(gs.scale, 3);
});

// ── SELECTED-OBJECT DRAG PRIORITY: bounding-box grab (2b) ────────────────────
// The onPointerDown precedence for a plain (non-shift) pointer-down, reproduced
// against REAL derived nodes so the circle's ellipse hitTest / rect's full-bbox
// hit / camera's border hit are all exercised end-to-end. This is a MIRROR of
// CanvasView.svelte `onPointerDown` (the block ending `const grab = overrideSel
// ?? hit`, plus the `!e.shiftKey && !hit && !overrideSel` band branch) — kept in
// sync by hand, exactly as dragkinds mirrors dragKinds.js doctests. It returns
// the decision that pointer-down reaches: "band" | "move"(itemId, clickSelectId)
// | "none". `grabbable(n)` is CanvasView's draggable test.
const registry = createRegistry();
registerAll(registry, createCommands());
const grabbable = (node) => !!node && !!(node.plugin.capabilities.transform || node.plugin.moveBy);

function pointerDownDecision(nodes, selIds, wx, wy, tol = 0) {
  const hit = pickNode(nodes, wx, wy, tol);
  let overrideSel = null, clickSelectId = null;
  if (selIds.length && !(hit && selIds.includes(hit.itemId))) {
    const selSet = new Set(selIds);
    const selNodes = nodes.filter((node) => selSet.has(node.itemId));
    const onSel = pickNode(selNodes, wx, wy, tol) ?? selNodes.findLast((node) => pointInNodeBox(node.state, wx, wy));
    if (grabbable(onSel)) { overrideSel = onSel; clickSelectId = hit?.itemId ?? null; }
  }
  const grab = overrideSel ?? hit;
  if (!hit && !overrideSel) return { action: "band" };
  if (!grabbable(grab)) return { action: "none" };
  return { action: "move", itemId: grab.itemId, clickSelectId };
}

// A scene: a CIRCLE (ellipse hitTest — bbox corners are OFF-shape) placed clear
// of the camera border, plus rects for the "object on top" and "other member".
function scene() {
  let doc = newDocument();
  let circle, cover, other;
  [doc, circle] = withNewItem(doc, 0, { type: "circle", active: true, x: 200, y: 200, w: 100, h: 100, rotation: 0, scale: 1, z: 1 });
  [doc, cover] = withNewItem(doc, 0, { type: "rect", active: true, x: 202, y: 202, w: 6, h: 6, rotation: 0, scale: 1, z: 5 }); // covers the corner, on top
  [doc, other] = withNewItem(doc, 0, { type: "rect", active: true, x: 400, y: 400, w: 50, h: 50, rotation: 0, scale: 1, z: 2 });
  const nodes = deriveRenderTree(evaluateState(foldState(doc, 0, 1), registry).state, registry);
  return { nodes, circle, cover, other };
}
// The circle's TOP-LEFT bbox corner (204,204) is inside the 100×100 box but
// OUTSIDE the ellipse — the exact gap the fix closes.
const CORNER_X = 204, CORNER_Y = 204;

test("dragPriority: circle-corner press with pickNode MISSING confirms the gap 2b closes", () => {
  const { nodes, circle } = scene();
  const circleNode = nodes.find((node) => node.itemId === circle);
  // Restricted to the circle alone: the ellipse hitTest misses its bbox corner
  // (2a would fail), but the oriented box catches it (2b).
  assert.equal(pickNode([circleNode], CORNER_X, CORNER_Y), null);
  assert.ok(pointInNodeBox(circleNode.state, CORNER_X, CORNER_Y));
});
test("dragPriority: selected circle, press in empty box corner (nothing on top) MOVES it (was band-select)", () => {
  const { nodes, circle, cover, other } = scene();
  // Remove the cover so nothing is on top at the corner — the pure band-vs-grab case.
  const bare = nodes.filter((node) => node.itemId !== cover && node.itemId !== other);
  const d = pointerDownDecision(bare, [circle], CORNER_X, CORNER_Y);
  assert.deepEqual(d, { action: "move", itemId: circle, clickSelectId: null });
});
test("dragPriority: NOT selected → same empty-corner press still BAND-selects (fix is gated on selection)", () => {
  const { nodes, circle, cover, other } = scene();
  const bare = nodes.filter((node) => node.itemId !== cover && node.itemId !== other);
  assert.deepEqual(pointerDownDecision(bare, [], CORNER_X, CORNER_Y), { action: "band" });
});
test("dragPriority: selected circle, corner press with a DIFFERENT object ON TOP grabs the circle; click cycles to the top", () => {
  const { nodes, circle, cover } = scene();
  // `cover` (a small rect) sits on top at the corner. Dragging moves the selected
  // circle (2b beats the topmost hit); a no-drag release selects `cover` (clickSelectId).
  const d = pointerDownDecision(nodes, [circle], CORNER_X, CORNER_Y);
  assert.deepEqual(d, { action: "move", itemId: circle, clickSelectId: cover });
});
test("dragPriority: press OUTSIDE every selected box (no hit) still starts BAND-select", () => {
  const { nodes, circle, cover, other } = scene();
  const bare = nodes.filter((node) => node.itemId !== cover && node.itemId !== other);
  assert.deepEqual(pointerDownDecision(bare, [circle], 600, 400), { action: "band" }); // camera interior, off the circle box
});
test("dragPriority: MULTI-selection — a press in ANY selected member's box moves the set (grab is a selected member)", () => {
  const { nodes, circle, cover, other } = scene();
  const bare = nodes.filter((node) => node.itemId !== cover); // circle + other both selected, nothing on top
  const d = pointerDownDecision(bare, [circle, other], CORNER_X, CORNER_Y);
  assert.equal(d.action, "move");
  assert.ok([circle, other].includes(d.itemId)); // grabbed a selected member (drag-all moves the whole set via translateMembers)
  assert.equal(d.itemId, circle); // specifically the member whose box the point is in
});

console.log(`\ndragKinds tests: ${n} passed`);
