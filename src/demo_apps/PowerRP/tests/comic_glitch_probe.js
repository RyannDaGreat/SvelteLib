/**
 * VLM PROBE (not a pass/fail suite) — renders the COMIC HALFTONE and DIGITAL
 * GLITCH backdrop materials to PNGs in .claude_vlm_checks/ so a VLM can judge
 * fidelity, and asserts the GLITCH determinism contract (same particle time ⇒
 * byte-identical pixels; different time ⇒ different pixels).
 *
 *  - COMIC: the demo widget's materialBackdrop op over a smooth tone ramp + colour
 *    fields + text, in each of its 5 presets, so the Ben-Day dot-size-tracks-tone
 *    law, per-channel screen angles, CMYK vs additive-RGB desync, duotone overprint,
 *    mono newsprint, posterize and edge-ink all read on real content.
 *  - GLITCH: the demo widget over an SMPTE colour-bar + text pattern (sharp edges
 *    show the RGB split + block displacement + tear), in each of its 6 presets, plus
 *    3 distinct particle-time frames of ONE preset to show it animates. A determinism
 *    block renders the same doc at t=1.0 twice (must be byte-identical) and at
 *    t=1.0 vs t=2.0 (must differ), via setParticleTimeOverride.
 *
 * Run: node src/demo_apps/PowerRP/tests/comic_glitch_probe.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { rect, ellipse, polygon, text, pushTransform, popTransform } from "../render_gpu/ir.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { comicPlugin } from "../plugins/demo/comic.js";
import { glitchPlugin } from "../plugins/demo/glitch.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude_vlm_checks");
const DPR = 2;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: DPR };
const MIN_PNG_BYTES = 2000; // a real rendered scene is far bigger; a stub/blank would be tiny

/** Command. Renders `commands` to a PNG in OUT_DIR; throws if the PNG is suspiciously
 * small (a blank/failed render). Returns the raw PNG bytes (for checksum compares). */
async function renderScene(name, commands, { W, H, background }) {
  const png = await renderToPng(commands, VIEW, { width: W * DPR, height: H * DPR, background });
  if (!(png instanceof Uint8Array) || png.length < MIN_PNG_BYTES) throw new Error(`${name}: PNG too small (${png?.length} bytes)`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(out, Buffer.from(png));
  console.log(`  ok  ${name} — ${png.length} bytes → ${out}`);
  return png;
}

const RAMP_STRIPS = 48; // vertical strips forming the smooth black→white tone ramp

/** Query→build. A smooth horizontal black→white tone RAMP (top) + primary/secondary
 * colour fields + a skin-tone disc + bold text, filling [x0,y0,w,h] world units. The
 * ramp is the key comic-halftone read: dot SIZE must grow smoothly left→right. */
function tonePattern(x0, y0, w, h) {
  const cmds = [rect({ x: x0, y: y0, w, h, fill: "#ffffff" })];
  const rampH = h * 0.5;
  const sw = w / RAMP_STRIPS;
  for (let i = 0; i < RAMP_STRIPS; i++) {
    const v = Math.round((i / (RAMP_STRIPS - 1)) * 255).toString(16).padStart(2, "0");
    cmds.push(rect({ x: x0 + i * sw, y: y0, w: sw + 1, h: rampH, fill: `#${v}${v}${v}` }));
  }
  // colour fields (CMYK separation + additive RGB both read strongly on saturated hues)
  const fields = ["#e02020", "#20b020", "#2040e0", "#e0d020", "#20c0c0", "#c020c0"];
  const fw = w / fields.length;
  for (let i = 0; i < fields.length; i++) cmds.push(rect({ x: x0 + i * fw, y: y0 + rampH, w: fw + 1, h: h * 0.28, fill: fields[i] }));
  // a skin-tone disc + bold outline text (edge-ink target)
  cmds.push(ellipse({ cx: x0 + w * 0.22, cy: y0 + h * 0.82, rx: h * 0.12, ry: h * 0.12, fill: "#f2b48c" }));
  cmds.push(text({ text: "HALFTONE", x: x0 + w * 0.40, y: y0 + h * 0.74, size: h * 0.16, color: "#101014", bold: true }));
  return cmds;
}

/** Query→build. An SMPTE-ish colour-bar + grey-step + label pattern (sharp edges) —
 * the high-contrast content that makes the glitch split/displacement/tear obvious. */
function barsPattern(x0, y0, w, h) {
  const cmds = [rect({ x: x0, y: y0, w, h, fill: "#0c0c12" })];
  const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  const bw = w / bars.length;
  for (let i = 0; i < bars.length; i++) cmds.push(rect({ x: x0 + i * bw, y: y0, w: bw, h: h * 0.6, fill: bars[i] }));
  const steps = 8;
  const stw = w / steps;
  for (let i = 0; i < steps; i++) {
    const v = Math.round((i / (steps - 1)) * 255).toString(16).padStart(2, "0");
    cmds.push(rect({ x: x0 + i * stw, y: y0 + h * 0.6, w: stw, h: h * 0.18, fill: `#${v}${v}${v}` }));
  }
  cmds.push(text({ text: "SIGNAL", x: x0 + w * 0.28, y: y0 + h * 0.82, size: h * 0.15, color: "#f5fff5", bold: true }));
  cmds.push(ellipse({ cx: x0 + w * 0.14, cy: y0 + h * 0.88, rx: h * 0.05, ry: h * 0.05, fill: "#40ff90" }));
  return cmds;
}

/** Query→build. A widget PANEL via plugin emit(): applies a preset's flat prop map
 * over the plugin defaults, at (px,py) size (pw,ph). */
function panel(plugin, px, py, pw, ph, overrides = {}) {
  const s = { ...plugin.defaults, w: pw, h: ph, ...overrides };
  return [pushTransform({ x: px, y: py }), ...plugin.emit(s), popTransform()];
}

// ── COMIC scenes: one per preset over the tone pattern ────────────────────────
{
  const W = 680, H = 460, PW = 600, PH = 400;
  const px = (W - PW) / 2, py = (H - PH) / 2;
  for (const preset of comicPlugin.presets) {
    const slug = "comic_" + preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    await renderScene(slug, [
      ...tonePattern(0, 0, W, H),
      ...panel(comicPlugin, px, py, PW, PH, preset.props),
    ], { W, H, background: "#20232a" });
  }
  // default knobs (CMYK, no preset) — the out-of-the-box look
  await renderScene("comic_default", [
    ...tonePattern(0, 0, W, H),
    ...panel(comicPlugin, px, py, PW, PH),
  ], { W, H, background: "#20232a" });
}

// ── GLITCH scenes: one per preset over the bars pattern (frozen editor time) ──
{
  const W = 680, H = 420, PW = 600, PH = 360;
  const px = (W - PW) / 2, py = (H - PH) / 2;
  setParticleTimeOverride(1.37); // a representative frame that crosses a burst/step boundary
  for (const preset of glitchPlugin.presets) {
    const slug = "glitch_" + preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    await renderScene(slug, [
      ...barsPattern(0, 0, W, H),
      ...panel(glitchPlugin, px, py, PW, PH, preset.props),
    ], { W, H, background: "#05060a" });
  }
  setParticleTimeOverride(null);
}

// ── GLITCH animation: 3 distinct frames of ONE preset (must look different) ───
{
  const W = 680, H = 420, PW = 600, PH = 360;
  const px = (W - PW) / 2, py = (H - PH) / 2;
  const preset = glitchPlugin.presets.find((p) => p.name === "Heavy Datamosh");
  const frames = [0.20, 0.85, 1.55];
  for (const t of frames) {
    setParticleTimeOverride(t);
    await renderScene(`glitch_anim_t${String(t).replace(".", "_")}`, [
      ...barsPattern(0, 0, W, H),
      ...panel(glitchPlugin, px, py, PW, PH, preset.props),
    ], { W, H, background: "#05060a" });
  }
  setParticleTimeOverride(null);
}

// ── GLITCH determinism: same t ⇒ identical bytes; different t ⇒ different ─────
{
  const W = 480, H = 300, PW = 440, PH = 260;
  const px = (W - PW) / 2, py = (H - PH) / 2;
  const preset = glitchPlugin.presets.find((p) => p.name === "VHS Glitch");
  const scene = () => [...barsPattern(0, 0, W, H), ...panel(glitchPlugin, px, py, PW, PH, preset.props)];

  setParticleTimeOverride(1.0);
  const a1 = await renderScene("glitch_determinism_t1_a", scene(), { W, H, background: "#05060a" });
  const a2 = await renderScene("glitch_determinism_t1_b", scene(), { W, H, background: "#05060a" });
  setParticleTimeOverride(2.0);
  const b = await renderScene("glitch_determinism_t2", scene(), { W, H, background: "#05060a" });
  setParticleTimeOverride(null);

  const same = Buffer.from(a1).equals(Buffer.from(a2));
  const differ = !Buffer.from(a1).equals(Buffer.from(b));
  if (!same) throw new Error("DETERMINISM FAIL: same particle time produced different pixels");
  if (!differ) throw new Error("ANIMATION FAIL: different particle time produced identical pixels");
  console.log(`  ok  glitch determinism — t1==t1 (byte-identical) and t1!=t2 (animates)`);
}

console.log("OK comic_glitch_probe — all scenes rendered + glitch determinism verified");
