/**
 * LIVE CONTROL EVENTS — what a hand does to a running patch, and where it goes.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * "I need nodes in the UI so that some of these patches I can play with them. I
 * need to be able to play with them myself." (user, 2026-08-03). A KNOB's play is
 * easy — turning it writes a property, and the mirror's ordinary diff turns that
 * into a setParam. A BUTTON's press is not a value at all. It is a MOMENT: there
 * is no leaf whose change means "the button was pressed just now", and inventing
 * one (a counter, a `pressedAt` timestamp) would put a live human event into the
 * saved document, which is the ephemeral state this project has none of.
 *
 * So a press does not go through the document. It is routed as an EVENT, from the
 * widget that was pressed to the engine module it is wired to, and this file owns
 * the one decision on that path: GIVEN THE DOCUMENT'S WIRES, WHICH ENGINE CALLS
 * DOES THIS PRESS PRODUCE? That is a pure function of the item map, so it is
 * covered in bare node — the same split core/audio_mirror_diff.js makes against
 * web/audioMirror.svelte.js, and for the same reason: a missed route is silent.
 *
 * ── WHY THE WIRES ARE READ FROM THE DOCUMENT AND THE EVENT IS NOT ───────────
 * The GRAPH is property state: which button feeds which ding is authored,
 * keyframable, saved, and identical on every machine. Only the PRESS is live. So
 * a press carries no routing of its own — it names its source item, and the
 * document says where that goes. A patch rewired between two presses routes the
 * second press differently, with no bookkeeping anywhere.
 *
 * ── WHAT AN EXPORT DOES WITH A PRESS: NOTHING (and see core/control_nodes.js) ─
 * A recorded render never calls any of this, because nobody pressed anything. The
 * frames are correct — the deck contains a button that was not pressed. A deck
 * that needs a trigger to fire in an export drives it from a Clock or Sequencer,
 * which are recordable (pure functions of elapsed time) and therefore reproduce.
 *
 * DOM-free, engine-free, and free of any clock: a live event's TIME is supplied
 * by the caller (the engine's audio clock), never read here.
 */

import { inputRefs, inputWires, resolvedWireSource } from "./nodeflow.js";

/**
 * Pure function. The engine calls one live TRIGGER event produces, given the
 * document's wires.
 *
 * ── WHAT MAKES A ROUTE REAL ─────────────────────────────────────────────────
 * A wire from this button counts only when all of the following hold, and each
 * one is an ordinary consequence of editing rather than an error:
 *   - the target item still exists and is an ENGINE MODULE (a button wired to a
 *     Number node is legal on the canvas and has no engine counterpart);
 *   - the target is on this slide (`active !== false`);
 *   - the target port exists and is a METHOD port — i.e. the module's own
 *     "something happens now" input. A trigger arriving at an ordinary AudioParam
 *     input is NOT a strike; it is a wire that should have been connected, and
 *     the mirror's normal path already handles it.
 *
 * Anything else is dropped QUIETLY, because handing the engine an id it has never
 * heard of throws in the middle of a presentation — the one place an exception is
 * most expensive.
 *
 * @param {object} items - the folded, evaluated item map
 * @param {object} registry - the plugin registry
 * @param {string} sourceId - the item id of the control that fired
 * @param {string} [sourcePort] - which of its outputs fired (default "out")
 * @returns {Array<{op: string, id: string, port: string}>} engine trigger calls
 *
 * @example // R is a registry whose "audio_ding" plugin declares a method `gate`
 * @example triggerRoutes({}, {get: () => null}, "b") // []
 * @example // a button wired to nothing produces nothing
 * @example triggerRoutes({b: {type: "node_button"}}, {get: () => ({})}, "b") // []
 */
export function triggerRoutes(items, registry, sourceId, sourcePort = "out") {
  const routes = [];
  for (const [targetId, target] of Object.entries(items ?? {})) {
    if (target?.active === false) continue;
    const plugin = pluginFor(registry, target?.type);
    // Only an ENGINE MODULE can be struck. A control node or a rect wired here is
    // legal on the canvas and simply has nothing to fire.
    if (!plugin?.audioModule) continue;
    for (const [targetPort, rawWire] of inputWires(target)) {
      // RESOLVED THROUGH ANY ROUTING POINT first (plugins/route_node.js): a press
      // must still reach a module the author tidied the cable to, and a joint is a
      // layout decision, not a break in the wire. Identity for a document with no
      // joints, so nothing about an ordinary patch changes.
      const wire = resolvedWireSource(items, registry, rawWire);
      if (wire.item !== sourceId) continue;
      if ((wire.port ?? "out") !== sourcePort) continue;
      const port = (plugin.audioSpec?.inputs ?? []).find((p) => p.key === targetPort);
      // A METHOD port is the module's "do it now" input (the ding's gate). An
      // ordinary input is an AudioParam and is driven by the mirror's connect,
      // not by an event — firing at one would be a call the engine refuses.
      if (!port?.method) continue;
      routes.push({ op: "trigger", id: targetId, port: targetPort });
    }
  }
  return routes;
}

/**
 * Pure function. The engine calls one live NOTE event produces — the keyboard's
 * per-note routing.
 *
 * ── WHY A NOTE IS NOT A TRIGGER WITH A NUMBER ATTACHED ──────────────────────
 * A trigger is one instant; a note has a BEGINNING and an END, and between them
 * it occupies a voice. That is why this returns `noteOn`/`noteOff` rather than
 * `trigger`, and why the target must be a module that declares a poly `gate`:
 * sending note-ons to a monophonic module would produce an instrument that plays
 * only the last key of every chord — audible, wrong, and with nothing to explain
 * it (synth/engine.requirePoly refuses it by name for exactly this reason).
 *
 * A keyboard MAY also be wired to a non-poly method port (a ding's gate), and
 * that IS meaningful: every key strikes the bell. Those come back as `trigger`
 * ops carrying the note's frequency, which is what `engine.trigger`'s
 * `options.frequency` is for — so a keyboard plays a bell melody with no poly
 * module in the patch.
 *
 * ── THE PITCH WIRE IS LOAD-BEARING (WORKSTREAM CC, and it was not) ──────────
 * USER, 2026-08-03 (verbatim): "I disconnected pitch from the keyboard to the pad
 * synth....kept only Gate....and it was fine. This is a big red flag lol there's
 * clearly state that's not visible in properties about these instrucments."
 *
 * HE WAS RIGHT, AND THIS FUNCTION WAS THE HIDDEN STATE. It used to find the GATE
 * wire and then carry the pressed key's `frequency` into the note unconditionally
 * — so the pitch connection contributed NOTHING to live play and cutting it
 * changed nothing audible. Measured before the fix: the route lists were
 * byte-identical with `inputs.pitch` set to null. The wire was decorative, which
 * is exactly the "state not visible in properties" he named: the audible pitch
 * came from the pressed key, not from anything the document said.
 *
 * SO THE PITCH INPUT NOW DECIDES, and it is read from the SAME property every
 * other consumer reads (`target.inputs.pitch`, via the connectionsOf shape):
 *   - wired FROM THIS KEYBOARD's pitch output ⟹ the key names the note, and the
 *     `frequency` travels with it. This is the ordinary playable arrangement.
 *   - NOT wired to this keyboard (absent, null, or pointing elsewhere) ⟹ the
 *     note carries NO frequency, so the module sounds its OWN pitch property.
 *     The gate still triggers, so keys still play — they just no longer choose
 *     the pitch, which is what disconnecting a pitch cable means on real gear.
 *
 * `frequency: undefined` is the carrier of that distinction rather than a second
 * flag, because it is precisely what the engine layer already means by "the
 * caller did not name a pitch": polyPad.noteOn and ding.trigger both fall back to
 * their own pitch port when `options.frequency` is absent (synth/modules.js states
 * that precedence at both sites). So this reads as one less argument, not as a
 * special case, and the ENGINE needed no change to honor it.
 *
 * @param {object} items - the folded, evaluated item map
 * @param {object} registry - the plugin registry
 * @param {string} sourceId - the keyboard's item id
 * @param {"on"|"off"} phase - whether the key went down or up
 * @param {number} note - the note's identity (a MIDI number)
 * @param {number} frequency - the note's pitch in Hz
 * @returns {Array<object>} engine calls: {op, id, note, frequency} or {op, id, port, frequency}
 *
 * @example noteRoutes({}, {get: () => null}, "k", "on", 60, 262) // []
 * @example // a keyboard wired to nothing sounds nothing
 * @example noteRoutes({k: {type: "node_keyboard"}}, {get: () => ({})}, "k", "on", 60, 262) // []
 */
export function noteRoutes(items, registry, sourceId, phase, note, frequency) {
  const routes = [];
  for (const [targetId, target] of Object.entries(items ?? {})) {
    if (target?.active === false) continue;
    const plugin = pluginFor(registry, target?.type);
    if (!plugin?.audioModule) continue;
    // THE PITCH DECISION, made ONCE PER TARGET from the target's own properties.
    // Hoisted out of the port loop because it is a fact about this receiver, not
    // about whichever method port we happen to be looking at.
    const played = keyboardDrivesPitch(plugin, target, sourceId, items, registry) ? frequency : undefined;
    for (const [targetPort, rawWire] of inputWires(target)) {
      // RESOLVED THROUGH ANY ROUTING POINT first (plugins/route_node.js): a press
      // must still reach a module the author tidied the cable to, and a joint is a
      // layout decision, not a break in the wire. Identity for a document with no
      // joints, so nothing about an ordinary patch changes.
      const wire = resolvedWireSource(items, registry, rawWire);
      if (wire.item !== sourceId) continue;
      const port = (plugin.audioSpec?.inputs ?? []).find((p) => p.key === targetPort);
      if (!port?.method) continue;
      // A wire from the keyboard's PITCH output is not a note event — it is an
      // ordinary control wire the mirror connects. Only the GATE plays notes.
      if ((wire.port ?? "out") !== "gate") continue;
      if (plugin.audioSpec?.poly) {
        // `note` travels even when the pitch is not the keyboard's: it is the
        // note's IDENTITY, which is what pairs a note-off with its note-on in the
        // voice pool. Losing it would leak a voice per keypress.
        routes.push(phase === "on"
          ? { op: "noteOn", id: targetId, note, frequency: played }
          : { op: "noteOff", id: targetId, note });
      } else if (phase === "on") {
        // A MONO method port (a bell's gate) is struck by every key, at that
        // key's pitch. A note-OFF has nothing to do: a struck bell rings out on
        // its own, which is what a one-shot voice means.
        routes.push({ op: "trigger", id: targetId, port: targetPort, frequency: played });
      }
    }
  }
  return routes;
}

/**
 * Pure function. Does THIS keyboard drive THIS receiver's pitch — i.e. is the
 * receiver's `pitch`-typed input wired to this keyboard's `pitch` output?
 *
 * WHICH INPUT COUNTS is asked of the module's own spec rather than hardcoded to
 * the key `"pitch"`, so a module that names its pitch input something else is
 * answered correctly by declaration instead of by coincidence. A module with NO
 * pitch input at all (a bell whose pitch is a knob) returns false — there is no
 * cable to have disconnected, so the key's own pitch is the only pitch available
 * and the historic behaviour is what is correct.
 *
 * @param {object} plugin - the receiver's plugin
 * @param {object} target - the receiver's folded state
 * @param {string} sourceId - the keyboard's item id
 * @returns {boolean}
 *
 * ── A MODULE WITH NO PITCH INPUT KEEPS THE OLD BEHAVIOUR, DELIBERATELY ──────
 * There is no cable to have disconnected, so there is nothing the author could
 * have meant by cutting one. The key's own pitch is then the only pitch in play
 * and it travels — which is what makes "a keyboard plays a bell melody" still
 * true for a bell whose pitch is a knob.
 *
 * @example // a poly pad whose pitch input is wired to keyboard "k"
 * @example keyboardDrivesPitch({audioSpec: {inputs: [{key: "pitch", type: "number"}]}}, {inputs: {pitch: {item: "k", port: "pitch"}}}, "k") // true
 * @example // the SAME pad with that wire cut — the user's own experiment
 * @example keyboardDrivesPitch({audioSpec: {inputs: [{key: "pitch", type: "number"}]}}, {inputs: {pitch: null}}, "k") // false
 * @example // wired, but to a DIFFERENT source: this keyboard does not name the note
 * @example keyboardDrivesPitch({audioSpec: {inputs: [{key: "pitch", type: "number"}]}}, {inputs: {pitch: {item: "lfo", port: "out"}}}, "k") // false
 * @example // the ding spells its pitch input `frequency`, and it counts the same
 * @example keyboardDrivesPitch({audioSpec: {inputs: [{key: "frequency", type: "number"}]}}, {inputs: {frequency: {item: "k", port: "pitch"}}}, "k") // true
 * @example // a module with NO pitch input at all: no cable to cut, so the key names the note
 * @example keyboardDrivesPitch({audioSpec: {inputs: [{key: "in", type: "audio"}]}}, {inputs: {}}, "k") // true
 */
export function keyboardDrivesPitch(plugin, target, sourceId, items = null, registry = null) {
  const pitchPort = (plugin?.audioSpec?.inputs ?? []).find((p) => PITCH_INPUT_KEYS.has(p.key));
  // NO PITCH INPUT ⟹ the key's pitch is the only one available. Returning false
  // here would silence the keyboard-plays-a-bell patch, which has no pitch cable
  // to disconnect and therefore cannot have been disconnected.
  if (!pitchPort) return true;
  // READ THROUGH inputRefs, the one reader of the slot's two shapes, so a pitch
  // input that ever declares `multiple` answers about its wires rather than about
  // an array it cannot interpret.
  const stored = inputRefs(target, pitchPort.key)[0];
  if (!stored) return false;
  // …AND THROUGH ANY ROUTING POINT, when the caller has the document to walk. A
  // joint on the pitch cable (plugins/route_node.js) is a layout decision; without
  // this the keyboard's own pitch would quietly stop being used and the module
  // would sound at its own, which is a wrong note rather than an error. The two
  // arguments are OPTIONAL because this predicate is also asked in the abstract —
  // by its own doctests and by a caller holding one item and no map — and with no
  // document in hand the honest answer is about the STORED wire, which is what it
  // then gives. `noteRoutes`, the one production caller, always passes them.
  const wire = items && registry ? resolvedWireSource(items, registry, stored) : stored;
  return wire.item === sourceId && (wire.port ?? "out") === PITCH_OUTPUT_KEY;
}

/**
 * The input keys that mean "what note should I sound". TWO SPELLINGS, because the
 * roster genuinely has two: the poly pad declares `pitch`, and the ding declares
 * `frequency` (labelled "pitch" on the card) because its knob is an OFFSET that
 * the input sums into. Matching only one of them would have made a keyboard's
 * pitch cable load-bearing on the pad and decorative on the bell — the same class
 * of split this workstream exists to remove.
 *
 * Kept in sync with synth/engine.js's PITCH_PARAM_KEYS by
 * tests/control_nodes_test.js, which asserts the two sets agree: core/ may not
 * import synth/**, so the pair is a restatement rather than a shared constant.
 */
const PITCH_INPUT_KEYS = new Set(["pitch", "frequency"]);

/** The keyboard's own OUTPUT port that carries pitch. One spelling, because one
 *  widget declares it (plugins/node_keyboard.js PORTS). */
const PITCH_OUTPUT_KEY = "pitch";

/**
 * Query (reads the plugin registry). THE LATCHED CHORDS a frame holds:
 * `{itemId: [note, …]}` for every widget declaring a `noteLatch`.
 *
 * ── A LATCH IS DOCUMENT STATE; A PRESS IS NOT. THIS FILE NOW HOLDS BOTH ─────
 * Everything below this function is the LIVE side — a moment, module scratch,
 * never saved. This function is on the other side of that line and is placed here
 * anyway, deliberately, because the two meet: a latched note produces the SAME
 * engine calls a pressed one does (`noteRoutes`, above), and a note that sounded
 * differently depending on how it was turned on would be the split this module was
 * written to prevent. What differs is only where the note came FROM.
 *
 * WHICH WIDGETS LATCH IS ASKED, NOT LISTED. A plugin declaring `noteLatch.notes`
 * is one; nothing here knows the roster (core/registry.js's law). `active: false`
 * items are skipped for the same reason `readAudioScene` skips them — a chord
 * sounding from a widget that is not on this slide is a drone with no visible
 * source.
 *
 * @param {object} items - the folded, evaluated item map
 * @param {object} registry - the plugin registry
 * @returns {Object<string, number[]>} itemId → the notes it is holding
 *
 * @example latchedChords({}, {get: () => null}) // {}
 * @example // a widget that declares no latch contributes nothing
 * @example latchedChords({r: {type: "rect"}}, {get: () => ({})}) // {}
 * @example // R is a registry whose keyboard declares noteLatch.notes
 * @example // latchedChords({k: {type: "node_keyboard", heldNotes: [[60], [64]]}}, R) // {k: [60, 64]}
 */
export function latchedChords(items, registry) {
  const chords = {};
  for (const [id, state] of Object.entries(items ?? {})) {
    if (state?.active === false) continue;
    const notes = pluginFor(registry, state?.type)?.noteLatch?.notes?.(state);
    if (notes?.length) chords[id] = notes;
  }
  return chords;
}

/**
 * Pure function. WHAT CHANGED between two latched-chord maps, as note events in
 * the order they must be sent: releases first, then presses.
 *
 * ── OFFS BEFORE ONS, AND IT IS NOT COSMETIC ─────────────────────────────────
 * A voice pool is finite and steals the OLDEST voice when it runs out
 * (synth/voices.js). Changing a five-note chord to a different five-note chord on
 * an eight-voice pad sends five ons and five offs; issue the ons first and the pool
 * is briefly holding ten notes, so it steals two that were about to be released and
 * cuts two notes that should have kept sounding. Releasing first means the pool
 * never exceeds what the document actually asks for.
 *
 * @param {Object<string, number[]>} prev - what is currently sounding
 * @param {Object<string, number[]>} next - what the document now says
 * @returns {Array<{id: string, phase: "on"|"off", note: number}>}
 *
 * @example latchedChordDelta({}, {}) // []
 * @example latchedChordDelta({}, {k: [60]}) // [{id: "k", phase: "on", note: 60}]
 * @example latchedChordDelta({k: [60]}, {}) // [{id: "k", phase: "off", note: 60}]
 * @example // an UNCHANGED chord is not re-sent — a second noteOn restarts an envelope
 * @example latchedChordDelta({k: [60, 64]}, {k: [60, 64]}) // []
 * @example // …and a chord that changes releases before it presses
 * @example latchedChordDelta({k: [60]}, {k: [64]}) // [{id: "k", phase: "off", note: 60}, {id: "k", phase: "on", note: 64}]
 */
export function latchedChordDelta(prev, next) {
  const offs = [], ons = [];
  for (const [id, notes] of Object.entries(prev ?? {}))
    for (const note of notes) if (!(next?.[id] ?? []).includes(note)) offs.push({ id, phase: "off", note });
  for (const [id, notes] of Object.entries(next ?? {}))
    for (const note of notes) if (!(prev?.[id] ?? []).includes(note)) ons.push({ id, phase: "on", note });
  return [...offs, ...ons];
}

/**
 * ── THE LIVE PRESS SET ───────────────────────────────────────────────────────
 *
 * WHICH KEYS ARE DOWN RIGHT NOW, per keyboard item: `itemId → Set<note>`.
 *
 * ── WHY THIS EXISTS AT ALL (user, 2026-08-03, verbatim) ─────────────────────
 * "The keyboard doesn't press keys visually when I touch it." A press already
 * routed to the ENGINE (noteRoutes, above) and reached nothing else, so the
 * widget stayed at rest while it sounded. The picture and the sound now read the
 * SAME set: `startLivePlay` writes it in the same statement it plays the note, so
 * a key that sounds is a key that lights, by construction rather than by two
 * call sites agreeing.
 *
 * ── WHY IT IS NOT DOCUMENT STATE, AND WHY THAT IS NOT A LOOPHOLE ────────────
 * WORKSTREAM BV's ruling stands unchanged: "a button/key PRESS is LIVE — a moment
 * is not a value, and a leaf for it would be the ephemeral state this project has
 * none of; a recorded export plays no presses and that is CORRECT". So this is
 * NOT in the fold, NOT keyframable, NOT saved, and NOT read by any plugin's
 * `emit()`. Its ONE consumer is the editor's screen-space overlay — the seam the
 * audio meters already use for live levels, for the identical reason.
 *
 * THE Δt LAW IS THEREFORE UNTOUCHED, and it is worth being precise about why,
 * because "live state that changes the picture" sounds exactly like the thing the
 * law forbids. The law binds the RENDER: RenderTree = pure(document, [[slide,
 * alpha]]), so holding `t` and the document fixed must give a byte-identical
 * frame. Nothing here reaches a render tree. `cli/render.js`, `cli/render_job.js`,
 * the PNG export and the presenter's own composite all walk plugin `emit()`, which
 * cannot see this module-scratch object. An export of a deck with a key held down
 * renders the resting keyboard — the same frame it rendered before this existed.
 *
 * ── SCRATCH, THE SAME DISCIPLINE web/knobFocus.js's `turning` KEEPS ─────────
 * One module-level object, cleared by the release that set it, and never
 * serialized. It lives in core/ rather than web/ because the PRESENTER
 * (web/PresentMode.svelte) and the EDITOR (web/CanvasView.svelte) are two callers
 * that must not each keep their own answer — and because a bare-node test can then
 * pin the set's transitions without a browser.
 */
const pressedByItem = new Map();

/**
 * Command. Record that `note` went down on `itemId`. Idempotent — a key already
 * held stays held, which is what makes an auto-repeating keydown harmless.
 *
 * @param {string} itemId - the keyboard's item id
 * @param {number} note - the note's MIDI number
 *
 * @example // pressNote("k1", 60); pressedNotes("k1") → [60]
 * @example // pressing the same note twice is one press
 * @example // pressNote("k1", 60); pressNote("k1", 60); pressedNotes("k1") → [60]
 */
export function pressNote(itemId, note) {
  if (!pressedByItem.has(itemId)) pressedByItem.set(itemId, new Set());
  pressedByItem.get(itemId).add(note);
}

/**
 * Command. Record that `note` came up on `itemId`. Silent on a note that was not
 * held: an ordinary consequence of a pointer leaving the canvas mid-drag or a
 * mode ending under a held key, not an error worth a report mid-performance.
 *
 * DROPS THE ITEM'S SET WHEN IT EMPTIES, so a document played once does not keep a
 * per-keyboard Set alive for the session.
 *
 * @param {string} itemId - the keyboard's item id
 * @param {number} note - the note's MIDI number
 *
 * @example // pressNote("k1", 60); releaseNote("k1", 60); pressedNotes("k1") → []
 */
export function releaseNote(itemId, note) {
  const held = pressedByItem.get(itemId);
  if (!held) return;
  held.delete(note);
  if (held.size === 0) pressedByItem.delete(itemId);
}

/**
 * Query. The notes held on `itemId`, ascending — what the overlay paints.
 *
 * Returns a fresh ARRAY rather than the live Set, deliberately: a consumer that
 * held the Set would see it mutate under a `$derived` without the assignment
 * Svelte tracks, which is the silent-staleness class this project keeps out of
 * reactive code. Ascending so two equal sets compare equal as strings.
 *
 * @param {string} itemId - the keyboard's item id
 * @returns {number[]}
 *
 * @example pressedNotes("nobody-has-played-this") // []
 * @example // pressNote("k1", 64); pressNote("k1", 60); pressedNotes("k1") → [60, 64]
 */
export function pressedNotes(itemId) {
  return [...(pressedByItem.get(itemId) ?? [])].sort((a, b) => a - b);
}

/**
 * Command. Drop every held note, on every item — what a slide change, a mode
 * exit, or a teardown owes the picture.
 *
 * THE PAIRED CALL IS web/audioMirror.releaseAllLiveNotes, and they are separate on
 * purpose: that one silences the ENGINE, this one un-lights the WIDGET. A caller
 * that silences without clearing leaves keys lit that are making no sound, which
 * is the same un-debuggable class as its own docblock's drone-with-no-source.
 *
 * IT REPORTS WHETHER IT ACTUALLY CLEARED ANYTHING, and that return value is not
 * decoration. Its editor caller sits in a Svelte `$effect` and follows it with a
 * repaint signal; signalling UNCONDITIONALLY is what made that effect write on
 * every run, including its first, which is half of the loop that took the deployed
 * boot down on 2026-08-03 (the other half is fixed at the counter itself, in
 * web/app.svelte.js bumpPressEpoch). A caller can now say "repaint only if the
 * picture changed", which is both cheaper and the honest statement.
 *
 * @returns {boolean} whether any note was being held (false = nothing to un-light)
 *
 * @example // pressNote("k1", 60); releaseAllPresses() → true
 * @example // releaseAllPresses(); releaseAllPresses() → false  (already empty)
 */
export function releaseAllPresses() {
  const had = pressedByItem.size > 0;
  pressedByItem.clear();
  return had;
}

/** Query. A plugin by type, or null — `registry.get` THROWS on an unknown type,
 *  and a document mid-edit legitimately holds types a registry may not have
 *  (core/audio_mirror_diff.js hit exactly this and records it). */
function pluginFor(registry, type) {
  if (!type || !registry) return null;
  try { return registry.get(type); } catch { return null; }
}

/**
 * Pure function. MIDI note number → frequency in Hz (A4 = 69 = 440).
 *
 * Restated here rather than imported from synth/dsp.js because core/ MAY NOT
 * import synth/** (that module's file header states the rule, and the engine
 * constructs an AudioContext, which does not exist in bare node). It is four
 * lines of exact arithmetic with no state, and tests/control_nodes_test.js pins
 * the two against each other so the duplication cannot drift.
 *
 * @param {number} note - a MIDI note number
 * @returns {number} frequency in Hz
 *
 * @example noteFrequency(69) // 440
 * @example noteFrequency(81) // 880
 * @example noteFrequency(57) // 220
 * @example Math.round(noteFrequency(60)) // 262
 */
export function noteFrequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}
