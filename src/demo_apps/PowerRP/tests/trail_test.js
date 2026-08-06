/**
 * THE TRAIL WIDGET (manifest R7-15) — the laws plugins/trail.js and
 * core/trail_history.js are built to keep. Plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/trail_test.js
 *
 * WHAT IS PINNED HERE, and why each one is a LAW rather than a behaviour:
 *   - a trail is SIMULATED state, so a deck containing one REFUSES strided sharding
 *     — the wrong-video-with-a-green-exit failure this project forbids;
 *   - Δt = 0 ⟹ the samples are BYTE-IDENTICAL however many times one instant is
 *     evaluated (web/CanvasView.svelte evaluates ~28 times per frame), which is what
 *     keeps the orthogonality law alive for the fourth kind of state;
 *   - resetSimulation() CLEARS a trail (an ill-defined reset diverges silently);
 *   - a FROZEN consumer cannot extend a trail (a thumbnail of another slide must not
 *     land in the presenter's timeline);
 *   - the sample count follows the AUTHORED WINDOW, never the frame rate — the same
 *     framerate independence `dt` buys the integrators;
 *   - memory is bounded by TRAIL_SAMPLE_CAPACITY however long the trail runs;
 *   - the ribbon geometry: butted convex quads, taper and fade by AGE.
 */

import assert from "node:assert/strict";
import { evaluateState } from "../core/expressions.js";
import { resetSimulation, setSimulationTimestepOverride, withSimulationFrozen } from "../core/simulation_history.js";
import {
  TRAIL_CLOCK_KEY, TRAIL_POINTS_KEY, TRAIL_SAMPLE_CAPACITY, advanceTrailHistory,
  trailHistoryPoints, trailSpacingSeconds, samePointList,
} from "../core/trail_history.js";
import { createRegistry } from "../core/registry.js";
import { newDocument, withNewItem, stridedShardRefusal, repairedDocument } from "../core/document.js";
import { trailPlugin, trailInsertState, trailLocalPath, trailRibbonQuads, trailColorAt, doubleCoverageAlpha, trailInkRect, polylineNormals, trailWidthFromDrag, trailWidthHandleFrame } from "../plugins/trail.js";
import { rectPlugin } from "../plugins/rect.js";
import { cameraPlugin } from "../plugins/camera.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registry.register(trailPlugin);
registry.register(rectPlugin);
registry.register(cameraPlugin);

/** Pure function. A folded state with ONE trail at (x, y), a DISTINCT object each
 *  call — evaluateState memoizes on state identity, so a reused object would serve a
 *  cached answer instead of stepping. */
function trailState(x, y, extra = {}) {
  return { vars: {}, items: { t1: { ...trailInsertState(), name: "Trail", x, y, ...extra } } };
}

/** Command (drives the ambient clock, the equation pass and the trail driver — the
 *  presenter's own sequence). Evaluates a trail at (x, y) at presentation time `t`
 *  and returns the evaluated trail item. */
function stepTrail(t, x, y, extra = {}) {
  setParticleTimeOverride(t);
  const pass = evaluateState(trailState(x, y, extra), registry);
  advanceTrailHistory(pass.state, registry);
  return pass.state.items.t1;
}

/** Command. A fresh simulation and a fresh clock, so no test inherits another's
 *  trajectory. */
function freshRun() {
  setSimulationTimestepOverride(null);
  resetSimulation();
  setParticleTimeOverride(0);
}

// ── The state kind: simulated, therefore not seekable ────────────────────────

test("a deck containing a trail REFUSES strided sharding, with no new detection to teach", () => {
  const doc = repairedDocument(withNewItem(newDocument(), 0, trailInsertState())[0], registry).doc;
  const refusal = stridedShardRefusal(doc, registry);
  assert.ok(refusal, "a trail-bearing document must not be strided-sharded silently");
  assert.match(refusal, /SIMULATED STATE/);
  // …and it is the trail's own clock equation that says so, not a special case:
  assert.equal(stridedShardRefusal(repairedDocument(newDocument(), registry).doc, registry), null);
});

test("the trail's clock is a REAL stored equation, so its authored value is the initial condition", () => {
  assert.equal(trailInsertState()[TRAIL_CLOCK_KEY], "= @@ + dt");
  assert.equal(trailPlugin.defaults[TRAIL_CLOCK_KEY], 0, "the DEFAULT is the initial condition, never the equation");
  freshRun();
  // Three steps of half a second each: the clock reads elapsed seconds, from 0.
  assert.equal(stepTrail(0, 0, 0)[TRAIL_CLOCK_KEY], 0);
  assert.equal(stepTrail(0.5, 0, 0)[TRAIL_CLOCK_KEY], 0.5);
  assert.equal(stepTrail(1, 0, 0)[TRAIL_CLOCK_KEY], 1);
});

// ── The laws of the fourth kind of state ─────────────────────────────────────

test("Δt = 0 ⟹ BYTE-IDENTICAL samples, however many times one instant is evaluated", () => {
  freshRun();
  stepTrail(0, 0, 0);
  stepTrail(0.1, 10, 0);
  const first = stepTrail(0.2, 20, 0)[TRAIL_POINTS_KEY];
  // 27 more evaluations at the SAME instant, as a frame's several consumers do.
  for (let i = 0; i < 27; i++) {
    const again = stepTrail(0.2, 20, 0)[TRAIL_POINTS_KEY];
    assert.ok(samePointList(first, again), `evaluation ${i + 2} at one instant produced different samples`);
  }
});

test("a still regime takes NO sample at all — the paused clock never rolls", () => {
  freshRun();
  // The particle clock's PAUSED regime is what every still consumer runs in; here the
  // test override holds one instant, which is the same thing for the history.
  for (let i = 0; i < 5; i++) stepTrail(0, 300, 300);
  const points = stepTrail(0, 300, 300)[TRAIL_POINTS_KEY];
  assert.equal(points.length, 1, "a frozen clock must leave the trail as its live tip alone");
  assert.deepEqual(points[0], { x: 300, y: 300, age: 0 });
});

test("resetSimulation() CLEARS a trail", () => {
  freshRun();
  for (let i = 0; i <= 10; i++) stepTrail(i * 0.1, i * 10, 0);
  assert.ok(stepTrail(1.1, 110, 0)[TRAIL_POINTS_KEY].length > 3, "the trail should have accumulated");
  resetSimulation();
  assert.equal(stepTrail(1.2, 120, 0)[TRAIL_POINTS_KEY].length, 1, "a reset trail is its live tip alone");
});

test("a FROZEN consumer renders the trail and extends nothing", () => {
  freshRun();
  for (let i = 0; i <= 10; i++) stepTrail(i * 0.1, i * 10, 0);
  const before = stepTrail(1.0, 100, 0)[TRAIL_POINTS_KEY].length;
  // A thumbnail of another slide, rendered while the presenter's clock is live.
  withSimulationFrozen(() => {
    for (let i = 0; i < 5; i++) stepTrail(1.1 + i * 0.1, -999, -999);
  });
  const after = stepTrail(1.0, 100, 0)[TRAIL_POINTS_KEY].length;
  assert.equal(after, before, "a frozen pass must not extend the timeline's trail");
});

// ── Decimation, eviction and the memory bound ────────────────────────────────

test("the sample count follows the AUTHORED WINDOW, not the frame rate", () => {
  // A 4 s window wants TRAIL_SAMPLE_CAPACITY/4 = 48 samples a second. Both displays
  // beat that, so the decimation — not the display — decides the picture.
  const counts = [100, 400].map((fps) => {
    freshRun();
    let item = null;
    for (let frame = 0; frame <= 4 * fps; frame++) item = stepTrail(frame / fps, frame, 0, { seconds: 4 });
    return item[TRAIL_POINTS_KEY].length;
  });
  assert.equal(counts[0], counts[1], `100 fps and 400 fps must draw the same streamer (${counts[0]} vs ${counts[1]})`);
  assert.equal(counts[0], TRAIL_SAMPLE_CAPACITY + 1, "a filled window is the whole ring plus the live tip");
});

test("BELOW the decimation rate the display sets the count, and it can only be FEWER", () => {
  // The stated bound: one sample per FRAME is the ceiling, so a window asking for
  // more samples a second than the display renders gets the display's rate. 30 fps
  // across a 1 s window wants 192 samples a second and can supply 30.
  freshRun();
  let item = null;
  for (let frame = 0; frame <= 30; frame++) item = stepTrail(frame / 30, frame, 0, { seconds: 1 });
  // 31 evaluations = 30 steps; the first takes no sample (nothing has rolled yet) and
  // the newest is still in `cur`, unreadable until the next roll — the live tip IS
  // that step, so the drawn count is 29 stored + 1 live.
  assert.equal(item[TRAIL_POINTS_KEY].length, 30, "a trail cannot hold points its display never rendered");
});

test("memory is bounded: a long run never exceeds the ring", () => {
  freshRun();
  let item = null;
  // 20 s of a 1 s window at 100 fps = 2000 frames, ~13x the ring's capacity.
  for (let frame = 0; frame <= 2000; frame++) item = stepTrail(frame / 100, frame, 0, { seconds: 1 });
  assert.ok(item[TRAIL_POINTS_KEY].length <= TRAIL_SAMPLE_CAPACITY + 1, `unbounded trail: ${item[TRAIL_POINTS_KEY].length} points`);
});

test("shortening the window drops old points on the NEXT frame, not after a full lap", () => {
  freshRun();
  for (let frame = 0; frame <= 400; frame++) stepTrail(frame / 100, frame, 0, { seconds: 4 });
  const wide = stepTrail(4.01, 401, 0, { seconds: 4 })[TRAIL_POINTS_KEY].length;
  const narrow = stepTrail(4.02, 402, 0, { seconds: 0.5 })[TRAIL_POINTS_KEY].length;
  assert.ok(narrow < wide / 4, `a 0.5 s window should hold far fewer than a 4 s one (${narrow} vs ${wide})`);
});

test("trailSpacingSeconds refuses a window it cannot divide", () => {
  assert.equal(trailSpacingSeconds(3), 3 / TRAIL_SAMPLE_CAPACITY);
  assert.throws(() => trailSpacingSeconds(0), /positive number of seconds/);
  assert.throws(() => trailSpacingSeconds(Infinity), /positive number of seconds/);
});

// ── The picture ──────────────────────────────────────────────────────────────

test("trailLocalPath: world history → local points, taper parameter by AGE", () => {
  const state = { x: 10, y: 10, [TRAIL_CLOCK_KEY]: 4, seconds: 2 };
  const path = trailLocalPath([{ x: 4, y: 10, age: 3 }, { x: 10, y: 10, age: 4 }], state);
  assert.deepEqual(path, [{ p: [-6, 0], t: 0.5 }, { p: [0, 0], t: 1 }]);
});

test("trailRibbonQuads: the interior is covered EXACTLY TWICE, which is what kills the AA hairline", () => {
  // A straight 6-point run, so every interior segment has both neighbours to reach
  // into. Coverage is counted by along-path span, which on a straight run is exact.
  const path = [0, 1, 2, 3, 4, 5].map((i) => ({ p: [i * 10, 0], t: i / 5 }));
  const quads = trailRibbonQuads(path, 0, 4);
  assert.equal(quads.length, 5);
  const spans = quads.map((q) => [Math.min(...q.quad.map((v) => v[0])), Math.max(...q.quad.map((v) => v[0]))]);
  for (let x = 6; x <= 44; x += 2) {
    const covering = spans.filter(([lo, hi]) => x > lo && x < hi).length;
    assert.equal(covering, 2, `x=${x} is covered ${covering} time(s), not twice`);
  }
  // …and the taper still follows t: half-width at t = 0.2 of a 0 → 4 ramp is 0.4.
  assert.deepEqual(quads[1].quad[0], [5, -0.4]);
});

test("doubleCoverageAlpha: two layers of it composite back to the authored opacity", () => {
  for (const a of [0, 0.1, 0.5, 0.75, 1]) {
    const layer = doubleCoverageAlpha(a);
    assert.ok(Math.abs(1 - (1 - layer) ** 2 - a) < 1e-12, `${a} does not round-trip through ${layer}`);
  }
});

test("trailRibbonQuads: a repeated point is dropped, a single point is no ribbon", () => {
  assert.deepEqual(trailRibbonQuads([{ p: [0, 0], t: 1 }], 0, 4), []);
  assert.deepEqual(trailRibbonQuads([{ p: [0, 0], t: 0 }, { p: [0, 0], t: 1 }], 0, 4), []);
  assert.equal(trailRibbonQuads([{ p: [0, 0], t: 0 }, { p: [0, 0], t: 0.5 }, { p: [10, 0], t: 1 }], 0, 4).length, 1);
});

test("polylineNormals: a doubling-back path keeps the incoming edge rather than dividing by zero", () => {
  assert.deepEqual(polylineNormals([[0, 0], [10, 0], [0, 0]])[1], [0, -1]);
  assert.throws(() => polylineNormals([[0, 0], [0, 0]]), /zero length/);
});

test("trailColorAt: the ramp reaches both authored ends exactly", () => {
  const s = { color: "#ffffff", tailColor: "#000000", tailOpacity: 0, opacity: 1 };
  assert.equal(trailColorAt(s, 1), "rgba(255,255,255,1)");
  assert.equal(trailColorAt(s, 0), "rgba(0,0,0,0)");
});

test("emit: a trail with history draws one polygon per segment; one with none draws its tip", () => {
  freshRun();
  for (let frame = 0; frame <= 20; frame++) stepTrail(frame / 20, frame * 5, 0);
  const item = stepTrail(1.05, 105, 0);
  const ops = trailPlugin.emit(item, null, { x: item.x, y: item.y, rotation: 0, scale: 1 });
  assert.ok(ops.length > 3, `expected a multi-segment ribbon, got ${ops.length} ops`);
  assert.ok(ops.every((op) => op.op === "polygon"), "a ribbon is polygons");
  freshRun();
  const bare = trailPlugin.emit(stepTrail(0, 0, 0), null, { x: 0, y: 0, rotation: 0, scale: 1 });
  assert.deepEqual(bare.map((op) => op.op), ["ellipse"], "no history ⇒ the tip alone");
});

test("localBounds covers the whole streamer, not just the tip", () => {
  freshRun();
  for (let frame = 0; frame <= 20; frame++) stepTrail(frame / 20, frame * 5, 0);
  const item = stepTrail(1.05, 105, 0);
  const rect = trailInkRect(item);
  assert.ok(rect.w > 50, `the ink rect must span the history, got w=${rect.w}`);
  assert.ok(rect.x < -50, `…and reach BEHIND the tip (local origin), got x=${rect.x}`);
});

test("the width handles slide along the ribbon's normal and read the width off it", () => {
  const s = { ...trailPlugin.defaults, x: 0, y: 0, [TRAIL_CLOCK_KEY]: 0, width: 8, tailWidth: 6 };
  const handles = trailPlugin.modifierPoints(s);
  assert.deepEqual(handles.map((h) => h.id), ["width", "tailWidth"]);
  assert.deepEqual([handles[0].x, handles[0].y], [0, -4]);
  assert.deepEqual([handles[1].x, handles[1].y], [0, 3]);
  // A drag off the axis is PROJECTED onto it, and the width is twice the distance.
  const allowed = handles[0].constrain(s, { x: 30, y: -10 });
  assert.deepEqual([allowed.x, allowed.y], [0, -10]);
  assert.deepEqual(handles[0].apply(s, allowed), { width: 20 });
  // The far side of the origin is NOT allowed — a width cannot be negative.\n  assert.equal(trailWidthFromDrag(trailWidthHandleFrame(s, false), { x: 0, y: 4 }).width, 0);
});

test("an item with no ring at all is its live point, not an error", () => {
  freshRun();
  assert.deepEqual(trailHistoryPoints("never-sampled", { x: 1, y: 2, seconds: 3 }, 0), [{ x: 1, y: 2, age: 0 }]);
});

setParticleTimeOverride(null);
setSimulationTimestepOverride(null);
resetSimulation();
console.log(`\n${passed} trail tests passed`);
