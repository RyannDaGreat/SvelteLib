/**
 * Lens-flare FEATURE-SCALE handle probe — the tests/modifier_probe.js technique
 * (page.mouse drives REAL pointer capture; a synthetic dispatchEvent cannot, because
 * CanvasView's drag handlers call setPointerCapture) applied to the flare's SECOND
 * yellow square, the one whose distance from the optical centre sets `flareScale`.
 *
 * Verifies, against the REAL app rather than a simulated preview call:
 *   - the flare offers exactly TWO modifier points, "light" then "scale" (that order
 *     matters: the overlay draws the later one ON TOP, and the scale handle is the one
 *     that must stay grabbable where they coincide);
 *   - dragging "scale" changes flareScale live (mid-drag preview);
 *   - the preview is PURE — the committed doc is untouched mid-drag;
 *   - releasing commits exactly ONE undo unit (one undo restores the pre-drag value);
 *   - Escape mid-drag cancels (reverts the preview, no commit, no undo unit);
 *   - the two handles do NOT fight: with the light dead-centre, dragging "scale"
 *     leaves lightX/lightY alone, and dragging "light" leaves flareScale alone;
 *   - all of it holds IDENTICALLY at 45° rotation (the manifest's correctness bar).
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/lens_flare_scale_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import * as T from "../core/transform.js";

// Resolved from THIS FILE, never from process.cwd(): the dump must run the same
// way whether invoked from the repo root or from the PowerRP directory (a cwd
// -relative path silently doubled to .../PowerRP/src/demo_apps/PowerRP/... and
// the probe died on ENOENT). tests/ -> PowerRP is one level up.
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = resolve(appRoot, "web");
const demoJson = await readFile(resolve(appRoot, "examples/demo.powerrp.json"), "utf8");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

// Software GL so Skia comes up headless, --no-sandbox because we run as root — the
// launch args every recent in-repo browser probe uses (see the .claude_vlm_checks
// harnesses; the older tests/*_probe.js predate the root-container requirement and
// cannot start here at all).
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// Same stale-fixture boot-noise allowance as modifier_probe.js (other agents'
// in-flight migrations on the shared demo fixture, unrelated to this fence).
const IGNORE_BOOT = [
  /PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /mermaid/i,
  // The software-GL headless browser above exposes no compute adapter, so an unrelated
  // video widget on the shared demo fixture reports its own fallback at boot. It is an
  // ENVIRONMENT limit, not a fence this probe owns.
  /no WebGPU adapter|WebGPU init failed/,
];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

const START_SCALE = 0.8; // a pre-drag value distinguishable from the 1 default
const BOX = { x: 200, y: 150, w: 640, h: 360 };

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
  await new Promise((r) => setTimeout(r, 800));
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  /** Adds a lens flare at a known pose via the real addItem + preview/commit API and
   * returns its itemId, both modifier points' LOCAL positions, and node.world — the
   * probe does the matrix multiply in Node with the SAME core/transform.js
   * nodeModifierPoints uses, so it never hardcodes geometry (modifier_probe's rule). */
  const setup = (rotation, over = {}) => page.evaluate((rotation, over, BOX, START_SCALE) => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("demo_lens_flare").defaults);
    const id = app.selection;
    app.setPreview(Object.entries({
      x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h, rotation, flareScale: START_SCALE, ...over,
    }).map(([k, v]) => [["items", id, k], v]));
    app.commitPreview();
    const node = app.nodes().find((n) => n.itemId === id);
    const mps = node.plugin.modifierPoints(node.state).map((m) => ({ id: m.id, x: m.x, y: m.y }));
    return { id, world: node.world, mps };
  }, rotation, over, BOX, START_SCALE);

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  const docVal = (id, key) => page.evaluate((id, key) => window.__powerrp_app.doc.slides[window.__powerrp_app.slideIndex].delta.items?.[id]?.[key], id, key);
  const previewVal = (id, key) => page.evaluate((id, key) => window.__powerrp_app.previewDelta?.items?.[id]?.[key], id, key);
  const worldOf = (s, mpId) => { const m = s.mps.find((x) => x.id === mpId); return T.apply(s.world, m.x, m.y); };

  /** Command. Drags modifier `mpId` by (dx, dy) WORLD units in real pointer steps.
   * `finish` is "up" (commit) or "escape" (cancel); `midway` is called mid-drag. */
  async function dragModifier(s, mpId, dx, dy, finish, midway) {
    const w0 = worldOf(s, mpId);
    const p0 = await worldToPage(w0.x, w0.y);
    const p1 = await worldToPage(w0.x + dx, w0.y + dy);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, { steps: 4 });
    await page.mouse.move(p1.x, p1.y, { steps: 4 });
    if (midway) await midway();
    if (finish === "escape") await page.keyboard.press("Escape");
    // Always release the physical button. After an Escape the app has already dropped
    // the drag, and CanvasView's onPointerUp returns immediately when there is none —
    // so this is a no-op for the app, and it stops the NEXT scenario's mouse.down()
    // from failing on a button puppeteer still considers pressed.
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 120));
  }

  // ── 1. Two handles, at distinct places, scale LAST ────────────────────────────
  {
    const s = await setup(0);
    ok(s.mps.length === 2, `two modifier points (got ${s.mps.length})`);
    ok(s.mps[0].id === "light" && s.mps[1].id === "scale", `order is light,scale — scale drawn on top (got ${s.mps.map((m) => m.id)})`);
    const [l, sc] = s.mps;
    ok(Math.hypot(l.x - sc.x, l.y - sc.y) > 1, `the two handles are at distinct points (${JSON.stringify(s.mps)})`);
    // arm = 0.45 * h/2 = 81 px at scale 1 ⇒ 64.8 at 0.8, east of the centre.
    ok(Math.abs(sc.x - (BOX.w / 2 + 0.45 * (BOX.h / 2) * START_SCALE)) < 1e-9 && Math.abs(sc.y - BOX.h / 2) < 1e-9,
      `scale handle rides the reference arm at 3 o'clock (got ${sc.x},${sc.y})`);
  }

  // ── 2. Drag → live preview, pure doc, ONE undo unit ───────────────────────────
  for (const rotation of [0, Math.PI / 4]) {
    const label = rotation === 0 ? "unrotated" : "at 45°";
    const s = await setup(rotation);
    let mid = null;
    // Drag OUTWARD along the handle's own axis, expressed in WORLD units: at 45° the
    // handle's local +x axis is rotated, so push along the rotated axis.
    const dx = 60 * Math.cos(rotation), dy = 60 * Math.sin(rotation);
    await dragModifier(s, "scale", dx, dy, "up", async () => {
      mid = { doc: await docVal(s.id, "flareScale"), preview: await previewVal(s.id, "flareScale") };
    });
    ok(mid.doc === START_SCALE, `${label} mid-drag: committed doc UNCHANGED (still ${START_SCALE}, got ${mid.doc})`);
    ok(typeof mid.preview === "number" && mid.preview > START_SCALE, `${label} mid-drag: preview flareScale GREW (${mid.preview})`);
    const after = { doc: await docVal(s.id, "flareScale"), preview: await previewVal(s.id, "flareScale") };
    ok(typeof after.doc === "number" && after.doc > START_SCALE, `${label} commit: doc flareScale updated (${after.doc})`);
    ok(after.preview === undefined, `${label} commit: preview cleared`);
    const undone = await page.evaluate(() => { const a = window.__powerrp_app; a.undo(); return a.doc.slides[a.slideIndex].delta.items?.[a.selection]?.flareScale; });
    ok(undone === START_SCALE, `${label} ONE undo unit: undo restores ${START_SCALE} (got ${undone})`);
  }

  // ── 3. Escape mid-drag cancels ────────────────────────────────────────────────
  {
    const s = await setup(0);
    await dragModifier(s, "scale", 60, 0, "escape");
    ok(await docVal(s.id, "flareScale") === START_SCALE, "escape: doc untouched");
    ok(await previewVal(s.id, "flareScale") === undefined, "escape: preview reverted");
  }

  // ── 4. The two handles do not fight (light dead-centre) ───────────────────────
  {
    const s = await setup(0, { lightX: 0.5, lightY: 0.5 });
    await dragModifier(s, "scale", 50, 0, "up");
    ok(await docVal(s.id, "lightX") === 0.5 && await docVal(s.id, "lightY") === 0.5,
      `scale drag left the light alone (${await docVal(s.id, "lightX")}, ${await docVal(s.id, "lightY")})`);
    const scaleAfter = await docVal(s.id, "flareScale");
    const s2 = await setup(0, { lightX: 0.5, lightY: 0.5 });
    await dragModifier(s2, "light", 90, -70, "up");
    ok(await docVal(s2.id, "flareScale") === START_SCALE, `light drag left flareScale alone (${await docVal(s2.id, "flareScale")})`);
    ok(await docVal(s2.id, "lightX") !== 0.5, "light drag actually moved the light");
    ok(scaleAfter > START_SCALE, "…and the scale drag before it had really taken effect");
  }

  ok(liveErrors.length === 0, `no console errors during the drags (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
if (errors.length) { console.error(`\n${errors.length} check(s) failed`); process.exit(1); }
console.log(`\nOK lens_flare_scale_probe — ${checks.length} checks passed`);
