/**
 * SELECTION INK DASH probe (WORKSTREAM NN, rendering per SS) — boot the PowerRP
 * editor headless, select stroke widgets, and measure what the overlay ACTUALLY
 * DRAWS.
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
 * ── HALF THIS FILE'S ASSERTIONS WERE INVERTED BY WORKSTREAM SS ──────────────────
 * NN's first RENDERING of that dash inflated each subpath into a band — the painted
 * stroke's width plus a clearance, floored at 9px — and this probe pinned exactly
 * that: a `>= 9px` stroke-width floor, and a painted-AREA comparison whose whole
 * premise was "more ink than the sliver". The user's ruling killed the band: "it
 * looks fucking hideous… it turns all fuzzy and thick… That doesn't look like a
 * dashed line to me… I was just hoping for a single line, a single dashed line that
 * connects the two points."
 *
 * So the FLOOR pin is now a CEILING pin, and that inversion is the point: a mark
 * whose job is to be the box marquee in a different SHAPE must be no heavier than
 * the box marquee, so the assertion reads the RECT's own painted stroke-width off
 * the same page and requires the dash not to exceed it. Written that way rather
 * than against the literal 1.5px, so a retheme of --a-selection-stroke moves both
 * marks together and this check keeps meaning "these two are one system" instead of
 * going stale. The painted-area assertion is GONE outright — it measured the slab.
 *
 * MEASURES PAINTED GEOMETRY, NOT CSS PRESENCE. Every assertion reads the SVG
 * overlay's real DOM — `getBBox()` on the rendered path, `getTotalLength()` and
 * `getPointAtLength()` — because "an element with class .selection-ink-dash
 * exists" is exactly the assertion that would have passed against a zero-width
 * sliver. The whole original defect was a mark that was PRESENT and INVISIBLE.
 *
 * Proves, against the REAL app:
 *   - a near-vertical ARROW's ink dash is painted at all, and SPANS THE ARROW'S RUN
 *     — the reach the degenerate box never reported;
 *   - IT IS A HAIRLINE, no heavier than the box marquee's own painted stroke (the
 *     SS pin: the slab cannot come back);
 *   - it is DASHED, not solid — a real stroke-dasharray on the rendered element;
 *   - closed subpaths (arrowheads, fancy_arrow's silhouette) are OUTLINED, never
 *     filled;
 *   - a CURVED arrow's dash FOLLOWS THE CURVE: its midpoint sits off the straight
 *     chord between its own endpoints by a real distance (a hull or chord
 *     approximation would put it ON the chord);
 *   - an ELBOW arrow's dash follows the JOG — materially longer than the straight
 *     run between its endpoints;
 *   - the two indications are EXCLUSIVE: a selected arrow draws an ink dash and no
 *     box marquee, while a selected RECT still draws its box and no ink dash;
 *   - the AUDIT's over-reach case: an `svg` widget, whose default artwork contains
 *     an open stroked subpath, KEEPS its box — whether a box describes a widget
 *     cannot depend on the art loaded into it;
 *   - MULTI-SELECT draws an ink dash for every stroke member.
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

// The minimum PAINTED EXTENT (px, either axis) a mark must have to count as
// visible. Not a theme number — a floor on the bounding box of what got drawn, so
// "a path element exists" cannot pass for "something is on screen". Well under any
// of the widget geometries this file authors (all ~300px runs) and well over the
// zero-extent degenerate that would mean nothing rendered.
const VISIBLE_EXTENT_PX = 20;

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
    // The overlay's mark count BEFORE this widget replaces the deck — the baseline
    // the settle loop below watches for a change against (see its comment).
    const before = await page.evaluate(() => document.querySelectorAll(".overlay .selection-ink-dash, .overlay polygon.selection").length);
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
    // discount a real red.
    //
    // POLLING FOR "A MARK EXISTS" WAS NOT ENOUGH, and the reason is worth writing
    // down because the fix looks like it should have worked: the PREVIOUS widget's
    // mark is still in the DOM when this loop starts, so the very first iteration
    // saw it, broke immediately, and the 150ms below was again a guess. `line`
    // reported 0 paths on one run under exactly that. So the wait is now for the
    // overlay to CHANGE — it records what was there before clearDoc and polls until
    // the count differs — which for a widget that draws N marks after one that drew
    // M ≠ N settles on the real answer. Where M happens to equal N the loop falls
    // through to the timeout, which is the honest fixed wait and no worse than
    // before. Widgets that legitimately draw NO ink dash (rect, svg) do the same.
    for (let i = 0; i < 30; i++) {
      const now = await page.evaluate(() => document.querySelectorAll(".overlay .selection-ink-dash, .overlay polygon.selection").length);
      if (now !== before) break;
      await sleep(100);
    }
    await sleep(200); // let a multi-path dash finish arriving before it is counted
    return id;
  };

  /**
   * The overlay's painted ink-dash paths: extent, stroke width, dash pattern, fill,
   * length and three samples along it. `fill` and `dasharray` are read as COMPUTED
   * style off the rendered element, because the SS ruling is about how the mark
   * LOOKS — a class name proves nothing about whether it came out solid or filled.
   */
  const inkDashes = () => page.evaluate(() => [...document.querySelectorAll(".overlay .selection-ink-dash")].map((el) => {
    const cs = getComputedStyle(el);
    const b = el.getBBox();
    const L = el.getTotalLength();
    const at = (d) => { const p = el.getPointAtLength(d); return { x: p.x, y: p.y }; };
    return {
      w: b.width, h: b.height, length: L,
      strokeWidth: parseFloat(cs.strokeWidth),
      dasharray: cs.strokeDasharray,
      fill: cs.fill,
      closed: (el.getAttribute("d") || "").trimEnd().endsWith("Z"),
      start: at(0), mid: at(L / 2), end: at(L),
    };
  }));

  /** Per-item BOX marquees (the multi-select collective frame is a different mark). */
  const boxMarquees = () => page.evaluate(() => document.querySelectorAll(".overlay polygon.selection:not(.multiselect-box)").length);

  /** The RECT marquee's own painted stroke-width — the reference the ink dash must
   *  not exceed. Read off the live page rather than restated as 1.5, so a retheme
   *  moves both marks together and this stays an "are these one system?" check. */
  const marqueeStrokeWidth = () => page.evaluate(() => {
    const el = document.querySelector(".overlay polygon.selection:not(.multiselect-box)");
    return el ? parseFloat(getComputedStyle(el).strokeWidth) : null;
  });

  // ── 1. THE BOX MARQUEE'S OWN WEIGHT, measured first so every later assertion
  // can compare against it. A rect is the canonical boxed widget.
  await only("rect", { x: 400, y: 300, w: 240, h: 160 });
  const MARQUEE_WIDTH = await marqueeStrokeWidth();
  assert(Number.isFinite(MARQUEE_WIDTH) && MARQUEE_WIDTH > 0,
    `RECT: the box marquee paints a measurable stroke (${MARQUEE_WIDTH}px) — the reference every ink dash is held to`);
  assert((await inkDashes()).length === 0, "RECT: no ink dash — an ordinary boxed widget keeps its box marquee");
  assert((await boxMarquees()) > 0, "RECT: the box marquee is still drawn (the ink dash did not replace it)");

  // ── 2. THE REPORTED BUG: a near-vertical arrow ────────────────────────────
  // 2px of horizontal run across 300px of vertical. Its ink rect is only as wide
  // as the stroke and arrowhead, so the box dash is the screenshot's sliver.
  await only("arrow", { from: { x: 300, y: 150 }, to: { x: 302, y: 450 } });
  const v = await inkDashes();
  assert(v.length > 0, "near-vertical ARROW: a selection ink dash is painted (the bug: NOTHING was)");
  if (v.length) {
    const shaft = v.reduce((a, b) => (b.length > a.length ? b : a));
    // THE INDICATION IS PRESENT AND REPORTS THE REACH the box never did.
    assert(shaft.h > 150, `near-vertical ARROW: the dash spans the arrow's RUN (${shaft.h.toFixed(0)}px), which the box never reported`);
    // THE SS PIN, and the inversion of NN's floor: no heavier than the marquee.
    // User: "it turns all fuzzy and thick… I was just hoping for a single line."
    // Every path, not just the shaft — an arrowhead contour drawn fat is the same
    // defect on a smaller mark.
    const heaviest = Math.max(...v.map((p) => p.strokeWidth));
    assert(heaviest <= MARQUEE_WIDTH,
      `near-vertical ARROW: every ink-dash stroke is ${heaviest}px, no heavier than the marquee's ${MARQUEE_WIDTH}px — a HAIRLINE, not the rejected slab`);
    // DASHED, NOT SOLID. "That doesn't look like a dashed line to me."
    assert(/\d/.test(shaft.dasharray) && shaft.dasharray !== "none",
      `near-vertical ARROW: the dash really is dashed (stroke-dasharray "${shaft.dasharray}"), not a solid casing`);
    // CLOSED SUBPATHS ARE OUTLINED, NEVER FILLED — the arrowhead contour.
    assert(v.every((p) => p.fill === "none"),
      "near-vertical ARROW: every subpath is fill:none — closed arrowhead contours are OUTLINED, never shaded");
  }
  assert((await boxMarquees()) === 0, "near-vertical ARROW: NO box marquee alongside the ink dash — the two indications are exclusive");

  // ── 3. THE DASH FOLLOWS CURVES, it does not cut the chord ─────────────────
  await only("curved_arrow", { from: { x: 300, y: 500 }, to: { x: 700, y: 500 }, bend: 0.5 });
  const c = await inkDashes();
  assert(c.length > 0, "CURVED arrow: a selection ink dash is painted");
  if (c.length) {
    const curve = c.reduce((a, b) => (b.length > a.length ? b : a));
    // The straight chord between the dash's OWN endpoints. A hull or chord
    // approximation puts the midpoint on that line; a real curve-follower bulges.
    const chordMid = { x: (curve.start.x + curve.end.x) / 2, y: (curve.start.y + curve.end.y) / 2 };
    const bulge = Math.hypot(curve.mid.x - chordMid.x, curve.mid.y - chordMid.y);
    assert(bulge > 10, `CURVED arrow: dash midpoint sits ${bulge.toFixed(1)}px OFF the chord — it follows the ARC, not a straight hull`);
  }

  // ── 4. AN ELBOW's JOG lengthens the dash beyond the straight run ──────────
  await only("elbow_arrow", { from: { x: 300, y: 600 }, to: { x: 600, y: 780 } });
  const e = await inkDashes();
  assert(e.length > 0, "ELBOW arrow: a selection ink dash is painted");
  if (e.length) {
    const elbow = e.reduce((a, b) => (b.length > a.length ? b : a));
    const straight = Math.hypot(elbow.end.x - elbow.start.x, elbow.end.y - elbow.start.y);
    assert(elbow.length > straight * 1.05,
      `ELBOW arrow: dash length ${elbow.length.toFixed(0)}px exceeds the straight run ${straight.toFixed(0)}px — it follows the JOG`);
  }

  // ── 5. THE AUDIT's over-reach case ────────────────────────────────────────
  // A first cut of the predicate admitted any boxed widget with an OPEN subpath,
  // which would have taken plugins/svg.js's correct box away because its DEFAULT
  // artwork happens to contain one stroked open path.
  await only("svg", { x: 400, y: 300, w: 160, h: 160 });
  assert((await inkDashes()).length === 0,
    "SVG: keeps its box — whether a box describes a widget cannot depend on the artwork loaded into it");

  // ── 6. THE OTHER STROKE WIDGETS the audit swept ───────────────────────────
  // fancy_arrow is the CLOSED-silhouette member and carries the outlined-not-filled
  // pin for its own kind: its whole payload is a closed contour, so if any widget
  // were going to come out as a filled blue blob it is this one.
  for (const [type, over] of [
    ["line", { from: { x: 300, y: 200 }, to: { x: 302, y: 500 } }],
    ["fancy_arrow", { from: { x: 300, y: 200 }, to: { x: 302, y: 500 } }],
    ["brace_curly", { from: { x: 300, y: 200 }, to: { x: 302, y: 500 } }],
    ["tangent_lines", {}],
  ]) {
    await only(type, over);
    const got = await inkDashes();
    const widest = got.length ? Math.max(...got.map((g) => Math.max(g.w, g.h))) : 0;
    assert(got.length > 0 && widest > VISIBLE_EXTENT_PX,
      `${type}: draws a visible ink dash (${got.length} path(s), widest extent ${widest.toFixed(0)}px) — it drew nothing before`);
    if (got.length) {
      const heaviest = Math.max(...got.map((g) => g.strokeWidth));
      assert(heaviest <= MARQUEE_WIDTH,
        `${type}: hairline at ${heaviest}px, no heavier than the marquee's ${MARQUEE_WIDTH}px`);
      assert(got.every((g) => g.fill === "none"),
        `${type}: fill:none on every subpath — outlined, never shaded`);
      assert(got.every((g) => /\d/.test(g.dasharray) && g.dasharray !== "none"),
        `${type}: every subpath is dashed, not solid`);
    }
    assert((await boxMarquees()) === 0, `${type}: ink dash only, no box marquee`);
  }

  // fancy_arrow's payload is ALL-CLOSED, so the outlined-not-filled law above was
  // exercised on a real silhouette rather than only on arrowhead contours. Assert
  // that explicitly so a payload change cannot quietly retire the coverage.
  await only("fancy_arrow", { from: { x: 300, y: 200 }, to: { x: 302, y: 500 } });
  const fancy = await inkDashes();
  assert(fancy.length > 0 && fancy.every((p) => p.closed),
    `FANCY_ARROW: its dash is a CLOSED silhouette (${fancy.filter((p) => p.closed).length}/${fancy.length} paths) — the case where "filled" would be most tempting`);

  // ── 7. ZOOM: THE HAIRLINE HOLDS ITS WEIGHT ────────────────────────────────
  // The other half of the SS ruling. NN's width consulted viewport.zoom, so the
  // user's zoomed screenshot showed the casing fattening against the art; the box
  // marquee never did, because the overlay is an SVG in SCREEN coordinates and its
  // stroke-width is screen px. This asserts the ink dash now shares that mechanism:
  // zoom 4x and the painted stroke is UNCHANGED, while the mark itself grows (the
  // geometry really did rescale — otherwise an inert overlay would pass this too).
  await only("arrow", { from: { x: 300, y: 150 }, to: { x: 302, y: 450 } });
  const beforeZoom = await inkDashes();
  const ZOOM_FACTOR = 4;
  // The established idiom (tests/pdf_reraster_vlm.js, scene3d_zoom_probe.js):
  // canvasActions.setViewport is the seam. The pan is recomputed to hold the same
  // world point at the overlay's centre, so the zoomed dash stays ON SCREEN — a
  // scale-only change would push a 300px arrow out of a 1600x1000 viewport and the
  // extent assertion would measure clipping instead of scaling.
  await page.evaluate((z) => {
    const app = window.__powerrp_app;
    const a = app.canvasActions;
    if (!a) throw new Error("canvasActions absent — the canvas never bound");
    const v = app.lastViewport ?? { zoom: 1, panX: 0, panY: 0 };
    const o = document.querySelector(".overlay").getBoundingClientRect();
    // The world point currently at the overlay's centre, kept there after the zoom.
    const wx = (o.width / 2 - v.panX) / v.zoom, wy = (o.height / 2 - v.panY) / v.zoom;
    const zoom = v.zoom * z;
    a.setViewport({ zoom, panX: o.width / 2 - wx * zoom, panY: o.height / 2 - wy * zoom });
  }, ZOOM_FACTOR);
  await sleep(400);
  const afterZoom = await inkDashes();
  if (beforeZoom.length && afterZoom.length) {
    const w0 = Math.max(...beforeZoom.map((p) => p.strokeWidth));
    const w1 = Math.max(...afterZoom.map((p) => p.strokeWidth));
    assert(w1 === w0,
      `ZOOM ${ZOOM_FACTOR}x: stroke-width is unchanged (${w0}px → ${w1}px) — a hairline in SCREEN px, the box marquee's own mechanism`);
    const h0 = Math.max(...beforeZoom.map((p) => p.h));
    const h1 = Math.max(...afterZoom.map((p) => p.h));
    assert(h1 > h0 * 2,
      `ZOOM ${ZOOM_FACTOR}x: the dash's GEOMETRY did rescale (${h0.toFixed(0)}px → ${h1.toFixed(0)}px) — the width test above measured a live overlay, not a frozen one`);
  } else {
    assert(false, `ZOOM ${ZOOM_FACTOR}x: ink dashes present before (${beforeZoom.length}) and after (${afterZoom.length}) the zoom`);
  }

  // ── 8. MULTI-SELECT: an ink dash for every stroke member ─────────────────
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
  const multi = await inkDashes();
  assert(multi.length >= 2, `MULTI-SELECT: every stroke member draws its ink dash (${multi.length} paths for 2 widgets)`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
console.log(`\n${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
if (fails.length) { for (const f of fails) console.error(f); process.exit(1); }
