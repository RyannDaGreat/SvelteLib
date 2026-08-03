/**
 * THE CROSS-BACKEND EFFECT-EXPORT GUARD — plain node, no framework
 * (core_test.js / effects_test.js style).
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/effects_export_guard_test.js
 *
 * ── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ────────────────────────────────────
 * pdf_backend.emitEffect used to choose its vector-preserving branch with an
 * inline `!cmd.bloom && cmd.blend === "normal"`. That boolean never mentioned
 * `innerShadow` or `softEdges`, so an effectSubtree carrying ONLY one of those
 * took the vector path: the effect was never rasterized, never drawn, and never
 * reported — a soft-edged widget exported CRISP and an inner shadow VANISHED from
 * every PDF, while SVG (which rasters unconditionally) rendered both. Measured
 * before the fix: the soft-edges and inner-shadow PDFs were BYTE-IDENTICAL to the
 * no-effect PDF (1888 bytes each).
 *
 * A silently-dropped effect is the worst class of export bug: the user gets a
 * wrong file with no warning. So this suite pins the STRUCTURE that prevents it
 * rather than any one effect:
 *
 *   1. EXHAUSTIVENESS — every field an all-effects-on effectSubtree carries is
 *      classified in pdf_backend as vector-safe, raster-only, or structural. A
 *      SIXTH effect added to ir.js and forgotten fails here (and at import).
 *   2. ONE GATE — vectorSafeEffects is the single predicate; each raster-only
 *      field, alone, flips it false.
 *   3. BOTH BACKENDS CONSULT IT — each raster-only effect, alone, actually
 *      produces a raster region in the PDF *and* in the SVG. This is the "an
 *      effect field exists on the op but no backend consults it" test.
 *   4. NO OVER-RASTERIZATION — a vector-safe (shadow-only) effect still keeps its
 *      content vector in the PDF, so the fix cannot be faked by rasterizing
 *      everything.
 *   5. NO SILENT STRIP — droppedRasterOnlyEffects catches an effect lost while a
 *      backend re-spreads the op for its rasterizer.
 */

import assert from "node:assert/strict";
import { effectSubtree, rect, text, pushTransform, popTransform } from "../ir.js";
import {
  vectorSafeEffects, droppedRasterOnlyEffects, allEffectsProbeOp,
  VECTOR_SAFE_EFFECT_FIELDS, RASTER_ONLY_EFFECT_FIELDS, irToPDF,
} from "../pdf_backend.js";
import { irToSVG } from "../svg_backend.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
async function atest(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const PAGE = { width: 200, height: 150, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff" };
const BOX = { x: 40, y: 30, w: 100, h: 70 };

// The 1x1 stub PNG every exporter suite uses (verbatim from pdf_backend_test.js /
// effects_test.js — the structural assertions ask WHETHER a raster region was
// emitted and with WHICH commands, never what the pixels are).
const STUB_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let rasterCalls = [];
/** Command (records the call). The injected raster hook both backends share. */
async function rasterize(ir, view, w, h, background) {
  rasterCalls.push({ ir, view, w, h, background });
  return STUB_PNG;
}

/** Query→build. One effected widget (rect + text content) carrying `fields`. */
function effectedScene(fields) {
  const content = [rect({ ...BOX, fill: "#ffd166" }), text({ text: "FX", x: BOX.x + 8, y: BOX.y + 8, size: 20, color: "#101018" })];
  return [effectSubtree({
    ...BOX, ...fields,
    content: [pushTransform(IDENTITY), ...content, popTransform()],
  })];
}

/** Pure function. A live value for one effect field — what "this effect is on" means.
 * @example liveEffectValue("softEdges") // 6
 * @example liveEffectValue("bloom") // {radius: 5, strength: 1}
 * @example liveEffectValue("blur") // 5 (the op field is `blur`; the ITEM-STATE key is `gaussianBlur`)
 */
function liveEffectValue(field) {
  switch (field) {
    case "shadow": return { dx: 3, dy: 3, blur: 4, color: "#000000", opacity: 0.6 };
    case "innerShadow": return { dx: 3, dy: 3, blur: 4, color: "#000000", opacity: 0.6 };
    case "bloom": return { radius: 5, strength: 1 };
    case "softEdges": return 6;
    // The effects bundle's sixth effect. A plain scalar sigma, like softEdges;
    // note this is the IR OP's field name — the item-state key it comes from is
    // `gaussianBlur`, because `blur` was already a plugins/blur.js property
    // (render_gpu/effects.js EFFECT_STATE_KEYS records the split).
    case "blur": return 5;
    default: throw new Error(`effects_export_guard: no live value defined for effect field "${field}" — add one when classifying a new effect`);
  }
}

// ── 1. EXHAUSTIVENESS ────────────────────────────────────────────────────────

test("EXHAUSTIVE: every effectSubtree field is classified (a new effect fails here)", () => {
  const probe = allEffectsProbeOp();
  // Structural keys are the ones a backend reads for geometry/plumbing, not as an
  // effect. Kept literal here so this test and pdf_backend must AGREE — if the op
  // grows a key that is neither, one of the two lists is out of date.
  const structural = ["op", "x", "y", "w", "h", "content", "margin", "shadowOnly", "blend"];
  const classified = new Set([...VECTOR_SAFE_EFFECT_FIELDS, ...RASTER_ONLY_EFFECT_FIELDS, ...structural]);
  const unclassified = Object.keys(probe).filter((k) => !classified.has(k));
  assert.deepEqual(unclassified, [], `effectSubtree carries unclassified field(s) ${JSON.stringify(unclassified)} — classify each in pdf_backend (VECTOR_SAFE_EFFECT_FIELDS / RASTER_ONLY_EFFECT_FIELDS) or an effect will export as NOTHING`);
  // Every classified effect field must actually EXIST on the op — a stale name in
  // either list is a gate that silently tests nothing.
  for (const field of [...VECTOR_SAFE_EFFECT_FIELDS, ...RASTER_ONLY_EFFECT_FIELDS])
    assert.ok(field in probe, `"${field}" is classified but absent from effectSubtree — remove the stale entry`);
  // And every classified field must be LIVE on the all-on probe, or the probe is
  // not really "all effects on" and the guard would pass vacuously.
  for (const field of [...VECTOR_SAFE_EFFECT_FIELDS, ...RASTER_ONLY_EFFECT_FIELDS])
    assert.ok(probe[field], `allEffectsProbeOp() leaves "${field}" off — the exhaustiveness guard would not see it`);
});

test("EXHAUSTIVE: the two effect lists are disjoint (a field cannot be both)", () => {
  const both = VECTOR_SAFE_EFFECT_FIELDS.filter((f) => RASTER_ONLY_EFFECT_FIELDS.includes(f));
  assert.deepEqual(both, []);
});

// ── 2. ONE GATE ──────────────────────────────────────────────────────────────

test("GATE: each raster-only effect ALONE makes vectorSafeEffects false", () => {
  for (const field of RASTER_ONLY_EFFECT_FIELDS) {
    const op = effectSubtree({ ...BOX, content: [], [field]: liveEffectValue(field) });
    assert.equal(vectorSafeEffects(op), false, `vectorSafeEffects must be false for a live "${field}" — it has no vector form, so the vector path would DROP it`);
  }
});

test("GATE: a vector-safe effect alone stays vector-safe; a non-normal blend does not", () => {
  for (const field of VECTOR_SAFE_EFFECT_FIELDS) {
    const op = effectSubtree({ ...BOX, content: [], [field]: liveEffectValue(field) });
    assert.equal(vectorSafeEffects(op), true, `"${field}" is classified vector-safe but the gate rasterizes it`);
  }
  for (const blend of ["multiply", "screen"])
    assert.equal(vectorSafeEffects(effectSubtree({ ...BOX, content: [], blend })), false);
});

// ── 3. BOTH BACKENDS CONSULT IT (the anti-silent-drop core) ──────────────────

await atest("PDF: each raster-only effect ALONE emits a raster region (never silently dropped)", async () => {
  for (const field of RASTER_ONLY_EFFECT_FIELDS) {
    rasterCalls = [];
    const bytes = await irToPDF(effectedScene({ [field]: liveEffectValue(field) }), { ...PAGE, rasterize });
    assert.ok(rasterCalls.length >= 1, `a live "${field}" produced NO raster region in the PDF — the effect exports as nothing`);
    // The rasterized op must still carry the effect (not a stripped copy).
    const carried = rasterCalls.some(({ ir }) => ir.some((c) => c.op === "effectSubtree" && c[field]));
    assert.ok(carried, `the PDF rasterized something for "${field}" but the op handed to the rasterizer no longer carries it`);
    assert.ok(bytes.length > 0);
  }
});

await atest("SVG: each raster-only effect ALONE emits a raster <image> (never silently dropped)", async () => {
  for (const field of RASTER_ONLY_EFFECT_FIELDS) {
    rasterCalls = [];
    const svg = await irToSVG(effectedScene({ [field]: liveEffectValue(field) }), { ...PAGE, rasterize });
    assert.ok(rasterCalls.length >= 1, `a live "${field}" produced NO raster region in the SVG — the effect exports as nothing`);
    assert.match(svg, /<image/, `SVG for "${field}" has no <image> raster region`);
    const carried = rasterCalls.some(({ ir }) => ir.some((c) => c.op === "effectSubtree" && c[field]));
    assert.ok(carried, `the SVG rasterized something for "${field}" but the op handed to the rasterizer no longer carries it`);
  }
});

await atest("BOTH: a scene with NO rasterize hook THROWS for every raster-only effect (loud, never silent)", async () => {
  for (const field of RASTER_ONLY_EFFECT_FIELDS) {
    const scene = effectedScene({ [field]: liveEffectValue(field) });
    await assert.rejects(() => irToPDF(scene, PAGE), /raster region/, `PDF must demand a rasterizer for "${field}" instead of exporting it blank`);
    await assert.rejects(() => irToSVG(scene, PAGE), /raster/, `SVG must demand a rasterizer for "${field}" instead of exporting it blank`);
  }
});

// ── 4. NO OVER-RASTERIZATION ─────────────────────────────────────────────────

await atest("PDF: a shadow-only effect keeps its content VECTOR (exactly one raster: the shadow)", async () => {
  rasterCalls = [];
  const bytes = await irToPDF(effectedScene({ shadow: liveEffectValue("shadow") }), { ...PAGE, rasterize });
  assert.equal(rasterCalls.length, 1, "a shadow-only effect must raster ONLY the shadow, never the widget");
  assert.ok(rasterCalls[0].ir.some((c) => c.op === "effectSubtree" && c.shadowOnly === true), "the single raster must be the shadowOnly re-issue");
  // The widget's own text survives as real PDF text operators (Tj/TJ), not pixels.
  const stream = Buffer.from(bytes).toString("latin1");
  assert.match(stream, /\bT[jJ]\b/, "shadow-only effected text must stay selectable PDF text");
});

await atest("PDF: adding a raster-only effect to a shadow does NOT lose the shadow raster", async () => {
  rasterCalls = [];
  await irToPDF(effectedScene({ shadow: liveEffectValue("shadow"), softEdges: liveEffectValue("softEdges") }), { ...PAGE, rasterize });
  // Two rasters: the shadow PNG, then the widget region carrying the feather.
  assert.equal(rasterCalls.length, 2);
  assert.ok(rasterCalls[0].ir.some((c) => c.op === "effectSubtree" && c.shadowOnly === true));
  const widget = rasterCalls[1].ir.find((c) => c.op === "effectSubtree");
  assert.equal(widget.shadow, null, "the widget raster must drop the shadow (already emitted) so it is not doubled");
  assert.equal(widget.softEdges, liveEffectValue("softEdges"), "the widget raster must KEEP softEdges — the shadow silhouettes the feathered widget");
});

// ── 5. NO SILENT STRIP ───────────────────────────────────────────────────────

test("STRIP: droppedRasterOnlyEffects reports a raster-only effect lost in a re-spread", () => {
  for (const field of RASTER_ONLY_EFFECT_FIELDS) {
    const original = { ...Object.fromEntries(RASTER_ONLY_EFFECT_FIELDS.map((f) => [f, liveEffectValue(f)])) };
    const forwarded = { ...original, [field]: field === "softEdges" ? 0 : null };
    assert.deepEqual(droppedRasterOnlyEffects(original, forwarded), [field]);
  }
  const all = Object.fromEntries(RASTER_ONLY_EFFECT_FIELDS.map((f) => [f, liveEffectValue(f)]));
  assert.deepEqual(droppedRasterOnlyEffects(all, all), []);
});

test("STRIP: dropping a VECTOR-SAFE effect is legitimate (the shadow-PNG convention)", () => {
  const original = { shadow: liveEffectValue("shadow"), softEdges: 6 };
  assert.deepEqual(droppedRasterOnlyEffects(original, { shadow: null, softEdges: 6 }), []);
});

console.log(`\n${passed} effect-export guard checks passed`);
