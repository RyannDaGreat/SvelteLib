/**
 * Regenerates tests/fixtures/pdf_vector_fixture.pdf — the reproducible fixture
 * for the PDF-as-vector suite (render_gpu/tests/pdf_vector_test.js). Two pages:
 *   PAGE 1 — PURE VECTOR GRAPHICS, NO TEXT: a filled rect, a stroked rect, a
 *            line, a filled ellipse (cubic beziers), and a filled SVG-path
 *            triangle. This is the "vector-safe" page P1 renders as crisp vector.
 *   PAGE 2 — TEXT: two text runs. This is the page P1 must RASTER-fall-back
 *            (text is P2), proving the classifier keeps text pages on P0.
 *
 * Command (writes the .pdf). Uses pdf-lib (already a project dependency) so the
 * op stream is deterministic and the test can pin pdf.js's operator layout.
 *
 * Run (from the SvelteLib repo root):
 *   node src/demo_apps/PowerRP/tests/fixtures/make_pdf_vector_fixture.js
 */
import { PDFDocument, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "pdf_vector_fixture.pdf");

/** Page size in PDF points — small and fixed so the op-stream snapshot is stable. */
const PAGE_W = 300;
const PAGE_H = 240;

async function main() {
  const doc = await PDFDocument.create();

  const p1 = doc.addPage([PAGE_W, PAGE_H]);
  p1.drawRectangle({ x: 20, y: 20, width: 100, height: 80, color: rgb(0.2, 0.4, 0.9) });
  p1.drawRectangle({ x: 150, y: 20, width: 100, height: 80, borderColor: rgb(0.9, 0.2, 0.2), borderWidth: 4 });
  p1.drawLine({ start: { x: 20, y: 130 }, end: { x: 250, y: 200 }, color: rgb(0.1, 0.6, 0.2), thickness: 3 });
  p1.drawEllipse({ x: 200, y: 170, xScale: 40, yScale: 30, color: rgb(0.95, 0.7, 0.1) });
  p1.drawSvgPath("M 0 0 L 60 0 L 30 -50 Z", { x: 40, y: 200, color: rgb(0.6, 0.2, 0.8) });

  const p2 = doc.addPage([PAGE_W, PAGE_H]);
  p2.drawText("Hello PDF text page", { x: 20, y: 180, size: 20, color: rgb(0, 0, 0) });
  p2.drawText("Second line of text.", { x: 20, y: 140, size: 16, color: rgb(0.2, 0.2, 0.2) });

  const bytes = await doc.save();
  writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT} (${bytes.length} bytes)`);
}

await main();
