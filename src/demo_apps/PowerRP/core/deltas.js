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
 *
 * @example blendApplied({x: 0}, {x: 10}, 0.5) // {x: 5}
 * @example blendApplied({x: 0}, {x: 10}, 0) // {x: 0}
 * @example blendApplied({s: "a"}, {s: "b"}, 0.01) // {s: "b"} (discrete: alpha > 0)
 * @example blendApplied({a: 1}, {b: 2}, 0.5) // {a: 1, b: 2} (addition: alpha > 0)
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
 */
function mutBlendApply(state, delta, alpha) {
  for (const [key, val] of Object.entries(delta)) {
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
      state[key] = interpolate(state[key], val, alpha);
    } else {
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
