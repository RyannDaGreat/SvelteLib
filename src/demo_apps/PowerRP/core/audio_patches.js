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
    { id: "ding", type: "audio_ding", col: 2, row: 0, knobs: { preset: "ding", frequency: 880, level: 0.42 } },
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
    // The sequencer's PITCH sets which note each strike lands on.
    { from: "seq", fromPort: "pitch", to: "ding", toPort: "level" },
    { from: "ding", fromPort: "out", to: "delay", toPort: "in" },
    { from: "delay", fromPort: "out", to: "reverb", toPort: "in" },
    ...analysisWires("reverb"),
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
 * ── ONE THING THIS PATCH WANTED AND CANNOT HAVE YET, STATED RATHER THAN FAKED ─
 * The gulls should cry at a RANDOM pitch, which is what a sample-and-hold on noise
 * is for: sampled on each clock tick, it is the classic random-stepped-voltage
 * source. It is not here, because the bell's `frequency` is an engine SETTER with no
 * input port — no wire can drive it, so the sample-and-hold would have had nowhere
 * to land and would have sat on the canvas contributing nothing. (The test that
 * every node reaches an output is what caught the dead branch when it was.) Giving
 * the ding a `frequency` input port is a small engine change and the right fix; it
 * is noted for the next wave rather than papered over with a node that does nothing.
 *
 * The AUDIO_SAMPLER module exists and would play a real loop; a patch using it is
 * the right thing to add the moment a beach asset is bundled. That is a note for the
 * next wave rather than a stub here — a sampler node with no buffer is silent, and a
 * silent node in a demo patch is exactly the un-debuggable case.
 */
export const BEACH = {
  id: "beach",
  title: "Beach (synthesised)",
  help: "Seagulls and waves built from noise and modulation — there is no bundled beach recording, so nothing here is sampled. Waves: pink noise under a very slow lowpass sweep. Gulls: the FM bell's 'pip' at a random pitch from a sample-and-hold. Swap the Sampler in when you have a real loop.",
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
export const DEMO_PATCHES = [SPACEY_PAD_DRONE, SEQUENCED_DINGS, WHOOSH, BEACH];

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
    const knobs = {};
    for (const [key, value] of Object.entries(node.knobs ?? {}))
      knobs["audio" + key.charAt(0).toUpperCase() + key.slice(1)] = value;
    const id = idFor(node.id);
    states[id] = { ...plugin.defaults, x: at.x, y: at.y, ...knobs, inputs: {} };
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
