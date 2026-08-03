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
import { blendUnderMode, defaultModeFor, interpKeyFor, modeClaimsTrees, modeForBlend } from "./interp_modes.js";

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
