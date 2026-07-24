/**
 * RAINY WINDOW VLM PROBE (node, no browser) — renders the rainy_window material
 * over a COLOURFUL backdrop at several animation times so a VLM can confirm the two
 * user-reported defects are fixed:
 *   (a) NO seams anywhere (fully procedural, grid-cell decomposition is seamless);
 *   (b) drops visibly SLIDE DOWN between frames leaving a fading refractive TRAIL
 *       behind the head (not static dots that pop in);
 *   (c) drops merge / grow as they descend;
 *   (d) it reads as believable rain-on-glass.
 *
 * Renders the SAME scene at t = 0, 1, 3, 6 s (setParticleTimeOverride makes the
 * emit-time particle clock deterministic), plus a ZOOMED close-up (a seam hunt) and
 * a LOW-rain mist frame. Uses node_render.renderToPng — the SAME GPU pipeline as
 * the editor — so a compile failure throws LOUDLY here. Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/rainy_window_probe.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { rect, ellipse, polygon, text, pushTransform, popTransform } from "../render_gpu/ir.js";
import { rainyWindowPlugin } from "../plugins/demo/rainy_window.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(OUT_DIR, { recursive: true });

/** Command (writes a PNG). Renders IR `commands` at `view` to OUT_DIR/name.png. */
async function renderScene(name, commands, { W, H, background, view }) {
  const png = await renderToPng(commands, view, { width: W * view.dpr, height: H * view.dpr, background });
  if (!(png instanceof Uint8Array) || png.length < 2000) throw new Error(`${name}: PNG too small (${png?.length} bytes)`);
  const out = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(out, Buffer.from(png));
  console.log(`  ok  ${name} — ${png.length} bytes → ${out}`);
}

// ── a saturated, high-frequency backdrop so refraction/lensing reads clearly ───
/** Query→build. Colour bars + scattered circles + a bright diagonal bar + a big
 * label, filling [0,0,W,H] world units — hard edges the drops can bend. */
function colorfulBackdrop(W, H) {
  const cmds = [rect({ x: 0, y: 0, w: W, h: H, fill: "#101024" })];
  const bars = ["#ff4d6d", "#ffb703", "#2ec4b6", "#3a86ff", "#8338ec", "#06d6a0", "#ef476f"];
  const bw = W / bars.length;
  for (let i = 0; i < bars.length; i++) cmds.push(rect({ x: i * bw, y: 0, w: bw, h: H, fill: bars[i], opacity: 0.9 }));
  // a bright near-horizontal bar = a hard edge for the lenses to warp
  cmds.push(rect({ x: -40, y: H * 0.44, w: W + 80, h: H * 0.1, rotation: -0.08, fill: "#f8f9ff" }));
  // scattered saturated circles (deterministic LCG, no Math.random)
  const cols = ["#ffffff", "#00131a", "#ffd000", "#ff006e", "#00f5d4"];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 26; i++) {
    const rr = 18 + rnd() * 34;
    cmds.push(ellipse({ cx: rnd() * W, cy: rnd() * H, rx: rr, ry: rr, fill: cols[i % cols.length] }));
  }
  cmds.push(text({ text: "RAIN", x: W * 0.30, y: H * 0.30, size: H * 0.22, color: "#0b0b16", bold: true }));
  cmds.push(polygon({ points: [[W * 0.6, H * 0.62], [W * 0.82, H * 0.62], [W * 0.71, H * 0.86]], fill: "#000010" }));
  return cmds;
}

/** The rainy window via the plugin emit() at (px,py), size (pw,ph), at time `t`
 * seconds (overrides the ambient clock), with optional knob overrides. */
function rainyPanel(px, py, pw, ph, t, overrides = {}) {
  setParticleTimeOverride(t);
  const s = { ...rainyWindowPlugin.defaults, w: pw, h: ph, ...overrides };
  const cmds = [pushTransform({ x: px, y: py }), ...rainyWindowPlugin.emit(s), popTransform()];
  return cmds;
}

try {
  // ── the animation sweep: same scene, four times — drops must SLIDE between them ─
  {
    const W = 900, H = 600, view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
    const P = { px: 40, py: 40, pw: W - 80, ph: H - 80 };
    for (const t of [0, 1, 3, 6]) {
      await renderScene(`rainy_t${t}`, [
        ...colorfulBackdrop(W, H),
        ...rainyPanel(P.px, P.py, P.pw, P.ph, t, { rain: 0.9, streakiness: 1.6 }),
      ], { W, H, background: "#05060a", view });
    }
  }

  // ── ZOOMED close-up (a small window rendered large) — the seam hunt. If the grid
  //    decomposition leaked, hard horizontal/vertical lines would show here. ──────
  {
    const W = 640, H = 640, view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
    await renderScene("rainy_zoom_seamhunt", [
      ...colorfulBackdrop(W, H),
      ...rainyPanel(30, 30, W - 60, H - 60, 3.4, { rain: 1.0, columns: 3, streakiness: 2.2, dropSize: 1.4 }),
    ], { W, H, background: "#05060a", view });
  }

  // ── LOW rain — a fine condensation mist (static beads), no heavy runners ───────
  {
    const W = 720, H = 480, view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
    await renderScene("rainy_mist_lowrain", [
      ...colorfulBackdrop(W, H),
      ...rainyPanel(30, 30, W - 60, H - 60, 2.0, { rain: 0.25, fog: 0.75 }),
    ], { W, H, background: "#05060a", view });
  }

  setParticleTimeOverride(null); // restore the ambient regime
  console.log("OK rainy_window_probe — all scenes rendered");
} finally {
  setParticleTimeOverride(null);
}
