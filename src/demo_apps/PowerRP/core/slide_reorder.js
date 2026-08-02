/**
 * APPEARANCE-PRESERVING SLIDE REORDER — and the delta-synthesis primitive under it.
 *
 * DOM-free pure JS (bare node), like the rest of core/.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * A PowerRP document stores no per-slide state, only per-slide DELTAS: slide N's
 * appearance is fold(delta_0 … delta_N). So moving a slide's ROW in the list
 * (the old `withSlideMoved`, a bare array splice) moves its DIFF, not its
 * PICTURE — and a diff means something different in a different place. Move
 * slide 3 to position 1 and its `x: +40` now applies to slide 0's pose instead
 * of slide 2's; every slide after it shifts too. User report, verbatim
 * (2026-08-02): "when I move slide up and move slide down, it does like change
 * way more than I bargained for", and the requirement: "when I drag a slide
 * somewhere else, the state should be adapted so that it looks like I actually
 * just dragged that slide somewhere else … we would need to suddenly keyframe
 * all the current states that would have been changed if I moved it somewhere
 * else, like the minimum set".
 *
 * ── THE ACCEPTANCE LAW ───────────────────────────────────────────────────────
 * Let F(i) be slide i's folded state BEFORE the move and P the permutation
 * (P[j] = the OLD index of the slide that ends up at NEW index j). Then for the
 * reordered document D':
 *
 *     fold(D', j)  ==  F(P[j])       for every ENABLED slide j
 *
 * i.e. every slide's evaluated state is byte-identical to what it was; only the
 * ORDER changed. That is the whole contract, and `reorderedSlides` asserts it is
 * achievable by construction: it FOLDS first, permutes the folded SEQUENCE, and
 * then RE-DERIVES each delta as the minimal diff between consecutive folds.
 * Nothing is transplanted; every delta is synthesized fresh for the position it
 * now occupies.
 *
 * A slide's IDENTITY (id, name, transition, enabled, autoAdvance — every field
 * except `delta`) travels with its fold, so the row the user dragged is still
 * the row they dragged.
 *
 * ── CONSEQUENCES WORTH STATING (they surprise people) ────────────────────────
 * - CREATION TRAVELS. Slide 0's delta creates everything, so if the slide that
 *   lands at index 0 previously showed items born on an earlier slide, the new
 *   slide 0's synthesized delta CREATES them (diff from the empty state). This
 *   is required by the law and is not a bug.
 * - DELTAS GROW. The minimal diff between two folds can be larger than the
 *   author's original hand-made delta (an item that was implicitly inherited may
 *   now need an explicit keyframe, or an explicit `null` deletion). "Minimal"
 *   here means minimal w.r.t. the neighbouring folds, not w.r.t. what the author
 *   typed. `simplifyDuplicateKeyframes` is the counterweight the user asked for.
 * - EQUATIONS ARE OPAQUE LEAVES. A stored `"=100+shape_2.x"` is a string; it
 *   diffs by identity like any other leaf, so it survives a reorder verbatim
 *   when it is unchanged and is written verbatim when it is not. The reorder
 *   preserves STORED state, so it preserves equations rather than baking them —
 *   but note the law is about stored folds: an equation whose REFERENT moved
 *   evaluates differently, and no reorder can fix that (see LIMITS).
 * - DISABLED SLIDES ARE NOT RE-DERIVED, AND THE LAW EXCLUDES THEM. `slideState`
 *   skips a disabled slide's delta entirely, so such a slide contributes nothing
 *   to any fold and HAS NO PICTURE OF ITS OWN — it shows whatever its
 *   predecessor shows. Moving it therefore changes what it displays, necessarily
 *   and in every possible implementation: there is no fold-diff that could
 *   reconstruct a state it never had. So its delta TRAVELS VERBATIM, the enabled
 *   slides around it diff against the previous ENABLED fold, and the law above
 *   is quantified over the ENABLED slides. Re-enabling it after a reorder gives
 *   whatever that delta means in its new home — the same "a diff means something
 *   else elsewhere" caveat the whole module exists to remove, kept only where
 *   the fold cannot see. (`tests/slide_reorder_test.js` pins both halves.)
 *
 * ── LIMITS (not covered, deliberately) ───────────────────────────────────────
 * The law is over STORED state (`slideState`), which is what `RenderTree =
 * pure(document, [[slide, alpha]])` is a function of at alpha 1. It says nothing
 * about:
 *   - TWEENS. Alpha strictly between 0 and 1 blends from the PREVIOUS slide's
 *     fold, and the previous slide is exactly what a reorder changes. Every
 *     endpoint is preserved; the paths between them are new. That is what the
 *     user asked for ("it looks like I'm just dragging the slides").
 *   - EQUATION REFERENTS. `= otherItem.x` reads the folded state, which is
 *     preserved, so ordinary references are fine; but an equation reading
 *     ambient time or a var whose own keyframe order changed evaluates by the
 *     new order, by construction.
 */

import { NONE, isTree, copied, copiedDeep, applied, deepEqual } from "./deltas.js";

/**
 * Pure function. THE MINIMAL DELTA taking `from` to `to`: the smallest delta
 * tree D for which `applied(from, D)` deep-equals `to`.
 *
 * THIS IS THE REUSE SEAM. Its contract, stated for the follow-ups that will
 * build slide copy / paste / duplicate on it:
 *   - INPUTS are two FOLDED STATE TREES (`{items, vars}` shaped), never deltas.
 *     `from` may be `{}` — the empty state — which yields a CREATION delta.
 *   - OUTPUT is a delta in `core/deltas.js`'s vocabulary: a value leaf sets, a
 *     `NONE` (null) leaf deletes, a nested object recurses. So it round-trips
 *     through `applied`, `blendApplied`, `leaves`, `setPath` and the keyframe
 *     panel with no special-casing anywhere.
 *   - It is MINIMAL: a key whose value is deep-equal in both sides is OMITTED,
 *     so the untouched keys keep whatever the document already stored for them
 *     (a literal OR an `=equation`) and no spurious keyframe appears in the
 *     keyframe panel. This is `diffState`'s rule (core/deltas.js), generalized
 *     from one flat object over a key list to the whole recursive tree.
 *   - ARRAYS ARE LEAVES. A list property (gradient `stops`, polygon `points`) is
 *     compared with `deepEqual` and written WHOLE when it differs. Per-element
 *     sparse keyframing exists (core/lists.js) but a synthesized delta must not
 *     invent one: a sparse patch over a list of a DIFFERENT length would merge
 *     element-wise into the wrong base. Whole-list is always correct and always
 *     reproduces `to`.
 *   - It is PURE and allocation-only: neither input is mutated, and every
 *     value placed in the output is deep-copied (`copiedDeep`), so a caller may
 *     mutate the result without touching the folds it came from.
 *
 * @param {object} from - the state the delta will be applied to ({} for creation)
 * @param {object} to - the state the delta must produce
 * @returns {object} a delta tree; `{}` when the two states are already equal
 *
 * @example deltaFromFoldDiff({x: 1, y: 2}, {x: 5, y: 2}) // {x: 5}  (y unchanged → omitted)
 * @example deltaFromFoldDiff({x: 1, y: 2}, {x: 1}) // {y: null}  (NONE = delete)
 * @example deltaFromFoldDiff({}, {items: {a: {x: 1}}}) // {items: {a: {x: 1}}}  (creation)
 * @example deltaFromFoldDiff({items: {a: {x: 1, w: 9}}}, {items: {a: {x: 2, w: 9}}}) // {items: {a: {x: 2}}}
 * @example deltaFromFoldDiff({a: 1}, {a: 1}) // {}  (no change)
 * @example deltaFromFoldDiff({p: [1, 2]}, {p: [1, 3]}) // {p: [1, 3]}  (arrays are whole leaves)
 * @example deltaFromFoldDiff({x: "=a.x"}, {x: "=a.x"}) // {}  (equations are opaque leaves)
 */
export function deltaFromFoldDiff(from, to) {
  const base = isTree(from) ? from : {};
  const out = {};
  for (const [key, val] of Object.entries(to)) {
    const prev = base[key];
    if (deepEqual(prev, val)) continue;
    // Both sides object trees → recurse, so an item that changed ONE leaf writes
    // one leaf rather than its whole state. Anything else (a leaf, an array, or
    // a tree replacing a non-tree) is written whole.
    out[key] = isTree(val) && isTree(prev) ? deltaFromFoldDiff(prev, val) : copiedDeep(val);
  }
  for (const key of Object.keys(base)) if (!(key in to)) out[key] = NONE;
  return out;
}

/**
 * Pure function. Every slide's FOLDED state, in order — `[fold(0), fold(1), …]`.
 * A disabled slide's delta is skipped (matching `core/document.js slideState`),
 * so a disabled slide's entry repeats its predecessor's fold.
 *
 * Local rather than imported from document.js on purpose: `slideState` memoizes
 * on document IDENTITY in a WeakMap, and this module folds INTERMEDIATE
 * documents that exist for one call — caching those would be pure garbage
 * retention. The rule it implements is one line and is asserted against
 * `slideState` in tests/slide_reorder_test.js.
 *
 * @param {object} doc - a PowerRP document
 * @returns {object[]} folded state per slide index
 *
 * @example foldedStates({slides: [{delta: {a: 1}}, {delta: {b: 2}}]}) // [{a: 1}, {a: 1, b: 2}]
 * @example foldedStates({slides: [{delta: {a: 1}}, {delta: {a: 9}, enabled: false}]}) // [{a: 1}, {a: 1}]
 */
export function foldedStates(doc) {
  const out = [];
  let cur = {};
  for (const slide of doc.slides) {
    if (slide.enabled !== false) cur = applied(cur, slide.delta);
    out.push(cur);
  }
  return out;
}

/**
 * Pure function. Validates a permutation of `length` and returns it as an array.
 * Loud on anything that is not a bijection onto 0..length-1 — a silently
 * accepted bad permutation would drop or duplicate a slide.
 *
 * @example checkedPermutation([2, 0, 1], 3) // [2, 0, 1]
 * @example // checkedPermutation([0, 0], 2) → throws (1 missing, 0 twice)
 */
export function checkedPermutation(order, length) {
  const perm = [...order];
  if (perm.length !== length)
    throw new Error(`slide permutation has ${perm.length} entries for ${length} slides`);
  const seen = new Set(perm);
  if (seen.size !== length || perm.some((i) => !Number.isInteger(i) || i < 0 || i >= length))
    throw new Error(`slide permutation is not a bijection over 0..${length - 1}: ${JSON.stringify(order)}`);
  return perm;
}

/**
 * Pure function. THE REORDER PRIMITIVE. Returns a document whose slides appear
 * in the order given by `order` (`order[j]` = the OLD index of the slide that
 * ends up at NEW index j), with every slide's delta RE-DERIVED so that
 * `fold(result, j)` deep-equals `fold(doc, order[j])` — the acceptance law in
 * this file's header.
 *
 * Each slide keeps every field except `delta` (id, name, transition, enabled,
 * autoAdvance, …), so identity travels with the picture.
 *
 * A DISABLED slide keeps its delta verbatim and is skipped when diffing (it
 * contributes nothing to any fold — see the header's DISABLED SLIDES note).
 *
 * @param {object} doc - a PowerRP document
 * @param {number[]} order - the permutation; order[newIndex] = oldIndex
 * @returns {object} a new document
 *
 * @example // two slides swapped: each still shows exactly what it showed
 * reorderedSlides({slides: [{id: "a", delta: {x: 1}}, {id: "b", delta: {x: 2}}]}, [1, 0])
 * // {slides: [{id: "b", delta: {x: 2}}, {id: "a", delta: {x: 1}}]}
 * @example // identity permutation is a no-op on the FOLDS (deltas may be renormalized)
 * reorderedSlides({slides: [{id: "a", delta: {x: 1}}]}, [0]).slides[0].delta // {x: 1}
 */
export function reorderedSlides(doc, order) {
  const perm = checkedPermutation(order, doc.slides.length);
  const folds = foldedStates(doc);
  let prev = {};
  const slides = perm.map((oldIndex) => {
    const slide = doc.slides[oldIndex];
    if (slide.enabled === false) return { ...slide, delta: copiedDeep(slide.delta) };
    const target = folds[oldIndex];
    const out = { ...slide, delta: deltaFromFoldDiff(prev, target) };
    prev = target;
    return out;
  });
  return { ...doc, slides };
}

/**
 * Pure function. `reorderedSlides` for the common single-slide move: slide
 * `index` moves to `index + offset` (clamped to the deck), everything else
 * closing up around it. The drop-in, appearance-preserving replacement for
 * `core/document.js withSlideMoved`.
 *
 * @param {object} doc - a PowerRP document
 * @param {number} index - the slide being moved
 * @param {number} offset - how far (negative = earlier)
 * @returns {object} a new document (the SAME object when the move is a no-op)
 *
 * @example movedSlidePreservingLook({slides: [{id: "a", delta: {x: 1}}, {id: "b", delta: {x: 2}}]}, 0, 1).slides[0].id // "b"
 * @example // clamped move at the top is a no-op:
 * movedSlidePreservingLook({slides: [{id: "a", delta: {}}]}, 0, -1).slides.length // 1
 */
export function movedSlidePreservingLook(doc, index, offset) {
  const n = doc.slides.length;
  const to = Math.max(0, Math.min(n - 1, index + offset));
  if (to === index) return doc;
  const order = doc.slides.map((_, i) => i);
  order.splice(index, 1);
  order.splice(to, 0, index);
  return reorderedSlides(doc, order);
}

/**
 * Pure function. Every NO-OP KEYFRAME in the document: a delta leaf whose value
 * is ALREADY what the fold says at that slide, so removing it changes nothing.
 *
 * User request, verbatim (2026-08-02): "if slide one is keyframed at A equals
 * five and slide two is also keyframed A equals five, then we could just
 * simplify it by deleting slide one's keyframe" — the second keyframe is the
 * redundant one (deleting it leaves the value inherited from the first), which
 * is what this finds.
 *
 * Slide 0 is EXEMPT: its delta is what CREATES everything, and a creation
 * keyframe never has a prior fold to be redundant against. Disabled slides are
 * exempt too — their deltas are outside the fold, so "already folded" is not a
 * question that has an answer for them.
 *
 * A `NONE` (delete) leaf counts as redundant when the key is already absent —
 * that is `contains`' rule for deletions and the same "applying it would change
 * nothing" test.
 *
 * @param {object} doc - a PowerRP document
 * @returns {{slideIndex: number, path: string[]}[]} the redundant leaves, in document order
 *
 * @example // slide 1 re-states x: 5, which slide 0 already set
 * duplicateKeyframes({slides: [{delta: {items: {a: {x: 5}}}}, {delta: {items: {a: {x: 5}}}}]})
 * // [{slideIndex: 1, path: ["items", "a", "x"]}]
 * @example duplicateKeyframes({slides: [{delta: {a: 1}}, {delta: {a: 2}}]}) // [] (a genuine change)
 */
export function duplicateKeyframes(doc) {
  const out = [];
  let prev = {};
  doc.slides.forEach((slide, slideIndex) => {
    if (slide.enabled === false) return;
    if (slideIndex > 0) collectRedundant(prev, slide.delta, [], slideIndex, out);
    prev = applied(prev, slide.delta);
  });
  return out;
}

/**
 * Command (appends to `out`) — duplicateKeyframes' recursion. Walks `delta`
 * against the fold `state` it will be applied to, recording each leaf that would
 * change nothing.
 *
 * A nested delta over a NON-tree state value is NOT descended into: it is a
 * structural rewrite (or a sparse list patch, core/deltas.js mutBlendApply), and
 * whether it is redundant is not a per-leaf question. Left alone, always.
 */
function collectRedundant(state, delta, prefix, slideIndex, out) {
  const base = isTree(state) ? state : {};
  for (const [key, val] of Object.entries(delta)) {
    const path = [...prefix, key];
    if (val === NONE) {
      if (!(key in base)) out.push({ slideIndex, path });
    } else if (isTree(val)) {
      if (isTree(base[key])) collectRedundant(base[key], val, path, slideIndex, out);
    } else if (deepEqual(base[key], val)) {
      out.push({ slideIndex, path });
    }
  }
}

/**
 * Pure function. Removes every no-op keyframe `duplicateKeyframes` finds, and
 * reports HOW MANY — the "Simplify duplicate keyframes" command's whole
 * implementation, and the number its tooltip states.
 *
 * APPEARANCE-PRESERVING BY CONSTRUCTION: every removed leaf was, by definition,
 * already satisfied by the fold at that slide, so no fold changes. (Removing
 * them can change a TWEEN — a leaf keyframed to the value it already has is a
 * no-op at alpha 1 but pins the value during the transition. It is still a
 * no-op there too, because `blendApplied` interpolates FROM the current folded
 * value, and start == end.)
 *
 * IDEMPOTENT: running it twice reports 0 the second time.
 *
 * @param {object} doc - a PowerRP document
 * @returns {{document: object, count: number}} the simplified doc and how many leaves went
 *
 * @example simplifyDuplicateKeyframes({slides: [{delta: {a: 5}}, {delta: {a: 5}}]})
 * // {document: {slides: [{delta: {a: 5}}, {delta: {}}]}, count: 1}
 * @example simplifyDuplicateKeyframes({slides: [{delta: {a: 5}}, {delta: {a: 6}}]}).count // 0
 */
export function simplifyDuplicateKeyframes(doc) {
  const redundant = duplicateKeyframes(doc);
  if (redundant.length === 0) return { document: doc, count: 0 };
  const bySlide = new Map();
  for (const { slideIndex, path } of redundant) {
    if (!bySlide.has(slideIndex)) bySlide.set(slideIndex, []);
    bySlide.get(slideIndex).push(path);
  }
  const slides = doc.slides.map((slide, i) => {
    const paths = bySlide.get(i);
    if (!paths) return slide;
    let delta = copied(slide.delta);
    for (const path of paths) prunedLeaf(delta, path);
    return { ...slide, delta };
  });
  return { document: { ...doc, slides }, count: redundant.length };
}

/**
 * Command (mutates `tree`). Deletes the leaf at `path` and prunes the object
 * nodes it empties. Unlike `core/deltas.js deletePath` this is IN-PLACE, because
 * `simplifyDuplicateKeyframes` removes many paths from one freshly-copied delta
 * and a persistent rebuild per path would be quadratic for no benefit. Arrays
 * are never descended into (a whole-array leaf is removed as one value).
 */
function prunedLeaf(tree, path) {
  const [head, ...rest] = path;
  if (!isTree(tree) || !(head in tree)) return;
  if (rest.length === 0) {
    delete tree[head];
    return;
  }
  prunedLeaf(tree[head], rest);
  if (isTree(tree[head]) && Object.keys(tree[head]).length === 0) delete tree[head];
}
