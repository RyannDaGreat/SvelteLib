/**
 * EXPORTER COVERAGE for THE EMIT-TIME CONTAINMENT BOUNDARY (render_gpu/ports.js
 * emitNode) — proves the PDF and SVG backends never even SEE an emit()-time
 * throw, because sceneIR has already turned the poisoned node into a red-box
 * op by the time irToPDF/irToSVG receive `commands`.
 * Plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/emit_containment_export_test.js
 *
 * ── WHY THIS IS A SEPARATE TEST FROM containment_parity_test.js ────────────
 * That suite hand-builds a POISONED OP (a getter that throws when the backend
 * reads .fill) to prove the PAINT-time boundary's exporter parity. This suite
 * exercises the REAL pipeline — registry, document, evaluateState, derive,
 * sceneIR — with a plugin whose emit() itself throws, so it proves containment
 * at the SOURCE (sceneIR) rather than re-asserting the paint boundary. The two
 * are complementary: paint_skia's boundary catches what escapes a HEALTHY
 * emit() (a bad material in a stroke slot); this one catches what never
 * reaches paint at all (a bad param an IR builder rejects inside emit()).
 */

import assert from "node:assert/strict";
import { irToPDF } from "../pdf_backend.js";
import { irToSVG } from "../svg_backend.js";
import { sceneIR } from "../ports.js";
import { createRegistry } from "../../core/registry.js";
import { registerPlugins } from "../../plugins/index.js";
import { repairedDocument, foldState, withNormalizedZ } from "../../core/document.js";
import { evaluateState } from "../../core/expressions.js";
import { deriveRenderTree } from "../../core/derive.js";

let passed = 0;
async function atest(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const VIEW = { width: 400, height: 300, view: { zoom: 1, panX: 0, panY: 0 } };
const CAM = { type: "camera", x: 0, y: 0, w: 400, h: 300, z: 0, rotation: 0, scale: 1, active: true };

function registryWithPoisonPlugin() {
  const registry = createRegistry();
  registerPlugins(registry);
  registry.register({
    type: "poison_emit_export", ephemeral: "none",
    title: "Poison Export (test-only)",
    capabilities: { bbox: true, transform: true, resizable: true },
    defaults: { type: "poison_emit_export", ephemeral: "none", x: 0, y: 0, w: 80, h: 60, z: 0, rotation: 0, scale: 1 },
    inspector: [],
    emit(state) {
      // The live shape: a plugin calls a validating IR builder with a bad number.
      throw new Error(`materialBackdrop: param "lightOffsetX" is a non-finite number (NaN)`);
    },
  });
  return registry;
}

/** The real chain every exporter walks: fold -> evaluate -> derive -> emit. */
function irOf(registry, doc) {
  return sceneIR(deriveRenderTree(
    evaluateState(foldState(withNormalizedZ(doc), 0, 1), registry, "").state,
    registry, "export-containment",
  ));
}

function poisonedDoc(registry) {
  const rep = repairedDocument({
    meta: { name: "export-containment", slideW: 400, slideH: 300 },
    slides: [{
      id: "s0", name: "Slide 1",
      delta: {
        items: {
          cam: CAM,
          good: { type: "rect", x: 20, y: 20, w: 100, h: 60, z: 1, rotation: 0, scale: 1, active: true, fill: "#22aa55" },
          poison: { type: "poison_emit_export", ephemeral: "none", name: "Poisoned Widget", x: 200, y: 20, w: 80, h: 60, z: 2, rotation: 0, scale: 1, active: true },
        },
      },
    }],
  }, registry);
  return rep.doc ?? rep;
}

const registry = registryWithPoisonPlugin();
const poisonedIR = irOf(registry, poisonedDoc(registry));

await atest("SANITY: sceneIR itself already contains the poison before either exporter runs", () => {
  assert.ok(!poisonedIR.some((o) => o.op === "materialBackdrop"), "the poisoned op must never reach the IR list");
  assert.ok(poisonedIR.some((o) => o.op === "text" && /materialBackdrop: param/.test(String(o.text))), "the real error message must survive into the affordance");
});

// ── PDF ─────────────────────────────────────────────────────────────────────

await atest("PDF: an emit()-poisoned deck exports without throwing", async () => {
  const bytes = await irToPDF(poisonedIR, VIEW);
  assert.ok(latin1(bytes).startsWith("%PDF-"), "a real PDF came out the other side");
});

await atest("PDF: the healthy rect and the red box are BOTH present", async () => {
  const s = latin1(await irToPDF(poisonedIR, VIEW));
  assert.match(s, /0\.13\d* 0\.6\d* 0\.33\d* rg/, "the healthy green fill must be there");
  assert.match(s, /0\.75\d* 0\.22\d* 0\.16\d* RG/, "the red error border must be drawn");
});

// ── SVG ─────────────────────────────────────────────────────────────────────

await atest("SVG: an emit()-poisoned deck exports without throwing", async () => {
  const svg = await irToSVG(poisonedIR, VIEW);
  assert.ok(svg.includes("<svg"), "a real SVG came out the other side");
});

await atest("SVG: the healthy rect and the red box (naming the item) are BOTH present", async () => {
  const svg = await irToSVG(poisonedIR, VIEW);
  assert.ok(/rgba?\(34,\s*170,\s*85/.test(svg) || svg.includes("#22aa55"), "the healthy fill must survive");
  assert.ok(/rgba?\(192,\s*57,\s*43/.test(svg) || svg.includes("#c0392b"), "the red error border must be drawn");
  assert.ok(/Poisoned Widget/.test(svg), "the box must NAME the item");
});

// ── PARITY ──────────────────────────────────────────────────────────────────

await atest("PARITY: both backends degrade the SAME poisoned deck the same way", async () => {
  const pdf = latin1(await irToPDF(poisonedIR, VIEW));
  const svg = await irToSVG(poisonedIR, VIEW);
  assert.ok(pdf.startsWith("%PDF-") && svg.includes("<svg"), "neither export threw");
  const pdfRed = /0\.75\d* 0\.22\d* 0\.16\d* RG/.test(pdf);
  const svgRed = /rgba?\(192,\s*57,\s*43/.test(svg) || svg.includes("#c0392b");
  assert.equal(pdfRed, true);
  assert.equal(svgRed, true);
});

// ── A CLEAN DECK IS UNAFFECTED (the byte-identical concern) ─────────────────

await atest("BYTE-IDENTICAL: a deck with NO poisoned item exports with no red box in either backend", async () => {
  const cleanDoc = repairedDocument({
    meta: { name: "clean", slideW: 400, slideH: 300 },
    slides: [{ id: "s0", name: "Slide 1", delta: { items: { cam: CAM, good: { type: "rect", x: 20, y: 20, w: 100, h: 60, z: 1, rotation: 0, scale: 1, active: true, fill: "#22aa55" } } } }],
  }, registry);
  const ir = irOf(registry, cleanDoc.doc ?? cleanDoc);
  const pdf = latin1(await irToPDF(ir, VIEW));
  const svg = await irToSVG(ir, VIEW);
  assert.ok(!/0\.75\d* 0\.22\d* 0\.16\d* RG/.test(pdf), "no red border in a healthy PDF export");
  assert.ok(!svg.includes("#c0392b") && !/rgba?\(192,\s*57,\s*43/.test(svg), "no red border in a healthy SVG export");
});

console.log(`\n${passed} passed`);
