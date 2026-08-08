/**
 * OFF-THE-SHELF RIGS — what INSERTING one node actually puts on the canvas, when
 * that node is useless alone.
 *
 * ── THE RULING (user, 2026-08-08, verbatim) ─────────────────────────────────
 * "btw by default when we add a surge node it comes bundled with a keyboard midi
 * widget on its left and an audio output oon its right so it works off theshelf"
 *
 * ── WHY THIS IS A SEPARATE FILE FROM core/audio_patches.js ──────────────────
 * A RIG IS NOT A DEMO PATCH, and the two are held apart because their LAWS differ.
 * A demo patch exists to be shown off: `tests/audio_patches_test.js` requires every
 * one of them to end in a meter AND a spectrum ("so the canvas is ALIVE"), and to
 * carry the "Audio " display prefix. A rig exists to make ONE widget usable the
 * second it lands, so it is the SMALLEST graph that makes sound — the user named
 * three nodes and three is what it is. Filing it under DEMO_PATCHES would have
 * forced a meter and a spectrum into it to satisfy a law written for a different
 * purpose, which is how a rule stops meaning anything.
 *
 * What the two DO share is the blueprint SHAPE — `{nodes: [{id, type, col, row,
 * knobs}], wires: [{from, fromPort, to, toPort}]}` — so `buildPatchItems`,
 * `patchColPitch` and `patchBounds` serve both with no changes, and a rig is
 * inserted through the same one-undo-unit path a patch is (web/demoInsert.js).
 *
 * ── IT IS DATA, WHICH IS WHAT KEEPS THE PLUGIN LAW INTACT ───────────────────
 * "No plugin may import another plugin." A rig names its members by TYPE STRING,
 * in core/, so `plugins/audio_surge.js` composes a keyboard and an output without
 * ever importing `plugins/node_keyboard.js` or `plugins/audio_output.js`. That is
 * precisely why the blueprint mechanism is shaped this way, and reaching for an
 * import here would be the wrong route made visible.
 *
 * Zero PowerRP-runtime imports: this is data, checked in bare node by
 * tests/audio_rigs_test.js against the real registry.
 */

/**
 * THE SURGE RIG — keyboard, synth, output. Left to right in signal order, which is
 * core/audio_patches.js's own Reaktor-derived layout rule.
 *
 * ── WHY THE KEYBOARD WIRES TO `pitch` AND `gate` AND NOT TO `midi` ──────────
 * This looks like the obvious place for the new `midi` cable and it is EXACTLY
 * WRONG, for the reason core/nodeflow.PORT_TYPES.midi states: a midi wire carries a
 * CLIP — authored notes, property state, the same on every machine. A `node_keyboard`
 * has no clip. It is a LIVE PERFORMANCE control: pressing a key is a moment, not a
 * value, and core/live_control.js exists precisely because that moment must not be
 * written into the document. So the keyboard keeps the two cables it has always had
 * (`pitch` names WHICH note, `gate` names WHEN), and `midi` stays free for the clip
 * and ABC nodes that genuinely produce one. Giving the keyboard a midi OUTPUT would
 * have been a category error dressed as symmetry.
 *
 * ── AND WHY THAT MEANS THE ENGINE NEVER SEES THESE TWO WIRES ────────────────
 * `readAudioScene` builds the engine graph from nodes that have an `audioModule`,
 * and a keyboard has none — so these two cables are DROPPED from the engine graph by
 * design. They are not dead: `core/live_control.noteRoutes` reads them from the
 * DOCUMENT at press time and turns each into `engine.noteOn`/`noteOff`. That is the
 * R7-PLAYABLE lesson's exact shape ("thirteen of twenty-four demo patches make no
 * sound because nobody can play them"), and the reason it is not a defect here is
 * that `gate` is declared `method: true` on the Surge spec and `poly: true` sends it
 * down the note path rather than the connect path. The only wire the ENGINE sees in
 * this rig is `surge.out -> out.in`, and that is correct.
 */
export const SURGE_RIG = {
  id: "surge",
  title: "Surge XT",
  help: "Surge XT with a keyboard already wired into it and an output already wired out of it — click a key and it makes a sound. Double-click the synth for Surge's own interface.",
  nodes: [
    // NARROWED FROM ITS 252 DEFAULT for the reason PLAYABLE_KEYS narrows it: the
    // card is wider than the column pitch and would overlap the synth. `w` is the
    // honest lever — it names the thing that is wrong — where fewer octaves would
    // cost a musical property to fix a layout one.
    { id: "keys", type: "node_keyboard", col: 0, row: 0, w: 196, knobs: { baseNote: 48, octaves: 2 } },
    { id: "surge", type: "audio_surge", col: 1, row: 0 },
    { id: "out", type: "audio_output", col: 2, row: 0, knobs: { volume: 0.7 } },
  ],
  wires: [
    { from: "keys", fromPort: "gate", to: "surge", toPort: "gate" },
    { from: "keys", fromPort: "pitch", to: "surge", toPort: "pitch" },
    { from: "surge", fromPort: "out", to: "out", toPort: "in" },
  ],
};

/** Every rig. One today; the shape is here so the second one is a record rather
 *  than a refactor. */
export const AUDIO_RIGS = [SURGE_RIG];

/** Pure function. The insertable-template id for a rig — the id
 *  `web/demoInsert.js` registers it under and `spec.rig` names.
 *  @example audioRigTemplateId("surge") // "audio-rig-surge" */
export function audioRigTemplateId(id) {
  return `audio-rig-${id}`;
}
