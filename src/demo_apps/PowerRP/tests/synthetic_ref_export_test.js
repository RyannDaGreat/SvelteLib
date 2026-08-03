/**
 * SYNTHETIC REGISTRY REFS NEVER REACH THE NETWORK (workstream AS, defect 2).
 * Run: node src/demo_apps/PowerRP/tests/synthetic_ref_export_test.js
 *
 * USER REPORT, 2026-08-02, console verbatim:
 *   Fetch API cannot load latex:x = \frac{...}:#000000:36.
 *     URL scheme "latex" is not supported
 *   PowerRP image_registry: failed to load "latex:..." — Failed to fetch
 *
 * A `latex:`/`mermaid:`/`pdfpage:` ref is a CACHE KEY for a bitmap the image
 * registry rasterizes and holds (gpu/image_registry.js reserveImageSlot +
 * registerRasterizedBitmap) — it is not a location, and nothing can fetch it.
 * The PDF exporter always knew that (pdf_backend.loadImageBytes routes it to
 * the resolveImageBytes seam); the SVG exporter's resolveImageHref called
 * `fetch(ref)` on every non-`data:` ref, so the two exporters DISAGREED about
 * the same refs and the SVG side produced the error above.
 *
 * This pins the shared law: ONE predicate, and a synthetic ref resolves through
 * the registry seam in BOTH backends — never through fetch.
 */

import assert from "node:assert/strict";
import { irToSVG } from "../render_gpu/svg_backend.js";
import { isSyntheticImageRef } from "../render_gpu/pdf_backend.js";
import { image } from "../render_gpu/ir.js";
import { fitRectView } from "../core/view.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${e.message}`);
    failed++;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${e.message}`);
    failed++;
  }
}

console.log("\nsynthetic registry refs never reach the network — AS defect 2\n");

// The user's OWN ref, transcribed from the console line.
const USER_LATEX_REF = "latex:x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}:#000000:36";

test("the predicate classifies every synthetic namespace, and no real URL", () => {
  for (const ref of [USER_LATEX_REF, "latex:x^2:#000:1", "mermaid:graph TD:1", "pdfpage:blob:x:1:1", "pdfregion:x"])
    assert.equal(isSyntheticImageRef(ref), true, `"${ref}" must be synthetic`);
  for (const ref of ["data:image/png;base64,AAAA", "https://x/a.png", "http://x/a.png", "blob:https://h/uuid", "/asset/proj/photo.png", "clip.png"])
    assert.equal(isSyntheticImageRef(ref), false, `"${ref}" must be fetchable`);
});

const W = 100, H = 50;
const svgOpts = (resolveImageHref) => ({
  width: W, height: H,
  view: fitRectView({ x: 0, y: 0, w: W, h: H }, W, H, 1),
  textAscent: () => 0,
  resolveImageHref,
});

await testAsync("a latex ref goes to the resolver seam — fetch is NEVER called", async () => {
  // The regression guard, stated as the user's own failure: if the export path
  // ever calls fetch() on a synthetic ref again, this throws with the message
  // the browser gave — not a vague assertion.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    throw new Error(`fetch() was called on "${String(url).slice(0, 40)}…" — a synthetic registry ref must never reach the network (this IS the reported "URL scheme \\"latex\\" is not supported" bug)`);
  };
  const seen = [];
  try {
    await irToSVG(
      [image({ ref: USER_LATEX_REF, x: 0, y: 0, w: 100, h: 50 })],
      svgOpts(async (ref) => {
        seen.push(ref);
        return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      }),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, [USER_LATEX_REF], "the latex ref must be handed to resolveImageHref, exactly once");
});

await testAsync("a NOT-YET-RASTERIZED synthetic ref exports blank, it does not throw", async () => {
  // The async reality: an export fired while MathJax is still typesetting has no
  // bitmap to inline. That is a reported skip (the resolver warns), not a failed
  // export — one un-typeset equation must not take the whole document down.
  const svg = await irToSVG(
    [image({ ref: USER_LATEX_REF, x: 0, y: 0, w: 100, h: 50 })],
    svgOpts(async () => null),
  );
  assert.ok(typeof svg === "string" && svg.includes("<svg"), "the export must still produce an SVG");
});

await testAsync("a FETCHABLE ref that resolves to null is still LOUD", async () => {
  // The other half of the rule: only a synthetic ref earns the blank pass. A
  // real URL returning nothing is a broken asset and must not be swallowed.
  await assert.rejects(
    () => irToSVG(
      [image({ ref: "/asset/proj/photo.png", x: 0, y: 0, w: 100, h: 50 })],
      svgOpts(async () => null),
    ),
    /must return a data: URI/,
    "a non-synthetic ref resolving to null must throw",
  );
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}\n`);
process.exit(failed ? 1 : 0);
