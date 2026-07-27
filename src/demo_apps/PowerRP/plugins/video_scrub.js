/**
 * Video SCRUBBER widget — the DETERMINISTIC counterpart to the video player.
 *
 * ── PLAYER vs SCRUBBER (manifest glossary) ────────────────────────────────────
 * The video PLAYER (plugins/video.js) plays via wall-clock HTML `<video>`
 * playback and does NOT touch document state — a looping clip never fights the
 * tween system, but its current frame is non-deterministic, so a headless/CLI
 * render shows only its poster frame. The SCRUBBER is the opposite: its
 * current-time IS document state — `scrubTime`, a keyframable, EQUATION-BINDABLE
 * number (seconds). The displayed frame is the video decoded AT that time, so it
 * is pure(document, slide, alpha): the SAME (slide, alpha) always shows the SAME
 * frame — deterministic and headlessly reproducible. This is the graceful answer
 * to "tweening a looping video": keyframe `scrubTime` across slides (or bind it
 * to an equation) and the clip scrubs as the slide tweens.
 *
 * ── MULTIPLE SYNCHRONIZED VIDEOS (falls out for free) ─────────────────────────
 * Because `scrubTime` is an ordinary keyframable/equation property, N scrubbers
 * whose `scrubTime` resolves to the SAME value (bound to the same doc variable,
 * the same equation, or the same keyframes) decode the SAME frame — they scrub
 * in frame-lockstep with NO dedicated sync mechanism. Two scrubbers on one
 * source at one time even share ONE decoded frame (the render layer keys frames
 * by ref+time+wrap; see render_gpu/ir.scrubFrameKey).
 *
 * ── STATE ─────────────────────────────────────────────────────────────────────
 * `src` — the video SOURCE string (data: URI / URL / asset URL), the SAME asset
 * binding the player uses (video assets in the AssetField). `scrubTime` — the
 * decode time in seconds (keyframable number; `=` for equations). `scrubWrap` —
 * past-the-end behavior ("clamp" holds the last frame, "loop" wraps modulo the
 * clip duration; resolved against the real duration at decode time, since a pure
 * emit does not know it). Plus the shared border / edge-crop / opacity / effects.
 * NO playback flags (autoplay/loop/muted) — a scrubber never plays; its time is
 * document state, not a wall clock.
 *
 * ── HOW A FRAME REACHES THE CANVAS (the async seek-and-await) ─────────────────
 * emit() is PURE: it returns a `videoFrame` op carrying the evaluated `scrubTime`
 * (equations are already numbers by emit time). The raster backend PARKS a
 * paused decoder at that time and AWAITS the decoded frame before compositing
 * (render_gpu/gpu/video_registry.requestScrubFrame):
 *   - LIVE (editor/presenter): the sync paint draws NOTHING for a not-yet-decoded
 *     frame and repaints when the seek lands (video_registry.notify → the
 *     reactive canvas's onVideoFrame nudge) — the image pipeline's async contract
 *     applied to seeks.
 *   - HEADLESS one-shot (thumbnails / PNG export / the puppeteer render hook via
 *     web/gpuService.js): the pixel path AWAITS every scrub frame BEFORE painting
 *     (browser_media.prepareSceneScrubFrames), so its output is reproducible.
 * The pure-Node CLI (cli/render.js) has no `<video>` element, so — exactly like
 * the image/video ops there today — a scrubber draws NOTHING in that path (an
 * honest, documented bound, not a fake frame). The determinism guarantee holds
 * in every path that CAN decode video (the browser + puppeteer render hook).
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — identical to the
 * player and the image widget, so it composites under magnifiers/blur and culls
 * for free (core/view.js canSkipNode). NOT `animated`: the scrubber is
 * deterministic document state, not wall-clock motion, so the presenter has no
 * reason to spin for it (a tween already repaints; a resting keyframe is static).
 *
 * ── PLAYBACK-PROGRESS EXPORTS (seconds / progress / duration) ─────────────────
 * Because the scrubber's time IS deterministic document state, it can export
 * "how far along the clip is" as REFERENCEABLE, read-only values that OTHER
 * widgets (e.g. a progress bar) bind to via `= @thisScrubber.progress`. Three
 * exports, all derived purely from existing state:
 *   - `seconds`  = the current decode time (`scrubTime`), in seconds.
 *   - `duration` = the clip length in seconds — a USER-PROVIDED input (see below).
 *   - `progress` = fraction 0..1 = clamp(scrubTime / duration); 0 when duration
 *                  is unknown (0) — an HONEST "don't know yet", never a fake value.
 *
 * WHY PROPS, NOT ANCHORS: values referenced through the anchor grammar
 * (`@item_anchorId.x`) are WORLD-TRANSFORMED before you read them
 * (core/expressions.anchorValue → T.apply(world, ax, ay)) — a scalar ridden in an
 * anchor's `.x` would come out corrupted by THIS widget's translation, scale, and
 * rotation. A PROPERTY reference (`@item.prop`) reads the raw folded value with NO
 * transform, so the exports are plain equation-bindable properties. `seconds` and
 * `progress` are DERIVED — declared as bare `self.`-equation defaults, so they are
 * (a) discoverable in the equation autocomplete (numericPropertyPaths lists every
 * isNumericSlot leaf) and (b) materialized on creation (addItem spreads defaults),
 * yet carry no editable Inspector row (they are outputs, not inputs).
 *
 * WHY `duration` IS AN INPUT: the real clip duration is only knowable at DECODE
 * time in the browser (`<video>.duration`, gpu/video_registry.js) — it is NOT in
 * the pure/CLI document state, so a pure(document, slide, alpha) derivation cannot
 * know it. Rather than invent one, `duration` is an explicit number the user sets
 * (or binds) to tell the scrubber its clip length; until set (default 0), progress
 * stays 0. Deterministic by construction, and honest about what it does not know.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props, SECONDS_SCRUB } from "../core/properties.js";
import * as T from "../core/transform.js";
import { videoFrame } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** A 1×1 transparent PNG data URI — the default `src` so a freshly added
 * scrubber is a valid (invisible-until-sourced) item rather than a broken ref
 * (it decodes to one transparent frame, so the widget draws nothing until a real
 * video is picked/dropped). Mirrors image/video's BLANK_SRC — a plugin may not
 * import another plugin, so the shared default value is repeated here (it is a
 * constant, not behavior). */
export const BLANK_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ── PLAYBACK-PROGRESS EXPORTS (derived, read-only PROPS — see the header) ─────
// Bare `self.`-equations so they are isNumericSlot leaves: discoverable in the
// equation autocomplete AND real equation slots the derive/evaluate pass settles
// to numbers. `self.scrub_time` / `self.duration` are the display (snake_case)
// forms of the stored scrubTime / duration props. A cross-widget consumer reads
// them with a PROPERTY reference: `= @thisScrubber.progress` (raw, un-transformed).
//
// `progress` = fraction 0..1: clamp(scrubTime / duration) once a positive duration
// is known, else 0 (unknown duration → honest 0, never a fabricated fraction).
export const SECONDS_EXPORT_EQ = "self.scrub_time";
export const PROGRESS_EXPORT_EQ =
  "self.duration > 0 ? Math.max(0, Math.min(1, self.scrub_time / self.duration)) : 0";

export const videoScrubPlugin = {
  type: "video_scrub",
  title: "Video Scrubber",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // asset picker. `primaryAsset` names WHICH property that picker fills; this
  // string is what says the double-click opens it at all.
  activate: "asset_picker",
  primaryAsset: "src",
  defaults: {
    type: "video_scrub", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: BLANK_SRC,
    // The deterministic scrub state: time (seconds) + past-end behavior, both
    // from the shared property registry (core/properties.js). scrubTime defaults
    // to 0 (first frame); scrubWrap to "clamp".
    ...defaults("scrubTime", "scrubWrap", "opacity"),
    // PLAYBACK-PROGRESS EXPORTS (see header). `duration` is the user-supplied clip
    // length in seconds (0 = unknown → progress 0); `seconds`/`progress` are the
    // derived, read-only exports other widgets bind to (`= @thisScrubber.progress`).
    duration: 0,
    seconds: SECONDS_EXPORT_EQ,
    progress: PROGRESS_EXPORT_EQ,
    // stroke COLOR default matches every other stroked shape; paints only once
    // strokeWidth > 0 (0 by default → an undecorated scrubber is byte-identical
    // to its pre-bundle rendering). Same border look as the player.
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius"),
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("positioning"),
    // The video source — VIDEO assets (same picker/drop as the player).
    ...props("src", { src: { assetKinds: ["video"] } }),
    // THE scrub controls: the keyframable/equation-bindable time + wrap mode.
    ...props("scrubTime", "scrubWrap"),
    // Clip DURATION (seconds) — a user-supplied INPUT (the real duration is only
    // known at browser decode time, not in pure state; see header). Feeds the
    // read-only `progress` export. `seconds`/`progress` themselves have NO row:
    // they are derived OUTPUTS, referenceable via `= @thisScrubber.progress`.
    { key: "duration", label: "Duration (s)", kind: "number", min: 0, scrub: SECONDS_SCRUB, category: "formatting", help: "The clip's total length in seconds. Set this (or bind it) so the read-only `progress` export (scrubTime ÷ duration) is meaningful — a progress bar can then bind its fraction to `= @thisScrubber.progress`. Left 0 (unknown), progress stays 0. The real duration is only known once the video decodes in the browser, so it is a value you provide, not one derived from pure document state." },
    // The stroked-BORDER bundle (stroke/rounded corners), like the player — no
    // `fill` row (the frame's pixels are its interior).
    ...bundle("strokedBorder"),
    // EDGE-CROP INSETS — trim the source from each side (all-0 = no crop).
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (local space). Emits ONE
   * `videoFrame` op carrying the EVALUATED `scrubTime` (equations are already
   * numbers here) + `scrubWrap` — the raster backend seeks a paused decoder to
   * that time and awaits the frame. Returns nothing for an empty/missing src or
   * a fully-cropped-away quad (a broken widget draws nothing rather than emitting
   * an invalid op). Edge-crop + border + rounded corners + effects are applied
   * EXACTLY like the video player (cropInsetsToSource → decorateStrokedBox →
   * applyEffects) — the scrubber differs from the player only in WHICH frame it
   * draws (a fixed time vs the live one).
   */
  emit(s, _targetWorldIR, world) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw
    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const quad = videoFrame({
      ref: s.src, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1,
      seekTime: s.scrubTime ?? 0, wrap: s.scrubWrap ?? "clamp",
      sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh,
    });
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
    // Crosshair bbox placement of a blank scrubber (the video/filmstrip Add
    // pattern; surfaced in the command palette like every other Add command).
    { id: "add-video-scrub", title: "Add Video Scrubber", icon: "mdi:video-image", run: (app) => app.armCrosshairPlacement(videoScrubPlugin) },
  ],
};
