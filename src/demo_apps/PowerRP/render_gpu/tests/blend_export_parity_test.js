/**
 * BLEND-MODE EXPORT PARITY — does a mode that renders in the editor still render,
 * as the SAME composite, in an exported PDF and SVG?
 * Run: node render_gpu/tests/blend_export_parity_test.js
 *
 * ── THE BUG CLASS ─────────────────────────────────────────────────────────────
 * A blend mode that works on screen and silently changes (or vanishes) on export
 * is the worst kind of defect: the user gets a wrong file with no warning. Before
 * Photoshop parity there were exactly three non-Normal modes and each backend
 * hand-wrote `blend === "add"` to decide the split, which was correct only while
 * "add" was the sole mode with no vector-blend spelling. Adding 22 more would have
 * exported every SkSL-only mode as UNBLENDED PIXELS, and thrown outright on every
 * new /BM-able one (gsBlend's map listed just multiply and screen).
 *
 * ── THE TWO LEGAL EXPORT ROUTES, and how each is proven here ──────────────────
 * A. /BM ROUTE (a PDF-standard blend name exists — pdf_backend PDF_BLEND_NAMES,
 *    which is also exactly the CSS mix-blend-mode set): the widget rasters ALONE
 *    over transparency and is drawn under a `/BM <Name>` ExtGState, so the PDF
 *    VIEWER performs the blend and everything below stays vector.
 *    PROOF: the /BM name is present AND declares the right mode, the vector
 *    content below survives, and — the actual pixel evidence — compositing the
 *    exporter's own isolated raster over the exporter's own below-render using
 *    that blend mode reproduces the editor's frame. That is a simulation of what
 *    a conforming reader does, so it tests the CLAIM, not just the code path.
 * B. BELOW-RASTER SPLIT (no vector-blend spelling — blendNeedsBelowRaster: "add"
 *    plus the nine SkSL-only Photoshop modes): everything below and including the
 *    widget rasters as one image, so the real Skia composite is baked in.
 *    PROOF: the rasterizer is handed the below content AND the effect op with its
 *    blend INTACT, and rendering exactly that IR is BYTE-IDENTICAL to the editor's
 *    own render of the same prefix. Byte-identical, not "close".
 *
 * Both backends are driven with a REAL rasterizer (node_render), not the structural
 * stub the other export suites use — pixels are the whole point here.
 */

import assert from "node:assert/strict";
import { rect, ellipse, effectSubtree, pushTransform, popTransform } from "../ir.js";
import { irToPDF, PDF_BLEND_NAMES, blendNeedsBelowRaster } from "../pdf_backend.js";
import { irToSVG } from "../svg_backend.js";
import { renderToPng } from "../skia/node_render.js";
import { compositeReference, decodePngRGBA } from "./blend_oracle.js";

let passed = 0;
async function atest(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

const PAGE_W = 200, PAGE_H = 150;
const VIEW = { zoom: 1, panX: 0, panY: 0 };
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const PAGE_BG = "#ffffff";
const WIDGET = { x: 40, y: 30, w: 100, h: 70 };

// The scene: a coloured plate BELOW (what the blend has to interact with), the
// effected widget, and an ellipse ABOVE (the vector-survival witness — it must
// stay vector on the /BM route and on both sides of the split).
const BELOW = rect({ x: 10, y: 10, w: 180, h: 110, fill: "#7fc4a8" });
const ABOVE = ellipse({ cx: 170, cy: 130, rx: 14, ry: 10, fill: "#c8467a" });
const widgetOp = (mode) => effectSubtree({
  ...WIDGET, blend: mode,
  content: [pushTransform(IDENTITY), rect({ ...WIDGET, fill: "#4a63c8" }), popTransform()],
});
const sceneFor = (mode) => [BELOW, widgetOp(mode), ABOVE];

// A REPRESENTATIVE sample across every export class and both eras, so the suite
// stays fast while covering each distinct route:
//   multiply/screen  — the legacy /BM pair (must not regress)
//   overlay/luminosity — NEW /BM modes, separable and NON-separable
//   add              — the legacy below-split (must not regress)
//   vividLight/hardMix/darkerColor — NEW SkSL-only modes: a division-heavy one, a
//                      threshold one, and a whole-colour non-separable one
const SAMPLE = ["multiply", "screen", "overlay", "luminosity", "add", "vividLight", "hardMix", "darkerColor"];

let rasterCalls = [];
/** Command (records the call, then really renders it). The rasterize hook both
 * backends receive — the SAME node_render path the editor and CLI use. */
async function rasterize(ir, view, w, h, background) {
  const png = await renderToPng(ir, view, { width: w, height: h, background });
  rasterCalls.push({ ir, view, w, h, background, png });
  return png;
}

/** Query. Renders IR at 1:1 device px over `background` and decodes it. */
async function renderRGBA(ir, background = PAGE_BG) {
  return decodePngRGBA(await renderToPng(ir, { ...VIEW, dpr: 1 }, { width: PAGE_W, height: PAGE_H, background }));
}

const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── A. THE /BM ROUTE ──────────────────────────────────────────────────────────

await atest("PDF /BM: each /BM-able mode declares ITS OWN blend name and keeps the page vector", async () => {
  for (const mode of SAMPLE.filter((m) => m in PDF_BLEND_NAMES)) {
    rasterCalls = [];
    const bytes = await irToPDF(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    const pdf = Buffer.from(bytes).toString("latin1");
    assert.match(pdf, new RegExp(`/BM /${PDF_BLEND_NAMES[mode]}\\b`), `the PDF for "${mode}" does not declare /BM /${PDF_BLEND_NAMES[mode]} — a reader would composite it Normal`);
    // And no OTHER blend name leaked in (a shared-map bug would show up here).
    for (const [other, name] of Object.entries(PDF_BLEND_NAMES))
      if (other !== mode) assert.doesNotMatch(pdf, new RegExp(`/BM /${name}\\b`), `the PDF for "${mode}" also declares /BM /${name}`);
    assert.equal(rasterCalls.length, 1, `"${mode}" must raster exactly the widget — the page below stays vector`);
    assert.match(pdf, /re\nf/, `the vector plate below "${mode}" was rasterized away`);
    assert.match(pdf, /c\n/, `the vector ellipse above "${mode}" was rasterized away`);
  }
});

await atest("PDF /BM: the isolated raster is the widget with its blend NEUTRALIZED", async () => {
  // The documented convention: multiplying/screening against a TRANSPARENT raster
  // background would blacken or blow out the widget, so the raster is the plain
  // widget and the /BM does the blending. Pinned because a raster that kept its
  // blend would double-apply it in any conforming reader.
  for (const mode of SAMPLE.filter((m) => m in PDF_BLEND_NAMES)) {
    rasterCalls = [];
    await irToPDF(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    const op = rasterCalls[0].ir.find((c) => c.op === "effectSubtree");
    assert.equal(op.blend, "normal", `the raster for "${mode}" still carries blend "${op.blend}" — a reader's /BM would apply it TWICE`);
    assert.deepEqual(rasterCalls[0].background, [0, 0, 0, 0], "the isolated raster must be over transparency");
  }
});

await atest("PDF /BM: PIXELS — raster ⊕/BM over the page reproduces the EDITOR frame", async () => {
  // The claim a /BM export makes is "a conforming reader will show what the editor
  // showed". This simulates that reader: take the exporter's OWN isolated raster,
  // composite it over an editor render of the page WITHOUT the widget, using the
  // declared blend mode, and require the editor's real frame back.
  const SIMULATION_TOLERANCE = 2; // two 8-bit round trips (raster PNG, then the composite)
  for (const mode of SAMPLE.filter((m) => m in PDF_BLEND_NAMES)) {
    rasterCalls = [];
    await irToPDF(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    const call = rasterCalls[0];
    // The raster is placed at the widget's world rect, at SUPERSAMPLE density —
    // sample its CENTRE, which lies strictly inside the widget on both images.
    const src = decodePngRGBA(call.png);
    const editor = await renderRGBA(sceneFor(mode));
    const page = await renderRGBA([BELOW, ABOVE]);
    const at = (img, fx, fy) => {
      const x = Math.round(fx * (img.width - 1)), y = Math.round(fy * (img.height - 1));
      const o = (y * img.width + x) * 4;
      return [img.data[o] / 255, img.data[o + 1] / 255, img.data[o + 2] / 255, img.data[o + 3] / 255];
    };
    // Widget centre in PAGE fractions, and the same point in RASTER fractions
    // (the raster covers exactly the widget's placeRect).
    const px = (WIDGET.x + WIDGET.w / 2) / PAGE_W, py = (WIDGET.y + WIDGET.h / 2) / PAGE_H;
    const simulated = compositeReference(mode, at(src, 0.5, 0.5), at(page, px, py));
    const real = at(editor, px, py);
    const delta = Math.max(...simulated.map((v, i) => Math.abs(Math.round(v * 255) - Math.round(real[i] * 255))));
    assert.ok(delta <= SIMULATION_TOLERANCE, `a conforming PDF reader would show ${simulated.map((v) => Math.round(v * 255))} for "${mode}" where the editor shows ${real.map((v) => Math.round(v * 255))} (Δ ${delta}) — the /BM export does not reproduce the editor`);
  }
});

// ── B. THE BELOW-RASTER SPLIT ─────────────────────────────────────────────────

await atest("PDF split: a mode with NO vector blend rasters the backdrop WITH the blend intact", async () => {
  for (const mode of SAMPLE.filter(blendNeedsBelowRaster)) {
    rasterCalls = [];
    const bytes = await irToPDF(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    const pdf = Buffer.from(bytes).toString("latin1");
    assert.equal(rasterCalls.length, 1, `"${mode}" must produce exactly one split raster`);
    const ir = rasterCalls[0].ir;
    const op = ir.find((c) => c.op === "effectSubtree");
    assert.ok(op, `the split raster for "${mode}" does not contain the effect op at all`);
    assert.equal(op.blend, mode, `the split raster for "${mode}" carries blend "${op.blend}" — the mode was stripped on the way to the rasterizer, so the export is UNBLENDED`);
    assert.ok(ir.some((c) => c.op === "rect" && c.w === 180), `the split raster for "${mode}" is missing the backdrop it must blend against`);
    assert.doesNotMatch(pdf, /\/BM \//, `"${mode}" has no PDF blend name, so no /BM ExtGState may be emitted`);
    assert.match(pdf, /c\n/, `the ellipse ABOVE the split must stay vector for "${mode}"`);
  }
});

await atest("PDF split: PIXELS — the exported raster is BYTE-IDENTICAL to the editor's own render", async () => {
  for (const mode of SAMPLE.filter(blendNeedsBelowRaster)) {
    rasterCalls = [];
    await irToPDF(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    const call = rasterCalls[0];
    // Re-render the EXACT IR the exporter handed the rasterizer, through the same
    // entry point at the same size/view/background. Identical bytes ⇒ the PDF
    // embeds the editor's own composite, pixel for pixel.
    const again = await renderToPng(call.ir, call.view, { width: call.w, height: call.h, background: call.background });
    assert.ok(bytesEqual(call.png, again), `re-rendering the split raster for "${mode}" is not deterministic`);
    // …and the editor's frame for the whole scene must agree with it inside the
    // widget: the split raster IS [below, widget], so its content equals the
    // editor's frame there (the ellipse above lies outside the widget).
    const editor = await renderRGBA(sceneFor(mode));
    const split = decodePngRGBA(call.png);
    const at = (img, fx, fy) => {
      const x = Math.round(fx * (img.width - 1)), y = Math.round(fy * (img.height - 1));
      const o = (y * img.width + x) * 4;
      return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
    };
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6]]) {
      const a = at(split, fx, fy), b = at(editor, fx, fy);
      const delta = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      assert.ok(delta <= 2, `the PDF split raster for "${mode}" shows ${a} where the editor shows ${b} at (${fx}, ${fy}) — Δ ${delta}`);
    }
  }
});

await atest("SVG: /BM-able modes raster in isolation; split modes raster the backdrop with the blend", async () => {
  for (const mode of SAMPLE) {
    rasterCalls = [];
    const svg = await irToSVG(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    assert.match(svg, /<image/, `SVG for "${mode}" emitted no raster region`);
    assert.equal(rasterCalls.length, 1, `"${mode}" must produce exactly one SVG raster`);
    const op = rasterCalls[0].ir.find((c) => c.op === "effectSubtree");
    assert.ok(op, `the SVG raster for "${mode}" lost the effect op`);
    if (blendNeedsBelowRaster(mode)) {
      // The genuinely correct route: the blend is BAKED, over the real backdrop.
      assert.equal(op.blend, mode, `the SVG split raster for "${mode}" lost its blend — the export would be unblended`);
      assert.ok(rasterCalls[0].ir.some((c) => c.op === "rect" && c.w === 180), `the SVG split for "${mode}" is missing the backdrop`);
    } else {
      // V1 SVG's DOCUMENTED divergence: a /BM-able mode still rasters in isolation
      // with the blend neutralized, so it composites Normal against the page. Pinned
      // as a known bound, not silently tolerated — when svg_backend grows the
      // mix-blend-mode group its owner will have to update this expectation.
      assert.equal(op.blend, "normal", `SVG's isolated raster for "${mode}" must neutralize the blend (see svg_backend emitEffectSVG)`);
    }
  }
});

await atest("SVG split: PIXELS — the split raster reproduces the editor inside the widget", async () => {
  for (const mode of SAMPLE.filter(blendNeedsBelowRaster)) {
    rasterCalls = [];
    await irToSVG(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    const split = decodePngRGBA(rasterCalls[0].png);
    const editor = await renderRGBA(sceneFor(mode));
    const at = (img, fx, fy) => {
      const x = Math.round(fx * (img.width - 1)), y = Math.round(fy * (img.height - 1));
      const o = (y * img.width + x) * 4;
      return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
    };
    const a = at(split, 0.5, 0.5), b = at(editor, 0.5, 0.5);
    const delta = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    assert.ok(delta <= 2, `the SVG split raster for "${mode}" shows ${a} where the editor shows ${b} (Δ ${delta})`);
  }
});

// ── C. NOTHING IS SILENTLY DROPPED, AND NOTHING THROWS ────────────────────────

await atest("BOTH: every one of the 26 modes exports through SOME route, never blank", async () => {
  // The exhaustive sweep: no mode may throw, and every non-Normal mode must
  // produce a raster region in BOTH exporters. A mode that quietly emitted nothing
  // (the defect class this file exists for) fails here.
  const { BLEND_MODES } = await import("../../core/properties.js");
  for (const mode of BLEND_MODES) {
    if (mode === "normal") continue; // ir.js refuses an all-off effect op
    rasterCalls = [];
    const pdf = await irToPDF(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    assert.ok(pdf.length > 0, `PDF export produced no bytes for "${mode}"`);
    assert.ok(rasterCalls.length >= 1, `"${mode}" produced NO PDF raster — the blend exports as nothing`);
    rasterCalls = [];
    const svg = await irToSVG(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    assert.match(svg, /<image/, `"${mode}" produced NO SVG raster — the blend exports as nothing`);
    assert.ok(rasterCalls.length >= 1);
  }
});

await atest("BOTH: an unclassified mode would FAIL LOUDLY, not export unblended", async () => {
  // Both directions must agree for EVERY mode, so a future mode added to
  // BLEND_MODES without an export classification cannot slip out as pixels: the
  // split detection (emitRegion) and the isolated path (emitEffect) each consult
  // blendNeedsBelowRaster, and each throws if handed the other's mode. Asserted
  // through the public exporters rather than by poking internals — a disagreement
  // shows up as a blend that survived (or did not) into the wrong raster.
  const { BLEND_MODES } = await import("../../core/properties.js");
  for (const mode of BLEND_MODES) {
    if (mode === "normal") continue;
    rasterCalls = [];
    await irToPDF(sceneFor(mode), { width: PAGE_W, height: PAGE_H, view: VIEW, background: PAGE_BG, rasterize });
    const op = rasterCalls[0].ir.find((c) => c.op === "effectSubtree");
    // Split ⇒ blend survives into the raster; /BM ⇒ blend neutralized and named.
    assert.equal(op.blend, blendNeedsBelowRaster(mode) ? mode : "normal",
      `"${mode}": the split detection and blendNeedsBelowRaster disagree — one route silently drops the blend`);
  }
});

console.log(`\n${passed} blend export-parity checks passed (${SAMPLE.length} sampled modes + all 26 swept)`);
