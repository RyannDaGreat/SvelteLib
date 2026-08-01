/**
 * Video V8 — a FRESH video-player widget built for the video cohort. It is a
 * PORTABILITY-FIRST OVERLAY player: the live frame is drawn by a single `<canvas>`
 * stacked over the Skia scene, with TWO interchangeable GPU backends chosen at
 * runtime (WebGPU zero-copy external-texture where a secure context provides
 * `navigator.gpu`, else a WebGL2 `texImage2D`-from-element upload on plain HTTP).
 * See web/videoV8Overlay.js for the overlay/backends; this file is just the
 * DECLARATIVE widget (state, inspector, and the deterministic poster it emits).
 *
 * ── WHAT THIS PLUGIN EMITS (and what it does NOT) ─────────────────────────────
 * emit() returns a DARK POSTER rect (+ a centered play glyph) in the widget's box
 * — a deterministic stand-in that:
 *   1. makes the widget visible/selectable the instant it is inserted (before any
 *      src, and while a clip is still decoding), and
 *   2. is the ONLY thing the CLI/PDF/thumbnail paths render (they walk emit() with
 *      no live `<video>`), giving those paths a deterministic frame — a live clip
 *      has no single "correct" frame, so a poster is the honest answer.
 * The MOVING video is NOT emitted here: it is composited by the overlay canvas in
 * the editor (web/CanvasView.svelte), on top of this poster. KNOWN BOUND: because
 * the overlay is one canvas above the whole Skia scene, a widget stacked above a
 * V8 video in z-order still draws visually beneath the live frame (the poster
 * respects z-order; the live frame does not).
 *
 * ── STATE ─────────────────────────────────────────────────────────────────────
 * `src` is the video SOURCE as a plain string (data: URI / URL / asset URL) —
 * self-contained, travels with the document. Default "" (empty) → poster only,
 * no element created, no load error (a freshly inserted widget is a valid, visible
 * poster until a video is dropped/picked). `w`/`h` are the quad's world size.
 * Playback flags all default TRUE (muted MUST be true or browsers block autoplay).
 *
 * ── PLAYER, NOT SCRUBBER ──────────────────────────────────────────────────────
 * Playback is ordinary `<video>` playback and never touches document/tween state,
 * so a looping clip never fights the delta/alpha system (same contract as the
 * stock player). No seconds/progress/duration exports (a live element's time is
 * not pure(document, slide, alpha)).
 *
 * ── OFF-VIEW = ZERO COST ──────────────────────────────────────────────────────
 * The widget culls via the standard bbox rule (backdrop:false, bbox:true), and the
 * overlay's registry (web/videoV8Registry.js) pauses any element whose src is not
 * in the post-cull visible set — so a clip off-screen or on another slide has its
 * browser decode stopped, resuming from its prior time on re-entry.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
import { bundle, defaults, props } from "../../core/properties.js";
import { videoSrcRow } from "../../core/video_sampling.js";
import * as T from "../../core/transform.js";
import { rect, polygon } from "../../render_gpu/ir.js";

/** Poster fill — a dark, slightly blue-black card so an unsourced/decoding video
 * reads as a media placeholder against the canvas (deterministic in CLI/PDF). */
const POSTER_FILL = "#14141f";
/** Play-glyph fill + its opacity (a calm, low-contrast triangle — a hint, not a
 * button; the overlay's live frame replaces it in the editor). */
const PLAY_GLYPH_FILL = "#e8e8f2";
const PLAY_GLYPH_OPACITY = 0.55;
/** Play triangle size as a fraction of the box's SHORTER side (scales with the
 * widget, stays centered, never spills a thin box). */
const PLAY_GLYPH_FRACTION = 0.26;

/**
 * Pure function. The centered right-pointing play triangle (3 local-space points)
 * for a `w×h` box, sized to PLAY_GLYPH_FRACTION of the shorter side. Convex (a
 * triangle), so it satisfies the polygon op's convexity requirement.
 *
 * @param {number} w box width
 * @param {number} h box height
 * @returns {[number,number][]} three [x,y] local points (TL, BL, mid-right)
 * @example playTrianglePoints(100, 100) // [[37, 37], [37, 63], [63, 50]]
 */
export function playTrianglePoints(w, h) {
  const half = (Math.min(w, h) * PLAY_GLYPH_FRACTION) / 2;
  const cx = w / 2, cy = h / 2;
  return [[cx - half, cy - half], [cx - half, cy + half], [cx + half, cy]];
}

export const videoV8Plugin = {
  type: "video_v8",
  title: "Video V8",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "video_v8", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: "", // empty → poster only, no element, no load error (blank-but-valid)
    ...defaults("autoplay", "loop", "muted", "opacity"),
  },
  inspector: [
    ...bundle("positioning"),
    // Video source — filtered to VIDEO assets in the AssetField picker/drop,
    // exactly like the stock player's src row.
    videoSrcRow("Source"),
    ...props("autoplay", "loop", "muted"),
    ...props("opacity"),
  ],
  /**
   * Pure function. State → display-list commands (local space): a dark poster
   * rect over the whole box, plus a centered play glyph. This is the deterministic
   * frame the CLI/PDF/thumbnail paths render; the editor's overlay canvas draws the
   * live video on top of it. Honors `opacity`. Never emits a video/external op —
   * the moving frame is the overlay's job, not the scene's.
   *
   * @param {object} s folded widget state ({w, h, opacity, ...})
   * @returns {object[]} display-list commands
   */
  emit(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const opacity = s.opacity ?? 1;
    return [
      rect({ x: 0, y: 0, w, h, fill: POSTER_FILL, opacity }),
      polygon({ points: playTrianglePoints(w, h), fill: PLAY_GLYPH_FILL, opacity: opacity * PLAY_GLYPH_OPACITY }),
    ];
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-video-v8", title: "Add Video V8", icon: "mdi:video", run: (app) => app.armCrosshairPlacement(videoV8Plugin) },
  ],
};
