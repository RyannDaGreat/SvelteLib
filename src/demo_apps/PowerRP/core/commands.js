/**
 * Command registry + fuzzy matching — the command palette's backend.
 * Commands come from core AND from plugins (each plugin may contribute;
 * the palette is how "everything routes through the plugin system" surfaces
 * in the UI).
 *
 * Entry: {id, title, run?(app), when?(app) → bool, children?: [entry],
 *         icon?, preview?(app) → revert, requires?: string, help?: string,
 *         aliases?: string[]}.
 * A command has `run` XOR `children`: children make it a SUBMENU the palette
 * drills into (e.g. "Color Theme →" listing themes). Child ids must still be
 * globally unique (they're registered flat for `get()`/shortcut reuse).
 * `aliases` are extra SEARCHABLE names — the synonyms a user actually types
 * that a short title cannot carry ("Duplicate" was unfindable under
 * "duplicate object" or "clone": a fuzzy subsequence match needs the query's
 * letters to exist in the target). search() ranks each entry by its best
 * match across title + aliases; aliases are never displayed.
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
 * **`when` MUST BE O(CHEAP). IT RUNS ON A HOT PATH, ONCE PER ENTRY, EVERY TIME
 * ANY SURFACING IS DRAWN OR RE-RANKED** — the palette on every keystroke, the
 * toolbar and the tool pane on every app-state change. There is no memo and no
 * debounce, deliberately: a cached availability is a control that lies for a
 * frame, which is the defect the greying rule exists to remove.
 *
 * So a gate may read app state, compare a couple of fields, and check a
 * selection's length. It may NOT walk the document, fold slides, evaluate
 * equations, touch the filesystem or the network, or allocate per call. Where a
 * gate genuinely needs derived data the cost is already paid elsewhere and must
 * be READ, not recomputed — `needsMultiBbox` derives the render tree, which is
 * exactly why `partitionByAvailability` (below) returns BOTH halves from one
 * pass rather than letting each caller ask every gate a second time.
 *
 * This is stated HERE, at the definition, and not only at that call site,
 * because the author of a new command reads this block and never reads
 * `partitionByAvailability` — a performance contract recorded only at the
 * consumer is a contract the producer never sees.
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
      // ── A TOP-LEVEL QUERY REACHES INTO SUBMENUS. A DRILLED-IN ONE DOES NOT. ──
      // The pool used to be `topLevel` flat, always, and the note above called that
      // "first and absolute". It is still absolute for a DRILLED-IN search — that is the
      // half the rule was written for, and scoping there is what makes a submenu a
      // submenu. But at top level it made every child UNFINDABLE BY NAME, and R7-18 moved
      // a lot behind submenus: measured, `search("pendulum")` returned NOTHING, and so did
      // "shimmer" and "incanta", so all 27 demo audio patches and all 3 presets could only
      // be reached by knowing which menu they lived in first. The user reported exactly
      // that — "I don't see the pendulum widget in the command palette."
      //
      // A palette whose whole promise is "type the name of the thing" cannot answer
      // "nothing" for a command it has registered. So: WITH A QUERY and no parent, one
      // level of children joins the pool and is ranked beside its parents.
      //
      // AN EMPTY top-level query is UNCHANGED and deliberately so — it opens onto the
      // top-level MRU. Flattening there would greet the author with thirty demo entries
      // in front of the commands they actually use, which is the opposite of a fix.
      const pool = parent ? parent.children : query ? [...topLevel, ...topLevel.flatMap((c) => c.children ?? [])] : topLevel;
      if (!query)
        return [...pool].sort((a, b) => (used.get(b.id) ?? -1) - (used.get(a.id) ?? -1));
      // rp's ranking: LOWER score = better match (title OR any alias).
      return pool
        .map((c) => ({ c, score: entryScore(query, c) }))
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
 * A TOOL'S DECLARED PLURAL SCOPE — what running it over a MULTI-SELECTION means.
 *
 * USER, 2026-08-06 (verbatim): *"Tools have the option to specify what happens or
 * if they're allowed to be done in a plural selection - copy tool already does
 * this so it might not be so bad."*
 *
 * ── THERE ARE THREE OUTCOMES AND ONLY TWO LIVE HERE ──────────────────────────
 * "APPLIES TO EACH" and "ACTS ON THE SELECTION AS A WHOLE" are below. The third —
 * REFUSED IN A PLURAL SELECTION — is NOT a value here, because the AVAILABILITY
 * axis already expresses it and three shipped commands already use it that way:
 *   - `shatterBlocker` (web/app.svelte.js): "one widget selected, not several —
 *     shatter makes one group at a time";
 *   - `pin-light-to-object`'s gate returns null unless exactly one item is
 *     selected, and LIGHT_PIN_REQUIRES says "a multi-selection has no single
 *     widget to pin from";
 *   - `distribute-h`/`distribute-v` gate on `selectedIds().length >= 3`.
 * Each renders DISABLED with its sentence through commandUnavailableReason, which
 * is exactly what the user asked "if they're allowed" to produce. A third enum
 * value would be a SECOND way to say a thing the app already says — the Tower of
 * Babel the manifest names — and worse, a value nothing could enforce agreement
 * with, so an entry could declare "refuse" while its gate said yes.
 *
 * ── OPTIONAL, ON `help`'s PRECEDENT ─────────────────────────────────────────
 * Undeclared claims NOTHING and renders nothing, exactly as an absent `help`
 * contributes no line ("absent on the obvious ones", above). The alternative —
 * mandatory on every tool — sounds stricter but is not, because the value cannot
 * be derived from anything the registry can read: it is a fact about what `run`
 * does, so a mandate would be satisfied by GUESSING, and a guessed sentence in a
 * tooltip is a confident lie where silence is merely quiet. So a value is
 * declared where somebody has READ the run, and nowhere else.
 *
 * A DECLARED value must be one of these two — `registerFlat` throws otherwise, so
 * a typo cannot ship as a silently-absent claim.
 *
 * @example PLURAL_SCOPE.EACH // "each"
 * @example Object.keys(PLURAL_SCOPE) // ["EACH", "TOGETHER"]
 */
export const PLURAL_SCOPE = { EACH: "each", TOGETHER: "together" };

/**
 * The sentence each scope shows, written ONCE — the `unavailableMessage` shape:
 * one home for one speech act, so no surfacing can grow its own wording.
 *
 * Both are phrased as a promise about the CLICK rather than about the tool, because
 * that is the question a plural selection raises: "will this hit all five?".
 */
export const PLURAL_SCOPE_NOTES = {
  [PLURAL_SCOPE.EACH]: "Applies to EVERY selected widget, independently — one undo unit.",
  [PLURAL_SCOPE.TOGETHER]: "Acts on the selection AS A WHOLE, not on each widget separately.",
};

/**
 * Pure function. The sentence to show for a command under a PLURAL selection, or
 * null when it declares no plural scope (and so has nothing to promise).
 *
 * Null rather than a stand-in sentence: a surfacing renders nothing for an
 * undeclared tool, the way the palette's help section is ABSENT rather than empty.
 *
 * @param {object} cmd - a command-registry entry
 * @returns {string|null}
 *
 * @example pluralScopeNote({id: "duplicate", plural: PLURAL_SCOPE.EACH})
 * 'Applies to EVERY selected widget, independently — one undo unit.'
 * @example pluralScopeNote({id: "align-left", plural: PLURAL_SCOPE.TOGETHER}).startsWith("Acts on the selection") // true
 * @example pluralScopeNote({id: "undo"}) // null (nothing declared, nothing claimed)
 */
export function pluralScopeNote(cmd) {
  return PLURAL_SCOPE_NOTES[cmd?.plural] ?? null;
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
 * `requires` MAY BE A FUNCTION of the app, not only a string. Most gates have one
 * reason and a literal says it best. But a gate with SEVERAL disqualifying
 * conditions has several true sentences, and a fixed string would have to pick
 * one and be wrong the rest of the time — which is worse than silence, because it
 * is a confident wrong answer. `save-project` is the case that forced this: it is
 * unavailable on an unsaved draft ("use Save As…"), on a clean working copy
 * ("nothing to save") and mid-flight ("wait"), and telling a user with unsaved
 * work that there is nothing to save would be a lie the UI states out loud.
 * The function is called ONLY when the gate already said no, so it never has to
 * answer for a runnable command.
 *
 * @param {object} cmd - a command-registry entry
 * @param {object} app - the app instance the gate is evaluated against
 * @returns {string|null}
 *
 * @example commandUnavailableReason({id: "u", requires: "a selection"}, app) // null (ungated: it can run)
 * @example commandUnavailableReason({id: "c", when: () => false, requires: "a selection"}, app) // "a selection"
 * @example // a multi-reason gate states the LIVE reason:
 * commandUnavailableReason({id: "s", when: () => false, requires: (a) => a.blocker}, {blocker: "changes to save"}) // "changes to save"
 */
export function commandUnavailableReason(cmd, app) {
  if (!commandUnavailable(cmd, app)) return null;
  return (typeof cmd.requires === "function" ? cmd.requires(app) : cmd.requires) ?? null;
}

/**
 * Pure function. THE refusal sentence a surfacing shows for a gated command —
 * the `requires` clause with its frame attached, and the ONLY place that frame
 * is spelled.
 *
 * WHY THIS EXISTS (W3-C, round 6; CLAUDE-ORIGINATED, not a user request). The
 * clause corpus was already perfect — MEASURED: 61 `requires` declarations, ~35
 * distinct sentences, every one a lowercase noun phrase with no terminal period,
 * i.e. all of them correctly complete "Unavailable — requires …". The DRIFT was
 * entirely in the frame, which four panes had each transcribed by hand
 * (web/Toolbar.svelte, web/ToolsPane.svelte, web/CommandPalette.svelte,
 * web/Inspector.svelte) while two more had grown different frames for the same
 * speech act. Four hand-copies of one sentence is four chances to disagree, and
 * web/app.css:5463's claim that this is "one sentence style" was FALSE while they
 * were separate — a comment asserting a uniformity that does not exist is worse
 * than no comment, because it tells the next reader not to check.
 *
 * The shape is `offlineMessage()`'s (web/connectivity.js:248): one exported
 * function, one condition, one sentence, pinned by a test so the app cannot grow
 * a second wording. That precedent is named in the round's own doctrine
 * (tests/connectivity_seam_test.js §3).
 *
 * THROWS on an empty reason rather than emitting "Unavailable — requires ." —
 * `offlineMessage` throws on a headless sentence for the same reason, and the
 * registry already treats a `when` without a `requires` as a defect the palette
 * probe fails on. A caller with no reason must render nothing, not a stub.
 *
 * @param {string} reason - the clause completing the frame (a lowercase noun phrase)
 * @returns {string}
 *
 * @example unavailableMessage("a selection")
 * 'Unavailable — requires a selection'
 * @example unavailableMessage("changes to save")
 * 'Unavailable — requires changes to save'
 * @example // composes with the resolved reason, never the raw field:
 * // unavailableMessage(commandUnavailableReason(cmd, app))
 */
export function unavailableMessage(reason) {
  const clause = String(reason ?? "").trim();
  if (!clause) throw new Error("unavailableMessage: needs a reason clause");
  return `Unavailable — requires ${clause}`;
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
  if (cmd.aliases !== undefined && (!Array.isArray(cmd.aliases) || cmd.aliases.some((a) => typeof a !== "string" || !a)))
    throw new Error(`Command "${cmd.id}": aliases must be an array of non-empty strings, got ${JSON.stringify(cmd.aliases)} — a malformed alias would silently never match.`);
  // A DECLARED plural scope must be a KNOWN one. Absent is legal (it claims
  // nothing); a typo must not be, because it would read as absent and the tool
  // would silently stop saying what a click does to five widgets.
  if (cmd.plural !== undefined && !Object.values(PLURAL_SCOPE).includes(cmd.plural))
    throw new Error(`Command "${cmd.id}": plural must be one of ${JSON.stringify(Object.values(PLURAL_SCOPE))}, got ${JSON.stringify(cmd.plural)} — a plural REFUSAL is declared through \`when\`/\`requires\`, not here (see PLURAL_SCOPE).`);
  if (map.has(cmd.id)) throw new Error(`Duplicate command id "${cmd.id}"`);
  map.set(cmd.id, cmd);
  for (const child of cmd.children ?? []) registerFlat(map, child);
}

/**
 * The bonus subtracted when a name IS the query rather than merely starting with
 * it. A tie-break and nothing more, and its SIZE is measured rather than picked.
 *
 * It must clear TWO thresholds. The floor it has to beat is rpFuzzyScore's best
 * prefix score, 0.000001. The subtler one is the CASE PENALTY: a title matched
 * case-insensitively costs +0.0001 per differing char before the /1000, so
 * `rpFuzzyScore("duplicate", "Duplicate")` is 0.0000011, not 0.000001. A bonus
 * smaller than that difference leaves an exact-but-capitalised TITLE tied with
 * the command's OWN lowercase alias ("duplicate object", 0.000001) — measured,
 * and the reason a first attempt at 1e-7 changed nothing for "duplicate".
 *
 * 1e-5 clears both with room, and cannot reach further: the next score band up
 * is a non-prefix match, whose scores start at 0.1 (a word-boundary skip) —
 * four orders of magnitude away. So this reorders EXACT-vs-PREFIX pairs and
 * provably nothing else.
 */
const EXACT_NAME_BONUS = 0.00001;

/**
 * Pure function. An entry's best (lowest) fuzzy score for `query`, across its
 * TITLE and its search `aliases` — or null when none of them match. This is
 * what lets "duplicate object" or "clone" find the command titled "Duplicate":
 * a fuzzy subsequence match needs the query's letters to EXIST in the target,
 * and a one-word title cannot carry its synonyms.
 *
 * AN EXACT NAME BEATS A MERE PREFIX, and this tie-break is why the function is
 * not just `Math.min` over rpFuzzyScore. MEASURED (2026-08-02): rpFuzzyScore
 * FLOORS every prefix match at the same 0.000001 — `rpFuzzyScore("delete",
 * "delete")` and `rpFuzzyScore("delete", "delete slides")` are the identical
 * number — because the prefix branch divides by 1000 and there is no term for
 * how much of the candidate the query covered. So typing the whole of one
 * command's name tied with a DIFFERENT command that happens to start with it,
 * and the tie fell through to REGISTRATION ORDER, which is an implementation
 * detail no user can see. Concretely: "duplicate" and "delete" both resolved to
 * the SLIDE commands (registered ~500 lines earlier in web/App.svelte) instead
 * of the widget Duplicate/Delete the user named in the ruling that
 * tests/tool_surfacing_probe.js exists to enforce.
 *
 * FIXED HERE AND NOT IN core/fuzzy.js, deliberately. That module is rp's
 * completion ranker, shared verbatim by the palette, the Asset Explorer, the
 * File Browser, equation autocomplete and the iconify search (web/searchRank.js
 * documents the one-ranking rule). Teaching it a new term would silently
 * reorder all five for a defect that is about COMMANDS having both a title and
 * aliases. This function is already the command-specific blend of those names,
 * so the command-specific tie-break belongs in it.
 *
 * @param {string} query - the palette's search text
 * @param {{title: string, aliases?: string[]}} entry - a registered command
 * @returns {number|null} rp's score (lower = better), null = no match anywhere
 *
 * @example entryScore("clone", {title: "Duplicate"}) // null
 * @example typeof entryScore("clone", {title: "Duplicate", aliases: ["clone", "duplicate object"]}) // "number"
 * @example typeof entryScore("duplicate object", {title: "Duplicate", aliases: ["duplicate object"]}) // "number"
 * @example entryScore("zzz", {title: "Duplicate", aliases: ["clone"]}) // null
 * @example // the whole point: typing a name exactly beats a command that merely starts with it
 * entryScore("delete", {title: "Delete", aliases: []}) < entryScore("delete", {title: "Delete Selected Slides", aliases: ["delete slides"]})
 * // => true
 * @example // and the bonus is a tie-break only — it never lifts a scattered match over a prefix one
 * entryScore("ds", {title: "ds"}) < entryScore("d", {title: "Distribute Spacing"})
 * // => true
 */
export function entryScore(query, entry) {
  const q = query.toLowerCase();
  let best = null;
  for (const name of [entry.title, ...(entry.aliases ?? [])]) {
    const raw = rpFuzzyScore(query, name);
    if (raw === null) continue;
    const score = name.toLowerCase() === q ? raw - EXACT_NAME_BONUS : raw;
    if (best === null || score < best) best = score;
  }
  return best;
}

