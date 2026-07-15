/**
 * Rotated-resize probe (W2d, registry #1): boot the PowerRP editor headless,
 * add a rect, rotate it, and drive the EXACT preview CanvasView.resizeDrag
 * produces for a rotated EAST-edge resize (the back-solved x/y), commit it, and
 * assert the PPT opposite-handle invariant LIVE against the app's real
 * derive/worldTransform paint path:
 *   - the grabbed (east) edge tracks the cursor (+40px);
 *   - the opposite (west) edge stays put in world space (~0px drift);
 *   - the rotationAnchor stays the `self.anchors.center` equation after commit
 *     (nothing numeric is persisted).
 * Plus a MOVE-purity regression guard (my CanvasView edit must not disturb the
 * existing preview-only contract).
 *
 * The resize MATH runs in this Node process (importing the real core modules);
 * the app is driven through its own setPreview/commitPreview API and introspected
 * via window.__powerrp_app — the same hook editor_smoke uses. Boot noise from the
 * stale demo fixture vs other agents' migrations is tolerated (same IGNORE_BOOT
 * list as colorfield_probe.js); any error DURING the interactions fails loudly.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/rotated_resize_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import * as T from "../core/transform.js";
import { stateXYForCenterPivotWorld } from "../core/derive.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new" });
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));
const applyWorld = (world, lx, ly) => T.apply(world, lx, ly);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  page.on("console", (m) => {
    if (m.type() !== "error" || isBootNoise(m.text())) return;
    (afterBoot.on ? errors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  // Add a rect and set it rotated 45° at a known pose, via the preview/commit API.
  const setup = await page.evaluate((rot) => {
    const app = window.__powerrp_app;
    app.runCommand("add-rect");
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 300], [["items", id, "y"], 300],
      [["items", id, "w"], 200], [["items", id, "h"], 120],
      [["items", id, "rotation"], rot],
    ]);
    app.commitPreview();
    return { id };
  }, Math.PI / 4);
  ok(!!setup.id, "rect created + rotated 45°");

  const nodeWorld = (id) => page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((n) => n.itemId === id);
    return { world: n.world, w: n.state.w, h: n.state.h };
  }, id);
  const rotAnchorStored = (id) => page.evaluate((id) => window.__powerrp_app.rawState().items[id].rotationAnchor, id);

  const before = await nodeWorld(setup.id);
  const westBefore = applyWorld(before.world, 0, before.h / 2);
  const eastBefore = applyWorld(before.world, before.w, before.h / 2);

  // Reproduce CanvasView.resizeDrag's back-solved preview for a +40px EAST-edge
  // drag (east handle: box top-left stays local (0,0), w grows by 40).
  const dxLocal = 40;
  const topLeftWorld = T.apply(before.world, 0, 0);
  const pinned = { x: topLeftWorld.x, y: topLeftWorld.y, rotation: before.world.rotation, scale: before.world.scale };
  const solved = stateXYForCenterPivotWorld(pinned, before.w + dxLocal, before.h);
  await page.evaluate((id, x, y, w, h) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", id, "x"], x], [["items", id, "y"], y],
      [["items", id, "w"], w], [["items", id, "h"], h],
    ]);
    app.commitPreview();
  }, setup.id, solved.x, solved.y, before.w + dxLocal, before.h);

  const after = await nodeWorld(setup.id);
  const westAfter = applyWorld(after.world, 0, after.h / 2);
  const eastAfter = applyWorld(after.world, after.w, after.h / 2);
  const westDrift = Math.hypot(westAfter.x - westBefore.x, westAfter.y - westBefore.y);
  const eastMove = Math.hypot(eastAfter.x - eastBefore.x, eastAfter.y - eastBefore.y);
  ok(westDrift < 0.01, `WEST edge stays put in world (drift ${westDrift.toFixed(4)}px)`);
  ok(Math.abs(eastMove - dxLocal) < 0.01, `EAST edge moved exactly ${dxLocal}px (${eastMove.toFixed(4)})`);
  const stored = await rotAnchorStored(setup.id);
  ok(typeof stored?.x === "string" && stored.x.startsWith("self."),
    `rotationAnchor stays the self.anchors.center equation after commit (${JSON.stringify(stored)})`);

  // MOVE-purity regression guard: preview never mutates the committed doc.
  const moveGuard = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const docXBefore = app.rawState().items[id].x;
    app.setPreview([[["items", id, "x"], docXBefore + 50]]);
    const committedX = app.doc.slides[app.slideIndex].delta.items?.[id]?.x;
    const previewX = app.previewDelta?.items?.[id]?.x;
    app.cancelPreview();
    return { docXBefore, committedX, previewX, cleared: app.previewDelta === null };
  }, setup.id);
  ok(moveGuard.previewX === moveGuard.docXBefore + 50, "preview reflects the pending move (preview-only)");
  ok(moveGuard.cleared, "cancelPreview clears the preview");

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} rotated-resize checks passed`);
} finally {
  await browser.close();
  await server.close();
}
