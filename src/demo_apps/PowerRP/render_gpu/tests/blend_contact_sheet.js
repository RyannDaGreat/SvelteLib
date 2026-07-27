/**
 * THE BLEND-MODE CONTACT SHEET — every shipped mode, same source over the same
 * backdrop, labelled, in one PNG for a human/VLM to compare at a glance; PLUS the
 * END-TO-END pixel proof that the mode survives the real pipeline.
 * Run: node render_gpu/tests/blend_contact_sheet.js [out.png]
 *
 * WHY BOTH IN ONE FILE: blend_modes_test.js proves the FORMULAS against an
 * independent oracle, but it talks to CanvasKit directly. This one goes through
 * the actual shipping path — ir.js effectSubtree → node_render → paintIR →
 * handleEffectSubtree → applyBlend — so it also proves the plumbing: that
 * `blendMode` reaches the painter, that the per-widget offscreen composite
 * preserves the mode, and that the SkSL modes work through the same
 * render-to-texture path as the native ones. A sheet you can only look at proves
 * nothing about numbers; numbers alone prove nothing about whether it LOOKS like
 * the mode. Here the sheet's own pixels ARE the assertion.
 *
 * EACH CELL is a blend-mode test chart: the backdrop is 8 VERTICAL bars (a
 * 4-step grey ramp + 4 saturated hues) and the effected widget is 8 HORIZONTAL
 * bars (a 4-step grey ramp + 4 different saturated hues), so one cell shows all
 * 64 (backdrop, source) combinations — grey×grey, grey×colour, colour×grey and
 * colour×colour. That matters because whole mode families are invisible on the
 * wrong chart: Hue/Saturation do nothing over a grey backdrop, and the
 * contrast group does almost nothing over mid-grey.
 *
 * THE "normal" CELL DRAWS NO effectSubtree. That is not a special case in the
 * sheet, it is the engine's contract: ir.js refuses to build an effect op with
 * no effect on, and render_gpu/effects.js applyEffects passes the content
 * through unwrapped. So the Normal cell is the true zero-cost baseline every
 * other cell should visibly differ from.
 *
 * Node-only (fs + blend_oracle's PNG read-back). Uses node_render's CanvasKit, so
 * this process holds exactly one WASM module.
 */

import fs from "fs";
import path from "path";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { renderToPng } from "../skia/node_render.js";
import { rect, text, effectSubtree, pushTransform, popTransform } from "../ir.js";
import { BLEND_MODES, BLEND_MODE_LABELS } from "../../core/properties.js";
import { compositeReference, decodePngRGBA } from "./blend_oracle.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, "..", "..", ".claude_vlm_checks", "blend_contact_sheet.png");
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT;

// ── sheet layout (canvas units; DPR doubles them in device px) ────────────────
const CELL = 152;          // one chart's side — 8 bars of 19 units each
const BARS = 8;            // bars per axis ⇒ 64 (backdrop, source) combinations per cell
const BAR = CELL / BARS;   // 19
const INSET = 0;           // the widget covers the whole cell: every combination is realized
const LABEL_H = 24;        // caption strip under each cell
const GAP = 10;
const COLS = 6;
const MARGIN = 20;
const TITLE_H = 40;
const LABEL_SIZE = 15;
const TITLE_SIZE = 24;
const DPR = 2;

const SHEET_W = MARGIN * 2 + COLS * CELL + (COLS - 1) * GAP;
const ROWS = Math.ceil(BLEND_MODES.length / COLS);
const SHEET_H = MARGIN * 2 + TITLE_H + ROWS * (CELL + LABEL_H + GAP);
const PAGE_BG = "#20222a";
const LABEL_COLOR = "#e8e8ee";

// The two bar palettes. Each is a 4-step grey ramp plus 4 saturated hues, and the
// two hue sets are DIFFERENT (backdrop warm/primary, source cool/secondary) so a
// colour-on-colour cell is never a mode blending a colour with itself — which
// would hide Hue/Saturation/Color/Luminosity entirely.
const BACKDROP_BARS = [
  [0, 0, 0], [0.33, 0.33, 0.33], [0.67, 0.67, 0.67], [1, 1, 1],
  [0.88, 0.20, 0.20], [0.95, 0.80, 0.15], [0.20, 0.70, 0.32], [0.20, 0.35, 0.90],
];
const SOURCE_BARS = [
  [0, 0, 0], [0.33, 0.33, 0.33], [0.67, 0.67, 0.67], [1, 1, 1],
  [0.15, 0.80, 0.85], [0.85, 0.20, 0.75], [0.95, 0.55, 0.15], [0.45, 0.25, 0.85],
];

/** Pure function. An [r,g,b] 0..1 triple as a #rrggbb string (the IR colour form).
 * @example hex([1, 0, 0.5]) // "#ff0080"
 */
function hex(c) {
  return "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

/** Pure function. The top-left of cell `i` in the sheet's grid.
 * @example cellOrigin(0) // {x: 20, y: 60}
 * @example cellOrigin(6).y // 246 (second row)
 */
function cellOrigin(i) {
  const col = i % COLS, row = Math.floor(i / COLS);
  return { x: MARGIN + col * (CELL + GAP), y: MARGIN + TITLE_H + row * (CELL + LABEL_H + GAP) };
}

/** Pure function. One cell's BACKDROP: 8 full-height vertical bars.
 * @example backdropOps(0, 0).length // 8
 */
function backdropOps(x0, y0) {
  return BACKDROP_BARS.map((c, k) => rect({ x: x0 + k * BAR, y: y0, w: BAR, h: CELL, fill: hex(c) }));
}

/** Pure function. One cell's SOURCE widget content: 8 full-width horizontal bars.
 * @example sourceOps(0, 0).length // 8
 */
function sourceOps(x0, y0) {
  return SOURCE_BARS.map((c, k) => rect({ x: x0 + INSET, y: y0 + INSET + k * BAR, w: CELL - 2 * INSET, h: BAR, fill: hex(c) }));
}

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };

/** Pure function. The IR for one labelled cell: backdrop bars, then the source
 * bars composited under `mode` (unwrapped for "normal" — see the header), then
 * the caption. */
function cellOps(mode, i) {
  const { x, y } = cellOrigin(i);
  const content = sourceOps(x, y);
  const composited = mode === "normal"
    ? content
    : [effectSubtree({
        x: x + INSET, y: y + INSET, w: CELL - 2 * INSET, h: CELL - 2 * INSET,
        blend: mode, content: [pushTransform(IDENTITY), ...content, popTransform()],
      })];
  return [
    ...backdropOps(x, y),
    ...composited,
    text({ text: BLEND_MODE_LABELS[mode], x, y: y + CELL + 5, size: LABEL_SIZE, color: LABEL_COLOR, font: "inter" }),
  ];
}

const commands = [
  text({
    text: `Blend modes — ${BLEND_MODES.length} modes; backdrop = vertical bars, source widget = horizontal bars`,
    x: MARGIN, y: MARGIN, size: TITLE_SIZE, color: LABEL_COLOR, font: "inter",
  }),
  ...BLEND_MODES.flatMap(cellOps),
];

const png = await renderToPng(commands, { zoom: 1, panX: 0, panY: 0, dpr: DPR }, {
  width: SHEET_W * DPR, height: SHEET_H * DPR, background: PAGE_BG,
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(png));

const sheet = decodePngRGBA(png);
assert.equal(sheet.width, SHEET_W * DPR);
assert.equal(sheet.height, SHEET_H * DPR);

/** Query. The RGBA byte quadruple at a CANVAS-unit point (× DPR into device px). */
function pixelAt(cx, cy) {
  const x = Math.round(cx * DPR), y = Math.round(cy * DPR);
  const o = (y * sheet.width + x) * 4;
  return [sheet.data[o], sheet.data[o + 1], sheet.data[o + 2], sheet.data[o + 3]];
}

// Same measured tolerances, same causes, as blend_modes_test.js — plus this path
// adds one more 8-bit round trip (the widget renders into its own offscreen
// before compositing), so the floor is 2 rather than 1.
const PIPELINE_TOLERANCE = 2;
const RECIPROCAL_TOLERANCE = 6;
const RECIPROCAL_MODES = ["colorBurn", "colorDodge", "vividLight", "divide"];
const NONSEPARABLE_TOLERANCE = 3;
const NONSEPARABLE_MODES = ["hue", "saturation", "color", "luminosity"];
// Bars are 19 units wide; sampling the middle keeps the probe clear of the
// antialiased 1px seam between neighbouring bars.
const SAMPLE_FRACTION = 0.5;

let checks = 0, worstOverall = 0;
const report = [];
for (let i = 0; i < BLEND_MODES.length; i++) {
  const mode = BLEND_MODES[i];
  const { x, y } = cellOrigin(i);
  const tol = RECIPROCAL_MODES.includes(mode) ? RECIPROCAL_TOLERANCE
    : NONSEPARABLE_MODES.includes(mode) ? NONSEPARABLE_TOLERANCE : PIPELINE_TOLERANCE;
  let worst = 0, at = null;
  for (let bx = 0; bx < BARS; bx++) {
    for (let sy = 0; sy < BARS; sy++) {
      const Cb = BACKDROP_BARS[bx], Cs = SOURCE_BARS[sy];
      // A step mode within ~1/255 of its boundary jumps the full range (see
      // blend_modes_test.js DISCONTINUOUS_MODES) — skip those samples rather than
      // widen the tolerance and stop testing the other 60.
      const nearThreshold = mode === "hardMix" && Cb.some((b, k) => Math.abs(b + Cs[k] - 1) < 0.05);
      const nearTie = (mode === "darkerColor" || mode === "lighterColor")
        && Math.abs(Cb[0] + Cb[1] + Cb[2] - (Cs[0] + Cs[1] + Cs[2])) < 0.05;
      if (nearThreshold || nearTie) continue;
      const got = pixelAt(x + (bx + SAMPLE_FRACTION) * BAR, y + (sy + SAMPLE_FRACTION) * BAR);
      const want = compositeReference(mode, [...Cs, 1], [...Cb, 1]).map((v) => Math.round(v * 255));
      const d = Math.max(...got.map((v, k) => Math.abs(v - want[k])));
      checks++;
      if (d > worst) { worst = d; at = { Cb, Cs, got, want }; }
    }
  }
  worstOverall = Math.max(worstOverall, worst);
  report.push(`  ${BLEND_MODE_LABELS[mode].padEnd(20)} worst ${String(worst).padStart(3)}/255  (tolerance ${tol})`);
  assert.ok(worst <= tol, `contact sheet cell "${mode}" deviates ${worst}/255 from the reference composite at ${JSON.stringify(at)} — the mode reaches paintIR but computes something else`);
}

// EVERY cell must differ from the Normal cell: a mode that changes no pixel of a
// 64-combination chart is not composited at all. This is the sheet's own version
// of the eyeball check, so a regression cannot hide behind "it looked fine".
const cellBytes = (i) => {
  const { x, y } = cellOrigin(i);
  const out = [];
  for (let bx = 0; bx < BARS; bx++) for (let sy = 0; sy < BARS; sy++)
    out.push(...pixelAt(x + (bx + SAMPLE_FRACTION) * BAR, y + (sy + SAMPLE_FRACTION) * BAR));
  return out.join(",");
};
const normalCell = cellBytes(BLEND_MODES.indexOf("normal"));
const seen = new Map([[normalCell, "normal"]]);
for (let i = 0; i < BLEND_MODES.length; i++) {
  const mode = BLEND_MODES[i];
  if (mode === "normal") continue;
  const bytes = cellBytes(i);
  assert.notEqual(bytes, normalCell, `the "${mode}" cell is pixel-identical to the Normal cell — the blend never reached the compositor`);
  const twin = seen.get(bytes);
  assert.equal(twin, undefined, `the "${mode}" and "${twin}" cells are pixel-identical — one of them is mislabelled or mismapped`);
  seen.set(bytes, mode);
}

console.log(report.join("\n"));
console.log(`\nOK blend_contact_sheet — ${BLEND_MODES.length} modes, ${checks} sampled composites, worst deviation ${worstOverall}/255`);
console.log(`     ${OUT} (${png.length} bytes, ${sheet.width}x${sheet.height})`);
