/**
 * DEMO PATCHES — Axoloti — the polyphonic voices.
 *
 * Part of R7-17-SEL's 20 headline patches; see `claude_instructions.md` for the full
 * table and for the user ruling that chose them (*"20 impressive, fully-equipped patches
 * with tons of likes and views"*). The blueprint format, the grid layout rule and the
 * meter/spectrum tail are documented ONCE in `core/audio_patches.js` — read that file's
 * header before adding anything here. The aggregation contract is in
 * `core/audio_patch_sets.js`.
 *
 * THIS SET REBUILDS:
 *   - A1 demos/synth/strings.axp — 7-VOICE poly string pad, 24 distinct / 15 DSP
 *   - A9 demos/sequencing/radioactive.axp — LFSR generative + FM + A1's pad, 38 distinct / 20 DSP
 *   - C4 tiar/synths/Tranquille.axp — wavetables drawn from spectral banks per note, poly 3, 24 / 16
 *
 * Every blueprint here carries `source` (the harvested file, its author, its popularity
 * figures, its distinct-module count) and `deviations` (what we did NOT reproduce, and
 * why) — an UNRECORDED substitution is the silent divergence R7-17-SEL exists to prevent.
 *
 * A node this set needs but the library does not yet have is a PLACEHOLDER, declared in
 * the companion `core/audio_stubs_axo_poly.js`. Read `core/audio_stub_nodes.js` first:
 * a placeholder carries the FINAL type name and the FINAL port names, so the wire written
 * here today is the wire the real module gets.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POLYPHONY: THE DECISION, AND WHY IT IS THIS ONE
 * ════════════════════════════════════════════════════════════════════════════
 * Axoloti's `patch/patcher` with `poly=N` instantiates a whole SUBPATCH N times with
 * voice allocation behind it. **PowerRP has no such construct**, and all three patches
 * here are built out of one. Three options were on the table; this set takes the first,
 * uniformly, and the reasoning is recorded because the lead must reconcile it against
 * AX-1's `poly/voices` row (`.frenzy/round7/NODE_REGISTRY.md:84`).
 *
 * **THE VOICE GRAPH IS DRAWN ONCE, AND `audio_ax_poly_voices` IS THE ALLOCATOR IN FRONT
 * OF IT.** It takes ONE stream of note events and emits the PER-VOICE note, gates and
 * velocities that the drawn graph reads; its `voices` knob is the patcher's `poly`
 * attribute, so the harvested 7 / 7 / 3 survive as data. When AX-1 builds the real node,
 * its contract is "replicate the subgraph DOWNSTREAM of me N times" — which is the one
 * sentence this scaffold is asking the lead to ratify.
 *
 * WHY NOT THE OTHER TWO:
 *   - **N explicit copies.** A1's voice is 30 nodes; seven copies is 210, and A9 embeds
 *     A1, so A9 would be 270. Unreadable on a canvas, and it hard-codes the voice count
 *     into the DOCUMENT — changing 7 to 8 would be a re-author rather than a knob. It is
 *     also not what the source says: the source says `poly=7` in one attribute.
 *   - **One voice, polyphony as a deviation.** Cheapest and dishonest: the user asked for
 *     these patches BECAUSE they are the batteries-included polyphony, so dropping the
 *     polyphony delivers the pad and loses the point. It would also make the node list
 *     LIE — `poly/voices` would stop being owed, which is the exact drift the
 *     patches-before-nodes ordering exists to prevent.
 *
 * WHY THE ALLOCATOR IS **NOT** MODELLED AS A SUBPATCH WRAPPER, which was the first
 * attempt: a patcher's ports ARE the subpatch's `patch/inlet`/`outlet` objects, so they
 * differ per instance — A1's patcher has 0 inlets and 1 outlet, C4's has 6 inlets and 4
 * outlets. One placeholder type cannot carry both port lists (and `stubRegistry` would
 * throw if it tried). So the boundary objects are ABSORBED instead: in a flat graph the
 * wire that crossed the subpatch edge is simply one wire, and `patch/inlet a`,
 * `patch/inlet f` and `patch/outlet a` disappear. That is recorded as a deviation on
 * every patch that had them.
 *
 * `audio_poly_pad` (our own eight-voice pad) was read before choosing and is NOT reusable
 * here: it is a whole INSTRUMENT with the voice pool sealed inside one module — its
 * `gate` is a method port and its timbre is fixed. These patches need the pool around an
 * AUTHORED voice graph, which is a different mechanism. What was taken from it is its
 * note CONTRACT: `pitch` as a value read at note-on plus `gate` as the event stream, and
 * `plugins/node_keyboard.js` on the other end of exactly those two wires (PLAYABLE_KEYS
 * is the precedent this set copies).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNITS: THE ONE THING THAT WILL SILENTLY TRANSPOSE EVERY PATCH
 * ════════════════════════════════════════════════════════════════════════════
 * On hardware every wire is a `frac32` and 1.0 means "full scale" for a noise generator
 * AND "64 semitones" for a pitch inlet. Our ports carry REAL units instead (AX-2's
 * deviation D9): pitch is semitones from E4, a dial is its own 0…64, a signal is ±1. So a
 * harvested gain transcribes by ONE of three rules, and which one depends on what is at
 * BOTH ends:
 *
 *   signal → signal        `dial / 64`   (a `*c` of 20.0 into an audio path is b = 0.3125)
 *   dial   → dial          `dial`        (a `*c` of 8.0 into a dial-unit port is b = 8.0)
 *   signal → dial/pitch    `dial`        (…and the 64 must appear somewhere on the path)
 *
 * ⚠ **AN ENVELOPE TIME IS NO LONGER A DIAL-UNIT PORT, and the second row's example used
 * to say it was.** AX-4 landed and its a/d/r knobs AND their same-named inlets are in
 * SECONDS (its D2, and its D3 for the inlets), so the ADSR and AHD knobs below are now
 * `axTimeDialSeconds`/`axDecayDialSeconds` of their harvested dials. The knobs are done;
 * THE MODULATION GAINS INTO THEM ARE NOT. `attackmod`/`decaymod` still carry the
 * harvested `*c` of 8.0 as `b: 8`, which under D3 is eight SECONDS per unit of velocity
 * into a 28 ms attack. It is left as harvested rather than guessed at, because theirs
 * MULTIPLIES the coefficient where ours ADDS seconds — the two are not related by any
 * constant, so the right value is a derivation and not a rescale. It is inaudible in the
 * offline renders (`readAudioScene` drops every wire out of a keyboard, so velocity is 0
 * there) and audible the moment somebody plays the patch.
 *
 * The third is where the work is. `mix13`'s pink-noise detune is `div 32` then a mixer at
 * gain 13.5, which on hardware is ±13.5/32 = ±0.42 SEMITONES; transcribed literally it
 * would be ±0.0066 semitones — a detune 64× too small, inaudible, and with nothing to
 * see. So on any path that ends at a `pitch`, `reso`, `delay` or envelope-time port, the
 * 64 is folded into the first gain node: `div 32` becomes `attenuate b = 2.0` (= 64/32),
 * which is the SAME node type with a different operation, so the graph shape is unchanged.
 *
 * **AND THERE IS A CEILING WE HIT REPEATEDLY, which is a real capability gap.**
 * `audio_ax_math`'s `b` reaches ±16 and `audio_mixer`'s levels reach 2 — so a required
 * gain of 24, 26 or 28 semitones needs TWO multiply nodes, and the allpass delay
 * modulations (a fraction of a 16384-sample buffer, i.e. ×1913) need THREE. Every such
 * chain is marked `// SCALE` at its site and counted in that patch's `deviations`.
 * Nothing in the shipped library multiplies a control signal by 64, which is exactly the
 * factor this corpus needs; that is reported to the lead rather than worked around twice.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SUBSTITUTE vs PLACEHOLDER — the line this set drew, stated once
 * ════════════════════════════════════════════════════════════════════════════
 * R7-17-SEL says drop cosmetic furniture, substitute a generic utility whose semantics we
 * have EXACTLY, and placeholder anything that shapes the sound. The test that decides the
 * middle case here is **whether the harvested VALUES survive**:
 *   - `gain/vca` has no params at all and is `gain × signal`, so `audio_vca` is exact →
 *     SUBSTITUTED.
 *   - `mix/mix N` is `bus + Σ gainᵢ·inᵢ`, and `audio_mixer` holds every gain these patches
 *     use once divided by 64 → SUBSTITUTED (its `in4` carries the `bus_in`).
 *   - `env/adsr`'s four dials map to an exponential segment law we did not have when this
 *     line was written, so the dial rode the normal knob path until AX-4 gave it meaning.
 *     IT HAS. `LinearTimeExp` is that law, `axTimeDialSeconds` is its inverse, and −17.0
 *     turns into 36.4 ms — so these are SUBSTITUTED now and every dial below is converted.
 *   - `ctrl/dial`, `ctrl/toggle` and `disp/*` are chrome; a dial IS a knob here, so it
 *     becomes `node_knob` where it feeds something through a smoother (a live gesture) and
 *     is folded into the target node's own knob where it does not (the param/inlet duality
 *     means a separate node would be a second control for one value).
 *   - `audio/out stereo` and `sss/audio/StOutVol` are DROPPED, not substituted by the
 *     already-shipped `audio_ax_stereo_out`: that node has no outputs, so it could not
 *     feed the mandatory meter → spectrum tail, and every node in a patch must REACH an
 *     `audio_output`. The stereo pair folds to one mono bus at the tail.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AUTOPLAY: WHY EVERY PATCH HERE CARRIES AN `ap*` BRANCH (§ R7-AUDIBLE)
 * ════════════════════════════════════════════════════════════════════════════
 * THE RULING (user, 2026-08-07): *"any patch that doesn't make audio right away (unless
 * it has a button or keyboard biult in to make noise) needs to make noise
 * automatically"*, and the exemption is a WORKING trigger, not a trigger-shaped widget.
 *
 * MEASURED 2026-08-07, before this branch existed: all three patches here rendered at
 * **−inf dBFS** in `tests/patch_sound_probe.mjs`, and pressing the `node_keyboard` made
 * no sound. TWO independent reasons, both structural, both worth writing down because
 * neither is visible on the canvas:
 *
 *   1. **THE KEYBOARD CANNOT REACH AN AXOLOTI CHAIN AT ALL, AND STILL CANNOT.**
 *      `core/audio_mirror_diff.readAudioScene` drops every wire whose SOURCE has no
 *      engine module, and a `node_keyboard` has none — it is a control widget. Its
 *      presses instead travel through `core/live_control.noteRoutes`, which routes a key
 *      ONLY to an input declared `method: true`. Exactly TWO ports in the whole library
 *      declare that (`audio_ding.gate` and `audio_poly_pad.gate`, core/audio_specs.js),
 *      and neither is ours. So a keyboard in front of an Axoloti voice is decorative
 *      TODAY no matter how it is wired — including in front of the real
 *      `audio_ax_midi_keyb`. Making it real means a `method` port plus a `noteOn`/
 *      `noteOff` surface on `axMidiKeyb`, i.e. `core/audio_specs_ax1.js` and `synth/`,
 *      which this file does not own. **Reported, not worked around.**
 *   2. **THE VOICE'S AMPLITUDE ENVELOPE IS A PLACEHOLDER**, so every `audio_vca` in the
 *      chain sits at its authored `gain: 0` offset with a dropped wire on its `gain`
 *      input. Even a working note source would have produced silence.
 *
 * So these patches take § R7-AUDIBLE's **third way — a self-driving source the original
 * implies** — and it is recorded as a deviation on each one. THE SHAPE IS THE SAME EVERY
 * TIME and is built ONLY from shipped nodes:
 *
 *      audio_ax_lfo (square)  →  audio_trigger  →  [ counter → steps: the note pattern ]
 *                                              →  [ pulse/d → a VCA gain: the envelope ]
 *
 * `audio_trigger` is not optional furniture: `core/nodeflow.COERCIONS` has no
 * `audio → trigger`, so a square wave becomes an event stream only through a Schmitt —
 * the same insertion A9 and C4 already record for their own clocks.
 *
 * **THE BRANCH DRIVES THE PATCH'S OWN VOICE WHEREVER ONE IS ALIVE**, rather than being a
 * drone bolted on beside it. In A1 the arpeggio enters the harvested `notemix` and is
 * heard through the harvested three oscillators, the pink detune and the vcf3; in A9 the
 * envelopes hang off the harvested step grid's OWN Schmitts and the LFSR's OWN gate. What
 * the branch supplies is exactly what a placeholder is failing to supply — a note pattern
 * where `audio_ax_midi_keyb` cannot be played, and an envelope where AX-4 owes one.
 *
 * **EVERY `ap*` NODE IS DELETABLE IN ONE BLOCK** the day AX-4's envelopes and a playable
 * keyboard land. Nothing existing was rewired to make room for it: the branch only takes
 * FREE mixer inputs and FANS OUT of outputs, so the harvested graph is byte-identical
 * underneath it. The one exception is a mixer LEVEL that was 0 for a free input, which is
 * named at its site.
 */

// ── THE ANALYSIS TAIL ───────────────────────────────────────────────────────
// A LOCAL COPY, AND THAT IS DEBT RATHER THAN A CHOICE. `core/audio_patches.js` has the
// same two helpers, but a set file MAY NOT import it (that is the cycle
// `core/audio_patch_sets.js` exists to break) and MAY NOT export a second name. So seven
// set files each hold a copy of a four-line helper, which is the hand-maintained-mirror
// defect this round has found five times. THE FIX IS ONE FILE THE LEAD OWNS: move
// `analysisTail`/`analysisWires` into a leaf module both sides import. Reported, not
// applied — this agent owns two files.

/** The output level every patch's tail runs at. A9 overrides it — see its deviations. */
const ANALYSIS_TAIL_VOLUME = 0.7;

/** The meter → spectrum → output tail every patch ends in, at a given column.
 *  `volume` IS A PARAMETER because A9's harvested mix peaks at +0.6 dBFS through the
 *  standard 0.7, which is over `tests/patch_sound_probe.mjs`'s clip bar. Trimming OUR
 *  tail is the honest lever there; trimming a harvested mixer gain would edit the port. */
const analysisTail = (col, row = 0, volume = ANALYSIS_TAIL_VOLUME) => [
  { id: "meter", type: "audio_meter", col, row },
  { id: "spectrum", type: "audio_spectrum", col: col + 1, row },
  { id: "out", type: "audio_output", col: col + 2, row, knobs: { volume } },
];

/** A9's tail level. Measured 2026-08-07: the harvested mix peaks at +0.6 dBFS at 0.7 and
 *  at −3.3 here, which leaves the headroom the `fx/chorus` placeholder will want. */
const AXO_RADIOACTIVE_OUTPUT_VOLUME = 0.45;

/** …and the wires that chain it. `from` is the module feeding the tail. */
const analysisWires = (from) => [
  { from, fromPort: "out", to: "meter", toPort: "in" },
  { from: "meter", fromPort: "out", to: "spectrum", toPort: "in" },
  { from: "spectrum", fromPort: "out", to: "out", toPort: "in" },
];

// ── THE AUTOPLAY PRIMITIVES (§ R7-AUDIBLE — see this file's AUTOPLAY section) ─

/**
 * AN LFO PITCH IS SEMITONES FROM ITS OWN 5.15 Hz BASE, NOT FROM E4, and the two patches
 * below state that base in prose already (*"LFO pitch 0 → 5.15 Hz"*, and A9's clock at
 * −36 being 0.64 Hz). Writing the tempos as hertz and converting once is what stops a
 * third reader re-deriving it — and getting a clock an octave out is the kind of error
 * that reads as a musical choice rather than as a bug.
 *
 * Pure function. The `audio_ax_lfo` `pitch` knob that runs at a given rate.
 *
 * @param {number} hz - the wanted rate in hertz
 * @returns {number} semitones, rounded to a tenth (the dial's own resolution)
 *
 * @example lfoPitchForHz(5.15) // 0
 * @example lfoPitchForHz(0.64) // -36.1  — A9's master clock, which the patch calls 0.64 Hz
 * @example lfoPitchForHz(2) // -16.4
 */
function lfoPitchForHz(hz) {
  return Math.round(12 * Math.log2(hz / AX_LFO_BASE_HZ) * 10) / 10;
}

/** The rate an `audio_ax_lfo` runs at with its `pitch` knob at 0. Measured from the
 *  block's own arithmetic and restated in both C4's and A9's node comments. */
const AX_LFO_BASE_HZ = 5.15;

/**
 * Pure function. THE AUTOPLAY CLOCK: a square LFO and the Schmitt that turns it into
 * events. Two nodes, written once because all three patches here need one and a
 * divergence between them would be meaningless variety.
 *
 * `core/nodeflow.COERCIONS` HAS NO `audio → trigger`, deliberately — turning a
 * continuous signal into events is a real operation with a real parameter — so the
 * Schmitt is structural, not decoration. A9 and C4 already record the same insertion.
 *
 * @param {string} id - id prefix; the nodes are `<id>Lfo` and `<id>Edge`
 * @param {number} col - column of the LFO; the Schmitt sits one to its right
 * @param {number} row - the row both occupy
 * @param {number} hz - the clock rate
 * @returns {{nodes: object[], wires: object[], trig: string}} `trig` is the id whose
 *   `out` port carries the event stream
 *
 * @example autoClock("ap", 0, 11, 0.5).trig // "apEdge"
 * @example autoClock("ap", 0, 11, 0.5).nodes.length // 2
 * @example autoClock("ap", 0, 11, 5.15).nodes[0].knobs // {waveform: "square", pitch: 0}
 */
function autoClock(id, col, row, hz) {
  return {
    trig: `${id}Edge`,
    nodes: [
      { id: `${id}Lfo`, type: "audio_ax_lfo", col, row, knobs: { waveform: "square", pitch: lfoPitchForHz(hz) } },
      { id: `${id}Edge`, type: "audio_trigger", col: col + 1, row, knobs: { pulseMs: AUTOPLAY_PULSE_MS } },
    ],
    wires: [{ from: `${id}Lfo`, fromPort: "out", to: `${id}Edge`, toPort: "in" }],
  };
}

/** The Schmitt width every autoplay clock uses — the same 5 ms the harvested patches
 *  already give their own inserted Schmitts, so one clock cannot be subtly unlike another. */
const AUTOPLAY_PULSE_MS = 5;

/**
 * Pure function. AN AUTOPLAY NOTE: `pulse/d` into a VCA — the two nodes that turn a live
 * trigger plus a live audio source into something you can hear.
 *
 * THIS IS THE SHAPE THE PLACEHOLDERS ARE FAILING TO PROVIDE. Every harvested VCA here
 * carries `gain: 0` (the knob is the OFFSET its envelope wire sums into) and every one of
 * those envelope wires runs from an AX-4 placeholder, so it is dropped and the VCA stays
 * shut. `audio_ax_pulse_decay` is `pulse/d`, an audio-rate exponential decay — NOT the
 * `env/adsr` or `env/ahd m` the source uses, so it is a substitution and is recorded as
 * one; what it has that they do not is an engine module today.
 *
 * @param {string} id - id prefix; the nodes are `<id>Env` and `<id>Vca`
 * @param {number} col - column of the envelope; the VCA goes at `vcaCol`
 * @param {number} row - the row both occupy
 * @param {object} cfg - `{trig, source, vcaCol, decay}` — `trig` and `source` are
 *   `{item, port}` records naming a LIVE trigger and a LIVE audio signal
 * @returns {{nodes: object[], wires: object[], out: string}}
 *
 * @example // autoNote("apKick", 9, 17, {trig: {item: "kickedge", port: "out"}, …}).out
 * @example // "apKickVca"
 * @example autoNote("x", 1, 2, {trig: {item: "t", port: "out"}, source: {item: "s", port: "out"}, vcaCol: 4, decay: 0.2}).nodes.length // 2
 */
function autoNote(id, col, row, { trig, source, vcaCol, decay }) {
  return {
    out: `${id}Vca`,
    nodes: [
      { id: `${id}Env`, type: "audio_ax_pulse_decay", col, row, knobs: { decay } },
      { id: `${id}Vca`, type: "audio_vca", col: vcaCol, row, knobs: { gain: 0 } },
    ],
    wires: [
      { from: trig.item, fromPort: trig.port, to: `${id}Env`, toPort: "trig" },
      { from: `${id}Env`, fromPort: "out", to: `${id}Vca`, toPort: "gain" },
      { from: source.item, fromPort: source.port, to: `${id}Vca`, toPort: "in" },
    ],
  };
}

// ── A1's STRING VOICE, AS A FUNCTION, BECAUSE A9 CONTAINS IT TOO ────────────
// A9 embeds `strings.axp`'s entire 7-voice subpatch as a keyboard split, with byte-
// identical effective parameters (verified against both XMLs: A9's `<patcher>` params
// block is character-for-character A1's). Spelling that voice twice would be thirty nodes
// and forty-three wires of hand-maintained mirror — the Tower of Babel failure named in
// the round's standing orders — and the two copies would drift the first time either was
// voiced. So it is ONE function, called twice.
//
// It is a local helper, not an export: the PATCH-SET CONTRACT allows exactly one exported
// name, and `core/audio_patches.js` already establishes local blueprint helpers
// (`analysisTail`) as the shape for this.

/**
 * Pure function. `strings.axp`'s voice as blueprint nodes, prefixed and offset.
 *
 * The voice runs left to right in eleven columns: note source → detune → oscillator
 * trio → mix → filter → VCA → output gain. Rows 1-9 carry the modulation that makes it a
 * string machine rather than three saws — the pink-noise detune, the PWM sweep, the
 * saw's vibrato, the cutoff envelope and the cutoff drift.
 *
 * @param {string} prefix - prepended to every node id, so two voices can coexist
 * @param {string} keysId - the `node_keyboard` node whose pitch and gate drive the voice
 * @param {number} col - column of the voice's first node
 * @param {number} row - row of the voice's first node
 * @returns {{nodes: object[], wires: object[], out: string}} `out` is the id whose `out`
 *   port carries the finished mono voice
 *
 * @example // stringVoice("st-", "keys", 1, 18).out // "st-amp"
 * @example // stringVoice("", "keys", 1, 0).nodes.length // 30
 * @example // stringVoice("", "keys", 1, 0).nodes[0] // {id: "keyb", type: "audio_ax_keyb", col: 1, row: 0, knobs: {…}}
 */
function stringVoice(prefix, keysId, col, row) {
  const n = (id, type, dc, dr, knobs) => ({ id: prefix + id, type, col: col + dc, row: row + dr, ...(knobs ? { knobs } : {}) });
  const w = (from, fromPort, to, toPort) => ({ from: prefix + from, fromPort, to: prefix + to, toPort });
  return {
    out: prefix + "amp",
    nodes: [
      // THE NOTE SOURCE. The subpatch's own `midi/in/keyb` is AX-1's shipped
      // `audio_ax_midi_keyb` — the placeholder this used to name landed under that name,
      // and it is where § R7-AXO-TRAPS' hertz→semitone conversion has its home. Swapping
      // the type changed no wire: the two carry the same five outputs and the same
      // pitch/gate inputs, which is exactly what a placeholder promises.
      n("keyb", "audio_ax_midi_keyb", 0, 0, { start_note: -64, end_note: 63 }),
      n("poly", "audio_ax_poly_voices", 1, 0, { voices: 7 }),
      // THE PER-VOICE DETUNE, which is what the patch is FOR: pink noise (a random WALK,
      // not a jitter) wandering each voice a few tens of cents off, so the ensemble never
      // phase-locks. `div 32` carries the 64× (see UNITS) and so is an `attenuate` at 2.0;
      // the mixer's 0.2109375 is the harvested gain 13.5/64, and the product is ±13.5/32
      // = ±0.42 semitones, exactly the hardware's spread.
      n("pink", "audio_ax_rand_pink", 1, 3, { octaves: 7, seed: 0 }),
      n("pinkgain", "audio_ax_math", 2, 3, { operation: "attenuate", b: 2 }), // SCALE: 64/32
      n("notemix", "audio_mixer", 3, 0, { level1: 0.2109375, level4: 1, master: 1 }),
      // THE THREE OSCILLATORS. `mix/mix 3`'s gains 4 / 21 / 26 say the saw is the body,
      // the pulse is the mid and the sub-sine is a hint — that balance IS the timbre.
      n("sine", "audio_ax_osc", 4, 0, { waveform: "sine", pitch: -24 }),
      n("pwmlfo", "audio_ax_lfo", 3, 1, { waveform: "sine", pitch: -10 }),
      n("pwmdepth", "audio_ax_math", 4, 1, { operation: "attenuate", b: 0.046875 }),
      // `pw: 0.5` ABSORBS TWO OBJECTS: `math/c 32` (a constant 32, which is 0.5 after the
      // int32→frac32 coercion) and the `mix/mix 1` that added it to the LFO. A knob and
      // its same-named input sum on one param here, so the constant IS the knob and the
      // mixer had nothing left to do. Duty runs 75% ± 4.7%, as on the hardware.
      n("pwmosc", "audio_ax_osc", 5, 1, { waveform: "pwm", pitch: 0, pw: 0.5 }),
      n("vib", "audio_ax_lfo", 3, 4, { waveform: "sine", pitch: 0 }),
      n("vibgain", "audio_ax_math", 4, 4, { operation: "attenuate", b: 2 }), // SCALE: 64/32
      n("sawmix", "audio_mixer", 5, 4, { level1: 0.0234375, level4: 1, master: 1 }),
      // −12.02, not −12: the 0.02 of a semitone is a deliberate 2-cent beat against the
      // sine an octave below. Do not tidy it.
      n("saw", "audio_ax_osc", 6, 2, { waveform: "saw", pitch: -12.02 }),
      n("oscmix", "audio_mixer", 7, 0, { level1: 0.0625, level2: 0.328125, level3: 0.40625, master: 1 }),
      // THE FILTER ENVELOPE is used ONLY as a cutoff shaper — it never touches amplitude,
      // which is why the pad has no attack transient but does have a swell.
      // IN SECONDS, from the harvested dials −17 / 19 / 21.5 / 0 through AX-4's own
      // `axTimeDialSeconds` (a/d/r) and its dial/64 for the sustain LEVEL. The dials are
      // what `.axp` stores; AX-4's knobs are `LinearTimeExp`'s output, which is the whole
      // point of that block's D2. As dials, `d: 19` asked for a nineteen-SECOND decay and
      // got the knob's 3.91 s ceiling instead — this swell was five times too slow.
      n("envf", "audio_ax_env_adsr", 2, 5, { a: 0.036364, d: 0.290909, s: 0.3359375, r: 0.097079 }),
      n("velmul", "audio_ax_math", 3, 5, { operation: "multiply" }),
      n("velgain", "audio_ax_math", 4, 5, { operation: "multiply", b: 13 }), // SCALE: 13 × 2 = 26
      // THE CUTOFF DRIFT: a ONE-OCTAVE pink walk (their `octaves` attribute is 1 here,
      // not the default 7) through a very slow smoother, τ ≈ 0.9 s at dial 62.5.
      n("pinkoct", "audio_ax_rand_pink", 2, 6, { octaves: 1, seed: 1 }),
      n("drift", "audio_ax_smooth", 3, 6, { time: 62.5, enable: 1 }),
      n("driftgain", "audio_ax_math", 4, 6, { operation: "multiply", b: 11.5 }), // SCALE: 11.5 × 2 = 23
      // THE MODWHEEL. `vcf3_1.pitch` carries `MidiCC="1"` in the source, and that is not
      // decoration: at its stored 55.0 the corner sits at 7902 Hz and the filter is doing
      // nothing, so the patch is PLAYED by pulling the cutoff down with the wheel. We have
      // no MIDI, and a knob is what a modwheel is here (PLAYABLE_KEYS' own reasoning), so
      // it takes the cutoff mixer's one free input. Park it at 0 and the patch sounds as
      // saved; pull it toward −64 and the strings close.
      n("wheel", "node_knob", 4, 7, { value: 0, min: -64, max: 0, step: 1 }),
      n("cutoffmix", "audio_mixer", 5, 5, { level1: 2, level2: 2, level3: 1, level4: 1, master: 1 }),
      // vcf3, not the Biquad: no constant-peak normalisation and a [2,1,2] numerator. Both
      // look like slips in the original and both are what this patch was voiced against
      // (AX-3's spec argues it). `pitch: 55` and `reso: 26.5` are the PARENT's overrides —
      // the subpatch itself says 7.0 and 46.5, which is a completely different filter.
      n("vcf", "audio_ax_vcf3", 8, 0, { pitch: 55, reso: 26.5 }),
      // THE AMP ENVELOPE'S TIMES ARE VELOCITY-DEPENDENT, and both directions are negated:
      // hit harder and the attack shortens; release harder and the decay shortens. `b: 8`
      // is the harvested `*c` dial UNCHANGED, because both ends of that path are dial-unit
      // quantities (see UNITS) — one of the few gains that needs no conversion at all.
      n("velneg", "audio_ax_math", 2, 8, { operation: "negate" }),
      n("attackmod", "audio_ax_math", 3, 8, { operation: "multiply", b: 8 }),
      n("rvelneg", "audio_ax_math", 2, 9, { operation: "negate" }),
      n("decaymod", "audio_ax_math", 3, 9, { operation: "multiply", b: 8 }),
      // IN SECONDS, from the harvested dials 30 and 56 through `axDecayDialSeconds` — the
      // HALF-LIFE conversion (`DecayTime`), not `LinearTimeExp`: `env/ahd m` is the one
      // envelope in AX-4 on that scale, and the spec's own help states dial 56 = 118 ms.
      // As dials both stages sat on the knob's 1.89 s ceiling, so the pad's amp envelope
      // was a two-second fade where the hardware gives 28 ms and 118 ms.
      n("ampenv", "audio_ax_env_ahd", 4, 8, { a: 0.027835, d: 0.118297 }),
      n("vca", "audio_vca", 9, 0, { gain: 0 }),
      // `gain: 0` on the VCA and `b: 0.3125` here are one story: the knob is the OFFSET the
      // envelope wire sums into, so a non-zero knob would be a floor under every note, and
      // the 20.0 output dial is a signal→signal gain, hence /64.
      n("amp", "audio_ax_math", 10, 0, { operation: "attenuate", b: 0.3125 }),
    ],
    wires: [
      { from: keysId, fromPort: "pitch", to: prefix + "keyb", toPort: "pitch" },
      { from: keysId, fromPort: "gate", to: prefix + "keyb", toPort: "gate" },
      w("keyb", "note", "poly", "note"),
      w("keyb", "gate", "poly", "gate"),
      w("keyb", "gate2", "poly", "gate2"),
      w("keyb", "velocity", "poly", "velocity"),
      w("keyb", "release_velocity", "poly", "release_velocity"),
      // The note reaches FOUR places, and that fan-out is the patch's spine: two
      // oscillators directly, the saw's vibrato mixer, and the cutoff mixer — so the
      // filter TRACKS the keyboard instead of sitting at a fixed corner.
      w("poly", "note", "notemix", "in4"),
      w("pink", "out", "pinkgain", "a"),
      w("pinkgain", "out", "notemix", "in1"),
      w("notemix", "out", "sine", "pitch"),
      w("notemix", "out", "pwmosc", "pitch"),
      w("notemix", "out", "sawmix", "in4"),
      w("notemix", "out", "cutoffmix", "in4"),
      w("pwmlfo", "out", "pwmdepth", "a"),
      w("pwmdepth", "out", "pwmosc", "pw"),
      w("vib", "out", "vibgain", "a"),
      w("vibgain", "out", "sawmix", "in1"),
      w("sawmix", "out", "saw", "pitch"),
      w("sine", "out", "oscmix", "in1"),
      w("pwmosc", "out", "oscmix", "in2"),
      w("saw", "out", "oscmix", "in3"),
      // gate2 RETRIGGERS on legato and gate does not — the source uses BOTH, and which
      // envelope gets which is the difference between a pad that re-swells on every
      // finger and one that only swells when you lift your hands. The filter envelope
      // takes gate2, the amplitude envelope takes gate.
      w("poly", "gate2", "envf", "gate"),
      w("envf", "env", "velmul", "a"),
      w("poly", "velocity", "velmul", "b"),
      w("velmul", "out", "velgain", "a"),
      w("velgain", "out", "cutoffmix", "in1"),
      w("pinkoct", "out", "drift", "in"),
      w("drift", "out", "driftgain", "a"),
      w("driftgain", "out", "cutoffmix", "in2"),
      w("wheel", "out", "cutoffmix", "in3"),
      w("cutoffmix", "out", "vcf", "pitch"),
      w("oscmix", "out", "vcf", "in"),
      w("poly", "velocity", "velneg", "a"),
      w("velneg", "out", "attackmod", "a"),
      w("attackmod", "out", "ampenv", "a"),
      w("poly", "release_velocity", "rvelneg", "a"),
      w("rvelneg", "out", "decaymod", "a"),
      w("decaymod", "out", "ampenv", "d"),
      w("poly", "gate", "ampenv", "gate"),
      w("ampenv", "env", "vca", "gain"),
      w("vcf", "out", "vca", "in"),
      w("vca", "out", "amp", "a"),
    ],
  };
}

/** Every deviation the string voice carries, shared by A1 and A9 for the same reason the
 *  voice itself is (they contain the same subpatch, so they cannot honestly disagree
 *  about what was changed in it). */
const STRING_VOICE_DEVIATIONS = [
  "patch/patcher poly=7 → `audio_ax_poly_voices` (placeholder) with the voice graph drawn ONCE. See this file's POLYPHONY section for why, and for the two options rejected.",
  "THE PER-VOICE PINK DRIFT IS ONE SHARED DRIFT. In the original each of the seven patcher instances owns its own `rand/pink`, so no two voices' detunes or cutoffs ever coincide — that decorrelation is precisely why the patch sounds like a string machine and not like seven saws. Drawing the voice once necessarily shares one generator, so today the seven voices move TOGETHER. This retires the day AX-1's `poly/voices` replicates the subgraph downstream of it, and it is the strongest argument for that contract.",
  "midi/in/keyb → AX-1's shipped `audio_ax_midi_keyb`, driven by a `node_keyboard`. PowerRP has no MIDI; the keyboard widget is the note source, and that node is where its HERTZ becomes Axoloti's semitones-from-E4. Velocity and release velocity are ITS KNOBS, because a mouse click has none — this patch's attack and decay times read them, so the default 100/128 is what a clicked key is worth here.",
  "THE `node_keyboard` IS DECORATIVE AND WE COULD NOT FIX IT (§ R7-AUDIBLE, measured 2026-08-07). `readAudioScene` drops every wire out of a control widget, and `live_control.noteRoutes` delivers a key press only to an input declared `method: true` — which exactly two ports in the library are, neither of them ours. So the keys reach nothing, in this patch or any Axoloti patch, and the fix is a `method` port plus a noteOn/noteOff surface on `axMidiKeyb` in files this set does not own. The keyboard is KEPT (a patch is not trimmed) and the patch is made audible the third way instead — see the AUTOPLAY branch below.",
  "patch/outlet a ABSORBED: a subpatch boundary is not a node in a flat graph, so the wire that crossed it is now one wire.",
  "MidiCC 1 on vcf3's cutoff → a `node_knob` into the cutoff mixer's free input. Not cosmetic: at the stored 55.0 the corner is 7902 Hz and the filter is transparent, so the modwheel IS how this patch is played.",
  "math/c 32 + the pwm `mix/mix 1` ABSORBED into the PWM oscillator's own `pw` knob — a knob and its same-named input sum on one param here, so the constant is the knob.",
  "mix/mix 1 / 2 / 3 → `audio_mixer` (its `in4` carries `bus_in` at unity). Every harvested gain is the dial ÷ 64, except on the two paths that end at a pitch port, where the 64× of a frac32 pitch wire forces a two-node chain: 13 × 2 = 26 for the cutoff envelope and 11.5 × 2 = 23 for the drift.",
  "gain/vca → `audio_vca`; math/inv, math/*, math/*c and math/div 32 → `audio_ax_math` operations. Their nineteen arithmetic overloads are one node with an `operation` knob, which is AX-1's own collapse.",
  "env/adsr and env/ahd m → AX-4's own ported nodes, NOT our `audio_adsr`. This entry used to say the dials were \"an exponential segment law in 0…64 units\" with \"nowhere to land\", and that the harvested dials therefore rode the knob path raw. AX-4 landed the law: a/d/r are `LinearTimeExp` and the AHD's a/d are `DecayTime`, so every dial here is now `axTimeDialSeconds` or `axDecayDialSeconds` of itself and every sustain is dial/64. What the raw dials were doing meanwhile is worth recording — they were being read as SECONDS, so `d: 19` was a nineteen-second decay clamped to the knob's 3.91 s ceiling and every envelope in the set was pinned wide open.",
];

/** How loud an autoplay branch returns into a harvested bus. Below the authored path's
 *  unity so that the day the placeholders land, the port is what dominates and the
 *  branch is a bed under it rather than the other way round. */
const AUTOPLAY_DRY_LEVEL = 0.85;

/** …and the same return split across a stereo PAIR of buses. Half of the dry level on
 *  each side, so a source that is mixed to both sums to one centred voice rather than to
 *  two coincident ones 6 dB louder. */
const AUTOPLAY_CENTRED_LEVEL = 0.42;

/** One over the number of near-unison voices an autoplay branch sums, so the sum peaks at
 *  one voice rather than at three. C4's trio is detuned by two and five cents, which is
 *  close enough that they add in phase for seconds at a time. */
const AUTOPLAY_VOICE_SUM_LEVEL = 1 / 3;

/** A1's arpeggio tempo and note length. Half a hertz is two seconds a note — a PAD's
 *  pace, slow enough that the four-second swell of the harvested filter drift is still
 *  the thing you notice. The decay is `pulse/d`'s RATE dial, not a time: 0.02 is a
 *  ~1.5 s time constant, so notes overlap the way a string machine's do. */
const AXO_STRING_PAD_ARP_HZ = 0.5;
const AXO_STRING_PAD_ARP_DECAY = 0.02;

/**
 * A1's AUTOPLAY BRANCH — § R7-AUDIBLE's third way, spelled out.
 *
 * A pad is the case the ruling says should do BOTH (self-play and be playable); it can
 * only do the first here, for the reason this file's AUTOPLAY section measures. So this
 * is a four-note arpeggio at half a hertz, and it is deliberately routed THROUGH the
 * harvested voice rather than beside it: the pattern enters `notemix`, which is the fan-out
 * the patch's own docstring calls "the patch's spine", so what sounds is the real sine +
 * pwm + saw stack, the real pink-noise detune, and the real vcf3 with its pink cutoff
 * drift. Only the note pattern and the amplitude envelope are ours.
 *
 * ROWS 11-12 ARE EMPTY IN THE HARVESTED LAYOUT (the voice occupies 0-9, the tail row 0),
 * so the branch reads as its own band under the patch instead of interleaving with it.
 */
const AXO_STRING_PAD_AUTOPLAY = (() => {
  const clock = autoClock("ap", 0, 11, AXO_STRING_PAD_ARP_HZ);
  // The VCA taps `vcf.out` — AFTER the filter and BEFORE the harvested `vca`, whose gain
  // input is held by the placeholder envelope and cannot take a second wire.
  const note = autoNote("apAmp", 2, 12, {
    trig: { item: clock.trig, port: "out" },
    source: { item: "vcf", port: "out" },
    vcaCol: 12,
    decay: AXO_STRING_PAD_ARP_DECAY,
  });
  return {
    nodes: [
      ...clock.nodes,
      { id: "apCount", type: "audio_ax_counter", col: 2, row: 11, knobs: { maximum: 4 } },
      // A MINOR-SEVENTH ARPEGGIO over the note the allocator is holding (0, i.e. E4 with
      // nothing pressed): root, fourth, fifth, octave. Four steps because a longer figure
      // at this tempo takes longer than anyone looks at a freshly-inserted patch.
      { id: "apSteps", type: "audio_ax_steps_value", col: 3, row: 11, knobs: { v0: 0, v1: 5, v2: 7, v3: 12 } },
      ...note.nodes,
    ],
    wires: [
      ...clock.wires,
      { from: clock.trig, fromPort: "out", to: "apCount", toPort: "trig" },
      { from: "apCount", fromPort: "count", to: "apSteps", toPort: "index" },
      { from: "apSteps", fromPort: "out", to: "notemix", toPort: "in2" },
      ...note.wires,
      { from: note.out, fromPort: "out", to: "stereo", toPort: "in3" },
    ],
  };
})();

/**
 * A1 — STRING PAD (7 VOICES) — `demos/synth/strings.axp`.
 *
 * The canonical Axoloti pad, and the patch the user meant by *"batteries-included
 * patches for polyphony"*. Seven voices, each detuned by its own pink-noise random walk
 * and each drifting its own filter cutoff, into a chorus.
 *
 * ── WHAT MAKES IT A STRING MACHINE AND NOT A POLY SAW ───────────────────────
 * Three things, and all three are modulation rather than timbre. (1) The detune is a
 * pink-noise WALK — correlated, so it wanders like seven slightly-out-of-tune players
 * rather than jittering. (2) The saw sits at −12.02 semitones, two cents off the octave,
 * so it beats against the sub-sine forever. (3) The cutoff carries a one-octave pink walk
 * through a 0.9-second smoother, so the ensemble's brightness breathes.
 */
export const AXO_STRING_PAD = {
  id: "axo-strings-poly",
  title: "Axoloti String Pad (7 Voices)",
  help: "Axoloti's reference polyphonic string pad: seven voices, each with its own pink-noise detune and its own drifting filter, through a chorus. Play the Keyboard; pull the Wheel knob down to close the filter, which is the modwheel gesture the patch was written around. Placeholders still stand in for the voice allocator, the envelopes, the MIDI keyboard and the chorus.",
  source: {
    patch: "axoloti-factory demos/synth/strings.axp",
    file: "patches/demos/synth/strings.axp @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    author: "Johannes Taelman (Axoloti factory patch)",
    popularity: "factory demo — shipped with every Axoloti install, and the patch the community's poly tutorials start from",
    distinct: 24,
    families: ["polyphony with voice allocation"],
  },
  deviations: [
    ...STRING_VOICE_DEVIATIONS,
    "audio/out stereo DROPPED in favour of the mandatory meter → spectrum → Output tail; the chorus's L and R fold to one mono bus through a mixer. Our Output limits where the hardware codec hard-clips (AX-1's `audio_ax_stereo_out` states that divergence), and that node cannot be used here because it has no outputs and so cannot feed the tail.",
    "fx/chorus → `audio_ax_chorus` (placeholder). It is an .axs SUBPATCH of five primitives; placeholdering the whole thing rather than assembling it keeps one hole instead of five, and its two promoted dials (depth 3.0, speed −33.0) ride the placeholder's knobs.",
    "AUTOPLAY (§ R7-AUDIBLE, the THIRD way — an added self-driving source; six `ap*` nodes). THE ORIGINAL IS PLAYED BY HAND AND OURS PLAYS ITSELF: a 0.5 Hz square clock drives a four-step arpeggio (0 / +5 / +7 / +12 semitones) into `notemix`'s FREE `in2`, so the harvested three oscillators, the pink detune and the vcf3 are what you hear; the same clock's Schmitt fires a `pulse/d` into a new VCA fed from `vcf.out`, standing in for the `env/ahd m` amplitude envelope AX-4 owes. It reaches the mixer on the DRY input `in3`, because the only authored path out of this voice runs through the `audio_ax_chorus` placeholder and a placeholder drops every wire that touches it. Measured before: −inf dBFS. Nothing harvested was rewired — the branch takes a free mixer input and fans out of `vcf`, so deleting all six `ap*` nodes and `stereo`'s `level3` restores the port exactly.",
    "AS BUILT: 18 distinct types for the source's 24 objects/types. The shrink is entirely Axoloti's machine-generated overloads collapsing (three `mix/mix N` widths → one mixer, six arithmetic objects → one Math, two `rand/pink*` → one, three oscillators → one, two `lfo/sine` → one), plus the four absorptions above. No DSP was dropped.",
  ],
  nodes: (() => {
    const voice = stringVoice("", "keys", 1, 0);
    return [
      { id: "keys", type: "node_keyboard", col: 0, row: 0, w: 196, knobs: { baseNote: 48, octaves: 2 } },
      ...voice.nodes,
      { id: "chorus", type: "audio_ax_chorus", col: 12, row: 0, knobs: { depth: 3, speed: -33 } },
      // `level3` CARRIES THE AUTOPLAY BRANCH'S DRY RETURN, and it is the only knob on a
      // harvested node this branch touches. The two chorus returns keep their own levels.
      { id: "stereo", type: "audio_mixer", col: 13, row: 0, knobs: { level1: 1, level2: 1, level3: AUTOPLAY_DRY_LEVEL, master: 1 } },
      ...analysisTail(14),
      ...AXO_STRING_PAD_AUTOPLAY.nodes,
    ];
  })(),
  wires: (() => {
    const voice = stringVoice("", "keys", 1, 0);
    return [
      ...voice.wires,
      { from: voice.out, fromPort: "out", to: "chorus", toPort: "in" },
      { from: "chorus", fromPort: "l", to: "stereo", toPort: "in1" },
      { from: "chorus", fromPort: "r", to: "stereo", toPort: "in2" },
      ...analysisWires("stereo"),
      ...AXO_STRING_PAD_AUTOPLAY.wires,
    ];
  })(),
};

/**
 * A9 — RADIOACTIVE — `demos/sequencing/radioactive.axp`.
 *
 * The only factory patch using `seq/lfsrseq`, and the largest thing in this set: a
 * self-playing machine with FOUR simultaneous voices — a clocked acid bass, a played
 * lead, an aperiodic FM "Geiger counter", and A1's entire seven-voice string pad as the
 * top of a keyboard split.
 *
 * ── THE GEIGER COUNTER, WHICH IS WHY THIS PATCH WAS PICKED ──────────────────
 * A linear-feedback shift register at polynomial 0x198 clocks an envelope. With a
 * maximal-length tap the pattern repeats only after 2^bits − 1 steps, so it never lands
 * where a 16-step loop would: the clicks sound genuinely random and are exactly
 * reproducible, which is the whole trick of generative sequencing with one object.
 *
 * ── AND THE FM IS PHASE MODULATION, WHICH IS A DIFFERENT THING ──────────────
 * `osc~_1 → *c 63.5 → osc~_2.phase`, not `.freq`. Adding to the PHASE of a sine (rather
 * than to its frequency) is what a DX7 does; it keeps the carrier's pitch exactly where
 * the keyboard put it while the timbre changes, where true FM would drag the pitch
 * around with the index. Wired as written, on our `phase` input, in cycles.
 *
 * ── THE KEYBOARD SPLIT IS ONE KEYBOARD AND THREE ZONES ──────────────────────
 * The source has two `midi/in/keyb zone lru` objects (MIDI 0–50 and 63–127) plus the
 * string subpatch on the whole range. That is three `audio_ax_keyb` nodes reading ONE
 * `node_keyboard`, which is what a split IS — and it is why the zones had to be
 * expressible as knobs rather than as three separate keyboards.
 */
export const AXO_RADIOACTIVE = {
  id: "axo-radioactive",
  title: "Axoloti Radioactive (LFSR Geiger + FM + Strings)",
  help: "A self-playing Axoloti machine: an LFSR 'Geiger counter' at polynomial 0x198 firing a phase-modulated sine, a clock-gated acid bass, a played lead, a 16-step drum grid with a pitch-dropping kick, and the whole 7-voice string pad from the Strings patch as the upper half of a keyboard split. NOTE the bass arrives at the synth mixer MUTED at gain 0, exactly as the author saved it — raise the Bass level to hear it.",
  source: {
    patch: "axoloti-factory demos/sequencing/radioactive.axp",
    file: "patches/demos/sequencing/radioactive.axp @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    author: "Johannes Taelman (Axoloti factory patch)",
    popularity: "factory demo — the patch Axoloti's own sequencing folder leads with, and the only one in the corpus using `seq/lfsrseq`",
    distinct: 38,
    families: ["chaotic / generative sequencing", "FM / phase modulation", "polyphony with voice allocation"],
  },
  deviations: [
    ...STRING_VOICE_DEVIATIONS,
    "midi/in/script DROPPED — and it is not a loss: the object has NO nets at all in the source file, so it contributes nothing to the sound. Recorded because the survey lists it as a node this patch needs, and it does not.",
    "AUTOPLAY (§ R7-AUDIBLE) — AND THIS PATCH NEEDED NONE IN THE END, WHICH IS THE FIRST WAY AND THE BEST ONE. It was −inf dBFS on 2026-08-07 and a six-node autoplay branch was built for it; hours later AX-4's `env/adsr`, `env/ahd m` and `env/d` landed, and the harvested machine — its own 2 Hz square clock, its own 16-step grid, its own 0x198 LFSR — came alive on its own at −29.4 dBFS. MEASURED BOTH WAYS before deleting: the port without the branch is audible, and the branch on top of it pushed the peak from +0.6 to +2.2 dBFS, i.e. duplicate DSP that clipped. So the branch is gone and nothing in this patch is invented. WHAT REMAINS OF THAT WORK is the `audio_ax_midi_keyb` swap and one measurement: the harvested mix peaks at +0.6 dBFS through the standard 0.7 output, over `patch_sound_probe`'s +0.5 clip bar, so THIS patch's analysis tail runs at 0.45. That is our scaffolding and not a harvested gain — no mixer level in the port was touched. THE SNARE AND HAT ARE STILL SILENT AND THAT IS FAITHFUL: `steps`' p2 and p3 are 0 in the saved file, so the author wrote a kick-only pattern. The lead is silent too, because its note comes from a `node_keyboard` that cannot reach an engine module — see the deviation above.",
    "midi/in/keyb zone lru ×2 → two more `audio_ax_midi_keyb` (AX-1, shipped) reading the SAME `node_keyboard`, with their zones as knobs in the note outlet's own units (MIDI 0–50 is −64…−14; 63–127 is −1…63). Their least-recently-used mono allocation is the placeholder's problem, not this patch's.",
    "THREE `audio/out stereo` FOLD TO ONE BUS (drums L/R, synths, strings), per ADDENDUM 10 — 'If we have multiple audio outputs we'll just add them all together'. The drum bus keeps its stereo split as two mixers so the harvested per-channel gains survive: the kick is centred, the long noise hit is right-only and the short one left-only.",
    "ctrl/dial b ×2 → `node_knob`, KEPT as nodes rather than folded into their targets because each one feeds its destination through a `math/smooth` — turning the knob glides the clock rate or the FM pitch, which is a live gesture and not a static parameter.",
    "ctrl/toggle → a `node_knob` with step 1 over 0…1, multiplying the Geiger envelope. Same 0/1 semantics; we have no toggle widget with a number output.",
    "sel b 16 4t's p1 is stored as 2147483647 (0x7FFFFFFF) and transcribes to 65535. Its param is a `bin16` and the body reads `(p1 >> index) & 1` for index 0…15, so the high bits are never read — the two values behave identically, and 65535 is what our `audio_ax_steps_bool` (bin16, max 65535) can hold. Pattern p1 = every step.",
    "FIVE `audio_trigger` SCHMITTS INSERTED that the original does not have. Axoloti has one wire type; `core/nodeflow.js` refuses `audio → trigger` deliberately, because turning a continuous signal into events is a real operation with a real parameter (the hysteresis). So each place the source drops a square wave or a logic level onto a `bool32.rising` inlet — the LFO reset, the counter clock, the LFSR clock, and the two drum decay triggers — gets our Schmitt. SEQUENCED_DINGS documents the same insertion for the same reason.",
    "THE BASS ARRIVES MUTED and we kept it. `mix/mix 4`'s gain1 is 0.0 in the saved file, so the author left the bass voice out of the synth bus (and `mix1_2`'s gain1 is 0.0 too, a second dead branch on the lead). Faithful, because a mixer gain is how a patch sounds; called out in `help` because a silent voice otherwise reads as our bug.",
    "TWO-NODE GAIN CHAINS where one `*c` exceeded `audio_ax_math`'s ±16 `b`: 24 semitones of bass cutoff envelope (12 × 2) and 28 semitones of kick pitch drop (14 × 2). See this file's UNITS section.",
    "AS BUILT: 25 distinct types for the source's 38, and 93 nodes for its 82 objects. The type count falls to the overload collapse; the node count RISES because of the five Schmitts, the gain chains and the absorbed subpatch boundary.",
  ],
  nodes: (() => {
    const voice = stringVoice("st-", "keys", 1, 18);
    return [
      { id: "keys", type: "node_keyboard", col: 0, row: 0, w: 196, knobs: { baseNote: 36, octaves: 4 } },
      // ── THE MASTER CLOCK. Its rate is a knob through a very slow smoother (dial 63.5,
      // τ ≈ 1.4 s), so a change in tempo GLIDES. −20 on the knob plus the LFO's own −16
      // is −36 semitones, which is 0.64 Hz — this machine runs slow on purpose.
      { id: "clockdial", type: "node_knob", col: 1, row: 0, knobs: { value: -20, min: -64, max: 64, step: 0.5 } },
      { id: "clocksmooth", type: "audio_ax_smooth", col: 2, row: 0, knobs: { time: 63.5, enable: 1 } },
      { id: "clock", type: "audio_ax_lfo", col: 3, row: 0, knobs: { waveform: "square", pitch: -16 } },
      { id: "clockedge", type: "audio_trigger", col: 4, row: 0, knobs: { pulseMs: 5 } },
      // ── THE BASS (zone MIDI 0–50). The keyboard chooses the NOTE and the clock plays
      // it: both envelopes are gated by the square wave, and the clock is also mixed into
      // the pitch at 12 semitones, so every beat starts with an octave stab.
      { id: "basskeyb", type: "audio_ax_midi_keyb", col: 1, row: 2, knobs: { start_note: -64, end_note: -14 } },
      { id: "bassdepth", type: "audio_ax_math", col: 4, row: 2, knobs: { operation: "multiply", b: 6 } }, // SCALE: 6 × 2 = 12
      { id: "bassmix", type: "audio_mixer", col: 5, row: 2, knobs: { level1: 2, level4: 1, master: 1 } },
      { id: "basssaw", type: "audio_ax_osc", col: 6, row: 2, knobs: { waveform: "saw", pitch: -12 } },
      { id: "basshalve", type: "audio_ax_math", col: 7, row: 2, knobs: { operation: "divide2" } },
      { id: "bassvcf", type: "audio_ax_vcf3", col: 8, row: 2, knobs: { pitch: 24, reso: 62 } },
      { id: "bassvca", type: "audio_vca", col: 9, row: 2, knobs: { gain: 0 } },
      // ── EVERY ENVELOPE BELOW IS IN SECONDS, and every one of them was a raw `.axp` dial
      // until 2026-08-07. AX-4's a/d/r knobs are `LinearTimeExp`'s OUTPUT — its own D2 —
      // so a harvested dial goes through `axTimeDialSeconds`, and a `frac32.u.map` level
      // (every sustain here) is dial/64. The dials are kept in the comments because they
      // are what the source file says. The error they made was not subtle: a dial of −64
      // means 2.4 ms and was being read as 64 seconds, i.e. every one of these attacks was
      // pinned at the knob's 3.91 s ceiling and this patch had no transients at all.
      // dials −64 / −21 / 32 / −1
      { id: "bassfiltenv", type: "audio_ax_env_adsr", col: 5, row: 3, knobs: { a: 0.002408, d: 0.028862, s: 0.5, r: 0.091631 } },
      { id: "bassfiltgain", type: "audio_ax_math", col: 6, row: 3, knobs: { operation: "multiply", b: 12 } }, // SCALE: 12 × 2 = 24
      { id: "bassfiltgain2", type: "audio_ax_math", col: 7, row: 3, knobs: { operation: "multiply", b: 2 } },
      // dials −32 / −5 / 46.5 / 20
      { id: "bassampenv", type: "audio_ax_env_adsr", col: 5, row: 4, knobs: { a: 0.015289, d: 0.072727, s: 0.7265625, r: 0.308207 } },
      // ── THE LEAD (zone MIDI 63–127), played by hand: its envelopes take the
      // keyboard's gate2, so a legato line retriggers.
      { id: "melkeyb", type: "audio_ax_midi_keyb", col: 1, row: 5, knobs: { start_note: -1, end_note: 63 } },
      // level1 = 0 is the source's own dead branch: gate2 is wired into this mixer at
      // gain 0.0. Kept, because a gain the author zeroed is a decision, not a mistake.
      { id: "melmix", type: "audio_mixer", col: 5, row: 5, knobs: { level1: 0, level4: 1, master: 1 } },
      { id: "melsaw", type: "audio_ax_osc", col: 6, row: 5, knobs: { waveform: "saw", pitch: -12 } },
      { id: "melvcf", type: "audio_ax_vcf3", col: 8, row: 5, knobs: { pitch: 12, reso: 59.5 } },
      { id: "melvca", type: "audio_vca", col: 9, row: 5, knobs: { gain: 0 } },
      // dials −25 / −9 / 23.5 / −9
      { id: "melfiltenv", type: "audio_ax_env_adsr", col: 5, row: 6, knobs: { a: 0.022908, d: 0.057724, s: 0.3671875, r: 0.057724 } },
      { id: "melfiltgain", type: "audio_ax_math", col: 6, row: 6, knobs: { operation: "multiply", b: 16 } },
      // dials −32 / 10 / 0 / 23 — the sustain's dial 0 is 0 either way, which is why it alone
      // never tripped the range law and is unchanged.
      { id: "melampenv", type: "audio_ax_env_adsr", col: 5, row: 7, knobs: { a: 0.015289, d: 0.172976, s: 0, r: 0.366522 } },
      // ── THE GEIGER COUNTER. A fast square (pitch 27 → 24 Hz) clocks the shift
      // register, and the MASTER clock resets that square — so the aperiodic pattern is
      // re-seeded in time with everything else instead of drifting away from it.
      { id: "geigerlfo", type: "audio_ax_lfo", col: 5, row: 8, knobs: { waveform: "square", pitch: 27 } },
      { id: "geigeredge", type: "audio_trigger", col: 6, row: 8, knobs: { pulseMs: 5 } },
      { id: "lfsr", type: "audio_ax_lfsr_seq", col: 7, row: 8, knobs: { polynomial: 408 } },
      // dials −64 / 3 / 0 / −64. ⚠ `d`'s DIAL OF 3 IS THE ONE THE RANGE LAW COULD NOT SEE: three
      // seconds is inside the knob, so a raw dial that happens to land there reads as a legal
      // value. It is the same defect as its neighbours and is converted with them — 0.115 s,
      // not 3 s, which is the difference between a geiger tick and a swell.
      { id: "geigerenv", type: "audio_ax_env_adsr", col: 8, row: 8, knobs: { a: 0.002408, d: 0.115447, s: 0, r: 0.002408 } },
      { id: "geigergate", type: "node_knob", col: 8, row: 9, knobs: { value: 1, min: 0, max: 1, step: 1 } },
      { id: "geigermul", type: "audio_ax_math", col: 9, row: 8, knobs: { operation: "multiply" } },
      { id: "fmdial", type: "node_knob", col: 5, row: 10, knobs: { value: 19, min: -64, max: 64, step: 0.5 } },
      { id: "fmsmooth", type: "audio_ax_smooth", col: 6, row: 10, knobs: { time: 13.5, enable: 1 } },
      { id: "fmmod", type: "audio_ax_osc", col: 5, row: 11, knobs: { waveform: "sine", pitch: -7 } },
      // 0.49609375 = the harvested 63.5/64, halved: a frac32 phase wire of 1.0 is HALF a
      // cycle on the hardware and our `phase` port is in whole cycles.
      { id: "fmdepth", type: "audio_ax_math", col: 6, row: 11, knobs: { operation: "attenuate", b: 0.49609375 } },
      { id: "fmcarrier", type: "audio_ax_osc", col: 7, row: 11, knobs: { waveform: "sine", pitch: 5 } },
      { id: "geigervca", type: "audio_vca", col: 10, row: 11, knobs: { gain: 0 } },
      // ── THE DRUM GRID. One counter, one 16-step pattern word, and the ANDs with
      // `change` are what make a held step fire once per step instead of continuously.
      { id: "counter", type: "audio_ax_counter", col: 5, row: 12, knobs: { maximum: 16 } },
      { id: "steps", type: "audio_ax_steps_bool", col: 6, row: 12, knobs: { p1: 65535, p2: 0, p3: 0, p4: 0, pulse: 1 } },
      { id: "kickand", type: "audio_ax_logic", col: 7, row: 12, knobs: { operation: "and" } },
      { id: "kickedge", type: "audio_trigger", col: 8, row: 12, knobs: { pulseMs: 5 } },
      // `env/d`'s time constant in SECONDS, dial −32.5 through `axTimeDialSeconds` (AX-4 D2).
      { id: "kickenv", type: "audio_ax_env_decay", col: 9, row: 12, knobs: { d: 0.014854 } },
      { id: "kickpitch1", type: "audio_ax_math", col: 10, row: 12, knobs: { operation: "multiply", b: 14 } }, // SCALE: 14 × 2 = 28
      { id: "kickpitch2", type: "audio_ax_math", col: 11, row: 12, knobs: { operation: "multiply", b: 2 } },
      // ONE envelope drives BOTH the kick's amplitude and its pitch — 28 semitones of
      // drop over the decay, which is how a synth kick is made and why it thumps.
      { id: "kickosc", type: "audio_ax_osc", col: 12, row: 12, knobs: { waveform: "sine", pitch: -29 } },
      { id: "kickvca", type: "audio_vca", col: 13, row: 12, knobs: { gain: 0 } },
      { id: "change", type: "audio_ax_logic", col: 6, row: 13, knobs: { operation: "change" } },
      { id: "snredge", type: "audio_trigger", col: 7, row: 14, knobs: { pulseMs: 5 } },
      // dial 22. As a raw dial this asked for a 22-SECOND snare and got the knob's 3.91 s.
      { id: "snrenv", type: "audio_ax_env_decay", col: 8, row: 14, knobs: { d: 0.345951 } },
      { id: "snrvca", type: "audio_vca", col: 9, row: 14, knobs: { gain: 0 } },
      { id: "hatand", type: "audio_ax_logic", col: 7, row: 15, knobs: { operation: "and" } },
      { id: "hatedge", type: "audio_trigger", col: 8, row: 15, knobs: { pulseMs: 5 } },
      // dial −15.
      { id: "hatenv", type: "audio_ax_env_decay", col: 9, row: 15, knobs: { d: 0.040817 } },
      { id: "hatvca", type: "audio_vca", col: 10, row: 15, knobs: { gain: 0 } },
      // ONE noise source, two envelopes, two pan positions: a long hit on the right and a
      // short one on the left. That is the whole percussion section besides the kick.
      { id: "pink", type: "audio_ax_noise", col: 6, row: 16, knobs: { colour: "pink", seed: 0 } },
      { id: "synthmix", type: "audio_mixer", col: 14, row: 2, knobs: { level1: 0, level2: 0.9921875, level3: 0.4375, level4: 0, master: 1 } },
      { id: "drumsl", type: "audio_mixer", col: 14, row: 12, knobs: { level1: 1, level2: 0, level3: 0.9921875, master: 1 } },
      { id: "drumsr", type: "audio_mixer", col: 14, row: 13, knobs: { level1: 1, level2: 0.9921875, level3: 0, master: 1 } },
      // ── THE STRING PAD, verbatim from A1 (same function, same effective params) ──
      ...voice.nodes,
      { id: "chorus", type: "audio_ax_chorus", col: 12, row: 18, knobs: { depth: 2.5, speed: -47 } },
      { id: "stringsmix", type: "audio_mixer", col: 13, row: 18, knobs: { level1: 1, level2: 1, master: 1 } },
      { id: "bus", type: "audio_mixer", col: 15, row: 0, knobs: { level1: 1, level2: 1, level3: 1, level4: 1, master: 1 } },
      ...analysisTail(16, 0, AXO_RADIOACTIVE_OUTPUT_VOLUME),
    ];
  })(),
  wires: (() => {
    const voice = stringVoice("st-", "keys", 1, 18);
    return [
      { from: "clockdial", fromPort: "out", to: "clocksmooth", toPort: "in" },
      { from: "clocksmooth", fromPort: "out", to: "clock", toPort: "pitch" },
      { from: "clock", fromPort: "out", to: "clockedge", toPort: "in" },
      { from: "clockedge", fromPort: "out", to: "geigerlfo", toPort: "reset" },
      { from: "clockedge", fromPort: "out", to: "counter", toPort: "trig" },
      // The bass: keyboard picks the note, the clock plays it AND stabs its pitch.
      { from: "keys", fromPort: "pitch", to: "basskeyb", toPort: "pitch" },
      { from: "keys", fromPort: "gate", to: "basskeyb", toPort: "gate" },
      { from: "basskeyb", fromPort: "note", to: "bassmix", toPort: "in4" },
      { from: "clock", fromPort: "out", to: "bassdepth", toPort: "a" },
      { from: "bassdepth", fromPort: "out", to: "bassmix", toPort: "in1" },
      { from: "bassmix", fromPort: "out", to: "basssaw", toPort: "pitch" },
      { from: "basssaw", fromPort: "out", to: "basshalve", toPort: "a" },
      { from: "basshalve", fromPort: "out", to: "bassvcf", toPort: "in" },
      { from: "clock", fromPort: "out", to: "bassfiltenv", toPort: "gate" },
      { from: "clock", fromPort: "out", to: "bassampenv", toPort: "gate" },
      { from: "bassfiltenv", fromPort: "env", to: "bassfiltgain", toPort: "a" },
      { from: "bassfiltgain", fromPort: "out", to: "bassfiltgain2", toPort: "a" },
      { from: "bassfiltgain2", fromPort: "out", to: "bassvcf", toPort: "pitch" },
      { from: "bassvcf", fromPort: "out", to: "bassvca", toPort: "in" },
      { from: "bassampenv", fromPort: "env", to: "bassvca", toPort: "gain" },
      { from: "bassvca", fromPort: "out", to: "synthmix", toPort: "in1" },
      // The lead, played by hand.
      { from: "keys", fromPort: "pitch", to: "melkeyb", toPort: "pitch" },
      { from: "keys", fromPort: "gate", to: "melkeyb", toPort: "gate" },
      { from: "melkeyb", fromPort: "note", to: "melmix", toPort: "in4" },
      { from: "melkeyb", fromPort: "gate2", to: "melmix", toPort: "in1" },
      { from: "melmix", fromPort: "out", to: "melsaw", toPort: "pitch" },
      { from: "melsaw", fromPort: "out", to: "melvcf", toPort: "in" },
      { from: "melkeyb", fromPort: "gate2", to: "melfiltenv", toPort: "gate" },
      { from: "melkeyb", fromPort: "gate2", to: "melampenv", toPort: "gate" },
      { from: "melfiltenv", fromPort: "env", to: "melfiltgain", toPort: "a" },
      { from: "melfiltgain", fromPort: "out", to: "melvcf", toPort: "pitch" },
      { from: "melvcf", fromPort: "out", to: "melvca", toPort: "in" },
      { from: "melampenv", fromPort: "env", to: "melvca", toPort: "gain" },
      { from: "melvca", fromPort: "out", to: "synthmix", toPort: "in2" },
      // The Geiger voice: LFSR → envelope → (× toggle) → VCA, on a phase-modulated sine.
      { from: "geigerlfo", fromPort: "out", to: "geigeredge", toPort: "in" },
      { from: "geigeredge", fromPort: "out", to: "lfsr", toPort: "trig" },
      { from: "lfsr", fromPort: "out", to: "geigerenv", toPort: "gate" },
      { from: "geigergate", fromPort: "out", to: "geigermul", toPort: "a" },
      { from: "geigerenv", fromPort: "env", to: "geigermul", toPort: "b" },
      { from: "geigermul", fromPort: "out", to: "geigervca", toPort: "gain" },
      { from: "fmdial", fromPort: "out", to: "fmsmooth", toPort: "in" },
      { from: "fmsmooth", fromPort: "out", to: "fmcarrier", toPort: "pitch" },
      { from: "fmmod", fromPort: "out", to: "fmdepth", toPort: "a" },
      { from: "fmdepth", fromPort: "out", to: "fmcarrier", toPort: "phase" },
      { from: "fmcarrier", fromPort: "out", to: "geigervca", toPort: "in" },
      { from: "geigervca", fromPort: "out", to: "synthmix", toPort: "in3" },
      // The drums.
      { from: "counter", fromPort: "count", to: "steps", toPort: "index" },
      { from: "counter", fromPort: "count", to: "change", toPort: "a" },
      { from: "steps", fromPort: "o1", to: "kickand", toPort: "a" },
      { from: "change", fromPort: "out", to: "kickand", toPort: "b" },
      { from: "kickand", fromPort: "out", to: "kickedge", toPort: "in" },
      { from: "kickedge", fromPort: "out", to: "kickenv", toPort: "trig" },
      { from: "kickenv", fromPort: "env", to: "kickpitch1", toPort: "a" },
      { from: "kickpitch1", fromPort: "out", to: "kickpitch2", toPort: "a" },
      { from: "kickpitch2", fromPort: "out", to: "kickosc", toPort: "pitch" },
      { from: "kickosc", fromPort: "out", to: "kickvca", toPort: "in" },
      { from: "kickenv", fromPort: "env", to: "kickvca", toPort: "gain" },
      { from: "steps", fromPort: "o2", to: "snredge", toPort: "in" },
      { from: "snredge", fromPort: "out", to: "snrenv", toPort: "trig" },
      { from: "snrenv", fromPort: "env", to: "snrvca", toPort: "gain" },
      { from: "pink", fromPort: "out", to: "snrvca", toPort: "in" },
      { from: "steps", fromPort: "o3", to: "hatand", toPort: "a" },
      { from: "change", fromPort: "out", to: "hatand", toPort: "b" },
      { from: "hatand", fromPort: "out", to: "hatedge", toPort: "in" },
      { from: "hatedge", fromPort: "out", to: "hatenv", toPort: "trig" },
      { from: "hatenv", fromPort: "env", to: "hatvca", toPort: "gain" },
      { from: "pink", fromPort: "out", to: "hatvca", toPort: "in" },
      { from: "kickvca", fromPort: "out", to: "drumsl", toPort: "in1" },
      { from: "snrvca", fromPort: "out", to: "drumsl", toPort: "in2" },
      { from: "hatvca", fromPort: "out", to: "drumsl", toPort: "in3" },
      { from: "kickvca", fromPort: "out", to: "drumsr", toPort: "in1" },
      { from: "snrvca", fromPort: "out", to: "drumsr", toPort: "in2" },
      { from: "hatvca", fromPort: "out", to: "drumsr", toPort: "in3" },
      // The string pad, and the three buses folding into one.
      ...voice.wires,
      { from: voice.out, fromPort: "out", to: "chorus", toPort: "in" },
      { from: "chorus", fromPort: "l", to: "stringsmix", toPort: "in1" },
      { from: "chorus", fromPort: "r", to: "stringsmix", toPort: "in2" },
      { from: "synthmix", fromPort: "out", to: "bus", toPort: "in1" },
      { from: "drumsl", fromPort: "out", to: "bus", toPort: "in2" },
      { from: "drumsr", fromPort: "out", to: "bus", toPort: "in3" },
      { from: "stringsmix", fromPort: "out", to: "bus", toPort: "in4" },
      ...analysisWires("bus"),
    ];
  })(),
};

/** C4's autoplay note rate and length, and the two gains that turn a `rand/uniform i`
 *  draw into semitones. THE TWO GAINS ARE NOT A STYLE CHOICE: a 16-step draw leaves as
 *  `k/64` (their int32→frac32 coercion, AX-2's own note), so an octave of transposition
 *  wants ×51.2 and `audio_ax_math`'s `b` stops at ±16 — the same two-node SCALE chain
 *  this file's UNITS section describes, here reaching 0…11.25 semitones. */
const AXO_TRANQUILLE_NOTE_HZ = 0.4;
const AXO_TRANQUILLE_NOTE_DECAY = 0.015;
const AXO_TRANQUILLE_DRAW_SCALE_A = 16;
const AXO_TRANQUILLE_DRAW_SCALE_B = 3;

/**
 * C4's AUTOPLAY BRANCH — § R7-AUDIBLE's third way, and the most SUBSTITUTED of the three,
 * because C4 has no live source at all: its three oscillators are `audio_ax_16steps_dp2`
 * placeholders and so are both wavetable banks.
 *
 * So this stands in for the voice rather than driving it — three `audio_ax_osc` at the
 * harvested detunings (0, +0.02, −0.05 semitones, which is the two-and-five-cent beating
 * the patch's own docstring calls its character), gated by one `pulse/d` on a 0.4 Hz
 * clock, into the harvested `outl`/`outr`'s free `in2`.
 *
 * ── IT KEEPS THE RANDOMISATION, WHICH IS WHAT THE PATCH IS FOR ──────────────
 * A `rand/uniform i` draw at 16 steps chooses a fresh note on every clock, on the SAME
 * node type and the same step count the patch's own three draws use — so "no two notes
 * are the same" survives as PITCH where the original had it as TIMBRE. It gets its own
 * seed (3) rather than sharing one of the harvested three, for the reason C4's own
 * deviation already gives about seeds 0/1/2: two draws on one seed are one draw.
 *
 * ── WHAT IT CANNOT REACH, STATED PLAINLY ────────────────────────────────────
 * The "pseudo reverb" return — the crossed highpass/lowpass/allpass pair that is the only
 * other live thing in this patch — takes its input from `vcasend`, an `audio_ax_vca_stereo`
 * placeholder, and an input port holds exactly one wire. So the branch is DRY only, and
 * the two 341 ms allpasses stay silent until AX-4 lands. Splicing into `hpl.in` would mean
 * deleting a harvested wire, which is not a trade worth making for a tail.
 */
const AXO_TRANQUILLE_AUTOPLAY = (() => {
  const clock = autoClock("ap", 0, 12, AXO_TRANQUILLE_NOTE_HZ);
  const note = autoNote("apAmp", 7, 13, {
    trig: { item: clock.trig, port: "out" }, source: { item: "apMix", port: "out" },
    vcaCol: 10, decay: AXO_TRANQUILLE_NOTE_DECAY,
  });
  // The three detunings are the harvested oscillators' own, kept to the cent.
  const voices = [
    { id: "apOsc1", waveform: "sine", pitch: 0, row: 12 },
    { id: "apOsc2", waveform: "pwm", pitch: 0.02, row: 13 },
    { id: "apOsc3", waveform: "saw", pitch: -0.05, row: 14 },
  ];
  return {
    nodes: [
      ...clock.nodes,
      { id: "apRand", type: "audio_ax_rand", col: 2, row: 12, knobs: { mode: "trig", steps: 16, seed: 3 } },
      { id: "apDraw1", type: "audio_ax_math", col: 3, row: 12, knobs: { operation: "multiply", b: AXO_TRANQUILLE_DRAW_SCALE_A } },
      { id: "apDraw2", type: "audio_ax_math", col: 4, row: 12, knobs: { operation: "multiply", b: AXO_TRANQUILLE_DRAW_SCALE_B } },
      ...voices.map((v) => ({ id: v.id, type: "audio_ax_osc", col: 5, row: v.row, knobs: { waveform: v.waveform, pitch: v.pitch } })),
      // UNITY ON THREE INPUTS IS A PEAK OF THREE, and that — not the return level — is
      // where C4's headroom went. Measured: at unity this branch rendered at −0.9 dBFS,
      // and cutting the RETURN by 4.2 dB moved the peak by 0.6, which is the output
      // limiter answering rather than the level. Three near-unison oscillators sum
      // coherently, so the honest place to normalise is the sum itself.
      { id: "apMix", type: "audio_mixer", col: 6, row: 13, knobs: { level1: AUTOPLAY_VOICE_SUM_LEVEL, level2: AUTOPLAY_VOICE_SUM_LEVEL, level3: AUTOPLAY_VOICE_SUM_LEVEL, master: 1 } },
      ...note.nodes,
    ],
    wires: [
      ...clock.wires,
      { from: clock.trig, fromPort: "out", to: "apRand", toPort: "trig" },
      { from: "apRand", fromPort: "out", to: "apDraw1", toPort: "a" },
      { from: "apDraw1", fromPort: "out", to: "apDraw2", toPort: "a" },
      ...voices.map((v) => ({ from: "apDraw2", fromPort: "out", to: v.id, toPort: "pitch" })),
      ...voices.map((v, i) => ({ from: v.id, fromPort: "out", to: "apMix", toPort: `in${i + 1}` })),
      ...note.wires,
      { from: note.out, fromPort: "out", to: "outl", toPort: "in2" },
      { from: note.out, fromPort: "out", to: "outr", toPort: "in2" },
    ],
  };
})();

/**
 * C4 — TRANQUILLE — `tiar/synths/Tranquille.axp`.
 *
 * A real wavetable synth, and the randomisation IS the patch: three 16-step waveform
 * banks (two spectral, one power-law) are indexed by random draws on a clock, and the
 * chosen waveforms are pushed as DATA into three oscillators that reload them at
 * note-on. So every note is a different instrument — but a note holds one timbre steady
 * for its whole length, because the latch is on the gate's rising edge.
 *
 * ── WHAT THE THREE OSCILLATORS ARE DOING ────────────────────────────────────
 * Detuned by 0, +0.02 and −0.05 semitones — two and five cents, so the three beat
 * against each other over seconds rather than sounding like a chord. Each one's output
 * goes to TWO VCAs, and the six VCA gains come from ONE tri-phase LFO on an 8-second
 * cycle: three sines 120° apart, so the crossfade between the three waveforms sums to a
 * constant and the level never dips. The second set of three is ROTATED, which is what
 * makes the "pseudo-reverb" send a different blend from the dry path.
 *
 * ── AND THE "PSEUDO REVERB" IS A CHANNEL SWAP, NOT A REVERB ─────────────────
 * The slow envelope's stereo VCA sends its LEFT output to the right return and its RIGHT
 * to the left, through a highpass, a lowpass and a 341 ms modulated allpass per side.
 * There is no reverb object anywhere in it: the sense of space is a slow envelope, a
 * crossed pair and two allpasses wobbling at 0.4 Hz.
 */
export const AXO_TRANQUILLE = {
  id: "axo-tranquille",
  title: "Axoloti Tranquille (Random Wavetables)",
  help: "A three-voice wavetable synth whose waveforms are drawn at RANDOM from three spectral banks and latched at every note-on, so no two notes are the same instrument. Three oscillators two and five cents apart crossfade under one 8-second tri-phase LFO, then a channel-swapped pair of 341 ms modulated allpasses fakes a reverb with no reverb in it.",
  source: {
    patch: "axoloti-contrib tiar/synths/Tranquille.axp",
    file: "patches/tiar/synths/Tranquille.axp @ 798166f0ce29f4b6a39099b3bde6ef2e7755a7c4 (tag 1.0.12)",
    author: "Smashed Transistors (tiar)",
    popularity: "the most-cited author in axoloti-contrib — 27 of his objects are pulled in by this survey's picks, and his synth patches are the corpus's reference material",
    distinct: 24,
    families: ["wavetable", "polyphony with voice allocation"],
  },
  deviations: [
    "patch/patcher poly=3 → `audio_ax_poly_voices` (placeholder) with the voice drawn once. See this file's POLYPHONY section.",
    "patch/inlet a ×3, patch/inlet f ×3 and patch/outlet a ×4 ABSORBED — ten instances of three types. They exist only to name the subpatch boundary, and a flat graph crosses it with one wire. This is the patch that proves a subpatch WRAPPER placeholder was impossible: its patcher has six inlets and four outlets where A1's has none and one.",
    "midi/in/keyb → AX-1's shipped `audio_ax_midi_keyb`, driven by a `node_keyboard`, as in the Strings patch and for the same unit reason. THE KEYBOARD IS DECORATIVE and could not be fixed from this file — see A1's deviation of the same name and this file's AUTOPLAY section.",
    "AUTOPLAY (§ R7-AUDIBLE, the THIRD way; eleven `ap*` nodes) — and here it SUBSTITUTES rather than drives, because C4 has no live source at all: all three oscillators and both wavetable banks are placeholders. Three `audio_ax_osc` at the harvested detunings (0 / +0.02 / −0.05 semitones) are gated by one `pulse/d` on a 0.4 Hz clock and land on `outl`/`outr`'s free `in2`. A `rand/uniform i` draw at the SAME 16 steps the harvested three use picks a fresh note per clock, so the source’s own “no two notes are the same” survives as pitch where the original had it as timbre; its seed is 3, distinct from the harvested 0/1/2 for the reason the seed deviation above gives. IT IS DRY ONLY: the crossed allpass return takes its input from the `audio_ax_vca_stereo` placeholder and an input port holds one wire, so the two 341 ms allpasses stay silent until AX-4 lands. Measured before: −inf dBFS.",
    "THE THREE RANDOM DRAWS CARRY SEEDS 0, 1, 2. Theirs read the STM32 hardware RNG, so the three `rand/uniform i` instances are independent by accident of hardware; ours are seeded, because a document that renders differently every time is not a document (AX-2's deviation D4). Three identical seeds would hand all three oscillators the SAME waveform and destroy the patch, so the seeds differ — a choice the source did not have to make and we do.",
    "THE `wf16` PORTS ARE TYPED `audio` AND THEY ARE NOT AUDIO. On hardware a waveform bus and an audio bus are both a `frac32buffer`; this one holds 32 int16 harmonic amplitudes. `core/nodeflow.js` has no wavetable port type and adding one is outside this agent's ownership, so the widest honest type is used and the patch's own warning is repeated here: *\"<— These are wf_16 waveforms, not audio !!!\"*. Reported to the lead as the one place this corpus wants a fifth port type.",
    "TSG/filter/allpass m → `audio_ax_allpass` (shipped). His `time` inlet is a Q27 FRACTION of a power-of-two buffer; ours is a sample count, so dial 51.0 of a 16384-sample buffer is 13056 samples (341 ms × 51/64) and 51.48 is 13179. His `timemod` inlet folds into our `delay` input, which sums with the knob. His 3-point interpolation is not ported (AX-3 says so); `location=ExtRAM` has no meaning here.",
    "THREE-NODE GAIN CHAINS on the two allpass modulations (16 × 16 × 7.475 = 1913 samples, and × 7 = 1792), and a two-node chain on one highpass (9.5 × 2 = 19 semitones). Their `*c` dials are fractions of a 16384-sample buffer or spans of semitones, and `audio_ax_math`'s `b` stops at ±16. See UNITS.",
    "ctrl/dial p ×4 FOLDED into the two Allpass nodes' own `g` and `delay` knobs. Every parameter is already a knob on the card here, so a separate dial node would be a second control for one value — and unlike Radioactive's dials, these feed their target directly with no smoother, so nothing is lost. g dial 64.0 is g = 1.0, which is where the allpass stops decaying; faithful, and AX-3 notes the ±16 fold that catches it.",
    "sss/gain/vcaST → `audio_ax_vca_stereo` (placeholder), NOT two `audio_vca`s. One gain over two channels is the point: two VCAs could drift apart and this cannot, which is what keeps the pair centred.",
    "sss/audio/StOutVol DROPPED in favour of the mandatory meter → spectrum → Output tail, and the stereo pair folds to one mono bus. Its volume dial 64.0 is unity; our Output sits at 0.7 and limits where the hardware hard-clips.",
    "gain/vca ×6 → `audio_vca`; mix/mix 3 ×2 and mix/mix 1 ×2 → `audio_mixer` with `in4` as `bus_in`, gains as dial ÷ 64 (32.055 → 0.5008…); math/*c ×6 → `audio_ax_math`; filter/hp1 m and lp1 m → the shipped `audio_ax_onepole` (whose −3 dB corner is its knob ÷ π, reproduced); conv/bipolar2unipolar → `audio_ax_convert`; tiar/logic/rising → `audio_ax_logic`'s `rising`; rand/uniform i → `audio_ax_rand` with steps 16.",
    "ONE `audio_trigger` SCHMITT INSERTED between the wavetable clock and the three random draws — `audio → trigger` is refused deliberately (see A9's note on the same insertion).",
    "AS BUILT: 22 distinct types and 57 nodes for the source's 24 types and 61 objects.",
  ],
  nodes: [
    { id: "keys", type: "node_keyboard", col: 0, row: 0, w: 196, knobs: { baseNote: 48, octaves: 2 } },
    { id: "keyb", type: "audio_ax_midi_keyb", col: 1, row: 0, knobs: { start_note: -64, end_note: 63 } },
    { id: "poly", type: "audio_ax_poly_voices", col: 2, row: 0, knobs: { voices: 3 } },
    // ── THE WAVEFORM CROSSFADE. One accumulator, three phases 120° apart, so the three
    // gains always sum to the same total — a crossfade that cannot dip.
    { id: "xlfo", type: "audio_ax_triphase_vlfo", col: 0, row: 3, knobs: { cycle: 8 } },
    { id: "x0", type: "audio_ax_convert", col: 1, row: 3, knobs: { mode: "bipolarToUnipolar" } },
    { id: "x120", type: "audio_ax_convert", col: 1, row: 4, knobs: { mode: "bipolarToUnipolar" } },
    { id: "x240", type: "audio_ax_convert", col: 1, row: 5, knobs: { mode: "bipolarToUnipolar" } },
    // ── THE RANDOM WAVETABLE DRAW, five times a second (LFO pitch 0 → 5.15 Hz). The
    // oscillators only LOOK at it on a note's rising edge, so the churn is inaudible and
    // what you hear is one fresh timbre per note.
    { id: "wtclock", type: "audio_ax_lfo", col: 0, row: 6, knobs: { waveform: "square", pitch: 0 } },
    { id: "wtedge", type: "audio_trigger", col: 1, row: 6, knobs: { pulseMs: 5 } },
    { id: "rnd1", type: "audio_ax_rand", col: 2, row: 5, knobs: { mode: "trig", steps: 16, seed: 0 } },
    { id: "rnd2", type: "audio_ax_rand", col: 2, row: 6, knobs: { mode: "trig", steps: 16, seed: 1 } },
    { id: "rnd3", type: "audio_ax_rand", col: 2, row: 7, knobs: { mode: "trig", steps: 16, seed: 2 } },
    { id: "bank1", type: "audio_ax_wf16_bank_spktra", col: 3, row: 5 },
    { id: "bank2", type: "audio_ax_wf16_bank_spktra", col: 3, row: 6 },
    { id: "bank3", type: "audio_ax_wf16_bank_pwr", col: 3, row: 7 },
    { id: "latch", type: "audio_ax_logic", col: 3, row: 1, knobs: { operation: "rising" } },
    { id: "osc1", type: "audio_ax_16steps_dp2", col: 4, row: 0, knobs: { pitch: 0 } },
    { id: "osc2", type: "audio_ax_16steps_dp2", col: 4, row: 1, knobs: { pitch: 0.02 } },
    { id: "osc3", type: "audio_ax_16steps_dp2", col: 4, row: 2, knobs: { pitch: -0.05 } },
    // Six VCAs: three for the dry blend, three for the send — and the send's LFO phases
    // are ROTATED against the dry's, which is why the two paths never carry the same mix.
    { id: "vcadry1", type: "audio_vca", col: 5, row: 0, knobs: { gain: 0 } },
    { id: "vcadry2", type: "audio_vca", col: 5, row: 1, knobs: { gain: 0 } },
    { id: "vcadry3", type: "audio_vca", col: 5, row: 2, knobs: { gain: 0 } },
    { id: "vcasend1", type: "audio_vca", col: 5, row: 3, knobs: { gain: 0 } },
    { id: "vcasend2", type: "audio_vca", col: 5, row: 4, knobs: { gain: 0 } },
    { id: "vcasend3", type: "audio_vca", col: 5, row: 5, knobs: { gain: 0 } },
    { id: "mixdry", type: "audio_mixer", col: 6, row: 0, knobs: { level1: 0.500859375, level2: 0.501484375, level3: 0.500937500, master: 1 } },
    { id: "mixsend", type: "audio_mixer", col: 6, row: 3, knobs: { level1: 0.513828125, level2: 0.526171875, level3: 0.506875000, master: 1 } },
    // TWO envelopes on the SAME note: a fast one for the dry pair and a very slow one
    // (attack dial 17, sustain full) for the send, so the space swells in behind the note.
    // IN SECONDS. dials −64 / 34 / 6.5 / 26 through `axTimeDialSeconds` (a/d/r) and dial/64
    // (sustain) — AX-4's D2. As dials both of these envelopes sat on the knob's 3.91 s
    // ceiling in every stage, so "fast" and "slow" were the same envelope.
    { id: "envfast", type: "audio_ax_env_adsr", col: 3, row: 8, knobs: { a: 0.002408, d: 0.691902, s: 0.1015625, r: 0.435871 } },
    // dials 17 / 52 / 64 / 36.61
    { id: "envslow", type: "audio_ax_env_adsr", col: 3, row: 9, knobs: { a: 0.259171, d: 1.956995, s: 1, r: 0.804487 } },
    { id: "vcadry", type: "audio_ax_vca_stereo", col: 7, row: 0 },
    { id: "vcasend", type: "audio_ax_vca_stereo", col: 7, row: 3 },
    // The return path, per side: highpass → lowpass → 341 ms allpass, every corner and
    // both delays modulated by their own tri-phase LFO.
    { id: "hpl", type: "audio_ax_onepole", col: 8, row: 3, knobs: { pitch: 22.5, mode: "highpass" } },
    { id: "lpl", type: "audio_ax_onepole", col: 9, row: 3, knobs: { pitch: 31.5, mode: "lowpass" } },
    { id: "apl", type: "audio_ax_allpass", col: 10, row: 3, knobs: { delay: 13056, g: 1 } },
    { id: "hpr", type: "audio_ax_onepole", col: 8, row: 4, knobs: { pitch: 22, mode: "highpass" } },
    { id: "lpr", type: "audio_ax_onepole", col: 9, row: 4, knobs: { pitch: 30.5, mode: "lowpass" } },
    { id: "apr", type: "audio_ax_allpass", col: 10, row: 4, knobs: { delay: 13179, g: 1 } },
    { id: "hplfo", type: "audio_ax_triphase_vlfo", col: 6, row: 6, knobs: { cycle: 2.565 } },
    { id: "hplmod", type: "audio_ax_math", col: 7, row: 6, knobs: { operation: "multiply", b: 16 } },
    { id: "hprmod1", type: "audio_ax_math", col: 7, row: 7, knobs: { operation: "multiply", b: 9.5 } }, // SCALE: 9.5 × 2 = 19
    { id: "hprmod2", type: "audio_ax_math", col: 8, row: 7, knobs: { operation: "multiply", b: 2 } },
    { id: "lplfo", type: "audio_ax_triphase_vlfo", col: 6, row: 8, knobs: { cycle: 3 } },
    { id: "lplmod", type: "audio_ax_math", col: 7, row: 8, knobs: { operation: "multiply", b: 9.5 } },
    { id: "lprmod", type: "audio_ax_math", col: 7, row: 9, knobs: { operation: "multiply", b: 10 } },
    { id: "aplfo", type: "audio_ax_triphase_vlfo", col: 6, row: 10, knobs: { cycle: 2.5 } },
    // SCALE ×3: their dial is a fraction of the 16384-sample buffer and ours is samples,
    // so 7.475/64 × 16384 = 1913 — three multiplies, because b stops at 16.
    { id: "aplmod1", type: "audio_ax_math", col: 7, row: 10, knobs: { operation: "multiply", b: 16 } },
    { id: "aplmod2", type: "audio_ax_math", col: 8, row: 10, knobs: { operation: "multiply", b: 16 } },
    { id: "aplmod3", type: "audio_ax_math", col: 9, row: 10, knobs: { operation: "multiply", b: 7.475 } },
    { id: "aprmod1", type: "audio_ax_math", col: 7, row: 11, knobs: { operation: "multiply", b: 16 } },
    { id: "aprmod2", type: "audio_ax_math", col: 8, row: 11, knobs: { operation: "multiply", b: 16 } },
    { id: "aprmod3", type: "audio_ax_math", col: 9, row: 11, knobs: { operation: "multiply", b: 7 } },
    // `level2` ON BOTH OUTPUT MIXERS IS THE AUTOPLAY RETURN, halved across the pair for
    // the same reason A9 halves its kick: one mono voice mixed to L and R is one voice.
    { id: "outl", type: "audio_mixer", col: 11, row: 0, knobs: { level1: 0.4609375, level2: AUTOPLAY_CENTRED_LEVEL, level4: 1, master: 1 } },
    { id: "outr", type: "audio_mixer", col: 11, row: 1, knobs: { level1: 0.4921875, level2: AUTOPLAY_CENTRED_LEVEL, level4: 1, master: 1 } },
    { id: "bus", type: "audio_mixer", col: 12, row: 0, knobs: { level1: 1, level2: 1, master: 1 } },
    ...analysisTail(13),
    ...AXO_TRANQUILLE_AUTOPLAY.nodes,
  ],
  wires: [
    { from: "keys", fromPort: "pitch", to: "keyb", toPort: "pitch" },
    { from: "keys", fromPort: "gate", to: "keyb", toPort: "gate" },
    { from: "keyb", fromPort: "note", to: "poly", toPort: "note" },
    { from: "keyb", fromPort: "gate", to: "poly", toPort: "gate" },
    { from: "keyb", fromPort: "gate2", to: "poly", toPort: "gate2" },
    { from: "keyb", fromPort: "velocity", to: "poly", toPort: "velocity" },
    { from: "keyb", fromPort: "release_velocity", to: "poly", toPort: "release_velocity" },
    { from: "poly", fromPort: "note", to: "osc1", toPort: "pitch" },
    { from: "poly", fromPort: "note", to: "osc2", toPort: "pitch" },
    { from: "poly", fromPort: "note", to: "osc3", toPort: "pitch" },
    // THE LATCH IS THE PATCH: one rising edge per note reloads all three waveforms.
    { from: "poly", fromPort: "gate", to: "latch", toPort: "a" },
    { from: "latch", fromPort: "out", to: "osc1", toPort: "update" },
    { from: "latch", fromPort: "out", to: "osc2", toPort: "update" },
    { from: "latch", fromPort: "out", to: "osc3", toPort: "update" },
    { from: "wtclock", fromPort: "out", to: "wtedge", toPort: "in" },
    { from: "wtedge", fromPort: "out", to: "rnd1", toPort: "trig" },
    { from: "wtedge", fromPort: "out", to: "rnd2", toPort: "trig" },
    { from: "wtedge", fromPort: "out", to: "rnd3", toPort: "trig" },
    { from: "rnd1", fromPort: "out", to: "bank1", toPort: "select" },
    { from: "rnd2", fromPort: "out", to: "bank2", toPort: "select" },
    { from: "rnd3", fromPort: "out", to: "bank3", toPort: "select" },
    { from: "bank1", fromPort: "waveform", to: "osc1", toPort: "wf16" },
    { from: "bank2", fromPort: "waveform", to: "osc2", toPort: "wf16" },
    { from: "bank3", fromPort: "waveform", to: "osc3", toPort: "wf16" },
    { from: "xlfo", fromPort: "phi_0", to: "x0", toPort: "in" },
    { from: "xlfo", fromPort: "phi_120", to: "x120", toPort: "in" },
    { from: "xlfo", fromPort: "phi_240", to: "x240", toPort: "in" },
    // The dry trio takes phases 0 / 120 / 240; the send trio takes them ROTATED, which
    // is the whole reason the send carries a different blend from the dry.
    { from: "x0", fromPort: "out", to: "vcadry1", toPort: "gain" },
    { from: "x120", fromPort: "out", to: "vcadry2", toPort: "gain" },
    { from: "x240", fromPort: "out", to: "vcadry3", toPort: "gain" },
    { from: "x120", fromPort: "out", to: "vcasend1", toPort: "gain" },
    { from: "x240", fromPort: "out", to: "vcasend2", toPort: "gain" },
    { from: "x0", fromPort: "out", to: "vcasend3", toPort: "gain" },
    { from: "osc1", fromPort: "out", to: "vcadry1", toPort: "in" },
    { from: "osc2", fromPort: "out", to: "vcadry2", toPort: "in" },
    { from: "osc3", fromPort: "out", to: "vcadry3", toPort: "in" },
    { from: "osc1", fromPort: "out", to: "vcasend1", toPort: "in" },
    { from: "osc2", fromPort: "out", to: "vcasend2", toPort: "in" },
    { from: "osc3", fromPort: "out", to: "vcasend3", toPort: "in" },
    { from: "vcadry1", fromPort: "out", to: "mixdry", toPort: "in1" },
    { from: "vcadry2", fromPort: "out", to: "mixdry", toPort: "in2" },
    { from: "vcadry3", fromPort: "out", to: "mixdry", toPort: "in3" },
    { from: "vcasend1", fromPort: "out", to: "mixsend", toPort: "in1" },
    { from: "vcasend2", fromPort: "out", to: "mixsend", toPort: "in2" },
    { from: "vcasend3", fromPort: "out", to: "mixsend", toPort: "in3" },
    { from: "poly", fromPort: "gate", to: "envfast", toPort: "gate" },
    { from: "poly", fromPort: "gate", to: "envslow", toPort: "gate" },
    { from: "mixdry", fromPort: "out", to: "vcadry", toPort: "a1" },
    { from: "mixsend", fromPort: "out", to: "vcadry", toPort: "a2" },
    { from: "envfast", fromPort: "env", to: "vcadry", toPort: "v" },
    { from: "mixdry", fromPort: "out", to: "vcasend", toPort: "a1" },
    { from: "mixsend", fromPort: "out", to: "vcasend", toPort: "a2" },
    { from: "envslow", fromPort: "env", to: "vcasend", toPort: "v" },
    // THE CHANNEL SWAP. The send's o1 is the source's "right rev" and its o2 is
    // "left rev" — the returns are crossed, which is the whole "pseudo reverb".
    { from: "vcasend", fromPort: "o2", to: "hpl", toPort: "in" },
    { from: "vcasend", fromPort: "o1", to: "hpr", toPort: "in" },
    { from: "hpl", fromPort: "out", to: "lpl", toPort: "in" },
    { from: "lpl", fromPort: "out", to: "apl", toPort: "in" },
    { from: "hpr", fromPort: "out", to: "lpr", toPort: "in" },
    { from: "lpr", fromPort: "out", to: "apr", toPort: "in" },
    { from: "hplfo", fromPort: "phi_0", to: "hplmod", toPort: "a" },
    { from: "hplmod", fromPort: "out", to: "hpl", toPort: "pitch" },
    { from: "hplfo", fromPort: "phi_120", to: "hprmod1", toPort: "a" },
    { from: "hprmod1", fromPort: "out", to: "hprmod2", toPort: "a" },
    { from: "hprmod2", fromPort: "out", to: "hpr", toPort: "pitch" },
    { from: "lplfo", fromPort: "phi_120", to: "lplmod", toPort: "a" },
    { from: "lplmod", fromPort: "out", to: "lpl", toPort: "pitch" },
    { from: "lplfo", fromPort: "phi_0", to: "lprmod", toPort: "a" },
    { from: "lprmod", fromPort: "out", to: "lpr", toPort: "pitch" },
    { from: "aplfo", fromPort: "phi_120", to: "aplmod1", toPort: "a" },
    { from: "aplmod1", fromPort: "out", to: "aplmod2", toPort: "a" },
    { from: "aplmod2", fromPort: "out", to: "aplmod3", toPort: "a" },
    { from: "aplmod3", fromPort: "out", to: "apl", toPort: "delay" },
    { from: "aplfo", fromPort: "phi_0", to: "aprmod1", toPort: "a" },
    { from: "aprmod1", fromPort: "out", to: "aprmod2", toPort: "a" },
    { from: "aprmod2", fromPort: "out", to: "aprmod3", toPort: "a" },
    { from: "aprmod3", fromPort: "out", to: "apr", toPort: "delay" },
    { from: "vcadry", fromPort: "o1", to: "outl", toPort: "in4" },
    { from: "vcadry", fromPort: "o2", to: "outr", toPort: "in4" },
    { from: "apl", fromPort: "out", to: "outl", toPort: "in1" },
    { from: "apr", fromPort: "out", to: "outr", toPort: "in1" },
    { from: "outl", fromPort: "out", to: "bus", toPort: "in1" },
    { from: "outr", fromPort: "out", to: "bus", toPort: "in2" },
    ...analysisWires("bus"),
    ...AXO_TRANQUILLE_AUTOPLAY.wires,
  ],
};

/** This set's blueprints. See the PATCH-SET CONTRACT in core/audio_patch_sets.js. */
export const BLOCK_PATCHES = [AXO_STRING_PAD, AXO_RADIOACTIVE, AXO_TRANQUILLE];
