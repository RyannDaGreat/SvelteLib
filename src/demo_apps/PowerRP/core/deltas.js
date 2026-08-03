/**
 * Delta trees — the atom of PowerRP's document model.
 *
 * A delta is a plain nested object tree mirroring the state tree's shape.
 * Leaf semantics:
 *   - value        → set/tween the key to that value
 *   - null (NONE)  → delete the key
 *   - nested {}    → recurse
 *
 * Descended from Lab-In-A-Cube's deltas.js (apply/blended/contains as one
 * generic walker) and tweenline.py (lazy start capture: blends run FROM the
 * current folded value, never a baked keyframe).
 *
 * All functions here are pure unless noted. State trees never contain
 * undefined; null is reserved as the delete sentinel.
 */

import { interpolate } from "./interpolators.js";
import { blendUnderMode, defaultModeFor, interpKeyFor, isInterpKey, modeClaimsTrees, modeForBlend } from "./interp_modes.js";
import { MORPH_KEY, morphModeForBlend, morphModeIsActive, universalMorphToken } from "./morph_property.js";

/** Delete sentinel. A delta leaf of NONE deletes the key from the state. */
export const NONE = null;

/**
 * Pure function. True for plain object-literal trees (not arrays/class instances).
 *
 * @example isTree({a: 1}) // true
 * @example isTree([1, 2]) // false
 * @example isTree(null) // false
 */
export function isTree(x) {
  return x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
}

/**
 * Pure function. Deep-copies a delta/state tree. Non-tree values (numbers,
 * strings, arrays) are shared — treat arrays as immutable leaf values.
 *
 * @example copied({a: {b: 1}}) // {a: {b: 1}} (new objects)
 */
export function copied(tree) {
  if (!isTree(tree)) return tree;
  const out = {};
  for (const [k, v] of Object.entries(tree)) out[k] = copied(v);
  return out;
}

/**
 * Pure function. Deep-copies a subtree INCLUDING arrays and their elements —
 * the copy-on-write clone used before mutating a keyframed LIST in place.
 * `copied()` deliberately shares arrays (treating them as immutable leaves, the
 * fast path for the fold cache), so a SPARSE per-element list keyframe (see
 * mutBlendApply) must clone the whole list subtree first, or it would corrupt
 * the shared/cached array.
 *
 * @example copiedDeep({stops: [{offset: 0}]}) // {stops: [{offset: 0}]} (all new)
 * @example copiedDeep([[1, 2], [3, 4]]) // [[1, 2], [3, 4]] (nested arrays copied)
 */
export function copiedDeep(x) {
  if (Array.isArray(x)) return x.map(copiedDeep);
  if (isTree(x)) {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = copiedDeep(v);
    return out;
  }
  return x;
}

/**
 * Pure function. Returns state with delta applied at full strength.
 * NONE leaves delete; tree leaves recurse; other leaves overwrite/add.
 *
 * @example applied({a: 1, b: 2}, {a: 10, b: NONE, c: 3}) // {a: 10, c: 3}
 * @example applied({o: {x: 1, y: 2}}, {o: {x: 5}}) // {o: {x: 5, y: 2}}
 */
export function applied(state, delta) {
  return blendApplied(state, delta, 1);
}

/**
 * Pure function. Applies `delta` to `state` at tween strength `alpha` in [0,1].
 *
 * Semantics (the tween core of PowerRP):
 *   - alpha === 0 → state unchanged.
 *   - numeric-ish leaves interpolate from the CURRENT state value (lazy start
 *     capture, tweenline-style) toward the delta target via `interpolate`.
 *   - discrete changes (non-interpolable values, additions, deletions) apply
 *     as soon as alpha > 0.
 *   - a leaf whose PER-PROPERTY INTERP MODE (core/interp_modes.js) says
 *     otherwise blends by that mode's law instead. The mode is a plain sibling
 *     property `<key>~interp` with no machinery of its own, and it STEPS at the
 *     transition's start (the incoming delta's mode governs from frame 1).
 *     Absent falls through to core/interp_modes.defaultModeFor, which is "tween"
 *     (whose law IS `interpolate`, so nothing moves) for every value shape EXCEPT
 *     a pair of object-shaped PAINTS — those default to "blend", the cross-fade
 *     the user asked for on material switches. Endpoints are unaffected either
 *     way: only the strictly-interior frames of a transition differ.
 *
 * @example blendApplied({x: 0}, {x: 10}, 0.5) // {x: 5}
 * @example blendApplied({x: 0}, {x: 10}, 0) // {x: 0}
 * @example blendApplied({s: "a"}, {s: "b"}, 0.01) // {s: "b"} (discrete: alpha > 0)
 * @example blendApplied({a: 1}, {b: 2}, 0.5) // {a: 1, b: 2} (addition: alpha > 0)
 * @example blendApplied({x: 0, "x~interp": "step"}, {x: 10}, 0.5) // {x: 10, "x~interp": "step"} (standing mode: x steps)
 * @example blendApplied({x: 0}, {x: 10, "x~interp": "step"}, 0.5) // {x: 10, "x~interp": "step"} (the mode steps first, then governs x)
 */
export function blendApplied(state, delta, alpha) {
  if (alpha <= 0) return copied(state);
  const out = copied(state);
  mutBlendApply(out, delta, alpha);
  return out;
}

/**
 * Command (mutates `state` in place) — blendApplied's internal recursion.
 * Module-private on purpose: the fold (core/document.js slideState) uses the
 * COPYING blendApplied because folded states are CACHED and shared — an
 * in-place step would corrupt every earlier cached state. (A prior comment
 * promised this as an exported "fold hot path" optimization; no such
 * consumer exists, and the cache makes it unsound there.)
 *
 * PER-PROPERTY INTERP MODES (core/interp_modes.js) are consulted HERE, at the
 * one point a leaf actually blends. `outgoing` is the state as it stood BEFORE
 * this delta touched anything — captured per recursion level because the mode
 * companion `<key>~interp` is an ordinary delta leaf and may be written EARLIER
 * in this very loop (JS object order is insertion order, so a delta that lists
 * `x~interp` before `x` would otherwise have already clobbered the standing
 * mode by the time `x` asks for it). Reading the mode from a pre-loop snapshot
 * makes the result independent of the delta's key order, which the fold's
 * determinism requires.
 */
function mutBlendApply(state, delta, alpha) {
  // Shallow is enough: a mode governs a leaf at THIS level, and each recursion
  // step takes its own snapshot of the sub-object it is about to mutate.
  const outgoing = { ...state };
  // THE UNIVERSAL MORPH SEAM (core/morph_property.js), and it runs BEFORE the
  // per-leaf loop because it is a fact about the WHOLE BAG rather than about any
  // one leaf. That is the user's ruling made structural: "it shouldn't just be a
  // subset of a widget type… it would just be under a universal option". A gear's
  // tooth count, an icon's name, an equation's source and the widget's whole
  // `type` all change the outline, and none of them is the leaf the author sets
  // the mode on.
  //
  // THIS IS ALSO WHERE THE ENDPOINT LAW IS ENFORCED, which is the jiggle fix
  // (workstream II). Here — and ONLY here — both endpoints of the transition are
  // in hand: `outgoing` IS the from-fold (the deltas' lazy start capture) and
  // `applied(outgoing, delta)` IS the to-state. Every consumer downstream sees a
  // token carrying those two FIXED bags, so no later stage can re-derive an
  // alignment from a mid-tween value. Doing it at the leaf level was impossible
  // by construction: a leaf blend sees two VALUES and cannot reach the bag.
  // Only the strictly-interior frames of a transition can carry a token. The
  // alpha-1 arm is how the TO endpoint is computed (via `applied`), so minting
  // there would recurse forever — and it must not mint anyway: alpha 1 IS the
  // document's own stored values, per the endpoint law enforced below.
  if (alpha < 1) mutMorphProperty(state, outgoing, delta, alpha);
  for (const [key, val] of Object.entries(delta)) {
    // THE MODE IS RESOLVED BEFORE THE BRANCH DISPATCH, not inside the leaf arm,
    // because A PAINT IS A TREE. `{type: "material", material: {…}}` and
    // `{type: "linearGradient", stops: […]}` are both plain objects, so an
    // un-hoisted mode lookup never sees them: they take the `isTree` arm and get
    // MERGED KEY-WISE, which for two different paints produces a chimera that is
    // neither (measured — a crt↔gradient switch folded to
    // `{type: "material", stops: [], material: {id: "crt"}}` mid-transition).
    // That merge is right for a SPARSE keyframe patch and wrong for a whole-paint
    // switch, and only a mode can tell them apart. So: resolve the mode first;
    // a mode that CLAIMS the leaf (`claimsTrees`) handles the whole subtree as
    // one value, and everything else falls through to the untouched branches
    // below, byte-identically.
    const modeKey = interpKeyFor(key);
    const storedMode = outgoing[modeKey] ?? delta[modeKey];
    if (val !== NONE && alpha < 1 && key in state) {
      // THE DEFAULT-MODE SEAM (core/interp_modes.defaultModeFor). A leaf with
      // NOTHING stored is not automatically "tween": a pair of object-shaped
      // PAINTS defaults to `blend`, per the user's "if I switch between any of
      // those material options, it should be blend by default". A STORED mode
      // still wins outright, so an author who wants a material to snap picks
      // `step` and this never second-guesses them.
      const mode = storedMode !== undefined
        ? modeForBlend(outgoing[modeKey], delta[modeKey])
        : defaultModeFor(state[key], val, key);
      if (modeClaimsTrees(mode)) {
        state[key] = blendUnderMode(state[key], val, alpha, { key, mode });
        continue;
      }
    }
    if (val === NONE) {
      delete state[key];
    } else if (isTree(val)) {
      // STRUCTURAL keyframing — a sparse per-element LIST keyframe: an
      // object-shaped delta over an ARRAY state addresses elements by index
      // (e.g. delta {stops: {1: {offset: 0.8}}} over state {stops: [...]}). Keep
      // the ARRAY shape (never rebuild it as an object) and recurse per index.
      // The array is shared from copied() (which treats arrays as immutable
      // leaves), so copy-on-write the whole list subtree before mutating.
      if (Array.isArray(state[key])) {
        state[key] = copiedDeep(state[key]);
      } else if (!isTree(state[key])) {
        state[key] = {};
      }
      mutBlendApply(state[key], val, alpha);
    } else if (key in state) {
      // THE ENDPOINT IS NOT A MODE'S CALL. At alpha 1 the answer IS the stored
      // target — that is what `applied()` means and what makes the fold
      // (core/document.js slideState) the document's own values rather than a
      // mode's opinion of them. Enforced HERE, at the one call site, rather than
      // trusted to every registered blend: a future `fade` or `morph` that
      // returned something else at 1 would silently corrupt every folded slide
      // state, the caches built on them, and every export. `interpolate` already
      // short-circuits both endpoints; this extends the same guarantee to modes.
      // (alpha <= 0 cannot reach here at all — blendApplied returns early.)
      if (alpha >= 1) {
        state[key] = interpolate(state[key], val, 1); // === copied(val) semantics
      } else {
        // The mode STEPS at the transition's start: the delta's mode (if it sets
        // one) governs from the first frame, else the standing one, else the
        // DEFAULT-MODE SEAM's answer for this leaf.
        //
        // THE DEFAULT IS CONSULTED HERE TOO, and it did not used to be — this arm
        // read `modeForBlend(stored, delta)` alone, which falls back to "tween"
        // unconditionally. That was invisible while the only default was `blend`
        // (a paint is never a scalar, so this arm could not reach it — as the note
        // this replaces correctly said), and it became wrong the moment a SCALAR
        // leaf had a default: `type` defaults to `morph`, and without this line a
        // rect→circle keyframe silently took the tween law and snapped, with the
        // author's chosen interp never consulted. One expression, both arms, one
        // rule — a stored mode still wins outright in either.
        const mode = storedMode !== undefined
          ? modeForBlend(outgoing[modeKey], delta[modeKey])
          : defaultModeFor(state[key], val, key);
        state[key] = blendUnderMode(state[key], val, alpha, { key, mode });
      }
    } else {
      // An ADDITION is discrete under every mode (there is no `a` to blend from
      // — this is the "additions apply as soon as alpha > 0" rule), so it does
      // not consult the registry. A mode that wants a say in appearance is
      // asking for the `active`/`visible` property's mode, not for this branch.
      state[key] = copied(val);
    }
  }
}

/**
 * Command (mutates `state`'s `morph` leaf). THE UNIVERSAL MORPH MINT — writes the
 * endpoint-carrying token (core/morph_property.js) onto a mid-transition item bag,
 * or leaves the bag untouched when this transition has no morph to run.
 *
 * ── WHY IT IS GATED ON `type`, NOT ON THE `morph` KEY ────────────────────────
 * The token must be minted whenever a WIDGET crosses a transition, INCLUDING the
 * overwhelmingly common case where the author has stored no mode at all (absent =
 * auto). So the gate cannot be "does this bag have a `morph` key" — that would
 * make the default unreachable. It is instead "is this bag a WIDGET", answered by
 * the one field every widget has and no sub-tree does: a string `type`.
 *
 * That test is deliberately narrow. `mutBlendApply` recurses into every nested
 * object in the document — paints, gradients, effect bundles, point lists — and
 * none of them is a widget. Minting a token onto one would put a `morph` key
 * where nothing reads it and where serialization would carry it forever.
 *
 * ── WHY IT SHORT-CIRCUITS ON AN UNCHANGED BAG ────────────────────────────────
 * The endpoints must actually DIFFER for there to be anything to morph. A
 * transition that moves an item without changing its shape (the ordinary case —
 * x, y, opacity, rotation) mints nothing at all, so every such document folds
 * byte-identically to before this feature and pays nothing. The real outline
 * comparison happens at the RENDER seam, which is the only place outlines exist;
 * this is the cheap structural pre-filter that keeps that seam off the hot path.
 *
 * THE ENDPOINTS THEMSELVES ARE NEVER TOUCHED: at alpha ≥ 1 (`applied`) the caller
 * has already returned, and at alpha ≤ 0 `blendApplied` returned before this ran.
 * So a folded slide state never carries a token, and no saved document, cached
 * fold or still export moves a byte.
 *
 * Args:
 *   state (object): the bag being mutated (already a copy)
 *   outgoing (object): the bag as it stood BEFORE this delta — the FROM endpoint
 *   delta (object): the delta being applied
 *   alpha (number): transition strength, strictly in (0, 1) at this point
 *
 * @example // a non-widget sub-tree is never touched:
 * @example (() => { const s = {offset: 0}; mutMorphProperty(s, {offset: 0}, {offset: 1}, 0.5); return "morph" in s; })() // false
 */
function mutMorphProperty(state, outgoing, delta, alpha) {
  if (typeof outgoing.type !== "string" || !isTree(delta)) return;
  const mode = morphModeForBlend(outgoing[MORPH_KEY], delta[MORPH_KEY]);
  if (!morphModeIsActive(mode)) return;
  // The TO endpoint, built by applying this delta at FULL strength to the
  // outgoing bag. That is the definition of the transition's far end, and it is
  // the same computation `applied()` performs — reused rather than re-derived so
  // the two cannot disagree about what "the end of this transition" means.
  const toState = applied(outgoing, delta);
  // NOTHING ABOUT THE WIDGET'S FORM CHANGED — no morph, no token, no cost. The
  // shape-bearing leaves are unknown to core (a plugin owns them), so the honest
  // cheap test is whether the delta changed ANY leaf that is not pure placement.
  if (!morphEndpointsDiffer(outgoing, toState)) return;
  state[MORPH_KEY] = universalMorphToken(mode, outgoing, toState, alpha);
}

/**
 * Pure function. Could these two endpoint states possibly have DIFFERENT
 * outlines? The structural pre-filter in front of the render seam's real
 * outline comparison.
 *
 * IT IS A DENYLIST OF PLACEMENT KEYS, NOT AN ALLOWLIST OF SHAPE KEYS, and that
 * direction is the whole point. Which leaves define a widget's ink is PLUGIN
 * knowledge and an open set — a gear's `teeth`, an icon's `icon`, an equation's
 * `latex`, a shapeshifter's family, and whatever the next widget invents. An
 * allowlist would silently fail to morph every widget it had not been taught
 * about, which is precisely the per-key failure this universal property replaces.
 * A denylist fails the other way: a NEW leaf defaults to "might change the
 * outline", so the worst case is asking the render seam a question it answers
 * cheaply, rather than a morph the author asked for silently not happening.
 *
 * THE DENIED KEYS ARE THE SIMILARITY TRANSFORM AND ITS KIN — position, size,
 * rotation, z, opacity, visibility. Every one of them is carried by the NODE'S
 * BOX at render time (render_gpu/ports.js maps the engine's unit output through
 * the current tweened w/h), so a change in any of them moves or scales the same
 * outline rather than producing a different one. Morphing on a pure resize would
 * count the box change twice — the exact trap the render seam is pinned against.
 *
 * @example morphEndpointsDiffer({type: "rect", w: 10}, {type: "rect", w: 20}) // false (a pure resize rides the box)
 * @example morphEndpointsDiffer({type: "rect"}, {type: "circle"}) // true (a retype)
 * @example morphEndpointsDiffer({type: "latex", latex: "a"}, {type: "latex", latex: "b"}) // true (a re-edit)
 * @example morphEndpointsDiffer({type: "gear", teeth: 8}, {type: "gear", teeth: 12}) // true (a parameter the plugin draws with)
 * @example morphEndpointsDiffer({type: "rect", x: 0}, {type: "rect", x: 50}) // false (pure placement)
 */
export function morphEndpointsDiffer(from, to) {
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (MORPH_PLACEMENT_KEYS.has(key) || isInterpKey(key) || key === MORPH_KEY) continue;
    if (!deepEqual(from[key], to[key])) return true;
  }
  return false;
}

/**
 * The leaves a morph must IGNORE — the similarity transform plus the universal
 * presentation knobs. A change in any of these moves, scales, spins or fades the
 * SAME outline, and the render seam already carries all of it through the node's
 * own box and opacity. See morphEndpointsDiffer for why this is a denylist.
 */
const MORPH_PLACEMENT_KEYS = new Set([
  "x", "y", "w", "h", "z", "rotation", "rotationAnchor", "opacity", "active", "name",
]);

/**
 * Pure function. Does `state` already satisfy `delta`? (Would applying it at
 * full strength change nothing?) The foundation for conditions/skip logic.
 *
 * @example contains({a: 1, b: 2}, {a: 1}) // true
 * @example contains({a: 1}, {a: 2}) // false
 * @example contains({a: 1}, {b: NONE}) // true (already absent)
 */
export function contains(state, delta) {
  for (const [key, val] of Object.entries(delta)) {
    if (val === NONE) {
      if (isTree(state) && key in state) return false;
    } else if (isTree(val)) {
      if (!isTree(state[key]) || !contains(state[key], val)) return false;
    } else if (!isTree(state) || state[key] !== val) {
      return false;
    }
  }
  return true;
}

/**
 * Pure function. Structural deep equality for state/delta leaf values —
 * primitives by identity, arrays element-wise, plain-object trees key-wise. The
 * comparison diffState uses to decide whether an interaction actually CHANGED a
 * property. Covers every shape a state leaf can hold: numbers, `=equation`/
 * literal strings, arrays (gradient stops, point lists), and nested trees.
 *
 * @example deepEqual(5, 5) // true
 * @example deepEqual("=100+shape_2.x", "=100+shape_2.x") // true
 * @example deepEqual([1, 2], [1, 2]) // true
 * @example deepEqual({x: 1, y: 2}, {x: 1, y: 3}) // false
 * @example deepEqual(5, "5") // false (no type coercion)
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isTree(a) && isTree(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Pure function. The MINIMAL delta between two flat state objects over `keys`:
 * a delta holding ONLY the keys whose `newState` value DIFFERS (deepEqual) from
 * `startState`. Unchanged keys are OMITTED — so a commit built from this delta
 * NEVER overwrites the document's stored raw value for them, and a literal OR
 * an `=equation` string on an untouched key survives intact. This is how a drag
 * that moves one axis (or a resize that stretches one dimension) leaves the
 * equations bound to the axes it never touched alone (the interaction-commit
 * rule: "only overwrite a property if it changed — that goes for ANY
 * property"). A key that genuinely changed writes its new value, overriding any
 * equation there — grabbing that axis is meant to.
 *
 * `startState` must be the RESOLVED start pose (the drag-start basis, e.g.
 * node.state.*), so "did this axis move" compares the new value against what
 * the axis actually SHOWED at grab time, not against a raw equation string.
 *
 * @param {object} startState - resolved start values (the drag-start basis)
 * @param {object} newState - the interaction's computed new values
 * @param {string[]} keys - the property keys to compare
 * @returns {object} a flat delta containing only the changed keys
 *
 * @example diffState({x: 10, y: 20}, {x: 15, y: 20}, ["x", "y"]) // {x: 15} (y unchanged → OMITTED; its equation survives)
 * @example diffState({x: 0, y: 0, w: 100, h: 50}, {x: 0, y: 0, w: 120, h: 50}, ["x", "y", "w", "h"]) // {w: 120}
 * @example diffState({x: 5}, {x: 5}, ["x"]) // {} (no change → empty delta)
 */
export function diffState(startState, newState, keys) {
  const out = {};
  for (const key of keys)
    if (!deepEqual(startState[key], newState[key])) out[key] = newState[key];
  return out;
}

/**
 * Pure function. Reads the leaf at a key path, or undefined. Descends into
 * both object trees AND arrays (an integer-like path segment indexes a list —
 * e.g. a gradient stop's offset lives at [..., "stops", 1, "offset"]), so the
 * keyframe path helpers reach individual list elements.
 *
 * @example getPath({items: {a: {x: 5}}}, ["items", "a", "x"]) // 5
 * @example getPath({stops: [{offset: 0.2}, {offset: 0.8}]}, ["stops", 1, "offset"]) // 0.8
 * @example getPath({}, ["nope"]) // undefined
 */
export function getPath(tree, path) {
  let cur = tree;
  for (const key of path) {
    if ((!isTree(cur) && !Array.isArray(cur)) || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Pure function. Returns a new tree with `value` set at `path` (creating
 * intermediate nodes). Passing NONE as value records a deletion leaf.
 *
 * ARRAY-AWARE (structural keyframing): descending through an EXISTING array
 * segment CLONES the array (never rebuilds it as an object), so a per-index
 * write (e.g. a gradient stop's [..., "stops", 2, "offset"]) updates that
 * element IN PLACE — preserving the array shape, its sibling elements, and the
 * touched element's other keys (a keyframed offset keeps the stop's color).
 * (Was the bug behind `parsePaint: a gradient needs >= 2 stops, got
 * {"2":{offset:…}}`: the old `isTree(tree) ? … : {}` turned the stops ARRAY
 * into a numeric-keyed object, dropping every other stop + the color.) When the
 * segment is ABSENT/non-container a fresh OBJECT is created — a sparse
 * numeric-keyed delta patch, which blendApplied merges element-wise into the
 * base array (never a holey array, which would corrupt whole-list interpolation).
 *
 * @example setPath({}, ["items", "a", "x"], 5) // {items: {a: {x: 5}}}
 * @example setPath({a: 1}, ["b"], 2) // {a: 1, b: 2}
 * @example setPath({stops: [{offset: 0, color: "#f00"}, {offset: 1, color: "#00f"}]}, ["stops", 1, "offset"], 0.7) // {stops: [{offset: 0, color: "#f00"}, {offset: 0.7, color: "#00f"}]}
 * @example setPath({}, ["stops", 2, "offset"], 0.7) // {stops: {2: {offset: 0.7}}} (sparse patch: no base array)
 */
export function setPath(tree, path, value) {
  if (path.length === 0) return value;
  const out = Array.isArray(tree) ? tree.slice() : isTree(tree) ? { ...tree } : {};
  out[path[0]] = setPath(out[path[0]], path.slice(1), value);
  return out;
}

/**
 * Pure function. Returns a new tree with the leaf at `path` removed, pruning
 * empty intermediate OBJECT nodes. Removing a missing path is a no-op.
 *
 * ARRAY-AWARE (structural keyframing): descends into arrays (clone), and a
 * final array-index removal SPLICES the element out (reindexing — no hole),
 * so unkeyframing one gradient stop leaves a well-formed list. Emptied ARRAYS
 * are NOT pruned (an empty list is a valid leaf); emptied OBJECTS still are.
 *
 * @example deletePath({a: {x: 1, y: 2}}, ["a", "x"]) // {a: {y: 2}}
 * @example deletePath({a: {x: 1}}, ["a", "x"]) // {} (pruned)
 * @example deletePath({stops: [{offset: 0}, {offset: 1}]}, ["stops", 0]) // {stops: [{offset: 1}]} (spliced)
 */
export function deletePath(tree, path) {
  if (!isTree(tree) && !Array.isArray(tree)) return tree;
  const [head, ...rest] = path;
  if (!(head in tree)) return tree;
  const out = Array.isArray(tree) ? tree.slice() : { ...tree };
  if (rest.length === 0) {
    if (Array.isArray(out)) out.splice(Number(head), 1);
    else delete out[head];
  } else {
    out[head] = deletePath(out[head], rest);
    if (isTree(out[head]) && Object.keys(out[head]).length === 0) delete out[head];
  }
  return out;
}

/**
 * Pure function. Flattens a delta tree into [path, value] leaf entries
 * (deterministic key order). Used by the keyframe panel.
 *
 * @example leaves({items: {a: {x: 1, y: 2}}}) // [[["items","a","x"],1],[["items","a","y"],2]]
 * @example leaves({a: NONE}) // [[["a"], null]]
 */
export function leaves(delta, prefix = []) {
  const out = [];
  for (const [key, val] of Object.entries(delta)) {
    if (isTree(val)) out.push(...leaves(val, [...prefix, key]));
    else out.push([[...prefix, key], val]);
  }
  return out;
}
