/**
 * selfcheck.mjs — NEGATIVE CONTROLS. Does this harness catch a wrong port?
 *
 *   node harness/selfcheck.mjs
 *
 * A green A/B report is worth exactly as much as the harness's power to go red,
 * and nothing in `run.mjs` demonstrates that power: every one of its assertions
 * could be vacuous and the output would look the same. So each control below
 * BREAKS one side on purpose, in a way a careless porter really would, and
 * requires the measurement to name it.
 *
 * A control that does NOT fire is itself a failure, and this script exits
 * nonzero for it. That is the point: an unfireable gate is a gate that will sit
 * green through the bug it was written for.
 */

import { runCase, holdToSampleRate, AX_SAMPLE_RATE } from "./runner.mjs";
import { loadProcessors, renderProcessor } from "./js_side.mjs";
import { probe, PROBE_FREQS } from "./cases.mjs";
import { estimateF0, harmonicProfile, transferDb, cornerFrequency, fallTimeSeconds, rms } from "./analysis.mjs";

const registry = await loadProcessors(AX_SAMPLE_RATE);
const cents = (a, b) => 1200 * Math.log2(a / b);
let failures = 0;

/**
 * Command. Assert that a control fired.
 *
 * @param {string} label - what was broken
 * @param {boolean} detected - did the measurement notice
 * @param {string} detail - the measured numbers, printed either way
 */
function control(label, detected, detail) {
  console.log(`${detected ? "CAUGHT " : "MISSED "} ${label.padEnd(46)} ${detail}`);
  if (!detected) failures++;
}

const OSC = { includes: ["<axoloti_oscs.h>"], extraSources: ["firmware/axoloti_oscs.c"] };

// 1. ONE SEMITONE OF DETUNE — the smallest error that is still musically fatal.
{
  const ref = runCase({ id: "nc_pitch", axo: "osc/sine.axo", ...OSC, params: { pitch: 0 }, buffers: 1024, inlet: () => 0 });
  const js = renderProcessor(registry.get("ax2-osc-processor"),
    { processorOptions: { waveform: "sine" }, params: { pitch: 1 } }, ref.out.wave.length).p0;
  const d = cents(estimateF0(js, AX_SAMPLE_RATE), estimateF0(ref.out.wave, AX_SAMPLE_RATE));
  control("pitch +1 semitone on our side", Math.abs(d) > 10, `${d.toFixed(1)} cents`);
}

// 2. THE E4-vs-C4 SLIP — the single most common Axoloti porting error, and it is
//    four semitones, not an octave, so a coarse gate would miss it.
{
  const ref = runCase({ id: "nc_c4", axo: "osc/sine.axo", ...OSC, params: { pitch: 0 }, buffers: 1024, inlet: () => 0 });
  const f0Ref = estimateF0(ref.out.wave, AX_SAMPLE_RATE);
  const d = cents(261.6256, f0Ref); // what a C4-based port would have produced
  control("pitch 0 read as C4 instead of E4", Math.abs(d) > 10, `${d.toFixed(1)} cents (${f0Ref.toFixed(2)} Hz measured)`);
}

// 3. WRONG WAVEFORM AT THE RIGHT PITCH — what a correlation alone cannot see.
{
  const ref = runCase({ id: "nc_wave", axo: "osc/square.axo", ...OSC, params: { pitch: 0 }, buffers: 1024, inlet: () => 0 });
  const js = renderProcessor(registry.get("ax2-osc-processor"),
    { processorOptions: { waveform: "saw" }, params: { pitch: 0 } }, ref.out.wave.length).p0;
  const f0 = estimateF0(ref.out.wave, AX_SAMPLE_RATE);
  const hr = harmonicProfile(ref.out.wave, AX_SAMPLE_RATE, f0, 8);
  const hj = harmonicProfile(js, AX_SAMPLE_RATE, estimateF0(js, AX_SAMPLE_RATE), 8);
  const worst = Math.max(...[...hr].map((v, i) => Math.abs(v - hj[i])));
  const tuned = Math.abs(cents(estimateF0(js, AX_SAMPLE_RATE), f0));
  control("saw substituted for square (pitch correct)", worst > 0.12,
    `harmonic Δ ${worst.toFixed(3)}, and note the tuning is only ${tuned.toFixed(1)} cents off`);
}

// 4. A FILTER AN OCTAVE OFF.
{
  const ref = runCase({
    id: "nc_filt", axo: "filter/lp1.axo", params: { freq: 24 }, buffers: 1024,
    inlet: (n, b, s) => Math.round(probe(b * 16 + s) * 2 ** 27),
  });
  const js = renderProcessor(registry.get("ax-onepole-processor"),
    { options: { mode: "lowpass" }, params: { pitch: 12 }, input: (i) => probe(i) }, ref.out.out.length).p0;
  const n = ref.out.out.length;
  const input = Float64Array.from({ length: n }, (_, i) => probe(i));
  const cr = cornerFrequency([...transferDb(input, ref.out.out, AX_SAMPLE_RATE, PROBE_FREQS)], PROBE_FREQS);
  const cj = cornerFrequency([...transferDb(input, Float64Array.from(js), AX_SAMPLE_RATE, PROBE_FREQS)], PROBE_FREQS);
  control("one-pole cutoff an octave low", cj / cr < 0.87 || cj / cr > 1.15, `${cj.toFixed(0)} Hz vs ${cr.toFixed(0)} Hz`);
}

// 5. AN ENVELOPE AT THE WRONG SPEED.
{
  const K4 = await import(new URL("../../../../synth/ax4_kernels.js", import.meta.url).pathname);
  const ref = runCase({
    id: "nc_env", axo: "env/d.axo", params: { d: 0 }, buffers: 2048,
    inlet: (name, b) => (name === "trig" && b < 4 ? 1 : 0),
  });
  const a = holdToSampleRate(ref.out.env);
  const js = renderProcessor(registry.get("ax4-env-decay-processor"),
    { params: { trig: (i) => (i < 64 ? 1 : 0), d: K4.axTimeDialToSeconds(0) * 2 } }, a.length).p0;
  const fr = fallTimeSeconds(a, AX_SAMPLE_RATE, 1 / Math.E);
  const fj = fallTimeSeconds(Float64Array.from(js), AX_SAMPLE_RATE, 1 / Math.E);
  control("decay time doubled on our side", fj / fr > 1.2 || fj / fr < 0.83,
    `${(fj * 1000).toFixed(1)} ms vs ${(fr * 1000).toFixed(1)} ms`);
}

// 6. THE CONTROL RATE HOISTED TO THE QUANTUM — the failure this codebase's own
//    doctrine warns about ("hoisting `control()` to once per 128-frame quantum
//    would run every LFO 8x slow"). Modelled by asking the LFO for a pitch 36
//    semitones down, which is 8x slower, and checking the harness sees it.
{
  const ref = runCase({ id: "nc_lfo", axo: "lfo/sine.axo", params: { pitch: 0 }, buffers: 2048, inlet: () => 0 });
  const a = holdToSampleRate(ref.out.wave);
  const js = renderProcessor(registry.get("ax2-lfo-processor"),
    { processorOptions: { waveform: "sine" }, params: { pitch: -36 } }, a.length).p0;
  const d = cents(estimateF0(Float64Array.from(js), AX_SAMPLE_RATE), estimateF0(a, AX_SAMPLE_RATE));
  control("LFO running 8x slow (k-rate hoisted)", Math.abs(d) > 10, `${d.toFixed(0)} cents`);
}

// 7. A SILENT NODE. The cheapest possible wrong port, and the one a correlation
//    reports as 0 rather than as an obvious zero.
{
  const ref = runCase({ id: "nc_silent", axo: "osc/sine.axo", ...OSC, params: { pitch: 0 }, buffers: 512, inlet: () => 0 });
  const silent = new Float64Array(ref.out.wave.length);
  const ratio = rms(silent) / rms(ref.out.wave);
  control("our node emits silence", ratio < 0.77, `rms ratio ${ratio.toFixed(3)}`);
}

console.log(`\n${failures === 0 ? "every control fired" : `${failures} CONTROL(S) DID NOT FIRE`}`);
process.exit(failures === 0 ? 0 : 1);
