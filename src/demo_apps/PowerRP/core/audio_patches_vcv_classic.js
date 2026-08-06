/**
 * DEMO PATCHES — VCV Rack — the recognisable instruments.
 *
 * Part of R7-17-SEL's 20 headline patches; see `claude_instructions.md` for the full
 * table and for the user ruling that chose them (*"20 impressive, fully-equipped patches
 * with tons of likes and views"*). The blueprint format, the grid layout rule and the
 * meter/spectrum tail are documented ONCE in `core/audio_patches.js` — read that file's
 * header before adding anything here. The aggregation contract is in
 * `core/audio_patch_sets.js`.
 *
 * THIS SET REBUILDS:
 *   - P8  Borealis / Generative Kosmische — patchstorage 184456, SATURATA, 920 dl / 43 likes, 30 distinct
 *   - P19 Korg MS-20 Full System — patchstorage 116910, litpnm, 1458 dl / 4671 views, 29 distinct
 *   - P20 FM Pad, free modules only — patchstorage 142616, Omri_Cohen, 679 dl, 17 distinct
 *   - P25 Moog Subharmonicon in VCV — patchstorage 124856, Omri_Cohen, 3391 dl / 66 likes, 20 distinct
 *
 * Every blueprint here carries `source` (the harvested file, its author, its popularity
 * figures, its distinct-module count) and `deviations` (what we did NOT reproduce, and
 * why) — an UNRECORDED substitution is the silent divergence R7-17-SEL exists to prevent.
 *
 * A node this set needs but the library does not yet have is a PLACEHOLDER, declared in
 * the companion `core/audio_stubs_vcv_classic.js`. Read `core/audio_stub_nodes.js` first:
 * a placeholder carries the FINAL type name and the FINAL port names, so the wire written
 * here today is the wire the real module gets.
 *
 * ── EVERY DIAL VALUE HERE IS CONVERTED, NOT COPIED (§ R7-UNITS) ──────────────
 * A `.vcv` file stores the RAW stored float of each param, which is a Rack voltage for a
 * CV and a knob position for everything else. R7-UNITS fixes what our wires carry: an
 * `audio` wire is ±1 = ±5 V (divide by five), a `number` wire is the quantity's REAL unit
 * (hertz, seconds, 0..1), a V/oct port is SEMITONES (×12 volts) and a gate is 0..1. So a
 * raw value copied across would land silently and be wrong the day the real module
 * arrives. Each conversion used here is written beside the value with its arithmetic:
 *
 *   Bogaudio segments (FM-OP, AD, DADSR(H))  seconds = raw² · 10, or · 100 with Speed slow
 *   Bogaudio LFO / LLFO rate                 hz = 261.626 · 2^(raw − 7), or − 11 when Slow
 *                                            (CONFIRMED at `lfo_base.cpp:30-37` —
 *                                            `getPitchOffset` is −3−4 normal, −3−8 slow —
 *                                            so LLFO shares LFO's map, which is why
 *                                            VC-3a's stated formula applies to both)
 *   Bogaudio VCO / LVCO pitch                hz = 261.626 · 2^raw
 *   FM-OP ratio                              raw < 0 → max(1+raw, 0.01); raw ≥ 0 → 1 + 9·raw
 *   FM-OP fine                                cents = raw · 100
 *   JW SimpleClock tempo                      bpm = 2^raw · 60 (its own `configParam`
 *                                            declares displayBase 2, multiplier 60)
 *   dbRackModules SPF cutoff                  hz = 2^raw (its knob is a log2 exponent)
 *   an attenuverter shown in %                fraction = raw / 2  (its ±2 rail is ±100 %)
 *
 * WHERE THE RAW→REAL MAPPING IS GENUINELY UNKNOWN — a module whose source was not
 * available, or a knob whose display transform is not in the file — THE KNOB IS NOT SET
 * AND THE RAW DUMP GOES IN `deviations` VERBATIM. Guessing a unit is the failure the
 * ruling exists to stop; writing the raw number onto a real-unit knob is the same failure
 * with a number attached. The dump is what the porter needs, and it is not lost.
 *
 * ── THE THREE THINGS OUR GRAPH CANNOT EXPRESS, STATED ONCE ───────────────────
 * (`core/audio_patches_vcv_ambient.js` states the same three; each patch below names its
 * own instances rather than leaving the reader to infer the rule.)
 *   1. FAN-IN — a connection is keyed BY ITS INPUT PORT, so a second wire to one input
 *      REPLACES the first. Rack allows several; fan-in needs a Mixer.
 *   2. CYCLES — `connectionRefusal` refuses a wire closing a loop in the data graph, and
 *      the layout law additionally requires every wire to run left-to-right. P25's PWM
 *      cross-modulation is a real cycle and is the one place this cost a module.
 *   3. STEREO — `audio_output` has one input, so a stereo pair is summed at the end and a
 *      module that exists only to place sound in a stereo field has nothing to do.
 */

/**
 * The analysis tail every patch ends with, at a given column. RE-STATED HERE rather than
 * imported: `core/audio_patch_sets.js` forbids a set from importing `core/audio_patches.js`
 * (that is the cycle the seam exists to break), and the tail lives there as a module-private
 * const. Spelled with the SAME names as the house one and as the other sets' copies so the
 * duplication is greppable instead of disguised — hoisting it into a leaf module every side
 * imports is the right fix and is a one-line change in eight files, which is the lead's
 * call, not a set's.
 */
const analysisTail = (col, row = 0) => [
  { id: "meter", type: "audio_meter", col, row },
  { id: "spectrum", type: "audio_spectrum", col: col + 1, row },
  { id: "out", type: "audio_output", col: col + 2, row, knobs: { volume: 0.7 } },
];

/** …and the wires that chain it. `from` is the module feeding the tail. */
const analysisWires = (from) => [
  { from, fromPort: "out", to: "meter", toPort: "in" },
  { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
  { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
];

/**
 * P25 — MOOG SUBHARMONICON IN VCV. The most-downloaded patch in the whole selection
 * (3391 dl / 66 likes / 4800 views) and the most instantly recognisable sound in it.
 *
 * ── WHAT MAKES IT WORTH THIRTEEN PLACEHOLDERS ───────────────────────────────
 * A Subharmonicon is TWO IDEAS AT ONCE, and both are integer division:
 *
 *   1. TRUE SUBHARMONICS. Each oscillator's own waveform is fed to two
 *      `VCFrequencyDividerMkII` units, which divide its FREQUENCY by an integer —
 *      2, 1, 5, 2 here. That is not a transposed copy and not a sub-oscillator with a
 *      fixed −1 octave: dividing by 3 puts a partial a twelfth below at exactly 1/3 the
 *      frequency, which is the undertone series. Nothing else in the corpus does this,
 *      and it is why the patch justifies eight instances of one module.
 *   2. A POLYRHYTHM MADE THE SAME WAY. The clock is divided by 3, 5, 6 and 7 by four MORE
 *      dividers, whose pulses are edge-detected (`OctaTrig`) and routed onto two gate
 *      buses. Because 3, 5, 6 and 7 share almost no factors, the two buses re-align only
 *      every 210 beats — the pattern is 210 bars long without a single stored step.
 *
 * THE SIGNAL PATH: SimpleClock → four dividers → OctaTrig → BusRoute2 → FourSeq → a
 * quantizer → an 8×8 matrix that sprays the sequence at both oscillators' pitch AND at
 * four division-CV inputs → two EvenVCOs → A/B switches → four subharmonic dividers →
 * two mixers → crossfade → Vult ladder filter → VCA → out. The two gate buses also drive
 * a Bool OR into two envelopes: one opens the filter, the other opens the VCA.
 *
 * WHY THE SEQUENCE REACHES THE DIVIDERS AND NOT ONLY THE OSCILLATORS: `Switch88` out 2, 3,
 * 5 and 6 land on `Division CV`. So the sequencer is not only choosing notes, it is
 * choosing WHICH UNDERTONE each divider produces. That is the module's real trick and it
 * is why the harvested matrix (three closed crosspoints of sixty-four) is load-bearing
 * rather than incidental.
 */
export const VCV_SUBHARMONICON = {
  id: "vcv-subharmonicon",
  title: "VCV Subharmonicon",
  help: "The Moog Subharmonicon, rebuilt: eight integer FREQUENCY DIVIDERS produce true undertones (÷2, ÷1, ÷5, ÷2) while four more divide the clock by 3, 5, 6 and 7 into a polyrhythm that repeats only every 210 beats. Turn a Divide By knob and you are choosing a different partial of the undertone series, not transposing a copy.",
  source: {
    patch: "patchstorage 124856", file: "Subharmonicon in VCV.vcv",
    author: "Omri_Cohen", popularity: "3391 dl / 66 likes / 4800 views",
    distinct: 20, families: ["integer frequency division", "polyrhythmic sequencing"],
  },
  deviations: [
    "SubmarineFree/TD-202 x6 dropped — they are TEXT LABELS ('Sequencer', 'Polyrhythm', 'Oscillators', 'PWM Switch', 'Filter', 'Envelopes'), decoration with no ports.",
    "Stoermelder-P1/Glue dropped — a panel-annotation overlay, not a sound.",
    "Core/AudioInterface substituted by our audio_output — identical role, and multiple outputs already sum.",
    "GlueTheGiant/BusDepot dropped — stereo bus plumbing with a level fader. Our bus is mono and outputs sum, so the VCA reaches the analysis tail directly.",
    "Bogaudio-Switch44 DROPPED, AND THIS ONE IS A REAL LOSS: it took both first subharmonic dividers and returned them to the two EvenVCOs' Pulse-Width inputs. That closes a directed CYCLE (Switch44 -> EvenVCO -> Bogaudio-Switch -> divider -> Switch44) which core/nodeflow.connectionRefusal refuses, and the left-to-right layout law forbids the backwards wire independently. Dropping either PWM return still leaves a cycle through the other oscillator, so BOTH had to go, which leaves the matrix with no destination. The subharmonics themselves are untouched; what is missing is the pulse-width cross-modulation that adds movement to the two square waves.",
    "CountModula/Mixer x2 substituted by our audio_mixer — four inputs, one level each, one master. Identical semantics; its Mode switch (raw 1.0) has no counterpart and is lost.",
    "Fundamental/VCA-1 substituted by our audio_vca — signal in, gain in, product out. Its Response-mode switch (raw 1.0, exponential) is lost.",
    "R7-UNITS conversions applied: SimpleClock's tempo knob is bpm = 2^raw x 60, so raw 2.728 is 397.3 BPM (it rides the placeholder's declared default because a BPM leaves the +/-10 V rail); the four subharmonic dividers' 'CV Amount' is an attenuverter displayed in %, so raw 2.0 is 1.0 = full depth; every Divide By is an integer and needs no conversion.",
    "dBiz/FourSeq has NO knobs on its placeholder and that is a loss, not a choice: the patch stores six non-zero step values (p12=0.396 p13=0.837 p14=0.36 p16=-0.315 p17=-0.549 p18=0.693) and dBiz's source was not available, so which step each index is cannot be read. Naming them by index would be a guess dressed as a reading. VC-12b must reinstate them.",
"NYSTHI/AttackDecay's placeholder carries its dials under RAW INDEX names (`p0`, `p1`), which core/audio_stubs_vcv_generative.js declared first and which this set adopted: nysthi was not pre-cloned, so no param name could be read. The two harvested envelopes are p1=0.106 (the filter's, short) and p1=0.292 (the amp's, longer); their p3=1.0 and p4=0.5 have no declared key and are recorded here only. VultModulesFree/Lateralus keeps NO dials at all — its repo is not identified — and its harvested set was p0=0.3295 p1=0.426 p2=0.555 p4=0.6, which is presumably cutoff, resonance and two attenuverters.",
  ],
  nodes: [
    // ── THE POLYRHYTHM: one clock, divided four ways by coprime integers ──────
    { id: "clock", type: "audio_vcv_simpleclock", col: 0, row: 0 },
    { id: "pdiv3", type: "audio_vcv_vcfrequencydividermkii", col: 1, row: 0, knobs: { divide: 3, cvAmount: 0 } },
    { id: "pdiv5", type: "audio_vcv_vcfrequencydividermkii", col: 1, row: 2, knobs: { divide: 5, cvAmount: 0 } },
    { id: "pdiv6", type: "audio_vcv_vcfrequencydividermkii", col: 1, row: 4, knobs: { divide: 6, cvAmount: 0 } },
    { id: "pdiv7", type: "audio_vcv_vcfrequencydividermkii", col: 1, row: 6, knobs: { divide: 7, cvAmount: 0 } },
    // Each divider emits a slow UNIPOLAR square; OctaTrig turns each into an edge.
    { id: "edges", type: "audio_vcv_octatrig", col: 2, row: 0 },
    // …which BusRoute2 routes onto two gate buses. Only two crosspoints are closed in
    // the harvested patch (busA1, busB2), so buses A and B carry the ÷3 and ÷5 pulses.
    { id: "buses", type: "audio_vcv_busroute2", col: 3, row: 0, knobs: { busA1: 1, busB2: 1 } },
    { id: "seq", type: "audio_vcv_fourseq", col: 4, row: 0 },
    // THE TWO BUSES ALSO FIRE THE ENVELOPES, through an OR — so a note happens on either
    // bus's pulse, which is what makes the polyrhythm audible as rhythm rather than as
    // pitch drift.
    { id: "orgate", type: "audio_vcv_bool", col: 4, row: 8 },
    { id: "envFilter", type: "audio_vcv_attackdecay", col: 5, row: 8, knobs: { p1: 0.106 } },
    { id: "envAmp", type: "audio_vcv_attackdecay", col: 5, row: 10, knobs: { p1: 0.292 } },
    { id: "quant", type: "audio_vcv_rewin", col: 5, row: 0 },
    // THE 8x8 MATRIX. Three crosspoints of sixty-four are closed, and they are what makes
    // the patch: in1 reaches out1 (oscillator 1's pitch) and out6 (divider 8's division
    // CV), in2 reaches out4 (oscillator 2's pitch).
    { id: "matrix", type: "audio_vcv_switch88", col: 6, row: 0, knobs: { mix11: 1, mix16: 1, mix24: 1 } },
    // ── THE TWO VOICES ───────────────────────────────────────────────────────
    { id: "vco1", type: "audio_vcv_evenvco", col: 7, row: 0 },
    { id: "vco2", type: "audio_vcv_evenvco", col: 7, row: 5, knobs: { octave: 1 } },
    // A LATCHED A/B switch per voice — square or sawtooth, chosen by a gate.
    { id: "wave1", type: "audio_vcv_switch", col: 8, row: 0, knobs: { latch: "on" } },
    { id: "wave2", type: "audio_vcv_switch", col: 8, row: 5, knobs: { latch: "on" } },
    // ── THE SUBHARMONICS. This is the patch. ─────────────────────────────────
    { id: "sub1a", type: "audio_vcv_vcfrequencydividermkii", col: 9, row: 0, knobs: { divide: 2, cvAmount: 1 } },
    { id: "sub1b", type: "audio_vcv_vcfrequencydividermkii", col: 9, row: 2, knobs: { divide: 1, cvAmount: 1 } },
    { id: "sub2a", type: "audio_vcv_vcfrequencydividermkii", col: 9, row: 5, knobs: { divide: 5, cvAmount: 1 } },
    { id: "sub2b", type: "audio_vcv_vcfrequencydividermkii", col: 9, row: 7, knobs: { divide: 2, cvAmount: 1 } },
    // Each voice is its own fundamental plus its two undertones, balanced by hand.
    { id: "mix1", type: "audio_mixer", col: 10, row: 0, knobs: { level1: 0.6745, level2: 0.7175, level3: 0.5, level4: 0.5, master: 1 } },
    { id: "mix2", type: "audio_mixer", col: 10, row: 5, knobs: { level1: 0.644, level2: 0.5, level3: 0.6995, level4: 0.5, master: 1 } },
    { id: "blend", type: "audio_vcv_xfade", col: 11, row: 0, knobs: { curve: 0.5 } },
    { id: "ladder", type: "audio_vcv_lateralus", col: 12, row: 0 },
    { id: "vca", type: "audio_vca", col: 13, row: 0, knobs: { gain: 1 } },
    ...analysisTail(14),
  ],
  wires: [
    // ONE CLOCK, FOUR COPRIME DIVISORS. `trigger → audio` is a legal coercion (a gate
    // reads as 1 while high), which is what lets a clock pulse be the signal a frequency
    // divider divides.
    { from: "clock", fromPort: "clock", to: "pdiv3", toPort: "div" },
    { from: "clock", fromPort: "clock", to: "pdiv5", toPort: "div" },
    { from: "clock", fromPort: "clock", to: "pdiv6", toPort: "div" },
    { from: "clock", fromPort: "clock", to: "pdiv7", toPort: "div" },
    { from: "pdiv3", fromPort: "divu", to: "edges", toPort: "in1" },
    { from: "pdiv5", fromPort: "divu", to: "edges", toPort: "in2" },
    { from: "pdiv6", fromPort: "divu", to: "edges", toPort: "in3" },
    { from: "pdiv7", fromPort: "divu", to: "edges", toPort: "in4" },
    { from: "edges", fromPort: "up1", to: "buses", toPort: "gate1" },
    { from: "edges", fromPort: "up2", to: "buses", toPort: "gate2" },
    { from: "edges", fromPort: "up3", to: "buses", toPort: "gate3" },
    { from: "edges", fromPort: "up4", to: "buses", toPort: "gate4" },
    { from: "buses", fromPort: "a", to: "seq", toPort: "clock_a" },
    { from: "buses", fromPort: "b", to: "seq", toPort: "clock_b" },
    { from: "clock", fromPort: "reset", to: "seq", toPort: "reset" },
    { from: "seq", fromPort: "out_a", to: "quant", toPort: "in_1" },
    { from: "seq", fromPort: "out_b", to: "quant", toPort: "in_2" },
    { from: "quant", fromPort: "out_1", to: "matrix", toPort: "in1" },
    { from: "quant", fromPort: "out_2", to: "matrix", toPort: "in2" },
    // THE MATRIX SPRAYS THE SEQUENCE AT SIX DESTINATIONS: two pitches and four division
    // CVs. The four division wires are the difference between a Subharmonicon and a
    // two-oscillator drone.
    { from: "matrix", fromPort: "out1", to: "vco1", toPort: "pitch2" },
    { from: "matrix", fromPort: "out2", to: "sub1a", toPort: "cv" },
    { from: "matrix", fromPort: "out3", to: "sub1b", toPort: "cv" },
    { from: "matrix", fromPort: "out4", to: "vco2", toPort: "pitch2" },
    { from: "matrix", fromPort: "out5", to: "sub2a", toPort: "cv" },
    { from: "matrix", fromPort: "out6", to: "sub2b", toPort: "cv" },
    // Square on the switch's HIGH input, sawtooth on its LOW — the gate picks the timbre.
    { from: "vco1", fromPort: "square", to: "wave1", toPort: "high1" },
    { from: "vco1", fromPort: "saw", to: "wave1", toPort: "low1" },
    { from: "vco2", fromPort: "square", to: "wave2", toPort: "high1" },
    { from: "vco2", fromPort: "saw", to: "wave2", toPort: "low1" },
    // ONE WAVEFORM FEEDS ITS OWN TWO DIVIDERS *AND* THE MIXER, so each voice is heard as
    // its fundamental plus two undertones rather than as the undertones alone.
    { from: "wave1", fromPort: "out1", to: "sub1a", toPort: "div" },
    { from: "wave1", fromPort: "out1", to: "sub1b", toPort: "div" },
    { from: "wave1", fromPort: "out1", to: "mix1", toPort: "in1" },
    { from: "sub1a", fromPort: "divb", to: "mix1", toPort: "in2" },
    { from: "sub1b", fromPort: "divb", to: "mix1", toPort: "in3" },
    { from: "wave2", fromPort: "out1", to: "sub2a", toPort: "div" },
    { from: "wave2", fromPort: "out1", to: "sub2b", toPort: "div" },
    { from: "wave2", fromPort: "out1", to: "mix2", toPort: "in1" },
    { from: "sub2a", fromPort: "divb", to: "mix2", toPort: "in2" },
    { from: "sub2b", fromPort: "divb", to: "mix2", toPort: "in3" },
    { from: "mix1", fromPort: "out", to: "blend", toPort: "a" },
    { from: "mix2", fromPort: "out", to: "blend", toPort: "b" },
    // THE GATE BUSES DRIVE THE ENVELOPES. Either bus's pulse fires both — one opens the
    // filter, the other opens the VCA, which is why the note has a shape at all.
    { from: "buses", fromPort: "a", to: "orgate", toPort: "a" },
    { from: "buses", fromPort: "b", to: "orgate", toPort: "b" },
    { from: "orgate", fromPort: "or", to: "envFilter", toPort: "trig" },
    { from: "orgate", fromPort: "or", to: "envAmp", toPort: "trig" },
    { from: "blend", fromPort: "out", to: "ladder", toPort: "in" },
    { from: "envFilter", fromPort: "out", to: "ladder", toPort: "fc_cv" },
    { from: "ladder", fromPort: "out2", to: "vca", toPort: "in" },
    { from: "envAmp", fromPort: "out", to: "vca", toPort: "gain" },
    ...analysisWires("vca"),
  ],
};

/**
 * P19 — KORG MS-20 FULL SYSTEM, from free modules only (1458 dl / 4671 views).
 *
 * ── WHY IT IS HERE: ONE FILTER NO OTHER FILTER IN THE CORPUS CAN IMITATE ────
 * `LindenbergResearch/MS20_VCF` is a Sallen-Key topology whose resonance path runs
 * through a DIODE CLIPPER. Turn Peak up and it does not merely ring: the clipper limits
 * the feedback and the filter SELF-OSCILLATES into a squashed, slightly sour sine, and
 * loud input SAGS the resonance instead of blowing up. That nonlinearity is the MS-20's
 * whole reputation and nothing else in these twenty patches has it.
 *
 * ── THE MS-20's ARCHITECTURE, AS THE PATCH DRAWS IT ─────────────────────────
 * Two oscillators, each offered as several waveforms to an 8:1 SELECTOR — that is how a
 * free-module rebuild reproduces the MS-20's per-oscillator waveform SWITCH, and it is
 * why there are two 8:1s rather than a mixer. Oscillator 2's Square is XOR'd against
 * oscillator 1's to give the MS-20's ring-modulator-ish extra timbre. The two selections
 * are summed in a VCM whose mix level is opened by the envelope, so the ENVELOPE IS THE
 * VCA — the MS-20 has no separate one. That sum feeds the diode filter, and in parallel a
 * low-pass GATE (whose control is the mod wheel) feeds a second reverb; an A/B switch
 * chooses which of the two paths is heard.
 *
 * ── THE MIDI MAPPING, WHICH IS A REAL DECISION AND NOT A DETAIL ────────────
 * `Core/MIDIToCVInterface` is not a node in our world: live playing IS our keyboard.
 * Its `1V/octave pitch` becomes `node_keyboard.pitch` and its `Gate` becomes
 * `node_keyboard.gate`. Its `Mod wheel` has no counterpart, and dropping it would have
 * killed the low-pass gate's entire control — so it becomes a `node_knob`, which is the
 * honest surface for a continuous hand control and is playable while the patch runs.
 */
export const VCV_MS20 = {
  id: "vcv-ms20",
  title: "VCV Korg MS-20",
  help: "A complete Korg MS-20 from free modules. The filter is the point: a Sallen-Key design whose resonance runs through a DIODE CLIPPER, so high Peak self-oscillates into a squashed sine instead of ringing cleanly. Play the keyboard; turn the Knob (the MS-20's mod wheel) to open the low-pass gate feeding the second reverb.",
  source: {
    patch: "patchstorage 116910", file: "MS-20-All-Free-Modules-No-External-Signal-Processing.vcv",
    author: "litpnm", popularity: "1458 dl / 10 likes / 4671 views",
    distinct: 29, families: ["physical modelling (diode-clipper VCF)", "FDN/plate reverb", "polyphony / voice allocation"],
  },
  deviations: [
    "Core/MIDIToCVInterface substituted by node_keyboard + node_knob — pitch and gate map one-to-one; its MOD WHEEL has no counterpart, so the low-pass gate's control becomes a hand Knob rather than being dropped. Its Velocity output is unused by this patch, so nothing is lost there.",
    "SubmarineFree/TD-202 x22 dropped — text labels. Core/Notes and Chiptuner/Blank1HP dropped — a notepad and a blank panel.",
    "CatroModulo/CatroModulo_CM-6, Bogaudio-SampleHold and NYSTHI/NYSTHIOMETER dropped: all three are present in the rack and WIRED TO NOTHING in the harvested file. Reproducing an unwired module would put three cards on the canvas contributing nothing.",
    "Bogaudio-DADSRH#1 dropped for the same reason — both its Envelope and Inverted outputs are unwired, so it is a dead branch. Only #2 (the one that opens the VCM) is rebuilt. Its harvested dials, converted, are recorded below in case a future reader wonders where the second envelope went: attack 21.8 s, release 57.4 s, hold 20.0 s (raw 0.4665 / 0.7575 / 0.4472, Speed slow so seconds = raw^2 x 100).",
    "VultModulesFree/UtilSend x2 dropped — a send/return pair with no aux bus in our engine. The chain they wrapped becomes the SERIES chain it effectively was: mixer -> Plateau -> Chronoblob2 -> tail. What is lost is the dry/wet balance the sends provided.",
    "LindenbergResearch/VCSpread dropped — it exists to place a mono signal in a stereo field, and our tail is mono (audio_output has one input), so it has nothing to do.",
    "AS/StereoVUmeter substituted by our audio_meter, and Core/AudioInterface by audio_output.",
    "Fundamental/VCMixer substituted by audio_mixer — four inputs, per-channel level, master. Identical semantics. Its harvested channel levels (all 1.0) and Mix level 0.178 carry across.",
    "Fundamental/Noise substituted by audio_noise on 'white' — the patch uses only the White output, which is exactly what our noise source is.",
    "R7-UNITS: Bogaudio-Stack's Semitones is ALREADY semitones (3, a minor third), so it copies unchanged — that is the clause-3 unit, not a coincidence. EvenVCO Octave (-3) is an octave count and Pulse width (1.0) is a normalized +/-1, both unconverted. The Bogaudio VCA's two levels (0.0015, 0.0075) are 0..1 normalized: a deliberately tiny vibrato depth, and copying them raw here is correct precisely because they are not volts.",
    "DADSR(H)'s envelope times are NOT SET and the reason is a real blocker worth fixing: converted to seconds they are decay 100 s, hold 20 s, and STUB_RANGES.vcv is +/-10 because it was written as a VOLT rail. Under R7-UNITS a `number` knob carries the REAL unit, so a seconds knob legitimately reaches 100 and the rail now rejects legal values — the one thing core/audio_stub_nodes.js says the scaffold must never do. The harvested set, converted: delay 0.011 s, decay 100 s, sustain 0.393, release 0.002 s, hold 20 s, mode gated, loop on, retrigger reset, all three shapes linear.",
    "MS20_VCF, PolyLPG, XFXF35 and Polyslew keep no dials — their sources are in survey_vcv.md § 7's not-indexed list, so neither their param names nor their display transforms could be read, and a guessed unit is exactly what R7-UNITS forbids. The raw dumps: MS20_VCF p0=0.5815 p1=0.543 p6=1.0; PolyLPG p0=0.604 p1=0.5 p2=0.5 (mode 0, vactrol speed 1); XFXF35 p1=0.5 p2=0.3205 p3=0.5 p5=0.5 p6=1.0 (mode 17).",
    "Plateau's dials are carried RAW, matching core/audio_stubs_vcv_ambient.js which declared this shared placeholder first with raw defaults. Its four damping knobs run 0..10 in Rack with 10 meaning fully open and have no established real unit; VC-5 must convert both patch sets in one sweep rather than have them disagree.",
  ],
  nodes: [
    { id: "keys", type: "node_keyboard", col: 0, row: 0, w: 196, knobs: { baseNote: 36, octaves: 2 } },
    // A fixed transposition, then a SLEW — the MS-20's portamento.
    { id: "stack", type: "audio_vcv_stack", col: 1, row: 0, knobs: { semitones: 3, quantize: "on" } },
    { id: "env", type: "audio_vcv_dadsrh", col: 1, row: 6, knobs: { delay: 0.011, attack: 0, decay: 100, sustain: 0.393, release: 0.002, hold: 20, mode: "gated", loop: "loop", retrigger: "reset", attackShape: "linear", decayShape: "linear", releaseShape: "linear" } },
    { id: "lfo", type: "audio_vcv_bog_lfo", col: 1, row: 12, knobs: { scale: 1 } },
    { id: "glide", type: "audio_vcv_polyslew", col: 2, row: 0 },
    // THE VIBRATO DEPTH IS 0.15% AND 0.75%, which is why it reads as life rather than
    // as a wobble. Two channels so the two oscillators get different amounts.
    { id: "vibrato", type: "audio_vcv_bog_vca", col: 2, row: 12, knobs: { level1: 0.0015, level2: 0.0075 } },
    // A DC SOURCE, not a modulator: one offset sets both pulse widths and the XOR's
    // inverter threshold, which is how a static asymmetry is drawn as a patch.
    { id: "offset", type: "audio_vcv_offset", col: 2, row: 18, knobs: { offset: -0.491, scale: 0.1812 } },
    { id: "vco1", type: "audio_vcv_evenvco", col: 3, row: 0, knobs: { octave: -3, pw: 1 } },
    { id: "vco2", type: "audio_vcv_evenvco", col: 3, row: 6, knobs: { octave: -3, pw: 1 } },
    { id: "ring", type: "audio_vcv_booleanxor", col: 4, row: 0 },
    { id: "noise", type: "audio_noise", col: 4, row: 6, knobs: { color: "white", level: 0.5 } },
    // THE TWO WAVEFORM SELECTORS. This is the MS-20's per-oscillator waveform switch,
    // built from an addressed 8:1 — which is also why Select is a knob you can turn.
    { id: "sel1", type: "audio_vcv_eightone", col: 5, row: 0, knobs: { steps: 8, direction: "forward", select: 1 } },
    { id: "sel2", type: "audio_vcv_eightone", col: 5, row: 6, knobs: { steps: 8, direction: "forward" } },
    { id: "modwheel", type: "node_knob", col: 5, row: 18, knobs: { value: 0.5, min: 0, max: 1, step: 0.01 } },
    // THE ENVELOPE OPENS THE MIXER, not a VCA — the MS-20 has no separate VCA and this
    // rebuild is faithful about it.
    { id: "vcm", type: "audio_vcv_vcm", col: 6, row: 0, knobs: { level1: 0.615, level2: 0.6285, level3: 0.8, level4: 0.8, mix: 0.8, taper: "linear" } },
    { id: "lpg", type: "audio_vcv_polylpg", col: 6, row: 18 },
    { id: "vcf", type: "audio_vcv_ms20vcf", col: 7, row: 0 },
    { id: "ladder", type: "audio_vcv_xfxf35", col: 7, row: 18, knobs: { mode: "ladder_hp12" } },
    // A/B: the diode filter, or the low-pass gate through the second reverb.
    { id: "path", type: "audio_vcv_switch", col: 8, row: 0, knobs: { latch: "on" } },
    { id: "mixer", type: "audio_mixer", col: 9, row: 0, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 0.178 } },
    { id: "plate", type: "audio_vcv_plateau", col: 10, row: 0, knobs: { dry: 1, input_low_damp: 10, input_high_damp: 10, size: 0.425, diffusion: 7.045, decay: 0.55, reverb_high_damp: 10, reverb_low_damp: 10, mod_shape: 0.5, mod_depth: 0.5, diffuse: "on" } },
    { id: "echo", type: "audio_vcv_chronoblob2", col: 11, row: 0, knobs: { delay: "dual", prescaler: 6 } },
    ...analysisTail(12),
  ],
  wires: [
    { from: "keys", fromPort: "pitch", to: "stack", toPort: "in" },
    { from: "stack", fromPort: "out", to: "glide", toPort: "in" },
    // ONE SLEWED PITCH DRIVES BOTH OSCILLATORS — that is what makes them one instrument.
    { from: "glide", fromPort: "out", to: "vco1", toPort: "pitch2" },
    { from: "glide", fromPort: "out", to: "vco2", toPort: "pitch2" },
    { from: "lfo", fromPort: "triangle", to: "vibrato", toPort: "in1" },
    { from: "lfo", fromPort: "triangle", to: "vibrato", toPort: "in2" },
    { from: "vibrato", fromPort: "out1", to: "vco1", toPort: "fm" },
    { from: "vibrato", fromPort: "out2", to: "vco2", toPort: "fm" },
    { from: "offset", fromPort: "out", to: "vco1", toPort: "pwm" },
    { from: "offset", fromPort: "out", to: "vco2", toPort: "pwm" },
    { from: "offset", fromPort: "out", to: "ring", toPort: "i" },
    { from: "vco1", fromPort: "square", to: "ring", toPort: "a" },
    { from: "vco2", fromPort: "square", to: "ring", toPort: "b" },
    // OSCILLATOR 1 OFFERS THREE WAVEFORMS AND NOISE to its selector; oscillator 2 offers
    // two plus the XOR. Selecting rather than mixing is the MS-20's own switch.
    { from: "vco1", fromPort: "tri", to: "sel1", toPort: "in1" },
    { from: "vco1", fromPort: "saw", to: "sel1", toPort: "in2" },
    { from: "vco1", fromPort: "square", to: "sel1", toPort: "in3" },
    { from: "noise", fromPort: "out", to: "sel1", toPort: "in4" },
    { from: "vco2", fromPort: "saw", to: "sel2", toPort: "in1" },
    { from: "vco2", fromPort: "square", to: "sel2", toPort: "in2" },
    { from: "ring", fromPort: "xor", to: "sel2", toPort: "in3" },
    { from: "sel1", fromPort: "out", to: "vcm", toPort: "in1" },
    { from: "sel2", fromPort: "out", to: "vcm", toPort: "in2" },
    { from: "keys", fromPort: "gate", to: "env", toPort: "trigger" },
    // THE ENVELOPE IS THE VCA: it opens the VCM's mix level, which is the only amplitude
    // control in the whole voice.
    { from: "env", fromPort: "env", to: "vcm", toPort: "mix_cv" },
    { from: "vcm", fromPort: "mix", to: "vcf", toPort: "in" },
    { from: "lfo", fromPort: "triangle", to: "vcf", toPort: "freq_cv" },
    // THE PARALLEL PATH: the same sum through the second reverb, plus a low-pass gate
    // whose control is the mod wheel.
    { from: "vcm", fromPort: "mix", to: "ladder", toPort: "in" },
    { from: "lfo", fromPort: "triangle", to: "lpg", toPort: "in" },
    { from: "modwheel", fromPort: "out", to: "lpg", toPort: "cv" },
    { from: "lpg", fromPort: "out", to: "ladder", toPort: "frequency" },
    { from: "vcf", fromPort: "out", to: "path", toPort: "low2" },
    { from: "ladder", fromPort: "out", to: "path", toPort: "high1" },
    { from: "path", fromPort: "out1", to: "mixer", toPort: "in1" },
    { from: "path", fromPort: "out2", to: "mixer", toPort: "in2" },
    { from: "mixer", fromPort: "out", to: "plate", toPort: "in_l" },
    { from: "plate", fromPort: "out_l", to: "echo", toPort: "in_l" },
    { from: "echo", fromPort: "out_l", to: "meter", toPort: "in" },
    { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
    { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
  ],
};

/**
 * P20 — FM PAD, free modules only (679 dl / 20 likes). Three FM operators, two
 * through-zero wavetable oscillators and a morphing wavetable voice, played from a
 * keyboard, into a plate reverb.
 *
 * ── THE ONE RELATIONSHIP THAT IS THE WHOLE PATCH, AND WHERE IT LIVES ────────
 * In FM, the MODULATOR's envelope decides the TIMBRE and the carrier's decides the
 * LOUDNESS. If the modulator outlives the carrier the note gets brighter as it dies,
 * which sounds synthetic; if it dies first the note starts metallic and PURIFIES into a
 * sine, which is what a struck bell or a plucked string actually does. In this file the
 * relationship is carried by three release times and one switch:
 *
 *   carrier  (FM-OP #1)  release 1.251 s   AND `Level follows envelope` ON
 *   modulator (FM-OP #2) release 1.0 s
 *   modulator (FM-OP #3) release 1.0 s
 *
 * So the two modulators fall silent a quarter of a second before the carrier does, and
 * only the carrier's envelope is routed to its own level. IF A REBUILD LOSES THAT — if
 * all three releases end up equal — the patch still plays and has no character, which is
 * exactly the silent failure R7-17-SEL is about. The survey states this as "the index
 * envelope is shorter than the amplitude envelope"; the file expresses it as those
 * numbers, and they are converted from Rack raw here (seconds = raw² · 10, so #1's 0.3537
 * is 1.251 s and #2/#3's 0.3162 is 1.0 s).
 *
 * ── THE TWO OTHER VOICES, AND WHY THEY ARE NOT DECORATION ──────────────────
 * squinkylabs WVCO does THROUGH-ZERO linear FM with a real anti-aliasing stage, which is
 * the thing an ordinary exponential-FM oscillator cannot do: at high index the modulated
 * frequency goes NEGATIVE and a through-zero oscillator keeps phase instead of folding,
 * so the tone stays in tune. WVCO #2 modulates WVCO #1's linear-FM input through a VCA —
 * that is the through-zero path, drawn. Valley Terrorform is a wavetable oscillator whose
 * frame is chosen per sample by a CV, so a random walk on its Wave input makes the
 * timbre drift without anything repeating.
 *
 * FOUR RANDOM WALKS DRIVE FOUR DIFFERENT THINGS: the FM depth, the LFO's own rate, the
 * wavetable frame, and the master level plus the filter cutoff. Nothing in the patch is
 * periodic, which is why a pad made of three envelopes never sounds like a loop.
 */
export const VCV_FM_PAD = {
  id: "vcv-fm-pad",
  title: "VCV FM Pad",
  help: "An FM pad from free modules: three FM operators stacked, two through-zero wavetable oscillators and a morphing wavetable voice, into a plate reverb. THE DESIGN IS ONE RELATIONSHIP — the modulators' release is 1.0 s against the carrier's 1.251 s, so every note starts metallic and purifies into a sine. Make them equal and the patch loses its character.",
  source: {
    patch: "patchstorage 142616", file: "FM-Pad.vcv",
    author: "Omri_Cohen", popularity: "679 dl / 20 likes / 1247 views",
    distinct: 17, families: ["FM", "wavetable / phase distortion", "FDN/plate reverb", "chaotic modulation", "polyphony / voice allocation"],
  },
  deviations: [
    "Core/MIDIToCVInterface substituted by node_keyboard: its pitch and gate map one-to-one. ITS VELOCITY DOES NOT — node_keyboard has no velocity output — so the four velocity->VCA-CV wires read the keyboard's GATE instead (trigger->number is 1 while held). The graph shape survives; per-note dynamics do not, and the four VCAs behave as hard gates rather than as a velocity response.",
    "Fundamental/VCA-1 #5 dropped: its ONLY job was scaling the gate by velocity before Terrorform's LPG trigger, so with no velocity it is a unity pass-through and the keyboard's gate reaches the trigger directly. Terrorform's 'LPG Velocity Sensitivity' knob (raw 1.0) consequently has nothing to act on.",
    "Fundamental/VCA-1 x4 and Fundamental/Sum x2 substituted by our audio_vca. A VCA-1 is exactly signal-in/gain-in/product-out. A Sum's job is collapsing a POLYPHONIC cable to mono, and our cables are mono, so what remains of it is precisely its Level knob (0.406 on both) — recorded because it is a substitution, not an identity.",
    "NYSTHI/mix4 kept as a placeholder but RENAMED audio_vcv_nysthi_mix4: `audio_vcv_mix4` is already taken, for real, by core/audio_specs_vc3a.js's BOGAUDIO MIX4. Two plugins whose model slug lowercases to one string is a collision the type-name convention lists only for Bogaudio's five, so this is a sixth the lead should add.",
    "NYSTHI/mix4's ports are PROVISIONAL — nysthi was not among the pre-cloned sources, so the survey reports raw indices. i0/i1 are the two FM sums and i2/i7 the Orbit pair, which the four audio inputs cover; i16 is a level CV (a Bogaudio Walk drives it) and is mapped to `master_cv` BY INFERENCE. That one mapping is unverified.",
    "GlueTheGiant/BusDepot dropped — stereo bus plumbing. Core/AudioInterface substituted by audio_output.",
    "Core/MIDI-Map and Stoermelder-P1/Mb dropped — a MIDI mapping utility and the module browser. Neither is a node.",
    "R7-UNITS: FM-OP times are seconds = raw^2 x 10; its Ratio is 1 + 9 x raw (so FM-OP #3's 0.1111 is a 2:1 modulator, a real harmonic ratio) and its Fine is cents = raw x 100 (1.8 ct and -0.9 ct — the detune that makes the stack move). squinkylabs WVCO's percent params are divided by 100, which is not a guess: `composites/WVCO.h:311,315,389` multiplies each by .01f. Bogaudio Walk's Rate/Offset/Scale are already 0..1 (`Walk.cpp:51` configures Rate as a percent), so they copy unchanged — the 0.2 x rate^5 in its process() is an internal scaling, not the knob's unit.",
    "FM-OP's three envelope-routing switches are NOT carried and this is the one omission that changes the sound: FM-OP #1 has `Level follows envelope` ON (raw 1.0), which is what makes the carrier's envelope an amplitude envelope at all. VC-3a spells these as DISCRETE rows (envToLevel / envToFeedback / envToDepth, options off|on) and a placeholder knob is numeric-railed, so a string cannot ride one. THE SWAP MUST SET `envToLevel: \"on\"` on the carrier. Neither modulator has any of the three set.",
    "squinkylabs-filt's dials are carried RAW (fc -0.5118, q -3.29, drive -3.395, slope 5.0, bassMakeup 1.0, masterVolume 0.5): its params are configured inside a composite header with no display transform recorded, so no real-unit conversion could be established without guessing.",
    "Plateau's dials are RAW for the same reason as the MS-20 patch — the shared placeholder was declared first by core/audio_stubs_vcv_ambient.js with raw defaults, and its damping knobs have no established unit.",
  ],
  nodes: [
    { id: "keys", type: "node_keyboard", col: 0, row: 0, w: 196, knobs: { baseNote: 48, octaves: 2 } },
    // FOUR INDEPENDENT RANDOM WALKS. Nothing here is periodic, which is the whole reason
    // a three-envelope pad does not sound like a loop.
    { id: "walkDepth", type: "audio_vcv_walk", col: 1, row: 0, knobs: { rate: 0.2035, offset: 1, scale: 1 } },
    { id: "walkRate", type: "audio_vcv_walk", col: 1, row: 3, knobs: { rate: 0.181, scale: 0.1515 } },
    { id: "walkWave", type: "audio_vcv_walk", col: 1, row: 6, knobs: { rate: 0.2185, scale: 1 } },
    { id: "walkBus", type: "audio_vcv_walk", col: 1, row: 9, knobs: { rate: 0.37, scale: 1 } },
    // AN LFO WHOSE OWN RATE WANDERS — 3.15 Hz nominal (hz = 261.626·2^(0.624 − 7)).
    { id: "lfo", type: "audio_vcv_llfo", col: 2, row: 0, knobs: { frequency: 3.15, scale: 1 } },
    // ── THE FM STACK, READ RIGHT TO LEFT: op3 → op2 → op1 → out ──────────────
    // op3 is the only one with FEEDBACK, and at 0.099 that is just enough to thicken its
    // sine into something saw-like before it modulates anything.
    { id: "op3", type: "audio_vcv_fmop", col: 3, row: 0, knobs: { ratio: 2, fine: -0.9, level: 1, feedback: 0.099, attack: 0.2, decay: 1, sustain: 1, release: 1 } },
    { id: "op2", type: "audio_vcv_fmop", col: 4, row: 0, knobs: { fine: 1.8, level: 1, depth: 0.213, attack: 0.2, decay: 1, sustain: 1, release: 1 } },
    { id: "vcaIndex", type: "audio_vca", col: 5, row: 0, knobs: { gain: 1 } },
    // THE CARRIER. Its release is 1.251 s against the modulators' 1.0 s — see the docblock.
    { id: "op1", type: "audio_vcv_fmop", col: 6, row: 0, knobs: { level: 1, levelResponse: "linear", depth: 0.1965, attack: 0.2, decay: 1, sustain: 1, release: 1.251, envToLevel: "on" } },
    { id: "vcaFm", type: "audio_vca", col: 7, row: 0, knobs: { gain: 1 } },
    { id: "sumFm", type: "audio_vca", col: 8, row: 0, knobs: { gain: 0.406 } },
    // ── THE THROUGH-ZERO PAIR. wvco2 modulates wvco1's LINEAR FM input. ──────
    { id: "wvco2", type: "audio_vcv_wvco", col: 3, row: 6, knobs: { octave: 4, frequencyMultiplier: 1, fineTune: 0.072, fmDepth: 0.078, waveshapeGain: 0.6235, waveShape: 2, outputLevel: 1 } },
    { id: "vcaTz", type: "audio_vca", col: 4, row: 6, knobs: { gain: 1 } },
    { id: "wvco1", type: "audio_vcv_wvco", col: 5, row: 6, knobs: { octave: 4, frequencyMultiplier: 1, fmDepth: 0.078, linearFmDepth: 0.324, waveshapeGain: 0.2625, waveShape: 1, feedback: 0.0765, outputLevel: 1 } },
    { id: "vcaWvco", type: "audio_vca", col: 6, row: 6, knobs: { gain: 1 } },
    { id: "sumWvco", type: "audio_vca", col: 7, row: 6, knobs: { gain: 0.406 } },
    // ── THE WAVETABLE VOICE. Its frame is chosen by a random walk, per sample. ──
    { id: "wave", type: "audio_vcv_terrorform", col: 4, row: 14, knobs: { wave: 0.309, shape_depth: 0.1245, lpg_attack: 0.8265, lpg_decay: 0.7805, fm_level: 0.0045, true_fm: "on", lpg_velocity: "on" } },
    { id: "orbit", type: "audio_vcv_orbit", col: 5, row: 14, knobs: { dist: 1 } },
    { id: "bus", type: "audio_vcv_nysthi_mix4", col: 9, row: 0, knobs: { level1: 0.8037, level2: 0.8037, level3: 0.1599, level4: 1, master: 0.7964 } },
    { id: "filt", type: "audio_vcv_filt", col: 10, row: 0, knobs: { fc: -0.5118, q: -3.29, drive: -3.395, slope: 5, bassMakeup: 1, masterVolume: 0.5 } },
    { id: "echo", type: "audio_vcv_chronoblob2", col: 11, row: 0, knobs: { delay: "ping_pong", prescaler: 6 } },
    { id: "plate", type: "audio_vcv_plateau", col: 12, row: 0, knobs: { dry: 1, wet: 0.4175, input_low_damp: 6.685, input_high_damp: 10, size: 0.5, diffusion: 10, decay: 0.3826, reverb_high_damp: 10, reverb_low_damp: 6.31, mod_shape: 0.5, mod_depth: 3.284, diffuse: "on" } },
    ...analysisTail(13),
  ],
  wires: [
    // ONE PITCH REACHES ALL FIVE OSCILLATORS — every operator tracks the key, which is
    // what keeps an FM stack in tune with itself.
    { from: "keys", fromPort: "pitch", to: "op3", toPort: "pitch" },
    { from: "keys", fromPort: "pitch", to: "op2", toPort: "pitch" },
    { from: "keys", fromPort: "pitch", to: "op1", toPort: "pitch" },
    { from: "keys", fromPort: "pitch", to: "wvco1", toPort: "voct" },
    { from: "keys", fromPort: "pitch", to: "wvco2", toPort: "voct" },
    { from: "keys", fromPort: "pitch", to: "wave", toPort: "v_oct" },
    // THE GATE ONLY REACHES THE CARRIER AND THE PLAYED OSCILLATORS. The modulators are
    // never gated, which is deliberate in the original: their envelopes run from the
    // carrier's note and their job is timbre, not loudness.
    { from: "keys", fromPort: "gate", to: "op1", toPort: "gate" },
    { from: "keys", fromPort: "gate", to: "wvco1", toPort: "gate" },
    { from: "keys", fromPort: "gate", to: "wave", toPort: "trigger" },
    { from: "keys", fromPort: "gate", to: "orbit", toPort: "trig" },
    // THE STACK. op3 bends op2's phase; op2, scaled, bends op1's.
    { from: "op3", fromPort: "audio", to: "op2", toPort: "fm" },
    { from: "walkDepth", fromPort: "out", to: "op2", toPort: "depth_cv" },
    { from: "op2", fromPort: "audio", to: "vcaIndex", toPort: "in" },
    { from: "keys", fromPort: "gate", to: "vcaIndex", toPort: "gain" },
    { from: "vcaIndex", fromPort: "out", to: "op1", toPort: "fm" },
    { from: "op1", fromPort: "audio", to: "vcaFm", toPort: "in" },
    { from: "keys", fromPort: "gate", to: "vcaFm", toPort: "gain" },
    { from: "vcaFm", fromPort: "out", to: "sumFm", toPort: "in" },
    // THE LFO'S OWN RATE WANDERS, and the same LFO then modulates three destinations.
    { from: "walkRate", fromPort: "out", to: "lfo", toPort: "pitch" },
    { from: "lfo", fromPort: "out", to: "wvco1", toPort: "fm" },
    { from: "lfo", fromPort: "out", to: "wvco2", toPort: "linear_fm" },
    { from: "lfo", fromPort: "out", to: "wave", toPort: "fm" },
    // THE THROUGH-ZERO PATH: wvco2 → VCA → wvco1's LINEAR FM. Exponential FM would
    // detune here; linear through-zero FM does not, which is why the module exists.
    { from: "wvco2", fromPort: "main", to: "vcaTz", toPort: "in" },
    { from: "keys", fromPort: "gate", to: "vcaTz", toPort: "gain" },
    { from: "vcaTz", fromPort: "out", to: "wvco1", toPort: "linear_fm" },
    { from: "wvco1", fromPort: "main", to: "vcaWvco", toPort: "in" },
    { from: "keys", fromPort: "gate", to: "vcaWvco", toPort: "gain" },
    { from: "vcaWvco", fromPort: "out", to: "sumWvco", toPort: "in" },
    // THE WAVETABLE FRAME IS A RANDOM WALK, which is the whole reason this voice never
    // repeats a timbre.
    { from: "walkWave", fromPort: "out", to: "wave", toPort: "wave" },
    { from: "wave", fromPort: "main", to: "orbit", toPort: "in" },
    { from: "sumFm", fromPort: "out", to: "bus", toPort: "in1" },
    { from: "sumWvco", fromPort: "out", to: "bus", toPort: "in2" },
    { from: "orbit", fromPort: "out_l", to: "bus", toPort: "in3" },
    { from: "orbit", fromPort: "out_r", to: "bus", toPort: "in4" },
    // ONE WALK DRIVES BOTH THE BUS LEVEL AND THE FILTER CUTOFF, so the pad breathes and
    // brightens together rather than in two unrelated motions.
    { from: "walkBus", fromPort: "out", to: "bus", toPort: "master_cv" },
    { from: "walkBus", fromPort: "out", to: "filt", toPort: "cv1" },
    { from: "bus", fromPort: "out_l", to: "filt", toPort: "l_audio" },
    { from: "bus", fromPort: "out_r", to: "filt", toPort: "r_audio" },
    { from: "filt", fromPort: "l_audio", to: "echo", toPort: "in_l" },
    { from: "echo", fromPort: "out_l", to: "plate", toPort: "in_l" },
    { from: "plate", fromPort: "out_l", to: "meter", toPort: "in" },
    { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
    { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
  ],
};

/**
 * P8 — BOREALIS / GENERATIVE KOSMISCHE (920 dl / 43 likes). Berlin-School sequencing
 * rather than an ambient wash, chosen deliberately so this set is not all one texture:
 * 30 DISTINCT module types in only 40 instances, so almost every module is a new
 * capability rather than a repeat.
 *
 * ── WHAT IT BRINGS THAT NOTHING ELSE HERE DOES ──────────────────────────────
 *   IMPROMPTU CHORD-KEY is polyphony done properly. One V/oct INDEX selects a stored
 *     chord and four separate CV outputs ARE its voicing — so a chord is four voices that
 *     were chosen together, not four cables merged. Here only its first voice is used, and
 *     that is the patch's own choice, not ours.
 *   ANIMATEDCIRCUITS ACFOLDING is a wavefolder: it reflects a waveform back on itself past
 *     a threshold, which multiplies harmonics rather than filtering them away. It is the
 *     opposite operation from everything else in this set.
 *   21kHz PALMLOOP supplies the FM layer, and dbRackModules SPF is a state-variable filter
 *     whose OUTPUT is what the patch treats as its audio bus.
 *
 * ── THE STRUCTURE, WHICH IS THREE VOICES OVER ONE CLOCK TREE ────────────────
 * A clock at 120 BPM feeds an edge detector, then a divider. Three things read the tree at
 * different rates: a random source, an addressable 8-step sequencer, and two envelopes.
 * Those are summed and QUANTIZED three times over — once for the FM voice, once through
 * Chord-Key for the chordal voice, once for the low oscillator. Each voice lands on a
 * mixer channel whose LEVEL is an envelope, so the three fade in and out independently and
 * the texture keeps changing without any part of it repeating.
 *
 * ── WHY THE ENVELOPES ARE THE MIXER'S CVs AND NOT VCAs ─────────────────────
 * `Bogaudio-AD` #1 has LOOP on, which makes it a shaped LFO rather than an envelope, and
 * it modulates #3's ATTACK — an envelope whose own attack time drifts. That is the
 * generative engine of the patch: nothing here is a fixed shape.
 */
export const VCV_BOREALIS = {
  id: "vcv-borealis",
  title: "VCV Borealis Kosmische",
  help: "Berlin-School generative sequencing, not an ambient wash: one clock tree feeds a random source, an addressable sequencer and three envelopes, quantized three ways into an FM voice, a CHORD (one V/oct index picks a whole voicing), and a low oscillator through a wavefolder. Each voice's mixer level is its own envelope, so the texture never repeats.",
  source: {
    patch: "patchstorage 184456", file: "Borealis-67d80dad22b55.vcv",
    author: "SATURATA", popularity: "920 dl / 43 likes / 2414 views",
    distinct: 30, families: ["polyphony / voice allocation (Chord-Key)", "wavetable / phase distortion (ACFolding)", "FM (PalmLoop)", "chaotic / generative sequencing", "FDN/plate reverb"],
  },
  deviations: [
    "RebelTech/CLK substituted by audio_clock + audio_trigger. Its harvested tempo is 120 BPM (raw p0=120, which our clock's range accepts exactly), but its THREE separate division outputs collapse onto one: our clock has a single output, and an `audio` output cannot drive a `trigger` input, so an edge detector is required as well (the house SEQUENCED DINGS patch states the same reasoning). What is lost is the phase relationship between CLK's three taps — everything downstream of them now fires on the same pulse, and the Autodafe divider supplies the only division that remains.",
    "Autinn/Zod substituted by our audio_output. Zod is the master limiter/EQ output stage, and audio_output already sums through a limiter, so this is an exact-role substitution. Its twelve harvested params could not be named (Autinn's repo is not identified) and are lost: p0=0.5 p1=0.5 p2=0.4024 p3=1.0 p4=1.991 p5=-14.497 p6=-60.0 p7=-70.0 p8=175.5 p9=0.5 p10=0.2361 p11=2.1687.",
    "Fundamental/VCMixer x2 and Befaco/STMix substituted by audio_mixer — four inputs, per-channel level CV, master. Exact for the VCMixers. STMix is a STEREO mixer and the substitution therefore also collapses its stereo pair, which our mono tail could not carry anyway.",
    "Fundamental/VCA-1 x2 substituted by audio_vca (levels 0.081 and 0.101 carried). VCA-1 #1 is DROPPED: it appears in the rack and is wired to nothing.",
    "Fundamental/Noise substituted by audio_noise on 'white' — only the White output is used.",
    "Bogaudio-XFade DROPPED: three ochd taps reach it and its output goes NOWHERE in the harvested file. It is a dead branch, and a node that cannot reach an output is a card contributing nothing.",
    "Fundamental/Scope dropped (an LLFO is patched to it for display), VCV-Recorder/Recorder dropped (a file writer, not a node), and DanTModules/Purfenator dropped — it is in the rack and wired to nothing.",
    "Core/AudioInterface2 substituted by audio_output.",
    "R7-UNITS conversions, each derived rather than guessed: Bogaudio LLFO's rate is `hz = 261.626 x 2^(raw - 11)` with its Slow switch engaged (`lfo_base.cpp:30-37` gives the -3-8 offset), so raw -1.8482 is 0.0355 Hz — one sweep every 28 seconds, which is what makes this a drift rather than a wobble. The Slow switch itself is therefore NOT set, because the conversion has already spent it. Bogaudio LVCO's pitch is `hz = 261.626 x 2^raw`, so raw 0.9867 is 518.4 Hz (a C5); that leaves nothing to convert on the blueprint side because it rides the placeholder's declared default. Bogaudio AD's segments are seconds = raw^2 x 10: #1 is 4.58 s / 7.60 s, #2 is 0.004 s / 0.21 s, #3 is 4.62 s / 9.14 s. dbRackModules SPF's cutoff knob is a LOG2-HERTZ exponent (its own configParam spans 4..14), so the harvested 10.7 and 5.7875 are 1664 Hz and 55 Hz and copy across unconverted because that IS the knob's unit.",
    "Bogaudio-AD's LOOP and RETRIGGER switches are not carried: the placeholder declares only attack and decay. THIS MATTERS — AD #1 has Loop on, which is what turns it from an envelope into the shaped LFO that modulates AD #3's attack time. VC-3a must set it when the real node lands. AD's context-menu `invert: 1.0` on all three is likewise not carried.",
    "Bogaudio-VCO's FM-mode switch is set to 'exponential' from the harvested raw 1.0 BY INDEX (Rack's panel switch is LIN/EXP), which is an assumption about VC-3b's option ORDER rather than a reading of it.",
    "Chronoblob2's `delay: ping_pong` comes from the harvested `data.delay_mode = 1` and its `prescaler: 6` from `data.sync_prescaler`, both by name-correspondence with VC-5's own knobs. Its numbered params p0=0.488 p1=0.5614 p2=0.4108 p5=0.087 p6=-0.1147 p8=1.0 could NOT be mapped onto VC-5's time/feedback/mix/damp — AlrightDevices' source is not identified, so the param ORDER is unknown — and are lost.",
    "THE SURVEY'S RAW CABLE INDICES FOR CHRONOBLOB2 ARE NOT VC-5'S PORT ORDER, and reading them as such would have built a silent patch. The survey has `Offset -> Chronoblob2[i5]` and `LLFO -> [i4]`; under VC-5's order i5 would be `mix`, which would leave the delay with NO audio input at all while the reverb downstream received nothing. Mapping by FUNCTION instead — the Offset carries the audio bus, so it is `in_l`; the LLFO is the classic delay-time modulation, so it is `time`; the clock is `sync` — is consistent with P19 and P20, where an audio source lands on the same i5/i6 pair.",
    "Fundamental/Random, Quantizer and Octave, ImpromptuModular Chord-Key, 21kHz PalmLoop, AnimatedCircuits ACFolding, Instruo ochd and athru all carry their dials RAW: their display transforms are not in the patch file (and four of those repos are in survey_vcv.md § 7's not-indexed list), so no real-unit conversion could be established. The values are on the right KEYS and are not lost; the units are the owing block's to fix.",
    "AudibleInstruments/Ripples' harvested Resonance 0.3169 and Frequency 6.0629 land on VC-1's `resonance` and `frequency` — its frequency knob is a log2-hertz exponent spanning 4.32..14.29, so 6.0629 is ~66 Hz and needs no conversion.",
  ],
  nodes: [
    // ── THE CLOCK TREE ────────────────────────────────────────────────────────
    { id: "clock", type: "audio_clock", col: 0, row: 0, knobs: { bpm: 120 } },
    // EIGHT FREE-RUNNING LFOs from one module, at eight related rates — the reason a
    // patch this size needs only one modulation source for its slowest movements.
    { id: "ochd", type: "audio_vcv_ochd", col: 0, row: 6, knobs: { rate: 0.2909 } },
    { id: "noise", type: "audio_noise", col: 0, row: 10, knobs: { color: "white", level: 0.5 } },
    // 0.0355 Hz — one sweep every 28 seconds. This one LFO reaches six destinations.
    { id: "drift", type: "audio_vcv_llfo", col: 0, row: 14, knobs: { frequency: 0.0355, offset: 1, scale: 0.2819 } },
    { id: "edge", type: "audio_trigger", col: 1, row: 0, knobs: { pulseMs: 5 } },
    { id: "divider", type: "audio_vcv_clockdivider", col: 2, row: 0 },
    { id: "envShort", type: "audio_vcv_ad", col: 2, row: 6, knobs: { attack: 0.004, decay: 0.209 } },
    { id: "randPitch", type: "audio_vcv_random", col: 3, row: 0, knobs: { rate: 0.9601, shape: 0.026, prob: 1, rand: 1, rateCv: 0.8587 } },
    // LOOPING, so it is a shaped LFO rather than an envelope — and its only job is to
    // modulate the SLOW envelope's attack time.
    { id: "envLoop", type: "audio_vcv_ad", col: 3, row: 6, knobs: { attack: 4.575, decay: 7.6 } },
    // `rate` IS HERTZ, and -2.5877 was the RAW LOG2 dial Rack stores. VC-2's clause-2
    // pass moved every dial to its real unit, so the harvested exponent has to be
    // evaluated: 2^-2.5877 = 0.1664 Hz. Left raw it is a NEGATIVE frequency, which the
    // blueprint range check caught — but had the range merely been wide it would have
    // been a silently wrong tempo.
    { id: "randChord", type: "audio_vcv_random", col: 4, row: 0, knobs: { rate: 0.1664, prob: 1, rand: 1, shapeCv: 1 } },
    { id: "seq", type: "audio_vcv_addrseq", col: 4, row: 6, knobs: { steps: 8, direction: "forward", step1: 0.0506, step2: -0.1133, step3: 0.0699, step4: 0.2169, step5: -0.1181, step6: 0.0651, step7: 0.4313, step8: 0.2651 } },
    { id: "envSlow", type: "audio_vcv_ad", col: 4, row: 14, knobs: { attack: 4.62, decay: 9.14 } },
    { id: "atChord", type: "audio_vca", col: 5, row: 0, knobs: { gain: 0.081 } },
    { id: "atLow", type: "audio_vca", col: 5, row: 4, knobs: { gain: 0.101 } },
    { id: "pitchMix", type: "audio_mixer", col: 5, row: 8, knobs: { level1: 0.396, level2: 0.7467, level3: 0.6901, master: 0.4313 } },
    // ONE V/OCT INDEX PICKS A WHOLE CHORD. That is the polyphony family done properly.
    { id: "chord", type: "audio_vcv_chordkey", col: 6, row: 0, knobs: { index: 4 } },
    { id: "quantLow", type: "audio_vcv_quantizer", col: 6, row: 8, knobs: { offset: -0.3639 } },
    { id: "quantFm", type: "audio_vcv_quantizer", col: 6, row: 14 },
    { id: "quantChord", type: "audio_vcv_quantizer", col: 7, row: 0 },
    { id: "low", type: "audio_vcv_lvco", col: 7, row: 8, knobs: { wave: 1 } },
    { id: "octave", type: "audio_vcv_octave", col: 8, row: 0 },
    { id: "lowFilter", type: "audio_vcv_spf", col: 8, row: 8, knobs: { freq: 5.7875, r: 1.165 } },
    { id: "fmOsc", type: "audio_vcv_palmloop", col: 8, row: 14, knobs: { octave: 9 } },
    { id: "drone", type: "audio_vcv_palmloop", col: 8, row: 18, knobs: { octave: 6 } },
    { id: "chordOsc", type: "audio_vcv_bog_vco", col: 9, row: 0, knobs: { fmMode: "exponential" } },
    // THE WAVEFOLDER — it multiplies harmonics where a filter would remove them.
    { id: "folder", type: "audio_vcv_acfolding", col: 9, row: 14, knobs: { fold: 1, symmetry: 1, gain: 7.4134 } },
    { id: "wavefold", type: "audio_vcv_athru", col: 9, row: 18 },
    // EACH VOICE'S LEVEL IS AN ENVELOPE, which is why the three fade independently.
    { id: "voices", type: "audio_mixer", col: 10, row: 0, knobs: { level1: 0.3394, level2: 0.7212, level3: 0.9221, level4: 0.5091, master: 0.8554 } },
    { id: "bus", type: "audio_vcv_spf", col: 11, row: 0, knobs: { freq: 10.7, r: 1 } },
    { id: "trim", type: "audio_vcv_offset", col: 12, row: 0, knobs: { scale: 0.1331, order: "scale_first" } },
    { id: "wash", type: "audio_vcv_ripples", col: 13, row: 0, knobs: { resonance: 0.3169, frequency: 6.0629 } },
    { id: "echo", type: "audio_vcv_chronoblob2", col: 14, row: 0, knobs: { delay: "ping_pong", prescaler: 6 } },
    { id: "plate", type: "audio_vcv_plateau", col: 15, row: 0, knobs: { dry: 0.7545, wet: 0.1091, pre_delay: 0.5, input_low_damp: 6.31, input_high_damp: 10, size: 0.5429, diffusion: 7.8701, decay: 0.6307, reverb_high_damp: 8.4026, reverb_low_damp: 7.165, mod_speed: 0.1247, mod_shape: 0.5, mod_depth: 5.852, diffuse: "on" } },
    { id: "master", type: "audio_mixer", col: 16, row: 0, knobs: { level1: 0.7133, level2: 0.6819, level3: 0.4976, level4: 0.0759, master: 1 } },
    ...analysisTail(17),
  ],
  wires: [
    { from: "clock", fromPort: "out", to: "edge", toPort: "in" },
    // FOUR THINGS READ THE SAME PULSE, and the divider gives the only slower rate.
    { from: "edge", fromPort: "out", to: "divider", toPort: "clock" },
    { from: "edge", fromPort: "out", to: "envShort", toPort: "trigger" },
    { from: "edge", fromPort: "out", to: "randPitch", toPort: "trig" },
    { from: "edge", fromPort: "out", to: "seq", toPort: "clock" },
    { from: "edge", fromPort: "out", to: "echo", toPort: "sync" },
    { from: "divider", fromPort: "div3", to: "randChord", toPort: "trig" },
    { from: "divider", fromPort: "div3", to: "envSlow", toPort: "trigger" },
    // THE LOOPING ENVELOPE MODULATES THE SLOW ONE'S ATTACK — an envelope whose shape
    // itself drifts, which is this patch's generative engine.
    { from: "envLoop", fromPort: "env", to: "envSlow", toPort: "attack" },
    { from: "randPitch", fromPort: "stepped", to: "pitchMix", toPort: "in1" },
    { from: "seq", fromPort: "out", to: "pitchMix", toPort: "in2" },
    { from: "drift", fromPort: "out", to: "pitchMix", toPort: "level1" },
    { from: "randChord", fromPort: "stepped", to: "atChord", toPort: "in" },
    { from: "randChord", fromPort: "exponential", to: "atLow", toPort: "in" },
    { from: "atChord", fromPort: "out", to: "chord", toPort: "index" },
    { from: "atLow", fromPort: "out", to: "quantLow", toPort: "pitch" },
    { from: "pitchMix", fromPort: "out", to: "quantFm", toPort: "pitch" },
    { from: "chord", fromPort: "cv1", to: "quantChord", toPort: "pitch" },
    { from: "quantChord", fromPort: "pitch", to: "octave", toPort: "pitch" },
    { from: "octave", fromPort: "pitch", to: "chordOsc", toPort: "pitch" },
    { from: "quantLow", fromPort: "pitch", to: "low", toPort: "pitch" },
    { from: "low", fromPort: "out", to: "lowFilter", toPort: "lp" },
    { from: "envSlow", fromPort: "env", to: "lowFilter", toPort: "freq" },
    { from: "quantFm", fromPort: "pitch", to: "fmOsc", toPort: "voct" },
    { from: "quantFm", fromPort: "pitch", to: "folder", toPort: "fold_cv" },
    { from: "fmOsc", fromPort: "main", to: "folder", toPort: "in" },
    { from: "drone", fromPort: "sqr", to: "wavefold", toPort: "in" },
    { from: "ochd", fromPort: "out7", to: "wavefold", toPort: "fold_cv" },
    { from: "ochd", fromPort: "out8", to: "bus", toPort: "freq" },
    // THE THREE VOICES, EACH ON A CHANNEL WHOSE LEVEL IS AN ENVELOPE. Channel 2 has a
    // level CV and no input, which is how the harvested patch left it.
    { from: "folder", fromPort: "out", to: "voices", toPort: "in1" },
    { from: "chordOsc", fromPort: "sine", to: "voices", toPort: "in3" },
    { from: "lowFilter", fromPort: "cv", to: "voices", toPort: "in4" },
    { from: "envShort", fromPort: "env", to: "voices", toPort: "level2" },
    { from: "envLoop", fromPort: "env", to: "voices", toPort: "level3" },
    { from: "envSlow", fromPort: "env", to: "voices", toPort: "level4" },
    // SPF's single output is the patch's audio bus — dbRack calls it CV, but it carries
    // the filtered signal, which is why an attenuverter and a delay follow it.
    { from: "voices", fromPort: "out", to: "bus", toPort: "lp" },
    { from: "bus", fromPort: "cv", to: "trim", toPort: "in" },
    { from: "noise", fromPort: "out", to: "wash", toPort: "in" },
    { from: "drift", fromPort: "out", to: "wash", toPort: "freq" },
    { from: "trim", fromPort: "out", to: "echo", toPort: "in_l" },
    { from: "drift", fromPort: "out", to: "echo", toPort: "time" },
    { from: "echo", fromPort: "out_l", to: "plate", toPort: "in_l" },
    // THE ONE LFO MODULATES THREE OF THE REVERB'S OWN PARAMETERS, which is what keeps a
    // long tail from sounding like a fixed room.
    { from: "drift", fromPort: "out", to: "plate", toPort: "wet" },
    { from: "drift", fromPort: "out", to: "plate", toPort: "diffusion" },
    { from: "drift", fromPort: "out", to: "plate", toPort: "mod_shape" },
    { from: "plate", fromPort: "out_l", to: "master", toPort: "in1" },
    { from: "wavefold", fromPort: "out", to: "master", toPort: "in2" },
    { from: "wash", fromPort: "lp4", to: "master", toPort: "in3" },
    { from: "plate", fromPort: "out_r", to: "master", toPort: "in4" },
    ...analysisWires("master"),
  ],
};

/** This set's blueprints. See the PATCH-SET CONTRACT in core/audio_patch_sets.js. */
export const BLOCK_PATCHES = [VCV_SUBHARMONICON, VCV_MS20, VCV_FM_PAD, VCV_BOREALIS];
