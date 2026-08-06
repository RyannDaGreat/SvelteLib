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
}

/** Command (mutates the registry). Drop every ring — the test/dev reset seam. */
export function resetLiveAnalysis() {
  rings.clear();
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
