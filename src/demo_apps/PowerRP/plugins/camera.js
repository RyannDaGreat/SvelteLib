/**
 * THE camera — a bounding box that determines every rendered view: export
 * aspect ratio, per-slide thumbnails, and the presentation viewport (the view
 * fits the camera's bbox, letterboxing the rest). One per document, created
 * with the document, tweened between slides like any other item.
 *
 * Renders NOTHING anywhere (emit() below — user ruling: its own border
 * doubled up with the selection outline). In the editor it is discovered by
 * border hit-testing + the item picker, and selecting it shows the standard
 * selection outline; exports, presentations, thumbnails, and CLI renders
 * never see it.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { defaultCameraState, CAMERA_NATURAL_ZOOM_KEY, CAMERA_NATURAL_ZOOM_DEFAULT } from "../core/document.js";
import { props, bundle, bundleDefaults } from "../core/properties.js";
import { borderBandHit } from "../core/geometry.js";
import { expLerp, expTweenApplies } from "../core/interp_modes.js";


// ── NATURAL ZOOM: THE COUPLING'S OWN SWITCH (WORKSTREAM BI) ───────────────────
//
// User ruling, 2026-08-02 night, verbatim, answering BG's flagged judgment call:
// "It is important that we follow the Mandelbrot zoom pan type, but it has to be
// smoothly carried over into the interface, however it works. If we have to make
// a tool for it to make sure that several settings are set simultaneously, so be
// it, by default it will be on for camera."
//
// BG shipped the coupling as a hook with no control and no mention: the four
// per-axis dropdowns said "Exp Tween" and interpolateCameraState quietly rendered
// something else. This is the switch that makes it a stated setting.
//
// ── WHAT ACTUALLY LIED, MEASURED BEFORE ANYTHING WAS DESIGNED ────────────────
// The obvious reading is "all four dropdowns misrepresent the coupling", and it
// is WRONG. Rendered against the coupling for w 1280 → 4 onto a point 9000 out:
//
//     alpha           0     0.1     0.25      0.5     0.75     0.9      1
//     coupled w  1280.00  718.94   302.64    71.55    16.92    7.12   4.00
//     Exp Tween w 1280.00 718.94   302.64    71.55    16.92    7.12   4.00   ← SAME
//     coupled x      0.0  3957.3   6893.6   8523.5   8908.9  8978.0   9000
//     Exp Tween x    0.0   900.0   2250.0   4500.0   6750.0  8100.0   9000   ← NOT
//
//   • `w` IS EXACTLY WHAT ITS DROPDOWN CLAIMS, at every alpha, always — the
//     coupling's width term literally IS `expLerp(from.w, to.w, alpha)` (line
//     ~"const w = expLerp" below). Swept at 0.005 steps over proportional and
//     non-proportional pairs alike: max |Δ| = 0. The w dropdown has never lied.
//   • `h` matches too WHENEVER THE ASPECT IS PRESERVED (max |Δ| = 0), and
//     diverges only when the aspect CHANGES — up to 24.7% mid-tween on a
//     1280×720 → 4×400 pair, 14.0% on a milder one — because `h` deliberately
//     rides `w`'s lam so the frame is one motion instead of two (see
//     interpolateCameraState). So `h` is honest for the ordinary camera, whose
//     aspect is the export aspect and does not change, and approximate exactly
//     when the author is doing something the coupling explicitly reshapes.
//   • `x`/`y` ARE THE LIARS, and by a wide margin: 3957 where the dropdown
//     promises 900. They are the leaves the coupling REPLACES outright.
//
// THAT MEASUREMENT IS THE WHOLE DESIGN. "Hide the four dropdowns while coupled"
// would have suppressed two controls that were telling the truth, and would have
// needed a state-aware interp gutter in web/Inspector.svelte — which is another
// wave's file. Instead the switch says what it governs, and the two rows it
// actually overrides say so in their own help text, which is a row aspect a
// plugin declares. No component change at all.
//
// ── WHY IT IS ONE SWITCH AND NOT FOUR DROPDOWNS ──────────────────────────────
// The ruling authorizes "a tool… to make sure that several settings are set
// simultaneously". The coupling is not expressible as four independent per-axis
// laws — that is the finding BG measured and this file's section header records
// (c(a) = A + B·10^(-z(a)) needs BOTH endpoint states jointly, so no per-leaf
// mode can be it). A control that IS the coupling therefore cannot be a fifth
// entry in the per-axis dropdowns; it has to be the thing that says whether the
// per-axis dropdowns are the whole story. That is exactly a boolean.
//
// THE SPELLING COMES FROM core/document.js and the MEANING lives here. That
// module holds the camera's one literal and this one already imports it, so the
// constant has to travel plugin-ward or the import cycle closes; re-exported
// under this file's own names because this is where every reader looks.
export const NATURAL_ZOOM_KEY = CAMERA_NATURAL_ZOOM_KEY;

/** ON by default, per the ruling's "by default it will be on for camera" — and
 *  ABSENT MEANS ON, which is what keeps every pre-BI document byte-identical:
 *  BG's coupling already governed unconditionally, so a stored `true` and a
 *  missing key must render the same frame. Read through naturalZoomOn(); nothing
 *  tests the raw key. */
export const NATURAL_ZOOM_DEFAULT = CAMERA_NATURAL_ZOOM_DEFAULT;

/**
 * Pure function. Is the coupled zoom-pan law in force for this camera state?
 *
 * ABSENT IS ON (see NATURAL_ZOOM_DEFAULT): every document written before this
 * switch existed rendered under the coupling, so reading a missing key as OFF
 * would silently re-cut every deck that moves its camera.
 *
 * Only an EXPLICIT `false` turns it off. An equation-bound value (`"= …"`) reads
 * as ON rather than throwing: this leaf is not equation-capable (it is not in
 * PROPS and takes no `=` slot), so a string here is a hand-edited document, and
 * the safe reading of a malformed switch is the one every other document gets.
 *
 * Args:
 *   state (object): a folded camera state
 *
 * Returns:
 *   boolean — true when interpolateCameraState should apply the coupling
 *
 * @example naturalZoomOn({}) // true (absent = on; a pre-BI document is unchanged)
 * @example naturalZoomOn({naturalZoom: true}) // true
 * @example naturalZoomOn({naturalZoom: false}) // false (the four dropdowns govern alone)
 * @example naturalZoomOn(undefined) // true (no camera state at all is not a reason to change the law)
 */
export function naturalZoomOn(state) {
  return state?.[NATURAL_ZOOM_KEY] !== false;
}

// THE TWO ROWS THE COUPLING ACTUALLY OVERRIDES — the pan axes, and ONLY them, per
// the measurement above. Exported because the pins assert against this set rather
// than against a literal pair: if a future change makes the coupling replace `h`
// outright, the row carrying the note must move with the law, and a test reading
// the same constant as the rows cannot catch that. Reading it in BOTH places is
// the point — the rows are BUILT from it below.
export const COUPLED_PAN_KEYS = ["x", "y"];

/** The `~interp` help sentence an OVERRIDDEN axis row carries while Natural
 *  zoom is on. It is appended to the registry's own help rather than replacing
 *  it, because the stored mode is still real and still governs the moment the
 *  frame stops scaling (a pure pan) or the switch goes off. A dropdown that
 *  named a law nothing was using would be the confident wrong answer
 *  core/properties.interpRowFor's own comment refuses; a dropdown that names its
 *  law AND says when something else outranks it is the honest form. */
const COUPLED_AXIS_NOTE =
  " NATURAL ZOOM OVERRIDES THIS WHENEVER THE FRAME IS ALSO SCALING: the pan is then"
  + " placed linear in the resulting width (the Mandelbrot law) instead of by this mode,"
  + " so this setting governs a pure pan at fixed magnification and nothing else."
  + " Turn Natural zoom off in Transform to hand this axis back to the mode named here.";


// THE CAMERA'S RENDER PROFILES — whole-scene render configurations over the three
// knobs of the "rendering" bundle that reach a rendered pixel, ordered by how far
// each departs from the smooth default (coverage AA on, no dither).
//
// `presetFamilies` with ONE titled entry rather than the flat form, on the
// plugins/mermaid.js:441-443 precedent ("presetFamilies (not presets) so the group
// is titled … specifically"): a bare "Presets" heading on the camera would be
// ambiguous the moment a BACKDROP family lands, and "Render profiles" echoes the
// Inspector's own "Rendering" accordion. The family id matches the bundle id.
//
// TWO OF THE BUNDLE'S FOUR KNOBS ARE DELIBERATELY ABSENT.
//   `retina` cannot move an exported pixel: core/view.effectiveDpr has exactly one
//     importer (web/app.svelte.js, which sizes the EDITOR canvas), and it is the
//     identity wherever devicePixelRatio is 1 — which is every headless render in
//     this repo. A preset writing it would be provably dead under the very gate
//     meant to catch dead rows.
//   `background` is not in the rendering bundle (core/properties.js declares it in
//     `formatting`) and is the author's composition, not a render setting. It would
//     also dominate every preview digest, so a family containing it would sail
//     through the distinctness check while proving nothing about the render knobs.
//
// SIX, NOT EIGHT, AND THE CUT IS A MEASUREMENT (R6-25.4). Swept on the repo's own
// banding torture fixture (tests/dither_vlm_check.js: a near-black ~10-level ramp
// over ~1000 px), whole-frame mean code values against dither OFF:
//     blueNoise  e=0.35 -> 0.055 (max 1)   e=1 -> 0.18 (max 1)   e=2 -> 0.50 (max 2)
//                e=4    -> 0.98  (max 3)   e=8 -> 1.92 (max 5)   e=16 -> 3.70 (max 9)
//     bayer      e=1    -> 0.16  (max 1)   e=3 -> 0.71 (max 2)   e=32 -> 6.83 (max 17)
// So every value the design wave proposed (0.35 to 4) moves ONE TO THREE code
// values. That dissolves banding — confirmed by eye — and produces NO visible
// texture, so rows named for a newspaper halftone, push-processed film grain and a
// bit-crush were promising a picture this knob does not draw at those values, and
// were cut. Texture only becomes real around e=16-32, where bayer renders a genuine
// fine ordered cross-hatch; those two rows are re-grounded on the measured values
// instead of the designed ones. A "Whisper Dither" at e=0.35 was cut outright: one
// code value on a tenth of the frame is the display floor, and a row whose only
// claim is that you cannot see it is a dead row by SPEC.md §11's own standard.
//
// HIGH-EMPHASIS blueNoise IS NOT OFFERED, and that is a finding rather than a
// preference: at e=32 it does not read as isotropic grain but as large soft
// blotches — its own tile's low-frequency structure, amplified. Reported to the
// renderer's owner; not shipped as a look.
//
// FULL — all three knobs in every profile, including where a value is inert
// (`ditherEmphasis` under `ditherMode: "off"`), because application is an overlay
// and a profile that omitted it would inherit the previous hover's grain strength
// and lie about itself. That is precisely the case plugins/demo/lens_flare.js:180-182
// calls out.
const RENDER_PROFILES = [
  { name: "Blue Noise De-Band", description: "The working de-band: high-frequency scatter with no pattern for the eye to lock onto, which is the quietest way to render a long gradient without eight-bit stepping.",
    props: { antialias: "standard", ditherMode: "blueNoise", ditherEmphasis: 2 } },
  { name: "Deep De-Band", description: "The same scatter at four times the strength, for a ramp long enough that a light dither still leaves steps in it — the scatter itself starts to show on flat light areas.",
    props: { antialias: "standard", ditherMode: "blueNoise", ditherEmphasis: 8 } },
  { name: "Ordered Screen", description: "The periodic threshold matrix at a strength you can actually see — a regular cross-hatch rather than grain, the artefact that reads as mechanical reproduction.",
    props: { antialias: "standard", ditherMode: "bayer", ditherEmphasis: 16 } },
  { name: "Heavy Ordered Screen", description: "The same cross-hatch driven twice as hard, so the screen becomes the surface of the picture instead of a way of hiding its steps.",
    props: { antialias: "standard", ditherMode: "bayer", ditherEmphasis: 32 } },
  { name: "Crisp Pixel Edges", description: "An unfiltered bitmap: coverage anti-aliasing off, so every diagonal is a hard staircase and nothing is blended — and no dither to soften what is left.",
    props: { antialias: "off", ditherMode: "off", ditherEmphasis: 1 } },
  { name: "Photocopy", description: "A page run through an office copier — hard unsmoothed edges over a heavy ordered screen, the two artefacts together that make a duplicate look duplicated.",
    props: { antialias: "off", ditherMode: "bayer", ditherEmphasis: 32 } },
];

export const cameraPlugin = {
  type: "camera",
  ephemeral: EPHEMERAL.NONE,
  title: "Camera",
  presetFamilies: [{ id: "rendering", title: "Render profiles", presets: RENDER_PROFILES }],
  // purgeable:false — the camera is mandatory: exactly one, cannot be deleted
  // or purged (capability-based, not type special-cased; manifest rule).
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, purgeable: false },
  // THE ONE camera literal (reconciled — this used to lack name/active and
  // hardcode 1280×720 while document.js carried the fuller truth; cruft audit).
  // The default-dims fallback (1280×720) matches the historical plugin value.
  // The SCENE-GLOBAL render settings (the "rendering" bundle: anti-aliasing /
  // retina / dither) layer on top; their defaults MATCH today's hardcoded
  // behavior (AA on, retina on, dither off) so an old document loads and renders
  // byte-identically, and the load-boundary missing-defaults fill (document.js
  // withMissingDefaultsFilled) backfills them into a pre-rendering-settings
  // camera loudly (version-skew path), exactly like rotationAnchor did.
  // `naturalZoom` rides in through defaultCameraState() (core/document.js), not
  // as a literal here — that function is THE camera literal, and this line's own
  // comment above records what happened last time a second one drifted from it.
  defaults: { ...defaultCameraState(), ...bundleDefaults("rendering") },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js): the
  // camera exposes its frame (x/y/w/h — NOT rotation/z, which don't apply to the
  // view box's editable surface), its background PAINT (solid/gradient/equation
  // — the slide backdrop), and its own "Rendering" accordion (the scene-global
  // render toggles). The registry `help` explains each.
  inspector: [
    // THE COUPLING'S SWITCH SITS ABOVE THE FRAME IT GOVERNS, in the same
    // Transform section as x/y/w/h — it is a statement ABOUT those four leaves,
    // and a reader meets it before the rows whose behaviour it qualifies.
    {
      key: NATURAL_ZOOM_KEY, label: "Natural zoom", kind: "boolean", category: "transform",
      default: NATURAL_ZOOM_DEFAULT,
      help: "Move the camera the way a zoom actually looks: the frame scales geometrically (a constant zoom RATE) and the view is panned in step with that scaling, rather than each of X/Y/W/H sliding independently. This is on by default and is what keeps the point you are zooming toward on screen the whole way in — with it off, a linear pan under a shrinking frame swings the target hundreds of frame-widths away mid-transition and snaps it back at the end. It changes nothing at either end of a transition (the stored frames are exact), nothing when the camera only pans at a fixed size, and nothing on any other widget. Turning it OFF hands X, Y, W and H back to their own interpolation modes, set individually below.",
    },
    // THE X/Y ROWS SAY WHAT OUTRANKS THEM. `interpNote` is appended to the interp
    // dropdown's own help (core/properties.interpRowFor): measured, `w` is
    // byte-identical to what its dropdown claims at every alpha and `h` is too
    // unless the aspect ratio changes, so only these two are overridden and only
    // these two carry the note. See the NATURAL ZOOM section header for the table.
    ...props("x", "y", "w", "h",
      Object.fromEntries(COUPLED_PAN_KEYS.map((k) => [k, { interpNote: COUPLED_AXIS_NOTE }]))),
    ...props("background"),
    ...bundle("rendering"),
  ],
  commands: [
    // THE SAME STATE IN A SECOND SURFACING — the house rule that the palette, the
    // shortcuts, the toolbar and the Inspector are all views of ONE action layer.
    // Declared HERE rather than as a core/registry.js TOOL_POOL row because the
    // action belongs to the widget that owns the law (plugins/text.js
    // `edit-text-content` is the standing precedent for a plugin publishing a
    // command whose gate reads the selection).
    //
    // THE TITLE NAMES THE VERB, NOT THE NEXT STATE. "Toggle Natural Zoom" rather
    // than "Turn Natural Zoom Off": the palette is searched before it is read, so
    // an entry whose name flips under the user's fingers is one they cannot learn
    // to type. The CURRENT state is what `help` reports, where there is room to
    // say it in a sentence.
    {
      id: "toggle-natural-zoom",
      title: "Toggle Natural Zoom (Camera)",
      icon: "mdi:magnify-scan",
      // A FUNCTION `requires`, per core/registry.js's rule — this gate has TWO
      // disqualifying conditions (nothing selected at all vs. something that is
      // not the camera), and a fixed string would be a confident wrong answer for
      // whichever one is not the case. Read through commandUnavailableReason.
      when: (app) => app.selectedNode()?.state?.type === "camera",
      requires: (app) => (app.selection
        ? "THE camera selected — natural zoom is the camera's own frame law, and no other widget has one"
        : "a selection — pick THE camera (its border, or the item picker) to set its frame law"),
      help: "Switches the camera's coupled zoom-pan law on or off. On (the default), a zoom keeps its target on screen the whole way in; off, X/Y/W/H each follow the interpolation mode set on their own row. Same setting as the Natural zoom checkbox in the Inspector's Transform section.",
      run: (app) => {
        const cam = app.selectedNode();
        if (!cam) return;
        // ONE undo unit through the ordinary property seam, so the palette's
        // write is byte-identical to the checkbox's — the two surfacings share
        // the state because they share the write, not because they agree.
        app.setPreview([[["items", cam.id, NATURAL_ZOOM_KEY], !naturalZoomOn(cam.state)]]);
        app.commitPreview();
      },
    },
  ],
  emit() {
    // The camera renders NOTHING (user ruling: its own dashed border doubled
    // up with the selection outline and "looked chaotic as fuck"). Selection
    // uses the standard outline; discovery is border hit-testing + the picker.
    return [];
  },
  // Hit only near the border, not the interior — the camera frames content;
  // clicks inside should select the content, not the camera. `tol` is the
  // editor's world-unit grab tolerance (constant screen-space feel).
  hitTest(s, lx, ly, tol = 6) {
    return borderBandHit(s, lx, ly, tol);
  },
  anchors: standardBBoxAnchors,
  interpolateState: interpolateCameraState,
};

// ── THE ZOOM COUPLING: why the four Exp Tween leaves are not the whole story ───
//
// User ruling, 2026-08-02 night (WORKSTREAM BG), verbatim: "It's the Mandelbrot.
// Look at the Mandelbrot interpolation logic. It took a while to get it right…
// Because when a camera zooms in, just like in Mendelbrot, it's gotta look
// natural."
//
// THE REFERENCE, read as instructed: plugins/demo/mandelbrot.js:479 zoomTweenLam.
// Its account of a natural zoom is TWO laws, not one:
//   1. the SCALE moves geometrically  — here, `w`/`h` under "Exp Tween";
//   2. the CENTRE is linear in the resulting HALF-WIDTH, not in alpha.
// Law 2 is the half that "took a while to get it right": that file records the
// measurement, where a linearly-panned centre under an exponentially-shrinking
// frame sent the target 4170 half-widths off screen mid-transition and snapped it
// back — the user's "it curved around and it was weird".
//
// MEASURED HERE, on this widget's own {x, y, w, h} bbox, because the task asked
// whether naive per-axis Exp Tween on x/y reproduces that feel. IT DOES NOT.
// Target-point offset from frame centre in half-widths (|offset| ≤ 1 is on
// screen), for w 1280 → 4 zooming onto a point 9000 units out:
//
//     alpha                       0     0.1    0.25     0.5    0.75     0.9    1
//     per-leaf Exp Tween x,w  13.06   21.53   43.61  124.81  265.17  252.26    0
//     Exp Tween w, linear x   13.06   21.53   43.61  124.81  265.17  252.26    0
//     THIS HOOK (centre in w) 13.06   13.03   12.93   12.37   10.01    5.74    0
//
// The first two rows are IDENTICAL, and that is not a coincidence: a camera's
// stored `x` is the frame's LEFT EDGE, and the default camera sits at x = 0 — a
// ZERO ENDPOINT, where expLerp takes its documented linear fallback. So per-axis
// exp on x/y buys nothing at the origin and, off it, peaks WORSE than the linear
// pan (587 vs 247 half-widths in the centre-space measurement). Only this hook's
// law is monotone. The ruling's stated acceptance is the picture, not the
// mechanism, so x/y still DECLARE "Exp Tween" (the author sees the ruling in the
// dropdown, and it governs a pure pan) while the coupled zoom is what actually
// renders whenever the frame is also scaling.
//
// This is exactly the argument core/document.js tweenedState makes for the hook's
// existence: "the correct centre path is c(a) = A + B·10^(-z(a)) with A and B
// determined by BOTH endpoints jointly", which "no reparameterization of the
// STORED leaves can fix under a leaf-wise lerp".

/**
 * Pure function. THE ZOOM TWEEN's shape parameter for a camera frame: how much of
 * the way from the TARGET width back to the START width the frame is at alpha
 * `a`. 1 at a = 0, 0 at a = 1, decaying with the FRAME rather than with alpha.
 *
 *           w(a) - wTo
 *     lam = ──────────        w(a) = wFrom·(wTo/wFrom)^a
 *           wFrom - wTo
 *
 * The direct transcription of mandelbrot.js zoomTweenLam onto a stored WIDTH
 * (that widget stores a log and exponentiates; this one stores the magnitude, so
 * `expLerp` IS its 10^(-z) and the two curves are the same).
 *
 * Args:
 *   wFrom (number): the start frame width
 *   wTo (number): the target frame width
 *   alpha (number): tween strength in [0, 1]
 *
 * Returns:
 *   number: lam in [0, 1], or NaN when there is NO zoom (wFrom === wTo)
 *
 * @example cameraZoomLam(100, 1, 0) // 1
 * @example cameraZoomLam(100, 1, 1) // 0
 * @example cameraZoomLam(100, 1, 0.5) // 0.09090909090909091 (a tenth of the way in scale, nine tenths of the way in offset)
 * @example cameraZoomLam(1, 100, 0.5) // 0.9090909090909091 (zooming OUT is the exact time-reverse)
 * @example Number.isNaN(cameraZoomLam(50, 50, 0.5)) // true (a pure pan has no zoom to couple to)
 */
export function cameraZoomLam(wFrom, wTo, alpha) {
  if (wFrom === wTo) return NaN;
  return (expLerp(wFrom, wTo, alpha) - wTo) / (wFrom - wTo);
}

/**
 * Pure function. THE CAMERA'S COUPLED FRAME (the core/document.js
 * `interpolateState` hook): the {x, y, w, h} leaves that replace the per-leaf
 * blend while a slide transition zooms the camera, or `{}` when the per-leaf
 * result is already right.
 *
 * `w`/`h` are the geometric law the four leaves already declare; the CENTRE is
 * then placed linear in the resulting width, which is the coupling — see the
 * section header for the measurement and for why per-axis exp on x/y is not it.
 *
 * RETURNS `{}` — deferring to the per-leaf blend — in exactly four cases, each
 * for a stated reason rather than as a fallback:
 *   - NATURAL ZOOM OFF (WORKSTREAM BI): the author has said the four per-axis
 *     modes govern alone, and this hook is precisely what overrides them, so its
 *     whole job here is to stand down. It is read off the TARGET state (`to`),
 *     because a switch is a property like any other and the mode-steps-at-start
 *     rule already says the incoming slide's value wins from frame 1
 *     (core/interp_modes.modeForBlend) — a transition that turns the coupling off
 *     is uncoupled for the whole of that transition, not half of it.
 *   - NO ZOOM (`w` equal at both ends): a pan at fixed magnification is a straight
 *     line, which is what the leaves already do, and lam is undefined (0/0).
 *   - A FRAME LEAF THAT IS NOT A FINITE NUMBER at either end: an `=` equation (or
 *     a key not yet in the state) is the equation's business, and this law is
 *     defined on numbers.
 *   - EITHER WIDTH ZERO OR THE PAIR SIGN-FLIPPED: the geometric law has no path
 *     there (`expTweenApplies` says so), so its coupling has no shape either. A
 *     zero-width camera is degenerate anyway — core/view.fitRectView guards it.
 *
 * `h` rides `w`'s OWN lam rather than computing its own, so a non-uniform aspect
 * change keeps one time-parameterization for the whole frame; two independent
 * lams would let width and height reach their targets at different rates and
 * shear the picture mid-zoom.
 *
 * Args:
 *   from (object): the folded camera state on the PREVIOUS slide
 *   to (object): its state on THIS slide (the delta at alpha 1)
 *   alpha (number): tween strength in (0, 1)
 *
 * Returns:
 *   object: a flat {stateKey: value} override map, possibly empty
 *
 * @example interpolateCameraState({x: 0, y: 0, w: 100, h: 100}, {x: 0, y: 0, w: 100, h: 100}, 0.5) // {} (no zoom → the per-leaf pan is correct)
 * @example interpolateCameraState({x: 0, y: 0, w: 100, h: 50}, {x: 9, y: 0, w: 1, h: 0.5}, 0.5).w // 10 (the geometric mean)
 * @example interpolateCameraState({x: 0, y: 0, w: 100, h: 50}, {x: 9, y: 0, w: 1, h: 0.5}, 1).x // 9 (exact at the endpoint)
 * @example interpolateCameraState({x: "= 1 + 1", y: 0, w: 100, h: 50}, {x: 9, y: 0, w: 1, h: 0.5}, 0.5) // {} (an equation-bound frame is the equation's business)
 * @example interpolateCameraState({x: 0, y: 0, w: 100, h: 50}, {x: 9, y: 0, w: 1, h: 0.5, naturalZoom: false}, 0.5) // {} (the author turned the coupling off; the four dropdowns govern alone)
 */
export function interpolateCameraState(from, to, alpha) {
  // THE SWITCH FIRST — before any arithmetic, so an uncoupled camera costs
  // exactly one property read and reaches none of the law below.
  if (!naturalZoomOn(to)) return {};
  const KEYS = ["x", "y", "w", "h"];
  for (const key of KEYS)
    if (!Number.isFinite(from[key]) || !Number.isFinite(to[key])) return {};
  if (!expTweenApplies(from.w, to.w)) return {};
  const lam = cameraZoomLam(from.w, to.w, alpha);
  if (!Number.isFinite(lam)) return {};
  // The frame at this alpha: width geometric, height on the SAME lam so the
  // aspect change is one motion (see above).
  const w = expLerp(from.w, to.w, alpha);
  const h = to.h + lam * (from.h - to.h);
  // The centre, linear in that width — the reference's law — then back to the
  // stored top-left corner the camera actually keyframes.
  const cx = (to.x + to.w / 2) + lam * ((from.x + from.w / 2) - (to.x + to.w / 2));
  const cy = (to.y + to.h / 2) + lam * ((from.y + from.h / 2) - (to.y + to.h / 2));
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
