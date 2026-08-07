/**
 * THE VC-8 KERNELS — eleven NYSTHI modules' arithmetic, and nothing else.
 *
 * No AudioNode, no AudioWorklet, no DOM: a plain ES module, so
 * `tests/port_vc8_test.js` can run every recurrence in BARE NODE. That is the
 * shape AX-2 and VC-3b set and the reason is the same — the arithmetic is the
 * deliverable, so the arithmetic must be reachable by a test that needs no
 * browser.
 *
 * `worklets/processors_vc8.js` imports this and wraps each kernel in an
 * AudioWorkletProcessor; `modules_vc8.js` wires those into engine modules.
 *
 * ⚠ THE WORKLET URL IS NOT HERE AND MUST NOT BE. `synth/worklet_urls.js` holds
 * every block's `?worker&url` specifier — read its header. A Vite specifier
 * anywhere in this import graph takes the entire bare-node test lane down.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * D0. THIS BLOCK HAS NO SOURCE. EVERY NODE HERE IS BEHAVIOUR-DERIVED.
 * ════════════════════════════════════════════════════════════════════════════
 * **NYSTHI SHIPS NO C++ AT ANY REF.** Verified 2026-08-06 on the pre-cloned
 * mirror `/tmp/r7_sources/nysthi` @ `f895816` ("Update CHANGELOG.md"): the
 * repository contains `README.md`, `CHANGELOG.md`, `changelog1.0.1_parsed.md`,
 * `.gitignore` and `images/` — `find . -name '*.cpp' -o -name '*.hpp'` returns
 * ZERO, on `master` and on all six tags (v2.1.19, v2.4.0arm64, v2.4.21,
 * v2.4.22, v2.4.23, v2.4.23special). The plugin is distributed as a binary.
 *
 * So NOTHING in this file is a transcription. Every kernel is an approximation
 * built from DOCUMENTS, and each one's docblock states, in this order:
 *
 *   1. **SOURCE** — the document, and the DATE it was read. `kind: behaviour`.
 *   2. **PORT-LAYOUT EVIDENCE** — separately, because the two are independent:
 *      the changelog gives NAMES and never jack ORDER, so a layout is proved (or
 *      not) by the demo patches' own cables. Which one fixed the layout is
 *      stated per node.
 *   3. **THE RECURRENCE AS IMPLEMENTED**, in float, so a wrong sound diffs
 *      against one line.
 *   4. **DEVIATIONS AND GUESSES, NAMED AND NUMBERED** — `D<n>` for a deliberate
 *      deviation from the documented behaviour, `G<n>` for a GUESS: something
 *      the documents do not state and that we chose. A `G` is not a deviation;
 *      it is an admission.
 *
 * The specs' `help` text says the same thing in plain words at the point of
 * use, because an author reading a card must be able to see that THIS module is
 * a documentation-derived approximation and not a port. Never imply a fidelity
 * that was not measured.
 *
 * ── THE DOCUMENTS, ALL OF THEM, READ 2026-08-06 ─────────────────────────────
 *
 *   CHANGELOG   `/tmp/r7_sources/nysthi/CHANGELOG.md` @ f895816. Documents
 *               SQUONK, SoyModelSOU, ClockableDelay, QuadPanner, Surveillance,
 *               the b208/208 family, the Serge Programmer, AttackDecay and the
 *               mix4 mixer CONTROL BY CONTROL. Cited by line number below.
 *   LPG PAPER   J. Parker and S. D'Angelo, "A Digital Model of the Buchla
 *               Lowpass-Gate", Proc. DAFx-13, Maynooth, pp. 278-285, 2013.
 *               THE CHANGELOG NAMES THIS PAPER AS THE b208 LPG's ALGORITHM
 *               (CHANGELOG.md:2573-2577, "the code is all based on … dafx13-lpg
 *               … thanks to Julian Parker and Stefano D'Angelo"). So for that
 *               one module the arithmetic is not guessed at all — it is a
 *               PUBLISHED model, and the equation numbers below are the paper's.
 *   CABLES      `core/audio_patches_vcv_fx.js` (P4 MICROCOSM v2, P22 Ciani's
 *               Buchla) and `core/audio_patches_vcv_classic.js`. Real harvested
 *               patch files; where a layout is proved, it is proved by these.
 *
 * ── D1. THE VOLTAGE LAW — ONE UNIT, STATED ONCE, APPLIED EVERYWHERE ─────────
 * R7-UNITS, and identical to VC-3b's D0 because a block may not re-litigate it.
 *
 *   **1.0 on a PowerRP audio wire IS 5 Rack volts.** `RACK_VOLTS_PER_UNIT = 5`.
 *   **1.0 on a gate/trigger wire IS 10 Rack volts.** `NYSTHI_GATE_VOLTS = 10`.
 *   **A `number` wire carrying a REAL QUANTITY is unscaled** — seconds are
 *   seconds, a 0…1 depth is a 0…1 depth, a stage index is a stage index.
 *
 * Every kernel below computes IN VOLTS and IN REAL UNITS, and the conversion
 * happens at exactly two places, both in `worklets/processors_vc8.js`: one read,
 * one write, off the per-port scale table its roster declares.
 *
 * **R7-UNITS CLAUSE 3 HAS NO SITE IN THIS BLOCK, AND THAT IS WORTH SAYING RATHER
 * THAN LEAVING TO INFERENCE.** Clause 3 governs V/oct pitch ports, which carry
 * SEMITONES. VC-8 contains no oscillator and no pitch inlet: LPGs, envelopes, a
 * panner, a delay, a mixer, a voltage bank and three sequencers whose CV outputs
 * are generic bipolar voltages, not pitches. So no port here is exempt from the
 * two scales above, and there is no per-family origin to choose. The moment this
 * block gains a V/oct port, that changes and the roster gains a `pitchPorts`
 * column exactly as VC-3b's has.
 *
 * ── D2. THERE IS NO CONTROL DIVIDER IN THIS BLOCK, ON PURPOSE ───────────────
 * R7-11's rule is "port the divisor, do not run it every sample for accuracy".
 * VC-3b has one because `src/module.cpp:22` states it. NYSTHI states no
 * `dsp::ClockDivider` anywhere — there is no source to state it in — so
 * INVENTING a divisor would be exactly the error R7-11 warns about, in the other
 * direction. Every kernel here therefore exposes `sample()` only, and the
 * processor's loop calls it once per sample with no `control()` split.
 *
 * ── D3. CV INPUTS ARE `audio` PORTS, NOT AudioParams (VC-3b's D3, same reason) ─
 * A NYSTHI CV law can branch on whether a cable is present — the QuadPanner's
 * documented context-menu mode is literally "uses 10V if no input"
 * (CHANGELOG.md:1255). No AudioParam can express that: one number cannot
 * distinguish "absent" from "zero". So every wireable inlet here is an `audio`
 * input at its own worklet input index and connectedness is `inputs[i].length >
 * 0`. Every kernel takes `wired` as an explicit map so the bare-node test can
 * drive both branches.
 *
 * ── D4. RANDOMNESS IS SEEDED (the project's determinism law) ────────────────
 * SoyModelSOU and SQUONK's RND both draw random values. `Math.random` is
 * forbidden here — `Δt = 0 ⟹ the frame is byte-identical`, and a document that
 * renders differently every time is not a document. `nysthiLcg` is the AX-2 SEED
 * pattern: a construct-time `seed` knob, one pure LCG, no wall clock anywhere.
 *
 * ── D5. PANEL BUTTONS AND MOUSE GESTURES ARE NOT PORTED ─────────────────────
 * VC-3b's D5, and NYSTHI has more of them: SQUONK's STAGE buttons and RANDOMIZE
 * ALL, the mixer's SOLO/MUTE buttons, the QuadPanner's XY pad, every "TAP"
 * control. A momentary press is not property state — it is not a function of
 * `[[slide, alpha]]` — and a latching version would be a different control. The
 * matching TRIG INPUTS carry the same signal and ARE ported wherever the port
 * contract declares one.
 *
 * ── D6. POLYPHONY IS NOT PORTED (VC-3b's D6) ────────────────────────────────
 * `PolyLPG` is the block's polyphonic module and our `audio` wire is MONO, so it
 * is the c = 0 voice. Nothing about its per-channel arithmetic differs; what is
 * lost is one cable carrying a chord. Reported to the lead rather than invented
 * around — a poly wire type is a document-model decision, not a port's.
 *
 * ── TWO MODULES ARE NOT HERE AT ALL, AND THAT IS THE HONEST ANSWER ──────────
 * `NYSTHI/Simpliciter` and `NYSTHI/complexSimpler` are WAV-file samplers — a
 * granular player and a 16-track recorder/player. There is no source, no
 * published grain algorithm, and no sample file: three independent gaps, any one
 * of which is fatal. A "granulator" that emitted anything at all would be a
 * fabrication wearing a famous name, and P4's five grain clouds would sound
 * wrong with nothing to say why. They are skipped and named in the report.
 */

// ════════════════════════════════════════════════════════════════════════════
// THE LAWS EVERY KERNEL IN THIS FILE OBEYS
// ════════════════════════════════════════════════════════════════════════════

/** D1: 1.0 on a PowerRP audio wire is this many Rack volts. */
export const RACK_VOLTS_PER_UNIT = 5;

/** D1: 1.0 on a gate/trigger wire is this many Rack volts. Logic is not level —
 *  VC-3b's argument, unchanged: a Rack patch's gate is a 10 V gate, and putting a
 *  full gate an order of magnitude clear of a 1 V Schmitt threshold is what makes
 *  an edge detector fire on a full gate and not on a rounding error. */
export const NYSTHI_GATE_VOLTS = 10;

/** The threshold a NYSTHI trigger inlet fires above, in volts. Rack's own
 *  `dsp::SchmittTrigger` default is 0.1 V low / 1 V high and every plugin that
 *  does not say otherwise uses it; nothing in the CHANGELOG says otherwise. */
export const TRIGGER_HIGH_VOLTS = 1;

/** …and falls back below, in volts. The hysteresis is what stops a noisy CV from
 *  clocking a sequencer twice on one edge. */
export const TRIGGER_LOW_VOLTS = 0.1;

/** A NYSTHI pulse output's width, in seconds. The CHANGELOG states it for the
 *  208 envelope — "a 1 msec PULSE is coming out every time the cycle is closed"
 *  (CHANGELOG.md:2689) — and that is the only width the documents give, so it is
 *  the one every pulse output in this block uses. G0: assumed uniform. */
export const NYSTHI_PULSE_SECONDS = 0.001;

/**
 * Pure function. Rack's `clamp`.
 *
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 *
 * @example nysthiClamp(3, 0, 1) // 1
 * @example nysthiClamp(-3, -1, 1) // -1
 * @example nysthiClamp(0.5, 0, 1) // 0.5
 */
export function nysthiClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pure function. One step of the block's seeded generator — D4.
 *
 * The same 32-bit LCG AX-2 uses (`seed·196314165 + 907633515`, Axoloti's own
 * constants), reused rather than a second generator invented, because two
 * generators is two things to seed and two things to get wrong. NYSTHI's real
 * randomness is `random::uniform()`, which is Rack's Xoroshiro seeded from the
 * system clock and is not reproducible even on the same machine — so there is no
 * bit-fidelity to lose here, only determinism to gain.
 *
 * @param {number} state - a uint32
 * @returns {number} the next uint32
 *
 * @example nysthiLcg(0) // 907633515
 * @example nysthiLcg(1) === (196314165 + 907633515) >>> 0 // true
 * @example nysthiLcg(nysthiLcg(0)) !== nysthiLcg(0) // true
 */
export function nysthiLcg(state) {
  return (Math.imul(state, 196314165) + 907633515) >>> 0;
}

/**
 * Pure function. A uint32 LCG state as a real in [0, 1).
 *
 * @param {number} state - a uint32
 * @returns {number}
 *
 * @example nysthiUnit(0) // 0
 * @example nysthiUnit(0xffffffff) < 1 // true
 * @example nysthiUnit(0x80000000) // 0.5
 */
export function nysthiUnit(state) {
  return state / 4294967296;
}

/**
 * A Schmitt trigger over a VOLTAGE, with Rack's own thresholds.
 *
 * Command (it carries an edge latch). One class rather than a boolean per
 * call-site because six kernels below need the identical hysteresis and a
 * hand-rolled `> 1` in each is six places for one of them to lose its low
 * threshold and double-clock.
 */
export class NysthiTrigger {
  constructor() {
    this.high = false;
  }

  /**
   * Command. Advance the latch and report whether THIS call is a rising edge.
   *
   * @param {number} volts
   * @returns {boolean} true exactly once per crossing of TRIGGER_HIGH_VOLTS
   */
  process(volts) {
    if (this.high) {
      if (volts <= TRIGGER_LOW_VOLTS) this.high = false;
      return false;
    }
    if (volts >= TRIGGER_HIGH_VOLTS) {
      this.high = true;
      return true;
    }
    return false;
  }
}

/**
 * A one-shot pulse generator, in seconds.
 *
 * Command. Every NYSTHI "PULSE OUT" in this block is one of these — see
 * NYSTHI_PULSE_SECONDS for why they all share one width.
 */
export class NysthiPulse {
  /** @param {number} sampleRate - hertz */
  constructor(sampleRate) {
    this.step = 1 / sampleRate;
    this.remaining = 0;
  }

  /** Command. Arm the pulse. */
  trigger() {
    this.remaining = NYSTHI_PULSE_SECONDS;
  }

  /**
   * Command. Advance one sample and return the pulse level in VOLTS.
   *
   * @returns {number} NYSTHI_GATE_VOLTS while high, 0 otherwise
   */
  process() {
    if (this.remaining <= 0) return 0;
    this.remaining -= this.step;
    return NYSTHI_GATE_VOLTS;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE BUCHLA LOWPASS-GATE — the one module in this block with a PUBLISHED model
// ════════════════════════════════════════════════════════════════════════════

/**
 * ── DERIVATION RECORD: `NYSTHI/b208_dualLPG` and `NYSTHI/PolyLPG` ───────────
 *
 * 1. SOURCE (`kind: behaviour`, but the ALGORITHM is published).
 *    - `CHANGELOG.md:2569-2589` @ f895816, read 2026-08-06, entry "DUAL DUAL LPG"
 *      (v0.6.38, 2019-01-19). It names the algorithm outright: *"the code is all
 *      based on … research.spa.aalto.fi/publications/papers/dafx13-lpg/ … thanks
 *      to Julian Parker and Stefano D'Angelo"*, plus *"3 Vactrol response models
 *      (actionable using contextual menu)"* and *"it's 2 times the section you
 *      have in the 208"* (hence FOUR LPGs: dual × dual).
 *    - J. Parker, S. D'Angelo, "A Digital Model of the Buchla Lowpass-Gate",
 *      Proc. DAFx-13, Maynooth, Ireland, Sept 2013, pp. 278-285. Read
 *      2026-08-06. Equation and table numbers below are that paper's.
 *    - `CHANGELOG.md:2329-2331`: *"POLY LPG … it's just one of the b208 dual dual
 *      LPG expanded and used in polyphonic mode; the CV IN is polyphonic too"* —
 *      which is why PolyLPG shares this kernel exactly rather than approximating
 *      it a second time.
 *    - Panel controls, `CHANGELOG.md:2582-2589`: *"red knobs selector for only
 *      VCA mode, VCA + LP mode, only LP mode"*; *"if in 'only LP mode' there is
 *      the RESO knob"*; *"IN for the signal to be filtered"*; *"OUT"*; *"the
 *      slider to the LEFT is the VCA for the incoming CV coming in from the BLACK
 *      socket"*; *"the slider on the right is the base level of action on the
 *      LPG"*.
 *
 * 2. PORT-LAYOUT EVIDENCE: **THE CABLES**, not the changelog. P22's harvested
 *    file wires `matrix.out4 → lpg.in_4`, `filt1.bp → lpg.in_1`,
 *    `filt2.bp → lpg.in_2`, `formant.out → lpg.in_3`, `env1.o2 → lpg.cv_1`,
 *    `env2.o2 → lpg.cv_2`, `env1.o5 → lpg.cv_3`, `env2.o5 → lpg.cv_4` and
 *    `lpg.out_1..out_4 → pan4/pan3/pan2/pan1`. Four audio in, four CV in, four
 *    out, index-aligned — the layout is proved by the patch and needs no guess.
 *    PolyLPG's `in`/`cv`/`out` are the same three jacks with the dual-dual
 *    numbering removed; its `level`/`response`/`offset` knob NAMES come from the
 *    Vult "Julste" module's documentation (vult-dsp Julste page, read
 *    2026-08-06), which is the SAME paper's model rewritten by its author's
 *    permission — "Range, Offset, Resonance, Sharpness". `response` is Julste's
 *    Sharpness: how much of the vactrol's lag is applied.
 *
 * 3. THE RECURRENCE AS IMPLEMENTED (all of it float, all of it per sample).
 *
 *    CONTROL PATH → LED CURRENT (paper Eq. 42, Fig. 8; **G1** below):
 *        i_f = clamp(cv_volts, 0, VC) / VC · IF_MAX
 *
 *    VACTROL (paper §3.2, Fig. 9) — a one-pole lag whose time constant is
 *    SWITCHED on the sign of the input's derivative, and then modulated by the
 *    lag's own current output so it responds faster when bright:
 *        τ      = (target > i ? TAU_RISE : TAU_FALL) / (1 + SPEEDUP · i/IF_MAX)
 *        i[n]   = i[n-1] + (target − i[n-1]) · (1 − exp(−h/τ))
 *    TAU_RISE = 12 ms and TAU_FALL = 250 ms are the paper's own datasheet values
 *    for the Perkin Elmer VTL5C3/2 (§3.2: *"approx 12ms in the positive-going
 *    direction and 250ms in the negative-going direction"*).
 *
 *    LDR CURRENT → RESISTANCE (paper Eq. 39, exactly):
 *        R_f = A / i_f^1.4 + B,  A = 3.464 Ω·A^1.4,  B = 1136.212 Ω
 *
 *    AUDIO PATH (paper Eqs. 5, 6 with the coefficient block under Eq. 6, and
 *    Table 1's component values). Two states, Vx and Vout:
 *        a1 = 1/(C1·Rf)          a2 = −(1/C1)·(1/Rf + 1/Rα)
 *        b1 = 1/(C2·Rf)          b2 = −2/(C2·Rf)
 *        b3 = 1/(C2·Rf)          b4 = C3/C2         d1 = a,  d2 = −1
 *        dVout/dt = a1·Vx + a2·Vout
 *        dVx/dt   = b1·Vin + b2·Vx + b3·Vout + b4·(d1·dVout/dt + d2·dVx/dt)
 *    Substituting Eq. 6 into Eq. 5 and collecting dVx/dt (d2 = −1):
 *        dVx/dt = [b1·Vin + (b2 + b4·a·a1)·Vx + (b3 + b4·a·a2)·Vout] / (1 + b4)
 *    which is `lpgDerivativeCoefficients` below, verbatim.
 *
 *    DISCRETIZATION: TOPOLOGY-PRESERVING, per paper §2.2.2, which is not a style
 *    choice — §2.2.1 measures the direct-form alternative DIVERGING TO INFINITY
 *    under modulation because collapsing C3's degenerate state changes the state
 *    transition matrix. Trapezoidal integration of the two states, with the
 *    resulting 2×2 implicit system solved in closed form each sample
 *    (`lpgTrapezoidStep`), and **2× oversampling as the paper recommends**
 *    (§2.2.1: *"we recommend oversampling the filter by a factor of 2"*, because
 *    the pole positions are a complicated function of Rf and Rα so pre-warping
 *    is not available).
 *
 *    MODES — Table 1 exactly:
 *        vca_lp ("Both",    both switches off): C3 = 0,     Rα = 5 MΩ
 *        vca    ("VCA")                       : C3 = 0,     Rα = 5 kΩ
 *        lp     ("Lowpass")                   : C3 = 4.7nF, Rα = 5 MΩ
 *    The NYSTHI panel's "only VCA / VCA + LP / only LP" maps onto those three in
 *    that order; **G2**.
 *
 *    RESONANCE: only reachable in `lp`, because `a` enters the system only
 *    through `b4 = C3/C2` and C3 is 0 in the other two — which is exactly what
 *    the panel says (*"if in 'only LP mode' there is the RESO knob"*). The knob
 *    scales the paper's Eq. 11 stability ceiling:
 *        a_max = (2·C1·Rα + (C2 + C3)·(Rα + Rf)) / (C3·Rα)
 *        a     = reso · a_max · RESO_HEADROOM
 *    Eq. 11's own sentence is *"When a > a_max, the poles of the circuit cross
 *    the imaginary axis and the system becomes unstable"*, so RESO_HEADROOM
 *    keeps a strictly under it; **G3** is its value.
 *
 * 4. DEVIATIONS AND GUESSES.
 *    G1. THE CONTROL-PATH CIRCUIT IS NOT PORTED, ONLY ITS SHAPE. Paper Eq. 42 is
 *        a four-case piecewise function of Ia through a zener (V_B = 3.9 V), two
 *        Lambert-W approximations (Eqs. 36, 38) and eight component constants
 *        (γ, G, α, β, R6, R7, R8, R9) that the paper does not tabulate. What IS
 *        given is Fig. 8's picture: monotone, near-zero below the knee, and
 *        saturating at If_max = 40 mA (§3.1's own bound, *"If,max = 40mA"*). A
 *        clamped linear ramp to that ceiling is the honest reduction. It is a
 *        GUESS: the real curve's knee shape near V_B is not reproduced, so the
 *        LPG's response to small CV values is softer here than on hardware.
 *    G2. THE THREE-MODE MAPPING. The paper's columns are "Both", "VCA",
 *        "Lowpass"; NYSTHI's selector reads "only VCA", "VCA + LP", "only LP".
 *        The bijection above is the only sensible one, but it is not stated by
 *        either document.
 *    G3. RESO_HEADROOM. The paper gives the instability ceiling and no taper.
 *    G4. THE THREE VACTROL RESPONSE MODELS ARE NOT PORTED. The changelog says
 *        *"I've added also 3 Vactrol response models … the 3 response are always
 *        a little variations, every new instance will be little bit different"* —
 *        a per-instance RANDOM perturbation of the time constants. The variation
 *        amounts are not documented, and a random one would violate the
 *        determinism law; `response` (PolyLPG) and the shared TAU pair are the
 *        one model here. A seeded per-instance jitter is a defensible future
 *        addition and is NOT pretended to exist now.
 *    D7. VCA MODE'S 4-5 dB INPUT GAIN IS NOT APPLIED. Paper §2: *"In the real
 *        circuits, the 'VCA' switch also changes the input op-amp configuration
 *        (not shown) so that it has a gain of 4-5dB instead of unity, presumably
 *        to normalize loudness between the modes."* The paper models neither the
 *        op-amp nor the gain, so neither do we; switching to VCA mode is
 *        therefore about 4 dB quieter here than on hardware. Named rather than
 *        silently compensated, because a compensation would be OUR number.
 *    D8. THE NONLINEAR AUDIO PATH IS NOT PORTED. §2.3 adds saturating
 *        nonlinearities in the vactrol's resistive parts and the op-amps and
 *        measures their harmonics; this is the LINEAR model of §2.1-2.2, which is
 *        the one the paper itself calls robust under modulation. The audible cost
 *        is the "quite aggressive character" §4 attributes to the nonlinear
 *        version at high resonance.
 */

/** Paper Table 1: C1, in farads. Identical in all three modes. */
const LPG_C1 = 1e-9;

/** Paper Table 1: C2, in farads. Identical in all three modes. */
const LPG_C2 = 220e-12;

/** Paper Table 1: C3 in 'Lowpass' mode, in farads. Zero in the other two, which
 *  is what "disengages the feedback" means (paper §2, above Table 1). */
const LPG_C3_LOWPASS = 4.7e-9;

/** Paper Table 1: Rα in 'Both' and 'Lowpass' modes, in ohms — high enough that
 *  no potential divider forms, so the circuit only filters. */
const LPG_RA_OPEN = 5e6;

/** Paper Table 1: Rα in 'VCA' mode, in ohms. THIS is the VCA: a low shunt makes
 *  Rf/Rα a potential divider, so raising Rf attenuates instead of filtering. */
const LPG_RA_VCA = 5e3;

/** Paper Eq. 39's A, in Ω·A^1.4 — the LDR's current-to-resistance fit. */
const LPG_RF_A = 3.464;

/** Paper Eq. 39's B, in ohms — the LDR's floor resistance at infinite current. */
const LPG_RF_B = 1136.212;

/** Paper Eq. 39's exponent. */
const LPG_RF_EXPONENT = 1.4;

/** Paper §3.1: `If,max = 40mA`, the point at which the control op-amp saturates. */
const LPG_IF_MAX = 0.04;

/** The smallest LED current the model evaluates Eq. 39 at, in amperes. Eq. 39
 *  diverges at zero current, so a floor is REQUIRED, not a fallback: this one is
 *  10^-6 of full scale, which puts Rf at 3.5 GΩ — far past the 1 MΩ the paper's
 *  own Fig. 2 sweeps, i.e. fully closed by any measure. */
const LPG_IF_MIN = LPG_IF_MAX * 1e-6;

/** Paper §3.2: the vactrol's positive-going response time, in seconds, from the
 *  VTL5C3/2 datasheet. */
const LPG_TAU_RISE = 0.012;

/** Paper §3.2: the negative-going response time, in seconds. Twenty times the
 *  rise — this asymmetry IS the lowpass gate's plucked character. */
const LPG_TAU_FALL = 0.250;

/** Paper §3.2: *"This chosen value is then modulated further by the current
 *  output value of the vactrol model, so that it responds quicker when at high
 *  values, as also indicated on the datasheet."* The paper states the effect and
 *  not its strength, so the strength is G5: at full brightness the vactrol is
 *  this many times faster than at rest. */
const LPG_TAU_SPEEDUP = 3;

/** G3: how close to Eq. 11's instability ceiling the RESO knob's top reaches. */
const LPG_RESO_HEADROOM = 0.95;

/** Paper §2.2.1: *"we recommend oversampling the filter by a factor of 2"*. */
const LPG_OVERSAMPLE = 2;

/** The LPG's three modes, in the panel's own order (CHANGELOG.md:2582). Exported
 *  because the spec must restate this list and `tests/port_vc8_test.js` pins the
 *  restatement against this one. */
export const LPG_MODES = ["vca", "vca_lp", "lp"];

/**
 * Pure function. Paper Eq. 39 — the vactrol LDR's resistance at a given LED
 * current.
 *
 * @param {number} current - LED current, amperes
 * @returns {number} R_f in ohms
 *
 * @example // fully open: 40 mA puts the LDR near its floor
 * @example Math.round(lpgResistance(0.04)) // 1450
 * @example // and the fit's B is the floor it approaches
 * @example lpgResistance(1e9) > 1136 // true
 * @example // one tenth the current: the A term climbs by 10^1.4 = 25x, but B
 * @example // does not move, so the TOTAL only rises about six-fold near the top
 * @example Math.round(lpgResistance(0.004)) // 9019
 */
export function lpgResistance(current) {
  const clamped = current < LPG_IF_MIN ? LPG_IF_MIN : current;
  return LPG_RF_A / clamped ** LPG_RF_EXPONENT + LPG_RF_B;
}

/**
 * Pure function. G1 — the control path's CV-to-LED-current curve, reduced to
 * Fig. 8's shape: zero below zero, linear, saturating at If_max.
 *
 * @param {number} volts - the CV reaching the LED driver
 * @returns {number} LED current in amperes, in [0, LPG_IF_MAX]
 *
 * @example lpgLedCurrent(0) // 0
 * @example lpgLedCurrent(10) // 0.04
 * @example lpgLedCurrent(5) // 0.02
 * @example // negative CV cannot light an LED
 * @example lpgLedCurrent(-3) // 0
 */
export function lpgLedCurrent(volts) {
  return nysthiClamp(volts / NYSTHI_GATE_VOLTS, 0, 1) * LPG_IF_MAX;
}

/**
 * Pure function. Paper Eq. 11 — the feedback gain at which the poles cross the
 * imaginary axis. Above this the filter is unstable.
 *
 * @param {number} rf - vactrol resistance, ohms
 * @param {number} ra - the mode's Rα, ohms
 * @param {number} c3 - the mode's C3, farads
 * @returns {number} a_max, or Infinity when C3 is 0 (no feedback path exists)
 *
 * @example lpgMaxFeedback(1450, 5e6, 0) // Infinity
 * @example lpgMaxFeedback(1450, 5e6, 4.7e-9) > 1 // true
 */
export function lpgMaxFeedback(rf, ra, c3) {
  if (c3 === 0) return Infinity;
  return (2 * LPG_C1 * ra + (LPG_C2 + c3) * (ra + rf)) / (c3 * ra);
}

/**
 * Pure function. The two state derivatives' coefficients, from paper Eqs. 5 and
 * 6 with Eq. 6 substituted into Eq. 5 and dVx/dt collected (d2 = −1).
 *
 * Returns `{p1, p2, p3, a1, a2}` where
 *   dVx/dt   = p1·Vin + p2·Vx + p3·Vout
 *   dVout/dt = a1·Vx  + a2·Vout
 *
 * @param {number} rf - vactrol resistance, ohms
 * @param {number} ra - the mode's Rα, ohms
 * @param {number} c3 - the mode's C3, farads
 * @param {number} a - the feedback amplifier gain (paper's `a`, Eq. 2)
 * @returns {{p1: number, p2: number, p3: number, a1: number, a2: number}}
 *
 * @example // with no feedback capacitor the Vx equation is the bare Eq. 5
 * @example lpgDerivativeCoefficients(1e6, 5e6, 0, 0).p2 === -2 * lpgDerivativeCoefficients(1e6, 5e6, 0, 0).p1 // true
 * @example // a1 is 1/(C1·Rf) exactly
 * @example lpgDerivativeCoefficients(1e6, 5e6, 0, 0).a1 // 1000
 */
export function lpgDerivativeCoefficients(rf, ra, c3, a) {
  const a1 = 1 / (LPG_C1 * rf);
  const a2 = -(1 / LPG_C1) * (1 / rf + 1 / ra);
  const b1 = 1 / (LPG_C2 * rf);
  const b2 = -2 / (LPG_C2 * rf);
  const b3 = 1 / (LPG_C2 * rf);
  const b4 = c3 / LPG_C2;
  const scale = 1 / (1 + b4);
  return {
    p1: b1 * scale,
    p2: (b2 + b4 * a * a1) * scale,
    p3: (b3 + b4 * a * a2) * scale,
    a1,
    a2,
  };
}

/**
 * Pure function. One trapezoidal step of the two-state system — paper §2.2.2's
 * topology-preserving discretization, solved in closed form.
 *
 * Trapezoidal rule on both states gives an implicit 2×2 system
 *   [1 − h·p2/2   −h·p3/2] [Vx ]   [Vx_o + (h/2)(f1_o + p1·Vin)]
 *   [  −h·a1/2  1 − h·a2/2] [Vout] = [Vout_o + (h/2)·f2_o        ]
 * whose inverse is written out rather than looped, because this runs per
 * oversampled sample on the audio thread.
 *
 * @param {{p1: number, p2: number, p3: number, a1: number, a2: number}} k - lpgDerivativeCoefficients
 * @param {number} h - the step, seconds
 * @param {number} vx - Vx at n−1
 * @param {number} vout - Vout at n−1
 * @param {number} vinNow - Vin at n
 * @param {number} vinPrev - Vin at n−1
 * @returns {{vx: number, vout: number}}
 *
 * @example // a zero state driven by zero input stays at zero
 * @example lpgTrapezoidStep(lpgDerivativeCoefficients(1e6, 5e6, 0, 0), 1 / 96000, 0, 0, 0, 0) // {vx: 0, vout: 0}
 * @example // and a step input starts the two states moving
 * @example lpgTrapezoidStep(lpgDerivativeCoefficients(1e6, 5e6, 0, 0), 1 / 96000, 0, 0, 1, 0).vx > 0 // true
 */
export function lpgTrapezoidStep(k, h, vx, vout, vinNow, vinPrev) {
  const half = h / 2;
  const f1Prev = k.p1 * vinPrev + k.p2 * vx + k.p3 * vout;
  const f2Prev = k.a1 * vx + k.a2 * vout;
  const r1 = vx + half * (f1Prev + k.p1 * vinNow);
  const r2 = vout + half * f2Prev;
  const m11 = 1 - half * k.p2;
  const m12 = -half * k.p3;
  const m21 = -half * k.a1;
  const m22 = 1 - half * k.a2;
  const det = m11 * m22 - m12 * m21;
  return {
    vx: (r1 * m22 - m12 * r2) / det,
    vout: (m11 * r2 - m21 * r1) / det,
  };
}

/**
 * ONE BUCHLA LOWPASS GATE — the vactrol plus the two-state audio path.
 *
 * Command (it advances three states: the vactrol current, Vx and Vout). Shared
 * by `B208DualLpgKernel` (four of them) and `PolyLpgKernel` (one), because
 * CHANGELOG.md:2330 says PolyLPG IS this section — approximating it twice would
 * be two things to get differently wrong.
 */
export class LpgVoice {
  /** @param {number} sampleRate - hertz */
  constructor(sampleRate) {
    this.step = 1 / (sampleRate * LPG_OVERSAMPLE);
    this.current = 0;
    this.vx = 0;
    this.vout = 0;
    this.vinPrev = 0;
  }

  /**
   * Command. Advance the vactrol one HOST sample toward a CV, and return its LED
   * current. Split out from `process` so the test can drive the vactrol's
   * asymmetric envelope on its own, which is the thing the paper actually
   * specifies numerically.
   *
   * @param {number} cvVolts - the control voltage reaching the LED driver
   * @param {number} response - 0…1, how much of the vactrol's lag applies (G6)
   * @returns {number} LED current in amperes
   */
  advanceVactrol(cvVolts, response) {
    const target = lpgLedCurrent(cvVolts);
    const rising = target > this.current;
    const base = rising ? LPG_TAU_RISE : LPG_TAU_FALL;
    // Paper §3.2: the chosen constant is modulated by the vactrol's own output.
    const tau = (base / (1 + LPG_TAU_SPEEDUP * (this.current / LPG_IF_MAX))) * response;
    // G6: `response` scales the time constant rather than crossfading the
    // output, so `response = 0` is an instantaneous (ideal) VCA and 1 is the
    // datasheet vactrol. Julste calls this Sharpness and documents its ENDS
    // ("full left, the gate will follow quickly the gate signal; full right it
    // will behave more like an envelope") but not its law, so the law is ours.
    if (tau <= this.step) {
      this.current = target;
    } else {
      this.current += (target - this.current) * (1 - Math.exp(-this.step / tau));
    }
    return this.current;
  }

  /**
   * Command. Filter one host sample.
   *
   * @param {number} inVolts - the signal, in volts
   * @param {number} cvVolts - the control voltage, in volts
   * @param {number} mode - an index into LPG_MODES
   * @param {number} reso - 0…1, only reachable in `lp` (see the record's item 3)
   * @param {number} response - 0…1 vactrol lag depth (G6)
   * @returns {number} the filtered signal, in volts
   */
  process(inVolts, cvVolts, mode, reso, response) {
    const current = this.advanceVactrol(cvVolts, response);
    const rf = lpgResistance(current);
    const name = LPG_MODES[mode];
    if (name === undefined) throw new Error(`LpgVoice: mode index ${mode} is not one of LPG_MODES`);
    const ra = name === "vca" ? LPG_RA_VCA : LPG_RA_OPEN;
    const c3 = name === "lp" ? LPG_C3_LOWPASS : 0;
    const ceiling = lpgMaxFeedback(rf, ra, c3);
    const a = c3 === 0 ? 0 : reso * ceiling * LPG_RESO_HEADROOM;
    const k = lpgDerivativeCoefficients(rf, ra, c3, a);
    // 2× oversampling (paper §2.2.1). The host sample is held across both
    // sub-steps — a zero-order hold, which is what an oversampled block with no
    // interpolating upsampler does, and the alias it leaves is above the host
    // Nyquist where the two-pole response is already down.
    for (let n = 0; n < LPG_OVERSAMPLE; n++) {
      const next = lpgTrapezoidStep(k, this.step, this.vx, this.vout, inVolts, this.vinPrev);
      this.vx = next.vx;
      this.vout = next.vout;
      this.vinPrev = inVolts;
    }
    return this.vout;
  }
}

/**
 * `NYSTHI/b208_dualLPG` — FOUR Buchla lowpass gates ("dual dual").
 *
 * Command. See LpgVoice's docblock for the whole derivation record; this class
 * is only the four-way fan-out and the panel's two sliders per channel.
 */
export class B208DualLpgKernel {
  /** @param {number} sampleRate - hertz */
  constructor(sampleRate) {
    this.voices = [new LpgVoice(sampleRate), new LpgVoice(sampleRate), new LpgVoice(sampleRate), new LpgVoice(sampleRate)];
    this.modes = [1, 1, 1, 1];
  }

  /**
   * Command. Set one channel's mode. Four setters rather than one indexed call
   * because `vc8OptionSetter` derives a method name from a knob key, and the
   * knobs are per channel.
   *
   * @param {string} value - one of LPG_MODES
   * @param {number} channel - 0…3
   */
  setChannelMode(value, channel) {
    const index = LPG_MODES.indexOf(value);
    if (index < 0) throw new Error(`b208_dualLPG: unknown mode ${JSON.stringify(value)}`);
    this.modes[channel] = index;
  }

  /** Command. Channel 1's mode. */
  setMode1(value) { this.setChannelMode(value, 0); }

  /** Command. Channel 2's mode. */
  setMode2(value) { this.setChannelMode(value, 1); }

  /** Command. Channel 3's mode. */
  setMode3(value) { this.setChannelMode(value, 2); }

  /** Command. Channel 4's mode. */
  setMode4(value) { this.setChannelMode(value, 3); }

  /**
   * Command. One sample of all four gates.
   *
   * @param {object} knobs - level_1..4, cv_amount_1..4, reso_1..4, response_1..4
   * @param {object} signals - in_1..4, cv_1..4, in volts
   * @param {object} wired - unused here; the LPG has no documented isConnected law
   * @param {Float64Array} frame - out_1..4, written in place
   */
  sample(knobs, signals, wired, frame) {
    for (let n = 0; n < 4; n++) {
      const i = n + 1;
      // The panel: the LEFT slider attenuates the BLACK CV socket, the RIGHT
      // slider is the gate's base level. They SUM in the control domain — a base
      // level with no cable holds the gate part-open, which is what "base level
      // of action on the LPG" means.
      const cv = signals[`cv_${i}`] * knobs[`cv_amount_${i}`] + knobs[`level_${i}`] * NYSTHI_GATE_VOLTS;
      frame[n] = this.voices[n].process(signals[`in_${i}`], cv, this.modes[n], knobs[`reso_${i}`], knobs[`response_${i}`]);
    }
  }
}

/**
 * `NYSTHI/PolyLPG` — ONE Buchla lowpass gate, D6's mono voice of a polyphonic
 * module.
 *
 * Command. CHANGELOG.md:2330: *"it's just one of the b208 dual dual LPG expanded
 * and used in polyphonic mode; the CV IN is polyphonic too"* — so this shares
 * `LpgVoice` exactly. What is LOST is the poly cable: on hardware one CV cable
 * carries up to sixteen channels and opens sixteen gates. Reported to the lead.
 */
export class PolyLpgKernel {
  /** @param {number} sampleRate - hertz */
  constructor(sampleRate) {
    this.voice = new LpgVoice(sampleRate);
    this.mode = 1;
  }

  /** Command. Set the gate's mode. @param {string} value - one of LPG_MODES */
  setMode(value) {
    const index = LPG_MODES.indexOf(value);
    if (index < 0) throw new Error(`PolyLPG: unknown mode ${JSON.stringify(value)}`);
    this.mode = index;
  }

  /**
   * Command. One sample.
   *
   * @param {object} knobs - level, response, offset, reso
   * @param {object} signals - in, cv, in volts
   * @param {object} wired - unused
   * @param {Float64Array} frame - out, written in place
   */
  sample(knobs, signals, wired, frame) {
    // Julste's documented control set: Range attenuates/amplifies the gate CV,
    // Offset adds to it, so the pair sets the gate's minimum and maximum.
    const cv = signals.cv * knobs.level + knobs.offset * NYSTHI_GATE_VOLTS;
    frame[0] = this.voice.process(signals.in, cv, this.mode, knobs.reso, knobs.response);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE ENVELOPES
// ════════════════════════════════════════════════════════════════════════════

/** An envelope's stages, as an integer state. Named because a bare 0/1/2/3 in a
 *  DSP loop is the magic number this project bans. */
const ENV_IDLE = 0;
const ENV_ATTACK = 1;
const ENV_HOLD = 2;
const ENV_DECAY = 3;

/** The 208 envelope's own peak, in volts: CHANGELOG.md:2692, *"ENV OUT … Value
 *  goes from 0v to 10v"*. */
const ENV_PEAK_VOLTS = 10;

/** The shortest stage the 208's sliders reach, in seconds (CHANGELOG.md:2694,
 *  *"ATTACK from 2 msecs to 10 secs"*). Also its floor: a zero-length stage would
 *  divide by zero. */
const ENV_MIN_SECONDS = 0.002;

/** The longest (same line). */
const ENV_MAX_SECONDS = 10;

/** How hard the LIN-EXP control bends at full travel. The documents give the
 *  control's ENDS and not its law, so this is G7; `e^4` is the conventional
 *  analogue-envelope bend and puts the half-way point at 0.17 rather than 0.5. */
const ENV_CURVE_STRENGTH = 4;

/**
 * Pure function. The exponential/linear blend both NYSTHI envelopes' LIN-EXP
 * control sweeps, applied to a 0…1 stage phase.
 *
 * `curve = 0` is the straight line, `curve = 1` is a strongly exponential rise
 * (and, on a falling stage, the familiar RC-shaped decay).
 *
 * @param {number} phase - 0…1 through the stage
 * @param {number} curve - 0 (linear) … 1 (exponential)
 * @returns {number} 0…1
 *
 * @example envShape(0, 1) // 0
 * @example envShape(1, 1) // 1
 * @example envShape(0.5, 0) // 0.5
 * @example // exponential lags the line in the first half…
 * @example envShape(0.5, 1) < 0.5 // true
 */
export function envShape(phase, curve) {
  if (curve <= 0) return phase;
  const bent = (Math.exp(ENV_CURVE_STRENGTH * phase) - 1) / (Math.exp(ENV_CURVE_STRENGTH) - 1);
  return phase + (bent - phase) * curve;
}

/**
 * ── DERIVATION RECORD: `NYSTHI/AttackDecay` ("AD Envelope") ─────────────────
 *
 * 1. SOURCE: `CHANGELOG.md:4999-5013` @ f895816, read 2026-08-06, entry
 *    "AD Envelope (AttackDecay Envelope)" (v0.4.10, 2017-11-12) —
 *    *"A standard Envelope with some 281 features"* (Buchla 281 Quad Function
 *    Generator). Its control list, verbatim: ATTACK (timing attack from 0 to 10
 *    secs); ATTACK CV (*"accept also negative values like, will be subtracted
 *    form the main value"*); DECAY (0 to 10 secs); DECAY CV; LIN-EXP curve
 *    modifier; SCALE (*"can scale Envelope for -2x to 2x"*, used to invert);
 *    TRIG BTN; TRIG IN; LOOP button (*"to have a cyclable AD"*); EOC
 *    (*"triggers out when the Envelope reach the stable phase"*); ENV LEVEL LED;
 *    ENV OUT. Cross-checked against `CHANGELOG.md:4406-4419` ("8 ATTACK DECAY",
 *    the eight-channel sibling), which lists the same controls plus an
 *    end-of-rise pulse.
 *    `kind: behaviour`.
 *
 * 2. PORT-LAYOUT EVIDENCE: the STUB's harvested port names
 *    (`attack_cv`, `decay_cv`, `retrig`, `trig` in; `out`, `eoc` out) are all
 *    four controls the changelog names as jacks, so the changelog CONFIRMS the
 *    names and the harvest supplies the order. `retrig` is the one name the
 *    changelog does not carry; the 8-channel sibling's *"TAP to single TRIG"* and
 *    *"IN PULSE to SINGLE TRIG"* are two ways into one envelope, which is what a
 *    second trigger jack beside `trig` would be, so it is treated as a second
 *    trigger inlet that ALSO restarts a running envelope. **G8.**
 *
 * 3. THE RECURRENCE (per sample, `h = 1/fs`):
 *      attack  = clamp(attackKnob  + attackCv,  0.002, 10)   seconds
 *      decay   = clamp(decayKnob   + decayCv,   0.002, 10)   seconds
 *      ATTACK: φ += h/attack;  out = 10·scale·envShape(φ, curve)
 *      DECAY : φ += h/decay ;  out = 10·scale·envShape(1 − φ, curve)
 *      at the end of DECAY: emit a 1 ms EOC pulse, and if LOOP, re-enter ATTACK.
 *    The CV ADDS to the knob, which is the changelog's own sentence — *"accept
 *    also negative values like, will be subtracted form the main value"* is a
 *    signed SUM, not a multiply. So `attack`/`attack_cv` is one of the cases
 *    R7's `_cv` rule calls an ADDING CV, and the pair is named accordingly.
 *
 * 4. DEVIATIONS AND GUESSES.
 *    G9. THE TIME UNIT OF THE HARVESTED DIALS. The patches store `p0`/`p1`
 *        (0.4365, 0.1, 0.106, 0.292). The changelog says the dials read 0…10
 *        seconds; whether the SAVED value is seconds or a 0…1 knob position is
 *        not knowable without the source. R7-UNITS clause 2 requires the real
 *        unit either way, so the knobs are SECONDS — and under that reading the
 *        harvested numbers are 100…440 ms, which is a musically sane envelope.
 *        The rename is reported to the lead: `p0 → attack`, `p1 → decay`.
 *    G7. The LIN-EXP law (see `envShape`).
 *    G8. `retrig` (above).
 *    D9. THE TRIG BUTTON AND THE LOOP BUTTON. The trig BUTTON is D5's momentary
 *        press and is dropped; the LOOP button is a LATCHING switch, so it is
 *        property state and IS ported, as the `loop` knob.
 */
export class AttackDecayKernel {
  /** @param {number} sampleRate - hertz */
  constructor(sampleRate) {
    this.step = 1 / sampleRate;
    this.trig = new NysthiTrigger();
    this.retrig = new NysthiTrigger();
    this.eoc = new NysthiPulse(sampleRate);
    this.stage = ENV_IDLE;
    this.phase = 0;
    this.loop = 0;
  }

  /**
   * Command. One sample.
   *
   * @param {object} knobs - attack, decay, curve, scale, loop (all real units)
   * @param {object} signals - attack_cv, decay_cv (seconds), retrig, trig (volts)
   * @param {object} wired - unused
   * @param {Float64Array} frame - [out, eoc], written in place
   */
  sample(knobs, signals, wired, frame) {
    const fired = this.trig.process(signals.trig) || this.retrig.process(signals.retrig);
    if (fired) {
      this.stage = ENV_ATTACK;
      this.phase = 0;
    }
    const attack = nysthiClamp(knobs.attack + signals.attack_cv, ENV_MIN_SECONDS, ENV_MAX_SECONDS);
    const decay = nysthiClamp(knobs.decay + signals.decay_cv, ENV_MIN_SECONDS, ENV_MAX_SECONDS);
    let level = 0;
    if (this.stage === ENV_ATTACK) {
      this.phase += this.step / attack;
      if (this.phase >= 1) {
        this.phase = 0;
        this.stage = ENV_DECAY;
        level = 1;
      } else {
        level = envShape(this.phase, knobs.curve);
      }
    } else if (this.stage === ENV_DECAY) {
      this.phase += this.step / decay;
      if (this.phase >= 1) {
        this.phase = 0;
        this.eoc.trigger();
        this.stage = knobs.loop >= 0.5 ? ENV_ATTACK : ENV_IDLE;
        level = 0;
      } else {
        level = envShape(1 - this.phase, knobs.curve);
      }
    }
    frame[0] = level * ENV_PEAK_VOLTS * knobs.scale;
    frame[1] = this.eoc.process();
  }
}

/**
 * ── DERIVATION RECORD: `NYSTHI/b208_envelope` (DUAL (208) ENVELOPE) ─────────
 *
 * 1. SOURCE: `CHANGELOG.md:2683-2698` @ f895816, read 2026-08-06, entry
 *    "DUAL (208) ENVELOPE" (v0.6.35, 2018-12-19), which is a complete panel
 *    walk: *"it's a copy of the 208 envelope, 2 times"*; *"GATE/TRIG IN (+TAP) …
 *    is a GATE IN if in 'sustained' mode and a TRIG IN if in 'transient' mode"*;
 *    *"EndOFCycle Pulse OUT (+LED): a 1 msec PULSE is coming out every time the
 *    cycle is closed, can be used to retrig the envelope to have an LFO/VCO"*;
 *    *"SUST - TRANS radio button"*; *"ENV OUT … Value goes from 0v to 10v"*;
 *    *"ATTACK from 2 msecs to 10 secs, CV controllable"*; *"DURATION, only
 *    working if in transient mode, is the time the ENV stays to 10v when the
 *    ATTACK phase is finished"*; *"DECAY from 2 msecs to 10 secs, CV
 *    controllable"*. `kind: behaviour`. This is the Buchla Music Easel's 208
 *    envelope, so the shape is also cross-checkable against published Easel
 *    behaviour: attack, sustain-while-gated or fixed duration, decay.
 *
 * 2. PORT-LAYOUT EVIDENCE: **THE CABLES, AND THEY GIVE THE STRIDE.** P22 wires
 *    `i0` and `i4` (both TRIGGERS) and `i3` and `i7` (both NUMBERS). Two pairs,
 *    each exactly four apart, each pair sharing a type. A DUAL module whose
 *    section stride is FOUR is the only reading that makes those four cables one
 *    pattern — so inputs are two banks of four, and `i0`/`i4` are the two
 *    sections' GATE/TRIG jacks. Outputs: `o2` and `o5` are three apart and both
 *    drive continuous targets (an LPG's CV and a filter cutoff), and the patch's
 *    DROPPED self-patch is `o4 → i4` — an end-of-cycle pulse into section two's
 *    own trigger, which the changelog names as the LFO trick. A stride of THREE
 *    with EOC at offset 1 and ENV at offset 2 satisfies all of it. The remaining
 *    slot per section (`o0`, `o3`) is the 8-channel sibling's *"End OF RISE
 *    (attack) PULSE OUT"* (`CHANGELOG.md:4415`). **This whole layout is an
 *    INFERENCE from four cables plus one dropped one — G10 — which is why the
 *    port KEYS stay as indices.** A plausible name in the key would make a guess
 *    look resolved; the LABEL carries the inference and the key carries the fact.
 *
 * 3. THE RECURRENCE (per sample, per section, `h = 1/fs`):
 *      attack   = clamp(attackKnob + attackCv, 0.002, 10)
 *      duration = clamp(durationKnob + durationCv, 0.002, 10)
 *      decay    = clamp(decayKnob + decayCv, 0.002, 10)
 *      ATTACK : φ += h/attack ; out = 10·envShape(φ, curve)
 *      HOLD   : transient → φ += h/duration and fall through at φ ≥ 1
 *               sustained → hold at 10 V while the GATE is high
 *      DECAY  : φ += h/decay  ; out = 10·envShape(1 − φ, curve)
 *               at the end: EOR was already emitted; emit the 1 ms EOC pulse.
 *
 * 4. DEVIATIONS AND GUESSES.
 *    G10. The whole port layout (above).
 *    G11. THE THREE PER-SECTION CV INLETS. The changelog says ATTACK and DECAY
 *         are *"CV controllable"* and says nothing about DURATION. Four inputs
 *         per section is what the stride proves, and [gate, attack, duration,
 *         decay] is the panel's own top-to-bottom order, so `i3`/`i7` land on
 *         DECAY — which is what the patch's four hand-set Surveillance voltages
 *         then are. If the fourth jack is something else, `i3` is mislabelled and
 *         the sound is a wrong decay time, not a wrong topology.
 *    D10. THE SELF-PATCH IS NOT AN INTERNAL LOOP. `o4 → i4` is a CABLE, and
 *         `core/nodeflow.js` refuses a cycle, so P22 drops it. This kernel does
 *         NOT add an internal loop switch to compensate: that would be inventing
 *         a control the panel does not have. The loss is recorded in the patch's
 *         own deviations.
 *    D5.  The TAP buttons are not ported.
 */
export class B208EnvelopeKernel {
  /** @param {number} sampleRate - hertz */
  constructor(sampleRate) {
    this.step = 1 / sampleRate;
    this.sections = [0, 1].map(() => ({
      trigger: new NysthiTrigger(),
      eor: new NysthiPulse(sampleRate),
      eoc: new NysthiPulse(sampleRate),
      stage: ENV_IDLE,
      phase: 0,
    }));
    this.sustained = [false, false];
  }

  /**
   * Command. Set one section's SUST/TRANS radio button.
   *
   * @param {string} value - "sustained" or "transient"
   * @param {number} index - 0 or 1
   */
  setSectionMode(value, index) {
    if (value !== "sustained" && value !== "transient") {
      throw new Error(`b208_envelope: unknown mode ${JSON.stringify(value)}`);
    }
    this.sustained[index] = value === "sustained";
  }

  /** Command. Section 1's SUST/TRANS radio button. */
  setMode1(value) { this.setSectionMode(value, 0); }

  /** Command. Section 2's SUST/TRANS radio button. */
  setMode2(value) { this.setSectionMode(value, 1); }

  /**
   * Command. One sample of both sections.
   *
   * @param {object} knobs - attack_1/duration_1/decay_1/curve_1 and the _2 set
   * @param {object} signals - i0…i7, in volts (gates) and seconds (CVs)
   * @param {object} wired - unused
   * @param {Float64Array} frame - o0…o5, written in place
   */
  sample(knobs, signals, wired, frame) {
    for (let s = 0; s < 2; s++) {
      const n = s + 1;
      const section = this.sections[s];
      const gateVolts = signals[`i${s * 4}`];
      const fired = section.trigger.process(gateVolts);
      if (fired) {
        section.stage = ENV_ATTACK;
        section.phase = 0;
      }
      const attack = nysthiClamp(knobs[`attack_${n}`] + signals[`i${s * 4 + 1}`], ENV_MIN_SECONDS, ENV_MAX_SECONDS);
      const duration = nysthiClamp(knobs[`duration_${n}`] + signals[`i${s * 4 + 2}`], ENV_MIN_SECONDS, ENV_MAX_SECONDS);
      const decay = nysthiClamp(knobs[`decay_${n}`] + signals[`i${s * 4 + 3}`], ENV_MIN_SECONDS, ENV_MAX_SECONDS);
      const curve = knobs[`curve_${n}`];
      let level = 0;
      if (section.stage === ENV_ATTACK) {
        section.phase += this.step / attack;
        if (section.phase >= 1) {
          section.phase = 0;
          section.stage = ENV_HOLD;
          section.eor.trigger();
          level = 1;
        } else {
          level = envShape(section.phase, curve);
        }
      } else if (section.stage === ENV_HOLD) {
        level = 1;
        if (this.sustained[s]) {
          // A GATE, per the changelog: the envelope holds at 10 V for as long as
          // the jack stays high, and the Schmitt's LOW threshold is what releases
          // it — the same hysteresis that armed it.
          if (!section.trigger.high) {
            section.phase = 0;
            section.stage = ENV_DECAY;
          }
        } else {
          section.phase += this.step / duration;
          if (section.phase >= 1) {
            section.phase = 0;
            section.stage = ENV_DECAY;
          }
        }
      } else if (section.stage === ENV_DECAY) {
        section.phase += this.step / decay;
        if (section.phase >= 1) {
          section.phase = 0;
          section.eoc.trigger();
          section.stage = ENV_IDLE;
          level = 0;
        } else {
          level = envShape(1 - section.phase, curve);
        }
      }
      frame[s * 3] = section.eor.process();
      frame[s * 3 + 1] = section.eoc.process();
      frame[s * 3 + 2] = level * ENV_PEAK_VOLTS;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE QUAD PANNER
// ════════════════════════════════════════════════════════════════════════════

/** The panner's four corners, in the roster's output order. Exported so the spec
 *  and the test read one list. */
export const QUAD_CORNERS = ["fl", "fr", "rl", "rr"];

/** Each corner's position in the unit square the panner spans, x then y. Front
 *  is +y and left is −x, which is the convention the "inverted Y axis" fix
 *  (CHANGELOG.md:1584) leaves the module in: a rising Y input moves the source
 *  toward the FRONT pair. */
const QUAD_CORNER_POSITIONS = [[-1, 1], [1, 1], [-1, -1], [1, -1]];

/** The CV a QuadPanner position inlet reads at full travel, in volts: the
 *  context-menu mode is documented as *"uses 10V if no input"* (CHANGELOG.md:1255),
 *  so 10 V is the module's own full-scale for these jacks. */
const QUAD_CV_FULL_VOLTS = 10;

/** The largest distance any corner can be from a source inside the square —
 *  the diagonal — so a normalized distance reaches exactly 1 at the far corner. */
const QUAD_MAX_DISTANCE = Math.sqrt(8);

/**
 * Pure function. One corner's RAW distance gain for a source at (x, y) — the
 * panner's LINEAR law before any normalization.
 *
 * @param {number} x - source position, −1…1
 * @param {number} y - source position, −1…1
 * @param {number} corner - index into QUAD_CORNERS
 * @returns {number} 0…1
 *
 * @example // dead centre feeds all four corners alike
 * @example quadLinearGain(0, 0, 0) === quadLinearGain(0, 0, 3) // true
 * @example quadLinearGain(-1, 1, 0) // 1
 * @example quadLinearGain(-1, 1, 3) // 0
 */
export function quadLinearGain(x, y, corner) {
  const [cx, cy] = QUAD_CORNER_POSITIONS[corner];
  const distance = Math.hypot(x - cx, y - cy) / QUAD_MAX_DISTANCE;
  return nysthiClamp(1 - distance, 0, 1);
}

/**
 * Pure function. One corner's gain under whichever of the panner's two documented
 * laws is selected.
 *
 * *"the PANNING is LINEAR and becomes EQUAL POWER PANNING activating the FLAG"*
 * (CHANGELOG.md:4680).
 *
 * **EQUAL POWER IS THE NORMALIZATION, NOT A SQUARE ROOT, AND THAT WAS MEASURED
 * RATHER THAN ASSUMED.** The first attempt took `sqrt(linear)`, reasoning from the
 * two-corner sin/cos law where the root is what equalizes. Over FOUR corners it
 * does not: the summed power under `sqrt` varied by 26% across the room against
 * the linear law's own 17%, i.e. the "equal power" setting was LESS equal —
 * measured by `tests/port_vc8_test.js` before this line was written. Equal power
 * means the four gains' squares SUM TO ONE at every position, so the honest
 * implementation is to divide by that sum's root, which is exactly what the name
 * says and is the direct N-corner generalisation of the stereo law.
 *
 * @param {number} x - source position, −1…1
 * @param {number} y - source position, −1…1
 * @param {number} corner - index into QUAD_CORNERS
 * @param {boolean} equalPower
 * @returns {number} 0…1
 *
 * @example quadCornerGain(-1, 1, 0, false) // 1
 * @example quadCornerGain(-1, 1, 3, false) // 0
 * @example // AT THE EXACT CENTRE THE TWO LAWS AGREE, and that is the normalization
 * @example // being honest rather than a bug: all four linear gains are 0.5 there, so
 * @example // their squares already sum to 1 and dividing by that root changes nothing.
 * @example quadCornerGain(0, 0, 0, true) === quadCornerGain(0, 0, 0, false) // true
 * @example // WHAT IT ACTUALLY CORRECTS IS THE CORNERS: linear summed power runs to
 * @example // 1.1716 at a corner, so equal power pulls the near corner down from 1.
 * @example quadCornerGain(-1, 1, 0, true) // 0.9238795325112867
 * @example // …and its four gains' squares sum to exactly one, everywhere
 * @example Math.abs([0, 1, 2, 3].reduce((s, c) => s + quadCornerGain(0.3, -0.7, c, true) ** 2, 0) - 1) < 1e-12 // true
 */
export function quadCornerGain(x, y, corner, equalPower) {
  const linear = quadLinearGain(x, y, corner);
  if (!equalPower) return linear;
  let power = 0;
  for (let c = 0; c < QUAD_CORNER_POSITIONS.length; c++) power += quadLinearGain(x, y, c) ** 2;
  // A source cannot be at distance d_max from all four corners of the square it
  // lives in, so `power` is strictly positive for every reachable (x, y); the
  // guard is for a caller that hands in something outside the square.
  if (power <= 0) throw new Error(`quadCornerGain: (${x}, ${y}) is outside the panner's field`);
  return linear / Math.sqrt(power);
}

/**
 * ── DERIVATION RECORD: `NYSTHI/QuadPanner` ─────────────────────────────────
 *
 * 1. SOURCE: `CHANGELOG.md:4676-4687` @ f895816, read 2026-08-06, entry
 *    "QUAD PANNER" (v0.5.8.0, 2017-12-12), complete:
 *    *"is an old style sound source placement using a quadraphonic system"*;
 *    *"implements some of the functionalities of a single channel of the Buchla
 *    227e"*; *"position of the source can be established with MOUSE, or by X and
 *    Y Position, or by AZIMUTH and MAGNITUDE, or by SWIRL (a la 227e)"*;
 *    *"the SWIRL is internal LFO that rotates the sound source for teh 4 outputs,
 *    with RATE and AMPLI (is the MAGNITUDE, again…)"*;
 *    *"X & Y positioning takes precendece on SWIRL that takes precendece on
 *    setting AZIMUTH (and MAGNITUDE)"*;
 *    *"the PANNING is LINEAR and becomes EQUAL POWER PANNING activating the
 *    FLAG"*; *"Activating the flag INFINITE DISTANCE CENTER, the center becomes
 *    an AUDIO BLACK HOLE, the audio disappear if the magnitude approximates to
 *    ZERO"*.
 *    Plus `:4672-4673` *"added chaining for cascading QUAD PANNERs"*, `:1254-1256`
 *    *"added CV source mode (from contextual menu 'uses 10V if no input')"* and
 *    *"added GATE output when touching the area: to be used as controller"*,
 *    `:1583-1586` *"inverted Y axis; corrected OFFSET for AZIMUTH (not clamping
 *    but rotating)"*, and `:2428-2430` *"inverted the Y input"*.
 *    `kind: behaviour`. The hardware it emulates — the Buchla 227e System
 *    Interface's quad panning — is published behaviour and agrees.
 *
 * 2. PORT-LAYOUT EVIDENCE: **THE CABLES.** P22 chains four of them:
 *    `pan1.out_fl → pan2.chain_fl`, `pan1.out_fr → pan2.chain_fr`,
 *    `pan1.out_rl → pan2.chain_rl`, and the same pattern from pan2→pan3→pan4.
 *    A chain input per corner matching an output per corner is exactly what
 *    *"added chaining for cascading"* describes, so the corner layout is proved
 *    rather than guessed. `x` and `y` take the Source of Uncertainty's random
 *    voltages and `in` takes an LPG output.
 *
 * 3. THE RECURRENCE (per sample):
 *      swirlPhase += rate·h                       (the internal LFO)
 *      position   = X/Y if either is WIRED
 *                   else swirl if swirlRate > 0   → (cos, sin)(2π·phase)·ampli
 *                   else (cos, sin)(2π·azimuth)·magnitude
 *      gain_c     = quadCornerGain(x, y, c, equalPower)
 *      if blackHole: gain_c ·= min(1, hypot(x, y))
 *      out_c      = in·gain_c + chain_c
 *
 * 4. DEVIATIONS AND GUESSES.
 *    D11. **THE `gate` OUTPUT IS ALWAYS 0, AND THAT IS THE HONEST ANSWER.**
 *         *"added GATE output when touching the area"* is a MOUSE gesture on the
 *         module's XY pad — D5's category, not property state. The port is kept
 *         because the patch contract declares it; its help says it is inert and
 *         why. Emitting a plausible-looking gate would be a fabrication, and
 *         removing the port would break a declared contract.
 *    G12. THE DISTANCE LAW. The changelog says LINEAR and EQUAL POWER and does
 *         not say linear IN WHAT. `1 − d/d_max` over the Euclidean distance to
 *         each corner of the unit square is the reading that makes "linear" and
 *         "equal power" both true and both smooth; a different normalization
 *         would change how fast the image moves, not where it ends up. The
 *         EQUAL-POWER half of it is normalization rather than a square root, and
 *         the reason is measured — see `quadCornerGain`, which got it wrong first.
 *    G13. THE BLACK HOLE'S LAW. *"the audio disappear if the magnitude
 *         approximates to ZERO"* states the endpoint and not the curve; a linear
 *         ramp in magnitude is used.
 *    D12. THE X/Y-OVER-SWIRL-OVER-AZIMUTH PRECEDENCE IS PORTED EXACTLY, and it is
 *         the one place `wired` is load-bearing in this block: "X & Y positioning
 *         takes precedence" can only mean "when a cable is there", which is D3's
 *         mechanism and no AudioParam could express it.
 */
export class QuadPannerKernel {
  /** @param {number} sampleRate - hertz */
  constructor(sampleRate) {
    this.step = 1 / sampleRate;
    this.swirlPhase = 0;
    this.equalPower = false;
    this.blackHole = false;
  }

  /** Command. The EQUAL POWER PANNING flag. @param {string} value - "linear"|"equal_power" */
  setPanLaw(value) {
    if (value !== "linear" && value !== "equal_power") {
      throw new Error(`QuadPanner: unknown pan law ${JSON.stringify(value)}`);
    }
    this.equalPower = value === "equal_power";
  }

  /** Command. The INFINITE DISTANCE CENTER flag. @param {string} value - "off"|"on" */
  setBlackHole(value) {
    if (value !== "off" && value !== "on") {
      throw new Error(`QuadPanner: unknown black hole setting ${JSON.stringify(value)}`);
    }
    this.blackHole = value === "on";
  }

  /**
   * Command. One sample.
   *
   * @param {object} knobs - azimuth (cycles), magnitude, swirl_rate (Hz), swirl_amount
   * @param {object} signals - in, x, y, chain_fl…chain_rr, in volts
   * @param {object} wired - x and y are read for D12's precedence
   * @param {Float64Array} frame - out_fl, out_fr, out_rl, out_rr, gate
   */
  sample(knobs, signals, wired, frame) {
    this.swirlPhase += knobs.swirl_rate * this.step;
    if (this.swirlPhase >= 1) this.swirlPhase -= Math.trunc(this.swirlPhase);
    let x;
    let y;
    if (wired.x || wired.y) {
      x = nysthiClamp(signals.x / QUAD_CV_FULL_VOLTS, -1, 1);
      y = nysthiClamp(signals.y / QUAD_CV_FULL_VOLTS, -1, 1);
    } else if (knobs.swirl_rate > 0) {
      const angle = 2 * Math.PI * this.swirlPhase;
      x = Math.cos(angle) * knobs.swirl_amount;
      y = Math.sin(angle) * knobs.swirl_amount;
    } else {
      const angle = 2 * Math.PI * knobs.azimuth;
      x = Math.cos(angle) * knobs.magnitude;
      y = Math.sin(angle) * knobs.magnitude;
    }
    const attenuation = this.blackHole ? Math.min(1, Math.hypot(x, y)) : 1;
    for (let c = 0; c < QUAD_CORNERS.length; c++) {
      frame[c] = signals.in * quadCornerGain(x, y, c, this.equalPower) * attenuation
        + signals[`chain_${QUAD_CORNERS[c]}`];
    }
    // D11: the touch gate has no equivalent here and does not pretend to.
    frame[QUAD_CORNERS.length] = 0;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE CLOCKABLE DELAY
// ════════════════════════════════════════════════════════════════════════════

/** CHANGELOG.md:3823: *"max total time is for 180 seconds stereo 48kHz"*. THE
 *  MODULE'S OWN CEILING, and the largest `max_seconds` this kernel will size to. */
export const CDELAY_CEILING_SECONDS = 180;

/** The buffer this kernel allocates by DEFAULT, in seconds — D21.
 *
 *  Sizing every instance for the documented ceiling costs 34.6 MB per channel at
 *  48 kHz, i.e. 69 MB per module, and P4 places TWO of them. So the buffer length
 *  is a CONSTRUCT-TIME knob (PEQ's `bands` is the precedent: a knob that SIZES the
 *  kernel is `construct: true`, not a live param) whose ceiling is the documented
 *  180 s and whose default covers the harvested patch with room — P4's two dials
 *  are 8.48 s and 5.26 s. An author who wants the full 180 s can have it, and
 *  pays for it deliberately rather than by default. */
export const CDELAY_DEFAULT_SECONDS = 30;

/** CHANGELOG.md:3762: *"add an hard limiter (max voltages -20 to +20 after
 *  feedback)"* — the thing that stops a feedback of 1.1 from running away. */
const CDELAY_LIMIT_VOLTS = 20;

/**
 * ── DERIVATION RECORD: `NYSTHI/ClockableDelay` ─────────────────────────────
 *
 * 1. SOURCE: `CHANGELOG.md:3802-3835` @ f895816, read 2026-08-06, entry
 *    "CLOCKABLEDELAY" (v0.6.16, 2018-08-19), a complete parameter walk:
 *    *"Freely inspired from MS Dual Looping Delay"*; *"it's a STEREO DELAY (or
 *    consider it as a dual delay line with same time base)"*; *"there are 8 point
 *    of SEND RETURN, before FEEDBACK and before DRYWET"*; *"FEEDIN red display is
 *    the draggable amount of IN signal, from 0.0 to 2.0"*; *"FEEDBACK … from 0.0
 *    to 1.10 (0% to 110 %) (beware !!!)"*; *"TIME … max total time is for 180
 *    seconds stereo 48kHz"*; *"TIME is multiplied by MULT (form 0.001 to 32.0).
 *    to have 1/8th (like in the DLD) you must multiply by 0.125"*; *"TAP TIME
 *    activate the time computer and after 3 taps compute the time base"*;
 *    *"TRIG TIME is the same but with external pulses"*; *"the inner clock is set
 *    to the same frequency amd a pulse is OUTPUT from PULSE out"*; *"HOLD and
 *    HOLD TRIG IN will freeze current buffer a repeated forever"*; *"REV and REV
 *    TRIG IN will reverse direction of the READ HEAD in the delays"*; *"DRY-WET
 *    to set the amount of original signal and effected signal"*. Plus
 *    `:3762` (the ±20 V limiter) and `:3785-3790` (HOLD preserves the buffer).
 *    `kind: behaviour`.
 *
 * 2. PORT-LAYOUT EVIDENCE: the changelog NAMES every jack; the ORDER comes from
 *    the stub's harvested keys, and P4 wires only three of them
 *    (`phaser1.out_l → cdelay1.in_l`, `freeze.out8 → cdelay1.hold`,
 *    `cdelay1.out_l → svf6.audio`). So the names are documented and the order is
 *    harvested — neither is guessed, but neither is proved either.
 *
 * 3. THE RECURRENCE (per sample, per channel; `Δ` is the delay in samples):
 *      Δ        = clamp(time + timeCv, 0, 180)·mult·fs
 *      wet      = buffer[read]                        (read runs backwards if REV)
 *      sendFb   = in·feedIn + wet·feedback            (the pre-feedback tap)
 *      write    = limit(returnFb wired ? returnFb : sendFb, ±20)
 *      buffer[write++] = HOLD ? buffer[write] : write  (HOLD freezes the write)
 *      sendDw   = wet                                 (the pre-dry/wet tap)
 *      out      = in·(1 − dryWet) + (returnDw wired ? returnDw : sendDw)·dryWet
 *    A send/return pair is a BREAK: when the return is wired the internal path is
 *    replaced by what comes back, which is what "patch point" means and is the
 *    second place `wired` is load-bearing in this block.
 *
 * 4. DEVIATIONS AND GUESSES.
 *    D13. THE TAP-TEMPO COMPUTER IS PORTED FROM `trig_time` ONLY. *"after 3 taps
 *         compute the time base"* — three rising edges on the trigger inlet set
 *         the time from the mean of the last two intervals. The TAP BUTTON is
 *         D5's momentary press and is not ported.
 *    G14. `send_rev_l/r` AND `send_hold_l/r` ARE UNATTESTED. The changelog names
 *         exactly TWO send/return pairs (before feedback, before dry/wet), which
 *         is four sends across two channels — and the harvested output list has
 *         eight. The extra four are given the two signals that genuinely exist in
 *         the algorithm and have no other jack: the reversed read tap and the
 *         held-buffer tap. If the hardware's jacks four to seven are something
 *         else, these are mislabelled and produce a real signal at the wrong
 *         name — reported rather than silently zeroed.
 *    D21. THE BUFFER LENGTH IS A CONSTRUCT KNOB, NOT THE DOCUMENTED 180 s. See
 *         CDELAY_DEFAULT_SECONDS: 180 s costs 69 MB per instance and P4 places
 *         two. The ceiling IS 180 s and is reachable; the default is not.
 *    D14. THE READ IS NEAREST-SAMPLE, NOT INTERPOLATED. A modulated delay time
 *         therefore steps rather than glides. This is a real limitation and is
 *         named; the changelog does not say which the original does, and adding
 *         interpolation would be a choice about a sound we cannot check.
 */
export class ClockableDelayKernel {
  /**
   * @param {number} sampleRate - hertz
   * @param {object} options - {max_seconds}, the buffer length (D21)
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.maxSeconds = nysthiClamp(options.max_seconds ?? CDELAY_DEFAULT_SECONDS, 0.001, CDELAY_CEILING_SECONDS);
    this.size = Math.ceil(this.maxSeconds * sampleRate);
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.write = 0;
    this.tapTrigger = new NysthiTrigger();
    this.holdTrigger = new NysthiTrigger();
    this.reverseTrigger = new NysthiTrigger();
    this.pulse = new NysthiPulse(sampleRate);
    this.taps = [];
    this.tappedSeconds = 0;
    this.held = false;
    this.reversed = false;
    this.clockPhase = 0;
    /** A monotone sample counter, the only clock the tap computer (D13) has. */
    this.samples = 0;
  }

  /**
   * Command. Feed the tap-tempo computer one rising edge (D13). Three taps —
   * i.e. two intervals — set the base time, which is what the changelog says.
   *
   * @param {number} samplesSinceStart - this kernel's own monotone sample count
   */
  tap(samplesSinceStart) {
    this.taps.push(samplesSinceStart);
    if (this.taps.length > 3) this.taps.shift();
    if (this.taps.length === 3) {
      const span = this.taps[2] - this.taps[0];
      this.tappedSeconds = span / (2 * this.sampleRate);
    }
  }

  /**
   * Command. One sample of the stereo delay.
   *
   * @param {object} knobs - time (s), mult, feed_in, feedback, dry_wet
   * @param {object} signals - the thirteen inlets, volts or real units
   * @param {object} wired - the four return jacks and the time inlet
   * @param {Float64Array} frame - eleven outputs, written in place
   */
  sample(knobs, signals, wired, frame) {
    this.samples++;
    if (this.tapTrigger.process(signals.trig_time)) this.tap(this.samples);
    if (this.holdTrigger.process(signals.hold)) this.held = !this.held;
    if (this.reverseTrigger.process(signals.reverse)) this.reversed = !this.reversed;
    const base = this.tappedSeconds > 0 ? this.tappedSeconds : knobs.time + signals.time;
    const seconds = nysthiClamp(base, 0, this.maxSeconds) * knobs.mult;
    const delay = Math.max(1, Math.min(this.size - 1, Math.round(seconds * this.sampleRate)));
    // REVERSE walks the read head the other way through the same buffer, which is
    // what "reverse direction of the READ HEAD" means and is why HOLD + REVERSE
    // plays the frozen buffer backwards.
    const read = this.reversed
      ? (this.write + delay) % this.size
      : (this.write - delay + this.size) % this.size;
    const wetL = this.left[read];
    const wetR = this.right[read];
    const sendFbL = signals.in_l * knobs.feed_in + wetL * knobs.feedback;
    const sendFbR = signals.in_r * knobs.feed_in + wetR * knobs.feedback;
    // HOLD RECIRCULATES AT UNITY; IT DOES NOT STOP THE WRITE. Not stopping it was
    // the first attempt and it is WRONG — with the write head frozen the read head
    // still walks forward, so the frozen content comes round once per BUFFER
    // length rather than once per DELAY, and a one-second buffer replayed a held
    // echo exactly once (measured by tests/port_vc8_test.js). Writing back what
    // was just read makes the loop `delay` samples long, which is what "freeze
    // current buffer a repeated forever" means — and it is also what makes the
    // documented memory-scan work, because moving TIME while held slides the
    // window through the recording instead of resizing silence.
    const loopL = this.held ? wetL : (wired.return_fb_l ? signals.return_fb_l : sendFbL);
    const loopR = this.held ? wetR : (wired.return_fb_r ? signals.return_fb_r : sendFbR);
    this.left[this.write] = nysthiClamp(loopL, -CDELAY_LIMIT_VOLTS, CDELAY_LIMIT_VOLTS);
    this.right[this.write] = nysthiClamp(loopR, -CDELAY_LIMIT_VOLTS, CDELAY_LIMIT_VOLTS);
    this.write = (this.write + 1) % this.size;
    const dwL = wired.return_dw_l ? signals.return_dw_l : wetL;
    const dwR = wired.return_dw_r ? signals.return_dw_r : wetR;
    // The inner clock runs at the delay's own frequency, so a chain of these can
    // be locked together off one module's PULSE out.
    this.clockPhase += 1 / (delay);
    if (this.clockPhase >= 1) {
      this.clockPhase -= 1;
      this.pulse.trigger();
    }
    frame[0] = sendFbL;
    frame[1] = sendFbR;
    frame[2] = wetL;
    frame[3] = wetR;
    frame[4] = this.reversed ? wetL : 0;
    frame[5] = this.reversed ? wetR : 0;
    frame[6] = this.held ? wetL : 0;
    frame[7] = this.held ? wetR : 0;
    frame[8] = signals.in_l * (1 - knobs.dry_wet) + dwL * knobs.dry_wet;
    frame[9] = signals.in_r * (1 - knobs.dry_wet) + dwR * knobs.dry_wet;
    frame[10] = this.pulse.process();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE MIXER AND THE VOLTAGE BANK
// ════════════════════════════════════════════════════════════════════════════

/** How many channels `NYSTHI/mix4` has — the name IS the count (CHANGELOG.md:651,
 *  *"mix4 mix8 mix16 … visually renamed with real name (before was 4MIX …)"*). */
export const MIX4_CHANNELS = 4;

/**
 * Pure function. A mixer channel's constant-power pan gains.
 *
 * @param {number} pan - −1 (hard left) … 1 (hard right)
 * @returns {{left: number, right: number}}
 *
 * @example // A PAN OF 0 IS CENTRED — but do NOT assert that with `===`. cos(π/4) and
 * @example // sin(π/4) are mathematically equal and land one ULP apart in IEEE754, so
 * @example // bit equality tests the float unit, not this function's contract.
 * @example mix4PanGains(0).left // 0.7071067811865476
 * @example Math.abs(mix4PanGains(0).left - mix4PanGains(0).right) < 1e-15 // true
 * @example Math.round(mix4PanGains(-1).left * 1000) // 1000
 * @example Math.round(mix4PanGains(-1).right * 1000) // 0
 * @example // constant power: the squares always sum to one
 * @example Math.abs(mix4PanGains(0.3).left ** 2 + mix4PanGains(0.3).right ** 2 - 1) < 1e-12 // true
 */
export function mix4PanGains(pan) {
  const angle = (nysthiClamp(pan, -1, 1) + 1) * (Math.PI / 4);
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

/**
 * ── DERIVATION RECORD: `NYSTHI/mix4` ───────────────────────────────────────
 *
 * 1. SOURCE: `CHANGELOG.md:3708-3727` @ f895816, read 2026-08-06, entry
 *    "4MIX + 8MIX + 16MIX" (v0.6.19, 2018-08-30):
 *    *"4 channels with VOLUME, PEAK meters"*; *"STEREO IN L and R"*;
 *    *"VOLUME display controller, with PEAK meter"*; *"VOLUME CV"*;
 *    *"VOLUME CV VCA"*; *"PAN display controller"*; *"PAN CV"*; *"PAN CV VCA"*;
 *    *"SOLO BTN and SOLO IN TRIG"*; *"MUTE BTN and MUTE IN TRIG"*;
 *    *"OUT LEFT and RIGHT"* with its own volume, volume CV and volume CV VCA, and
 *    *"CHAIN IN LEFT RIGHT"*. Renamed to `mix4` at `:651`. `kind: behaviour`.
 *
 * 2. PORT-LAYOUT EVIDENCE: **NONE BEYOND THE HARVESTED INDICES — the stub says
 *    `ports PROVISIONAL` and it is right.** What the changelog DOES settle is the
 *    SEMANTICS behind the provisional names: a per-channel VOLUME CV and a master
 *    VOLUME CV both exist, so `cv1…cv4` and `master_cv` are the right KIND of
 *    port even if their indices are unproved. The classic patch stores
 *    `level1..4` and `master` on this node, which is consistent with four channel
 *    faders and a master.
 *
 * 3. THE RECURRENCE (per sample):
 *      gain_n = level_n · (wired(cv_n) ? clamp(cv_n/10, 0, 1)·cvAmount_n : 1)
 *      L     += in_n · gain_n · panL_n
 *      R     += in_n · gain_n · panR_n
 *      master = masterLevel · (wired(master_cv) ? clamp(master_cv/10,0,1)·masterCvAmount : 1)
 *    THE CV MULTIPLIES, which is why every CV inlet here is a `_cv`-named port
 *    with its own VCA knob rather than an AudioParam summed with the fader —
 *    R7's `_cv` rule, and the VCA knobs default to 1.0 (full scale) rather than
 *    0 so that patching a cable does not mute the channel.
 *
 * 4. DEVIATIONS AND GUESSES.
 *    G15. THE FADER LAW. *"VOLUME display controller"* does not say whether the
 *         stored 0…1 is an amplitude or a dB position. It is treated as a linear
 *         amplitude, which makes the harvested 0.8037 a −1.9 dB fader.
 *    D15. MONO CHANNEL INPUTS. The changelog says each channel has *"STEREO IN L
 *         and R"*; the harvested contract has one `in1…in4`. The mono jack is
 *         kept (it is what the patch wires) and the channel is panned rather than
 *         balanced. Reported.
 *    D5.  SOLO and MUTE are panel BUTTONS; their TRIG inlets are not in the
 *         harvested contract, so neither half is ported. A soloed mixer is a
 *         performance state, not property state, and a latching version would be
 *         a different control.
 *    D16. THE CHAIN INPUTS ARE NOT IN THE CONTRACT and are not added. Adding a
 *         port no patch wires would be inventing surface area.
 */
export class Mix4Kernel {
  constructor() {
    this.mixL = 0;
    this.mixR = 0;
  }

  /**
   * Command. One sample.
   *
   * @param {object} knobs - level1..4, pan1..4, cv_amount1..4, master, master_cv_amount
   * @param {object} signals - in1..4, cv1..4, master_cv, in volts
   * @param {object} wired - the five CV inlets
   * @param {Float64Array} frame - [out_l, out_r], written in place
   */
  sample(knobs, signals, wired, frame) {
    let left = 0;
    let right = 0;
    for (let n = 1; n <= MIX4_CHANNELS; n++) {
      const cv = wired[`cv${n}`]
        ? nysthiClamp(signals[`cv${n}`] / NYSTHI_GATE_VOLTS, 0, 1) * knobs[`cv_amount${n}`]
        : 1;
      const gain = knobs[`level${n}`] * cv;
      const pan = mix4PanGains(knobs[`pan${n}`]);
      left += signals[`in${n}`] * gain * pan.left;
      right += signals[`in${n}`] * gain * pan.right;
    }
    const masterCv = wired.master_cv
      ? nysthiClamp(signals.master_cv / NYSTHI_GATE_VOLTS, 0, 1) * knobs.master_cv_amount
      : 1;
    const master = knobs.master * masterCv;
    frame[0] = left * master;
    frame[1] = right * master;
  }
}

/** `NYSTHI/Surveillance`'s output count (CHANGELOG.md:5190, *"one control to send
 *  10 different voltages"*). */
export const SURVEILLANCE_OUTPUTS = 10;

/** Its main pot's travel, in volts, in the DEFAULT range (`:5191`, *"the main pot
 *  goes from -5 to +5"*). */
const SURVEILLANCE_BIPOLAR_VOLTS = 5;

/** Its unipolar range's ceiling (`:5202-5205`, *"added switch to have 2 ranges
 *  A) from -5v to +5v B) from 0v to +10v"*). */
const SURVEILLANCE_UNIPOLAR_VOLTS = 10;

/** The two range-switch positions, in the changelog's own A-then-B order. */
export const SURVEILLANCE_RANGES = ["bipolar", "unipolar"];

/**
 * ── DERIVATION RECORD: `NYSTHI/Surveillance` ───────────────────────────────
 *
 * 1. SOURCE: `CHANGELOG.md:5188-5192` @ f895816, read 2026-08-06 —
 *    *"SURVEILLANCE / new module: one control to send 10 different voltages /
 *    the main pot goes from -5 to +5 / all the outs are controlled by
 *    attuenverters"* — and `:5202-5205`, *"added switch to have 2 ranges
 *    A) from -5v to +5v B) from 0v to +10v"*. `kind: behaviour`.
 *
 * 2. PORT-LAYOUT EVIDENCE: ten identical outputs need no order. P22 wires four
 *    of them into the two 208 envelopes' CV inlets.
 *
 * 3. THE RECURRENCE: `out_n = main · atten_n`, where `main` is the pot in volts
 *    under the selected range and `atten_n` is that output's attenuverter in
 *    −1…1. No state; a pure function of two knobs.
 *
 * 4. **THE FINDING THIS NODE EXISTS TO REPORT, AND IT IS A REAL ONE.**
 *    G16. THE HARVEST READ THE ATTENUVERTERS AS VOLTAGES AND DIVIDED THEM BY
 *         FIVE. `core/audio_stubs_vcv_fx.js`'s comment says *"Its four harvested
 *         voltages are /5 per R7-UNITS: -1.0 V -> -0.2"*, giving
 *         `v_1..v_4 = −0.2, 0.1172, 0.1434, 0.195`. But the changelog says this
 *         module has ONE voltage pot and TEN ATTENUVERTERS — the per-output
 *         controls are not voltages at all. The pre-division values are −1.0,
 *         0.586, 0.717, 0.975, which sit exactly in an attenuverter's −1…1 and
 *         include a suspiciously round extreme. Under that reading the /5 is
 *         WRONG and the patch's four numbers should be restored ×5. Reported to
 *         the lead; NOT fixed here, because `core/audio_patches_*.js` is not
 *         mine. The knobs below are declared as the changelog describes them.
 *    D17. THE OUTPUT COUNT IS RAISED FROM FOUR TO TEN. The harvested contract
 *         declares `out_1..out_4` because that is all P22 wires; the module has
 *         ten. Adding the six is additive — every existing cable still lands.
 */
export class SurveillanceKernel {
  constructor() {
    this.unipolar = false;
  }

  /** Command. The range switch. @param {string} value - one of SURVEILLANCE_RANGES */
  setRange(value) {
    if (!SURVEILLANCE_RANGES.includes(value)) {
      throw new Error(`Surveillance: unknown range ${JSON.stringify(value)}`);
    }
    this.unipolar = value === "unipolar";
  }

  /**
   * Command (by interface only — it has no state to advance). One sample.
   *
   * @param {object} knobs - main (−1…1 of the pot's travel), v_1…v_10
   * @param {object} signals - none
   * @param {object} wired - none
   * @param {Float64Array} frame - out_1…out_10, written in place
   */
  sample(knobs, signals, wired, frame) {
    const main = this.unipolar
      ? (knobs.main + 1) / 2 * SURVEILLANCE_UNIPOLAR_VOLTS
      : knobs.main * SURVEILLANCE_BIPOLAR_VOLTS;
    for (let n = 0; n < SURVEILLANCE_OUTPUTS; n++) {
      frame[n] = main * knobs[`v_${n + 1}`];
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE THREE STAGE SEQUENCERS
// ════════════════════════════════════════════════════════════════════════════

/** `THE SQUONK`'s stage count (CHANGELOG.md:4792, *"is 12 steps with 11 lines of
 *  programming"*). */
export const SQUONK_STAGES = 12;

/** Its five CV channels, in the changelog's own line order (`:4795-4799`). */
export const SQUONK_CHANNELS = ["a", "b", "c", "d", "e"];

/** A SQUONK stage's MODE, line 9 (`:4800`): *"TRIG mode; if bright yellow, CV and
 *  TRIG out, if dark yellow, only CV out, if black step is jumped"*. Numeric
 *  rather than discrete because it is per stage and lives in the DSP loop —
 *  VC-2's SEQ3 `toggle` precedent, generalised from two states to three. */
export const SQUONK_MODE_CV_AND_TRIG = 0;
export const SQUONK_MODE_CV_ONLY = 1;
export const SQUONK_MODE_JUMP = 2;

/** The A/B/C channels' documented span, in volts (`:4795`, *"CV channel from 0 to
 *  2 volts"*). */
const SQUONK_ABC_VOLTS = 2;

/** The D/E channels' documented span, in volts (`:4798`, *"CV channel from -1 to
 *  1 volts"*). D and E are BIPOLAR and A, B, C are not — that asymmetry is the
 *  vendor's and is what makes D and E the modulation pair. */
const SQUONK_DE_VOLTS = 1;

/** Line 3 (`:4794`): *"5X: voltage multiplier for A B C D E channels"*. */
const SQUONK_MULTIPLIER = 5;

/** The SEL CV inlet's full scale, in volts (`:4805`, *"SEL CV input: selection of
 *  stage using CV (0 -> 10v)"*). */
const SQUONK_SEL_FULL_VOLTS = 10;

/** Line 10's ratchet ceiling (`:4801`, *"REP: … will retrig the step from 1 to 8
 *  times (subdivisions)"*). */
export const SQUONK_MAX_REPEATS = 8;

/**
 * ── DERIVATION RECORD: `NYSTHI/SQUONK` ─────────────────────────────────────
 *
 * 1. SOURCE: `CHANGELOG.md:4790-4820` @ f895816, read 2026-08-06, entry
 *    "THE SQUONK" (v0.5.4, 2017-12-03) — the most completely documented module in
 *    this block, LINE BY LINE:
 *    *"it's a PROGRAMMER, STAGE sequencer, Sampler TRIGGER, freely inspired to
 *    Serge TKB / is 12 steps with 11 lines of programming"*, then
 *    line 1 TRIG IN (selects the stage triggered), line 2 STAGE button,
 *    line 3 5X multiplier, lines 4-6 A/B/C *"CV channel from 0 to 2 volts"*,
 *    lines 7-8 D/E *"from -1 to 1 volts"*, line 9 MODE, line 10 REP
 *    *"if the sequencer is clocked will retrig the step from 1 to 8 times
 *    (subdivisions) (ratcheting)"*, line 11 TRIG OUT.
 *    Globals: *"SEL knob"*, *"SEL CV input … (0 -> 10v)"*, *"CLK IN CLK OUT"*,
 *    *"UP TRIG and BUTTON: if ON the sequence will go UP (normally is DOWN)"*,
 *    *"RND btn: if light up the next stage is randomized"*,
 *    *"OUTS A B C D E are the CV outs"*, *"ROT knob, from -5 to +5, is the number
 *    of steps the yellow channel will rotate"*, *"LAST trig out: PULSE out when
 *    last step is reached"*, *"TRIG (global): current stage TRIG out (with
 *    repetitions if any)"*, *"CHAIN A B C D E and CHAIN TRIG"*,
 *    *"START STOP RESET: sequencer status controls by BUTTON or by TRIG"*.
 *    Plus `:4771-4774`: *"the CV now is scaled 1/12 V (with modf) to track steps
 *    like a keyboard using CV (0.08333 VOLT steps)"* — the SEL CV quantization.
 *    `kind: behaviour`.
 *
 * 2. PORT-LAYOUT EVIDENCE: **EVERY HARVESTED PORT NAME IS IN THE CHANGELOG.**
 *    The stub's `sel, clock, start, stop, reset, rnd, chain_trig` in and
 *    `a, b, c, d, e, trig, last, clock_out` out are, one for one, the global
 *    controls the entry lists. That is unusually strong for this block: the
 *    changelog confirms the NAMES and the harvest confirms which INDEX each sits
 *    at. P4 wires `clk1.clock → squonk1.clock` and `squonk1.trig → grain1.trig`,
 *    which is the stage-trigger path the entry describes.
 *
 * 3. THE RECURRENCE (per sample):
 *      on a CLOCK edge (and only while RUNNING):
 *        stage ← rnd ? floor(random·12) : stage + (up ? +1 : −1), wrapped
 *        skip forward while mode[stage] = JUMP
 *        repeats ← rep[stage]; if mode ≠ CV_ONLY, fire TRIG
 *        if stage is the last, fire LAST
 *      on a SEL CV: stage ← round(selVolts/10 · 11) directly (line 1's TRIG IN)
 *      ratchet: the clock interval is divided into `repeats` sub-triggers
 *      out_ch = value[(stage + rot) mod 12][ch] · span_ch · 5X
 *      CLK OUT mirrors CLK IN, so a chain of SQUONKs shares one clock.
 *
 * 4. DEVIATIONS AND GUESSES.
 *    G17. THE ROT KNOB ROTATES ALL FIVE CHANNELS, not just "the yellow channel".
 *         The entry says *"the number of steps the yellow channel will rotate jump
 *         and rotate if in sequencer mode"* — "the yellow channel" is a panel
 *         colour we cannot see, and reading it as the CV bank is the only
 *         interpretation that makes the control do anything with the jacks we
 *         have.
 *    G18. THE RATCHET'S SUBDIVISION USES THE MEASURED CLOCK INTERVAL. The entry
 *         says "subdivisions" and not of what; the interval between the last two
 *         clock edges is the only period the module can know.
 *    D18. THE 12 × 11 STAGE MATRIX IS A GENERATED KNOB BANK, NOT A LIST
 *         PROPERTY. `core/audio_patches_vcv_fx.js`'s deviation note says the
 *         matrix *"is a LIST property (core/lists.js) rather than a knob band, and
 *         VC-8 has to decide its shape"*. Decided: a knob band, because
 *         `core/audio_nodes.audioNodePlugin` has no list row — its `derived`
 *         spelling reads a list the WIDGET declares, and an audio node declares
 *         none — so a list here would need a spec-vocabulary extension, which is
 *         the lead's to grant and not a block's to fork. The band is GENERATED
 *         (`squonkStageParams`), which is exactly how VC-2's SEQ3 ships its 24 CV
 *         knobs and VC-3a's AddrSeq its 8. Cost: 84 Inspector rows. Reported as a
 *         candidate for a list row later.
 *    D19. THE CHAIN INPUTS. Only `chain_trig` is in the contract; it ORs into the
 *         clock, which is what *"useful when chaining many SQUONKs (to have just
 *         one connection for the CV and TRIGs)"* means for a trigger.
 *    D5.  Every button (STAGE, UP, RND, START/STOP/RESET, RANDOMIZE ALL) is a
 *         momentary press; the TRIG inlets beside them ARE ported, and UP and RND
 *         are LATCHING switches so they are knobs.
 */
export class SquonkKernel {
  /**
   * @param {number} sampleRate - hertz
   * @param {object} options - {seed} (D4)
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.rng = (options.seed ?? 0) >>> 0;
    this.clock = new NysthiTrigger();
    this.startTrigger = new NysthiTrigger();
    this.stopTrigger = new NysthiTrigger();
    this.resetTrigger = new NysthiTrigger();
    this.rndTrigger = new NysthiTrigger();
    this.chainTrigger = new NysthiTrigger();
    this.trig = new NysthiPulse(sampleRate);
    this.last = new NysthiPulse(sampleRate);
    this.clockOut = new NysthiPulse(sampleRate);
    this.stage = 0;
    this.running = true;
    this.sinceClock = 0;
    this.interval = sampleRate;
    this.repeatsLeft = 0;
    this.repeatPeriod = 0;
    this.sinceRepeat = 0;
  }

  /** Command. Draw the next stage index, seeded (D4). @returns {number} 0…11 */
  randomStage() {
    this.rng = nysthiLcg(this.rng);
    return Math.floor(nysthiUnit(this.rng) * SQUONK_STAGES);
  }

  /**
   * Command. Advance to the next stage, honouring UP and the JUMP mode.
   *
   * @param {object} knobs - read for `up` and every stage's mode
   */
  advance(knobs) {
    const direction = knobs.up >= 0.5 ? 1 : -1;
    for (let hop = 0; hop < SQUONK_STAGES; hop++) {
      this.stage = (this.stage + direction + SQUONK_STAGES) % SQUONK_STAGES;
      if (knobs[`mode${this.stage + 1}`] !== SQUONK_MODE_JUMP) return;
    }
  }

  /**
   * Command. One sample.
   *
   * @param {object} knobs - sel, rot, up, rnd, and the generated stage band
   * @param {object} signals - sel (volts), clock/start/stop/reset/rnd/chain_trig
   * @param {object} wired - `sel` decides whether the CV overrides the knob
   * @param {Float64Array} frame - a, b, c, d, e, trig, last, clock_out
   */
  sample(knobs, signals, wired, frame) {
    if (this.startTrigger.process(signals.start)) this.running = true;
    if (this.stopTrigger.process(signals.stop)) this.running = false;
    if (this.resetTrigger.process(signals.reset)) this.stage = 0;
    const randomNow = this.rndTrigger.process(signals.rnd);
    this.sinceClock++;
    const ticked = this.clock.process(signals.clock) || this.chainTrigger.process(signals.chain_trig);
    if (ticked) {
      this.clockOut.trigger();
      this.interval = Math.max(1, this.sinceClock);
      this.sinceClock = 0;
      if (this.running) {
        if (randomNow || knobs.rnd >= 0.5) this.stage = this.randomStage();
        else this.advance(knobs);
        const mode = knobs[`mode${this.stage + 1}`];
        if (mode !== SQUONK_MODE_CV_ONLY) {
          this.repeatsLeft = Math.max(1, Math.round(knobs[`rep${this.stage + 1}`]));
          this.repeatPeriod = this.interval / this.repeatsLeft;
          this.sinceRepeat = 0;
          this.repeatsLeft--;
          this.trig.trigger();
        }
        if (this.stage === SQUONK_STAGES - 1) this.last.trigger();
      }
    }
    // G18: the ratchet subdivides the MEASURED interval.
    if (this.repeatsLeft > 0) {
      this.sinceRepeat++;
      if (this.sinceRepeat >= this.repeatPeriod) {
        this.sinceRepeat = 0;
        this.repeatsLeft--;
        this.trig.trigger();
      }
    }
    // Line 1's TRIG IN / the SEL CV: an addressed stage, quantized to the 1/12 V
    // keyboard grid the 2017-12 fix describes.
    if (wired.sel) {
      const fraction = nysthiClamp(signals.sel / SQUONK_SEL_FULL_VOLTS, 0, 1);
      this.stage = Math.min(SQUONK_STAGES - 1, Math.round(fraction * (SQUONK_STAGES - 1)));
    }
    const shown = (this.stage + Math.round(knobs.rot) + SQUONK_STAGES * 2) % SQUONK_STAGES;
    for (let c = 0; c < SQUONK_CHANNELS.length; c++) {
      const span = c < 3 ? SQUONK_ABC_VOLTS : SQUONK_DE_VOLTS;
      frame[c] = knobs[`${SQUONK_CHANNELS[c]}${shown + 1}`] * span * (knobs.multiply >= 0.5 ? SQUONK_MULTIPLIER : 1);
    }
    frame[5] = this.trig.process();
    frame[6] = this.last.process();
    frame[7] = this.clockOut.process();
  }
}

/** `NYSTHI/Programmer`'s stage count (CHANGELOG.md:1066, *"perfect imitation of
 *  the CGS 16 step SERGE programmer with extras"* / `:1068`, *"it's 16 stages"*). */
export const PROGRAMMER_STAGES = 16;

/** Its four CV channels (`:1088`, *"A, B, C, D CV outputs"*). */
export const PROGRAMMER_CHANNELS = ["a", "b", "c", "d"];

/** A Programmer stage's control mode (`:1078-1085`, the RUN / STOP / SKIP triple
 *  the panel offers per direction). Numeric per stage — SEQ3's `toggle`
 *  precedent, as SQUONK's is. */
export const PROGRAMMER_MODE_RUN = 0;
export const PROGRAMMER_MODE_STOP = 1;
export const PROGRAMMER_MODE_SKIP = 2;

/** The CV span a Programmer channel reaches, in volts. `:1096` says the range is
 *  a context-menu "VOLTAGE MODE" with *"various ranges"* and names none, so this
 *  is Rack's own default sequencer span and is **G19**. */
const PROGRAMMER_CV_VOLTS = 10;

/** The ADDR inlet's full scale, in volts. `:1087`: *"ADDR input (to address
 *  directly a STAGE using CV: the CV is a clipped MIDI note in CV)"* — a MIDI note
 *  in V/oct is 1/12 V per stage, so sixteen stages span 16/12 V. */
const PROGRAMMER_ADDR_VOLTS_PER_STAGE = 1 / 12;

/**
 * ── DERIVATION RECORD: `NYSTHI/Programmer` (CGS 16-step Serge programmer) ───
 *
 * 1. SOURCE: `CHANGELOG.md:1063-1098` @ f895816, read 2026-08-06 — a complete
 *    panel walk: *"a new OLD sequencer/programmer module / perfect imitation of
 *    the CGS 16 step SERGE programmer with extras / the programmer can be used as
 *    step sequencer, or programmer or keyboard / contains a minimal quantizer and
 *    can output polyphony using channel A / it's 16 stages, and every stage
 *    contains: active ON/OFF (if OFF stage will not emit the pulse(s)) /
 *    repetitions (number of subdivisions pulses) / SELECT STAGE IN TRIG / STAGE
 *    SELECTED PULSE OUT (with LED) / CHANNEL A, B, C, D, cv out controls with
 *    ranges set via contextual menu / backward control mode … RUN = GREEN, STOP =
 *    RED, SKIP = GRAY / forward control mode … / Select Stage Button"*, and
 *    globally *"ADDR input … FORWARD CLOCK input … BACKWARD CLOCK input … A, B,
 *    C, D CV outputs … TRIG output … PUSH output"*. `kind: behaviour`.
 *
 * 2. PORT-LAYOUT EVIDENCE: **THE CHANGELOG AND THE CABLES TOGETHER RESOLVE WHAT
 *    NEITHER RESOLVES ALONE, AND THIS CORRECTS THE STUB.**
 *    `core/audio_stubs_vcv_fx.js` read the wrong changelog entry — it quotes
 *    *"there are 12 GATE PULSE programmers"*, which is the RAEL / Imperial
 *    Aerosol Kid entry at `:392`, a different module. The real PROGRAMMER entry
 *    says SIXTEEN stages, each with its own SELECT STAGE IN TRIG and STAGE
 *    SELECTED PULSE OUT. Sixteen per-stage inputs occupy i0…i15, so **i16 is the
 *    first GLOBAL input** — and P22 wires `clock.clock_16ths → prog.i16`, a clock
 *    into what is then the FORWARD CLOCK. Sixteen per-stage pulse outputs occupy
 *    o0…o15, so **o16, o17, o18, o19 are exactly the A, B, C, D CV outputs** —
 *    and P22 wires all four into an 8:1 selector's first four inputs, which is a
 *    four-channel CV bank being scanned. Every index in the patch lands on a jack
 *    the changelog names. `clock.reset → prog.i0` is then stage 1's select
 *    trigger, which IS a reset. **This layout is DERIVED, not guessed** — but it
 *    is derived, so the port KEYS stay as indices and the LABELS carry it.
 *
 * 3. THE RECURRENCE (per sample):
 *      a FORWARD CLOCK edge advances +1, a BACKWARD CLOCK edge −1
 *      a stage whose mode is SKIP is stepped over; STOP halts the walk there
 *      a stage select trigger (i0…i15) jumps straight to that stage
 *      ADDR (i16+2) addresses a stage as a clipped MIDI note, 1/12 V per stage
 *      on arrival: if ACTIVE, fire the stage's own pulse and the global TRIG,
 *        `rep` times across the measured clock interval; raise PUSH
 *      out_ch = value[stage][ch] · 10 V
 *
 * 4. DEVIATIONS AND GUESSES.
 *    G19. THE CV RANGE. The context menu offers *"various ranges"* and names
 *         none; ±10 V full scale is assumed.
 *    G20. THE PER-STAGE MODE IS ONE CONTROL, NOT TWO. The panel has a forward
 *         RUN/STOP/SKIP and a backward RUN/STOP/SKIP per stage — 32 controls.
 *         They are collapsed to one per stage here, which is right whenever the
 *         two agree and wrong when a patch programs a different forward and
 *         backward path. Collapsing halves an already very large knob band; the
 *         asymmetric case is a real loss and is named.
 *    D18. The stage matrix is a generated knob band, for SQUONK's reason.
 *    D20. THE QUANTIZER AND THE POLY MODE ARE NOT PORTED. *"contains a minimal
 *         quantizer"* with *"various classic scales"* — which scales is not
 *         stated, so a quantizer here would be our scale list wearing their name.
 *         Channel A's polyphony is D6.
 *    D5.  The Select Stage BUTTONS are momentary; their TRIG inlets are ported.
 */
export class ProgrammerKernel {
  /** @param {number} sampleRate - hertz */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.forward = new NysthiTrigger();
    this.backward = new NysthiTrigger();
    this.selects = [];
    for (let n = 0; n < PROGRAMMER_STAGES; n++) this.selects.push(new NysthiTrigger());
    this.stagePulses = [];
    for (let n = 0; n < PROGRAMMER_STAGES; n++) this.stagePulses.push(new NysthiPulse(sampleRate));
    this.trig = new NysthiPulse(sampleRate);
    this.push = new NysthiPulse(sampleRate);
    this.stage = 0;
    this.sinceClock = 0;
    this.interval = sampleRate;
    this.repeatsLeft = 0;
    this.repeatPeriod = 0;
    this.sinceRepeat = 0;
  }

  /**
   * Command. Walk one step in a direction, stepping over SKIP stages and
   * stopping on STOP.
   *
   * @param {object} knobs - read for every stage's mode
   * @param {number} direction - +1 or −1
   */
  walk(knobs, direction) {
    for (let hop = 0; hop < PROGRAMMER_STAGES; hop++) {
      const next = (this.stage + direction + PROGRAMMER_STAGES) % PROGRAMMER_STAGES;
      const mode = knobs[`mode${next + 1}`];
      if (mode === PROGRAMMER_MODE_STOP) return;
      this.stage = next;
      if (mode !== PROGRAMMER_MODE_SKIP) return;
    }
  }

  /**
   * Command. Arrive at the current stage: fire its pulse and the globals.
   *
   * @param {object} knobs - read for the stage's `active` and `rep`
   */
  arrive(knobs) {
    this.push.trigger();
    if (knobs[`active${this.stage + 1}`] < 0.5) return;
    this.repeatsLeft = Math.max(1, Math.round(knobs[`rep${this.stage + 1}`]));
    this.repeatPeriod = this.interval / this.repeatsLeft;
    this.sinceRepeat = 0;
    this.repeatsLeft--;
    this.trig.trigger();
    this.stagePulses[this.stage].trigger();
  }

  /**
   * Command. One sample.
   *
   * @param {object} knobs - the generated stage band
   * @param {object} signals - i0…i18, in volts
   * @param {object} wired - `i18` (ADDR) is read for its precedence
   * @param {Float64Array} frame - o0…o15 stage pulses, then o16…o19 A/B/C/D
   */
  sample(knobs, signals, wired, frame) {
    this.sinceClock++;
    for (let n = 0; n < PROGRAMMER_STAGES; n++) {
      if (this.selects[n].process(signals[`i${n}`])) {
        this.stage = n;
        this.arrive(knobs);
      }
    }
    if (this.forward.process(signals.i16)) {
      this.interval = Math.max(1, this.sinceClock);
      this.sinceClock = 0;
      this.walk(knobs, 1);
      this.arrive(knobs);
    }
    if (this.backward.process(signals.i17)) {
      this.interval = Math.max(1, this.sinceClock);
      this.sinceClock = 0;
      this.walk(knobs, -1);
      this.arrive(knobs);
    }
    if (wired.i18) {
      const addressed = Math.round(signals.i18 / PROGRAMMER_ADDR_VOLTS_PER_STAGE);
      this.stage = nysthiClamp(addressed, 0, PROGRAMMER_STAGES - 1);
    }
    if (this.repeatsLeft > 0) {
      this.sinceRepeat++;
      if (this.sinceRepeat >= this.repeatPeriod) {
        this.sinceRepeat = 0;
        this.repeatsLeft--;
        this.trig.trigger();
        this.stagePulses[this.stage].trigger();
      }
    }
    for (let n = 0; n < PROGRAMMER_STAGES; n++) frame[n] = this.stagePulses[n].process();
    for (let c = 0; c < PROGRAMMER_CHANNELS.length; c++) {
      frame[PROGRAMMER_STAGES + c] = knobs[`${PROGRAMMER_CHANNELS[c]}${this.stage + 1}`] * PROGRAMMER_CV_VOLTS;
    }
    frame[PROGRAMMER_STAGES + PROGRAMMER_CHANNELS.length] = this.trig.process();
    frame[PROGRAMMER_STAGES + PROGRAMMER_CHANNELS.length + 1] = this.push.process();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE SOURCE OF UNCERTAINTY
// ════════════════════════════════════════════════════════════════════════════

/** A fluctuating-random section's slowest sampling rate, in hertz
 *  (CHANGELOG.md:4808, *"from 0.05 to 50 sampling per seconds"*). */
const SOU_RATE_MIN_HZ = 0.05;

/** …and its fastest (same line). */
const SOU_RATE_MAX_HZ = 50;

/** A fluctuating-random voltage's span, in volts — the Buchla 266's own ±5 V, and
 *  the range every other CV in this block uses. G21. */
const SOU_FLUCTUATING_VOLTS = 5;

/** The HARD output's PULSE threshold, in volts (`:4810`, *"PULSE (when HARD >
 *  0.5)"*). Stated as a fraction of full scale on the panel; 0.5 of the ±5 V
 *  span is 2.5 V. */
const SOU_PULSE_THRESHOLD_VOLTS = 2.5;

/** The 2^n section's step, in volts (`:4817`, *"2^n are in 1/12V jumps"*). */
const SOU_QUANTIZED_SEMITONE_VOLTS = 1 / 12;

/** The n+1 section's step, in volts (`:4816`, *"n+1 are in 1V jumps"*). */
const SOU_QUANTIZED_OCTAVE_VOLTS = 1;

/** The quantized sections' N range (`:4813`, *"where N is form 1 to 6"*). */
const SOU_N_MIN = 1;
const SOU_N_MAX = 6;

/**
 * Pure function. The n+1 section's TRIANGULAR distribution (`:4814`, *"the n+1
 * distribution is a Triangular distribution (like throwing 2 dice)"*) — two
 * independent draws summed, which is literally two dice.
 *
 * @param {number} u1 - a uniform in [0,1)
 * @param {number} u2 - a second uniform in [0,1)
 * @param {number} n - the section's N, 1…6
 * @returns {number} an integer in 0…2n, peaked at n
 *
 * @example souTwoDice(0, 0, 6) // 0
 * @example souTwoDice(0.999, 0.999, 6) // 12
 * @example // EACH DIE HAS n+1 FACES, so a mid-range draw lands on the median FACE and
 * @example // not on the distribution's peak unless that face count is odd. n = 6 gives
 * @example // seven faces {0…6}, whose median 3 doubles to the peak, 6:
 * @example souTwoDice(0.5, 0.5, 6) // 6
 * @example // …but n = 3 gives FOUR faces {0,1,2,3}: floor(0.5·4) = 2, so the sum is 4
 * @example // while the distribution still peaks at 3. That asymmetry is the n+1 face
 * @example // count, not an off-by-one.
 * @example souTwoDice(0.5, 0.5, 3) // 4
 */
export function souTwoDice(u1, u2, n) {
  const faces = n + 1;
  return Math.min(Math.floor(u1 * faces), n) + Math.min(Math.floor(u2 * faces), n);
}

/** How far the SKEW control bends the distribution at full travel (G22): at 1 the
 *  exponent is 1/3, at −1 it is 3. */
const SOU_SKEW_STRENGTH = 2 / 3;

/**
 * Pure function. The stored-random section's SKEW (`:4840`, *"Random with SKEWING
 * function (CV controllable) to have more events in LOW MID or HIGH ranges"*).
 *
 * A power law: skew < 0 crowds the low end, skew > 0 the high end, 0 is uniform.
 * The changelog states the effect and not the law, so this is **G22**.
 *
 * @param {number} u - a uniform in [0,1)
 * @param {number} skew - −1 … 1
 * @returns {number} a value in [0,1)
 *
 * @example souSkew(0.5, 0) // 0.5
 * @example souSkew(0.5, 1) > 0.5 // true
 * @example souSkew(0.5, -1) < 0.5 // true
 * @example souSkew(0, 1) // 0
 */
export function souSkew(u, skew) {
  return u ** (1 - nysthiClamp(skew, -1, 1) * SOU_SKEW_STRENGTH);
}

/**
 * ── DERIVATION RECORD: `NYSTHI/SoyModelSOU` (Buchla 266 Source of Uncertainty) ─
 *
 * 1. SOURCE: `CHANGELOG.md:4805-4841` @ f895816, read 2026-08-06 —
 *    *"IS an imitation of the FLUCTUATING, QUANTIZED and STORED voltages sections
 *    of the Buchla 266 Source of Uncertainty"*, then section by section:
 *    FRV1 *"control TIME via CV and KNOB: from 0.05 to 50 sampling per seconds /
 *    OUTS: SMOOTH, HARD (the sampled voltage), PULSE (when HARD > 0.5)"*;
 *    FRV2 the same *"has a different smoothing function that can be controlled
 *    via CV"*; QRV *"2 sections: 2^n and n+1, where N is form 1 to 6 (established
 *    via CV and KNOB) / the n+1 distribution is a Triangular distribution (like
 *    throwing 2 dice) / n+1 are in 1V jumps / 2^n are in 1/12V jumps"*;
 *    SRV *"Random with SKEWING function (CV controllable) to have more events in
 *    LOW MID or HIGH ranges"*. Plus `:4753-4762`, the later additions:
 *    *"ADD PULSE in to the FRV1 section … ADD PROBABILTY to HAVE pulse, from 0 to
 *    1 … ADD PROBABILTY CV IN … ADD GATE OUT to FRV1"*, the same for FRV2, and
 *    *"ADD a section with 3 FLIP-FLOPs for more GATING divertimento"*.
 *    `kind: behaviour`. The hardware — the Buchla 266e — is published and agrees.
 *
 * 2. PORT-LAYOUT EVIDENCE, AND IT IS THE WEAKEST IN THE BLOCK. The changelog
 *    names every SECTION and every OUTPUT KIND and no order at all. P22 wires
 *    `sou.o6 → pan4.x`, `sou.o6 → pan3.x`, `sou.o6 → pan1.x`, `sou.o7 → pan1.y`
 *    (and pan3/pan4's y), `sou.o6 → sh2.in1`/`in2`, and `sou.o12 → shapes.i7`,
 *    with `clock.clock_16ths → sou.i0`.
 *    **THE CABLES CONSTRAIN THE LAYOUT AND ONE ORDERING SATISFIES THEM:** o6 and
 *    o7 drive a panner's X and Y and a sample-and-hold's inputs, so both must be
 *    CONTINUOUS voltages, not pulses. Laying the sections out in the changelog's
 *    own order with the ORIGINAL three outputs each —
 *      o0 FRV1 smooth, o1 FRV1 hard, o2 FRV1 pulse,
 *      o3 FRV2 smooth, o4 FRV2 hard, o5 FRV2 pulse,
 *      o6 QRV 2^n,     o7 QRV n+1,   o8 SRV
 *    — puts exactly two continuous voltages at o6 and o7, and it does so for a
 *    STRUCTURAL reason rather than a convenient one: the GATE outs and the three
 *    FLIP-FLOPs were added in LATER releases (`:4757`, `:4767`), and a Rack
 *    module's output enum grows by APPENDING, so they land at o9 onward — which
 *    is where o12 (a flip-flop, i.e. a gate) then sits, driving an index-keyed
 *    ShapeMaster input that may well want one.
 *    **This is an INFERENCE from cable types plus release chronology — G23 — and
 *    it is the block's least certain claim. The port KEYS stay as indices.**
 *
 * 3. THE RECURRENCE (per sample):
 *      each FRV: rate = min + (max − min)·knob;  phase += rate·h
 *                on wrap (or on a PULSE IN edge): hard ← U(−5, 5)
 *                smooth ← smooth + (hard − smooth)·(1 − exp(−h/τ))
 *                pulse  ← 1 ms when hard > 2.5 V, gated by PROBABILITY
 *      QRV     : on the shared clock, 2^n ← floor(U·2^N)·(1/12) V
 *                                     n+1 ← twoDice(U, U, N)·1 V
 *      SRV     : on the shared clock, out ← skew(U)·10 V − 5 V
 *      FF_k    : toggles on each of its own section's pulse
 *
 * 4. DEVIATIONS AND GUESSES.
 *    G23. The whole output layout (above).
 *    G21. THE FLUCTUATING SECTIONS' VOLTAGE SPAN. ±5 V, the 266's own and this
 *         block's default; the changelog gives the RATE range and not the span.
 *    G22. The SKEW law (see `souSkew`).
 *    G24. `i0`. The contract declares ONE input, typed `trigger`, and P22 sends a
 *         clock into it. FRV1's PULSE IN is the only jack a clock belongs in — but
 *         PULSE IN was ADDED LATER (`:4753`), so by the append rule it should NOT
 *         be at index 0; index 0 should be FRV1's TIME CV. The two readings
 *         conflict and the documents do not settle it. Treated as FRV1's PULSE IN,
 *         because that is what makes the patch's cable mean something; the other
 *         reading would make it a rate CV being clocked, which is not musical.
 *         **This is the one place in the block where I chose the reading that
 *         makes the patch work over the reading the append rule implies, and it
 *         is stated rather than buried.**
 *    D4.  Every draw is seeded.
 */
export class SoyModelSouKernel {
  /**
   * @param {number} sampleRate - hertz
   * @param {object} options - {seed} (D4)
   */
  constructor(sampleRate, options = {}) {
    this.step = 1 / sampleRate;
    this.rng = (options.seed ?? 0) >>> 0;
    this.pulseIn = new NysthiTrigger();
    this.sections = [0, 1].map(() => ({
      phase: 0,
      hard: 0,
      smooth: 0,
      pulse: new NysthiPulse(sampleRate),
      gate: false,
    }));
    this.quantizedPower = 0;
    this.quantizedPlus = 0;
    this.stored = 0;
    this.flipflops = [false, false, false];
  }

  /** Command. Draw a uniform in [0,1), seeded. @returns {number} */
  draw() {
    this.rng = nysthiLcg(this.rng);
    return nysthiUnit(this.rng);
  }

  /**
   * Command. Redraw every quantized and stored value — done on the same event
   * that reseeds FRV1, because the contract gives the module one clock inlet.
   *
   * @param {object} knobs - n_power, n_plus, skew
   */
  redrawQuantized(knobs) {
    const nPower = Math.round(nysthiClamp(knobs.n_power, SOU_N_MIN, SOU_N_MAX));
    const nPlus = Math.round(nysthiClamp(knobs.n_plus, SOU_N_MIN, SOU_N_MAX));
    this.quantizedPower = Math.floor(this.draw() * 2 ** nPower) * SOU_QUANTIZED_SEMITONE_VOLTS;
    this.quantizedPlus = souTwoDice(this.draw(), this.draw(), nPlus) * SOU_QUANTIZED_OCTAVE_VOLTS;
    this.stored = (souSkew(this.draw(), knobs.skew) * 2 - 1) * SOU_FLUCTUATING_VOLTS;
  }

  /**
   * Command. One sample.
   *
   * @param {object} knobs - rate_1, rate_2, smooth_1, smooth_2, probability_1,
   *                         probability_2, n_power, n_plus, skew
   * @param {object} signals - i0, in volts
   * @param {object} wired - unused
   * @param {Float64Array} frame - o0…o13, written in place
   */
  sample(knobs, signals, wired, frame) {
    const clocked = this.pulseIn.process(signals.i0);
    if (clocked) this.redrawQuantized(knobs);
    for (let s = 0; s < 2; s++) {
      const n = s + 1;
      const section = this.sections[s];
      const rate = SOU_RATE_MIN_HZ + (SOU_RATE_MAX_HZ - SOU_RATE_MIN_HZ) * nysthiClamp(knobs[`rate_${n}`], 0, 1);
      section.phase += rate * this.step;
      const fired = section.phase >= 1 || (s === 0 && clocked);
      if (fired) {
        section.phase = 0;
        section.hard = (this.draw() * 2 - 1) * SOU_FLUCTUATING_VOLTS;
        // PROBABILITY gates whether the pulse is emitted at all (`:4755`).
        if (section.hard > SOU_PULSE_THRESHOLD_VOLTS && this.draw() < knobs[`probability_${n}`]) {
          section.pulse.trigger();
          this.flipflops[s] = !this.flipflops[s];
        }
      }
      // The two sections differ by their smoothing, which is the changelog's own
      // distinction: FRV2's is CV-controllable and FRV1's is fixed.
      const tau = Math.max(this.step, knobs[`smooth_${n}`]);
      section.smooth += (section.hard - section.smooth) * (1 - Math.exp(-this.step / tau));
      section.gate = section.smooth > SOU_PULSE_THRESHOLD_VOLTS;
      frame[s * 3] = section.smooth;
      frame[s * 3 + 1] = section.hard;
      frame[s * 3 + 2] = section.pulse.process();
    }
    frame[6] = this.quantizedPower;
    frame[7] = this.quantizedPlus;
    frame[8] = this.stored;
    frame[9] = this.sections[0].gate ? NYSTHI_GATE_VOLTS : 0;
    frame[10] = this.sections[1].gate ? NYSTHI_GATE_VOLTS : 0;
    // The third flip-flop toggles on the QUANTIZED clock, which is the only other
    // event the module has; the changelog says three flip-flops and not what
    // drives the third. Part of G23.
    if (clocked) this.flipflops[2] = !this.flipflops[2];
    for (let f = 0; f < this.flipflops.length; f++) {
      frame[11 + f] = this.flipflops[f] ? NYSTHI_GATE_VOLTS : 0;
    }
  }
}
