/**
 * MULTI-SELECTION PROPERTY INTERSECTION — the whole pure half of the
 * heterogeneous multi-select Property Panel. DOM-free pure JS (bare-node
 * testable, like the rest of core/); web/Inspector.svelte is a thin renderer
 * over `multiSelectPanel()` and holds none of the logic below.
 *
 * ── WHAT THE USER ASKED FOR ───────────────────────────────────────────────────
 * "I might select an arrow and a box and a video and try to alter their opacity
 * jointly. If they all have different values, or any of them have different
 * values, we would have to have a slightly different interface, a dot dot dot in
 * the parts that are different. And then when I click them, it would have to
 * unify them all to the same value. … so that if I wanted to make a bunch of
 * things fade in at the same time, I could do that."
 *
 * So: SELECT N ITEMS OF DIFFERENT TYPES → the panel shows the INTERSECTION of
 * their editable properties → a property whose values differ shows MIXED_MARK →
 * editing it UNIFIES every selected item to the value you set.
 *
 * ── THE ROW-IDENTITY RELATION (the central design question) ───────────────────
 * Two rows are THE SAME ROW iff they agree on every CONTRACT aspect. Same `key`
 * is NOT sufficient and never was: `ambient` is a NUMBER on the metaball widget
 * and a COLOR on skyClouds; `shape` is a 20-option preset select on the shape
 * widget and a 2-option circle/box select on the magnifier; `src` accepts images
 * on `image` and videos on `video`; `cornerRadius` is a LENGTH in canvas units on
 * a rect and a 0..0.5 FRACTION on ss_polygonStar. Unifying any of those pairs
 * writes a value the other item cannot mean.
 *
 * CONTRACT vs PRESENTATIONAL is the partition, and it is not arbitrary:
 *   CONTRACT       — what the control can EXPRESS or STORE. kind, min, max,
 *                    options/optionGroups/optionsFrom, display (the UNIT — a row
 *                    storing radians and one storing degrees would take "45" to
 *                    mean two different angles), paint, assetKinds/assetForm/
 *                    nullable, a list's element/order/orderKey/activeKey/
 *                    minLength, an action row's command, … i.e. EVERYTHING NOT
 *                    NAMED BELOW.
 *   PRESENTATIONAL — how it LOOKS or FEELS: label, help, category, and the
 *                    tactile-only step/scrub/on-off iconography. None of these
 *                    change which values are representable or how one is stored,
 *                    so two rows differing only in these ARE jointly editable.
 *
 * THE DENYLIST POLARITY IS THE LOAD-BEARING PART. PRESENTATIONAL_ROW_ASPECTS
 * names the presentational aspects and treats EVERYTHING ELSE as contract, so a
 * NEW row aspect added to core/properties.js defaults to CONTRACT — i.e. it makes
 * rows compare UNEQUAL, which shows up as a reported conflict rather than as a
 * silent wrong unification. An allowlist of contract aspects would fail the other
 * way: the new aspect would be silently ignored and a joint write would clobber
 * whatever it governed. This is the same "fail loud, never fake it" polarity
 * core/registry.js's effects gate and core/properties.js's label gates use, and
 * it is why this module needs NO hand-maintained list of "properties that are
 * common" — the intersection is DERIVED from the plugins' own declared rows.
 *
 * MEASURED, not assumed (.scratch measurement over all 77 registered plugins):
 * 411 distinct row keys, of which only 29 drift on a CONTRACT aspect — and every
 * one of those 29 is a genuine semantic difference like the four above. Under this
 * relation `arrow + rect + video` — the user's own example — shares 18 rows
 * (opacity, z, stroke, strokeWidth and all 14 effects rows), `rect + circle`
 * shares 26, and `rect + text + image + video` shares 23.
 *
 * WHY BUNDLES ARE THE BACKBONE. Those 14 effects rows are identical ACROSS
 * UNRELATED WIDGET TYPES by construction, not by luck: core/registry.js injects
 * `bundle("effects")` into every eligible plugin, and `bundle()` builds each row
 * from the ONE core/properties.js PROPS entry. So the shared property registry
 * that exists to stop rows drifting is exactly what makes a rich intersection
 * possible, and a widget composing bundles is jointly editable with every other
 * such widget for free — with no line here to add per widget.
 *
 * ── WHICH ITEMS PARTICIPATE ───────────────────────────────────────────────────
 * THE CAMERA DOES. `purgeable: false` marks the mandatory singleton, and core
 * already decides per-operation whether that matters, on the declared property,
 * with a written reason: core/registry.js `effectsInjectable` and `frameBindable`
 * exclude it, `keyframable` INCLUDES it ("a widget qualifies by having state,
 * never by being a particular kind of widget"). An intersection is the
 * `keyframable` case — the camera's rows are real, stored and editable, so
 * excluding it would make "select everything, set X" skip one item in silence,
 * which is the one outcome this module may not produce. Included, it honestly
 * thins the intersection (camera + rect shares x/y/w/h and nothing else, because
 * the camera has no opacity row and takes no effects bundle) — that is the
 * feature working, not a defect.
 *
 * AN ITEM NOT ON THIS SLIDE DOES NOT. An item selected but NOT YET CREATED on the
 * current slide has no folded state, so it has no value to compare and must not be
 * written: keyframing `opacity` onto an item whose `type` this slide never keys
 * would manufacture a typeless-in-fold item. Such items are dropped from BOTH the
 * intersection and the write, and returned in `skipped` so the panel can say so.
 * Never silently.
 *
 * ── VISIBILITY (`active`) IS DELIBERATELY NOT HERE ────────────────────────────
 * `active` is universal, but no plugin declares it in `inspector` (the Inspector
 * renders it inline), so it is not in any intersection — and that agrees with the
 * standing ruling that a SET's visibility is TWO EXPLICIT ACTIONS (Hide All /
 * Show All), always both, because "no toggle that has to guess the set's state".
 * This module does not reopen that; the existing set actions stay exactly as they
 * are. Note the ruling rejects a tri-state ACTION control that must guess what a
 * click means, NOT the REPORTING of a mixed value — the rich-text toolbar already
 * ships a set/unset/indeterminate boolean. A `boolean` PROPERTY row here reports
 * mixed and then unifies, which is the reporting case, not the guessing one.
 *
 * ── NO ROW IS COPIED, ONLY REFERENCED ─────────────────────────────────────────
 * `intersectRows` returns the primary plugin's OWN row objects, by reference. It
 * never rebuilds a row, and it must never start to: this codebase has a named
 * recurring defect — "a hand-maintained copy of another module's shape", six-plus
 * instances, "every instance found this session was found by a test breaking,
 * never by anyone noticing" — and the prescribed cure is exactly this ("a
 * reference cannot drift from itself; a lookup needs a table that can be
 * missing"). tests/multiselect_test.js pins it as a DRIFT GATE with an identity
 * assertion, so a future refactor that starts synthesizing rows fails loudly.
 *
 * ── THIS MODULE AUTHORS A RULING, IT DOES NOT RECOVER ONE ─────────────────────
 * The manifest records the user's own words: "We haven't decided how to handle
 * plurality in properties yet but thats ok". The set-intersection requirement and
 * the tri-state keyframe diamond were specced long ago, but the identity relation,
 * the mixed-value semantics and the unify write below are NEW decisions made here
 * against the surrounding precedent, and are open to ratification.
 */

import { deepEqual, getPath } from "./deltas.js";
import { ROW_KINDS } from "./properties.js";
import { LIST_ROW_KIND } from "./lists.js";

/**
 * What a MIXED value reads as in a field — the user's "a dot dot dot in the parts
 * that are different". A single character (U+2026), not three periods, so it
 * cannot be mistaken for a literal typed value and never widens a field.
 *
 * The manifest's older multi-select spec asks for the differing value to render
 * at "~80% opaque"; that is a TREATMENT of the field and this is its CONTENT, so
 * both are honoured together rather than one superseding the other.
 */
export const MIXED_MARK = "…";

/**
 * The row aspects that are PRESENTATIONAL — the complete denylist the identity
 * relation ignores. Everything not named here is CONTRACT (see the module header
 * for why the polarity must be this way round).
 *
 *   label / help / category — the field's name, its (?) sentence, and which
 *     accordion it files under. A magnifier calls `stroke` "Rim color" and a rect
 *     calls it "Stroke"; it is the same colour slot storing the same paint.
 *   step / scrub — drag granularity and drag sensitivity. They change how a
 *     GESTURE feels, never which values are representable nor how one is stored.
 *   onIcon / offIcon / onText / offText — a boolean toggle's iconography.
 *
 * @example PRESENTATIONAL_ROW_ASPECTS.includes("label") // true
 * @example PRESENTATIONAL_ROW_ASPECTS.includes("min") // false (a bound is a contract)
 * @example PRESENTATIONAL_ROW_ASPECTS.includes("display") // false (a UNIT is a contract)
 */
export const PRESENTATIONAL_ROW_ASPECTS = [
  "label", "help", "category",
  "step", "scrub",
  "onIcon", "offIcon", "onText", "offText",
];

/**
 * Row kinds a joint (N-item) edit can DRIVE, because a control exists that fans
 * one gesture out to N state paths — the equation-aware fields threaded with
 * `paths`, and the kinds that already commit through the row's generic
 * `oncommit(key, kind, value)` seam.
 *
 * @example JOINT_EDITABLE_KINDS.includes("number") // true
 * @example JOINT_EDITABLE_KINDS.includes("list") // false (see JOINT_UNEDITABLE_KINDS)
 */
export const JOINT_EDITABLE_KINDS = ["number", "angle", "color", "boolean", "select", "asset", "text", "action"];

/**
 * Row kinds that INTERSECT correctly but cannot yet be edited jointly, mapped to
 * the reason shown to the user. A row of one of these kinds is still LISTED (it
 * genuinely is shared) and rendered inert with its reason — the
 * "a disabled control explains itself" rule core/registry.js's TOOL_POOL enforces
 * — rather than hidden, which would misreport what the items have in common.
 *
 * @example JOINT_UNEDITABLE_KINDS.list.startsWith("Lists") // true
 */
export const JOINT_UNEDITABLE_KINDS = {
  [LIST_ROW_KIND]: "Lists are edited one item at a time — elements are identified by INDEX, so two lists of different lengths have no shared element to write.",
};

// LOUD IMPORT-TIME GATE (the core/registry.js effects-gate doctrine, and
// core/properties.js's BLEND_MODE_LABELS gate): every row kind must be
// CLASSIFIED here, exactly once. Without this, a row kind added to ROW_KINDS
// later would be silently assumed jointly editable and its rows would drive a
// control that writes to only one of the selected items — the class of silent
// wrongness this module exists to prevent. Adding a kind now fails at boot,
// beside the author, instead of shipping.
{
  const classified = [...JOINT_EDITABLE_KINDS, ...Object.keys(JOINT_UNEDITABLE_KINDS)];
  for (const kind of ROW_KINDS)
    if (!classified.includes(kind))
      throw new Error(`core/multiselect: row kind "${kind}" is not classified — add it to JOINT_EDITABLE_KINDS, or to JOINT_UNEDITABLE_KINDS with the reason a joint edit cannot drive it.`);
  for (const kind of classified) {
    if (!ROW_KINDS.includes(kind))
      throw new Error(`core/multiselect: "${kind}" is classified for joint editing but is not one of ROW_KINDS (${JSON.stringify(ROW_KINDS)}) — remove the stale entry.`);
    if (classified.filter((k) => k === kind).length > 1)
      throw new Error(`core/multiselect: row kind "${kind}" is classified twice — it is either jointly editable or it is not.`);
  }
}

/**
 * Why a PAINT row cannot be edited jointly yet. web/PaintField.svelte is the one
 * Tier-1 field not yet threaded with `paths` (it was owned by another agent when
 * this landed — a handback patch is pending), so a joint paint edit would write
 * the primary item only. Reported instead of silently half-applied.
 */
export const PAINT_JOINT_EDIT_PENDING = "Fills and strokes that can hold a gradient are edited one item at a time for now (the paint control does not yet write to a set).";

/**
 * Pure function. A row's CONTRACT — the row with every presentational aspect
 * stripped. This is what the identity relation compares; see the module header
 * for the partition and why the denylist points this way.
 *
 * @param {object} row - a resolved property row ({key, label, kind, category, …})
 * @returns {object} the row's contract aspects only
 *
 * @example rowContract({key: "opacity", kind: "number", min: 0, max: 1, label: "Opacity", help: "…", category: "formatting", step: 0.01})
 * // {key: "opacity", kind: "number", min: 0, max: 1}
 * @example rowContract({key: "stroke", kind: "color", paint: true, label: "Rim color", category: "lens"})
 * // {key: "stroke", kind: "color", paint: true}
 */
export function rowContract(row) {
  const out = {};
  for (const key of Object.keys(row))
    if (!PRESENTATIONAL_ROW_ASPECTS.includes(key)) out[key] = row[key];
  return out;
}

/**
 * Pure function. Are these two rows THE SAME ROW for joint editing — i.e. do
 * their contracts match exactly? Compared with core/deltas.js `deepEqual`, the
 * codebase's established "did this value actually change" comparison, which
 * compares a FUNCTION aspect (a row's state-derived dynamic `max`) by reference —
 * the only honest answer, since two distinct closures may compute anything.
 *
 * @param {object} a - a resolved property row
 * @param {object} b - another resolved property row
 * @returns {boolean}
 *
 * @example sameRowContract({key: "x", kind: "number", label: "X"}, {key: "x", kind: "number", label: "X", help: "…"})
 * // true (help is presentational — a rect and a magnifier really do share X)
 * @example sameRowContract({key: "shape", kind: "select", options: ["star"]}, {key: "shape", kind: "select", options: ["circle", "box"]})
 * // false (different option sets are different properties sharing a name)
 * @example sameRowContract({key: "ambient", kind: "number"}, {key: "ambient", kind: "color"})
 * // false (metaball's ambient is a number, skyClouds' is a colour)
 */
export function sameRowContract(a, b) {
  return deepEqual(rowContract(a), rowContract(b));
}

/**
 * Pure function. The names of the CONTRACT aspects on which two rows disagree,
 * sorted — what a conflict REPORT shows, so an excluded row says which aspect
 * excluded it instead of merely vanishing from the panel.
 *
 * @param {object} a - a resolved property row
 * @param {object} b - another resolved property row
 * @returns {string[]} differing contract aspect names (empty iff sameRowContract)
 *
 * @example contractDifferences({key: "cornerRadius", kind: "number", min: 0}, {key: "cornerRadius", kind: "number", min: 0, max: 0.5})
 * // ["max"]
 * @example contractDifferences({key: "src", kind: "asset", assetKinds: ["image"]}, {key: "src", kind: "asset", assetKinds: ["video"]})
 * // ["assetKinds"]
 * @example contractDifferences({key: "x", kind: "number", label: "X"}, {key: "x", kind: "number", label: "Ex"})
 * // [] (a label is not a contract)
 */
export function contractDifferences(a, b) {
  const ca = rowContract(a);
  const cb = rowContract(b);
  const names = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  return [...names].filter((name) => !deepEqual(ca[name], cb[name])).sort();
}

/**
 * Pure function. Why this row cannot be edited jointly, or null when it can.
 * A row kind with no fan-out control names itself through JOINT_UNEDITABLE_KINDS;
 * a paint row is pending its field's handback. Everything else returns null.
 *
 * @param {object} row - a resolved property row
 * @returns {string|null} the reason, shown verbatim to the user
 *
 * @example jointEditProblem({key: "opacity", kind: "number"}) // null
 * @example jointEditProblem({key: "fill", kind: "color", paint: true}) === PAINT_JOINT_EDIT_PENDING // true
 * @example jointEditProblem({key: "points", kind: "list"}) === JOINT_UNEDITABLE_KINDS.list // true
 */
export function jointEditProblem(row) {
  if (row.kind in JOINT_UNEDITABLE_KINDS) return JOINT_UNEDITABLE_KINDS[row.kind];
  if (row.paint) return PAINT_JOINT_EDIT_PENDING;
  return null;
}

/**
 * Pure function. The rows N selected items SHARE, plus the CONFLICTS worth
 * reporting.
 *
 * `rows` are the PRIMARY entry's own row OBJECTS (entries[0] — the first of
 * app.selectedIds(), which core/document's selectMany already designates as the
 * primary by mirroring it into `selection`), filtered to those every other entry
 * declares an identical contract for. Returning the primary's objects is what
 * makes the presentational aspects come from ONE coherent place — the panel reads
 * as the primary item's panel, minus whatever the others do not share — and it is
 * what makes a ONE-ITEM selection return that plugin's rows by IDENTITY, so the
 * single-selection panel is unchanged by construction rather than by care.
 *
 * `conflicts` names each key that EVERY entry declares but with a differing
 * contract — the excluded rows a user would otherwise hunt for ("both of these
 * have a corner radius, where did it go?"). A key merely ABSENT from some item is
 * not a conflict, it is simply not shared, and reporting those would bury the
 * real ones under every unrelated property.
 *
 * @param {Array<{itemId: string, plugin: object, state: object}>} entries - selected items, primary FIRST
 * @returns {{rows: object[], conflicts: Array<{key: string, aspects: string[]}>}}
 *
 * @example intersectRows([]) // {rows: [], conflicts: []}
 * @example // ONE entry degrades to that plugin's own rows, unchanged:
 * // intersectRows([{itemId: "a", plugin: {inspector: [{key: "x", kind: "number"}]}, state: {}}])
 * // → {rows: [{key: "x", kind: "number"}], conflicts: []}
 * @example // opacity is shared; `shape` conflicts (both declare it, different options):
 * // intersectRows([
 * //   {itemId: "a", plugin: {inspector: [{key: "opacity", kind: "number"}, {key: "shape", kind: "select", options: ["star"]}]}, state: {}},
 * //   {itemId: "b", plugin: {inspector: [{key: "opacity", kind: "number", help: "…"}, {key: "shape", kind: "select", options: ["box"]}]}, state: {}},
 * // ])
 * // → {rows: [{key: "opacity", kind: "number"}], conflicts: [{key: "shape", aspects: ["options"]}]}
 */
export function intersectRows(entries) {
  if (entries.length === 0) return { rows: [], conflicts: [] };
  const primaryRows = entries[0].plugin.inspector ?? [];
  const otherRowLists = entries.slice(1).map((e) => e.plugin.inspector ?? []);
  const rows = [];
  const conflicts = [];
  for (const row of primaryRows) {
    // The MATCHING row on each other item, by key — the candidate this row would
    // be unified with. A key declared twice by one plugin is a plugin defect the
    // row-kind suites already reject, so the first match is the only match.
    const counterparts = otherRowLists.map((list) => list.find((r) => r.key === row.key));
    if (counterparts.every((r) => r !== undefined && sameRowContract(row, r))) {
      rows.push(row);
      continue;
    }
    // Present on EVERY item but not identical → a real conflict, worth naming.
    if (counterparts.every((r) => r !== undefined)) {
      const aspects = new Set();
      for (const r of counterparts) for (const name of contractDifferences(row, r)) aspects.add(name);
      conflicts.push({ key: row.key, aspects: [...aspects].sort() });
    }
  }
  return { rows, conflicts };
}

/**
 * Pure function. An item's DEFAULTED value at a property key: what it stores, or
 * — when it stores nothing there — what its plugin's `defaults` say it means.
 *
 * DEFAULTING BEFORE COMPARING IS THE SHIPPED PRECEDENT, not a nicety. The rich-text
 * toolbar's `sameStyle` "compares DEFAULTED values so {bold:false} and absent
 * MERGE", which is what stops a bold-then-unbold round-trip reading as a change.
 * The same reasoning applies here and the failure without it is worse: a rect that
 * has never had its opacity written stores no `opacity` at all, so comparing RAW
 * values would report it MIXED against a visually identical rect that happens to
 * store an explicit 1 — a panel that says two things differ when nothing about
 * them does.
 *
 * @param {{plugin: object, state: object}} entry - one selected item
 * @param {string[]} path - the split property key (["shadow", "dx"])
 * @returns {*} the stored value, else the plugin default, else undefined
 *
 * @example defaultedValue({plugin: {defaults: {opacity: 1}}, state: {opacity: 0.4}}, ["opacity"]) // 0.4
 * @example defaultedValue({plugin: {defaults: {opacity: 1}}, state: {}}, ["opacity"]) // 1 (absent MEANS the default)
 * @example defaultedValue({plugin: {defaults: {bold: false}}, state: {bold: false}}, ["bold"]) // false (not confused with absent)
 * @example defaultedValue({plugin: {}, state: {}}, ["opacity"]) // undefined (nothing knows a value)
 */
export function defaultedValue(entry, path) {
  const stored = getPath(entry.state, path);
  return stored === undefined ? getPath(entry.plugin.defaults, path) : stored;
}

/**
 * Pure function. How the selected items' values at one property key relate:
 * MIXED (they differ) or agreed, and what an edit starts from.
 *
 * Values are the DEFAULTED ones (see defaultedValue) read from the RAW folded
 * state — raw, so an item holding `= expr` and one holding a literal read as
 * MIXED. That is the honest answer: they are not the same value, and a user who
 * unifies them is deliberately replacing the equation.
 *
 * Comparison is core/deltas.js `deepEqual`, the same comparison `diffState` uses
 * to decide whether an interaction actually CHANGED a property, so "differs"
 * means exactly what it means everywhere else in core: structural, no coercion,
 * NO EPSILON. An epsilon would be a panel showing one unified number while the
 * document holds two, with nothing on screen to reveal the difference — and the
 * values being compared are stored authored values, not computed ones, so two
 * items the user set to 0.5 both hold exactly 0.5.
 *
 * `seed` is the PRIMARY's value — what a unify writes to everything, and the
 * defined starting point a gesture on a mixed row needs.
 *
 * @param {Array<{itemId: string, plugin: object, state: object}>} entries - selected items, primary FIRST
 * @param {string} key - a property key, possibly dotted ("shadow.dx")
 * @returns {{mixed: boolean, value: *, seed: *}} `value` is undefined when mixed
 *
 * @example rowMixedState([{itemId: "a", plugin: {}, state: {opacity: 0.5}}, {itemId: "b", plugin: {}, state: {opacity: 0.5}}], "opacity")
 * // {mixed: false, value: 0.5, seed: 0.5}
 * @example rowMixedState([{itemId: "a", plugin: {}, state: {opacity: 1}}, {itemId: "b", plugin: {}, state: {opacity: 0.2}}], "opacity")
 * // {mixed: true, value: undefined, seed: 1}
 * @example rowMixedState([{itemId: "a", plugin: {}, state: {opacity: 1}}, {itemId: "b", plugin: {}, state: {opacity: "=other.opacity"}}], "opacity")
 * // {mixed: true, value: undefined, seed: 1}   (an equation is not the literal it evaluates to)
 * @example rowMixedState([{itemId: "a", plugin: {defaults: {opacity: 1}}, state: {}}, {itemId: "b", plugin: {defaults: {opacity: 1}}, state: {opacity: 1}}], "opacity")
 * // {mixed: false, value: 1, seed: 1}   (absent MEANS the default — the sameStyle rule)
 * @example rowMixedState([{itemId: "a", plugin: {}, state: {shadow: {dx: 4}}}, {itemId: "b", plugin: {}, state: {shadow: {dx: 4}}}], "shadow.dx")
 * // {mixed: false, value: 4, seed: 4}
 */
export function rowMixedState(entries, key) {
  const path = key.split(".");
  const values = entries.map((e) => defaultedValue(e, path));
  const seed = values[0];
  const mixed = !values.every((v) => deepEqual(v, seed));
  return { mixed, value: mixed ? undefined : seed, seed };
}

/**
 * Pure function. THE ONE CALL web/Inspector.svelte makes: everything the
 * multi-selection Property Panel renders, for a selection of N items.
 *
 * Items with no state on the current slide are removed first (see the module
 * header) and returned in `skipped`, so the panel can say how many selected items
 * it is not editing instead of quietly editing fewer than the user chose.
 *
 * @param {Array<{itemId: string, plugin: object, state: object|null}>} entries - selected items, primary FIRST
 * @returns {{rows: Array<{row: object, mixed: boolean, value: *, seed: *, problem: string|null}>, conflicts: Array<{key: string, aspects: string[]}>, skipped: string[], itemIds: string[]}}
 *
 * @example multiSelectPanel([]) // {rows: [], conflicts: [], skipped: [], itemIds: []}
 * @example // a rect at opacity 1 and a video at opacity 0.2 share opacity, MIXED:
 * // multiSelectPanel([
 * //   {itemId: "r", plugin: {inspector: [{key: "opacity", kind: "number", min: 0, max: 1}]}, state: {opacity: 1}},
 * //   {itemId: "v", plugin: {inspector: [{key: "opacity", kind: "number", min: 0, max: 1}]}, state: {opacity: 0.2}},
 * // ])
 * // → rows: [{row: {key: "opacity", …}, mixed: true, value: undefined, seed: 1, problem: null}],
 * //   conflicts: [], skipped: [], itemIds: ["r", "v"]
 * @example // an item not created on this slide is skipped, never written:
 * // multiSelectPanel([{itemId: "r", plugin: {inspector: []}, state: {}}, {itemId: "ghost", plugin: {inspector: []}, state: null}]).skipped
 * // → ["ghost"]
 */
export function multiSelectPanel(entries) {
  const live = entries.filter((e) => e.state != null);
  const skipped = entries.filter((e) => e.state == null).map((e) => e.itemId);
  const { rows, conflicts } = intersectRows(live);
  return {
    rows: rows.map((row) => ({ row, ...rowMixedState(live, row.key), problem: jointEditProblem(row) })),
    conflicts,
    skipped,
    itemIds: live.map((e) => e.itemId),
  };
}

/**
 * Pure function. THE FAN-OUT PRIMITIVE: one gesture's `value` staged at N state
 * paths, as `app.setPreview` pairs.
 *
 * WHY THE TIER-1 FIELDS NEED THIS. Every specialized field (NumericField,
 * AngleField, ColorField, BooleanField) writes `app.setPreview([[path, v]])` from
 * a SINGULAR `path` prop — the one assumption a multi-selection breaks. They now
 * take an optional `paths`, default `[path]`, and route every write through here,
 * so a joint edit REUSES the real field verbatim instead of a parallel
 * multi-select control. That matters beyond DRY: the Inspector's field pipeline
 * has already shipped a defect where a declared row aspect (`scrub`) was silently
 * ignored because a SIBLING branch of the pipeline never threaded it, and the user
 * reported the same pain twice. A third branch for "multi" would reproduce that
 * class of bug for every aspect at once; reusing the itemMode branch cannot.
 *
 * @param {Array<string[]>} paths - the state paths to write (one per selected item)
 * @param {*} value - the value every path receives
 * @returns {Array<[string[], *]>} [path, value] pairs for app.setPreview
 *
 * @example fanOutPairs([["items", "a", "x"]], 5) // [[["items", "a", "x"], 5]]
 * @example fanOutPairs([["items", "a", "opacity"], ["items", "b", "opacity"]], 0.5)
 * // [[["items", "a", "opacity"], 0.5], [["items", "b", "opacity"], 0.5]]
 * @example fanOutPairs([], 5) // [] (nothing selected writes nothing)
 */
export function fanOutPairs(paths, value) {
  return paths.map((path) => [path, value]);
}

/**
 * Pure function. The `app.setPreview` pairs that write `value` at `key` on every
 * selected item — the whole joint write, staged as ONE preview and therefore
 * committed as ONE undo unit (app.commitPreview walks one delta into one
 * `commit`). The same seam `applyPreset` already writes a property SET through.
 *
 * MINIMAL DELTA (the standing rule that interactions write ONLY changed props, so
 * an equation on an untouched axis survives): an item already holding exactly
 * this value is SKIPPED. Two consequences worth stating, because a caller must
 * handle both:
 *   - When every item already holds the value the result is EMPTY, and the caller
 *     must NOT commit — `keyframed` rebuilds the document, so committing an empty
 *     write would push an undo entry for nothing (the "an untouched draft must not
 *     spend an undo unit" rule the equation field's blur handler already obeys).
 *   - An item whose stored value is an `= equation` is NOT skipped even when the
 *     equation currently evaluates to `value`: the stored strings differ, and
 *     replacing the equation is precisely what unifying to a literal means.
 * ONLY the one key is ever written — no other property of any selected item is
 * touched, so an equation on a different axis is never collateral.
 *
 * @param {Array<{itemId: string, plugin: object, state: object|null}>} entries - selected items
 * @param {string} key - the property key, possibly dotted ("shadow.dx")
 * @param {*} value - the value to unify to (a literal, or an `=` equation string)
 * @returns {Array<[string[], *]>} [path, value] pairs for app.setPreview
 *
 * @example unifyPairs([{itemId: "r", plugin: {}, state: {opacity: 1}}, {itemId: "v", plugin: {}, state: {opacity: 0.2}}], "opacity", 0.5)
 * // [[["items", "r", "opacity"], 0.5], [["items", "v", "opacity"], 0.5]]
 * @example unifyPairs([{itemId: "r", plugin: {}, state: {opacity: 0.5}}, {itemId: "v", plugin: {}, state: {opacity: 0.2}}], "opacity", 0.5)
 * // [[["items", "v", "opacity"], 0.5]]   (r already holds it — minimal delta)
 * @example unifyPairs([{itemId: "r", plugin: {}, state: {opacity: 0.5}}], "opacity", 0.5)
 * // []   (nothing to write — the caller must not commit)
 * @example unifyPairs([{itemId: "r", plugin: {defaults: {opacity: 1}}, state: {}}], "opacity", 1)
 * // []   (absent already MEANS 1 — no redundant keyframe)
 * @example unifyPairs([{itemId: "r", plugin: {}, state: {shadow: {dx: 0}}}], "shadow.dx", 8)
 * // [[["items", "r", "shadow", "dx"], 8]]
 * @example unifyPairs([{itemId: "r", plugin: {}, state: {opacity: 1}}], "opacity", "=cam.opacity")
 * // [[["items", "r", "opacity"], "=cam.opacity"]]   (an equation unifies like any value)
 */
export function unifyPairs(entries, key, value) {
  const path = key.split(".");
  return entries
    .filter((e) => e.state != null && !deepEqual(defaultedValue(e, path), value))
    .map((e) => [["items", e.itemId, ...path], value]);
}

/**
 * Pure function. The keyframe diamond's state over a SET: "all" when every
 * selected item is keyed at this property on this slide, "some" when only a few
 * are, "none" when none is — the manifest's FILLED / HALF-FILLED / HOLLOW triad.
 * An EMPTY set is "none": nothing is keyed, because there is nothing.
 *
 * @param {boolean[]} flags - one per selected item: is it keyed here?
 * @returns {"all"|"some"|"none"}
 *
 * @example keyframeTriState([true, true]) // "all"
 * @example keyframeTriState([true, false, true]) // "some"
 * @example keyframeTriState([false, false]) // "none"
 * @example keyframeTriState([]) // "none"
 */
export function keyframeTriState(flags) {
  if (flags.length === 0 || flags.every((f) => !f)) return "none";
  return flags.every((f) => f) ? "all" : "some";
}
