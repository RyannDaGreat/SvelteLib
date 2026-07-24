/**
 * Render + unit test for the Liquid Glass widget (the first live SkSL
 * RuntimeEffect). Two halves:
 *
 *  1. PURE assertions (bare-node): the glassBackdrop IR builder normalizes/clamps
 *     its fields, and the glass plugin's emit() returns exactly one glassBackdrop
 *     op with the material knobs threaded through.
 *  2. RENDER scenes through node_render (CanvasKit CPU surface): glass over a
 *     colorful high-contrast backdrop, over a DARK region and a LIGHT region (the
 *     luminance-adaptive tint), a materialize ramp, and a rotated panel. Each is
 *     written as a PNG to .claude_vlm_checks/ for a VLM fidelity check vs the
 *     macOS references, and asserted to be non-trivial output.
 *
 * Run: node render_gpu/tests/skia_glass_test.js
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../skia/node_render.js";
import { rect, ellipse, polygon, pushTransform, popTransform, glassBackdrop } from "../ir.js";
import { glassPlugin } from "../../plugins/demo/glass.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", ".claude_vlm_checks");
const DPR = 2;
const W = 760, H = 460;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: DPR };

// ── (1) PURE assertions ───────────────────────────────────────────────────────
function unitTests() {
  // builder normalizes + clamps
  const g = glassBackdrop({ cx: 10, cy: 20, halfW: 80, halfH: 40, cornerRadius: -5, saturation: 2, materialize: 1.5, blurRadius: -3 });
  assert.equal(g.op, "glassBackdrop");
  assert.equal(g.cornerRadius, 0, "negative cornerRadius clamps to 0");
  assert.equal(g.saturation, 1, "saturation clamps to [0,1]");
  assert.equal(g.materialize, 1, "materialize clamps to [0,1]");
  assert.equal(g.blurRadius, 0, "negative blurRadius clamps to 0");
  assert.deepEqual(g.tint, null, "no tint → null skin");
  const gt = glassBackdrop({ cx: 0, cy: 0, halfW: 1, halfH: 1, tint: "rgba(255,255,255,0.14)" });
  assert.ok(Math.abs(gt.tint[3] - 0.14) < 1e-6, "tint alpha parsed");
  // new material/render knobs: defaults + clamps
  assert.equal(g.squircle, 4, "squircle default 4");
  assert.equal(glassBackdrop({ cx: 0, cy: 0, halfW: 1, halfH: 1, squircle: 1 }).squircle, 2, "squircle clamps to >=2");
  assert.equal(g.chromatic, 0.08, "chromatic default 0.08 (tiny)");
  assert.equal(g.backdropScale, 1, "backdropScale default 1");
  assert.equal(glassBackdrop({ cx: 0, cy: 0, halfW: 1, halfH: 1, backdropScale: 0.1 }).backdropScale, 0.25, "backdropScale clamps to >=0.25");
  assert.equal(g.tintAdaptivity, 1, "tintAdaptivity default 1");

  // plugin emit() → exactly one glassBackdrop with knobs threaded through
  const s = { ...glassPlugin.defaults, w: 400, h: 120 };
  const ops = glassPlugin.emit(s);
  assert.equal(ops.length, 1, "emit returns one op");
  assert.equal(ops[0].op, "glassBackdrop");
  assert.equal(ops[0].halfW, 200, "halfW = w/2");
  assert.equal(ops[0].halfH, 60, "halfH = h/2");
  assert.equal(ops[0].cornerRadius, glassPlugin.defaults.cornerRadius, "cornerRadius threaded");
  // strokeWidth 0 ⇒ no border op field
  const noBorder = glassPlugin.emit({ ...s, strokeWidth: 0 });
  assert.deepEqual(noBorder[0].stroke, null, "strokeWidth 0 → null stroke");
  console.log("  ok  glass unit assertions");
}

// ── colorful high-contrast backdrops (so refraction/blur/adaptive-tint READ) ──
/** Query→build. A diagonal color gradient + a bright hard-edged band (refraction
 * shows as a bent line across it) + scattered saturated dots (blur has detail),
 * filling the region [x0,y0,x0+w,y0+h] in world units. */
function colorfield(x0, y0, w, h) {
  const cmds = [rect({
    x: x0, y: y0, w, h,
    fill: {
      type: "linearGradient",
      linear: {
        stops: [{ offset: 0, color: "#141852" }, { offset: 0.55, color: "#962882" }, { offset: 1, color: "#f09628" }],
        from: { x: 0, y: 0 }, to: { x: 1, y: 1 },
      },
    },
  })];
  // bright diagonal band (a hard high-contrast edge → refraction reads)
  cmds.push(polygon({
    points: [[x0 - 40, y0 + h * 0.55], [x0 + w + 40, y0 + h * 0.18], [x0 + w + 40, y0 + h * 0.30], [x0 - 40, y0 + h * 0.67]],
    fill: "rgba(245,250,255,0.92)",
  }));
  // scattered saturated dots
  const cols = ["#50dcc8", "#ff5a78", "#ffd246", "#78a0ff", "#b4ff78"];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 40; i++) {
    const r = 6 + rnd() * 24;
    cmds.push(ellipse({ cx: x0 + rnd() * w, cy: y0 + rnd() * h, rx: r, ry: r, fill: cols[i % cols.length] + "d8" }));
  }
  return cmds;
}

/** Query→build. A flat solid field (for the adaptive-tint dark/light probes). */
function solidfield(x0, y0, w, h, color) {
  const cmds = [rect({ x: x0, y: y0, w, h, fill: color })];
  const cols = ["#50dcc8", "#ff5a78", "#ffd246", "#78a0ff"];
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 24; i++) cmds.push(ellipse({ cx: x0 + rnd() * w, cy: y0 + rnd() * h, rx: 8 + rnd() * 18, ry: 8 + rnd() * 18, fill: cols[i % cols.length] + "bb" }));
  return cmds;
}

/** The glass panel op via the plugin's emit(), placed at (px,py) with size (pw,ph). */
function glassPanel(px, py, pw, ph, overrides = {}) {
  const s = { ...glassPlugin.defaults, w: pw, h: ph, ...overrides };
  return [pushTransform({ x: px, y: py }), ...glassPlugin.emit(s), popTransform()];
}

async function renderScene(name, commands) {
  const png = await renderToPng(commands, VIEW, { width: W * DPR, height: H * DPR, background: "#0b0f18" });
  if (!(png instanceof Uint8Array) || png.length < 2000) throw new Error(`${name}: PNG too small (${png?.length} bytes)`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `skia_glass_${name}.png`);
  fs.writeFileSync(out, Buffer.from(png));
  console.log(`  ok  ${name} — ${png.length} bytes → ${out}`);
}

unitTests();

// Glass over the colorful high-contrast field (the money shot — refraction reads).
await renderScene("colorful", [
  ...colorfield(0, 0, W, H),
  ...glassPanel(W / 2 - 220, H / 2 - 80, 440, 160),
]);

// Adaptive tint: glass over a DARK field (expect a PALE/light skin) …
await renderScene("adaptive_dark", [
  ...solidfield(0, 0, W, H, "#0a0c18"),
  ...glassPanel(W / 2 - 220, H / 2 - 70, 440, 140),
]);
// … and over a BRIGHT field (expect a SMOKY/dark skin).
await renderScene("adaptive_light", [
  ...solidfield(0, 0, W, H, "#e8ecf2"),
  ...glassPanel(W / 2 - 220, H / 2 - 70, 440, 140),
]);

// Materialize ramp (the Spotlight appear) — one PNG per stage.
for (const m of [0, 0.2, 0.45, 0.7, 1]) {
  await renderScene(`materialize_${String(Math.round(m * 100)).padStart(3, "0")}`, [
    ...colorfield(0, 0, W, H),
    ...glassPanel(W / 2 - 220, H / 2 - 70, 440, 140, { materialize: m }),
  ]);
}

// Chromatic aberration: default (tiny) vs an EXAGGERATED value, over the bright
// band, so the rim color fringe (red inward / blue outward) is verifiable.
await renderScene("chromatic_default", [
  ...colorfield(0, 0, W, H),
  ...glassPanel(W / 2 - 220, H / 2 - 70, 440, 140, { chromatic: 0.08 }),
]);
await renderScene("chromatic_strong", [
  ...colorfield(0, 0, W, H),
  ...glassPanel(W / 2 - 220, H / 2 - 70, 440, 140, { chromatic: 0.6, refractionStrength: 26 }),
]);

// Resolution factor: half-res vs 2x supersample — both must ALIGN (same backdrop).
await renderScene("backdrop_half", [
  ...colorfield(0, 0, W, H),
  ...glassPanel(W / 2 - 220, H / 2 - 70, 440, 140, { backdropScale: 0.5 }),
]);
await renderScene("backdrop_super2x", [
  ...colorfield(0, 0, W, H),
  ...glassPanel(W / 2 - 220, H / 2 - 70, 440, 140, { backdropScale: 2 }),
]);

// Rotated panel — proves the shader's SDF-frame rotation (light stays from above).
// Emit centered on the transform origin (cx/cy = 0), then wrap in a rotated world.
const rotatedOps = glassPlugin.emit({ ...glassPlugin.defaults, w: 440, h: 150 }).map((o) => ({ ...o, cx: 0, cy: 0 }));
await renderScene("rotated", [
  ...colorfield(0, 0, W, H),
  pushTransform({ x: W / 2, y: H / 2, rotation: 0.32 }),
  ...rotatedOps,
  popTransform(),
]);

console.log("OK skia_glass_test — all glass scenes rendered");
