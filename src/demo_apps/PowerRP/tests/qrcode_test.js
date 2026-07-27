/**
 * QR-Code widget test — proves the vector QR widget is CORRECT and SCANNABLE.
 * Run (from the PowerRP dir): node tests/qrcode_test.js
 *
 * Covers:
 *   (1) pure helpers — qrMatrix (dimension + known cell + loud throw on empty),
 *       qrMatrixToPathD (merged-run geometry), isTransparentColor (doctests).
 *   (2) THE GOLD STANDARD: render the emitted QR IR to PNG through the SAME Skia
 *       pipeline the editor/CLI use (render_gpu/skia/node_render.renderToPng),
 *       DECODE it with jsQR, and assert it round-trips to the EXACT data string
 *       for several (data, ecLevel) pairs — i.e. the rendered code really scans.
 *   (3) SVG export of the widget contains a real <path> (true vector, not a
 *       bitmap), via the pure svg_backend (irToSVG) — no browser needed.
 *   (4) registry/command wiring — the plugin registers as type "qrcode" and its
 *       add-qrcode command is present.
 * Also writes .claude_vlm_checks/qrcode.png for a human/VLM eyeball check.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import jsQR from "jsqr";

import { qrcodePlugin, qrMatrix, qrMatrixToPathD, isTransparentColor, qrDataIsEmpty } from "../plugins/qrcode.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { renderDocToPng } from "../cli/render.js";
import { irToSVG } from "../render_gpu/svg_backend.js";
import { fitRectView } from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VLM_DIR = path.join(HERE, "..", ".claude_vlm_checks");
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const BOX = 200;        // widget box size in local units (square)
const RENDER_PX = 1000; // decode-test surface size (device px) — plenty of module resolution
const PAD = 12;         // extra white padding (local units) around the box for the decoder

// ── (1) pure-helper doctests ─────────────────────────────────────────────────
assert.equal(qrMatrix("HELLO", "M").length, 21, "HELLO@M is a version-1 21x21 symbol");
assert.equal(qrMatrix("HELLO", "M")[0][0], true, "top-left finder module is dark");
assert.throws(() => qrMatrix("", "M"), /QR generation failed/, "empty data throws loudly (no silent fallback)");
assert.throws(() => qrMatrix("x", "Z"), /ecLevel must be/, "bad ecLevel throws");

assert.equal(qrMatrixToPathD([[true]], { boxW: 3, boxH: 3, quietModules: 1 }), "M1 1 h1 v1 h-1 z");
assert.equal(qrMatrixToPathD([[true, true], [false, false]], { boxW: 4, boxH: 4, quietModules: 1 }), "M1 1 h2 v1 h-2 z", "adjacent modules merge into one run");
assert.equal(qrMatrixToPathD([[true, false, true], [false, false, false], [false, false, false]], { boxW: 3, boxH: 3, quietModules: 0 }), "M0 0 h1 v1 h-1 z M2 0 h1 v1 h-1 z");

assert.equal(isTransparentColor(""), true);
assert.equal(isTransparentColor("#ffffff"), false);
assert.equal(isTransparentColor("#ffffff00"), true);
assert.equal(isTransparentColor("rgba(0,0,0,0)"), true);
console.log("OK helpers — qrMatrix / qrMatrixToPathD / isTransparentColor");

// ── (2) decode round-trip: rendered QR must SCAN back to the exact data ───────
/** Command (allocates a Skia surface). Emits the QR widget's IR, renders it to a
 * PNG via the shared Skia pipeline, and returns {png, width, height}. */
async function renderQrPng(data, ecLevel) {
  const state = { ...qrcodePlugin.defaults, data, ecLevel, x: 0, y: 0, w: BOX, h: BOX };
  const commands = qrcodePlugin.emit(state, null, IDENTITY);
  const view = fitRectView({ x: -PAD, y: -PAD, w: BOX + 2 * PAD, h: BOX + 2 * PAD }, RENDER_PX, RENDER_PX, 1);
  const png = await renderToPng(commands, view, { width: RENDER_PX, height: RENDER_PX, background: "#ffffff" });
  return png;
}

/** Query. PNG bytes → the decoded QR string (or null if unreadable). */
function decodeQr(pngBytes) {
  const img = PNG.sync.read(Buffer.from(pngBytes)); // {width, height, data: RGBA}
  const res = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  return res ? res.data : null;
}

const CASES = [
  { data: "https://www.example.com", ecLevel: "M" },
  { data: "HELLO WORLD 12345", ecLevel: "H" },
  { data: "https://example.com/path?q=1&z=2", ecLevel: "Q" },
  { data: "PowerRP", ecLevel: "L" },
];
for (const { data, ecLevel } of CASES) {
  const png = await renderQrPng(data, ecLevel);
  const decoded = decodeQr(png);
  assert.equal(decoded, data, `decode round-trip failed for ${JSON.stringify(data)} @${ecLevel} (got ${JSON.stringify(decoded)})`);
  console.log(`OK scan — ${JSON.stringify(data)} @${ecLevel} round-trips (${png.length} PNG bytes)`);
}

// ── (2b) FULL PIPELINE e2e: a doc with a QR item scans after repair→derive→Skia ─
{
  const cam = { type: "camera", name: "Camera", x: 0, y: 0, w: 1280, h: 720, z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff" };
  const qr = { ...qrcodePlugin.defaults, data: "https://www.example.com", x: 490, y: 110, w: 500, h: 500 };
  const doc = {
    meta: { name: "QR E2E", slideW: 1280, slideH: 720 },
    slides: [{ id: "s1", name: "Slide 1", transition: { seconds: 0.5, curve: "smooth", sound: null, type: "tween" }, delta: { items: { cam, qr } } }],
  };
  const png = await renderDocToPng(JSON.stringify(doc), { slide: 0, alpha: 1, width: 1920, height: 1080 });
  assert.equal(decodeQr(png), "https://www.example.com", "full-pipeline (repair→fold→derive→camera→Skia) QR must scan");
  console.log("OK e2e — a document's QR item renders scannable through the real CLI pipeline");
}

// ── (3) SVG export is real vector (<path>) ────────────────────────────────────
{
  const state = { ...qrcodePlugin.defaults, w: BOX, h: BOX };
  const commands = qrcodePlugin.emit(state, null, IDENTITY);
  const view = fitRectView({ x: 0, y: 0, w: BOX, h: BOX }, BOX, BOX, 1);
  const svg = await irToSVG(commands, { width: BOX, height: BOX, view, background: "#ffffff" });
  assert.ok(svg.startsWith("<svg"), "SVG has an <svg> root");
  assert.ok(svg.includes("<path"), "SVG export contains a real vector <path> (not a raster <image>)");
  assert.ok(!svg.includes("<image"), "QR SVG has no raster <image> — it is fully vector");
  console.log(`OK svg — export is vector, ${svg.length} bytes, contains <path>`);
}

// ── (4) registry + command wiring ─────────────────────────────────────────────
{
  const registry = createRegistry();
  const commands = createCommands();
  registerAll(registry, commands);
  assert.equal(registry.get("qrcode"), qrcodePlugin, "plugin registers under type 'qrcode'");
  assert.ok(commands.get("add-qrcode"), "add-qrcode command is registered");
  console.log("OK wiring — plugin + add-qrcode command registered");
}

// ── (5) EMPTY DATA IS A GHOST, NOT A CRASH (regression: canvas $effect crash) ──
// A QR widget with empty/blank data (freshly cleared) used to reach qrMatrix,
// which throws "No input text", crashing the render $effect and the whole
// canvas. emit() now GHOSTS empty data (returns []) like mermaid/text; qrMatrix
// itself STILL throws loudly on empty (guarded upstream, no silent fallback).
{
  assert.equal(qrDataIsEmpty(""), true);
  assert.equal(qrDataIsEmpty("   "), true, "whitespace-only is empty (nothing to encode)");
  assert.equal(qrDataIsEmpty("https://x"), false);
  assert.equal(qrcodePlugin.isGhost({ data: "" }), true, "empty data → ghost (selectable/findable)");
  assert.equal(qrcodePlugin.isGhost({ data: "https://example.com" }), false);
  for (const data of ["", "   ", undefined]) {
    const state = { ...qrcodePlugin.defaults, data, w: BOX, h: BOX };
    assert.deepEqual(qrcodePlugin.emit(state, null, IDENTITY), [], `empty QR emit must ghost ([]) for ${JSON.stringify(data)}`);
  }
  const valid = qrcodePlugin.emit({ ...qrcodePlugin.defaults, data: "https://www.example.com", w: BOX, h: BOX }, null, IDENTITY);
  assert.ok(valid.some((op) => op.op === "path" && op.d.length > 0), "valid data still emits a QR path op");
  console.log("OK ghost — empty/blank QR data emits [] (no crash), valid data emits a path");
}

// ── VLM eyeball artifact ──────────────────────────────────────────────────────
{
  fs.mkdirSync(VLM_DIR, { recursive: true });
  const png = await renderQrPng(qrcodePlugin.defaults.data, qrcodePlugin.defaults.ecLevel);
  fs.writeFileSync(path.join(VLM_DIR, "qrcode.png"), Buffer.from(png));
  console.log(`OK vlm — wrote ${path.join(VLM_DIR, "qrcode.png")}`);
}

console.log("\nRESULT: PASS — QR widget renders scannable vector codes (decode round-trip + <path> SVG + wiring)");
