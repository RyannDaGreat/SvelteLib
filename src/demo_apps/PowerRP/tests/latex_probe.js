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

/** A minimal doc: one latex item over the default camera. `latex` and
 * `fontSize` come from the caller so the same builder serves every check. */
function makeDoc(latex, fontSize = 40) {
  return {
    meta: { name: "latex_probe", slideW: 400, slideH: 160 },
    slides: [{
      id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0, curve: "smooth" },
      delta: {
        items: {
          cam: { type: "camera", x: 0, y: 0, w: 400, h: 160, z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff" },
          eq: { type: "latex", x: 20, y: 20, w: 360, h: 120, z: 0, rotation: 0, scale: 1, active: true, latex, fontSize },
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

      const registry = createRegistry();
      registerAll(registry, createCommands());
      // Defensive: once the lead lands the index.js line, latex is already
      // registered — re-registering the same type throws.
      try { registry.get("latex"); } catch { registry.register(latexPlugin); }

      // Direct hooks for the ghost/emit structural checks (no GPU needed).
      window.__latexIsGhost = (state) => latexPlugin.isGhost(state);
      window.__latexEmitCount = (state, world) => latexPlugin.emit(state, null, world ?? { x: 0, y: 0, rotation: 0, scale: 1 }).length;

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

  // ── check 4: no unexpected console errors from THIS widget ──────────────────
  const mine = consoleErrors.filter((m) => /latex|latex_raster|image_registry|mathjax/i.test(m));
  check("no unexpected console errors from latex/latex_raster/image_registry", mine.length === 0, `mine: ${JSON.stringify(mine)}; ALL: ${JSON.stringify(consoleErrors)}`);

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
