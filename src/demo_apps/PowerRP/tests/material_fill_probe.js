/**
 * MATERIAL-FILL SHAPE MATRIX probe (browser) — the fill-material framework's
 * gate: EVERY fill-capable material (materials.fillCapableMaterialIds — the
 * matrix grows automatically as materials opt in) is rendered as the FILL of
 * FOUR shapes, including a custom outline:
 *
 *   rounded rect · circle · 5-point star (ss_polygonStar) · custom polygon blob
 *
 * over a busy underlay (a gradient + discs + text — backdrop materials need
 * tone beneath to transform). Rendered camera-true through the SAME
 * __powerrp_render seam the CLI uses (?cli=1 — no editor UI), at world == px.
 *
 * PER CELL, TWO MACHINE ASSERTIONS against a shared no-shapes BASELINE:
 *   INSIDE  — interior sample points must DIFFER from the baseline (the
 *             material actually painted; a silently-skipped fill fails here);
 *   OUTSIDE — bbox-corner samples (outside the silhouette, away from AA) must
 *             MATCH the baseline (the clip held; a material bleeding past its
 *             shape fails here).
 * Screenshots land in .claude_vlm_checks/material_fill_<id>.png for the VLM
 * look-pass.
 *
 * Spawns its own Vite + headless Chromium (swiftshader), the fontpicker_probe
 * pattern. Frontend-only. Run: node src/demo_apps/PowerRP/tests/material_fill_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";
import { PNG } from "pngjs";
// puppeteer ≥23 returns screenshot/data bytes as Uint8Array; pngjs wants Buffer.
const readPng = (bytes) => PNG.sync.read(Buffer.from(bytes));

import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { newDocument, withNewItem, serialize } from "../core/document.js";
import { fillCapableMaterialIds, getMaterial, isBackdropMaterial } from "../render_gpu/skia/materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const W = 920, H = 300;
const BG = "#123f5a";
/** The four shape cells: id, widget type, geometry overrides. Every cell is a
 * 180×180 box; the OUTSIDE sample offsets are chosen per silhouette to sit
 * well clear of antialiasing. */
const CELL = 180;
const CELLS = [
  { id: "rect", type: "rect", at: { x: 40, y: 60 }, over: { cornerRadius: 40 }, outside: [[6, 6], [CELL - 6, 6]] },
  { id: "circle", type: "circle", at: { x: 260, y: 60 }, over: {}, outside: [[10, 10], [CELL - 10, CELL - 10]] },
  { id: "star", type: "ss_polygonStar", at: { x: 480, y: 60 }, over: { points: 5, innerRatio: 0.45, startAngle: 0 }, outside: [[8, 8], [CELL - 8, 8]] },
  {
    id: "custom", type: "polygon", at: { x: 700, y: 60 },
    over: { points: [[0.5, 0.02], [0.9, 0.25], [0.98, 0.7], [0.6, 0.98], [0.15, 0.85], [0.02, 0.4]], closed: true },
    outside: [[CELL - 4, 4], [4, CELL - 4]],
  },
];
/** Interior sample points (cell-local px) — center + four inset probes, all
 * inside every one of the four silhouettes. */
const INSIDE = [[CELL / 2, CELL / 2], [CELL / 2, CELL * 0.32], [CELL * 0.38, CELL / 2], [CELL * 0.62, CELL / 2], [CELL / 2, CELL * 0.66]];
/** Per-channel tolerance for "same as baseline" (raster noise) and the minimum
 * mean-abs difference for "the material painted here". */
const SAME_TOL = 3;
const DIFF_MIN = 4;

const registry = createRegistry();
registerAll(registry, createCommands());

/** Near-pure (fresh ids). One matrix document: underlay + camera (+ the four
 * material-filled shapes unless `withShapes` is false — the baseline). */
function matrixDoc(materialId, withShapes) {
  let doc = newDocument(), z = 1;
  const add = (type, over) => { [doc] = withNewItem(doc, 0, { ...registry.get(type).defaults, ...over, active: true, z: z++ }); };
  add("camera", { name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, background: BG });
  // The underlay backdrop materials transform: a bright gradient band + discs + text.
  add("rect", {
    x: 0, y: 0, w: W, h: H, strokeWidth: 0,
    fill: { type: "linearGradient", solid: "#ffffff", linear: { stops: [{ offset: 0, color: "#ffd166" }, { offset: 0.5, color: "#ef476f" }, { offset: 1, color: "#118ab2" }], angle: 20 }, radial: { stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } },
  });
  for (let i = 0; i < 7; i++) add("circle", { x: 30 + i * 130, y: (i % 2) * 150 + 20, w: 110, h: 110, fill: i % 2 ? "#06d6a0" : "#f8f9fa", strokeWidth: 0 });
  add("text", { x: 20, y: 120, w: 880, h: 60, text: "MATERIAL FILL MATRIX — tone under every cell", size: 40, color: "#1b1b2f", bold: true });
  if (withShapes) {
    for (const cell of CELLS) {
      add(cell.type, {
        x: cell.at.x, y: cell.at.y, w: CELL, h: CELL, strokeWidth: 0,
        ...cell.over,
        fill: { type: "material", material: { id: materialId, params: {} } },
      });
    }
  }
  return serialize(doc);
}

/** Pure function. Mean absolute RGB difference between two decoded PNGs at one
 * pixel. @example (identical pixels) // 0 */
function pixelDiff(a, b, x, y) {
  const i = (y * a.width + x) * 4;
  return (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
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

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => fails.push(`pageerror: ${e.message}`));
  await page.goto(`${baseUrl}/?cli=1`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_render, { timeout: 40000 });

  const render = async (docJson) => {
    const dataUrl = await page.evaluate(
      (json, w, h) => window.__powerrp_render(json, { slide: 0, width: w, height: h }),
      docJson, W, H,
    );
    return readPng(Buffer.from(dataUrl.split(",")[1], "base64"));
  };

  const baseline = await render(matrixDoc("none", false));
  const ids = fillCapableMaterialIds();
  ok(ids.length > 0, `fill-capable materials registered (${ids.join(", ")})`);

  for (const id of ids) {
    const png = await render(matrixDoc(id, true));
    fs.writeFileSync(resolve(SHOTS, `material_fill_${id}.png`), PNG.sync.write(png));
    for (const cell of CELLS) {
      const insideDiff = INSIDE.map(([dx, dy]) => pixelDiff(png, baseline, cell.at.x + Math.round(dx), cell.at.y + Math.round(dy)));
      const meanInside = insideDiff.reduce((a, b) => a + b, 0) / insideDiff.length;
      ok(meanInside >= DIFF_MIN, `${id} on ${cell.id}: material PAINTED the interior (mean diff ${meanInside.toFixed(1)} >= ${DIFF_MIN})`);
      for (const [dx, dy] of cell.outside) {
        const d = pixelDiff(png, baseline, cell.at.x + dx, cell.at.y + dy);
        ok(d <= SAME_TOL, `${id} on ${cell.id}: clip HELD outside the silhouette at +${dx},+${dy} (diff ${d.toFixed(1)} <= ${SAME_TOL})`);
      }
    }
    console.log(`  shot .claude_vlm_checks/material_fill_${id}.png  (${isBackdropMaterial(getMaterial(id)) ? "backdrop" : "foreground"})`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nFAILED: ${fails.length} — material fill matrix`);
  process.exit(1);
}
console.log("\nPASS — material fill matrix (every fill-capable material × 4 shapes incl. custom)");
