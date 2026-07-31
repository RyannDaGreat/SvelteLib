/**
 * GOD RAYS — FIRST-USE PROBE, the user's EXACT reported path, on the real editor.
 *
 * The bug: "demo_god_rays b405eaa4": failed to emit — materialBackdrop: param
 * "lightOffsetX" is a non-finite number (NaN)", hit inserting a FRESH widget into
 * the user's OWN document — not the fixture-deck probe's tuned sky/sun/cloud deck
 * (god_rays_probe.js), which OVERRIDES lightWorldX/Y with a literal-or-bound value
 * at insert time and therefore never exercised the plugin's own DEFAULT equation at
 * all. This probe does exactly what the palette does: `addItem(registry.get(
 * "demo_god_rays").defaults)` — the unmodified defaults object, equation strings and
 * all — matching web/App.svelte's "Add Demo Widget" > "God Rays" menu entry.
 *
 * THREE CHECKS, matching the bug report's acceptance:
 *   1. Fresh Untitled document -> insert from the registry defaults (the palette's
 *      own code path) -> must RENDER (no page error, no red-boxed item) — not the
 *      red box from the bug report.
 *   2. The inserted item's evaluated state carries a FINITE lightWorldX/Y (proves
 *      the fix, not just "didn't crash" — a crash-free NaN would still be silently
 *      wrong).
 *   3. Reload the page (the working-copy model's autosave recovers the unsaved
 *      draft) -> the item is still there and STILL renders — the exact acceptance
 *      criterion in the bug report ("revisit rebuilds fresh" precedent, applied to
 *      a plain reload of an unsaved insert).
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/god_rays_insert_probe.js
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1280, height: 800 };
const BOOT_SETTLE_MS = 1200;
const PAINT_SETTLE_MS = 1000;

// Boot noise unrelated to this probe (god_rays_probe.js's own list — same reasons:
// no GPU backend, no project server listening for a frontend-only Vite boot).
const KNOWN_BOOT_NOISE = [/no WebGPU adapter/, /WebGPU init failed/, /Failed to load resource.*500/, /\/api\/(projects|assets)/];

/** Pure function. Splits errors into ones this probe must fail on vs known noise.
 * @example partitionErrors(["console.error: VideoV7: no WebGPU adapter"]).relevant // [] */
function partitionErrors(all) {
  const ignored = all.filter((e) => KNOWN_BOOT_NOISE.some((re) => re.test(e)));
  return { relevant: all.filter((e) => !ignored.includes(e)), ignored };
}

function assertNoErrors(all, where) {
  const { relevant, ignored } = partitionErrors(all);
  for (const e of ignored) console.log(`  (ignored, known-unrelated) ${e}`);
  all.length = 0;
  if (relevant.length) throw new Error(`PAGE ERRORS ${where}:\n${relevant.map((e) => JSON.stringify(e)).join("\n")}`);
}

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser({ args: CHROME_ARGS });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  // ── 1. FRESH UNTITLED DOCUMENT ──────────────────────────────────────────────
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  assertNoErrors(errors, "AT BOOT (fresh Untitled document)");

  const before = await page.evaluate(() => ({
    name: window.__powerrp_app.projectDisplayName?.() ?? null,
    itemCount: Object.keys(window.__powerrp_app.doc.slides[0].delta.items ?? {}).length,
  }));
  console.log(`  fresh document: "${before.name}", ${before.itemCount} item(s)`);

  // ── 2. INSERT GOD RAYS — the palette's EXACT code path ──────────────────────
  // web/App.svelte's "demo-insert-god-rays" command is literally:
  //   run: (a) => a.addItem(a.registry.get("demo_god_rays").defaults)
  // This probe calls that same seam directly rather than clicking through the
  // submenu, for the same reason every other probe in this suite drives
  // window.__powerrp_app instead of the DOM: it is the one path every insert
  // surface (palette, submenu, future ones) funnels through, so exercising it
  // IS exercising the menu item without depending on the menu's own DOM shape.
  const inserted = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const defaults = app.registry.get("demo_god_rays").defaults;
    app.addItem(defaults);
    return app.selection; // the new item's id, per addItem's own contract
  });
  if (!inserted) throw new Error("probe: addItem(demo_god_rays defaults) did not select the new item");
  console.log(`  inserted demo_god_rays item "${inserted}"`);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  assertNoErrors(errors, "AFTER INSERTING GOD RAYS (the shipped bug's exact trigger)");

  // ── 3. THE EVALUATED STATE MUST BE FINITE, not merely crash-free ────────────
  const evaluated = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const { state } = app.evalInfo(); // {state, errors} — the derivation-stage expression pass, app.svelte.js's own accessor
    const item = state.items[id];
    return { lightWorldX: item.lightWorldX, lightWorldY: item.lightWorldY };
  }, inserted);
  console.log(`  evaluated lightWorldX=${evaluated.lightWorldX} lightWorldY=${evaluated.lightWorldY}`);
  if (!Number.isFinite(evaluated.lightWorldX))
    throw new Error(`REGRESSION: lightWorldX evaluated to ${evaluated.lightWorldX} (non-finite) — the leading-"=" trap is back`);
  if (!Number.isFinite(evaluated.lightWorldY))
    throw new Error(`REGRESSION: lightWorldY evaluated to ${evaluated.lightWorldY} (non-finite) — the leading-"=" trap is back`);

  // NOTE ON THE "RED BOX": ports.js paints the failed-item affordance DIRECTLY into
  // the display list (core/paint_containment.errorAffordanceArgs) — a rectangle drawn
  // on the WebGL canvas, not a DOM element — so there is no queryable DOM marker to
  // assert against; a pixel-level red-box check belongs to a dedicated pixel probe,
  // not this one. What IS asserted, and is the earlier and sufficient failure point:
  // assertNoErrors above already fails on the equation-evaluation console.error
  // ("= expression result 560 is not a valid string value") that PRECEDES and CAUSES
  // the emit()-level throw ports.js would otherwise catch and paint red — reverting
  // the fix locally and re-running this probe reproduces exactly that console.error,
  // confirming this check is a real regression guard for the shipped defect.

  const canvas = await page.$(".canvas-wrap");
  if (!canvas) throw new Error("probe: .canvas-wrap not found after insert");
  console.log("  ok  inserted item renders with no page error and a finite light position");

  // ── 4. RELOAD — the working-copy model's autosave must recover the draft ───
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  assertNoErrors(errors, "AFTER RELOAD");

  const afterReload = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items ?? {};
    const { state } = app.evalInfo();
    const stillThere = id in items || Object.values(items).some((it) => it.type === "demo_god_rays");
    const godRaysId = id in items ? id : Object.keys(items).find((k) => items[k].type === "demo_god_rays");
    const item = godRaysId ? state.items[godRaysId] : null;
    return { stillThere, lightWorldX: item?.lightWorldX ?? null, lightWorldY: item?.lightWorldY ?? null };
  }, inserted);
  console.log(`  after reload: item present=${afterReload.stillThere}, lightWorldX=${afterReload.lightWorldX}, lightWorldY=${afterReload.lightWorldY}`);
  if (!afterReload.stillThere)
    throw new Error("probe: the god-rays item is gone after reload — the unsaved draft did not survive (autosave regression, unrelated to this fix but breaks the acceptance criterion)");
  if (!Number.isFinite(afterReload.lightWorldX) || !Number.isFinite(afterReload.lightWorldY))
    throw new Error(`REGRESSION AFTER RELOAD: lightWorldX=${afterReload.lightWorldX} lightWorldY=${afterReload.lightWorldY} — a reload must not resurrect the NaN`);

  console.log("\nOK god_rays_insert_probe — fresh insert renders, evaluated light position is finite, and it survives a reload");
} finally {
  await browser.close();
  await server.close();
}
