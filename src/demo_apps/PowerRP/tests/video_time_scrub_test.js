/**
 * Video TIME SCRUBBER (plugins/demo/video_time_scrub.js) — bare-node suite for
 * the demo widget of manifest item 72: a video scrubber whose `scrubTime` is
 * driven by the presentation clock through equation presets (the dream being
 * Loop = `time % self.length`).
 *
 * Proves, with NO browser (the evaluation + emit are pure/deterministic):
 *   1. every preset EVALUATES to its intended function of (time, self.length),
 *      against the pinned particle clock — the "each preset must evaluate
 *      correctly" requirement;
 *   2. the Loop headline is exactly `currentTime = time % self.length`;
 *   3. Δt = 0 ⟹ scrubTime is UNCHANGED (the recordable-state law) and a Δt ≠ 0
 *      moves it (the whole point of clock-driven scrubbing);
 *   4. a fresh widget is STATIC (scrubTime default 0, not a preset) so it never
 *      evaluates `time % 0 = NaN` before a length is known;
 *   5. emit() returns the core scrubber's `videoFrame` op carrying the evaluated
 *      scrubTime (so it decodes through the deterministic scrub pipeline).
 *
 * Run: node src/demo_apps/PowerRP/tests/video_time_scrub_test.js
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { evaluateState } from "../core/expressions.js";
import * as T from "../core/transform.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { videoTimeScrubPlugin, TIME_SCRUB_PRESETS, PROGRESS_EXPORT_EQ } from "../plugins/demo/video_time_scrub.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

const registry = createRegistry();
registry.register(videoTimeScrubPlugin);
const L = 3; // a 3-second clip (the committed scrub_video.mp4 fixture's length)

/** Query. The evaluated scrubTime of a widget bound to `eq` with length L, clock t. */
function scrubAt(eq, t, length = L) {
  setParticleTimeOverride(t);
  const state = { vars: {}, items: { w: { ...videoTimeScrubPlugin.defaults, length, scrubTime: eq } } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, `errors for "${eq}" @${t}: ${[...errors.values()].join("; ")}`);
  return s.items.w.scrubTime;
}

// The reference implementation of each preset's intent (mirrors the equation math).
const EXPECTED = {
  "Loop": (t) => t % L,
  "Reverse": (t) => L - (t % L),
  "Half Speed": (t) => (t / 2) % L,
  "Double Speed": (t) => (t * 2) % L,
  "Reverse Half Speed": (t) => L - ((t / 2) % L),
  "Ping-Pong": (t) => L - Math.abs((t % (2 * L)) - L),
  "Boomerang Burst": (t) => L - Math.abs(((t * 2) % (2 * L)) - L),
  "Slow-Mo Ramp": (t) => ((t % L) * (t % L)) / L,
  "Stutter": (t) => (Math.floor(t * 4) / 4) % L,
  "Strobe Skip": (t) => (Math.floor(t * 2) * (L / 3)) % L,
  "Freeze Frame": () => L / 2,
};
const CLOCKS = [0, 0.7, 1.5, 2.9, 4.2, 7.0, 13.5]; // spanning within-clip and several loops

try {
  test("there are at least 10 presets and each has an expectation (the ≥10 mantra)", () => {
    assert.ok(TIME_SCRUB_PRESETS.length >= 10, `only ${TIME_SCRUB_PRESETS.length} presets`);
    for (const p of TIME_SCRUB_PRESETS) assert.ok(EXPECTED[p.name], `no expectation pinned for preset "${p.name}"`);
  });

  test("every preset evaluates to its intended function of (time, self.length)", () => {
    for (const p of TIME_SCRUB_PRESETS) {
      const exp = EXPECTED[p.name];
      for (const t of CLOCKS) {
        const got = scrubAt(p.props.scrubTime, t);
        assert.ok(Math.abs(got - exp(t)) < 1e-9, `${p.name} @${t}: got ${got}, want ${exp(t)} (eq: ${p.props.scrubTime})`);
      }
    }
  });

  test("Loop is EXACTLY currentTime = time % self.length (the dream equation)", () => {
    const loop = TIME_SCRUB_PRESETS.find((p) => p.name === "Loop");
    assert.equal(loop.props.scrubTime, "time % self.length");
    assert.equal(scrubAt("time % self.length", 13.5), 1.5); // 13.5 % 3
    assert.equal(scrubAt("time % self.length", 2.4), 2.4);   // within the first pass, unchanged
    assert.equal(scrubAt("time % self.length", 3.0), 0);     // exactly one clip → back to frame 0
  });

  test("recordable-state law: Δt = 0 ⟹ scrubTime unchanged; Δt ≠ 0 moves it", () => {
    const a = scrubAt("time % self.length", 4.2);
    const b = scrubAt("time % self.length", 4.2); // same clock, re-evaluated
    assert.equal(a, b, "same clock must give the same scrubTime (byte-identical)");
    assert.notEqual(scrubAt("time % self.length", 5.2), a, "a different clock must move it");
  });

  test("a fresh widget is STATIC (scrubTime default 0), never time % 0 = NaN", () => {
    assert.equal(videoTimeScrubPlugin.defaults.scrubTime, 0, "default must be a plain 0, not a preset");
    assert.equal(videoTimeScrubPlugin.defaults.length, 0, "length unknown until probed/typed");
    // With the default (0) and unknown length, a fresh widget evaluates to 0 with no error.
    const state = { items: { w: { ...videoTimeScrubPlugin.defaults } } };
    const { state: s, errors } = evaluateState(state, registry);
    assert.equal(errors.size, 0);
    assert.equal(s.items.w.scrubTime, 0);
    // progress is an honest 0 when length is unknown (no fabricated fraction).
    assert.equal(s.items.w.progress, 0);
    assert.equal(PROGRESS_EXPORT_EQ.includes("self.length"), true, "progress divides by length, not a separate duration knob");
  });

  test("emit() returns the core scrubber's videoFrame op with the evaluated scrubTime", () => {
    const cmds = videoTimeScrubPlugin.emit({ src: "clip.mp4", w: 320, h: 180, scrubTime: 1.5, scrubWrap: "loop" }, null, T.identity());
    const frame = cmds.find((c) => c.op === "videoFrame");
    assert.ok(frame, "expected a videoFrame op");
    assert.equal(frame.seekTime, 1.5, "the evaluated scrubTime rides as seekTime");
    assert.equal(frame.wrap, "loop");
    assert.deepEqual(videoTimeScrubPlugin.emit({ src: "", w: 320, h: 180 }, null, T.identity()), [], "no src → nothing to draw");
  });

  console.log(`\n${passed} video_time_scrub tests passed`);
} finally {
  setParticleTimeOverride(null); // never leak the override
}
