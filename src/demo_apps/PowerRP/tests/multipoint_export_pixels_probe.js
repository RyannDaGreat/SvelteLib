/** Real Skia → hybrid SVG/PDF → browser pixels. No mock PNG or external PDF binary.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_export_pixels_probe.js
 * Evidence: .scratchpad/multipoint/export_pixels (control / result / 4× RGB diff).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { PNG } from "pngjs";
import { PDFDocument, PDFName, PDFArray, decodePDFRawStream } from "pdf-lib";
import { rect, path, pushTransform, popTransform } from "../render_gpu/ir.js";
import { irToSVG } from "../render_gpu/svg_backend.js";
import { irToPDF } from "../render_gpu/pdf_backend.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { MULTIPOINT_PRESETS } from "../core/multipoint_presets.js";
import { multipointFeature } from "../core/multipoint.js";
import { imageDistance, readPng } from "./imageDistinctness.js";
import { launchBrowser } from "./puppeteerLaunch.js";
import { freePort } from "./free_port.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = resolve(ROOT, ".scratchpad/multipoint/export_pixels");
const WIDTH = 480, HEIGHT = 320;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const BACKGROUND = "#23394b";
const TIMEOUT = 120_000;
const INTERIOR_CODES = 6; // rounding/resampling allowance; not a whole-page mean
const EDGE_MEAN_CODES = 14; // separate coverage AA engines at native output size
const EDGE_P99_CODES = 90;
const EDGE_RADIUS = 2; // exclude two-pixel AA neighbourhood from interior checks
const DIFF_GAIN = 4;
const BEFORE = rect({ x: 12, y: 12, w: 29, h: 23, fill: "#ff9a23" });
const AFTER = rect({ x: 405, y: 255, w: 37, h: 31, fill: "#25e2ac" });
const NEON = MULTIPOINT_PRESETS.find(p => p.id === "neon-spiral").paint;
const TRANSPARENT = { type: "multipointGradient", multipoint: { features: [
  [0.12, 0.15, "#ff403080"], [0.85, 0.2, "#24ffe0c0"], [0.5, 0.85, "#8c42ff40"],
].map(([x, y, color]) => ({ ...multipointFeature("point", color), nodes: [[x, y, 0, 0, 0, 0]] })) } };
const CASES = [
  { name: "neon-spiral", op: rect({ x: 85, y: 65, w: 170, h: 170, fill: NEON }) },
  { name: "source-alpha-op-opacity", op: rect({ x: 90, y: 75, w: 220, h: 130, fill: TRANSPARENT, opacity: 0.375 }) },
  { name: "transformed-curve-stroke", world: { x: 110, y: 75, rotation: 0.23, scale: 1.1 },
    op: path({ d: "M 0 20 C 35 -10 155 -10 190 25 L 170 85 C 110 110 30 95 0 20 Z",
      fill: NEON, stroke: TRANSPARENT, strokeWidth: 18, opacity: 0.8 }) },
];
const report = { cases: [], errors: [], notices: [], failures: [] };
let server, browser, stage = "setup";
const originalError = console.error;
// Exporters deliberately report hybrid routing via console.error. Everything
// else (including renderer containment/solver errors) is fatal, never hidden.
console.error = (...args) => {
  originalError(...args);
  const message = args.map(String).join(" ");
  if (/^PowerRP (SVG|PDF) export: Multipoint paints have no native/.test(message)) report.notices.push(message);
  else report.errors.push(message);
};

/**
 * Pure function. Surrounds an op with its optional world transform.
 * @param {object} fixture - Case with optional world. @param {object} op - IR op.
 * @returns {object[]} Balanced IR.
 * @example wrapped({}, BEFORE) // [BEFORE]
 */
function wrapped(fixture, op) {
  return fixture.world ? [pushTransform(fixture.world), op, popTransform()] : [op];
}

/**
 * Pure function. Selects full-coverage interiors and their two-pixel AA border.
 * @param {object} mask - Decoded (H,W,4) RGBA PNG; e.g. (320,480,4).
 * @param {object} reference - Same-size control; separates sharp internal field edges.
 * @returns {{interior:number[],edge:number[]}} Pixel indices, not byte offsets.
 * @example regions(opaqueMask, control).interior // indices at least two pixels inside ink
 */
function regions(mask, reference) {
  const interior = [], edge = [];
  for (let y = EDGE_RADIUS; y < mask.height - EDGE_RADIUS; y++) for (let x = EDGE_RADIUS; x < mask.width - EDGE_RADIUS; x++) {
    let lo = 255, hi = 0;
    for (let dy = -EDGE_RADIUS; dy <= EDGE_RADIUS; dy++) for (let dx = -EDGE_RADIUS; dx <= EDGE_RADIUS; dx++) {
      const a = mask.data[4 * ((y + dy) * mask.width + x + dx) + 3];
      lo = Math.min(lo, a); hi = Math.max(hi, a);
    }
    // Two-sided diffusion curves contain sharp INTERNAL color boundaries too.
    // Classify using reference alone, never observed error (which could hide bugs).
    const p = y * mask.width + x;
    let variation = 0;
    for (let dy = -EDGE_RADIUS; dy <= EDGE_RADIUS; dy++) for (let dx = -EDGE_RADIUS; dx <= EDGE_RADIUS; dx++)
      for (let c = 0; c < 3; c++) variation = Math.max(variation, Math.abs(reference.data[4*p+c] - reference.data[4*((y+dy)*mask.width+x+dx)+c]));
    const SMOOTH_NEIGHBOUR_CODES = 16; // one 4-bit color bin across the AA neighbourhood
    if (lo === 255 && variation <= SMOOTH_NEIGHBOUR_CODES) interior.push(p);
    else if (hi > 0) edge.push(p);
  }
  return { interior, edge };
}

/**
 * Pure function. Per-pixel maximum RGBA errors over a nonempty region.
 * @param {object} a - (H,W,4) RGBA reference. @param {object} b - Same-size result.
 * @param {number[]} indices - Selected pixels, e.g. mask interior.
 * @returns {object} Mean, p99 and worst channel error in 8-bit codes.
 * @example stats(image, image, [0,1]) // {count:2, mean:0, p99:0, max:0}
 */
function stats(a, b, indices) {
  assert.ok(indices.length, "nonempty comparison region");
  const errors = indices.map(p => Math.max(...[0, 1, 2, 3].map(c => Math.abs(a.data[4*p+c] - b.data[4*p+c])))).sort((x,y) => x-y);
  return { count: errors.length, mean: errors.reduce((s,x) => s+x, 0)/errors.length,
    p99: errors[Math.floor((errors.length-1)*0.99)], max: errors.at(-1) };
}

/**
 * Command. Writes control/result/amplified RGB difference side by side.
 * @param {string} name - Output filename stem. @param {object} a - (320,480,4) RGBA.
 * @param {object} b - Same-sized comparison. @returns {Promise<void>}
 * @example await triptych('neon-svg', control, svg) // writes neon-svg-triptych.png
 */
async function triptych(name, a, b) {
  const out = new PNG({ width: WIDTH * 3, height: HEIGHT });
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const src = 4*(y*WIDTH+x);
    for (let panel = 0; panel < 3; panel++) {
      const dst = 4*(y*out.width+panel*WIDTH+x);
      for (let c = 0; c < 3; c++) out.data[dst+c] = panel === 0 ? a.data[src+c] : panel === 1 ? b.data[src+c] : Math.min(255, DIFF_GAIN*Math.abs(a.data[src+c]-b.data[src+c]));
      out.data[dst+3] = 255;
    }
  }
  await writeFile(resolve(OUT, `${name}-triptych.png`), PNG.sync.write(out));
}

/**
 * Command. Native SVG image decode or legacy pdf.js page render in Chromium.
 * @param {object} page - Puppeteer page. @param {string} format - svg or pdf.
 * @param {string|Uint8Array} bytes - Actual export. @returns {Promise<Buffer>} (320,480,4) PNG.
 * @example await roundtrip(page, 'svg', exportedSVG) // actual browser PNG bytes
 */
async function roundtrip(page, format, bytes) {
  const data = Buffer.from(bytes).toString("base64");
  const uri = await page.evaluate(async ({ format, data, width, height }) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (format === "svg") {
      const image = new Image(); image.src = `data:image/svg+xml;base64,${data}`;
      await image.decode(); ctx.drawImage(image, 0, 0);
    } else {
      const pdfjs = await import("/node_modules/pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
      const doc = await pdfjs.getDocument({ data: Uint8Array.from(atob(data), c => c.charCodeAt(0)) }).promise;
      try {
        const pdfPage = await doc.getPage(1), viewport = pdfPage.getViewport({ scale: 1 });
        if (viewport.width !== width || viewport.height !== height) throw new Error(`PDF viewport ${viewport.width}x${viewport.height}`);
        await pdfPage.render({ canvasContext: ctx, canvas, viewport }).promise;
      } finally { await doc.destroy(); }
    }
    return canvas.toDataURL("image/png");
  }, { format, data, width: WIDTH, height: HEIGHT });
  return Buffer.from(uri.split(",")[1], "base64");
}

try {
  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, "blank.html"), '<!doctype html><title>Multipoint export pixels</title><link rel="icon" href="data:,">');
  server = await createServer({ configFile: false, root: ROOT, cacheDir: resolve(OUT, `vite-cache-${process.pid}`),
    server: { host: "127.0.0.1", port: await freePort(), strictPort: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true } });
  await server.listen();
  browser = await launchBrowser({ protocolTimeout: TIMEOUT });
  const page = await browser.newPage();
  page.on("pageerror", e => console.error(e.stack ?? e.message));
  page.on("console", m => { if (["error", "warn"].includes(m.type())) console.error(`BROWSER ${m.type()}: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/.scratchpad/multipoint/export_pixels/blank.html`);
  for (const fixture of CASES) {
    stage = `${fixture.name}: control renderToPng`;
    console.log(stage);
    const commands = [BEFORE, ...wrapped(fixture, fixture.op), AFTER];
    const options = { width: WIDTH, height: HEIGHT, view: VIEW, background: BACKGROUND };
    await writeFile(resolve(OUT, `${fixture.name}-ir.json`), JSON.stringify({ commands, options }, null, 2));
    const controlBytes = await renderToPng(commands, VIEW, options), control = readPng(controlBytes);
    await writeFile(resolve(OUT, `${fixture.name}-control.png`), controlBytes);
    const maskOp = { ...fixture.op, fill: [1,1,1,1], stroke: fixture.op.stroke ? [1,1,1,1] : null, opacity: 1 };
    const maskBytes = await renderToPng(wrapped(fixture, maskOp), VIEW, { ...options, background: "#00000000" });
    await writeFile(resolve(OUT, `${fixture.name}-mask.png`), maskBytes);
    const region = regions(readPng(maskBytes), control);
    assert.ok(region.interior.length > 1000, "substantial shape interior, not empty/error output");
    const bins = new Set(region.interior.map(p => [0,1,2].map(c => Math.floor(control.data[4*p+c]/16)).join(",")));
    assert.ok(bins.size >= 8, `${fixture.name}: actual multicolor variation, got ${bins.size} bins`);
    const result = { name: fixture.name, colorBins: bins.size, formats: {} }; report.cases.push(result);
    let doubleOpacity, strokeOutside = [];
    if (fixture.op.stroke) {
      const fillMask = readPng(await renderToPng(wrapped(fixture, { ...maskOp, stroke: null }), VIEW, { ...options, background: "#00000000" }));
      strokeOutside = region.interior.filter(p => fillMask.data[4*p+3] === 0);
      assert.ok(strokeOutside.length > 100, "visible outer stroke beyond geometric fill bounds");
      result.outerStrokePixels = strokeOutside.length;
    }
    // Independent alpha oracle: full-opacity source composited once over backdrop.
    if (fixture.name === "source-alpha-op-opacity") {
      const sourceBytes = await renderToPng(wrapped(fixture, { ...fixture.op, opacity: 1 }), VIEW, { ...options, background: "#00000000" });
      await writeFile(resolve(OUT, `${fixture.name}-source-transparent.png`), sourceBytes);
      const source = readPng(sourceBytes);
      const expected = { ...control, data: Buffer.from(control.data) };
      for (const p of region.interior) for (let c = 0; c < 3; c++) {
        const alpha = source.data[4*p+3]/255 * fixture.op.opacity;
        expected.data[4*p+c] = Math.round(source.data[4*p+c]*alpha + [35,57,75][c]*(1-alpha));
      }
      result.alphaOracle = stats(expected, control, region.interior);
      assert.ok(result.alphaOracle.max <= 2, JSON.stringify(result.alphaOracle));
      await writeFile(resolve(OUT, `${fixture.name}-alpha-oracle.png`), PNG.sync.write(expected));
      const wrong = await renderToPng([BEFORE, ...wrapped(fixture, { ...fixture.op, opacity: fixture.op.opacity ** 2 }), AFTER], VIEW, options);
      await writeFile(resolve(OUT, `${fixture.name}-wrong-double-opacity.png`), wrong);
      doubleOpacity = readPng(wrong);
    }
    for (const [format, exporter] of [["svg", irToSVG], ["pdf", irToPDF]]) {
      stage = `${fixture.name}: ${format} export`; const calls = [];
      /** Command. Records exact raster callback and invokes shared real Skia painter.
       * @param {object[]} cmds - Balanced IR. @param {object} view - Crop view.
       * @param {number} width - Pixels. @param {number} height - Pixels. @param {*} background - Clear.
       * @returns {Promise<Uint8Array>} Real encoded RGBA PNG. @example await rasterize(cmds, VIEW, 480, 320, BACKGROUND)
       */
      const rasterize = async (cmds, view, width, height, background) => {
        const call = { commands: cmds, view, width, height, background }; calls.push(call);
        await writeFile(resolve(OUT, `${fixture.name}-${format}-raster-call.json`), JSON.stringify(call, null, 2));
        const png = await renderToPng(cmds, view, { width, height, background });
        await writeFile(resolve(OUT, `${fixture.name}-${format}-tile.png`), png); return png;
      };
      const bytes = await exporter(commands, { ...options, rasterize });
      await writeFile(resolve(OUT, `${fixture.name}.${format}`), bytes);
      assert.equal(calls.length, 1, "one actual Multipoint tile, not whole-page flattening");
      assert.ok(calls[0].commands.includes(fixture.op), "original op with original opacity reaches Skia");
      assert.ok(!calls[0].commands.includes(AFTER), "above-vector excluded from raster tile");
      assert.ok(calls[0].width < WIDTH*2 || calls[0].height < HEIGHT*2, "bounded fallback, not whole page");
      if (format === "svg") {
        const imageAt = bytes.indexOf("<image");
        assert.ok(bytes.indexOf("rgba(255,154,35,1)") < imageAt && bytes.indexOf("rgba(255,154,35,1)") >= 0, "before remains SVG vector");
        assert.ok(bytes.indexOf("rgba(37,226,172,1)") > imageAt, "after remains SVG vector");
      } else {
        const doc = await PDFDocument.load(bytes), contents = doc.getPage(0).node.get(PDFName.of("Contents"));
        const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
        const stream = refs.map(ref => Buffer.from(decodePDFRawStream(doc.context.lookup(ref)).decode()).toString()).join("\n");
        await writeFile(resolve(OUT, `${fixture.name}-pdf-stream.txt`), stream);
        const imageAt = stream.indexOf("/Im1 Do");
        assert.ok(stream.indexOf("12 12 29 23 re") >= 0 && stream.indexOf("12 12 29 23 re") < imageAt, "before remains PDF vector");
        assert.ok(stream.indexOf("405 255 37 31 re") > imageAt, "after remains PDF vector");
      }
      stage = `${fixture.name}: ${format} browser roundtrip`;
      const actualBytes = await roundtrip(page, format, bytes), actual = readPng(actualBytes);
      await writeFile(resolve(OUT, `${fixture.name}-${format}.png`), actualBytes);
      await triptych(`${fixture.name}-${format}`, control, actual);
      const metrics = { whole: imageDistance(control, actual), interior: stats(control, actual, region.interior), edge: stats(control, actual, region.edge) };
      if (doubleOpacity) {
        metrics.doubleOpacity = stats(doubleOpacity, actual, region.interior);
        assert.ok(metrics.doubleOpacity.mean > 3 && metrics.interior.mean * 4 < metrics.doubleOpacity.mean,
          "roundtrip matches once-applied opacity, not twice-applied opacity");
      }
      if (strokeOutside.length) {
        metrics.outerStroke = stats(control, actual, strokeOutside);
        if (!(metrics.outerStroke.p99 <= INTERIOR_CODES && metrics.outerStroke.mean <= 2)) report.failures.push(`${stage}: stroke beyond fill bounds ${JSON.stringify(metrics.outerStroke)}`);
      }
      result.formats[format] = metrics; console.log(`${fixture.name} ${format}: ${JSON.stringify(metrics)}`);
      if (!(metrics.interior.p99 <= INTERIOR_CODES && metrics.interior.mean <= 2)) report.failures.push(`${stage}: interior ${JSON.stringify(metrics.interior)}`);
      if (!(metrics.edge.mean <= EDGE_MEAN_CODES && metrics.edge.p99 <= EDGE_P99_CODES)) report.failures.push(`${stage}: edge ${JSON.stringify(metrics.edge)}`);
      for (const marker of [BEFORE, AFTER]) {
        const p = (marker.y+5)*WIDTH+marker.x+5;
        assert.ok(stats(control, actual, [p]).max <= 1, "vector-neighbor pixels retained");
      }
      assert.deepEqual(report.errors, [], "no swallowed renderer/solver/browser errors");
    }
  }
  assert.deepEqual(report.failures, [], "pixel fidelity failures (all fixtures saved)");
  report.passed = true;
  console.log(`PASS: ${CASES.length} real Skia → SVG/PDF pixel roundtrips. Evidence: ${OUT}`);
} catch (error) {
  report.failure = { stage, message: error.message, stack: error.stack };
  originalError(`FAIL ${stage}; evidence ${OUT}`, error);
  process.exitCode = 1;
} finally {
  console.error = originalError;
  try { await browser?.close(); } finally { await server?.close(); }
  await writeFile(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));
}
