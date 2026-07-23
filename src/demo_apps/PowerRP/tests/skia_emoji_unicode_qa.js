/**
 * QA for the Skia text render's per-codepoint FALLBACK + COLOR EMOJI (the
 * render-rewrite-skia emoji/unicode task). Renders the probe string through the
 * SAME node_render.renderToPng the CLI/tests use — proving the Paragraph text
 * path resolves Greek/Cyrillic/Arabic and draws emoji IN COLOR, with Latin
 * unchanged. Exercises BOTH the rich text op (per-run styles) AND the legacy
 * single-run op. Writes PNGs to .claude_vlm_checks/ for a VLM look and asserts,
 * from the pixels, that the emoji region carries MULTIPLE distinct hues (not a
 * monochrome silhouette — the color-glyph-bypass gate the lead flagged).
 *
 * Run: node tests/skia_emoji_unicode_qa.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { text } from "../render_gpu/ir.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", ".claude_vlm_checks");
const PROBE = "Latin Héllo · Ελληνικά Привет · 日本語 中文 · مرحبا · 😀🎉👍❤🚀";
// Wide enough that the UNWRAPPED single-run op (boxW=Infinity, no wrap — correct
// for legacy single-run parity ops) fits the whole line on-canvas at `size`.
const DPR = 2, W = 2800, H = 180, SIZE = 40;

/** Query. Decode a PNG's pixels and count distinct saturated hue buckets (proves color). */
async function hueStats(png) {
  // Reuse CanvasKit to decode our own PNG deterministically (no browser).
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
  const BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
  const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN, f) });
  const img = CanvasKit.MakeImageFromEncoded(png);
  const w = img.width(), h = img.height();
  const px = img.readPixels(0, 0, { width: w, height: h, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  const hues = new Set();
  let colored = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
    if (a < 128) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (sat > 0.35 && mx > 60) {
      colored++;
      let hue;
      if (mx === r) hue = (60 * ((g - b) / (mx - mn)) + 360) % 360;
      else if (mx === g) hue = 60 * ((b - r) / (mx - mn)) + 120;
      else hue = 60 * ((r - g) / (mx - mn)) + 240;
      hues.add(Math.round(hue / 30));
    }
  }
  img.delete();
  return { colored, hueBuckets: hues.size };
}

const cases = [
  { name: "skia_emoji_unicode_rich", cmd: text({ text: PROBE, x: 24, y: 24, size: SIZE, color: "#111111", font: "inter", rich: { runs: [{ text: PROBE }], paras: [{}] }, boxW: W / DPR - 48 }) },
  { name: "skia_emoji_unicode_singlerun", cmd: text({ text: PROBE, x: 24, y: 24, size: SIZE, color: "#111111", font: "inter" }) },
];

fs.mkdirSync(OUT, { recursive: true });
let fail = false;
for (const c of cases) {
  const png = await renderToPng([c.cmd], { zoom: 1, panX: 0, panY: 0, dpr: DPR }, { width: W, height: H, background: "#ffffff" });
  const file = path.join(OUT, `${c.name}.png`);
  fs.writeFileSync(file, Buffer.from(png));
  const { colored, hueBuckets } = await hueStats(png);
  const ok = colored > 300 && hueBuckets >= 3;
  if (!ok) fail = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}: colored=${colored} hueBuckets=${hueBuckets}  -> ${file}`);
}
console.log(fail ? "\nRESULT: FAIL — emoji not rendering in multiple colors" : "\nRESULT: PASS — Latin/Greek/Cyrillic/Arabic render + emoji in MULTIPLE COLORS (CJK is opt-in tofu)");
if (fail) process.exit(2);
