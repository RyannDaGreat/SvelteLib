/**
 * LATEX EQUATION WIDGET end-to-end probe (manifest ROUND 14.5 —
 * plugins/latex.js + render_gpu/gpu/latex_raster.js). Drives a REAL browser
 * (ephemeral Vite dev server + puppeteer, ALWAYS an isolated port — never 3637)
 * through the SAME fold→evaluate→derive→emit→GPU pipeline the CLI renderer
 * uses, so the widget is exercised through its true render path (MathJax
 * tex-svg typeset → SVG rasterize → gpu/image_registry.js registration → the
 * compositor's normal image draw). Writes NOTHING into user projects.
 *
 * Checks:
 *   1. A valid equation (the quadratic formula) renders NON-BLANK pixels with
 *      DARK INK on the light camera background (glyphs present) AND the raster
 *      is correctly sized to the widget box (not a 1×1 degenerate).
 *   2. An INVALID equation (\frac{ — unbalanced) renders the LOUD in-widget
 *      ERROR AFFORDANCE: RED-dominant pixels (the red error box), NOT a blank
 *      widget, NOT the normal dark-ink equation.
 *   3. An EMPTY latex string is a GHOST: isGhost(state) is true AND emit()
 *      returns [] (no rendered volume) → the frame is the plain camera
 *      background (nothing drawn), exactly like empty text/filmstrip.
 *   4. Zero UNEXPECTED page console errors from latex/latex_raster/
 *      image_registry (the codebase's "no unexpected console errors"
 *      convention — an invalid equation is surfaced via the in-widget
 *      affordance + latexErrorFor, NOT a thrown/console error, so this probe
 *      expects ZERO of its own console errors).
 *
 * Also DUMPS the valid equation's rasterized PNG to `<outDir>/latex_equation.png`
 * (base64 printed as LATEX_FIXTURE_B64=… on stdout) so the parity fixture
 * (tests/fixtures/latex_equation_png.js) can be regenerated deterministically
 * from the REAL runtime path — see that fixture's header.
 *
 * IMPORTANT: latex is NOT registered in plugins/index.js by default (that
 * shared file is the lead's; this probe imports latexPlugin directly and
 * registers it into a throwaway registry via the same createRegistry() core
 * API real code uses), so it never depends on index.js having the line added.
 *
 * Run (exit-code gated): node src/demo_apps/PowerRP/tests/latex_probe.js [outDir]
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(HERE, "../../../..");
const outDir = process.argv[2] || join(HERE, "..", ".probe_latex");
mkdirSync(outDir, { recursive: true });

/** A minimal doc: one latex item over the default camera. `latex`, `fontSize`,
 * and `ink` come from the caller so the same builder serves every check
 * (including the two-color / cache checks — Round 15.4). */
function makeDoc(latex, fontSize = 40, ink = undefined) {
  const eq = { type: "latex", x: 20, y: 20, w: 360, h: 120, z: 0, rotation: 0, scale: 1, active: true, latex, fontSize };
  if (ink !== undefined) eq.ink = ink;
  return {
    meta: { name: "latex_probe", slideW: 400, slideH: 160 },
    slides: [{
      id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0, curve: "smooth" },
      delta: {
        items: {
          cam: { type: "camera", x: 0, y: 0, w: 400, h: 160, z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff" },
          eq,
        },
      },
    }],
  };
}

/** Pure function. RGBA Uint8ClampedArray → {r,g,b} mean over all pixels
 * (ignores alpha). Cheap frame fingerprint.
 *
 * @example meanColor(new Uint8ClampedArray([255,0,0,255, 255,0,0,255])) // {r: 255, g: 0, b: 0}
 */
function meanColor(rgba) {
  let r = 0, g = 0, b = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < n; i++) { r += rgba[i * 4]; g += rgba[i * 4 + 1]; b += rgba[i * 4 + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

/** Pure function. Fraction of pixels that are clearly DARK (all channels below
 * a threshold) — the "is there ink here" test for an equation on a light
 * background (glyphs are near-black). A blank white frame scores ~0.
 *
 * @example darkFraction(new Uint8ClampedArray([0,0,0,255, 255,255,255,255])) // 0.5
 */
function darkFraction(rgba, thresh = 90) {
  let dark = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4] < thresh && rgba[i * 4 + 1] < thresh && rgba[i * 4 + 2] < thresh) dark++;
  }
  return dark / n;
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Repo-root vite config (the pdf_page_probe precedent — serving from the repo
// root lets in-page absolute "/src/demo_apps/PowerRP/…" imports resolve).
const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(repoRoot, "vite.config.js"),
  root: repoRoot,
  server: { port: 0, open: false, host: "127.0.0.1" }, // port 0 → ephemeral, never 3637
  // Pre-bundle BOTH lazy heavy deps at boot so vite does its one-time
  // re-optimization+reload deterministically BEFORE the render hook is
  // installed — not mid-run (which would wipe the hook between calls, the
  // exact flake this avoids). pdfjs-dist rides in via plugins/index.js's
  // pdf_page chain; mathjax is this widget's own lazy tex-svg dep.
  optimizeDeps: { include: ["pdfjs-dist", "mathjax"] },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: true });

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (e) => console.log(`  (hub pageerror, ignored — not this widget's concern): ${e.message}`));
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });

  /** Command (in-page). Registers latex into a throwaway registry (bypassing
   * plugins/index.js per the fence) and installs the render hook + an
   * isGhost/emit inspector, all through the SAME core API real code uses. */
  async function installRenderHook(page) {
    await page.evaluate(async () => {
      const { createRegistry } = await import("/src/demo_apps/PowerRP/core/registry.js");
      const { createCommands } = await import("/src/demo_apps/PowerRP/core/commands.js");
      const { registerAll } = await import("/src/demo_apps/PowerRP/plugins/index.js");
      const { latexPlugin } = await import("/src/demo_apps/PowerRP/plugins/latex.js");
      const { foldState, repairedDocument } = await import("/src/demo_apps/PowerRP/core/document.js");
      const { cameraRect } = await import("/src/demo_apps/PowerRP/core/derive.js");
      const { evaluateState } = await import("/src/demo_apps/PowerRP/core/expressions.js");
      const { fitRectView } = await import("/src/demo_apps/PowerRP/core/view.js");
      const { parseColor } = await import("/src/demo_apps/PowerRP/render_gpu/ir.js");
      const { GpuCompositor } = await import("/src/demo_apps/PowerRP/render_gpu/gpu/compositor.js");
      const { cameraFrameIR } = await import("/src/demo_apps/PowerRP/web/cameraFrame.js");
      const { irToSVG } = await import("/src/demo_apps/PowerRP/render_gpu/svg_backend.js");
      const { irToPDF } = await import("/src/demo_apps/PowerRP/render_gpu/pdf_backend.js");
      const { latexGlyphs } = await import("/src/demo_apps/PowerRP/render_gpu/gpu/latex_raster.js");

      const registry = createRegistry();
      registerAll(registry, createCommands());
      // Defensive: once the lead lands the index.js line, latex is already
      // registered — re-registering the same type throws.
      try { registry.get("latex"); } catch { registry.register(latexPlugin); }

      // Direct hooks for the ghost/emit structural checks (no GPU needed).
      window.__latexIsGhost = (state) => latexPlugin.isGhost(state);
      window.__latexEmitCount = (state, world) => latexPlugin.emit(state, null, world ?? { x: 0, y: 0, rotation: 0, scale: 1 }).length;
      // The flattened vector glyph geometry (Round 15.1) for a latex string —
      // used both for the vector-export assertions and to DUMP the deterministic
      // bare-node parity fixture (analogous to the PNG fixture).
      window.__latexGlyphs = (latex) => latexGlyphs(latex);

      // Build the derived scene IR for a doc, then serialize to SVG / PDF —
      // exercises the TRUE latex plugin emit() → latexVector op → vector backends
      // (Round 15.1). Returns the SVG string + the PDF bytes (base64).
      window.__latexVectorExports = async function (doc, { slide = 0, width, height } = {}) {
        const { doc: repaired } = repairedDocument(doc, registry);
        const state = evaluateState(foldState(repaired, slide, 1), registry).state;
        const rect = cameraRect(state, repaired.meta);
        const view = fitRectView(rect, width, height, 1);
        const ir = cameraFrameIR(state, repaired.meta, registry);
        const svg = await irToSVG(ir, { width, height, view, background: rect.background });
        const pdfBytes = await irToPDF(ir, { width, height, view, background: rect.background });
        let bin = "";
        for (const b of pdfBytes) bin += String.fromCharCode(b);
        return { svg, pdf: btoa(bin) };
      };

      window.__latexProbeRender = async function (doc, { slide = 0, alpha = 1, width, height } = {}) {
        const { doc: repaired, reports } = repairedDocument(doc, registry);
        for (const r of reports) console.error(`repair: ${JSON.stringify(r)}`); // loud, never silent
        const state = evaluateState(foldState(repaired, slide, alpha), registry).state;
        const rect = cameraRect(state, repaired.meta);
        const view = fitRectView(rect, width, height, 1);
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const gpu = await GpuCompositor.create(canvas);
        gpu.render(cameraFrameIR(state, repaired.meta, registry), view, { background: parseColor(rect.background) });
        return Array.from(await gpu.readPixels(0, 0, width, height));
      };
    });
  }

  // MathJax's tex-svg bundle is a NEW heavy dep loaded LAZILY (inside
  // latex_raster.loadMathJax), so vite discovers+optimizes it on the FIRST
  // typeset and force-reloads once — retry across that reload (the pdf_page
  // precedent), re-installing the render hook after a reload.
  const RELOAD_TIMEOUT_MS = 90_000;
  const WARMUP_TRIES = 5;
  async function runAcrossReloads(step) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (e) {
        // Also catch the POST-reload symptom (a reload between calls wipes the
        // in-page hook → "__latexProbeRender is not a function"): re-install and
        // retry rather than fail (defensive belt-and-suspenders atop optimizeDeps).
        if (attempt >= WARMUP_TRIES || !/Execution context was destroyed|Failed to fetch dynamically imported module|__latexProbeRender is not a function/.test(String(e))) throw e;
        console.log(`  (vite re-optimized deps and reloaded — warmup retry ${attempt})`);
        await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: RELOAD_TIMEOUT_MS });
        await installRenderHook(page);
      }
    }
  }

  await runAcrossReloads(() => installRenderHook(page));

  const W = 400, H = 160;
  const QUADRATIC = "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";
  const INVALID = "\\frac{"; // unbalanced — MathJax renders an merror box

  // Warm up MathJax's dependency optimization (and its one-time reload) HERE,
  // deterministically, rather than mid-poll below.
  await runAcrossReloads(() => page.evaluate(
    (d, w, h) => window.__latexProbeRender(d, { width: w, height: h }),
    makeDoc(QUADRATIC), W, H,
  ));

  /** Query (in-page). Renders `doc`, polling (the async typeset-then-repaint
   * contract) until the frame stops being the plain white camera background,
   * or `tries` is exhausted. Returns the final RGBA + fingerprints. */
  async function renderUntilNonBlank(doc, tries = 60) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const px = await runAcrossReloads(() => page.evaluate(
        (d, w, h) => window.__latexProbeRender(d, { width: w, height: h }),
        doc, W, H,
      ));
      const rgba = new Uint8ClampedArray(px);
      const mean = meanColor(rgba);
      const dark = darkFraction(rgba);
      last = { mean, dark, px };
      if (mean.r < 250 || mean.g < 250 || mean.b < 250) return { ...last, tries: i + 1 };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ...last, tries, timedOut: true };
  }

  // ── check 1: valid equation → non-blank, dark ink, correctly sized ──────────
  const rValid = await renderUntilNonBlank(makeDoc(QUADRATIC));
  check("valid equation renders non-blank pixels", !rValid.timedOut, `mean=${JSON.stringify(rValid.mean)} after ${rValid.tries} tries`);
  check("valid equation has DARK INK (glyphs present, not a blank/filled box)", rValid.dark > 0.005, `darkFraction=${rValid.dark?.toFixed(4)}`);
  check("valid equation is NOT red-dominant (it's an equation, not the error box)", !(rValid.mean.r > rValid.mean.g + 30 && rValid.mean.r > rValid.mean.b + 30), `mean=${JSON.stringify(rValid.mean)}`);

  // ── check 2: invalid equation → loud RED error affordance ───────────────────
  const rErr = await renderUntilNonBlank(makeDoc(INVALID));
  check("invalid equation renders non-blank (NOT a silent blank widget)", !rErr.timedOut, `mean=${JSON.stringify(rErr.mean)} after ${rErr.tries} tries`);
  // The loud error affordance is a red-tinted box (ERROR_BG) with a red border +
  // deep-red text: the frame reads clearly REDDISH (r meaningfully above g and
  // b) — distinct from the neutral dark-on-light equation render (check 1's
  // valid mean is ~grayscale). A generous margin (>25) confirms it is the loud
  // affordance, not MathJax's faint own error box.
  check("invalid equation shows the LOUD RED error affordance (clearly reddish frame)", rErr.mean.r > rErr.mean.g + 25 && rErr.mean.r > rErr.mean.b + 25, `mean=${JSON.stringify(rErr.mean)}`);

  // ── check 3: empty latex → ghost (isGhost true, emit []) ────────────────────
  const emptyState = { type: "latex", x: 20, y: 20, w: 360, h: 120, latex: "", fontSize: 40 };
  const isGhost = await page.evaluate((s) => window.__latexIsGhost(s), emptyState);
  const emitCount = await page.evaluate((s) => window.__latexEmitCount(s), emptyState);
  check("empty latex is a GHOST (isGhost === true)", isGhost === true, `isGhost=${isGhost}`);
  check("empty latex emits NOTHING (emit() returns [])", emitCount === 0, `emit length=${emitCount}`);
  const wsGhost = await page.evaluate((s) => window.__latexIsGhost(s), { ...emptyState, latex: "   " });
  check("whitespace-only latex is also a GHOST", wsGhost === true, `isGhost=${wsGhost}`);
  const nonGhost = await page.evaluate((s) => window.__latexIsGhost(s), { ...emptyState, latex: "x^2" });
  check("non-empty latex is NOT a ghost", nonGhost === false, `isGhost=${nonGhost}`);

  // ── check 5: TRUE VECTOR EXPORT (Round 15.1) — SVG has <path> glyphs + NO
  //             latex <image>; PDF has path operators for the equation ─────────
  // First ensure the valid equation's glyph geometry has been flattened (the
  // valid render above already typeset it; poll latexGlyphs to be safe).
  let glyphsReady = null;
  for (let i = 0; i < 60 && !glyphsReady; i++) {
    glyphsReady = await runAcrossReloads(() => page.evaluate((l) => {
      const g = window.__latexGlyphs(l);
      return g ? { count: g.glyphs.length, viewBox: g.viewBox } : null;
    }, QUADRATIC));
    if (!glyphsReady) await new Promise((r) => setTimeout(r, 100));
  }
  check("valid equation FLATTENS to vector glyphs (>0 <path>s, real viewBox)",
    glyphsReady && glyphsReady.count > 0 && glyphsReady.viewBox.w > 0,
    `glyphs=${JSON.stringify(glyphsReady)}`);

  const exports = await runAcrossReloads(() => page.evaluate(
    (d, w, h) => window.__latexVectorExports(d, { width: w, height: h }),
    makeDoc(QUADRATIC), W, H,
  ));
  // SVG: the equation is inline <path> glyph geometry, NOT a raster <image>.
  // (The scene has a white camera background; there is NO image widget, so ANY
  // <image> in the output would be the latex raster — its absence proves true
  // vector.)
  check("exported SVG contains <path> glyph geometry", /<path\b/.test(exports.svg), `svg head: ${exports.svg.slice(0, 120)}`);
  check("exported SVG has NO latex <image> (true vector, not a raster region)", !/<image\b/.test(exports.svg), `contains <image>: ${/<image\b/.test(exports.svg)}`);
  const svgExternalRef = /href="https?:/.test(exports.svg) || /url\(https?:/.test(exports.svg);
  check("exported SVG is self-contained (no http(s) external refs)", !svgExternalRef, svgExternalRef ? "external ref found" : "self-contained");
  // PDF: path-fill operators for the equation region (m/l/c … f). A raster-only
  // equation would embed an /XObject image instead — assert the vector path ops
  // are present AND no image XObject was minted for the (unblurred) equation.
  const pdfText = Buffer.from(exports.pdf, "base64").toString("latin1");
  check("exported PDF contains path operators for the equation (m/l/c + f fill)",
    /\bm\b/.test(pdfText) && /\bc\b/.test(pdfText) && /\bf\b/.test(pdfText),
    `has m:${/\bm\b/.test(pdfText)} c:${/\bc\b/.test(pdfText)} f:${/\bf\b/.test(pdfText)}`);
  check("exported PDF has NO image XObject for the unblurred equation (true vector)",
    !/\/XObject/.test(pdfText), `has /XObject: ${/\/XObject/.test(pdfText)}`);

  // ── check 6: INK COLOR (Round 15.4) — two colors render differently (live +
  //             both vector exports) ──────────────────────────────────────────
  const rRed = await renderUntilNonBlank(makeDoc(QUADRATIC, 40, "#ff0000"));
  const rBlue = await renderUntilNonBlank(makeDoc(QUADRATIC, 40, "#0000ff"));
  check("red-ink equation renders reddish ink", rRed.mean.r > rRed.mean.b, `mean=${JSON.stringify(rRed.mean)}`);
  check("blue-ink equation renders bluish ink", rBlue.mean.b > rBlue.mean.r, `mean=${JSON.stringify(rBlue.mean)}`);
  check("two ink colors produce DIFFERENT live pixels (raster tint honors ink)",
    Math.abs(rRed.mean.r - rBlue.mean.r) > 5 || Math.abs(rRed.mean.b - rBlue.mean.b) > 5,
    `red=${JSON.stringify(rRed.mean)} blue=${JSON.stringify(rBlue.mean)}`);
  const exRed = await runAcrossReloads(() => page.evaluate((d, w, h) => window.__latexVectorExports(d, { width: w, height: h }), makeDoc(QUADRATIC, 40, "#ff0000"), W, H));
  const exBlue = await runAcrossReloads(() => page.evaluate((d, w, h) => window.__latexVectorExports(d, { width: w, height: h }), makeDoc(QUADRATIC, 40, "#0000ff"), W, H));
  check("exported SVG glyph fill follows ink (red vs blue paths differ)",
    /rgba\(255,0,0/.test(exRed.svg) && /rgba\(0,0,255/.test(exBlue.svg),
    `redSvgHasRed=${/rgba\(255,0,0/.test(exRed.svg)} blueSvgHasBlue=${/rgba\(0,0,255/.test(exBlue.svg)}`);
  const pdfRed = Buffer.from(exRed.pdf, "base64").toString("latin1");
  const pdfBlue = Buffer.from(exBlue.pdf, "base64").toString("latin1");
  check("exported PDF glyph fill follows ink (1 0 0 rg vs 0 0 1 rg)",
    /1 0 0 rg/.test(pdfRed) && /0 0 1 rg/.test(pdfBlue),
    `redPdfHasRed=${/1 0 0 rg/.test(pdfRed)} bluePdfHasBlue=${/0 0 1 rg/.test(pdfBlue)}`);

  // ── check 7: CACHE correctness — ink is in the ref key; a color flip mints a
  //             new ref (a new raster), never reuses the wrong-colored bitmap ──
  const refCheck = await runAcrossReloads(() => page.evaluate(async (latex) => {
    const { latexRef } = await import("/src/demo_apps/PowerRP/render_gpu/gpu/latex_raster.js");
    return { red: latexRef(latex, 40, "#ff0000"), blue: latexRef(latex, 40, "#0000ff"), def: latexRef(latex, 40) };
  }, QUADRATIC));
  check("ink is in the raster cache key (red ref != blue ref != default ref)",
    refCheck.red !== refCheck.blue && refCheck.red !== refCheck.def && refCheck.blue !== refCheck.def,
    JSON.stringify(refCheck));

  // ── check 4: no unexpected console errors from THIS widget ──────────────────
  const mine = consoleErrors.filter((m) => /latex|latex_raster|image_registry|mathjax/i.test(m));
  check("no unexpected console errors from latex/latex_raster/image_registry", mine.length === 0, `mine: ${JSON.stringify(mine)}; ALL: ${JSON.stringify(consoleErrors)}`);

  // ── vector fixture dump: the flattened glyph geometry (Round 15.1) for the
  //     bare-node parity scene (analogous to the PNG fixture) ─────────────────
  const vecFixture = await runAcrossReloads(() => page.evaluate((l) => window.__latexGlyphs(l), QUADRATIC));
  if (vecFixture && vecFixture.glyphs.length > 0) {
    check(`vector fixture captured (${vecFixture.glyphs.length} glyph paths)`, true);
    console.log(`LATEX_VECTOR_FIXTURE ${JSON.stringify(vecFixture)}`);
  } else {
    check("vector fixture captured", false, "latexGlyphs returned null/empty");
  }

  // ── fixture dump: the valid equation's rasterized PNG (from the REAL path) ──
  // Grab the widget's own bitmap via the image registry (the ref the plugin
  // emitted), re-encode it to a PNG data URI, and dump for the parity fixture.
  const fixtureB64 = await runAcrossReloads(() => page.evaluate(async (latex, fontSize) => {
    const { latexRef, LATEX_RASTER_DENSITY } = await import("/src/demo_apps/PowerRP/render_gpu/gpu/latex_raster.js");
    const { getImage } = await import("/src/demo_apps/PowerRP/render_gpu/gpu/image_registry.js");
    // The plugin rasters at scale = world.scale(1) × fontSize (see latex.js emit).
    const ref = latexRef(latex, fontSize);
    const bitmap = getImage(ref);
    if (!bitmap) return null;
    const c = document.createElement("canvas");
    c.width = bitmap.width; c.height = bitmap.height;
    c.getContext("2d").drawImage(bitmap, 0, 0);
    const dataUrl = c.toDataURL("image/png");
    return { dataUrl, w: bitmap.width, h: bitmap.height };
  }, QUADRATIC, 40));
  if (fixtureB64?.dataUrl) {
    const b64 = fixtureB64.dataUrl.split(",")[1];
    writeFileSync(join(outDir, "latex_equation.png"), Buffer.from(b64, "base64"));
    check(`fixture bitmap captured (correctly sized ${fixtureB64.w}x${fixtureB64.h}, not 1x1)`, fixtureB64.w > 10 && fixtureB64.h > 10, `size=${fixtureB64.w}x${fixtureB64.h}`);
    console.log(`LATEX_FIXTURE_SIZE ${fixtureB64.w}x${fixtureB64.h}`);
    console.log(`LATEX_FIXTURE_B64 ${fixtureB64.dataUrl}`);
  } else {
    check("fixture bitmap captured", false, "getImage returned null (raster not ready)");
  }

  console.log(failures === 0 ? "\nAll latex probe checks passed." : `\n${failures} latex probe check(s) FAILED.`);
} finally {
  await browser.close();
  await server.close();
}

process.exit(failures === 0 ? 0 : 1);
