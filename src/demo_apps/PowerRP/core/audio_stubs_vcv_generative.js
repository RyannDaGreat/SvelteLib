/**
 * PLACEHOLDER NODES for VCV Rack — the big generative machines.
 *
 * The companion to `core/audio_patches_vcv_generative.js`: every node those patches name that
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
 * ── WHERE EACH PORT KEY BELOW CAME FROM — four tiers, and they are NOT equal ────
 * `stubRegistry` throws on disagreement, so a key has to come from a RULE another agent
 * can reproduce rather than from taste. Every row says which tier it is in, because the
 * confidence really is different and the block that owes the node needs to know:
 *
 *   TIER 0 — ADOPTED FROM A SIBLING SET THAT LANDED FIRST. `core/audio_stubs_vcv_ambient.js`
 *     and `core/audio_stubs_vcv_classic.js` were written in the same wave and reached the
 *     tree before this file. Where they had already declared a type, THEIR list is copied
 *     here verbatim — BRIEF.md's precedence rule ("where two patterns compete the OLDER
 *     wins") applied to a port list. Two of those readings look wrong to me and are named
 *     in the report rather than silently corrected here: correcting them would mean
 *     editing another agent's file, and disagreeing would turn every suite in the round
 *     red at import.
 *   TIER 1 — COPIED FROM A LANDED SPEC. `core/audio_specs_vc1.js` (Mutable) is written and
 *     merely not yet spread into `PORT_BLOCK_SPECS`, so nothing registers it; its lists are
 *     verbatim here. **This tier is the scheme working: VC-3a and VC-5 were aggregated WHILE
 *     this file was being written, and six rows (fifteen of them, from FM-OP and ADDR-SEQ
 *     through Plateau, Chronoblob2, Feline, reburst, Clouds, Rings, Blinds, Branches and the
 *     four Bogaudio kernels) were deleted for real — with no change to a single wire, because the
 *     type names and port names had been right all along.**
 *   TIER 2 — MECHANICAL, FROM THE MODULE'S OWN C++ ENUM, or from the landed engine half
 *     where one exists (`synth/worklets/processors_vc2.js`, `…_vc3b.js`). Drop the trailing
 *     `_INPUT`/`_OUTPUT`, lowercase, non-alphanumerics to `_`. Two additions, both taken
 *     from what the landed blocks actually did rather than invented here: an `ENUMS(X, n)`
 *     bank becomes `x1…xn`, and a CV input whose bare name would collide with a knob of
 *     the same name takes `_cv` — the shape VC-3a's FM-OP (`depth_cv`) landed.
 *   TIER 3 — THE SURVEY'S RESOLVED INDICES, because there is no readable source. Vult's
 *     free pack is generated from the Vult language, and NYSTHI and Instruo are not among
 *     the repositories cloned to `/tmp/r7_sources`, so the only exact datum about such a
 *     port is the cable's INDEX. `i5`/`o0` is a poor name and it is what the two sibling
 *     sets already shipped for exactly these modules (Chronoblob2, Tangents, Caudal,
 *     complexSimpler), so it is the local convention and the new rows follow it rather
 *     than forking a prettier one. **Every tier-3 key is a PROPOSAL. It is the one kind
 *     here that can be wrong in a way no test catches, and the owing block must rename
 *     it — for Chronoblob2 that rename is already computable, see that row.**
 *
 * KNOB KEYS carry no collision risk (`stubRegistry` unions them rather than comparing), and
 * they follow the same tiers. The two landed blocks disagree with each other about
 * multiword spelling — VC-1 ships `in_gain`, VC-3a ships `levelResponse` — so rows copied
 * from a spec keep that spec's spelling exactly, and rows derived here use snake_case for a
 * panel control and camelCase for a context-menu option, the majority shape across the two.
 */

/** This set's placeholder declarations. Empty means every node its patches want exists. */
export const BLOCK_STUBS = [
  // ── VC-7a — CountModula: the clocking and event plumbing P2 is BUILT out of ─────
  // TIER 2. Source read: `/tmp/r7_sources/VCVRackPlugins/src/modules/*.cpp` — CountModula's
  // repository slug is `VCVRackPlugins`, which is why the survey's plugin name and the
  // clone directory do not match.
  {
    // THE MODULE THAT MAKES P2 SELF-PLAYING. One trigger fires a burst of N pulses, and
    // every sample-and-hold in that patch is clocked from `pulses` — which is how a patch
    // with no sequencer never stops and never repeats.
    type: "audio_vcv_burstgenerator",
    title: "VCV Burst Generator", family: "modulation",
    source: "CountModula/BurstGenerator", block: "VC-7a", corpus: "vcv",
    // `RATECV_INPUT` is one word in their enum; written `rate_cv` for the reason the
    // header gives — a CV input beside a knob of the same name takes `_cv`.
    inputs: [["clock", "trigger"], ["rate_cv", "number"], ["trigger", "trigger"], ["pulses_cv", "number"], ["probability_cv", "number"]],
    outputs: [["pulses", "trigger"], ["start", "trigger"], ["duration", "trigger"], ["end", "trigger"]],
    knobs: [["rate", 1.0994], ["rate_cv", 0.2771], ["pulses_cv", 0.6747], ["probability", 1]],
  },
  {
    // A STEREO CROSSFADER WITH A TIMED IN AND OUT. P2 uses six to fade whole voices in
    // and out of the mix, which is what it does instead of muting.
    type: "audio_vcv_fade",
    title: "VCV Fade", family: "effect",
    source: "CountModula/Fade", block: "VC-7a", corpus: "vcv",
    inputs: [["l", "audio"], ["r", "audio"], ["ctrl", "number"]],
    outputs: [["l", "audio"], ["r", "audio"], ["gate", "trigger"], ["trig", "trigger"]],
    knobs: [["fade", 0], ["in", 0.9425], ["out", 0.9127], ["mon", 0]],
  },
  {
    type: "audio_vcv_eventtimer",
    title: "VCV Event Timer", family: "modulation",
    source: "CountModula/EventTimer", block: "VC-7a", corpus: "vcv",
    inputs: [["clock", "trigger"], ["reset", "trigger"], ["trigger", "trigger"]],
    outputs: [["end", "trigger"], ["endt", "trigger"]],
    // Their panel is a pair of up/down buttons per digit; the COUNT is what the patch file
    // stores (`"length": 30`), so that is the knob rather than six button params.
    knobs: [["length", 3], ["retrigger", 0]],
  },
  {
    // NOT our audio_sample_hold: this one holds with a PROBABILITY, so a clock tick
    // sometimes passes the input straight through. That is generative behaviour, not a
    // utility, which is why it is a placeholder and not a substitution.
    type: "audio_vcv_sampleandhold2",
    title: "VCV Sample & Hold 2", family: "modulation",
    source: "CountModula/SampleAndHold2", block: "VC-7a", corpus: "vcv",
    inputs: [["sample", "audio"], ["trig", "trigger"], ["mode", "number"], ["prob", "number"], ["offset", "number"]],
    outputs: [["sample", "audio"], ["inv", "audio"]],
    knobs: [["mode", 0], ["prob", 0.5241], ["prob_cv", 0], ["level", 0.1747], ["offset", 0]],
  },
  {
    type: "audio_vcv_sampleandhold",
    title: "VCV Sample & Hold", family: "modulation",
    source: "CountModula/SampleAndHold", block: "VC-7a", corpus: "vcv",
    inputs: [["sample", "audio"], ["trig", "trigger"], ["mode", "number"]],
    outputs: [["sample", "audio"], ["inv", "audio"]],
    knobs: [["mode", 0]],
  },
  {
    type: "audio_vcv_booleanand",
    title: "VCV Boolean AND", family: "modulation",
    source: "CountModula/BooleanAND", block: "VC-7a", corpus: "vcv",
    inputs: [["a", "trigger"], ["b", "trigger"], ["c", "trigger"], ["d", "trigger"], ["i", "trigger"]],
    outputs: [["and", "trigger"], ["inv", "trigger"]],
    knobs: [],
  },
  {
    // TIER 0 — adopted from core/audio_stubs_vcv_classic.js. Eight simultaneous divisions
    // of one clock; P9 uses it so one Rampage cycle drives events at unrelated rates.
    type: "audio_vcv_clockdivider",
    title: "Clock Divider", family: "modulation",
    source: "CountModula/ClockDivider", block: "VC-7a", corpus: "vcv",
    inputs: [["clock", "trigger"], ["reset", "trigger"]],
    outputs: [["div1", "trigger"], ["div2", "trigger"], ["div3", "trigger"], ["div4", "trigger"],
      ["div5", "trigger"], ["div6", "trigger"], ["div7", "trigger"], ["div8", "trigger"]],
    knobs: [["dir", 0], ["mode", 0]],
  },

  // ── VC-3a — Bogaudio part 1. TIER 1: verbatim from core/audio_specs_vc3a.js, which is
  // written and merely not yet spread into PORT_BLOCK_SPECS. ──────────────────────

  // ── VC-1 — Mutable. TIER 0 for the four the sibling sets landed; TIER 1 for Blinds,
  // which nobody has declared and core/audio_specs_vc1.js already specifies. ──────
  {
    // TIER 0 (ambient). Sixteen macro-oscillator models behind four knobs; P9's lead voice.
    type: "audio_vcv_plaits",
    title: "VCV Plaits", family: "source",
    source: "AudibleInstruments/Plaits", block: "VC-1", corpus: "vcv",
    inputs: [["engine", "number"], ["timbre", "number"], ["freq", "number"], ["morph", "number"], ["harmonics", "number"], ["trigger", "number"], ["level", "number"], ["note", "number"]],
    outputs: [["out", "audio"], ["aux", "audio"]],
    knobs: [["harmonics", 0.203], ["timbre", 0.4955], ["morph", 0.5], ["timbre_cv", 0.198], ["lpg_color", 0.5], ["lpg_decay", 0.5]],
  },

  // ── VC-3b — Bogaudio part 2. TIER 0 where a sibling set landed the type, TIER 2
  // otherwise — and the tier-2 lists are the LANDED engine half's own port names
  // (`synth/worklets/processors_vc3b.js`), so the spec that block still owes has nowhere
  // to disagree. ─────────────────────────────────────────────────────────────────
  {
    // ⚠ WALK2 IS A SEPARATE MODULE AND NOTHING HAS PORTED IT. `NODE_REGISTRY.md` folds
    // `Bogaudio-Walk2` into its `Bogaudio/Bogaudio-Walk` row, but the landed engine half
    // ships ONE `vcvWalk` with a single `out` — a 1-D walker. Walk2 is the 2-D one: two
    // independent rates, two scales, an X, a Y and a DISTANCE. P5 runs EIGHT and the
    // pairing is the point (a 2-D walk makes two modulation streams correlated but not
    // equal), so it cannot be spelled as Walk. TIER 2, `BogaudioModules/src/Walk2.hpp`.
    type: "audio_vcv_walk2",
    title: "VCV Bogaudio Walk2", family: "modulation",
    source: "Bogaudio/Bogaudio-Walk2", block: "VC-3b", corpus: "vcv",
    inputs: [["offset_x_cv", "number"], ["scale_x_cv", "number"], ["rate_x_cv", "number"],
      ["offset_y_cv", "number"], ["scale_y_cv", "number"], ["rate_y_cv", "number"], ["jump", "trigger"]],
    outputs: [["out_x", "audio"], ["out_y", "audio"], ["distance", "audio"]],
    knobs: [["rate_x", 0.3024], ["rate_y", 0.3265], ["offset_x", 0], ["offset_y", 0], ["scale_x", 0.9735], ["scale_y", 1]],
  },
  {
    // TIER 0 (classic). Bogaudio's little LFO — one selectable waveform, one output. It is
    // a DIFFERENT type from `audio_vcv_bog_lfo` (the full Bogaudio LFO, six simultaneous
    // waveforms, already specified by VC-3a), which is what the model-slug naming rule
    // gives: `Bogaudio-LLFO` -> `audio_vcv_llfo`. NODE_REGISTRY.md folds the two into one
    // node; the sibling set split them, and the split is what the convention asks for.
    type: "audio_vcv_llfo",
    title: "LLFO", family: "modulation",
    source: "Bogaudio/Bogaudio-LLFO", block: "VC-3b", corpus: "vcv",
    inputs: [["pitch", "number"], ["reset", "trigger"]],
    outputs: [["out", "audio"]],
    knobs: [["frequency", 0.007], ["slow", 1], ["wave", 0], ["offset", 0], ["scale", 1]],
  },
  {
    // XCO — four waveforms with per-waveform phase, mix and saturation. P5's entire
    // wavetable / phase-distortion family comes out of this one module.
    type: "audio_vcv_xco",
    title: "VCV Bogaudio XCO", family: "source",
    source: "Bogaudio/Bogaudio-XCO", block: "VC-3b", corpus: "vcv",
    inputs: [["fm", "audio"], ["fm_depth_cv", "number"],
      ["square_pw_cv", "number"], ["square_phase_cv", "number"], ["square_mix_cv", "number"],
      ["saw_saturation_cv", "number"], ["saw_phase_cv", "number"], ["saw_mix_cv", "number"],
      ["triangle_sample_cv", "number"], ["triangle_phase_cv", "number"], ["triangle_mix_cv", "number"],
      ["sine_feedback_cv", "number"], ["sine_phase_cv", "number"], ["sine_mix_cv", "number"],
      ["pitch", "number"], ["sync", "trigger"]],
    outputs: [["square", "audio"], ["saw", "audio"], ["triangle", "audio"], ["sine", "audio"], ["mix", "audio"]],
    knobs: [["frequency", 3], ["fm_depth", 0.1253], ["square_pw", 0.3927], ["square_mix", 0.9614],
      ["saw_mix", 1], ["triangle_mix", 1], ["sine_mix", 1]],
  },
  {
    // TIER 0 (ambient). A reference pitch as a plain V/oct source — no inputs at all. P9
    // uses two, one per voice, which is how that patch states its key.
    type: "audio_vcv_reftone",
    title: "Bogaudio Reftone", family: "source",
    source: "Bogaudio/Bogaudio-Reftone", block: "VC-3b", corpus: "vcv",
    inputs: [],
    outputs: [["cv", "audio"], ["out", "audio"]],
    knobs: [["pitch", 7], ["octave", 2], ["fine", 0]],
  },

  // ── VC-2 — Fundamental + Core. TIER 0 for the Quantizer; TIER 2 for the rest, from the
  // landed engine half (`synth/worklets/processors_vc2.js`). ─────────────────────
  {
    // THE ONE SEQUENCER IN P2 — and it does not drive the piece, it drives one voice
    // while the burst generator drives everything else.
    type: "audio_vcv_seq3",
    title: "VCV SEQ3", family: "modulation",
    source: "Fundamental/SEQ3", block: "VC-2", corpus: "vcv",
    inputs: [["clock", "trigger"], ["reset", "trigger"], ["run", "trigger"], ["tempo", "number"], ["steps", "number"]],
    outputs: [["cv1", "audio"], ["cv2", "audio"], ["cv3", "audio"], ["trig", "trigger"],
      ["steps", "audio"], ["clock", "trigger"], ["run", "trigger"], ["reset", "trigger"],
      ["step1", "trigger"], ["step2", "trigger"], ["step3", "trigger"], ["step4", "trigger"],
      ["step5", "trigger"], ["step6", "trigger"], ["step7", "trigger"], ["step8", "trigger"]],
    knobs: [["steps", 6]],
  },
  {
    // A WINDOW COMPARATOR used as a voice gate: a random walk crossing a threshold is
    // what decides whether a layer is currently audible.
    type: "audio_vcv_compare",
    title: "VCV Compare", family: "modulation",
    source: "Fundamental/Compare", block: "VC-2", corpus: "vcv",
    inputs: [["a", "audio"], ["b", "audio"]],
    outputs: [["max", "audio"], ["min", "audio"], ["clip", "audio"], ["lim", "audio"],
      ["clipgate", "trigger"], ["limgate", "trigger"], ["greater", "trigger"], ["less", "trigger"]],
    knobs: [["b", -0.8193], ["b_cv", 0]],
  },
  {
    // TIER 0 (classic). Fundamental's TWELVE-NOTE MASK quantizer. P5 uses six across two
    // different masks and switches between them, so the mask is the musical content —
    // which is why our `audio_quantize` (named scales) is not the same node.
    type: "audio_vcv_quantizer",
    title: "Quantizer", family: "filter",
    source: "Fundamental/Quantizer", block: "VC-2", corpus: "vcv",
    inputs: [["pitch", "number"]],
    outputs: [["pitch", "audio"]],
    knobs: [["offset", 0]],
  },
  {
    type: "audio_vcv_sequentialswitch2",
    title: "VCV Sequential Switch 2", family: "modulation",
    source: "Fundamental/SequentialSwitch2", block: "VC-2", corpus: "vcv",
    inputs: [["in1", "audio"], ["in2", "audio"], ["in3", "audio"], ["in4", "audio"], ["clock", "trigger"], ["reset", "trigger"]],
    outputs: [["out", "audio"]],
    knobs: [["steps", 2], ["declick", 0]],
  },

  // ── VC-4 — Surge XT Rack. TIER 2, from `/tmp/r7_sources/surge-rack/src/*.h`. ────
  // ⚠ THEIR MOD INPUTS ARE A BANK: `OSC_MOD_INPUT + n_mod_inputs` with
  // `n_mod_inputs{4}`, so the enum yields `osc_mod_0…3`. Cross-checked against the cable
  // list: the burst's gate lands on EGxVCA `[i2]`, which in that enum is `GATE_IN` — the
  // third member. It agrees, so the expansion is right.
  //
  // ⚠ AND THEIR PARAMS ARE INDEXED, WHICH COSTS US REAL DATA. A Surge module serialises
  // `p1=0.005, p2=0.5, …` with no names in the patch file and no fixed meaning across
  // models, so these four rows declare NO knobs and P2's harvested Surge dial values are
  // LOST. Recorded as a named deviation on the patch rather than papered over with
  // invented keys; VC-4 must recover them from the module's own param list.
  {
    type: "audio_vcv_surgextoscsine",
    title: "Surge XT Sine OSC", family: "source",
    source: "SurgeXTRack/SurgeXTOSCSine", block: "VC-4", corpus: "vcv",
    inputs: [["pitch_cv", "number"], ["retrigger", "trigger"],
      ["osc_mod_0", "number"], ["osc_mod_1", "number"], ["osc_mod_2", "number"], ["osc_mod_3", "number"], ["audio_input", "audio"]],
    outputs: [["output_l", "audio"], ["output_r", "audio"]],
    knobs: [],
  },
  {
    type: "audio_vcv_surgextoscwavetable",
    title: "Surge XT Wavetable OSC", family: "source",
    source: "SurgeXTRack/SurgeXTOSCWavetable", block: "VC-4", corpus: "vcv",
    inputs: [["pitch_cv", "number"], ["retrigger", "trigger"],
      ["osc_mod_0", "number"], ["osc_mod_1", "number"], ["osc_mod_2", "number"], ["osc_mod_3", "number"], ["audio_input", "audio"]],
    outputs: [["output_l", "audio"], ["output_r", "audio"]],
    knobs: [],
  },
  {
    type: "audio_vcv_surgextegxvca",
    title: "Surge XT EGxVCA", family: "effect",
    source: "SurgeXTRack/SurgeXTEGxVCA", block: "VC-4", corpus: "vcv",
    inputs: [["input_l", "audio"], ["input_r", "audio"], ["gate_in", "trigger"], ["clock_in", "trigger"],
      ["mod_0", "number"], ["mod_1", "number"], ["mod_2", "number"], ["mod_3", "number"]],
    outputs: [["output_l", "audio"], ["output_r", "audio"], ["env_out", "audio"], ["eoc_out", "trigger"]],
    knobs: [],
  },
  {
    type: "audio_vcv_surgextvcf",
    title: "Surge XT VCF", family: "filter",
    source: "SurgeXTRack/SurgeXTVCF", block: "VC-4", corpus: "vcv",
    inputs: [["input_l", "audio"], ["input_r", "audio"],
      ["vcf_mod_0", "number"], ["vcf_mod_1", "number"], ["vcf_mod_2", "number"], ["vcf_mod_3", "number"]],
    outputs: [["output_l", "audio"], ["output_r", "audio"]],
    knobs: [],
  },

  // ── VC-5 — Valley + the large FX. Plateau and Feline are TIER 0 (and agree with a
  // mechanical reading of `Plateau.hpp` / `Feline.hpp`, including `left`/`right` rather
  // than a prettier `in_l`/`in_r`). ──────────────────────────────────────────────

  // ── VC-6 — Befaco. TIER 2, from `Befaco/src/Rampage.cpp`. ──────────────────────
  {
    // THE MODULE P9 IS ABOUT. One dual slew recurrence wearing four hats:
    // `out_a`/`out_b` are the ENVELOPE, or the LFO once `cycle_a`/`cycle_b` latch it into
    // free-running, or the SLEW-LIMITED version of whatever is patched to `in_a`/`in_b`;
    // `rising`/`falling` are its edge detectors; `comparator`/`min`/`max` make it a
    // COMPARATOR across the two channels. Same integrator, four jobs, and the reason the
    // module is hard to port is that they all have to fall out of it at once.
    type: "audio_vcv_rampage",
    title: "VCV Rampage", family: "modulation",
    source: "Befaco/Rampage", block: "VC-6", corpus: "vcv",
    inputs: [["in_a", "audio"], ["in_b", "audio"], ["trigg_a", "trigger"], ["trigg_b", "trigger"],
      ["rise_cv_a", "number"], ["rise_cv_b", "number"], ["fall_cv_a", "number"], ["fall_cv_b", "number"],
      ["exp_cv_a", "number"], ["exp_cv_b", "number"], ["cycle_a", "trigger"], ["cycle_b", "trigger"]],
    outputs: [["rising_a", "trigger"], ["rising_b", "trigger"], ["falling_a", "trigger"], ["falling_b", "trigger"],
      ["eoc_a", "trigger"], ["eoc_b", "trigger"], ["out_a", "audio"], ["out_b", "audio"],
      ["comparator", "trigger"], ["min", "audio"], ["max", "audio"]],
    knobs: [["range_a", 0], ["range_b", 0], ["shape_a", 0], ["shape_b", 0],
      ["rise_a", 0.582], ["rise_b", 0.675], ["fall_a", 0.525], ["fall_b", 0.675],
      ["cycle_a", 1], ["cycle_b", 1], ["balance", 0.5]],
  },

  // ── VC-7b — ML modules. TIER 2, from `ML_modules/src/Quantum.cpp`. ─────────────
  {
    // A TWELVE-SWITCH SCALE MASK with a gate on every accepted note. P9 uses three on ONE
    // mask, which is how its three voices stay in the same key while playing different
    // lines. The mask is the musical content, so ours (named scales) is a different node.
    type: "audio_vcv_quantum",
    title: "VCV Quantum", family: "modulation",
    source: "ML_modules/Quantum", block: "VC-7b", corpus: "vcv",
    inputs: [["in", "audio"], ["transpose", "number"], ["note", "number"], ["set", "trigger"], ["reset", "trigger"]],
    outputs: [["out", "audio"], ["trigger", "trigger"], ["gate", "trigger"]],
    knobs: [["semi1", 0], ["semi2", 0], ["semi3", 1], ["semi4", 1], ["semi5", 0], ["semi6", 0],
      ["semi7", 0], ["semi8", 1], ["semi9", 0], ["semi10", 1], ["semi11", 1], ["semi12", 0]],
  },

  // ── TIER 3 — NO READABLE SOURCE. Read the header's tier note first. Vult's free pack is
  // compiled from the Vult language, and NYSTHI and Instruo are not among the repositories
  // under `/tmp/r7_sources`, so these keys are the survey's resolved cable INDICES — the
  // only exact datum there is, and the spelling the two sibling sets already shipped for
  // exactly these modules. Every key is a PROPOSAL for VC-8 / VC-10 to rename. ────
  {
    // TIER 0 + TIER 3 (ambient). Vult's lowpass gate. Six in P2 and four in P9, always as
    // stereo PAIRS: one instance per channel, its cutoff opened by a held random value.
    type: "audio_vcv_tangents",
    title: "VCV Tangents", family: "filter",
    source: "VultModulesFree/Tangents", block: "VC-10", corpus: "vcv",
    inputs: [["i1", "audio"], ["i3", "number"]],
    outputs: [["o0", "audio"]],
    knobs: [["p0", 0.6275], ["p1", 0], ["p2", 0], ["p4", 0.6]],
  },
  {
    // TIER 0 + TIER 3 (ambient). Vult's chaotic modulation source: no inputs the patches
    // use, nine taps out, one rate knob.
    type: "audio_vcv_caudal",
    title: "VCV Caudal", family: "modulation",
    source: "VultModulesFree/Caudal", block: "VC-10", corpus: "vcv",
    inputs: [],
    outputs: [["o0", "audio"], ["o1", "audio"], ["o2", "audio"], ["o3", "audio"], ["o4", "audio"], ["o6", "audio"], ["o7", "audio"], ["o9", "audio"], ["o10", "audio"]],
    knobs: [["p0", -0.325]],
  },
  {
    // TIER 0 + TIER 3 (classic). Instruo's ochd: eight slow LFOs at eight related but
    // mutually incommensurate rates from one knob. It is P9's whole modulation farm in a
    // single module, which is why that patch needs so few other modulators.
    type: "audio_vcv_ochd",
    title: "ochd", family: "modulation",
    source: "Instruo/ochd", block: "VC-10", corpus: "vcv",
    inputs: [],
    outputs: [["out1", "audio"], ["out2", "audio"], ["out3", "audio"], ["out4", "audio"],
      ["out5", "audio"], ["out6", "audio"], ["out7", "audio"], ["out8", "audio"]],
    knobs: [["rate", 0.2375]],
  },
  {
    // TIER 0 + TIER 3 (ambient). NYSTHI's complexSimpler, a sample player. P5 takes its
    // two outputs into the bus and patches nothing in, which is why it declares no inputs.
    type: "audio_vcv_complexsimpler",
    title: "VCV Complex Simpler", family: "source",
    source: "NYSTHI/complexSimpler", block: "VC-8", corpus: "vcv",
    inputs: [],
    outputs: [["o0", "audio"], ["o1", "audio"]],
    knobs: [["p0", 1], ["p4", 1], ["p7", 1], ["p11", 1], ["p12", 2], ["p13", 0]],
  },
  {
    // TIER 0 + TIER 3 (classic). NYSTHI's attack/decay envelope. P9 fires it from a
    // Rampage edge and lands it on Plaits' level input.
    type: "audio_vcv_attackdecay",
    title: "Attack Decay", family: "modulation",
    source: "NYSTHI/AttackDecay", block: "VC-8", corpus: "vcv",
    inputs: [["attack_cv", "number"], ["decay_cv", "number"], ["retrig", "trigger"], ["trig", "trigger"]],
    outputs: [["out", "audio"], ["eoc", "trigger"]],
    knobs: [["p0", 0.4365], ["p1", 0.1]],
  },
  {
    // TIER 3, NEW. A granular/tape player fed LIVE by the voice above it — P2's Fade feeds
    // it and in P9 a Chronoblob does, both stereo in, stereo out, started by a trigger.
    // Indices from the cable lists of those two patches: `[i0]`/`[i1]` are the pair and
    // `[i2]` is the start.
    type: "audio_vcv_simpliciter",
    title: "VCV Simpliciter", family: "effect",
    source: "NYSTHI/Simpliciter", block: "VC-8", corpus: "vcv",
    inputs: [["in_l", "audio"], ["in_r", "audio"], ["trig", "trigger"]],
    outputs: [["out_l", "audio"], ["out_r", "audio"]],
    knobs: [],
  },
  {
    // TIER 3, NEW. Instruo's saich — a dual complex oscillator, P9's second voice. `[i0]`
    // takes the Reftone's V/oct and `[i6]` an ochd tap; `[o0]` is what reaches the mix.
    type: "audio_vcv_saich",
    title: "VCV saich", family: "source",
    source: "Instruo/saich", block: "VC-10", corpus: "vcv",
    inputs: [["i0", "number"], ["i6", "number"]],
    outputs: [["o0", "audio"]],
    knobs: [["p0", 0.4755], ["p7", 1], ["p8", 0.5]],
  },
  {
    // TIER 3, NEW. Vult's Basal — the analogue voice P9 hangs its Rampage envelope on.
    // `[i0]` is the quantised pitch, `[i1]`/`[i2]` two ochd taps, `[o0]` the signal.
    type: "audio_vcv_basal",
    title: "VCV Basal", family: "source",
    source: "VultModulesFree/Basal", block: "VC-10", corpus: "vcv",
    inputs: [["i0", "number"], ["i1", "number"], ["i2", "number"]],
    outputs: [["o0", "audio"]],
    knobs: [["p2", 0.087], ["p3", 0.225], ["p4", 0.4515], ["p5", 0.543]],
  },
];
