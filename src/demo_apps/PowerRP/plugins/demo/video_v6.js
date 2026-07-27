/**
 * Video V6 — a from-scratch video-player widget whose live playback is drawn by
 * a SINGLE shared WebGPU external-texture overlay canvas (web/VideoV6Overlay.svelte
 * + web/videoV6Gpu.js + web/videoV6Registry.js + web/videoV6Layout.js), stacked
 * above the Skia scene. This plugin is the DECLARATIVE half: state shape,
 * inspector rows, culling, anchors, and the deterministic backing emit() — it
 * imports NO other plugin and holds NO frames.
 *
 * ── WHY A BACKING RECT (not a Skia video draw) ────────────────────────────────
 * The live frame is NOT painted through Skia — the overlay owns pixels for the
 * clip. emit() therefore returns a deterministic dark BACKING rect at the
 * widget's box (plus its optional border): it makes the widget visible +
 * hit-testable, gives a continuous surface UNDER the live overlay (so there is
 * no flicker before the first frame arrives), and is the deterministic
 * appearance the headless CLI/PDF path shows (a live clip has no single correct
 * frame — the manifest's sparkler rule). This deliberately does NOT reuse the
 * current `video` op / Skia video draw (the path the boss is replacing).
 *
 * ── STATE (mirrors the current video widget so drops work) ────────────────────
 * `src` is the source string (data: URI / URL / asset URL); `w`/`h` the box
 * size; playback flags autoplay/loop/muted all default TRUE (muted MUST be true
 * or browsers block autoplay). The overlay reads these off state to configure +
 * gate the shared <video> element.
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — identical to the
 * image/video widgets, so the standard bbox culling rule (core/view.js
 * canSkipNode) applies for free: off-screen → culled → the overlay pauses its
 * <video> (zero cost off-view).
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
import { bundle, defaults, props } from "../../core/properties.js";
import * as T from "../../core/transform.js";
import { rect } from "../../render_gpu/ir.js";

/** A 1×1 transparent PNG — the default `src` so a freshly placed widget is a
 *  valid (invisible-until-sourced) item, not a broken ref. A <video> pointed at
 *  a PNG simply never produces a video frame (the overlay draws nothing for it),
 *  so the backing rect shows until a real clip is dropped/picked. Mirrors the
 *  image/video widgets' BLANK_SRC. */
export const BLANK_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The backing surface colour beneath the live overlay — a near-black tone that
 *  reads as "video here" and hides the grid before the first frame lands. Kept a
 *  hair off pure black so the backing plate stays distinguishable from a black
 *  letterbox bar in the first frame. */
const BACKING_FILL = "#0b0b12";

export const videoV6Plugin = {
  type: "video_v6",
  title: "Video V6",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "video_v6", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: BLANK_SRC,
    // Playback flags from the shared property registry (help text shared with the
    // other media widgets); all default true. muted:true is REQUIRED for autoplay.
    ...defaults("autoplay", "loop", "muted", "opacity"),
  },
  inspector: [
    ...bundle("positioning"),
    // src filtered to VIDEO assets in the picker/drop (same as the video widget).
    ...props("src", { src: { assetKinds: ["video"] } }),
    ...props("autoplay", "loop", "muted"),
    ...props("opacity"),
  ],
  /**
   * Pure function. State → display-list commands (local space). Returns a single
   * dark backing rect at the widget's box (the deterministic surface the CLI/PDF
   * path shows and the live overlay draws over); nothing for an empty src. The
   * live video frame is NOT emitted here — the overlay canvas draws it on top in
   * interactive contexts. Opacity carries onto the backing so a faded widget
   * fades uniformly (the overlay applies the same opacity to the live frame).
   *
   * @param {object} s The folded widget state.
   * @returns {Array<object>} A one-element display list (the backing rect), or [].
   *
   * @example
   * // A sourced 320×180 widget → one dark backing rect at its box:
   * videoV6Plugin.emit({src: "clip.mp4", w: 320, h: 180, opacity: 1}).length // 1
   * @example videoV6Plugin.emit({src: "", w: 320, h: 180}) // []
   */
  emit(s) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    return [rect({ x: 0, y: 0, w, h, fill: BACKING_FILL, opacity: s.opacity ?? 1 })];
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-video-v6", title: "Add Video V6", icon: "mdi:video", run: (app) => app.armCrosshairPlacement(videoV6Plugin) },
  ],
};
