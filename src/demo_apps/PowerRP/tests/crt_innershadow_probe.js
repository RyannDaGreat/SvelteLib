/**
 * VLM PROBE (not a pass/fail suite) — renders the CRT material and the inner
 * shadow to PNGs in .claude_vlm_checks/ so a VLM can judge fidelity + iterate.
 *
 *  - CRT: the crt demo widget's materialBackdrop op over a recognizable test
 *    pattern (colour bars + text + shapes), so scanlines / curvature / phosphor /
 *    vignette / convergence all read on real content.
 *  - INNER SHADOW: a light rounded rect WITH a strong inner shadow beside an
 *    identical one WITHOUT, so the recessed/inset look is obvious; plus an
 *    offset variant.
 *
 * Run: node src/demo_apps/PowerRP/tests/crt_innershadow_probe.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { rect, ellipse, polygon, text, pushTransform, popTransform, effectSubtree } from "../render_gpu/ir.js";
import { crtPlugin } from "../plugins/demo/crt.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude_vlm_checks");
const DPR = 2;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: DPR };

async function renderScene(name, commands, { W, H, background }) {
  const png = await renderToPng(commands, VIEW, { width: W * DPR, height: H * DPR, background });
  if (!(png instanceof Uint8Array) || png.length < 2000) throw new Error(`${name}: PNG too small (${png?.length} bytes)`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(out, Buffer.from(png));
  console.log(`  ok  ${name} — ${png.length} bytes → ${out}`);
}

// ── a recognizable TV test pattern (colour bars + label + shapes) ─────────────
/** Query→build. SMPTE-ish vertical colour bars + a big label + a white grid line,
 * filling [x0,y0,w,h] world units — high-contrast content so the CRT effects read. */
function testPattern(x0, y0, w, h) {
  const cmds = [rect({ x: x0, y: y0, w, h, fill: "#101014" })];
  const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  const bw = w / bars.length;
  for (let i = 0; i < bars.length; i++) cmds.push(rect({ x: x0 + i * bw, y: y0, w: bw, h: h * 0.62, fill: bars[i] }));
  // lower band: black-to-white steps
  const steps = 8;
  const sw = w / steps;
  for (let i = 0; i < steps; i++) {
    const v = Math.round((i / (steps - 1)) * 255).toString(16).padStart(2, "0");
    cmds.push(rect({ x: x0 + i * sw, y: y0 + h * 0.62, w: sw, h: h * 0.16, fill: `#${v}${v}${v}` }));
  }
  // white label + a couple of shapes for edge detail
  cmds.push(text({ text: "CRT", x: x0 + w * 0.32, y: y0 + h * 0.80, size: h * 0.16, color: "#f5fff5", bold: true }));
  cmds.push(ellipse({ cx: x0 + w * 0.18, cy: y0 + h * 0.86, rx: h * 0.06, ry: h * 0.06, fill: "#40ff90" }));
  cmds.push(polygon({ points: [[x0 + w * 0.72, y0 + h * 0.78], [x0 + w * 0.86, y0 + h * 0.78], [x0 + w * 0.79, y0 + h * 0.92]], fill: "#ff6060" }));
  return cmds;
}

/** The CRT panel via the plugin emit(), at (px,py), size (pw,ph). */
function crtPanel(px, py, pw, ph, overrides = {}) {
  const s = { ...crtPlugin.defaults, w: pw, h: ph, ...overrides };
  return [pushTransform({ x: px, y: py }), ...crtPlugin.emit(s), popTransform()];
}

/** An inner-shadowed rounded rect: the effectSubtree the effects bundle builds
 * (content carries its own world), rendered directly to isolate the inner shadow. */
function innerShadowRect(px, py, w, h, inner, { fill = "#dfe4ea", cornerRadius = 28 } = {}) {
  const world = { x: px, y: py, rotation: 0, scale: 1 };
  return [effectSubtree({
    x: 0, y: 0, w, h,
    innerShadow: inner,
    content: [pushTransform(world), rect({ x: 0, y: 0, w, h, fill, cornerRadius }), popTransform()],
  })];
}

// ── CRT scenes ────────────────────────────────────────────────────────────────
{
  const W = 720, H = 560, PW = 620, PH = 470;
  await renderScene("crt_default", [
    ...testPattern(0, 0, W, H),
    ...crtPanel((W - PW) / 2, (H - PH) / 2, PW, PH),
  ], { W, H, background: "#05060a" });

  // exaggerated look (stronger curvature / scanlines / phosphor) — reads the knobs
  await renderScene("crt_strong", [
    ...testPattern(0, 0, W, H),
    ...crtPanel((W - PW) / 2, (H - PH) / 2, PW, PH, {
      curvature: 0.30, scanlineStrength: 0.6, maskStrength: 0.6, maskPitch: 5, vignette: 0.55, halation: 0.35, diffusion: 0.3, convergence: 0.05,
    }),
  ], { W, H, background: "#05060a" });

  // flat / minimal (curvature 0, no mask) — sanity that knobs turn effects off
  await renderScene("crt_flat", [
    ...testPattern(0, 0, W, H),
    ...crtPanel((W - PW) / 2, (H - PH) / 2, PW, PH, {
      curvature: 0, scanlineStrength: 0.15, maskStrength: 0, maskType: "none", vignette: 0.15, convergence: 0, bezel: 0.02, halation: 0, diffusion: 0,
    }),
  ], { W, H, background: "#05060a" });
}

// ── inner-shadow scenes ─────────────────────────────────────────────────────────
{
  const W = 760, H = 320;
  const rw = 200, rh = 200, cy = (H - rh) / 2;
  await renderScene("inner_shadow", [
    // plain (inner shadow OFF, opacity 0) — the reference
    ...innerShadowRect(40, cy, rw, rh, { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 }),
    // even recess (dx=dy=0, big blur)
    ...innerShadowRect(280, cy, rw, rh, { dx: 0, dy: 0, blur: 18, color: "#000000", opacity: 0.85 }),
    // directional (offset toward bottom-right → deeper on top-left inner edge)
    ...innerShadowRect(520, cy, rw, rh, { dx: 10, dy: 10, blur: 16, color: "#000000", opacity: 0.85 }),
  ], { W, H, background: "#f2f4f7" });

  // colored inner shadow on a colored fill (inset colored glow)
  await renderScene("inner_shadow_color", [
    ...innerShadowRect(40, cy, rw, rh, { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 }, { fill: "#ffd24a" }),
    ...innerShadowRect(280, cy, rw, rh, { dx: 6, dy: 6, blur: 4, color: "#7a2a00", opacity: 0.9 }, { fill: "#ffd24a" }),
    ...innerShadowRect(520, cy, rw, rh, { dx: 0, dy: 0, blur: 22, color: "#001a55", opacity: 0.9 }, { fill: "#7ec8ff" }),
  ], { W, H, background: "#f2f4f7" });
}

console.log("OK crt_innershadow_probe — all scenes rendered");
