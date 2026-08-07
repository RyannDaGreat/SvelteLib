/**
 * AX-1 AUDIOWORKLET PROCESSORS — the ported Axoloti arithmetic, logic and step tables.
 *
 * A SECOND worklet module alongside `processors.js`, not an edit to it: R7-17 has 23
 * agents landing nodes at once and one worklet file would be 23 writers on one
 * conflict surface. Every processor here registers under an `ax1-` prefix, because
 * `registerProcessor` names are global to the AudioContext and several blocks are
 * adding files like this one.
 *
 * ── ⚠ THE K-RATE BRIDGE IS THE WHOLE REASON THESE ARE HAND-WRITTEN LOOPS ────
 * Axoloti is 48 kHz with `BUFSIZE 16`, so its control rate is EXACTLY 3000 Hz. A
 * 128-frame AudioWorklet quantum is therefore **8 control ticks, each followed by 16
 * samples** — and `axKrateLoop` below is that structure, spelled once.
 *
 * HOISTING THE CONTROL WORK TO ONCE PER QUANTUM IS THE OBVIOUS OPTIMISATION AND IT IS
 * WRONG BY A FACTOR OF EIGHT. Every counter, every edge detector, every smoothing
 * coefficient in this file would run 8× slow, and nothing would throw: a sequencer
 * would simply play at an eighth of its tempo and a glide would take eight times as
 * long, which reads as "the port sounds sluggish" rather than as a bug.
 *
 * This is also why every parameter here is declared **a-rate**. A k-rate AudioParam
 * gives ONE value per 128-frame quantum, which is the 8× error baked into the API; an
 * a-rate param gives 128 and we sample it at each sub-block boundary, which is
 * exactly what "a control value held across 16 samples" means.
 *
 * ── REAL-TIME SAFETY (`processors.js`'s checklist, followed the same way) ────
 * `process()` runs on the audio thread. ZERO allocations in the hot path: every
 * buffer and every piece of state is created in the constructor, no `new`, no array
 * literals, no closures, no string building. Always `return true`.
 *
 * ── WHY THE RECURRENCES ARE RESTATED FROM synth/ax1_dsp.js ──────────────────
 * The AudioWorklet global scope cannot import. `processors.js` already carries this
 * duplication for SCHMITT_LOW / SCHMITT_HIGH, with a test asserting the two files
 * agree so it cannot silently drift; this file follows that precedent, and
 * tests/port_ax1_test.js is where ours is pinned. ax1_dsp.js is the readable,
 * doctested, MEASURED statement of each recurrence — read it first; this file is the
 * same arithmetic written for a hot loop.
 *
 * This file is loaded by `audioWorklet.addModule()` and is NOT an ES module in the
 * normal sense: `sampleRate`, `AudioWorkletProcessor` and `registerProcessor` are
 * ambient, and it must not import anything.
 */

/** Restated from synth/ax1_dsp.AX_KRATE_BLOCK — Axoloti's `#define BUFSIZE 16`, and
 *  the reason its control rate is 3000 Hz rather than something round. */
const AX_KRATE_BLOCK = 16;

/** Restated from synth/ax1_dsp.AX_DIAL_FULL_SCALE. `frac32 → int32` is `>>21`, so a
 *  full-scale 1.0 on a wire arrives at an integer inlet as 64. Every step index and
 *  every selector in this file is read through this. */
const AX_DIAL_FULL_SCALE = 64;

/** Restated from synth/ax1_dsp.AX_DECODE_WIDTH. */
const AX_DECODE_WIDTH = 8;
/** Restated from synth/ax1_dsp.AX_STEP_COUNT. */
const AX_STEP_COUNT = 16;
/** How many tracks `audio_ax_steps_bool` carries — their `sel b 16 4t`. */
const AX_STEP_TRACKS = 4;
/** How many rows `audio_ax_steps_multi` carries — their `sel 4l 16 8t s`. */
const AX_MULTI_ROWS = 8;
/** How many inputs `audio_ax_mux` carries — their `mux 8`. */
const AX_MUX_WIDTH = 8;
/** How many breakpoints the `u4u` shaper has: four segments, five points. */
const AX_SHAPER_POINTS = 5;

/**
 * Read an a-rate parameter at a sub-block boundary. Web Audio COLLAPSES a param that
 * did not change across the quantum to a length-1 array, so indexing it directly
 * would read `undefined` on every tick but the first — a silent NaN, which in an
 * audio graph means the node goes quiet and stays quiet with nothing logged.
 *
 * @param {Float32Array} values - one AudioParam's samples for this quantum
 * @param {number} index - the sample index of the control tick
 * @returns {number}
 */
function axParamAt(values, index) {
  return values.length === 1 ? values[0] : values[index];
}

/** Read an input channel, tolerating a disconnected port (`process` is still called). */
function axInputAt(input, index) {
  if (!input || input.length === 0) return 0;
  const channel = input[0];
  return channel.length === 1 ? channel[0] : channel[index];
}

/** Clamp to frac32's nominal ±1.0 — the float form of `__SSAT(x,28)`. */
function axSat1(x) {
  return x < -1 ? -1 : (x > 1 ? 1 : x);
}

/** Write one value across a whole 16-sample control block of every output channel.
 *  Control-rate outputs are HELD across the block, never interpolated — that is
 *  Axoloti's rule, and interpolating would smear an edge detector's one-tick pulse. */
function axHold(output, start, value) {
  for (let c = 0; c < output.length; c++) {
    const channel = output[c];
    const end = Math.min(start + AX_KRATE_BLOCK, channel.length);
    for (let i = start; i < end; i++) channel[i] = value;
  }
}

// ─── math/op ────────────────────────────────────────────────────────────────

/**
 * `audio_ax_math` — Axoloti's arithmetic shelf. See synth/ax1_dsp.AX_MATH_OPS for
 * each operation's source object, its integer form and its measured error.
 *
 * `a` is treated at SAMPLE rate (their frac32buffer overloads' `<code.srate>` is
 * byte-identical to the k-rate one, so per-sample application is the faithful
 * reading), while `b` is a control value held across each 16-sample block.
 */
class Ax1MathProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "b", defaultValue: 1, minValue: -16, maxValue: 16, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    // The operation is DISCRETE, so it is a message rather than an AudioParam —
    // the same choice quantize's scale table makes in processors.js.
    this.operation = "multiply";
    // `ringModAntialiased` needs the previous sample of both inputs. Pre-allocated
    // whether or not that operation is selected: allocating on a knob change would
    // put a `new` on the audio thread the first time someone turned it.
    this.x1 = 0;
    this.y1 = 0;
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.operation === "string") this.operation = event.data.operation;
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const op = this.operation;
    const bValues = parameters.b;

    for (let i = 0; i < frames; i++) {
      const a = axInputAt(input, i);
      // b is held across its control block: sample it at the block boundary only.
      const b = axParamAt(bValues, i - (i % AX_KRATE_BLOCK));
      let value;
      switch (op) {
        case "add": value = a + b; break;
        case "subtract": value = a - b; break;
        case "multiply": value = a * b; break;
        case "ringModAntialiased":
          // `tiar/math/DP STAR.axo` <code.srate>: the product AVERAGED over the sample
          // interval rather than sampled at its start. Costs one sample of delay and
          // is what stops a hard ring mod folding aliases down.
          value = (a * (2 * b + this.y1) + this.x1 * (b + 2 * this.y1)) / 6;
          this.x1 = a;
          this.y1 = b;
          break;
        case "addDialUnit": value = a + 1 / AX_DIAL_FULL_SCALE; break;
        case "absolute": value = a > 0 ? a : -a; break;
        case "negate": value = -a; break;
        case "maximum": value = a > b ? a : b; break;
        // bool32 → frac32 is +1.0, not +1/64. A comparator at 1/64 is inaudible.
        case "greaterThan": value = a > b ? 1 : 0; break;
        case "divide2": value = a / 2; break;
        case "divide4": value = a / 4; break;
        case "divide32": value = a / 32; break;
        // The saturating multipliers clamp the INPUT and then multiply, so the knee
        // is at ±1/N and the ceiling at ±1.0 — not a multiply followed by a clip.
        case "satMultiply2": value = 2 * (a < -0.5 ? -0.5 : (a > 0.5 ? 0.5 : a)); break;
        case "satMultiply4": value = 4 * (a < -0.25 ? -0.25 : (a > 0.25 ? 0.25 : a)); break;
        case "satMultiply8": value = 8 * (a < -0.125 ? -0.125 : (a > 0.125 ? 0.125 : a)); break;
        case "satMultiply16": value = 16 * (a < -0.0625 ? -0.0625 : (a > 0.0625 ? 0.0625 : a)); break;
        case "saturate": value = axSat1(a); break;
        case "attenuate": value = a * b; break;
        case "gain16": value = axSat1(axSat1(a) * b); break;
        // NO SILENT FALLBACK: an unknown operation would otherwise emit silence, or
        // worse the previous op, with nothing to say which. Zeroing the buffer and
        // posting once is the loudest thing a real-time thread may safely do.
        default:
          value = 0;
          if (!this.reportedUnknown) {
            this.reportedUnknown = true;
            this.port.postMessage({ error: `ax1-math: unknown operation ${op}` });
          }
      }
      for (let c = 0; c < output.length; c++) output[c][i] = value;
    }
    return true;
  }
}

// ─── math/smooth ────────────────────────────────────────────────────────────

/**
 * `audio_ax_smooth` — `math/smooth` and `math/glide`, which differ only by the
 * `enable` gate. One pole per CONTROL TICK, so the coefficient is spent 3000 times a
 * second and not 375 — see the k-rate note at the top of this file.
 */
class Ax1SmoothProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "time", defaultValue: 32, minValue: 0, maxValue: 64, automationRate: "a-rate" },
      { name: "enable", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.value = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const target = axInputAt(input, start);
      const enable = axParamAt(parameters.enable, start);
      if (enable > 0) {
        // (64 − dial)/4096 per tick. At dial 64 this is exactly 0 and the value
        // FREEZES — their behaviour, and the knob is backwards from its name.
        const coefficient = (64 - axParamAt(parameters.time, start)) / 4096;
        this.value += (target - this.value) * coefficient;
      } else {
        this.value = target;
      }
      axHold(output, start, this.value);
    }
    return true;
  }
}

// ─── math/window ────────────────────────────────────────────────────────────

/** `audio_ax_window` — the Hann window a granular voice is multiplied by. Sample
 *  rate, because a grain envelope stepping 3000 times a second would buzz; their
 *  object has a `frac32buffer` overload for exactly this reason. */
class Ax1WindowProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      const phase = axInputAt(input, i);
      // Exact cosine rather than their 1024-point int16 table. Measured difference
      // 3.0e-5, which is THEIR truncation, not ours (tests/port_ax1_test.js).
      const value = 0.5 - 0.5 * Math.cos(2 * Math.PI * (phase - Math.floor(phase)));
      for (let c = 0; c < output.length; c++) output[c][i] = value;
    }
    return true;
  }
}

// ─── math/divrem ────────────────────────────────────────────────────────────

/**
 * `audio_ax_divrem` — integer divide with the remainder alongside it. TWO outputs.
 * Their off-by-one at exact negative multiples is reproduced deliberately; see
 * synth/ax1_dsp.axDivRem for the reasoning and the test that pins its shape.
 */
class Ax1DivRemProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "denominator", defaultValue: 4, minValue: 1, maxValue: 128, automationRate: "a-rate" }];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const [divOut, remOut] = outputs;
    if (!divOut || divOut.length === 0) return true;
    const frames = divOut[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      // frac32 → int32 is `>>21`, so a full-scale wire is the integer 64.
      const a = Math.floor(axInputAt(input, start) * AX_DIAL_FULL_SCALE);
      const denominator = Math.max(1, Math.round(axParamAt(parameters.denominator, start)));
      const div = a >= 0
        ? Math.trunc(a / denominator)
        : -Math.trunc((denominator - a) / denominator);
      // Back onto the wire in the same units they arrived in.
      axHold(divOut, start, div / AX_DIAL_FULL_SCALE);
      axHold(remOut, start, (a - div * denominator) / AX_DIAL_FULL_SCALE);
    }
    return true;
  }
}

// ─── math/shaper-k ──────────────────────────────────────────────────────────

/** `audio_ax_shaper` — Smashed Transistors' `u4u`, a five-point transfer function
 *  over four equal segments. Control rate, as the source is (`kfunc`). */
class Ax1ShaperProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const descriptors = [];
    for (let i = 0; i < AX_SHAPER_POINTS; i++) {
      descriptors.push({
        name: `p${i}`,
        defaultValue: i / (AX_SHAPER_POINTS - 1),
        minValue: 0,
        maxValue: 1,
        automationRate: "a-rate",
      });
    }
    return descriptors;
  }

  constructor() {
    super();
    // Pre-allocated: reading the five breakpoints into an array per tick would
    // allocate on the audio thread 3000 times a second.
    this.points = new Float32Array(AX_SHAPER_POINTS);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      for (let p = 0; p < AX_SHAPER_POINTS; p++) {
        this.points[p] = axParamAt(parameters[`p${p}`], start);
      }
      const value = axInputAt(input, start);
      let shaped;
      if (value >= 1) shaped = this.points[AX_SHAPER_POINTS - 1];
      else if (value <= 0) shaped = this.points[0];
      else {
        const scaled = value * 4;
        const segment = Math.floor(scaled);
        const fraction = scaled - segment;
        shaped = this.points[segment] + (this.points[segment + 1] - this.points[segment]) * fraction;
      }
      axHold(output, start, shaped);
    }
    return true;
  }
}

// ─── conv/convert ───────────────────────────────────────────────────────────

/**
 * `audio_ax_convert` — the two range maps, plus `conv/interp`'s k→s ramp.
 *
 * The ramp is ONE CONTROL BLOCK LATE and stays late: it runs FROM the previous
 * block's value, so a new value is reached only at the END of the block it arrived
 * in. `gain/vca` carries the identical ramp, and ported patches are tuned against
 * the pair — "fixing" the lag here would desynchronise them.
 */
class Ax1ConvertProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = "bipolarToUnipolar";
    this.previous = 0;
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.mode === "string") this.mode = event.data.mode;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;

    if (this.mode === "smoothStep") {
      for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
        const target = axInputAt(input, start);
        let ramped = this.previous;
        const step = (target - this.previous) / AX_KRATE_BLOCK;
        this.previous = target;
        const end = Math.min(start + AX_KRATE_BLOCK, frames);
        for (let i = start; i < end; i++) {
          for (let c = 0; c < output.length; c++) output[c][i] = ramped;
          ramped += step;
        }
      }
      return true;
    }

    const toUnipolar = this.mode === "bipolarToUnipolar";
    for (let i = 0; i < frames; i++) {
      const value = axInputAt(input, i);
      const converted = toUnipolar ? value / 2 + 0.5 : (value - 0.5) * 2;
      for (let c = 0; c < output.length; c++) output[c][i] = converted;
    }
    return true;
  }
}

// ─── logic/op ───────────────────────────────────────────────────────────────

/**
 * `audio_ax_logic` — AND, NOT and the two edge detectors. Control rate, because an
 * edge detector's pulse IS one control tick wide and running it per sample would
 * make it 16× narrower than every patch that reads it expects.
 */
class Ax1LogicProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "b", defaultValue: 0, minValue: -16, maxValue: 16, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    this.operation = "rising";
    this.previousHigh = false; // `rising`'s `_in`
    this.latchedValue = 0; // `change`'s `pval`
    this.interlock = false; // `change`'s `ptrig`
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.operation === "string") this.operation = event.data.operation;
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const a = axInputAt(input, start);
      let value;
      switch (this.operation) {
        // Their `and` tests C truthiness on the raw word (NON-ZERO), while `invert`
        // tests `> 0`. The two disagree on a negative input; the inconsistency is
        // Axoloti's and is kept, because a patch may depend on either.
        case "and": value = a !== 0 && axParamAt(parameters.b, start) !== 0 ? 1 : 0; break;
        case "invert": value = a > 0 ? 0 : 1; break;
        case "change":
          if (this.latchedValue !== a && !this.interlock) {
            this.latchedValue = a;
            this.interlock = true;
            value = 1;
          } else {
            this.interlock = false;
            value = 0;
          }
          break;
        case "rising": {
          const high = a > 0;
          value = high && !this.previousHigh ? 1 : 0;
          this.previousHigh = high;
          break;
        }
        default:
          value = 0;
          if (!this.reportedUnknown) {
            this.reportedUnknown = true;
            this.port.postMessage({ error: `ax1-logic: unknown operation ${this.operation}` });
          }
      }
      // bool32 → frac32 is +1.0: a firing logic output is FULL SCALE.
      axHold(output, start, value);
    }
    return true;
  }
}

// ─── logic/counter ──────────────────────────────────────────────────────────

/** `audio_ax_counter` — cyclic up-counter with an independent reset. Input 0 is the
 *  count trigger, input 1 the reset; output 0 the count, output 1 the carry. */
class Ax1CounterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "maximum", defaultValue: 16, minValue: 0, maxValue: 65536, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    this.count = 0;
    this.ntrig = false;
    this.rtrig = false;
  }

  process(inputs, outputs, parameters) {
    const [trigIn, resetIn] = inputs;
    const [countOut, carryOut] = outputs;
    if (!countOut || countOut.length === 0) return true;
    const frames = countOut[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const trig = axInputAt(trigIn, start);
      const reset = axInputAt(resetIn, start);
      const maximum = Math.max(1, Math.round(axParamAt(parameters.maximum, start)));
      let carry = 0;
      if (trig > 0 && !this.ntrig) {
        this.count += 1;
        if (this.count >= maximum) { this.count = 0; carry = 1; }
        this.ntrig = true;
      } else if (!(trig > 0)) {
        this.ntrig = false;
      }
      if (reset > 0 && !this.rtrig) { this.count = 0; this.rtrig = true; }
      else if (!(reset > 0)) { this.rtrig = false; }
      // The count is an int32 outlet there, so it leaves on the wire in the units
      // `frac32 → int32` reads back: full scale is 64.
      axHold(countOut, start, this.count / AX_DIAL_FULL_SCALE);
      axHold(carryOut, start, carry);
    }
    return true;
  }
}

// ─── logic/latch ────────────────────────────────────────────────────────────

/** `audio_ax_latch` — sample on a rising edge, hold otherwise. Input 0 the signal,
 *  input 1 the trigger. NO Schmitt hysteresis, unlike PowerRP's own Sample & Hold —
 *  that difference is the reason this is a second node and not a rename. */
class Ax1LatchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.latched = 0;
    this.ntrig = false;
  }

  process(inputs, outputs) {
    const [signalIn, trigIn] = inputs;
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const trig = axInputAt(trigIn, start);
      if (trig > 0 && !this.ntrig) { this.latched = axInputAt(signalIn, start); this.ntrig = true; }
      if (!(trig > 0)) this.ntrig = false;
      axHold(output, start, this.latched);
    }
    return true;
  }
}

// ─── logic/decode ───────────────────────────────────────────────────────────

/** `audio_ax_decode` — one-hot decode into eight gates plus a chain outlet, so two
 *  of these side by side cover sixteen values without either knowing the other is
 *  there. Nine outputs. */
class Ax1DecodeProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    if (!outputs[0] || outputs[0].length === 0) return true;
    const frames = outputs[0][0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const value = Math.floor(axInputAt(input, start) * AX_DIAL_FULL_SCALE);
      for (let k = 0; k < AX_DECODE_WIDTH; k++) {
        axHold(outputs[k], start, value === k ? 1 : 0);
      }
      axHold(outputs[AX_DECODE_WIDTH], start, (value - AX_DECODE_WIDTH) / AX_DIAL_FULL_SCALE);
    }
    return true;
  }
}

// ─── mux/mux ────────────────────────────────────────────────────────────────

/**
 * `audio_ax_mux` — eight inputs, one selector. Per SAMPLE on the chosen input (their
 * frac32buffer overload is byte-identical), with the selector held per control block.
 * A selector past the end CLAMPS TO THE LAST INPUT — their `default:` branch — rather
 * than going silent, and a patch that oversteps relies on that.
 */
class Ax1MuxProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "select", defaultValue: 0, minValue: 0, maxValue: AX_MUX_WIDTH - 1, automationRate: "a-rate" }];
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const raw = Math.floor(axParamAt(parameters.select, start));
      const chosen = raw < 0 ? 0 : (raw >= AX_MUX_WIDTH ? AX_MUX_WIDTH - 1 : raw);
      const source = inputs[chosen];
      const end = Math.min(start + AX_KRATE_BLOCK, frames);
      for (let i = start; i < end; i++) {
        const value = axInputAt(source, i);
        for (let c = 0; c < output.length; c++) output[c][i] = value;
      }
    }
    return true;
  }
}

// ─── sel/steps-bool ─────────────────────────────────────────────────────────

/**
 * `audio_ax_steps_bool` — four parallel 16-step gate patterns read by one index.
 * Input 0 the index, input 1 the `def` fallback. Outputs 0…3 the tracks, output 4 the
 * chain.
 *
 * `pulse` fires a track only on the tick the INDEX CHANGED, which is what makes a
 * held index emit one hit per step instead of a continuous high — the single clause
 * that separates their `sel b 16` from their `sel b 16 pulse`.
 */
class Ax1StepsBoolProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const descriptors = [{ name: "pulse", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "a-rate" }];
    for (let t = 1; t <= AX_STEP_TRACKS; t++) {
      descriptors.push({ name: `p${t}`, defaultValue: 0, minValue: 0, maxValue: 65535, automationRate: "a-rate" });
    }
    return descriptors;
  }

  constructor() {
    super();
    // Their `in_prev`, initialised to their own <code.init> value.
    this.previousIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const [indexIn, defaultIn] = inputs;
    if (!outputs[0] || outputs[0].length === 0) return true;
    const frames = outputs[0][0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const index = Math.floor(axInputAt(indexIn, start) * AX_DIAL_FULL_SCALE);
      const fallback = axInputAt(defaultIn, start);
      const pulse = axParamAt(parameters.pulse, start) > 0;
      const inRange = index >= 0 && index < AX_STEP_COUNT;
      const changed = this.previousIndex !== index;
      for (let t = 0; t < AX_STEP_TRACKS; t++) {
        let value;
        if (!inRange) value = fallback;
        else {
          const mask = Math.round(axParamAt(parameters[`p${t + 1}`], start));
          const set = (mask & (1 << index)) !== 0;
          value = set && (!pulse || changed) ? 1 : 0;
        }
        axHold(outputs[t], start, value);
      }
      axHold(outputs[AX_STEP_TRACKS], start, (index - AX_STEP_COUNT) / AX_DIAL_FULL_SCALE);
      this.previousIndex = index;
    }
    return true;
  }
}

// ─── sel/steps-value ────────────────────────────────────────────────────────

/** `audio_ax_steps_value` — sixteen stored values read by one index, with the `def`
 *  inlet as the out-of-range branch and a chain outlet so tables cascade. */
class Ax1StepsValueProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const descriptors = [];
    for (let s = 0; s < AX_STEP_COUNT; s++) {
      descriptors.push({ name: `v${s}`, defaultValue: 0, minValue: -16, maxValue: 16, automationRate: "a-rate" });
    }
    return descriptors;
  }

  process(inputs, outputs, parameters) {
    const [indexIn, defaultIn] = inputs;
    const [valueOut, chainOut] = outputs;
    if (!valueOut || valueOut.length === 0) return true;
    const frames = valueOut[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const index = Math.floor(axInputAt(indexIn, start) * AX_DIAL_FULL_SCALE);
      const value = index >= 0 && index < AX_STEP_COUNT
        ? axParamAt(parameters[`v${index}`], start)
        : axInputAt(defaultIn, start);
      axHold(valueOut, start, value);
      axHold(chainOut, start, (index - AX_STEP_COUNT) / AX_DIAL_FULL_SCALE);
    }
    return true;
  }
}

// ─── sel/steps-multi ────────────────────────────────────────────────────────

/** `audio_ax_steps_multi` — eight rows of sixteen four-level steps, packed two bits
 *  per step into one 32-bit word each. The accent lane of a 303-style sequencer. */
class Ax1StepsMultiProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const descriptors = [{ name: "row", defaultValue: 0, minValue: 0, maxValue: AX_MULTI_ROWS - 1, automationRate: "a-rate" }];
    for (let r = 0; r < AX_MULTI_ROWS; r++) {
      descriptors.push({ name: `t${r}`, defaultValue: 0, minValue: 0, maxValue: 4294967295, automationRate: "a-rate" });
    }
    return descriptors;
  }

  process(inputs, outputs, parameters) {
    const [indexIn, defaultIn] = inputs;
    const [levelOut, chainOut, chainRowOut] = outputs;
    if (!levelOut || levelOut.length === 0) return true;
    const frames = levelOut[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const index = Math.floor(axInputAt(indexIn, start) * AX_DIAL_FULL_SCALE);
      const row = Math.floor(axParamAt(parameters.row, start));
      const inRange = index >= 0 && index < AX_STEP_COUNT && row >= 0 && row < AX_MULTI_ROWS;
      let level;
      if (inRange) {
        const word = axParamAt(parameters[`t${row}`], start) >>> 0;
        level = (word >>> (index * 2)) & 3;
      } else {
        level = axInputAt(defaultIn, start) * AX_DIAL_FULL_SCALE;
      }
      // The level is an int32 0…3 there; back onto the wire in the same units.
      axHold(levelOut, start, level / AX_DIAL_FULL_SCALE);
      axHold(chainOut, start, (index - AX_STEP_COUNT) / AX_DIAL_FULL_SCALE);
      axHold(chainRowOut, start, (row - AX_MULTI_ROWS) / AX_DIAL_FULL_SCALE);
    }
    return true;
  }
}

// ─── midi/in/* ──────────────────────────────────────────────────────────────
//
// ⚠ NO PROCESSOR HERE READS A HOST MIDI PORT, AND NONE MAY. There is no MIDI transport
// in this engine, and an AudioWorkletGlobalScope could not reach one anyway; a live host
// input would be the EPHEMERAL state CLAUDE.md forbids. Every one of these is a pure
// function of its inlets, its params and its own latched state — property state and
// recordable state only, so Δt = 0 gives a byte-identical frame.

/** Restated from synth/ax1_dsp.js's E4 tuning law (A440_HZ / A440_SEMITONES /
 *  SEMITONES_PER_OCTAVE — themselves restated from core/audio_nodes.semitonesToHz).
 *  Axoloti pitch 0 is MIDI 64 = E4, so A440 is semitone 5. */
const AX_A440_HZ = 440;
const AX_A440_SEMITONES = 5;
const AX_SEMITONES_PER_OCTAVE = 12;

/** Restated from synth/ax1_dsp.AX_POLY_ACTIVE_PRIORITY_BASE — their `100000 +
 *  priority++`, which is what makes a released voice outrank a sounding one. */
const AX_POLY_ACTIVE_PRIORITY_BASE = 100000;
/** Restated from synth/ax1_dsp.AX_POLY_PRIORITY_CEILING — their `int min = 1<<30`. */
const AX_POLY_PRIORITY_CEILING = 1 << 30;
/** Restated from synth/ax1_dsp.AX_POLY_MAX_VOICES. The tables are allocated at this
 *  size once, in the constructor, and `voices` narrows the SEARCH — a per-tick resize
 *  would allocate on the audio thread. */
const AX_POLY_MAX_VOICES = 16;

/**
 * THE HERTZ→SEMITONE CONVERSION § R7-AXO-TRAPS TRAP 1 EXISTS FOR. Restated from
 * synth/ax1_dsp.axHzToSemitones; NaN for a non-positive frequency, which is what a
 * disconnected `pitch` input reads and which the caller treats as "no key is down".
 */
function axHzToSemitones(hz) {
  if (!(hz > 0)) return NaN;
  return AX_A440_SEMITONES + AX_SEMITONES_PER_OCTAVE * Math.log2(hz / AX_A440_HZ);
}

/**
 * `audio_ax_midi_keyb` — `midi/in/keyb` with `keyb zone lru`'s zone guard.
 *
 * Input 0 is `pitch` in HERTZ, input 1 the gate. Outputs 0…4 are note (SEMITONES from
 * E4), gate, gate2, velocity, release velocity.
 *
 * `gate2` IS `gate` DELAYED ONE CONTROL TICK — their `_gate2 = _gate` runs after the
 * outlet write, and a note-on zeroes `_gate2` directly, so gate2 notches low for exactly
 * one tick on EVERY note-on including a legato one. That notch is "retrigger on legato"
 * and A1's filter envelope is wired to it.
 */
class Ax1MidiKeybProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "start_note", defaultValue: -64, minValue: -64, maxValue: 63, automationRate: "a-rate" },
      { name: "end_note", defaultValue: 63, minValue: -64, maxValue: 63, automationRate: "a-rate" },
      { name: "velocity", defaultValue: 100 / 128, minValue: 0, maxValue: 1, automationRate: "a-rate" },
      { name: "release_velocity", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    // Their <code.init>: `_gate = 0; _note = 0;`.
    this.note = 0;
    this.gate = 0;
    this.gate2 = 0;
    this.velocity = 0;
    this.releaseVelocity = 0;
    this.wasHigh = false;
  }

  process(inputs, outputs, parameters) {
    const [pitchIn, gateIn] = inputs;
    const [noteOut, gateOut, gate2Out, velocityOut, releaseOut] = outputs;
    if (!noteOut || noteOut.length === 0) return true;
    const frames = noteOut[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const high = axInputAt(gateIn, start) > 0;
      if (high) {
        const candidate = Math.round(axHzToSemitones(axInputAt(pitchIn, start)));
        const low = axParamAt(parameters.start_note, start);
        const top = axParamAt(parameters.end_note, start);
        // Their zone guard is `(data1 >= attr_startNote) && (data1 <= attr_endNote)`,
        // and a note-on outside it is skipped ENTIRELY — gate included.
        if (Number.isFinite(candidate) && candidate >= low && candidate <= top
            && (!this.wasHigh || candidate !== this.note)) {
          this.note = candidate;
          this.velocity = axParamAt(parameters.velocity, start);
          this.gate = 1;
          this.gate2 = 0;
        }
      } else if (this.wasHigh) {
        this.releaseVelocity = axParamAt(parameters.release_velocity, start);
        this.gate = 0;
      }
      this.wasHigh = high;
      axHold(noteOut, start, this.note);
      axHold(gateOut, start, this.gate);
      axHold(gate2Out, start, this.gate2);
      axHold(velocityOut, start, this.velocity);
      axHold(releaseOut, start, this.releaseVelocity);
      // AFTER the outlet write, exactly where theirs is. Moving it above would erase
      // the one-tick notch and silently turn every legato retrigger into a no-op.
      this.gate2 = this.gate;
    }
    return true;
  }
}

/**
 * `audio_ax_midi_bend` — `midi/in/bend`. NO audio inputs: the bender's position is a
 * param (knob and inlet share it, per § R7-11's duality rule). Output 0 is the interval
 * in SEMITONES (position × 64, the frac32-pitch factor), output 1 a one-tick trigger on
 * every move.
 */
class Ax1MidiBendProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "position", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    // Their <code.init>: `_bend = 0; ntrig = 0;`. The previous value is what stands in
    // for "a message arrived", since a wire carries a value and not an event.
    this.previous = 0;
  }

  process(inputs, outputs, parameters) {
    const [bendOut, trigOut] = outputs;
    if (!bendOut || bendOut.length === 0) return true;
    const frames = bendOut[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const position = axParamAt(parameters.position, start);
      // A frac32 pitch of 1.0 IS 64 semitones, so a fully-bent wheel is ±64 st and
      // every patch that uses it divides (A10 takes `÷32` for the usual ±2).
      axHold(bendOut, start, position * AX_DIAL_FULL_SCALE);
      axHold(trigOut, start, position !== this.previous ? 1 : 0);
      this.previous = position;
    }
    return true;
  }
}

/**
 * `audio_ax_midi_touch` — `midi/in/touch`, CHANNEL pressure. Same shape as the bend:
 * a param in, the value and a one-tick change trigger out. Output 0 is `o`, output 1
 * `trig`.
 */
class Ax1MidiTouchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "pressure", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    this.previous = 0;
  }

  process(inputs, outputs, parameters) {
    const [pressureOut, trigOut] = outputs;
    if (!pressureOut || pressureOut.length === 0) return true;
    const frames = pressureOut[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const pressure = axParamAt(parameters.pressure, start);
      axHold(pressureOut, start, pressure);
      axHold(trigOut, start, pressure !== this.previous ? 1 : 0);
      this.previous = pressure;
    }
    return true;
  }
}

// ─── patch/patcher poly=N ───────────────────────────────────────────────────

/**
 * `audio_ax_poly_voices` — the voice allocator of `patch/patcher poly=N`
 * (PatchViewCodegen.java:1042-1083, not an `.axo` code block: the patcher object is an
 * empty shell and the allocator is generated).
 *
 * ⚠ IT ALLOCATES; IT DOES NOT REPLICATE. `core/audio_mirror_diff.readAudioScene` is a
 * flat 1:1 map, so nothing can instantiate the graph downstream of this node N times.
 * These five outputs are ONE slot of the pool — the one the `voice` param names.
 *
 * Inputs 0…4 are note, gate, gate2, velocity, release velocity; outputs the same five.
 * A note-on is a rising `gate`, a `note` change under a held gate, OR a falling `gate2`
 * under a held gate — the three ways `audio_ax_midi_keyb` spells the one event.
 */
class Ax1PolyVoicesProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "voices", defaultValue: 7, minValue: 1, maxValue: AX_POLY_MAX_VOICES, automationRate: "a-rate" },
      { name: "voice", defaultValue: 0, minValue: 0, maxValue: AX_POLY_MAX_VOICES - 1, automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    // Their <sInitCode>: `notePlaying[vi]=0; voicePriority[vi]=0; … priority=0;`.
    // Allocated ONCE at the maximum — `voices` narrows the search rather than resizing,
    // because a resize on the audio thread would allocate.
    this.notePlaying = new Float32Array(AX_POLY_MAX_VOICES);
    this.voicePriority = new Float64Array(AX_POLY_MAX_VOICES);
    this.pressed = new Uint8Array(AX_POLY_MAX_VOICES);
    // The per-voice surface each `midi/in/keyb` inside a voice would produce.
    this.voiceNote = new Float32Array(AX_POLY_MAX_VOICES);
    this.voiceGate = new Float32Array(AX_POLY_MAX_VOICES);
    this.voiceGate2 = new Float32Array(AX_POLY_MAX_VOICES);
    this.voiceVelocity = new Float32Array(AX_POLY_MAX_VOICES);
    this.voiceRelease = new Float32Array(AX_POLY_MAX_VOICES);
    this.priority = 0;
    this.heldNote = 0;
    this.wasHigh = false;
    this.previousGate2High = false;
  }

  process(inputs, outputs, parameters) {
    const [noteIn, gateIn, gate2In, velocityIn, releaseIn] = inputs;
    const [noteOut, gateOut, gate2Out, velocityOut, releaseOut] = outputs;
    if (!noteOut || noteOut.length === 0) return true;
    const frames = noteOut[0].length;

    for (let start = 0; start < frames; start += AX_KRATE_BLOCK) {
      const width = Math.max(1, Math.min(AX_POLY_MAX_VOICES,
        Math.round(axParamAt(parameters.voices, start))));
      const note = axInputAt(noteIn, start);
      const high = axInputAt(gateIn, start) > 0;
      const gate2High = axInputAt(gate2In, start) > 0;

      if (high) {
        const retriggered = this.wasHigh && (note !== this.heldNote || (this.previousGate2High && !gate2High));
        if (!this.wasHigh || retriggered) {
          // A legato note-on releases the note it replaces first, exactly as their
          // NOTE_OFF branch would when the controller sends one.
          if (retriggered) this.releaseNote(this.heldNote, axInputAt(releaseIn, start));
          const slot = this.allocate(width, note);
          this.voiceNote[slot] = note;
          this.voiceVelocity[slot] = axInputAt(velocityIn, start);
          this.voiceGate[slot] = 1;
          this.voiceGate2[slot] = 0;
          this.heldNote = note;
        }
      } else if (this.wasHigh) {
        this.releaseNote(this.heldNote, axInputAt(releaseIn, start));
      }
      this.wasHigh = high;
      this.previousGate2High = gate2High;

      const reported = Math.round(axParamAt(parameters.voice, start));
      // A `voice` past the pool reports SILENCE rather than wrapping: a voice that does
      // not exist has no note, and wrapping would make two nodes play in unison with
      // nothing to say why.
      const live = reported >= 0 && reported < width;
      axHold(noteOut, start, live ? this.voiceNote[reported] : 0);
      axHold(gateOut, start, live ? this.voiceGate[reported] : 0);
      axHold(gate2Out, start, live ? this.voiceGate2[reported] : 0);
      axHold(velocityOut, start, live ? this.voiceVelocity[reported] : 0);
      axHold(releaseOut, start, live ? this.voiceRelease[reported] : 0);
      // The one-tick gate2 lag, per voice, exactly as each voice's own `midi/in/keyb`
      // would produce it.
      for (let i = 0; i < AX_POLY_MAX_VOICES; i++) this.voiceGate2[i] = this.voiceGate[i];
    }
    return true;
  }

  /** Their NOTE_ON branch: steal the lowest-priority voice, push it above the offset. */
  allocate(width, note) {
    let min = AX_POLY_PRIORITY_CEILING;
    let mini = 0;
    for (let i = 0; i < width; i++) {
      if (this.voicePriority[i] < min) { min = this.voicePriority[i]; mini = i; }
    }
    this.voicePriority[mini] = AX_POLY_ACTIVE_PRIORITY_BASE + this.priority;
    this.priority += 1;
    this.notePlaying[mini] = note;
    this.pressed[mini] = 1;
    return mini;
  }

  /** Their NOTE_OFF branch: EVERY voice holding that note, with no `break` — two can
   *  hold one note after a steal. The priority drops below the offset, which is what
   *  returns the voice to the free pool. */
  releaseNote(note, releaseVelocity) {
    for (let i = 0; i < AX_POLY_MAX_VOICES; i++) {
      if (this.notePlaying[i] === note && this.pressed[i]) {
        this.voicePriority[i] = this.priority;
        this.priority += 1;
        this.pressed[i] = 0;
        this.voiceGate[i] = 0;
        this.voiceRelease[i] = releaseVelocity;
      }
    }
  }
}

// ─── audio/out ──────────────────────────────────────────────────────────────

/**
 * `audio_ax_stereo_out` — `sss/audio/StOutVol`'s HARD CLIP, which is the whole reason
 * this exists as a processor rather than as two GainNodes: their codec saturates at
 * ±1.0 where PowerRP's own Output runs a limiter, and a patch tuned to clip here
 * sounds wrong through a limiter. Two inputs (L, R) into one stereo output.
 */
class Ax1StereoOutProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "volume", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "a-rate" }];
  }

  process(inputs, outputs, parameters) {
    const [leftIn, rightIn] = inputs;
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const right = output.length > 1 ? output[1] : output[0];

    for (let i = 0; i < frames; i++) {
      // Volume BEFORE the clip, exactly as their `___SMMUL(…) ` then `__SSAT(…,28)`
      // order does — so turning a loud source down really does stop it clipping.
      const volume = axParamAt(parameters.volume, i - (i % AX_KRATE_BLOCK));
      output[0][i] = axSat1(axInputAt(leftIn, i) * volume);
      right[i] = axSat1(axInputAt(rightIn, i) * volume);
    }
    return true;
  }
}

registerProcessor("ax1-math", Ax1MathProcessor);
registerProcessor("ax1-smooth", Ax1SmoothProcessor);
registerProcessor("ax1-window", Ax1WindowProcessor);
registerProcessor("ax1-divrem", Ax1DivRemProcessor);
registerProcessor("ax1-shaper", Ax1ShaperProcessor);
registerProcessor("ax1-convert", Ax1ConvertProcessor);
registerProcessor("ax1-logic", Ax1LogicProcessor);
registerProcessor("ax1-counter", Ax1CounterProcessor);
registerProcessor("ax1-latch", Ax1LatchProcessor);
registerProcessor("ax1-decode", Ax1DecodeProcessor);
registerProcessor("ax1-mux", Ax1MuxProcessor);
registerProcessor("ax1-steps-bool", Ax1StepsBoolProcessor);
registerProcessor("ax1-steps-value", Ax1StepsValueProcessor);
registerProcessor("ax1-steps-multi", Ax1StepsMultiProcessor);
registerProcessor("ax1-midi-keyb", Ax1MidiKeybProcessor);
registerProcessor("ax1-midi-bend", Ax1MidiBendProcessor);
registerProcessor("ax1-midi-touch", Ax1MidiTouchProcessor);
registerProcessor("ax1-poly-voices", Ax1PolyVoicesProcessor);
registerProcessor("ax1-stereo-out", Ax1StereoOutProcessor);
