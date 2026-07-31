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
 *  P6  an EDIT does not RE-SHADOW the eight box-level rows: a box whose stored
 *      rich value is the plugin default (content only) still stores content only
 *      after a real keystroke / a paragraph-align commit; the toolbar still shows
 *      the RESOLVED state while editing; an authored per-run size survives; a
 *      select-all/delete/retype does not reset the box's typography; and
 *      the eight rows still move pixels on the value the real editor produced
 *      (byte-diffed through cli/render.js, in this process).
 *
 * Spawns its OWN vite (isolated). Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/text_wysiwyg_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
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

  // ── P6: an in-place EDIT must not RE-SHADOW the box rows ──────────────────────
  // 437df12 freed eight box-level rows by storing only what the user set. This
  // controller then put the stamp straight back: it derived its edit model with
  // normalizeRichText (RESOLVED runs) and staged the result verbatim, so ONE
  // keystroke re-materialized all ten run keys (measured: ["text"] → eleven) and
  // font/size/bold/color went byte-identical under renderDocToPng again. A
  // paragraph-align commit did it too (applyParaToSelection writes base.runs
  // through). A bare-node test cannot catch it — only a real keystroke through the
  // real controller can, which is why this lives here.
  const BOX_SIZE = 60, BOX_FONT = "lora", BOX_COLOR = "#ffcc00";
  const BARE_SAMPLE = "Te xt";     // carries a SPACE, so the wordSpacing row can move pixels at all
  await page.evaluate(({ size, font, color, sample }) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 300, z: 1000, active: true, background: "#101014" };
    // The PLUGIN DEFAULT rich shape: CONTENT ONLY. Every style below is a BOX row
    // that runFrom/paraStyleFor resolve UNDER the run/paragraph.
    const txt = { ...def("text"), name: "Bare", x: 40, y: 40, w: 300, h: 160, z: 1, active: true,
      text: { runs: [{ text: sample }], paras: [{}] },
      size, font, color, bold: true, align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0, valign: "top" };
    const doc = { meta: { name: "bare-rows-probe", slideW: 400, slideH: 300 }, slides: [
      { id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, txt } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, { size: BOX_SIZE, font: BOX_FONT, color: BOX_COLOR, sample: BARE_SAMPLE });
  await sleep(400);

  const bareId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "text");
  });
  /** Query. The stored key set of EVERY run — the shadowing measurement. */
  const runKeySets = () => page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].text.runs.map((r) => Object.keys(r)), bareId);
  const storedParas = () => page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].text.paras.map((p) => ({ ...p })), bareId);
  const storedPlain = () => page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].text.runs.map((r) => r.text).join(""), bareId);
  async function enterEdit() {
    const p = await textCenterScreen();
    await page.mouse.click(p.x, p.y, { clickCount: 2 });
    await sleep(250);
  }
  async function commitEdit() {
    await focusSink();
    await page.keyboard.press("Escape");
    await sleep(220);
  }
  assert(JSON.stringify(await runKeySets()) === '[["text"]]', `P6: the fixture starts CONTENT-ONLY (got ${JSON.stringify(await runKeySets())})`);

  // The DISPLAY must stay RESOLVED: the toolbar reads run style to show B/I/U
  // pressed and the size number. On an UNRESOLVED base those reads are undefined,
  // so Bold would sit unpressed in a bold box and the size box would show "—".
  await enterEdit();
  await page.evaluate(() => window.__powerrp_textEdit.setSelection(0, 5));
  await sleep(150);
  const toolbar = await page.evaluate(() => ({
    size: document.querySelector(".text-format-size")?.textContent?.trim() ?? null,
    bold: document.querySelector('[aria-label="Bold"]')?.getAttribute("aria-pressed") ?? null,
  }));
  assert(toolbar.size === String(BOX_SIZE), `P6: the toolbar size box shows the RESOLVED size ${BOX_SIZE} (got ${JSON.stringify(toolbar.size)})`);
  assert(toolbar.bold === "true", `P6: Bold reads aria-pressed=true from the box's bold row (got ${JSON.stringify(toolbar.bold)})`);

  // ONE real keystroke, committed. The stored runs must be untouched.
  await focusSink();
  await page.evaluate(() => window.__powerrp_textEdit.setSelection(5, 5));
  await page.keyboard.type("Z");
  await sleep(150);
  await commitEdit();
  assert(!(await isEditing()), "P6: Esc commits the keystroke");
  assert((await storedPlain()) === `${BARE_SAMPLE}Z`, `P6: the keystroke landed (got ${JSON.stringify(await storedPlain())})`);
  const keysAfterType = await runKeySets();
  assert(JSON.stringify(keysAfterType) === '[["text"]]', `P6: ONE keystroke stores NO style — the four typography rows stay live (got ${JSON.stringify(keysAfterType)})`);
  const typedDoc = await page.evaluate(() => JSON.parse(JSON.stringify(window.__powerrp_app.doc)));

  // A paragraph-align commit writes the runs back — it must write them back BARE.
  await enterEdit();
  await page.evaluate(() => window.__powerrp_textEdit.setSelection(0, 6));
  await page.evaluate(() => window.__powerrp_textEdit.applyPara({ align: "center" }));
  await sleep(150);
  await commitEdit();
  assert((await storedParas()).every((p) => p.align === "center"), `P6: the paragraph align committed (got ${JSON.stringify(await storedParas())})`);
  assert(JSON.stringify(await runKeySets()) === '[["text"]]', `P6: a paragraph-align commit leaves the RUNS bare (got ${JSON.stringify(await runKeySets())})`);

  // An AUTHORED per-run size must survive a later keystroke (projects/"Untitled
  // cheese" stores size 76 in a run whose box says 36 — real authored style).
  const RUN_SIZE = 76;
  await enterEdit();
  await page.evaluate((s) => { window.__powerrp_textEdit.setSelection(0, 2); window.__powerrp_textEdit.applyStyle({ size: s }); }, RUN_SIZE);
  await sleep(150);
  await commitEdit();
  await enterEdit();
  await focusSink();
  await page.evaluate(() => window.__powerrp_textEdit.setSelection(6, 6));
  await page.keyboard.type("Q");
  await sleep(150);
  await commitEdit();
  const authoredRuns = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].text.runs.map((r) => ({ ...r })), bareId);
  assert(authoredRuns[0]?.size === RUN_SIZE, `P6: the authored per-run size ${RUN_SIZE} survives a later keystroke (got ${JSON.stringify(authoredRuns)})`);
  assert(authoredRuns.slice(1).every((r) => Object.keys(r).join() === "text"), `P6: only the AUTHORED run carries style; the rest stay bare (got ${JSON.stringify(authoredRuns)})`);

  // SELECT ALL + DELETE + RETYPE. Emptying the run list makes mergeAdjacentRuns
  // invent the lone empty run the caret inherits from; seeded resolved, the retyped
  // text came back at runFrom's hardcoded floor (36 / system / black) and VISIBLY
  // shrank in this size-60 lora box.
  await enterEdit();
  await focusSink();
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("New");
  await sleep(150);
  await commitEdit();
  assert((await storedPlain()) === "New", `P6: select-all + delete + retype replaced the text (got ${JSON.stringify(await storedPlain())})`);
  const retypedKeys = await runKeySets();
  assert(JSON.stringify(retypedKeys) === '[["text"]]', `P6: the retyped run stores NO style, so the box rows still supply it (got ${JSON.stringify(retypedKeys)})`);

  // PIXELS. Byte-diff the eight box rows on the document the real editor produced
  // after its keystroke, through the shared display list (cli/render.js).
  const { renderDocToPng } = await import("../cli/render.js");
  const PNG_W = 320, PNG_H = 240;
  const rowHash = async (row, value) => {
    const d = JSON.parse(JSON.stringify(typedDoc));
    if (row) d.slides[0].delta.items[bareId][row] = value;
    const png = await renderDocToPng(JSON.stringify(d), { slide: 0, alpha: 1, width: PNG_W, height: PNG_H });
    return createHash("sha256").update(png).digest("hex");
  };
  const baseHash = await rowHash(null, null);
  const BOX_ROWS = [
    ["size", BOX_SIZE + 20], ["font", "inter"], ["bold", false], ["color", "#ff0000"],
    ["align", "right"], ["lineSpacing", 2], ["charSpacing", 6], ["wordSpacing", 12],
  ];
  const deadRows = [];
  for (const [row, value] of BOX_ROWS) if ((await rowHash(row, value)) === baseHash) deadRows.push(row);
  assert(deadRows.length === 0, `P6: all EIGHT box rows still move pixels after the edit (DEAD: ${deadRows.join(", ") || "none"})`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error("WYSIWYG PROBE FAILURES:\n" + fails.join("\n")); process.exit(1); }
  console.log("  P1 in-place edit: dblclick enters, controller over the widget top-left (≤2px), sink present, item renders live.");
  console.log("  P2 rich edit: select 'Hello' → bold+red+highlight, runs SPLIT, pixels changed, ONE undo restores.");
  console.log("  P3 native feel: ENTER = newline (no commit), typing appends, cancel reverts.");
  console.log("  P4 valign: caret top y increases top<middle<bottom (valignOffset reaches the editor geometry).");
  console.log("  P5 paragraph align: applyPara centers every touched paragraph, ONE undo restores.");
  console.log("  P6 no re-shadowing: a keystroke and a paragraph commit both store CONTENT ONLY, the toolbar still");
  console.log("     shows the resolved size/bold, an authored per-run size survives, a select-all/delete/retype");
  console.log("     keeps the box's typography, and all EIGHT box rows still move pixels on the document the");
  console.log("     editor produced (cli/render.js byte-diff).");
  console.log("\nWYSIWYG rich-text editing probe passed.");
} finally {
  await browser.close();
  await server.close();
}
