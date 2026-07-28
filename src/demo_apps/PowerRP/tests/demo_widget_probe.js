/**
 * DEMO-WIDGET PROBE (browser) — proves the demo-widget infrastructure in the
 * live editor:
 *   (1) The "Insert Demo Widget" command-palette SUBMENU exists as a top-level
 *       entry with children (the color-theme submenu pattern), reachable via a
 *       top-level fuzzy search, and each child arms a real registered plugin.
 *   (2) A Demo Showcase widget's CUSTOM self.* property (`inset`) appears in the
 *       Inspector under a "Custom" category, rendered by the equation-aware
 *       NumericField.
 *   (3) That property ACCEPTS a literal AND a `= …` equation through the field's
 *       own commit path, and both resolve through evaluateState (app.state()).
 * Screenshots each phase for a VLM look.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern
 * as paintfield_probe.js. Frontend-only — backend-absent 404s are ignored.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/demo_widget_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const BOX_W = 240; // demo_showcase width, so `= self.w / 4` resolves to a known 60
const EXPECTED_EQ_INSET = BOX_W / 4;
const LITERAL_INSET = 40;

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
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ── (1) The submenu exists, is a top-level submenu, and its children resolve.
  const submenu = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const entry = app.commands.get("insert-demo-widget");
    const topHit = app.commands.search("insert demo").some((c) => c.id === "insert-demo-widget");
    // Each child must resolve a REAL registered plugin type (loud get() would throw).
    const childTypes = { "demo-insert-showcase": "demo_showcase", "demo-insert-magnifier": "magnifier" };
    const childResolves = entry.children.map((c) => {
      const t = childTypes[c.id];
      let ok = false;
      try { ok = !!app.registry.get(t); } catch { ok = false; }
      return { id: c.id, hasRun: typeof c.run === "function", resolves: ok };
    });
    return {
      hasChildren: Array.isArray(entry.children),
      childIds: entry.children.map((c) => c.id),
      isTopLevelSearchable: topHit,
      childResolves,
    };
  });
  assert(submenu.hasChildren, "'Insert Demo Widget' is a submenu (has children)");
  assert(submenu.isTopLevelSearchable, "submenu is reachable via a top-level palette search (like color-theme)");
  assert(submenu.childIds.includes("demo-insert-showcase") && submenu.childIds.includes("demo-insert-magnifier"),
    `children include the showcase + magnifier (${submenu.childIds.join(", ")})`);
  assert(submenu.childResolves.every((c) => c.hasRun && c.resolves),
    "every child has a run() that arms a real registered plugin type");

  // ── Inject a doc with ONE demo_showcase item + the camera; select it.
  await page.evaluate((boxW) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const demo = { ...def("demo_showcase"), name: "Demo", x: 300, y: 150, w: boxW, h: 160, z: 1, active: true };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "demo-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: tr, delta: { items: { cam, demo } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    const id = Object.keys(app.doc.slides[0].delta.items).find((k) => app.doc.slides[0].delta.items[k].type === "demo_showcase");
    app.selection = id;
    window.__id = id;
  }, BOX_W);
  await sleep(500);

  // Expand every collapsed inspector category so the Custom region is in DOM.
  await page.evaluate(() => {
    for (const h of document.querySelectorAll(".cat-header[aria-expanded='false']")) h.click();
  });
  await sleep(300);
  await page.screenshot({ path: resolve(SHOTS, "demo_widget_1_inspector.png") });

  // ── (2) The custom `inset` prop appears in the Inspector, under a "Custom"
  //        category, rendered by the equation-aware NumericField.
  const insetRow = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".row")].find((r) => r.querySelector(".label")?.textContent.trim() === "Inset");
    if (!row) return { present: false };
    const customHeader = [...document.querySelectorAll(".cat-title")].some((t) => t.textContent.trim() === "Custom");
    return { present: true, hasNumfield: !!row.querySelector(".numfield"), customHeader };
  });
  assert(insetRow.present, "custom 'Inset' prop appears as a row in the Inspector");
  assert(insetRow.customHeader, "a 'Custom' category header is rendered");
  assert(insetRow.hasNumfield, "the Inset row uses the equation-aware NumericField");

  // ── (3a) Accepts a LITERAL (via the field's commit path).
  const litInset = await page.evaluate((lit) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", window.__id, "inset"], lit]]);
    app.commitPreview();
    const stored = app.doc.slides[0].delta.items[window.__id].inset;
    return { stored, resolved: app.state().items[window.__id].inset };
  }, LITERAL_INSET);
  assert(litInset.stored === LITERAL_INSET && litInset.resolved === LITERAL_INSET,
    `literal inset accepted + resolves (stored=${litInset.stored}, resolved=${litInset.resolved})`);

  // ── (3b) Accepts a `= …` EQUATION that resolves against self through evaluateState.
  const eqInset = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", window.__id, "inset"], "= self.w / 4"]]);
    app.commitPreview();
    const stored = app.doc.slides[0].delta.items[window.__id].inset;
    return { stored, resolved: app.state().items[window.__id].inset };
  });
  assert(typeof eqInset.stored === "string" && eqInset.stored.startsWith("="),
    `equation stored verbatim as a "=" string (${eqInset.stored})`);
  assert(eqInset.resolved === EXPECTED_EQ_INSET,
    `equation resolves via evaluateState (self.w/4 = ${EXPECTED_EQ_INSET}, got ${eqInset.resolved})`);
  await page.screenshot({ path: resolve(SHOTS, "demo_widget_2_equation.png") });

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors present"); }
  console.log(fails.length ? `\nFAILED (${fails.length}): ${fails.join("; ")}` : `\nALL PROBE ASSERTIONS PASSED`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
