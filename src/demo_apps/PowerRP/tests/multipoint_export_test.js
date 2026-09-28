/**
 * Multipoint export ROUTING checks; no pixel/shader claim.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_export_test.js
 * Mock PNG proves existing raster callback + embedding, not field rendering.
 * Pixel rendering is covered separately by multipoint_text_test.js; these
 * checks cover exporter routing, not SVG/PDF raster parity.
 */
import assert from "node:assert/strict";
import { rect, text, polyline, cropSubtree, effectSubtree, parsePaint, pushTransform, popTransform } from "../render_gpu/ir.js";
import { irToSVG, paintRef, gradientDefSVG } from "../render_gpu/svg_backend.js";
import { irToPDF } from "../render_gpu/pdf_backend.js";
import { isConfigurationError } from "../core/paint_containment.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const STUB_PNG = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));
const PAGE = { width: 200, height: 150, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff" };
const BOX = { x: 40, y: 30, w: 80, h: 60 };
const OPACITY = 0.375;
const STORED = {
  type: "multipointGradient", solid: "#ff00ff",
  linear: { stops: [{ offset: 0, color: "#00ff00" }], angle: 0 },
  multipoint: {
    features: [{
      nodes: [[0.2, 0.3, 0, 0, 0.1, 0], [0.8, 0.7, -0.1, 0, 0, 0]],
      stops: [{ offset: 0, color: "#ff000080", rightColor: "#00ff0040" }, { offset: 1, color: "#0000ff", rightColor: "#ffff00" }],
      weight: 2, twoSided: true, closed: false,
    }],
    featuresActive: [true],
  },
};
const PARSED = parsePaint(STORED);
const CROSSFADE = { type: "crossfade", from: "#000000", to: STORED, t: 0.25 };
const FIELD_RECT = rect({ ...BOX, fill: STORED, opacity: OPACITY });
const BELOW = rect({ x: 0, y: 0, w: 10, h: 10, fill: "#112233" });
const ABOVE = rect({ x: 180, y: 130, w: 10, h: 10, fill: "#abcdef" });
const TRANSFORM = { x: 3, y: 4, rotation: Math.PI / 12, scale: 1 };
const TEXT = { text: "Field", x: 40, y: 30, size: 18, color: "#000000", opacity: OPACITY, font: "system" };

const CASES = [
  ["parsed fill", FIELD_RECT],
  ["stored fill", { ...FIELD_RECT, fill: STORED }],
  ["stroke", rect({ ...BOX, fill: "#ffffff", stroke: STORED, strokeWidth: 4, opacity: OPACITY })],
  ["text color", text({ ...TEXT, color: STORED })],
  ["glyph stroke", text({ ...TEXT, glyphStroke: STORED, glyphStrokeWidth: 2 })],
  ["rich run color", text({ ...TEXT, rich: { runs: [{ text: "Field", color: STORED }] } })],
  ...[["outline-only rich run", STORED], ["outline-only rich crossfade", CROSSFADE],
    ["outline-only nested rich crossfade", { type: "crossfade", from: CROSSFADE, to: "#ffffff", t: 0.5 }],
  ].map(([name, outlineColor]) => [name, text({ ...TEXT, color: "#00000000", boxW: BOX.w, boxH: BOX.h,
    rich: { runs: [{ text: "Field", color: "#00000000", outlineColor, outlineWidth: 4 }] },
  })]),
  ["polyline color", polyline({ points: [[40, 30], [120, 90]], width: 4, color: STORED, opacity: OPACITY })],
  ["crossfade fill", rect({ ...BOX, fill: CROSSFADE, opacity: OPACITY })],
  ["nested crossfade run", text({ ...TEXT, rich: { runs: [{ text: "Field", color: { type: "crossfade", from: CROSSFADE, to: "#ffffff", t: 0.5 } }] } })],
  // Raw IR isolates exporter behavior: cropSubtree's builder currently reduces
  // its own paints with parseColor (upstream responsibility, not this test).
  ["crop fill before special dispatch", { ...cropSubtree({ ...BOX, content: [BELOW], opacity: OPACITY }), fill: PARSED }],
  ["crop stroke before special dispatch", { ...cropSubtree({ ...BOX, content: [BELOW], opacity: OPACITY }), stroke: PARSED, strokeWidth: 4 }],
];
let calls = [];
let passed = 0;

/**
 * Command. Records raster inputs and returns a fixed PNG, without rendering.
 * @param {object[]} commands - Unchanged region IR, including original opacity.
 * @param {object} view - Region world-to-pixel mapping.
 * @param {number} width - Requested raster width in pixels.
 * @param {number} height - Requested raster height in pixels.
 * @param {*} background - Region background.
 * @returns {Promise<Uint8Array>} Encoded 1×1 RGBA PNG, not a rendered scene.
 * @example await rasterize([FIELD_RECT], PAGE.view, 80, 60, null) // STUB_PNG; records one call
 */
async function rasterize(commands, view, width, height, background) {
  calls.push({ commands, view, width, height, background });
  return STUB_PNG;
}

/**
 * Command. Asserts exported bytes contain the mock raster (no pixel comparison).
 * @param {string} format - SVG or PDF.
 * @param {string|Uint8Array} output - Serialized export.
 * @returns {void}
 * @example assertEmbedded("SVG", `<image href="data:image/png;base64,${PNG_BASE64}"/>`) // undefined
 */
function assertEmbedded(format, output) {
  if (format === "SVG") {
    assert.match(output, /<image\b/);
    assert.ok(output.includes(`href="data:image/png;base64,${PNG_BASE64}"`));
    assert.doesNotMatch(output, /<image\b[^>]*\sopacity=/, "opacity must be baked once, not applied again to image");
    assert.doesNotMatch(output, /<linearGradient|<radialGradient/, "Multipoint must not masquerade as a native gradient");
  } else {
    const pdf = Buffer.from(output).toString("latin1");
    assert.ok(pdf.startsWith("%PDF-"));
    assert.match(pdf, /\/Subtype \/Image/);
    assert.doesNotMatch(pdf, /\/ShadingType/);
  }
}

for (const [format, exportScene] of [["SVG", irToSVG], ["PDF", irToPDF]]) {
  for (const [name, cmd] of CASES) {
    calls = [];
    const snapshot = structuredClone(cmd);
    const output = await exportScene([BELOW, pushTransform(TRANSFORM), cmd, popTransform(), ABOVE], { ...PAGE, rasterize });
    assert.equal(calls.length, 1, `${format} ${name}: expected existing raster callback`);
    const call = calls[0];
    assert.ok(call.commands.includes(cmd), "forward original op, not representative solid");
    assert.ok(call.commands.includes(BELOW), "retain below-content for compositing");
    assert.ok(!call.commands.includes(ABOVE), "later vector content stays outside raster");
    assert.equal(call.commands.at(-1).op, "popTransform", "balance sliced transform stack");
    assert.deepEqual(cmd, snapshot, "export must not mutate paints or opacity");
    assert.equal(cmd.opacity, OPACITY);
    assert.equal(call.background, PAGE.background);
    assert.ok(call.width > 0 && call.height > 0 && call.view.zoom > 0);
    assertEmbedded(format, output);
    if (format === "SVG") assert.match(output, /rgba\(171,205,239,1\)/, "later solid remains vector");
    await assert.rejects(exportScene([cmd], PAGE), {
      message: /Multipoint.*no rasterize callback was provided/,
    });
    console.log(`ok ${format}: ${name}, payload/opacity retained, embed, no-callback rejection`);
    passed++;
  }

  // Nested content enters the same existing region walk (PDF can keep an
  // effect's content vector; SVG rasterizes its wrapper by existing policy).
  for (const wrapper of [cropSubtree, effectSubtree]) {
    calls = [];
    const wrapped = wrapper({ ...BOX, content: [FIELD_RECT], ...(wrapper === effectSubtree ? { blend: "multiply" } : {}) });
    assertEmbedded(format, await exportScene([wrapped], { ...PAGE, rasterize }));
    assert.equal(calls.length, 1);
    await assert.rejects(exportScene([wrapped], PAGE), /no rasterize callback was provided/);
    passed++;
  }

  calls = [];
  const unknown = { op: "futureUnrepresentableOp", ...BOX, opacity: OPACITY };
  assertEmbedded(format, await exportScene([unknown], { ...PAGE, rasterize }));
  assert.equal(calls.length, 1);
  await assert.rejects(exportScene([unknown], PAGE), /no rasterize callback was provided/);
  passed++;

  // Missing callback must escape node containment, not produce an error box.
  await assert.rejects(exportScene([FIELD_RECT], PAGE), isConfigurationError);

  for (const fill of ["#123456", { ...STORED, type: "solid" },
    { type: "linearGradient", linear: { angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] } },
    { type: "radialGradient", radial: { center: { x: 0.5, y: 0.5 }, r: 0.5, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] } },
  ]) {
    calls = [];
    await exportScene([rect({ ...BOX, fill })], { ...PAGE, rasterize });
    assert.equal(calls.length, 0, "supported active paint stays vector, even with remembered Multipoint state");
    passed++;
  }
}

assert.throws(() => paintRef(null, PARSED), /Multipoint paint has no native SVG representation/);
assert.throws(() => paintRef(null, CROSSFADE), /Multipoint paint has no native SVG representation/);
assert.throws(() => gradientDefSVG(PARSED, "mp"), /unsupported native SVG gradient type "multipointGradient"/);
assert.throws(() => gradientDefSVG({ type: "unknownGradient", stops: [] }, "unknown"), /unsupported native SVG gradient type "unknownGradient"/);
assert.throws(() => parsePaint({ type: "unknownPaint" }), /unknown paint type/);
console.log(`\n${passed} Multipoint export routing cases + 5 native/parser rejection checks passed (mock PNG; not SVG/PDF pixel parity).`);
