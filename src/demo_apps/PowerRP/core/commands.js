/**
 * Command registry + fuzzy matching — the command palette's backend.
 * Commands come from core AND from plugins (each plugin may contribute;
 * the palette is how "everything routes through the plugin system" surfaces
 * in the UI).
 *
 * Entry: {id, title, run?(app), when?(app) → bool, children?: [entry],
 *         icon?, preview?(app) → revert, requires?: string, help?: string}.
 * A command has `run` XOR `children`: children make it a SUBMENU the palette
 * drills into (e.g. "Color Theme →" listing themes). Child ids must still be
 * globally unique (they're registered flat for `get()`/shortcut reuse).
 *
 * ── AVAILABILITY: `when` GREYS OUT, IT DOES NOT HIDE ────────────────────────
 * `when(app)` is the AVAILABILITY axis — transient, per-app-state ("nothing is
 * selected right now"). core/registry.js's TOOL GROUPS block names the two axes
 * and rules on both: APPLICABILITY (structural, per-widget) removes an
 * affordance so it cannot be reached, AVAILABILITY renders it DISABLED, never
 * hidden, because hiding it makes the command unlearnable — you cannot discover
 * "Purge needs a selection" from a palette that omits Purge. web/Toolbar.svelte
 * and web/ToolsPane.svelte already surface `when` that way; `search()` used to
 * be the one surfacing that dropped the entry instead, which is why a user could
 * not find a command that plainly exists (user ruling: "it could be grayed out
 * for now, and even just that some tooltip tells us why it's grayed out").
 * So `search()` returns unavailable entries and every surfacing marks them.
 *
 * `requires` is the sentence completing "Unavailable — requires …" — the reason
 * a surfacing shows while the gate says no. MANDATORY beside a `when` (a grey
 * control that will not say why is the defect this rule removes; the palette
 * probe's registry sweep fails on a `when` with no `requires`). It is the
 * ENTRY's field, so every surfacing gets the same sentence for free.
 *
 * OPTIONAL `help`: one plain sentence of hover help — what the command does to
 * the document and WHY you would reach for it, for commands whose title does not
 * already carry the consequence (Purge vs Delete; Flip vs Mirror). Never a
 * restatement of the title, and absent on the obvious ones: the palette's help
 * section is ABSENT, not empty, when the highlighted entry declares none. A
 * PLAIN STRING deliberately — richer help (markup, a picture) is a later
 * discriminated shape (e.g. {text, image}) that readers can switch on; nothing
 * downstream may assume string-ness beyond rendering it as text.
 *
 * OPTIONAL `preview(app) -> revert` (GENERAL previewable-command protocol,
 * driven in CommandPalette.svelte): a temporary, non-committing application of
 * the command's effect, returning a closure that undoes it. The palette calls
 * it while the entry is hovered/arrow-focused and calls the returned revert
 * when focus moves off or the palette closes without selecting; selecting the
 * entry keeps the change and runs `run`. Purely additive — the registry treats
 * it as opaque metadata (only the palette reads it).
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
     *
     * THE THREE FILTERS AND THE ORDER THEY COMPOSE IN. They are different
     * questions and each answers exactly one; writing the order down because the
     * gray-out change moved one of them out of this function and a later reader
     * would otherwise be free to fold it back in:
     *   1. POOL SCOPING (here, first and absolute). `parent` chooses the
     *      candidate set: a submenu search sees THAT submenu's children and
     *      nothing else, ever. No later filter may widen it.
     *   2. QUERY RANKING (here, second). Fuzzy score drops non-matches and orders
     *      the rest; an empty query orders by MRU instead. This is the only
     *      filter that removes an entry from the returned list.
     *   3. AVAILABILITY (NOT here — at each surfacing, per row). `when` decides
     *      whether a row is GREYED, never whether it is present. It is applied
     *      last, to something already scoped and ranked, and it cannot change
     *      what is in the list or what order it is in.
     * Rank is deliberately not re-sorted by availability either: a row that moved
     * when the selection changed would break the muscle memory the MRU order
     * exists to build, and the query is the real filter. Ranking therefore needs
     * no `app` at all — the parameter that used to carry it here is gone.
     */
    search(query, parent = null) {
      const pool = parent ? parent.children : topLevel;
      if (!query)
        return [...pool].sort((a, b) => (used.get(b.id) ?? -1) - (used.get(a.id) ?? -1));
      // rp's ranking: LOWER score = better match.
      return pool
        .map((c) => ({ c, score: rpFuzzyScore(query, c.title) }))
        .filter((x) => x.score !== null)
        .sort((a, b) => a.score - b.score)
        .map((x) => x.c);
    },
    /**
     * Query. EVERY registered entry, submenu children included, in registration
     * order. The sweep seam: a guard over "every command explains itself" must
     * read the registry rather than re-list the ids it expects to find, which is
     * the mirrored-shape defect this project keeps rediscovering.
     */
    all() {
      return [...commands.values()];
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

/**
 * Query (reads app state through the entry's own gate). Is `cmd` UNAVAILABLE
 * right now — i.e. does it declare a `when` that says no? THE one expression for
 * the availability axis: web/Toolbar.svelte, web/ToolsPane.svelte and
 * web/CommandPalette.svelte each used to spell it out, and a surfacing that
 * spells its own gate is free to disagree with the others about what "disabled"
 * means.
 *
 * SEPARATE FROM THE REASON, deliberately (the Tools pane's rule): whether a
 * control is disabled must not depend on whether anyone wrote prose for it, or a
 * gated command with no sentence would render ENABLED and no-op on click.
 *
 * @param {object} cmd - a command-registry entry
 * @param {object} app - the app instance the gate is evaluated against
 * @returns {boolean}
 *
 * @example commandUnavailable({id: "undo", title: "Undo", run: () => {}}, app) // false (no gate)
 * @example commandUnavailable({id: "copy-item", when: (a) => a.selectedIds().length > 0}, app) // true with an empty selection
 */
export function commandUnavailable(cmd, app) {
  return !!cmd.when && !cmd.when(app);
}

/**
 * Query. WHY `cmd` cannot run right now — the clause completing "Unavailable —
 * requires …" — or null when it CAN run (or when the entry declares no reason).
 * Null on a runnable command is what makes the sentence read as the live reason
 * rather than a standing caveat.
 *
 * @param {object} cmd - a command-registry entry
 * @param {object} app - the app instance the gate is evaluated against
 * @returns {string|null}
 *
 * @example commandUnavailableReason({id: "u", requires: "a selection"}, app) // null (ungated: it can run)
 * @example commandUnavailableReason({id: "c", when: () => false, requires: "a selection"}, app) // "a selection"
 */
export function commandUnavailableReason(cmd, app) {
  return commandUnavailable(cmd, app) ? (cmd.requires ?? null) : null;
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

