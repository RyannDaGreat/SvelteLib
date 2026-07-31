/**
 * HANDLE-CONSTRAINT browser probe — the handle-constraint protocol (core/derive.js)
 * driven through the REAL app by REAL pointer events, on the two most-constrained
 * handles in the codebase:
 *
 *   the ANALOG CLOCK's hand tip — allowed set = an ANNULUS (any angle, radius held
 *     between the two hand-length bounds), the only two-degree-of-freedom
 *     constraint; and
 *   the LENS FLARE's feature-scale arm — allowed set = a RAY (one axis, floored at
 *     the optical centre), the tightest one-dimensional constraint.
 *
 * page.mouse is mandatory, not a preference: CanvasView's drag handlers call
 * setPointerCapture, which a synthetic dispatchEvent cannot satisfy (the technique
 * tests/modifier_probe.js and tests/lens_flare_scale_probe.js established).
 *
 * Verifies, against the app rather than a simulated call:
 *   - a drag PAST the allowed set lands ON its boundary (the ray floors at 0, the
 *     annulus clamps to the max hand length) — the constraint is what the editor
 *     actually enforces, not just what the unit sweep asserts;
 *   - a drag ACROSS the trajectory is absorbed: the component the constraint
 *     removes changes nothing (the flare's y, the clock's angle-only swing);
 *   - the handle ENDS UP where the constraint said it may be (read back from
 *     modifierPoints after the commit — the round-trip, in the real app);
 *   - the preview is PURE — the committed doc is untouched mid-drag;
 *   - releasing commits EXACTLY ONE undo unit, measured by JSON COMPARE of the
 *     whole document (undo restores an EQUAL doc through a fresh reactive proxy, so
 *     reference identity would prove nothing);
 *   - all of it holds IDENTICALLY at 45° rotation — the constraint is declared in
 *     LOCAL units and derive/CanvasView wrap and invert the same node.world.
 *
 * Run from the SvelteLib repo root or here:
 *   node src/demo_apps/PowerRP/tests/handle_constraint_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import * as T from "../core/transform.js";

// Resolved from THIS FILE, never from process.cwd() (the lens_flare_scale_probe
// lesson: a cwd-relative path silently doubled the app path and died on ENOENT).
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = resolve(appRoot, "web");
const demoJson = await readFile(resolve(appRoot, "examples/demo.powerrp.json"), "utf8");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

// Software GL so Skia comes up headless, --no-sandbox because this container runs
// as root — the launch args every recent in-repo browser probe uses.
const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// The same stale-fixture / headless-graphics boot-noise allowance the sibling
// probes carry: other agents' in-flight migrations on the shared demo fixture, and
// video widgets probing for an adapter the software renderer does not expose.
const IGNORE_BOOT = [
  /PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /mermaid/i,
  /no WebGPU adapter|WebGPU init failed/, /no.*adapter|adapters/i,
];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

const BOX = { x: 200, y: 150, w: 240, h: 240 };
const FLARE_BOX = { x: 200, y: 150, w: 640, h: 360 };
const START_HAND_LENGTH = 0.5; // the clock's default hour-hand length
const START_SCALE = 0.8;       // a flare scale distinguishable from the 1 default

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

  /** Adds a widget at a known pose through the real addItem + preview/commit API and
   * returns its id, node.world, and every handle's LOCAL position. Geometry is never
   * hardcoded here — the probe multiplies by node.world in Node with the SAME
   * core/transform.js nodeModifierPoints uses (modifier_probe's rule). */
  const setup = (type, box, over, rotation) => page.evaluate((type, box, over, rotation) => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get(type).defaults);
    const id = app.selection;
    app.setPreview(Object.entries({ ...box, rotation, ...over }).map(([k, v]) => [["items", id, k], v]));
    app.commitPreview();
    const node = app.nodes().find((n) => n.itemId === id);
    return { id, world: node.world, mps: node.plugin.modifierPoints(node.state).map((m) => ({ id: m.id, x: m.x, y: m.y })) };
  }, type, box, over, rotation);

  /** Query. A handle's CURRENT local position, re-derived from the live app — the
   *  round-trip's read side (handles are derived, never held). */
  const handleNow = (id, mpId) => page.evaluate((id, mpId) => {
    const node = window.__powerrp_app.nodes().find((n) => n.itemId === id);
    const m = node.plugin.modifierPoints(node.state).find((x) => x.id === mpId);
    return m && { x: m.x, y: m.y };
  }, id, mpId);

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  const docVal = (id, key) => page.evaluate((id, key) => window.__powerrp_app.doc.slides[window.__powerrp_app.slideIndex].delta.items?.[id]?.[key], id, key);
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const worldOf = (s, mpId) => { const m = s.mps.find((x) => x.id === mpId); return T.apply(s.world, m.x, m.y); };

  /** Command. Drags handle `mpId` by a LOCAL (dx, dy), rotated into world through the
   *  item's own transform, in real captured pointer steps. `finish` is "up" or
   *  "escape"; `midway` runs mid-drag. */
  async function dragHandle(s, mpId, dLocal, finish, midway) {
    const w0 = worldOf(s, mpId);
    const c = Math.cos(s.world.rotation), sn = Math.sin(s.world.rotation);
    const dw = { x: s.world.scale * (dLocal.x * c - dLocal.y * sn), y: s.world.scale * (dLocal.x * sn + dLocal.y * c) };
    const p0 = await worldToPage(w0.x, w0.y);
    const p1 = await worldToPage(w0.x + dw.x, w0.y + dw.y);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, { steps: 4 });
    await page.mouse.move(p1.x, p1.y, { steps: 4 });
    if (midway) await midway();
    if (finish === "escape") await page.keyboard.press("Escape");
    // Always release the physical button: after an Escape the app already dropped the
    // drag (onPointerUp returns immediately), and leaving it pressed would break the
    // NEXT scenario's mouse.down().
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 120));
  }

  const CLOCK = { time: 10800, hourHandLength: START_HAND_LENGTH, showSecondHand: false }; // 3:00 → hour hand east

  // ── 1. CLOCK hand tip: the ANNULUS clamps a far drag to the outer rim ─────────
  for (const rotation of [0, Math.PI / 4]) {
    const label = rotation === 0 ? "unrotated" : "at 45°";
    const s = await setup("clock_analog", BOX, CLOCK, rotation);
    ok(s.mps.some((m) => m.id === "hourTip"), `${label}: the clock offers an hourTip handle (${s.mps.map((m) => m.id)})`);
    const before = await docJson();
    let mid = null;
    // Straight out along the hand (local +x at 3:00) by five times the face radius:
    // far outside the annulus, so the projection must land on the outer rim and the
    // ANGLE must be untouched.
    await dragHandle(s, "hourTip", { x: 5 * BOX.w, y: 0 }, "up", async () => {
      mid = { doc: await docVal(s.id, "hourHandLength"), docAll: await docJson() };
    });
    ok(mid.doc === START_HAND_LENGTH, `${label} mid-drag: committed doc UNCHANGED (${mid.doc})`);
    ok(mid.docAll === before, `${label} mid-drag: the WHOLE document is byte-identical (preview is pure)`);
    const len = await docVal(s.id, "hourHandLength");
    ok(Math.abs(len - 1) < 1e-9, `${label}: a far outward drag clamps the hand to the outer rim, length 1 (got ${len})`);
    const time = await docVal(s.id, "time");
    ok(Math.abs(((time % 43200) / 43200) * 360 - 90) < 0.5, `${label}: a purely radial drag left the hand ANGLE at 3 o'clock (time ${time})`);
    // ROUND TRIP in the real app: the handle now sits ON the rim it was clamped to.
    const now = await handleNow(s.id, "hourTip");
    const R = Math.min(BOX.w, BOX.h) / 2;
    const radius = Math.hypot(now.x - BOX.w / 2, now.y - BOX.h / 2);
    ok(Math.abs(radius - R) < 1e-6, `${label}: the handle ENDED UP on the rim (radius ${radius}, R ${R})`);
    // ONE undo unit, by JSON COMPARE of the whole doc.
    const restored = await page.evaluate(() => { window.__powerrp_app.undo(); return JSON.stringify(window.__powerrp_app.doc); });
    ok(restored === before, `${label}: EXACTLY ONE undo unit — one undo restores an EQUAL document (JSON compare)`);
  }

  // ── 2. CLOCK hand tip: a drag INTO the pivot clamps to the inner rim ──────────
  {
    const s = await setup("clock_analog", BOX, CLOCK, 0);
    const minLen = await page.evaluate(() => {
      const rows = window.__powerrp_app.registry.get("clock_analog").inspector ?? [];
      return rows.find((r) => r.key === "hourHandLength")?.min;
    });
    ok(typeof minLen === "number" && minLen > 0, `the hand-length row declares a minimum (${minLen})`);
    // INTO the annulus's hole — not past it. The set is a RING, so overshooting the
    // pivot lands on the OUTER rim on the far side (correct, and check 1 already
    // covers that); the inner rim is reached by stopping inside the hole. From the
    // tip at 0.5·R, moving 0.5·R − 2px inward puts the pointer 2px from the pivot,
    // well inside the 0.05·R hole.
    const R = Math.min(BOX.w, BOX.h) / 2;
    const INSIDE_HOLE_PX = 2;
    await dragHandle(s, "hourTip", { x: -(START_HAND_LENGTH * R - INSIDE_HOLE_PX), y: 0 }, "up");
    const len = await docVal(s.id, "hourHandLength");
    ok(Math.abs(len - minLen) < 1e-9, `a drag into the annulus's hole clamps to the inner rim ${minLen} (got ${len})`);
    const now = await handleNow(s.id, "hourTip");
    ok(Math.abs(Math.hypot(now.x - BOX.w / 2, now.y - BOX.h / 2) - minLen * R) < 1e-6, "…and the handle ENDED UP on the inner rim");
  }

  // ── 3. CLOCK hand tip: an angle-only swing leaves the LENGTH alone ────────────
  {
    const s = await setup("clock_analog", BOX, CLOCK, 0);
    const R = Math.min(BOX.w, BOX.h) / 2;
    // From (R/2, 0) to (0, R/2): a quarter turn at the SAME radius — the annulus
    // allows the whole arc, so only the angle (time) may change.
    const arm = START_HAND_LENGTH * R;
    await dragHandle(s, "hourTip", { x: -arm, y: arm }, "up");
    const len = await docVal(s.id, "hourHandLength");
    ok(Math.abs(len - START_HAND_LENGTH) < 1e-6, `swinging at constant radius left the length at ${START_HAND_LENGTH} (got ${len})`);
    const time = await docVal(s.id, "time");
    ok(Math.abs(((time % 43200) / 43200) * 360 - 180) < 1, `…and moved the hand to 6 o'clock (time ${time})`);
  }

  // ── 4. LENS FLARE scale arm: the RAY floors at the optical centre ─────────────
  for (const rotation of [0, Math.PI / 4]) {
    const label = rotation === 0 ? "unrotated" : "at 45°";
    const s = await setup("demo_lens_flare", FLARE_BOX, { flareScale: START_SCALE }, rotation);
    const before = await docJson();
    // Far to the LOCAL left, past the centre the ray starts at: flareScale must land
    // exactly on 0 and never go negative.
    await dragHandle(s, "scale", { x: -3 * FLARE_BOX.w, y: 0 }, "up");
    const scale = await docVal(s.id, "flareScale");
    ok(scale === 0, `${label}: a drag past the optical centre floors flareScale at exactly 0 (got ${scale})`);
    const now = await handleNow(s.id, "scale");
    ok(Math.abs(now.x - FLARE_BOX.w / 2) < 1e-9 && Math.abs(now.y - FLARE_BOX.h / 2) < 1e-9,
      `${label}: the handle ENDED UP on the ray's origin (${now.x}, ${now.y})`);
    const restored = await page.evaluate(() => { window.__powerrp_app.undo(); return JSON.stringify(window.__powerrp_app.doc); });
    ok(restored === before, `${label}: EXACTLY ONE undo unit for the floored drag (JSON compare)`);
  }

  // ── 5. LENS FLARE scale arm: a purely ACROSS-trajectory drag changes nothing ──
  {
    const s = await setup("demo_lens_flare", FLARE_BOX, { flareScale: START_SCALE }, 0);
    // Straight down the LOCAL y: the ray has no y, so the projection removes the ENTIRE
    // drag. The check is a BOUND, not equality, and the bound is what makes it
    // meaningful: page.mouse coordinates are integers, so the world x recovered from
    // the pointer differs from the handle's x by a fraction of a screen pixel — about
    // 1/81 ≈ 1.2e-2 of flareScale per pixel on this arm. If the y LEAKED into the
    // value it would move by 140/81 ≈ 1.7. Landing four orders of magnitude below one
    // pixel's worth is proof the y contributed nothing.
    const PIXEL_QUANTIZATION_BOUND = 1e-4;
    const Y_LEAK_WOULD_BE = 140 / (0.45 * (FLARE_BOX.h / 2));
    await dragHandle(s, "scale", { x: 0, y: 140 }, "up");
    const scale = await docVal(s.id, "flareScale");
    ok(Math.abs(scale - START_SCALE) < PIXEL_QUANTIZATION_BOUND,
      `an across-trajectory drag left flareScale at ${START_SCALE} within pointer quantization (got ${scale}; a y leak would have moved it ~${Y_LEAK_WOULD_BE.toFixed(2)})`);
  }

  // ── 6. Escape mid-drag still cancels through the protocol ─────────────────────
  {
    const s = await setup("clock_analog", BOX, CLOCK, 0);
    const before = await docJson();
    await dragHandle(s, "hourTip", { x: 3 * BOX.w, y: 0 }, "escape");
    ok(await docJson() === before, "escape mid-drag: document untouched");
  }

  ok(liveErrors.length === 0, `no console errors during the drags (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
if (errors.length) { console.error(`\n${errors.length} check(s) failed`); process.exit(1); }
console.log(`\nOK handle_constraint_probe — ${checks.length} checks passed`);
