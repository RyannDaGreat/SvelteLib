/**
 * WYSIWYG LATEX EDIT PROBE — proves the MathLive in-place equation editor:
 *   1. Double-clicking a latex widget mounts a <math-field> at its world pose.
 *   2. The field seeds with the item's LaTeX and the canvas equation is
 *      SUPPRESSED (only the DOM field shows) while editing.
 *   3. Editing + commit re-typesets the CANVAS through the normal latexVector
 *      path to the NEW value (one undo unit).
 *   4. ONE undo restores the original equation.
 *
 * Also captures the ENTER/EXIT for VLM inspection of the MathLive↔MathJax "pop":
 *   .claude_vlm_checks/latex_edit_{static,editing,committed}.png
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern as
 * text_undo_probe.js. Run from POWERRP or the SvelteLib root (cwd-independent).
 * Backend-absent resource 404s in the boot gate are ignored (frontend-only Vite).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
mkdirSync(vlmDir, { recursive: true });

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

// Fraction + sqrt so the render exercises RULES (fraction bar, √ vinculum) — the
// flattener must emit them (issue #1) or the static render drops the bars.
const ORIGINAL_LATEX = "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";
const EDITED_LATEX = "\\frac{1}{2} + \\sqrt{n}";
const TYPESET_MS = 3000; // MathJax bundle load (first typeset) + tex2svg + raster + createImageBitmap

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/|\/asset\//i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint + MathLive boot import
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A single latex widget centered in the camera.
  await page.evaluate((latex) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#ffffff" };
    // Deliberately WIDE, SHORT box (non-natural aspect for this equation) so
    // squash-vs-letterbox is unmistakable: preserveAspect must NOT stretch it.
    const eq = { ...def("latex"), name: "Eq", x: 220, y: 190, w: 560, h: 120, z: 1, active: true, latex, fontSize: 44, ink: "#1a1a2e" };
    const doc = { meta: { name: "latex-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, eq } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, ORIGINAL_LATEX);
  await sleep(TYPESET_MS); // let MathJax typeset the static equation onto the canvas

  const latexId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "latex");
  });
  assert(!!latexId, "latex widget exists in the doc");

  const shot = async (name) => {
    const el = await page.$(".render-area");
    await el.screenshot({ path: resolve(vlmDir, `latex_edit_${name}.png`) });
  };
  const latexVal = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    return app.previewDelta?.items?.[id]?.latex ?? app.state().items?.[id]?.latex;
  }, latexId);

  // (1) STATIC — the committed MathJax render on the canvas, no editor.
  await shot("static");

  // (2) ENTER EDIT — double-click routes to beginLatexEdit → mount the field.
  await page.evaluate((id) => window.__powerrp_app.beginLatexEdit(id), latexId);
  await sleep(500); // mount + fade-in
  const mounted = await page.evaluate(() => ({
    field: !!document.querySelector("math-field"),
    seam: !!window.__powerrp_latexEdit,
    value: window.__powerrp_latexEdit?.getValue() ?? null,
    editing: !!window.__powerrp_app.latexEditing,
  }));
  assert(mounted.field, "a <math-field> is mounted on begin");
  assert(mounted.seam, "window.__powerrp_latexEdit dev seam is present");
  assert(mounted.value === ORIGINAL_LATEX, `field seeded with the item's latex (got ${JSON.stringify(mounted.value)})`);
  assert(mounted.editing, "app.latexEditing is set");
  await shot("editing");

  // SELECTION LEGIBILITY (issue #3): select the whole equation and screenshot —
  // the selection band must be visible AND the glyphs must stay legible (never
  // white-on-white). Visual check via the VLM image.
  await page.evaluate(() => document.querySelector("math-field")?.select());
  await sleep(200);
  await shot("editing_selected");

  // (3) EDIT — replace the equation through the field, then verify the preview
  //     staged it (canvas is suppressed → no per-keystroke re-typeset).
  await page.evaluate((v) => window.__powerrp_latexEdit.setValue(v), EDITED_LATEX);
  await sleep(200);
  assert((await latexVal()) === EDITED_LATEX, "edit is staged into the preview");

  // (4) COMMIT — Escape gesture (via the seam) → one undo unit + closing crossfade.
  await page.evaluate(() => window.__powerrp_latexEdit.commit());
  await sleep(TYPESET_MS); // closing fade + re-typeset the NEW equation on the canvas
  const afterCommit = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    return {
      committed: app.state().items?.[id]?.latex,
      editing: app.latexEditing,
      field: !!document.querySelector("math-field"),
    };
  }, latexId);
  assert(afterCommit.committed === EDITED_LATEX, `canvas value re-typeset to the edit (got ${JSON.stringify(afterCommit.committed)})`);
  assert(afterCommit.editing === null, "latexEditing cleared after the closing crossfade");
  assert(afterCommit.field === false, "the <math-field> unmounted after commit");
  await shot("committed");

  // (5) ONE undo restores the original equation (the commit was one undo unit).
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(400);
  assert((await latexVal()) === ORIGINAL_LATEX, `ONE undo restores the original latex (got ${JSON.stringify(await latexVal())})`);

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors present"); }
  console.log(fails.length ? `\nFAILED (${fails.length})` : "\nALL PASSED");
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
