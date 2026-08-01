/**
 * BACKEND PARITY for THE PER-NODE PAINT BOUNDARY: an EXPORT of a poisoned deck
 * produces the deck with a red box on the one broken item — never a thrown
 * export.
 * Plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/containment_parity_test.js
 *
 * ── WHY EXPORT PARITY IS PART OF THE ARMOR, NOT A NICE-TO-HAVE ──────────────
 * The incident that motivated the boundary was a BRICK: a poisoned autosave that
 * crashed the app on every boot ("Oh no, I put it into a crash permaloop"). The
 * export path has the same shape of failure with a different cost — a user whose
 * deck contains ONE bad widget gets nothing at all out of a thrown export, and
 * the error names no item, so they cannot even tell which of forty slides to
 * look at. Degrading that one item to a red box hands them their other
 * thirty-nine slides AND tells them exactly what to fix.
 *
 * ── THE LINE, PINNED IN BOTH DIRECTIONS ────────────────────────────────────
 * DOCUMENT POISON is contained. BACKEND CONFIGURATION (a missing rasterize
 * callback) still throws, because it is broken for the WHOLE export and no red
 * box on one item describes it honestly. Containing it would convert a correct,
 * loud refusal into forty red boxes plus a "successful" export — precisely the
 * silent failure the boundary exists to prevent, wearing its costume. Both
 * halves are asserted here; the existing pdf_backend / render_gpu suites pin the
 * configuration half independently.
 */

import assert from "node:assert/strict";
import { irToPDF } from "../pdf_backend.js";
import { irToSVG } from "../svg_backend.js";
import { rect, pushTransform, popTransform } from "../ir.js";
import { errorMessage } from "../../core/paint_containment.js";

let passed = 0;
async function atest(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const VIEW = { width: 200, height: 120, view: { zoom: 1, panX: 0, panY: 0 } };

/**
 * A POISONED op: structurally a valid rect, but reading its `fill` throws — the
 * shape of the live defect (a fill-only material in a stroke slot made
 * getStrokeMaterial throw when the painter reached for it), reproduced without
 * pinning this test to one material id that a future refactor could rename.
 * The throw happens INSIDE the backend's own op handling, which is exactly where
 * the emit-time guards could not reach.
 */
function poisonedRect(id) {
  const op = { op: "rect", x: 10, y: 10, w: 60, h: 40, cornerRadius: 0, stroke: null, strokeWidth: 0 };
  Object.defineProperty(op, "fill", {
    enumerable: true,
    get() { throw new Error(`unknown material "crt" (${id})`); },
  });
  return op;
}

/** A scene: one healthy item, one poisoned item, each in its OWN owner run —
 *  the structure render_gpu/ports.js emits for two derived nodes. */
function poisonedScene() {
  return [
    { ...pushTransform({ x: 0, y: 0 }), owner: { itemId: "healthy1", type: "rect", name: "Good Box" } },
    rect({ x: 100, y: 10, w: 50, h: 50, fill: "#22aa55" }),
    popTransform(),
    { ...pushTransform({ x: 0, y: 0 }), owner: { itemId: "poison1", type: "iconify", name: "Bad Icon" } },
    poisonedRect("poison1"),
    popTransform(),
  ];
}

// ── PDF ─────────────────────────────────────────────────────────────────────

await atest("PDF: a poisoned item does NOT throw the export", async () => {
  const bytes = await irToPDF(poisonedScene(), VIEW);
  assert.ok(latin1(bytes).startsWith("%PDF-"), "a real PDF came out the other side");
});

await atest("PDF: the HEALTHY item still exports (the rest of the deck survives)", async () => {
  const clean = latin1(await irToPDF([
    { ...pushTransform({}), owner: { itemId: "healthy1", type: "rect" } },
    rect({ x: 100, y: 10, w: 50, h: 50, fill: "#22aa55" }),
    popTransform(),
  ], VIEW));
  const poisoned = latin1(await irToPDF(poisonedScene(), VIEW));
  // the healthy rect's green fill is present in BOTH
  const green = /0\.13\d* 0\.6\d* 0\.33\d* rg/;
  assert.match(clean, green, "control: the healthy fill is expressible");
  assert.match(poisoned, green, "the healthy item must be untouched by its neighbour's failure");
});

await atest("PDF: the poisoned item becomes a RED BOX naming it", async () => {
  const s = latin1(await irToPDF(poisonedScene(), VIEW));
  // the affordance's border colour (#c0392b) as a PDF stroke operator
  assert.match(s, /0\.75\d* 0\.22\d* 0\.16\d* RG/, "the red error border must be drawn");
  // AND THE NAME, which is the half this file used to assert on the SVG side only —
  // and the half that was MISSING. Fonts are embedded by irToPDF's pre-scan of the
  // command list, and this text op is created after the failure, so on a slide with
  // no other text `ctx.font()` threw "not embedded", emitContainmentBox's catch ate
  // it, and the export got a BLANK red box. That is what todo #226's reporter saw:
  // "the big red box", with nothing in it to say which widget or why, so he bisected
  // by hand. A box that names nothing is the silent failure the affordance exists to
  // prevent, wearing its costume — the same shape of mistake as the hex-vs-parsed
  // colour bug recorded in core/paint_containment.js's palette docblock.
  //
  // The expectation is DERIVED: the exporter writes text as one hex Tj, so the
  // oracle is errorMessage()'s own output hex-encoded, not a transcribed literal.
  const label = errorMessage("Bad Icon", "failed to export");
  assert.ok(s.includes(Buffer.from(label, "latin1").toString("hex").toUpperCase()),
    `the box must NAME the item — that is how the user finds what to fix. Expected the Tj hex for ${JSON.stringify(label)}`);
});

await atest("PDF: BACKEND CONFIGURATION still throws — containment has a limit", async () => {
  // A blur with no rasterize callback: broken for the whole export, so it must
  // NOT be quietly turned into a red box.
  const { blurBackdrop } = await import("../ir.js");
  await assert.rejects(
    () => irToPDF([
      { ...pushTransform({}), owner: { itemId: "a", type: "rect" } },
      rect({ x: 0, y: 0, w: 10, h: 10, fill: "#f00" }),
      blurBackdrop({ radius: 3 }),
      popTransform(),
    ], VIEW),
    /rasterize callback/,
    "a caller wiring error must stay loud and fatal",
  );
});

// ── SVG ─────────────────────────────────────────────────────────────────────

await atest("SVG: a poisoned item does NOT throw the export", async () => {
  const svg = await irToSVG(poisonedScene(), VIEW);
  assert.ok(svg.includes("<svg"), "a real SVG came out the other side");
});

await atest("SVG: the HEALTHY item still exports", async () => {
  const svg = await irToSVG(poisonedScene(), VIEW);
  assert.ok(/rgba?\(34,\s*170,\s*85/.test(svg) || svg.includes("#22aa55"), `the healthy green fill must survive: ${svg.slice(0, 400)}`);
});

await atest("SVG: the poisoned item becomes a RED BOX naming it", async () => {
  const svg = await irToSVG(poisonedScene(), VIEW);
  assert.ok(/rgba?\(192,\s*57,\s*43/.test(svg) || svg.includes("#c0392b"), "the red error border must be drawn");
  assert.ok(/Bad Icon/.test(svg), "the box must NAME the item — that is how the user finds what to delete");
});

await atest("SVG: BACKEND CONFIGURATION still throws", async () => {
  const { blurBackdrop } = await import("../ir.js");
  await assert.rejects(
    () => irToSVG([
      { ...pushTransform({}), owner: { itemId: "a", type: "rect" } },
      rect({ x: 0, y: 0, w: 10, h: 10, fill: "#f00" }),
      blurBackdrop({ radius: 3 }),
      popTransform(),
    ], VIEW),
    /rasterize callback/,
  );
});

// ── PARITY ──────────────────────────────────────────────────────────────────

await atest("PARITY: both exporters contain the SAME item and keep the SAME neighbour", async () => {
  // The point of a shared affordance module: a contained item looks the same
  // wherever it is drawn, so a user comparing an editor screenshot to a PDF to
  // an SVG sees one consistent failure, not three different mysteries.
  const pdf = latin1(await irToPDF(poisonedScene(), VIEW));
  const svg = await irToSVG(poisonedScene(), VIEW);
  assert.ok(pdf.startsWith("%PDF-") && svg.includes("<svg"), "neither export threw");
  const pdfRed = /0\.75\d* 0\.22\d* 0\.16\d* RG/.test(pdf);
  const svgRed = /rgba?\(192,\s*57,\s*43/.test(svg) || svg.includes("#c0392b");
  assert.equal(pdfRed, svgRed, "both backends must degrade, or neither — a one-sided containment is a parity bug");
  assert.equal(pdfRed, true);
});

console.log(`\n${passed} passed`);
