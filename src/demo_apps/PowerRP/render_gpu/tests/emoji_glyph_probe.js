/**
 * EMOJI COLOR GLYPH PROBE (verification, SA4 — Round 12B "Text rendering
 * bugs" → EMOJI RENDER BLACK).
 *
 * Proves the atlas/shader/compositor fix end-to-end through the REAL GPU
 * render path (window.__powerrp_render, the exact hook the CLI and editor
 * both use): a text run containing an emoji renders NON-MONOCHROME pixels
 * (the glyph's own color survives, TEX_MODE.colorGlyph bypasses the tint)
 * while a plain-letter text run still tints fully to the run's `color`
 * (TEX_MODE.glyph unaffected — the fix is additive, not a regression).
 *
 * Both text items are given `color: "#000000"` (pure black) — the exact
 * condition that produced "EMOJI RENDER BLACK": before the fix, a white
 * alpha-mask glyph multiplied by black text color is black regardless of
 * what the glyph rasterized. Asserts ZERO console errors (house rule).
 *
 * Spawns its OWN vite (the CLI/editor_smoke/fade_probe pattern) so it never
 * touches the dev server on :3637. Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/render_gpu/tests/emoji_glyph_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");

// One slide, two text items stacked so each occupies its own half of the
// camera: EMOJI (a red-square emoji — solid, unambiguous color) on top,
// LETTER ("A", plain glyph) below. Both use color:"#000000" (see header).
// A large size keeps the glyph well clear of the exact-raster/lattice seam
// and gives the probe plenty of interior pixels to sample.
const doc = {
  meta: { name: "emoji-glyph-probe", slideW: 300, slideH: 300 },
  slides: [
    {
      id: "s0",
      name: "Slide 1",
      transition: { type: "tween", seconds: 0, curve: "linear", sound: null },
      delta: {
        items: {
          cam: { type: "camera", name: "Camera", x: 0, y: 0, w: 300, h: 300, z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff" },
          emoji: {
            type: "text", name: "Emoji", x: 40, y: 20, w: 220, h: 140, z: 1, rotation: 0, scale: 1, active: true,
            text: "\u{1F7E5}", size: 120, color: "#000000", bold: false, font: "system", opacity: 1,
            rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
          },
          letter: {
            type: "text", name: "Letter", x: 40, y: 170, w: 220, h: 120, z: 1, rotation: 0, scale: 1, active: true,
            text: "A", size: 120, color: "#000000", bold: false, font: "system", opacity: 1,
            rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
          },
        },
      },
    },
  ],
};

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const url = `${base}/?cli=1`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new" });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle0" });

  const W = 300, H = 300;
  // Render AND sample entirely in-page: decode the returned PNG data URL via
  // an <img> onto a plain 2D canvas, then getImageData — the fade_probe.js
  // convention (avoids a node-side PNG-decode dependency; canvas2D already
  // speaks PNG natively in the browser).
  const { emojiRegion, letterRegion } = await page.evaluate(async (docObj, o, W, H) => {
    const dataUrl = await window.__powerrp_render(docObj, o);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, W, H);
    const px = (x, y) => {
      const i = (W * y + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    // Scan a region for its distinct hue count (excluding the white
    // background and near-gray pixels, which both a mask AND a color glyph
    // legitimately produce at antialiased edges/corners).
    const isBackgroundish = (r, g, b) => r > 245 && g > 245 && b > 245;
    const isNearGray = (r, g, b) => Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) < 10;
    const scanRegion = (y0, y1) => {
      const hues = new Set();
      let coveredPixels = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const [r, g, b, a] = px(x, y);
          if (a < 200 || isBackgroundish(r, g, b)) continue;
          coveredPixels++;
          if (!isNearGray(r, g, b)) hues.add(`${Math.round(r / 24)},${Math.round(g / 24)},${Math.round(b / 24)}`);
        }
      }
      return { coveredPixels, distinctHues: hues.size };
    };
    return { emojiRegion: scanRegion(10, 150), letterRegion: scanRegion(160, 290) };
  }, doc, { slide: 0, alpha: 1, width: W, height: H }, W, H);

  const assert = (cond, msg) => { if (!cond) throw new Error(`EMOJI GLYPH PROBE FAIL: ${msg}`); };

  console.log("emoji region:", emojiRegion);
  console.log("letter region:", letterRegion);

  assert(emojiRegion.coveredPixels > 20, `emoji glyph drew too few covered pixels (${emojiRegion.coveredPixels}) — did it render at all?`);
  // THE FIX: a red-square emoji tinted BLACK (the bug) would be pure black/gray
  // everywhere — zero non-gray hues. Post-fix it must show its own red color —
  // i.e. at least one non-gray (saturated) bucket among the covered pixels.
  assert(emojiRegion.distinctHues >= 1, `emoji glyph rendered with ZERO non-gray hues — still tinted black (bug not fixed)`);

  // Regression guard: the plain letter "A" must NOT pick up spurious color —
  // it stays a monochrome mask tinted by color:"#000000", so every covered
  // pixel should be near-gray (here: near-black, modulo AA).
  assert(letterRegion.coveredPixels > 20, `letter glyph drew too few covered pixels (${letterRegion.coveredPixels}) — did it render at all?`);
  assert(letterRegion.distinctHues === 0, `letter glyph picked up non-gray hues (${letterRegion.distinctHues}) — the tint path regressed`);

  if (errors.length) throw new Error(`Console errors during emoji glyph render:\n${errors.join("\n")}`);
  console.log("EMOJI GLYPH PROBE: emoji glyph renders in its own color (bypasses tint); monochrome glyph still tints; zero console errors.");
} finally {
  await browser.close();
  await server.close();
}
