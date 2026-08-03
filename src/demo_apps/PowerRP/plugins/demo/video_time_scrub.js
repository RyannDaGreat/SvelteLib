/**
 * Video TIME SCRUBBER — a demo video scrubber whose current-time is driven by the
 * presentation clock through equation PRESETS (manifest item 72).
 *
 * ── WHY THIS EXISTS (the user's question) ─────────────────────────────────────
 * "A scrubber with the time just being the time variable modulo self.length should
 * be equivalent [to a looping player], right?" This widget IS that: it is the
 * video SCRUBBER (plugins/video_scrub.js) with its `scrubTime` bound, by preset,
 * to a function of the presentation clock `time` — the headline being LOOP:
 *   currentTime = time % self.length
 * i.e. play the clip forward and wrap at its end, forever, WITHOUT a wall-clock
 * `<video>` player. Because the frame shown is `pure(document, slide, alpha, t)`
 * with `t` the deterministic particle clock (render_gpu/particle_clock), the look
 * is a looping player in the presenter yet BYTE-REPRODUCIBLE in an export (the
 * exporters override `t` per frame — the recordable-state contract).
 *
 * ── RELATION TO video_scrub.js / video_v5_scrub.js (the fence) ────────────────
 * A plugin may NOT import another plugin. This widget is a SIBLING of the core
 * scrubber, related to it exactly as plugins/demo/video_v5_scrub.js is: same
 * document-state contract (`scrubTime`/`scrubWrap`), same async seek-and-await
 * draw path, same `videoFrame` IR op and decode pipeline (render_gpu/gpu/
 * video_registry — deterministic, headlessly awaited by browser_media.prepare-
 * SceneScrubFrames). It composes only shared capabilities + core property helpers
 * + the additive things it OWNS (the `length` prop, the clock presets, the probe
 * command). The three shared default STRINGS (the unsourced src + the export
 * equations) are repeated locally — they are constants, not behaviour.
 *
 * ── WHAT THIS WIDGET ADDS OVER THE CORE SCRUBBER ──────────────────────────────
 *  1. `length` (seconds) — the clip's INTRINSIC duration, the `self.length` the
 *     presets divide by. Its deterministic source is ffprobe on the server
 *     (server/server.py video_duration_seconds; the "Probe Clip Length" command
 *     writes it, and it also rides each video's listAssets entry as `durationSec`).
 *     It is a stored numeric prop (default 0 = unknown → an honest "don't know
 *     yet"): once written it is ordinary property state, so the document stays
 *     machine-stable and `pure(document)`. It REPLACES the core scrubber's manual
 *     `duration` knob — here the one number is both the progress divisor AND the
 *     modulo length, which is the whole point of "no distinction between a player
 *     and a scrubber" the user asked for. Hand-typeable (its Inspector row) for
 *     when the server probe is unavailable.
 *  2. `animated` (default true) — a clock-driven `scrubTime` must REPAINT every
 *     presenter frame to advance (the core scrubber is static document state and
 *     is deliberately NOT animated). A constant preset (Freeze Frame) still repaints
 *     harmlessly; turn `animated` off to pin a still.
 *  3. PRESETS — ready-made `scrubTime` equations over `time` + `self.length`
 *     (below). Applied by app.applyPreset, which writes the equation SOURCE string
 *     verbatim onto `scrubTime`, so a preset IS just an equation the user could
 *     have typed. The scrubTime DEFAULT is a plain `0` (first frame, static): a
 *     freshly added widget is not time-driven until a preset is applied AND a
 *     positive `length` is known, so it never shows `time % 0 = NaN`.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────────
 * `time` is read ONLY through the particle-clock seam (core/expressions evaluates
 * `time` via particleTime()). Δt = 0 ⟹ the frame is unchanged (recordable-state
 * law): freeze the clock and the same (slide, alpha) is byte-identical; advance it
 * and the clip scrubs. The exporters set the clock per frame (videoExport.create-
 * FrameSampler → setParticleTimeOverride) and await the decode, so an export is
 * reproducible frame-for-frame. This widget does NOT touch the video PLAYER or
 * gpu/video_registry's wall-clock playback path (user ruling: player stays as-is).
 */

import { convergesOnRefs } from "../../render_gpu/gpu/settled.js";
import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props, SECONDS_SCRUB } from "../../core/properties.js";
import { videoSrcRow } from "../../core/video_sampling.js";
import * as T from "../../core/transform.js";
import { videoFrame } from "../../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";

/** THE UNSOURCED DEFAULT IS THE EMPTY STRING — see plugins/video.js's UNSOURCED
 *  for the reasoning. This widget emits the same `videoFrame` op as the core
 *  scrubber and therefore reaches the same `<video>` decoder, which refuses a PNG
 *  data URI (`MediaError code 4`), so it carried the same defect and gets the same
 *  fix. `emit` already draws nothing for an empty src. Precedent:
 *  plugins/demo/video_v8.js:84. */
const UNSOURCED = "";

// PLAYBACK-PROGRESS EXPORTS (derived, read-only PROPS — bare `self.`-equations so
// they are isNumericSlot leaves: discoverable in the equation autocomplete AND real
// equation slots the derive/evaluate pass settles to numbers). `seconds` = the
// current decode time; `progress` = clamp(scrubTime / length), 0 when the length is
// unknown (an honest "don't know yet", never a fabricated fraction). Unlike the core
// scrubber these divide by `self.length` (this widget's ONE duration number), not a
// separate `duration` knob. Other widgets read them un-transformed: `= @thisScrubber.progress`.
export const SECONDS_EXPORT_EQ = "self.scrub_time";
export const PROGRESS_EXPORT_EQ =
  "self.length > 0 ? Math.max(0, Math.min(1, self.scrub_time / self.length)) : 0";

/**
 * Clock-driven `scrubTime` PRESETS — the equation SOURCE strings app.applyPreset
 * writes verbatim onto `scrubTime`, each carrying the universal "=" marker per
 * R6-25.1. The marker is not decoration here: applyPreset writes the value RAW,
 * so this string IS the stored value, and without the marker a stored equation
 * is an equation only while its slot's default happens to be a number. On this
 * row it is (so the bare form these shipped as evaluated correctly), but the
 * same string on a colour or enum row would have stored a silent literal — and
 * the rule cannot be "it depends what the default is today". Every one is a
 * function of the presentation
 * clock `time` and the clip's `self.length`, so each is RECORDABLE state (a
 * function of elapsed time alone) and reproducible in an export. The simple ones
 * are pure restricted-grammar arithmetic (`%` `*` `/` `+` `-`); the advanced ones
 * use `Math.abs`/`Math.floor`, which the evaluator's full-JS path handles exactly
 * like the existing `progress` export's `Math.max`/`Math.min` (they evaluate
 * correctly — the only cost is that the field highlighter does not colourise a
 * `Math` member yet, a cosmetic bound shared with every stored Math equation).
 *
 * Each literal speed/step-rate is named by the preset's description rather than the
 * equation, since an equation string is preset DATA, not code.
 */
export const TIME_SCRUB_PRESETS = [
  { name: "Loop", description: "Play forward and wrap at the clip's end, forever: currentTime = time mod length. The headline preset — a looping player, made deterministic.",
    props: { scrubTime: "= time % self.length" } },
  { name: "Reverse", description: "Play BACKWARD on a loop (the clip runs end-to-start, then jumps back to the end): length − (time mod length).",
    props: { scrubTime: "= self.length - (time % self.length)" } },
  { name: "Half Speed", description: "Loop at half speed — the clock is divided by 2 before wrapping, so the clip takes twice as long to play through.",
    props: { scrubTime: "= (time / 2) % self.length" } },
  { name: "Double Speed", description: "Loop at double speed — the clock is multiplied by 2 before wrapping, so the clip plays through twice as fast.",
    props: { scrubTime: "= (time * 2) % self.length" } },
  { name: "Reverse Half Speed", description: "Play backward on a loop at half speed: length − ((time ÷ 2) mod length).",
    props: { scrubTime: "= self.length - ((time / 2) % self.length)" } },
  { name: "Ping-Pong", description: "Bounce: play forward to the end, then backward to the start, forever — a triangle wave of period 2·length, amplitude length.",
    props: { scrubTime: "= self.length - Math.abs((time % (2 * self.length)) - self.length)" } },
  { name: "Boomerang Burst", description: "A double-speed ping-pong — the clip bounces forward-and-back twice as fast as Ping-Pong, for a restless boomerang.",
    props: { scrubTime: "= self.length - Math.abs(((time * 2) % (2 * self.length)) - self.length)" } },
  { name: "Slow-Mo Ramp", description: "An eased loop: the clip accelerates through each pass (a quadratic ease-in) — slow at the start of the loop, fast at the end. eased = (time mod length)² ÷ length.",
    props: { scrubTime: "= ((time % self.length) * (time % self.length)) / self.length" } },
  { name: "Stutter", description: "A stuttered loop — time is quantised to quarter-second steps (4 holds per second) before wrapping, so the clip advances in visible jerks.",
    props: { scrubTime: "= (Math.floor(time * 4) / 4) % self.length" } },
  { name: "Strobe Skip", description: "A strobe that leaps around the clip — twice a second it jumps to the next third (0 → ⅓ → ⅔ → 0…), never scrubbing smoothly.",
    props: { scrubTime: "= (Math.floor(time * 2) * (self.length / 3)) % self.length" } },
  { name: "Freeze Frame", description: "Hold one frame — the middle of the clip (length ÷ 2), constant in time. The degenerate case: a scrubber that does not move (turn `animated` off to stop repainting it).",
    props: { scrubTime: "= self.length / 2" } },
];

/**
 * Command (async; browser-only). Probes the SELECTED video-time-scrubber's clip
 * for its intrinsic duration (ffprobe on the server) and writes it onto `length`,
 * so the time-driven presets have a real `self.length` to divide by. Loud on: no
 * selection, a source that is not a saved project video (a data: URI or bare URL
 * cannot be ffprobed server-side), or a server/probe failure. The projectApi
 * import is DYNAMIC so this plugin file stays bare-node importable (projectApi
 * reads `location` at module load; a static import would crash the node tests).
 *
 * @param {object} app The editor app (selection, state(), setPreview/commitPreview, projectName()).
 */
async function probeClipLength(app) {
  const id = app.selection;
  if (id == null) throw new Error("Probe Clip Length: select a video time scrubber first");
  const src = app.state().items[id]?.src;
  // A project asset is served as /asset/<project>/<file...>; only those can be ffprobed.
  const m = /^\/asset\/([^/]+)\/(.+)$/.exec(typeof src === "string" ? src : "");
  if (!m)
    throw new Error(`Probe Clip Length: the scrubber's source is not a saved project video (got ${src}) — save the video into the project's assets and pick it, then probe.`);
  const project = decodeURIComponent(m[1]);
  const file = decodeURIComponent(m[2].split("/").pop());
  const { videoDuration } = await import("../../web/projectApi.js");
  const { durationSec } = await videoDuration(project, file);
  app.setPreview([[["items", id, "length"], durationSec]]);
  app.commitPreview();
}

export const videoTimeScrubPlugin = {
  type: "demo_video_time_scrub",
  // CONVERGES: it draws an async raster (the parked decoder frame). settled.js owns what
  // “ready” means so this cannot drift from its thirteen siblings.
  ephemeral: convergesOnRefs((s) => [s.src]),
  title: "Video Time Scrubber (clock presets)",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // asset picker. `primaryAsset` names WHICH property it fills.
  activate: "asset_picker",
  primaryAsset: "src",
  presets: TIME_SCRUB_PRESETS,
  defaults: {
    type: "demo_video_time_scrub", x: 100, y: 100, w: 320, h: 180, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: UNSOURCED,
    // The deterministic scrub state: time (seconds) + past-end behavior. scrubTime
    // defaults to a plain 0 (first frame, STATIC) — NOT a preset — so a freshly
    // added widget never evaluates `time % 0`. Apply a preset to make it clock-driven.
    // scrubWrap defaults to "loop" (a looping preset expects a wrapping clip).
    ...defaults("scrubTime", "scrubWrap", "opacity"),
    scrubWrap: "loop",
    // `animated` (default true): a clock-driven scrubTime must repaint every
    // presenter frame to advance (see the header). opacity:1.
    ...defaults("animated"),
    // The clip's intrinsic duration in seconds — the `self.length` the presets
    // divide by. 0 = unknown (probe it, or type it). See the header.
    length: 0,
    // Read-only, derived progress exports (divide by `length`; see above).
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
    // THE scrub controls: the keyframable/equation-bindable time (presets write it)
    // + wrap mode, then the clip length the presets divide by.
    ...props("scrubTime", "scrubWrap"),
    { key: "length", label: "Clip length (s)", kind: "number", min: 0, scrub: SECONDS_SCRUB, category: "formatting", help: "The clip's intrinsic duration in seconds — the `self.length` the time-driven presets divide by (e.g. Loop = `time % self.length`) and the divisor of the read-only `progress` export. Use the \"Probe Clip Length\" command to fill it from the server (ffprobe, deterministic), or type it. Left 0 (unknown), the looping presets evaluate to NaN and fall back — so set it before applying a preset." },
    // `animated`: keep the presenter repainting so a clock-driven scrubTime advances.
    ...props("animated"),
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
   * `videoFrame` op carrying the EVALUATED `scrubTime` (the preset equation is
   * already a number here — the expression pass read `time` from the clock and
   * computed `time % self.length` before emit) + `scrubWrap`. Byte-identical to
   * the core scrubber's emit (cropInsetsToSource → videoFrame → decorateStrokedBox
   * → applyEffects); this widget differs only in WHERE `scrubTime` comes from (a
   * clock preset vs a keyframe). Returns nothing for an empty src or a fully
   * cropped-away quad.
   *
   * @example videoTimeScrubPlugin.emit({src: "clip.mp4", w: 320, h: 180, scrubTime: 1.5}, null, T.identity())[0].op // "videoFrame"
   * @example videoTimeScrubPlugin.emit({src: "", w: 320, h: 180}, null, T.identity()) // []
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
    // Crosshair bbox placement of a blank time scrubber (the video/scrubber Add
    // pattern; surfaced in the command palette like every other Add command).
    { id: "add-video-time-scrub", title: "Add Video Time Scrubber (clock presets)", icon: "mdi:motion-play-outline", run: (app) => app.armCrosshairPlacement(videoTimeScrubPlugin) },
    // Fill `length` from the server (ffprobe) for the selected scrubber's clip.
    // GATED: `probeClipLength` reads app.selection in its first line and throws
    // when there is none, so without a `when` the palette offered it against an
    // empty selection and answered with an exception instead of a greyed row —
    // the defect tests/palette_probe.js's
    // `sweep-every-selection-command-declares-its-gate` sweep flags. The gate is
    // narrower than "any selection" because the command is meaningless on any
    // other widget: it writes THIS plugin's `length` property.
    {
      id: "probe-video-time-scrub-length",
      title: "Probe Clip Length (ffprobe)",
      icon: "mdi:ruler-square",
      when: (app) => app.selectedNode()?.type === "demo_video_time_scrub",
      requires: "a selected Video Time Scrubber — this fills that widget's own `length` from its clip",
      run: probeClipLength,
    },
  ],
  // …AND IT REACHES THE TOOLS PANE. A gate is only half of an affordance: the
  // command above was findable in the palette and nowhere else, which is the exact
  // complaint that produced tests/tool_surfacing_probe.js ("Why do I have to open
  // the command palette to find these things?"). It rides the pool's EXISTING Edit
  // section — a one-row section of its own would be the "section of one" the light
  // pin was talked out of — and inherits that section's title rather than
  // re-spelling it. No `applies` is needed: a plugin's own group is already scoped
  // to this widget, which is what makes THIS the right home for a type-specific
  // tool and the pool the right home for a general one.
  toolGroups: [
    { id: "edit", rows: [{ kind: "command", command: "probe-video-time-scrub-length" }] },
  ],
};
