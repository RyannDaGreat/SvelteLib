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
import { worldTransform } from "../core/derive.js";
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

// ── resizeAnchors / resizedBox ────────────────────────────────────────────
test("resizeAnchors: corner drag anchors at the opposite corner", () => {
  const a = resizeAnchors([0, 0, 100, 50], { east: true, south: true }, {});
  eq({ gx: a.gx, gy: a.gy, fx: a.fx, fy: a.fy, cx: a.cx, cy: a.cy, xActive: a.xActive, yActive: a.yActive },
    { gx: 100, gy: 50, fx: 0, fy: 0, cx: 50, cy: 25, xActive: true, yActive: true });
});
test("resizeAnchors: symmetric anchors at the center", () => {
  assert.equal(resizeAnchors([0, 0, 100, 50], { east: true }, { symmetric: true }).fx, 50);
});
test("resizedBox: plain east, symmetric, uniform-corner, and clamp", () => {
  eq(resizedBox([0, 0, 100, 50], { x: 20, y: 0 }, { east: true }, {}), [0, 0, 120, 50]);
  eq(resizedBox([0, 0, 100, 50], { x: 20, y: 0 }, { east: true }, { symmetric: true }), [-20, 0, 120, 50]);
  eq(resizedBox([0, 0, 100, 50], { x: 100, y: 0 }, { east: true, south: true }, { uniform: true }), [0, 0, 180, 90]);
  eq(resizedBox([0, 0, 100, 50], { x: -200, y: 0 }, { east: true }, {}), [0, 0, 0, 50]);
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

console.log(`\ndragKinds tests: ${n} passed`);
