/**
 * THE SVG/ICONIFY FILL ROW — BROWSER PROBE (real Skia pixels, real Inspector).
 *
 * The bare-node suite (tests/paint_off_test.js) proves the display-list algebra:
 * off parses to null, the override substitutes every op's paint, the row is one
 * shared declaration. What it CANNOT prove is that any of that reaches a pixel —
 * bare node has no GL context and cannot even fetch an icon. This probe closes
 * that gap on the two claims the user actually made:
 *
 *   "right now it's just always black"      → an SVG with fill OFF renders its
 *                                             own (black) intrinsic paint.
 *   "we need to be able to color them"      → the same SVG with fill ON renders
 *                                             the chosen colour, at the same
 *                                             pixels, with nothing else changed.
 *
 * It reads the pixels back through gpuService (the shared offscreen compositor
 * every pixel consumer uses — thumbnails, minimap, PNG export), so a pass means
 * the real WebGL2 Skia surface drew it, not that a JS object had a field set.
 *
 * The artwork is an INLINE svg source (svgText), deliberately: the Iconify API is
 * a network dependency this probe must not have, and the iconify widget shares
 * the row, the resolver and the flatten with the svg widget — the sharing itself
 * is asserted by identity in the node suite, so proving the pixel path once
 * proves it for both.
 *
 * Also checks the INSPECTOR half: the row exists, it is a PaintField with an Off
 * tab, Off is the state a fresh widget is in, and choosing a colour writes the
 * document (the "declared but not wired" failure mode).
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), the
 * text_undo_probe pattern. Run from POWERRP or the SvelteLib root.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A monochrome artwork authored the way the mono icon sets are: currentColor
 *  for the filled shape, and a SEPARATE stroked path with fill="none" — the
 *  tabler/lucide convention a fill-only override would silently miss. */
const ART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <rect x="0" y="0" width="10" height="6" fill="currentColor"/>
  <path d="M1 8L9 8" fill="none" stroke="currentColor" stroke-width="2"/>
</svg>`;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7|listAssets/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A one-SVG document on a WHITE camera background, so an unpainted region reads
  // as pure white and any ink at all is unambiguous.
  await page.evaluate((svgText) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 400, z: 1000, active: true, background: "#ffffff" };
    const art = { ...def("svg"), name: "Art", x: 0, y: 0, w: 400, h: 400, z: 1, active: true, svgSource: "inline", svgSrc: svgText, preserveAspect: false };
    const doc = { meta: { name: "svg-fill-qa", slideW: 400, slideH: 400 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, art } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, ART_SVG);
  await sleep(600);

  const svgId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "svg");
  });
  assert(!!svgId, "svg widget created from inline source");

  // A fresh widget's stored fill IS the off tag — the default the whole
  // byte-identical claim rests on.
  /** The item's stored `fill`, JSON-STRINGIFIED INSIDE THE PAGE. Reading the raw
   *  object across page.evaluate's boundary is not enough: the document lives in a
   *  Svelte 5 `$state` PROXY, and puppeteer's structured-clone of a proxy yields
   *  `{}` — the value is intact, the transport is what loses it. Serialize on the
   *  page side and the real paint comes back. */
  const storedFill = () => page.evaluate((id) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].fill), svgId);

  const freshFill = await storedFill();
  assert(freshFill === '{"type":"none"}', `a fresh SVG's fill is stored OFF; got ${freshFill}`);

  /** Renders the current document through the SHARED pixel service and returns
   *  the rgba of two probe points: one inside the FILLED rect, one on the STROKED
   *  rule below it. Same seam thumbnails/minimap/PNG export use. */
  const sample = () => page.evaluate(async () => {
    const app = window.__powerrp_app;
    const svc = await import("/gpuService.js");
    const W = 200, H = 200;
    const canvas = await svc.renderCameraFrame(app.doc, { slideIndex: 0, alpha: 1, registry: app.registry, width: W, height: H });
    const ctx = canvas.getContext("2d");
    const at = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    // viewBox is 10x10 stretched to the 200x200 frame: the rect spans y 0..6
    // (0..120px), the stroked rule sits at y=8 (160px).
    return { fillPx: at(W / 2, 60), strokePx: at(W / 2, 160), cornerPx: at(4, 196) };
  });

  // ── OFF: the artwork's own paint, which for a currentColor icon is INK-BLACK
  //    — the user's "it's just always black", reproduced as the DEFAULT. ───────
  const off = await sample();
  const isBlack = (p) => p[0] < 40 && p[1] < 40 && p[2] < 40 && p[3] > 200;
  const isWhite = (p) => p[0] > 215 && p[1] > 215 && p[2] > 215;
  assert(isBlack(off.fillPx), `fill OFF: the filled shape draws its own black ink; got rgba(${off.fillPx})`);
  assert(isBlack(off.strokePx), `fill OFF: the stroked rule draws its own black ink; got rgba(${off.strokePx})`);
  assert(isWhite(off.cornerPx), `fill OFF: unpainted background stays white; got rgba(${off.cornerPx})`);

  // ── ON: every path takes the override — the fill AND the stroke. ───────────
  const TINT = "#ff00ff";
  // Written through the app's UNIVERSAL edit path (setPreview → commitPreview),
  // the same one every Inspector field uses — so this exercises the real commit
  // seam rather than poking the document behind the app's back.
  await page.evaluate((id, tint) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill"], tint]]);
    app.commitPreview();
  }, svgId, TINT);
  await sleep(400);

  const on = await sample();
  const isMagenta = (p) => p[0] > 200 && p[1] < 60 && p[2] > 200 && p[3] > 200;
  assert(isMagenta(on.fillPx), `fill ON: the filled shape takes the override; got rgba(${on.fillPx})`);
  assert(isMagenta(on.strokePx), `fill ON: the STROKED path takes it too (the outline-icon case); got rgba(${on.strokePx})`);
  assert(isWhite(on.cornerPx), `fill ON: the override recolours, it does not FLOOD the box; got rgba(${on.cornerPx})`);

  // ── BACK TO OFF: the row is a reversible MODE, and returning restores the
  //    exact original pixels — the byte-identical gate, measured in pixels. ────
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill"], { type: "none" }]]);
    app.commitPreview();
  }, svgId);
  await sleep(400);
  const back = await sample();
  assert(JSON.stringify(back.fillPx) === JSON.stringify(off.fillPx) && JSON.stringify(back.strokePx) === JSON.stringify(off.strokePx),
    `turning fill back OFF restores the original pixels exactly; got fill rgba(${back.fillPx}) stroke rgba(${back.strokePx})`);

  // ── THE INSPECTOR ROW: a real PaintField with an Off tab, showing Off. ─────
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, svgId);
  await sleep(500);

  const rowUi = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Fill");
    if (!row) return { found: false };
    const tabs = [...row.querySelectorAll(".paint-type-tab")].map((b) => ({ label: b.textContent.trim(), pressed: b.getAttribute("aria-pressed") === "true" }));
    return { found: true, tabs, note: row.querySelector(".paint-off-note")?.textContent.trim() ?? null };
  });
  assert(rowUi.found, "the Inspector shows a Fill row for the SVG widget");
  assert(rowUi.tabs.some((t) => t.label === "Off"), `the Fill row's PaintField offers an Off tab; got ${JSON.stringify(rowUi.tabs.map((t) => t.label))}`);
  assert(rowUi.tabs.find((t) => t.label === "Off")?.pressed, "Off is the ACTIVE tab for a fresh SVG (default off)");
  assert(rowUi.note && /own colours/i.test(rowUi.note),
    `the Off state explains what off means IN THIS SLOT (the row's offMeans); got ${JSON.stringify(rowUi.note)}`);

  // Clicking Solid must WRITE the document — the "declared but not wired" check,
  // from the UI side rather than the model side.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Fill");
    [...row.querySelectorAll(".paint-type-tab")].find((b) => b.textContent.trim() === "Solid").click();
  });
  await sleep(400);
  const afterSolid = await storedFill();
  assert(afterSolid.includes('"type":"solid"'),
    `clicking Solid turns the fill ON in the document; got ${afterSolid}`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nSVG FILL ROW PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nSVG FILL ROW PROBE PASSED — off renders the artwork's own ink, on recolours fills AND strokes in real Skia pixels, and the Inspector row round-trips.");
} finally {
  await browser.close();
  await server.close();
}
