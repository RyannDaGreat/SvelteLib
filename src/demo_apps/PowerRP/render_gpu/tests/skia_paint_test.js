/**
 * Phase-1a render test for the Skia backend: build REAL IR with the ir.js
 * builders (rect/ellipse/polyline/polygon/text + a transform-scaled text run),
 * render it through node_render (CanvasKit CPU surface), and prove:
 *   - the backend consumes the actual display-list IR (parity path),
 *   - text drawn through a 20x transform stays crisp (the reported zoom bug),
 *   - fonts load from the committed registry.
 * Writes a PNG for a VLM crispness check; asserts a non-trivial PNG came out.
 *
 * Run: node render_gpu/tests/skia_paint_test.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../skia/node_render.js";
import { rect, ellipse, polyline, polygon, text, pushTransform, popTransform } from "../ir.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", ".claude_vlm_checks", "skia_backend_test.png");
const DPR = 2;
const LOGICAL_W = 720, LOGICAL_H = 470;

const commands = [
  rect({ x: 30, y: 30, w: 200, h: 110, cornerRadius: 18, fill: "#4f8cff", stroke: "#12234a", strokeWidth: 5 }),
  ellipse({ cx: 360, cy: 85, rx: 80, ry: 52, fill: "#f59e42", stroke: "#7a3d10", strokeWidth: 4 }),
  polyline({ points: [[470, 45], [540, 120], [600, 45], [670, 120]], width: 9, color: "#22a06b" }),
  polygon({ points: [[470, 155], [560, 155], [515, 122]], fill: "#e0567a" }),
  text({ text: "Skia backend — real IR display list", x: 30, y: 172, size: 30, color: "#111111", font: "inter" }),
  text({ text: "JetBrains Mono 20px  { x = 42 }", x: 30, y: 218, size: 20, color: "#444444", font: "jetbrains-mono" }),
  // Crisp-at-zoom via the REAL transform path: 6px text under a 20x world scale
  // = 120px effective. If Skia re-rasterizes at the CTM scale, this is crisp.
  pushTransform({ x: 30, y: 262, scale: 20 }),
  text({ text: "Rag 12 (6px @ 20x)", x: 0, y: 0, size: 6, color: "#111111", font: "inter" }),
  popTransform(),
];

const png = await renderToPng(commands, { zoom: 1, panX: 0, panY: 0, dpr: DPR }, {
  width: LOGICAL_W * DPR, height: LOGICAL_H * DPR, background: "#ffffff",
});

if (!(png instanceof Uint8Array) || png.length < 1000) throw new Error(`skia_paint_test: PNG too small (${png?.length} bytes) — render produced nothing`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(png));
console.log(`OK skia_paint_test — wrote ${OUT} (${png.length} bytes)`);
