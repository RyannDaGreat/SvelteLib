/**
 * AX-1 SPECS — the Axoloti arithmetic, logic and step-table nodes, as spec records.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * Exactly what core/audio_specs.js is — "everything that makes one audio node differ
 * from another, and nothing else" — for the block of ported nodes AX-1 owns. Read
 * that file's header first; every rule in it (the port types are the engine's truth,
 * ranges restate the engine's clamps, `construct: true` is the knob that cannot be
 * turned) applies here unchanged.
 *
 * IT IS A SEPARATE FILE FOR A MECHANICAL REASON, NOT A DESIGN ONE. R7-17 assigns 336
 * nodes across 23 agents working at once; one spec file would be 23 writers on one
 * conflict surface. The barrel in core/audio_specs.js is where they meet.
 *
 * ── THE DERIVATION RECORD, AND WHY EVERY SPEC HERE CARRIES ONE ──────────────
 * User, 2026-08-06, on why ported nodes must record their origin: *"it's so we can
 * debug shit and find flaws in the emulation."* That PURPOSE decides the contents —
 * a licence tag would be useless for it. So each record names:
 *
 *   `project` + `commit`  the repository and the exact revision it was read at
 *   `objects`             the source object files, by path
 *   `codeBlock`           WHICH block the recurrence came from (`<code.krate>`,
 *                         `<code.srate>`, or a firmware function). The registry left
 *                         this column deliberately blank for Phase 3 to fill; a row
 *                         with it still blank is NOT DONE, and
 *                         tests/port_ax1_test.js fails on a blank one.
 *   `recurrence`          the ported recurrence IN FLOAT, so a wrong sound is diffed
 *                         against a line rather than re-derived from the library
 *   `deviations`          every deliberate difference, NAMED. An empty list is a
 *                         claim ("this is arithmetically the source") and is checked.
 *
 * ── THE ARITHMETIC IS THE TASK ──────────────────────────────────────────────
 * User, verbatim: *"axoloti uses integer math u have to port it to our floating
 * math"*. The recurrences live in synth/ax1_dsp.js next to the EXACT integer form
 * they were derived from, and tests/port_ax1_test.js sweeps both and prints the max
 * absolute error. This file is the description; that file is the arithmetic; the test
 * is the proof. Nothing here asserts fidelity — the printed error bounds do.
 *
 * ── WHY THE OPTION LISTS ARE RESTATED RATHER THAN IMPORTED ──────────────────
 * core/ MAY NOT IMPORT synth/** (core/audio_specs.js header, and CLAUDE.md: core must
 * run in bare node, where an AudioContext does not exist). So `AX1_MATH_OP_OPTIONS`
 * cannot be `Object.keys(AX_MATH_OPS)`. core/audio_specs.js has exactly this problem
 * with SPECTRUM_BIN_OPTIONS and solves it the same way — restate, and pin the two
 * together in the test that legitimately imports both. That pin is
 * tests/port_ax1_test.js's "the spec's operation lists are the DSP's" check.
 *
 * Zero PowerRP-runtime and zero synth imports: this is data.
 */

// ── THE AXOLOTI SOURCES, at the commits everything here was read at ─────────
// One object each so a derivation record cannot name a revision by hand and get it
// wrong. The registry's own "Sources" section is where these two came from.

/** axoloti/axoloti-factory. The repo has NO tags; this commit is its frozen final state. */
const FACTORY = { project: "axoloti/axoloti-factory", commit: "78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa" };
/** axoloti/axoloti-contrib at tag 1.0.12 — `master` is empty of the contributed objects. */
const CONTRIB = { project: "axoloti/axoloti-contrib", commit: "798166f0ce29f4b6a39099b3bde6ef2e7755a7c4 (tag 1.0.12)" };

/**
 * Pure function. Build one derivation record. A helper rather than 15 object
 * literals because the SHAPE is the contract the test enforces, and a shape spelled
 * once per node is once per node's chance to drop the field that mattered.
 *
 * @param {{project: string, commit: string}} source - FACTORY or CONTRIB
 * @param {string[]} objects - source object paths, relative to the repo root
 * @param {string} codeBlock - which block the recurrence came from
 * @param {string} recurrence - the ported recurrence, in float
 * @param {string[]} deviations - every deliberate difference, named
 * @returns {object} the frozen record
 *
 * @example derivedFrom(FACTORY, ["objects/math/abs.axo"], "<code.krate>", "out = |a|", []).commit
 * @example // '78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa'
 * @example derivedFrom(FACTORY, ["objects/math/abs.axo"], "<code.krate>", "out = |a|", []).deviations.length // 0
 */
function derivedFrom(source, objects, codeBlock, recurrence, deviations) {
  return Object.freeze({ ...source, objects, codeBlock, recurrence, deviations });
}

/** The deviation EVERY node in this block shares, stated once and referenced by name.
 *  Repeating it per node would bury the per-node ones that actually matter. */
const FIXED_POINT_DEVIATION = "Q4.27 fixed point → float32. frac32 1.0 = 2^27 becomes 1.0; the source TRUNCATES where we do not, so results differ by up to one frac32 LSB (7.45e-9). Measured per node by tests/port_ax1_test.js.";

/** The other near-universal one: their control rate is 3000 Hz exactly (48 kHz /
 *  BUFSIZE 16), which our worklet reproduces as 8 ticks of 16 samples per quantum. */
const KRATE_NOTE = "Runs at Axoloti's control rate of EXACTLY 3000 Hz (48000/16), reproduced as 8 k-rate ticks per 128-frame quantum. Hoisting it to once per quantum would run it 8× slow.";

// ── SHARED KNOB SHAPES ──────────────────────────────────────────────────────

/** An Axoloti DIAL, in its own units. 64 IS 1.0 — the § R7-11 trap — so a knob that
 *  the source reads through a pfunction keeps the dial's range rather than being
 *  quietly pre-mapped, and its help says what 64 means. */
const DIAL = { min: 0, max: 64, step: 1 };

/** A frac32 CONTROL VALUE, in the float units the port speaks: nominal ±1.0 with the
 *  ±16.0 of headroom frac32 really carries, so a summed signal can arrive un-clipped. */
const FRAC = { min: -16, max: 16, step: 0.001 };

// ── math/op ─────────────────────────────────────────────────────────────────

/**
 * THE ARITHMETIC OPERATIONS, restated from synth/ax1_dsp.AX_MATH_OPS.
 * The restatement is forced (core may not import synth) and pinned by the test.
 */
export const AX1_MATH_OP_OPTIONS = [
  "add", "subtract", "multiply", "ringModAntialiased", "addDialUnit", "absolute",
  "negate", "maximum", "greaterThan", "divide2", "divide4", "divide32",
  "satMultiply2", "satMultiply4", "satMultiply8", "satMultiply16", "saturate",
  "attenuate", "gain16",
];

export const AX_MATH_SPEC = {
  type: "audio_ax_math", module: "axMath", title: "Math", family: "modulation",
  icon: "mdi:plus-minus-variant", readout: "operation", w: 165,
  help: "Axoloti's whole arithmetic shelf as ONE node — twenty operations on two signals, from a plain sum to an antialiased ring modulator. Their library spends twenty-one object files and sixty-odd generated overloads on this; the operation is a knob here because the port types are already checked by the wire.",
  inputs: [
    { key: "a", type: "audio", label: "a" },
    { key: "b", type: "number", label: "b" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "operation", label: "Operation", default: "multiply", discrete: true, options: AX1_MATH_OP_OPTIONS, help: "Which arithmetic to apply. UNARY operations (absolute, negate, the divides, the saturating multiplies, saturate, addDialUnit) IGNORE b entirely — the port stays visible because the same node does both, and the readout names which one is running. `attenuate` and `gain16` are `*c` and `math/gain`: identical arithmetic to multiply, kept as their own operations because their sources read b through a pfunction, which is the layer a port gets wrong." },
    { key: "b", label: "b", default: 1, min: -16, max: 16, step: 0.001, help: "The second operand, and the OFFSET the `b` wire sums into — this is the param/inlet duality rule (§ R7-11) that saves Axoloti's ~70 duplicated ` m` objects. Range reaches ±16 because frac32 carries that much headroom and because `gain16` genuinely amplifies to ×16." },
  ],
  derivation: derivedFrom(FACTORY, [
    "objects/math/PLUS.axo", "objects/math/MINUS.axo", "objects/math/STAR.axo",
    "objects/math/STARc.axo", "objects/math/PLUS1.axo", "objects/math/PLUSc.axo",
    "objects/math/abs.axo", "objects/math/inv.axo", "objects/math/max.axo",
    "objects/math/GT.axo", "objects/math/div 2.axo", "objects/math/div 4.axo",
    "objects/math/div 32.axo", "objects/math/muls 2.axo", "objects/math/muls 4.axo",
    "objects/math/muls 8.axo", "objects/math/muls 16.axo", "objects/math/sat.axo",
    "objects/math/gain.axo", "objects/tiar/math/DP STAR.axo (contrib)",
  ], "<code.krate> of each; the frac32buffer overloads' <code.srate> is byte-identical",
  "out = a OP b, per synth/ax1_dsp.AX_MATH_OPS[op].float. multiply: a·b (their ___SMMUL(a<<3,b<<2) IS a·b/2^27, i.e. frac32×frac32→frac32). attenuate: a·b with b = dial/64 (their `.gain` pfunction is <<4, so the body's <<1 completes the law). gain16: sat1(sat1(a)·b) with b = 16·dial/64.",
  [
    FIXED_POINT_DEVIATION,
    "The divide operations use an ARITHMETIC shift in the source, which FLOORS; we divide exactly. A negative odd input therefore lands one frac32 LSB above the source.",
    "`addDialUnit` is Axoloti's `+1`, which adds 1<<21 = ONE DIAL UNIT = 1/64 of full scale, not 1.0. The name is theirs and it is a trap; the help says the quantity.",
    "The ~60 machine-generated int32/frac32/frac32buffer overloads collapse into one node. Their overload resolution is by connected type; ours is core/nodeflow.js's port typing, which does the same job at the wire.",
    "`ringModAntialiased` (tiar `DP *`) was ALREADY float in the source — it converts in and out of q27 itself — so it is the one operation with no fixed-point step to reproduce and no error to measure.",
  ]),
};

// ── math/smooth ─────────────────────────────────────────────────────────────

export const AX_SMOOTH_SPEC = {
  type: "audio_ax_smooth", module: "axSmooth", title: "Smooth", family: "modulation",
  icon: "mdi:transition", readout: "time",
  help: "Axoloti's one-pole smoother — the node that turns a stepped control into a glide, and the single most reused utility in their library. WARNING, and it is theirs: the knob is called Time but is BACKWARDS — higher means slower, and at 64 the value freezes completely.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "enable", type: "number", label: "en" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "time", label: "Time", default: 32, ...DIAL, help: "The smoothing dial, in Axoloti's own 0…64 units. The per-tick coefficient is (64 − dial)/4096 at 3000 Hz, so 0 is the FASTEST (τ ≈ 21 ms), 32 is τ ≈ 43 ms, 63 is τ ≈ 1.4 s, and 64 is a coefficient of exactly ZERO — the output stops moving and holds forever. That inversion is the source's; re-mapping the knob would break every ported patch's tuning." },
    { key: "enable", label: "Enable", default: 1, min: 0, max: 1, step: 1, help: "1 smooths; 0 passes the input straight through with no lag at all. This is the only difference between their `math/smooth` and `math/glide` — glide is smooth with this gate — so the two objects are one node here." },
  ],
  derivation: derivedFrom(FACTORY, ["objects/math/smooth.axo", "objects/math/glide.axo"],
    "<code.krate>: `val = ___SMMLA(val-inlet_in, (-1<<26)+(param_time>>1), val)`",
    "Per k-rate tick: val += (in − val) · (64 − dial)/4096. The coefficient falls out of the pfunction: param_time = dial·2^21, so (−2^26 + dial·2^20)/2^32 = −(64 − dial)/4096, and the minus cancels against their `val − in` argument order.",
    [
      FIXED_POINT_DEVIATION,
      KRATE_NOTE,
      "The source TRUNCATES on every tick, so its state settles a fraction short of the target and stays there — the classic fixed-point one-pole standing offset. Ours converges. Measured at up to 1e-3 over 20000 ticks; it is bounded by the step size, not by run length.",
      "`math/glide`'s `en` inlet is a bool32 there and a number knob+input here, so it can be keyframed like any other property.",
    ]),
};

// ── math/window ─────────────────────────────────────────────────────────────

export const AX_WINDOW_SPEC = {
  type: "audio_ax_window", module: "axWindow", title: "Hann Window", family: "modulation",
  icon: "mdi:bell-curve-cumulative", readout: null,
  help: "A Hann window over a 0…1 phase — the envelope every granular voice is multiplied by, and the reason a grain fades in and out instead of clicking at both ends. Drive it from a phasor and multiply the result into the grain.",
  inputs: [{ key: "phase", type: "audio", label: "phase" }],
  outputs: [{ key: "out", type: "audio", label: "win" }],
  knobs: [],
  derivation: derivedFrom(FACTORY, ["objects/math/window.axo"],
    "<code.krate> / <code.srate>: `HANNING2TINTERP(inlet_phase<<5, r); outlet_win = (r>>4);`, resolving to `hann_q31` at firmware/axoloti_math.h:132 over the `windowt` table built at firmware/axoloti_math.c:49-52",
    "win = 0.5 − 0.5·cos(2π·phase), phase wrapped to [0,1). Their `<<5` promotes a frac32 0…1 phase to a full uint32 phase; the `>>4` narrows the q31 result back to frac32.",
    [
      FIXED_POINT_DEVIATION,
      "WE EVALUATE THE COSINE EXACTLY instead of interpolating their 1024-point int16 table. Measured difference against the reconstructed table: under 1e-5 of full scale, which is the TABLE's error against the cosine it was built from — their quantisation, not a property of the sound.",
    ]),
};

// ── math/divrem ─────────────────────────────────────────────────────────────

export const AX_DIVREM_SPEC = {
  type: "audio_ax_divrem", module: "axDivRem", title: "Divide / Remainder", family: "modulation",
  icon: "mdi:division", readout: "denominator",
  help: "Integer divide with the remainder alongside it — how an Axoloti sequencer turns one running counter into a bar number and a step within the bar. Wire a counter in and take both outputs.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "denominator", type: "number", label: "den" },
  ],
  outputs: [
    { key: "div", type: "audio", label: "div" },
    { key: "rem", type: "audio", label: "rem" },
  ],
  knobs: [
    { key: "denominator", label: "Denominator", default: 4, min: 1, max: 128, step: 1, help: "What to divide by. Their `attr_denominator` spinner's range exactly (1…128). A counter divided by 4 with the remainder taken alongside is a bar counter and a beat counter from one source." },
  ],
  derivation: derivedFrom(FACTORY, ["objects/math/divremc.axo"], "<code.krate>",
    "div = a ≥ 0 ? trunc(a/den) : −trunc((den − a)/den); rem = a − div·den. The integer arrives through the frac32→int32 coercion, which is `>>21` — so a frac32 1.0 on the wire is the integer 64.",
    [
      "The integer is read off the wire with frac32 → int32 = `>>21`, so full scale is 64, not 1. That is § R7-11's coercion, not a scaling choice.",
      "THEIR FORMULA HAS A REAL OFF-BY-ONE AND WE PORT IT (§ R7-11: port the behaviour, make the label honest). For a NEGATIVE input the denominator divides exactly, `-(den − a)/den` overshoots: divrem(−4, 2) gives div −3 and rem 2, where floor division gives −2 and 0 — and the remainder EQUALS the denominator instead of being below it. Every other case agrees with floor division. The knob's help says so, and tests/port_ax1_test.js asserts this is the ONLY shape of divergence, so a second one cannot appear unnoticed.",
    ]),
};

// ── math/shaper-k ───────────────────────────────────────────────────────────

/** How many BREAKPOINTS the `u4u` shaper has. Four segments, so five points — and
 *  the knob list below is generated from this rather than spelled five times. */
const AX_SHAPER_POINTS = 5;

export const AX_SHAPER_SPEC = {
  type: "audio_ax_shaper", module: "axShaper", title: "4-Segment Shaper", family: "modulation",
  icon: "mdi:vector-polyline", readout: null, w: 165,
  help: "Smashed Transistors' `u4u`: a control-rate transfer function drawn with five breakpoints over four equal segments. Put it after a saw LFO and the LFO becomes any shape you like; put it after an envelope and the envelope's curve becomes yours.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: Array.from({ length: AX_SHAPER_POINTS }, (unused, i) => ({
    key: `p${i}`,
    label: `Point ${i}`,
    default: i / (AX_SHAPER_POINTS - 1),
    min: 0,
    max: 1,
    step: 0.001,
    help: `Output value when the input is ${(i / (AX_SHAPER_POINTS - 1)).toFixed(2)}. The five points default to a straight line, so an untouched shaper is a pass-through and every change is visible against that.`,
  })),
  derivation: derivedFrom(CONTRIB, ["objects/tiar/kfunc/u4u.axo"], "<code.krate>",
    "Clamped to 0…1, then out = p[i] + (p[i+1] − p[i])·f where i = floor(4·in) and f = 4·in − i. Their body indexes with `in >> 25` and interpolates the remaining q25 fraction through `___SMMLA(p[i+1]−p[i], a, p[i]>>7) << 7`.",
    [
      FIXED_POINT_DEVIATION,
      KRATE_NOTE,
      "Their `>>7 … <<7` accumulator round trip quantises each segment's BASE to 2^7/2^27 ≈ 9.5e-7. That is fixed-point overhead needed to make room in the accumulator, not shape, so it is not reproduced. Measured total difference: under 2e-6.",
    ]),
};

// ── conv/convert ────────────────────────────────────────────────────────────

export const AX1_CONVERT_OPTIONS = ["bipolarToUnipolar", "unipolarToBipolar", "smoothStep"];

export const AX_CONVERT_SPEC = {
  type: "audio_ax_convert", module: "axConvert", title: "Convert", family: "modulation",
  icon: "mdi:swap-horizontal-bold", readout: "mode",
  help: "The range-and-rate adaptors that sit between two Axoloti objects that disagree: bipolar to unipolar and back, and the k→s ramp that stops a stepped control from zipper-noising an audio path.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "mode", label: "Mode", default: "bipolarToUnipolar", discrete: true, options: AX1_CONVERT_OPTIONS, help: "bipolarToUnipolar maps −1…1 onto 0…1 (halve, then centre on 0.5); unipolarToBipolar is its exact inverse. smoothStep is their `conv/interp`: it RAMPS across the 16 samples of each control block instead of stepping, which is what a control signal needs before it multiplies audio. Their `to f` / `to i` are type coercions with no arithmetic and have no mode here — the wire's type already carries that." },
  ],
  derivation: derivedFrom(FACTORY, [
    "objects/conv/bipolar2unipolar.axo", "objects/conv/unipolar2bipolar.axo",
    "objects/conv/interp.axo", "objects/conv/to f.axo", "objects/conv/to i.axo",
  ], "<code.krate> for the two range maps; <code.declaration> + <code.krate> + <code.srate> together for `interp`, whose state spans all three",
  "bipolarToUnipolar: out = in/2 + 0.5. unipolarToBipolar: out = (in − 0.5)·2. smoothStep, per control block: step = (in − prev)/16, g = prev, prev = in; then per sample out = g, g += step.",
  [
    FIXED_POINT_DEVIATION,
    KRATE_NOTE,
    "THE RAMP IS ONE CONTROL BLOCK (333 µs) LATE AND WE KEEP IT LATE. `interp` ramps FROM the previous block's value, so a new value is only reached at the END of the block it arrived in — the measured trace for prev=0, v=1.0 is 0, 0.0625, …, 0.9375, never 1.0 inside that block. Removing the lag would be an improvement in isolation and a mismatch in every ported patch, because `gain/vca` carries the same ramp and patches are tuned against the pair.",
    "`to f` and `to i` absorb into nothing: they are type coercions the source needs because its inlets are typed int32 vs frac32, and core/nodeflow.js already types the wire.",
  ]),
};

// ── logic/op ────────────────────────────────────────────────────────────────

/** Restated from synth/ax1_dsp.AX_LOGIC_OPS; pinned by tests/port_ax1_test.js. */
export const AX1_LOGIC_OP_OPTIONS = ["and", "invert", "change", "rising"];

export const AX_LOGIC_SPEC = {
  type: "audio_ax_logic", module: "axLogic", title: "Logic", family: "modulation",
  icon: "mdi:gate-and", readout: "operation",
  help: "Axoloti's boolean shelf: AND, NOT, and the two edge detectors their sequencers are built out of. A true here is FULL SCALE (+1.0), not 1/64 — bool32 coerces to frac32 as +1.0, which is the coercion that makes a comparator audible.",
  inputs: [
    { key: "a", type: "audio", label: "a" },
    { key: "b", type: "number", label: "b" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "operation", label: "Operation", default: "rising", discrete: true, options: AX1_LOGIC_OP_OPTIONS, help: "`and` needs both inputs; `invert`, `change` and `rising` are unary and ignore b. `change` emits one tick whenever the input differs from the value it last latched; `rising` emits one tick per rising edge. Note their two objects disagree about what TRUE means — `and` tests C truthiness on the raw word (so a NEGATIVE input is true) while `invert` tests `> 0`. That inconsistency is Axoloti's and is kept, because a patch may rely on either." },
    { key: "b", label: "b", default: 0, min: -16, max: 16, step: 0.001, help: "The second operand, used by `and` only. It is a knob AND an input, per the param/inlet duality rule." },
  ],
  derivation: derivedFrom(FACTORY, [
    "objects/logic/and 2.axo", "objects/logic/inv.axo", "objects/logic/change.axo",
    "objects/tiar/logic/rising.axo (contrib)",
  ], "<code.krate> of each; `change` and `rising` also carry <code.declaration> state",
  "and: (a ≠ 0 && b ≠ 0) ? 1 : 0. invert: (a > 0) ? 0 : 1. change: 1 for one tick when a differs from the latched value, with their ptrig interlock. rising: 1 for one tick when (a > 0) and it was not last tick.",
  [
    "bool32 → frac32 is +1.0, NOT +1/64 (§ R7-11). A logic output patched into an audio path is at full scale.",
    KRATE_NOTE,
    "`change` HAS A QUIRK AND WE PORT IT: its two-flag form means an input that changes on EVERY control tick fires on every OTHER tick, because the interlock flag has to fall first. Audible as a halved trigger rate on a fast-moving input.",
    "`rising` has NO Schmitt hysteresis, unlike PowerRP's own Trigger node — a signal wobbling around zero fires repeatedly. That is the source's behaviour and what a ported patch is tuned against.",
    "Axoloti's or/xor objects are NOT included: they are outside the node this block was assigned. Adding them would be inventing scope rather than porting a patch's needs.",
  ]),
};

// ── logic/counter ───────────────────────────────────────────────────────────

export const AX_COUNTER_SPEC = {
  type: "audio_ax_counter", module: "axCounter", title: "Counter", family: "modulation",
  icon: "mdi:counter", readout: "maximum",
  help: "A cyclic up-counter with an independent reset — the thing that turns a clock into a step index, which is what every step table in this block wants upstream of it. Its carry output fires on the tick it wraps, so counters chain into bars.",
  inputs: [
    { key: "trig", type: "trigger", label: "trig" },
    { key: "reset", type: "trigger", label: "rst" },
  ],
  outputs: [
    { key: "count", type: "audio", label: "count" },
    { key: "carry", type: "audio", label: "carry" },
  ],
  knobs: [
    { key: "maximum", label: "Maximum", default: 16, min: 0, max: 65536, step: 1, help: "The wrap point: the count runs 0…maximum−1 and then carries. Their `int32` param's range exactly (0…65536). 16 matches the 16-step tables in this block." },
  ],
  derivation: derivedFrom(FACTORY, ["objects/logic/counter.axo"],
    "<code.declaration> + <code.init> + <code.krate>",
    "Per tick: if (trig > 0 && !ntrig) { count++; if (count >= maximum) { count = 0; carry = 1 } ntrig = true } else if (!(trig > 0)) ntrig = false. Reset runs the same edge detector into count = 0. The count leaves as an int32 outlet, so a downstream frac32 reads it as count/64.",
    [
      KRATE_NOTE,
      "`bool32.pulse` outlets are one CONTROL TICK wide (1/3000 s) in the source, and stay one control tick wide here rather than becoming a millisecond-width pulse. A patch that gates a table off this carry depends on the width.",
    ]),
};

// ── logic/latch ─────────────────────────────────────────────────────────────

export const AX_LATCH_SPEC = {
  type: "audio_ax_latch", module: "axLatch", title: "Latch", family: "modulation",
  icon: "mdi:content-save-outline", readout: null,
  help: "Copies its input to its output on a rising edge and holds it otherwise. NOT the same node as PowerRP's Sample & Hold: this one arms on a bare `> 0` with no hysteresis, which samples at a different moment on a slow or noisy gate.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "trig", type: "trigger", label: "trig" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [],
  derivation: derivedFrom(FACTORY, ["objects/logic/latch.axo"],
    "<code.declaration> + <code.krate>",
    "if (trig > 0 && !ntrig) { latch = in; ntrig = true } ; if (!(trig > 0)) ntrig = false ; out = latch.",
    [
      KRATE_NOTE,
      "DELIBERATELY A SECOND NODE ALONGSIDE `audio_sample_hold` RATHER THAN A RENAME. Ours (synth/worklets/processors.js SampleHoldProcessor) arms on a SCHMITT pair (0.1 / 0.5) so a noisy trigger cannot re-fire; this arms on `> 0`. A trigger of 0.2 fires this and not that, so a patch authored against Axoloti's latch captures different values through the other one.",
      "The int32 and frac32 overloads of their object are one node here, as everywhere in this block.",
    ]),
};

// ── logic/decode ────────────────────────────────────────────────────────────

/** `objects/logic/decode/int 8.axo` declares o0…o7 — and its `chain` outlet subtracts
 *  this same 8, which is what lets decoders cascade past eight values. */
const AX_DECODE_OUTPUTS = 8;

export const AX_DECODE_SPEC = {
  type: "audio_ax_decode", module: "axDecode", title: "Decode 8", family: "modulation",
  icon: "mdi:call-split", readout: null, w: 165,
  help: "One-hot decode: an integer in, eight gates out, exactly one of them high. The `chain` output is the input minus 8, so two of these side by side decode sixteen values without either knowing the other exists.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [
    ...Array.from({ length: AX_DECODE_OUTPUTS }, (unused, i) => ({ key: `o${i}`, type: "audio", label: `${i}` })),
    { key: "chain", type: "audio", label: "chain" },
  ],
  knobs: [],
  derivation: derivedFrom(FACTORY, ["objects/logic/decode/int 8.axo"], "<code.krate>",
    "o[k] = (in === k) ? 1 : 0 for k in 0…7; chain = in − 8. The integer arrives through frac32 → int32 = `>>21`, so full scale on the wire is the integer 64.",
    [
      "bool32 → frac32 is +1.0, so each gate is FULL SCALE when it fires.",
      KRATE_NOTE,
    ]),
};

// ── mux/mux ─────────────────────────────────────────────────────────────────

/** `mux 8`'s width. `mux 2` and `mux 4` are the same switch truncated, so one node at
 *  the widest covers all three — an unused input simply is never selected. */
const AX_MUX_WIDTH = 8;

export const AX_MUX_SPEC = {
  type: "audio_ax_mux", module: "axMux", title: "Mux", family: "modulation",
  icon: "mdi:source-merge", readout: null, w: 165,
  help: "Eight inputs, one selector, one output — pick a signal with a number. Their mux 2 / 4 / 8 are the same switch at three widths, so this is the widest and an unused input is simply never chosen.",
  inputs: [
    ...Array.from({ length: AX_MUX_WIDTH }, (unused, i) => ({ key: `i${i}`, type: "audio", label: `${i}` })),
    { key: "select", type: "number", label: "sel" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "select", label: "Select", default: 0, min: 0, max: AX_MUX_WIDTH - 1, step: 1, help: "Which input passes. A selector below 0 is treated as 0 and one above 7 CLAMPS TO THE LAST INPUT rather than going silent — their `default:` branch returns the highest input, and a patch that oversteps relies on that instead of a hole." },
  ],
  derivation: derivedFrom(FACTORY, ["objects/mux/mux 2.axo", "objects/mux/mux 4.axo", "objects/mux/mux 8.axo"],
    "<code.krate> (and the byte-identical <code.srate> of the frac32buffer overload)",
    "out = i[clamp(floor(select), 0, 7)]. Their body is `switch(inlet_s>0?inlet_s:0)` with `default:` falling to the highest input, which is the clamp above.",
    [
      "Their five overloads per width (frac32 / frac32buffer / int32 / bool32 / charptr32) collapse to one node; charptr32 is a string pointer type PowerRP has no equivalent of and no audio patch uses.",
      "`mux 2`'s selector is a bool32 there and a number here, so the three widths are one node. Selecting 0 or 1 on this node is exactly `mux 2`.",
      KRATE_NOTE,
    ]),
};

// ── sel/steps-bool ──────────────────────────────────────────────────────────

/** The step count every `sel … 16` table in this block holds, and what its `chain`
 *  outlet subtracts. Their `sel b 32 8t` is the 32-step member of the same family;
 *  16 is the width the selected patches use. */
const AX_STEPS = 16;
/** How many parallel TRACKS `sel b 16 4t` reaches. */
const AX_STEP_TRACKS = 4;
/** A 16-bit pattern word's ceiling — their `bin16` param type. */
const AX_BIN16_MAX = 65535;

export const AX_STEPS_BOOL_SPEC = {
  type: "audio_ax_steps_bool", module: "axStepsBool", title: "Step Gates", family: "modulation",
  icon: "mdi:view-week-outline", readout: "pulse", w: 200,
  help: "Four parallel 16-step gate patterns read by one step index — the drum-grid half of an Axoloti sequencer. Feed it a Counter; take the four gates into four Envelopes. In `pulse` mode a track fires only on the tick the index CHANGED, which is what makes a held index emit one hit per step rather than a continuous high.",
  inputs: [
    { key: "index", type: "audio", label: "step" },
    { key: "default", type: "number", label: "def" },
  ],
  outputs: [
    ...Array.from({ length: AX_STEP_TRACKS }, (unused, i) => ({ key: `o${i + 1}`, type: "audio", label: `${i + 1}` })),
    { key: "chain", type: "audio", label: "chain" },
  ],
  knobs: [
    ...Array.from({ length: AX_STEP_TRACKS }, (unused, i) => ({
      key: `p${i + 1}`,
      label: `Track ${i + 1}`,
      default: 0,
      min: 0,
      max: AX_BIN16_MAX,
      step: 1,
      help: `Track ${i + 1}'s 16-step pattern as one integer: bit k is step k, so 1 is "step 0 only", 3 is "steps 0 and 1", 65535 is every step. Their editor draws this as a row of sixteen toggles; here it is the number underneath, which is also what an equation can compute.`,
    })),
    { key: "pulse", label: "Pulse", default: 1, min: 0, max: 1, step: 1, help: "1 fires a track only on the control tick the step index CHANGED (their `sel b 16 pulse`); 0 holds the gate high for as long as the index sits on a set step (their `sel b 16`). The two are separate objects there and one knob here, because the bodies differ by a single clause." },
  ],
  derivation: derivedFrom(FACTORY, [
    "objects/sel/sel b 16.axo", "objects/sel/sel b 16 pulse.axo",
    "objects/sel/sel b 16 4t.axo", "objects/sel/sel b 16 4t pulse.axo",
    "objects/sel/sel b 16 2t pulse.axo", "objects/sel/sel b 32 8t.axo",
  ], "<code.krate> (with <code.declaration>'s `in_prev` for the pulse variants)",
  "For index in 0…15: level mode out[t] = (mask[t] >> index) & 1; pulse mode the same AND (index ≠ previousIndex). Outside 0…15 every track passes the `def` inlet. chain = index − 16.",
  [
    "bool32 → frac32 is +1.0, so a set step is FULL SCALE.",
    KRATE_NOTE,
    "Their 2-track and 4-track objects are one 4-track node; `sel b 32 8t` (32 steps, 8 tracks) is NOT covered — it is a different width, and none of the selected patches uses it. Stated rather than implied.",
    "THE PATTERNS ARE NUMBERS HERE, NOT A STEP GRID. Their editor draws a bin16 as sixteen toggles. An Inspector row that does that is a real UI feature and is NOT in this block; the number is honest and equation-drivable in the meantime, and the help says which bit is which step. Reported to the lead as the one piece of chrome this node wants.",
  ]),
};

// ── sel/steps-value ─────────────────────────────────────────────────────────

export const AX_STEPS_VALUE_SPEC = {
  type: "audio_ax_steps_value", module: "axStepsValue", title: "Step Values", family: "modulation",
  icon: "mdi:format-list-numbered", readout: null, w: 200,
  help: "Sixteen stored values read by one step index — the pitch lane of an Axoloti sequencer. Feed it a Counter and take the output into an Oscillator's frequency, or into a Quantize node first so it cannot play a wrong note.",
  inputs: [
    { key: "index", type: "audio", label: "step" },
    { key: "default", type: "number", label: "def" },
  ],
  outputs: [
    { key: "out", type: "audio", label: "out" },
    { key: "chain", type: "audio", label: "chain" },
  ],
  knobs: Array.from({ length: AX_STEPS }, (unused, i) => ({
    key: `v${i}`,
    label: `${i}`,
    default: 0,
    ...FRAC,
    help: `The value emitted at step ${i}. Their sliders run 0…64 in dial units where 64 IS 1.0; this is the same quantity in float, so 1.0 here is a full-scale value and the ±16 range is frac32's real headroom.`,
  })),
  derivation: derivedFrom(FACTORY, [
    "objects/sel/sel fb 16.axo", "objects/sel/sel fp 16.axo",
    "objects/sel/sel i 32.axo", "objects/sel/sel dial 4.axo",
  ], "<code.krate> — a 16-way `switch(inlet_in)` with the `def` inlet as its `default:` branch",
  "out = index in 0…15 ? values[index] : def. chain = index − 16.",
  [
    FIXED_POINT_DEVIATION,
    KRATE_NOTE,
    "Their four objects differ only in WIDTH and in the pfunction their sliders use (bipolar `frac32.s.mapvsl`, unipolar `frac32.u.mapvsl`, `int32.mini`, `frac32.u.map`). In float those distinctions collapse: the value is the value, and the knob's range carries the polarity. `sel i 32`'s 32 steps are NOT covered — 16 is the width the selected patches use.",
  ]),
};

// ── sel/steps-multi ─────────────────────────────────────────────────────────

/** Eight `int2x16` words — their `sel 4l 16 8t s` declares t0…t7. */
const AX_MULTI_ROWS = 8;
/** An `int2x16` packs 16 steps × 2 bits into one 32-bit word, so it is unsigned-full. */
const AX_INT2X16_MAX = 4294967295;

export const AX_STEPS_MULTI_SPEC = {
  type: "audio_ax_steps_multi", module: "axStepsMulti", title: "Step Levels", family: "modulation",
  icon: "mdi:grid", readout: "row", w: 200,
  help: "Eight selectable rows of sixteen FOUR-LEVEL steps — off, and three degrees of on. This is the accent lane: a 303 patch reads gate from a Step Gates node and accent depth from this one, and switching the row switches the whole pattern in one move.",
  inputs: [
    { key: "index", type: "audio", label: "step" },
    { key: "row", type: "number", label: "row" },
    { key: "default", type: "number", label: "def" },
  ],
  outputs: [
    { key: "out", type: "audio", label: "out" },
    { key: "chain", type: "audio", label: "chain" },
    // SNAKE_CASE, NOT `chainRow`. A port key is PUBLISHED as an output property, and
    // core/output_properties.js refuses a camelCase name because core/expressions.js's
    // checkCanonicalPath cannot spell one — `= axstepsmulti1.chainRow` is unwritable, so
    // the port would exist with no way to read it. The gate caught this only once the
    // lead spliced BLOCK_PLUGINS into the registry; nothing in this block could see it.
    // The DSP's internal field keeps its JS spelling — that name is not published.
    { key: "chain_row", type: "audio", label: "chainR" },
  ],
  knobs: [
    { key: "row", label: "Row", default: 0, min: 0, max: AX_MULTI_ROWS - 1, step: 1, help: "Which of the eight patterns is live. Keyframe this and the pattern changes across a slide transition, which is the whole reason a row selector is worth having over eight separate nodes." },
    ...Array.from({ length: AX_MULTI_ROWS }, (unused, i) => ({
      key: `t${i}`,
      label: `Row ${i}`,
      default: 0,
      min: 0,
      max: AX_INT2X16_MAX,
      step: 1,
      help: `Row ${i}'s pattern as one 32-bit word: TWO BITS PER STEP, step k in bits 2k and 2k+1, so each step is a level 0…3. Their editor draws this as sixteen four-way cells; the same caveat as Step Gates applies — the grid row is real UI work and is not in this block.`,
    })),
  ],
  derivation: derivedFrom(FACTORY, ["objects/sel/sel 4l 16 8t s.axo"], "<code.krate>",
    "out = (words[row] >>> (index·2)) & 3, for index in 0…15 and row in 0…7; otherwise the `def` inlet. chain = index − 16; chain_row = row − 8.",
    [
      "The level leaves as an int32 0…3, so a downstream frac32 reads it as level/64 — the § R7-11 coercion, not a scaling choice. Multiply it if you want 0…1.",
      KRATE_NOTE,
    ]),
};

// ── midi/in/* — the note sources, and the trap that makes them necessary ────
//
// ⚠ § R7-AXO-TRAPS TRAP 1 IS THIS SECTION'S WHOLE REASON FOR EXISTING.
// `plugins/node_keyboard.js`'s `pitch` output is in HERTZ; every Axoloti pitch port is
// in SEMITONES FROM E4. Wiring the playable keyboard straight into one transposes every
// note BY ITS OWN FREQUENCY IN SEMITONES — A4 arrives as semitone 440 — and it looks
// perfectly fine on the canvas. `audio_ax_midi_keyb` is where that conversion has a
// home, which is why 17 of the 20 § R7-17-SEL patches want it.
//
// ⚠ AND THERE IS NO MIDI TRANSPORT IN THIS ENGINE. Measured 2026-08-06:
// `requestMIDIAccess` / `MIDIAccess` / `midimessage` appear NOWHERE in synth/, web/,
// core/ or plugins/. Reading a live host port would be EPHEMERAL state, which CLAUDE.md
// says this project has none of. So these three nodes take WIREABLE inputs and KNOBS —
// both property state, both deterministic — and say so in their own `help` rather than
// implying a MIDI cable that is not there.
//
// ── THE OUTPUT PORT TYPES ARE A DECISION, AND HERE IS THE ARGUMENT ──────────
// Every audio module shipped before this section declares its outputs `audio` or
// `trigger` and never `number` (checked across all nine spec files). These four break
// that, and R7-UNITS clause 1 is why: **an `audio` wire is ±1**, and a note output
// carries ±64 SEMITONES while a bend carries ±64 semitones too. Declaring those `audio`
// would put a value sixty-four times the wire's own definition on it. Clause 2 — "a
// `number` wire carries the REAL UNIT of its quantity" — is exactly the port these are,
// and it is also the WIDER type: `number` reaches number, audio AND trigger, where
// `audio` cannot reach `trigger` at all (core/nodeflow.COERCIONS).
// GATE-SHAPED OUTPUTS STAY `trigger`, per clause 4's caution and for the same reach
// argument — `trigger` is the only output type that can be dropped on all three.

/** The MIDI note range a zone can span, expressed in the `note` outlet's OWN units:
 *  semitones from E4, i.e. MIDI − 64. So MIDI 0…127 is −64…63, and `keyb zone lru`'s
 *  0…50 split is −64…−14. Their spinners say 0…127; restating the range in the outlet's
 *  units rather than MIDI's is what stops a zone knob and a note wire disagreeing. */
const AX_ZONE_LOW = -64;
const AX_ZONE_HIGH = 63;

/** The velocity a clicked key gets when nothing drives the inlet, as a MIDI data byte —
 *  100 is the conventional "played, not slammed" velocity, and the wire value is
 *  100/128. It is a DEFAULT and not a constant of the port: A1's amplitude envelope
 *  reads velocity twice, so a patch that wants a softer touch turns the knob. */
const AX_DEFAULT_VELOCITY_BYTE = 100;
/** The 7-bit data byte's divisor on the wire. Their `_velo<<20` over frac32's 2^27 is
 *  `/128`, NOT `/127` — so a maximum velocity reads 0.9921875 and never quite 1.0. */
const AX_MIDI_DATA_FULL_SCALE = 128;
/** A released key's default note-off velocity. Half scale: a note-off velocity is the
 *  one MIDI quantity most controllers do not send at all, and 64 is what they substitute. */
const AX_DEFAULT_RELEASE_VELOCITY_BYTE = 64;

/** A normalized 0…1 control — velocity, release velocity, channel pressure. Their
 *  outlets are `frac32.positive`, whose real range is 0…127/128; the knob reaches a
 *  round 1 because a knob is not a MIDI byte and refusing the last 0.8% would be a
 *  field that cannot say "all the way". */
const UNIT = { min: 0, max: 1, step: 0.001 };

export const AX_MIDI_KEYB_SPEC = {
  type: "audio_ax_midi_keyb", module: "axMidiKeyb", title: "AX MIDI Keyboard",
  family: "source", icon: "mdi:piano", readout: "velocity", w: 200,
  help: "Axoloti's `midi/in/keyb`, and THE ADAPTOR THAT MAKES AN AXOLOTI PATCH PLAYABLE: PowerRP's Keyboard widget emits HERTZ and every Axoloti pitch port reads SEMITONES FROM E4, so wiring the two together directly transposes A4 to semitone 440. Wire the Keyboard's `pitch` and `gate` in here and the note leaves in the units the rest of the block speaks. It is MONOPHONIC, exactly as the source object is — for chords, follow it with Poly Voices.",
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "gate", type: "trigger", label: "gate" },
    { key: "velocity", type: "number", label: "vel" },
    { key: "release_velocity", type: "number", label: "rvel" },
  ],
  outputs: [
    { key: "note", type: "number", label: "note" },
    { key: "gate", type: "trigger", label: "gate" },
    { key: "gate2", type: "trigger", label: "gate2" },
    { key: "velocity", type: "number", label: "vel" },
    { key: "release_velocity", type: "number", label: "rvel" },
  ],
  knobs: [
    { key: "start_note", label: "Zone Low", default: AX_ZONE_LOW, min: AX_ZONE_LOW, max: AX_ZONE_HIGH, step: 1, help: "The lowest note this keyboard answers, IN THE `note` OUTLET'S OWN UNITS — semitones from E4, so MIDI 0 is −64 and MIDI 127 is 63. Their `keyb zone lru` spinners say 0…127; restating the zone where the note wire lives is what stops the two disagreeing. A note-on outside the zone is IGNORED entirely, gate included, which is their guard verbatim — that is how A9 splits one keyboard into a bass half and a melody half." },
    { key: "end_note", label: "Zone High", default: AX_ZONE_HIGH, min: AX_ZONE_LOW, max: AX_ZONE_HIGH, step: 1, help: "The highest note this keyboard answers, in semitones from E4. Set it below Zone Low and the keyboard answers nothing, which is a legal way to mute a split." },
    { key: "velocity", label: "Velocity", default: AX_DEFAULT_VELOCITY_BYTE / AX_MIDI_DATA_FULL_SCALE, ...UNIT, help: "What a key press is worth, latched on the note-on. A MOUSE CLICK HAS NO VELOCITY and this project has no MIDI, so this is a knob rather than an invented host input — and being a knob it keyframes, folds and takes an `=` equation, so a sequencer's accent lane can drive it through the same-named inlet. The default 0.78125 is MIDI 100 over the 128 their `<<20` divides by." },
    { key: "release_velocity", label: "Release Vel", default: AX_DEFAULT_RELEASE_VELOCITY_BYTE / AX_MIDI_DATA_FULL_SCALE, ...UNIT, help: "What releasing a key is worth, latched on the note-off. A1's amplitude envelope negates it into its decay time, so a higher value SHORTENS the release. The default 0.5 is MIDI 64, which is what a controller that does not measure release velocity sends." },
  ],
  derivation: derivedFrom(FACTORY, ["objects/midi/in/keyb.axo", "objects/midi/in/keyb zone lru.axo"],
    "<code.krate> + <code.midihandler> of `keyb`, with `keyb zone lru`'s <code.midihandler> zone guard",
    "Per k-rate tick, in order: a note-on (rising gate, or a pitch change while the gate is high) inside [start_note, end_note] sets note = round(hzToSemitones(pitch)), velocity = the knob, gate = 1 and gate2 = 0; a falling gate sets release_velocity = the knob and gate = 0. Then the five outlets are emitted and gate2 := gate — so gate2 is gate DELAYED ONE TICK, which is their `_gate2 = _gate` after the outlet write.",
    [
      KRATE_NOTE,
      "THERE IS NO MIDI TRANSPORT IN THIS ENGINE (measured: `requestMIDIAccess` appears nowhere in synth/, web/, core/ or plugins/), so the message stream becomes a `pitch` wire in HERTZ plus a `gate` wire. Their midihandler cannot tell a fresh note-on from a legato one either — both are MIDI_NOTE_ON — so a pitch change under a held gate is a note-on here, which is the same event.",
      "THE HERTZ→SEMITONE CONVERSION IS THIS NODE'S POINT, not an incidental (§ R7-AXO-TRAPS trap 1). It is ROUNDED to the nearest semitone because their `_note` is an `int8_t`, so a swept pitch input steps rather than glides. Glide belongs after this node, in the semitone domain, where `math/smooth` already lives.",
      "VELOCITY AND RELEASE VELOCITY ARE KNOBS (with same-named inlets), because a clicked key has none and inventing a host input would be the ephemeral state CLAUDE.md forbids. Their wire quantity is `data/128`, so a full-scale MIDI byte is 0.9921875 — the knob reaches a round 1 anyway, which is 0.8% above anything the hardware can send.",
      "`keyb zone lru`'s LEAST-RECENTLY-USED FALLBACK IS **NOT** PORTED, and it cannot be from these inputs. On a note-off their object scans its whole held-key table for the most recently pressed key still down and reverts to it; a `pitch` wire carries ONE value, not a set of held keys, so that table does not exist here. The ZONE half of that object — which is what A9's split actually uses — is ported. Named rather than approximated: a fallback that guessed would sound like a stuck note.",
      "THE OUTPUT PORT TYPES DIVERGE FROM EVERY EARLIER PORTED BLOCK (`number`, not `audio`, for note/velocity/release_velocity). R7-UNITS clause 1 defines an `audio` wire as ±1 and `note` carries ±64 semitones; clause 2 is the port these are. `number` is also the only output type that can be dropped on a `trigger` input.",
    ]),
};

export const AX_MIDI_BEND_SPEC = {
  type: "audio_ax_midi_bend", module: "axMidiBend", title: "AX MIDI Bend",
  family: "source", icon: "mdi:tune-vertical", readout: "position",
  help: "Axoloti's `midi/in/bend`. Its output is a PITCH in semitones and its full swing is ±64 of them — which looks absurd until you see what every patch does with it: A10 sends it through a `÷32` and gets the ±2 semitones a bender actually bends. The `trig` output fires one control tick whenever the position moves.",
  inputs: [{ key: "position", type: "number", label: "pos" }],
  outputs: [
    { key: "bend", type: "number", label: "bend" },
    { key: "trig", type: "trigger", label: "trig" },
  ],
  knobs: [
    { key: "position", label: "Position", default: 0, min: -1, max: 1, step: 0.001, help: "The bender's physical position: −1 fully down, 0 centred, +1 fully up. This is the 14-bit message mapped as their `(v − 0x2000) << 14` maps it, so the knob is the wheel and the `bend` output is the interval it means. It is a knob AND an inlet, so an LFO wired here is a vibrato with the patch's own bend depth already applied." },
  ],
  derivation: derivedFrom(FACTORY, ["objects/midi/in/bend.axo"],
    "<code.krate> + <code.midihandler>",
    "bend = position × 64 semitones; trig = 1 for one control tick when position differs from the previous tick's. Their `_bend = ((data2<<7)+data1 − 0x2000)<<14` is the frac32 (v14 − 8192)/8192, i.e. the position; the ×64 is the frac32-pitch→semitone factor core/audio_specs_ax2.js's header states.",
    [
      KRATE_NOTE,
      "`trig` IS A VALUE CHANGE HERE, NOT A MESSAGE ARRIVAL. Their `ntrig` is set by the midihandler and cleared every k-rate tick, so a REPEATED IDENTICAL bend message re-triggers on hardware. A wire carries a value and not an event, so an unchanged position cannot fire. The difference is audible only where `trig` gates something and the controller is spamming its centre value.",
      "The position is the INPUT and the semitone interval is the OUTPUT, deliberately under two names. A knob and its same-named input must carry the SAME units (core/audio_specs_ax2.js's header), and a −1…1 wheel and a ±64 semitone interval are not the same quantity — so they get different names rather than one name with two meanings.",
    ]),
};

export const AX_MIDI_TOUCH_SPEC = {
  type: "audio_ax_midi_touch", module: "axMidiTouch", title: "AX Channel Pressure",
  family: "source", icon: "mdi:gesture-tap-hold", readout: "pressure",
  help: "Axoloti's `midi/in/touch` — CHANNEL pressure, one value for the whole keyboard rather than per note. C3 and C7 take their pad's swell from it. Its `trig` fires one control tick whenever the pressure moves, which is how their patches retrigger on a squeeze.",
  inputs: [{ key: "pressure", type: "number", label: "press" }],
  outputs: [
    { key: "o", type: "number", label: "o" },
    { key: "trig", type: "trigger", label: "trig" },
  ],
  knobs: [
    { key: "pressure", label: "Pressure", default: 0, ...UNIT, help: "How hard the keyboard is being leaned on, 0…1. Their outlet is `data1/128`, so a maximum MIDI pressure is 0.9921875 — this knob reaches a round 1 because a knob is not a MIDI byte. Knob AND inlet, so an envelope wired here is a programmed swell." },
  ],
  derivation: derivedFrom(FACTORY, ["objects/midi/in/touch.axo"],
    "<code.krate> + <code.midihandler>",
    "o = pressure; trig = 1 for one control tick when pressure differs from the previous tick's. Their `_press = data1<<20` is `data1/128` in frac32, which is the same 0…1 quantity the inlet carries.",
    [
      KRATE_NOTE,
      "`trig` IS A VALUE CHANGE, NOT A MESSAGE ARRIVAL — the same substitution `audio_ax_midi_bend` records, for the same reason.",
      "THIS IS CHANNEL PRESSURE, NOT POLYPHONIC AFTERTOUCH. `midi/in/keyb touch`'s per-note `touch` outlet is a DIFFERENT quantity and is NOT ported: it would have to reach the voice through `audio_ax_poly_voices`, whose five-port signature is ratified in § R7-POLY, so adding it to this block alone would be a port with nowhere to go. C3's and C7's recorded substitution stands until that decision is taken.",
    ]),
};

// ── patch/patcher poly=N — the voice allocator (§ R7-POLY) ──────────────────

/** The largest `poly` this node offers. Their combo box runs to 24; ours stops where
 *  synth/voices.MAX_POLY_VOICES stops, and the § R7-17-SEL set's largest is C7's 8. */
const AX_POLY_MAX_VOICES = 16;

export const AX_POLY_VOICES_SPEC = {
  type: "audio_ax_poly_voices", module: "axPolyVoices", title: "AX Poly Voices",
  family: "modulation", icon: "mdi:call-split", readout: "voices", w: 200,
  help: "Axoloti's `patch/patcher poly=N` voice allocator: one stream of notes in, and the note actually assigned to ONE voice out. IT ALLOCATES; IT DOES NOT REPLICATE. The engine has no way to instantiate the graph downstream of a node N times, so one of these drives ONE voice graph — for N real voices, place N of them on the same input wires with `voice` set 0…N−1, each feeding its own copy. The allocation arithmetic is the source's exactly: releases are stolen before sounding notes, and among equals the oldest.",
  inputs: [
    { key: "note", type: "number", label: "note" },
    { key: "gate", type: "trigger", label: "gate" },
    { key: "gate2", type: "trigger", label: "gate2" },
    { key: "velocity", type: "number", label: "vel" },
    { key: "release_velocity", type: "number", label: "rvel" },
  ],
  outputs: [
    { key: "note", type: "number", label: "note" },
    { key: "gate", type: "trigger", label: "gate" },
    { key: "gate2", type: "trigger", label: "gate2" },
    { key: "velocity", type: "number", label: "vel" },
    { key: "release_velocity", type: "number", label: "rvel" },
  ],
  knobs: [
    { key: "voices", label: "Voices", default: 7, min: 1, max: AX_POLY_MAX_VOICES, step: 1, help: "The patcher's `poly` attribute, carried across as DATA — the harvested decks say 7 (A1, A9), 8 (C7), 5 (C1, C11) and 3 (C4). It is the SIZE OF THE POOL notes are allocated into, so raising it makes releases ring longer before they are stolen even when only one voice graph is listening. Theirs is a COMPILE-TIME attribute and this is an ordinary keyframable knob: the pool is always allocated at its maximum and this is the search width, so changing it mid-note is legal and only narrows where the next note may land." },
    { key: "voice", label: "Voice", default: 0, min: 0, max: AX_POLY_MAX_VOICES - 1, step: 1, help: "WHICH voice of the pool these five outputs report. This knob is NOT in the source — a patcher has no such control because it genuinely instantiates the subpatch N times, and the engine cannot. It is the honest seam: without it this node could only ever be voice 0 and `voices` would be a knob with no picture behind it. Set it past `voices` and the outputs stay silent, which is the truth about a voice that does not exist." },
  ],
  derivation: derivedFrom(FACTORY, ["objects/patch/patcher.axo", "objects/patch/inlet a.axo", "objects/patch/outlet a.axo"],
    "NOT an <obj> code block: `patch/patcher.axo` is a `AxoObjectPatcher` shell with no code at all. The allocator is GENERATED — axoloti/src/main/java/axoloti/codegen/patch/PatchViewCodegen.java:1042-1083 (`generatePolyCode`'s `sMidiCode`), with its state at :946-950 and its init at :965-987, read at axoloti/axoloti commit 46f6e4b383ce182da9dcca25b9d4b544fe20f990",
    "On a note-on: mini = argmin(voicePriority); voicePriority[mini] = 100000 + priority++; notePlaying[mini] = note; pressed[mini] = true. On a note-off: for every i with notePlaying[i] === note and pressed[i], voicePriority[i] = priority++ and pressed[i] = false. The chosen voice's five outputs then carry that note's note/gate/velocity/release_velocity, with gate2 the one-tick-delayed gate `midi/in/keyb` produces inside each voice.",
    [
      KRATE_NOTE,
      "⚠ THE SUBGRAPH IS NOT REPLICATED, AND THAT IS THE HALF THIS NODE CANNOT DELIVER. § R7-POLY's ratified contract is \"replicate the subgraph DOWNSTREAM of me N times\"; `core/audio_mirror_diff.readAudioScene` is a FLAT 1:1 map — one item is one module and one wire is one connect — so nothing in the engine can honour it. What ships is the ALLOCATION, exactly; what is missing is the INSTANTIATION. Reported to the lead with what the mirror would need.",
      "THE `voice` KNOB IS AN ADDITION TO THE RATIFIED SIGNATURE (the five ports are untouched). Without it the node is permanently voice 0 and looks polyphonic while being monophonic, which § R7-POLY names as the worst outcome available.",
      "THE SOURCE ALSO HANDLES SUSTAIN (CC64) AND `polychannel` / `polyexpression` MPE MODES (PatchViewCodegen.java:1086-1310). None is ported: there is no CC transport to carry a pedal and no per-channel note stream to split. A sustain pedal here would be a `hold` inlet, which is a design decision and not a transcription.",
      "THEIR `priority` COUNTER NEVER RESETS AND THE `100000` OFFSET IS FINITE, so after 100000 note events a released voice's priority catches up with a sounding one's and the two classes stop separating — the allocator starts stealing sounding notes while free voices sit idle. Ported as-is (it takes hours of playing to reach), and named because it is a real bound rather than an invariant.",
      "`patch/inlet a` and `patch/outlet a` ARE ABSORBED, not ported: in a flat graph the wire that crossed the subpatch edge is one wire. Their code generator SUMS every voice's `outlet a` (PatchViewCodegen.java:1030-1036, `outlet_x[j] += getVoices()[vi]…`) and BROADCASTS every `inlet a` to all voices (:1015-1021) — which is what N of these plus a mixer reproduces.",
    ]),
};

// ── audio/out ───────────────────────────────────────────────────────────────

export const AX_STEREO_OUT_SPEC = {
  type: "audio_ax_stereo_out", module: "axStereoOut", title: "Stereo Out", family: "output",
  icon: "mdi:speaker-multiple", readout: "volume",
  help: "The stereo output nearly every contrib patch ends in, with its own volume. It differs from PowerRP's own Output in the way that matters for a port: this HARD CLIPS at ±1.0 the way the hardware codec does, where ours runs a limiter. A patch tuned to clip here sounds wrong through a limiter, and vice versa.",
  inputs: [
    { key: "left", type: "audio", label: "L" },
    { key: "right", type: "audio", label: "R" },
    { key: "volume", type: "number", label: "vol" },
  ],
  outputs: [],
  knobs: [
    { key: "volume", label: "Volume", default: 0.5, min: 0, max: 1, step: 0.01, help: "Applied BEFORE the clip, so turning a loud source down really does stop it clipping. Their dial is 0…64 through the `frac32.u.map` pfunction, which is this same 0…1." },
  ],
  derivation: derivedFrom(CONTRIB, ["objects/sss/audio/StOutVol.axo"], "<code.krate>",
    "out = clamp(in · volume, −1, 1) per sample, both channels. Their `___SMMUL(inlet_left[j]<<3, param_volume<<2)` is the frac32×frac32 law (a·b/2^27) and `__SSAT(…, 28)` is the clamp to ±1.0.",
    [
      FIXED_POINT_DEVIATION,
      "THEIR OBJECT ASSIGNS WHERE `audio/out left` ACCUMULATES: `AudioOutputLeft[j] = …` rather than `+=`, so two StOutVols in one Axoloti patch do NOT sum — the later one in their spatial execution order simply wins, silently. Ours SUMS, like every other PowerRP output (ADDENDUM 10: 'If we have multiple audio outputs by the way, we'll just add them all together'). A silently dropped channel is exactly the failure this port exists to catch, so the divergence is deliberate and is named here.",
      "The `frac32.vu` displays are not ported — PowerRP's Level node is the meter, and it passes its input through so it can be inserted anywhere rather than living on one node.",
    ]),
};

/**
 * EVERY AX-1 SPEC, in the order the block's own work went: arithmetic, then the
 * things that decide, then the things that step, then the way out.
 *
 * ── THIS ARRAY IS NOT YET REGISTERED ────────────────────────────────────────
 * core/audio_specs.js's AUDIO_SPECS is what plugins/index.js registers from and what
 * tests/audio_nodes_test.js sweeps, and AX-1 does not own that file — four other
 * agents are in it. The barrel lines this block needs are reported to the lead
 * rather than applied here. Until they land, these specs are covered by
 * tests/port_ax1_test.js and by nothing else, which is stated so nobody reads a
 * green gate as proof they are wired in.
 */
export const BLOCK_SPECS = [
  AX_MATH_SPEC, AX_SMOOTH_SPEC, AX_WINDOW_SPEC, AX_DIVREM_SPEC, AX_SHAPER_SPEC,
  AX_CONVERT_SPEC,
  AX_LOGIC_SPEC, AX_COUNTER_SPEC, AX_LATCH_SPEC, AX_DECODE_SPEC, AX_MUX_SPEC,
  AX_STEPS_BOOL_SPEC, AX_STEPS_VALUE_SPEC, AX_STEPS_MULTI_SPEC,
  AX_MIDI_KEYB_SPEC, AX_MIDI_BEND_SPEC, AX_MIDI_TOUCH_SPEC, AX_POLY_VOICES_SPEC,
  AX_STEREO_OUT_SPEC,
];
