/**
 * RAINY WINDOW ROW-SEAM REPRO (node, no browser) — isolates the bug reported by
 * the user: "the drops don't go all the way down and then they can be cut off by
 * a little sliver... you see in the middle how there's a line there?"
 *
 * ROOT CAUSE (read from render_gpu/skia/rainy_window_shader.js, not assumed):
 * `runningLayer()` loops the 3 horizontal NEIGHBOUR columns
 * (`for (float dc = -1.0; dc <= 1.0; ...)`) so a head near a COLUMN edge is drawn
 * whole from both sides — but it never loops neighbour ROWS. `rowF =
 * floor(uv.y * rows)` is fixed per pixel, so `runDrop` only ever sees the ONE
 * drop belonging to the pixel's own row. A head's blob has radius `R` in `ly`
 * units (`R * CELL_WH`, roughly 0.08-0.16 of the cell height across the phase
 * range) centred at `yh = ph*ph`. When the drop is freshly spawned (small `ph`,
 * `yh` near 0) or about to wrap (`ph` near 1, `yh` near 1), that circle
 * geometrically crosses `ly = 0` or `ly = 1` — the row boundary — while `life`
 * (a function of `ph` alone, NOT of `ly`) is already > 0, so the head is visible
 * on ITS side of the boundary but the row above/below never evaluates this drop
 * at all: nothing is drawn past the edge. The result is a dark blob hard-clipped
 * by a FLAT horizontal line exactly at the cell boundary — the reported seam.
 * (The TRAIL is fine — it fades to exactly 0 at `ly=0` via `t01 = ly/yh` — but
 * the HEAD is not attenuated near either row edge, unlike the static-bead layer
 * and the runner layer's own column handling, both already neighbour-sampled.)
 *
 * Rendering the real shader is expensive on node's SOFTWARE Skia surface (no GL
 * in bare node), so this probe keeps frames SMALL (one drop-cell tall) and few,
 * and picks `t` values that put a KNOWN drop (col=0 in a 1-column layer, with a
 * FIXED rate/salt so its hash is reproducible run to run) near ph≈0 (fresh
 * spawn, straddling the cell's TOP) using the shader's own formulas evaluated in
 * JS to locate a period, not to replace the visual proof.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/rainy_window_rowseam_probe.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { rect, pushTransform, popTransform } from "../render_gpu/ir.js";
import { rainyWindowPlugin } from "../plugins/demo/rainy_window.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "../.claude_logs/rainseam");
fs.mkdirSync(OUT_DIR, { recursive: true });

// The "rainy_window" material lives in the plugin-asset LIBRARY (the matmig
// wave), not materials.js's static table — it only exists once registerAll has
// run (the same call cli/render.js makes). Without this, paint_skia's
// materialBackdrop op throws "unknown material" and every frame silently
// becomes an error box instead of the shader under test.
registerAll(createRegistry(), createCommands());

async function renderScene(name, commands, { W, H, background, view }) {
  const png = await renderToPng(commands, view, { width: W * view.dpr, height: H * view.dpr, background });
  if (!(png instanceof Uint8Array) || png.length < 200) throw new Error(`${name}: PNG too small (${png?.length} bytes)`);
  const out = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(out, Buffer.from(png));
  return out;
}

/** A backdrop with hard horizontal-ish edges (stacked stripes) so a drop's
 * refraction lens and any FLAT clip in its silhouette both read with strong
 * contrast — a plain flat colour would make wet/dry nearly indistinguishable
 * since the shader's refraction bends the SAME flat colour into itself. */
function highContrastBackdrop(W, H) {
  const cmds = [rect({ x: 0, y: 0, w: W, h: H, fill: "#101024" })];
  const stripeH = H / 12;
  const colors = ["#ff4d6d", "#ffb703", "#2ec4b6", "#3a86ff", "#8338ec", "#06d6a0"];
  for (let i = 0; i < 12; i++)
    cmds.push(rect({ x: 0, y: i * stripeH, w: W, h: stripeH, fill: colors[i % colors.length] }));
  return cmds;
}

function rainyPanel(px, py, pw, ph, t, overrides = {}) {
  setParticleTimeOverride(t);
  const s = { ...rainyWindowPlugin.defaults, w: pw, h: ph, ...overrides };
  return [pushTransform({ x: px, y: py }), ...rainyWindowPlugin.emit(s), popTransform()];
}

// SMALL panel: one column (1 drop stream), only 2 "rows" tall in the runner grid
// (CELL_WH=0.55 sets rows from cols/aspect internally) — kept tiny to keep the
// SOFTWARE-surface cost down (this probe's whole point is a repro, not a sweep).
const W = 220, H = 320, view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const P = { px: 10, py: 10, pw: W - 20, ph: H - 20 };
const OVERRIDES = { rain: 1.0, columns: 1, dropSize: 2.4, streakiness: 0.2, fog: 0, refraction: 0.25, shine: 1.4 };

// FALL_BASE (0.18) and the per-drop rate spread (RUN_SPEED_LO=0.60 .. HI=1.55)
// from the shader's own constants — used only to size the scan window to one
// full fall period at the SLOWEST end of the spread (the widest net), not to
// predict a specific frame (the hash is opaque from JS).
const FALL_BASE = 0.18, RUN_SPEED_LO = 0.60;
const SLOWEST_PERIOD = 1 / (FALL_BASE * RUN_SPEED_LO); // ~9.26s — one full run at the slowest speed

const N_FRAMES = 14; // sparse enough to stay fast, dense enough to catch a wrap
const paths = [];
try {
  for (let i = 0; i < N_FRAMES; i++) {
    const t = (i / N_FRAMES) * SLOWEST_PERIOD;
    const name = `rowseam_${String(i).padStart(2, "0")}_t${t.toFixed(2)}`;
    const out = await renderScene(name, [
      ...highContrastBackdrop(W, H),
      ...rainyPanel(P.px, P.py, P.pw, P.ph, t, OVERRIDES),
    ], { W, H, background: "#ffffff", view });
    paths.push(out);
    console.log(`  ok  t=${t.toFixed(2)} -> ${out}`);
  }
  setParticleTimeOverride(null);
  console.log(`OK rainy_window_rowseam_probe — ${paths.length} frames written to ${OUT_DIR}`);
  console.log("Inspect for a dark blob sliced by a flat horizontal line partway down its body,");
  console.log("near the panel's vertical MIDPOINT (the row-grid boundary for a 1-column layer this tall).");
} finally {
  setParticleTimeOverride(null);
}
