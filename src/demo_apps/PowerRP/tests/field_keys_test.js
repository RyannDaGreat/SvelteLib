/**
 * fieldKeys tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/field_keys_test.js
 *
 * Covers THE key-ownership boundary for focused value-editing controls
 * (src/lib/fieldKeys.js), which lib/DraggableNumber and web/AngleField both apply:
 *   (1) the doctested cases of fieldOwnsKeydown;
 *   (2) the boundary stated as properties rather than examples — every plain key is
 *       claimed, every Cmd/Ctrl/Alt combo is not, no bare modifier is, and the three
 *       host verbs (Tab/Escape/Enter) are not;
 *   (3) the KEYS THE DEFECT WAS ABOUT, named one by one against the registry's own
 *       KEYBINDING_DEFAULTS: every unmodified editor binding must be claimed (it
 *       must not fire from behind a focused field) and every modified one must not
 *       be (Cmd+Z legitimately works there). Derived from the real bindings, so a
 *       NEW unmodified binding is covered the day it is added — the hand-written
 *       version of this list is the class of thing that goes stale silently.
 *
 * fieldKeys.js is DOM-free (it reads only a KeyboardEvent's shape), so this runs in
 * bare node against plain objects.
 */

import assert from "node:assert/strict";
import { fieldOwnsKeydown, MODIFIER_KEY_NAMES, HOST_KEY_NAMES } from "../../../lib/fieldKeys.js";
import { KEYBINDING_DEFAULTS } from "../core/shortcut_entries.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) the doctested cases ──────────────────────────────────────────────────
test("the docstring's examples hold", () => {
  assert.equal(fieldOwnsKeydown({ key: "Backspace" }), true);
  assert.equal(fieldOwnsKeydown({ key: "ArrowLeft" }), true);
  assert.equal(fieldOwnsKeydown({ key: "g" }), true);
  assert.equal(fieldOwnsKeydown({ key: "z", metaKey: true }), false);
  assert.equal(fieldOwnsKeydown({ key: "Backspace", metaKey: true }), false);
  assert.equal(fieldOwnsKeydown({ key: "Shift" }), false);
  assert.equal(fieldOwnsKeydown({ key: "Escape" }), false);
  assert.equal(fieldOwnsKeydown({ key: "Tab" }), false);
});

// ── (2) the boundary as properties ───────────────────────────────────────────
test("every plain keystroke is claimed", () => {
  for (const key of ["a", "Z", "0", "9", ".", "-", "=", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", " ", "F2", "Insert"])
    assert.equal(fieldOwnsKeydown({ key }), true, `${JSON.stringify(key)} is a plain keystroke aimed at the focused field`);
});

test("Shift alone does not un-claim a keystroke (Shift is the field's own fine/coarse modifier)", () => {
  for (const key of ["ArrowUp", "Home", "b"])
    assert.equal(fieldOwnsKeydown({ key, shiftKey: true }), true, `Shift+${key} is still a keystroke aimed at the field`);
});

test("a Cmd/Ctrl/Alt combo is never claimed — those are the host's commands", () => {
  for (const mod of ["metaKey", "ctrlKey", "altKey"])
    for (const key of ["z", "c", "v", "d", "Backspace", "Delete", "ArrowLeft", "b", "p"])
      assert.equal(
        fieldOwnsKeydown({ key, [mod]: true }), false,
        `${mod}+${key} must keep bubbling: undo/copy/paste/duplicate legitimately work while a field is focused, and swallowing them would trade one bug for another`,
      );
});

test("no bare modifier press is claimed (held modifiers are read as FLAGS)", () => {
  for (const key of MODIFIER_KEY_NAMES)
    assert.equal(
      fieldOwnsKeydown({ key }), false,
      `a bare ${key} press must bubble — the control reads the modifier off the keystroke/drag it modifies, and a host's held-modifier tracker needs the press`,
    );
});

test("the host verbs leave/cancel/confirm are not claimed", () => {
  for (const key of HOST_KEY_NAMES)
    assert.equal(
      fieldOwnsKeydown({ key }), false,
      `${key} belongs to the surface around the control (a wrapper's Escape-revert, a dialog's Tab trap, a modal transform's Enter) — a control that swallowed it would break its own host`,
    );
  assert.deepEqual([...HOST_KEY_NAMES], ["Tab", "Escape", "Enter"]);
});

// ── (3) against the app's REAL editor bindings ───────────────────────────────
/** Pure function. Is this binding's combo one the host claims with a modifier?
 * `Cmd` in a binding covers Control too (core/shortcuts.js dispatch matches
 * either), so both flags are the same case here.
 *
 * @example // modified({keys: ["Cmd", "Z"]}) → true
 * @example // modified({keys: ["Backspace"]}) → false
 */
const modified = (b) => b.keys.some((k) => k === "Cmd" || k === "Ctrl" || k === "Alt");
/** Pure function. A binding's main key as a KeyboardEvent `key` value: the
 * registry writes tokens ("Left", "Backspace", "P"), and a keydown carries
 * "ArrowLeft", "Backspace", "p".
 *
 * @example // eventKey({keys: ["Left"]}) → "ArrowLeft"
 * @example // eventKey({keys: ["Cmd", "D"]}) → "d"
 */
function eventKey(b) {
  const token = b.keys[b.keys.length - 1];
  const arrows = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Space: " " };
  return arrows[token] ?? (token.length === 1 ? token.toLowerCase() : token);
}

test("every UNMODIFIED editor binding is claimed by a focused field", () => {
  const plain = KEYBINDING_DEFAULTS.filter((b) => !modified(b) && !HOST_KEY_NAMES.includes(eventKey(b)));
  assert.ok(plain.length >= 5, `only ${plain.length} unmodified bindings found — the derivation went stale, which would make this pass for the wrong reason`);
  for (const b of plain)
    assert.equal(
      fieldOwnsKeydown({ key: eventKey(b) }), true,
      `"${b.command}" is bound to the unmodified ${b.keys.join("+")}, so it WOULD fire from behind a focused number field. THIS is the reported defect (delete-item on Backspace deleted the widget being edited); the field must claim that key.`,
    );
});

test("the one unmodified binding a field does NOT claim is Escape, and something else covers it", () => {
  // `deselect` on a bare Escape is the single unmodified editor binding the field
  // lets through, and that is deliberate, not a hole: web/NumericField.svelte's row
  // wrapper claims Escape itself (revert the live scrub preview + blur +
  // stopPropagation), so the selection survives anyway. A control that swallowed
  // Escape would delete that revert. Proven end-to-end in
  // tests/field_key_ownership_probe.js ("Escape on a focused scrubber does NOT
  // deselect the widget"), which is what makes this exception safe to state here.
  const escapes = KEYBINDING_DEFAULTS.filter((b) => !modified(b) && HOST_KEY_NAMES.includes(eventKey(b)));
  assert.deepEqual(
    escapes.map((b) => `${b.command} on ${b.keys.join("+")}`), ["deselect on Escape"],
    "an unmodified editor binding landed on a Tab/Escape/Enter key that fields deliberately let through. Either the field must claim it (add it to fieldKeys.js) or a wrapper must, and the probe must prove which — this exception is only justified for `deselect`, whose revert NumericField already owns.",
  );
});

test("every MODIFIED editor binding still reaches the app from a focused field", () => {
  for (const b of KEYBINDING_DEFAULTS.filter(modified))
    assert.equal(
      fieldOwnsKeydown({ key: eventKey(b), metaKey: true }), false,
      `"${b.command}" is bound to ${b.keys.join("+")} and legitimately works while a field is focused — the field must NOT claim it`,
    );
});

console.log(`\n${passed} fieldKeys tests passed`);
