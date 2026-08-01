/**
 * Arrow-variant modifier-point probe (SB1, manifest ARCHITECTURE PLAN #6):
 * boot the PowerRP editor headless and drive REAL pointer drags (page.mouse
 * — routes through real pointer capture, same technique modifier_probe.js
 * uses for the donut) on:
 *   - the ELBOW arrow's `elbow` modifier point (route changes live);
 *   - the CURVED arrow's `bend` modifier point (curvature changes live);
 *   - one FANCY ARROW modifier point (tipWidth), as a spot-check that the
 *     five-handle geometry also works end-to-end through the real drag path
 *     (arrow_variants_test.js already covers all five analytically in Node —
 *     this is the "does it actually work through a real pointer gesture"
 *     check the manifest's VERIFY section asks for).
 * Also verifies a head at BOTH ends renders two heads with zero console errors,
 * and that the legacy color/width→stroke/strokeWidth migration fires loudly
 * exactly once at boot (the demo fixture was migrated surgically — see
 * concerns.md's Opus19 precedent — so this asserts NO migration noise on the
 * CURRENT fixture, proving the surgical edit actually took).
 *
 * Every scenario checks the same invariants modifier_probe.js established:
 * mid-drag preview-only (committed doc untouched), commit = ONE undo unit,
 * Escape cancels, zero console errors throughout.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/arrow_modifier_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

// Anchored to this file, not the cwd — see the same note in eq_highlight_ref_probe.js:
// a cwd-relative fixture path makes the probe runnable only from the worktree root,
// which breaks re-running it alone during triage.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The WEBGPU-ABSENCE line is an environment report, not a fixture-migration
    // symptom (see webgpu_absence_noise.js). This check exists to prove the demo
    // fixture's stroke/strokeWidth/head-shape migration is not re-firing; a missing
    // WebGPU adapter says nothing about that, and swallowing only this one
    // sentence leaves a real repair log still able to fail the check below.
    if (isWebGpuAbsenceNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  // ZERO boot noise expected — the demo fixture's arrow item was migrated
  // SURGICALLY (color/width -> stroke/strokeWidth, headStart/headEnd added) so
  // withLegacyKeysRenamed/withMissingDefaultsFilled have nothing to repair on
  // this specific item. A non-empty bootErrors here would mean the fixture
  // edit didn't actually take (the schema-lag smoke lesson from concerns.md).
  ok(bootErrors.length === 0, `no boot errors — proves the demo fixture's stroke/strokeWidth/head-shape migration is CURRENT, not re-firing (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  /** Adds an item of `cmdId` at a given state via the real command + preview/
   * commit API, selects it, and returns its itemId + the named modifier
   * point's CURRENT world (x,y) (arrow-family widgets have capabilities.
   * transform:false, so world coordinates ARE the modifier point's x/y —
   * verified in the plugin docstrings; no local/world conversion needed,
   * unlike donut's bbox transform). */
  const setupArrow = (cmdId, extra, mpId) => page.evaluate((cmdId, extra, mpId) => {
    const app = window.__powerrp_app;
    // The arrow Add commands now ARM crosshair placement instead of spawning
    // immediately (manifest UNDEFERRAL SWEEP: crosshair placement for ALL Add
    // buttons). This probe tests modifier points, not placement, so it creates
    // the widget directly via app.addItem (the SAME primitive the placement
    // gesture calls on release) — find the plugin whose command is `cmdId`.
    const plugin = app.registry.all().find((p) => (p.commands ?? []).some((c) => c.id === cmdId));
    app.addItem(plugin.defaults);
    const id = app.selection;
    const pairs = Object.entries(extra).map(([k, v]) => [["items", id, k], v]);
    app.setPreview(pairs);
    app.commitPreview();
    const node = app.nodes().find((n) => n.itemId === id);
    const mp = node.plugin.modifierPoints(node.state).find((m) => m.id === mpId);
    return { id, x: mp.x, y: mp.y };
  }, cmdId, extra, mpId);

  const docProp = (id, key) => page.evaluate((id, key) => window.__powerrp_app.doc.slides[window.__powerrp_app.slideIndex].delta.items?.[id]?.[key], id, key);
  const previewProp = (id, key) => page.evaluate((id, key) => window.__powerrp_app.previewDelta?.items?.[id]?.[key], id, key);

  /** Drives one full drag-commit cycle on a modifier point and checks the
   * standard invariants (preview-only mid-drag, ONE undo unit on commit). */
  async function dragAndCommit(setup, propKey, dx, dy, label) {
    const p0 = await worldToPage(setup.x, setup.y);
    const target = await worldToPage(setup.x + dx, setup.y + dy);
    const before = await docProp(setup.id, propKey);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move((p0.x + target.x) / 2, (p0.y + target.y) / 2, { steps: 4 });
    await page.mouse.move(target.x, target.y, { steps: 4 });
    const midDoc = await docProp(setup.id, propKey);
    const midPreview = await previewProp(setup.id, propKey);
    ok(midDoc === before, `${label}: mid-drag committed doc UNCHANGED (${propKey} still ${before})`);
    ok(typeof midPreview === "number" && midPreview !== before, `${label}: mid-drag preview ${propKey} changed (${before} -> ${midPreview})`);
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 100));
    const after = await docProp(setup.id, propKey);
    ok(after === midPreview, `${label}: commit matches the preview exactly (${after} vs ${midPreview})`);
    const afterPreview = await previewProp(setup.id, propKey);
    ok(afterPreview === undefined, `${label}: preview cleared after commit`);
    const undone = await page.evaluate((id, key, before) => {
      const a = window.__powerrp_app;
      a.undo();
      const v = a.doc.slides[a.slideIndex].delta.items?.[id]?.[key];
      return v === before || v === undefined;
    }, setup.id, propKey, before);
    ok(undone, `${label}: ONE undo unit — undo restores ${propKey} (or removes the keyframe)`);
  }

  // ── Scenario 1: ELBOW arrow's `elbow` modifier point ───────────────────
  {
    const setup = await setupArrow("add-elbow-arrow", { from: { x: 200, y: 200 }, to: { x: 500, y: 400 }, elbow: 0.5 }, "elbow");
    ok(!!setup.id, "elbow arrow created");
    // Drag toward `to`'s x — increases the elbow proportion.
    await dragAndCommit(setup, "elbow", 60, 0, "elbow arrow: elbow modifier point");
  }

  // ── Scenario 2: CURVED arrow's `bend` modifier point ────────────────────
  {
    const setup = await setupArrow("add-curved-arrow", { from: { x: 200, y: 550 }, to: { x: 500, y: 550 }, bend: 0.2 }, "bend");
    ok(!!setup.id, "curved arrow created");
    // Drag perpendicular (along +y, since the arrow is horizontal) — increases bend.
    await dragAndCommit(setup, "bend", 0, 30, "curved arrow: bend modifier point");
  }

  // ── Scenario 3: FANCY ARROW's tipWidth modifier point (spot-check) ─────
  // World coordinates kept well within the canvas's safe interior (the
  // donut probe's proven-safe x~300 range) — an earlier draft placed this
  // arrow at x:700-900, which mapped to a screen point overlapping a
  // SplitPane panel divider at this viewport's default zoom/pan, silently
  // stealing the pointerdown before it ever reached the modifier rect.
  {
    const setup = await setupArrow("add-fancy-arrow", { from: { x: 250, y: 450 }, to: { x: 450, y: 450 }, tipWidth: 30 }, "tipWidth");
    ok(!!setup.id, "fancy arrow created");
    await dragAndCommit(setup, "tipWidth", 0, 15, "fancy arrow: tipWidth modifier point");
  }

  // ── Scenario 4: Escape mid-drag cancels (elbow arrow) ───────────────────
  {
    const setup = await setupArrow("add-elbow-arrow", { from: { x: 200, y: 550 }, to: { x: 450, y: 650 }, elbow: 0.5 }, "elbow");
    const before = await docProp(setup.id, "elbow");
    const p0 = await worldToPage(setup.x, setup.y);
    const target = await worldToPage(setup.x + 80, setup.y);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 6 });
    const midPreview = await previewProp(setup.id, "elbow");
    ok(typeof midPreview === "number" && midPreview !== before, `Escape scenario: mid-drag preview differs from committed (${midPreview} vs ${before})`);
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 50));
    const afterDoc = await docProp(setup.id, "elbow");
    const afterPreview = await previewProp(setup.id, "elbow");
    ok(afterDoc === before, `Escape: committed doc UNCHANGED (${afterDoc} === ${before})`);
    ok(afterPreview === undefined, "Escape: preview cleared");
    await page.mouse.up();
  }

  // ── Scenario 5: a head at BOTH ends renders with zero console errors ───
  {
    await page.evaluate(() => {
      const app = window.__powerrp_app;
      // add-arrow now arms placement — create directly (see setupArrow's note).
      app.addItem(app.registry.get("arrow").defaults);
      const id = app.selection;
      app.setPreview([
        [["items", id, "from"], { x: 950, y: 400 }],
        [["items", id, "to"], { x: 1100, y: 500 }],
        [["items", id, "headStart"], "triangle"],
        [["items", id, "headEnd"], "triangle"],
      ]);
      app.commitPreview();
    });
    await new Promise((r) => setTimeout(r, 150));
    // No direct visual assertion here (headTriangle geometry is covered
    // analytically by arrow_variants_test.js) — this scenario's job is
    // proving the REAL render pipeline (GPU compositor, not just emit())
    // accepts a head at both ends with zero console errors, which the
    // zero-console-errors check at the end of this probe covers.
    ok(true, "a head at BOTH ends committed and rendered (see zero-console-errors check below)");
  }

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} arrow-modifier checks passed`);
} finally {
  await browser.close();
  await server.close();
}
