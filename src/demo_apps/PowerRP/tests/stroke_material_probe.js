/**
 * STROKE-MATERIAL SHAPE MATRIX probe (browser) — the stroke-material framework's
 * gate, the twin of tests/material_fill_probe.js. EVERY registered stroke material
 * (strokeMaterialIds — the matrix grows automatically as materials are added) is
 * rendered as the STROKE of FOUR filled shapes PLUS one OPEN polyline:
 *
 *   rounded rect · circle · 5-point star (ss_polygonStar) · custom polygon blob ·
 *   open polyline (an unclosed polygon chain)
 *
 * over a busy underlay (a gradient + discs + text). Rendered camera-true through
 * the SAME __powerrp_render seam the CLI uses (?cli=1 — no editor UI), at world == px.
 *
 * PER CELL, TWO MACHINE ASSERTIONS against a shared NO-STROKE baseline (the same
 * shapes, stroke nulled — so only the OUTLINE can differ):
 *   OUTLINE — the material must have painted SOMETHING: counting the cell's pixels
 *             that DIFFER from the baseline must clear a floor. Combined with the
 *             interior check, that "something" is necessarily on/near the outline
 *             (a silently-skipped stroke, or a throw, fails here).
 *   INTERIOR— for the FILLED shapes, sample points deep in the interior (far from
 *             the outline) must MATCH the baseline: the stroke material must not
 *             bleed into the fill (a material stroke that mis-clipped, or that fell
 *             back to a full-region fill, fails here). The open polyline has no
 *             interior, so it asserts OUTLINE only.
 * Screenshots land in .claude_vlm_checks/stroke_material_<id>.png for the VLM look.
 *
 * Spawns its own Vite + headless Chromium (swiftshader), the material_fill_probe
 * pattern. Frontend-only. Run: node src/demo_apps/PowerRP/tests/stroke_material_probe.js
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
import { strokeMaterialIds, getStrokeMaterial } from "../render_gpu/skia/stroke_materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const W = 940, H = 300;
const BG = "#123f5a";
const CELL = 160;          // every shape sits in a CELL×CELL box
const STROKE_W = 14;       // a wide stroke so every material reads clearly

/** The five cells: id, widget type, geometry overrides, and whether it is FILLED
 * (so its interior can be asserted clean). The open polyline is unfilled. */
const CELLS = [
  { id: "rect", type: "rect", at: { x: 20, y: 70 }, over: { cornerRadius: 30 }, checkInterior: true },
  { id: "circle", type: "circle", at: { x: 205, y: 70 }, over: {}, checkInterior: true },
  { id: "star", type: "ss_polygonStar", at: { x: 390, y: 70 }, over: { points: 5, innerRatio: 0.45, startAngle: 0 }, checkInterior: true },
  {
    id: "custom", type: "polygon", at: { x: 575, y: 70 },
    over: { points: [[0.5, 0.02], [0.9, 0.25], [0.98, 0.7], [0.6, 0.98], [0.15, 0.85], [0.02, 0.4]], closed: true },
    checkInterior: true,
  },
  {
    // An OPEN polyline (unclosed polygon chain). Its "interior" is not a filled
    // region and the chain crosses the cell centre, so it asserts OUTLINE only.
    id: "polyline", type: "polygon", at: { x: 760, y: 70 },
    over: { points: [[0.05, 0.2], [0.32, 0.85], [0.62, 0.12], [0.95, 0.78]], closed: false },
    checkInterior: false,
  },
];

/** Interior sample points (cell-local px) — center + four inset probes, all deep
 * inside every closed silhouette and clear of a 14px edge stroke (nearest is
 * ~0.28·CELL ≈ 45px from any edge). The shapes are UNFILLED, so these points are
 * pure UNDERLAY: a correct edge stroke leaves them byte-identical to the baseline,
 * a stroke material that mis-clipped into a full-region fill does not. */
const INTERIOR = [[CELL / 2, CELL / 2], [CELL / 2, CELL * 0.36], [CELL * 0.36, CELL / 2], [CELL * 0.64, CELL / 2], [CELL / 2, CELL * 0.64]];
/** Per-channel tolerance for "same as baseline" and the minimum mean-abs diff for
 * "this pixel changed". */
const SAME_TOL = 3;
const DIFF_MIN = 8;
/** Cell grid step (px) for counting changed pixels, and the floor a stroke must
 * clear. A 14px stroke around any of these silhouettes changes many hundreds of
 * grid cells; even a dashed/dotted one clears this comfortably. */
const GRID_STEP = 4;
const MIN_CHANGED = 40;

const registry = createRegistry();
registerAll(registry, createCommands());

/** Near-pure (fresh ids). One matrix document: underlay + camera + the five shapes.
 * The shapes are UNFILLED (fill: null) on purpose: `materialId` null = the BASELINE
 * (shapes invisible — pure underlay), an id = the same shapes carrying that material
 * as their STROKE. So a test-vs-baseline diff is EXACTLY the stroke — no fill to
 * confound it — and the underlay is byte-identical in both (the cells draw nothing
 * in the baseline). */
function matrixDoc(materialId) {
  let doc = newDocument(), z = 1;
  // Configure THE mandatory camera (the only item newDocument creates) to W×H so
  // the render maps world 1:1 to output px. ADDING a second camera is wrong: repair
  // keeps exactly one and which survives is UUID-order luck, so a second camera
  // silently left the DEFAULT 1280×720 camera in place and rescaled the whole scene.
  doc.meta = { ...doc.meta, slideW: W, slideH: H };
  const items0 = doc.slides[0].delta.items;
  const camId = Object.keys(items0)[0];
  items0[camId] = { ...items0[camId], x: 0, y: 0, w: W, h: H, background: BG };
  const add = (type, over) => { [doc] = withNewItem(doc, 0, { ...registry.get(type).defaults, ...over, active: true, z: z++ }); };
  // Busy underlay so a stroke that spills past its silhouette is visible against tone.
  add("rect", {
    x: 0, y: 0, w: W, h: H, strokeWidth: 0,
    fill: { type: "linearGradient", solid: "#ffffff", linear: { stops: [{ offset: 0, color: "#ffd166" }, { offset: 0.5, color: "#ef476f" }, { offset: 1, color: "#118ab2" }], angle: 20 }, radial: { stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } },
  });
  for (let i = 0; i < 7; i++) add("circle", { x: 30 + i * 130, y: (i % 2) * 150 + 20, w: 110, h: 110, fill: i % 2 ? "#06d6a0" : "#f8f9fa", strokeWidth: 0 });
  add("text", { x: 16, y: 8, w: 900, h: 46, text: "STROKE MATERIAL MATRIX — outline of every cell", size: 30, color: "#1b1b2f", bold: true });
  for (const cell of CELLS) {
    add(cell.type, {
      x: cell.at.x, y: cell.at.y, w: CELL, h: CELL,
      ...cell.over,
      fill: null,
      stroke: materialId ? { type: "material", material: { id: materialId, params: {} } } : null,
      strokeWidth: materialId ? STROKE_W : 0,
    });
  }
  return serialize(doc);
}

/** Pure function. Mean absolute RGB difference between two decoded PNGs at one
 * pixel. @example (identical pixels) // 0 */
function pixelDiff(a, b, x, y) {
  const i = (y * a.width + x) * 4;
  return (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
}

/** Pure function. Count of cell-grid points whose colour changed from baseline. */
function changedPixels(png, baseline, cell) {
  let n = 0;
  for (let dy = 2; dy < CELL - 2; dy += GRID_STEP)
    for (let dx = 2; dx < CELL - 2; dx += GRID_STEP)
      if (pixelDiff(png, baseline, cell.at.x + dx, cell.at.y + dy) > DIFF_MIN) n++;
  return n;
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

  const baseline = await render(matrixDoc(null)); // fills present, NO stroke — the stroke-isolating baseline
  fs.writeFileSync(resolve(SHOTS, `stroke_material_baseline.png`), PNG.sync.write(baseline));
  const ids = strokeMaterialIds();
  ok(ids.length > 0, `stroke materials registered (${ids.join(", ")})`);

  for (const id of ids) {
    const png = await render(matrixDoc(id));
    fs.writeFileSync(resolve(SHOTS, `stroke_material_${id}.png`), PNG.sync.write(png));
    for (const cell of CELLS) {
      const changed = changedPixels(png, baseline, cell);
      ok(changed >= MIN_CHANGED, `${id} on ${cell.id}: stroke PAINTED the outline (${changed} changed grid pts >= ${MIN_CHANGED})`);
      if (cell.checkInterior) {
        for (const [dx, dy] of INTERIOR) {
          const d = pixelDiff(png, baseline, cell.at.x + Math.round(dx), cell.at.y + Math.round(dy));
          ok(d <= SAME_TOL, `${id} on ${cell.id}: interior UNTOUCHED at +${Math.round(dx)},+${Math.round(dy)} (diff ${d.toFixed(1)} <= ${SAME_TOL})`);
        }
      }
    }
    console.log(`  shot .claude_vlm_checks/stroke_material_${id}.png  (${getStrokeMaterial(id).title})`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nFAILED: ${fails.length} — stroke material matrix`);
  process.exit(1);
}
console.log("\nPASS — stroke material matrix (every stroke material × 4 shapes incl. custom + an open polyline)");
