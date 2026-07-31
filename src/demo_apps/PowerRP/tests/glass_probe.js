/**
 * LIQUID GLASS PROBE (browser) — proves the glass widget renders LIVE in the
 * editor through the real GPU (WebGL2 / swiftshader) Skia pipeline, not just in
 * node. It:
 *   (1) injects a doc = camera + a colorful backdrop (circles + a bright bar) +
 *       ONE demo_glass panel on top, and SCREENSHOTS the live canvas (the money
 *       shot for a VLM look);
 *   (2) asserts the glass widget's self.* material knobs appear in the Inspector
 *       under a "Custom" category (equation-aware fields);
 *   (3) confirms a knob (refractionStrength) accepts a LITERAL and a `= self.…`
 *       EQUATION through the field commit path, resolving via evaluateState;
 *   (4) fails on any page error (the first live RuntimeEffect must not crash).
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), the
 * demo_widget_probe.js pattern. Frontend-only — backend-absent 404s are ignored.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/glass_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const PANEL_W = 460; // demo_glass width, so `= self.w / 20` resolves to a known 23
const EXPECTED_EQ_REFRACT = PANEL_W / 20;
const LITERAL_REFRACT = 30;

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // The last alternative is the WEBGPU-ABSENCE line: an environment report from
  // videoV7Gpu.js, not a glass/backdrop defect. See tests/webgpu_absence_noise.js.
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|VideoV7: WebGPU init failed — using 2D drawImage fallback/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Inject a doc: camera + colorful backdrop (bright bar + saturated circles) +
  // ONE glass panel on top; select the glass so the Inspector shows its knobs.
  await page.evaluate((panelW) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 600, z: 1000, active: true, background: "#1a1040" };
    const items = { cam };
    // a bright diagonal-ish bar (rotated rect) = a hard edge for refraction to bend
    items.bar = { ...def("rect"), name: "Bar", x: -80, y: 250, w: 1160, h: 90, z: 1, rotation: -0.14, fill: "#eef2ff", cornerRadius: 0, active: true };
    // scattered saturated circles
    const cols = ["#50dcc8", "#ff5a78", "#ffd246", "#78a0ff", "#b4ff78", "#c37bff"];
    let seed = 9;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 22; i++) {
      const d = 40 + rnd() * 90;
      items["c" + i] = { ...def("circle"), name: "C" + i, x: rnd() * 940, y: rnd() * 560, w: d, h: d, z: 2, fill: cols[i % cols.length], active: true };
    }
    // the glass panel, on top
    items.glass = { ...def("demo_glass"), name: "Glass", x: 270, y: 210, w: panelW, h: 170, z: 50, active: true };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "glass-qa", slideW: 1000, slideH: 600 }, slides: [
      { id: "s0", name: "S1", transition: tr, delta: { items } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    const id = Object.keys(app.doc.slides[0].delta.items).find((k) => app.doc.slides[0].delta.items[k].type === "demo_glass");
    app.selection = id;
    window.__id = id;
  }, PANEL_W);
  await sleep(1200); // Skia paint + first RuntimeEffect compile

  await page.screenshot({ path: resolve(SHOTS, "glass_live_editor.png") });

  // (2) the material knobs appear in the Inspector under a "Custom" category.
  await page.evaluate(() => {
    for (const h of document.querySelectorAll(".cat-header[aria-expanded='false']")) h.click();
  });
  await sleep(300);
  const rows = await page.evaluate(() => {
    const labels = [...document.querySelectorAll(".row .label")].map((l) => l.textContent.trim());
    const customHeader = [...document.querySelectorAll(".cat-title")].some((t) => t.textContent.trim() === "Custom");
    return { labels, customHeader };
  });
  assert(rows.customHeader, "a 'Custom' category header is rendered for the glass knobs");
  for (const want of ["Blur radius", "Refraction strength", "Backdrop scale", "Chromatic", "Tint", "Squircle"])
    assert(rows.labels.includes(want), `Inspector shows the '${want}' material knob`);

  // (3a) a knob accepts a LITERAL through the field commit path.
  const lit = await page.evaluate((v) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", window.__id, "refractionStrength"], v]]);
    app.commitPreview();
    return { stored: app.doc.slides[0].delta.items[window.__id].refractionStrength, resolved: app.state().items[window.__id].refractionStrength };
  }, LITERAL_REFRACT);
  assert(lit.stored === LITERAL_REFRACT && lit.resolved === LITERAL_REFRACT, `literal refractionStrength accepted + resolves (${lit.stored}/${lit.resolved})`);

  // (3b) a knob accepts a `= self.…` EQUATION resolving via evaluateState.
  const eq = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", window.__id, "refractionStrength"], "= self.w / 20"]]);
    app.commitPreview();
    return { stored: app.doc.slides[0].delta.items[window.__id].refractionStrength, resolved: app.state().items[window.__id].refractionStrength };
  });
  assert(typeof eq.stored === "string" && eq.stored.startsWith("="), `equation stored verbatim ("${eq.stored}")`);
  assert(eq.resolved === EXPECTED_EQ_REFRACT, `equation resolves via evaluateState (self.w/20 = ${EXPECTED_EQ_REFRACT}, got ${eq.resolved})`);
  await page.screenshot({ path: resolve(SHOTS, "glass_live_equation.png") });

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors present"); }
  console.log(fails.length ? `\nFAILED (${fails.length}): ${fails.join("; ")}` : `\nALL GLASS PROBE ASSERTIONS PASSED`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
