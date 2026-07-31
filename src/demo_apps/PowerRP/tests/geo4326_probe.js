/**
 * GIBS EPSG:4326 GEOGRAPHIC TILES — BROWSER PROBE against a FIXTURE TILE SERVER.
 *
 * The bare-node suite (tests/geo4326_test.js) proves the grid math, the provider
 * table and the crossfade-coherence measurement in pure arithmetic. Four things
 * survive only a real boot, and this probe proves each with a request LOG rather
 * than an impression (same fixture-server discipline as globe_map_probe.js and
 * mapctl_probe.js, and for the identical policy reason: no request may ever
 * leave for gibs.earthdata.nasa.gov or tile.openstreetmap.org from an automated
 * suite):
 *
 *   1. THE GLOBE PATH ACTUALLY REQUESTS 4326 URLS for a provider that has a
 *      geographic twin (satellite), when pinned to "globe" view mode — not just
 *      that the math SAYS it should.
 *   2. POLE COVERAGE IS REAL: centring the globe near the north pole and reading
 *      the request log for tiles whose row is 0 (this pyramid's actual pole row,
 *      per GEOGRAPHIC_MATRIX_DIMS) proves the pole is a FETCHED, DRAWABLE tile,
 *      not a shaded cap standing in for one.
 *   3. THE DOCUMENTED ASYMMETRY HOLDS IN THE RUNNING APP: OSM's globe path must
 *      keep requesting MERCATOR urls (tile.openstreetmap.org), never 4326 ones,
 *      because no such OSM service exists — this is the fixture-backed twin of
 *      tests/geo4326_test.js's `geographicFor(TILE_PROVIDERS.osm) === null`.
 *   4. CROP ECONOMY holds on the 4326 grid exactly as it does on the Mercator
 *      one: zooming the globe in requests a small, compact block of geographic
 *      tiles, not the whole pyramid level.
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/geo4326_probe.js
 * PNGs land in .claude_logs/geotiles/.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const outDir = resolve(here, "..", ".claude_logs", "geotiles");

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1440, height: 900 };
const BOOT_SETTLE_MS = 1200;
const PAINT_SETTLE_MS = 1600;

const MAP_BOX = { x: 240, y: 60, w: 600, h: 600 };

const KNOWN_BOOT_NOISE = [
  /no WebGPU adapter/, /WebGPU init failed/,
  /Failed to load resource.*500/, /\/api\/(projects|assets)/,
  /Failed to load resource.*404/,
  /globe_map: no map tiles are available to this renderer/,
];

function partitionErrors(all) {
  const ignored = all.filter((e) => KNOWN_BOOT_NOISE.some((re) => re.test(e)));
  return { relevant: all.filter((e) => !ignored.includes(e)), ignored };
}

function assertNoErrors(all, where) {
  const { relevant, ignored } = partitionErrors(all);
  for (const e of ignored) console.log(`  (ignored, known-unrelated) ${e}`);
  all.length = 0;
  if (relevant.length) {
    const urls = [...new Set(failedUrls)];
    throw new Error(`PAGE ERRORS ${where}:\n${relevant.map((e) => JSON.stringify(e)).join("\n")}${urls.length ? `\nFAILED URLS:\n  ${urls.join("\n  ")}` : ""}`);
  }
}

// ── THE SAME MINIMAL PNG FIXTURE globe_map_probe.js / mapctl_probe.js USE
// (copied rather than imported: these probes are meant to stay independently
// runnable). Each tile gets its own hue so a misplaced or transposed tile is
// visible in the screenshots. ──────────────────────────────────────────────
function checkerTilePng(z, x, y, hueSeed = 0) {
  const SIZE = 256, CELL = 32;
  const hue = (((x * 7 + y * 13 + z * 29) % 12) / 12 + hueSeed) % 1;
  const [r1, g1, b1] = hsvBytes(hue, 0.55, 0.95);
  const [r2, g2, b2] = hsvBytes(hue, 0.75, 0.55);
  const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
  let p = 0;
  for (let row = 0; row < SIZE; row++) {
    raw[p++] = 0;
    for (let col = 0; col < SIZE; col++) {
      const on = (Math.floor(row / CELL) + Math.floor(col / CELL)) % 2 === 0;
      raw[p++] = on ? r1 : r2;
      raw[p++] = on ? g1 : g2;
      raw[p++] = on ? b1 : b2;
    }
  }
  return encodePng(SIZE, SIZE, raw);
}

function hsvBytes(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const [p, q, t] = [v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)];
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return rgb.map((c) => Math.round(c * 255));
}

function encodePng(width, height, raw) {
  const idat = _zlib.deflateSync(raw);
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", (() => {
      const b = Buffer.alloc(13);
      b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4);
      b[8] = 8; b[9] = 2; b[10] = 0; b[11] = 0; b[12] = 0;
      return b;
    })()),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat(chunks);
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

const _zlib = await import("node:zlib");

await mkdir(outDir, { recursive: true });

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

// BOTH pyramids for the satellite base, plus OSM (which has NO 4326 twin — the
// documented asymmetry this probe exists to confirm holds against the real app).
const HOST_PATTERNS = [
  { name: "osm-mercator", re: /^https:\/\/[abc]\.tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, hueSeed: 0 },
  { name: "satellite-mercator", re: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/MODIS_Terra_CorrectedReflectance_TrueColor\/default\/[\d-]+\/GoogleMapsCompatible_Level9\/(\d+)\/(\d+)\/(\d+)\.jpg/, hueSeed: 0.3, yBeforeX: true },
  { name: "satellite-geographic", re: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg4326\/best\/MODIS_Terra_CorrectedReflectance_TrueColor\/default\/[\d-]+\/250m\/(\d+)\/(\d+)\/(\d+)\.jpeg/, hueSeed: 0.55, yBeforeX: true },
];

/** Every request, tagged by which layer/pyramid it belongs to. */
const requested = [];
const failedUrls = [];

const browser = await launchBrowser({ args: CHROME_ARGS });
const errors = [];
let failures = 0;

function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  await page.setRequestInterception(true);
  page.on("requestfailed", (req) => failedUrls.push(`${req.url()} — ${req.failure()?.errorText ?? "failed"}`));
  page.on("response", (res) => { if (res.status() >= 400) failedUrls.push(`${res.url()} — HTTP ${res.status()}`); });
  page.on("request", (req) => {
    const hit = HOST_PATTERNS.find((h) => h.re.test(req.url()));
    if (!hit) return void req.continue();
    const m = hit.re.exec(req.url());
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [z, x, y] = hit.yBeforeX ? [a, c, b] : [a, b, c];
    requested.push({ layer: hit.name, z, x, y });
    req.respond({
      status: 200,
      contentType: "image/jpeg",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: checkerTilePng(z, x, y, hit.hueSeed),
    });
  });

  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  assertNoErrors(errors, "AT BOOT");

  const shoot = async (name) => {
    const canvas = await page.$(".canvas-wrap");
    const out = resolve(outDir, `${name}.png`);
    await canvas.screenshot({ path: out });
    console.log(`  shot  ${name} → ${out}`);
    return out;
  };

  // ── 1. SATELLITE, PINNED TO GLOBE: must request 4326, not 3857 ─────────────
  const built = await page.evaluate((MAP_BOX) => {
    const app = window.__powerrp_app;
    app.addItem({
      ...app.registry.get("demo_globe_map").defaults,
      x: MAP_BOX.x, y: MAP_BOX.y, w: MAP_BOX.w, h: MAP_BOX.h,
      style: "satellite", viewMode: "globe", centerLon: 8, centerLat: 24, zoom: 0.6,
    });
    return { id: app.selection };
  }, MAP_BOX);
  check(!!built.id, "the satellite globe widget was inserted", built.id ?? "");
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  await shoot("01_satellite_globe_whole_earth");

  const geoReq = requested.filter((r) => r.layer === "satellite-geographic");
  const mercReqOnGlobe = requested.filter((r) => r.layer === "satellite-mercator");
  check(geoReq.length > 0, "THE GLOBE PATH REQUESTED 4326 (geographic) satellite tiles", `${geoReq.length} requests`);
  check(mercReqOnGlobe.length === 0, "the globe path requested ZERO 3857 (mercator) satellite tiles while pinned to globe view",
    `${mercReqOnGlobe.length} mercator requests logged`);
  assertNoErrors(errors, "after the satellite globe paint");

  // ── 2. POLE COVERAGE: centre on the north pole, confirm a REAL row-0 fetch ──
  requested.length = 0;
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "centerLat"], 89], [["items", id, "zoom"], 2]]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  await shoot("02_satellite_globe_pole_closeup");
  const poleReq = requested.filter((r) => r.layer === "satellite-geographic");
  const poleRow0 = poleReq.filter((r) => r.y === 0);
  check(poleReq.length > 0, "centring near the pole still fetches GEOGRAPHIC tiles", `${poleReq.length} requests`);
  check(poleRow0.length > 0, "POLE COVERAGE: at least one fetched tile is row 0 -- the pyramid's own true-pole row",
    `${poleRow0.length} of ${poleReq.length} requests are row 0`);
  assertNoErrors(errors, "after centring on the pole");

  // ── 3. OSM GLOBE PATH KEEPS MERCATOR (the documented asymmetry) ────────────
  requested.length = 0;
  const osmBuilt = await page.evaluate((MAP_BOX) => {
    const app = window.__powerrp_app;
    app.addItem({
      ...app.registry.get("demo_globe_map").defaults,
      x: MAP_BOX.x + 20, y: MAP_BOX.y + 20, w: MAP_BOX.w, h: MAP_BOX.h,
      style: "osm", viewMode: "globe", centerLon: 0, centerLat: 20, zoom: 1,
    });
    return { id: app.selection };
  }, MAP_BOX);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  await shoot("03_osm_globe_stays_mercator");
  const osmMercReq = requested.filter((r) => r.layer === "osm-mercator");
  check(osmMercReq.length > 0, "OSM's globe path requested MERCATOR tiles (no 4326 service exists for OSM)", `${osmMercReq.length} requests`);
  assertNoErrors(errors, "after the OSM globe paint");

  // ── 4. CROSSFADE PAIR: same widget either side of GLOBE_FLAT_CROSSOVER ─────
  requested.length = 0;
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", id, "style"], "satellite"], [["items", id, "viewMode"], "auto"],
      [["items", id, "zoom"], 4.4], [["items", id, "centerLon"], 8], [["items", id, "centerLat"], 24],
    ]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  await shoot("04a_crossfade_below_threshold_more_globe");
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "zoom"], 5.6]]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  await shoot("04b_crossfade_above_threshold_more_flat");
  check(true, "crossfade pair captured either side of GLOBE_FLAT_CROSSOVER for visual inspection");
  assertNoErrors(errors, "after the crossfade pair");

  // ── 5. CROP ECONOMY on the 4326 grid ────────────────────────────────────────
  requested.length = 0;
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", id, "viewMode"], "globe"], [["items", id, "zoom"], 6],
      [["items", id, "centerLon"], -74], [["items", id, "centerLat"], 41],
    ]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  await shoot("05_geographic_crop_economy_zoomed");
  const deep = requested.filter((r) => r.layer === "satellite-geographic" && r.z >= 3);
  if (deep.length) {
    const z = deep[0].z;
    const [mw, mh] = [10 * 2 ** Math.max(0, z - 3), 5 * 2 ** Math.max(0, z - 3)];
    const whole = mw * mh;
    const xs = deep.map((t) => t.x), ys = deep.map((t) => t.y);
    const span = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
    check(deep.length < whole / 4, "CROP ECONOMY (4326): far fewer tiles than the whole level", `${deep.length} requested at z${z}, whole level is ${whole}`);
    check(span <= deep.length * 4 && span < 400, "CROP ECONOMY (4326): the requested tiles form ONE compact block", `bounding block ${span} tiles for ${deep.length} requests`);
  } else {
    check(false, "CROP ECONOMY (4326): the zoom produced deeper geographic tile requests", "none were logged");
  }
  assertNoErrors(errors, "after the geographic crop-economy zoom");

  console.log(`\n  fixture tile requests logged in total: ${requested.length}`);
  if (failedUrls.length) console.log(`  failed loads (${failedUrls.length}):\n    ${[...new Set(failedUrls)].join("\n    ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
