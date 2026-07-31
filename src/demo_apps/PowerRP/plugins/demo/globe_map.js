/**
 * GLOBE / MAP — a DEMO WIDGET (plugins/demo/, the showcase folder): a real
 * slippy map of the Earth that renders as a lit GLOBE with an atmosphere at
 * planetary zoom and crossfades to a flat street map as you zoom in, navigable by
 * double-click exactly like the Mandelbrot.
 *
 * The mathematics is in core/geo_tiles.js (Web Mercator + the inverse orthographic
 * sphere), the providers and their licences in web/tile_providers.js, the tile
 * bytes in render_gpu/gpu/tile_registry.js, the depth/crop decision in
 * render_gpu/map_display.js, and the air in
 * render_gpu/skia/atmosphere_shader.js. This file is the WIDGET: what the document
 * stores, what the Inspector shows, how navigation writes back, and how state
 * becomes a display list.
 *
 * ── THE STATE MODEL IS THE WHOLE DESIGN ──────────────────────────────────────
 * `centerLon`, `centerLat`, `zoom` and `style` are ORDINARY PROPERTIES — plain
 * keyframable numbers (and one select), not a transient map camera. That is not a
 * detail; it is what makes every feature below fall out for free:
 *   · A slide-to-slide zoom-in ANIMATES, because the properties tween like any
 *     other numbers. Set a wide view on slide 1 and a city on slide 2 and the
 *     transition flies you there.
 *   · A view is `=`-BINDABLE: `centerLon: "= city.x / 10"` is legal and works,
 *     because equations do not know or care that these numbers mean a place.
 *   · A RELOAD, A CLI RENDER AND A PDF EXPORT ALL AGREE WITH THE SCREEN. An
 *     interior camera held in the editor would make them disagree — the exact
 *     argument web/interiorNav.js makes, applied to a second widget, which is what
 *     proves the interiorView contract was general rather than fractal-shaped.
 * TILE PIXELS ARE NOT DOCUMENT STATE. They are URL-addressed registry content,
 * like an image widget's `src`: fetched async, cached by URL, and ABSENT until
 * they arrive. An absent tile draws the loading affordance and NEVER a stretched
 * neighbour standing in for real data — a plausible-looking map of the wrong place
 * is precisely the decoder lie render_gpu/gpu/missing_media.js exists to refuse.
 * Once tiles are resident, two renders at one document state are byte-identical.
 *
 * ── WHICH KIND OF STATE (the taxonomy, applied) ──────────────────────────────
 * PROPERTY STATE, entirely. There is no clock and no random anywhere on this path:
 * the GIBS imagery date is a PINNED CONSTANT rather than "today" for exactly this
 * reason (web/tile_providers.GIBS_IMAGERY_DATE — reading a clock would make the
 * same document render differently tomorrow, which is the ephemeral state the
 * taxonomy forbids). Δt = 0 leaves this widget bit-identical, trivially, because
 * t never enters it.
 *
 * ── THE GLOBE, AND WHY IT IS QUADS AND NOT A SHADER ──────────────────────────
 * The surface is drawn as `image` ops — one per tile on the flat map, and on the
 * globe a GRID of small quads per tile, each placed by projecting its corners
 * through core/geo_tiles.sphereProject. Subdividing is what turns an axis-aligned
 * image quad into a curved surface: over a small enough patch the sphere is flat,
 * so a fine enough grid of flat quads IS the sphere to within a pixel.
 *
 * The alternative — a bespoke SkSL shader sampling tile textures — was rejected,
 * and the reason is recorded in atmosphere_shader.js's header: the material
 * contract has no child-image mechanism, so it would have meant a framework change
 * for one widget AND re-earning what `image` already provides — PDF/SVG export, the
 * CLI's media-omission count, and image_registry's pendingRefs gate that stops the
 * render-job worker shipping a frame with tiles still in flight. The ATMOSPHERE is
 * a material because it is pure math over the disc with no texture at all.
 *
 * ONE OF THOSE INHERITED GUARANTEES TURNED OUT TO HAVE A HOLE, and it is worth
 * stating precisely rather than leaving the claim above to over-promise. The CLI's
 * warning counts EMITTED media ops — but a map that fetched no tiles emits none, so
 * the count is 0 and the warning never fires, while the map still draws no surface.
 * `tilePlan` therefore reports that condition itself; see the reportOnce there.
 *
 * DOM-free / bare-node-safe at import: it imports only pure core modules and the
 * IR builders. The tile REGISTRY is reached exclusively through the render context
 * (the pre-pass's descriptor), never imported here — which is what keeps this file
 * loadable in the bare-node test lane.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { reportOnce } from "../../core/report.js";
import { CUSTOM_CATEGORY, bundle, customProps, defaults, props } from "../../core/properties.js";
import {
  GLOBE_FLAT_CROSSOVER, MAX_MERCATOR_LAT, clampLat, discCoverageFraction, geoTileNorthWest,
  geoTileZoomFor, geoTilesForWindow, globeSubdivisionsFor, globeWeight, lonLatToWorld, mapGeoWorldWindow,
  mapWorldWindow, parseLatLon, sphereProject, tileNorthWest, tileZoomFor, tilesForWindow, worldToLonLat,
  wrapLon,
} from "../../core/geo_tiles.js";
import {
  DEFAULT_TILE_STYLE, OVERLAY_IDS, TILE_OVERLAYS, TILE_PROVIDERS, TILE_PROVIDER_IDS,
  geographicFor, overlayFor, overlayPropName, providerFor,
} from "../../web/tile_providers.js";
import { ATMOSPHERE_FILL_PARAMS } from "../../render_gpu/skia/atmosphere_shader.js";
import { image, materialFill, polygon, rect, text } from "../../render_gpu/ir.js";

/**
 * How many quads each tile is split into per axis when drawn on the GLOBE — NO
 * LONGER A FIXED CONSTANT. `core/geo_tiles.globeSubdivisionsFor` reads the
 * globe's actual ON-SCREEN radius (device px) and scales quad density with it,
 * the CesiumJS screen-space-error principle applied without a patch quadtree
 * (see that function's docblock and the RESEARCH section atop core/geo_tiles.js).
 *
 * WHY THIS REPLACED A FIXED 16: a fixed count is right at exactly one on-screen
 * size and wrong everywhere else. At the size it was tuned for (a ~200px-radius
 * globe) 16 hides the facets; at presentation size (900px+) it visibly facets —
 * the faceted, "coerced-2D" look the user's critique points at is 16 subdivisions
 * stretched over 4-8x the pixels it was measured against. The curvature argument
 * for a FLOOR still holds at any size: even the smallest globe needs >= 4 quads
 * per edge or a single facet is a large enough fraction of the diameter to read
 * as a flat polygon regardless of pixel count (GLOBE_SUBDIVISIONS_MIN in
 * geo_tiles.js). What is NEW is the ceiling growing with size instead of staying
 * fixed, and the reason a fixed ceiling was wrong to begin with: quad loss at the
 * limb (globeQuadRect) scales with a quad's OWN angular size, and a quad's own
 * angular size is tile-arc/subdivisions — so more subdivisions narrows the limb
 * loss the same way at any globe size, but a bigger globe needs more of them to
 * reach the SAME angular quad size in the first place.
 */
function globeSubdivisions(s, devicePerWorld) {
  const radiusPx = (Math.min(s.w, s.h) / 2) * devicePerWorld;
  return globeSubdivisionsFor(radiusPx);
}

/** The tile-grid resolution used when NO render context is present (export,
 *  thumbnails, the CLI). The camera is unknown there, so `devicePerWorld` is 1 and
 *  the widget's own zoom alone picks the depth — a correct, camera-independent
 *  picture of the same place. See the emit() fallback. */
const FALLBACK_DEVICE_PER_WORLD = 1;

/**
 * Pure function. The widget's own geographic window, from its stored properties.
 * The `interiorView.window` a navigator pans and zooms, in NORMALIZED WORLD units
 * (not degrees — latitude is not linear in degrees under Mercator, so a window in
 * degrees would distort the moment it spanned any real latitude range).
 *
 * @param {object} s - folded item state
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example globeMapPlugin.interiorView.window({centerLon: 0, centerLat: 0, zoom: 0, w: 256, h: 256}) // {x: 0, y: 0, w: 1, h: 1}
 * @example globeMapPlugin.interiorView.window({centerLon: 0, centerLat: 0, zoom: 1, w: 256, h: 256}) // {x: 0.25, y: 0.25, w: 0.5, h: 0.5}
 */
function mapWindow(s) {
  return mapWorldWindow(s.centerLon ?? 0, s.centerLat ?? 0, s.zoom ?? 0, s.w || 1, s.h || 1);
}

/**
 * Pure function. A new interior window → the property writes that store it. The
 * inverse of mapWindow: the window's CENTRE becomes centerLon/centerLat and its
 * WIDTH becomes the zoom.
 *
 * Longitude WRAPS and latitude CLAMPS (core/geo_tiles), so panning east past the
 * date line continues around the world while panning north stops at the Mercator
 * limit instead of producing a window off the top of a finite map.
 *
 * @param {object} s - folded item state (for the box size)
 * @param {{x: number, y: number, w: number, h: number}} win - the new window, normalized world units
 * @returns {object} a flat {stateKey: value} map of keyframable leaves
 *
 * @example globeMapPlugin.interiorView.writes({w: 256, h: 256, zoom: 0}, {x: 0.25, y: 0.25, w: 0.5, h: 0.5}) // {zoom: 1, centerLon: 0, centerLat: 0} (zoomed one level onto null island)
 * @example globeMapPlugin.interiorView.writes({w: 256, h: 256, zoom: 0}, {x: 0, y: 0, w: 1, h: 1}) // {zoom: 0, centerLon: 0, centerLat: 0} (the whole world)
 */
function mapWrites(s, win) {
  const centre = worldToLonLat(win.x + win.w / 2, win.y + win.h / 2);
  // The window's width in normalized units is boxW / (TILE_SIZE·2^zoom), so the
  // zoom that produced it is log2(boxW / (TILE_SIZE·width)) — mapWorldWindow read
  // backwards, which is what keeps the round trip exact.
  const zoom = Math.log2((s.w || 1) / (256 * Math.max(1e-12, win.w)));
  return {
    zoom: Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, zoom)),
    centerLon: wrapLon(centre.lon),
    centerLat: clampLat(centre.lat),
  };
}

/** The zoom floor. 0 is "the whole world in one tile"; going below it just shrinks
 *  the planet inside the box, which the globe rendering already does gracefully,
 *  so a modest negative floor lets a globe sit small in a large box. */
const MIN_MAP_ZOOM = -2;

/** The zoom ceiling ACROSS ALL PROVIDERS — a stored value, not a fetch limit. Tile
 *  requests are separately clamped to each provider's own maxZoom (tileZoomFor), so
 *  this only bounds how far the PROPERTY may be driven; past a provider's ceiling
 *  the deepest tiles are magnified, which is what every slippy map does. 22 is
 *  about 3 cm/px at the equator: past it the numbers stop meaning anything. */
const MAX_MAP_ZOOM = 22;

// The widget's knobs. The PLACE is three plain numbers + a select; the AIR is the
// atmosphere material's own schema, spread in so there is ONE declaration of those
// seven knobs (the material framework's single-declaration rule) rather than a
// copy here that could drift from the shader's packer.
const CUSTOM = customProps([
  { name: "centerLon", kind: "number", default: 8, min: -180, max: 180, step: 0.0001, label: "Longitude",
    help: "Longitude of the view centre, in degrees east. WRAPS at the date line, so panning east past 180 continues from -180. A plain number: keyframe it, tween it, or bind it to an equation." },
  { name: "centerLat", kind: "number", default: 24, min: -MAX_MERCATOR_LAT, max: MAX_MERCATOR_LAT, step: 0.0001, label: "Latitude",
    help: `Latitude of the view centre, in degrees north. CLAMPED to +-${MAX_MERCATOR_LAT.toFixed(2)}, the latitude where Web Mercator cuts off — that cut is what makes the tile pyramid a square grid, so the poles are not on the flat map at all. The GLOBE does show them.` },
  { name: "zoom", kind: "number", default: 0.6, min: MIN_MAP_ZOOM, max: MAX_MAP_ZOOM, step: 0.01, label: "Zoom",
    help: `The slippy-map zoom: 0 is the whole world, and each unit DOUBLES the scale (about 11 degrees of longitude at 5, a city block at 17). TWEEN THIS for a fly-in — it is the one property a zoom animation should touch. The globe crossfades to the flat map around ${GLOBE_FLAT_CROSSOVER}. Tiles are fetched at whatever depth the CAMERA justifies, so zooming the canvas into the widget sharpens it further without touching this.` },
  { name: "style", kind: "select", default: DEFAULT_TILE_STYLE, options: TILE_PROVIDER_IDS,
    optionLabels: Object.fromEntries(TILE_PROVIDER_IDS.map((id) => [id, TILE_PROVIDERS[id].title])), label: "Basemap",
    help: "Which tile provider draws the surface. Streets is OpenStreetMap (deepest zoom, good at every scale); Satellite is NASA's MODIS true-colour mosaic (beautiful on the globe, but a ~250 m/px instrument, so it stops getting sharper around zoom 9); Terrain is OpenTopoMap's relief and contours. Attribution is drawn only when Show attribution is on (off by default). NOTE ON SATELLITE: the MODIS mosaic is assembled from ONE DAY of polar orbits, so it carries BLACK WEDGES where the satellite's swaths did not overlap — most visible near the equator. Those gaps are in NASA's data, not in the rendering (verified by downloading the raw tile), and they are the honest picture of what was actually imaged. Use Streets or Terrain for a deck that needs unbroken coverage. POLES ON THE GLOBE: Satellite samples NASA's separate geographic tile pyramid there, so its poles are REAL imagery, all the way to 90°. Streets and Terrain have no such pyramid to draw from, so their globe still shows a shaded ice cap past 85.05° — the honest gap those two providers genuinely have." },
  // ONE BOOLEAN PER OVERLAY (web/tile_providers.TILE_OVERLAYS) — transparent
  // reference layers composited ABOVE the base, the Google "hybrid" look. Each is
  // an ordinary tweenable/equation-bindable property, same as `style`, rendered
  // through the SAME tile registry/compositor as the base (emit()'s layer 2b).
  // Declared as `overlay<Id>` (overlayLabels/overlayFeatures/overlayCoastlines)
  // rather than a single list property: a fixed, small, named set reads better as
  // named booleans in the Inspector than as list rows, and it is what lets the
  // popup mirror each one as its own quick-switch button (globe_map.js's
  // floatingToolbar) through the exact same stored key `toggleWrites` writes.
  ...OVERLAY_IDS.map((id) => ({
    name: overlayPropName(id), kind: "boolean", default: false, label: TILE_OVERLAYS[id].title,
    help: TILE_OVERLAYS[id].help,
  })),
  { name: "viewMode", kind: "select", default: "auto", options: ["auto", "globe", "flat"],
    optionLabels: { auto: "Auto (zoom crossfade)", globe: "Globe", flat: "Flat" }, label: "View mode",
    help: `Pins the globe/flat crossfade instead of letting zoom decide it. "Auto" is the shipped zoom-threshold crossfade (globeWeight — a globe below zoom ${GLOBE_FLAT_CROSSOVER}, flat above it) and stays the default; "Globe" pins the sphere rendering at ANY zoom (a full-frame city on a curved globe, if that is the look you want); "Flat" pins the mercator rectangle at any zoom, including the whole world. The underlying blend is CONTINUOUS either way — this only selects/pins where on that blend the render sits, so a slide tween from "Globe" to "Flat" (or across a zoom range in "Auto") animates the unroll rather than popping.` },
  ...ATMOSPHERE_FILL_PARAMS,
  { name: "attributionColor", kind: "color", default: "rgba(255,255,255,0.82)", label: "Attribution colour",
    help: "Ink of the provider credit. It is a knob because legibility is the point: white reads over satellite imagery and the dark globe, but a light street map at street zoom needs a dark value. An unreadable credit does not satisfy the licence it exists for." },
  { name: "showAttribution", kind: "boolean", default: false, label: "Show attribution",
    help: "OFF by default everywhere (user ruling). Turning it on draws the credit line(s) for every ACTIVE layer, tiny, in the corner. OSM/OpenTopoMap's tile terms ask for that credit when their tiles are used; showing it is your call — the switch never re-locks itself when you change the basemap." },
]);

/** The attribution's type size and inset, in world px. Small enough to stay out of
 *  the way, large enough to be legible at presentation scale — a credit nobody can
 *  read does not satisfy a licence. */
const ATTRIBUTION_SIZE = 11;
const ATTRIBUTION_INSET = 6;

/**
 * Pure function. The DEVICE-PER-WORLD factor a render context implies, or the
 * camera-free fallback when there is none. The ONE place emit() decides whether it
 * is drawing for a live view or for an export.
 *
 * @param {object|null} ctx - sceneIR's 4th-arg render context
 * @returns {number}
 *
 * @example devicePerWorldOf(null) // 1 (no camera: the export/CLI fallback)
 * @example devicePerWorldOf({mapTiles: {devicePerWorld: 4}}) // 4
 */
function devicePerWorldOf(ctx) {
  return ctx?.mapTiles?.devicePerWorld ?? FALLBACK_DEVICE_PER_WORLD;
}

/**
 * Pure function. THE GLOBE WEIGHT `viewMode` ACTUALLY RENDERS AT — `globeWeight`
 * pinned to an endpoint when the property asks for one, else passed straight
 * through. "auto" (the default) is the shipped zoom-threshold crossfade,
 * unchanged. "globe"/"flat" PIN the number rather than special-casing the
 * renderer: emit() and every helper below it (globeTileOps, polarCapOps, the
 * flat-tile loop) already branch on `gw` alone, so pinning it to 1 or 0 reuses
 * every one of those branches exactly as the crossfade does mid-transition —
 * there is no second code path to keep in sync. This is also what makes a slide
 * tween from `viewMode: "globe"` to `viewMode: "flat"` animate the unroll:
 * `viewMode` is a SELECT (a discrete keyframe, switching at alpha > 0 per the
 * document model), but the surface it feeds is the same continuous blend, so a
 * timeline that tweens `zoom` across a `viewMode` switch still crossfades smoothly
 * through whatever `gw` the switched-to mode pins.
 *
 * @param {object} s - folded state
 * @returns {number} globe weight in [0, 1]
 *
 * @example effectiveGlobeWeight({viewMode: "auto", zoom: 0}) // 1 (auto at planetary zoom: all globe)
 * @example effectiveGlobeWeight({viewMode: "auto", zoom: 15}) // 0 (auto at street zoom: all flat)
 * @example effectiveGlobeWeight({viewMode: "globe", zoom: 15}) // 1 (pinned to a sphere even at street zoom)
 * @example effectiveGlobeWeight({viewMode: "flat", zoom: 0}) // 0 (pinned to the flat rectangle even for the whole world)
 * @example effectiveGlobeWeight({viewMode: undefined, zoom: 0}) // 1 (undeclared reads as "auto" — an old document without this property)
 */
function effectiveGlobeWeight(s) {
  if (s.viewMode === "globe") return 1;
  if (s.viewMode === "flat") return 0;
  return globeWeight(s.zoom);
}

/**
 * Pure function. The tile list emit() should draw: the pre-pass's list when a live
 * view supplied one, else a camera-free list computed from the widget's own state.
 *
 * THE FALLBACK IS NOT A DEGRADED PATH, it is the export path — a correct picture of
 * the same place at the widget's own zoom, identical on every machine, which is
 * exactly what a PDF export and a headless still must be.
 *
 * @param {object} s - folded item state
 * @param {object|null} ctx - the render context
 * @returns {{z: number, tiles: object[], window: object}}
 */
function tilePlan(s, ctx) {
  const supplied = ctx?.mapTiles;
  if (supplied?.tiles) return supplied;
  const provider = providerFor(s.style);
  const window = mapWindow(s);
  const z = tileZoomFor(s.zoom, s.w, FALLBACK_DEVICE_PER_WORLD, provider.maxZoom);
  // THE WIDGET ANNOUNCES ITS OWN OMISSION, because nothing else can. cli/render.js
  // counts MEDIA OPS to warn that a bare-node PNG has holes where images belong —
  // but a map with no fetched tiles emits ZERO image ops, so that count is 0 and the
  // warning never fires. The map would then render as bare space plus attribution
  // and exit 0: precisely the "holed picture while exiting 0" that file's header
  // exists to prevent, just arriving through a gap in how it measures. Reported ONCE
  // per style/zoom (reportOnce), so a 900-frame render says it once rather than 900
  // times, and it names the renderer that CAN draw it.
  reportOnce(
    `globe_map-no-tiles:${provider.id}:${z}`,
    `PowerRP globe_map: no map tiles are available to this renderer, so the map draws its background, polar caps and attribution but NO SURFACE at zoom ${z} of "${provider.id}". This is expected in bare node (cli/render.js has no image decoder) and in any consumer that runs no tile pre-pass; it is NOT what the editor shows. For a faithful render use cli/render_job.js, which draws it in a real headless browser.`,
  );
  // No registry reachable from a DOM-free plugin, so refs are left null and every
  // tile reports not-ready: a camera-free consumer that has not run the pre-pass
  // draws the ocean base and the graticule, which is the honest picture of "no
  // pixels were fetched" rather than a blank rectangle.
  //
  // THE GEOGRAPHIC FALLBACK — same camera-free honesty, over the 4326 grid when
  // this provider has one. Export/thumbnails/the CLI get a correct globe-side
  // picture at the widget's own zoom even with no pre-pass, exactly as the
  // Mercator fallback above already does for the flat map.
  const geoWindow = mapGeoWorldWindow(s.centerLon, s.centerLat, s.zoom, s.w, s.h);
  const providerGeo = geographicFor(provider);
  const geo = fallbackGeoPlan(providerGeo, geoWindow, s);

  // AN OVERLAY'S PYRAMID FOLLOWS THE BASE'S — see map_display.js's own note on
  // this same rule for the live-view path. `providerGeo` gates every overlay's
  // geo branch here too, so the camera-free fallback can never draw a
  // geographic overlay over a Mercator base (or vice versa).
  const overlays = {};
  for (const id of OVERLAY_IDS) {
    if (!s[overlayPropName(id)]) continue;
    const layer = overlayFor(id);
    const oz = tileZoomFor(s.zoom, s.w, FALLBACK_DEVICE_PER_WORLD, layer.maxZoom);
    overlays[id] = {
      z: oz, tiles: tilesForWindow(window, oz).map((t) => ({ ...t, ref: null, ready: false })),
      geo: providerGeo ? fallbackGeoPlan(geographicFor(layer), geoWindow, s) : undefined,
    };
  }
  return {
    z, window, cropped: window, overlays, geo,
    tiles: tilesForWindow(window, z).map((t) => ({ ...t, ref: null, ready: false })),
  };
}

/**
 * Pure function. The camera-free GEOGRAPHIC tile plan for one layer, or
 * undefined when that layer has no geographic twin — the fallback-path helper
 * shared by tilePlan's base call and its per-overlay loop, so the same
 * "no registry, no pre-pass, ref left null" honesty (this function's caller
 * docblock) is written once rather than twice.
 *
 * @param {object|null} geo - geographicFor(provider) or geographicFor(overlay)
 * @param {{x: number, y: number, w: number, h: number}} geoWindow - mapGeoWorldWindow's output
 * @param {object} s - folded item state (for zoom/w)
 * @returns {{z: number, window: object, tiles: object[]}|undefined}
 */
function fallbackGeoPlan(geo, geoWindow, s) {
  if (!geo) return undefined;
  const z = geoTileZoomFor(s.zoom, s.w, FALLBACK_DEVICE_PER_WORLD, geo.maxZoom);
  return { z, window: geoWindow, tiles: geoTilesForWindow(geoWindow, z).map((t) => ({ ...t, ref: null, ready: false })) };
}

/**
 * Pure function. One tile's placement on the FLAT map: its rect in the widget's
 * local px, from the tile's own world-normalized extent and the window on screen.
 *
 * @param {{x: number, y: number, z: number, wrapped: number}} tile
 * @param {{x: number, y: number, w: number, h: number}} window - the widget's window
 * @param {number} w - box width
 * @param {number} h - box height
 * @returns {{x: number, y: number, w: number, h: number}} local px
 *
 * @example flatTileRect({x: 0, y: 0, z: 0, wrapped: 0}, {x: 0, y: 0, w: 1, h: 1}, 256, 256) // {x: 0, y: 0, w: 256, h: 256}
 * @example flatTileRect({x: 1, y: 0, z: 1, wrapped: 0}, {x: 0, y: 0, w: 1, h: 1}, 256, 256) // {x: 128, y: 0, w: 128, h: 128}
 */
export function flatTileRect(tile, window, w, h) {
  const n = Math.pow(2, tile.z);
  const size = 1 / n;
  const wx = (tile.x + tile.wrapped * n) * size;
  const wy = tile.y * size;
  return {
    x: ((wx - window.x) / window.w) * w,
    y: ((wy - window.y) / window.h) * h,
    w: (size / window.w) * w,
    h: (size / window.h) * h,
  };
}

/**
 * Pure function. The GLOBE placement of one sub-quad of a tile: the local-px rect
 * bounding the quad's four projected corners, plus a COVERAGE FRACTION in [0, 1]
 * (not a boolean) saying how much of that quad the shader-quality limb feather
 * (core/geo_tiles.discCoverageFraction) says should actually be drawn.
 *
 * A quad is drawn as an axis-aligned `image` with the tile's matching sub-rect, so
 * the curvature is carried by the GRID of quads rather than by any one of them —
 * see globeSubdivisions for how many are used at the globe's current on-screen size.
 *
 * ── COVERAGE, NOT A HARD CULL: THE FIX FOR THE FACETED SILHOUETTE ────────────
 * This used to return a BOOLEAN `visible`, all-or-nothing per quad. That is
 * precisely a one-quad-wide staircase at the limb — every dropped quad leaves a
 * hard straight edge where its neighbour is still fully opaque, which is the
 * "cookie-cutter"/faceted look the user's critique points at (visible in the
 * baseline screenshot's ragged colour-block edge). The fix keeps the same
 * corner-projection geometry but converts the `cosC` (angular-distance cosine)
 * the four corners span into a coverage fraction via the closed form in
 * discCoverageFraction: a quad whose corners straddle the true limb (cosC = 0)
 * gets a FRACTIONAL opacity proportional to how much of its own angular extent
 * is actually on the visible hemisphere, instead of being fully drawn or fully
 * dropped. globeTileOps multiplies this into the quad's opacity, so the very
 * last ring of quads at the limb feathers smoothly rather than snapping off.
 * This is the ANALYTIC antialiasing this file's header describes — no `fwidth`,
 * because `cosC` is already known exactly at the quad's own four corners.
 *
 * WHY cosC AND NOT rho (a correction — this fix's first draft used rho and was
 * WRONG): see discCoverageFraction's own docblock for the full derivation. In
 * short, rho = hypot(u, v) looks like the natural feather variable but is not a
 * reliable per-corner limb signal — the back hemisphere's near-limb geometry can
 * project to a SMALLER rho than the front hemisphere's true limb, which a rho-
 * only feather cannot tell apart from a legitimate straddle. cosC is the
 * geometrically correct, monotonic signal (sphereProject's `visible` is exactly
 * `cosC >= 0`), and it has the same exact linearity property near its own
 * boundary that made rho attractive in the first place.
 *
 * ── THE BALLOONING-BOX GUARD STILL APPLIES, UNCHANGED IN INTENT ──────────────
 * A quad whose bounding BOX escapes the disc by more than a hair is still
 * rejected outright (coverage forced to 0), for the reason recorded here before:
 * because the quad is drawn as an axis-aligned rect bounding rotated corners, a
 * quad with one corner round the back can bound a box that BALLOONS across most
 * of the planet — a real bug this codebase hit and fixed (see the git history
 * this docblock used to carry in full; .claude_logs/globemap shows the artifact).
 * The box test catches that; the coverage fraction below is an independent,
 * additional refinement for the ORDINARY case of a quad legitimately straddling
 * the limb, which the box test alone always treated as a hard yes/no.
 *
 * @param {object} corners - {lon0, lat0, lon1, lat1} the quad's geographic extent
 * @param {object} s - state (centerLon, centerLat, w, h)
 * @returns {{x: number, y: number, w: number, h: number, coverage: number}} local px + [0,1] opacity weight
 *
 * Exported (alongside flatTileRect) so the limb feather is directly testable
 * against a chosen quad without reconstructing a whole tile plan.
 */
export function globeQuadRect(corners, s) {
  const r = Math.min(s.w, s.h) / 2;
  const cx = s.w / 2, cy = s.h / 2;
  const pts = [
    sphereProject(corners.lon0, corners.lat0, s.centerLon, s.centerLat),
    sphereProject(corners.lon1, corners.lat0, s.centerLon, s.centerLat),
    sphereProject(corners.lon0, corners.lat1, s.centerLon, s.centerLat),
    sphereProject(corners.lon1, corners.lat1, s.centerLon, s.centerLat),
  ];
  // Screen y is DOWN while the projection's v is NORTH-positive, so v is negated
  // here — the one place that flip happens (core/geo_tiles states the convention).
  const xs = pts.map((p) => cx + p.u * r), ys = pts.map((p) => cy - p.v * r);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  // THE TEST IS ON THE BOX, NOT ON THE FOUR PROJECTED POINTS, and the difference is
  // the whole bug. What gets DRAWN is the axis-aligned rect [x0,x1]x[y0,y1]; its
  // corners are combinations like (min x, min y) that need not be any projected
  // point at all, and near the limb one of those combinations lands outside the disc
  // even when all four sphere points are safely inside it. Checking the points would
  // pass while ink still escaped — measured: a quad whose corners were all on the
  // sphere still bounded a box reaching (148, 4) on a disc of radius 200.
  //
  // THE BALLOONING GUARD IS UNCHANGED — still the exact strict sub-pixel bound
  // this file's history fought to keep strict (see the paragraph above): a box
  // that escapes the disc by more than DISC_EPSILON_PX is rejected OUTRIGHT,
  // coverage forced to 0, full stop. Loosening this guard to "let the feather
  // see straddling quads" was tried and reverted — it also re-admitted quads
  // whose box balloons for an UNRELATED reason (a wide-longitude quad near a
  // pole, where u is non-monotonic in longitude, produces the same kind of
  // escaping box as the recorded back-of-sphere ballooning, and the two are not
  // distinguishable from the box alone). The box test is therefore left exactly
  // as strict as it always was; the feather below reads the CORNERS' OWN cosC
  // values instead, which are meaningful even when the box would be rejected —
  // discCoverageFraction's docblock explains why cosC (not rho) is the correct
  // per-corner signal.
  const boxInsideDisc = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
    .every(([x, y]) => Math.hypot(x - cx, y - cy) <= r + DISC_EPSILON_PX);
  // NO PRE-FILTER ON `visible` HERE — that boolean IS the thing being replaced.
  // A quad gets a coverage fraction from the corners' cosC band whenever the box
  // itself did not balloon; a ballooned box's corner values are meaningless as a
  // feather signal regardless of cosC (the wide-longitude polar case above), so
  // that case alone is dropped outright rather than fed into the feather.
  const cosCs = pts.map((p) => p.cosC);
  const coverage = boxInsideDisc ? discCoverageFraction(Math.min(...cosCs), Math.max(...cosCs)) : 0;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, coverage };
}

/** Slack on the disc containment test, in local px. A corner ON the limb is
 *  exactly at radius r and floating-point rounding can put it a hair outside; a
 *  sub-pixel tolerance keeps those legitimate quads without admitting the
 *  ballooned boxes the test exists to reject (those overshoot by many px). */
const DISC_EPSILON_PX = 0.5;

/** The polar caps' colour. Both of Earth's caps are ice, so one value is right for
 *  both; it is slightly blue-grey rather than white so it reads as ice under the
 *  atmosphere's tint instead of as a blown highlight. */
const POLAR_CAP_COLOR = "#dfe8f2";

/**
 * Pure function. Filled polygons covering the two POLAR CAPS the Mercator tile
 * pyramid cannot reach — the region poleward of ±MAX_MERCATOR_LAT — shaded as a
 * ring stack so the cap reads as CONTINUING CURVATURE rather than a flat sticker.
 *
 * ── ONLY CALLED FOR A PROVIDER WITH NO GEOGRAPHIC TWIN ───────────────────────
 * NASA GIBS also serves true GEOGRAPHIC (EPSG:4326) tiles that cover the poles
 * (this file's header, "POLES: MERCATOR'S CUT vs GIBS GEOGRAPHIC TILES") and the
 * satellite provider now samples them on the globe path (web/tile_providers.js's
 * `geographic` field, geoTileNorthWest in globeTileOps) — REAL pixels reach the
 * pole there, so emit() skips this function entirely for that provider (its own
 * call site gates on `!geographicFor(provider)`). This function still exists,
 * unchanged, for OSM and Terrain: neither has a EPSG:4326 service (no such
 * service exists to point at — web/tile_providers.js's own note on each), so
 * their globe path keeps sampling Mercator tiles and genuinely has no data
 * poleward of ±MAX_MERCATOR_LAT. What follows is that provider's honest
 * PRESENTATION of the gap: a single flat-colour disc reads as a hole plugged
 * with a sticker — visibly flat against a sphere whose every other pixel is
 * doing real orthographic shading. A single fill colour cannot be a gradient
 * here without threading the polygon op through the gradient-paint machinery
 * (parsePaint's radial branch) for a widget-specific one-off, so instead the
 * SAME shading law the atmosphere shader already applies to the ground (limb
 * darkening from the orthographic normal, nz = sqrt(1-r²)) is approximated by
 * drawing the cap as CONCENTRIC RINGS, each one ring's-worth darker toward the
 * pole — the same idea as a computer-graphics ramp texture, built from polygons
 * this renderer's three backends (Skia/PDF/SVG) already draw identically, so no
 * new exporter code is needed anywhere.
 *
 * Each ring is the area between two parallels at the cut latitude and a slightly
 * higher one, projected through the same orthographic map the tiles use, so the
 * OUTERMOST ring meets the topmost tile row exactly at the seam with no gap and
 * no overlap — unchanged from the original single-polygon cap. A cap facing away
 * from the viewer projects no visible points and is skipped.
 *
 * @param {object} s - folded state (centerLon, centerLat, w, h)
 * @param {number} opacity - the globe's crossfade weight
 * @returns {object[]} polygon ops (0 to 2*POLAR_CAP_RINGS)
 */
function polarCapOps(s, opacity) {
  const r = Math.min(s.w, s.h) / 2;
  const cx = s.w / 2, cy = s.h / 2;
  const ops = [];
  for (const sign of [1, -1]) {
    for (let ring = 0; ring < POLAR_CAP_RINGS; ring++) {
      // Ring k spans the parallel at t=k/N to t=(k+1)/N, where t=0 is the cut
      // latitude (equator-ward edge, seamed to the tiles) and t=1 is the pole.
      const t0 = ring / POLAR_CAP_RINGS, t1 = (ring + 1) / POLAR_CAP_RINGS;
      const lat0 = sign * (MAX_MERCATOR_LAT + (90 - MAX_MERCATOR_LAT) * t0);
      const lat1 = sign * (MAX_MERCATOR_LAT + (90 - MAX_MERCATOR_LAT) * t1);
      const points = [];
      for (let i = 0; i <= POLAR_CAP_SEGMENTS; i++) {
        const lon = -180 + (360 * i) / POLAR_CAP_SEGMENTS;
        const p = sphereProject(lon, lat0, s.centerLon, s.centerLat);
        if (p.visible) points.push([cx + p.u * r, cy - p.v * r]);
      }
      // The pole-ward edge collapses toward a single point as t1 -> 1; walking it
      // in REVERSE closes the ring into one simple polygon instead of two fans.
      for (let i = POLAR_CAP_SEGMENTS; i >= 0; i--) {
        const lon = -180 + (360 * i) / POLAR_CAP_SEGMENTS;
        const p = sphereProject(lon, lat1, s.centerLon, s.centerLat);
        if (p.visible) points.push([cx + p.u * r, cy - p.v * r]);
      }
      // Under three points there is no polygon to fill — the ring is entirely
      // round the back, which is the ordinary case for whichever pole faces away.
      if (points.length < 3) continue;
      // Darken toward the pole by the SAME nz-style falloff the atmosphere uses
      // for limb darkening on the rest of the sphere, so the cap's own shading
      // law matches the ground it is seamed to instead of introducing a new one.
      const shade = 1 - POLAR_CAP_DARKEN * ((t0 + t1) / 2);
      ops.push(polygon({ points, fill: shadeHexColor(POLAR_CAP_COLOR, shade), opacity }));
    }
  }
  return ops;
}

/** How many concentric rings approximate the cap's shading gradient. 6 is enough
 *  that adjacent rings' colour step is imperceptible as banding at any globe size
 *  this widget draws (checked at both the thumbnail and presentation sizes in
 *  .claude_logs/globequal) while adding only 12 polygon ops worst case (both
 *  poles visible) — negligible next to a tile's own subdivision count. */
const POLAR_CAP_RINGS = 6;

/** How much the cap darkens from its equator-ward edge (shade=1, matching the
 *  seamed tile row exactly) to the pole itself (shade = 1-this). 0.35 mirrors the
 *  atmosphere's own default limbDarken (atmosphere_shader.ATMOSPHERE_FILL_PARAMS)
 *  so the cap's falloff visually matches the sphere it is drawn on rather than
 *  inventing an unrelated constant. */
const POLAR_CAP_DARKEN = 0.35;

/**
 * Pure function. Multiplies a "#rrggbb" hex colour's RGB channels by `shade`,
 * clamped to a valid byte per channel. Used to approximate the cap's toward-pole
 * darkening with plain solid-fill polygons (see polarCapOps) rather than
 * threading a one-off radial gradient through the paint pipeline.
 *
 * @param {string} hex - "#rrggbb"
 * @param {number} shade - multiplier, typically in (0, 1]
 * @returns {string} "#rrggbb"
 *
 * @example shadeHexColor("#dfe8f2", 1) // "#dfe8f2" (no change at full shade)
 * @example shadeHexColor("#dfe8f2", 0.5) // "#707479" (halfway to black)
 * @example shadeHexColor("#ffffff", 0.65) // "#a6a6a6" (the pole-most ring at the default darken amount)
 */
function shadeHexColor(hex, shade) {
  const n = parseInt(hex.slice(1), 16);
  const chan = (byte) => Math.max(0, Math.min(255, Math.round(byte * shade))).toString(16).padStart(2, "0");
  return `#${chan((n >> 16) & 0xff)}${chan((n >> 8) & 0xff)}${chan(n & 0xff)}`;
}

/** How finely the cut-latitude ring is sampled when building a polar cap. 48
 *  segments put a vertex every 7.5° of longitude, which on a 400-px globe is well
 *  under a pixel of chord error at the cap's radius. */
const POLAR_CAP_SEGMENTS = 48;

/**
 * Pure function. The image ops for one tile drawn on the GLOBE: an adaptive
 * subdivisions² grid of quads (globeSubdivisions — scales with the globe's
 * on-screen size, see its docblock), each carrying its own sub-rect of the tile
 * texture, back-face-culled and FEATHERED at the limb by its coverage fraction.
 *
 * `cornerFn` is the ONE thing that differs between a Mercator tile and a
 * geographic (EPSG:4326) one — tileNorthWest for the former, geoTileNorthWest
 * for the latter (geoGlobeTileOps below passes it in). Everything past that
 * corner lookup — the subdivision grid, the per-quad projection, the coverage
 * feather, the sub-rect placement — is IDENTICAL for both pyramids: a quad is a
 * quad once its four corners are known in lon/lat, regardless of which grid
 * produced them. Factoring the lookup out is what keeps this the ONE emitter
 * rather than a byte-for-byte fork with one changed line.
 *
 * @param {object} tile - {x, y, z, ref}
 * @param {object} s - folded state
 * @param {number} opacity - the globe's crossfade weight
 * @param {number} devicePerWorld - camera device px per world unit, for adaptive subdivision
 * @param {(x: number, y: number, z: number) => {lon: number, lat: number}} [cornerFn] - a tile corner's lon/lat; defaults to the Mercator lookup
 * @returns {object[]} image ops
 */
function globeTileOps(tile, s, opacity, devicePerWorld, cornerFn = tileNorthWest) {
  if (!tile.ref || !tile.ready) return [];
  const nw = cornerFn(tile.x, tile.y, tile.z);
  const se = cornerFn(tile.x + 1, tile.y + 1, tile.z);
  const n = globeSubdivisions(s, devicePerWorld);
  const ops = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const f0 = ix / n, f1 = (ix + 1) / n;
      const g0 = iy / n, g1 = (iy + 1) / n;
      const rect = globeQuadRect({
        lon0: nw.lon + (se.lon - nw.lon) * f0, lon1: nw.lon + (se.lon - nw.lon) * f1,
        lat0: nw.lat + (se.lat - nw.lat) * g0, lat1: nw.lat + (se.lat - nw.lat) * g1,
      }, s);
      // COVERAGE, NOT A BOOLEAN: the quad's opacity is weighted by how much of its
      // own footprint the analytic limb feather says is actually inside the disc
      // (globeQuadRect's docblock) — this is what turns the old hard-edged cutoff
      // into a smooth falloff at the silhouette.
      if (!(rect.coverage > 0) || !(rect.w > 0) || !(rect.h > 0)) continue;
      ops.push(image({
        ref: tile.ref, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        sx: f0, sy: g0, sw: f1 - f0, sh: g1 - g0,
        opacity: opacity * rect.coverage, sampling: "bilinear",
      }));
    }
  }
  return ops;
}

/**
 * Pure function. THE SURFACE OPS for ONE LAYER — base or overlay, they are the
 * same shape ({z, tiles, window[, geo]}) and get IDENTICAL treatment: flat
 * `image` ops below the crossfade weight (always from `plan.tiles`, the
 * Mercator plan — the FLAT map is untouched by the geographic path, always),
 * globe quad ops above it, both near the crossover so the transition dissolves
 * rather than pops. This is what makes an overlay a genuine "second basemap"
 * rather than a special case: emit() calls this once for the base and once per
 * active overlay (see its docblock), and neither call knows or cares which one
 * it is.
 *
 * THE GLOBE SIDE READS `plan.geo` WHEN PRESENT (tile_providers.geographicFor):
 * a layer with a geographic (EPSG:4326) twin draws that grid's tiles on the
 * globe, via geoTileNorthWest instead of globeTileOps' default Mercator corner
 * lookup — DIFFERENT PIXELS from the flat side's, reaching the true poles.
 * A layer with no twin (`plan.geo` is `undefined` — OSM, Terrain, or an overlay
 * with no geographic entry) falls through to the SAME Mercator tiles the flat
 * side just drew, exactly as before this feature existed — the "no such field"
 * shape IS the documented asymmetry, not a special case needing its own branch.
 *
 * @param {{z: number, tiles: object[], window: object, geo?: {z: number, tiles: object[]}}} plan - one layer's tile plan
 * @param {object} s - folded state (centerLon, centerLat, w, h)
 * @param {number} gw - the globe weight (effectiveGlobeWeight)
 * @param {number} devicePerWorld - camera device px per world unit, for adaptive subdivision
 * @param {number} opacity - the widget's own opacity (multiplied in, not the layer's own — an
 *   overlay has no separate opacity property; showing it is the boolean, not a fade)
 * @returns {object[]} image ops
 */
function layerSurfaceOps(plan, s, gw, devicePerWorld, opacity) {
  const ops = [];
  if (gw < 1) {
    for (const tile of plan.tiles) {
      if (!tile.ref || !tile.ready) continue;
      const r = flatTileRect(tile, plan.window, s.w, s.h);
      if (!(r.w > 0) || !(r.h > 0)) continue;
      ops.push(image({ ref: tile.ref, x: r.x, y: r.y, w: r.w, h: r.h, opacity: (1 - gw) * opacity, sampling: "bilinear" }));
    }
  }
  // THE GLOBE SIDE: the layer's `geo` (EPSG:4326) plan when it has one — the
  // corner-lookup swap globeTileOps takes a `cornerFn` for exactly this — else the
  // SAME Mercator tiles the flat side above just drew, at globeTileOps' default
  // cornerFn. This is precisely the "documented asymmetry" the manifest names:
  // OSM/Terrain (no `geo` field, ever — see tile_providers.js's own note on each)
  // fall straight through to the untouched Mercator globe path, unchanged bit for
  // bit from before this feature existed.
  if (gw > 0) {
    if (plan.geo) {
      for (const tile of plan.geo.tiles) ops.push(...globeTileOps(tile, s, gw * opacity, devicePerWorld, geoTileNorthWest));
    } else {
      for (const tile of plan.tiles) ops.push(...globeTileOps(tile, s, gw * opacity, devicePerWorld));
    }
  }
  return ops;
}

/** THE PRESETS — a few places worth starting from, each chosen to show a different
 *  thing the widget does rather than merely to be a nice view. */
const PRESETS = [
  {
    name: "The Blue Marble",
    description: "The whole Earth as a lit globe with its atmosphere — the view this widget exists for. Satellite imagery at planetary zoom, where the globe rendering is at full strength and the flat map is nowhere in sight. Tween Zoom up from here for a fly-in.",
    // showAttribution: false is EXPLICIT here rather than relied-on-by-default:
    // NASA's own imagery needs no credit (web/tile_providers.js), and a preset
    // is exactly the kind of starting point that should demonstrate the honest
    // default rather than depend on nobody having changed it since.
    props: { centerLon: 8, centerLat: 24, zoom: 0.6, style: "satellite", rimStrength: 0.9, nightAmount: 0.72, showAttribution: false },
  },
  {
    name: "Daylight Globe (no terminator)",
    description: "The same globe lit evenly, with no day/night boundary — a cleaner read for a diagram where the terminator would be a distraction rather than a feature. Night darkness at 0 is what removes it.",
    props: { centerLon: 0, centerLat: 20, zoom: 0.6, style: "satellite", nightAmount: 0, limbDarken: 0.25, showAttribution: false },
  },
  {
    name: "Hybrid (satellite + labels + borders)",
    description: "The Google Maps \"hybrid\" look: NASA satellite imagery with place labels and political borders composited on top, both from the same keyless GIBS source. Coastlines stays off here — the satellite base already shows a sharp coastline of its own. NASA's imagery needs no credit; the two OVERLAYS are OSM-derived — flip Show attribution on if you want their credit line drawn.",
    props: {
      centerLon: 12, centerLat: 42, zoom: 3.4, style: "satellite", showAttribution: false,
      overlayLabels: true, overlayFeatures: true, overlayCoastlines: false,
    },
  },
  {
    name: "Continental (the crossover)",
    description: `Europe at the zoom where the globe gives way to the flat map (about ${GLOBE_FLAT_CROSSOVER}). Nudge Zoom either way to watch the crossfade — this is the preset for checking that the two renderings agree, since both sample the SAME tiles.`,
    props: { centerLon: 10, centerLat: 48, zoom: 4.6, style: "terrain" },
  },
  {
    name: "City (street level)",
    description: "Manhattan on the OpenStreetMap basemap at street zoom — the flat slippy map, fully out of the globe. Zoom the CANVAS camera into this one to see the view-resolution law: the tiles get deeper for the visible crop alone, with no property change.",
    props: { centerLon: -74.006, centerLat: 40.7128, zoom: 13, style: "osm" },
  },
  {
    name: "Terrain (the Alps)",
    description: "OpenTopoMap's contour and relief rendering over the Alps, where topography is the whole point. A different provider entirely (CC-BY-SA; Show attribution draws its credit if you turn it on).",
    props: { centerLon: 7.66, centerLat: 45.98, zoom: 11, style: "terrain" },
  },
];

export const globeMapPlugin = {
  type: "demo_globe_map",
  title: "Globe / Map",
  capabilities: { bbox: true, transform: true, resizable: true },
  // DOUBLE-CLICK ACTIVATION — the SAME handler the Mandelbrot uses
  // (web/interiorNav.js, phase "activate"): double-click to enter, wheel to pan
  // inside, Ctrl+wheel (a trackpad PINCH) to zoom inside, Escape to leave, and a
  // plain drag still MOVES the widget. Nothing map-specific was added to that
  // handler; declaring `interiorView` below is the entire opt-in, which is the
  // proof that the contract generalized beyond the fractal it was written for.
  activate: "navigate_interior",
  /**
   * THE INTERIOR VIEW — the web/interiorNav.js contract. Interior units are
   * NORMALIZED WORLD MERCATOR (not degrees: see mapWindow for why degrees would
   * distort), and the window IS the geographic rect the widget shows.
   */
  interiorView: {
    window: mapWindow,
    writes: mapWrites,
  },
  /**
   * Pure function. THE FLOATING BAR (web/CanvasToolbar.svelte's `toggles` +
   * `fields` specs) — the on-canvas popup explore mode puts above the widget.
   * THREE TOGGLE ROWS mirror the Inspector's basemap/overlay/view-mode rows
   * exactly (same stored keys, same command path, via toggleWrites below — no
   * parallel state), plus a coordinate PASTE field ahead of the existing
   * lon/lat/zoom readout: "importing geographic coordinates is simple" (the
   * user's own reasoning for choosing coordinates over a search box) is exactly
   * what core/geo_tiles.parseLatLon exists to make true — paste "40.7128,
   * -74.0060" (or any of the forms its doctests cover) and the map recentres.
   *
   * @param {object} s - folded, EVALUATED item state
   * @returns {{toggles: object, fields: object[]}}
   */
  floatingToolbar(s) {
    return {
      label: "Map view",
      toggles: {
        groups: [
          {
            buttons: TILE_PROVIDER_IDS.map((id) => ({
              id: `style:${id}`, label: TILE_PROVIDERS[id].title, active: s.style === id, keys: ["style"],
              help: `Switch the basemap to "${TILE_PROVIDERS[id].title}".`,
            })),
          },
          {
            buttons: OVERLAY_IDS.map((id) => ({
              id: `overlay:${id}`, label: TILE_OVERLAYS[id].title, active: !!s[overlayPropName(id)], keys: [overlayPropName(id)],
              help: TILE_OVERLAYS[id].help,
            })),
          },
          {
            buttons: ["auto", "globe", "flat"].map((mode) => ({
              id: `viewMode:${mode}`, label: mode === "auto" ? "Auto" : mode === "globe" ? "Globe" : "Flat",
              active: (s.viewMode ?? "auto") === mode, keys: ["viewMode"],
              help: mode === "auto" ? "The shipped zoom-threshold crossfade." : mode === "globe" ? "Pin the sphere rendering at any zoom." : "Pin the flat mercator rendering at any zoom.",
            })),
          },
        ],
      },
      fields: [
        { id: "coords", label: "Go to", value: "", keys: [], size: "wide", help: "Paste coordinates to fly there: \"40.7128, -74.0060\", with N/S/E/W suffixes, or with ° marks — see the field's own parser." },
        { id: "lon", label: "Lon", value: String(round6(s.centerLon)), keys: ["centerLon"], size: "wide", help: "Longitude of the view centre, degrees east. Paste a coordinate here to fly to it." },
        { id: "lat", label: "Lat", value: String(round6(s.centerLat)), keys: ["centerLat"], size: "wide", help: "Latitude of the view centre, degrees north." },
        { id: "zoom", label: "Zoom", value: String(round6(s.zoom)), keys: ["zoom"], size: "narrow", help: "Slippy-map zoom: 0 is the whole world and each unit doubles the scale. Tween this for a fly-in." },
      ],
    };
  },
  /**
   * Pure function. A bar field's typed text → the property writes that store it,
   * or null when the text is not a value the field accepts (the host then leaves
   * the field alone rather than committing a guess).
   *
   * Longitude wraps and latitude clamps here exactly as they do for a drag, so a
   * typed 200 means 160°W rather than being refused or stored as an impossible
   * coordinate. The "coords" field is a WRITE-ONLY paste target — it always
   * displays empty (floatingToolbar's `value: ""`) and its typed text is parsed
   * by core/geo_tiles.parseLatLon into the SAME centerLon/centerLat keys "lon"
   * and "lat" write individually, so pasting one string moves the view exactly
   * as typing both fields would. A LOUD REFUSAL (returning null, never throwing)
   * is what the brief asks for on unparseable text: the host leaves the field
   * alone rather than silently discarding a typo, and the field's own `help`
   * documents the accepted grammar so the refusal is not a mystery.
   *
   * @example globeMapPlugin.fieldWrites({}, "lon", "-74.006") // {centerLon: -74.006}
   * @example globeMapPlugin.fieldWrites({}, "lon", "200") // {centerLon: -160} (wraps past the date line)
   * @example globeMapPlugin.fieldWrites({}, "lat", "95") // {centerLat: 85.05112877980659} (clamped to the Mercator limit)
   * @example globeMapPlugin.fieldWrites({}, "zoom", "13") // {zoom: 13}
   * @example globeMapPlugin.fieldWrites({}, "lat", "banana") // null
   * @example globeMapPlugin.fieldWrites({}, "coords", "40.7128, -74.0060") // {centerLat: 40.7128, centerLon: -74.00599999999997}
   * @example globeMapPlugin.fieldWrites({}, "coords", "33.5S 151.2E") // {centerLat: -33.5, centerLon: 151.20000000000005}
   * @example globeMapPlugin.fieldWrites({}, "coords", "not a place") // null (loud refusal: the host leaves the field alone rather than guessing)
   */
  fieldWrites(s, id, text) {
    if (id === "coords") {
      const parsed = parseLatLon(text);
      return parsed ? { centerLat: parsed.lat, centerLon: parsed.lon } : null;
    }
    const n = Number(String(text).trim());
    if (String(text).trim() === "" || !Number.isFinite(n)) return null;
    if (id === "lon") return { centerLon: wrapLon(n) };
    if (id === "lat") return { centerLat: clampLat(n) };
    if (id === "zoom") return { zoom: Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, n)) };
    throw new Error(`globe_map fieldWrites: unknown field "${id}" (declared: coords, lon, lat, zoom)`);
  },
  /**
   * Pure function. A popup toggle button's id → the property writes it commits,
   * exactly the shape fieldWrites returns — the SAME command path CanvasToolbar
   * uses for both, so a popup click and an Inspector edit are indistinguishable
   * to app.setPreview/commitPreview. Three id families, one per toggle group in
   * floatingToolbar: "style:<id>" picks a basemap (like the grid picker other
   * widgets use, but as a button since there are only three), "overlay:<id>"
   * FLIPS that overlay's boolean (clicking an already-active one turns it back
   * off — the popup mirrors the Inspector checkbox, which is a toggle, not a
   * radio), "viewMode:<mode>" pins the crossfade.
   *
   * @example globeMapPlugin.toggleWrites({}, "style:satellite") // {style: "satellite"}
   * @example globeMapPlugin.toggleWrites({overlayLabels: false}, "overlay:labels") // {overlayLabels: true}
   * @example globeMapPlugin.toggleWrites({overlayLabels: true}, "overlay:labels") // {overlayLabels: false}
   * @example globeMapPlugin.toggleWrites({}, "viewMode:globe") // {viewMode: "globe"}
   */
  toggleWrites(s, id) {
    const [kind, value] = id.split(":");
    if (kind === "style") {
      if (!TILE_PROVIDER_IDS.includes(value)) throw new Error(`globe_map toggleWrites: unknown basemap id "${value}" in "${id}"`);
      return { style: value };
    }
    if (kind === "overlay") {
      if (!OVERLAY_IDS.includes(value)) throw new Error(`globe_map toggleWrites: unknown overlay id "${value}" in "${id}"`);
      const key = overlayPropName(value);
      return { [key]: !s[key] };
    }
    if (kind === "viewMode") {
      if (!["auto", "globe", "flat"].includes(value)) throw new Error(`globe_map toggleWrites: unknown view mode "${value}" in "${id}"`);
      return { viewMode: value };
    }
    throw new Error(`globe_map toggleWrites: unknown toggle id "${id}" (declared families: style:, overlay:, viewMode:)`);
  },
  defaults: {
    type: "demo_globe_map", x: 140, y: 120, w: 420, h: 420, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // SPACE. The globe is drawn over this, and it is what the halo fades into; a
    // transparent default would put the atmosphere against whatever is behind,
    // which reads as a glowing sticker rather than a planet.
    fill: "#05070d",
    stroke: "rgba(255,255,255,0.18)", strokeWidth: 0,
    ...defaults("opacity"),
    ...CUSTOM.defaults,
  },
  inspector: [
    ...bundle("positioning"),
    ...props("fill", "stroke", "strokeWidth", "opacity", {
      fill: { label: "Space colour" },
      stroke: { label: "Edge colour" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows,
  ],
  presets: PRESETS,
  /**
   * Pure function. State → display list. FIVE layers, in z order:
   *   1. SPACE — the box fill, which the atmosphere's halo fades into.
   *   2. THE SURFACE — one `image` op per tile (flat) or per sub-quad (globe),
   *      crossfaded by effectiveGlobeWeight so both are drawn near the crossover
   *      and the transition is a dissolve between two renderings OF THE SAME
   *      TILES on the FLAT side always, and on the GLOBE side too for a provider
   *      with no geographic twin (OSM, Terrain). A provider WITH a twin
   *      (satellite, and its overlays) draws DIFFERENT tiles on the globe side —
   *      GIBS's EPSG:4326 pyramid, linear in latitude, reaching the true poles —
   *      layerSurfaceOps' own docblock names the swap and why it is still "the
   *      same widget", not a fork.
   *   2b. THE OVERLAYS — every active reference layer (web/tile_providers
   *      TILE_OVERLAYS: labels/borders/coastlines), composited ABOVE the surface
   *      through the identical tile mechanics as the base — same registry, same
   *      flat/globe placement math, same crossfade weight, same geographic-twin
   *      rule — because an overlay IS a basemap, just a transparent one with its
   *      own maxZoom. This is the Google "hybrid" look: reference linework over
   *      satellite imagery.
   *   2c. THE POLAR CAPS — shaded ice discs filling the gap a MERCATOR-only globe
   *      side genuinely has (OSM, Terrain: no EPSG:4326 service exists for
   *      either). Skipped entirely for a provider with a geographic twin, whose
   *      globe side already has REAL pixels at the pole — drawing the cap there
   *      would cover real data with an invented sticker.
   *   3. THE AIR — one `materialFill` naming the "atmosphere" material, drawn
   *      only when there is globe to put air around, and ABOVE the overlays/caps
   *      so limb darkening/the terminator fall across labels exactly as they do
   *      across the base surface.
   *   4. THE ATTRIBUTION — the UNION of every active layer's required credit
   *      (base + overlays), deduplicated, tiny, in the corner.
   *
   * `ctx` (sceneIR's 4th arg) carries the pre-pass's tile plan when a live view
   * ran one. Without it emit takes the camera-free fallback — see tilePlan. emit
   * stays PURE either way: same args, same output.
   */
  emit(s, _subtree, _world, ctx = null) {
    const plan = tilePlan(s, ctx);
    const gw = effectiveGlobeWeight(s);
    const provider = providerFor(s.style);
    const ops = [];

    // 1. SPACE / the base. Always drawn: it is the backdrop the halo dissolves
    //    into on the globe, and the "no tiles yet" surface on the flat map.
    ops.push(rect({
      x: 0, y: 0, w: s.w, h: s.h, fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null, strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    }));

    const devicePerWorld = devicePerWorldOf(ctx);
    // 2 + 2b. THE SURFACE, then every active OVERLAY on top of it — same plan
    // shape ({z, tiles, window}), same placement math, one extra loop per active
    // overlay. layerSurfaceOps is shared by the base and every overlay so the
    // two can never drift (see its docblock).
    ops.push(...layerSurfaceOps(plan, s, gw, devicePerWorld, s.opacity ?? 1));
    for (const id of OVERLAY_IDS) {
      const layerPlan = plan.overlays?.[id];
      if (!s[overlayPropName(id)] || !layerPlan) continue;
      ops.push(...layerSurfaceOps(layerPlan, s, gw, devicePerWorld, s.opacity ?? 1));
    }
    // THE POLAR CAPS — drawn ONLY when the base provider has NO geographic twin.
    // Web Mercator is cut at ±MAX_MERCATOR_LAT (that cut is what makes the tile
    // grid square), so NO MERCATOR TILE AT ANY ZOOM covers the last five degrees
    // to either pole — the hole this shaded cap exists to fill honestly (ice
    // colour, not sampled, because there is no data to sample; see below). A
    // provider with a `.geographic` twin (satellite, and any of its overlays) has
    // REAL PIXELS at the pole instead (core/geo_tiles.js's geographic grid; the
    // globe side of layerSurfaceOps already draws them), so painting the shaded
    // cap OVER that imagery would cover real data with an invented sticker —
    // exactly the decoder lie this cap was built to avoid in the first place.
    if (gw > 0 && !geographicFor(provider)) {
      // THE POLAR CAPS, and they are not decoration — they are the honest treatment
      // of a hole the projection genuinely leaves. On a flat map that hole is
      // invisible: the map simply ends. On a GLOBE the missing cap is a hole
      // straight through the planet, and the first render showed exactly that — a
      // black ellipse at the north pole (.claude_logs/globemap).
      //
      // A cap is drawn in the ICE COLOUR rather than sampled, because there is no
      // data to sample: inventing pixels by stretching the topmost tile row over
      // the pole would be a decoder lie of the kind this widget refuses everywhere
      // else. Both real caps ARE ice, so a flat polar disc is the truthful picture
      // — and the atmosphere's limb darkening falls across it like anywhere else.
      for (const op of polarCapOps(s, gw * (s.opacity ?? 1))) ops.push(op);
    }

    // 3. THE AIR. Only where there is a globe — on a flat street map there is no
    //    limb to glow and no terminator to draw, and painting one would be a lie
    //    about what the picture is.
    if (gw > 0 && (s.rimStrength ?? 0) > 0) {
      ops.push(materialFill({
        material: "atmosphere",
        cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
        cornerRadius: 0,
        params: {
          glowColor: s.glowColor, rimStrength: (s.rimStrength ?? 0) * gw, rimPower: s.rimPower,
          haloWidth: s.haloWidth, nightAmount: s.nightAmount, limbDarken: s.limbDarken,
          lightAngle: s.lightAngle, lightHeight: s.lightHeight,
        },
        opacity: s.opacity ?? 1,
      }));
    }

    // 4. THE ATTRIBUTION — the UNION of every ACTIVE layer's licence-required
    //    credit (see web/tile_providers.js), deduplicated, drawn last so nothing
    //    can cover it. TINY, corner text — the Google-Maps-corner idiom (user
    //    ruling: "I don't need to see their logo on my presentations. Get rid of
    //    it." — this is the smallest legible size, not a badge).
    if (s.showAttribution !== false) {
      const lines = [provider.attribution];
      for (const id of OVERLAY_IDS) if (s[overlayPropName(id)]) lines.push(overlayFor(id).attribution);
      ops.push(text({
        text: [...new Set(lines)].join("  ·  "),
        x: ATTRIBUTION_INSET, y: s.h - ATTRIBUTION_INSET - ATTRIBUTION_SIZE,
        size: ATTRIBUTION_SIZE, color: s.attributionColor,
        opacity: s.opacity ?? 1,
      }));
    }
    return ops;
  },
  hitTest(s, lx, ly) {
    return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
  },
  snapFeatures(s) {
    return [{ kind: "point", x: s.w / 2, y: s.h / 2, id: "center" }];
  },
  anchors: standardBBoxAnchors,
  // NO top-level commands: reached ONLY via the "Add Demo Widget" submenu, like
  // every other plugins/demo/ widget.
};

/** Pure function. Rounds a coordinate for DISPLAY in the floating bar. Six
 *  decimals is about 11 cm at the equator — past the precision any basemap here
 *  resolves, and short enough to read.
 *  @example round6(40.712776123) // 40.712776
 *  @example round6(undefined) // 0 */
function round6(v) {
  return Math.round((v ?? 0) * 1e6) / 1e6;
}
