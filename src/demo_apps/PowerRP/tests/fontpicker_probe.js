/**
 * FONTPICKER PROBE — verification tooling for the residual FontPicker fixes.
 * Self-spins Vite + headless Chromium, boots the editor, drops a text item,
 * enters in-place text edit (which mounts the floating TextFormatToolbar and its
 * FontPicker), opens the picker, then:
 *   (0) MEASURES the two popover columns (.fp-list, .fp-preview) + .fp-pop so the
 *       separator ("does it reach the bottom?") is diagnosed by numbers, not eyes.
 *   (1) WHEEL over the list must NOT pan the canvas (viewport.panX/Y unchanged).
 *   (2) The option list must be scrollable AND show an always-on scrollbar gutter.
 *   (3) The divider must span the FULL popover height (list bottom == preview
 *       bottom == pop bottom) in every state (few + many results, empty search).
 *   (4) The pangram lines must not be clipped (each line's bottom <= pop bottom).
 *   (5) The divider must DRAG (pointerdown+move on .fp-divider changes list width).
 * Screenshots each state into .claude_vlm_checks/ for a VLM look.
 *
 * Frontend-only Vite (backend-absent 404s ignored), swiftshader GL.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

// The alphabetic pangram a NORMAL font previews (must equal FontPicker.svelte's).
const PANGRAM = "The quick brown fox jumps over the lazy dog";
// seg7's descriptor `sample` — the segmented clock/calculator readout the picker
// previews for it (must equal render_gpu/fonts.js FONTS.seg7.sample).
const SEG7_SAMPLE = "12:34 0.0";

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
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|crypto\.randomUUID|Credentials API|preserveAspect/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A 1-slide doc: camera + a text item. Then enter in-place text edit → the
  // floating TextFormatToolbar (with the FontPicker) mounts over the canvas.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    // Left-of-center so the toolbar + popover land in open canvas, clear of the
    // right-hand Inspector panel (a clean, un-occluded screenshot for the VLM).
    const text = { ...def("text"), name: "Title", x: 60, y: 120, w: 480, h: 160, z: 1, active: true };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "fontpicker-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: tr, delta: { items: { cam, text } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    const tid = Object.keys(app.doc.slides[0].delta.items).find((id) => app.doc.slides[0].delta.items[id].type === "text");
    app.beginTextEdit(tid);
    window.__tid = tid;
  });
  await sleep(600);

  // Open the FontPicker.
  const opened = await page.evaluate(() => {
    const trigger = document.querySelector(".fp-trigger");
    if (!trigger) return false;
    trigger.click();
    return true;
  });
  assert(opened, "FontPicker trigger present + clicked (toolbar mounted)");
  await sleep(300);

  // (0/3/4) Measure the popover geometry: pop, list column, preview column,
  // the divider element (if present), the scrollable menu, and every pangram line.
  const measure = () => page.evaluate(() => {
    const r = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
    const pop = r(".fp-pop"), list = r(".fp-list"), preview = r(".fp-preview"), divider = r(".fp-divider"), menu = r(".fp-menu");
    const lineEls = [...document.querySelectorAll(".fp-preview-line")];
    const lines = lineEls.map((el) => el.getBoundingClientRect().bottom);
    const lineRights = lineEls.map((el) => el.getBoundingClientRect().right);
    const previewEl = document.querySelector(".fp-preview");
    // Horizontal containment: scrollWidth > clientWidth ⟺ content overflows the box.
    const previewOverflowX = previewEl ? previewEl.scrollWidth - previewEl.clientWidth : null;
    const menuEl = document.querySelector(".fp-menu");
    const scroll = menuEl ? {
      scrollHeight: menuEl.scrollHeight, clientHeight: menuEl.clientHeight, canScroll: menuEl.scrollHeight > menuEl.clientHeight,
      // offsetWidth − clientWidth = the space a CLASSIC (always-on) scrollbar occupies.
      gutter: menuEl.offsetWidth - menuEl.clientWidth,
    } : null;
    const b = (x) => x ? { top: Math.round(x.top), bottom: Math.round(x.bottom), height: Math.round(x.height), left: Math.round(x.left), right: Math.round(x.right), width: Math.round(x.width) } : null;
    return { pop: b(pop), list: b(list), preview: b(preview), divider: b(divider), menu: b(menu), lineBottoms: lines.map(Math.round), lineRights: lineRights.map(Math.round), previewOverflowX, scroll };
  });

  const m0 = await measure();
  console.log("MEASURE (many results / no search):", JSON.stringify(m0, null, 2));
  await page.screenshot({ path: resolve(SHOTS, "fontpicker_1_open.png") });
  // Tight, un-occluded shot of JUST the popover for the VLM look.
  const popHandle = await page.$(".fp-pop");
  if (popHandle) await popHandle.screenshot({ path: resolve(SHOTS, "fontpicker_1_popover.png") });

  if (m0.pop && m0.list && m0.preview) {
    // Divider spans full height ⟺ list bottom == preview bottom == pop bottom (±1px subpixel).
    const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
    assert(near(m0.list.bottom, m0.pop.bottom), `list column reaches pop bottom (list=${m0.list.bottom} pop=${m0.pop.bottom})`);
    assert(near(m0.preview.bottom, m0.pop.bottom), `preview column reaches pop bottom (preview=${m0.preview.bottom} pop=${m0.pop.bottom})`);
    assert(near(m0.list.bottom, m0.preview.bottom), `columns are equal height — divider full (Δ=${Math.abs(m0.list.bottom - m0.preview.bottom)}px)`);
    if (m0.divider) assert(near(m0.divider.bottom, m0.pop.bottom) && near(m0.divider.top, m0.pop.top), `.fp-divider spans full pop height (top=${m0.divider.top}/${m0.pop.top} bottom=${m0.divider.bottom}/${m0.pop.bottom})`);
    // Pangram CONTAINED: not clipped below pop, AND no horizontal overflow past
    // the preview box (each line's right edge within the box; scrollWidth==clientWidth).
    const clipped = m0.lineBottoms.filter((lb) => lb > m0.pop.bottom + 1);
    assert(clipped.length === 0, `no pangram line clipped below pop (over-bottom lines: ${clipped.length}; lineBottoms=${m0.lineBottoms.join(",")} popBottom=${m0.pop.bottom})`);
    const overRight = m0.lineRights.filter((lr) => lr > m0.preview.right + 1);
    assert(overRight.length === 0, `no pangram line overflows the preview's RIGHT edge (over-right lines: ${overRight.length}; lineRights=${m0.lineRights.join(",")} previewRight=${m0.preview.right})`);
    assert(m0.previewOverflowX != null && m0.previewOverflowX <= 1, `preview has NO horizontal overflow (scrollWidth−clientWidth=${m0.previewOverflowX}px)`);
    // List actually scrolls (many fonts).
    if (m0.scroll) assert(m0.scroll.canScroll, `option list is scrollable (scrollH=${m0.scroll.scrollHeight} > clientH=${m0.scroll.clientHeight})`);
  }

  // (2) The CUSTOM always-visible scrollbar (track + thumb) is painted (native
  // overlay bars auto-hide — this one must be there at rest, in the screenshot).
  const sb = await page.evaluate(() => {
    const track = document.querySelector(".fp-scrolltrack"), thumb = document.querySelector(".fp-scrollthumb");
    if (!track || !thumb) return { present: false };
    const t = track.getBoundingClientRect(), h = thumb.getBoundingClientRect();
    return { present: true, trackW: Math.round(t.width), thumbH: Math.round(h.height), trackTop: Math.round(t.top), trackBottom: Math.round(t.bottom), thumbTop: Math.round(h.top), thumbBottom: Math.round(h.bottom) };
  });
  assert(sb.present, "custom always-visible scrollbar (track + thumb) is present at rest");
  if (sb.present) {
    assert(sb.trackW >= 8, `scrollbar track has a visible width (${sb.trackW}px)`);
    assert(sb.thumbH > 8, `scrollbar thumb has a visible height (${sb.thumbH}px)`);
    assert(sb.thumbTop >= sb.trackTop - 1 && sb.thumbBottom <= sb.trackBottom + 1, `thumb sits within the track (thumb ${sb.thumbTop}-${sb.thumbBottom}, track ${sb.trackTop}-${sb.trackBottom})`);
  }

  // (1) WHEEL over the list must NOT pan the canvas. Capture viewport, dispatch a
  // real wheel over the menu, and re-read. PanZoom pans on bubbled wheel; the fix
  // must stopPropagation so panX/panY are unchanged.
  // Use a TRUSTED wheel (page.mouse.wheel) — a synthetic WheelEvent won't cause
  // native list scrolling. Normalize the viewport read (defaults to 0/1) so the
  // compare is robust even before PanZoom first emits.
  const readVp = () => page.evaluate(() => { const v = window.__powerrp_app.lastViewport || {}; return { zoom: v.zoom ?? 1, panX: v.panX ?? 0, panY: v.panY ?? 0 }; });
  const menuCenter = await page.evaluate(() => { const r = document.querySelector(".fp-menu").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
  await page.evaluate(() => { document.querySelector(".fp-menu").scrollTop = 0; });
  const vpBefore = await readVp();
  await page.mouse.move(menuCenter.x, menuCenter.y);
  await page.mouse.wheel({ deltaY: 240 });
  await sleep(200);
  const vpAfter = await readVp();
  assert(vpBefore.panX === vpAfter.panX && vpBefore.panY === vpAfter.panY && vpBefore.zoom === vpAfter.zoom,
    `wheel over list did NOT pan/zoom canvas (before=${JSON.stringify(vpBefore)} after=${JSON.stringify(vpAfter)})`);
  const menuScrolled = await page.evaluate(() => document.querySelector(".fp-menu").scrollTop);
  assert(menuScrolled > 0, `wheel scrolled the LIST itself (scrollTop=${menuScrolled})`);

  // (3b) FEW results state: type a narrow query so only 1-2 items remain, then
  // re-measure — the divider must STILL be full height.
  await page.evaluate(() => {
    const s = document.querySelector(".fp-search");
    s.focus(); s.value = "system"; s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(250);
  const mFew = await measure();
  console.log("MEASURE (few results / query=system):", JSON.stringify(mFew, null, 2));
  await page.screenshot({ path: resolve(SHOTS, "fontpicker_2_fewresults.png") });
  if (mFew.pop && mFew.list && mFew.preview) {
    const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
    assert(near(mFew.list.bottom, mFew.preview.bottom), `few-results: columns still equal height — divider full (Δ=${Math.abs(mFew.list.bottom - mFew.preview.bottom)}px)`);
    const clipped = mFew.lineBottoms.filter((lb) => lb > mFew.pop.bottom + 1);
    assert(clipped.length === 0, `few-results: pangram not clipped (over-bottom lines: ${clipped.length})`);
  }

  // (5) DRAG the divider: pointerdown on .fp-divider, move left by DX, pointerup.
  // The list column width must change (persisted within the session).
  await page.evaluate(() => {
    const s = document.querySelector(".fp-search");
    s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  // The width change is a Svelte $state update → the DOM reflects it on the NEXT
  // tick, so dispatch the drag, then re-measure AFTER a flush (separate evaluate).
  const w0 = await page.evaluate(() => {
    const div = document.querySelector(".fp-divider");
    if (!div) return null;
    const list = document.querySelector(".fp-list");
    const w = Math.round(list.getBoundingClientRect().width);
    const dr = div.getBoundingClientRect();
    const cx = dr.left + dr.width / 2, cy = dr.top + dr.height / 2;
    const DX = 90; // drag right → list gets wider
    div.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientX: cx + DX, clientY: cy, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: cx + DX, clientY: cy, pointerId: 1 }));
    return w;
  });
  await sleep(200);
  const w1 = await page.evaluate(() => document.querySelector(".fp-list") ? Math.round(document.querySelector(".fp-list").getBoundingClientRect().width) : null);
  console.log("DRAG:", JSON.stringify({ w0, w1, delta: w1 != null && w0 != null ? w1 - w0 : null }));
  assert(w0 != null, "a .fp-divider element exists (draggable separator)");
  if (w0 != null) assert(w1 - w0 > 20, `dragging divider resized the list column (w0=${w0} → w1=${w1}, Δ=${w1 - w0})`);
  const popHandle2 = await page.$(".fp-pop");
  if (popHandle2) await popHandle2.screenshot({ path: resolve(SHOTS, "fontpicker_3_afterdrag.png") });

  // (5b) PERSIST within the session: close + reopen the picker; the dragged width
  // must survive (module-scoped sessionListW).
  await page.evaluate(() => document.querySelector(".fp-trigger").click()); // close
  await sleep(150);
  await page.evaluate(() => document.querySelector(".fp-trigger").click()); // reopen
  await sleep(250);
  const wReopen = await page.evaluate(() => document.querySelector(".fp-list") ? Math.round(document.querySelector(".fp-list").getBoundingClientRect().width) : null);
  if (w0 != null) assert(wReopen != null && Math.abs(wReopen - w1) <= 2, `dragged split PERSISTS across close/reopen (reopen width=${wReopen}, was ${w1})`);

  // (6) SEG7 READABILITY + PREVIEW (the seven-segment fix). Filtering the search
  // to a query focuses the single matching font (activeIndex clamps to 0), so its
  // row + the big preview are both live. We read the DOM TEXT (name is readable)
  // and the COMPUTED font-family (name in the UI font, sample/body in the face).
  const focusByQuery = async (q) => {
    await page.evaluate((query) => {
      const s = document.querySelector(".fp-search");
      s.focus(); s.value = query; s.dispatchEvent(new Event("input", { bubbles: true }));
    }, q);
    await sleep(250);
    return page.evaluate(() => {
      const face = (el) => (el ? getComputedStyle(el).fontFamily : null);
      const q1 = (sel) => document.querySelector(sel);
      const nameEl = q1(".fp-item-name"), sampleEl = q1(".fp-item-sample");
      const pName = q1(".fp-preview-name"), pSample = q1(".fp-preview-sample");
      const pLines = [...document.querySelectorAll(".fp-preview-line")];
      const txt = (el) => (el ? el.textContent.trim() : null);
      return {
        rowName: txt(nameEl), rowNameFace: face(nameEl),
        rowSample: txt(sampleEl), rowSampleFace: face(sampleEl),
        previewName: txt(pName), previewNameFace: face(pName),
        previewSample: txt(pSample),
        previewLines: pLines.map(txt), previewLineFace: face(pLines[0]),
      };
    });
  };

  // (a) The seg7 row: NAME readable (real "Seven Segment" text, drawn in the UI
  //     font — NOT the seg7 face), plus an in-face segmented-digit sample.
  const seg7 = await focusByQuery("seven");
  console.log("SEG7:", JSON.stringify(seg7, null, 2));
  const seg7Pop = await page.$(".fp-pop");
  if (seg7Pop) await seg7Pop.screenshot({ path: resolve(SHOTS, "fontpicker_4_seg7.png") });
  assert(seg7.rowName === "Seven Segment", `seg7 row NAME is readable text "Seven Segment" (got ${JSON.stringify(seg7.rowName)})`);
  assert(!!seg7.rowNameFace && !/Seven Segment/.test(seg7.rowNameFace), `seg7 row name drawn in the READABLE UI font, not the seg7 face (face=${seg7.rowNameFace})`);
  assert(seg7.rowSample === SEG7_SAMPLE, `seg7 row shows its in-face sample ${JSON.stringify(SEG7_SAMPLE)} (got ${JSON.stringify(seg7.rowSample)})`);
  assert(/Seven Segment/.test(seg7.rowSampleFace || ""), `seg7 row SAMPLE drawn in the seg7 face (face=${seg7.rowSampleFace})`);
  // (b) The big preview: name readable (UI font), body = segmented DIGITS (the
  //     sample) in all three styles, in the seg7 face — NOT the blank pangram.
  assert(seg7.previewName === "Seven Segment", `seg7 preview NAME readable (got ${JSON.stringify(seg7.previewName)})`);
  assert(!!seg7.previewNameFace && !/Seven Segment/.test(seg7.previewNameFace), `seg7 preview name in the READABLE UI font (face=${seg7.previewNameFace})`);
  assert(seg7.previewSample === SEG7_SAMPLE, `seg7 preview sample line is the segmented sample (got ${JSON.stringify(seg7.previewSample)})`);
  assert(seg7.previewLines.length === 3 && seg7.previewLines.every((t) => t === SEG7_SAMPLE), `seg7 preview BODY is the segmented sample in all 3 styles (got ${JSON.stringify(seg7.previewLines)})`);
  assert(/Seven Segment/.test(seg7.previewLineFace || ""), `seg7 preview body drawn in the seg7 FACE (face=${seg7.previewLineFace})`);

  // (c) A NORMAL font (Inter) is UNCHANGED: preview name + pangram, both in its
  //     OWN face (regression guard for the sample swap).
  const inter = await focusByQuery("inter");
  console.log("INTER:", JSON.stringify(inter, null, 2));
  const interPop = await page.$(".fp-pop");
  if (interPop) await interPop.screenshot({ path: resolve(SHOTS, "fontpicker_5_inter.png") });
  assert(inter.previewName === "Inter", `inter preview name (got ${JSON.stringify(inter.previewName)})`);
  assert(/PowerRP Inter/.test(inter.previewNameFace || ""), `inter preview NAME still in its OWN face — no regression (face=${inter.previewNameFace})`);
  assert(inter.previewLines.length === 3 && inter.previewLines.every((t) => t === PANGRAM), `inter preview BODY is the pangram, unchanged (got ${JSON.stringify(inter.previewLines[0])})`);
  assert(/PowerRP Inter/.test(inter.previewLineFace || ""), `inter preview body in its OWN face — no regression (face=${inter.previewLineFace})`);

  if (errors.length) console.error("PAGE ERRORS:\n" + errors.join("\n"));
  console.log(`\n${fails.length ? "FAILED: " + fails.length : "PASS"} — FontPicker probe (shots in .claude_vlm_checks/fontpicker_*.png)`);
  process.exitCode = fails.length || errors.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
