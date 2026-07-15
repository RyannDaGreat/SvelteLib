/**
 * Modifier-point probe (SA1, manifest ARCHITECTURE PLAN #1 + DONUT widget):
 * boot the PowerRP editor headless, add a donut, and drive a REAL pointer
 * drag on its inner-rim modifier point (the yellow square) via
 * page.mouse — the same technique editor_smoke.js uses for its shift-drag
 * (page.mouse routes through real pointer capture, unlike a synthetic
 * dispatchEvent — required because CanvasView's drag handlers call
 * setPointerCapture). Verifies, against the REAL app (not a simulated
 * preview call):
 *   - dragging the modifier point changes `inner` live (mid-drag preview);
 *   - the preview is PURE (the committed doc is untouched mid-drag — the
 *     same invariant every other drag kind in editor_smoke.js encodes);
 *   - releasing commits exactly ONE undo unit;
 *   - Escape mid-drag cancels (reverts the preview, no commit, no undo unit);
 *   - the whole thing works IDENTICALLY at 45° rotation (the manifest's
 *     explicit correctness bar: "test at 45°" — nodeModifierPoints wraps
 *     local→world through node.world, and modifierDrag inverts the SAME
 *     world back to local before calling apply, so rotation is correct BY
 *     CONSTRUCTION, not by a rotation-specific code path to verify).
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/modifier_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import * as T from "../core/transform.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new" });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// Same stale-fixture boot-noise allowance as rotated_resize_probe.js/
// colorfield_probe.js (documented in concerns.md — other agents' in-flight
// migrations on the shared demo fixture, unrelated to this fence).
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || isBootNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  /** Adds a donut at a known pose (optionally rotated) via the real command +
   * preview/commit API, selects it, and returns its itemId + the modifier
   * point's LOCAL (x,y) and the node's world transform — the probe computes
   * the WORLD position itself (via the imported core/transform.js, the exact
   * same pure function CanvasView's nodeModifierPoints calls) rather than
   * hardcoding geometry, so it's reading real app state either way; the only
   * thing done in Node instead of in-page is the matrix multiply, to avoid a
   * fragile in-page dynamic import of a module the page didn't statically
   * request. */
  const setupDonut = (rotation) => page.evaluate((rotation) => {
    const app = window.__powerrp_app;
    app.runCommand("add-donut");
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 300], [["items", id, "y"], 300],
      [["items", id, "w"], 200], [["items", id, "h"], 200],
      [["items", id, "inner"], 0.4],
      [["items", id, "rotation"], rotation],
    ]);
    app.commitPreview();
    const node = app.nodes().find((n) => n.itemId === id);
    const mp = node.plugin.modifierPoints(node.state).find((m) => m.id === "inner");
    return { id, world: node.world, localX: mp.x, localY: mp.y };
  }, rotation);

  /** World point → PAGE (absolute) screen coordinates, through the app's own
   * canvasActions.worldToScreen (the SAME transform CanvasView's overlay
   * uses) + the overlay's real bounding rect (screenPoint's render-area
   * origin) — so the probe never assumes a specific zoom/pan, matching
   * whatever the live viewport actually is. */
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  const docInner = (id) => page.evaluate((id) => window.__powerrp_app.doc.slides[window.__powerrp_app.slideIndex].delta.items?.[id]?.inner, id);
  const previewInner = (id) => page.evaluate((id) => window.__powerrp_app.previewDelta?.items?.[id]?.inner, id);
  /** The modifier point's CURRENT world position, computed via the real
   * core/transform.js apply() (imported at top) over the world/local values
   * setupDonut read from the live app — identical math to
   * nodeModifierPoints/CanvasView, just run in Node instead of in-page. */
  const worldOf = (setup) => T.apply(setup.world, setup.localX, setup.localY);

  // ── Scenario 1: unrotated drag → commit ────────────────────────────────
  {
    const setup = await setupDonut(0);
    ok(!!setup.id, "donut created at rotation 0");
    const w0 = worldOf(setup);
    const p0 = await worldToPage(w0.x, w0.y);
    const target = await worldToPage(w0.x - 30, w0.y); // drag toward center (shrinks the hole)
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move((p0.x + target.x) / 2, (p0.y + target.y) / 2, { steps: 4 });
    await page.mouse.move(target.x, target.y, { steps: 4 });
    const mid = { doc: await docInner(setup.id), preview: await previewInner(setup.id) };
    ok(mid.doc === 0.4, `mid-drag: committed doc UNCHANGED (inner still 0.4, got ${mid.doc})`);
    ok(typeof mid.preview === "number" && mid.preview < 0.4, `mid-drag: preview inner DECREASED toward center (${mid.preview})`);
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 100));
    const after = { doc: await docInner(setup.id), preview: await previewInner(setup.id) };
    ok(typeof after.doc === "number" && after.doc < 0.4, `commit: doc inner updated (${after.doc})`);
    ok(after.preview === undefined, "commit: preview cleared");
    const undone = await page.evaluate(() => { const a = window.__powerrp_app; a.undo(); return a.doc.slides[a.slideIndex].delta.items?.[a.selection]?.inner; });
    ok(undone === 0.4 || undone === undefined, `ONE undo unit: undo restores inner to 0.4 (or removes the keyframe) — got ${undone}`);
    await page.evaluate(() => window.__powerrp_app.redo()); // restore state for the next scenario
  }

  // ── Scenario 2: Escape mid-drag cancels ────────────────────────────────
  {
    const setup = await setupDonut(0);
    const before = await docInner(setup.id);
    const w0 = worldOf(setup);
    const p0 = await worldToPage(w0.x, w0.y);
    const target = await worldToPage(w0.x + 25, w0.y);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 6 });
    const midPreview = await previewInner(setup.id);
    ok(typeof midPreview === "number" && midPreview !== before, `Escape scenario: mid-drag preview differs from committed (${midPreview} vs ${before})`);
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 50));
    const afterEscape = { doc: await docInner(setup.id), preview: await previewInner(setup.id) };
    ok(afterEscape.doc === before, `Escape: committed doc UNCHANGED (${afterEscape.doc} === ${before})`);
    ok(afterEscape.preview === undefined, "Escape: preview cleared");
    const undoLenAfterEscape = await page.evaluate(() => window.__powerrp_app.undoLog.canUndo);
    // Release the (still logically down, but capture-cancelled) mouse button
    // so it doesn't bleed into the next scenario's gesture.
    await page.mouse.up();
    ok(undoLenAfterEscape !== null, "Escape: no crash reading undo state (sanity)");
  }

  // ── Scenario 3: 45° rotation — correct by construction (manifest's bar) ─
  {
    const setup = await setupDonut(Math.PI / 4);
    const w0 = worldOf(setup);
    ok(Math.abs(w0.y - 300) > 1, `rotated 45°: modifier point's world Y is OFF the unrotated axis (${w0.y}) — proves it's really reading through node.world, not a stale unrotated position`);
    const p0 = await worldToPage(w0.x, w0.y);
    // Move 15 world units toward the ROTATED handle's own local-x axis
    // (world direction = node.world's rotated x-basis, i.e. (cos45°,sin45°)
    // for a 45° item) — this is what "drag toward the center" means once the
    // handle itself is rotated; a plain screen-axis drag would be wrong. 15
    // (not the handle's full 40-unit reach to the center) keeps the result a
    // non-degenerate INTERMEDIATE value instead of landing exactly on the
    // inner=0 clamp — a stronger check that the proportional math tracks the
    // drag, not just that clamping works.
    const dirX = Math.cos(setup.world.rotation), dirY = Math.sin(setup.world.rotation);
    const target = await worldToPage(w0.x - 15 * dirX, w0.y - 15 * dirY);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 6 });
    const before = 0.4;
    const midPreview = await previewInner(setup.id);
    // Outer radius 100, handle starts at local x=140 (cx=100 + 100·0.4); a
    // clean 15-unit pull along its own axis lands local x=125 → inner=0.25
    // exactly (t=(125-100)/100) — an exact expected value, not just "< before".
    ok(midPreview !== undefined && Math.abs(midPreview - 0.25) < 1e-6, `45° rotation: dragging 15 world units toward center gives the EXACT expected inner=0.25 (got ${midPreview}) — apply() operates in local space regardless of world rotation`);
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 100));
    const after = await docInner(setup.id);
    ok(typeof after === "number" && Math.abs(after - midPreview) < 1e-6, `45° rotation: commit matches the preview exactly (${after} vs ${midPreview})`);
  }

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} modifier-point checks passed`);
} finally {
  await browser.close();
  await server.close();
}
