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
  // Configure THE mandatory camera (the only item newDocument creates) to W×H, so
  // the render maps world 1:1 to output px. ADDING a second camera is a latent bug:
  // repair keeps exactly one and picks the lexicographically-SMALLEST uuid
  // (core/document.js withExtraCamerasDropped), so ~half the time the DEFAULT
  // 1280×720 camera survived instead, rescaled the scene, and the outside-silhouette
  // clip checks failed — a 50/50 flaky gate that only passed at commit time by luck.
  doc.meta = { ...doc.meta, slideW: W, slideH: H };
  const items0 = doc.slides[0].delta.items;
  const camId = Object.keys(items0)[0];
  items0[camId] = { ...items0[camId], x: 0, y: 0, w: W, h: H, background: BG };
  const add = (type, over) => { [doc] = withNewItem(doc, 0, { ...registry.get(type).defaults, ...over, active: true, z: z++ }); };
  // The underlay backdrop materials transform: a bright gradient band + discs + text.
  add("rect", {
    x: 0, y: 0, w: W, h: H, strokeWidth: 0,
    fill: { type: "linearGradient", solid: "#ffffff", linear: { stops: [{ offset: 0, color: "#ffd166" }, { offset: 0.5, color: "#ef476f" }, { offset: 1, color: "#118ab2" }], angle: 20 }, radial: { stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } },
  });
  // NO discs near the cell corners: a backdrop material triggers a REGION
  // re-render of the scene beneath, and Skia's antialiased rims are not
  // invariant under that (the documented materials.js maxSampleReach wobble,
  // ±dozens of levels ON CURVED EDGES ONLY) — two agents independently traced
  // the first matrix's outside-clip "failures" to the no-shapes BASELINE
  // differing at disc rims, not to any clip leak. The OUTSIDE samples must sit
  // on rasterization-STABLE flat gradient, so the underlay keeps its tone
  // variety INSIDE the cells (gradient band + text) and puts its discs in the
  // horizontal gutter strip that no cell's corner samples touch.
  for (let i = 0; i < 4; i++) add("circle", { x: 120 + i * 220, y: 95, w: 110, h: 110, fill: i % 2 ? "#06d6a0" : "#f8f9fa", strokeWidth: 0 });
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
const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

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
  // ── REGRESSION: a material fill on a PAINT_PATH (a `path`-op emitter, not a
  // box shape) must resolve and paint without error. Pinned after a user's live
  // deck carried glass (with a stale knob) + a brush material stroke + trims on
  // a paint_path — the op class this matrix's four box cells never covered. The
  // render must produce ZERO page errors (the "reached the painter UNRESOLVED"
  // throw is a pageerror) and paint the interior.
  {
    let doc = newDocument(), z = 1;
    doc.meta = { ...doc.meta, slideW: 400, slideH: 300 };
    const items0 = doc.slides[0].delta.items;
    const camId = Object.keys(items0)[0];
    items0[camId] = { ...items0[camId], x: 0, y: 0, w: 400, h: 300, background: BG };
    const addOne = (type, over) => { [doc] = withNewItem(doc, 0, { ...registry.get(type).defaults, ...over, active: true, z: z++ }); };
    addOne("rect", { x: 0, y: 0, w: 400, h: 300, strokeWidth: 0, fill: "#ef476f" });
    addOne("paint_path", {
      x: 60, y: 40, w: 280, h: 220, closed: true, strokeStart: 0.05, strokeEnd: 0.95, strokeWidth: 8,
      paintPoints: [[0.5, 0.05, 0.2, 0, 0], [0.95, 0.6, 0, 0.2, 0], [0.5, 0.95, -0.2, 0, 0], [0.05, 0.6, 0, -0.2, 0]],
      fill: { type: "material", material: { id: "glass", params: { lightX: 0.3 } } },
      stroke: { type: "material", material: { id: "brush", params: { brush: "fineliner", wStale: 1 } } },
    });
    const before = fails.length;
    const png = await (async () => {
      const dataUrl = await page.evaluate(
        (json, w, h) => window.__powerrp_render(json, { slide: 0, width: w, height: h }),
        serialize(doc), 400, 300,
      );
      return readPng(Buffer.from(dataUrl.split(",")[1], "base64"));
    })();
    const center = pixelAt(png, 200, 150);
    ok(fails.length === before, "paint_path with glass fill + brush material stroke rendered with ZERO page errors (the UNRESOLVED regression)");
    ok(center.some((c, i) => Math.abs(c - [0xef, 0x47, 0x6f][i]) > 4),
      `paint_path material fill PAINTED its interior (center ${center.join(",")} differs from the underlay)`);
  }
  // ── PARITY: the glitch FILL distorts its backdrop like the glitch WIDGET ────
  // (user report: "the demo widget looks great, why doesn't the material?").
  // Both are rendered over vertical stripes; each region's changed-fraction vs a
  // no-overlay control measures how much backdrop it displaced. The fill must
  // distort at least 80% as much as the widget — parity, not pixel-equality
  // (their regions differ, so the tear pattern does too).
  {
    const stripes = (withOverlays) => {
      let d = newDocument(), z = 1;
      d.meta = { ...d.meta, slideW: 800, slideH: 300 };
      const items0 = d.slides[0].delta.items;
      const camId = Object.keys(items0)[0];
      items0[camId] = { ...items0[camId], x: 0, y: 0, w: 800, h: 300, background: "#101018" };
      const addOne = (type, over) => { [d] = withNewItem(d, 0, { ...registry.get(type).defaults, ...over, active: true, z: z++ }); };
      for (let x = 0; x < 800; x += 40) addOne("rect", { x, y: 0, w: 20, h: 300, fill: "#e8e8f0", strokeWidth: 0 });
      if (withOverlays) {
        addOne("demo_glitch", { x: 40, y: 40, w: 300, h: 220 });
        addOne("rect", { x: 460, y: 40, w: 300, h: 220, strokeWidth: 0, cornerRadius: 0, fill: { type: "material", material: { id: "glitch", params: {} } } });
      }
      return serialize(d);
    };
    const renderWH = async (json) => {
      const dataUrl = await page.evaluate((j) => window.__powerrp_render(j, { slide: 0, width: 800, height: 300 }), json);
      return readPng(Buffer.from(dataUrl.split(",")[1], "base64"));
    };
    const control = await renderWH(stripes(false));
    const both = await renderWH(stripes(true));
    const changedFrac = (x0, y0, x1, y1) => {
      let n = 0, t = 0;
      for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) {
        const i = (y * 800 + x) * 4;
        const d = Math.abs(both.data[i] - control.data[i]) + Math.abs(both.data[i + 1] - control.data[i + 1]) + Math.abs(both.data[i + 2] - control.data[i + 2]);
        t++;
        if (d > 30) n++;
      }
      return n / t;
    };
    const wFrac = changedFrac(60, 60, 320, 240), fFrac = changedFrac(480, 60, 740, 240);
    ok(fFrac >= wFrac * 0.8,
      `glitch FILL distorts its backdrop at widget parity (fill ${fFrac.toFixed(3)} >= 0.8 x widget ${wFrac.toFixed(3)})`);
  }

} finally {
  await browser.close();
  await server.close();
}

/** Pure function. RGB triple at (x,y) of a decoded PNG.
 * @example (a red pixel) // [255, 0, 0] */
function pixelAt(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

if (fails.length) {
  console.error(`\nFAILED: ${fails.length} — material fill matrix`);
  process.exit(1);
}
console.log("\nPASS — material fill matrix (every fill-capable material × 4 shapes incl. custom)");
