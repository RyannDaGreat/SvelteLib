/**
 * Video PLAYER widget — a sampled-texture quad of a video the user drops in or
 * picks from the project's assets, playing back via a plain HTML `<video>`
 * element. THE second media widget (after image), and the proof the render
 * cornerstone holds for MOVING raster content: it renders through the Skia
 * raster path (the element's CURRENT frame uploaded to a texture each paint —
 * render_gpu/gpu/video_registry.getSkiaVideoFrame) AND through the PDF backend
 * (as a CURRENT-FRAME embedded image XObject).
 *
 * ── PLAYER, NOT SCRUBBER (manifest glossary) ──────────────────────────────────
 * This is the video *player*: playback runs as ordinary HTML `<video>` playback
 * and does NOT touch document/tween state — a looping clip never fights the
 * delta/alpha system. The *scrubber* (plugins/video_scrub.js), whose current-time
 * IS tweened deterministic state, is the sibling widget; it exists. So this
 * plugin's state holds only PARAMETERS (src + playback flags), never frames.
 *
 * AND THAT COSTS DETERMINISM — MEASURED, not conceded in the abstract. This
 * docblock used to call the headless result "the poster/first frame, which is
 * deterministic". It is neither: the element keeps playing while the worker
 * renders, so which clip frame lands on which output frame depends on decode and
 * buffering timing. The same job, the same frame index, two runs, different md5
 * (wave-1 measurement, recorded at claude_instructions.md R6-12). Δt = 0 does NOT
 * leave this widget unchanged, so it is not recordable state under the law in
 * CLAUDE.md — it is the one place in the app that is EPHEMERAL, which is why
 * server/server.py attaches a warning naming this type on every render. R6-12.3
 * removes the category by collapsing onto the scrubber's model.
 *
 * ── NO PLAYBACK-PROGRESS EXPORTS (deliberate) ─────────────────────────────────
 * Unlike the SCRUBBER, the player exposes NO seconds/progress/duration exports.
 * Its current time is the wall clock of a live `<video>` element — NOT document
 * state and NOT pure(document, slide, alpha) — so a "how far along" value here
 * would be non-deterministic and unrepeatable in the CLI/PDF paths. Rather than
 * fabricate a time, the player has none: bind a progress bar to a video SCRUBBER
 * (plugins/video_scrub.js), whose time IS deterministic state and which therefore
 * carries the `seconds`/`progress`/`duration` exports.
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

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { videoSrcRow } from "../core/video_sampling.js";
import * as T from "../core/transform.js";
import { video } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** THE UNSOURCED DEFAULT IS THE EMPTY STRING, and it used to be a 1×1 transparent
 * PNG data URI copied from the image widget's BLANK_SRC. The justification written
 * beside that copy — "an image src is fine: it decodes to one transparent frame" —
 * is FALSE for a `<video>`, which refuses a PNG outright with `MediaError code 4:
 * Unable to load URL due to content type` (measured). So every freshly added,
 * not-yet-sourced video widget logged a load failure on the paint that created its
 * element, and once a failed source FAILS the render (web/renderJobPage.js
 * settledFrame) that default would have made an unsourced widget refuse the whole
 * job. `emit` already draws nothing for an empty src, so the empty string is both
 * the honest representation of "not sourced yet" and the one that reaches no
 * decoder. Precedent: plugins/demo/video_v8.js:84 `src: ""` — "empty → poster only,
 * no element, no load error". */
const UNSOURCED = "";

export const videoPlugin = {
  type: "video",
  // NEVER settles, and says so rather than poisoning an export silently:
  // the <video> element runs on the BROWSER's clock deliberately (a player's playing is not document state), so it never reaches a fixed point.
  // NEVER is a DEFECT, not a design option (core/ephemeral.js) — grandfathered.
  ephemeral: EPHEMERAL.NEVER,
  title: "Video",
  // THE WIDGET A DROPPED VIDEO BECOMES (core/registry.js assetDropKindOf) — the
  // PLAYER, not the scrubber, which is the pre-existing behaviour preserved: a
  // scrubber's deterministic frame is authored deliberately, never landed on by
  // dragging a file in.
  assetDrop: "video",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): the asset
  // picker — choosing the Source is a media widget's primary edit action, the
  // counterpart of double-click-to-edit-text. `primaryAsset` names WHICH property
  // that picker fills; this string is what says the double-click opens it at all.
  activate: "asset_picker",
  primaryAsset: "src",
  defaults: {
    type: "video", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: UNSOURCED,
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
    stroke: "#000000",
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
    videoSrcRow("Source"),
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
   * widget draws nothing rather than emitting an invalid op) — which is also what
   * a freshly added, not-yet-sourced widget does, since its default src is the
   * empty string (see UNSOURCED).
   *
   * THE PLAYBACK FLAGS ARE NOT IN THE OP, AND TODAY THAT MEANS THEY DO NOTHING.
   * This docblock used to say the registry "reads them off state". It does not:
   * `ensureVideo(src, flags)` has exactly ONE production call site,
   * render_gpu/gpu/video_registry.js:255, and it passes NO flags, so every element
   * is created with that function's own defaults (autoplay/loop/muted all true).
   * The Inspector's autoplay / loop / muted rows above are therefore INERT —
   * setting muted:false or autoplay:false changes the document and nothing else.
   * The sibling `videoV2` op DOES carry the three flags (render_gpu/ir.js:1570),
   * which is the shape this one needs; making them real is a two-line change to
   * `ir.js video()` plus the read in render_gpu/skia/browser_media.js sceneMedia,
   * and it is deliberately not bundled here because R6-12.3 (collapse every video
   * widget into one, on the deterministic scrubber model) decides whether a
   * wall-clock playback flag survives at all. Written down rather than left
   * implied: a control that reports nothing is exactly the defect class this app
   * keeps finding.
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
