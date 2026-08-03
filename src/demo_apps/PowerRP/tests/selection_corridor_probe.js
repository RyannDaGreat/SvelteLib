/**
 * SELECTION CORRIDOR probe (WORKSTREAM NN) — boot the PowerRP editor headless,
 * select stroke widgets, and measure what the overlay ACTUALLY DRAWS.
 *
 * THE BUG THIS PINS, in the user's words: "selected arrows show nothing". Two
 * failures stacked. CanvasView's `outlines` filters on `capabilities.bbox` and the
 * whole arrow family is `bbox: false`, so a selected arrow got no outline at all.
 * And the box would have been useless anyway: a NEAR-VERTICAL arrow's ink rect is
 * ~zero-width, so its marquee degenerates to an invisible dashed hairline — which
 * is exactly what the user's screenshot showed, a lone vertical sliver plus the
 * midpoint bead. The fix runs the dash ALONG THE INK instead, tracing the
 * `morphPaths` payload the plugin already publishes.
 *
 * MEASURES PAINTED GEOMETRY, NOT CSS PRESENCE. Every assertion reads the SVG
 * overlay's real DOM — `getBBox()` on the rendered path, `getTotalLength()` and
 * `getPointAtLength()` — because "an element with class .selection-corridor
 * exists" is exactly the assertion that would have passed against a zero-width
 * sliver. The whole defect was a mark that was PRESENT and INVISIBLE.
 *
 * Proves, against the REAL app:
 *   - a near-vertical ARROW's corridor is painted, and its extent is SUBSTANTIALLY
 *     larger than the degenerate box sliver it replaces (the sliver's own width is
 *     computed from the widget's ink rect and compared against);
 *   - the corridor's stroke-width meets the theme's visibility floor, so a thin
 *     arrow still reads as selected rather than being a 1px dash;
 *   - a CURVED arrow's corridor FOLLOWS THE CURVE: its midpoint sits off the
 *     straight chord between its own endpoints by a real distance (a hull or chord
 *     approximation would put it ON the chord);
 *   - an ELBOW arrow's corridor follows the JOG — materially longer than the
 *     straight run between its endpoints;
 *   - the two indications are EXCLUSIVE: a selected arrow draws a corridor and no
 *     box marquee, while a selected RECT still draws its box and no corridor;
 *   - the AUDIT's over-reach case: an `svg` widget, whose default artwork contains
 *     an open stroked subpath, KEEPS its box — whether a box describes a widget
 *     cannot depend on the art loaded into it;
 *   - MULTI-SELECT draws a corridor for every stroke member.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/selection_corridor_probe.js
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

// Paths resolve off THIS file, never process.cwd() — the suite convention.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../web");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const browser = await launchBrowser();
const fails = [];
const checks = [];
const assert = (cond, label) => { checks.push([!!cond, label]); if (!cond) fails.push(`CHECK FAILED: ${label}`); };

// The corridor's visibility FLOOR, from web/app.css --a-selection-corridor-min-width.
// Restated here rather than read from the page because the point of the assertion is
// that the rendered stroke meets an independently-known minimum.
const MIN_CORRIDOR_WIDTH = 9;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  // A page error FAILS the probe. An exception inside a Svelte $effect wedges the
  // flush, so every later DOM read silently goes stale (the idiom the multiselect
  // probe records) — logging it as noise is how that symptom hides its cause.
  page.on("pageerror", (e) => { console.log("PAGEERROR " + e.message); fails.push(`page error: ${e.message}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  /**
   * Clear the deck and add ONE item of `type`, which addItem leaves selected.
   * SPREADS THE PLUGIN DEFAULTS: app.addItem stores exactly what it is handed and
   * missingDefaults only repairs at the LOAD boundary, so a hand-written arrow with
   * no strokeWidth reaches the canvas undefined and CanvasView throws inside an
   * $effect — which wedges the flush and makes every later DOM read stale. That is
   * the established idiom (tests/multiselect_inspector_probe.js records the two
   * debugging rounds it cost).
   */
  const only = async (type, over) => {
    const id = await page.evaluate((t, o) => {
      const app = window.__powerrp_app;
      app.selection = null; // a selection surviving clearDoc points at a dead item
      app.clearDoc();
      app.addItem({ ...app.registry.get(t).defaults, type: t, ...o });
      return app.selection;
    }, type, over);
    // WAIT FOR THE OVERLAY TO SETTLE, don't guess at it. A fixed sleep made this
    // probe FLAKE: `brace_curly` reported "0 paths" on one run and 1 path on the
    // next, from the same code, because the derived overlay had not flushed within
    // the deadline. A flaky probe is worse than no probe — it teaches readers to
    // discount a real red — so this polls for the mark the assertions are about to
    // measure instead. Widgets that legitimately draw NO corridor (rect, svg) fall
    // through the full timeout, which costs a moment and asserts the same thing.
    for (let i = 0; i < 20; i++) {
      if (await page.evaluate(() => document.querySelectorAll(".overlay .selection-corridor, .overlay polygon.selection").length > 0)) break;
      await sleep(100);
    }
    await sleep(150); // let a multi-path corridor finish arriving before it is counted
    return id;
  };

  /** The overlay's painted corridor paths: extent, stroke width, length, samples. */
  const corridors = () => page.evaluate(() => [...document.querySelectorAll(".overlay .selection-corridor")].map((el) => {
    const b = el.getBBox();
    const L = el.getTotalLength();
    const at = (d) => { const p = el.getPointAtLength(d); return { x: p.x, y: p.y }; };
    return { w: b.width, h: b.height, strokeWidth: parseFloat(getComputedStyle(el).strokeWidth), length: L, start: at(0), mid: at(L / 2), end: at(L) };
  }));

  /** Per-item BOX marquees (the multi-select collective frame is a different mark). */
  const boxMarquees = () => page.evaluate(() => document.querySelectorAll(".overlay polygon.selection:not(.multiselect-box)").length);

  /**
   * THE DEGENERATE SLIVER'S PAINTED AREA, in screen px² — the mark the box marquee
   * would have made. A dashed rect paints only its PERIMETER at the hairline
   * selection stroke, so its ink is perimeter × stroke width, and for a
   * near-vertical arrow that is a tall thin rectangle's outline: visually, the
   * hairline the user photographed.
   *
   * AREA, NOT WIDTH, is the honest comparison, and getting that wrong is worth
   * recording: an earlier version of this assertion compared the corridor's WIDTH
   * against the ink rect's WIDTH and failed at 12px vs 26px — because the ink rect
   * is as wide as the ARROWHEAD's flare while the shaft corridor is only as wide as
   * the shaft, even though the corridor is 300px TALL and unmistakably the larger
   * mark. Comparing one axis of two differently-shaped marks measures nothing; the
   * defect was never "too narrow", it was "too little ink to see".
   */
  const sliverInkArea = (id) => page.evaluate((itemId) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === itemId);
    const ink = n.plugin.localBounds(n.state);
    const zoom = app.viewport?.().zoom ?? 1;
    const w = ink.w * zoom, h = ink.h * zoom;
    const HAIRLINE = 1.5; // --a-selection-stroke
    return 2 * (w + h) * HAIRLINE;
  }, id);

  // ── 1. THE REPORTED BUG: a near-vertical arrow ────────────────────────────
  // 2px of horizontal run across 300px of vertical. Its ink rect is only as wide
  // as the stroke and arrowhead, so the box dash is the screenshot's sliver.
  const vId = await only("arrow", { from: { x: 300, y: 150 }, to: { x: 302, y: 450 } });
  const v = await corridors();
  assert(v.length > 0, "near-vertical ARROW: a selection corridor is painted (the bug: NOTHING was)");
  if (v.length) {
    // THE TASK'S CENTRAL MEASUREMENT: painted extent vs the sliver it replaces.
    // The corridor's ink is its arc length × its stroke width, summed over its paths.
    const sliver = await sliverInkArea(vId);
    const painted = v.reduce((a, c) => a + c.length * c.strokeWidth, 0);
    assert(painted > sliver * 2,
      `near-vertical ARROW: the corridor paints ${painted.toFixed(0)}px² of selection ink — over 2x the degenerate box sliver's ${sliver.toFixed(0)}px²`);
    const shaft = v.reduce((a, b) => (b.length > a.length ? b : a));
    assert(shaft.strokeWidth >= MIN_CORRIDOR_WIDTH,
      `near-vertical ARROW: corridor stroke-width ${shaft.strokeWidth}px meets the ${MIN_CORRIDOR_WIDTH}px floor — a hairline stroke still shows selection`);
    assert(shaft.h > 150, `near-vertical ARROW: the corridor spans the arrow's RUN (${shaft.h.toFixed(0)}px), which the box never reported`);
  }
  assert((await boxMarquees()) === 0, "near-vertical ARROW: NO box marquee alongside the corridor — the two indications are exclusive");

  // ── 2. THE CORRIDOR FOLLOWS CURVES, it does not cut the chord ─────────────
  await only("curved_arrow", { from: { x: 300, y: 500 }, to: { x: 700, y: 500 }, bend: 0.5 });
  const c = await corridors();
  assert(c.length > 0, "CURVED arrow: a selection corridor is painted");
  if (c.length) {
    const curve = c.reduce((a, b) => (b.length > a.length ? b : a));
    // The straight chord between the corridor's OWN endpoints. A hull or chord
    // approximation puts the midpoint on that line; a real curve-follower bulges.
    const chordMid = { x: (curve.start.x + curve.end.x) / 2, y: (curve.start.y + curve.end.y) / 2 };
    const bulge = Math.hypot(curve.mid.x - chordMid.x, curve.mid.y - chordMid.y);
    assert(bulge > 10, `CURVED arrow: corridor midpoint sits ${bulge.toFixed(1)}px OFF the chord — it follows the ARC, not a straight hull`);
  }

  // ── 3. AN ELBOW's JOG lengthens the corridor beyond the straight run ──────
  await only("elbow_arrow", { from: { x: 300, y: 600 }, to: { x: 600, y: 780 } });
  const e = await corridors();
  assert(e.length > 0, "ELBOW arrow: a selection corridor is painted");
  if (e.length) {
    const elbow = e.reduce((a, b) => (b.length > a.length ? b : a));
    const straight = Math.hypot(elbow.end.x - elbow.start.x, elbow.end.y - elbow.start.y);
    assert(elbow.length > straight * 1.05,
      `ELBOW arrow: corridor length ${elbow.length.toFixed(0)}px exceeds the straight run ${straight.toFixed(0)}px — it follows the JOG`);
  }

  // ── 4. THE AUDIT's other half: ordinary boxed widgets are LEFT ALONE ──────
  await only("rect", { x: 400, y: 300, w: 240, h: 160 });
  assert((await corridors()).length === 0, "RECT: no corridor — an ordinary boxed widget keeps its box marquee");
  assert((await boxMarquees()) > 0, "RECT: the box marquee is still drawn (the corridor did not replace it)");

  // The over-reach the audit caught: a first cut of the predicate admitted any boxed
  // widget with an OPEN subpath, which would have taken plugins/svg.js's correct box
  // away because its DEFAULT artwork happens to contain one stroked open path.
  await only("svg", { x: 400, y: 300, w: 160, h: 160 });
  assert((await corridors()).length === 0,
    "SVG: keeps its box — whether a box describes a widget cannot depend on the artwork loaded into it");

  // ── 5. THE OTHER STROKE WIDGETS the audit swept (one assertion each) ──────
  for (const [type, over] of [
    ["line", { from: { x: 300, y: 200 }, to: { x: 302, y: 500 } }],
    ["fancy_arrow", { from: { x: 300, y: 200 }, to: { x: 302, y: 500 } }],
    ["brace_curly", { from: { x: 300, y: 200 }, to: { x: 302, y: 500 } }],
    ["tangent_lines", {}],
  ]) {
    await only(type, over);
    const got = await corridors();
    const widest = got.length ? Math.max(...got.map((g) => Math.max(g.w, g.h))) : 0;
    assert(got.length > 0 && widest > MIN_CORRIDOR_WIDTH,
      `${type}: draws a visible corridor (${got.length} path(s), widest extent ${widest.toFixed(0)}px) — it drew nothing before`);
    assert((await boxMarquees()) === 0, `${type}: corridor only, no box marquee`);
  }

  // ── 6. MULTI-SELECT: a corridor for every stroke member ──────────────────
  const multiCount = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    const add = (t, o) => { app.addItem({ ...app.registry.get(t).defaults, type: t, ...o }); return app.selection; };
    const a = add("arrow", { from: { x: 300, y: 200 }, to: { x: 302, y: 500 } });
    const b = add("line", { from: { x: 500, y: 200 }, to: { x: 502, y: 500 } });
    // A multi-selection must go through selectMany — assigning an array to
    // app.selection does not register one (the multiselect probe's recorded idiom).
    app.selectMany([a, b]);
    return app.selectedIds().length;
  });
  await sleep(600);
  assert(multiCount === 2, `MULTI-SELECT: two stroke widgets selected (${multiCount})`);
  const multi = await corridors();
  assert(multi.length >= 2, `MULTI-SELECT: every stroke member draws its corridor (${multi.length} paths for 2 widgets)`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
console.log(`\n${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
if (fails.length) { for (const f of fails) console.error(f); process.exit(1); }
