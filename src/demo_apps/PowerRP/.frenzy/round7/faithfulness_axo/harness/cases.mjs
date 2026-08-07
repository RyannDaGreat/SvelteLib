/**
 * cases.mjs — THE A/B ROSTER. One row per (our node, their object) pair.
 *
 * Each row states BOTH sides of one comparison and the units bridge between
 * them, which is the whole substance of a faithfulness claim:
 *
 *   ref   what to run on the AXOLOTI side — a `.axo` path, its dial values in
 *         XML units (-64…64, where 64 == 1.0), and an `inlet()` returning int32
 *   js    what to run on OUR side — a registered processor name, its params in
 *         OUR units, and an `input()` returning float
 *   kind  which measurements apply (see `run.mjs`)
 *
 * WHERE THE UNITS DIFFER, THE ROW SAYS SO. That is not a convenience: the
 * dial->seconds and dial->hertz maps ARE the thing under test for the envelopes
 * and filters, so each row converts explicitly through the SHIPPED helper
 * (`axTimeDialToSeconds` and friends) rather than through a number typed here.
 * If the shipped map is wrong, the measured time is wrong, and the row is red.
 */

import { toFrac32 } from "./runner.mjs";
import { APP_ROOT } from "./js_side.mjs";
import { join } from "node:path";

const K4 = await import(join(APP_ROOT, "synth/ax4_kernels.js"));

/** Their 48 kHz. Every case runs at it, on both sides. */
export const FS = 48000;

/**
 * THE PROBE AND THE MEASUREMENT GRID ARE THE SAME FREQUENCIES, AND THEY MUST BE.
 *
 * MEASURED 2026-08-07: they were not, and every filter's corner came out near
 * Nyquist with a 57 dB "passband gain". The probe was a sum of tones at
 * 20·2^(k/2) while `transferDb` measured at 30·2^(i/4), so at three quarters of
 * the measured points the INPUT had no energy, and the output/input ratio was
 * noise over nothing. A filter measurement is only meaningful where the probe
 * actually excites, so the excitation list IS the measurement list.
 *
 * 28 tones, quarter-octave spaced, 30 Hz to about 15 kHz. Fixed irrational-ish
 * phases so the sum has no giant peak at t=0 and the same waveform lands on both
 * sides bit for bit.
 */
export const PROBE_FREQS = Array.from({ length: 28 }, (_, i) => 30 * Math.pow(2, i * 0.32));

/** The probe's per-tone amplitude, chosen so the sum stays inside frac32's ±1. */
const PROBE_AMPLITUDE = 1 / 14;

/**
 * Pure function. The deterministic broadband probe: one tone per PROBE_FREQS
 * entry. Repeatable, and by construction it has known energy at every point the
 * transfer measurement reads.
 *
 * @param {number} i - sample index
 * @returns {number} amplitude, roughly within ±1
 *
 * @example probe(0).toFixed(3)  // '0.244' — the fixed phase offsets, summed
 */
export function probe(i) {
  let v = 0;
  for (let k = 0; k < PROBE_FREQS.length; k++) {
    v += Math.sin(2 * Math.PI * PROBE_FREQS[k] * i / FS + k * 0.7);
  }
  return v * PROBE_AMPLITUDE;
}

/** Pure function. A 440 Hz half-scale sine — the "does it pass a tone" probe. */
export const tone = (i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / FS);

/** Pure function. Gate high for the middle half of the run. */
const gateAt = (i, on, off) => (i >= on && i < off ? 1 : 0);

/** The k-rate tick count for a given sample index — one tick per 16 samples. */
const tickOf = (buffer) => buffer;

const OSC_INCLUDES = { includes: ["<axoloti_oscs.h>"], extraSources: ["firmware/axoloti_oscs.c"] };

/** Buffers of 16 samples in a standard oscillator run: 2048 * 16 = 32768 samples. */
const OSC_BUFFERS = 2048;
/** A filter run is the same length so the spectra are directly comparable. */
const FILTER_BUFFERS = 2048;
/** Envelopes are slower — 1.4 s at 3000 ticks/s. */
const ENV_BUFFERS = 4096;

/**
 * Pure function. One oscillator row, since the five differ only by file+name.
 *
 * @param {string} id
 * @param {string} axo - path under `objects/`
 * @param {string} waveform - our `OSC_WAVEFORMS` name
 * @param {number} pitchDial - semitones from E4, the SAME number both sides
 * @returns {Object} a case row
 *
 * @example oscCase('osc_sine_0', 'osc/sine.axo', 'sine', 0).kind // 'osc'
 */
function oscCase(id, axo, waveform, pitchDial, extra = {}) {
  return {
    id,
    node: `audio_ax_osc (${waveform})`,
    object: axo,
    kind: "osc",
    ref: {
      axo, ...OSC_INCLUDES, params: { pitch: pitchDial }, buffers: OSC_BUFFERS,
      inlet: (name) => (name === "pw" ? toFrac32(extra.pw ?? 0) : 0),
    },
    refPort: "wave",
    js: {
      name: "ax2-osc-processor", processorOptions: { waveform },
      params: { pitch: pitchDial, freq: 0, phase: 0, pw: extra.pw ?? 0 },
    },
    ...extra.overrides,
  };
}

/**
 * Pure function. One LFO row. THE LFO OUTPUT IS K-RATE on both sides: their
 * outlet is a bare `frac32`, so the C harness produces one value per 16-sample
 * buffer and `run.mjs` holds it up to sample rate before comparing.
 */
function lfoCase(id, axo, waveform, pitchDial) {
  return {
    id,
    node: `audio_ax_lfo (${waveform})`,
    object: axo,
    kind: "lfo",
    ref: { axo, params: { pitch: pitchDial }, buffers: OSC_BUFFERS, inlet: () => 0 },
    refPort: "wave",
    refIsKRate: true,
    js: { name: "ax2-lfo-processor", processorOptions: { waveform }, params: { pitch: pitchDial, reset: 0, phase: 0 } },
  };
}

/** The list. Order is by how many demo patches use the node, oscillators first. */
export const CASES = [
  // ── OSCILLATORS — audio_ax_osc, 28 patch references ───────────────────────
  oscCase("osc_sine_p0", "osc/sine.axo", "sine", 0),
  oscCase("osc_sine_p12", "osc/sine.axo", "sine", 12),
  oscCase("osc_sine_pm24", "osc/sine.axo", "sine", -24),
  oscCase("osc_saw_p0", "osc/saw.axo", "saw", 0),
  oscCase("osc_saw_p12", "osc/saw.axo", "saw", 12),
  oscCase("osc_square_p0", "osc/square.axo", "square", 0),
  oscCase("osc_pwm_p0", "osc/pwm.axo", "pwm", 0),
  oscCase("osc_pwm_pw50", "osc/pwm.axo", "pwm", 0, { pw: 0.5 }),
  oscCase("osc_sawmed_p0", "osc/saw medium.axo", "sawMedium", 0),

  // ── PHASOR — audio_ax_dp2saw / phasor ─────────────────────────────────────
  {
    id: "phasor_p0", node: "audio_ax_phasor", object: "osc/phasor.axo", kind: "osc",
    ref: { axo: "osc/phasor.axo", params: { pitch: 0 }, buffers: OSC_BUFFERS, inlet: () => 0 },
    refPort: "phasor",
    js: { name: "ax2-phasor-processor", params: { pitch: 0, freq: 0 } },
  },

  // ── LFO — audio_ax_lfo, 37 patch references ───────────────────────────────
  lfoCase("lfo_sine_p0", "lfo/sine.axo", "sine", 0),
  lfoCase("lfo_sine_pm24", "lfo/sine.axo", "sine", -24),
  lfoCase("lfo_saw_p0", "lfo/saw.axo", "saw", 0),
  lfoCase("lfo_square_p0", "lfo/square.axo", "square", 0),

  // ── ENVELOPES — audio_ax_env_*, 22 patch references ───────────────────────
  {
    id: "env_adsr", node: "audio_ax_env_adsr", object: "env/adsr.axo", kind: "env",
    // a is `klineartime.exp2` (a pfunction the C side computes), d/r are plain
    // `frac32.s.map`, s is `frac32.u.map`. Dials chosen so every stage is
    // measurable inside the run: fast attack, medium decay, half sustain.
    ref: {
      axo: "env/adsr.axo", params: { a: 0, d: 0, s: 32, r: 0 }, buffers: ENV_BUFFERS,
      inlet: (name, b) => (name === "gate" ? (tickOf(b) < 2048 ? 1 : 0) : 0),
    },
    refPort: "env", refIsKRate: true,
    js: {
      name: "ax4-env-adsr-processor",
      params: {
        gate: (i) => (i < 2048 * 16 ? 1 : 0),
        a: K4.axTimeDialToSeconds(0), d: K4.axTimeDialToSeconds(0),
        s: 0.5, r: K4.axTimeDialToSeconds(0),
      },
    },
  },
  {
    id: "env_d", node: "audio_ax_env_d", object: "env/d.axo", kind: "env",
    ref: {
      axo: "env/d.axo", params: { d: 0 }, buffers: ENV_BUFFERS,
      inlet: (name, b) => (name === "trig" ? (tickOf(b) < 4 ? 1 : 0) : 0),
    },
    refPort: "env", refIsKRate: true,
    js: {
      name: "ax4-env-decay-processor",
      params: { trig: (i) => (i < 4 * 16 ? 1 : 0), d: K4.axTimeDialToSeconds(0) },
    },
  },
  {
    id: "env_d_lin", node: "audio_ax_env_d_lin_m", object: "env/d lin m.axo", kind: "env",
    ref: {
      axo: "env/d lin m.axo", params: { d: 0 }, buffers: ENV_BUFFERS,
      inlet: (name, b) => (name === "trig" ? (tickOf(b) < 4 ? 1 : 0) : 0),
    },
    refPort: "env", refIsKRate: true,
    js: {
      name: "ax4-env-decay-linear-processor",
      params: { trig: (i) => (i < 4 * 16 ? 1 : 0), d: K4.axTimeDialToSeconds(0) },
    },
  },
  {
    id: "env_ahd", node: "audio_ax_env_ahd", object: "env/ahd m.axo", kind: "env",
    ref: {
      axo: "env/ahd m.axo", params: { a: 16, d: 16 }, buffers: ENV_BUFFERS,
      inlet: (name, b) => (name === "gate" ? (tickOf(b) < 2048 ? 1 : 0) : 0),
    },
    refPort: "env", refIsKRate: true,
    js: {
      name: "ax4-env-ahd-processor",
      params: {
        gate: (i) => (i < 2048 * 16 ? 1 : 0),
        a: K4.axDecayDialToSeconds(16), d: K4.axDecayDialToSeconds(16),
      },
    },
  },

  // ── FILTERS — audio_ax_vcf3 / onepole / kfilter / svf / allpass ───────────
  {
    id: "vcf3", node: "audio_ax_vcf3", object: "filter/vcf3.axo", kind: "filter",
    ref: {
      axo: "filter/vcf3.axo", includes: ["<axoloti_filters.h>"],
      params: { pitch: 24, reso: 32 }, buffers: FILTER_BUFFERS,
      inlet: (name, b, s) => (name === "in" ? toFrac32(probe(b * 16 + s)) : 0),
    },
    refPort: "out",
    js: { name: "ax-vcf3-processor", params: { pitch: 24, reso: 32 }, input: (i) => probe(i) },
  },
  {
    id: "onepole_lp", node: "audio_ax_onepole (lowpass)", object: "filter/lp1.axo", kind: "filter",
    ref: {
      axo: "filter/lp1.axo", params: { freq: 24 }, buffers: FILTER_BUFFERS,
      inlet: (name, b, s) => (name === "in" ? toFrac32(probe(b * 16 + s)) : 0),
    },
    refPort: "out",
    js: { name: "ax-onepole-processor", options: { mode: "lowpass" }, params: { pitch: 24 }, input: (i) => probe(i) },
  },
  {
    id: "onepole_hp", node: "audio_ax_onepole (highpass)", object: "filter/hp1.axo", kind: "filter",
    ref: {
      axo: "filter/hp1.axo", params: { freq: 24 }, buffers: FILTER_BUFFERS,
      inlet: (name, b, s) => (name === "in" ? toFrac32(probe(b * 16 + s)) : 0),
    },
    refPort: "out",
    js: { name: "ax-onepole-processor", options: { mode: "highpass" }, params: { pitch: 24 }, input: (i) => probe(i) },
  },
  {
    id: "svf_lp", node: "audio_ax_svf (lowpass)", object: "filter/lp svf.axo", kind: "filter",
    ref: {
      axo: "filter/lp svf.axo", params: { pitch: 24, reso: 32 }, buffers: FILTER_BUFFERS,
      inlet: (name, b, s) => (name === "in" ? toFrac32(probe(b * 16 + s)) : 0),
    },
    refPort: "out",
    // THREE OUTPUT PORTS, and the processor RETURNS EARLY if given fewer:
    // `if (outputs.length < 3) return true;`. Wired with one port it emits pure
    // silence and reports nothing — which this harness first read as "our SVF is
    // dead". It is a real sharp edge (a graph that wires only the lowpass tap
    // gets nothing), but it is not a fidelity defect, so the case wires all three
    // and compares tap 2, the lowpass, against `filter/lp svf`.
    js: {
      name: "ax-svf-processor", params: { pitch: 24, reso: 32 }, input: (i) => probe(i),
      outputPorts: 3,
    },
    jsPort: "p2",
  },
  {
    id: "biquad_lp", node: "audio_ax_biquad (lowpass)", object: "filter/lp.axo", kind: "filter",
    ref: {
      axo: "filter/lp.axo", includes: ["<axoloti_filters.h>"],
      params: { pitch: 24, reso: 32 }, buffers: FILTER_BUFFERS,
      inlet: (name, b, s) => (name === "in" ? toFrac32(probe(b * 16 + s)) : 0),
    },
    refPort: "out",
    js: { name: "ax-biquad-processor", options: { mode: "lowpass" }, params: { pitch: 24, reso: 32 }, input: (i) => probe(i) },
  },
  {
    id: "kfilter_lowpass", node: "audio_ax_kfilter_lowpass", object: "kfilter/lowpass.axo", kind: "krate",
    ref: {
      axo: "kfilter/lowpass.axo", params: { freq: -24 }, buffers: FILTER_BUFFERS,
      inlet: (name, b) => (name === "in" ? toFrac32(probe(b * 16)) : 0),
    },
    refPort: "out", refIsKRate: true,
    // Our node is the UNION of the symmetric and asymmetric kfilters, so the
    // one-param original is `rise == decay`.
    js: {
      name: "ax-kfilter-lowpass-processor", params: { rise: -24, decay: -24 },
      input: (i) => probe(Math.floor(i / 16) * 16),
    },
  },
  {
    id: "allpass", node: "audio_ax_allpass", object: "filter/allpass.axo", kind: "comb",
    // MEASURED DEFECT, not a deviation. Our line reads ONE SAMPLE SHORT: driving
    // `ax-allpass-processor` with `delay: 1001` reproduces `filter/allpass`'s
    // `attr_delay = 1000` at NCC 1.000000 / max |Δ| 0.00069, while 1000 gives
    // 0.873 / 0.412. `worklets/processors_ax3.js` AxAllpassProcessor reads
    // `newer = line[(write - whole + 1) & MASK]` and lerps `newer + (older -
    // newer) * frac`, so at frac == 0 it returns the sample at write-whole+1 —
    // an effective delay of `delay - 1`. The two taps should straddle the delay
    // DOWNWARD (`write - whole` and `write - whole - 1`), not upward. The class
    // docblock claims the opposite of what the code does: it says this path
    // "interpolates to a delay of exactly M where TSG's own 2-point path lands
    // one sample short". It is the one that lands short.
    note: "our delay line is one sample short; `delay: 1001` matches their `attr_delay: 1000` at NCC 1.000000",
    ref: {
      axo: "filter/allpass.axo", attribs: { delay: 1000 }, params: { g: 32 }, buffers: FILTER_BUFFERS,
      inlet: (name, b, s) => (name === "in" ? toFrac32(probe(b * 16 + s)) : 0),
    },
    refPort: "out",
    js: { name: "ax-allpass-processor", params: { delay: 1000, g: 0.5 }, input: (i) => probe(i) },
  },
  {
    id: "fdbkcomb", node: "audio_ax_fdbkcomb", object: "filter/fdbkcomb.axo", kind: "comb",
    ref: {
      axo: "filter/fdbkcomb.axo", attribs: { delay: 1000 }, params: { a: 32, b: 32 }, buffers: FILTER_BUFFERS,
      inlet: (name, b, s) => (name === "in" ? toFrac32(probe(b * 16 + s)) : 0),
    },
    refPort: "out",
    js: { name: "ax-fdbkcomb-processor", params: { delay: 1000, a: 0.5, b: 0.5 }, input: (i) => probe(i) },
  },

  // ── MIX / GAIN / DISTORTION ───────────────────────────────────────────────
  {
    id: "xfade", node: "audio_ax_xfade", object: "mix/xfade.axo", kind: "krate",
    ref: {
      axo: "mix/xfade.axo", params: {}, buffers: 1024,
      inlet: (name, b) => (name === "i1" ? toFrac32(tone(b * 16))
        : name === "i2" ? toFrac32(-0.3) : toFrac32(0.25)),
    },
    refPort: "o", refIsKRate: true,
    js: {
      name: "ax4-xfade-processor", params: { c: 0.25 }, inputPorts: 2,
      input: (i, port) => (port === 0 ? tone(Math.floor(i / 16) * 16) : -0.3),
    },
  },
  {
    id: "dist_soft", node: "audio_ax_dist_soft", object: "dist/soft.axo", kind: "krate",
    ref: {
      axo: "dist/soft.axo", params: {}, buffers: 1024,
      inlet: (name, b) => toFrac32(1.6 * Math.sin(2 * Math.PI * 220 * b * 16 / FS)),
    },
    refPort: "out", refIsKRate: true,
    js: {
      name: "ax4-dist-soft-processor", inputPorts: 1,
      input: (i) => 1.6 * Math.sin(2 * Math.PI * 220 * (Math.floor(i / 16) * 16) / FS),
    },
  },
  {
    id: "dist_inf", node: "audio_ax_dist_inf", object: "dist/inf.axo", kind: "sig",
    ref: {
      axo: "dist/inf.axo", ...OSC_INCLUDES, params: {}, buffers: 1024,
      inlet: (name, b, s) => toFrac32(0.8 * Math.sin(2 * Math.PI * 220 * (b * 16 + s) / FS)),
    },
    refPort: "out",
    js: {
      name: "ax4-dist-inf-processor", inputPorts: 1,
      input: (i) => 0.8 * Math.sin(2 * Math.PI * 220 * i / FS),
    },
  },
  {
    id: "mix4", node: "audio_ax_mix", object: "mix/mix 4.axo", kind: "krate",
    ref: {
      axo: "mix/mix 4.axo", params: { gain1: 32, gain2: 32, gain3: 32, gain4: 32 }, buffers: 1024,
      inlet: (name, b) => {
        if (name === "bus_in") return 0;
        const n = Number(name.replace("in", ""));
        return toFrac32(0.2 * n * Math.sin(2 * Math.PI * (110 * n) * b * 16 / FS));
      },
    },
    refPort: "out", refIsKRate: true,
    js: {
      name: "ax4-mix-processor", inputPorts: 7,
      params: { gain1: 0.5, gain2: 0.5, gain3: 0.5, gain4: 0.5, gain5: 0, gain6: 0 },
      // input port 0 is `bus_in`; ports 1..6 are in1..in6.
      input: (i, port) => {
        if (port === 0 || port > 4) return 0;
        const t = Math.floor(i / 16) * 16;
        return 0.2 * port * Math.sin(2 * Math.PI * (110 * port) * t / FS);
      },
    },
  },
  {
    id: "vca", node: "audio_ax_vca_stereo", object: "gain/vca.axo", kind: "sig",
    // Their `gain/vca` is MONO; ours is `sss/gain/vcaST`, the stereo widening of
    // exactly this recurrence. Channel 1 is therefore the comparison.
    ref: {
      axo: "gain/vca.axo", params: {}, buffers: 1024,
      inlet: (name, b, s) => (name === "v" ? toFrac32(0.6) : toFrac32(tone(b * 16 + s))),
    },
    refPort: "o",
    js: {
      name: "ax4-vca-stereo-processor", params: { v: 0.6 }, inputPorts: 2, outputPorts: 2,
      input: (i) => tone(i),
    },
    jsPort: "p0",
  },

  // ── AX-1 K-RATE PRIMITIVES — audio_ax_math alone has 98 patch references ──
  // These are all `<code.krate>` scalar objects: one value per 16 samples on
  // both sides. Cheap to cover and the most-used nodes in the whole library.
  {
    id: "math_star", node: "audio_ax_math (multiply)", object: "math/STAR.axo", kind: "krate",
    ref: {
      axo: "math/STAR.axo", params: {}, buffers: 1024,
      inlet: (name, b) => (name === "a" ? toFrac32(tone(b * 16)) : toFrac32(0.75)),
    },
    refPort: "result", refIsKRate: true,
    js: {
      name: "ax1-math", options: { operation: "multiply" }, params: { b: 0.75 },
      input: (i) => tone(Math.floor(i / 16) * 16),
    },
  },
  {
    id: "math_plus", node: "audio_ax_math (add)", object: "math/PLUS.axo", kind: "krate",
    ref: {
      axo: "math/PLUS.axo", params: {}, buffers: 1024,
      inlet: (name, b) => (name === "in1" ? toFrac32(tone(b * 16)) : toFrac32(0.2)),
    },
    refPort: "out", refIsKRate: true,
    js: {
      name: "ax1-math", options: { operation: "add" }, params: { b: 0.2 },
      input: (i) => tone(Math.floor(i / 16) * 16),
    },
  },
  {
    id: "math_max", node: "audio_ax_math (maximum)", object: "math/max.axo", kind: "krate",
    ref: {
      axo: "math/max.axo", params: {}, buffers: 1024,
      inlet: (name, b) => (name === "in1" ? toFrac32(tone(b * 16)) : toFrac32(0.1)),
    },
    refPort: "out", refIsKRate: true,
    js: {
      name: "ax1-math", options: { operation: "maximum" }, params: { b: 0.1 },
      input: (i) => tone(Math.floor(i / 16) * 16),
    },
  },
  {
    id: "math_abs", node: "audio_ax_math (absolute)", object: "math/abs.axo", kind: "krate",
    ref: { axo: "math/abs.axo", params: {}, buffers: 1024, inlet: (n, b) => toFrac32(tone(b * 16)) },
    refPort: "out", refIsKRate: true,
    js: { name: "ax1-math", options: { operation: "absolute" }, input: (i) => tone(Math.floor(i / 16) * 16) },
  },
  {
    id: "math_sat", node: "audio_ax_math (saturate)", object: "math/sat.axo", kind: "krate",
    ref: { axo: "math/sat.axo", params: {}, buffers: 1024, inlet: (n, b) => toFrac32(1.8 * tone(b * 16)) },
    refPort: "out", refIsKRate: true,
    js: { name: "ax1-math", options: { operation: "saturate" }, input: (i) => 1.8 * tone(Math.floor(i / 16) * 16) },
  },
  {
    id: "smooth", node: "audio_ax_smooth", object: "math/smooth.axo", kind: "krate",
    // `time` is a DIAL on both sides here — our processor takes 0..64 directly,
    // which is the one place in the library where our unit IS theirs.
    ref: {
      axo: "math/smooth.axo", params: { time: 32 }, buffers: 2048,
      inlet: (n, b) => toFrac32(b < 512 ? 0 : 0.8),
    },
    refPort: "out", refIsKRate: true,
    js: {
      name: "ax1-smooth", params: { time: 32, enable: 1 },
      input: (i) => (Math.floor(i / 16) < 512 ? 0 : 0.8),
    },
  },
  {
    id: "window", node: "audio_ax_window", object: "math/window.axo", kind: "krate",
    ref: {
      axo: "math/window.axo", params: {}, buffers: 1024,
      inlet: (n, b) => toFrac32((b % 256) / 256),
    },
    refPort: "win", refIsKRate: true,
    js: { name: "ax1-window", input: (i) => (Math.floor(i / 16) % 256) / 256 },
  },
  {
    id: "latch", node: "audio_ax_latch", object: "logic/latch.axo", kind: "krate",
    ref: {
      axo: "logic/latch.axo", params: {}, buffers: 1024,
      inlet: (name, b) => (name === "i" ? toFrac32(tone(b * 16)) : (b % 97 === 0 ? 1 : 0)),
    },
    refPort: "o", refIsKRate: true,
    js: {
      name: "ax1-latch", inputPorts: 2,
      input: (i, port) => {
        const t = Math.floor(i / 16);
        return port === 0 ? tone(t * 16) : (t % 97 === 0 ? 1 : 0);
      },
    },
  },
  {
    id: "counter", node: "audio_ax_counter", object: "logic/counter.axo", kind: "int",
    ref: {
      axo: "logic/counter.axo", params: { maximum: 8 }, buffers: 1024,
      inlet: (name, b) => (name === "trig" ? (b % 13 === 0 ? 1 : 0) : 0),
    },
    refPort: "o", refIsKRate: true,
    // Their `o` is a bare int32; ours is that count over 64. See `jsScale`.
    jsScale: 64,
    js: {
      // TWO output ports: `o` (the count) and `c` (the carry pulse).
      name: "ax1-counter", params: { maximum: 8 }, inputPorts: 2, outputPorts: 2,
      input: (i, port) => (port === 0 && Math.floor(i / 16) % 13 === 0 ? 1 : 0),
    },
  },
  {
    id: "logic_and", node: "audio_ax_logic (and)", object: "logic/and 2.axo", kind: "int",
    ref: {
      axo: "logic/and 2.axo", params: {}, buffers: 1024,
      inlet: (name, b) => (name === "i1" ? (b % 5 < 3 ? 1 : 0) : (b % 7 < 4 ? 1 : 0)),
    },
    refPort: "o", refIsKRate: true,
    js: {
      name: "ax1-logic", params: { b: (i) => (Math.floor(i / 16) % 7 < 4 ? 1 : 0) },
      options: { operation: "and" },
      input: (i) => (Math.floor(i / 16) % 5 < 3 ? 1 : 0),
    },
  },
  {
    id: "convert_b2u", node: "audio_ax_convert (bipolar2unipolar)", object: "conv/bipolar2unipolar.axo", kind: "krate",
    ref: { axo: "conv/bipolar2unipolar.axo", params: {}, buffers: 1024, inlet: (n, b) => toFrac32(tone(b * 16)) },
    refPort: "o", refIsKRate: true,
    js: { name: "ax1-convert", options: { mode: "bipolarToUnipolar" }, input: (i) => tone(Math.floor(i / 16) * 16) },
  },
  {
    id: "mux2", node: "audio_ax_mux", object: "mux/mux 2.axo", kind: "krate",
    ref: {
      axo: "mux/mux 2.axo", params: {}, buffers: 1024,
      inlet: (name, b) => (name === "i1" ? toFrac32(tone(b * 16))
        : name === "i2" ? toFrac32(-0.4) : 1),
    },
    refPort: "o", refIsKRate: true,
    js: {
      name: "ax1-mux", params: { select: 1 }, inputPorts: 8,
      input: (i, port) => (port === 0 ? tone(Math.floor(i / 16) * 16) : port === 1 ? -0.4 : 0),
    },
  },

  // ── NOISE — statistical only, see `rand_s32` in axo_shim.h ────────────────
  {
    id: "noise_uniform", expected: "Their `rand_s32()` folds in `RNG->DR`, the STM32 hardware entropy source: NOT reproducible on real Axoloti either, so a sample match is not a thing that exists. Judged on spectral tilt and level instead, which agree.", node: "audio_ax_noise (uniform)", object: "noise/uniform.axo", kind: "noise",
    ref: { axo: "noise/uniform.axo", params: {}, buffers: OSC_BUFFERS, inlet: () => 0 },
    refPort: "wave",
    js: { name: "ax2-noise-processor", processorOptions: { colour: "uniform", seed: 1 } },
  },
  {
    id: "noise_pink", expected: "Same hardware RNG as `noise_uniform`. The pink filter bank on top is deterministic, and the tilt measurement is what tests it.", node: "audio_ax_noise (pink)", object: "noise/pink.axo", kind: "noise",
    ref: { axo: "noise/pink.axo", params: {}, buffers: OSC_BUFFERS, inlet: () => 0 },
    refPort: "out",
    js: { name: "ax2-noise-processor", processorOptions: { colour: "pink", seed: 1 } },
  },
];
