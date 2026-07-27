/**
 * KEYBOARD-INPUT SWEEP — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/shortcut_sweep_test.js
 * Inventory (what the scanner sees, for authoring the allowlist):
 *     node src/demo_apps/PowerRP/tests/shortcut_sweep_test.js --inventory
 *
 * WHY THIS EXISTS. "A shortcut that isn't registered does not exist" is a claim
 * about the WHOLE codebase, and tests/shortcut_registry_test.js can only check the
 * entries that ARE registered. It cannot see a component that quietly grows a
 * `keydown` listener or reads `e.shiftKey` and tells nobody — which is exactly how
 * multi-selection resize ended up reading Shift and Cmd with nothing on the
 * HintBar, and how the command palette ended up with five keys and one chip.
 *
 * So this sweep goes the other way: it enumerates EVERY keyboard input the source
 * actually reads and requires each to be ACCOUNTED FOR — either by naming the
 * registry entries that cover it, or by a written LOCAL rationale for why it is
 * confined to its own component. An unlisted file, or a new key inside a listed
 * file, fails. That is the mechanical form of the convention.
 *
 * It sweeps EVERY real source artifact rather than a sample (the tests/
 * row_kinds_test.js idiom): web/, plugins/, core/, minus the build output.
 *
 * WHAT A `coverage` STRING MEANS:
 *   "registry: …"  the keys are registered in core/shortcut_entries.js (dispatched
 *                  there, or dispatched here and registered for the HintBar — the
 *                  documented "registered but externally dispatched" case).
 *   "LOCAL: …"     deliberately NOT registered, with the reason. The bar is a
 *                  finite surface; universal platform conventions (Enter/Space
 *                  activating a focused control, arrow keys in a listbox, caret
 *                  motion in a text field) are already known to every user and
 *                  would drown the app-invented verbs that need teaching.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
// SHARED CONTROLS ARE SWEPT TOO. `../../lib` is SvelteLib's src/lib — the
// component library this app is built out of, where DraggableNumber, AngleField's
// dial siblings, Dropdown, Modal, Tooltip, ColorPicker, PanZoom and the HintBar
// itself actually read the keyboard. It was outside the sweep for its whole life,
// which is exactly how the numeric-field key leak reached a user: web/NumericField
// was accounted for, and the `div[role=spinbutton]` INSIDE it — the thing that
// swallowed or leaked the keystroke — was invisible to this test. A shared control
// is not less bound by "a shortcut that isn't registered does not exist"; it is
// more, since one unaccounted key there is unaccounted in every consumer.
const SWEPT_DIRS = ["web", "plugins", "core", "../../lib"];
// Vite build output: a checked-in copy of third-party bundles, not source we own.
const SKIP_PREFIXES = ["web/dist/"];

/**
 * Query. Every source file under the swept directories, as repo-relative paths.
 *
 * @example // sweptFiles().includes("web/App.svelte") → true
 * @example // sweptFiles().some((f) => f.startsWith("web/dist/")) → false
 */
function sweptFiles() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (SKIP_PREFIXES.some((p) => child.startsWith(p))) continue;
      if (e.isDirectory()) walk(child);
      else if (/\.(js|svelte)$/.test(e.name)) out.push(child);
    }
  };
  for (const d of SWEPT_DIRS) walk(d);
  return out.sort();
}

// A KeyboardEvent parameter is called one of these everywhere in this codebase; the
// restriction is what keeps `row.key` / `prop.key` (ordinary object keys, which are
// everywhere in the Inspector) out of the inventory.
const EVENT_NAMES = String.raw`e|ev|evt|event`;
const LISTENER_RE = new RegExp(String.raw`on(?:keydown|keyup|keypress)\s*[=:]|addEventListener\(\s*["'](?:keydown|keyup|keypress)["']`, "i");
const MODIFIER_RE = /\.(?:shiftKey|metaKey|ctrlKey|altKey)\b/;

/**
 * Pure function. The key-name literals a source file compares a KeyboardEvent
 * against. Covers the three shapes this codebase uses: a direct comparison
 * (`e.key === "Escape"`), a `switch (e.key)` over `case` labels, and an ALIAS
 * (`const k = e.key;` then `k === "Escape"` — TextEditController's shape, which a
 * naive `\.key ===` scan misses entirely).
 *
 * @example keyLiterals(`if (e.key === "Escape") x();`) // ["Escape"]
 * @example keyLiterals(`const k = e.key; if (k === "Tab") x();`) // ["Tab"]
 * @example keyLiterals(`switch (e.key) { case "Home": x(); }`) // ["Home"]
 * @example keyLiterals(`if (row.key === "active") x();`) // []  — not an event
 */
export function keyLiterals(src) {
  const found = new Set();
  const direct = new RegExp(String.raw`(?:${EVENT_NAMES})\.(?:key|code)\s*(?:===|!==|==)\s*["']([^"']*)["']`, "g");
  const reversed = new RegExp(String.raw`["']([^"']*)["']\s*(?:===|!==|==)\s*(?:${EVENT_NAMES})\.(?:key|code)`, "g");
  for (const re of [direct, reversed]) for (const m of src.matchAll(re)) found.add(m[1]);
  if (new RegExp(String.raw`switch\s*\(\s*(?:${EVENT_NAMES})\.(?:key|code)\s*\)`).test(src))
    for (const m of src.matchAll(/case\s+["']([^"']*)["']\s*:/g)) found.add(m[1]);
  const aliases = [...src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*(?:${EVENT_NAMES})\.(?:key|code)\b`, "g"))].map((m) => m[1]);
  for (const a of aliases) {
    const cmp = new RegExp(String.raw`\b${a}\s*(?:===|!==|==)\s*["']([^"']*)["']|["']([^"']*)["']\s*(?:===|!==|==)\s*\b${a}\b`, "g");
    for (const m of src.matchAll(cmp)) found.add(m[1] ?? m[2]);
    if (new RegExp(String.raw`switch\s*\(\s*${a}\s*\)`).test(src))
      for (const m of src.matchAll(/case\s+["']([^"']*)["']\s*:/g)) found.add(m[1]);
  }
  return [...found].sort();
}

/** Query. The keyboard-input inventory: one row per file that reads keys. */
function inventory() {
  return sweptFiles().flatMap((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const listener = LISTENER_RE.test(src);
    const modifiers = MODIFIER_RE.test(src);
    if (!listener && !modifiers) return [];
    return [{ file: f, listener, modifiers, keys: keyLiterals(src) }];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ALLOWLIST. Every file that reads a keyboard input, what keys it reads, and
// what accounts for them. `keys` is the exact scanner inventory — a new key in a
// listed file fails until it is declared here WITH a decision about registering it.
// ─────────────────────────────────────────────────────────────────────────────
const ACCOUNTED = {
  "core/shortcuts.js": {
    keys: [" "],
    modifiers: true,
    coverage: "registry: THIS IS the registry — dispatch() reads the modifier flags to match an entry's combo, and keyToken() rewrites the space bar's raw key (\" \") to the \"Space\" token every entry is written against. The one file where reading a key needs no further justification.",
  },
  "web/App.svelte": {
    keys: [],
    coverage: "registry: the app-level keydown/paste listeners hand every event to app.shortcuts.dispatch(). It compares no key literal of its own — that is the point of the registry.",
  },
  "web/CanvasView.svelte": {
    keys: ["A", "Escape", "a"],
    modifiers: true,
    coverage: "registry: modifier reads are the per-drag-kind verbs declared in DRAG_KIND_MODIFIERS and announced by DRAG_MODIFIER_HINTS (Shift/Cmd/Alt per kind). Held A is the 'Anchor snap' entry; Escape is the 'Cancel drag' entry, dispatched here from a CAPTURE-phase listener so it pre-empts App's bubble-phase Deselect (the deselectable predicate keeps that chip off the bar for the gesture).",
  },
  "web/TextEditController.svelte": {
    keys: ["Backspace", "Delete", "End", "Enter", "Escape", "Home", "a", "b", "i", "u", "y", "z", "+", "-", "=", "_", "A", "B", "I", "U", "Y", "Z", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"],
    modifiers: true,
    coverage: "registry (the app-specific half): Escape 'Done editing'; Cmd+B/I/U bold/italic/underline; Cmd+=/+ and Cmd+-/_ the size steppers; Cmd+Z / Cmd+Shift+Z / Cmd+Y the EDIT-BUFFER history (a separate undo stack from the document's, which is exactly why it must be announced); Cmd+A select all. LOCAL (ruling, not an oversight): caret motion and text mutation — arrows, Alt+arrows by word, Cmd+arrows to line ends, Home/End, Shift+arrows to extend, Backspace/Delete/Enter, printable characters. Universal platform text-editing conventions handled by the focused editor, with no effect outside it; registering them would add ~10 chips every user already knows and would drown the app-invented verbs above.",
  },
  "web/CodeEditController.svelte": {
    keys: ["Enter", "Escape", "Tab"],
    modifiers: true,
    coverage: "registry: Escape 'Done editing', Cmd+Enter its hidden alias, Tab 'Indent' and Shift+Tab 'Outdent' (announced because a textarea does NOT indent by default — the panel overrides the browser's focus-move, the kind of app-specific rebinding the bar exists to teach). LOCAL: the auto-close bracket pairs, keyed off the typed character itself rather than a named shortcut.",
  },
  "web/LatexEditController.svelte": {
    keys: ["Escape"],
    coverage: "registry: Escape 'Done editing' (latexEditing). Everything else inside the field is MathLive's own editing surface.",
  },
  "web/CommandPalette.svelte": {
    keys: ["ArrowDown", "ArrowUp", "Backspace", "Enter", "Escape"],
    coverage: "registry: Escape 'Back / close', Backspace its hidden alias (empty query inside a submenu), Up 'Prev result', Down 'Next result', Enter 'Run' — all paletteContext-scoped. Registered in this pass: the palette was the worst offender against the convention, with five real keys and exactly one chip on the bar (the 'Palette' toggle, which cannot even fire while the palette is open).",
  },
  "web/PresentMode.svelte": {
    keys: [" ", "ArrowLeft", "ArrowRight", "Escape", "PageDown", "PageUp"],
    coverage: "registry: every presenter key is a presentMode entry — Right/Space/PageDown next, Left/PageUp prev, Escape exit. Dispatched here from a capture-phase window listener that claims them for the fullscreen takeover; registered for the bar.",
  },
  "web/AngleField.svelte": {
    keys: ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Enter", "Escape", "Tab"],
    modifiers: true,
    coverage: "registry: Shift 'Coarse adjust' (fieldFocus('dial')) — app-invented vocabulary nobody can guess, so it is announced whenever the dial has focus. LOCAL: the arrow keys themselves (role=slider; adjusting a focused slider with arrows is the platform's own ARIA convention) and Enter/Escape/Tab inside its equation <input> (commit / revert / leave — universal field conventions). The dial also CLAIMS the plain keyspace while focused (src/lib/fieldKeys.js fieldOwnsKeydown → stopPropagation) so no canvas command fires behind it: an svg[role=slider] is not a typing target, so Backspace used to delete the widget whose rotation was being edited and one arrow press both nudged the heading AND changed slide. Cmd/Ctrl/Alt combos, held modifiers and Tab/Escape/Enter still bubble, so app undo and the row's own Escape-revert are untouched.",
  },
  "web/NumericField.svelte": {
    keys: ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"],
    coverage: "registry: the DraggableNumber it wraps contributes Shift 'Fine adjust' and Home/End 'Minimum'/'Maximum' through fieldFocus('scrubber'). LOCAL: Enter/Escape/Tab/arrows in the equation-entry <input> and its suggestion list — universal field and listbox conventions; plus the row's own Escape (onWrapKeydown) which reverts a live scrub preview and stopPropagations, which is precisely why the scrubber below it does NOT claim Escape (src/lib/fieldKeys.js HOST_KEY_NAMES). The scrubber itself claims every OTHER plain key while focused, so no canvas command fires behind a number being edited — the sweep cannot see that decision because it lives in src/lib, which SWEPT_DIRS does not cover.",
  },
  "web/Inspector.svelte": {
    keys: ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"],
    coverage: "LOCAL: property-row text inputs and their equation-suggestion listbox. Commit on Enter, revert on Escape, move focus with Tab, walk the suggestions with arrows — universal field/listbox conventions, each confined to the focused row. The registry's typingTarget axis makes the canvas chips stand down while any of them has focus, so the bar does not lie about what these keys do.",
  },
  "web/FontPicker.svelte": {
    keys: ["ArrowDown", "ArrowUp", "Enter", "Escape"],
    coverage: "LOCAL: a combobox — filter, walk with arrows, choose with Enter, dismiss with Escape. The platform's own listbox conventions, effect confined to the open picker.",
  },
  "web/ShapePicker.svelte": {
    keys: ["Escape"],
    coverage: "LOCAL: Escape dismisses the open picker popover, the universal dismiss-a-popover convention.",
  },
  "web/ColorField.svelte": {
    keys: ["Escape"],
    coverage: "LOCAL: Escape dismisses the open color popover (same popover convention).",
  },
  "web/GradientPresetPicker.svelte": {
    keys: ["Escape"],
    coverage: "LOCAL: Escape dismisses the open preset popover (same popover convention).",
  },
  "web/GridSizePicker.svelte": {
    keys: [" ", "Enter"],
    coverage: "LOCAL: Enter/Space activate the focused grid cell — the platform's convention for activating a focused control, on a div that has to implement it by hand because it is not a <button>.",
  },
  "web/Toolbar.svelte": {
    keys: ["Enter", "F2"],
    coverage: "LOCAL: Enter commits the inline project-title rename and F2 starts it — both scoped to the title field, and F2 is the platform's own rename key. Not registered because a global chip for a key that only works on one hovered widget would be less honest than none.",
  },
  "web/SlideNav.svelte": {
    keys: ["Enter"],
    coverage: "LOCAL: Enter commits an inline slide rename (same field-commit convention).",
  },
  "web/VariablesPanel.svelte": {
    keys: ["Enter"],
    coverage: "LOCAL: Enter commits an inline variable name/value edit (same field-commit convention).",
  },
  "web/AssetThumb.svelte": {
    keys: ["Enter"],
    coverage: "LOCAL: Enter activates the focused asset tile (activate-a-focused-control convention).",
  },
  "web/VideoThumbnail.svelte": {
    keys: ["Enter"],
    coverage: "LOCAL: Enter activates the focused video tile (activate-a-focused-control convention).",
  },
  // ── SvelteLib src/lib: THE SHARED CONTROLS ──────────────────────────────────
  // `../../lib/…` — see SWEPT_DIRS. These are consumed by the web/ components
  // above, so each one's keys reach the editor through whatever mounts it, and the
  // LOCAL clause has to be argued about the CONTROL, not about a call site: keys
  // handled by the FOCUSED widget, effect confined to that widget, and a universal
  // platform convention the user already knows. src/lib/fieldKeys.js is where the
  // ownership boundary is DEFINED (fieldOwnsKeydown: a plain keystroke belongs to
  // the focused field; Cmd/Ctrl/Alt combos, bare modifiers and Tab/Escape/Enter
  // belong to the surface around it) — the rationales below cite it rather than
  // re-deciding it per component.
  "../../lib/fieldKeys.js": {
    keys: [],
    modifiers: true,
    coverage: "LOCAL: THIS IS the ownership boundary — fieldOwnsKeydown reads the modifier flags to decide whether a keydown is the focused field's plain keystroke or the host's application combo. It compares no key NAME of its own by design (the two name lists are exported constants, so a consumer cannot re-decide the split), and it dispatches nothing at all: it is a pure predicate the controls below call. The one file where reading a modifier needs no further justification, exactly as core/shortcuts.js is for keys.",
  },
  "../../lib/DraggableNumber.svelte": {
    keys: ["ArrowDown", "ArrowUp", "End", "Enter", "Escape", "Home"],
    modifiers: true,
    coverage: "registry: Shift is 'Fine adjust' under fieldFocus('scrubber'), and Home/End are 'Minimum'/'Maximum' under the same predicate plus numericFieldBounded — app-invented vocabulary, so all three are announced (they are the entries web/NumericField.svelte's note points at). LOCAL: Up/Down nudge one step, which is the platform's own spinbutton convention, and Enter/Escape commit/revert the text entry a click-without-drag opens. This is also the control the whole boundary exists for: it stopPropagations every keydown fieldOwnsKeydown claims, so no canvas command fires behind a number being edited (the leak measured in tests/field_key_ownership_probe.js — Backspace deleting the very widget whose number was focused), while Cmd/Ctrl combos, bare modifiers and Tab/Escape/Enter keep bubbling so app undo and a wrapper's own cancel still work.",
  },
  "../../lib/Dropdown.svelte": {
    keys: [" ", "ArrowDown", "ArrowUp", "End", "Enter", "Escape", "Home"],
    coverage: "LOCAL: a listbox — Space/Enter/Down open it, arrows walk the options, Home/End jump to first/last, Enter chooses, Escape dismisses. The platform's own ARIA listbox conventions, every effect confined to the open menu, and it stopPropagations Escape so a host cancel does not ALSO fire behind the dismiss (the innermost-cancel-wins nesting Modal.svelte's header documents).",
  },
  "../../lib/ColorPicker.svelte": {
    keys: ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Enter", "Escape"],
    coverage: "LOCAL: three focusable slider surfaces (the SV square, the hue strip, the alpha strip) nudged with arrows — the same role=slider ARIA convention web/AngleField's dial rides — plus Enter/Escape to commit/revert the hex <input>. Universal field and slider conventions, each confined to the focused surface inside an open popover.",
  },
  "../../lib/Modal.svelte": {
    keys: ["Escape", "Tab"],
    modifiers: true,
    coverage: "LOCAL: a dialog's two universal keys — Escape closes, Tab (and Shift+Tab, which is the modifier read) cycles the focus trap. Both are bound to the PANEL rather than to window, precisely so they do NOT also reach the app: one Escape used to close the dialog AND clear the canvas selection behind it (measured, and recorded at its onKeydown). The registry needs no entry because a dialog is a keyboard takeover the context axes already model — `dialogOpen` makes editorInput false, so the canvas chips stand down and the bar cannot claim keys the dialog has taken.",
  },
  "../../lib/Tooltip.svelte": {
    keys: ["Escape"],
    coverage: "LOCAL: Escape hides a shown tooltip — the universal dismiss-transient-chrome convention. It is a window listener but a PASSIVE one: it neither preventDefaults nor stopPropagations, so the same Escape still reaches whatever else means to act on it, and dismissing a hover tip changes no app state. Nothing to register, because nothing is claimed.",
  },
  "../../lib/Thumbnail.svelte": {
    keys: ["Enter"],
    coverage: "LOCAL: Enter activates the focused thumbnail — the activate-a-focused-control convention, on a div that must implement it by hand because it is not a <button>. Identical case to web/AssetThumb.svelte and web/VideoThumbnail.svelte above.",
  },
  "../../lib/PanZoom.svelte": {
    keys: [],
    modifiers: true,
    coverage: "registry: the modifier read is Ctrl on the WHEEL — Ctrl+scroll zooms, plain scroll pans — which is the pair of pointer hints core/shortcut_entries.js registers as 'Zoom' ({keys: ['Ctrl','mouse_scroll']}) and 'Pan' ({keys: ['mouse_scroll']}) under editMode. Display-only there, dispatched here: the registered-but-externally-dispatched case. No keydown listener at all; this container is also the element a canvas gesture moves focus TO (div[role=application], tabindex=-1), which is the fact fieldFocus's docstring cites.",
  },
  "../../lib/AnnotateBar.svelte": {
    keys: ["Enter", "Escape", "c", "t", "x"],
    modifiers: true,
    mounted: false,
    coverage: "LOCAL: NOT MOUNTED BY THIS APP — no file under web/, plugins/ or core/ imports it (asserted below, so the claim cannot go stale), so none of its keys are in the editor's keyspace and there is nothing for the registry to know. Recorded rather than skipped because its C/X/T hotkeys are WINDOW-scoped and app-invented, which is the one shape the LOCAL clause does NOT excuse: were PowerRP ever to mount this bar, those three would have to be registered (or scoped to the bar) before it shipped. Enter/Escape commit its inline comment edit and the modifier reads are Alt/Shift on its own pointer gestures — those parts would be ordinary field and drag-modifier cases.",
  },
};

// The lib components no allowlist entry claims are unmounted — i.e. everything the
// editor really does mount — must be imported SOMEWHERE, or the claim is backwards.
// Import specifiers are literal relative paths ("../../../lib/Modal.svelte"), so a
// basename match over the app's own source is exact enough to be a gate.
const APP_DIRS = ["web", "plugins", "core"];

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const rows = inventory();

if (process.argv.includes("--inventory")) {
  for (const r of rows)
    console.log(`${r.file}\n    listener=${r.listener} modifiers=${r.modifiers}\n    keys=${JSON.stringify(r.keys)}`);
  console.log(`\n${rows.length} files read keyboard input`);
  process.exit(0);
}

test("the scanner still finds keyboard input (the sweep is not vacuous)", () => {
  assert.ok(rows.length >= 20, `only ${rows.length} files matched — the scan patterns went stale, which would make every assertion below pass for the wrong reason`);
  const app = rows.find((r) => r.file === "web/App.svelte");
  assert.ok(app?.listener, "web/App.svelte must be found as a keyboard listener — it owns the app-level keydown");
  // The lib half specifically: SWEPT_DIRS reaching src/lib is the whole point of
  // the extension, and a walk that silently found nothing there would leave the
  // hole open while every assertion below still passed.
  const lib = rows.filter((r) => r.file.startsWith("../../lib/"));
  assert.ok(lib.length >= 5, `the src/lib walk found only ${lib.length} keyboard-reading files — the shared controls (DraggableNumber, Dropdown, Modal, …) are where the numeric-field leak hid, so a sweep that stops at the app boundary is the hole this covers`);
  const scrubber = rows.find((r) => r.file === "../../lib/DraggableNumber.svelte");
  assert.ok(scrubber?.listener && scrubber.modifiers, "../../lib/DraggableNumber.svelte must be found as a keyboard listener that reads modifiers — it is the control the field-key boundary exists for");
});

test("a lib entry claiming it is NOT MOUNTED really is not imported by this app", () => {
  const appSources = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (SKIP_PREFIXES.some((p) => child.startsWith(p))) continue;
      if (e.isDirectory()) walk(child);
      else if (/\.(js|svelte)$/.test(e.name)) appSources.push(child);
    }
  };
  for (const d of APP_DIRS) walk(d);
  const sources = appSources.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"));
  for (const [file, spec] of Object.entries(ACCOUNTED)) {
    if (!file.startsWith("../../lib/")) continue;
    const specifier = `lib/${path.basename(file)}`;
    const importers = appSources.filter((_, i) => sources[i].includes(specifier));
    if (spec.mounted === false)
      assert.deepEqual(importers, [], `${file}'s coverage claims it is NOT MOUNTED by this app, but ${JSON.stringify(importers)} import it. Its keys ARE in the editor's keyspace, so the rationale has to be argued on the control instead.`);
    else
      assert.ok(importers.length > 0, `${file} carries no "mounted: false" marker, so its coverage note is written as if the app mounts it — but nothing under ${APP_DIRS.join("/, ")}/ imports it. Either add mounted: false and say so in the note, or fix the note.`);
  }
});

test("every file that reads keyboard input is accounted for", () => {
  for (const r of rows)
    assert.ok(
      ACCOUNTED[r.file],
      `${r.file} reads keyboard input (${r.listener ? "listener" : ""}${r.modifiers ? " modifiers" : ""}, keys ${JSON.stringify(r.keys)}) but is not in the sweep allowlist. Either register those inputs in core/shortcut_entries.js and record "registry: …" here, or record "LOCAL: …" with the reason they stay confined to this component. An unlisted keyboard input is the convention violation this test exists to stop.`,
    );
});

test("every key a listed file reads is declared (a new key fails the sweep)", () => {
  for (const r of rows) {
    const declared = ACCOUNTED[r.file].keys;
    for (const k of r.keys)
      assert.ok(
        declared.includes(k),
        `${r.file} reads the key ${JSON.stringify(k)}, which its allowlist entry does not declare. Add it — and while adding it, decide whether it belongs in the registry (an app-invented verb) or is a universal platform convention that stays LOCAL. That decision is the whole point of this failure.`,
      );
  }
});

test("no allowlist entry declares a key its file no longer reads", () => {
  for (const r of rows)
    for (const k of ACCOUNTED[r.file].keys)
      assert.ok(
        r.keys.includes(k),
        `the allowlist says ${r.file} reads ${JSON.stringify(k)} but the scanner no longer finds it — drop it, so the allowlist stays a description of the code rather than a wish.`,
      );
});

test("no allowlist entry names a file that no longer reads keyboard input", () => {
  const seen = new Set(rows.map((r) => r.file));
  for (const f of Object.keys(ACCOUNTED))
    assert.ok(seen.has(f), `the allowlist lists ${f}, which no longer reads keyboard input — remove the stale entry.`);
});

test("modifier reads are declared where they happen", () => {
  for (const r of rows) {
    const declared = !!ACCOUNTED[r.file].modifiers;
    assert.equal(
      r.modifiers, declared,
      r.modifiers
        ? `${r.file} reads a modifier flag (shiftKey/metaKey/ctrlKey/altKey) but its allowlist entry does not say so. A held modifier that changes behaviour is precisely the class of hidden verb the user reported ("Shift and other keys do not pop up") — set modifiers: true and make sure the coverage names the entry that announces it.`
        : `${r.file}'s allowlist entry claims modifiers: true but the scanner finds no modifier read — drop the claim.`,
    );
  }
});

test("every coverage note is a registry citation or a written LOCAL rationale", () => {
  for (const [file, spec] of Object.entries(ACCOUNTED)) {
    assert.ok(spec.coverage, `${file} has no coverage note`);
    assert.ok(
      /^(registry|LOCAL)/.test(spec.coverage),
      `${file}'s coverage note must start with "registry:" (naming the entries that cover it) or "LOCAL:" (giving the reason it is not registered) — got ${JSON.stringify(spec.coverage.slice(0, 40))}`,
    );
    assert.ok(spec.coverage.length > 60, `${file}'s coverage note is too short to be a real rationale: ${JSON.stringify(spec.coverage)}`);
  }
});

console.log(`\n${passed} keyboard-sweep tests passed (${rows.length} files read keyboard input)`);
