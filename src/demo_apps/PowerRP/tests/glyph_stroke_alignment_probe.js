/**
 * GLYPH STROKE ALIGNMENT probe (workstream AN) — does a plaintext widget's glyph
 * OUTLINE sit on its FILL, in the real editor's real GPU renderer?
 *
 * The user's report, verbatim: "with plain text, the stroke is misaligned with the
 * fill." Two screenshots of "Hi!" showed the outline riding a few pixels HIGH —
 * fill peeking out below every letter bottom, stroke overhanging every top.
 *
 * ── WHAT IS MEASURED, AND WHY IT IS A NUMBER AND NOT A PICTURE ──────────────
 * The load-bearing check is that the STROKE's baseline IS the FILL's baseline, to
 * floating-point equality. That is checkable exactly because the fix is
 * structural: the outline is now placed from the shaped positions of the very
 * CanvasKit paragraph that paints the fill, so there is nothing left to be
 * approximately equal. The two numbers come from opposite sides of the seam —
 * the stroke's from core/glyph_outlines.textGlyphPathDs (what it actually
 * placed), the fill's from CanvasKit's OWN getShapedLines(), deliberately NOT
 * from the layout helper this fix added, so the reference measurement does not
 * come from the code under test.
 *
 * ── AND WHY PIXELS ALONE CANNOT SETTLE IT (measured, not assumed) ────────────
 * An earlier draft of this file asserted only on rasterized ink — best-fit
 * vertical shift and boundary overlap between a fill-only and a stroke-only
 * render — and it PASSED AGAINST THE BROKEN RENDERER, on every case. That is not
 * a flaw in the instrument, it is the physics: the pre-fix baseline error is a
 * FRACTION of a pixel (measured 0.156 to 0.480 across these faces and sizes), so
 * it moves a coverage edge by less than one pixel, a whole-pixel best-fit shift
 * still reads 0 and a within-1px overlap score still reads 100%. A probe that
 * cannot fail on the bug it is named after is worse than no probe. The raster
 * checks are KEPT below as corroboration — they would catch a gross placement
 * error the numeric check could miss, such as an outline drawn at the wrong
 * origin entirely — but they are explicitly not what pins this fix.
 *
 * ── WHAT THIS PROBE DOES NOT COVER, STATED RATHER THAN IMPLIED ──────────────
 * The seam's LARGEST measured disagreement was lineSpacing: the two engines
 * distribute the extra leading differently and the baselines parted by 16.5px at
 * lineSpacing 1.5, size 96 — a 92px stroke offset at lineSpacing 2. There is no
 * case for it here because it is UNREACHABLE from the shipped UI: `lineSpacing`
 * lives on plugins/text.js and `glyphStroke` on plugins/plaintext.js and
 * plugins/latex.js, and those sets are disjoint, so no widget can currently have
 * both. It was fixed anyway (the seam carries the paragraph style now) and is
 * pinned in bare node instead; if a widget ever gains both rows, add the case.
 *
 * ── WHY A BROWSER PROBE AT ALL, given the numbers are node-checkable ─────────
 * Because the reported defect is in the BROWSER's WebGL2 Skia surface, and
 * because the two things that must agree are produced by two different libraries
 * — the fill by a CanvasKit Paragraph, the stroke by fontkit outlines. This runs
 * both through the app's own offscreen compositor on a REAL plaintext widget, so
 * what is checked is the path a user's text actually takes, plugin emit included.
 *
 * Frontend-only Vite on an EPHEMERAL port (never 3637/3638).
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/glyph_stroke_alignment_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const appDir = resolve(HERE, "..");

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const assert = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails.push(m); };

/** The alignment budget, in LOGICAL pixels. One pixel is the task's stated bar and
 * it is a real bar rather than a generous one: the fix places the outline from the
 * paragraph's own shaped positions, so the residual is the rasterizer's own
 * coverage rounding, which cannot reach a whole pixel. The pre-fix defect measured
 * 92px in case 2 — this budget is nowhere near it. */
const ALIGN_TOLERANCE_PX = 1;
/** How far the stroke's baseline may sit from the FILL's, in logical pixels. This
 * is a FLOATING-POINT-EQUALITY budget, not a visual one: after the fix the stroke
 * is placed from the paragraph's own reported baseline, so the two are the same
 * number and any difference at all is a bug. The pre-fix build missed by 0.039 to
 * 0.480 across the cases below, so this budget is an order of magnitude under the
 * smallest real defect it has to catch. */
const BASELINE_TOLERANCE_PX = 1e-6;
/** Text big enough that a sub-pixel placement error is visible in coverage at all;
 * the reported screenshots were large display type. */
const TEXT_SIZE = 96;
/** How far the raster corroboration slides the stroke looking for a better fit,
 * in logical px. Wide enough that a GROSS regression — an outline placed at the
 * wrong origin — is reported at its true size rather than clipped to the edge of
 * the search and read as "a bit off". */
const SEARCH_PX = 120;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.log("PAGEERROR " + e.message); fails.push(`page error: ${e.message}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  /**
   * Renders a REAL plaintext widget twice through the app's own offscreen
   * compositor (web/gpuService.renderCameraFrame — the WebGL2 Skia surface the
   * editor draws with), once fill-only and once stroke-only, at byte-identical
   * document state apart from the two paint slots. Returns the vertical shift
   * that best aligns the stroke's ink onto the fill's boundary.
   *
   * Going through the WIDGET rather than a hand-built IR op is deliberate: the
   * op the renderer sees is then plugins/plaintext.js's own emit(), so the
   * probe covers the path a user's text actually takes, including whatever the
   * plugin does with the box and the paragraph style.
   */
  const measure = (opts) => page.evaluate(async (opts, SEARCH_PX, appDir) => {
    const app = window.__powerrp_app;
    const { renderCameraFrame } = await import("/gpuService.js");
    const W = 900, H = 600;

    app.selection = null;
    app.clearDoc();
    // SPREAD THE PLUGIN DEFAULTS — app.addItem stores exactly what it is handed
    // and missingDefaults only repairs at the LOAD boundary, so a hand-written
    // item reaches the canvas with undefined fields and throws inside an $effect.
    const add = (over) => {
      app.addItem({ ...app.registry.get("plaintext").defaults, type: "plaintext", ...over });
      return app.selection;
    };
    const common = {
      text: "Hi!", x: 60, y: 60, w: 600, h: 400,
      size: opts.size, font: opts.font, align: "left", valign: opts.valign ?? "top",
    };
    /** One render of the current doc as raw RGBA. */
    const shoot = async () => {
      const canvas = await renderCameraFrame(app.doc, {
        slideIndex: 0, alpha: 1, registry: app.registry, width: W, height: H, project: app.projectName(),
      });
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext("2d");
      g.drawImage(canvas, 0, 0);
      return g.getImageData(0, 0, W, H).data;
    };
    // FILL ONLY: a solid fill, no outline.
    const idFill = add({ ...common, fill: "#000000" });
    const fillPx = await shoot();
    // STROKE ONLY: same box, transparent fill, hairline outline. Rebuilt rather
    // than mutated so the two renders differ ONLY in the two paint slots.
    app.selection = null;
    app.clearDoc();
    add({ ...common, fill: "rgba(0,0,0,0)", glyphStroke: "#000000", glyphStrokeWidth: 1 });
    const strokePx = await shoot();

    /** Per-pixel ink coverage (0..1) against the lighter of the two grounds. */
    const cov = (d) => {
      const c = new Float64Array(W * H);
      for (let i = 0, j = 0; j < W * H; i += 4, j++) c[j] = (255 - Math.min(d[i], d[i + 1], d[i + 2])) / 255;
      return c;
    };
    const f = cov(fillPx), s = cov(strokePx);
    // The fill's BOUNDARY: a covered pixel with an uncovered 4-neighbour. This is
    // the curve the stroke is supposed to be tracing.
    const bnd = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (f[i] < 0.5) continue;
      if (f[i - 1] < 0.5 || f[i + 1] < 0.5 || f[i - W] < 0.5 || f[i + W] < 0.5) bnd[i] = 1;
    }
    let fillInk = 0, strokeInk = 0;
    for (let j = 0; j < W * H; j++) { fillInk += f[j]; strokeInk += s[j]; }
    /** Stroke ink lying within 1px of the fill boundary, with the stroke slid dy. */
    const score = (dy) => {
      let hit = 0, tot = 0;
      for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
        const v = s[y * W + x];
        if (v < 0.5) continue;
        tot += v;
        let near = false;
        for (let oy = -1; oy <= 1 && !near; oy++) for (let ox = -1; ox <= 1; ox++) {
          const yy = y + dy + oy;
          if (yy < 2 || yy >= H - 2) continue;
          if (bnd[yy * W + x + ox]) { near = true; break; }
        }
        if (near) hit += v;
      }
      return tot === 0 ? 0 : hit / tot;
    };
    let best = { dy: 0, score: -1 };
    for (let dy = -SEARCH_PX; dy <= SEARCH_PX; dy++) {
      const sc = score(dy);
      if (sc > best.score) best = { dy, score: sc };
    }
    // Also report the fill's and the stroke's vertical INK EXTENT: if the two
    // engines disagree about the baseline, the whole letterform moves, so the
    // extents part company even when a boundary-fit score does not.
    const extent = (c) => {
      let y0 = -1, y1 = -1;
      for (let y = 0; y < H; y++) { let any = false; for (let x = 0; x < W; x++) if (c[y * W + x] > 0.5) { any = true; break; }
        if (any) { if (y0 < 0) y0 = y; y1 = y; } }
      return { y0, y1 };
    };
    // ── THE TWO BASELINES, read from the engines themselves ───────────────────
    // The FILL's: the CanvasKit paragraph's own first-line baseline, taken from
    // the SAME cached TextLayout the renderer just drew through (getTextLayout is
    // a cache, so this is that very object, not an equal one).
    // The STROKE's: what core/glyph_outlines actually placed the outlines at.
    const { getTextLayout } = await import(`/@fs${appDir}/render_gpu/skia/text_layout.js`);
    const { textGlyphPathDs } = await import(`/@fs${appDir}/core/glyph_outlines.js`);
    const { ensureCanvasKit, loadFontCollection } = await import(`/@fs${appDir}/render_gpu/skia/browser_canvaskit.js`);
    const CanvasKit = await ensureCanvasKit();
    const fc = await loadFontCollection(CanvasKit);
    const state = { text: "Hi!", size: opts.size, font: opts.font, bold: false,
      w: common.w, h: common.h, align: "left", valign: opts.valign ?? "top" };
    const strokeBaseline = textGlyphPathDs(state).baselineY;
    // The paragraph the FILL drew through, asked for its own first-line baseline.
    // Read through getShapedLines() DIRECTLY rather than through the layout's own
    // shapedGlyphs() helper: that helper is part of the fix, and a probe whose
    // reference measurement comes from the code under test cannot fail when that
    // code is wrong — it would merely crash when the method is missing, which is
    // a red for the wrong reason. getShapedLines is CanvasKit's own API and is
    // there in both states, so the pre-fix build reports a real number and the
    // assertion below fails on its VALUE.
    const layout = getTextLayout(CanvasKit, fc, {
      text: "Hi!", x: 0, y: 0, size: opts.size, color: "#000000", font: opts.font,
      boxW: common.w, boxH: common.h,
      boxStyle: { align: "left", valign: opts.valign ?? "top" },
    }, 1);
    const b0 = layout.built[0];
    const fillBaseline = b0.yTop + b0.para.getShapedLines()[0].runs[0].positions[1];
    return { bestShift: best.dy, bestScore: best.score, scoreAtZero: score(0), fillInk, strokeInk,
             fillExtent: extent(f), strokeExtent: extent(s), strokeBaseline, fillBaseline };
  }, opts, SEARCH_PX, appDir);

  const cases = [
    ["inter 96", { size: 96, font: "inter" }],
    ["inter 36 (the default size)", { size: 36, font: "inter" }],
    ["inter 24", { size: 24, font: "inter" }],
    ["lora 96", { size: 96, font: "lora" }],
    ["jetbrains-mono 36", { size: 36, font: "jetbrains-mono" }],
    ["valign bottom", { size: 96, font: "inter", valign: "bottom" }],
  ];
  for (const [label, opts] of cases) {
    const r = await measure(opts);
    console.log(`  ${label}: baseline stroke ${r.strokeBaseline} vs fill ${r.fillBaseline} (Δ ${(r.strokeBaseline - r.fillBaseline).toFixed(4)})`
      + `  |  raster fit ${(r.scoreAtZero * 100).toFixed(1)}%  fill y ${r.fillExtent.y0}..${r.fillExtent.y1}  stroke y ${r.strokeExtent.y0}..${r.strokeExtent.y1}`);
    // BOTH passes must have drawn something. A silent empty render would make
    // every check below trivially true and the whole probe a green no-op — the
    // exact failure mode that lets a rendering bug ship, so it is asserted.
    assert(r.fillInk > 0, `${label}: the FILL pass drew ink`);
    assert(r.strokeInk > 0, `${label}: the STROKE pass drew ink`);
    // ── THE LOAD-BEARING CHECK ────────────────────────────────────────────────
    // The stroke's baseline must be the FILL's OWN baseline, to floating-point
    // agreement — not "close enough to look right". This is the assertion that
    // actually fails on the pre-fix code, and it is exact BECAUSE the fix is
    // structural: the outline is placed from the paragraph's own shaped
    // positions, so there is nothing left to be approximately equal. Measured on
    // the pre-fix build for these very cases, the two parted by 0.156 (inter 96),
    // 0.441 (inter 36), 0.039 (inter 24), 0.120 (lora 96) and 0.480 (jetbrains 36).
    //
    // A RASTER-ONLY probe cannot make this call, and the reason is worth stating:
    // a half-pixel baseline error moves a coverage edge by less than one pixel,
    // so a boundary-overlap score still reads 100% and a whole-pixel best-fit
    // shift still reads 0. An earlier draft of this file asserted exactly that
    // and PASSED against the broken renderer. The pixels below are kept as a
    // corroborating check — they catch a gross placement error this numeric one
    // could miss, such as an outline drawn at the wrong origin entirely — but
    // they are not what pins the fix.
    assert(Math.abs(r.strokeBaseline - r.fillBaseline) < BASELINE_TOLERANCE_PX,
      `${label}: the stroke is placed at the FILL's baseline (Δ ${(r.strokeBaseline - r.fillBaseline).toFixed(4)}px)`);
    assert(Math.abs(r.bestShift) <= ALIGN_TOLERANCE_PX,
      `${label}: and the rasterized stroke sits on the rasterized fill (${r.bestShift}px)`);
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(fails.length === 0 ? "\nGLYPH STROKE ALIGNMENT PROBE: PASS" : `\nGLYPH STROKE ALIGNMENT PROBE: ${fails.length} FAILURE(S)`);
process.exit(fails.length === 0 ? 0 : 1);
