/**
 * fieldKeys [general] — WHICH keydowns a focused value-editing control owns, and
 * which belong to the surface around it.
 *
 * WHY THIS EXISTS. A control built out of a `div[role=spinbutton]` or an
 * `svg[role=slider]` takes focus and receives keystrokes like any field, but it is
 * not an INPUT/TEXTAREA/SELECT/contenteditable — so a host app that skips its
 * global shortcuts "while a text field is focused" (the universal test, by tag
 * name) does NOT skip them for these. The result measured in PowerRP: with a
 * widget selected and its number field focused, Backspace ran the app's
 * delete-the-selection command and DELETED THE WIDGET the user was editing;
 * Left/Right changed slide; G started a modal transform.
 *
 * The fix is the one every focused control already owes its host: claim the
 * keystrokes that are yours (stopPropagation) and let the rest through. This
 * module is the ONE definition of that boundary, shared by every such control
 * rather than re-decided per component.
 *
 * THE BOUNDARY, and the reason for each side of it:
 *   CLAIMED — every plain keystroke. That is what focus MEANS: a keystroke aimed
 *     at a focused control is not also a canvas command. It is the same treatment
 *     the sibling state of these very controls already gets for free, since a
 *     click-to-type field renders a real <input> and every host skips those.
 *   NOT CLAIMED — a combo carrying Cmd/Ctrl/Alt. Those are application commands
 *     (undo, copy, the command palette) and they LEGITIMATELY work while a field
 *     is focused; swallowing them would trade one bug for another.
 *   NOT CLAIMED — a bare modifier press. The modifier is read as a FLAG (on the
 *     drag/keystroke it modifies), by the control AND by whatever else tracks held
 *     keys; swallowing the press itself changes nothing for the control and breaks
 *     those trackers.
 *   NOT CLAIMED — Tab, Escape, Enter: leave / cancel / confirm. The three verbs
 *     that belong to the surface AROUND a control, not to the control. Tab's whole
 *     meaning is "leave this control"; and a wrapper commonly owns the other two —
 *     PowerRP's NumericField claims Escape on the row to revert a live preview, and
 *     lib/Modal.svelte claims Escape + Tab on the dialog panel, both of which a
 *     control that swallowed them would break.
 */

/**
 * Keys whose keydown is a MODE CHANGE rather than a keystroke. Control/Alt/Meta
 * are listed for completeness even though their own flags already exclude them
 * (a Control press carries ctrlKey), so the set reads as what it is: every key
 * that means "I am now holding something".
 */
export const MODIFIER_KEY_NAMES = Object.freeze([
  "Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock",
]);

/**
 * Keys that belong to the surface AROUND a focused control: leave, cancel,
 * confirm. See the header — a wrapper or dialog commonly owns these, so a control
 * that swallowed them would break its own host.
 */
export const HOST_KEY_NAMES = Object.freeze(["Tab", "Escape", "Enter"]);

/**
 * Pure function. Does this keydown belong to the FOCUSED FIELD, so the field
 * should claim it (stopPropagation) instead of letting a host shortcut fire?
 *
 * Takes anything with a KeyboardEvent's shape, so it is testable in bare node.
 *
 * @param {{key: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean}} e
 * @returns {boolean}
 *
 * @example fieldOwnsKeydown({key: "Backspace"}) // true  — a plain keystroke aimed at the field
 * @example fieldOwnsKeydown({key: "ArrowLeft"}) // true
 * @example fieldOwnsKeydown({key: "g"}) // true
 * @example fieldOwnsKeydown({key: "z", metaKey: true}) // false — application undo
 * @example fieldOwnsKeydown({key: "Backspace", metaKey: true}) // false — a modified combo is the host's
 * @example fieldOwnsKeydown({key: "Shift"}) // false — a held modifier, read as a flag
 * @example fieldOwnsKeydown({key: "Escape"}) // false — the surface around the field cancels
 * @example fieldOwnsKeydown({key: "Tab"}) // false — Tab means "leave this control"
 */
export function fieldOwnsKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return !MODIFIER_KEY_NAMES.includes(e.key) && !HOST_KEY_NAMES.includes(e.key);
}
