/**
 * WYSIWYG RICH-TEXT EDITING probe — rewritten for the TRUE in-place editor
 * (Skia-owned caret/selection; render_gpu/skia/text_layout.js + TextEditController).
 * The old DOM-mirror overlay (readRunsFromDom / DOM Selection) is gone; the
 * selection now lives in the MODEL and the caret/selection are self-drawn from the
 * SAME CanvasKit Paragraph the render draws. This probe drives the REAL controller
 * via window.__powerrp_textEdit (the seam the floating toolbar uses) + real keys.
 *
 * PROBES (headless, zero unexpected console errors):
 *  P1  dblclick enters in-place edit; the controller root sits over the widget
 *      top-left; the hidden input sink exists; the item still renders live (Skia).
 *  P2  rich per-character edit: select "Hello" (model offsets), bold+recolor+
 *      highlight via the toolbar's applyStyle path; runs SPLIT; pixels change;
 *      ONE undo restores the original single run.
 *  P3  ENTER = newline (never commits); typing appends; cancel reverts.
 *  P4  VERTICAL ALIGN flows into the caret geometry: caretScreen(0).y increases
 *      top → middle → bottom (the layout's valignOffset reaches the editor).
 *  P5  toolbar ALIGN applies per-paragraph (applyPara); ONE undo restores.
 *
 * Spawns its OWN vite (isolated). Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/text_wysiwyg_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Ignore backend-absent noise: this probe self-spins a FRONTEND-ONLY Vite (no
  // server.py), so best-effort thumbnail-persist POSTs 404. Orthogonal to this test.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(1200);
  if (errors.length) { console.error("PAGE ERRORS AT BOOT:\n" + errors.join("\n")); process.exit(1); }

  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 300, z: 1000, active: true, background: "#101014" };
    const richText = { runs: [{ text: "Hello World", bold: false, italic: false, underline: false, strike: false, size: 32, font: "system", color: "#ffffff", outlineColor: "#000000", outlineWidth: 0, highlight: "" }], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] };
    const txt = { ...def("text"), name: "Title", x: 40, y: 40, w: 300, h: 120, z: 1, active: true, text: richText, size: 32, color: "#ffffff", font: "system", valign: "top" };
    const doc = { meta: { name: "wysiwyg-probe", slideW: 400, slideH: 300 }, slides: [
      { id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, txt } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await sleep(400);
  if (errors.length) { console.error("PAGE ERRORS AFTER DOC LOAD:\n" + errors.join("\n")); process.exit(1); }

  const textId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "text");
  });
  const isEditing = () => page.evaluate(() => !!window.__powerrp_app.textEditing?.itemId);
  const frameCount = () => page.evaluate(() => window.__powerrp_app.renderFrameCount);
  const storedRuns = () => page.evaluate((id) => (window.__powerrp_app.doc.slides[0].delta.items[id].text?.runs ?? []).map((r) => ({ ...r })), textId);
  const focusSink = () => page.evaluate(() => document.querySelector(".text-edit-sink")?.focus());
  async function textCenterScreen() {
    return page.evaluate((id) => {
      const app = window.__powerrp_app;
      const n = app.nodes().find((nn) => nn.itemId === id);
      const T = { apply: (t, px, py) => { const c = Math.cos(t.rotation), s = Math.sin(t.rotation); return { x: t.x + t.scale * (c * px - s * py), y: t.y + t.scale * (s * px + c * py) }; } };
      const wp = T.apply(n.world, (n.state.w ?? 0) / 2, (n.state.h ?? 0) / 2);
      const s = app.canvasActions.worldToScreen(wp.x, wp.y);
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      return { x: rect.left + s.x, y: rect.top + s.y };
    }, textId);
  }

  // ── P1: dblclick enters WYSIWYG edit; controller over the widget; item renders live
  const c = await textCenterScreen();
  await page.mouse.click(c.x, c.y, { clickCount: 2 });
  await sleep(250);
  assert(await isEditing(), "P1: dblclick on text enters in-place edit (app.textEditing set)");
  const geom = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const root = document.querySelector(".text-edit-overlay-root");
    const sink = document.querySelector(".text-edit-sink");
    if (!root) return { open: false };
    const rb = root.getBoundingClientRect();
    const n = app.nodes().find((nn) => nn.itemId === id);
    const T = { apply: (t, px, py) => { const c = Math.cos(t.rotation), s = Math.sin(t.rotation); return { x: t.x + t.scale * (c * px - s * py), y: t.y + t.scale * (s * px + c * py) }; } };
    const tl = T.apply(n.world, 0, 0);
    const s = app.canvasActions.worldToScreen(tl.x, tl.y);
    const rr = document.querySelector(".render-area").getBoundingClientRect();
    return { open: true, hasSink: !!sink, rootTL: { x: rb.left, y: rb.top }, widgetTL: { x: rr.left + s.x, y: rr.top + s.y }, painted: app.nodes().filter((nn) => nn.itemId === id).length };
  }, textId);
  assert(geom.open, "P1: the controller root (.text-edit-overlay-root) exists");
  assert(geom.hasSink, "P1: the hidden input sink (.text-edit-sink) exists");
  if (geom.open) {
    const dx = Math.abs(geom.rootTL.x - geom.widgetTL.x), dy = Math.abs(geom.rootTL.y - geom.widgetTL.y);
    assert(dx <= 2 && dy <= 2, `P1: controller root sits over the widget top-left (dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}, tol 2px)`);
    assert(geom.painted === 1, "P1: the edited item still renders live through Skia (not suppressed)");
  }

  // ── P3 (while editing): ENTER = newline (no commit); typing appends
  await focusSink();
  await page.evaluate(() => window.__powerrp_textEdit.setSelection(11, 11)); // end of "Hello World"
  await page.keyboard.press("Enter");
  await page.keyboard.type("Line2");
  await sleep(150);
  assert(await isEditing(), "P3: ENTER does NOT commit/exit (still editing)");
  const previewText = await page.evaluate((id) => { const t = window.__powerrp_app.previewDelta?.items?.[id]?.text; return t ? (t.runs ?? []).map((r) => r.text ?? "").join("") : null; }, textId);
  assert(previewText && previewText.includes("\n") && previewText.includes("Line2"), `P3: ENTER inserts a newline; typing appends (preview=${JSON.stringify(previewText)})`);
  await page.evaluate(() => window.__powerrp_app.cancelTextEdit());
  await sleep(150);
  assert(!(await isEditing()), "P3: cancelTextEdit exits edit mode");
  assert((await storedRuns()).map((r) => r.text).join("") === "Hello World", "P3: cancel reverts (doc text unchanged)");

  // ── P2: rich per-character edit — bold+recolor+highlight the first word "Hello"
  const framesBefore = await frameCount();
  await page.mouse.click(c.x, c.y, { clickCount: 2 });
  await sleep(250);
  await page.evaluate(() => {
    window.__powerrp_textEdit.setSelection(0, 5); // "Hello"
    window.__powerrp_textEdit.applyStyle({ bold: true, color: "#ff0000", highlight: "#ffff00" });
  });
  await sleep(150);
  await focusSink();
  await page.keyboard.press("Escape"); // commit
  await sleep(200);
  assert(!(await isEditing()), "P2: Esc commits + exits");
  const runsAfter = await storedRuns();
  assert(runsAfter.length >= 2, `P2: runs SPLIT at the selection (got ${runsAfter.length})`);
  const first = runsAfter[0];
  assert(first.text === "Hello" && first.bold === true && first.color === "#ff0000" && first.highlight === "#ffff00", `P2: first run bold+red+highlighted (got ${JSON.stringify(first)})`);
  assert(runsAfter.slice(1).map((r) => r.text).join("") === " World", "P2: the rest is unchanged ' World'");
  assert((await frameCount()) > framesBefore, "P2: the scene re-rendered after the style edit");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(150);
  const runsUndone = await storedRuns();
  assert(runsUndone.length === 1 && runsUndone[0].text === "Hello World" && !runsUndone[0].bold, `P2: ONE undo restores the original single run (got ${JSON.stringify(runsUndone)})`);

  // ── P4: valign flows into caret geometry (caretScreen(0).y increases t→m→b)
  async function caretTopFor(valign) {
    await page.evaluate(({ id, valign }) => { const app = window.__powerrp_app; app.setPreview([[["items", id, "valign"], valign]]); app.commitPreview(); }, { id: textId, valign });
    await sleep(120);
    const c2 = await textCenterScreen();
    await page.mouse.click(c2.x, c2.y, { clickCount: 2 });
    await sleep(200);
    const y = await page.evaluate(() => window.__powerrp_textEdit.caretScreen(0)?.y ?? null);
    await page.evaluate(() => window.__powerrp_app.cancelTextEdit());
    await sleep(120);
    return y;
  }
  const yTop = await caretTopFor("top");
  const yMid = await caretTopFor("middle");
  const yBot = await caretTopFor("bottom");
  assert(yTop != null && yMid != null && yBot != null, "P4: caret geometry available for each valign");
  assert(yBot > yMid && yMid > yTop, `P4: caret top y increases top<middle<bottom (${yTop?.toFixed(1)} / ${yMid?.toFixed(1)} / ${yBot?.toFixed(1)}) — valignOffset reaches the editor`);
  await page.evaluate((id) => { const app = window.__powerrp_app; app.setPreview([[["items", id, "valign"], "top"]]); app.commitPreview(); }, textId);
  await sleep(120);

  // ── P5: toolbar ALIGN applies per-paragraph (applyPara); ONE undo restores
  const c3 = await textCenterScreen();
  await page.mouse.click(c3.x, c3.y, { clickCount: 2 });
  await sleep(200);
  await page.evaluate(() => {
    window.__powerrp_textEdit.setSelection(0, 11); // whole "Hello World"
    window.__powerrp_textEdit.applyPara({ align: "center" });
  });
  await sleep(150);
  await focusSink();
  await page.keyboard.press("Escape");
  await sleep(200);
  assert(!(await isEditing()), "P5: Esc commits after a paragraph-align edit");
  const parasAfter = await page.evaluate((id) => (window.__powerrp_app.doc.slides[0].delta.items[id].text?.paras ?? []).map((p) => ({ ...p })), textId);
  assert(parasAfter.length >= 1 && parasAfter.every((p) => p.align === "center"), `P5: every paragraph center-aligned after applyPara (got ${JSON.stringify(parasAfter)})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(150);
  const parasUndone = await page.evaluate((id) => (window.__powerrp_app.doc.slides[0].delta.items[id].text?.paras ?? []).map((p) => ({ ...p })), textId);
  assert(parasUndone.every((p) => p.align !== "center"), `P5: ONE undo restores the original paragraph align (got ${JSON.stringify(parasUndone)})`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error("WYSIWYG PROBE FAILURES:\n" + fails.join("\n")); process.exit(1); }
  console.log("  P1 in-place edit: dblclick enters, controller over the widget top-left (≤2px), sink present, item renders live.");
  console.log("  P2 rich edit: select 'Hello' → bold+red+highlight, runs SPLIT, pixels changed, ONE undo restores.");
  console.log("  P3 native feel: ENTER = newline (no commit), typing appends, cancel reverts.");
  console.log("  P4 valign: caret top y increases top<middle<bottom (valignOffset reaches the editor geometry).");
  console.log("  P5 paragraph align: applyPara centers every touched paragraph, ONE undo restores.");
  console.log("\nWYSIWYG rich-text editing probe passed.");
} finally {
  await browser.close();
  await server.close();
}
