/**
 * Phase-1b render test for the Skia backend: exercise EACH backdrop/effect/
 * vector op through node_render (CanvasKit CPU surface) and write a PNG per op
 * for a VLM check. Builds REAL IR with the ir.js builders and proves the ops
 * render without throwing and produce non-trivial output.
 *
 * Ops covered: blurBackdrop, magnifyBackdrop (supersample crisp + soft sample,
 * circle + box), cropSubtree, effectSubtree (shadow+bloom, and shadowOnly),
 * latexVector.
 *
 * Because backdrop samplers read the composite-so-far, node_render's CPU
 * MakeSurface path is what this validates end-to-end (paintIR renders the whole
 * scene to an owned offscreen surface, snapshots it per sampler, blits back).
 *
 * Run: node render_gpu/tests/skia_backdrop_test.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../skia/node_render.js";
import {
  rect, ellipse, text, pushTransform, popTransform,
  blurBackdrop, magnifyBackdrop, cropSubtree, effectSubtree, latexVector,
} from "../ir.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", ".claude_vlm_checks");
const DPR = 2;
const W = 720, H = 480;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: DPR };

/** Query→build. A busy background (color grid + fine labels) so blur/magnify have detail to sample. */
function background() {
  const cmds = [rect({ x: 0, y: 0, w: W, h: H, fill: "#0e1726" })];
  const cols = ["#4f8cff", "#f59e42", "#22a06b", "#e0567a", "#a970ff"];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 9; c++) {
      cmds.push(rect({ x: 20 + c * 76, y: 20 + r * 74, w: 60, h: 58, cornerRadius: 8, fill: cols[(r + c) % cols.length] }));
      cmds.push(text({ text: `${r}${c}`, x: 30 + c * 76, y: 30 + r * 74, size: 12, color: "#0b0f18", font: "jetbrains-mono" }));
    }
  }
  return cmds;
}

/** Command (renders one scene to a PNG and asserts it is non-trivial). */
async function renderScene(name, commands) {
  const png = await renderToPng(commands, VIEW, { width: W * DPR, height: H * DPR, background: "#0e1726" });
  if (!(png instanceof Uint8Array) || png.length < 1000) throw new Error(`${name}: PNG too small (${png?.length} bytes)`);
  const out = path.join(OUT_DIR, `skia_${name}.png`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(out, Buffer.from(png));
  console.log(`OK ${name} — ${png.length} bytes → ${out}`);
}

// blurBackdrop: full-screen backdrop blur, then a crisp banner drawn on top.
const blurScene = [
  ...background(),
  blurBackdrop({ radius: 5, opacity: 1 }),
  rect({ x: 210, y: 200, w: 300, h: 70, cornerRadius: 12, fill: "#ffffffee" }),
  text({ text: "crisp over blur", x: 232, y: 222, size: 26, color: "#0e1726", font: "inter" }),
];

// magnifyBackdrop CRISP (supersample:true) — circle lens re-renders the grid+text sharp.
const magCrispScene = [
  ...background(),
  magnifyBackdrop({ shape: "circle", cx: 360, cy: 240, r: 130, magnification: 2.4, rimColor: "#ffffff", rimWidth: 5 }),
];

// magnifyBackdrop SOFT (supersample:false) — box lens samples the backdrop scaled.
const magSoftScene = [
  ...background(),
  magnifyBackdrop({ shape: "box", cx: 360, cy: 240, halfW: 180, halfH: 120, cornerRadius: 18, magnification: 2.4, stroke: "#ffd166", strokeWidth: 5, supersample: false }),
];

// cropSubtree: content extends past the region and is clipped to a rounded rect + border.
const cropScene = [
  ...background(),
  cropSubtree({
    x: 200, y: 140, w: 320, h: 200, cornerRadius: 24, fill: "#101826", stroke: "#4f8cff", strokeWidth: 6,
    content: [
      pushTransform({ x: 0, y: 0 }),
      ellipse({ cx: 360, cy: 240, rx: 230, ry: 150, fill: "#f59e42" }),
      ellipse({ cx: 360, cy: 240, rx: 120, ry: 90, fill: "#e0567a" }),
      text({ text: "clipped content", x: 250, y: 232, size: 30, color: "#0e1726", font: "inter" }),
      popTransform(),
    ],
  }),
];

// effectSubtree: shadow + bloom around a card (content carries its own world).
const card = (label) => [
  pushTransform({ x: 0, y: 0 }),
  rect({ x: 260, y: 190, w: 200, h: 100, cornerRadius: 16, fill: "#4f8cff" }),
  text({ text: label, x: 286, y: 226, size: 26, color: "#ffffff", font: "inter" }),
  popTransform(),
];
const effectScene = [
  ...background(),
  effectSubtree({
    x: 260, y: 190, w: 200, h: 100,
    shadow: { dx: 14, dy: 16, blur: 8, color: "#000000", opacity: 0.7 },
    bloom: { radius: 10, strength: 0.9 },
    blend: "normal",
    content: card("shadow+bloom"),
  }),
];

// effectSubtree shadowOnly — the PDF-hybrid "raster shadow only" path.
const shadowOnlyScene = [
  ...background(),
  effectSubtree({
    x: 260, y: 190, w: 200, h: 100,
    shadow: { dx: 16, dy: 18, blur: 10, color: "#000000", opacity: 0.85 },
    shadowOnly: true,
    content: card("(suppressed)"),
  }),
];

// latexVector: three vector glyphs (an "L", a "+", and a square ring with a hole)
// mapped from viewBox space onto the draw box. Ignores any raster ref.
const latexScene = [
  rect({ x: 0, y: 0, w: W, h: H, fill: "#f7f7fb" }),
  text({ text: "latexVector - true vector glyphs (box-to-box)", x: 40, y: 40, size: 22, color: "#1a1a2e", font: "inter" }),
  latexVector({
    ref: "unused",
    x: 120, y: 140, w: 480, h: 200,
    viewBox: { minX: 0, minY: 0, w: 200, h: 90 },
    glyphs: [
      { d: "M10 80 L10 15 L24 15 L24 66 L60 66 L60 80 Z", fill: "#1a1a2e" },
      { d: "M80 40 L100 40 L100 20 L114 20 L114 40 L134 40 L134 54 L114 54 L114 74 L100 74 L100 54 L80 54 Z", fill: "#c0392b" },
      { d: "M150 15 L195 15 L195 75 L150 75 Z M162 27 L162 63 L183 63 L183 27 Z", fill: "#1f6f43" },
    ],
  }),
];

// Combined stress scene: crop + effect + a crisp lens, all in one pass.
const combinedScene = [
  ...background(),
  effectSubtree({
    x: 40, y: 300, w: 200, h: 100,
    shadow: { dx: 10, dy: 12, blur: 7, color: "#000000", opacity: 0.6 }, blend: "normal",
    content: [pushTransform({ x: 0, y: 0 }), rect({ x: 40, y: 300, w: 200, h: 100, cornerRadius: 14, fill: "#22a06b" }), text({ text: "effect", x: 66, y: 334, size: 24, color: "#fff", font: "inter" }), popTransform()],
  }),
  cropSubtree({
    x: 470, y: 300, w: 210, h: 130, cornerRadius: 18, stroke: "#e0567a", strokeWidth: 5,
    content: [pushTransform({ x: 0, y: 0 }), ellipse({ cx: 575, cy: 365, rx: 160, ry: 110, fill: "#a970ff" }), text({ text: "crop", x: 540, y: 350, size: 26, color: "#0e1726", font: "inter" }), popTransform()],
  }),
  magnifyBackdrop({ shape: "circle", cx: 250, cy: 150, r: 95, magnification: 2.2, rimColor: "#ffffff", rimWidth: 4 }),
];

await renderScene("blur", blurScene);
await renderScene("magnify_crisp", magCrispScene);
await renderScene("magnify_soft", magSoftScene);
await renderScene("crop", cropScene);
await renderScene("effect", effectScene);
await renderScene("effect_shadow_only", shadowOnlyScene);
await renderScene("latex", latexScene);
await renderScene("combined", combinedScene);
console.log("OK skia_backdrop_test — all ops rendered");
