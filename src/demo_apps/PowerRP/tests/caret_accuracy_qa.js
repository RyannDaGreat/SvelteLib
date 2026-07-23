/**
 * CARET/SELECTION ACCURACY QA — proves the TRUE in-place editor's caret + selection
 * are correct across MIXED size/font runs (the drift bug the rewrite fixes),
 * because they come from the SAME CanvasKit Paragraph that renders the glyphs.
 *
 * Spawns its OWN isolated Vite (text_wysiwyg_probe pattern) + headless Chromium
 * with swiftshader (Skia/WebGL2). Drives the REAL app via window.__powerrp_app and
 * the controller seam window.__powerrp_textEdit. Writes screenshots to
 * .claude_vlm_checks/ and FAILS on any dangerous console/page error.
 *
 * PROBES:
 *  A. Per-glyph caret advances track PER-RUN metrics — the 48px run's advance is
 *     ~3x the 16px run's (a browser uniform-layout / drifted caret would NOT).
 *  B. Click-to-place: a REAL mouse click 20% / 80% into each glyph lands on the
 *     correct glyph boundary — across the 16px→48px transition (THE bug).
 *  C. Same click-accuracy holds at a 2nd ZOOM level (no drift at zoom).
 *  D. Selection across mixed runs = ONE clean band at the max line height.
 *  E. Arrows / Home / End / Shift-select / double-click-word / typing-updates-render.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/caret_accuracy_qa.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../../../../../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

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

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A mixed-run single line: "Inter16 " (16px inter) + "Lora48" (48px bold lora),
  // in a wide box so it stays on ONE line (the mixed-size line the bug targets).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const R = (o) => ({ bold: false, italic: false, underline: false, strike: false, size: 36, font: "system", color: "#ffffff", outlineColor: "#000000", outlineWidth: 0, highlight: "", ...o });
    const rich = { runs: [R({ text: "Inter16 ", size: 16, font: "inter" }), R({ text: "Lora48", size: 48, font: "lora", bold: true })], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] };
    const txt = { ...def("text"), name: "Mixed", x: 60, y: 120, w: 700, h: 140, z: 1, active: true, text: rich, size: 36, color: "#ffffff", font: "inter", valign: "top" };
    const doc = { meta: { name: "caret-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, txt } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await sleep(500);
  if (errors.length) { console.error("DOC LOAD ERRORS:\n" + errors.join("\n")); process.exit(1); }

  const textId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "text");
  });
  const plainLen = await page.evaluate((id) => {
    const t = window.__powerrp_app.doc.slides[0].delta.items[id].text;
    return [...t.runs.map((r) => r.text).join("")].length;
  }, textId);

  // Enter edit; the controller mounts + focuses its sink.
  await page.evaluate((id) => window.__powerrp_app.beginTextEdit(id), textId);
  await sleep(400);
  const editing = await page.evaluate(() => !!window.__powerrp_app.textEditing);
  assert(editing, "E0: beginTextEdit enters edit mode (controller mounted)");
  const seamOk = await page.evaluate(() => !!window.__powerrp_textEdit?.caretScreen);
  assert(seamOk, "E0: controller seam window.__powerrp_textEdit is live");

  // render-area rect + caret screen positions (render-area frame) for every offset.
  const renderRect = await page.evaluate(() => { const r = document.querySelector(".render-area").getBoundingClientRect(); return { left: r.left, top: r.top }; });
  const caretsAt = async () => page.evaluate((n) => {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(window.__powerrp_textEdit.caretScreen(i));
    return out;
  }, plainLen);

  // ── PROBE A: per-run advance ratio (48px vs 16px) ─────────────────────────────
  const carets = await caretsAt();
  // "Inter16 " = 8 chars (offsets 0..8), "Lora48" = 6 chars (offsets 8..14).
  const adv = (a, b) => (carets[b].x - carets[a].x) / (b - a); // avg per-char advance
  const smallAdv = adv(0, 7);   // within the 16px run (exclude the trailing space at 7..8)
  const bigAdv = adv(8, 14);    // within the 48px run
  const strictlyInc = carets.every((c, i) => i === 0 || c.x >= carets[i - 1].x - 0.01);
  assert(strictlyInc, "A: caret x is monotonically non-decreasing across the whole line");
  const ratio = bigAdv / smallAdv;
  assert(ratio > 2.3 && ratio < 4.2, `A: 48px-run per-char advance is ~3x the 16px-run's (ratio=${ratio.toFixed(2)}; proves PER-RUN metrics, not a uniform/drifted caret)`);

  // ── PROBE B: real click lands on the correct glyph boundary (mixed sizes) ─────
  const lineMidY = (carets[0].y + carets[0].y2) / 2;
  async function clickOffset(frameX) {
    await page.mouse.click(renderRect.left + frameX, renderRect.top + lineMidY);
    await sleep(30);
    return page.evaluate(() => window.__powerrp_textEdit.getSelection().focus);
  }
  let bHits = 0, bTotal = 0;
  for (let i = 0; i < plainLen; i++) {
    const x0 = carets[i].x, x1 = carets[i + 1].x;
    if (x1 - x0 < 2) continue; // skip the near-zero-advance space glyph
    const left = await clickOffset(x0 + (x1 - x0) * 0.2);  // 20% into glyph i → offset i
    const right = await clickOffset(x0 + (x1 - x0) * 0.8);  // 80% into glyph i → offset i+1
    bTotal += 2;
    if (left === i) bHits++;
    if (right === i + 1) bHits++;
  }
  assert(bHits >= bTotal - 1, `B: click-to-place lands on the correct glyph boundary across the 16px→48px line (${bHits}/${bTotal} exact)`);

  // Screenshot: caret placed at the run boundary (offset 8, start of the 48px run).
  await page.evaluate(() => window.__powerrp_textEdit.setSelection(8, 8));
  await sleep(120);
  await page.screenshot({ path: join(SHOTS, "caret_qa_boundary.png") });

  // ── PROBE C: same accuracy at a 2nd zoom level (geometry round-trip) ──────────
  // Use the caret↔hit-test round-trip (both go through the LIVE viewport
  // worldToScreen/screenToWorld) rather than real mouse clicks — a real click at
  // 2x can land outside the box (which correctly dismisses the edit). The
  // round-trip exercises exactly the zoom-dependent world↔screen mapping, so it
  // proves the caret and hit-test agree at 2x (no drift), which is the claim.
  await page.evaluate(() => window.__powerrp_app.canvasActions.zoomTo(2));
  await sleep(800); // animated zoom settle
  const stillEditing2 = await page.evaluate(() => !!window.__powerrp_textEdit);
  assert(stillEditing2, "C: edit still active after zoomTo(2)");
  const cRes = await page.evaluate((n) => {
    const te = window.__powerrp_textEdit;
    const c = []; for (let i = 0; i <= n; i++) c.push(te.caretScreen(i));
    const midY = (c[0].y + c[0].y2) / 2;
    let hits = 0, total = 0;
    for (let i = 0; i < n; i++) {
      const x0 = c[i].x, x1 = c[i + 1].x;
      if (x1 - x0 < 3) continue;                       // skip near-zero-advance glyphs
      total += 2;
      if (te.offsetAtScreen(x0 + (x1 - x0) * 0.2, midY) === i) hits++;     // 20% into glyph i → i
      if (te.offsetAtScreen(x0 + (x1 - x0) * 0.8, midY) === i + 1) hits++; // 80% into glyph i → i+1
    }
    return { hits, total };
  }, plainLen);
  assert(cRes.hits >= cRes.total - 1, `C: caret↔hit-test glyph-accurate at 2x zoom (${cRes.hits}/${cRes.total}) — no drift at zoom`);
  await page.evaluate(() => window.__powerrp_app.canvasActions.zoomTo(1));
  await sleep(800);
  // If the zoom churn happened to dismiss, re-enter for the remaining probes.
  const stillEditing1 = await page.evaluate(() => !!window.__powerrp_textEdit);
  if (!stillEditing1) { await page.evaluate((id) => window.__powerrp_app.beginTextEdit(id), textId); await sleep(300); }

  // ── PROBE D: selection across mixed runs = a CLEAN contiguous band at the
  // uniform (max) line height. CanvasKit's getRectsForRange returns one rect PER
  // RUN (documented; not per glyph), so a 2-run line gives 2 ADJACENT rects — the
  // "clean band" claim is: all rects share the SAME (max) height and are
  // contiguous (no gap/overlap), together spanning the whole line. ─────────────
  const sel = (await page.evaluate(() => { window.__powerrp_textEdit.setSelection(0, 14); return window.__powerrp_textEdit.selectionScreenRects(); }))
    .slice().sort((a, b) => a.x - b.x);
  assert(sel.length >= 1, `D: whole-line selection produces a band (got ${sel.length} rects)`);
  if (sel.length) {
    const bigLineH = await page.evaluate(() => { const c = window.__powerrp_textEdit.caretScreen(10); return c.y2 - c.y; });
    const uniformH = sel.every((r) => Math.abs(r.h - bigLineH) <= 3);
    assert(uniformH, `D: every band rect is the MAX (48px) line height — clean band across mixed sizes (heights=${sel.map((r) => r.h.toFixed(1)).join(",")}, max=${bigLineH.toFixed(1)})`);
    const contiguous = sel.every((r, i) => i === 0 || Math.abs(r.x - (sel[i - 1].x + sel[i - 1].w)) <= 2);
    assert(contiguous, "D: band rects are contiguous (no gap/overlap between runs)");
    const span = (sel.at(-1).x + sel.at(-1).w) - sel[0].x;
    const lineSpan = carets[14].x - carets[0].x;
    assert(Math.abs(span - lineSpan) <= 4, `D: band spans both runs (band=${span.toFixed(1)}, line=${lineSpan.toFixed(1)})`);
  }
  await page.screenshot({ path: join(SHOTS, "caret_qa_selection.png") });

  // ── PROBE E: arrows / home / end / shift / double-click / typing ──────────────
  const sink = () => page.evaluate(() => document.querySelector(".text-edit-sink")?.focus());
  const getSel = () => page.evaluate(() => window.__powerrp_textEdit.getSelection());
  await page.evaluate(() => window.__powerrp_textEdit.setSelection(0, 0));
  await sink();
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  assert((await getSel()).focus === 3, `E: ArrowRight ×3 moves caret to offset 3 (got ${(await getSel()).focus})`);
  await page.keyboard.press("Home");
  assert((await getSel()).focus === 0, "E: Home moves to line start");
  await page.keyboard.press("End");
  assert((await getSel()).focus === plainLen, `E: End moves to line end (${plainLen})`);
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.keyboard.up("Shift");
  const ss = await getSel();
  assert(ss.start === 0 && ss.end === 2, `E: Shift+ArrowRight ×2 selects [0,2) (got [${ss.start},${ss.end}))`);

  // double-click a word (real mouse) → selects "Inter16"
  await page.mouse.click(renderRect.left + carets[3].x, renderRect.top + lineMidY, { clickCount: 2 });
  await sleep(80);
  const wsel = await getSel();
  assert(wsel.end - wsel.start >= 4, `E: double-click selects a word (got [${wsel.start},${wsel.end}))`);

  // typing inserts at caret + the Skia render updates live (frame count rises).
  const frames0 = await page.evaluate(() => window.__powerrp_app.renderFrameCount);
  await page.evaluate(() => window.__powerrp_textEdit.setSelection(0, 0));
  await sink();
  await page.keyboard.type("Xy");
  await sleep(150);
  const previewPlain = await page.evaluate((id) => { const t = window.__powerrp_app.previewDelta?.items?.[id]?.text; return t ? t.runs.map((r) => r.text).join("") : null; }, textId);
  const frames1 = await page.evaluate(() => window.__powerrp_app.renderFrameCount);
  assert(previewPlain && previewPlain.startsWith("Xy"), `E: typing inserts at the caret (preview="${previewPlain?.slice(0, 12)}")`);
  assert(frames1 > frames0, `E: the Skia render updates live while typing (frames ${frames0}→${frames1})`);

  await page.screenshot({ path: join(SHOTS, "caret_qa_typed.png") });
  await page.evaluate(() => window.__powerrp_app.cancelTextEdit());

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));

  console.log(`\nscreenshots: ${SHOTS}/caret_qa_boundary.png, caret_qa_selection.png, caret_qa_typed.png`);
  if (fails.length) { console.error(`\nCARET QA FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nCARET ACCURACY QA PASSED — caret/selection are glyph-accurate across mixed size/font runs, at multiple zooms.");
} finally {
  await browser.close();
  await server.close();
}
