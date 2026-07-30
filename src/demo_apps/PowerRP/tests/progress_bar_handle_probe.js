/**
 * PROGRESS BAR HANDLE PROBE — the browser half of the progress-bar fix.
 *
 * The bare-node suite (tests/progress_bar_plugin_test.mjs) proves the GEOMETRY and
 * the handle's constrain/apply contract as pure functions. This probe proves the
 * parts that only exist once the real editor is running, and that a pure test
 * structurally cannot reach:
 *
 *   1. The widget REGISTERS and INSTANTIATES from the built-in plugin-asset
 *      library in a live app. A plugin asset is compiled in a jail at load, so a
 *      source that emits a `path` op it never emitted before is exactly the kind
 *      of change that registers fine and then throws at first paint.
 *   2. The handle is REACHABLE BY MOUSE. It is not enough that modifierPoints()
 *      returns a point: the app has to publish it into world space, draw it, and
 *      route a pointerdown on it into a drag. So this probe finds the handle's
 *      REAL DOM ELEMENT (CanvasView draws each modifier point as `rect.modifier`)
 *      and drives genuine mouse events at its on-screen position — the user's
 *      path, not a shortcut through the app object.
 *   3. The committed DOCUMENT changed, and changed to the value the drag denotes
 *      — not a live preview that never lands.
 *   4. The fill FOLLOWS. A handle that moves without repainting is the classic
 *      half-wired handle, and it looks correct in a screenshot taken at the wrong
 *      moment.
 *   5. The property still takes a TYPED value afterwards. The handle is a
 *      SURFACING of `fraction`, not a second store; if a drag broke the Inspector
 *      path, keyframes and `=` bindings would silently diverge from it.
 *   6. It renders at 1% with no error, and leaves screenshots for human eyes. The
 *      reported symptom was visual ("looks a little bit weird"), so the last word
 *      belongs to a picture.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), the
 * text_undo_probe.js pattern. Run from POWERRP or the SvelteLib root.
 * Screenshots land in .claude_logs/progress_bar_probe/.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shotDir = resolve(HERE, "../../../../.claude_logs/progress_bar_probe");
mkdirSync(shotDir, { recursive: true });

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The bar in the test document: wide, short, fully rounded (r = h/2, a pill),
 *  which is the shape the user's screenshot showed the defect on. */
const BAR = { x: 120, y: 200, w: 600, h: 40, r: 20 };
/** Where the drag lands. 0.6 is far from both ends and from the start value, so a
 *  handle that silently snapped to either end would fail rather than coincide. */
const DRAG_TO = 0.6;
/** The fraction the bar starts at — the reported "low progress" case. */
const START_FRACTION = 0.01;
/** A drag lands within a pixel or two of its target once the world→screen round
 *  trip and the pointer's integer coordinates are accounted for; as a fraction of
 *  a 600-unit track that is well under a percent. */
const DRAG_TOLERANCE = 0.02;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Frontend-only Vite (no server.py), so best-effort thumbnail/asset POSTs 404.
  // Orthogonal to this widget — the text_undo_probe.js precedent.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ── 1. the widget registers and instantiates ───────────────────────────────
  const registered = await page.evaluate(() => !!window.__powerrp_app.registry.get("progress_bar"));
  assert(registered, "progress_bar registers from the built-in plugin-asset library");
  if (!registered) throw new Error("progress_bar did not register — nothing further is meaningful");

  await page.evaluate(({ BAR, START_FRACTION }) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const bar = {
      ...def("progress_bar"), name: "Bar", active: true, z: 1,
      x: BAR.x, y: BAR.y, w: BAR.w, h: BAR.h, cornerRadius: BAR.r,
      fraction: START_FRACTION, trackColor: "#3a3a48", fillColor: "#7aa2f7",
    };
    const doc = { meta: { name: "progress-bar-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, bar } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, { BAR, START_FRACTION });
  await sleep(600);

  const barId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "progress_bar");
  });
  assert(!!barId, "a progress_bar item exists in the committed document");

  /** Query. The item's COMMITTED fraction (the document, not a preview). */
  const fractionOf = () => page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].fraction, barId);

  /** Query. The widget's live fill path `d`, straight off the derived node — the
   *  same emit() the painter runs, so this is what is actually on screen. */
  const fillPathD = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === id);
    const ops = app.registry.get("progress_bar").emit(node.state, null, node.world);
    return (ops.find((o) => o.op === "path") ?? {}).d ?? null;
  }, barId);

  /** Pure function. The x/y extent of an M/L/Z path's vertices. */
  const extent = (d) => {
    const pts = [...d.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const xs = pts.map(([x]) => x), ys = pts.map(([, y]) => y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), spanY: Math.max(...ys) - Math.min(...ys) };
  };

  // ── 2. it paints at 1% with no error, and the fill is SEATED, not floating ──
  assert(errors.length === 0, `instantiating + painting the bar at fraction ${START_FRACTION} raises no error`);
  const lowD = await fillPathD();
  assert(lowD !== null, "at 1% the bar emits a fill path");
  await page.screenshot({ path: resolve(shotDir, "fill_01pct.png") });

  // The visual claim stated mechanically, so the screenshot confirms rather than
  // discovers: at 1% the fill starts ON the left cap, stops at the 1% cut, and is
  // PINCHED by the cap's curve (shorter than the track) — precisely the three
  // things the old floating pill got wrong.
  const lowExt = extent(lowD);
  assert(lowExt.minX <= 0.001, `at 1% the fill starts ON the left cap (minX=${lowExt.minX})`);
  assert(lowExt.maxX <= BAR.w * START_FRACTION + 0.001, `at 1% the fill ends at the cut (maxX=${lowExt.maxX}, cut=${BAR.w * START_FRACTION})`);
  assert(lowExt.spanY < BAR.h, `at 1% the fill is pinched by the cap's curve, not full height (spanY=${lowExt.spanY} < ${BAR.h})`);

  // ── 3. the handle exists IN THE DOM and is grabbable by mouse ──────────────
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, barId);
  await sleep(500);

  const declared = await page.evaluate(() => window.__powerrp_app.handles().map((h) => h.id));
  assert(declared.length === 1 && declared[0] === "fraction", `the widget publishes exactly one handle, "fraction" (got ${JSON.stringify(declared)})`);

  /** Query. The on-screen center of THE handle's DOM element. CanvasView draws a
   *  modifier point as `rect.modifier`; going through the element (rather than
   *  recomputing world→screen here) is what makes this a test of the wiring. */
  const handleBox = async () => {
    const el = await page.$("rect.modifier");
    if (!el) return null;
    const b = await el.boundingBox();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  };
  const start = await handleBox();
  assert(start !== null, "the handle is DRAWN as a grabbable element on the canvas overlay");
  if (!start) throw new Error("no rect.modifier in the DOM — the handle is not reachable by mouse");

  const before = await fractionOf();
  assert(Math.abs(before - START_FRACTION) < 1e-9, `starts at fraction ${START_FRACTION} (got ${before})`);

  /** Command. Writes `fraction` through the INSPECTOR's path (setPreview +
   *  commitPreview — Inspector.svelte commitField), i.e. the same seam a typed
   *  number or an equation edit goes through. */
  const setFraction = async (f) => {
    await page.evaluate(({ id, f }) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "fraction"], f]]);
      app.commitPreview();
    }, { id: barId, f });
    await sleep(450);
  };

  // CALIBRATION, not an assumption about zoom: move the handle a KNOWN fraction
  // through the property, measure how far its element travelled, and derive the
  // screen pixels per unit fraction. The drag below is then expressed in the
  // view's real units whatever the zoom happens to be.
  await setFraction(0.5);
  const halfBox = await handleBox();
  const pxPerFraction = (halfBox.x - start.x) / (0.5 - START_FRACTION);
  assert(pxPerFraction > 0, `the handle moves right as fraction grows (${pxPerFraction.toFixed(1)} px per unit fraction)`);

  // Put it back to the low value and drag for real.
  await setFraction(START_FRACTION);

  const from = await handleBox();
  const to = { x: from.x + pxPerFraction * (DRAG_TO - START_FRACTION), y: from.y };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Several intermediate moves: one jump can fall foul of the click-vs-drag slop
  // threshold and register as a click that selects the handle without moving it.
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y, { steps: 1 });
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(600);

  // ── 4. the drag committed, to the value it denotes ─────────────────────────
  const after = await fractionOf();
  assert(after !== START_FRACTION, `dragging the handle CHANGED the committed fraction (${START_FRACTION} -> ${after})`);
  assert(Math.abs(after - DRAG_TO) < DRAG_TOLERANCE, `the drag wrote the fraction it denotes: ~${DRAG_TO} (got ${after})`);
  assert(after >= 0 && after <= 1, `the written fraction stays in 0..1 (got ${after})`);

  // ── 5. the fill FOLLOWS the handle ─────────────────────────────────────────
  const highExt = extent(await fillPathD());
  assert(highExt.maxX > lowExt.maxX, `the fill grew with the handle (${lowExt.maxX} -> ${highExt.maxX})`);
  assert(Math.abs(highExt.maxX - BAR.w * after) < 0.01, `the fill's leading edge is at fraction x (${highExt.maxX} vs ${BAR.w * after})`);
  assert(highExt.minX <= 0.001, "the fill still hugs the left cap after the drag");
  assert(Math.abs(highExt.spanY - BAR.h) < 0.01, "past the corner radius the fill is full height");
  await page.screenshot({ path: resolve(shotDir, `fill_${Math.round(after * 100)}pct.png`) });

  // The handle REDRAWS where the drag left it (a stale handle is a half-wired one).
  const settled = await handleBox();
  assert(Math.abs(settled.x - to.x) < Math.abs(pxPerFraction) * DRAG_TOLERANCE * 2,
    `the handle redraws at the dragged position (${settled.x.toFixed(1)} vs ${to.x.toFixed(1)} px)`);

  // ── 6. typing/equations still drive the SAME property ─────────────────────
  await setFraction(0.25);
  const typed = await fractionOf();
  assert(Math.abs(typed - 0.25) < 1e-9, `setting fraction through the Inspector path still works after a drag (got ${typed})`);
  const typedExt = extent(await fillPathD());
  assert(Math.abs(typedExt.maxX - BAR.w * 0.25) < 0.01, "and the fill follows the typed value too");
  const typedHandle = await handleBox();
  assert(typedHandle !== null, "the handle is still drawn after a typed edit");
  await page.screenshot({ path: resolve(shotDir, "fill_25pct.png") });

  // ── the zero case, end to end: no ink, but still a grab point ─────────────
  await setFraction(0);
  assert((await fillPathD()) === null, "at fraction 0 the widget emits NO fill ink at all");
  const zeroHandle = await handleBox();
  assert(zeroHandle !== null, "...and the handle is STILL grabbable at the track's left cap");
  await page.screenshot({ path: resolve(shotDir, "fill_00pct.png") });

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nPROGRESS BAR HANDLE PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log(`\nPROGRESS BAR HANDLE PROBE PASSED — fill clips to the track at 1%, the handle drags to set fraction, the fill follows.\nScreenshots: ${shotDir}`);
} finally {
  await browser.close();
  await server.close();
}
