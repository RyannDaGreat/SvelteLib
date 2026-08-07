/**
 * DEMO PATCHES — VCV Rack — the effect chains.
 *
 * Part of R7-17-SEL's 20 headline patches; see `claude_instructions.md` for the full
 * table and for the user ruling that chose them (*"20 impressive, fully-equipped patches
 * with tons of likes and views"*). The blueprint format, the grid layout rule and the
 * meter/spectrum tail are documented ONCE in `core/audio_patches.js` — read that file's
 * header before adding anything here. The aggregation contract is in
 * `core/audio_patch_sets.js`.
 *
 * THIS SET REBUILDS:
 *   - P4  MICROCOSM v2 — patchstorage 162625, DwineKcuttop, 1117 dl / 40 likes, 18 distinct
 *   - P22 Ciani's Buchla, Performance Patch — patchstorage 141823, pyer, 1658 dl / 37 likes, 38 distinct
 *
 * Every blueprint here carries `source` (the harvested file, its author, its popularity
 * figures, its distinct-module count) and `deviations` (what we did NOT reproduce, and
 * why) — an UNRECORDED substitution is the silent divergence R7-17-SEL exists to prevent.
 *
 * A node this set needs but the library does not yet have is a PLACEHOLDER, declared in
 * the companion `core/audio_stubs_vcv_fx.js`. Read `core/audio_stub_nodes.js` first:
 * a placeholder carries the FINAL type name and the FINAL port names, so the wire written
 * here today is the wire the real module gets.
 *
 * ── THE GRAPHS HERE WERE READ FROM THE PATCH FILES, NOT FROM THE SURVEY ──────
 * `.frenzy/round7/survey_vcv.md` prints only the FIRST 70 cables of each patch ("... 19
 * more cables (see the .vcv)"), so it cannot describe either graph completely — P4 has 89
 * and P22 has 132. Both files were therefore re-downloaded and re-parsed for this work
 * (`curl` the patchstorage beta API, `zstd -dc`, read `./patch.json`), which is the recipe
 * the survey itself documents in its § 1. Everything below is the whole cable list.
 *
 * That second reading is also what found the survey's two mistakes, both recorded where
 * they matter rather than only here: a Fundamental `ENUMS(...)` macro leaking through its
 * port-name resolver as a port called `ENUMS`, and P4's ninth `f2` reported as part of the
 * fan-out when the patch file shows it has no cables at all.
 *
 * ── WHY BOTH PATCHES ARE LINEARISED, AND WHY THAT IS NOT NEGOTIABLE ─────────
 * A Rack patch may contain cycles; a PowerRP node graph may not. `core/nodeflow.js`
 * REFUSES a connection that closes one, and its reason is the determinism law rather than
 * a limitation: "a lazily-resolved cycle would quietly introduce the one kind of state this
 * app has none of" (state carried from frame N-1, which breaks Δt = 0 and frame-range
 * sharding at once). Both of these patches have real cycles — P4's aux send/return loop
 * and P22's self-patched envelope — so each is cut at ONE named place, and the cut is in
 * `deviations`. Nothing about that is a fidelity CHOICE: the alternative is a blueprint
 * that cannot be inserted.
 */

/** This set's blueprints. See the PATCH-SET CONTRACT in core/audio_patch_sets.js. */

/**
 * MICROCOSM v2 — a Hologram Microcosm pedal built out of eleven distinct kinds of module,
 * and the ONE patch in R7-17-SEL that is entirely an effect chain.
 *
 * ── WHAT MAKES IT WORTH 47 NODES ────────────────────────────────────────────
 * The Microcosm is a granular micro-looper people pay real money for, and this patch is
 * somebody's from-scratch emulation of it: FIVE NYSTHI SQUONK stage sequencers each
 * clocking its own Simpliciter granulator, fanned out through NINE squinkylabs `f2`
 * state-variable filters into a sixteen-track desk, with two Chronoblob2 delays, two
 * FrozenWasteland phasers, two NYSTHI looping delays and a Plateau plate on the aux buses.
 *
 * **THE FAN-OUT IS THE PATCH.** Five loopers and five granulators is not five copies of
 * one idea: each pair runs on its own clock at its own tempo, so the five loops drift
 * against each other and never line up, which is the whole reason the pedal sounds like a
 * cloud rather than like a delay. One looper and one granulator would be a different, much
 * worse instrument, so the count is reproduced exactly — 89 cables over 18 distinct module
 * types is the highest reuse-per-node in the whole selection.
 *
 * ── IT HAS NO SOUND SOURCE, AND WHAT WE FEED IT INSTEAD ─────────────────────
 * The original's only source is the audio interface's INPUT — a guitar or a synth in front
 * of the pedal. Three cables leave `AudioInterface#1[o0]`, into the first phaser, the fifth
 * granulator, and track 15 of the desk. Our `audio_pad` takes that jack's place at all
 * three, and a pad is the right choice rather than a convenient one: a granulator needs
 * sustained, harmonically rich material to cut grains out of, and a detuned pad is exactly
 * what the pedal's demos are played into. It is also the source the house patches already
 * use (SPACEY_PAD_DRONE), so the sound of this patch is comparable with those.
 *
 * ── THE AUX LOOP IS THE ONE PLACE THE TOPOLOGY HAD TO CHANGE ────────────────
 * MixMaster and AuxExpander talk over Rack's EXPANDER BUS — a side-channel between
 * adjacent panels with no cable at all — and the four FX chains hang off it as sends whose
 * returns come back into the same expander. That is two things PowerRP cannot express: an
 * invisible connection, and a cycle. So the bus becomes two ordinary wires into the
 * AuxExpander placeholder's `bus_l`/`bus_r`, and the four returns land in a chain of
 * `audio_mixer`s instead of back on the expander. Every module, every send and every
 * return survives; only the point where the wet signal rejoins the dry moves, and it moves
 * to the one place an acyclic graph allows.
 */
export const VCV_MICROCOSM = {
  id: "vcv-microcosm",
  title: "VCV Microcosm v2",
  help: "A Hologram Microcosm pedal, rebuilt from the real patch: five stage sequencers each clocking their own granulator, drifting against each other because no two clocks share a tempo, fanned out through nine state-variable filters whose cutoffs are driven by a four-segment pendulum simulation. A pad stands in for the guitar the original expects. Almost every module is a PLACEHOLDER — the card faces say 'pending' — so this is the wiring, not yet the sound.",
  source: {
    patch: "patchstorage 162625", file: "MICROCOSM-2-Upload-Version-63d9437e7d1fd.vcv",
    author: "DwineKcuttop", popularity: "1117 dl / 40 likes / 6214 views",
    distinct: 18, instances: 43, cables: 89,
    families: ["granular", "FDN plate reverb", "polyphony / voice allocation"],
  },
  deviations: [
    "THE AUX SEND/RETURN LOOP IS CUT. AuxExpander's four returns fed back into the same module (Plateau, Chronoblob2, Simpliciter#4 and JustAPhaser#2 all return to it), which is a cycle core/nodeflow.js refuses. The returns are summed by three chained audio_mixers instead; every module and every send is intact.",
    "THE EXPANDER BUS BECOMES TWO CABLES. MixMaster feeds AuxExpander over Rack's invisible expander channel — there is no cable between them in the patch file. The AuxExpander placeholder therefore declares `bus_l`/`bus_r` inputs and MixMaster's main pair drives them.",
    "Core/AudioInterface substituted by audio_pad at all three of its cables. The original's source is a LIVE INPUT (a guitar in front of the pedal); a sustained pad is the material a granulator wants and is the source the house patches already use.",
    "NYSTHI/MasterRecorder2 dropped — a stereo recorder between the output delays and the interface. It is a pass-through in the signal path and its job in our world is the render pipeline, not a node.",
    "squinkylabs-f2 #8 dropped: the patch file has NO cables on it at all. The survey counts nine f2 instances in the fan-out; the ninth is an unpatched spare on the rack, and an orphan node is refused by tests/audio_patches_test.js for exactly the reason it should be.",
    "Fundamental/Delay x2 substituted by our audio_delay — same topology (delay line, tone, mix) and the substitution keeps this half of the patch AUDIBLE rather than placeholder-silent. Their harvested Time dials are a normalised taper, so the times are restated in seconds: 13.1 ms and 11.6 ms, which is what the original's 0.2831/0.2651 pair works out to, and the near-miss between them is the stereo widening it is there for.",
    "THE POLY CABLE IS FLATTENED, and it costs something. Caudal#2's six pendulum taps go through Merge -> Offset -> Split so each granulator gets its OWN chaotic speed CV. PowerRP wires are monophonic, so the Merge->Offset->Split chain is preserved as structure but carries one channel: all four granulators receive the same value where the original gave each a different tap. The nodes are kept rather than bypassed because the merge/split pair IS why this patch was selected for the polyphony family.",
    "R7-UNITS: every harvested dial is CONVERTED, never copied. Volt-domain params (f2's fc/q/r, Plateau's damp and diffusion) are divided by five; normalised fractions and absolute seconds are verbatim. Dials whose real unit does not fit a placeholder's +/-10 rail are NOT carried and are listed in core/audio_stubs_vcv_fx.js's header — the five SimpleClock tempos (34-49 BPM, five different values) are the loss that matters here, because their incommensurability is what makes the five loopers drift.",
    "SQUONK's and Simpliciter's dials are not carried: those plugins are closed source, so their 117- and 40-entry param vectors are positional with no enum to name them. SQUONK's is its 12 x 11 stage matrix, which is a LIST property (core/lists.js) rather than a knob band, and VC-8 has to decide its shape.",
    "FOUR CABLE TARGETS ARE PROVISIONAL, and are listed by INDEX so nobody mistakes them for resolved. Chronoblob2 is a closed binary with no published jack order, so its `i1` and `i3` — driven from the pendulum on BOTH instances — are sent to `time` and `feedback`, which is what the symmetric +/-0.05 attenuverter pair stored beside them (`p4 = -0.048`, `p5 = 0.046` on the first, `-0.05`/`0.05` on the second) says they are: one delay time pushed up and the other down, which is a stereo spread. VC-5 owns the correction.",
    "SQUONK's `i1` -> `clock` and `o5` -> `trig`, and Simpliciter's `i2` -> `trig` and `i9` -> `speed`, are the same kind of provisional mapping. The NAMES are the vendor's own (the NYSTHI CHANGELOG documents every one of those controls); only which index carries which is unpublished. `o5` is the first output after the five documented CV channels A-E, and a stage TRIGGER into a sampler is what makes a SQUONK a micro-looper controller rather than a melody source — that is the reasoning, not a certainty.",
  ],
  nodes: [
    // ── THE SOURCE AND THE MODULATORS ─────────────────────────────────────
    // `src` is the guitar jack. Its `space`/`motion` settings are the house pad's, not
    // harvested — there is nothing to harvest, because the original has no source.
    { id: "src", type: "audio_pad", col: 0, row: 0, knobs: { frequency: 110, level: 0.35, space: "hall", cutoff: 1200, motion: 0.07 } },
    // FIVE CLOCKS, and in the original five DIFFERENT tempos (38.4, 34.5, 34.9, 48.5 and
    // 34.9 BPM). See the R7-UNITS deviation: the tempo dial cannot ride a placeholder, so
    // they arrive identical and the drift that defines this patch is owed to VC-7b.
    { id: "clk1", type: "audio_vcv_simpleclock", col: 0, row: 1 },
    { id: "clk2", type: "audio_vcv_simpleclock", col: 0, row: 2 },
    { id: "clk3", type: "audio_vcv_simpleclock", col: 0, row: 3 },
    { id: "clk4", type: "audio_vcv_simpleclock", col: 0, row: 4 },
    { id: "clk5", type: "audio_vcv_simpleclock", col: 0, row: 5 },
    // THE PENDULUM. One Caudal drives eleven of its twelve outputs into this patch: the
    // filter cutoffs, both phasers' sweeps, both Chronoblob2s' time and feedback, and both
    // output delays' time. That single chaotic system is why nothing in the patch moves
    // periodically and why everything moves TOGETHER — the outputs are correlated because
    // they are measurements of one four-segment pendulum.
    { id: "chaos", type: "audio_vcv_caudal", col: 0, row: 6 },
    // The second one is a pure CV source: its six taps become the granulators' speeds.
    { id: "chaos2", type: "audio_vcv_caudal", col: 0, row: 7, knobs: { speed: -0.396 } },
    // THE FREEZE FOOTSWITCH. A Bogaudio Manual's eighth output holds both looping delays,
    // which is the Microcosm's own hold pedal.
    { id: "freeze", type: "audio_vcv_manual", col: 0, row: 8 },

    // ── THE INPUT STAGE ───────────────────────────────────────────────────
    { id: "phaser1", type: "audio_vcv_justaphaser", col: 1, row: 0 },
    { id: "squonk1", type: "audio_vcv_squonk", col: 1, row: 1 },
    { id: "squonk2", type: "audio_vcv_squonk", col: 1, row: 2 },
    { id: "squonk3", type: "audio_vcv_squonk", col: 1, row: 3 },
    { id: "squonk4", type: "audio_vcv_squonk", col: 1, row: 4 },
    { id: "squonk5", type: "audio_vcv_squonk", col: 1, row: 5 },
    { id: "merge", type: "audio_vcv_merge", col: 1, row: 6 },

    { id: "offset", type: "audio_vcv_offset", col: 2, row: 0, knobs: { offset: 1, scale: 0.2223 } },
    // TWO LOOPING DELAYS off the phaser, held by the freeze switch. Their times come from
    // the module's own `data{}` in SECONDS — 8.48 s and 5.26 s, an incommensurate pair.
    { id: "cdelay1", type: "audio_vcv_clockabledelay", col: 2, row: 1 },
    { id: "cdelay2", type: "audio_vcv_clockabledelay", col: 2, row: 2, knobs: { time: 5.2613 } },
    { id: "grain5", type: "audio_vcv_simpliciter", col: 2, row: 3 },

    { id: "split", type: "audio_vcv_split", col: 3, row: 0 },
    // THE TWO DELAY FILTERS ARE IN HERTZ, NOT VOLTS. `fc` was harvested as squinkylabs'
    // own 0…10 V control (1.46506 and 1.50844) and VC-10's knob is that control's OUTPUT,
    // `261.6256 · 2^(v − 4)` — the law `f2CutoffVolts` inverts, and the one that produces
    // the knob's own declared 16.35 Hz…16744 Hz bounds from that 0…10 V span. As volts the
    // two numbers read as 1.5 Hz, which the engine clamps to the bottom of the knob: both
    // looping delays would have come back as mud rather than as the 45 Hz rumble filter.
    { id: "svf6", type: "audio_vcv_f2", col: 3, row: 1, knobs: { fc: 45.142672 } },
    { id: "svf7", type: "audio_vcv_f2", col: 3, row: 2, knobs: { fc: 46.520668 } },
    { id: "svf9", type: "audio_vcv_f2", col: 3, row: 3, knobs: { q: 0.5494 } },

    // ── THE FIVE GRANULATORS ──────────────────────────────────────────────
    { id: "grain1", type: "audio_vcv_simpliciter", col: 4, row: 0 },
    { id: "grain2", type: "audio_vcv_simpliciter", col: 4, row: 1 },
    { id: "grain3", type: "audio_vcv_simpliciter", col: 4, row: 2 },

    { id: "svf1", type: "audio_vcv_f2", col: 5, row: 0 },
    { id: "svf2", type: "audio_vcv_f2", col: 5, row: 1 },
    { id: "svf3", type: "audio_vcv_f2", col: 5, row: 2 },

    // ── THE DESK ──────────────────────────────────────────────────────────
    // Six granulator/delay channels, the dry input on track 15 and the phaser's stereo
    // pair on track 16. The faders and pans ARE harvested and they are what places the
    // five clouds across the stereo field.
    { id: "desk", type: "audio_vcv_mixmaster", col: 6, row: 0 },
    { id: "aux", type: "audio_vcv_auxexpander", col: 7, row: 0 },
    // The two output delays are a stereo widener: fully wet, no feedback, 13.1 ms against
    // 11.6 ms, each with its time driven by a different pendulum tap.
    { id: "haas1", type: "audio_delay", col: 7, row: 1, knobs: { time: 0.0131, feedback: 0, wet: 1, dry: 0 } },
    { id: "haas2", type: "audio_delay", col: 7, row: 2, knobs: { time: 0.0116, feedback: 0, wet: 1, dry: 0 } },

    // ── THE FOUR AUX CHAINS ───────────────────────────────────────────────
    { id: "phaser2", type: "audio_vcv_justaphaser", col: 8, row: 0, knobs: { stages: "8", feedback: 0.3971, resonance: 1.521, stereo_phase: 0.99999 } },
    { id: "grain4", type: "audio_vcv_simpliciter", col: 8, row: 1 },
    { id: "plate", type: "audio_vcv_plateau", col: 8, row: 2 },
    { id: "chrono1", type: "audio_vcv_chronoblob2", col: 8, row: 3 },

    { id: "svf4", type: "audio_vcv_f2", col: 9, row: 0, knobs: { q: 0.53494 } },
    { id: "svf5", type: "audio_vcv_f2", col: 9, row: 1, knobs: { q: 0.5494 } },
    { id: "chrono2", type: "audio_vcv_chronoblob2", col: 9, row: 2 },

    // ── THE RETURN SUM (the substitution the cycle forced) ────────────────
    { id: "ret1", type: "audio_mixer", col: 10, row: 0, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 0.8 } },
    { id: "ret2", type: "audio_mixer", col: 11, row: 0, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 0.8 } },
    { id: "ret3", type: "audio_mixer", col: 12, row: 0, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 0.8 } },

    { id: "meter", type: "audio_meter", col: 13, row: 0 },
    { id: "spectrum", type: "audio_spectrum", col: 14, row: 0 },
    { id: "out", type: "audio_output", col: 15, row: 0, knobs: { volume: 0.7 } },
  ],
  wires: [
    // THE THREE CABLES THAT LEFT THE AUDIO INTERFACE'S INPUT JACK.
    { from: "src", fromPort: "out", to: "phaser1", toPort: "in_l" },
    { from: "src", fromPort: "out", to: "grain5", toPort: "in_l" },
    { from: "src", fromPort: "out", to: "desk", toPort: "track_15_l" },
    // Five clocks, five stage sequencers. `clock` on the SQUONK is the patch's `i1`.
    { from: "clk1", fromPort: "clock", to: "squonk1", toPort: "clock" },
    { from: "clk2", fromPort: "clock", to: "squonk2", toPort: "clock" },
    { from: "clk3", fromPort: "clock", to: "squonk3", toPort: "clock" },
    { from: "clk4", fromPort: "clock", to: "squonk4", toPort: "clock" },
    { from: "clk5", fromPort: "clock", to: "squonk5", toPort: "clock" },
    // THE FIRST PHASER, swept by the pendulum's first two Y measurements.
    { from: "chaos", fromPort: "y_1", to: "phaser1", toPort: "external_mod_l" },
    { from: "chaos", fromPort: "y_2", to: "phaser1", toPort: "external_mod_r" },
    // …and fanned into three granulators, two looping delays and the desk. Note the
    // asymmetry, which is the original's and not a slip: granulators 1 and 3 take the
    // phaser's LEFT output and granulator 2 takes its RIGHT, so the phaser's stereo
    // separation becomes a difference in WHICH grain cloud hears what.
    { from: "phaser1", fromPort: "out_l", to: "grain1", toPort: "in_l" },
    { from: "phaser1", fromPort: "out_r", to: "grain2", toPort: "in_l" },
    { from: "phaser1", fromPort: "out_l", to: "grain3", toPort: "in_l" },
    { from: "phaser1", fromPort: "out_l", to: "cdelay1", toPort: "in_l" },
    { from: "phaser1", fromPort: "out_l", to: "cdelay2", toPort: "in_l" },
    { from: "phaser1", fromPort: "out_l", to: "desk", toPort: "track_16_l" },
    { from: "phaser1", fromPort: "out_r", to: "desk", toPort: "track_16_r" },
    { from: "freeze", fromPort: "out8", to: "cdelay1", toPort: "hold" },
    { from: "freeze", fromPort: "out8", to: "cdelay2", toPort: "hold" },
    // THE CV DISTRIBUTION. Six taps of the second pendulum, merged, scaled by an Offset
    // and split back out — one speed per granulator. See the flattening deviation.
    { from: "chaos2", fromPort: "x_1", to: "merge", toPort: "mono_1" },
    { from: "chaos2", fromPort: "x_2", to: "merge", toPort: "mono_2" },
    { from: "chaos2", fromPort: "x_3", to: "merge", toPort: "mono_3" },
    { from: "chaos2", fromPort: "x_4", to: "merge", toPort: "mono_4" },
    { from: "chaos2", fromPort: "y_1", to: "merge", toPort: "mono_5" },
    { from: "chaos2", fromPort: "y_2", to: "merge", toPort: "mono_6" },
    { from: "merge", fromPort: "poly", to: "offset", toPort: "in" },
    { from: "offset", fromPort: "out", to: "split", toPort: "poly" },
    { from: "split", fromPort: "mono_1", to: "grain1", toPort: "speed" },
    { from: "split", fromPort: "mono_2", to: "grain2", toPort: "speed" },
    { from: "split", fromPort: "mono_3", to: "grain3", toPort: "speed" },
    { from: "split", fromPort: "mono_4", to: "grain4", toPort: "speed" },
    // EACH SQUONK'S STAGE TRIGGER FIRES ITS OWN LOOPER. This is the wire that makes a
    // SQUONK a micro-looper controller rather than a melody source, and it is the reason
    // five clocks at five tempos produce five independent grain clouds.
    { from: "squonk1", fromPort: "trig", to: "grain1", toPort: "trig" },
    { from: "squonk2", fromPort: "trig", to: "grain2", toPort: "trig" },
    { from: "squonk3", fromPort: "trig", to: "grain3", toPort: "trig" },
    { from: "squonk4", fromPort: "trig", to: "grain4", toPort: "trig" },
    { from: "squonk5", fromPort: "trig", to: "grain5", toPort: "trig" },
    // EVERY CLOUD GETS ITS OWN STATE-VARIABLE FILTER, cutoff on a pendulum tap.
    // The jack is `fc_cv`, not `fc`: squinkylabs' `composites/F2.h` has an `FC_PARAM`
    // beside its `FC_INPUT`, and the `_cv` suffix is how a jack that would collide with a
    // knob is spelled here. Same index (1), same wire.
    { from: "grain1", fromPort: "out_l", to: "svf1", toPort: "audio" },
    { from: "chaos", fromPort: "x_1", to: "svf1", toPort: "fc_cv" },
    { from: "grain2", fromPort: "out_l", to: "svf2", toPort: "audio" },
    { from: "chaos", fromPort: "x_2", to: "svf2", toPort: "fc_cv" },
    { from: "grain3", fromPort: "out_l", to: "svf3", toPort: "audio" },
    { from: "chaos", fromPort: "x_3", to: "svf3", toPort: "fc_cv" },
    { from: "grain5", fromPort: "out_l", to: "svf9", toPort: "audio" },
    { from: "chaos2", fromPort: "y_3", to: "svf9", toPort: "fc_cv" },
    { from: "cdelay1", fromPort: "out_l", to: "svf6", toPort: "audio" },
    { from: "chaos", fromPort: "a_3", to: "svf6", toPort: "fc_cv" },
    { from: "cdelay2", fromPort: "out_l", to: "svf7", toPort: "audio" },
    // THE DESK, in the original's own channel order — which is NOT the filters' order
    // (f2 #3 lands on track 2 and #2 on track 3), and the pans are per track, so the
    // ordering decides where in the stereo field each cloud sits.
    { from: "svf1", fromPort: "audio", to: "desk", toPort: "track_1_l" },
    { from: "svf3", fromPort: "audio", to: "desk", toPort: "track_2_l" },
    { from: "svf2", fromPort: "audio", to: "desk", toPort: "track_3_l" },
    { from: "svf6", fromPort: "audio", to: "desk", toPort: "track_4_l" },
    { from: "svf7", fromPort: "audio", to: "desk", toPort: "track_5_l" },
    { from: "svf9", fromPort: "audio", to: "desk", toPort: "track_6_l" },
    // THE AUX BUS, made explicit (see the deviation).
    { from: "desk", fromPort: "main_l", to: "aux", toPort: "bus_l" },
    { from: "desk", fromPort: "main_r", to: "aux", toPort: "bus_r" },
    // SEND 1 — the plate.
    { from: "aux", fromPort: "send_1_l", to: "plate", toPort: "in_l" },
    { from: "aux", fromPort: "send_1_r", to: "plate", toPort: "in_r" },
    // SEND 2 — two Chronoblob2s in series, both time-and-feedback modulated.
    { from: "aux", fromPort: "send_2_l", to: "chrono1", toPort: "in_l" },
    { from: "aux", fromPort: "send_2_r", to: "chrono1", toPort: "in_r" },
    { from: "chaos", fromPort: "a_1", to: "chrono1", toPort: "time" },
    { from: "chaos", fromPort: "a_2", to: "chrono1", toPort: "feedback" },
    { from: "chrono1", fromPort: "out_l", to: "chrono2", toPort: "in_l" },
    { from: "chrono1", fromPort: "out_r", to: "chrono2", toPort: "in_r" },
    { from: "chaos", fromPort: "a_1", to: "chrono2", toPort: "time" },
    { from: "chaos", fromPort: "x_3", to: "chrono2", toPort: "feedback" },
    // SEND 3 — a granulator ON THE AUX BUS, so the wet mix is itself granulated, and its
    // two outputs go to two SEPARATE filters. That is the send that makes the patch a
    // Microcosm rather than a reverb.
    { from: "aux", fromPort: "send_3_l", to: "grain4", toPort: "in_l" },
    { from: "aux", fromPort: "send_3_r", to: "grain4", toPort: "in_r" },
    { from: "grain4", fromPort: "out_l", to: "svf4", toPort: "audio" },
    { from: "chaos", fromPort: "x_4", to: "svf4", toPort: "fc_cv" },
    { from: "grain4", fromPort: "out_r", to: "svf5", toPort: "audio" },
    { from: "chaos", fromPort: "x_4", to: "svf5", toPort: "fc_cv" },
    // SEND 4 — the second phaser, eight stages against the first one's four.
    { from: "aux", fromPort: "send_4_l", to: "phaser2", toPort: "in_l" },
    { from: "aux", fromPort: "send_4_r", to: "phaser2", toPort: "in_r" },
    { from: "chaos", fromPort: "y_3", to: "phaser2", toPort: "external_mod_l" },
    { from: "chaos", fromPort: "y_4", to: "phaser2", toPort: "external_mod_r" },
    // THE RETURNS, summed here instead of on the expander.
    { from: "plate", fromPort: "out_l", to: "ret1", toPort: "in1" },
    { from: "plate", fromPort: "out_r", to: "ret1", toPort: "in2" },
    { from: "chrono2", fromPort: "out_l", to: "ret1", toPort: "in3" },
    { from: "chrono2", fromPort: "out_r", to: "ret1", toPort: "in4" },
    { from: "ret1", fromPort: "out", to: "ret2", toPort: "in1" },
    { from: "svf4", fromPort: "audio", to: "ret2", toPort: "in2" },
    { from: "svf5", fromPort: "audio", to: "ret2", toPort: "in3" },
    { from: "phaser2", fromPort: "out_l", to: "ret2", toPort: "in4" },
    // THE DRY PATH — the desk's main pair through the two widening delays.
    { from: "desk", fromPort: "main_l", to: "haas1", toPort: "in" },
    { from: "chaos", fromPort: "a_4", to: "haas1", toPort: "time" },
    { from: "desk", fromPort: "main_r", to: "haas2", toPort: "in" },
    { from: "chaos", fromPort: "x_2", to: "haas2", toPort: "time" },
    { from: "ret2", fromPort: "out", to: "ret3", toPort: "in1" },
    { from: "phaser2", fromPort: "out_r", to: "ret3", toPort: "in2" },
    { from: "haas1", fromPort: "out", to: "ret3", toPort: "in3" },
    { from: "haas2", fromPort: "out", to: "ret3", toPort: "in4" },
    { from: "ret3", fromPort: "out", to: "meter", toPort: "in" },
    { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
    { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
  ],
};

/**
 * CIANI'S BUCHLA, PERFORMANCE PATCH — 36 distinct kinds of module, and the most PERFORMED
 * patch in R7-17-SEL. Suzanne Ciani's west-coast instrument, rebuilt in Rack by `pyer` and
 * rebuilt again here from his patch file.
 *
 * ── WHY THIS ONE, OUT OF 421 PARSED PATCHES ─────────────────────────────────
 * It is a WHOLE INSTRUMENT rather than a texture, and it is built out of the Buchla
 * lineage: a 208's dual low-pass gate and two of its envelopes, a 266 Source of
 * Uncertainty for randomness, a Serge programmer for melody, three Vult oscillators
 * through a Bogaudio 8x8 matrix, and four chained quad panners so the sound MOVES around
 * the room while you play it. Its headline module is squinkylabs' **freqshifter** — a true
 * single-sideband frequency shifter, which moves every partial by the same number of HERTZ
 * instead of the same RATIO, so the result is inharmonic. That is a genuinely different
 * algorithm from every other pitch module in the selection, and it is the reason this patch
 * carries the pitch-shifting family on its own.
 *
 * ── IT IS PLAYED, SO WE GIVE IT A KEYBOARD ──────────────────────────────────
 * The original's only source of events is `Core/MIDIToCVInterface` — pitch out of `o0`
 * into the sample-and-hold bank, gate out of `o1` into the Switch18 that fans it to
 * everything else. Our `node_keyboard` has exactly those two outputs (`pitch` and `gate`)
 * with exactly those meanings, so it is a substitution rather than a stand-in, and it makes
 * the patch playable with the mouse the way PLAYABLE_KEYS is. That is the right call for
 * the most-performed patch in the set.
 *
 * ── HOW TO READ THE GRAPH ───────────────────────────────────────────────────
 * One key press fans out through the Switch18 into an OR-gate bank, an 8:1 rotary and a
 * 1:8 rotary — the trigger distribution. Those triggers clock the SH-8, whose three held
 * voltages are ADDED (Bogaudio Sums) to a slewed, quantized, octave-shifted sequencer
 * pitch, and the three sums tune the three oscillators. The oscillators, the frequency
 * shifter and a noise source meet in the 8x8 matrix, which feeds two self-oscillating Vult
 * filters, a six-band formant bank, and the dual LPG — the LPG's four channels are opened
 * by the two 208 envelopes, and its four outputs go to the four panners, then the plate,
 * then the limiter.
 */
export const VCV_CIANI_BUCHLA = {
  id: "vcv-ciani-buchla",
  title: "VCV Ciani's Buchla",
  help: "Suzanne Ciani's west-coast instrument: PLAY IT with the keyboard. One key press fans out through an OR-gate bank into three sampled voltages that tune three oscillators; they meet in an 8x8 matrix with a true single-sideband frequency shifter, pass two self-oscillating filters and a formant bank into a Buchla 208 dual low-pass gate, and four chained quad panners move the result around the room before the plate. Most of it is PLACEHOLDERS — the cards say 'pending' — so this is the wiring, not yet the sound.",
  source: {
    patch: "patchstorage 141823", file: "PERFORMANCE-PATCH.vcv",
    author: "pyer", popularity: "1658 dl / 37 likes / 2954 views",
    distinct: 38, instances: 52, cables: 132,
    families: ["pitch shifting", "vocoder / spectral", "chaotic / generative sequencing", "polyphony / voice allocation", "FDN plate reverb"],
  },
  deviations: [
    "THE PITCH FEEDBACK LOOP IS CUT IN ONE PLACE, and it is the patch's most interesting cycle: the quantized pitch is octave-shifted, SLEWED, and fed back through MergeSplit4 into BOTH AddrSeq sequencers' SELECT inputs — so the sequence chooses its own next step from the note it just played. That is two loops sharing one edge, and core/nodeflow.js refuses a cycle. The two `MergeSplit4#1 -> AddrSeq select` cables are the cut (2 of 132); everything else in the loop, including the slew and both sequencers, is intact and reachable.",
    "BOTH b208_envelope SELF-PATCHES ARE DROPPED: `o4 -> i4` on each instance, which is how a function generator is made to LOOP — its end-of-cycle pulse retriggers itself, turning an envelope into a free-running LFO. A one-node cycle is still a cycle. This is a real behavioural loss and the reason both envelopes here will fire once per gate instead of cycling.",
    "Core/MIDIToCVInterface substituted by node_keyboard — an exact match on the two ports the patch uses (`pitch` and `gate`), and it makes the patch playable by mouse.",
    "Core/AudioInterface2 substituted by audio_output. The original takes the limiter's L and R into two interface channels; our output holds ONE source per input, so an audio_mixer folds the stereo pair before the meter rather than one channel being silently dropped.",
    "Fundamental/Quantizer and Fundamental/Octave are PLACEHOLDERS, not substitutions onto our audio_quantize, and NODE_REGISTRY.md's `variant(ours)` note is about the WORK being small rather than about the semantics matching. Fundamental's quantizer snaps a V/oct CV to a user-chosen note set and its jacks are `pitch` in and `pitch` out; our audio_quantize takes an AUDIO signal. Substituting there would have put an audio-rate node in a CV chain.",
    "FOUR MODULES DROPPED, and all four are unpatched or portless in the patch file itself, which is the strongest possible evidence they are furniture: JW-Modules/FullScope (a decorative Lissajous scope — its three cables are the only ones lost to a drop), Stoermelder-P1/Glue (a panel-annotation utility), SubmarineFree/WM-101 (a wire manager; its enum has NO inputs and NO outputs at all, only `PARAM_DRAW_3D` and `PARAM_LOCKED`), and Bogaudio/AddrSeqX x2.",
    "Bogaudio-AddrSeqX is an EXPANDER: `enum InputIds { NUM_INPUTS }` and `enum OutputIds { NUM_OUTPUTS }` — it has no jacks, and communicates over Rack's expander bus to add eight more steps to the AddrSeq beside it. PowerRP has no expander concept and a node with no ports would be an orphan, so its eight step values belong on the AddrSeq placeholder's own knobs. Both instances are unpatched in the file.",
    "ZZC/Div dropped: its outputs are unpatched in the original — the clock's PHASE and RESET go into it and nothing comes out, because ZZC modules also link over an expander bus. An unreachable node is refused by tests/audio_patches_test.js, and this one contributes nothing to the sound.",
    "R7-UNITS: values converted, not copied. Surveillance's four manual voltages are /5 (-1.0 V becomes -0.2). PolyCon8's two channels are a V/oct CONSTANT, so clause 3 applies and -1.0 V becomes -12 SEMITONES. Normalised Vult and Bogaudio dials are verbatim. The freqshifter's 500 Hz shift RANGE and the clock's 147 BPM cannot ride a placeholder's +/-10 rail and are not carried — see core/audio_stubs_vcv_fx.js's header.",
    "PORT KEYS ARE INDICES WHERE THE INDEX IS ALL WE HAVE: ShapeMaster, the Serge Programmer, the Source of Uncertainty and both 208 envelopes wire to keys like `i8` and `o19`. That is deliberate — those modules' jack order is not published (NYSTHI ships no source at any ref; MindMeld's ShapeMaster module struct is absent from the mirror we have), and a plausible name over an unverified index would make a guess look resolved. The modules whose layout the CABLES prove — the dual LPG's 4 audio + 4 CV + 4 out, and the quad panners' front/rear chain — do get real names, and each row says which it is.",
    "Bleak's `i2` is wired to `wave`. Vult's manual lists Tune, Oct, PW and Wave as its controls and only V/OCT as a named jack, so which CV input index 2 is cannot be read off the document. A sequencer morphing the waveform is the west-coast gesture and WAVE is the only continuous target left, but it is an inference, flagged here rather than buried.",
  ],
  nodes: [
    { id: "matrix", type: "audio_vcv_matrix88", col: 12, row: 0 },
    { id: "formant", type: "audio_vcv_peq6", col: 13, row: 0 },
    { id: "noise", type: "audio_vcv_bog_noise", col: 0, row: 0 },
    { id: "oneeight", type: "audio_vcv_oneeight", col: 2, row: 0 },
    { id: "polycon", type: "audio_vcv_polycon8", col: 0, row: 1 },
    { id: "sh2", type: "audio_vcv_samplehold", col: 2, row: 1 },
    { id: "slew", type: "audio_vcv_slew", col: 7, row: 0 },
    { id: "sum1", type: "audio_vcv_sums", col: 9, row: 0 },
    { id: "sum2", type: "audio_vcv_sums", col: 7, row: 1 },
    { id: "sum3", type: "audio_vcv_sums", col: 9, row: 1 },
    { id: "pitchsel", type: "audio_vcv_switch", col: 3, row: 0 },
    { id: "gatesel", type: "audio_vcv_switch", col: 2, row: 2 },
    { id: "fan", type: "audio_vcv_switch18", col: 1, row: 0 },
    { id: "seq1", type: "audio_vcv_addrseq", col: 0, row: 2 },
    { id: "seq2", type: "audio_vcv_addrseq", col: 0, row: 3 },
    { id: "pick", type: "audio_vcv_eightone", col: 2, row: 3 },
    { id: "limiter", type: "audio_vcv_lmtr", col: 20, row: 0 },
    { id: "aten", type: "audio_vcv_dualatenuverter", col: 3, row: 1 },
    { id: "octave", type: "audio_vcv_octave", col: 6, row: 0 },
    { id: "quant", type: "audio_vcv_quantizer", col: 4, row: 0 },
    { id: "ms1", type: "audio_vcv_mergesplit4", col: 8, row: 0 },
    { id: "ms2", type: "audio_vcv_mergesplit4", col: 5, row: 0 },
    { id: "shapes", type: "audio_vcv_shapemaster", col: 4, row: 1 },
    { id: "prog", type: "audio_vcv_programmer", col: 1, row: 1 },
    { id: "pan1", type: "audio_vcv_quadpanner", col: 15, row: 0 },
    { id: "pan2", type: "audio_vcv_quadpanner", col: 16, row: 0 },
    { id: "pan3", type: "audio_vcv_quadpanner", col: 17, row: 0 },
    { id: "pan4", type: "audio_vcv_quadpanner", col: 18, row: 0 },
    { id: "sou", type: "audio_vcv_soymodelsou", col: 1, row: 2 },
    { id: "volts", type: "audio_vcv_surveillance", col: 0, row: 4 },
    { id: "lpg", type: "audio_vcv_b208duallpg", col: 14, row: 0 },
    { id: "env1", type: "audio_vcv_b208envelope", col: 6, row: 1 },
    { id: "env2", type: "audio_vcv_b208envelope", col: 6, row: 2 },
    { id: "or1", type: "audio_vcv_og104", col: 3, row: 2 },
    { id: "or2", type: "audio_vcv_og104", col: 5, row: 1 },
    { id: "plate", type: "audio_vcv_plateau", col: 19, row: 0 },
    { id: "osc1", type: "audio_vcv_bleak", col: 10, row: 0 },
    { id: "osc2", type: "audio_vcv_bleak", col: 10, row: 1 },
    { id: "osc3", type: "audio_vcv_bleak", col: 8, row: 1 },
    { id: "filt1", type: "audio_vcv_unstabile", col: 13, row: 1 },
    { id: "filt2", type: "audio_vcv_unstabile", col: 13, row: 2 },
    { id: "clock", type: "audio_vcv_clock", col: 0, row: 5 },
    { id: "sh8", type: "audio_vcv_sh8", col: 6, row: 3 },
    { id: "shifter", type: "audio_vcv_freqshifter", col: 11, row: 0 },
    { id: "keys", type: "node_keyboard", col: 0, row: 6, w: 196, knobs: { baseNote: 36, octaves: 2 } },
    { id: "out", type: "audio_output", col: 24, row: 0, knobs: { volume: 0.7 } },
    { id: "fold", type: "audio_mixer", col: 21, row: 0, knobs: { level1: 1, level2: 1, master: 0.9 } },
    { id: "meter", type: "audio_meter", col: 22, row: 0 },
    { id: "spectrum", type: "audio_spectrum", col: 23, row: 0 },
  ],
  wires: [
    { from: "matrix", fromPort: "out1", to: "filt1", toPort: "in" },
    { from: "matrix", fromPort: "out2", to: "filt2", toPort: "in" },
    { from: "matrix", fromPort: "out3", to: "formant", toPort: "in" },
    { from: "matrix", fromPort: "out4", to: "lpg", toPort: "in_4" },
    { from: "filt1", fromPort: "bp", to: "lpg", toPort: "in_1" },
    { from: "filt2", fromPort: "bp", to: "lpg", toPort: "in_2" },
    { from: "formant", fromPort: "out", to: "lpg", toPort: "in_3" },
    { from: "lpg", fromPort: "out_3", to: "pan2", toPort: "in" },
    { from: "lpg", fromPort: "out_2", to: "pan3", toPort: "in" },
    { from: "lpg", fromPort: "out_1", to: "pan4", toPort: "in" },
    { from: "pan3", fromPort: "out_fl", to: "pan4", toPort: "chain_fl" },
    { from: "pan3", fromPort: "out_fr", to: "pan4", toPort: "chain_fr" },
    { from: "pan2", fromPort: "out_fl", to: "pan3", toPort: "chain_fl" },
    { from: "pan2", fromPort: "out_fr", to: "pan3", toPort: "chain_fr" },
    { from: "pan1", fromPort: "out_fl", to: "pan2", toPort: "chain_fl" },
    { from: "pan1", fromPort: "out_fr", to: "pan2", toPort: "chain_fr" },
    { from: "osc1", fromPort: "out", to: "matrix", toPort: "in1" },
    { from: "osc2", fromPort: "out", to: "matrix", toPort: "in2" },
    { from: "env2", fromPort: "o5", to: "lpg", toPort: "cv_4" },
    { from: "lpg", fromPort: "out_4", to: "pan1", toPort: "in" },
    { from: "sum3", fromPort: "sum", to: "osc1", toPort: "v_oct" },
    { from: "sum1", fromPort: "sum", to: "osc2", toPort: "v_oct" },
    { from: "sum2", fromPort: "sum", to: "osc3", toPort: "v_oct" },
    { from: "env1", fromPort: "o5", to: "lpg", toPort: "cv_3" },
    { from: "octave", fromPort: "pitch", to: "slew", toPort: "in" },
    { from: "quant", fromPort: "pitch", to: "octave", toPort: "pitch" },
    { from: "seq1", fromPort: "out", to: "pitchsel", toPort: "low1" },
    { from: "pitchsel", fromPort: "out1", to: "quant", toPort: "pitch" },
    { from: "seq1", fromPort: "out", to: "pick", toPort: "select_cv" },
    { from: "pick", fromPort: "out", to: "pitchsel", toPort: "high1" },
    { from: "prog", fromPort: "o16", to: "pick", toPort: "in1" },
    { from: "prog", fromPort: "o17", to: "pick", toPort: "in2" },
    { from: "prog", fromPort: "o18", to: "pick", toPort: "in3" },
    { from: "prog", fromPort: "o19", to: "pick", toPort: "in4" },
    { from: "aten", fromPort: "out1", to: "shapes", toPort: "i8" },
    { from: "aten", fromPort: "out1", to: "shapes", toPort: "i9" },
    { from: "aten", fromPort: "out1", to: "shapes", toPort: "i10" },
    { from: "aten", fromPort: "out1", to: "shapes", toPort: "i11" },
    { from: "aten", fromPort: "out2", to: "shapes", toPort: "i12" },
    { from: "aten", fromPort: "out2", to: "shapes", toPort: "i13" },
    { from: "aten", fromPort: "out2", to: "shapes", toPort: "i14" },
    { from: "aten", fromPort: "out2", to: "shapes", toPort: "i15" },
    { from: "sh2", fromPort: "out1", to: "aten", toPort: "in1" },
    { from: "sou", fromPort: "o7", to: "pan4", toPort: "x" },
    { from: "sou", fromPort: "o7", to: "pan3", toPort: "x" },
    { from: "or1", fromPort: "output_2", to: "sh8", toPort: "trig_1" },
    { from: "or1", fromPort: "output_4", to: "sh8", toPort: "trig_2" },
    { from: "or2", fromPort: "output_2", to: "sh8", toPort: "trig_3" },
    { from: "fan", fromPort: "out1", to: "or1", toPort: "input_a_1" },
    { from: "fan", fromPort: "out1", to: "or1", toPort: "input_a_3" },
    { from: "fan", fromPort: "out1", to: "or2", toPort: "input_a_1" },
    { from: "fan", fromPort: "out2", to: "gatesel", toPort: "gate" },
    { from: "fan", fromPort: "out2", to: "gatesel", toPort: "high1" },
    { from: "fan", fromPort: "out2", to: "gatesel", toPort: "low2" },
    { from: "fan", fromPort: "out3", to: "oneeight", toPort: "clock" },
    { from: "fan", fromPort: "out3", to: "oneeight", toPort: "in" },
    { from: "oneeight", fromPort: "out1", to: "or1", toPort: "input_a_2" },
    { from: "oneeight", fromPort: "out2", to: "or1", toPort: "input_a_4" },
    { from: "oneeight", fromPort: "out3", to: "or2", toPort: "input_a_2" },
    { from: "gatesel", fromPort: "out1", to: "or1", toPort: "input_b_1" },
    { from: "gatesel", fromPort: "out2", to: "or2", toPort: "input_b_1" },
    { from: "sh8", fromPort: "hold_1", to: "sum3", toPort: "a" },
    { from: "sh8", fromPort: "hold_2", to: "sum1", toPort: "a" },
    { from: "sh8", fromPort: "hold_3", to: "sum2", toPort: "a" },
    { from: "env1", fromPort: "o2", to: "lpg", toPort: "cv_1" },
    { from: "clock", fromPort: "clock_16ths", to: "sh2", toPort: "trigger1" },
    { from: "sh2", fromPort: "out2", to: "aten", toPort: "in2" },
    { from: "env2", fromPort: "o2", to: "lpg", toPort: "cv_2" },
    { from: "volts", fromPort: "out_1", to: "env1", toPort: "i3" },
    { from: "volts", fromPort: "out_3", to: "env1", toPort: "i7" },
    { from: "volts", fromPort: "out_4", to: "env2", toPort: "i7" },
    { from: "volts", fromPort: "out_2", to: "env2", toPort: "i3" },
    { from: "clock", fromPort: "clock_16ths", to: "shapes", toPort: "i2" },
    { from: "shapes", fromPort: "o6", to: "or2", toPort: "input_a_4" },
    { from: "clock", fromPort: "clock_16ths", to: "shapes", toPort: "i6" },
    { from: "shapes", fromPort: "o7", to: "or2", toPort: "input_b_4" },
    { from: "sou", fromPort: "o12", to: "shapes", toPort: "i7" },
    { from: "pan1", fromPort: "out_rl", to: "pan2", toPort: "chain_rl" },
    { from: "sou", fromPort: "o6", to: "pan4", toPort: "y" },
    { from: "sou", fromPort: "o6", to: "pan3", toPort: "y" },
    { from: "sou", fromPort: "o6", to: "pan1", toPort: "y" },
    { from: "plate", fromPort: "out_l", to: "limiter", toPort: "left" },
    { from: "plate", fromPort: "out_r", to: "limiter", toPort: "right" },
    { from: "sou", fromPort: "o7", to: "pan1", toPort: "x" },
    { from: "clock", fromPort: "reset", to: "prog", toPort: "i0" },
    { from: "shapes", fromPort: "o2", to: "or2", toPort: "input_a_3" },
    { from: "or2", fromPort: "output_4", to: "env2", toPort: "i0" },
    { from: "or2", fromPort: "output_3", to: "env1", toPort: "i0" },
    { from: "env2", fromPort: "o5", to: "filt2", toPort: "cutoff" },
    { from: "env1", fromPort: "o5", to: "filt1", toPort: "cutoff" },
    { from: "gatesel", fromPort: "out2", to: "or1", toPort: "input_b_3" },
    // POLYCON8 HAS ONE JACK IN RACK AND EIGHT HERE. Its `OutputsIds` is a single
    // `OUT_OUTPUT` carrying eight POLY channels, and VC-3b's node splits that cable into
    // eight mono outlets because PowerRP has no polyphony. Both cables in the original run
    // from that one jack, so both take CHANNEL 1 — and the harvest's two set channels are
    // −1 V each, so which channel a mono reader picks makes no audible difference here.
    // `rise_cv`/`fall_cv` for the reason F2's `fc_cv` has it: `RISE_INPUT` sits beside a
    // `RISE_PARAM`.
    { from: "polycon", fromPort: "out1", to: "slew", toPort: "rise_cv" },
    { from: "polycon", fromPort: "out1", to: "slew", toPort: "fall_cv" },
    { from: "shapes", fromPort: "o8", to: "ms1", toPort: "in_a_1" },
    { from: "shapes", fromPort: "o12", to: "ms1", toPort: "in_a_2" },
    { from: "shapes", fromPort: "o9", to: "ms2", toPort: "in_a_1" },
    { from: "shapes", fromPort: "o13", to: "ms2", toPort: "in_a_2" },
    { from: "ms2", fromPort: "poly_out_a", to: "octave", toPort: "octave" },
    { from: "slew", fromPort: "out", to: "ms1", toPort: "poly_in_b" },
    { from: "ms1", fromPort: "out_b_1", to: "sum3", toPort: "b" },
    { from: "ms1", fromPort: "out_b_2", to: "sum1", toPort: "b" },
    { from: "seq2", fromPort: "out", to: "ms2", toPort: "poly_in_b" },
    { from: "ms2", fromPort: "out_b_1", to: "osc1", toPort: "wave" },
    { from: "ms2", fromPort: "out_b_2", to: "osc2", toPort: "wave" },
    { from: "clock", fromPort: "clock_16ths", to: "prog", toPort: "i16" },
    { from: "prog", fromPort: "o19", to: "pick", toPort: "in5" },
    { from: "osc3", fromPort: "out", to: "matrix", toPort: "in3" },
    { from: "osc2", fromPort: "out", to: "shifter", toPort: "audio_r" },
    { from: "clock", fromPort: "clock_16ths", to: "sou", toPort: "i0" },
    { from: "env2", fromPort: "o5", to: "pan2", toPort: "x" },
    { from: "env1", fromPort: "o5", to: "pan2", toPort: "y" },
    { from: "keys", fromPort: "pitch", to: "sh8", toPort: "noise" },
    { from: "keys", fromPort: "gate", to: "fan", toPort: "in" },
    { from: "sou", fromPort: "o6", to: "sh2", toPort: "in1" },
    { from: "sou", fromPort: "o6", to: "sh2", toPort: "in2" },
    { from: "clock", fromPort: "clock_16ths", to: "sh2", toPort: "trigger2" },
    { from: "pan4", fromPort: "out_fl", to: "plate", toPort: "in_l" },
    { from: "pan4", fromPort: "out_fr", to: "plate", toPort: "in_r" },
    { from: "shifter", fromPort: "sin_r", to: "matrix", toPort: "in4" },
    { from: "osc1", fromPort: "out", to: "shifter", toPort: "cv" },
    { from: "noise", fromPort: "white", to: "matrix", toPort: "in5" },
    { from: "limiter", fromPort: "left", to: "fold", toPort: "in1" },
    { from: "limiter", fromPort: "right", to: "fold", toPort: "in2" },
    { from: "fold", fromPort: "out", to: "meter", toPort: "in" },
    { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
    { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
  ],
};

export const BLOCK_PATCHES = [VCV_MICROCOSM, VCV_CIANI_BUCHLA];
