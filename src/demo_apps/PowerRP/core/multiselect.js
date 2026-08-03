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
 * ── THE UNIVERSAL ROWS ARE PART OF THE INTERSECTION (WORKSTREAM BE) ───────────
 * THIS SECTION USED TO SAY `active` WAS DELIBERATELY ABSENT. The user overruled
 * that (2026-08-02, night, verbatim): "When I am selecting multiple objects, the
 * universal drop-down menu should still be there, or at least some subset of it.
 * In particular, perhaps name shouldn't be there. But widget type, visible, and
 * morph all should be. The reason why? I just duplicated three objects and there
 * was no way to change their visibility interpolation all at once. I had to do it
 * once each, manually."
 *
 * MEASURED BEFORE THE FIX, on the real editor with three duplicated rects
 * selected: the panel rendered 39 plugin rows and ZERO interp buttons (single
 * selection renders 42). So visibility interpolation was not merely awkward over
 * a set — it was UNREACHABLE, which is exactly the report.
 *
 * THE MECHANISM WAS NOT A CONTRACT FAILURE, and that distinction is why the fix
 * belongs here. No plugin declares `name`/`type`/`active`/`morph` in `inspector`
 * — web/Inspector.svelte SYNTHESIZED them into a hard-coded `universalCategory`,
 * and the multi-selection branch is a different render tree that never built it.
 * `intersectRows` walks `plugin.inspector` alone, so these rows were never
 * CANDIDATES: nothing fell out of `sameRowContract`, because nothing entered it.
 * Fixing it in the component would have meant a SECOND hand-maintained copy of
 * the universal row set — the named recurring defect this module's drift gate
 * exists to prevent. So the rows move to ONE exported definition
 * (`universalRows`) that both selection paths read.
 *
 * WHICH ROWS, AND WHY NAME IS OUT. Type, Visible and Morph are in because the
 * user named them. NAME is out because the user volunteered it ("perhaps name
 * shouldn't be there") AND because it is the one universal row that is not
 * per-slide state at all: a name is written on the item's creation slide through
 * `renameSelection`, not keyframed here, and N items sharing one name would make
 * the item picker unusable. Excluding it costs nothing a set edit wants.
 *
 * ── WIDGET TYPE IS EDITABLE OVER A SET (WORKSTREAM BT) ────────────────────────
 * THIS SECTION USED TO DESCRIBE A REFUSAL, and that refusal was a Claude choice
 * (`UNIVERSAL_TYPE_ROW_PROBLEM`), never a user ruling. It reasoned: a retype is a
 * per-item COERCION PLAN, so one shared value cannot describe what N items of
 * different types would become — therefore the row renders inert with its reason.
 *
 * The user overruled it (2026-08-03, verbatim, looking at that very tooltip):
 * "Hey, why won't it let me edit widget type? No, that's a stupid error. Just do
 * it to everyone individually. When I do widget type coercion... Look, this is a
 * stupid error. There's no reason why this should be a problem. Just do it to
 * them all individually, then change what we see in the properties. It's not
 * that hard."
 *
 * THE PREMISE WAS TRUE AND THE CONCLUSION WAS WRONG. One shared value indeed
 * cannot describe N coercions — but nothing ever required it to. `retypedItem`
 * takes the item's OWN folded state and its OWN current type; running it N times,
 * once per item, is N correct plans, not one wrong one. The refusal mistook "the
 * FAN-OUT seam cannot drive this" for "this cannot be driven": `unifyPairs` writes
 * one value to N paths, and a retype is not one value — so the type row simply
 * does not go through `unifyPairs`. It goes through `app.retypeSelection`, which
 * already looped over nothing and now loops over the selection.
 *
 * SO THE ROW HAS NO `problem`. `jointEditProblem` returns null for it like any
 * other select, and the panel renders the same SearchableDropdown the single-select
 * widget-type row renders (same row grammar, same `optionsFrom: "retype"`).
 *
 * WHAT THE MENU OFFERS OVER A SET is `retypeChoicesForSet` below: the types EVERY
 * eligible selected item can become, which for the live roster is every eligible
 * type (the eligibility predicate is about the TARGET, not the source). Coercion
 * previews are per-item and there are N of them, so the set menu carries a COUNT
 * of how many selected items would lose a value rather than one item's list —
 * a per-item list would be the primary's, presented as if it were everyone's.
 *
 * INELIGIBLE ITEMS ARE SKIPPED WITH THE REASON, NEVER SILENTLY CONVERTED. BF's
 * pin stands: "the app adapter declined to retype the camera but type stayed in
 * the retargeted state and the camera SILENTLY BECAME A RECT". `retypeSkips`
 * names them and why; the panel shows that sentence on the row, and after a
 * partial apply the row reads MIXED because the camera really did keep its type.
 * An ineligible item never BLOCKS the eligible rest — that was the other half of
 * the ruling ("just do it to them all individually").
 *
 * THE SET-ACTIONS RULING IS UNTOUCHED. "A SET's visibility is TWO EXPLICIT
 * ACTIONS (Hide All / Show All), always both" rejects a tri-state ACTION control
 * that must GUESS what a click means. A `boolean` PROPERTY row reports a mixed
 * value and then unifies to a value the author picked — the reporting case, not
 * the guessing one, exactly as the rich-text toolbar's set/unset/indeterminate
 * boolean already ships. Both surfaces stay.
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
import { ROW_KINDS, PROPS, interpRowFor, rowSupportsInterp } from "./properties.js";
import { MORPH_KEY, MORPH_AUTO } from "./morph_property.js";
import { LIST_ROW_KIND } from "./lists.js";
import { NODE_INPUT_ROW_KIND } from "./nodeflow.js";

/**
 * The category the universal rows file under. It matches the id
 * web/Inspector.svelte's single-select panel uses (`__universal`), `__`-prefixed
 * for the reason stated there: a hard-coded section must own an id no plugin can
 * declare, or a plugin filing rows under it would render a second block with the
 * same title.
 */
export const UNIVERSAL_CATEGORY = "__universal";

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
 * THE TWO WAYS A MULTI-SELECTION CAN CHOOSE ITS ROWS. User, 2026-08-02: "when I
 * have a selection of multiple objects, on the very top it should let me say
 * intersection or union — if I select the intersection of properties then I see
 * what I have now, but if I toggle that to union then it will show me the union
 * of all properties. Same behaviour for both."
 *
 *   INTERSECTION (default, and byte-identical to the shipped behaviour) — only
 *     rows EVERY selected item declares. The safe reading: every row you see
 *     edits everything you selected.
 *   UNION — every row ANY selected item declares. A row only some items have
 *     still edits, keyframes, shows MIXED_MARK and unifies exactly as an
 *     intersection row does ("same behaviour for both"); it simply applies to the
 *     items that declare it. Each row carries `appliesTo` so the panel can say
 *     which, and so a write cannot leak onto an item whose plugin never declared
 *     the property.
 *
 * DEFAULTING TO INTERSECTION IS NOT A COIN FLIP: it is the mode in which "I
 * changed this row" means "I changed it on everything selected", and that is the
 * assumption a bulk edit is usually made under.
 */
export const MULTISELECT_MODE = { INTERSECTION: "intersection", UNION: "union" };

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
 *   visibleWhen — a `(state) => boolean` deciding whether the row is SHOWN at
 *     all. It is the most literally presentational aspect there is, and it
 *     passes the partition's own test cleanly: two rows differing only in
 *     `visibleWhen` accept exactly the same values, in the same unit, at the
 *     same path, and a value written to both means the same thing. Whether a
 *     control is on screen is not a claim about what it can express. See the
 *     note below for why the classification does NOT rest on how the panel
 *     happens to call groupRows today.
 *
 * @example PRESENTATIONAL_ROW_ASPECTS.includes("label") // true
 * @example PRESENTATIONAL_ROW_ASPECTS.includes("min") // false (a bound is a contract)
 * @example PRESENTATIONAL_ROW_ASPECTS.includes("display") // false (a UNIT is a contract)
 * @example PRESENTATIONAL_ROW_ASPECTS.includes("visibleWhen") // true (shown-or-not is not expressible-or-not)
 */
export const PRESENTATIONAL_ROW_ASPECTS = [
  "label", "help", "category",
  "step", "scrub",
  "onIcon", "offIcon", "onText", "offText",
  "visibleWhen",
];

// WHY `visibleWhen` IS HERE, AND THE ARGUMENT THAT DOES *NOT* JUSTIFY IT.
//
// It was added when e3caa3a gave plugins/text.js's eight box-level style rows a
// `visibleWhen` (they hide once per-run/per-paragraph twins exist) and
// plugins/plaintext.js's identical rows kept none. MEASURED consequence before
// this entry: selecting a text + a plaintext turned font / size / bold / align
// into CONFLICTS carrying aspect "visibleWhen" — four rows that are the same
// property in every way that matters, surfaced as un-editable.
//
// THE DENYLIST DID ITS JOB, and that is the point worth keeping. A new row
// aspect appeared, defaulted to CONTRACT, and produced a visible, named,
// diagnosable conflict — not two widgets silently disagreeing about what a
// written value means. The polarity described above is exactly what made a
// third-party change land as a reported symptom instead of as data loss.
//
// THE WEAK ARGUMENT, recorded so nobody promotes it: web/Inspector.svelte's
// multi panel calls `groupRows(rows)` with NO state (`:190`), and groupRows only
// consults `visibleWhen` when state is passed (`:295-298`) — so the predicate is
// inert in that panel today. TRUE, and useful, but it proves only that the
// CURRENT panel is unaffected. If it were the whole justification, then passing
// state to groupRows would silently re-break this. It is not: the entry rests on
// the CONTRACT/PRESENTATIONAL partition above, which is a statement about the
// property, not about a call site.
//
// WHAT IS GENUINELY OPEN is a DISPLAY question, and it is not this one: if a
// future set panel does resolve `visibleWhen`, it must decide WHOSE state to
// resolve it against, since a row can be visible on one selected item and hidden
// on another. That question does not reach here — the two rows are still the
// same row and a joint write to both is still well defined.

/**
 * Row kinds a joint (N-item) edit can DRIVE, because a control exists that fans
 * one gesture out to N state paths — the equation-aware fields threaded with
 * `paths`, and the kinds that already commit through the row's generic
 * `oncommit(key, kind, value)` seam.
 *
 * NODE INPUTS QUALIFY, and the check is the one this list exists to apply: the
 * joint seam fans ONE already-computed value out to N paths, and one `{item, port}`
 * reference written to three selected filters means exactly what it says — all
 * three read that source. Nothing about the value is relative to the item holding
 * it (which is what disqualifies richtext below), so the fan-out is well defined.
 * Rewiring a bank of nodes to one source in a single gesture is also a real thing
 * to want, and it is ONE undo unit through the same setPreview → commitPreview path
 * as any other row.
 *
 * @example JOINT_EDITABLE_KINDS.includes("number") // true
 * @example JOINT_EDITABLE_KINDS.includes("nodeinput") // true (one reference, N receivers)
 * @example JOINT_EDITABLE_KINDS.includes("list") // false (see JOINT_UNEDITABLE_KINDS)
 */
export const JOINT_EDITABLE_KINDS = ["number", "angle", "color", "boolean", "select", "asset", "text", "action", NODE_INPUT_ROW_KIND];

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
  // The joint seam is `oncommit(key, kind, value)` — ONE already-computed value
  // fanned out to N paths. A richtext write is a SPLICE against the item's OWN
  // current runs (core/richtext.withPlainTextReplaced), so the one value it
  // produces carries that item's whole run structure; fanning it out would stamp
  // A's styling onto B. Two text items with different content therefore show
  // MIXED and refuse the write, which is the honest answer.
  richtext: "Rich text is edited one item at a time — a write here is a SPLICE against that item's own runs, so one result cannot be shared without stamping its whole run structure onto the others.",
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

// (PAINT_JOINT_EDIT_PENDING is GONE: web/PaintField.svelte now threads `paths`
// like every other Tier-1 field — the handback that constant was waiting for.
// The one paint aspect that still cannot write to a set, the gradient STOP LIST,
// is reported honestly INSIDE the field, beside the stops it gates.)

/**
 * The universal row KEYS a multi-selection offers, in the ruled order — "widget
 * type, visible, and morph all should be", and `name` deliberately absent (see
 * the module header for both halves).
 *
 * @example UNIVERSAL_MULTI_KEYS.includes("name") // false (the row the user dropped)
 * @example UNIVERSAL_MULTI_KEYS // ["type", "active", "morph"]
 */
export const UNIVERSAL_MULTI_KEYS = ["type", "active", "morph"];

/**
 * Pure function. WHY one selected item cannot be retyped, or null when it can.
 * The predicate is `retypeEligible`'s (core/retype.js) — read through the plugin's
 * declared capabilities, never a hand list — and this only turns its `false` into
 * the sentence the panel shows.
 *
 * FOUR STRUCTURAL REASONS, each the plugin's own declaration (see retypeEligible
 * for why every one of them was already declared for another purpose). Named
 * separately rather than collapsed into "it is structural" because the user reads
 * this precisely when they are wondering why one of their items did not change,
 * and "the camera is the document's one mandatory widget" answers that where
 * "structural" does not.
 *
 * @param {object} plugin - the selected item's plugin
 * @returns {string|null} the reason, or null when the item may be retyped
 *
 * @example retypeSkipReason({type: "rect", capabilities: {}}) // null
 * @example retypeSkipReason({title: "Camera", capabilities: {purgeable: false}})
 * // 'Camera is the document’s one mandatory widget — it owns the background and every view, so it cannot become something else.'
 * @example retypeSkipReason({title: "Group", capabilities: {ghost: true}, foldsSubtree: () => true}).includes("members")
 * // true
 */
export function retypeSkipReason(plugin) {
  const c = plugin?.capabilities ?? {};
  const name = plugin?.title ?? plugin?.type ?? "This widget";
  if (c.purgeable === false)
    return `${name} is the document’s one mandatory widget — it owns the background and every view, so it cannot become something else.`;
  if (plugin?.foldsSubtree)
    return `${name} is a derivation parent — its members name it by id, so retyping it would orphan them.`;
  if (c.ghost)
    return `${name} draws no volume of its own (it renders another item’s content or is editor chrome), so there is no picture to carry into another type.`;
  if (c.metaball)
    return `${name} draws from the scene collection of its siblings, not from its own state alone, so it cannot be retyped in isolation.`;
  return null;
}

/**
 * Pure function. The selected items a retype would SKIP, each with its reason —
 * what the type row surfaces so a partial apply is never silent (WORKSTREAM BT;
 * BF's camera pin is what this keeps green).
 *
 * @param {Array<{itemId: string, plugin: object}>} entries - the selected items
 * @returns {Array<{itemId: string, reason: string}>} empty when everything is eligible
 *
 * @example retypeSkips([{itemId: "a", plugin: {capabilities: {}}}]) // []
 * @example retypeSkips([{itemId: "cam", plugin: {title: "Camera", capabilities: {purgeable: false}}}]).map((s) => s.itemId)
 * // ["cam"]
 */
export function retypeSkips(entries) {
  return entries
    .map((e) => ({ itemId: e.itemId, reason: retypeSkipReason(e.plugin) }))
    .filter((s) => s.reason !== null);
}

/**
 * Pure function. The universal rows for a selection — the rows EVERY widget has,
 * which no plugin declares and which therefore cannot come from `plugin.inspector`.
 *
 * ONE DEFINITION, TWO SELECTION PATHS. web/Inspector.svelte's single-select
 * `universalCategory` decorates these with its own help/labels/placeholder; the
 * multi panel gets them from here. Neither hand-copies the other's set, which is
 * the drift rule the module header states.
 *
 * THE CAMERA HAS NO `active` ROW. `purgeable: false` marks the mandatory
 * singleton — it cannot be hidden, so offering the row would be a control whose
 * write the document refuses. Same rule the single-select panel already applies,
 * read from the same capability rather than restated.
 *
 * @param {Array<{plugin: object}>} entries - the selected items
 * @returns {object[]} resolved rows, in UNIVERSAL_MULTI_KEYS order
 *
 * @example universalRows([{plugin: {capabilities: {}}}]).map((r) => r.key)
 * // ["type", "active", "morph"]
 * @example universalRows([{plugin: {capabilities: {purgeable: false}}}]).map((r) => r.key)
 * // ["type", "morph"]   (the camera cannot be hidden, so it offers no Visible row)
 * @example universalRows([]) // []
 */
export function universalRows(entries) {
  if (entries.length === 0) return [];
  // EVERY item must be hideable for the row to appear: a set containing the
  // camera cannot take a joint `active` write, and showing the row would promise
  // one. The intersection's own polarity — a row every item has, or no row.
  const hideable = entries.every((e) => e.plugin?.capabilities?.purgeable !== false);
  return UNIVERSAL_ROW_DEFS.filter((row) => row.key !== "active" || hideable);
}

/**
 * The universal rows' CONTRACTS. Presentational aspects (label/help) are the
 * multi panel's own — the single-select panel supplies richer ones — but the
 * contract aspects here are what a joint write is defined against.
 *
 * `morph` is spread from core/properties.js PROPS so the two cannot describe
 * different option sets; `type` and `active` have no PROPS entry (they are not
 * plugin properties) and are stated here, once.
 */
const UNIVERSAL_ROW_DEFS = [
  { key: "type", label: "Widget type", kind: "select", optionsFrom: "retype", category: UNIVERSAL_CATEGORY },
  { key: "active", label: "Visible", kind: "boolean", category: UNIVERSAL_CATEGORY,
    onIcon: "mdi:eye", offIcon: "mdi:eye-off",
    onText: "Visible on this slide — click to hide every selected item (keyframes active: false)",
    offText: "Hidden on this slide — click to show every selected item (keyframes active: true)",
    help: "Whether these items show on THIS slide. Keyframeable like any other property, and its interpolation row is what fades a set in together." },
  { ...PROPS[MORPH_KEY], key: MORPH_KEY, absentValue: MORPH_AUTO, category: UNIVERSAL_CATEGORY },
];

/**
 * Pure function. The universal rows PLUS the interp companion rows a set edit
 * needs — THE DRIVING USE CASE ("there was no way to change their visibility
 * interpolation all at once").
 *
 * ── WHICH INTERP ROWS, AND THE CLAIM THAT DID NOT SURVIVE MEASUREMENT ────────
 * The founding brief carried the user's context fact: "by default, the one
 * exception for interpolation being visible by default is visible. Visible's
 * interpolation is visible by default in the property editor."
 *
 * THAT IS NOT WHAT THE CODE DOES, measured on the real editor before this change:
 * a single-selected rect renders 42 interp BUTTONS and ZERO open interp STRIPS.
 * `interpOpenKeys` starts empty and `interpRowOpen` has no `active` exception —
 * every interp row, Visible's included, is opt-in behind its gutter button. What
 * IS singular about Visible is its MENU: `modesForKey("active", …)` returns five
 * modes (tween/step/fade/blurFade/manim) where `x` returns two, so it is by far
 * the richest interp row in the panel and the only one offering fades. That is
 * the most likely thing the recollection was pointing at.
 *
 * So this does NOT "preserve a default-open" that never existed — inventing one
 * here would have made single- and multi-select disagree, and would have been a
 * Claude-authored behaviour wearing a user ruling's clothes. What it does is
 * satisfy the RULING (the thing the user actually asked for, and the acceptance
 * they stated): with a set selected, the `active~interp` row is REACHABLE, so one
 * edit changes visibility interpolation on all N. It is a plain row here because
 * the multi panel has no per-item interp toggle to hang it behind — `interpOpenKeys`
 * is keyed by (row, OWNER item), a pairing a set does not have.
 *
 * ONLY `active` GETS ONE. A row per interp companion for all 39 shared rows would
 * double the panel to say almost nothing: the other rows offer tween/step only.
 * `active` is where the user's flow is and where the modes are.
 *
 * THE OPTION SET IS STABLE ACROSS A REAL SELECTION, which is why these rows
 * unify rather than conflict. `modesForKey` is VALUE-AWARE and a FRACTIONAL
 * `active` (0.3) yields only two modes — but core/interp_modes.js is explicit
 * that "a folded slide state never holds a fraction; only the strictly-interior
 * frames of a transition are fractional", so the Inspector's raw state is always
 * a boolean and always the five-mode menu. Were that ever violated, the rows
 * would differ on `options` — a CONTRACT aspect — and surface as a reported
 * conflict rather than a silent mis-unification. The denylist polarity covers it.
 *
 * @param {Array<{plugin: object, state: object}>} entries - the selected items
 * @returns {object[]} universal rows, each interp-capable one followed by its companion
 *
 * @example universalRowsWithInterp([{plugin: {capabilities: {}}, state: {active: true}}]).map((r) => r.key)
 * // ["type", "active", "active~interp", "morph"]
 * @example universalRowsWithInterp([{plugin: {capabilities: {purgeable: false}}, state: {}}]).map((r) => r.key)
 * // ["type", "morph"]   (no Visible row, so no interp row either)
 */
export function universalRowsWithInterp(entries) {
  const out = [];
  for (const row of universalRows(entries)) {
    out.push(row);
    if (row.key !== "active" || !rowSupportsInterp(row)) continue;
    // Built from core/properties.interpRowFor — the SAME builder the single-select
    // panel uses — so the two panels cannot offer different modes for one property.
    // Seeded from the PRIMARY's value, which is what every other row in this
    // module reads as its seed.
    out.push({ ...interpRowFor(row, entries[0]?.state?.[row.key], entries[0]?.state?.type), category: UNIVERSAL_CATEGORY });
  }
  return out;
}

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
 * everything else — paint rows included, since PaintField threads `paths` —
 * returns null.
 *
 * @param {object} row - a resolved property row
 * @returns {string|null} the reason, shown verbatim to the user
 *
 * THERE IS NO LONGER A PER-ROW REFUSAL. `type` used to be one (WORKSTREAM BE's
 * UNIVERSAL_TYPE_ROW_PROBLEM); the user overruled it (WORKSTREAM BT, see the
 * module header). The row is now driven by `app.retypeSelection`, which runs one
 * coercion plan PER ITEM — so the reason it was excluded from this table's
 * grammar ("one shared value cannot say what N widgets become") no longer
 * describes how the row writes. Nothing here special-cases a key any more.
 *
 * @example jointEditProblem({key: "opacity", kind: "number"}) // null
 * @example jointEditProblem({key: "fill", kind: "color", paint: true}) // null (PaintField fans out)
 * @example jointEditProblem({key: "points", kind: "list"}) === JOINT_UNEDITABLE_KINDS.list // true
 * @example jointEditProblem({key: "type", kind: "select"}) // null (WORKSTREAM BT — retyped per item)
 * @example jointEditProblem({key: "active", kind: "boolean"}) // null (visibility DOES unify)
 */
export function jointEditProblem(row) {
  if (row.kind in JOINT_UNEDITABLE_KINDS) return JOINT_UNEDITABLE_KINDS[row.kind];
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
export function intersectRows(entries, mode = MULTISELECT_MODE.INTERSECTION) {
  if (entries.length === 0) return { rows: [], conflicts: [] };
  const union = mode === MULTISELECT_MODE.UNION;
  // THE UNIVERSAL ROWS LEAD, and they are PREPENDED to every item's row list
  // rather than special-cased downstream. That is what makes them ordinary
  // participants: they run the same contract comparison, the same mixed-value
  // read, the same fan-out write and the same conflict report as a plugin row,
  // with no branch anywhere below this line. Prepending (rather than appending)
  // puts them first in the panel for the same reason the single-select panel
  // renders its Universal section first — they are the properties every widget
  // has, and a plugin's sections are what it adds to them.
  const universal = universalRowsWithInterp(entries);
  const rowsOf = entries.map((e) => [...universal, ...(e.plugin.inspector ?? [])]);
  // WHICH KEYS ARE CANDIDATES. Intersection asks only what the PRIMARY declares
  // (a key it lacks can never be shared), so the panel reads as the primary
  // item's panel minus what the others do not share — the shipped behaviour, and
  // the reason a one-item selection returns that plugin's rows by identity.
  // Union asks every key ANY item declares, primary-first so that framing
  // survives and the extra rows append rather than reshuffling the panel.
  const keys = [];
  const seenKeys = new Set();
  for (const list of union ? rowsOf : [rowsOf[0]])
    for (const r of list) if (!seenKeys.has(r.key)) { seenKeys.add(r.key); keys.push(r.key); }

  const rows = [];
  const conflicts = [];
  // key → the itemIds that DECLARE the row. A side table rather than a field on
  // the row, so rows stay the plugins' own objects (the drift gate above).
  const appliesTo = new Map();
  for (const key of keys) {
    // The MATCHING row on each item, by key — the candidate this row would be
    // unified with. A key declared twice by one plugin is a plugin defect the
    // row-kind suites already reject, so the first match is the only match.
    const found = rowsOf.map((list) => list.find((r) => r.key === key));
    // WHO PARTICIPATES. Intersection: everyone, or the row is out. Union: the
    // items that actually DECLARE the row — and no others, which is the decision
    // worth stating. The alternative (write the key onto every selected item) was
    // rejected: it would store a property a plugin does not declare, which is
    // invisible junk in the document that its widget silently ignores. A union
    // row therefore edits the subset that can MEAN it; `appliesTo` names them so
    // the panel can say so and the fan-out can target exactly those.
    const present = entries.filter((_, i) => found[i] !== undefined);
    const declared = found.filter((r) => r !== undefined);
    if (!union && declared.length !== entries.length) continue; // not shared — not a conflict either
    const seed = declared[0];
    if (declared.every((r) => sameRowContract(seed, r))) {
      // THE ROW IS PUSHED BY REFERENCE, NEVER REBUILT. A `{...seed, appliesTo}`
      // spread here would be the obvious way to carry participation and it is
      // FORBIDDEN: tests/multiselect_test.js's drift gate asserts an intersected
      // row IS the plugin's own object, on the manifest's reasoning that "a
      // reference cannot drift from itself; a lookup needs a table that can be
      // missing". It caught exactly that mistake when union mode was written.
      // Participation therefore rides in a SIDE TABLE keyed by row key, and
      // multiSelectPanel puts it on the WRAPPER it already builds per row.
      rows.push(seed);
      appliesTo.set(key, present.map((e) => e.itemId));
      continue;
    }
    // ── A CONTRACT MISMATCH WARNS, IT NO LONGER BLOCKS (#300) ────────────────
    // User, 2026-08-02: "I realise they may mean different things, so if the
    // top-level drop-down is different just show it with a triple dot. If I click
    // it, it will unify them… You can still have a warning message on the top
    // explaining why something is special, but don't actually BLOCK me from doing
    // it. There should be a way to get around that."
    //
    // The row is now OFFERED as well as reported: it joins `rows` so the panel can
    // render it with MIXED_MARK and let one click unify, and it stays in
    // `conflicts` so the warning line above the panel can still say what differs.
    // Those two are not alternatives — the point is to inform AND allow.
    //
    // THE PRIMARY'S ROW IS THE ONE OFFERED, which is the user's "it will always
    // default to whatever that top-level drop-down says it is": the panel already
    // reads as the primary item's panel, so its contract is the one an author is
    // looking at when they click. Pushed BY REFERENCE like every other row, so the
    // drift gate still holds.
    //
    // THIS IS ORTHOGONAL TO UNION MODE. Union is about a row being ABSENT from
    // some items; this is about a row MEANING different things where it is
    // present. Both now surface the row, for different reasons, and neither
    // silently writes a value another item cannot mean — the write is a deliberate
    // click on a marked row, not a side effect of the panel being built.
    const aspects = new Set();
    for (const r of declared.slice(1)) for (const name of contractDifferences(seed, r)) aspects.add(name);
    rows.push(seed);
    appliesTo.set(key, present.map((e) => e.itemId));
    conflicts.push({ key, aspects: [...aspects].sort() });
  }
  return { rows, conflicts, appliesTo };
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
 * @param {string} [mode] - MULTISELECT_MODE.INTERSECTION (default) or .UNION
 * `retypeSkips` are the selected items a WIDGET-TYPE change would not touch and
 * why (WORKSTREAM BT). It rides on the panel rather than on the type row because
 * it is a fact about the SELECTION, not about the row's contract — and putting it
 * on the row would mean rebuilding the row object, which the drift gate forbids.
 *
 * @returns {{rows: Array<{row: object, appliesTo: string[], mixed: boolean, value: *, seed: *, problem: string|null}>, conflicts: Array<{key: string, aspects: string[]}>, skipped: string[], retypeSkips: Array<{itemId: string, reason: string}>, mode: string, itemIds: string[]}}
 *
 * @example multiSelectPanel([]) // {rows: [], conflicts: [], skipped: [], retypeSkips: [], mode: "intersection", itemIds: []}
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
export function multiSelectPanel(entries, mode = MULTISELECT_MODE.INTERSECTION) {
  const live = entries.filter((e) => e.state != null);
  const skipped = entries.filter((e) => e.state == null).map((e) => e.itemId);
  const { rows, conflicts, appliesTo } = intersectRows(live, mode);
  return {
    rows: rows.map((row) => {
      // MIXEDNESS IS READ OVER THE ITEMS THE ROW APPLIES TO, NOT THE WHOLE
      // SELECTION — and in UNION mode those differ. Reading all of them would ask
      // an item whose plugin never declares the key for a value, get `undefined`
      // from both its state and its defaults, and report the row MIXED against a
      // participant that has a perfectly definite value. The row would show "…"
      // forever and unifying could never clear it: a permanently-wrong panel.
      // In INTERSECTION mode `appliesTo` is every live item, so this is the same
      // call the shipped code made.
      const ids = appliesTo.get(row.key) ?? live.map((e) => e.itemId);
      const applicable = live.filter((e) => ids.includes(e.itemId));
      // WHICH CONTRACT ASPECTS DISAGREE, or null. A conflicted row is OFFERED now
      // rather than withheld (#300), so each one has to carry the reason it is
      // special — the panel marks it and names what differs, and unifying it is a
      // deliberate click rather than something that can happen by accident.
      const conflict = conflicts.find((c) => c.key === row.key) ?? null;
      return {
        row, appliesTo: ids,
        conflict: conflict ? conflict.aspects : null,
        ...rowMixedState(applicable, row.key),
        problem: jointEditProblem(row),
      };
    }),
    conflicts,
    skipped,
    // Read over the LIVE entries only: an item not on this slide is already
    // reported by `skipped` and has no folded type to retype anyway, so naming it
    // twice for two different reasons would be noise.
    retypeSkips: retypeSkips(live),
    mode,
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
  // An OBJECT value (a gradient paint, a shadow) is cloned PER TARGET: writing
  // one shared reference into N items would alias their stored state — a later
  // in-place mutation anywhere would edit all of them silently.
  const perTarget = () => (value !== null && typeof value === "object" ? structuredClone(value) : value);
  return entries
    .filter((e) => e.state != null && !deepEqual(defaultedValue(e, path), value))
    .map((e) => [["items", e.itemId, ...path], perTarget()]);
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
