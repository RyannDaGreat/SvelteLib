/**
 * COPY PROPERTIES — moving a widget's STATE through time, not through space.
 *
 * DOM-free pure JS (bare node), like the rest of core/.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * Ordinary Copy clones a widget: paste makes a NEW item with a new id, beside
 * the original. That is the right verb for "I want another one of these", and
 * the wrong one for what the user asked for (2026-08-02, verbatim):
 *
 *   "there should be a copy state button … It's distinct from copying because
 *    it's going to just copy all of this state in whatever widget it is. And
 *    then if I move to another slide and I paste it, all that state will be
 *    pasted. That way I can basically move an object back in time."
 *
 * The unit is the SAME item at a DIFFERENT TIME. Nothing is created; slide N's
 * appearance of item X is transported onto slide M's appearance of item X.
 *
 * ── THE TRANSPORT LAW ────────────────────────────────────────────────────────
 * Let F(i, X) be item X's folded state on slide i. Copy on slide `s` captures
 * F(s, X) for each selected X; paste on slide `d` must make
 *
 *     fold(D', d, X)  ==  F(s, X)      for every copied, surviving X
 *
 * and change NOTHING else — not other items, not other slides. This is the
 * item-level analogue of `slide_reorder.js`'s acceptance law, and it is built
 * the same way: FOLD, then DIFF. `deltaFromFoldDiff(F(d, X), F(s, X))` is
 * exactly the minimal set of keyframes that carries the destination's current
 * appearance to the copied one, so a property that already agrees gains NO
 * keyframe. That minimality is the point rather than an optimization: a
 * keyframe on every leaf would pin properties the author never touched, and
 * every later slide inheriting them would silently stop tracking edits.
 *
 * ── WHY `active` RIDES ALONG, AND WHAT IT BUYS ───────────────────────────────
 * `active: false` is how an item exists on some slides and not others (it is
 * what Delete keyframes). It is an ordinary universal property, so it is part
 * of the fold and the diff carries it with no special case — which is what
 * makes "move an object back in time" work on an item that is HIDDEN at the
 * destination: copying from a slide where it is showing writes `active: true`
 * at the destination, and the item comes back wearing its copied pose. Stating
 * it because it looks like a special case and deliberately is not.
 *
 * ── PURGED ITEMS ARE REFUSED, BY NAME ────────────────────────────────────────
 * Hidden and purged are different (the manifest's hide-vs-purge distinction). A
 * hidden item still has a fold and is a legitimate target. A PURGED item is
 * gone from the document: there is no item to transport state onto, and
 * inventing one would be a CREATE wearing paste's clothes — a different verb
 * than the one the user pressed, producing an item with a stale id. So it is
 * refused, and the refusal NAMES the items rather than reporting a count, since
 * "1 item could not be pasted" tells the author nothing about which of their
 * widgets to go looking for.
 *
 * ── NOT THE SAME CLIPBOARD KIND AS COPY ──────────────────────────────────────
 * `powerrp_item_props` is a distinct payload kind from `powerrp_items`
 * (the clone payload) precisely so paste can DISPATCH: the user's ruling is
 * "paste behaves as normal, because after all if we copy something different,
 * paste will still do it". One paste verb, told apart by what is on the
 * clipboard — never by a second key the user has to remember.
 *
 * ── SUBSET COPIES: THE PAYLOAD MAY BE A PARTIAL FOLD ─────────────────────────
 * The user, 2026-08-02, verbatim: "We should also have copy position, copy
 * dimensions, in other words, hide width, and also copy x, y, h, w as options in
 * the command palette, and also, of course, tools. It's kind of like copy
 * properties, but for a limited subset."
 *
 * So `powerrp_item_props` may carry a PROPER SUBSET of an item's keys — Copy
 * Position is `{x, y}`, Copy Dimensions `{w, h}`, Copy Box all four. The paste
 * VERB is unchanged; the payload is simply smaller, which is the whole reason
 * the subsets cost one capture argument and no new paste path.
 *
 * THAT STILL NEEDED A REAL FIX ON THIS SIDE, and it was found by measuring rather
 * than by reasoning that a smaller payload is a smaller diff. `deltaFromFoldDiff`
 * diffs two WHOLE folds, so a key present in `from` and ABSENT from `to` is a
 * DELETION and earns a NONE tombstone (slide_reorder.js:132). Handing it a
 * two-key payload against a full destination state emitted
 * `{x: 10, type: null, w: null, h: null, z: null, active: null, fill: null}` —
 * i.e. pasting Copy Position would have STRIPPED THE WIDGET'S TYPE and hidden it.
 * A subset is not a smaller diff of the same two states; it is a diff over a
 * RESTRICTED KEY SET. `itemPropertiesDelta` therefore projects the DESTINATION
 * onto the payload's own keys before diffing, which makes that deletion loop
 * vacuous by construction rather than by luck. A FULL payload is unaffected — its
 * key set already IS every key, so the projection is the identity and the
 * transport law above holds unchanged. Both directions are pinned by tests.
 *
 * ONE CONSEQUENCE WORTH STATING: a subset payload can no longer DELETE a
 * property, because it never mentions one it does not carry. That is correct for
 * these verbs (Copy Position moves a widget; it does not un-set anything) and it
 * is why the projection is safe rather than merely convenient.
 *
 * ── THE SELECTION DECIDES WHO IS PASTED ONTO (WORKSTREAM UU) ─────────────────
 * User, 2026-08-02, verbatim: "When I copy position or some properties or any
 * copying any kind of properties from some object when I then paste it into
 * another slide How that works is determined by Whether or not I have a
 * selection If I have no selection it will just paste It will just paste the
 * properties given the ones that I copied individually object per object But if
 * I select an object it will paste the properties into that object Given the
 * intersection of whatever is possible to be pasted into it. So for example not
 * mismatching data types"
 *
 * So the payload above is a TRANSPORT with two DESTINATIONS, chosen by the
 * selection and by nothing else — no second verb, no modifier key, exactly as
 * paste already dispatches on the clipboard's KIND:
 *
 *   NO SELECTION  → per-item BY ID, "object per object". Everything above,
 *                   unchanged and byte-identical.
 *   A SELECTION   → the copied properties are RETARGETED onto the selected
 *                   items, intersected per target (`retargetedPayload` below).
 *
 * ── WHAT "THE INTERSECTION OF WHATEVER IS POSSIBLE" MEANS, EXACTLY ───────────
 * A key transfers to a target iff the target's plugin declares a row for it
 * whose CONTRACT matches the source's row for the same key — core/multiselect.js
 * `sameRowContract`, the relation this codebase already uses to decide whether
 * two widgets' same-named properties are the same property. It is REUSED rather
 * than reinvented, deliberately: a parallel type check would be a second opinion
 * about cross-widget compatibility, and the codebase's named recurring defect is
 * "a hand-maintained copy of another module's shape". The Inspector's joint-edit
 * question ("may one gesture write this row on both items?") and this one ("may
 * this copied value land on that widget?") are the SAME question, so they must
 * have the same answer or the panel and the paste will disagree.
 *
 * That relation is what "not mismatching data types" resolves to, and it is
 * STRONGER than a type check, which is why it is the right one:
 *   • a NUMBER `ambient` does not land on a COLOR `ambient` (kind)
 *   • a 20-option `shape` does not land on a 2-option `shape` (options)
 *   • a canvas-unit `cornerRadius` does not land on a 0..0.5 FRACTION one (max)
 *   • a degrees row does not land on a radians row (display — the UNIT)
 * A bare typeof check passes every one of those and writes a value the target
 * cannot mean.
 *
 * A KEY THE TARGET'S PLUGIN NEVER DECLARES IS NOT TRANSFERRED. Writing it would
 * store invisible junk the widget ignores — the same decision core/multiselect
 * made for union mode, and for the same stated reason.
 *
 * IDENTITY KEYS ARE NEVER TRANSFERRED (`UNRETARGETABLE_KEYS`). `type` is what a
 * widget IS, and pasting a rect's `type` onto a circle would not "apply a
 * property" — it would silently REPLACE the widget with one whose remaining
 * state was authored for something else. `z` and `active` are excluded for a
 * blunter reason: they are position-in-the-stack and visibility, which are
 * facts about the TARGET's place in this slide, not appearance being copied.
 * (They still ride a NO-selection paste, which is the same item at another time
 * — there, `active` coming back is the documented feature.)
 *
 * EQUATIONS TRANSFER VERBATIM. They are strings, and the target evaluates them;
 * a `= @otherItem.x` that names something absent fails through the ordinary
 * equation-error path, which is honest and visible. Rewriting or refusing them
 * here would be this module inventing a second equation semantics.
 *
 * SKIPPED KEYS ARE REPORTED, NEVER DROPPED SILENTLY (`retargetReport`), naming
 * WHICH key and WHY — the same say-the-reason discipline `purgedRefusal` uses.
 *
 * ── CARDINALITY: ONE SOURCE BROADCASTS, N SOURCES REFUSE ─────────────────────
 * One copied widget + N selected → BROADCAST: every selected item receives that
 * one item's properties, intersected per target, in ONE undo unit. This is the
 * case the ruling describes ("I select an object it will paste the properties
 * into that object") and the case that generalises to a set without ambiguity.
 *
 * N copied widgets (N > 1) + a selection → REFUSED, by name, with the ambiguity
 * stated. There is no non-arbitrary pairing: matching source i to target i by
 * ORDER would be a silent-wrong-mapping generator (clipboard order is capture
 * order; selection order is click order — neither is a correspondence anyone
 * authored), and picking one source arbitrarily would discard the rest without
 * saying so. The refusal names the counts and points at the escape hatch that
 * already exists: DESELECT and the per-id paste — the very thing the multi-item
 * copy was made for — still works untouched.
 */

import { deltaFromFoldDiff } from "./slide_reorder.js";
import { copiedDeep } from "./deltas.js";
import { sameRowContract, contractDifferences } from "./multiselect.js";

/**
 * Pure function. Captures the FOLDED state of `ids` out of a folded slide
 * state — the Copy Properties payload body.
 *
 * FOLDED, not the raw per-slide delta: the delta is a difference, and a
 * difference means something else in a different place (the whole reason
 * slide_reorder.js exists). The fold is what the item LOOKS like, which is the
 * thing being transported. Equations ride verbatim as the opaque leaves they
 * are — copying `x: "=box.x"` transports the binding, not the number it
 * happened to evaluate to.
 *
 * Ids with no state on this slide drop out (nothing to capture), matching the
 * clone path's `#cloneStates`.
 *
 * `keys` narrows the capture to a SUBSET of each item's properties (the header's
 * subset section — Copy Position is `["x", "y"]`). Omitted or null = every key,
 * the original whole-state behaviour, unchanged. A requested key the item does
 * not have simply does not appear: a widget with no `w` cannot contribute one,
 * and inventing `w: undefined` would paste a tombstone.
 *
 * RAW STORED VALUES, sign included. A flipped widget's `w` is NEGATIVE (the
 * negative-extents contract: the sign IS the reflection), and that sign is part
 * of the dimensions being copied — normalising it here would silently un-flip the
 * widget at the destination.
 *
 * An item that contributes NO requested key drops out entirely, exactly as an
 * absent id does — an empty entry would make `partitionPurged` report a surviving
 * item with nothing to transport.
 *
 * @param {object} foldedState - a folded slide state ({items, vars})
 * @param {string[]} ids - the item ids to capture
 * @param {string[]|null} [keys] - property names to keep; omitted = all of them
 * @returns {{powerrp_item_props: Object<string, object>}} the payload
 *
 * @example itemPropertiesPayload({items: {a: {x: 1, y: 2}, b: {x: 9}}}, ["a"])
 * // {powerrp_item_props: {a: {x: 1, y: 2}}}
 * @example itemPropertiesPayload({items: {a: {x: 1}}}, ["a", "gone"])
 * // {powerrp_item_props: {a: {x: 1}}}  (an absent id captures nothing)
 * @example itemPropertiesPayload({items: {a: {x: 1, y: 2, fill: "#f00"}}}, ["a"], ["x", "y"])
 * // {powerrp_item_props: {a: {x: 1, y: 2}}}  (Copy Position: the colour stays home)
 * @example itemPropertiesPayload({items: {a: {x: 1, w: -8}}}, ["a"], ["w", "h"])
 * // {powerrp_item_props: {a: {w: -8}}}  (the flip's sign rides along; absent `h` is not invented)
 */
export function itemPropertiesPayload(foldedState, ids, keys = null) {
  const items = foldedState.items ?? {};
  const captured = (state) => {
    const whole = copiedDeep(state);
    if (!keys) return whole;
    return Object.fromEntries(keys.filter((k) => k in whole).map((k) => [k, whole[k]]));
  };
  return {
    powerrp_item_props: Object.fromEntries(
      ids
        .filter((id) => items[id])
        .map((id) => [id, captured(items[id])])
        .filter(([, state]) => Object.keys(state).length),
    ),
  };
}

/**
 * Pure function. Splits a payload's ids into those that still EXIST in the
 * destination's folded state and those that are PURGED — the refusal's input.
 *
 * "Exists" is membership in the folded `items` map, NOT `active !== false`: a
 * hidden item is a perfectly good destination (see the header), so hiding must
 * not read as purged.
 *
 * @param {object} payload - an `itemPropertiesPayload` result
 * @param {object} foldedState - the DESTINATION slide's folded state
 * @returns {{surviving: string[], purged: string[]}} ids, payload order
 *
 * @example partitionPurged({powerrp_item_props: {a: {x: 1}, b: {x: 2}}}, {items: {a: {x: 5}}})
 * // {surviving: ["a"], purged: ["b"]}
 * @example partitionPurged({powerrp_item_props: {a: {x: 1}}}, {items: {a: {x: 5, active: false}}})
 * // {surviving: ["a"], purged: []}  (hidden is NOT purged — it is a valid target)
 */
export function partitionPurged(payload, foldedState) {
  const items = foldedState.items ?? {};
  const ids = Object.keys(payload.powerrp_item_props ?? {});
  return {
    surviving: ids.filter((id) => items[id]),
    purged: ids.filter((id) => !items[id]),
  };
}

/**
 * Pure function. The sentence shown when some copied items no longer exist.
 * NAMES them (see the header) and says what to do about it, in one line.
 *
 * @param {string[]} purged - the ids that are gone
 * @param {number} surviving - how many ids DO still exist
 * @returns {string} the refusal sentence
 *
 * @example purgedRefusal(["a1"], 2)
 * // 'Paste Properties: 1 copied widget no longer exists in this document (a1) — its properties were skipped; the other 2 were pasted. A purged widget cannot be restored by pasting state onto it; undo the purge, or paste the widget itself with an ordinary Copy.'
 * @example purgedRefusal(["a1", "b2"], 0)
 * // 'Paste Properties: 2 copied widgets no longer exist in this document (a1, b2) — nothing was pasted. A purged widget cannot be restored by pasting state onto it; undo the purge, or paste the widget itself with an ordinary Copy.'
 */
export function purgedRefusal(purged, surviving) {
  const noun = purged.length === 1 ? "widget no longer exists" : "widgets no longer exist";
  const rest = surviving === 0
    ? "nothing was pasted"
    : `its properties were skipped; the other ${surviving} ${surviving === 1 ? "was" : "were"} pasted`;
  return `Paste Properties: ${purged.length} copied ${noun} in this document (${purged.join(", ")}) — ${rest}. ` +
    "A purged widget cannot be restored by pasting state onto it; undo the purge, or paste the widget itself with an ordinary Copy.";
}

/**
 * Pure function. THE TRANSPORT. Returns the DELTA to merge into the destination
 * slide so each surviving copied item folds to its captured state — the
 * header's law, one `deltaFromFoldDiff` per item.
 *
 * Per-ITEM diffs, not one whole-state diff: the law says change nothing but the
 * copied items, and diffing the full states would additionally write deletions
 * for every item the source slide happens not to have.
 *
 * Arrays are whole leaves (deltaFromFoldDiff's contract), so a copied point
 * list transports intact rather than being merged element-wise.
 *
 * THE DESTINATION IS PROJECTED ONTO THE PAYLOAD'S KEYS FIRST — the header's
 * subset section, and the load-bearing line in this function. `deltaFromFoldDiff`
 * reads a key it has and the other side lacks as a DELETION, so diffing a
 * two-key Copy Position payload against the destination's full state would write
 * `type: null` and unmake the widget. Restricting the `from` side to the keys
 * actually being transported makes that loop vacuous. For a WHOLE-state payload
 * the projection is the identity, so nothing about the original verb changes.
 *
 * @param {object} payload - an `itemPropertiesPayload` result (whole or subset)
 * @param {object} destFold - the DESTINATION slide's folded state
 * @returns {object} a delta of the shape `{items: {id: {...}}}` ({} when nothing differs)
 *
 * @example // transporting x from a slide where it was 1 onto one where it is 5
 * itemPropertiesDelta({powerrp_item_props: {a: {x: 1, y: 2}}}, {items: {a: {x: 5, y: 2}}})
 * // {items: {a: {x: 1}}}   (y already agrees → NO keyframe: the minimality law)
 * @example // an item HIDDEN at the destination comes back, because `active` is in the fold
 * itemPropertiesDelta({powerrp_item_props: {a: {x: 1, active: true}}}, {items: {a: {x: 1, active: false}}})
 * // {items: {a: {active: true}}}
 * @example itemPropertiesDelta({powerrp_item_props: {a: {x: 1}}}, {items: {a: {x: 1}}})
 * // {}   (nothing differs → no delta at all, so no undo-worthy edit)
 * @example // a SUBSET payload touches only its own keys — no tombstone for `fill`
 * itemPropertiesDelta({powerrp_item_props: {a: {x: 1}}}, {items: {a: {x: 5, fill: "#f00"}}})
 * // {items: {a: {x: 1}}}
 */
export function itemPropertiesDelta(payload, destFold) {
  const destItems = destFold.items ?? {};
  const items = {};
  for (const [id, copiedState] of Object.entries(payload.powerrp_item_props ?? {})) {
    if (!destItems[id]) continue; // purged — refused by the caller, never silently created
    // See the header: diff over the payload's OWN key set, so an unmentioned
    // property is "not being transported" rather than "deleted".
    const destState = Object.fromEntries(
      Object.keys(copiedState).filter((k) => k in destItems[id]).map((k) => [k, destItems[id][k]]),
    );
    const diff = deltaFromFoldDiff(destState, copiedState);
    if (Object.keys(diff).length) items[id] = diff;
  }
  return Object.keys(items).length ? { items } : {};
}

// ── SELECTION-TARGETED PASTE (the header's WORKSTREAM UU section) ────────────

/**
 * The payload keys a retarget never carries, each with the reason it is refused
 * — the header's identity-keys paragraph, as data so the report can quote it.
 *
 * A DENYLIST rather than a "transfer only what the inspector declares" rule
 * doing the job by accident: `type` has no inspector row anywhere, so it would
 * already be filtered — but that would be luck, and a plugin that one day
 * declares a `type` row would silently start replacing widgets. Named here, the
 * refusal is a decision instead of a side effect.
 *
 * @example UNRETARGETABLE_KEYS.type.startsWith("A widget's type") // true
 * @example Object.keys(UNRETARGETABLE_KEYS).sort()
 * // ["active", "type", "z"]
 */
export const UNRETARGETABLE_KEYS = {
  type: "A widget's type is what it IS, not a property it has — pasting one onto another widget would replace it rather than restyle it.",
  z: "Stacking order is where a widget sits in THIS slide's pile, not part of the appearance being copied.",
  active: "Whether a widget is showing on this slide belongs to the target, not to the copied look.",
};

/**
 * Pure function. The rows a plugin declares, as a `key -> row` map — the lookup
 * `retargetedState` needs on both sides of the contract comparison.
 *
 * A plugin with no `inspector` contributes nothing, which is the correct reading:
 * it declares no property anything may be pasted into.
 *
 * @param {object|null|undefined} plugin - a registry plugin entry
 * @returns {Map<string, object>} declared key → its resolved row
 *
 * @example rowsByKey({inspector: [{key: "x", kind: "number"}, {key: "fill", kind: "color"}]}).get("fill").kind
 * // 'color'
 * @example rowsByKey(null).size
 * // 0
 */
export function rowsByKey(plugin) {
  return new Map((plugin?.inspector ?? []).map((row) => [row.key, row]));
}

/**
 * Pure function. ONE copied item's properties INTERSECTED against one target —
 * the header's "intersection of whatever is possible to be pasted into it".
 *
 * Returns both halves, because dropping a key silently is exactly what this
 * module may not do: `state` is what will be written, `skipped` is one
 * `{key, reason}` per key that will not be, in payload order.
 *
 * The three ways a key fails, in the order tested:
 *   1. It is an IDENTITY key (UNRETARGETABLE_KEYS) — refused everywhere.
 *   2. The target's plugin declares NO row for it — it cannot mean the property.
 *   3. Both declare it, with DIFFERENT contracts — `sameRowContract` says no, and
 *      the reason names the aspects, so "why did my corner radius not paste"
 *      answers itself.
 *
 * SOURCE ROWS ARE OPTIONAL. When the source plugin is unknown (a cross-document
 * payload, or a widget type this build does not register) there is no contract to
 * compare, so the target's declaration alone decides — the honest fallback: we
 * know the target can express the key, and we have no evidence the source meant
 * something else by it.
 *
 * @param {object} copiedState - one item's captured properties (whole or subset)
 * @param {object|null} sourcePlugin - the plugin the properties were copied FROM, if known
 * @param {object} targetPlugin - the plugin being pasted ONTO
 * @returns {{state: object, skipped: Array<{key: string, reason: string}>}}
 *
 * @example // x and y are the same row on every boxed widget — they transfer:
 * retargetedState({x: 10, y: 20}, {inspector: [{key: "x", kind: "number"}, {key: "y", kind: "number"}]},
 *                                 {inspector: [{key: "x", kind: "number"}, {key: "y", kind: "number"}]}).state
 * // {x: 10, y: 20}
 * @example // a key the target's plugin never declares does not land, and says so:
 * retargetedState({sides: 6}, {inspector: [{key: "sides", kind: "number"}]}, {inspector: []}).skipped
 * // [{key: "sides", reason: "this widget has no “sides” property"}]
 * @example // same key, different contract → refused, naming the aspect:
 * retargetedState({cornerRadius: 12},
 *   {inspector: [{key: "cornerRadius", kind: "number", min: 0}]},
 *   {inspector: [{key: "cornerRadius", kind: "number", min: 0, max: 0.5}]}).skipped[0].reason
 * // 'this widget’s “cornerRadius” means something different (max)'
 * @example // an equation rides verbatim — the target evaluates it:
 * retargetedState({x: "=cam.x + 10"}, null, {inspector: [{key: "x", kind: "number"}]}).state
 * // {x: '=cam.x + 10'}
 * @example retargetedState({type: "rect"}, null, {inspector: [{key: "type", kind: "text"}]}).state
 * // {}   (identity keys are refused even where a row exists)
 */
export function retargetedState(copiedState, sourcePlugin, targetPlugin) {
  const sourceRows = rowsByKey(sourcePlugin);
  const targetRows = rowsByKey(targetPlugin);
  const state = {};
  const skipped = [];
  for (const [key, value] of Object.entries(copiedState)) {
    if (key in UNRETARGETABLE_KEYS) {
      skipped.push({ key, reason: UNRETARGETABLE_KEYS[key] });
      continue;
    }
    const targetRow = targetRows.get(key);
    if (!targetRow) {
      skipped.push({ key, reason: `this widget has no “${key}” property` });
      continue;
    }
    const sourceRow = sourceRows.get(key);
    if (sourceRow && !sameRowContract(sourceRow, targetRow)) {
      const aspects = contractDifferences(sourceRow, targetRow);
      skipped.push({ key, reason: `this widget’s “${key}” means something different (${aspects.join(", ")})` });
      continue;
    }
    state[key] = value;
  }
  return { state, skipped };
}

/**
 * Pure function. THE RETARGET. One copied item's properties broadcast onto every
 * selected target, each intersected separately — a payload of the SAME shape
 * `itemPropertiesDelta` already consumes, so the selection path reuses the
 * transport arithmetic verbatim rather than growing a second one.
 *
 * ONE SOURCE ONLY. Multiple copied items are the header's refusal case and are
 * rejected by `retargetRefusal` BEFORE this is called; passing more than one here
 * throws rather than picking, because a silent choice among sources is exactly
 * the mapping this design exists to refuse.
 *
 * A target that ends up with NO transferable key still appears in `report` (so
 * the user learns nothing landed on it, and why) but contributes no payload
 * entry — an empty entry would make `partitionPurged` count a target that
 * receives nothing as one that receives something.
 *
 * @param {object} payload - an `itemPropertiesPayload` result with EXACTLY one item
 * @param {object|null} sourcePlugin - the plugin the properties came from, if known
 * @param {Array<{itemId: string, plugin: object}>} targets - the selected items
 * @returns {{payload: object, report: Array<{itemId: string, applied: string[], skipped: Array<{key: string, reason: string}>}>}}
 *
 * @example // one rect's position broadcast to a circle and a text:
 * // retargetedPayload({powerrp_item_props: {r: {x: 10, y: 20}}}, rectPlugin,
 * //                   [{itemId: "c", plugin: circlePlugin}, {itemId: "t", plugin: textPlugin}])
 * // → {payload: {powerrp_item_props: {c: {x: 10, y: 20}, t: {x: 10, y: 20}}}, report: [...]}
 * @example retargetedPayload({powerrp_item_props: {r: {sides: 6}}}, null,
 *   [{itemId: "c", plugin: {inspector: []}}]).payload
 * // {powerrp_item_props: {}}   (nothing was expressible — no entry is invented)
 */
export function retargetedPayload(payload, sourcePlugin, targets) {
  const sources = Object.entries(payload.powerrp_item_props ?? {});
  if (sources.length !== 1)
    throw new Error(`retargetedPayload: exactly one copied item may be broadcast, got ${sources.length} — the caller must run retargetRefusal first.`);
  const [, copiedState] = sources[0];
  const out = {};
  const report = [];
  for (const target of targets) {
    const { state, skipped } = retargetedState(copiedState, sourcePlugin, target.plugin);
    if (Object.keys(state).length) out[target.itemId] = state;
    report.push({ itemId: target.itemId, applied: Object.keys(state), skipped });
  }
  return { payload: { powerrp_item_props: out }, report };
}

/**
 * Pure function. The sentence refusing an N-source paste onto a selection, or
 * null when the cardinality is fine — the header's cardinality rule, said out
 * loud instead of resolved by an invented pairing.
 *
 * NAMES THE COUNTS AND THE WAY OUT. A refusal that only says "ambiguous" leaves
 * the author with a clipboard they cannot spend; the per-id paste is still there
 * and one deselect reaches it, so the sentence points at it.
 *
 * @param {number} sourceCount - how many items the payload carries
 * @param {number} targetCount - how many items are selected
 * @returns {string|null} the refusal, or null to proceed
 *
 * @example retargetRefusal(1, 3) // null
 * @example retargetRefusal(2, 1)
 * // 'Paste Properties: 2 widgets were copied and 1 is selected — there is no way to tell which copied widget belongs to which selected one, and pairing them by order would silently paste the wrong properties. Deselect everything to paste each copied widget’s properties back onto ITSELF, or copy just one widget to paste it onto a selection.'
 * @example retargetRefusal(1, 0) // null (no selection at all — the per-id path, not this one)
 */
export function retargetRefusal(sourceCount, targetCount) {
  if (targetCount === 0 || sourceCount <= 1) return null;
  return `Paste Properties: ${sourceCount} widgets were copied and ${targetCount} ${targetCount === 1 ? "is" : "are"} selected — ` +
    "there is no way to tell which copied widget belongs to which selected one, and pairing them by order would silently paste the wrong properties. " +
    "Deselect everything to paste each copied widget’s properties back onto ITSELF, or copy just one widget to paste it onto a selection.";
}

/**
 * Pure function. What a retarget DID, as the lines shown to the author — one per
 * target that lost at least one key, plus a leading line when nothing landed
 * anywhere at all.
 *
 * WHY PER-TARGET AND NOT ONE SUMMARY: pasting a rect's properties onto a circle
 * and a video, the two lose DIFFERENT keys for different reasons, and "7 keys
 * were skipped" would send the author hunting through both widgets. A target
 * that took everything says nothing, because a silent success is fine and a
 * silent failure is not.
 *
 * @param {Array<{itemId: string, applied: string[], skipped: Array<{key: string, reason: string}>}>} report - retargetedPayload's report
 * @returns {string[]} lines to warn with, empty when every key landed everywhere
 *
 * @example retargetReport([{itemId: "c", applied: ["x", "y"], skipped: []}])
 * // []
 * @example retargetReport([{itemId: "c", applied: ["x"], skipped: [{key: "sides", reason: "this widget has no “sides” property"}]}])
 * // ['Paste Properties: c did not take “sides” — this widget has no “sides” property.']
 * @example retargetReport([{itemId: "c", applied: [], skipped: [{key: "sides", reason: "this widget has no “sides” property"}]}])
 * // ['Paste Properties: nothing could be pasted onto any of the 1 selected widget — none of the copied properties exists on it with the same meaning.', 'Paste Properties: c did not take “sides” — this widget has no “sides” property.']
 */
export function retargetReport(report) {
  const lines = [];
  if (report.length && report.every((r) => r.applied.length === 0))
    lines.push(`Paste Properties: nothing could be pasted onto any of the ${report.length} selected widget${report.length === 1 ? "" : "s"} — ` +
      `none of the copied properties exists on ${report.length === 1 ? "it" : "them"} with the same meaning.`);
  for (const { itemId, skipped } of report)
    for (const { key, reason } of skipped)
      lines.push(`Paste Properties: ${itemId} did not take “${key}” — ${reason}.`);
  return lines;
}
