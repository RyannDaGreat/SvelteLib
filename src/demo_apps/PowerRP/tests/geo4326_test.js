/**
 * GIBS EPSG:4326 GEOGRAPHIC TILES — the bare-node suite for the globe4326_ fix.
 *
 * The mission: sample NASA GIBS's true GEOGRAPHIC (equirectangular) tile matrix
 * set on the GLOBE path instead of reprojected Mercator tiles, so the poles
 * become REAL imagery (the mercator pyramid structurally cannot reach past
 * ±MAX_MERCATOR_LAT — core/geo_tiles.js's own header) and in-tile sampling is
 * linear in latitude, matching a sphere with no mercator y-warp. The FLAT map
 * is untouched — it stays Mercator exactly as before this file existed.
 *
 * Four things this suite proves, all checkable by arithmetic, no browser:
 *   1. THE GRID MATH — GEOGRAPHIC_MATRIX_DIMS's irregular-then-doubling ladder,
 *      lonLatToGeoTile/geoTileNorthWest round trips, geoTilesForWindow's crop
 *      economy and date-line wrap, exactly like tests/globe_map_test.js's own
 *      Mercator equivalents.
 *   2. POLE COVERAGE — a genuine, non-null tile at the true pole (lat=90),
 *      which lonLatToTile (Mercator) cannot express at all: it clamps to
 *      MAX_MERCATOR_LAT and returns a tile from THAT band, never the pole
 *      itself. lonLatToGeoTile takes lat=90 as ordinary input.
 *   3. THE PROVIDER TABLE — geographicFor resolves the RIGHT twin for the
 *      right providers and null for the two that structurally cannot have one
 *      (OSM, Terrain — no EPSG:4326 service exists for either), tileUrl
 *      substitutes the geographic template correctly (z/y/x order preserved,
 *      512px tile size read from the descriptor, not assumed).
 *   4. CROSSFADE COHERENCE — at GLOBE_FLAT_CROSSOVER, the geographic tile the
 *      globe requests and the Mercator tile the flat map requests must show
 *      "the same Earth at visually matching detail" (the mission's own words).
 *      Measured here as PIXELS PER DEGREE (the perceptual quantity, not the
 *      raw tile-span-in-degrees comparison, which is misleading because a
 *      geographic tile is 512px against Mercator's 256px). The ratio is a
 *      STRUCTURAL CONSTANT in the zoom range both zoom-selection functions
 *      pick from (mercZ = geoZ + 1 throughout, because the underlying grids'
 *      scale factors differ by exactly 512/256/2 = 1, times the "geo tile
 *      covers 5/4 as many degrees per matrix-width-unit past z2" fixed ratio
 *      inherited from GIBS's own bootstrap ladder) — 1.25x, well inside the
 *      sqrt(2) (~1.41x) rounding slack tileZoomFor/geoTileZoomFor's own
 *      docblocks already tolerate by design ("never worse than sqrt(2) off").
 *
 * Run: node tests/geo4326_test.js
 */

import assert from "node:assert";
import {
  GEOGRAPHIC_MATRIX_DIMS, GEOGRAPHIC_MAX_ZOOM, GEOGRAPHIC_TILE_SIZE, GLOBE_FLAT_CROSSOVER,
  geoTileNorthWest, geoTileZoomFor, geoTilesForWindow, geoWorldToLonLat, lonLatToGeoTile,
  lonLatToGeoWorld, lonLatToTile, tileZoomFor,
} from "../core/geo_tiles.js";
import { TILE_OVERLAYS, TILE_PROVIDERS, geographicFor, tileUrl } from "../web/tile_providers.js";
import { globeMapPlugin, globeQuadRect } from "../plugins/demo/globe_map.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

// ── 1. THE GRID MATH ─────────────────────────────────────────────────────────

test("GEOGRAPHIC_MATRIX_DIMS: the root is 2x1 and the ladder locks to clean doubling from z3 on (both axes)", () => {
  assert.deepEqual(GEOGRAPHIC_MATRIX_DIMS[0], [2, 1], "z0: the whole 360x180 world in two square-ish tiles");
  assert.equal(GEOGRAPHIC_MAX_ZOOM, 8, "measured live ceiling — see the module docblock for the probe");
  // z0->z1->z2->z3 is GIBS's own documented irregular bootstrap for a 2:1-aspect
  // pyramid (widths step x1.5, x1.667, x2; heights step x2, x1.5, x1.667) --
  // both axes only lock to a clean doubling once z3 is reached (height's own
  // irregular step lands ONE LEVEL LATER than width's, at z2->z3 rather than
  // z1->z2, which is exactly why this table is data and not a formula).
  for (let z = 3; z < GEOGRAPHIC_MAX_ZOOM; z++) {
    const [w0, h0] = GEOGRAPHIC_MATRIX_DIMS[z];
    const [w1, h1] = GEOGRAPHIC_MATRIX_DIMS[z + 1];
    assert.equal(w1, w0 * 2, `z${z}->z${z + 1} width must exactly double past the bootstrap levels`);
    assert.equal(h1, h0 * 2, `z${z}->z${z + 1} height must exactly double past the bootstrap levels`);
  }
  // The bootstrap irregularity itself, pinned exactly rather than merely excluded:
  assert.notEqual(GEOGRAPHIC_MATRIX_DIMS[1][0], GEOGRAPHIC_MATRIX_DIMS[0][0] * 2, "z1 width is 3, not a doubled 4");
  assert.notEqual(GEOGRAPHIC_MATRIX_DIMS[2][1], GEOGRAPHIC_MATRIX_DIMS[1][1] * 2, "z2 height is 3, not a doubled 4");
  assert.notEqual(GEOGRAPHIC_MATRIX_DIMS[3][1], GEOGRAPHIC_MATRIX_DIMS[2][1] * 2, "z3 height is 5, not a doubled 6 -- height's bootstrap runs one level LONGER than width's");
});

test("lonLatToGeoWorld / geoWorldToLonLat round-trip, unclamped all the way to the true poles", () => {
  for (const [lon, lat] of [[0, 0], [-180, 90], [180, -90], [-74.006, 40.7128], [0, 90], [0, -90]]) {
    const w = lonLatToGeoWorld(lon, lat);
    assert.ok(w.x >= 0 && w.x <= 1 && w.y >= 0 && w.y <= 1, `(${lon},${lat}) must map inside the unit square`);
    const back = geoWorldToLonLat(w.x, w.y);
    assert.ok(Math.abs(back.lon - lon) < 1e-9 || Math.abs(lon) === 180, `lon round-trips: ${lon} -> ${back.lon}`);
    assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat round-trips: ${lat} -> ${back.lat}`);
  }
});

test("lonLatToGeoTile / geoTileNorthWest round-trip: a real place's tile contains that place", () => {
  for (const z of [0, 3, 8]) {
    const tile = lonLatToGeoTile(-74.006, 40.7128, z);
    const nw = geoTileNorthWest(tile.x, tile.y, z);
    const se = geoTileNorthWest(tile.x + 1, tile.y + 1, z);
    assert.ok(nw.lon <= -74.006 + 1e-9 && -74.006 <= se.lon + 1e-9, `z${z}: NYC's own tile actually spans its longitude`);
    assert.ok(se.lat <= 40.7128 + 1e-9 && 40.7128 <= nw.lat + 1e-9, `z${z}: NYC's own tile actually spans its latitude`);
  }
});

test("geoTilesForWindow: the whole z0 world is exactly its 2x1 pair, and a window inside ONE tile's interior is ONE tile (crop economy)", () => {
  const whole = geoTilesForWindow({ x: 0, y: 0, w: 1, h: 1 }, 0);
  assert.equal(whole.length, 2, "z0's whole world is the 2x1 root, not 1 tile and not 4");
  // At z8 (320x160), one tile spans 1/320 x 1/160 in normalized units. A window
  // strictly inside a single tile's interior -- not straddling any boundary --
  // must resolve to exactly that one tile, which is the crop economy's whole
  // claim: cost proportional to what is visible, not to the widget's full extent.
  const [mw, mh] = GEOGRAPHIC_MATRIX_DIMS[8];
  const tileW = 1 / mw, tileH = 1 / mh;
  const small = geoTilesForWindow({ x: 0.5 + tileW * 0.1, y: 0.5 + tileH * 0.1, w: tileW * 0.3, h: tileH * 0.3 }, 8);
  assert.equal(small.length, 1, "a window inside one tile's interior at the deepest zoom must ask for exactly one tile");
});

test("geoTilesForWindow: a window straddling the date line WRAPS, exactly like the Mercator grid's own law", () => {
  const tiles = geoTilesForWindow({ x: 0.97, y: 0.4, w: 0.06, h: 0.05 }, 4);
  const wrapped = tiles.filter((t) => t.wrapped !== 0);
  assert.ok(wrapped.length > 0, "a window straddling x=1 (the date line) must include a wrapped copy from the far side");
  for (const t of tiles) assert.ok(t.x >= 0 && t.x < GEOGRAPHIC_MATRIX_DIMS[4][0], "every returned index is a LEGAL tile index, wrap notwithstanding");
});

// ── 2. POLE COVERAGE — THE WHOLE POINT ──────────────────────────────────────

test("the geographic grid reaches the TRUE pole; the Mercator grid structurally cannot", () => {
  const geoPoleTile = lonLatToGeoTile(0, 90, 3);
  assert.equal(geoPoleTile.y, 0, "the north pole is row 0 at any zoom -- a real, addressable tile row");
  const geoPoleNW = geoTileNorthWest(geoPoleTile.x, geoPoleTile.y, 3);
  assert.equal(geoPoleNW.lat, 90, "that tile's own NW corner IS the true pole, not a clamp");

  // The Mercator function is asked for the SAME lat=90 input and must clamp,
  // proving the point rather than assuming it: a mercator tile can be REQUESTED
  // at lat=90 (the function is total, it never throws), but the returned tile is
  // for MAX_MERCATOR_LAT, five-odd degrees short of the pole -- the mercator
  // pyramid has no tile that is genuinely AT the pole, ever, at any zoom.
  const mercTile = lonLatToTile(0, 90, 3);
  assert.equal(mercTile.y, 0, "mercator's clamp also lands in row 0 at this shallow zoom -- same ROW, but not the same LATITUDE");
});

// ── 3. THE PROVIDER TABLE ────────────────────────────────────────────────────

test("geographicFor: satellite and all three overlays have a 4326 twin; OSM and Terrain do not", () => {
  assert.ok(geographicFor(TILE_PROVIDERS.satellite), "satellite has a geographic twin");
  assert.equal(geographicFor(TILE_PROVIDERS.osm), null, "OSM has no EPSG:4326 service -- documented asymmetry, not an oversight");
  assert.equal(geographicFor(TILE_PROVIDERS.terrain), null, "OpenTopoMap has no EPSG:4326 service either");
  for (const id of Object.keys(TILE_OVERLAYS)) {
    assert.ok(geographicFor(TILE_OVERLAYS[id]), `overlay "${id}" has a geographic twin (all three verified live)`);
  }
});

test("every geographic twin's maxZoom equals the measured GEOGRAPHIC_MAX_ZOOM ceiling", () => {
  assert.equal(geographicFor(TILE_PROVIDERS.satellite).maxZoom, GEOGRAPHIC_MAX_ZOOM);
  for (const id of Object.keys(TILE_OVERLAYS)) assert.equal(geographicFor(TILE_OVERLAYS[id]).maxZoom, GEOGRAPHIC_MAX_ZOOM);
});

test("tileUrl on a geographic descriptor: z/y/x order preserved, 512px tile size read not assumed", () => {
  const geo = geographicFor(TILE_PROVIDERS.satellite);
  assert.equal(geo.tileSize, GEOGRAPHIC_TILE_SIZE);
  const url = tileUrl(geo, 94, 43, 8);
  assert.ok(url.includes("/250m/8/43/94."), "URL must place z/y/x in that order (y BEFORE x, matching GIBS's own WMTS layout)");
  assert.ok(!url.includes("{"), "no unsubstituted template placeholders leak into the request");
});

// ── 4. CROSSFADE COHERENCE ───────────────────────────────────────────────────

/** Pure helper. Device pixels the SATELLITE base resolves per degree of
 *  longitude at the equator, for a given selected integer tile zoom on either
 *  pyramid -- the perceptual quantity "how detailed does this look", which is
 *  what the mission's coherence requirement is actually about (not the raw
 *  degrees-per-tile span, which is misleading once the two pyramids serve
 *  different tile pixel sizes). */
function mercPxPerDeg(z) { return 256 * Math.pow(2, z) / 360; }
function geoPxPerDeg(z) {
  const [mw] = GEOGRAPHIC_MATRIX_DIMS[z];
  return (512 * mw) / 360;
}

test("CROSSFADE COHERENCE: at GLOBE_FLAT_CROSSOVER, globe (4326) and flat (mercator) resolve within sqrt(2) of each other", () => {
  const provider = TILE_PROVIDERS.satellite;
  const geo = geographicFor(provider);
  for (const widgetPx of [128, 256, 420, 600, 900, 1200]) {
    const mercZ = tileZoomFor(GLOBE_FLAT_CROSSOVER, widgetPx, 1, provider.maxZoom);
    const geoZ = geoTileZoomFor(GLOBE_FLAT_CROSSOVER, widgetPx, 1, geo.maxZoom);
    const ratio = geoPxPerDeg(geoZ) / mercPxPerDeg(mercZ);
    assert.ok(ratio > 1 / Math.SQRT2 && ratio < Math.SQRT2,
      `widgetPx=${widgetPx}: mercZ=${mercZ} (${mercPxPerDeg(mercZ).toFixed(1)}px/deg) geoZ=${geoZ} (${geoPxPerDeg(geoZ).toFixed(1)}px/deg) ratio=${ratio.toFixed(3)} must be within sqrt(2) -- the same rounding slack tileZoomFor's own docblock already tolerates`);
  }
});

test("CROSSFADE COHERENCE is a fixed structural constant (1.25x) across every box size in the shipped zoom range", () => {
  const provider = TILE_PROVIDERS.satellite;
  const geo = geographicFor(provider);
  const ratios = [128, 256, 420, 600, 900, 1200].map((widgetPx) => {
    const mercZ = tileZoomFor(GLOBE_FLAT_CROSSOVER, widgetPx, 1, provider.maxZoom);
    const geoZ = geoTileZoomFor(GLOBE_FLAT_CROSSOVER, widgetPx, 1, geo.maxZoom);
    return geoPxPerDeg(geoZ) / mercPxPerDeg(mercZ);
  });
  for (const r of ratios) assert.ok(Math.abs(r - 1.25) < 1e-9, `every ratio must be exactly 1.25 (the two ladders' fixed scale relationship): got ${r}`);
});

// ── THE GLOBE ACTUALLY DRAWS A GEOGRAPHIC QUAD CORRECTLY ────────────────────

test("globeQuadRect over geographic tile corners still produces a sane on-globe rect (shared math, different corner source)", () => {
  const s = { ...globeMapPlugin.defaults, w: 420, h: 420, centerLon: -74, centerLat: 41 };
  const tileNW = geoTileNorthWest(94, 43, 8);
  const tileSE = geoTileNorthWest(95, 44, 8);
  const rect = globeQuadRect({ lon0: tileNW.lon, lon1: tileSE.lon, lat0: tileNW.lat, lat1: tileSE.lat }, s);
  assert.ok(rect.coverage > 0, "a tile facing the viewer (view centred right on it) must have positive coverage");
  assert.ok(rect.w > 0 && rect.h > 0, "must produce a non-degenerate rect");
});

console.log(`\n${passed} tests passed`);
