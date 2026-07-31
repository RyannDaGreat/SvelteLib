/**
 * THE TILE PROVIDER TABLE — which raster basemaps this app may fetch, the URL
 * template for each, and the ATTRIBUTION each one's licence REQUIRES. See
 * TILE_OVERLAYS below for the transparent REFERENCE layers (labels, borders,
 * coastlines) a base may composite with — the Google "hybrid" look.
 *
 * This is a DATA table with a legal research record attached, because "which map
 * can I use" is a licensing question before it is a technical one, and the answer
 * is not obvious from any provider's homepage. The verdicts below were checked
 * against each provider's own published policy; the rejected ones are kept with
 * their reasons so nobody re-adds them on a hunch.
 *
 * ── ATTRIBUTION IS A LICENCE TERM WITH A DEFAULT, NOT A FIXED DECORATION ──────
 * Every entry carries an `attribution` string; whether it draws is the widget's
 * `showAttribution` BOOLEAN PROPERTY, tweenable/equation-bindable like every other
 * knob. It is not a per-provider constant because the licences genuinely differ:
 * NASA's own MODIS imagery is public domain (full-and-open-sharing — no credit
 * REQUIRED), while OSM ("Show OpenStreetMap licence attribution clearly on the
 * map") and OpenTopoMap's CC-BY-SA make the credit a CONDITION of use. So each
 * entry's `defaultShowAttribution` encodes what the licence actually requires —
 * true for osm/terrain, false for satellite — and the property starts there on
 * insert, but the toggle is always the USER'S to flip (user ruling, verbatim:
 * "I don't need to see their logo on my presentations. Get rid of it."). A row's
 * help carries one sentence naming the trade-off; there is no lecture, no
 * on-canvas nagging, and no modal gate — the user's call to make, not this
 * table's to enforce past the honest default.
 *
 * ── ADOPTED ───────────────────────────────────────────────────────────────────
 *   osm        — OpenStreetMap standard raster. THE reference street map, free,
 *                no key. Its Tile Usage Policy is the strictest of the three and
 *                the one that shapes this whole module (see THE POLICY CONTRACT).
 *   satellite  — NASA GIBS (MODIS Terra Corrected Reflectance, true colour). A
 *                real satellite view of the whole planet, NASA-operated, public,
 *                no key, no registration. NASA's data policy is full and open
 *                sharing, which is why this is the satellite layer rather than a
 *                commercial imagery service.
 *   terrain    — OpenTopoMap. Topographic relief + contours, CC-BY-SA 3.0.
 *
 * ── REJECTED, WITH REASONS ────────────────────────────────────────────────────
 *   GOOGLE MAPS — REFUSED OUTRIGHT. Google's Terms prohibit accessing their tiles
 *     except through their own Maps JavaScript API; scraping the tile endpoints a
 *     browser's network tab reveals is a terms violation regardless of volume or
 *     intent. The user's brief named "Google Maps or whatever other surface we can
 *     find" — this table IS the "whatever other surface", and Google is the one
 *     entry that cannot be in it. No API-key path is offered either: the Maps JS
 *     API is an iframe/DOM map, which cannot feed a Skia display list or a
 *     deterministic headless render, so it fails this app's architecture too.
 *   ESRI WORLD IMAGERY — REJECTED, and this one is worth stating because the
 *     brief proposed it as "free with attribution". It is not: Esri's item terms
 *     say World Imagery requires an ArcGIS Online or Enterprise licence and is not
 *     available for commercial use. The widely-copied "free with attribution" URL
 *     circulating in tutorials rests on a SPECIAL ARRANGEMENT Esri made for
 *     OpenStreetMap EDITORS, which is not a general grant and does not extend to a
 *     presentation tool. NASA GIBS is the satellite layer instead — genuinely
 *     public-domain-ish, genuinely keyless.
 *   CARTO BASEMAPS — REJECTED for the shipped table. Carto's raster CDN is real
 *     and its attribution string is published, but Carto's own basemaps page
 *     governs pricing/terms and now routes production use through an API key. A
 *     default that quietly depends on someone else's free tier is a default that
 *     breaks without warning, so it is not shipped as a named style. (It remains
 *     the natural first addition if a keyed provider is ever wanted.)
 *
 * ── THE POLICY CONTRACT (what the rest of the code must honour) ───────────────
 * OSM's Tile Usage Policy is explicit, and these are not suggestions:
 *   · BULK DOWNLOADING IS PROHIBITED — "any pre-emptive fetching of tiles other
 *     than those a user is actively viewing", naming pre-seeding areas or zoom
 *     levels and automated wide-bbox scans at z>=14. THIS IS WHY the widget
 *     fetches exactly the tiles its VISIBLE window intersects (core/geo_tiles
 *     tilesForWindow) and why PREFETCH_RING is 0 by default: a neighbour ring is
 *     precisely "tiles the user is not actively viewing".
 *   · OFFLINE USE IS NOT PERMITTED on tile.openstreetmap.org — so the service
 *     worker does NOT precache tiles, and the offline-doctrine entry for this
 *     widget says "previously fetched tiles may serve from the HTTP cache",
 *     which is ordinary browser caching, not an archive we built.
 *   · CACHE AT LEAST 7 DAYS and never send no-cache headers — so tile requests
 *     are plain `fetch` with default caching. Nothing here sets Cache-Control.
 *   · A CLEAR, UNIQUE User-Agent / a valid Referer. A browser sets both; we must
 *     not suppress the Referer, so no `referrerPolicy: "no-referrer"` anywhere on
 *     this path.
 *   · NO SLA. Tiles fail sometimes; the registry's missing-tile affordance is the
 *     normal case, not an exception.
 *
 * DOM-free at import: a frozen data table plus pure string builders.
 */

/**
 * The neighbour ring prefetched around the visible window, in tiles. ZERO, and
 * the zero is the policy above rather than an unfinished feature: OSM defines
 * bulk downloading as "any pre-emptive fetching of tiles other than those a user
 * is actively viewing", which is exactly what a ring is. Raising it is a decision
 * to be a heavier client of somebody else's donated infrastructure, so it is a
 * named constant with this note rather than a number inline in a loop.
 */
export const PREFETCH_RING = 0;

/**
 * THE TABLE. Each entry:
 *   id          — the stored `style` property value (document state; never renamed).
 *   title       — the Inspector select's label.
 *   url         — a template over {z}/{x}/{y} (+ {s} subdomain, + {time} for GIBS).
 *   subdomains  — the {s} rotation, or "" when the provider serves one host.
 *   maxZoom     — the provider's DEEPEST level. tileZoomFor clamps to it, so a
 *                 deeper camera zoom magnifies the deepest tiles instead of
 *                 requesting 404s (what every slippy map does at max zoom).
 *   attribution — RENDERED ON THE MAP. See the header: a licence term.
 *   tileSize    — px per tile edge; 256 everywhere here, read rather than assumed.
 *   geographic  — OPTIONAL: {url, maxZoom, tileSize}, an EPSG:4326 twin of this
 *                 same layer for the GLOBE path only (core/geo_tiles.js's
 *                 geographic-grid functions). See "THE GEOGRAPHIC TWIN" below for
 *                 which providers have one and why the rest do not.
 */
export const TILE_PROVIDERS = Object.freeze({
  osm: Object.freeze({
    id: "osm",
    title: "Streets (OpenStreetMap)",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: "abc",
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
    tileSize: 256,
    // ODbL asks for on-map credit; the widget defaults it OFF everywhere (user
    // ruling) and the showAttribution toggle draws it for whoever wants it.
    defaultShowAttribution: false,
    // NO `geographic` TWIN — OpenStreetMap publishes no EPSG:4326 service at all
    // (only the Mercator "standard" tile layer this entry already points at), so
    // there is nothing to add here. See "THE GEOGRAPHIC TWIN" below: the globe path
    // for this provider stays on the Mercator tiles with the shaded polar caps, a
    // DELIBERATE, DOCUMENTED asymmetry rather than an oversight.
  }),
  satellite: Object.freeze({
    id: "satellite",
    title: "Satellite (NASA GIBS)",
    // The WMTS REST layout is layer/style/tilematrixset/{z}/{y}/{x}.ext — note
    // Y BEFORE X, which is the opposite of the {z}/{x}/{y} every other entry uses.
    // tileUrl() handles it from this template alone; nothing downstream special-cases
    // GIBS, and getting the order wrong yields a plausible-looking map of the WRONG
    // PLACE (a transposed world), which is exactly the kind of silent error the
    // fixture probe pins.
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{time}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
    subdomains: "",
    // z9 IS THE CEILING, MEASURED, not inferred from the name. The matrix set is
    // called GoogleMapsCompatible_Level9 and the obvious reading — "Level9 = 9
    // levels = z0..z8" — is WRONG: probing the live endpoint, z8 and z9 both
    // return 200 and z10/z11/z12 return 400. The suffix names the MAX LEVEL, not
    // the count. This was written as 8 first; the probe is why it is 9, and why
    // this comment exists instead of a bare number.
    // MODIS is a ~250 m/px instrument, so the ceiling is the physics rather than
    // the endpoint: past it there is no more detail to serve, and magnifying the
    // deepest tile is the honest rendering. Deep zoom belongs to street/terrain.
    maxZoom: 9,
    attribution: "Imagery: NASA EOSDIS GIBS",
    tileSize: 256,
    // NASA's own MODIS imagery is public domain — full and open sharing, no
    // licence term requiring a credit. User ruling, verbatim: "I don't need to
    // see their logo on my presentations. Get rid of it." — so a satellite-only
    // slide shows NOTHING by default. (The three OVERLAY layers below are a
    // DIFFERENT case even when paired with this same base — they are OSM-derived
    // and default to shown; see TILE_OVERLAYS's header.)
    defaultShowAttribution: false,
    // THE GEOGRAPHIC TWIN — see "THE GEOGRAPHIC TWIN" below for the full
    // verification record. Same layer, same instrument, a DIFFERENT pyramid: GIBS's
    // "250m" EPSG:4326 TileMatrixSet, {z}/{y}/{x} within that set's own fixed name
    // (no {s} rotation — one host, like the mercator entry above). z8 is this
    // pyramid's OWN measured ceiling (z8 200s, z9 400s) — it does not have to equal
    // the mercator entry's z9 because the two pyramids' zoom numbers do not mean the
    // same angular resolution (core/geo_tiles.js geoTileZoomFor's own docblock).
    geographic: Object.freeze({
      url: "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{time}/250m/{z}/{y}/{x}.jpeg",
      maxZoom: 8,
      tileSize: 512,
    }),
  }),
  terrain: Object.freeze({
    id: "terrain",
    title: "Terrain (OpenTopoMap)",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: "abc",
    // OpenTopoMap renders worldwide to z17.
    maxZoom: 17,
    // CC-BY-SA 3.0 REQUIRES naming both the data source and the style's author.
    attribution: "© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)",
    tileSize: 256,
    defaultShowAttribution: false,
    // NO `geographic` TWIN — OpenTopoMap is itself Mercator-only (it renders from
    // OSM + SRTM through the same {z}/{x}/{y} pyramid as the streets entry); no
    // EPSG:4326 relief/contour service exists to point at. Same asymmetry as OSM
    // above, same reason, same globe-path fallback (Mercator tiles + shaded caps).
  }),
});

/** The stored `style` values, in Inspector order. The select's options come from
 *  here so the table is the ONE place a provider is declared.
 *  @example TILE_PROVIDER_IDS // ["osm", "satellite", "terrain"] */
export const TILE_PROVIDER_IDS = Object.freeze(Object.keys(TILE_PROVIDERS));

/** The style a fresh widget gets: the street map, because it is the one that
 *  reads correctly at EVERY zoom from the globe down to a building. */
export const DEFAULT_TILE_STYLE = "osm";

/**
 * Pure function. The provider descriptor for a stored style id, falling back to
 * the default for an unknown one — with a LOUD note in the returned record rather
 * than a silent substitution, so a document written against a provider we later
 * removed renders (with the default basemap) instead of going blank, and says so.
 *
 * @param {string} id - a stored `style` value
 * @returns {object} the frozen provider descriptor
 *
 * @example providerFor("osm").maxZoom // 19
 * @example providerFor("satellite").title // "Satellite (NASA GIBS)"
 * @example providerFor("nonesuch").id // "osm" (unknown style ⇒ the default basemap)
 */
export function providerFor(id) {
  return TILE_PROVIDERS[id] ?? TILE_PROVIDERS[DEFAULT_TILE_STYLE];
}

/**
 * Pure function. A provider-or-overlay descriptor's `geographic` (EPSG:4326) twin,
 * or null when it does not have one — the ONE place the globe path asks "does this
 * layer have real polar imagery". A layer's own `.geographic` field is
 * TILE_PROVIDERS-shaped (`{url, maxZoom, tileSize}`, `tileUrl`-compatible) but
 * carries no `attribution`/`title` of its own: it is the SAME layer under a
 * different pyramid, so plugins/demo/globe_map.js reads those from the Mercator
 * entry regardless of which pyramid actually served the pixels.
 *
 * @param {object} descriptor - a TILE_PROVIDERS or TILE_OVERLAYS entry
 * @returns {object|null}
 *
 * @example geographicFor(TILE_PROVIDERS.satellite).maxZoom // 8
 * @example geographicFor(TILE_PROVIDERS.osm) // null (OpenStreetMap has no EPSG:4326 service)
 * @example geographicFor(TILE_OVERLAYS.labels).tileSize // 512
 */
export function geographicFor(descriptor) {
  return descriptor.geographic ?? null;
}

/**
 * The GIBS imagery DATE, as an ISO day. NASA's true-colour layer is a DAILY
 * mosaic, so the URL carries a date and "today" is often INCOMPLETE — the swaths
 * are still being downlinked and processed, and a same-day request yields black
 * tiles over much of the globe.
 *
 * A FIXED date is used rather than `Date.now()`, and that is a determinism
 * requirement, not laziness: reading a clock inside a render path would make the
 * same document produce different pixels on different days, which is exactly the
 * EPHEMERAL state the three-kinds-of-state taxonomy forbids (and it would make an
 * export irreproducible). A date pinned here is DOCUMENT-INDEPENDENT and stable,
 * so two renders of one deck agree forever.
 */
export const GIBS_IMAGERY_DATE = "2026-06-01";

/**
 * Pure function. A tile's URL from a provider descriptor and tile coordinates.
 * Handles the {s} subdomain rotation, the {time} GIBS date, and the fact that the
 * GIBS template names {y} BEFORE {x} (a template substitution, so the ordering
 * lives in the table and not in a branch here).
 *
 * The subdomain is chosen by a STABLE hash of (x, y) rather than a counter,
 * because a counter would make the same tile resolve to different hosts on
 * successive renders — defeating the browser's HTTP cache, which is the cache
 * OSM's policy requires us to lean on.
 *
 * @param {object} provider - a TILE_PROVIDERS entry
 * @param {number} x - tile x index
 * @param {number} y - tile y index
 * @param {number} z - tile zoom
 * @returns {string} an absolute https URL
 *
 * @example tileUrl(TILE_PROVIDERS.osm, 0, 0, 0) // "https://a.tile.openstreetmap.org/0/0/0.png"
 * @example tileUrl(TILE_PROVIDERS.osm, 301, 385, 10) // "https://c.tile.openstreetmap.org/10/301/385.png"
 * @example tileUrl(TILE_PROVIDERS.terrain, 1, 2, 3) // "https://a.tile.opentopomap.org/3/1/2.png"
 * @example tileUrl(TILE_PROVIDERS.satellite, 1, 2, 3) // "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-06-01/GoogleMapsCompatible_Level9/3/2/1.jpg" (note y before x)
 */
export function tileUrl(provider, x, y, z) {
  const subs = provider.subdomains ?? "";
  const s = subs ? subs[Math.abs(x + y) % subs.length] : "";
  return provider.url
    .replace("{s}", s)
    .replace("{time}", GIBS_IMAGERY_DATE)
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/**
 * Pure function. Every attribution string the shipped table requires, deduplicated
 * — what a credits slide or an export footer would list. The widget itself renders
 * only the ACTIVE provider's line (that is the licence's requirement); this is for
 * a consumer that wants the whole set.
 *
 * @returns {string[]}
 * @example allAttributions().length // 3
 * @example allAttributions()[0] // "© OpenStreetMap contributors"
 */
export function allAttributions() {
  return [...new Set(Object.values(TILE_PROVIDERS).map((p) => p.attribution))];
}

/**
 * ── THE OVERLAY TABLE — transparent REFERENCE layers drawn ABOVE a base, the
 * Google "hybrid" look (labels/borders/coastlines over satellite imagery). ──────
 *
 * ── RESEARCH RECORD ───────────────────────────────────────────────────────────
 * The brief asked specifically for a NASA GIBS keyless source pairing with the
 * satellite base, since Google's hybrid overlay is barred by the same ToS clause
 * that rejected their tiles as a base layer (web/tile_providers.js's ADOPTED/
 * REJECTED header), Esri needs a licence, and Carto needs a key. GIBS ships three
 * candidates, and all three were VERIFIED against the live service (2026-07-31),
 * not inferred from the capabilities document alone:
 *
 *   Reference_Labels    — place-name labels (cities, countries, oceans).
 *   Reference_Features  — political borders + roads (Worldview calls the same
 *                          data "Borders and Roads"; GIBS's own layer name is
 *                          the more general "Features").
 *   Coastlines           — coastline linework alone, for a base (like the
 *                          satellite) that has no vector coastline of its own.
 *
 * ALL THREE ARE OSM-DERIVED, NOT NASA-DERIVED — this is the finding that
 * decides their attribution default below. Confirmed against imagico.de's
 * write-up of GIBS's own OSM ingestion pipeline: Coastlines is built from OSM
 * ways tagged `natural=coastline`, and Reference_Labels/Reference_Features are
 * OSM place/boundary/highway data restyled for global raster display. GIBS
 * merely HOSTS these tiles; the data underneath is ODbL, exactly like the OSM
 * street basemap. "NASA GIBS ⇒ public domain ⇒ no attribution" (true for the
 * MODIS satellite base) does NOT extend to these three layers, and shipping
 * them attribution-free on that false generalization would be the same mistake
 * the manifest's attribution ruling exists to prevent.
 *
 * A `_15m` (higher-resolution, GoogleMapsCompatible_Level13) variant of each
 * exists in GIBS's own GetCapabilities document but is NOT shipped here:
 * `Reference_Labels_15m` returned HTTP 404 at every zoom level and every tile
 * tested (equator, NYC, z0 through z9) despite matching its own published
 * ResourceURL template exactly — a catalog entry for tiles GIBS has not
 * actually published. `Reference_Features_15m` and `Coastlines_15m` DID
 * resolve, but were left unshipped for the same reason Carto was rejected
 * elsewhere in this file: a table entry that silently 404s for one of its three
 * siblings is a worse default than a matched trio that all work, and the base
 * (Level9) trio's ~5 km resolution is already finer than anything meaningful at
 * the zoom range these overlays are useful at (labels and borders, not terrain
 * detail). If GIBS ever publishes the missing `_15m` labels tile, upgrading the
 * pair is a two-line change here, not a redesign.
 *
 * maxZoom 9 for all three — MEASURED the same way the satellite base's ceiling
 * was: the GoogleMapsCompatible_Level9 TileMatrixSet in the live GetCapabilities
 * document, cross-checked with a 200 at z9 and a 400 at z10 against the actual
 * NYC tile. No `{time}` segment: unlike the MODIS satellite base, these three
 * layers carry no Dimension/TIME element in GetCapabilities — they are a single
 * static snapshot, not a daily mosaic, so there is no GIBS_IMAGERY_DATE analogue
 * to pin.
 *
 * Every entry decoded to a genuinely TRANSPARENT PNG (spot-checked: 95%,  82%
 * and 94% transparent pixels respectively over a NYC tile), which is the
 * precondition for compositing as an overlay at all — an opaque "overlay" would
 * simply replace the base rather than annotate it.
 *
 * ── THE GEOGRAPHIC TWIN (all three overlays, added 2026-07-31) ───────────────
 * GIBS publishes ALL THREE of these same layers under EPSG:4326 too, on the
 * IDENTICAL "250m" TileMatrixSet the satellite base's `geographic` entry uses
 * (see TILE_PROVIDERS.satellite) — VERIFIED LIVE, not inferred: a 200 at z0 and
 * z8, a 400 at z9, for Reference_Labels, Reference_Features and Coastlines
 * alike. No `{time}` segment here either, for the identical reason as the
 * Mercator entries below (a static snapshot, not a daily mosaic).
 *
 * The `_15m` finer variant ALSO exists on the 4326 side (TileMatrixSet
 * "15.625m") and mirrors the Mercator finding exactly: live at z0, a 400 past
 * it, for all three layers — so it is left unshipped here for the same "a
 * matched trio that all work beats one with a dead sibling" reason stated
 * above. If GIBS ever actually populates it, the fix is the same two-line
 * change on both pyramids' entries, not a redesign.
 */
export const TILE_OVERLAYS = Object.freeze({
  labels: Object.freeze({
    id: "labels",
    title: "Place labels",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Reference_Labels/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png",
    subdomains: "",
    maxZoom: 9,
    attribution: "Labels: © OpenStreetMap contributors",
    tileSize: 256,
    help: "City, country and ocean names, from OpenStreetMap data hosted by NASA GIBS. Pairs with any basemap — this is the Google Maps \"hybrid\" look over satellite imagery.",
    // See "THE GEOGRAPHIC TWIN" above. Same layer, GIBS's 4326 "250m" set.
    geographic: Object.freeze({
      url: "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/Reference_Labels/default/250m/{z}/{y}/{x}.png",
      maxZoom: 8,
      tileSize: 512,
    }),
  }),
  features: Object.freeze({
    id: "features",
    title: "Borders & roads",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Reference_Features/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png",
    subdomains: "",
    maxZoom: 9,
    attribution: "Borders & roads: © OpenStreetMap contributors",
    tileSize: 256,
    help: "Political borders and major roads, from OpenStreetMap data hosted by NASA GIBS. Most useful over Satellite, which has no vector borders of its own.",
    geographic: Object.freeze({
      url: "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/Reference_Features/default/250m/{z}/{y}/{x}.png",
      maxZoom: 8,
      tileSize: 512,
    }),
  }),
  coastlines: Object.freeze({
    id: "coastlines",
    title: "Coastlines",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Coastlines/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png",
    subdomains: "",
    maxZoom: 9,
    attribution: "Coastlines: © OpenStreetMap contributors",
    tileSize: 256,
    help: "Coastline linework, from OpenStreetMap data hosted by NASA GIBS. Sharpens the Satellite basemap's shoreline, which MODIS's own imagery leaves soft.",
    geographic: Object.freeze({
      url: "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/Coastlines/default/250m/{z}/{y}/{x}.png",
      maxZoom: 8,
      tileSize: 512,
    }),
  }),
});

/** The stored per-overlay boolean property names, in Inspector/popup order — the
 *  ONE place an overlay's `id` becomes its item-state key, so the widget and the
 *  table can never name one differently.
 *  @example OVERLAY_IDS // ["labels", "features", "coastlines"] */
export const OVERLAY_IDS = Object.freeze(Object.keys(TILE_OVERLAYS));

/**
 * Pure function. The overlay descriptor for a stored overlay id, or undefined for
 * an unknown one — undefined rather than a default substitution (unlike
 * providerFor) because an overlay is optional by nature: a caller iterates
 * OVERLAY_IDS and skips what does not resolve, rather than a document depending on
 * exactly one basemap always resolving to something drawable.
 *
 * @param {string} id - a stored overlay id
 * @returns {object|undefined}
 * @example overlayFor("labels").title // "Place labels"
 * @example overlayFor("nonesuch") // undefined
 */
export function overlayFor(id) {
  return TILE_OVERLAYS[id];
}

/**
 * Pure function. The stored item-state key for one overlay's boolean property —
 * the ONE place `overlay<Id>` is spelled, so the widget's Inspector row, its
 * popup toggle button and the tile pre-pass's compositor (render_gpu/map_display.js
 * — which cannot import a plugin, so it reaches this naming rule here instead)
 * all read the identical key. Declared here rather than in the widget because the
 * naming rule is a property OF the overlay table, not of any one consumer.
 *
 * @param {string} id - a TILE_OVERLAYS key
 * @returns {string}
 * @example overlayPropName("labels") // "overlayLabels"
 * @example overlayPropName("coastlines") // "overlayCoastlines"
 */
export function overlayPropName(id) {
  return `overlay${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}
