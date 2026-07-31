/**
 * THE SLIPPY-MAP / GLOBE MATHEMATICS — pure, DOM-free, bare-node-safe.
 *
 * Everything the map widget needs to turn (longitude, latitude, zoom) into TILE
 * COORDINATES, and to project that tile pyramid onto a SPHERE. No fetching, no
 * canvas, no provider table (that is web/tile_providers.js — a network concern);
 * this file is only the geometry, so it is testable in bare node and reusable by
 * the sphere shader, the flat compositor, the navigator and the crop-economy
 * pre-pass alike.
 *
 * ── THE PROJECTION: WEB MERCATOR (EPSG:3857), AND WHY IT IS THE ONE ───────────
 * Every raster tile provider worth using (OSM, Esri, NASA GIBS, OpenTopoMap)
 * publishes the SAME pyramid: a square world, 2^z × 2^z tiles at zoom z, tile
 * (0,0) at the top-left, y increasing SOUTHWARD. So the widget speaks one
 * projection and every provider is a URL template over it. The forward map, from
 * the OSM wiki's own definition:
 *
 *     x_norm = (λ° + 180) / 360                                  ∈ [0, 1]
 *     y_norm = (1 − ln(tan φ + sec φ) / π) / 2                   ∈ [0, 1]
 *     tileX  = ⌊x_norm · 2^z⌋      tileY = ⌊y_norm · 2^z⌋
 *
 * where λ is longitude, φ latitude IN RADIANS. `ln(tan φ + sec φ)` is the inverse
 * Gudermannian function — the Mercator y — and it DIVERGES at the poles, which is
 * why the pyramid is clipped to ±MAX_MERCATOR_LAT (85.0511287798…°, the latitude
 * whose Mercator y is exactly π, making the world SQUARE). That clip is not a
 * fudge: a square world is what makes a tile a tile.
 *
 * The inverse, which the sphere needs to go from a tile back to a real place:
 *
 *     λ° = x_norm · 360 − 180
 *     φ  = atan(sinh(π · (1 − 2·y_norm)))                        (the Gudermannian)
 *
 * ── THE SPHERE: ORTHOGRAPHIC, AND THE UV THAT FEEDS IT ───────────────────────
 * At planetary zoom the widget draws a GLOBE, and the projection is ORTHOGRAPHIC
 * (a parallel projection — what a camera infinitely far away sees). It is chosen
 * over a perspective projection because it is exactly invertible in closed form
 * with no camera-distance parameter to invent, and because at planet scale the
 * difference is a few pixels of limb: the honest picture of a distant planet.
 *
 * For a unit disc coordinate (u, v) ∈ [−1, 1]² with r² = u² + v² ≤ 1, the point on
 * the unit sphere facing the viewer is (u, v, √(1 − r²)); rotating that by the
 * view's centre (λ₀, φ₀) and reading off spherical coordinates gives the lon/lat
 * under that pixel — `sphereLonLatAt` below, with the rotation written out. The
 * texture read is then the ORDINARY Mercator map of that lon/lat, so THE GLOBE AND
 * THE FLAT MAP SAMPLE THE SAME TILES. That is the property that makes the
 * crossfade between them coherent rather than a dissolve between two datasets.
 *
 * ── THE ZOOM LAW ──────────────────────────────────────────────────────────────
 * `zoom` is the ordinary slippy-map zoom: z=0 is the whole world in ONE 256-px
 * tile, and each unit doubles the scale. It is a CONTINUOUS number here (it
 * tweens, and it is a property), while a tile request needs an INTEGER level —
 * `tileZoomFor` is the one place that rounding happens, and it composes the
 * widget's own zoom with the CAMERA's device-pixels-per-world-unit so that
 * zooming the editor camera into the widget raises tile depth. See its docblock
 * for the derivation; that composition IS the view-resolution law.
 *
 * ── RESEARCH: HOW REAL GLOBE RENDERERS SOLVE THE LIMB, AND WHAT WE TOOK ──────
 * The user's critique ("coercing a 2D mapping into 3D… the edges always look
 * bad") sent us to look at what CesiumJS, MapLibre GL's globe mode, deck.gl's
 * GlobeView and the d3-geo raster-reprojection idiom actually do. None of them
 * is a drop-in fix — each assumes a real 3D mesh/GPU pipeline this app does not
 * have (render_gpu is a Skia/SkSL raster stack over `image` ops, not a WebGL
 * mesh engine) — but each named a specific failure mode worth checking against:
 *
 *   · CESIUMJS: a quadtree of ellipsoid patches, LOD chosen by projected
 *     SCREEN-SPACE ERROR per patch, horizon-cull by an occludee point against a
 *     horizon plane. ADOPTED (the principle, not the mesh): tile/quad density
 *     must be a function of ON-SCREEN size, not a fixed constant — see
 *     `globeSubdivisionsFor` below. REJECTED: an actual patch quadtree — there
 *     is no 3D mesh engine to hang it on, and the existing quad-grid-of-`image`-
 *     ops IS this app's patch mesh; the honest analog is adaptive density, not a
 *     new geometry system.
 *   · MAPLIBRE GL globe mode: reprojects mercator tiles per-VERTEX onto a unit
 *     sphere and hides the horizon by a CLIP PLANE, not by feathering — their
 *     own developer guide (github.com/maplibre/maplibre-gl-js,
 *     developer-guides/globe.md) discusses the horizon only as clip-plane math
 *     and says nothing about antialiasing the silhouette. That is a real GPU
 *     hardware-MSAA advantage this raster stack does not get for free, so their
 *     silence on limb AA is not a technique to adopt — it means they lean on
 *     hardware the Skia CPU/GL2 path here cannot assume. What IS actionable:
 *     their guide states plainly that RASTER tiles need much finer subdivision
 *     than vector ("raster tiles in particular need a relatively high base
 *     granularity, as otherwise they would exhibit visible warping and
 *     deformations") — confirming subdivision is necessary, which this widget
 *     already had (GLOBE_SUBDIVISIONS), but per MapLibre's own admission
 *     subdivision ALONE does not solve edge quality; it solves interior warping.
 *     ADOPTED: keep subdivision, stop treating it as sufficient for the limb.
 *   · DECK.GL GlobeView: converts flat geometry to a 3D mesh at a configurable
 *     angular resolution; raster tile support on the globe is still marked
 *     experimental in their own docs. Nothing new to adopt over CesiumJS/MapLibre
 *     here — same "mesh + hardware AA" answer, same inapplicability.
 *   · D3-GEO RASTER REPROJECTION (the observablehq/d3 idiom, e.g.
 *     gist.github.com/rasmuse/75fae4fee3354ec41a49d10fb37af551): for EVERY
 *     destination pixel, inverse-project to source lon/lat and sample — the
 *     reference implementation is nearest-neighbour only ("I only implemented
 *     nearest neighbor resampling… not really useful for animated on-the-fly
 *     reprojection") and admits it has no antialiasing at all. ADOPTED THE
 *     MODEL, NOT THE CODE: this is the architecturally correct target — a
 *     genuine per-pixel inverse projection, which is exactly what an SkSL
 *     shader already does per-pixel for the atmosphere. REJECTED as a literal
 *     replacement for the surface: doing this for the TILE SURFACE (not just
 *     the atmosphere) would require handing a material shader N arbitrary tile
 *     textures as children, and the material framework has no such mechanism
 *     (see plugins/demo/globe_map.js's docblock on why the surface stays
 *     `image` ops) — building one is a framework change with a global blast
 *     radius, out of this fix's scope. What IS adopted from this idiom is its
 *     STANDARD antialiasing answer (supersample several sub-points per output
 *     pixel/quad and blend) applied at the QUAD level: `discCoverageFraction`
 *     below is the closed-form version of exactly that idea, done analytically
 *     instead of by supersampling, which SkSL ES2 here cannot do with `fwidth`
 *     anyway (see next point).
 *
 * ── WHY NO fwidth/dFdx: THE SHADER RUNTIME IS ES2, AND THE FIX IS ANALYTIC ───
 * The obvious limb-AA idiom in shader work is `alpha = 1 - smoothstep(0, fwidth(r),
 * r - 1)` — antialias over one screen-space derivative of the edge function. This
 * codebase's SkSL runtime effects are ES2-restricted (CanvasKit's CPU path does not
 * implement the ES3 derivative intrinsics; render_gpu/skia/metal_shader.js and
 * metal_stamp_shader.js already hit this and use ANALYTIC or central-difference
 * derivatives instead of `dFdx`). The orthographic disc has a gift here: unlike an
 * arbitrary SDF, `r = length((p - uCenter) / uRadius)` is EXACTLY LINEAR in device
 * px along the radial direction, so its true screen-space derivative is the closed
 * form `1 / uRadius` device px per unit of `r` — no `fwidth` needed AT ALL, in the
 * atmosphere shader or in the quad-level analog below. This is why the fix does not
 * need a runtime upgrade: the closed form was always available, it just was not
 * being used at the quad-culling boundary (globeQuadRect used a hard boolean).
 *
 * ── POLES: MERCATOR'S CUT vs GIBS GEOGRAPHIC TILES, AND WHY THE GLOBE NOW USES
 * BOTH ──────────────────────────────────────────────────────────────────────
 * NASA GIBS also serves true GEOGRAPHIC (EPSG:4326, equirectangular) tile matrix
 * sets whose "spatial coverage… matches the full extent of the projection"
 * (nasa-gibs.github.io/gibs-api-docs/access-advanced-topics) — i.e. all the way to
 * ±90°, with none of Mercator's ±MAX_MERCATOR_LAT cut. An equirectangular texture
 * is also the RIGHT bake target for a sphere shader in principle: lon/lat is
 * linear across it, so an inverse-orthographic lookup is one lerp with no
 * Gudermannian and no polar singularity. THIS WAS EVALUATED AND DEFERRED once
 * (the provider table's layer/style plumbing was mid-flight in a concurrently-
 * landing sibling change, mapctl_, and a second tile geometry would have raced
 * it) — that sibling has since landed, and this file now carries the geographic
 * grid (GEOGRAPHIC_MATRIX_DIMS, lonLatToGeoTile, geoTileNorthWest,
 * geoTilesForWindow, geoTileZoomFor below) beside the Mercator math above,
 * NEVER MERGED INTO IT: the two pyramids have different roots (2×1 vs 1×1),
 * different per-level matrix dimensions (GIBS's geographic ladder is NOT a clean
 * 2^z power — see that constant's own docblock) and a different forward map
 * (linear in latitude here; log-tangent above), so a shared function would need
 * a branch on every call rather than two call sites each doing one honest thing.
 * web/tile_providers.js's `geographic: true` flag on the satellite/overlay
 * entries selects this path; OSM and Terrain carry no 4326 entry (no such
 * service exists) and the globe keeps sampling their Mercator tiles with the
 * shaded polar caps below — a DELIBERATE, DOCUMENTED ASYMMETRY, not a gap: see
 * plugins/demo/globe_map.js's polarCapOps and web/tile_providers.js's own note
 * on which providers this covers.
 */

/**
 * The tile pyramid's tile size in pixels. 256 is the near-universal raster tile
 * size (OSM, Esri, GIBS, OpenTopoMap all serve 256²); a provider serving 512²
 * "@2x" tiles declares its own `tileSize` and the scale math reads it from there
 * rather than assuming this.
 */
export const TILE_SIZE = 256;

/**
 * The latitude where the Mercator projection is cut, in degrees:
 * atan(sinh(π))·180/π = 85.0511287798066…°.
 *
 * WHY EXACTLY HERE, because it looks arbitrary and is not: Mercator y is
 * ln(tan φ + sec φ), which runs to infinity at the pole. Cutting at the latitude
 * whose Mercator y equals π makes the projected world span [−π, π] in BOTH axes —
 * a SQUARE. A square world is what lets zoom z be a 2^z × 2^z grid of square
 * tiles, so this constant is the reason the tile pyramid exists in this shape.
 * The poles are therefore not on the flat map at all; the GLOBE draws them (it
 * samples the sphere, not the square), which is one of the nicer consequences of
 * having both renderings.
 */
export const MAX_MERCATOR_LAT = 85.05112877980659;

/** Pure function. Clamps a latitude into the Mercator-representable band. A
 *  value past the cut is not an error — a pan can ask for it, and the honest
 *  answer is the edge of the map rather than an infinity.
 *  @example clampLat(0) // 0
 *  @example clampLat(89) // 85.05112877980659
 *  @example clampLat(-120) // -85.05112877980659 */
export function clampLat(lat) {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

/**
 * Pure function. Wraps a longitude into [−180, 180). The map is a CYLINDER: 181°
 * and −179° are the same meridian, so panning east past the date line must
 * continue rather than stop. Latitude clamps (clampLat) and longitude WRAPS —
 * the asymmetry is the geometry's, not a policy choice.
 *
 * @example wrapLon(0) // 0
 * @example wrapLon(190) // -170
 * @example wrapLon(-190) // 170
 * @example wrapLon(180) // -180 (the half-open interval: 180 and -180 name one meridian)
 */
export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Pure function. Longitude/latitude → NORMALIZED world coordinates, both in
 * [0, 1], with (0, 0) at the top-left (the north-west corner of the map, at
 * −180° / +MAX_MERCATOR_LAT). This is the Web Mercator forward projection stated
 * in the header, and it is the ONE place the log-tangent formula is written.
 *
 * Multiplying the result by 2^z gives fractional tile coordinates at zoom z,
 * which is what every other function here builds on.
 *
 * @param {number} lon - longitude in degrees
 * @param {number} lat - latitude in degrees (clamped to the Mercator band)
 * @returns {{x: number, y: number}} normalized world position in [0, 1]²
 *
 * @example lonLatToWorld(0, 0) // {x: 0.5, y: 0.5} (null island is the map's centre)
 * @example lonLatToWorld(-180, 85.05112877980659) // {x: 0, y: 0} (the NW corner)
 * @example lonLatToWorld(180, -85.05112877980659) // {x: 1, y: 1} (the SE corner)
 * @example lonLatToWorld(-74.006, 40.7128) // {x: 0.2944277777777778, y: 0.3759807982580087} (New York City)
 */
export function lonLatToWorld(lon, lat) {
  const phi = (clampLat(lat) * Math.PI) / 180;
  // ln(tan φ + sec φ) is the inverse Gudermannian; asinh(tan φ) is the same value
  // computed without the cancellation that tan+sec suffers near the equator.
  const mercatorY = Math.asinh(Math.tan(phi));
  return { x: (lon + 180) / 360, y: 0.5 - mercatorY / (2 * Math.PI) };
}

/**
 * Pure function. The inverse of lonLatToWorld: normalized world coordinates →
 * longitude/latitude in degrees. The latitude step is the GUDERMANNIAN function,
 * atan(sinh(·)), which is what undoes the log-tangent above.
 *
 * @param {number} x - normalized world x in [0, 1]
 * @param {number} y - normalized world y in [0, 1]
 * @returns {{lon: number, lat: number}} degrees
 *
 * @example worldToLonLat(0.5, 0.5) // {lon: 0, lat: 0}
 * @example worldToLonLat(0, 0) // {lon: -180, lat: 85.05112877980659} (the NW corner)
 * @example // the round trip returns the place it started at:
 * worldToLonLat(lonLatToWorld(-74.006, 40.7128).x, lonLatToWorld(-74.006, 40.7128).y)
 * { lon: -74.006, lat: 40.71279999999999 }
 */
export function worldToLonLat(x, y) {
  const mercatorY = (0.5 - y) * 2 * Math.PI;
  return { lon: x * 360 - 180, lat: (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI };
}

/**
 * Pure function. Longitude/latitude/integer-zoom → the TILE INDICES covering that
 * point, plus the fractional position INSIDE that tile. The indices are what a
 * URL template's {x}/{y} take; the fraction is what a compositor needs to place
 * the tile's pixels exactly.
 *
 * Indices are clamped to [0, 2^z − 1]: the fractional coordinate of the extreme
 * south-east corner is exactly 2^z, whose floor is one past the last tile, and a
 * request for that tile is a 404 at every provider.
 *
 * @param {number} lon - longitude in degrees
 * @param {number} lat - latitude in degrees
 * @param {number} z - integer zoom level (≥ 0)
 * @returns {{x: number, y: number, z: number, fx: number, fy: number}} indices + in-tile fraction
 *
 * @example lonLatToTile(0, 0, 0) // {x: 0, y: 0, z: 0, fx: 0.5, fy: 0.5} (one tile holds the world)
 * @example lonLatToTile(0, 0, 1) // {x: 1, y: 1, z: 1, fx: 0, fy: 0} (the equator/meridian crossing is the 2x2 grid's centre corner)
 * @example lonLatToTile(-74.006, 40.7128, 10) // {x: 301, y: 385, z: 10, fx: 0.49404444444445517, fy: 0.004337416200883126} (New York at z10 — the indices the canonical OSM formula gives)
 */
export function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, Math.max(0, Math.round(z)));
  const world = lonLatToWorld(lon, lat);
  const fx = world.x * n, fy = world.y * n;
  const x = Math.max(0, Math.min(n - 1, Math.floor(fx)));
  const y = Math.max(0, Math.min(n - 1, Math.floor(fy)));
  return { x, y, z: Math.max(0, Math.round(z)), fx: fx - x, fy: fy - y };
}

/**
 * Pure function. A tile's north-west corner in longitude/latitude — the inverse
 * of lonLatToTile at the tile's own origin. Used to place a fetched tile's pixels
 * and to build a tile's UV footprint on the globe.
 *
 * @param {number} x - tile x index
 * @param {number} y - tile y index
 * @param {number} z - integer zoom level
 * @returns {{lon: number, lat: number}} the tile's NW corner, degrees
 *
 * @example tileNorthWest(0, 0, 0) // {lon: -180, lat: 85.05112877980659} (z0's single tile starts at the NW corner of the world)
 * @example tileNorthWest(1, 1, 1) // {lon: 0, lat: 0} (the z1 south-east tile starts at null island)
 * @example tileNorthWest(301, 385, 10) // {lon: -74.1796875, lat: 40.713955826286046} (the New York tile's own NW corner)
 */
export function tileNorthWest(x, y, z) {
  const n = Math.pow(2, Math.max(0, Math.round(z)));
  return worldToLonLat(x / n, y / n);
}

/**
 * Pure function. THE TILE ZOOM LEVEL a render should request — the view-resolution
 * law, and the single place the widget's own zoom is composed with the CAMERA's.
 *
 * ── THE DERIVATION ───────────────────────────────────────────────────────────
 * A slippy map at zoom z draws the world across 2^z · TILE_SIZE pixels, so one
 * tile covers TILE_SIZE pixels ON SCREEN when the on-screen scale matches z. The
 * widget shows a window of the world `widgetPx` pixels wide (its own box, in world
 * units), and the camera then maps one of those world units to `devicePerWorld`
 * DEVICE pixels. So the tiles must be chosen for the DEVICE resolution:
 *
 *     screenPxForWholeWorld = widgetPx · devicePerWorld · 2^zoom
 *     z*                    = log2(screenPxForWholeWorld / TILE_SIZE)
 *                           = zoom + log2(widgetPx · devicePerWorld / TILE_SIZE)
 *
 * THIS IS THE WHOLE POINT OF THE FUNCTION. `devicePerWorld` is the camera's
 * contribution: zoom the editor camera IN and it grows, which raises z* and
 * fetches DEEPER tiles for the same widget — "if I zoom in, it should render a
 * smaller crop of the thing" (the user's law) satisfied by tile SELECTION, not by
 * scaling a fixed bitmap. A MAGNIFIER over the map is the same thing arriving
 * through the same argument: its supersample path re-renders at magnified zoom,
 * which IS a larger devicePerWorld, so the lens gets deeper tiles for free with no
 * magnifier-specific code.
 *
 * The result is ROUNDED and clamped to [0, maxZoom]. Rounding rather than
 * flooring is deliberate: flooring makes a map spend most of its zoom range up to
 * 2× under-resolved (blurry), whereas rounding is never worse than √2 off in
 * either direction. `maxZoom` is the PROVIDER's native ceiling — past it there
 * are no deeper tiles to fetch, and the renderer simply magnifies the deepest
 * ones, which is what every slippy map does at max zoom.
 *
 * @param {number} zoom - the widget's own continuous zoom property
 * @param {number} widgetPx - the widget's on-screen extent in WORLD units (its box w)
 * @param {number} devicePerWorld - camera device px per world unit (view.zoom · view.dpr)
 * @param {number} maxZoom - the provider's deepest available level
 * @returns {number} an integer tile zoom in [0, maxZoom]
 *
 * @example tileZoomFor(0, 256, 1, 19) // 0 (a 256-px box at zoom 0 is exactly one tile)
 * @example tileZoomFor(0, 512, 1, 19) // 1 (twice the pixels for the same world ⇒ one level deeper)
 * @example tileZoomFor(3, 256, 1, 19) // 3 (the widget's own zoom passes straight through)
 * @example tileZoomFor(3, 256, 4, 19) // 5 (the CAMERA zoomed in 4x ⇒ two levels deeper, for the same document)
 * @example tileZoomFor(3, 256, 0.25, 19) // 1 (camera zoomed OUT ⇒ shallower tiles, fewer bytes)
 * @example tileZoomFor(30, 256, 1, 19) // 19 (clamped at the provider's native ceiling)
 * @example tileZoomFor(-5, 256, 1, 19) // 0 (never below the single world tile)
 */
export function tileZoomFor(zoom, widgetPx, devicePerWorld, maxZoom) {
  const pxPerWorld = Math.max(1e-6, widgetPx * Math.max(1e-6, devicePerWorld));
  const z = (zoom ?? 0) + Math.log2(pxPerWorld / TILE_SIZE);
  return Math.max(0, Math.min(Math.round(maxZoom), Math.round(z)));
}

/**
 * Pure function. The GEOGRAPHIC WINDOW a flat map shows: the lon/lat rect its box
 * covers at a given zoom. This is the `interiorView.window` a navigator pans and
 * zooms, expressed in the widget's own interior units (degrees).
 *
 * The width in normalized world units is `boxAspectPx / (TILE_SIZE · 2^zoom)`:
 * one tile spans TILE_SIZE px, and there are 2^zoom of them across the world. The
 * rect is returned in WORLD-NORMALIZED units rather than degrees because latitude
 * is NOT linear in degrees under Mercator — a rect in degrees would be wrong the
 * moment it spanned any real latitude range, which is the classic slippy-map bug.
 * Callers convert corners with worldToLonLat.
 *
 * @param {number} lon - centre longitude, degrees
 * @param {number} lat - centre latitude, degrees
 * @param {number} zoom - the widget's continuous zoom
 * @param {number} w - the widget's box width (world units)
 * @param {number} h - the widget's box height (world units)
 * @returns {{x: number, y: number, w: number, h: number}} the window in normalized world units
 *
 * @example mapWorldWindow(0, 0, 0, 256, 256) // {x: 0, y: 0, w: 1, h: 1} (z0 in a 256-box: the whole world)
 * @example mapWorldWindow(0, 0, 1, 256, 256) // {x: 0.25, y: 0.25, w: 0.5, h: 0.5} (one level in: a quarter of the world, centred)
 * @example mapWorldWindow(0, 0, 0, 512, 256) // {x: -0.5, y: 0, w: 2, h: 1} (a wide box at z0 runs off both edges — the map repeats there)
 */
export function mapWorldWindow(lon, lat, zoom, w, h) {
  const scale = TILE_SIZE * Math.pow(2, zoom ?? 0);
  const centre = lonLatToWorld(lon, lat);
  const ww = (w || 1) / scale, wh = (h || 1) / scale;
  return { x: centre.x - ww / 2, y: centre.y - wh / 2, w: ww, h: wh };
}

/**
 * Pure function. THE TILE LIST a flat map window needs — every tile intersecting
 * the visible window at `z`, and NOTHING ELSE. This is the crop-economy law made
 * mechanical: the cost of a render is proportional to the VISIBLE window, so
 * zooming the camera into a corner of a huge map fetches the tiles for that
 * corner rather than for the whole widget.
 *
 * Tiles are returned in a stable order (row-major from the NW corner) so two
 * renders of the same state request the same tiles in the same sequence — which
 * is what makes a fixed-document render reproducible once the tiles are resident.
 *
 * X WRAPS, Y CLAMPS, for the reason wrapLon/clampLat differ: the world is a
 * cylinder, so a window straddling the date line asks for tiles on both sides and
 * gets them by wrapping the index; a window past a pole simply has no tiles there.
 * The returned `x` is therefore always a legal index while `wrapped` records
 * whether the world repeated, which the compositor needs for placement.
 *
 * @param {{x: number, y: number, w: number, h: number}} window - normalized world window (mapWorldWindow)
 * @param {number} z - integer tile zoom
 * @param {number} [maxTiles] - a hard cap; past it the list is truncated (see TILE_BUDGET)
 * @returns {Array<{x: number, y: number, z: number, wrapped: number}>}
 *
 * @example tilesForWindow({x: 0, y: 0, w: 1, h: 1}, 0) // [{x: 0, y: 0, z: 0, wrapped: 0}]
 * @example tilesForWindow({x: 0, y: 0, w: 1, h: 1}, 1).length // 4 (the whole world at z1 is the 2x2 grid)
 * @example tilesForWindow({x: 0, y: 0, w: 0.5, h: 0.5}, 1) // [{x: 0, y: 0, z: 1, wrapped: 0}] (a quarter window ⇒ ONE tile, not four — this is the crop economy)
 * @example tilesForWindow({x: 0.9, y: 0.4, w: 0.2, h: 0.2}, 1).map((t) => t.x) // [1, 0, 1, 0] (across the date line: the world repeats, and the window spans both rows)
 * @example tilesForWindow({x: 0.9, y: 0.4, w: 0.2, h: 0.2}, 1).map((t) => t.wrapped) // [0, 1, 0, 1] (the eastern copies sit one whole world over)
 */
export function tilesForWindow(window, z, maxTiles = TILE_BUDGET) {
  const level = Math.max(0, Math.round(z));
  const n = Math.pow(2, level);
  const x0 = Math.floor(window.x * n), x1 = Math.ceil((window.x + window.w) * n) - 1;
  const y0 = Math.max(0, Math.floor(window.y * n));
  const y1 = Math.min(n - 1, Math.ceil((window.y + window.h) * n) - 1);
  const out = [];
  for (let ty = y0; ty <= y1 && out.length < maxTiles; ty++)
    for (let tx = x0; tx <= x1 && out.length < maxTiles; tx++) {
      // The wrap COUNT (how many whole worlds east/west this copy sits) is what a
      // compositor adds back to place the tile; the index itself is wrapped into
      // the legal range so the URL is always requestable.
      const wrapped = Math.floor(tx / n);
      out.push({ x: ((tx % n) + n) % n, y: ty, z: level, wrapped });
    }
  return out;
}

/**
 * The most tiles ONE render may request. A 4K-wide map at a badly chosen zoom
 * could otherwise ask for thousands, and every one is an HTTP request against a
 * volunteer-funded server — the OSM tile policy's "bulk download" line is exactly
 * this failure mode. 256 tiles is a 16×16 grid: more than covers a 4096-px edge at
 * the correct zoom (16 tiles), so hitting this cap means the zoom choice was
 * already wrong and truncating is the safe answer rather than the lossy one.
 */
export const TILE_BUDGET = 256;

/**
 * ── THE GEOGRAPHIC (EPSG:4326) TILE PYRAMID ──────────────────────────────────
 * A SECOND, INDEPENDENT tile grid — NASA GIBS's own equirectangular pyramid,
 * used ONLY by the globe path for the providers that have one (this file's
 * header explains the boundary). Nothing below shares code with the Mercator
 * functions above: the forward/inverse maps are linear in latitude (no
 * Gudermannian), the root tile is 2×1 rather than 1×1, and the per-level tile
 * COUNT is not a clean 2^z power (GEOGRAPHIC_MATRIX_DIMS's own docblock), so a
 * shared helper would be a branch at every call site rather than a reuse.
 *
 * VERIFIED LIVE (2026-07-31) against GIBS's own GetCapabilities document
 * (epsg4326/best/wmts.cgi?REQUEST=GetCapabilities) and literal tile fetches —
 * not inferred from the TileMatrixSet's name, which the Mercator satellite
 * entry's own history already shows can lie (that pyramid's "Level9" turned out
 * to mean "z0..z9", not "9 levels"; see web/tile_providers.js). The set used
 * here is named "250m" and covers MODIS_Terra_CorrectedReflectance_TrueColor
 * plus all three Reference overlays (Labels/Features/Coastlines) — the SAME
 * four layers the Mercator table already ships, at the SAME z8 ceiling
 * (confirmed: z8 tile requests 200, z9 requests 400 for all four). A finer
 * "15.625m" set exists in the capabilities document for `_15m` overlay
 * variants, exactly mirroring the Mercator finding — and 400s past z0 for all
 * three, so it is left unshipped for the identical reason (web/tile_providers.js
 * TILE_OVERLAYS docblock: a trio with one dead sibling is a worse default than
 * a matched trio that all work).
 */

/**
 * THE GEOGRAPHIC MATRIX DIMENSIONS: [width, height] tile counts per zoom level
 * 0 through GEOGRAPHIC_MAX_ZOOM, read directly off GIBS's "250m" TileMatrixSet
 * (epsg4326/best/wmts.cgi?REQUEST=GetCapabilities). A DATA TABLE rather than a
 * formula, because the ladder is NOT a clean 2^z power throughout: the root is
 * 2×1 (the whole 360°×180° world in two square-ish tiles, half the height of
 * their width), and the first two doublings are irregular —
 *
 *     z:      0    1    2    3    4    5    6    7    8
 *     width:  2    3    5   10   20   40   80  160  320
 *     height: 1    2    3    5   10   20   40   80  160
 *
 * — width/height only lock to the clean "double every level" pattern from z3
 * onward (z0→z1→z2 step by ×1.5 and ×1.667 rather than ×2, which is GIBS's own
 * documented bootstrap for a 2:1-aspect geographic pyramid whose z0 has just
 * two tiles). Encoding this as a closed-form exponent would silently produce
 * the WRONG tile count for z ≤ 2 — measured while building this: the naive
 * `[2·2^z, 2^z]` guess matches at z=0 and z=8 alone and is off by one tile in
 * at least one axis at every level in between. A table this short (9 rows) is
 * the honest fix, not a premature one.
 *
 * Every level past z2 IS exactly square in degrees-per-tile (360°/width ==
 * 180°/height), which is the property that makes this pyramid a genuine fit
 * for linear-in-latitude sampling — z0/z1/z2 are not square (2:1, 1.5:1,
 * 1.667:1 respectively) but they cover so much of the globe per tile that the
 * distortion is invisible at the zoom levels a globe actually uses them.
 */
export const GEOGRAPHIC_MATRIX_DIMS = Object.freeze([
  Object.freeze([2, 1]), Object.freeze([3, 2]), Object.freeze([5, 3]), Object.freeze([10, 5]),
  Object.freeze([20, 10]), Object.freeze([40, 20]), Object.freeze([80, 40]), Object.freeze([160, 80]),
  Object.freeze([320, 160]),
]);

/** The geographic pyramid's deepest zoom — GEOGRAPHIC_MATRIX_DIMS.length − 1,
 *  named so a caller never hardcodes 8. MEASURED, not assumed: z8 tiles return
 *  200 and z9 tiles return 400 against the live GIBS endpoint for every layer
 *  this pyramid serves (satellite + all three Reference overlays) — the same
 *  ~250 m/px MODIS instrument resolution that caps the Mercator satellite
 *  entry at its own z9, arrived at independently here because the two
 *  pyramids' zoom numbers do not mean the same angular resolution.
 *  @example GEOGRAPHIC_MAX_ZOOM // 8 */
export const GEOGRAPHIC_MAX_ZOOM = GEOGRAPHIC_MATRIX_DIMS.length - 1;

/** The geographic pyramid's tile size in pixels. GIBS serves 512² for this
 *  TileMatrixSet (verified in the same GetCapabilities document), twice the
 *  Mercator table's 256 — a provider-shape difference read from the table by
 *  callers, never assumed equal to TILE_SIZE. */
export const GEOGRAPHIC_TILE_SIZE = 512;

/**
 * Pure function. Longitude/latitude → normalized GEOGRAPHIC world coordinates,
 * both in [0, 1], (0, 0) at the NW corner (−180°, +90°). Unlike lonLatToWorld,
 * this is a PLAIN LINEAR SCALE — no log-tangent, no clamping at a Mercator
 * limit — because the equirectangular projection is linear in latitude by
 * construction, all the way to the true poles.
 *
 * @param {number} lon - longitude in degrees
 * @param {number} lat - latitude in degrees (unclamped: ±90 is legal here)
 * @returns {{x: number, y: number}} normalized world position in [0, 1]²
 *
 * @example lonLatToGeoWorld(0, 0) // {x: 0.5, y: 0.5} (null island, same centre as Mercator)
 * @example lonLatToGeoWorld(-180, 90) // {x: 0, y: 0} (the NW corner is the true pole, not a clamp)
 * @example lonLatToGeoWorld(180, -90) // {x: 1, y: 1} (the SE corner is the true south pole)
 * @example lonLatToGeoWorld(0, 90) // {x: 0.5, y: 0} (the north pole itself has a real coordinate here)
 */
export function lonLatToGeoWorld(lon, lat) {
  return { x: (lon + 180) / 360, y: (90 - lat) / 180 };
}

/**
 * Pure function. The inverse of lonLatToGeoWorld: normalized geographic world
 * coordinates → longitude/latitude in degrees. A plain linear unscale — the
 * geographic pyramid's whole advantage over Mercator's is that this step needs
 * no Gudermannian.
 *
 * @param {number} x - normalized world x in [0, 1]
 * @param {number} y - normalized world y in [0, 1]
 * @returns {{lon: number, lat: number}} degrees
 *
 * @example geoWorldToLonLat(0.5, 0.5) // {lon: 0, lat: 0}
 * @example geoWorldToLonLat(0, 0) // {lon: -180, lat: 90} (the true pole, not Mercator's 85.05°)
 * @example // the round trip returns the place it started at:
 * geoWorldToLonLat(lonLatToGeoWorld(-74.006, 40.7128).x, lonLatToGeoWorld(-74.006, 40.7128).y)
 * { lon: -74.006, lat: 40.7128 }
 */
export function geoWorldToLonLat(x, y) {
  return { lon: x * 360 - 180, lat: 90 - y * 180 };
}

/**
 * Pure function. Longitude/latitude/integer-zoom → the GEOGRAPHIC tile indices
 * covering that point, plus the fractional position inside that tile — the
 * 4326-pyramid twin of lonLatToTile, reading GEOGRAPHIC_MATRIX_DIMS instead of
 * assuming a 2^z square grid.
 *
 * @param {number} lon - longitude in degrees
 * @param {number} lat - latitude in degrees (unclamped)
 * @param {number} z - integer zoom level, clamped into [0, GEOGRAPHIC_MAX_ZOOM]
 * @returns {{x: number, y: number, z: number, fx: number, fy: number}} indices + in-tile fraction
 *
 * @example lonLatToGeoTile(0, 0, 0) // {x: 1, y: 0, z: 0, fx: 0, fy: 0.5} (null island sits at the seam between the z0 pair's two tiles)
 * @example lonLatToGeoTile(-180, 90, 0) // {x: 0, y: 0, z: 0, fx: 0, fy: 0} (the NW corner is tile (0,0) at any zoom)
 * @example lonLatToGeoTile(0, 90, 3) // {x: 5, y: 0, z: 3, fx: 0, fy: 0} (the north pole at z3: row 0 of a 10x5 grid, on the seam column)
 * @example lonLatToGeoTile(-74.006, 40.7128, 8) // {x: 94, y: 43, z: 8, fx: 0.2168888888888887, fy: 0.8108444444444416} (New York at z8, the geographic ceiling)
 */
export function lonLatToGeoTile(lon, lat, z) {
  const level = Math.max(0, Math.min(GEOGRAPHIC_MAX_ZOOM, Math.round(z)));
  const [mw, mh] = GEOGRAPHIC_MATRIX_DIMS[level];
  const world = lonLatToGeoWorld(lon, lat);
  const fx = world.x * mw, fy = world.y * mh;
  const x = Math.max(0, Math.min(mw - 1, Math.floor(fx)));
  const y = Math.max(0, Math.min(mh - 1, Math.floor(fy)));
  return { x, y, z: level, fx: fx - x, fy: fy - y };
}

/**
 * Pure function. A GEOGRAPHIC tile's north-west corner in longitude/latitude —
 * the 4326-pyramid twin of tileNorthWest, reading GEOGRAPHIC_MATRIX_DIMS
 * instead of a 2^z grid. What globeTileOps needs to place a fetched 4326 tile's
 * pixels on the sphere, in exactly the role tileNorthWest plays for Mercator
 * tiles today.
 *
 * @param {number} x - tile x index
 * @param {number} y - tile y index
 * @param {number} z - integer zoom level
 * @returns {{lon: number, lat: number}} the tile's NW corner, degrees
 *
 * @example geoTileNorthWest(0, 0, 0) // {lon: -180, lat: 90} (z0's western tile starts at the true NW corner of the world)
 * @example geoTileNorthWest(1, 0, 0) // {lon: 0, lat: 90} (z0's eastern tile starts at the seam meridian)
 * @example geoTileNorthWest(94, 43, 8) // {lon: -74.25, lat: 41.625} (the New York tile's own NW corner, z8)
 */
export function geoTileNorthWest(x, y, z) {
  const level = Math.max(0, Math.min(GEOGRAPHIC_MAX_ZOOM, Math.round(z)));
  const [mw, mh] = GEOGRAPHIC_MATRIX_DIMS[level];
  return geoWorldToLonLat(x / mw, y / mh);
}

/**
 * Pure function. THE GEOGRAPHIC TILE LIST a globe window needs — every 4326
 * tile intersecting the visible window at `z`, and nothing else. The
 * crop-economy twin of tilesForWindow, over the geographic grid: same
 * row-major-from-NW ordering (reproducible request sequence), same X-WRAPS/
 * Y-CLAMPS split (the world is still a cylinder in longitude; a window past a
 * pole still has no tiles beyond row 0 or the last row), same hard cap.
 *
 * @param {{x: number, y: number, w: number, h: number}} window - normalized GEOGRAPHIC world window (lonLatToGeoWorld-shaped rect)
 * @param {number} z - integer tile zoom, clamped into [0, GEOGRAPHIC_MAX_ZOOM]
 * @param {number} [maxTiles] - a hard cap; past it the list is truncated (see TILE_BUDGET)
 * @returns {Array<{x: number, y: number, z: number, wrapped: number}>}
 *
 * @example geoTilesForWindow({x: 0, y: 0, w: 1, h: 1}, 0) // [{x: 0, y: 0, z: 0, wrapped: 0}, {x: 1, y: 0, z: 0, wrapped: 0}] (the whole z0 world is its 2x1 pair)
 * @example geoTilesForWindow({x: 0, y: 0, w: 0.1, h: 0.1}, 3).length // 1 (a small corner window ⇒ one tile — the crop economy holds here too)
 * @example geoTilesForWindow({x: 0.95, y: 0.4, w: 0.2, h: 0.1}, 3).map((t) => t.x) // [9, 0, 1] (across the date line: the world repeats, exactly as the Mercator grid does)
 */
export function geoTilesForWindow(window, z, maxTiles = TILE_BUDGET) {
  const level = Math.max(0, Math.min(GEOGRAPHIC_MAX_ZOOM, Math.round(z)));
  const [mw, mh] = GEOGRAPHIC_MATRIX_DIMS[level];
  const x0 = Math.floor(window.x * mw), x1 = Math.ceil((window.x + window.w) * mw) - 1;
  const y0 = Math.max(0, Math.floor(window.y * mh));
  const y1 = Math.min(mh - 1, Math.ceil((window.y + window.h) * mh) - 1);
  const out = [];
  for (let ty = y0; ty <= y1 && out.length < maxTiles; ty++)
    for (let tx = x0; tx <= x1 && out.length < maxTiles; tx++) {
      const wrapped = Math.floor(tx / mw);
      out.push({ x: ((tx % mw) + mw) % mw, y: ty, z: level, wrapped });
    }
  return out;
}

/**
 * Pure function. THE GEOGRAPHIC TILE ZOOM a globe render should request — the
 * view-resolution law's 4326 twin. Composes exactly like tileZoomFor (widget
 * zoom + camera device-px-per-world-unit, rounded and clamped to the
 * provider's own ceiling), but against GEOGRAPHIC_TILE_SIZE (512, not 256):
 * using the Mercator tile size here would ask for tiles a full stop too deep,
 * since a 512-px 4326 tile already covers as much screen space as two 256-px
 * Mercator tiles at the "same" zoom number.
 *
 * @param {number} zoom - the widget's own continuous zoom property
 * @param {number} widgetPx - the widget's on-screen extent in WORLD units (its box w)
 * @param {number} devicePerWorld - camera device px per world unit (view.zoom · view.dpr)
 * @param {number} [maxZoom] - the provider's deepest available level (defaults to GEOGRAPHIC_MAX_ZOOM)
 * @returns {number} an integer tile zoom in [0, maxZoom]
 *
 * @example geoTileZoomFor(0, 256, 1) // 0 (a 256-px box at zoom 0 needs less than one 512-px tile's worth of resolution)
 * @example geoTileZoomFor(0, 512, 1) // 0 (twice the pixels: still under one 512-px tile of resolution)
 * @example geoTileZoomFor(3, 256, 4, 8) // 4 (the CAMERA zoomed in 4x ⇒ two levels deeper — ONE LESS than tileZoomFor's own 5 at these same inputs, because a 512-px geo tile already covers what two 256-px Mercator tiles cover at "the same" zoom number: the numbering genuinely differs between the two pyramids, and it is a documented divergence rather than a bug)
 * @example geoTileZoomFor(30, 256, 1, 8) // 8 (clamped at the geographic ceiling)
 */
export function geoTileZoomFor(zoom, widgetPx, devicePerWorld, maxZoom = GEOGRAPHIC_MAX_ZOOM) {
  const pxPerWorld = Math.max(1e-6, widgetPx * Math.max(1e-6, devicePerWorld));
  const z = (zoom ?? 0) + Math.log2(pxPerWorld / GEOGRAPHIC_TILE_SIZE);
  return Math.max(0, Math.min(Math.round(maxZoom), Math.round(z)));
}

/**
 * Pure function. The GEOGRAPHIC WINDOW a globe's crop-economy pass reads — the
 * 4326-pyramid twin of mapWorldWindow, over the geographic lon/lat map
 * (lonLatToGeoWorld) instead of Mercator's.
 *
 * SCALED BY TILE_SIZE, NOT GEOGRAPHIC_TILE_SIZE — this is NOT a copy-paste typo
 * left uncorrected; an earlier draft of this function used
 * GEOGRAPHIC_TILE_SIZE and it was WRONG, caught by a live crossfade screenshot
 * that showed FAR fewer geographic tiles resolving than Mercator ones at the
 * same view (measured: 4 geographic tiles fetched against 36 Mercator ones for
 * an identical box/zoom — a 2x-too-narrow window, exactly (512/256)). The
 * window a widget shows is a function of its OWN `zoom` PROPERTY and its box
 * size ALONE: `zoom` is one shared value driving both the flat Mercator
 * rendering and the globe's rendering of the SAME PLACE, so "how much of the
 * world is visible" cannot depend on which pyramid happens to answer that
 * question — only the DEPTH each pyramid fetches at may legitimately differ
 * (geoTileZoomFor already accounts for the 512px tile size correctly, exactly
 * once, at the zoom-selection step). Scaling the WINDOW by the tile size too
 * would double-count that factor into a window half as wide as the Mercator
 * one shows for the identical box — which is precisely the bug this note
 * exists to prevent someone from reintroducing.
 *
 * @param {number} lon - centre longitude, degrees
 * @param {number} lat - centre latitude, degrees (unclamped: a globe can centre on a pole)
 * @param {number} zoom - the widget's continuous zoom
 * @param {number} w - the widget's box width (world units)
 * @param {number} h - the widget's box height (world units)
 * @returns {{x: number, y: number, w: number, h: number}} the window in normalized GEOGRAPHIC world units
 *
 * @example mapGeoWorldWindow(0, 0, 0, 256, 256) // {x: 0, y: 0, w: 1, h: 1} (z0 in a 256-box: the whole geographic world — SAME box size as mapWorldWindow's own z0 example)
 * @example mapGeoWorldWindow(0, 0, 1, 256, 256) // {x: 0.25, y: 0.25, w: 0.5, h: 0.5} (one level in: a quarter of the world, centred)
 * @example mapGeoWorldWindow(0, 0, 0, 512, 256) // {x: -0.5, y: 0, w: 2, h: 1} (a wide box at z0 runs off both edges, exactly as mapWorldWindow's own example does)
 * @example // AT IDENTICAL (lon, lat, zoom, w, h), the two windows are IDENTICAL widths:
 * mapGeoWorldWindow(8, 24, 4.9, 600, 600).w === mapWorldWindow(8, 24, 4.9, 600, 600).w
 * true
 */
export function mapGeoWorldWindow(lon, lat, zoom, w, h) {
  const scale = TILE_SIZE * Math.pow(2, zoom ?? 0);
  const centre = lonLatToGeoWorld(lon, lat);
  const ww = (w || 1) / scale, wh = (h || 1) / scale;
  return { x: centre.x - ww / 2, y: centre.y - wh / 2, w: ww, h: wh };
}

/**
 * Pure function. THE GLOBE'S INVERSE PROJECTION: a point on the unit disc →
 * the longitude/latitude beneath it, or null when the point is OFF the disc
 * (outside the planet's silhouette, where there is no surface to name).
 *
 * ── THE MATH, ORTHOGRAPHIC ───────────────────────────────────────────────────
 * With the view centred at (λ₀, φ₀), the standard inverse orthographic
 * projection (Snyder, *Map Projections — A Working Manual*, eqs. 20-14/20-15) is:
 *
 *     ρ = √(u² + v²),   c = asin(ρ)                     (angular distance from centre)
 *     φ = asin(cos c · sin φ₀ + v · sin c · cos φ₀ / ρ)
 *     λ = λ₀ + atan2(u · sin c, ρ · cos c · cos φ₀ − v · sin c · sin φ₀)
 *
 * ρ = 0 (the exact centre of the disc) is the removable singularity — the centre
 * of the view is the centre of the view, so it answers (λ₀, φ₀) directly rather
 * than dividing by zero.
 *
 * `v` points NORTH here (up on screen is up on the globe), so a caller working in
 * screen coordinates, where y grows downward, negates before calling. Stating the
 * convention in the signature is what keeps that flip in ONE place.
 *
 * @param {number} u - disc x in [−1, 1], east-positive
 * @param {number} v - disc y in [−1, 1], NORTH-positive
 * @param {number} centerLon - the globe's centre longitude, degrees
 * @param {number} centerLat - the globe's centre latitude, degrees
 * @returns {{lon: number, lat: number}|null} null when u² + v² > 1 (off the planet)
 *
 * @example sphereLonLatAt(0, 0, 0, 0) // {lon: 0, lat: 0} (the disc centre IS the view centre)
 * @example sphereLonLatAt(0, 0, -74, 40) // {lon: -74, lat: 40} (whatever the centre is)
 * @example sphereLonLatAt(2, 0, 0, 0) // null (off the disc: no planet there)
 * @example sphereLonLatAt(1, 0, 0, 0) // {lon: 90, lat: 0} (the eastern limb is a quarter turn away)
 * @example sphereLonLatAt(0, 1, 0, 0) // {lon: 0, lat: 90} (the top of a globe centred on the equator is the north pole)
 */
export function sphereLonLatAt(u, v, centerLon, centerLat) {
  const rho = Math.hypot(u, v);
  if (rho > 1) return null;
  if (rho === 0) return { lon: wrapLon(centerLon), lat: centerLat };
  const c = Math.asin(Math.min(1, rho));
  const lat0 = (centerLat * Math.PI) / 180;
  const sinC = Math.sin(c), cosC = Math.cos(c);
  const sinLat0 = Math.sin(lat0), cosLat0 = Math.cos(lat0);
  const lat = Math.asin(cosC * sinLat0 + (v * sinC * cosLat0) / rho);
  const lon = Math.atan2(u * sinC, rho * cosC * cosLat0 - v * sinC * sinLat0);
  return { lon: wrapLon(centerLon + (lon * 180) / Math.PI), lat: (lat * 180) / Math.PI };
}

/**
 * Pure function. The FORWARD orthographic projection — lon/lat → the disc point
 * that shows it, plus whether that point is on the VISIBLE hemisphere. The
 * inverse of sphereLonLatAt, and what a caller needs to place a marker or to
 * decide whether a tile is even facing the viewer.
 *
 * `visible` is the cosine test: a point is on the near hemisphere exactly when
 * the angular distance from the view centre is under 90°, i.e. when
 * `sin φ · sin φ₀ + cos φ · cos φ₀ · cos(λ − λ₀) ≥ 0`. A point on the FAR side
 * still projects to a disc coordinate (the projection is not injective over the
 * whole sphere), so returning the flag rather than null lets a culler use it
 * without recomputing the geometry.
 *
 * `cosC` (that same cosine, signed and un-thresholded) IS ALSO RETURNED, because
 * `visible` alone is a HARD boolean at exactly the wrong place for antialiasing:
 * `rho = sqrt(u²+v²)` — the disc-radius the limb feather (discCoverageFraction)
 * reads — and `cosC` agree ONLY for a point genuinely ON the unit sphere (there,
 * rho = sin(c) and cosC = cos(c), so cosC≥0 ⟺ rho≤1 exactly). A point whose
 * great-circle distance from the view centre is just past 90° in ONE axis (say
 * longitude) but offset in another (say latitude) can still have rho comfortably
 * under 1 while cosC is already negative — the back hemisphere's near-limb
 * points project into the SAME disc area as the front hemisphere's limb. rho
 * cannot see this; cosC is the ONLY continuous signal that tells a front-facing
 * near-limb quad corner apart from a back-facing one at the same rho. This is
 * why globeQuadRect's coverage fraction is NOT `discCoverageFraction` on rho
 * alone — it needs cosC as an independent per-corner gate, continuous rather
 * than boolean, precisely at the boundary this matters.
 *
 * @param {number} lon - degrees
 * @param {number} lat - degrees
 * @param {number} centerLon - the globe's centre longitude, degrees
 * @param {number} centerLat - the globe's centre latitude, degrees
 * @returns {{u: number, v: number, visible: boolean, cosC: number}} v is NORTH-positive
 *
 * @example sphereProject(0, 0, 0, 0) // {u: 0, v: 0, visible: true, cosC: 1} (the centre projects to the centre, facing the viewer dead-on)
 * @example Math.abs(sphereProject(90, 0, 0, 0).cosC) < 1e-15 // true (a quarter turn east is EXACTLY the limb: grazing incidence, cosC ~ 0)
 * @example sphereProject(180, 0, 0, 0).visible // false (the antipode faces away)
 * @example Math.abs(sphereProject(0, 90, 0, 0).cosC) < 1e-15 // true (the pole, from the equator, is also exactly the limb)
 */
export function sphereProject(lon, lat, centerLon, centerLat) {
  const dLon = ((wrapLon(lon - centerLon)) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180, phi0 = (centerLat * Math.PI) / 180;
  const cosC = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dLon);
  return {
    u: Math.cos(phi) * Math.sin(dLon),
    v: Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dLon),
    visible: cosC >= 0,
    cosC,
  };
}

/**
 * Pure function. THE ANALYTIC LIMB FEATHER: given the minimum and maximum
 * `cosC` (the signed cosine of angular distance from the view centre —
 * sphereProject's `cosC`) spanned by a quad's four projected corners, returns
 * what FRACTION of that band lies on the VISIBLE side (cosC ≥ 0).
 *
 * THIS IS THE FIX FOR THE FACETED SILHOUETTE. The old rule was a hard boolean —
 * a quad was either fully drawn or fully dropped (globeQuadRect's `visible`) —
 * which is exactly a one-pixel-wide staircase of quad edges at the limb: the
 * "cookie-cutter" look the user's critique names. Weighting each quad's opacity
 * by this fraction instead turns that staircase into a smooth falloff.
 *
 * WHY cosC AND NOT rho (a correction to this function's first draft): the disc
 * radius `rho = sqrt(u²+v²)` looked like the natural feather variable — it is
 * what the atmosphere shader itself normalizes by — but rho is NOT a reliable
 * limb signal for a projected quad CORNER, only for a point genuinely centred
 * in the view's own great-circle sense. A corner whose great-circle distance
 * from the view centre exceeds 90° in a COMBINED lon+lat sense can still have
 * rho comfortably under 1 (the back hemisphere's near-limb geometry projects
 * into the same disc area as the front hemisphere's limb — sphereProject's own
 * docblock states this: "a point on the FAR side still projects to a disc
 * coordinate"). Measured directly: a real quad corner at rho=0.99998 (visibly
 * INSIDE the disc by the rho test) had cosC < 0 (genuinely facing away) —
 * verified against tests/globe_limb_feather_test.js while building this fix.
 * `cosC`, by contrast, IS the true angular test (sphereProject's `visible` is
 * just `cosC >= 0`, thresholded), and — critically for the SAME closed-form
 * reasoning that motivated using rho — cosC is ALSO exactly linear in angular
 * distance near the boundary, so the identical straddle formula applies with
 * the boundary at 0 instead of 1: a quad whose cosC band straddles zero has a
 * visible fraction of exactly `cosC1 / (cosC1 - cosC0)`, clamped to [0, 1] (the
 * band's fraction that lies above zero, given cosC decreases as cosC0 -> cosC1
 * moves away from the view centre). This needs no derivative intrinsic at all:
 * cosC0/cosC1 are already known from the quad's own corners, computed once per
 * quad, not once per pixel (this file's header, "WHY NO fwidth").
 *
 * A quad entirely visible (cosC0 ≥ 0, the CLOSED half-space — a corner exactly
 * AT the limb still counts as visible) is fully covered; entirely hidden
 * (cosC1 ≤ 0, and NOT already caught by the first test) is fully dropped.
 *
 * @param {number} cosC0 - the smaller (more hidden) corner cosC
 * @param {number} cosC1 - the larger (more visible) corner cosC
 * @returns {number} coverage fraction in [0, 1]
 *
 * @example discCoverageFraction(0.6, 0.9) // 1 (fully visible, nowhere near the limb)
 * @example discCoverageFraction(-0.3, -0.1) // 0 (fully hidden — round the back)
 * @example discCoverageFraction(-0.1, 0.1) // 0.5 (straddles the limb evenly: half the band is visible)
 * @example discCoverageFraction(0, 0.3) // 1 (the more-hidden corner sits exactly ON the limb: the closed half-space counts it visible)
 * @example discCoverageFraction(0, 0) // 1 (a degenerate band exactly ON the limb: still the closed-half-space edge, not hidden)
 */
export function discCoverageFraction(cosC0, cosC1) {
  if (cosC0 >= 0) return 1;
  if (cosC1 <= 0) return 0;
  return Math.max(0, Math.min(1, cosC1 / (cosC1 - cosC0)));
}

/**
 * Pure function. ADAPTIVE GLOBE SUBDIVISION: how many quads a tile is split into
 * per axis when drawn on the sphere, as a function of the globe's ACTUAL on-screen
 * radius in device px — replacing a single fixed constant.
 *
 * WHY ADAPTIVE (the CesiumJS principle, applied without a mesh/LOD tree): a real
 * quadtree globe renderer (CesiumJS) chooses patch density from projected
 * SCREEN-SPACE ERROR, not a fixed count — denser where the sphere occupies more
 * pixels, coarser where it does not, because a facet's visible size is a SCREEN
 * quantity, not a geometry quantity. This app has no patch quadtree to hang that
 * on, but the same principle is one line here: a 40-px thumbnail globe wastes
 * cycles at a subdivision fine enough for a 900-px presentation globe, and,
 * conversely, a 900-px globe at the OLD fixed 16 visibly facets (exactly the
 * screenshot the user's critique points at) because 16 quads across a tile
 * spanning tens of degrees is nowhere near enough arc-per-quad at that pixel
 * count.
 *
 * THE LAW: quads-per-tile-edge scales so that ONE QUAD SPANS ROUGHLY
 * `PX_PER_QUAD_EDGE` device px of the globe's own diameter — i.e. subdivision
 * grows with radius, not with zoom or tile depth (a tile's OWN footprint in
 * degrees already shrinks as zoom deepens, which is a separate effect this
 * function does not need to know about). Clamped to [MIN, MAX] so a tiny globe
 * is never sub-4 (a single quad IS a visible flat facet) and a huge one never
 * asks for a quadratic-cost grid with no visible benefit past the display's own
 * resolution.
 *
 * @param {number} radiusPx - the globe's on-screen radius, DEVICE px (min(w,h)/2 · devicePerWorld)
 * @returns {number} an even integer quad count per tile edge
 *
 * @example globeSubdivisionsFor(20) // 4 (a tiny thumbnail globe: coarse is invisible at this size)
 * @example globeSubdivisionsFor(200) // 16 (the old fixed constant, recovered at the size it was tuned for)
 * @example globeSubdivisionsFor(500) // 40 (a large presentation globe: finer facets where they would otherwise show)
 * @example globeSubdivisionsFor(1e6) // 64 (clamped: past this, more quads buy nothing visible)
 */
export function globeSubdivisionsFor(radiusPx) {
  const raw = Math.round((2 * Math.max(0, radiusPx)) / PX_PER_QUAD_EDGE / 2) * 2;
  return Math.max(GLOBE_SUBDIVISIONS_MIN, Math.min(GLOBE_SUBDIVISIONS_MAX, raw || GLOBE_SUBDIVISIONS_MIN));
}

/** Target device px spanned by one quad's edge across the globe's diameter — the
 *  ratio that calibrates globeSubdivisionsFor. 25 recovers 16 subdivisions at a
 *  200px radius (the size the original fixed constant was tuned and measured
 *  against — see git history on GLOBE_SUBDIVISIONS), so existing decks at that
 *  size render unchanged while other sizes now scale correctly. */
const PX_PER_QUAD_EDGE = 25;

/** Subdivision floor: below 4 quads per edge a single facet is a large enough
 *  fraction of a tiny globe's diameter to read as an obviously flat polygon
 *  rather than a curve, regardless of how few pixels it occupies. */
const GLOBE_SUBDIVISIONS_MIN = 4;

/** Subdivision ceiling: 64 quads per tile edge is 4096 quads for one tile; past
 *  this the facet size is already sub-pixel at any realistic widget size, so
 *  more quads cost real time (image ops are not free) for zero visible gain. */
const GLOBE_SUBDIVISIONS_MAX = 64;

/**
 * The zoom at which the GLOBE gives way to the FLAT map, and the width of the
 * crossfade around it.
 *
 * WHY z ≈ 5, argued rather than picked: at zoom z the visible window spans about
 * 360/2^z degrees of longitude, so z=5 is roughly 11° — a large country. Below
 * that the curvature of the earth is a real, visible feature of the picture and a
 * globe is the honest rendering; above it the window is small enough that the
 * sphere is indistinguishable from its tangent plane, and a flat map is both
 * truer to what a viewer expects and far cheaper (no per-pixel inverse
 * projection). The ONE-level fade width means the transition takes a full zoom
 * doubling, which reads as a deliberate camera move rather than a pop.
 */
export const GLOBE_FLAT_CROSSOVER = 5;
export const GLOBE_FADE_WIDTH = 1;

/**
 * Pure function. How much GLOBE is in the picture at a given zoom: 1 = a pure
 * sphere, 0 = a pure flat map, and a smooth ramp between. The crossfade is
 * SMOOTHSTEP rather than linear so the blend has zero derivative at both ends —
 * a linear fade visibly "starts" and "stops", which a zoom animation makes
 * obvious.
 *
 * @param {number} zoom - the widget's continuous zoom
 * @returns {number} globe weight in [0, 1]
 *
 * @example globeWeight(0) // 1 (planetary: all globe)
 * @example globeWeight(10) // 0 (street level: all flat map)
 * @example globeWeight(5) // 0.5 (the crossover itself: half and half)
 * @example globeWeight(4) // 1 (a level out from the crossover: still all globe)
 */
export function globeWeight(zoom) {
  const t = ((zoom ?? 0) - (GLOBE_FLAT_CROSSOVER - GLOBE_FADE_WIDTH)) / (2 * GLOBE_FADE_WIDTH);
  const c = Math.max(0, Math.min(1, t));
  return 1 - c * c * (3 - 2 * c); // smoothstep, inverted (globe fades OUT as zoom rises)
}

/**
 * One coordinate's regex: an optional sign, digits, an optional decimal part, an
 * optional degree mark (° or the word "deg", with optional whitespace before it),
 * and an optional N/S/E/W suffix (also with optional whitespace before it). Used
 * TWICE inside COORD_PAIR — once per half of a pair — so lat and lon accept
 * exactly the same vocabulary and neither copy can drift from the other.
 */
const COORD_NUMBER = `[+-]?\\d+(?:\\.\\d+)?\\s*(?:°|deg)?\\s*[NSEWnsew]?`;

/** Two COORD_NUMBERs separated by a comma-and/or-whitespace run — the ENTIRE
 *  field must match (anchored both ends), which is what makes "40.7128" (only
 *  one number) and "banana" (no number) refuse instead of partially matching. */
const COORD_PAIR = new RegExp(`^(${COORD_NUMBER})\\s*(?:,\\s*|\\s+)(${COORD_NUMBER})$`);

/**
 * Pure function. Parses ONE coordinate token (a signed number, an optional degree
 * mark, an optional hemisphere suffix) into a signed decimal degree, or null when
 * the text is not a coordinate at all. A hemisphere suffix OVERRIDES any leading
 * sign — "-74W" is the same point as "74W" (both 74° west) — because a suffix is
 * the more explicit statement of hemisphere and a user pasting a search result's
 * "74.5 W" should not have to also remember a sign convention.
 *
 * @param {string} token - one coordinate, already isolated from its pair
 * @returns {number|null}
 *
 * @example parseCoordToken("40.7128") // 40.7128
 * @example parseCoordToken("74.006W") // -74.006 (a suffix sets the sign)
 * @example parseCoordToken("-74.006W") // -74.006 (a leading sign AND a suffix agree)
 * @example parseCoordToken("33.5S") // -33.5
 * @example parseCoordToken("12.3°N") // 12.3 (a degree mark is just punctuation)
 * @example parseCoordToken("banana") // null
 */
function parseCoordToken(token) {
  const m = new RegExp(`^(${COORD_NUMBER})$`).exec(token.trim());
  if (!m) return null;
  const inner = /^([+-]?\d+(?:\.\d+)?)\s*(?:°|deg)?\s*([NSEWnsew]?)$/.exec(m[1]);
  const magnitude = Math.abs(Number(inner[1]));
  const suffix = inner[2].toUpperCase();
  if (suffix === "S" || suffix === "W") return -magnitude;
  if (suffix === "N" || suffix === "E") return magnitude;
  return Number(inner[1]); // no suffix: the leading sign (or its absence) stands
}

/**
 * Pure function. Parses a FLEXIBLE lat/lon pair — the popup's coordinate field —
 * into `{lon, lat}` degrees, or null when the text names no coordinate pair at
 * all. Accepts every shape a person pastes from a map, a GPS unit or a search
 * result: comma OR whitespace between the two numbers, an optional ° mark, and
 * an optional N/S/E/W suffix on either or both halves. THE ORDER IS ALWAYS
 * LAT, LON (the universal convention — "40.7128, -74.0060" reads latitude
 * first), matching what every map service, GPS device and this app's OWN
 * floating-toolbar Lat/Lon fields already show.
 *
 * A HEMISPHERE SUFFIX DISAMBIGUATES THE ORDER when one is given: if the first
 * token carries E/W and the second carries N/S, the pair is read as (lon, lat)
 * instead — "74.006W, 40.7128N" is unambiguous regardless of which position it
 * is typed in, and refusing to honour that would penalize the more explicit
 * input. With no suffixes at all (the common case), lat-then-lon stands.
 *
 * Latitude is CLAMPED and longitude WRAPPED exactly as every other write path
 * in this module does (clampLat/wrapLon), so a typo like "95, 200" lands at a
 * legal point rather than an invalid one.
 *
 * @param {string} text - the typed field value
 * @returns {{lon: number, lat: number}|null} null when unparseable
 *
 * @example parseLatLon("40.7128, -74.0060") // {lat: 40.7128, lon: -74.00599999999997}
 * @example parseLatLon("40.7128 -74.0060") // {lat: 40.7128, lon: -74.00599999999997} (whitespace instead of a comma)
 * @example parseLatLon("40.7128N, 74.0060W") // {lat: 40.7128, lon: -74.00599999999997} (suffixes spell the sign)
 * @example parseLatLon("74.0060W, 40.7128N") // {lat: 40.7128, lon: -74.00599999999997} (E/W-then-N/S reorders to lat,lon)
 * @example parseLatLon("33.5S 151.2E") // {lat: -33.5, lon: 151.20000000000005} (Sydney, southern + eastern hemispheres)
 * @example parseLatLon("12.3° N, 45.6° E") // {lat: 12.3, lon: 45.60000000000002} (a degree mark either side of the space)
 * @example parseLatLon("95, 200") // {lat: 85.05112877980659, lon: -160} (clamped + wrapped, not refused)
 * @example parseLatLon("banana") // null
 * @example parseLatLon("40.7128") // null (a pair needs two numbers)
 */
export function parseLatLon(text) {
  const m = COORD_PAIR.exec(String(text).trim());
  if (!m) return null;
  const a = parseCoordToken(m[1]);
  const b = parseCoordToken(m[2]);
  if (a === null || b === null) return null;
  const suffixOf = (s) => (/[EWew]$/.test(s.trim()) ? "lon" : /[NSns]$/.test(s.trim()) ? "lat" : null);
  // (lon, lat) ordering is honoured ONLY when the suffixes say so unambiguously;
  // any other combination (both blank, both the same axis, or only one given)
  // falls through to the universal lat-then-lon reading.
  const reordered = suffixOf(m[1]) === "lon" && suffixOf(m[2]) === "lat";
  const [lat, lon] = reordered ? [b, a] : [a, b];
  return { lat: clampLat(lat), lon: wrapLon(lon) };
}
