/**
 * Svelte action: focus a text input and SELECT ALL of its text as soon as it
 * mounts.
 *
 * This is InlineRename's focus/select behaviour extracted for the inputs that
 * are NOT inline editors — a MODAL rename or save-as field, which stays a modal
 * and so cannot be the component. One convention, two shapes: wherever a name
 * field opens PRE-FILLED with the current name, typing must REPLACE it (user
 * ruling: "it should by default select all the text — so that if I simply start
 * typing it would rename the whole thing"). Arrow keys or a click collapse the
 * selection natively, so partial edits still work with no extra code.
 *
 * WHY AN ACTION AND NOT `autofocus`: `autofocus` focuses but selects nothing,
 * which is exactly the bug — the caret lands at one end and typing APPENDS to
 * the old name. An action runs after its node is in the DOM with its value
 * already bound, which is the moment `select()` is meaningful.
 *
 * The deferral matters when the input is inside a portalled/focus-trapping
 * dialog: Modal.svelte moves focus to the first focusable on open, in a
 * microtask of its own. Running in a LATER macrotask lets that land first, so
 * the trap does not re-focus (and thereby collapse the selection of) this input
 * after we selected it. Focusing here too, rather than relying on the trap,
 * keeps the action correct for a plain input with no dialog around it.
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} node The field to focus+select.
 * @returns {{destroy: function}} Svelte action handle (cancels a pending frame).
 *
 * Examples:
 *     >>> // <input bind:value={renameName} use:selectAllOnMount />
 *     >>> // opens focused with "My Project" fully selected; typing replaces it
 */
export function selectAllOnMount(node) {
  const frame = requestAnimationFrame(() => {
    node.focus();
    node.select();
  });
  return {
    destroy() {
      cancelAnimationFrame(frame);
    },
  };
}
