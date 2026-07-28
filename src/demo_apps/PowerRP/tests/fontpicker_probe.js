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
 *   (6) SEG7/Inter readability of the in-menu preview panel.
 *   (7) LIVE CANVAS PREVIEW of the focused font — the hover trope. Proved on
 *       PIXELS (a crop of the rendered text, clear of the popover) AND on the
 *       serialized document at once, because the whole point is that one changes
 *       while the other does not:
 *         7a hovering a row repaints the canvas, leaves app.doc byte-identical
 *         7b the toolbar keeps reporting the REAL font (no preview feedback loop)
 *         7c focusing the original row again restores the EXACT baseline pixels
 *         7d Escape reverts (pixels + document)
 *         7e ARROW KEYS preview too (the trope follows focus, not the pointer)
 *         7f click-away mid-hover must NOT commit the merely-hovered font
 *         7g clicking commits, and exactly ONE undo restores a JSON-equal doc
 * Screenshots each state into .claude_vlm_checks/ for a VLM look.
 *
 * Frontend-only Vite (backend-absent 404s ignored), swiftshader GL.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";
import { PNG } from "pngjs";

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
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|crypto\.randomUUID|Credentials API|preserveAspect|WebGPU|VideoV7/i;
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

  // ── (7) LIVE CANVAS PREVIEW OF THE FOCUSED FONT ──────────────────────────────
  // A fresh doc whose text is BIG, WHITE and SHORT, parked well left of where the
  // popover opens: the pixel crop must contain only rendered text, never a corner
  // of the menu (whose own preview panel repaints on hover and would make the
  // digest change for the wrong reason). Asserted below, not assumed.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const run = { text: "Hamburg", bold: false, italic: false, underline: false, strike: false, size: 96, font: "system", color: "#ffffff", outlineColor: "#000000", outlineWidth: 0, highlight: "" };
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const text = { ...def("text"), name: "Title", x: 60, y: 120, w: 480, h: 160, z: 1, active: true, text: { runs: [run], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] } };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    app.commit(app.repaired({ meta: { name: "fontpicker-hover", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: tr, delta: { items: { cam, text } } },
    ] }));
    app.slideIndex = 0;
    window.__tid = Object.keys(app.doc.slides[0].delta.items).find((id) => app.doc.slides[0].delta.items[id].type === "text");
  });
  await sleep(500);

  /** Command. Enters text edit on the fixture item and SELECTS the whole string —
   *  a run-style preview applies to a RANGE, so an empty selection previews
   *  nothing (by design: there is no glyph it could change). */
  const enterEditSelectAll = async () => {
    await page.evaluate(() => window.__powerrp_app.beginTextEdit(window.__tid));
    await sleep(400);
    await page.evaluate(() => window.__powerrp_textEdit.setSelection(0, "Hamburg".length));
    await sleep(250);
  };
  // Empty canvas, well clear of the popover, the toolbar and the crop. The mouse
  // is PARKED here before the picker opens: a pointer left sitting over the list
  // from an earlier step gets a pointerenter the moment the menu reappears under
  // it, which is correct behaviour but silently previews a font — that is exactly
  // how the first version of this section contaminated its own baseline.
  const NEUTRAL = { x: 300, y: 900 };
  const openPicker = async () => {
    await page.mouse.move(NEUTRAL.x, NEUTRAL.y);
    await sleep(120);
    await page.evaluate(() => document.querySelector(".fp-trigger").click());
    await sleep(300);
  };
  /** Query. The serialized document — the ONLY identity that matters here. Undo
   *  restores an EQUAL document through a fresh proxy, never the same object. */
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  /** Query. The trigger's visible label = the font the toolbar believes is current. */
  const triggerLabel = () => page.evaluate(() => document.querySelector(".fp-trigger-label")?.textContent.trim() ?? null);

  await enterEditSelectAll();
  await openPicker();

  // The crop: the selection's on-screen rects, padded. Computed once and reused
  // for every shot so each digest compares the same pixels.
  const CROP_PAD = 12;
  const geom = await page.evaluate((pad) => {
    const rects = window.__powerrp_textEdit.selectionScreenRects();
    if (!rects.length) return null;
    // selectionScreenRects is in the RENDER-AREA frame (PanZoom's worldToScreen),
    // not page coordinates — offset by the scene canvas so the crop lands on the
    // canvas and not, say, on the slide navigator's thumbnail, which re-renders
    // on preview and would confound every comparison.
    const c = document.querySelector("canvas.scene").getBoundingClientRect();
    const x0 = c.left + Math.min(...rects.map((r) => r.x)), y0 = c.top + Math.min(...rects.map((r) => r.y));
    const x1 = c.left + Math.max(...rects.map((r) => r.x + r.w)), y1 = c.top + Math.max(...rects.map((r) => r.y + r.h));
    const pop = document.querySelector(".fp-pop")?.getBoundingClientRect() ?? null;
    const tb = document.querySelector(".text-format-toolbar")?.getBoundingClientRect() ?? null;
    if (!pop || !tb) return null;
    // CLAMP the padded selection box into the region that shows canvas and
    // nothing else: left of the popover, below the floating toolbar, inside the
    // scene canvas. A few glyphs of a 96u face are ample signal; what matters is
    // that every pixel in frame can ONLY have come from the render.
    const GAP = 4;
    const left = Math.max(x0 - pad, c.left);
    const right = Math.min(x1 + pad, pop.left - GAP, c.right);
    const top = Math.max(y0 - pad, tb.bottom + GAP, c.top);
    const bottom = Math.min(y1 + pad, c.bottom);
    return {
      clip: { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) },
      canvas: { left: Math.round(c.left), top: Math.round(c.top), right: Math.round(c.right), bottom: Math.round(c.bottom) },
      popLeft: Math.round(pop.left),
      toolbarBottom: Math.round(tb.bottom),
    };
  }, CROP_PAD);
  const MIN_CROP = 60; // a crop smaller than this shows too few glyphs to judge
  assert(!!geom && geom.clip.width >= MIN_CROP && geom.clip.height >= MIN_CROP,
    `selection yields a usable canvas-only crop (${JSON.stringify(geom?.clip)})`);
  const clip = geom.clip;
  // The crop must show ONLY canvas: inside the scene canvas, left of the popover,
  // below the floating toolbar. Anything else in frame (the navigator thumbnail,
  // the toolbar's own controls) repaints for reasons unrelated to the canvas.
  assert(clip.x >= geom.canvas.left && clip.y >= geom.canvas.top && clip.x + clip.width <= geom.canvas.right && clip.y + clip.height <= geom.canvas.bottom,
    `pixel crop lies wholly INSIDE the scene canvas (crop=${JSON.stringify(clip)} canvas=${JSON.stringify(geom.canvas)})`);
  assert(geom.popLeft != null && clip.x + clip.width <= geom.popLeft,
    `pixel crop is CLEAR of the popover (crop right=${clip.x + clip.width}, popover left=${geom.popLeft})`);
  assert(geom.toolbarBottom != null && clip.y >= geom.toolbarBottom,
    `pixel crop is CLEAR of the floating toolbar (crop top=${clip.y}, toolbar bottom=${geom.toolbarBottom})`);

  // The crop must contain RENDERED GLYPHS ONLY. The caret + selection rects are
  // DOM overlays drawn over the same pixels, and the caret BLINKS — leaving them
  // in makes every digest a coin flip and the whole comparison meaningless.
  // Hiding them for the rest of the run is exactly right: what is under test is
  // what Skia painted, not the editor chrome on top of it.
  // Also the SELECTION outline + resize handles: Escape closes the picker AND
  // exits edit mode (its keydown deliberately does not stop propagation), which
  // swaps editing chrome for selection chrome — a DOM change that has nothing to
  // do with whether the previewed typeface was reverted.
  await page.addStyleTag({ content: ".text-edit-caret, .text-edit-selrect, .handle, polygon.selection { display: none !important; }" });
  await sleep(200);

  // Compare DECODED PIXELS, not file digests: the GL rasterizer is not
  // bit-deterministic across repaints, so two screenshots of an unchanged scene
  // hash differently while being visually identical. Mean absolute difference
  // over RGB separates "same scene, resampling noise" from "different typeface"
  // by orders of magnitude — the noise floor is MEASURED below, not assumed.
  const shot = async (name) => {
    const buf = await page.screenshot({ clip });
    fs.writeFileSync(resolve(SHOTS, `fontpicker_hover_${name}.png`), buf);
    return PNG.sync.read(buf);
  };
  /**
   * Pure function. Mean absolute per-channel RGB difference of two equal-sized
   * decoded PNGs, in 0..255 units. 0 = pixel-identical.
   *
   * @param {{data: Buffer, width: number, height: number}} a
   * @param {{data: Buffer, width: number, height: number}} b
   * @returns {number}
   *
   * @example mad(black4x4, black4x4) // 0
   * @example mad(black4x4, white4x4) // 255
   */
  const mad = (a, b) => {
    let sum = 0, n = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      n += 3;
    }
    return sum / n;
  };
  /** Command. Moves the real mouse onto the row whose label starts with `prefix`,
   *  firing a genuine pointerenter (the trope's actual trigger). */
  const hoverRow = async (prefix) => {
    const at = await page.evaluate((p) => {
      const li = [...document.querySelectorAll(".fp-item")].find((el) => el.querySelector(".fp-item-name")?.textContent.trim().startsWith(p));
      if (!li) return null;
      li.scrollIntoView({ block: "nearest" });
      const r = li.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, prefix);
    if (!at) return false;
    await page.mouse.move(at.x, at.y);
    await sleep(280);
    return true;
  };

  /** Command. Logs the STAGED vs STORED font alongside the focused row — the four
   *  numbers that make a preview bug self-diagnosing (this is what revealed the
   *  contaminated baseline: stagedFonts was already set at "base"). */
  const probeState = async (tag) => {
    const s = await page.evaluate(() => {
      const app = window.__powerrp_app;
      const pd = app.previewDelta;
      const stagedRuns = pd?.items?.[window.__tid]?.text?.runs ?? null;
      const docRuns = app.doc.slides[0].delta.items[window.__tid].text.runs;
      const active = document.querySelector(".fp-item.active .fp-item-name")?.textContent.trim() ?? null;
      return {
        stagedFonts: stagedRuns ? stagedRuns.map((r) => r.font) : null,
        docFonts: docRuns.map((r) => r.font),
        transient: !!app.transientPreview,
        activeRow: active,
        trigger: document.querySelector(".fp-trigger-label")?.textContent.trim() ?? null,
      };
    });
    console.log(`  STATE[${tag}]`, JSON.stringify(s));
  };

  const baseDoc = await docJson();
  await probeState("base");
  // The baseline MUST be the untouched render: nothing staged, nothing transient.
  // Every later comparison is against this, so a contaminated baseline would
  // quietly invert the meaning of "reverted".
  const baseClean = await page.evaluate(() => window.__powerrp_app.previewDelta === null && !window.__powerrp_app.transientPreview);
  assert(baseClean, "BASELINE IS CLEAN — no preview staged before the comparisons begin");
  const base = await shot("0_base");

  // MEASURE THE NOISE FLOOR: two shots of an untouched scene. Everything below is
  // judged against what the renderer itself does when nothing changed, so the
  // thresholds are evidence rather than taste.
  const noise = mad(base, await shot("0_base_again"));
  // CONTROL: leaving edit mode re-renders the SAME text slightly differently
  // (a broad, low-amplitude antialiasing shift over every glyph edge — measured,
  // not guessed). It has nothing to do with previews, but it is large enough to
  // swamp a revert check, so every comparison below is made in the SAME edit
  // state as the baseline: shots taken after an exit re-enter edit mode first.
  await page.evaluate(() => window.__powerrp_app.dismissEdit());
  await sleep(400);
  const editModeShift = mad(base, await shot("0_control_not_editing"));
  await enterEditSelectAll();
  await openPicker();
  const reenterShift = mad(base, await shot("0_control_reentered"));
  console.log(`PIXEL CONTROLS: exiting edit mode shifts mad=${editModeShift.toFixed(3)}; re-entering returns to mad=${reenterShift.toFixed(3)}`);
  assert(reenterShift <= 0.5, `re-entering edit mode reproduces the baseline render exactly (mad=${reenterShift.toFixed(3)}) — so like-for-like comparison is sound`);
  // A revert must land within the renderer's own repaint noise; a typeface swap
  // must clear it by a wide margin. 4x/20x give room without being a fudge.
  const SAME_MAX = Math.max(0.5, noise * 4);
  const CHANGED_MIN = Math.max(2.0, noise * 20);
  console.log(`PIXEL NOISE FLOOR: mad=${noise.toFixed(4)} → same<=${SAME_MAX.toFixed(3)}, changed>=${CHANGED_MIN.toFixed(3)}`);
  assert(noise < 1.0, `renderer repaint noise is small enough to compare against (mad=${noise.toFixed(4)})`);

  // (7a) HOVER a visually distinct face → the CANVAS repaints, the DOCUMENT does not.
  const hovered = await hoverRow("Seven Segment");
  assert(hovered, "the Seven Segment row is reachable in the list");
  const hoverShot = await shot("1_hovering_seg7");
  const hoverDoc = await docJson();
  const hoverMad = mad(base, hoverShot);
  assert(hoverMad >= CHANGED_MIN, `HOVER REPAINTS THE CANVAS (mad=${hoverMad.toFixed(3)} >= ${CHANGED_MIN.toFixed(3)})`);
  assert(hoverDoc === baseDoc, "hover leaves the DOCUMENT byte-identical (no commit, no undo entry)");

  // (7b) No feedback loop: the toolbar must keep reporting the REAL font. If the
  // staged preview fed back into the picker's `value`, the picker would read its
  // own preview as the current font and cancel itself (flicker/loop).
  assert((await triggerLabel()) === "System UI", `toolbar still reports the REAL font while previewing (label=${JSON.stringify(await triggerLabel())})`);

  await probeState("hovering_seg7");
  // (7c) Focus the ORIGINAL row again → baseline pixels back.
  await hoverRow("System UI");
  await probeState("back_on_original");
  const backMad = mad(base, await shot("2_back_on_original"));
  assert(backMad <= SAME_MAX, `re-focusing the original font restores the baseline pixels (mad=${backMad.toFixed(3)} <= ${SAME_MAX.toFixed(3)})`);

  // (7d) ESCAPE while previewing must revert, not strand the preview.
  await hoverRow("Seven Segment");
  assert(mad(base, await shot("3_before_escape")) >= CHANGED_MIN, "preview is live again before Escape (guards the next assertion)");
  await page.keyboard.press("Escape");
  await sleep(350);
  assert((await docJson()) === baseDoc, "Escape leaves the document untouched");
  assert(await page.evaluate(() => !document.querySelector(".fp-pop")), "Escape also closed the picker");
  // Escape ALSO exits edit mode: FontPicker's Escape handler does not stop
  // propagation, so it reaches the editor's own Escape → commit-and-exit.
  // Recorded, not asserted as desirable — it is PRE-EXISTING behaviour. What
  // matters is that the revert ran BEFORE the exit could commit the hover, which
  // the untouched-document assertion above proves.
  assert(await page.evaluate(() => window.__powerrp_app.textEditing === null),
    "(recorded) Escape in the picker also exits edit mode — pre-existing, and it committed the REAL value");
  // Re-enter before shooting — see the edit-mode control above.
  await enterEditSelectAll();
  const escMad = mad(base, await shot("4_after_escape"));
  assert(escMad <= SAME_MAX, `ESCAPE reverts the preview (mad=${escMad.toFixed(3)} <= ${SAME_MAX.toFixed(3)})`);

  // (7e) KEYBOARD navigation previews too — the trope follows FOCUS, not the
  // pointer. Arrow ONTO A VISUALLY DISTINCT face: neighbouring grotesques can
  // rasterize identically here, so a single ArrowDown proves nothing (it measured
  // mad=0.000 while the preview was in fact working — a false negative).
  await openPicker();
  const ARROW_LIMIT = 40; // the list is bounded; never spin forever
  let arrowSteps = 0, landed = null;
  while (arrowSteps < ARROW_LIMIT) {
    landed = await page.evaluate(() => document.querySelector(".fp-item.active .fp-item-name")?.textContent.trim() ?? null);
    if (landed === "Seven Segment") break;
    await page.keyboard.press("ArrowDown");
    arrowSteps++;
    await sleep(60);
  }
  await sleep(300);
  assert(landed === "Seven Segment", `ARROW KEYS moved focus onto Seven Segment in ${arrowSteps} presses (landed=${JSON.stringify(landed)})`);
  const arrowMad = mad(base, await shot("5_arrowdown"));
  assert(arrowMad >= CHANGED_MIN, `ARROW-KEY focus previews on the canvas — no pointer involved (mad=${arrowMad.toFixed(3)})`);
  assert((await docJson()) === baseDoc, "keyboard preview leaves the document untouched");
  await page.keyboard.press("Escape");
  await sleep(300);
  await enterEditSelectAll(); // Escape exits edit mode; compare like-for-like
  const arrowEscMad = mad(base, await shot("6_after_arrow_escape"));
  assert(arrowEscMad <= SAME_MAX, `Escape after keyboard preview reverts (mad=${arrowEscMad.toFixed(3)})`);

  // (7f) THE HAZARD: click-away lands mid-hover. Click-away is a WINDOW-capture
  // pointerdown that COMMITS the edit, and it always beats the picker's own
  // document-capture close — so without a transient-preview guard the merely
  // HOVERED font would be committed as though it had been chosen.
  await openPicker();
  await hoverRow("Seven Segment");
  assert(mad(base, await shot("7_hover_before_clickaway")) >= CHANGED_MIN, "preview live before the click-away (guards the next assertion)");
  await page.mouse.click(900, 700); // empty canvas, outside the overlay + toolbar
  await sleep(450);
  const afterAway = await docJson();
  assert(!/seg7/.test(afterAway), "CLICK-AWAY MID-HOVER DID NOT COMMIT the hovered font (no seg7 in the document)");
  assert(afterAway === baseDoc, "click-away mid-hover left the document exactly as it was");
  await enterEditSelectAll(); // click-away exits edit mode; compare like-for-like
  const awayMad = mad(base, await shot("8_after_clickaway"));
  assert(awayMad <= SAME_MAX, `click-away mid-hover reverted the canvas too (mad=${awayMad.toFixed(3)})`);

  // (7g) CLICKING commits — and exactly ONE undo restores a JSON-equal document.
  await enterEditSelectAll();
  await openPicker();
  await hoverRow("Seven Segment");
  await page.evaluate(() => {
    const li = [...document.querySelectorAll(".fp-item")].find((el) => el.querySelector(".fp-item-name")?.textContent.trim().startsWith("Seven Segment"));
    li.click();
  });
  await sleep(350);
  await page.evaluate(() => window.__powerrp_app.dismissEdit()); // leave edit mode → commit
  await sleep(450);
  const committed = await docJson();
  assert(committed !== baseDoc, "clicking a font COMMITS a change to the document");
  assert(/seg7/.test(committed), "the committed document carries the CHOSEN font");
  const commitMad = mad(base, await shot("9_committed"));
  assert(commitMad >= CHANGED_MIN, `committed font is on the canvas (mad=${commitMad.toFixed(3)})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(400);
  assert((await docJson()) === baseDoc, "EXACTLY ONE undo restores a JSON-equal document (one undo unit, no hover spam)");

  // ── (8) THE REST OF THE TOOLBAR PREVIEWS TOO ─────────────────────────────────
  // The FontPicker was the ONLY control wired to onstylepreview/onstylepreviewend;
  // Bold/Italic/Underline/Strike and the size steppers were handed the same seam
  // and ignored it. Same fixture, same crop, same measured thresholds as (7) — so
  // these assertions are directly comparable with the font ones above and cost no
  // new machinery.
  //
  // Hovering here must NOT dismiss edit mode, so every step keeps the pointer on
  // toolbar chrome or the parked NEUTRAL point; the toolbar's own pointerleave is
  // what reverts, which is precisely what 8b measures.

  /** Command. Moves the pointer onto a toolbar button by aria-label and lets the
   *  hover settle. Real pointer moves, not synthetic events — a dispatched
   *  pointerenter would not exercise the browser's own hit-testing. */
  const hoverToolbar = async (label) => {
    const box = await page.evaluate((l) => {
      const b = document.querySelector(`.text-format-toolbar button[aria-label="${l}"]`);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, label);
    if (!box) return false;
    await page.mouse.move(box.x, box.y);
    await page.mouse.move(box.x + 1, box.y);
    await sleep(280);
    return true;
  };

  await enterEditSelectAll();
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y);
  await sleep(250);
  const tbBase = await shot("10_toolbar_base");
  const tbBaseDoc = await docJson();
  assert(
    await page.evaluate(() => window.__powerrp_app.previewDelta === null && !window.__powerrp_app.transientPreview),
    "TOOLBAR BASELINE IS CLEAN — no preview staged before the toolbar comparisons begin"
  );

  // (8a) Hovering a toggle repaints the canvas and leaves the document alone.
  for (const label of ["Bold", "Italic", "Underline", "Strikethrough", "Increase size"]) {
    assert(await hoverToolbar(label), `the toolbar exposes a "${label}" button to hover`);
    const m = mad(tbBase, await shot(`11_hover_${label.toLowerCase().replace(/ /g, "_")}`));
    assert(m >= CHANGED_MIN, `HOVERING "${label}" REPAINTS THE CANVAS (mad=${m.toFixed(3)} >= ${CHANGED_MIN.toFixed(3)})`);
    assert((await docJson()) === tbBaseDoc, `hovering "${label}" leaves the document byte-identical`);
    assert(
      await page.evaluate(() => typeof window.__powerrp_app.transientPreview === "function"),
      `hovering "${label}" stages the preview as TRANSIENT (a click-away cannot commit it)`
    );
  }

  // (8b) LEAVING THE TOOLBAR REVERTS — measured, against the same baseline.
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y);
  await sleep(300);
  const leaveMad = mad(tbBase, await shot("12_after_toolbar_leave"));
  assert(leaveMad <= SAME_MAX, `LEAVING THE TOOLBAR REVERTS the preview (mad=${leaveMad.toFixed(3)} <= ${SAME_MAX.toFixed(3)})`);
  assert((await docJson()) === tbBaseDoc, "leaving the toolbar left the document exactly as it was");
  assert(
    await page.evaluate(() => window.__powerrp_app.previewDelta === null && !window.__powerrp_app.transientPreview),
    "leaving the toolbar leaves NO preview staged behind (a bare hover creates no pending edit)"
  );

  // (8c) The toggle's LIT state keeps reporting the COMMITTED value while a hover
  // previews the opposite — the "two states need two readings" invariant. Without
  // it the button would light up on hover and be indistinguishable from committed.
  const litState = () => page.evaluate(() =>
    document.querySelector('.text-format-toolbar button[aria-label="Bold"]')?.getAttribute("aria-pressed"));
  const litBefore = await litState();
  await hoverToolbar("Bold");
  assert(
    (await litState()) === litBefore,
    `the Bold button keeps reporting the COMMITTED state while hovered (aria-pressed stayed ${litBefore}) — hover is distinguishable from committed`
  );
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y);
  await sleep(280);

  // (8d) CLICKING a toggle commits, and exactly ONE undo restores the document.
  await hoverToolbar("Bold");
  await page.evaluate(() => document.querySelector('.text-format-toolbar button[aria-label="Bold"]').click());
  await sleep(300);
  await page.evaluate(() => window.__powerrp_app.dismissEdit());
  await sleep(450);
  const boldCommitted = await docJson();
  assert(boldCommitted !== tbBaseDoc, "clicking Bold COMMITS a change to the document");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(400);
  assert((await docJson()) === tbBaseDoc, "EXACTLY ONE undo restores a JSON-equal document after a hover-then-click on Bold");

  if (errors.length) console.error("PAGE ERRORS:\n" + errors.join("\n"));
  console.log(`\n${fails.length ? "FAILED: " + fails.length : "PASS"} — FontPicker probe (shots in .claude_vlm_checks/fontpicker_*.png)`);
  process.exitCode = fails.length || errors.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
