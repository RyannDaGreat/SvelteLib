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
     *   3. AVAILABILITY (NOT here — at each surfacing, via
     *      partitionByAvailability below). `when` decides whether a row is
     *      GREYED and, since the user's ordering ruling, WHERE it sits: a
     *      surfacing that renders a list partitions the ranked result into
     *      available-then-unavailable. It is applied last, to something already
     *      scoped and ranked. It may NOT change membership and may NOT widen the
     *      pool — the partition is a permutation of what this function returned,
     *      nothing enters or leaves — but it DOES outrank ranking, at exactly one
     *      coarse level. Inside each partition the order below is untouched.
     * So this function is availability-blind by construction and needs no `app`
     * — the parameter that used to carry one is gone, and putting the partition
     * here would hand it back AND silently reorder for callers that only want the
     * ranking (a membership check, a "does the fuzzy query hit this" probe).
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

/**
 * Query. Splits already-ranked `entries` into the ones that can run now and the
 * ones that cannot, each keeping its incoming relative order. A surfacing that
 * renders a LIST concatenates them (available first) — user ruling: "you can
 * always put ones we can't select on the bottom. Ones that we can select are
 * always going to get priority and be sorted above ones that are not. It's a
 * stable sort."
 *
 * A PARTITION, NOT A SORT. Two buckets filled in one forward pass: stability is
 * then a property of the code's shape (push preserves order, full stop) rather
 * than a guarantee to look up in the spec about how `sort` treats a comparator
 * that returns 0. It also cannot accidentally re-rank within a bucket, which a
 * comparator can if someone later "improves" it.
 *
 * BOTH HALVES ARE RETURNED, not just the concatenation, because the caller needs
 * both facts — the order AND which rows to grey — and `when` is not free
 * (needsMultiBbox derives the render tree). One pass answers both; returning only
 * an ordered list would make every caller ask each gate a second time.
 *
 * It is a PERMUTATION of its input: available.length + unavailable.length always
 * equals entries.length. That is what keeps pool scoping absolute — this runs on
 * what search() returned, so a submenu's list cannot gain a foreign entry here.
 *
 * @param {object[]} entries - command entries, already pool-scoped and ranked
 * @param {object} app - the app instance the gates are evaluated against
 * @returns {{available: object[], unavailable: object[]}}
 *
 * @example
 *   >>> # gates: a and c runnable, b and d not
 *   >>> partitionByAvailability([a, b, c, d], app)
 *   {available: [a, c], unavailable: [b, d]}   // "a, c, b, d" once concatenated
 * @example
 *   >>> # nothing gated at all — the ranking passes through untouched
 *   >>> partitionByAvailability([a, b], app)
 *   {available: [a, b], unavailable: []}
 */
export function partitionByAvailability(entries, app) {
  const available = [];
  const unavailable = [];
  for (const cmd of entries) (commandUnavailable(cmd, app) ? unavailable : available).push(cmd);
  return { available, unavailable };
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

