/**
 * PAINTFIELD PROBE — proves the rebuilt fill/stroke PaintField over the state
 * foundation (any-type equations + structural keyframing):
 *   (1) Solid→Linear→Radial→Solid→Linear NEVER forgets the other modes' state
 *       (the multi-sub-state {type, solid, linear, radial} object).
 *   (2) Stop colors render through the standard ColorField (swatch) and offsets
 *       through NumericField (the DraggableNumber scrubber) — not hand-typed hex
 *       or bare inputs; each stop carries a per-slot ◆ KeyframeControls.
 *   (3) A per-slot keyframe writes to the CURRENT slide's delta at the stop path
 *       (so a stop keyframes across slides).
 *   (4) The copy-equation-path button no longer throws on a non-secure origin
 *       (the clipboard-helper fix) and flashes a "Copied!" check.
 * Screenshots each phase for a VLM look.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern
 * as text_undo_probe.js. Frontend-only — backend-absent 404s are ignored.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const { createServer } = await import("vite");
// HMR OFF + do not watch the repo: this probe WRITES screenshots into the repo
// (.claude_vlm_checks), and a watched write would trigger a full HMR reload that
// remounts the app and discards the injected test document mid-probe.
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
  // Frontend-only Vite (no server.py): ignore backend-absent noise (asset list,
  // thumbnails, proxy 500s). Clipboard errors would be real, but our copy path
  // uses the execCommand fallback in a headless page, so also tolerated here.
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A 2-slide doc: slide 0 has a camera + a rect with a BARE-STRING solid fill;
  // slide 1 is empty (for the cross-slide keyframe).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const rect = { ...def("rect"), name: "Box", x: 300, y: 150, w: 400, h: 200, z: 1, active: true, fill: "#7aa2f7" };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "paint-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: tr, delta: { items: { cam, rect } } },
      { id: "s1", name: "S2", transition: tr, delta: {} },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    const rid = Object.keys(app.doc.slides[0].delta.items).find((id) => app.doc.slides[0].delta.items[id].type === "rect");
    app.selection = rid;
    window.__rid = rid;
  });
  await sleep(500);

  // Expand any collapsed inspector categories so the fill PaintField is in DOM.
  await page.evaluate(() => {
    for (const h of document.querySelectorAll(".cat-header[aria-expanded='false']")) h.click();
  });
  await sleep(300);

  // Read the rect's fill FRESH each call (re-find by type — robust to any
  // re-keying; a cached id proved flaky). JSON round-trip inside the page: the
  // doc is a Svelte $state PROXY, and returning it RAW makes puppeteer's
  // structured-clone drop keys (it once surfaced the full object as a bare
  // string) — stringify in-page, parse in node = a faithful plain snapshot.
  const rectFill = () => page.evaluate(() => {
    const it = window.__powerrp_app.doc.slides[0].delta.items;
    const id = Object.keys(it).find((k) => it[k]?.type === "rect");
    return JSON.stringify(it[id]?.fill ?? null);
  }).then((s) => JSON.parse(s));
  // Click a Solid/Linear/Radial type button, SCOPED to the "Fill" row (the
  // Stroke PaintField has the same buttons), then WAIT for the committed fill to
  // reflect the switch (robust to the click racing a re-render — no fixed sleep).
  const clickType = async (t, expectedType) => {
    await page.evaluate((label) => {
      const row = [...document.querySelectorAll(".row")].find((r) => r.querySelector(".label")?.textContent.trim() === "Fill");
      if (!row) throw new Error(`"Fill" row not found`);
      const btn = [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
      if (!btn) throw new Error(`type button "${label}" not found in Fill row`);
      btn.click();
    }, t);
    // Wait for the COMPLETE committed shape (not just `type`) — the multi-sub-
    // state object always carries solid + linear + radial once materialized, so
    // waiting on that rides through any transient re-render/commit ordering.
    await page.waitForFunction((exp) => {
      const it = window.__powerrp_app.doc.slides[0].delta.items;
      const id = Object.keys(it).find((k) => it[k]?.type === "rect");
      const f = it[id]?.fill;
      if (exp === "solid") return f?.type === "solid" && typeof f.solid === "string" && !!f.linear && !!f.radial;
      return f?.type === exp && !!f.solid && !!f.linear && !!f.radial && Array.isArray(f.linear.stops);
    }, { timeout: 5000 }, expectedType);
  };

  await page.screenshot({ path: resolve(SHOTS, "paintfield_1_solid.png") });
  assert(typeof (await rectFill()) === "string", "starts as a bare-string solid (byte-identical shape)");

  // → Linear: object materializes with ALL sub-states.
  await clickType("Linear", "linearGradient");
  let f = await rectFill();
  assert(f && f.type === "linearGradient" && f.solid === "#7aa2f7" && f.linear && f.radial,
    "Solid→Linear: multi-sub-state object {type, solid, linear, radial}");
  assert(Array.isArray(f.linear.stops), "linear.stops is an ARRAY (not a numeric-keyed object)");

  // Edit linear stop 0's offset via the exact setPreview/commitPreview path a
  // stop's NumericField uses — INTO a slide whose delta already holds the whole
  // stops array (the live-crash path). Must keep an ARRAY of complete stops.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const it = app.doc.slides[0].delta.items;
    const id = Object.keys(it).find((k) => it[k]?.type === "rect");
    app.setPreview([[["items", id, "fill", "linear", "stops", 0, "offset"], 0.42]]);
    app.commitPreview();
  });
  await sleep(200);
  f = await rectFill();
  assert(Array.isArray(f.linear.stops) && f.linear.stops.every((s) => "offset" in s && "color" in s),
    "per-index stop edit keeps stops an ARRAY of complete {offset,color} (no numeric-keyed object crash)");

  await clickType("Radial", "radialGradient");
  f = await rectFill();
  assert(f.type === "radialGradient" && f.radial && f.radial.stops.length >= 2, "Linear→Radial: radial sub-state present");
  assert(f.linear.stops[0].offset === 0.42, "Linear→Radial: LINEAR stops retained (not forgotten)");

  await clickType("Solid", "solid");
  f = await rectFill();
  assert(f.type === "solid" && f.solid === "#7aa2f7", "Radial→Solid: solid retained");
  assert(f.linear.stops[0].offset === 0.42 && f.radial, "Radial→Solid: BOTH gradients still remembered");

  await clickType("Linear", "linearGradient");
  f = await rectFill();
  assert(f.type === "linearGradient" && f.linear.stops[0].offset === 0.42, "back to Linear: offset 0.42 NEVER forgotten");
  await page.screenshot({ path: resolve(SHOTS, "paintfield_2_linear.png") });

  // (1b) EQUATION mode: the whole fill becomes a "=" color expression that
  // evaluateState resolves + validates as a color (the any-type UNIFICATION).
  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".row")].find((r) => r.querySelector(".label")?.textContent.trim() === "Fill");
    [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "= Eq").click();
  });
  await page.waitForFunction(() => {
    const it = window.__powerrp_app.doc.slides[0].delta.items;
    const id = Object.keys(it).find((k) => it[k]?.type === "rect");
    return typeof it[id]?.fill === "string" && it[id].fill.startsWith("=");
  }, { timeout: 5000 });
  const eqRaw = await rectFill();
  assert(typeof eqRaw === "string" && eqRaw.startsWith("="), `Equation mode: fill is a "=" expression (${eqRaw})`);
  const eqResolved = await page.evaluate(() => {
    const it = window.__powerrp_app.state().items;
    const id = Object.keys(it).find((k) => it[k]?.type === "rect");
    return it[id]?.fill;
  });
  assert(typeof eqResolved === "string" && /^#[0-9a-f]{3,8}$/i.test(eqResolved), `Equation resolves + validates to a color (${eqResolved})`);
  await clickType("Solid", "solid");
  f = await rectFill();
  assert(f.type === "solid" && typeof f.solid === "string", "Equation→Solid restores a valid paint (no crash)");
  await clickType("Linear", "linearGradient"); // leave it in gradient mode for the control/keyframe checks below
  f = await rectFill();

  // (2) Controls: stop colors are ColorFields (swatch), offsets NumericFields,
  //     each stop has a KeyframeControls ◆. Count within the fill PaintField.
  const controls = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".row")].find((r) => r.querySelector(".label")?.textContent.trim() === "Fill");
    return {
      swatches: row.querySelectorAll(".colorfield-swatch").length,
      numfields: row.querySelectorAll(".numfield").length,
      diamonds: row.querySelectorAll(".keybtn").length,
    };
  });
  assert(controls.swatches >= 2, `stop colors are ColorFields (swatches=${controls.swatches})`);
  assert(controls.numfields >= 2, `stop offsets are NumericFields (numfields=${controls.numfields})`);
  assert(controls.diamonds >= 2, `each stop has a keyframe ◆ (keybtns=${controls.diamonds})`);

  // (3) Per-slot keyframe across slides: on slide 1, keyframe stop 0.
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 1; });
  await sleep(300);
  await page.evaluate(() => {
    // Click the FIRST stop's keyframe ◆ within the Fill row.
    const row = [...document.querySelectorAll(".row")].find((r) => r.querySelector(".label")?.textContent.trim() === "Fill");
    row.querySelector(".keybtn").click();
  });
  await sleep(300);
  const kfOnS1 = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const it0 = app.doc.slides[0].delta.items;
    const id = Object.keys(it0).find((k) => it0[k]?.type === "rect");
    let cur = app.doc.slides[1].delta; // getPath into the sparse stop delta
    for (const k of ["items", id, "fill", "linear", "stops", 0]) { if (cur == null) break; cur = cur[k]; }
    return cur !== undefined && cur !== null;
  });
  assert(kfOnS1, "per-slot ◆ keyframes stop 0 on slide 1 (cross-slide keyframe)");

  // (4) copy-equation-path button no longer throws + flashes a check.
  const errMark = errors.length;
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; });
  await sleep(200);
  const copied = await page.evaluate(() => {
    const btn = document.querySelector(".copy-path-btn");
    if (!btn) return "no-button";
    btn.click();
    return "clicked";
  });
  await sleep(200);
  const checkShown = await page.evaluate(() => {
    const ic = document.querySelector(".copy-path-btn iconify-icon");
    return ic?.getAttribute("icon");
  });
  assert(copied === "clicked", "copy-path button is present");
  assert(errors.length === errMark, "copy-path does NOT throw on a non-secure origin (clipboard fix)");
  assert(checkShown === "mdi:check", `copy-path flashes a "Copied!" check (icon=${checkShown})`);

  if (errors.length) console.error("PAGE ERRORS:\n" + errors.join("\n"));
  console.log(`\n${fails.length ? "FAILED: " + fails.length : "PASS"} — PaintField probe (shots in .claude_vlm_checks/paintfield_*.png)`);
  process.exitCode = fails.length || errors.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
