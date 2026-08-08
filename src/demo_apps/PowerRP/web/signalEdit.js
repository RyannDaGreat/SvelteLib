/**
 * ACTIVATE: OPEN `signal`, THE MIDI SEQUENCER, ON THIS WIDGET'S CLIP.
 *
 * ── THE ASK (user, 2026-08-08) ──────────────────────────────────────────────
 * The MIDI widgets should "bring up full fledged UI's in giant modals when duoble
 * clicked (imitating the website with the giant piano for surge and a fullscreen
 * midi piano roll editor ported over)".
 *
 * ── AND THE STANDING RULING ABOUT WHOSE EDITOR IT IS ────────────────────────
 * "the piano roll open source thing should NOT be vibecoded" / "Hopefully your
 * agent is LITERALLY USING the midi code I gave? Not just trying to reimplement
 * it" / "Again, USE IT dont imitate it". The editor this handler opens is
 * ryohey's `signal` (https://github.com/ryohey/signal, MIT), vendored at
 * web/public/signal/ and framed. It REPLACED a hand-rolled roll that violated that
 * ruling; the replacement is the point of this file's existence, not an
 * implementation detail of it.
 *
 * ── WHY THIS IS A HANDLER AND NOT A LINE IN CanvasView ─────────────────────
 * web/widget_handlers.js's whole argument, applied: a plugin may not carry a Svelte
 * component (core/ and plugins/ must import in bare node, and no plugin may import
 * another), so it carries a STRING — `activate: "signal_edit"` — and this file,
 * which lives in the DOM layer, turns that string into behaviour. Adding the
 * editor therefore touches CanvasView not at all.
 *
 * ── WHY IT IS A MODAL AND NOT A CANVAS MODE ────────────────────────────────
 * The other activations that sustain a gesture (`keyboard_play`, `bento_bind_cell`,
 * `navigate_interior`) declare a `mode`, because they operate ON THE CANVAS: the
 * widget stays where it is and the mode reinterprets pointer input over it. signal
 * cannot work that way at any honest size — it is a whole application with a
 * transport bar, an arrange view and automation lanes, and a node card is a couple
 * of hundred pixels. So this handler declares NO mode: it raises an app signal,
 * App.svelte mounts the dialog, and the canvas is simply covered. That is the same
 * shape `code_modal` uses, for the same reason, and it is why neither needs
 * `enterMode`.
 *
 * A consequence that is a feature: because the dialog carries `role="dialog"`,
 * App.svelte's focusContext sees `dialog: true` and every canvas shortcut chip
 * stands down while it is open. signal's own keys cannot collide with the app's —
 * which matters far more here than it did for a roll we wrote, because signal has
 * a full shortcut map of its own and we do not get to choose it.
 */

/**
 * THE HANDLER. `claims` reads the widget's CONTENT DESCRIPTOR — an editable
 * `midiClip` declaration — which is what makes forgetting the one-line `activate`
 * string a TEST FAILURE (tests/activation_migration_test.js asserts
 * `migrationPlan` is empty) rather than a widget that quietly does nothing when
 * you double-click it.
 *
 * `editable` is part of the claim on purpose. A widget can declare `midiClip` to
 * say WHERE its notes live without them being hand-editable — an ABC node's are
 * derived from text and must be edited as text (plugins/node_abc.js states why a
 * round-trip through a roll is the wrong shape) — and such a widget must not be
 * claimed by an editor that would write back over its source.
 */
export const SIGNAL_EDIT_HANDLER = {
  id: "signal_edit",
  phase: "activate",
  label: "Edit clip in signal",
  /** Pure function. `midiClip: {key, activeKey, editable}` names WHICH list leaves
   * hold this widget's notes, so a widget declaring an EDITABLE one wants this
   * trigger. migrationPlan-only.
   * @example // claims({midiClip: {key: "clip", editable: true}}) → true
   * @example // claims({midiClip: {key: "clip"}}) → false (derived, not editable)
   * @example // claims({type: "rect"}) → false */
  claims: (plugin) => !!plugin.midiClip?.editable,
  /** Command. Selects the widget and raises the app's signal-editor signal. The
   *  selection is the app's own concern (openSignalEditor does it) so that opening
   *  the editor from the palette and from a double-click cannot leave the Inspector
   *  pointing at different items. */
  run(ctx) {
    ctx.app.openSignalEditor(ctx.node.itemId);
  },
};
