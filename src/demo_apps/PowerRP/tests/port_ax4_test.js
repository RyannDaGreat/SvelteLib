/**
 * AX-4 PORT PROOF — the eleven Axoloti envelope / gain / mix / distortion nodes,
 * measured against an INTEGER model of the original C rather than against their
 * own algebra.
 * Run: node src/demo_apps/PowerRP/tests/port_ax4_test.js
 *
 * ── WHY THIS FILE IS SHAPED LIKE THIS ───────────────────────────────────────
 * A port of a fixed-point recurrence has one interesting failure mode: the float
 * transcription is self-consistent and WRONG. For an ENVELOPE the specific way
 * that happens is the k-rate bridge — run `control()` once per 128-sample
 * quantum instead of once per 16 and every stage is 8× long, which still sounds
 * like music and passes any check written from the same wrong assumption. So the
 * reference below is not a second float formula. It is Axoloti's own arithmetic:
 * `___SMMUL` / `___SMMLA` / `__SSAT` / `__USAT` / `mtof48k_q31` and the four
 * pfunctions, reproduced in BigInt so every truncation lands where theirs does,
 * driven at their real 3000 Hz — and what is compared is the envelope's measured
 * DURATION, not a coefficient.
 *
 * ── IT TESTS THE SHIPPED KERNELS, NOT A COPY OF THEM ────────────────────────
 * `synth/ax4_kernels.js` is the ONE copy of the arithmetic and this file imports
 * it. The processor file is read as TEXT only for the structural pins at the
 * bottom (the k-rate tick, the registered names), which are properties of the
 * BRIDGE and have nothing to import them from.
 *
 * WHAT THIS FILE DOES NOT PROVE: that any of it sounds right. It proves the
 * arithmetic matches the original's to the tolerances quoted per check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BLOCK_SPECS, axDecayDialSeconds, axTimeDialSeconds } from "../core/audio_specs_ax4.js";
import { audioKnobDefaults, audioKnobRows, audioNodePlugin } from "../core/audio_nodes.js";
import { NODE_FAMILY_NAMES } from "../core/node_chrome.js";
import { PORT_TYPE_NAMES } from "../core/nodeflow.js";
import { AUDIO_SPECS } from "../core/audio_specs.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_ax4.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES } from "../synth/modules_ax4.js";
import { AX4_PROCESSORS } from "../synth/worklets/processors_ax4.js";
import { blepResidual } from "../synth/ax2_kernels.js";
import * as K from "../synth/ax4_kernels.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/** Report a measured error and assert its bound in one place, so no comparison
 *  is silently loose. */
const within = (label, measured, bound) => {
  console.log(`  ${label}: ${measured}  (bound ${bound})`);
  assert.ok(measured <= bound, `${label}: ${measured} exceeds ${bound}`);
};

/** Axoloti's own rate. Every reference number here is at 48 kHz because that is
 *  the rate the hardware runs and the rate its tables are built for. */
const FS = 48000;
const TICK = K.AX_BUFSIZE / FS;
const INT32_MAX = 0x7fffffff;
const FRAC32_ONE = 2 ** 27;
const SEMITONE_RAW = 2 ** 21;

const WORKLET_SOURCE = readFileSync(join(here, "../synth/worklets/processors_ax4.js"), "utf8");

// ── THE INTEGER MODEL — Axoloti's arithmetic, exactly ───────────────────────

/** Pure function. int32 truncation, the C cast every intermediate silently does. */
const i32 = (x) => Number(BigInt.asIntN(32, BigInt(Math.trunc(x))));

/** Pure function. `___SMMUL` — the top 32 bits of a signed 64-bit product.
 *  BigInt `>>` floors, which is what an arithmetic shift does, which is what
 *  the ARM instruction does. */
const smmul = (a, b) => Number((BigInt(a) * BigInt(b)) >> 32n);

/** Pure function. `___SMMLA` — accumulate the top 32 bits. */
const smmla = (a, b, c) => i32(c + smmul(a, b));

/** Pure function. `__SSAT(x, bits)`. */
const ssat = (x, bits) => {
  const lim = 2 ** (bits - 1);
  return x > lim - 1 ? lim - 1 : (x < -lim ? -lim : x);
};

/** Pure function. `__USAT(x, bits)`. */
const usat = (x, bits) => {
  const lim = 2 ** bits - 1;
  return x > lim ? lim : (x < 0 ? 0 : x);
};

/** Pure function. An XML dial's `modvalue` — the raw int a pfunction receives. */
const dialRaw = (dial) => i32(Math.round(dial * SEMITONE_RAW));

/** `pitcht[]` from axoloti_math.c: 257 entries, `4·2^30·f/48000`, hard-clamped
 *  at 2^31 (i.e. at 24 kHz). Built once, exactly as `axoloti_math_init` does. */
const PITCH_TABLE_SIZE = 257;
const pitcht = new Array(PITCH_TABLE_SIZE);
for (let i = 0; i < PITCH_TABLE_SIZE; i++) {
  const f = 440 * Math.pow(2, (i - 69 - 64) / 12);
  const phi = 4 * 2 ** 30 * f / FS;
  pitcht[i] = phi > 2 ** 31 ? INT32_MAX : Math.trunc(phi);
}

/** `mtof48k_q31` / `mtof48k_ext_q31` (api/axoloti_math.h:88 and :102) — the same
 *  body under a different `__SSAT` width. */
function mtof(pitchRaw, bits) {
  const p = ssat(pitchRaw, bits);
  const pi = Math.floor(p / SEMITONE_RAW);
  const y1 = pitcht[128 + pi];
  const y2 = pitcht[128 + 1 + pi];
  const pf = i32((p & 0x1fffff) * 2 ** 10);
  const pfc = i32(INT32_MAX - pf);
  let r = smmul(y1, pfc);
  r = smmla(y2, pf, r);
  return Number(BigInt.asUintN(32, BigInt(r) * 2n));
}

/** `pfun_inl_kexpltime` — a RISE step (api/parameter_functions.h:71). */
const pfKexpLTime = (raw) => Math.floor(mtof(-raw, 28) / 4);

/** `pfun_inl_kexpdtime` — a DECAY coefficient (api/parameter_functions.h:77). */
const pfKexpDTime = (raw) => i32(INT32_MAX - Math.floor(mtof(-raw, 28) / 4));

/** `blept[i]` recovered exactly from the one copy ax2_kernels ships. */
const BLEP_UNITY = 16384;
const blepAt = (i) => Math.round((1 - blepResidual(i)) * BLEP_UNITY);

// ── THE OBJECTS, TRANSCRIBED LINE BY LINE ───────────────────────────────────

/** `env/adsr` `code.krate`, in ints. Returns q27 outputs, one per control tick. */
function adsrInt(dials, gateAt, ticks) {
  const pa = pfKexpLTime(dialRaw(dials.a));
  const pd = pfKexpDTime(dialRaw(dials.d));
  const ps = usat(dialRaw(dials.s), 27);
  const pr = pfKexpDTime(dialRaw(dials.r));
  let stage = 0;
  let ntrig = 0;
  let val = 0;
  const out = new Float64Array(ticks);
  for (let t = 0; t < ticks; t++) {
    const gate = gateAt(t);
    if (gate > 0 && !ntrig) { stage = 1; ntrig = 1; }
    if (!(gate > 0) && ntrig) { stage = 0; ntrig = 0; }
    if (stage === 0) {
      val = i32(smmul(val, pr) * 2);
    } else if (stage === 1) {
      val = i32(val + pa);
      if (val < 0) { val = INT32_MAX; stage = 2; }
    } else {
      const s4 = i32(ps * 16);
      val = i32(s4 + i32(smmul(i32(val - s4), pd) * 2));
    }
    out[t] = (val >> 4) / FRAC32_ONE;
  }
  return out;
}

/** `env/ahd m` `code.krate`, in ints. */
function ahdInt(dials, gateAt, ticks) {
  const pa = usat(dialRaw(dials.a), 27);
  const pd = usat(dialRaw(dials.d), 27);
  let val = 0;
  const out = new Float64Array(ticks);
  for (let t = 0; t < ticks; t++) {
    if (gateAt(t) > 0) val = smmla(i32((1 << 27) - val), i32((1 << 26) - (pa >> 1)), val);
    else val = smmla(val, i32(-(1 << 26) + (pd >> 1)), val);
    out[t] = val / FRAC32_ONE;
  }
  return out;
}

/** `env/d` `code.krate`, in ints. */
function envDecayInt(dialD, trigAt, ticks) {
  const pd = pfKexpDTime(dialRaw(dialD));
  let ntrig = 0;
  let val = 0;
  const out = new Float64Array(ticks);
  for (let t = 0; t < ticks; t++) {
    const trig = trigAt(t);
    if (trig > 0 && !ntrig) { val = 1 << 27; ntrig = 1; }
    else {
      if (!(trig > 0)) ntrig = 0;
      val = i32(smmul(val, pd) * 2);
    }
    out[t] = val / FRAC32_ONE;
  }
  return out;
}

/** `env/d lin m` `code.krate`, in ints. */
function envDecayLinearInt(dialD, trigAt, ticks) {
  const pd = ssat(dialRaw(dialD), 28);
  let ntrig = 0;
  let val = 0;
  const out = new Float64Array(ticks);
  for (let t = 0; t < ticks; t++) {
    const trig = trigAt(t);
    if (trig > 0 && !ntrig) { val = 1 << 27; ntrig = 1; }
    else {
      if (!(trig > 0)) ntrig = 0;
      val = i32(val - (mtof(-pd, 28) >>> 6));
      if (val < 0) val = 0;
    }
    out[t] = val / FRAC32_ONE;
  }
  return out;
}

/** `mix/mix 6` `code.srate`, in ints. `ins` are real values, `dials` 0…64. */
function mixInt(busIn, ins, dials) {
  const gains = dials.map((d) => usat(dialRaw(d), 27));
  let accum = smmul(raw(ins[0]), gains[0]);
  for (let k = 1; k < ins.length; k++) accum = smmla(raw(ins[k]), gains[k], accum);
  return ssat(i32(raw(busIn) + i32(accum * 32)), 28) / FRAC32_ONE;
}

/** `mix/xfade` third overload, in ints. */
function xfadeInt(i1, i2, c) {
  const cRaw = raw(c);
  const ccompl = i32((128 << 20) - cRaw);
  const a = BigInt(raw(i2)) * BigInt(cRaw) + BigInt(raw(i1)) * BigInt(ccompl);
  return Number(a >> 27n) / FRAC32_ONE;
}

/** `sss/gain/vcaST`, in ints. `levels` is one control value per tick. */
function vcaStereoInt(a1, a2, levels) {
  const count = a1.length;
  const left = new Float64Array(count);
  const right = new Float64Array(count);
  let prev = 0;
  let g = 0;
  let step = 0;
  for (let n = 0; n < count; n++) {
    if (n % K.AX_BUFSIZE === 0) {
      const v = raw(levels[n / K.AX_BUFSIZE]);
      step = (v - prev) >> 4;
      g = prev;
      prev = v;
    }
    left[n] = i32(smmul(raw(a1[n]), g) * 32) / FRAC32_ONE;
    right[n] = i32(smmul(raw(a2[n]), g) * 32) / FRAC32_ONE;
    g = i32(g + step);
  }
  return { left, right };
}

/** `dist/soft` `code.srate`, in ints. */
function distSoftInt(x) {
  const ts = ssat(raw(x), 28);
  const tsq31 = i32(ts * 8);
  const cubed = smmul(tsq31, smmul(tsq31, tsq31));
  return i32(ts + (ts >> 1) - cubed) / FRAC32_ONE;
}

/** `dist/inf` `code.krate`, in ints — the whole body, including its own
 *  BUFSIZE loop, which is why it is per sample. */
function distInfInt(series) {
  const voices = new Int32Array(8).fill(2047);
  let next = 0;
  let i0 = 0;
  const out = new Float64Array(series.length);
  for (let n = 0; n < series.length; n++) {
    const i1 = raw(series[n]) >> 2;
    if (i1 > 0 && !(i0 > 0)) {
      next = (next + 1) & 7;
      voices[next] = 64 - Math.trunc((-i0 * 64) / (i1 - i0));
    } else if (i1 < 0 && !(i0 < 0)) {
      next = (next + 1) & 7;
      voices[next] = 64 - Math.trunc((i0 * 64) / (i0 - i1));
    }
    i0 = i1;
    let sum = 0;
    for (let v = 0; v < 8; v++) {
      const t = voices[v];
      sum += (v & 1) ? blepAt(t) : -blepAt(t);
      const advanced = t + 64;
      voices[v] = advanced >= 2047 ? 2047 : advanced;
    }
    sum -= ((((next + 1) & 1) << 1) - 1) << 13;
    out[n] = i32(sum * 8192) / FRAC32_ONE;
  }
  return out;
}

/** `tiar/dist/DPSoftClip` `code.srate` AS WRITTEN — the guard is transcribed
 *  literally so the precedence bug (deviation D6) is in the MODEL too, and
 *  `dpSoftAntialiased` below is the counterfactual it never takes. */
function dpSoftClipInt(x, dialIn, dialOut) {
  const pIn = usat(dialRaw(dialIn), 27);
  const pOut = usat(dialRaw(dialOut), 27);
  const inGain = pIn * (1 / 2 ** 25) * (1 / 2 ** 27);
  const x0 = raw(x) * inGain;
  const outMax = i32(pOut * 2);
  // `if(inlet_in & 0xFFFFF000 != old_in & 0xFFFFF000)` parses as
  // `(inlet_in & (0xFFFFF000 != old_in)) & 0xFFFFF000`, and 0xFFFFF000's low bit
  // is 0, so this is 0 for every possible pair. The branch is unreachable.
  const value = x0 >= 1 ? outMax : (x0 <= -1 ? -outMax : Math.trunc(pOut * (x0 * (3 - x0 * x0))));
  return i32(value) / FRAC32_ONE;
}

/** What `DPSoftClip` WOULD do if its guard were parenthesised — kept here rather
 *  than in the kernel, because it is a counterfactual, and used to put a NUMBER
 *  on what deviation D6 costs. Their `I0 = x²(0.75 − 0.125x²)`, `|x| − 0.375`. */
function dpSoftAntialiased(x0, x1) {
  const integral = (v) => {
    const magnitude = Math.abs(v);
    return magnitude < 1 ? v * v * (0.75 - 0.125 * v * v) : magnitude - 0.375;
  };
  return 2 * (integral(x0) - integral(x1)) / (x0 - x1);
}

/** `tiar/dist/DPHardClip` `code.srate`, in ints. Returns the whole series
 *  because its antialiasing branch depends on the previous sample. */
function dpHardClipInt(series, dialIn, dialOut) {
  const pIn = usat(dialRaw(dialIn), 27);
  const pOut = usat(dialRaw(dialOut), 27);
  const inGain = pIn * (1 / 2 ** 25) * (1 / 2 ** 27);
  const outGain = 2 * pOut;
  const outMax = i32(outGain);
  let x0 = 0;
  let x1 = 0;
  let integral0 = 0;
  let integral1 = 0;
  let oldIn = 0;
  const out = new Float64Array(series.length);
  for (let n = 0; n < series.length; n++) {
    const inlet = raw(series[n]);
    x1 = x0;
    x0 = inlet * inGain;
    integral1 = integral0;
    const magnitude = Math.abs(x0);
    integral0 = magnitude <= 1 ? 0.5 * magnitude * magnitude : magnitude - 0.5;
    let value;
    if ((inlet & 0xfffff000) !== (oldIn & 0xfffff000)) {
      value = Math.trunc(outGain * (integral0 - integral1) / (x0 - x1));
    } else {
      value = x0 >= 1 ? outMax : (x0 <= -1 ? -outMax : Math.trunc(outGain * x0));
    }
    oldIn = inlet;
    out[n] = i32(value) / FRAC32_ONE;
  }
  return out;
}

/** Pure function. A real value as the int32 an Axoloti buffer holds. */
function raw(x) {
  return i32(Math.trunc(x * FRAC32_ONE));
}

// ── THE HARNESS ─────────────────────────────────────────────────────────────

/**
 * Run a shipped kernel through the SAME k-rate bridge the processor uses: one
 * `control()` per AX_BUFSIZE samples, one `sample()` per sample. Getting this
 * wrong here would hide the 8× bug rather than catch it, so it is written once.
 */
function render(kernel, controlsAt, count, audioAt = null, outputIndex = 0) {
  const out = new Float64Array(count);
  const frame = new Float64Array(4);
  const ins = new Float64Array(8);
  for (let n = 0; n < count; n++) {
    const controls = controlsAt(n);
    if (audioAt) audioAt(n, ins);
    if (n % K.AX_BUFSIZE === 0) kernel.control(controls);
    kernel.sample(controls, ins, frame);
    out[n] = frame[outputIndex];
  }
  return out;
}

/** The value at each control tick, which is what an integer model produces. */
const perTick = (series) => Float64Array.from(
  { length: Math.floor(series.length / K.AX_BUFSIZE) },
  (_, t) => series[t * K.AX_BUFSIZE],
);

const maxError = (a, b) => {
  assert.equal(a.length, b.length, "series lengths must match");
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
};

/** The first tick at or past a threshold, in seconds — an envelope's DURATION,
 *  which is what a wrong k-rate bridge changes and a coefficient diff hides. */
const timeToReach = (ticks, level, rising) => {
  for (let t = 0; t < ticks.length; t++) {
    if (rising ? ticks[t] >= level : ticks[t] <= level) return t * TICK;
  }
  return Infinity;
};

const held = () => 1;
const silent = () => 0;

// ── 1. THE UNIT CONVERSIONS ─────────────────────────────────────────────────

check("the pitch law is E4, and the dial→seconds maps are Axoloti's own", () => {
  assert.ok(Math.abs(K.axPitchToHz(0) - 329.6275569) < 1e-6, "pitch 0 is E4");
  assert.ok(Math.abs(K.axPitchToHz(5) - 440) < 1e-9, "pitch 5 is A440");
  // realunits/LinearTimeExp.java: hz = 440*2^((-v+64-69)/12)/32 ; t = 1/hz
  for (const dial of [-64, -32.5, -20, 0, 16, 22, 24, 64]) {
    const theirs = 1 / (440 * Math.pow(2, (-dial + 64 - 69) / 12) / 32);
    assert.ok(Math.abs(K.axTimeDialToSeconds(dial) - theirs) < 1e-15, `LinearTimeExp at ${dial}`);
  }
  // realunits/DecayTime.java: t = ln2 * (1/(64-v)) * (16/48000) * 4096
  for (const dial of [0, 30, 36, 56, 63.5]) {
    const theirs = Math.log(2) * (1 / (64 - dial)) * (16 / 48000) * 4096;
    assert.ok(Math.abs(K.axDecayDialToSeconds(dial) - theirs) < 1e-15, `DecayTime at ${dial}`);
  }
});

check("core/audio_specs_ax4.js's RESTATED conversions match the kernels' (core may not import synth)", () => {
  for (const dial of [-64, -20, 0, 24, 64]) {
    assert.ok(Math.abs(axTimeDialSeconds(dial) - K.axTimeDialToSeconds(dial)) < 1e-15, `time dial ${dial}`);
  }
  for (const dial of [0, 30, 56, 63.5]) {
    assert.ok(Math.abs(axDecayDialSeconds(dial) - K.axDecayDialToSeconds(dial)) < 1e-15, `decay dial ${dial}`);
  }
});

check("D5: the AHD's seconds are their display's approximation, and the cost is bounded", () => {
  let worst = 0;
  for (let dial = 0; dial <= 63.5; dial += 0.5) {
    const rate = (64 - dial) / 4096;
    const trueHalfLife = Math.LN2 / -Math.log(1 - rate) * TICK;
    worst = Math.max(worst, Math.abs(trueHalfLife / K.axDecayDialToSeconds(dial) - 1));
    // …and the round trip through our knob must reproduce THEIR rate exactly.
    assert.ok(Math.abs(K.axDecayRate(K.axDecayDialToSeconds(dial), TICK) - rate) < 1e-15,
      `dial ${dial} must round-trip to its own rate`);
  }
  within("D5 worst label error (fraction)", worst, 0.0079);
});

check("the transcription constants a patch needs are exported and invertible", () => {
  // The harvested patches hold RAW DIALS on these knobs; the lead converts them
  // with these two functions. A round trip that is not exact would silently
  // retune every envelope in the library.
  for (const dial of [-59, -48, -36, -32.5, -30, -25, -20, -16, -15, 1.5, 2, 3, 7, 10, 16, 19, 22, 24, 34, 36.61]) {
    assert.ok(Math.abs(K.axTimeSecondsToDial(K.axTimeDialToSeconds(dial)) - dial) < 1e-9, `round trip ${dial}`);
  }
  assert.equal(K.AX_DIAL_FULL, 64, "the divisor every normalised gain uses");
});

// ── 2. THE ENVELOPES, AGAINST THE INTEGER MODEL ─────────────────────────────

check("ADSR: the whole four-stage series matches env/adsr's ints, and the TIMES do", () => {
  const dials = { a: -20, d: 24, s: 32, r: -30 };
  const seconds = {
    gate: 0, a: K.axTimeDialToSeconds(dials.a), d: K.axTimeDialToSeconds(dials.d),
    s: dials.s / 64, r: K.axTimeDialToSeconds(dials.r),
  };
  const TICKS = 3000;
  const GATE_TICKS = 1500;
  const gateAt = (t) => (t < GATE_TICKS ? 1 : 0);
  const reference = adsrInt(dials, gateAt, TICKS);
  const kernel = new K.AdsrKernel(FS);
  const ours = perTick(render(
    kernel,
    (n) => ({ ...seconds, gate: gateAt(Math.floor(n / K.AX_BUFSIZE)) }),
    TICKS * K.AX_BUFSIZE,
  ));
  within("ADSR max |ours − theirs| over 1 s", maxError(ours, reference), 2e-4);

  // THE MEASUREMENT THAT CATCHES A HOISTED CONTROL BLOCK: an attack that ran
  // once per quantum instead of once per 16 samples would be EIGHT TIMES this.
  const oursAttack = timeToReach(ours, 0.999, true);
  const theirsAttack = timeToReach(reference, 0.999, true);
  console.log(`  ADSR attack: ours ${(oursAttack * 1e3).toFixed(3)} ms, theirs ${(theirsAttack * 1e3).toFixed(3)} ms, knob ${(seconds.a * 1e3).toFixed(3)} ms`);
  within("ADSR attack time error (fraction)", Math.abs(oursAttack / theirsAttack - 1), 0.01);
  assert.ok(Math.abs(oursAttack / seconds.a - 1) < 0.01, "and the knob's number IS the attack time");

  // The decay's 1/e point, which is what a `kdecaytime.exp` dial really names.
  const target = 0.5 + (1 - 0.5) / Math.E;
  const oursDecay = timeToReach(ours.slice(oursAttack / TICK | 0), target, false);
  console.log(`  ADSR decay to 1/e: ours ${(oursDecay * 1e3).toFixed(2)} ms, knob ${(seconds.d * 1e3).toFixed(2)} ms`);
  assert.ok(Math.abs(oursDecay / seconds.d - 1) < 0.02, "the decay knob is the 1/e time constant");
});

check("ADSR: sustain is the level, and release falls from wherever it was", () => {
  const dials = { a: -40, d: -10, s: 24, r: 0 };
  const seconds = {
    a: K.axTimeDialToSeconds(dials.a), d: K.axTimeDialToSeconds(dials.d),
    s: dials.s / 64, r: K.axTimeDialToSeconds(dials.r), gate: 0,
  };
  const TICKS = 4000;
  const gateAt = (t) => (t < 900 ? 1 : 0);
  const ours = perTick(render(
    new K.AdsrKernel(FS),
    (n) => ({ ...seconds, gate: gateAt(Math.floor(n / K.AX_BUFSIZE)) }),
    TICKS * K.AX_BUFSIZE,
  ));
  // 851 decay ticks is 5.2 time constants at this dial, so the exponential is
  // still 0.9% of the way out — an exponential approach never arrives, which is
  // the point of the stage.
  assert.ok(Math.abs(ours[880] - seconds.s) < 6e-3, `settled at ${ours[880]}, sustain is ${seconds.s}`);
  assert.ok(ours[905] < ours[899], "release starts falling immediately");
  assert.ok(ours[3900] < 1e-3, "and gets there");
  within("ADSR sustain/release vs ints", maxError(ours, adsrInt(dials, gateAt, TICKS)), 2e-4);
});

check("AHD: matches env/ahd m's ints, and its knob is a HALF-LIFE", () => {
  const dials = { a: 30, d: 56 };
  const seconds = { a: K.axDecayDialToSeconds(dials.a), d: K.axDecayDialToSeconds(dials.d), gate: 0 };
  const TICKS = 4000;
  const gateAt = (t) => (t < 2000 ? 1 : 0);
  const reference = ahdInt(dials, gateAt, TICKS);
  const ours = perTick(render(
    new K.AhdKernel(FS),
    (n) => ({ ...seconds, gate: gateAt(Math.floor(n / K.AX_BUFSIZE)) }),
    TICKS * K.AX_BUFSIZE,
  ));
  within("AHD max |ours − theirs|", maxError(ours, reference), 5e-3);
  // Half-life: the rise covers half the remaining distance in `a` seconds.
  const halfRise = timeToReach(ours, 0.5, true);
  console.log(`  AHD rise to 0.5: ${(halfRise * 1e3).toFixed(2)} ms, knob ${(seconds.a * 1e3).toFixed(2)} ms`);
  assert.ok(Math.abs(halfRise / seconds.a - 1) < 0.02, "the attack knob is the half-life of the climb");
  const fall = ours.slice(2000);
  const halfFall = timeToReach(fall, fall[0] / 2, false);
  console.log(`  AHD fall to half: ${(halfFall * 1e3).toFixed(2)} ms, knob ${(seconds.d * 1e3).toFixed(2)} ms`);
  assert.ok(Math.abs(halfFall / seconds.d - 1) < 0.02, "and the decay knob is the half-life of the fall");
});

check("AHD: a negative dial is their FASTEST setting, not their slowest", () => {
  // `frac32.u.map.kdecaytime` is UNSIGNED — `__USAT(v,27)` clamps a negative
  // modvalue to 0, which is rate 64/4096. A harvested `a: -50` therefore means
  // 14.8 ms, and reading it as "very slow" would be wrong by two orders.
  assert.equal(usat(dialRaw(-50), 27), 0, "their pfunction clamps it to zero");
  assert.equal(K.axDecayRate(K.axDecayDialToSeconds(0), TICK), 64 / 4096, "which is the fastest rate");
  assert.equal(K.axDecayRate(1e-9, TICK), 64 / 4096, "and ours saturates at the same place");
});

check("Decay envelope: matches env/d's ints, and D4's pitch table is the ONLY gap", () => {
  // THE SPLIT IS THE INTERESTING PART. At a WHOLE-semitone dial their
  // piecewise-linear `pitcht` lookup is exact, so the two must agree to
  // rounding. At a HALF-semitone dial the table interpolates and reads up to
  // 0.72 cents sharp (deviation D4) — a 0.04% rate error, which compounds over
  // a 1.3 s decay into the number reported below. Measuring the two separately
  // is what tells a table artefact apart from a wrong coefficient; one pooled
  // bound would have hidden either.
  const TICKS = 4000;
  const trigAt = (t) => (t === 10 ? 1 : 0);
  const run = (dial) => {
    const seconds = K.axTimeDialToSeconds(dial);
    const ours = perTick(render(
      new K.EnvDecayKernel(FS),
      (n) => ({ trig: trigAt(Math.floor(n / K.AX_BUFSIZE)), d: seconds }),
      TICKS * K.AX_BUFSIZE,
    ));
    assert.equal(ours[10], 1, `dial ${dial}: the trigger tick is exactly full scale`);
    const tau = timeToReach(ours.slice(10), 1 / Math.E, false);
    assert.ok(Math.abs(tau / seconds - 1) < 0.02, `dial ${dial}: 1/e at ${tau}, knob says ${seconds}`);
    return maxError(ours, envDecayInt(dial, trigAt, TICKS));
  };
  let onGrid = 0;
  for (const dial of [-15, 0, 16, 40]) onGrid = Math.max(onGrid, run(dial));
  // ON GRID the residual is the C's own int truncations — `pitcht`'s trunc, the
  // `+1` in `0x7FFFFFFF − …`, and `mtof`'s two SMMULs — each worth ~1e-9 in the
  // coefficient and amplified by 1/(1−c), which is 2900 at the slowest dial.
  within("env/d max |ours − theirs| at WHOLE-semitone dials (their int truncations)", onGrid, 2e-5);
  let offGrid = 0;
  for (const dial of [-32.5, 22.5]) offGrid = Math.max(offGrid, run(dial));
  within("env/d max |ours − theirs| at HALF-semitone dials (D4, their 0.72-cent table)", offGrid, 3e-4);
  assert.ok(offGrid > onGrid * 5, "if these were equal the pitch table would not be the cause and D4 would be wrong");
});

check("Decay envelope: the trigger tick does NOT also decay (their else branch)", () => {
  const seconds = K.axTimeDialToSeconds(-64);   // the fastest possible
  const out = render(
    new K.EnvDecayKernel(FS),
    (n) => ({ trig: n >= K.AX_BUFSIZE && n < 2 * K.AX_BUFSIZE ? 1 : 0, d: seconds }),
    6 * K.AX_BUFSIZE,
  );
  assert.equal(out[K.AX_BUFSIZE], 1, "full scale on the tick that fires");
  assert.ok(out[2 * K.AX_BUFSIZE] < 1, "and only then does it start falling");
  // A HELD trigger must not retrigger — `ntrig` latches until it goes low.
  const heldOut = perTick(render(
    new K.EnvDecayKernel(FS),
    () => ({ trig: 1, d: seconds }),
    40 * K.AX_BUFSIZE,
  ));
  for (let t = 2; t < heldOut.length; t++) assert.ok(heldOut[t] <= heldOut[t - 1], `tick ${t} rose again`);
});

check("Linear decay: matches env/d lin m's ints, and `d` is the WHOLE ramp", () => {
  const TICKS = 2000;
  const trigAt = (t) => (t === 5 ? 1 : 0);
  let worst = 0;
  for (const dial of [-16, 0, 20]) {
    const seconds = K.axTimeDialToSeconds(dial);
    const reference = envDecayLinearInt(dial, trigAt, TICKS);
    const ours = perTick(render(
      new K.EnvDecayLinearKernel(FS),
      (n) => ({ trig: trigAt(Math.floor(n / K.AX_BUFSIZE)), d: seconds }),
      TICKS * K.AX_BUFSIZE,
    ));
    worst = Math.max(worst, maxError(ours, reference));
    const reached = timeToReach(ours.slice(5), 0, false);
    console.log(`  d lin dial ${dial}: zero at ${(reached * 1e3).toFixed(3)} ms, knob ${(seconds * 1e3).toFixed(3)} ms`);
    assert.ok(Math.abs(reached / seconds - 1) < 0.01, `dial ${dial}: the ramp IS the knob's seconds`);
    // A LINE, not a curve: the second difference is zero while it is falling.
    const mid = Math.floor(reached / TICK / 2) + 5;
    const slopeA = ours[mid] - ours[mid - 1];
    const slopeB = ours[mid + 40] - ours[mid + 39];
    assert.ok(Math.abs(slopeA - slopeB) < 1e-12, `dial ${dial}: the fall must be straight`);
  }
  within("env/d lin m max |ours − theirs| (their t>>6 truncation, accumulated over the ramp)", worst, 1e-5);
});

// ── 3. GAIN, MIX AND CROSSFADE ──────────────────────────────────────────────

check("Stereo VCA: the k→s ramp, one buffer late, matches vcaST's ints", () => {
  const COUNT = 8 * K.AX_BUFSIZE;
  const a1 = Float64Array.from({ length: COUNT }, (_, n) => Math.sin(2 * Math.PI * 440 * n / FS));
  const a2 = Float64Array.from({ length: COUNT }, (_, n) => Math.cos(2 * Math.PI * 440 * n / FS));
  const levels = [0, 0, 1, 1, 0.25, 0.25, 0.25, 0.25];
  const reference = vcaStereoInt(a1, a2, levels);
  const kernel = new K.VcaStereoKernel();
  const frame = new Float64Array(2);
  const ins = new Float64Array(2);
  const left = new Float64Array(COUNT);
  const right = new Float64Array(COUNT);
  for (let n = 0; n < COUNT; n++) {
    const controls = { v: levels[Math.floor(n / K.AX_BUFSIZE)] };
    ins[0] = a1[n];
    ins[1] = a2[n];
    if (n % K.AX_BUFSIZE === 0) kernel.control(controls);
    kernel.sample(controls, ins, frame);
    left[n] = frame[0];
    right[n] = frame[1];
  }
  within("vcaST L max |ours − theirs| (their step>>4 floor)", maxError(left, reference.left), 1e-6);
  within("vcaST R max |ours − theirs| (their step>>4 floor)", maxError(right, reference.right), 1e-6);
  // THE ONE-BUFFER LAG IS THE POINT: tick 2 asks for gain 1, and the block that
  // follows it ramps from 0 rather than being at 1.
  assert.ok(Math.abs(left[2 * K.AX_BUFSIZE]) < 1e-12, "the first sample after the step is still at the OLD gain");
  assert.ok(Math.abs(left[3 * K.AX_BUFSIZE - 1] / a1[3 * K.AX_BUFSIZE - 1] - 15 / 16) < 1e-9,
    "and it arrives 15/16 of the way by the end of that block");
});

check("Crossfade: linear, and byte-for-byte on their int64 form", () => {
  let worst = 0;
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    const kernel = new K.XfadeKernel();
    kernel.control({ c });
    const frame = new Float64Array(1);
    for (const [i1, i2] of [[1, -1], [0.5, 0.25], [-0.75, 0.125], [0, 0]]) {
      kernel.sample({ c }, Float64Array.from([i1, i2]), frame);
      worst = Math.max(worst, Math.abs(frame[0] - xfadeInt(i1, i2, c)));
    }
  }
  within("xfade max |ours − theirs|", worst, 2e-8);
  const kernel = new K.XfadeKernel();
  const frame = new Float64Array(1);
  kernel.control({ c: 0.5 });
  kernel.sample({ c: 0.5 }, Float64Array.from([1, 1]), frame);
  assert.ok(Math.abs(frame[0] - 1) < 1e-12, "LINEAR: two correlated inputs hold their level at the midpoint");
});

check("Mixer: gains are dial/64, and the OUTPUT HARD-CLIPS at ±1", () => {
  const kernel = new K.MixKernel();
  const frame = new Float64Array(1);
  const run = (busIn, ins, dials) => {
    const controls = {};
    dials.forEach((d, k) => { controls[`gain${k + 1}`] = d / 64; });
    kernel.control(controls);
    const inFrame = Float64Array.from([busIn, ...ins]);
    kernel.sample(controls, inFrame, frame);
    return frame[0];
  };
  const cases = [
    [0, [0.5, 0, 0, 0, 0, 0], [32, 32, 32, 32, 32, 32]],
    [0.25, [0.5, -0.25, 0.125, 0, 0, 0], [64, 32, 16, 0, 0, 0]],
    [0, [1, 1, 1, 1, 1, 1], [64, 64, 64, 64, 64, 64]],
    [-0.9, [-1, -1, 0, 0, 0, 0], [64, 64, 0, 0, 0, 0]],
  ];
  let worst = 0;
  for (const [busIn, ins, dials] of cases) worst = Math.max(worst, Math.abs(run(busIn, ins, dials) - mixInt(busIn, ins, dials)));
  within("mix max |ours − theirs| (their accum<<5 scales each SMMUL truncation to 2^-22)", worst, 6 * 2 ** -22);
  assert.ok(run(0, [1, 1, 1, 1, 1, 1], [64, 64, 64, 64, 64, 64]) <= 1, "six units of signal must NOT sum to six");
  assert.equal(run(-0.9, [-1, -1, 0, 0, 0, 0], [64, 64, 0, 0, 0, 0]), -1, "and the negative side clips at exactly −1");
  assert.ok(Math.abs(run(0, [0.5, 0, 0, 0, 0, 0], [32, 0, 0, 0, 0, 0]) - 0.25) < 1e-9, "dial 32 is a ratio of 0.5");
  assert.ok(Math.abs(run(0.3, [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]) - 0.3) < 1e-9, "bus_in passes at unity with no gain");
});

// ── 4. THE CLIPPERS ─────────────────────────────────────────────────────────

check("dist/soft: the transfer curve is theirs, measured across the whole range", () => {
  const kernel = new K.DistSoftKernel();
  const frame = new Float64Array(1);
  const ins = new Float64Array(1);
  let worst = 0;
  for (let x = -2; x <= 2; x += 1 / 512) {
    ins[0] = x;
    kernel.sample({}, ins, frame);
    worst = Math.max(worst, Math.abs(frame[0] - distSoftInt(x)));
  }
  // Their `ts>>1` FLOORS a negative odd value, so the C reads one raw step low
  // there and we do not. 2^-27 is −162 dBFS.
  within("dist/soft max |ours − theirs| (their >>1 floor)", worst, 2 / FRAC32_ONE);
  assert.ok(Math.abs(K.softCubic(0.5) - 0.6875) < 1e-15, "1.5·0.5 − 0.5·0.125");
  assert.equal(K.softCubic(3), 1, "flat above unity");
  assert.equal(K.softCubic(-3), -1, "and below it");
});

check("dist/inf: byte-for-byte against their blept dispatch, and it band-limits", () => {
  const COUNT = 2048;
  const series = Float64Array.from({ length: COUNT }, (_, n) => 0.3 * Math.sin(2 * Math.PI * 220 * n / FS));
  const reference = distInfInt(series);
  const kernel = new K.DistInfKernel();
  const ours = render(kernel, () => ({}), COUNT, (n, ins) => { ins[0] = series[n]; });
  within("dist/inf max |ours − theirs|", maxError(ours, reference), 2e-7);
  assert.ok(Math.abs(ours[0] + 0.5) < 1e-12, "their code.init leaves it at −0.5 DC until the first crossing");
  // It really is a square, and its amplitude is ±0.5 — their `out = sum<<13`
  // against a 16384 unit step, which is the same half-scale swing `osc/square`
  // has (AX-2's BLEP_OSC_AMPLITUDE). Measured here rather than assumed, because
  // "infinite gain" reads like it should saturate at ±1 and it does not.
  const settled = ours.slice(400);
  const square = settled.filter((v) => Math.abs(Math.abs(v) - 0.5) < 0.05).length / settled.length;
  console.log(`  dist/inf: ${(square * 100).toFixed(1)}% of settled samples are within 0.05 of ±0.5`);
  assert.ok(square > 0.9, "infinite gain must produce a square, not a shaped sine");
  assert.ok(Math.max(...settled) < 0.75, "and the BLEP's ringing overshoot is bounded, not a clip");
  // The shape does not depend on the input's LEVEL, which is what "infinite" means:
  // tripling the drive may only move where each edge falls inside its sample.
  const loud = render(new K.DistInfKernel(), () => ({}), COUNT,
    (n, ins) => { ins[0] = 0.9 * Math.sin(2 * Math.PI * 220 * n / FS); });
  within("dist/inf level independence (3x drive)", maxError(ours.slice(400), loud.slice(400)), 0.1);
});

check("this file's BLEP_LAST and the 64-per-sample advance match ax2_kernels' table", () => {
  const shape = K.blepShape();
  assert.equal(shape.last, 2047, "firmware BLEPSIZE − 1");
  assert.equal(K.blepStep(shape.last), 1, "a settled voice contributes exactly a full step");
  assert.ok(Number.isNaN(K.blepStep(shape.last + 1)), "…and there is nothing past it");
  assert.equal(shape.subsamples, 64, "their `t += 64`");
  // 64 entries per sample over 2048 entries is 32 samples of impulse response.
  assert.equal(shape.last + 1, shape.subsamples * 32, "2048 = 64 × 32");
});

check("DPHardClip: the DP branch really runs, and matches their ints sample for sample", () => {
  const COUNT = 1024;
  const dialIn = 11;
  const dialOut = 28;
  const series = Float64Array.from({ length: COUNT }, (_, n) => 0.8 * Math.sin(2 * Math.PI * 1000 * n / FS));
  const reference = dpHardClipInt(series, dialIn, dialOut);
  const controls = { ingain: dialIn / 64, outgain: dialOut / 64 };
  const ours = render(new K.DpHardClipKernel(), () => controls, COUNT, (n, ins) => { ins[0] = series[n]; });
  within("DPHardClip max |ours − theirs|", maxError(ours, reference), 2e-7);
  // D7: at InGain 0 their quotient is 0/0. Ours must be silence, not NaN.
  const zeroed = render(new K.DpHardClipKernel(), () => ({ ingain: 0, outgain: 0.5 }), 64,
    (n, ins) => { ins[0] = Math.sin(n); });
  assert.ok(zeroed.every((v) => v === 0), "InGain 0 is silence, and never NaN");
  // The antialiasing must actually engage: a hard clip WITHOUT it is only ever
  // ±peak or a straight line, so a sample strictly between the two proves it.
  const peak = 2 * (dialOut / 64);
  const smeared = ours.filter((v) => Math.abs(v) < peak * 0.999 && Math.abs(v) > peak * 0.5).length;
  console.log(`  DPHardClip: ${smeared} of ${COUNT} samples land inside the corner`);
  assert.ok(smeared > 0, "the DP branch must engage — this is what its sibling's bug removes");
});

check("D6: DPSoftClip's antialiasing NEVER runs, we reproduce that, and here is what it cost", () => {
  const COUNT = 1024;
  const dialIn = 25;
  const dialOut = 15;
  const series = Float64Array.from({ length: COUNT }, (_, n) => 0.9 * Math.sin(2 * Math.PI * 3000 * n / FS));
  const controls = { ingain: dialIn / 64, outgain: dialOut / 64 };
  const ours = render(new K.DpSoftClipKernel(), () => controls, COUNT, (n, ins) => { ins[0] = series[n]; });
  let worst = 0;
  for (let n = 0; n < COUNT; n++) worst = Math.max(worst, Math.abs(ours[n] - dpSoftClipInt(series[n], dialIn, dialOut)));
  within("DPSoftClip max |ours − theirs|", worst, 2e-7);

  // THE GUARD, EVALUATED AS C PARSES IT, for every pair a patch can produce.
  for (const inlet of [0, 1, -1, 4095, 4096, -4096, 0x0ffff000, -0x0ffff000, 134217727]) {
    for (const old of [0, -4096, 4096, 12345]) {
      assert.equal((inlet & (0xfffff000 !== old ? 1 : 0)) & 0xfffff000, 0,
        `their guard must be false for (${inlet}, ${old})`);
    }
  }
  // …and the counterfactual, so D6's cost is a number rather than an opinion.
  const drive = 4 * (dialIn / 64);
  const peak = 2 * (dialOut / 64);
  let costliest = 0;
  for (let n = 1; n < COUNT; n++) {
    const x0 = drive * series[n];
    const x1 = drive * series[n - 1];
    if (x0 === x1) continue;
    costliest = Math.max(costliest, Math.abs(ours[n] - peak * dpSoftAntialiased(x0, x1) / 2));
  }
  console.log(`  D6: the dead branch would have differed by up to ${costliest.toFixed(4)} of full scale at 3 kHz`);
  assert.ok(costliest > 1e-3, "if this were tiny the bug would not matter and D6 would be over-stated");
});

check("D10: the DP clippers' defaults are unity drive and unity peak", () => {
  // Which makes DPSoftClip at its defaults byte-identical to dist/soft — the
  // property that makes 0.25/0.5 the one non-arbitrary default pair.
  const soft = new K.DistSoftKernel();
  const dp = new K.DpSoftClipKernel();
  const controls = { ingain: 0.25, outgain: 0.5 };
  dp.control(controls);
  const a = new Float64Array(1);
  const b = new Float64Array(1);
  const ins = new Float64Array(1);
  let worst = 0;
  for (let x = -2; x <= 2; x += 1 / 256) {
    ins[0] = x;
    soft.sample({}, ins, a);
    dp.sample(controls, ins, b);
    worst = Math.max(worst, Math.abs(a[0] - b[0]));
  }
  within("DP soft at defaults vs dist/soft", worst, 1e-15);
  const spec = BLOCK_SPECS.find((s) => s.type === "audio_ax_dp_soft_clip");
  assert.equal(spec.knobs.find((k) => k.key === "ingain").default, 0.25, "their dial 16");
  assert.equal(spec.knobs.find((k) => k.key === "outgain").default, 0.5, "their dial 32");
});

// ── 5. THE CONTROL-RATE LAW ─────────────────────────────────────────────────

check("the control rate is fs/16 — eight ticks per 128-frame quantum, not one", () => {
  assert.equal(K.AX_BUFSIZE, 16, "Axoloti's BUFSIZE");
  assert.equal(128 / K.AX_BUFSIZE, 8, "eight k-rate ticks per process() call");
  assert.equal(FS / K.AX_BUFSIZE, 3000, "which is exactly 3000 Hz at 48 kHz");
  // BEHAVIOURAL, not structural: a fast decay must be over inside ONE quantum,
  // and a hoisted control block would stretch it across eight.
  const seconds = K.axTimeDialToSeconds(-64);
  const out = render(new K.EnvDecayKernel(FS), (n) => ({ trig: n === 0 ? 1 : 0, d: seconds }), 128);
  const steps = new Set(out).size;
  console.log(`  a 2.4 ms decay shows ${steps} distinct levels in one 128-frame quantum`);
  assert.ok(steps >= 8, `expected 8 staircase steps per quantum; a hoisted control() gives 1`);
  for (let i = 1; i < K.AX_BUFSIZE; i++) assert.equal(out[i], out[0], `sample ${i} must hold tick 0's value`);
  assert.notEqual(out[K.AX_BUFSIZE], out[0], "…and the next tick must differ, or nothing is running");
  // The SHIPPED bridge, not this file's mirror of it.
  assert.match(WORKLET_SOURCE, /this\.tick = \(this\.tick \+ 1\) & \(AX_BUFSIZE - 1\);/,
    "the processor must advance its tick per SAMPLE");
  assert.match(WORKLET_SOURCE, /if \(this\.tick === 0\) this\.kernel\.control\(controls\);/,
    "and call control() inside the sample loop");
});

check("every processor this block ships is registered, once, and only these", () => {
  const names = [...WORKLET_SOURCE.matchAll(/name: "(ax4-[^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length, "no duplicate processor name");
  assert.equal(names.length, AX4_PROCESSORS.length, "one row per name");
  for (const name of names) assert.ok(name.startsWith("ax4-"), `${name} must carry the block prefix`);
  assert.match(WORKLET_SOURCE, /registerProcessor\(entry\.name,/, "registration is derived from the roster");
});

check("the worklet URL is NOT declared in this block (it belongs to worklet_urls.js)", () => {
  // A Vite `?worker&url` specifier anywhere in synth/modules*.js's import graph
  // takes the whole bare-node lane down. This file running at all is half the
  // proof; the grep is the other half.
  const modules = readFileSync(join(here, "../synth/modules_ax4.js"), "utf8");
  const kernels = readFileSync(join(here, "../synth/ax4_kernels.js"), "utf8");
  // A SPECIFIER, not the words: all three files legitimately EXPLAIN the rule in
  // prose, and grepping the bare string made this check fail on its own doctrine.
  const SPECIFIER = /["'][^"']*\?worker&url["']/;
  for (const [label, source] of [["modules_ax4", modules], ["ax4_kernels", kernels], ["processors_ax4", WORKLET_SOURCE]]) {
    assert.ok(!SPECIFIER.test(source), `${label} must not hold a Vite specifier`);
  }
  assert.ok(!modules.includes("BLOCK_WORKLET_URL ="), "and must not export the contract's URL name");
});

// ── 6. THE SPECS, AND THE FOUR PLACES A NODE HAS TO EXIST IN ────────────────

check("every spec has a factory, a processor, a plugin and a worklet-module entry", () => {
  assert.equal(BLOCK_SPECS.length, 11, "eleven ported objects, eleven specs");
  assert.equal(BLOCK_SPECS.length, Object.keys(BLOCK_MODULE_FACTORIES).length, "one factory per spec");
  assert.equal(BLOCK_SPECS.length, AX4_PROCESSORS.length, "one processor per spec");
  assert.equal(BLOCK_SPECS.length, BLOCK_PLUGINS.length, "one plugin per spec");
  assert.ok(Array.isArray(BLOCK_WORKLET_MODULES), "BLOCK_WORKLET_MODULES is an ARRAY, per the contract");
  const pluginTypes = BLOCK_PLUGINS.map((p) => p.type);
  for (const spec of BLOCK_SPECS) {
    assert.ok(spec.type.startsWith("audio_ax_"), `${spec.type} must carry the Axoloti prefix`);
    assert.ok(BLOCK_MODULE_FACTORIES[spec.module], `${spec.type}: no factory named ${spec.module}`);
    assert.ok(BLOCK_WORKLET_MODULES.includes(spec.module), `${spec.type}: not in the init() gate`);
    assert.ok(pluginTypes.includes(spec.type), `${spec.type}: no plugin wrapper`);
    assert.equal(audioNodePlugin(spec).type, spec.type, `${spec.type}: plugin type`);
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type}: family ${spec.family} is not one of ours`);
    assert.ok(spec.title && spec.icon, `${spec.type} is missing chrome`);
    assert.ok(spec.help.length > 40, `${spec.type} needs a help sentence worth reading`);
    assert.ok(spec.outputs.length >= 1, `${spec.type} produces nothing`);
    for (const port of [...spec.inputs, ...spec.outputs]) {
      assert.ok(PORT_TYPE_NAMES.includes(port.type), `${spec.type}.${port.key}: port type ${port.type}`);
    }
    if (spec.readout) assert.ok(spec.knobs.some((k) => k.key === spec.readout), `${spec.type}'s readout names no knob`);
  }
});

check("THE SPEC↔PROCESSOR SWEEP, BOTH DIRECTIONS: every port is real, every param is declared", () => {
  const rows = new Map(AX4_PROCESSORS.map((row) => [row.module, row]));
  for (const spec of BLOCK_SPECS) {
    const row = rows.get(spec.module);
    assert.ok(row, `${spec.type}: no processor row for module ${spec.module}`);
    const params = new Set(row.params.map((p) => p.name));
    const audio = new Set(row.audioInputs);
    for (const knob of spec.knobs) {
      assert.ok(params.has(knob.key), `${spec.type}: knob ${knob.key} is no AudioParam`);
    }
    for (const port of spec.inputs) {
      assert.ok(params.has(port.key) || audio.has(port.key),
        `${spec.type}: input ${port.key} is neither an AudioParam nor a worklet input`);
      // An `audio` PORT may still ride an AudioParam (a gate is a level), but a
      // `number` port must never be a raw worklet input — nothing would read it.
      if (port.type === "number") assert.ok(params.has(port.key), `${spec.type}: number input ${port.key} must be a param`);
    }
    assert.deepEqual(spec.outputs.map((o) => o.key), row.outputs, `${spec.type}: output order must match the worklet's indices`);
    // …and the reverse, which is the direction that catches a forgotten row.
    const declared = new Set(spec.inputs.map((p) => p.key));
    for (const name of [...params, ...audio]) {
      assert.ok(declared.has(name), `${spec.type}: the processor has ${name} and the spec declares no port for it`);
    }
  }
});

check("every knob is inside its own range, has a row, a default and a help", () => {
  for (const spec of BLOCK_SPECS) {
    const defaults = audioKnobDefaults(spec);
    const rows = audioKnobRows(spec);
    assert.equal(rows.length, spec.knobs.length, `${spec.type}: every knob needs an Inspector row`);
    assert.equal(Object.keys(defaults).length, spec.knobs.length, `${spec.type}: every knob needs a default leaf`);
    const params = new Map(AX4_PROCESSORS.find((r) => r.module === spec.module).params.map((p) => [p.name, p]));
    for (const knob of spec.knobs) {
      assert.ok(knob.help && knob.help.length > 20, `${spec.type}.${knob.key}: no help worth reading`);
      assert.ok(knob.default >= knob.min && knob.default <= knob.max,
        `${spec.type}.${knob.key}: default ${knob.default} outside [${knob.min}, ${knob.max}]`);
      // THE KNOB MUST FIT INSIDE THE AudioParam, or modules_ax4's clampParam
      // silently rewrites what the Inspector shows.
      const param = params.get(knob.key);
      assert.ok(knob.min >= param.minValue && knob.max <= param.maxValue,
        `${spec.type}.${knob.key}: knob [${knob.min}, ${knob.max}] escapes the param [${param.minValue}, ${param.maxValue}]`);
    }
  }
});

check("R7-17: every spec carries a derivation record with all four required parts", () => {
  for (const spec of BLOCK_SPECS) {
    const d = spec.derivation;
    assert.ok(d, `${spec.type}: no derivation record`);
    assert.match(d.source, /axoloti-(factory|contrib)/, `${spec.type}: source must name the repo`);
    assert.match(d.source, /@ (tag )?[0-9a-f.]{6,}/, `${spec.type}: source must pin a commit or tag`);
    assert.match(d.block, /code\.(krate|srate|declaration)|firmware\//, `${spec.type}: block must name where the recurrence is`);
    assert.ok(d.recurrence.includes("\n"), `${spec.type}: the recurrence must be written out`);
    assert.ok(Array.isArray(d.deviations) && d.deviations.length > 0, `${spec.type}: deviations must be named`);
  }
});

check("THE DRY GUARD: no AX-4 type or module name collides with a spec from another block", () => {
  // BY IDENTITY, NOT BY NAME — once the lead splices BLOCK_SPECS into
  // AUDIO_SPECS, every one of these types is legitimately already in the shipped
  // list, and comparing strings alone would turn the wiring itself into a red.
  const mine = new Set(BLOCK_SPECS);
  const foreign = AUDIO_SPECS.filter((s) => !mine.has(s));
  const shipped = new Set(foreign.map((s) => s.type));
  const shippedModules = new Set(foreign.map((s) => s.module));
  const seen = new Set();
  for (const spec of BLOCK_SPECS) {
    assert.ok(!shipped.has(spec.type), `${spec.type} is also claimed by a spec from another block`);
    assert.ok(!shippedModules.has(spec.module), `module ${spec.module} is also claimed by another block`);
    assert.ok(!seen.has(spec.type), `${spec.type} declared twice`);
    seen.add(spec.type);
  }
});

check("the gate inputs are `audio` and the trigger inputs are `trigger`, per the C", () => {
  // `env/adsr` and `env/ahd m` read a LEVEL (`bool32.risingfalling`, and ahd has
  // no latch at all); `env/d` and `env/d lin m` latch an EDGE (`bool32.rising`
  // plus `ntrig`). core/nodeflow has no audio->trigger coercion, so this decides
  // what may be wired in — see core/audio_specs_ax4.js's header.
  const portType = (type, key) => BLOCK_SPECS.find((s) => s.type === type).inputs.find((p) => p.key === key).type;
  assert.equal(portType("audio_ax_env_adsr", "gate"), "audio");
  assert.equal(portType("audio_ax_env_ahd", "gate"), "audio");
  assert.equal(portType("audio_ax_env_decay", "trig"), "trigger");
  assert.equal(portType("audio_ax_env_d_lin_m", "trig"), "trigger");
});

console.log(`\nport_ax4_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
