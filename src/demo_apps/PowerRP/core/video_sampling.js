/**
 * VIDEO SAMPLING — the ONE declaration of "which clip, and WHICH FRAMES OF IT".
 *
 * ── WHY THIS MODULE EXISTS (a user requirement, not a tidiness pass) ──────────
 * Two widgets draw a SET of stills sampled out of a single video: the FILMSTRIP
 * (plugins/filmstrip.js — the frames laid out in a row on a strip of film) and the
 * IMAGE STACK (plugins/image_stack.js — the same frames piled up and fading back).
 * The user's ruling on the second one, verbatim:
 *
 *   "very similar to filmstrip except slightly different — it should have the same
 *    properties to specify video as filmstrip, so that if I go from one element to
 *    the other, it's easy to fall between them."
 *
 * "Fall between them" is RETYPING (core/retype.js): `type` is an ordinary keyframed
 * leaf, and a retype CARRIES a stored value across iff both types declare the key
 * AND their inspector rows agree on kind (core/retype.js carryVerdict). So the
 * requirement is not "similar properties", it is a LOSSLESS ROUND TRIP —
 * filmstrip → image_stack → filmstrip must return the source untouched.
 *
 * THAT IS WHY THE DECLARATION IS SHARED RATHER THAN COPIED. A second hand-written
 * copy of these rows would satisfy the requirement on the day it was written and
 * break it silently the first time one side changed a `min`, an option or an
 * `assetKinds` — every one of which is a CONTRACT aspect (core/multiselect.js
 * rowContract, whose denylist is exactly the "same row" test used here). A
 * hand-maintained mirror of another module's shape is this codebase's worst
 * recurring defect; there is one declaration and both widgets read it.
 *
 * A plugin may not import another plugin, so the shared home is core/. This module
 * is DOM-free and runs in bare node like the rest of core/.
 *
 * ── WHAT IS SHARED, AND WHAT IS NOT ──────────────────────────────────────────
 * SHARED (VIDEO_SAMPLING_ROWS, in Inspector order):
 *   `src`        the video asset URL — PROPS.src narrowed to VIDEO assets. The
 *                narrowing is baked in HERE because `assetKinds` is a contract
 *                aspect: two video widgets that spell it differently stop being
 *                the same row for both retype and joint editing.
 *   `videoStart` / `videoEnd`  the sampled WINDOW into the clip, in seconds. The
 *                frame list's default equations span it, so ONE edit re-times
 *                every frame in either widget.
 *   `frames`     THE FRAME LIST (core/lists.js): a sequence of one-field TUPLE
 *                elements holding that frame's time in seconds, with the universal
 *                `framesActive` companion for hide-vs-purge. The frame COUNT is the
 *                list's length — there is no second source of truth for it.
 *   `scrubWrap`  past-the-end behaviour, shared with the scrubbers.
 * ALSO SHARED, but placed per widget (`preserveAspectRow`): `preserveAspect`, whose
 * HELP sentence names the widget's own container ("cell" vs "card") and whose
 * Inspector POSITION differs. Both are presentational, so the CONTRACT is still one
 * declaration; see that function for why it is not simply part of the block.
 *
 * NOT SHARED: everything a widget draws WITH the frames. Film gauge, perforations,
 * leader and film colour belong to the filmstrip; the stack's shift, fade and card
 * shadow belong to the image stack. Those are DIFFERENT properties that happen to
 * live next to each other, and merging them would make a retype carry a film
 * perforation family into a widget with no film in it.
 *
 * ── THE DEFAULT FRAME EQUATIONS ──────────────────────────────────────────────
 * Element i of a fresh n-frame list defaults to the EQUATION
 *
 *     self.video_start + i/n * (self.video_end - self.video_start)
 *
 * so ONE edit — `videoEnd` — spreads the whole sample across a clip, and any single
 * frame can still be overridden by typing over its own equation. WHY i/n and not
 * i/(n-1): frame 0 sits AT the start (what a contact sheet is for); i/(n-1) would
 * ask for EXACTLY `videoEnd`, and seeking exactly to a clip's duration is undefined
 * (past the last frame); and i/(n-1) divides by zero at n = 1 while i/n degenerates
 * cleanly to a one-frame sample showing `videoStart`. The span is divided into n
 * equal slots and each element samples the START of its slot.
 *
 * THE EQUATIONS BAKE i AND n deliberately. Re-deriving them from the live list
 * length would mean adding one frame silently RE-TIMES every existing frame, which
 * is exactly the override-ability the equations exist to provide. A widget that
 * wants them evened out again offers that as an explicit command (the filmstrip's
 * `filmstrip-respace-frames`), never as an invisible re-derivation.
 *
 * ── THE THREE KINDS OF STATE ─────────────────────────────────────────────────
 * Property state only. A frame's time is an ordinary keyframable, equation-bindable
 * leaf, so keyframing the times across slides makes the sampled frames scrub as the
 * slide tweens — with no autoplay clock anywhere.
 */

import { defaults, props } from "./properties.js";
import { visibleIndices } from "./lists.js";

/**
 * The shared property KEYS, in Inspector order: the asset, then the window it is
 * sampled over, then the frames themselves, then what happens past the clip's end.
 * The window comes before the list because it is what the list's default equations
 * READ — the reading order matches the causal one.
 *
 * @example VIDEO_SAMPLING_KEYS // ["src", "videoStart", "videoEnd", "frames", "scrubWrap"]
 */
export const VIDEO_SAMPLING_KEYS = ["src", "videoStart", "videoEnd", "frames", "scrubWrap"];

/**
 * THE VIDEO NARROWING OF `src`, as ONE object. `PROPS.src` declares IMAGE assets
 * (the image widget is its oldest consumer), so every video widget has to narrow it
 * — and `assetKinds` is a CONTRACT aspect, so two widgets that narrow it differently
 * stop being the same row for retype and for joint editing. This constant is the one
 * place the narrowing is written; `videoSrcRow` and VIDEO_SAMPLING_ROWS both read it.
 *
 * Module-private on purpose: a consumer wants a ROW, not an override fragment, and
 * exporting both spellings would be two ways to say one thing.
 */
const VIDEO_SRC_NARROWING = { label: "Video", assetKinds: ["video"] };

/**
 * Pure function. THE `src` ROW NARROWED TO VIDEO ASSETS, on its own — for a widget
 * that takes a clip but does NOT sample a set of stills out of it, and therefore
 * cannot spread the all-or-nothing VIDEO_SAMPLING_ROWS block.
 *
 * It exists because the block is all-or-nothing and the narrowing is not: a plain
 * video PLAYER draws ONE frame at one time, so `videoStart`/`videoEnd`/`frames` would
 * be a category error in it, while `src` is the identical row. Six video plugins
 * currently re-type the narrowing by hand. This is the same shape as
 * `preserveAspectRow` below — a shared CONTRACT with a per-widget presentational
 * argument — which is the precedent it is deliberately copied from.
 *
 * The `label` is a parameter because it is PRESENTATIONAL and the existing widgets
 * genuinely disagree about it (this module says "Video", plugins/video.js:134 leaves
 * PROPS.src's "Source"); core/multiselect.js PRESENTATIONAL_ROW_ASPECTS ignores it,
 * so both spellings are still THE SAME ROW for retype.
 *
 * @param {string} [label] - this widget's own label for the row
 * @returns {object} one resolved inspector row
 *
 * @example videoSrcRow().key // "src"
 * @example videoSrcRow().assetKinds // ["video"]
 * @example videoSrcRow().label // "Video"
 * @example videoSrcRow("Source").label // "Source"
 * @example videoSrcRow("Source").assetKinds // ["video"] (the narrowing is not the caller's to change)
 */
export function videoSrcRow(label = VIDEO_SRC_NARROWING.label) {
  return props("src", { src: { ...VIDEO_SRC_NARROWING, label } })[0];
}

/**
 * THE SHARED INSPECTOR ROWS — resolved once, spread by every widget that samples
 * frames out of a clip.
 *
 * These row OBJECTS are shared by reference across the consuming plugins, which is
 * deliberate and is the `GRADIENT_STOPS_LIST` / `RAMP_STOP_ELEMENT` precedent in
 * core/properties.js: nothing mutates a resolved row, and one identity is the
 * strongest possible statement that these are the same rows.
 *
 * @example VIDEO_SAMPLING_ROWS.map((r) => r.key) // ["src", "videoStart", "videoEnd", "frames", "scrubWrap"]
 * @example VIDEO_SAMPLING_ROWS[0].assetKinds // ["video"]
 * @example VIDEO_SAMPLING_ROWS[0].label // "Video"
 */
export const VIDEO_SAMPLING_ROWS = props(...VIDEO_SAMPLING_KEYS, { src: VIDEO_SRC_NARROWING });

/**
 * Pure function. THE `preserveAspect` ROW, with this widget's own help sentence.
 *
 * It is a function rather than a member of VIDEO_SAMPLING_ROWS for two
 * presentational reasons, neither of which touches the contract (core/multiselect.js
 * PRESENTATIONAL_ROW_ASPECTS: label, help and category are ignored by the identity
 * relation, so both widgets still declare THE SAME ROW and a retype still carries
 * the value):
 *   - the HELP names the container the frame is fitted into, which is a film "cell"
 *     in one widget and a stacked "card" in the other, and
 *   - the two widgets file it in different places in their own row order.
 *
 * @param {string} help - the widget's own (?) sentence for the row
 * @returns {object} an inspector row
 *
 * @example preserveAspectRow("Fit each frame in its cell.").key // "preserveAspect"
 * @example preserveAspectRow("Fit each frame in its cell.").kind // "boolean"
 * @example preserveAspectRow("Fit each frame in its cell.").help // "Fit each frame in its cell."
 */
export function preserveAspectRow(help) {
  return { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help };
}

/**
 * Pure function. The default `time` EQUATION for element `i` of an `n`-frame list:
 * the point i/n of the way across the `videoStart` → `videoEnd` span (see the module
 * header for why i/n). Display (snake_case) property spellings, which is what the
 * equation grammar reads (core/expressions.js pathToStored maps them back to
 * videoStart/videoEnd).
 *
 * @example frameTimeEquation(0, 6) // "self.video_start"
 * @example frameTimeEquation(1, 4) // "self.video_start + 1 / 4 * (self.video_end - self.video_start)"
 * @example frameTimeEquation(0, 1) // "self.video_start"
 */
export function frameTimeEquation(i, n) {
  if (i === 0) return "self.video_start";
  return `self.video_start + ${i} / ${n} * (self.video_end - self.video_start)`;
}

/**
 * Pure function. The DEFAULT frame list for an `n`-frame sample: one TUPLE element
 * per frame holding that frame's default time EQUATION. This is the value a plugin
 * default carries, the value the filmstrip's respace command rewrites, and the
 * builder core/document.js's legacy frames-as-a-COUNT migration is handed through
 * the registry.
 *
 * @example defaultFrameList(1) // [["self.video_start"]]
 * @example defaultFrameList(2) // [["self.video_start"], ["self.video_start + 1 / 2 * (self.video_end - self.video_start)"]]
 * @example defaultFrameList(6).length // 6
 */
export function defaultFrameList(n) {
  const count = Math.max(1, Math.round(n));
  return Array.from({ length: count }, (_, i) => [frameTimeEquation(i, count)]);
}

/**
 * Pure function. THE SHARED DEFAULTS FRAGMENT for a widget sampling `frameCount`
 * frames: every key VIDEO_SAMPLING_ROWS declares, plus `preserveAspect`.
 *
 * `src` is EMPTY, which is both what makes a fresh widget a ghost and what the
 * two-step creation gesture's empty-source guard reads (web/widget_handlers.js
 * bbox_then_asset). `videoEnd` defaults to 0 — an honest "the clip length has not
 * been supplied", since a real duration is only knowable at browser DECODE time and
 * is therefore not derivable from pure document state; both widgets SAY so rather
 * than inventing a length (spanIsEmpty).
 *
 * @param {number} frameCount - how many frames this widget starts with
 * @returns {object} a defaults fragment to spread into a plugin's `defaults`
 *
 * @example videoSamplingDefaults(1) // {src: "", frames: [["self.video_start"]], preserveAspect: true, videoStart: 0, videoEnd: 0, scrubWrap: "clamp"}
 * @example videoSamplingDefaults(6).frames.length // 6
 * @example videoSamplingDefaults(6).videoEnd // 0
 */
export function videoSamplingDefaults(frameCount) {
  return {
    src: "",
    frames: defaultFrameList(frameCount),
    // Letterbox each frame inside whatever container the widget gives it, instead of
    // squashing it to that container's shape. ON by default — the latex/svg/mermaid/
    // cursor default, and what the Python originals both do (`resize_images_to_hold`).
    preserveAspect: true,
    ...defaults(...VIDEO_SAMPLING_KEYS),
  };
}

/**
 * Pure function. The VISIBLE frames of a sampling widget's state, as {index, time}
 * pairs — `index` the STORED element index (what a per-frame anchor id is keyed on,
 * so hiding a frame rebinds nothing), `time` the evaluated seconds (equations are
 * already numbers by the time emit/anchors see state; a non-number reads as 0 rather
 * than throwing, since a half-typed equation must not crash the paint).
 *
 * Hidden elements are simply ABSENT — core/lists.js's "acts like it's not there"
 * rule, read through visibleIndices so neither widget holds a second copy of the
 * absent-means-visible convention.
 *
 * @example visibleFrames({frames: [[0], [1.5]]}) // [{index: 0, time: 0}, {index: 1, time: 1.5}]
 * @example visibleFrames({frames: [[0], [1], [2]], framesActive: [true, false, true]}) // [{index: 0, time: 0}, {index: 2, time: 2}]
 * @example visibleFrames({frames: [["self.video_start"]]}) // [{index: 0, time: 0}] (an unevaluated equation reads as 0)
 * @example visibleFrames({}) // []
 */
export function visibleFrames(state) {
  const list = Array.isArray(state.frames) ? state.frames : [];
  return visibleIndices({ list, active: state.framesActive }).map((index) => {
    const time = list[index]?.[0];
    return { index, time: Number.isFinite(time) ? time : 0 };
  });
}

/**
 * Pure function. Is the sampled span EMPTY — i.e. has the clip length not been
 * supplied? Then every default frame time collapses onto `videoStart` and the widget
 * shows N copies of one frame, which its emit() REPORTS rather than letting pass
 * silently (the no-silent-fallback rule; the real duration is not derivable from
 * pure state).
 *
 * @example spanIsEmpty({videoStart: 0, videoEnd: 0}) // true
 * @example spanIsEmpty({videoStart: 0, videoEnd: 3}) // false
 * @example spanIsEmpty({videoStart: 5, videoEnd: 2}) // true (an inverted span samples nothing)
 * @example spanIsEmpty({}) // true
 */
export function spanIsEmpty(state) {
  return !((state.videoEnd ?? 0) > (state.videoStart ?? 0));
}

/**
 * Pure function. The sentence a widget REPORTS when its sampled span is empty.
 * Single-sourced so the filmstrip and the image stack do not grow two voices for one
 * condition — the `connectivity.offlineMessage` precedent (one condition, one
 * wording). The `{key, message}` pair is exactly what core/report.js reportOnce
 * takes; the key omits the widget's live values so a drag reports once, not once per
 * frame.
 *
 * @param {string} widget - the widget's human title, for the message
 * @param {object} state - the widget's folded state (reads videoStart/videoEnd)
 * @returns {{key: string, message: string}}
 *
 * @example emptySpanReport("Image Stack", {videoStart: 0, videoEnd: 0}).key // "PowerRP Image Stack: the sampled span is empty (Video end is not set)"
 * @example emptySpanReport("Filmstrip", {videoStart: 0, videoEnd: 0}).message.startsWith("PowerRP Filmstrip:") // true
 */
export function emptySpanReport(widget, state) {
  return {
    key: `PowerRP ${widget}: the sampled span is empty (Video end is not set)`,
    message:
      `PowerRP ${widget}: "Video end (s)" is ${state.videoEnd ?? 0} and "Video start (s)" is ${state.videoStart ?? 0}, so the sampled span is ` +
      "EMPTY and every frame's default equation collapses onto the start — every sampled frame is the SAME frame. " +
      "Set Video end (s) to the clip's length (it is only knowable once the video decodes, so it is a value you supply).",
  };
}

/**
 * Pure function. Whether `src` is a real playable VIDEO source, as opposed to the
 * blank-placeholder IMAGE data URI a freshly-added video widget carries as its
 * default. A `data:image/…` URI decodes as an image and never as a video, so an
 * overlay must NOT hand one to a `<video>` element: the element fires `error`
 * with MediaError code 4 ("Format error"), which every video registry here
 * reports loudly — so an untouched widget, straight off the insert menu with its
 * own defaults, printed a console error about a corrupt clip the author never
 * chose. Such a widget shows only its Skia poster until a real clip is set.
 *
 * THIS LIVES IN core/ BECAUSE TWO OVERLAYS NEED IT AND ONE MAY NOT IMPORT THE
 * OTHER. It was written for video_v7's placement module, and video_v6's overlay
 * carried the WEAKER half of the same test — `typeof src === "string" &&
 * src.length > 0`, missing the data-URI clause — which is exactly the defect
 * above. A hand-maintained second copy of another module's predicate is this
 * codebase's worst recurring defect (see this file's header); there is one.
 *
 * @param {*} src candidate source
 * @returns {boolean}
 * @example isPlayableVideoSrc("clip.mp4") // true
 * @example isPlayableVideoSrc("/asset/Demo/pan.mp4") // true
 * @example isPlayableVideoSrc("") // false
 * @example isPlayableVideoSrc(null) // false
 * @example isPlayableVideoSrc("data:image/png;base64,iVBORw0KGgo=") // false
 */
export function isPlayableVideoSrc(src) {
  return typeof src === "string" && src.length > 0 && !src.startsWith("data:image/");
}
