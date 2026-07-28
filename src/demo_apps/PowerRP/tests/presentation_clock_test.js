/**
 * THE PRESENTATION CLOCK suite (`= time`) — bare node, no framework.
 *
 * THE BUG THIS PINS SHUT. `core/expressions.js` read the clock off the FOLDED STATE
 * (`state.time` / `state.frame`) and nothing anywhere wrote either key, so `= time`
 * and `= frame` were frozen constants of 0. That made two SHIPPED palette commands
 * lie: `demo-insert-clock-digital` ("Digital Clock (seven-segment, live = time)")
 * and `demo-insert-clock-live` ("Analog Clock (live — time = presentation clock)")
 * both ship `time: "= time"` in their own defaults and both rendered a permanently
 * frozen 00:00. Silently wrong output, which the house rules forbid.
 *
 * THE FIX, and therefore what this suite asserts:
 *   1. `= time` reads THE app-wide presentation clock — render_gpu/particle_clock's
 *      particleTime(), the ONE answer to "what animation time is it right now?",
 *      already shared by the particle emitters, the sky and the cursor. Not a second
 *      time source, so the two can never disagree.
 *   2. Its TWO REGIMES carry straight through: PAUSED (a fixed freeze) for the
 *      editor, CLI and thumbnails, so a still is byte-reproducible; LIVE for the
 *      presenter; and the per-frame override the MP4 exporters already drive.
 *   3. evaluateState's memo — keyed on state OBJECT IDENTITY, and `slideState`
 *      hands back the SAME object for a resting slide — must not serve a stale
 *      clock. This is the trap a naive fix falls into: the clock advances, the
 *      state object does not, and the readout freezes anyway.
 *   4. A document that never writes `= time` still gets the old unconditional
 *      cache hit (the memo drag latency depends on).
 *   5. There is NO `frame`. It cannot be given an honest meaning without a frame
 *      rate; `meta.fps` is dead and the presenter runs one frame per rAF tick. `=
 *      frame` is now a LOUD unknown reference instead of a second frozen constant.
 *   6. THE PIXEL PROOF: both shipped presets, rendered through the CLI's real
 *      pipeline (repairedDocument → evaluate → camera frame → Skia), differ between
 *      two times and are byte-identical at the same time.
 *
 * Run: node tests/presentation_clock_test.js
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { newDocument, withNewItem, keyframed, foldState, serialize } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { evaluationAt } from "../web/cameraFrame.js";
import { suggestEquation } from "../core/equationSuggest.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { EDITOR_FREEZE_TIME } from "../core/particles.js";
import {
  particleTime, startParticleClock, stopParticleClock, setParticleTimeOverride,
} from "../render_gpu/particle_clock.js";
import { renderDocToPng } from "../cli/render.js";
import { createFrameSampler, subFrameTimes, timelinePlan } from "../web/videoExport.js";

const registry = createRegistry();
registerAll(registry, createCommands());

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

/**
 * Query (reads the plugin registry). A one-item document holding EXACTLY what the
 * shipped palette command inserts: the plugin's own defaults with `time` bound to
 * the presentation clock. `type` is the widget type; `overrides` places/sizes it.
 *
 * @example // clockDoc("clock_analog")[0].slides.length // 1
 * @example // clockDoc("clock_digital")[0] — a doc whose one clock has time: "= time"
 */
function clockDoc(type, overrides = {}) {
  const defaults = registry.get(type).defaults;
  return withNewItem(newDocument(), 0, {
    ...defaults, active: true, time: "= time", ...overrides,
  });
}

/** Pure function. sha256 of bytes, hex — the byte-identity comparator.
 * @example // sha256(new Uint8Array([1])) // "4bf5122f…" (64 hex chars) */
function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// ── (1) `= time` IS the presentation clock, in both regimes ──────────────────

test("`= time` resolves to the OVERRIDE clock, and tracks it across values", () => {
  const [doc, id] = clockDoc("clock_digital", { x: 0, y: 0 });
  const seen = [];
  for (const t of [0, 5, 3600, 86399.5]) {
    setParticleTimeOverride(t);
    seen.push(evaluateState(foldState(doc, 0, 1), registry).state.items[id].time);
  }
  setParticleTimeOverride(null);
  assert.deepEqual(seen, [0, 5, 3600, 86399.5]);
});

test("`= time` in the PAUSED regime is the editor FREEZE constant (a still is reproducible)", () => {
  const [doc, id] = clockDoc("clock_analog", { x: 0, y: 0 });
  // Paused is the default: no override, clock not started.
  assert.equal(particleTime(), EDITOR_FREEZE_TIME);
  assert.equal(evaluateState(foldState(doc, 0, 1), registry).state.items[id].time, EDITOR_FREEZE_TIME);
});

test("`= time` in the LIVE regime ADVANCES (the presenter's regime)", () => {
  const [doc, id] = clockDoc("clock_analog", { x: 0, y: 0 });
  startParticleClock();
  const first = evaluateState(foldState(doc, 0, 1), registry).state.items[id].time;
  // Busy-wait a measurable slice of wall time — this must not be a sleep, the suite
  // is synchronous, and the point is that two reads of the SAME document disagree.
  const spinUntil = Date.now() + 20;
  while (Date.now() < spinUntil) { /* spin */ }
  const second = evaluateState(foldState(doc, 0, 1), registry).state.items[id].time;
  stopParticleClock();
  assert.ok(second > first, `live clock did not advance (${first} → ${second})`);
  assert.equal(particleTime(), EDITOR_FREEZE_TIME); // stop returns to the freeze
});

test("`= time` arithmetic works — it is an ordinary number in the grammar", () => {
  const [doc, id] = clockDoc("clock_analog", { x: 0, y: 0, time: "= time * 3600 + 900" });
  setParticleTimeOverride(2);
  const value = evaluateState(foldState(doc, 0, 1), registry).state.items[id].time;
  setParticleTimeOverride(null);
  assert.equal(value, 2 * 3600 + 900);
});

// ── (2) THE MEMO cannot serve a stale clock ──────────────────────────────────

test("the memo does NOT freeze the clock: ONE state object, two clock values, two answers", () => {
  // THE EXACT TRAP. slideState memoizes per document, so foldState(doc, 0, 1)
  // returns the SAME object every call; evalMemo is a WeakMap on that object. A fix
  // that only taught scopeGet to read the clock would still hand back the first
  // frame's evaluation forever. Assert the identity, THEN assert divergence.
  const [doc, id] = clockDoc("clock_digital", { x: 0, y: 0 });
  const state = foldState(doc, 0, 1);
  assert.equal(foldState(doc, 0, 1), state, "precondition: the folded state is one shared object");
  setParticleTimeOverride(10);
  const at10 = evaluateState(state, registry).state.items[id].time;
  setParticleTimeOverride(20);
  const at20 = evaluateState(state, registry).state.items[id].time;
  setParticleTimeOverride(null);
  assert.equal(at10, 10);
  assert.equal(at20, 20);
});

test("a CLOCK-FREE document is still cached unconditionally (clock === null)", () => {
  // The memo the editor's drag latency depends on. A document with no `= time`
  // anywhere must report clock === null and return the IDENTICAL result object even
  // as the clock moves — otherwise the fix would have taxed every drag frame.
  const [doc] = withNewItem(newDocument(), 0, {
    ...registry.get("rect").defaults, x: 0, y: 0, w: 10, h: 10, active: true, z: "= 5 * 2",
  });
  const state = foldState(doc, 0, 1);
  setParticleTimeOverride(1);
  const first = evaluateState(state, registry);
  setParticleTimeOverride(999);
  const second = evaluateState(state, registry);
  setParticleTimeOverride(null);
  assert.equal(first.clock, null);
  assert.equal(second, first, "a clock-free evaluation was recomputed");
});

test("an evaluation that READ the clock records the value it used", () => {
  const [doc] = clockDoc("clock_analog", { x: 0, y: 0 });
  setParticleTimeOverride(7);
  const result = evaluateState(foldState(doc, 0, 1), registry);
  setParticleTimeOverride(null);
  assert.equal(result.clock, 7);
});

// ── (3) THE PRESENTER'S GATE — `clock !== null` decides the repaint loop ─────

test("evaluationAt().clock is the presenter's repaint gate: non-null with `= time`, null without", () => {
  // web/PresentMode.svelte's currentSlideHasVisibleAnimated returns true when this is
  // non-null, which is what makes a `= time` widget repaint at rest. Without it the
  // clock would advance and nothing would draw it — the two shipped commands would
  // still show a frozen face on screen even with the evaluator fixed. Pinned here in
  // bare node because the presenter component itself needs a browser.
  const [bound] = clockDoc("clock_analog", { x: 0, y: 0 });
  assert.notEqual(evaluationAt(bound, 0, 1, registry).clock, null);

  const [fixed] = withNewItem(newDocument(), 0, {
    ...registry.get("clock_analog").defaults, x: 0, y: 0, active: true, time: 500,
  });
  assert.equal(evaluationAt(fixed, 0, 1, registry).clock, null); // a hand-set clock: no loop
});

// ── (4) NO `frame`, and it fails LOUDLY ──────────────────────────────────────

test("`= frame` is an UNKNOWN REFERENCE — reported, not a second frozen constant", () => {
  const [doc, id] = clockDoc("clock_digital", { x: 0, y: 0, time: "= frame" });
  const { state, errors } = evaluateState(foldState(doc, 0, 1), registry);
  const message = errors.get(`items.${id}.time`);
  assert.ok(message, "`= frame` evaluated without an error — it is silently 0 again");
  assert.ok(message.includes("frame"), `error should name the reference: ${message}`);
  // Errored slots fall back to the plugin default — deterministic, never NaN.
  assert.equal(state.items[id].time, registry.get("clock_digital").defaults.time);
});

// ── (5) `time` is DISCOVERABLE, so a user does not name a variable over it ───

test("`time` is offered by the equation autocomplete (it takes precedence over a variable)", () => {
  const state = { vars: {}, items: {} };
  const names = suggestEquation("ti", 2, state, registry, null).map((c) => c.text);
  assert.ok(names.includes("time"), `expected "time" among ${JSON.stringify(names)}`);
  // And the precedence it warns about is real: a variable named `time` is shadowed
  // by the host clock, exactly as one named `Math` or `random` would be.
  const [doc, id] = withNewItem(keyframed(newDocument(), 0, ["vars", "time"], "1234"), 0, {
    ...registry.get("rect").defaults, x: "= time", y: 0, w: 10, h: 10, active: true,
  });
  setParticleTimeOverride(42);
  const value = evaluateState(foldState(doc, 0, 1), registry).state.items[id].x;
  setParticleTimeOverride(null);
  assert.equal(value, 42);
});

// ── (6) THE PIXEL PROOF, through the CLI's real pipeline ─────────────────────

const RENDER = { slide: 0, alpha: 1, width: 240, height: 240 };

/** Query (renders). PNG bytes for `doc` at presentation time `t`.
 * @example // await pngAt(docJson, 0) — the deck's first-second frame, 240x240 */
async function pngAt(docJson, t) {
  setParticleTimeOverride(t);
  try { return await renderDocToPng(docJson, RENDER); }
  finally { setParticleTimeOverride(null); }
}

for (const [type, label] of [["clock_analog", "demo-insert-clock-live"], ["clock_digital", "demo-insert-clock-digital"]]) {
  await atest(`PIXELS: the shipped "${label}" preset renders DIFFERENTLY at two times, and identically at the same one`, async () => {
    const meta = newDocument().meta;
    const [doc] = clockDoc(type, { x: meta.slideW / 4, y: meta.slideH / 4, w: meta.slideW / 2, h: meta.slideH / 2 });
    const json = serialize(doc);
    // 0 s vs 1810 s — a different second, minute AND hour hand / readout, so no
    // backend can pass this by rounding two nearby times to the same picture.
    const a = sha256(await pngAt(json, 0));
    const b = sha256(await pngAt(json, 1810));
    const aAgain = sha256(await pngAt(json, 0));
    assert.notEqual(a, b, "the clock rendered IDENTICAL pixels at 0 s and 1810 s — it is frozen");
    assert.equal(a, aAgain, "the same time rendered different pixels — the render is not deterministic");
  });
}

// ── (7) THE EXPORT SEAM — fps-correct, through createFrameSampler ─────────────
//
// The pixel proof above drives the clock with setParticleTimeOverride DIRECTLY,
// which is the LEAF of the export path but not the wiring above it. The MP4
// exporter reaches that leaf through web/videoExport.createFrameSampler: for
// output frame N it computes the wall-second subFrameTimes(N, 1, fps) = (N+0.5)/fps
// and hands it to `setTime` (renderJobPage wires setTime = setParticleTimeOverride).
// So the CLOCK IS A FUNCTION OF WALL SECONDS, not of frame index — which is the
// whole "render 30 vs 60 fps and it takes that into account" requirement. This
// section exercises that exact seam in bare node (samples:1 allocates no canvas,
// so createFrameSampler needs no DOM) with a renderFrame that, instead of pixels,
// reports the `= time` the evaluator actually saw at the sampler's chosen instant.

/** Query (evaluates; drives the module clock). Runs a `= time` doc through
 * createFrameSampler at `(frameIndex, fps)` and returns the `time` the evaluator
 * saw — i.e. the wall-second the export seam selected for that frame.
 * @example // await sampledTime(clockDoc("clock_digital")[0], id, 0, 30) // 0.0166… ((0+0.5)/30) */
async function sampledTime(doc, id, frameIndex, fps) {
  let seen = null;
  const sampler = createFrameSampler({
    plan: timelinePlan({ slides: [{}] }, { holdSeconds: 2 }), // duration 2s ⊇ every t below
    renderFrame: () => { seen = evaluateState(foldState(doc, 0, 1), registry).state.items[id].time; return null; },
    width: 4, height: 4, fps, samples: 1, setTime: setParticleTimeOverride,
  });
  try { await sampler.sample(frameIndex); } finally { sampler.release(); }
  return seen;
}

await atest("EXPORT SEAM: frame N at fps f evaluates `= time` to exactly (N+0.5)/f", async () => {
  const [doc, id] = clockDoc("clock_digital", { x: 0, y: 0 });
  for (const [n, fps] of [[0, 30], [15, 30], [7, 60], [0, 24]]) {
    const t = await sampledTime(doc, id, n, fps);
    assert.equal(t, subFrameTimes(n, 1, fps)[0], `frame ${n} @ ${fps}fps`);
    assert.equal(t, (n + 0.5) / fps);
  }
  assert.equal(particleTime(), EDITOR_FREEZE_TIME); // release() restored the freeze
});

await atest("EXPORT SEAM: the SAME wall-second yields the SAME value at two frame rates", async () => {
  // 10fps frame 0 and 30fps frame 1 both land on wall-second 0.05s:
  //   (0+0.5)/10 = 0.05 = (1+0.5)/30. The clock is seconds-since-start, so a
  //   deck exported at 10fps and at 30fps agrees wherever their frames coincide.
  const [doc, id] = clockDoc("clock_digital", { x: 0, y: 0 });
  const at10 = await sampledTime(doc, id, 0, 10);
  const at30 = await sampledTime(doc, id, 1, 30);
  assert.equal(at10, 0.05);
  assert.equal(at30, at10, "same wall-second rendered a different time at 30fps — the export is frame-index-driven, not time-driven");
});

console.log(failures ? `\n${failures} presentation-clock test(s) FAILED` : "\npresentation-clock tests passed");
process.exit(failures ? 1 : 0);
