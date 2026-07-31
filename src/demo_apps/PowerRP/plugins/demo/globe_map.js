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
 * for one widget AND re-earning three things `image` already provides (PDF/SVG
 * export, the CLI's loud media-omission count, and image_registry's pendingRefs
 * gate that stops the render-job worker shipping a holed frame). The ATMOSPHERE is
 * a material because it is pure math over the disc with no texture at all.
 *
 * DOM-free / bare-node-safe at import: it imports only pure core modules and the
 * IR builders. The tile REGISTRY is reached exclusively through the render context
 * (the pre-pass's descriptor), never imported here — which is what keeps this file
 * loadable in the bare-node test lane.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { CUSTOM_CATEGORY, bundle, customProps, defaults, props } from "../../core/properties.js";
import {
  GLOBE_FLAT_CROSSOVER, MAX_MERCATOR_LAT, clampLat, globeWeight, lonLatToWorld,
  mapWorldWindow, sphereProject, tileNorthWest, tileZoomFor, tilesForWindow, worldToLonLat, wrapLon,
} from "../../core/geo_tiles.js";
import { DEFAULT_TILE_STYLE, TILE_PROVIDERS, TILE_PROVIDER_IDS, providerFor } from "../../web/tile_providers.js";
import { ATMOSPHERE_FILL_PARAMS } from "../../render_gpu/skia/atmosphere_shader.js";
import { image, materialFill, polygon, rect, text } from "../../render_gpu/ir.js";

/**
 * How many quads each tile is split into per axis when drawn on the GLOBE. 8 gives
 * 64 quads per tile, which is where the visible facetting disappears: measured by
 * the geometry rather than by eye — at the crossover zoom one tile spans at most
 * ~45° of arc, so an 8-way split leaves ~5.6° per quad, whose sagitta (the gap
 * between the chord and the arc) is r·(1-cos(2.8°)) ≈ 0.0012·r. On a 400-px globe
 * that is half a pixel, i.e. below the resolution at which a straight edge can be
 * told from a curved one. Doubling it quadruples the op count for no visible gain.
 */
const GLOBE_SUBDIVISIONS = 16;

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
    help: "Which tile provider draws the surface. Streets is OpenStreetMap (deepest zoom, good at every scale); Satellite is NASA's MODIS true-colour mosaic (beautiful on the globe, but a ~250 m/px instrument, so it stops getting sharper around zoom 9); Terrain is OpenTopoMap's relief and contours. Each provider's REQUIRED attribution is drawn on the map. NOTE ON SATELLITE: the MODIS mosaic is assembled from ONE DAY of polar orbits, so it carries BLACK WEDGES where the satellite's swaths did not overlap — most visible near the equator. Those gaps are in NASA's data, not in the rendering (verified by downloading the raw tile), and they are the honest picture of what was actually imaged. Use Streets or Terrain for a deck that needs unbroken coverage." },
  ...ATMOSPHERE_FILL_PARAMS,
  { name: "attributionColor", kind: "color", default: "rgba(255,255,255,0.82)", label: "Attribution colour",
    help: "Ink of the provider credit. It is a knob because legibility is the point: white reads over satellite imagery and the dark globe, but a light street map at street zoom needs a dark value. An unreadable credit does not satisfy the licence it exists for." },
  { name: "showAttribution", kind: "boolean", default: true, label: "Show attribution",
    help: "Draws the basemap provider's credit line on the map. Leave it on: for OpenStreetMap and OpenTopoMap this credit is a CONDITION OF THE LICENCE, not decoration — it is the term under which the tiles may be used at all. The switch exists for a slide that credits the provider elsewhere (a sources slide), which satisfies the same requirement a different way." },
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
  // No registry reachable from a DOM-free plugin, so refs are left null and every
  // tile reports not-ready: a camera-free consumer that has not run the pre-pass
  // draws the ocean base and the graticule, which is the honest picture of "no
  // pixels were fetched" rather than a blank rectangle.
  return { z, window, cropped: window, tiles: tilesForWindow(window, z).map((t) => ({ ...t, ref: null, ready: false })) };
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
 * bounding the quad's four projected corners, plus whether it may be drawn.
 *
 * A quad is drawn as an axis-aligned `image` with the tile's matching sub-rect, so
 * the curvature is carried by the GRID of quads rather than by any one of them —
 * see GLOBE_SUBDIVISIONS for why 8 is enough to hide the facets.
 *
 * ── ALL FOUR CORNERS MUST FACE THE VIEWER, AND THAT IS A FIX ─────────────────
 * This used to draw a quad when ANY corner faced the viewer, reasoning that
 * dropping a limb-straddling quad would bite a chunk out of the planet's edge.
 * The screenshot said otherwise: because the quad is drawn as an AXIS-ALIGNED
 * rect bounding its corners, a quad with one corner round the back has a bounding
 * box that BALLOONS — the far corner projects to the opposite side of the disc, so
 * the box spans most of the planet and the tile's pixels were smeared across space
 * OUTSIDE the limb. (Visible in .claude_logs/globemap as coloured blocks floating
 * off the globe's top-right.)
 *
 * Requiring all four corners fixes it exactly, and costs nothing visible: the
 * dropped quads are 1/GLOBE_SUBDIVISIONS of a tile wide — at the crossover zoom
 * under a degree of arc — so the silhouette loses at most a sliver far narrower
 * than the atmosphere's own rim, which is drawn over that boundary anyway.
 *
 * A quad is ALSO dropped when its box escapes the disc, which catches the same
 * ballooning from the other side: near the limb the projection compresses
 * enormously (dv/dlat → 0), so a numerically-visible quad can still bound a box
 * wider than the planet. The disc test is the geometric truth — nothing on a
 * sphere of radius r can project outside radius r — so it is the honest guard.
 *
 * @param {object} corners - {lon0, lat0, lon1, lat1} the quad's geographic extent
 * @param {object} s - state (centerLon, centerLat, w, h)
 * @returns {{x: number, y: number, w: number, h: number, visible: boolean}} local px
 */
function globeQuadRect(corners, s) {
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
  // THE TOLERANCE IS A SUB-PIXEL SLACK AND NOTHING MORE. It was briefly widened to
  // half the quad's diagonal, on the theory that rejected limb quads explained the
  // black wedges in the satellite globe. THAT THEORY WAS WRONG, and the way it was
  // settled is worth recording: the wedges are in NASA'S OWN TILE. Downloading the
  // raw z2 tile and looking at it shows the same black strips — they are MODIS
  // ORBITAL GAPS, swaths the satellite had not imaged that day. The renderer was
  // faithful the whole time. Widening the slack did not remove them (they are data,
  // not geometry) and did let tiles overshoot the limb, so it was reverted.
  const boxInsideDisc = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
    .every(([x, y]) => Math.hypot(x - cx, y - cy) <= r + DISC_EPSILON_PX);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, visible: pts.every((p) => p.visible) && boxInsideDisc };
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
 * pyramid cannot reach — the region poleward of ±MAX_MERCATOR_LAT.
 *
 * Each cap is the ring of points at exactly the cut latitude, projected through the
 * same orthographic map the tiles use and filled as one polygon, so the cap meets
 * the topmost tile row exactly at the seam with no gap and no overlap. A cap facing
 * away from the viewer projects no visible points and is skipped.
 *
 * @param {object} s - folded state (centerLon, centerLat, w, h)
 * @param {number} opacity - the globe's crossfade weight
 * @returns {object[]} polygon ops (0, 1 or 2)
 */
function polarCapOps(s, opacity) {
  const r = Math.min(s.w, s.h) / 2;
  const cx = s.w / 2, cy = s.h / 2;
  const ops = [];
  for (const lat of [MAX_MERCATOR_LAT, -MAX_MERCATOR_LAT]) {
    const points = [];
    for (let i = 0; i <= POLAR_CAP_SEGMENTS; i++) {
      const lon = -180 + (360 * i) / POLAR_CAP_SEGMENTS;
      const p = sphereProject(lon, lat, s.centerLon, s.centerLat);
      if (!p.visible) continue;
      points.push([cx + p.u * r, cy - p.v * r]);
    }
    // Under three points there is no polygon to fill — the cap is entirely round
    // the back, which is the ordinary case for whichever pole is facing away.
    if (points.length < 3) continue;
    ops.push(polygon({ points, fill: POLAR_CAP_COLOR, opacity }));
  }
  return ops;
}

/** How finely the cut-latitude ring is sampled when building a polar cap. 48
 *  segments put a vertex every 7.5° of longitude, which on a 400-px globe is well
 *  under a pixel of chord error at the cap's radius. */
const POLAR_CAP_SEGMENTS = 48;

/**
 * Pure function. The image ops for one tile drawn on the GLOBE: a
 * GLOBE_SUBDIVISIONS² grid of quads, each carrying its own sub-rect of the tile
 * texture, back-face-culled.
 *
 * @param {object} tile - {x, y, z, ref}
 * @param {object} s - folded state
 * @param {number} opacity - the globe's crossfade weight
 * @returns {object[]} image ops
 */
function globeTileOps(tile, s, opacity) {
  if (!tile.ref || !tile.ready) return [];
  const nw = tileNorthWest(tile.x, tile.y, tile.z);
  const se = tileNorthWest(tile.x + 1, tile.y + 1, tile.z);
  const ops = [];
  for (let iy = 0; iy < GLOBE_SUBDIVISIONS; iy++) {
    for (let ix = 0; ix < GLOBE_SUBDIVISIONS; ix++) {
      const f0 = ix / GLOBE_SUBDIVISIONS, f1 = (ix + 1) / GLOBE_SUBDIVISIONS;
      const g0 = iy / GLOBE_SUBDIVISIONS, g1 = (iy + 1) / GLOBE_SUBDIVISIONS;
      const rect = globeQuadRect({
        lon0: nw.lon + (se.lon - nw.lon) * f0, lon1: nw.lon + (se.lon - nw.lon) * f1,
        lat0: nw.lat + (se.lat - nw.lat) * g0, lat1: nw.lat + (se.lat - nw.lat) * g1,
      }, s);
      if (!rect.visible || !(rect.w > 0) || !(rect.h > 0)) continue;
      ops.push(image({
        ref: tile.ref, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        sx: f0, sy: g0, sw: f1 - f0, sh: g1 - g0,
        opacity, sampling: "bilinear",
      }));
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
    props: { centerLon: 8, centerLat: 24, zoom: 0.6, style: "satellite", rimStrength: 0.9, nightAmount: 0.72 },
  },
  {
    name: "Daylight Globe (no terminator)",
    description: "The same globe lit evenly, with no day/night boundary — a cleaner read for a diagram where the terminator would be a distraction rather than a feature. Night darkness at 0 is what removes it.",
    props: { centerLon: 0, centerLat: 20, zoom: 0.6, style: "satellite", nightAmount: 0, limbDarken: 0.25 },
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
    description: "OpenTopoMap's contour and relief rendering over the Alps, where topography is the whole point. A different provider entirely, with its own CC-BY-SA attribution drawn on the map.",
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
   * Pure function. THE FLOATING BAR (web/CanvasToolbar.svelte's `fields` spec) —
   * the on-canvas readout explore mode puts above the widget, so a user zooming
   * around can SEE and TYPE the coordinates rather than guessing. The same
   * affordance the Mandelbrot's coordinate bar provides, with the fields a map
   * wants: a place is a longitude, a latitude and a zoom.
   *
   * @param {object} s - folded, EVALUATED item state
   * @returns {{fields: object[]}}
   */
  floatingToolbar(s) {
    return {
      label: "Map view",
      fields: [
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
   * coordinate.
   *
   * @example globeMapPlugin.fieldWrites({}, "lon", "-74.006") // {centerLon: -74.006}
   * @example globeMapPlugin.fieldWrites({}, "lon", "200") // {centerLon: -160} (wraps past the date line)
   * @example globeMapPlugin.fieldWrites({}, "lat", "95") // {centerLat: 85.05112877980659} (clamped to the Mercator limit)
   * @example globeMapPlugin.fieldWrites({}, "zoom", "13") // {zoom: 13}
   * @example globeMapPlugin.fieldWrites({}, "lat", "banana") // null
   */
  fieldWrites(s, id, text) {
    const n = Number(String(text).trim());
    if (String(text).trim() === "" || !Number.isFinite(n)) return null;
    if (id === "lon") return { centerLon: wrapLon(n) };
    if (id === "lat") return { centerLat: clampLat(n) };
    if (id === "zoom") return { zoom: Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, n)) };
    throw new Error(`globe_map fieldWrites: unknown field "${id}" (declared: lon, lat, zoom)`);
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
   * Pure function. State → display list. Four layers, in z order:
   *   1. SPACE — the box fill, which the atmosphere's halo fades into.
   *   2. THE SURFACE — one `image` op per tile (flat) or per sub-quad (globe),
   *      crossfaded by globeWeight so both are drawn near the crossover and the
   *      transition is a dissolve between two renderings OF THE SAME TILES.
   *   3. THE AIR — one `materialFill` naming the "atmosphere" material, drawn only
   *      when there is globe to put air around.
   *   4. THE ATTRIBUTION — the provider's licence-required credit.
   *
   * `ctx` (sceneIR's 4th arg) carries the pre-pass's tile plan when a live view
   * ran one. Without it emit takes the camera-free fallback — see tilePlan. emit
   * stays PURE either way: same args, same output.
   */
  emit(s, _subtree, _world, ctx = null) {
    const plan = tilePlan(s, ctx);
    const gw = globeWeight(s.zoom);
    const provider = providerFor(s.style);
    const ops = [];

    // 1. SPACE / the base. Always drawn: it is the backdrop the halo dissolves
    //    into on the globe, and the "no tiles yet" surface on the flat map.
    ops.push(rect({
      x: 0, y: 0, w: s.w, h: s.h, fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null, strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    }));

    // 2. THE SURFACE. Both renderings are emitted near the crossover, each at its
    //    own weight; away from it one of them has weight 0 and contributes nothing.
    if (gw < 1) {
      for (const tile of plan.tiles) {
        if (!tile.ref || !tile.ready) continue;
        const r = flatTileRect(tile, plan.window, s.w, s.h);
        if (!(r.w > 0) || !(r.h > 0)) continue;
        ops.push(image({ ref: tile.ref, x: r.x, y: r.y, w: r.w, h: r.h, opacity: (1 - gw) * (s.opacity ?? 1), sampling: "bilinear" }));
      }
    }
    if (gw > 0) {
      // THE POLAR CAPS, and they are not decoration — they are the honest treatment
      // of a hole the projection genuinely leaves. Web Mercator is cut at
      // ±MAX_MERCATOR_LAT (that cut is what makes the tile grid square), so NO TILE
      // AT ANY ZOOM covers the last five degrees to either pole. On a flat map that
      // is invisible: the map simply ends. On a GLOBE the missing cap is a hole
      // straight through the planet, and the first render showed exactly that — a
      // black ellipse at the north pole (.claude_logs/globemap).
      //
      // A cap is drawn in the ICE COLOUR rather than sampled, because there is no
      // data to sample: inventing pixels by stretching the topmost tile row over
      // the pole would be a decoder lie of the kind this widget refuses everywhere
      // else. Both real caps ARE ice, so a flat polar disc is the truthful picture
      // — and the atmosphere's limb darkening falls across it like anywhere else.
      for (const op of polarCapOps(s, gw * (s.opacity ?? 1))) ops.push(op);
      for (const tile of plan.tiles) ops.push(...globeTileOps(tile, s, gw * (s.opacity ?? 1)));
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

    // 4. THE ATTRIBUTION — a LICENCE TERM (see web/tile_providers.js). Drawn last
    //    so nothing can cover it.
    if (s.showAttribution !== false) {
      ops.push(text({
        text: provider.attribution,
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
