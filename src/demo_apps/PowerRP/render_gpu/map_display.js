/**
 * THE MAP TILE PRE-PASS — the render-time layer that decides WHICH TILES, AT WHAT
 * DEPTH, a map widget draws this frame. The twin of render_gpu/pdf_display.js,
 * and it exists for the identical reason.
 *
 * ── WHY A PRE-PASS AND NOT emit() ────────────────────────────────────────────
 * A plugin's `emit(state, …)` is deliberately CAMERA-FREE: sceneIR passes state
 * and the node's own local world, never the outer zoom/pan/dpr, so ONE emit output
 * feeds the editor, the presenter, thumbnails, the CLI and both vector exporters.
 * The tile-depth decision is a function of the camera, so it CANNOT live in emit
 * without breaking that. The surfaces that DO know the view (CanvasView,
 * PresentMode — via web/cameraFrame.js) run this pass BEFORE sceneIR and hand each
 * map node its descriptor through sceneIR's 4th argument, exactly as the PDF
 * re-raster does. emit stays pure: same args, same output.
 *
 * ── THE VIEW-RESOLUTION LAW, MADE MECHANICAL ─────────────────────────────────
 * The user's law, verbatim: "if I zoom in, it should render a smaller crop of the
 * thing … rendering a portion should be faster than rendering the whole thing and
 * then cropping … I should be able to zoom in with the canvas camera in arbitrary
 * detail, through the rendering alone."
 *
 * Both halves are satisfied here, and neither is satisfiable in emit:
 *
 *   DEPTH   `core/geo_tiles.tileZoomFor` composes the widget's own `zoom` property
 *           with the camera's DEVICE PIXELS PER WORLD UNIT (view.zoom · view.dpr).
 *           Zoom the canvas camera into a map and devicePerWorld rises, so the
 *           effective tile z rises with it and the SAME DOCUMENT fetches deeper
 *           tiles — arbitrary detail through the rendering alone, up to the
 *           provider's native ceiling.
 *   CROP    The tile list comes from the VISIBLE window (widget box ∩ viewport,
 *           via the same core/clip.visibleSourceRect primitive the PDF path uses),
 *           not from the widget's full extent. So a camera zoomed into one corner
 *           of a large map requests the tiles for THAT CORNER: cost proportional
 *           to what is on screen, never to the widget. This is the property the
 *           fixture probe asserts by counting requests.
 *
 * ── MAGNIFIER COMPATIBILITY IS FREE, AND THAT IS THE POINT ───────────────────
 * A magnifier over a map is not a special case here and needs no map-specific
 * code. plugins/demo/magnify.js's `supersample` path RE-RENDERS the content under
 * the lens at magnified zoom — a re-render with a LARGER view.zoom, which arrives
 * at this pass through the ordinary `view` argument and therefore raises
 * devicePerWorld and selects deeper tiles. The lens gets crisp map detail by the
 * same mechanism the camera does, because both are "the view is more magnified
 * now" and this pass reads only that. Any future seam that re-renders at a
 * different scale inherits it too.
 *
 * ── NO PRE-PASS = THE CAMERA-FREE FALLBACK ───────────────────────────────────
 * Export, thumbnails, the CLI and the tests run no pre-pass and pass no
 * descriptor. plugins/demo/globe_map.js then takes its fallback: tiles chosen from
 * the widget's OWN zoom and box alone (devicePerWorld = 1), which is a correct,
 * camera-independent picture of the same place. That is what keeps a PDF export
 * and a headless still from depending on somebody's screen.
 *
 * Browser/CLI-facing (it drives the tile registry, which needs fetch +
 * createImageBitmap), NOT part of the DOM-free core/.
 */

import { visibleSourceRect } from "../core/clip.js";
import { rectsIntersect, rotatedBBoxAABB } from "../core/view.js";
import {
  TILE_BUDGET, mapWorldWindow, tileZoomFor, tilesForWindow,
} from "../core/geo_tiles.js";
import { providerFor } from "../web/tile_providers.js";
import { ensureTile, markTileFailed, tileRef, tileStatus, trimTileCache } from "./gpu/tile_registry.js";

/** The widget `type` this pass serves. Named once so a rename cannot leave the
 *  pass silently matching nothing (which would look like "the map stopped getting
 *  crisp" rather than like a broken pass). */
export const MAP_WIDGET_TYPE = "demo_globe_map";

/**
 * Pure function. THE CAMERA'S CONTRIBUTION to tile depth: device pixels per world
 * unit, `view.zoom · view.dpr`, times the node's own world scale (a map scaled up
 * as an object is showing more pixels per world unit too, exactly as if the camera
 * had zoomed).
 *
 * Stated as its own function because it is the ONE quantity that couples the
 * camera to tile selection, and because the dpr factor is easy to forget — leaving
 * it out makes every map soft on a Retina display in a way that looks like a tile
 * quality problem rather than an arithmetic one.
 *
 * @param {{zoom: number, dpr: number}} view - the live camera mapping
 * @param {number} worldScale - the node's own world.scale
 * @returns {number} device px per world unit (> 0)
 *
 * @example devicePerWorldUnit({zoom: 1, dpr: 1}, 1) // 1
 * @example devicePerWorldUnit({zoom: 4, dpr: 1}, 1) // 4 (camera zoomed 4x ⇒ 4x the device pixels)
 * @example devicePerWorldUnit({zoom: 1, dpr: 2}, 1) // 2 (a Retina display is genuinely twice the pixels)
 * @example devicePerWorldUnit({zoom: 2, dpr: 2}, 1.5) // 6 (a scaled-up widget shows more pixels per world unit too)
 */
export function devicePerWorldUnit(view, worldScale) {
  return Math.max(1e-6, (view?.zoom ?? 1) * (view?.dpr ?? 1) * Math.max(1e-6, worldScale ?? 1));
}

/**
 * Pure function. THE VISIBLE SUB-WINDOW of a map, in the widget's own normalized
 * world-Mercator units: the part of its geographic window that is actually on
 * screen. `visible` is the widget box ∩ viewport expressed as fractions of the
 * box (core/clip.visibleSourceRect's output shape), so this maps that fraction
 * onto the geographic window the widget shows.
 *
 * THIS IS THE CROP ECONOMY IN ONE FUNCTION: everything downstream asks for tiles
 * over the returned rect, so an off-screen half of a map contributes no requests.
 *
 * @param {{x: number, y: number, w: number, h: number}} window - the full geographic window (mapWorldWindow)
 * @param {{sx: number, sy: number, sw: number, sh: number}} visible - visible fraction of the box
 * @returns {{x: number, y: number, w: number, h: number}} the visible part, in normalized world units
 *
 * @example croppedWindow({x: 0, y: 0, w: 1, h: 1}, {sx: 0, sy: 0, sw: 1, sh: 1}) // {x: 0, y: 0, w: 1, h: 1} (all on screen: unchanged)
 * @example croppedWindow({x: 0, y: 0, w: 1, h: 1}, {sx: 0.5, sy: 0, sw: 0.5, sh: 1}) // {x: 0.5, y: 0, w: 0.5, h: 1} (the right half is showing)
 * @example croppedWindow({x: 0.25, y: 0.25, w: 0.5, h: 0.5}, {sx: 0, sy: 0, sw: 0.5, sh: 0.5}) // {x: 0.25, y: 0.25, w: 0.25, h: 0.25} (a quarter of a quarter)
 */
export function croppedWindow(window, visible) {
  return {
    x: window.x + window.w * (visible.sx ?? 0),
    y: window.y + window.h * (visible.sy ?? 0),
    w: window.w * (visible.sw ?? 1),
    h: window.h * (visible.sh ?? 1),
  };
}

/**
 * Query (kicks idempotent fetches; mutates the tile registry's LRU). THE PASS.
 * Given the derived render tree and the live view, returns Map<itemId, descriptor>
 * where a descriptor is
 *
 *     {z, tiles: [{x, y, z, wrapped, ref, ready}], window, provider, attribution}
 *
 * — the tiles this frame should draw, at the depth this frame's magnification
 * justifies, with each one's readiness resolved SYNCHRONOUSLY so emit can decide
 * per tile between real pixels and the loading affordance without ever awaiting.
 *
 * Nothing here awaits. Tiles not yet decoded are reported `ready: false`; the
 * registry's onTileLoad wakes the reactive repaint when they land, so the next
 * frame draws them. That is the same async contract every media registry in this
 * codebase follows.
 *
 * @param {object[]} nodes - deriveRenderTree output (nodes carry .plugin/.state/.world)
 * @param {{zoom: number, panX: number, panY: number, dpr: number}} view - the live camera
 * @param {number} viewW - device-px canvas width
 * @param {number} viewH - device-px canvas height
 * @returns {Map<string, object>} itemId → descriptor (empty when nothing applies)
 */
export function prepareMapTiles(nodes, view, viewW, viewH) {
  const map = new Map();
  if (!(viewW > 0) || !(viewH > 0)) return map; // collapsed surface — nothing to size
  const needed = new Set();
  for (const node of nodes) {
    if (node.type !== MAP_WIDGET_TYPE) continue;
    const aabb = rotatedBBoxAABB(node);
    // A map scrolled entirely off screen asks for NOTHING. Without this the crop
    // economy would still hold per-tile but an off-screen map would keep a full
    // screen's worth of tiles resident, which is the same waste one layer up.
    if (aabb && !rectsIntersect(aabb, worldRectOf(view, viewW, viewH))) continue;
    const descriptor = describeMapNode(node, view, viewW, viewH);
    if (!descriptor) continue;
    map.set(node.itemId, descriptor);
    for (const tile of descriptor.tiles) needed.add(tile.ref);
  }
  // Bound the resident set AFTER every map has stated its needs, protecting
  // exactly this frame's tiles (see trimTileCache: a budget bounds history, never
  // the frame being painted).
  if (needed.size) trimTileCache(needed);
  return map;
}

/** Pure function. The world-space rect the canvas currently shows — the same
 *  inversion core/view.worldViewRect does, restated here only so this module does
 *  not need the whole view module for one call. Kept private for that reason. */
function worldRectOf(view, viewW, viewH) {
  const wx = (dx) => (dx / (view.dpr ?? 1) - (view.panX ?? 0)) / (view.zoom ?? 1);
  const wy = (dy) => (dy / (view.dpr ?? 1) - (view.panY ?? 0)) / (view.zoom ?? 1);
  const x0 = wx(0), y0 = wy(0), x1 = wx(viewW), y1 = wy(viewH);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * Query (kicks fetches). One map node's descriptor, or null when it has no
 * drawable window this frame.
 *
 * @param {object} node - a derived render node of MAP_WIDGET_TYPE
 * @param {object} view - the live camera mapping
 * @param {number} viewW - device-px canvas width
 * @param {number} viewH - device-px canvas height
 * @returns {object|null}
 */
export function describeMapNode(node, view, viewW, viewH) {
  const s = node.state;
  const provider = providerFor(s.style);
  const devicePerWorld = devicePerWorldUnit(view, node.world?.scale ?? 1);
  const z = tileZoomFor(s.zoom, s.w, devicePerWorld, provider.maxZoom);
  const window = mapWorldWindow(s.centerLon, s.centerLat, s.zoom, s.w, s.h);

  // THE VISIBLE CROP. The shared primitive (the PDF path's own) answers "what
  // fraction of this widget's box is on screen", which is exactly the fraction of
  // its geographic window worth fetching. It takes the BOX (w/h/world) and the
  // widget's crop insets; a map honours cropInsets like any other bbox widget, so
  // a cropped map fetches only the tiles inside the crop as well.
  const vis = visibleSourceRect(
    { w: s.w, h: s.h, world: node.world },
    s.cropInsets ?? {},
    view,
    { viewW, viewH, margin: 0 },
  );
  if (!vis.visible || !(vis.sourceRect.sw > 0) || !(vis.sourceRect.sh > 0)) return null;
  const cropped = croppedWindow(window, vis.sourceRect);

  const tiles = tilesForWindow(cropped, z, TILE_BUDGET).map((tile) => {
    const ref = tileRef(provider, tile);
    ensureTile(ref);
    const status = tileStatus(ref);
    if (status === "error") markTileFailed(ref);
    return { ...tile, ref, ready: status === "ready" };
  });
  return { z, tiles, window, cropped, devicePerWorld, provider: provider.id, attribution: provider.attribution };
}
