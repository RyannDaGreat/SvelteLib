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
 */

const MOUSE_TOKENS = new Set(["mouse_left", "mouse_right", "mouse_middle", "mouse_scroll", "mouse"]);

export function createShortcuts() {
  const entries = [];
  return {
    /** Command. Registers one shortcut/hint entry. */
    add(entry) {
      if (!entry.keys?.length || !entry.label || !entry.when)
        throw new Error(`Malformed shortcut entry: ${JSON.stringify(entry)}`);
      entries.push(entry);
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
        if ((!e.run && !e.command) || !e.when(ctx)) continue;
        const mods = e.keys.slice(0, -1).map((k) => k.toLowerCase());
        const main = e.keys[e.keys.length - 1];
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
