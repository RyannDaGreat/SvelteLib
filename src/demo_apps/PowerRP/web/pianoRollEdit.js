/**
 * ACTIVATE: OPEN THE FULLSCREEN PIANO ROLL.
 *
 * ── THE ASK (user, 2026-08-08) ──────────────────────────────────────────────
 * The MIDI widgets should "bring up full fledged UI's in giant modals when duoble
 * clicked (imitating the website with the giant piano for surge and a fullscreen
 * midi piano roll editor ported over)".
 *
 * ── WHY THIS IS A HANDLER AND NOT A LINE IN CanvasView ─────────────────────
 * web/widget_handlers.js's whole argument, applied: a plugin may not carry a Svelte
 * component (core/ and plugins/ must import in bare node, and no plugin may import
 * another), so it carries a STRING — `activate: "piano_roll_edit"` — and this file,
 * which lives in the DOM layer, turns that string into behaviour. Adding the piano
 * roll therefore touched CanvasView not at all.
 *
 * ── WHY IT IS A MODAL AND NOT A CANVAS MODE ────────────────────────────────
 * The other activations that sustain a gesture (`keyboard_play`, `bento_bind_cell`,
 * `navigate_interior`) declare a `mode`, because they operate ON THE CANVAS: the
 * widget stays where it is and the mode reinterprets pointer input over it. A piano
 * roll cannot work that way at any honest size — a node card is a couple of hundred
 * pixels and an editable roll needs a screen. So this handler declares NO mode: it
 * raises an app signal, App.svelte mounts the dialog, and the canvas is simply
 * covered. That is the same shape `code_modal` uses, for the same reason, and it is
 * why neither needs `enterMode`.
 *
 * A consequence that is a feature: because the dialog carries `role="dialog"`,
 * App.svelte's focusContext sees `dialog: true` and every canvas shortcut chip
 * stands down while it is open. The roll's own keys cannot collide with the app's.
 */

/**
 * THE HANDLER. `claims` reads the widget's CONTENT DESCRIPTOR — an editable
 * `midiClip` declaration — which is what makes forgetting the one-line `activate`
 * string a TEST FAILURE (tests/activation_migration_test.js asserts
 * `migrationPlan` is empty) rather than a widget that quietly does nothing when
 * you double-click it.
 *
 * `editable` is part of the claim on purpose. A future widget could declare
 * `midiClip` to say WHERE its notes live without them being hand-editable — an ABC
 * node's are derived from text and must be edited as text (plugins/node_abc.js
 * states why a round-trip through the roll is the wrong shape) — and such a widget
 * must not be claimed by an editor that could not write back to it.
 */
export const PIANO_ROLL_EDIT_HANDLER = {
  id: "piano_roll_edit",
  phase: "activate",
  label: "Edit clip in piano roll",
  /** Pure function. `midiClip: {key, activeKey, editable}` names WHICH list leaves
   * hold this widget's notes, so a widget declaring an EDITABLE one wants this
   * trigger. migrationPlan-only.
   * @example // claims({midiClip: {key: "clip", editable: true}}) → true
   * @example // claims({midiClip: {key: "clip"}}) → false (derived, not editable)
   * @example // claims({type: "rect"}) → false */
  claims: (plugin) => !!plugin.midiClip?.editable,
  /** Command. Selects the widget and raises the app's piano-roll signal. The
   *  selection is the app's own concern (openPianoRoll does it) so that opening the
   *  editor from the palette and from a double-click cannot leave the Inspector
   *  pointing at different items. */
  run(ctx) {
    ctx.app.openPianoRoll(ctx.node.itemId);
  },
};
