/**
 * IMAGE STACK widget — N frames sampled out of one video, PILED UP and receding:
 * the first frame square on top at full strength, each later frame stepped down and
 * across behind it, fading as it goes, every card rounded and casting its own soft
 * drop shadow. A faithful reproduction of the user's own Figures library entry
 * (refs/Figures/image_stack/image_stack.py — `create_image_stack`).
 *
 * ── THE REFERENCE ALGORITHM, and what each line becomes here ──────────────────
 * The Python builds ONE composited raster, bottom-up:
 *
 *     video  = resize_list(video, num_frames)               # N frames, evenly
 *     video  = resize_images_to_hold(video, frame_size, frame_size)   # letterbox
 *     video  = with_corner_radii(video, radius=corner_radius)
 *     video  = with_drop_shadows(video, x=y=shadow_shift, blur=shadow_blur,
 *                                color=shadow_color, opacity=shadow_opacity)
 *     video  = [shift_image(f, i*total_shift_x/N, i*total_shift_y/N) …]
 *     alphas = linspace(0, 1, N, endpoint=False) ** alphas_exponent
 *     for frame, alpha in zip(video[::-1], alphas):         # LAST frame first
 *         image = image_with_alpha(image * alpha)           # fade what's there
 *         image = blend(image, frame)                       # then draw over it
 *
 * The PowerRP translation is one display list, drawn BACK TO FRONT, and it is
 * equivalent rather than merely similar:
 *   · the N frames are the shared FRAME LIST (core/video_sampling.js) — one
 *     `videoV5Frame` op per card at that card's own time, which is exactly what
 *     `resize_list` samples;
 *   · `with_corner_radii` is a per-card `decorateStrokedBox` rounded clip;
 *   · `with_drop_shadows` is a blurred rounded-rect `path` UNDER each card;
 *   · `shift_image` + `crop_images_to_max_size` is `stackLayout`, which solves the
 *     card size from the widget's box instead of growing the box from the cards;
 *   · the REPEATED FADE of the accumulated image is `stackAlphas`, which closes the
 *     loop's cumulative product into one per-card opacity (see there for the
 *     algebra). Multiplying a card's alpha once is the same picture as fading it
 *     once per later card, and it is what lets the display list be flat.
 *
 * TWO LINES DO NOT TRANSLATE, and pretending otherwise would be the wrong kind of
 * faithfulness — this docblock said one of them wrongly until it was measured:
 *   · `resize_images_to_hold(frame_size, frame_size)` scales each frame so the square
 *     FITS INSIDE it (rp's "hold", the opposite of "fit"), keeping the frame's own
 *     aspect — so a reference card of a 4:3 clip is 341x256, not a square. A widget
 *     has a BOX and the card size is solved from it, so a card cannot take the clip's
 *     shape. `preserveAspect` letterboxes the frame inside the card instead, which
 *     equals the reference exactly when the box's aspect matches the clip's and
 *     honestly shows bars when it does not. Off stretches, which is neither.
 *   · `bordered_images_solid_color(color="transparent", thickness=30)` pads each frame
 *     so its drop shadow has room in a FIXED-SIZE array. A display list has no array
 *     to overflow; the shadow simply draws where it falls, and `localBounds` reports
 *     the reach so an export captures it. Hence the widget's box is the pile's INK
 *     (frames + shift), 30 px per side smaller than the reference's saved raster.
 *
 * ── THE SOURCE HALF IS SHARED WITH THE FILMSTRIP, BY REQUIREMENT ──────────────
 * `src`, `videoStart`, `videoEnd`, the `frames` list, `scrubWrap` and
 * `preserveAspect` are NOT declared here. They are ONE declaration in
 * core/video_sampling.js, spread by this widget and by plugins/filmstrip.js. The
 * user asked for exactly this, verbatim:
 *
 *   "very similar to filmstrip except slightly different — it should have the same
 *    properties to specify video as filmstrip, so that if I go from one element to
 *    the other, it's easy to fall between them."
 *
 * "Fall between them" is RETYPING, and a retype carries a value across only when
 * BOTH types declare the key and their rows agree on kind (core/retype.js
 * carryVerdict). So the requirement is a LOSSLESS ROUND TRIP — filmstrip →
 * image_stack → filmstrip returns the source untouched — which is proven, not
 * asserted, by tests/video_sampling_test.js. A hand-copied second declaration would
 * pass on the day it was written and break silently the first time either side moved
 * a contract aspect; that is why there is one.
 *
 * ── EVERY LENGTH IS A FRACTION, SO THE LOOK SURVIVES A RESIZE ─────────────────
 * The reference's numbers are absolute pixels against a 256 px frame. A widget is
 * resized, so each of them is stored here as a FRACTION of the thing it belongs to
 * (`shiftX`/`shiftY` of the widget's own width/height; `cardRadius`, `shadowShift`
 * and `shadowBlur` of the CARD's width), and REFERENCE below records the pixel
 * numbers the fractions are derived from. This is the filmstrip's STRIP_LOOK
 * convention and paper_peacock's shadow convention, not a new one.
 *
 * ── OFFLINE / NO-SOURCE BEHAVIOUR (the no-silent-fallback rule) ───────────────
 * With no `src` the widget is a GHOST (the dashed-outline placeholder) and emits
 * nothing, the same symmetry tests/ghost_test.js polices for the filmstrip. With a
 * src but an EMPTY SPAN (videoEnd <= videoStart) every card shows the same frame; it
 * draws the real stack and REPORTS once, in the same sentence the filmstrip uses
 * (core/video_sampling.emptySpanReport — one condition, one voice). A shift so large
 * that no card is left is reported too. Nothing is ever painted onto the artwork to
 * say so: an editor-time warning scrawled across a widget ships in the export.
 *
 * ── THE THREE KINDS OF STATE ──────────────────────────────────────────────────
 * Property state only. Every card's time is a keyframable, equation-bindable leaf, so
 * keyframing them makes the whole pile scrub as the slide tweens — no clock, no
 * randomness, no carry from the previous frame.
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — like the image widget and
 * the filmstrip, so it composites under magnifiers/blur and culls for free.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { reportOnce } from "../core/report.js";
import { rectPathD } from "../core/svg_paths.js";
import * as T from "../core/transform.js";
import {
  VIDEO_SAMPLING_ROWS, emptySpanReport, preserveAspectRow, spanIsEmpty,
  videoSamplingDefaults, visibleFrames,
} from "../core/video_sampling.js";
import { path, videoV5Frame, BLUR_SUPPORT_SIGMAS } from "../render_gpu/ir.js";
import { decorateStrokedBox } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/**
 * THE REFERENCE FIGURE'S OWN DEFAULTS, in its own pixels — the signature of
 * `create_image_stack` in refs/Figures/image_stack/image_stack.py. Every default
 * below is DERIVED from these rather than retyped as a decimal, so the derivation is
 * checkable against the source it came from.
 *
 * @example REFERENCE.frames // 10
 * @example REFERENCE.totalShift // 200
 */
export const REFERENCE = {
  frames: 10,        // num_frames=10
  frameSize: 256,    // frame_size=256 (each frame is letterboxed into a square)
  totalShift: 200,   // total_shift=200, applied to BOTH axes
  cornerRadius: 10,  // corner_radius=10
  shadowShift: 10,   // shadow_shift=10, applied to BOTH axes
  shadowBlur: 30,    // shadow_blur=30
  shadowOpacity: 0.25,
  alphaExponent: 0.5,
};

/**
 * The reference pile's INK extent in its own pixels, for a SQUARE source: the frame
 * plus the run the other N-1 frames step across it. This is the denominator every
 * fraction below is taken against, and it is the widget's default box.
 *
 * It is NOT the reference's saved raster size, which is 30 px per side larger (the
 * transparent border it pads each frame with so the drop shadows have somewhere to
 * land — measured: a 320x240 clip comes out 582x496). A display list has no array to
 * overflow, so the box is the ink and `localBounds` carries the shadow reach.
 *
 * @example REFERENCE_SIDE // 436
 */
export const REFERENCE_SIDE =
  REFERENCE.frameSize + ((REFERENCE.frames - 1) * REFERENCE.totalShift) / REFERENCE.frames;

/** How many frames a freshly placed stack samples — the reference's ten. Every count
 *  after that is the user's, through the frame list's own insert/purge affordances. */
export const DEFAULT_FRAME_COUNT = REFERENCE.frames;

/** The total step across the box, as a FRACTION of the box's own width/height. At
 *  the reference's numbers this leaves each card exactly `frameSize` on a side. */
export const DEFAULT_SHIFT_FRACTION = REFERENCE.totalShift / REFERENCE_SIDE;

/** A card's corner radius, as a fraction of the card's SHORT side. */
export const DEFAULT_CARD_RADIUS_FRACTION = REFERENCE.cornerRadius / REFERENCE.frameSize;

/** A card shadow's offset (both axes) and blur, as fractions of the CARD's width —
 *  the paper_peacock convention, so a shadow keeps its proportions under a resize. */
export const DEFAULT_SHADOW_SHIFT_FRACTION = REFERENCE.shadowShift / REFERENCE.frameSize;
export const DEFAULT_SHADOW_BLUR_FRACTION = REFERENCE.shadowBlur / REFERENCE.frameSize;

/**
 * Pure function. THE FADE LADDER: each card's opacity multiplier, index 0 = the TOP
 * card. Closed form of the reference loop's cumulative fade.
 *
 * The Python fades the WHOLE accumulated image by a_m = (m/N)^e at step m and then
 * draws the next card over it, iterating the cards back-to-front. A card composited
 * at step k is therefore faded by every a_m after it, so with j = N-1-k counting from
 * the top,
 *
 *              N-1
 *     alpha  =  ∏  (m/N)^e ,      alpha_0 = 1  (an empty product)
 *          j   m=N-j
 *
 * which this evaluates as the running product alpha_j = alpha_{j-1} · ((N-j)/N)^e.
 * The top card is therefore always fully opaque and the deepest is the faintest,
 * with `exponent` controlling how fast the pile disappears: a HIGHER exponent is a
 * sharper drop-off (fewer cards readable), a LOWER one keeps more of them visible.
 *
 * @param {number} n - how many cards
 * @param {number} exponent - the reference's `alphas_exponent`
 * @returns {number[]} one multiplier per card, top first, alphas[0] === 1
 *
 * @example stackAlphas(1, 0.5) // [1]
 * @example stackAlphas(2, 1) // [1, 0.5]
 * @example stackAlphas(3, 1) // [1, 0.6666666666666666, 0.2222222222222222]
 * @example stackAlphas(4, 0) // [1, 1, 1, 1] (exponent 0 disables the fade entirely)
 * @example stackAlphas(10, 0.5)[9] < stackAlphas(10, 0.25)[9] // true (a higher exponent hides the pile faster)
 */
export function stackAlphas(n, exponent) {
  const count = Math.max(0, Math.round(n));
  const e = Number.isFinite(exponent) ? exponent : REFERENCE.alphaExponent;
  const out = [];
  let acc = 1;
  for (let j = 0; j < count; j++) {
    if (j > 0) acc *= Math.pow((count - j) / count, e);
    out.push(acc);
  }
  return out;
}

/**
 * Pure function. THE PILE'S LAYOUT in local (bbox) space: one card rect per frame,
 * index 0 = the TOP card. The widget's box is the pile's BOUNDING BOX, so the card
 * size is SOLVED from it rather than the box grown from the cards (the reference's
 * `crop_images_to_max_size`, run backwards).
 *
 * With n cards stepping by `step = shift·w/n` each (`shift` a fraction of the box),
 * the run the pile covers is `span = (n-1)·step`, so a card measures `w - |span|` and
 * card j sits at `j·step`, shifted by `-min(0, span)` so a NEGATIVE shift — a pile
 * receding up and to the left — still starts inside the box. Both axes independently.
 *
 * Degenerates correctly: n = 1 gives one card filling the box, and shift 0 gives n
 * coincident full-box cards (a pile seen exactly end-on, which is a legitimate look).
 * A shift big enough to leave no card returns cards of NON-POSITIVE size — emit()
 * detects that and REPORTS it rather than clamping something into view.
 *
 * @param {number} n - card count (>= 1)
 * @param {number} w - the widget's local width
 * @param {number} h - the widget's local height
 * @param {number} shiftX - total step across the box, as a fraction of w
 * @param {number} shiftY - total step down the box, as a fraction of h
 * @returns {Array<{x: number, y: number, w: number, h: number}>} top card first
 *
 * @example stackLayout(1, 100, 80, 0.5, 0.5) // [{x: 0, y: 0, w: 100, h: 80}]
 * @example stackLayout(2, 100, 100, 0.5, 0) // [{x: 0, y: 0, w: 75, h: 100}, {x: 25, y: 0, w: 75, h: 100}]
 * @example // the reference's own numbers: ten 256-px cards stepping 20 px across a 436-px box
 * @example stackLayout(10, 436, 436, 200 / 436, 200 / 436)[0] // {x: 0, y: 0, w: 256, h: 256}
 * @example stackLayout(10, 436, 436, 200 / 436, 200 / 436)[9] // {x: 180, y: 180, w: 256, h: 256}
 * @example // a NEGATIVE shift recedes up-and-left and still starts inside the box:
 * @example stackLayout(2, 100, 100, -0.5, 0)[1] // {x: 0, y: 0, w: 75, h: 100}
 */
export function stackLayout(n, w, h, shiftX, shiftY) {
  const count = Math.max(1, Math.round(n));
  const axis = (extent, shift) => {
    const step = ((shift ?? 0) * extent) / count;
    const span = (count - 1) * step;
    return { step, size: extent - Math.abs(span), origin: -Math.min(0, span) };
  };
  const ax = axis(w ?? 0, shiftX);
  const ay = axis(h ?? 0, shiftY);
  return Array.from({ length: count }, (_, j) => ({
    x: ax.origin + j * ax.step,
    y: ay.origin + j * ay.step,
    w: ax.size,
    h: ay.size,
  }));
}

/**
 * Pure function. How far a card's DROP SHADOW reaches beyond that card, in local
 * units: the offset plus the Gaussian's own support bound (render_gpu/ir.js
 * BLUR_SUPPORT_SIGMAS — the same 3σ the effects halo uses, so the two agree about
 * where a blur stops). Both `shift` and `blur` are fractions of the card's width, as
 * the Inspector rows declare them.
 *
 * This is what makes the widget's `localBounds` bigger than its box: a card's shadow
 * is INK the widget draws, not an effects-bundle halo, so it belongs to the BOUNDS
 * protocol (which the export capture rect reads) and not to `cullMargin`.
 *
 * @param {number} cardW - the card's width in local units
 * @param {number} shift - shadow offset, as a fraction of cardW
 * @param {number} blur - shadow blur radius, as a fraction of cardW
 * @returns {number} the outward reach, in local units (>= 0)
 *
 * @example shadowReach(256, 0, 0) // 0
 * @example shadowReach(100, 0.1, 0) // 10 (offset alone)
 * @example shadowReach(100, 0, 0.1) // 30 (3 sigma of a 10-unit blur)
 * @example shadowReach(-256, 0.5, 0) // 128 (a reflected card reaches just as far)
 */
export function shadowReach(cardW, shift, blur) {
  const span = Math.abs(cardW ?? 0);
  return Math.abs(shift ?? 0) * span + Math.abs(blur ?? 0) * span * BLUR_SUPPORT_SIGMAS;
}

export const imageStackPlugin = {
  type: "image_stack",
  title: "Image Stack",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // CREATION GESTURE (web/widget_handlers.js, phase "create"): drag a box, then
  // prompt for the video — a stack with no source has nothing to draw, so asking is
  // part of placing it. The filmstrip's gesture exactly, which is half of what makes
  // the two widgets feel like one another.
  placement: "bbox_then_asset",
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): re-open the
  // asset picker, like every other media widget. `primaryAsset` names WHICH property
  // the picker fills.
  activate: "asset_picker",
  primaryAsset: "src",
  /**
   * Pure function. Is this stack a GHOST (the dashed-outline placeholder)? Only when
   * it has NO SOURCE — with a source there is always a real pile of cards to draw,
   * and any remaining problem is REPORTED rather than hidden behind a ghost outline.
   *
   * @example imageStackPlugin.isGhost({ src: "" })
   * true
   * @example imageStackPlugin.isGhost({})
   * true
   * @example imageStackPlugin.isGhost({ src: "clip.mp4" })
   * false
   */
  isGhost(state) {
    return typeof state.src !== "string" || state.src.length === 0;
  },
  defaults: {
    type: "image_stack", x: 100, y: 100, z: 0, rotation: 0, scale: 1,
    // A SQUARE box at the reference composite's own side length, so a freshly placed
    // stack at 1:1 reproduces refs/Figures/image_stack pixel for pixel.
    w: REFERENCE_SIDE, h: REFERENCE_SIDE,
    // Rotation pivots about this WORLD point; default = own center (an equation).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // THE SHARED SOURCE HALF (core/video_sampling.js): the video asset URL, the
    // sampled window, the frame LIST with its per-element time equations, the
    // past-the-end wrap and preserveAspect — the SAME declaration the filmstrip
    // spreads, so retyping between the two carries all of it across.
    ...videoSamplingDefaults(DEFAULT_FRAME_COUNT),
    // THE PILE: how far it steps, how fast it fades, how the cards are cut.
    shiftX: DEFAULT_SHIFT_FRACTION,
    shiftY: DEFAULT_SHIFT_FRACTION,
    alphaExponent: REFERENCE.alphaExponent,
    cardRadius: DEFAULT_CARD_RADIUS_FRACTION,
    // EACH CARD'S OWN DROP SHADOW (the reference's with_drop_shadows).
    shadowShift: DEFAULT_SHADOW_SHIFT_FRACTION,
    shadowBlur: DEFAULT_SHADOW_BLUR_FRACTION,
    shadowColor: "#000000",
    shadowOpacity: REFERENCE.shadowOpacity,
    // stroke COLOR default matches every stroked shape; paints only once
    // strokeWidth > 0 (0 by default). The border/rounding here frames the WHOLE
    // pile — per-card rounding is `cardRadius`, above.
    stroke: "#808080",
    ...defaults("strokeWidth", "cornerRadius", "opacity"),
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("positioning"),
    // THE SHARED SOURCE ROWS (core/video_sampling.js VIDEO_SAMPLING_ROWS) — byte-for-
    // byte the filmstrip's, which is what makes a retype between them lossless.
    ...VIDEO_SAMPLING_ROWS,
    preserveAspectRow("Fit each frame inside its card without distorting it (centered, letterboxed). Turn off to stretch every frame to its card's exact shape, which squashes them when the stack is not square."),
    // THE PILE'S OWN rows, declared inline (the donut `inner` precedent: a property
    // only this widget has does not belong in the shared registry). The two shifts
    // and the exponent are fractions, so they declare a fine `scrub` — a row with no
    // upper bound has no span to scale a drag against and would fall back to 1/px.
    { key: "shiftX", label: "Shift X", kind: "number", scrub: 0.005, category: "formatting", help: "How far the pile steps sideways in total, as a fraction of the stack's width. The cards shrink to keep the whole pile inside the box, so 0 stacks them exactly on top of each other and larger values make each card smaller. Negative recedes to the LEFT." },
    { key: "shiftY", label: "Shift Y", kind: "number", scrub: 0.005, category: "formatting", help: "How far the pile steps downward in total, as a fraction of the stack's height. Negative recedes UPWARD." },
    { key: "alphaExponent", label: "Fade exponent", kind: "number", min: 0, scrub: 0.01, category: "formatting", help: "How fast the pile fades into the background. The front card is always solid; a HIGHER exponent drops the ones behind it off sharply (you see only a few), a LOWER one keeps more of them readable, and 0 turns the fade off so every card is solid." },
    { key: "cardRadius", label: "Card corners", kind: "number", min: 0, max: 0.5, scrub: 0.002, category: "formatting", help: "Each card's corner rounding, as a fraction of the card's short side — 0 is square, 0.5 is a full stadium." },
    { key: "shadowShift", label: "Card shadow offset", kind: "number", scrub: 0.002, category: "formatting", help: "How far each card's own drop shadow is offset down and to the right, as a fraction of the card's width. Negative throws it up and to the left." },
    { key: "shadowBlur", label: "Card shadow blur", kind: "number", min: 0, scrub: 0.002, category: "formatting", help: "Each card's drop-shadow softness, as a fraction of the card's width. 0 gives a hard-edged offset silhouette." },
    { key: "shadowColor", label: "Card shadow color", kind: "color", category: "formatting", help: "The colour each card's drop shadow is cast in. Black is the reference look; a tinted shadow reads as coloured bounce light." },
    { key: "shadowOpacity", label: "Card shadow opacity", kind: "number", min: 0, max: 1, scrub: 0.01, category: "formatting", help: "How dark each card's drop shadow is, 0 (none) to 1 (solid). It is multiplied by that card's own place in the fade, so shadows recede with the pile." },
    // The stroked-BORDER bundle frames the WHOLE pile (all cards together).
    ...bundle("strokedBorder"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (console.errors ONCE per unique message via core/report.js
   * reportOnce — the plugins/donut.js and plugins/filmstrip.js contract; otherwise
   * pure). State → display-list commands in local space: for each card from the BACK
   * forward, its blurred rounded-rect drop shadow and then the card itself — one
   * `videoV5Frame` op at that frame's time, inside its own rounded clip — then the
   * whole-pile border/rounding + effects.
   *
   * TWO CONDITIONS ARE REPORTED AND NOTHING IS PAINTED TO SAY SO: an EMPTY SPAN
   * (every card is the same frame) and a shift so large that no card is left. Both go
   * to the console channel and to the Inspector rows that fix them, never onto the
   * artwork — a warning scrawled across the widget ships in the export.
   *
   * THE CARD CONTENT CARRIES THE STACK'S OWN `world`, which is not optional:
   * decorateStrokedBox wraps its content in pushTransform(world) because a
   * cropSubtree's `content` is flattened INDEPENDENTLY from identity by every backend
   * (render_gpu/decorate.js's absolute-world contract). Passing identity would leave
   * every card's picture at world (0,0) while the shadows moved with the widget —
   * the exact bug tests/filmstrip_test.js pins for the strip.
   */
  emit(s, _targetWorldIR, world) {
    // NO SOURCE → draw NOTHING. The ghost's dashed placeholder is the only thing
    // that should show (tests/ghost_test.js polices this symmetry).
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const opacity = s.opacity ?? 1;
    const frames = visibleFrames(s);
    if (frames.length === 0) return [];
    const cards = stackLayout(frames.length, s.w ?? 0, s.h ?? 0, s.shiftX, s.shiftY);
    const alphas = stackAlphas(frames.length, s.alphaExponent);
    const content = [];
    // A SHIFT LARGER THAN THE BOX leaves no card to draw. Refusing to invent one is
    // the no-silent-fallback rule; the affordance is the Shift X / Shift Y rows the
    // message names. The key omits the live size so a resize drag reports once.
    if (!(cards[0].w > 0 && cards[0].h > 0)) {
      reportOnce(
        `PowerRP ${imageStackPlugin.title}: the shift leaves no card to draw`,
        `PowerRP ${imageStackPlugin.title}: at ${frames.length} frames a shift of (${s.shiftX ?? 0}, ${s.shiftY ?? 0}) steps the pile ` +
        `${Math.abs(((frames.length - 1) * (s.shiftX ?? 0)) / frames.length).toFixed(3)} x ` +
        `${Math.abs(((frames.length - 1) * (s.shiftY ?? 0)) / frames.length).toFixed(3)} of the box across itself, which is the whole box or more — ` +
        "so every card measures zero and NOTHING is drawn. Lower Shift X / Shift Y (they are fractions of the box, and the cards shrink to keep the " +
        "pile inside it), or use fewer frames.",
      );
      return [];
    }
    // EMPTY SPAN: every card samples the same instant. Reported in the SAME sentence
    // the filmstrip uses (core/video_sampling.emptySpanReport) — one condition, one
    // voice — and never painted onto the artwork.
    if (spanIsEmpty(s)) {
      const notice = emptySpanReport(imageStackPlugin.title, s);
      reportOnce(notice.key, notice.message);
    }
    const radius = Math.min(cards[0].w, cards[0].h) * Math.max(0, s.cardRadius ?? 0);
    const shadowBlur = Math.abs(s.shadowBlur ?? 0) * cards[0].w;
    const shadowOffset = (s.shadowShift ?? 0) * cards[0].w;
    const shadowOpacity = Math.max(0, s.shadowOpacity ?? 0);
    // BACK TO FRONT — the reference composites the LAST frame first and draws frame 0
    // over everything, so the pile reads as receding into the page.
    for (let j = frames.length - 1; j >= 0; j--) {
      const c = cards[j];
      const alpha = alphas[j] * opacity;
      // The card's OWN drop shadow, under the card. A blurred `path`, the same soft
      // cast shadow plugins/paper_peacock.js gives each of its sheets — and, like
      // that one, honoured by the Skia painter and dropped by the vector exporters
      // (`path.blur`, ledger C-17 / todo #219: an SVG or PDF export of this widget
      // has hard-edged card shadows).
      if (shadowOpacity > 0 && (shadowBlur > 0 || shadowOffset !== 0))
        content.push(path({
          d: rectPathD(c.x + shadowOffset, c.y + shadowOffset, c.w, c.h, radius, radius),
          fill: s.shadowColor ?? "#000000",
          opacity: alpha * shadowOpacity,
          blur: shadowBlur,
        }));
      // The card itself: the frame at its own time, letterboxed by the painter if
      // preserveAspect is on, inside its own rounded clip.
      const frame = videoV5Frame({
        ref: s.src, x: c.x, y: c.y, w: c.w, h: c.h, opacity: alpha,
        seekTime: frames[j].time, wrap: s.scrubWrap ?? "clamp",
        preserveAspect: s.preserveAspect !== false,
      });
      for (const op of decorateStrokedBox([frame], { x: c.x, y: c.y, w: c.w, h: c.h, cornerRadius: radius }, world))
        content.push(op);
    }
    const style = {
      w: s.w ?? 0, h: s.h ?? 0, stroke: s.stroke,
      strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0,
    };
    return applyEffects(decorateStrokedBox(content, style, world), s, world, { x: 0, y: 0, w: style.w, h: style.h });
  },
  /**
   * Pure function. BOUNDS protocol (core/registry.js): the cards fill the box exactly
   * by construction (stackLayout solves their size from it), but each card's DROP
   * SHADOW is ink drawn OUTSIDE that box — so the ink rect is the box inflated by the
   * shadow's reach. Getting this wrong clips the shadows out of an export and culls
   * the widget one shadow-width too early.
   *
   * The inflation is symmetric rather than one-sided, because the offset may be
   * negative and because the blur reaches every way regardless.
   *
   * @example imageStackPlugin.localBounds({w: 100, h: 100, shadowOpacity: 0}) // {x: 0, y: 0, w: 100, h: 100}
   * @example imageStackPlugin.localBounds({w: 100, h: 100, frames: [[0], [1]], shiftX: 0, shiftY: 0, shadowOpacity: 0.25, shadowShift: 0.1, shadowBlur: 0}) // {x: -10, y: -10, w: 120, h: 120}
   */
  localBounds(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (!((s.shadowOpacity ?? 0) > 0)) return { x: 0, y: 0, w, h };
    const frames = visibleFrames(s);
    const cards = stackLayout(Math.max(1, frames.length), w, h, s.shiftX, s.shiftY);
    const reach = shadowReach(cards[0].w, s.shadowShift, s.shadowBlur);
    return { x: -reach, y: -reach, w: w + 2 * reach, h: h + 2 * reach };
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    // CROSSHAIR PLACEMENT (like every Add button): arm placement; the finished
    // gesture runs this widget's declared `placement` handler above, which creates it
    // and opens the video picker.
    { id: "add-image-stack", title: "Add Image Stack", icon: "mdi:image-multiple", run: (app) => app.armCrosshairPlacement(imageStackPlugin) },
  ],
};
