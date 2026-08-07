/**
 * DEMO PATCHES — Axoloti — the hand-built reverbs and the flagship pads.
 *
 * Part of R7-17-SEL's 20 headline patches; see `claude_instructions.md` for the full
 * table and for the user ruling that chose them (*"20 impressive, fully-equipped patches
 * with tons of likes and views"*). The blueprint format, the grid layout rule and the
 * meter/spectrum tail are documented ONCE in `core/audio_patches.js` — read that file's
 * header before adding anything here. The aggregation contract is in
 * `core/audio_patch_sets.js`.
 *
 * THIS SET REBUILDS:
 *   - C1 tiar/synths/Shimmer.axp — two pitch shifters INSIDE a 6x6 FDN, poly 5, 26 distinct / 20 DSP
 *   - C3 tiar/synths/ToTheStarsII.axp — 12 ZDF filters, 10 allpasses, 19 LFOs, 140 objects
 *   - C7 tiar/synths/091-Pad 3 (polysynth)-tiar.axp — 8-voice MPE pad into a Dattorro plate, 39 / 22
 *
 * Every blueprint here carries `source` (the harvested file, its author, its popularity
 * figures, its distinct-module count) and `deviations` (what we did NOT reproduce, and
 * why) — an UNRECORDED substitution is the silent divergence R7-17-SEL exists to prevent.
 *
 * A node this set needs but the library does not yet have is a PLACEHOLDER, declared in
 * the companion `core/audio_stubs_axo_reverb.js`. Read `core/audio_stub_nodes.js` first:
 * a placeholder carries the FINAL type name and the FINAL port names, so the wire written
 * here today is the wire the real module gets.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POLYPHONY: THE VOICE GRAPH IS DRAWN **ONCE**, BEHIND AN ALLOCATOR NODE
 * ════════════════════════════════════════════════════════════════════════════
 * All three of these patches are `patch/patcher poly=N` — Axoloti instantiates a subpatch
 * N times and hands each instance one held note. **PowerRP has no subgraph-instantiation
 * construct at all**, and the three honest ways to say so were weighed:
 *
 *   1. N EXPLICIT COPIES of the voice graph. Rejected on two counts. It is not
 *      polyphony: a keyboard fanned out to N identical voices plays N unisons, because
 *      what makes a poly patcher poly is the ALLOCATION (which free voice takes this
 *      note, who is stolen) and a fan-out has none. And the arithmetic is absurd — C7's
 *      voice is 22 nodes at poly 8, so the patch would be 176 cards before its reverb.
 *   2. ONE VOICE, polyphony recorded as a deviation and nothing else. Rejected: it
 *      discards the number, and `voices` is the single most characterful value in a
 *      patch chosen FOR its polyphony ("batteries-included patches for polyphony").
 *   3. **CHOSEN — an allocator node, `audio_ax_poly_voices`, with the voice graph drawn
 *      ONCE beside it as the template.** `.frenzy/round7/NODE_REGISTRY.md` already lists
 *      `poly/voices` as an AX-1 row standing for `patch/patcher`, so this is the
 *      sanctioned shape rather than an invention; it keeps `voices` as DATA (5 / 5 / 8);
 *      it keeps every voice node, which is what "do not trim a patch to fit" asks; and
 *      it needs no new wire type.
 *
 * WHAT THE CHOICE COSTS, said plainly. The allocator's outputs are the per-voice note
 * surface (`note`, `gate`, `gate2`, `velocity`, `release_velocity`) — the surface
 * `midi/in/keyb` publishes INSIDE a poly patcher, which is where the port list comes from.
 * It carries NO `touch`, because that list was YIELDED to the `axo_poly` set under
 * BRIEF.md's older-wins rule; `core/audio_stubs_axo_reverb.js` states what that costs and
 * what the lead should decide. The graph
 * downstream of it is the TEMPLATE, and the N-fold instantiation plus the summing of the
 * N outputs lives inside the future real node, not on the canvas. So a reader sees one
 * voice and a knob that says how many there are, which is exactly what the Axoloti editor
 * shows. Every patch below repeats this in its own `deviations`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FEEDBACK: A SINGLE-DELAY LOOP IS **INEXPRESSIBLE**, AND THAT IS MEASURED
 * ════════════════════════════════════════════════════════════════════════════
 * These are reverb patches, so their defining structure is a feedback loop, and
 * `core/nodeflow.js` refuses a directed cycle at connect time. Its ONE escape hatch is a
 * port declared `feedbackSafe`, and exactly one port in the library declares it:
 * `audio_delay.in` (`core/audio_specs.js` DELAY_SPEC). Two consequences were MEASURED
 * against `connectionRefusal` rather than reasoned about, in
 * `.frenzy/round7/w_axoverb/probe_cycle2.mjs`:
 *
 *   A. **A LOOP CONTAINING EXACTLY ONE `audio_delay` IS REFUSED.** `wouldCycle` drops
 *      edges ENTERING a feedbackSafe port when it walks, but it does not exempt the edge
 *      being PROPOSED — so the wire into that one delay walks back through the rest of
 *      the loop (all ordinary edges) and finds the delay again. Every other wire in the
 *      loop is accepted; that one is not. This is an artefact of the walk, not a design
 *      decision, and it is the single most important thing this set found.
 *   B. **A LOOP CONTAINING TWO OR MORE IS ACCEPTED.** N feedbackSafe edges cut the cycle
 *      into N arcs and each proposed edge's backward walk stops inside its own arc.
 *
 * SO EVERY FEEDBACK LEG HERE DRAWS ITS DELAY LINE AS **TWO SEGMENTS IN SERIES WHOSE TIMES
 * SUM TO THE AUTHORED LENGTH.** That is exact — one line of length T is two of T/2, and a
 * modulation wire on the first segment moves the total by the same amount it moved the
 * whole line — so nothing about the tuning of a tank changes. Where the original leg's
 * delay lives inside a module we cannot declare `feedbackSafe` (a pitch shifter's window,
 * an allpass's line), the two segments spend that module's OWN measured length, and where
 * the original has no delay at all the two segments spend `FEEDBACK_FLOOR_SECONDS`. Each
 * case is named in the patch's `deviations`.
 *
 * THE FIX THE LEAD SHOULD WEIGH is `feedbackSafe` on the placeholder declaration format
 * (`stubSpec` today carries only `{key, type, label}`), so `audio_ax_fdn_d6`,
 * `audio_ax_apnoodle` and `audio_ax_allpass` can say what is true about their own buffers
 * and the split segments can be deleted.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNITS: HOW AN AXOLOTI DIAL BECOMES A KNOB VALUE HERE
 * ════════════════════════════════════════════════════════════════════════════
 * Every number below is the EFFECTIVE value (parent `<params>` overrides applied — see
 * `.frenzy/round7/survey_axoloti.md` § 0.4, which is not optional reading), converted by
 * these five laws and nothing else. They are written once, here.
 *
 *   1. **A `pitch` dial is already semitones from E4** (`frac32.s.map.pitch`), and so is
 *      every AX spec's `pitch` knob — so it copies across unchanged. Same for
 *      `filter/hp1`'s `freq`, `kfilter/lowpass`'s `freq` and an LFO's `lfopitch` dial.
 *   2. **A plain dial is `dial/64`** (`frac32.u.map` / `.s.map`): a mixer gain of 40.0 is
 *      0.625, an allpass `g` of 49.0 is 0.7656.
 *   3. **…EXCEPT INTO A PITCH INPUT, WHERE IT IS THE DIAL ITSELF.** On hardware a frac32
 *      pitch wire is multiplied by 64, so `math/*c 5.5` into a `pitch` inlet is
 *      `a·(5.5/64)·64` = 5.5 SEMITONES. Our pitch inputs are already semitones, so the
 *      64s cancel and the dial is the answer: transcribe `math/*c d` into a pitch input as
 *      `multiply` with `b = d`, and into a plain gain as `attenuate` with `b = d`.
 *   4. **An envelope time dial is `32/(440·2^((−d−5)/12))` seconds**, derived and
 *      cross-checked against `LinearTimeExp.ToReal` in
 *      `.frenzy/round7/axoloti_research_report.md:1560-1610`. Sustain is `dial/64`.
 *   5. **A `delay/read` or `over1tap` time is a FRACTION OF ITS BUFFER**, and our
 *      `audio_delay` is in seconds — so `dial/64 × bufferSeconds`, with the buffer read
 *      off the object's `size` attribute (16384 at the 96 kHz oversampled rate = 0.1707 s;
 *      32768 at 48 kHz = 0.6827 s). The buffer length is also what a mix gain feeding such
 *      a time must be multiplied by, which is why the modulation depths below are small
 *      numbers in seconds rather than dials.
 */

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AUTOPLAY: WHY EVERY PATCH HERE CARRIES AN `ap*` BRANCH (§ R7-AUDIBLE)
 * ════════════════════════════════════════════════════════════════════════════
 * THE RULING (user, 2026-08-07): *"any patch that doesn't make audio right away … needs
 * to make noise automatically"*. MEASURED before this branch existed: all three patches
 * here rendered at **−inf dBFS** in `tests/patch_sound_probe.mjs`.
 *
 * NONE OF THE THREE HAS A KEYBOARD AT ALL, so § R7-AUDIBLE's second way was never
 * available to them — and it would not have helped if it were. `readAudioScene` drops
 * every wire out of a control widget, and `core/live_control.noteRoutes` delivers a key
 * press only to an input declared `method: true`, which exactly two ports in the library
 * are (`audio_ding.gate`, `audio_poly_pad.gate`). A `node_keyboard` in front of an
 * Axoloti voice cannot sound it today. That is reported, not worked around.
 *
 * SO ALL THREE TAKE THE THIRD WAY — an added self-driving source, recorded as a deviation
 * on each. Every branch is the same two-node clock, and it drives the patch's OWN
 * `audio_ax_poly_voices` gate, which is the seam that wakes the harvested envelopes:
 *
 *      audio_ax_lfo (square)  →  audio_trigger  →  poly.gate
 *
 * The Schmitt is structural, not decoration — `core/nodeflow.COERCIONS` has no
 * `audio → trigger`, deliberately, so a square wave becomes events only through one.
 *
 * ── THE CLOCK IS DRAWN IN THE POLY ALLOCATOR'S OWN COLUMN, AND THAT IS FORCED ─
 * `tests/audio_patches_test.js` requires `from.col <= to.col` on every wire, `poly` is at
 * column 0 in all three, and a clock must reach it — so the two clock nodes sit at
 * column 0 too, stacked below the patch. Equal columns are legal; a column to the left
 * would be negative. The same reason the tank is one column, applied to the front.
 *
 * ── WHAT EACH BRANCH ADDS BEYOND THE CLOCK, AND WHY IT DIFFERS ──────────────
 * The voice's OSCILLATOR is a placeholder in all three (`audio_ax_selfpm`,
 * `audio_ax_6coseg`, `audio_ax_dp2saw`), so each also substitutes shipped oscillators for
 * it — and each routes them into as much of its own LIVE chain as an unoccupied input
 * allows, rather than being a drone beside the patch. C3 is the extreme case and the best
 * argument for the approach: two `audio_ax_osc` into `stereoL`/`stereoR`'s free inputs
 * light up sixty live nodes, the whole twelve-filter ZDF bank included.
 *
 * ── NOTHING HARVESTED IS REWIRED ────────────────────────────────────────────
 * Every branch takes FREE mixer inputs and FANS OUT of existing outputs, so the ported
 * graph is byte-identical underneath it and the `ap*` nodes delete in one block the day
 * their placeholders land. The exceptions are mixer LEVELS for inputs that had no wire,
 * named at their sites.
 */

/** The rate an `audio_ax_lfo` runs at with its `pitch` knob at 0 — the base every LFO
 *  dial in this corpus is relative to, restated from AX-2's arithmetic. */
const AX_LFO_BASE_HZ = 5.15;

/**
 * THE AUTOPLAY GATE'S WIDTH, AND IT IS THE LONGEST THE ENGINE WILL GIVE — 100 ms,
 * `TriggerProcessor`'s own `maxValue` (synth/worklets/processors.js:339).
 *
 * ── WHY NOT THE 5 ms THE PORTED PATCHES USE FOR THEIR OWN SCHMITTS ──────────
 * Because those fire `pulse/d`, which HOLDS its own shape after a trigger, and these fire
 * `audio_adsr`, which does not: an ADSR handed a 5 ms gate attacks for 5 ms and then
 * RELEASES. Measured on C7 before this constant existed — its amplitude envelope decayed
 * monotonically to −100 dBFS over the render and never came back, which is one blip, not
 * a note, and it cost the patch 30 dB. C1 hid the same defect because its `ampScale`
 * multiplies by 15.5, so a blip is still loud; that is exactly the kind of thing a
 * measurement catches and a reading does not.
 *
 * 100 ms is not a musical choice, it is a ceiling. An ADSR with a 30 ms attack reaches
 * full and starts its decay inside it, so the note is the envelope's own release rather
 * than a click — good enough, and named as a bound rather than a value.
 *
 * ⚠ THE SPEC AND THE WORKLET DISAGREE ABOUT THIS BOUND: `TRIGGER_SPEC`'s knob says max
 * 200, `TriggerProcessor` clamps at 100. Not this file's to fix; 100 is inside both.
 */
const AUTOPLAY_PULSE_MS = 100;

/**
 * How loud an autoplay branch returns into a harvested bus — the DEFAULT, which every
 * patch here then overrides. Below the authored path's own level so that when the
 * placeholders land the PORT dominates and the branch is a bed under it.
 *
 * ONE SHARED NUMBER WOULD HAVE CLIPPED TWO OF THE THREE, which is why `stereoTail` takes
 * it as a parameter: a branch's loudness at the tail depends on how much of the patch's
 * own gain staging it passes through first, and the three differ by 24 dB. Measured at
 * this default: C1 +1.4 dBFS peak, C3 +0.1, C7 −11.2, against the probe's +0.5 clip bar.
 */
const AUTOPLAY_RETURN_LEVEL = 0.8;

/**
 * Pure function. The `audio_ax_lfo` `pitch` knob that runs at a given rate — written once
 * so a third reader does not re-derive the 5.15 Hz base and land an octave out.
 *
 * @param {number} hz - the wanted rate in hertz
 * @returns {number} semitones, rounded to the dial's own tenth
 *
 * @example lfoPitchForHz(5.15) // 0
 * @example lfoPitchForHz(0.4) // -44.2 — a note every two and a half seconds
 */
function lfoPitchForHz(hz) {
  return Math.round(12 * Math.log2(hz / AX_LFO_BASE_HZ) * 10) / 10;
}

/**
 * Pure function. THE AUTOPLAY CLOCK, and the wire that plays the patch with it: a square
 * LFO, the Schmitt that turns it into events, and the gate into `poly`.
 *
 * A LOCAL COPY OF A SHAPE `core/audio_patches_axo_poly.js` ALSO HOLDS, and that is the
 * same debt `analysisTail` already carries in every set file: the PATCH-SET CONTRACT
 * allows one exported name and forbids importing `core/audio_patches.js`, so a helper two
 * sets want has nowhere shared to live. THE FIX IS ONE LEAF MODULE THE LEAD OWNS.
 * Reported, not applied — this agent owns three files.
 *
 * @param {number} row - the LFO's row; the Schmitt sits one below, both at column 0
 * @param {number} hz - the note rate
 * @returns {{nodes: object[], wires: object[], trig: string}}
 *
 * @example autoPolyClock(25, 0.4).trig // "apEdge"
 * @example autoPolyClock(25, 0.4).wires.at(-1).to // "poly"
 * @example autoPolyClock(25, 5.15).nodes[0].knobs.pitch // 0
 */
function autoPolyClock(row, hz) {
  return {
    trig: "apEdge",
    nodes: [
      { id: "apLfo", type: "audio_ax_lfo", col: 0, row, knobs: { waveform: "square", pitch: lfoPitchForHz(hz) } },
      { id: "apEdge", type: "audio_trigger", col: 0, row: row + 1, knobs: { pulseMs: AUTOPLAY_PULSE_MS } },
    ],
    wires: [
      { from: "apLfo", fromPort: "out", to: "apEdge", toPort: "in" },
      { from: "apEdge", fromPort: "out", to: "poly", toPort: "gate" },
    ],
  };
}

/**
 * Every audio_delay used to CUT a feedback loop rather than to carry an authored delay
 * gets this length. It is one Web Audio render quantum rounded up (128/48000 = 2.67 ms):
 * DELAY_SPEC's own bar for a real feedback path, and below it the browser mutes the cycle
 * outright. Two segments therefore cost 6 ms in a leg that had none, which is named in
 * every `deviations` list that spends it.
 */
const FEEDBACK_FLOOR_SECONDS = 0.003;

/**
 * The three `tiar/delay/over1tap` buffer lengths these patches use, in seconds, and the
 * two `delay/write sdram` ones. `over1tap` runs 2x oversampled, which is why its 16384
 * samples are 170 ms rather than 341.
 */
const OVER1TAP_16K_SECONDS = 16384 / 96000;
const OVER1TAP_32K_SECONDS = 32768 / 96000;
const SDRAM_16K_SECONDS = 16384 / 48000;
const SDRAM_32K_SECONDS = 32768 / 48000;

/**
 * `tiar/fx/pitchX3` and `tiar/fx/pitchoct` are overlap-add shifters whose window is an
 * ATTRIBUTE (8192 samples in Shimmer), not a knob — so the placeholder cannot declare it
 * and the value would be lost. It is spent instead as the length of the two segments that
 * make that leg's loop expressible, which is both the honest place for it and a record
 * that survives in the document.
 */
const PITCH_SHIFTER_WINDOW_SECONDS = 8192 / 48000;

/** Top of `audio_delay`'s damping range — i.e. a delay line that colours nothing, which
 *  is what every Axoloti delay line is (the tanks below filter with their own hp1/lp1). */
const NO_DAMPING_HZ = 20000;

/**
 * Pure function. A feedback leg's delay line as TWO `audio_delay` segments in series —
 * the shape law B above forces (see the FEEDBACK section of this file's header).
 *
 * The pair is transparent apart from its length: `feedback: 0` (the loop is drawn on the
 * canvas, not hidden inside the module), `wet: 1, dry: 0` (a delay line, not a mix) and
 * `damping: NO_DAMPING_HZ` (the leg's own filters do the colouring — an Axoloti delay
 * line has no lowpass in it).
 *
 * @param {string} id - the leg's name; the segments are `<id>a` and `<id>b`
 * @param {number} col - grid column (a whole loop shares ONE column; see the layout note)
 * @param {number} row - grid row of the FIRST segment; the second sits one row below
 * @param {number} seconds - the AUTHORED total length of the line
 * @returns {object[]} two blueprint nodes
 *
 * @example delayPair("legB", 9, 1, 0.1387).map((n) => n.id) // ["legBa", "legBb"]
 * @example delayPair("legB", 9, 1, 0.1387)[0].knobs.time // 0.06935
 * @example delayPair("x", 2, 0, 0.006)[1].row // 1
 */
function delayPair(id, col, row, seconds) {
  const half = seconds / 2;
  const knobs = { time: half, feedback: 0, damping: NO_DAMPING_HZ, wet: 1, dry: 0 };
  return [
    { id: `${id}a`, type: "audio_delay", col, row, knobs },
    { id: `${id}b`, type: "audio_delay", col, row: row + 1, knobs },
  ];
}

/** Pure function. The wires chaining a `delayPair` from `from` into `to`.
 *
 * @param {string} id - the pair's name, as given to delayPair
 * @param {{item: string, port: string}} from - what feeds the pair
 * @param {{item: string, port: string}} to - what the pair feeds
 * @returns {object[]} three wires
 *
 * @example delayPairWires("legB", {item: "d6", port: "out2"}, {item: "legBhp", port: "in"}).length // 3
 * @example delayPairWires("x", {item: "a", port: "out"}, {item: "b", port: "in"})[1].from // "xa"
 */
function delayPairWires(id, from, to) {
  return [
    { from: from.item, fromPort: from.port, to: `${id}a`, toPort: "in" },
    { from: `${id}a`, fromPort: "out", to: `${id}b`, toPort: "in" },
    { from: `${id}b`, fromPort: "out", to: to.item, toPort: to.port },
  ];
}

/**
 * Pure function. The meter → spectrum → output tail every patch must end in, plus the
 * mixer that sums a STEREO pair into it.
 *
 * WHY A MIXER IS PART OF THE TAIL HERE: all three of these patches end at
 * `audio/out stereo`, and `tests/audio_patches_test.js` requires an `audio_output` (a mono
 * module) with every node reaching it. Summing L and R is the smallest honest answer —
 * `audio_mixer` at unity, which BEACH already uses for exactly this fan-in reason.
 *
 * `level3` AND `level4` ARE THE AUTOPLAY RETURN in all three patches — free inputs on the
 * one mixer every patch here already has, so no harvested gain moves. The level is a
 * PARAMETER because how much a branch has to give back depends on how much of the patch's
 * own gain staging it passes through first, and C3 passes through all of it: measured, its
 * two `audio_ax_math` voice gains (attenuate 10 and 12) put the same branch 2.6 dB hotter
 * than C1's, over `tests/patch_sound_probe.mjs`'s +0.5 dBFS clip bar. One number per patch
 * is the honest answer; one shared number would have been a clip in one of them.
 *
 * @param {number} col - column of the summing mixer; the tail runs three columns right
 * @param {number} row - grid row for the whole tail
 * @param {number} [returnLevel] - the autoplay branch's return gain on in3/in4
 * @returns {object[]} four blueprint nodes: sum, meter, spectrum, out
 *
 * @example stereoTail(10, 0).map((n) => n.type)
 * // ["audio_mixer", "audio_meter", "audio_spectrum", "audio_output"]
 * @example stereoTail(10, 0)[3].col // 13
 * @example stereoTail(10, 0)[0].knobs.level3 // 0.8
 * @example stereoTail(24, 0, 0.4)[0].knobs.level4 // 0.4
 */
function stereoTail(col, row, returnLevel = AUTOPLAY_RETURN_LEVEL) {
  return [
    { id: "sum", type: "audio_mixer", col, row, knobs: { level1: 0.5, level2: 0.5, level3: returnLevel, level4: returnLevel, master: 1 } },
    { id: "meter", type: "audio_meter", col: col + 1, row },
    { id: "spectrum", type: "audio_spectrum", col: col + 2, row },
    { id: "out", type: "audio_output", col: col + 3, row, knobs: { volume: 0.7 } },
  ];
}

/** Pure function. The wires of a `stereoTail`, given the two channels feeding it.
 *
 * @param {{item: string, port: string}} left - the left channel's source
 * @param {{item: string, port: string}} right - the right channel's source
 * @returns {object[]} five wires
 *
 * @example stereoTailWires({item: "d6", port: "out0"}, {item: "d6", port: "out1"}).length // 5
 */
function stereoTailWires(left, right) {
  return [
    { from: left.item, fromPort: left.port, to: "sum", toPort: "in1" },
    { from: right.item, fromPort: right.port, to: "sum", toPort: "in2" },
    { from: "sum", fromPort: "out", to: "meter", toPort: "in" },
    { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
    { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
  ];
}

/**
 * C1 — SHIMMER: two pitch shifters INSIDE a 6x6 FDN feedback path.
 *
 * The best ambient patch in the Axoloti contrib library and the one R7-17-SEL names as
 * the hard structural case. A 6x6 Rochebois dispersion matrix carries the tank; two of
 * its channels leave through PITCH SHIFTERS and come back in, so the tail rises in pitch
 * forever. Twenty of its twenty-six object types are DSP — the highest ratio in the whole
 * Axoloti survey.
 *
 * ── THE LAYOUT IS A TALL COLUMN, AND THAT IS THE HONEST PICTURE ──────────────
 * Columns run left to right in signal order and a test enforces `from.col <= to.col`, so
 * a feedback leg — which by definition returns to where it came from — can only be drawn
 * with every one of its nodes in ONE column. The whole tank is therefore column 9, read
 * top to bottom: the matrix, then its four legs, then H4 and its three. That is not a
 * workaround; a loop has no left-to-right order, and a column is what "no order" looks
 * like in a grid.
 *
 * ── THE VIBRATO IS THE CHARACTER OF THE VOICE, SO NONE OF IT IS DROPPED ─────
 * Per note: a fresh random value (`rand/uniform f trig`, retriggered by the gate) scales
 * the vibrato LFO's PITCH, so **every note's vibrato runs at a different speed**; and the
 * vibrato's DEPTH is the amplitude envelope pushed through a five-point transfer function
 * (`tiar/kfunc/u4u` — our `audio_ax_shaper`) whose points 0.078, 0.086, 0.133, 0.398, 1.0
 * are flat then steep, i.e. **delayed vibrato that blooms late in the note**. Two
 * self-phase-modulating oscillators then take that pitch, their feedback amounts moved
 * 120° apart by one tri-phase LFO, which is what stops the pair from beating in step.
 */
/** The first free row under C1's tank column, which runs to row 24. */
const C1_AUTOPLAY_ROW = 26;

/** C1's autoplay return level, back at the file default once the trim below exists. */
const C1_AUTOPLAY_RETURN_LEVEL = AUTOPLAY_RETURN_LEVEL;

/**
 * THE ONE-OVER-`ampScale` TRIM, and it is a measurement, not taste.
 *
 * The harvested `ampScale` is `attenuate b: 15.5` and it drives `dca1`/`dca2` — VCAs
 * whose output goes into a 6x6 FDN, where that 15.5 is the tank's input drive. The
 * autoplay branch borrows that same envelope but does NOT go through the tank, so 15.5
 * lands undivided on the output. Measured: the branch slammed the limiter at +1.4 dBFS,
 * and HALVING the return level moved the peak by 0.3 dB — the signature of a limiter, not
 * of a level. So the trim goes at the source, where the missing stage was.
 */
const C1_AUTOPLAY_AMP_TRIM = 1 / 15.5;

/** C1's autoplay note rate, and the PM depth of its substitute oscillator pair. The
 *  depth is a fraction of a cycle because `audio_ax_osc.phase` is in whole cycles; 0.18
 *  is bright enough to hear as a timbre rather than as a sine, and short of the ragged
 *  index a full cycle gives. */
const C1_AUTOPLAY_HZ = 0.35;
const C1_AUTOPLAY_PM_DEPTH = 0.18;

/** The two allpasses the substitute voice returns through — the smallest honest stand-in
 *  for a 6x6 FDN, using the ONE diffuser type this library ships. Their lengths are the
 *  harvested tank's own two allpasses (`h4ap1` 473 samples, `h4ap2` 189), so the branch
 *  at least rings at the frequencies the port will. */
const C1_AUTOPLAY_AP = [{ delay: 473, g: 0.7 }, { delay: 189, g: 0.66 }];

/**
 * C1's AUTOPLAY BRANCH — § R7-AUDIBLE's third way.
 *
 * ── IT DRIVES THE HARVESTED VOICE, NOT A DRONE BESIDE IT ────────────────────
 * The clock's gate into `poly` wakes FOUR live nodes at once, and they are the four this
 * patch's own docstring calls its character: `vibEnv` and `ampEnv` (both `audio_adsr`,
 * shipped), `rate` (a fresh `rand/uniform f` per note, which is what makes every note's
 * vibrato run at a different speed) and, through `shape`, the five-point transfer that
 * makes the vibrato bloom LATE. So the substitute oscillator is pitched by the harvested
 * `notePitch` — real delayed vibrato at a real random rate — and gated by the harvested
 * `ampScale`, i.e. the real four-second amplitude decay. Only the OSCILLATOR is ours.
 *
 * ── WHY AN OSCILLATOR HAD TO BE SUBSTITUTED AT ALL ──────────────────────────
 * `audio_ax_selfpm` is a placeholder, and it cannot be built from shipped parts: feeding
 * an oscillator's own output to its `phase` closes a directed cycle and
 * `core/nodeflow.js` refuses that at connect time. TWO oscillators in series is the
 * nearest expressible thing — classic two-operator phase modulation rather than self-PM,
 * which is a different (and tamer) spectrum. Named, not glossed.
 *
 * ── AND THE TANK IS SIMPLY NOT REACHABLE ────────────────────────────────────
 * Every input into the 6x6 matrix and its H4 child is held by a harvested wire, and both
 * matrices are placeholders anyway, so the shimmer — the thing the patch is named for —
 * cannot sound until AX-? lands `audio_ax_fdn_d6`, `audio_ax_fdn_h4`, `audio_ax_pitchx3`
 * and `audio_ax_pitchoct`. Two `audio_ax_allpass` stand in for the diffusion so the
 * branch is not bone dry; they are NOT a shimmer and are not claimed to be.
 */
const AXO_SHIMMER_AUTOPLAY = (() => {
  const clock = autoPolyClock(C1_AUTOPLAY_ROW, C1_AUTOPLAY_HZ);
  return {
    nodes: [
      ...clock.nodes,
      { id: "apMod", type: "audio_ax_osc", col: 5, row: C1_AUTOPLAY_ROW, knobs: { waveform: "sine", pitch: 12 } },
      { id: "apPmDepth", type: "audio_ax_math", col: 5, row: C1_AUTOPLAY_ROW + 1, knobs: { operation: "attenuate", b: C1_AUTOPLAY_PM_DEPTH } },
      { id: "apCar", type: "audio_ax_osc", col: 6, row: C1_AUTOPLAY_ROW, knobs: { waveform: "sine", pitch: 0 } },
      { id: "apAmpTrim", type: "audio_ax_math", col: 6, row: C1_AUTOPLAY_ROW + 1, knobs: { operation: "attenuate", b: C1_AUTOPLAY_AMP_TRIM } },
      { id: "apVca", type: "audio_vca", col: 7, row: C1_AUTOPLAY_ROW, knobs: { gain: 0 } },
      ...C1_AUTOPLAY_AP.map((ap, i) => ({ id: `apAp${i}`, type: "audio_ax_allpass", col: 8, row: C1_AUTOPLAY_ROW + i, knobs: ap })),
    ],
    wires: [
      ...clock.wires,
      { from: "apMod", fromPort: "out", to: "apPmDepth", toPort: "a" },
      { from: "apPmDepth", fromPort: "out", to: "apCar", toPort: "phase" },
      { from: "notePitch", fromPort: "out", to: "apCar", toPort: "pitch" },
      { from: "apCar", fromPort: "out", to: "apVca", toPort: "in" },
      { from: "ampScale", fromPort: "out", to: "apAmpTrim", toPort: "a" },
      { from: "apAmpTrim", fromPort: "out", to: "apVca", toPort: "gain" },
      { from: "apVca", fromPort: "out", to: "apAp0", toPort: "in" },
      { from: "apAp0", fromPort: "out", to: "apAp1", toPort: "in" },
      // The dry voice and its diffused copy take the summing mixer's two free inputs.
      { from: "apVca", fromPort: "out", to: "sum", toPort: "in3" },
      { from: "apAp1", fromPort: "out", to: "sum", toPort: "in4" },
    ],
  };
})();

export const AXO_SHIMMER = {
  id: "axo-shimmer",
  title: "Axoloti Shimmer (Poly 5)",
  help: "The octave-up shimmer reverb, rebuilt from Smashed Transistors' Shimmer.axp: a 6x6 Rochebois FDN whose tank has TWO PITCH SHIFTERS inside its feedback path, so the tail climbs forever. Underneath it, five voices of self-phase-modulating oscillator with delayed vibrato whose speed is a fresh random value on every note. Turn the shifter legs' delay segments to retune the tank.",
  source: {
    patch: "axoloti-contrib patches/tiar/synths/Shimmer.axp", file: "Shimmer.axp",
    author: "Smashed Transistors (tiar)", popularity: "contrib @ 1.0.12 (798166f) — the reference shimmer patch of the corpus",
    distinct: 26, dsp: 20, objects: 48, poly: 5,
    families: ["FDN reverb", "pitch shifting", "phase modulation", "polyphony"],
  },
  deviations: [
    "POLY 5 IS AN ALLOCATOR NODE, NOT FIVE COPIES — `audio_ax_poly_voices` stands for `patch/patcher poly=5` and the voice graph is drawn ONCE as its template. See this file's POLYPHONY header for the three options weighed and why this one won.",
    "EVERY FEEDBACK LEG'S DELAY LINE IS DRAWN AS TWO SEGMENTS SUMMING TO THE AUTHORED LENGTH — forced, and measured: a loop with one audio_delay is REFUSED by connectionRefusal. Exact for the three `over1tap` legs. See this file's FEEDBACK header.",
    "THE TWO PITCH-SHIFTER LEGS SPEND THE SHIFTER'S OWN 8192-SAMPLE WINDOW as their two segments (85.3 ms each). That window is an `<attribs>` combo, not a knob, so the placeholder cannot hold it; spending it here keeps the number in the document AND makes the leg's loop legal. Delete both segments the day `audio_ax_pitchx3` declares its buffer.",
    "THE D6 -> H4 -> D6 COUPLING AND THE H4 in1 ALLPASS LEG HAVE NO AUTHORED DELAY AT ALL — on hardware they rely on Axoloti's implicit one-sample delay between objects, which Web Audio does not have. Each therefore carries two 3 ms floor segments, so those two legs are 6 ms longer than the original. Audible as a slightly lower tank mode, not as a different patch.",
    "`tiar/delay/over1tap` substituted by `audio_delay` (wet 1, dry 0, feedback 0, damping 20 kHz) — a modulated single tap with a wire-driven time is exactly that, and `audio_delay.in` is the ONLY feedbackSafe port in the library, so it is also the only node a tank leg can be built from. His 2x `Over=Bright` interpolation is NOT reproduced.",
    "`tiar/mix/mix2cs` substituted by `audio_mixer`: two weighted inputs plus a constant, where the constant becomes the delay's own `time` knob (knob + input sum on one AudioParam, the house convention). The two LFO gains are multiplied by the buffer length so the depths are in seconds — 0.9/64 x 170 ms = 2.4 ms of chorus, as authored.",
    "`tiar/gain/DCA` substituted by `audio_vca`. DCA is a plain multiply (measured: `objects/tiar/gain/DCA.axo`) whose only extra is updating its gain at input zero crossings to avoid clicks; that anti-click behaviour is not reproduced.",
    "`env/adsr` substituted by `audio_adsr`, dials converted to seconds by law 4 of this file's UNITS header. Their attack is LINEAR and their release does not re-target, which our ADSR does not reproduce.",
    "`math/*`, `math/*c` and `math/sat` all substituted by `audio_ax_math` (multiply / attenuate / saturate) — that node exists precisely to be Axoloti's whole arithmetic shelf.",
    "`filter/hp1` substituted by `audio_ax_onepole` in highpass mode; `mix/mix 1` by `audio_mixer`; `tiar/filter/Butt10` and `tiar/kfunc/u4u` are the shipped `audio_ax_butterworth10` and `audio_ax_shaper`.",
    "DROPPED, and NOT cosmetic-by-assumption — traced through the patch's `<nets>`: the root `midi/in/keyb` and `osc/sine` exist ONLY to give the two `sss/disp/MIDscope` displays a sync reference (`keyb.note -> sine_2.pitch`, `sine_2.wave -> MIDscope.syncIn`, and that oscillator reaches nothing else). Dropping the scopes therefore drops both. The survey lists that oscillator as `osc/sine (pitch 0, key-tracked)` as though it were part of the voice; it is not.",
    "The stereo `audio/out stereo` is summed to one mono analysis tail, because a patch here must end at `audio_output` with a meter and a spectrum.",
    "AUTOPLAY (§ R7-AUDIBLE, the THIRD way; seven `ap*` nodes). Measured before: −inf dBFS — this patch has NO live source, because `audio_ax_selfpm` is a placeholder and so are both matrices. A 0.35 Hz clock gates the harvested `poly`, which wakes the four live nodes this patch's own docstring calls its character: both `audio_adsr` envelopes, the per-note `rand/uniform f` that gives every note a different vibrato SPEED, and the five-point shaper that makes the vibrato bloom late. A substituted two-operator oscillator pair is then pitched by the harvested `notePitch` and gated by the harvested `ampScale`, so only the OSCILLATOR is ours. It is TWO-OPERATOR PM, not self-PM: feeding an oscillator's output to its own `phase` closes a directed cycle and `core/nodeflow.js` refuses that at connect time, so the nearest expressible thing is a tamer spectrum, and it is named rather than glossed. THE SHIMMER ITSELF DOES NOT SOUND — every input to the 6x6 matrix and its H4 child is held by a harvested wire and both matrices are placeholders, so two `audio_ax_allpass` at the harvested tank's own 473 and 189 samples stand in for the diffusion. They are not a shimmer and are not claimed to be. TWO NUMBERS IN THE BRANCH ARE MEASUREMENTS, not taste: the clock's gate is 100 ms because that is `TriggerProcessor`'s ceiling and an `audio_adsr` handed the 5 ms the ported Schmitts use attacks and immediately RELEASES (C7 lost 30 dB to exactly that, monotonically decaying to −100 dBFS over a whole render); and the branch divides the harvested `ampScale` by its own 15.5, because that factor is the FDN's input drive and this branch does not go through the FDN — at full it slammed the output limiter at +1.4 dBFS, and halving the return level moved the peak by 0.3 dB, which is what a limiter looks like and not what a level does. Measured after: −12.8 dBFS, peak −1.8.",
  ],
  nodes: [
    // ── THE VOICE (poly 5), drawn once as the allocator's template ───────────
    { id: "poly", type: "audio_ax_poly_voices", col: 0, row: 0, knobs: { voices: 5 } },
    // adsr_2 (a 29, d 0, s 64, r 26) — the VIBRATO envelope, not the amplitude one.
    { id: "vibEnv", type: "audio_adsr", col: 1, row: 0, knobs: { attack: 0.5183, decay: 0.09708, sustain: 1, release: 0.4359 } },
    // adsr_3 (a −13, d 64, s 48.5, r 27) — the amplitude envelope: fast in, four-second decay.
    { id: "ampEnv", type: "audio_adsr", col: 1, row: 1, knobs: { attack: 0.04582, decay: 3.914, sustain: 0.7578, release: 0.4618 } },
    // `rand/uniform f trig`, retriggered by the gate: ONE fresh value per note.
    { id: "rate", type: "audio_ax_rand", col: 1, row: 2, knobs: { mode: "trig" } },
    { id: "fbLfo", type: "audio_ax_triphase_lfo", col: 1, row: 3, knobs: { cycle: 4 } },
    // u4u's five points, dial/64. Flat until the last quarter, then a jump to full —
    // which is why the vibrato arrives LATE rather than with the note.
    { id: "shape", type: "audio_ax_shaper", col: 2, row: 0, knobs: { p0: 0.07813, p1: 0.08594, p2: 0.1328, p3: 0.3984, p4: 1 } },
    // *c_1 (amp 15.5) into a plain gain -> `attenuate`, b = the dial (law 3).
    { id: "ampScale", type: "audio_ax_math", col: 2, row: 1, knobs: { operation: "attenuate", b: 15.5 } },
    // *c_2 (amp 1.0) into an LFO's PITCH input -> `multiply`, b = the dial: +/-1 semitone
    // of LFO pitch, i.e. every note's vibrato runs about 6% faster or slower.
    { id: "rateScale", type: "audio_ax_math", col: 2, row: 2, knobs: { operation: "multiply", b: 1 } },
    { id: "vibLfo", type: "audio_ax_lfo", col: 3, row: 0, knobs: { pitch: 4.5536, waveform: "sine" } },
    // math/*: the LFO times the shaped envelope. `b: 0` because the knob is an OFFSET the
    // wire sums into, and the default 1 would add a constant to a product.
    { id: "vibDepth", type: "audio_ax_math", col: 4, row: 0, knobs: { operation: "multiply", b: 0 } },
    // mix/mix 1 (bus_in = note, gain1 = 0.1): note + 0.1 SEMITONES of vibrato (law 3).
    { id: "notePitch", type: "audio_mixer", col: 5, row: 0, knobs: { level1: 1, level2: 0.1, master: 1 } },
    { id: "pm1", type: "audio_ax_selfpm", col: 6, row: 0, knobs: { pitch: 0, fb1: 50, fb0: 15 } },
    { id: "pm2", type: "audio_ax_selfpm", col: 6, row: 1, knobs: { pitch: 0, fb1: 50, fb0: 11 } },
    { id: "dca1", type: "audio_vca", col: 7, row: 0, knobs: { gain: 0 } },
    { id: "dca2", type: "audio_vca", col: 7, row: 1, knobs: { gain: 0 } },

    // ── THE SIX DELAY-MODULATION LFOs, all mutually irrational ──────────────
    { id: "modB1", type: "audio_ax_lfo", col: 7, row: 2, knobs: { pitch: -50.32, waveform: "sine" } },
    { id: "modB2", type: "audio_ax_lfo", col: 7, row: 3, knobs: { pitch: -4.3763, waveform: "sine" } },
    { id: "modC1", type: "audio_ax_lfo", col: 7, row: 4, knobs: { pitch: -61.22, waveform: "sine" } },
    { id: "modC2", type: "audio_ax_lfo", col: 7, row: 5, knobs: { pitch: -12.5132, waveform: "sine" } },
    { id: "modA1", type: "audio_ax_lfo", col: 7, row: 6, knobs: { pitch: -62.71, waveform: "sine" } },
    { id: "modA2", type: "audio_ax_lfo", col: 7, row: 7, knobs: { pitch: -1.7763, waveform: "sine" } },

    // ── THE VOICE'S TWO CHANNELS INTO THE TANK ──────────────────────────────
    { id: "inHpL", type: "audio_ax_onepole", col: 8, row: 0, knobs: { mode: "highpass", pitch: -32 } },
    { id: "inHpR", type: "audio_ax_onepole", col: 8, row: 1, knobs: { mode: "highpass", pitch: -32 } },
    // mix2cs x3: two LFOs into one delay time, depths already multiplied by the buffer.
    { id: "modMixB", type: "audio_mixer", col: 8, row: 2, knobs: { level1: 0.001333, level2: 0.0001867, master: 1 } },
    { id: "modMixC", type: "audio_mixer", col: 8, row: 3, knobs: { level1: 0.001333, level2: 0.00016, master: 1 } },
    { id: "modMixA", type: "audio_mixer", col: 8, row: 4, knobs: { level1: 0.0024, level2: 0.0001867, master: 1 } },

    // ── THE TANK: ONE COLUMN, because a loop has no left-to-right order ─────
    { id: "d6", type: "audio_ax_fdn_d6", col: 9, row: 0 },
    // LEG out2: over1tap_2 (16384 -> 170 ms, d1 base 52.0/64) then hp1(−53).
    ...delayPair("legB", 9, 1, 52 / 64 * OVER1TAP_16K_SECONDS),
    { id: "legBhp", type: "audio_ax_onepole", col: 9, row: 3, knobs: { mode: "highpass", pitch: -53 } },
    // LEG out3: over1tap_3 (32768 -> 341 ms, d1 base 59.0/64) then hp1(−49).
    ...delayPair("legC", 9, 4, 59 / 64 * OVER1TAP_32K_SECONDS),
    { id: "legChp", type: "audio_ax_onepole", col: 9, row: 6, knobs: { mode: "highpass", pitch: -49 } },
    // LEG out4 — THE SHIMMER LEG: brick-wall lowpass, then the x3 shifter, back in.
    { id: "butt", type: "audio_ax_butterworth10", col: 9, row: 7, knobs: { fc: "9k" } },
    ...delayPair("shimA", 9, 8, PITCH_SHIFTER_WINDOW_SECONDS),
    { id: "px3", type: "audio_ax_pitchx3", col: 9, row: 10 },
    // LEG out5 — the second, smaller Hadamard tank hanging off the first.
    ...delayPair("h4Link", 9, 11, FEEDBACK_FLOOR_SECONDS * 2),
    { id: "h4", type: "audio_ax_fdn_h4", col: 9, row: 13 },
    // H4 LEG out1: one allpass, 473 samples, NEGATIVE g.
    { id: "h4ap1", type: "audio_ax_allpass", col: 9, row: 14, knobs: { delay: 473, g: -0.7031 } },
    ...delayPair("h4ap1Cut", 9, 15, FEEDBACK_FLOOR_SECONDS * 2),
    // H4 LEG out2: over1tap_4 (16384 -> 170 ms, d1 base 48.0/64) then hp1(−53).
    ...delayPair("legA", 9, 17, 48 / 64 * OVER1TAP_16K_SECONDS),
    { id: "legAhp", type: "audio_ax_onepole", col: 9, row: 19, knobs: { mode: "highpass", pitch: -53 } },
    // H4 LEG out3 — THE SECOND SHIMMER LEG, an OCTAVE shifter behind a short allpass,
    // saturated on the way back so the octave stack cannot run away.
    { id: "h4ap2", type: "audio_ax_allpass", col: 9, row: 20, knobs: { delay: 189, g: 0.6563 } },
    { id: "poct", type: "audio_ax_pitchoct", col: 9, row: 21 },
    { id: "sat", type: "audio_ax_math", col: 9, row: 22, knobs: { operation: "saturate" } },
    ...delayPair("shimB", 9, 23, PITCH_SHIFTER_WINDOW_SECONDS),

    ...stereoTail(10, 0, C1_AUTOPLAY_RETURN_LEVEL),
    ...AXO_SHIMMER_AUTOPLAY.nodes,
  ],
  wires: [
    // ── THE VOICE ───────────────────────────────────────────────────────────
    { from: "poly", fromPort: "gate", to: "vibEnv", toPort: "gate" },
    { from: "poly", fromPort: "gate", to: "ampEnv", toPort: "gate" },
    { from: "poly", fromPort: "gate", to: "rate", toPort: "trig" },
    { from: "vibEnv", fromPort: "out", to: "shape", toPort: "in" },
    { from: "ampEnv", fromPort: "out", to: "ampScale", toPort: "a" },
    { from: "rate", fromPort: "out", to: "rateScale", toPort: "a" },
    { from: "rateScale", fromPort: "out", to: "vibLfo", toPort: "pitch" },
    { from: "vibLfo", fromPort: "out", to: "vibDepth", toPort: "a" },
    { from: "shape", fromPort: "out", to: "vibDepth", toPort: "b" },
    { from: "poly", fromPort: "note", to: "notePitch", toPort: "in1" },
    { from: "vibDepth", fromPort: "out", to: "notePitch", toPort: "in2" },
    { from: "notePitch", fromPort: "out", to: "pm1", toPort: "pitch" },
    { from: "notePitch", fromPort: "out", to: "pm2", toPort: "pitch" },
    // THE 120-DEGREE SPLIT: one tri-phase LFO, two oscillators, feedback amounts that
    // never coincide. This is the whole reason the pair sounds like two instruments.
    { from: "fbLfo", fromPort: "phi_0", to: "pm1", toPort: "fb_mod" },
    { from: "fbLfo", fromPort: "phi_120", to: "pm2", toPort: "fb_mod" },
    { from: "pm1", fromPort: "wave", to: "dca1", toPort: "in" },
    { from: "pm2", fromPort: "wave", to: "dca2", toPort: "in" },
    { from: "ampScale", fromPort: "out", to: "dca1", toPort: "gain" },
    { from: "ampScale", fromPort: "out", to: "dca2", toPort: "gain" },

    // ── INTO THE MATRIX ─────────────────────────────────────────────────────
    { from: "dca1", fromPort: "out", to: "inHpL", toPort: "in" },
    { from: "dca2", fromPort: "out", to: "inHpR", toPort: "in" },
    { from: "inHpL", fromPort: "out", to: "d6", toPort: "in0" },
    { from: "inHpR", fromPort: "out", to: "d6", toPort: "in1" },

    // ── THE FOUR D6 LEGS ────────────────────────────────────────────────────
    ...delayPairWires("legB", { item: "d6", port: "out2" }, { item: "legBhp", port: "in" }),
    { from: "legBhp", fromPort: "out", to: "d6", toPort: "in2" },
    ...delayPairWires("legC", { item: "d6", port: "out3" }, { item: "legChp", port: "in" }),
    { from: "legChp", fromPort: "out", to: "d6", toPort: "in3" },
    { from: "d6", fromPort: "out4", to: "butt", toPort: "in" },
    ...delayPairWires("shimA", { item: "butt", port: "out" }, { item: "px3", port: "in" }),
    { from: "px3", fromPort: "out", to: "d6", toPort: "in4" },
    ...delayPairWires("h4Link", { item: "d6", port: "out5" }, { item: "h4", port: "in0" }),
    { from: "h4", fromPort: "out0", to: "d6", toPort: "in5" },

    // ── THE THREE H4 LEGS ───────────────────────────────────────────────────
    { from: "h4", fromPort: "out1", to: "h4ap1", toPort: "in" },
    ...delayPairWires("h4ap1Cut", { item: "h4ap1", port: "out" }, { item: "h4", port: "in1" }),
    ...delayPairWires("legA", { item: "h4", port: "out2" }, { item: "legAhp", port: "in" }),
    { from: "legAhp", fromPort: "out", to: "h4", toPort: "in2" },
    { from: "h4", fromPort: "out3", to: "h4ap2", toPort: "in" },
    { from: "h4ap2", fromPort: "out", to: "poct", toPort: "in" },
    { from: "poct", fromPort: "out", to: "sat", toPort: "a" },
    ...delayPairWires("shimB", { item: "sat", port: "out" }, { item: "h4", port: "in3" }),

    // ── THE DELAY MODULATION: two irrational LFOs per line, around a constant ──
    { from: "modB1", fromPort: "out", to: "modMixB", toPort: "in1" },
    { from: "modB2", fromPort: "out", to: "modMixB", toPort: "in2" },
    { from: "modMixB", fromPort: "out", to: "legBa", toPort: "time" },
    { from: "modC1", fromPort: "out", to: "modMixC", toPort: "in1" },
    { from: "modC2", fromPort: "out", to: "modMixC", toPort: "in2" },
    { from: "modMixC", fromPort: "out", to: "legCa", toPort: "time" },
    { from: "modA1", fromPort: "out", to: "modMixA", toPort: "in1" },
    { from: "modA2", fromPort: "out", to: "modMixA", toPort: "in2" },
    { from: "modMixA", fromPort: "out", to: "legAa", toPort: "time" },

    ...stereoTailWires({ item: "d6", port: "out0" }, { item: "d6", port: "out1" }),
    ...AXO_SHIMMER_AUTOPLAY.wires,
  ],
};


/**
 * C3's two generated halves need their columns named, because a generator cannot read a
 * literal that is written beside the nodes it emits. The bank occupies seven columns from
 * `C3_BAND_LFO_COL` (sweep LFO, depth, ZDF stage 1, ZDF stage 2, allpass, weighted sum, dry
 * sum) and the reverb five from `C3_REVERB_COL - 4` (slow LFO, depth, fast LFO, mod sum,
 * THE LOOP) plus one for the clipper.
 */
const C3_BAND_LFO_COL = 13;
const C3_REVERB_COL = 22;

/**
 * Pure function. One channel of C3's filter bank: three cascaded ZDF state-variable pairs,
 * each swept by its own LFO, two of them through an allpass, summed with the dry path.
 *
 * WRITTEN ONCE FOR BOTH CHANNELS. The two banks are the SAME topology with different
 * numbers — different sweep rates, different allpass lengths, one different dry tap — and
 * the patch's whole stereo image is that difference. Spelling twenty-two nodes out twice
 * would make the difference invisible and the divergence inevitable.
 *
 * ── WHY EACH BANK SUMS THROUGH **TWO** MIXERS ───────────────────────────────
 * `mix/mix 4` has FIVE inputs: a unity `bus_in` plus four weighted ones. `audio_mixer` has
 * four. So the four weighted taps meet in `<side>Bank` and the unity dry bus is added in
 * `<side>Dry`. Recorded as a deviation on the patch.
 *
 * @param {string} side - "l" or "r"; every id is prefixed with it
 * @param {object} cfg - `{row, source, dry, bands, apDry, gains}` where `bands` is three
 *   `{p1, q1, p2, q2, lfo, depth, ap}` records (`ap` null for the band that goes direct),
 *   `gains` is `mix/mix 4`'s four converted gains, and `source`/`dry` are node ids.
 * @returns {{nodes: object[], wires: object[]}}
 *
 * @example zdfBank("l", C3_BANK_L).nodes.length // 15
 * @example zdfBank("l", C3_BANK_L).nodes.filter((n) => n.type === "audio_ax_zdf_svf").length // 6
 * @example zdfBank("r", C3_BANK_R).nodes[0].id // "rSweep0"
 */
function zdfBank(side, cfg) {
  const nodes = [];
  const wires = [];
  cfg.bands.forEach((band, i) => {
    const row = cfg.row + i;
    // THE SWEEP: `lfo/sine` x `math/*c d` into a PITCH input is `d` SEMITONES (UNITS law 3),
    // so the transcription is `multiply` with b = the dial and no scaling anywhere else.
    nodes.push({ id: `${side}Sweep${i}`, type: "audio_ax_lfo", col: C3_BAND_LFO_COL, row, knobs: { pitch: band.lfo, waveform: "sine" } });
    nodes.push({ id: `${side}Depth${i}`, type: "audio_ax_math", col: C3_BAND_LFO_COL + 1, row, knobs: { operation: "multiply", b: band.depth } });
    nodes.push({ id: `${side}Zdf${i}a`, type: "audio_ax_zdf_svf", col: C3_BAND_LFO_COL + 2, row, knobs: { pitch: band.p1, Q: band.q1 } });
    nodes.push({ id: `${side}Zdf${i}b`, type: "audio_ax_zdf_svf", col: C3_BAND_LFO_COL + 3, row, knobs: { pitch: band.p2, Q: band.q2 } });
    wires.push({ from: `${side}Sweep${i}`, fromPort: "out", to: `${side}Depth${i}`, toPort: "a" });
    // ONE sweep drives BOTH filters of the pair, which is what keeps a cascaded pair a
    // single band rather than two that drift apart.
    for (const stage of ["a", "b"])
      wires.push({ from: `${side}Depth${i}`, fromPort: "out", to: `${side}Zdf${i}${stage}`, toPort: "pitch" });
    wires.push({ from: cfg.source, fromPort: "out", to: `${side}Zdf${i}a`, toPort: "in" });
    // THE BANDPASS OUTPUT, not the lowpass: `bp6` is what he takes, and it is why this is
    // a formant bank rather than three lowpasses in a row.
    wires.push({ from: `${side}Zdf${i}a`, fromPort: "bp", to: `${side}Zdf${i}b`, toPort: "in" });
    const bankPort = `in${i + 2}`;
    if (band.ap) {
      nodes.push({ id: `${side}Ap${i}`, type: "audio_ax_allpass", col: C3_BAND_LFO_COL + 4, row, knobs: band.ap });
      wires.push({ from: `${side}Zdf${i}b`, fromPort: "bp", to: `${side}Ap${i}`, toPort: "in" });
      wires.push({ from: `${side}Ap${i}`, fromPort: "out", to: `${side}Bank`, toPort: bankPort });
    } else {
      wires.push({ from: `${side}Zdf${i}b`, fromPort: "bp", to: `${side}Bank`, toPort: bankPort });
    }
  });
  // THE DRY ALLPASS: the split signal diffused but unfiltered, at `mix/mix 4`'s in1.
  nodes.push({ id: `${side}ApDry`, type: "audio_ax_allpass", col: C3_BAND_LFO_COL + 4, row: cfg.row + 3, knobs: cfg.apDry });
  nodes.push({
    id: `${side}Bank`, type: "audio_mixer", col: C3_BAND_LFO_COL + 5, row: cfg.row,
    knobs: { level1: cfg.gains[0], level2: cfg.gains[1], level3: cfg.gains[2], level4: cfg.gains[3], master: 1 },
  });
  nodes.push({ id: `${side}Dry`, type: "audio_mixer", col: C3_BAND_LFO_COL + 6, row: cfg.row, knobs: { level1: 1, level2: 1, master: 1 } });
  wires.push({ from: cfg.source, fromPort: "out", to: `${side}ApDry`, toPort: "in" });
  wires.push({ from: `${side}ApDry`, fromPort: "out", to: `${side}Bank`, toPort: "in1" });
  wires.push({ from: `${side}Bank`, fromPort: "out", to: `${side}Dry`, toPort: "in1" });
  wires.push({ from: cfg.dry, fromPort: "out", to: `${side}Dry`, toPort: "in2" });
  return { nodes, wires };
}

/**
 * Pure function. One channel of C3's reverb: an allpass-noodle whose external loop runs
 * through a 341 ms delay line and two long allpasses, with the delay's read point moved by
 * a THREE-LFO CHAIN (a slow sine modulating a faster sine's pitch, three times over, summed).
 *
 * WRITTEN ONCE FOR BOTH CHANNELS for the same reason `zdfBank` is: identical topology,
 * different numbers, and the numbers are the stereo image.
 *
 * The loop lives in ONE column because a loop has no left-to-right order, and its delay is
 * a `delayPair` because a one-delay loop is refused (see this file's FEEDBACK header).
 *
 * @param {string} side - "l" or "r"; every id is prefixed with it
 * @param {object} cfg - `{row, modRow, source, g, delaySeconds, aps, chains, levels, clip}`
 * @returns {{nodes: object[], wires: object[]}}
 *
 * @example reverbChannel("l", C3_REVERB_L).nodes.filter((n) => n.type === "audio_delay").length // 2
 * @example reverbChannel("l", C3_REVERB_L).nodes.some((n) => n.id === "lNoodle") // true
 */
function reverbChannel(side, cfg) {
  const nodes = [
    { id: `${side}Noodle`, type: "audio_ax_apnoodle", col: C3_REVERB_COL, row: cfg.row, knobs: { g: cfg.g } },
    ...delayPair(`${side}Tank`, C3_REVERB_COL, cfg.row + 1, cfg.delaySeconds),
    { id: `${side}TankAp0`, type: "audio_ax_allpass", col: C3_REVERB_COL, row: cfg.row + 3, knobs: cfg.aps[0] },
    { id: `${side}TankAp1`, type: "audio_ax_allpass", col: C3_REVERB_COL, row: cfg.row + 4, knobs: cfg.aps[1] },
    { id: `${side}Clip`, type: "audio_ax_dpsoftclip", col: C3_REVERB_COL + 1, row: cfg.row, knobs: cfg.clip },
    { id: `${side}ModMix`, type: "audio_mixer", col: C3_REVERB_COL - 1, row: cfg.modRow, knobs: { level1: cfg.levels[0], level2: cfg.levels[1], level3: cfg.levels[2], master: 1 } },
    // `math/*c 0.03` on the summed modulation — an attenuate, so b is the dial (UNITS law 3).
    { id: `${side}ModDepth`, type: "audio_ax_math", col: C3_REVERB_COL - 1, row: cfg.modRow + 1, knobs: { operation: "attenuate", b: cfg.modScale } },
  ];
  const wires = [
    { from: cfg.source, fromPort: "out", to: `${side}Noodle`, toPort: "x" },
    ...delayPairWires(`${side}Tank`, { item: `${side}Noodle`, port: "u" }, { item: `${side}TankAp0`, port: "in" }),
    { from: `${side}TankAp0`, fromPort: "out", to: `${side}TankAp1`, toPort: "in" },
    { from: `${side}TankAp1`, fromPort: "out", to: `${side}Noodle`, toPort: "v" },
    { from: `${side}Noodle`, fromPort: "y_out", to: `${side}Clip`, toPort: "in" },
    { from: `${side}ModMix`, fromPort: "out", to: `${side}ModDepth`, toPort: "a" },
    { from: `${side}ModDepth`, fromPort: "out", to: `${side}Tanka`, toPort: "time" },
  ];
  // THE THREE-LFO CHAIN, three times over. Each pair is a slow sine whose output IS the
  // pitch of a faster one — modulation of a modulator, which is why the read point never
  // traces the same path twice.
  cfg.chains.forEach((chain, i) => {
    const row = cfg.modRow - cfg.chains.length + i;
    nodes.push({ id: `${side}ModSlow${i}`, type: "audio_ax_lfo", col: C3_REVERB_COL - 4, row, knobs: { pitch: chain.slow, waveform: "sine" } });
    nodes.push({ id: `${side}ModScale${i}`, type: "audio_ax_math", col: C3_REVERB_COL - 3, row, knobs: { operation: "multiply", b: chain.depth } });
    nodes.push({ id: `${side}ModFast${i}`, type: "audio_ax_lfo", col: C3_REVERB_COL - 2, row, knobs: { pitch: chain.fast, waveform: "sine" } });
    wires.push({ from: `${side}ModSlow${i}`, fromPort: "out", to: `${side}ModScale${i}`, toPort: "a" });
    wires.push({ from: `${side}ModScale${i}`, fromPort: "out", to: `${side}ModFast${i}`, toPort: "pitch" });
    wires.push({ from: `${side}ModFast${i}`, fromPort: "out", to: `${side}ModMix`, toPort: `in${i + 1}` });
  });
  return { nodes, wires };
}

/** C3's three cascaded ZDF bands per channel. The two channels share every centre pitch and
 *  Q and differ ONLY in their sweep rates, sweep depths and allpass lengths — which is
 *  precisely the patch's stereo image, so the two tables sit side by side to be compared. */
const C3_BANK_L = {
  row: 0, source: "splitHpL", dry: "splitLpR",
  bands: [
    { p1: 13.04, q1: 22, p2: 13.04, q2: 18.5, lfo: -61.4, depth: 5.5, ap: { g: 0.7656, delay: 523 } },
    { p1: 21.51, q1: 27.5, p2: 21.54, q2: 15, lfo: -54.58, depth: 4.35, ap: { g: 0.7656, delay: 427 } },
    { p1: 35.59, q1: 21.5, p2: 35.58, q2: 14.5, lfo: -63.1, depth: 3.45, ap: null },
  ],
  apDry: { g: 0.7656, delay: 309 },
  gains: [0.3672, 0.4375, 0.2891, 0.3359],
};
const C3_BANK_R = {
  row: 4, source: "splitHpR", dry: "splitLpR",
  bands: [
    { p1: 13.04, q1: 22, p2: 13.04, q2: 18.5, lfo: -62.6, depth: 4.5, ap: { g: 0.7656, delay: 337 } },
    { p1: 21.51, q1: 27.5, p2: 21.54, q2: 15, lfo: -51.04, depth: 4.25, ap: { g: 0.7656, delay: 468 } },
    { p1: 35.59, q1: 21.5, p2: 35.58, q2: 14.5, lfo: -64, depth: 3.55, ap: null },
  ],
  apDry: { g: 0.7656, delay: 327 },
  gains: [0.3672, 0.4375, 0.2891, 0.3359],
};

/** C3's two reverb channels. `delaySeconds` is the SDRAM read point (dial/64 x 341 ms);
 *  `levels` are `mix/mix 2`'s unity bus and two gains, each already multiplied by the
 *  buffer length so the sum is in SECONDS (UNITS law 5). */
const C3_REVERB_L = {
  row: 0, modRow: 13, source: "vcaML", g: 41.68, delaySeconds: 0.281, modScale: 0.03,
  aps: [{ g: 0.7813, delay: 1726 }, { g: 0.7813, delay: 1117 }],
  chains: [{ slow: -57.8, depth: 3.715, fast: -33.41 }, { slow: -44.84, depth: 2.27, fast: -17.67 }, { slow: -36.78, depth: 0.615, fast: -7 }],
  levels: [0.3413, 0.2133, 0.2693],
  clip: { ingain: 64, outgain: 32 },
};
const C3_REVERB_R = {
  row: 6, modRow: 18, source: "vcaMR", g: 41.68, delaySeconds: 0.2697, modScale: 0.03,
  aps: [{ g: 0.8438, delay: 1685 }, { g: 0.8438, delay: 1343 }],
  chains: [{ slow: -55.85, depth: 3.885, fast: -32.82 }, { slow: -40.42, depth: 2.51, fast: -18.2 }, { slow: -35.22, depth: 0.425, fast: -7.45 }],
  levels: [0.3413, 0.2133, 0.2693],
  clip: { ingain: 64, outgain: 32 },
};

const C3_BANKS = [zdfBank("l", C3_BANK_L), zdfBank("r", C3_BANK_R)];
const C3_REVERBS = [reverbChannel("l", C3_REVERB_L), reverbChannel("r", C3_REVERB_R)];

/**
 * C3 — TO THE STARS II: the flagship ambient pad. 140 objects, and every one of them is
 * doing something.
 *
 * ── WHY THE WAVEFORM NEVER SETTLES, WHICH IS THE WHOLE PATCH ────────────────
 * Two six-cosine-segment oscillators share their six segment LEVELS, and the levels are
 * not settings — they are signals. THREE of them come from sampled-and-held randoms (a
 * square LFO latches a uniform random, then a very slow smoother turns the step into a
 * glide), and THREE come from one sixteen-second tri-phase LFO. So the harmonic content is
 * a moving target that cannot repeat, and it is the reason this patch sounds alive rather
 * than like a preset. The two oscillators additionally have their `l4` and `l5` SWAPPED
 * against each other and their third resonance fed from separate dials, which decorrelates
 * the pair — a deliberate asymmetry, not a wiring slip.
 *
 * ── NINETEEN SINE LFOs, NONE OF THEM AT A RELATED RATE ──────────────────────
 * Six sweep the filter bands. TWELVE are the reverb's read-point modulation, arranged as
 * six PAIRS: a slow sine whose output is the PITCH of a faster sine. One is the voice's
 * vibrato. Every rate is an irrational dial away from every other, which is why nothing in
 * the picture ever lines up.
 */
/** C3's autoplay return level. Measured: at the shared 0.8 the branch peaks at +0.1
 *  dBFS, on the clip bar, because it passes through the patch's own voice gains and its
 *  whole twelve-filter bank on the way. 0.25 lands it near −10 dBFS peak. */
const C3_AUTOPLAY_RETURN_LEVEL = 0.25;

/** C3's first free row — the two ZDF banks and the two tanks fill rows 0-19. */
const C3_AUTOPLAY_ROW = 21;

/** C3's autoplay note rate. Slower than C1's, because its amplitude envelope decays over
 *  1.2 s and its three sample-and-hold morph clocks run at 0.2-0.3 Hz — a note every four
 *  seconds is what lets one of those morphs actually finish inside a note. */
const C3_AUTOPLAY_HZ = 0.25;

/**
 * C3's AUTOPLAY BRANCH — § R7-AUDIBLE's third way, and the cheapest of the three in this
 * file at FOUR nodes, because almost everything downstream of the oscillators is already
 * shipped and already wired.
 *
 * ── FOUR NODES LIGHT UP SIXTY ──────────────────────────────────────────────
 * `audio_ax_6coseg` is a placeholder, so `osc0`/`osc1` are the ONLY hole between the note
 * and the analysis tail: `stereoL`/`stereoR`, both `audio_vca`s, both voice gains, the
 * three-way split, and the entire twelve-filter / six-allpass ZDF bank are shipped nodes
 * sitting idle for want of a signal. Two `audio_ax_osc` on the harvested `notePitch` fix
 * that, and they enter through `stereoL`/`stereoR`'s FREE `in3`/`in4` at the harvested
 * pan gains, so the two substitutes are panned against each other exactly as `osc0` and
 * `osc1` are — that opposition is the patch's whole stereo image.
 *
 * ── WHERE IT LEAVES, AND WHAT IS STILL DARK ────────────────────────────────
 * The banks' outputs (`lDry`/`rDry`) fan out to the summing mixer's free inputs. They do
 * NOT reach it the authored way, because that runs `vcaML`/`vcaMR` — whose gain is a
 * `node_knob` squared, and a control widget's wire is dropped, so the master VCA is shut
 * at its `gain: 0` — and then the two reverb tanks and `audio_ax_dpsoftclip`, which is a
 * placeholder. So the TANKS DO NOT SOUND; what you hear is the voice through the filter
 * bank, which is the majority of this patch's character but not its tail.
 */
const AXO_TO_THE_STARS_AUTOPLAY = (() => {
  const clock = autoPolyClock(C3_AUTOPLAY_ROW, C3_AUTOPLAY_HZ);
  // The harvested detunings, to the hundredth of a semitone, and the harvested waveforms'
  // nearest shipped shapes: `6coseg` is a six-segment cosine table, so a saw and a pulse
  // are a coarse stand-in and are named as one in the deviations.
  const oscs = [
    { id: "apOsc0", pitch: -0.01, waveform: "saw", row: C3_AUTOPLAY_ROW },
    { id: "apOsc1", pitch: 0.01, waveform: "pwm", row: C3_AUTOPLAY_ROW + 1 },
  ];
  return {
    nodes: [
      ...clock.nodes,
      ...oscs.map((o) => ({ id: o.id, type: "audio_ax_osc", col: 8, row: o.row, knobs: { waveform: o.waveform, pitch: o.pitch } })),
    ],
    wires: [
      ...clock.wires,
      ...oscs.map((o) => ({ from: "notePitch", fromPort: "out", to: o.id, toPort: "pitch" })),
      // in3/in4 on both pan mixers, so each substitute reaches both channels — the
      // harvested `stereoL`/`stereoR` gains already say how much of each goes where.
      { from: "apOsc0", fromPort: "out", to: "stereoL", toPort: "in3" },
      { from: "apOsc1", fromPort: "out", to: "stereoL", toPort: "in4" },
      { from: "apOsc0", fromPort: "out", to: "stereoR", toPort: "in3" },
      { from: "apOsc1", fromPort: "out", to: "stereoR", toPort: "in4" },
      // Out of the filter banks and straight to the tail: the authored route through
      // `vcaML` is shut by a control-widget gain, and ends at a placeholder clipper.
      { from: "lDry", fromPort: "out", to: "sum", toPort: "in3" },
      { from: "rDry", fromPort: "out", to: "sum", toPort: "in4" },
    ],
  };
})();

export const AXO_TO_THE_STARS = {
  id: "axo-to-the-stars",
  title: "Axoloti To The Stars II (Poly 5)",
  help: "The flagship ambient pad, rebuilt from Smashed Transistors' 140-object ToTheStarsII.axp: two six-segment oscillators whose SIX WAVEFORM LEVELS are live signals — three sampled randoms and three phases of a sixteen-second LFO — through two banks of three cascaded ZDF bandpasses, into a pair of allpass-noodle reverbs whose read points are moved by twelve LFOs in six chains. Turn the four Resonance knobs while it plays.",
  source: {
    patch: "axoloti-contrib patches/tiar/synths/ToTheStarsII.axp", file: "ToTheStarsII.axp",
    author: "Smashed Transistors (tiar)", popularity: "contrib @ 1.0.12 (798166f) — the largest object count in the Axoloti half of the survey",
    distinct: 38, dsp: 21, objects: 140, poly: 5,
    families: ["plate/allpass reverb", "ZDF filter bank", "segment-level wavetable", "polyphony"],
  },
  deviations: [
    "POLY 5 IS AN ALLOCATOR NODE — see this file's POLYPHONY header. The voice graph is drawn once as the template.",
    "PER-NOTE MPE PRESSURE (`midi/in/keyb touch`'s `touch` outlet) IS SUBSTITUTED BY THE ALLOCATOR'S `velocity`, because the yielded `audio_ax_poly_voices` port list carries no `touch` (core/audio_stubs_axo_reverb.js says why and what the lead should decide). Structurally the graph is unchanged — `max(channelPressure, perNoteTerm x pressureEnvelope)` — and velocity is per-note and dynamic, so the `max` stays meaningful rather than degenerating; but it is struck-once rather than continuous, so the pad no longer swells under your finger. `midi/in/touch` (channel pressure) IS ported, as `audio_ax_midi_touch`.",
    "EACH REVERB CHANNEL'S 341 ms SDRAM LINE IS DRAWN AS TWO `audio_delay` SEGMENTS SUMMING TO THE AUTHORED READ POINT — forced by the measured one-delay-loop refusal (this file's FEEDBACK header) and exact, since the modulation rides the first segment's time.",
    "`delay/write sdram` + `delay/read` substituted by one `audio_delay` per TAP. A write with N reads at different times is N delay lines fed from one source, which is the same thing; here N is 1 per channel.",
    "`mix/mix 4` HAS FIVE INPUTS (a unity bus plus four weighted) and `audio_mixer` has four, so each filter bank sums through TWO mixers — the four taps in `<side>Bank`, the dry bus added in `<side>Dry`.",
    "`lfo/square` -> `logic/latch.trig` needs an EDGE, and there is no audio->trigger coercion (deliberately, per core/nodeflow.js: turning a signal into events is a real operation with a real hysteresis parameter). So each of the three sample-and-hold clocks gains an `audio_trigger`, which is the same repair SEQUENCED_DINGS documents. Axoloti's `bool32.rising` inlet does this inside the object.",
    "`ctrl/dial p` x4 substituted by `node_knob` — a hardware panel dial IS a knob, and this makes the four Resonance controls playable instead of frozen. `midi/in/cc` (cc 7, the master volume) substituted the same way, so its `math/*` squaring law survives with a knob behind it.",
    "`sss/gain/vcaST` substituted by TWO `audio_vca` sharing one gain wire — a stereo VCA with one control input is exactly that. Applies to both the voice's output stage and the master.",
    "`env/adsr` substituted by `audio_adsr`, dials converted by UNITS law 4. `kfilter/lowpass` is the shipped `audio_ax_kfilter_lowpass` with rise = decay. `math/smooth`, `logic/latch`, `rand/uniform f`, `filter/hp1`, `filter/lp1` and `tiar/filter/ZDF SVF 1` are all shipped nodes.",
    "DROPPED AFTER TRACING `<nets>`, not assumed: `triphase_vlfo_1` (1.5 s) and `triphase_vlfo_2` (1.315 s) are WIRED TO NOTHING in the source — the survey's \"19 LFOs, keep them all\" counts them, and two of the five tri-phase LFOs are dead. `patcher_1/*c_1` (amp 0.505) has no consumer either, and `patcher_1/dial_1` -> `math/-` is a dead pair (its output goes nowhere). Also dropped: `disp/dial b` x3, `disp/dial p`, `tiar/disp/scope` (displays), `midi/in/pgm` + `patch/load i` (preset recall), and the ten `patch/inlet f` / two `patch/outlet a` that vanish when a subpatch is inlined.",
    "AUTOPLAY (§ R7-AUDIBLE, the THIRD way; four `ap*` nodes — the cheapest branch in this file). Measured before: −inf dBFS; after: −24.7 dBFS, peak −3.4. `audio_ax_6coseg` is a placeholder and it is the ONLY hole between the note and the tail — `stereoL`/`stereoR`, both voice VCAs, both voice gains, the three-way split and the entire twelve-filter/six-allpass ZDF bank are shipped nodes idling for want of a signal. So two `audio_ax_osc` at the harvested detunings (−0.01 / +0.01 semitones) enter through those two pan mixers' FREE `in3`/`in4`, at gains mirroring `level1`/`level2` so the substitutes are panned against each other the way the pair they stand in for is. A SAW AND A PULSE ARE A COARSE STAND-IN for a six-segment cosine table and are not claimed otherwise; what survives exactly is the pitch, the pan and everything downstream. THE TWO REVERB TANKS STILL DO NOT SOUND: the authored route out runs `vcaML`/`vcaMR`, whose gain is a `node_knob` squared and a control widget's wire is dropped by `readAudioScene`, so the master VCA is shut at `gain: 0`; and past it sits `audio_ax_dpsoftclip`, a placeholder. The branch therefore leaves from `lDry`/`rDry` — the filter banks' own outputs — into the summing mixer's free inputs, at 0.4 rather than the file's shared 0.8 because this patch's own voice gains put the same branch 2.6 dB hotter than C1's, over the probe's clip bar. Nothing harvested is rewired.",
    "The stereo pair is summed to one mono analysis tail, because a patch here must end at `audio_output` with a meter and a spectrum.",
  ],
  nodes: [
    // ── THE VOICE (poly 5), drawn once ──────────────────────────────────────
    { id: "poly", type: "audio_ax_poly_voices", col: 0, row: 0, knobs: { voices: 5 } },
    { id: "touchIn", type: "audio_ax_midi_touch", col: 0, row: 1 },
    { id: "vibLfo", type: "audio_ax_lfo", col: 0, row: 2, knobs: { pitch: 2.84, waveform: "sine" } },
    // THE THREE SAMPLE-AND-HOLD CLOCKS, at three unrelated rates.
    { id: "segClk0", type: "audio_ax_lfo", col: 0, row: 3, knobs: { pitch: -58, waveform: "square" } },
    { id: "segRnd0", type: "audio_ax_rand", col: 0, row: 4, knobs: { mode: "free" } },
    { id: "segClk1", type: "audio_ax_lfo", col: 0, row: 5, knobs: { pitch: -53.35, waveform: "square" } },
    { id: "segRnd1", type: "audio_ax_rand", col: 0, row: 6, knobs: { mode: "free" } },
    { id: "segClk2", type: "audio_ax_lfo", col: 0, row: 7, knobs: { pitch: -59.2, waveform: "square" } },
    { id: "segRnd2", type: "audio_ax_rand", col: 0, row: 8, knobs: { mode: "free" } },
    // THE THREE TRI-PHASE LFOs THAT ARE ACTUALLY WIRED (two more exist in the source and
    // are connected to nothing — see the deviations).
    { id: "segRot", type: "audio_ax_triphase_lfo", col: 0, row: 9, knobs: { cycle: 16 } },
    { id: "resRot", type: "audio_ax_triphase_lfo", col: 0, row: 10, knobs: { cycle: 16.34 } },
    { id: "res2Rot", type: "audio_ax_triphase_lfo", col: 0, row: 11, knobs: { cycle: 15.355 } },
    // THE FOUR RESONANCE DIALS — `ctrl/dial p`, i.e. knobs on his hardware panel. The two
    // pairs are deliberately a hundredth apart, which is what stops the two oscillators'
    // resonances from moving as one.
    { id: "resKnob0", type: "node_knob", col: 0, row: 12, knobs: { value: 0.09375, min: 0, max: 1, step: 0.001 } },
    { id: "resKnob1", type: "node_knob", col: 0, row: 13, knobs: { value: 0.09391, min: 0, max: 1, step: 0.001 } },
    { id: "res2Knob0", type: "node_knob", col: 0, row: 14, knobs: { value: 0.9059, min: 0, max: 1, step: 0.001 } },
    { id: "res2Knob1", type: "node_knob", col: 0, row: 15, knobs: { value: 0.8984, min: 0, max: 1, step: 0.001 } },

    // adsr_2 (a −54, d 0, s 64, r 1) — the PRESSURE envelope: 4 ms in, holds at full.
    { id: "pressEnv", type: "audio_adsr", col: 1, row: 0, knobs: { attack: 0.00429, decay: 0.09708, sustain: 1, release: 0.1029 } },
    // adsr_1 (a −17, d 43, s 39, r −5) — the AMPLITUDE envelope, parent-overridden.
    { id: "ampEnv", type: "audio_adsr", col: 1, row: 1, knobs: { attack: 0.03636, decay: 1.164, sustain: 0.6094, release: 0.07273 } },
    { id: "segEdge0", type: "audio_trigger", col: 1, row: 2, knobs: { pulseMs: 5 } },
    { id: "segEdge1", type: "audio_trigger", col: 1, row: 3, knobs: { pulseMs: 5 } },
    { id: "segEdge2", type: "audio_trigger", col: 1, row: 4, knobs: { pulseMs: 5 } },
    // mix/mix 1 x4: a dial plus one phase of a very slow LFO -> a resonance inlet.
    { id: "resMix0", type: "audio_mixer", col: 1, row: 5, knobs: { level1: 0.0903, level2: 1, master: 1 } },
    { id: "resMix1", type: "audio_mixer", col: 1, row: 6, knobs: { level1: 0.0902, level2: 1, master: 1 } },
    { id: "res2Mix0", type: "audio_mixer", col: 1, row: 7, knobs: { level1: 0.0838, level2: 1, master: 1 } },
    { id: "res2Mix1", type: "audio_mixer", col: 1, row: 8, knobs: { level1: 0.0896, level2: 1, master: 1 } },

    // *_1: the per-note dynamic term x the pressure envelope (velocity substituted for touch).
    { id: "touchGate", type: "audio_ax_math", col: 2, row: 0, knobs: { operation: "multiply", b: 0 } },
    { id: "segHold0", type: "audio_ax_latch", col: 2, row: 1 },
    { id: "segHold1", type: "audio_ax_latch", col: 2, row: 2 },
    { id: "segHold2", type: "audio_ax_latch", col: 2, row: 3 },

    // max_1: channel pressure OR the per-note term, whichever is greater — an MPE pressure
    // path with an envelope floor, so a note played very softly still speaks.
    { id: "pressMax", type: "audio_ax_math", col: 3, row: 0, knobs: { operation: "maximum", b: 0 } },
    // math/smooth at 62.5/62/63 on a 0…64 dial: time constants of about a second, which is
    // what turns a sampled random STEP into a waveform that MORPHS.
    { id: "segSmooth0", type: "audio_ax_smooth", col: 3, row: 1, knobs: { time: 62.5 } },
    { id: "segSmooth1", type: "audio_ax_smooth", col: 3, row: 2, knobs: { time: 62 } },
    { id: "segSmooth2", type: "audio_ax_smooth", col: 3, row: 3, knobs: { time: 63 } },

    { id: "pressSmooth", type: "audio_ax_kfilter_lowpass", col: 4, row: 0, knobs: { rise: 0, decay: 0 } },
    // *_3: the smoothed pressure SQUARED, so vibrato depth grows faster than pressure does.
    { id: "vibSquare", type: "audio_ax_math", col: 5, row: 0, knobs: { operation: "multiply", b: 0 } },
    { id: "vibDepth", type: "audio_ax_math", col: 6, row: 0, knobs: { operation: "multiply", b: 0 } },
    // mix/mix 1 (bus_in = note, gain1 0.33): note + 0.33 SEMITONES of vibrato (UNITS law 3).
    { id: "notePitch", type: "audio_mixer", col: 7, row: 0, knobs: { level1: 1, level2: 0.33, master: 1 } },
    { id: "osc0", type: "audio_ax_6coseg", col: 8, row: 0, knobs: { pitch: -0.01 } },
    { id: "osc1", type: "audio_ax_6coseg", col: 8, row: 1, knobs: { pitch: 0.01 } },
    // mix/mix 2 x2 at 48/24.5 and 24/48 — the two oscillators panned against each other.
    // `level3`/`level4` MIRROR `level1`/`level2` — they carry the AUTOPLAY substitutes for
    // the two placeholder oscillators, so the pair must be panned the same way the pair
    // they stand in for is. Nothing harvested moves; these two inputs had no wire.
    { id: "stereoL", type: "audio_mixer", col: 9, row: 0, knobs: { level1: 0.75, level2: 0.3828, level3: 0.75, level4: 0.3828, master: 1 } },
    { id: "stereoR", type: "audio_mixer", col: 9, row: 1, knobs: { level1: 0.375, level2: 0.75, level3: 0.375, level4: 0.75, master: 1 } },
    { id: "ampMax", type: "audio_ax_math", col: 9, row: 2, knobs: { operation: "maximum", b: 0 } },
    { id: "vcaL", type: "audio_vca", col: 10, row: 0, knobs: { gain: 0 } },
    { id: "vcaR", type: "audio_vca", col: 10, row: 1, knobs: { gain: 0 } },
    { id: "voiceGainL", type: "audio_ax_math", col: 11, row: 0, knobs: { operation: "attenuate", b: 10 } },
    { id: "voiceGainR", type: "audio_ax_math", col: 11, row: 1, knobs: { operation: "attenuate", b: 12 } },
    // THE SPLIT: the left channel is highpassed into its bank, the right is highpassed into
    // its own AND lowpassed to make the DRY bus both banks share.
    { id: "splitHpL", type: "audio_ax_onepole", col: 12, row: 0, knobs: { mode: "highpass", pitch: -17 } },
    { id: "splitHpR", type: "audio_ax_onepole", col: 12, row: 1, knobs: { mode: "highpass", pitch: -17 } },
    { id: "splitLpR", type: "audio_ax_onepole", col: 12, row: 2, knobs: { mode: "lowpass", pitch: -17 } },

    ...C3_BANKS.flatMap((bank) => bank.nodes),

    // ── THE MASTER VOLUME, squared exactly as his CC is ──────────────────────
    { id: "volKnob", type: "node_knob", col: 18, row: 8, knobs: { value: 0.64, min: 0, max: 1, step: 0.01 } },
    { id: "volSq", type: "audio_ax_math", col: 19, row: 8, knobs: { operation: "multiply", b: 0 } },
    { id: "vcaML", type: "audio_vca", col: 20, row: 0, knobs: { gain: 0 } },
    { id: "vcaMR", type: "audio_vca", col: 20, row: 1, knobs: { gain: 0 } },

    ...C3_REVERBS.flatMap((channel) => channel.nodes),
    ...stereoTail(24, 0, C3_AUTOPLAY_RETURN_LEVEL),
    ...AXO_TO_THE_STARS_AUTOPLAY.nodes,
  ],
  wires: [
    // ── THE VOICE ───────────────────────────────────────────────────────────
    { from: "poly", fromPort: "gate", to: "pressEnv", toPort: "gate" },
    { from: "poly", fromPort: "gate", to: "ampEnv", toPort: "gate" },
    { from: "poly", fromPort: "velocity", to: "touchGate", toPort: "a" },
    { from: "pressEnv", fromPort: "out", to: "touchGate", toPort: "b" },
    { from: "touchIn", fromPort: "o", to: "pressMax", toPort: "a" },
    { from: "touchGate", fromPort: "out", to: "pressMax", toPort: "b" },
    { from: "pressMax", fromPort: "out", to: "pressSmooth", toPort: "in" },
    { from: "pressSmooth", fromPort: "out", to: "vibSquare", toPort: "a" },
    { from: "pressSmooth", fromPort: "out", to: "vibSquare", toPort: "b" },
    { from: "vibLfo", fromPort: "out", to: "vibDepth", toPort: "a" },
    { from: "vibSquare", fromPort: "out", to: "vibDepth", toPort: "b" },
    { from: "poly", fromPort: "note", to: "notePitch", toPort: "in1" },
    { from: "vibDepth", fromPort: "out", to: "notePitch", toPort: "in2" },
    { from: "notePitch", fromPort: "out", to: "osc0", toPort: "pitch" },
    { from: "notePitch", fromPort: "out", to: "osc1", toPort: "pitch" },

    // ── THE SIX SEGMENT LEVELS: three sampled randoms, three rotating phases ─
    { from: "segClk0", fromPort: "out", to: "segEdge0", toPort: "in" },
    { from: "segEdge0", fromPort: "out", to: "segHold0", toPort: "trig" },
    { from: "segRnd0", fromPort: "out", to: "segHold0", toPort: "in" },
    { from: "segHold0", fromPort: "out", to: "segSmooth0", toPort: "in" },
    { from: "segClk1", fromPort: "out", to: "segEdge1", toPort: "in" },
    { from: "segEdge1", fromPort: "out", to: "segHold1", toPort: "trig" },
    { from: "segRnd1", fromPort: "out", to: "segHold1", toPort: "in" },
    { from: "segHold1", fromPort: "out", to: "segSmooth1", toPort: "in" },
    { from: "segClk2", fromPort: "out", to: "segEdge2", toPort: "in" },
    { from: "segEdge2", fromPort: "out", to: "segHold2", toPort: "trig" },
    { from: "segRnd2", fromPort: "out", to: "segHold2", toPort: "in" },
    { from: "segHold2", fromPort: "out", to: "segSmooth2", toPort: "in" },
    // l0 and l2 go to BOTH oscillators; l4/l5 are SWAPPED between them, which is the
    // asymmetry that decorrelates the pair.
    { from: "segSmooth0", fromPort: "out", to: "osc0", toPort: "l0" },
    { from: "segSmooth0", fromPort: "out", to: "osc1", toPort: "l0" },
    { from: "segSmooth2", fromPort: "out", to: "osc0", toPort: "l2" },
    { from: "segSmooth2", fromPort: "out", to: "osc1", toPort: "l2" },
    { from: "segSmooth1", fromPort: "out", to: "osc0", toPort: "l4" },
    { from: "segSmooth1", fromPort: "out", to: "osc1", toPort: "l5" },
    { from: "segRot", fromPort: "phi_0", to: "osc0", toPort: "l1" },
    { from: "segRot", fromPort: "phi_0", to: "osc1", toPort: "l1" },
    { from: "segRot", fromPort: "phi_120", to: "osc0", toPort: "l3" },
    { from: "segRot", fromPort: "phi_120", to: "osc1", toPort: "l3" },
    { from: "segRot", fromPort: "phi_240", to: "osc0", toPort: "l5" },
    { from: "segRot", fromPort: "phi_240", to: "osc1", toPort: "l4" },

    // ── THE THREE RESONANCES: two shared, the third fed SEPARATELY per oscillator ──
    { from: "resKnob0", fromPort: "out", to: "resMix0", toPort: "in2" },
    { from: "resRot", fromPort: "phi_0", to: "resMix0", toPort: "in1" },
    { from: "resKnob1", fromPort: "out", to: "resMix1", toPort: "in2" },
    { from: "resRot", fromPort: "phi_120", to: "resMix1", toPort: "in1" },
    { from: "resMix0", fromPort: "out", to: "osc0", toPort: "r0" },
    { from: "resMix0", fromPort: "out", to: "osc1", toPort: "r0" },
    { from: "resMix1", fromPort: "out", to: "osc0", toPort: "r1" },
    { from: "resMix1", fromPort: "out", to: "osc1", toPort: "r1" },
    { from: "res2Knob0", fromPort: "out", to: "res2Mix0", toPort: "in2" },
    { from: "res2Rot", fromPort: "phi_0", to: "res2Mix0", toPort: "in1" },
    { from: "res2Knob1", fromPort: "out", to: "res2Mix1", toPort: "in2" },
    { from: "res2Rot", fromPort: "phi_240", to: "res2Mix1", toPort: "in1" },
    { from: "res2Mix0", fromPort: "out", to: "osc0", toPort: "r2" },
    { from: "res2Mix1", fromPort: "out", to: "osc1", toPort: "r2" },

    // ── THE STEREO PAIR AND ITS GAIN STAGE ──────────────────────────────────
    { from: "osc0", fromPort: "wave", to: "stereoL", toPort: "in1" },
    { from: "osc1", fromPort: "wave", to: "stereoL", toPort: "in2" },
    { from: "osc0", fromPort: "wave", to: "stereoR", toPort: "in1" },
    { from: "osc1", fromPort: "wave", to: "stereoR", toPort: "in2" },
    { from: "ampEnv", fromPort: "out", to: "ampMax", toPort: "a" },
    { from: "touchGate", fromPort: "out", to: "ampMax", toPort: "b" },
    { from: "stereoL", fromPort: "out", to: "vcaL", toPort: "in" },
    { from: "stereoR", fromPort: "out", to: "vcaR", toPort: "in" },
    { from: "ampMax", fromPort: "out", to: "vcaL", toPort: "gain" },
    { from: "ampMax", fromPort: "out", to: "vcaR", toPort: "gain" },
    { from: "vcaL", fromPort: "out", to: "voiceGainL", toPort: "a" },
    { from: "vcaR", fromPort: "out", to: "voiceGainR", toPort: "a" },
    { from: "voiceGainL", fromPort: "out", to: "splitHpL", toPort: "in" },
    { from: "voiceGainR", fromPort: "out", to: "splitHpR", toPort: "in" },
    { from: "voiceGainR", fromPort: "out", to: "splitLpR", toPort: "in" },

    ...C3_BANKS.flatMap((bank) => bank.wires),

    // ── THE MASTER: his CC squared, here a knob squared ──────────────────────
    { from: "volKnob", fromPort: "out", to: "volSq", toPort: "a" },
    { from: "volKnob", fromPort: "out", to: "volSq", toPort: "b" },
    { from: "lDry", fromPort: "out", to: "vcaML", toPort: "in" },
    { from: "rDry", fromPort: "out", to: "vcaMR", toPort: "in" },
    { from: "volSq", fromPort: "out", to: "vcaML", toPort: "gain" },
    { from: "volSq", fromPort: "out", to: "vcaMR", toPort: "gain" },

    ...C3_REVERBS.flatMap((channel) => channel.wires),
    ...stereoTailWires({ item: "lClip", port: "out" }, { item: "rClip", port: "out" }),
    ...AXO_TO_THE_STARS_AUTOPLAY.wires,
  ],
};

/** C7's plate tank lives in ONE column — the two tanks are CROSS-COUPLED, so every node in
 *  either of them is in a loop with every node in the other, and a loop has no
 *  left-to-right order (see AXO_SHIMMER's layout note). */
const C7_TANK_COL = 28;

/**
 * Pure function. One of C7's four cross-coupled plate taps: an SDRAM read, a one-pole
 * highpass, a one-pole lowpass, back into the OTHER tank's input mixer.
 *
 * WRITTEN ONCE FOR ALL FOUR because they are the same four nodes with four different sets
 * of numbers, and those numbers ARE the plate — a Dattorro tank is a table of mutually
 * prime lengths, so seeing them in one table is how you check them.
 *
 * @param {string} id - the tap's name; its nodes are `<id>a`, `<id>b`, `<id>Hp`, `<id>Lp`
 * @param {number} row - grid row of the first node; the tap occupies four rows
 * @param {object} cfg - `{source, seconds, hp, lp, to}` — the tank output being read, the
 *   authored read point in seconds, the two filter pitches, and `{item, port}` it returns to
 * @returns {{nodes: object[], wires: object[]}}
 *
 * @example plateTap("tap2", 8, C7_TAPS[0]).nodes.length // 4
 * @example plateTap("tap2", 8, C7_TAPS[0]).nodes.map((n) => n.row) // [8, 9, 10, 11]
 */
function plateTap(id, row, cfg) {
  return {
    nodes: [
      ...delayPair(id, C7_TANK_COL, row, cfg.seconds),
      { id: `${id}Hp`, type: "audio_ax_onepole", col: C7_TANK_COL, row: row + 2, knobs: { mode: "highpass", pitch: cfg.hp } },
      { id: `${id}Lp`, type: "audio_ax_onepole", col: C7_TANK_COL, row: row + 3, knobs: { mode: "lowpass", pitch: cfg.lp } },
    ],
    wires: [
      ...delayPairWires(id, { item: cfg.source, port: "out" }, { item: `${id}Hp`, port: "in" }),
      { from: `${id}Hp`, fromPort: "out", to: `${id}Lp`, toPort: "in" },
      { from: `${id}Lp`, fromPort: "out", to: cfg.to.item, toPort: cfg.to.port },
    ],
  };
}

/**
 * C7's four plate taps, as one table. Each read is `dial/64 x 682 ms` (UNITS law 5) and each
 * returns to the OTHER tank's input mixer — that cross-coupling is what makes two tanks one
 * plate rather than two reverbs. `tankA` writes the line `tap5`/`tap3` read; `tankB` writes
 * the one `tap2`/`tap4` read.
 */
const C7_TAPS = [
  { id: "tap2", row: 8, source: "apB2", seconds: 0.6347, hp: 12, lp: 45, to: { item: "mixA", port: "in2" } },
  { id: "tap5", row: 12, source: "apA2", seconds: 0.4427, hp: -9, lp: 54, to: { item: "mixA", port: "in3" } },
  { id: "tap3", row: 16, source: "apA2", seconds: 0.5813, hp: 14, lp: 48, to: { item: "mixB", port: "in2" } },
  { id: "tap4", row: 20, source: "apB2", seconds: 0.3787, hp: 2, lp: 56, to: { item: "mixB", port: "in3" } },
];

const C7_TAP_PARTS = C7_TAPS.map((cfg) => plateTap(cfg.id, cfg.row, cfg));

/**
 * C7 — 091-PAD 3: an eight-voice MPE pad into a Dattorro plate reverb built out of
 * primitives. There is NO reverb object in it, which is exactly why it is in the set.
 *
 * ── WHAT THE REVERB SUBPATCH ACTUALLY CONTAINS ──────────────────────────────
 * Eleven allpasses, two 682 ms SDRAM tanks, four cross-coupled taps, six one-pole
 * lowpasses, five one-pole highpasses and TWO CHORUS UNITS INSIDE the feedback path. The
 * input is bandlimited, diffused by three short allpasses (62 / 146 / 315 samples — mutually
 * prime, which is the whole trick), then SPLIT: one branch chorused straight into the tanks,
 * the other through two more allpasses and a second chorus that is added at the OUTPUT. Each
 * tank is three long allpasses (2364 / 1116 / 587 and 2057 / 1105 / 619) writing a delay line
 * the OTHER tank reads twice, filtered on the way back.
 *
 * ── THE VOICE, AND WHY ITS THIRD SAW IS WIRED DIFFERENTLY ───────────────────
 * Three phase-distortion saws at 0 / +0.02 / −0.0488 semitones. TWO of them are summed and
 * gated by the smoothed MPE pressure; the THIRD goes straight to the filter bus, so a note
 * held at zero pressure still speaks and pressing adds the detuned pair. The cutoff is the
 * note plus 61.5 SEMITONES of pressure — five octaves — which is the patch's whole gesture.
 *
 * ── THE RING MODULATOR IS THE PERFORMANCE CONTROL ───────────────────────────
 * One knob (his CC 113) does two things through one smoother: it sweeps the ring
 * modulator's carrier an octave and a fifth (19 semitones, and his own comment says so),
 * AND it crossfades the ring-modulated signal in. Both knobs start where he left them —
 * at zero — so turn Ring and Mod to hear what they do.
 */
/** C7's autoplay return level, and it is ABOVE unity where C1's and C3's are well
 *  under. Nothing arbitrary in that: C7's branch is the only one that passes through a
 *  whole Dattorro plate before the tail — four `audio_delay` taps, six allpasses and two
 *  one-pole pairs — and a diffuser network is lossy by construction. Measured at 0.6 it
 *  peaked at −11.2 dBFS; 1.2 puts it beside the other two. */
const C7_AUTOPLAY_RETURN_LEVEL = 1.2;

/** C7's first free row — its voice and its plate fill rows 0-8, and only the tank column
 *  goes deeper. */
const C7_AUTOPLAY_ROW = 9;

/** C7's autoplay note rate. An eight-voice MPE pad with a 1.2 s decay and a 0.27 s
 *  release: a note every three seconds leaves the plate audibly ringing between them,
 *  which is the point of putting a Dattorro plate behind it. */
const C7_AUTOPLAY_HZ = 0.33;

/**
 * C7's AUTOPLAY BRANCH — § R7-AUDIBLE's third way.
 *
 * ── THE HOLE IS THE OSCILLATOR TRIO, AND ONLY THAT ─────────────────────────
 * `audio_ax_dp2saw` is a placeholder, so `saw0`/`saw1`/`saw2` are dead and everything
 * behind them idles: `filtBus`, the vcf3, both voice VCAs (whose gains come from the now
 * shipped `audio_adsr` pair), the voice gain, and the entire plate. Three `audio_ax_osc`
 * at the harvested detunings (0, +0.02, −0.0488 semitones — the two-and-five-cent spread
 * that makes this a pad rather than one saw) sum into `filtBus`'s free `in3`, so the
 * substitutes are filtered and enveloped by the patch's own stage.
 *
 * ── AND THE PLATE HAS TO BE FED AND TAPPED AROUND TWO PLACEHOLDERS ─────────
 * The authored route into the tank runs `xfade` → `dphardclip` → the input diffusers, and
 * the clipper is a placeholder, so `voiceGain` fans out to the tank mixers' FREE `in4`
 * instead — one wire per side, entering the plate exactly where the diffuser chain would
 * have delivered it. Coming back, the authored route runs `vcaOutL`/`vcaOutR`, whose gain
 * is a `node_knob` and therefore a dropped wire, leaving them shut at `gain: 0`; so the
 * tank's own `outMixA`/`outMixB` fan out to the summing mixer's free inputs. Both are
 * additions, neither displaces a harvested wire, and both delete cleanly when
 * `audio_ax_dphardclip` and a playable volume land.
 */
const AXO_PAD3_PLATE_AUTOPLAY = (() => {
  const clock = autoPolyClock(C7_AUTOPLAY_ROW, C7_AUTOPLAY_HZ);
  const saws = [
    { id: "apSaw0", pitch: 0 }, { id: "apSaw1", pitch: 0.02 }, { id: "apSaw2", pitch: -0.0488 },
  ];
  return {
    nodes: [
      ...clock.nodes,
      ...saws.map((v, i) => ({ id: v.id, type: "audio_ax_osc", col: 10, row: C7_AUTOPLAY_ROW + i, knobs: { waveform: "saw", pitch: v.pitch } })),
      { id: "apSawMix", type: "audio_mixer", col: 11, row: C7_AUTOPLAY_ROW, knobs: { level1: 1, level2: 1, level3: 1, master: 1 } },
    ],
    wires: [
      ...clock.wires,
      ...saws.map((v) => ({ from: "notePitch", fromPort: "out", to: v.id, toPort: "pitch" })),
      ...saws.map((v, i) => ({ from: v.id, fromPort: "out", to: "apSawMix", toPort: `in${i + 1}` })),
      { from: "apSawMix", fromPort: "out", to: "filtBus", toPort: "in3" },
      { from: "voiceGain", fromPort: "out", to: "mixA", toPort: "in4" },
      { from: "voiceGain", fromPort: "out", to: "mixB", toPort: "in4" },
      { from: "outMixA", fromPort: "out", to: "sum", toPort: "in3" },
      { from: "outMixB", fromPort: "out", to: "sum", toPort: "in4" },
    ],
  };
})();

export const AXO_PAD3_PLATE = {
  id: "axo-pad3-plate",
  title: "Axoloti Pad 3 Plate (Poly 8)",
  help: "An eight-voice MPE pad into a Dattorro plate reverb built from PRIMITIVES — eleven allpasses, two 682 ms tanks, four cross-coupled taps and two chorus units inside the feedback path, with no reverb module anywhere. Three phase-distortion saws, cutoff swept five octaves by pressure. Turn the RING knob for an octave-and-a-fifth ring modulator that crossfades itself in.",
  source: {
    patch: "axoloti-contrib patches/tiar/synths/091-Pad 3 (polysynth)-tiar.axp", file: "091-Pad 3 (polysynth)-tiar.axp",
    author: "Smashed Transistors (tiar)", popularity: "contrib @ 1.0.12 (798166f) — the corpus' reference hand-built plate",
    distinct: 39, dsp: 22, objects: 88, poly: 8,
    families: ["plate reverb from primitives", "polyphony", "phase distortion", "ring modulation"],
  },
  deviations: [
    "POLY 8 IS AN ALLOCATOR NODE — see this file's POLYPHONY header. The voice graph is drawn once as its template.",
    "PER-NOTE MPE PRESSURE SUBSTITUTED BY THE ALLOCATOR'S `velocity`, exactly as in C3 and for the same reason (the yielded port list carries no `touch`). `midi/in/touch` (channel pressure) IS ported as `audio_ax_midi_touch`, so the `max(channel, perNote x envelope)` structure survives.",
    "EVERY DELAY IN THE PLATE IS DRAWN AS TWO `audio_delay` SEGMENTS SUMMING TO THE AUTHORED READ POINT — forced by the measured one-delay-loop refusal (this file's FEEDBACK header) and exact.",
    "`delay/write sdram` + `delay/read` substituted by ONE `audio_delay` PER TAP. Each 682 ms line is read TWICE at different times, and two lines of different lengths fed from one source are the same signal as one line with two taps — which is also the only way to say it, since our delay has one output.",
    "THE 61.5-SEMITONE PRESSURE-TO-CUTOFF DEPTH NEEDS TWO `multiply` STAGES: `mix/mix 1`'s gain is 61.5 into a pitch inlet (UNITS law 3), and our `audio_mixer` level tops out at 2 while `audio_ax_math`'s b tops out at 16. 16 x 3.844 = 61.504, four thousandths of a semitone from the authored value. The 19-semitone ring-mod sweep needs one stage plus a mixer level of 1.1875, which is exact.",
    "`midi/in/cc` x3 substituted by `node_knob`: cc 1 (the mod wheel into vibrato depth), cc 113 (the ring modulator) and cc 7 (master volume). All three start at HIS default — 0, 0 and 82/127 — so the patch arrives exactly as authored and the two performance controls are playable rather than frozen.",
    "`sss/gain/vcaST` substituted by TWO `audio_vca` sharing one gain wire; `gain/vca` x2 by `audio_vca`; `mix/mix N` by `audio_mixer`; `env/adsr` by `audio_adsr` with dials converted by UNITS law 4; `filter/lp1`/`hp1` by `audio_ax_onepole`; `math/*`, `math/+`, `math/+c`, `math/gain`, `math/sat`, `math/max` and `tiar/math/DP *` all by `audio_ax_math` (its `ringModAntialiased` operation IS `DP *`); `filter/vcf3` and `tiar/kfilter/LPRiseDecay` are shipped nodes.",
    "DROPPED AFTER TRACING `<nets>`: the voice's `patch/inlet f` named `pitch` has NO source at root, so `mix_3.in2` (gain 7.0) is fed by nothing and both go. Also `disp/dial p` (a display), `midi/in/pgm` + `patch/load i` (preset recall) and the subpatch boundary inlets/outlets that vanish when a subpatch is inlined.",
    "ONE `math/*c` IS `multiply`, NOT `attenuate`: the voice's output gain is dial 21.5, and `attenuate`'s b IS the dial while `audio_ax_math`'s b range stops at ±16 (Axoloti's goes to 64). Transcribed as `multiply` with 21.5/64 = 0.3359 — identical arithmetic. That range is a real defect in AX_MATH_SPEC and is reported to the lead.",
    "SURVEY CORRECTION: § 2 C7 calls the four taps \"modulated\". They are not — all four `delay/read` objects carry a fixed `time` param and no wire. The modulation in this reverb is the two `fx/chorus` units, which is a different and more interesting thing.",
    "AUTOPLAY (§ R7-AUDIBLE, the THIRD way; six `ap*` nodes). Measured before: −inf dBFS; after: −23.9 dBFS, peak −5.2. `audio_ax_dp2saw` is a placeholder, so `saw0`/`saw1`/`saw2` are the hole and everything behind them idles — `filtBus`, the vcf3, both voice VCAs, the voice gain, and the entire Dattorro plate. Three `audio_ax_osc` at the harvested detunings (0 / +0.02 / −0.0488 semitones, the two-and-five-cent spread that makes this a pad and not one saw) sum into `filtBus`'s free `in3`, so the substitutes are filtered and enveloped by the patch's own stage. THE PLATE IS FED AND TAPPED AROUND TWO PLACEHOLDERS, both by addition and neither by displacing a harvested wire: the authored way IN runs `xfade` → `audio_ax_dphardclip`, so `voiceGain` fans out to the tank mixers' free `in4` at the same gain `level1` gives the authored input tap; the authored way OUT runs `vcaOutL`/`vcaOutR`, whose gain is a `node_knob` and therefore a wire `readAudioScene` drops, leaving them shut at `gain: 0`, so `outMixA`/`outMixB` fan out to the summing mixer's free inputs. THIS BRANCH RETURNS ABOVE UNITY (1.2) where C1's and C3's are well under, and the reason is measured rather than tuned: it is the only one that crosses a whole diffuser network — four delay taps, six allpasses, two one-pole pairs — and diffusion is lossy by construction. It is also the patch that exposed the 100 ms gate: at the ported patches' 5 ms Schmitt its `audio_adsr` decayed monotonically to −100 dBFS and never retriggered, costing 30 dB.",
    "The stereo pair is summed to one mono analysis tail, because a patch here must end at `audio_output` with a meter and a spectrum.",
  ],
  nodes: [
    // ── THE VOICE (poly 8) AND THE THREE PERFORMANCE KNOBS ──────────────────
    { id: "poly", type: "audio_ax_poly_voices", col: 0, row: 0, knobs: { voices: 8 } },
    { id: "touchIn", type: "audio_ax_midi_touch", col: 0, row: 1 },
    // mix/mix 3 at 64 / 16.525 / 7 — three vibrato LFOs at unrelated rates, the fastest
    // barely a tremolo and the third BELOW one hertz.
    { id: "vibLfo0", type: "audio_ax_lfo", col: 0, row: 2, knobs: { pitch: 1, waveform: "sine" } },
    { id: "vibLfo1", type: "audio_ax_lfo", col: 0, row: 3, knobs: { pitch: 10.91, waveform: "sine" } },
    { id: "vibLfo2", type: "audio_ax_lfo", col: 0, row: 4, knobs: { pitch: -17.9, waveform: "sine" } },
    { id: "modKnob", type: "node_knob", col: 0, row: 5, knobs: { value: 0, min: 0, max: 1, step: 0.01 } },
    { id: "ringKnob", type: "node_knob", col: 0, row: 6, knobs: { value: 0, min: 0, max: 1, step: 0.01 } },
    { id: "volKnob", type: "node_knob", col: 0, row: 7, knobs: { value: 0.65, min: 0, max: 1, step: 0.01 } },
    // THE ROOT KEYBOARD, which is NOT the voice's: it tracks the played note for the ring
    // modulator's carrier, mono, outside the poly patcher.
    { id: "rootKeyb", type: "audio_ax_keyb", col: 0, row: 8 },

    { id: "ampEnv", type: "audio_adsr", col: 1, row: 0, knobs: { attack: 0.03058, decay: 1.233, sustain: 0.5313, release: 0.2746 } },
    { id: "pressEnv", type: "audio_adsr", col: 1, row: 1, knobs: { attack: 0.00429, decay: 0.09708, sustain: 1, release: 0.1029 } },
    { id: "vibSum", type: "audio_mixer", col: 1, row: 2, knobs: { level1: 1, level2: 0.2582, level3: 0.1094, master: 1 } },
    { id: "modSmooth", type: "audio_ax_kfilter_lowpass", col: 1, row: 3, knobs: { rise: -40, decay: -40 } },
    // LPRiseDecay: climbs in 48, falls in 11 — a control that snaps up and glides down.
    { id: "ringSmooth", type: "audio_ax_kfilter_lowpass", col: 1, row: 4, knobs: { rise: 48, decay: 11 } },

    { id: "touchGate", type: "audio_ax_math", col: 2, row: 0, knobs: { operation: "multiply", b: 0 } },
    // math/+c 8.0 — a floor under the mod wheel, so vibrato never reaches exactly zero.
    { id: "modOffset", type: "audio_ax_math", col: 2, row: 1, knobs: { operation: "add", b: 0.125 } },
    { id: "ringDepth", type: "audio_ax_math", col: 2, row: 2, knobs: { operation: "multiply", b: 16 } },

    { id: "pressMax", type: "audio_ax_math", col: 3, row: 0, knobs: { operation: "maximum", b: 0 } },
    // note + 19 semitones of knob = an octave and a fifth, his own comment's number.
    { id: "ringPitch", type: "audio_mixer", col: 3, row: 1, knobs: { level1: 1, level2: 1.1875, master: 1 } },

    { id: "pressSmooth", type: "audio_ax_kfilter_lowpass", col: 4, row: 0, knobs: { rise: -18, decay: -18 } },
    { id: "ringOsc", type: "audio_ax_osc", col: 4, row: 1, knobs: { pitch: 0, waveform: "sine" } },

    // *_3 then *_4: pressure SQUARED then squared again, so vibrato depth is a fourth power
    // of how hard you are pressing — nothing at a light touch, a lot at a hard one.
    { id: "press2", type: "audio_ax_math", col: 5, row: 0, knobs: { operation: "multiply", b: 0 } },
    { id: "cutoffDepth0", type: "audio_ax_math", col: 5, row: 1, knobs: { operation: "multiply", b: 16 } },
    { id: "press4", type: "audio_ax_math", col: 6, row: 0, knobs: { operation: "multiply", b: 0 } },
    { id: "cutoffDepth1", type: "audio_ax_math", col: 6, row: 1, knobs: { operation: "multiply", b: 3.844 } },

    { id: "modMix", type: "audio_mixer", col: 7, row: 0, knobs: { level1: 1, level2: 0.5, master: 1 } },
    { id: "cutoffMix", type: "audio_mixer", col: 7, row: 1, knobs: { level1: 1, level2: 1, master: 1 } },
    { id: "vibDepth", type: "audio_ax_math", col: 8, row: 0, knobs: { operation: "multiply", b: 0 } },
    // mix/mix 2 (bus_in = note, gain1 0.245): note + 0.245 SEMITONES of vibrato.
    { id: "notePitch", type: "audio_mixer", col: 9, row: 0, knobs: { level1: 1, level2: 0.245, master: 1 } },

    { id: "saw0", type: "audio_ax_dp2saw", col: 10, row: 0, knobs: { pitch: 0 } },
    { id: "saw1", type: "audio_ax_dp2saw", col: 10, row: 1, knobs: { pitch: 0.02 } },
    { id: "saw2", type: "audio_ax_dp2saw", col: 10, row: 2, knobs: { pitch: -0.0488 } },
    { id: "sawSum", type: "audio_ax_math", col: 11, row: 0, knobs: { operation: "add", b: 0 } },
    { id: "vca1", type: "audio_vca", col: 12, row: 0, knobs: { gain: 0 } },
    // `level3` CARRIES THE AUTOPLAY SAW TRIO, at the same unity `saw0` has on `in1`.
    { id: "filtBus", type: "audio_mixer", col: 13, row: 0, knobs: { level1: 1, level2: 0.5, level3: 1, master: 1 } },
    { id: "vcf", type: "audio_ax_vcf3", col: 14, row: 0, knobs: { pitch: 23, reso: 35 } },
    { id: "vca2", type: "audio_vca", col: 15, row: 0, knobs: { gain: 0 } },
    // `math/*c 21.5` — and this ONE `*c` cannot be `attenuate`, because that operation's b IS
    // the dial and our range stops at 16 while Axoloti's goes to 64. Same arithmetic through
    // `multiply` with the converted gain, 21.5/64. Reported as a range defect in AX_MATH_SPEC.
    { id: "voiceGain", type: "audio_ax_math", col: 16, row: 0, knobs: { operation: "multiply", b: 0.3359 } },

    // ── THE RING MODULATOR AND ITS CROSSFADE ────────────────────────────────
    { id: "ringMod", type: "audio_ax_math", col: 17, row: 0, knobs: { operation: "ringModAntialiased", b: 0 } },
    { id: "ringXfadeGain", type: "audio_ax_math", col: 17, row: 1, knobs: { operation: "gain16", b: 9.025 } },
    { id: "xfade", type: "audio_ax_xfade", col: 18, row: 0 },
    { id: "ringSat", type: "audio_ax_math", col: 18, row: 1, knobs: { operation: "saturate" } },
    // THE DP CLIPPER GAINS ARE NORMALISED dial/64 (AX-4's D9), so the harvested dials 11
    // and 28 are 0.171875 and 0.4375 — a drive just under unity's 0.25 and a ceiling just
    // under the 0.5 that puts the shaper's own peak of 2 on ±1. As raw dials they were a
    // 44× drive into a hard clipper followed by 56× of make-up, i.e. this node was a fuzz
    // box in front of the plate rather than the gentle ceiling the patch was voiced with.
    { id: "clip", type: "audio_ax_dphardclip", col: 19, row: 0, knobs: { ingain: 0.171875, outgain: 0.4375 } },

    // ── THE PLATE: BANDLIMIT, DIFFUSE, SPLIT ────────────────────────────────
    { id: "inLp", type: "audio_ax_onepole", col: 20, row: 0, knobs: { mode: "lowpass", pitch: 59 } },
    { id: "inHp", type: "audio_ax_onepole", col: 21, row: 0, knobs: { mode: "highpass", pitch: -1 } },
    // THE INPUT DIFFUSER: three MUTUALLY PRIME lengths, which is the Schroeder trick — a
    // common factor would make the three sections ring together instead of smearing.
    { id: "diff0", type: "audio_ax_allpass", col: 22, row: 0, knobs: { g: 0.7813, delay: 62 } },
    { id: "diff1", type: "audio_ax_allpass", col: 23, row: 0, knobs: { g: 0.625, delay: 146 } },
    { id: "diff2", type: "audio_ax_allpass", col: 24, row: 0, knobs: { g: 0.6563, delay: 315 } },
    { id: "branchA", type: "audio_ax_onepole", col: 25, row: 0, knobs: { mode: "lowpass", pitch: 37 } },
    { id: "branchB0", type: "audio_ax_allpass", col: 25, row: 1, knobs: { g: 0.6719, delay: 349 } },
    // CHORUS ONE FEEDS THE TANKS — a modulated delay INSIDE the feedback path, which is
    // what stops a plate this long from ringing on fixed modes.
    { id: "chorus1", type: "audio_ax_chorus", col: 26, row: 0, knobs: { depth: 6.5, speed: -64 } },
    { id: "branchB1", type: "audio_ax_allpass", col: 26, row: 1, knobs: { g: 0.6719, delay: 823 } },
    // CHORUS TWO IS ADDED AT THE OUTPUT, not into the tanks.
    { id: "chorus2", type: "audio_ax_chorus", col: 27, row: 1, knobs: { depth: 4.5, speed: -63.2 } },

    // ── THE TWO CROSS-COUPLED TANKS, in ONE column ──────────────────────────
    // `level4` ON BOTH TANK MIXERS IS THE AUTOPLAY INPUT — the door the placeholder
    // clipper is standing in. Matched to `level1`, which is the authored input tap.
    { id: "mixA", type: "audio_mixer", col: C7_TANK_COL, row: 0, knobs: { level1: 0.6172, level2: 0.5391, level3: 0.3906, level4: 0.6172, master: 1 } },
    { id: "apA0", type: "audio_ax_allpass", col: C7_TANK_COL, row: 1, knobs: { g: 0.7656, delay: 2364 } },
    { id: "apA1", type: "audio_ax_allpass", col: C7_TANK_COL, row: 2, knobs: { g: 0.7344, delay: 1116 } },
    { id: "apA2", type: "audio_ax_allpass", col: C7_TANK_COL, row: 3, knobs: { g: 0.75, delay: 587 } },
    { id: "mixB", type: "audio_mixer", col: C7_TANK_COL, row: 4, knobs: { level1: 0.6094, level2: 0.5781, level3: 0.375, level4: 0.6094, master: 1 } },
    { id: "apB0", type: "audio_ax_allpass", col: C7_TANK_COL, row: 5, knobs: { g: 0.7969, delay: 2057 } },
    { id: "apB1", type: "audio_ax_allpass", col: C7_TANK_COL, row: 6, knobs: { g: 0.7188, delay: 1105 } },
    { id: "apB2", type: "audio_ax_allpass", col: C7_TANK_COL, row: 7, knobs: { g: 0.75, delay: 619 } },
    ...C7_TAP_PARTS.flatMap((tap) => tap.nodes),

    { id: "outMixA", type: "audio_mixer", col: C7_TANK_COL + 1, row: 0, knobs: { level1: 1, level2: 0.4844, master: 1 } },
    { id: "outMixB", type: "audio_mixer", col: C7_TANK_COL + 1, row: 1, knobs: { level1: 1, level2: 0.4844, master: 1 } },
    // mix/mix 2 x2 at 34 / 64 — the DRY clipper output against the reverb return.
    { id: "wetMixL", type: "audio_mixer", col: C7_TANK_COL + 2, row: 0, knobs: { level1: 0.5313, level2: 1, master: 1 } },
    { id: "wetMixR", type: "audio_mixer", col: C7_TANK_COL + 2, row: 1, knobs: { level1: 0.5313, level2: 1, master: 1 } },
    { id: "vcaOutL", type: "audio_vca", col: C7_TANK_COL + 3, row: 0, knobs: { gain: 0 } },
    { id: "vcaOutR", type: "audio_vca", col: C7_TANK_COL + 3, row: 1, knobs: { gain: 0 } },
    ...stereoTail(C7_TANK_COL + 4, 0, C7_AUTOPLAY_RETURN_LEVEL),
    ...AXO_PAD3_PLATE_AUTOPLAY.nodes,
  ],
  wires: [
    // ── THE MPE PRESSURE PATH ───────────────────────────────────────────────
    { from: "poly", fromPort: "gate", to: "ampEnv", toPort: "gate" },
    { from: "poly", fromPort: "gate", to: "pressEnv", toPort: "gate" },
    { from: "poly", fromPort: "velocity", to: "touchGate", toPort: "a" },
    { from: "pressEnv", fromPort: "out", to: "touchGate", toPort: "b" },
    { from: "touchIn", fromPort: "o", to: "pressMax", toPort: "a" },
    { from: "touchGate", fromPort: "out", to: "pressMax", toPort: "b" },
    { from: "pressMax", fromPort: "out", to: "pressSmooth", toPort: "in" },
    { from: "pressSmooth", fromPort: "out", to: "press2", toPort: "a" },
    { from: "pressSmooth", fromPort: "out", to: "press2", toPort: "b" },
    { from: "press2", fromPort: "out", to: "press4", toPort: "a" },
    { from: "press2", fromPort: "out", to: "press4", toPort: "b" },

    // ── THE VIBRATO: three LFOs, depth = mod wheel + pressure^4 ─────────────
    { from: "vibLfo0", fromPort: "out", to: "vibSum", toPort: "in1" },
    { from: "vibLfo1", fromPort: "out", to: "vibSum", toPort: "in2" },
    { from: "vibLfo2", fromPort: "out", to: "vibSum", toPort: "in3" },
    { from: "modKnob", fromPort: "out", to: "modSmooth", toPort: "in" },
    { from: "modSmooth", fromPort: "out", to: "modOffset", toPort: "a" },
    { from: "modOffset", fromPort: "out", to: "modMix", toPort: "in1" },
    { from: "press4", fromPort: "out", to: "modMix", toPort: "in2" },
    { from: "vibSum", fromPort: "out", to: "vibDepth", toPort: "a" },
    { from: "modMix", fromPort: "out", to: "vibDepth", toPort: "b" },
    { from: "poly", fromPort: "note", to: "notePitch", toPort: "in1" },
    { from: "vibDepth", fromPort: "out", to: "notePitch", toPort: "in2" },

    // ── THE THREE SAWS: two gated by pressure, ONE always speaking ──────────
    { from: "notePitch", fromPort: "out", to: "saw0", toPort: "pitch" },
    { from: "notePitch", fromPort: "out", to: "saw1", toPort: "pitch" },
    { from: "notePitch", fromPort: "out", to: "saw2", toPort: "pitch" },
    { from: "saw2", fromPort: "wave", to: "sawSum", toPort: "a" },
    { from: "saw1", fromPort: "wave", to: "sawSum", toPort: "b" },
    { from: "sawSum", fromPort: "out", to: "vca1", toPort: "in" },
    { from: "pressSmooth", fromPort: "out", to: "vca1", toPort: "gain" },
    { from: "saw0", fromPort: "wave", to: "filtBus", toPort: "in1" },
    { from: "vca1", fromPort: "out", to: "filtBus", toPort: "in2" },

    // ── THE FILTER: note + 61.5 SEMITONES of pressure, in two gain stages ───
    { from: "pressSmooth", fromPort: "out", to: "cutoffDepth0", toPort: "a" },
    { from: "cutoffDepth0", fromPort: "out", to: "cutoffDepth1", toPort: "a" },
    { from: "poly", fromPort: "note", to: "cutoffMix", toPort: "in1" },
    { from: "cutoffDepth1", fromPort: "out", to: "cutoffMix", toPort: "in2" },
    { from: "filtBus", fromPort: "out", to: "vcf", toPort: "in" },
    { from: "cutoffMix", fromPort: "out", to: "vcf", toPort: "pitch" },
    { from: "vcf", fromPort: "out", to: "vca2", toPort: "in" },
    { from: "ampEnv", fromPort: "out", to: "vca2", toPort: "gain" },
    { from: "vca2", fromPort: "out", to: "voiceGain", toPort: "a" },

    // ── THE RING MODULATOR: ONE knob sets its pitch AND fades it in ─────────
    { from: "ringKnob", fromPort: "out", to: "ringSmooth", toPort: "in" },
    { from: "ringSmooth", fromPort: "out", to: "ringDepth", toPort: "a" },
    { from: "rootKeyb", fromPort: "note", to: "ringPitch", toPort: "in1" },
    { from: "ringDepth", fromPort: "out", to: "ringPitch", toPort: "in2" },
    { from: "ringPitch", fromPort: "out", to: "ringOsc", toPort: "pitch" },
    { from: "voiceGain", fromPort: "out", to: "ringMod", toPort: "a" },
    { from: "ringOsc", fromPort: "out", to: "ringMod", toPort: "b" },
    { from: "ringSmooth", fromPort: "out", to: "ringXfadeGain", toPort: "a" },
    { from: "ringXfadeGain", fromPort: "out", to: "ringSat", toPort: "a" },
    { from: "voiceGain", fromPort: "out", to: "xfade", toPort: "i1" },
    { from: "ringMod", fromPort: "out", to: "xfade", toPort: "i2" },
    { from: "ringSat", fromPort: "out", to: "xfade", toPort: "c" },
    { from: "xfade", fromPort: "o", to: "clip", toPort: "in" },

    // ── INTO THE PLATE ──────────────────────────────────────────────────────
    { from: "clip", fromPort: "out", to: "inLp", toPort: "in" },
    { from: "inLp", fromPort: "out", to: "inHp", toPort: "in" },
    { from: "inHp", fromPort: "out", to: "diff0", toPort: "in" },
    { from: "diff0", fromPort: "out", to: "diff1", toPort: "in" },
    { from: "diff1", fromPort: "out", to: "diff2", toPort: "in" },
    // THE SPLIT: one branch is chorused into the tanks, the other diffused twice more and
    // chorused into the OUTPUT.
    { from: "diff2", fromPort: "out", to: "branchA", toPort: "in" },
    { from: "diff2", fromPort: "out", to: "branchB0", toPort: "in" },
    { from: "branchA", fromPort: "out", to: "chorus1", toPort: "in" },
    { from: "branchB0", fromPort: "out", to: "branchB1", toPort: "in" },
    { from: "branchB1", fromPort: "out", to: "chorus2", toPort: "in" },
    { from: "chorus1", fromPort: "l", to: "mixA", toPort: "in1" },
    { from: "chorus1", fromPort: "r", to: "mixB", toPort: "in1" },

    // ── THE TANKS ───────────────────────────────────────────────────────────
    { from: "mixA", fromPort: "out", to: "apA0", toPort: "in" },
    { from: "apA0", fromPort: "out", to: "apA1", toPort: "in" },
    { from: "apA1", fromPort: "out", to: "apA2", toPort: "in" },
    { from: "mixB", fromPort: "out", to: "apB0", toPort: "in" },
    { from: "apB0", fromPort: "out", to: "apB1", toPort: "in" },
    { from: "apB1", fromPort: "out", to: "apB2", toPort: "in" },
    ...C7_TAP_PARTS.flatMap((tap) => tap.wires),

    // ── OUT: tank + the second chorus, then dry + wet, then the master VCA ──
    { from: "apA2", fromPort: "out", to: "outMixA", toPort: "in1" },
    { from: "chorus2", fromPort: "l", to: "outMixA", toPort: "in2" },
    { from: "apB2", fromPort: "out", to: "outMixB", toPort: "in1" },
    { from: "chorus2", fromPort: "r", to: "outMixB", toPort: "in2" },
    { from: "clip", fromPort: "out", to: "wetMixL", toPort: "in1" },
    { from: "outMixA", fromPort: "out", to: "wetMixL", toPort: "in2" },
    { from: "clip", fromPort: "out", to: "wetMixR", toPort: "in1" },
    { from: "outMixB", fromPort: "out", to: "wetMixR", toPort: "in2" },
    { from: "wetMixL", fromPort: "out", to: "vcaOutL", toPort: "in" },
    { from: "wetMixR", fromPort: "out", to: "vcaOutR", toPort: "in" },
    { from: "volKnob", fromPort: "out", to: "vcaOutL", toPort: "gain" },
    { from: "volKnob", fromPort: "out", to: "vcaOutR", toPort: "gain" },
    ...stereoTailWires({ item: "vcaOutL", port: "out" }, { item: "vcaOutR", port: "out" }),
    ...AXO_PAD3_PLATE_AUTOPLAY.wires,
  ],
};

/** This set's blueprints. See the PATCH-SET CONTRACT in core/audio_patch_sets.js. */
export const BLOCK_PATCHES = [AXO_SHIMMER, AXO_TO_THE_STARS, AXO_PAD3_PLATE];
