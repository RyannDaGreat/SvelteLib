/**
 * DEMO PATCHES — VCV Rack — the big generative machines.
 *
 * Part of R7-17-SEL's 20 headline patches; see `claude_instructions.md` for the full
 * table and for the user ruling that chose them (*"20 impressive, fully-equipped patches
 * with tons of likes and views"*). The blueprint format, the grid layout rule and the
 * meter/spectrum tail are documented ONCE in `core/audio_patches.js` — read that file's
 * header before adding anything here. The aggregation contract is in
 * `core/audio_patch_sets.js`.
 *
 * THIS SET REBUILDS:
 *   - P2 Self-Playing Generative Ambient — patchstorage 163246, Omri_Cohen, 1793 dl, 28 distinct
 *   - P5 Incanta — patchstorage 151546, Massi, 1271 dl, 37 distinct, SEVEN hard families
 *   - P9 Generative Patching with Rampage — patchstorage 143657, Omri_Cohen, 1251 dl, 32 distinct
 *
 * Every blueprint here carries `source` (the harvested file, its author, its popularity
 * figures, its distinct-module count) and `deviations` (what we did NOT reproduce, and
 * why) — an UNRECORDED substitution is the silent divergence R7-17-SEL exists to prevent.
 *
 * A node this set needs but the library does not yet have is a PLACEHOLDER, declared in
 * the companion `core/audio_stubs_vcv_generative.js`. Read `core/audio_stub_nodes.js` first:
 * a placeholder carries the FINAL type name and the FINAL port names, so the wire written
 * here today is the wire the real module gets.
 *
 * ── THE ONE STRUCTURAL DEVIATION ALL THREE SHARE: OUR GRAPH IS ACYCLIC ──────
 * `core/nodeflow.js` REFUSES a connection that closes a directed cycle (its own header
 * gives the reason: a pull-based evaluator resolves a cycle either by looping forever or
 * by reading frame N-1, and frame-N-1 state is what the determinism law disqualifies), and
 * `tests/audio_patches_test.js` additionally requires every wire to run left to right. All
 * three of these patches are FULL of cycles, because a Rack cable has no such rule:
 *
 *   · A SEND/RETURN IS A CYCLE. `MixMaster -> AuxExpander -> Plateau -> AuxExpander` is
 *     how every one of these patches reverberates. Rebuilt here as the two halves it
 *     actually is: the strip mix feeds the reverb AND the master, and the reverb's return
 *     is a second and third channel of that master. Same signal path, same sound, drawn
 *     as the DAG it always was. **This is the send/return shape the rest of the set
 *     should copy** (R7-17-SEL names P2 as the patch that pins it).
 *   · A SELF-PATCH IS A CYCLE. P2's burst generator re-samples its own rate through a
 *     sample-and-hold clocked by its own pulses; P5's `EventTimer -> EventTimer`; P1's
 *     famous `Marbles[Y] -> Marbles[T jitter]`. Each is broken by moving the sampler
 *     UPSTREAM onto an independent clock, which keeps "these values are freshly random"
 *     and loses "they are re-rolled by the thing they control". Named per patch below.
 *
 * ── AND THE ONE UNIT DEVIATION THEY SHARE: EVERY DIAL WAS CONVERTED ────────
 * R7-UNITS: an `audio` wire is ±1 = ±5 Rack volts, a `number` wire carries the REAL unit
 * of its quantity, a V/oct port is SEMITONES and a gate is 0..1. A `.vcv` file stores Rack
 * volts and raw knob positions, so a harvested value is CONVERTED before it is written
 * here, never copied. Each patch's `deviations` names what moved and what could not be
 * carried at all.
 */

/**
 * The analysis tail every patch ends with, at a given column — a local copy of the helper
 * in `core/audio_patches.js`, because a patch set MUST NOT import that file (it imports
 * this one through `core/audio_patch_sets.js`, so the dependency only runs one way).
 *
 * Pure function.
 *
 * @param {number} col - the column the meter sits in; the tail occupies col..col+2
 * @param {number} row - the row all three sit on
 * @returns {object[]} three blueprint nodes: meter, spectrum, output
 *
 * @example analysisTail(4, 1)[0] // {id: "meter", type: "audio_meter", col: 4, row: 1}
 * @example analysisTail(4, 1).map((n) => n.col) // [4, 5, 6]
 */
const analysisTail = (col, row = 0) => [
  { id: "meter", type: "audio_meter", col, row },
  { id: "spectrum", type: "audio_spectrum", col: col + 1, row },
  { id: "out", type: "audio_output", col: col + 2, row, knobs: { volume: 0.7 } },
];

/**
 * Pure function. The wires that chain that tail, given the node feeding it.
 *
 * @param {string} from - the blueprint id of the module feeding the meter
 * @param {string} fromPort - which of its outputs to take
 * @returns {object[]} three wires: from → meter → spectrum → out
 *
 * @example analysisWires("master", "out")[0]
 *   // {from: "master", fromPort: "out", to: "meter", toPort: "in"}
 * @example analysisWires("bus", "o0").length // 3
 */
const analysisWires = (from, fromPort) => [
  { from, fromPort, to: "meter", toPort: "in" },
  { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
  { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
];

/**
 * P2 — SELF-PLAYING GENERATIVE AMBIENT (Omri Cohen).
 *
 * ── WHY THIS PATCH AND NOT ANOTHER OF HIS ───────────────────────────────────
 * **It has no sequencer driving the piece.** That is the whole reason R7-17-SEL took it:
 * a CountModula BurstGenerator fires a burst of pulses, SEVEN Bogaudio SampleHold pairs
 * snapshot a fresh random value on every one of those pulses, and SIX CountModula Fade
 * units crossfade whole voices in and out over seconds. Nothing decides what happens next
 * except which random values happened to be held when the last burst fired. Its one SEQ3
 * drives ONE voice; it is a participant, not a conductor.
 *
 * Three voices run in parallel and all three are kept:
 *   A — Surge XT sine oscillator through Surge's EGxVCA, delayed, faded, then granulated
 *       by NYSTHI's Simpliciter. The burst's `pulses` is the VCA's gate, so voice A plays
 *       exactly the rhythm the burst generator invented.
 *   B — Surge XT WAVETABLE oscillator through Surge's VCF, delayed, then through two
 *       stereo pairs of Vult Tangents lowpass gates opened by held random values.
 *   C — Bogaudio FM-OP, pitched by the quantizer and gated by the SEQ3.
 *
 * ── THE SEND/RETURN IS THE OTHER REASON IT GOES FIRST ───────────────────────
 * MixMaster + AuxExpander + Plateau is the topology every other patch in the set needs,
 * and in Rack it is a CYCLE. See this file's header for the DAG it becomes; `stripA`,
 * `stripB`, `plateau` and `master` below are that shape, and they are what P5 and P9 copy.
 */
export const VCV_SELF_PLAYING_AMBIENT = {
  id: "vcv-self-playing-ambient",
  title: "VCV Self-Playing Generative Ambient",
  help: "Omri Cohen's flagship self-playing patch, and it has NO sequencer: a burst generator fires pulses, seven sample-and-hold pairs snapshot a new random value on each one, and six timed crossfaders bring three whole voices in and out. Insert it, enable audio, press Start once and leave it. The Burst Generator's Rate and Pulses are what to turn.",
  source: {
    patch: "patchstorage 163246", file: "Generative-63eb3c52d54b3.vcv",
    author: "Omri_Cohen", popularity: "1793 dl / 27 likes / 4440 views",
    distinct: 28, families: ["granular", "FDN/plate reverb", "wavetable", "FM", "chaotic/generative sequencing"],
  },
  deviations: [
    "SEVEN UNRESOLVABLE VULT VALUES ARE DROPPED RATHER THAN CARRIED AS RAW INDICES, AND THAT IS A CRASH FIX. Caudal's Speed (−0.325) and the six Tangents' fifth param (`p4`, 0.6 on every one of tangent1…tangent6). A `pN` is not a knob any spec declares, so `buildPatchItems` threw on it and THE PATCH COULD NOT BE INSERTED. Tangents' p4 is a fifth param VC-10 does not model — never 0 and never absent, which says it is an input-level-like control neutral at 0.6, but a name would still not license copying the number onto a knob we do not have. Caudal's Speed is bipolar in Vult and 0…1 here, so the raw negative clamps to a stopped chain while the document claims otherwise. Both numbers are preserved in this sentence; recover them the day Vult's param enum is known.",
    "Inklen-CableColourKey x1 and VCV-Recorder x1 dropped — a cable-colour legend and a file writer, neither of them sound.",
    "Core/AudioInterface2 substituted by our audio_output — NODE_REGISTRY.md marks it `chrome`.",
    "MindMeld MixMaster + AuxExpander and all six Fundamental/Mixer instances substituted by our audio_mixer (unity summing with per-channel level). What is lost is MixMaster's per-strip EQ and metering, neither of which this patch uses; what is preserved is the SEND/RETURN, rebuilt as an acyclic dry+wet split — see the file header.",
    "CountModula/ManualGate substituted by our node_button — it IS a manual gate, and a button is how this app spells a live human trigger. CONSEQUENCE, stated because it is invisible otherwise: a rendered export of this slide never starts, because nobody pressed it (core/control_nodes.js's ruling). The `reseed` clock beside it is recordable and does run.",
    "AaronStatic/ScaleCV and DiatonicCV substituted by two of our audio_quantize. Both originals turn a random voltage into a scale-locked pitch, which is exactly what ours does — and ours states its output in SEMITONES (`range` is 'how many semitones the incoming 0..1 signal spans'), so it doubles as the R7-UNITS scaler this pitch path would otherwise need. What is lost is choosing the root and mode by CV.",
    "THE BURST GENERATOR'S SELF-PATCH IS BROKEN, and it is the most audible deviation here. Originally `BurstGenerator[pulses] -> SampleHold#1 -> BurstGenerator[rate CV, pulses CV]`: the burst re-rolls its own rate and length every time it fires. That is a directed cycle. Here `sh1` is clocked by an independent slow audio_clock (`reseed`, 24 bpm) instead, so the rate and length are still freshly random and no longer re-rolled BY the burst. One node was ADDED for this (the clock and its edge detector) and it is not in the original.",
    "The survey printed only the first 70 of 113 cables. Tangents #3-#6 and Fade #4-#6 are wired one stereo PAIR per voice, which is what the six visible Tangents cables show for the first pair; that grouping is inferred, not harvested.",
    "R7-UNITS conversions applied: Fundamental/Compare's B offset -4.0964 V became -0.8193 (÷5); the burst's probability 10.0 became 1.0 (its configParam displays 0..10 as a percentage); FM-OP's envelope raws 0.0241/0.3162 became 0.0058 s and 1.0 s (Bogaudio shows those knobs as v²·10 seconds); the two LLFO frequencies became hertz (1.4363 and 12.9418) from their raws −0.509 and 2.6626 through `bogaudioSemitonesToHz(12·(v − 7))`. THAT LAST ONE WAS WRONG UNTIL 2026-08-07 and is worth the sentence: it read the slow-mode raws through a `2^v/100` that is no octave offset of Bogaudio's reference at all, and it stated the rate AFTER Slow's ÷16 in a knob that means the rate BEFORE it — so `LlfoKernel.control` divided a second time and both LFOs ran 200× slow, below the knob's own minimum.",
    "DIAL VALUES THAT COULD NOT BE CARRIED AT ALL, said plainly rather than discovered later: all four Surge XT modules' params serialise as p1…p50 with no names in the patch file and no fixed meaning across models, so their harvested settings are LOST and VC-4 must recover them. SEQ3's tempo is 120 bpm, which does not fit a placeholder's ±10 rail. Bogaudio SampleHold #6's 1011 ms smoothing likewise.",
  ],
  nodes: [
    // ── COLUMN 0 — everything with no input at all ─────────────────────────
    { id: "start", type: "node_button", col: 0, row: 0, knobs: { label: "Start" } },
    { id: "reseed", type: "audio_clock", col: 0, row: 1, knobs: { bpm: 24 } },
    { id: "noise", type: "audio_noise", col: 0, row: 2, knobs: { color: "white", level: 0.5 } },
    // THE LLFO RATE KNOB IS THE RATE BEFORE SLOW MODE, and these two used to double-count
    // it. Their harvested raws are −0.509 and 2.6626 (survey_vcv.md), and VC-3b's map is
    // `bogaudioSemitonesToHz(12·(v − 7))` — pinned by `vcv-fm-pad.lfo` over in
    // core/audio_patches_vcv_classic.js, whose raw 0.624 was written 3.15 Hz under exactly
    // that law. It is the one LLFO in the roster with Slow OFF and the only one that was
    // already right, which is what identifies the fault as Slow rather than as the map.
    // What was stored here was the rate AFTER the ÷16 (through a `2^v/100` that is no
    // octave offset of Bogaudio's reference), so `LlfoKernel.control`'s own ÷16 applied
    // twice: 204× slow. Slow still divides these to 0.09 and 0.81 Hz, which is also what
    // finally makes the two nodes' names true.
    { id: "llfoSlow", type: "audio_vcv_llfo", col: 0, row: 3, knobs: { frequency: 1.436305, slow: "on", scale: 1 } },
    // `wave` is Bogaudio's own `configSwitch` index and 4 is `square` (BOG_LLFO_WAVES).
    { id: "llfoFast", type: "audio_vcv_llfo", col: 0, row: 4, knobs: { frequency: 12.941762, slow: "on", wave: "square", scale: 1 } },
    { id: "walk", type: "audio_vcv_walk", col: 0, row: 5, knobs: { rate: 0.3139, scale: 0.3193 } },
    // `speed` is Caudal's param 0. THE HARVESTED −0.325 IS DROPPED and the knob sits at its
    // default: Rack clamps before saving, so a stored −0.325 proves Vult's own Speed knob is
    // bipolar while VC-10 models it 0…1, and its real bounds are closed source so no rescale
    // is invented. Writing the raw number anyway made the document say −0.325 while our
    // engine clamped it to 0 — a stopped pendulum, stated nowhere. See vcv-ambient-drone's
    // Caudal for the same call and the full reasoning.
    { id: "caudal", type: "audio_vcv_caudal", col: 0, row: 6 },
    // ── COLUMN 1 — the two sample-and-holds that decide what the machine does ─
    { id: "sh1", type: "audio_vcv_samplehold", col: 1, row: 0 },
    { id: "reseedEdge", type: "audio_trigger", col: 1, row: 1, knobs: { pulseMs: 5 } },
    { id: "sh4", type: "audio_vcv_samplehold", col: 1, row: 2 },
    // ── COLUMN 2 — the two things that generate TIME ────────────────────────
    // `rateCvAtten`/`pulsesCvAtten`: VC-7a's header publishes this map, because a
    // CountModula CV jack ATTENUATES its knob rather than summing with it, so the jack
    // keeps the plain name and the trim beside it is what these two dials are.
    { id: "burst", type: "audio_vcv_burstgenerator", col: 2, row: 0, knobs: { rate: 1.0994, rateCvAtten: 0.2771, pulsesCvAtten: 0.6747, probability: 1 } },
    { id: "seq3", type: "audio_vcv_seq3", col: 2, row: 2, knobs: { steps: 6 } },
    // ── COLUMN 3 — five more S&H pairs, plus the probabilistic one ──────────
    { id: "sh2", type: "audio_vcv_samplehold", col: 3, row: 0 },
    { id: "sh3", type: "audio_vcv_samplehold", col: 3, row: 1 },
    { id: "sh5", type: "audio_vcv_samplehold", col: 3, row: 2 },
    { id: "sh6", type: "audio_vcv_samplehold", col: 3, row: 3 },
    { id: "sh7", type: "audio_vcv_samplehold", col: 3, row: 4 },
    { id: "sah2", type: "audio_vcv_sampleandhold2", col: 3, row: 5, knobs: { prob: 0.5241, level: 0.1747 } },
    { id: "compare", type: "audio_vcv_compare", col: 3, row: 6, knobs: { b: -0.8193 } },
    // ── COLUMN 4 — the CV mix that becomes the pitch material ──────────────
    { id: "cvmix", type: "audio_mixer", col: 4, row: 0, knobs: { level1: 1, level2: 0.6, level3: 0.4, master: 1 } },
    { id: "evt1", type: "audio_vcv_eventtimer", col: 4, row: 5, knobs: { length: 3 } },
    { id: "evt2", type: "audio_vcv_eventtimer", col: 4, row: 6, knobs: { length: 2 } },
    // ── COLUMN 5 — the quantizers (the ScaleCV substitution) + the fade CVs ─
    { id: "quant", type: "audio_quantize", col: 5, row: 0, knobs: { range: 24, scale: "pentatonic" } },
    { id: "fadeMix1", type: "audio_mixer", col: 5, row: 4, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "fadeMix2", type: "audio_mixer", col: 5, row: 5, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "fadeMix3", type: "audio_mixer", col: 5, row: 6, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "fadeMix4", type: "audio_mixer", col: 5, row: 7, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "quant2", type: "audio_quantize", col: 6, row: 0, knobs: { range: 12, scale: "major" } },
    // ── COLUMN 7 — the three voices' oscillators, in parallel ──────────────
    { id: "sineOsc", type: "audio_vcv_surgextoscsine", col: 7, row: 0 },
    { id: "wtOsc", type: "audio_vcv_surgextoscwavetable", col: 7, row: 2 },
    { id: "fmop", type: "audio_vcv_fmop", col: 7, row: 4, knobs: { attack: 0.0058, decay: 1, sustain: 1, release: 1, feedback: 0.1024, level: 1, envToLevel: "on" } },
    // ── COLUMN 8 — each voice's amplitude/timbre stage ─────────────────────
    { id: "egvca", type: "audio_vcv_surgextegxvca", col: 8, row: 0 },
    { id: "surgeVcf", type: "audio_vcv_surgextvcf", col: 8, row: 2 },
    { id: "fade2", type: "audio_vcv_fade", col: 8, row: 4, knobs: { in: 4.6102, out: 6.8169 } },
    // ── COLUMN 9 — the two delays ─────────────────────────────────────────
    { id: "chrono1", type: "audio_vcv_chronoblob2", col: 9, row: 0, knobs: { time: 0.6416, feedback: 0.759, mix: 0.5 } },
    { id: "chrono2", type: "audio_vcv_chronoblob2", col: 9, row: 2, knobs: { time: 0.7199, feedback: 0.3313, mix: 1 } },
    // ── COLUMN 10 — the fade on voice A, and three stereo pairs of LPGs ────
    { id: "fade1", type: "audio_vcv_fade", col: 10, row: 0, knobs: { in: 0.9425, out: 0.9127 } },
    // Tangents' param 0 is the Cutoff CV, so it is converted out of Vult's own 0…1 CV
    // domain into our hertz by their law (`synth/vc10_kernels.vultCvToHz`); param 1 is
    // Resonance. `p4` is a fifth param VC-10 does not model, so it is DROPPED rather than
    // written raw — see the reasoning at vcv-ambient-drone's Tangents.
    { id: "tangent1", type: "audio_vcv_tangents", col: 10, row: 2, knobs: { cutoff: 2533 } },
    { id: "tangent2", type: "audio_vcv_tangents", col: 10, row: 3, knobs: { cutoff: 1730 } },
    { id: "tangent3", type: "audio_vcv_tangents", col: 10, row: 4, knobs: { cutoff: 8228 } },
    { id: "tangent4", type: "audio_vcv_tangents", col: 10, row: 5, knobs: { cutoff: 1532 } },
    { id: "tangent5", type: "audio_vcv_tangents", col: 10, row: 6, knobs: { cutoff: 1642, resonance: 0.1575 } },
    { id: "tangent6", type: "audio_vcv_tangents", col: 10, row: 7, knobs: { cutoff: 1559, resonance: 0.1625 } },
    // ── COLUMN 11 — the granulator and the remaining fades ────────────────
    { id: "simpl", type: "audio_vcv_simpliciter", col: 11, row: 0 },
    { id: "fade3", type: "audio_vcv_fade", col: 11, row: 2, knobs: { in: 10, out: 3 } },
    { id: "fade5", type: "audio_vcv_fade", col: 11, row: 4, knobs: { in: 3, out: 10 } },
    { id: "fade6", type: "audio_vcv_fade", col: 11, row: 6, knobs: { in: 4.7892, out: 6.3398 } },
    // ── COLUMNS 12-15 — the bus, the send, the return, the master ──────────
    { id: "fade4", type: "audio_vcv_fade", col: 12, row: 0, knobs: { in: 5.0575, out: 8.6358 } },
    { id: "stripA", type: "audio_mixer", col: 12, row: 3, knobs: { level1: 0.9, level2: 0.8, level3: 0.8, level4: 0.7, master: 1 } },
    { id: "stripB", type: "audio_mixer", col: 13, row: 0, knobs: { level1: 1, level2: 0.7, level3: 0.7, level4: 0.8, master: 1 } },
    { id: "plateau", type: "audio_vcv_plateau", col: 14, row: 0, knobs: { wet: 1, input_low_damp: 7.039, input_high_damp: 10, size: 0.5, diffusion: 10, decay: 0.4483, reverb_high_damp: 10, reverb_low_damp: 7.4805, mod_shape: 0.5, mod_depth: 4.5312 } },
    { id: "master", type: "audio_mixer", col: 15, row: 0, knobs: { level1: 0.9, level2: 0.7, level3: 0.7, master: 1 } },
    ...analysisTail(16),
  ],
  wires: [
    // ── ONE PRESS STARTS THE MACHINE ───────────────────────────────────────
    { from: "start", fromPort: "out", to: "burst", toPort: "trigger" },
    { from: "start", fromPort: "out", to: "sh1", toPort: "trigger2" },
    { from: "start", fromPort: "out", to: "sh4", toPort: "trigger1" },
    // …and the independent reseed clock is what keeps re-rolling the burst's own
    // settings, standing in for the self-patch our acyclic graph cannot express.
    { from: "reseed", fromPort: "out", to: "reseedEdge", toPort: "in" },
    { from: "reseedEdge", fromPort: "out", to: "sh1", toPort: "trigger1" },
    // ── THE NOISE FLOOR EVERY S&H SAMPLES. Bogaudio's SampleHold falls back to an
    // internal noise source when its input is unpatched; we have no
    // connectedness signal, so the noise is patched explicitly — which is also
    // the honest picture of where the randomness comes from.
    { from: "noise", fromPort: "out", to: "sh1", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh1", toPort: "in2" },
    { from: "noise", fromPort: "out", to: "sh4", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh4", toPort: "in2" },
    { from: "noise", fromPort: "out", to: "sh2", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh2", toPort: "in2" },
    { from: "noise", fromPort: "out", to: "sh3", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh7", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh7", toPort: "in2" },
    { from: "noise", fromPort: "out", to: "sh6", toPort: "in2" },
    // ── THE SLOW MODULATORS, each sampled by a different clock so no two land
    // on the same value twice.
    { from: "walk", fromPort: "out", to: "sh3", toPort: "in2" },
    { from: "walk", fromPort: "out", to: "sh5", toPort: "in1" },
    { from: "walk", fromPort: "out", to: "compare", toPort: "a" },
    { from: "llfoSlow", fromPort: "out", to: "sh5", toPort: "in2" },
    { from: "llfoSlow", fromPort: "out", to: "surgeVcf", toPort: "vcf_mod_0" },
    { from: "llfoFast", fromPort: "out", to: "sh6", toPort: "in1" },
    { from: "llfoFast", fromPort: "out", to: "fadeMix3", toPort: "in1" },
    { from: "llfoFast", fromPort: "out", to: "fadeMix4", toPort: "in2" },
    // Caudal's twelve outputs are four (x, y, angle) triples, so index 0 and index 3 are
    // segment 1's and segment 2's X — the same map vcv-microcosm and vcv-ambient-drone use.
    { from: "caudal", fromPort: "x_1", to: "wtOsc", toPort: "osc_mod_0" },
    { from: "caudal", fromPort: "x_2", to: "wtOsc", toPort: "osc_mod_1" },
    // ── THE BURST GENERATOR'S OWN SETTINGS ARE HELD RANDOM VALUES ──────────
    { from: "sh1", fromPort: "out1", to: "burst", toPort: "rate_cv" },
    { from: "sh1", fromPort: "out2", to: "burst", toPort: "pulses_cv" },
    // …and so are the sequencer's length and tempo.
    { from: "sh4", fromPort: "out1", to: "seq3", toPort: "steps" },
    { from: "sh4", fromPort: "out2", to: "seq3", toPort: "tempo" },
    // ── EVERY PULSE OF THE BURST SNAPSHOTS THE WHOLE PATCH ────────────────
    { from: "burst", fromPort: "pulses", to: "sh2", toPort: "trigger1" },
    { from: "burst", fromPort: "pulses", to: "sh3", toPort: "trigger1" },
    { from: "burst", fromPort: "pulses", to: "egvca", toPort: "gate_in" },
    { from: "burst", fromPort: "end", to: "sh7", toPort: "trigger1" },
    { from: "burst", fromPort: "end", to: "evt1", toPort: "trigger" },
    { from: "burst", fromPort: "end", to: "evt2", toPort: "trigger" },
    { from: "burst", fromPort: "end", to: "fadeMix1", toPort: "in2" },
    { from: "burst", fromPort: "end", to: "fadeMix2", toPort: "in2" },
    { from: "burst", fromPort: "duration", to: "fade1", toPort: "ctrl" },
    { from: "burst", fromPort: "start", to: "simpl", toPort: "trig" },
    // ── THE SEQ3 DRIVES ONE VOICE AND NOTHING ELSE ────────────────────────
    { from: "seq3", fromPort: "trig", to: "fmop", toPort: "gate" },
    { from: "seq3", fromPort: "trig", to: "sh5", toPort: "trigger1" },
    { from: "seq3", fromPort: "clock", to: "sh6", toPort: "trigger1" },
    { from: "seq3", fromPort: "clock", to: "sah2", toPort: "trig" },
    { from: "seq3", fromPort: "cv1", to: "sah2", toPort: "sample" },
    { from: "seq3", fromPort: "cv2", to: "cvmix", toPort: "in2" },
    { from: "seq3", fromPort: "run", to: "evt1", toPort: "clock" },
    { from: "seq3", fromPort: "run", to: "chrono2", toPort: "sync" },
    // ── THE PITCH MATERIAL: a probabilistic hold plus a sequencer row plus a
    // held random value, mixed, then quantized TWICE on two different scales.
    { from: "sah2", fromPort: "sample", to: "cvmix", toPort: "in1" },
    { from: "sh2", fromPort: "out1", to: "cvmix", toPort: "in3" },
    // A held value on the mixer's LEVEL, not on its input — so how much of the
    // random pitch reaches the quantizer is itself re-rolled every burst.
    { from: "sh2", fromPort: "out2", to: "cvmix", toPort: "level3" },
    { from: "cvmix", fromPort: "out", to: "quant", toPort: "in" },
    { from: "quant", fromPort: "out", to: "sineOsc", toPort: "pitch_cv" },
    { from: "quant", fromPort: "out", to: "quant2", toPort: "in" },
    { from: "quant2", fromPort: "out", to: "wtOsc", toPort: "pitch_cv" },
    { from: "quant2", fromPort: "out", to: "fmop", toPort: "pitch" },
    // ── VOICE A — Surge sine → Surge EGxVCA → delay → fade → granulator ───
    { from: "sh3", fromPort: "out1", to: "sineOsc", toPort: "osc_mod_0" },
    { from: "sh3", fromPort: "out2", to: "egvca", toPort: "mod_0" },
    { from: "sineOsc", fromPort: "output_l", to: "egvca", toPort: "input_l" },
    { from: "sineOsc", fromPort: "output_r", to: "egvca", toPort: "input_r" },
    { from: "egvca", fromPort: "output_l", to: "chrono1", toPort: "in_l" },
    { from: "egvca", fromPort: "output_r", to: "chrono1", toPort: "in_r" },
    { from: "chrono1", fromPort: "out_l", to: "fade1", toPort: "l" },
    { from: "chrono1", fromPort: "out_r", to: "fade1", toPort: "r" },
    { from: "fade1", fromPort: "l", to: "simpl", toPort: "in_l" },
    { from: "fade1", fromPort: "r", to: "simpl", toPort: "in_r" },
    { from: "simpl", fromPort: "out_l", to: "fade4", toPort: "l" },
    { from: "simpl", fromPort: "out_r", to: "fade4", toPort: "r" },
    // ── VOICE B — Surge wavetable → Surge VCF → delay → two LPG pairs ─────
    { from: "wtOsc", fromPort: "output_l", to: "surgeVcf", toPort: "input_l" },
    { from: "wtOsc", fromPort: "output_r", to: "surgeVcf", toPort: "input_r" },
    { from: "surgeVcf", fromPort: "output_l", to: "chrono2", toPort: "in_l" },
    { from: "surgeVcf", fromPort: "output_r", to: "chrono2", toPort: "in_r" },
    // Tangents' inlets are LP, BP, HP, cutoff CV, so index 1 is the BANDPASS input and
    // index 3 is the cutoff. Transcribed as found rather than moved to the lowpass a pad
    // would normally take: the manual's own note on the bandpass is that "when modulated
    // magic happens", and the sample-and-hold on the next line is what modulates it.
    { from: "chrono2", fromPort: "out_l", to: "tangent1", toPort: "bp_in" },
    { from: "chrono2", fromPort: "out_r", to: "tangent2", toPort: "bp_in" },
    { from: "sh6", fromPort: "out1", to: "tangent1", toPort: "cutoff" },
    { from: "sh6", fromPort: "out2", to: "tangent2", toPort: "cutoff" },
    { from: "tangent1", fromPort: "out", to: "fade3", toPort: "l" },
    { from: "tangent2", fromPort: "out", to: "fade3", toPort: "r" },
    { from: "surgeVcf", fromPort: "output_l", to: "tangent3", toPort: "bp_in" },
    { from: "surgeVcf", fromPort: "output_r", to: "tangent4", toPort: "bp_in" },
    { from: "tangent3", fromPort: "out", to: "fade5", toPort: "l" },
    { from: "tangent4", fromPort: "out", to: "fade5", toPort: "r" },
    // The third pair takes voice A's DELAY tail, so the granulator and the gates
    // hear the same echo differently — which is how the patch gets its width.
    { from: "chrono1", fromPort: "out_l", to: "tangent5", toPort: "bp_in" },
    { from: "chrono1", fromPort: "out_r", to: "tangent6", toPort: "bp_in" },
    { from: "tangent5", fromPort: "out", to: "fade6", toPort: "l" },
    { from: "tangent6", fromPort: "out", to: "fade6", toPort: "r" },
    // ── VOICE C — the FM operator, its feedback and sustain freshly held ──
    { from: "sh5", fromPort: "out1", to: "fmop", toPort: "feedback_cv" },
    { from: "sh5", fromPort: "out2", to: "fmop", toPort: "sustain_cv" },
    { from: "fmop", fromPort: "audio", to: "fade2", toPort: "l" },
    // ── WHAT DECIDES WHICH VOICES ARE AUDIBLE RIGHT NOW ──────────────────
    // Each fade's control is a MIX of an event timer's end pulse and the burst's,
    // or of the comparator's two sides — so voices come and go on unrelated
    // schedules and the texture never settles.
    { from: "evt1", fromPort: "end", to: "fadeMix1", toPort: "in1" },
    { from: "evt2", fromPort: "end", to: "fadeMix2", toPort: "in1" },
    { from: "compare", fromPort: "greater", to: "fadeMix3", toPort: "in2" },
    { from: "compare", fromPort: "less", to: "fadeMix4", toPort: "in1" },
    { from: "fadeMix1", fromPort: "out", to: "fade2", toPort: "ctrl" },
    { from: "fadeMix2", fromPort: "out", to: "fade3", toPort: "ctrl" },
    { from: "fadeMix3", fromPort: "out", to: "fade5", toPort: "ctrl" },
    { from: "fadeMix4", fromPort: "out", to: "fade6", toPort: "ctrl" },
    // ── THE BUS, AND THE SEND/RETURN AS A DAG ───────────────────────────
    { from: "fade2", fromPort: "l", to: "stripA", toPort: "in1" },
    { from: "fade3", fromPort: "l", to: "stripA", toPort: "in2" },
    { from: "fade3", fromPort: "r", to: "stripA", toPort: "in3" },
    { from: "fade5", fromPort: "l", to: "stripA", toPort: "in4" },
    { from: "stripA", fromPort: "out", to: "stripB", toPort: "in1" },
    { from: "fade5", fromPort: "r", to: "stripB", toPort: "in2" },
    { from: "fade6", fromPort: "l", to: "stripB", toPort: "in3" },
    { from: "fade4", fromPort: "l", to: "stripB", toPort: "in4" },
    // THE SEND: the whole strip mix into Plateau, both channels.
    { from: "stripB", fromPort: "out", to: "plateau", toPort: "in_l" },
    { from: "stripB", fromPort: "out", to: "plateau", toPort: "in_r" },
    // A fresh random reverb size and decay on every burst — the one thing in the
    // original's unseen tail that this patch would be poorer without.
    { from: "sh7", fromPort: "out1", to: "plateau", toPort: "decay" },
    { from: "sh7", fromPort: "out2", to: "plateau", toPort: "size" },
    // THE RETURN: dry on channel 1, the reverb's two channels on 2 and 3.
    { from: "stripB", fromPort: "out", to: "master", toPort: "in1" },
    { from: "plateau", fromPort: "out_l", to: "master", toPort: "in2" },
    { from: "plateau", fromPort: "out_r", to: "master", toPort: "in3" },
    ...analysisWires("master", "out"),
  ],
};

/**
 * P5 — INCANTA (Massi). 105 module instances, 236 cables, SEVEN hard families — the
 * broadest single patch in R7-17-SEL, and the one that justifies most of the Bogaudio
 * modulation vocabulary in a single stroke.
 *
 * ── THE PARALLELISM *IS* THE PATCH, so nothing here is folded ───────────────
 * FOUR Clouds run as four separate granular voices and THREE Rings as three separate
 * resonators. EIGHT FM-OP operators supply the metallic layer as two banks of four (three
 * carriers plus one modulator each). EIGHT Walk2 two-dimensional random walkers and NINE
 * addressed sequencers form a modulation farm in which **no two sources share a rate** —
 * the mutually-irrational-LFO trick done at scale, and the reason a patch built from
 * eight-step tables never audibly repeats. Collapsing any of those counts would produce a
 * patch that sounds like Incanta for thirty seconds and then starts repeating, which is
 * exactly the thing it is famous for not doing.
 *
 * ── HOW A 2-D WALKER ADDRESSES A SEQUENCER, WHICH IS THE TRICK WORTH SEEING ─
 * ADDR-SEQ is not clocked through its steps; it is ADDRESSED — `select_cv` picks which of
 * eight stored values is showing. Here each walker's `distance` output does the picking, so
 * the "melody" is a smooth two-dimensional drift being read through an eight-note table.
 * That is why the notes are always in the scale and the ORDER is never the same twice.
 *
 * ── AND THE THREE-VOICE HARMONY MACHINE ─────────────────────────────────────
 * Per voice group: two of its three sequencers go through Fundamental Quantizers on
 * DIFFERENT twelve-note masks, the third stays chromatic, and a Sequential Switch clocked
 * by a Boolean AND of all three clocks chooses which of the three is currently the pitch.
 * The harmony therefore modulates without anything choosing to modulate it.
 */
export const VCV_INCANTA = {
  id: "vcv-incanta",
  title: "VCV Incanta",
  help: "The broadest patch in the set: four Clouds granulators and three Rings resonators as SEVEN parallel voices, eight FM operators, and a modulation farm of eight two-dimensional random walkers addressing nine eight-step tables so that no two sources ever share a rate. It plays itself and it does not repeat. Press Reset to re-align the tables; turn any walker's Rate X to change how fast the harmony drifts.",
  source: {
    patch: "patchstorage 151546", file: "Incanta6.vcv",
    author: "Massi", popularity: "1271 dl / 23 likes / 1749 views",
    distinct: 37, families: ["granular", "FDN/plate reverb", "wavetable", "physical modelling", "FM", "chaotic/generative sequencing", "polyphony/voice allocation"],
  },
  deviations: [
    "POLYPHONIC CABLES DO NOT EXIST HERE, and this is the largest deviation in the patch. Incanta merges each group's three sequencers onto ONE polyphonic cable, quantizes and switches it as a chord, then splits it back out — so Fundamental/Merge x3 and Split x3 are DROPPED, and the poly Quantizer/SequentialSwitch pairs become PER-VOICE ones. What is preserved: three independent pitch lines per group (the chord), two different twelve-note masks, and the switch that alternates between them. What is lost: the alternation used to happen to all three voices at the same instant.",
    "R7-UNITS: ADDR-SEQ's step CV is a generic +/-1 and FM-OP's pitch reads SEMITONES, so the chain the original could wire straight needs a SCALER. `pitchNum` (a Number node holding 12) and `pitchMul1..3` (Math nodes on multiply) are that scaler, one per voice group, and they are nodes the original does not have. Without them the whole patch would drift inside a single semitone — audible as a drone rather than as a tune, with nothing to see.",
    "ImpromptuModular/Clocked substituted by THREE audio_clock + audio_trigger pairs at 70, 35 and 105 bpm. Clocked is one module with four ratio-divided outputs; three clocks at those ratios is the same distribution of edges, and it keeps the property the patch depends on — that the three voice groups advance at unrelated rates. What is lost is Clocked's run/reset transport and its BPM display.",
    "AS/TriggersMKIII substituted by our node_button, wired to every sequencer's Reset — it is the patch's one manual control. CONSEQUENCE: a rendered export never sees the press (core/control_nodes.js); the three clocks are recordable and do run.",
    "MindMeld MixMasterJr + AuxExpanderJr substituted by our audio_mixer, and EqMaster by our audio_eq3 (three bands instead of four; the harvested gains 2.5/3.2/3.7 dB carried across). The send/return is the acyclic dry+wet shape this file's header describes.",
    "Bogaudio-Mix4 x5 are the REAL ported node (VC-3a landed while this was being written), so they are not a substitution — but the fifth one is repurposed as the modulation summer feeding the two Feline cutoffs, because the survey printed only 70 of 236 cables and its original destination is in the unseen 166.",
    "Core/AudioInterface2 substituted by audio_output; VCV-Recorder, JW-Modules/Tree x4, Core/Blank x3, Bogaudio-Blank6 x3 and CountModula/Blank2HP x2 dropped as furniture (Tree is a drawing, not a sound). Fundamental/Noise substituted by audio_noise; Fundamental/LFO2 (the wavetable LFO) by audio_lfo at its harvested 0.0217 Hz, its wavetable position 0.096 being within a hair of a sine.",
    "Dial conversions applied: the four LLFO frequencies became 0.42345 / 0.605904 / 0.225604 / 0.24341 Hz from their raws −2.2711 / −1.7542 / −3.1795 / −3.0699 through `bogaudioSemitonesToHz(12·(v − 7))`. THIS LINE USED TO READ `2^v/100`, which is not Bogaudio's reference and not an octave offset of anything, and it also stated the rate AFTER Slow's ÷16 in a knob that means the rate BEFORE it — two independent errors compounding to 204×, which put all four below the knob's own 0.0639 Hz minimum. Every FM-OP envelope stage became seconds via Bogaudio's own v²·10; ADDR-SEQ's `steps` raws were rounded to the integer step COUNT they are and `direction` became the discrete \"forward\". Pressor's threshold and gains are in DECIBELS in the ported spec and their raw 0..1 knob positions are not convertible without Bogaudio's curve, so only its ratio and detector mix are set.",
    "Chronoblob2's TIME knob is stated in SECONDS by the landed spec; the harvested 0.612 is a 0..1 knob position and Chronoblob2 has no public source, so 0.612 s is carried across as the same order of magnitude rather than as an exact conversion.",
  ],
  nodes: [
    // ── COLUMN 0 — the transport, the noise floor, and the modulation farm ──
    { id: "btn", type: "node_button", col: 0, row: 0, knobs: { label: "Reset" } },
    // THREE CLOCKS AT UNRELATED RATES, standing in for Clocked's ratio outputs.
    { id: "clkA", type: "audio_clock", col: 0, row: 1, knobs: { bpm: 70 } },
    { id: "clkB", type: "audio_clock", col: 0, row: 2, knobs: { bpm: 35 } },
    { id: "clkC", type: "audio_clock", col: 0, row: 3, knobs: { bpm: 105 } },
    { id: "noise", type: "audio_noise", col: 0, row: 4, knobs: { color: "white", level: 0.5 } },
    // EIGHT 2-D WALKERS. Every rate is different on purpose — see the docblock.
    // camelCase, not snake_case: Bogaudio is open and VC-3b spelled every one of these
    // from its own `ParamsIds` (RATE_X_PARAM, SCALE_X_PARAM, …). Same knobs, same values.
    { id: "w1", type: "audio_vcv_walk2", col: 0, row: 5, knobs: { rateX: 0.3024, rateY: 0.3265, scaleX: 0.9735, scaleY: 1 } },
    { id: "w2", type: "audio_vcv_walk2", col: 0, row: 6, knobs: { rateX: 0.4048, rateY: 0.347, scaleX: 1, scaleY: 1 } },
    { id: "w3", type: "audio_vcv_walk2", col: 0, row: 7, knobs: { rateX: 0.4048, rateY: 0.347, scaleX: 1, scaleY: 1 } },
    { id: "w4", type: "audio_vcv_walk2", col: 0, row: 8, knobs: { rateX: 0.3024, rateY: 0.3265, scaleX: 1, scaleY: 1 } },
    { id: "w5", type: "audio_vcv_walk2", col: 0, row: 9, knobs: { rateX: 0.3024, rateY: 0.3265, scaleX: 1, scaleY: 1 } },
    { id: "w6", type: "audio_vcv_walk2", col: 0, row: 10, knobs: { rateX: 0.4048, rateY: 0.347, scaleX: 1, scaleY: 1 } },
    { id: "w7", type: "audio_vcv_walk2", col: 0, row: 11, knobs: { rateX: 0.2217, rateY: 0.2506, scaleX: 1, scaleY: 1 } },
    { id: "w8", type: "audio_vcv_walk2", col: 0, row: 12, knobs: { rateX: 0.3036, rateY: 0.3373, scaleX: 1, scaleY: 1 } },
    // FOUR LLFOs IN SLOW MODE, one cycle every 26 to 71 seconds — and the RATE KNOB IS
    // THE RATE BEFORE Slow's ÷16, which is what these four used to get wrong. Their raws
    // are −2.2711 / −1.7542 / −3.1795 / −3.0699 (survey_vcv.md) through VC-3b's own
    // `bogaudioSemitonesToHz(12·(v − 7))`; the numbers here before were those raws through
    // `2^v/100`, which is neither Bogaudio's reference nor any octave offset of it, and
    // which additionally stated the POST-÷16 rate so `LlfoKernel.control` divided again.
    { id: "l1", type: "audio_vcv_llfo", col: 0, row: 13, knobs: { frequency: 0.42345, slow: "on", offset: 1, scale: 1 } },
    { id: "l2", type: "audio_vcv_llfo", col: 0, row: 14, knobs: { frequency: 0.605904, slow: "on", offset: 1, scale: 1 } },
    { id: "l3", type: "audio_vcv_llfo", col: 0, row: 15, knobs: { frequency: 0.225604, slow: "on", offset: 1, scale: 1 } },
    { id: "l4", type: "audio_vcv_llfo", col: 0, row: 16, knobs: { frequency: 0.24341, slow: "on", offset: 1, scale: 1 } },
    { id: "lfo2a", type: "audio_lfo", col: 0, row: 17, knobs: { frequency: 0.0217, depth: 1, waveform: "sine" } },
    { id: "lfo2b", type: "audio_lfo", col: 0, row: 18, knobs: { frequency: 0.0217, depth: 1, waveform: "triangle" } },
    { id: "lfo2c", type: "audio_lfo", col: 0, row: 19, knobs: { frequency: 0.0217, depth: 1, waveform: "sine" } },
    { id: "csimpler", type: "audio_vcv_complexsimpler", col: 0, row: 20, knobs: { p0: 1, p4: 1 } },
    // ── COLUMN 1 — edges, and the three Blinds banks that turn walks into CV ─
    { id: "edgeA", type: "audio_trigger", col: 1, row: 0, knobs: { pulseMs: 5 } },
    { id: "edgeB", type: "audio_trigger", col: 1, row: 1, knobs: { pulseMs: 5 } },
    { id: "edgeC", type: "audio_trigger", col: 1, row: 2, knobs: { pulseMs: 5 } },
    { id: "blinds1", type: "audio_vcv_blinds", col: 1, row: 3, knobs: { mod1: 1, mod2: 1, mod3: 0.9947, mod4: 0.864 } },
    { id: "blinds2", type: "audio_vcv_blinds", col: 1, row: 4, knobs: { mod1: 1, mod2: 1, mod3: 0.9947, mod4: 0.864 } },
    { id: "blinds3", type: "audio_vcv_blinds", col: 1, row: 5, knobs: { mod1: 1, mod2: 1, mod3: 0.9947, mod4: 0.864 } },
    { id: "sh4", type: "audio_vcv_samplehold", col: 1, row: 6 },
    // ── COLUMN 2 — the clock logic, and NINE addressed sequencers ───────────
    { id: "and1", type: "audio_vcv_booleanand", col: 2, row: 0 },
    { id: "and2", type: "audio_vcv_booleanand", col: 2, row: 1 },
    { id: "and3", type: "audio_vcv_booleanand", col: 2, row: 2 },
    { id: "seq1", type: "audio_vcv_addrseq", col: 2, row: 3, knobs: { steps: 3, direction: "forward", step1: 0.721, step2: -0.075, step3: -0.2699, step4: 0.4369, step5: 0.7297, step6: -0.5758, step7: -0.6455, step8: -0.8634 } },
    { id: "seq2", type: "audio_vcv_addrseq", col: 2, row: 4, knobs: { steps: 5, direction: "forward", step1: 0.5832, step2: -0.6673, step3: 0.6448, step4: 0.3639, step5: -0.0525, step6: -0.2806, step7: -0.1192, step8: 0.6631 } },
    { id: "seq3", type: "audio_vcv_addrseq", col: 2, row: 5, knobs: { steps: 7, direction: "forward", step1: 0.4995, step2: 0.7001, step3: -0.0282, step4: -0.7418, step5: 0.5078, step6: -0.933, step7: -0.5456, step8: -0.7817 } },
    { id: "seq4", type: "audio_vcv_addrseq", col: 2, row: 6, knobs: { steps: 3, step1: 0.6842, step2: -0.1443, step3: 0.7537, step4: -0.773, step5: -0.9364, step6: 0.3501, step7: 0.8912, step8: 0.3648 } },
    { id: "seq5", type: "audio_vcv_addrseq", col: 2, row: 7, knobs: { steps: 7, direction: "forward", step1: 0.6051, step2: 0.393, step3: 0.0503, step4: -0.2109, step5: -0.9892, step6: 0.8833, step7: 0.1785, step8: 0.68 } },
    { id: "seq6", type: "audio_vcv_addrseq", col: 2, row: 8, knobs: { steps: 4, step1: 0.6725, step2: -0.5394, step3: -0.8277, step4: -0.0684, step5: -0.3566, step6: 0.2243, step7: 0.6621, step8: 0.2508 } },
    { id: "seq7", type: "audio_vcv_addrseq", col: 2, row: 9, knobs: { steps: 6, direction: "forward", step1: 0.2857, step2: -0.8185, step3: 0.1097, step4: -0.0121, step5: 0.1443, step6: -0.5037, step7: -0.2801, step8: 0.0186 } },
    { id: "seq8", type: "audio_vcv_addrseq", col: 2, row: 10, knobs: { steps: 3, step1: -0.8841, step2: -0.631, step3: 0.937, step4: -0.7813, step5: -0.0417, step6: -0.119, step7: 0.3979, step8: -0.1331 } },
    { id: "seq9", type: "audio_vcv_addrseq", col: 2, row: 11, knobs: { steps: 7, step1: 0.9734, step2: -0.2918, step3: -0.4285, step4: 0.6098, step5: -0.9206, step6: 0.8935, step7: 0.4136, step8: 0.3508 } },
    // ── COLUMN 3 — six sample-and-hold pairs, one per clock, twice over ─────
    { id: "sh1", type: "audio_vcv_samplehold", col: 3, row: 0 },
    { id: "sh2", type: "audio_vcv_samplehold", col: 3, row: 1 },
    { id: "sh3", type: "audio_vcv_samplehold", col: 3, row: 2 },
    { id: "sh5", type: "audio_vcv_samplehold", col: 3, row: 4 },
    { id: "sh6", type: "audio_vcv_samplehold", col: 3, row: 5 },
    // ── COLUMN 4 — three coin flips deciding which voice each event strikes ─
    { id: "br1", type: "audio_vcv_branches", col: 4, row: 0, knobs: { p1: 0.688, p2: 0.5 } },
    { id: "br2", type: "audio_vcv_branches", col: 4, row: 1, knobs: { p1: 0.747, p2: 0.5 } },
    { id: "br3", type: "audio_vcv_branches", col: 4, row: 2, knobs: { p1: 0.6843, p2: 0.5 } },
    // ── COLUMN 5 — six mask quantizers, two per voice group on two masks ────
    { id: "q1", type: "audio_vcv_quantizer", col: 5, row: 0 },
    { id: "q2", type: "audio_vcv_quantizer", col: 5, row: 1 },
    { id: "q3", type: "audio_vcv_quantizer", col: 5, row: 2 },
    { id: "q4", type: "audio_vcv_quantizer", col: 5, row: 3 },
    { id: "q5", type: "audio_vcv_quantizer", col: 5, row: 4 },
    { id: "q6", type: "audio_vcv_quantizer", col: 5, row: 5 },
    // ── COLUMN 6 — and the switch that alternates between the two masks ────
    // `steps: 1` IS THREE STEPS, and the 3 that was here was the count. Rack stores a
    // SWITCH POSITION: `configSwitch(STEPS_PARAM, 0, 2, 2, "Steps", {"2","3","4"})` and
    // `length = 2 + int(value)`, so 0/1/2 cycle two/three/four inputs and 3 is off the
    // end of the param entirely. Caught by the blueprint range check.
    { id: "sw1", type: "audio_vcv_sequentialswitch2", col: 6, row: 0, knobs: { steps: 1 } },
    { id: "sw2", type: "audio_vcv_sequentialswitch2", col: 6, row: 1, knobs: { steps: 1 } },
    { id: "sw3", type: "audio_vcv_sequentialswitch2", col: 6, row: 2, knobs: { steps: 1 } },
    // ── COLUMNS 7-8 — THE R7-UNITS SCALER, and it is deliberately VISIBLE ──
    // A sequencer step is a generic +/-1 CV; a V/oct port reads semitones. One shared
    // constant and one multiply per group is the whole conversion, on the canvas where
    // an author can see why the tune has the range it has.
    { id: "pitchNum", type: "node_number", col: 7, row: 0, knobs: { value: 12 } },
    { id: "pitchMul1", type: "node_math", col: 8, row: 0, knobs: { op: "multiply" } },
    { id: "pitchMul2", type: "node_math", col: 8, row: 1, knobs: { op: "multiply" } },
    { id: "pitchMul3", type: "node_math", col: 8, row: 2, knobs: { op: "multiply" } },
    // ── COLUMN 9 — EIGHT FM OPERATORS as two banks of four, plus the analogue pair ─
    { id: "fmop1", type: "audio_vcv_fmop", col: 9, row: 0, knobs: { attack: 0.0429, decay: 1.0543, sustain: 1, release: 0.9998, feedback: 0.4795, level: 0.8434, envToLevel: "on" } },
    { id: "fmop2", type: "audio_vcv_fmop", col: 9, row: 1, knobs: { attack: 0.0261, decay: 0.9998, sustain: 0.8301, release: 0.9998, feedback: 0.4181, level: 0.6313, envToLevel: "on" } },
    { id: "fmop3", type: "audio_vcv_fmop", col: 9, row: 2, knobs: { attack: 0.044, decay: 0.8117, sustain: 0.512, release: 0.9998, depth: 0.5663, feedback: 0.3723, level: 0.7807, envToLevel: "on" } },
    // fmop4 is a MODULATOR, not a voice: its output goes into fmop3's FM input.
    { id: "fmop4", type: "audio_vcv_fmop", col: 9, row: 3, knobs: { attack: 0.0511, decay: 0.9998, sustain: 1, release: 0.9998, feedback: 0.3952, level: 0.9012, envToLevel: "on" } },
    { id: "fmop5", type: "audio_vcv_fmop", col: 9, row: 4, knobs: { attack: 0.0937, decay: 1.0543, sustain: 1, release: 1.3542, feedback: 0.6289, level: 0.8434, envToLevel: "on" } },
    { id: "fmop6", type: "audio_vcv_fmop", col: 9, row: 5, knobs: { attack: 0.0494, decay: 0.9998, sustain: 0.8301, release: 2.728, feedback: 0.6277, level: 0.8783, envToLevel: "on" } },
    { id: "fmop7", type: "audio_vcv_fmop", col: 9, row: 6, knobs: { attack: 0.0632, decay: 0.8117, sustain: 0.512, release: 2.1344, depth: 0.5663, feedback: 0.4867, level: 0.7807, envToLevel: "on" } },
    { id: "fmop8", type: "audio_vcv_fmop", col: 9, row: 7, knobs: { attack: 0.101, decay: 0.9998, sustain: 1, release: 2.506, feedback: 0.2205, level: 0.9012, envToLevel: "on" } },
    { id: "xco", type: "audio_vcv_xco", col: 9, row: 8, knobs: { frequency: 3, fmDepth: 0.1253, squarePw: 0.3927, squareMix: 0.9614, sawMix: 1, triangleMix: 1, sineMix: 1 } },
    { id: "bogvco", type: "audio_vcv_bog_vco", col: 9, row: 9, knobs: { frequency: 1, pw: 0.2217 } },
    // ── COLUMN 10 — the FM banks' stereo mixes, THREE Rings, and the VCF ───
    { id: "mix1", type: "audio_vcv_mix4", col: 10, row: 0, knobs: { level1: 0.8651, pan1: -0.9687, level2: 0.7801, pan2: 0.8145, level3: 0.8541, pan3: -0.8988, level4: 0.9091, pan4: 0.9952, mix: 0.8801 } },
    { id: "mix2", type: "audio_vcv_mix4", col: 10, row: 1, knobs: { level1: 0.8651, pan1: -0.9687, level2: 0.8731, pan2: 0.8145, level3: 0.8541, pan3: -0.8988, level4: 0.9091, pan4: 0.9952, mix: 0.8951 } },
    { id: "rings1", type: "audio_vcv_rings", col: 10, row: 2, knobs: { structure: 0.5, brightness: 0.4422, damping: 0.6602, position: 0.6747, polyphony: "2", model: "modal" } },
    { id: "rings2", type: "audio_vcv_rings", col: 10, row: 3, knobs: { structure: 0.5, brightness: 0.3807, damping: 0.488, position: 0.2518, polyphony: "2", model: "sympathetic" } },
    { id: "rings3", type: "audio_vcv_rings", col: 10, row: 4, knobs: { structure: 0.4831, brightness: 0.4301, damping: 0.412, position: 0.4675, polyphony: "1", model: "sympathetic" } },
    { id: "bogvcf", type: "audio_vcv_bog_vcf", col: 10, row: 5, knobs: { frequencyCvAtten: 0.1036, slope: 0.5222 } },
    // ── COLUMN 11 — the first two granulators, two Ripples, the mod summer ─
    { id: "clouds1", type: "audio_vcv_clouds", col: 11, row: 0, knobs: { position: 0.1373, size: 0.3205, inGain: 0.4229, density: 0.2578, texture: 0.3867, blend: 1, spread: 1, feedback: 0.312, reverb: 0.2843 } },
    { id: "clouds2", type: "audio_vcv_clouds", col: 11, row: 1, knobs: { position: 0.2289, size: 0.3867, pitch: 1, inGain: 0.3723, density: 0.2217, texture: 0.3, blend: 1, spread: 1, feedback: 0.312, reverb: 0.2843 } },
    { id: "ripples1", type: "audio_vcv_ripples", col: 11, row: 2, knobs: { resonance: 0.288, frequency: 5.8228 } },
    { id: "ripples2", type: "audio_vcv_ripples", col: 11, row: 3, knobs: { resonance: 0.2819, frequency: 6.5072 } },
    // THE FIFTH MIX4 as the modulation summer — four walker axes into two filter cutoffs.
    { id: "mix5", type: "audio_vcv_mix4", col: 11, row: 4, knobs: { level1: 0.8621, pan1: -0.9133, level2: 0.8431, pan2: 0.8867, level3: 0.6921, pan3: -1, level4: 0.6651, pan4: 1, mix: 0.8011 } },
    // ── COLUMN 12 — the Rings mix and the two Felines ──────────────────────
    { id: "mix3", type: "audio_vcv_mix4", col: 12, row: 0, knobs: { level1: 0.7501, pan1: -0.1542, level2: 0.7881, pan2: -0.9735, level3: 0.8221, pan3: 1, level4: 0.9091, pan4: 0.9952, mix: 0.8011 } },
    { id: "feline1", type: "audio_vcv_feline", col: 12, row: 1, knobs: { cutoff: 7.66, poles: "4", type: "lowpass" } },
    { id: "feline2", type: "audio_vcv_feline", col: 12, row: 2, knobs: { cutoff: 7.44, poles: "4", type: "lowpass" } },
    // ── COLUMNS 13-14 — granulators three and four ────────────────────────
    { id: "clouds3", type: "audio_vcv_clouds", col: 13, row: 0, knobs: { position: 0.2289, size: 0.3867, pitch: 1, inGain: 0.3723, density: 0.1976, texture: 0.2723, blend: 1, spread: 1, feedback: 0.312, reverb: 0.4012 } },
    { id: "mix4b", type: "audio_vcv_mix4", col: 13, row: 1, knobs: { level1: 0.8621, pan1: -0.9133, level2: 0.8431, pan2: 0.8867, level3: 0.5831, pan3: -1, level4: 0.6101, pan4: 1, mix: 0.8401 } },
    { id: "clouds4", type: "audio_vcv_clouds", col: 14, row: 0, knobs: { position: 0.2072, size: 0.2458, pitch: 1, inGain: 0.3747, density: 0.1976, texture: 0.2723, blend: 1, spread: 1, feedback: 0.312, reverb: 0.4012 } },
    // ── COLUMNS 15-20 — the bus, the EQ, the send/return, the compressor ───
    { id: "busL", type: "audio_mixer", col: 15, row: 0, knobs: { level1: 0.9, level2: 0.9, level3: 0.8, level4: 0.8, master: 1 } },
    { id: "busR", type: "audio_mixer", col: 15, row: 1, knobs: { level1: 0.9, level2: 0.9, level3: 0.8, level4: 0.8, master: 1 } },
    { id: "eq", type: "audio_eq3", col: 16, row: 0, knobs: { low: 2.5, mid: 3.2, high: 3.7 } },
    { id: "chrono", type: "audio_vcv_chronoblob2", col: 17, row: 0, knobs: { time: 0.612, feedback: 0.3469, mix: 1 } },
    { id: "plateau", type: "audio_vcv_plateau", col: 18, row: 0, knobs: { wet: 0.539, input_low_damp: 10, input_high_damp: 10, size: 0.5, diffusion: 10, decay: 0.55, reverb_high_damp: 10, reverb_low_damp: 10, mod_shape: 0.5, mod_depth: 3.5338 } },
    { id: "master", type: "audio_mixer", col: 19, row: 0, knobs: { level1: 0.9, level2: 0.6, level3: 0.6, level4: 0.5, master: 1 } },
    { id: "pressor", type: "audio_vcv_pressor", col: 20, row: 0, knobs: { ratio: 0.8359, detectorMix: 0.3807 } },
    ...analysisTail(21),
  ],
  wires: [
    // ── THE THREE UNRELATED CLOCKS ─────────────────────────────────────────
    { from: "clkA", fromPort: "out", to: "edgeA", toPort: "in" },
    { from: "clkB", fromPort: "out", to: "edgeB", toPort: "in" },
    { from: "clkC", fromPort: "out", to: "edgeC", toPort: "in" },
    // ONE BUTTON RE-ALIGNS EVERY TABLE — the patch's single manual control.
    { from: "btn", fromPort: "out", to: "seq1", toPort: "reset" },
    { from: "btn", fromPort: "out", to: "seq2", toPort: "reset" },
    { from: "btn", fromPort: "out", to: "seq3", toPort: "reset" },
    { from: "btn", fromPort: "out", to: "seq4", toPort: "reset" },
    { from: "btn", fromPort: "out", to: "seq5", toPort: "reset" },
    { from: "btn", fromPort: "out", to: "seq6", toPort: "reset" },
    { from: "btn", fromPort: "out", to: "seq7", toPort: "reset" },
    { from: "btn", fromPort: "out", to: "seq8", toPort: "reset" },
    { from: "btn", fromPort: "out", to: "seq9", toPort: "reset" },
    // Each group's three tables advance on ITS clock.
    { from: "edgeA", fromPort: "out", to: "seq1", toPort: "clock" },
    { from: "edgeA", fromPort: "out", to: "seq2", toPort: "clock" },
    { from: "edgeA", fromPort: "out", to: "seq3", toPort: "clock" },
    { from: "edgeB", fromPort: "out", to: "seq4", toPort: "clock" },
    { from: "edgeB", fromPort: "out", to: "seq5", toPort: "clock" },
    { from: "edgeB", fromPort: "out", to: "seq6", toPort: "clock" },
    { from: "edgeC", fromPort: "out", to: "seq7", toPort: "clock" },
    { from: "edgeC", fromPort: "out", to: "seq8", toPort: "clock" },
    { from: "edgeC", fromPort: "out", to: "seq9", toPort: "clock" },
    // ── THE CLOCK LOGIC. Each AND fires only when all three clocks coincide,
    // which on 70/35/105 bpm is a rare and irregular event — and that is what
    // moves the harmony.
    { from: "edgeA", fromPort: "out", to: "and1", toPort: "a" },
    { from: "edgeB", fromPort: "out", to: "and1", toPort: "b" },
    { from: "edgeC", fromPort: "out", to: "and1", toPort: "c" },
    { from: "edgeB", fromPort: "out", to: "and2", toPort: "a" },
    { from: "edgeC", fromPort: "out", to: "and2", toPort: "b" },
    { from: "edgeA", fromPort: "out", to: "and2", toPort: "c" },
    { from: "edgeC", fromPort: "out", to: "and3", toPort: "a" },
    { from: "edgeA", fromPort: "out", to: "and3", toPort: "b" },
    { from: "edgeB", fromPort: "out", to: "and3", toPort: "c" },
    { from: "and1", fromPort: "and", to: "sw1", toPort: "clock" },
    { from: "and2", fromPort: "and", to: "sw2", toPort: "clock" },
    { from: "and3", fromPort: "and", to: "sw3", toPort: "clock" },
    { from: "and1", fromPort: "and", to: "br1", toPort: "in1" },
    { from: "and2", fromPort: "and", to: "br2", toPort: "in1" },
    { from: "and3", fromPort: "and", to: "br3", toPort: "in1" },
    { from: "and1", fromPort: "inv", to: "br1", toPort: "in2" },
    { from: "and2", fromPort: "inv", to: "br2", toPort: "in2" },
    { from: "and3", fromPort: "inv", to: "br3", toPort: "in2" },
    // ── A WALKER'S DISTANCE ADDRESSES A TABLE. This is the trick — see the docblock.
    { from: "w1", fromPort: "distance", to: "seq1", toPort: "select_cv" },
    { from: "w2", fromPort: "distance", to: "seq2", toPort: "select_cv" },
    { from: "w3", fromPort: "distance", to: "seq3", toPort: "select_cv" },
    { from: "w4", fromPort: "distance", to: "seq4", toPort: "select_cv" },
    { from: "w5", fromPort: "distance", to: "seq5", toPort: "select_cv" },
    { from: "w6", fromPort: "distance", to: "seq6", toPort: "select_cv" },
    { from: "w7", fromPort: "distance", to: "seq7", toPort: "select_cv" },
    { from: "w8", fromPort: "distance", to: "seq8", toPort: "select_cv" },
    // ── THE MODULATION FARM'S OTHER HALF: sixteen walker axes into three Blinds
    // banks (four VCAs each) and one Mix4, which is how a 2-D walk becomes CV
    // with a level you can see.
    { from: "lfo2a", fromPort: "out", to: "blinds1", toPort: "in1" },
    { from: "w1", fromPort: "out_x", to: "blinds1", toPort: "cv1" },
    { from: "lfo2b", fromPort: "out", to: "blinds1", toPort: "in2" },
    { from: "w1", fromPort: "out_y", to: "blinds1", toPort: "cv2" },
    { from: "lfo2c", fromPort: "out", to: "blinds1", toPort: "in3" },
    { from: "w2", fromPort: "out_x", to: "blinds1", toPort: "cv3" },
    { from: "noise", fromPort: "out", to: "blinds1", toPort: "in4" },
    { from: "w2", fromPort: "out_y", to: "blinds1", toPort: "cv4" },
    { from: "lfo2a", fromPort: "out", to: "blinds2", toPort: "in1" },
    { from: "w3", fromPort: "out_x", to: "blinds2", toPort: "cv1" },
    { from: "lfo2b", fromPort: "out", to: "blinds2", toPort: "in2" },
    { from: "w3", fromPort: "out_y", to: "blinds2", toPort: "cv2" },
    { from: "lfo2c", fromPort: "out", to: "blinds2", toPort: "in3" },
    { from: "w4", fromPort: "out_x", to: "blinds2", toPort: "cv3" },
    { from: "l1", fromPort: "out", to: "blinds2", toPort: "in4" },
    { from: "w4", fromPort: "out_y", to: "blinds2", toPort: "cv4" },
    { from: "lfo2a", fromPort: "out", to: "blinds3", toPort: "in1" },
    { from: "w5", fromPort: "out_x", to: "blinds3", toPort: "cv1" },
    { from: "l2", fromPort: "out", to: "blinds3", toPort: "in2" },
    { from: "w5", fromPort: "out_y", to: "blinds3", toPort: "cv2" },
    { from: "l3", fromPort: "out", to: "blinds3", toPort: "in3" },
    { from: "w6", fromPort: "out_x", to: "blinds3", toPort: "cv3" },
    { from: "l4", fromPort: "out", to: "blinds3", toPort: "in4" },
    { from: "w6", fromPort: "out_y", to: "blinds3", toPort: "cv4" },
    { from: "w7", fromPort: "out_x", to: "mix5", toPort: "in1" },
    { from: "w7", fromPort: "out_y", to: "mix5", toPort: "in2" },
    { from: "w8", fromPort: "out_x", to: "mix5", toPort: "in3" },
    { from: "w8", fromPort: "out_y", to: "mix5", toPort: "in4" },
    { from: "mix5", fromPort: "l", to: "feline1", toPort: "cutoff" },
    { from: "mix5", fromPort: "r", to: "feline2", toPort: "cutoff" },
    // ── THE HARMONY MACHINE: two masks and a chromatic third, alternated ────
    { from: "seq1", fromPort: "out", to: "q1", toPort: "pitch" },
    { from: "seq2", fromPort: "out", to: "q2", toPort: "pitch" },
    { from: "seq4", fromPort: "out", to: "q3", toPort: "pitch" },
    { from: "seq5", fromPort: "out", to: "q4", toPort: "pitch" },
    { from: "seq7", fromPort: "out", to: "q5", toPort: "pitch" },
    { from: "seq8", fromPort: "out", to: "q6", toPort: "pitch" },
    { from: "q1", fromPort: "pitch", to: "sw1", toPort: "in1" },
    { from: "q2", fromPort: "pitch", to: "sw1", toPort: "in2" },
    { from: "seq3", fromPort: "out", to: "sw1", toPort: "in3" },
    { from: "q3", fromPort: "pitch", to: "sw2", toPort: "in1" },
    { from: "q4", fromPort: "pitch", to: "sw2", toPort: "in2" },
    { from: "seq6", fromPort: "out", to: "sw2", toPort: "in3" },
    { from: "q5", fromPort: "pitch", to: "sw3", toPort: "in1" },
    { from: "q6", fromPort: "pitch", to: "sw3", toPort: "in2" },
    { from: "seq9", fromPort: "out", to: "sw3", toPort: "in3" },
    // ── AND THE SCALER THE ORIGINAL DID NOT NEED (R7-UNITS) ────────────────
    { from: "pitchNum", fromPort: "out", to: "pitchMul1", toPort: "b" },
    { from: "pitchNum", fromPort: "out", to: "pitchMul2", toPort: "b" },
    { from: "pitchNum", fromPort: "out", to: "pitchMul3", toPort: "b" },
    { from: "sw1", fromPort: "out", to: "pitchMul1", toPort: "a" },
    { from: "sw2", fromPort: "out", to: "pitchMul2", toPort: "a" },
    { from: "sw3", fromPort: "out", to: "pitchMul3", toPort: "a" },
    // ── FM BANK ONE: three carriers and a modulator, all on group 1's pitch ─
    { from: "pitchMul1", fromPort: "out", to: "fmop1", toPort: "pitch" },
    { from: "pitchMul1", fromPort: "out", to: "fmop2", toPort: "pitch" },
    { from: "pitchMul1", fromPort: "out", to: "fmop3", toPort: "pitch" },
    { from: "pitchMul1", fromPort: "out", to: "fmop4", toPort: "pitch" },
    { from: "edgeA", fromPort: "out", to: "fmop1", toPort: "gate" },
    { from: "br1", fromPort: "out1a", to: "fmop2", toPort: "gate" },
    { from: "br1", fromPort: "out2a", to: "fmop3", toPort: "gate" },
    { from: "br1", fromPort: "out1b", to: "fmop4", toPort: "gate" },
    // THE OPERATOR PAIR: fmop4 is not heard directly — it IS fmop3's timbre.
    { from: "fmop4", fromPort: "audio", to: "fmop3", toPort: "fm" },
    { from: "fmop1", fromPort: "audio", to: "mix1", toPort: "in1" },
    { from: "fmop2", fromPort: "audio", to: "mix1", toPort: "in2" },
    { from: "fmop3", fromPort: "audio", to: "mix1", toPort: "in3" },
    // ── FM BANK TWO, the same shape on group 2's pitch and group 2's clock ─
    { from: "pitchMul2", fromPort: "out", to: "fmop5", toPort: "pitch" },
    { from: "pitchMul2", fromPort: "out", to: "fmop6", toPort: "pitch" },
    { from: "pitchMul2", fromPort: "out", to: "fmop7", toPort: "pitch" },
    { from: "pitchMul2", fromPort: "out", to: "fmop8", toPort: "pitch" },
    { from: "edgeB", fromPort: "out", to: "fmop5", toPort: "gate" },
    { from: "br2", fromPort: "out1a", to: "fmop6", toPort: "gate" },
    { from: "br2", fromPort: "out2a", to: "fmop7", toPort: "gate" },
    { from: "br2", fromPort: "out1b", to: "fmop8", toPort: "gate" },
    { from: "fmop8", fromPort: "audio", to: "fmop7", toPort: "fm" },
    { from: "fmop5", fromPort: "audio", to: "mix2", toPort: "in1" },
    { from: "fmop6", fromPort: "audio", to: "mix2", toPort: "in2" },
    { from: "fmop7", fromPort: "audio", to: "mix2", toPort: "in3" },
    // ── THE HELD RANDOM VALUES that keep the two banks from settling ───────
    { from: "noise", fromPort: "out", to: "sh1", toPort: "in1" },
    { from: "w1", fromPort: "out_x", to: "sh1", toPort: "in2" },
    { from: "edgeA", fromPort: "out", to: "sh1", toPort: "trigger1" },
    { from: "edgeA", fromPort: "out", to: "sh1", toPort: "trigger2" },
    { from: "sh1", fromPort: "out1", to: "fmop1", toPort: "feedback_cv" },
    { from: "sh1", fromPort: "out2", to: "fmop1", toPort: "sustain_cv" },
    { from: "noise", fromPort: "out", to: "sh2", toPort: "in1" },
    { from: "w3", fromPort: "out_x", to: "sh2", toPort: "in2" },
    { from: "edgeB", fromPort: "out", to: "sh2", toPort: "trigger1" },
    { from: "edgeB", fromPort: "out", to: "sh2", toPort: "trigger2" },
    { from: "sh2", fromPort: "out1", to: "fmop5", toPort: "feedback_cv" },
    { from: "sh2", fromPort: "out2", to: "fmop5", toPort: "sustain_cv" },
    { from: "noise", fromPort: "out", to: "sh3", toPort: "in1" },
    { from: "w5", fromPort: "out_x", to: "sh3", toPort: "in2" },
    { from: "edgeC", fromPort: "out", to: "sh3", toPort: "trigger1" },
    { from: "edgeC", fromPort: "out", to: "sh3", toPort: "trigger2" },
    { from: "sh3", fromPort: "out1", to: "rings1", toPort: "damping_mod" },
    { from: "sh3", fromPort: "out2", to: "rings1", toPort: "structure_mod" },
    { from: "noise", fromPort: "out", to: "sh4", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh4", toPort: "in2" },
    { from: "edgeA", fromPort: "out", to: "sh4", toPort: "trigger1" },
    { from: "edgeC", fromPort: "out", to: "sh4", toPort: "trigger2" },
    { from: "sh4", fromPort: "out1", to: "seq9", toPort: "select_cv" },
    { from: "sh4", fromPort: "out2", to: "rings2", toPort: "position_mod" },
    { from: "noise", fromPort: "out", to: "sh5", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh5", toPort: "in2" },
    { from: "edgeB", fromPort: "out", to: "sh5", toPort: "trigger1" },
    { from: "edgeA", fromPort: "out", to: "sh5", toPort: "trigger2" },
    { from: "sh5", fromPort: "out1", to: "clouds3", toPort: "pitch" },
    { from: "sh5", fromPort: "out2", to: "clouds4", toPort: "pitch" },
    { from: "noise", fromPort: "out", to: "sh6", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh6", toPort: "in2" },
    { from: "edgeC", fromPort: "out", to: "sh6", toPort: "trigger1" },
    { from: "edgeB", fromPort: "out", to: "sh6", toPort: "trigger2" },
    { from: "sh6", fromPort: "out1", to: "plateau", toPort: "decay" },
    { from: "sh6", fromPort: "out2", to: "plateau", toPort: "size" },
    // ── THREE RESONATORS IN PARALLEL, excited by noise and strummed by coins ─
    { from: "pitchMul3", fromPort: "out", to: "rings1", toPort: "pitch" },
    { from: "pitchMul3", fromPort: "out", to: "rings2", toPort: "pitch" },
    { from: "pitchMul3", fromPort: "out", to: "rings3", toPort: "pitch" },
    { from: "pitchMul3", fromPort: "out", to: "xco", toPort: "pitch" },
    { from: "pitchMul3", fromPort: "out", to: "bogvco", toPort: "pitch" },
    { from: "noise", fromPort: "out", to: "rings1", toPort: "in" },
    { from: "noise", fromPort: "out", to: "rings2", toPort: "in" },
    { from: "noise", fromPort: "out", to: "rings3", toPort: "in" },
    { from: "br3", fromPort: "out1a", to: "rings1", toPort: "strum" },
    { from: "br3", fromPort: "out2a", to: "rings2", toPort: "strum" },
    { from: "br3", fromPort: "out1b", to: "rings3", toPort: "strum" },
    { from: "l1", fromPort: "out", to: "rings1", toPort: "brightness_mod" },
    { from: "l2", fromPort: "out", to: "rings2", toPort: "damping_mod" },
    { from: "l3", fromPort: "out", to: "rings3", toPort: "position_mod" },
    { from: "l4", fromPort: "out", to: "xco", toPort: "square_mix_cv" },
    // THE ANALOGUE COUNTERWEIGHT: one VCO frequency-modulating the XCO, into the
    // Bogaudio VCF — the only subtractive voice in a patch of resonators.
    { from: "bogvco", fromPort: "sine", to: "xco", toPort: "fm" },
    { from: "xco", fromPort: "mix", to: "bogvcf", toPort: "in" },
    // ── THE SEVEN VOICES' ROUTES TO THE FOUR GRANULATORS ──────────────────
    { from: "mix1", fromPort: "l", to: "clouds1", toPort: "in_l" },
    { from: "mix1", fromPort: "r", to: "clouds1", toPort: "in_r" },
    { from: "mix2", fromPort: "l", to: "clouds2", toPort: "in_l" },
    { from: "mix2", fromPort: "r", to: "clouds2", toPort: "in_r" },
    { from: "blinds1", fromPort: "mix", to: "clouds1", toPort: "position" },
    { from: "blinds1", fromPort: "out1", to: "clouds1", toPort: "density" },
    { from: "blinds2", fromPort: "mix", to: "clouds2", toPort: "position" },
    { from: "blinds2", fromPort: "out1", to: "clouds2", toPort: "density" },
    { from: "blinds3", fromPort: "mix", to: "clouds3", toPort: "position" },
    { from: "blinds3", fromPort: "out1", to: "clouds4", toPort: "texture" },
    { from: "rings1", fromPort: "odd", to: "ripples1", toPort: "in" },
    { from: "rings1", fromPort: "even", to: "mix3", toPort: "in1" },
    { from: "rings2", fromPort: "odd", to: "ripples2", toPort: "in" },
    { from: "rings2", fromPort: "even", to: "mix3", toPort: "in2" },
    { from: "rings3", fromPort: "odd", to: "mix3", toPort: "in3" },
    { from: "bogvcf", fromPort: "out", to: "mix3", toPort: "in4" },
    { from: "ripples1", fromPort: "lp4", to: "feline1", toPort: "in_l" },
    { from: "ripples1", fromPort: "bp2", to: "feline1", toPort: "in_r" },
    { from: "ripples2", fromPort: "lp4", to: "feline2", toPort: "in_l" },
    { from: "ripples2", fromPort: "bp2", to: "feline2", toPort: "in_r" },
    { from: "mix3", fromPort: "l", to: "clouds3", toPort: "in_l" },
    { from: "mix3", fromPort: "r", to: "clouds3", toPort: "in_r" },
    { from: "feline1", fromPort: "out_l", to: "mix4b", toPort: "in1" },
    { from: "feline2", fromPort: "out_l", to: "mix4b", toPort: "in2" },
    { from: "rings3", fromPort: "even", to: "mix4b", toPort: "in3" },
    { from: "csimpler", fromPort: "o0", to: "mix4b", toPort: "in4" },
    { from: "mix4b", fromPort: "l", to: "clouds4", toPort: "in_l" },
    { from: "mix4b", fromPort: "r", to: "clouds4", toPort: "in_r" },
    // ── THE BUS: four granulators, two channels each ──────────────────────
    { from: "clouds1", fromPort: "out_l", to: "busL", toPort: "in1" },
    { from: "clouds2", fromPort: "out_l", to: "busL", toPort: "in2" },
    { from: "clouds3", fromPort: "out_l", to: "busL", toPort: "in3" },
    { from: "clouds4", fromPort: "out_l", to: "busL", toPort: "in4" },
    { from: "clouds1", fromPort: "out_r", to: "busR", toPort: "in1" },
    { from: "clouds2", fromPort: "out_r", to: "busR", toPort: "in2" },
    { from: "clouds3", fromPort: "out_r", to: "busR", toPort: "in3" },
    { from: "clouds4", fromPort: "out_r", to: "busR", toPort: "in4" },
    // ── EQ, THE DELAY, AND THE SEND/RETURN AS A DAG ──────────────────────
    { from: "busL", fromPort: "out", to: "eq", toPort: "in" },
    { from: "eq", fromPort: "out", to: "chrono", toPort: "in_l" },
    { from: "busR", fromPort: "out", to: "chrono", toPort: "in_r" },
    { from: "edgeA", fromPort: "out", to: "chrono", toPort: "sync" },
    { from: "chrono", fromPort: "out_l", to: "plateau", toPort: "in_l" },
    { from: "chrono", fromPort: "out_r", to: "plateau", toPort: "in_r" },
    { from: "chrono", fromPort: "out_l", to: "master", toPort: "in1" },
    { from: "plateau", fromPort: "out_l", to: "master", toPort: "in2" },
    { from: "plateau", fromPort: "out_r", to: "master", toPort: "in3" },
    { from: "busR", fromPort: "out", to: "master", toPort: "in4" },
    // ── AND THE COMPRESSOR ACROSS THE WHOLE THING ────────────────────────
    { from: "master", fromPort: "out", to: "pressor", toPort: "left" },
    { from: "master", fromPort: "out", to: "pressor", toPort: "right" },
    ...analysisWires("pressor", "left"),
  ],
};

/**
 * P9 — GENERATIVE PATCHING WITH RAMPAGE (Omri Cohen). The reference patch for Befaco's
 * Rampage, and the reason it is hard to port: **one dual slew recurrence has to produce
 * four different behaviours at once**, and this patch uses all four simultaneously.
 *
 * ── THE FOUR HATS, AND WHERE EACH ONE IS IN THE BLUEPRINT BELOW ─────────────
 *   1. ENVELOPE — `out_a` is wired to `voiceVca`'s gain. It is what makes the Basal voice
 *      swell and fade; `trigg_a` restarts it, which is what an envelope IS.
 *   2. LFO — the same channel A has `cycle_a` latched, so with nothing triggering it, it
 *      free-runs. Hat 1 and hat 2 are THE SAME OUTPUT, and that is the point of the
 *      module: a cycling envelope is an LFO, and an interrupted LFO is an envelope.
 *   3. SLEW LIMITER — channel B has white noise patched to `in_b` and does NOT cycle, so
 *      `out_b` is noise with its slope limited: the textbook smooth-random voltage. It
 *      goes through `bMix` into the lowpass gates' cutoff.
 *   4. COMPARATOR — `max` (the greater of the two channels) feeds the sample-and-hold that
 *      picks the FM voice's note, so what note plays depends on which channel is currently
 *      higher. `min` and `comparator` come out of the same comparison.
 *
 * Its EDGE DETECTORS — `rising_a`, `falling_a`, `rising_b`, `falling_b`, `eoc_a`, `eoc_b`
 * — are what clock the rest of the patch. Six events out of one recurrence, which is why
 * the patch needs almost no other timing modules: there is no master clock in it at all.
 *
 * Around it: Plaits, Branches, Simpliciter, an FM operator, three ML Quantum mask
 * quantizers, Instruo's ochd as the entire modulation farm, and Plateau on the send.
 */
export const VCV_RAMPAGE_GENERATIVE = {
  id: "vcv-rampage-generative",
  title: "VCV Generative Patching with Rampage",
  help: "The Befaco Rampage reference patch: ONE dual slew generator being an envelope, an LFO, a slew limiter and a comparator at the same time, and its six edge outputs clocking everything else — there is no master clock in this patch. Turn Rise A and Fall A and the whole piece changes tempo, timbre and shape together, which is the thing the module teaches.",
  source: {
    patch: "patchstorage 143657", file: "Generative-Patching-with-Rampage.vcv",
    author: "Omri_Cohen", popularity: "1251 dl / 13 likes / 1557 views",
    distinct: 32, families: ["granular", "FDN/plate reverb", "physical modelling", "FM", "chaotic/generative sequencing", "polyphony/voice allocation"],
  },
  deviations: [
    "ELEVEN UNRESOLVABLE CLOSED-SOURCE DIALS ARE DROPPED RATHER THAN CARRIED AS RAW INDICES, AND THAT IS A CRASH FIX. Basal (p2 0.087, p3 0.225, p4 0.4515, p5 0.543), Instruō saich (p0 0.4755, p7 1, p8 0.5) and the four Tangents' fifth param (`p4`, 0.6 on tang1…tang4). A `pN` key is not a knob any spec declares, so `buildPatchItems` threw on it and THE PATCH COULD NOT BE INSERTED. No index→name table for these modules exists in this repo: Vult compiles from a private .vult, Instruō was never cloned and VC-10's saich spec is behaviour-only off the vendor PDF, so no param enum was ever read. Basal shows why a positional guess is not the fallback — Rack's module has at least six params and VC-10 models four, so the indices do not line up with the names even in principle. The numbers are preserved in this sentence.",
    "RAMPAGE'S TWO CV FEEDBACK LOOPS ARE BROKEN, and they are the deviation to know about. Originally `Rampage[eoc A] -> SampleHold -> VCA -> Rampage[rise CV A, fall CV A]` (and the same on channel B): the module re-times ITSELF from its own end-of-cycle. That is a directed cycle. Here the four rise/fall CVs come from four ochd taps instead, so the times still wander and no longer wander because of Rampage. The sample-and-hold and VCA that used to close the loop are kept and now attenuate CV for the quantizers, which is the other thing VCA-1 does in the original.",
    "R7-UNITS: ML Quantum emits V/oct volts and a pitch port reads SEMITONES, so `pitchNum` (a Number node holding 12) and `pitchMul1..3` (Math nodes on multiply) sit between them — three nodes the original does not have. Without them all three voices would drift inside one semitone.",
    "NYSTHI/SimplerTapeControl dropped: it is the Simpliciter's transport panel, not a sound. Stoermelder-P1/Mb (a module browser) and ModularFungi/Color12HP (a coloured blank) dropped as furniture.",
    "VultModulesFree/Punch and Instruo/tsl DROPPED, and this one is an honest gap rather than a judgement: both of their cables are in the 26 the survey did not print, so there is nothing to reconstruct them from. They are the two modules of the original's 32 that this rebuild simply does not have.",
    "NYSTHI/VectorMixer and Bogaudio-UMix x2 substituted by our audio_mixer (both are unity summers here — VectorMixer's four params are all 1.0 in the harvested file). MindMeld MixMasterJr + AuxExpanderJr likewise, with the send/return as the acyclic dry+wet shape this file's header describes. Core/AudioInterface substituted by audio_output; Fundamental/Noise by audio_noise; Fundamental/Delay by audio_delay; Fundamental/VCA x2 and VCA-1 x5 by our audio_vca.",
    "Rampage's `in_b` carries white noise and its `cycle_b` knob is left latched as harvested — the SLEW hat needs an input to slew, and the original's is in the unseen 26 cables. Slew-limited noise is the canonical demonstration and is what the module's own manual shows.",
    "Dial conversions applied: FM-OP's envelope raws became seconds via Bogaudio's v²·10 (0.1414 -> 0.2 s attack); reburst's `cv_mode` raw 4 became the discrete \"random_pos\" and its gate mode \"trigger\"; Rampage's own rise/fall knobs are 0..1 panel positions in Befaco's C++ (`configParam(RISE_A_PARAM, 0, 1, 0)`) and carry across unchanged. Bogaudio Reftone's pitch/octave are a semitone index and an octave number rather than volts — but only the OCTAVE carries across as a number: VC-3b's pitch knob is the note NAME, so the harvested index 7 is written \"G\".",
  ],
  nodes: [
    // ── COLUMN 0 — the whole patch's inputs: one button, one chaos farm, noise,
    // and two reference pitches. There is no clock.
    { id: "btn", type: "node_button", col: 0, row: 0, knobs: { label: "Ping" } },
    // OCHD IS THE MODULATION FARM: eight slow LFOs at eight mutually incommensurate
    // rates from a single knob, and it is the only modulation source in the patch.
    { id: "ochd", type: "audio_vcv_ochd", col: 0, row: 1, knobs: { rate: 0.2375 } },
    { id: "noise", type: "audio_noise", col: 0, row: 2, knobs: { color: "white", level: 0.5 } },
    // "G", not 7. Reftone's PITCH_PARAM is an INDEX into the twelve note names and VC-3b's
    // knob is the NAME (`BOGAUDIO_NOTE_NAMES[7]`), the same correction vcv-ambient-drone's
    // reftone already took for its harvested 9 → "A". Two G's, two octaves apart.
    { id: "reftone1", type: "audio_vcv_reftone", col: 0, row: 3, knobs: { pitch: "G", octave: 2 } },
    { id: "reftone2", type: "audio_vcv_reftone", col: 0, row: 4, knobs: { pitch: "G", octave: 4 } },
    // ── COLUMN 1 — THE MODULE THE PATCH IS ABOUT, wearing all four hats ────
    { id: "rampage", type: "audio_vcv_rampage", col: 1, row: 0, knobs: { rise_a: 0.582, fall_a: 0.525, rise_b: 0.675, fall_b: 0.675, cycle_a: 1, cycle_b: 1, balance: 0.5 } },
    // ── COLUMN 2 — everything Rampage's six edges clock, plus the CV summers ─
    { id: "clkdiv", type: "audio_vcv_clockdivider", col: 2, row: 0 },
    { id: "sh1", type: "audio_vcv_samplehold", col: 2, row: 1 },
    { id: "sh2", type: "audio_vcv_samplehold", col: 2, row: 2 },
    // THE COMPARATOR HAT LANDS HERE: `max` sampled on `rising_a`.
    { id: "sah", type: "audio_vcv_sampleandhold", col: 2, row: 3 },
    { id: "reburst", type: "audio_vcv_reburst", col: 2, row: 4, knobs: { time: 1, rep: 8, accel: 1, jitter: 1, cv_mode: "random_pos", gate_mode: "trigger" } },
    // NYSTHI is not cloneable, but VC-8's AttackDecay defaults ARE these two numbers —
    // 0.4365 s and 0.1 s — which is only possible if it read them off this very instance,
    // so params 0 and 1 are Attack and Decay in that order.
    { id: "ad1", type: "audio_vcv_attackdecay", col: 2, row: 5, knobs: { attack: 0.4365, decay: 0.1 } },
    { id: "ad2", type: "audio_vcv_attackdecay", col: 2, row: 6, knobs: { decay: 0.136 } },
    { id: "br", type: "audio_vcv_branches", col: 2, row: 7, knobs: { p1: 0.5, p2: 0.5 } },
    // THE SLEW HAT'S DESTINATION: out_b summed with an ochd tap, into the gates.
    { id: "bMix", type: "audio_mixer", col: 2, row: 8, knobs: { level1: 1, level2: 1, master: 1 } },
    // ── COLUMN 3 — the CV attenuators (the original's five VCA-1s) ─────────
    { id: "vcaA", type: "audio_vca", col: 3, row: 0, knobs: { gain: 0.1425 } },
    { id: "vcaB", type: "audio_vca", col: 3, row: 1, knobs: { gain: 0.108 } },
    { id: "vcaC", type: "audio_vca", col: 3, row: 2, knobs: { gain: 0.1065 } },
    { id: "vcaD", type: "audio_vca", col: 3, row: 3, knobs: { gain: 0.1425 } },
    // ── COLUMN 4 — three mask quantizers, ALL ON ONE MASK, which is how three
    // voices play different lines in the same key.
    { id: "quantum1", type: "audio_vcv_quantum", col: 4, row: 0, knobs: { semi3: 1, semi4: 1, semi8: 1, semi10: 1, semi11: 1 } },
    { id: "quantum2", type: "audio_vcv_quantum", col: 4, row: 1, knobs: { semi3: 1, semi4: 1, semi8: 1, semi10: 1, semi11: 1 } },
    { id: "quantum3", type: "audio_vcv_quantum", col: 4, row: 2, knobs: { semi3: 1, semi4: 1, semi8: 1, semi10: 1, semi11: 1 } },
    // ── COLUMNS 5-6 — THE R7-UNITS SCALER, visible for the reason P5's is ──
    { id: "pitchNum", type: "node_number", col: 5, row: 0, knobs: { value: 12 } },
    { id: "pitchMul1", type: "node_math", col: 6, row: 0, knobs: { op: "multiply" } },
    { id: "pitchMul2", type: "node_math", col: 6, row: 1, knobs: { op: "multiply" } },
    { id: "pitchMul3", type: "node_math", col: 6, row: 2, knobs: { op: "multiply" } },
    // ── COLUMN 7 — four voices, all four pitched and gated by Rampage's edges ─
    // Basal's four harvested dials (p2 0.087, p3 0.225, p4 0.4515, p5 0.543) ARE DROPPED
    // and the node inserts at its defaults. They were raw Rack param indices — Vult is
    // closed source, no index→name table exists in this repo, and VC-10 models only four
    // knobs (tune/oct/mod1/mod2) against a Rack module with at least six params. A `pN` is
    // not a knob any spec declares, so these threw at insert. The numbers are kept in this
    // patch's deviations; pairing them onto the named knobs by position would be invention.
    { id: "basal", type: "audio_vcv_basal", col: 7, row: 0 },
    { id: "fmop", type: "audio_vcv_fmop", col: 7, row: 1, knobs: { attack: 0.2, decay: 0.9998, sustain: 1, release: 0.9998, feedback: 0.342, level: 1, envToLevel: "on" } },
    { id: "plaits", type: "audio_vcv_plaits", col: 7, row: 2, knobs: { harmonics: 0.203, timbre: 0.4955, morph: 0.5, timbre_cv: 0.198, lpg_color: 0.5, lpg_decay: 0.5 } },
    // saich's three harvested dials (p0 0.4755, p7 1, p8 0.5) ARE DROPPED, same call and
    // same reason: Instruō was never cloned, VC-10's spec is `behaviourOnly` off the vendor
    // PDF, so no param enum was ever read and the indices name nothing. Numbers preserved
    // in this patch's deviations.
    { id: "saich", type: "audio_vcv_saich", col: 7, row: 3 },
    // ── COLUMN 8 — THE ENVELOPE HAT (voiceVca) and four lowpass gates ──────
    { id: "voiceVca", type: "audio_vca", col: 8, row: 0, knobs: { gain: 1 } },
    // Cutoff CV → hertz, Resonance and the cutoff attenuverter as-is; `p4` IS DROPPED (it
    // is Tangents' fifth param, which VC-10 does not model, so the key landed on no leaf
    // and threw). The reasoning for all four is at vcv-ambient-drone's Tangents.
    { id: "tang1", type: "audio_vcv_tangents", col: 8, row: 1, knobs: { cutoff: 411, resonance: 0.3885, cutoffAtten: 0.156 } },
    { id: "tang2", type: "audio_vcv_tangents", col: 8, row: 2, knobs: { cutoff: 2586 } },
    { id: "tang3", type: "audio_vcv_tangents", col: 8, row: 3, knobs: { cutoff: 1047, resonance: 0.111, cutoffAtten: 0.309 } },
    { id: "tang4", type: "audio_vcv_tangents", col: 8, row: 4, knobs: { cutoff: 1025, cutoffAtten: 0.201 } },
    // ── COLUMN 9 — one delay per voice, which is what makes it a WASH ──────
    { id: "delay", type: "audio_delay", col: 9, row: 0, knobs: { time: 0.602, feedback: 0.6635, wet: 0.5, dry: 0.5 } },
    { id: "chrono1", type: "audio_vcv_chronoblob2", col: 9, row: 1, knobs: { time: 0.68, feedback: 0.434, mix: 1 } },
    { id: "chrono2", type: "audio_vcv_chronoblob2", col: 9, row: 2, knobs: { time: 0.707, feedback: 0.4145, mix: 0.5 } },
    { id: "chrono3", type: "audio_vcv_chronoblob2", col: 9, row: 3, knobs: { time: 0.593, feedback: 0.422, mix: 1 } },
    { id: "chrono4", type: "audio_vcv_chronoblob2", col: 9, row: 4, knobs: { time: 0.692, feedback: 0.3455, mix: 0.5 } },
    // ── COLUMNS 10-14 — the granulator, the bus, the send, the return ──────
    { id: "simpl", type: "audio_vcv_simpliciter", col: 10, row: 0 },
    { id: "vecmix", type: "audio_mixer", col: 11, row: 0, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 1 } },
    { id: "busB", type: "audio_mixer", col: 12, row: 0, knobs: { level1: 1, level2: 0.8, level3: 0.7, level4: 0.5, master: 1 } },
    { id: "plateau", type: "audio_vcv_plateau", col: 13, row: 0, knobs: { wet: 1, input_low_damp: 8.665, input_high_damp: 10, size: 0.5, diffusion: 10, decay: 0.4757, reverb_high_damp: 10, reverb_low_damp: 7.435, mod_shape: 0.5, mod_depth: 6.38 } },
    { id: "master", type: "audio_mixer", col: 14, row: 0, knobs: { level1: 0.9, level2: 0.6, level3: 0.6, master: 1 } },
    ...analysisTail(15),
  ],
  wires: [
    // ── HAT 1+2: THE CYCLING ENVELOPE. The button restarts channel A; with
    // `cycle_a` latched it free-runs when nobody presses anything, so the same
    // output is an LFO and an envelope depending on what you do.
    { from: "btn", fromPort: "out", to: "rampage", toPort: "trigg_a" },
    // ── HAT 3: THE SLEW LIMITER. Channel B slews white noise, which is the
    // canonical smooth-random-voltage use of the module.
    { from: "noise", fromPort: "out", to: "rampage", toPort: "in_b" },
    // FOUR OCHD TAPS SET THE FOUR TIMES. In the original these came from Rampage's
    // own end-of-cycle through a sample-and-hold — a cycle; see `deviations`.
    { from: "ochd", fromPort: "out1", to: "rampage", toPort: "rise_cv_a" },
    { from: "ochd", fromPort: "out2", to: "rampage", toPort: "fall_cv_a" },
    { from: "ochd", fromPort: "out3", to: "rampage", toPort: "rise_cv_b" },
    { from: "ochd", fromPort: "out4", to: "rampage", toPort: "fall_cv_b" },
    // ── ITS SIX EDGES ARE THE PATCH'S ONLY CLOCK ─────────────────────────
    { from: "rampage", fromPort: "eoc_a", to: "clkdiv", toPort: "clock" },
    { from: "rampage", fromPort: "eoc_a", to: "sh1", toPort: "trigger1" },
    { from: "rampage", fromPort: "eoc_b", to: "sh2", toPort: "trigger1" },
    { from: "rampage", fromPort: "rising_a", to: "sah", toPort: "trig" },
    { from: "rampage", fromPort: "rising_a", to: "fmop", toPort: "gate" },
    { from: "rampage", fromPort: "rising_b", to: "simpl", toPort: "trig" },
    { from: "rampage", fromPort: "falling_a", to: "ad1", toPort: "trig" },
    { from: "rampage", fromPort: "falling_b", to: "br", toPort: "in1" },
    { from: "rampage", fromPort: "comparator", to: "br", toPort: "in2" },
    // ── HAT 4: THE COMPARATOR. `max` is the greater of the two channels, and
    // sampling it is what chooses the FM voice's note — so which note plays
    // depends on which of Rampage's two ramps is currently higher.
    { from: "rampage", fromPort: "max", to: "sah", toPort: "sample" },
    { from: "rampage", fromPort: "min", to: "sh1", toPort: "in1" },
    { from: "noise", fromPort: "out", to: "sh1", toPort: "in2" },
    { from: "noise", fromPort: "out", to: "sh2", toPort: "in1" },
    { from: "ochd", fromPort: "out8", to: "sh2", toPort: "in2" },
    // ── HAT 1: THE ENVELOPE, on the voice VCA's gain ─────────────────────
    { from: "rampage", fromPort: "out_a", to: "voiceVca", toPort: "gain" },
    // ── HAT 3's DESTINATION: slewed noise plus an ochd tap, opening the gates ─
    { from: "rampage", fromPort: "out_b", to: "bMix", toPort: "in1" },
    { from: "ochd", fromPort: "out5", to: "bMix", toPort: "in2" },
    { from: "bMix", fromPort: "out", to: "tang1", toPort: "cutoff" },
    { from: "bMix", fromPort: "out", to: "tang2", toPort: "cutoff" },
    // ── THE DIVIDER FANS ONE EDGE OUT TO FOUR UNRELATED RATES ────────────
    { from: "clkdiv", fromPort: "div1", to: "sh1", toPort: "trigger2" },
    { from: "clkdiv", fromPort: "div2", to: "sh2", toPort: "trigger2" },
    { from: "clkdiv", fromPort: "div3", to: "reburst", toPort: "clock" },
    { from: "clkdiv", fromPort: "div4", to: "quantum1", toPort: "set" },
    // ── THE COIN FLIP decides which envelope fires and which note is re-picked ─
    { from: "br", fromPort: "out1a", to: "ad2", toPort: "trig" },
    { from: "br", fromPort: "out1b", to: "reburst", toPort: "gate" },
    { from: "br", fromPort: "out2a", to: "quantum2", toPort: "set" },
    { from: "br", fromPort: "out2b", to: "quantum3", toPort: "set" },
    // ── THE CV ATTENUATORS, then the three quantizers, then the scaler ────
    { from: "sh1", fromPort: "out1", to: "vcaA", toPort: "in" },
    { from: "sah", fromPort: "sample", to: "vcaB", toPort: "in" },
    { from: "ochd", fromPort: "out5", to: "vcaC", toPort: "in" },
    { from: "sh2", fromPort: "out1", to: "vcaD", toPort: "in" },
    { from: "vcaA", fromPort: "out", to: "quantum1", toPort: "in" },
    { from: "vcaB", fromPort: "out", to: "quantum2", toPort: "in" },
    { from: "vcaD", fromPort: "out", to: "quantum3", toPort: "in" },
    { from: "pitchNum", fromPort: "out", to: "pitchMul1", toPort: "b" },
    { from: "pitchNum", fromPort: "out", to: "pitchMul2", toPort: "b" },
    { from: "pitchNum", fromPort: "out", to: "pitchMul3", toPort: "b" },
    { from: "quantum1", fromPort: "out", to: "pitchMul1", toPort: "a" },
    { from: "quantum2", fromPort: "out", to: "pitchMul2", toPort: "a" },
    { from: "quantum3", fromPort: "out", to: "pitchMul3", toPort: "a" },
    // ── FOUR VOICES ─────────────────────────────────────────────────────
    // Basal has exactly three jacks and its manual lists them V/OCT, Mod 1 CV, Mod 2 CV —
    // which is VC-10's order, and the cables agree with it: the pitch chain lands on 0 and
    // the two ochd taps on 1 and 2. Its four DIALS are a different matter and stay raw:
    // the manual documents an attenuverter beside each Mod knob, so the real module has at
    // least six params against VC-10's four knobs and no index lines up.
    { from: "pitchMul1", fromPort: "out", to: "basal", toPort: "v_oct" },
    { from: "ochd", fromPort: "out6", to: "basal", toPort: "mod1" },
    { from: "ochd", fromPort: "out7", to: "basal", toPort: "mod2" },
    { from: "pitchMul2", fromPort: "out", to: "fmop", toPort: "pitch" },
    { from: "ochd", fromPort: "out3", to: "fmop", toPort: "feedback_cv" },
    { from: "sh1", fromPort: "out2", to: "fmop", toPort: "sustain_cv" },
    { from: "reftone2", fromPort: "out", to: "plaits", toPort: "freq" },
    { from: "pitchMul3", fromPort: "out", to: "plaits", toPort: "note" },
    { from: "ad1", fromPort: "out", to: "plaits", toPort: "level" },
    { from: "vcaC", fromPort: "out", to: "plaits", toPort: "harmonics" },
    { from: "ochd", fromPort: "out7", to: "plaits", toPort: "timbre" },
    // Instruō publishes no source, so saich's jacks are VC-10's reading of the manual's
    // panel order: four V/oct, then PWM, CV and Scan. Index 0 is a V/oct and the Reftone
    // proves it; index 6 is the Scan fader's own jack, which is what a slow ochd tap is
    // for. Its DIALS stay raw — index 8 lands on a discrete `wave` knob that cannot take
    // the harvested 0.5, which refutes the dial order the same evidence supports for jacks.
    { from: "reftone1", fromPort: "out", to: "saich", toPort: "voct1" },
    { from: "ochd", fromPort: "out6", to: "saich", toPort: "scan" },
    // ── THE ENVELOPE ON THE BASAL VOICE, and the gates on the rest ───────
    { from: "basal", fromPort: "out", to: "voiceVca", toPort: "in" },
    { from: "saich", fromPort: "out", to: "tang1", toPort: "bp_in" },
    // Gate into gate: two Tangents in series is how the original shapes that voice.
    { from: "tang1", fromPort: "out", to: "tang2", toPort: "bp_in" },
    { from: "plaits", fromPort: "out", to: "tang3", toPort: "bp_in" },
    { from: "noise", fromPort: "out", to: "tang4", toPort: "bp_in" },
    { from: "ad2", fromPort: "out", to: "tang4", toPort: "cutoff" },
    { from: "ochd", fromPort: "out7", to: "tang3", toPort: "cutoff" },
    // ── ONE DELAY PER VOICE ─────────────────────────────────────────────
    { from: "voiceVca", fromPort: "out", to: "delay", toPort: "in" },
    { from: "ochd", fromPort: "out8", to: "delay", toPort: "time" },
    { from: "tang2", fromPort: "out", to: "chrono1", toPort: "in_l" },
    { from: "fmop", fromPort: "audio", to: "chrono2", toPort: "in_l" },
    { from: "sh2", fromPort: "out2", to: "chrono2", toPort: "time" },
    { from: "tang3", fromPort: "out", to: "chrono3", toPort: "in_l" },
    { from: "tang4", fromPort: "out", to: "chrono4", toPort: "in_l" },
    { from: "reburst", fromPort: "gate_out", to: "chrono4", toPort: "mix" },
    // ── THE GRANULATOR TAKES THE FM VOICE'S ECHO, started by a Rampage edge ─
    { from: "chrono2", fromPort: "out_l", to: "simpl", toPort: "in_l" },
    { from: "chrono2", fromPort: "out_r", to: "simpl", toPort: "in_r" },
    // ── THE BUS, THE SEND, THE RETURN ──────────────────────────────────
    { from: "delay", fromPort: "out", to: "vecmix", toPort: "in1" },
    { from: "chrono1", fromPort: "out_l", to: "vecmix", toPort: "in2" },
    { from: "chrono3", fromPort: "out_l", to: "vecmix", toPort: "in3" },
    { from: "chrono4", fromPort: "out_l", to: "vecmix", toPort: "in4" },
    { from: "vecmix", fromPort: "out", to: "busB", toPort: "in1" },
    { from: "simpl", fromPort: "out_l", to: "busB", toPort: "in2" },
    { from: "chrono1", fromPort: "out_r", to: "busB", toPort: "in3" },
    { from: "reburst", fromPort: "cv", to: "busB", toPort: "in4" },
    { from: "busB", fromPort: "out", to: "plateau", toPort: "in_l" },
    { from: "busB", fromPort: "out", to: "plateau", toPort: "in_r" },
    { from: "busB", fromPort: "out", to: "master", toPort: "in1" },
    { from: "plateau", fromPort: "out_l", to: "master", toPort: "in2" },
    { from: "plateau", fromPort: "out_r", to: "master", toPort: "in3" },
    ...analysisWires("master", "out"),
  ],
};

/** This set's blueprints. See the PATCH-SET CONTRACT in core/audio_patch_sets.js. */
export const BLOCK_PATCHES = [VCV_SELF_PLAYING_AMBIENT, VCV_INCANTA, VCV_RAMPAGE_GENERATIVE];
