/**
 * SIMULATED STATE — THE INTEGRATION (manifest R7-9, Wave 2). Plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/simulated_export_test.js
 *
 * tests/simulated_state_test.js pins the HISTORY MODULE. This file pins the four
 * seams that carry it out of the editor, because until they were wired a
 * double-pendulum animated in the editor's presenter and sat FROZEN in an export
 * — the wrong-video-with-a-green-exit failure, one layer up.
 *
 * WHAT IS PINNED HERE, and why each is a law rather than a behaviour:
 *   - AN EXPORT ADVANCES 1/fps PER OUTPUT FRAME AT EVERY SAMPLE COUNT. Motion blur
 *     renders `samples` sub-frames at `samples` distinct clock instants, so each
 *     one is its own simulation step; a dictated `1/fps` would run the simulation
 *     `samples`x too fast and no error would be raised anywhere. The divisor is
 *     `fps * samples`, and turning blur on must not change what the movie shows.
 *   - THE EXPORT'S TWO EVALUATIONS PER SUB-FRAME MUST AGREE, and their ORDER is
 *     load-bearing. web/transitionRender.createLetterboxFrameRenderer evaluates
 *     the state itself (for the camera rect) BEFORE asking gpuService for pixels,
 *     and gpuService's pass is FROZEN — so the letterbox pass is the export's one
 *     advancing consumer and the pixel pass re-reads the same step. Flip the order
 *     and the pixels are one step stale; that is measured here in both directions
 *     so the dependency cannot be refactored away silently.
 *   - dt = 0 IS BYTE-IDENTICAL: re-sampling one output frame takes no second step.
 *   - A FROZEN STILL CONSUMER CANNOT PERTURB THE TIMELINE, tested with a dt-FREE
 *     equation, which is the case where "dt is 0 so the write is harmless" is
 *     FALSE — that pass still computes f(prev) and would record it. The two slides
 *     must DISAGREE about the slot, or the test passes either way (see it).
 *   - A SIMULATED DOCUMENT REFUSES A PARALLEL SPLIT, loudly, before any browser.
 */

import assert from "node:assert/strict";
import { evaluateState } from "../core/expressions.js";
import {
  withSimulationFrozen, resetSimulation, setSimulationTimestepOverride,
  hasSimulationValue, simulationSnapshot,
} from "../core/simulation_history.js";
import { createRegistry } from "../core/registry.js";
import { newDocument, withNewItem, keyframed, stridedShardRefusal } from "../core/document.js";
import { rectPlugin } from "../plugins/rect.js";
import { cameraPlugin } from "../plugins/camera.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { parallelSplitRefusal, shardFrames } from "../cli/render_job.js";

// A canvas stand-in, installed BEFORE web/videoExport.js is imported only because
// createFrameSampler allocates its averaging scratch at construction when
// samples > 1. Nothing here inspects pixels: the quantity under test is the
// SIMULATION ADVANCE, which the injected renderFrame reports directly.
const CHANNELS = 4;
function fakeCanvas() {
  const ctx = {
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * CHANNELS) }),
    putImageData: () => {},
  };
  return { width: 0, height: 0, getContext: () => ctx };
}
globalThis.document = { createElement: () => fakeCanvas() };
globalThis.ImageData = class {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const { createFrameSampler, timelinePlan } = await import("../web/videoExport.js");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
/** THE MESSAGE COMES BEFORE THE TOLERANCE. tests/simulated_state_test.js's `approx`
 *  takes (a, b, eps), and passing a message into that third slot makes the
 *  comparison `Math.abs(a-b) < "some sentence"` — NaN, so the assertion fails on
 *  values that are equal to the last bit and blames the arithmetic. Cost an hour
 *  here; the tolerance is last precisely because it is the argument nobody passes. */
function approx(a, b, message = "", eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}${message ? ` — ${message}` : ""}`);
}

const registry = createRegistry();
registry.register(rectPlugin);
registry.register(cameraPlugin);

/** Pure function. A folded state holding ONE rect whose `rotation` is `src`, as a
 *  DISTINCT object each call — evaluateState memoizes on state identity, so a
 *  reused object would serve a cached answer instead of stepping.
 *  @example rotationState("= @@ + dt").items.a1.rotation // "= @@ + dt" */
function rotationState(src) {
  return { vars: {}, items: { a1: { ...rectPlugin.defaults, type: "rect", name: "Box", rotation: src } } };
}

/** The output frames every timing test walks — enough to see three intervals. */
const WALKED_FRAMES = 5;

/**
 * Command (drives the clock and the history through the REAL export seam). Runs
 * `frames` output frames of a `= @@ + dt` document through createFrameSampler at
 * `fps` with `samples` temporal subsamples, reproducing the export's own two
 * evaluations per sub-frame — the letterbox's UNFROZEN camera-rect pass, then
 * gpuService's FROZEN pixel pass — and returns the rotation at the end of each
 * output frame.
 *
 * Returns:
 *   Promise<number[]> length `frames`
 */
async function exportRotations({ fps, samples, frames = WALKED_FRAMES, source = "= @@ + dt", repeatFrame = null }) {
  const seen = [];
  const sampler = createFrameSampler({
    plan: timelinePlan({ slides: [{}] }, { holdSeconds: frames / fps + 1 }), // ⊇ every sub-time below
    renderFrame: () => {
      // web/transitionRender.js:260 — ONE unfrozen evaluation per sub-frame, for
      // the camera rect, BEFORE any pixels. This is the advancing consumer.
      const advanced = evaluateState(rotationState(source), registry).state.items.a1.rotation;
      // web/gpuService.renderCameraFrame — the pixel pass, read-only.
      const painted = withSimulationFrozen(() =>
        evaluateState(rotationState(source), registry).state.items.a1.rotation);
      assert.equal(painted, advanced, "the frozen pixel pass disagreed with the advancing pass");
      seen[seen.length - 1] = painted;
      return fakeCanvas();
    },
    width: 2, height: 2, fps, samples, setTime: setParticleTimeOverride,
  });
  try {
    for (let i = 0; i < frames; i++) {
      seen.push(null);
      await sampler.sample(i);
      if (repeatFrame === i) await sampler.sample(i); // the Δt = 0 probe
    }
  } finally {
    sampler.release();
  }
  return seen;
}

// ── The export seam: one output frame is 1/fps of simulation, always ──────────

await test("AN EXPORT ADVANCES 1/fps PER OUTPUT FRAME — at 1, 2 and 4 temporal subsamples", async () => {
  const fps = 30;
  for (const samples of [1, 2, 4]) {
    const seen = await exportRotations({ fps, samples });
    for (let i = 1; i < seen.length; i++)
      approx(seen[i] - seen[i - 1], 1 / fps,
        `samples=${samples}: output frame ${i} advanced ${seen[i] - seen[i - 1]}s of simulation, not ${1 / fps}s`);
  }
});

await test("MOTION BLUR DOES NOT RUN THE SIMULATION FAST — 4 subsamples is not 4x", async () => {
  // THE TRAP, stated as its own failure: dictating 1/fps instead of 1/(fps*samples)
  // makes every sub-frame a full frame of simulation, so a 4-sample export would
  // advance 4/fps per output frame and the movie would be silently time-warped.
  const fps = 30;
  const plain = await exportRotations({ fps, samples: 1 });
  const blurred = await exportRotations({ fps, samples: 4 });
  const plainStep = plain[plain.length - 1] - plain[0];
  const blurredStep = blurred[blurred.length - 1] - blurred[0];
  approx(blurredStep, plainStep);
  approx(blurredStep, (WALKED_FRAMES - 1) / fps);
});

await test("TWO FRAME RATES, ONE TRAJECTORY: 24 fps and 60 fps each advance their own 1/fps", async () => {
  for (const fps of [24, 60]) {
    const seen = await exportRotations({ fps, samples: 1 });
    approx(seen[seen.length - 1] - seen[0], (WALKED_FRAMES - 1) / fps);
  }
  // …and the SAME wall-second is the same trajectory point: 4 frames at 24 fps and
  // 10 at 60 fps both cover 1/6 s of simulation.
  const at24 = await exportRotations({ fps: 24, samples: 1, frames: 5 });
  const at60 = await exportRotations({ fps: 60, samples: 1, frames: 11 });
  approx(at24[4] - at24[0], at60[10] - at60[0]);
});

await test("Δt = 0: re-sampling ONE output frame takes no second step", async () => {
  const fps = 30;
  const repeated = await exportRotations({ fps, samples: 1, repeatFrame: 2 });
  const plain = await exportRotations({ fps, samples: 1 });
  assert.deepEqual(repeated, plain, "sampling a frame twice changed the trajectory");
});

// ── The ORDER of the export's two passes is load-bearing ─────────────────────

await test("IF THE FROZEN PASS RAN FIRST THE PIXELS WOULD BE ONE STEP STALE (measured both ways)", async () => {
  const source = "= @@ + dt";
  const step = 1 / 30;
  const run = (frozenFirst) => {
    resetSimulation();
    setSimulationTimestepOverride(step);
    const out = [];
    for (let i = 0; i < 3; i++) {
      setParticleTimeOverride(i * step);
      if (frozenFirst) {
        const painted = withSimulationFrozen(() => evaluateState(rotationState(source), registry).state.items.a1.rotation);
        const advanced = evaluateState(rotationState(source), registry).state.items.a1.rotation;
        out.push([painted, advanced]);
      } else {
        const advanced = evaluateState(rotationState(source), registry).state.items.a1.rotation;
        const painted = withSimulationFrozen(() => evaluateState(rotationState(source), registry).state.items.a1.rotation);
        out.push([painted, advanced]);
      }
    }
    setSimulationTimestepOverride(null);
    setParticleTimeOverride(null);
    return out;
  };
  // THE SHIPPED ORDER (letterbox evaluates, then gpuService paints): they agree.
  for (const [painted, advanced] of run(false)) assert.equal(painted, advanced);
  // THE FLIPPED ORDER: the frozen pass reads the PREVIOUS step's history and its
  // dt is the previous step's dt, so from the second frame on it paints a stale
  // value. This is why the order is documented at both ends.
  const flipped = run(true);
  assert.notDeepEqual(flipped[2][0], flipped[2][1],
    "flipping the order produced identical values — the ordering contract has stopped being load-bearing, so the docs at gpuService.js and transitionRender.js are now wrong");
});

// ── A frozen still consumer cannot perturb the timeline ──────────────────────

await test("A THUMBNAIL OF ANOTHER SLIDE LEAVES THE EDITOR'S SIMULATION EXACTLY AS IT FOUND IT", async () => {
  // BOTH EQUATIONS ARE dt-FREE, which is the whole point: they compute a NEW value
  // even at dt = 0, so "the write is harmless because the timestep is zero" is
  // false and freezing must mean NO WRITE. They differ in their constant so the
  // two slides genuinely disagree about the slot — an equal pair would make this
  // test pass whether or not the freeze works. (The decay `= @@ * 0.9` alone was
  // that vacuous test: rect's default rotation is 0 and 0*0.9 is 0 forever.)
  const live = "= @@ * 0.9 + 1";
  const other = "= @@ * 0.9 + 100";
  const slide = (src) => ({ vars: {}, items: { a1: { ...rectPlugin.defaults, type: "rect", name: "Box", rotation: src } } });
  resetSimulation();
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(0);
  const first = evaluateState(slide(live), registry).state.items.a1.rotation; // seeds history
  setParticleTimeOverride(1);
  const second = evaluateState(slide(live), registry).state.items.a1.rotation;
  approx(second, first * 0.9 + 1);

  // A slide thumbnail of a DIFFERENT slide, at the same instant, frozen. It reads
  // the current step (so its picture is right) and records nothing.
  const before = simulationSnapshot();
  const thumb = withSimulationFrozen(() => evaluateState(slide(other), registry).state.items.a1.rotation);
  approx(thumb, first * 0.9 + 100);
  assert.deepEqual(simulationSnapshot().cur, before.cur, "the frozen pass WROTE the current-step table");

  // The next real step continues the LIVE trajectory, not the thumbnail's — which
  // is the corruption the freeze exists to prevent (unfrozen, the next value is
  // computed from 90.9 instead of 1.9).
  setParticleTimeOverride(2);
  approx(evaluateState(slide(live), registry).state.items.a1.rotation, second * 0.9 + 1);
  setParticleTimeOverride(null);
});

// ── The render job refuses a parallel split, before it boots anything ────────

await test("A SIMULATED DOCUMENT REFUSES A PARALLEL SPLIT, and renders as ONE CONTIGUOUS WALK", async () => {
  const [withBox, id] = withNewItem(newDocument(), 0, { ...rectPlugin.defaults, type: "rect", name: "Box" });
  const simulated = keyframed(withBox, 0, ["items", id, "rotation"], "= @@ + dt");
  const refusal = stridedShardRefusal(simulated, registry);
  assert.ok(refusal, "a `= @@ + dt` deck was not detected as simulated");

  // Parallelism is refused, and the sentence names both the ask and the remedy.
  const said = parallelSplitRefusal(refusal, 1, 8);
  assert.match(said ?? "", /8 browser\(s\)/);
  assert.match(said ?? "", /--shards 1 --workers 1/);
  assert.match(said ?? "", /CONTIGUOUS/);
  assert.match(parallelSplitRefusal(refusal, 4, 1) ?? "", /4 shard\(s\)/);

  // One shard, one browser is always allowed — and that split IS contiguous and
  // ascending, which is what lets the single worker integrate its own prefix.
  assert.equal(parallelSplitRefusal(refusal, 1, 1), null);
  assert.deepEqual(shardFrames(6, 0, 1), [0, 1, 2, 3, 4, 5]);

  // An ordinary deck is untouched by any of this.
  assert.equal(stridedShardRefusal(newDocument(), registry), null);
  assert.equal(parallelSplitRefusal(null, 4, 8), null);
});

// ── release() hands `dt` back to measured time ───────────────────────────────

await test("release() returns the simulation to MEASURED time (a second export cannot inherit a dictated step)", async () => {
  await exportRotations({ fps: 30, samples: 1, frames: 2 });
  // Measured again: two clock instants 0.5 s apart, against the 0.1 s default clamp.
  resetSimulation();
  setParticleTimeOverride(0);
  evaluateState(rotationState("= @@ + dt"), registry);
  setParticleTimeOverride(0.5);
  const state = { vars: {}, items: {
    c1: { type: "camera", maxTimestep: 0.1 },
    a1: { ...rectPlugin.defaults, type: "rect", name: "Box", rotation: "= @@ + dt" },
  } };
  approx(evaluateState(state, registry).state.items.a1.rotation, 0.1); // clamped ⇒ measured, not dictated
  setParticleTimeOverride(null);
});

setParticleTimeOverride(null);
setSimulationTimestepOverride(null);
resetSimulation();
assert.equal(hasSimulationValue("items.a1.rotation"), false);
console.log(`\n${passed} simulated-export tests passed`);
