/**
 * Command registry + fuzzy matching — the command palette's backend.
 * Commands come from core AND from plugins (each plugin may contribute;
 * the palette is how "everything routes through the plugin system" surfaces
 * in the UI).
 *
 * Entry: {id, title, run?(app), when?(app) → bool, children?: [entry]}.
 * A command has `run` XOR `children`: children make it a SUBMENU the palette
 * drills into (e.g. "Color Theme →" listing themes). Child ids must still be
 * globally unique (they're registered flat for `get()`/shortcut reuse).
 */

import { rpFuzzyScore } from "./fuzzy.js";

export function createCommands() {
  const commands = new Map(); // flat: every id (incl. children) → entry
  const topLevel = [];
  const used = new Map(); // id → monotonic use stamp (MRU ordering)
  let useCounter = 0;
  return {
    /** Command. Registers a palette command (and its children); loud on problems. */
    add(cmd) {
      registerFlat(commands, cmd);
      topLevel.push(cmd);
    },
    /**
     * Query. Entries under `parent` (null = top level) ranked against `query`.
     * Empty query → most-recently-used first (unused keep registration order);
     * with a query → fuzzy rank.
     */
    search(query, app, parent = null) {
      const pool = parent ? parent.children : topLevel;
      const available = pool.filter((c) => !c.when || c.when(app));
      if (!query)
        return [...available].sort((a, b) => (used.get(b.id) ?? -1) - (used.get(a.id) ?? -1));
      // rp's ranking: LOWER score = better match.
      return available
        .map((c) => ({ c, score: rpFuzzyScore(query, c.title) }))
        .filter((x) => x.score !== null)
        .sort((a, b) => a.score - b.score)
        .map((x) => x.c);
    },
    /** Command. Stamps a command as just-used (drives MRU ordering). */
    markUsed(id) {
      used.set(id, useCounter++);
    },
    /**
     * Query. The top-level submenu entry owning `id`, or null when `id` is
     * itself top-level (or unknown). Lets a child run surface its PARENT in the
     * top-level MRU — children aren't top-level entries, so they can never
     * appear there, but the submenu they live under can.
     */
    parentOf(id) {
      return topLevel.find((c) => c.children?.some((ch) => ch.id === id)) ?? null;
    },
    /** Query. MRU state for persistence: ids, most recent LAST. */
    usageList() {
      return [...used.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    },
    /** Command. Restores MRU state from usageList() output. */
    loadUsage(ids) {
      for (const id of ids) if (commands.has(id)) used.set(id, useCounter++);
    },
    /** Query. Command by id, including submenu children (loud when missing). */
    get(id) {
      const c = commands.get(id);
      if (!c) throw new Error(`Unknown command "${id}"`);
      return c;
    },
  };
}

/** Command (mutates map). Validates and registers an entry + descendants. */
function registerFlat(map, cmd) {
  const isSubmenu = Array.isArray(cmd.children);
  if (!cmd.id || !cmd.title || (isSubmenu ? cmd.run : !cmd.run))
    throw new Error(`Malformed command (need id, title, and run XOR children): ${JSON.stringify(cmd).slice(0, 120)}`);
  if (map.has(cmd.id)) throw new Error(`Duplicate command id "${cmd.id}"`);
  map.set(cmd.id, cmd);
  for (const child of cmd.children ?? []) registerFlat(map, child);
}

