/** Native Multipoint text uses widget-box coordinates, never per-run ink bounds.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_text_test.js
 * Real CanvasKit/font fixtures; no browser, new dependencies, or generated assets.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { committedFaces, fontFileFor, FALLBACK_FACES } from "../render_gpu/fonts.js";
import { makeFontkitOutlines } from "../render_gpu/fontkit_outlines.js";
import { setInkMeasure } from "../core/ink_metrics.js";
import { setGlyphOutlines, setGlyphShapedPlacement } from "../core/glyph_outlines.js";
import { text, rect, pushTransform, popTransform } from "../render_gpu/ir.js";
import { getTextLayout, multipointTextBounds, makeSkiaRunMeasure, makeSkiaShapedPlacement } from "../render_gpu/skia/text_layout.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { resolveMaterialFillPaints } from "../render_gpu/ports.js";
import { multipointFeature } from "../core/multipoint.js";
import { paintModifierPoints } from "../core/paint_handles.js";
import { plaintextPlugin } from "../plugins/plaintext.js";
import { textPlugin } from "../plugins/text.js";

const require = createRequire(import.meta.url);
const CK_BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CK = await require("canvaskit-wasm/bin/canvaskit.js")({ locateFile: f => path.join(CK_BIN, f) });
const provider = CK.TypefaceFontProvider.Make();
for (const { family, file } of [
  ...committedFaces().map(f => ({ family: f.cssFamily, file: f.file })), ...FALLBACK_FACES,
]) provider.registerFont(fs.readFileSync(new URL(`../fonts/${file}`, import.meta.url)), family);
const fc = CK.FontCollection.Make();
fc.setDefaultFontManager(provider);
fc.enableFontFallback();
// Install all three seams against THIS CanvasKit/collection: a second WASM
// instance cannot safely reuse text_layout's global Paragraph cache.
setInkMeasure(makeSkiaRunMeasure(CK, fc));
setGlyphOutlines(makeFontkitOutlines(
  (fontId, bold) => fs.readFileSync(new URL(`../fonts/${fontFileFor(fontId, bold)}`, import.meta.url)),
  require("@pdf-lib/fontkit"),
));
setGlyphShapedPlacement(makeSkiaShapedPlacement(CK, fc));

// Five point constraints make both axes observable, including the handle at .5,.5.
const FIELD = { type: "multipointGradient", multipoint: { features: [
  [0, 0, "#ff0000"], [1, 0, "#0000ff"], [0, 1, "#ffff00"], [1, 1, "#ff00ff"], [0.5, 0.5, "#00ff00"],
].map(([x, y, color]) => ({ ...multipointFeature("point", color), nodes: [[x, y, 0, 0, 0, 0]] })) } };
const WIDTH = 900, HEIGHT = 600;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const BASE = { text: "Hi", x: 31, y: 27, size: 44, color: FIELD, font: "inter", boxW: 720, boxH: 420,
  boxStyle: { align: "left", valign: "top" } };
const BYTE_TOLERANCE = 2; // separate Skia mask/paint paths may round one byte each
const MIN_INK_PIXELS = 100; // rule out vacuous success from missing fonts or blank text
// Constant shader uses the SAME drawGlyphs mask as Multipoint, rather than the
// Paragraph's differently antialiased solid-text path (not a coordinate oracle).
const WHITE_SHADER = { type: "linearGradient", stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#fff" }] };

/**
 * Command. Renders ordinary IR to an unpremultiplied (HEIGHT, WIDTH, 4) RGBA buffer.
 * @param {object[]} commands - Display list, e.g. [text(BASE)].
 * @returns {Uint8Array} (600,900,4) RGBA pixels; owns no surviving surface.
 */
function render(commands) {
  const surface = CK.MakeSurface(WIDTH, HEIGHT);
  assert.ok(surface);
  try {
    paintIR(CK, surface.getCanvas(), commands, VIEW, {
      fontCollection: fc, background: "#00000000", makeSurface: (w, h) => CK.MakeSurface(w, h),
    });
    surface.flush();
    const image = surface.makeImageSnapshot();
    try {
      return image.readPixels(0, 0, { width: WIDTH, height: HEIGHT, colorType: CK.ColorType.RGBA_8888,
        alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB });
    } finally { image.delete(); }
  } finally { surface.dispose(); }
}

/**
 * Pure function. Replaces fill or outline paint, keeping text and all layout metrics.
 * @param {object} cmd - Text op.
 * @param {*} color - Replacement paint.
 * @param {string} slot - color, outlineColor, or widget-level glyphStroke.
 * @returns {object} Recoloured op.
 * @example recolor({text:"Hi", color:FIELD}, "#fff").color // "#fff"
 */
function recolor(cmd, color, slot = "color") {
  return { ...cmd, [slot]: color, ...(cmd.rich && slot !== "glyphStroke" ? {
    rich: { ...cmd.rich, runs: cmd.rich.runs.map(run => ({ ...run, [slot]: color })) },
  } : {}) };
}

/**
 * Command. Compares every fully covered glyph pixel with the same field on a box.
 * A separately rendered white text mask prevents shader alpha from hiding errors.
 * @param {string} name - Case label printed on success.
 * @param {object} cmd - Text op, including real boxW/boxH and x/y.
 * @param {object} world - Optional node transform, applied identically to text/box.
 * @param {string} slot - Paint slot whose opaque mask is compared against the box.
 * @returns {number} Number of interior pixels checked (at least MIN_INK_PIXELS).
 */
function matchesBox(name, cmd, world = {}, slot = "color") {
  const wrap = op => [pushTransform(world), op, popTransform()];
  const mask = render(wrap({ ...recolor(cmd, WHITE_SHADER, slot), opacity: 1 }));
  const solidMask = render(wrap({ ...recolor(cmd, "#ffffff", slot), opacity: 1 }));
  const actual = render(wrap(cmd));
  const fill = slot === "glyphStroke" ? cmd.glyphStroke : cmd.rich?.runs[0][slot] ?? cmd[slot];
  const box = render(wrap(rect({ x: cmd.x, y: cmd.y, w: cmd.boxW, h: cmd.boxH, fill, opacity: cmd.opacity ?? 1 })));
  let checked = 0, worst = 0, worstPixel = null;
  for (let i = 0; i < mask.length; i += 4) {
    if (mask[i + 3] !== 255 || solidMask[i + 3] !== 255) continue;
    checked++;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(actual[i + c] - box[i + c]);
      if (delta > worst) { worst = delta; worstPixel = { x: (i / 4) % WIDTH, y: Math.floor(i / 4 / WIDTH), channel: c, actual: [...actual.slice(i, i + 4)], box: [...box.slice(i, i + 4)] }; }
    }
  }
  assert.ok(checked >= MIN_INK_PIXELS, `${name}: only ${checked} opaque mask pixels`);
  assert.ok(worst <= BYTE_TOLERANCE, `${name}: glyph vs box differs by ${worst} bytes over ${checked} pixels: ${JSON.stringify(worstPixel)}`);
  console.log(`  ok  ${name}: ${checked} ink pixels, max channel error ${worst}`);
  return checked;
}

assert.deepEqual(multipointTextBounds(720, 420, 31, 27), { x: 31, y: 27, w: 720, h: 420 });
for (const [w, h] of [[Infinity, 420], [720, Infinity], [NaN, 100], [0, 100], [100, -1]])
  assert.throws(() => multipointTextBounds(w, h), /finite positive boxW and boxH/);

// Actual handles and shader box, not merely an assertion against a source constant.
const handles = paintModifierPoints({ w: BASE.boxW, h: BASE.boxH, fill: FIELD });
const center = handles.find(h => h.id === "fill-mp-4-node-0");
assert.deepEqual([center.x, center.y], [BASE.boxW / 2, BASE.boxH / 2]);
const fieldPixels = render([rect({ x: 0, y: 0, w: BASE.boxW, h: BASE.boxH, fill: FIELD })]);
const centerPixel = (center.y * WIDTH + center.x) * 4;
assert.ok(fieldPixels[centerPixel + 1] > 240 && fieldPixels[centerPixel] < 15 && fieldPixels[centerPixel + 2] < 15,
  `green .5,.5 point must appear at the actual widget handle: ${fieldPixels.slice(centerPixel, centerPixel + 4)}`);

matchesBox("short Hi in huge non-square box, nonzero op origin", text(BASE));
for (const valign of ["middle", "bottom"])
  matchesBox(`right aligned Hi, ${valign}`, text({ ...BASE, boxStyle: { align: "right", valign } }));

const rich = { runs: [
  { text: "Hi ", size: 44, font: "inter", color: FIELD },
  { text: "wide", size: 32, font: "inter", bold: true, color: FIELD },
  { text: "\nHi again\nThird line", size: 38, font: "inter", color: FIELD },
], paras: [{}, { align: "center" }, { align: "right" }] };
const richOp = text({ ...BASE, rich, boxStyle: { align: "left", valign: "middle" } });
assert.equal(getTextLayout(CK, fc, richOp).built.length, 3);
matchesBox("hard newlines, mixed sizes/styles, three paragraph origins", richOp);
matchesBox("world translation, rotation and scale plus op position", richOp,
  { x: 84, y: 18, rotation: 0.12, scale: 0.85 });
matchesBox("soft-wrapped lines share field", text({ ...BASE, text: "Hi there Hi there Hi there Hi there", boxW: 190, boxH: 480 }));
matchesBox("opacity folded once", text({ ...BASE, opacity: 0.6 }));

// Existing emitters and native builder already forward both dimensions unchanged.
const plainOp = plaintextPlugin.emit({ ...plaintextPlugin.defaults, text: "Hi", w: 720, h: 420, fill: FIELD })[0];
const pluginRichOp = textPlugin.emit({ ...textPlugin.defaults, text: rich, w: 720, h: 420 })[0];
for (const [name, cmd] of [["plaintext emit", plainOp], ["rich text emit", pluginRichOp]]) {
  assert.equal(cmd.boxW, 720); assert.equal(cmd.boxH, 420);
  matchesBox(name, cmd);
}

const crossfade = { type: "crossfade", from: FIELD, to: "#ffffff", t: 0.35 };
matchesBox("Multipoint crossfade through ordinary op router", text({ ...BASE, color: crossfade }));
matchesBox("rich-run Multipoint crossfade", recolor(richOp, crossfade));

const outlineOp = text({ ...BASE, color: "#00000000", rich: { runs: [{ text: "Hi\nHi", size: 72, font: "inter",
  color: "#00000000", outlineColor: FIELD, outlineWidth: 5 }], paras: [{}, {}] } });
matchesBox("per-run Multipoint outline uses whole box", outlineOp, {}, "outlineColor");
const outlineWorld = { x: 84, y: 18, rotation: 0.12, scale: 0.85 };
const outlineCrossfade = recolor(outlineOp, crossfade, "outlineColor");
matchesBox("outline-only rich crossfade through op router", outlineCrossfade, {}, "outlineColor");
matchesBox("outline-only rich crossfade, world transform and opacity", { ...outlineCrossfade, opacity: 0.6 }, outlineWorld, "outlineColor");

// Real widget emission, with fill transparent so missing outlines cannot pass.
// Nonzero op origin is separate from the world transform: neither belongs in
// the shader bounds after drawTextGlyphStroke translates to box-local space.
const glyphOp = { ...plaintextPlugin.emit({ ...plaintextPlugin.defaults,
  text: "Hi\nHi", size: 72, font: "inter", w: BASE.boxW, h: BASE.boxH,
  align: "right", valign: "bottom", fill: "#00000000", glyphStroke: FIELD, glyphStrokeWidth: 5,
})[0], x: BASE.x, y: BASE.y };
assert.equal(glyphOp.boxW, BASE.boxW); assert.equal(glyphOp.boxH, BASE.boxH);
assert.equal(glyphOp.glyphStrokeWidth, 5);
matchesBox("widget Multipoint glyph stroke, nonzero op origin", glyphOp, {}, "glyphStroke");
matchesBox("widget Multipoint glyph stroke, world translation/rotation/scale", glyphOp, outlineWorld, "glyphStroke");
matchesBox("widget glyph-stroke crossfade through op router", recolor(glyphOp, crossfade, "glyphStroke"), {}, "glyphStroke");
matchesBox("widget glyph-stroke crossfade, world transform and opacity",
  { ...recolor(glyphOp, crossfade, "glyphStroke"), opacity: 0.6 }, outlineWorld, "glyphStroke");

// Calling layout directly still bypasses the required crossfade router.
assert.throws(() => getTextLayout(CK, fc, outlineCrossfade).draw({}, BASE.x, BASE.y),
  /Multipoint outlineColor crossfade.*op paint router/);
assert.throws(() => getTextLayout(CK, fc, text({ ...BASE, boxH: Infinity })).draw({}, BASE.x, BASE.y),
  /finite positive boxW and boxH/);

// x/y stay OUT of cache identity; a cached layout must re-anchor on every draw.
assert.equal(getTextLayout(CK, fc, text(BASE)), getTextLayout(CK, fc, text({ ...BASE, x: 75, y: 60 })));
matchesBox("cached layout redrawn at another origin", text({ ...BASE, x: 75, y: 60 }));

// Legacy modes deliberately keep ink-relative coordinates: enlarging an otherwise
// identical left/top box must not change their pixels. No migration of old looks.
const stops = [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }];
const material = resolveMaterialFillPaints([text({ ...BASE,
  color: { type: "material", material: { id: "metal", params: {} } },
})], null, null)[0].color;
for (const color of ["#345678", { type: "linearGradient", stops },
  { type: "radialGradient", stops, center: { x: 0.5, y: 0.5 }, r: 0.5 }, material]) {
  const a = render([text({ ...BASE, color, boxW: 150, boxH: 100 })]);
  const b = render([text({ ...BASE, color })]);
  assert.deepEqual(a, b, `legacy ${color.type ?? "solid"} must remain ink-framed`);
  console.log(`  ok  legacy ${color.type ?? "solid"} unchanged by box dimensions`);
}
console.log("multipoint_text_test: OK");
