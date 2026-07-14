/**
 * The PowerRP document model.
 *
 * A document is ONLY:
 *   { meta: {name, slideW, slideH}, slides: [{id, name, duration, delta}] }
 *
 * There is no separate items table — EVERYTHING is deltas (slide 0's delta
 * creates the initial items). Slide N's full state = fold of deltas 0..N over
 * the empty state. An item appearing in multiple slides IS the "symlink":
 * same UUID, same object, until a delta deletes it. Slides have permanent
 * UUIDs; slide NUMBERS are display-only (indices shift on insert).
 *
 * State shape produced by folding:
 *   { items: { <itemId>: {type, x, y, z, ...plugin state} } }
 *
 * Documents are treated as IMMUTABLE — every edit returns a new document.
 * That makes the undo snapshot log and the per-document fold cache trivial
 * (WeakMap keyed on document identity).
 */

import { NONE, blendApplied, copied, getPath, setPath, deletePath, leaves } from "./deltas.js";

/** Query (reads crypto). Random 8-char id — short but collision-safe at presentation scale. */
export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.floor(Math.random() * 2 ** 48).toString(36);
}

/**
 * Pure function (modulo uuid randomness). A fresh single-slide document.
 *
 * @example // newDocument().slides.length === 1; newDocument().meta.slideW === 1280
 */
export function newDocument() {
  // Every document is born with THE camera (one per document, manifest spec):
  // a bbox item covering the meta slide rect, tweenable like any other item.
  const cameraId = uuid();
  return {
    meta: { name: "Untitled", slideW: 1280, slideH: 720, fps: 120 },
    slides: [{
      id: uuid(),
      name: "Slide 1",
      duration: 0.5,
      delta: {
        items: {
          [cameraId]: { type: "camera", name: "Camera", x: 0, y: 0, w: 1280, h: 720, z: 1000, active: true },
        },
      },
    }],
  };
}

// ── Folding (with per-document cache) ────────────────────────────────────────

const foldCache = new WeakMap(); // doc → Array<state at slide i, fully applied>

/**
 * Query (memoized on document identity). Full state at slide `index` with all
 * deltas 0..index applied at alpha 1.
 */
export function slideState(doc, index) {
  let states = foldCache.get(doc);
  if (!states) foldCache.set(doc, (states = []));
  if (states.length > index) return states[index];
  let cur = states.length ? states[states.length - 1] : {};
  for (let i = states.length; i <= index; i++) {
    // A disabled slide's delta is skipped entirely — "slides are just deltas,
    // so toggling a slide off toggles its delta out of the fold".
    cur = doc.slides[i].enabled === false ? cur : blendApplied(cur, doc.slides[i].delta, 1);
    states.push(cur);
  }
  return states[index];
}

/**
 * Pure function (uses memoized fold). State mid-transition INTO slide `index`
 * at tween strength `alpha` (0 = previous slide exactly, 1 = slide `index`).
 * This is the single evaluation point for editor, presenter, and CLI renderer.
 *
 * @example // foldState(doc, 2, 0.5) — halfway between slide 1 and slide 2
 */
export function foldState(doc, index, alpha = 1) {
  // Slide 0 has no predecessor to tween from — it is always fully applied.
  if (index === 0 || alpha >= 1) return slideState(doc, index);
  if (doc.slides[index].enabled === false) return slideState(doc, index - 1);
  return blendApplied(slideState(doc, index - 1), doc.slides[index].delta, alpha);
}

// ── Keyframe edits (all pure: return a new document) ─────────────────────────

/** Pure function. Sets a keyframe leaf in slide `index`'s delta. */
export function keyframed(doc, index, path, value) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, delta: setPath(s.delta, path, value) } : s);
  return { ...doc, slides };
}

/** Pure function. Removes a keyframe leaf from slide `index`'s delta. */
export function unkeyframed(doc, index, path) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, delta: deletePath(s.delta, path) } : s);
  return { ...doc, slides };
}

/** Pure function. True if slide `index`'s delta keys this exact path. */
export function hasKeyframe(doc, index, path) {
  return getPath(doc.slides[index].delta, path) !== undefined;
}

/**
 * Pure function. Slide indices whose delta keys `path`, ascending. Powers the
 * inspector's prev/next-keyframe jumps.
 *
 * @example // keyframeIndices(doc, ["items","ab12","x"]) → [0, 3, 7]
 */
export function keyframeIndices(doc, path) {
  const out = [];
  doc.slides.forEach((s, i) => {
    if (getPath(s.delta, path) !== undefined) out.push(i);
  });
  return out;
}

// ── Item edits ───────────────────────────────────────────────────────────────

/** Pure function. Creates an item (full initial state) in slide `index`'s delta. Returns [doc, itemId]. */
export function withNewItem(doc, index, state) {
  const id = uuid();
  return [keyframed(doc, index, ["items", id], copied(state)), id];
}

/** Pure function. Deletes an item as of slide `index` (NONE keyframe). Earlier slides keep it. */
export function withItemDeleted(doc, index, itemId) {
  let out = keyframed(doc, index, ["items", itemId], NONE);
  // Later slides' keyframes for a dead item are meaningless — prune them.
  for (let i = index + 1; i < out.slides.length; i++) out = unkeyframed(out, i, ["items", itemId]);
  return out;
}

/** Pure function. Removes an item FROM EXISTENCE: every keyframe of it on every slide. */
export function withItemPurged(doc, itemId) {
  let out = doc;
  for (let i = 0; i < doc.slides.length; i++) out = unkeyframed(out, i, ["items", itemId]);
  return out;
}

// ── Slide edits ──────────────────────────────────────────────────────────────

/** Pure function. Inserts an empty slide after `index`. Returns [doc, newIndex]. */
export function withNewSlide(doc, index) {
  const slide = { id: uuid(), name: `Slide ${doc.slides.length + 1}`, duration: 0.5, delta: {} };
  const slides = [...doc.slides];
  slides.splice(index + 1, 0, slide);
  return [{ ...doc, slides }, index + 1];
}

/** Pure function. Removes slide `index` (refuses to remove the last slide). */
export function withSlideDeleted(doc, index) {
  if (doc.slides.length <= 1) throw new Error("Cannot delete the only slide");
  const slides = doc.slides.filter((_, i) => i !== index);
  return { ...doc, slides };
}

/** Pure function. Toggles a slide's enabled flag (default true → false). */
export function withSlideToggled(doc, index) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, enabled: s.enabled === false } : s);
  return { ...doc, slides };
}

/** Pure function. Moves slide `index` by `offset` (clamped). */
export function withSlideMoved(doc, index, offset) {
  const to = Math.max(0, Math.min(doc.slides.length - 1, index + offset));
  if (to === index) return doc;
  const slides = [...doc.slides];
  const [s] = slides.splice(index, 1);
  slides.splice(to, 0, s);
  return { ...doc, slides };
}

// ── Z-order maintenance ──────────────────────────────────────────────────────
// UI reorder ops set z to the midpoint between neighbors (bisect), then this
// renormalizes every KEYFRAMED z document-wide to 1, 2, 3... (order-preserving
// over the set of distinct stored values) so bisection never runs out of
// precision. Tweened in-between z values are ephemeral and never normalized.

/** Pure function. Document with all stored z keyframes renormalized to 1..N. */
export function withNormalizedZ(doc) {
  const zs = new Set();
  for (const s of doc.slides)
    for (const [path, value] of leaves(s.delta))
      if (path[path.length - 1] === "z" && typeof value === "number") zs.add(value);
  const sorted = [...zs].sort((a, b) => a - b);
  const map = new Map(sorted.map((z, i) => [z, i + 1]));
  const slides = doc.slides.map((s) => {
    let delta = s.delta;
    for (const [path, value] of leaves(s.delta))
      if (path[path.length - 1] === "z" && map.has(value)) delta = setPath(delta, path, map.get(value));
    return { ...s, delta };
  });
  return { ...doc, slides };
}

/**
 * Pure function. New z for an item moved one step forward/backward among the
 * given z-ascending [itemId, z] pairs — midpoint with the far neighbor
 * (bisect), or ±1 past the end.
 *
 * @example bisectedZ([["a",1],["b",2],["c",3]], "a", +1) // 2.5 (between b and c)
 * @example bisectedZ([["a",1],["b",2]], "b", +1) // 3 (already frontmost: past end)
 * @example bisectedZ([["a",1],["b",2],["c",3]], "c", -1) // 1.5
 */
export function bisectedZ(pairs, itemId, direction) {
  const i = pairs.findIndex(([id]) => id === itemId);
  if (i === -1) throw new Error(`bisectedZ: unknown item ${itemId}`);
  const j = i + direction;
  if (j < 0) return pairs[0][1] - 1;
  if (j >= pairs.length) return pairs[pairs.length - 1][1] + 1;
  const k = j + direction;
  if (k < 0) return pairs[0][1] - 1;
  if (k >= pairs.length) return pairs[pairs.length - 1][1] + 1;
  return (pairs[j][1] + pairs[k][1]) / 2;
}

// ── (De)serialization ────────────────────────────────────────────────────────

/** Pure function. Document → pretty JSON (the .powerrp.json save format). */
export function serialize(doc) {
  return JSON.stringify(doc, null, 2);
}

/** Pure function. JSON → document; validates the basic shape loudly. */
export function deserialize(json) {
  const doc = JSON.parse(json);
  if (!doc.meta || !Array.isArray(doc.slides) || doc.slides.length === 0)
    throw new Error("Invalid PowerRP document: expected {meta, slides[≥1]}");
  for (const s of doc.slides)
    if (typeof s.id !== "string" || typeof s.delta !== "object")
      throw new Error(`Invalid slide: ${JSON.stringify(s).slice(0, 80)}`);
  return doc;
}

/**
 * Pure function. All keyframe leaf entries across slides, chronological —
 * the keyframe panel's data: [{slideIndex, slideId, path, value}].
 */
export function allKeyframes(doc) {
  return doc.slides.flatMap((s, slideIndex) =>
    leaves(s.delta).map(([path, value]) => ({ slideIndex, slideId: s.id, path, value })));
}
