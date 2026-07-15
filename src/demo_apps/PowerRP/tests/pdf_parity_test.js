/**
 * WIDGET RENDER PARITY suite (manifest cornerstone rule: papers are PDFs —
 * every widget must export to PDF indistinguishably from its GPU render).
 *
 * For every scene in render_gpu/tests/pdf_scenes.js:
 *   1. GPU-render the scene (real WebGPU, readPixels) → EXPECTED pixels.
 *   2. irToPDF with the real GPU rasterize callback → PDF bytes.
 *   3. Rasterize the PDF with pdftoppm (poppler — the reference PDF
 *      rasterizer; chosen because it ships PPM output that parses with zero
 *      dependencies and takes an exact DPI) at the same pixel size.
 *   4. PSNR(expected, rasterized) must clear the scene's psnrFloor.
 * Plus the demo-doc acceptance: slide 1 exports selectable text (pdftotext)
 * and both demo slides export + rasterize cleanly.
 *
 * Artifacts (per scene: <name>_expected.png, <name>_pdf.png, <name>.pdf) go
 * in the REQUIRED output dir — inspect them visually; the suite is also the
 * VLM-inspection feed.
 *
 * Run: node src/demo_apps/PowerRP/tests/pdf_parity_test.js <out_dir>
 * Requires: pdftoppm + pdftotext on PATH (poppler; `brew install poppler`).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { scenes } from "../render_gpu/tests/pdf_scenes.js";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node pdf_parity_test.js <out_dir>   (artifact dir is REQUIRED — the images are the point)");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const tool of ["pdftoppm", "pdftotext"]) {
  try {
    execFileSync("which", [tool]);
  } catch {
    throw new Error(`${tool} not found on PATH — install poppler (brew install poppler); the parity suite depends on it`);
  }
}

/** Raster px per PDF pt — 2 matches the exporter's default rasterScale, so
 * hybrid raster regions compare 1:1 (no resampling). 144 dpi = 72 × 2. */
const K = 2;
const DPI = 72 * K;

/**
 * Pure function. Parses a binary P6 PPM into {w, h, rgb: Uint8Array}.
 *
 * @example // parsePPM(Buffer.from("P6\n2 1\n255\n" + "\x00".repeat(6), "latin1")).w // 2
 */
export function parsePPM(buf) {
  let pos = 0;
  const token = () => {
    while (buf[pos] === 0x23) { while (buf[pos] !== 0x0a) pos++; pos++; } // # comment lines
    let start = pos;
    while (!/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    const t = buf.slice(start, pos).toString("latin1");
    pos++; // single whitespace after token
    return t;
  };
  const magic = token();
  if (magic !== "P6") throw new Error(`parsePPM: not a P6 ppm (got "${magic}")`);
  const w = +token(), h = +token(), max = +token();
  if (max !== 255) throw new Error(`parsePPM: unsupported maxval ${max}`);
  return { w, h, rgb: new Uint8Array(buf.buffer, buf.byteOffset + pos, w * h * 3) };
}

/**
 * Pure function. PSNR (dB) between RGBA (expected) and RGB (actual) buffers
 * of the same w×h, over RGB channels. Identical images → Infinity.
 *
 * @example psnr(new Uint8Array([255,0,0,255]), new Uint8Array([255,0,0]), 1, 1) // Infinity
 * @example Math.round(psnr(new Uint8Array([255,0,0,255]), new Uint8Array([245,0,0]), 1, 1)) // 33 (10px error on one channel)
 */
export function psnr(rgba, rgb, w, h) {
  let se = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const d = rgba[i * 4 + c] - rgb[i * 3 + c];
      se += d * d;
    }
  }
  if (se === 0) return Infinity;
  const mse = se / (n * 3);
  return 10 * Math.log10((255 * 255) / mse);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(repoRoot, "vite.config.js"),
  root: repoRoot,
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: true });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { console.error(`  pageerror: ${e.message}`); failures++; });
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });

  // Warm the module graph once. Vite pre-bundles pdf-lib on FIRST import and
  // force-reloads the page, destroying the execution context mid-evaluate —
  // an expected, one-time event (it prints "optimized dependencies changed.
  // reloading"). Retry the warmup after the reload; any later navigation is
  // a real failure (retries exhausted → the error propagates).
  const WARMUP_TRIES = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await warmup(page);
      break;
    } catch (e) {
      if (attempt >= WARMUP_TRIES || !/Execution context was destroyed/.test(String(e))) throw e;
      console.log(`  (vite re-optimized deps and reloaded — warmup retry ${attempt})`);
      await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    }
  }
  async function warmup(page) {
  await page.evaluate(async () => {
    window.__mods = {
      compositor: await import("/src/demo_apps/PowerRP/render_gpu/gpu/compositor.js"),
      pdf: await import("/src/demo_apps/PowerRP/render_gpu/pdf_backend.js"),
      ir: await import("/src/demo_apps/PowerRP/render_gpu/ir.js"),
      scenes: await import("/src/demo_apps/PowerRP/render_gpu/tests/pdf_scenes.js"),
      doc: await import("/src/demo_apps/PowerRP/core/document.js"),
      derive: await import("/src/demo_apps/PowerRP/core/derive.js"),
      expr: await import("/src/demo_apps/PowerRP/core/expressions.js"),
      viewMod: await import("/src/demo_apps/PowerRP/core/view.js"),
      ports: await import("/src/demo_apps/PowerRP/render_gpu/ports.js"),
      registry: await import("/src/demo_apps/PowerRP/core/registry.js"),
      plugins: await import("/src/demo_apps/PowerRP/plugins/index.js"),
      commands: await import("/src/demo_apps/PowerRP/core/commands.js"),
    };
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    document.body.appendChild(canvas);
    window.__gpu = await window.__mods.compositor.GpuCompositor.create(canvas);
    window.__canvas = canvas;

    // The GPU rasterize callback irToPDF uses (and the expected-pixels path).
    window.__renderRaw = async (cmds, view, w, h, background) => {
      const gpu = window.__gpu, c = window.__canvas;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const bg = background == null ? [0, 0, 0, 0]
        : Array.isArray(background) ? background : window.__mods.ir.parseColor(background);
      gpu.render(cmds, view, { background: bg });
      return gpu.readPixels(0, 0, w, h);
    };
    window.__rasterizePng = async (cmds, view, w, h, background) => {
      const px = await window.__renderRaw(cmds, view, w, h, background);
      const c2 = document.createElement("canvas");
      c2.width = w;
      c2.height = h;
      c2.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
      const blob = await new Promise((res) => c2.toBlob(res, "image/png"));
      return new Uint8Array(await blob.arrayBuffer());
    };
    window.__b64 = (bytes) => {
      let s = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      return btoa(s);
    };

    // Measured baseline parity: the GPU atlas top-anchors text at the canvas
    // fontBoundingBoxAscent of ITS font stack; hand the measured fraction to
    // the PDF backend so baselines coincide (irToPDF textAscent).
    const { fontString } = await import("/src/demo_apps/PowerRP/render_gpu/gpu/glyph_atlas.js");
    const mctx = document.createElement("canvas").getContext("2d");
    const REF_SIZE = 100; // any size — the fraction is size-relative
    mctx.font = fontString(REF_SIZE, false);
    window.__textAscent = mctx.measureText("Mg").fontBoundingBoxAscent / REF_SIZE;
  });
  }

  const rasterizePdf = (pdfPath, prefix) => {
    execFileSync("pdftoppm", ["-r", String(DPI), pdfPath, prefix]);           // PPM for compare
    execFileSync("pdftoppm", ["-png", "-r", String(DPI), pdfPath, prefix]);   // PNG for eyes
    return parsePPM(readFileSync(`${prefix}-1.ppm`));
  };

  console.log(`\nscene parity (PSNR floor per scene; ${DPI} dpi vs GPU @${K}x):`);
  const psnrTable = [];
  for (const scene of scenes()) {
    const res = await page.evaluate(async (name, k) => {
      const { scenes } = window.__mods.scenes;
      const s = scenes().find((x) => x.name === name);
      const view = { zoom: s.view.zoom * k, panX: s.view.panX * k, panY: s.view.panY * k, dpr: 1 };
      const raw = await window.__renderRaw(s.commands, view, s.width * k, s.height * k, s.background);
      const expectedPng = await window.__rasterizePng(s.commands, view, s.width * k, s.height * k, s.background);
      const pdfBytes = await window.__mods.pdf.irToPDF(s.commands, {
        width: s.width, height: s.height, view: s.view, background: s.background,
        rasterize: window.__rasterizePng, textAscent: window.__textAscent,
      });
      return { raw: window.__b64(new Uint8Array(raw.buffer)), expectedPng: window.__b64(expectedPng), pdf: window.__b64(pdfBytes) };
    }, scene.name, K);

    const pdfPath = join(outDir, `${scene.name}.pdf`);
    writeFileSync(pdfPath, Buffer.from(res.pdf, "base64"));
    writeFileSync(join(outDir, `${scene.name}_expected.png`), Buffer.from(res.expectedPng, "base64"));
    const ppm = rasterizePdf(pdfPath, join(outDir, `${scene.name}_pdf`));
    const expected = Buffer.from(res.raw, "base64");

    const wPx = scene.width * K, hPx = scene.height * K;
    if (ppm.w !== wPx || ppm.h !== hPx) {
      check(`${scene.name}: size`, false, `pdf raster ${ppm.w}x${ppm.h} != expected ${wPx}x${hPx}`);
      continue;
    }
    const db = psnr(expected, ppm.rgb, wPx, hPx);
    psnrTable.push({ scene: scene.name, psnr: +db.toFixed(2), floor: scene.psnrFloor });
    check(`${scene.name}: PSNR ${db.toFixed(2)} dB >= ${scene.psnrFloor}`, db >= scene.psnrFloor);
  }
  console.log("PSNR_TABLE " + JSON.stringify(psnrTable));

  // ── demo-doc acceptance: real pipeline, selectable text, both slides ──────
  console.log("\ndemo-doc acceptance:");
  for (const slideIndex of [0, 2]) {
    const res = await page.evaluate(async (slideIndex, k) => {
      const M = window.__mods;
      const docJson = await (await fetch("/src/demo_apps/PowerRP/examples/demo.powerrp.json")).text();
      const doc = M.doc.deserialize(docJson);
      const registry = M.registry.createRegistry();
      M.plugins.registerAll(registry, M.commands.createCommands());
      const state = M.expr.evaluateState(M.doc.foldState(doc, slideIndex, 1), registry).state;
      const rect = M.derive.cameraRect(state, doc.meta);
      const nodes = M.derive.deriveRenderTree(state, registry);
      const ir = M.ports.sceneIR(nodes);
      const view = M.viewMod.fitRectView(rect, rect.w, rect.h, 1);
      const pdfBytes = await M.pdf.irToPDF(ir, {
        width: rect.w, height: rect.h, view, background: rect.background,
        rasterize: window.__rasterizePng, textAscent: window.__textAscent,
      });
      // Expected pixels through the same camera at k×
      const viewPx = { zoom: view.zoom * k, panX: view.panX * k, panY: view.panY * k, dpr: 1 };
      const raw = await window.__renderRaw(
        [M.ir.rect({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: M.ir.parseColor(rect.background) }), ...ir],
        viewPx, Math.round(rect.w * k), Math.round(rect.h * k), rect.background,
      );
      const expectedPng = await window.__rasterizePng(
        [M.ir.rect({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: M.ir.parseColor(rect.background) }), ...ir],
        viewPx, Math.round(rect.w * k), Math.round(rect.h * k), rect.background,
      );
      return {
        pdf: window.__b64(pdfBytes), raw: window.__b64(new Uint8Array(raw.buffer)), expectedPng: window.__b64(expectedPng),
        w: Math.round(rect.w * k), h: Math.round(rect.h * k),
      };
    }, slideIndex, K);

    const name = `demo-slide${slideIndex + 1}`;
    const pdfPath = join(outDir, `${name}.pdf`);
    writeFileSync(pdfPath, Buffer.from(res.pdf, "base64"));
    writeFileSync(join(outDir, `${name}_expected.png`), Buffer.from(res.expectedPng, "base64"));
    const ppm = rasterizePdf(pdfPath, join(outDir, `${name}_pdf`));
    check(`${name}: rasterizes at expected size`, ppm.w === res.w && ppm.h === res.h, `${ppm.w}x${ppm.h}`);
    if (ppm.w === res.w && ppm.h === res.h) {
      const db = psnr(Buffer.from(res.raw, "base64"), ppm.rgb, res.w, res.h);
      // Demo floor: measured 25.63 dB (slide 1, text-bearing) and 46.70 dB
      // (slide 3, hybrid) in the 2026-07 run; floor = weakest − ~5 dB.
      const DEMO_FLOOR = 20; // PENDING USER RATIFICATION with the scene floors
      check(`${name}: PSNR ${db.toFixed(2)} dB >= ${DEMO_FLOOR}`, db >= DEMO_FLOOR);
    }
    if (slideIndex === 0) {
      const txt = execFileSync("pdftotext", [pdfPath, "-"]).toString();
      check(`${name}: text is SELECTABLE (pdftotext finds the title)`, txt.includes("PowerRP V1"), JSON.stringify(txt.trim().slice(0, 40)));
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(failures === 0 ? "\npdf parity: all checks passed" : `\npdf parity: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
