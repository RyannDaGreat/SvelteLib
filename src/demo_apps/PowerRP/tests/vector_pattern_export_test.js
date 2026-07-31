/**
 * vector_pattern_export_test.js — THE VECTOR-EXPORT GATE.
 *
 * The user's framing of this feature was "it's a SPECIAL material because it uses
 * VECTOR GRAPHICS to do it". That claim is only true if the PDF and SVG exporters
 * carry the pattern as real geometry — and the default behaviour of both exporters
 * for a material fill is the exact opposite: opHasMaterialFill sends the shape down
 * a RASTER-EMBED fallback, because a shader fill has no vector form. A pattern that
 * quietly took that path would look identical in a screenshot and be wrong in every
 * way that matters (fixed resolution, huge files, blurry when zoomed).
 *
 * So this test pins the thing that is easy to lose and impossible to see:
 *
 *   1. The ROUTING PREDICATE. opHasVectorMaterialFill separates the pattern from
 *      every shader material, and both exporters consult it before rasterizing.
 *   2. SVG emits a native <pattern> whose tile is <path> geometry, with the knobs
 *      on patternTransform — and NO <image> anywhere.
 *   3. PDF emits a PatternType 1 TILING pattern whose tile is path operators, and
 *      the shape is filled through /Pattern cs … scn — no embedded raster.
 *   4. THE OFF BACKGROUND survives into both exports as genuine transparency,
 *      rather than being flattened to white.
 *   5. ALL THREE BACKENDS AGREE about the cell, because all three call the same
 *      patternCellFor — checked by construction rather than by eye.
 *
 * Bare node, DOM-free: the exporters are pure string/byte work by design.
 */

import assert from "node:assert";
import { opHasMaterialFill, opHasVectorMaterialFill, VECTOR_FILL_MATERIAL_IDS, rect } from "../render_gpu/ir.js";
import { patternDefSVG, irToSVG } from "../render_gpu/svg_backend.js";
import { irToPDF } from "../render_gpu/pdf_backend.js";
import { patternCellFor, patternMatrix, shapeColor, PATTERN_PRESETS, PATTERN_MATERIAL, isPatternMaterial } from "../render_gpu/skia/pattern_material.js";
import { getMaterial, materialIds, fillCapableMaterialIds, isBackdropMaterial } from "../render_gpu/skia/materials.js";

/** A material paint carrying the given pattern params, in the shape ports.js
 *  produces after resolveMaterialFillPaints (resolvedParams complete). */
const patternPaint = (params) => ({
  type: "material", material: { id: "vector_pattern", params }, resolvedParams: params,
});

// ── 1. THE ROUTING PREDICATE ──────────────────────────────────────────────────
{
  const pattern = { op: "rect", fill: patternPaint({ generator: "stripes" }) };
  const shader = { op: "rect", fill: { type: "material", material: { id: "crt" } } };
  const solid = { op: "rect", fill: "#ffffff" };

  assert.ok(opHasMaterialFill(pattern), "a pattern fill is still a material fill (the general predicate must stay true)");
  assert.ok(opHasVectorMaterialFill(pattern), "a pattern fill must be recognized as VECTOR-exportable");
  assert.ok(opHasMaterialFill(shader) && !opHasVectorMaterialFill(shader),
    "a SHADER material must NOT be treated as vector-exportable — it has no vector form and must keep rasterizing");
  assert.ok(!opHasVectorMaterialFill(solid), "a solid fill is not a material fill at all");
  assert.deepStrictEqual([...VECTOR_FILL_MATERIAL_IDS], ["vector_pattern"],
    "the vector-exportable material set changed — every id in it must have a real <pattern>/tiling-pattern emitter in BOTH exporters");
}

// ── 2. THE MATERIAL IS REGISTERED AS ITS OWN KIND ─────────────────────────────
{
  assert.ok(materialIds().includes("vector_pattern"), "the pattern material must be in the ONE registry, so the Mat tab lists it");
  assert.ok(fillCapableMaterialIds().includes("vector_pattern"), "the pattern material must be fill-capable (it declares fillParams)");
  const material = getMaterial("vector_pattern");
  assert.ok(isPatternMaterial(material), "getMaterial must return the pattern-kind descriptor");
  assert.ok(!isBackdropMaterial(material),
    "a pattern must NOT be a backdrop material — it has no SkSL, so the backdrop path would try to compile nothing");
  assert.strictEqual(material.sksl, undefined, "a pattern material carries NO shader source — that is the point of the kind");
}

// ── 3. SVG EMITS A NATIVE <pattern> OF REAL PATHS ─────────────────────────────
{
  const svg = patternDefSVG(patternPaint({
    generator: "stripes", period: 10, ratio: 0.5, ink: "#000000", background: "#ffffff",
    scale: 1, offsetX: 0, offsetY: 0, rotation: 0,
  }), "pat1", 1);

  assert.ok(svg.startsWith('<pattern id="pat1"'), `SVG must emit a <pattern> def, got: ${svg.slice(0, 80)}`);
  assert.ok(svg.includes('patternUnits="userSpaceOnUse"'), "the tile must be in user space so its size IS the fundamental domain");
  assert.ok(svg.includes('width="10" height="10"'), `the tile must be exactly the cell (10x10), got: ${svg.slice(0, 140)}`);
  assert.ok(svg.includes("<path "), "the tile's content must be real <path> geometry");
  assert.ok(!svg.includes("<image"), "THE WHOLE POINT: an SVG pattern export must contain NO embedded raster");

  // The knobs must reach patternTransform, or scale/offset/rotation would silently
  // do nothing in an export while working in the editor.
  const moved = patternDefSVG(patternPaint({
    generator: "stripes", period: 10, ratio: 0.5, ink: "#000", background: "#fff",
    scale: 2, offsetX: 3, offsetY: 4, rotation: 0,
  }), "pat2", 1);
  assert.ok(moved.includes('patternTransform="matrix(2 0 0 2 3 4)"'),
    `scale/offset must ride patternTransform, got: ${moved.slice(0, 160)}`);
}

// ── 4. THE OFF BACKGROUND IS REAL TRANSPARENCY, NOT WHITE ─────────────────────
{
  const params = { generator: "polka_dots", period: 10, radius: 0.2, ink: "#ffffff", backgroundOff: true };
  const cell = patternCellFor(params);
  const background = cell.shapes.find((s) => s.paint === "background");
  assert.ok(background, "the cell still carries a background shape (the OFF-ness is resolved by the consumer, not the generator)");
  assert.strictEqual(shapeColor(background, params, () => [1, 1, 1, 1]), null,
    "an OFF background must resolve to null (draw nothing), never to an opaque colour");

  const svg = patternDefSVG(patternPaint(params), "pat3", 1);
  assert.ok(!svg.includes("M0 0H10V10H0Z"),
    "an OFF background must emit NO background rect in the SVG export — flattening it to white would destroy the overlay");
  assert.ok(svg.includes("<path "), "the ink is still exported");
}

// ── 5. EVERY SHIPPED PRESET BUILDS A VALID CELL AND EXPORTS ───────────────────
// A preset naming a knob its generator does not have, or a colour that will not
// parse, would surface as a broken swatch in the picker rather than as an error.
{
  const knobNames = new Set(PATTERN_MATERIAL.fillParams.map((row) => row.name));
  for (const preset of PATTERN_PRESETS) {
    for (const knob of Object.keys(preset.params))
      assert.ok(knobNames.has(knob),
        `preset "${preset.id}" sets "${knob}", which is not a knob in the pattern material's schema (${[...knobNames].join(", ")})`);

    const cell = patternCellFor(preset.params);
    assert.ok(cell.w > 0 && cell.h > 0, `preset "${preset.id}" produced a degenerate cell (${cell.w}x${cell.h})`);
    assert.ok(cell.shapes.length > 0, `preset "${preset.id}" produced an EMPTY cell — it would render as nothing`);

    // It must survive the SVG exporter too, with real geometry.
    const svg = patternDefSVG(patternPaint(preset.params), `p_${preset.id}`, 1);
    assert.ok(svg.includes("<path "), `preset "${preset.id}" exported an SVG pattern with no path geometry`);
    assert.ok(!svg.includes("NaN"), `preset "${preset.id}" exported NaN into its SVG — a knob resolved to a non-finite number`);
  }
  assert.ok(PATTERN_PRESETS.length >= 12,
    `the shipped roster is ${PATTERN_PRESETS.length} presets — the brief asked for 12-15 spanning the reference imagery`);
}

// ── 6. THE TRANSFORM MATRIX IS THE SAME MATH FOR ALL THREE BACKENDS ───────────
// Each backend consumes patternMatrix directly, so agreement is structural. These
// pin the convention itself (a sign flip here would rotate the SVG the other way
// from the canvas, which is exactly the kind of drift that goes unnoticed).
{
  assert.deepStrictEqual(patternMatrix({ scale: 1, offsetX: 0, offsetY: 0, rotation: 0 }), [1, 0, 0, 1, 0, 0], "identity knobs must give the identity matrix");
  assert.deepStrictEqual(patternMatrix({ scale: 3, offsetX: 0, offsetY: 0, rotation: 0 }), [3, 0, 0, 3, 0, 0], "scale must be uniform on both axes");
  assert.deepStrictEqual(patternMatrix({ scale: 1, offsetX: 5, offsetY: -2, rotation: 0 }), [1, 0, 0, 1, 5, -2], "offsets must land in the translation slots");
  const rotated = patternMatrix({ scale: 1, offsetX: 0, offsetY: 0, rotation: 90 });
  assert.ok(Math.abs(rotated[0]) < 1e-9 && Math.abs(rotated[1] - 1) < 1e-9,
    `a 90° rotation must map x→y (got [${rotated.map((v) => v.toFixed(3)).join(", ")}])`);
  for (const bad of [{ scale: NaN }, { offsetX: Infinity }, { rotation: NaN }])
    assert.throws(() => patternMatrix(bad), /must be finite/,
      `a non-finite knob (${JSON.stringify(bad)}) must be refused LOUDLY, never packed into a silent no-op matrix`);
}

// ── 7. THE REAL EXPORTERS, END TO END, WITH RASTERIZING FORBIDDEN ─────────────
// The strongest form of the claim. Both exporters run for real on a pattern-filled
// rect, with a `rasterize` callback that THROWS: if either backend were to take the
// material raster fallback, this test fails loudly instead of quietly producing a
// correct-looking-but-raster export. That callback is the assertion.
{
  const params = { generator: "stripes", period: 10, ratio: 0.5, ink: "#000000", background: "#ffffff", scale: 1, offsetX: 0, offsetY: 0, rotation: 0 };
  const commands = [rect({ x: -100, y: -80, w: 200, h: 160, fill: { type: "material", material: { id: "vector_pattern", params }, resolvedParams: params } })];
  // COUNTING the rasterize calls, rather than throwing from the seam: svg_backend
  // deliberately never lets a raster failure escape (its "never throws" contract
  // turns one into a reported degradation), so a throw here would be swallowed and
  // the test would pass for the wrong reason. The call COUNT is the honest signal.
  let rasterCalls = 0;
  const page = {
    width: 400, height: 300, view: { zoom: 1, panX: 200, panY: 150, dpr: 1 }, background: "#ffffff",
    rasterize: async () => { rasterCalls++; return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); },
  };

  const pdf = await irToPDF(commands, page);
  assert.strictEqual(rasterCalls, 0, "the PDF exporter rasterized a pattern fill — it must stay vector");
  const pdfText = Buffer.from(pdf).toString("latin1");
  assert.ok(pdfText.includes("PatternType"), "the PDF must contain a tiling-pattern object (PatternType 1)");
  assert.ok(pdfText.includes("/Pattern cs"), "the shape must be filled through the /Pattern colour space");
  assert.ok(!pdfText.includes("/Subtype /Image"), "THE WHOLE POINT: the PDF must embed no raster for a pattern fill");

  const svg = await irToSVG(commands, page);
  assert.strictEqual(rasterCalls, 0, "the SVG exporter rasterized a pattern fill — it must stay vector");
  assert.ok(svg.includes("<pattern"), "the SVG must contain a native <pattern> def");
  assert.ok(!svg.includes("<image"), "THE WHOLE POINT: the SVG must embed no raster for a pattern fill");

  // A SHADER material on the same geometry must STILL rasterize. This is the other
  // half of the guarantee: the vector bypass must be narrow, not a hole that lets
  // every material skip a fallback it genuinely needs.
  const shaderCommands = [rect({ x: -100, y: -80, w: 200, h: 160, fill: { type: "material", material: { id: "crt", params: {} }, resolvedParams: {} } })];
  await irToSVG(shaderCommands, page);
  assert.strictEqual(rasterCalls, 1,
    `a SHADER material must still take the raster path (rasterize calls: ${rasterCalls}) — the vector bypass must not have widened to every material`);
}

console.log(`vector_pattern_export_test: OK — pattern routes around the raster fallback, PDF emits a tiling pattern and SVG a <pattern> (both raster-free, verified by counting rasterize calls; a shader material still rasterizes), ${PATTERN_PRESETS.length} presets export cleanly, OFF background stays transparent`);
