/**
 * PDF-as-vector (PDF P1) headless tests — plain node, no framework
 * (core_test.js style). Run FROM THE POWERRP DIR:
 *   node render_gpu/tests/pdf_vector_test.js
 *
 * Covers:
 *   1. PURE mapper helpers (render_gpu/pdf_vector.js) — matrix/decode/gray/gState
 *      doctests, bare node (no pdf.js).
 *   2. OP-STREAM SNAPSHOT — asserts the pinned PDF_OP / DRAW_OP constants AND the
 *      constructPath arg layout match the LIVE pdfjs-dist. A pdf.js bump that
 *      reshapes the operator list FAILS THIS LOUDLY rather than silently dropping
 *      geometry (the feature's single biggest maintenance liability — house rule).
 *   3. INGEST — the committed fixture's vector page (no text) classifies
 *      vector-safe and maps to `path` IR ops (NOT the raster image op), and those
 *      ops export as native `<path>` via svg_backend. The text page classifies
 *      UNSAFE (rasters) — proving P1 never ships a page with missing text.
 *   4. CLASSIFIER hard-set — synthetic op lists for image / shading / CMYK / clip /
 *      blend / soft-mask / alpha each fall back with a reason.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PDF_OP, DRAW_OP, MAX_VECTOR_OP_COUNT,
  matMul, matrixMeanScale, pageToBoxMatrix, grayToHex, drawOpsToPathD,
  gStateFallbackReason, unsafeOpReason, classifyPdfPage, pdfPageVectorIR,
} from "../pdf_vector.js";
import { vectorCommandToSVG } from "../svg_backend.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/pdf_vector_fixture.pdf");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
async function atest(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

// ── 1. PURE mapper helpers ─────────────────────────────────────────────────────
test("matMul: identity ∘ M = M", () => assert.deepEqual(matMul([1, 0, 0, 1, 0, 0], [2, 0, 0, 2, 5, 6]), [2, 0, 0, 2, 5, 6]));
test("matMul: y-flip after translate", () => assert.deepEqual(matMul([1, 0, 0, -1, 0, 240], [1, 0, 0, 1, 20, 20]), [1, 0, 0, -1, 20, 220]));
test("matrixMeanScale: uniform 2× → 2, y-flip → 1", () => {
  assert.equal(matrixMeanScale([2, 0, 0, 2, 0, 0]), 2);
  assert.equal(matrixMeanScale([1, 0, 0, -1, 0, 240]), 1);
});
test("pageToBoxMatrix: half-size box", () => assert.deepEqual(pageToBoxMatrix([1, 0, 0, -1, 0, 240], 300, 240, { x: 0, y: 0, w: 150, h: 120 }), [0.5, 0, 0, -0.5, 0, 120]));
test("grayToHex", () => { assert.equal(grayToHex(0), "#000000"); assert.equal(grayToHex(1), "#ffffff"); assert.equal(grayToHex(0.5), "#808080"); });
test("drawOpsToPathD: rect / y-flip / cubic", () => {
  assert.equal(drawOpsToPathD([0, 0, 0, 1, 0, 80, 1, 100, 80, 1, 100, 0, 4], [1, 0, 0, 1, 0, 0]), "M0 0L0 80L100 80L100 0Z");
  assert.equal(drawOpsToPathD([0, 0, 0, 1, 60, 0, 1, 30, -50, 4], [1, 0, 0, -1, 0, 0]), "M0 0L60 0L30 50Z");
  assert.equal(drawOpsToPathD([0, 0, 0, 2, 1, 1, 2, 2, 3, 0], [1, 0, 0, 1, 0, 0]), "M0 0C1 1 2 2 3 0");
});
test("drawOpsToPathD: unknown DrawOPS code throws", () => assert.throws(() => drawOpsToPathD([9, 0, 0], [1, 0, 0, 1, 0, 0]), /unknown DrawOPS code/));

// ── 2. OP-STREAM SNAPSHOT (pins pdf.js layout — fails loudly on a bump) ─────────
test("PDF_OP constants match live pdfjs OPS (op-layout snapshot)", () => {
  for (const [name, num] of Object.entries(PDF_OP)) {
    assert.equal(pdfjs.OPS[name], num, `pdf.js OPS.${name} drifted: pinned ${num}, live ${pdfjs.OPS[name]} — re-verify render_gpu/pdf_vector.js against the new pdfjs`);
  }
});
test("DRAW_OP codes are the pinned constructPath segment enum", () => {
  assert.deepEqual(DRAW_OP, { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 });
});

const data = new Uint8Array(readFileSync(FIXTURE));
const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
const page1 = await doc.getPage(1);
const vp1 = page1.getViewport({ scale: 1 });
const opList1 = await page1.getOperatorList();

test("constructPath arg layout: [paintOp, [segsBuffer], minMax] (numeric buffer, not Path2D)", () => {
  const idx = opList1.fnArray.indexOf(PDF_OP.constructPath);
  assert.ok(idx >= 0, "fixture page 1 has a constructPath");
  const args = opList1.argsArray[idx];
  assert.equal(typeof args[0], "number", "args[0] is the paint verb");
  assert.ok(Array.isArray(args[1]), "args[1] is an array wrapping the segment buffer");
  const buf = args[1][0];
  assert.equal(typeof buf.length, "number", "args[1][0] is an indexable buffer");
  assert.equal(typeof buf[0], "number", "segment buffer is numeric (NOT a Path2D — the main-thread swap risk)");
});

// ── 3. INGEST the committed fixture ────────────────────────────────────────────
test("page 1 (pure vector graphics) classifies vector-safe", () => {
  assert.deepEqual(classifyPdfPage(opList1), { vectorSafe: true, reason: "vector-safe" });
});

const box = { x: 0, y: 0, w: vp1.width, h: vp1.height };
const pageViewport = { width: vp1.width, height: vp1.height, transform: Array.from(vp1.transform) };
const ops = pdfPageVectorIR(opList1, { pageViewport, box });

test("page 1 maps to PATH ops — NOT the raster image op", () => {
  assert.ok(ops.length >= 5, `expected >= 5 vector ops, got ${ops.length}`);
  assert.ok(ops.every((o) => o.op === "path"), "every ingested op is a `path` op");
  assert.ok(!ops.some((o) => o.op === "image"), "no raster image op in the vector sub-list");
});
test("page 1 filled-rect path baked to absolute box coords (y-flipped)", () => {
  // pdf-lib drew a filled rect at (20,20) 100×80 (y-up); the box == page, so it
  // maps to box coords (20,140)-(120,220), y-down. This pins the CTM baking.
  assert.ok(ops.some((o) => o.d === "M20 220L20 140L120 140L120 220Z" && o.fill), "blue filled rect present with baked coords");
});
test("page 1 vector ops export as native <path> in SVG", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const svg = ops.map((o) => vectorCommandToSVG(o, world, {})).join("");
  assert.ok(svg.includes("<path"), "svg export contains a <path>");
  assert.ok((svg.match(/<path/g) || []).length >= 5, "one <path> per vector op");
});

const page2 = await doc.getPage(2);
const opList2 = await page2.getOperatorList();
test("page 2 (text) classifies UNSAFE → raster fallback (text is P2)", () => {
  const c = classifyPdfPage(opList2);
  assert.equal(c.vectorSafe, false);
  assert.match(c.reason, /text/);
});

// ── 4. CLASSIFIER hard set (synthetic op lists) ────────────────────────────────
const only = (op, arg = null) => ({ fnArray: [op], argsArray: [arg] });
test("classifier: embedded image → raster", () => assert.match(classifyPdfPage(only(PDF_OP.paintImageXObject, ["img_p0_1", 64, 48])).reason, /embedded image/));
test("classifier: shading/gradient → raster", () => assert.match(classifyPdfPage(only(PDF_OP.shadingFill)).reason, /shading/));
test("classifier: CMYK → raster", () => assert.match(classifyPdfPage(only(PDF_OP.setFillCMYKColor, [0, 0, 0, 1])).reason, /CMYK/));
test("classifier: clip → raster", () => assert.match(classifyPdfPage(only(PDF_OP.clip)).reason, /clip/));
test("classifier: pattern fill → raster", () => assert.match(classifyPdfPage(only(PDF_OP.setFillColorN, [{}])).reason, /pattern/));
test("classifier: blend mode → raster", () => assert.match(classifyPdfPage(only(PDF_OP.setGState, [[["BM", "multiply"]]])).reason, /blend/));
test("classifier: soft mask → raster", () => assert.match(classifyPdfPage(only(PDF_OP.setGState, [[["SMask", { type: "alpha" }]]])).reason, /soft mask/));
test("classifier: constant alpha < 1 → raster", () => assert.match(classifyPdfPage(only(PDF_OP.setGState, [[["ca", 0.5]]])).reason, /alpha/));
test("classifier: benign gState (line width) stays safe", () => assert.equal(classifyPdfPage(only(PDF_OP.setGState, [[["LW", 4]]])).vectorSafe, true));
test("classifier: unknown op → raster with op number", () => assert.match(classifyPdfPage(only(200)).reason, /unhandled op/));
test("classifier: over budget → raster", () => {
  const big = { fnArray: new Array(MAX_VECTOR_OP_COUNT + 1).fill(PDF_OP.constructPath), argsArray: [] };
  assert.match(classifyPdfPage(big).reason, /over budget/);
});
test("gStateFallbackReason / unsafeOpReason doctests", () => {
  assert.equal(gStateFallbackReason([["LW", 4]]), null);
  assert.equal(gStateFallbackReason([["ca", 0.5]]), "constant alpha < 1 (ca=0.5)");
  assert.equal(unsafeOpReason(PDF_OP.constructPath), null);
  assert.equal(unsafeOpReason(PDF_OP.shadingFill), "shading/gradient fill");
});

console.log(`\n${passed} PDF-vector checks passed`);
