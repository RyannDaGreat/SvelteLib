/**
 * THE AX-3 FILTER PROCESSORS — nine Axoloti filters, ported to float.
 *
 * ── WHY A SECOND WORKLET FILE ───────────────────────────────────────────────
 * synth/worklets/processors.js is the v1 five. This file is the R7-11 PORT set:
 * every processor here is a transcription of a specific Axoloti object, and its
 * derivation record (source object, commit, code block, recurrence, deviations)
 * is in core/audio_specs_ax3.js beside the spec it belongs to. Keeping the ports
 * in their own file means the v1 processors stay readable as "the things native
 * AudioNodes cannot do" rather than becoming a mixed bag, and it means five
 * concurrent porting agents do not all edit one file.
 *
 * ── THE SAME REAL-TIME LAW AS processors.js ─────────────────────────────────
 * `process()` runs on the audio thread every 128 samples. ZERO allocations in the
 * hot path — every delay line is sized in the constructor. No `new`, no literals,
 * no closures. Always `return true`.
 *
 * ── THIS FILE IMPORTS, AND THE BUILD SIDE OF THAT IS MEASURED ──────────────
 * processors.js's header says the AudioWorklet scope "cannot import" and pins two
 * duplicated constants on that basis. THE RUNTIME HALF OF THAT CLAIM IS FALSE on
 * this Chrome — a module worklet takes static imports, measured by AX-2 — and this
 * file relies on it: `../ax3_kernels.js` is the ONE copy of the arithmetic, so
 * tests/port_ax3_test.js can import it in bare node instead of evaluating this file
 * behind a shim. Two implementations of one DSP recurrence is the Tower of Babel
 * failure R7-17 names at its most literal, and duplicating a filter into a file no
 * bare-node test can read is how you get one.
 *
 * ⚠ THE BUILD HALF IS A DIFFERENT QUESTION AND ITS ANSWER IS THE OPPOSITE. Vite's
 * `new URL("./x.js", import.meta.url)` copies the target into the bundle BYTE FOR
 * BYTE: the emitted asset still reads `import { … } from "../ax3_kernels.js"`, the
 * kernel module is never emitted at all, and the import 404s at runtime — while
 * the build exits 0. Under `assetsInlineLimit` it is worse: the worklet becomes a
 * `data:` URL, where a relative specifier has no base to resolve against. So an
 * importing worklet is only safe if its URL goes through Vite's WORKER pipeline
 * (`?worker&url`), which bundles the import in. modules_ax3.js does that and
 * carries the measurement. A worklet that imports and is loaded by the plain
 * `new URL` form is broken in production and green in CI.
 *
 * ── THE ARITHMETIC LAWS THESE PORTS OBEY (R7-11) ────────────────────────────
 * - `frac32` is signed Q27: full scale ±1.0, with ±16.0 of headroom above it.
 *   Every kernel here works in the ±1.0 domain, so the headroom shows up only
 *   where the original SATURATES or WRAPS at int32 — and where it does, so do we.
 * - THE CONTROL RATE IS fs/16, i.e. exactly 3000 Hz on Axoloti's 48 kHz. In a
 *   128-frame quantum that is EIGHT control ticks of sixteen samples each.
 *   Hoisting the coefficient update to once per quantum would run every one of
 *   these filters 8x slow. `kPhase` is what keeps the tick grid continuous across
 *   quanta of any length.
 * - Coefficients are HELD across their sixteen samples, never interpolated. That
 *   is not an omission: Axoloti's krate block runs once and its locals are simply
 *   visible inside the sample loop. The ONE exception is `ax-zdf-svf`, whose
 *   author wrote his own /16 interpolation — and his is deliberately one buffer
 *   LATE, which is reproduced.
 * - Modulation inputs are read at a-rate and SAMPLED at the tick boundary
 *   (`frac32buffer -> frac32` takes sample 0, not an average). A k-rate
 *   AudioParam would deliver one value per 128 samples and silently make the
 *   control rate 375 Hz.
 * - PITCH IS SEMITONES and pitch 0 = MIDI 64 = E4 = 329.6276 Hz. See
 *   core/audio_specs_ax3.js on why these nodes are tuned in semitones rather than
 *   in the hertz the rest of the library uses.
 */

import {
  AX_A440_HZ,
  AX_BIQUAD_BANDPASS,
  AX_BIQUAD_HIGHPASS,
  AX_BIQUAD_LOWPASS,
  AX_BIQUAD_MODES,
  AX_BUFSIZE,
  AX_BUTT10_DEFAULT_FC,
  AX_BUTT10_STAGES,
  AX_BUTT10_STAGE_COUNT,
  AX_DELAY_LINE_MASK,
  AX_DELAY_LINE_SAMPLES,
  AX_DIAL_FULL,
  AX_MIN_DELAY_SAMPLES,
  AX_ONEPOLE_HIGHPASS,
  AX_ONEPOLE_LOWPASS,
  AX_ONEPOLE_MODES,
  AX_PITCH_A440_SEMITONES,
  AX_QINV_MIN,
  AX_SEMITONES_PER_OCTAVE,
  FRAC32_HEADROOM,
  FRAC32_ONE,
  FRAC32_SPAN,
  ZDF_STATE_LIMIT,
  ZDF_TRF_SCALE,
  axBiquadCoefs,
  axCutoffHz,
  axOnePoleAlpha,
  axParamAt,
  axPitchToHz,
  axQinv,
  axSat1,
  axSvfDamp,
  axSvfF,
  axVcf3Coefs,
  axWrapFrac32,
  axZdfQ,
  axZdfUpdate,
} from "../ax3_kernels.js";

// ── THE BIQUAD FAMILY — filter/lp, lp m, bp, bp m, hp, hp m ─────────────────

/**
 * `filter/lp`, `filter/bp`, `filter/hp` and their ` m` modulation variants.
 *
 * Coefficients once per 16-sample tick (`code.krate`), Direct Form 1 per sample
 * (`biquad_dsp`). The state keeps the UNSATURATED output and only the OUTPUT is
 * clipped — that is `biquad_dsp`'s own split and it is why this filter can ring
 * past full scale internally and come back.
 */
class AxBiquadProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitch", defaultValue: 24, minValue: -64, maxValue: 64, automationRate: "a-rate" },
      { name: "reso", defaultValue: 32, minValue: 0, maxValue: AX_DIAL_FULL, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.coefs = new Float64Array(5);
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
    this.mode = AX_BIQUAD_LOWPASS;
    this.kPhase = 0;
    this.port.onmessage = (event) => {
      const wanted = AX_BIQUAD_MODES[event.data && event.data.mode];
      if (wanted === undefined) throw new Error(`ax-biquad: unknown mode ${JSON.stringify(event.data)}`);
      this.mode = wanted;
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const src = input && input.length > 0 ? input[0] : null;
    const dst = output[0];
    const pitch = parameters.pitch;
    const reso = parameters.reso;
    const c = this.coefs;
    for (let i = 0; i < dst.length; i++) {
      if (this.kPhase === 0) {
        axBiquadCoefs(this.mode, axCutoffHz(axParamAt(pitch, i), sampleRate), axParamAt(reso, i), sampleRate, c);
      }
      this.kPhase = (this.kPhase + 1) % AX_BUFSIZE;
      const x = src ? src[i] : 0;
      // THE STATE WRAPS, THE OUTPUT SATURATES, and that split is `biquad_dsp`'s
      // own: `filter_y_n1 = filteroutput` is a bare int32 assignment (so it wraps
      // at +/-16.0) while only `outbuffer[i]` gets `__SSAT(., 28)`. It matters at
      // the very top of the resonance dial, where qinv reaches its one-LSB floor,
      // the poles sit on the unit circle and an on-corner input rings up FOREVER —
      // theirs folds there and an unwrapped float would climb to Infinity and
      // poison the graph. Below +/-16 `axWrapFrac32` returns its argument.
      const y = axWrapFrac32(c[0] * x + c[1] * this.x1 + c[2] * this.x2 - c[3] * this.y1 - c[4] * this.y2);
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      dst[i] = axSat1(y);
    }
    return true;
  }
}
registerProcessor("ax-biquad-processor", AxBiquadProcessor);

// ── filter/vcf3 — THE OLDER BIQUAD, AND A DIFFERENT FILTER ──────────────────

/**
 * `filter/vcf3` — the same 16-sample tick, but the accumulator saturates at the
 * FULL frac32 range (±16.0) and the SATURATED value is what feeds back, where
 * `biquad_dsp` saturates only the output. Both are ported as written.
 */
class AxVcf3Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitch", defaultValue: 24, minValue: -64, maxValue: 64, automationRate: "a-rate" },
      { name: "reso", defaultValue: 32, minValue: 0, maxValue: AX_DIAL_FULL, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.coefs = new Float64Array(4);
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
    this.kPhase = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const src = input && input.length > 0 ? input[0] : null;
    const dst = output[0];
    const pitch = parameters.pitch;
    const reso = parameters.reso;
    const c = this.coefs;
    for (let i = 0; i < dst.length; i++) {
      if (this.kPhase === 0) {
        axVcf3Coefs(axCutoffHz(axParamAt(pitch, i), sampleRate), axParamAt(reso, i), sampleRate, c);
      }
      this.kPhase = (this.kPhase + 1) % AX_BUFSIZE;
      const x = src ? src[i] : 0;
      let y = c[0] * x + c[1] * this.x1 + c[0] * this.x2 - c[2] * this.y1 - c[3] * this.y2;
      y = y > FRAC32_HEADROOM ? FRAC32_HEADROOM : y < -FRAC32_HEADROOM ? -FRAC32_HEADROOM : y;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      dst[i] = y;
    }
    return true;
  }
}
registerProcessor("ax-vcf3-processor", AxVcf3Processor);

// ── filter/lp1, lp1 m, hp1, hp1 m — THE ONE-POLE ────────────────────────────

/** `filter/lp1` and `filter/hp1` (and their ` m` variants — one node, because the
 *  only difference is where the mod inlet is summed). Coefficient per tick, the
 *  recurrence per sample; the highpass is literally `in - val`. */
class AxOnePoleProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "pitch", defaultValue: 24, minValue: -64, maxValue: 64, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    this.val = 0;
    this.alpha = 0;
    this.mode = AX_ONEPOLE_LOWPASS;
    this.kPhase = 0;
    this.port.onmessage = (event) => {
      const wanted = AX_ONEPOLE_MODES[event.data && event.data.mode];
      if (wanted === undefined) throw new Error(`ax-onepole: unknown mode ${JSON.stringify(event.data)}`);
      this.mode = wanted;
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const src = input && input.length > 0 ? input[0] : null;
    const dst = output[0];
    const pitch = parameters.pitch;
    for (let i = 0; i < dst.length; i++) {
      if (this.kPhase === 0) this.alpha = axOnePoleAlpha(axCutoffHz(axParamAt(pitch, i), sampleRate), sampleRate);
      this.kPhase = (this.kPhase + 1) % AX_BUFSIZE;
      const x = src ? src[i] : 0;
      this.val += (x - this.val) * this.alpha;
      dst[i] = this.mode === AX_ONEPOLE_HIGHPASS ? x - this.val : this.val;
    }
    return true;
  }
}
registerProcessor("ax-onepole-processor", AxOnePoleProcessor);

// ── filter/lp svf, bp svf, hp svf, multimode svf m — CHAMBERLIN ─────────────

/**
 * `filter/lp svf`, `bp svf`, `hp svf` and `multimode svf m` as ONE node with the
 * three taps the multimode object already exposes.
 *
 * ⚠ STABILITY IS NOT GUARDED, DELIBERATELY. The original has no `__SSAT` anywhere
 * in this recursion, so at high cutoff with high resonance it does not blow up —
 * its int32 state WRAPS, and the fold is audible as a hard buzz. `axWrapFrac32`
 * reproduces exactly that. A clamp would have been the tidier choice and it would
 * have been a different filter; a bare float would have been neither, because an
 * Infinity here poisons the graph for the rest of the session.
 *
 * The four lines run in the source's order — notch, low, high, band — and that
 * order IS the filter: `high` is computed from the JUST-UPDATED `low`, and `band`
 * from the just-computed `high`.
 */
class AxSvfProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitch", defaultValue: 24, minValue: -128, maxValue: 128, automationRate: "a-rate" },
      { name: "reso", defaultValue: 32, minValue: 0, maxValue: AX_DIAL_FULL, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.low = 0;
    this.band = 0;
    this.damp = 0;
    this.f = 0;
    this.kPhase = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (outputs.length < 3) return true;
    const hpOut = outputs[0][0];
    const bpOut = outputs[1][0];
    const lpOut = outputs[2][0];
    const src = input && input.length > 0 ? input[0] : null;
    const pitch = parameters.pitch;
    const reso = parameters.reso;
    for (let i = 0; i < lpOut.length; i++) {
      if (this.kPhase === 0) {
        this.damp = axSvfDamp(axParamAt(reso, i));
        this.f = axSvfF(axCutoffHz(axParamAt(pitch, i), sampleRate), sampleRate);
      }
      this.kPhase = (this.kPhase + 1) % AX_BUFSIZE;
      const x = src ? src[i] : 0;
      const notch = axWrapFrac32(x - this.damp * this.band);
      this.low = axWrapFrac32(this.low + this.f * this.band);
      const high = axWrapFrac32(notch - this.low);
      this.band = axWrapFrac32(this.f * high + this.band);
      hpOut[i] = high;
      bpOut[i] = this.band;
      lpOut[i] = this.low;
    }
    return true;
  }
}
registerProcessor("ax-svf-processor", AxSvfProcessor);

// ── kfilter/lowpass + tiar/kfilter/LPRiseDecay — THE CONTROL-RATE ONE-POLE ──

/**
 * `kfilter/lowpass` and `tiar/kfilter/LPRiseDecay` as one node: the same one-pole
 * as `filter/lp1`, but run ONCE PER CONTROL TICK and HELD for the sixteen samples
 * between ticks — which is what makes it a smoother for modulation rather than an
 * audio filter. Setting rise and decay equal IS `kfilter/lowpass`; splitting them
 * IS `LPRiseDecay`, whose whole body is a ternary picking which coefficient to use.
 *
 * The staircase is not an artefact to be smoothed away. A k-rate object's output
 * on this platform is a held value, and `frac32buffer -> frac32` takes sample 0 —
 * so the input is read at the tick boundary too.
 */
class AxKFilterLowpassProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rise", defaultValue: -24, minValue: -64, maxValue: 64, automationRate: "a-rate" },
      { name: "decay", defaultValue: -24, minValue: -64, maxValue: 64, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.val = 0;
    this.kPhase = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const src = input && input.length > 0 ? input[0] : null;
    const dst = output[0];
    const rise = parameters.rise;
    const decay = parameters.decay;
    for (let i = 0; i < dst.length; i++) {
      if (this.kPhase === 0) {
        const x = src ? src[i] : 0;
        const pitch = x > this.val ? axParamAt(rise, i) : axParamAt(decay, i);
        this.val += (x - this.val) * axOnePoleAlpha(axCutoffHz(pitch, sampleRate), sampleRate);
      }
      this.kPhase = (this.kPhase + 1) % AX_BUFSIZE;
      dst[i] = this.val;
    }
    return true;
  }
}
registerProcessor("ax-kfilter-lowpass-processor", AxKFilterLowpassProcessor);

// ── filter/allpass + TSG/filter/allpass m — THE SCHROEDER SECTION ───────────

/**
 * `filter/allpass` — the Schroeder allpass section every FDN and diffuser is
 * built from — with `TSG/filter/allpass m`'s modulatable delay folded in.
 *
 * The recurrence recovered from the fixed-point (their delay line stores a
 * half-scaled int16, which is why the source is full of `>>1` and `<<1` that
 * cancel):
 *
 *     v[n] = x[n] + g·v[n-M]
 *     y[n] = v[n-M] - g·v[n]
 *
 * DEVIATIONS, both named in the spec: the line is float32 here rather than int16,
 * so the original's 15-bit quantisation noise inside a reverb tail is absent; and
 * the fractional read interpolates to a delay of exactly M where TSG's own 2-point
 * path lands one sample short of the M it computed.
 */
class AxAllpassProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "delay", defaultValue: 1000, minValue: AX_MIN_DELAY_SAMPLES, maxValue: AX_DELAY_LINE_SAMPLES - 1, automationRate: "a-rate" },
      { name: "g", defaultValue: 0.5, minValue: -1, maxValue: 1, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.line = new Float32Array(AX_DELAY_LINE_SAMPLES);
    this.write = 0;
    this.delay = 0;
    this.g = 0;
    this.kPhase = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const src = input && input.length > 0 ? input[0] : null;
    const dst = output[0];
    const line = this.line;
    for (let i = 0; i < dst.length; i++) {
      if (this.kPhase === 0) {
        const wanted = axParamAt(parameters.delay, i);
        this.delay = wanted < AX_MIN_DELAY_SAMPLES ? AX_MIN_DELAY_SAMPLES
          : wanted > AX_DELAY_LINE_MASK ? AX_DELAY_LINE_MASK : wanted;
        this.g = axParamAt(parameters.g, i);
      }
      this.kPhase = (this.kPhase + 1) % AX_BUFSIZE;
      const whole = Math.floor(this.delay);
      const frac = this.delay - whole;
      const older = line[(this.write - whole) & AX_DELAY_LINE_MASK];
      const newer = line[(this.write - whole + 1) & AX_DELAY_LINE_MASK];
      const vDelayed = newer + (older - newer) * frac;
      // At |g| = 1 the inner comb `v = x + g*v[n-M]` never decays, and their `din`
      // is a bare int32 — so it folds rather than growing. Same wrap, same reason
      // as the biquad's state; a no-op for every musical setting.
      const v = axWrapFrac32((src ? src[i] : 0) + this.g * vDelayed);
      line[this.write] = v;
      this.write = (this.write + 1) & AX_DELAY_LINE_MASK;
      dst[i] = vDelayed - this.g * v;
    }
    return true;
  }
}
registerProcessor("ax-allpass-processor", AxAllpassProcessor);

// ── filter/fdbkcomb ─────────────────────────────────────────────────────────

/**
 * `filter/fdbkcomb` — the feedback comb, the other half of a Schroeder reverb.
 *
 * ⚠ THE B KNOB IS APPLIED AT HALF ITS VALUE AND THEIR DESCRIPTION DOES NOT SAY SO.
 * The object's own `sDescription` reads `y(n) = b*x(n)+a*y(n-D)`, but
 * `___SMMUL(b2, inlet_in)` is a q31 times a frac32 with NO `<<1`, which is a
 * halving, while the feedback term's halving is cancelled by the delay line's
 * `>>15` / `<<16` pair. Recovered recurrence:
 *
 *     y[n] = 0.5·b·x[n] + a·y[n-D]
 *
 * Ported as written, with the help text saying what the label does not — R7-11's
 * ruling on `env/ad` applied to a gain instead of a time.
 */
class AxFdbkCombProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "delay", defaultValue: 1000, minValue: 1, maxValue: AX_DELAY_LINE_SAMPLES - 1, automationRate: "a-rate" },
      { name: "a", defaultValue: 0.5, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      { name: "b", defaultValue: 1, minValue: -1, maxValue: 1, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.line = new Float32Array(AX_DELAY_LINE_SAMPLES);
    this.write = 0;
    this.delay = 0;
    this.a = 0;
    this.b = 0;
    this.kPhase = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const src = input && input.length > 0 ? input[0] : null;
    const dst = output[0];
    const line = this.line;
    for (let i = 0; i < dst.length; i++) {
      if (this.kPhase === 0) {
        const wanted = Math.round(axParamAt(parameters.delay, i));
        this.delay = wanted < 1 ? 1 : wanted > AX_DELAY_LINE_MASK ? AX_DELAY_LINE_MASK : wanted;
        this.a = axParamAt(parameters.a, i);
        this.b = axParamAt(parameters.b, i);
      }
      this.kPhase = (this.kPhase + 1) % AX_BUFSIZE;
      const delayed = line[(this.write - this.delay) & AX_DELAY_LINE_MASK];
      // `a` reaches 1 because theirs does, and at 1 the loop never decays. Their
      // accumulator is an unsaturated int32, so it folds; ours folds identically.
      const y = axWrapFrac32(this.b * (src ? src[i] : 0) / 2 + this.a * delayed);
      line[this.write] = y;
      this.write = (this.write + 1) & AX_DELAY_LINE_MASK;
      dst[i] = y;
    }
    return true;
  }
}
registerProcessor("ax-fdbkcomb-processor", AxFdbkCombProcessor);

// ── tiar/filter/ZDF SVF 1 ───────────────────────────────────────────────────

/**
 * `tiar/filter/ZDF SVF 1` — a zero-delay-feedback SVF with three taps.
 *
 * The `- 7` on his pitch sum is SEVEN RAW frac32 UNITS, i.e. 3.3e-6 of a
 * semitone, and it is not reproduced: our pitch is a float and there is no
 * integer to nudge.
 */
class AxZdfSvfProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitch", defaultValue: 24, minValue: -128, maxValue: 128, automationRate: "a-rate" },
      { name: "Q", defaultValue: 16, minValue: 0, maxValue: AX_DIAL_FULL, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    // a, b, c, na, nb, nc, da, db, dc — one array so the hot loop touches one object.
    this.s = new Float64Array(9);
    this.d = 0;
    this.lp = 0;
    this.bp = 0;
    this.kPhase = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (outputs.length < 3) return true;
    const lpOut = outputs[0][0];
    const hpOut = outputs[1][0];
    const bpOut = outputs[2][0];
    const src = input && input.length > 0 ? input[0] : null;
    const s = this.s;
    for (let i = 0; i < lpOut.length; i++) {
      if (this.kPhase === 0) {
        const q = axZdfQ(axParamAt(parameters.Q, i));
        const fc = axCutoffHz(axParamAt(parameters.pitch, i), sampleRate);
        this.d = 1 / (2 * q);
        axZdfUpdate(this.d, ZDF_TRF_SCALE * 2 * Math.PI * fc / (sampleRate * sampleRate), s);
        this.bp = this.bp > ZDF_STATE_LIMIT ? ZDF_STATE_LIMIT : this.bp < -ZDF_STATE_LIMIT ? -ZDF_STATE_LIMIT : this.bp;
        this.lp = this.lp > ZDF_STATE_LIMIT ? ZDF_STATE_LIMIT : this.lp < -ZDF_STATE_LIMIT ? -ZDF_STATE_LIMIT : this.lp;
      }
      this.kPhase = (this.kPhase + 1) % AX_BUFSIZE;
      s[0] += s[6];
      s[1] += s[7];
      s[2] += s[8];
      const x = src ? src[i] : 0;
      const xLp = x - this.lp;
      this.lp += s[0] * xLp + s[1] * this.bp;
      lpOut[i] = this.lp;
      hpOut[i] = x - this.d * this.bp - this.lp;
      this.bp = s[1] * xLp + s[2] * this.bp;
      bpOut[i] = this.bp;
    }
    return true;
  }
}
registerProcessor("ax-zdf-svf-processor", AxZdfSvfProcessor);

// ── tiar/filter/Butt10 ──────────────────────────────────────────────────────

/** `tiar/filter/Butt10`. No control-rate work at all: the coefficients are a
 *  construct-time table, so this is five Direct Form 1 biquads in series and
 *  nothing else. His `calc()` has no output saturation and neither does this. */
class AxButterworth10Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stages = AX_BUTT10_STAGES[AX_BUTT10_DEFAULT_FC];
    // Five stages x (x1, x2, y1, y2), flat so the loop indexes arithmetic.
    this.state = new Float64Array(AX_BUTT10_STAGE_COUNT * 4);
    this.port.onmessage = (event) => {
      const wanted = AX_BUTT10_STAGES[event.data && event.data.fc];
      if (!wanted) throw new Error(`ax-butterworth10: unknown cutoff ${JSON.stringify(event.data)}`);
      this.stages = wanted;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const src = input && input.length > 0 ? input[0] : null;
    const dst = output[0];
    const st = this.state;
    const stages = this.stages;
    for (let i = 0; i < dst.length; i++) dst[i] = src ? src[i] : 0;
    for (let s = 0; s < AX_BUTT10_STAGE_COUNT; s++) {
      const b0 = stages[s][0];
      const a1 = stages[s][1];
      const b1 = 2 * b0;
      const a2 = 1 - 2 * b1 - a1;
      const base = s * 4;
      let x1 = st[base];
      let x2 = st[base + 1];
      let y1 = st[base + 2];
      let y2 = st[base + 3];
      for (let i = 0; i < dst.length; i++) {
        const x = dst[i];
        const y = b0 * (x + x2) + b1 * x1 + a1 * y1 + a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        dst[i] = y;
      }
      st[base] = x1;
      st[base + 1] = x2;
      st[base + 2] = y1;
      st[base + 3] = y2;
    }
    return true;
  }
}
registerProcessor("ax-butterworth10-processor", AxButterworth10Processor);
