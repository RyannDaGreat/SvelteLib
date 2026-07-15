/**
 * Image widget — a sampled-texture quad of a bitmap the user drops in or picks
 * from the project's assets. THE first media widget, and the proof that the
 * render-parity cornerstone (manifest round 11) holds for raster content: it
 * renders through the WebGPU compositor (as a textured quad) AND through the
 * PDF backend (as an embedded image XObject), no corners cut.
 *
 * ── STATE ─────────────────────────────────────────────────────────────────────
 * `src` holds the image SOURCE as a string — a `data:` URI or a URL. That is
 * deliberately self-contained: an asset server is being built in PARALLEL, and
 * this widget must NOT depend on it (a dropped image can be inlined as a data
 * URI; a project asset can be a URL the server serves later). Because `src` is
 * a plain string it travels with the document, works offline, and needs no
 * media-registry plumbing through the web layer — every raster backend resolves
 * it (the GPU compositor via gpu/image_registry.js; the PDF backend decodes the
 * data URI itself). `w`/`h` are the quad's world size; a UI insert defaults them
 * to the image's native pixel size centered at the drop point (that UI is NOT
 * this plugin's job — see the round-12 drag-drop spec).
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false. backdrop:false is
 * what makes an image UNDER a magnifier or blur composite correctly: the image
 * paints in z-order into the scene, and the effect above it samples the
 * composited canvas (which now contains the image) — the backdrop-stacking
 * requirement holds with zero special-casing (culling likewise: the default
 * bbox-intersection rule in core/view.js canSkipNode applies for free).
 *
 * ── ASYNC (manifest F3 + the round-12 async rule) ─────────────────────────────
 * Bitmap decode is async; emit() is sync and PURE (it always returns the same
 * image op for a given state). The compositor draws NOTHING for a src whose
 * bitmap has not decoded yet and repaints when it lands (gpu/image_registry.js
 * skip-and-notify) — so there is no silent placeholder and no blocking. A
 * decode FAILURE is reported loudly by the registry (console.error), never
 * swallowed.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import * as T from "../core/transform.js";
import { image } from "../render_gpu/ir.js";

/** A tiny 1×1 transparent PNG data URI — the default `src` so a freshly added
 * image widget is a valid (invisible-until-sourced) item rather than a broken
 * ref. Replaced the instant the user drops/picks a real image. */
export const BLANK_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const imagePlugin = {
  type: "image",
  title: "Image",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "image", x: 100, y: 100, w: 200, h: 150, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: BLANK_SRC, opacity: 1,
  },
  inspector: [
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "w", label: "Width", kind: "number", min: 0 },
    { key: "h", label: "Height", kind: "number", min: 0 },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees" }, // core stores radians; field shows degrees (round-10 ruling)
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number" }, // world pivot; default self.anchors.center
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number" },
    { key: "z", label: "Z order", kind: "number" },
    // The image source (data URI / URL). A generic string row today — the
    // proper asset-picker control lands with the asset server + explorer.
    { key: "src", label: "Source", kind: "text" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1 },
  ],
  /**
   * Pure function. State → display-list commands (local space) — THE render
   * API. The `ref` IS the source string: every raster backend resolves it (the
   * GPU compositor through gpu/image_registry.js, the PDF backend by decoding
   * the data URI). Returns nothing for an empty/missing src (a broken widget
   * draws nothing rather than emitting an invalid op).
   */
  emit(s) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    return [image({ ref: s.src, x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0, opacity: s.opacity ?? 1 })];
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-image", title: "Add Image", icon: "mdi:image-outline", run: (app) => app.addItem(imagePlugin.defaults) },
  ],
};
