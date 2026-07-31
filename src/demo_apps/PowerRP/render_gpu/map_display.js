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
  TILE_BUDGET, geoTileZoomFor, geoTilesForWindow, globeWeight, mapGeoWorldWindow, mapWorldWindow,
  tileZoomFor, tilesForWindow,
} from "../core/geo_tiles.js";
import { OVERLAY_IDS, geographicFor, overlayFor, overlayPropName, providerFor } from "../web/tile_providers.js";
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
    // Overlay tiles are protected from eviction exactly like the base's — an
    // active overlay's tiles are just as much "what this frame needs" as the
    // basemap's, and skipping them here would let trimTileCache evict a label
    // tile the SAME frame just fetched it.
    for (const layer of Object.values(descriptor.overlays ?? {}))
      for (const tile of layer.tiles) needed.add(tile.ref);
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
 * Query (kicks fetches). The tile list for ONE provider-shaped descriptor (a base
 * provider OR an overlay — both are TILE_PROVIDERS-shaped: {url, subdomains,
 * maxZoom}) over a given window, at the DEEPEST zoom that provider's own maxZoom
 * allows. Factored out of describeMapNode so the base layer and every active
 * overlay share one fetch path — an overlay is not a second implementation, it is
 * the same tile mechanics run again with a different provider and its OWN
 * (typically shallower) zoom ceiling.
 *
 * @param {object} provider - a TILE_PROVIDERS or TILE_OVERLAYS entry
 * @param {{x: number, y: number, w: number, h: number}} cropped - the visible window
 * @param {number} devicePerWorld - camera device px per world unit
 * @param {number} widgetPx - the widget's box width, world units
 * @param {number} widgetZoom - the widget's own continuous zoom property
 * @returns {{z: number, tiles: object[]}}
 */
function layerTilePlan(provider, cropped, devicePerWorld, widgetPx, widgetZoom) {
  const z = tileZoomFor(widgetZoom, widgetPx, devicePerWorld, provider.maxZoom);
  const tiles = tilesForWindow(cropped, z, TILE_BUDGET).map((tile) => {
    const ref = tileRef(provider, tile);
    ensureTile(ref);
    const status = tileStatus(ref);
    if (status === "error") markTileFailed(ref);
    return { ...tile, ref, ready: status === "ready" };
  });
  return { z, tiles };
}

/**
 * Query (kicks fetches). The GEOGRAPHIC (EPSG:4326) tile plan for one layer's own
 * window — the globe-only twin of layerTilePlan, over core/geo_tiles's
 * geoTileZoomFor/geoTilesForWindow instead of the Mercator pair. Called ONLY when
 * the layer has a `.geographic` descriptor (tile_providers.geographicFor) and the
 * globe weight is nonzero; the flat map never calls this, and a provider with no
 * geographic twin (OSM, Terrain) never reaches it either, because the caller
 * checks geographicFor's null first — see describeMapNode.
 *
 * Uses the SAME crop FRACTION (`vis.sourceRect`) the Mercator plan does, applied
 * to the geographic window instead: the visible-fraction-of-the-box computation
 * is projection-agnostic (core/clip.visibleSourceRect never looks at lon/lat), so
 * cropping is shared math and only the window/tile grid itself differs between
 * the two calls.
 *
 * @param {object} geo - a `.geographic` descriptor ({url, maxZoom, tileSize})
 * @param {{x: number, y: number, w: number, h: number}} croppedGeo - the visible geographic window
 * @param {number} devicePerWorld - camera device px per world unit
 * @param {number} widgetPx - the widget's box width, world units
 * @param {number} widgetZoom - the widget's own continuous zoom property
 * @returns {{z: number, tiles: object[]}}
 */
function geoLayerTilePlan(geo, croppedGeo, devicePerWorld, widgetPx, widgetZoom) {
  const z = geoTileZoomFor(widgetZoom, widgetPx, devicePerWorld, geo.maxZoom);
  const tiles = geoTilesForWindow(croppedGeo, z, TILE_BUDGET).map((tile) => {
    const ref = tileRef(geo, tile);
    ensureTile(ref);
    const status = tileStatus(ref);
    if (status === "error") markTileFailed(ref);
    return { ...tile, ref, ready: status === "ready" };
  });
  return { z, tiles };
}

/**
 * Pure function. The globe weight this module uses to decide WHICH pyramid is
 * worth fetching — the pre-pass's own read of the exact same pin
 * plugins/demo/globe_map.js's effectiveGlobeWeight applies, reproduced here
 * rather than imported (this module may not import a plugin; the pin itself is
 * three lines and pure, so duplicating it is cheaper and more honest than a
 * cross-layer import for one ternary). Kept in lock-step by
 * tests/geo4326_test.js asserting both read the SAME viewMode/zoom inputs to
 * the SAME weight.
 *
 * @param {object} s - folded item state
 * @returns {number} globe weight in [0, 1]
 * @example prePassGlobeWeight({viewMode: "globe", zoom: 15}) // 1
 * @example prePassGlobeWeight({viewMode: "flat", zoom: 0}) // 0
 * @example prePassGlobeWeight({viewMode: "auto", zoom: 0}) // 1
 */
function prePassGlobeWeight(s) {
  if (s.viewMode === "globe") return 1;
  if (s.viewMode === "flat") return 0;
  return globeWeight(s.zoom);
}

/**
 * Query (kicks fetches). One map node's descriptor, or null when it has no
 * drawable window this frame. Carries the BASE layer's Mercator tile plan at top
 * level (unchanged shape, so a consumer written before overlays existed keeps
 * working) plus `overlays: {id: {z, tiles}}` for every overlay property the
 * widget has switched on — same window, same crop, each at ITS OWN provider's
 * zoom ceiling (the three shipped overlays cap at 9, independent of the base's
 * own ceiling).
 *
 * `geo` (top level) and `overlays[id].geo` carry the GEOGRAPHIC (EPSG:4326) twin
 * plan for any layer that has one (tile_providers.geographicFor) — `undefined`
 * for OSM/Terrain and for an overlay with no geographic entry, which is exactly
 * the "no such field" shape plugins/demo/globe_map.js already treats as "fall
 * back to this layer's Mercator tiles on the globe".
 *
 * EACH PYRAMID IS ONLY FETCHED WHEN IT CAN ACTUALLY BE DRAWN THIS FRAME: a
 * layer with a geographic twin skips the MERCATOR ensureTile calls entirely
 * when the globe weight is fully 1 (pinned "globe", or auto at a zoom past the
 * crossfade's far edge) — the flat side draws nothing at gw=1 and would
 * otherwise silently keep fetching tiles no pixel ever uses. Symmetrically, the
 * geographic fetch is skipped at gw=0 (pinned "flat", or auto below the near
 * edge). MID-CROSSFADE (0<gw<1) still fetches BOTH, because emit() genuinely
 * draws both there. This is a fetch-cost optimization only: describeMapNode's
 * shape is unchanged either way, an omitted plan is `undefined` exactly like a
 * provider with no twin at all, and emit()'s existing "no field -> Mercator
 * fallback" branch already handles it with no new logic.
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
  const window = mapWorldWindow(s.centerLon, s.centerLat, s.zoom, s.w, s.h);
  const gw = prePassGlobeWeight(s);

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

  const providerGeo = geographicFor(provider);
  // gw===1 with a geographic twin: the flat side draws NOTHING (layerSurfaceOps'
  // own `if (gw < 1)`), so fetching Mercator tiles here would ensureTile() bytes
  // no paint path ever reads. z/tiles still need SOME shape for callers that
  // never got this far into the geo branch (window/cropped below stay Mercator
  // regardless, for interior-nav and the geo window's own crop maths).
  const skipMercator = gw >= 1 && !!providerGeo;
  const { z, tiles } = skipMercator ? { z: 0, tiles: [] } : layerTilePlan(provider, cropped, devicePerWorld, s.w, s.zoom);

  // THE GEOGRAPHIC PLAN, same crop FRACTION applied to the geographic window
  // (mapGeoWorldWindow) instead of the Mercator one — the fraction itself
  // (vis.sourceRect) is projection-agnostic, computed once above and reused here.
  // Symmetric skip: gw===0 means the globe draws nothing, so a provider's
  // geographic twin is left unfetched exactly as the Mercator side is at gw=1.
  const geo = providerGeo && gw > 0
    ? geoLayerTilePlan(
        providerGeo,
        croppedWindow(mapGeoWorldWindow(s.centerLon, s.centerLat, s.zoom, s.w, s.h), vis.sourceRect),
        devicePerWorld, s.w, s.zoom,
      )
    : undefined;

  // OVERLAYS — one tile plan per property the widget has switched on, same
  // window/crop as the base, each at its OWN provider's zoom ceiling. A widget
  // with no overlays on (the common case) does the same work as before this
  // feature existed: an empty object, no extra fetches, no extra tiles.
  //
  // AN OVERLAY'S PYRAMID FOLLOWS THE BASE'S, NOT ITS OWN CAPABILITY: an overlay
  // drawn on the geographic grid while the base draws Mercator (or vice versa)
  // would misalign on the globe — the two pyramids place a given lon/lat at
  // DIFFERENT quad corners (this file's own geoLayerTilePlan vs layerTilePlan),
  // so "labels over satellite" only lines up when both layers read the SAME
  // grid. `providerGeo` (the base's own twin, computed above) gates every
  // overlay's geo branch here, even though an overlay may have its own twin
  // (all three shipped ones do) — an overlay's independent capability is
  // irrelevant when the base it is annotating has none to match.
  const overlays = {};
  for (const id of OVERLAY_IDS) {
    if (!s[overlayPropName(id)]) continue;
    const layer = overlayFor(id);
    const layerGeo = providerGeo ? geographicFor(layer) : null;
    const skipLayerMercator = gw >= 1 && !!layerGeo;
    overlays[id] = {
      ...(skipLayerMercator ? { z: 0, tiles: [] } : layerTilePlan(layer, cropped, devicePerWorld, s.w, s.zoom)),
      attribution: layer.attribution,
      geo: layerGeo && gw > 0
        ? geoLayerTilePlan(
            layerGeo,
            croppedWindow(mapGeoWorldWindow(s.centerLon, s.centerLat, s.zoom, s.w, s.h), vis.sourceRect),
            devicePerWorld, s.w, s.zoom,
          )
        : undefined,
    };
  }

  return { z, tiles, geo, window, cropped, devicePerWorld, provider: provider.id, attribution: provider.attribution, overlays };
}
