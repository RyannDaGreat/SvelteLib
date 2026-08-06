/**
 * PLACEHOLDER NODES for VCV Rack — the recognisable instruments.
 *
 * The companion to `core/audio_patches_vcv_classic.js`: every node those patches name that
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
 * ════════════════════════════════════════════════════════════════════════════
 * THREE RULES THIS SET FOLLOWS, WRITTEN DOWN BECAUSE EACH ONE WAS A JUDGEMENT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 1. PORT KEYS ARE THE ENUM, MINUS THE `_INPUT`/`_OUTPUT` SUFFIX ──────────
 * Read from the C++ `enum InputsIds`/`OutputsIds` in `/tmp/r7_sources/`, lowercased,
 * suffix dropped: `PITCH1_INPUT` → `pitch1`, `DIVU_OUTPUT` → `divu`, `MIX_CV_INPUT` →
 * `mix_cv`. Where a CV JACK collides with a KNOB of the same name the jack takes `_cv`
 * (`SUSTAIN_INPUT` beside a Sustain knob → `sustain_cv`). All of that is
 * `core/audio_specs_vc3a.js`'s spelling, not this file's invention — VC-3a shipped nine
 * of these modules for real and its choices are the precedent every row here follows.
 * A KNOB AND A PORT MAY LEGITIMATELY SHARE A NAME when they are the same control:
 * VC-3a's DADSR(H) has a `trigger` knob (the panel button) beside a `trigger` input
 * ("it SUMS with the trigger input exactly as the C++ does"), so Bogaudio Switch's
 * `gate` and XFade's `mix` do the same rather than inventing a second spelling.
 *
 * ── 2. WHERE THE SOURCE WAS NOT AVAILABLE, THE ROW SAYS SO ON THE CARD ──────
 * `survey_vcv.md` § 7 lists the plugins whose repos it could not clone, and eleven of
 * them are in these four patches. For those modules the cable list gives INDICES
 * (`Lateralus#1[i0]`) and nothing else, so the port names below are read off the panel
 * and off what the cables prove — they are NOT the enum. Rather than let that look like
 * a resolved reading, the `source` string carries `ports PROVISIONAL`, which
 * `stubSpec` folds into the card's own help text. The owing block must reconcile.
 * **This is the one place a reader could be misled, so it is said in the loudest
 * available place rather than only here.**
 *
 * ── 3. THE HARVESTED DIAL VALUES, AND THE ONE KIND THAT CANNOT RIDE A KNOB ──
 * A placeholder knob is NUMERIC, so a param the real spec has already declared DISCRETE
 * cannot ride one — see the first bullet. The second bullet is HISTORY worth keeping: it
 * was true while `STUB_RANGES.vcv` was the ±10 V Rack rail, which rejected every legal
 * real-unit value above ten (a 100 s Hold, a 397 BPM tempo, a 1664 Hz cutoff). That is
 * the one thing `core/audio_stub_nodes.js` says the scaffold must never do, and the rail
 * has since been widened, so the workaround below is no longer needed for new rows —
 * three declarations here still carry their value as a DEFAULT because that is where it
 * was put when the rail was narrow, and moving it now would change nothing:
 *   • A SWITCH that VC-3a has already spelled as a DISCRETE row (FM-OP's
 *     `envToDepth: "on"`, Bogaudio AD's `loop`). A string is not in [-10, 10], and
 *     writing Rack's raw 1.0 onto that key would become an out-of-options value the
 *     day the real node lands. So the placeholder does not carry it and the patch's
 *     `deviations` records the position IN VC-3a's OWN SPELLING, which makes the swap
 *     mechanical instead of archaeological.
 *   • A value whose units are not volts and which leaves the rail — a 100 s Hold, a
 *     120 BPM tempo, a log2-hertz exponent. Those ride the DECLARED DEFAULT here
 *     (measured: `repairedDocument` does not clamp a knob default, so this produces
 *     zero repair reports) and are NOT restated as a blueprint override, because an
 *     override is range-checked against the rail.
 * Everything else is set by the blueprint, which is where it belongs: `stubRegistry`
 * unions knob sets keeping the FIRST value seen, so a value that lived only here would
 * silently become whichever patch set declared it first.
 */

/** This set's placeholder declarations. Empty means every node its patches want exists. */
export const BLOCK_STUBS = [
  // ── VC-7a — CountModula ────────────────────────────────────────────────────
  {
    // THE HEADLINE NODE OF P25, and the one family nothing else in the corpus touches:
    // it divides an incoming signal's FREQUENCY by an integer, which produces a true
    // SUBHARMONIC rather than a transposed copy. Eight of them are the Subharmonicon.
    type: "audio_vcv_vcfrequencydividermkii",
    title: "VC Frequency Divider MkII", family: "modulation",
    source: "CountModula/VCFrequencyDividerMkII", block: "VC-7a", corpus: "vcv",
    inputs: [["cv", "number"], ["div", "audio"]],
    outputs: [["divb", "audio"], ["divu", "audio"]],
    // `MANUAL_PARAM` is labelled "Divide by" and runs 1…21, so it is `divide`; `CV_PARAM`
    // is labelled "CV Amount" and is the attenuverter on the `cv` jack.
    knobs: [["cvAmount", 0], ["divide", 1]],
  },
  {
    type: "audio_vcv_busroute2", title: "Bus Route 2", family: "modulation",
    source: "CountModula/BusRoute2", block: "VC-7a", corpus: "vcv",
    // ENUMS(GATE_INPUTS, 7) → gate1…gate7; A_OUTPUT/B_OUTPUT → a, b.
    inputs: [1, 2, 3, 4, 5, 6, 7].map((n) => [`gate${n}`, "trigger"]),
    outputs: [["a", "trigger"], ["b", "trigger"]],
    // ENUMS(BUS_A_PARAM, 7) then ENUMS(BUS_B_PARAM, 7) — so the patch file's `p0` is
    // busA1 and its `p8` is busB2. Only the routed pair is declared; the rest are off.
    knobs: [["busA1", 0], ["busB2", 0]],
  },
  {
    type: "audio_vcv_booleanxor", title: "Boolean XOR", family: "modulation",
    source: "CountModula/BooleanXOR", block: "VC-7a", corpus: "vcv",
    inputs: [["a", "number"], ["b", "number"], ["c", "number"], ["d", "number"], ["i", "number"]],
    outputs: [["xor", "trigger"], ["inv", "trigger"]],
    knobs: [["mode", 0]],
  },

  // ── VC-7b — clocking and sequencing plumbing ───────────────────────────────
  {
    type: "audio_vcv_simpleclock", title: "Simple Clock", family: "modulation",
    source: "JW-Modules/SimpleClock", block: "VC-7b", corpus: "vcv",
    inputs: [],
    outputs: [["clock", "trigger"], ["reset", "trigger"],
      ["div_4", "trigger"], ["div_8", "trigger"], ["div_16", "trigger"], ["div_32", "trigger"]],
    // BPM (§ R7-UNITS clause 2 — a tempo's real unit). Its own `configParam(CLOCK_PARAM,
    // -2, 6, 1, "BPM", "", 2.f, 60.f)` declares displayBase 2 and multiplier 60, so
    // `bpm = 2^raw · 60` and P25's harvested raw 2.728 is 397.3 BPM — fast on purpose,
    // because it is about to be divided by 3, 5, 6 and 7 into 132/79/66/57 BPM pulses.
    // It is declared HERE and not as a blueprint override: a BPM leaves the ±10 V rail.
    // `prob` is "Random Reset Probability", harvested at its knob MINIMUM (raw −2), which
    // is probability zero — so the placeholder's 0 says the same thing in real units.
    knobs: [["clock", 397.3], ["run", 0], ["prob", 0], ["reset", 0]],
  },
  {
    type: "audio_vcv_octatrig", title: "Octa Trig", family: "modulation",
    source: "ML_modules/OctaTrig", block: "VC-7b", corpus: "vcv",
    // ENUMS(IN_INPUT, 8) in; then ENUMS(UP_OUTPUT, 8), ENUMS(DN_OUTPUT, 8),
    // ENUMS(SUM_OUTPUT, 8) out — eight independent rising/falling edge detectors.
    inputs: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`in${n}`, "number"]),
    outputs: [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`up${n}`, "trigger"]),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`dn${n}`, "trigger"]),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`sum${n}`, "trigger"]),
    ],
    knobs: [["reset", 0]],
  },

  // ── VC-6 — Befaco ──────────────────────────────────────────────────────────
  {
    type: "audio_vcv_evenvco", title: "Even VCO", family: "source",
    source: "Befaco/EvenVCO", block: "VC-6", corpus: "vcv",
    inputs: [["pitch1", "number"], ["pitch2", "number"], ["fm", "audio"], ["sync", "trigger"], ["pwm", "number"]],
    outputs: [["tri", "audio"], ["sine", "audio"], ["even", "audio"], ["saw", "audio"], ["square", "audio"]],
    // `octave` snaps to integers (−5…4) and `tune` is ±7 semitones — both raw Rack.
    knobs: [["octave", 0], ["tune", 0], ["pw", 0]],
  },
  {
    type: "audio_vcv_stmix", title: "ST Mix", family: "modulation",
    source: "Befaco/STMix", block: "VC-6", corpus: "vcv",
    // ENUMS(LEFT_INPUT, numMixerChannels + 1) — four channels plus an AUX pair.
    inputs: [
      ...[1, 2, 3, 4, 5].map((n) => [`left${n}`, "audio"]),
      ...[1, 2, 3, 4, 5].map((n) => [`right${n}`, "audio"]),
    ],
    outputs: [["left", "audio"], ["right", "audio"]],
    knobs: [1, 2, 3, 4].map((n) => [`gain${n}`, 0]),
  },

  // ── VC-3a — Bogaudio, part 1. ONE ROW LEFT, AND IT IS NOT THE ADSR ────────
  // Eight rows stood here for one working day: `core/audio_specs_vc3a.js` was committed
  // but not yet spread into `core/audio_blocks.js`'s PORT_BLOCK_SPECS, so FM-OP, the LFO,
  // DADSR(H), ADDR-SEQ, 8:1 and BOOL were in NO registry and these declarations — port
  // keys and knob keys copied from that file, so the swap was wire-identical — were what
  // made the patches below typecheck. The barrel landed mid-write and they were deleted.
  // What is left is Bogaudio-AD, which is a DIFFERENT NODE from the ADSR that shipped.
  {
    // NOT VC-3a's `audio_vcv_bog_adsr`, and the registry's row is misleading about this:
    // it folds `Bogaudio-AD` and `Bogaudio-ADSR` into one node, but AD has TRIGGER/
    // ATTACK/DECAY inputs and ENV/EOC outputs where ADSR has one gate and one output.
    // Different ports is a different node; a wire cannot be shared between them.
    type: "audio_vcv_ad", title: "AD", family: "modulation",
    source: "Bogaudio/Bogaudio-AD", block: "VC-3a", corpus: "vcv",
    inputs: [["trigger", "trigger"], ["attack", "number"], ["decay", "number"]],
    outputs: [["env", "audio"], ["eoc", "trigger"]],
    knobs: [["attack", 0], ["decay", 0]],
  },

  // ── VC-3b — Bogaudio, part 2 ───────────────────────────────────────────────
  {
    type: "audio_vcv_switch88", title: "Switch 8×8", family: "modulation",
    source: "Bogaudio/Bogaudio-Switch88", block: "VC-3b", corpus: "vcv",
    inputs: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`in${n}`, "audio"]),
    outputs: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`out${n}`, "audio"]),
    // MIX{row}{column} — only the three the patch closes are declared; the other 61
    // crosspoints are open and declaring them would be 61 dials nothing turns.
    knobs: [["mix11", 0], ["mix16", 0], ["mix24", 0]],
  },
  {
    type: "audio_vcv_llfo", title: "LLFO", family: "modulation",
    source: "Bogaudio/Bogaudio-LLFO", block: "VC-3b", corpus: "vcv",
    inputs: [["pitch", "number"], ["reset", "trigger"]],
    outputs: [["out", "audio"]],
    knobs: [["frequency", 0], ["slow", 0], ["wave", 0], ["offset", 0], ["scale", 0]],
  },
  {
    type: "audio_vcv_lvco", title: "LVCO", family: "source",
    source: "Bogaudio/Bogaudio-LVCO", block: "VC-3b", corpus: "vcv",
    inputs: [["pitch", "number"], ["fm", "audio"], ["sync", "trigger"]],
    outputs: [["out", "audio"]],
    // HERTZ (§ R7-UNITS clause 2). A Bogaudio oscillator's pitch knob is a CV against
    // `cvToFrequency` — `hz = 261.626 · 2^raw`, CONFIRMED at `lfo_base.cpp:30-47` for the
    // LFO family and the same table for the VCO family — so P8's harvested raw 0.9867 is
    // 518.4 Hz, a C5. It is declared HERE because it leaves the ±10 V rail.
    knobs: [["frequency", 518.4], ["slow", 0], ["wave", 0], ["fmDepth", 0]],
  },

  // ── VC-2 — Fundamental + Core ──────────────────────────────────────────────
  {
    type: "audio_vcv_octave", title: "Octave", family: "modulation",
    source: "Fundamental/Octave", block: "VC-2", corpus: "vcv",
    inputs: [["pitch", "number"], ["octave", "number"]],
    outputs: [["pitch", "audio"]],
    knobs: [["octave", 0]],
  },
  {
    type: "audio_vcv_quantizer", title: "Quantizer", family: "filter",
    source: "Fundamental/Quantizer", block: "VC-2", corpus: "vcv",
    // ⚠ THE `offset` INPUT IS ADOPTED, NOT ENDORSED. `Fundamental/src/Quantizer.cpp`'s
    // `enum InputIds` holds PITCH_INPUT and nothing else — its Offset is a PARAM with no
    // jack. `core/audio_stubs_vcv_generative.js` declares one anyway and is declared
    // first, so its shape stands; VC-2 must drop the phantom port when it lands.
    // PORTS SYNCED to audio_stubs_vcv_generative.js, which declares this type first — see the header's rule 1.
    inputs: [["pitch", "number"]],
    outputs: [["pitch", "audio"]],
    knobs: [["offset", 0]],
  },
  {
    // ⚠ PORT TYPES ADOPTED FROM `core/audio_stubs_vcv_ambient.js`, NOT INDEPENDENTLY
    // CHOSEN, and the disagreement is on record for the lead. This set first read
    // `TRIG_INPUT`/`TRIG_OUTPUT` as `trigger` and `EXTERNAL_INPUT` as `audio`, which is
    // the mapping `core/audio_specs_vc3a.js` uses for every gate port it shipped (BOOL's
    // and/or/xor, MANUAL's eight outputs, ADDR-SEQ's clock and reset). The ambient set
    // reads all four as `number`/`audio`. `stubRegistry` THREW on the difference — which
    // is the cross-check doing exactly its job — and since that set is declared first and
    // this one may not edit it, its reading stands here. Nothing in these patches is lost
    // by it: `trigger → number` is a legal coercion, so the wires typecheck either way.
    type: "audio_vcv_random", title: "Random", family: "modulation",
    source: "Fundamental/Random", block: "VC-2", corpus: "vcv",
    // PORTS SYNCED to audio_stubs_vcv_ambient.js, which declares this type first — see the header's rule 1.
    inputs: [["rate", "number"], ["shape", "number"], ["trig", "trigger"], ["external", "audio"], ["prob", "number"], ["rand", "number"]],
    outputs: [["stepped", "audio"], ["linear", "audio"], ["smooth", "audio"], ["exponential", "audio"], ["trig", "trigger"]],
    knobs: [["rate", 0], ["shape", 0], ["offset", 0], ["prob", 0], ["rand", 0],
      ["rateCv", 0], ["shapeCv", 0], ["probCv", 0], ["randCv", 0]],
  },

  // ── VC-1 — VCV's Mutable Instruments ports ─────────────────────────────────

  // ── VC-5 — Valley and the large FX ─────────────────────────────────────────

  // ── VC-8 — NYSTHI ──────────────────────────────────────────────────────────
  {
    type: "audio_vcv_attackdecay", title: "Attack Decay", family: "modulation",
    source: "NYSTHI/AttackDecay (ports PROVISIONAL — source not pre-cloned; indices from the cable list)",
    block: "VC-8", corpus: "vcv",
    // ADOPTED from `core/audio_stubs_vcv_generative.js` (declared first): one trigger in,
    // one envelope out. This set had read the cable list's `i3` as the fourth of four
    // inputs; with only one declared, `trig` becomes `trigger` and the wire is the same.
    // PORTS SYNCED to audio_stubs_vcv_generative.js, which declares this type first — see the header's rule 1.
    inputs: [["attack_cv", "number"], ["decay_cv", "number"], ["retrig", "trigger"], ["trig", "trigger"]],
    outputs: [["out", "audio"], ["eoc", "trigger"]],
    knobs: [],
  },
  {
    type: "audio_vcv_polylpg", title: "Poly LPG", family: "filter",
    source: "NYSTHI/PolyLPG (ports PROVISIONAL — source not pre-cloned; indices from the cable list)",
    block: "VC-8", corpus: "vcv",
    inputs: [["in", "audio"], ["cv", "number"]],
    outputs: [["out", "audio"]],
    knobs: [["level", 0], ["response", 0], ["offset", 0]],
  },

  // ── VC-10 — Vult, Instruo, squinkylabs ─────────────────────────────────────
  {
    type: "audio_vcv_wvco", title: "WVCO", family: "source",
    source: "squinkylabs-plug1/squinkylabs-wvco", block: "VC-10", corpus: "vcv",
    inputs: [["voct", "number"], ["fm", "audio"], ["linear_fm", "audio"], ["gate", "trigger"],
      ["sync", "trigger"], ["shape", "number"], ["linear_fm_depth", "number"], ["feedback", "number"]],
    outputs: [["main", "audio"]],
    knobs: [["octave", 0], ["frequencyMultiplier", 0], ["fineTune", 0], ["fmDepth", 0],
      ["linearFmDepth", 0], ["waveshapeGain", 0], ["waveShape", 0], ["feedback", 0], ["outputLevel", 0]],
  },
  {
    type: "audio_vcv_filt", title: "Filt", family: "filter",
    source: "squinkylabs-plug1/squinkylabs-filt", block: "VC-10", corpus: "vcv",
    inputs: [["l_audio", "audio"], ["r_audio", "audio"], ["cv1", "number"], ["cv2", "number"],
      ["q", "number"], ["drive", "number"], ["slope", "number"], ["edge", "number"]],
    outputs: [["l_audio", "audio"], ["r_audio", "audio"]],
    knobs: [["fc", 0], ["q", 0], ["drive", 0], ["edge", 0], ["spread", 0], ["slope", 0],
      ["bassMakeup", 0], ["masterVolume", 0]],
  },
  {
    type: "audio_vcv_lateralus", title: "Lateralus", family: "filter",
    source: "VultModulesFree/Lateralus (ports PROVISIONAL — repo not identified; indices from the cable list)",
    block: "VC-10", corpus: "vcv",
    inputs: [["in", "audio"], ["fc_cv", "number"]],
    outputs: [["out1", "audio"], ["out2", "audio"]],
    knobs: [],
  },
  {
    type: "audio_vcv_ochd", title: "ochd", family: "modulation",
    source: "Instruo/ochd (ports PROVISIONAL — repo not identified; eight taps, indices from the cable list)",
    block: "VC-10", corpus: "vcv",
    // PORTS SYNCED to audio_stubs_vcv_generative.js, which declares this type first — see the header's rule 1.
    inputs: [],
    outputs: [["out1", "audio"], ["out2", "audio"], ["out3", "audio"], ["out4", "audio"], ["out5", "audio"], ["out6", "audio"], ["out7", "audio"], ["out8", "audio"]],
    knobs: [["rate", 0]],
  },
  {
    type: "audio_vcv_athru", title: "athru", family: "effect",
    source: "Instruo/athru (ports PROVISIONAL — repo not identified; indices from the cable list)",
    block: "VC-10", corpus: "vcv",
    inputs: [["in", "audio"], ["fold_cv", "number"], ["symmetry_cv", "number"]],
    outputs: [["out", "audio"], ["thru", "audio"]],
    knobs: [],
  },

  // ── VC-12a / VC-12b — the single-use long tail ─────────────────────────────
  {
    type: "audio_vcv_chordkey", title: "Chord Key", family: "modulation",
    source: "ImpromptuModular/Chord-Key", block: "VC-12a", corpus: "vcv",
    // ENUMS(CV_OUTPUTS, 4) then ENUMS(GATE_OUTPUTS, 4) — a single V/oct index picked a
    // stored chord, and the four CV outputs ARE the voicing. That is the polyphony
    // family "done properly rather than via Merge".
    inputs: [["index", "number"], ["gate", "trigger"]],
    outputs: [...[1, 2, 3, 4].map((n) => [`cv${n}`, "audio"]),
      ...[1, 2, 3, 4].map((n) => [`gate${n}`, "trigger"])],
    knobs: [["index", 0], ["force", 0]],
  },
  {
    type: "audio_vcv_palmloop", title: "Palm Loop", family: "source",
    source: "21kHz/kHzPalmLoop (ports PROVISIONAL — repo not identified; indices from the cable list)",
    block: "VC-12a", corpus: "vcv",
    inputs: [["sync", "trigger"], ["voct", "number"], ["exp_fm", "audio"], ["lin_fm", "audio"]],
    outputs: [["sine", "audio"], ["tri", "audio"], ["saw", "audio"], ["sqr", "audio"], ["main", "audio"]],
    knobs: [["octave", 0]],
  },
  {
    type: "audio_vcv_acfolding", title: "AC Folding", family: "effect",
    source: "AnimatedCircuits/ACFolding (ports PROVISIONAL — repo not identified; indices from the cable list)",
    block: "VC-12a", corpus: "vcv",
    inputs: [["in", "audio"], ["fold_cv", "number"], ["symmetry_cv", "number"]],
    outputs: [["out", "audio"]],
    knobs: [["fold", 0], ["symmetry", 0], ["gain", 0]],
  },
  {
    type: "audio_vcv_clockdivider", title: "Clock Divider", family: "modulation",
    source: "Autodafe/ClockDivider (ports PROVISIONAL — repo not identified; indices from the cable list)",
    block: "VC-7a", corpus: "vcv",
    inputs: [["clock", "trigger"], ["reset", "trigger"]],
    outputs: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`div${n}`, "trigger"]),
    knobs: [],
  },
  {
    // THE HEADLINE NODE OF P19: a Sallen-Key filter whose resonance path is a DIODE
    // CLIPPER, so it self-oscillates and distorts rather than just ringing. No other
    // filter in the corpus has that nonlinearity.
    type: "audio_vcv_ms20vcf", title: "MS-20 VCF", family: "filter",
    source: "LindenbergResearch/MS20_VCF (ports PROVISIONAL — repo not identified; indices from the cable list)",
    block: "VC-12b", corpus: "vcv",
    inputs: [["in", "audio"], ["freq_cv", "number"], ["peak_cv", "number"]],
    outputs: [["out", "audio"]],
    knobs: [["freq", 0], ["peak", 0], ["drive", 0]],
  },
  {
    type: "audio_vcv_polyslew", title: "Poly Slew", family: "modulation",
    source: "stocaudio/Polyslew (ports PROVISIONAL — repo not identified; indices from the cable list)",
    block: "VC-12b", corpus: "vcv",
    inputs: [["in", "audio"], ["rise_cv", "number"], ["fall_cv", "number"]],
    outputs: [["out", "audio"]],
    knobs: [["rise", 0], ["fall", 0]],
  },
  {
    type: "audio_vcv_orbit", title: "Orbit", family: "effect",
    source: "Stoermelder-P1/Orbit (ports PROVISIONAL — source not pre-cloned; indices from the cable list)",
    block: "VC-12b", corpus: "vcv",
    inputs: [["dist_cv", "number"], ["motion_cv", "number"], ["in", "audio"], ["trig", "trigger"]],
    outputs: [["out_l", "audio"], ["out_r", "audio"]],
    knobs: [["dist", 0]],
  },
  {
    type: "audio_vcv_fourseq", title: "Four Seq", family: "modulation",
    source: "dBiz/FourSeq (ports PROVISIONAL — repo not identified; indices from the cable list)",
    block: "VC-12b", corpus: "vcv",
    inputs: [["reset", "trigger"], ["clock_a", "trigger"], ["clock_b", "trigger"]],
    outputs: [["out_a", "audio"], ["out_b", "audio"]],
    // NO KNOBS, and that is a LOSS rather than a choice: P25 stores six non-zero step
    // values on this module (p12=0.396 p13=0.837 p14=0.36 p16=−0.315 p17=−0.549
    // p18=0.693) and without the source there is no way to say which step each index
    // is. Naming them by index would be a guess dressed as a reading. The raw dump is
    // preserved in the patch's `deviations` so the porter has it.
    knobs: [],
  },
  {
    // ⚠ A TYPE-NAME COLLISION THE CONVENTION DOES NOT LIST. `audio_vcv_mix4` is already
    // taken, for real, by `core/audio_specs_vc3a.js`'s BOGAUDIO MIX4 — two different
    // plugins whose model slug lowercases to the same string. The convention's escape
    // hatch is the plugin prefix (it names `bog_lfo`, `bog_adsr`, `bog_vca`, `bog_vcf`,
    // `bog_vco`), and Bogaudio holds the unprefixed name here, so NYSTHI's takes one.
    type: "audio_vcv_nysthi_mix4", title: "NYSTHI Mix4", family: "modulation",
    source: "NYSTHI/mix4 (ports PROVISIONAL — source not pre-cloned; indices from the cable list)",
    block: "VC-8", corpus: "vcv",
    inputs: [...[1, 2, 3, 4].map((n) => [`in${n}`, "audio"]),
      ...[1, 2, 3, 4].map((n) => [`cv${n}`, "number"]), ["master_cv", "number"]],
    outputs: [["out_l", "audio"], ["out_r", "audio"]],
    knobs: [["level1", 0], ["level2", 0], ["level3", 0], ["level4", 0], ["master", 0]],
  },
];
