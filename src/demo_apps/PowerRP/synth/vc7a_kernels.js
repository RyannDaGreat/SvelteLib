/**
 * THE VC-7a KERNELS — twelve CLOCKING AND LOGIC modules' arithmetic, and nothing else.
 *
 * No AudioNode, no AudioWorklet, no DOM: a plain ES module, so
 * `tests/port_vc7a_test.js` can run every recurrence in BARE NODE against a
 * transcription of the C++. THE ARITHMETIC IS THE DELIVERABLE, so the arithmetic has
 * to be reachable by a test that needs no browser — the reasoning that put AX-2's
 * minBLEP table and VC-3b's Butterworth solver in a kernels module.
 *
 * `worklets/processors_vc7a.js` imports this and wraps each kernel in an
 * AudioWorkletProcessor; `modules_vc7a.js` wires those into engine modules.
 *
 * ⚠ THE WORKLET URL IS NOT HERE AND MUST NOT BE. `synth/worklet_urls.js` holds every
 * block's `?worker&url` specifier — read its header. A Vite specifier anywhere in
 * this import graph takes the entire bare-node test lane down.
 *
 * ── THE DERIVATION RECORD ───────────────────────────────────────────────────
 * TWO sources, cloned read-only and read at these commits on 2026-08-06:
 *
 *   github.com/countmodula/VCVRackPlugins @ 30b3c6c46fc0589f5e0ece7ad79abbe0293e70fd
 *     — eleven of the twelve. Its `src/modules/*.cpp` are parameter plumbing; the
 *       behaviour lives in `src/inc/*.hpp`, which ten modules SHARE. That sharing is
 *       mirrored here (one `GateProcessor`, one `FrequencyDivider`, one `Inverter`,
 *       one `ClockOscillator`, one `LagProcessor`) rather than copied per module,
 *       because a per-module copy is exactly how a Schmitt threshold drifts.
 *   github.com/MarcBoule/ImpromptuModular @ cf87c918875e502043cabe3deaa2e52adda7cecd
 *     — `Clkd` alone (`src/Clkd.cpp`, constants from `src/ClockedCommon.hpp`,
 *       `Trigger`/`TriggerRiseFall`/`RefreshCounter` from `src/ImpromptuModular.hpp`).
 *
 * Rack's own primitives (`dsp::SchmittTrigger`, `dsp::PulseGenerator`, `rescale`,
 * `clamp`) are cited against
 *   github.com/VCVRack/Rack @ 061ccf63c1758599396ac1bb10d47345d9d34076.
 *
 * ── D0. THE VOLTAGE LAW — TWO SCALES, STATED ONCE, APPLIED IN ONE FILE ──────
 * Rack cables carry volts: ±5 V nominal, ±10 V max, a gate is 10 V. Our `audio`
 * wires are ±1 and our `trigger` wires are 0…1 (R7-UNITS clauses 1 and 4).
 *
 *   **1.0 on a PowerRP audio wire IS 5 V in Rack.** `RACK_VOLTS_PER_UNIT = 5`.
 *   **1.0 on a PowerRP trigger wire IS 10 V in Rack.** `RACK_GATE_VOLTS = 10`.
 *
 * So every kernel below computes IN VOLTS — every transcribed line is directly
 * diffable against the C++ — and the conversion happens in exactly two places, both
 * in `worklets/processors_vc7a.js`: `volts = sample · 5` on every input, and
 * `sample = volts / 5` (audio port) or `volts / 10` (trigger port) on every output.
 *
 * THE ASYMMETRY IS DELIBERATE AND IT IS THE WHOLE POINT OF CLAUSE 4. There is no
 * gate-typed INPUT in this block (see D3), so every input takes the LEVEL scale; a
 * 0…1 trigger arriving on one becomes 5 V, which clears CountModula's 2 V Schmitt
 * threshold by a factor of 2.5 and Impromptu's 1 V threshold by 5. A gate OUTPUT is
 * `trigger`-typed and must land in 0…1, so it divides by the 10 V the source emits.
 *
 * THE ONE EXCEPTION, and it is declared per port rather than assumed: Clkd's `bpm`
 * inlet and outlet carry BPM, not volts (R7-UNITS clause 2 — "a number wire carries
 * the REAL unit of its quantity"). They are `rawPorts` in the roster, so the
 * processor scales them by 1 and `ClkdKernel` does its own conversion. See D9.
 *
 * ── D1. THE CONTROL-RATE DIVIDERS ARE PORTED, NOT "IMPROVED" ────────────────
 * Four CountModula modules read their panel every NINTH sample
 * (`if (++processCount > 8) { processCount = 0; … }` — ClockDivider, SampleAndHold2,
 * Fade, EventTimer), and Clkd reads its knobs every SIXTEENTH
 * (`RefreshCounter::processInputs`, `userInputsStepSkipMask = 0xF`). Both divisors are
 * ported as the roster's `controlSteps` and the processor drives the split. Running
 * those reads per sample is the change R7-11 forbids: SampleAndHold2's `forceSample`
 * fires on a mode CHANGE detected at that rate, so a per-sample read changes when it
 * fires, and Fade's fade times would follow a swept knob nine times more finely than
 * the original does.
 *
 * ── D2. RANDOMNESS IS SEEDED ────────────────────────────────────────────────
 * `random::uniform()` (Rack `include/random.hpp`) is a per-thread xoroshiro128+ seeded
 * from the system clock, so THEIR randomness is not reproducible even on the same
 * machine. Three modules use it: SampleAndHold2's probability gate AND its
 * unpatched-input random source, BurstGenerator's pulse probability, and
 * GateSequencer8's RANDOM direction. Ours takes a `seed` knob — the AX-2 SEED pattern,
 * and the project's determinism law (`CLAUDE.md`, "The three kinds of state"): a
 * document that renders differently every time is not a document. The generator is
 * `mulberry32`, which is the generator `synth/vc2_kernels.js` already chose for this
 * job; porting xoroshiro128+ bit-exactly would buy nothing, because the SEED it is
 * bit-exact against does not exist. **The DRAW ORDER is ported exactly**, because that
 * is what a sequence's shape depends on — see `SampleAndHold2Kernel.sample`.
 *
 * ── D3. EVERY INLET IS AN `audio` WORKLET INPUT, NOT AN AudioParam ──────────
 * Ten of these twelve branch on `isConnected()`, and it is not a detail:
 * BooleanAND outputs nothing at all unless A is patched and NORMALS B→A, C→B, D→C;
 * SampleAndHold's mode inlet OVERRIDES its knob when present; BurstGenerator's clock
 * inlet DISCONNECTS the internal oscillator; SampleAndHold2 does nothing whatever
 * unless its trigger is patched, and samples RANDOM NOISE when its signal inlet is
 * not; GateSequencer8's run inlet is normalled to 10 V, so unpatched means RUNNING.
 * No AudioParam can express any of that — one number cannot distinguish "absent" from
 * "zero" — so every inlet here is an `audio` input at its own worklet input index and
 * the processor reads connectedness as `inputs[i].length > 0`. VC-3b measured the same
 * requirement and this is the same mechanism; the kernels take `wired` as an explicit
 * map so `tests/port_vc7a_test.js` drives both branches directly.
 *
 * ── D4. THE INLET TYPE IS `audio`, NOT `trigger`, AND THAT IS THE POINT ─────
 * Every gate inlet in this block goes through `src/inc/GateProcessor.hpp`, which is a
 * SCHMITT TRIGGER ON A RAW VOLTAGE (`rescale(value, 0.1f, 2.0f, 0.f, 1.f)`), and Clkd's
 * is Impromptu's `Trigger` at 0.1 V / 1 V. Patching an LFO or an oscillator into one is
 * an ordinary thing to do — it is how a Subharmonicon's dividers are clocked at audio
 * rate — and `core/nodeflow.COERCIONS` has NO `audio -> trigger`, so typing these
 * inlets `trigger` would REFUSE exactly that cable. `trigger -> audio` exists, so a
 * real trigger output still drives them. Same call VC-3b made, for the same measured
 * reason. Gate OUTPUTS go the other way and are `trigger`-typed, because `trigger`
 * reaches trigger, number AND audio while `audio` reaches only two.
 *
 * ── D5. MOMENTARY PANEL BUTTONS ARE NOT PORTED ──────────────────────────────
 * BurstGenerator's MANUAL, EventTimer's six digit buttons plus TRIGGER and RESET,
 * Clkd's RUN, RESET, BPM-mode and display buttons. A momentary press is not property
 * state (it is not a function of `[[slide, alpha]]`). Where a button was the ONLY
 * route to a value the module KEEPS — EventTimer's countdown length, Clkd's run state
 * and PPQN — that value is a KNOB, and **a knob standing in for a button acts on its
 * CHANGE**, which is the press. Where the button merely duplicated an inlet
 * (BurstGenerator's MANUAL, EventTimer's TRIGGER/RESET) it is simply gone.
 *
 * ── D6. PANEL LIGHTS, LED DISPLAYS AND EXPANDERS ARE NOT PORTED ─────────────
 * Every `lights[…]` write, EventTimer's and Clkd's numeric displays, and the
 * `SequencerExpanderMessage` / `FadeExpanderMessage` blocks. None of them affects a
 * sample. Two lights DO have a computational tail and it is kept: ClockDivider's
 * `pgDiv[c].process()` runs in the gate branch too ("ensure any residual triggers are
 * processed"), and Fade's `processCount == 0` guard is why its light block is inside
 * the control tick.
 *
 * ── D7. POLYPHONY IS NOT PORTED ─────────────────────────────────────────────
 * Rack cables carry up to 16 channels and six of these modules are channel-aware
 * (`getPolyVoltage`, `setChannels`, `gateTrig[16]`). Our `audio` wire is MONO, so each
 * kernel is the c = 0 engine. Nothing about the per-channel arithmetic differs; what is
 * lost is one cable carrying a chord. Reported to the lead rather than invented around.
 * **BusRoute2 is NOT an instance of this** despite its name: its "bus" is a logical OR
 * of seven gates onto two outputs, entirely mono, and it needs nothing.
 *
 * ── DEVIATIONS SPECIFIC TO ONE MODULE ARE NAMED IN THAT KERNEL'S DOCBLOCK ───
 * D8 (SampleAndHold's swapped mode labels — theirs, reproduced), D9 (Clkd's BPM port
 * unit and the two menu fields it makes meaningless), D10 (Clkd's ratio knob is the
 * INDEX into their ratio table), D11 (EventTimer's digit buttons as one `length` knob),
 * D12 (Fade's writes back to its own panel switches), D13 (GateSequencer8's
 * `startUpCounter`), D14 (VCFrequencyDividerMkII's dead `antiAlias` field), D15 (real-
 * unit knobs).
 */

// ── THE LAWS EVERY KERNEL IN THIS FILE OBEYS ────────────────────────────────

/** D0: 1.0 on a PowerRP `audio` wire is this many Rack volts. */
export const RACK_VOLTS_PER_UNIT = 5;

/** D0: 1.0 on a PowerRP `trigger` wire is this many Rack volts — `boolToGate`'s own
 *  10, which is what every gate output in both source plugins emits. */
export const RACK_GATE_VOLTS = 10;

/** `src/inc/Utility.hpp boolToGate(x)`. */
export const GATE_HIGH_VOLTS = 10;

/** `src/inc/Utility.hpp boolToAudio(x)` — a bipolar square, ±5 V. */
export const AUDIO_HIGH_VOLTS = 5;

/** Rack's `dsp::PulseGenerator` duration every CountModula module arms with. */
export const PULSE_SECONDS = 1e-3;

/**
 * Pure function. Rack `include/math.hpp clamp`.
 *
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 *
 * @example clamp(3, 0, 1) // 1
 * @example clamp(-3, -1, 1) // -1
 * @example clamp(0.5, 0, 1) // 0.5
 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pure function. Rack `include/math.hpp rescale` — map `x` from `[xMin, xMax]` onto
 * `[yMin, yMax]`, WITHOUT clamping. `GateProcessor` is built on it.
 *
 * @param {number} x
 * @param {number} xMin
 * @param {number} xMax
 * @param {number} yMin
 * @param {number} yMax
 * @returns {number}
 *
 * @example rescale(2, 0.1, 2, 0, 1) // 1
 * @example rescale(0.1, 0.1, 2, 0, 1) // 0
 * @example rescale(10, 0.1, 2, 0, 1) // 5.2105263157894735
 */
export function rescale(x, xMin, xMax, yMin, yMax) {
  return yMin + ((x - xMin) / (xMax - xMin)) * (yMax - yMin);
}

/**
 * Pure function. Rack `include/math.hpp crossfade` — `a + (b − a)·p`. `LagProcessor`
 * is the only caller, and its `p` is the slew SHAPE knob.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} p
 * @returns {number}
 *
 * @example crossfade(1, 5, 0) // 1
 * @example crossfade(1, 5, 1) // 5
 * @example crossfade(1, 5, 0.25) // 2
 */
export function crossfade(a, b, p) {
  return a + (b - a) * p;
}

/**
 * Pure function. C's `(int)` cast — truncation TOWARD ZERO, which is not
 * `Math.floor` for a negative value and this block has negative CVs everywhere
 * (BurstGenerator's pulse CV, VCFrequencyDividerMkII's division CV).
 *
 * Named rather than spelled `Math.trunc` at twenty call sites so that "this line is a
 * C int cast" reads as such when the port is diffed against the C++.
 *
 * @param {number} v
 * @returns {number}
 *
 * @example toInt(3.9) // 3
 * @example toInt(-3.9) // -3
 * @example toInt(-0.5) // -0
 */
export function toInt(v) {
  return Math.trunc(v);
}

/** mulberry32's odd increment — any odd constant gives the full period; this is the
 *  published one, and it is the constant `synth/vc2_kernels.js` already uses. */
const MULBERRY32_INCREMENT = 0x6d2b79f5;

/**
 * D2's generator. Command — each `next()` advances the state.
 *
 * `mulberry32`, seeded from a construct-time knob so a document renders the same
 * randomness forever. See D2 for why this is not a bit-exact port of Rack's own
 * xoroshiro128+.
 */
export class SeededRandom {
  /** @param {number} seed - any integer; 0 is the default across this block */
  constructor(seed = 0) {
    this.state = seed >>> 0;
  }

  /** Command. The next value in `[0, 1)`, matching `random::uniform()`'s range. */
  next() {
    this.state = (this.state + MULBERRY32_INCREMENT) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// ── Rack include/dsp/digital.hpp — THE PRIMITIVES BOTH PLUGINS BUILD ON ─────

const SCHMITT_UNINITIALIZED = 0;
const SCHMITT_LOW = 1;
const SCHMITT_HIGH = 2;

/**
 * `Rack include/dsp/digital.hpp TSchmittTrigger<float>`, with its THREE-state
 * machine intact.
 *
 * UNINITIALIZED IS NOT LOW, and that is load-bearing rather than pedantry: an input
 * that is already high on the module's first sample sets the state WITHOUT firing, so
 * a patch whose clock is parked high does not emit a spurious event at t = 0. Both
 * source plugins depend on it — `Inverter` holds two of these directly, and
 * `GateProcessor` wraps one.
 *
 * Command.
 */
export class SchmittTrigger {
  constructor() {
    this.state = SCHMITT_UNINITIALIZED;
  }

  /** Command. Back to UNINITIALIZED. */
  reset() {
    this.state = SCHMITT_UNINITIALIZED;
  }

  /** Command. Feed one value; true exactly on a LOW→HIGH crossing. */
  process(value, low = 0, high = 1) {
    if (this.state === SCHMITT_LOW && value >= high) {
      this.state = SCHMITT_HIGH;
      return true;
    }
    if (this.state === SCHMITT_HIGH && value <= low) {
      this.state = SCHMITT_LOW;
      return false;
    }
    if (this.state === SCHMITT_UNINITIALIZED) {
      if (value >= high) this.state = SCHMITT_HIGH;
      else if (value <= low) this.state = SCHMITT_LOW;
    }
    return false;
  }

  /** Query. Is it latched high? */
  isHigh() {
    return this.state === SCHMITT_HIGH;
  }
}

/**
 * `Rack include/dsp/digital.hpp PulseGenerator`. Command — `trigger(t)` arms it for
 * `t` seconds (never SHORTENING an in-flight pulse), `process(dt)` decrements and
 * returns whether it was high for this sample. Every CountModula module arms it with
 * `PULSE_SECONDS`.
 */
export class PulseGenerator {
  constructor() {
    this.remaining = 0;
  }

  /** Command. Back to idle. */
  reset() {
    this.remaining = 0;
  }

  /** Command. Arm for `duration` seconds, extending but never truncating. */
  trigger(duration = PULSE_SECONDS) {
    if (duration > this.remaining) this.remaining = duration;
  }

  /** Command. Advance by `deltaTime`; true while the pulse is high. */
  process(deltaTime) {
    if (this.remaining <= 0) return false;
    this.remaining -= deltaTime;
    return true;
  }
}

// ── CountModula src/inc/*.hpp — THE SHARED MACHINERY (read these first) ─────

/** `src/inc/GateProcessor.hpp`: the low threshold of every CountModula gate inlet. */
export const COUNTMODULA_GATE_LOW_VOLTS = 0.1;

/** `src/inc/GateProcessor.hpp`: the high threshold. A 0…1 PowerRP trigger arrives at 5 V
 *  (D0), which is 2.5× this — the margin D4's typing decision rests on. */
export const COUNTMODULA_GATE_HIGH_VOLTS = 2;

/**
 * `src/inc/GateProcessor.hpp GateProcessor` — THE gate inlet of ten CountModula modules,
 * and therefore the single most load-bearing class in this file.
 *
 * A Schmitt trigger at 0.1 V / 2 V, plus a ONE-SAMPLE MEMORY of its own output so the
 * four edge questions can be asked separately:
 *
 *   set(v)          `st.process(rescale(v, 0.1, 2, 0, 1))`, then
 *                   `prev ← current`, `current ← st.isHigh()`; returns `current`
 *   high()          the level now
 *   leadingEdge()   `current && !prev`
 *   trailingEdge()  `prev && !current`
 *   anyEdge()       `prev != current`   ← BOTH edges; the frequency divider counts these
 *
 * `set()` RETURNS THE LEVEL, NOT AN EDGE, and BooleanXOR depends on that: its
 * `i += (int)(a.set(aIn))` is counting how many inputs are HIGH.
 *
 * Command.
 */
export class GateProcessor {
  constructor() {
    this.st = new SchmittTrigger();
    this.prevState = false;
    this.currentState = false;
  }

  /** Command. Feed one voltage; returns the level AFTER this sample. */
  set(volts) {
    this.st.process(rescale(volts, COUNTMODULA_GATE_LOW_VOLTS, COUNTMODULA_GATE_HIGH_VOLTS, 0, 1));
    this.prevState = this.currentState;
    this.currentState = this.st.isHigh();
    return this.currentState;
  }

  /** Command. Back to an unfired, uninitialised inlet. */
  reset() {
    this.st.reset();
    this.prevState = false;
    this.currentState = false;
  }

  /** Command. `preset(true)` drives it high through a real 10 V `set` and then
   *  forces `prev` high too, so no edge is reported. Their JSON restore path. */
  preset(value) {
    if (value) {
      this.set(GATE_HIGH_VOLTS);
      this.prevState = true;
      this.currentState = true;
    } else {
      this.reset();
    }
  }

  /** Query. Is the gate high now? */
  high() {
    return this.currentState;
  }

  /** Query. Is the gate low now? */
  low() {
    return !this.currentState;
  }

  /** Query. Did this sample take it low→high? */
  leadingEdge() {
    return this.currentState && !this.prevState;
  }

  /** Query. Did this sample take it high→low? */
  trailingEdge() {
    return this.prevState && !this.currentState;
  }

  /** Query. Did this sample change it in EITHER direction? */
  anyEdge() {
    return this.prevState !== this.currentState;
  }

  /** Query. The 10 V / 0 V output form. */
  value() {
    return this.currentState ? GATE_HIGH_VOLTS : 0;
  }
}

/**
 * `src/inc/Inverter.hpp Inverter` — a Schmitt-triggered logical NOT with an ENABLE, used
 * by both boolean gates for their second output.
 *
 * TWO THINGS ARE EASY TO GET WRONG HERE. Its triggers are Rack's DEFAULT-threshold
 * ones (0 V / 1 V), NOT `GateProcessor`'s 0.1 / 2 — so the inverter's own inlet is
 * five times more sensitive than the gate inlets beside it. And `isHigh` INITIALISES
 * TRUE, so an inverter that has never seen a high input outputs 10 V.
 *
 * Command.
 */
export class Inverter {
  constructor() {
    this.i = new SchmittTrigger();
    this.e = new SchmittTrigger();
    this.isHigh = true;
    this.isEnabled = false;
  }

  /** Command. Back to the constructor's state. */
  reset() {
    this.i.reset();
    this.e.reset();
    this.isHigh = true;
    this.isEnabled = false;
  }

  /** Command. Feed the signal (and an enable, defaulted to their own 10 V);
   *  returns 10 or 0 volts. */
  process(volts, enable = GATE_HIGH_VOLTS) {
    this.i.process(volts);
    this.e.process(enable);
    this.isEnabled = this.e.isHigh();
    this.isHigh = this.isEnabled ? !this.i.isHigh() : this.i.isHigh();
    return this.isHigh ? GATE_HIGH_VOLTS : 0;
  }
}

/** `src/inc/ClockOscillator.hpp setPitch`'s ceiling — a pitch above this is clamped, so
 *  the internal clock tops out at 1024 Hz. */
const CLOCK_OSCILLATOR_MAX_PITCH = 10;

/**
 * `src/inc/ClockOscillator.hpp ClockOscillator` — "a version of the VCV Rack Fundamental
 * LFO offering Square/Pulse only". BurstGenerator's internal clock.
 *
 * The recurrence, per sample:
 *
 *   freq  = 2^min(pitch, 10)
 *   phase = (phase + min(freq·dt, 0.5)) mod 1      (ONE subtraction, not a loop)
 *   sqr   = phase < pw ? +1 : −1
 *
 * THE `min(…, 0.5)` IS A REAL CEILING, not a guard: above Nyquist/2 the oscillator
 * stops speeding up and starts producing a slower, wrong pitch. That is theirs.
 *
 * Command.
 */
export class ClockOscillator {
  constructor() {
    this.phase = 0;
    this.pw = 0.5;
    this.freq = 1;
  }

  /** Command. Set the frequency from a pitch in octaves, `2^pitch` hertz. */
  setPitch(pitch) {
    this.freq = Math.pow(2, Math.min(pitch, CLOCK_OSCILLATOR_MAX_PITCH));
  }

  /** Command. Back to phase zero. Their `reset()` leaves `freq` alone. */
  reset() {
    this.phase = 0;
  }

  /** Command. Advance one sample. */
  step(deltaTime) {
    this.phase += Math.min(this.freq * deltaTime, 0.5);
    if (this.phase >= 1) this.phase -= 1;
  }

  /** Query. The bipolar square, ±1. */
  sqr() {
    return this.phase < this.pw ? 1 : -1;
  }

  /** Query. Is the square in its high half? */
  high() {
    return this.phase < this.pw;
  }
}

/** `src/inc/FrequencyDivider.hpp` count modes. */
export const COUNT_UP = 1;
export const COUNT_DN = 2;

/**
 * `src/inc/FrequencyDivider.hpp FrequencyDivider` — THE current divider, and P25's whole
 * sound (eight of these against polyrhythmic sequencers is the Subharmonicon).
 *
 * IT COUNTS BOTH EDGES, which is what makes it a FREQUENCY divider rather than a
 * clock divider, and it is the one line a reader gets wrong from the name:
 *
 *   on gate.anyEdge():
 *       count += 1
 *       if countMode == UP and count == N:  phase = !phase
 *       if count >= N:                      count = 0
 *       if countMode == DN and count == 0:  phase = !phase
 *
 * With N = 1 the phase flips on every edge, so the output IS the input square. With
 * N = 2 it flips once per input CYCLE, so the output is an octave down. In general
 * `f_out = f_in / N`, and because the flip is driven by edges rather than by a
 * timer, the subharmonic locks to the input exactly — no drift, no beating, which is
 * why this sounds like a Subharmonicon and a detuned second oscillator does not.
 *
 * UP vs DOWN moves the flip to the END of the count instead of the START; the phase
 * relationship changes, the frequency does not. Their comment calls DOWN "more
 * musical" and it is the mode both dividers in this block force.
 *
 * Command.
 */
export class FrequencyDivider {
  constructor() {
    this.count = 0;
    this.N = 0;
    this.maxN = 20;
    this.countMode = COUNT_DN;
    this.phase = false;
    this.gate = new GateProcessor();
  }

  /** Command. Feed one clock voltage; returns the divided phase. */
  process(clockVolts) {
    this.gate.set(clockVolts);
    if (this.gate.anyEdge()) {
      this.count++;
      if (this.countMode === COUNT_UP && this.count === this.N) this.phase = !this.phase;
      if (this.count >= this.N) this.count = 0;
      if (this.countMode === COUNT_DN && this.count === 0) this.phase = !this.phase;
    }
    return this.phase;
  }

  /** Command. Set the division, clamped to `[1, maxN]`. */
  setN(n) {
    this.N = clamp(n, 1, this.maxN);
  }

  /** Command. `COUNT_UP` or `COUNT_DN`; anything else is IGNORED, which is theirs. */
  setCountMode(mode) {
    if (mode === COUNT_DN || mode === COUNT_UP) this.countMode = mode;
  }

  /** Command. Set the division ceiling, itself clamped to `[1, 64]`. */
  setMaxN(max) {
    this.maxN = max < 1 ? 1 : max > 64 ? 64 : max;
  }

  /** Command. Their `reset()` — note `count = -1` and `N = 0`, which only survives
   *  until the next `setN`, and `countMode` back to DOWN. */
  reset() {
    this.countMode = COUNT_DN;
    this.count = -1;
    this.N = 0;
    this.phase = false;
    this.gate.reset();
  }
}

/**
 * `src/inc/FrequencyDivider.hpp FrequencyDividerOld` — the pre-MkII divider, kept because
 * VCFrequencyDividerMkII still ships it behind a "Legacy Mode" menu item and a patch
 * saved with that flag sounds different.
 *
 * THE THREE DIFFERENCES, all audible:
 *   1. it counts LEADING EDGES only, so it divides by 2N where the new one divides by N;
 *   2. `N == 0` is a special case that PASSES THE GATE THROUGH rather than dividing;
 *   3. `setN` takes a VOLTAGE and scales `0…10 V` onto `0…maxN`, where the new one
 *      takes the division directly.
 *
 * Command.
 */
export class FrequencyDividerOld {
  constructor() {
    this.count = 0;
    this.N = 0;
    this.maxN = 20;
    this.countMode = COUNT_UP;
    this.phase = false;
    this.gate = new GateProcessor();
  }

  /** Command. Feed one clock voltage; returns the divided phase. */
  process(clockVolts) {
    this.gate.set(clockVolts);
    if (this.N === 0) {
      this.count = 0;
      this.phase = this.gate.high();
    } else if (this.gate.leadingEdge()) {
      if (this.countMode === COUNT_DN) {
        this.count--;
        if (this.count <= 0) {
          this.count = this.N;
          this.phase = !this.phase;
        }
      } else {
        this.count++;
        if (this.count >= this.N) {
          this.count = 0;
          this.phase = !this.phase;
        }
      }
    }
    return this.phase;
  }

  /** Command. Set the division from a VOLTAGE — `0…10 V` maps onto `0…maxN`. */
  setN(volts) {
    this.N = toInt(clamp(volts, 0, 10) * (this.maxN / 10));
    if (this.N > this.maxN) this.N = this.maxN;
  }

  /** Command. `COUNT_UP` or `COUNT_DN`; anything else is IGNORED. */
  setCountMode(mode) {
    if (mode === COUNT_DN || mode === COUNT_UP) this.countMode = mode;
  }

  /** Command. Their ceiling, clamped to `[0, 63]` — one less than the new one's. */
  setMaxN(max) {
    this.maxN = max < 0 ? 0 : max > 63 ? 63 : max;
  }

  /** Command. Back to zero. */
  reset() {
    this.count = 0;
    this.N = 0;
    this.phase = false;
    this.gate.reset();
  }
}

/** `src/inc/SlewLimiter.hpp`: the slowest and fastest slopes, in volts per second. */
const SLEW_MIN_VOLTS_PER_SECOND = 0.1;
const SLEW_MAX_VOLTS_PER_SECOND = 10000;

/** `src/inc/SlewLimiter.hpp`: "amount of extra slew per voltage difference" — the shape
 *  term's scale, so a 10 V gap gives a shape multiplier of 1. */
const SLEW_SHAPE_SCALE = 1 / 10;

/**
 * `src/inc/SlewLimiter.hpp LagProcessor` — "based on the Befaco Slew Limiter by Andrew
 * Belt". Fade's monitor button is the only user in this block.
 *
 * The recurrence, per sample and per direction:
 *
 *   slew = 10000 · (0.1/10000)^rise                      volts per second
 *   out += slew · crossfade(1, (in − out)/10, shape) · dt
 *   out  = min(out, in)                                  never overshoot
 *
 * `shape` interpolates between a CONSTANT slope (linear ramp) and a slope
 * PROPORTIONAL to the remaining gap (an exponential approach). Fade calls it with
 * shape = 1, so its monitor fade is the exponential one.
 *
 * Command.
 */
export class LagProcessor {
  constructor() {
    this.out = 0;
  }

  /** Command. Back to zero. */
  reset() {
    this.out = 0;
  }

  /** Command. One sample toward `input`. */
  process(input, shape, rise, fall, sampleTime) {
    if (input > this.out) {
      const slew = SLEW_MAX_VOLTS_PER_SECOND * Math.pow(SLEW_MIN_VOLTS_PER_SECOND / SLEW_MAX_VOLTS_PER_SECOND, rise);
      this.out += slew * crossfade(1, SLEW_SHAPE_SCALE * (input - this.out), shape) * sampleTime;
      if (this.out > input) this.out = input;
    } else if (input < this.out) {
      const slew = SLEW_MAX_VOLTS_PER_SECOND * Math.pow(SLEW_MIN_VOLTS_PER_SECOND / SLEW_MAX_VOLTS_PER_SECOND, fall);
      this.out -= slew * crossfade(1, SLEW_SHAPE_SCALE * (this.out - input), shape) * sampleTime;
      if (this.out < input) this.out = input;
    }
    return this.out;
  }
}

// ── ImpromptuModular src/ImpromptuModular.hpp — Clkd's OWN primitives ───────

/** `ImpromptuModular.hpp Trigger` / `TriggerRiseFall`: their thresholds, in volts.
 *  Note these are Rack's defaults shifted UP at the bottom only, and they are five
 *  times more sensitive than CountModula's. */
const IMPROMPTU_TRIGGER_LOW_VOLTS = 0.1;
const IMPROMPTU_TRIGGER_HIGH_VOLTS = 1;

/**
 * `ImpromptuModular.hpp Trigger` — a TWO-state Schmitt at 0.1 V / 1 V.
 *
 * IT INITIALISES HIGH (`bool state = true`), which is the opposite of Rack's own
 * three-state one and is not a typo: a Clkd whose reset inlet is parked high must not
 * fire at t = 0, and starting HIGH is how Marc Boulé gets that with two states.
 *
 * Command.
 */
export class ImpromptuTrigger {
  constructor() {
    this.state = true;
  }

  /** Command. Back to their initial HIGH. */
  reset() {
    this.state = true;
  }

  /** Query. */
  isHigh() {
    return this.state;
  }

  /** Command. True exactly on a LOW→HIGH crossing. */
  process(volts) {
    if (this.state) {
      if (volts <= IMPROMPTU_TRIGGER_LOW_VOLTS) this.state = false;
    } else if (volts >= IMPROMPTU_TRIGGER_HIGH_VOLTS) {
      this.state = true;
      return true;
    }
    return false;
  }
}

/**
 * `ImpromptuModular.hpp TriggerRiseFall` — the same thresholds reporting BOTH edges
 * as +1 / −1 / 0, and initialising LOW rather than high. Clkd's run inlet uses it so
 * that a LEVEL-sensitive run signal (menu option) can be told from a momentary one.
 *
 * Command.
 */
export class ImpromptuTriggerRiseFall {
  constructor() {
    this.state = false;
  }

  /** Command. Back to LOW. */
  reset() {
    this.state = false;
  }

  /** Command. +1 on a rise, −1 on a fall, 0 otherwise. */
  process(volts) {
    if (this.state) {
      if (volts <= IMPROMPTU_TRIGGER_LOW_VOLTS) {
        this.state = false;
        return -1;
      }
    } else if (volts >= IMPROMPTU_TRIGGER_HIGH_VOLTS) {
      this.state = true;
      return 1;
    }
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE TWELVE KERNELS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `CountModula/BooleanAND` (`src/modules/BooleanAND.cpp`, struct `AndGate` and
 * `BooleanAND::process`, plus `src/inc/GateProcessor.hpp` and `src/inc/Inverter.hpp`).
 *
 * A four-input AND with a separate inverter, and it is far less trivial than the name
 * suggests because of the NORMALLING and the A-input gate:
 *
 *   iConnected = wired(i)
 *   if wired(a):
 *       inA = a;  inB = wired(b) ? b : inA;  inC = wired(c) ? c : inB;  inD = wired(d) ? d : inC
 *       and = high(inA) && high(inB) && high(inC) && high(inD)          → 10 V or 0
 *       inv = invert(iConnected ? i : and)
 *   else:
 *       and = 0 V
 *       inv = iConnected ? invert(i) : 10 V                             (the inverter is NOT stepped)
 *
 * So an unpatched B follows A, and a module with only A patched is a BUFFER. That
 * normalling is what makes one of these usable as a 2-, 3- or 4-input gate with no
 * mode switch, and it is stated in their own `inputInfos` descriptions.
 *
 * THE `else` BRANCH'S BARE 10 V IS NOT `Inverter`'s output — their code writes the
 * constant without calling `process`, so the inverter's Schmitt state does not
 * advance while A is unpatched. Reproduced exactly; a "tidier" version that always
 * stepped the inverter would differ on the sample A is patched.
 *
 * Command.
 */
export class BooleanAndKernel {
  constructor() {
    this.a = new GateProcessor();
    this.b = new GateProcessor();
    this.c = new GateProcessor();
    this.d = new GateProcessor();
    this.inverter = new Inverter();
  }

  /** Command. No control-rate work — this module has no knobs. */
  control() {}

  /** Command. One sample. `frame` is `[and, inv]` in volts. */
  sample(knobs, signals, wired, frame) {
    const iConnected = wired.i;
    if (wired.a) {
      const inA = signals.a;
      const inB = wired.b ? signals.b : inA;
      const inC = wired.c ? signals.c : inB;
      const inD = wired.d ? signals.d : inC;
      this.a.set(inA);
      this.b.set(inB);
      this.c.set(inC);
      this.d.set(inD);
      const high = this.a.high() && this.b.high() && this.c.high() && this.d.high();
      const out = high ? GATE_HIGH_VOLTS : 0;
      frame[0] = out;
      frame[1] = this.inverter.process(iConnected ? signals.i : out);
    } else {
      frame[0] = 0;
      frame[1] = iConnected ? this.inverter.process(signals.i) : GATE_HIGH_VOLTS;
    }
  }
}

/**
 * `CountModula/BooleanXOR` (`src/modules/BooleanXOR.cpp`, struct `XorGate` and
 * `BooleanXOR::process`).
 *
 * The AND's shape with two differences that matter:
 *
 *   1. **NO NORMALLING.** An unpatched B, C or D is 0 V, not the previous input. That
 *      is right for XOR — a normalled input would make every unpatched channel count.
 *   2. **TWO MODES.** `i` counts how many inputs are HIGH (their
 *      `i += (int)(a.set(aIn))` — `set` returns the LEVEL, not an edge), then
 *
 *          oneHot:  xor = (i == 1)
 *          else:    xor = (i > 0 && i is odd)
 *
 *      Odd-parity is the classic XOR; ONE-HOT fires only when EXACTLY one input is
 *      high, which with four gates is a "solo detector". Their v1.2 flipped the
 *      default from one-hot to parity, which is why `mode` defaults to 0 here.
 *
 * The A-input gate and the inverter behave exactly as the AND's — see that docblock.
 *
 * Command.
 */
export class BooleanXorKernel {
  constructor() {
    this.a = new GateProcessor();
    this.b = new GateProcessor();
    this.c = new GateProcessor();
    this.d = new GateProcessor();
    this.inverter = new Inverter();
  }

  /** Command. No control-rate work: their `oneHot` read is inside the A branch. */
  control() {}

  /** Command. One sample. `frame` is `[xor, inv]` in volts. */
  sample(knobs, signals, wired, frame) {
    const iConnected = wired.i;
    if (wired.a) {
      const oneHot = knobs.mode > 0.5;
      let n = 0;
      n += this.a.set(signals.a) ? 1 : 0;
      n += this.b.set(wired.b ? signals.b : 0) ? 1 : 0;
      n += this.c.set(wired.c ? signals.c : 0) ? 1 : 0;
      n += this.d.set(wired.d ? signals.d : 0) ? 1 : 0;
      const high = oneHot ? n === 1 : n > 0 && n % 2 === 1;
      const out = high ? GATE_HIGH_VOLTS : 0;
      frame[0] = out;
      frame[1] = this.inverter.process(iConnected ? signals.i : out);
    } else {
      frame[0] = 0;
      frame[1] = iConnected ? this.inverter.process(signals.i) : GATE_HIGH_VOLTS;
    }
  }
}

/** `BusRoute2.cpp`: the number of gate channels, and therefore of switch pairs. */
export const BUS_ROUTE_CHANNELS = 7;

/**
 * `CountModula/BusRoute2` (`src/modules/BusRoute2.cpp BusRoute2::process`).
 *
 * Seven gate inlets, fourteen switches, two outlets:
 *
 *   for i in 0…6:  if high(gate_i):  a |= busA_i ;  b |= busB_i
 *
 * A WIRED OR, not a mixer and not a polyphonic bus: nothing here carries a level, and
 * an unpatched channel simply reads 0 V and never contributes. P25 uses one to merge
 * two sequencer rows onto one trigger bus.
 *
 * Command.
 */
export class BusRoute2Kernel {
  constructor() {
    this.gates = [];
    for (let i = 0; i < BUS_ROUTE_CHANNELS; i++) this.gates.push(new GateProcessor());
  }

  /** Command. No control-rate work — their switches are read per sample. */
  control() {}

  /** Command. One sample. `frame` is `[a, b]` in volts. */
  sample(knobs, signals, wired, frame) {
    let aOut = false;
    let bOut = false;
    for (let i = 0; i < BUS_ROUTE_CHANNELS; i++) {
      const n = i + 1;
      this.gates[i].set(signals[`gate${n}`]);
      if (this.gates[i].high()) {
        if (knobs[`busA${n}`] > 0.5) aOut = true;
        if (knobs[`busB${n}`] > 0.5) bOut = true;
      }
    }
    frame[0] = aOut ? GATE_HIGH_VOLTS : 0;
    frame[1] = bOut ? GATE_HIGH_VOLTS : 0;
  }
}

/** `ClockDivider.cpp`: eight division outputs. */
export const CLOCK_DIVIDER_OUTPUTS = 8;

/**
 * `ClockDivider.cpp`: `maxCount[mode]`, the value a DOWN counter wraps to. Binary is
 * 2^9; the others are the LCM of their own mask, so the pattern repeats exactly.
 */
export const CLOCK_DIVIDER_MAX_COUNT = Object.freeze([512, 512, 362880, 9699690]);

/**
 * `ClockDivider.cpp`: `outputMask[mode]`. Binary 1 is a RIPPLE COUNTER — the mask is
 * ANDed with the count, so output n is bit n. The other three are DIVISORS — the mask
 * is a modulus, so output n fires when the count is a multiple of it, which is why
 * Decimal and Prime give divisions a binary counter cannot.
 */
export const CLOCK_DIVIDER_MASKS = Object.freeze([
  Object.freeze([1, 2, 4, 8, 16, 32, 64, 128]),
  Object.freeze([2, 4, 8, 16, 32, 64, 128, 256]),
  Object.freeze([2, 3, 4, 5, 6, 7, 8, 9]),
  Object.freeze([2, 3, 5, 7, 11, 13, 17, 19]),
]);

/** `ClockDivider.cpp`: `BINARY_MODE` is the one mode whose mask is a BIT rather than
 *  a divisor, so it is the one branch that ANDs. */
const CLOCK_DIVIDER_BINARY_MODE = 0;

/**
 * `CountModula/ClockDivider` (`src/modules/ClockDivider.cpp ClockDivider::process`).
 *
 * A multimode clock divider — one counter, eight taps, four ways to read it:
 *
 *   on reset leading edge:   count = binary ? (up ? 0 : 512) : (up ? 0 : 1);  isReset = true
 *   else on clock leading edge:
 *       isReset = false
 *       up   ? (++count > maxCount−1 ? count = 0)
 *            : (--count < 1          ? count = maxCount)
 *   per output c:
 *       bit = isReset ? false
 *           : binary  ? (count & mask[c]) > 0
 *           :           (count % mask[c]) == 0
 *
 * THE RESET AND THE CLOCK ARE MUTUALLY EXCLUSIVE IN ONE SAMPLE — the clock is inside
 * an `else`, so a reset edge swallows a simultaneous clock edge. That is theirs.
 *
 * **THE OUTPUT STAGE IS TWO DIFFERENT MODULES.** In GATE mode each output is the raw
 * bit, so Binary 1 makes a square wave at f/2, f/4, f/8… In TRIGGER mode the bit's
 * RISE arms a 1 ms pulse instead, so every output is a 1 ms blip and the divisions are
 * the same but the shape is not. Their light code is why the pulse generator is still
 * stepped in gate mode ("ensure any residual triggers are processed") — dropping that
 * would leave a pulse armed across a mode change.
 *
 * D1: `countUp`, `doTrigs` and `mode` are read once every NINE samples
 * (`if (++processCount > 8)`), not per sample.
 *
 * Command.
 */
export class ClockDividerKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.gpClock = new GateProcessor();
    this.gpReset = new GateProcessor();
    this.pgDiv = [];
    this.countBits = [];
    for (let c = 0; c < CLOCK_DIVIDER_OUTPUTS; c++) {
      this.pgDiv.push(new PulseGenerator());
      this.countBits.push(false);
    }
    // Their constructor's own initial values, which are NOT `onReset`'s: `count`
    // starts at the binary wrap value and `isReset` starts FALSE, so a divider that
    // is never reset still produces a pattern from its first clock.
    this.count = CLOCK_DIVIDER_MAX_COUNT[CLOCK_DIVIDER_BINARY_MODE];
    this.countUp = false;
    this.doTrigs = false;
    this.mode = 0;
    this.isReset = false;
  }

  /** Command. Their nine-sample panel read (D1). */
  control(knobs) {
    this.countUp = knobs.dir > 0.5;
    this.doTrigs = knobs.trig > 0.5;
    this.mode = clamp(toInt(knobs.mode), 0, CLOCK_DIVIDER_MASKS.length - 1);
  }

  /** Command. One sample. `frame` is the eight division outputs in volts. */
  sample(knobs, signals, wired, frame) {
    const sampleTime = this.sampleTime;
    this.gpReset.set(signals.reset);
    if (this.gpReset.leadingEdge()) {
      this.isReset = true;
      if (this.mode === CLOCK_DIVIDER_BINARY_MODE) this.count = this.countUp ? 0 : CLOCK_DIVIDER_MAX_COUNT[this.mode];
      else this.count = this.countUp ? 0 : 1;
    } else {
      this.gpClock.set(signals.clock);
      if (this.gpClock.leadingEdge()) {
        this.isReset = false;
        if (this.countUp) {
          if (++this.count > CLOCK_DIVIDER_MAX_COUNT[this.mode] - 1) this.count = 0;
        } else if (--this.count < 1) {
          this.count = CLOCK_DIVIDER_MAX_COUNT[this.mode];
        }
      }
    }

    const mask = CLOCK_DIVIDER_MASKS[this.mode];
    for (let c = 0; c < CLOCK_DIVIDER_OUTPUTS; c++) {
      let divActive = this.countBits[c];
      if (this.isReset) this.countBits[c] = false;
      else if (this.mode === CLOCK_DIVIDER_BINARY_MODE) this.countBits[c] = (this.count & mask[c]) > 0;
      else this.countBits[c] = this.count % mask[c] === 0;

      if (this.doTrigs) {
        if (this.countBits[c] && !divActive) {
          divActive = true;
          this.pgDiv[c].trigger(PULSE_SECONDS);
        } else {
          divActive = this.pgDiv[c].process(sampleTime);
        }
      } else {
        divActive = this.countBits[c];
        this.pgDiv[c].process(sampleTime);
      }
      frame[c] = divActive ? GATE_HIGH_VOLTS : 0;
    }
  }
}

/**
 * `VCFrequencyDividerMkII.cpp`: the legacy division map. Their comment gives no
 * reason for the ¼-offsets; the effect is that a division sits in the MIDDLE of the
 * voltage window `FrequencyDividerOld::setN` quantises, so a slightly noisy CV does
 * not flip between two divisions.
 */
export const LEGACY_CV_MAP = Object.freeze([
  0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75,
  5.25, 5.75, 6.25, 6.75, 7.25, 7.75, 8.25, 8.75, 9.25, 9.75, 10.25,
]);

/** `VCFrequencyDividerMkII.cpp`: `divider.setMaxN(21)` in current mode, 20 in legacy. */
const MKII_MAX_N = 21;
const MKII_LEGACY_MAX_N = 20;

/**
 * `CountModula/VCFrequencyDividerMkII` (`src/modules/VCFrequencyDividerMkII.cpp
 * VCFrequencyDividerMkII::process`, on `src/inc/FrequencyDivider.hpp`).
 *
 * **THIS IS P25's WHOLE SOUND.** The Moog Subharmonicon patch runs eight of these off
 * two oscillators; every subharmonic in it comes out of `FrequencyDivider` above, and
 * the reason it sounds like a Subharmonicon rather than like a detuned stack is that
 * the division is EDGE-COUNTED, so each subharmonic is exactly `f/N` and phase-locked
 * to its parent forever.
 *
 * The current path:
 *
 *   divider.setMaxN(21);  divider.setCountMode(COUNT_DN)
 *   N   = (int)(divide + cvAmount · cv)          ← ONE int cast of the SUM, then clamp 1…21
 *   phase = divider.process(div)
 *   divb  = phase ? +5 : −5        (boolToAudio — a bipolar square, ±1 on our wire)
 *   divu  = phase ? 10  :  0       (boolToGate  — the unipolar copy, 0…2 on our wire)
 *
 * The legacy path (menu flag, saved in their JSON, so a harvested patch may carry it)
 * runs `FrequencyDividerOld` instead: the knob indexes `LEGACY_CV_MAP` to a VOLTAGE,
 * the CV is added in volts, and the old divider re-quantises that to a division and
 * counts LEADING edges only — so the same knob divides by twice as much. Both are
 * ported; `legacy` is the knob.
 *
 * **BOTH OUTPUTS STAY `audio`-TYPED** even though `divu` is gate-shaped, and that is
 * the D4 rule applied honestly rather than mechanically: at audio rate these are
 * OSCILLATOR outputs, not logic, and P25 wires them into mixers.
 *
 * D14: their `antiAlias` field is saved and restored and READ BY NOTHING — `process`
 * never mentions it. It gets no knob here, because the house rule forbids shipping an
 * inert control; a checkbox that does nothing is worse than a missing feature.
 *
 * Command.
 */
export class VcFrequencyDividerMkIIKernel {
  constructor() {
    this.divider = new FrequencyDivider();
    this.legacyDivider = new FrequencyDividerOld();
  }

  /** Command. No control-rate work — theirs reads its params per sample. */
  control() {}

  /** Command. One sample. `frame` is `[divb, divu]` in volts. */
  sample(knobs, signals, wired, frame) {
    let phase = false;
    if (knobs.legacy > 0.5) {
      this.legacyDivider.setMaxN(MKII_LEGACY_MAX_N);
      this.legacyDivider.setCountMode(COUNT_DN);
      const div = LEGACY_CV_MAP[clamp(toInt(knobs.divide), 1, MKII_MAX_N) - 1];
      const divCV = knobs.cvAmount * signals.cv;
      this.legacyDivider.setN(div + divCV);
      this.legacyDivider.process(signals.div);
      phase = this.legacyDivider.phase;
    } else {
      this.divider.setMaxN(MKII_MAX_N);
      this.divider.setCountMode(COUNT_DN);
      const divCV = knobs.cvAmount * signals.cv;
      this.divider.setN(toInt(knobs.divide + divCV));
      this.divider.process(signals.div);
      phase = this.divider.phase;
    }
    frame[0] = phase ? AUDIO_HIGH_VOLTS : -AUDIO_HIGH_VOLTS;
    frame[1] = phase ? GATE_HIGH_VOLTS : 0;
  }
}

/** `SampleAndHold.cpp` / `SampleAndHold2.cpp`: `enum Modes`. */
export const SH_SAMPLE = 0;
export const SH_TRACK = 1;
export const SH_PASS = 2;

/**
 * Pure function. `SampleAndHold::process`'s mode-CV law — `(int)(clamp(v, 0, 5)) / 2`
 * in C, where BOTH the cast and the division are integer, so the 0…5 V window is cut
 * into three two-volt bands.
 *
 * @param {number} volts
 * @returns {number} 0 SAMPLE, 1 TRACK, 2 PASS
 *
 * @example sampleHoldModeFromCv(0) // 0
 * @example sampleHoldModeFromCv(1.9) // 0
 * @example sampleHoldModeFromCv(2) // 1
 * @example sampleHoldModeFromCv(4) // 2
 * @example // out-of-range volts clamp rather than wrap
 * @example sampleHoldModeFromCv(50) // 2
 * @example sampleHoldModeFromCv(-9) // 0
 */
export function sampleHoldModeFromCv(volts) {
  return toInt(toInt(clamp(volts, 0, 5)) / 2);
}

/**
 * `CountModula/SampleAndHold` (`src/modules/SampleAndHold.cpp
 * SampleAndHold::process`).
 *
 * Three hold behaviours off one trigger inlet:
 *
 *   SAMPLE  s = in   on the trigger's LEADING EDGE          (classic sample & hold)
 *   TRACK   s = in   while the trigger is HIGH              (track & hold)
 *   PASS    s = in   while the trigger is LOW               (an inverted track)
 *   otherwise the previous s is held
 *   out = s ;  inv = −s
 *
 * The mode INLET OVERRIDES the knob whenever a cable is present (`isConnected`, D3) —
 * not sums with it, overrides — and quantises 0…5 V into the three bands
 * `sampleHoldModeFromCv` states.
 *
 * D8: **THEIR PANEL LABELS AND THEIR ENUM DISAGREE, AND THE CODE IS PORTED, NOT THE
 * LABELS.** `configSwitch(MODE_PARAM, …, {"Sample & Hold", "Through", "Track & Hold"})`
 * names position 1 "Through" and position 2 "Track & Hold", while `enum Modes
 * {SAMPLE, TRACK, PASS}` makes 1 TRACK and 2 PASS. Position 1 therefore TRACKS while
 * the gate is high and position 2 PASSES while it is low. The `help` in
 * `core/audio_specs_vc7a.js` states the behaviour, not the panel.
 *
 * Command.
 */
export class SampleAndHoldKernel {
  constructor() {
    this.gateTrig = new GateProcessor();
    this.held = 0;
  }

  /** Command. No control-rate work — theirs reads its mode per sample. */
  control() {}

  /** Command. One sample. `frame` is `[sample, inv]` in volts. */
  sample(knobs, signals, wired, frame) {
    this.gateTrig.set(signals.trig);
    const trackMode = wired.mode_cv ? sampleHoldModeFromCv(signals.mode_cv) : toInt(knobs.mode);
    const take = (trackMode === SH_TRACK && this.gateTrig.high())
      || (trackMode === SH_SAMPLE && this.gateTrig.leadingEdge())
      || (trackMode === SH_PASS && !this.gateTrig.high());
    if (take) this.held = signals.sample;
    frame[0] = this.held;
    frame[1] = -this.held;
  }
}

/** `SampleAndHold2.cpp`: the saturation their own `// todo:` comment wants to replace
 *  with a soft one. Until they do, it is a hard clamp at ±12 V. */
const SH2_OUTPUT_CLAMP_VOLTS = 12;

/** `SampleAndHold2.cpp`: `getNormalPolyVoltage(10.0f)` — an unpatched offset inlet
 *  reads 10 V, so the Offset knob alone spans ±10 V. */
const SH2_OFFSET_NORMAL_VOLTS = 10;

/** `SampleAndHold2.cpp`: the probability CV's own scale, `cv · atten / 10`. */
const SH2_PROBABILITY_CV_DIVISOR = 10;

/** `SampleAndHold2.cpp`: the random source's span when the signal inlet is unpatched
 *  — `random::uniform() * 10 − 5`, i.e. a bipolar ±5 V. */
const SH2_RANDOM_VOLTS = 10;

/**
 * `CountModula/SampleAndHold2` (`src/modules/SampleAndHold2.cpp
 * SampleAndHold2::process`).
 *
 * The plain S&H plus three things, and the third is the one that makes it interesting:
 *
 *   1. **LEVEL AND OFFSET.** `s = clamp(v · level + offset · offsetCv, −12, +12)`,
 *      where the offset inlet is NORMALLED TO 10 V so the knob alone is a ±10 V shift.
 *   2. **PROBABILITY.** On every edge of the trigger a random number is drawn and the
 *      sample only HAPPENS if it lands under the threshold; otherwise the previous
 *      value stays. That is what turns a clocked S&H into a generative one.
 *   3. **AN UNPATCHED SIGNAL INLET IS A RANDOM SOURCE**, not silence: `c >= inputChannels`
 *      is true for channel 0 when nothing is patched, so `v = random·10 − 5`. A bare
 *      SampleAndHold2 with only a clock is a random voltage generator, and that is how
 *      P2 uses seven of them.
 *
 * **THE MODULE DOES NOTHING AT ALL UNLESS THE TRIGGER IS PATCHED** (`numTrigs > 0`
 * gates the entire body), so its outputs freeze at whatever they last held. D3.
 *
 * D2 — THE DRAW ORDER IS PART OF THE ALGORITHM. `r` is drawn on EVERY edge, BEFORE
 * the threshold is computed and whether or not the CV is patched; the random SIGNAL
 * is drawn afterwards and only when a sample is actually taken. Swap them and the
 * same seed gives a different sequence.
 *
 * D1: mode, probability and its attenuverter are read once every NINE samples, and a
 * mode CHANGE detected at that rate sets `forceSample`, which makes the next sample
 * unconditional.
 *
 * Command.
 */
export class SampleAndHold2Kernel {
  /** @param {number} sampleRate @param {object} options - `{seed}` */
  constructor(sampleRate, options = {}) {
    this.gateTrig = new GateProcessor();
    this.random = new SeededRandom(options.seed ?? 0);
    this.trackMode = SH_SAMPLE;
    this.probability = 1;
    this.probabilityCV = 1;
    this.doSample = false;
    this.forceSample = true;
    this.held = 0;
  }

  /** Command. Their nine-sample panel read (D1). */
  control(knobs, signals, wired) {
    const previous = this.trackMode;
    this.trackMode = wired.mode_cv ? sampleHoldModeFromCv(signals.mode_cv) : toInt(knobs.mode);
    this.probability = knobs.prob;
    this.probabilityCV = knobs.probCvAtten;
    if (previous !== this.trackMode) this.forceSample = true;
  }

  /** Command. One sample. `frame` is `[sample, inv]` in volts. */
  sample(knobs, signals, wired, frame) {
    if (!wired.trig) {
      frame[0] = this.held;
      frame[1] = -this.held;
      return;
    }

    this.gateTrig.set(signals.trig);
    if (this.forceSample || this.gateTrig.anyEdge()) {
      const r = this.random.next();
      let threshold = this.probability;
      if (wired.prob_cv) {
        threshold = clamp(this.probability + (signals.prob_cv * this.probabilityCV) / SH2_PROBABILITY_CV_DIVISOR, 0, 1);
      }
      if (r < threshold) {
        if (this.trackMode === SH_TRACK) this.doSample = this.gateTrig.high();
        else if (this.trackMode === SH_SAMPLE) this.doSample = this.gateTrig.leadingEdge();
        else this.doSample = !this.gateTrig.high();
      }
    }

    if (this.doSample) {
      const offsetVoltage = knobs.offset * (wired.offset_cv ? signals.offset_cv : SH2_OFFSET_NORMAL_VOLTS);
      const v = wired.sample ? signals.sample : this.random.next() * SH2_RANDOM_VOLTS - SH2_RANDOM_VOLTS / 2;
      this.held = clamp(v * knobs.level + offsetVoltage, -SH2_OUTPUT_CLAMP_VOLTS, SH2_OUTPUT_CLAMP_VOLTS);
      if (this.trackMode === SH_SAMPLE) this.doSample = false;
    }

    frame[0] = this.held;
    frame[1] = -this.held;
    this.forceSample = false;
  }
}

/** `BurstGenerator.cpp`: the fast range's remap, `rate = 4 + rate·2`, so the 0…5
 *  knob spans 4…14 octaves instead of 0…5. */
const BURST_FAST_RANGE_OFFSET = 4;
const BURST_FAST_RANGE_SCALE = 2;

/** `BurstGenerator.cpp`: the probability knob reads 0…10 and is divided by this to
 *  become a 0…1 probability, so its units are "tenths". */
const BURST_PROBABILITY_DIVISOR = 10;

/** `BurstGenerator.cpp`: both CV inlets are clamped to Rack's ±10 V rail before the
 *  attenuverter is applied. */
const BURST_CV_CLAMP_VOLTS = 10;

/**
 * `CountModula/BurstGenerator` (`src/modules/BurstGenerator.cpp
 * BurstGenerator::process`, with `src/inc/ClockOscillator.hpp` and
 * `src/inc/GateProcessor.hpp`).
 *
 * One trigger in, a burst of N pulses out — and it is P2's entire clock section,
 * which has no sequencer at all.
 *
 *   pulses = (int)max(pulsesKnob + (int)(clamp(pulsesCv, ±10)·atten), 1)
 *   rate   = rateKnob + clamp(rateCv, ±10)·atten ;  fast ? 4 + 2·rate : rate
 *   clock  = wired(clock) ? clockIn : 5·internalClock.sqr()       ← the inlet DISCONNECTS the oscillator
 *
 *   on trigger leading edge, if !bursting or retrigger allowed:
 *       gpClock.reset() ; clock.reset() ; startBurst = true ; counter = −1
 *   on clock leading edge:
 *       prob = random ≤ clamp((probKnob + clamp(probCv·atten, ±10))/10, 0, 1)
 *       if startBurst or bursting:  ++counter >= pulses ? (counter = −1, bursting = false) : bursting = true
 *   on clock trailing edge, if counter + 1 >= pulses:  bursting = false     ← ends on the pulse, not the next clock
 *
 *   pulses out = bursting && prob && clock high      (the burst, gated by probability)
 *   duration   = bursting                            (a gate spanning the whole burst)
 *   start/end  = 1 ms pulses at the two boundaries
 *
 * **RESETTING THE CLOCK ON THE TRIGGER IS THE FEATURE.** Because the internal
 * oscillator's phase is zeroed by an incoming trigger, the first pulse of the burst
 * lands ON the trigger rather than on the next clock tick — which is what makes a
 * burst sound like a flam rather than like a delayed sequence.
 *
 * D2: the probability draw. D5: their MANUAL button is dropped, so the trigger read is
 * `max(triggerIn, 0)` — note that keeps their `fmaxf`, which SWALLOWS A NEGATIVE
 * TRIGGER VOLTAGE rather than passing it to the Schmitt.
 * D7: the `SequencerExpanderMessage` block is not ported.
 *
 * Command.
 */
export class BurstGeneratorKernel {
  /** @param {number} sampleRate @param {object} options - `{seed}` */
  constructor(sampleRate, options = {}) {
    this.sampleTime = 1 / sampleRate;
    this.clock = new ClockOscillator();
    this.gpClock = new GateProcessor();
    this.gpTrig = new GateProcessor();
    this.pgStart = new PulseGenerator();
    this.pgEnd = new PulseGenerator();
    this.random = new SeededRandom(options.seed ?? 0);
    this.counter = -1;
    this.bursting = false;
    this.prevBursting = false;
    this.startBurst = false;
    this.prob = true;
  }

  /** Command. No control-rate work — theirs is entirely per sample. */
  control() {}

  /** Command. One sample. `frame` is `[pulses, start, duration, end]` in volts. */
  sample(knobs, signals, wired, frame) {
    const sampleTime = this.sampleTime;

    const pulseCV = toInt(clamp(signals.pulses_cv, -BURST_CV_CLAMP_VOLTS, BURST_CV_CLAMP_VOLTS) * knobs.pulsesCvAtten);
    const pulses = toInt(Math.max(knobs.pulses + pulseCV, 1));

    const rateCV = clamp(signals.rate_cv, -BURST_CV_CLAMP_VOLTS, BURST_CV_CLAMP_VOLTS) * knobs.rateCvAtten;
    let rate = knobs.rate + rateCV;
    if (knobs.range > 0) rate = BURST_FAST_RANGE_OFFSET + rate * BURST_FAST_RANGE_SCALE;
    this.clock.setPitch(rate);

    this.gpTrig.set(Math.max(signals.trigger, 0));
    const retrigAllowed = knobs.retrigger > 0.5;
    if (this.gpTrig.leadingEdge() && (!this.bursting || retrigAllowed)) {
      this.gpClock.reset();
      this.clock.reset();
      this.startBurst = true;
      this.counter = -1;
    }

    this.clock.step(sampleTime);
    const internalClock = AUDIO_HIGH_VOLTS * this.clock.sqr();
    this.gpClock.set(wired.clock ? signals.clock : internalClock);

    if (this.gpClock.leadingEdge()) {
      const pCV = clamp(signals.probability_cv * knobs.probabilityCvAtten, -BURST_CV_CLAMP_VOLTS, BURST_CV_CLAMP_VOLTS);
      this.prob = this.random.next() <= clamp((knobs.probability + pCV) / BURST_PROBABILITY_DIVISOR, 0, 1);
      if (this.startBurst || this.bursting) {
        if (++this.counter >= pulses) {
          this.counter = -1;
          this.bursting = false;
        } else {
          this.bursting = true;
        }
        this.startBurst = false;
      }
    }

    if (this.gpClock.trailingEdge() && this.counter + 1 >= pulses) this.bursting = false;

    let startOut = false;
    if (!this.prevBursting && this.bursting) this.pgStart.trigger(PULSE_SECONDS);
    else startOut = this.pgStart.process(sampleTime);

    let endOut = false;
    if (this.prevBursting && !this.bursting) this.pgEnd.trigger(PULSE_SECONDS);
    else endOut = this.pgEnd.process(sampleTime);

    frame[0] = this.bursting && this.prob && this.gpClock.high() ? GATE_HIGH_VOLTS : 0;
    frame[1] = startOut ? GATE_HIGH_VOLTS : 0;
    frame[2] = this.bursting ? GATE_HIGH_VOLTS : 0;
    frame[3] = endOut ? GATE_HIGH_VOLTS : 0;

    this.prevBursting = this.bursting;
  }
}

/** `Fade.cpp`: `enum Stages`. */
const FADE_ATTACK = 0;
const FADE_ON = 1;
const FADE_DECAY = 2;
const FADE_OFF = 3;

/** `Fade.cpp`: the monitor button's own slew, `monitorSlew.process(mute, 1, 0.1, 0.1, dt)`
 *  — shape 1 (exponential), 0.1 rise and fall, which is about 45 ms to full. */
const FADE_MONITOR_SHAPE = 1;
const FADE_MONITOR_SLEW = 0.1;

/**
 * `CountModula/Fade` (`src/modules/Fade.cpp Fade::process`, on `src/inc/SlewLimiter.hpp`).
 *
 * A stereo VCA whose gain is a four-stage LINEAR fade, built for driving VCV's
 * recorder — it is what gives P2 and P14 a clean top and tail.
 *
 *   gate = wired(ctrl) ? (startStop ? toggle on each leading edge
 *                                   : high while the ctrl input is high)
 *                      : fadeKnob > 0.5
 *
 *   ATTACK  t/fadeIn from lastMute toward 1, then → ON   when t > fadeIn
 *   ON      mute = 1,                          then → DECAY when the gate falls
 *   DECAY   1 − t/fadeOut,                     then → OFF when t > fadeOut
 *   OFF     mute = 0,                          then → ATTACK when the gate rises,
 *                                              else running = false
 *
 *   out = in · mute   (per channel, and a channel with nothing patched outputs 0 V)
 *   gate out = running ;  trig out = a 1 ms pulse at each change of `running`
 *
 * **`lastMute` IS WHY AN INTERRUPTED FADE DOES NOT JUMP.** Entering ATTACK from a
 * half-decayed state starts the ramp at the CURRENT gain rather than at zero, so
 * re-gating mid-fade is continuous. That is one variable and it is the difference
 * between a usable fader and a clicky one.
 *
 * The MONITOR path is separate: when not running, `mute` is 0 or 1 through
 * `LagProcessor`, giving a ~45 ms click-free pass-through.
 *
 * D1: fade times, monitor and the fade switch are read once every NINE samples.
 * D12: their `process` WRITES BACK to its own panel switches
 * (`params[MON_PARAM].setValue(0)`, `params[FADE_PARAM].setValue(…)`) so the panel
 * follows the control input. A knob is document state here and a kernel may not write
 * it, so those three writes are dropped; the LOCAL `monitor = false` while running is
 * kept, because that one changes the sound.
 * D7: the `FadeExpanderMessage` block is not ported.
 *
 * Command.
 */
export class FadeKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.gpControl = new GateProcessor();
    this.pgTrig = new PulseGenerator();
    this.monitorSlew = new LagProcessor();
    this.mute = 0;
    this.lastMute = 0;
    this.time = 0;
    this.stage = FADE_OFF;
    this.running = false;
    this.prevRunning = false;
    this.gate = false;
    this.fadeIn = 3;
    this.fadeOut = 3;
    this.fadeButton = 0;
    this.monitor = false;
  }

  /** Command. Their nine-sample panel read (D1). */
  control(knobs) {
    this.fadeIn = knobs.in;
    this.fadeOut = knobs.out;
    this.monitor = knobs.mon > 0.5;
    this.fadeButton = knobs.fade;
  }

  /** Command. One sample. `frame` is `[l, r, gate, trig]` in volts. */
  sample(knobs, signals, wired, frame) {
    const sampleTime = this.sampleTime;

    if (this.running) this.monitor = false;

    if (wired.ctrl) {
      this.gpControl.set(signals.ctrl);
      if (knobs.controlMode > 0.5) {
        if (this.gpControl.leadingEdge()) this.gate = !this.gate;
      } else if (this.gpControl.leadingEdge()) {
        this.gate = true;
      } else if (this.gpControl.trailingEdge()) {
        this.gate = false;
      }
      if (this.monitor) {
        this.gate = false;
        this.running = false;
      }
    } else {
      this.gate = this.fadeButton > 0.5;
      if (this.monitor) {
        this.gate = false;
        this.running = false;
      }
    }

    if (this.gate || this.running) {
      this.running = true;
      this.time += sampleTime;

      if (this.stage === FADE_ATTACK) {
        if (this.time > this.fadeIn) {
          this.stage = FADE_ON;
          this.time = 0;
          this.lastMute = this.mute;
        }
      } else if (this.stage === FADE_ON) {
        if (!this.gate) {
          this.stage = FADE_DECAY;
          this.time = 0;
          this.lastMute = 1;
        }
      } else if (this.stage === FADE_DECAY) {
        if (this.time > this.fadeOut) {
          this.stage = FADE_OFF;
          this.time = 0;
          this.lastMute = this.mute;
        }
      } else {
        this.time = 0;
        if (this.gate) this.stage = FADE_ATTACK;
        else this.running = false;
      }

      if (this.stage === FADE_ATTACK) {
        const t = Math.min(this.time / this.fadeIn, 1);
        this.mute = this.lastMute + (1 - this.lastMute) * t;
      } else if (this.stage === FADE_ON) {
        this.mute = 1;
      } else if (this.stage === FADE_DECAY) {
        this.mute = 1 - Math.min(this.time / this.fadeOut, 1);
      } else {
        this.mute = 0;
      }
    } else {
      this.mute = this.monitorSlew.process(this.monitor ? 1 : 0, FADE_MONITOR_SHAPE, FADE_MONITOR_SLEW, FADE_MONITOR_SLEW, sampleTime);
    }

    frame[0] = wired.l ? signals.l * this.mute : 0;
    frame[1] = wired.r ? signals.r * this.mute : 0;

    let trig = false;
    if (this.prevRunning !== this.running) {
      this.pgTrig.trigger(PULSE_SECONDS);
      trig = true;
    } else {
      trig = this.pgTrig.process(sampleTime);
    }

    frame[2] = this.running ? GATE_HIGH_VOLTS : 0;
    frame[3] = trig ? GATE_HIGH_VOLTS : 0;
    this.prevRunning = this.running;
  }
}

/** `EventTimer.cpp`: `NUM_DIGITS 3`, so the countdown spans 0…999. */
export const EVENT_TIMER_MAX_COUNT = 999;

/** `EventTimer.hpp`: the internal clock is 1 Hz with a half-second high phase. */
const EVENT_TIMER_PERIOD_SECONDS = 1;
const EVENT_TIMER_HIGH_SECONDS = 0.5;

/**
 * `CountModula/EventTimer` (`src/modules/EventTimer.cpp` → `src/modules/EventTimer.hpp`,
 * which is shared with `EventTimer2`).
 *
 * A countdown that fires once. Arm it with a length, trigger it, and N clocks later it
 * raises a gate and a 1 ms pulse — the "do this after 32 bars" of a generative patch.
 *
 *   on reset leading edge:    count = length ; running = false ; end = false ; clock phase = 0
 *   on trigger leading edge:  if !end:  running = true, and if retrigger: count = length
 *   internal clock:           1 Hz, high for the first half second
 *   clock = wired(clock) ? clockIn : internal
 *   on clock leading edge, while running:   if (--count < 0) count = 0
 *   if running and count == 0:  running = false ; end = true ; 1 ms pulse
 *
 *   end out  = a LATCHED gate, high until the next reset
 *   endt out = the 1 ms pulse
 *
 * **`end` LATCHES AND BLOCKS RETRIGGERING** — once fired, the trigger inlet does
 * nothing until a reset arrives. That is what makes it a one-shot rather than a
 * divider, and it is why the reset inlet is not optional in practice.
 *
 * D11: their length is set by SIX momentary digit buttons and lives in `length`, saved
 * in their JSON. Here it is ONE `length` knob, and per D5 a knob standing in for a
 * button acts on its CHANGE: moving it sets both `length` and the live `count`, which
 * is exactly what pressing a digit button does in their loop.
 * D5: their TRIGGER and RESET buttons are dropped — both duplicate an inlet.
 *
 * Command.
 */
export class EventTimerKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.gpTrigger = new GateProcessor();
    this.gpClock = new GateProcessor();
    this.gpReset = new GateProcessor();
    this.pgEnd = new PulseGenerator();
    this.count = 0;
    this.length = 0;
    this.running = false;
    this.end = false;
    this.currentTime = 0;
    // NaN so the FIRST control tick counts as a change and seeds both from the knob.
    this.lastLengthKnob = NaN;
  }

  /** Command. Their nine-sample panel read (D1), reading the knob that stands in for
   *  their digit buttons (D11). */
  control(knobs) {
    const wanted = clamp(toInt(knobs.length), 0, EVENT_TIMER_MAX_COUNT);
    if (wanted !== this.lastLengthKnob) {
      this.lastLengthKnob = wanted;
      this.length = wanted;
      this.count = wanted;
    }
  }

  /** Command. One sample. `frame` is `[end, endt]` in volts. */
  sample(knobs, signals, wired, frame) {
    const sampleTime = this.sampleTime;

    this.gpTrigger.set(signals.trigger);
    this.gpReset.set(signals.reset);

    if (this.gpReset.leadingEdge()) {
      this.count = this.length;
      this.running = false;
      this.end = false;
      this.currentTime = 0;
    }

    if (this.gpTrigger.leadingEdge() && !this.end) {
      if (!this.running) this.currentTime = 0;
      if (knobs.retrigger > 0.5) {
        this.count = this.length;
        this.currentTime = 0;
      }
      this.running = true;
    }

    this.currentTime += sampleTime;
    let v = 0;
    if (this.currentTime > EVENT_TIMER_PERIOD_SECONDS) {
      v = GATE_HIGH_VOLTS;
      this.currentTime -= EVENT_TIMER_PERIOD_SECONDS;
    } else if (this.currentTime < EVENT_TIMER_HIGH_SECONDS) {
      v = GATE_HIGH_VOLTS;
    }

    this.gpClock.set(wired.clock ? signals.clock : v);
    if (this.gpClock.leadingEdge() && this.running && --this.count < 0) this.count = 0;

    let trigOut = false;
    if (this.running && this.count === 0) {
      this.running = false;
      this.end = true;
      trigOut = true;
      this.pgEnd.trigger(PULSE_SECONDS);
    } else {
      trigOut = this.pgEnd.process(sampleTime);
    }

    frame[0] = this.end ? GATE_HIGH_VOLTS : 0;
    frame[1] = trigOut ? GATE_HIGH_VOLTS : 0;
  }
}

/** `GateSequencerSrc.hpp`: `GATESEQ_NUM_ROWS` and `GATESEQ_NUM_STEPS` for the 8. */
export const GATESEQ_ROWS = 8;
export const GATESEQ_STEPS = 8;

/** `GateSequencerSrc.hpp` `enum Directions` — the first four are the real modes and
 *  the next four are their one-shot twins, which `setDirectionLight` FOLDS BACK onto
 *  the first four after setting `oneShot`. 8 is the voltage-addressed mode. */
const GATESEQ_FORWARD = 0;
const GATESEQ_PENDULUM = 1;
const GATESEQ_REVERSE = 2;
const GATESEQ_RANDOM = 3;
const GATESEQ_FORWARD_ONESHOT = 4;
const GATESEQ_RANDOM_ONESHOT = 7;
const GATESEQ_ADDRESSED = 8;

/** `GateSequencerSrc.hpp`: the run/reset "cooey" window — a run or reset edge within
 *  this many seconds of a clock edge is TREATED AS a clock edge. */
const GATESEQ_CLOCK_WINDOW_SECONDS = 1e-4;

/** `GateSequencerSrc.hpp`: `clamp(dirCV, 0.0f, 8.99f)` — 9 volts would floor to 9,
 *  which is off the end of their enum. */
const GATESEQ_DIRECTION_CV_MAX = 8.99;

/** `GateSequencerSrc.hpp`: the addressed mode's own divisor, `length · v / 100`
 *  where `v` is up to 10 V times a 0…10 knob. */
const GATESEQ_ADDRESS_DIVISOR = 100;

/**
 * `CountModula/GateSequencer8` (`src/modules/GateSequencer8.cpp` →
 * `src/modules/GateSequencerSrc.hpp`, shared with GateSequencer16).
 *
 * Eight tracks of eight steps sharing one position, with nine ways to walk it. P3
 * uses one as its whole rhythm section.
 *
 *   length    = wired(length) ? (int)clamp(7/10 · V, 0, 7) + 1 : lengthKnob
 *   direction = wired(direction) ? floor(clamp(V, 0, 8.99)) : directionKnob
 *   run       = wired(run) ? runIn : 10 V                 ← UNPATCHED MEANS RUNNING
 *
 *   FORWARD   ++count ; past length → 1 (or stop, one-shot)
 *   REVERSE   --count ; below 1     → length (or stop)
 *   PENDULUM  the same two, swapping direction AT the turn and stepping back one
 *   RANDOM    count = 1 + (int)(random · length)
 *   ADDRESSED count = 1 + (int)(length · clamp(addrIn normalled 10 V, 0, 10) · addrKnob / 100)
 *
 *   gate_r  = running && step[r][count−1] && !mute[r]
 *   trig_r  = gate_r && clock high            ← the trigger row is the gate row ANDed
 *                                               with the raw clock, so its width is
 *                                               the clock's, not the step's
 *   end     = the one-shot has finished
 *
 * **THE RUN/RESET "COOEY" WINDOW IS THE SUBTLE PART.** A clock edge arms a 100 µs
 * pulse; while that pulse is live, a RUN or RESET edge counts as a clock edge too. So
 * starting a sequencer whose run and clock arrive on the same tick does not lose the
 * first step — a race every clocked module has and most get wrong.
 *
 * D2: the RANDOM direction's draw. D13: their `startUpCounter` delays the clock and run
 * inlets by 20 samples, and it is only ever set by `dataFromJson` — a freshly built
 * module has it at 0. Since our modules are always freshly built, the delay is dropped;
 * nothing reads it in the path we have.
 *
 * Command.
 */
export class GateSequencer8Kernel {
  /** @param {number} sampleRate @param {object} options - `{seed}` */
  constructor(sampleRate, options = {}) {
    this.sampleTime = 1 / sampleRate;
    this.gateClock = new GateProcessor();
    this.gateReset = new GateProcessor();
    this.gateRun = new GateProcessor();
    this.pgClock = new PulseGenerator();
    this.random = new SeededRandom(options.seed ?? 0);
    this.count = 0;
    this.length = GATESEQ_STEPS;
    this.direction = GATESEQ_FORWARD;
    this.directionMode = GATESEQ_FORWARD;
    this.oneShot = false;
    this.oneShotEnded = false;
    this.running = false;
  }

  /** Command. No control-rate work — theirs reads its panel per sample. */
  control() {}

  /**
   * Command. `setDirectionLight`'s ONLY computational half: decide `oneShot` and FOLD
   * the four one-shot modes back onto their plain twins, which is what lets the walk
   * below have four cases instead of eight.
   */
  resolveDirectionMode() {
    this.oneShot = this.directionMode >= GATESEQ_FORWARD_ONESHOT && this.directionMode <= GATESEQ_RANDOM_ONESHOT;
    if (!this.oneShot) this.oneShotEnded = false;
    if (this.directionMode >= GATESEQ_FORWARD_ONESHOT && this.directionMode <= GATESEQ_RANDOM_ONESHOT) {
      this.directionMode -= GATESEQ_FORWARD_ONESHOT;
    }
  }

  /** Query. `recalcDirection()` — pendulum alternates, everything else is itself. */
  recalcDirection() {
    if (this.directionMode === GATESEQ_PENDULUM) {
      return this.direction === GATESEQ_FORWARD ? GATESEQ_REVERSE : GATESEQ_FORWARD;
    }
    return this.directionMode;
  }

  /** Command. One sample. `frame` is `[gate1…8, trig1…8, end]` in volts. */
  sample(knobs, signals, wired, frame) {
    const sampleTime = this.sampleTime;

    this.gateReset.set(signals.reset);
    this.gateRun.set(wired.run ? signals.run : GATE_HIGH_VOLTS);
    this.gateClock.set(signals.clock);

    if (wired.length_cv) {
      const scale = GATESEQ_STEPS - 1;
      this.length = toInt(clamp((scale / 10) * signals.length_cv, 0, scale)) + 1;
    } else {
      this.length = toInt(knobs.length);
    }

    if (wired.direction_cv) {
      this.directionMode = Math.floor(clamp(signals.direction_cv, 0, GATESEQ_DIRECTION_CV_MAX));
    } else {
      this.directionMode = toInt(knobs.direction);
    }
    this.resolveDirectionMode();

    let nextDir = this.recalcDirection();
    if (this.directionMode !== GATESEQ_PENDULUM) this.direction = nextDir;

    if (this.gateReset.leadingEdge()) {
      this.oneShotEnded = false;
      if (this.directionMode === GATESEQ_PENDULUM) {
        this.direction = GATESEQ_FORWARD;
        nextDir = GATESEQ_FORWARD;
      }
      if (nextDir === GATESEQ_FORWARD || nextDir === GATESEQ_RANDOM) this.count = 0;
      else if (nextDir === GATESEQ_REVERSE) this.count = GATESEQ_STEPS + 1;
      this.direction = nextDir;
    }

    let clockEdge = this.gateClock.leadingEdge();
    if (clockEdge) this.pgClock.trigger(GATESEQ_CLOCK_WINDOW_SECONDS);
    else if (this.pgClock.process(sampleTime)) {
      clockEdge = this.gateRun.leadingEdge() || this.gateReset.leadingEdge();
    }

    if (this.gateRun.low()) this.running = false;

    if (clockEdge && this.gateRun.high()) {
      this.running = true;
      if (this.oneShot && this.oneShotEnded) {
        this.count = 0;
      } else {
        if (this.direction === GATESEQ_FORWARD) {
          this.count++;
          if (this.count > this.length) {
            if (nextDir === GATESEQ_FORWARD) {
              this.count = 1;
              if (this.oneShot) {
                this.oneShotEnded = true;
                this.count = 0;
              }
            } else {
              this.count--;
              this.direction = nextDir;
            }
          }
        } else if (this.direction === GATESEQ_REVERSE) {
          this.count--;
          if (this.count < 1) {
            if (this.oneShot) {
              this.oneShotEnded = true;
              this.count = 0;
            } else if (nextDir === GATESEQ_REVERSE) {
              this.count = this.length;
            } else {
              this.count++;
              this.direction = nextDir;
            }
          }
        } else if (this.direction === GATESEQ_RANDOM) {
          if (this.oneShot && this.count >= this.length) {
            this.oneShotEnded = true;
            this.count = 0;
          }
          if (!this.oneShotEnded) this.count = 1 + toInt(this.random.next() * this.length);
          this.direction = nextDir;
        } else if (this.direction === GATESEQ_ADDRESSED) {
          const v = clamp(wired.address_cv ? signals.address_cv : GATE_HIGH_VOLTS, 0, 10) * knobs.addr;
          this.count = 1 + toInt((this.length * v) / GATESEQ_ADDRESS_DIVISOR);
        }
        if (this.count > this.length) this.count = this.length;
      }
    }

    const clockHigh = this.gateClock.high();
    for (let r = 0; r < GATESEQ_ROWS; r++) {
      const step = this.count >= 1 && this.count <= GATESEQ_STEPS
        ? knobs[`step${r + 1}_${this.count}`] > 0.5
        : false;
      const gate = this.running && step && knobs[`mute${r + 1}`] < 0.5;
      frame[r] = gate ? GATE_HIGH_VOLTS : 0;
      frame[GATESEQ_ROWS + r] = gate && clockHigh ? GATE_HIGH_VOLTS : 0;
    }
    frame[GATESEQ_ROWS * 2] = this.oneShotEnded ? GATE_HIGH_VOLTS : 0;
  }
}

/** `ClockedCommon.hpp`: the 35 ratio values a Clkd ratio knob indexes. */
export const CLKD_RATIO_VALUES = Object.freeze([
  1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19,
  23, 24, 29, 31, 32, 37, 41, 43, 47, 48, 53, 59, 61, 64, 96,
]);

/** `ClockedCommon.hpp`: `bpmMin` / `bpmMax`, and therefore the master period's bounds. */
export const CLKD_BPM_MIN = 30;
export const CLKD_BPM_MAX = 300;

/** `Clkd.cpp`: `Clock::guard` — the window before the end of a sub-clock's last
 *  iteration in which it waits for the master rather than free-running. */
const CLKD_SYNC_GUARD_SECONDS = 0.0005;

/** `Clkd.cpp`: a trigger-mode clock output is high for this long instead of for half
 *  the period (`isHigh()`'s `step <= 0.001f`). */
const CLKD_TRIGGER_HIGH_SECONDS = 0.001;

/** `Clkd.cpp`: the reset and run OUTPUT pulses, `resetPulse.trigger(0.001f)`. */
const CLKD_PULSE_SECONDS = 0.001;

/** `Clkd.cpp` `resetOnStartStop` bit masks. */
const ON_STOP_INT_RST_MSK = 0x1;
const ON_START_INT_RST_MSK = 0x2;
const ON_STOP_EXT_RST_MSK = 0x4;
const ON_START_EXT_RST_MSK = 0x8;

/** `Clkd.cpp`: the external-sync range is widened by this factor either way "for
 *  better sync ability (20-450 BPM)". */
const CLKD_SYNC_RANGE_STRETCH = 1.5;

/** `Clkd.cpp`: the two-quick-pulses window that auto-switches to P24, in seconds —
 *  their `(60/300)/24` and `(60/30)/4`. */
const CLKD_AUTO_P24_MIN_SECONDS = (60 / 300) / 24;
const CLKD_AUTO_P24_MAX_SECONDS = (60 / 30) / 4;

/**
 * `Clkd.cpp`'s inner `class Clock` — ONE clock in a family of four, and the reason
 * Clkd's sub-clocks cannot drift out of phase with its master.
 *
 * A clock is a position `step` in `[0, length)` plus a count of `iterations` to run
 * before it resets. `step == −1` means STOPPED, and the master re-arms every clock
 * whose step is −1 at the top of its own frame — which is how a ratio change takes
 * effect at a musical boundary instead of immediately.
 *
 *   stepClock():
 *       step += dt
 *       if sub-clock and on the LAST iteration and step > length − 0.0005:
 *           if the master has reset:  reset()          ← THE SYNC. Wait, do not wrap.
 *       else if step >= length:
 *           iterations-- ; step -= length
 *           if iterations <= 0:  reset(master ? 0 : step)   ← the master CARRIES its
 *                                                             remainder, subs do not
 *
 * **THE MASTER CARRYING ITS REMAINDER IS WHY THERE IS NO ACCUMULATED ERROR.** A
 * period is rarely a whole number of samples, so the leftover is handed to the next
 * frame instead of being truncated; over an hour that is the difference between in
 * time and audibly not.
 *
 * Command.
 */
export class ClkdClock {
  /**
   * @param {ClkdClock|null} syncSrc - the master, or null if this IS the master
   * @param {object} owner - the kernel, read for `resetClockOutputsHigh` and `trigOuts`
   * @param {number} index - which clock this is, so `trigOuts[index]` is readable
   */
  constructor(syncSrc, owner, index) {
    this.syncSrc = syncSrc;
    this.owner = owner;
    this.index = index;
    this.step = -1;
    this.remainder = 0;
    this.length = 0;
    this.sampleTime = 0;
    this.iterations = 0;
  }

  /** Command. Stop, optionally carrying a remainder into the next start. */
  reset(remainder = 0) {
    this.step = -1;
    this.remainder = remainder;
  }

  /** Query. Is this clock stopped and awaiting re-arming? */
  isReset() {
    return this.step === -1;
  }

  /** Query. The current position, in seconds. */
  getStep() {
    return this.step;
  }

  /** Command. Start at the carried remainder. */
  start() {
    this.step = this.remainder;
  }

  /** Command. Arm with a period, an iteration count and a sample time. */
  setup(length, iterations, sampleTime) {
    this.length = length;
    this.iterations = iterations;
    this.sampleTime = sampleTime;
  }

  /** Command. Advance one sample; see the docblock's recurrence. */
  stepClock() {
    if (this.step < 0) return;
    this.step += this.sampleTime;
    if (this.syncSrc !== null && this.iterations === 1 && this.step > this.length - CLKD_SYNC_GUARD_SECONDS) {
      if (this.syncSrc.isReset()) this.reset();
      return;
    }
    if (this.step >= this.length) {
      this.iterations--;
      this.step -= this.length;
      if (this.iterations <= 0) this.reset(this.syncSrc === null ? this.step : 0);
    }
  }

  /** Command. Rescale position AND period when the tempo changes, so a tempo sweep
   *  does not restart the bar. */
  applyNewLength(lengthStretchFactor) {
    if (this.step !== -1) this.step *= lengthStretchFactor;
    this.length *= lengthStretchFactor;
  }

  /** Query. 1 or 0 — a 1 ms blip in trigger mode, a 50% square otherwise, and the
   *  configured idle level while stopped. */
  isHigh() {
    if (this.step >= 0) {
      if (this.owner.trigOuts[this.index]) return this.step <= CLKD_TRIGGER_HIGH_SECONDS ? 1 : 0;
      return this.step < this.length * 0.5 ? 1 : 0;
    }
    return this.owner.resetClockOutputsHigh ? 1 : 0;
  }
}

/**
 * Pure function. `Clkd::getRatioDoubled` — a ratio knob's INDEX into
 * `CLKD_RATIO_VALUES`, returned DOUBLED so the half-integers (1.5, 2.5) survive as
 * whole numbers, and NEGATED for a division.
 *
 * The doubling is not a rounding trick: the sub-clock setup below uses the parity of
 * this number to decide how many iterations of the master frame a ratio spans, which
 * is what makes a ×1.5 clock line up again every two bars rather than never.
 *
 * @param {number} knob - the ratio knob, −34…34
 * @returns {number} twice the ratio, negative for a division
 *
 * @example clkdRatioDoubled(0) // 2
 * @example clkdRatioDoubled(1) // 3
 * @example clkdRatioDoubled(5) // 8
 * @example // a negative knob is a DIVISION by the same table entry
 * @example clkdRatioDoubled(-9) // -16
 * @example // past the end of the table it saturates on the last entry, 96
 * @example clkdRatioDoubled(99) // 192
 */
export function clkdRatioDoubled(knob) {
  let i = Math.round(knob);
  let isDivision = false;
  if (i < 0) {
    i *= -1;
    isDivision = true;
  }
  if (i >= CLKD_RATIO_VALUES.length) i = CLKD_RATIO_VALUES.length - 1;
  const ret = toInt(CLKD_RATIO_VALUES[i] * 2 + 0.5);
  return isDivision ? -ret : ret;
}

/** `Clkd.cpp`'s BPM-mode menu: the only PPQN values it can reach. */
export const CLKD_PPQN_VALUES = Object.freeze([2, 4, 8, 12, 16, 24]);

/**
 * Pure function. Snap a `ppqn` knob to the nearest value their menu can actually
 * produce. THE KNOB IS A NUMBER RATHER THAN A DROPDOWN because every switch in this
 * block is (see `core/audio_specs_vc7a.js`'s UNITS section), and a number knob can
 * be swept by an equation; snapping is what keeps the swept values MEANINGFUL instead
 * of letting `ppqn = 5` produce a sync timeout no menu could ask for.
 *
 * @param {number} value - the knob
 * @returns {number} one of 2, 4, 8, 12, 16, 24
 *
 * @example clkdSnapPpqn(4) // 4
 * @example clkdSnapPpqn(5) // 4
 * @example clkdSnapPpqn(7) // 8
 * @example clkdSnapPpqn(1000) // 24
 * @example clkdSnapPpqn(-3) // 2
 */
export function clkdSnapPpqn(value) {
  let best = CLKD_PPQN_VALUES[0];
  for (const candidate of CLKD_PPQN_VALUES) {
    if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate;
  }
  return best;
}

/**
 * `ImpromptuModular/Clkd` (`src/Clkd.cpp`, class `Clock` and `Clkd::process`;
 * constants from `src/ClockedCommon.hpp`; `Trigger`, `TriggerRiseFall` and
 * `RefreshCounter` from `src/ImpromptuModular.hpp`).
 *
 * A master clock and three ratio-locked sub-clocks. **A missing clock divider silences
 * everything downstream of it**, which is why this node is the first one in the block.
 *
 *   masterLength = clamp(60 / bpm, 0.2, 2.0)          seconds per beat
 *   sub i:  r = ratioDoubled[i]
 *           r < 0  (division):  length = masterLength · |r| / 2 ; iterations = 1 + (|r| mod 2)
 *           r > 0  (multiple):  length = 2 · masterLength / r    ; iterations = r / (2 − r mod 2)
 *
 * The iteration counts are the whole trick. A ×3 clock runs three periods inside one
 * master frame and then re-syncs; a ÷3 clock runs one period lasting one and a half
 * master frames, and its `1 + (r mod 2)` iterations is what lets a half-integer ratio
 * close its cycle on a master boundary. Nothing free-runs: every sub-clock waits in
 * `Clock::stepClock`'s guard region for the master to reset, so eight bars later they
 * are still exactly in phase.
 *
 * THREE WAYS TO SET THE TEMPO, and the inlet chooses:
 *   knob         `bpm` knob, 30…300, when nothing is patched
 *   BPM CV       the `bpm` inlet's value, when patched and `bpmMode` is 0
 *   DETECTION    the `bpm` inlet as a CLOCK, when `bpmMode` is 1: it counts PPQN
 *                pulses, measures the interval, and predicts the rest of the beat
 *                (`newMasterLength = step + extIntervalTime·(ppqn − n)/n`). This is
 *                what locks a whole rack to an external sequencer, and it STOPS the
 *                clock on a timeout rather than freewheeling.
 *
 * D9 — **THE `bpm` PORT'S UNIT, AND THE TWO MENU FIELDS IT COSTS.** R7-UNITS clause 2
 * says a number wire carries the real unit of its quantity, so this pair carries BPM,
 * not Rack's `120·2^V` volts: the inlet is read as BPM, the outlet emits
 * `60 / masterLength`. That keeps a Clkd→Clkd chain in one unit, which is the whole
 * point of the clause, and the outlet's type changes from the harvested `audio` to
 * `number` for the same reason (an `audio` wire carrying 96 would be twenty times
 * full scale). The cost is that their `bpmInputScale` and `bpmInputOffset` menu
 * fields — a calibration for volt-domain CVs — have nothing to calibrate and are NOT
 * ported. In DETECTION mode the inlet is a clock instead, and is read as a raw level
 * scaled by `RACK_VOLTS_PER_UNIT`; that dual reading is the original's, one jack with
 * two jobs, and both are stated in the spec's `help`.
 *
 * D10: a ratio knob is an INDEX into `CLKD_RATIO_VALUES`, not a ratio. Knob 5 is ×4,
 * knob −9 is ÷8. Theirs is a snap knob and so is ours.
 * D5: their RUN, RESET, BPM-mode and display buttons are dropped; `running` is a knob
 * acting on its CHANGE, and PPQN and the BPM mode are knobs outright.
 * D6: `editingBpmMode`, `cantRunWarning`, `displayIndex` and every light are dropped —
 * all four exist only to drive the panel.
 *
 * Command.
 */
export class ClkdKernel {
  /** @param {number} sampleRate @param {object} options - unused; kept for the roster's uniform `make` */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.sampleTime = 1 / sampleRate;
    this.masterLengthMin = 60 / CLKD_BPM_MAX;
    this.masterLengthMax = 60 / CLKD_BPM_MIN;

    this.resetTrigger = new ImpromptuTrigger();
    this.runInputTrigger = new ImpromptuTriggerRiseFall();
    this.bpmDetectTrigger = new ImpromptuTrigger();
    this.resetPulse = new PulseGenerator();
    this.runPulse = new PulseGenerator();

    // Read by ClkdClock through `owner`, so the four clocks share one copy.
    this.resetClockOutputsHigh = true;
    this.trigOuts = [false, false, false, false];

    this.clk = [new ClkdClock(null, this, 0)];
    for (let i = 1; i < 4; i++) this.clk.push(new ClkdClock(this.clk[0], this, i));

    this.running = true;
    this.bpmDetectionMode = false;
    this.resetOnStartStop = 0;
    this.ppqn = 4;
    this.momentaryRunInput = true;
    this.forceCvOnBpmOut = false;

    // `bufferedKnobs` is [ratio1, ratio2, ratio3, bpm] — their own indexing, where
    // BPM_PARAM is "contiguous with RATIO_PARAMS" so one loop covers all four.
    this.bufferedKnobs = [0, 0, 0, 120];
    this.syncRatios = [false, false, false];
    this.ratiosDoubled = [0, 0, 0];
    this.clkOutputs = [0, 0, 0, 0];
    this.extPulseNumber = -1;
    this.extIntervalTime = 0;
    this.timeoutTime = 2 / this.ppqn + 0.1;
    this.masterLength = 0.5;
    this.newMasterLength = 0.5;
    this.lastRunningKnob = NaN;
    this.lastPpqnKnob = this.ppqn;
    this.lastBpmModeKnob = this.bpmDetectionMode;
    this.resetClkd(true, false);
  }

  /** Command. `resetClkd(hardReset)` — re-arm all four clocks and recompute the
   *  master period from whichever tempo source is live. */
  resetClkd(hardReset, bpmWired, bpmValue = 0) {
    for (let i = 0; i < 4; i++) {
      this.clk[i].reset();
      this.clkOutputs[i] = this.resetClockOutputsHigh ? GATE_HIGH_VOLTS : 0;
    }
    for (let i = 0; i < 3; i++) {
      this.syncRatios[i] = false;
      this.ratiosDoubled[i] = clkdRatioDoubled(this.bufferedKnobs[i]);
    }
    this.extPulseNumber = -1;
    this.extIntervalTime = 0;
    this.timeoutTime = 2 / this.ppqn + 0.1;
    if (bpmWired) {
      if (this.bpmDetectionMode) {
        if (hardReset) this.newMasterLength = 0.5;
      } else {
        this.newMasterLength = 60 / bpmValue;
      }
    } else {
      this.newMasterLength = 60 / this.bufferedKnobs[3];
    }
    this.newMasterLength = clamp(this.newMasterLength, this.masterLengthMin, this.masterLengthMax);
    this.masterLength = this.newMasterLength;
  }

  /** Command. `toggleRun()` — with the guard that a detecting clock may be STOPPED by
   *  hand but not STARTED, because a manual start cannot know which pulse begins a
   *  PPQN set. */
  toggleRun(bpmWired) {
    if (!(this.bpmDetectionMode && bpmWired) || this.running) {
      this.running = !this.running;
      this.runPulse.trigger(CLKD_PULSE_SECONDS);
      const startMask = this.running ? ON_START_INT_RST_MSK : ON_STOP_INT_RST_MSK;
      const extMask = this.running ? ON_START_EXT_RST_MSK : ON_STOP_EXT_RST_MSK;
      if (this.resetOnStartStop & startMask) this.resetClkd(false, bpmWired);
      if (this.resetOnStartStop & extMask) this.resetPulse.trigger(CLKD_PULSE_SECONDS);
    }
  }

  /** Command. Their `RefreshCounter::processInputs` tick — once every sixteen samples
   *  (D1). Buffers the four knobs and flags a ratio that moved. */
  control(knobs) {
    // THE TWO FIELDS THE MODULE ITSELF CAN WRITE are applied on their knob's CHANGE,
    // not every tick: `Clkd`'s auto-P24 path sets `bpmDetectionMode` and `ppqn` from
    // inside `process`, and a per-tick read would silently undo it on the next
    // control sample. Same rule as `running` below (D5).
    const wantedPpqn = clkdSnapPpqn(knobs.ppqn);
    if (wantedPpqn !== this.lastPpqnKnob) {
      this.lastPpqnKnob = wantedPpqn;
      this.ppqn = wantedPpqn;
    }
    const wantedBpmMode = knobs.bpmMode > 0.5;
    if (wantedBpmMode !== this.lastBpmModeKnob) {
      this.lastBpmModeKnob = wantedBpmMode;
      this.bpmDetectionMode = wantedBpmMode;
    }
    this.resetClockOutputsHigh = knobs.resetHigh > 0.5;
    this.momentaryRunInput = knobs.momentaryRun > 0.5;
    this.forceCvOnBpmOut = knobs.forceCvOnBpmOut > 0.5;
    this.resetOnStartStop = (knobs.resetOnStopInt > 0.5 ? ON_STOP_INT_RST_MSK : 0)
      | (knobs.resetOnStartInt > 0.5 ? ON_START_INT_RST_MSK : 0)
      | (knobs.resetOnStopExt > 0.5 ? ON_STOP_EXT_RST_MSK : 0)
      | (knobs.resetOnStartExt > 0.5 ? ON_START_EXT_RST_MSK : 0);
    for (let i = 0; i < 4; i++) this.trigOuts[i] = knobs[`trigOut${i + 1}`] > 0.5;

    const wanted = [knobs.ratio_1, knobs.ratio_2, knobs.ratio_3, knobs.bpm];
    for (let i = 0; i < 4; i++) {
      if (this.bufferedKnobs[i] !== wanted[i]) {
        this.bufferedKnobs[i] = wanted[i];
        if (i < 3) this.syncRatios[i] = true;
      }
    }
  }

  /** Command. One sample. `frame` is `[clk_1…clk_4, reset, run, bpm]`; the first six
   *  are volts and `bpm` is BPM (D9). */
  sample(knobs, signals, wired, frame) {
    const sampleTime = this.sampleTime;
    const bpmWired = wired.bpm_cv;

    // D5: the run knob stands in for their momentary RUN button, so its CHANGE is the
    // press. The run INLET keeps toggling independently, exactly as the button does.
    const runKnob = knobs.running > 0.5;
    if (Number.isNaN(this.lastRunningKnob)) this.lastRunningKnob = runKnob;
    else if (runKnob !== this.lastRunningKnob) {
      this.lastRunningKnob = runKnob;
      this.toggleRun(bpmWired);
    }

    if (wired.run) {
      const state = this.runInputTrigger.process(signals.run);
      if (state !== 0) {
        if (this.momentaryRunInput) {
          if (state === 1) this.toggleRun(bpmWired);
        } else if ((this.running && state === -1) || (!this.running && state === 1)) {
          this.toggleRun(bpmWired);
        }
      }
    }

    if (this.resetTrigger.process(signals.reset)) {
      this.resetPulse.trigger(CLKD_PULSE_SECONDS);
      this.resetClkd(false, bpmWired, signals.bpm_cv);
    }

    this.newMasterLength = this.masterLength;
    if (bpmWired) {
      // D9: in DETECTION mode the inlet is a clock, so it is read as a level in volts;
      // in CV mode it is the tempo itself, in BPM.
      const detectVolts = signals.bpm_cv * RACK_VOLTS_PER_UNIT;
      const trigBpmInValue = this.bpmDetectTrigger.process(detectVolts);
      if (this.bpmDetectionMode) {
        if (trigBpmInValue) {
          if (!this.running) {
            this.running = true;
            this.runPulse.trigger(CLKD_PULSE_SECONDS);
            this.resetClkd(false, bpmWired, signals.bpm_cv);
            if (this.resetOnStartStop & ON_START_EXT_RST_MSK) this.resetPulse.trigger(CLKD_PULSE_SECONDS);
          }
          this.extPulseNumber++;
          if (this.extPulseNumber >= this.ppqn) this.extPulseNumber = 0;
          if (this.extPulseNumber === 0) {
            this.extIntervalTime = 0;
          } else {
            const timeLeft = (this.extIntervalTime * (this.ppqn - this.extPulseNumber)) / this.extPulseNumber;
            this.newMasterLength = clamp(
              this.clk[0].getStep() + timeLeft,
              this.masterLengthMin / CLKD_SYNC_RANGE_STRETCH,
              this.masterLengthMax * CLKD_SYNC_RANGE_STRETCH,
            );
            this.timeoutTime = this.extIntervalTime * ((1 + this.extPulseNumber) / this.extPulseNumber) + 0.1;
          }
        }
        if (this.running) {
          this.extIntervalTime += sampleTime;
          if (this.extIntervalTime > this.timeoutTime) {
            this.running = false;
            this.runPulse.trigger(CLKD_PULSE_SECONDS);
            if (this.resetOnStartStop & ON_STOP_INT_RST_MSK) this.resetClkd(false, bpmWired, signals.bpm_cv);
            if (this.resetOnStartStop & ON_STOP_EXT_RST_MSK) this.resetPulse.trigger(CLKD_PULSE_SECONDS);
          }
        }
      } else {
        this.newMasterLength = clamp(60 / signals.bpm_cv, this.masterLengthMin, this.masterLengthMax);
        if (this.extIntervalTime !== 0) this.extIntervalTime += sampleTime;
        if (trigBpmInValue) {
          if (this.extIntervalTime === 0) {
            this.extIntervalTime = sampleTime;
          } else if (this.extIntervalTime > CLKD_AUTO_P24_MIN_SECONDS && this.extIntervalTime < CLKD_AUTO_P24_MAX_SECONDS) {
            this.extIntervalTime = 0;
            this.bpmDetectionMode = true;
            this.ppqn = 24;
          } else {
            this.extIntervalTime = sampleTime;
          }
        }
      }
    } else {
      this.newMasterLength = clamp(60 / this.bufferedKnobs[3], this.masterLengthMin, this.masterLengthMax);
    }

    if (this.newMasterLength !== this.masterLength) {
      const lengthStretchFactor = this.newMasterLength / this.masterLength;
      for (let i = 0; i < 4; i++) this.clk[i].applyNewLength(lengthStretchFactor);
      this.masterLength = this.newMasterLength;
    }

    if (this.running) {
      if (this.clk[0].isReset()) {
        for (let i = 0; i < 3; i++) {
          if (this.syncRatios[i]) {
            this.clk[i + 1].reset();
            this.ratiosDoubled[i] = clkdRatioDoubled(this.bufferedKnobs[i]);
            this.syncRatios[i] = false;
          }
        }
        this.clk[0].setup(this.masterLength, 1, sampleTime);
        this.clk[0].start();
      }
      this.clkOutputs[0] = this.clk[0].isHigh() ? GATE_HIGH_VOLTS : 0;

      for (let i = 1; i < 4; i++) {
        if (this.clk[i].isReset()) {
          let ratioDoubled = this.ratiosDoubled[i - 1];
          let length;
          let iterations;
          if (ratioDoubled < 0) {
            ratioDoubled *= -1;
            length = (this.masterLength * ratioDoubled) / 2;
            iterations = 1 + (ratioDoubled % 2);
          } else {
            length = (2 * this.masterLength) / ratioDoubled;
            iterations = toInt(ratioDoubled / (2 - (ratioDoubled % 2)));
          }
          this.clk[i].setup(length, iterations, sampleTime);
          this.clk[i].start();
        }
        this.clkOutputs[i] = this.clk[i].isHigh() ? GATE_HIGH_VOLTS : 0;
      }

      for (let i = 0; i < 4; i++) this.clk[i].stepClock();
    }

    for (let i = 0; i < 4; i++) frame[i] = this.clkOutputs[i];
    frame[4] = this.resetPulse.process(sampleTime) ? GATE_HIGH_VOLTS : 0;
    frame[5] = this.runPulse.process(sampleTime) ? GATE_HIGH_VOLTS : 0;
    // D9: BPM out, in BPM. Their `log2f(0.5 / masterLength)` is the same quantity in
    // their volt domain; `60 / masterLength` is it in ours.
    frame[6] = bpmWired && !this.forceCvOnBpmOut ? signals.bpm_cv : 60 / this.masterLength;
  }
}
