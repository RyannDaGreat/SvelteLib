/**
 * SVG AFFORDANCE PROBE (browser) — the two halves of the SVG adapter that only a
 * real browser can gate:
 *
 *   (1) THE WARNING BAND IS VISIBLE. core/svg_paths.js draws several SVG features
 *       WRONG rather than not at all (a `mask=` element renders UNMASKED; same for
 *       clip-path, filter, inline style=, arcs, radial gradients). Those punts used
 *       to reach console.error only, so the user just saw wrong art. The widget now
 *       appends an amber notice band naming the feature and the element. This probe
 *       injects a DEGRADED svg widget beside a CLEAN one, SCREENSHOTS the live
 *       editor (the VLM look), and proves in PIXELS — through the browser Skia
 *       rasterizer (window.__powerrp_render) — that the band shows on the degraded
 *       widget and NOTHING is added to the clean one.
 *
 *   (2) THE BROWSER CURSOR PATH DID NOT REGRESS. The built-in cursor library used
 *       to load ONLY through Vite's `import.meta.glob`, which is why nothing could
 *       render a cursor headlessly. Adding the bare-node disk reader must not
 *       disturb the bundler path, so this probe loads all 39 cursors IN THE BROWSER
 *       and compares them BYTE FOR BYTE against the same 39 read off disk in node —
 *       the two environments must hand the flatten identical sources — then renders
 *       a cursor document through the browser rasterizer.
 *
 * Spawns its OWN isolated Vite (HMR/watch OFF — siblings may be editing) + headless
 * Chromium (swiftshader), the glass_probe.js pattern. Frontend-only: backend-absent
 * 404s are ignored. Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/svg_affordance_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";
import { PNG } from "pngjs";
// puppeteer ≥23 returns screenshot bytes as a Uint8Array; pngjs demands a real
// Buffer (readUInt32BE). One adapter, used by every decode below.
const readPng = (bytes) => PNG.sync.read(Buffer.from(bytes));
import { CURSOR_NAMES, cursorSource } from "../render_gpu/gpu/svg_raster.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const appDir = resolve(HERE, "..");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const SLIDE_W = 1200;
const SLIDE_H = 640;
// A widget box big enough that the band's text is legible in the screenshot.
const SVG_W = 460;
const SVG_H = 320;
const LEFT_X = 60;    // the DEGRADED widget (left half of the frame)
const RIGHT_X = 660;  // the CLEAN widget (right half)
const SVG_Y = 160;
const BG = "#f0f0f4";
// An SVG whose circle is MASKED (so it draws unmasked = wrong) and which also
// carries an unsupported <text>: two punts, exercising the band's notice join.
const DEGRADED_SRC = '<svg viewBox="0 0 48 48"><defs><mask id="m"><rect width="24" height="48" fill="#fff"/></mask></defs><circle cx="24" cy="24" r="20" fill="#7aa2f7" mask="url(#m)"/><text x="4" y="44">hi</text></svg>';
const CLEAN_SRC = '<svg viewBox="0 0 48 48"><rect x="4" y="4" width="40" height="40" rx="8" fill="#7aa2f7"/><path d="M14 25L21 32L35 16" fill="none" stroke="#ffffff" stroke-width="4"/></svg>';
/** The rasterized frame size for the pixel gate (dpr 1, like the PNG export). */
const RASTER_W = 1200;
const RASTER_H = 640;
/** How many amber band pixels count as "the band is really on screen" — the band is
 * SVG_W wide by ~40 units tall, so a real one contributes thousands. */
const MIN_BAND_PIXELS = 500;

const registry = createRegistry();
registerAll(registry, createCommands());

/**
 * Pure function. True for a pixel that is the notice band's AMBER (warm: red-ish
 * and green-ish, clearly not blue), and not the neutral background or the blue art.
 *
 * @param {number} r - red 0..255
 * @param {number} g - green 0..255
 * @param {number} b - blue 0..255
 * @returns {boolean}
 *
 * @example isBandAmber(246, 225, 173) // true   (the band over the page background)
 * @example isBandAmber(240, 240, 244) // false  (the neutral camera background)
 * @example isBandAmber(122, 162, 247) // false  (the blue SVG art)
 */
function isBandAmber(r, g, b) {
  return r > 225 && g > 195 && b < 205 && r - b > 40;
}

/** Query. Counts band-amber pixels in a decoded PNG, split at the frame midline. */
function amberHalves(png) {
  let left = 0, right = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (!isBandAmber(png.data[i], png.data[i + 1], png.data[i + 2])) continue;
      if (x < png.width / 2) left++; else right++;
    }
  }
  return { left, right };
}

/**
 * Pure function. The two-widget document (degraded left, clean right).
 *
 * @returns {object} a serializable .powerrp.json document
 *
 * @example // svgDoc().slides[0].delta.items.degraded.type  // "svg"
 * @example // Object.keys(svgDoc().slides[0].delta.items)   // ["cam00001", "degraded", "clean"]
 */
function svgDoc() {
  const def = (type) => ({ ...registry.get(type).defaults, type });
  const items = {
    cam00001: { ...def("camera"), name: "Camera", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, z: 1000, active: true, background: BG },
    degraded: { ...def("svg"), name: "Degraded", svgSrc: DEGRADED_SRC, x: LEFT_X, y: SVG_Y, w: SVG_W, h: SVG_H, z: 1, active: true },
    clean: { ...def("svg"), name: "Clean", svgSrc: CLEAN_SRC, x: RIGHT_X, y: SVG_Y, w: SVG_W, h: SVG_H, z: 1, active: true },
  };
  return {
    meta: { name: "svg-affordance-qa", slideW: SLIDE_W, slideH: SLIDE_H },
    slides: [{ id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items } }],
  };
}

/**
 * Pure function. A document holding THE camera plus one built-in cursor item.
 *
 * @param {string} kind - a built-in cursor name (e.g. "default")
 * @returns {object} a serializable .powerrp.json document
 *
 * @example // cursorDoc("default").slides[0].delta.items.cur00001.cursorKind  // "default"
 */
function cursorDoc(kind) {
  const def = (type) => ({ ...registry.get(type).defaults, type });
  const items = {
    cam00001: { ...def("camera"), name: "Camera", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, z: 1000, active: true, background: "#202030" },
    cur00001: { ...def("cursor"), name: "Cursor", cursorKind: kind, x: 400, y: 120, w: 400, h: 400, z: 1, active: true },
  };
  return {
    meta: { name: "cursor-qa", slideW: SLIDE_W, slideH: SLIDE_H },
    slides: [{ id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items } }],
  };
}

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|WebGPU|repair:/i;
  // The flatten's own punt reports are EXPECTED here — that is the feature under
  // test. They are collected and asserted on, not counted as failures.
  const PUNT = /svg_raster: svg: /;
  const punts = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (PUNT.test(t)) punts.push(t);
    else if (!IGNORE.test(t)) errors.push(`console.error: ${t}`);
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ── (1) the degraded + clean pair, live in the editor ───────────────────────
  await page.evaluate((doc) => {
    const app = window.__powerrp_app;
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = "degraded";
  }, svgDoc());
  await sleep(1200); // Skia paint
  await page.screenshot({ path: resolve(SHOTS, "svg_warning_band_editor.png") });

  // The widget's OWN emit (the editor's real module instance) carries the band.
  const emitted = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const world = { x: 0, y: 0, rotation: 0, scale: 1 };
    const opsFor = (id) => app.registry.get("svg").emit(app.state().items[id], null, world).map((o) => ({ op: o.op, text: o.text }));
    return { degraded: opsFor("degraded"), clean: opsFor("clean") };
  });
  const bandText = emitted.degraded.find((o) => o.op === "text")?.text ?? "";
  assert(/^Unsupported: /.test(bandText), `the degraded widget emits a notice band ("${bandText.slice(0, 60)}")`);
  assert(/<circle> mask=/.test(bandText), "the band names the FEATURE and the ELEMENT (<circle> mask=)");
  assert(/<text>/.test(bandText), "the band names the second punt too (<text>)");
  assert(!emitted.clean.some((o) => o.op === "text"), "the CLEAN widget emits no notice band");
  assert(punts.some((p) => /mask=/.test(p)), `the punts still reach the console too (${punts.length} reported)`);

  // PIXELS: rasterize the frame through the browser Skia path and look for amber.
  const svgFrame = await page.evaluate(
    async (doc, w, h) => window.__powerrp_render(doc, { slide: 0, alpha: 1, width: w, height: h }),
    svgDoc(), RASTER_W, RASTER_H,
  );
  const svgPng = readPng(Buffer.from(svgFrame.split(",")[1], "base64"));
  fs.writeFileSync(resolve(SHOTS, "svg_warning_band_frame.png"), PNG.sync.write(svgPng));
  const amber = amberHalves(svgPng);
  assert(amber.left >= MIN_BAND_PIXELS, `the band RASTERIZES over the degraded widget (${amber.left} amber pixels)`);
  assert(amber.right === 0, `nothing amber over the clean widget (${amber.right} amber pixels)`);

  // ── (2) the browser cursor library, byte-for-byte against node's ────────────
  const nodeSources = Object.fromEntries(CURSOR_NAMES.map((n) => [n, cursorSource(n)]));
  const browserSources = await page.evaluate(async (base, dir, names) => {
    const url = (p) => `${base}/@fs${dir}/${p}`;
    const { cursorSource: src } = await import(url("render_gpu/gpu/svg_raster.js"));
    return Object.fromEntries(names.map((n) => [n, src(n)]));
  }, baseUrl, appDir, CURSOR_NAMES);
  const mismatched = CURSOR_NAMES.filter((n) => browserSources[n] !== nodeSources[n]);
  assert(Object.keys(browserSources).length === CURSOR_NAMES.length, `the browser bundle still yields all ${CURSOR_NAMES.length} cursors`);
  assert(mismatched.length === 0, `browser and node cursor sources are byte-identical (mismatched: ${JSON.stringify(mismatched)})`);

  const cursorFrame = await page.evaluate(
    async (doc, w, h) => window.__powerrp_render(doc, { slide: 0, alpha: 1, width: w, height: h }),
    cursorDoc("default"), RASTER_W, RASTER_H,
  );
  const cursorPng = readPng(Buffer.from(cursorFrame.split(",")[1], "base64"));
  fs.writeFileSync(resolve(SHOTS, "svg_cursor_browser_frame.png"), PNG.sync.write(cursorPng));
  // The arrow is white-on-black over a dark camera background: real ink means
  // bright pixels exist. A blank/failed cursor render would have none.
  let bright = 0;
  for (let i = 0; i < cursorPng.data.length; i += 4) if (cursorPng.data[i] > 200 && cursorPng.data[i + 1] > 200 && cursorPng.data[i + 2] > 200) bright++;
  assert(bright > MIN_BAND_PIXELS, `the cursor renders through the browser rasterizer (${bright} bright pixels)`);

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors present"); }
  console.log(fails.length ? `\nFAILED (${fails.length}): ${fails.join("; ")}` : `\nALL SVG AFFORDANCE PROBE ASSERTIONS PASSED — shots in ${SHOTS}`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
