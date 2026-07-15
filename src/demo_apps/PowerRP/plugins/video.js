/**
 * Video PLAYER widget — a sampled-texture quad of a video the user drops in or
 * picks from the project's assets, playing back via a plain HTML `<video>`
 * element. THE second media widget (after image), and the proof the render
 * cornerstone holds for MOVING raster content: it renders through the WebGPU
 * compositor (as an external-texture quad, current frame imported each render)
 * AND through the PDF backend (as a CURRENT-FRAME embedded image XObject).
 *
 * ── PLAYER, NOT SCRUBBER (manifest glossary) ──────────────────────────────────
 * This is the video *player*: playback runs as ordinary HTML `<video>` playback
 * and does NOT touch document/tween state — a looping clip never fights the
 * delta/alpha system. (The *scrubber*, whose current-time IS tweened
 * deterministic state, is a distinct future widget.) So this plugin's state
 * holds only PARAMETERS (src + playback flags), never frames — the sparkler
 * rule: a headless/CLI render shows the video's poster/first frame, which is
 * deterministic and legitimate (a live clip has no single "correct" frame).
 *
 * ── STATE ─────────────────────────────────────────────────────────────────────
 * `src` holds the video SOURCE as a string — a `data:` URI, a URL, or an asset
 * URL. Self-contained by design (same rationale as the image widget): a plain
 * string travels with the document, works offline, and needs no media-registry
 * plumbing through the web layer — the GPU compositor resolves it through
 * gpu/video_registry.js (which owns the `<video>` element), and the PDF backend
 * grabs the element's current frame. `w`/`h` are the quad's world size.
 *
 * Playback flags, all default TRUE (manifest "Drag-drop media → videos AUTOPLAY
 * + LOOP by default, both toggleable"):
 *   - autoplay: begin playing on load.
 *   - loop: restart at the end (so a looping clip plays forever without a tween).
 *   - muted: play with no audio. DEFAULT TRUE because BROWSERS BLOCK UNMUTED
 *     AUTOPLAY — an autoplaying clip that isn't muted is silently paused by the
 *     browser's autoplay policy, which would make autoplay:true a lie. Muted is
 *     the only combination that autoplays reliably; a user who wants sound turns
 *     muted off (and typically autoplay off with it, or clicks to start).
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — identical to image.
 * backdrop:false is what makes a video UNDER a magnifier or blur composite
 * correctly: the video paints in z-order into the scene, and the effect above
 * samples the composited canvas (now containing the current video frame) — the
 * backdrop-stacking requirement holds with zero special-casing (culling too:
 * the default bbox-intersection rule in core/view.js canSkipNode applies free).
 *
 * ── ASYNC (manifest F3 + the round-12 async rule) ─────────────────────────────
 * The `<video>` element loads and decodes asynchronously; emit() is sync and
 * PURE (it always returns the same video op for a given state). The compositor
 * draws NOTHING for a src whose element has no decoded frame yet and repaints
 * when frames arrive (gpu/video_registry.js onVideoFrame nudge) — so there is
 * no silent placeholder and no blocking. A load FAILURE is reported loudly by
 * the registry (console.error), never swallowed.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import * as T from "../core/transform.js";
import { video } from "../render_gpu/ir.js";

/** A tiny 1×1 transparent PNG data URI — the default `src` so a freshly added
 * video widget is a valid (invisible-until-sourced) item rather than a broken
 * ref (an image src is fine: it decodes to one transparent frame, so the widget
 * simply draws nothing until a real video is dropped/picked). Mirrors the image
 * widget's BLANK_SRC. */
export const BLANK_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const videoPlugin = {
  type: "video",
  title: "Video",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "video", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: BLANK_SRC,
    // Playback flags — all default true (see header). muted:true is REQUIRED for
    // autoplay:true to actually play (browser autoplay policy blocks unmuted).
    autoplay: true, loop: true, muted: true,
    opacity: 1,
  },
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees", category: "positioning" }, // core stores radians; field shows degrees (round-10 ruling)
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number", category: "positioning" }, // world pivot; default self.anchors.center
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    // The video source (data URI / URL). A generic string row today — the
    // proper asset-picker control lands with the asset server + explorer.
    { key: "src", label: "Source", kind: "text", category: "formatting" },
    // Boolean playback rows (BooleanField — the keyframeable boolean control).
    { key: "autoplay", label: "Autoplay", kind: "boolean", category: "formatting" },
    { key: "loop", label: "Loop", kind: "boolean", category: "formatting" },
    { key: "muted", label: "Muted", kind: "boolean", category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
  ],
  /**
   * Pure function. State → display-list commands (local space) — THE render
   * API. The `ref` IS the source string: raster backends resolve it (the GPU
   * compositor through gpu/video_registry.js, the PDF backend by grabbing the
   * element's current frame). Returns nothing for an empty/missing src (a broken
   * widget draws nothing rather than emitting an invalid op). The playback flags
   * are NOT part of the op: they configure the `<video>` element (the registry
   * reads them off state), not the per-frame draw — the op is just "this frame
   * of this source over this quad".
   */
  emit(s) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    return [video({ ref: s.src, x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0, opacity: s.opacity ?? 1 })];
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-video", title: "Add Video", icon: "mdi:video-outline", run: (app) => app.addItem(videoPlugin.defaults) },
  ],
};
