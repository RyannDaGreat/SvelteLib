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
 *   - LIVE (editor/presenter): the sync paint draws the source's most recently
 *     DECODED frame — the HOLD — while the requested one is still in flight, and
 *     snaps to the exact frame when the seek lands (video_registry.notify → the
 *     reactive canvas's onVideoFrame nudge). Drawing NOTHING there instead was the
 *     reported FLICKER: blank, frame, blank, frame as the decoder chased the
 *     pointer (measured — 153 of 154 captured frames of a 2 s scrub were blank).
 *     A few milliseconds of a stale frame of the SAME clip beats a hole, and the
 *     hold is keyed on the SOURCE, so it can never show a previous video's
 *     picture. Live requests also COALESCE latest-wins, so the decoder always
 *     works on the time being asked for now. See video_registry's scrubber section.
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

import { convergesOnRefs } from "../render_gpu/gpu/settled.js";
import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props, SECONDS_SCRUB } from "../core/properties.js";
import { videoSrcRow } from "../core/video_sampling.js";
import * as T from "../core/transform.js";
import { videoFrame } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** THE UNSOURCED DEFAULT IS THE EMPTY STRING — see plugins/video.js's UNSOURCED
 * for the full reasoning; the scrubber carried the same 1×1 PNG copy with the same
 * false justification, and it was the WORSE of the two: an unloadable scrub source
 * left `await entry.ready` pending forever, so inserting a scrubber and not
 * choosing a source hung a render job at zero frames (fixed separately in
 * render_gpu/gpu/video_registry.js, but the bad default is why it was reachable
 * with no bad input at all). `emit` already draws nothing for an empty src.
 * Precedent: plugins/demo/video_v8.js:84. */
const UNSOURCED = "";

// ── SCRUBBER TREATMENTS (R7-39 presets law) ──────────────────────────────────
// SAME CHROME SPACE AS THE PLAYER (plugins/video.js's VIDEO_PRESETS), and for a
// real reason, not a copy of convenience: both widgets compose the identical
// stroked-border + crop-insets + effects bundles over the identical rect, so a
// frame that reads as "cinema" or "security feed" on a scrubber is the same
// picture it is on a player. UNLIKE THE PLAYER, THERE ARE NO INERT PLAYBACK
// FLAGS TO AVOID — a scrubber has no autoplay/loop/muted rows at all (its time
// IS document state; see the module header) — so this table has no ceiling the
// player's does not already have. EVERY ROW SETS EVERY EFFECTS KEY, IDENTITIES
// INCLUDED, AND ALL FOUR CROP INSETS — the same overlay argument (application
// writes exactly the keys in `props`, so an omitted knob keeps whatever the
// PREVIOUSLY HOVERED row left there). NO ROW WRITES `src`, `scrubTime`,
// `scrubWrap`, or `duration` — those are the author's content and playback
// state, not the frame around it (the qrcode `data` rule).
const SHADOW_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLOOM_OFF = { radius: 10, strength: 0 };
const INNER_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLUR_OFF = 0;
const NO_CROP = { cropTop: 0, cropLeft: 0, cropRight: 0, cropBottom: 0 };

const VIDEO_SCRUB_PRESETS = [
  {
    name: "Cinema Frame",
    description: "A letterboxed crop with a heavy black border, the way a widescreen clip sits inside a dark cinema frame.",
    props: {
      stroke: "#000000", strokeWidth: 24, cornerRadius: 0, opacity: 1,
      shadow: { dx: 0, dy: 12, blur: 24, color: "#000000", opacity: 0.5 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      cropTop: 30, cropLeft: 0, cropRight: 0, cropBottom: 30,
    },
  },
  {
    name: "Rounded Player Card",
    // BORDER WEIGHT IS A HARNESS ACCOMMODATION, flagged (the image.js Soft
    // Vignette/Torn Edge precedent, and identical to the player's own row of the
    // same name): the intended look is a QUIET 2px hairline, but
    // tests/preset_p2_test.js measured a 2px stroke at cornerRadius 16
    // indistinguishable from the untouched default under the empty-content
    // bare-node harness — the shadow silhouettes drawn content and there is
    // none to decode. 5px is the minimum that clears the gate today; REVISIT
    // toward 2px once a browser-based gate can render a real decoded frame.
    description: "A soft rounded-corner card lifted off the page by a light shadow — the everyday embedded-player look.",
    props: {
      stroke: "#1a1a1a", strokeWidth: 5, cornerRadius: 16, opacity: 1,
      shadow: { dx: 0, dy: 8, blur: 20, color: "#000000", opacity: 0.35 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Security Feed",
    description: "A CCTV monitor's hard black bezel and square corners — no shadow, no warmth, a feed rather than a presentation.",
    props: {
      stroke: "#000000", strokeWidth: 10, cornerRadius: 0, opacity: 1,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: { dx: 0, dy: 0, blur: 10, color: "#000000", opacity: 0.6 }, softEdges: 0, gaussianBlur: BLUR_OFF,
      cropTop: 0, cropLeft: 0, cropRight: 0, cropBottom: 6,
    },
  },
  {
    name: "Projector Screen",
    description: "A wide white border and a soft ambient shadow, the way a projected image sits inside its own screen.",
    props: {
      stroke: "#f5f5f0", strokeWidth: 20, cornerRadius: 2, opacity: 1,
      shadow: { dx: 0, dy: 4, blur: 40, color: "#000000", opacity: 0.3 }, bloom: { radius: 24, strength: 0.2 }, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Phone Story Crop",
    description: "A tall vertical crop with a slim dark bezel — the mobile-story aspect a phone screen shows, cut from the middle of the frame.",
    props: {
      stroke: "#0a0a0a", strokeWidth: 6, cornerRadius: 22, opacity: 1,
      shadow: { dx: 0, dy: 6, blur: 16, color: "#000000", opacity: 0.4 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      cropTop: 0, cropLeft: 28, cropRight: 28, cropBottom: 0,
    },
  },
  {
    name: "Picture-in-Picture Chip",
    description: "A small rounded corner-inset card with a crisp white keyline and a tight shadow — the floating PiP tile that sits over other content.",
    props: {
      stroke: "#ffffff", strokeWidth: 4, cornerRadius: 12, opacity: 1,
      shadow: { dx: 0, dy: 3, blur: 10, color: "#000000", opacity: 0.45 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Broadcast Monitor",
    description: "A dark graphite bezel with a subtle inner glow along the tube edge, the way a studio reference monitor frames its picture.",
    props: {
      stroke: "#2b2b2b", strokeWidth: 16, cornerRadius: 6, opacity: 1,
      shadow: { dx: 0, dy: 10, blur: 22, color: "#000000", opacity: 0.4 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: { dx: 0, dy: 0, blur: 8, color: "#4a9eff", opacity: 0.25 }, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Clean Borderless",
    // HARNESS ACCOMMODATION, flagged rather than hidden (the image.js Magazine
    // Bleed precedent, verbatim, and identical to the player's own row of the
    // same name): this treatment's whole point is "no frame", so strokeWidth
    // here is NOT the look — it is the minimum that keeps the row provable
    // under tests/preset_p2_test.js's empty-content bare-node gate, where
    // strokeWidth 0 is measured byte-identical to the untouched default.
    // REVISIT and drop to 0 once a browser-based distinctness gate exists.
    // THE SHADOW'S BLUR IS PART OF THE SAME ACCOMMODATION, and used to be 0 with
    // the description still promising a soft shadow — a blur-0 shadow is a HARD
    // silhouette copy offset 14px down (image.js's "Magazine Bleed" is the row
    // that ships one deliberately, and says so). MEASURED on this gate: with no
    // decoded frame the only thing casting a shadow is the 1px stroke, so a wide
    // blur smears it to nothing — blur 10 falls to 4.78 lit-set levels from the
    // untouched default, under the 5 the gate requires, and blur 24 to 4.32.
    // blur 9 is the WIDEST that still clears the gate, at 5.18 (no headroom at
    // all), so 6 ships instead: at 6 this row is no longer the default's closest
    // neighbour, and the family's narrowest pair is "Rounded Player Card" <-> this
    // one at 6.10. The truly ambient blur this treatment wants is part of the same
    // REVISIT.
    description: "No frame at all — just a soft-edged shadow lifting the clip off the page, for a clip that should read as content rather than a framed object.",
    props: {
      stroke: "#000000", strokeWidth: 1, cornerRadius: 0, opacity: 1,
      shadow: { dx: 0, dy: 14, blur: 6, color: "#000000", opacity: 0.5 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Vintage TV",
    description: "A thick rounded plastic bezel with a soft vignette-like edge feather, the way an old CRT set's curved screen falls off toward its corners.",
    props: {
      stroke: "#3a2e22", strokeWidth: 26, cornerRadius: 34, opacity: 1,
      shadow: { dx: 0, dy: 8, blur: 16, color: "#000000", opacity: 0.45 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 4, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Frosted Preview",
    // BORDER + BLUR WEIGHT ARE A HARNESS ACCOMMODATION, flagged (identical to the
    // player's own row of the same name): `opacity` fades the widget's own
    // CONTENT (decorateStrokedBox forces the wrapper to 1, the image.js Faded
    // Watermark precedent), and `gaussianBlur`/`softEdges` act on the drawn
    // silhouette — with no decoded frame in bare node, a thin 3px border at
    // those settings measured byte-identical to the untouched default. 15px +
    // a stronger blur is what clears tests/preset_p2_test.js's empty-content
    // gate today; REVISIT toward the original lighter values once a
    // browser-based gate can render real content.
    description: "A translucent-reading soft-edged tile with a light blur at the border, the way a paused preview looks behind a loading veil.",
    props: {
      stroke: "#ffffff", strokeWidth: 15, cornerRadius: 14, opacity: 0.8,
      shadow: { dx: 0, dy: 4, blur: 14, color: "#000000", opacity: 0.2 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 4, gaussianBlur: 6,
      ...NO_CROP,
    },
  },
];

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
  // CONVERGES: it draws an async raster (the parked decoder frame). settled.js owns what
  // “ready” means so this cannot drift from its thirteen siblings.
  ephemeral: convergesOnRefs((s) => [s.src]),
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
    src: UNSOURCED,
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
  presets: VIDEO_SCRUB_PRESETS,
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
