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
import { defaultCameraState } from "../core/document.js";
import { props, bundle, bundleDefaults } from "../core/properties.js";
import { borderBandHit } from "../core/geometry.js";
import { expLerp, expTweenApplies } from "../core/interp_modes.js";


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
  defaults: { ...defaultCameraState(), ...bundleDefaults("rendering") },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js): the
  // camera exposes its frame (x/y/w/h — NOT rotation/z, which don't apply to the
  // view box's editable surface), its background PAINT (solid/gradient/equation
  // — the slide backdrop), and its own "Rendering" accordion (the scene-global
  // render toggles). The registry `help` explains each.
  inspector: [
    ...props("x", "y", "w", "h"),
    ...props("background"),
    ...bundle("rendering"),
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
 * RETURNS `{}` — deferring to the per-leaf blend — in exactly three cases, each
 * for a stated reason rather than as a fallback:
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
 */
export function interpolateCameraState(from, to, alpha) {
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
