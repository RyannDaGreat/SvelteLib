/**
 * TWO-POINT band-select probe (#194, the user's "why does box select not work on
 * lines?"): boot the PowerRP editor headless over a purpose-built document and
 * drive REAL rubber-band drags with page.mouse — the same technique
 * modifier_probe.js uses, and the only one that works here, because CanvasView's
 * drag handlers call setPointerCapture and a synthetic dispatchEvent never
 * acquires it.
 *
 * The unit suites (tests/bandselect_test.js, tests/culling_test.js) prove the
 * predicates. THIS proves the whole chain the user actually touches: pointer
 * capture → CanvasView's band drag → bandSelectionAt → selectInBox →
 * localBoundsOf → the plugin's declared bounds → app.selectMany.
 *
 * Verified against the live app:
 *   - OUTER band over everything catches the rect AND the line AND the arrow,
 *     and never the blur layer (unboundable) or the camera (border-hit-only);
 *   - INNER band enclosing only the line's bounds catches exactly the line;
 *   - INNER band on the line's TIGHT endpoint box catches NOTHING — the stroke
 *     pad spills past the endpoints, and inner means completely enclosed, the
 *     same conservative rule a rotated rect obeys;
 *   - a 45deg DIAGONAL line (the manifest's correctness bar) band-selects from a
 *     box covering its square hull;
 *   - zero console errors throughout.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/bandselect_twopoint_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { newDocument, withNewItem } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";

// Paths resolve from THIS FILE, never process.cwd() — a cwd-relative path
// silently doubles when the probe is run from the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../web");

// ── the fixture: built with the REAL document primitives, so the app's load
// path repairs nothing and the probe's expected geometry is exact ─────────────
const registry = createRegistry();
registerAll(registry, createCommands());
const scene = () => {
  let doc = newDocument();
  const insert = (d, type, over) => withNewItem(d, 0, { ...registry.get(type).defaults, active: true, ...over })[0];
  doc = insert(doc, "rect", { x: 100, y: 100, w: 50, h: 50, rotation: 0, scale: 1, z: 1 });
  // line (200,200)→(300,260) stroke 3 → bounds 197..303 x 197..263 (a full
  // stroke-width pad per side, plugins/line.js lineInkRect).
  doc = insert(doc, "line", { from: { x: 200, y: 200 }, to: { x: 300, y: 260 }, z: 2 });
  // arrow (400,200)→(500,260), pad = max(stroke 3, head 12) = 12.
  doc = insert(doc, "arrow", { from: { x: 400, y: 200 }, to: { x: 500, y: 260 }, z: 3 });
  // a 45deg diagonal line: bounds are a SQUARE, 596..704 x 396..504 at stroke 4.
  doc = insert(doc, "line", { from: { x: 600, y: 400 }, to: { x: 700, y: 500 }, strokeWidth: 4, z: 4 });
  doc = insert(doc, "blur", { z: 5 }); // unboundable: must never be band-caught
  return doc;
};

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// The same stale-fixture boot-noise allowance the sibling probes carry
// (documented in concerns.md — other agents' in-flight migrations), plus the
// videoV7 demo widget's own no-adapter report: a headless software rasteriser has
// no GPU adapter to give it, and that widget is not in this fence's scene at all.
// The message is a LOUD report from its own code, not a swallowed failure.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /VideoV7: /];
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
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), JSON.stringify(scene()));
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  /** Query. itemId → type for every derived node, plus each node's world AABB —
   *  read from the LIVE app so the probe never hardcodes what the app believes. */
  const nodeMap = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return app.nodes().map((n) => ({ id: n.itemId, type: n.type, w: n.state.w, from: n.state.from }));
  });
  const idsOfType = (type) => nodeMap.filter((n) => n.type === type).map((n) => n.id);
  const [lineId, diagonalId] = idsOfType("line");
  const [rectId] = idsOfType("rect");
  const [arrowId] = idsOfType("arrow");
  const [blurId] = idsOfType("blur");
  ok(lineId && diagonalId && rectId && arrowId && blurId, "fixture loaded: rect + 2 lines + arrow + blur all derived");

  /** World point → PAGE (absolute) screen coordinates, through the app's OWN
   *  worldToScreen + the overlay's real bounding rect — so the drag lands
   *  correctly at whatever zoom/pan the live viewport happens to have. */
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  /**
   * Arms a band of `mode` and drags the world rect (x0,y0)→(x1,y1) with a REAL
   * pointer (down → several moves → up), then returns the resulting selection.
   * Clears the selection first so each scenario reads only its own catch.
   */
  const bandDrag = async (mode, x0, y0, x1, y1) => {
    await page.evaluate((mode) => {
      const app = window.__powerrp_app;
      app.selectMany([]); // THE multi-select substrate — an empty set clears it
      app.armCrosshairBand(mode);
    }, mode);
    const a = await worldToPage(x0, y0);
    const b = await worldToPage(x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 80));
    return page.evaluate(() => window.__powerrp_app.selectedIds());
  };
  /** Ids → their widget types, for readable failure messages. Every selectable id
   *  is a derived node, so a miss here would be a real defect, not a display gap. */
  const named = (ids) => ids.map((id) => {
    const node = nodeMap.find((n) => n.id === id);
    if (!node) throw new Error(`band caught id "${id}" which is not a derived node`);
    return node.type;
  }).sort();

  // ── 1. OUTER over the whole scene: the two-point widgets come along ─────────
  {
    const got = await bandDrag("outer", 50, 50, 760, 560);
    ok(got.includes(lineId), `OUTER: the LINE is caught (#194 — it never was before)`);
    ok(got.includes(arrowId), "OUTER: the ARROW is caught");
    ok(got.includes(rectId), "OUTER: the rect is still caught (no regression)");
    ok(!got.includes(blurId), "OUTER: the blur layer is NOT caught (genuinely unboundable)");
    ok(!nodeMap.some((n) => n.type === "camera" && got.includes(n.id)), "OUTER: the camera is never caught");
    ok(got.length === 4, `OUTER: exactly the four boundable widgets (got ${JSON.stringify(named(got))})`);
  }

  // ── 2. INNER enclosing only the line's bounds ──────────────────────────────
  {
    const got = await bandDrag("inner", 190, 190, 320, 290);
    ok(got.length === 1 && got[0] === lineId, `INNER: a band over 190..320 x 190..290 catches EXACTLY the line (got ${JSON.stringify(named(got))})`);
  }

  // ── 3. INNER on the TIGHT endpoint box catches nothing ─────────────────────
  {
    const got = await bandDrag("inner", 200, 200, 300, 260);
    ok(got.length === 0, `INNER: the line's tight endpoint box encloses nothing — the stroke pad spills past the endpoints (got ${JSON.stringify(named(got))})`);
  }

  // ── 4. the 45deg diagonal line (the manifest's correctness bar) ────────────
  {
    const got = await bandDrag("inner", 590, 390, 710, 510);
    ok(got.length === 1 && got[0] === diagonalId, `INNER at 45deg: the diagonal line's square hull is enclosed and caught (got ${JSON.stringify(named(got))})`);
    const partial = await bandDrag("inner", 590, 390, 650, 450);
    ok(partial.length === 0, "INNER at 45deg: a band over only HALF the diagonal encloses nothing");
    const touching = await bandDrag("outer", 590, 390, 650, 450);
    ok(touching.length === 1 && touching[0] === diagonalId, "OUTER at 45deg: the same half-band TOUCHES the diagonal and catches it");
  }

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} two-point band-select checks passed`);
} finally {
  await browser.close();
  await server.close();
}
