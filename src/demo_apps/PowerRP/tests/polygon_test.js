/**
 * Polygon tests — the freeform-polygon widget (plugins/polygon.js). Plain node,
 * no framework (suite convention). Run from the SvelteLib repo root or here:
 *   node src/demo_apps/PowerRP/tests/polygon_test.js
 *
 * Covers, per the task's VERIFY bar:
 *   (1) the pure geometry: path building (open vs closed), Shift angle snapping,
 *       close-the-loop hit detection, the world→normalized constructor, the
 *       chain distance / closest-point solvers, the ink rect.
 *   (2) EVEN-ODD is the fill rule AND the hit test, so "clickable" == "painted",
 *       and both are WINDING-INDEPENDENT (the reason even-odd was chosen).
 *   (3) rendering: one `path` op; filled iff the loop encloses area; open chains
 *       carry no `Z`; no `A` arc command (PDF/SVG-export safe); the degenerate
 *       counts (0 / 1 / 2 vertices) and the zero-extent box.
 *   (4) the VARIABLE-ARITY handles: one per vertex, each placed exactly on its
 *       vertex, each apply() round-tripping, and correct through a ROTATED +
 *       SCALED world (the derive → CanvasView contract, exercised end to end).
 *   (5) KEYFRAMING — the headline feature: a same-count point list tweens
 *       ELEMENT-WISE at alpha 0.25/0.5/0.75 with NO integer snapping, and a
 *       count change switches DISCRETELY. Proved through the real document
 *       pipeline (keyframed + foldState), not just the interpolator.
 *   (6) registry integration: the universal effects bundle is INJECTED (not
 *       self-composed), and the transform/anchor/snap surfaces answer.
 *   (7) DETERMINISM: the same document derives byte-identical IR twice.
 */

import assert from "node:assert/strict";
import {
  polygonPlugin, unitRegularPolygon, normalizedPoints, localPoints, fillsInterior,
  openPathD, polygonChainPathD, withPointAt, distToChain, closestPointOnChain,
  angleSnappedPoint, closeLoopIndex, polygonFromWorldPoints, polygonInkRect,
  MIN_POLYGON_VERTICES, MIN_DRAWN_VERTICES, SHIFT_ANGLE_DIVISIONS,
  POINTS_LIST, visiblePoints, closestChainProjection, withVertexInsertedNear,
} from "../plugins/polygon.js";
import { elementActive, withElementActive, withElementPurged, indexAfterPurge } from "../core/lists.js";
import { pointInPolygon, signedArea } from "../core/outline.js";
import { createRegistry } from "../core/registry.js";
// builtinRoster(), NOT allPlugins: this file SWEEPS "every shipped widget", and
// allPlugins is only the SOURCE-MODULE half of the roster — the five batch-1 widgets
// (donut, progress_bar, number, both clocks) moved to the built-in plugin-asset
// library and silently left every such sweep. See plugins/index.js builtinRoster.
import { builtinRoster, registerPlugins } from "../plugins/index.js";

const roster = builtinRoster();
import { deriveRenderTree, nodeModifierPoints, nodeAnchors, nodeFeatures, pickNode } from "../core/derive.js";
import { localBoundsOf, defaultCanSkip } from "../core/view.js";
import { keyframed, foldState, repairedDocument, serialize } from "../core/document.js";
import { sceneIR } from "../render_gpu/ports.js";
import * as T from "../core/transform.js";

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const registry = createRegistry();
registerPlugins(registry); // BOTH halves of the roster: source modules + the built-in plugin-asset library
const registered = registry.get("polygon");

// A unit SQUARE and a self-crossing PENTAGRAM, the two shapes the fill-rule and
// hit-test claims are made about. The pentagram is the classic even-odd case:
// five clicks, every other vertex, so the middle is enclosed TWICE.
const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]];
const PENTAGRAM = [0, 2, 4, 1, 3].map((k) => {
  const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
  return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
});

/** Pure function. A full polygon item state from a partial override — the
 *  registered defaults are the substrate every case starts from.
 *  @example polyState({w: 10}).w // 10 */
function polyState(over = {}) {
  return { ...registered.defaults, x: 0, y: 0, w: 100, h: 100, ...over };
}

/** Pure function. A single-item document whose slide 0 creates that polygon.
 *  @example oneSlideDoc({type: "polygon"}).slides.length // 1 */
function oneSlideDoc(state, extraSlides = 0) {
  const slides = [{ id: "s0", name: "s0", delta: { items: { poly: state } } }];
  for (let i = 0; i < extraSlides; i++) slides.push({ id: `s${i + 1}`, name: `s${i + 1}`, delta: {} });
  return { meta: {}, slides };
}

// ── (1) pure geometry ────────────────────────────────────────────────────────
test("unitRegularPolygon: inscribed in the unit box, first vertex straight up, loud below 3", () => {
  assert.deepEqual(unitRegularPolygon(4), [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
  const penta = unitRegularPolygon(5);
  assert.equal(penta.length, 5);
  assert.deepEqual(penta[0], [0.5, 0]); // top-up
  for (const [x, y] of penta) assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `${x},${y} escapes the unit box`);
  assert.throws(() => unitRegularPolygon(2), /need >= 3/);
});

test("normalizedPoints / localPoints: box fractions scale by w and h independently", () => {
  assert.deepEqual(normalizedPoints({}), []);
  assert.deepEqual(localPoints({ points: SQUARE, w: 200, h: 50 }), [[0, 0], [200, 0], [200, 50], [0, 50]]);
  // A NON-uniform box stretch is exactly why the points are normalized: resizing
  // the bbox reshapes the polygon (the PowerPoint freeform behaviour).
  assert.deepEqual(localPoints({ points: [[0.25, 0.5]], w: 400, h: 10 }), [[100, 5]]);
  // Zero-extent axis collapses to the origin, and does NOT produce NaN.
  assert.deepEqual(localPoints({ points: [[0.5, 0.5]], w: 0, h: 0 }), [[0, 0]]);
});

test("fillsInterior: closed AND >= 3 vertices — 2 points are a line either way", () => {
  assert.equal(fillsInterior({ closed: true, points: SQUARE }), true);
  assert.equal(fillsInterior({ closed: false, points: SQUARE }), false);
  assert.equal(fillsInterior({ closed: true, points: [[0, 0], [1, 1]] }), false);
  assert.equal(fillsInterior({ closed: true, points: [[0, 0]] }), false);
  assert.equal(fillsInterior({ closed: true, points: [] }), false);
  assert.equal(fillsInterior({ points: SQUARE }), false); // absent flag reads as OPEN
});

test("openPathD / polygonChainPathD: Z iff the loop encloses area; never an arc", () => {
  assert.equal(openPathD([[0, 0], [10, 0], [10, 10]]), "M0 0 L10 0 L10 10");
  assert.equal(polygonChainPathD([[0, 0], [10, 0], [5, 8]], true), "M0 0 L10 0 L5 8 Z");
  assert.equal(polygonChainPathD([[0, 0], [10, 0], [5, 8]], false), "M0 0 L10 0 L5 8");
  assert.equal(polygonChainPathD([[0, 0], [10, 0]], true), "M0 0 L10 0"); // 2 points: never closed
  assert.equal(polygonChainPathD([[0, 0], [10, 0], [5, 8]], true).includes("A"), false);
  assert.throws(() => openPathD([[0, 0]]), /need >= 2/);
});

test("withPointAt: replaces ONE vertex, returns a NEW list, loud out of range", () => {
  const before = [[0, 0], [1, 0], [1, 1]];
  const after = withPointAt(before, 1, [0.5, 0.25]);
  assert.deepEqual(after, [[0, 0], [0.5, 0.25], [1, 1]]);
  assert.deepEqual(before, [[0, 0], [1, 0], [1, 1]], "the input list must NOT be mutated (deltas share arrays as leaves)");
  assert.notEqual(after, before);
  assert.throws(() => withPointAt(before, 3, [0, 0]), /outside a 3-vertex list/);
  assert.throws(() => withPointAt(before, -1, [0, 0]), /outside a 3-vertex list/);
});

test("distToChain: min over segments; the closing edge only when closed; Infinity when empty", () => {
  const L = [[0, 0], [10, 0], [10, 10]];
  approx(distToChain(L, 5, 4, false), 4);
  // (5,5) is ON the closing (10,10) → (0,0) diagonal, and 5 away from both drawn
  // legs — so the closing edge is exactly what `closed` adds.
  approx(distToChain(L, 5, 5, false), 5);
  approx(distToChain(L, 5, 5, true), 0);
  approx(distToChain([[3, 4]], 0, 0, true), 5); // a lone vertex
  assert.equal(distToChain([], 0, 0, true), Infinity);
});

test("closestPointOnChain: clamped per segment; lone vertex; empty → fallback", () => {
  assert.deepEqual(closestPointOnChain([[0, 0], [10, 0]], 4, 7, false, { x: 0, y: 0 }), { x: 4, y: 0 });
  assert.deepEqual(closestPointOnChain([[0, 0], [10, 0]], -6, 0, false, { x: 0, y: 0 }), { x: 0, y: 0 });
  assert.deepEqual(closestPointOnChain([[3, 4]], 0, 0, false, { x: 9, y: 9 }), { x: 3, y: 4 });
  assert.deepEqual(closestPointOnChain([], 1, 2, false, { x: 9, y: 9 }), { x: 9, y: 9 });
  // The CLOSING edge is reachable only when closed (the fill/hit-test pairing).
  const tri = [[0, 0], [10, 0], [10, 10]];
  assert.deepEqual(closestPointOnChain(tri, 1, 9, true, { x: 0, y: 0 }), { x: 5, y: 5 });
});

test("angleSnappedPoint: nearest of N rays, LENGTH PRESERVED, degenerate is identity", () => {
  const O = { x: 0, y: 0 };
  // A shallow raw angle snaps to due east, keeping the length (true at any N).
  const east = angleSnappedPoint(O, { x: 100, y: 8 }, SHIFT_ANGLE_DIVISIONS);
  approx(east.y, 0);
  approx(east.x, Math.hypot(100, 8));
  // 8 divisions = 45°: a near-45° raw angle snaps to the exact diagonal (x === y).
  // Written with the LITERAL 8, not SHIFT_ANGLE_DIVISIONS: this pins the general
  // function's N-ray behaviour, which must not move if the flow's chosen N does.
  const diag = angleSnappedPoint(O, { x: 10, y: 9 }, 8);
  approx(diag.x, diag.y);
  approx(Math.hypot(diag.x, diag.y), Math.hypot(10, 9));
  // Anchored anywhere, not just the origin; and a zero-length drag is identity.
  const off = angleSnappedPoint({ x: 5, y: 5 }, { x: 5, y: 95 }, SHIFT_ANGLE_DIVISIONS);
  assert.deepEqual([Math.round(off.x), Math.round(off.y)], [5, 95]); // already due south
  assert.deepEqual(angleSnappedPoint({ x: 5, y: 5 }, { x: 5, y: 5 }, SHIFT_ANGLE_DIVISIONS), { x: 5, y: 5 });
});

test("SHIFT_ANGLE_DIVISIONS is an AXIS LOCK (the ruling), not a 45° snap", () => {
  // THE RULING (web/polygonDraw.js): the user's words are "I shift to constrain the
  // axis", and the older in-house Shift convention — core/snap.axisLock and
  // dragKinds.creationEndpoint's `uniform` — locks to the two axes. So the flow's N
  // is 4, and the HintBar chip is the existing DRAG_MODIFIER_HINTS.axisLock. This
  // test exists so flipping it back to 8 is a deliberate, visible decision.
  assert.equal(SHIFT_ANGLE_DIVISIONS, 4);
  const axis = angleSnappedPoint({ x: 0, y: 0 }, { x: 10, y: 9 }, SHIFT_ANGLE_DIVISIONS);
  approx(axis.y, 0); // the 45°-ish pointer lands on the horizontal, not the diagonal
  approx(axis.x, Math.hypot(10, 9));
});

test("closeLoopIndex: index 0 IS the close-the-loop gesture; -1 off a vertex", () => {
  const placed = [[0, 0], [50, 0], [50, 50]];
  assert.equal(closeLoopIndex(placed, { x: 3, y: 4 }, 6), 0);
  assert.equal(closeLoopIndex(placed, { x: 3, y: 4 }, 4), -1); // 5 > 4 tolerance
  assert.equal(closeLoopIndex(placed, { x: 50, y: 48 }, 6), 2);
  assert.equal(closeLoopIndex(placed, { x: 25, y: 0 }, 6), -1); // mid-segment
  assert.equal(closeLoopIndex([], { x: 0, y: 0 }, 6), -1);
});

test("polygonFromWorldPoints: fits the box to the hull and normalizes into it", () => {
  const tri = polygonFromWorldPoints([[10, 20], [110, 20], [110, 120]], true);
  assert.deepEqual(tri, { x: 10, y: 20, w: 100, h: 100, points: [[0, 0], [1, 0], [1, 1]], closed: true });
  // ROUND TRIP: the constructed state's local points, offset by x/y, are the
  // original world clicks — the creation flow's correctness condition.
  for (const [i, [wx, wy]] of [[10, 20], [110, 20], [110, 120]].entries()) {
    const [lx, ly] = localPoints(tri)[i];
    approx(tri.x + lx, wx);
    approx(tri.y + ly, wy);
  }
  // A FLAT chain: zero height, every y at the midline, and it still renders at 0.
  const flat = polygonFromWorldPoints([[0, 50], [100, 50]], false);
  assert.deepEqual(flat, { x: 0, y: 50, w: 100, h: 0, points: [[0, 0.5], [1, 0.5]], closed: false });
  assert.deepEqual(localPoints(flat), [[0, 0], [100, 0]]);
  // Empty (Escape with nothing placed) is a well-formed empty polygon.
  assert.deepEqual(polygonFromWorldPoints([], false), { x: 0, y: 0, w: 0, h: 0, points: [], closed: false });
});

test("polygonInkRect: unions the box with the vertex hull, padded by half the stroke", () => {
  assert.deepEqual(polygonInkRect({ points: SQUARE, w: 100, h: 100, strokeWidth: 0 }), { x: 0, y: 0, w: 100, h: 100 });
  // A vertex dragged OUTSIDE the box (normalized coords are not clamped).
  assert.deepEqual(polygonInkRect({ points: [[-0.2, 0], [1, 1.5]], w: 100, h: 100, strokeWidth: 0 }), { x: -20, y: 0, w: 120, h: 150 });
  // A flat chain is still a real strokeable region (never degenerate).
  const flat = polygonInkRect({ points: [[0, 0], [1, 0]], w: 100, h: 0, strokeWidth: 4 });
  assert.deepEqual(flat, { x: -2, y: -2, w: 104, h: 4 });
  assert.ok(flat.w > 0 && flat.h > 0);
});

// ── (2) EVEN-ODD: the fill rule IS the hit test, and both ignore winding ─────
test("EVEN-ODD: a pentagram's centre is HOLLOW, and reversing the winding changes nothing", () => {
  const reversed = [...PENTAGRAM].reverse();
  assert.ok(signedArea(PENTAGRAM) * signedArea(reversed) < 0, "the two windings must genuinely differ in sign");
  // The centre is enclosed twice → even parity → outside.
  assert.equal(pointInPolygon(PENTAGRAM, 0.5, 0.5), false);
  assert.equal(pointInPolygon(reversed, 0.5, 0.5), false, "even-odd is winding-INDEPENDENT (the reason it was chosen)");
  // A point in one of the five limbs is enclosed once → inside.
  assert.equal(pointInPolygon(PENTAGRAM, 0.5, 0.1), true);
  assert.equal(pointInPolygon(reversed, 0.5, 0.1), true);
});

test("hitTest: clickable == painted (interior only when filled), band scales with tol", () => {
  const filled = polyState({ points: SQUARE, closed: true, strokeWidth: 0 });
  assert.equal(registered.hitTest(filled, 50, 50), true);   // inside a filled square
  assert.equal(registered.hitTest(filled, 150, 50), false); // outside the box
  const open = polyState({ points: SQUARE, closed: false, strokeWidth: 0 });
  assert.equal(registered.hitTest(open, 50, 50), false, "an OPEN chain paints no interior, so it must not be hit there");
  assert.equal(registered.hitTest(open, 50, 0), true, "…but its outline is hit");
  // A hairline chain becomes grabbable through the caller's screen tolerance.
  assert.equal(registered.hitTest(open, 50, 6, 0), false);
  assert.equal(registered.hitTest(open, 50, 6, 8), true);
  // A self-crossing polygon's HOLE is not clickable, matching its even-odd fill.
  const star = polyState({ points: PENTAGRAM, closed: true, strokeWidth: 0 });
  assert.equal(registered.hitTest(star, 50, 50), false, "the pentagram's hollow centre must not be clickable");
  assert.equal(registered.hitTest(star, 50, 10), true);
});

test("hitTest: a degenerate (< 2 vertex) polygon falls back to its BBOX so it stays selectable", () => {
  for (const points of [[], [[0.5, 0.5]]]) {
    const s = polyState({ points });
    assert.equal(registered.isGhost(s), true);
    assert.equal(registered.hitTest(s, 50, 50), true, "invisible AND unreachable would be a trap");
    assert.equal(registered.hitTest(s, 150, 50), false);
  }
  assert.equal(registered.isGhost(polyState({ points: [[0, 0], [1, 1]] })), false);
});

// ── (3) rendering ────────────────────────────────────────────────────────────
test("emit: ONE path op, evenodd, filled + stroked when closed", () => {
  const ops = registered.emit(polyState({ points: SQUARE, closed: true }));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "path");
  assert.equal(ops[0].fillRule, "evenodd");
  assert.equal(ops[0].d, "M0 0 L100 0 L100 100 L0 100 Z");
  assert.ok(ops[0].fill !== null, "a closed polygon fills");
  assert.ok(ops[0].stroke !== null, "strokeWidth 2 strokes");
  assert.equal(ops[0].d.includes("A"), false, "no arc command — PDF/SVG-export safe");
});

test("emit: an OPEN chain has NO Z and NO fill (only a stroke)", () => {
  const ops = registered.emit(polyState({ points: SQUARE, closed: false }));
  assert.equal(ops[0].d, "M0 0 L100 0 L100 100 L0 100");
  assert.equal(ops[0].d.includes("Z"), false);
  assert.equal(ops[0].fill, null, "an open polyline must not fill (that would invent a closing edge)");
  assert.ok(ops[0].stroke !== null);
});

test("emit: degenerate counts and a ZERO-EXTENT box", () => {
  assert.deepEqual(registered.emit(polyState({ points: [] })), []);
  assert.deepEqual(registered.emit(polyState({ points: [[0.5, 0.5]] })), []);
  // 2 points: a LINE — stroked, unclosed, unfilled even with closed: true.
  const line = registered.emit(polyState({ points: [[0, 0], [1, 1]], closed: true }))[0];
  assert.equal(line.d, "M0 0 L100 100");
  assert.equal(line.fill, null);
  // A zero-height box still RENDERS (no w/h > 0 guard): this is how a perfectly
  // horizontal chain is stored, and it must not silently vanish.
  const flat = registered.emit(polyState({ points: [[0, 0.5], [1, 0.5]], w: 100, h: 0, closed: false }))[0];
  assert.equal(flat.d, "M0 0 L100 0");
});

test("emit: strokeWidth 0 drops the stroke; the fill alone still paints", () => {
  const ops = registered.emit(polyState({ points: SQUARE, closed: true, strokeWidth: 0 }));
  assert.equal(ops[0].stroke, null);
  assert.ok(ops[0].fill !== null);
});

// ── (4) the VARIABLE-ARITY handles ───────────────────────────────────────────
test("modifierPoints: exactly ONE handle per vertex, at ANY count, placed on its vertex", () => {
  for (const n of [0, 1, 2, 3, 5, 12]) {
    const points = Array.from({ length: n }, (_, i) => [i / Math.max(1, n), (i % 3) / 4]);
    const s = polyState({ points, w: 200, h: 80 });
    const mps = registered.modifierPoints(s);
    assert.equal(mps.length, n, `${n} vertices must give ${n} handles`);
    assert.deepEqual(mps.map((m) => m.id), points.map((_, i) => `p${i}`));
    // Each handle sits EXACTLY on the local vertex the renderer draws.
    const local = localPoints(s);
    mps.forEach((m, i) => { approx(m.x, local[i][0]); approx(m.y, local[i][1]); });
  }
});

test("modifierPoints: each apply() ROUND-TRIPS and touches ONLY its own vertex", () => {
  const s = polyState({ points: unitRegularPolygon(6), w: 300, h: 120 });
  const mps = registered.modifierPoints(s);
  mps.forEach((m, i) => {
    // Placing the handle where it already is recovers the list unchanged.
    const same = m.apply(s, { x: m.x, y: m.y }).points;
    same.forEach((p, k) => { approx(p[0], s.points[k][0]); approx(p[1], s.points[k][1]); });
    // Dragging it somewhere new writes exactly one vertex.
    const moved = m.apply(s, { x: 30, y: 90 }).points;
    approx(moved[i][0], 30 / 300);
    approx(moved[i][1], 90 / 120);
    moved.forEach((p, k) => { if (k !== i) assert.deepEqual(p, s.points[k], `vertex ${k} must be untouched`); });
    assert.equal(moved.length, s.points.length, "a drag never changes the vertex COUNT");
  });
});

test("modifierPoints: a vertex may be dragged OUTSIDE the box (no clamp), and the BOUNDS follow", () => {
  const s = polyState({ points: SQUARE, w: 100, h: 100, strokeWidth: 0 });
  const dragged = registered.modifierPoints(s)[0].apply(s, { x: -40, y: -25 }).points;
  assert.deepEqual(dragged[0], [-0.4, -0.25], "clamping would make the handle refuse to follow the pointer");
  const escaped = { ...s, points: dragged };
  const ink = polygonInkRect(escaped);
  assert.deepEqual(ink, { x: -40, y: -25, w: 140, h: 125 });
  // WHAT THIS USED TO ASSERT, AND WHY IT CHANGED. It was
  // `assert.equal(registered.cullMargin(escaped), 40)`: the plugin declared a
  // SECOND bounds mechanism, returning effectsCullMargin + the vertex hull's MAX
  // escape (40) from the HALO hook, so core/view.js inflated the BOX-derived AABB
  // enough to cover the escaped vertex. That worked but conflated two orthogonal
  // quantities — the widget's own INK and the effect halo BEYOND it — and it
  // over-reported, applying one max to all four sides. The polygon now declares
  // `localBounds: polygonInkRect` (THE bounds protocol, core/view.js
  // localBoundsOf) and `cullMargin: effectsCullMargin` like every other widget.
  assert.deepEqual(localBoundsOf({ plugin: registered, state: escaped }), ink,
    "the ink rect IS the declared bounds — one declaration, every consumer");
  assert.equal(registered.cullMargin(escaped), 0,
    "with no effect on there is no halo; ink is bounds, not margin");
  // THE GUARANTEE the old number was only a proxy for, now asserted directly: a
  // view rect containing ONLY the escaped vertex must not cull the polygon.
  const node = { plugin: registered, state: escaped, world: T.identity() };
  assert.equal(defaultCanSkip(node, { x: -45, y: -30, w: 10, h: 10 }), false,
    "the escaped vertex is visible, so the polygon must be drawn");
  // …and the new rect is TIGHTER, which the old rule could not be. The old margin
  // grew the box by 40 on EVERY side (x, y both spanning [-40, 140]); the per-side
  // ink rect stops at y = -25 above and x = 100 right. These two view rects hold
  // no ink at all, and now correctly cull where the old rule painted.
  assert.equal(defaultCanSkip(node, { x: 0, y: -39, w: 4, h: 4 }), true,
    "above the top-most ink: the old max-on-all-sides margin reached here, the ink does not");
  assert.equal(defaultCanSkip(node, { x: 130, y: 50, w: 5, h: 5 }), true,
    "right of the right-most ink: same over-report, other side");
});

test("modifierPoints: a ZERO-EXTENT axis KEEPS its coordinate (never NaN)", () => {
  const s = polyState({ points: [[0.25, 0.5], [0.75, 0.5]], w: 0, h: 0 });
  const out = registered.modifierPoints(s)[1].apply(s, { x: 12, y: 34 }).points;
  assert.deepEqual(out, [[0.25, 0.5], [0.75, 0.5]]);
  for (const [x, y] of out) assert.ok(Number.isFinite(x) && Number.isFinite(y));
});

test("modifierPoints through a ROTATED + SCALED world: the derive→CanvasView contract", () => {
  // The full path a real drag takes: nodeModifierPoints wraps local→world for
  // display, CanvasView inverts the pointer back through the SAME world, apply
  // runs in local space. So a handle grabbed at its own drawn world position and
  // released there must recover the identical list, at any rotation/scale.
  const state = polyState({ points: unitRegularPolygon(5), w: 200, h: 160, rotation: Math.PI / 5, scale: 1.7 });
  const doc = repairedDocument(oneSlideDoc(state), registry).doc;
  const nodes = deriveRenderTree(foldState(doc, 0, 0), registry);
  const node = nodes.find((n) => n.type === "polygon");
  const world = node.world;
  assert.notEqual(world.rotation, 0);
  assert.notEqual(world.scale, 1);
  const wrapped = nodeModifierPoints(node);
  assert.equal(wrapped.length, 5);
  wrapped.forEach((m, i) => {
    // The world handle is the local vertex pushed through the node world.
    const expect = T.apply(world, localPoints(node.state)[i][0], localPoints(node.state)[i][1]);
    approx(m.x, expect.x, 1e-6);
    approx(m.y, expect.y, 1e-6);
    // Round trip: invert the world (what CanvasView.modifierDrag does) → apply.
    const local = T.apply(T.invert(world), m.x, m.y);
    const back = m.apply(node.state, local).points;
    back.forEach((p, k) => { approx(p[0], node.state.points[k][0], 1e-9); approx(p[1], node.state.points[k][1], 1e-9); });
  });
  // A drag to a NEW world point lands where the pointer was, not somewhere
  // rotated away from it: re-deriving with the written list puts the handle back
  // under the pointer.
  const target = { x: wrapped[2].x + 40, y: wrapped[2].y - 25 };
  const written = wrapped[2].apply(node.state, T.apply(T.invert(world), target.x, target.y)).points;
  const after = nodeModifierPoints({ ...node, state: { ...node.state, points: written } })[2];
  approx(after.x, target.x, 1e-6);
  approx(after.y, target.y, 1e-6);
});

test("handle drag = ONE undo unit: the preview writes ONE leaf (the whole list)", () => {
  // app.setPreview builds a delta tree from [path, value] pairs and
  // app.commitPreview walks it, treating ARRAYS as leaves — so a drag produces
  // exactly ONE keyframed() call, i.e. one undo unit, on the current slide.
  // Reproduced here without the browser: modifierDrag's own pair construction.
  const state = polyState({ points: SQUARE, w: 100, h: 100 });
  const mp = registered.modifierPoints(state)[2];
  const pairs = Object.entries(mp.apply(state, { x: 80, y: 90 })).map(([key, value]) => [["items", "poly", key], value]);
  assert.equal(pairs.length, 1, "one drag must write ONE path");
  assert.deepEqual(pairs[0][0], ["items", "poly", "points"]);
  assert.ok(Array.isArray(pairs[0][1]));

  const doc0 = repairedDocument(oneSlideDoc(state), registry).doc;
  const doc1 = keyframed(doc0, 0, pairs[0][0], pairs[0][1]);
  assert.deepEqual(foldState(doc1, 0, 0).items.poly.points[2], [0.8, 0.9]);
  // UNDO is "the previous document": the pre-drag list is intact in doc0 and the
  // drag never mutated it (withPointAt copies).
  assert.deepEqual(foldState(doc0, 0, 0).items.poly.points[2], [1, 1]);
  assert.deepEqual(state.points, SQUARE);
});

// ── (5) KEYFRAMING (the headline feature) ────────────────────────────────────
test("KEYFRAMING: a SAME-COUNT point list tweens ELEMENT-WISE at 0.25 / 0.5 / 0.75", () => {
  const from = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const to = [[0, 0], [1, 0], [0.5, 0.4], [0, 1]]; // only vertex 2 moves
  let doc = repairedDocument(oneSlideDoc(polyState({ points: from, closed: true }), 1), registry).doc;
  doc = keyframed(doc, 1, ["items", "poly", "points"], to);
  for (const alpha of [0.25, 0.5, 0.75]) {
    const pts = foldState(doc, 1, alpha).items.poly.points;
    assert.equal(pts.length, 4, "the count is unchanged, so this is a SCALAR tween");
    // Vertex 2 lerps per coordinate…
    approx(pts[2][0], 1 + (0.5 - 1) * alpha);
    approx(pts[2][1], 1 + (0.4 - 1) * alpha);
    // …and NOTHING rounds, even though 0 and 1 are integers: this is exactly the
    // trap a list of {x, y} RECORDS would fall into (interpolate's int rule).
    assert.deepEqual(pts[0], [0, 0]);
    assert.deepEqual(pts[1], [1, 0]);
    assert.deepEqual(pts[3], [0, 1]);
  }
  // A 0 → 1 coordinate must lerp smoothly, not snap at the midpoint.
  let doc2 = repairedDocument(oneSlideDoc(polyState({ points: [[0, 0], [1, 0], [1, 1]] }), 1), registry).doc;
  doc2 = keyframed(doc2, 1, ["items", "poly", "points"], [[1, 1], [1, 0], [1, 1]]);
  approx(foldState(doc2, 1, 0.25).items.poly.points[0][0], 0.25, 1e-12);
  approx(foldState(doc2, 1, 0.5).items.poly.points[0][1], 0.5, 1e-12);
  // The endpoints are exact.
  assert.deepEqual(foldState(doc, 1, 0).items.poly.points, from);
  assert.deepEqual(foldState(doc, 1, 1).items.poly.points, to);
});

test("KEYFRAMING: a COUNT change is DISCRETE — it snaps, never a half-built shape", () => {
  const from = [[0, 0], [1, 0], [1, 1]];
  const to = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 1.4]]; // 3 → 5 vertices
  let doc = repairedDocument(oneSlideDoc(polyState({ points: from }), 1), registry).doc;
  doc = keyframed(doc, 1, ["items", "poly", "points"], to);
  assert.deepEqual(foldState(doc, 1, 0).items.poly.points, from);
  for (const alpha of [0.01, 0.25, 0.5, 0.75, 1]) {
    const pts = foldState(doc, 1, alpha).items.poly.points;
    assert.deepEqual(pts, to, `alpha ${alpha}: a structural change switches at alpha > 0`);
  }
  // Shrinking is the same rule.
  let back = repairedDocument(oneSlideDoc(polyState({ points: to }), 1), registry).doc;
  back = keyframed(back, 1, ["items", "poly", "points"], from);
  assert.deepEqual(foldState(back, 1, 0.5).items.poly.points, from);
});

test("KEYFRAMING: `closed` is a DISCRETE flip, and the tweened shape renders throughout", () => {
  const from = unitRegularPolygon(5);
  const to = unitRegularPolygon(5).map(([x, y]) => [x * 0.5 + 0.25, y * 0.5 + 0.25]);
  let doc = repairedDocument(oneSlideDoc(polyState({ points: from, closed: false }), 1), registry).doc;
  doc = keyframed(doc, 1, ["items", "poly", "points"], to);
  doc = keyframed(doc, 1, ["items", "poly", "closed"], true);
  assert.equal(foldState(doc, 1, 0).items.poly.closed, false);
  assert.equal(foldState(doc, 1, 0.5).items.poly.closed, true, "a boolean is discrete at alpha > 0");
  // Every alpha yields a real, renderable, one-op scene.
  for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
    const ops = sceneIR(deriveRenderTree(foldState(doc, 1, alpha), registry)).filter((c) => c.op === "path");
    assert.equal(ops.length, 1, `alpha ${alpha} must render exactly one polygon path`);
    assert.ok(!ops[0].d.includes("NaN"));
  }
});

// ── (6) registry integration ─────────────────────────────────────────────────
test("registry: the universal effects bundle is INJECTED (not self-composed)", () => {
  assert.equal(registered.effectsInjected, true, "the plugin must not compose the bundle itself");
  for (const key of ["shadow.opacity", "bloom.strength", "innerShadow.opacity", "softEdges", "blendMode"])
    assert.ok(registered.inspector.some((r) => r.key === key), `missing injected effect row ${key}`);
  assert.equal(registered.defaults.softEdges, 0, "injected effects must default OFF (byte identity)");
  // cullMargin is the SHARED effectsCullMargin — the plugin no longer wraps it to
  // smuggle its bounds through (that is `localBounds` now) — and it obeys the
  // universal contract: 0 with no effects, the shadow halo with one.
  assert.equal(registered.cullMargin({}), 0);
  assert.equal(registered.cullMargin({ shadow: { dx: 3, dy: 4, blur: 2, color: "#000", opacity: 0.5 } }), 11);
  // And ONE effectSubtree wrap when an effect is on, none when all are off.
  const node = { itemId: "i", type: "polygon", plugin: registered, world: T.identity(), state: polyState({}) };
  const count = (ops) => ops.filter((c) => c.op === "effectSubtree").length;
  assert.equal(count(sceneIR([node])), 0);
  assert.equal(count(sceneIR([{ ...node, state: { ...node.state, softEdges: 8 } }])), 1);
});

test("anchors / snapFeatures / closestAnchor: the 9 bbox anchors, one snap point per vertex", () => {
  const state = polyState({ points: SQUARE, w: 200, h: 100 });
  const doc = repairedDocument(oneSlideDoc(state), registry).doc;
  const node = deriveRenderTree(foldState(doc, 0, 0), registry).find((n) => n.type === "polygon");
  assert.deepEqual(nodeAnchors(node).map((a) => a.id).sort(), ["bl", "bm", "br", "cm", "ml", "mr", "tl", "tm", "tr"]);
  // Vertex snap features exist, are index-keyed, and land on the vertices.
  const feats = nodeFeatures(node).filter((f) => /:v\d+$/.test(f.id));
  assert.equal(feats.length, 4);
  assert.deepEqual(feats.map((f) => f.id.split(":")[1]), ["v0", "v1", "v2", "v3"]);
  approx(feats[2].x, node.world.x + 200);
  // closestAnchor answers in LOCAL coords, on the outline.
  const c = registered.closestAnchor(state, node.world.x + 100, node.world.y + 400, node.world);
  assert.deepEqual([c.x, c.y], [100, 100]); // straight down → the bottom edge
  // With no vertices there is no outline, so the box centre is the honest answer.
  assert.deepEqual(registered.closestAnchor(polyState({ points: [], w: 200, h: 100 }), 0, 0, T.identity()), { x: 100, y: 50 });
});

test("pickNode: a polygon is picked by its painted region through a rotated world", () => {
  const state = polyState({ points: SQUARE, w: 120, h: 120, rotation: Math.PI / 4, strokeWidth: 0, closed: true });
  const doc = repairedDocument(oneSlideDoc(state), registry).doc;
  const nodes = deriveRenderTree(foldState(doc, 0, 0), registry);
  const node = nodes.find((n) => n.type === "polygon");
  const centre = T.apply(node.world, 60, 60);
  assert.equal(pickNode(nodes, centre.x, centre.y)?.type, "polygon");
  // A point just outside the ROTATED square (past a corner along +x) misses it.
  const outside = T.apply(node.world, 60, 60);
  assert.notEqual(pickNode(nodes, outside.x + 200, outside.y)?.type, "polygon");
});

test("repair: a fresh polygon document needs NO repair (defaults are complete)", () => {
  const { doc, reports } = repairedDocument(oneSlideDoc({ ...registered.defaults }), registry);
  const mine = reports.filter((r) => JSON.stringify(r).includes("poly"));
  assert.deepEqual(mine, [], `a freshly authored polygon must round-trip clean: ${JSON.stringify(mine)}`);
  assert.deepEqual(foldState(doc, 0, 0).items.poly.points, registered.defaults.points);
});

// ── (7) DETERMINISM ─────────────────────────────────────────────────────────
test("DETERMINISM: the same document derives byte-identical IR and serialization twice", () => {
  const state = polyState({ points: PENTAGRAM, w: 240, h: 180, rotation: 0.37, scale: 1.3, closed: true, softEdges: 4 });
  const doc = repairedDocument(oneSlideDoc(state, 1), registry).doc;
  const irOf = () => JSON.stringify(sceneIR(deriveRenderTree(foldState(doc, 1, 0.5), registry)));
  assert.equal(irOf(), irOf());
  assert.equal(serialize(doc), serialize(doc));
  // A SECOND, independently repaired copy of the same input renders the same
  // polygon. Compared at the polygon's own op rather than on the whole
  // serialization, because repairedDocument MINTS THE CAMERA with a fresh
  // random id each time it has to inject one (a repair-stage id, unrelated to
  // this widget) — so the documents differ by that id while the drawn polygon
  // must be identical.
  const doc2 = repairedDocument(oneSlideDoc(state, 1), registry).doc;
  const irOf2 = () => JSON.stringify(sceneIR(deriveRenderTree(foldState(doc2, 1, 0.5), registry)));
  assert.equal(irOf2(), irOf(), "two independent repairs of the same input must render identically");
  // The polygon really is in there, evenodd, wrapped in exactly one effect
  // subtree (softEdges is on in this state) — so the comparison is not vacuous.
  assert.ok(irOf().includes('"fillRule":"evenodd"'));
  assert.equal(sceneIR(deriveRenderTree(foldState(doc, 1, 0.5), registry)).filter((c) => c.op === "effectSubtree").length, 1);
});

// ── THE TWO GAPS THIS SUITE USED TO PIN ARE CLOSED (core/lists.js) ───────────
// They were pinned as "a future fix must be noticed", and it arrived: `points` is
// now a DECLARED list property (core/properties.js PROPS.points), so the whole list
// has an equation result kind and a row kind exists for it. These tests now pin the
// NEW truth — including the one part that has NOT changed, so its absence is still
// deliberate rather than forgotten.
test("CLOSED GAP: `points` is a declared LIST property, so the whole list has a result kind", async () => {
  const { isEquationValue, resultKindForSlot, resultMatchesKind } = await import("../core/expressions.js");
  assert.equal(isEquationValue(registered, ["points", 0, "x"], "= 5"), true, "the `=` MARKER is recognized");
  // The list ROOT now types as "list" instead of falling to UNRESOLVED, which is
  // what made the old rejection loud-but-total.
  assert.equal(resultKindForSlot(registered, ["points"], "= [[0,0]]"), "list");
  assert.equal(resultMatchesKind([[0, 0]], "list"), true);
  // The KEYFRAME half is unchanged (it always worked — that is what made the gap
  // partial), and it must stay byte-exact: the whole list is ONE leaf.
  let doc = repairedDocument(oneSlideDoc(polyState({}), 1), registry).doc;
  doc = keyframed(doc, 1, ["items", "poly", "points"], SQUARE);
  assert.deepEqual(foldState(doc, 1, 1).items.poly.points, SQUARE);
});

test("CLOSED GAP: a list ROW_KIND exists, and the widget NOW declares its points row", async () => {
  const { ROW_KINDS, PROPS } = await import("../core/properties.js");
  assert.ok(ROW_KINDS.includes("list"), `the list row kind must exist: ${JSON.stringify(ROW_KINDS)}`);
  assert.equal(PROPS.points.kind, "list");
  assert.equal(PROPS.points.order, "sequence", "the order IS the outline — sorting would be a different polygon");
  assert.equal(PROPS.points.element.storage, "tuple", "tuples keep the tween on interpolate's plain-lerp branch");
  // FLIPPED (this assertion used to demand the row's ABSENCE): the Inspector's
  // list CONTROL now exists — web/ListField.svelte, reached by the dispatcher's
  // `kind === LIST_ROW_KIND` branch — so the row is safe to declare. Before that
  // branch existed a list row fell through the catch-all TEXT input, whose
  // oninput would have committed a string over the vertex array; that is why the
  // row and the control had to land together.
  const pointsRow = registered.inspector.find((r) => r.key === "points");
  assert.ok(pointsRow, "the vertex list must be an Inspector row now that the list control exists");
  assert.equal(pointsRow.kind, "list");
  // The ROW IS THE DECLARATION — ListField reads element/order/activeKey off it,
  // so there is no second table for the control to drift from.
  assert.equal(pointsRow.element, PROPS.points.element, "one declaration object, read by reference");
  assert.equal(pointsRow.order, "sequence");
  assert.equal(pointsRow.activeKey, "pointsActive");
  // `closed` DOES have one (a boolean), so the widget is not row-less.
  assert.equal(registered.inspector.find((r) => r.key === "closed").kind, "boolean");
  // The plugin reads the SAME declaration back rather than re-typing it.
  assert.equal(POINTS_LIST.key, "points");
  assert.equal(POINTS_LIST.activeKey, "pointsActive");
  assert.equal(POINTS_LIST.element, PROPS.points.element, "one declaration object, read by reference");
});

// ── PER-VERTEX VISIBILITY (hide) — the index-stable half of the pair ─────────

test("HIDE: the outline closes over a hidden vertex, and every OTHER surface agrees", () => {
  const all = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const visible = polyState({ points: all, pointsActive: [true, false, true, true], closed: true, w: 100, h: 100 });
  // The DRAWN chain is the square minus vertex 1 — a triangle.
  assert.deepEqual(visiblePoints(visible), [[0, 0], [1, 1], [0, 1]]);
  assert.deepEqual(localPoints(visible), [[0, 0], [100, 100], [0, 100]]);
  // …and it is EXACTLY the shape you would get by authoring three vertices: same
  // path, same fill decision, same hit test. That is the "acts like it's not
  // there" contract (core/lists.visibleElements), proved rather than asserted.
  const authored = polyState({ points: [[0, 0], [1, 1], [0, 1]], closed: true, w: 100, h: 100 });
  assert.equal(JSON.stringify(registered.emit(visible)), JSON.stringify(registered.emit(authored)));
  assert.equal(registered.hitTest(visible, 90, 95, 0), registered.hitTest(authored, 90, 95, 0));
  // A point inside the SQUARE but outside the triangle is now a miss, so the hide
  // really changed the painted region (the comparison above is not vacuous).
  assert.equal(registered.hitTest(polyState({ points: all, closed: true, w: 100, h: 100 }), 90, 10, 0), true);
  assert.equal(registered.hitTest(visible, 90, 10, 0), false);
  // ABSENT / SHORT / non-false companions all read as VISIBLE, which is what keeps
  // every document written before the companion existed byte-identical.
  assert.deepEqual(visiblePoints(polyState({ points: all })), all);
  assert.deepEqual(visiblePoints(polyState({ points: all, pointsActive: [true] })), all);
});

test("HIDE does NOT RENUMBER: the handle set, and every vertex ADDRESS, survives it", () => {
  const all = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const before = polyState({ points: all, closed: true, w: 100, h: 100 });
  const after = polyState({ points: all, pointsActive: [true, false, true, true], closed: true, w: 100, h: 100 });
  // A handle PER STORED VERTEX either way — a hidden vertex that lost its handle
  // could never be shown again.
  assert.deepEqual(registered.modifierPoints(before).map((m) => m.id), ["p0", "p1", "p2", "p3"]);
  assert.deepEqual(registered.modifierPoints(after).map((m) => m.id), ["p0", "p1", "p2", "p3"]);
  // Each handle still sits on ITS OWN stored vertex and names ITS OWN index — this
  // is the invariant equations depend on: `points.3.x` still means vertex 3.
  for (let i = 0; i < all.length; i++) {
    assert.equal(registered.modifierPoints(after)[i].element.list, POINTS_LIST, "the declaration is carried BY REFERENCE");
    assert.equal(registered.modifierPoints(after)[i].element.index, i);
    approx(registered.modifierPoints(after)[i].x, all[i][0] * 100);
    approx(registered.modifierPoints(after)[i].y, all[i][1] * 100);
  }
  assert.deepEqual(registered.modifierPoints(after).map((m) => m.active), [true, false, true, true]);
  // withElementActive writes ONLY the companion — the element list comes back BY
  // IDENTITY, so there is nothing that could have been renumbered.
  const hidden = withElementActive(POINTS_LIST, { list: all, active: undefined }, 1, false);
  assert.equal(hidden.list, all, "the element list is returned by identity");
  // Asserted through elementActive rather than against a literal array: how far the
  // companion is padded is core/lists.js's own representation choice, and only the
  // per-index ANSWER is the contract this widget depends on.
  assert.deepEqual(all.map((_, i) => elementActive(hidden.active, i)), [true, false, true, true]);
  // PURGE, by contrast, DOES renumber — the reason the two are separate buttons.
  const purged = withElementPurged(POINTS_LIST, { list: all, active: undefined }, 1);
  assert.deepEqual(purged.list, [[0, 0], [1, 1], [0, 1]]);
  assert.equal(indexAfterPurge(3, 1), 2, "what was vertex 3 is now vertex 2 — an equation bound to it moved");
});

test("HIDE is a plain boolean KEYFRAME on the companion path (no new machinery)", () => {
  let doc = repairedDocument(oneSlideDoc(polyState({ points: SQUARE, closed: true }), 1), registry).doc;
  doc = keyframed(doc, 1, ["items", "poly", "pointsActive"], [true, false, true, true]);
  const folded = foldState(doc, 1, 1).items.poly;
  assert.deepEqual(folded.pointsActive, [true, false, true, true]);
  assert.deepEqual(folded.points, SQUARE, "the vertex list itself is untouched");
  assert.deepEqual(visiblePoints(folded), [[0, 0], [1, 1], [0, 1]]);
  // Hiding EVERY vertex leaves a reachable GHOST rather than an invisible,
  // unclickable item (the degenerate-honesty rule, extended to visibility).
  const blind = polyState({ points: SQUARE, pointsActive: [false, false, false, false] });
  assert.equal(registered.isGhost(blind), true);
  assert.deepEqual(registered.emit(blind), []);
  assert.equal(registered.hitTest(blind, 5, 5, 0), true, "a ghost polygon stays selectable via its bbox");
});

// ── ADD VERTEX — on the chain, so the shape does not jump ────────────────────

test("closestChainProjection: reports the SEGMENT as well as the point, and closestPointOnChain reads it", () => {
  assert.deepEqual(closestChainProjection([[0, 0], [10, 0], [10, 10]], 11, 6, false), { segment: 1, x: 10, y: 6 });
  assert.deepEqual(closestChainProjection([[0, 0], [10, 0], [10, 10]], 5, -3, false), { segment: 0, x: 5, y: 0 });
  // The CLOSING leg is segment N-1 and only exists when closed.
  assert.equal(closestChainProjection([[0, 0], [10, 0], [10, 10]], -1, 6, true).segment, 2);
  assert.equal(closestChainProjection([[0, 0], [10, 0], [10, 10]], -1, 6, false).segment, 0);
  // No segment at all below two vertices — and the closest-point wrapper still
  // answers for those cases, so its own contract is unchanged.
  assert.equal(closestChainProjection([[3, 4]], 0, 0, true), null);
  assert.equal(closestChainProjection([], 0, 0, true), null);
  assert.deepEqual(closestPointOnChain([[3, 4]], 0, 0, false, { x: 9, y: 9 }), { x: 3, y: 4 });
  assert.deepEqual(closestPointOnChain([], 1, 2, false, { x: 9, y: 9 }), { x: 9, y: 9 });
});

test("ADD VERTEX: lands ON the chain — the INK RECT and the painted region are unchanged", () => {
  const state = polyState({ points: unitRegularPolygon(5), closed: true, w: 240, h: 240, strokeWidth: 2 });
  const before = polygonInkRect(state);
  // Click exactly on the midpoint of the first leg (in LOCAL units — what the
  // activation hands over).
  const lp = localPoints(state);
  const mid = { x: (lp[0][0] + lp[1][0]) / 2, y: (lp[0][1] + lp[1][1]) / 2 };
  const value = withVertexInsertedNear(state, mid.x, mid.y);
  const after = polyState({ points: value.list, pointsActive: value.active, closed: true, w: 240, h: 240, strokeWidth: 2 });
  assert.equal(value.list.length, state.points.length + 1, "one vertex was added");
  // THE SHAPE DID NOT JUMP: same ink rect to floating-point tolerance, and the
  // new vertex is exactly on the leg it was inserted into (collinear with its
  // neighbours, i.e. zero triangle area).
  for (const k of ["x", "y", "w", "h"]) approx(before[k], polygonInkRect(after)[k], 1e-9);
  assert.deepEqual(value.list[0], state.points[0]);
  assert.deepEqual(value.list[2], state.points[1], "the displaced vertex is INTACT, one index later");
  const [a, b, c] = [lp[0], localPoints(after)[1], lp[1]];
  approx((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]), 0, 1e-6);
  // Anywhere the old polygon was painted, the new one still is (a denser outline
  // of the same region) — checked on a grid rather than at one lucky point.
  for (let gx = 5; gx < 240; gx += 17)
    for (let gy = 5; gy < 240; gy += 17)
      assert.equal(registered.hitTest(after, gx, gy, 0), registered.hitTest(state, gx, gy, 0), `hit parity at ${gx},${gy}`);
});

test("ADD VERTEX: the CLOSING leg appends; a chain with no leg refuses; the plugin hook names the keys", () => {
  const tri = polyState({ points: [[0, 0], [1, 0], [1, 1]], closed: true, w: 100, h: 100 });
  // The closing leg runs from the LAST vertex back to the first, so its insertion
  // belongs at the END of the sequence (never after vertex 0).
  const closing = withVertexInsertedNear(tri, 20, 90);
  assert.equal(closing.list.length, 4);
  assert.deepEqual(closing.list.slice(0, 3), tri.points, "the existing vertices are untouched and unmoved");
  approx(closing.list[3][0], 0.55);
  approx(closing.list[3][1], 0.55);
  // Nothing to insert on below two vertices — reported as null, never a guess.
  assert.equal(withVertexInsertedNear(polyState({ points: [[0, 0]], w: 100, h: 100 }), 5, 5), null);
  assert.equal(registered.insertPointAt(polyState({ points: [], w: 100, h: 100 }), 5, 5), null);
  // The hook the "insert_point" activation calls declares WHICH state keys to
  // write, so the handler stays widget-agnostic.
  const hook = registered.insertPointAt(tri, 50, 4);
  assert.equal(hook.key, "points");
  assert.equal(hook.activeKey, "pointsActive");
  assert.equal(hook.value.list.length, 4);
  // An insert into a list WITH a companion carries the companion along, aligned,
  // with the new element visible.
  const withHidden = polyState({ points: [[0, 0], [1, 0], [1, 1]], pointsActive: [true, false, true], closed: false, w: 100, h: 100 });
  const kept = withVertexInsertedNear(withHidden, 100, 50);
  assert.equal(kept.list.length, 4);
  assert.equal(kept.active.length, 4);
  assert.equal(kept.active.filter((f) => f === false).length, 1, "the hidden vertex is STILL hidden");
});

test("ADD VERTEX is ONE keyframe pair, and the widget declares the activation that drives it", async () => {
  const { handlerFor, handlerIds, migrationPlan } = await import("../web/widget_handlers.js");
  assert.equal(registered.activate, "insert_point");
  assert.equal(handlerFor("activate", registered).id, "insert_point");
  assert.ok(handlerIds("activate").includes("insert_point"));
  // Every plugin that ships the CONTENT descriptor must also name the handler —
  // the same gate tests/activation_migration_test.js applies globally.
  assert.deepEqual(migrationPlan(roster), []);
  // The write itself is a plain list keyframe: one leaf, tweenable, undoable.
  const state = polyState({ points: [[0, 0], [1, 0], [1, 1]], closed: false, w: 100, h: 100 });
  const hook = registered.insertPointAt(state, 50, 4);
  let doc = repairedDocument(oneSlideDoc(state, 1), registry).doc;
  doc = keyframed(doc, 1, ["items", "poly", hook.key], hook.value.list);
  assert.deepEqual(foldState(doc, 1, 1).items.poly.points, hook.value.list);
  assert.equal(foldState(doc, 1, 1).items.poly.pointsActive, undefined, "no companion is minted when nothing was hidden");
});

console.log(`\n${passed} polygon tests passed`);
