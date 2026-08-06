/**
 * THE LIVE ANALYSIS REGISTRY — one ring buffer of magnitude columns per analysis
 * node, and the pre-pass that hands them to `sceneIR`.
 *
 * Sibling of image_registry.js / video_registry.js / tile_registry.js: the mutable
 * home for a resource the pure layers must not own. Everything about the DATA and
 * the DRAWING is in core/analysis_display.js, which is pure and bare-node tested;
 * what lives here is the Map, its lifetime, and the descriptor shape.
 *
 * ── THE HISTORY IS DATA, WHICH IS THE WHOLE POINT (R7-5) ────────────────────
 * The spectrogram this replaces kept its history in the PIXELS of a DOM canvas and
 * scrolled by blitting the canvas onto itself, so a zoom — which resizes the
 * element and resets its backing store — ERASED it. That was the first symptom the
 * user reported. Here the history is `count` columns of floats that no view change
 * can touch: a zoom re-renders the same columns at a new size, and the picture is
 * continuous across it. core/analysis_display.js's header states the full
 * four-symptom diagnosis.
 *
 * ── WHY A PRE-PASS AND NOT A GLOBAL THE WALKER READS ────────────────────────
 * `prepareLiveAnalysis` is called by the surfaces that HAVE live audio (the editor
 * canvas, the presenter) and its result is passed to `sceneIR` as an ordinary
 * argument, exactly like `mapTiles` and `scene3d`. render_gpu/ports.js states the
 * law and the reason: a global reached into by the walker would put live samples
 * into every export and into cli/render.js, where they are neither reproducible
 * nor, headlessly, even available. Surfaces that pass nothing get a node's static
 * form, which is the honest picture of a document that has no sound in it.
 *
 * THIS IS NOT RECORDABLE STATE. Read CLAUDE.md's "four kinds of state" and
 * core/analysis_display.js's header before assuming otherwise: live analysis of a
 * live AudioContext fails the Δt = 0 test, the same way a video PLAYER's current
 * frame does. `OfflineAudioContext` is the honest path to making it recordable and
 * is deliberately not built here.
 */

import {
  analysisHistoryColumns, createColumnRing, pushColumn, ringColumns,
} from "../../core/analysis_display.js";

/** itemId → {kind, ring}. Written by web/audioMirror.svelte.js's analysis
 *  subscriptions, read once per frame by prepareLiveAnalysis. */
const rings = new Map();

/**
 * Command (mutates the registry). Record one analysis frame for an item.
 *
 * RESETS THE RING ON A SHAPE CHANGE rather than reshaping it. A different bin
 * count or a different display kind means the columns already held were measured
 * on a different axis, and stretching them onto a new one would draw a frequency
 * scale that lies. An honest restart of a display whose meaning changed beats a
 * continuous picture of two incompatible things.
 *
 * @param {string} itemId - the analysis node's item id
 * @param {string} kind - the spec's `overlay` value ("meter" | "spectrum")
 * @param {ArrayLike<number>} values - one column of magnitudes in 0..1
 */
export function pushAnalysisFrame(itemId, kind, values) {
  const held = rings.get(itemId);
  const ring = held && held.kind === kind && held.ring.bins === values.length
    ? held.ring
    : createColumnRing(values.length, analysisHistoryColumns(kind));
  if (ring !== held?.ring) rings.set(itemId, { kind, ring });
  pushColumn(ring, values);
  lastPushAt.set(itemId, performance.now());
  for (const cb of frameListeners) cb(itemId);
}

// ── THE REPAINT WAKE ─────────────────────────────────────────────────────────
//
// A USER-REPORTED BUG, and the reason this seam exists at all: *"The spectrogram
// doesnt update unless i move it btw its like its not trying to update."*
//
// THE SYMPTOM NAMED THE CAUSE. Moving the node changes DOCUMENT state, which
// invalidates the frame and forces a repaint — so you saw exactly one fresh
// column per drag. Pushing a column invalidates nothing, because live analysis is
// deliberately NOT document state (that is what keeps Δt = 0 byte-identical), so
// the ring filled and nothing ever asked for another frame.
//
// The DOM overlay this replaced did not have the bug because it owned its own
// canvas and drew from its own rAF. Moving the picture into the display list moved
// the drawing — and the REPAINT TRIGGER did not come with it.
//
// THIS IS NOT A NEW ANIMATION DRIVER. It is the same shape the app already uses
// for every other asynchronous producer that must wake a paint: image_registry's
// `onImageLoad`, `onSvgSourceLoad`, `onTextAssetLoad` and — the closest twin —
// `onVideoFrame`, which web/CanvasView.svelte turns into an `imageEpoch` bump
// gated on whether that source is actually on screen. A rAF loop invented here
// would be a THIRD idiom for a question the codebase has already answered twice,
// and it would have to live somewhere that could see the viewport, which this
// module deliberately cannot.
//
// THE LISTENER GETS THE ITEM ID so the consumer can apply that same on-screen
// gate. Waking a repaint for a node that is culled, on another slide, or scrolled
// out of view is the cost this argument exists to let the caller refuse.

/** Callbacks fired with an itemId on every pushed column. A Set so a component
 *  remounting cannot register twice. */
const frameListeners = new Set();

/**
 * Command. Subscribe to analysis columns arriving. Returns an unsubscribe.
 *
 * @param {(itemId: string) => void} cb - called with the item whose ring grew
 * @returns {() => void} unsubscribe
 */
export function onAnalysisFrame(cb) {
  frameListeners.add(cb);
  return () => frameListeners.delete(cb);
}

/**
 * How recently a column must have arrived for a display to count as MOVING, in
 * milliseconds. Columns arrive on the engine's rAF poll (~16 ms apart), so this is
 * ~15 missed frames — long enough that a stutter, a slow paint or a backgrounded
 * tab does not read as "audio stopped", short enough that the presenter's idle
 * loop shuts down promptly once it really has.
 */
const FLOWING_WINDOW_MS = 250;

/** itemId → the clock reading of its most recent column. */
const lastPushAt = new Map();

/**
 * Query (reads a clock). Is any of these nodes' analysis STILL ARRIVING?
 *
 * ── WHY THIS MEASURES INSTEAD OF ASKING `audioState.status` ─────────────────
 * The obvious implementation is "is there a display, and does the mirror say audio
 * is running". MEASURED, and it is wrong: in a real page the mirror can report
 * `blocked` while `engine.context.state` is `"running"` — its status is a record of
 * whether a GESTURE was harvested, not a reading of the context. So a predicate
 * built on it would freeze a display that is genuinely moving.
 *
 * The other half is the mirror image: a ring KEEPS its history after audio stops,
 * so "does this node have columns" stays true forever and would hold the
 * presenter's idle rAF loop open for the life of the session on any deck that ever
 * made a sound.
 *
 * Freshness answers both without believing anything: it is true exactly while
 * columns are landing. It needs no gesture bookkeeping, it cannot disagree with the
 * context, and it shuts itself off `FLOWING_WINDOW_MS` after the last column —
 * including when the session mutes, when the patch is deleted, and when the tab is
 * backgrounded and rAF stops delivering.
 *
 * @param {object[]} nodes - deriveRenderTree output (post-cull: an off-view node
 *   draws nothing, so it must not keep a repaint loop alive)
 * @param {number} [now] - the clock reading to compare against (injectable for tests)
 * @returns {boolean}
 */
export function analysisFlowing(nodes, now = performance.now()) {
  for (const node of nodes) {
    const held = rings.get(node.itemId);
    if (!held || node.plugin?.audioSpec?.overlay !== held.kind) continue;
    if (now - (lastPushAt.get(node.itemId) ?? -Infinity) <= FLOWING_WINDOW_MS) return true;
  }
  return false;
}

/**
 * Command (mutates the registry). Forget an item's history — what an unsubscribed
 * or deleted node owes the session. Without it the Map grows for the life of the
 * page, holding a buffer per node that ever existed.
 *
 * @param {string} itemId - the analysis node's item id
 */
export function dropAnalysis(itemId) {
  rings.delete(itemId);
  lastPushAt.delete(itemId);
}

/** Command (mutates the registry). Drop every ring — the test/dev reset seam. */
export function resetLiveAnalysis() {
  rings.clear();
  lastPushAt.clear();
}

/**
 * Query. THE PRE-PASS: the per-item live-analysis descriptors for `nodes`, in the
 * `Map<itemId, descriptor>` shape `sceneIR` threads into `emit()`'s 4th argument.
 *
 * Returns null when no node on this frame has any history, which is the
 * overwhelmingly common case (a deck with no audio, or one whose context has not
 * started). Null is the same signal every other pre-pass uses for "nothing here",
 * and it costs a document with no analysis nodes one loop over the node list.
 *
 * A node with a subscription but no data YET is absent from the map rather than
 * present with zero columns — the widget's own "no history" branch would draw the
 * same thing, and absence keeps "is anything live?" a single check.
 *
 * @param {object[]} nodes - deriveRenderTree output (nodes carry .plugin/.itemId)
 * @returns {Map<string, {kind: string, columns: Float32Array[]}>|null}
 */
export function prepareLiveAnalysis(nodes) {
  let out = null;
  for (const node of nodes) {
    const held = rings.get(node.itemId);
    if (!held || held.ring.count === 0) continue;
    // ASK THE NODE, not the ring, what kind it is: an item retyped from spectrum
    // to meter keeps its id, and drawing the old kind's columns into the new
    // widget is the class of stale-picture bug the shape check in
    // pushAnalysisFrame exists to prevent one frame later.
    if (node.plugin?.audioSpec?.overlay !== held.kind) continue;
    if (out === null) out = new Map();
    out.set(node.itemId, { kind: held.kind, columns: ringColumns(held.ring) });
  }
  return out;
}

/** Query. How many columns of history an item holds — for probes and tests, which
 *  need to assert that a zoom did NOT reset it. */
export function analysisColumnCount(itemId) {
  return rings.get(itemId)?.ring.count ?? 0;
}
