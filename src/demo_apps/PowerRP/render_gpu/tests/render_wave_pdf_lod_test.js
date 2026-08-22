/**
 * THE INTERACTION-LOD DECISION — plain node, no browser.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/render_wave_pdf_lod_test.js
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────────
 * User, 2026-08-12: "Paper peacock might need an easier to render proxy for all
 * the slides. It's laggy to drag around. Actually anything involving pdfs may need
 * to. Why don't we just make them white rectangles?"
 *
 * The lag is a RASTER STAMPEDE. A drag is a continuous sweep of world scale, and
 * every PDF raster is cached under a scale bucketed to PDF_SCALE_STEP (0.1). So a
 * single gesture walks through bucket after bucket, and each new bucket is a cache
 * MISS that kicks a fresh pdf.js page render — for paper_peacock, once PER SHEET
 * per frame. The fix is display-time LOD: while a gesture is live, draw whatever
 * raster is already resident instead of requesting the ideal one.
 *
 * `bestCachedScale` is the whole policy, factored out of the two cache lookups so
 * it can be tested here with no CanvasKit, no pdf.js and no browser. The lookups
 * themselves are thin: scan the map for ready entries, hand their scales to this.
 *
 * ── WHY LOG-SPACE DISTANCE, WHICH IS THE ONE SUBTLE PART ─────────────────────
 * "Nearest resident scale" on a LINEAR metric is wrong in a way that shows up as
 * blur exactly when it is most visible. Wanting 2.0 with {0.5, 4.0} resident: 0.5
 * is off by 1.5 and 4.0 is off by 2.0, so linear picks 0.5 — a raster with a
 * QUARTER the needed resolution, upsampled 4x into a blurry smear, over one with
 * twice the resolution that downsamples invisibly. In log space they are 1.39 and
 * 0.69 apart, and 4.0 wins. Resolution is a ratio quantity; the metric has to be.
 *
 * ── THE ASSERTIONS ────────────────────────────────────────────────────────────
 *   EMPTY       nothing resident ⇒ null. The caller's cue to draw the placeholder
 *               box, which is the ONLY case that may show one.
 *   EXACT       a resident exact match always wins — LOD must be invisible when
 *               the ideal raster is already there (i.e. the common steady state).
 *   NEAREST     the ordinary case: the closest resident bucket, either side.
 *   SHARPER     ties break toward the LARGER scale (downsample, never upsample).
 *   LOG         the metric assertion above — the case a linear metric gets wrong.
 *   DEGENERATE  a nonsense want/scale never returns a nonsense answer.
 */
import assert from "node:assert/strict";
import { bestCachedScale, roundPdfScale, PDF_SCALE_STEP } from "../gpu/pdf_page_raster.js";
import { createRegistry } from "../../core/registry.js";
import { registerPlugins } from "../../plugins/index.js";
import { sceneIR } from "../ports.js";

/**
 * A src no pdf.js document will ever resolve, so the raster cache stays provably
 * cold and the LOD's no-raster branch cannot be reached by accident.
 *
 * THIS SUITE PRINTS pdf_page_raster / pdf_page_vector LOAD ERRORS ON A PASS, and
 * they are EVIDENCE, not noise: they are the INTERACTIVE branch dutifully asking
 * for rasters of a PDF that cannot exist and reporting the failure loudly, exactly
 * as this codebase requires. Their presence proves the request path still fires
 * when interactive; the WIRED assertion proves it does NOT fire when dragging.
 * A run with no such lines would mean the interactive branch had stopped
 * requesting at all.
 */
const COLD_SRC = "blob:powerrp-render-wave-lod-never-resolves";

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

test("EMPTY — nothing resident is null, the placeholder's only trigger", () => {
  assert.equal(bestCachedScale(2, []), null);
  // A page that has never been rasterized at ANY scale is the only case where the
  // user may see a flat box. Anything else must draw real pixels.
  assert.equal(bestCachedScale(0.1, []), null);
});

test("EXACT — a resident exact match wins, so LOD is invisible at rest", () => {
  assert.equal(bestCachedScale(2, [1, 2, 3]), 2);
  assert.equal(bestCachedScale(1, [1]), 1);
  // The steady state after a drag ends: the ideal scale has landed, and the very
  // next frame must pick it rather than lingering on the stale one.
  assert.equal(bestCachedScale(3.4, [1.2, 3.4]), 3.4);
});

test("NEAREST — the closest resident bucket, from either side", () => {
  assert.equal(bestCachedScale(2.0, [1.9, 4.0]), 1.9, "1.9 is far closer than 4.0");
  assert.equal(bestCachedScale(2.0, [0.4, 2.1]), 2.1);
  // A drag sweeping upward: the wanted bucket runs ahead of what has landed, and
  // the answer is the highest resident scale rather than a stale low one.
  assert.equal(bestCachedScale(5.0, [1.0, 2.0, 3.0]), 3.0);
});

test("SHARPER — a tie breaks toward the larger scale (downsample, never up)", () => {
  // 1.0 and 4.0 are equidistant from 2.0 in log space (both ln 2). Downsampling
  // 4.0 is invisible; upsampling 1.0 is a visible smear.
  assert.equal(bestCachedScale(2.0, [1.0, 4.0]), 4.0);
  assert.equal(bestCachedScale(3.0, [1.0, 9.0]), 9.0);
});

test("LOG — the metric a linear 'nearest' gets backwards", () => {
  // Linear distance would pick 0.5 (|0.5−2|=1.5 vs |4−2|=2). Log picks 4.0.
  assert.equal(bestCachedScale(2.0, [0.5, 4.0]), 4.0);
  // Stated as the property rather than the instance: halving and doubling are
  // equally far, so the tie-break (not the distance) decides — and it picks up.
  const half = Math.abs(Math.log(1.0 / 2.0));
  const double = Math.abs(Math.log(4.0 / 2.0));
  assert.ok(Math.abs(half - double) < 1e-12, "half and double must be equidistant in log space");
});

test("DEGENERATE — a bad want or a bad resident scale never yields a bad answer", () => {
  assert.equal(bestCachedScale(0, [1, 2]), null, "a zero want has no meaningful nearest");
  assert.equal(bestCachedScale(-1, [1, 2]), null);
  assert.equal(bestCachedScale(NaN, [1, 2]), null);
  // A non-positive resident scale is skipped rather than returned or thrown on:
  // roundPdfScale can never produce one, so this is defence at the map boundary.
  assert.equal(bestCachedScale(2, [0, -3, 1.8]), 1.8);
  assert.equal(bestCachedScale(2, [0, -3]), null);
});

test("THE BUCKET GRID IS WHY MISSES ARE COMMON — the premise, pinned", () => {
  // The stampede this feature exists to stop is a consequence of bucketing: a drag
  // sweeping scale 1.0 → 2.0 crosses ten distinct cache keys, each a fresh pdf.js
  // render. If the step ever changed, the cost model here changes with it.
  assert.equal(PDF_SCALE_STEP, 0.1);
  const buckets = new Set();
  for (let s = 1.0; s <= 2.0; s += 0.01) buckets.add(roundPdfScale(s));
  assert.ok(buckets.size >= 10, `a 1.0→2.0 zoom sweep crosses ${buckets.size} buckets — each one a miss without LOD`);
});

/**
 * ── THE END-TO-END HALF ──────────────────────────────────────────────────────
 * The policy above is pure and easy to test; the part that actually broke in this
 * codebase's history is WIRING, so these drive real plugin emit() through sceneIR
 * with a cold cache. A `src` that no pdf.js document will ever resolve is the
 * point: nothing can land, so `interactive: false` MUST take the no-raster branch
 * and cannot accidentally pass by drawing a real page.
 */
test("WIRED — a live gesture requests no raster and draws a placeholder instead", () => {
  const registry = createRegistry();
  registerPlugins(registry);
  const node = (type) => {
    const plugin = registry.get(type);
    assert.ok(plugin, `${type} is not registered`);
    return { itemId: "i", type, plugin, world: { x: 0, y: 0, rotation: 0, scale: 1 },
      state: { ...plugin.defaults, x: 0, y: 0, w: 300, h: 400, rotation: 0, scale: 1, src: COLD_SRC } };
  };
  const opNames = (cmds) => {
    const out = [];
    const walk = (list) => { for (const c of list) { out.push(c.op); if (Array.isArray(c.content)) walk(c.content); } };
    walk(cmds);
    return out;
  };
  for (const type of ["pdf_page", "paper_peacock"]) {
    const hot = opNames(sceneIR([node(type)], { interactive: true }));
    const dragging = opNames(sceneIR([node(type)], { interactive: false }));
    assert.ok(hot.includes("image"), `${type}: the normal path must emit an image quad`);
    assert.ok(
      !dragging.includes("image"),
      `${type}: a live gesture with a COLD cache still emitted an image op — it asked for a raster that cannot exist instead of drawing the placeholder`,
    );
    assert.equal(hot.length, dragging.length, `${type}: LOD must swap ops, not drop them`);
  }
});

test("NO HOLES — an LOD frame never emits a null op", () => {
  const registry = createRegistry();
  registerPlugins(registry);
  for (const type of ["pdf_page", "paper_peacock", "pdf_packet"]) {
    const plugin = registry.get(type);
    const node = { itemId: "i", type, plugin, world: { x: 0, y: 0, rotation: 0, scale: 1 },
      state: { ...plugin.defaults, x: 0, y: 0, w: 300, h: 400, rotation: 0, scale: 1, src: COLD_SRC } };
    for (const interactive of [true, false]) {
      const cmds = sceneIR([node], { interactive });
      assert.ok(
        cmds.every((c) => c != null),
        `${type} (interactive=${interactive}): emitted a null op — a dropped quad must become a placeholder, never a hole in the display list`,
      );
    }
  }
});

test("EXPORTS NEVER DEGRADE — omitting the flag is full quality", () => {
  const registry = createRegistry();
  registerPlugins(registry);
  const plugin = registry.get("pdf_page");
  const node = { itemId: "i", type: "pdf_page", plugin, world: { x: 0, y: 0, rotation: 0, scale: 1 },
    state: { ...plugin.defaults, x: 0, y: 0, w: 300, h: 400, rotation: 0, scale: 1, src: COLD_SRC } };
  // An exporter, the CLI and every thumbnail path pass no `interactive` at all.
  // Defaulting to false would silently ship degraded exports, so the default is
  // asserted here rather than trusted — this is the Δt-style "exports never see an
  // editor-only state" guarantee for the LOD.
  const omitted = JSON.stringify(sceneIR([node], {}));
  const explicit = JSON.stringify(sceneIR([node], { interactive: true }));
  assert.equal(omitted, explicit, "omitting `interactive` must be identical to full quality");
});

console.log(`\nrender_wave_pdf_lod_test: ${passed} passed`);
