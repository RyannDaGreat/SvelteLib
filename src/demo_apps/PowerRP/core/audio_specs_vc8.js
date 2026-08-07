/**
 * THE VC-8 MODULE SPECS — eleven ported NYSTHI nodes.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary applied to the NYSTHI set. Same record shape,
 * same rules, same reader (`core/audio_nodes.audioNodePlugin`): a spec is the
 * values that make one module differ from its neighbours, and NOTHING about how
 * it sounds. The DSP is `synth/vc8_kernels.js`, and each node's full derivation
 * record — document, date, port-layout evidence, recurrence, every deviation and
 * every GUESS — is that file's docblocks; each `help` below points at it rather
 * than repeating it.
 *
 * ── THE ONE THING A READER OF THIS FILE MUST KNOW ───────────────────────────
 * **NYSTHI SHIPS NO SOURCE AT ANY REF.** Verified on the pre-cloned mirror
 * @ f895816 on 2026-08-06: zero `.cpp`, zero `.hpp`, on master and all six tags.
 * So NOT ONE node here is a port in the sense AX-2 and VC-3b are. Every one is an
 * APPROXIMATION built from documents — the plugin's own CHANGELOG, one published
 * DSP paper, and the demo patches' cables — and every spec below says so twice:
 * in its `derivation` record, machine-readably, and in the first sentence of its
 * `help`, in plain words, so an author looking at the card can see it without
 * reading any of this.
 *
 * `derivation` IS A FIELD THIS BLOCK ADDS TO THE SPEC RECORD and the lead should
 * know: `{kind, document, read, layout}`, where `kind` is `"behaviour"` for all
 * eleven, `document` cites what was read, `read` is the date, and `layout`
 * separately states what fixed the PORT ORDER — because the changelog gives NAMES
 * and never jack order, so the two are independent and a node can be confident
 * about one and guessing about the other. `tests/port_vc8_test.js` REFUSES a spec
 * without it, which is the gate that keeps a future node from quietly claiming
 * source fidelity. `core/audio_nodes.js` ignores unknown fields, so this costs
 * nothing; if it graduates it should be swept across every block in one commit.
 *
 * ── UNITS ───────────────────────────────────────────────────────────────────
 * R7-UNITS, and the block's decision is stated once in `synth/vc8_kernels.js`'s
 * D1: an audio wire's ±1 is ±5 Rack volts, a gate's 0…1 is 0…10 V, and a `number`
 * port carrying a real quantity (seconds, a fraction, a stage index) is unscaled.
 * **No knob here carries an `hz` field, and that is correct rather than an
 * omission**: this block has no oscillator and no pitch control, so there is no
 * absolute frequency for a readout to show. R7-UNITS' own rule — a control that
 * is not a pitch gets no hertz, because a hertz readout beside one would be a
 * confident lie.
 *
 * ── THIS FILE MAY NOT IMPORT synth/** ───────────────────────────────────────
 * core must run in bare node. So the option lists and the two generated stage
 * bands below are RESTATED from the kernels' and the worklet roster's own
 * declarations, and `tests/port_vc8_test.js` pins every restatement against the
 * original — a renamed knob or a reordered option list turns that suite red
 * rather than shipping two lists that disagree.
 */

// ── SHARED KNOB FRAGMENTS ───────────────────────────────────────────────────

/** A level-valued knob's step. 0.01 is finer than any panel and coarse enough to
 *  scrub, which is the value VC-2 settled on for the same reason. */
const LEVEL_STEP = 0.01;

/** A time knob's step, in seconds — one millisecond, which is the resolution the
 *  208's own *"from 2 msecs"* floor implies. */
const TIME_STEP = 0.001;

/** The longest stage either NYSTHI envelope reaches, in seconds. Restated from
 *  `synth/vc8_kernels.js`'s ENV_MAX_SECONDS for the layering reason the header
 *  gives; pinned against it by the test. */
const ENV_MAX_SECONDS = 10;

/** A 0…1 fraction, the shape three quarters of this block's knobs take. */
const FRACTION = { min: 0, max: 1, step: LEVEL_STEP };

/** A −1…1 bipolar control — an attenuverter, a pan, a stage's CV value. */
const BIPOLAR = { min: -1, max: 1, step: LEVEL_STEP };

/** A latching panel switch, expressed as a stepped 0/1 knob. See the worklet
 *  roster's `toggle` for why a per-stage flag cannot be a discrete option. */
const SWITCH = { min: 0, max: 1, step: 1 };

/** The SEED knob every seeded module in this block carries — the AX-2 pattern,
 *  and the project's determinism law (`Δt = 0 ⟹ byte-identical`). NYSTHI's own
 *  randomness comes from Rack's clock-seeded generator and is not reproducible
 *  even on the same machine, so this is an improvement, not an apology. */
const SEED = {
  key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
  help: "CONSTRUCT-TIME: the generator's state is initialised once, so changing this rebuilds the module. THE REASON IT EXISTS: NYSTHI's randomness is Rack's clock-seeded generator and renders differently every time, and a document that renders differently every time is not a document. Same seed, same sequence, forever.",
};

/**
 * Pure function. `n` numbered keys with an underscore before the index. Restated
 * from the worklet roster's `underscoredKeys` (this file may not import synth/**)
 * and pinned against it by tests/port_vc8_test.js.
 *
 * @param {string} stem
 * @param {number} count
 * @returns {string[]}
 *
 * @example specUnderscored("in", 2) // ["in_1", "in_2"]
 */
function specUnderscored(stem, count) {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(`${stem}_${i}`);
  return keys;
}

/**
 * Pure function. `i0 … i(n-1)` or `o0 … o(n-1)` port records with a LABEL.
 *
 * THE KEY IS THE INDEX AND THE LABEL IS THE INFERENCE, for the three modules
 * whose jack order is derived rather than published. That split is the whole
 * point: `core/audio_patches_vcv_fx.js`'s deviation list says *"a plausible name
 * over an unverified index would make a guess look resolved"*, and it is right —
 * but a jack with no label at all is unusable. So the KEY carries the fact (this
 * is input 3) and the LABEL carries the reading (we believe it is decay CV).
 *
 * @param {string} prefix - "i" or "o"
 * @param {string} type - the port type every member of this family carries
 * @param {string[]} labels - one per index, in index order
 * @returns {object[]} port records
 *
 * @example specIndexPorts("i", "trigger", ["gate 1", "gate 2"])[1] // {key: "i1", type: "trigger", label: "gate 2"}
 */
function specIndexPorts(prefix, type, labels) {
  return labels.map((label, index) => ({ key: `${prefix}${index}`, type, label }));
}

/**
 * Pure function. `i0 … i(n-1)` port records whose TYPES differ per index.
 *
 * @param {string} prefix - "i" or "o"
 * @param {Array<[string, string]>} entries - [type, label] per index
 * @returns {object[]} port records
 *
 * @example specMixedIndexPorts("o", [["trigger", "eor"], ["number", "env"]])[0].key // "o0"
 */
function specMixedIndexPorts(prefix, entries) {
  return entries.map(([type, label], index) => ({ key: `${prefix}${index}`, type, label }));
}

// ── FILTERS: THE LOWPASS GATES ──────────────────────────────────────────────

/** The LPG's three modes, restated from `synth/vc8_kernels.LPG_MODES` (this file
 *  may not import synth/**) and pinned against it by the test. */
const LPG_MODE_OPTIONS = ["vca", "vca_lp", "lp"];

/** The `help` every LPG mode selector carries. One string because the two nodes
 *  have the same control and a second copy would be a second thing to correct. */
const LPG_MODE_HELP = "Which of the paper's three circuit configurations this gate is in — the values are Table 1's, exactly. `vca` drops the shunt resistor to 5 kΩ so raising the resistance ATTENUATES rather than filters (a VCA). `vca_lp` is the paper's 'Both', both switches disengaged: a two-pole lowpass whose gain also falls as it closes, which is what a Buchla low-pass gate does and why it sounds like a struck object. `lp` switches in the 4.7 nF feedback capacitor, which makes the circuit a Sallen-Key with a resonant bump — and is the ONLY mode where Resonance does anything, because resonance reaches the maths solely through that capacitor.";

/** The `help` for a vactrol response control. Same reason as LPG_MODE_HELP. */
const LPG_RESPONSE_HELP = "How much of the photoresistor's LAG is applied — 1 is the datasheet vactrol (12 ms to brighten, 250 ms to fade, and faster when already bright), 0 is an ideal instantaneous gate. THAT ASYMMETRY IS THE WHOLE INSTRUMENT: a sharp control pulse produces a fast attack and a long fall, which is the amplitude envelope of a struck physical object, and it is why a low-pass gate needs no envelope generator. The two time constants are the paper's own, from the Perkin Elmer VTL5C3/2 datasheet; the LAW that turns this knob into them is ours (kernels' G6).";

export const VCV_B208_DUAL_LPG_SPEC = {
  type: "audio_vcv_b208duallpg", module: "vcvB208DualLpg", title: "VCV b208 Dual LPG", family: "filter",
  icon: "mdi:blur-linear", readout: "level_1", w: 190,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:2569-2589 @ f895816 (v0.6.38 'DUAL DUAL LPG'), which NAMES its algorithm: J. Parker & S. D'Angelo, 'A Digital Model of the Buchla Lowpass-Gate', Proc. DAFx-13, Maynooth 2013, pp. 278-285",
    read: "2026-08-06",
    layout: "PROVED BY THE CABLES — P22 wires in_1..in_4, cv_1..cv_4 and out_1..out_4 index-aligned (core/audio_patches_vcv_fx.js)",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source. But this is the block's most solid node anyway, because the changelog names the algorithm outright and the algorithm is PUBLISHED: Parker and D'Angelo's DAFx-13 model of the Buchla 292, implemented from its own equations. Four low-pass gates. What makes one different from a filter with a VCA after it is the VACTROL — a photoresistor that brightens in 12 ms and fades over 250 ms, so every gate open is a struck-object envelope you did not have to draw.",
  inputs: [
    ...specUnderscored("in", 4).map((key, n) => ({ key, type: "audio", label: `in ${n + 1}` })),
    ...specUnderscored("cv", 4).map((key, n) => ({ key, type: "number", label: `cv ${n + 1}` })),
  ],
  outputs: specUnderscored("out", 4).map((key, n) => ({ key, type: "audio", label: `out ${n + 1}` })),
  knobs: [1, 2, 3, 4].flatMap((n) => [
    { key: `level_${n}`, label: `Level ${n}`, default: 0, ...FRACTION, help: `Gate ${n}'s BASE level — the panel's right-hand slider, "the base level of action on the LPG". It sums with the CV, so a level above zero holds the gate part-open with no cable patched, which is how you use one of these as a plain filter.` },
    { key: `cv_amount_${n}`, label: `CV ${n}`, default: 1, ...BIPOLAR, help: `How much of the \`cv_${n}\` input reaches gate ${n} — the panel's left-hand slider, "the VCA for the incoming CV coming in from the BLACK socket". Negative inverts, so an envelope can CLOSE the gate instead of opening it.` },
    { key: `reso_${n}`, label: `Reso ${n}`, default: 0, ...FRACTION, help: `Gate ${n}'s resonance, as a fraction of the instability ceiling the paper's Eq. 11 gives. INERT UNLESS THE MODE IS \`lp\` — resonance enters through the 4.7 nF feedback capacitor and the other two modes do not have one, which is the panel's own rule ("if in 'only LP mode' there is the RESO knob"). The vendor's note is worth repeating: "for a real 208, the RESO should be full CCW (but I like to use it!)".` },
    { key: `response_${n}`, label: `Vactrol ${n}`, default: 1, ...FRACTION, help: LPG_RESPONSE_HELP },
    { key: `mode${n}`, label: `Mode ${n}`, default: "vca_lp", discrete: true, options: LPG_MODE_OPTIONS, help: LPG_MODE_HELP },
  ]),
};

export const VCV_POLY_LPG_SPEC = {
  type: "audio_vcv_polylpg", module: "vcvPolyLpg", title: "Poly LPG", family: "filter",
  icon: "mdi:blur", readout: "level",
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:2329-2331 @ f895816 ('POLY LPG … it's just one of the b208 dual dual LPG expanded and used in polyphonic mode'), so the same DAFx-13 model; knob names cross-checked against the Vult Julste documentation (vult-dsp.com, read 2026-08-06), which is that paper's model rewritten by another author",
    read: "2026-08-06",
    layout: "PROVISIONAL in the harvest, and still provisional: in/cv/out is the only reading of a three-jack LPG, but no cable proves the order",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source. One Buchla low-pass gate, sharing the dual LPG's kernel exactly because the changelog says it IS that section. **ITS POLYPHONY IS NOT PORTED**: on hardware one CV cable opens sixteen gates at once, and a PowerRP wire is mono, so this is voice one. That is a real loss and the reason it is stated on the card rather than only in a docblock.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "cv", type: "number", label: "cv" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "level", label: "Range", default: 1, ...BIPOLAR, help: "How much of the CV input reaches the gate — Julste calls this Range, \"attenuates or amplifies the gate signal allowing to open or close more the gate\". Negative inverts." },
    { key: "offset", label: "Offset", default: 0, ...BIPOLAR, help: "Added to the gate CV, so this and Range together set the gate's minimum and maximum. With nothing patched, Offset alone is the gate's resting opening." },
    { key: "response", label: "Vactrol", default: 1, ...FRACTION, help: LPG_RESPONSE_HELP },
    { key: "reso", label: "Reso", default: 0, ...FRACTION, help: "Resonance, INERT unless the mode is `lp` — see the dual LPG's Reso for why. Julste exposes the same control and the same restriction." },
    { key: "mode", label: "Mode", default: "vca_lp", discrete: true, options: LPG_MODE_OPTIONS, help: LPG_MODE_HELP },
  ],
};

// ── MODULATION: THE ENVELOPES ───────────────────────────────────────────────

/** The `help` for a LIN-EXP curve control. Both envelopes have one. */
const ENV_CURVE_HELP = "The panel's LIN-EXP control: 0 is a straight-line ramp, 1 is the exponential shape an analogue envelope really has. THE BEND'S STRENGTH IS OURS, not the vendor's (kernels' G7) — the changelog names the control and its two ends and never states its law, so the curve is right in shape and unverified in degree.";

export const VCV_ATTACK_DECAY_SPEC = {
  type: "audio_vcv_attackdecay", module: "vcvAttackDecay", title: "Attack Decay", family: "modulation",
  icon: "mdi:chart-bell-curve", readout: "attack",
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:4999-5013 @ f895816 (v0.4.10, 'AD Envelope (AttackDecay Envelope) … A standard Envelope with some 281 features'), cross-checked against :4406-4419 ('8 ATTACK DECAY')",
    read: "2026-08-06",
    layout: "the changelog NAMES every jack (attack CV, decay CV, trig in, EOC out, env out); the harvest supplies the order. `retrig` is the one name the changelog lacks — kernels' G8.",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source. A two-stage envelope with the Buchla 281's features: attack and decay in seconds, both CV-summable, a linear-to-exponential curve, a SCALE that can invert the whole shape, a LOOP switch that turns it into an LFO, and an end-of-cycle pulse. **THE TWO TIME KNOBS ARE READ AS SECONDS AND THAT IS A GUESS** (kernels' G9): the harvested patch dials could be seconds or normalised positions, and only the source would settle it.",
  inputs: [
    { key: "attack_cv", type: "number", label: "atk cv" },
    { key: "decay_cv", type: "number", label: "dec cv" },
    { key: "retrig", type: "trigger", label: "retrig" },
    { key: "trig", type: "trigger", label: "trig" },
  ],
  outputs: [
    { key: "out", type: "audio", label: "env" },
    { key: "eoc", type: "trigger", label: "eoc" },
  ],
  knobs: [
    { key: "attack", label: "Attack", default: 0.4365, min: 0, max: ENV_MAX_SECONDS, step: TIME_STEP, unit: " s", help: "Rise time. The CV inlet ADDS to this rather than multiplying it — the changelog's own sentence about the CV jack is \"accept also negative values like, will be subtracted form the main value\", which is a signed sum. The default is P4's own harvested dial, read as seconds (G9)." },
    { key: "decay", label: "Decay", default: 0.1, min: 0, max: ENV_MAX_SECONDS, step: TIME_STEP, unit: " s", help: "Fall time, and the CV adds here too. A decay much shorter than the attack is the percussive shape; the reverse is a swell." },
    { key: "curve", label: "Curve", default: 1, ...FRACTION, help: ENV_CURVE_HELP },
    { key: "scale", label: "Scale", default: 1, min: -2, max: 2, step: LEVEL_STEP, help: "Multiplies the whole envelope — the panel's SCALE, documented as \"-2x to 2x … is used to invert the envelope\". NEGATIVE IS THE POINT: an inverted envelope closing a gate is how a west-coast patch ducks." },
    { key: "loop", label: "Loop", default: 0, ...SWITCH, help: "The LOOP switch: when on, the end-of-cycle pulse restarts the attack, so the envelope free-runs as an LFO whose shape you drew. A LATCHING switch, so unlike the panel's TRIG button it IS property state and is ported." },
  ],
};

export const VCV_B208_ENVELOPE_SPEC = {
  type: "audio_vcv_b208envelope", module: "vcvB208Envelope", title: "VCV b208 Envelope", family: "modulation",
  icon: "mdi:chart-line-variant", readout: "attack_1", w: 180,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:2683-2698 @ f895816 (v0.6.35, 'DUAL (208) ENVELOPE'), a complete panel walk — gate/trig in, EOC pulse out, SUST/TRANS radio, 0-10 V env out, attack 2 ms-10 s CV-controllable, duration, decay",
    read: "2026-08-06",
    layout: "DERIVED FROM CABLE STRIDES, NOT PUBLISHED (kernels' G10). P22 wires i0 and i4 (both triggers) and i3 and i7 (both numbers) — two pairs four apart — which fixes a DUAL module's section stride at four; o2 and o5 are three apart and both continuous, and the dropped self-patch o4→i4 fixes the output stride at three. Port KEYS therefore stay indices; the LABELS carry the reading.",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source, and **THIS NODE'S JACK ORDER IS INFERRED FROM FOUR CABLES** rather than read anywhere, which is why its ports are numbered instead of named (the labels say what we believe each one is). Two copies of the Buchla Music Easel's 208 envelope. Each is attack, then either a fixed DURATION at full level (transient) or a hold for as long as the gate stays up (sustained), then decay, then a 1 ms end-of-cycle pulse — the pulse the Easel patch traditionally feeds back into the trigger to make the envelope free-run.",
  inputs: specMixedIndexPorts("i", [
    ["trigger", "gate 1"], ["number", "atk cv 1"], ["number", "dur cv 1"], ["number", "dec cv 1"],
    ["trigger", "gate 2"], ["number", "atk cv 2"], ["number", "dur cv 2"], ["number", "dec cv 2"],
  ]),
  outputs: specMixedIndexPorts("o", [
    ["trigger", "eor 1"], ["trigger", "eoc 1"], ["number", "env 1"],
    ["trigger", "eor 2"], ["trigger", "eoc 2"], ["number", "env 2"],
  ]),
  knobs: [1, 2].flatMap((n) => [
    { key: `attack_${n}`, label: `Attack ${n}`, default: 0.01, min: 0, max: ENV_MAX_SECONDS, step: TIME_STEP, unit: " s", help: `Section ${n}'s rise time; the panel says 2 ms to 10 s and the kernel clamps at the 2 ms floor. Its CV inlet (\`i${(n - 1) * 4 + 1}\`) adds to it.` },
    { key: `duration_${n}`, label: `Duration ${n}`, default: 0.1, min: 0, max: ENV_MAX_SECONDS, step: TIME_STEP, unit: " s", help: `How long section ${n} holds at full level before the decay — "only working if in transient mode", says the panel, because in sustained mode the GATE decides instead. INAPPLICABLE IN SUSTAINED MODE: the spec vocabulary has no \`when\` clause to hide a row with, so this sentence is the honest interim (the same gap core/audio_specs_ax2.js records).` },
    { key: `decay_${n}`, label: `Decay ${n}`, default: 0.5, min: 0, max: ENV_MAX_SECONDS, step: TIME_STEP, unit: " s", help: `Section ${n}'s fall time. Its CV inlet is \`i${(n - 1) * 4 + 3}\` — which is where P22's hand-set Surveillance voltages land, IF the fourth jack per section really is decay CV (kernels' G11).` },
    { key: `curve_${n}`, label: `Curve ${n}`, default: 1, ...FRACTION, help: ENV_CURVE_HELP },
    {
      key: `mode${n}`, label: `Mode ${n}`, default: "transient", discrete: true, options: ["transient", "sustained"],
      help: `The SUST-TRANS radio button. \`transient\` makes the gate jack a TRIGGER — one edge runs the whole attack/duration/decay shape and the length is yours. \`sustained\` makes it a GATE — the envelope holds at full level until the signal falls, which is what you want when a keyboard is playing it.`,
    },
  ]),
};

// ── EFFECTS ─────────────────────────────────────────────────────────────────

export const VCV_QUAD_PANNER_SPEC = {
  type: "audio_vcv_quadpanner", module: "vcvQuadPanner", title: "VCV QuadPanner", family: "effect",
  icon: "mdi:view-grid-outline", readout: "azimuth", w: 175,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:4676-4687 @ f895816 (v0.5.8.0 'QUAD PANNER', a complete control walk: 'implements some of the functionalities of a single channel of the Buchla 227e'), plus :4672 (chaining), :1254-1256 (the 10 V CV mode and the touch gate), :1583-1586 and :2428-2430 (the Y-axis inversions)",
    read: "2026-08-06",
    layout: "PROVED BY THE CABLES — P22 chains four of these, out_fl/out_fr/out_rl into the next one's chain_fl/chain_fr/chain_rl, which is a corner-for-corner match",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source. One channel of a Buchla 227e: it places a mono source anywhere in a four-corner room, by XY position, by azimuth and distance, or by an internal SWIRL LFO that rotates it. The precedence between those three is the vendor's own and is ported exactly — a patched X or Y beats the swirl, and the swirl beats the azimuth knob. Chain several and each adds its source to the same four buses.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "x", type: "number", label: "x" },
    { key: "y", type: "number", label: "y" },
    { key: "chain_fl", type: "audio", label: "ch FL" },
    { key: "chain_fr", type: "audio", label: "ch FR" },
    { key: "chain_rl", type: "audio", label: "ch RL" },
    { key: "chain_rr", type: "audio", label: "ch RR" },
  ],
  outputs: [
    { key: "out_fl", type: "audio", label: "FL" },
    { key: "out_fr", type: "audio", label: "FR" },
    { key: "out_rl", type: "audio", label: "RL" },
    { key: "out_rr", type: "audio", label: "RR" },
    { key: "gate", type: "trigger", label: "gate" },
  ],
  knobs: [
    { key: "azimuth", label: "Azimuth", default: 0, ...BIPOLAR, unit: " cyc", help: "Where the source sits around the room, in turns — 0 is front-right, 0.25 is front-left, and it WRAPS rather than clamping (the changelog's own \"corrected OFFSET for AZIMUTH (not clamping but rotating)\"). Only reached when nothing is patched to X or Y and the swirl rate is zero." },
    { key: "magnitude", label: "Distance", default: 1, ...FRACTION, help: "How far from the centre the source sits, along the azimuth. At 0 it is dead centre and feeds all four corners equally — unless Black Hole is on, in which case it vanishes." },
    { key: "swirl_rate", label: "Swirl", default: 0, min: 0, max: 20, step: LEVEL_STEP, unit: " Hz", help: "The internal rotation LFO, \"a la 227e\". ANY value above zero overrides the Azimuth knob, which is the documented precedence and not a quirk — so leave it at 0 to place the source by hand. At a few hertz this is the classic Buchla spin." },
    { key: "swirl_amount", label: "Swirl radius", default: 1, ...FRACTION, help: "How wide the swirl's circle is — the panel calls it AMPLI and notes it is the magnitude again. At 0 the source spins in place at the centre, which is only audible with Black Hole on." },
    {
      key: "panLaw", label: "Pan law", default: "linear", discrete: true, options: ["linear", "equal_power"],
      help: "`linear` is the module's default and fades a corner in proportion to distance — which means the total loudness is NOT constant as the source moves: it runs from 0.92 at the edges to 1.17 at the corners, so a slow pan swells as it reaches a speaker. `equal_power` divides the four gains by the root of their own summed squares, so that sum is exactly one wherever the source sits and a pan holds its loudness. At the exact centre the two settings coincide, because the linear law already happens to be unit-power there. THE DISTANCE MEASURE UNDER BOTH IS OURS (kernels' G12) — the changelog names the two laws and never says linear in what.",
    },
    {
      key: "blackHole", label: "Black hole", default: "off", discrete: true, options: ["off", "on"],
      help: "The panel's INFINITE DISTANCE CENTER flag: \"the center becomes an AUDIO BLACK HOLE, the audio disappear if the magnitude approximates to ZERO\". With it on, pulling the source to the middle mutes it — so the swirl radius becomes a depth control. The ramp's shape is ours (kernels' G13).",
    },
  ],
};

export const VCV_CLOCKABLE_DELAY_SPEC = {
  type: "audio_vcv_clockabledelay", module: "vcvClockableDelay", title: "VCV ClockableDelay", family: "effect",
  icon: "mdi:chart-timeline-variant", readout: "time", w: 200,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:3802-3835 @ f895816 (v0.6.16 'CLOCKABLEDELAY', a complete parameter walk: 'Freely inspired from MS Dual Looping Delay'), plus :3762 (the ±20 V limiter) and :3785-3790 (HOLD preserves the buffer)",
    read: "2026-08-06",
    layout: "the changelog NAMES every jack and the harvest supplies the order. FOUR OUTPUTS ARE UNATTESTED — the entry names exactly two send/return pairs, i.e. four sends across two channels, and the harvested list has eight (kernels' G14).",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source. A stereo looping delay after the Make Noise Dual Looping Delay: one time base for both channels, feedback that goes past unity on purpose, HOLD to freeze the buffer forever, REVERSE to run the read head backwards through it, and send/return breaks before the feedback and before the dry/wet so you can put anything you like inside the loop. In P4 two of these are the Microcosm's looping pedals.",
  inputs: [
    { key: "in_l", type: "audio", label: "in L" },
    { key: "in_r", type: "audio", label: "in R" },
    { key: "return_fb_l", type: "audio", label: "ret fb L" },
    { key: "return_fb_r", type: "audio", label: "ret fb R" },
    { key: "return_dw_l", type: "audio", label: "ret dw L" },
    { key: "return_dw_r", type: "audio", label: "ret dw R" },
    { key: "feed_in", type: "number", label: "feed cv" },
    { key: "feedback", type: "number", label: "fb cv" },
    { key: "time", type: "number", label: "time cv" },
    { key: "tap", type: "trigger", label: "tap" },
    { key: "trig_time", type: "trigger", label: "trig t" },
    { key: "hold", type: "trigger", label: "hold" },
    { key: "reverse", type: "trigger", label: "rev" },
  ],
  outputs: [
    { key: "send_fb_l", type: "audio", label: "snd fb L" },
    { key: "send_fb_r", type: "audio", label: "snd fb R" },
    { key: "send_dw_l", type: "audio", label: "snd dw L" },
    { key: "send_dw_r", type: "audio", label: "snd dw R" },
    { key: "send_rev_l", type: "audio", label: "snd rev L" },
    { key: "send_rev_r", type: "audio", label: "snd rev R" },
    { key: "send_hold_l", type: "audio", label: "snd hld L" },
    { key: "send_hold_r", type: "audio", label: "snd hld R" },
    { key: "out_l", type: "audio", label: "out L" },
    { key: "out_r", type: "audio", label: "out R" },
    { key: "pulse", type: "trigger", label: "pulse" },
  ],
  knobs: [
    { key: "time", label: "Time", default: 8.4788, min: 0, max: 180, step: TIME_STEP, unit: " s", help: "The base delay, before Mult. The module's own ceiling is 180 seconds; how much of it this instance can actually reach is set by Buffer, because the memory has to be allocated up front. The default is P4's own harvested dial — 8.48 s, against its sibling's 5.26 s, an incommensurate pair that never lines up." },
    { key: "mult", label: "Mult", default: 1, min: 0.001, max: 32, step: TIME_STEP, help: "Multiplies the base time — \"to have 1/8th (like in the DLD) you must multiply by 0.125\". This is the CLOCKABLE half: tap or trigger a tempo into the base time and then take any absurd division of it here." },
    { key: "feed_in", label: "Feed in", default: 1, min: 0, max: 2, step: LEVEL_STEP, help: "How much of the input enters the delay line, 0 to 200%. Above 1 it drives the ±20 V limiter, which is the module's own saturation and part of why it sounds like a tape loop rather than a clean delay." },
    { key: "feedback", label: "Feedback", default: 0.5945, min: 0, max: 1.1, step: LEVEL_STEP, help: "How much of the delayed signal is written back, 0 to 110%. THE CEILING IS ABOVE UNITY ON PURPOSE — the panel's own annotation is \"(beware !!!)\". Past 1.0 the loop grows until the limiter catches it, which is the runaway wash this module is famous for." },
    { key: "dry_wet", label: "Dry / wet", default: 0.5, ...FRACTION, help: "0 is the input untouched, 1 is delay only. The dry/wet mixer sits AFTER the second send/return break, so anything patched into that return is what gets mixed." },
    { key: "max_seconds", label: "Buffer", default: 30, min: 0.001, max: 180, step: TIME_STEP, unit: " s", construct: true, help: "CONSTRUCT-TIME: this sizes the delay memory, so changing it rebuilds the module. The vendor's ceiling is 180 seconds and it IS reachable here — but 180 s costs 69 MB per instance and P4 places two, so the default covers the harvested patch with room instead. Raise it deliberately when you want a minutes-long loop." },
  ],
};

// ── MIXING AND VOLTAGE SOURCES ──────────────────────────────────────────────

export const VCV_NYSTHI_MIX4_SPEC = {
  type: "audio_vcv_nysthi_mix4", module: "vcvNysthiMix4", title: "NYSTHI Mix4", family: "modulation",
  icon: "mdi:tune-vertical", readout: "master", w: 175,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:3708-3727 @ f895816 (v0.6.19 '4MIX + 8MIX + 16MIX': four channels with volume, volume CV, volume CV VCA, pan, pan CV, pan CV VCA, solo, mute; master out with its own volume and CV), renamed to mix4 at :651",
    read: "2026-08-06",
    layout: "PROVISIONAL, and the harvest says so. What the changelog DOES settle is that a per-channel volume CV and a master volume CV both exist, so the ports are the right KIND even though their indices are unproved.",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source, and **THIS NODE'S PORT ORDER IS STILL PROVISIONAL**: the changelog confirms the controls exist and never says which jack is which. A four-channel mixer whose channel and master volumes each take a CV that MULTIPLIES rather than adds — so a cable at 0 V mutes the channel while no cable leaves it alone, and each CV has its own attenuator so patching one never silences the desk by surprise.",
  inputs: [
    ...[1, 2, 3, 4].map((n) => ({ key: `in${n}`, type: "audio", label: `in ${n}` })),
    ...[1, 2, 3, 4].map((n) => ({ key: `cv${n}`, type: "number", label: `cv ${n}` })),
    { key: "master_cv", type: "number", label: "mst cv" },
  ],
  outputs: [
    { key: "out_l", type: "audio", label: "out L" },
    { key: "out_r", type: "audio", label: "out R" },
  ],
  knobs: [
    ...[1, 2, 3, 4].flatMap((n) => [
      { key: `level${n}`, label: `Level ${n}`, default: 0.8, ...FRACTION, help: `Channel ${n}'s fader, as a linear amplitude. THE LAW IS A GUESS (kernels' G15): the panel calls it a "VOLUME display controller" and never says whether its stored number is an amplitude or a decibel position.` },
      { key: `pan${n}`, label: `Pan ${n}`, default: 0, ...BIPOLAR, help: `Channel ${n}'s position, constant power — the two gains' squares always sum to one, so sweeping it does not dip in the middle.` },
      { key: `cv_amount${n}`, label: `CV amt ${n}`, default: 1, ...FRACTION, help: `How much of \`cv${n}\` reaches channel ${n}'s fader. IT MULTIPLIES, which is why it is a separate control and not a second inlet on the fader — and why it DEFAULTS TO FULL rather than zero: a 0 default would mute the channel the instant anyone patched a cable.` },
    ]),
    { key: "master", label: "Master", default: 0.8, ...FRACTION, help: "The output fader, applied after the four channels sum. Same linear-amplitude guess as the channel faders." },
    { key: "master_cv_amount", label: "Master CV amt", default: 1, ...FRACTION, help: "How much of `master_cv` reaches the output fader. Multiplies, and defaults to full for the same reason the channel attenuators do." },
  ],
};

export const VCV_SURVEILLANCE_SPEC = {
  type: "audio_vcv_surveillance", module: "vcvSurveillance", title: "VCV Surveillance", family: "modulation",
  icon: "mdi:altimeter", readout: "main", w: 165,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:5188-5192 @ f895816 ('new module: one control to send 10 different voltages / the main pot goes from -5 to +5 / all the outs are controlled by attuenverters') and :5202-5205 (the two-range switch)",
    read: "2026-08-06",
    layout: "ten identical outputs need no order; P22 wires four of them into the two 208 envelopes' CV inlets",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source. A bank of hand-set voltages: ONE main pot, and ten attenuverters that each scale it to their own output. So turning the main pot moves all ten together, in proportion — which is what makes this a performance control rather than ten separate offsets. **A NODE_REGISTRY CORRECTION rides with it**: the registry files this module under `vcv/recorder` and marks it chrome. It is neither; it is a voltage SOURCE, and P22 would have lost four hand-set voltages if it had been dropped as decoration.",
  inputs: [],
  outputs: specUnderscored("out", 10).map((key, n) => ({ key, type: "number", label: `out ${n + 1}` })),
  knobs: [
    { key: "main", label: "Main", default: 1, ...BIPOLAR, help: "The one pot every output is scaled from, as a fraction of the selected range's travel. At 1 in bipolar mode it is +5 V; the attenuverters then decide what each output does with that." },
    ...specUnderscored("v", 10).map((key, n) => ({
      key, label: `Atten ${n + 1}`, default: 0, ...BIPOLAR,
      help: `Output ${n + 1}'s attenuverter: its voltage is the main pot times this. Negative inverts, so one pot can push some destinations up while pulling others down — which is the whole reason to use this instead of ten constants. ⚠ IF A HARVESTED PATCH SETS THIS, CHECK IT: the harvest read these as VOLTAGES and divided them by five (kernels' G16), and if they are really attenuverter positions the stored numbers are five times too small. Reported to the lead; the patch files are not this block's to edit.`,
    })),
    {
      key: "range", label: "Range", default: "bipolar", discrete: true, options: ["bipolar", "unipolar"],
      help: "The panel's range switch: `bipolar` is −5 V to +5 V, `unipolar` is 0 V to +10 V. Unipolar is what you want when the destination is a gate level or a one-sided CV, because a negative excursion there does nothing visible and wastes half the pot.",
    },
  ],
};

// ── THE STAGE SEQUENCERS ────────────────────────────────────────────────────

/** SQUONK's stage count, restated from the kernels' SQUONK_STAGES. */
const SQUONK_STAGES = 12;

/** Its five CV channel letters, restated from the kernels' SQUONK_CHANNELS. */
const SQUONK_CHANNELS = ["a", "b", "c", "d", "e"];

/** Its ratchet ceiling, restated from the kernels' SQUONK_MAX_REPEATS. */
const SQUONK_MAX_REPEATS = 8;

/** The Programmer's stage count, restated from the kernels' PROGRAMMER_STAGES. */
const PROGRAMMER_STAGES = 16;

/** Its four CV channel letters, restated from the kernels' PROGRAMMER_CHANNELS. */
const PROGRAMMER_CHANNELS = ["a", "b", "c", "d"];

/**
 * Pure function. A stage sequencer's generated knob band — one CV knob per
 * channel per stage, then a mode per stage, then a repeat count per stage.
 *
 * GENERATED FOR TWO REASONS. The small one: a hand-typed 84- or 112-entry list is
 * a list with a typo. The large one: `synth/worklets/processors_vc8.js` generates
 * the matching AudioParams the same way, so the two lists have one SHAPE between
 * them and `tests/port_vc8_test.js` compares them element for element. VC-2's
 * SEQ3 (24 generated CV knobs) and VC-3b's PEQ (28) are the precedent; see the
 * kernels' D18 for why a 12 × 11 matrix is a knob band and not a list property.
 *
 * @param {string[]} channels - the CV channel letters, in panel order
 * @param {number} stages - how many stages
 * @param {number} maxRepeats - the ratchet ceiling
 * @param {string[]} modeNames - the three mode values, low to high
 * @param {number} modeDefault - which of them a fresh stage takes
 * @returns {object[]} spec knob records
 *
 * @example stageBandKnobs(["a"], 2, 8, ["run", "stop", "skip"], 0).length // 6
 * @example stageBandKnobs(["a"], 2, 8, ["run", "stop", "skip"], 0)[0].key // "a1"
 * @example stageBandKnobs(["a", "b"], 3, 8, ["run", "stop", "skip"], 0).length // 12
 */
function stageBandKnobs(channels, stages, maxRepeats, modeNames, modeDefault) {
  const knobs = [];
  for (const channel of channels) {
    for (let stage = 1; stage <= stages; stage++) {
      knobs.push({
        key: `${channel}${stage}`, label: `${channel.toUpperCase()}${stage}`, default: 0, ...BIPOLAR,
        help: `Stage ${stage}'s value on CV channel ${channel.toUpperCase()}. Ordinary keyframable state, which is the thing this node can do that the hardware cannot: a whole sequence can be rewritten between slides.`,
      });
    }
  }
  for (let stage = 1; stage <= stages; stage++) {
    knobs.push({
      key: `mode${stage}`, label: `Mode ${stage}`, default: modeDefault, min: 0, max: modeNames.length - 1, step: 1,
      help: `What the sequencer does at stage ${stage}: ${modeNames.map((name, index) => `${index} = ${name}`).join(", ")}. A NUMBER rather than a dropdown because it lives in the DSP loop and there are ${stages} of them — the same call VC-2's SEQ3 makes for its per-step gates.`,
    });
  }
  for (let stage = 1; stage <= stages; stage++) {
    knobs.push({
      key: `rep${stage}`, label: `Rep ${stage}`, default: 1, min: 1, max: maxRepeats, step: 1,
      help: `How many times stage ${stage} retriggers while it is held — the panel's REP line, "will retrig the step from 1 to ${maxRepeats} times (subdivisions)". This is ratcheting, and the subdivision is measured against the last clock interval (kernels' G18).`,
    });
  }
  return knobs;
}

export const VCV_SQUONK_SPEC = {
  type: "audio_vcv_squonk", module: "vcvSquonk", title: "VCV SQUONK", family: "modulation",
  icon: "mdi:stairs", readout: "rot", w: 185,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:4790-4820 @ f895816 (v0.5.4 'THE SQUONK: it's a PROGRAMMER, STAGE sequencer, Sampler TRIGGER, freely inspired to Serge TKB / is 12 steps with 11 lines of programming'), documented line by line, plus :4771-4774 (the 1/12 V SEL CV quantization)",
    read: "2026-08-06",
    layout: "THE CHANGELOG CONFIRMS EVERY HARVESTED NAME. sel, clock, start, stop, reset, rnd, chain_trig in and a, b, c, d, e, trig, last, clock_out out are one for one the global controls the entry lists — unusually strong evidence for this block.",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source, but this is the most completely documented module in the set: the changelog walks all eleven programming lines. A Serge TKB-style stage programmer — twelve stages, five CV channels each, a per-stage jump/CV-only/CV-and-trigger mode, and per-stage ratcheting. In P4 five of these at five different clock tempos are what make five grain clouds drift against each other. **THE 12 × 11 MATRIX IS A KNOB BAND** (84 rows) because an audio spec has no list row; see kernels' D18.",
  inputs: [
    { key: "sel", type: "number", label: "sel" },
    { key: "clock", type: "trigger", label: "clock" },
    { key: "start", type: "trigger", label: "start" },
    { key: "stop", type: "trigger", label: "stop" },
    { key: "reset", type: "trigger", label: "reset" },
    { key: "rnd", type: "trigger", label: "rnd" },
    { key: "chain_trig", type: "trigger", label: "chain" },
  ],
  outputs: [
    ...SQUONK_CHANNELS.map((channel) => ({ key: channel, type: "number", label: channel.toUpperCase() })),
    { key: "trig", type: "trigger", label: "trig" },
    { key: "last", type: "trigger", label: "last" },
    { key: "clock_out", type: "trigger", label: "clk out" },
  ],
  knobs: [
    { key: "sel", label: "Select", default: 0, min: 0, max: SQUONK_STAGES - 1, step: 1, help: "Which stage is current, when nothing is driving the SEL input. Patching SEL overrides it — a CV of 0 to 10 V addresses the twelve stages, quantized to the 1/12 V keyboard grid the vendor added in 2017 so a keyboard can pick stages." },
    { key: "rot", label: "Rotate", default: 0, min: -5, max: 5, step: 1, help: "Shifts which stage's values are read out, without moving the playhead — so the same clock walks the same path while the pattern slides under it. THE PANEL SAYS THIS ROTATES \"the yellow channel\"; reading that as the whole CV bank is ours (kernels' G17), because we cannot see the panel's colours." },
    { key: "up", label: "Count up", default: 0, ...SWITCH, help: "The UP switch: on, the sequence walks forward; off (the default) it walks DOWN, which is the module's own normal direction and not a mistake." },
    { key: "rnd", label: "Random", default: 0, ...SWITCH, help: "The RND latch: while on, each clock jumps to a random stage instead of the next one. Seeded — see Seed — so the same document always produces the same wandering." },
    { key: "multiply", label: "5×", default: 0, ...SWITCH, help: "The panel's 5X line: multiplies every CV channel by five, so the A/B/C channels reach 10 V and D/E reach ±5 V. Off, they stay in the 0…2 V and ±1 V ranges the entry documents, which is where they sit if you are driving something expecting small CVs." },
    ...stageBandKnobs(SQUONK_CHANNELS, SQUONK_STAGES, SQUONK_MAX_REPEATS, ["CV and trig", "CV only", "jump"], 0),
    { ...SEED },
  ],
};

export const VCV_PROGRAMMER_SPEC = {
  type: "audio_vcv_programmer", module: "vcvProgrammer", title: "VCV Programmer", family: "modulation",
  icon: "mdi:format-list-numbered", readout: "rep1", w: 185,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:1063-1098 @ f895816 ('a new OLD sequencer/programmer module / perfect imitation of the CGS 16 step SERGE programmer with extras'), a complete panel walk of the sixteen stages and the global jacks",
    read: "2026-08-06",
    layout: "DERIVED, AND IT CORRECTS THE STUB. The stub quoted the RAEL entry ('12 GATE PULSE programmers'), a different module. The real entry says SIXTEEN stages each with its own select-trigger IN and pulse OUT, so i0..i15 and o0..o15 are per stage — which makes i16 the first global input (P22 sends a clock there, i.e. FORWARD CLOCK) and o16..o19 exactly the A/B/C/D CV outputs (P22 reads all four into an 8:1 selector). Every index in the patch lands on a jack the changelog names.",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source. The CGS 16-step Serge programmer: sixteen stages, four CV channels each, a per-stage RUN/STOP/SKIP, per-stage ratcheting, and a select-trigger IN plus a pulse OUT for every stage — which is what lets you use it as a sequencer, a programmer or a keyboard. Its ports stay numbered because the layout is DERIVED from cable indices plus the changelog rather than published; the labels say what we believe each one is.",
  inputs: [
    ...specIndexPorts("i", "trigger", Array.from({ length: PROGRAMMER_STAGES }, (_, n) => `sel ${n + 1}`)),
    { key: "i16", type: "trigger", label: "clk fwd" },
    { key: "i17", type: "trigger", label: "clk bwd" },
    { key: "i18", type: "number", label: "addr" },
  ],
  outputs: [
    ...specIndexPorts("o", "trigger", Array.from({ length: PROGRAMMER_STAGES }, (_, n) => `st ${n + 1}`)),
    ...PROGRAMMER_CHANNELS.map((channel, n) => ({ key: `o${PROGRAMMER_STAGES + n}`, type: "number", label: channel.toUpperCase() })),
    { key: "o20", type: "trigger", label: "trig" },
    { key: "o21", type: "trigger", label: "push" },
  ],
  knobs: [
    ...stageBandKnobs(PROGRAMMER_CHANNELS, PROGRAMMER_STAGES, SQUONK_MAX_REPEATS, ["run", "stop", "skip"], 0),
    ...Array.from({ length: PROGRAMMER_STAGES }, (_, n) => ({
      key: `active${n + 1}`, label: `Active ${n + 1}`, default: 1, ...SWITCH,
      help: `Stage ${n + 1}'s ACTIVE switch — "if OFF stage will not emit the pulse(s)". The stage is still WALKED and still sets the CV outputs; it just goes by silently, which is how you punch holes in a rhythm without changing its length.`,
    })),
  ],
};

export const VCV_SOY_MODEL_SOU_SPEC = {
  type: "audio_vcv_soymodelsou", module: "vcvSoyModelSou", title: "VCV SoyModelSOU", family: "modulation",
  icon: "mdi:dice-multiple-outline", readout: "rate_1", w: 180,
  derivation: {
    kind: "behaviour",
    document: "NYSTHI CHANGELOG.md:4805-4841 @ f895816 ('IS an imitation of the FLUCTUATING, QUANTIZED and STORED voltages sections of the Buchla 266 Source of Uncertainty'), section by section, plus :4753-4762 (the later PULSE IN, PROBABILITY, GATE OUT and three flip-flops)",
    read: "2026-08-06",
    layout: "THE WEAKEST IN THE BLOCK — kernels' G23. The changelog names every section and no order at all. The layout used here is the one ordering that makes P22's cables coherent (o6 and o7 drive a panner's X/Y and must therefore be CONTINUOUS, which puts the two quantized outputs there) AND agrees with Rack enum-append order for the features added in later releases. It is an inference, not a fact, so the port KEYS stay indices.",
  },
  help: "APPROXIMATED FROM DOCUMENTATION, NOT PORTED — NYSTHI ships no source, and **THIS NODE HAS THE LEAST CERTAIN JACK LAYOUT IN THE BLOCK**: its sections are documented, their ORDER is inferred from what the patch's cables must be carrying. A Buchla 266 Source of Uncertainty — two fluctuating random generators (each with a smoothed voltage, the raw sampled one and a pulse), two quantized random sections (one in semitone steps, one in volt steps with a two-dice triangular distribution), a stored random voltage with a skew control, and three flip-flops. Everything it draws is SEEDED, so a document renders the same way every time.",
  inputs: [{ key: "i0", type: "trigger", label: "pulse in" }],
  outputs: specMixedIndexPorts("o", [
    ["number", "1 smooth"], ["number", "1 hard"], ["trigger", "1 pulse"],
    ["number", "2 smooth"], ["number", "2 hard"], ["trigger", "2 pulse"],
    ["number", "2^n"], ["number", "n+1"], ["number", "stored"],
    ["trigger", "1 gate"], ["trigger", "2 gate"],
    ["trigger", "ff 1"], ["trigger", "ff 2"], ["trigger", "ff 3"],
  ]),
  knobs: [
    { key: "rate_1", label: "Rate 1", default: 0.2, ...FRACTION, help: "Section 1's sampling rate across the documented 0.05 to 50 draws per second. At the bottom it is a voltage that changes twice a minute; at the top it is noise." },
    { key: "smooth_1", label: "Smooth 1", default: 0.2, min: 0, max: 10, step: LEVEL_STEP, unit: " s", help: "The time constant of section 1's SMOOTH output — the lag between the raw sampled voltage and the gliding one. The HARD output is unaffected, which is the point of having both." },
    { key: "probability_1", label: "Prob 1", default: 1, ...FRACTION, help: "How likely section 1 is to emit its pulse when the sampled voltage clears the threshold — the panel's \"PROBABILTY to HAVE pulse, from 0 to 1\". At 1 every qualifying draw pulses; below that the rhythm thins out at random." },
    { key: "rate_2", label: "Rate 2", default: 0.05, ...FRACTION, help: "Section 2's sampling rate, same span. Two sections at incommensurate rates is the whole reason the 266 has two." },
    { key: "smooth_2", label: "Smooth 2", default: 1, min: 0, max: 10, step: LEVEL_STEP, unit: " s", help: "Section 2's smoothing time. The changelog says section 2 \"has a different smoothing function that can be controlled via CV\" — WHAT makes it different is not stated, so both sections use one lag here and that is a stated approximation, not a claim." },
    { key: "probability_2", label: "Prob 2", default: 1, ...FRACTION, help: "Section 2's pulse probability, as section 1's." },
    { key: "n_power", label: "2^n range", default: 3, min: 1, max: 6, step: 1, help: "N for the 2^n quantized section: it draws one of 2^N values in 1/12 V steps, so N=3 gives eight semitones and N=6 gives sixty-four. This is the output you patch to a pitch when you want random notes inside a fixed span." },
    { key: "n_plus", label: "n+1 range", default: 3, min: 1, max: 6, step: 1, help: "N for the n+1 section, whose values are whole VOLTS and whose distribution is TRIANGULAR — \"like throwing 2 dice\". So the middle of the range comes up far more often than the ends, which is what makes it sound like a decision rather than a coin flip." },
    { key: "skew", label: "Skew", default: 0, ...BIPOLAR, help: "Bends the stored-random section toward the low end (negative) or the high end (positive); 0 is uniform. The panel documents the effect — \"to have more events in LOW MID or HIGH ranges\" — and not the curve, so the law is ours (kernels' G22)." },
    { ...SEED },
  ],
};

/**
 * EVERY VC-8 SPEC — filters, then modulation, then effects, then the mixer and
 * the sequencers. The same family-first ordering core/audio_specs.AUDIO_SPECS
 * follows, so the palette reads as one library.
 *
 * THE BARREL LINE THIS NEEDS: `core/audio_blocks.js`'s PORT_BLOCK_SPECS must
 * spread this array, and `plugins/audio_index.js`'s `audioPlugins` must spread
 * `plugins/audio_index_vc8.js`'s BLOCK_PLUGINS, or these modules exist in the
 * engine and nowhere the author can reach.
 *
 * TWO NODE_REGISTRY ROWS ARE DELIBERATELY ABSENT and the report names them:
 * `NYSTHI/Simpliciter` and `NYSTHI/complexSimpler` are WAV-file samplers with no
 * source, no published grain algorithm and no sample. A granulator that emitted
 * anything at all would be a fabrication wearing a famous name.
 */
export const BLOCK_SPECS = [
  VCV_B208_DUAL_LPG_SPEC, VCV_POLY_LPG_SPEC,
  VCV_ATTACK_DECAY_SPEC, VCV_B208_ENVELOPE_SPEC,
  VCV_QUAD_PANNER_SPEC, VCV_CLOCKABLE_DELAY_SPEC,
  VCV_NYSTHI_MIX4_SPEC, VCV_SURVEILLANCE_SPEC,
  VCV_SQUONK_SPEC, VCV_PROGRAMMER_SPEC, VCV_SOY_MODEL_SOU_SPEC,
];
