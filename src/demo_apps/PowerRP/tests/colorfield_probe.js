/**
 * ColorField probe (W2e): boot the PowerRP editor headless with the demo deck,
 * select a rect, and exercise the ColorField / SvelteLib-ColorPicker color-row
 * path end-to-end, asserting the house preview/commit contract:
 *   - opening the picker (click the swatch) inline-expands it;
 *   - dragging hue/alpha previews LIVE mid-gesture (previewDelta set) while the
 *     committed DOCUMENT stays UNCHANGED until settle;
 *   - pointerup SETTLES = ONE undo unit (undo reverts it, redo restores it);
 *     preview cleared; committed doc changed;
 *   - alpha drag produces an 8-digit #rrggbbaa storage value;
 *   - Escape while open REVERTS the live preview and closes the picker;
 *   - the color row's keyframe diamond still works;
 *   - a legacy #rrggbb (opaque) value loads and opens the picker.
 * Fails loudly (nonzero exit) on any assertion failure or page console error.
 *
 * The ColorPicker's strips use setPointerCapture; puppeteer's page.mouse does
 * not route captured pointer events reliably in headless, so strip gestures are
 * driven with SYNTHETIC PointerEvents dispatched on the strip element (verified
 * to exercise the exact oninput/onchange path).
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/colorfield_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

// Known INTERLEAVED-FLEET boot noise (a stale demo fixture vs other agents'
// in-flight migrations — documented in concerns.md; NOT from the color path).
// The probe ignores these at boot only; any error DURING the color interactions
// (recorded after boot is cleared) still fails. If the demo fixture is
// regenerated this list becomes dead and can be dropped.
// This container's headless graphics reality, allowlisted the same way
// tests/escape_propagation_probe.js and tests/lens_flare_scale_probe.js do it:
// the demo fixture carries video widgets that probe for an adapter the software
// renderer does not expose and fall back, which is EXPECTED here and is not this
// suite's to own. Named specifically — the gate still fails on anything else.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

// Drive a picker strip (.cp-hue / .cp-alpha) or the .cp-square with synthetic
// PointerEvents: a down at fraction f0, a move to fraction f1 (a live gesture).
// Returns nothing; the caller reads previewDelta afterward. Passing `up:true`
// also fires pointerup (settle → onchange commit).
function stripGesture(page, selector, f0, f1, up) {
  return page.evaluate((sel, a, b, doUp) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const mk = (type, fx) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
      clientX: r.left + r.width * fx, clientY: y,
    });
    el.dispatchEvent(mk("pointerdown", a));
    el.dispatchEvent(mk("pointermove", b));
    if (doUp) el.dispatchEvent(mk("pointerup", b));
  }, selector, f0, f1, !!up);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  // Clear known interleaved-fleet boot noise; fail on anything else at boot.
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  if (errors.length) console.warn("(ignoring interleaved-fleet boot noise:\n  " + errors.join("\n  ") + "\n)");
  errors.length = 0; // reset: from here, ANY console error is a color-path failure

  // Select the rect on slide 1 (index 0), where its fill IS keyframed (so the
  // committed value is readable straight from that slide's raw delta).
  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    const id = Object.keys(items).find((k) => items[k].type === "rect");
    app.selection = id;
    return id;
  });
  ok(rectId, "found a rect item in the demo deck");
  await new Promise((r) => setTimeout(r, 250));

  // committedFill(): the rect's fill as stored on slide 0's raw delta (NOT
  // rawState(), which folds in the live preview) — the "committed doc" truth.
  const committedFill = () => page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].fill, rectId);

  // The ColorField renders: swatch button + hex readout; NO native input.
  const rowInfo = await page.evaluate(() => ({
    count: document.querySelectorAll(".inspector .colorfield").length,
    swatches: document.querySelectorAll(".inspector .colorfield-swatch").length,
    nativeInputs: document.querySelectorAll('.inspector input[type="color"]').length,
  }));
  ok(rowInfo.count >= 2, `rect shows >=2 ColorFields (fill+stroke); got ${rowInfo.count}`);
  ok(rowInfo.swatches >= 2, `>=2 swatches rendered; got ${rowInfo.swatches}`);
  ok(rowInfo.nativeInputs === 0, `NO native <input type=color> remains; got ${rowInfo.nativeInputs}`);

  // Click the FILL row's swatch (evaluate-based: the Inspector panel scrolls,
  // and page.click requires the element in-viewport/uncovered; el.click() does
  // not). Returns true if a swatch was found + clicked.
  const clickFillSwatch = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fillRow = rows.find((r) => r.querySelector(".label")?.textContent === "Fill");
    const sw = fillRow?.querySelector(".colorfield-swatch");
    if (!sw) return false;
    sw.click();
    return true;
  });

  // ── Open the fill row's picker by clicking its swatch ──────────────────────
  const before = { fill: await committedFill() };
  ok(before.fill === "#7aa2f7", `demo rect fill starts opaque #7aa2f7; got ${before.fill}`);
  ok(await clickFillSwatch(), "fill swatch found + clicked");
  await new Promise((r) => setTimeout(r, 150));
  const pickerOpen = await page.evaluate(() => document.querySelectorAll(".inspector .colorfield-picker .cp").length);
  ok(pickerOpen === 1, `clicking the swatch inline-expands exactly one picker; got ${pickerOpen}`);

  // ── Drag the HUE strip: preview LIVE mid-gesture, committed doc UNCHANGED ───
  await stripGesture(page, ".inspector .colorfield-picker .cp-hue", 0.1, 0.7, false);
  await new Promise((r) => setTimeout(r, 60));
  const midHue = await page.evaluate((id) => ({
    previewFill: window.__powerrp_app.previewDelta?.items?.[id]?.fill ?? null,
  }), rectId);
  const docDuringHue = await committedFill();
  ok(typeof midHue.previewFill === "string" && midHue.previewFill.startsWith("#"),
    `mid-hue-drag: previewDelta.fill is a live color; got ${JSON.stringify(midHue.previewFill)}`);
  ok(midHue.previewFill !== before.fill,
    `mid-hue-drag: preview differs from original fill (${before.fill} -> ${midHue.previewFill})`);
  ok(docDuringHue === before.fill,
    `mid-hue-drag: committed DOC fill UNCHANGED (still ${before.fill}); got ${docDuringHue}`);

  // pointerup SETTLES → commit; preview cleared; committed doc == last preview.
  await page.evaluate(() => {
    const el = document.querySelector(".inspector .colorfield-picker .cp-hue");
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: r.left + r.width * 0.7, clientY: r.top + r.height / 2 }));
  });
  await new Promise((r) => setTimeout(r, 120));
  const afterHue = await page.evaluate(() => window.__powerrp_app.previewDelta);
  const docAfterHue = await committedFill();
  ok(afterHue === null, "after hue settle: preview cleared");
  ok(docAfterHue !== before.fill, `after hue settle: committed doc fill changed (${before.fill} -> ${docAfterHue})`);
  ok(docAfterHue === midHue.previewFill, "after hue settle: committed value == last preview (no drift)");

  // ONE undo unit: undo reverts to the ORIGINAL fill; redo restores the change.
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 80));
  const afterUndo = await committedFill();
  ok(afterUndo === before.fill, `hue settle is ONE undo unit: undo reverts to ${before.fill}; got ${afterUndo}`);
  await page.evaluate(() => window.__powerrp_app.redo());
  await new Promise((r) => setTimeout(r, 80));
  const afterRedo = await committedFill();
  ok(afterRedo === docAfterHue, `redo restores the committed color (${docAfterHue}); got ${afterRedo}`);
  // reselect (undo/redo may clear selection) and reopen the picker.
  await page.evaluate((id) => { const a = window.__powerrp_app; a.slideIndex = 0; a.selection = id; }, rectId);
  await new Promise((r) => setTimeout(r, 150));

  // ── Drag the ALPHA strip → an 8-digit #rrggbbaa storage value ──────────────
  const pickerNowOpen = await page.evaluate(() => document.querySelectorAll(".inspector .colorfield-picker .cp").length);
  if (pickerNowOpen === 0) { await clickFillSwatch(); await new Promise((r) => setTimeout(r, 120)); }
  await stripGesture(page, ".inspector .colorfield-picker .cp-alpha", 0.9, 0.4, false); // lower alpha
  await new Promise((r) => setTimeout(r, 60));
  const midAlpha = await page.evaluate((id) => window.__powerrp_app.previewDelta?.items?.[id]?.fill ?? null, rectId);
  ok(typeof midAlpha === "string" && midAlpha.length === 9,
    `mid-alpha-drag: preview fill is 8-digit #rrggbbaa; got ${JSON.stringify(midAlpha)}`);
  await page.evaluate(() => {
    const el = document.querySelector(".inspector .colorfield-picker .cp-alpha");
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: r.left + r.width * 0.4, clientY: r.top + r.height / 2 }));
  });
  await new Promise((r) => setTimeout(r, 120));
  const docAfterAlpha = await committedFill();
  ok(docAfterAlpha.length === 9, `after alpha settle: stored fill is 8-digit #rrggbbaa; got ${docAfterAlpha}`);

  // ── Escape while open REVERTS the live preview and closes the picker ────────
  // Ensure the picker is open, then seed an uncommitted preview (as ColorField
  // does on picker oninput mid-drag) and dispatch Escape on the colorfield.
  const openForEsc = await page.evaluate(() => document.querySelectorAll(".inspector .colorfield-picker .cp").length);
  if (openForEsc === 0) { await clickFillSwatch(); await new Promise((r) => setTimeout(r, 120)); }
  const escBaseline = await committedFill();
  await page.evaluate((id) => window.__powerrp_app.setPreview([[["items", id, "fill"], "#123456ff"]]), rectId);
  const escHasPreview = await page.evaluate(() => window.__powerrp_app.previewDelta != null);
  ok(escHasPreview, "pre-Escape: an uncommitted live preview exists to revert");
  await page.evaluate(() => {
    document.querySelector(".inspector .colorfield").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 100));
  const afterEsc = await page.evaluate(() => ({
    open: document.querySelectorAll(".inspector .colorfield-picker .cp").length,
    preview: window.__powerrp_app.previewDelta,
  }));
  const docAfterEsc = await committedFill();
  ok(afterEsc.open === 0, `Escape closes the inline picker; open-count now ${afterEsc.open}`);
  ok(afterEsc.preview === null, "after Escape: live preview reverted (previewDelta null)");
  ok(docAfterEsc === escBaseline, `after Escape: committed doc UNCHANGED (${escBaseline}); got ${docAfterEsc}`);

  // ── Keyframe diamond on a color row still works ────────────────────────────
  // Move to slide 2 (index 1) so toggling a keyframe there is meaningful.
  await page.evaluate((id) => { const a = window.__powerrp_app; a.slideIndex = Math.min(1, a.doc.slides.length - 1); a.selection = id; }, rectId);
  await new Promise((r) => setTimeout(r, 200));
  const fillRowKeyed = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fillRow = rows.find((r) => r.querySelector(".label")?.textContent === "Fill");
    const btn = fillRow?.querySelector(".keybtn");
    return { hasBtn: !!btn, keyed: btn?.classList.contains("keyed") ?? null };
  });
  const kfBefore = await fillRowKeyed();
  ok(kfBefore.hasBtn, "fill color row has a keyframe diamond button");
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    rows.find((r) => r.querySelector(".label")?.textContent === "Fill").querySelector(".keybtn").click();
  });
  await new Promise((r) => setTimeout(r, 150));
  const kfAfter = await fillRowKeyed();
  ok(kfAfter.keyed !== kfBefore.keyed, `keyframe diamond toggled on the color row (${kfBefore.keyed} -> ${kfAfter.keyed})`);

  // ── Legacy #rrggbb (opaque) loads and opens the picker ─────────────────────
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    app.setPreview([[["items", id, "fill"], "#abcdef"]]); // plain 6-digit legacy
    app.commitPreview();
    app.selection = id;
  }, rectId);
  await new Promise((r) => setTimeout(r, 200));
  const legacyHex = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fillRow = rows.find((r) => r.querySelector(".label")?.textContent === "Fill");
    return fillRow?.querySelector(".colorfield-hex")?.textContent ?? null;
  });
  ok(legacyHex === "#abcdef", `legacy #rrggbb loads and displays opaque; got ${JSON.stringify(legacyHex)}`);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    rows.find((r) => r.querySelector(".label")?.textContent === "Fill").querySelector(".colorfield-swatch").click();
  });
  await new Promise((r) => setTimeout(r, 120));
  const legacyPickerHex = await page.evaluate(() => document.querySelector(".inspector .colorfield-picker .cp-hex")?.value ?? null);
  ok(legacyPickerHex && legacyPickerHex.toLowerCase().startsWith("#abcdef"),
    `legacy value opens the picker seeded to the color; hex field got ${JSON.stringify(legacyPickerHex)}`);

  // ── Report ─────────────────────────────────────────────────────────────────
  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`ColorField probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
