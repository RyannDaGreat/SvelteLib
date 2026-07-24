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


export const cameraPlugin = {
  type: "camera",
  title: "Camera",
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
