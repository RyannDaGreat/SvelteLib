/**
 * PLACEHOLDER NODES for VCV Rack — the effect chains.
 *
 * The companion to `core/audio_patches_vcv_fx.js`: every node those patches name that
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
 * ── WHERE THESE PORT NAMES COME FROM, AND THE THREE TIERS OF CONFIDENCE ─────
 * The convention is `enum InputIds`/`OutputIds`, lowercased. That is available for MOST of
 * this set and was read at `/tmp/r7_sources/` (the Phase-1 clones) plus three repos cloned
 * for this file: `dbgrande/GrandeModular`, `david-c14/SubmarineFree`, `zezic/ZZC`. But two
 * of the plugins these two patches lean hardest on **have no public source at all**, and
 * that is a fact about the corpus rather than a gap in the survey:
 *
 *   TIER 1 — ENUM-DERIVED (exact). JustAPhaser, Plateau, f2, freqshifter, Merge, Split,
 *     Octave, every Bogaudio module, DualAtenuverter, SimpleClock, MixMaster, AuxExpander,
 *     MergeSplit4, OG-104, ZZC Clock/Div/SH-8. Port keys are the enum, verbatim.
 *   TIER 2 — DOC-DERIVED (function names, index CHECKED against the patch file). Vult
 *     (Caudal, Bleak, Unstabile) — Vult ships closed builds, so the names come from the
 *     vendor manual at `modlfo.github.io/VultModules/<module>/`, and every cable in the
 *     real `.vcv` lands on a port the manual describes. Caudal's twelve outputs are
 *     4 pendulum segments x (X, Y, A), which is what makes `o0..o11` read as three-strided
 *     groups in the patch — the cables prove the layout the manual only implies.
 *   TIER 3 — BEHAVIOUR-DERIVED (function names, index UNVERIFIABLE). Every NYSTHI module.
 *     **NYSTHI SHIPS NO SOURCE, AT ANY REF, AND THAT WAS MEASURED RATHER THAN ASSUMED**
 *     (2026-08-06, because a lead brief said the opposite and it is worth settling once):
 *     `github.com/nysthi/nysthi` master is `f895816` and `git ls-tree` on it returns
 *     `.gitignore CHANGELOG.md README.md changelog1.0.1_parsed.md images` — no `src/`.
 *     Nor at any tag: v2.1.18, v2.0.6, v0.4.12 and v0 were fetched individually and every
 *     one has the same five entries. There is no fork carrying it either (GitHub search
 *     returns the manual project and three theme repos). The plugin is distributed as
 *     prebuilt binaries, which is exactly why survey_vcv.md prints `i<N>`/`o<N>` for all
 *     of them. So `Simpliciter.cpp` cannot be read to settle a port order — the question
 *     has no C++ answer.
 *     The one real reference is that repo's CHANGELOG, which documents SQUONK,
 *     SoyModelSOU, ClockableDelay and Surveillance CONTROL BY CONTROL. That gives the
 *     NAMES (SQUONK's "OUTS A B C D E", its CLK IN/OUT and SEL CV; Simpliciter's SPEED
 *     input, START-that-doubles-as-STOP and RAMP OUT) but never the ORDER, so every row
 *     below records the raw index each of its wires was read at. **This is the same tier
 *     `synth/vc5_kernels.js` puts Chronoblob2 in, and for the same reason** — see its
 *     "THIS PORT IS BEHAVIOUR-DERIVED, NOT SOURCE-DERIVED" header, whose port vocabulary
 *     this file adopts rather than inventing a second one.
 *
 * ── A PORT SURFACE IS FOCUSED, AND THAT IS SAFE IN ONE DIRECTION ONLY ───────
 * Where a module has a very wide surface that the patch does not touch (MixMaster's 16
 * per-track volume CVs and its inserts, PEQ6's six per-band level CVs), the row declares
 * the ports the patch WIRES plus the module's principal ones, not every jack. That is safe
 * because the real node ADDING a port breaks nothing, whereas misNAMING or renaming a
 * wired one breaks a wire silently — so the effort went into the ports that carry cables.
 * MixMaster's 32 track signal inputs are declared in full anyway: the patch reaches track
 * 16, so a truncated list would have had to renumber.
 *
 * ── WHY SO MANY KNOB LISTS ARE EMPTY, STATED RATHER THAN LEFT TO LOOK LAZY ──
 * `core/audio_stub_nodes.js` is emphatic that harvested dial values are real data. They
 * are carried wherever a value can be ASSIGNED TO A NAME, which needs the `enum ParamIds`.
 * For the NYSTHI modules there is none, and their param vectors are enormous and
 * positional — SQUONK alone stores 117 (its 12 stages x 11 programming lines, per the
 * CHANGELOG). Writing `p47 = 0.5922` onto a knob called `p47` would be a fabricated name
 * carrying a real number, which is worse than no knob: it looks transferred. So those rows
 * declare the knobs whose meaning IS known (ClockableDelay's, which are in its `data{}`
 * as seconds and fractions, not as normalised params) and nothing else. The blueprint's
 * `deviations` names each one.
 *
 * ── EVERY KNOB VALUE HERE IS CONVERTED, NOT COPIED (R7-UNITS) ────────────────
 * A `.vcv` param is stored in whatever domain the module's `configParam` declares, so the
 * conversion is decided PER PARAM by reading that call — not by a blanket rule over the
 * file. Three cases arise, and each value below is one of them:
 *
 *   VOLT-DOMAIN -> DIVIDED BY 5. A param whose range exists so a CV input can sum into it
 *     1:1 (`{0, 10, 5, "Cutoff freq (Fc)"}` on F2; Plateau's four 0..10 damp controls and
 *     its 0..10 diffusion). F2's harvested `fc` of 7.3855 V is written `1.4771`.
 *   ALREADY THE REAL UNIT -> VERBATIM. A normalised fraction (a depth, a mix, a fader, a
 *     pan, a feedback amount — every one declared `0..1` and displayed as a percent), a
 *     phase expressed as a fraction of a cycle (the spelling `core/ramps.js` already uses,
 *     where phase = 1 is identity), or an absolute time in seconds.
 *   REAL UNIT OUTSIDE THE PLACEHOLDER'S RAIL -> NOT CARRIED, and named in the blueprint's
 *     `deviations`. This is a COLLISION between two rules, not a judgement call, and it is
 *     worth stating because it costs real data: `STUB_RANGES.vcv` gives every placeholder
 *     knob `[-10, 10]`, while R7-UNITS clause 2 asks for hertz, seconds and BPM. So
 *     JustAPhaser's centre frequency (`2^8` = 256 Hz), SimpleClock's tempo
 *     (`60 * 2^-0.6453` = 38.4 BPM) and Plateau's pre-delay in milliseconds have nowhere
 *     to land. Its `frequency` knob is carried because `2^0` = 1 Hz happens to fit — which
 *     shows the rail, not the unit, is what decides. The five SimpleClocks are the visible
 *     casualty: their five DIFFERENT tempos are what keep the five micro-loopers
 *     incommensurate, and all five arrive identical.
 */

/** This set's placeholder declarations. Empty means every node its patches want exists. */
export const BLOCK_STUBS = [

  // ── VC-8 — NYSTHI (Buchla-lineage) — ALL TIER 3, no public source ─────────
  {
    // TIER 3. The CHANGELOG (v0.5.4, "THE SQUONK") documents it exactly: a Serge-TKB
    // PROGRAMMER / stage sequencer, 12 steps x 11 lines, with "OUTS A B C D E are the CV
    // outs", a global TRIG, a LAST pulse, CLK IN/OUT, SEL knob + SEL CV, and
    // START/STOP/RESET. Read at index: the patch's clock lands on `i1` -> `clock`, and
    // `o5` -> `trig` (the first output after the five CV channels), which is the wire
    // that makes a SQUONK a micro-looper controller rather than a melody source.
    type: "audio_vcv_squonk",
    title: "VCV SQUONK", family: "modulation",
    source: "NYSTHI/SQUONK", block: "VC-8", corpus: "vcv",
    inputs: [
      ["sel", "number"], ["clock", "trigger"], ["start", "trigger"], ["stop", "trigger"],
      ["reset", "trigger"], ["rnd", "trigger"], ["chain_trig", "trigger"],
    ],
    outputs: [
      ["a", "number"], ["b", "number"], ["c", "number"], ["d", "number"], ["e", "number"],
      ["trig", "trigger"], ["last", "trigger"], ["clock_out", "trigger"],
    ],
    knobs: [],
  },
  {
    // TIER 3. The VCV Library calls it a "sample oscillator also known as
    // confusingSimpler"; the CHANGELOG establishes the stereo recording inputs, the RAMP
    // OUT (playhead position), the START control that doubles as STOP when negative, and
    // the SPEED input the tape expander drives. Read at index: `i0`/`i1` are the record
    // inputs, `i2` takes the SQUONK's stage trigger, `i9` takes the split poly CV.
    type: "audio_vcv_simpliciter",
    title: "VCV Simpliciter", family: "source",
    source: "NYSTHI/Simpliciter", block: "VC-8", corpus: "vcv",
    inputs: [
      ["in_l", "audio"], ["in_r", "audio"], ["trig", "trigger"], ["start", "number"],
      ["length", "number"], ["pitch", "number"], ["slice", "number"],
      ["gate", "trigger"], ["reset", "trigger"], ["speed", "number"],
    ],
    outputs: [["out_l", "audio"], ["out_r", "audio"], ["ramp", "number"], ["eoc", "trigger"]],
    knobs: [],
  },
  {
    // TIER 3, but the best-documented of them: the CHANGELOG (v0.6.16) describes it
    // control by control — a DLD-inspired stereo delay with IN L/R, FEEDIN, FEEDBACK,
    // TIME (all CV + VCA), TAP/TRIG TIME, HOLD, REVERSE, a PULSE out, and "8 point of
    // SEND RETURN, before FEEDBACK and before DRYWET".
    // ⚠ THE OUTPUT ORDER IS DECIDED BY THE CABLE, NOT THE PROSE. The patch takes its
    // audio from `o8`, so there are at least nine outputs; eight sends before the two
    // mains is the only reading that puts an audio out at 8. Evidence over prose.
    // ITS KNOBS ARE REAL, uniquely among the NYSTHI rows, because they are stored in
    // `data{}` in ABSOLUTE units rather than as normalised params:
    // `m_delay_time: 8.4788` seconds, `m_feedback: 0.5945`, `m_feed_in: 1.0`.
    type: "audio_vcv_clockabledelay",
    title: "VCV ClockableDelay", family: "effect",
    source: "NYSTHI/ClockableDelay", block: "VC-8", corpus: "vcv",
    inputs: [
      ["in_l", "audio"], ["in_r", "audio"],
      ["return_fb_l", "audio"], ["return_fb_r", "audio"],
      ["return_dw_l", "audio"], ["return_dw_r", "audio"],
      ["feed_in", "number"], ["feedback", "number"], ["time", "number"],
      ["tap", "trigger"], ["trig_time", "trigger"], ["hold", "trigger"], ["reverse", "trigger"],
    ],
    outputs: [
      ["send_fb_l", "audio"], ["send_fb_r", "audio"], ["send_dw_l", "audio"], ["send_dw_r", "audio"],
      ["send_rev_l", "audio"], ["send_rev_r", "audio"], ["send_hold_l", "audio"], ["send_hold_r", "audio"],
      ["out_l", "audio"], ["out_r", "audio"], ["pulse", "trigger"],
    ],
    knobs: [["time", 8.4788], ["feedback", 0.5945], ["feed_in", 1], ["mult", 1]],
  },

  // ── VC-10 — Vult + Instruo + squinkylabs ─────────────────────────────────
  {
    // TIER 1. SquinkyVCV composites/F2_Poly.h — the state-variable filter this patch
    // uses nine of. Its param indices in the `.vcv` (p1, p3, p6, p8, p12) match
    // F2_Poly's thirteen-param enum, not F2.h's six, which is how we know which
    // composite the `squinkylabs-f2` model is built on.
    type: "audio_vcv_f2",
    title: "VCV F2", family: "filter",
    source: "squinkylabs-plug1/squinkylabs-f2", block: "VC-10", corpus: "vcv",
    inputs: [["audio", "audio"], ["fc", "number"], ["q", "number"], ["r", "number"]],
    outputs: [["audio", "audio"]],
    // fc, r and q are all `{0, 10, …}` VOLT-domain (the code does
    // `freqVolts += inputs[FC_INPUT].getVoltage(0)`), so every harvested value is /5:
    // fc 7.3855 V -> 1.4771, q 2.0 V -> 0.4. `limiter` is a 0..1 switch, not a voltage.
    knobs: [["topology", 0], ["fc", 1.4771], ["r", 0], ["q", 0.4], ["mode", 0], ["limiter", 1]],
  },
  {
    // TIER 2. Vult's manual: a four-segment pendulum simulation, "For every segment of
    // the pendula there are the following 3 outputs" — X (horizontal position), Y
    // (vertical), A (angle), each normalised to +/-5 V. Four segments x three is twelve,
    // and the patch's use of `o0..o11` in three-strided groups (x1 y1 a1 | x2 y2 a2 | ...)
    // is what confirms the layout the manual leaves implicit.
    type: "audio_vcv_caudal",
    title: "VCV Caudal", family: "modulation",
    source: "VultModulesFree/Caudal", block: "VC-10", corpus: "vcv",
    inputs: [
      ["hit", "trigger"], ["rev", "trigger"], ["store", "trigger"], ["recall", "trigger"],
      ["sh_1", "number"], ["sh_2", "number"],
    ],
    outputs: [
      ["x_1", "number"], ["y_1", "number"], ["a_1", "number"],
      ["x_2", "number"], ["y_2", "number"], ["a_2", "number"],
      ["x_3", "number"], ["y_3", "number"], ["a_3", "number"],
      ["x_4", "number"], ["y_4", "number"], ["a_4", "number"],
    ],
    knobs: [["speed", 0], ["energy", 0]],
  },

  // ── VC-9 — VCV mixing / bussing / metering chain ─────────────────────────
  {
    // TIER 1. MindMeldModular/src/MixMaster/MixMaster.cpp, with N_TRK = 16 and
    // N_GRP = 4: `ENUMS(TRACK_SIGNAL_INPUTS, N_TRK * 2)` is L,R INTERLEAVED per track,
    // which the patch proves — its `i30`/`i31` are track 16's pair. Outputs are
    // `ENUMS(DIRECT_OUTPUTS, N_TRK / 8 + 1)` = three, THEN the main pair, which is why
    // the patch's main bus leaves at `o3`/`o4` rather than at 0.
    type: "audio_vcv_mixmaster",
    title: "VCV MixMaster", family: "modulation",
    source: "MindMeldModular/MixMaster", block: "VC-9", corpus: "vcv",
    inputs: [
      ["track_1_l", "audio"], ["track_1_r", "audio"], ["track_2_l", "audio"], ["track_2_r", "audio"],
      ["track_3_l", "audio"], ["track_3_r", "audio"], ["track_4_l", "audio"], ["track_4_r", "audio"],
      ["track_5_l", "audio"], ["track_5_r", "audio"], ["track_6_l", "audio"], ["track_6_r", "audio"],
      ["track_7_l", "audio"], ["track_7_r", "audio"], ["track_8_l", "audio"], ["track_8_r", "audio"],
      ["track_9_l", "audio"], ["track_9_r", "audio"], ["track_10_l", "audio"], ["track_10_r", "audio"],
      ["track_11_l", "audio"], ["track_11_r", "audio"], ["track_12_l", "audio"], ["track_12_r", "audio"],
      ["track_13_l", "audio"], ["track_13_r", "audio"], ["track_14_l", "audio"], ["track_14_r", "audio"],
      ["track_15_l", "audio"], ["track_15_r", "audio"], ["track_16_l", "audio"], ["track_16_r", "audio"],
      ["chain_l", "audio"], ["chain_r", "audio"],
    ],
    outputs: [
      ["direct_1", "audio"], ["direct_2", "audio"], ["direct_grp_aux", "audio"],
      ["main_l", "audio"], ["main_r", "audio"], ["fade_cv", "number"],
    ],
    knobs: [
      ["fader_1", 0.423], ["fader_2", 0.3776], ["fader_3", 0.4129], ["fader_4", 0.7077],
      ["fader_5", 0.7228], ["fader_6", 0.5767],
      ["pan_1", 0.2819], ["pan_2", 0.5], ["pan_3", 0.6627], ["pan_4", 0.2386],
      ["pan_5", 0.7602], ["pan_6", 0.7277],
      ["main_fader", 1],
    ],
  },
  {
    // TIER 1 for its jacks, and ONE DELIBERATE ADDITION that is a named deviation in the
    // blueprint: `bus_l`/`bus_r`. In Rack, AuxExpander gets the mix over the EXPANDER
    // BUS — a side-channel between adjacent modules, with NO cable. PowerRP has no such
    // concept and should not grow one for this, so the bus becomes two ordinary inputs.
    // Everything else is the enum: `ENUMS(SEND_OUTPUTS, 2 * 4)` is GROUPED (four lefts
    // then four rights, which the patch's o0/o4 pairing proves), while
    // `ENUMS(RETURN_INPUTS, 2 * 4)` is INTERLEAVED (its i0/i1, i2/i3, i4/i5, i6/i7
    // pairing proves that). The asymmetry is real; do not "tidy" it.
    type: "audio_vcv_auxexpander",
    title: "VCV AuxExpander", family: "effect",
    source: "MindMeldModular/AuxExpander", block: "VC-9", corpus: "vcv",
    inputs: [
      ["return_1_l", "audio"], ["return_1_r", "audio"], ["return_2_l", "audio"], ["return_2_r", "audio"],
      ["return_3_l", "audio"], ["return_3_r", "audio"], ["return_4_l", "audio"], ["return_4_r", "audio"],
      ["bus_l", "audio"], ["bus_r", "audio"],
    ],
    outputs: [
      ["send_1_l", "audio"], ["send_2_l", "audio"], ["send_3_l", "audio"], ["send_4_l", "audio"],
      ["send_1_r", "audio"], ["send_2_r", "audio"], ["send_3_r", "audio"], ["send_4_r", "audio"],
    ],
    knobs: [
      ["send_1_a", 0.4145], ["send_1_b", 0.5373], ["send_1_c", 1], ["send_1_d", 0.7072],
      ["send_16_a", 0.3349], ["send_16_b", 0.3687], ["send_16_c", 1], ["send_16_d", 0.6843],
      ["return_a", 1], ["return_b", 1], ["return_c", 1.0101], ["return_d", 1],
    ],
  },

  // ── VC-7b — VCV utility / clocking / sequencing plumbing ─────────────────
  {
    // TIER 1. JW-Modules/src/SimpleClock.cpp. It has NO inputs at all — the run and
    // reset controls are buttons — and six gate outputs: the clock plus four divisions
    // and a reset pulse. Five of these drive the five SQUONKs.
    type: "audio_vcv_simpleclock",
    title: "VCV SimpleClock", family: "modulation",
    source: "JW-Modules/SimpleClock", block: "VC-7b", corpus: "vcv",
    inputs: [],
    outputs: [
      ["clock", "trigger"], ["reset", "trigger"], ["div_4", "trigger"],
      ["div_8", "trigger"], ["div_16", "trigger"], ["div_32", "trigger"],
    ],
    // `prob` is a PROBABILITY: its param is `-2..6` and the harvested -2 is the bottom of
    // that range, i.e. zero chance of a random reset. The tempo knob is ABSENT — its real
    // unit is BPM (`60 * 2^v`), which does not fit the rail, and that is why all five of
    // this patch's clocks arrive identical instead of five tempos apart.
    knobs: [["prob", 0]],
  },

  // ── VC-2 — VCV Fundamental + Core ────────────────────────────────────────
  {
    // TIER 1. Fundamental/src/Merge.cpp — `ENUMS(MONO_INPUTS, 16)` then one POLY_OUTPUT.
    // ⚠ AND A SURVEY CORRECTION: survey_vcv.md prints this patch's cable as
    // `Caudal#2[o0] -> Merge#1[ENUMS]`. There is no port called ENUMS — that is the
    // macro leaking through the survey's name resolver, and the port is `mono_1`
    // (index 0). The same artifact appears on Split's `[ENUMS]`.
    type: "audio_vcv_merge",
    title: "VCV Merge", family: "modulation",
    source: "Fundamental/Merge", block: "VC-2", corpus: "vcv",
    inputs: [
      ["mono_1", "number"], ["mono_2", "number"], ["mono_3", "number"], ["mono_4", "number"],
      ["mono_5", "number"], ["mono_6", "number"], ["mono_7", "number"], ["mono_8", "number"],
      ["mono_9", "number"], ["mono_10", "number"], ["mono_11", "number"], ["mono_12", "number"],
      ["mono_13", "number"], ["mono_14", "number"], ["mono_15", "number"], ["mono_16", "number"],
    ],
    outputs: [["poly", "number"]],
    knobs: [],
  },
  {
    // TIER 1. Fundamental/src/Split.cpp — one POLY_INPUT, `ENUMS(MONO_OUTPUTS, 16)`.
    type: "audio_vcv_split",
    title: "VCV Split", family: "modulation",
    source: "Fundamental/Split", block: "VC-2", corpus: "vcv",
    inputs: [["poly", "number"]],
    outputs: [
      ["mono_1", "number"], ["mono_2", "number"], ["mono_3", "number"], ["mono_4", "number"],
      ["mono_5", "number"], ["mono_6", "number"], ["mono_7", "number"], ["mono_8", "number"],
      ["mono_9", "number"], ["mono_10", "number"], ["mono_11", "number"], ["mono_12", "number"],
      ["mono_13", "number"], ["mono_14", "number"], ["mono_15", "number"], ["mono_16", "number"],
    ],
    knobs: [],
  },
  // ── P22's PLACEHOLDERS ────────────────────────────────────────────────────
  // Everything from here down is named by "Ciani's Buchla, Performance Patch". The tier
  // split in the header applies: Bogaudio, Befaco, ZZC, SubmarineFree and GrandeModular
  // are ENUM-DERIVED; Vult is DOC-DERIVED; NYSTHI and MindMeld's ShapeMaster are
  // BEHAVIOUR-DERIVED, and where their index cannot be mapped the port key IS the index.

  // ── VC-3a / VC-3b — Bogaudio (all TIER 1, BogaudioModules/src/*.hpp) ─────
  {
    // The 8x8 mixing matrix at the heart of the instrument: three oscillators, the
    // frequency shifter and a noise source in, four destinations out, and 64 level knobs.
    // Only the seven NON-ZERO ones are carried — the other 57 are silent by design, and
    // writing 57 zeros would bury the seven that make the patch.
    type: "audio_vcv_matrix88",
    title: "VCV Matrix88", family: "modulation",
    source: "Bogaudio/Bogaudio-Matrix88", block: "VC-3b", corpus: "vcv",
    inputs: [["in1", "audio"], ["in2", "audio"], ["in3", "audio"], ["in4", "audio"],
             ["in5", "audio"], ["in6", "audio"], ["in7", "audio"], ["in8", "audio"]],
    outputs: [["out1", "audio"], ["out2", "audio"], ["out3", "audio"], ["out4", "audio"],
              ["out5", "audio"], ["out6", "audio"], ["out7", "audio"], ["out8", "audio"]],
    knobs: [["mix_1a", 0.982], ["mix_6a", 0.002], ["mix_2b", 1], ["mix_6b", 0.002],
            ["mix_4c", 1], ["mix_3d", 1], ["mix_6d", 0.002]],
  },
  {
    // Bogaudio's six noise colours out of one module. The patch takes WHITE into the
    // matrix — and Bogaudio's white is GAUSSIAN, which is why it has a separate `gauss`.
    type: "audio_vcv_bog_noise",
    title: "VCV Bogaudio Noise", family: "source",
    source: "Bogaudio/Bogaudio-Noise", block: "VC-3b", corpus: "vcv",
    // ⚠ THE `bog_` PREFIX IS THE COLLISION RULE, NOT A PREFERENCE, and it is a rule the
    // central list has an entry missing from: the convention names bog_lfo, bog_adsr,
    // bog_vca, bog_vcf and bog_vco as the known collisions, but `Fundamental/Noise` is on
    // VC-2's roster and `Bogaudio-Noise` is here, so NOISE collides too and needs the same
    // treatment. Reported to the lead rather than fixed silently.
    inputs: [["abs", "number"]],
    outputs: [["white", "audio"], ["pink", "audio"], ["red", "audio"],
              ["gauss", "audio"], ["abs", "audio"], ["blue", "audio"]],
    knobs: [],
  },
  {
    type: "audio_vcv_oneeight",
    title: "VCV OneEight", family: "modulation",
    source: "Bogaudio/Bogaudio-OneEight", block: "VC-3b", corpus: "vcv",
    // `clock` and `reset` are `number` for the reason spelled out on OG-104 below: a
    // Bogaudio rotary Schmitt-triggers a VOLTAGE, and P22 drives this one from a Switch18
    // signal tap rather than from anything edge-typed.
    inputs: [["clock", "number"], ["reset", "number"], ["select_cv", "number"], ["in", "audio"]],
    outputs: [["out1", "audio"], ["out2", "audio"], ["out3", "audio"], ["out4", "audio"],
              ["out5", "audio"], ["out6", "audio"], ["out7", "audio"], ["out8", "audio"]],
    knobs: [["steps", 3], ["direction", 1]],
  },
  {
    // Eight constant voltages on one POLY cable — the patch uses two of them, and this is
    // the module the polyphony family credit rests on. Its two harvested channels are
    // -1.0 V each, which is -12 SEMITONES under R7-UNITS clause 3: it is a V/oct constant,
    // and the whole point of a PolyCon is to state a pitch.
    type: "audio_vcv_polycon8",
    title: "VCV PolyCon8", family: "modulation",
    source: "Bogaudio/Bogaudio-PolyCon8", block: "VC-3b", corpus: "vcv",
    inputs: [],
    outputs: [["out", "number"]],
    knobs: [["channel_1", -12], ["channel_2", -12]],
  },
  {
    type: "audio_vcv_slew",
    title: "VCV Slew", family: "modulation",
    source: "Bogaudio/Bogaudio-Slew", block: "VC-3b", corpus: "vcv",
    inputs: [["rise", "number"], ["fall", "number"], ["in", "number"]],
    outputs: [["out", "number"]],
    knobs: [["rise", 1], ["fall", 1]],
  },
  {
    // Sum, difference, max, min and negate of two inputs, from one module. Three of them
    // add the sampled random voltage to the slewed sequencer pitch — the SUM output is
    // what tunes each oscillator, so this humble utility is the patch's pitch adder.
    type: "audio_vcv_sums",
    title: "VCV Sums", family: "modulation",
    source: "Bogaudio/Bogaudio-Sums", block: "VC-3b", corpus: "vcv",
    inputs: [["a", "number"], ["b", "number"], ["negate", "number"]],
    outputs: [["sum", "number"], ["difference", "number"], ["max", "number"],
              ["min", "number"], ["negate", "number"]],
    knobs: [],
  },
  {
    // One signal fanned to eight, each with its own level. The keyboard's GATE goes in and
    // three taps come out — this is what turns one key press into the patch's whole
    // trigger distribution.
    type: "audio_vcv_switch18",
    title: "VCV Switch18", family: "modulation",
    source: "Bogaudio/Bogaudio-Switch18", block: "VC-3b", corpus: "vcv",
    inputs: [["in", "audio"]],
    outputs: [["out1", "audio"], ["out2", "audio"], ["out3", "audio"], ["out4", "audio"],
              ["out5", "audio"], ["out6", "audio"], ["out7", "audio"], ["out8", "audio"]],
    knobs: [["mix1", 1]],
  },
  {
    // The stereo limiter that ends the patch, after the plate and before the interface.
    // Its threshold is the one dial it carries here.
    type: "audio_vcv_lmtr",
    title: "VCV Lmtr", family: "effect",
    source: "Bogaudio/Bogaudio-Lmtr", block: "VC-3a", corpus: "vcv",
    inputs: [["left", "audio"], ["right", "audio"], ["threshold", "number"], ["output_gain", "number"]],
    outputs: [["left", "audio"], ["right", "audio"]],
    knobs: [["threshold", 0.7783]],
  },

  // ── VC-6 / VC-7b / VC-12a — the enum-derived utilities ────────────────────
  {
    // TIER 1. ZZC/src/Clock.hpp. EVERY INDEX IN THIS PATCH CONFIRMS THE ENUM: the cable to
    // Div's phase input leaves `o1` (PHASE_OUTPUT), the one to its reset leaves `o7`
    // (RESET_OUTPUT), and the six cables that drive the sample-and-holds, ShapeMaster,
    // the Programmer and the Source of Uncertainty all leave `o3` — CLOCK_16THS_OUTPUT.
    // The whole patch runs on sixteenths from one clock.
    type: "audio_vcv_clock",
    title: "VCV ZZC Clock", family: "modulation",
    source: "ZZC/Clock", block: "VC-7b", corpus: "vcv",
    inputs: [["vbps", "number"], ["ext_run", "trigger"], ["ext_reset", "trigger"],
             ["clock", "trigger"], ["phase", "number"],
             ["swing_8ths", "number"], ["swing_16ths", "number"]],
    outputs: [["clock", "trigger"], ["phase", "number"], ["clock_8ths", "trigger"],
              ["clock_16ths", "trigger"], ["vbps", "number"], ["vspb", "number"],
              ["run", "trigger"], ["reset", "trigger"]],
    // The tempo is 147 BPM. It is NOT carried, for the reason the header gives: BPM does
    // not fit a placeholder's +/-10 rail. Swing is 50% on both, i.e. straight.
    knobs: [["swing_8ths", 0.5], ["swing_16ths", 0.5]],
  },
  {
    // TIER 1. ZZC/src/SH-8.cpp — one noise/signal input, eight independent triggers, eight
    // held outputs. Three are used, and this is what turns the keyboard's pitch into three
    // sampled voltages, one per oscillator.
    type: "audio_vcv_sh8",
    title: "VCV SH-8", family: "modulation",
    source: "ZZC/SH-8", block: "VC-7b", corpus: "vcv",
    inputs: [["noise", "number"], ["trig_1", "trigger"], ["trig_2", "trigger"],
             ["trig_3", "trigger"], ["trig_4", "trigger"], ["trig_5", "trigger"],
             ["trig_6", "trigger"], ["trig_7", "trigger"], ["trig_8", "trigger"]],
    outputs: [["hold_1", "number"], ["hold_2", "number"], ["hold_3", "number"],
              ["hold_4", "number"], ["hold_5", "number"], ["hold_6", "number"],
              ["hold_7", "number"], ["hold_8", "number"]],
    knobs: [],
  },
  {
    // TIER 1, and the module is FOUR OR GATES, which the source makes plain:
    // SubmarineFree/src/OG1.cpp is `template <int x> struct OG_1` with
    // `INPUT_A_1`, `INPUT_B_1 = x`, `OUTPUT_1`, and the process loop compares each input
    // against `midpoint()`. For OG-104, x = 4. So `i0..i3` are the A inputs and `i4..i7`
    // the B inputs — exactly the pattern the patch's cables show.
    type: "audio_vcv_og104",
    title: "VCV OG-104", family: "modulation",
    source: "SubmarineFree/OG-104", block: "VC-7b", corpus: "vcv",
    // ⚠ THE EIGHT INPUTS ARE `number`, NOT `trigger`, AND THE SOURCE SETTLES IT: the
    // process loop is `if (inputs[INPUT_A_1 + i].getVoltage() > midpoint())`. It reads a
    // LEVEL and compares it, which is what a `number` is here. `trigger` in this codebase
    // means a rising EDGE, and core/nodeflow.js deliberately has no audio -> trigger
    // coercion because that conversion is a real operation with a real parameter — so
    // typing these `trigger` would have made every gate cable in P22 refuse.
    inputs: [["input_a_1", "number"], ["input_a_2", "number"], ["input_a_3", "number"],
             ["input_a_4", "number"], ["input_b_1", "number"], ["input_b_2", "number"],
             ["input_b_3", "number"], ["input_b_4", "number"]],
    outputs: [["output_1", "trigger"], ["output_2", "trigger"],
              ["output_3", "trigger"], ["output_4", "trigger"]],
    knobs: [],
  },
  {
    // TIER 1. GrandeModular/src/MergeSplit4.cpp — `ENUMS(INPUTS_A, 4)` then `POLY_IN_B`,
    // and `POLY_OUT_A` then `ENUMS(OUTPUTS_B, 4)`. It is a merge and a split in ONE panel,
    // which is why the patch uses two of them as its whole polyphonic plumbing.
    // ⚠ NOT IN `.frenzy/round7/NODE_REGISTRY.md` AT ALL — no block owns it. Filed under
    // VC-12a (the single-use third-party long tail) so it is scheduled rather than lost.
    type: "audio_vcv_mergesplit4",
    title: "VCV MergeSplit4", family: "modulation",
    source: "GrandeModular/MergeSplit4", block: "VC-12a", corpus: "vcv",
    inputs: [["in_a_1", "number"], ["in_a_2", "number"], ["in_a_3", "number"],
             ["in_a_4", "number"], ["poly_in_b", "number"]],
    outputs: [["poly_out_a", "number"], ["out_b_1", "number"], ["out_b_2", "number"],
              ["out_b_3", "number"], ["out_b_4", "number"]],
    knobs: [],
  },

  // ── VC-10 — Vult (TIER 2: vendor manual, indices checked against the patch) ─
  {
    // Vult's manual: "a virtual analog oscillator with zero aliassing", knobs Tune, Oct,
    // PW and Wave (a continuous blend saw -> pulse -> triangle), one V/OCT in, one out.
    // Three of them are the instrument's voices. `i2` takes a CV, and WAVE is the only
    // continuous target the manual describes beyond pitch — a sequencer morphing the
    // waveform is a west-coast move, so that is where it goes; flagged in `deviations`.
    type: "audio_vcv_bleak",
    title: "VCV Bleak", family: "source",
    source: "VultModulesFree/Bleak", block: "VC-10", corpus: "vcv",
    inputs: [["v_oct", "number"], ["pw", "number"], ["wave", "number"]],
    outputs: [["out", "audio"]],
    knobs: [["tune", 0], ["oct", 0], ["pw", 0.5], ["wave", 0.514]],
  },
  {
    // Vult's manual: a "circuit bent" nonlinear filter that saturates hard and
    // self-oscillates — knobs Cutoff, Resonance, Semblance and Drive, ONE audio input plus
    // a cutoff CV, and FOUR outputs (LP, BP, HP and the Semblance-blended SEM). The patch
    // takes BP from both instances, with an envelope on each cutoff.
    type: "audio_vcv_unstabile",
    title: "VCV Unstabile", family: "filter",
    source: "VultModulesFree/Unstabile", block: "VC-10", corpus: "vcv",
    inputs: [["in", "audio"], ["cutoff", "number"]],
    outputs: [["lp", "audio"], ["bp", "audio"], ["hp", "audio"], ["sem", "audio"]],
    knobs: [["cutoff", 0.6209], ["resonance", 0.4422], ["semblance", 0.131], ["drive", 0.987]],
  },
  {
    // TIER 1 — SquinkyVCV composites/FrequencyShifter.h. A TRUE SINGLE-SIDEBAND shifter,
    // and the reason P22 is in the set at all: it moves every partial by the SAME NUMBER OF
    // HERTZ rather than by the same ratio, so the result is inharmonic. That is a different
    // algorithm from every other pitch module in R7-17-SEL, and its two outputs are the two
    // sidebands: `sin` is the up-shift and `cos` the down-shift.
    type: "audio_vcv_freqshifter",
    title: "VCV Frequency Shifter", family: "effect",
    source: "squinkylabs-plug1/squinkylabs-freqshifter", block: "VC-10", corpus: "vcv",
    inputs: [["audio", "audio"], ["cv", "number"], ["audio_r", "audio"]],
    outputs: [["sin", "audio"], ["cos", "audio"], ["sin_r", "audio"], ["cos_r", "audio"]],
    // The shift RANGE lives in `data{"range": 500}` — hertz, and 500 Hz does not fit the
    // rail, so it is not carried. `pitch` is the module's one param and sits at 0.
    knobs: [["pitch", 0]],
  },

  // ── VC-9 — MindMeld ShapeMaster ───────────────────────────────────────────
  {
    // BEHAVIOUR-DERIVED, and unusually so: MindMeldModular IS open source but this clone
    // (`/tmp/r7_sources/MindMeldModular`) ships `src/ShapeMaster/` WITHOUT the module
    // struct — `grep -rn "struct ShapeMaster"` finds nothing, only `modelShapeMaster`
    // declared `extern` in `MindMeldModular.hpp`. So the eight-channel CV shaper's jack
    // order is not readable here and EVERY PORT KEY IS ITS INDEX. The pattern is
    // suggestive — the dual atenuverter's two outputs fan to `i8..i11` and `i12..i15`,
    // eight cables that look exactly like eight per-channel trigger inputs — but
    // suggestive is not read, so nothing is renamed on the strength of it.
    type: "audio_vcv_shapemaster",
    title: "VCV ShapeMaster", family: "modulation",
    source: "MindMeldModular/ShapeMaster", block: "VC-9", corpus: "vcv",
    inputs: [["i2", "number"], ["i6", "number"], ["i7", "number"],
             ["i8", "number"], ["i9", "number"], ["i10", "number"], ["i11", "number"],
             ["i12", "number"], ["i13", "number"], ["i14", "number"], ["i15", "number"]],
    outputs: [["o2", "number"], ["o6", "number"], ["o7", "number"],
              ["o8", "number"], ["o9", "number"], ["o12", "number"], ["o13", "number"]],
    knobs: [],
  },

  // ── VC-8 — NYSTHI (TIER 3 throughout; see the header on why there is no source) ─
  {
    // THE BUCHLA 208's DUAL LOW-PASS GATE, and the ONE NYSTHI module in this patch whose
    // port layout the cables PROVE rather than merely suggest — which is why it gets real
    // names. Four audio inputs at `i0..i3` (two filters, the formant bank and a matrix
    // send), four CV inputs at `i4..i7` (two envelopes x two taps each), four outputs at
    // `o0..o3` (one per quad panner). A 4x4x4 module is the only reading that fits.
    // The CHANGELOG confirms the family: "it's just one of the b208 dual dual LPG expanded".
    type: "audio_vcv_b208duallpg",
    title: "VCV b208 Dual LPG", family: "filter",
    source: "NYSTHI/b208_dualLPG", block: "VC-8", corpus: "vcv",
    inputs: [["in_1", "audio"], ["in_2", "audio"], ["in_3", "audio"], ["in_4", "audio"],
             ["cv_1", "number"], ["cv_2", "number"], ["cv_3", "number"], ["cv_4", "number"]],
    outputs: [["out_1", "audio"], ["out_2", "audio"], ["out_3", "audio"], ["out_4", "audio"]],
    knobs: [["level_1", 0.47], ["level_2", 0.49], ["level_3", 0.546], ["level_4", 0.468]],
  },
  {
    // THE BUCHLA 208's ENVELOPE, x2 — INDEX-KEYED, because the panel has more jacks than
    // the cables identify. What the cables DO show is the shape of the patch: `i0` takes an
    // OR gate (so it is the trigger), `i3` and `i7` take manual voltages from the
    // Surveillance (so they are two time/level CVs), `o5` drives a filter cutoff AND an LPG
    // (so it is the envelope), and `o2` drives a second LPG tap.
    // ⚠ ITS SELF-PATCH IS DROPPED AND IT IS THE PATCH'S ONE CYCLE: `o4 -> i4` on BOTH
    // instances, which is how a function generator is made to LOOP — its end-of-cycle
    // pulse retriggers itself, turning an envelope into an LFO. See the blueprint's
    // `deviations`; a cycle is refused by core/nodeflow.js.
    type: "audio_vcv_b208envelope",
    title: "VCV b208 Envelope", family: "modulation",
    source: "NYSTHI/b208_envelope", block: "VC-8", corpus: "vcv",
    inputs: [["i0", "trigger"], ["i3", "number"], ["i4", "trigger"], ["i7", "number"]],
    outputs: [["o2", "number"], ["o4", "trigger"], ["o5", "number"]],
    knobs: [],
  },
  {
    // FOUR QUAD PANNERS CHAINED, and the chain is what makes the layout readable: each
    // panner's `o0`/`o1` feed the next one's `i5`/`i6`, and #1's `o2` feeds #2's `i7`. A
    // quad panner with FRONT and REAR pairs plus a matching chain input per corner is the
    // reading that makes all three of those cables one pattern, so these four get real
    // names. The CHANGELOG confirms the mechanism ("added chaining for cascading QUAD
    // PANNERs") and the extra output ("added GATE output when touching the area").
    // `i1`/`i2` take the Source of Uncertainty's smooth random voltages — that is the
    // patch's automatic quadraphonic movement, and it is why this is a PERFORMANCE patch.
    type: "audio_vcv_quadpanner",
    title: "VCV QuadPanner", family: "effect",
    source: "NYSTHI/QuadPanner", block: "VC-8", corpus: "vcv",
    inputs: [["in", "audio"], ["x", "number"], ["y", "number"],
             ["chain_fl", "audio"], ["chain_fr", "audio"],
             ["chain_rl", "audio"], ["chain_rr", "audio"]],
    outputs: [["out_fl", "audio"], ["out_fr", "audio"],
              ["out_rl", "audio"], ["out_rr", "audio"], ["gate", "trigger"]],
    knobs: [],
  },
  {
    // THE BUCHLA 266 SOURCE OF UNCERTAINTY, and the CHANGELOG documents it fully: four
    // sections — FLUCTUATING RANDOM VOLTAGES 1 and 2 (each with SMOOTH, HARD and PULSE
    // outs), QUANTIZED RANDOM VOLTAGES (2^n in 1/12 V steps and n+1 in 1 V steps, the n+1
    // distribution TRIANGULAR "like throwing 2 dice") and STORED RANDOM VOLTAGES with a
    // CV-controllable SKEW. That is the whole randomness budget of this patch.
    // INDEX-KEYED anyway: the sections are known, their jack ORDER is not, and `o6`/`o7`
    // (which drive the panners and the sample-and-hold) and `o12` cannot be assigned to a
    // named section without guessing which.
    type: "audio_vcv_soymodelsou",
    title: "VCV SoyModelSOU", family: "modulation",
    source: "NYSTHI/SoyModelSOU", block: "VC-8", corpus: "vcv",
    inputs: [["i0", "trigger"]],
    outputs: [["o6", "number"], ["o7", "number"], ["o12", "number"]],
    knobs: [],
  },
  {
    // A BANK OF MANUAL VOLTAGES — the CHANGELOG: "SURVEILLANCE / added switch to have 2
    // ranges A) from -5v to +5v B) from 0v to +10v". So it is a SOURCE, not a monitor.
    // ⚠ AND THAT IS A NODE_REGISTRY CORRECTION: the registry maps `NYSTHI/Surveillance`
    // onto `vcv/recorder` and marks it `chrome` — "not a node". It is neither a recorder
    // nor chrome; it FEEDS both envelopes' CV inputs here, and dropping it as decoration
    // would have silently removed the patch's four hand-set voltages. Almost certainly a
    // fuzzy name match. Reported to the lead.
    // Its four harvested voltages are /5 per R7-UNITS: -1.0 V -> -0.2, and so on.
    type: "audio_vcv_surveillance",
    title: "VCV Surveillance", family: "modulation",
    source: "NYSTHI/Surveillance", block: "VC-8", corpus: "vcv",
    inputs: [],
    outputs: [["out_1", "number"], ["out_2", "number"], ["out_3", "number"], ["out_4", "number"]],
    knobs: [["v_1", -0.2], ["v_2", 0.1172], ["v_3", 0.1434], ["v_4", 0.195]],
  },
  {
    // THE SERGE PROGRAMMER — the CHANGELOG: "it's a PULSE and GATE programmer with LOOPING
    // and SEQUENCING abilities / there are 12 GATE PULSE programmers". INDEX-KEYED: with
    // twelve stages of several lines each there is no way to say which bank `o16..o19` are
    // without the enum, and this patch reads four of them into the 8:1 selector as its
    // melody source. `i0` takes the clock's reset and `i16` its sixteenths.
    type: "audio_vcv_programmer",
    title: "VCV Programmer", family: "modulation",
    source: "NYSTHI/Programmer", block: "VC-8", corpus: "vcv",
    inputs: [["i0", "trigger"], ["i16", "trigger"]],
    outputs: [["o16", "number"], ["o17", "number"], ["o18", "number"], ["o19", "number"]],
    knobs: [],
  },
];
