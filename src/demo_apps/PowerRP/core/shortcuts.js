/**
 * The shortcut registry — the SINGLE source of truth for inputs.
 *
 * Convention (from the manifest): a keyboard shortcut or button is only
 * eligible to exist if registered here, because this registry BOTH dispatches
 * keydown events AND feeds the HintBar at the bottom of the app. This closes
 * the video_slice_annotator gap where display hints and real listeners were
 * hand-duplicated.
 *
 * Entry shape:
 *   { keys: ["Ctrl","Z"],        // key tokens; "mouse_left" etc. for mouse
 *     label: "Undo",             // HintBar text
 *     when: (ctx) => bool,       // availability in the current app context
 *     command?: "undo",          // command id to run — THE normal case: every
 *                                //   shortcut routes through the command
 *                                //   registry, which lets the palette display
 *                                //   shortcuts automatically (commandKeys)
 *     run?: (ctx) => void }      // escape hatch for non-command UI state;
 *                                //   omit BOTH for display-only hints (mouse
 *                                //   gestures handled by pointer code still
 *                                //   REGISTER here for the HintBar)
 *
 * A MOUSE GESTURE entry is display-only BY CONSTRUCTION, and that is now ENFORCED
 * rather than conventional: dispatch() only ever reads KeyboardEvents, so an entry
 * whose main key is a mouse token could never fire, and add() throws if one carries
 * a `run`/`command` (see isGestureCombo). The registry keeps the KNOWLEDGE of the
 * input; the pointer code that owns the gesture keeps the behaviour.
 */

/**
 * A DOUBLE-CLICK of the left button. Spelled by suffixing the button token it is a
 * gesture ON rather than as a token of its own ("mouse_double"), so the two
 * compose: a double-click is the left button twice, not a different button.
 *
 * WHY IT EXISTS. Double-click was the one real input this registry had no
 * vocabulary for, so every double-click activation in the app — a polygon's
 * insert-point, the equation editor, the in-place text editors, the media asset
 * picker, a widget's overlay palette, interior explore — fired from a DOM
 * `dblclick` handler the registry knew nothing about. The HintBar therefore could
 * not show any of them, which is the "a shortcut that isn't registered does not
 * exist" violation on the ONE gesture a user cannot discover by accident: a key
 * gets pressed by mistake eventually, a double-click on the right widget does not.
 *
 * It also retires a wrong instruction. web/polygonDraw.js announced its own
 * double-click finish on `mouse_left` — a SINGLE-click glyph on a double-click
 * gesture, the "Plus"/"Minus" failure (see RETIRED_KEY_TOKENS) in mouse form — and
 * had to hide the chip entirely to stop it colliding with the real single-click
 * one. With its own token it collides with nothing and can be shown.
 */
export const MOUSE_DOUBLE_TOKEN = "mouse_left_double";

/**
 * The MOUSE GESTURE main keys. `mouse` is the generic form; the rest name the
 * button, the wheel, or (MOUSE_DOUBLE_TOKEN) a gesture on a button. Exported so a
 * consumer can ask "is this entry a gesture?" through isGestureCombo rather than
 * re-listing the vocabulary.
 */
export const MOUSE_TOKENS = new Set(["mouse_left", MOUSE_DOUBLE_TOKEN, "mouse_right", "mouse_middle", "mouse_scroll", "mouse"]);

/** The four modifier tokens dispatch() understands (Cmd covers Ctrl — see below). */
export const MODIFIER_TOKENS = Object.freeze(["Cmd", "Ctrl", "Alt", "Shift"]);

/**
 * The NAMED (non-printable) main keys a registry entry may bind. Each spelling
 * is EXACTLY what keyToken() produces from a real KeyboardEvent, which is what
 * makes the allowlist enforceable: a token that isn't here can never be matched
 * by dispatch(), so registering one is a shortcut that does not exist.
 * ("Left"/"Right"/"Up"/"Down" are keyToken's Arrow* → bare-direction rewrite.)
 */
export const NAMED_KEY_TOKENS = Object.freeze([
  "Escape", "Enter", "Tab", "Space", "Backspace", "Delete",
  "Home", "End", "PageUp", "PageDown",
  "Left", "Right", "Up", "Down",
  // F2 — the platform's own RENAME key (Toolbar title, item 61). keyToken() returns
  // event.key verbatim ("F2") for it, so this spelling is exactly what dispatch()
  // would see; no other function key is bound, so only F2 is admitted.
  "F2",
]);

/**
 * Misspellings that LOOK alive and are not — every one of these shipped in this
 * app at some point and silently produced a chip the user could not press.
 * Mapped to their replacement so the throw NAMES the fix, the same
 * retired-vocabulary treatment core/properties.js RETIRED_ROW_KINDS gets.
 *
 * "Esc": keyToken() returns event.key, and the DOM's key for that button is
 *   "Escape" — "Esc" can never match. It was invisible only because the entries
 *   using it happened to be display-only AND lib/keyicons.js maps both spellings.
 * "Plus"/"Minus": not key values at all. The HintBar rendered the literal WORDS
 *   "Plus"/"Minus" while the real keys were "="/"+" and "-"/"_" — a wrong
 *   instruction to the user, which is worse than a missing one.
 */
export const RETIRED_KEY_TOKENS = Object.freeze({
  Esc: "Escape",
  Return: "Enter",
  Plus: '"=" (with "+" as a hidden alias entry)',
  Minus: '"-" (with "_" as a hidden alias entry)',
  Meta: "Cmd",
  Command: "Cmd",
  Control: "Ctrl",
  Option: "Alt",
  Del: "Delete",
  Spacebar: "Space",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
});

for (const [retired, replacement] of Object.entries(RETIRED_KEY_TOKENS))
  if (MODIFIER_TOKENS.includes(retired) || NAMED_KEY_TOKENS.includes(retired) || MOUSE_TOKENS.has(retired))
    throw new Error(`shortcuts: "${retired}" is listed as RETIRED (use ${replacement}) but is ALSO a live token — one key, one spelling.`);

/**
 * The punctuation main keys in use. Deliberately NOT "every printable ASCII
 * character": a token is only legal once something registers it, so the list
 * grows with real use and the throw stays informative. "." and "-" are the modal
 * transform's numeric entry; "="/"+" and "-"/"_" are the text size steppers (the
 * unshifted and shifted face of the same physical key — hence both spellings);
 * "[" and "]" are slide navigation (the arrows nudge the selection instead).
 *
 * "," ";" "/" and "\\" joined for the KEYBOARD NODE's play mode (WORKSTREAM CB),
 * which binds the reference app's piano rows — the bottom row ends `, . /` and the
 * home row ends `;`, so the punctuation is not decoration, it is five of the keys.
 * They are the UNSHIFTED faces, which is what `keyToken()` returns and therefore
 * the only spelling that can match; the mode's own keyup reader uppercases before
 * comparing, so a letter and a punctuation key are looked up the same way.
 * This is the growth the list's own note above describes: a token is legal once
 * something registers it, and something now does.
 */
export const PUNCTUATION_KEY_TOKENS = Object.freeze([".", "-", "=", "+", "_", "[", "]", ",", ";", "/", "\\"]);

/**
 * Pure function. Is this a single PRINTABLE main key — the tokens keyToken()
 * passes through verbatim? Letters/digits only in their registered form:
 * UPPERCASE letters, because that is what the whole registry (and
 * keybindings.normalizeCombo) writes, and one spelling per key is the point.
 *
 * @example isPrintableKeyToken("A") // true
 * @example isPrintableKeyToken("7") // true
 * @example isPrintableKeyToken("=") // true
 * @example isPrintableKeyToken("a") // false — letters are registered uppercase
 * @example isPrintableKeyToken("Escape") // false — a NAMED key, not printable
 */
export function isPrintableKeyToken(token) {
  return /^[A-Z0-9]$/.test(token) || PUNCTUATION_KEY_TOKENS.includes(token);
}

/**
 * Pure function. Throws unless every token in `keys` is one dispatch() can
 * actually match: modifiers first, then exactly one main key (a named key, a
 * printable character, or a mouse gesture). A MODIFIER-ONLY combo is legal and
 * common — a held-modifier hint like ["Shift"] ("Uniform scale") announces a
 * verb the pointer code reads, and has no main key by nature.
 *
 * This is the import-time guard that kills the "Esc"/"Plus" class at boot in
 * EVERY consumer, rather than one entry at a time (house idiom: the loud
 * cross-check in render_gpu/skia/render_settings.js and core/properties.js).
 *
 * @example validateShortcutKeys(["Cmd", "Shift", "P"]) // undefined (ok)
 * @example validateShortcutKeys(["Shift"]) // undefined (ok — a held-modifier hint)
 * @example validateShortcutKeys(["mouse_left"]) // undefined (ok)
 * @example // validateShortcutKeys(["Esc"]) → throws: 'Esc' is retired, use "Escape"
 */
export function validateShortcutKeys(keys, label = "") {
  const where = label ? ` (entry "${label}")` : "";
  if (!Array.isArray(keys) || keys.length === 0)
    throw new Error(`Shortcut keys must be a non-empty array${where}, got ${JSON.stringify(keys)}`);
  keys.forEach((token, i) => {
    if (typeof token !== "string" || !token)
      throw new Error(`Shortcut key token must be a non-empty string${where}, got ${JSON.stringify(token)} in ${JSON.stringify(keys)}`);
    if (RETIRED_KEY_TOKENS[token])
      throw new Error(`Shortcut key token "${token}" is RETIRED${where} — use ${RETIRED_KEY_TOKENS[token]}. It can never match a real KeyboardEvent, so the entry would show a chip the user cannot press.`);
    const isModifier = MODIFIER_TOKENS.includes(token);
    const isMain = NAMED_KEY_TOKENS.includes(token) || MOUSE_TOKENS.has(token) || isPrintableKeyToken(token);
    if (!isModifier && !isMain)
      throw new Error(`Unknown shortcut key token "${token}"${where} in ${JSON.stringify(keys)} — dispatch() can never match it. Use a modifier (${MODIFIER_TOKENS.join("/")}), a named key (${NAMED_KEY_TOKENS.join("/")}), a single printable character, or a mouse token (${[...MOUSE_TOKENS].join("/")}).`);
    if (isModifier || i === keys.length - 1) return;
    throw new Error(`Shortcut "${keys.join("+")}"${where} has "${token}" before the last position — dispatch() reads keys[0..-2] as MODIFIERS and keys[-1] as the one main key, so only modifiers may precede it.`);
  });
}

/**
 * Pure function. Is this combo a MOUSE GESTURE — a main key dispatch() can never
 * see, because dispatch() only ever reads KeyboardEvents? Such an entry is
 * DISPLAY-ONLY by construction: the pointer code that owns the gesture invokes the
 * behaviour, and the entry exists so the registry (and therefore the HintBar and
 * the palette) KNOWS the input.
 *
 * @example isGestureCombo(["mouse_left"]) // true
 * @example isGestureCombo(["Shift", "mouse_left_double"]) // true
 * @example isGestureCombo(["Ctrl", "mouse_scroll"]) // true
 * @example isGestureCombo(["Cmd", "Z"]) // false
 */
export function isGestureCombo(keys) {
  return MOUSE_TOKENS.has(keys[keys.length - 1]);
}

export function createShortcuts() {
  const entries = [];
  return {
    /** Command. Registers one shortcut/hint entry. Throws on a malformed entry, an
     * unmatchable key token (validateShortcutKeys), or a mouse gesture that claims
     * to dispatch (isGestureCombo). */
    add(entry) {
      if (!entry.keys?.length || !entry.label || !entry.when)
        throw new Error(`Malformed shortcut entry: ${JSON.stringify(entry)}`);
      validateShortcutKeys(entry.keys, entry.label);
      // THE GESTURE HONESTY GUARD, and the reason the registry may claim mouse
      // entries are display-only instead of merely describing them that way: a
      // combo whose main key is a mouse token is unreachable from keydown
      // dispatch, so binding one to a command produces a chip the user can see,
      // press, and get nothing from — the same class as a RETIRED key token, and
      // previously a SILENT failure (dispatch() just skipped it).
      if (isGestureCombo(entry.keys) && (entry.run || entry.command))
        throw new Error(`Shortcut "${entry.keys.join("+")}" (entry "${entry.label}") binds a MOUSE GESTURE and also declares a ${entry.command ? `command ("${entry.command}")` : "run"} — dispatch() only ever reads KeyboardEvents, so it could never fire. A gesture entry is DISPLAY-ONLY: register it for the HintBar and let the pointer code that owns the gesture run the behaviour.`);
      entries.push(entry);
    },
    /** Query. Every registered entry, in registration order (the HintBar's order).
     * For tests/guards that must sweep the REAL population, not a sample. */
    all() {
      return [...entries];
    },
    /** Query. [keys, label] pairs for HintBar, filtered by context.
     * Entries with hidden:true dispatch but don't display (key aliases). */
    hints(ctx) {
      return entries.filter((e) => !e.hidden && e.when(ctx)).map((e) => [e.keys, e.label]);
    },
    /** Query. Key tokens bound to a command id (first match), or null. */
    commandKeys(commandId) {
      const e = entries.find((en) => en.command === commandId);
      return e ? e.keys : null;
    },
    /**
     * Command (runs the matched entry). Dispatches a KeyboardEvent against the
     * registry. Returns true if an entry ran (caller preventDefaults).
     */
    dispatch(event, ctx) {
      const token = keyToken(event);
      for (const e of entries) {
        // nativeEvent entries are delivered by a dedicated browser event (the
        // Paste key rides the native `paste` ClipboardEvent so it can read the
        // pasted image), NOT by keydown dispatch — skip them here so the key
        // never fires twice. commandKeys() still surfaces them to the palette.
        if ((!e.run && !e.command) || e.nativeEvent || !e.when(ctx)) continue;
        const mods = e.keys.slice(0, -1).map((k) => k.toLowerCase());
        const main = e.keys[e.keys.length - 1];
        // A BELT ON A PROVEN INVARIANT, and no longer this skip's own load: add()
        // rejects a gesture entry that carries a run/command, and the line above
        // already skipped everything WITHOUT one, so nothing reaching here can have
        // a mouse main key (tests/shortcut_registry_test.js asserts both halves).
        // Kept because dispatch is the last line of defence for "a gesture is never
        // delivered by a KeyboardEvent" — the same belt-on-a-proven-invariant call
        // web/widget_handlers.js findHandler makes about its ambiguous-id branch.
        if (MOUSE_TOKENS.has(main)) continue;
        const wantCtrl = mods.includes("ctrl") || mods.includes("cmd");
        const wantShift = mods.includes("shift");
        const wantAlt = mods.includes("alt");
        if (token.toLowerCase() !== main.toLowerCase()) continue;
        if (wantCtrl !== (event.metaKey || event.ctrlKey)) continue;
        if (wantShift !== event.shiftKey) continue;
        if (wantAlt !== event.altKey) continue;
        if (e.command) ctx.app.runCommand(e.command);
        else e.run(ctx);
        return true;
      }
      return false;
    },
  };
}

/**
 * Pure function. Normalizes a KeyboardEvent's key to a registry token.
 *
 * @example keyToken({key: "ArrowRight"}) // "Right"
 * @example keyToken({key: "z"}) // "z"
 * @example keyToken({key: " "}) // "Space"
 */
export function keyToken(event) {
  const k = event.key;
  if (k === " ") return "Space";
  if (k.startsWith("Arrow")) return k.slice(5);
  return k;
}
