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
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { video } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

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
    // Playback + animated flags all default true — sourced from the SHARED
    // PROPERTY REGISTRY (core/properties.js): autoplay/loop/muted/animated each
    // declare `default: true` there, so this stays in sync with the rows below.
    // muted:true is REQUIRED for autoplay:true to actually play (browser autoplay
    // policy blocks unmuted). `animated` (manifest ANIMATED WIDGET) keeps the
    // PRESENTER rendering every rAF frame while a video is visible so a looping
    // clip doesn't freeze between transitions; the presenter (Opus26,
    // web/PresentMode.svelte) reads the evaluated value. Its ROW + help text
    // live in the registry (this plugin composes them below).
    ...defaults("autoplay", "loop", "muted", "animated", "opacity"),
    // stroke COLOR default matches every other stroked shape; paints only once
    // strokeWidth > 0 (0 by default → an undecorated video is byte-identical to
    // its pre-bundle rendering).
    stroke: "#1a1a2e",
    ...defaults("strokeWidth", "cornerRadius"),
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  inspector: [
    ...bundle("positioning"),
    // The video source (data URI / URL) — the registry `src` row, filtered to
    // VIDEO assets in the AssetField picker/drop (assetForm stays "url", the
    // registry default: video.src stores the served /asset/<project>/<file>
    // path, unlike filmstrip's bare-filename form).
    ...props("src", { src: { assetKinds: ["video"] } }),
    // Boolean playback rows + the animated flag (BooleanField — the keyframeable
    // boolean control), all from the registry so their help texts are shared.
    ...props("autoplay", "loop", "muted", "animated"),
    // The stroked-BORDER bundle — a video inherits stroke/rounded corners at
    // once, exactly like an image (manifest "including images and videos and
    // such"). No `fill` row (the frame's pixels are its interior).
    ...bundle("strokedBorder"),
    // EDGE-CROP INSETS — trim the source from each side (manifest "Edge-crop
    // insets"); all-0 default = byte-identical to no crop.
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
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
   *
   * EDGE-CROP INSETS + BORDER + ROUNDED CORNERS: identical to the image widget
   * (cropInsetsToSource shrinks the quad + crops the source; decorateStrokedBox
   * frames the cropped rect). See image.js/decorate.js for the world + opacity
   * contracts. All-zero crop + no border → the bare video op (unchanged).
   */
  emit(s, _targetWorldIR, world) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw
    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const quad = video({ ref: s.src, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh });
    // Effects wrap OUTSIDE the border decoration (render_gpu/effects.js order
    // rule): shadow/bloom silhouette the FRAMED video, border included.
    return applyEffects(decorateStrokedBox([quad], style, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-video", title: "Add Video", icon: "mdi:video-outline", run: (app) => app.armCrosshairPlacement(videoPlugin) }, // crosshair bbox placement of a blank video widget (manifest UNDEFERRAL SWEEP); drop/explorer inserts still use native-size insertVideoAsset
  ],
};
