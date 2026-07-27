/**
 * Escape-propagation probe: every place a LOCAL Escape handler must not ALSO
 * reach App.svelte's global `deselect` (or any other app-level command). Boots
 * the real editor headless and drives REAL keyboard/pointer input through
 * page.keyboard / page.mouse — page.mouse routes through real pointer capture,
 * which a synthetic dispatchEvent cannot (CanvasView's drag handlers call
 * setPointerCapture), the same technique modifier_probe.js uses.
 *
 * The four fences, each measured as app state BEFORE and AFTER one keypress:
 *   1. INLINE TEXT EDIT (TextEditController) — Escape COMMITS the edit and must
 *      keep the selection (it used to commit AND deselect in one keypress: the
 *      sink unmounts inside the keydown, so App.onKeydown's contentEditable
 *      guard no longer sees a typing target by the time the bubble reaches it).
 *   2. ENDPOINT DRAG (CanvasView) — Escape mid-drag CANCELS the drag (preview
 *      reverted, nothing committed, no undo unit) and must keep the selection;
 *      a plain release still commits exactly ONE undo unit.
 *   3. MODAL DIALOG (src/lib/Modal.svelte) — Escape closes the dialog only.
 *   4. SHAPE PICKER POPUP — Escape closes the popup only, and the handler is
 *      SCOPED to the popup (the keystroke is handled by the focused widget).
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/escape_propagation_probe.js
 * An optional argument is a directory to drop screenshots in (editor_smoke.js's
 * convention) — the checks are identical with or without it.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

// Paths resolve from THIS file, never process.cwd() — a cwd-relative path
// silently doubles when the suite is run from the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const powerrp = resolve(here, "..");
const webRoot = resolve(powerrp, "web");
const demoJson = await readFile(resolve(powerrp, "examples/demo.powerrp.json"), "utf8");

// SwiftShader/ANGLE: this container has no GPU, and the editor's Skia surface
// needs a WebGL2 context to boot at all.
const LAUNCH_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
// Stale-fixture boot noise other agents' in-flight migrations emit (same
// allowance as modifier_probe.js / rotated_resize_probe.js), plus this
// container's headless graphics reality: the demo fixture carries video widgets
// that probe for an adapter the software renderer does not expose and fall back.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({ headless: "new", args: LAUNCH_ARGS });

const shotDir = process.argv[2] ?? null;
if (shotDir) await mkdir(shotDir, { recursive: true });

const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || IGNORE_BOOT.some((re) => re.test(m.text()))) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 20000 });
  await pause(800);
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  // THE MECHANISM MEASUREMENT, independent of any one host's guards: a bubble
  // listener on the window counting Escapes that got all the way up. An Escape a
  // local owner (in-place editor, live drag, dialog, popup) claims must never
  // arrive here — that is what "consumed" means, and it is the only assertion
  // that stays true no matter which app-level commands happen to be bound.
  await page.evaluate(() => {
    window.__escAtWindow = 0;
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") window.__escAtWindow++; });
  });
  /** Query + reset: how many Escapes reached the window since the last call. */
  const escapesAtWindow = () => page.evaluate(() => { const n = window.__escAtWindow; window.__escAtWindow = 0; return n; });

  /** The app state one Escape can plausibly disturb, as one snapshot. */
  const snap = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const el = document.activeElement;
    return {
      sel: app.selection,
      textEditing: !!app.textEditing,
      dragging: app.dragging,
      dragKind: app.dragKind,
      hasPreview: !!app.previewDelta,
      docIsBefore: JSON.stringify(app.doc) === window.__escProbeDoc,
      canUndo: app.undoLog.canUndo,
      modalOpen: !!document.querySelector(".modal-panel"),
      pickerOpen: !!document.querySelector(".shape-picker-grid"),
      activeInPicker: !!el?.closest?.(".shape-picker"),
    };
  });
  /** Command. Writes a screenshot when a shot directory was requested. */
  const shot = async (name) => { if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png` }); };
  /** Command (in-page). Stashes the CURRENT document's serialization: matching
   * it later proves nothing was committed, and "matching again after exactly one
   * undo" proves the gesture made exactly ONE undo unit. Compared as JSON, not
   * by reference: undo restores an EQUAL document through a fresh reactive proxy,
   * so reference identity does not survive the round trip (measured). */
  const markDoc = () => page.evaluate(() => { window.__escProbeDoc = JSON.stringify(window.__powerrp_app.doc); });
  /** Command (in-page). Adds `type` at a known on-screen pose, selected. */
  const addItem = (type, pose) => page.evaluate((type, pose) => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get(type).defaults);
    const id = app.selection;
    app.setPreview(Object.entries(pose).map(([k, v]) => [["items", id, k], v]));
    app.commitPreview();
    return id;
  }, type, pose);

  // ── 1. Inline text edit: Escape commits, keeps the selection ──────────────
  {
    const id = await addItem("text", { x: 320, y: 260, w: 300, h: 90 });
    await page.evaluate((id) => window.__powerrp_app.beginTextEdit(id), id);
    await page.waitForSelector(".text-edit-sink", { timeout: 5000 });
    await pause(200);
    await page.keyboard.press("KeyZ"); // one edit, so the commit is observable
    await pause(150);
    await markDoc();
    await shot("10_text_edit_live");
    const before = await snap();
    ok(before.textEditing && before.sel === id, `text edit live on the new item (${JSON.stringify(before)})`);
    ok(before.hasPreview, "text edit staged a preview (the typed char)");

    // The SIBLING branches of the same keydown handler: unlike Escape they keep
    // the sink mounted and focused, so App.onKeydown's isTypingTarget guard still
    // covers them and they need no stopPropagation of their own. Measured, not
    // assumed — an app-level leak would be visible as a doc/selection change
    // (Cmd+Z is app UNDO, Cmd+A is app SELECT ALL).
    for (const combo of [["Meta", "KeyZ"], ["Meta", "KeyA"], ["Meta", "KeyB"]]) {
      await page.keyboard.down(combo[0]);
      await page.keyboard.press(combo[1]);
      await page.keyboard.up(combo[0]);
      await pause(120);
      const s = await snap();
      ok(s.textEditing && s.sel === id && s.docIsBefore,
        `text ${combo.join("+")}: stayed inside the editor, no app-level command fired (${JSON.stringify(s)})`);
    }
    await page.keyboard.press("Escape");
    await pause(200);
    const after = await snap();
    ok(await escapesAtWindow() === 0, "text Escape: CONSUMED by the editor (never reached the window)");
    ok(!after.textEditing, "text Escape: exited edit mode");
    ok(after.sel === id, `text Escape: selection KEPT (expected ${id}, got ${after.sel})`);
    ok(!after.docIsBefore && !after.hasPreview, "text Escape: the edit COMMITTED (doc advanced, preview cleared)");
    const oneUnit = await page.evaluate(() => { window.__powerrp_app.undo(); return JSON.stringify(window.__powerrp_app.doc) === window.__escProbeDoc; });
    ok(oneUnit, "text Escape: exactly ONE undo unit");
    await page.evaluate(() => window.__powerrp_app.redo());
  }

  // ── 2. Endpoint drag: release commits one unit; Escape cancels, keeps sel ──
  {
    const id = await addItem("arrow", { from: { x: 320, y: 420 }, to: { x: 520, y: 420 } });
    await page.waitForSelector(".endpoint", { timeout: 5000 });
    /** The page-space centers of the selected arrow's endpoint handles. */
    const endpointCenters = () => page.evaluate(() => [...document.querySelectorAll(".endpoint")].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }));
    const eps = await endpointCenters();
    ok(eps.length === 2, `the arrow shows both endpoint handles (${eps.length})`);
    const size = page.viewport();
    ok(eps.every((p) => p.x > 0 && p.y > 0 && p.x < size.width && p.y < size.height), `endpoint handles are on-screen (${JSON.stringify(eps)})`);

    // 2a — a plain drag + release commits exactly ONE undo unit.
    await markDoc();
    await page.mouse.move(eps[1].x, eps[1].y);
    await page.mouse.down();
    await page.mouse.move(eps[1].x + 60, eps[1].y - 40, { steps: 6 });
    const mid = await snap();
    ok(mid.dragging && mid.hasPreview, `endpoint drag live with a preview (${JSON.stringify(mid)})`);
    ok(mid.dragKind === "endpoint", `endpoint drag announces dragKind "endpoint" (got ${mid.dragKind})`);
    ok(mid.docIsBefore, "endpoint drag: committed doc untouched mid-drag (preview is pure)");
    await page.mouse.up();
    await pause(150);
    const committed = await snap();
    ok(!committed.docIsBefore && !committed.hasPreview, "endpoint release: committed (doc advanced, preview cleared)");
    ok(committed.dragKind === null && !committed.dragging, "endpoint release: drag bookkeeping cleared");
    const oneUnit = await page.evaluate(() => { window.__powerrp_app.undo(); return JSON.stringify(window.__powerrp_app.doc) === window.__escProbeDoc; });
    ok(oneUnit, "endpoint release: exactly ONE undo unit");

    // 2b — Escape mid-drag cancels the drag and keeps the selection.
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, id);
    await pause(150);
    const eps2 = await endpointCenters();
    await markDoc();
    await page.mouse.move(eps2[1].x, eps2[1].y);
    await page.mouse.down();
    await page.mouse.move(eps2[1].x - 50, eps2[1].y + 30, { steps: 6 });
    await shot("20_endpoint_drag_live");
    const mid2 = await snap();
    ok(mid2.hasPreview && mid2.sel === id, `endpoint drag #2 live on ${id} (${JSON.stringify(mid2)})`);
    await page.keyboard.press("Escape");
    await pause(150);
    const esc = await snap();
    ok(await escapesAtWindow() === 0, "endpoint Escape: CONSUMED by the live drag (never reached the window)");
    ok(esc.sel === id, `endpoint Escape: selection KEPT (expected ${id}, got ${esc.sel})`);
    ok(!esc.hasPreview, "endpoint Escape: preview reverted");
    ok(esc.docIsBefore, "endpoint Escape: nothing committed");
    ok(esc.dragKind === null && !esc.dragging, "endpoint Escape: drag bookkeeping cleared");
    await shot("21_endpoint_after_escape");
    await page.mouse.up(); // the button is still logically down — release it
    await pause(150);
    const released = await snap();
    ok(released.docIsBefore, "endpoint Escape: the release after a cancel commits NOTHING");
    ok(released.sel === id, `endpoint Escape: selection still kept after release (got ${released.sel})`);
  }

  // ── 3. Modal dialog: Escape closes the dialog only ────────────────────────
  {
    // Re-assert a selection so this scenario stands alone: a lost selection is
    // the very thing being measured, and it must not be inherited from above.
    await page.evaluate(() => { const app = window.__powerrp_app; app.selection = app.nodes().at(-1).itemId; });
    await pause(150);
    const before = await snap();
    ok(before.sel !== null, `a selection exists before opening the dialog (${before.sel})`);
    await page.evaluate(() => window.__powerrp_app.showRenameModal());
    await page.waitForSelector(".modal-panel", { timeout: 5000 });
    await pause(200);
    await shot("30_dialog_open");
    await page.keyboard.press("Escape");
    await pause(200);
    const after = await snap();
    ok(await escapesAtWindow() === 0, "modal Escape: CONSUMED by the dialog (never reached the window)");
    ok(!after.modalOpen, "modal Escape: the dialog closed");
    ok(after.sel === before.sel, `modal Escape: canvas selection KEPT (expected ${before.sel}, got ${after.sel})`);
  }

  // ── 4. Shape picker popup: Escape closes the popup only ───────────────────
  {
    await page.evaluate(() => { const app = window.__powerrp_app; app.selection = app.nodes().at(-1).itemId; });
    await pause(150);
    const before = await snap();
    ok(before.sel !== null, `a selection exists before opening the popup (${before.sel})`);
    const btn = await page.$('[aria-label="Add Shape"]');
    ok(!!btn, "the Add Shape toolbar button exists");
    const r = await btn.boundingBox();
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await page.waitForSelector(".shape-picker-grid", { timeout: 5000 });
    await pause(150);
    await shot("40_picker_open");
    const opened = await snap();
    ok(opened.pickerOpen, "the shape picker popup opened");
    ok(opened.activeInPicker, "the picker keeps focus inside itself (a LOCAL handler can see the keystroke)");
    await page.keyboard.press("Escape");
    await pause(200);
    const after = await snap();
    ok(await escapesAtWindow() === 0, "picker Escape: CONSUMED by the popup (never reached the window)");
    await shot("41_picker_after_escape");
    ok(!after.pickerOpen, "picker Escape: the popup closed");
    ok(after.sel === before.sel, `picker Escape: canvas selection KEPT (expected ${before.sel}, got ${after.sel})`);
  }

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error(`\n${errors.length} FAILURES:\n` + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} Escape-propagation checks passed`);
} finally {
  await browser.close();
  await server.close();
}
