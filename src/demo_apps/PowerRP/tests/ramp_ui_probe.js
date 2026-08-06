/**
 * RAMP-PROPERTY UI probe — boots the REAL PowerRP editor headless and drives the
 * generalized COLOUR RAMP (core/ramps.js, core/properties.js `ramp` bundle) on the
 * widget the user asked about: the Mandelbrot viewer's palette.
 *
 * WHAT IT PROVES, and why each one is the claim that mattered:
 *
 *   1. THE PALETTE IS THE GRADIENT CONTROL. The Inspector renders the palette as a
 *      LIST row with the SHARED preset library above it — the same control, the
 *      same 343 baked gradients, plus the six cyclic ramps. Before this it was a
 *      `select` over six hard-coded names and a comma-separated `text` box, and the
 *      library was mounted PRIVATELY by web/PaintField.svelte so no other property
 *      could have one.
 *
 *   2. HOVER PREVIEWS ON THE CANVAS, AND THE DOCUMENT DOES NOT MOVE. Pointing at a
 *      swatch repaints the FRACTAL — measured as canvas pixels, not as a swatch
 *      lighting up — while the document JSON stays BYTE-IDENTICAL. That is the
 *      manifest's hover doctrine ("the document is never mutated by hovering")
 *      measured rather than asserted.
 *
 *   3. LEAVING REVERTS EXACTLY. The canvas after pointerleave is byte-identical to
 *      the canvas before the hover — the font-picker probe's own bar (revert at
 *      mean-absolute-difference 0.000), here as an exact PNG compare.
 *
 *   4. THE TRANSIENT-PREVIEW SEAM IS NOT REOPENED. A sibling found a REAL bug: with
 *      one preview slot and no notion of a TRANSIENT preview, a click-away landing
 *      mid-hover COMMITTED the value the user had merely pointed at. So this asserts
 *      app.transientPreview is ARMED while hovering and CLEARED on leave and on
 *      pick, and that calling dropTransientPreview() mid-hover REVERTS rather than
 *      commits.
 *
 *   5. A SHARED GRADIENT PRESET RENDERS AS A PALETTE. Picking one of the 343
 *      gradient-family presets writes its stops, changes the fractal's pixels, and
 *      is EXACTLY ONE UNDO UNIT. And because a preset is a whole ramp VALUE, its
 *      ASPECTS land too: a gradient-family preset arrives clamped/sRGB, a
 *      cyclic-family one arrives looping/OKLab.
 *
 * Writes screenshots to POWERRP/.claude_vlm_checks/ramp_ui/.
 * Run from anywhere: node src/demo_apps/PowerRP/tests/ramp_ui_probe.js
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { RAMP_PRESET_FAMILIES } from "../web/ramp_preset_families.js";

// Paths resolve off THIS file, never process.cwd() (the suite convention, enforced
// by tests/probe_artifact_path_test.js).
const HERE = dirname(fileURLToPath(import.meta.url));
const powerrp = resolve(HERE, "..");
const webRoot = resolve(powerrp, "web");
const shots = resolve(powerrp, ".claude_vlm_checks/ramp_ui");
await mkdir(shots, { recursive: true });
const demoJson = await readFile(resolve(powerrp, "examples/demo.powerrp.json"), "utf8");

/** How long a mandelbrot repaint needs on this container's software GL before its
 *  pixels are worth comparing. Generous: the whole point of the pixel checks is
 *  that a frame is FINISHED, and a half-drawn frame would make a revert check
 *  flaky for a reason unrelated to the revert. */
const REPAINT_MS = 900;

// hmr: false — this probe drives a long stateful sequence and a hot update (any
// sibling's editor save) reloads the page mid-run (tests/list_ui_probe.js's own
// reason, measured there as "Execution context was destroyed").
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// The same stale-fixture boot-noise allowance the sibling probes document: other
// agents' in-flight fixture migrations, plus this container's headless graphics
// reality. Named specifically — anything else still fails the probe.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i, /mandelbrot: the reference orbit/];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
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
  await settle(700);
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  // ── Page helpers (the sibling probes' shapes, verbatim where shared) ────────
  const jsonEval = (fn, ...args) => page.evaluate(fn, ...args).then((s) => JSON.parse(s));
  const rawAt = (id, keys) => jsonEval((id, keys) => {
    let v = window.__powerrp_app.rawState().items?.[id];
    for (const k of keys) v = v?.[k];
    return JSON.stringify(v ?? null);
  }, id, keys);
  const stateAt = (id, keys) => jsonEval((id, keys) => {
    let v = window.__powerrp_app.state().items?.[id];
    for (const k of keys) v = v?.[k];
    return JSON.stringify(v ?? null);
  }, id, keys);
  /** A stable JSON snapshot of the whole document — what "the document did not
   *  move" and "exactly one undo unit" are measured against. Reference identity is
   *  useless: undo() restores an EQUAL document through a fresh reactive proxy. */
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));

  // ── The widget under test: a Mandelbrot viewer filling most of the canvas ───
  const id = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("demo_mandelbrot").defaults);
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 60], [["items", id, "y"], 60],
      [["items", id, "w"], 560], [["items", id, "h"], 400],
      // A cheap, shallow view: this container rasterizes the material on software
      // GL, and the pixel checks only need the palette to be legible.
      [["items", id, "zoomExponent"], 0.4], [["items", id, "centerX"], -0.6],
      [["items", id, "centerY"], 0], [["items", id, "maxIterations"], 180],
      [["items", id, "paletteScale"], 14],
    ]);
    app.commitPreview();
    return id;
  });
  // WAIT FOR THE CONTROL, do not guess at a settle: the palette row only exists
  // once the Inspector has rendered the new selection, and a fixed sleep that is
  // one frame short makes every check below fail for a reason that has nothing to
  // do with ramps.
  await page.waitForSelector(".ramp-presets-and-list .gradient-presets", { timeout: 10000 });
  await settle(REPAINT_MS);

  // ── (1) THE PALETTE IS THE GRADIENT CONTROL ────────────────────────────────
  ok(await page.evaluate(() => !!document.querySelector(".ramp-presets-and-list .gradient-presets")),
    "the palette row renders the SHARED preset library, mounted from the LIST DECLARATION");
  ok(await page.evaluate(() => {
    const presets = document.querySelector(".gradient-presets");
    const list = document.querySelector(".listfield");
    // DOCUMENT_POSITION_FOLLOWING (4): the list comes AFTER the library, and the
    // library is its SIBLING (not inside it), so `.listfield` still means the list.
    return !!(presets.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) && !list.contains(presets);
  }), "the library sits ABOVE the stop list and OUTSIDE it");
  ok(await page.evaluate(() => document.querySelectorAll(".listfield .list-el").length) === 8,
    "the default gold ramp lists its EIGHT stops through the general list control");
  ok(await page.evaluate(() => !document.querySelector('.inspector .row [aria-label*="Palette override" i]')),
    "the retired comma-separated `text` override row is GONE (it could not tween)");

  // Open the library and check BOTH families are there, from one shared home.
  await page.evaluate(() => {
    const t = document.querySelector(".gradient-presets-toggle");
    t.scrollIntoView({ block: "center" });
    t.click();
  });
  await settle(400);
  // THE FAMILIES ARE READ FROM web/ramp_preset_families.js, NOT PINNED AS A LIST
  // HERE. This probe used to hardcode "two families, 349 swatches" and both
  // assertions went red the day R7-19 added the colour maps — a false report of a
  // regression in a library that was working exactly as designed. What the probe
  // is actually for is that the grid is family-GROUPED, cyclic first, and that
  // every declared preset reaches the DOM from one shared home; asserting the
  // roster's contents here is the hand-maintained mirror this codebase names as
  // its worst defect. The roster's own count is asserted in its module's
  // doctests, where the roster lives.
  const families = await jsonEval(() => JSON.stringify([...document.querySelectorAll(".gradient-presets-family")].map((e) => e.textContent)));
  ok(families.length === RAMP_PRESET_FAMILIES.length && /Cyclic/.test(families[0]),
    `the grid is FAMILY-GROUPED, cyclic ramps first (${JSON.stringify(families)})`);
  const swatchCount = await page.evaluate(() => document.querySelectorAll(".gradient-swatch").length);
  const declared = RAMP_PRESET_FAMILIES.reduce((n, f) => n + f.presets.length, 0);
  ok(swatchCount === declared,
    `every declared preset is offered from ONE shared library: ${RAMP_PRESET_FAMILIES.map((f) => f.presets.length).join(" + ")} = ${swatchCount}`);
  await page.screenshot({ path: resolve(shots, "palette_library_open.png"), clip: await page.evaluate(() => {
    const r = document.querySelector(".ramp-presets-and-list").getBoundingClientRect();
    const PAD = 10;
    return { x: Math.max(0, Math.round(r.x) - PAD), y: Math.max(0, Math.round(r.y) - PAD), width: Math.round(r.width) + 2 * PAD, height: Math.round(r.height) + 2 * PAD };
  }) });

  // ── Canvas pixel helpers ───────────────────────────────────────────────────
  // Clip to THE WIDGET, intersected with the canvas — not the whole canvas: a
  // pixel compare over the panels would photograph the Inspector's own hover state
  // and call it a fractal repaint. (tests/list_ui_probe.js's own gradient-rect
  // clipping, same reason.)
  const canvasClip = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(60, 60);
    const e = app.canvasActions.worldToScreen(60 + 560, 60 + 400);
    const c = document.querySelector("canvas").getBoundingClientRect();
    const x0 = Math.max(Math.round(Math.min(s.x, e.x)), Math.round(c.x));
    const y0 = Math.max(Math.round(Math.min(s.y, e.y)), Math.round(c.y));
    const x1 = Math.min(Math.round(Math.max(s.x, e.x)), Math.round(c.x + c.width));
    const y1 = Math.min(Math.round(Math.max(s.y, e.y)), Math.round(c.y + c.height));
    if (!(x1 > x0 && y1 > y0)) throw new Error("the mandelbrot widget is not visible on the canvas — nothing to compare");
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  });
  const shootCanvas = async (name) => {
    await settle(REPAINT_MS);
    const buf = await page.screenshot({ clip: canvasClip });
    await writeFile(resolve(shots, `${name}.png`), buf);
    return buf;
  };
  /** Dispatches a real pointerenter on the Nth swatch (the handler is onpointerenter). */
  const hoverSwatch = (index) => page.evaluate((index) => {
    const s = document.querySelectorAll(".gradient-swatch")[index];
    if (!s) throw new Error(`no .gradient-swatch at ${index}`);
    s.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  }, index);
  const leaveGrid = () => page.evaluate(() => {
    document.querySelector(".gradient-presets-grid").dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
  });
  const swatchName = (index) => page.evaluate((index) => document.querySelectorAll(".gradient-swatch")[index].getAttribute("aria-label"), index);
  const transientArmed = () => page.evaluate(() => window.__powerrp_app.transientPreview !== null);

  // ── (2) + (3) HOVER PREVIEWS ON THE CANVAS; THE DOCUMENT DOES NOT MOVE ─────
  const beforeHoverDoc = await docJson();
  const beforeHoverPixels = await shootCanvas("canvas_before_hover_gold");

  // A CYCLIC-family swatch (index 2 = the third cyclic ramp) — visibly unlike gold.
  const hoveredName = await swatchName(2);
  await hoverSwatch(2);
  const hoveredPixels = await shootCanvas("canvas_hovering_preset");
  ok(!hoveredPixels.equals(beforeHoverPixels),
    `HOVERING "${hoveredName}" REPAINTS THE FRACTAL — the preview lands on the CANVAS, not merely in the dropdown`);
  ok(await docJson() === beforeHoverDoc,
    "and the DOCUMENT IS BYTE-IDENTICAL while hovering (a hover that commits is a bug)");
  ok(await transientArmed(),
    "the hover ARMS app.transientPreview, so a dismissal path that commits the staged preview reverts instead");

  await leaveGrid();
  const afterLeavePixels = await shootCanvas("canvas_after_leave");
  ok(afterLeavePixels.equals(beforeHoverPixels),
    `LEAVING REVERTS EXACTLY — the canvas is byte-identical to before the hover (${afterLeavePixels.length} vs ${beforeHoverPixels.length} bytes)`);
  ok(await docJson() === beforeHoverDoc, "and the document never moved at all");
  ok(!await transientArmed(), "leaving DISARMS the transient preview");

  // ── (4) THE TRANSIENT SEAM: dropTransientPreview REVERTS, never commits ────
  await hoverSwatch(4);
  await settle(200);
  ok(await transientArmed(), "armed again on a second hover");
  await page.evaluate(() => window.__powerrp_app.dropTransientPreview());
  const afterDropPixels = await shootCanvas("canvas_after_drop_transient");
  ok(await docJson() === beforeHoverDoc,
    "dropTransientPreview() mid-hover REVERTS the pointed-at preset instead of committing it (the font-picker bug, not reopened)");
  ok(afterDropPixels.equals(beforeHoverPixels), "and the canvas is back to what the document actually holds");

  // ── (5) A SHARED GRADIENT PRESET RENDERS AS A PALETTE, in one undo unit ────
  // THE INDEX IS DERIVED, NOT COUNTED. It used to be the literal 6 ("6 cyclic
  // ramps precede it"), which silently became a COLOUR MAP when R7-19 inserted a
  // family between them — and the assertion below then reported oklab as a defect
  // when it was the picked preset's own correct aspect. The gradients are the
  // presets the user called beautiful and they are what this check is about, so
  // the probe asks the roster where they start.
  const gradientIndex = RAMP_PRESET_FAMILIES
    .slice(0, RAMP_PRESET_FAMILIES.findIndex((f) => f.id === "gradients"))
    .reduce((n, f) => n + f.presets.length, 0);
  const gradientName = await swatchName(gradientIndex);
  const beforePickDoc = await docJson();
  await hoverSwatch(gradientIndex);
  await page.evaluate((i) => document.querySelectorAll(".gradient-swatch")[i].click(), gradientIndex);
  const pickedPixels = await shootCanvas("canvas_gradient_preset_applied");
  const stops = await rawAt(id, ["rampStops"]);
  ok(Array.isArray(stops) && stops.length >= 2 && stops.every((s) => typeof s.offset === "number" && /^#/.test(s.color)),
    `picking "${gradientName}" wrote a real stop list (${JSON.stringify(stops).slice(0, 120)})`);
  ok(!pickedPixels.equals(beforeHoverPixels),
    "A SHARED GRADIENT PRESET RENDERS AS A MANDELBROT PALETTE — the fractal's pixels changed");
  ok(!await transientArmed(), "picking DISARMS the transient preview (the commit is the user's choice, not a revert target)");
  // A preset is a whole ramp VALUE, so its aspects travel with it.
  ok(await stateAt(id, ["rampLoop"]) === false && await stateAt(id, ["rampSpace"]) === "srgb",
    `a GRADIENT-family preset lands clamped + sRGB, as it was authored (loop=${await stateAt(id, ["rampLoop"])}, space=${await stateAt(id, ["rampSpace"])})`);

  // EXACTLY ONE UNDO UNIT for the whole pick (stops + both aspects).
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle(200);
  ok(await docJson() === beforePickDoc, "applying a preset is EXACTLY ONE undo unit — stops and aspects together (JSON compare)");
  await page.evaluate(() => window.__powerrp_app.redo());
  await settle(200);

  // A CYCLIC-family preset lands looping + OKLab, from the same one control.
  await page.evaluate(() => {
    const t = document.querySelector(".gradient-presets-toggle");
    if (t.getAttribute("aria-expanded") !== "true") t.click();
  });
  await settle(350);
  const cyclicName = await swatchName(1);
  await page.evaluate(() => document.querySelectorAll(".gradient-swatch")[1].click());
  await settle(300);
  ok(await stateAt(id, ["rampLoop"]) === true && await stateAt(id, ["rampSpace"]) === "oklab",
    `a CYCLIC-family preset ("${cyclicName}") lands looping + OKLab — the domain knowledge travels with the DATA`);
  await shootCanvas("canvas_cyclic_preset_applied");

  ok(liveErrors.length === 0, `no console errors during the run (${JSON.stringify(liveErrors.slice(0, 3))})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "  ok  " : "  NOT OK  "}${label}`);
console.log(`\n${checks.filter(([p]) => p).length}/${checks.length} ramp UI checks passed — shots in .claude_vlm_checks/ramp_ui/`);
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
