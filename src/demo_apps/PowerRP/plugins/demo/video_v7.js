/**
 * Video V7 — a video PLAYER widget rendered by a PER-WIDGET WebGPU overlay
 * canvas (web/VideoV7Overlay.svelte), NOT by the Skia scene compositor.
 *
 * ── THE V7 APPROACH (why a separate overlay at all) ───────────────────────────
 * The Skia scene renders on WebGL2 and works on plain HTTP; WebGPU needs a
 * secure context. So a WebGPU video layer CANNOT live inside the Skia canvas —
 * it is a SEPARATE stack of small <canvas> elements composited (by the browser)
 * OVER the Skia scene. Each V7 widget owns ONE such canvas, sized to the video's
 * NATURAL resolution and CSS-transformed to the widget's on-screen quad. On a
 * secure context with `navigator.gpu` the canvas draws the video ZERO-COPY via
 * `device.importExternalTexture({source: videoEl})` (re-imported each frame,
 * `textureSampleBaseClampToEdge`); on plain HTTP (no `navigator.gpu`) it falls
 * back to a 2D `drawImage` of the current frame — same full-resolution, same
 * frame rate (both driven by `requestVideoFrameCallback`), just a CPU copy.
 * Off-view widgets are dropped from the descriptor set → their `<video>` is
 * PAUSED (browser stops decoding) → ZERO cost, `currentTime` preserved.
 *
 * ── WHAT THIS PLUGIN CONTRIBUTES (sync + pure) ────────────────────────────────
 * emit() draws only the deterministic POSTER (a dark rounded box + a centered
 * play triangle) so the CLI/PDF/headless render — and the editor while a clip is
 * paused off-view or not yet sourced — always shows something legitimate (a live
 * clip has no single "correct" frame; the sparkler rule). The moving pixels are
 * the overlay's job, entirely outside the document/tween state. The poster is
 * covered by the overlay canvas whenever a real frame is live.
 *
 * ── STATE ─────────────────────────────────────────────────────────────────────
 * `src` is the video SOURCE string (data URI / URL / asset URL). A fresh widget
 * carries BLANK_SRC (a 1×1 transparent PNG) which is an IMAGE, not a video — the
 * overlay recognizes `data:image/…` as "not yet sourced" and shows only the
 * poster (handing an image URI to a <video> would error). Playback flags
 * autoplay/loop/muted default TRUE (muted is required for autoplay under browser
 * policy — an unmuted autoplay is silently blocked).
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable, backdrop:false — same family as image/video.
 *
 * NOTE this is a FRESH module: it does NOT import or extend the deleted
 * compositor.js / render_gpu/gpu/video_registry.js / plugins/video.js. It shares
 * nothing with them but the plugin shape.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
import { bundle, defaults, props } from "../../core/properties.js";
import { videoSrcRow } from "../../core/video_sampling.js";
import * as T from "../../core/transform.js";
import { rect, polygon } from "../../render_gpu/ir.js";

/** A 1×1 transparent PNG data URI — the default `src` so a freshly added widget
 * is valid (poster-only) rather than a broken ref. It is an IMAGE data URI, so
 * the overlay treats it as "not yet sourced" and never hands it to a <video>. */
export const BLANK_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Poster look. Dark box + a muted play triangle so a static export reads as
 * "video". Sizes/colors are named (no magic numbers): the triangle spans this
 * fraction of the box's smaller dimension. */
const POSTER_FILL = "#0c0c14";
const POSTER_GLYPH = "#5a5a6e";
const POSTER_STROKE = "#000000";
const PLAY_TRIANGLE_FRAC = 0.34;

/**
 * Pure function. The three corner points of a centered right-pointing "play"
 * triangle for a w×h poster box, sized to `frac` of the box's smaller
 * dimension. The vertical back edge sits half a radius left of center so the
 * triangle looks visually centered (apex farther from center than the back).
 * Returns [[x,y],…] in local box coordinates.
 *
 * @param {number} w box width (local units)
 * @param {number} h box height (local units)
 * @param {number} frac triangle size as a fraction of min(w,h), in (0,1]
 * @returns {Array<[number,number]>} three [x,y] points (convex, CCW-ish)
 * @example playTrianglePoints(100, 50, 0.4) // [[45, 15], [45, 35], [60, 25]]
 */
export function playTrianglePoints(w, h, frac) {
  const r = (Math.min(w, h) * frac) / 2; // half the triangle's height
  const cx = w / 2, cy = h / 2;
  const back = r / 2; // back edge sits half a radius left of center
  return [[cx - back, cy - r], [cx - back, cy + r], [cx + r, cy]];
}

export const videoV7Plugin = {
  type: "video_v7",
  title: "Video V7 (WebGPU per-widget canvas)",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "video_v7", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about the widget's own center by default (an equation —
    // same convention as every bbox widget).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: BLANK_SRC,
    // Playback flags from the shared registry (each declares default:true there).
    ...defaults("autoplay", "loop", "muted", "opacity"),
    stroke: POSTER_STROKE,
    ...defaults("strokeWidth", "cornerRadius"),
  },
  inspector: [
    ...bundle("positioning"),
    videoSrcRow("Source"),
    ...props("autoplay", "loop", "muted"),
    ...bundle("strokedBorder"),
    ...props("opacity"),
  ],
  /**
   * Pure function. State → display-list commands (local space): the deterministic
   * POSTER only (a dark rounded box + centered play triangle). The live video is
   * drawn by the per-widget overlay canvas OUTSIDE the scene, so emit() never
   * touches the source frames — it always returns the same poster for a given
   * box, which is exactly what the CLI/PDF/headless paths render. Degenerate
   * (w<=0 or h<=0) → nothing to draw.
   */
  emit(s, _targetWorldIR, _world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const opacity = s.opacity ?? 1;
    const cornerRadius = s.cornerRadius ?? 0;
    const box = rect({ x: 0, y: 0, w, h, cornerRadius, fill: POSTER_FILL, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, opacity });
    const glyph = polygon({ points: playTrianglePoints(w, h, PLAY_TRIANGLE_FRAC), fill: POSTER_GLYPH, opacity });
    return [box, glyph];
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-video-v7", title: "Add Video V7", icon: "mdi:video-vintage", run: (app) => app.armCrosshairPlacement(videoV7Plugin) },
  ],
};
