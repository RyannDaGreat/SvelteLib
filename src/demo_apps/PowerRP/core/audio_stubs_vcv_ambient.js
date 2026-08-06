/**
 * PLACEHOLDER NODES for VCV Rack — the ambient/granular core.
 *
 * The companion to `core/audio_patches_vcv_ambient.js`: every node those patches name that
 * the library does not yet implement. **Read `core/audio_stub_nodes.js`'s header before
 * adding a row** — it defines the declaration shape, why a placeholder carries the FINAL
 * type and port names, and the three ways a placeholder is made LOUD.
 *
 * OVERLAP WITH OTHER SETS IS EXPECTED AND IS A FEATURE. A module used by eight patches is
 * declared by every set that needs it, and `stubRegistry` THROWS if two declarations of
 * one type disagree about its ports — so two agents reading the same C++ port enum are
 * checked against each other. Do not "helpfully" omit a row because you think another set
 * already has it; that removes the check.
 *
 * DELETE A ROW THE DAY ITS REAL NODE LANDS. `tests/audio_stub_test.js` fails if a type is
 * both a placeholder and a real spec.
 *
 * ── HOW A PORT KEY IS SPELLED HERE, AND THE THREE CASES ──────────────────────
 * Every key below was read off the module's own source or off the harvested patch file,
 * never invented. Three cases arise, and which one a row is in is stated on the row:
 *
 *   1. SOURCE INDEXED — the key is the C++ `enum InputIds`/`OutputIds` symbol, lowercased,
 *      non-alphanumerics to `_`, and the `_INPUT`/`_OUTPUT` suffix dropped (`IN_L_INPUT` →
 *      `in_l`, the spelling `core/audio_stub_nodes.js`'s own example uses). Same rule for a
 *      knob: the `ParamIds` symbol minus `_PARAM` (`DEJA_VU_PARAM` → `deja_vu`).
 *   2. AN `ENUMS(X, N)` BANK — Rack's macro, which no port-name index expands. It becomes
 *      `x_1 … x_N`, panel-numbered, so Clkd's four clock jacks are `clk_1 … clk_4`. THIS
 *      MATTERS BEYOND SPELLING: an unexpanded bank makes every LATER index in the enum
 *      report the wrong name, which is a real defect in the survey (see the header of the
 *      patch file for the two places it bit).
 *   3. SOURCE NOT AVAILABLE (closed-source Vult, un-cloned plugins) — the key is the raw
 *      port INDEX as the patch file states it: `i5`, `o0`, `p3`. That is DATA. A friendly
 *      name would be a guess wearing the costume of data, and the port block that ports the
 *      module will have the header in front of it and can rename in one place. For these
 *      modules the row declares ONLY the ports the patch actually uses — the full port
 *      count is not knowable from a patch file, and declaring a padded list would state
 *      something we do not know. THEIR KNOB VALUES ARE UNCONVERTED for the same reason: a
 *      `p3` whose quantity is unknown has no known unit, so R7-UNITS cannot be applied to
 *      it and pretending otherwise would be worse than the raw float. The owing block
 *      converts them when it learns what they are.
 *
 * ── PORT TYPES: A JACK'S TYPE IS WHAT IT CARRIES, NOT WHAT RACK STORES ──────
 * In Rack every cable carries the same thing — volts — and whether a destination reads them
 * as a pitch, a gate or a waveform is the destination's business. Our type system is finer,
 * so each jack is declared as the quantity it really is: `audio` for a signal to be
 * processed or produced, `number` for a CV/modulation jack, `trigger` for a gate, clock,
 * strum or reset. THAT CHOICE IS SAFE IN ONE DIRECTION ONLY, and the direction is why it is
 * the right one: `core/nodeflow.js` COERCIONS carry trigger → number and trigger → audio,
 * and number → trigger, but NOT audio → trigger. So a gate declared `trigger` can drive
 * anything downstream — including our own `audio_adsr.gate`, with no edge detector spliced
 * in — while a gate declared `audio` could not have driven it at all.
 *
 * ── THE KNOB VALUES ARE CONVERTED, NOT COPIED (R7-UNITS) ────────────────────
 * A `.vcv` stores Rack volts and Rack param units; the ruling fixes ours. So: a VOLTAGE is
 * divided by 5 (±5 V = ±1), a V/oct quantity is ×12 into SEMITONES, a log2-hertz knob is
 * raised to a real HERTZ, and a gate is 0..1. Values already normalised in the C++ — every
 * Mutable 0..1 param, Marbles' ±1 rates, an attenuverter's gain — cross unchanged, and so
 * does a param whose own unit IS the real one (Rings' 0..60 semitones, Clkd's BPM,
 * Reftone's note and octave). Each row states which case it is where it is not obvious.
 * A raw voltage left on a knob would land SILENTLY and be wrong only when the real node
 * arrives, which is precisely the failure this scaffold exists to prevent.
 *
 * ── A VALUE OUTSIDE THE ±10 RAIL RIDES THE DECLARATION, NOT THE BLUEPRINT ────
 * `STUB_RANGES.vcv` is the ±10 V cable rail, and several harvested params are not volts at
 * all: Rings' frequency is 0..60 semitones, Tides2' is ±48, Clkd's tempo is 96 BPM.
 * `tests/audio_patches_test.js` range-checks a blueprint OVERRIDE, and nothing sweeps a
 * stub's DECLARED DEFAULT (`tests/audio_nodes_test.js`'s default-in-range check reads
 * `AUDIO_SPECS`, which by law 1 of the stub test never contains a placeholder) — so such a
 * value is carried HERE and deliberately NOT restated as an override. That keeps the datum
 * on the node instead of only in prose. It is a knowingly temporary state: the real node
 * declares the real range and the value becomes ordinary.
 */

/** This set's placeholder declarations. Empty means every node its patches want exists. */
export const BLOCK_STUBS = [
  // ── VC-1 — WHAT IS LEFT AFTER THE BLOCK LANDED ──────────────────────────────
  // Marbles, Rings, Clouds, Branches, Shades and Supercell were declared here and are now
  // DELETED: VC-1 shipped them mid-session (commit e0d28131) and a type may not be both a
  // placeholder and a spec. THE SWAP WAS NOT FREE, and that is the finding worth keeping:
  // these rows carried the C++ ENUM's names, VC-1's carry the BLOCK AGENT's, and the two
  // diverged — `left`/`right` vs `in_l`/`in_r`, snake_case knobs vs camelCase (`dejaVu`,
  // `inGain`, `positionTrim`), `polyphony: 1` vs the string option `"1"`, and Feline's two
  // five-jack CV buses collapsed into five parameter inputs. Nine patch-test reds came out of
  // it. So: WHERE A REAL SPEC EXISTS, READ `core/audio_specs.js`, NOT THE SURVEY — and expect
  // a placeholder's port names to be a good guess rather than an authority.
  // Plaits, Elements and Tides2 are still owed; their rows stay.
  {
    type: "audio_vcv_plaits", title: "VCV Plaits", family: "source",
    source: "AudibleInstruments/Plaits", block: "VC-1", corpus: "vcv",
    inputs: [["engine", "number"], ["timbre", "number"], ["freq", "number"], ["morph", "number"],
      ["harmonics", "number"], ["trigger", "trigger"], ["level", "number"], ["note", "number"]],
    outputs: [["out", "audio"], ["aux", "audio"]],
    knobs: [["harmonics", 0.4398], ["timbre", 0.5374], ["morph", 0.6458], ["timbre_cv", 0.5307],
      ["morph_cv", -0.248], ["lpg_color", 0.5], ["lpg_decay", 0.6241]],
  },
  {
    type: "audio_vcv_elements", title: "VCV Elements", family: "source",
    source: "AudibleInstruments/Elements", block: "VC-1", corpus: "vcv",
    inputs: [["note", "number"], ["fm", "number"], ["gate", "trigger"], ["strength", "number"],
      ["blow", "audio"], ["strike", "audio"], ["bow_timbre_mod", "number"], ["flow_mod", "number"],
      ["blow_timbre_mod", "number"], ["mallet_mod", "number"], ["strike_timbre_mod", "number"],
      ["damping_mod", "number"], ["geometry_mod", "number"], ["position_mod", "number"],
      ["brightness_mod", "number"], ["space_mod", "number"]],
    outputs: [["aux", "audio"], ["main", "audio"]],
    knobs: [["coarse", -1.8795], ["fine", -0.0241], ["flow", 0.5], ["mallet", 1], ["geometry", 0.2964],
      ["brightness", 0.2952], ["bow_timbre", 0.5133], ["blow_timbre", 0.5], ["strike_timbre", 0.5096],
      ["damping", 0.7795], ["position", 0.5627], ["space", 2]],
  },
  {
    // CASE 2 — `ENUMS(OUT_OUTPUTS, 4)`. The four jacks are one bank, so they are `out_1 …
    // out_4`; a port index resolver that stops at the macro reports index 0 as "ENUMS" and
    // has nothing at all for 1-3, which is exactly what the survey shows.
    type: "audio_vcv_tides2", title: "VCV Tides2", family: "modulation",
    source: "AudibleInstruments/Tides2", block: "VC-1", corpus: "vcv",
    inputs: [["slope", "number"], ["frequency", "number"], ["v_oct", "number"], ["smoothness", "number"],
      ["shape", "number"], ["shift", "number"], ["trig", "trigger"], ["clock", "trigger"]],
    outputs: [["out_1", "audio"], ["out_2", "audio"], ["out_3", "audio"], ["out_4", "audio"]],
    // `frequency` is SEMITONES in the C++ too (`configParam(FREQUENCY_PARAM, -48, 48, 0,
    // "Frequency", " semitones")`) and both instances sit near its floor, so it rides this
    // declaration for the reason Rings' does. The second instance's −42.3325 is unioned away
    // by stubRegistry's first-value rule; both are "as slow as the module goes".
    knobs: [["frequency", -48], ["shape", 0.5], ["smoothness", 0.6976], ["slope", 0.5],
      ["shift", 1], ["slope_cv", 0.3413]],
  },

  // ── VC-2 — Fundamental. Only the ones NODE_REGISTRY.md marks as still to write; the
  // rest (VCA, Noise, VCF, ADSR, Quantizer, LFO, AudioInterface) map onto ours and the
  // patches say so in `deviations`.
  {
    type: "audio_vcv_random", title: "VCV Random", family: "modulation",
    source: "Fundamental/Random", block: "VC-2", corpus: "vcv",
    inputs: [["rate", "number"], ["shape", "number"], ["trig", "trigger"], ["external", "audio"],
      ["prob", "number"], ["rand", "number"]],
    outputs: [["stepped", "audio"], ["linear", "audio"], ["smooth", "audio"],
      ["exponential", "audio"], ["trig", "trigger"]],
    // `rate` IS CONVERTED: Fundamental stores log2(Hz) (`configParam(RATE_PARAM,
    // log2(0.002), log2(2000), log2(2), "Internal trigger rate", " Hz", 2)`), so the
    // harvested 1.0 is 2 Hz — the real unit R7-UNITS clause 2 asks for. The other four are
    // 0..1 percentages and `offset` is a switch.
    knobs: [["rate", 2], ["shape", 1], ["offset", 1], ["prob", 1], ["rand", 1]],
  },

  // ── VC-3a — Bogaudio, part 1: NOTHING IS OWED HERE ANY MORE ─────────────────
  // `audio_vcv_bog_lfo` was declared here for one commit and is now DELETED, which is the
  // scheme working: VC-3a's real spec (`core/audio_specs_vc3a.js`) reached the registry
  // mid-session, `core/registry.register` refused the duplicate type by name, and the swap
  // cost exactly this deletion — P1's two LLFO nodes, their `sine` output and their
  // frequency/scale/offset knobs were already spelled the real module's way, so not one wire
  // or dial moved. That is what "a placeholder carries the FINAL port names" buys.

  // ── VC-5 — VALLEY LANDED MID-SESSION TOO, so nothing is owed here either ────
  // `audio_vcv_plateau`, `audio_vcv_feline` and `audio_vcv_chronoblob2` were declared here
  // and are now DELETED for the reason bog_lfo was. The swap was NOT free this time, and the
  // difference is worth recording: Plateau's real jacks are `in_l`/`in_r`/`out_l`/`out_r`
  // (not the enum's `left`/`right`) and its CV inputs carry no `_cv` suffix, Feline's two
  // five-jack CV BUSES became five direct parameter inputs, and Chronoblob2's indexed params
  // have no mapping onto its four named knobs at all. So each patch's wires and dials were
  // re-read against the real specs — see their `deviations`. The lesson for the next
  // placeholder: an ENUM-EXACT port list is not the same thing as the PORT BLOCK's list, and
  // where a block simplifies a jack bank the patch is what has to move.

  // ── VC-6 — Befaco ────────────────────────────────────────────────────────────
  {
    type: "audio_vcv_dualatenuverter", title: "VCV Dual Atenuverter", family: "modulation",
    source: "Befaco/DualAtenuverter", block: "VC-6", corpus: "vcv",
    inputs: [["in1", "number"], ["in2", "number"]],
    outputs: [["out1", "audio"], ["out2", "audio"]],
    // THE OFFSET KNOBS ARE VOLTS and are therefore the one place in this file R7-UNITS
    // clause 1 bites: `configParam(OFFSET1_PARAM, -10, 10, 0, "Ch 1 offset", " V")`, so the
    // harvested 0.1205 V is 0.0241 of our ±1. The gains are already ±1 attenuverter amounts.
    // P3's other three instances offset by −2.5783 V and −1.7831 V (→ −0.5157, −0.3566);
    // those ride their blueprint nodes.
    knobs: [["aten1", 0.2361], ["offset1", 0.0241], ["aten2", 0.159], ["offset2", 0]],
  },

  // ── VC-7a / VC-7b — clocking, sequencing and utility plumbing ────────────────
  {
    // CASE 2 AGAIN, AND THIS ONE CHANGES THE MUSIC. Clkd's outputs are
    // `ENUMS(CLK_OUTPUTS, 4), RESET_OUTPUT, RUN_OUTPUT, BPM_OUTPUT` — so index 1 is the
    // SECOND CLOCK, not "Reset" as an unexpanded reading reports, and every index up to 6
    // is shifted by three. Read the wrong way, P3's tutorial patch appears to drive
    // Marbles' clock, two Clouds' triggers and a gate sequencer from a RESET pulse, which
    // is nonsense; read correctly it is a clock tree, which is what the module is for.
    type: "audio_vcv_clkd", title: "VCV Clkd", family: "modulation",
    source: "ImpromptuModular/Clocked-Clkd", block: "VC-7a", corpus: "vcv",
    inputs: [["reset", "trigger"], ["run", "trigger"], ["bpm", "number"]],
    outputs: [["clk_1", "trigger"], ["clk_2", "trigger"], ["clk_3", "trigger"], ["clk_4", "trigger"],
      ["reset", "trigger"], ["run", "trigger"], ["bpm", "audio"]],
    // THE SAME SHIFT MOVES THE KNOBS, and reading them correctly is what turns a nonsense
    // number into a tempo. ParamIds are `ENUMS(RATIO_PARAMS, 3), BPM_PARAM, …`, so the
    // harvested list — reported as "ENUMS=5, Master clock=−9, Reset=−5, Run=96" — is really
    // ratio_1=5, ratio_2=−9, ratio_3=−5 and BPM=96. 96 BPM is a plausible tempo for a
    // generative tutorial patch; a −9 "Master clock" was not. BPM is already the real unit
    // (`configParam<BpmParam>(BPM_PARAM, bpmMin, bpmMax, 120, "Master clock", " BPM")`) and
    // rides this declaration because it leaves the ±10 rail.
    knobs: [["bpm", 96], ["ratio_1", 5], ["ratio_2", -9], ["ratio_3", -5]],
  },
  {
    // CASE 3 — CountModula is not cloned. o8 and o10-o12 are the gate outputs the patch
    // uses, i1/i2 its clock and run inputs.
    type: "audio_vcv_gatesequencer8", title: "VCV Gate Sequencer 8", family: "modulation",
    source: "CountModula/GateSequencer8", block: "VC-7a", corpus: "vcv",
    inputs: [["i1", "trigger"], ["i2", "trigger"]],
    outputs: [["o8", "trigger"], ["o10", "trigger"], ["o11", "trigger"], ["o12", "trigger"]],
    knobs: [["p0", 1], ["p3", 1], ["p12", 1], ["p16", 1], ["p64", 8]],
  },
  {
    // CASE 3 — JW-Modules IS cloned and its enum is `VOLT_INPUT, NUM_INPUTS = VOLT_INPUT +
    // 16`: sixteen identical shifter channels, so the keys are `volt_1 … volt_16` and the
    // six the drone patch uses are declared. The module adds 5 V to whatever it is given.
    type: "audio_vcv_add5", title: "VCV Add5", family: "modulation",
    source: "JW-Modules/Add5", block: "VC-7b", corpus: "vcv",
    inputs: [["volt_1", "number"], ["volt_2", "number"], ["volt_3", "number"],
      ["volt_4", "number"], ["volt_5", "number"], ["volt_6", "number"]],
    outputs: [["volt_1", "audio"], ["volt_2", "audio"], ["volt_3", "audio"],
      ["volt_4", "audio"], ["volt_5", "audio"], ["volt_6", "audio"]],
    knobs: [],
  },

  // ── VC-8 — NYSTHI ────────────────────────────────────────────────────────────
  {
    // CASE 3. The drone patch plays a WAV file through this ("Birds and Cars.wav", which we
    // do not have) — so even ported it will need an asset, and that is exactly why it is a
    // placeholder rather than our Sampler: a sampler with no buffer is silent and looks
    // finished, which is the failure the whole placeholder scheme exists to make loud.
    type: "audio_vcv_complexsimpler", title: "VCV Complex Simpler", family: "source",
    source: "NYSTHI/complexSimpler", block: "VC-8", corpus: "vcv",
    inputs: [],
    outputs: [["o0", "audio"], ["o1", "audio"]],
    knobs: [["p0", -1], ["p4", 1], ["p7", 1], ["p11", 1], ["p12", 2], ["p13", -2]],
  },

  // ── VC-10 — Vult + squinkylabs. Vult is CLOSED SOURCE (Vult DSP compiles to C++ from a
  // private .vult), so case 3 is not laziness here: the indices are all that exist.
  {
    type: "audio_vcv_vessek", title: "VCV Vessek", family: "source",
    source: "VultModulesFree/Vessek", block: "VC-10", corpus: "vcv",
    inputs: [["i0", "number"], ["i3", "number"], ["i4", "number"], ["i5", "number"],
      ["i6", "number"], ["i7", "number"], ["i8", "number"]],
    outputs: [["o0", "audio"]],
    knobs: [["p1", -0.0092], ["p4", 2], ["p6", 0.0135], ["p7", 0.225], ["p10", 0.5],
      ["p21", 0.462], ["p22", 1], ["p23", 0.669], ["p24", 0.79], ["p25", 0.639], ["p26", -0.774]],
  },
  {
    type: "audio_vcv_caudal", title: "VCV Caudal", family: "modulation",
    source: "VultModulesFree/Caudal", block: "VC-10", corpus: "vcv",
    inputs: [],
    outputs: [["o0", "audio"], ["o1", "audio"], ["o2", "audio"], ["o3", "audio"],
      ["o4", "audio"], ["o6", "audio"], ["o7", "audio"], ["o9", "audio"], ["o10", "audio"]],
    knobs: [["p0", -0.327]],
  },
  {
    type: "audio_vcv_tangents", title: "VCV Tangents", family: "filter",
    source: "VultModulesFree/Tangents", block: "VC-10", corpus: "vcv",
    inputs: [["i1", "audio"], ["i3", "number"]],
    outputs: [["o0", "audio"]],
    knobs: [["p0", 0.5], ["p1", 0.3495], ["p2", 0.618], ["p4", 0.6]],
  },
  {
    // CASE 3 — SquinkyVCV is cloned but its Super module's ports live in a composite
    // template (`composites/Super.h`) rather than in a flat enum an index walk can read,
    // so the harvested indices stand. o0/o1 are its stereo pair.
    type: "audio_vcv_super", title: "VCV Super", family: "source",
    source: "squinkylabs-plug1/squinkylabs-super", block: "VC-10", corpus: "vcv",
    inputs: [],
    outputs: [["o0", "audio"], ["o1", "audio"]],
    knobs: [["p0", -3], ["p1", -3], ["p3", 1.26], ["p5", 5]],
  },

  // ── VC-3b — Bogaudio, part 2 ─────────────────────────────────────────────────
  {
    type: "audio_vcv_peq6", title: "Bogaudio PEQ6", family: "filter",
    source: "Bogaudio/Bogaudio-PEQ6", block: "VC-3b", corpus: "vcv",
    inputs: [["frequency_cv", "number"], ["bandwidth", "number"], ["in", "audio"],
      ["level1", "number"], ["frequency_cv1", "number"], ["level2", "number"],
      ["frequency_cv2", "number"], ["level3", "number"], ["frequency_cv3", "number"],
      ["level4", "number"], ["frequency_cv4", "number"], ["level5", "number"],
      ["frequency_cv5", "number"], ["level6", "number"], ["frequency_cv6", "number"]],
    outputs: [["out", "audio"], ["out1", "audio"], ["out2", "audio"], ["out3", "audio"],
      ["out4", "audio"], ["out5", "audio"], ["out6", "audio"]],
    knobs: [["bandwidth", 0.33], ["lp", 1], ["hp", 1],
      ["level1", 0.9091], ["frequency1", 0.0707], ["frequency_cv1", 1],
      ["level2", 0.9091], ["frequency2", 0.0935], ["frequency_cv2", 1],
      ["level3", 0.9091], ["frequency3", 0.1323], ["frequency_cv3", 1],
      ["level4", 0.9091], ["frequency4", 0.1871], ["frequency_cv4", 1],
      ["level5", 0.9091], ["frequency5", 0.2646], ["frequency_cv5", 1],
      ["level6", 0.9091], ["frequency6", 0.3536], ["frequency_cv6", 1]],
  },
  {
    type: "audio_vcv_reftone", title: "Bogaudio Reftone", family: "source",
    source: "Bogaudio/Bogaudio-Reftone", block: "VC-3b", corpus: "vcv",
    inputs: [],
    outputs: [["cv", "audio"], ["out", "audio"]],
    knobs: [["pitch", 9], ["octave", 4], ["fine", 0]],
  },

  // ── VC-12b — the single-use long tail ────────────────────────────────────────
  {
    // CASE 3 — OrangeLine is not cloned. Fence quantises and range-clamps a CV; the granular
    // patch sends Marbles' X2 through it into Rings' pitch, which is the ONE thing that
    // makes that patch play in a key.
    type: "audio_vcv_fence", title: "VCV Fence", family: "modulation",
    source: "OrangeLine/Fence", block: "VC-12b", corpus: "vcv",
    inputs: [["i4", "number"]],
    outputs: [["o1", "audio"]],
    knobs: [["p0", 0.0001], ["p1", 1.5662], ["p3", 1], ["p4", 1]],
  },
  {
    // CASE 3 — voxglitch is not cloned.
    type: "audio_vcv_digitalsequencer", title: "VCV Digital Sequencer", family: "modulation",
    source: "voxglitch/digitalsequencer", block: "VC-12b", corpus: "vcv",
    inputs: [["i1", "trigger"]],
    outputs: [["o2", "audio"], ["o3", "audio"], ["o4", "audio"]],
    // p1-p6 are its six lanes, each set to 32 steps. A step COUNT is already a real unit and
    // 32 leaves the ±10 rail, so the six ride this declaration (see the header).
    knobs: [["p1", 32], ["p2", 32], ["p3", 32], ["p4", 32], ["p5", 32], ["p6", 32]],
  },
  {
    // CASE 3 — VCV-Drums is not cloned. i0/i20/i30 are the trigger inputs the tutorial
    // patch plays and i34 a CV; o0/o1 its stereo mix.
    type: "audio_vcv_drummachine", title: "VCV Drum Machine", family: "source",
    source: "VCV-Drums/DrumMachine", block: "VC-12b", corpus: "vcv",
    inputs: [["i0", "trigger"], ["i20", "trigger"], ["i30", "trigger"], ["i34", "number"]],
    outputs: [["o0", "audio"], ["o1", "audio"]],
    knobs: [["p0", 0.5], ["p9", 0.76], ["p10", 0.1267], ["p48", 0.3347], ["p49", 0.512],
      ["p56", 0.5733]],
  },
];
