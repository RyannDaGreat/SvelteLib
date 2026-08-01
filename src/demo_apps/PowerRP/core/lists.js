/**
 * LIST PROPERTIES — the substrate for a property whose value is a VARIABLE-LENGTH
 * list of records: a gradient's `stops`, a polygon's `points`. DOM-free pure JS
 * (bare-node testable, like the rest of core/).
 *
 * ── WHY (the hole this closes) ────────────────────────────────────────────────
 * Manifest Tier 0 says EVERY property accepts an `=` equation, no exceptions. A
 * list was the largest remaining exception, for four separate reasons, all of
 * them the same root cause — a list had no DECLARATION:
 *   1. `core/deltas.js leaves()` treats an array as an OPAQUE leaf and never
 *      descends, so `points.3.x` was not a leaf path at all;
 *   2. so `isNumericSlot` never saw it and `numericPropertyPaths` never offered
 *      it — no per-element `=`;
 *   3. binding the WHOLE list failed for a different reason:
 *      `resultKindForSlot` found no kind for an array-valued slot and returned
 *      UNRESOLVED, which `resultMatchesKind` rejects (loudly, falling back to the
 *      default);
 *   4. `core/properties.js ROW_KINDS` was a CLOSED vocabulary with no list
 *      control, so no Inspector row could be declared for one.
 * Gradient stops sidestepped all four by being BESPOKE UI (web/PaintField.svelte
 * hand-writes a stop row per element). This module is the general mechanism that
 * bespoke UI should have been, so `points` gets it for free and nothing has to be
 * re-typed for the next list property.
 *
 * ── THE LIST DECLARATION (the published interface) ────────────────────────────
 * A list property's row carries these aspects (validated by
 * checkListDeclaration, called from the core/properties.js import-time guard):
 *
 *   {
 *     kind: "list",
 *     element: {
 *       storage: "record" | "tuple",       // how ONE element is stored
 *       fields: [{name, kind, min?, max?, label?, ...}, ...],
 *     },
 *     order: "sorted" | "sequence",
 *     orderKey: <field name>,              // REQUIRED iff order === "sorted"
 *     activeKey: <sibling state key>,      // where per-element visibility lives
 *     minLength: <number>,                 // optional floor on the value's length
 *   }
 *
 * The field `kind`s are the SAME control vocabulary every other property row
 * uses (core/properties.js ROW_KINDS) — there is deliberately no parallel
 * type system for list elements.
 *
 * ── HIDE vs PURGE: the ITEM-level rule, one level down ────────────────────────
 * The document model's universal rule for ITEMS is "`active: false` is how items
 * exist on some slides and not others — Delete keyframes it; Purge actually
 * removes" (core/properties.js PROPS.active). A list ELEMENT gets the SAME two
 * operations, with the same split, from the same machinery:
 *
 *   HIDE   — keyframes the element's `active` flag off. The element is still
 *            stored, still keyframable, still there to come back on another
 *            slide; it simply does not participate. NOTHING MOVES.
 *   PURGE  — splices the element out of the array. Destructive, and it RENUMBERS
 *            every later element (see the identity invariant below).
 *
 * A per-row X affordance is PURGE. Visibility is a SEPARATE toggle. They are not
 * interchangeable and no part of this interface lets one stand in for the other.
 *
 * ── WHERE THE FLAG LIVES, and why it is NOT a field of the element ────────────
 * Visibility is an ALIGNED COMPANION LIST beside the list itself, named by the
 * declaration's `activeKey` (`points` → `pointsActive`, `stops` → `stopsActive`):
 * index i of the companion is element i's flag, and an ABSENT flag (a short or
 * missing companion) means VISIBLE — the same absent-means-visible rule item
 * `active` has, so EVERY existing document keeps rendering byte-identically with
 * no migration.
 *
 * It is not a field INSIDE the element, and that is forced, not stylistic: a
 * TUPLE element ([x, y]) has no key space, and appending a third slot would
 * change the array's length AND its contents from all-numeric to mixed — which
 * flips `core/interpolators.js interpolate()` off its pure-numeric-array branch
 * onto the per-element branch, where the tweenline INT RULE rounds a lerp between
 * two integers. Normalized polygon corners are routinely exactly 0 and 1, so that
 * would silently SNAP every vertex tween at alpha 0.5 — the precise defect the
 * tuple storage form exists to avoid. A record element COULD hold the key, but
 * then hiding would work one way for stops and another way for points: two
 * mechanisms for one concept, which is the duplication this module exists to
 * prevent. One companion serves both storage forms identically.
 *
 * ── "ACTS LIKE IT'S NOT THERE": one primitive, per-flavour meaning ────────────
 * `visibleElements(decl, value)` returns the list a CONSUMER should read — the
 * surviving elements, in order, with the hidden ones simply absent. Because it
 * returns exactly the array a user would have authored by hand, each consumer's
 * existing semantics do the rest, with no special-casing anywhere:
 *   GRADIENT STOPS (sorted)  — the ramp interpolates between the SURVIVING
 *     neighbours (there is no transparent hole: the hidden stop never reaches
 *     render_gpu/ir.js normalizeStops at all), and a 3-stop gradient with its
 *     middle stop hidden is byte-identical to the hand-authored 2-stop gradient.
 *   POLYGON VERTICES (sequence) — the chain closes over the hidden vertex: the
 *     edge runs from the previous surviving vertex straight to the next. The
 *     hidden vertex's stored coordinates are untouched, so unhiding restores the
 *     exact shape.
 *
 * ── ELEMENT IDENTITY: the index, and the two operations that renumber ─────────
 * An element's identity IS its index — there is no generated per-element id,
 * because an id cannot live in a tuple element for exactly the reason `active`
 * cannot (above), so ids would be available for record lists only, i.e. two
 * identity schemes for one concept.
 *
 * INVARIANT (load-bearing for equations): HIDE NEVER RENUMBERS. It writes only
 * the companion, so `points.3.x` still names the same vertex after any number of
 * elements are hidden, and a sorted list's order key is untouched so its
 * canonical order cannot move either. This is WHY hide exists: it is the
 * index-preserving way to take an element out of the picture, exactly as
 * keyframing item `active` off is the id-preserving way to take an item out.
 *
 * PURGE, INSERT AND REORDER ARE THE RENUMBERING OPERATIONS. Purge and insert
 * shift every later element's address by one; a REORDER (only a "sorted" list
 * has one — moving an element's order key past a neighbour's) permutes them. So
 * an equation bound to another element's field silently comes to mean its
 * neighbour. (This is the same hazard that made per-vertex ANCHORS a rejected
 * design: plugins/polygon.js records that index-keyed vertex anchors would
 * rebind every attached arrow on insert.) `indexAfterPurge` / `indexAfterInsert`
 * are the pure remaps a document-wide equation rewrite needs — and for a reorder
 * the remap cannot be computed from an index alone (it depends on the VALUES),
 * so `withElementsOrderedBy` returns it. Wiring that rewrite (the
 * core/expressions.js withVariableRenamed shape — walk every slide delta,
 * rewrite matching reference tokens) is the follow-up that makes these safe
 * rather than merely loud.
 *
 * ── THE TWO ELEMENT STORAGE FORMS, and why both exist ─────────────────────────
 * "record" — one element is a plain object keyed by field name:
 *              {offset: 0.5, color: "#ff0000"}     (a gradient stop)
 * "tuple"  — one element is a positional array, field i at index i:
 *              [0.5, 0.25]                         (a polygon point)
 * A tuple is NOT a stylistic preference. `core/interpolators.js interpolate()`
 * ROUNDS a lerp between two INTEGERS (the tweenline int rule), and normalized
 * polygon corners are routinely exactly 0 and 1 — so a RECORD of coordinates
 * would recurse to that integer path and SNAP at alpha 0.5, while a numeric
 * PAIR takes interpolate's pure-numeric-array branch (a plain lerp, the branch
 * whose own comment says it exists "so point/coord lists stay byte-identical").
 * Declaring the storage form therefore lets a list KEEP its existing byte layout
 * — and its existing tween behaviour — while still naming its fields. Nothing in
 * a document is rewritten by adopting a declaration.
 *
 * ── ADDRESSING: named fields, positional storage ──────────────────────────────
 * A field is ALWAYS addressed by NAME (`points.3.x`, `stops.2.offset`); the
 * name→storage mapping (identity for a record, name→index for a tuple) happens
 * in exactly ONE place, `listStoragePath` / `listLogicalPath`. This is the same
 * declared-naming-over-storage duality the equation grammar already has between
 * display snake_case and stored camelCase (core/expressions.js pathToStored).
 * A KIND QUERY (listPathKind) accepts either spelling, because asking "what type
 * lives here" is not an addressing decision — but there is only ONE canonical
 * ADDRESS, so the two spellings can never drift into two meanings.
 *
 * ── SORTED vs SEQUENCE (the distinction the mechanism turns on) ───────────────
 * "sorted"   — the order is DERIVED from a declared key field, so it carries no
 *              information of its own. Editing one element's key past another's
 *              simply SWAPS them (canonicalOrder re-sorts), which is what makes
 *              a gradient's absolute stop positions behave the way a user
 *              expects: drag stop 1 past stop 2 and they trade places.
 * "sequence" — the order IS the data. A polygon's vertices define the outline;
 *              sorting them would change the shape into a different polygon. So
 *              insert-between means "insert at this index", and reordering is an
 *              explicit gesture, never a side effect of editing a value.
 *
 * MEASURED WARNING — "sorted" means CANONICALIZED AT WRITE TIME, not "the
 * renderer sorts". Gradient stop order is LOAD-BEARING all the way down:
 * render_gpu/ir.js normalizeStops maps the array in place without sorting, Skia
 * PINS each stop position to >= the previous one (so a stop moved before its
 * predecessor COLLAPSES its span instead of swapping — measured on a CanvasKit
 * raster: stops [0.5 green, 0 red, 1 blue] render flat green to 0.5 then red→blue,
 * and [1, 0.5, 0] render solid blue), the SVG backend emits <stop> elements in
 * array order (where the SVG spec applies the same monotonic clamp), and the PDF
 * backend uses the array order as its stitching-function segment order with the
 * offsets as `Bounds`, which the PDF spec requires to be increasing. So a sorted
 * list is only "free to reorder" because canonicalOrder runs on every write.
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
 * It has no opinion about the UI. It produces/validates VALUES and PATHS;
 * web/Inspector.svelte's list control and web/PaintField.svelte consume it.
 * A whole ELEMENT (`points.3`, without a field) is deliberately NOT an
 * addressable slot: it has no declared kind of its own, so an `=` there stays
 * UNRESOLVED and fails loudly (see listPathKind). Its FIELDS are the slots.
 */

import { interpolate, lerp } from "./interpolators.js";

/**
 * The two list ORDER flavours. See the module header for why the distinction is
 * load-bearing rather than cosmetic.
 *
 * @example LIST_ORDERS.includes("sorted") // true
 * @example LIST_ORDERS.includes("keyed") // false
 */
export const LIST_ORDERS = ["sorted", "sequence"];

/**
 * The two element STORAGE forms — a name-keyed record, or a positional tuple.
 *
 * @example ELEMENT_STORAGE // ["record", "tuple"]
 */
export const ELEMENT_STORAGE = ["record", "tuple"];

/** The `kind` a list property row declares (the ROW_KINDS entry this module owns). */
export const LIST_ROW_KIND = "list";

/**
 * THE UNIVERSAL PER-ELEMENT VISIBILITY FIELD — injected by this module into every
 * list, never declared per element shape (a per-plugin copy is how the item-level
 * `active` row would have drifted, and the same reasoning applies here). Its
 * label/kind mirror core/properties.js PROPS.active exactly, because it IS that
 * rule one level down. Its value lives in the declaration's `activeKey` companion
 * list, NOT inside the element — see the module header for why that is forced.
 *
 * @example ACTIVE_FIELD.name // "active"
 * @example ACTIVE_FIELD.kind // "boolean"
 */
export const ACTIVE_FIELD = {
  name: "active",
  kind: "boolean",
  label: "Visible",
  help: "Whether this element participates. Hiding keyframes it off rather than removing it, so it can come back on a later slide and nothing after it is renumbered; the X button purges it for good.",
};

/** Halfway — the interpolation position an insert-BETWEEN lands its new element
 *  at, i.e. exactly between its two neighbours. */
const MIDPOINT = 0.5;

/**
 * Query (throws). Validates ONE list declaration, naming the fix in the message
 * — the loud import-time guard idiom (core/properties.js checkOptionGroups /
 * render_gpu/skia/render_settings.js ANTIALIAS_MODES). `label` identifies the
 * declaration in the error; `fieldKinds` is the allowed control vocabulary
 * (ROW_KINDS) and `sortableKinds` the subset a sorted list's key may use, both
 * supplied by the caller so this module holds no second copy of that vocabulary.
 *
 * Args:
 *   label (string): what to call the declaration in an error message
 *   def (object): the row/PROPS definition to validate
 *   fieldKinds (string[]): every kind an element field may declare
 *   sortableKinds (string[]): the kinds a sorted list's orderKey may declare
 *
 * Returns:
 *   undefined (throws on a malformed declaration)
 *
 * @example checkListDeclaration("points", {kind: "list", order: "sequence", activeKey: "pointsActive", element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, ["number"], ["number"]) // undefined
 * @example // a sorted list with no orderKey throws:
 * @example // checkListDeclaration("stops", {kind: "list", order: "sorted", activeKey: "stopsActive", element: {storage: "record", fields: [{name: "offset", kind: "number"}]}}, ["number"], ["number"])
 * @example // → 'properties: "stops" declares order "sorted" but no orderKey …'
 */
export function checkListDeclaration(label, def, fieldKinds, sortableKinds) {
  const bad = (message) => { throw new Error(`properties: "${label}" ${message}`); };
  if (def.kind !== LIST_ROW_KIND) bad(`is not a list declaration (kind "${def.kind}")`);
  const el = def.element;
  if (!el || typeof el !== "object") bad(`declares kind "${LIST_ROW_KIND}" but no \`element\` shape — a list must say what ONE element holds (see core/lists.js)`);
  if (!ELEMENT_STORAGE.includes(el.storage)) bad(`declares element storage "${el.storage}", not one of ${JSON.stringify(ELEMENT_STORAGE)}`);
  if (!Array.isArray(el.fields) || el.fields.length === 0) bad("declares an element with no fields — name at least one");
  const seen = new Set();
  for (const f of el.fields) {
    if (!f || typeof f.name !== "string" || !f.name) bad(`has an element field with no name: ${JSON.stringify(f)}`);
    if (seen.has(f.name)) bad(`declares the element field "${f.name}" twice`);
    if (f.name === ACTIVE_FIELD.name) bad(`declares an element field named "${ACTIVE_FIELD.name}" — per-element visibility is UNIVERSAL and injected by core/lists.js (it lives in the "${def.activeKey}" companion, never inside the element); remove the hand-declared copy`);
    seen.add(f.name);
    if (!fieldKinds.includes(f.kind)) bad(`element field "${f.name}" declares kind "${f.kind}", not one of ${JSON.stringify(fieldKinds)} — element fields use the SAME control vocabulary as any other property row`);
  }
  if (typeof def.activeKey !== "string" || !def.activeKey)
    bad(`declares no \`activeKey\` — every list carries per-element visibility, stored in a companion list beside it (see core/lists.js)`);
  if (!LIST_ORDERS.includes(def.order)) bad(`declares order "${def.order}", not one of ${JSON.stringify(LIST_ORDERS)} — see core/lists.js for what the two mean`);
  if (def.order === "sorted") {
    if (!def.orderKey) bad(`declares order "sorted" but no orderKey — a sorted list derives its order from a declared field (e.g. a gradient stop's "offset")`);
    if (!seen.has(def.orderKey)) bad(`declares orderKey "${def.orderKey}", which is not one of its element fields (${[...seen].join(", ")})`);
    const keyKind = el.fields.find((f) => f.name === def.orderKey).kind;
    if (!sortableKinds.includes(keyKind)) bad(`declares orderKey "${def.orderKey}", whose kind "${keyKind}" has no ordering — a sorted list's key must be one of ${JSON.stringify(sortableKinds)}`);
  } else if (def.orderKey) {
    bad(`declares an orderKey but order "${def.order}" — only a sorted list derives its order from a field`);
  }
  if ("minLength" in def && !(Number.isInteger(def.minLength) && def.minLength >= 0))
    bad(`declares minLength ${JSON.stringify(def.minLength)}, which is not a non-negative integer`);
}

/**
 * Pure function. The element's declared fields, in declaration order.
 *
 * @example elementFields({storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}).map((f) => f.name) // ["x", "y"]
 */
export function elementFields(element) {
  return element.fields;
}

/**
 * Pure function. The declared kind of one element field, or null when the
 * element declares no such field.
 *
 * @example elementFieldKind({storage: "record", fields: [{name: "offset", kind: "number"}, {name: "color", kind: "color"}]}, "color") // "color"
 * @example elementFieldKind({storage: "record", fields: [{name: "offset", kind: "number"}]}, "nope") // null
 */
export function elementFieldKind(element, fieldName) {
  return element.fields.find((f) => f.name === fieldName)?.kind ?? null;
}

/**
 * Pure function. The STORAGE key one field lives under: its own name for a
 * record element, its declared POSITION for a tuple element. Throws on a field
 * the element does not declare (a typo must not silently address nothing).
 *
 * @example elementStorageKey({storage: "record", fields: [{name: "offset", kind: "number"}, {name: "color", kind: "color"}]}, "color") // "color"
 * @example elementStorageKey({storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}, "y") // 1
 */
export function elementStorageKey(element, fieldName) {
  const index = element.fields.findIndex((f) => f.name === fieldName);
  if (index < 0)
    throw new Error(`lists: no element field named "${fieldName}" (declared: ${element.fields.map((f) => f.name).join(", ")})`);
  return element.storage === "tuple" ? index : fieldName;
}

/**
 * Pure function. The FIELD NAME stored under a storage key — the inverse of
 * elementStorageKey — or null when the key addresses no declared field. A
 * numeric-STRING key is accepted for a tuple (a path segment walked out of a
 * document is a string, e.g. "1"), which is why the delta path
 * ["points", 3, "1"] resolves the same as ["points", 3, 1].
 *
 * @example elementFieldNameAt({storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}, 1) // "y"
 * @example elementFieldNameAt({storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}, "0") // "x"
 * @example elementFieldNameAt({storage: "record", fields: [{name: "offset", kind: "number"}]}, "offset") // "offset"
 * @example elementFieldNameAt({storage: "tuple", fields: [{name: "x", kind: "number"}]}, 7) // null
 */
export function elementFieldNameAt(element, storageKey) {
  if (element.storage === "tuple") {
    const index = Number(storageKey);
    if (!Number.isInteger(index)) return null;
    return element.fields[index]?.name ?? null;
  }
  return element.fields.some((f) => f.name === storageKey) ? storageKey : null;
}

/**
 * Pure function. One field's value on one element.
 *
 * @example elementFieldValue({storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}, [0.25, 0.75], "y") // 0.75
 * @example elementFieldValue({storage: "record", fields: [{name: "offset", kind: "number"}]}, {offset: 0.4}, "offset") // 0.4
 */
export function elementFieldValue(element, el, fieldName) {
  return el[elementStorageKey(element, fieldName)];
}

/**
 * Pure function. A COPY of `el` with one field replaced — the write a list-row
 * edit makes. Returns a new element (a document's arrays are shared as immutable
 * leaves, so mutating one would corrupt the cached slide state that produced it).
 *
 * @example withElementFieldValue({storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}, [0.25, 0.75], "x", 0.5) // [0.5, 0.75]
 * @example withElementFieldValue({storage: "record", fields: [{name: "offset", kind: "number"}, {name: "color", kind: "color"}]}, {offset: 0, color: "#ff0000"}, "offset", 0.3) // {offset: 0.3, color: "#ff0000"}
 */
export function withElementFieldValue(element, el, fieldName, value) {
  const key = elementStorageKey(element, fieldName);
  if (element.storage === "tuple") {
    const out = el.slice();
    out[key] = value;
    return out;
  }
  return { ...el, [key]: value };
}

/**
 * Pure function. A shallow COPY of one element in its declared storage form —
 * the copy-on-write every list edit goes through (a document's arrays are shared
 * as immutable leaves; see core/deltas.js copied).
 *
 * @example copiedElement({storage: "tuple", fields: [{name: "x", kind: "number"}]}, [0.5]) // [0.5] (a new array)
 * @example copiedElement({storage: "record", fields: [{name: "offset", kind: "number"}]}, {offset: 0.5}) // {offset: 0.5} (a new object)
 */
export function copiedElement(element, el) {
  return element.storage === "tuple" ? el.slice() : { ...el };
}

/**
 * Pure function. One field of a NEW element interpolated between two existing
 * ones — the per-field half of insertedElement.
 *
 * TWO numbers LERP CONTINUOUSLY (never through interpolate). interpolate()
 * applies the tweenline INT RULE — a lerp between two integers rounds — which is
 * right for a TWEEN (a keyframed side count must not show 4.5 sides mid-flight)
 * and wrong here: the midpoint of a gradient's default stops (offset 0 and
 * offset 1) would round to 1, producing a DUPLICATE of the neighbour instead of
 * an in-between, which is the whole point of the gesture. Insert-between is a
 * one-shot authoring action, so the position it computes must land strictly
 * between its neighbours.
 *
 * ANY OTHER value shape goes through interpolate at the midpoint, so a colour
 * blends per-channel (including its alpha) and a boolean/string/enum snaps to
 * the LATER of the two (interpolate is discrete for unlike values at alpha > 0).
 *
 * FLAG — there is no `integer` field aspect in the vocabulary, so a list field
 * that must stay integral is not expressible; every element field in the app
 * today (polygon coordinates, gradient offsets) is continuous. Add the aspect
 * here, not a second rule elsewhere, if an integral one ever appears.
 *
 * @example betweenFieldValue(0, 1) // 0.5 (a plain lerp: NOT interpolate's rounded int rule)
 * @example betweenFieldValue(0.25, 0.75) // 0.5
 * @example betweenFieldValue("#000000", "#ffffff") // "#808080" (per-channel colour blend)
 * @example betweenFieldValue("a", "b") // "b" (discrete: unlike values snap to the target)
 */
export function betweenFieldValue(a, b) {
  if (typeof a === "number" && typeof b === "number") return lerp(a, b, MIDPOINT);
  return interpolate(a, b, MIDPOINT);
}

/**
 * Pure function. One field of a NEW element EXTRAPOLATED past the end of a list:
 * `edge` is the outermost element's value, `inner` its neighbour's.
 *
 * TWO numbers REFLECT the outermost step (edge + (edge − inner)), clamped to the
 * field's declared bounds — so appending to a gradient whose last stops sit at
 * 0.5 and 1 lands at 1 (clamped by max), i.e. "extend the ramp to the far end",
 * and appending to a polygon continues its last edge by the same step.
 *
 * ANY OTHER value shape COPIES the edge. There is no meaningful "beyond" for a
 * colour or an enum — reflecting a colour would invent one outside the ramp,
 * whereas copying keeps the ramp's end colour, which is what extending a
 * gradient means.
 *
 * @example extrapolatedFieldValue(1, 0.5, {}) // 1.5
 * @example extrapolatedFieldValue(1, 0.5, {min: 0, max: 1}) // 1 (clamped to the declared max)
 * @example extrapolatedFieldValue(0, 0.5, {min: 0, max: 1}) // 0 (prepending past a min)
 * @example extrapolatedFieldValue("#ff0000", "#00ff00", {}) // "#ff0000" (a colour has no "beyond": copy the edge)
 */
export function extrapolatedFieldValue(edge, inner, field) {
  if (typeof edge !== "number" || typeof inner !== "number") return edge;
  const reflected = edge + (edge - inner);
  const lo = typeof field.min === "number" ? Math.max(field.min, reflected) : reflected;
  return typeof field.max === "number" ? Math.min(field.max, lo) : lo;
}

/**
 * Pure function. THE new element for an insert at position `index` of `list`
 * (0 = before the first element, list.length = after the last), built from the
 * declaration's fields.
 *
 *   BETWEEN two elements → every field interpolated at the midpoint
 *                          (betweenFieldValue).
 *   AT EITHER END        → every field extrapolated from the outermost pair
 *                          (extrapolatedFieldValue), which for a bounded key
 *                          clamps to the domain edge.
 *   A ONE-ELEMENT LIST   → a copy of the sole element (nothing to extrapolate
 *                          from, and inventing a step would be a guess).
 *
 * An EMPTY list throws: there is nothing to interpolate from, and the honest
 * answer is for the caller to seed the first element from the property's default
 * rather than have this invent one.
 *
 * Args:
 *   decl (object): the list declaration ({element, order, ...})
 *   list (Array): the current value
 *   index (number): insertion position, 0..list.length
 *
 * Returns:
 *   the new element, in the declaration's storage form
 *
 * @example insertedElement({element: {storage: "record", fields: [{name: "offset", kind: "number", min: 0, max: 1}, {name: "color", kind: "color"}]}, order: "sorted", orderKey: "offset"}, [{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], 1) // {offset: 0.5, color: "#808080"}
 * @example insertedElement({element: {storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}, order: "sequence"}, [[0, 0], [1, 0], [1, 1]], 2) // [1, 0.5] (the midpoint of the edge it splits)
 * @example insertedElement({element: {storage: "record", fields: [{name: "offset", kind: "number", min: 0, max: 1}, {name: "color", kind: "color"}]}, order: "sorted", orderKey: "offset"}, [{offset: 0, color: "#000000"}, {offset: 0.5, color: "#ffffff"}], 2) // {offset: 1, color: "#ffffff"} (extrapolated, clamped to max)
 * @example insertedElement({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}, order: "sequence"}, [[7]], 1) // [7] (a lone element is copied)
 */
export function insertedElement(decl, list, index) {
  const { element } = decl;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`lists.insertedElement: an empty list has no element to interpolate from — seed the first element from the property's default`);
  if (!(Number.isInteger(index) && index >= 0 && index <= list.length))
    throw new Error(`lists.insertedElement: index ${index} is outside 0..${list.length}`);
  if (list.length === 1) return copiedElement(element, list[0]);
  const between = index > 0 && index < list.length;
  // BETWEEN: the two neighbours the new element lands between. AT AN END: the
  // outermost element and the one just inside it, reflected outward.
  const [a, b] = between ? [list[index - 1], list[index]] : index === 0 ? [list[0], list[1]] : [list[list.length - 1], list[list.length - 2]];
  let out = between ? interpolate(a, b, MIDPOINT) : a;
  for (const field of element.fields) {
    const av = elementFieldValue(element, a, field.name);
    const bv = elementFieldValue(element, b, field.name);
    const v = between ? betweenFieldValue(av, bv) : extrapolatedFieldValue(av, bv, field);
    out = withElementFieldValue(element, out, field.name, v);
  }
  return out;
}

/**
 * Pure function. The list's CANONICAL order: a "sorted" list is stably sorted by
 * its orderKey field (ties keep their relative order, so the result is
 * deterministic); a "sequence" list is returned UNCHANGED, by identity, because
 * its order IS its data.
 *
 * This is what makes a sorted list's reordering free — and it is REQUIRED on
 * every write, not merely nice: the render path consumes gradient stop ORDER
 * (see the module header's measured warning), so an unsorted array does not swap
 * two stops, it collapses one.
 *
 * An already-canonical list is returned BY IDENTITY (no copy), so a caller can
 * compare references to see whether anything moved.
 *
 * @example canonicalOrder({order: "sorted", orderKey: "offset", element: {storage: "record", fields: [{name: "offset", kind: "number"}]}}, [{offset: 0.8}, {offset: 0.2}]) // [{offset: 0.2}, {offset: 0.8}]
 * @example canonicalOrder({order: "sequence", element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, [[3], [1]]) // [[3], [1]] (order IS the data)
 */
export function canonicalOrder(decl, list) {
  if (decl.order !== "sorted") return list;
  const { element, orderKey } = decl;
  const keyed = list.map((el, i) => ({ el, i, key: elementFieldValue(element, el, orderKey) }));
  keyed.sort((p, q) => (p.key === q.key ? p.i - q.i : p.key - q.key)); // stable: ties by original index
  return keyed.every((p, i) => p.i === i) ? list : keyed.map((p) => p.el);
}

// ── PER-ELEMENT VISIBILITY (hide) ────────────────────────────────────────────
//
// A LIST VALUE is the pair {list, active}: the elements, and the ALIGNED
// COMPANION flag list (the declaration's `activeKey` sibling state key). `active`
// is optional everywhere — absent, or shorter than the list, means VISIBLE, which
// is what makes every pre-existing document render unchanged. Every operation
// below takes and returns the PAIR, so the two can never be spliced out of step.

/**
 * Pure function. Is element `index` visible? Absent / short / non-false flags all
 * read as VISIBLE — the absent-means-visible rule item `active` already has
 * (core/properties.js PROPS.active: "absent-means-visible must keep working for
 * every existing document"). Only an explicit `false` hides.
 *
 * @example elementActive(undefined, 3) // true (no companion at all)
 * @example elementActive([true, false], 1) // false
 * @example elementActive([true, false], 5) // true (past the companion's end)
 * @example elementActive([null], 0) // true (only an explicit false hides)
 */
export function elementActive(active, index) {
  return active?.[index] !== false;
}

/**
 * Pure function. The LIST VALUE with element `index`'s visibility set — the HIDE
 * operation. Writes ONLY the companion: the element list is returned by identity,
 * so nothing is renumbered and every equation bound to a later element keeps its
 * meaning (the index-stability invariant in the module header). The companion is
 * padded with `true` up to `index` when it was short or absent.
 *
 * The returned companion is always a FULL, list-length array of booleans, so it
 * CANONICALIZES whatever shape it was handed: absent, short, or the numeric-keyed
 * OBJECT a sparse per-index keyframe folds to when no base array existed yet
 * (core/deltas.js setPath documents that encoding). One write and the companion is
 * a well-formed array that later sparse keyframes merge into element-wise.
 *
 * @example withElementActive({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, {list: [[0], [1], [2]]}, 1, false) // {list: [[0], [1], [2]], active: [true, false, true]}
 * @example withElementActive({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, {list: [[0], [1]], active: [true, false]}, 1, true) // {list: [[0], [1]], active: [true, true]}
 * @example withElementActive({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, {list: [[0], [1], [2]], active: {2: false}}, 0, false) // {list: [[0], [1], [2]], active: [false, true, false]}
 */
export function withElementActive(decl, value, index, active) {
  const list = value.list;
  if (!(Number.isInteger(index) && index >= 0 && index < list.length))
    throw new Error(`lists.withElementActive: index ${index} is outside a ${list.length}-element list`);
  return { list, active: list.map((_, i) => (i === index ? active : elementActive(value.active, i))) };
}

/**
 * Pure function. The elements a CONSUMER should read: the visible ones, in order,
 * with the hidden ones simply absent. This is THE "acts like it's not there"
 * primitive — it returns exactly the array a user would have authored by hand, so
 * each consumer's existing semantics do the rest (a gradient ramp spans the
 * surviving stops; a polygon chain closes over the gap) with no special-casing.
 * Returns the input list BY IDENTITY when nothing is hidden, so the common case
 * allocates nothing and byte-identity is checkable by reference. Reads the
 * companion only through elementActive, so it accepts BOTH stored encodings (a
 * flags array, or the numeric-keyed object a sparse keyframe folds to).
 *
 * @example visibleElements({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, {list: [[0], [1], [2]], active: [true, false, true]}) // [[0], [2]]
 * @example visibleElements({element: {storage: "record", fields: [{name: "offset", kind: "number"}]}}, {list: [{offset: 0}, {offset: 0.5}, {offset: 1}], active: [true, false, true]}) // [{offset: 0}, {offset: 1}]
 * @example visibleElements({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, {list: [[0], [1]]}) // [[0], [1]] (no companion: every element visible)
 * @example visibleElements({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, {list: [[0], [1], [2]], active: {1: false}}) // [[0], [2]] (sparse-keyframe encoding)
 */
export function visibleElements(decl, value) {
  if (value.list.every((_, i) => elementActive(value.active, i))) return value.list;
  return value.list.filter((_, i) => elementActive(value.active, i));
}

/**
 * Pure function. The indices of the visible elements — the map from a consumer's
 * position back to the stored element it came from, so a UI can point at the real
 * element behind a filtered one.
 *
 * @example visibleIndices({list: [[0], [1], [2]], active: [true, false, true]}) // [0, 2]
 * @example visibleIndices({list: [[0], [1]]}) // [0, 1]
 */
export function visibleIndices(value) {
  return value.list.map((_, i) => i).filter((i) => elementActive(value.active, i));
}

// ── INSERT / PURGE / REORDER (the RENUMBERING operations) ────────────────────

/**
 * Pure function. The LIST VALUE with a new interpolated element inserted at
 * `index`, canonically ordered, and its companion flag inserted alongside (the
 * new element is visible). For a SEQUENCE this is exactly "insert here"
 * (inserting between elements i and i+1 means index i+1); for a SORTED list the
 * insert position only selects WHICH pair to interpolate — canonicalOrder then
 * places the result, which by construction is already where it was put.
 *
 * RENUMBERS every later element (see the module header's identity invariant).
 *
 * @example withElementInserted({element: {storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}, order: "sequence"}, {list: [[0, 0], [1, 1]]}, 1) // {list: [[0, 0], [0.5, 0.5], [1, 1]], active: undefined}
 * @example withElementInserted({element: {storage: "record", fields: [{name: "offset", kind: "number", min: 0, max: 1}, {name: "color", kind: "color"}]}, order: "sorted", orderKey: "offset"}, {list: [{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}]}, 1).list // [{offset: 0, color: "#000000"}, {offset: 0.5, color: "#808080"}, {offset: 1, color: "#ffffff"}]
 * @example withElementInserted({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}, order: "sequence"}, {list: [[0], [2]], active: [false, true]}, 1) // {list: [[0], [1], [2]], active: [false, true, true]}
 */
export function withElementInserted(decl, value, index) {
  const el = insertedElement(decl, value.list, index);
  const list = canonicalOrder(decl, [...value.list.slice(0, index), el, ...value.list.slice(index)]);
  if (!value.active) return { list, active: undefined };
  return { list, active: [...value.active.slice(0, index), true, ...value.active.slice(index)] };
}

/**
 * Pure function. The LIST VALUE with element `index` PURGED — spliced out of the
 * array, along with its companion flag. This is the DESTRUCTIVE operation (the
 * per-row X affordance); HIDE is withElementActive and moves nothing.
 *
 * Refuses to drop below the declaration's `minLength` (a gradient needs two stops
 * — render_gpu/ir.js normalizeStops throws below that) and refuses an
 * out-of-range index: both are caller bugs, not values to silently ignore.
 *
 * RENUMBERS every later element (see the module header's identity invariant):
 * an equation bound to a later element's field comes to mean its neighbour, so a
 * caller that cares must remap through indexAfterPurge.
 *
 * @example withElementPurged({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}, order: "sequence"}, {list: [[0], [1], [2]]}, 1) // {list: [[0], [2]], active: undefined}
 * @example withElementPurged({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}, order: "sequence"}, {list: [[0], [1], [2]], active: [true, false, true]}, 0) // {list: [[1], [2]], active: [false, true]}
 * @example // withElementPurged({...minLength: 2}, {list: [{offset: 0}, {offset: 1}]}, 0)
 * @example // → throws: purging element 0 would leave 1 element, below the declared minimum of 2
 */
export function withElementPurged(decl, value, index) {
  const { list } = value;
  if (!(Number.isInteger(index) && index >= 0 && index < list.length))
    throw new Error(`lists.withElementPurged: index ${index} is outside a ${list.length}-element list`);
  const floor = decl.minLength ?? 0;
  if (list.length - 1 < floor)
    throw new Error(`lists.withElementPurged: purging element ${index} would leave ${list.length - 1} element${list.length === 2 ? "" : "s"}, below the declared minimum of ${floor}`);
  return {
    list: list.filter((_, i) => i !== index),
    active: value.active ? value.active.filter((_, i) => i !== index) : undefined,
  };
}

/**
 * Pure function. The LIST VALUE reordered so its elements ascend by `keys` — the
 * PAIR-level counterpart of canonicalOrder, which sorts the element list ALONE
 * and leaves the visibility companion where it was. Stable (equal keys keep their
 * relative order), and the input is returned BY IDENTITY when it is already in
 * that order, so "did anything move" is a reference compare.
 *
 * `indices[i]` is where the element that WAS at i ended up — the reorder's member
 * of the indexAfterPurge / indexAfterInsert family. It comes back with the result
 * rather than being a function of an index, because a reorder's remap depends on
 * the VALUES: a caller that is mid-gesture (a gradient stop being DRAGGED along
 * its bar) has to keep pointing at the element it is moving as that element
 * changes address underneath it.
 *
 * WHY THE KEYS ARE SUPPLIED rather than read off the elements the way
 * canonicalOrder reads them — this is the whole reason the function exists:
 * an element's order key MAY BE AN "=" EQUATION, which is a string and has no
 * ordering, while the order the RENDER consumes is the one the EVALUATED
 * positions describe (a stop's offset can be bound, and render_gpu/ir.js
 * normalizeStops reads the array's order as authoritative). What must be written
 * BACK is the RAW element with its expression intact. Sorting by supplied
 * EVALUATED keys while permuting RAW elements is the only combination that
 * satisfies both, and no version that reads the key off the element can express
 * it.
 *
 * Args:
 *   value ({list: Array, active?: Array}): the list value pair
 *   keys (number[]): one sort key per element, in the list's CURRENT order
 *
 * Returns:
 *   {list, active, indices} — the reordered pair plus the old→new index map
 *
 * @example withElementsOrderedBy({list: [{offset: 0.8}, {offset: 0.2}]}, [0.8, 0.2]).list // [{offset: 0.2}, {offset: 0.8}]
 * @example withElementsOrderedBy({list: [{offset: 0.8}, {offset: 0.2}]}, [0.8, 0.2]).indices // [1, 0]
 * @example withElementsOrderedBy({list: [{offset: 0}, {offset: 1}]}, [0, 1]).indices // [0, 1] (already ordered)
 * @example withElementsOrderedBy({list: [{offset: 0.7}, {offset: 0.5}], active: [false, true]}, [0.7, 0.5]).active // [true, false] (the companion follows its own element)
 * @example withElementsOrderedBy({list: [{offset: "=t"}, {offset: 0.1}]}, [0.9, 0.1]).list // [{offset: 0.1}, {offset: "=t"}] (RAW elements permuted, ordered by the SUPPLIED evaluated keys)
 * @example withElementsOrderedBy({list: [{offset: 0.5}, {offset: 0.5}]}, [0.5, 0.5]).indices // [0, 1] (a tie is stable: nothing moves)
 */
export function withElementsOrderedBy(value, keys) {
  const { list, active } = value;
  if (keys.length !== list.length)
    throw new Error(`lists.withElementsOrderedBy: ${keys.length} sort keys for a ${list.length}-element list`);
  const order = list.map((_, i) => i).sort((a, b) => (keys[a] === keys[b] ? a - b : keys[a] - keys[b]));
  const indices = [];
  for (let at = 0; at < order.length; at++) indices[order[at]] = at;
  if (order.every((from, at) => from === at)) return { list, active, indices };
  // The companion is read through elementActive, so BOTH stored encodings permute
  // correctly — a flags array and the numeric-keyed object a sparse per-index
  // keyframe folds to (core/deltas.js setPath) — and the result canonicalizes to
  // a full array, exactly as withElementActive's does.
  return {
    list: order.map((from) => list[from]),
    active: active ? order.map((from) => elementActive(active, from)) : undefined,
    indices,
  };
}

/**
 * Pure function. Where element `index` ends up after element `purgedIndex` is
 * purged, or null when `index` IS the purged element (it no longer exists). The
 * remap a document-wide equation rewrite needs, since purge renumbers.
 *
 * @example indexAfterPurge(5, 2) // 4
 * @example indexAfterPurge(1, 2) // 1 (before the purge: unmoved)
 * @example indexAfterPurge(2, 2) // null (that element is gone)
 */
export function indexAfterPurge(index, purgedIndex) {
  if (index === purgedIndex) return null;
  return index > purgedIndex ? index - 1 : index;
}

/**
 * Pure function. Where element `index` ends up after a new element is inserted at
 * `insertedIndex`. The counterpart of indexAfterPurge (insert renumbers too).
 *
 * @example indexAfterInsert(5, 2) // 6
 * @example indexAfterInsert(1, 2) // 1 (before the insert: unmoved)
 * @example indexAfterInsert(2, 2) // 3 (the element the new one displaced)
 */
export function indexAfterInsert(index, insertedIndex) {
  return index >= insertedIndex ? index + 1 : index;
}

/**
 * Pure function. The STORAGE path for a path BELOW a list key — the ONE place a
 * named field becomes a positional index. `relPath` is [] (the list itself),
 * [index] (one element) or [index, fieldName]. Throws on an undeclared field
 * name (a typo addresses nothing, loudly).
 *
 * @example listStoragePath({element: {storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}}, [3, "y"]) // [3, 1]
 * @example listStoragePath({element: {storage: "record", fields: [{name: "offset", kind: "number"}]}}, [2, "offset"]) // [2, "offset"]
 * @example listStoragePath({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, [3]) // [3]
 * @example listStoragePath({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, []) // []
 */
export function listStoragePath(decl, relPath) {
  if (relPath.length < 2) return relPath;
  const [index, fieldName, ...rest] = relPath;
  return [index, elementStorageKey(decl.element, fieldName), ...rest];
}

/**
 * Pure function. The LOGICAL (named-field) path for a STORAGE path below a list
 * key — the inverse of listStoragePath, for showing a slot's canonical address
 * (the Inspector's copy-path affordance). An undeclared storage key is returned
 * verbatim: this is a display conversion, and inventing a name would hide the
 * mismatch that the kind lookup reports loudly.
 *
 * @example listLogicalPath({element: {storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}}, [3, 1]) // [3, "y"]
 * @example listLogicalPath({element: {storage: "record", fields: [{name: "offset", kind: "number"}]}}, [2, "offset"]) // [2, "offset"]
 * @example listLogicalPath({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, [3, 9]) // [3, 9] (undeclared: verbatim)
 */
export function listLogicalPath(decl, relStoragePath) {
  if (relStoragePath.length < 2) return relStoragePath;
  const [index, storageKey, ...rest] = relStoragePath;
  return [index, elementFieldNameAt(decl.element, storageKey) ?? storageKey, ...rest];
}

/**
 * Pure function. The equation RESULT KIND for a path BELOW a list key, or null
 * when the path addresses nothing typed:
 *   []                    → "list"          (the whole value — bindable by
 *                                            reference, e.g. `= other.points`)
 *   [index, field]        → the field's declared kind
 *   [index]               → null            (a whole ELEMENT has no declared
 *                                            kind of its own; its fields do)
 * The field segment may be spelled either as the declared NAME or as the raw
 * STORAGE key, because asking "what type lives here" is not an addressing
 * decision — a walk over stored state produces the storage spelling, a row
 * produces the name, and both must answer the same. Addressing itself has ONE
 * canonical spelling (listStoragePath).
 *
 * INDEX-INDEPENDENT BY CONSTRUCTION: the answer comes from the DECLARATION, not
 * from whatever the plugin's default list happens to contain, so element 9 of a
 * five-element default types exactly like element 0. That is the difference
 * between a declared list and the old accidental typing (isNumericSlot reading
 * plugin.defaults, which ran out of elements and fell to UNRESOLVED).
 *
 * @example listPathKind({element: {storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}}, []) // "list"
 * @example listPathKind({element: {storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}}, [3, "y"]) // "number"
 * @example listPathKind({element: {storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}}, [3, 1]) // "number" (storage spelling)
 * @example listPathKind({element: {storage: "record", fields: [{name: "offset", kind: "number"}, {name: "color", kind: "color"}]}}, [0, "color"]) // "color"
 * @example listPathKind({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, [3]) // null (a whole element is not a slot)
 * @example listPathKind({element: {storage: "record", fields: [{name: "offset", kind: "number"}]}}, [0, "nope"]) // null
 */
export function listPathKind(decl, relPath) {
  if (relPath.length === 0) return "list";
  if (relPath.length !== 2) return null;
  // Either spelling: the declared field NAME first (what a row / a canonical
  // address uses), then the raw STORAGE key (what a walk over stored state
  // produces — index 0 of a tuple). A record element's name IS its storage key,
  // so the two branches coincide there.
  const named = elementFieldKind(decl.element, relPath[1]);
  if (named !== null) return named;
  const name = elementFieldNameAt(decl.element, relPath[1]);
  return name === null ? null : elementFieldKind(decl.element, name);
}

/**
 * Pure function. The state path of a list's VISIBILITY COMPANION — the sibling
 * key beside the list itself. `listPath` is the list's own path.
 *
 * @example activeListPath({activeKey: "pointsActive"}, ["points"]) // ["pointsActive"]
 * @example activeListPath({activeKey: "stopsActive"}, ["fill", "linear", "stops"]) // ["fill", "linear", "stopsActive"]
 */
export function activeListPath(decl, listPath) {
  return [...listPath.slice(0, -1), decl.activeKey];
}

/**
 * Pure function. Every addressable SLOT of a concrete list value: per element,
 * the universal VISIBILITY flag first (ACTIVE_FIELD — the row's hide toggle,
 * leading the way item `active` leads an item's rows), then one entry per declared
 * field in declaration order. `prefix` is the state path of the list itself, so
 * `path` is ready to hand to a keyframe / equation field.
 *
 * The visibility slot's path points into the COMPANION list (activeListPath), not
 * into the element — which is also why its `address` is the companion's own
 * dotted path rather than a `<list>.<i>.active` spelling that does not exist in
 * storage. Every OTHER slot's `address` is the canonical named-field form
 * (`points.3.x`), whose storage translation is listStoragePath's job.
 *
 * Because every entry is a plain state path, per-element visibility is
 * KEYFRAMABLE exactly like any other leaf — hiding a stop on one slide and not
 * the next needs no extra machinery, it is a boolean keyframe on a path.
 *
 * This is the type-level-vs-instance-level split: the list ROOT is declared and
 * so can be offered by the type-level equation autocomplete, but per-ELEMENT
 * paths exist only for the value a particular item holds right now (a 3-vertex
 * polygon has no `points.4.x`), so they are enumerated HERE, from the value.
 *
 * Args:
 *   decl (object): the list declaration
 *   list (Array): the current element list
 *   prefix (Array): the list's own state path (default [])
 *
 * Returns:
 *   [{index, field, kind, path, address}] — path in STORAGE form
 *
 * @example listSlotPaths({activeKey: "pointsActive", element: {storage: "tuple", fields: [{name: "x", kind: "number"}, {name: "y", kind: "number"}]}}, [[0, 1]], ["points"]) // [{index: 0, field: "active", kind: "boolean", path: ["pointsActive", 0], address: "pointsActive.0"}, {index: 0, field: "x", kind: "number", path: ["points", 0, 0], address: "points.0.x"}, {index: 0, field: "y", kind: "number", path: ["points", 0, 1], address: "points.0.y"}]
 * @example listSlotPaths({activeKey: "stopsActive", element: {storage: "record", fields: [{name: "offset", kind: "number"}]}}, [{offset: 0}, {offset: 1}], ["fill", "linear", "stops"]).map((s) => s.address) // ["fill.linear.stopsActive.0", "fill.linear.stops.0.offset", "fill.linear.stopsActive.1", "fill.linear.stops.1.offset"]
 */
export function listSlotPaths(decl, list, prefix = []) {
  const activePath = activeListPath(decl, prefix);
  const out = [];
  for (let index = 0; index < list.length; index++) {
    out.push({
      index,
      field: ACTIVE_FIELD.name,
      kind: ACTIVE_FIELD.kind,
      path: [...activePath, index],
      address: [...activePath, index].join("."),
    });
    for (const field of decl.element.fields)
      out.push({
        index,
        field: field.name,
        kind: field.kind,
        path: [...prefix, index, elementStorageKey(decl.element, field.name)],
        address: [...prefix, index, field.name].join("."),
      });
  }
  return out;
}
