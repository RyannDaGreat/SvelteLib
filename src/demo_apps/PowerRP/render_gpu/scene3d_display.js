/**
 * THE 3D VIEWPORT DISPLAY PRE-PASS (todo #257) — the THIRD of these, after
 * render_gpu/pdf_display.js and render_gpu/map_display.js, and built to their
 * shape rather than to a new one.
 *
 * ── THE PRINCIPLE, IN THE USER'S OWN WORDS ───────────────────────────────────
 * "You know how when I zoom into the Mandelbrot — I just zoom into the canvas and
 * by doing so I'm zooming into the Mandelbrot too. How it adjusts resolution,
 * renders in a smaller region, and makes it IMPOSSIBLE FOR THE USER TO TELL IT
 * WAS EVEN RASTER. That's what we should be doing with Gaussian splats and 3D
 * widgets… whatever my screen-space resolution is when I view it is what it
 * should render, and it should render A CROP of it to be faster. It doesn't need
 * to render the entire object, just where the camera is. So I can never see the
 * pixels. THIS IS A GENERAL PRINCIPLE."
 *
 * The Mandelbrot is the QUALITY BAR and not the template: it is a shader
 * evaluated per device pixel, so it is resolution-independent by construction and
 * has no raster to crop. A 3D viewport does produce a raster, which makes
 * pdf_page the structural template — re-raster the visible region at display
 * resolution, every frame, and let the generation of stale refs fall out of the
 * content-addressed cache.
 *
 * ── WHAT MAKES 3D DIFFERENT FROM A PDF, AND IT IS THE WHOLE TRICK ────────────
 * Cropping a PDF page means rasterizing a SUB-RECT OF A PAGE. Cropping a 3D scene
 * cannot mean cropping a finished bitmap — that adds no detail, which is exactly
 * the complaint. It means rendering through an ASYMMETRIC SUB-FRUSTUM: the same
 * camera, sheared so it draws only the window that is on screen, at that window's
 * device resolution. three.js spells that `camera.setViewOffset(fullW, fullH, x,
 * y, w, h)` and it is the same device a tiled offline renderer uses. This module
 * computes those five numbers; render_gpu/gpu/scene3d_raster.js applies them.
 *
 * ── THIS MODULE IS PURE, AND THAT IS DELIBERATE ──────────────────────────────
 * Unlike pdf_display, which kicks rasters itself, this one only does GEOMETRY: it
 * returns a descriptor and touches no engine, no registry and no cache. The
 * rasterization stays in the plugin's emit() where it already lived, so there is
 * exactly ONE place that turns a viewport into a ref and the crop is just another
 * field of the spec it passes. The payoff is that the whole decision — which is
 * the part with the arithmetic and therefore the part that can be wrong — is
 * testable in bare node with no GPU.
 *
 * ── WHY A PRE-PASS AT ALL ────────────────────────────────────────────────────
 * emit() is camera-free by design (sceneIR passes state and the node's own world,
 * never the outer zoom/pan/dpr), because the same emit output feeds the editor,
 * the presenter, thumbnails, the CLI and the exporters. A zoom-dependent
 * resolution therefore cannot be decided inside it. The surfaces that DO know the
 * view run this before sceneIR and hand each node its descriptor; surfaces with
 * none (export, thumbnails, CLI) pass nothing and the widget takes its camera-free
 * fallback, byte-identically to before this file existed.
 *
 * DOM-free and engine-free at import: core geometry plus one constant. It lives in
 * render_gpu/ rather than core/ only to sit beside its two siblings.
 */

import { rasterFitFactor, visibleSourceRect } from "../core/clip.js";
import { cropInsetsToSource } from "./decorate.js";
import { SCENE3D_MAX_RASTER_DIM, SCENE3D_RASTER_DENSITY } from "./gpu/scene3d_raster.js";

/** The render mode this pre-pass serves. A widget in any other mode gets no
 *  descriptor and keeps the sizing rule it already had, which is what makes the
 *  new mode additive rather than a migration of the other two. */
export const SCENE3D_VIEWPORT_MODE = "viewport";

/**
 * Pure function. ONE node's viewport descriptor, or null when it has none —
 * split out from the walk so the arithmetic can be tested directly, which is the
 * only part of this file that can be wrong.
 *
 * The five sub-frustum numbers, derived from the visible-region primitive:
 *
 *   scale   = device px per LOCAL unit, SUPERSAMPLED        (vsr.scale x density)
 *   fullW,H = the WHOLE cropped box at that scale          — the virtual image
 *   x, y    = the visible window's offset inside it        — where to shear to
 *   w, h    = the visible window at that scale             — the surface size
 *
 * so the raster is always about the size of the widget's footprint ON SCREEN,
 * whatever the canvas zoom is. That bound is the point: at 50x zoom a whole-object
 * raster would want 2500x the pixels, and this wants the same as at 1x.
 *
 * THE SUPERSAMPLE IS NOT OPTIONAL, AND LEAVING IT OUT WAS A MEASURED REGRESSION.
 * The obvious reading of "render at screen resolution" is 1:1 device pixels, and
 * the first version did exactly that — which made this mode SOFTER than the
 * "Follow widget size" mode it replaces at ordinary zoom, because that one has
 * always rendered at SCENE3D_RASTER_DENSITY (the app-wide 2x, ir.js
 * SUPERSAMPLE_DENSITY) and downsampled. The probe's A/B caught it: at zoom 1 the
 * old mode produced 15% MORE detail than the new one. The engine draws splats
 * with WebGL MSAA off (Spark's own requirement), so the supersample is this
 * widget's only edge antialiasing; dropping it to gain pixels would have traded
 * away quality at the magnification most authors work at, to buy headroom at one
 * they rarely visit. Density first, then the fit clamp on the result.
 *
 * A LAST-RESORT CLAMP, ON THE SURFACE AND ONLY THE SURFACE. `fullW/fullH` are
 * projection arithmetic, never an allocation — a sub-frustum's virtual image is
 * ALLOWED to be enormous, and at a deep zoom it always is (100 local units at
 * zoom 128 is a 12,800 px virtual image behind a 400 px window). Clamping THAT
 * would cap detail at exactly the magnifications this mode exists to serve, which
 * is the defect rather than the guard. The thing a driver must allocate is the
 * WINDOW, so the fit factor is computed from `deviceRect` — and once computed it
 * scales all five numbers TOGETHER, because clamping the surface alone would
 * shear the frustum for a picture of a different size: a visibly wrong crop
 * rather than a soft one. In practice it is inert (the window is viewport-bounded
 * by construction) and only engages on a canvas larger than the driver's limit.
 *
 * That correction was earned: the first version clamped on the virtual image and
 * a bare-node test caught it, reporting a QUARTER of the resolution at zoom 128.
 *
 * @param {object} node a derived render node (carries .state and .world)
 * @param {object} view the camera mapping {zoom, panX, panY, dpr}
 * @param {number} viewW device-px canvas width
 * @param {number} viewH device-px canvas height
 * @returns {{x:number,y:number,w:number,h:number,deviceW:number,deviceH:number,viewOffset:{fullW:number,fullH:number,x:number,y:number}}|null}
 *
 * @example
 * // A 100x100 widget at the origin, wholly inside a 400x400 canvas at zoom 1:
 * // the window IS the box, so the offset is (0, 0) and the virtual image is the surface.
 * scene3dViewDescriptor(
 *   {state: {w: 100, h: 100}, world: {x: 0, y: 0, rotation: 0, scale: 1}},
 *   {zoom: 1, panX: 0, panY: 0, dpr: 1}, 400, 400
 * )
 * // {x: 0, y: 0, w: 100, h: 100, deviceW: 200, deviceH: 200, viewOffset: {fullW: 200, fullH: 200, x: 0, y: 0}}
 *
 * @example
 * // The SAME widget at zoom 8 on a 400x400 canvas: only the top-left 50x50 local
 * // units are on screen, so the surface stays one canvas-worth (bounded by the
 * // SCREEN, not the zoom) while the virtual image it is a window into grows.
 * scene3dViewDescriptor(
 *   {state: {w: 100, h: 100}, world: {x: 0, y: 0, rotation: 0, scale: 1}},
 *   {zoom: 8, panX: 0, panY: 0, dpr: 1}, 400, 400
 * )
 * // {x: 0, y: 0, w: 50, h: 50, deviceW: 800, deviceH: 800, viewOffset: {fullW: 1600, fullH: 1600, x: 0, y: 0}}
 */
export function scene3dViewDescriptor(node, view, viewW, viewH) {
  const s = node.state;
  const vsr = visibleSourceRect({ world: node.world, w: s.w ?? 0, h: s.h ?? 0 }, s, view, { viewW, viewH });
  if (!vsr.visible || !(vsr.deviceRect.w > 0) || !(vsr.deviceRect.h > 0)) return null;
  const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
  const dense = vsr.scale * SCENE3D_RASTER_DENSITY;
  const fit = rasterFitFactor(vsr.deviceRect.w * SCENE3D_RASTER_DENSITY, vsr.deviceRect.h * SCENE3D_RASTER_DENSITY, SCENE3D_MAX_RASTER_DIM);
  const scale = dense * fit;
  return {
    x: vsr.localRect.x, y: vsr.localRect.y, w: vsr.localRect.w, h: vsr.localRect.h,
    deviceW: Math.max(1, Math.round(vsr.localRect.w * scale)),
    deviceH: Math.max(1, Math.round(vsr.localRect.h * scale)),
    viewOffset: {
      fullW: Math.max(1, c.w * scale),
      fullH: Math.max(1, c.h * scale),
      x: (vsr.localRect.x - c.x) * scale,
      y: (vsr.localRect.y - c.y) * scale,
    },
  };
}

/**
 * Pure function. THE PRE-PASS: every visible 3D viewport's descriptor, keyed by
 * item id, for render_gpu/ports.sceneIR to thread into emit().
 *
 * SELECTION IS BY DECLARATION, NOT BY TYPE NAME. pdf_display tests
 * `node.type !== "pdf_page"`, which is correct for a widget that is one of a kind
 * and would be a hand-maintained mirror here: this is a FAMILY, it already has two
 * members, and a third is a row in a table. A plugin opts in with
 * `viewportRaster: true`, so a new member is opted in by the factory that builds
 * it and cannot be forgotten — the drifted-mirror defect this codebase keeps
 * finding, avoided rather than re-created.
 *
 * A node in any other render mode is SKIPPED rather than given a null entry: the
 * absence of a descriptor is already the signal emit() reads for "no pre-pass
 * ran", so one absence means one thing everywhere.
 *
 * @param {object[]} nodes the derived render tree
 * @param {object} view the camera mapping {zoom, panX, panY, dpr}
 * @param {number} viewW device-px canvas width
 * @param {number} viewH device-px canvas height
 * @returns {Map<string, object>} itemId → descriptor (see scene3dViewDescriptor)
 *
 * @example prepareScene3dViews([], {zoom: 1, panX: 0, panY: 0, dpr: 1}, 800, 600).size // 0
 * @example
 * // A widget whose plugin does not declare viewportRaster is never considered:
 * prepareScene3dViews(
 *   [{itemId: "a", state: {w: 10, h: 10, renderMode: "viewport"}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {}}],
 *   {zoom: 1, panX: 0, panY: 0, dpr: 1}, 800, 600
 * ).size // 0
 */
export function prepareScene3dViews(nodes, view, viewW, viewH) {
  const map = new Map();
  for (const node of nodes) {
    if (node.plugin?.viewportRaster !== true) continue;
    if ((node.state?.renderMode ?? "") !== SCENE3D_VIEWPORT_MODE) continue;
    const descriptor = scene3dViewDescriptor(node, view, viewW, viewH);
    if (descriptor) map.set(node.itemId, descriptor);
  }
  return map;
}
