/**
 * DOUBLE-CLICK DISCOVERABILITY probe: the gesture the user reported must be both
 * ANNOUNCED and PERFORMED, and the two must come from the same declaration.
 *
 * THE DEFECT THIS MEASURES, in the user's words: "double clicking adds a new point
 * but the shortcut area didnt mention that it's not discoverable". Every
 * double-click behaviour in this editor fired from a DOM `dblclick` handler that
 * core/shortcuts.js had no vocabulary for — MOUSE_TOKENS held no double-click token
 * — so none of the seven widget activations could ever reach the HintBar. The
 * polygon's own "double-click to finish" hint was declared on `mouse_left` and
 * hidden, which made it a single-click glyph nobody ever saw.
 *
 * The node suites (tests/shortcut_registry_test.js, tests/creation_modes_test.js)
 * prove the ENTRIES are generated, reachable and correctly scoped over ~10k probe
 * contexts. They cannot prove the app renders them, because the context object they
 * probe is App.svelte's shortcutCtx() and only the real app builds it. That is the
 * one gap this covers, so it stays deliberately small:
 *
 *   1. THE CHIP — select a polygon; the HintBar shows a double-click chip reading
 *      "Add a point", with a GLYPH (not the raw token string).
 *   2. THE BEHAVIOUR — double-click its outline; a vertex really is inserted.
 *   3. THE PAIRING — select a rect, which declares no activation, and the chip is
 *      gone. Announcing a double-click that does nothing is the mirror-image lie.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/dblclick_discoverability_probe.js
 * An optional argument is a directory to drop screenshots in (editor_smoke.js's
 * convention).
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { MOUSE_DOUBLE_TOKEN } from "../core/shortcuts.js";

// Paths resolve from THIS file, never process.cwd() — a cwd-relative path silently
// doubles when the suite is run from the repo root (editor_smoke.js does that).
const here = dirname(fileURLToPath(import.meta.url));
const powerrp = resolve(here, "..");
const webRoot = resolve(powerrp, "web");
const demoJson = await readFile(resolve(powerrp, "examples/demo.powerrp.json"), "utf8");

// SwiftShader/ANGLE: this container has no GPU, and the editor's Skia surface needs
// a WebGL2 context to boot at all.
const LAUNCH_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
// Stale-fixture boot noise other agents' in-flight migrations emit, plus this
// container's headless graphics reality (the same allowance
// tests/field_key_ownership_probe.js makes, for the same reasons).
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];

// A polygon big enough that its outline is unambiguously far from every vertex, so
// the double-click lands on an EDGE (an insert) rather than on a corner.
const POLY = { x: 200, y: 200, w: 400, h: 300 };
// The glyph src/lib/keyicons.js maps the double-click token to. Named here rather
// than imported because it is a fact about the RENDERED bar, and the point of this
// probe is to measure that independently of the map the app read it from.
const DOUBLE_ICON = "mdi:gesture-double-tap";

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser({ args: LAUNCH_ARGS });

const shotDir = process.argv[2] ?? null;
if (shotDir) await mkdir(shotDir, { recursive: true });

const checks = [];
const errors = [];
// Logged as it happens, not batched: a batched log prints NOTHING when a step
// throws part-way, which is exactly when the transcript matters.
const ok = (cond, label) => {
  checks.push([!!cond, label]);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) errors.push(`CHECK FAILED: ${label}`);
};
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

  const shot = async (name) => { if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png` }); };

  /**
   * Query (in-page). The HintBar EXACTLY AS RENDERED: one row per `.hint`, giving
   * the icons its `.keys` chip drew, the raw text of that chip, and the label.
   *
   * Read from the DOM rather than from the registry ON PURPOSE. The node suites
   * already prove the registry's side over ~10k contexts; the only thing they
   * cannot see is App.svelte's shortcutCtx() feeding the real bar and KeyCombo
   * turning a token into a glyph. `keyText` is what catches an unmapped mouse
   * token, which renders as the literal string "mouse_left_double".
   */
  const renderedHints = () => page.evaluate(() =>
    [...document.querySelectorAll(".hintbar .hint")].map((h) => ({
      icons: [...h.querySelectorAll(".keys iconify-icon")].map((i) => i.getAttribute("icon")),
      keyText: h.querySelector(".keys")?.textContent.trim() ?? "",
      label: h.querySelector(".label")?.textContent.trim() ?? "",
    })));

  /** Query (in-page). Screen coordinates for a world point — app.canvasActions
   *  .worldToScreen offset by the overlay's own rect, the idiom every
   *  canvas-driving probe in this directory uses. */
  const toScreen = (wx, wy) => page.evaluate((wx, wy) => {
    const s = window.__powerrp_app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  // ── SETUP: a polygon, selected ─────────────────────────────────────────────
  const polyId = await page.evaluate((box) => {
    const app = window.__powerrp_app;
    const plugin = app.registry.all().find((p) => p.type === "polygon");
    app.addItem({ ...plugin.defaults, ...box });
    return app.selection;
  }, POLY);
  await pause(300);
  ok(!!polyId, `a polygon was added and selected (${polyId})`);

  const polyActivation = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return app.selectedNode()?.plugin.activate ?? null;
  });
  ok(polyActivation === "insert_point", `the polygon declares activate: "insert_point" (got ${JSON.stringify(polyActivation)})`);

  // ── 1. THE CHIP ────────────────────────────────────────────────────────────
  const withPoly = await renderedHints();
  ok(withPoly.length > 0, `the HintBar is rendering (${withPoly.length} chips)`);
  const dbl = withPoly.filter((h) => h.icons.includes(DOUBLE_ICON));
  ok(
    dbl.length === 1 && dbl[0].label === "Add a point",
    `with a polygon selected the bar shows exactly one double-click chip reading "Add a point" (got ${JSON.stringify(dbl)}) — THIS is the reported defect`,
  );
  ok(
    !withPoly.some((h) => h.keyText.includes(MOUSE_DOUBLE_TOKEN)),
    `no chip may print the raw token "${MOUSE_DOUBLE_TOKEN}" — an unmapped mouse token renders as literal text instead of a glyph`,
  );
  await shot("1-polygon-selected-chip");

  // ── 2. THE BEHAVIOUR ───────────────────────────────────────────────────────
  const before = await page.evaluate((id) => window.__powerrp_app.nodes().find((n) => n.itemId === id)?.state.points.length ?? -1, polyId);
  ok(before > 0, `the polygon has vertices before the gesture (${before})`);
  // The MIDPOINT of the first edge, in screen space: unambiguously ON the outline
  // and far from both of its endpoints, so this is an insert and not a corner grab.
  const world = await page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((x) => x.itemId === id);
    const [a, b] = n.state.points;
    const mid = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
    // The widget's points are NORMALIZED into its box, so a world point is the
    // box origin plus the normalized offset scaled by the box extent.
    return { x: n.state.x + mid.x * n.state.w, y: n.state.y + mid.y * n.state.h };
  }, polyId);
  const at = await toScreen(world.x, world.y);
  ok(!!at, `the first edge's midpoint maps to a screen point (${JSON.stringify(at)})`);
  await page.mouse.click(at.x, at.y, { clickCount: 2, delay: 40 });
  await pause(400);
  const after = await page.evaluate((id) => window.__powerrp_app.nodes().find((n) => n.itemId === id)?.state.points.length ?? -1, polyId);
  ok(after === before + 1, `double-clicking the outline INSERTS one vertex (${before} -> ${after}) — the behaviour the chip now announces`);
  await shot("2-after-double-click");

  // ── 3. THE PAIRING: no activation, no chip ─────────────────────────────────
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const plugin = app.registry.all().find((p) => p.type === "rect");
    app.addItem({ ...plugin.defaults, x: 900, y: 200, w: 200, h: 150 });
  });
  await pause(300);
  const rectActivation = await page.evaluate(() => window.__powerrp_app.selectedNode()?.plugin.activate ?? null);
  ok(rectActivation === null || rectActivation === undefined, `a rect declares NO activation (got ${JSON.stringify(rectActivation)})`);
  const withRect = (await renderedHints()).filter((h) => h.icons.includes(DOUBLE_ICON));
  ok(withRect.length === 0, `with a rect selected the bar shows NO double-click chip (got ${JSON.stringify(withRect)}) — announcing a gesture that does nothing is the mirror-image lie`);
  await shot("3-rect-selected-no-chip");

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([c]) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} double-click discoverability checks passed`);
if (errors.length) {
  console.error(`\n${errors.join("\n")}`);
  process.exit(1);
}
