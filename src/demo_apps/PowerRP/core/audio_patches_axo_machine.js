/**
 * DEMO PATCHES — Axoloti — the drum machine and the Mutable stack.
 *
 * Part of R7-17-SEL's 20 headline patches; see `claude_instructions.md` for the full
 * table and for the user ruling that chose them (*"20 impressive, fully-equipped patches
 * with tons of likes and views"*). The blueprint format, the grid layout rule and the
 * meter/spectrum tail are documented ONCE in `core/audio_patches.js` — read that file's
 * header before adding anything here. The aggregation contract is in
 * `core/audio_patch_sets.js`.
 *
 * THIS SET REBUILDS:
 *   - A10 demos/sequencing/drseq.axp — the largest factory patch: 53 distinct / 111 objects
 *   - C11 mtyas/messymix/big MI stingy patch.axp — four Mutable engines at once, poly 5
 *
 * Every blueprint here carries `source` (the harvested file, its author, its popularity
 * figures, its distinct-module count) and `deviations` (what we did NOT reproduce, and
 * why) — an UNRECORDED substitution is the silent divergence R7-17-SEL exists to prevent.
 *
 * A node this set needs but the library does not yet have is a PLACEHOLDER, declared in
 * the companion `core/audio_stubs_axo_machine.js`. Read `core/audio_stub_nodes.js` first:
 * a placeholder carries the FINAL type name and the FINAL port names, so the wire written
 * here today is the wire the real module gets.
 *
 * ── THE GRID WAS COMPUTED, NOT EYEBALLED, AND THAT IS WORTH KNOWING ─────────
 * A10 is 108 nodes and 143 wires. `{col}` is each node's LONGEST PATH from a source, so
 * the Reaktor left-to-right law (`tests/audio_patches_test.js`: every wire's `from.col <=
 * to.col`) holds by construction rather than by inspection; `{row}` is its lane's band —
 * clock, bass drum, hi-hat, snare, bass, acid, burst, pink, sum, top to bottom — so a
 * drum machine reads as one voice per stripe. THE CONSEQUENCE, so nobody "fixes" it: a
 * node's column is where its DEEPEST input puts it, so an unmodulated source (a noise
 * generator, an oscillator with a fixed pitch) sits at column 0 far to the LEFT of the
 * multiplier it feeds. That is the law being obeyed, not a layout bug.
 *
 * ── FOUR UNIT RULES DECIDE EVERY NUMBER BELOW ───────────────────────────────
 * Axoloti has ONE wire type (frac32) and reads it differently at every destination; our
 * nodes speak real units. Getting this wrong transposes or mutes a whole lane, so the
 * four conversions are stated once here and referenced by the `deviations` that use them.
 *
 *   1. A DIAL OF 64 IS 1.0. A `frac32.u.map` / `frac32.s.map` param's real value is
 *      dial/64, which is why an audio gain harvested as `28.5` is written `0.445312`.
 *   2. PITCH IS SEMITONES FROM E4 and a frac32 pitch wire is ×64 (AX-2's header). The
 *      two factors CANCEL for a value that travels dial → wire → pitch inlet, so a
 *      transposition table harvested as `0, −2, 3, −5` is written unchanged: those ARE
 *      semitones.
 *   3. `conv/to i` IS A ×64, not a no-op. AX-1 absorbed their `to f` / `to i` into
 *      nothing because they are type coercions — true of the TYPE, but the frac32→int32
 *      coercion is `>>21`, so a 0…1 signal becomes 0…64. Where that integer is a STEP
 *      INDEX the ×64 has to survive, and it is folded into the mixer that feeds it
 *      (§ A10 deviations). Here too the factors cancel and the harvested dial is what
 *      the knob carries.
 *   4. A KNOB IS AN OFFSET THE WIRE SUMS INTO (core/audio_patches.js SEQUENCED_DINGS).
 *      So every VCA whose `gain` is driven by an envelope sits at `gain: 0` and every
 *      `audio_ax_math` whose `b` is wired sits at `b: 0` — the source objects have no
 *      param there at all, and leaving our default of 1 would mean a VCA that never
 *      closes and a ring modulator that passes its carrier through.
 */

/** This set's blueprints. See the PATCH-SET CONTRACT in core/audio_patch_sets.js. */

/**
 * A10 — THE LARGEST FACTORY PATCH THERE IS: an 8-pattern drum machine, an FM bass with
 * per-step glide, an acid lane, an LFSR noise-burst lane and an FDN reverb on the snare.
 *
 * ── WHY THIS PATCH IS THE ANTI-GAMING PROOF ─────────────────────────────────
 * 111 objects, 53 distinct types. The user's ruling was *"Do not choose teh easy nodes or
 * the easy patches. That's lazy"*, and this is the factory library's answer to it: seven
 * `sel/sel 4l 16 8t s` banks each holding EIGHT sixteen-step patterns as packed int32s,
 * three separately-swung step indices, a four-bar transposition table, per-step accent
 * latched into each drum's decay, and a 2-op FM bass whose glide is enabled per step.
 * Nothing here is trimmed to fit what is already ported — that trimming is the drift
 * R7-17-SEL's build order exists to stop.
 *
 * ── HOW IT WORKS, IN THE ORDER THE COLUMNS RUN ──────────────────────────────
 * THE CLOCK is one rising saw LFO. Its `sync` pulse resets the swing sine and advances
 * the bar counter; its ramp is scaled ×16 into a STEP INDEX. Three copies of that sum
 * exist with different amounts of the swing sine added, so the bass drum, hi-hat and
 * snare read the same pattern at very slightly different times — the swing is
 * per-instrument, which is the trick that makes the groove.
 *
 * EACH DRUM reads its index twice: once into a Step Levels bank (four levels per step,
 * eight selectable patterns) and once into an edge detector. The bank's level ANDed with
 * that edge is the strike; the same level also picks one of four decay values, latched at
 * the strike — so a louder step is also a longer one. That is the accent lane, and it is
 * why the pattern sounds played rather than typed.
 *
 * THE BASS is two sine oscillators, one phase-modulating the other through a VCA driven
 * by its own ADSR — a 2-op FM voice. Its note is a four-value scale lookup plus a
 * FOUR-BAR transposition read from a counter, and the sum passes through a glide whose
 * ENABLE is a per-step lane, so some steps slide and some do not.
 *
 * THE SNARE goes through a 4-line feedback delay network and then a resonant vcf3 whose
 * cutoff is swept by its own slow LFO; the dry snare is summed back in ungained. THE
 * BURST LANE fires a linear-feedback-shift-register burst — 255 samples of pseudo-random
 * noise — through a resonant highpass, selected by a 32-step gate bank.
 */
export const AXO_DRUM_MACHINE = {
  id: "axo-drseq",
  title: "Axoloti Drum Machine (drseq)",
  help: "The largest patch in the Axoloti factory library: an 8-pattern drum machine (bass drum, hi-hat, snare through a 4-line FDN reverb), a 2-op FM bass with a four-bar transposition table and per-step glide, an acid saw lane and an LFSR noise-burst lane — all clocked from ONE saw LFO whose ramp is three separately-swung step indices. Every drum's decay is latched per step from a four-level accent lane. Turn any Step Levels node's Row knob to switch that instrument's whole pattern.",
  source: {
    patch: "axoloti-factory demos/sequencing/drseq.axp",
    file: "patches/demos/sequencing/drseq.axp @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    author: "Johannes Taelman / Axoloti factory library",
    popularity: "the factory library's flagship sequencing demo — shipped with every Axoloti 1.0.12 install",
    distinct: 53,
    families: ["generative sequencing", "FDN reverb", "table lookup", "FM / phase modulation", "wavetable"],
  },
  deviations: [
    // ── WHAT THE SURVEY GOT WRONG, MEASURED AGAINST THE PATCH FILE ──────────
    "SURVEY CORRECTION — the patch has 53 distinct object types, not 54. `.frenzy/round7/survey_axoloti.md` § 0.2 tallies 54; the dumper's own footer for the same file says `DISTINCT OBJECT TYPES: 53  TOTAL: 111`. 111 is right.",
    "SURVEY CORRECTION — `pulse/lfsrburst 8`'s polynomial is NOT a usable 0x9. The patch file really does store `<combo attributeName=\"polynomial\" selection=\"0x9\"/>`, but the object at the commit we read offers sixteen taps, 0x8E…0xFA, and 0x9 is not among them — the patch predates that combo. This build uses 142 (0x8E), the first legal entry and our node's default. The harvested string is recorded here so nobody re-derives it as a port bug.",
    "SURVEY CORRECTION — the three swing mixers are not three different swings. `mix.mix3_1` (bass drum) and `mix.mix3_2` (hi-hat) carry IDENTICAL gains (16.0 / 0.1 / 0.0); only the snare's differs (16.0 / 0.05 / 0.0). All three are built, because that is what the patch says.",
    "SURVEY CORRECTION — `vcf3~_1` on the snare tail has a BASE pitch of 40.0 that the survey omits; the LFO × 13.5 is added to it, not the whole story. Built as knob 40.0 + the wire.",
    // ── THE THREE DEAD OR MUTED BRANCHES IN THE SOURCE ──────────────────────
    "THE PINK-NOISE LANE IS DEAD IN THE ORIGINAL and is COMPLETED here. Two separate breaks: `filter/hp1`'s output is wired to nothing at all, and `gain/vca~_2`'s level inlet is unwired (so the lane is silent even before its output goes nowhere). PowerRP refuses both — an orphan node and a node that reaches no output are two of the laws in tests/audio_patches_test.js, correctly, since either is a card that cannot be heard. So: a Knob widget supplies the missing VCA level (0.35, the one fabricated value in this patch, and a knob is the honest place for one), and the lane ends in its OWN `audio_output` rather than being forced into the six-input drum sum — ADDENDUM 10's ruling, verbatim: 'If we have multiple audio outputs by the way, we'll just add them all together.' Everything else in the lane is the source's: pink random → interp ramp → VCA → vcf3 (cutoff latched from a 32-step lane through a four-value table) → +11.5 bias → soft clip → 43.0 highpass.",
    "TWO GAINS OF ZERO ARE FAITHFUL, NOT BUGS. The final mixer's `gain6` is 0.0, so the ACID LANE is built, wired and MUTED exactly as the author left it — turn it up in the Inspector to hear it. `mix.mix1_1`'s `gain1` is 0.0 likewise, so the burst lane's level LFO contributes nothing and the level is the constant alone. Both are the harvested values.",
    "AN UNWIRED SECOND `lfo/saw r` (pitch 0.0) sits in the original connected to nothing. Dropped — an orphan node is refused, and it made no sound there either.",
    // ── SUBSTITUTIONS ONTO NODES WE ALREADY SHIP ────────────────────────────
    "`conv/to i` ×3 dropped, and its ×64 folded into the swing mixers. AX-1 absorbed `to i` as a type coercion, which is true of the type and NOT of the arithmetic: frac32→int32 is `>>21`, i.e. ×64, and that is what turns a 0…1 ramp into a 0…16 step index. Folding it into the mixer that feeds the index is exact rather than approximate, because the mixer's own gains are dial/64 and the two factors cancel — so the harvested dials 16.0 / 0.1 / 0.0 are what these three mixers carry, while every AUDIO mixer below carries dial/64. Same cancellation, different direction; both are stated in this file's header.",
    "`sel/sel b 32 8t` (32 steps × 8 tracks) is NOT shipped — AX-1's `audio_ax_steps_bool` is the 16-step 4-track member and its own deviation list says so. Built as TWO of them carrying the LOW 16 BITS of p1…p4 and p5…p8: 8208 / 256 / 449 / 0 and 2133 / 1 / 0 / 0. Nothing audible is lost, because the step index is 16·saw + 0.1·sine and never leaves 0…16, so the upper 16 steps are unreachable in this patch. The full 32-bit words are p1=8208, p2=−2011168512, p3=536871361, p4=0, p5=1574997, p6=1, p7=0, p8=0.",
    "`sel/sel i 32` → `audio_ax_steps_value` (16 wide) for the same reason and with the same argument: the harvested lane is i0…i31 = 0,0,0,0,0,0,1,1,1,0,…,i21=2, i27=3, i31=10, and steps 16…31 are unreachable at this index range. Our node returns its `def` inlet (unwired, so 0) outside 0…15, which is exactly what i16 held.",
    "`table/allocate 32b 16sliders` + `table/read` → ONE `audio_ax_steps_value`. Their pair is joined by an object NAME (`read`'s `table` attribute), not by a wire, and the semantics of the pair — `out = values[index]` over sixteen slider values — is precisely what that node already is. The four-bar transposition 0 / −2 / 3 / −5 is carried unchanged, in semitones (see unit rule 2).",
    "`sel/sel dial 4` ×5 → `audio_ax_steps_value`, which AX-1 names as one of the objects it absorbs. TWO OF THE FIVE NEEDED A UNIT CHOICE and it went the other way from the pitch lanes, so it is written down: the three ACCENT tables feed a placeholder envelope's `d` modulation inlet, whose knob holds a RAW DIAL, but `audio_ax_steps_value`'s range is ±16 and a dial of 44.5 does not fit — so those twelve values are stated as dial/64. The raw dials are: bass drum 3.5 / 8.0 / 34.5 / 44.5, hi-hat 0 / 49.5 / 28.5 / 9.0, snare 0 / 30.5 / 7.0 / 0. When AX-4's envelope lands and names its own time units, re-derive from those four numbers, not from the /64 ones. The two PITCH tables (bass note 0/12/7/5, pink cutoff 6/12/7/8) needed no conversion at all — unit rule 2.",
    "`gain/vca` ×6 → `audio_vca`, which NODE_REGISTRY.md marks `variant(ours)`. Their object interpolates the k-rate level across the block; ours is an AudioParam. Each one sits at `gain: 0` per unit rule 4.",
    "`math/c 32` → a `node_knob` at 0.5. Their object is a constant int32 32, read down the wire as 32/64 = 0.5, and `audio_ax_math` has no constant operation. A Knob is a real widget with an Inspector row and a canvas affordance, and it makes the burst lane's level the one thing in this patch you can grab.",
    "`ctrl/i radio 8 v` ×7, `ctrl/i` ×2, `ctrl/dial b` ×2 and `disp/ibar 16` dropped as CHROME — NODE_REGISTRY.md's own ruling for the `ui/control` and `ui/scope` rows ('knob band (audio_nodes.js)', 'audio_meter + audio_spectrum'). Their values are not lost, they MOVED onto the knob they drove: the seven radios are the seven Step Levels `Row` knobs (5, 6, 5, 0, 0, 0, 2), the two `ctrl/i` are the two Mux `Select` knobs (3, 0), and the two dials are the clock LFO's pitch (−47.0) and the swing LFO's phase (21.0 dial → 0.328125 cycles).",
    "`audio/out stereo` → the mono analysis tail. Both its channels are fed by the SAME node in the original, so nothing is lost but the port count. `audio_ax_stereo_out` is shipped and faithful, but it has no outputs, so a patch ending in it could not reach the `audio_output` every blueprint must — see core/audio_patches.js.",
    // ── THE ONE ADDED-NODE CLASS ────────────────────────────────────────────
    "AUTOPLAY (§ R7-AUDIBLE) — AND A10 NEEDS NONE, WHICH IS THE FIRST WAY AND THE ONE THE RULING PREFERS. It was −inf dBFS on 2026-08-07 and this file was briefed to give it a self-driving source; hours later AX-4's envelopes, `mix/mix N`, the two DP clippers and the crossfader landed and the harvested machine came alive on its own at −27.0 dBFS, peak −20.7, with a visible rhythmic envelope (an eight-slice RMS of −25 / −24 / −28 / −57 / silence / −34 / −24 / −24 — the machine's own bar-length rest). It has its own clock, its own 8-pattern step tables and its own `pulse/lfsrburst`; the silence was never a missing trigger, it was an unfinished port, exactly as the brief suspected. NOTHING WAS ADDED. Two placeholders remain — see the next entry.",
    "⚠ `audio_ax_env_d` IS A PLACEHOLDER THAT WILL NEVER BE SUPERSEDED, AND IT IS A NAME COLLISION RATHER THAN MISSING WORK. AX-4 shipped `env/d` as `audio_ax_env_decay` (the name `core/audio_stubs_axo_poly.js` guessed); this file guessed `audio_ax_env_d`. Both stand for the same object with BYTE-IDENTICAL ports, so `STUB_SUPERSEDED` — which matches on the type string — retires one and not the other. The consequence is audible: `bdsweep`, `hhamp` and `snamp` are dead, so the kick has no pitch sweep and the hat and snare have no amplitude envelope. THE SWAP IS NOT SAFE TO MAKE FROM HERE, because the shipped node's `d` is in SECONDS and these three hold raw Axoloti dials (−20, 1.5, 16). THE SWEEP THE ENTRY BELOW RECORDS IS DONE AND THESE THREE ARE STILL NOT PART OF IT, which is the thing to understand before touching them: their dials are untouched BECAUSE the type they point at is a placeholder that declares no module, so nothing reads them and converting them would be converting a value into a node that does not exist. They convert when the type does — `axTimeDialSeconds` of −20, 1.5 and 16, in the same edit that repoints the type. Reported to the lead rather than half-done.",
    "THE HARVESTED DIALS ON THE ENVELOPES AND CLIPPERS ARE NOW CONVERTED — done 2026-08-07, across six of the eight Axoloti patches: 60 values on `env/adsr` (a/d/r through `axTimeDialSeconds`, s through dial/64), `env/ahd m` (`axDecayDialSeconds`), `env/d`, `env/d lin m` and the two DP clippers (dial/64). `core/audio_specs_ax4.js`'s header named this work and deferred it; this is it. TWO OF THEM THE RANGE LAW COULD NOT HAVE FOUND, because a raw dial small enough lands inside the seconds knob and reads as legal: `geigerenv.d` at dial 3 and `pmenv.d` at dial 2 were three and two SECONDS where the object means 0.115 s and 0.109 s. AND ONE CLASS IS DELIBERATELY LEFT: `idxbd`/`idxhh`/`idxsn` carry `gain1: 16`, which is not a gain but the ×16 that turns the clock's 0…1 saw into a 16-step index — dividing it by 64 is § R7-AXO-TRAPS trap 2 and would leave the sequencer on step 0. That one needs an `audio_ax_math` node, not a converted knob. Called out here rather than swept in silently, and rather than guessed at.",
    "CORRECTION TO THE LINE ABOVE, MEASURED 2026-08-13 (workstream DX): LEAVING `gain1: 16` DOES NOT PRESERVE THE ×16 — IT IS SILENTLY CLAMPED TO ×1 AND ALWAYS HAS BEEN. `synth/worklets/processors_ax4.js:79` declares every mixer gain with `amount()`, i.e. `{minValue: 0, maxValue: 1}`, and an AudioParam clamps to its own bounds inside the Web Audio implementation — nothing throws, nothing warns. So the three step indices run ×1 and the drum sequencer walks a SIXTEENTH of its pattern, not the pattern. The previous note's reasoning was sound about the KNOB (a 0…1 dial cannot express 16, and dividing by 64 really would be trap 2) but wrong about the CONSEQUENCE: it treated the raw value as preserved-until-converted, when the engine had already discarded it. This is the exact shape the deviations list exists to prevent, and it survived because a value the ENGINE clamps looks identical in the document to a value it honours. THE VALUE IS LEFT AS 16 rather than written down to 1: 1 is not the author's intent either, and it would erase the evidence of what this node is owed. The fix remains an `audio_ax_math` ×16 node between clock and sequencer; until it lands, this patch's drum pattern is KNOWN WRONG, which is better stated than implied. `tests/patch_integrity_test.js` carries these three as its only declared range exceptions so the gate stays green while the defect stays visible.",
    "NINE `audio_trigger` NODES ARE INSERTED, and they are the price of an honest type system. An Axoloti `bool32` outlet is a level our AX-1 nodes type `audio`; an Axoloti `bool32.rising` inlet is an EDGE we type `trigger`; and core/nodeflow.COERCIONS has no audio→trigger entry, deliberately, because turning a level into an edge is a real operation with a real parameter. So every junction where a logic gate, a mux or a decoder meets a counter, latch, envelope or burst generator goes through the Schmitt edge detector — which is exactly what core/audio_patches.js's SEQUENCED_DINGS records learning. Cost: their pulse is one control tick (1/3000 s) and ours is 1 ms, and ours has hysteresis (0.1/0.5) their bare `> 0` does not.",
  ],
  nodes: [
    // ── THE CLOCK AND THE THREE SWUNG STEP INDICES ────────────────────────
    { id: "clk", type: "audio_ax_lfo", col: 0, row: 0, knobs: { waveform: "saw", pitch: -47 } },
    { id: "clkedge", type: "audio_trigger", col: 1, row: 0, knobs: { pulseMs: 1 } },
    { id: "swing", type: "audio_ax_lfo", col: 2, row: 0, knobs: { waveform: "sine", pitch: 36, phase: 0.328125 } },
    { id: "swinginv", type: "audio_ax_math", col: 3, row: 0, knobs: { operation: "negate" } },
    { id: "idxbd", type: "audio_ax_mix", col: 4, row: 0, knobs: { gain1: 16, gain2: 0.1, gain3: 0 } },
    { id: "idxhh", type: "audio_ax_mix", col: 4, row: 1, knobs: { gain1: 16, gain2: 0.1, gain3: 0 } },
    { id: "idxsn", type: "audio_ax_mix", col: 4, row: 2, knobs: { gain1: 16, gain2: 0.05, gain3: 0 } },
    // ── BASS DRUM: rectified noise × a swept sine, both from one strike ────
    { id: "bd", type: "audio_ax_steps_multi", col: 5, row: 3, knobs: { row: 5, t0: 1073954819, t1: 1074987523, t2: 2105347, t3: 270540803, t4: 268435459, t5: 2166129715, t6: 1346439187, t7: 271351811 } },
    { id: "bdchange", type: "audio_ax_logic", col: 5, row: 4, knobs: { operation: "change" } },
    { id: "bdgate", type: "audio_ax_logic", col: 6, row: 3, knobs: { operation: "and", b: 0 } },
    { id: "bdtrig", type: "audio_trigger", col: 7, row: 3, knobs: { pulseMs: 1 } },
    { id: "bdaccent", type: "audio_ax_steps_value", col: 6, row: 4, knobs: { v0: 0.054688, v1: 0.125, v2: 0.539062, v3: 0.695312 } },
    { id: "bdhold", type: "audio_ax_latch", col: 8, row: 3 },
    { id: "bdsweep", type: "audio_ax_env_d", col: 8, row: 4, knobs: { d: -20 } },
    { id: "bdsweepamt", type: "audio_ax_math", col: 9, row: 3, knobs: { operation: "attenuate", b: 0.382812 } },
    { id: "bdtone", type: "audio_ax_osc", col: 10, row: 3, knobs: { waveform: "sine", pitch: -30 } },
    { id: "bdnoise", type: "audio_ax_noise", col: 0, row: 3, knobs: { colour: "uniform" } },
    { id: "bdrect", type: "audio_ax_math", col: 1, row: 3, knobs: { operation: "absolute" } },
    { id: "bdlp", type: "audio_ax_onepole", col: 2, row: 3, knobs: { mode: "lowpass", pitch: -29 } },
    { id: "bdring", type: "audio_ax_math", col: 11, row: 3, knobs: { operation: "multiply", b: 0 } },
    // `env/d lin m`'s WHOLE RAMP in seconds, dial −16 through `axTimeDialSeconds` — AX-4's
    // D2, and on this object the conversion is exact rather than nominal (its own D2 says
    // the ramp really does reach zero in `LinearTimeExp(dial)` seconds). As a raw dial the
    // kick's amplitude ramp asked for −16 s and was clamped to the knob's 2.4 ms floor.
    { id: "bdamp", type: "audio_ax_env_d_lin_m", col: 9, row: 4, knobs: { d: 0.038526 } },
    { id: "bdout", type: "audio_ax_math", col: 12, row: 3, knobs: { operation: "multiply", b: 0 } },
    // ── HI-HAT: noise through a decay VCA into a resonant bandpass ─────────
    { id: "hh", type: "audio_ax_steps_multi", col: 5, row: 5, knobs: { row: 6, t0: 16777728, t1: 318767360, t2: 16777232, t3: 303174162, t4: 1464996118, t5: 51380752, t6: 541134865, t7: 1986487911 } },
    { id: "hhchange", type: "audio_ax_logic", col: 5, row: 6, knobs: { operation: "change" } },
    { id: "hhgate", type: "audio_ax_logic", col: 6, row: 5, knobs: { operation: "and", b: 0 } },
    { id: "hhtrig", type: "audio_trigger", col: 7, row: 5, knobs: { pulseMs: 1 } },
    { id: "hhaccent", type: "audio_ax_steps_value", col: 6, row: 6, knobs: { v0: 0, v1: 0.773438, v2: 0.445312, v3: 0.140625 } },
    { id: "hhhold", type: "audio_ax_latch", col: 8, row: 5 },
    { id: "hhamp", type: "audio_ax_env_d", col: 9, row: 5, knobs: { d: 1.5 } },
    { id: "hhnoise", type: "audio_ax_noise", col: 0, row: 5, knobs: { colour: "uniform" } },
    { id: "hhvca", type: "audio_vca", col: 10, row: 5, knobs: { gain: 0 } },
    { id: "hhbp", type: "audio_ax_svf", col: 11, row: 5, knobs: { pitch: 58, reso: 23.5 } },
    // ── SNARE: the same voice, then the FDN and its swept resonant tail ────
    { id: "sn", type: "audio_ax_steps_multi", col: 5, row: 7, knobs: { row: 5, t0: 16777984, t1: 50332032, t2: 319832592, t3: 403702016, t4: 0, t5: 33816576, t6: 33554944, t7: 50594064 } },
    { id: "snchange", type: "audio_ax_logic", col: 5, row: 8, knobs: { operation: "change" } },
    { id: "sngate", type: "audio_ax_logic", col: 6, row: 7, knobs: { operation: "and", b: 0 } },
    { id: "sntrig", type: "audio_trigger", col: 7, row: 7, knobs: { pulseMs: 1 } },
    { id: "snaccent", type: "audio_ax_steps_value", col: 6, row: 8, knobs: { v0: 0, v1: 0.476562, v2: 0.109375, v3: 0 } },
    { id: "snhold", type: "audio_ax_latch", col: 8, row: 7 },
    { id: "snamp", type: "audio_ax_env_d", col: 9, row: 7, knobs: { d: 16 } },
    { id: "snnoise", type: "audio_ax_noise", col: 0, row: 7, knobs: { colour: "uniform" } },
    { id: "snvca", type: "audio_vca", col: 10, row: 7, knobs: { gain: 0 } },
    { id: "snbp", type: "audio_ax_svf", col: 11, row: 7, knobs: { pitch: 22, reso: 11 } },
    { id: "snfdn", type: "audio_ax_fdn4", col: 12, row: 7, knobs: { g: 0 } },
    { id: "sntaillfo", type: "audio_ax_lfo", col: 0, row: 8, knobs: { waveform: "sine", pitch: -61 } },
    { id: "sntailamt", type: "audio_ax_math", col: 1, row: 7, knobs: { operation: "attenuate", b: 0.210938 } },
    { id: "sntailvcf", type: "audio_ax_vcf3", col: 13, row: 7, knobs: { pitch: 40, reso: 58 } },
    { id: "snmix", type: "audio_ax_mix", col: 14, row: 7, knobs: { gain1: 0.078125 } },
    // ── FM BASS: a four-bar transposition, per-step glide, 2-op phase mod ──
    { id: "bar", type: "audio_ax_counter", col: 2, row: 9, knobs: { maximum: 4 } },
    { id: "bartable", type: "audio_ax_steps_value", col: 3, row: 9, knobs: { v0: 0, v1: -2, v2: 3, v3: -5 } },
    { id: "bass", type: "audio_ax_steps_multi", col: 5, row: 9, knobs: { row: 0, t0: 1713904394, t1: 27962027, t2: 810898688, t3: 869209431, t4: 0, t5: 0, t6: 0, t7: 0 } },
    { id: "basschange", type: "audio_ax_logic", col: 6, row: 9, knobs: { operation: "change" } },
    // THE RE-GATE, and it is the cleverest object in the patch. Their `mux 2` is
    // `o = s ? i2 : i1` with i2 left unwired, so the step level passes EXCEPT on the
    // one tick the index changed, when the output drops to zero — which forces the
    // ADSR's gate low and makes it retrigger on a held note. Our Mux is 0-based, so
    // their i1 is our `i0` and their i2 is our (unwired) `i1`.
    { id: "bassregate", type: "audio_ax_mux", col: 7, row: 9, knobs: { select: 0 } },
    { id: "bassdecode", type: "audio_ax_decode", col: 8, row: 9 },
    { id: "bassgate", type: "audio_trigger", col: 8, row: 10, knobs: { pulseMs: 1 } },
    // IN SECONDS. dials −59 / 24 / 0 / −30 through `axTimeDialSeconds` (a/d/r) and dial/64
    // (sustain) — AX-4's D2. The sustain's dial 0 is 0 either way, so it is unchanged.
    { id: "bassenv", type: "audio_ax_env_adsr", col: 9, row: 9, knobs: { a: 0.003214, d: 0.388317, s: 0, r: 0.017161 } },
    { id: "pmgate", type: "audio_trigger", col: 9, row: 10, knobs: { pulseMs: 1 } },
    // dials −36 / 2 / 0 / 7. ⚠ `d`'s DIAL OF 2 IS ONE THE RANGE LAW CANNOT SEE — two seconds
    // is inside the knob — so it is converted with its neighbours rather than left as the
    // only raw dial in the node: 0.109 s of FM index decay, not two seconds of it.
    { id: "pmenv", type: "audio_ax_env_adsr", col: 10, row: 9, knobs: { a: 0.012135, d: 0.108968, s: 0, r: 0.145455 } },
    { id: "pmamt", type: "audio_ax_math", col: 11, row: 9, knobs: { operation: "attenuate", b: 0.65625 } },
    { id: "bassnote", type: "audio_ax_steps_multi", col: 5, row: 10, knobs: { row: 0, t0: 84153600, t1: 50899456, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0 } },
    { id: "bassscale", type: "audio_ax_steps_value", col: 6, row: 10, knobs: { v0: 0, v1: 12, v2: 7, v3: 5 } },
    { id: "basspitch", type: "audio_ax_math", col: 7, row: 10, knobs: { operation: "add", b: 0 } },
    { id: "bassglide", type: "audio_ax_steps_multi", col: 5, row: 11, knobs: { row: 0, t0: 16777472, t1: 340087893, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0 } },
    { id: "bassslide", type: "audio_ax_smooth", col: 8, row: 11, knobs: { time: 32, enable: 0 } },
    { id: "pmosc", type: "audio_ax_osc", col: 9, row: 11, knobs: { waveform: "sine", pitch: -8.13 } },
    { id: "pmvca", type: "audio_vca", col: 12, row: 9, knobs: { gain: 0 } },
    { id: "bassosc", type: "audio_ax_osc", col: 13, row: 9, knobs: { waveform: "sine", pitch: -24 } },
    { id: "bassvca", type: "audio_vca", col: 14, row: 9, knobs: { gain: 0 } },
    { id: "bassmuls", type: "audio_ax_math", col: 15, row: 9, knobs: { operation: "satMultiply4" } },
    { id: "basssoft", type: "audio_ax_dist_soft", col: 16, row: 9 },
    // ── ACID LANE: built and wired, MUTED at the mixer, exactly as authored ─
    { id: "acidsteps", type: "audio_ax_steps_multi", col: 5, row: 12, knobs: { row: 2, t0: 285234497, t1: 286544197, t2: 84215045, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0 } },
    { id: "acidchange", type: "audio_ax_logic", col: 6, row: 12, knobs: { operation: "change" } },
    { id: "acidregate", type: "audio_ax_mux", col: 7, row: 12, knobs: { select: 0 } },
    { id: "acidgate", type: "audio_trigger", col: 8, row: 12, knobs: { pulseMs: 1 } },
    // dials −48 / −32 / 31 / −14
    { id: "acidenv", type: "audio_ax_env_adsr", col: 9, row: 12, knobs: { a: 0.006067, d: 0.015289, s: 0.484375, r: 0.043244 } },
    { id: "acidamt", type: "audio_ax_math", col: 10, row: 12, knobs: { operation: "attenuate", b: 0.21875 } },
    { id: "acidosc", type: "audio_ax_osc", col: 0, row: 12, knobs: { waveform: "saw", pitch: -24 } },
    { id: "acidvcf", type: "audio_ax_vcf3", col: 11, row: 12, knobs: { pitch: 10, reso: 37 } },
    { id: "acidbias", type: "audio_ax_math", col: 12, row: 12, knobs: { operation: "add", b: 0.507812 } },
    { id: "acidinf", type: "audio_ax_dist_inf", col: 13, row: 12 },
    // ── LFSR BURST LANE, off a 32-step gate bank split across two nodes ────
    { id: "bursta", type: "audio_ax_steps_bool", col: 5, row: 13, knobs: { p1: 8208, p2: 256, p3: 449, p4: 0, pulse: 0 } },
    { id: "burstb", type: "audio_ax_steps_bool", col: 5, row: 14, knobs: { p1: 2133, p2: 1, p3: 0, p4: 0, pulse: 0 } },
    { id: "pinkpick", type: "audio_ax_mux", col: 6, row: 15, knobs: { select: 3 } },
    { id: "burstpick", type: "audio_ax_mux", col: 6, row: 13, knobs: { select: 0 } },
    { id: "bursttrig", type: "audio_trigger", col: 7, row: 13, knobs: { pulseMs: 1 } },
    { id: "burst", type: "audio_ax_lfsr_burst", col: 8, row: 13, knobs: { polynomial: 142 } },
    { id: "bursthp", type: "audio_ax_svf", col: 9, row: 13, knobs: { pitch: -5, reso: 50 } },
    { id: "burstlfo", type: "audio_ax_lfo", col: 0, row: 13, knobs: { waveform: "sine", pitch: 2 } },
    { id: "burstlevelknob", type: "node_knob", col: 0, row: 14, knobs: { value: 0.5, min: 0, max: 1, step: 0.01 } },
    { id: "burstlevel", type: "audio_ax_mix", col: 1, row: 13, knobs: { gain1: 0 } },
    { id: "burstvca", type: "audio_vca", col: 10, row: 13, knobs: { gain: 0 } },
    // ── PINK-NOISE LANE — dangling in the source, completed here ───────────
    { id: "pinkrand", type: "audio_ax_rand_pink", col: 0, row: 15, knobs: { octaves: 7 } },
    { id: "pinkramp", type: "audio_ax_convert", col: 1, row: 15, knobs: { mode: "smoothStep" } },
    { id: "pinkscale", type: "audio_ax_steps_value", col: 5, row: 15, knobs: { v6: 1, v7: 1, v8: 1 } },
    { id: "pinkcutoff", type: "audio_ax_steps_value", col: 6, row: 16, knobs: { v0: 6, v1: 12, v2: 7, v3: 8 } },
    { id: "pinktrig", type: "audio_trigger", col: 7, row: 15, knobs: { pulseMs: 1 } },
    { id: "pinkhold", type: "audio_ax_latch", col: 8, row: 15 },
    { id: "pinklevelknob", type: "node_knob", col: 0, row: 16, knobs: { value: 0.35, min: 0, max: 1, step: 0.01 } },
    { id: "pinkvca", type: "audio_vca", col: 2, row: 15, knobs: { gain: 0 } },
    { id: "pinkvcf", type: "audio_ax_vcf3", col: 9, row: 15, knobs: { pitch: 0, reso: 63.5 } },
    { id: "pinkbias", type: "audio_ax_math", col: 10, row: 15, knobs: { operation: "add", b: 0.179688 } },
    { id: "pinksoft", type: "audio_ax_dist_soft", col: 11, row: 15 },
    { id: "pinkhp", type: "audio_ax_onepole", col: 12, row: 15, knobs: { mode: "highpass", pitch: 43 } },
    { id: "pinkout", type: "audio_output", col: 13, row: 15, knobs: { volume: 0.5 } },
    // ── THE SUM AND THE ANALYSIS TAIL ─────────────────────────────────────
    { id: "drums", type: "audio_ax_mix", col: 17, row: 17, knobs: { gain1: 0.445312, gain2: 0.242188, gain3: 0.265625, gain4: 0.1875, gain5: 0.976562, gain6: 0 } },
    { id: "master", type: "audio_ax_math", col: 18, row: 17, knobs: { operation: "attenuate", b: 0.40625 } },
    { id: "meter", type: "audio_meter", col: 19, row: 17 },
    { id: "spectrum", type: "audio_spectrum", col: 20, row: 17 },
    { id: "out", type: "audio_output", col: 21, row: 17, knobs: { volume: 0.7 } },
  ],
  wires: [
    { from: "clk", fromPort: "sync", to: "clkedge", toPort: "in" },
    { from: "clkedge", fromPort: "out", to: "swing", toPort: "reset" },
    { from: "clkedge", fromPort: "out", to: "bar", toPort: "trig" },
    { from: "clk", fromPort: "out", to: "idxbd", toPort: "in1" },
    { from: "clk", fromPort: "out", to: "idxhh", toPort: "in1" },
    { from: "clk", fromPort: "out", to: "idxsn", toPort: "in1" },
    { from: "swing", fromPort: "out", to: "idxbd", toPort: "in2" },
    { from: "swing", fromPort: "out", to: "idxhh", toPort: "in2" },
    { from: "swing", fromPort: "out", to: "idxsn", toPort: "in2" },
    { from: "swing", fromPort: "out", to: "swinginv", toPort: "a" },
    { from: "swinginv", fromPort: "out", to: "idxbd", toPort: "in3" },
    { from: "swinginv", fromPort: "out", to: "idxhh", toPort: "in3" },
    { from: "swinginv", fromPort: "out", to: "idxsn", toPort: "in3" },
    { from: "idxbd", fromPort: "out", to: "bd", toPort: "index" },
    { from: "idxbd", fromPort: "out", to: "bdchange", toPort: "a" },
    { from: "bd", fromPort: "out", to: "bdgate", toPort: "a" },
    { from: "bdchange", fromPort: "out", to: "bdgate", toPort: "b" },
    { from: "bdgate", fromPort: "out", to: "bdtrig", toPort: "in" },
    { from: "bd", fromPort: "out", to: "bdaccent", toPort: "index" },
    { from: "bdaccent", fromPort: "out", to: "bdhold", toPort: "in" },
    { from: "bdtrig", fromPort: "out", to: "bdhold", toPort: "trig" },
    { from: "bdtrig", fromPort: "out", to: "bdsweep", toPort: "trig" },
    { from: "bdsweep", fromPort: "env", to: "bdsweepamt", toPort: "a" },
    { from: "bdsweepamt", fromPort: "out", to: "bdtone", toPort: "pitch" },
    { from: "bdnoise", fromPort: "out", to: "bdrect", toPort: "a" },
    { from: "bdrect", fromPort: "out", to: "bdlp", toPort: "in" },
    { from: "bdlp", fromPort: "out", to: "bdring", toPort: "a" },
    { from: "bdtone", fromPort: "out", to: "bdring", toPort: "b" },
    { from: "bdtrig", fromPort: "out", to: "bdamp", toPort: "trig" },
    { from: "bdhold", fromPort: "out", to: "bdamp", toPort: "d" },
    { from: "bdring", fromPort: "out", to: "bdout", toPort: "a" },
    { from: "bdamp", fromPort: "env", to: "bdout", toPort: "b" },
    { from: "bdout", fromPort: "out", to: "drums", toPort: "in1" },
    { from: "idxhh", fromPort: "out", to: "hh", toPort: "index" },
    { from: "idxhh", fromPort: "out", to: "hhchange", toPort: "a" },
    { from: "hh", fromPort: "out", to: "hhgate", toPort: "a" },
    { from: "hhchange", fromPort: "out", to: "hhgate", toPort: "b" },
    { from: "hhgate", fromPort: "out", to: "hhtrig", toPort: "in" },
    { from: "hh", fromPort: "out", to: "hhaccent", toPort: "index" },
    { from: "hhaccent", fromPort: "out", to: "hhhold", toPort: "in" },
    { from: "hhtrig", fromPort: "out", to: "hhhold", toPort: "trig" },
    { from: "hhtrig", fromPort: "out", to: "hhamp", toPort: "trig" },
    { from: "hhhold", fromPort: "out", to: "hhamp", toPort: "d" },
    { from: "hhnoise", fromPort: "out", to: "hhvca", toPort: "in" },
    { from: "hhamp", fromPort: "env", to: "hhvca", toPort: "gain" },
    { from: "hhvca", fromPort: "out", to: "hhbp", toPort: "in" },
    { from: "hhbp", fromPort: "bp", to: "drums", toPort: "in2" },
    { from: "idxsn", fromPort: "out", to: "sn", toPort: "index" },
    { from: "idxsn", fromPort: "out", to: "snchange", toPort: "a" },
    { from: "sn", fromPort: "out", to: "sngate", toPort: "a" },
    { from: "snchange", fromPort: "out", to: "sngate", toPort: "b" },
    { from: "sngate", fromPort: "out", to: "sntrig", toPort: "in" },
    { from: "sn", fromPort: "out", to: "snaccent", toPort: "index" },
    { from: "snaccent", fromPort: "out", to: "snhold", toPort: "in" },
    { from: "sntrig", fromPort: "out", to: "snhold", toPort: "trig" },
    { from: "sntrig", fromPort: "out", to: "snamp", toPort: "trig" },
    { from: "snhold", fromPort: "out", to: "snamp", toPort: "d" },
    { from: "snnoise", fromPort: "out", to: "snvca", toPort: "in" },
    { from: "snamp", fromPort: "env", to: "snvca", toPort: "gain" },
    { from: "snvca", fromPort: "out", to: "snbp", toPort: "in" },
    { from: "snbp", fromPort: "bp", to: "snfdn", toPort: "in1" },
    { from: "snbp", fromPort: "bp", to: "snmix", toPort: "bus_in" },
    { from: "snfdn", fromPort: "out1", to: "sntailvcf", toPort: "in" },
    { from: "sntaillfo", fromPort: "out", to: "sntailamt", toPort: "a" },
    { from: "sntailamt", fromPort: "out", to: "sntailvcf", toPort: "pitch" },
    { from: "sntailvcf", fromPort: "out", to: "snmix", toPort: "in1" },
    { from: "snmix", fromPort: "out", to: "drums", toPort: "in3" },
    { from: "bar", fromPort: "count", to: "bartable", toPort: "index" },
    { from: "idxbd", fromPort: "out", to: "bass", toPort: "index" },
    { from: "bass", fromPort: "out", to: "basschange", toPort: "a" },
    { from: "bass", fromPort: "out", to: "bassregate", toPort: "i0" },
    { from: "basschange", fromPort: "out", to: "bassregate", toPort: "select" },
    { from: "bassregate", fromPort: "out", to: "bassdecode", toPort: "in" },
    { from: "bassregate", fromPort: "out", to: "bassgate", toPort: "in" },
    { from: "bassgate", fromPort: "out", to: "bassenv", toPort: "gate" },
    { from: "bassdecode", fromPort: "o3", to: "pmgate", toPort: "in" },
    { from: "pmgate", fromPort: "out", to: "pmenv", toPort: "gate" },
    { from: "pmenv", fromPort: "env", to: "pmamt", toPort: "a" },
    { from: "idxbd", fromPort: "out", to: "bassnote", toPort: "index" },
    { from: "bassnote", fromPort: "out", to: "bassscale", toPort: "index" },
    { from: "bassscale", fromPort: "out", to: "basspitch", toPort: "a" },
    { from: "bartable", fromPort: "out", to: "basspitch", toPort: "b" },
    { from: "basspitch", fromPort: "out", to: "bassslide", toPort: "in" },
    { from: "idxbd", fromPort: "out", to: "bassglide", toPort: "index" },
    { from: "bassglide", fromPort: "out", to: "bassslide", toPort: "enable" },
    { from: "bassslide", fromPort: "out", to: "pmosc", toPort: "pitch" },
    { from: "bassslide", fromPort: "out", to: "bassosc", toPort: "pitch" },
    { from: "pmosc", fromPort: "out", to: "pmvca", toPort: "in" },
    { from: "pmamt", fromPort: "out", to: "pmvca", toPort: "gain" },
    { from: "pmvca", fromPort: "out", to: "bassosc", toPort: "phase" },
    { from: "bassosc", fromPort: "out", to: "bassvca", toPort: "in" },
    { from: "bassenv", fromPort: "env", to: "bassvca", toPort: "gain" },
    { from: "bassvca", fromPort: "out", to: "bassmuls", toPort: "a" },
    { from: "bassmuls", fromPort: "out", to: "basssoft", toPort: "in" },
    { from: "basssoft", fromPort: "out", to: "drums", toPort: "in4" },
    { from: "idxbd", fromPort: "out", to: "acidsteps", toPort: "index" },
    { from: "acidsteps", fromPort: "out", to: "acidchange", toPort: "a" },
    { from: "acidsteps", fromPort: "out", to: "acidregate", toPort: "i0" },
    { from: "acidchange", fromPort: "out", to: "acidregate", toPort: "select" },
    { from: "acidregate", fromPort: "out", to: "acidgate", toPort: "in" },
    { from: "acidgate", fromPort: "out", to: "acidenv", toPort: "gate" },
    { from: "acidenv", fromPort: "env", to: "acidamt", toPort: "a" },
    { from: "acidamt", fromPort: "out", to: "acidvcf", toPort: "pitch" },
    { from: "acidosc", fromPort: "out", to: "acidvcf", toPort: "in" },
    { from: "acidvcf", fromPort: "out", to: "acidbias", toPort: "a" },
    { from: "acidbias", fromPort: "out", to: "acidinf", toPort: "in" },
    { from: "acidinf", fromPort: "out", to: "drums", toPort: "in6" },
    { from: "idxbd", fromPort: "out", to: "bursta", toPort: "index" },
    { from: "idxbd", fromPort: "out", to: "burstb", toPort: "index" },
    { from: "bursta", fromPort: "o1", to: "pinkpick", toPort: "i0" },
    { from: "bursta", fromPort: "o2", to: "pinkpick", toPort: "i1" },
    { from: "bursta", fromPort: "o3", to: "pinkpick", toPort: "i2" },
    { from: "bursta", fromPort: "o4", to: "pinkpick", toPort: "i3" },
    { from: "burstb", fromPort: "o1", to: "burstpick", toPort: "i0" },
    { from: "burstb", fromPort: "o2", to: "burstpick", toPort: "i1" },
    { from: "burstb", fromPort: "o3", to: "burstpick", toPort: "i2" },
    { from: "burstb", fromPort: "o4", to: "burstpick", toPort: "i3" },
    { from: "burstpick", fromPort: "out", to: "bursttrig", toPort: "in" },
    { from: "bursttrig", fromPort: "out", to: "burst", toPort: "trig" },
    { from: "burst", fromPort: "out", to: "bursthp", toPort: "in" },
    { from: "burstlfo", fromPort: "out", to: "burstlevel", toPort: "in1" },
    { from: "burstlevelknob", fromPort: "out", to: "burstlevel", toPort: "bus_in" },
    { from: "bursthp", fromPort: "hp", to: "burstvca", toPort: "in" },
    { from: "burstlevel", fromPort: "out", to: "burstvca", toPort: "gain" },
    { from: "burstvca", fromPort: "out", to: "drums", toPort: "in5" },
    { from: "pinkrand", fromPort: "out", to: "pinkramp", toPort: "in" },
    { from: "idxbd", fromPort: "out", to: "pinkscale", toPort: "index" },
    { from: "pinkscale", fromPort: "out", to: "pinkcutoff", toPort: "index" },
    { from: "pinkcutoff", fromPort: "out", to: "pinkhold", toPort: "in" },
    { from: "pinkpick", fromPort: "out", to: "pinktrig", toPort: "in" },
    { from: "pinktrig", fromPort: "out", to: "pinkhold", toPort: "trig" },
    { from: "pinkramp", fromPort: "out", to: "pinkvca", toPort: "in" },
    { from: "pinklevelknob", fromPort: "out", to: "pinkvca", toPort: "gain" },
    { from: "pinkvca", fromPort: "out", to: "pinkvcf", toPort: "in" },
    { from: "pinkhold", fromPort: "out", to: "pinkvcf", toPort: "pitch" },
    { from: "pinkvcf", fromPort: "out", to: "pinkbias", toPort: "a" },
    { from: "pinkbias", fromPort: "out", to: "pinksoft", toPort: "in" },
    { from: "pinksoft", fromPort: "out", to: "pinkhp", toPort: "in" },
    { from: "pinkhp", fromPort: "out", to: "pinkout", toPort: "in" },
    { from: "drums", fromPort: "out", to: "master", toPort: "a" },
    { from: "master", fromPort: "out", to: "meter", toPort: "in" },
    { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
    { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
  ],
};

/**
 * C11 — FOUR MUTABLE INSTRUMENTS ENGINES AT ONCE: a Braids BOWED string into Elements'
 * diffuser, Elements' reverb and Rings' chorus in parallel, then twin 341 ms delays.
 *
 * ── WHY THIS PATCH ──────────────────────────────────────────────────────────
 * It is the densest MI demo in the contrib library and the only patch anywhere that uses
 * `fx/lmnts/diffuser` and `fx/lmnts/reverb` as STANDALONE effects rather than buried
 * inside Elements. One voice fans out to five destinations at once; the diffuser's output
 * then feeds the reverb's right channel, the chorus's right channel AND both output
 * mixers, so the stereo field is built out of one mono source by giving each effect a
 * different pair of taps. That structure is the patch, and it is why it earns a slot.
 *
 * ── THE VOICE ───────────────────────────────────────────────────────────────
 * `keyb.note` plus the pitch bend at gain 0.2 sets the Braids pitch; the key's gate2 both
 * opens an attack-hold-decay envelope AND strikes the bow. Velocity does two things: it
 * scales the envelope into the VCA, and it goes through a control-rate lowpass into the
 * bow's COLOUR — so playing harder opens the timbre smoothly rather than in a step.
 *
 * ── THE TWO DELAYS ARE CROSSED, AND THAT IS DELIBERATE ──────────────────────
 * The chorus's LEFT output drives delay A, whose output is summed into the RIGHT mixer,
 * and vice versa. Both delays share the same feedback and mix knobs, so the two channels
 * are the same treatment on swapped material — a wide, non-correlated stereo out of a
 * mono voice. Their time inlets are separately knobbed and smoothed, which is what makes
 * a slow sweep of one side audible against the other.
 */
/** A10 and this patch both need the 5.15 Hz base an `audio_ax_lfo` runs at with its
 *  `pitch` knob at 0 — restated from AX-2's arithmetic, as the other two Axoloti patch
 *  sets restate it. THE FIX FOR ALL THREE COPIES IS ONE LEAF MODULE THE LEAD OWNS; the
 *  PATCH-SET CONTRACT allows one exported name per set file and forbids importing
 *  `core/audio_patches.js`, so a helper two sets want has nowhere shared to live. */
const AX_LFO_BASE_HZ = 5.15;

/**
 * THE AUTOPLAY GATE'S WIDTH — 100 ms, which is `TriggerProcessor`'s own `maxValue`
 * (synth/worklets/processors.js:339) and therefore a ceiling rather than a taste.
 * MEASURED on C7 in the sibling set: an `audio_adsr` handed the 5 ms the ported Schmitts
 * use attacks for 5 ms and then RELEASES — one blip, not a note, and it cost that patch
 * 30 dB. `env/ahd m` here is gated the same way and would have done the same.
 */
const AUTOPLAY_PULSE_MS = 100;

/**
 * Pure function. The `audio_ax_lfo` `pitch` knob that runs at a given rate.
 *
 * @param {number} hz - the wanted rate in hertz
 * @returns {number} semitones, rounded to the dial's own tenth
 *
 * @example lfoPitchForHz(5.15) // 0
 * @example lfoPitchForHz(0.5) // -40.4 — a note every two seconds
 */
function lfoPitchForHz(hz) {
  return Math.round(12 * Math.log2(hz / AX_LFO_BASE_HZ) * 10) / 10;
}

/**
 * C11's autoplay return gain on `mixl`/`mixr`'s free sixth input.
 *
 * IT WAS 0.12, AND THAT NUMBER WAS COMPENSATING FOR A DEFECT RATHER THAN SETTING A LEVEL.
 * Its own note said so: at unity the branch used to reach the tail at −0.5 dBFS peak with
 * a 4 dB crest factor, squared off against the limiter, "because the two `dp_soft_clip`
 * nodes it passes are still driven by dial-unit gains". Those gains are converted now
 * (dial 25/15 → 0.390625/0.234375), so the shaper sees a 1.56× drive instead of a 100×
 * one and the trim underneath it has nothing left to trim.
 *
 * Measured 2026-08-07, whole patch, 6 s offline: with the clippers fixed and this still at
 * 0.12 the patch rendered −24.7 dBFS, twenty-one decibels under where it had been. At 1 it
 * is −6.7 dBFS, no clipping. THE 18.0 dB IT GAINED FROM 18.4 dB OF KNOB IS THE POINT, not
 * the level: a near-linear response is the shaper working in its cubic region, which is
 * what an in-gain under unity is supposed to produce. The old pairing could not have shown
 * that, because at 100× drive the thing was a squarer and gain did almost nothing.
 */
const C11_AUTOPLAY_RETURN_GAIN = 1;

/** C11's four-note figure and the multiplier that turns it into hertz. 8/10/12/15 x 16 is
 *  128 / 160 / 192 / 240 Hz — C3, E3, G3, B3 to within a few cents, and the octave the
 *  harvested Braids voice sits in. The multiplier is 16 because that is `audio_ax_math`'s
 *  `b` ceiling and one node is enough at this pitch; a higher octave would need the
 *  two-node SCALE chain the sibling sets use. */
const C11_AUTOPLAY_STEPS = [8, 10, 12, 15];
const C11_AUTOPLAY_HZ_PER_STEP = 16;

/** C11's autoplay note rate and its first free row. A bowed string with a 341 ms delay
 *  behind it wants space between notes; 0.45 Hz is a note every 2.2 seconds. */
const C11_AUTOPLAY_HZ = 0.45;
const C11_AUTOPLAY_ROW = 18;

/**
 * C11's AUTOPLAY BRANCH — § R7-AUDIBLE's third way, in four nodes.
 *
 * ── WHAT WAS MEASURED, AND WHY THE PATCH WAS DEAD ──────────────────────────
 * −inf dBFS. TWO reasons, and the second is the interesting one. `audio_ax_brds_bowed` is
 * a placeholder, so the patch has no source at all — that much is expected. But its
 * `audio_ax_midi_keyb` had NO WIRE ON ANY OF ITS FOUR INPUTS either: this patch ships no
 * `node_keyboard` (its own deviation explains why — the widget emits hertz and has no
 * velocity output), so nothing could ever have gated `env/ahd m`, and the velocity →
 * colour mapping the patch's `help` calls "the expressive part" had no velocity to read.
 *
 * ── SO THE CLOCK GATES THE KEYBOARD NODE ITSELF ────────────────────────────
 * `audio_ax_midi_keyb` is a real shipped node with a real `gate` inlet, and gating it
 * wakes the whole front of the patch: `note` through `bendmix` to the pitch, `velocity`
 * into `velamp` and `velcolour`, and the gate into the AHD envelope. The substituted
 * oscillator is then pitched and gated entirely by the patch's own machinery.
 *
 * ── ⚠ AND A GATE ALONE IS NOT ENOUGH: THE NODE NEEDS A PITCH IN HERTZ ──────
 * MEASURED, after the first version of this branch shipped a gate and nothing else and
 * the patch stayed at −inf. `axMidiKeyb`'s note-on is guarded by its zone — its own
 * derivation says a note outside [start_note, end_note] "is IGNORED entirely, gate
 * included" — and with the `pitch` inlet unwired it reads 0 Hz, whose semitone value is
 * −Infinity. So EVERY output stayed dead: no gate, no note, and no velocity either.
 * Isolated in `.frenzy/w_r7aud`: the identical graph with the gate wired straight to the
 * envelope sounds at −16.5 dBFS, and routed through the keyboard node it is silent; add a
 * hertz value on `pitch` and the two match to a tenth of a dB.
 *
 * THAT IS A TRAP WORTH NAMING, because it is the mirror image of § R7-AXO-TRAPS trap 1.
 * That trap is about wiring a HERTZ source into a SEMITONE port; this is about the
 * adaptor built to fix it being INERT until something puts hertz in. Nothing warns you —
 * the canvas shows a correctly wired keyboard driving a correctly wired envelope.
 *
 * The three nodes that supply it are a counter, a step table and one multiply: the table
 * holds a four-note figure and the multiply turns it into 128/160/192/240 Hz, which is
 * the octave the harvested `bowed` voice sits in.
 *
 * ── A SAW IS NOT A BOWED STRING, AND IS NOT CLAIMED TO BE ──────────────────
 * Braids' BOWED model is a physical model with a bow-friction nonlinearity; a sawtooth
 * through this patch's own vcf3 pair is a spectral impression of one. It is the closest
 * shipped source, and the substitution is what the deviation records. Everything AFTER
 * the oscillator is the patch's own: `velamp`'s envelope × velocity, both output filters,
 * both soft clippers.
 *
 * ── IT ENTERS AT `in6`, THE MIXER'S SIXTH WEIGHTED INPUT ───────────────────
 * `voicevca` and `voiceamp` are held by the placeholder's wires, and five of `mixl`/
 * `mixr`'s six weighted inputs are taken (three of them by placeholders). `in6` is free on
 * both. IT IS DELIBERATELY NOT `bus_in`: `bus_in` is fixed at unity and this branch needs
 * a level it can set. `gain6` is the honest lever because it is OURS, where the clipper's
 * gains are the port's.
 *
 * THE REASON THIS PARAGRAPH GAVE FOR NEEDING A LEVEL AT ALL IS GONE, and the deletion is
 * worth recording. It used to say the `dp_soft_clip` pair downstream was "driven by
 * dial-unit gains (`ingain: 25`) that the shipped node's 0…1 range does not cover", so
 * unity here peaked at −0.5 dBFS squared off against the limiter, and it deferred the
 * re-derivation to AX-4's dial→unit sweep. That sweep is done (2026-08-07): `ingain` is
 * 0.390625 and the clipper is a soft shaper again rather than a squarer, so unity here
 * measures −6.7 dBFS with headroom and `C11_AUTOPLAY_RETURN_GAIN` is 1.
 *
 * The diffuser, the reverb, the chorus and the two delays are all still placeholders, so
 * what you hear is the dry voice through the filters — not the four-engine Mutable stack.
 */
const AXO_MUTABLE_STACK_AUTOPLAY = {
  nodes: [
    { id: "apLfo", type: "audio_ax_lfo", col: 0, row: C11_AUTOPLAY_ROW, knobs: { waveform: "square", pitch: lfoPitchForHz(C11_AUTOPLAY_HZ) } },
    { id: "apEdge", type: "audio_trigger", col: 0, row: C11_AUTOPLAY_ROW + 1, knobs: { pulseMs: AUTOPLAY_PULSE_MS } },
    // THE FOUR-NOTE FIGURE AND ITS HERTZ SCALER. All at column 0, because every one of
    // them has to reach `keyb`, which is at column 0 — the same forced-column rule the
    // sibling set's clock hits, and equal columns are legal.
    { id: "apCount", type: "audio_ax_counter", col: 0, row: C11_AUTOPLAY_ROW + 2, knobs: { maximum: C11_AUTOPLAY_STEPS.length } },
    { id: "apSteps", type: "audio_ax_steps_value", col: 0, row: C11_AUTOPLAY_ROW + 3, knobs: Object.fromEntries(C11_AUTOPLAY_STEPS.map((v, i) => [`v${i}`, v])) },
    { id: "apHz", type: "audio_ax_math", col: 0, row: C11_AUTOPLAY_ROW + 4, knobs: { operation: "multiply", b: C11_AUTOPLAY_HZ_PER_STEP } },
    { id: "apOsc", type: "audio_ax_osc", col: 2, row: C11_AUTOPLAY_ROW, knobs: { waveform: "saw", pitch: 0 } },
    { id: "apVca", type: "audio_vca", col: 3, row: C11_AUTOPLAY_ROW, knobs: { gain: 0 } },
  ],
  wires: [
    { from: "apLfo", fromPort: "out", to: "apEdge", toPort: "in" },
    { from: "apEdge", fromPort: "out", to: "apCount", toPort: "trig" },
    { from: "apCount", fromPort: "count", to: "apSteps", toPort: "index" },
    { from: "apSteps", fromPort: "out", to: "apHz", toPort: "a" },
    { from: "apHz", fromPort: "out", to: "keyb", toPort: "pitch" },
    { from: "apEdge", fromPort: "out", to: "keyb", toPort: "gate" },
    { from: "bendmix", fromPort: "out", to: "apOsc", toPort: "pitch" },
    { from: "apOsc", fromPort: "out", to: "apVca", toPort: "in" },
    { from: "velamp", fromPort: "out", to: "apVca", toPort: "gain" },
    { from: "apVca", fromPort: "out", to: "mixl", toPort: "in6" },
    { from: "apVca", fromPort: "out", to: "mixr", toPort: "in6" },
  ],
};

export const AXO_MUTABLE_STACK = {
  id: "axo-mi-stack",
  title: "Axoloti Mutable Stack (big MI patch)",
  help: "Four Mutable Instruments engines running at once: a Braids BOWED string voice fanned into Elements' diffuser, Elements' reverb and Rings' chorus in parallel, then through twin 341 ms delays that are CROSSED left-for-right before the output filters and soft clippers. Seven Knob widgets stand in for the hardware panel: two delay times, a shared time bus, feedback, dry/wet, filter cutoff and resonance. Velocity opens the bow's colour through a control-rate lowpass, which is the expressive part.",
  source: {
    patch: "axoloti-contrib mtyas/messymix/big MI stingy patch.axp",
    file: "patches/mtyas/messymix/big MI stingy patch.axp @ 1.0.12 (798166f)",
    author: "mtyas (contrib), over Mutable Instruments DSP ported to Axoloti by the forum",
    popularity: "the densest Mutable demo in the contrib library — the only patch using Elements' diffuser and reverb standalone",
    distinct: 28,
    families: ["physical modelling", "MI reverb / diffuser / chorus", "polyphony", "delay"],
  },
  deviations: [
    // ── THE BIG ONE ─────────────────────────────────────────────────────────
    "POLY 5 IS NOT REPRODUCED, AND NO PART OF PowerRP CAN EXPRESS IT TODAY. The voice lives in a `patch/patcher` with `poly=5`: Axoloti instantiates the subpatch five times and allocates incoming notes across the copies. PowerRP's only polyphony is a node that owns its voice pool INTERNALLY (`audio_poly_pad`'s `voices` knob over synth/voices.js), which cannot wrap an arbitrary subgraph. The three alternatives were weighed and are recorded so the choice can be re-litigated rather than guessed at: (a) a `poly/voices` PLACEHOLDER standing for the patcher — rejected because a patcher's ports ARE its subpatch's inlets and outlets, so the type has no stable port list, and `stubRegistry` would throw the moment a second patch declared it with different ones; (b) five copies of the voice graph — rejected because nothing would allocate notes between them, so five copies of one keyboard is a UNISON, which is a false picture of polyphony and 40 duplicate cards; (c) ONE voice, stated here. (c) is built. Everything inside the patcher is present and correct; only the multiplication is missing.",
    // ── SUBSTITUTIONS AND DROPS ─────────────────────────────────────────────
    "`patch/patcher` ×3, `patch/inlet a` ×2, `patch/inlet f` ×6, `patch/outlet a` ×3 dropped as ENCAPSULATION. Two of the three patchers (`obj_1`, `obj_2`) are plain subpatches with no polyphony — they exist to reuse one delay twice — and their inlets/outlets are wires once inlined. The third is the poly voice, above. PowerRP has groups for visual encapsulation, but a blueprint is a flat item graph, so inlining is the honest form.",
    "`gpio/in/analog` ×7 → seven `node_knob` widgets, which is what the survey recommends. THEIR VALUES ARE THE ONLY NUMBERS IN THIS PATCH THAT ARE NOT HARVESTED: an ADC has no stored position, so the patch file records none, and the seven values here are chosen. AND THEIR RANGES ARE NOT 0…1: a hardware knob's 0…1 becomes each destination's own range (resonance 0…64, filter pitch ±16 semitones), because a literal 0…1 into a semitone or dial port is a control that moves nothing — 'never ship an inert control' is a house rule.",
    "`conv/unipolar2bipolar` dropped. It exists to turn the ADC's 0…1 into ±1 for the two filters' pitch inlets, where a frac32 ±1.0 means ±64 semitones. A Knob widget states its own range, so it emits ±16 semitones directly and the adaptor has nothing left to adapt. ±16 rather than ±64 because no single node multiplies by 64 (`audio_ax_math`'s `b` reaches ±16); the sweep is therefore two octaves shallower than the hardware's, which is a real difference and this is where it is written down.",
    "`delay/write sdram` + `delay/read interp` → ONE `audio_ax_delay_sdram` placeholder, per pair. On hardware they are joined by an instance NAME (`read`'s `delayname` attribute), not a wire; PowerRP has no name-binding between nodes, and a write-only node has no outlet, so it could never reach an output and the patch law refuses it. The 16384-sample (341 ms) buffer is an ATTRIBUTE — construct-time — so it is not a knob on the placeholder; it belongs on AX-5's real node as a `construct: true` row and is recorded here.",
    "THE DELAY FEEDBACK LOOP IS FOLDED INTO THAT NODE, AND ONE `math/*` IS ABSORBED. In the source, `read.out` × the `feedback` inlet returns to `mix/mix 3.in2`, which feeds `write.in` — a CYCLE. A blueprint's columns must be non-decreasing along every wire (the Reaktor law), and no column assignment satisfies a cycle, so the loop cannot be drawn. Rather than drop the feedback and ship two single-tap delays, the placeholder carries a `feedback` input — the shape our own `audio_delay` already has — and the knob wires straight to it. The consequence, stated plainly: `mix/mix 3`'s `in2` is left unwired and the `math/*` that scaled the tap has no node here. Its gain2 (60.0 dial) is still on the mixer, so nothing is lost from the record.",
    "`midi/in/keyb` and `midi/in/bend` are PLACEHOLDERS rather than our `node_keyboard`, and the reason is a UNIT BUG that would otherwise have been planted for later. `node_keyboard`'s `pitch` output is in HERTZ (plugins/node_keyboard.js, `noteFrequency`); every Axoloti pitch port is in SEMITONES FROM E4. Wiring the widget to `osc/brds/bowed.pitch` would transpose each note by its own frequency in semitones, and it would look right until AX-6 landed. The keyboard widget also has no `velocity` output, so the velocity → colour mapping — the expressive heart of this patch — could not be built from it at all.",
    "`gain/vca` → `audio_vca` (NODE_REGISTRY marks it `variant(ours)`), at `gain: 0` because the wire is the level. `audio/out stereo` → an `audio_mixer` summing L and R into the mono analysis tail: the tail's meter, spectrum and output are single-input, and a patch must reach an `audio_output`. The two channels genuinely differ here (unlike A10's), so this collapse loses the stereo image — the two chains are still separately visible and separately filtered up to that point.",
    "`tiar/dist/DPSoftClip`'s params are `InGain` / `OutGain`; the placeholder spells them `ingain` / `outgain` under the port-key normalisation rule (lowercase, non-alphanumerics to `_`). Values 25.0 / 15.0 unchanged.",
    "`kfilter/lowpass` has ONE `freq` param (16.0 harvested); our shipped `audio_ax_kfilter_lowpass` is the asymmetric variant with separate `rise` and `decay`. Both are set to 16.0, which is the symmetric filter the source has.",
    "AUTOPLAY (§ R7-AUDIBLE, the THIRD way; seven `ap*` nodes). Measured before: −inf dBFS; after: −9.9 dBFS, peak −3.9. TWO reasons it was dead, and the second was not expected. `audio_ax_brds_bowed` is a placeholder, so there is no source — that much follows from the deviation above. But this patch ships no `node_keyboard` (see the unit-bug deviation for why), so its `audio_ax_midi_keyb` had NO WIRE ON ANY OF ITS FOUR INPUTS: nothing could ever have gated `env/ahd m`, and the velocity → colour mapping this patch's `help` calls the expressive part had no velocity to read. So the branch gates the keyboard node itself, which wakes the whole front of the patch, and substitutes ONE `audio_ax_osc` saw for the Braids BOWED model — a spectral impression of a physical model, not the model, and everything after it (the envelope × velocity, both vcf3s, both soft clippers) is the patch's own.",
    "⚠ AND A GATE ALONE WAS NOT ENOUGH — `audio_ax_midi_keyb` NEEDS A PITCH IN HERTZ OR IT EMITS NOTHING AT ALL. Measured, after the first version of the branch shipped a gate and the patch stayed at −inf: the node's note-on is guarded by its zone, its own derivation says a note outside [start_note, end_note] is \"IGNORED entirely, gate included\", and an unwired `pitch` inlet reads 0 Hz whose semitone value is −Infinity. So gate, note AND velocity all stayed dead. Isolated in `.frenzy/w_r7aud`: the same graph with the gate wired straight to the envelope sounds at −16.5 dBFS and routed through the keyboard node is silent, and adding a hertz value on `pitch` makes the two match to a tenth of a dB. THIS IS THE MIRROR IMAGE OF § R7-AXO-TRAPS TRAP 1 — that trap is a hertz source landing on a semitone port; this is the adaptor built to fix it being INERT until something puts hertz in, with nothing on the canvas to show it. Three nodes supply it: a counter, a step table holding 8/10/12/15 and one ×16, i.e. 128/160/192/240 Hz.",
  ],
  nodes: [
    // ── THE VOICE (one; poly 5 is in the deviations) ───────────────────────
    { id: "keyb", type: "audio_ax_midi_keyb", col: 0, row: 0 },
    { id: "bend", type: "audio_ax_midi_bend", col: 0, row: 1 },
    { id: "bendmix", type: "audio_ax_mix", col: 1, row: 0, knobs: { gain1: 0.2 } },
    // IN SECONDS, from the harvested dials −50 and 36 through `axDecayDialSeconds` — the
    // HALF-LIFE map (`DecayTime`), which is `env/ahd m`'s and not `LinearTimeExp`.
    // ⚠ THE ATTACK'S −50 IS CLAMPED TO DIAL 0 AND THAT IS THE FAITHFUL ANSWER, not a
    // rounding: their dial is UNSIGNED (`pf_unsigned_clamp`), so on hardware a negative
    // reads as 0 — which is the FASTEST setting at 14.8 ms, not the slowest. AX-4's knob
    // help warns about exactly this value. It is written to eight decimals because dial 0 IS
    // the knob's minimum: six would round BELOW the bound and fail the range law.
    { id: "ahd", type: "audio_ax_env_ahd", col: 1, row: 1, knobs: { a: 0.01478714, d: 0.033799 } },
    { id: "velamp", type: "audio_ax_math", col: 2, row: 0, knobs: { operation: "multiply", b: 0 } },
    { id: "velcolour", type: "audio_ax_kfilter_lowpass", col: 1, row: 2, knobs: { rise: 16, decay: 16 } },
    { id: "bowed", type: "audio_ax_brds_bowed", col: 2, row: 1, knobs: { pitch: 0, timbre: 40.5, color: 40 } },
    { id: "voicevca", type: "audio_vca", col: 3, row: 0, knobs: { gain: 0 } },
    { id: "voiceamp", type: "audio_ax_math", col: 4, row: 0, knobs: { operation: "attenuate", b: 0.65625 } },
    // ── THE PANEL: seven knobs where seven hardware ADC inputs were ────────
    { id: "speedlknob", type: "node_knob", col: 0, row: 3, knobs: { value: 0.4, min: 0, max: 1, step: 0.01 } },
    { id: "speedrknob", type: "node_knob", col: 0, row: 4, knobs: { value: 0.55, min: 0, max: 1, step: 0.01 } },
    { id: "fbknob", type: "node_knob", col: 0, row: 5, knobs: { value: 0.45, min: 0, max: 1, step: 0.01 } },
    { id: "amountknob", type: "node_knob", col: 0, row: 6, knobs: { value: 0.5, min: 0, max: 1, step: 0.01 } },
    { id: "speedbusknob", type: "node_knob", col: 0, row: 7, knobs: { value: 0.25, min: 0, max: 1, step: 0.01 } },
    { id: "cutoffknob", type: "node_knob", col: 0, row: 8, knobs: { value: 4, min: -16, max: 16, step: 0.5 } },
    { id: "resoknob", type: "node_knob", col: 0, row: 9, knobs: { value: 18, min: 0, max: 64, step: 0.5 } },
    // ── THE THREE MUTABLE EFFECTS, in parallel off one voice ───────────────
    { id: "diffuser", type: "audio_ax_lmnts_diffuser", col: 5, row: 10 },
    { id: "reverb", type: "audio_ax_lmnts_reverb", col: 6, row: 10, knobs: { amount: 60.5, time: 56, diffusion: 50, gain: 18, lowpass: 46 } },
    { id: "chorus", type: "audio_ax_rngs_chorus", col: 6, row: 11, knobs: { amount: 8.5, depth: 43.5 } },
    // ── DELAY A: fed by chorus L, summed into the RIGHT mixer ──────────────
    { id: "speedlmix", type: "audio_ax_mix", col: 1, row: 12, knobs: { gain1: 0.03125 } },
    { id: "smoothl", type: "audio_ax_smooth", col: 2, row: 12, knobs: { time: 58.5 } },
    { id: "interpl", type: "audio_ax_convert", col: 3, row: 12, knobs: { mode: "smoothStep" } },
    { id: "dryl", type: "audio_ax_math", col: 7, row: 12, knobs: { operation: "attenuate", b: 0.320312 } },
    { id: "delayinl", type: "audio_ax_mix", col: 7, row: 13, knobs: { gain1: 0.695312, gain2: 0.9375, gain3: 0.664062 } },
    { id: "delayl", type: "audio_ax_delay_sdram", col: 8, row: 12, knobs: { time: 0 } },
    { id: "xfadel", type: "audio_ax_xfade", col: 9, row: 12 },
    // ── DELAY B: fed by chorus R, summed into the LEFT mixer ───────────────
    { id: "speedrmix", type: "audio_ax_mix", col: 1, row: 14, knobs: { gain1: 0.03125 } },
    { id: "smoothr", type: "audio_ax_smooth", col: 2, row: 14, knobs: { time: 58.5 } },
    { id: "interpr", type: "audio_ax_convert", col: 3, row: 14, knobs: { mode: "smoothStep" } },
    { id: "dryr", type: "audio_ax_math", col: 7, row: 14, knobs: { operation: "attenuate", b: 0.320312 } },
    { id: "delayinr", type: "audio_ax_mix", col: 7, row: 15, knobs: { gain1: 0.695312, gain2: 0.9375, gain3: 0.664062 } },
    { id: "delayr", type: "audio_ax_delay_sdram", col: 8, row: 14, knobs: { time: 0 } },
    { id: "xfader", type: "audio_ax_xfade", col: 9, row: 14 },
    // ── THE TWO OUTPUT CHAINS, THEN THE MONO TAIL ─────────────────────────
    // `gain6` IS THE AUTOPLAY RETURN — `in6` had no wire, so no harvested gain moves.
    { id: "mixl", type: "audio_ax_mix", col: 10, row: 16, knobs: { gain1: 0.304688, gain2: 0.109375, gain3: 0.140625, gain4: 0.140625, gain5: 0.601562, gain6: C11_AUTOPLAY_RETURN_GAIN } },
    { id: "mixr", type: "audio_ax_mix", col: 10, row: 17, knobs: { gain1: 0.09375, gain2: 0.289062, gain3: 0.140625, gain4: 0.140625, gain5: 0.609375, gain6: C11_AUTOPLAY_RETURN_GAIN } },
    { id: "vcfl", type: "audio_ax_vcf3", col: 11, row: 16, knobs: { pitch: 0, reso: 0 } },
    { id: "vcfr", type: "audio_ax_vcf3", col: 11, row: 17, knobs: { pitch: 0, reso: 0 } },
    // THE DP CLIPPER GAINS ARE NORMALISED dial/64 (AX-4's D9), so the harvested 25 and 15
    // are 0.390625 and 0.234375. As raw dials both were 25× and 15× over the knob's top:
    // an in-gain of 25 is a 100× drive, which is the whole mix pinned to the shaper's
    // flat region — a square wave — and an out-gain of 15 is 30× on top of that.
    { id: "clipl", type: "audio_ax_dp_soft_clip", col: 12, row: 16, knobs: { ingain: 0.390625, outgain: 0.234375 } },
    { id: "clipr", type: "audio_ax_dp_soft_clip", col: 12, row: 17, knobs: { ingain: 0.390625, outgain: 0.234375 } },
    { id: "stereosum", type: "audio_mixer", col: 13, row: 16, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "meter", type: "audio_meter", col: 14, row: 16 },
    { id: "spectrum", type: "audio_spectrum", col: 15, row: 16 },
    { id: "out", type: "audio_output", col: 16, row: 16, knobs: { volume: 0.7 } },
    ...AXO_MUTABLE_STACK_AUTOPLAY.nodes,
  ],
  wires: [
    { from: "keyb", fromPort: "note", to: "bendmix", toPort: "bus_in" },
    { from: "bend", fromPort: "bend", to: "bendmix", toPort: "in1" },
    { from: "bendmix", fromPort: "out", to: "bowed", toPort: "pitch" },
    { from: "keyb", fromPort: "gate2", to: "ahd", toPort: "gate" },
    { from: "keyb", fromPort: "gate2", to: "bowed", toPort: "strike" },
    { from: "ahd", fromPort: "env", to: "velamp", toPort: "a" },
    { from: "keyb", fromPort: "velocity", to: "velamp", toPort: "b" },
    { from: "keyb", fromPort: "velocity", to: "velcolour", toPort: "in" },
    { from: "velcolour", fromPort: "out", to: "bowed", toPort: "color" },
    { from: "bowed", fromPort: "wave", to: "voicevca", toPort: "in" },
    { from: "velamp", fromPort: "out", to: "voicevca", toPort: "gain" },
    { from: "voicevca", fromPort: "out", to: "voiceamp", toPort: "a" },
    { from: "voiceamp", fromPort: "out", to: "diffuser", toPort: "in" },
    { from: "voiceamp", fromPort: "out", to: "reverb", toPort: "l" },
    { from: "voiceamp", fromPort: "out", to: "chorus", toPort: "l" },
    { from: "voiceamp", fromPort: "out", to: "mixl", toPort: "in1" },
    { from: "voiceamp", fromPort: "out", to: "mixr", toPort: "in1" },
    { from: "diffuser", fromPort: "out", to: "reverb", toPort: "r" },
    { from: "diffuser", fromPort: "out", to: "chorus", toPort: "r" },
    { from: "diffuser", fromPort: "out", to: "mixl", toPort: "in2" },
    { from: "diffuser", fromPort: "out", to: "mixr", toPort: "in2" },
    { from: "reverb", fromPort: "l", to: "mixl", toPort: "in4" },
    { from: "reverb", fromPort: "r", to: "mixr", toPort: "in4" },
    { from: "chorus", fromPort: "l", to: "mixl", toPort: "in3" },
    { from: "chorus", fromPort: "r", to: "mixr", toPort: "in3" },
    { from: "speedlknob", fromPort: "out", to: "speedlmix", toPort: "in1" },
    { from: "speedbusknob", fromPort: "out", to: "speedlmix", toPort: "bus_in" },
    { from: "speedlmix", fromPort: "out", to: "smoothl", toPort: "in" },
    { from: "smoothl", fromPort: "out", to: "interpl", toPort: "in" },
    { from: "interpl", fromPort: "out", to: "delayl", toPort: "time" },
    { from: "chorus", fromPort: "l", to: "dryl", toPort: "a" },
    { from: "chorus", fromPort: "l", to: "delayinl", toPort: "in1" },
    { from: "delayinl", fromPort: "out", to: "delayl", toPort: "in" },
    { from: "fbknob", fromPort: "out", to: "delayl", toPort: "feedback" },
    { from: "dryl", fromPort: "out", to: "xfadel", toPort: "i1" },
    { from: "delayl", fromPort: "out", to: "xfadel", toPort: "i2" },
    { from: "amountknob", fromPort: "out", to: "xfadel", toPort: "c" },
    { from: "xfadel", fromPort: "o", to: "mixr", toPort: "in5" },
    { from: "speedrknob", fromPort: "out", to: "speedrmix", toPort: "in1" },
    { from: "speedbusknob", fromPort: "out", to: "speedrmix", toPort: "bus_in" },
    { from: "speedrmix", fromPort: "out", to: "smoothr", toPort: "in" },
    { from: "smoothr", fromPort: "out", to: "interpr", toPort: "in" },
    { from: "interpr", fromPort: "out", to: "delayr", toPort: "time" },
    { from: "chorus", fromPort: "r", to: "dryr", toPort: "a" },
    { from: "chorus", fromPort: "r", to: "delayinr", toPort: "in1" },
    { from: "delayinr", fromPort: "out", to: "delayr", toPort: "in" },
    { from: "fbknob", fromPort: "out", to: "delayr", toPort: "feedback" },
    { from: "dryr", fromPort: "out", to: "xfader", toPort: "i1" },
    { from: "delayr", fromPort: "out", to: "xfader", toPort: "i2" },
    { from: "amountknob", fromPort: "out", to: "xfader", toPort: "c" },
    { from: "xfader", fromPort: "o", to: "mixl", toPort: "in5" },
    { from: "mixl", fromPort: "out", to: "vcfl", toPort: "in" },
    { from: "mixr", fromPort: "out", to: "vcfr", toPort: "in" },
    { from: "cutoffknob", fromPort: "out", to: "vcfl", toPort: "pitch" },
    { from: "cutoffknob", fromPort: "out", to: "vcfr", toPort: "pitch" },
    { from: "resoknob", fromPort: "out", to: "vcfl", toPort: "reso" },
    { from: "resoknob", fromPort: "out", to: "vcfr", toPort: "reso" },
    { from: "vcfl", fromPort: "out", to: "clipl", toPort: "in" },
    { from: "vcfr", fromPort: "out", to: "clipr", toPort: "in" },
    { from: "clipl", fromPort: "out", to: "stereosum", toPort: "in1" },
    { from: "clipr", fromPort: "out", to: "stereosum", toPort: "in2" },
    { from: "stereosum", fromPort: "out", to: "meter", toPort: "in" },
    { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
    { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
    ...AXO_MUTABLE_STACK_AUTOPLAY.wires,
  ],
};

/** This set's blueprints, in the order the palette shows them. */
export const BLOCK_PATCHES = [AXO_DRUM_MACHINE, AXO_MUTABLE_STACK];
