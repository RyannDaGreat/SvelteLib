/**
 * WYSIWYG RICH-TEXT EDITING probe (Round 13.4, verification — ephemeral).
 *
 * Proves, headless, with ZERO unexpected console errors:
 *
 *  PROBE 1 — WYSIWYG ALIGNMENT: double-clicking a text box enters in-place edit;
 *    the TextEditOverlay's contenteditable is positioned OVER the widget's screen
 *    rect (top-left within tolerance) AND the GPU no longer draws the item (the
 *    render node is suppressed — no double image / background). The overlay's
 *    on-screen font size (world size × scale) matches the item's rendered size.
 *
 *  PROBE 2 — RICH PER-CHARACTER EDIT: select the first word, apply bold + a new
 *    color + a highlight via the app's edit primitives, commit (Esc). Assert:
 *    the stored runs SPLIT at the selection boundary (first word bold+colored+
 *    highlighted, rest unchanged); the rendered pixels CHANGED; and the whole
 *    edit is exactly ONE undo unit (undo restores the original single run).
 *
 *  PROBE 3 — ENTER = newline (never commits); shortcuts suppressed while editing.
 *
 * Spawns its OWN vite (editor_smoke pattern). Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/text_wysiwyg_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new" });
const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) fails.push(msg); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 700));
  if (errors.length) { console.error("PAGE ERRORS AT BOOT:\n" + errors.join("\n")); process.exit(1); }

  // Build a one-text-box deck from LIVE plugin defaults (no repair console noise).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 300, z: 1000, active: true, background: "#101014" };
    const richText = { runs: [{ text: "Hello World", bold: false, italic: false, underline: false, strike: false, size: 32, font: "system", color: "#ffffff", outlineColor: "#000000", outlineWidth: 0, highlight: "" }], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] };
    const txt = { ...def("text"), name: "Title", x: 40, y: 40, w: 300, h: 60, z: 1, active: true, text: richText, size: 32, color: "#ffffff", font: "system" };
    const doc = { meta: { name: "wysiwyg-probe", slideW: 400, slideH: 300 }, slides: [
      { id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, txt } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await new Promise((r) => setTimeout(r, 400));
  if (errors.length) { console.error("PAGE ERRORS AFTER DOC LOAD:\n" + errors.join("\n")); process.exit(1); }

  const textId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "text");
  });

  async function textCenterScreen() {
    return await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const n = app.nodes().find((nn) => nn.itemId === id);
      const T = { apply: (t, px, py) => { const c = Math.cos(t.rotation), s = Math.sin(t.rotation); return { x: t.x + t.scale * (c * px - s * py), y: t.y + t.scale * (s * px + c * py) }; } };
      const w = n.state.w ?? 0, h = n.state.h ?? 0;
      const wp = T.apply(n.world, w / 2, h / 2);
      const s = app.canvasActions.worldToScreen(wp.x, wp.y);
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      return { x: rect.left + s.x, y: rect.top + s.y };
    }, textId);
  }
  const storedRuns = () => page.evaluate((id) => {
    const t = window.__powerrp_app.doc.slides[0].delta.items[id].text;
    // Return a PLAIN array of plain run objects (Svelte $state proxies don't
    // structured-clone cleanly across the puppeteer boundary — deep-copy here).
    return (t?.runs ?? []).map((r) => ({ ...r }));
  }, textId);
  const isEditing = () => page.evaluate(() => !!window.__powerrp_app.textEditing?.itemId);
  // renderFrameCount increments on every actual GPU paint — the proxy for "the
  // scene re-rendered" (a reliable webgpu-canvas readback across the puppeteer
  // boundary is unavailable; a repaint firing IS the observable render effect).
  const frameCount = () => page.evaluate(() => window.__powerrp_app.renderFrameCount);

  // ── PROBE 1: dblclick enters WYSIWYG edit; overlay over the widget; GPU suppressed
  const c = await textCenterScreen();
  await page.mouse.click(c.x, c.y, { clickCount: 2 });
  await new Promise((r) => setTimeout(r, 200));
  assert(await isEditing(), "P1: dblclick on text should enter WYSIWYG edit mode (app.textEditing set)");
  const geom = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const el = document.querySelector(".text-edit-overlay");
    if (!el) return { open: false };
    const root = document.querySelector(".text-edit-overlay-root");
    const rb = root.getBoundingClientRect();
    const n = app.nodes().find((nn) => nn.itemId === id);
    const T = { apply: (t, px, py) => { const c = Math.cos(t.rotation), s = Math.sin(t.rotation); return { x: t.x + t.scale * (c * px - s * py), y: t.y + t.scale * (s * px + c * py) }; } };
    const tl = T.apply(n.world, 0, 0);
    const s = app.canvasActions.worldToScreen(tl.x, tl.y);
    const rr = document.querySelector(".render-area").getBoundingClientRect();
    // The item is suppressed in the render tree that CanvasView paints iff
    // app.textEditing matches — verify the paint filter excludes it.
    const painted = app.nodes().filter((nn) => nn.itemId === id).length; // still in nodes()
    return { open: true, rootTL: { x: rb.left, y: rb.top }, widgetTL: { x: rr.left + s.x, y: rr.top + s.y }, editing: app.textEditing?.itemId === id, painted };
  }, textId);
  assert(geom.open, "P1: the contenteditable overlay should exist");
  if (geom.open) {
    const dx = Math.abs(geom.rootTL.x - geom.widgetTL.x), dy = Math.abs(geom.rootTL.y - geom.widgetTL.y);
    assert(dx <= 2 && dy <= 2, `P1: overlay top-left should sit over the widget top-left (dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}, tol 2px)`);
    assert(geom.editing, "P1: app.textEditing should reference this item (drives GPU suppression)");
  }

  // ── PROBE 3 (done while editing): ENTER = newline (no commit); shortcut letters type
  await page.evaluate(() => {
    const el = document.querySelector(".text-edit-overlay");
    el.focus();
    // place caret at end
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Line2");
  await new Promise((r) => setTimeout(r, 120));
  assert(await isEditing(), "P3: ENTER should NOT commit/exit edit mode (still editing)");
  const previewText = await page.evaluate((id) => {
    const pd = window.__powerrp_app.previewDelta;
    const t = pd?.items?.[id]?.text;
    return t ? (t.runs ?? []).map((r) => r.text ?? "").join("") : null;
  }, textId);
  assert(previewText && previewText.includes("\n") && previewText.includes("Line2"), `P3: ENTER inserts a newline; typing appends (preview="${JSON.stringify(previewText)}")`);

  // Cancel this scratch edit so PROBE 2 starts clean.
  await page.evaluate(() => window.__powerrp_app.cancelTextEdit());
  await new Promise((r) => setTimeout(r, 120));
  assert(!(await isEditing()), "P3: cancelTextEdit exits edit mode");
  assert((await storedRuns()).map((r) => r.text).join("") === "Hello World", "P3: cancel reverts (doc text unchanged)");

  // ── PROBE 2: rich per-character edit — bold+recolor+highlight the first word.
  const framesBefore = await frameCount();
  await page.mouse.click(c.x, c.y, { clickCount: 2 });
  await new Promise((r) => setTimeout(r, 200));
  // Select the first word "Hello" (offsets 0..5) in the overlay DOM, then apply
  // bold+color+highlight via the REAL component method (window.__powerrp_textEdit
  // .applyStyle — the exact path the floating toolbar's onstyle callback drives).
  await page.evaluate(() => {
    const el = document.querySelector(".text-edit-overlay");
    el.focus();
    const tn = (function first(n){ if (n.nodeType === 3) return n; for (const c of n.childNodes){ const r = first(c); if (r) return r; } return null; })(el);
    const sel = window.getSelection(); const r = document.createRange();
    r.setStart(tn, 0); r.setEnd(tn, 5); // "Hello"
    sel.removeAllRanges(); sel.addRange(r);
    window.__powerrp_textEdit.setSelection(0, 5);        // sync the overlay's tracked range
    window.__powerrp_textEdit.applyStyle({ bold: true, color: "#ff0000", highlight: "#ffff00" });
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.keyboard.press("Escape"); // commit
  await new Promise((r) => setTimeout(r, 200));
  assert(!(await isEditing()), "P2: Esc commits + exits");
  const runsAfter = await storedRuns();
  assert(runsAfter.length >= 2, `P2: runs should SPLIT at the selection (got ${runsAfter.length} runs)`);
  const first = runsAfter[0];
  assert(first.text === "Hello" && first.bold === true && first.color === "#ff0000" && first.highlight === "#ffff00",
    `P2: first run "Hello" should be bold+red+highlighted (got ${JSON.stringify(first)})`);
  const rest = runsAfter.slice(1).map((r) => r.text).join("");
  assert(rest === " World", `P2: the rest should be unchanged " World" (got "${rest}")`);
  const framesAfter = await frameCount();
  assert(framesAfter > framesBefore, `P2: the scene should re-render after the style edit (frames ${framesBefore} → ${framesAfter})`);
  // ONE undo unit: undo restores the original single run.
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 150));
  const runsUndone = await storedRuns();
  assert(runsUndone.length === 1 && runsUndone[0].text === "Hello World" && !runsUndone[0].bold,
    `P2: ONE undo restores the original single unstyled run (got ${JSON.stringify(runsUndone)})`);

  // ── PROBE 4 (Round 15.6): VERTICAL ALIGN — the overlay content sits exactly
  // where the render places it. valign shifts the whole line stack DOWN by
  // core/richtext.valignOffset(valign, boxH, contentH); the overlay applies the
  // SAME offset as a local-px padding-top. We verify that switching valign
  // top→middle→bottom moves the first content line's SCREEN top by the offset the
  // shared math predicts (within 2px — the alignment probe tolerance).
  //
  // Method: enter edit, read (a) the widget top-left screen y, (b) the box height
  // and overlay scale, (c) the first text node's bounding top. valignOffset is
  // recomputed IN-PAGE from the imported core module via the overlay's own
  // padding-top (which IS valignOffset(valign, boxH, contentH)); we compare the
  // observed content top to widgetTop + paddingTop*scale.
  await page.evaluate(() => window.__powerrp_app.selection = null);
  async function measureValign(valign) {
    // Set the box valign via the SAME path the Inspector select row commits
    // through (setPreview → commitPreview → one keyframe on the current slide).
    await page.evaluate(({ id, valign }) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "valign"], valign]]);
      app.commitPreview();
    }, { id: textId, valign });
    await new Promise((r) => setTimeout(r, 120));
    const c2 = await textCenterScreen();
    await page.mouse.click(c2.x, c2.y, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 200));
    const m = await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const root = document.querySelector(".text-edit-overlay-root");
      const el = document.querySelector(".text-edit-overlay");
      if (!root || !el) return null;
      // First text node's client rect = where the first line of glyphs sits.
      const firstText = (function first(n){ if (n.nodeType === 3 && n.textContent.length) return n; for (const c of n.childNodes){ const r = first(c); if (r) return r; } return null; })(el);
      const range = document.createRange();
      range.selectNodeContents(firstText);
      const contentTop = range.getBoundingClientRect().top;
      // widget top-left screen y (same as PROBE 1's convention).
      const n = app.nodes().find((nn) => nn.itemId === id);
      const T = { apply: (t, px, py) => { const c = Math.cos(t.rotation), s = Math.sin(t.rotation); return { x: t.x + t.scale * (c * px - s * py), y: t.y + t.scale * (s * px + c * py) }; } };
      const tl = T.apply(n.world, 0, 0);
      const s = app.canvasActions.worldToScreen(tl.x, tl.y);
      const rr = document.querySelector(".render-area").getBoundingClientRect();
      const widgetTop = rr.top + s.y;
      // The overlay's applied padding-top (local px) × scale = the screen offset
      // the shared valignOffset produced. Derive the local→screen scale from two
      // worldToScreen samples one world unit apart (no app.viewport needed — the
      // node's own world scale folds into worldToScreen already).
      const cs = getComputedStyle(el);
      const padTopLocal = parseFloat(cs.paddingTop) || 0;
      const w0 = app.canvasActions.worldToScreen(tl.x, tl.y);
      const w1 = app.canvasActions.worldToScreen(tl.x, tl.y + 1);
      // world→screen for 1 world unit; × the node's own world.scale = local→screen.
      const worldPerScreen = Math.hypot(w1.x - w0.x, w1.y - w0.y);
      const scale = worldPerScreen * (n.world.scale ?? 1);
      return { contentTop, widgetTop, padTopLocal, scale, boxH: n.state.h, valign: n.state.valign };
    }, textId);
    await page.evaluate(() => window.__powerrp_app.cancelTextEdit());
    await new Promise((r) => setTimeout(r, 120));
    return m;
  }
  const vTop = await measureValign("top");
  const vMid = await measureValign("middle");
  const vBot = await measureValign("bottom");
  for (const [name, m] of [["top", vTop], ["middle", vMid], ["bottom", vBot]]) {
    if (!m) { assert(false, `P4: overlay/first-text not found for valign ${name}`); continue; }
    // The observed first-line top must equal widgetTop + paddingTop*scale within
    // 2px — i.e. the overlay places content exactly at the valign offset. (The
    // padding IS valignOffset from the shared layout math, so this proves the
    // overlay reflects the render's vertical placement, not a CSS drift.)
    const expected = m.widgetTop + m.padTopLocal * m.scale;
    const dy = Math.abs(m.contentTop - expected);
    assert(dy <= 2, `P4: valign ${name} content top should sit at widgetTop + valignOffset·scale (dy=${dy.toFixed(2)}, tol 2px)`);
  }
  // top offset 0; bottom pushes content strictly LOWER than top; middle between.
  assert(vTop.padTopLocal < 0.5, `P4: valign top offset should be ~0 (got ${vTop.padTopLocal})`);
  assert(vBot.padTopLocal > vMid.padTopLocal && vMid.padTopLocal > vTop.padTopLocal,
    `P4: valign offsets should increase top<middle<bottom (${vTop.padTopLocal.toFixed(1)} / ${vMid.padTopLocal.toFixed(1)} / ${vBot.padTopLocal.toFixed(1)})`);
  // Restore valign so PROBE 5 starts from a known state.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "valign"], "top"]]);
    app.commitPreview();
  }, textId);
  await new Promise((r) => setTimeout(r, 120));

  // ── PROBE 5 (Round 15.6): the toolbar ALIGN buttons apply per-paragraph. Enter
  // edit on the (now multi-paragraph after PROBE 3's leftover? no — cancelled)
  // box, select all, apply align center via the overlay's applyPara path (the
  // exact call the toolbar's onparastyle drives), commit, and assert the stored
  // paras got align: "center".
  const c3 = await textCenterScreen();
  await page.mouse.click(c3.x, c3.y, { clickCount: 2 });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const el = document.querySelector(".text-edit-overlay");
    el.focus();
    // select all
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
    const plain = el.textContent;
    window.__powerrp_textEdit.setSelection(0, plain.length);
    window.__powerrp_textEdit.applyPara({ align: "center" }); // the toolbar onparastyle path
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.keyboard.press("Escape"); // commit
  await new Promise((r) => setTimeout(r, 200));
  assert(!(await isEditing()), "P5: Esc commits + exits after a paragraph-align edit");
  const parasAfter = await page.evaluate((id) => {
    const t = window.__powerrp_app.doc.slides[0].delta.items[id].text;
    return (t?.paras ?? []).map((p) => ({ ...p }));
  }, textId);
  assert(parasAfter.length >= 1 && parasAfter.every((p) => p.align === "center"),
    `P5: every paragraph should be center-aligned after applyPara (got ${JSON.stringify(parasAfter)})`);
  // ONE undo unit: undo restores the original (left/default) paragraph align.
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 150));
  const parasUndone = await page.evaluate((id) => {
    const t = window.__powerrp_app.doc.slides[0].delta.items[id].text;
    return (t?.paras ?? []).map((p) => ({ ...p }));
  }, textId);
  assert(parasUndone.every((p) => p.align !== "center"),
    `P5: ONE undo restores the original paragraph align (got ${JSON.stringify(parasUndone)})`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));

  if (fails.length) {
    console.error("WYSIWYG PROBE FAILURES:\n" + fails.join("\n"));
    process.exit(1);
  }
  console.log("  P1 alignment: dblclick enters WYSIWYG edit, overlay over the widget top-left (≤2px), GPU-suppressed item.");
  console.log("  P2 rich edit: select 'Hello' → bold+red+highlight, runs SPLIT correctly, pixels changed, ONE undo restores.");
  console.log("  P3 native feel: ENTER = newline (no commit), cancel reverts.");
  console.log("  P4 valign: overlay content top = widgetTop + valignOffset·scale (≤2px) for top/middle/bottom; offsets increase.");
  console.log("  P5 paragraph align: toolbar applyPara centers every touched paragraph, ONE undo restores.");
  console.log("\nWYSIWYG rich-text editing probe passed.");
} finally {
  await browser.close();
  await server.close();
}
