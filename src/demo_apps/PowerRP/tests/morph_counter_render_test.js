/**
 * THE COUNTER, IN REAL PIXELS — workstream AM's end-to-end proof.
 * Run: node src/demo_apps/PowerRP/tests/morph_counter_render_test.js
 *
 * USER BUG (2026-08-02, verbatim): "why does the number 6, the hole gets filled
 * in in the middle of morphing? As does infinity. Why is this? Can you please
 * debug that and fix that?"
 *
 * ── WHY A RENDER AND NOT ANOTHER GEOMETRY ASSERTION ─────────────────────────
 * tests/morph_counter_op_test.js states the law on the OPS, which is where the
 * bug was. This suite asks the question one level further out — through
 * `cli/render.js`, on a real CanvasKit software surface, with real Inter outlines
 * — and reads the actual PNG. That closes the loop the reported bug opened: the
 * user was looking at pixels, and every intermediate representation in this app
 * looked correct while those pixels were wrong.
 *
 * MEASURED BOTH WAYS on this exact document, "6" morphing to "8" at alpha 0.5:
 * with `morphIR` emitting one op per subpath (the defect) the frame is a SOLID
 * BLOB — zero white pixels inside the glyph's bounding box; with the paint-run
 * grain it is a 6 with an open bowl.
 *
 * ── WHAT THIS SUITE DOES NOT COVER, STATED PLAINLY ──────────────────────────
 * LATEX. `cli/render.js` cannot draw it — MathJax needs a DOM, which bare node
 * does not have, and the CLI reports that omission rather than drawing a holed
 * picture. The user's screenshot was a latex morph, so the equivalent latex
 * verification needs a BROWSER probe and is NOT claimed here. What justifies
 * reading this as covering the reported bug anyway is that the seam is SHARED:
 * latex and plaintext both hand `morphIR` a MorphPaths through the same
 * `morphPaths` capability, and `morphIR` is where the defect was. Text is the one
 * glyph-bearing widget bare node can lay out, which is the same reason
 * tests/morph_content_test.js measures the AG paint law on plaintext.
 */

import assert from "node:assert/strict";
import { renderDocToPng } from "../cli/render.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The frame size. Small enough to render in well under a second on the software
 * surface, large enough that a 180pt glyph's counter is tens of pixels across. */
const W = 400, H = 300;

/** A two-slide document whose one text item morphs "6" into "8". `morph: "morph"`
 * is the universal Morph property FORCING a morph (core/morph_property.js), so
 * the frame under test cannot quietly become a crossfade. */
const DOC = JSON.stringify({
  meta: { name: "am-counter", width: W, height: H, script: "" },
  slides: [
    {
      id: "s0", name: "six",
      transition: { type: "fade", seconds: 1, curve: "linear", sound: null },
      delta: {
        items: {
          cam: { type: "camera", x: 0, y: 0, w: W, h: H, background: "#ffffff" },
          t1: {
            type: "plaintext", x: 120, y: 60, w: 200, h: 180,
            text: "6", size: 180, font: "inter", fill: "#000000",
            align: "center", valign: "middle", morph: "morph",
          },
        },
      },
    },
    {
      id: "s1", name: "eight",
      transition: { type: "fade", seconds: 1, curve: "linear", sound: null },
      delta: { items: { t1: { text: "8" } } },
    },
  ],
});

/** Test helper. A PNG's pixels, via CanvasKit's own decoder — the same binary the
 * renderer used, so no image library enters the gate for this one measurement. */
async function decode(png) {
  const { default: CanvasKitInit } = await import("canvaskit-wasm");
  const CanvasKit = await CanvasKitInit();
  const img = CanvasKit.MakeImageFromEncoded(png);
  assert.ok(img, "the render did not produce a decodable PNG");
  const info = {
    width: img.width(), height: img.height(),
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  };
  const px = img.readPixels(0, 0, info);
  img.delete();
  return { px, width: info.width, height: info.height };
}

/** Test helper. How many light pixels are ENCLOSED BY INK — i.e. genuine holes?
 *
 * By flood fill from the frame's border across light pixels: everything the fill
 * reaches is background CONNECTED TO THE OUTSIDE, and every light pixel it cannot
 * reach is a hole, because ink is the only thing that could have stopped it.
 *
 * THIS IS THE MEASUREMENT AND A BOUNDING BOX IS NOT. The first version of this
 * helper counted light pixels inside the ink's bbox with a 20% inset, and it
 * PASSED WITH THE BUG STILL PRESENT: a 6 is round, so the corners of its box are
 * background even when the glyph is a solid blob, and the count never reached
 * zero. Recording that because it is the same class of mistake as the bug itself
 * — a proxy that correlates with the thing instead of being it.
 */
function enclosedLightPixels({ px, width, height }) {
  const DARK = 128; // a filled glyph is #000 over #fff; anything nearer black is ink
  const light = (i) => px[i * 4] >= DARK;
  const seen = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) { stack.push(x); stack.push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { stack.push(y * width); stack.push(y * width + width - 1); }
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || !light(i)) continue;
    seen[i] = 1;
    const x = i % width, y = (i - x) / width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - width);
    if (y < height - 1) stack.push(i + width);
  }
  let holes = 0, inked = 0;
  for (let i = 0; i < width * height; i++) {
    if (!light(i)) inked++;
    else if (!seen[i]) holes++;
  }
  assert.ok(inked > 0, "the frame has no ink at all — nothing was drawn");
  return holes;
}

await test("THE USER'S FRAME: a '6' morphing to an '8' keeps its bowl OPEN at alpha 0.5", async () => {
  // BEFORE THE FIX this frame was a solid black blob and this count was ZERO.
  const png = await renderDocToPng(DOC, { slide: 1, alpha: 0.5, width: W, height: H });
  const light = enclosedLightPixels(await decode(png));
  assert.ok(light > 50,
    `the counter filled in mid-morph: only ${light} enclosed light pixels — this is the user's screenshot`);
});

await test("THE ENDPOINTS still draw their own holes, so the interior is not special-cased", async () => {
  // The endpoint law: alpha 1 is the target's own picture. If the interior were
  // fixed by something that also rewrote an endpoint, this would say so.
  for (const [slide, alpha] of [[0, 1], [1, 1]]) {
    const png = await renderDocToPng(DOC, { slide, alpha, width: W, height: H });
    const light = enclosedLightPixels(await decode(png));
    assert.ok(light > 50, `slide ${slide} alpha ${alpha}: the endpoint glyph has no counter (${light} enclosed light px)`);
  }
});

console.log(`\n${passed} passed`);
