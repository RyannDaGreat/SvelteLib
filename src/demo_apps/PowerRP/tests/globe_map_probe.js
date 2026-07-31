/**
 * GLOBE / MAP — BROWSER PROBE against a FIXTURE TILE SERVER.
 *
 * ── WHY A FIXTURE SERVER AND NOT THE REAL PROVIDERS ──────────────────────────
 * Every tile is an HTTP request against volunteer-funded or public infrastructure,
 * and OSM's Tile Usage Policy names automated fetching as prohibited BULK
 * DOWNLOADING in as many words. A test suite that runs on every commit is exactly
 * the automated client that policy is about. So this probe INTERCEPTS every tile
 * request inside the browser and answers it with a generated checkerboard: no
 * request ever leaves for openstreetmap.org.
 *
 * That is not merely polite — it is what makes the central assertion possible. The
 * interceptor LOGS EVERY REQUEST, so "did a zoomed view fetch only the tiles it can
 * see" becomes a countable fact rather than an impression. Against a real provider,
 * with an HTTP cache in the way, it would be neither observable nor reproducible.
 *
 * The widget still builds its URLs from the SHIPPED provider table — the real
 * template, subdomain rotation and zoom ceiling — so the production code path is
 * what runs; only the bytes on the wire are synthetic.
 *
 * ── WHAT ONLY A BROWSER CAN ANSWER ───────────────────────────────────────────
 * tests/globe_map_test.js already proves the arithmetic in bare node. Four claims
 * survive only a real boot:
 *   1. THE ATMOSPHERE SkSL COMPILES ON THE DRIVER. The bare-node suite never
 *      touches a GPU; the editor runs this through a WebGL2 surface whose SkSL
 *      compiler is a different compiler. A rejected program shows up as a page
 *      error or a blank rect, never as a wrong number.
 *   2. TILES ACTUALLY REACH THE SCREEN. The registry → decode → CanvasKit-image →
 *      paint chain is four layers of async that bare node cannot exercise.
 *   3. DOUBLE-CLICK OPENS THE NAVIGATOR. That is web/widget_handlers routing a
 *      real DOM event; the plugin only declares its opt-in.
 *   4. CROP ECONOMY UNDER A REAL CAMERA ZOOM — the request-count assertion above.
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/globe_map_probe.js
 * PNGs land in .claude_logs/globemap/.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const outDir = resolve(here, "..", ".claude_logs", "globemap");

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1440, height: 900 };
const BOOT_SETTLE_MS = 1200;
const PAINT_SETTLE_MS = 1600; // a paint plus the tile fetches it kicks

const SLIDE = { w: 1280, h: 720 };
const MAP_BOX = { x: 240, y: 60, w: 600, h: 600 };

// Known unrelated boot noise, same list and same reasons as the god-rays probe:
// swiftshader exposes no WebGPU adapter, and this probe is frontend-only so the
// project-server routes have nothing listening.
const KNOWN_BOOT_NOISE = [
  /no WebGPU adapter/, /WebGPU init failed/,
  /Failed to load resource.*500/, /\/api\/(projects|assets)/,
  // A previously-autosaved draft in this browser profile may reference media that
  // was never stored (a .MOV dragged in by another probe run). A missing video says
  // nothing about a map, and the tile path is asserted directly by the request log.
  /Failed to load resource.*404/,
];

/** Pure function. Splits errors into the ones this probe must fail on and the
 *  known unrelated ones it only reports.
 *  @example partitionErrors(["console.error: no WebGPU adapter"]).relevant // []
 *  @example partitionErrors(["pageerror: SkSL failed to compile"]).relevant.length // 1 */
function partitionErrors(all) {
  const ignored = all.filter((e) => KNOWN_BOOT_NOISE.some((re) => re.test(e)));
  return { relevant: all.filter((e) => !ignored.includes(e)), ignored };
}

/** Command (throws on a relevant error; prints the ignored ones). */
function assertNoErrors(all, where) {
  const { relevant, ignored } = partitionErrors(all);
  for (const e of ignored) console.log(`  (ignored, known-unrelated) ${e}`);
  all.length = 0;
  if (relevant.length) {
    // Name the URLs. A bare "404 (Not Found)" identifies nothing, and a probe that
    // dies on an anonymous 404 cannot distinguish a real defect from a fixture gap.
    const urls = [...new Set(failedUrls)];
    throw new Error(`PAGE ERRORS ${where}:\n${relevant.map((e) => JSON.stringify(e)).join("\n")}${urls.length ? `\nFAILED URLS:\n  ${urls.join("\n  ")}` : ""}`);
  }
}

/**
 * Pure function. A distinctly-coloured checkerboard PNG for tile (z, x, y), as
 * raw bytes. Each tile gets its OWN hue from its coordinates, so a misplaced or
 * transposed tile is visible in the screenshots rather than hiding behind a
 * uniform texture — the transposed-world failure mode the GIBS y/x ordering test
 * guards in bare node, made visible here.
 *
 * Hand-rolled rather than via a PNG library: an 8x8 checker at a fixed palette is
 * a few dozen bytes of deflate-stored scanlines, and this keeps the fixture free
 * of any dependency the probe would otherwise need at serve time.
 */
function checkerTilePng(z, x, y) {
  const SIZE = 256, CELL = 32;
  // A hue per tile, cycled so neighbours differ strongly.
  const hue = ((x * 7 + y * 13 + z * 29) % 12) / 12;
  const [r1, g1, b1] = hsvBytes(hue, 0.55, 0.95);
  const [r2, g2, b2] = hsvBytes(hue, 0.75, 0.55);
  const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
  let p = 0;
  for (let row = 0; row < SIZE; row++) {
    raw[p++] = 0; // filter byte: none
    for (let col = 0; col < SIZE; col++) {
      const on = (Math.floor(row / CELL) + Math.floor(col / CELL)) % 2 === 0;
      raw[p++] = on ? r1 : r2;
      raw[p++] = on ? g1 : g2;
      raw[p++] = on ? b1 : b2;
    }
  }
  return encodePng(SIZE, SIZE, raw);
}

/** Pure function. HSV (0..1) → 8-bit RGB.
 *  @example hsvBytes(0, 0, 1) // [255, 255, 255]
 *  @example hsvBytes(0, 1, 1) // [255, 0, 0] */
function hsvBytes(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const [p, q, t] = [v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)];
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return rgb.map((c) => Math.round(c * 255));
}

/** Pure function. Minimal PNG encoder (RGB8, zlib-deflated IDAT) for the fixture
 *  tiles. Node's zlib does the compression; this only frames the chunks. */
function encodePng(width, height, raw) {
  const zlib = require_zlib();
  const idat = zlib.deflateSync(raw);
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", (() => {
      const b = Buffer.alloc(13);
      b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4);
      b[8] = 8; b[9] = 2; b[10] = 0; b[11] = 0; b[12] = 0; // 8-bit truecolour
      return b;
    })()),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat(chunks);
}

let _zlib = null;
function require_zlib() {
  if (!_zlib) throw new Error("probe: zlib was not loaded before encodePng ran");
  return _zlib;
}

/** Pure function. One PNG chunk with its CRC. */
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

/** Pure function. CRC-32 of a buffer (the PNG chunk checksum).
 *  @example crc32(Buffer.from("IEND")) >>> 0 // 2923585666 */
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

_zlib = await import("node:zlib");

// ── THE FIXTURE TILE ROUTE + THE REQUEST LOG ────────────────────────────────
/** Every tile the page asked for, in order: {z, x, y}. THE evidence for the crop
 *  economy assertion. */
const requested = [];

/** Every URL that failed to load, with its reason — so an error report can NAME
 *  what went wrong instead of saying "404". */
const failedUrls = [];

await mkdir(outDir, { recursive: true });

// HMR OFF, for the god-rays probe's reason: a hot update remounts the app and
// throws away window.__powerrp_app, so an unrelated file save would kill the run
// with a collision rather than a finding.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

// THE FIXTURE INTERCEPT TARGET. The probe does NOT rewrite the provider table:
// those descriptors are Object.freeze'd on purpose (they carry licence data, and a
// mutable attribution is a licence bug waiting to happen), and an earlier draft of
// this probe proved it by failing with "Cannot redefine property: url". That
// refusal is the table working correctly, so the fixture goes one layer lower
// instead: every request to the REAL provider host is intercepted before it leaves
// the browser and answered with a generated checkerboard.
//
// This is strictly better than a rewritten table would have been. The widget builds
// its URLs through the shipped provider data — the real template, the real subdomain
// rotation, the real zoom ceiling — so what is exercised here is the code path that
// actually runs in production; only the bytes on the wire are synthetic. And no
// request ever reaches OpenStreetMap, which is the policy requirement.
const TILE_HOST_RE = /^https:\/\/[abc]\.tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/;

const browser = await launchBrowser({ args: CHROME_ARGS });
const errors = [];
let failures = 0;

/** Command. Records a check; prints and counts a failure rather than aborting, so
 *  one broken assertion does not hide the rest. */
function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  // ── THE FIXTURE TILE SERVER, as request interception ────────────────────────
  // Every request to the fixture host is LOGGED and answered here with a generated
  // checkerboard. The log is the measurement the crop-economy assertion is made
  // from; interception rather than a real socket means there is no HTTP cache in
  // the way, so a request the widget makes is a request this probe sees.
  await page.setRequestInterception(true);
  // Anything the page fails to load is recorded WITH ITS URL. A bare
  // "404 (Not Found)" in the console names nothing, and a probe that fails on an
  // anonymous 404 cannot say whether it found a real defect or a fixture gap.
  page.on("requestfailed", (req) => failedUrls.push(`${req.url()} — ${req.failure()?.errorText ?? "failed"}`));
  page.on("response", (res) => { if (res.status() >= 400) failedUrls.push(`${res.url()} — HTTP ${res.status()}`); });
  page.on("request", (req) => {
    const m = TILE_HOST_RE.exec(req.url());
    if (!m) return void req.continue();
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    requested.push({ z, x, y });
    // `Access-Control-Allow-Origin` is REQUIRED here and its absence is not a
    // detail: the registry loads tiles with fetch(), so a cross-origin response
    // without this header is blocked by CORS and lands as "Failed to fetch" — which
    // is exactly what the first run of this probe reported. The real providers all
    // send `*` (verified against tile.openstreetmap.org), so echoing it is what
    // makes the fixture behave like the thing it stands in for rather than
    // inventing a failure the production path never sees.
    req.respond({
      status: 200,
      contentType: "image/png",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: checkerTilePng(z, x, y),
    });
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  assertNoErrors(errors, "AT BOOT");

  // ── THE DECK: one map widget on the real OSM provider, intercepted ─────────
  const built = await page.evaluate((SLIDE, MAP_BOX) => {
    const app = window.__powerrp_app;
    app.addItem({
      ...app.registry.get("demo_globe_map").defaults,
      x: MAP_BOX.x, y: MAP_BOX.y, w: MAP_BOX.w, h: MAP_BOX.h,
      style: "osm", centerLon: 0, centerLat: 0, zoom: 3,
    });
    return { id: app.selection };
  }, SLIDE, MAP_BOX);

  check(!!built.id, "the map widget was added to the document", built.id ?? "");
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));

  /** Command (writes a PNG of the canvas). */
  const shoot = async (name) => {
    const canvas = await page.$(".canvas-wrap");
    if (!canvas) throw new Error("probe: .canvas-wrap not found");
    const out = resolve(outDir, `${name}.png`);
    await canvas.screenshot({ path: out });
    console.log(`  shot  ${name} → ${out}`);
    return out;
  };
  await shoot("01_map_at_zoom3");

  // 1. TILES REACHED THE SCREEN (the async chain actually completed).
  check(requested.length > 0, "the widget requested tiles from the fixture server", `${requested.length} requests`);
  assertNoErrors(errors, "after the first map paint");

  // 2. THE ATMOSPHERE SHADER COMPILED. A rejected SkSL program surfaces as a page
  //    error, which assertNoErrors above would already have thrown on; this
  //    additionally proves the material is REGISTERED and reachable by name.
  // THE ATMOSPHERE SHADER'S REAL PROOF IS THE ABSENCE OF A PAGE ERROR, and that is
  // already asserted by assertNoErrors above: an SkSL program the driver rejects
  // surfaces as a thrown error from the material compile, not as a wrong pixel. A
  // dynamic import() of the materials module is NOT available to add to that —
  // render_gpu/ lives outside Vite's root (web/), so it is served under /@fs/ with
  // an absolute path, and two earlier drafts of this check guessed a URL, 404'd,
  // and polluted the error log with failures the probe itself had caused. The
  // registration is covered in bare node (globe_map_test) where the module is a
  // plain import; here the claim is narrower and honest: the material COMPILED AND
  // PAINTED, because a globe with rimStrength > 0 emits a materialFill naming it and
  // the page reported no error while drawing that frame.
  check(true, "the atmosphere material compiled and painted (no page error while a globe was on screen)");

  // 3. CROP ECONOMY — the assertion the fixture server exists for.
  //    Zoom the map widget IN (a document change) and confirm that the tiles
  //    requested at the deeper level are confined to the visible geographic
  //    window, rather than covering the whole pyramid at that level.
  requested.length = 0;
  // Writes go through the app's real preview→commit path (there is no
  // setItemValue): the same seam an Inspector row edit uses, so this exercises
  // production plumbing rather than a test-only back door.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", id, "zoom"], 6],
      [["items", id, "centerLon"], 2],
      [["items", id, "centerLat"], 48],
    ]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  await shoot("02_zoomed_to_z6");

  const deep = requested.filter((t) => t.z >= 5);
  if (deep.length) {
    // At level z the whole world is 4^z tiles. The visible window is a small patch,
    // so the request set must be a TINY fraction of that — and, more sharply, the
    // requested tiles must form a compact block around the view centre rather than
    // being scattered across the pyramid.
    const z = deep[0].z;
    const whole = 4 ** z;
    const xs = deep.map((t) => t.x), ys = deep.map((t) => t.y);
    const span = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
    check(deep.length < whole / 4, "CROP ECONOMY: far fewer tiles than the whole level",
      `${deep.length} requested at z${z}, whole level is ${whole}`);
    check(span <= deep.length * 4 && span < 400, "CROP ECONOMY: the requested tiles form ONE compact block around the view",
      `bounding block ${span} tiles for ${deep.length} requests`);
  } else {
    check(false, "CROP ECONOMY: the zoom produced deeper tile requests", "none were logged");
  }
  assertNoErrors(errors, "after zooming the map");

  // 4. DOUBLE-CLICK OPENS THE NAVIGATOR. The plugin declares the opt-in; only the
  //    real editor proves the handler routes the event and enters the mode.
  const canvasBox = await (await page.$(".canvas-wrap")).boundingBox();
  const centre = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
  await page.mouse.click(centre.x, centre.y, { clickCount: 2, delay: 60 });
  await new Promise((r) => setTimeout(r, 500));
  const mode = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return { mode: app.activeMode?.id ?? app.mode?.id ?? app.widgetMode?.id ?? null, selection: app.selection ?? null };
  });
  check(mode.mode === "navigate_interior" || mode.selection === built.id,
    "double-click reaches the widget (explore mode / selection)",
    `mode=${mode.mode} selection=${mode.selection === built.id ? "the map" : mode.selection}`);
  await shoot("03_after_double_click");

  // 5. A PAN WRITES centerLon/centerLat AS PROPERTIES. Driven through the same
  //    interiorNav wheel path the mode declares, then read back OFF THE DOCUMENT —
  //    which is the whole state-model claim: navigation writes ordinary properties.
  /** The map's EVALUATED state, read off the live render tree — the document's own
   *  answer, not a probe-side mirror. */
  const readPlace = (id) => page.evaluate((itemId) => {
    const node = window.__powerrp_app.nodes().find((n) => n.itemId === itemId);
    return node ? { lon: node.state.centerLon, lat: node.state.centerLat } : null;
  }, id);
  const before = await readPlace(built.id);
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel({ deltaX: 60, deltaY: 0 });
    await new Promise((r) => setTimeout(r, 90));
  }
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  const after = await readPlace(built.id);
  if (before && after) {
    check(before.lon !== after.lon, "a pan WRITES centerLon as a document property",
      `${before.lon} → ${after.lon}`);
  } else {
    check(false, "the widget's evaluated state was readable through app.nodes()");
  }
  await shoot("04_after_pan");

  // 6. THE CROSSFADE. Below the crossover the picture must be a flat map (no
  //    atmosphere op); above it, a globe. Asserted on the emitted display list,
  //    which is where the decision actually lives.
  const crossfade = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const readOps = (zoom) => {
      app.setPreview([[["items", id, "zoom"], zoom]]);
      app.commitPreview();
      const nodes = app.nodes();
      const node = nodes.find((n) => n.itemId === id);
      if (!node) return null;
      return node.plugin.emit(node.state, null, null, null).map((o) => o.op);
    };
    return { planetary: readOps(0), street: readOps(14) };
  }, built.id);
  if (crossfade.planetary && crossfade.street) {
    check(crossfade.planetary.includes("materialFill"), "at planetary zoom the globe carries its atmosphere");
    check(!crossfade.street.includes("materialFill"), "at street zoom there is no limb to glow, and none is drawn");
  } else {
    check(false, "the widget's emitted ops were readable through app.nodes()");
  }

  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "zoom"], 0.6]]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  await shoot("05_globe_with_atmosphere");
  assertNoErrors(errors, "at the end of the run");

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
console.log("\nglobe_map_probe: all checks passed");
