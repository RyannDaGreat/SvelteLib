/**
 * DEMO PATCHES — fully-wired working patches, as pure item-graph BLUEPRINTS.
 *
 * ── THE STANDING DIRECTIVE (user, ADDENDUM 10, verbatim) ────────────────────
 * "We should have a menu called, well, in the command palette by the way, called
 * demo patches that will insert a demo patch in a group that is just a fully patched
 * audio thing. If we have multiple audio outputs by the way, we'll just add them all
 * together. I want to see a bunch of patches, so once you have everything, as you go
 * by the way, just make demo patches. I want to see demo patches. Demo patches are
 * freaking awesome."
 *
 * So this is not a one-time fixture: EVERY module wave adds patches here. A module
 * that ships without a patch showing it off has shipped without the thing the user
 * asked to see.
 *
 * ── WHY A BLUEPRINT AND NOT A BUILDER FUNCTION ──────────────────────────────
 * synth/patches.js builds the same sounds by calling the ENGINE directly, which is
 * right for dev.html and for proving the API is sufficient. These patches are the
 * other half: they build DOCUMENT ITEMS, so the patch appears on the canvas as
 * widgets the author can see, drag, rewire and keyframe — which is the entire point
 * of a node editor. The engine graph then falls out of the document through the
 * mirror, exactly as it would if the author had wired it by hand.
 *
 * A blueprint is data: `{title, help, nodes: [...], wires: [...]}` where a node names
 * a widget type, a grid position and its knob overrides. Being data means
 * tests/audio_nodes_test.js and tests/audio_patches_test.js can check every patch
 * without an app, an AudioContext, or a browser — that every type exists, every wire
 * names ports that exist and typecheck, and every knob is real.
 *
 * ── LAYOUT IS A GRID, AND THE GRID IS THE SIGNAL FLOW ───────────────────────
 * A node's position is `{col, row}`, not pixels. Columns run left to right in
 * SIGNAL ORDER (the user's Reaktor reference, ADDENDUM 1: "I'm looking for like
 * reactor type left to right flows"), so a patch reads as a chain rather than as a
 * pile, and `patchLayout` turns that into world coordinates at insert time. Using a
 * grid rather than literal x/y means a patch cannot be authored with two nodes on
 * top of each other, and it means the whole family can be re-spaced by changing two
 * constants instead of editing every patch.
 *
 * ── EVERY PATCH ENDS IN A METER AND A SPECTRUM ──────────────────────────────
 * Deliberate, and the brief asks for it: "each with a meter and spectrum node
 * patched in so the canvas is ALIVE." Both are pass-through modules, so inserting
 * them changes nothing about the sound — they only make it VISIBLE. A patch that
 * plays but shows nothing looks identical to a patch that is silent, which is the
 * same failure the autoplay badge exists to prevent.
 */

/** Horizontal and vertical spacing of the patch grid, in world units. The column
 *  pitch leaves room for a default-width node (150) plus a wire long enough to read
 *  as a curve rather than as a butt joint. */
export const PATCH_COL = 210;
export const PATCH_ROW = 130;

/**
 * Pure function. A blueprint node's world position, given the patch's origin.
 *
 * @param {{col: number, row: number}} node - a blueprint node
 * @param {{x: number, y: number}} origin - the patch's top-left in world units
 * @returns {{x: number, y: number}}
 *
 * @example patchLayout({col: 0, row: 0}, {x: 100, y: 100}) // {x: 100, y: 100}
 * @example patchLayout({col: 2, row: 1}, {x: 0, y: 0}) // {x: 420, y: 130}
 */
export function patchLayout(node, origin) {
  return { x: origin.x + node.col * PATCH_COL, y: origin.y + node.row * PATCH_ROW };
}

/** The analysis tail every patch ends with, at a given column. Written once because
 *  four patches share it and a divergence would be meaningless variety. */
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
 * SPACEY PAD DRONE — the blueprint's own acceptance patch, and the sound the whole
 * project is about (the user: "harmonic ambience pad type synths in the background",
 * "so it kind of sounds like we're whooshing around in space").
 *
 * pad → filter (LFO on cutoff) → deep-space reverb → meter → spectrum → out.
 *
 * WHY AN LFO ON THE FILTER when the pad already has its own internal sweep: the
 * internal one is fixed inside the module, and the whole point of a node editor is
 * to SHOW the composition. A visible LFO wired to a visible cutoff is the patch
 * teaching what it does; a hidden one is a preset.
 */
export const SPACEY_PAD_DRONE = {
  id: "spacey-pad-drone",
  title: "Spacey Pad Drone",
  help: "The ambience bed: a detuned pad through a slowly-swept filter into a deep-space reverb. Wire something else into the LFO's rate to make the sweep respond to your slide.",
  nodes: [
    { id: "pad", type: "audio_pad", col: 0, row: 0, knobs: { frequency: 82.41, level: 0.4, space: "deepSpace", cutoff: 700, motion: 0.05 } },
    { id: "lfo", type: "audio_lfo", col: 0, row: 1, knobs: { frequency: 0.05, depth: 600, waveform: "sine" } },
    { id: "filter", type: "audio_filter", col: 1, row: 0, knobs: { frequency: 900, Q: 3, type: "lowpass" } },
    { id: "reverb", type: "audio_reverb", col: 2, row: 0, knobs: { character: "deepSpace", wet: 0.6, dry: 0.5, preDelay: 0.04 } },
    ...analysisTail(3),
  ],
  wires: [
    { from: "pad", fromPort: "out", to: "filter", toPort: "in" },
    // THE LFO DRIVES THE CUTOFF. `frequency` is a `number` input (an AudioParam a
    // wire can drive), which is what makes this legal — and it is the single most
    // useful patch in the whole library.
    { from: "lfo", fromPort: "out", to: "filter", toPort: "frequency" },
    { from: "filter", fromPort: "out", to: "reverb", toPort: "in" },
    ...analysisWires("reverb"),
  ],
};

/**
 * SEQUENCED DINGS — the blueprint's second acceptance patch: "clock → sequencer →
 * ding", plus the delay and reverb that turn a bell into ambience.
 *
 * The pattern is pentatonic, which is the honest generative-music trick
 * synth/patches.js explains: every note of a pentatonic scale is consonant with
 * every other, so a sparse or random pattern cannot produce a sour interval.
 */
export const SEQUENCED_DINGS = {
  id: "sequenced-dings",
  title: "Sequenced Dings",
  help: "A clock drives a 16-step sequencer into an FM bell, through a damped delay and a plate reverb. The user's 'little metallic ding or dong' — sparse enough to be ambience rather than a ringtone.",
  nodes: [
    { id: "clock", type: "audio_clock", col: 0, row: 0, knobs: { bpm: 72 } },
    { id: "seq", type: "audio_sequencer", col: 0, row: 1, knobs: { stepCount: 16 } },
    // THE SCHMITT TRIGGER IS NOT DECORATION, and leaving it out is what the type
    // system caught. A clock's output is a SQUARE WAVE — an audio-rate signal, typed
    // `audio` because that is what it is. A bell's gate is a `trigger`: a rising
    // EDGE. There is no audio→trigger coercion, deliberately, because turning a
    // continuous signal into discrete events is a real operation with a real
    // parameter (the hysteresis that stops a signal wobbling at the threshold from
    // firing dozens of times) — and this module is that operation. The refusal was
    // right and the patch was wrong.
    { id: "edge", type: "audio_trigger", col: 1, row: 0, knobs: { pulseMs: 5 } },
    // `frequency: 0` is DELIBERATE and is the whole point of the pitch wire below.
    // The knob is an OFFSET the `pitch` input sums into (synth/modules.js
    // dingModule), so leaving it at its 880 default would transpose every
    // sequenced note up by 880 Hz — the sequence would still be a sequence, but a
    // squashed one, because Hz are linear and pitch is not. At 0 the wire alone
    // names the note and the sequencer's pattern is heard as written.
    { id: "ding", type: "audio_ding", col: 2, row: 0, knobs: { preset: "ding", frequency: 0, level: 0.42 } },
    { id: "delay", type: "audio_delay", col: 3, row: 0, knobs: { time: 0.375, feedback: 0.35, damping: 2400, wet: 0.35, dry: 1 } },
    { id: "reverb", type: "audio_reverb", col: 4, row: 0, knobs: { character: "plate", wet: 0.55, dry: 0.5 } },
    ...analysisTail(5),
  ],
  wires: [
    // clock → edge detector → the bell's gate. `gate` on the ding is a METHOD port
    // (the mirror routes it to engine.trigger rather than to a wire) — the card
    // still shows it, so the patch reads correctly and the gesture works.
    { from: "clock", fromPort: "out", to: "edge", toPort: "in" },
    { from: "edge", fromPort: "out", to: "ding", toPort: "gate" },
    // The sequencer's PITCH sets which note each strike lands on — into the ding's
    // `frequency` port, which is where it always belonged.
    //
    // IT USED TO GO TO `level`, AND THAT WAS A REAL BUG WITH A REASON. When this
    // patch was authored the ding's frequency was a SETTER with no input port
    // (recorded as wave 2's third wiring truth), so there was nowhere for a pitch
    // signal to land; the wire went to the only number port that existed and the
    // "melody" was heard as a volume wobble at note frequencies. Wave 3 gave the
    // ding a real pitch input, so the wire now says what it always meant.
    { from: "seq", fromPort: "pitch", to: "ding", toPort: "frequency" },
    { from: "ding", fromPort: "out", to: "delay", toPort: "in" },
    { from: "delay", fromPort: "out", to: "reverb", toPort: "in" },
    ...analysisWires("reverb"),
  ],
};

/**
 * GAMELAN BELLS — the patch wave 3's engine seam made possible, and the one that
 * shows what a PITCHED percussion voice is.
 *
 * ── WHY THIS IS A DIFFERENT PATCH FROM "SEQUENCED DINGS" ────────────────────
 * Sequenced Dings is about AMBIENCE: one bell struck sparsely, buried in delay and
 * reverb, deliberately too sparse to read as a tune. This one is about MELODY —
 * the sequencer's pitch is the subject rather than a texture, so the reverb is
 * shorter, the tempo is faster, and there is no delay smearing one note into the
 * next. Both patches exist because they teach different things with the same three
 * modules, which is what a patch library is for.
 *
 * ── TWO BELLS, ONE SEQUENCER, AND WHY THAT IS THE INTERESTING PART ──────────
 * The same pitch signal drives two dings on different PRESETS, one transposed by
 * its own frequency offset. That is only expressible because the offset and the
 * wire SUM: the low `gong` takes the pitch as-is, and the `pip` takes it plus a
 * fixed interval, so one melody is heard on two instruments an interval apart. It
 * is also the clearest demonstration that the knob is an offset and not a
 * competing setting — the two nodes differ in exactly that one number.
 *
 * The scale is pentatonic for the same reason Sequenced Dings' is: every note is
 * consonant with every other, so the pattern cannot produce a sour interval.
 */
export const GAMELAN_BELLS = {
  id: "gamelan-bells",
  title: "Gamelan Bells",
  help: "A sequenced MELODY on two FM bells — the sequencer's pitch wired into the dings' new frequency input. The second bell's Frequency knob is an OFFSET added to that pitch, so the two play the same tune an interval apart. Change either bell's Character for a different metal.",
  nodes: [
    { id: "clock", type: "audio_clock", col: 0, row: 0, knobs: { bpm: 108 } },
    { id: "seq", type: "audio_sequencer", col: 0, row: 1, knobs: { stepCount: 16 } },
    { id: "edge", type: "audio_trigger", col: 1, row: 0, knobs: { pulseMs: 5 } },
    // THE LEAD BELL takes the sequencer's pitch untransposed, so its offset is 0.
    { id: "lead", type: "audio_ding", col: 2, row: 0, knobs: { preset: "gong", frequency: 0, level: 0.34 } },
    // THE ANSWERING BELL is the same melody plus a fixed 220 Hz. Hz are linear and
    // pitch is not, so a constant offset is NOT a constant musical interval — it
    // narrows as the melody rises, which is exactly the shimmering, slightly
    // out-of-tune relationship a gamelan's paired instruments have and the reason
    // the ensemble sounds alive rather than doubled.
    { id: "answer", type: "audio_ding", col: 2, row: 1, knobs: { preset: "pip", frequency: 220, level: 0.2 } },
    { id: "mix", type: "audio_mixer", col: 3, row: 0, knobs: { level1: 0.9, level2: 0.6, master: 1 } },
    { id: "room", type: "audio_reverb", col: 4, row: 0, knobs: { character: "plate", wet: 0.35, dry: 0.8, preDelay: 0.02 } },
    ...analysisTail(5),
  ],
  wires: [
    { from: "clock", fromPort: "out", to: "edge", toPort: "in" },
    // ONE edge strikes BOTH bells — an output fans out to as many inputs as like
    // (only an INPUT is limited to one source), which is what keeps them in unison.
    { from: "edge", fromPort: "out", to: "lead", toPort: "gate" },
    { from: "edge", fromPort: "out", to: "answer", toPort: "gate" },
    // …and one pitch signal feeds both, each summing with its own offset knob.
    { from: "seq", fromPort: "pitch", to: "lead", toPort: "frequency" },
    { from: "seq", fromPort: "pitch", to: "answer", toPort: "frequency" },
    { from: "lead", fromPort: "out", to: "mix", toPort: "in1" },
    { from: "answer", fromPort: "out", to: "mix", toPort: "in2" },
    { from: "mix", fromPort: "out", to: "room", toPort: "in" },
    ...analysisWires("room"),
  ],
};

/**
 * WHOOSH — noise through a swept bandpass, the sound of moving fast through air.
 * The user's own use case, verbatim: "when the Mendelbrot zooms in maybe I can make
 * it wish faster like we're going past a bunch of wind."
 *
 * WHOOSH INTENSITY IS ONE OBVIOUS KNOB (the brief's requirement), and it is the
 * LFO's DEPTH: how far the bandpass sweeps is exactly how violent the whoosh is. A
 * depth of 0 is steady wind; a large depth is a pass-by. That is the knob to bind to
 * a zoom with `=`, which is what makes this patch answer the Mandelbrot request.
 */
export const WHOOSH = {
  id: "whoosh",
  title: "Whoosh",
  help: "Pink noise through a resonant bandpass swept by an LFO. WHOOSH INTENSITY is the LFO's Depth knob — bind it with '=' to a camera or a variable and the wind follows your zoom.",
  nodes: [
    { id: "noise", type: "audio_noise", col: 0, row: 0, knobs: { color: "pink", level: 0.5 } },
    { id: "lfo", type: "audio_lfo", col: 0, row: 1, knobs: { frequency: 0.15, depth: 900, waveform: "triangle" } },
    { id: "filter", type: "audio_filter", col: 1, row: 0, knobs: { frequency: 500, Q: 7, type: "bandpass" } },
    { id: "reverb", type: "audio_reverb", col: 2, row: 0, knobs: { character: "hall", wet: 0.45, dry: 0.7 } },
    ...analysisTail(3),
  ],
  wires: [
    { from: "noise", fromPort: "out", to: "filter", toPort: "in" },
    { from: "lfo", fromPort: "out", to: "filter", toPort: "frequency" },
    { from: "filter", fromPort: "out", to: "reverb", toPort: "in" },
    ...analysisWires("reverb"),
  ],
};

/**
 * BEACH — seagulls and waves, the user's own example: "maybe I want to have a beach
 * note that makes it sound like there's seagulls and waves."
 *
 * ── IT IS SYNTHESISED, NOT SAMPLED, AND THAT IS SAID OUT LOUD ───────────────
 * The brief's instruction: "if no bundled audio asset exists, synthesize the
 * seagull/wave beds from noise + modulation and say so." There is no bundled beach
 * recording in this repo, so there is none here. Everything below is made from noise
 * and modulation:
 *
 *   THE WAVES are pink noise through a lowpass swept very slowly (0.08 Hz — one
 *     swell every twelve seconds). Surf is broadband noise whose BRIGHTNESS rises
 *     and falls as the wave breaks and recedes; a slow filter sweep on pink noise is
 *     that, and it is why it reads as water rather than as hiss.
 *   THE GULLS are the FM bell on its `pip` preset — a short inharmonic chirp —
 *     struck by a slow clock through an edge detector. It is a suggestion of a gull,
 *     not a recording of one.
 *
 * ── THE RANDOM-PITCH GULL, WHICH WAVE 3 UNBLOCKED ──────────────────────────
 * The gulls cry at a RANDOM pitch, from a sample-and-hold on noise: sampled on each
 * clock tick, that is the classic random-stepped-voltage source, and it is why no
 * two cries are the same. It could not be built before this wave — the bell's
 * `frequency` was an engine SETTER with no input port, so a sample-and-hold would
 * have had nowhere to land and would have sat on the canvas contributing nothing.
 * (The test that every node reaches an output is what caught that dead branch when
 * the patch was first authored, which is why the note was written down rather than
 * papered over with a node that did nothing.) The ding now has a real `frequency`
 * AudioParam input, so the branch is live and the honest note is retired.
 *
 * THE SOURCE IS AN LFO, NOT RAW NOISE, AND THE UNITS ARE WHY. The textbook
 * random-voltage source samples noise, but the noise module's output is roughly
 * [-1, 1] — patched to a frequency port that is a spread of one hertz, which is
 * inaudible, so the gulls would all cry at the same pitch and the branch would look
 * wired and do nothing. An LFO's output is ±`depth` in the TARGET's units (its own
 * knob help says so), so a depth of 400 IS a ±400 Hz spread with no scaling module
 * in between. A fast, non-integer LFO rate sampled by a much slower clock is
 * effectively random: the two are incommensurate, so successive samples land at
 * unrelated phases. The bell's `frequency` knob supplies the CENTRE and the held
 * value the deviation — the two sum at the port, which is what an
 * offset-plus-modulation pair is for.
 *
 * The AUDIO_SAMPLER module exists and would play a real loop; a patch using it is
 * the right thing to add the moment a beach asset is bundled. That is a note for the
 * next wave rather than a stub here — a sampler node with no buffer is silent, and a
 * silent node in a demo patch is exactly the un-debuggable case.
 */
export const BEACH = {
  id: "beach",
  title: "Beach (synthesised)",
  help: "Seagulls and waves built from noise and modulation — there is no bundled beach recording, so nothing here is sampled. Waves: pink noise under a very slow lowpass sweep. Gulls: the FM bell's 'pip', struck by a slow clock, its pitch a fresh random value each cry from a sample-and-hold on a fast LFO. Swap the Sampler in when you have a real loop.",
  nodes: [
    // THE WAVES
    { id: "waves", type: "audio_noise", col: 0, row: 0, knobs: { color: "pink", level: 0.45 } },
    { id: "swell", type: "audio_lfo", col: 0, row: 1, knobs: { frequency: 0.08, depth: 500, waveform: "sine" } },
    { id: "surf", type: "audio_filter", col: 1, row: 0, knobs: { frequency: 700, Q: 1.4, type: "lowpass" } },
    // THE GULLS
    { id: "gullclock", type: "audio_clock", col: 0, row: 2, knobs: { bpm: 26 } },
    // Same edge detector as SEQUENCED_DINGS, and for the same reason: a clock emits
    // a square WAVE, and a bell's gate wants an EDGE.
    { id: "gulledge", type: "audio_trigger", col: 1, row: 2, knobs: { pulseMs: 8 } },
    // THE RANDOM-PITCH BRANCH (wave 3). A fast irrational-rate LFO is the source of
    // spread; the sample-and-hold freezes one value of it per gull, held steady for
    // the whole cry so the pitch does not slide mid-note. Its trigger is the SAME
    // edge that strikes the bell, which is what makes the held value current at the
    // instant the strike samples it.
    { id: "gullrand", type: "audio_lfo", col: 0, row: 3, knobs: { frequency: 7.3, depth: 400, waveform: "triangle" } },
    { id: "gullhold", type: "audio_sample_hold", col: 1, row: 3 },
    { id: "gull", type: "audio_ding", col: 2, row: 2, knobs: { preset: "pip", frequency: 1760, level: 0.16 } },
    // THE MIXER IS REQUIRED, and leaving it out is the second thing the tests
    // caught. Two beds have to reach one reverb, and AN INPUT HOLDS AT MOST ONE
    // SOURCE — that is structural in core/nodeflow.js (a connection is keyed by its
    // input port, so a second wire to the same port REPLACES the first). Wiring both
    // surf and gull straight into the reverb therefore did not sum them: it silently
    // disconnected the waves and left a beach with only birds. Fan-in needs a module
    // that HAS several inputs, which is precisely what a mixer is for.
    { id: "mix", type: "audio_mixer", col: 2, row: 1, knobs: { level1: 0.9, level2: 0.7, master: 1 } },
    // THE SHARED SPACE both beds sit in
    { id: "air", type: "audio_reverb", col: 3, row: 1, knobs: { character: "hall", wet: 0.4, dry: 0.85, preDelay: 0.03 } },
    ...analysisTail(4, 1),
  ],
  wires: [
    { from: "waves", fromPort: "out", to: "surf", toPort: "in" },
    { from: "swell", fromPort: "out", to: "surf", toPort: "frequency" },
    { from: "surf", fromPort: "out", to: "mix", toPort: "in1" },
    { from: "gullclock", fromPort: "out", to: "gulledge", toPort: "in" },
    { from: "gulledge", fromPort: "out", to: "gull", toPort: "gate" },
    // The random-pitch branch: LFO → S&H (clocked by the same edge) → the bell's
    // pitch offset. Only reachable at all because wave 3 gave the ding that port.
    { from: "gullrand", fromPort: "out", to: "gullhold", toPort: "in" },
    { from: "gulledge", fromPort: "out", to: "gullhold", toPort: "trigger" },
    { from: "gullhold", fromPort: "out", to: "gull", toPort: "frequency" },
    { from: "gull", fromPort: "out", to: "mix", toPort: "in2" },
    { from: "mix", fromPort: "out", to: "air", toPort: "in" },
    ...analysisWires("air"),
  ],
};

/**
 * EVERY DEMO PATCH, in the order they appear in the palette.
 *
 * WHAT THE NEXT WAVE SHOULD ADD (the standing directive, made concrete): a patch
 * per module family that has none yet — a SUPERSAW pad with an ADSR and a VCA (the
 * envelope story, which no patch here tells); a BITCRUSH/QUANTIZE patch showing the
 * control-signal side; an EQ3 patch once the draggable EQ-graph node exists; and a
 * SAMPLER patch the moment an audio asset is bundled, which is also when BEACH
 * should gain a real wave loop.
 */
/**
 * PLAYABLE KEYS — the polyphony patch, and the one the user asked for by name.
 *
 * "Even a keyboard node is good. Polyphonic demos are important" (user,
 * 2026-08-03). Insert it, click Enable Audio, and play chords with the mouse.
 *
 * ── WHAT MAKES IT THE POLYPHONY DEMO RATHER THAN JUST A PATCH ──────────────
 * The Poly Pad is set to FOUR voices, not its default eight, DELIBERATELY: a
 * four-voice pool is small enough that an ordinary two-handed chord reaches it,
 * so the OLDEST-STEAL behaviour is something you can hear on purpose rather than
 * a rule you have to take on faith. Turn Voices up in the Inspector and the
 * stealing goes away — which is the clearest possible demonstration of what the
 * knob does.
 *
 * ── THE KEYBOARD'S TWO OUTPUTS GO TO TWO DIFFERENT PLACES ──────────────────
 * `gate` carries the per-note EVENTS (the polyphonic path — noteOn/noteOff with
 * a voice pool behind them). `pitch` is a VALUE, and here it drives the reverb's
 * nothing — it is deliberately left unwired, because a chord has no single pitch
 * and wiring it would suggest otherwise. That absence is the patch teaching the
 * distinction the ports exist to make.
 *
 * The KNOB is wired to the pad's cutoff so there is something to play with by
 * hand besides the keys, which is the founding ask in miniature: turn it while
 * holding a chord and the whole instrument moves.
 */
export const PLAYABLE_KEYS = {
  id: "playable-keys",
  title: "Playable Keys (Poly)",
  help: "A KEYBOARD you can play with the mouse, into a POLYPHONIC pad and a hall reverb. Set to four voices on purpose: hold five notes and the oldest is stolen, which is what the Voices knob controls. Double-click the Knob to sweep the pad's filter while you play.",
  nodes: [
    // TWO octaves, narrowed to fit its column. The default card is 252 wide
    // against a PATCH_COL of 210 and overlapped the next column; `w` is the
    // property that was wrong, so `w` is what this sets. The octave span is
    // left alone — a poly patch wants enough keys to hold a five-note chord
    // and prove the steal, which is the whole point of this patch.
    { id: "keys", type: "node_keyboard", col: 0, row: 0, w: 196, knobs: { baseNote: 48, octaves: 2 } },
    { id: "cutoffKnob", type: "node_knob", col: 0, row: 1, knobs: { value: 1400, min: 200, max: 6000, step: 10 } },
    { id: "poly", type: "audio_poly_pad", col: 1, row: 0, knobs: { voices: 4, cutoff: 1400, level: 0.3, attack: 0.06, release: 0.5 } },
    { id: "reverb", type: "audio_reverb", col: 2, row: 0, knobs: { character: "hall", wet: 0.45, dry: 0.7, preDelay: 0.02 } },
    ...analysisTail(3),
  ],
  wires: [
    // THE POLYPHONIC WIRE. `gate` is a METHOD port on the poly pad, so this is
    // not an engine connect — core/live_control.noteRoutes turns each key press
    // into engine.noteOn and each release into noteOff, and the engine's voice
    // pool (synth/voices.js) decides which voice and who is stolen.
    { from: "keys", fromPort: "gate", to: "poly", toPort: "gate" },
    // THE PITCH WIRE, and this patch used to be missing it (WORKSTREAM CC). The
    // keys ALWAYS chose the note, because noteRoutes carried the pressed key's
    // frequency whether or not anything was wired — which is exactly the defect
    // the user found by cutting this cable and hearing no change. Now that the
    // wire decides, the patch has to draw the connection it always relied on.
    // It is also simply the honest picture of the patch: the keyboard names both
    // WHEN a note happens and WHICH note it is, so it has two cables, and cutting
    // this one now audibly leaves the pad on its own pitch.
    { from: "keys", fromPort: "pitch", to: "poly", toPort: "pitch" },
    // The knob drives the pad's cutoff: `cutoff` is a `number` input (an
    // AudioParam a wire can drive), the same thing that makes the LFO patch work.
    { from: "cutoffKnob", fromPort: "out", to: "poly", toPort: "cutoff" },
    { from: "poly", fromPort: "out", to: "reverb", toPort: "in" },
    ...analysisWires("reverb"),
  ],
};

/**
 * BUTTON DING — the smallest possible playable patch, and the one that proves a
 * live trigger reaches the engine.
 *
 * "button nodes for triggers" (user, 2026-08-03). Press the button, hear a bell.
 * Two nodes plus the analysis tail; there is nothing else in it, deliberately —
 * a demo of one mechanism should contain one mechanism.
 *
 * WORTH KNOWING WHILE PLAYING IT: this patch is silent in a RENDERED EXPORT, and
 * that is correct rather than broken. Nobody pressed the button, because a press
 * is a live human event with no representation in [[slide, alpha]]
 * (core/control_nodes.js states the ruling). To ring the bell in an export, drive
 * it from the Sequenced Dings patch's clock instead — a clock is RECORDABLE, so
 * it reproduces exactly.
 */
export const BUTTON_DING = {
  id: "button-ding",
  title: "Button Ding",
  help: "Press the button, hear the bell. The smallest playable patch: a live trigger into an FM bell's strike input. NOTE: a rendered video of this slide is silent — nobody pressed the button. Use a Clock to ring it in an export.",
  nodes: [
    { id: "btn", type: "node_button", col: 0, row: 0, knobs: { label: "Ding" } },
    { id: "bell", type: "audio_ding", col: 1, row: 0, knobs: { preset: "ding", frequency: 880, level: 0.5 } },
    ...analysisTail(2),
  ],
  wires: [
    // A METHOD wire: `gate` on the ding is engine.trigger, not a connect. One
    // press is one rising edge (plugins/node_button.js states why it does not
    // repeat while held).
    { from: "btn", fromPort: "out", to: "bell", toPort: "gate" },
    ...analysisWires("bell"),
  ],
};

export const DEMO_PATCHES = [SPACEY_PAD_DRONE, SEQUENCED_DINGS, GAMELAN_BELLS, WHOOSH, BEACH, PLAYABLE_KEYS, BUTTON_DING];

/**
 * Pure function. A patch's items as `{id → state}` plus its wires resolved to real
 * item ids — everything an inserter needs except the document itself.
 *
 * Kept pure and separate from the app's insert command so the whole construction can
 * be checked in bare node: that every type is registered, every port exists, every
 * wire typechecks against the coercion table, and no knob is invented.
 *
 * @param {object} patch - a blueprint from DEMO_PATCHES
 * @param {object} registry - the plugin registry
 * @param {{x: number, y: number}} origin - world position of the patch's top-left
 * @param {function} idFor - blueprintId → the real item id to use
 * @returns {{states: object, order: string[]}} item states keyed by REAL id, in creation order
 *
 * @example // buildPatchItems(WHOOSH, registry, {x: 0, y: 0}, (n) => "w-" + n).order[0] // "w-noise"
 */
export function buildPatchItems(patch, registry, origin, idFor) {
  const states = {};
  const order = [];
  for (const node of patch.nodes) {
    const plugin = registry.get(node.type);
    const at = patchLayout(node, origin);
    // ── THE KNOB KEY IS THE WIDGET'S, NOT A FIXED PREFIX (BV, 2026-08-03) ────
    // This prefixed "audio" onto every knob name unconditionally, which was
    // right while every patchable node was an audio module. A CONTROL node
    // (knob, slider, button, keyboard) stores its settings in PLAIN leaves —
    // `value`, `min`, `label`, `baseNote` — so the prefix would have written
    // `audioValue` into a widget with no such property. Nothing would throw: the
    // state object takes any key, so the node would silently insert at its
    // defaults and the patch would be subtly wrong with nothing to see.
    //
    // A widget SAYS which it is by declaring `audioModule`, so this asks rather
    // than assumes. Pinned by tests/audio_patches_test.js, which asserts every
    // knob a blueprint names is a key the target plugin's own defaults carry.
    const prefixed = !!plugin.audioModule;
    const knobs = {};
    for (const [key, value] of Object.entries(node.knobs ?? {}))
      knobs[prefixed ? "audio" + key.charAt(0).toUpperCase() + key.slice(1) : key] = value;
    // ── A BLUEPRINT MAY SET A NODE'S SIZE, AND THE KEYBOARD IS WHY (BV) ──────
    // Every other patchable widget's default `w` is under PATCH_COL, so column
    // pitch alone laid patches out correctly and nothing needed this. The
    // keyboard's default is 252 against a PATCH_COL of 210 — deliberately wide,
    // because a keyboard dropped on a slide by hand wants playable keys — so
    // inserted into a patch it overlapped the module in the next column.
    // MEASURED, not reasoned: a prior attempt at this bug set `octaves: 1`,
    // which is a MUSICAL parameter — keyLayout divides the CARD's width among
    // however many keys are asked for, so fewer octaves means wider keys and
    // the identical 252-wide card. It fixed nothing and cost an octave.
    // `size` is the honest lever: it names the thing that was wrong.
    const size = {};
    if (Number.isFinite(node.w)) size.w = node.w;
    if (Number.isFinite(node.h)) size.h = node.h;
    const id = idFor(node.id);
    states[id] = { ...plugin.defaults, x: at.x, y: at.y, ...size, ...knobs, inputs: {} };
    order.push(id);
  }
  // WIRES ARE WRITTEN LAST, ONTO THE INPUT SIDE, because that is where a connection
  // lives (core/nodeflow.js: an input has at most one source, so input-side storage
  // makes fan-in-1 structural). Writing them after every node exists also means a
  // blueprint may list its wires in any order.
  for (const wire of patch.wires) {
    const target = states[idFor(wire.to)];
    if (!target) throw new Error(`demo patch "${patch.id}": wire targets unknown node "${wire.to}"`);
    if (!states[idFor(wire.from)]) throw new Error(`demo patch "${patch.id}": wire sources unknown node "${wire.from}"`);
    target.inputs = { ...target.inputs, [wire.toPort]: { item: idFor(wire.from), port: wire.fromPort } };
  }
  return { states, order };
}

/**
 * Pure function. The world-space bounding box a patch will occupy, for placing the
 * GROUP that contains it — and for placing the patch itself somewhere sensible
 * rather than on top of whatever is already on the slide.
 *
 * @param {object} patch - a blueprint
 * @param {object} registry - the plugin registry
 * @param {{x: number, y: number}} origin - world position of the top-left
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example // patchBounds(WHOOSH, registry, {x: 0, y: 0}).w > 0 // true
 */
export function patchBounds(patch, registry, origin) {
  let maxX = origin.x, maxY = origin.y;
  for (const node of patch.nodes) {
    const plugin = registry.get(node.type);
    const at = patchLayout(node, origin);
    maxX = Math.max(maxX, at.x + (plugin.defaults.w ?? 0));
    maxY = Math.max(maxY, at.y + (plugin.defaults.h ?? 0));
  }
  return { x: origin.x, y: origin.y, w: maxX - origin.x, h: maxY - origin.y };
}
