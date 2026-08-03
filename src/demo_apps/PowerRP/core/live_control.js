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
    for (const [targetPort, wire] of Object.entries(target?.inputs ?? {})) {
      if (wire?.item !== sourceId) continue;
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
    for (const [targetPort, wire] of Object.entries(target?.inputs ?? {})) {
      if (wire?.item !== sourceId) continue;
      const port = (plugin.audioSpec?.inputs ?? []).find((p) => p.key === targetPort);
      if (!port?.method) continue;
      // A wire from the keyboard's PITCH output is not a note event — it is an
      // ordinary control wire the mirror connects. Only the GATE plays notes.
      if ((wire.port ?? "out") !== "gate") continue;
      if (plugin.audioSpec?.poly) {
        routes.push(phase === "on"
          ? { op: "noteOn", id: targetId, note, frequency }
          : { op: "noteOff", id: targetId, note });
      } else if (phase === "on") {
        // A MONO method port (a bell's gate) is struck by every key, at that
        // key's pitch. A note-OFF has nothing to do: a struck bell rings out on
        // its own, which is what a one-shot voice means.
        routes.push({ op: "trigger", id: targetId, port: targetPort, frequency });
      }
    }
  }
  return routes;
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
