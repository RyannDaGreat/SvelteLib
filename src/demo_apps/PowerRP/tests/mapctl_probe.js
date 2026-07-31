/**
 * MAP LAYERS — the FIRST-USE ACCEPTANCE PROBE, against a FIXTURE TILE SERVER.
 *
 * THE STANDING RULE THIS PROBE EXISTS TO SATISFY (learned from the god-rays
 * miss): "passing" means the REAL user path in the real editor, not just the
 * arithmetic tests/mapctl_test.js already covers in bare node. That file proves
 * the overlay tile-plan math, toggleWrites, the attribution union and
 * parseLatLon are correct; this probe proves a person can actually reach them —
 * fresh doc, insert map, open the navigator popup, click a layer quick-switch
 * (the STYLE changes on canvas), toggle an overlay, type coordinates (the map
 * recentres), reload — all persisted.
 *
 * Same fixture-server discipline as tests/globe_map_probe.js and for the
 * identical reason: OSM's Tile Usage Policy names automated fetching as
 * prohibited bulk downloading, so every tile request is intercepted inside the
 * browser and answered with a generated checkerboard — no request ever leaves
 * for a real provider. The GIBS overlay hosts are intercepted the same way.
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/mapctl_probe.js
 * PNGs land in .claude_logs/mapctl/.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const outDir = resolve(here, "..", ".claude_logs", "mapctl");

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1440, height: 900 };
const BOOT_SETTLE_MS = 1200;
const PAINT_SETTLE_MS = 1200;

const MAP_BOX = { x: 240, y: 60, w: 600, h: 600 };

// Same known-unrelated boot noise as globe_map_probe.js, for the same reasons,
// plus the map's OWN reportOnce (core/report.js) about the very first frame it
// draws before any tile pre-pass has run — a real, expected, ONE-TIME transient
// (this file's own globe_map.js docblock names it) rather than a defect: the
// live editor runs the pre-pass on every subsequent frame, and the request log
// below is the actual evidence tiles were fetched once it did.
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

// ── THE SAME MINIMAL PNG FIXTURE globe_map_probe.js USES (copied rather than
// imported: these two probes are meant to stay independently runnable, and a
// shared helper module would be the only thing coupling them). ─────────────
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

// EVERY provider AND overlay host this feature touches, intercepted the same
// way globe_map_probe.js intercepts OSM alone: `req.respond()` never lets a
// request leave for a real host, and the request is LOGGED so "did the right
// layer's tiles actually get asked for" is a countable fact.
const HOST_PATTERNS = [
  { name: "osm", re: /^https:\/\/[abc]\.tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, hueSeed: 0 },
  { name: "satellite", re: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/MODIS_Terra_CorrectedReflectance_TrueColor\/default\/[\d-]+\/GoogleMapsCompatible_Level9\/(\d+)\/(\d+)\/(\d+)\.jpg/, hueSeed: 0.3, yBeforeX: true },
  { name: "overlayLabels", re: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/Reference_Labels\/default\/GoogleMapsCompatible_Level9\/(\d+)\/(\d+)\/(\d+)\.png/, hueSeed: 0.6, yBeforeX: true },
  { name: "overlayFeatures", re: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/Reference_Features\/default\/GoogleMapsCompatible_Level9\/(\d+)\/(\d+)\/(\d+)\.png/, hueSeed: 0.75, yBeforeX: true },
  { name: "overlayCoastlines", re: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/Coastlines\/default\/GoogleMapsCompatible_Level9\/(\d+)\/(\d+)\/(\d+)\.png/, hueSeed: 0.9, yBeforeX: true },
];

/** Every request, tagged by which layer it belongs to — the evidence for
 *  "clicking a layer button actually changed what the widget fetches". */
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
    // GIBS templates put y before x (documented in web/tile_providers.js); OSM
    // puts x before y. Recording z/x/y uniformly regardless of the template's
    // own placeholder order is what lets this probe's assertions read plainly.
    const [z, x, y] = hit.yBeforeX ? [a, c, b] : [a, b, c];
    requested.push({ layer: hit.name, z, x, y });
    req.respond({
      status: 200,
      contentType: "image/png",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: checkerTilePng(z, x, y, hit.hueSeed),
    });
  });

  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  assertNoErrors(errors, "AT BOOT");

  // ── 1. FRESH DOC, INSERT MAP ────────────────────────────────────────────
  const built = await page.evaluate((MAP_BOX) => {
    const app = window.__powerrp_app;
    app.addItem({
      ...app.registry.get("demo_globe_map").defaults,
      x: MAP_BOX.x, y: MAP_BOX.y, w: MAP_BOX.w, h: MAP_BOX.h,
      style: "osm", centerLon: 0, centerLat: 0, zoom: 3,
    });
    return { id: app.selection };
  }, MAP_BOX);
  check(!!built.id, "fresh doc: the map widget was inserted", built.id ?? "");
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));

  const shoot = async (name) => {
    const canvas = await page.$(".canvas-wrap");
    const out = resolve(outDir, `${name}.png`);
    await canvas.screenshot({ path: out });
    console.log(`  shot  ${name} → ${out}`);
    return out;
  };
  await shoot("01_inserted_osm");

  // ── 2. OPEN THE NAVIGATOR POPUP (double-click) ─────────────────────────
  const canvasBox = await (await page.$(".canvas-wrap")).boundingBox();
  const centre = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
  await page.mouse.click(centre.x, centre.y, { clickCount: 2, delay: 60 });
  await new Promise((r) => setTimeout(r, 500));
  const panelVisible = await page.evaluate(() => !!document.querySelector(".canvas-toolbar"));
  check(panelVisible, "double-click opens the popup toolbar");
  assertNoErrors(errors, "after opening the popup");

  // ── 3. CLICK A LAYER QUICK-SWITCH (style changes on canvas) ────────────
  requested.length = 0;
  const clickedSatellite = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".canvas-toolbar-toggles .btn")];
    const target = buttons.find((b) => b.textContent.includes("Satellite"));
    if (!target) return false;
    target.click();
    return true;
  });
  check(clickedSatellite, "the Satellite basemap quick-switch button exists and was clicked");
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  const styleAfterClick = await page.evaluate((id) => window.__powerrp_app.nodes().find((n) => n.itemId === id)?.state.style, built.id);
  check(styleAfterClick === "satellite", "clicking the button actually wrote style=\"satellite\"", `style is now "${styleAfterClick}"`);
  check(requested.some((r) => r.layer === "satellite"), "the widget fetched SATELLITE tiles after the click — the canvas actually changed",
    `${requested.filter((r) => r.layer === "satellite").length} satellite requests logged`);
  await shoot("02_style_satellite");
  assertNoErrors(errors, "after the style quick-switch");

  // ── 4. TOGGLE AN OVERLAY (the hybrid look) ─────────────────────────────
  requested.length = 0;
  const clickedLabels = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".canvas-toolbar-toggles .btn")];
    const target = buttons.find((b) => b.textContent.includes("Place labels"));
    if (!target) return false;
    target.click();
    return true;
  });
  check(clickedLabels, "the Place labels overlay quick-switch button exists and was clicked");
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  const overlayAfterClick = await page.evaluate((id) => window.__powerrp_app.nodes().find((n) => n.itemId === id)?.state.overlayLabels, built.id);
  check(overlayAfterClick === true, "clicking the overlay button flipped overlayLabels to true");
  check(requested.some((r) => r.layer === "overlayLabels"), "the widget fetched the LABELS overlay tiles after the toggle",
    `${requested.filter((r) => r.layer === "overlayLabels").length} label-overlay requests logged`);
  await shoot("03_hybrid_satellite_plus_labels");
  assertNoErrors(errors, "after the overlay toggle");

  // ── 5. TYPE COORDINATES (the map recentres) ────────────────────────────
  const before = await page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((nn) => nn.itemId === id);
    return { lon: n.state.centerLon, lat: n.state.centerLat };
  }, built.id);
  const typedCoords = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll(".canvas-toolbar-field-input")];
    const coordsInput = inputs.find((i) => i.closest(".canvas-toolbar-field")?.querySelector(".canvas-toolbar-field-label")?.textContent === "Go to");
    if (!coordsInput) return false;
    coordsInput.focus();
    coordsInput.value = "35.6895, 139.6917"; // Tokyo
    coordsInput.dispatchEvent(new Event("input", { bubbles: true }));
    coordsInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  });
  check(typedCoords, "the \"Go to\" coordinate field exists and accepted typed input");
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  const after = await page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((nn) => nn.itemId === id);
    return { lon: n.state.centerLon, lat: n.state.centerLat };
  }, built.id);
  check(Math.abs(after.lat - 35.6895) < 1e-6 && Math.abs(after.lon - 139.6917) < 1e-6,
    "typing coordinates RECENTRED the map to the typed place",
    `before=(${before.lon.toFixed(4)}, ${before.lat.toFixed(4)}) after=(${after.lon.toFixed(4)}, ${after.lat.toFixed(4)})`);
  await shoot("04_recentred_tokyo");
  assertNoErrors(errors, "after typing coordinates");

  // ── 6. RELOAD -> ALL PERSISTED ──────────────────────────────────────────
  // The document is autosaved by the app's own draft mechanism; a reload must
  // read back the SAME style/overlay/place this session just wrote, with no
  // special-case persistence path invented for this feature.
  const beforeReload = await page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((nn) => nn.itemId === id);
    return { style: n.state.style, overlayLabels: n.state.overlayLabels, lon: n.state.centerLon, lat: n.state.centerLat };
  }, built.id);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  const afterReload = await page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((nn) => nn.itemId === id);
    return n ? { style: n.state.style, overlayLabels: n.state.overlayLabels, lon: n.state.centerLon, lat: n.state.centerLat } : null;
  }, built.id);
  check(!!afterReload, "the widget still exists after reload (the draft round-tripped)");
  if (afterReload) {
    check(afterReload.style === beforeReload.style, "style PERSISTED across reload", `${beforeReload.style} -> ${afterReload.style}`);
    check(afterReload.overlayLabels === beforeReload.overlayLabels, "the overlay toggle PERSISTED across reload", `${beforeReload.overlayLabels} -> ${afterReload.overlayLabels}`);
    check(Math.abs(afterReload.lon - beforeReload.lon) < 1e-9 && Math.abs(afterReload.lat - beforeReload.lat) < 1e-9,
      "the typed coordinates PERSISTED across reload");
  }
  await shoot("05_after_reload");
  assertNoErrors(errors, "after reload");

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
console.log("\nmapctl_probe: all checks passed");
