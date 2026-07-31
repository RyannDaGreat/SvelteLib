/**
 * SVG STROKE-CAP ORACLE probe (browser) — the bug this pins:
 *
 *   "Tabler icons draw the exclamation mark's DOT as a thin hairline sliver
 *   (native browser SVG shows a proper round dot), plus a faint stray diagonal
 *   hairline near the triangle's apex."
 *
 * THE ORACLE is the browser's own SVG rasterizer: an `<img>` of the RAW SVG
 * source drawn to a canvas, at the SAME pixel size as our pipeline's render.
 * Tabler icons are stroke-based (`fill="none" stroke="currentColor"
 * stroke-linecap="round" stroke-linejoin="round"`) and lean on TWO idioms our
 * flatten (core/svg_paths.js) did not honor:
 *   (1) the classic dot — `M12 16h.01`, a near-zero-length subpath that is a
 *       round DOT only because a round cap extends a half-stroke-width disc
 *       past each (coincident) end;
 *   (2) a near-closed rounded outline (e.g. alert-triangle's apex) whose open
 *       ends coincide almost exactly, relying on two overlapping round caps to
 *       read as a smooth corner rather than two square-cut stubs.
 *
 * A pipeline that draws every stroke with Skia's default caps (BUTT) turns (1)
 * into an invisible-to-hairline sliver (a butt-capped stroke has NO length to
 * paint) and can turn (2) into a faint diagonal seam where the two now-flat
 * ends fail to align.
 *
 * WHAT IT MEASURES (pixels, not guesses):
 *   - DOT INK COVERAGE: count of non-background pixels in a small box centered
 *     on each icon's dot, oracle vs pipeline. Asserts the pipeline's coverage is
 *     within a small ratio of the oracle's (not a 40x discrepancy).
 *   - STRAY INK: for the region near the triangle's apex (above the real
 *     exclamation bar, where nothing should paint), the pipeline's non-background
 *     pixel count must be comparably small to the oracle's, not a visible streak.
 *   - FULL-ICON DIFF: a coarse sampled pixel diff between oracle and pipeline
 *     over the WHOLE icon box, reported for context (stroke antialiasing differs
 *     between Skia and the browser's own rasterizer even when geometry matches,
 *     so this is informational, not a pass/fail gate by itself).
 *
 * Screenshots land in .claude_vlm_checks/svg_stroke_cap_oracle_<icon>_{native,ours}.png.
 *
 * Spawns its own Vite + headless Chromium (the svg_stroke_material_probe
 * pattern), renders our side through the SAME __powerrp_render seam the CLI
 * uses (?cli=1); the native side is a plain <img>-to-canvas draw on the same
 * page, so both share one Chromium's font/AA stack.
 *   node src/demo_apps/PowerRP/tests/svg_stroke_cap_oracle_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";
import { PNG } from "pngjs";
const readPng = (bytes) => PNG.sync.read(Buffer.from(bytes));

import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { newDocument, withNewItem, serialize } from "../core/document.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const FIXTURES = resolve(HERE, "fixtures/iconify");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const BOX = 240; // icon box size, px — big enough that a ~1px hairline is unambiguous
const W = BOX, H = BOX;
const BG = "#ffffff";
const INK = "#000000";

/** One case: an icon fixture + the box-local region (in BOX-sized pixels) where
 * a round-cap dot or near-closed apex idiom lives, so the probe can measure ink
 * coverage precisely instead of eyeballing a screenshot. Regions are in the
 * icon's 24x24 viewBox, scaled to BOX by (BOX/24) at probe time. */
const CASES = [
  {
    name: "tabler-alert-triangle",
    file: "tabler-alert-triangle.svg",
    dotVB: { cx: 12, cy: 16.005, halfW: 1.4, halfH: 1.4 }, // the "M12 16h.01" dot
    // The apex hairline region: a tight box around the triangle's TOP point
    // (~ (12, 2.6) in the 24x24 viewBox — see the manifest's endpoint math),
    // away from the real vertical exclamation bar (x=12, y 9..13) so it only
    // catches the near-closed-loop seam, not the intentional stroke.
    apexVB: { cx: 12, cy: 2.7, halfW: 2.2, halfH: 1.1 },
  },
  {
    name: "tabler-alert-circle",
    file: "tabler-alert-circle.svg",
    dotVB: { cx: 12, cy: 16.005, halfW: 1.4, halfH: 1.4 }, // "...m0 4h.01"
    apexVB: null, // no near-closed-loop idiom in this icon; dot-only case
  },
  {
    name: "tabler-circle-check",
    file: "tabler-circle-check.svg",
    dotVB: null, // no dot in this icon; it is the SHARP-CORNER control instead
    // The checkmark's sharp vee at (9,12)-(11,14)-(15,10) — a real miter/round
    // JOIN test (not a cap test): with round joins the outer corner is a small
    // arc; with Skia's default miter it is a sharp point. Region around the vee.
    apexVB: { cx: 11, cy: 13, halfW: 1.6, halfH: 1.6 },
  },
];

const registry = createRegistry();
registerAll(registry, createCommands());

/** Near-pure (fresh ids). One document: a single svg widget filling the box. */
function iconDoc(svgSrc) {
  let doc = newDocument();
  doc.meta = { ...doc.meta, slideW: W, slideH: H };
  const items0 = doc.slides[0].delta.items;
  const camId = Object.keys(items0)[0];
  items0[camId] = { ...items0[camId], x: 0, y: 0, w: W, h: H, background: BG };
  [doc] = withNewItem(doc, 0, {
    ...registry.get("svg").defaults, x: 0, y: 0, w: W, h: H,
    svgSrc, preserveAspect: true, strokeWidth: 0, active: true, z: 1,
  });
  return serialize(doc);
}

/** Pure function. viewBox-space region → BOX-pixel-space {x0,y0,x1,y1} (24x24
 * viewBox, uniform scale since preserveAspect:false + a square box + square
 * viewBox make the box→viewBox map uniform).
 * @example vbRegionToPx({cx: 12, cy: 16, halfW: 1, halfH: 1}, 240, 24) // {x0: 110, y0: 150, x1: 130, y1: 170}
 */
function vbRegionToPx(region, boxPx, viewBoxSize) {
  const s = boxPx / viewBoxSize;
  return {
    x0: Math.round((region.cx - region.halfW) * s), x1: Math.round((region.cx + region.halfW) * s),
    y0: Math.round((region.cy - region.halfH) * s), y1: Math.round((region.cy + region.halfH) * s),
  };
}

/** Pure function. True if a pixel is "ink" (far enough from the white background
 * to count as drawn content, not antialiasing noise).
 * @example isInkPixel([0,0,0,255], "#ffffff") // true
 * @example isInkPixel([255,255,255,255], "#ffffff") // false
 */
function isInkPixel(rgba, bgHex) {
  const bg = [parseInt(bgHex.slice(1, 3), 16), parseInt(bgHex.slice(3, 5), 16), parseInt(bgHex.slice(5, 7), 16)];
  const d = Math.abs(rgba[0] - bg[0]) + Math.abs(rgba[1] - bg[1]) + Math.abs(rgba[2] - bg[2]);
  const INK_THRESHOLD = 60; // sum of |ΔR|+|ΔG|+|ΔB|; antialiasing fringe is < ~30, real ink is ~765
  return d > INK_THRESHOLD;
}

/** Query. Ink pixel count within {x0,y0,x1,y1} of a decoded PNG. */
function inkCountInRegion(png, region, bgHex) {
  let n = 0;
  const x0 = Math.max(0, region.x0), x1 = Math.min(png.width, region.x1);
  const y0 = Math.max(0, region.y0), y1 = Math.min(png.height, region.y1);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * png.width + x) * 4;
    if (isInkPixel([png.data[i], png.data[i + 1], png.data[i + 2]], bgHex)) n++;
  }
  return n;
}

/** Query. Coarse sampled mean-abs pixel diff between two same-size PNGs. */
function coarseDiff(a, b, stride = 3) {
  let sum = 0, n = 0;
  for (let y = 0; y < a.height; y += stride) for (let x = 0; x < a.width; x += stride) {
    const i = (y * a.width + x) * 4;
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    n++;
  }
  return sum / (n * 3);
}

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const fails = [];
const ok = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const report = (msg) => console.log(`  ..   ${msg}`);

// Ratio bound for "comparable ink coverage" between oracle and pipeline in the
// dot region — the task's own framing ("not a 40x discrepancy"). 3x is already
// generous (Skia vs Chrome AA differ in edge pixel counts even when geometry
// matches); it catches "the dot barely exists" (empirically ~10-40x before the
// fix) while tolerating ordinary rasterizer AA differences.
const MAX_DOT_RATIO = 3;
// A stray-ink region should be near-empty in BOTH renders. A handful of AA
// fringe pixels from the real adjacent stroke geometry is expected; a genuine
// hairline artifact reads as tens of pixels the oracle does not have.
const MAX_STRAY_INK_ABOVE_ORACLE = 12;

try {
  const page = await browser.newPage();
  let pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${baseUrl}/?cli=1`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_render, { timeout: 40000 });

  /** Native oracle: draws the raw SVG source via <img> onto a BOXxBOX canvas,
   * white background, and returns its PNG bytes. Runs IN the same Chromium as
   * our pipeline render, so both share one AA/font stack — the only variable
   * under test is the two rasterizers' stroke-cap/join handling. */
  const renderNative = async (svgSrc, boxPx, bg) => {
    const dataUrl = await page.evaluate(async (src, box, bgHex) => {
      const canvas = document.createElement("canvas");
      canvas.width = box; canvas.height = box;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = bgHex; ctx.fillRect(0, 0, box, box);
      ctx.fillStyle = "#000000"; // currentColor resolution for an <img> is the CSS color; force via a colored wrapper below instead
      const blob = new Blob([src], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      ctx.drawImage(img, 0, 0, box, box);
      URL.revokeObjectURL(url);
      return canvas.toDataURL("image/png");
    }, svgSrc, boxPx, bg);
    return readPng(Buffer.from(dataUrl.split(",")[1], "base64"));
  };

  /** Our pipeline: renders the icon through the SVG widget + __powerrp_render
   * (the exact CLI/render-job seam), at the same box size. */
  const renderOurs = async (svgSrc, boxPx) => {
    pageErrors = [];
    const dataUrl = await page.evaluate(
      (json, w, h) => window.__powerrp_render(json, { slide: 0, width: w, height: h }),
      iconDoc(svgSrc), boxPx, boxPx,
    );
    return { png: readPng(Buffer.from(dataUrl.split(",")[1], "base64")), errors: [...pageErrors] };
  };

  // currentColor resolves against the CSS color of the <img>'s context, which a
  // plain <img> draw does not inherit (SVG in an <img> is opaque to CSS
  // currentColor from the host document) — so bake the ink color directly into
  // the fixture text for the oracle render, mirroring what the pipeline does via
  // its own `ink` resolution (both sides end up drawing the SAME literal color).
  const bakeInk = (src) => src.replace(/currentColor/g, INK);

  for (const c of CASES) {
    const raw = fs.readFileSync(resolve(FIXTURES, c.file), "utf8");
    const svgSrc = bakeInk(raw);

    const nativePng = await renderNative(svgSrc, BOX, BG);
    const { png: oursPng, errors } = await renderOurs(svgSrc, BOX);
    fs.writeFileSync(resolve(SHOTS, `svg_stroke_cap_oracle_${c.name}_native.png`), PNG.sync.write(nativePng));
    fs.writeFileSync(resolve(SHOTS, `svg_stroke_cap_oracle_${c.name}_ours.png`), PNG.sync.write(oursPng));

    ok(errors.length === 0, `${c.name}: our pipeline renders with ZERO uncaught errors${errors.length ? ` — ${errors[0]}` : ""}`);

    const wholeDiff = coarseDiff(nativePng, oursPng);
    report(`${c.name}: whole-icon coarse mean-abs diff = ${wholeDiff.toFixed(2)} (informational — AA differs even when geometry matches)`);

    if (c.dotVB) {
      const region = vbRegionToPx(c.dotVB, BOX, 24);
      const nativeDot = inkCountInRegion(nativePng, region, BG);
      const oursDot = inkCountInRegion(oursPng, region, BG);
      const ratio = oursDot === 0 ? Infinity : nativeDot / oursDot;
      report(`${c.name}: dot ink coverage — native=${nativeDot}px ours=${oursDot}px (region ${JSON.stringify(region)})`);
      ok(oursDot > 0, `${c.name}: the dot paints SOME ink (native has ${nativeDot}px; ours must be non-zero)`);
      ok(ratio <= MAX_DOT_RATIO && ratio >= 1 / MAX_DOT_RATIO,
        `${c.name}: dot ink coverage is comparable to native (ratio ${ratio.toFixed(2)}, bound ${MAX_DOT_RATIO}x) — not a hairline sliver`);
    }

    if (c.apexVB) {
      const region = vbRegionToPx(c.apexVB, BOX, 24);
      const nativeApex = inkCountInRegion(nativePng, region, BG);
      const oursApex = inkCountInRegion(oursPng, region, BG);
      report(`${c.name}: apex/join region ink — native=${nativeApex}px ours=${oursApex}px (region ${JSON.stringify(region)})`);
      ok(oursApex <= nativeApex + MAX_STRAY_INK_ABOVE_ORACLE,
        `${c.name}: no stray ink beyond native near the apex/join (ours ${oursApex}px vs native ${nativeApex}px, bound +${MAX_STRAY_INK_ABOVE_ORACLE}px)`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED:`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll svg stroke-cap oracle checks passed.");
