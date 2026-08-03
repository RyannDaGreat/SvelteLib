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

import { convergesOnRefs } from "../render_gpu/gpu/settled.js";
import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { image } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** A tiny 1×1 transparent PNG data URI — the default `src` so a freshly added
 * image widget is a valid (invisible-until-sourced) item rather than a broken
 * ref. Replaced the instant the user drops/picks a real image. */
export const BLANK_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** THE sampling default — "nearest" is the long-standing pre-Round-3 behaviour, so
 *  it is what keeps an untouched image byte-identical. ONE constant because the
 *  value has TWO readers that must never disagree: `defaults` (what a NEW item
 *  gets) and emit's `??` (what an item saved BEFORE this row existed falls back
 *  to). It used to be three literals — the row also carried `default: "nearest"`,
 *  which was INERT: `defaults()` reads the shared PROPS registry
 *  (core/properties.js:1584), and nothing in core/, web/ or render_gpu/ reads
 *  `.default` off an inspector row. `sampling` is not a PROPS key (measured: 86
 *  keys, no `sampling`), so that declaration looked authoritative and did nothing,
 *  and a new item's `sampling` was simply absent. Now it is a real default. */
export const DEFAULT_SAMPLING = "nearest";

export const imagePlugin = {
  type: "image",
  // CONVERGES: it draws an async raster (the decoded bitmap). settled.js owns what
  // “ready” means so this cannot drift from its thirteen siblings.
  ephemeral: convergesOnRefs((s) => [s.src]),
  title: "Image",
  // THE WIDGET A DROPPED IMAGE BECOMES (core/registry.js assetDropKindOf). Other
  // widgets ACCEPT an image in their src row; this one is what a bare file drop
  // creates, which is a different question and so a separate declaration.
  assetDrop: "image",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // asset picker. `primaryAsset` names WHICH property that picker fills; this
  // string is what says the double-click opens it at all.
  activate: "asset_picker",
  primaryAsset: "src",
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js):
  // the transform bundle, the stroked-BORDER slice (stroke/strokeWidth/
  // cornerRadius — a photo has a frame, not a fill), and opacity are inherited,
  // so an added stroke aspect (dashes/caps/joins) reaches images automatically.
  // strokeWidth 0 + cornerRadius 0 by default → an undecorated image renders
  // byte-identically to before this bundle existed (decorateStrokedBox is a
  // pass-through when there's nothing to draw).
  defaults: {
    type: "image", x: 100, y: 100, w: 200, h: 150, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: BLANK_SRC,
    // stroke COLOR default matches every other stroked shape (rect/circle/donut
    // all use INK #000000); it only paints once strokeWidth > 0 (0 by default).
    stroke: "#000000",
    sampling: DEFAULT_SAMPLING,
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth:0, cornerRadius:0, opacity:1
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  inspector: [
    ...bundle("transform"),
    // The image source (data URI / URL) — the registry `src` row. Default
    // assetKinds (["image"]) and assetForm ("url") match this widget exactly,
    // so no override is needed here (unlike video/filmstrip).
    ...props("src"),
    // SAMPLING (Round 3 #37). "Nearest" IS the long-standing behavior — the
    // legacy draw call measures hard-edged on upscale (the user's premise was
    // right); Bilinear is the NEW smooth option. Absent/default renders
    // byte-identically.
    // No `default:` on this row — a row-level `default` is INERT (see
    // DEFAULT_SAMPLING). The real default is in `defaults` above.
    { key: "sampling", label: "Sampling", kind: "select", options: ["nearest", "bilinear"], optionLabels: { nearest: "Nearest (crisp)", bilinear: "Bilinear (smooth)" }, category: "formatting", help: "How the image's pixels are enlarged or shrunk. Nearest (the default, and the long-standing behavior) keeps every source pixel a crisp square — right for pixel art, QR codes, screenshots. Bilinear blends neighbouring pixels — right for photos that shouldn't look blocky when scaled." },
    // The stroked-BORDER bundle (manifest "SHARED STYLE BUNDLES — images and
    // videos inherit stroke/rounding at once"). No `fill` row: an image's own
    // pixels ARE its interior. The default INK stroke color is in `defaults`
    // (matching rect/circle/donut), invisible until strokeWidth > 0.
    ...bundle("strokedBorder"),
    // EDGE-CROP INSETS (manifest "Edge-crop insets") — trim the source from each
    // side; all-0 default = byte-identical to no crop.
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (local space) — THE render
   * API. The `ref` IS the source string: every raster backend resolves it (the
   * GPU compositor through gpu/image_registry.js, the PDF backend by decoding
   * the data URI). Returns nothing for an empty/missing src (a broken widget
   * draws nothing rather than emitting an invalid op).
   *
   * EDGE-CROP INSETS (manifest "Edge-crop insets"): cropInsetsToSource shrinks
   * the drawn quad by the per-edge insets AND contracts the source UV rect to
   * match — a source crop, not a stretch. All-zero insets → full quad + full
   * frame (byte-identical to no crop).
   *
   * BORDER + ROUNDED CORNERS (manifest "SHARED STYLE BUNDLES"): when the
   * stroked-border style has anything to draw, the (cropped) image quad is
   * wrapped by the shared decorateStrokedBox (render_gpu/decorate.js) — a
   * cropSubtree giving it a rounded-corner clip + border ring, reusing the
   * crop-box machinery. The decoration frames the CROPPED rect (what's actually
   * shown), so a bordered+cropped image's frame hugs the visible pixels. When
   * there's no border/rounding it's a pass-through: the bare image op, unchanged
   * from before this bundle existed. `world` (sceneIR's 3rd emit arg) is only
   * needed on the decorated path — cropSubtree's content carries its own
   * absolute world (see decorate.js's OPACITY/world contracts). The widget
   * opacity always rides on the image op itself (the OPACITY CONTRACT — it fades
   * identically on GPU and PDF); the border/fill stay opaque.
   */
  emit(s, _targetWorldIR, world) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw
    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const quad = image({ ref: s.src, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh, sampling: s.sampling ?? DEFAULT_SAMPLING });
    // Effects wrap OUTSIDE the border decoration (render_gpu/effects.js order
    // rule): the shadow/bloom silhouette the FRAMED image, border included.
    // The effect bbox is the CROPPED (drawn) rect — what the widget paints.
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
    { id: "add-image", title: "Add Image", icon: "mdi:image-outline", run: (app) => app.armCrosshairPlacement(imagePlugin) }, // crosshair bbox placement of a blank image widget (manifest UNDEFERRAL SWEEP); drop/explorer inserts still use native-size insertImageAsset
  ],
};
