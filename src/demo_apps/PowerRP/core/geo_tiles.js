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
 * @param {number} lon - degrees
 * @param {number} lat - degrees
 * @param {number} centerLon - the globe's centre longitude, degrees
 * @param {number} centerLat - the globe's centre latitude, degrees
 * @returns {{u: number, v: number, visible: boolean}} v is NORTH-positive
 *
 * @example sphereProject(0, 0, 0, 0) // {u: 0, v: 0, visible: true} (the centre projects to the centre)
 * @example sphereProject(90, 0, 0, 0) // {u: 1, v: 0, visible: true} (a quarter turn east is the limb)
 * @example sphereProject(180, 0, 0, 0).visible // false (the antipode faces away)
 * @example sphereProject(0, 90, 0, 0) // {u: 0, v: 1, visible: true} (the pole is the top of the disc)
 */
export function sphereProject(lon, lat, centerLon, centerLat) {
  const dLon = ((wrapLon(lon - centerLon)) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180, phi0 = (centerLat * Math.PI) / 180;
  const cosC = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dLon);
  return {
    u: Math.cos(phi) * Math.sin(dLon),
    v: Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dLon),
    visible: cosC >= 0,
  };
}

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
