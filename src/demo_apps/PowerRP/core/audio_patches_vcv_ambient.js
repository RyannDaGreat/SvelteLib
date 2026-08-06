/**
 * DEMO PATCHES — VCV Rack — the ambient/granular core.
 *
 * Part of R7-17-SEL's 20 headline patches; see `claude_instructions.md` for the full
 * table and for the user ruling that chose them (*"20 impressive, fully-equipped patches
 * with tons of likes and views"*). The blueprint format, the grid layout rule and the
 * meter/spectrum tail are documented ONCE in `core/audio_patches.js` — read that file's
 * header before adding anything here. The aggregation contract is in
 * `core/audio_patch_sets.js`.
 *
 * THIS SET REBUILDS:
 *   - P1  Simple Generative Granular Ambient — patchstorage 178011, SATURATA, 1958 dl / 6071 views, 14 distinct
 *   - P3  Your First Generative Patch — patchstorage 149531, redmeansrecording, 1636 dl, 23 distinct
 *   - P12 Building an Ambient Drone — patchstorage 145668, Omri_Cohen, 2040 dl, 18 distinct
 *
 * Every blueprint here carries `source` (the harvested file, its author, its popularity
 * figures, its distinct-module count) and `deviations` (what we did NOT reproduce, and
 * why) — an UNRECORDED substitution is the silent divergence R7-17-SEL exists to prevent.
 *
 * A node this set needs but the library does not yet have is a PLACEHOLDER, declared in
 * the companion `core/audio_stubs_vcv_ambient.js`. Read `core/audio_stub_nodes.js` first:
 * a placeholder carries the FINAL type name and the FINAL port names, so the wire written
 * here today is the wire the real module gets.
 *
 * ── THE GRAPHS WERE RE-PARSED FROM THE `.vcv`, NOT COPIED FROM THE SURVEY ────
 * `.frenzy/round7/survey_vcv.md` § 3 is a good reading and it is not the source. Re-parsing
 * the three files (`/tmp/svcv/files`, the harvest these patches were chosen from) found
 * THREE things the survey states wrongly, each of which would have been rebuilt as stated:
 *
 *   1. `ENUMS(FIRST, N)` IS NOT EXPANDED by the survey's port-name index, so in a module
 *      whose enum contains one, every LATER port is reported under the wrong name.
 *      `ImpromptuModular/Clocked-Clkd` is `ENUMS(CLK_OUTPUTS, 4), RESET, RUN, BPM`, so
 *      output 1 is the SECOND CLOCK — the survey calls it "Reset", which turns P3's clock
 *      tree into nine cables driven by a reset pulse. Its PARAMS shift the same way:
 *      "Master clock=−9, Run=96" is really ratio_2=−9 and BPM=96, and 96 BPM is a tempo
 *      where −9 was nonsense. `AudibleInstruments/Tides2` has the same shape.
 *   2. P3'S CABLE LIST IS TRUNCATED at 70 of 94 in the survey; the last 24 include the whole
 *      output chain. Anything built from the printed list would have had no audio path.
 *   3. THE PROSE FOR P1 SAYS "enveloped white noise excites Rings as a modal resonator".
 *      The cables say otherwise: `VCA-1[out] -> VCF[IN]`, alongside `Clouds[out_l]` and
 *      `[out_r]`. The noise burst goes to the FILTER, not into Rings — Rings is struck by
 *      Marbles' T2 through its own internal exciter and pitched by Fence. Same modules,
 *      different instrument, and it is the sort of error that gets repeated once written.
 *
 * A fourth survey statement that looks wrong and is NOT: `Fundamental/Scope` really does
 * have `X_OUTPUT`/`Y_OUTPUT` thru jacks, so a cable SOURCED from a scope is genuine. Ten of
 * P3's 47 modules are scopes wired as pass-throughs, which is why dropping them and joining
 * their source straight to their destination is EXACT rather than approximate.
 *
 * ── WHAT OUR GRAPH CANNOT EXPRESS, STATED ONCE ───────────────────────────────
 * Three properties of a Rack patch have no expression here, so each patch's `deviations`
 * names its own instances rather than leaving the reader to infer the rule:
 *
 *   1. FAN-IN. Rack lets several cables land on ONE input (`Engine::addCable` only tracks
 *      that the input "was connected"; it does not refuse), and P1 does exactly that with
 *      three cables into the VCF's audio jack. `core/nodeflow.js` keys a connection BY ITS
 *      INPUT PORT, so a second wire REPLACES the first — fan-in needs a module with several
 *      inputs, which is what a Mixer is (the house BEACH patch records the same discovery).
 *   2. CYCLES. `connectionRefusal` refuses a wire that would close a loop in the data
 *      graph, and the ONE escape hatch (`feedbackSafe`) is pinned by
 *      `tests/audio_nodes_test.js` to exactly one port, `audio_delay.in`. So Marbles'
 *      self-patch and P3's reverb-into-delay-into-mixer shimmer loop cannot be drawn.
 *   3. STEREO. Our tail is mono — `audio_output` has one input — so each patch's final
 *      stereo pair is summed by a Mixer at the very end.
 *
 * ── THE PORT BLOCKS LANDED WHILE THIS FILE WAS BEING WRITTEN ─────────────────
 * VC-1, VC-3a and VC-5 arrived mid-session, so Marbles, Rings, Clouds, Branches, Shades,
 * Supercell, Bogaudio LFO, Plateau, Feline and Chronoblob2 are REAL nodes here and their
 * placeholders are deleted. Two lessons, recorded because the next patch agent will hit
 * them: a real block's port list is NOT always the C++ enum (Plateau's jacks are
 * `in_l`/`in_r`, not the enum's `left`/`right`, and its CV inputs carry no `_cv` suffix),
 * and where a block SIMPLIFIES a jack bank the patch is what has to move (Feline's two
 * five-jack CV buses became five parameter inputs). Its knob KEYS are camelCase
 * (`dejaVu`, `inGain`, `positionTrim`), not the enum's snake_case.
 */

/**
 * The analysis tail every patch ends with, at a given column. RE-STATED HERE rather than
 * imported: `core/audio_patch_sets.js` forbids a set from importing `core/audio_patches.js`
 * (that is the cycle the seam exists to break), and the tail lives there as a module-private
 * const. Spelled with the SAME names as the house one so the duplication is greppable
 * instead of disguised — hoisting it into a leaf module both sides import is the right fix
 * and is a one-line change in seven files, which is the lead's call, not a set's.
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
 * P1 — SIMPLE GENERATIVE GRANULAR AMBIENT, and the diagnostic for the whole VCV half.
 *
 * The canonical modern VCV ambient recipe and the most-viewed granular patch on
 * patchstorage. The survey's verdict on why it goes first: *"if these four modules are
 * wrong, nothing else in the set will sound right either."*
 *
 * ── WHAT MAKES THE SOUND, READ OFF THE CABLES AND NOT OFF THE PROSE ─────────
 * RINGS IS THE INSTRUMENT and it is struck, not blown: Marbles' T2 gate hits its Strum
 * input, its internal exciter provides the impulse, and Fence quantises Marbles' X2 random
 * voltage into the note. Nothing is patched into Rings' audio input at all.
 * CLOUDS GRANULATES ITS DECORRELATED PAIR. Rings' ODD and EVEN outputs are genuinely
 * independent — VC-1 measured r = −0.001, and at position 0.5 the even modes null exactly —
 * so feeding both is what makes the granular field stereo. One would be a different patch.
 * THE NOISE BURST IS A THIRD VOICE INTO THE FILTER, not an exciter: Marbles' T1 opens an
 * envelope on a VCA passing white noise, and that lands on the filter's audio input beside
 * Clouds' two outputs. (The survey says it excites Rings. The .vcv says VCF.)
 * Then a delay and Plateau's plate, with a second slow LFO sweeping the cutoff.
 */
export const VCV_GRANULAR_AMBIENT = {
  id: "vcv-granular-ambient",
  title: "VCV Granular Ambient",
  help: "The canonical VCV ambient recipe. Marbles' gates STRIKE Rings, whose decorrelated odd/even pair is granulated by Clouds in stereo; an enveloped puff of white noise joins them at the filter, then a delay and Plateau's plate. No oscillator anywhere — every pitch comes from Marbles' random voltage quantised by Fence, so turn Fence's range down for a narrower key.",
  source: {
    patch: "patchstorage 178011", file: "Simple-Nice-Granular-Ambient-6668629538b97.vcv",
    author: "SATURATA", popularity: "1958 dl / 28 likes / 6071 views",
    distinct: 14, families: ["granular", "physical modelling", "generative sequencing", "FDN reverb"],
  },
  deviations: [
    "VCV-Recorder/Recorder dropped — it writes a WAV to the author's E:\\ drive; our own export is that.",
    "cf/PEAK substituted by audio_meter — both are pass-through level meters, so the sound is unchanged; PEAK's Threshold=10 and Gain=9.1446 dials are not reproduced.",
    "Core/AudioInterface2 substituted by audio_output, and Plateau's stereo pair is summed to mono by a Mixer first — our output has one input.",
    "Fundamental/Noise, /VCA-1, /ADSR and /VCF substituted by audio_noise, audio_vca, audio_adsr and audio_filter — NODE_REGISTRY.md's 'have?' column maps all four onto ours. (VC-2 has since written real audio_vcv_noise/vca/adsr/vcf specs; they are not aggregated yet, and swapping to them is a one-line-per-node change once they are.)",
    "The ADSR's four dials are Rack 0..1 knobs and ours are SECONDS: 0.36/0.89/0.182/0.808 are carried across as literal seconds, which is the right shape (slow attack, long release) but not the same curve.",
    "The VCF's cutoff is transcribed, not copied: Fundamental's knob is freq = C4·2^(10·v − 5), so v=0.8424 is 2808 Hz. Its Resonance 0.0048 and Drive −0.3928 have no counterpart on our filter; Q sits at 0.7.",
    "THREE cables land on the VCF's audio input in the original (Clouds L, Clouds R and the noise VCA). Rack permits that and the last cable wins; our nodeflow keeps one source per input, so a Mixer sums the three — which is what the author was reaching for and what the module in front of them appeared to do.",
    "Marbles[Y] -> Marbles[T jitter] — THE PATCH'S SIGNATURE SELF-PATCH, and the one cable we cannot draw: a node feeding itself is a cycle of length one and connectionRefusal refuses it. Its effect (the smooth-random output wobbling its own clock jitter) is unreproduced, so the rhythm here is steadier than the original's.",
    "R7-UNITS: dials are CONVERTED, not verbatim. The two LLFO rates come off Rack's log2 knob (261.626·2^(v−7) → 0.0989 Hz and 0.0947 Hz) and the VCF cutoff as above; every Mutable param is already 0..1 in the C++ and crosses unchanged; Rings' frequency is already semitones.",
    "Chronoblob2's five stored params are NOT carried. It is closed source, so its param indices have no mapping onto VC-5's four named knobs, and writing 0.6602 into a `time` knob measured in SECONDS is exactly the silent unit error R7-UNITS forbids. Its two `data` fields DO map by name and are set: delay_mode 1 → ping-pong, sync_prescaler 6.",
    "Fence's four params ride the placeholder declaration; OrangeLine is not cloned, so their meaning is unknown and only the two jacks the cables prove (i4 in, o1 out) are declared.",
  ],
  nodes: [
    // ── THE GENERATIVE BRAIN ──────────────────────────────────────────────────
    // Marbles' `data` blob IS carried here, because VC-1 gave every field a discrete row:
    // t_mode 2 is DRUMS (three related gate streams rather than independent coin flips),
    // t_range 2 is the 4× clock multiplier, x_scale 2 is the pentatonic quantiser and
    // y_divider 8 the quarter-note smooth-random rate. Those five choices are most of what
    // makes this patch's rhythm; a port that read only `params[]` would miss all of them.
    {
      id: "marbles", type: "audio_vcv_marbles", col: 0, row: 0, w: 205,
      knobs: {
        dejaVu: 0.3373, dejaVuLength: 0.7084, tRate: -0.5783, tBias: 0.6614, tJitter: 0.6675,
        xSpread: 0.7157, xBias: 0.3807, xSteps: 0.8072,
        tMode: "drums", tRange: "4x", xMode: "identical", xRange: "narrow", xScale: "pentatonic", yDivider: "1/4",
      },
    },
    // LLFO #1 — one ~10 s sweep shared by Rings' grain position and Marbles' own
    // distribution bias, which is how two unrelated-sounding parameters stay in step.
    { id: "llfoPos", type: "audio_vcv_bog_lfo", col: 0, row: 1, knobs: { frequency: 0.0989, scale: 1, offset: 0.4554 } },
    { id: "noise", type: "audio_noise", col: 0, row: 2, knobs: { color: "white", level: 1 } },
    // LLFO #2 — the filter sweep, deliberately at a slightly different rate (0.0947 Hz vs
    // 0.0989) so the two never phase-lock. Its Scale is 0.306, a third of the other's.
    { id: "llfoCut", type: "audio_vcv_bog_lfo", col: 0, row: 3, knobs: { frequency: 0.0947, scale: 0.306, offset: -0.3639 } },
    { id: "fence", type: "audio_vcv_fence", col: 1, row: 0 },
    // MARBLES' T1 REACHES THE ENVELOPE WITH NOTHING SPLICED IN, and that is a consequence of
    // the port TYPES rather than luck: a gate jack is `trigger`, and `trigger` is the one
    // source type our ADSR's `gate` accepts directly (core/nodeflow.js COERCIONS has no
    // audio → trigger, deliberately). Typed `audio` it would have needed an `audio_trigger`
    // edge detector the original does not contain.
    { id: "adsr", type: "audio_adsr", col: 1, row: 2, knobs: { attack: 0.36, decay: 0.89, sustain: 0.182, release: 0.808 } },
    {
      id: "rings", type: "audio_vcv_rings", col: 2, row: 0,
      knobs: {
        frequency: 30, structure: 0.3012, brightness: 0.4048, damping: 0.5012, position: 0.6482,
        brightnessTrim: 0.1467, dampingTrim: 0.1333, positionTrim: 0.1867,
        model: "modal", polyphony: "1",
      },
    },
    { id: "vca", type: "audio_vca", col: 2, row: 2, knobs: { gain: 0.028 } },
    {
      id: "clouds", type: "audio_vcv_clouds", col: 3, row: 0,
      knobs: { position: 0.5434, size: 0.7916, inGain: 0.5, density: 0.841, texture: 0.5422, blend: 0.7133, playback: "granular" },
    },
    // THE FAN-IN MIXER — see the deviation. in1/in2 are Clouds' stereo pair, in3 the dry
    // noise burst, which is how the original's three-cables-on-one-jack was heard.
    { id: "inmix", type: "audio_mixer", col: 4, row: 1, knobs: { level1: 1, level2: 1, level3: 1, master: 1 } },
    { id: "vcf", type: "audio_filter", col: 5, row: 0, knobs: { frequency: 2808, Q: 0.7, type: "lowpass" } },
    { id: "chrono", type: "audio_vcv_chronoblob2", col: 6, row: 0, knobs: { delay: "ping_pong", prescaler: 6 } },
    {
      id: "plateau", type: "audio_vcv_plateau", col: 7, row: 0,
      knobs: {
        dry: 1, wet: 0.1597, input_low_damp: 10, input_high_damp: 10, size: 0.3961,
        diffusion: 10, decay: 0.696, reverb_high_damp: 10, reverb_low_damp: 10,
        mod_shape: 0.5, mod_depth: 3.139, diffuse: "on",
      },
    },
    { id: "sum", type: "audio_mixer", col: 8, row: 0, knobs: { level1: 1, level2: 1, master: 1 } },
    ...analysisTail(9),
  ],
  wires: [
    // PITCH: Marbles' second X voltage, quantised and fenced into Rings' 1V/oct.
    { from: "marbles", fromPort: "x2", to: "fence", toPort: "i4" },
    { from: "fence", fromPort: "o1", to: "rings", toPort: "pitch" },
    // MODULATION: one slow LFO into two places.
    { from: "llfoPos", fromPort: "sine", to: "marbles", toPort: "x_bias" },
    { from: "llfoPos", fromPort: "sine", to: "rings", toPort: "position_mod" },
    // THE STRIKE, and the noise voice that is NOT the strike.
    { from: "marbles", fromPort: "t2", to: "rings", toPort: "strum" },
    { from: "marbles", fromPort: "t1", to: "adsr", toPort: "gate" },
    { from: "adsr", fromPort: "out", to: "vca", toPort: "gain" },
    { from: "noise", fromPort: "out", to: "vca", toPort: "in" },
    // THE STEREO GRANULAR PAIR — Rings' odd and even outputs are DECORRELATED, which is
    // the whole reason they are patched to Clouds' two inputs rather than one signal split.
    { from: "rings", fromPort: "odd", to: "clouds", toPort: "in_l" },
    { from: "rings", fromPort: "even", to: "clouds", toPort: "in_r" },
    { from: "clouds", fromPort: "out_l", to: "inmix", toPort: "in1" },
    { from: "clouds", fromPort: "out_r", to: "inmix", toPort: "in2" },
    { from: "vca", fromPort: "out", to: "inmix", toPort: "in3" },
    { from: "inmix", fromPort: "out", to: "vcf", toPort: "in" },
    { from: "llfoCut", fromPort: "sine", to: "vcf", toPort: "frequency" },
    // THE TAIL OF THE ORIGINAL: one mono filter feeding BOTH delay inputs, exactly as the
    // .vcv states it (two cables from the same jack), then delay into plate.
    { from: "vcf", fromPort: "out", to: "chrono", toPort: "in_l" },
    { from: "vcf", fromPort: "out", to: "chrono", toPort: "in_r" },
    { from: "chrono", fromPort: "out_l", to: "plateau", toPort: "in_l" },
    { from: "chrono", fromPort: "out_r", to: "plateau", toPort: "in_r" },
    { from: "plateau", fromPort: "out_l", to: "sum", toPort: "in1" },
    { from: "plateau", fromPort: "out_r", to: "sum", toPort: "in2" },
    ...analysisWires("sum"),
  ],
};

/**
 * P3 — YOUR FIRST GENERATIVE PATCH, the densest Mutable cluster in the corpus and the best
 * patch in the set for DIAGNOSING a bad port.
 *
 * Marbles, Branches, Plaits (×2), Rings (×2), Elements, Shades and Tides2 (×2) in one graph,
 * with Feline and Plateau on the tail. It was built on camera step by step, so every cable
 * has a stated purpose — which is exactly what makes it a diagnostic: if Plaits sounds wrong
 * here you can see which one cable made it wrong.
 *
 * ── THE SHAPE, BECAUSE 43 NODES DO NOT READ THEMSELVES ──────────────────────
 * ONE CLOCK TREE feeds everything: Clkd's ratio outputs drive Marbles' clock, both Clouds'
 * grain triggers, the gate sequencer and three Randoms. FIVE VOICES hang off it — Plaits ×2
 * (pitched by quantised random voltages), Rings ×2 (one strummed by Marbles, one by the gate
 * sequencer), and Elements (gated by Branches' coin flip). Random → Atenuverter → Quantizer
 * is the SAME three-module idiom four times over, which is the tutorial's actual lesson: a
 * smooth random voltage is not a melody until something scales it and snaps it to a scale.
 *
 * ── WHY THE ONE MIXER BECAME FIVE, AND HOW THE BUSES WERE ASSIGNED ──────────
 * The original sums everything in a Hora StereoMixer-16-2: 14 channels in, three stereo
 * buses out. WHICH CHANNEL FEEDS WHICH BUS IS NOT IN THE PATCH FILE — a mixer's routing
 * lives in its own state, and that state is not there — so the assignment here is derived
 * from what each bus FEEDS, which the cables do state: bus 1/3 goes to Clouds #1, bus 2/4 to
 * Plateau, bus 5/6 to the audio interface. So: the drum granulator (Clouds #2) feeds the
 * grain bus; the five instruments feed the reverb bus through a two-mixer tree (our Mixer
 * takes four inputs and there are nine mono sources); Clouds #1 and the delay feed the main
 * bus. That also happens to BREAK THE ONE CYCLE — see the deviations.
 */
export const VCV_FIRST_GENERATIVE = {
  id: "vcv-first-generative",
  title: "VCV First Generative Patch",
  help: "The densest Mutable cluster in the corpus: one Clkd clock tree driving Marbles, Branches, two Plaits, two Rings and Elements, each pitched by the tutorial's Random → Atenuverter → Quantizer idiom, then Feline and Plateau on the tail. Cut any one cable and you can hear exactly what it did — which is why this is the patch to diagnose a suspect port with.",
  source: {
    patch: "patchstorage 149531", file: "04b-Final-Video-Proof-of-Concept.vcv",
    author: "redmeansrecording", popularity: "1636 dl / 17 likes / 2173 views",
    distinct: 23, families: ["granular", "physical modelling", "generative sequencing", "FDN reverb"],
  },
  deviations: [
    "ALL 94 CABLES were re-read from the .vcv (the survey prints 70 and says so), so nothing here is inferred from a truncated list.",
    "Fundamental/Scope ×10 and CountModula/Oscilloscope dropped — decoration. Scope has real X/Y THRU outputs and eleven cables pass through one, so each was collapsed to a direct wire from its source to its destination: that is EXACT, not approximate. Four scope taps fed nothing onward (Marbles X3 and the oscilloscope's three) and are simply gone.",
    "Hora-Mixers/StereoMixer-16-2 substituted by five of our Mixers — see the docblock for how the buses were assigned. Its per-channel levels, pans and mutes (74 stored params) are NOT reproduced; every bus here sums at unity.",
    "Core/AudioInterface substituted by audio_output, and the stereo bus is summed to mono before it.",
    "Fundamental/LFO ×2 and /Quantizer ×3 substituted by audio_lfo and audio_quantize, per NODE_REGISTRY.md's 'have?' column. The LFO rates are transcribed from Rack's log2 knob (2^-4.2482 = 0.0526 Hz, 2^-5.853 = 0.0173 Hz) and their depth is 1, which is our ±1 full scale for Rack's ±5 V (R7-UNITS clause 1).",
    "THE QUANTIZERS' SCALES ARE APPROXIMATED. Fundamental's Quantizer stores a 12-note mask and ours picks from five named scales. The masks are C/F/G (→ pentatonic), C/Eb/F/Ab/Bb (→ pentatonic) and C/Eb/F/G/Ab/Bb (→ minor); the first is the loosest fit, and a patch that sounds too consonant there is this line, not a bad port.",
    "THE ONE CYCLE IS BROKEN. The original sends Plateau's output into Chronoblob2 and the delay's output back into the mixer bus that feeds Plateau — a shimmer loop. connectionRefusal refuses a wire that closes a loop in the data graph (the one `feedbackSafe` exemption is pinned to audio_delay.in), so here the delay's return lands on the MAIN bus instead of the reverb bus. Everything is still heard; the regeneration is not.",
    "`Clkd[clk_2] -> Chronoblob2[i7]` IS DROPPED, and deliberately unguessed. Chronoblob2 is closed source; VC-5 settled its four audio jacks from two patches agreeing on the indices, but i0-i4 and i7 cannot be mapped. i7 is almost certainly the sync jack — and 'almost certainly' written into a patch reads as resolved, which is worse than a hole. So the delay free-runs on its Time knob instead of locking to the clock.",
    "FELINE'S TWO CV JACKS BECOME ONE SUMMED INPUT, and the source says that is exact: `Feline.cpp:43-44` is `cutoff += CV1_1·atten1; cutoff += CV2_1·atten2` — both jacks drive CUTOFF and the module ADDS them. VC-5's node exposes one `cutoff` number input, so a Mixer performs the same addition. What is lost is the two per-jack attenuverters (0.2892 and 0.5494), so the two CVs here arrive at equal depth.",
    "Befaco's atenuverter OFFSET knobs are VOLTS (−10..10 V) and are divided by 5 per R7-UNITS: 0.1205 V → 0.0241, −2.5783 V → −0.5157, −1.7831 V → −0.3566. The gains are already ±1 and cross unchanged.",
    "Clkd's tempo (96 BPM), Tides2' frequency (−48 and −42.33 semitones) and the digital sequencer's 32-step lanes leave the placeholder's ±10 rail, so they ride the DECLARATION rather than a blueprint override.",
    "Chronoblob2's params are unmapped for the reason P1 states; only its `sync_prescaler` 6 is carried, by name. Feline's Poles switch (stored 1.0) is left at its default: VC-5's row is a two-option [2|4] switch and which option Valley's 1.0 selects is not established.",
    "CLOUDS #2 ASKED FOR THE SPECTRAL ENGINE (`data.playback` 3) AND WE DO NOT HAVE IT. VC-1 ships `granular` and `loopingDelay` and says outright that `stretch` needs a WSOLA correlator and `spectral` an FFT phase vocoder, neither of which was reached. So the drum granulator runs in granular mode; Clouds #1's mode 2 IS loopingDelay and is set. Marbles' t_mode 6 (markov) and both Rings' model 1 (sympathetic) and polyphony 2 DO map and are set — the `data` blob is carried wherever VC-1 gave it a row.",
    "GateSequencer8 #2's p4 step is not carried: our placeholder declares only the five params instance #1 sets, and the two instances set different ones. VCV-Drums/DrumMachine's 57 stored params are reduced to the six that are not 0.5 defaults.",
  ],
  nodes: [
    // ── THE CLOCK TREE AND THE TWO LFOs ───────────────────────────────────────
    // Clkd's four outputs are RATIOS of one master tempo, which is why one module can be
    // the whole rhythm section: ratio 5 (a multiplier) clocks Marbles and both grain
    // triggers, ratios −9 and −5 (divisions) fire the Randoms.
    { id: "clkd", type: "audio_vcv_clkd", col: 0, row: 0, knobs: { ratio_1: 5, ratio_2: -9, ratio_3: -5 } },
    { id: "lfo1", type: "audio_lfo", col: 0, row: 1, knobs: { frequency: 0.0526, depth: 1, waveform: "sine" } },
    { id: "lfo2", type: "audio_lfo", col: 0, row: 2, knobs: { frequency: 0.0173, depth: 1, waveform: "sine" } },
    // ── THE RANDOM SOURCES ────────────────────────────────────────────────────
    {
      id: "marbles", type: "audio_vcv_marbles", col: 1, row: 0, w: 205,
      knobs: {
        dejaVu: 0.5, dejaVuLength: 0, tRate: 0, tBias: 0.5, tJitter: 0,
        xSpread: 0.5, xBias: 0.5, xSteps: 0.5,
        tMode: "markov", tRange: "1x", xMode: "identical", xRange: "positive", xScale: "major", yDivider: "1/4",
      },
    },
    { id: "rnd1", type: "audio_vcv_random", col: 1, row: 1, knobs: { rate: 2, shape: 1, prob: 1, rand: 1 } },
    { id: "rnd2", type: "audio_vcv_random", col: 1, row: 2, knobs: { rate: 2, shape: 1, prob: 1, rand: 1 } },
    { id: "rnd3", type: "audio_vcv_random", col: 1, row: 3, knobs: { rate: 2, shape: 1, offset: 1, prob: 1, rand: 1 } },
    // rnd4 has NO trigger cable in the original — it free-runs on its internal rate, which
    // is what makes Shades' first input drift independently of the clock.
    { id: "rnd4", type: "audio_vcv_random", col: 1, row: 4, knobs: { rate: 2, shape: 1, offset: 1, prob: 1, rand: 1 } },
    { id: "tides1", type: "audio_vcv_tides2", col: 1, row: 5, knobs: { shape: 0.5, smoothness: 0.6976, slope: 0.5, shift: 1 } },
    { id: "tides2", type: "audio_vcv_tides2", col: 1, row: 6, knobs: { shape: 0.5, smoothness: 1, slope: 0.5, shift: 1, slope_cv: 0.3413 } },
    { id: "gseq1", type: "audio_vcv_gatesequencer8", col: 1, row: 7, knobs: { p0: 1, p3: 1, p12: 1, p16: 1, p64: 8 } },
    // ── SCALING: the tutorial's idiom, four times ─────────────────────────────
    { id: "branches", type: "audio_vcv_branches", col: 2, row: 0, knobs: { p1: 0.2904, p2: 0.5 } },
    { id: "atn1", type: "audio_vcv_dualatenuverter", col: 2, row: 1, knobs: { aten2: 0.159, offset2: 0 } },
    { id: "atn2", type: "audio_vcv_dualatenuverter", col: 2, row: 2, knobs: { aten1: 0.2361, offset1: 0.0241 } },
    { id: "atn3", type: "audio_vcv_dualatenuverter", col: 2, row: 3, knobs: { aten1: 0.1831, offset1: -0.5157 } },
    { id: "gseq2", type: "audio_vcv_gatesequencer8", col: 2, row: 7, knobs: { p0: 1, p64: 8 } },
    { id: "rnd5", type: "audio_vcv_random", col: 2, row: 8, knobs: { rate: 2, shape: 1, prob: 1, rand: 1 } },
    { id: "dseq", type: "audio_vcv_digitalsequencer", col: 3, row: 0 },
    {
      id: "plaits1", type: "audio_vcv_plaits", col: 3, row: 1,
      knobs: { harmonics: 0.4398, timbre: 0.5374, morph: 0.6458, timbre_cv: 0.5307, morph_cv: -0.248, lpg_decay: 0.6241 },
    },
    { id: "quant1", type: "audio_quantize", col: 3, row: 2, knobs: { range: 24, scale: "pentatonic" } },
    { id: "quant2", type: "audio_quantize", col: 3, row: 3, knobs: { range: 24, scale: "pentatonic" } },
    {
      id: "rings2", type: "audio_vcv_rings", col: 3, row: 7,
      knobs: { frequency: 30, structure: 0.4783, brightness: 0.6614, damping: 0.7506, position: 0.4843, model: "sympathetic", polyphony: "2" },
    },
    { id: "drums", type: "audio_vcv_drummachine", col: 3, row: 8, knobs: { p9: 0.76, p10: 0.1267, p48: 0.3347, p49: 0.512, p56: 0.5733 } },
    { id: "shades", type: "audio_vcv_shades", col: 4, row: 0, knobs: { gain1: 1, gain2: 1, gain3: 0.5, mode1: 1, mode2: 1, mode3: 1 } },
    {
      id: "rings1", type: "audio_vcv_rings", col: 4, row: 1,
      knobs: {
        frequency: 30.8675, structure: 0.3361, brightness: 0.4301, damping: 0.541, position: 0.5,
        structureTrim: 0.368, dampingTrim: 0.3467, positionTrim: -0.376,
        model: "sympathetic", polyphony: "2",
      },
    },
    { id: "plaits2", type: "audio_vcv_plaits", col: 4, row: 3, knobs: { timbre_cv: 1, morph_cv: 0.5467, lpg_color: 0.5, lpg_decay: 0.9193 } },
    // THE CV SUM the real Feline needs — see the deviation; the module itself adds these two.
    { id: "felineCv", type: "audio_mixer", col: 4, row: 6, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "feline", type: "audio_vcv_feline", col: 5, row: 7, knobs: { cutoff: 5.54, spacing: 0.168, spacing_target: 0.584, drive: 0.4554 } },
    {
      id: "clouds2", type: "audio_vcv_clouds", col: 4, row: 8,
      knobs: { position: 0.447, size: 0.2578, pitch: -13.01, inGain: 1, density: 0.5157, texture: 0.3892, blend: 0.2133, feedback: 0.1771, reverb: 1 },
    },
    { id: "atn4", type: "audio_vcv_dualatenuverter", col: 5, row: 0, knobs: { aten1: 0.1711, offset1: -0.3566 } },
    { id: "busVoiceA", type: "audio_mixer", col: 5, row: 1, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 1 } },
    { id: "busGrain", type: "audio_mixer", col: 5, row: 8, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "quant3", type: "audio_quantize", col: 6, row: 0, knobs: { range: 24, scale: "minor" } },
    {
      id: "clouds1", type: "audio_vcv_clouds", col: 6, row: 8,
      knobs: { position: 0.5, size: 0.5, inGain: 0.5, density: 0.5, texture: 0.5, blend: 1, spread: 1, feedback: 0.5253, reverb: 1, playback: "loopingDelay" },
    },
    {
      id: "elements", type: "audio_vcv_elements", col: 7, row: 0,
      knobs: {
        coarse: -1.8795, fine: -0.0241, flow: 0.5, mallet: 1, geometry: 0.2964, brightness: 0.2952,
        bow_timbre: 0.5133, blow_timbre: 0.5, strike_timbre: 0.5096, damping: 0.7795, position: 0.5627, space: 2,
      },
    },
    { id: "busVoiceB", type: "audio_mixer", col: 8, row: 1, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 1 } },
    { id: "busVerb", type: "audio_mixer", col: 9, row: 1, knobs: { level1: 1, level2: 1, master: 1 } },
    {
      id: "plateau", type: "audio_vcv_plateau", col: 10, row: 1,
      knobs: {
        dry: 0.7714, wet: 0.139, input_low_damp: 10, input_high_damp: 10, size: 0.5,
        diffusion: 10, decay: 0.668, reverb_high_damp: 10, reverb_low_damp: 10,
        mod_shape: 0.5, mod_depth: 0.5, diffuse: "on",
      },
    },
    { id: "chrono", type: "audio_vcv_chronoblob2", col: 11, row: 1, knobs: { prescaler: 6 } },
    { id: "busMain", type: "audio_mixer", col: 12, row: 1, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 1 } },
    ...analysisTail(13, 1),
  ],
  wires: [
    // ── THE CLOCK TREE ────────────────────────────────────────────────────────
    { from: "clkd", fromPort: "clk_2", to: "marbles", toPort: "t_clock" },
    { from: "clkd", fromPort: "clk_2", to: "clouds1", toPort: "trig" },
    { from: "clkd", fromPort: "clk_2", to: "clouds2", toPort: "trig" },
    { from: "clkd", fromPort: "clk_2", to: "gseq1", toPort: "i1" },
    { from: "clkd", fromPort: "clk_4", to: "tides1", toPort: "trig" },
    { from: "clkd", fromPort: "clk_4", to: "rnd1", toPort: "trig" },
    { from: "clkd", fromPort: "clk_4", to: "rnd2", toPort: "trig" },
    { from: "clkd", fromPort: "clk_3", to: "rnd3", toPort: "trig" },
    { from: "clkd", fromPort: "run", to: "gseq1", toPort: "i2" },
    // ── VOICE 1: Plaits, triggered by Marbles, shaped by Tides2 ──────────────
    { from: "marbles", fromPort: "t1", to: "plaits1", toPort: "trigger" },
    { from: "tides1", fromPort: "out_1", to: "plaits1", toPort: "timbre" },
    { from: "tides1", fromPort: "out_2", to: "plaits1", toPort: "morph" },
    { from: "rnd1", fromPort: "smooth", to: "atn1", toPort: "in2" },
    { from: "atn1", fromPort: "out2", to: "plaits1", toPort: "harmonics" },
    // ── VOICE 2: Rings, strummed by Marbles, pitched through the idiom ────────
    { from: "marbles", fromPort: "t3", to: "rings1", toPort: "strum" },
    { from: "rnd2", fromPort: "smooth", to: "atn2", toPort: "in1" },
    { from: "atn2", fromPort: "out1", to: "quant1", toPort: "in" },
    { from: "quant1", fromPort: "out", to: "rings1", toPort: "pitch" },
    { from: "lfo1", fromPort: "out", to: "rings1", toPort: "damping_mod" },
    { from: "tides2", fromPort: "out_1", to: "rings1", toPort: "structure_mod" },
    { from: "tides2", fromPort: "out_3", to: "rings1", toPort: "position_mod" },
    // ── VOICE 3: the second Plaits — note from the idiom, TRIGGER from the same
    // Random that made the note, so pitch and event are the same event.
    { from: "rnd3", fromPort: "smooth", to: "atn3", toPort: "in1" },
    { from: "atn3", fromPort: "out1", to: "quant2", toPort: "in" },
    { from: "quant2", fromPort: "out", to: "plaits2", toPort: "note" },
    { from: "rnd3", fromPort: "trig", to: "plaits2", toPort: "trigger" },
    { from: "tides1", fromPort: "out_4", to: "plaits2", toPort: "morph" },
    { from: "tides2", fromPort: "out_2", to: "plaits2", toPort: "timbre" },
    { from: "lfo2", fromPort: "out", to: "tides2", toPort: "slope" },
    // ── VOICE 4: Elements — pitch through a THIRD idiom whose random voltage is
    // mixed with the digital sequencer's in Shades, and gated by Branches' coin flip.
    // Branches takes ONE gate and passes it to one of two outputs, chosen per event by
    // its threshold — which is why one Marbles gate can drive both the sequencer lane and
    // Elements' strike without them ever landing together.
    { from: "rnd4", fromPort: "smooth", to: "shades", toPort: "in1" },
    { from: "dseq", fromPort: "o2", to: "shades", toPort: "in2" },
    { from: "shades", fromPort: "out2", to: "atn4", toPort: "in1" },
    { from: "atn4", fromPort: "out1", to: "quant3", toPort: "in" },
    { from: "quant3", fromPort: "out", to: "elements", toPort: "note" },
    { from: "marbles", fromPort: "t3", to: "branches", toPort: "in1" },
    { from: "branches", fromPort: "out1a", to: "dseq", toPort: "i1" },
    { from: "branches", fromPort: "out1b", to: "elements", toPort: "gate" },
    // ── VOICE 5: the drum machine, the second Rings, and the granulator they feed ──
    { from: "gseq1", fromPort: "o8", to: "drums", toPort: "i0" },
    { from: "gseq1", fromPort: "o10", to: "drums", toPort: "i30" },
    { from: "gseq1", fromPort: "o12", to: "drums", toPort: "i20" },
    { from: "gseq1", fromPort: "o10", to: "rnd5", toPort: "trig" },
    { from: "rnd5", fromPort: "smooth", to: "drums", toPort: "i34" },
    { from: "gseq1", fromPort: "o11", to: "gseq2", toPort: "i1" },
    { from: "gseq2", fromPort: "o8", to: "rings2", toPort: "strum" },
    { from: "rings2", fromPort: "odd", to: "feline", toPort: "in_l" },
    { from: "rings2", fromPort: "even", to: "feline", toPort: "in_r" },
    { from: "tides2", fromPort: "out_4", to: "felineCv", toPort: "in1" },
    { from: "tides1", fromPort: "out_3", to: "felineCv", toPort: "in2" },
    { from: "felineCv", fromPort: "out", to: "feline", toPort: "cutoff" },
    { from: "drums", fromPort: "o0", to: "clouds2", toPort: "in_l" },
    { from: "drums", fromPort: "o1", to: "clouds2", toPort: "in_r" },
    // ── THE GRAIN BUS: Clouds #2's output is what Clouds #1 granulates AGAIN ──
    { from: "clouds2", fromPort: "out_l", to: "busGrain", toPort: "in1" },
    { from: "clouds2", fromPort: "out_r", to: "busGrain", toPort: "in2" },
    { from: "busGrain", fromPort: "out", to: "clouds1", toPort: "in_l" },
    { from: "busGrain", fromPort: "out", to: "clouds1", toPort: "in_r" },
    { from: "rnd1", fromPort: "smooth", to: "clouds1", toPort: "position" },
    // ── THE REVERB BUS: nine mono voices through a two-mixer tree ────────────
    { from: "plaits1", fromPort: "out", to: "busVoiceA", toPort: "in1" },
    { from: "plaits2", fromPort: "out", to: "busVoiceA", toPort: "in2" },
    { from: "rings1", fromPort: "odd", to: "busVoiceA", toPort: "in3" },
    { from: "rings1", fromPort: "even", to: "busVoiceA", toPort: "in4" },
    { from: "elements", fromPort: "aux", to: "busVoiceB", toPort: "in1" },
    { from: "elements", fromPort: "main", to: "busVoiceB", toPort: "in2" },
    { from: "feline", fromPort: "out_l", to: "busVoiceB", toPort: "in3" },
    { from: "feline", fromPort: "out_r", to: "busVoiceB", toPort: "in4" },
    { from: "busVoiceA", fromPort: "out", to: "busVerb", toPort: "in1" },
    { from: "busVoiceB", fromPort: "out", to: "busVerb", toPort: "in2" },
    { from: "busVerb", fromPort: "out", to: "plateau", toPort: "in_l" },
    { from: "busVerb", fromPort: "out", to: "plateau", toPort: "in_r" },
    // ── THE MAIN BUS: the plate through the delay, plus the granulator ────────
    { from: "plateau", fromPort: "out_l", to: "chrono", toPort: "in_l" },
    { from: "plateau", fromPort: "out_r", to: "chrono", toPort: "in_r" },
    { from: "chrono", fromPort: "out_l", to: "busMain", toPort: "in1" },
    { from: "chrono", fromPort: "out_r", to: "busMain", toPort: "in2" },
    { from: "clouds1", fromPort: "out_l", to: "busMain", toPort: "in3" },
    { from: "clouds1", fromPort: "out_r", to: "busMain", toPort: "in4" },
    ...analysisWires("busMain"),
  ],
};

/**
 * P12 — BUILDING AN AMBIENT DRONE, and the only patch in the corpus using Grayscale
 * Supercell — the 'big Clouds', with per-grain reverb and pitch and a real polyphonic grain
 * engine. Also the only appearance of Vult Vessek, a complete physically-modelled voice.
 *
 * ── THE THING TO UNDERSTAND ABOUT IT: ONE MODULATOR RUNS EVERYTHING ─────────
 * Vult Caudal is a chaotic modulator with a bank of related outputs, and NINE of them are
 * patched. Six go through JW Add5 — a sixteen-channel +5 V shifter, i.e. the utility that
 * turns a bipolar CV into a unipolar one — and the shifted copies drive a Bogaudio PEQ6's
 * six BAND LEVELS. That is the patch's signature: a six-band parametric EQ used as a
 * FORMANT SHAPER, with each band's gain breathing on its own chaotic voltage. The same
 * modulator also drives Vessek's timbre inputs and Supercell's grain parameters, so the
 * drone's harmonic content, its grains and its formants all move together without ever
 * repeating.
 *
 * Three independent tails sum into the mixer: Vessek → PEQ6 → Supercell; a Squinky Super
 * saw pair → Feline → a highpass → delay → Plateau; and a sample player into a second
 * Plateau. Plus pink noise through Vult Tangents as an air bed.
 */
export const VCV_AMBIENT_DRONE = {
  id: "vcv-ambient-drone",
  title: "VCV Ambient Drone",
  help: "Omri Cohen's drone: a chaotic Vult modulator breathing on all six band levels of a parametric EQ, which shapes a physically-modelled Vessek voice into Supercell's polyphonic grain engine. Two more tails — a supersaw through Feline and a delay into Plateau, and a second Plateau on a sample player — sum underneath. The Caudal node is the one to grab: everything moves when it does.",
  source: {
    patch: "patchstorage 145668", file: "Ambient Drone.vcv",
    author: "Omri_Cohen", popularity: "2040 dl / 31 likes / 2899 views",
    distinct: 18, families: ["granular", "physical modelling", "FDN reverb", "vocoder / spectral"],
  },
  deviations: [
    "Stoermelder-P1/Mb dropped — it replaces Rack's module browser and has no cables at all.",
    "MindMeldModular/MixMasterJr substituted by three of our Mixers: it is a 10-in stereo mixer and the patch uses it as one, but its per-channel EQ, pan, aux sends and 20 kHz band splits are not reproduced. NYSTHI/VectorMixer is substituted by a Mixer for the same reason and with more confidence — the patch wires only audio in and audio out of it, so its vector/CV panning is not exercised by any cable.",
    "Core/AudioInterface substituted by audio_output, and the master pair summed to mono before it.",
    "Fundamental/Noise substituted by TWO of our Noise nodes, one white and one pink. The original takes both colours from the ONE module's two outputs simultaneously; ours picks its colour when the node is built (a construct-time knob), so one node cannot do both.",
    "Fundamental/VCF substituted by audio_filter in HIGHPASS mode (the patch takes its HPF output). Cutoff transcribed from Rack's knob: C4·2^(10·0.545 − 5) = 357 Hz.",
    "THREE CABLES INTO SUPERCELL ARE DROPPED, NOT GUESSED: `Caudal[o2] -> [i2]`, `Caudal[o6] -> [i9]` and `Add5[o3] -> [i12]`. Grayscale's source was never identified, so the .vcv gives indices only, and VC-1's real Supercell has sixteen named inputs whose ORDER demonstrably does not match those indices (the patch sends the EQ's audio mix to i6, while VC-1's index 6 is `v_oct`). The one cable that can be placed with confidence is that audio mix, because in_l/in_r are the only audio inputs and the source is mono — so it goes to `in_l`. The three CV cables need VC-1 to state the panel order.",
    "FELINE'S TWO CV JACKS BECOME ONE SUMMED INPUT — `Feline.cpp:43-44` adds CV1_1 and CV2_1 into cutoff, so a Mixer does the same addition. Here that means Add5's shifted chaos and WHITE NOISE arrive on the cutoff together, which is what makes the filter hiss-modulated rather than smoothly swept. The per-jack attenuverters (0.192 and 0.228) are lost, so both arrive at full depth.",
    "Plateau #1's `Input high cut CV` attenuverter (−0.309) has no counterpart on VC-5's node, which exposes the CV jack without a depth trim; the cable itself is wired.",
    "NYSTHI/complexSimpler plays a WAV the patch names on the author's D:\\ drive ('Birds and Cars.wav'). We do not have it, so this node is a placeholder rather than our Sampler — a sampler with no buffer is silent and looks finished, which is the failure the placeholder scheme exists to make loud.",
    "Vult Vessek, Caudal and Tangents, JW Add5, Bogaudio Reftone/PEQ6, Squinky Super and complexSimpler are placeholders. Vult is CLOSED SOURCE — its DSP is generated from a private .vult — so those rows carry raw port indices and raw param floats: R7-UNITS cannot convert a quantity whose identity is unknown.",
    "BOGAUDIO PEQ6 IS DECLARED AS ITS OWN TYPE (`audio_vcv_peq6`) AND THAT NEEDS A RULING. VC-3b has written `audio_vcv_peq`, a 2..14-band PEQ with THREE inputs — in, frequency CV, bandwidth CV — and no per-band level CV jacks. The C++ has them (`LEVEL1_INPUT` … `LEVEL6_INPUT` at indices 3, 5, 7, 9, 11, 13) and this patch's whole formant trick is six cables into them. Either VC-3b's node gains the jacks or this patch loses its subject; until that is decided the placeholder keeps the patch honest.",
  ],
  nodes: [
    // ── THE MODULATION SOURCE AND THE VOICES ──────────────────────────────────
    { id: "reftone", type: "audio_vcv_reftone", col: 0, row: 0, knobs: { pitch: 9, octave: 4 } },
    { id: "caudal", type: "audio_vcv_caudal", col: 0, row: 1, knobs: { p0: -0.327 } },
    { id: "noiseW", type: "audio_noise", col: 0, row: 2, knobs: { color: "white", level: 1 } },
    { id: "noiseP", type: "audio_noise", col: 0, row: 3, knobs: { color: "pink", level: 1 } },
    { id: "supersaw", type: "audio_vcv_super", col: 0, row: 4, knobs: { p0: -3, p1: -3, p3: 1.26, p5: 5 } },
    { id: "sample", type: "audio_vcv_complexsimpler", col: 0, row: 5, knobs: { p0: -1, p4: 1, p7: 1, p11: 1, p12: 2, p13: -2 } },
    // ADD5 IS THE HINGE OF THE WHOLE PATCH: six chaotic voltages in, six unipolar copies
    // out, and those copies are what the EQ's band levels and Vessek's timbre inputs read.
    { id: "add5", type: "audio_vcv_add5", col: 1, row: 1 },
    {
      id: "vessek", type: "audio_vcv_vessek", col: 2, row: 0,
      knobs: { p1: -0.0092, p4: 2, p6: 0.0135, p7: 0.225, p10: 0.5, p21: 0.462, p22: 1, p23: 0.669, p24: 0.79, p25: 0.639, p26: -0.774 },
    },
    { id: "tangents", type: "audio_vcv_tangents", col: 2, row: 3, knobs: { p0: 0.5, p1: 0.3495, p2: 0.618, p4: 0.6 } },
    { id: "felineCv", type: "audio_mixer", col: 2, row: 5, knobs: { level1: 1, level2: 1, master: 1 } },
    {
      id: "peq6", type: "audio_vcv_peq6", col: 3, row: 0,
      knobs: {
        bandwidth: 0.33, lp: 1, hp: 1,
        level1: 0.9091, frequency1: 0.0707, level2: 0.9091, frequency2: 0.0935,
        level3: 0.9091, frequency3: 0.1323, level4: 0.9091, frequency4: 0.1871,
        level5: 0.9091, frequency5: 0.2646, level6: 0.9091, frequency6: 0.3536,
      },
    },
    { id: "feline", type: "audio_vcv_feline", col: 3, row: 4, knobs: { cutoff: 4.96, drive: 0.2865 } },
    { id: "supercell", type: "audio_vcv_supercell", col: 4, row: 0, w: 205, knobs: { position: 0.5, size: 0.5, density: 0.5, texture: 0.5, mix: 1, feedback: 0.628, space: 0.522, inLevel: 1, randomEnabled: 1, randomFreq: 1 } },
    { id: "vecmix", type: "audio_mixer", col: 4, row: 3, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "vcf", type: "audio_filter", col: 4, row: 4, knobs: { frequency: 357, Q: 0.7, type: "highpass" } },
    { id: "chrono", type: "audio_vcv_chronoblob2", col: 5, row: 4, knobs: { delay: "ping_pong", prescaler: 6 } },
    {
      id: "plateau1", type: "audio_vcv_plateau", col: 6, row: 4,
      knobs: {
        dry: 0, wet: 0.5, input_low_damp: 6.655, input_high_damp: 10, size: 0.5,
        diffusion: 10, decay: 0.55, reverb_high_damp: 10, reverb_low_damp: 7.6,
        mod_shape: 0.5, mod_depth: 6.548, diffuse: "on",
      },
    },
    {
      id: "plateau2", type: "audio_vcv_plateau", col: 6, row: 5,
      knobs: {
        dry: 1, wet: 0.5, input_low_damp: 7.72, input_high_damp: 10, size: 0.5,
        diffusion: 10, decay: 0.55, reverb_high_damp: 10, reverb_low_damp: 7.945,
        mod_shape: 0.5, mod_depth: 5.54, diffuse: "on",
      },
    },
    { id: "busA", type: "audio_mixer", col: 7, row: 0, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 1 } },
    { id: "busB", type: "audio_mixer", col: 7, row: 4, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 1 } },
    { id: "busMain", type: "audio_mixer", col: 8, row: 2, knobs: { level1: 1, level2: 1, level3: 1, master: 1 } },
    ...analysisTail(9, 2),
  ],
  wires: [
    // ── THE DRONE VOICE: a fixed reference pitch into Vessek, chaos into its timbre ──
    { from: "reftone", fromPort: "cv", to: "vessek", toPort: "i0" },
    { from: "caudal", fromPort: "o0", to: "add5", toPort: "volt_1" },
    { from: "caudal", fromPort: "o3", to: "add5", toPort: "volt_2" },
    { from: "caudal", fromPort: "o6", to: "add5", toPort: "volt_3" },
    { from: "caudal", fromPort: "o9", to: "add5", toPort: "volt_4" },
    { from: "caudal", fromPort: "o1", to: "add5", toPort: "volt_5" },
    { from: "caudal", fromPort: "o4", to: "add5", toPort: "volt_6" },
    { from: "add5", fromPort: "volt_1", to: "vessek", toPort: "i3" },
    { from: "caudal", fromPort: "o7", to: "vessek", toPort: "i4" },
    { from: "add5", fromPort: "volt_2", to: "vessek", toPort: "i5" },
    { from: "caudal", fromPort: "o10", to: "vessek", toPort: "i6" },
    { from: "caudal", fromPort: "o3", to: "vessek", toPort: "i7" },
    { from: "caudal", fromPort: "o0", to: "vessek", toPort: "i8" },
    // ── THE FORMANT SHAPER: six band levels, six chaotic voltages ─────────────
    { from: "vessek", fromPort: "o0", to: "peq6", toPort: "in" },
    { from: "add5", fromPort: "volt_1", to: "peq6", toPort: "level1" },
    { from: "add5", fromPort: "volt_2", to: "peq6", toPort: "level2" },
    { from: "add5", fromPort: "volt_3", to: "peq6", toPort: "level3" },
    { from: "add5", fromPort: "volt_4", to: "peq6", toPort: "level4" },
    { from: "add5", fromPort: "volt_5", to: "peq6", toPort: "level5" },
    { from: "add5", fromPort: "volt_6", to: "peq6", toPort: "level6" },
    // ── THE GRAIN ENGINE ──────────────────────────────────────────────────────
    { from: "peq6", fromPort: "out", to: "supercell", toPort: "in_l" },
    // ── THE SECOND TAIL: supersaw → Feline (cutoff summed with white noise) → HPF
    // → delay → plate.
    { from: "supersaw", fromPort: "o1", to: "feline", toPort: "in_l" },
    { from: "supersaw", fromPort: "o0", to: "feline", toPort: "in_r" },
    { from: "add5", fromPort: "volt_3", to: "felineCv", toPort: "in1" },
    { from: "noiseW", fromPort: "out", to: "felineCv", toPort: "in2" },
    { from: "felineCv", fromPort: "out", to: "feline", toPort: "cutoff" },
    { from: "feline", fromPort: "out_l", to: "vcf", toPort: "in" },
    { from: "vcf", fromPort: "out", to: "chrono", toPort: "in_l" },
    { from: "chrono", fromPort: "out_l", to: "plateau1", toPort: "in_l" },
    { from: "chrono", fromPort: "out_r", to: "plateau1", toPort: "in_r" },
    { from: "add5", fromPort: "volt_5", to: "plateau1", toPort: "input_high_damp" },
    // ── THE AIR BED: pink noise through Tangents, doubled into the vector mixer ──
    { from: "noiseP", fromPort: "out", to: "tangents", toPort: "i1" },
    { from: "caudal", fromPort: "o10", to: "tangents", toPort: "i3" },
    { from: "tangents", fromPort: "o0", to: "vecmix", toPort: "in1" },
    { from: "tangents", fromPort: "o0", to: "vecmix", toPort: "in2" },
    // ── THE THIRD TAIL: the sample player's own plate ─────────────────────────
    { from: "sample", fromPort: "o0", to: "plateau2", toPort: "in_l" },
    { from: "sample", fromPort: "o1", to: "plateau2", toPort: "in_r" },
    // ── THE MIXER, IN THREE ───────────────────────────────────────────────────
    { from: "supercell", fromPort: "out_l", to: "busA", toPort: "in1" },
    { from: "supercell", fromPort: "out_r", to: "busA", toPort: "in2" },
    { from: "feline", fromPort: "out_l", to: "busA", toPort: "in3" },
    { from: "feline", fromPort: "out_r", to: "busA", toPort: "in4" },
    { from: "plateau1", fromPort: "out_l", to: "busB", toPort: "in1" },
    { from: "plateau1", fromPort: "out_r", to: "busB", toPort: "in2" },
    { from: "plateau2", fromPort: "out_l", to: "busB", toPort: "in3" },
    { from: "plateau2", fromPort: "out_r", to: "busB", toPort: "in4" },
    { from: "busA", fromPort: "out", to: "busMain", toPort: "in1" },
    { from: "busB", fromPort: "out", to: "busMain", toPort: "in2" },
    { from: "vecmix", fromPort: "out", to: "busMain", toPort: "in3" },
    ...analysisWires("busMain"),
  ],
};

/** This set's blueprints. See the PATCH-SET CONTRACT in core/audio_patch_sets.js. */
export const BLOCK_PATCHES = [VCV_GRANULAR_AMBIENT, VCV_FIRST_GENERATIVE, VCV_AMBIENT_DRONE];
