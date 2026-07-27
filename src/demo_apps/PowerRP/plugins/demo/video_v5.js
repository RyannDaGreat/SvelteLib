/**
 * Video V5 (OffscreenCanvas/worker) — a DEMO video player that draws its frames
 * through the off-main-thread V5 pipeline (render_gpu/skia/video_v5.js +
 * video_v5_worker.js) instead of the main-thread texImage2D(<video>) path the
 * core `video` widget uses (plugins/video.js + render_gpu/gpu/video_registry.js).
 *
 * It exists to A/B the V5 hypothesis: move the per-frame YUV->RGBA colour convert
 * OFF the main thread (a worker does it via createImageBitmap on VideoFrames
 * piped through captureStream->MediaStreamTrackProcessor), so the main thread
 * only does a cheap texImage2D(ImageBitmap) upload — reducing the video cost that
 * competes with drag/pan input. Everything downstream (transform, culling,
 * opacity, off-view pause, reactive repaint) matches the core video widget.
 *
 * STATE mirrors plugins/video.js's parameters — `src` (the source string, the
 * media-registry key), plus autoplay/loop/muted/animated/opacity — but is
 * DELIBERATELY leaner: no border/crop/effects, so a bare V5 quad is directly
 * comparable to a bare `video` quad in a perf A/B. Playback flags default TRUE;
 * muted:true is required for autoplay (browser policy blocks unmuted autoplay).
 *
 * emit() is PURE (same state → same `videoV5` op). The frame is resolved async by
 * the V5 registry; a src with no decoded frame yet draws nothing and repaints
 * when a frame lands (onVideoV5Frame nudge) — never a placeholder, never a block.
 * A headless/CLI render shows nothing for a live clip (the sparkler rule).
 *
 * Not a plugin import of any other plugin (the fence): it composes only shared
 * capabilities + core property helpers + the additive `videoV5` IR op.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
import { bundle, defaults, props } from "../../core/properties.js";
import * as T from "../../core/transform.js";
import { videoV5 } from "../../render_gpu/ir.js";

/** A 1×1 transparent PNG data URI — the default `src` (a valid, invisible-until-
 *  sourced widget rather than a broken ref). Mirrors video.js/image.js BLANK_SRC. */
export const BLANK_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const videoV5Plugin = {
  type: "video_v5",
  title: "Video V5 (OffscreenCanvas/worker)",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // asset picker. `primaryAsset` names WHICH property that picker fills; this
  // string is what says the double-click opens it at all.
  activate: "asset_picker",
  primaryAsset: "src",
  defaults: {
    type: "video_v5", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: BLANK_SRC,
    // autoplay/loop/muted/animated/opacity from the SHARED property registry (each
    // defaults true, opacity 1). muted:true is required for autoplay to actually
    // play; `animated` keeps the presenter rendering a looping clip every rAF.
    ...defaults("autoplay", "loop", "muted", "animated", "opacity"),
  },
  inspector: [
    ...bundle("positioning"),
    ...props("src", { src: { assetKinds: ["video"] } }),
    ...props("autoplay", "loop", "muted", "animated"),
    ...props("opacity"),
  ],
  /**
   * Pure function. State → the single `videoV5` quad (local space). The `ref` IS
   * the source string (the V5 registry keys its `<video>`/worker by it). Draws
   * nothing for an empty/missing src or a zero-size quad. Playback flags are NOT
   * in the op — they configure the `<video>` element, not the per-frame draw.
   *
   * @example videoV5Plugin.emit({src: "clip.mp4", w: 320, h: 180, opacity: 1})[0].op // "videoV5"
   * @example videoV5Plugin.emit({src: "", w: 320, h: 180}) // []
   */
  emit(s) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    if (!(s.w > 0) || !(s.h > 0)) return [];
    return [videoV5({ ref: s.src, x: 0, y: 0, w: s.w, h: s.h, opacity: s.opacity ?? 1 })];
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-video-v5", title: "Add Video V5 (worker)", icon: "mdi:video", run: (app) => app.armCrosshairPlacement(videoV5Plugin) },
  ],
};
