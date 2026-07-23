/**
 * Transition frame rendering — the ONE pure-ish planner that turns a
 * (doc, index, alpha) transition state into rendered pixels, honoring the
 * transition TYPE (manifest Round 12 "Slides & TRANSITIONS"):
 *
 *   TWEEN — the delta tween. ONE evaluated state at (index, alpha) through the
 *     camera, exactly the existing thumbnail/present/CLI path.
 *   FADE  — a CROSSFADE of two COMPLETED-state snapshots: the previous slide
 *     (index-1 at alpha 1) and the new slide (index at alpha 1), blended by the
 *     curve-eased alpha. This is the manifest's "snapshot the previous state,
 *     snapshot the completed new one, crossfade between the two".
 *
 * The fade is a PURE FUNCTION OF ALPHA: at eased strength e the output is
 * frameA·(1-e) + frameB·e. Both endpoint frames depend only on the document, so
 * a mid-fade frame is fully determined by (doc, index, alpha) — the CLI can
 * render any fade frame the same way the presenter does (no hidden state).
 *
 * Compositing the two snapshots as full rasterized layers (drawn with
 * globalAlpha on a plain 2D canvas) is deliberate: crossfading at the RASTER
 * level is what makes the blend correct in the presence of overlapping content
 * and backdrop effects (blur/magnifier). Per-command opacity would double-blend
 * overlaps and cannot fade a whole composited scene as one layer. It matches the
 * manifest wording exactly (two snapshots, one crossfade).
 *
 * Both endpoint snapshots go through gpuService (WebGPU — THE renderer) and come
 * back as 2D canvases; this module only lays them over each other. It never
 * touches the GPU compositor internals (Opus8's fence).
 */

import { ease } from "../core/interpolators.js";
import { resolveTransition } from "../core/transitions.js";

// gpuService is browser-only (its Skia bootstrap uses Vite `?url` + import.meta.glob),
// so import it LAZILY on first use. This keeps transitionRender's PURE planners
// (fadeStrength, isFadeFrame) importable in bare node — their unit tests never call a
// render function, so the browser rasterizer is never pulled into node module
// resolution. The browser pays one dynamic import on the first transition frame.
let _renderCameraFrame = null;
async function renderCameraFrame(...args) {
  if (!_renderCameraFrame) _renderCameraFrame = (await import("./gpuService.js")).renderCameraFrame;
  return _renderCameraFrame(...args);
}

// ── Endpoint-snapshot memo (14.7 REOPENED root cause) ──────────────────────────
// The two completed-state frames a fade blends depend ONLY on (doc, index, size)
// — NEVER on alpha — so they are CONSTANT for the entire transition. Before this
// memo, renderTransitionFrame re-rendered BOTH snapshots (each a full fold +
// evaluate + GPU render + readPixels readback) for EVERY emitted rAF frame,
// serialized through gpuService's queue. At a real present size (fullscreen
// retina, ~2.8 Mpx x2 per frame) one crossfade frame took longer than the whole
// default 0.5s fade; PresentMode's paintToken then discarded every late
// completion and ZERO blend frames reached the screen — the user's "fade does
// not properly alpha blend" flick (probe: fade_starvation_probe.js: 0 distinct
// blend levels at 1470x956@dpr2 before this memo). Small canvases (the earlier
// 400x400 probes) rendered fast enough to mask it.
//
// Memoizing a pure async function keeps renderTransitionFrame pure in
// (doc, index, alpha) — same values, computed once (the core fold-cache
// precedent). Keyed by DOC OBJECT IDENTITY (WeakMap — the app's document
// updates are immutable, so any edit produces a new object and misses the
// cache; entries die with the doc) then by `${index}|${width}|${height}` (a
// mid-fade window resize re-renders at the new size). The registry is not in
// the key: it is per-document stable in this app. A REJECTED render is evicted
// so the next frame retries — the caller still sees the rejection LOUDLY
// (eviction is cache hygiene, not error handling).
const fadeSnapshotCache = new WeakMap(); // doc → Map<key, Promise<[prevCanvas, nextCanvas]>>

/** Query (memoized). The fade's two completed-state endpoint snapshots for
 *  slide `index` of `doc` at width×height: [prev (index-1 @ alpha 1),
 *  next (index @ alpha 1)]. One render per (doc, index, size) — every
 *  mid-fade frame after the first reuses the settled promise. */
function fadeSnapshots(doc, index, registry, width, height) {
  let byKey = fadeSnapshotCache.get(doc);
  if (!byKey) {
    byKey = new Map();
    fadeSnapshotCache.set(doc, byKey);
  }
  const key = `${index}|${width}|${height}`;
  let promise = byKey.get(key);
  if (!promise) {
    promise = Promise.all([
      renderCameraFrame(doc, { slideIndex: index - 1, alpha: 1, registry, width, height }),
      renderCameraFrame(doc, { slideIndex: index, alpha: 1, registry, width, height }),
    ]);
    promise.catch(() => byKey.delete(key)); // evict failures (callers still reject loudly)
    byKey.set(key, promise);
  }
  return promise;
}

/**
 * Pure function. The eased blend strength for a transition frame — the fraction
 * of the NEW slide shown (0 = all previous, 1 = all new). Honors the curve:
 * "smooth" applies the existing cubic ease, "linear" passes alpha through.
 * Clamped to [0,1].
 *
 * @example fadeStrength(0.5, "linear") // 0.5
 * @example fadeStrength(0, "smooth") // 0
 * @example fadeStrength(1, "smooth") // 1
 */
export function fadeStrength(alpha, curve) {
  const a = Math.max(0, Math.min(1, alpha));
  return curve === "linear" ? a : ease("cubic")(a);
}

/**
 * Query. True when rendering slide `index` at `alpha` requires a FADE crossfade:
 * the incoming transition is a fade, there IS a predecessor (index > 0), and
 * alpha is mid-transition (0 < alpha < 1). At the endpoints a fade shows exactly
 * one completed slide, so the plain single-state path renders it — no crossfade
 * needed (and slide 0 has no predecessor to fade from).
 *
 * @example // isFadeFrame(doc, 1, 0.5) → true  when slide 1's transition.type === "fade"
 * @example // isFadeFrame(doc, 0, 0.5) → false (slide 0 has no predecessor)
 */
export function isFadeFrame(doc, index, alpha) {
  if (index <= 0 || alpha <= 0 || alpha >= 1) return false;
  return resolveTransition(doc, index).type === "fade";
}

/**
 * Command (async). Renders the transition frame for (doc, index, alpha) at
 * width×height device px through THE CAMERA → a fresh 2D canvas with the pixels.
 * TWEEN frames are the single evaluated-state camera render; FADE frames
 * crossfade the two completed-state snapshots by the curve-eased alpha.
 *
 * PURE in (doc, index, alpha): the presenter and (once wired) the CLI hook both
 * call this, so present and headless renders of a fade are pixel-consistent.
 *
 * Args:
 *   doc (object): document (already load-migrated — transitions resolved)
 *   index (number): target slide index
 *   alpha (number): tween strength 0..1 into `index`
 *   registry (object): plugin registry
 *   width, height (number): output device px
 *
 * Returns:
 *   Promise<HTMLCanvasElement> width×height, RGBA
 *
 * @example // await renderTransitionFrame(doc, 1, 0.5, registry, 1280, 720) → <canvas> (crossfade if slide 1 fades)
 */
export async function renderTransitionFrame(doc, index, alpha, registry, width, height) {
  if (!isFadeFrame(doc, index, alpha))
    // TWEEN (or a fade at an endpoint / slide 0): the existing delta-tween
    // camera render at exactly this (index, alpha).
    return renderCameraFrame(doc, { slideIndex: index, alpha, registry, width, height });

  // FADE: crossfade the two COMPLETED-state snapshots. Both endpoints render at
  // alpha 1 (fully-applied states) — the crossfade lives in the layer opacity,
  // NOT in either scene's tween, so it's a pure function of the eased alpha.
  // MEMOIZED (see fadeSnapshots): the snapshots are alpha-independent, so every
  // frame after the first blends the SAME two canvases at rAF rate — the fix for
  // the flick-at-scale (14.7 REOPENED).
  const [prevCanvas, nextCanvas] = await fadeSnapshots(doc, index, registry, width, height);
  const e = fadeStrength(alpha, resolveTransition(doc, index).curve);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  // frameA·(1-e) + frameB·e: draw the previous snapshot fully, then the new one
  // over it at opacity e. Both snapshots are opaque full-camera frames, so the
  // source-over composite yields the exact crossfade in the covered region.
  ctx.drawImage(prevCanvas, 0, 0);
  ctx.globalAlpha = e;
  ctx.drawImage(nextCanvas, 0, 0);
  ctx.globalAlpha = 1;
  return out;
}
