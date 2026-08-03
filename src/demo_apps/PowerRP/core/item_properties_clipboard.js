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
 */

import { deltaFromFoldDiff } from "./slide_reorder.js";
import { copiedDeep } from "./deltas.js";

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
