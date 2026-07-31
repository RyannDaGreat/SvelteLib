/**
 * GLOBE / MAP — the bare-node suite. Registration, emit, the projection round
 * trips, the navigator contract, DETERMINISM, and the two laws that are easy to
 * state and easy to break silently: the VIEW-RESOLUTION law (camera zoom raises
 * tile depth) and the CROP ECONOMY law (a zoomed view requests only the tiles it
 * can see).
 *
 * Everything here runs WITHOUT a browser: the pure math lives in core/geo_tiles.js
 * and the tile-selection decision in render_gpu/map_display.js, both DOM-free, so
 * the laws are checkable by arithmetic rather than by screenshot. The browser
 * probe (tests/globe_map_probe.js) covers what genuinely needs pixels.
 *
 * Run: node tests/globe_map_test.js
 */

import assert from "node:assert";
import {
  GLOBE_FLAT_CROSSOVER, MAX_MERCATOR_LAT, TILE_BUDGET, TILE_SIZE, clampLat, globeWeight,
  lonLatToTile, lonLatToWorld, mapWorldWindow, sphereLonLatAt, sphereProject, tileNorthWest,
  tileZoomFor, tilesForWindow, worldToLonLat, wrapLon,
} from "../core/geo_tiles.js";
import { TILE_PROVIDERS, TILE_PROVIDER_IDS, providerFor, tileUrl } from "../web/tile_providers.js";
import { croppedWindow, devicePerWorldUnit } from "../render_gpu/map_display.js";
import { globeMapPlugin, flatTileRect } from "../plugins/demo/globe_map.js";
import { allPlugins } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

/** A folded state for a widget at its defaults, with an explicit box. */
function stateAt(over = {}) {
  return { ...globeMapPlugin.defaults, w: 420, h: 420, ...over };
}

// ── REGISTRATION ────────────────────────────────────────────────────────────

test("the plugin is registered exactly once in the roster", () => {
  const matches = allPlugins.filter((p) => p.type === "demo_globe_map");
  assert.equal(matches.length, 1, "exactly one globe_map plugin in allPlugins");
  assert.equal(matches[0], globeMapPlugin);
});

test("it declares the interior-navigation contract the double-click handler reads", () => {
  // web/interiorNav.NAVIGATE_INTERIOR_HANDLER.claims() keys off `interiorView`, and
  // widget_handlers.migrationPlan fails a widget that ships the descriptor without
  // the activate string. Both halves must be present or the mode silently vanishes.
  assert.equal(globeMapPlugin.activate, "navigate_interior");
  assert.equal(typeof globeMapPlugin.interiorView.window, "function");
  assert.equal(typeof globeMapPlugin.interiorView.writes, "function");
});

test("every preset writes only declared properties", () => {
  // A preset naming a key the widget does not declare would write a property no
  // Inspector row can reach and no serializer round-trips.
  const declared = new Set(Object.keys(globeMapPlugin.defaults));
  for (const preset of globeMapPlugin.presets)
    for (const key of Object.keys(preset.props))
      assert.ok(declared.has(key), `preset "${preset.name}" writes undeclared key "${key}"`);
});

// ── THE PROJECTION ──────────────────────────────────────────────────────────

test("Web Mercator agrees with the canonical OSM tile formula", () => {
  // The reference implementation from the OSM wiki, written out independently here
  // so this is a genuine cross-check rather than a restatement of geo_tiles.
  for (const [lon, lat, z] of [[-74.006, 40.7128, 10], [0, 0, 3], [139.6917, 35.6895, 12], [-0.1276, 51.5074, 8]]) {
    const n = 2 ** z, rad = (lat * Math.PI) / 180;
    const wantX = Math.floor(((lon + 180) / 360) * n);
    const wantY = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    const got = lonLatToTile(lon, lat, z);
    assert.equal(got.x, wantX, `tile x at (${lon}, ${lat}) z${z}`);
    assert.equal(got.y, wantY, `tile y at (${lon}, ${lat}) z${z}`);
  }
});

test("lon/lat -> world -> lon/lat round-trips to float precision", () => {
  for (const [lon, lat] of [[0, 0], [-74.006, 40.7128], [139.69, 35.69], [-179.9, -84], [12, 60]]) {
    const w = lonLatToWorld(lon, lat);
    const back = worldToLonLat(w.x, w.y);
    assert.ok(Math.abs(back.lon - lon) < 1e-9, `lon round trip ${lon} -> ${back.lon}`);
    assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat round trip ${lat} -> ${back.lat}`);
  }
});

test("a tile's NW corner maps back into that same tile", () => {
  // The inverse must land INSIDE the tile it names, not on a neighbour — an
  // off-by-one here tiles the globe with the wrong imagery and looks plausible.
  for (const [x, y, z] of [[0, 0, 0], [301, 385, 10], [1, 2, 3], [511, 511, 9]]) {
    const nw = tileNorthWest(x, y, z);
    // Nudge inward: the NW corner is exactly on the boundary, so the tile it
    // resolves to is decided by floor, and a point a hair inside is unambiguous.
    const inside = lonLatToTile(nw.lon + 1e-9, nw.lat - 1e-9, z);
    assert.equal(inside.x, x, `tile x for (${x},${y},${z})`);
    assert.equal(inside.y, y, `tile y for (${x},${y},${z})`);
  }
});

test("the sphere projection round-trips over the visible hemisphere", () => {
  const centerLon = 12, centerLat = 30;
  for (const [lon, lat] of [[12, 30], [20, 35], [0, 0], [12, 80], [-10, 10]]) {
    const p = sphereProject(lon, lat, centerLon, centerLat);
    if (!p.visible) continue;
    const back = sphereLonLatAt(p.u, p.v, centerLon, centerLat);
    assert.ok(back, `(${lon},${lat}) projects onto the disc`);
    assert.ok(Math.abs(wrapLon(back.lon - lon)) < 1e-6, `sphere lon round trip ${lon} -> ${back.lon}`);
    assert.ok(Math.abs(back.lat - lat) < 1e-6, `sphere lat round trip ${lat} -> ${back.lat}`);
  }
});

test("the far hemisphere is reported invisible and off-disc points are null", () => {
  assert.equal(sphereProject(180, 0, 0, 0).visible, false, "the antipode faces away");
  assert.equal(sphereProject(0, 0, 0, 0).visible, true, "the view centre faces the viewer");
  assert.equal(sphereLonLatAt(1.5, 0, 0, 0), null, "outside the unit disc there is no planet");
  assert.notEqual(sphereLonLatAt(0.5, 0.5, 0, 0), null, "inside the disc there is");
});

test("latitude clamps and longitude wraps — the cylinder, not a sphere, in Mercator", () => {
  assert.equal(clampLat(89), MAX_MERCATOR_LAT);
  assert.equal(clampLat(-89), -MAX_MERCATOR_LAT);
  assert.equal(wrapLon(190), -170, "east past the date line continues");
  assert.equal(wrapLon(-190), 170, "and west past it too");
});

// ── THE VIEW-RESOLUTION LAW ─────────────────────────────────────────────────

test("VIEW-RESOLUTION LAW: camera zoom raises tile depth for the SAME document", () => {
  // The user's law: "I should be able to zoom in with the canvas camera in
  // arbitrary detail, through the rendering alone." The widget's own zoom is held
  // FIXED here; only the camera moves. Each doubling of device px per world unit
  // must buy exactly one more level.
  const widgetZoom = 6, box = 400, maxZoom = 19;
  const z1 = tileZoomFor(widgetZoom, box, 1, maxZoom);
  const z2 = tileZoomFor(widgetZoom, box, 2, maxZoom);
  const z4 = tileZoomFor(widgetZoom, box, 4, maxZoom);
  assert.equal(z2, z1 + 1, "2x camera zoom = one level deeper");
  assert.equal(z4, z1 + 2, "4x camera zoom = two levels deeper");
  assert.ok(tileZoomFor(widgetZoom, box, 0.25, maxZoom) < z1, "zooming OUT fetches shallower tiles");
});

test("VIEW-RESOLUTION LAW: a MAGNIFIER reaches tile selection by the same argument", () => {
  // A magnifier's supersample path re-renders the content beneath at MAGNIFIED
  // zoom. That is a larger view.zoom arriving through the ordinary view argument,
  // so it must select deeper tiles with no magnifier-specific code anywhere. This
  // asserts the composition that makes that true.
  const view = { zoom: 2, dpr: 1 };
  const plain = devicePerWorldUnit(view, 1);
  const underLens = devicePerWorldUnit({ ...view, zoom: view.zoom * 2.5 }, 1); // magnification 2.5
  assert.ok(underLens > plain, "the lens re-renders at a higher device-per-world scale");
  const zPlain = tileZoomFor(6, 400, plain, 19);
  const zLens = tileZoomFor(6, 400, underLens, 19);
  assert.ok(zLens > zPlain, `the lens gets deeper tiles (${zPlain} -> ${zLens}) with no magnifier-specific code`);
});

test("tile depth is clamped to the PROVIDER's ceiling, never past it", () => {
  // Past a provider's max there are no deeper tiles; requesting them is a 404 per
  // tile. NASA GIBS tops out far shallower than OSM, which is the physics of a
  // 250 m/px instrument rather than a limitation of the endpoint.
  assert.equal(tileZoomFor(30, 256, 1, TILE_PROVIDERS.satellite.maxZoom), TILE_PROVIDERS.satellite.maxZoom);
  assert.equal(tileZoomFor(30, 256, 1, TILE_PROVIDERS.osm.maxZoom), TILE_PROVIDERS.osm.maxZoom);
  assert.equal(tileZoomFor(-99, 256, 1, 19), 0, "and never below the single world tile");
});

// ── THE CROP ECONOMY LAW ────────────────────────────────────────────────────

test("CROP ECONOMY: a window covering a quarter of the world asks for a quarter of the tiles", () => {
  const whole = tilesForWindow({ x: 0, y: 0, w: 1, h: 1 }, 2);
  const quarter = tilesForWindow({ x: 0, y: 0, w: 0.5, h: 0.5 }, 2);
  assert.equal(whole.length, 16, "the whole world at z2 is 4x4");
  assert.equal(quarter.length, 4, "a quarter window is 2x2 — cost follows the WINDOW, not the widget");
});

test("CROP ECONOMY: zooming the camera in leaves the tile COUNT bounded, not growing", () => {
  // The point of the law: a deeper camera zoom fetches DEEPER tiles for a SMALLER
  // window, so the count stays about the screen's worth. If depth rose while the
  // window stayed whole, the count would explode as 4^level — that is the failure
  // this asserts against.
  const box = 400;
  let previous = null;
  for (const cameraZoom of [1, 2, 4, 8, 16]) {
    const devicePerWorld = cameraZoom;
    const z = tileZoomFor(4, box, devicePerWorld, 19);
    // The visible window shrinks in world terms exactly as the camera zooms in.
    const win = mapWorldWindow(0, 0, 4 + Math.log2(cameraZoom), box, box);
    const tiles = tilesForWindow(win, z);
    assert.ok(tiles.length <= 25, `at camera ${cameraZoom}x the visible crop needs ${tiles.length} tiles, not the whole pyramid`);
    if (previous !== null) assert.ok(tiles.length <= previous * 2, "the count stays bounded as depth rises");
    previous = tiles.length;
  }
});

test("croppedWindow narrows the fetch window to the on-screen fraction", () => {
  const window = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const all = croppedWindow(window, { sx: 0, sy: 0, sw: 1, sh: 1 });
  assert.deepEqual(all, window, "fully on screen: unchanged");
  const half = croppedWindow(window, { sx: 0.5, sy: 0, sw: 0.5, sh: 1 });
  assert.deepEqual(half, { x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, "the right half on screen: half the window");
});

test("the tile list is BUDGETED, so one frame can never bulk-download", () => {
  // Every tile is an HTTP request against donated infrastructure; OSM's policy
  // names wide automated fetching as prohibited bulk downloading. A pathological
  // window must truncate rather than emit thousands of requests.
  const huge = tilesForWindow({ x: 0, y: 0, w: 1, h: 1 }, 12);
  assert.equal(huge.length, TILE_BUDGET, "capped at the budget");
});

test("a window across the date line wraps the x index and records the world offset", () => {
  const tiles = tilesForWindow({ x: 0.9, y: 0.4, w: 0.2, h: 0.2 }, 1);
  for (const t of tiles) assert.ok(t.x >= 0 && t.x < 2, `x index ${t.x} is requestable at z1`);
  assert.ok(tiles.some((t) => t.wrapped === 1), "the eastern copies record that the world repeated");
});

// ── THE NAVIGATOR (the interiorView contract) ───────────────────────────────

test("NAVIGATOR: window -> writes -> window is the identity (a no-op drag moves nothing)", () => {
  // If this drifted, merely entering explore mode and releasing would nudge the
  // map — the silent-relocation class of bug.
  const s = stateAt({ centerLon: -74.006, centerLat: 40.7128, zoom: 11 });
  const win = globeMapPlugin.interiorView.window(s);
  const writes = globeMapPlugin.interiorView.writes(s, win);
  assert.ok(Math.abs(writes.centerLon - s.centerLon) < 1e-6, `lon preserved (${writes.centerLon})`);
  assert.ok(Math.abs(writes.centerLat - s.centerLat) < 1e-6, `lat preserved (${writes.centerLat})`);
  assert.ok(Math.abs(writes.zoom - s.zoom) < 1e-9, `zoom preserved (${writes.zoom})`);
});

test("NAVIGATOR: a pan writes centerLon/centerLat and only those", () => {
  const s = stateAt({ centerLon: 0, centerLat: 0, zoom: 4 });
  const win = globeMapPlugin.interiorView.window(s);
  const panned = { ...win, x: win.x + win.w * 0.25 }; // slide a quarter-window east
  const writes = globeMapPlugin.interiorView.writes(s, panned);
  assert.ok(writes.centerLon > 0, "panning east raises the longitude");
  assert.ok(Math.abs(writes.centerLat) < 1e-9, "and leaves the latitude alone");
  assert.ok(Math.abs(writes.zoom - 4) < 1e-9, "and does not change the zoom");
  assert.deepEqual(Object.keys(writes).sort(), ["centerLat", "centerLon", "zoom"]);
});

test("NAVIGATOR: zooming the window in raises the zoom by the expected level", () => {
  const s = stateAt({ centerLon: 0, centerLat: 0, zoom: 3 });
  const win = globeMapPlugin.interiorView.window(s);
  const halved = { x: win.x + win.w / 4, y: win.y + win.h / 4, w: win.w / 2, h: win.h / 2 };
  const writes = globeMapPlugin.interiorView.writes(s, halved);
  assert.ok(Math.abs(writes.zoom - 4) < 1e-9, `halving the window is exactly one level (got ${writes.zoom})`);
});

test("NAVIGATOR: every write key is a real, keyframable property", () => {
  // The interiorNav contract requires each written key to be a stored leaf — that
  // is what makes an explored view tweenable and =-bindable.
  const s = stateAt();
  const writes = globeMapPlugin.interiorView.writes(s, globeMapPlugin.interiorView.window(s));
  for (const key of Object.keys(writes))
    assert.ok(key in globeMapPlugin.defaults, `"${key}" is a declared property`);
});

test("the floating bar's typed fields wrap, clamp and refuse nonsense", () => {
  const s = stateAt();
  assert.deepEqual(globeMapPlugin.fieldWrites(s, "lon", "200"), { centerLon: -160 });
  assert.deepEqual(globeMapPlugin.fieldWrites(s, "lat", "95"), { centerLat: MAX_MERCATOR_LAT });
  assert.deepEqual(globeMapPlugin.fieldWrites(s, "zoom", "13"), { zoom: 13 });
  assert.equal(globeMapPlugin.fieldWrites(s, "lat", "banana"), null, "nonsense is refused, not guessed");
  assert.equal(globeMapPlugin.fieldWrites(s, "lon", ""), null);
  // Every field the bar declares must be writable, or a typed value silently vanishes.
  for (const field of globeMapPlugin.floatingToolbar(s).fields)
    assert.notEqual(globeMapPlugin.fieldWrites(s, field.id, "1"), null, `field "${field.id}" accepts a value`);
});

// ── EMIT + DETERMINISM ──────────────────────────────────────────────────────

test("emit produces a display list with no render context (the export/CLI path)", () => {
  const ops = globeMapPlugin.emit(stateAt(), null, null, null);
  assert.ok(ops.length > 0, "a camera-free consumer still gets a picture");
  assert.equal(ops[0].op, "rect", "space is drawn first");
  assert.ok(ops.some((o) => o.op === "materialFill" && o.material === "atmosphere"), "the globe carries its air");
  assert.ok(ops.some((o) => o.op === "text"), "and the licence-required attribution");
});

test("DETERMINISM: two emits of one state are structurally identical", () => {
  // The map reads no clock and no random — the GIBS date is pinned for exactly
  // this reason — so a frozen document must render identically forever.
  const s = stateAt({ centerLon: 5, centerLat: 45, zoom: 3 });
  const a = JSON.stringify(globeMapPlugin.emit(s, null, null, null));
  const b = JSON.stringify(globeMapPlugin.emit(s, null, null, null));
  assert.equal(a, b, "same state, same display list");
});

test("DETERMINISM: with STUBBED resident tiles the display list is byte-identical", () => {
  // The real async question: once tiles are resident, two renders agree. The stub
  // stands in for the registry so this is checkable in bare node.
  const s = stateAt({ centerLon: 0, centerLat: 0, zoom: 8 });
  const plan = {
    z: 8, devicePerWorld: 1,
    window: mapWorldWindow(0, 0, 8, s.w, s.h),
    tiles: tilesForWindow(mapWorldWindow(0, 0, 8, s.w, s.h), 8).map((t) => ({ ...t, ref: `stub:${t.z}/${t.x}/${t.y}`, ready: true })),
  };
  plan.cropped = plan.window;
  const ctx = { mapTiles: plan };
  const a = JSON.stringify(globeMapPlugin.emit(s, null, null, ctx));
  const b = JSON.stringify(globeMapPlugin.emit(s, null, null, ctx));
  assert.equal(a, b, "resident tiles render byte-identically");
  const imageOps = JSON.parse(a).filter((o) => o.op === "image");
  assert.ok(imageOps.length > 0, "the tiles actually reached the display list");
  for (const op of imageOps) assert.ok(op.ref.startsWith("stub:"), "every image op names a tile ref");
});

test("an UNREADY tile draws NOTHING — never a stretched neighbour standing in", () => {
  // The decoder-lie refusal: a plausible map of the wrong place is worse than a
  // visibly absent one.
  const s = stateAt({ zoom: 8 });
  const window = mapWorldWindow(s.centerLon, s.centerLat, 8, s.w, s.h);
  const tiles = tilesForWindow(window, 8).map((t) => ({ ...t, ref: `stub:${t.x}`, ready: false }));
  const ops = globeMapPlugin.emit(s, null, null, { mapTiles: { z: 8, window, cropped: window, tiles, devicePerWorld: 1 } });
  assert.equal(ops.filter((o) => o.op === "image").length, 0, "not one image op for a not-yet-decoded tile");
});

test("the flat renderer places tiles edge to edge with no gaps", () => {
  // A placement error here shows as hairlines between tiles, which reads as a
  // rendering artifact rather than as arithmetic.
  const window = { x: 0, y: 0, w: 1, h: 1 };
  const a = flatTileRect({ x: 0, y: 0, z: 1, wrapped: 0 }, window, 256, 256);
  const b = flatTileRect({ x: 1, y: 0, z: 1, wrapped: 0 }, window, 256, 256);
  assert.equal(a.x + a.w, b.x, "the second tile starts exactly where the first ends");
  assert.equal(a.w, 128, "each z1 tile is half the box");
});

test("GLOBE: no tile ink is ever drawn OUTSIDE the planet's disc", () => {
  // THE REGRESSION. Quads are axis-aligned image rects bounding four projected
  // corners, so a quad with one corner round the BACK bounds a box spanning most of
  // the disc — and the first render smeared tile pixels across empty space off the
  // globe's limb (.claude_logs/globemap, before the fix). Nothing on a sphere of
  // radius r can project outside radius r, so that is the invariant to assert.
  const s = stateAt({ centerLon: 10, centerLat: 48, zoom: 1, w: 400, h: 400 });
  const window = mapWorldWindow(s.centerLon, s.centerLat, s.zoom, s.w, s.h);
  const tiles = tilesForWindow(window, 2).map((t) => ({ ...t, ref: `stub:${t.x}/${t.y}`, ready: true }));
  const ops = globeMapPlugin.emit(s, null, null, { mapTiles: { z: 2, window, cropped: window, tiles, devicePerWorld: 1 } });
  const cx = s.w / 2, cy = s.h / 2, r = Math.min(s.w, s.h) / 2;
  const images = ops.filter((o) => o.op === "image");
  assert.ok(images.length > 0, "the globe actually drew tiles (else this asserts nothing)");
  const SLACK = 1; // one px, matching the emitter's own sub-pixel disc tolerance
  for (const op of images)
    for (const [x, y] of [[op.x, op.y], [op.x + op.w, op.y], [op.x, op.y + op.h], [op.x + op.w, op.y + op.h]])
      assert.ok(Math.hypot(x - cx, y - cy) <= r + SLACK,
        `a tile quad reaches (${x.toFixed(1)}, ${y.toFixed(1)}), which is outside the disc of radius ${r} — tile ink is escaping into space`);
  // AND NO RUNAWAY BOXES: the original defect's shape was a quad whose bounding box
  // spanned a large fraction of the planet, so bound the size directly too.
  const biggest = Math.max(...images.map((o) => Math.max(o.w, o.h)));
  assert.ok(biggest < r, `the largest quad is ${biggest.toFixed(1)} px on a disc of radius ${r} — a quad that big is a ballooned bounding box, not a piece of sphere`);
});

test("GLOBE: the POLAR CAPS fill the hole Mercator cannot reach", () => {
  // Web Mercator stops at ±MAX_MERCATOR_LAT, so no tile at any zoom covers the last
  // five degrees to a pole. On a flat map the map simply ends; on a GLOBE that is a
  // hole straight through the planet, and the first render showed a black ellipse at
  // the north pole. A cap is drawn in ice colour — never sampled, because there is no
  // data there and stretching the top tile row over the pole would be a decoder lie.
  const facingNorth = globeMapPlugin.emit(stateAt({ centerLat: 70, zoom: 0.5 }), null, null, null);
  assert.ok(facingNorth.some((o) => o.op === "polygon"), "a globe tilted toward the north pole draws its cap");
  // At street zoom there is no globe at all, so there are no caps either.
  const flat = globeMapPlugin.emit(stateAt({ centerLat: 70, zoom: 14 }), null, null, null);
  assert.ok(!flat.some((o) => o.op === "polygon"), "a flat map has no cap to draw");
});

// ── THE CROSSFADE ───────────────────────────────────────────────────────────

test("the globe/flat crossfade is total at both ends and smooth between", () => {
  assert.equal(globeWeight(0), 1, "planetary zoom is all globe");
  assert.equal(globeWeight(12), 0, "street zoom is all flat map");
  assert.ok(Math.abs(globeWeight(GLOBE_FLAT_CROSSOVER) - 0.5) < 1e-9, "the crossover is half and half");
  // Monotone: a zoom-in must never make the globe come BACK, which would read as
  // a flicker mid-animation.
  let previous = 1.0000001;
  for (let z = 0; z <= 12; z += 0.25) {
    const w = globeWeight(z);
    assert.ok(w <= previous, `globe weight is monotone non-increasing at z${z}`);
    previous = w;
  }
});

test("emit draws the flat map only below the crossover and the air only above", () => {
  const deep = globeMapPlugin.emit(stateAt({ zoom: 14 }), null, null, null);
  assert.ok(!deep.some((o) => o.op === "materialFill"), "a street map has no limb to glow");
  const planetary = globeMapPlugin.emit(stateAt({ zoom: 0 }), null, null, null);
  assert.ok(planetary.some((o) => o.op === "materialFill"), "a globe does");
});

// ── PROVIDERS + ATTRIBUTION ─────────────────────────────────────────────────

test("every provider carries a non-empty attribution — it is a LICENCE TERM", () => {
  for (const id of TILE_PROVIDER_IDS) {
    const p = TILE_PROVIDERS[id];
    assert.ok(p.attribution && p.attribution.length > 3, `"${id}" names its source`);
    assert.ok(p.maxZoom >= 1 && p.maxZoom <= 24, `"${id}" declares a sane max zoom`);
    assert.ok(p.url.startsWith("https://"), `"${id}" is fetched over TLS`);
  }
});

test("the attribution of the ACTIVE provider is what gets drawn", () => {
  for (const id of TILE_PROVIDER_IDS) {
    const ops = globeMapPlugin.emit(stateAt({ style: id }), null, null, null);
    const label = ops.find((o) => o.op === "text");
    assert.equal(label.text, TILE_PROVIDERS[id].attribution, `"${id}" draws its own credit`);
  }
});

test("NO GOOGLE TILES, ever — their terms permit access only via their own JS API", () => {
  // THE ASSERTION IS ON THE HOST, not on the string "google" anywhere in the URL,
  // and the distinction is real rather than pedantic: NASA GIBS's path contains
  // `GoogleMapsCompatible`, which is the OGC name of the WEB MERCATOR TILING
  // SCHEME every provider here uses — nothing to do with Google as a service. A
  // substring test flagged it and would have pushed someone to "fix" a correct
  // NASA endpoint. What must never appear is a Google-operated HOST.
  const FORBIDDEN_HOSTS = ["google.com", "googleapis.com", "gstatic.com", "ggpht.com"];
  for (const id of TILE_PROVIDER_IDS) {
    const host = new URL(TILE_PROVIDERS[id].url.replace("{s}", "a")).hostname.toLowerCase();
    for (const bad of FORBIDDEN_HOSTS)
      assert.ok(!host.endsWith(bad), `"${id}" is served from ${host}, which is a Google host`);
  }
});

test("tile URLs substitute every placeholder — a leftover brace would 404 forever", () => {
  for (const id of TILE_PROVIDER_IDS) {
    const url = tileUrl(TILE_PROVIDERS[id], 3, 5, 4);
    assert.ok(!url.includes("{"), `"${id}" leaves no unsubstituted placeholder: ${url}`);
    assert.ok(url.includes("/4/") || url.includes("/4."), `"${id}" carries the zoom`);
  }
});

test("the GIBS template puts Y BEFORE X — its WMTS layout, not the usual order", () => {
  // Getting this backwards yields a transposed world: a plausible-looking map of
  // the wrong place, which no crash would ever reveal.
  const url = tileUrl(TILE_PROVIDERS.satellite, 3, 7, 5);
  assert.ok(url.endsWith("/5/7/3.jpg"), `z/y/x ordering (got ${url})`);
});

test("an unknown stored style falls back to the default basemap rather than blanking", () => {
  assert.equal(providerFor("nonesuch").id, TILE_PROVIDERS.osm.id);
  assert.equal(providerFor(undefined).id, TILE_PROVIDERS.osm.id);
});

// ── THE STATE MODEL ─────────────────────────────────────────────────────────

test("the place is PLAIN NUMBERS, which is what makes a fly-in tween", () => {
  // If any of these were an object or a string, the generic per-leaf lerp could
  // not interpolate it and a slide-to-slide zoom would SNAP instead of flying.
  for (const key of ["centerLon", "centerLat", "zoom"])
    assert.equal(typeof globeMapPlugin.defaults[key], "number", `${key} is a plain number`);
  assert.equal(typeof globeMapPlugin.defaults.style, "string", "style is a select (switches, does not tween)");
});

test("tile geometry is stable across box sizes — one tile is TILE_SIZE px at matching zoom", () => {
  // The identity the whole pyramid rests on: at zoom z the world is
  // 2^z * TILE_SIZE px wide.
  const win = mapWorldWindow(0, 0, 0, TILE_SIZE, TILE_SIZE);
  assert.ok(Math.abs(win.w - 1) < 1e-12, "a TILE_SIZE box at z0 shows exactly the whole world");
});

console.log(`\n${passed} tests passed`);
