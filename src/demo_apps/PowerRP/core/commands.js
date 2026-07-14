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

export function createCommands() {
  const commands = new Map(); // flat: every id (incl. children) → entry
  const topLevel = [];
  return {
    /** Command. Registers a palette command (and its children); loud on problems. */
    add(cmd) {
      registerFlat(commands, cmd);
      topLevel.push(cmd);
    },
    /** Query. Entries under `parent` (null = top level) ranked against `query`. */
    search(query, app, parent = null) {
      const pool = parent ? parent.children : topLevel;
      const available = pool.filter((c) => !c.when || c.when(app));
      if (!query) return available;
      return available
        .map((c) => ({ c, score: fuzzyScore(query, c.title) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c);
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

/**
 * Pure function. Subsequence fuzzy score of `query` against `text`.
 * 0 = no match. Higher = better: consecutive runs and word-start hits score
 * extra, shorter targets win ties.
 *
 * @example fuzzyScore("dh", "Distribute Horizontally") > 0 // true
 * @example fuzzyScore("dh", "Distribute Horizontally") > fuzzyScore("dh", "Dark theme handler") // true
 * @example fuzzyScore("xyz", "Distribute") // 0
 */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    let found = -1;
    for (let i = ti; i < t.length; i++) if (t[i] === ch) { found = i; break; }
    if (found === -1) return 0;
    const wordStart = found === 0 || t[found - 1] === " ";
    streak = found === ti ? streak + 1 : 1;
    score += 1 + streak + (wordStart ? 3 : 0);
    ti = found + 1;
  }
  return score + 10 / (t.length + 10); // shorter targets edge out longer ones
}
