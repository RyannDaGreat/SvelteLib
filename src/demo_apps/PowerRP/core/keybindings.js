/**
 * Configurable keybinding registry — an EDITOR setting.
 *
 * PowerRP tracks THREE settings categories (dump manifest, "Settings taxonomy
 * v2"): PRESENTATION settings (doc.meta, travel with the file), BROWSER
 * settings (per-browser localStorage: retina, theme, ...), and EDITOR
 * settings (user preferences). This module is the EDITOR-settings substrate
 * for CONFIGURABLE KEYBOARD SHORTCUTS: it maps key combos → command-palette
 * command ids, with defaults declared in code and user overrides layered on
 * top. A settings-editing UI is FUTURE work — this registry is only the
 * substrate that UI will edit.
 *
 * DOM-free on purpose (core/ must run in bare node; tests enforce this), so
 * storage is the caller's job. Intended browser persistence, under the
 * localStorage key "powerrp.keybindings":
 *
 *   save: localStorage.setItem("powerrp.keybindings",
 *                              JSON.stringify(kb.serializeOverrides()));
 *   load: const raw = localStorage.getItem("powerrp.keybindings");
 *         if (raw) kb.loadOverrides(JSON.parse(raw));
 *
 * Bridge to the shortcut registry (core/shortcuts.js) — the intended
 * App.svelte integration (shortcut entries keep routing through the command
 * registry, per the manifest invariant):
 *
 *   const kb = createKeybindings([
 *     { command: "undo",          keys: ["Ctrl", "Z"],         when: "editMode" },
 *     { command: "put-on-top",    keys: ["Cmd", "Shift", "F"], when: "editMode" },
 *     { command: "put-on-bottom", keys: ["Cmd", "Shift", "B"], when: "editMode" },
 *   ]);
 *   const raw = localStorage.getItem("powerrp.keybindings");
 *   if (raw) kb.loadOverrides(JSON.parse(raw));
 *   const labels = { undo: "Undo", "put-on-top": "Put on Top", ... };
 *   const resolvers = { editMode: (c) => c.mode === "edit" && !c.paletteOpen };
 *   for (const e of kb.toShortcutEntries(labels, resolvers)) app.shortcuts.add(e);
 *
 * A binding's `when` is the NAME of a context predicate; the names are
 * app-defined and resolved at bridge time via `whenResolvers` (compound
 * predicates like "editMode && hasSelection" just get their own name).
 * Naming a resolver that isn't provided throws at bridge time, so typos die
 * at startup instead of producing dead bindings.
 *
 * Scope (v1):
 * - ONE binding per command. Hidden key aliases (Backspace vs Delete) and
 *   display-only mouse-gesture hints stay hand-registered in App.svelte.
 * - createShortcuts() has no remove(); after a rebind at runtime, rebuild
 *   the shortcut registry from toShortcutEntries() output again.
 */

const MODIFIER_ALIASES = {
  cmd: "Cmd", command: "Cmd", meta: "Cmd",
  ctrl: "Ctrl", control: "Ctrl",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift",
};
const MODIFIER_ORDER = ["Cmd", "Ctrl", "Alt", "Shift"];

/**
 * Creates the keybinding registry.
 *
 * Args:
 *   defaults: [{command: "put-on-top",         // command-registry id
 *               keys: ["Cmd", "Shift", "F"],   // any alias/order; normalized
 *               when?: "editMode"}]            // NAME of a context predicate,
 *                                              //   resolved in toShortcutEntries
 *
 * Loud on malformed defaults: duplicate command ids, invalid combos, and
 * conflicting default combos all throw. Two defaults conflict when their
 * combos are equal AND their `when` contexts can overlap (same name, or
 * either side has no `when` — differently-NAMED contexts are assumed
 * disjoint, e.g. "editMode" vs "presentMode").
 *
 * @example
 *   const kb = createKeybindings([{ command: "undo", keys: ["ctrl", "z"], when: "editMode" }]);
 *   kb.bindingFor("undo") // ["Ctrl", "Z"]
 */
export function createKeybindings(defaults) {
  const registry = new Map(); // command → {keys: normalized combo, when?: string}
  for (const d of defaults ?? []) {
    if (typeof d?.command !== "string" || !d.command)
      throw new Error(`Default binding needs a command id string: ${JSON.stringify(d)}`);
    if (registry.has(d.command)) throw new Error(`Duplicate default binding for command "${d.command}"`);
    if (d.when !== undefined && typeof d.when !== "string")
      throw new Error(`Default binding "when" must be a context-flag name (string): ${JSON.stringify(d)}`);
    registry.set(d.command, { keys: normalizeCombo(d.keys), when: d.when });
  }
  const overrides = new Map(); // command → normalized combo | null (null = explicitly unbound)

  const requireKnown = (command) => {
    if (!registry.has(command)) throw new Error(`Unknown command "${command}" — not in keybinding defaults`);
  };
  // Query. Effective combo for a command: override if present, else default.
  const effectiveKeys = (command) => (overrides.has(command) ? overrides.get(command) : registry.get(command).keys);
  // Query. First OTHER command whose effective binding collides with `keys`
  // in an overlapping `when` context, or null.
  const findConflict = (command, keys) => {
    const when = registry.get(command).when;
    for (const [other, spec] of registry) {
      if (other === command) continue;
      const otherKeys = effectiveKeys(other);
      if (otherKeys && comboEquals(otherKeys, keys) && whensOverlap(when, spec.when)) return other;
    }
    return null;
  };
  // Command (console.warn). Reports every effective-binding collision once
  // per pair; hand-edited storage can smuggle conflicts past bind()'s guard.
  const warnOnConflicts = () => {
    const warned = new Set();
    for (const [command] of registry) {
      const keys = effectiveKeys(command);
      const conflict = keys && findConflict(command, keys);
      if (!conflict) continue;
      const pair = [command, conflict].sort().join(" / ");
      if (warned.has(pair)) continue;
      warned.add(pair);
      console.warn(
        `keybindings: "${command}" and "${conflict}" are both bound to ` +
        `${comboToDisplayString(keys)} (first registered wins at dispatch)`,
      );
    }
  };

  for (const [command] of registry) {
    const conflict = findConflict(command, registry.get(command).keys);
    if (conflict) {
      throw new Error(
        `Conflicting default bindings: "${command}" and "${conflict}" share ` +
        `${comboToDisplayString(registry.get(command).keys)} in overlapping contexts`,
      );
    }
  }

  return {
    /**
     * Command. Overrides a command's binding.
     *
     * Returns the CONFLICTING command id when `keys` collides with another
     * command's effective binding, else null. Without `force` a conflict
     * blocks the rebind (nothing changes); with `force` the conflicting
     * command is unbound (recorded as an override) and the rebind applies —
     * the return value then reports what got clobbered. Unknown command or
     * malformed combo throws.
     *
     * @example kb.bind("put-on-top", ["cmd", "k"]) // null — rebound
     * @example kb.bind("put-on-top", ["Ctrl", "Z"]) // "undo" — blocked, undo keeps Ctrl+Z
     * @example kb.bind("put-on-top", ["Ctrl", "Z"], { force: true }) // "undo" — undo now unbound
     */
    bind(command, keys, { force = false } = {}) {
      requireKnown(command);
      const combo = normalizeCombo(keys);
      const conflict = findConflict(command, combo);
      if (conflict && !force) return conflict;
      if (conflict) overrides.set(conflict, null);
      if (comboEquals(combo, registry.get(command).keys)) overrides.delete(command); // == default: no override needed
      else overrides.set(command, combo);
      return conflict;
    },
    /** Command. Unbinds a command (an explicit override, so it persists). */
    unbind(command) {
      requireKnown(command);
      overrides.set(command, null);
    },
    /** Command. Drops a command's override, restoring its default. Warns if
     * the restored default now collides with another override. */
    reset(command) {
      requireKnown(command);
      overrides.delete(command);
      warnOnConflicts();
    },
    /** Command. Drops ALL overrides — every command back to its default. */
    resetAll() {
      overrides.clear();
    },
    /** Query. Effective combo for a command (["Cmd","Shift","F"]), or null if
     * unbound. Unknown command throws. */
    bindingFor(command) {
      requireKnown(command);
      const keys = effectiveKeys(command);
      return keys ? [...keys] : null;
    },
    /** Query. Every command's effective binding (defaults merged with
     * overrides), in default-declaration order:
     * [{command, keys|null, when?, overridden}]. */
    allBindings() {
      return [...registry.entries()].map(([command, spec]) => {
        const keys = effectiveKeys(command);
        return { command, keys: keys ? [...keys] : null, when: spec.when, overridden: overrides.has(command) };
      });
    },
    /**
     * Query. ONLY the overrides (never defaults) as a JSON-safe plain object:
     * {command: keys | null}, null meaning explicitly unbound. Caller stores
     * it (intended: localStorage "powerrp.keybindings", see module docs).
     *
     * @example kb.serializeOverrides() // { "put-on-top": ["Cmd", "K"], "undo": null }
     */
    serializeOverrides() {
      return Object.fromEntries([...overrides.entries()].map(([c, k]) => [c, k ? [...k] : null]));
    },
    /**
     * Command. REPLACES all current overrides with serializeOverrides()-shaped
     * data (a parsed plain object, not a JSON string). Validation: unknown
     * commands are console.warn'd and skipped (stale storage after a command
     * is renamed must not brick startup); malformed combos throw, applying
     * NOTHING (all-or-nothing). Conflicts smuggled in by hand-edited storage
     * are console.warn'd (dispatch first-match shadows; it does not crash).
     */
    loadOverrides(overridesJson) {
      if (typeof overridesJson !== "object" || overridesJson === null || Array.isArray(overridesJson))
        throw new Error(`loadOverrides expects a plain {command: keys|null} object, got: ${JSON.stringify(overridesJson)}`);
      const incoming = new Map();
      for (const [command, keys] of Object.entries(overridesJson)) {
        if (!registry.has(command)) {
          console.warn(`keybindings: skipping override for unknown command "${command}"`);
          continue;
        }
        incoming.set(command, keys === null ? null : normalizeCombo(keys));
      }
      overrides.clear();
      for (const [command, keys] of incoming) overrides.set(command, keys);
      warnOnConflicts();
    },
    /**
     * Query. THE bridge to core/shortcuts.js: every effectively-BOUND command
     * as a shortcut-registry entry {keys, label, when, command}, ready for
     * shortcuts.add() (see module docs for the full App.svelte snippet).
     *
     * Args:
     *   labelsById: {command: "HintBar label"} — missing label throws
     *     (shortcuts.add requires one; App.svelte can derive these from
     *     command titles)
     *   whenResolvers: {whenName: (ctx) => bool} — a binding naming a missing
     *     resolver throws; bindings with no `when` get () => true
     */
    toShortcutEntries(labelsById, whenResolvers = {}) {
      const entries = [];
      for (const [command, spec] of registry) {
        const keys = effectiveKeys(command);
        if (!keys) continue;
        const label = labelsById[command];
        if (!label) throw new Error(`toShortcutEntries: no label for command "${command}"`);
        let when = () => true;
        if (spec.when) {
          when = whenResolvers[spec.when];
          if (!when) throw new Error(`toShortcutEntries: no when-resolver named "${spec.when}" (needed by "${command}")`);
        }
        entries.push({ keys: [...keys], label, when, command });
      }
      return entries;
    },
  };
}

/**
 * Pure function. Normalizes a key combo to canonical form: modifiers in
 * Cmd, Ctrl, Alt, Shift order, then EXACTLY ONE main key last (the order
 * core/shortcuts.js dispatch expects). Modifier aliases (meta/command,
 * control, option/opt) are canonicalized; single-letter main keys are
 * uppercased; longer main keys get their first letter uppercased ("escape" →
 * "Escape", "F5" stays "F5"). Throws on empty/non-array combos, non-string
 * tokens, duplicate modifiers, and zero or 2+ main keys.
 *
 * @example normalizeCombo(["shift", "cmd", "f"]) // ["Cmd", "Shift", "F"]
 * @example normalizeCombo(["option", "escape"]) // ["Alt", "Escape"]
 * @example normalizeCombo(["meta", "z"]) // ["Cmd", "Z"]
 */
export function normalizeCombo(keys) {
  if (!Array.isArray(keys) || keys.length === 0)
    throw new Error(`Key combo must be a non-empty array of key tokens, got: ${JSON.stringify(keys)}`);
  const mods = [];
  const mains = [];
  for (const raw of keys) {
    if (typeof raw !== "string" || !raw.trim())
      throw new Error(`Key token must be a non-empty string, got ${JSON.stringify(raw)} in ${JSON.stringify(keys)}`);
    const token = raw.trim();
    const mod = MODIFIER_ALIASES[token.toLowerCase()];
    if (mod) {
      if (mods.includes(mod)) throw new Error(`Duplicate modifier "${mod}" in ${JSON.stringify(keys)}`);
      mods.push(mod);
    } else {
      mains.push(token);
    }
  }
  if (mains.length !== 1)
    throw new Error(`Key combo needs exactly one non-modifier key, got ${mains.length} in ${JSON.stringify(keys)}`);
  const main = mains[0].length === 1 ? mains[0].toUpperCase() : mains[0][0].toUpperCase() + mains[0].slice(1);
  return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), main];
}

/**
 * Pure function. True when two combos normalize to the same keys (order-,
 * alias-, and case-insensitive). Throws if either combo is malformed.
 *
 * @example comboEquals(["Shift", "Cmd", "F"], ["cmd", "shift", "f"]) // true
 * @example comboEquals(["Ctrl", "Z"], ["Ctrl", "Shift", "Z"]) // false
 */
export function comboEquals(a, b) {
  const na = normalizeCombo(a);
  const nb = normalizeCombo(b);
  return na.length === nb.length && na.every((k, i) => k.toLowerCase() === nb[i].toLowerCase());
}

/**
 * Pure function. Human-readable string for a combo (normalized first).
 *
 * @example comboToDisplayString(["shift", "cmd", "f"]) // "Cmd+Shift+F"
 * @example comboToDisplayString(["Backspace"]) // "Backspace"
 */
export function comboToDisplayString(keys) {
  return normalizeCombo(keys).join("+");
}

/**
 * Pure function. Whether two `when` context names can be active at once:
 * same name, or either side unscoped (no `when` = always active). Different
 * NAMES are assumed disjoint (e.g. "editMode" vs "presentMode") — the
 * registry cannot evaluate predicates, only compare their names.
 *
 * @example whensOverlap("editMode", "editMode") // true
 * @example whensOverlap("editMode", undefined) // true — unscoped overlaps everything
 * @example whensOverlap("editMode", "presentMode") // false
 */
export function whensOverlap(a, b) {
  return a === b || !a || !b;
}
