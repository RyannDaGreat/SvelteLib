/**
 * Video V2 (Skia direct upload) — a DEMO video player widget that renders through
 * the from-scratch V2 path (render_gpu/skia/video_v2.js + the `videoV2` IR op),
 * NOT the shared video_registry.js player. It exists to showcase, and let us
 * measure, the CanvasKit `makeImageFromTextureSource`/`updateTextureFromSource`
 * DIRECT-UPLOAD approach: the live `<video>` frame is uploaded straight to a GL
 * texture (no drawImage→canvas→MakeImageFromCanvasImageSource readback), refreshed
 * only when a NEW decoded frame arrives, at full resolution and full frame rate,
 * and paused with zero decode cost whenever the widget is culled/off-slide.
 *
 * ── PLAYER, NOT SCRUBBER ──────────────────────────────────────────────────────
 * Like plugins/video.js this is the PLAYER: playback is ordinary `<video>`
 * playback and never touches document/tween state, so state holds only PARAMETERS
 * (src + playback flags), never frames. A headless render shows nothing (the live
 * player has no single deterministic frame) — the same sparkler contract the V1
 * player has with an empty media map (not a regression).
 *
 * ── STATE / FLAGS ─────────────────────────────────────────────────────────────
 * `src` is the video source string (data: URI / URL / asset URL), self-contained
 * so it travels with the document. Playback flags default TRUE and — unlike the V1
 * player — are carried IN the emitted `videoV2` op (the V2 registry owns its own
 * elements and reads the flags off the draw command). `muted` defaults true
 * because browsers block unmuted autoplay. `animated` defaults true so the
 * PRESENTER (web/PresentMode.svelte) keeps rendering every rAF frame while the
 * clip is visible — the V2 path's continuous-playback surface (see the module's
 * off-view pause sweep).
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — identical to the image
 * and V1 video widgets, so it culls via the standard bbox rule and composites
 * correctly under magnifiers/blur with zero special-casing.
 *
 * ── NO PLUGIN IMPORTS ANOTHER PLUGIN ──────────────────────────────────────────
 * This file imports only shared core/render modules (never plugins/video.js) — it
 * carries its own unsourced default and its own defaults/inspector composed from the
 * shared property registry, exactly like the V1 player does independently.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../../core/properties.js";
import * as T from "../../core/transform.js";
import { videoV2 } from "../../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";

/** A 1×1 transparent PNG data URI — the default `src` so a freshly added widget is
 * a valid (invisible-until-sourced) item rather than a broken ref. Mirrors the
/** THE UNSOURCED DEFAULT IS THE EMPTY STRING — see plugins/video.js's UNSOURCED
 *  for the full reasoning. This widget's op reaches an HTMLMediaElement decoder,
 *  and a `<video>` refuses a PNG data URI (`MediaError code 4`), so the copied
 *  image-widget default logged a load failure on every unsourced insert. `emit`
 *  already draws nothing for an empty src. Pinned by tests/unsourced_media_test.js,
 *  which DERIVES its subjects from the registry so a new video widget joins the law
 *  by existing. Precedent: plugins/demo/video_v8.js:84. */
const UNSOURCED = "";

export const videoV2Plugin = {
  type: "video_v2",
  title: "Video V2",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "video_v2", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: UNSOURCED,
    // Playback + animated flags, all default true — from the SHARED registry
    // (core/properties.js). muted:true is REQUIRED for autoplay to actually play;
    // animated:true keeps the presenter repainting so the V2 path plays live.
    ...defaults("autoplay", "loop", "muted", "animated", "opacity"),
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius"),
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"),
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("positioning"),
    ...props("src", { src: { assetKinds: ["video"] } }),
    ...props("autoplay", "loop", "muted", "animated"),
    ...bundle("strokedBorder"),
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (local space). Emits the
   * `videoV2` op (the direct-upload path) carrying both the quad + edge-crop
   * source rect AND the playback flags (the V2 registry configures the `<video>`
   * from the op). Border + rounded corners + edge-crop + effects are identical to
   * the image/V1-video widgets (cropInsetsToSource + decorateStrokedBox +
   * applyEffects). Returns nothing for an empty/missing or fully-cropped src.
   */
  emit(s, _targetWorldIR, world) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw
    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const quad = videoV2({
      ref: s.src, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1,
      sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh,
      autoplay: s.autoplay ?? true, loop: s.loop ?? true, muted: s.muted ?? true,
    });
    return applyEffects(decorateStrokedBox([quad], style, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
};
