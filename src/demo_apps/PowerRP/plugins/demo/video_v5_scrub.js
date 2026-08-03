/**
 * Video V5 SCRUBBER — the DETERMINISTIC scrubber (plugins/video_scrub.js UX)
 * driven through the off-main-thread V5 frame pipeline (render_gpu/skia/video_v5.js
 * + video_v5_worker.js) instead of the main-thread seek path the core scrubber
 * uses (render_gpu/gpu/video_registry.js).
 *
 * It is the A/B twin of the video SCRUBBER, related to it exactly as the demo
 * video_v5 PLAYER is related to the core `video` player: same widget, same
 * document-state contract, only the FRAME-DELIVERY pipeline differs.
 *
 * ── PLAYER vs SCRUBBER (unchanged from video_scrub.js) ────────────────────────
 * A player plays via wall-clock `<video>` playback (non-deterministic frame). A
 * scrubber's current-time IS document state — `scrubTime`, a keyframable,
 * EQUATION-BINDABLE number (seconds) — so the displayed frame is the video
 * decoded AT that time: pure(document, slide, alpha). The SAME (slide, alpha)
 * always shows the SAME frame — deterministic and headlessly reproducible. This
 * is the graceful answer to "tweening a looping video": keyframe `scrubTime`
 * across slides (or bind it to an equation) and the clip scrubs as the slide
 * tweens. N scrubbers whose `scrubTime` resolves to the same value decode the
 * same frame — frame-lockstep with no dedicated sync mechanism.
 *
 * ── WHAT "V5" CHANGES (and what it does NOT) ──────────────────────────────────
 * emit() is PURE and returns a `videoV5Frame` op (the A/B twin of the core
 * scrubber's `videoFrame`). The raster backend PARKS a paused decoder at the
 * evaluated `scrubTime` and awaits the frame — but through the V5 registry's
 * OWN off-main-thread scrub decoder (render_gpu/skia/video_v5.requestVideoV5-
 * ScrubFrame: seek a paused `<video>`, then convert the frame via
 * createImageBitmap OFF the main thread), keyed by the "v5|"-prefixed
 * videoV5FrameKey so it never collides with a core scrubber on the same
 * (ref, time, wrap). The document-state contract, the keyframable/equation
 * binding, the progress exports, and the async draw contract are byte-identical
 * to video_scrub.js — only the decode pipeline moved off the main thread.
 *
 * ── HOW A FRAME REACHES THE CANVAS (the async seek-and-await) ─────────────────
 *   - LIVE (editor/presenter): the sync paint draws NOTHING for a not-yet-decoded
 *     frame and repaints when the seek lands (video_v5's notify() nudge) — the
 *     image pipeline's async contract applied to seeks.
 *   - HEADLESS one-shot (thumbnails / PNG export / the puppeteer render hook via
 *     web/gpuService.js): the pixel path AWAITS every V5 scrub frame BEFORE
 *     painting (browser_media.prepareSceneScrubFrames), so its output is
 *     reproducible.
 * The pure-Node CLI (cli/render.js) has no `<video>` element, so — like the
 * image/video ops there today — the widget draws NOTHING in that path (an
 * honest, documented bound, not a fake frame).
 *
 * ── PLAYBACK-PROGRESS EXPORTS (seconds / progress / duration) ─────────────────
 * Identical to video_scrub.js: `seconds` = scrubTime; `duration` = a user-
 * supplied clip length (the real duration is only knowable at browser decode
 * time, not in pure state); `progress` = clamp(scrubTime / duration), 0 when
 * duration is unknown (an honest "don't know yet"). All three are equation-
 * bindable PROPS other widgets read un-transformed via `= @thisScrubber.progress`.
 *
 * Not a plugin import of any other plugin (the fence): it composes only shared
 * capabilities + core property helpers + the additive `videoV5Frame` IR op. The
 * three shared default STRINGS (the unsourced src + the two export equations) are repeated
 * locally — they are constants, not behavior — exactly as video_v5.js repeats
 * that constant rather than importing it from video.js.
 */

import { convergesOnRefs } from "../../render_gpu/gpu/settled.js";
import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props, SECONDS_SCRUB } from "../../core/properties.js";
import { videoSrcRow } from "../../core/video_sampling.js";
import * as T from "../../core/transform.js";
import { videoV5Frame } from "../../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";

/** A 1×1 transparent PNG data URI — the default `src` (a valid, invisible-until-
 *  sourced widget rather than a broken ref). Mirrors video_scrub.js/video_v5.js
/** THE UNSOURCED DEFAULT IS THE EMPTY STRING — see plugins/video.js's UNSOURCED
 *  for the full reasoning. This widget's op reaches an HTMLMediaElement decoder,
 *  and a `<video>` refuses a PNG data URI (`MediaError code 4`), so the copied
 *  image-widget default logged a load failure on every unsourced insert. `emit`
 *  already draws nothing for an empty src. Pinned by tests/unsourced_media_test.js,
 *  which DERIVES its subjects from the registry so a new video widget joins the law
 *  by existing. Precedent: plugins/demo/video_v8.js:84. */
const UNSOURCED = "";

// PLAYBACK-PROGRESS EXPORTS (derived, read-only PROPS — see the header). Bare
// `self.`-equations so they are isNumericSlot leaves: discoverable in the equation
// autocomplete AND real equation slots the derive/evaluate pass settles to numbers.
// Same values as video_scrub.js (repeated, not imported — the fence).
export const SECONDS_EXPORT_EQ = "self.scrub_time";
export const PROGRESS_EXPORT_EQ =
  "self.duration > 0 ? Math.max(0, Math.min(1, self.scrub_time / self.duration)) : 0";

export const videoV5ScrubPlugin = {
  type: "video_v5_scrub",
  // CONVERGES: it draws an async raster (the worker-decoded frame). settled.js owns what
  // “ready” means so this cannot drift from its thirteen siblings.
  ephemeral: convergesOnRefs((s) => [s.src]),
  title: "Video V5 Scrubber (OffscreenCanvas/worker)",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // asset picker. `primaryAsset` names WHICH property that picker fills; this
  // string is what says the double-click opens it at all.
  activate: "asset_picker",
  primaryAsset: "src",
  defaults: {
    type: "video_v5_scrub", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: UNSOURCED,
    // The deterministic scrub state: time (seconds) + past-end behavior, both from
    // the shared property registry. scrubTime defaults to 0 (first frame); scrubWrap
    // to "clamp". NO playback flags — a scrubber never plays; its time is doc state.
    ...defaults("scrubTime", "scrubWrap", "opacity"),
    // PLAYBACK-PROGRESS EXPORTS (see header). `duration` is the user-supplied clip
    // length in seconds (0 = unknown → progress 0); `seconds`/`progress` are the
    // derived, read-only exports other widgets bind to (`= @thisScrubber.progress`).
    duration: 0,
    seconds: SECONDS_EXPORT_EQ,
    progress: PROGRESS_EXPORT_EQ,
    // stroke COLOR default matches every other stroked shape; paints only once
    // strokeWidth > 0 (0 by default → an undecorated scrubber draws no border).
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius"),
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("transform"),
    // The video source — VIDEO assets (same picker/drop as the player).
    videoSrcRow("Source"),
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
   * `videoV5Frame` op carrying the EVALUATED `scrubTime` (equations are already
   * numbers here) + `scrubWrap` — the raster backend seeks a paused V5 decoder to
   * that time (off the main thread) and awaits the frame. Returns nothing for an
   * empty/missing src or a fully-cropped-away quad (a broken widget draws nothing
   * rather than emitting an invalid op). Edge-crop + border + rounded corners +
   * effects are applied EXACTLY like the core scrubber (cropInsetsToSource →
   * decorateStrokedBox → applyEffects) — this widget differs from video_scrub.js
   * ONLY in the op it emits (videoV5Frame vs videoFrame), i.e. the decode pipeline.
   *
   * @example videoV5ScrubPlugin.emit({src: "clip.mp4", w: 320, h: 180, scrubTime: 1.5}, null, T.identity())[0].op // "videoV5Frame"
   * @example videoV5ScrubPlugin.emit({src: "", w: 320, h: 180}, null, T.identity()) // []
   */
  emit(s, _targetWorldIR, world) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw
    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const quad = videoV5Frame({
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
    // Crosshair bbox placement of a blank V5 scrubber (the video/scrubber Add
    // pattern; surfaced in the command palette like every other Add command).
    { id: "add-video-v5-scrub", title: "Add Video V5 Scrubber (worker)", icon: "mdi:video-image", run: (app) => app.armCrosshairPlacement(videoV5ScrubPlugin) },
  ],
};
