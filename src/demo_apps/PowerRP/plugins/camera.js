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

import { standardBBoxAnchors } from "../core/derive.js";
import { defaultCameraState } from "../core/document.js";
import { props, bundle, bundleDefaults } from "../core/properties.js";
import { borderBandHit } from "../core/geometry.js";


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
};
