/**
 * METABALL FUSION PROBE — proves the metaball ARCHETYPE fuses SEPARATE widgets and,
 * crucially, that fused widgets are POSITIONED CORRECTLY for ANY union-region aspect
 * (wide, tall, diagonal) — not collapsed toward the region centre.
 * Run: node src/demo_apps/PowerRP/tests/metaball_fusion_probe.js
 *
 * Authors documents via the document model (colourful striped backdrop; THE camera
 * resized to frame the widgets), CLI-renders each through the SAME Skia pipeline the
 * editor uses (cli/render.js renderDocToPng), and measures pixels PROPERLY: it
 * renders WITH metaballs and a matching backdrop-ONLY doc, then a "droplet pixel" is
 * one where the two differ (the droplet refracts/lights the backdrop there) — robust
 * to any backdrop colour. It then asserts, per case:
 *   CLOSE       — the two lobes are CONNECTED (droplet pixels in the midpoint band).
 *   WIDE-APART  — a droplet at EACH widget + an EMPTY midpoint band (X axis correct).
 *   TALL-APART  — a droplet at EACH widget + an EMPTY midpoint band (Y axis correct).
 *   DIAG-WIDE   — droplets at the two diagonal corners, empty centre column.
 *   SINGLE      — exactly one blob at the widget's own location.
 * PNGs are written to .claude_vlm_checks/ for a VLM look. Bare node (CPU CanvasKit).
 */

import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDocument, withNewItem, serialize, keyframed, foldState } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { renderDocToPng } from "../cli/render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", ".claude_vlm_checks");
await mkdir(OUT, { recursive: true });

// CanvasKit (to decode the rendered PNGs back to pixels), loaded exactly like node_render.js.
const require = createRequire(path.join(HERE, "..", "render_gpu", "skia", "node_render.js"));
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CK = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

const registry = createRegistry();
registerAll(registry, createCommands());
const item = (type, over) => ({ ...registry.get(type).defaults, ...over });

const BAR_COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#0a84ff", "#5e5ce6", "#bf5af2"];

/** Query. A doc: THE camera sized to W×H, colourful bars (z=1), and (optionally) the metaball boxes. */
function doc(W, H, boxes, withBalls) {
  let d = newDocument();
  d = { ...d, meta: { ...d.meta, slideW: W, slideH: H } };
  const camId = Object.entries(foldState(d, 0).items).find(([, s]) => s.type === "camera")[0];
  d = keyframed(d, 0, ["items", camId, "w"], W);
  d = keyframed(d, 0, ["items", camId, "h"], H);
  const barW = W / BAR_COLORS.length;
  BAR_COLORS.forEach((fill, i) => { [d] = withNewItem(d, 0, item("rect", { x: i * barW, y: 0, w: barW, h: H, z: 1, strokeWidth: 0, cornerRadius: 0, fill })); });
  if (withBalls) for (const b of boxes) [d] = withNewItem(d, 0, item("metaball", b));
  return serialize(d);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const isPng = (b) => PNG_MAGIC.every((m, i) => b[i] === m);
const DIFF = 24; // per-channel 8-bit difference that marks a droplet-altered pixel

async function pixels(json, W, H, saveAs) {
  const png = await renderDocToPng(json, { slide: 0, alpha: 1, width: W, height: H });
  if (!isPng(png) || png.length < 2000) throw new Error(`bad render (${png?.length} bytes)`);
  if (saveAs) await writeFile(saveAs, png);
  const img = CK.MakeImageFromEncoded(png);
  const px = img.readPixels(0, 0, { width: W, height: H, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB });
  img.delete();
  return px;
}
/** Query. Droplet mask (1 where WITH differs from WITHOUT by > DIFF). */
function mask(a, b, W, H) {
  const m = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) { const i = p * 4; m[p] = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > DIFF ? 1 : 0; }
  return m;
}
function countRect(m, W, H, x0, x1, y0, y1) {
  let n = 0;
  for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) if (m[y * W + x]) n++;
  return n;
}

let fails = 0;
const check = (cond, msg) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) fails++; };
const HALF = 60;   // half-width of a "ball cell" / gap band (device px)
const CELL_MIN = 3000; // a real droplet colours at least this many px in its cell
const GAP_MAX = 600;   // a SEPARATED pair leaves at most this many px in the midpoint band (AA/rim only)
const NECK_MIN = 2000; // a FUSED pair connects with at least this many px in the midpoint band

async function caseAnalyze(name, W, H, boxes) {
  const a = await pixels(doc(W, H, boxes, true), W, H, path.join(OUT, `${name}.png`));
  const b = await pixels(doc(W, H, boxes, false), W, H);
  const m = mask(a, b, W, H);
  return { m, W, H, total: countRect(m, W, H, 0, W, 0, H) };
}
const cx = (bx) => bx.x + bx.w / 2, cy = (bx) => bx.y + bx.h / 2;

console.log("metaball fusion — pixel-level (droplet = differs from backdrop-only):\n");

// SINGLE — one blob at the widget's own centre.
{
  const W = 1280, H = 720, box = { x: W / 2 - 150, y: H / 2 - 150, w: 300, h: 300 };
  const { m, total } = await caseAnalyze("metaball_single", W, H, [box]);
  console.log(`SINGLE total=${total}`);
  check(countRect(m, W, H, cx(box) - HALF, cx(box) + HALF, 0, H) >= CELL_MIN, "SINGLE: a droplet sits at the widget centre");
  check(countRect(m, W, H, 0, cx(box) - 200, 0, H) === 0 && countRect(m, W, H, cx(box) + 200, W, 0, H) === 0, "SINGLE: nothing elsewhere (one blob only)");
}
// CLOSE — overlapping boxes → ONE fused peanut (connected across the midpoint).
{
  const W = 1280, H = 720, b0 = { x: 360, y: H / 2 - 150, w: 300, h: 300 }, b1 = { x: 560, y: H / 2 - 150, w: 300, h: 300 };
  const { m, total } = await caseAnalyze("metaball_close", W, H, [b0, b1]);
  const mid = (cx(b0) + cx(b1)) / 2;
  const gap = countRect(m, W, H, mid - HALF, mid + HALF, 0, H);
  console.log(`CLOSE total=${total} neck@${mid}=${gap}`);
  check(gap >= NECK_MIN, "CLOSE: the two lobes are CONNECTED (neck present at the midpoint)");
}
// WIDE-APART — X axis: a droplet at each widget, EMPTY midpoint band.
{
  const W = 1600, H = 700, b0 = { x: 360, y: H / 2 - 150, w: 300, h: 300 }, b1 = { x: 1260, y: H / 2 - 150, w: 300, h: 300 };
  const { m, total } = await caseAnalyze("metaball_wide_apart", W, H, [b0, b1]);
  const mid = (cx(b0) + cx(b1)) / 2;
  const c0 = countRect(m, W, H, cx(b0) - HALF, cx(b0) + HALF, 0, H), c1 = countRect(m, W, H, cx(b1) - HALF, cx(b1) + HALF, 0, H), gap = countRect(m, W, H, mid - HALF, mid + HALF, 0, H);
  console.log(`WIDE-APART total=${total} cell0=${c0} gap@${mid}=${gap} cell1=${c1}`);
  check(c0 >= CELL_MIN && c1 >= CELL_MIN, "WIDE-APART: a droplet at EACH widget's true X (no collapse)");
  check(gap <= GAP_MAX, "WIDE-APART: EMPTY midpoint band (two disjoint droplets, X axis correct)");
}
// TALL-APART — Y axis: a droplet at each widget, EMPTY midpoint band.
{
  const W = 700, H = 1600, b0 = { x: 200, y: 200, w: 300, h: 300 }, b1 = { x: 200, y: 1100, w: 300, h: 300 };
  const { m, total } = await caseAnalyze("metaball_tall_apart", W, H, [b0, b1]);
  const mid = (cy(b0) + cy(b1)) / 2;
  const c0 = countRect(m, W, H, 0, W, cy(b0) - HALF, cy(b0) + HALF), c1 = countRect(m, W, H, 0, W, cy(b1) - HALF, cy(b1) + HALF), gap = countRect(m, W, H, 0, W, mid - HALF, mid + HALF);
  console.log(`TALL-APART total=${total} cell0=${c0} gap@${mid}=${gap} cell1=${c1}`);
  check(c0 >= CELL_MIN && c1 >= CELL_MIN, "TALL-APART: a droplet at EACH widget's true Y (no collapse)");
  check(gap <= GAP_MAX, "TALL-APART: EMPTY midpoint band (two disjoint droplets, Y axis correct)");
}
// DIAG-WIDE — both axes off-centre in a wide region: droplets at UL and LR, empty centre column.
{
  const W = 1600, H = 800, b0 = { x: 150, y: 80, w: 300, h: 300 }, b1 = { x: 1150, y: 420, w: 300, h: 300 };
  const { m, total } = await caseAnalyze("metaball_diag_wide", W, H, [b0, b1]);
  // Per-QUADRANT (droplet diff concentrates at the rim, so a tiny centre box under-counts):
  // the UL droplet lives in the upper-left quadrant, the LR droplet in the lower-right.
  const ul = countRect(m, W, H, 0, W / 2, 0, H / 2);
  const lr = countRect(m, W, H, W / 2, W, H / 2, H);
  const midCol = countRect(m, W, H, W / 2 - HALF, W / 2 + HALF, 0, H);
  console.log(`DIAG-WIDE total=${total} UL=${ul} LR=${lr} centreCol=${midCol}`);
  check(ul >= CELL_MIN && lr >= CELL_MIN, "DIAG-WIDE: droplets at BOTH diagonal corners (both axes correct)");
  check(midCol <= GAP_MAX, "DIAG-WIDE: empty centre column (no collapse to region centre)");
}

console.log(fails === 0 ? `\nAll fusion checks passed. PNGs in ${OUT}` : `\n${fails} FAILED`);
if (fails) process.exit(1);
