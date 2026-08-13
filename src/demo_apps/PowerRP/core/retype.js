/**
 * RETYPING A WIDGET — turning an existing item into a different widget TYPE
 * without destroying and recreating it, so its id, its name, its z, its
 * keyframes on other slides and every equation that references it survive.
 *
 * `type` is an ordinary delta-written field. Folding treats it as a discrete
 * leaf (core/document.js blendApplied), and core/derive.js looks the plugin up
 * per fold with `registry.get(itemState.type)`. So the WRITE is one keyframe.
 * Everything in this file exists because that one keyframe is not enough.
 *
 * ── WHY A BARE TYPE WRITE IS NOT ENOUGH ─────────────────────────────────────
 * A plugin's `defaults` are materialized into a document at exactly ONE place:
 * the load boundary (core/document.js withMissingDefaultsFilled, called only by
 * repairedDocument). They are NEVER merged at fold, derive or emit time — a
 * plugin's emit() reads the folded bag directly and trusts that every key it
 * declares is present, because insert put them there. Retype breaks that
 * assumption: the old type's bag has none of the new type's own keys, so the new
 * plugin's emit() meets `undefined` where it declared a number.
 *
 * MEASURED over all 8190 ordered pairs of the 91 RETYPE-ELIGIBLE types
 * (tests/retype_sweep_test.js, which sweeps the menu's own space): filling the
 * new type's defaults for absent keys — what this module does — leaves the
 * overwhelming majority drawing cleanly, a small tail red-boxed, and ZERO
 * escaping the emit containment.
 *
 * ONLY THE ZERO IS ASSERTED, deliberately. The red-box count is a fact about the
 * WIDGETS, not about this module: it moved 133 -> 43 in one afternoon while other
 * work hardened individual plugins, without a line of retype.js changing. Pinning
 * it here would make this file wrong every time someone else fixed a widget, and
 * pinning it in the test would fail the gate for an IMPROVEMENT. The invariant
 * that belongs to retype is that nothing THROWS — a pair that escapes containment
 * is a ports.js bug the sweep must catch.
 *
 * The tail is rule 2 working as designed (see below): a shared key whose KIND
 * agrees but whose VALUE the new type rejects rides along and red-boxes with the
 * reason on it, one undo away.
 *
 * ── THE THREE RULES (user ruling, verbatim) ─────────────────────────────────
 * "It's okay if they share keys, just let it be. Live and let live. If they
 * share keys, then they'll share values from those keys. If those types are not
 * viable, then they'll be coerced to the default — like string vs float — upon
 * selecting the new object type."
 *
 *   1. FILL LIKE INSERT. Every key the new type declares and the item does not
 *      hold gets the new type's default. See `retypeFilledPaths`.
 *   2. KIND-COMPATIBLE CARRY. A key BOTH types declare keeps its stored value
 *      when the two types' row kinds agree; on a kind MISMATCH it is coerced to
 *      the new type's default. See `carryVerdict` and the table in its docs.
 *   3. DORMANT KEYS PRESERVED. A key only the OLD type declared is left in the
 *      bag untouched. Repair only ever ADDS (missingDefaults iterates the
 *      plugin's defaults and never prunes surplus keys), so a surplus key costs
 *      nothing and a retype round-trip LOSES NO VALUE: circle → rect → circle
 *      returns every key the circle held, holding what it held.
 *      Note the round trip is not key-for-key IDENTICAL, and must not be: the
 *      rect leg fills rect's own keys, so `cornerRadius` comes home as a dormant
 *      surplus sitting at its default. Nothing reads it while the item is a
 *      circle and repair will not prune it. tests/retype_test.js asserts the
 *      no-value-lost property and spells out why the stricter one is wrong.
 *
 * Rules 2 and 3 together are why a KIND-LEGAL BUT VALUE-HOSTILE survivor is
 * carried rather than reset: svg's `fill: {type: "none"}` is a legal paint for
 * svg and rejected by mermaid, but both declare `fill` as a paint row, so the
 * kinds agree and the value rides along. That is deliberate — the item red-boxes
 * with the reason written on it, one undo away, which is a better answer than
 * silently discarding a value the user chose. Those pairs are exactly the
 * documented residual set the sweep test pins.
 */

import { keyframed } from "./document.js";
import { getPath } from "./deltas.js";
import { RETIRED_ROW_KINDS } from "./properties.js";

/**
 * Pure function. The CANONICAL row kind for an inspector row: a retired
 * spelling resolves to its replacement, so two plugins that spell the same
 * control differently still compare EQUAL. Mirrors web/Inspector.svelte's own
 * rowKind — both read the one alias table in core/properties.js.
 *
 * @param {object} row - an inspector row ({key, kind, ...})
 * @returns {string} the canonical kind
 *
 * @example canonicalRowKind({kind: "number"})
 * 'number'
 * @example canonicalRowKind({kind: "checkbox"})
 * 'boolean'
 */
export function canonicalRowKind(row) {
  return RETIRED_ROW_KINDS[row.kind] ?? row.kind;
}

/**
 * Pure function. A plugin's inspector rows indexed by their stored KEY, with
 * retired kind spellings already canonicalized.
 *
 * A plugin may declare the same key twice (a bundle composed over a plugin's own
 * row); the FIRST wins, matching the Inspector, which renders rows in declaration
 * order and lets the first control for a key own it.
 *
 * @param {object} plugin - a registered plugin
 * @returns {Map<string, object>} key → row
 *
 * @example rowsByKey({inspector: [{key: "w", kind: "number"}, {key: "shape", kind: "select", options: ["star"]}]}).get("shape").kind
 * 'select'
 * @example rowsByKey({}).size
 * 0
 */
export function rowsByKey(plugin) {
  const out = new Map();
  for (const row of plugin.inspector ?? [])
    if (row.key != null && !out.has(row.key)) out.set(row.key, { ...row, kind: canonicalRowKind(row) });
  return out;
}

/**
 * Pure function. Whether a stored value under a SELECT row is one of that row's
 * offered options. A select's options list IS its type — an option the new type
 * does not offer is as wrong as a string in a number slot.
 *
 * @param {object} row - a select row (reads .options)
 * @param {*} value - the stored value
 * @returns {boolean}
 *
 * @example selectOptionOffered({options: ["star", "heart"]}, "star")
 * true
 * @example selectOptionOffered({options: ["star", "heart"]}, "gear")
 * false
 * @example selectOptionOffered({options: [{value: "a"}, {value: "b"}]}, "b")
 * true
 */
export function selectOptionOffered(row, value) {
  const options = row.options ?? [];
  return options.some((o) => (o != null && typeof o === "object" ? o.value : o) === value);
}

/**
 * Pure function. THE CARRY DECISION for one key both types declare: does the
 * stored value ride along, or is it reset to the new type's default?
 *
 * ── THE KIND-COERCION TABLE ─────────────────────────────────────────────────
 *   old kind === new kind, non-select    → "carry"  (values of one kind are
 *                                          interchangeable by construction —
 *                                          a number is a number)
 *   old kind === new kind === "select",  → "carry"
 *     stored value IS offered
 *   old kind === new kind === "select",  → "reset"  (the option does not exist
 *     stored value NOT offered                      on the new type; a select's
 *                                                   options list IS its type)
 *   old kind !== new kind                → "reset"  (string vs float, the user's
 *                                                   own example)
 *   the OLD type declares no row for it  → "carry"  (nothing to disagree with:
 *                                                   the value came from the old
 *                                                   type's plain defaults, and
 *                                                   the new type's row will edit
 *                                                   it as its own kind)
 *
 * An EQUATION value ("= …") carries under exactly the same rules: an equation is
 * a way of PRODUCING a value of the row's kind, not a kind of its own, and
 * core/expressions.js already validates the result against the slot. Resetting
 * one on a kind mismatch is right for the same reason a literal is reset.
 *
 * @param {object|undefined} oldRow - the old type's row for this key (or undefined)
 * @param {object} newRow - the new type's row for this key
 * @param {*} value - the stored value
 * @returns {"carry"|"reset"}
 *
 * @example carryVerdict({kind: "number"}, {kind: "number"}, 12)
 * 'carry'
 * @example carryVerdict({kind: "text"}, {kind: "number"}, "hello")
 * 'reset'
 * @example carryVerdict({kind: "select", options: ["a"]}, {kind: "select", options: ["a", "b"]}, "a")
 * 'carry'
 * @example carryVerdict({kind: "select", options: ["a", "z"]}, {kind: "select", options: ["a", "b"]}, "z")
 * 'reset'
 * @example carryVerdict(undefined, {kind: "number"}, 3)
 * 'carry'
 */
export function carryVerdict(oldRow, newRow, value) {
  if (!oldRow) return "carry";
  if (oldRow.kind !== newRow.kind) return "reset";
  if (newRow.kind === "select" && !selectOptionOffered(newRow, value)) return "reset";
  return "carry";
}

/**
 * Pure function. Every leaf of a plugin's `defaults` as [dottedPathSegments, value].
 * A nested plain object recurses; an ARRAY is a leaf (a list property's default
 * IS the whole list — core/lists.js owns element-level edits, and splitting one
 * into per-index paths would keyframe a length this document may not have).
 *
 * @param {object} obj - the defaults object
 * @param {string[]} prefix - accumulated path (recursion)
 * @returns {Array<[string[], *]>}
 *
 * @example defaultLeaves({w: 10, shadow: {blur: 2}})
 * [ [ [ 'w' ], 10 ], [ [ 'shadow', 'blur' ], 2 ] ]
 * @example defaultLeaves({stops: [{offset: 0}]})
 * [ [ [ 'stops' ], [ { offset: 0 } ] ] ]
 */
export function defaultLeaves(obj, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v != null && typeof v === "object" && !Array.isArray(v)) out.push(...defaultLeaves(v, [...prefix, k]));
    else out.push([[...prefix, k], v]);
  }
  return out;
}

/**
 * Pure function. THE PLAN for retyping one item: which default paths get written
 * and why. Split out from the write so the decision is testable without a
 * document, and so the UI could explain a retype before performing it.
 *
 * A path is written when EITHER
 *   - the item does not hold it at all (RULE 1: fill like insert), or
 *   - the item holds it but the two types' row kinds disagree (RULE 2: coerce).
 * A path the item holds under an agreeing kind is absent from the plan (carried),
 * and so is every key only the old type declared (RULE 3: dormant, untouched).
 *
 * @param {object} folded - the item's FOLDED state on the target slide
 * @param {object} oldPlugin - the plugin the item is today
 * @param {object} newPlugin - the plugin it is becoming
 * @returns {Array<{path: string[], value: *, why: "fill"|"coerce"}>}
 *
 * @example // a rect becoming a widget that declares a `sides` count it lacks:
 * retypePlan({type: "rect", w: 10}, {inspector: []}, {defaults: {type: "poly", sides: 5}, inspector: []})
 * [ { path: [ 'sides' ], value: 5, why: 'fill' } ]
 * @example // a shared key whose kinds AGREE is carried — nothing planned:
 * retypePlan({label: "hi"}, {inspector: [{key: "label", kind: "text"}]}, {defaults: {label: "x"}, inspector: [{key: "label", kind: "text"}]})
 * []
 * @example // the same key when the kinds DISAGREE is coerced to the new default:
 * retypePlan({label: "hi"}, {inspector: [{key: "label", kind: "text"}]}, {defaults: {label: 0}, inspector: [{key: "label", kind: "number"}]})
 * [ { path: [ 'label' ], value: 0, why: 'coerce' } ]
 */
export function retypePlan(folded, oldPlugin, newPlugin) {
  const oldRows = rowsByKey(oldPlugin);
  const newRows = rowsByKey(newPlugin);
  const plan = [];
  for (const [path, value] of defaultLeaves(newPlugin.defaults)) {
    // `type` is the retype itself, written by the caller — never a fill.
    if (path[0] === "type") continue;
    const key = path.join(".");
    const held = getPath(folded, path);
    // RULE 1 — FILL LIKE INSERT. Absent means the item never had this key, so it
    // gets the new type's default exactly as a fresh insert would.
    //
    // WHY SELF.-EQUATION DEFAULTS ARE FILLED HERE and skipped by the migration
    // backfill at core/document.js withMissingDefaultsFilled: that rule is about
    // MIGRATION — it refuses to materialize a computed default into a document
    // that predates it, because the derivation stage supplies the same value as a
    // fallback and writing it would rewrite every old document on load. RETYPE IS
    // NOT MIGRATION. It is INSERT, applied to an item that already exists: the
    // user is choosing this widget now, and insert writes a widget's whole
    // declared bag including its self.-equations. Skipping them here would leave
    // a retyped widget missing exactly the geometry-derived defaults (a lens
    // flare's light position, god rays' source) that make it look like itself.
    if (held === undefined) { plan.push({ path, value, why: "fill" }); continue; }
    // RULE 2 — KIND-COMPATIBLE CARRY, else coerce to the new default.
    const newRow = newRows.get(key);
    if (newRow && carryVerdict(oldRows.get(key), newRow, held) === "reset")
      plan.push({ path, value, why: "coerce" });
    // Otherwise: carried. RULE 3 (keys only the old type declares) needs no
    // branch at all — this loop only visits the NEW type's declared paths, so a
    // dormant key is never considered and never touched.
  }
  return plan;
}

/**
 * Pure function. THE RETYPE WRITE: the document with `itemId` retyped to
 * `newType` on slide `slideIndex`, defaults filled and hostile-kind values
 * coerced. ONE undo unit is the caller's business (web/app.svelte.js wraps this
 * in a single history entry) — this returns one document, however many keyframes
 * it took to build it.
 *
 * Loud when the item does not exist on this fold or either type is unregistered
 * (registry.get throws): a retype of nothing is a caller bug, not a user error.
 *
 * @param {object} doc - the document
 * @param {number} slideIndex - the slide whose delta receives the keyframes
 * @param {string} itemId - the item to retype
 * @param {string} newType - the type it becomes
 * @param {object} folded - the item's FOLDED state on that slide
 * @param {object} registry - the plugin registry
 * @returns {object} the new document
 *
 * @example // #  const doc2 = retypedItem(doc, 0, "ab12", "circle", foldState(doc, 0).items.ab12, registry);
 * @example // #  foldState(doc2, 0).items.ab12.type  →  "circle"
 */
export function retypedItem(doc, slideIndex, itemId, newType, folded, registry) {
  if (!folded || typeof folded.type !== "string")
    throw new Error(`retypedItem: item "${itemId}" has no folded type on slide ${slideIndex} — nothing to retype`);
  const oldPlugin = registry.get(folded.type);
  const newPlugin = registry.get(newType);
  let out = keyframed(doc, slideIndex, ["items", itemId, "type"], newType);
  for (const { path, value } of retypePlan(folded, oldPlugin, newPlugin))
    out = keyframed(out, slideIndex, ["items", itemId, ...path], value);
  return out;
}

/**
 * Pure function. THE EXCLUSION PREDICATE — may this type be OFFERED as a retype
 * target (and may an item of this type be retyped at all)? A PREDICATE over
 * declared capabilities rather than a hand list, so a new widget joins or is
 * kept out of the menu by what it declares.
 *
 * Four declared marks exclude a type, each for its own structural reason. Every
 * one of them is a mark the plugin ALREADY declares for another purpose — none
 * was invented for this menu, which is what makes the predicate a fact about the
 * widget rather than a restatement of a list:
 *
 *   `capabilities.purgeable === false` — THE CAMERA. Exactly one exists, it owns
 *     the background and every view, and it cannot be deleted. A type the
 *     document structurally requires cannot become something else, and nothing
 *     else may become a second one.
 *
 *   `foldsSubtree` — A GROUP. It is a derivation PARENT, not a drawing: its
 *     members name it by id, so retyping it would orphan them, and retyping
 *     something INTO one would invent a parent with no membership. This hook IS
 *     the declaration "my emit() consumes a subtree of other nodes"
 *     (core/registry.js, render_gpu/ports.js emitNode's arg-2 seam).
 *
 *   `capabilities.ghost` without `foldsSubtree` — SCENE-STRUCTURAL / CHROME. A
 *     ghost has NO RENDERED VOLUME OF ITS OWN (core/registry.js:226): a crop box
 *     draws its TARGET's content and needs that resolved target at derive time,
 *     and an anchor point is editor chrome that draws nothing. Neither has a
 *     picture a stored bag could be carried into. A group is also a ghost, which
 *     is why this clause is written `ghost && !foldsSubtree` — the same
 *     distinction core/registry.js effectsInjectable already draws.
 *
 *   `capabilities.metaball` — A METABALL, whose emit() needs the SCENE
 *     COLLECTION of its sibling metaballs, not just its own state.
 *
 * Over the live 96-type roster this excludes exactly five: camera, group,
 * cropbox, empty, metaball. tests/retype_test.js pins that set against the
 * roster, so a new scene-structural type cannot silently join the menu.
 *
 * @param {object} plugin - a registered plugin
 * @returns {boolean} true when the type may be a retype source or target
 *
 * @example retypeEligible({type: "rect", capabilities: {bbox: true}})
 * true
 * @example retypeEligible({type: "camera", capabilities: {purgeable: false}})
 * false
 * @example retypeEligible({type: "group", capabilities: {ghost: true}, foldsSubtree: () => true})
 * false
 * @example retypeEligible({type: "cropbox", capabilities: {ghost: true}})
 * false
 * @example retypeEligible({type: "metaball", capabilities: {metaball: true}})
 * false
 */
export function retypeEligible(plugin) {
  const c = plugin.capabilities ?? {};
  if (c.purgeable === false) return false;
  if (plugin.foldsSubtree) return false;
  if (c.ghost) return false; // a group is a ghost too, but foldsSubtree already refused it above
  if (c.metaball) return false;
  return true;
}

/**
 * Pure function. A stored value rendered for a WARNING BULLET — short enough to
 * sit on one tooltip line, and honest about what it is.
 *
 * A paint/object shows its `type` discriminator rather than its whole JSON,
 * because "solid" is what the user recognizes and `{"type":"solid","color":…}`
 * is not readable at tooltip width. A long string is elided in the MIDDLE-END so
 * the beginning — the part that identifies it — survives.
 *
 * @param {*} value - the stored value
 * @param {number} limit - max characters before eliding
 * @returns {string}
 *
 * @example coercionValueText(12)
 * '12'
 * @example coercionValueText("hello")
 * '"hello"'
 * @example coercionValueText({type: "solid", color: "#ff0000"})
 * 'solid'
 * @example coercionValueText("= sin(time) * 40")
 * '"= sin(time) * 40"'
 * @example coercionValueText("abcdefghij", 6)
 * '"abcdef…"'
 * @example coercionValueText([1, 2, 3])
 * '3 items'
 */
export function coercionValueText(value, limit = 24) {
  if (Array.isArray(value)) return `${value.length} items`;
  if (value != null && typeof value === "object") return typeof value.type === "string" ? value.type : "…";
  if (typeof value !== "string") return String(value);
  return value.length > limit ? `"${value.slice(0, limit)}…"` : `"${value}"`;
}

/**
 * Pure function. THE COERCION PREVIEW for one candidate target type: exactly
 * which of this item's properties would LOSE their stored value, from what to
 * what. Empty when nothing would be coerced.
 *
 * THIS IS THE ONE FUNCTION THE MENU AND THE COMMAND SHARE. Both read `retypePlan`
 * and both keep only its `why === "coerce"` entries, so the warning the tooltip
 * shows and the write the command performs cannot disagree — a second
 * hand-written kind check in the UI is exactly how a "no warning" menu entry
 * would come to silently discard a value. Fills (`why === "fill"`) are NOT
 * coercions and are deliberately absent: filling an absent key takes nothing
 * away, so warning about it would cry wolf on every retype.
 *
 * @param {object} folded - the item's FOLDED state on the target slide
 * @param {object} oldPlugin - the plugin the item is today
 * @param {object} newPlugin - the plugin it would become
 * @returns {Array<{key: string, label: string, from: string, to: string}>}
 *
 * @example // a text label becoming a numeric one: the string cannot survive
 * coercionPreview(
 *   {label: "hi"},
 *   {inspector: [{key: "label", kind: "text", label: "Label"}]},
 *   {defaults: {label: 0}, inspector: [{key: "label", kind: "number", label: "Label"}]})
 * [ { key: 'label', label: 'Label', from: '"hi"', to: '0' } ]
 * @example // kinds agree — nothing is coerced, so no warning
 * coercionPreview(
 *   {label: "hi"},
 *   {inspector: [{key: "label", kind: "text"}]},
 *   {defaults: {label: "x"}, inspector: [{key: "label", kind: "text"}]})
 * []
 */
export function coercionPreview(folded, oldPlugin, newPlugin) {
  const newRows = rowsByKey(newPlugin);
  return retypePlan(folded, oldPlugin, newPlugin)
    .filter((p) => p.why === "coerce")
    .map(({ path, value }) => {
      const key = path.join(".");
      return {
        key,
        label: newRows.get(key)?.label ?? key,
        from: coercionValueText(getPath(folded, path)),
        to: coercionValueText(value),
      };
    });
}

/**
 * Query. THE RETYPE MENU for one item: every eligible type, each carrying the
 * coercion preview computed against THIS item's live state, ordered CLEAN FIRST
 * and COERCING LAST.
 *
 * Empty when the item's OWN type is ineligible — the camera's header stays plain
 * text, because offering a menu that refuses every choice is a lie.
 *
 * The order is the user's ruling ("highlighting it red in the dropdown and
 * putting them at the very bottom"), and it is a STABLE PARTITION: within each
 * half the roster's registration order survives, so a menu does not reshuffle
 * itself as an item's values change — only the clean/coercing boundary moves.
 * The CURRENT type sorts with the clean half regardless (retyping to what you
 * already are coerces nothing, since every shared key trivially agrees with
 * itself).
 *
 * @param {object} registry - the plugin registry
 * @param {object} folded - the item's FOLDED state (drives the previews)
 * @returns {Array<{value: string, label: string, coercions: Array<object>}>}
 *
 * @example // #  retypeChoices(registry, foldState(doc, 0).items.ab12)
 * @example // #  → [{value: "rect", label: "Rectangle", coercions: []},        ← clean, top
 * @example // #     …,
 * @example // #     {value: "mermaid", label: "Mermaid", coercions: [          ← coercing, bottom
 * @example // #       {key: "shape", label: "Shape", from: '"star"', to: '"box"'}]}]
 * @example // #  retypeChoices(registry, {type: "camera", …})  →  []  (not retypeable)
 */
export function retypeChoices(registry, folded) {
  const oldPlugin = registry.get(folded?.type);
  if (!retypeEligible(oldPlugin)) return [];
  const rows = registry
    .all()
    .filter(retypeEligible)
    .map((p) => ({ value: p.type, label: p.title, coercions: coercionPreview(folded, oldPlugin, p) }));
  // Stable partition — Array.prototype.sort IS stable per spec, so registration
  // order survives inside each half.
  return rows.sort((a, b) => (a.coercions.length === 0 ? 0 : 1) - (b.coercions.length === 0 ? 0 : 1));
}

/**
 * Query. THE RETYPE MENU FOR A SET (WORKSTREAM BT — user, 2026-08-03: "Just do it
 * to them all individually, then change what we see in the properties").
 *
 * Every eligible target type, ordered clean-first exactly as the single-item menu
 * is, but ordered by HOW MANY of the selected items would lose a value rather than
 * by one item's coercion list. The per-item plans are genuinely different — that
 * was the true half of the refusal this replaces — so the menu reports the COUNT
 * and lets each item's own plan do the work at write time.
 *
 * WHY A COUNT AND NOT A MERGED LIST. A merged list would either be the PRIMARY's
 * (presented as if it were everyone's — the exact lie the old refusal was right to
 * avoid) or a union of N lists keyed by property name, which reads as "these
 * properties will be coerced" when in truth each one is coerced on a different
 * subset of the items. "3 of 4 selected items would lose a value" is the sentence
 * that is true of the SET, which is what the author is choosing for.
 *
 * INELIGIBLE ENTRIES ARE NOT CONSULTED for the previews (they will be skipped, so
 * counting them would inflate the warning) but they do not empty the menu either:
 * a selection of a camera and two rects still offers the rects their types. An
 * EMPTY menu means NOTHING in the selection is eligible, which is the same "the
 * type really is fixed here" the single-item empty menu means.
 *
 * @param {object} registry - the plugin registry
 * @param {Array<object>} foldedStates - each selected item's FOLDED state
 * @returns {Array<{value: string, label: string, coercingCount: number, total: number}>}
 *
 * @example // #  retypeChoicesForSet(registry, [rectState, circleState, cameraState])
 * @example // #  → [{value: "rect", label: "Rectangle", coercingCount: 0, total: 2},   ← clean, top
 * @example // #     …,
 * @example // #     {value: "mermaid", label: "Mermaid", coercingCount: 2, total: 2}]  ← coercing, bottom
 * @example // #  (the camera is not counted in `total` — it is skipped, see retypeSkips)
 * @example retypeChoicesForSet({all: () => [], get: () => ({capabilities: {}})}, [])
 * []
 */
export function retypeChoicesForSet(registry, foldedStates) {
  const eligible = foldedStates.filter((f) => f?.type != null && retypeEligible(registry.get(f.type)));
  if (eligible.length === 0) return [];
  const rows = registry
    .all()
    .filter(retypeEligible)
    .map((p) => ({
      value: p.type,
      label: p.title,
      coercingCount: eligible.filter((f) => coercionPreview(f, registry.get(f.type), p).length > 0).length,
      total: eligible.length,
    }));
  return rows.sort((a, b) => (a.coercingCount === 0 ? 0 : 1) - (b.coercingCount === 0 ? 0 : 1));
}
