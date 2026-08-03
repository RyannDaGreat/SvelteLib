/**
 * ABANDONED ≠ FAILED — plain node, no framework (core_test.js style).
 * Run FROM THE POWERRP DIR:
 *   node render_gpu/tests/abandoned_slot_test.js
 *
 * THE BUG THIS PINS (user, 2026-08-02): "rendering a mp4 with pdfs in it is
 * failing even if they're raster even if they're not live it's still failing I
 * don't know why." Every PDF video export refused itself, naming
 * `pdfregion:`/`pdfpage:` refs whose pixels were actually present.
 *
 * THE MECHANISM. `abandonImageSlot` retires a reserved-but-never-filled slot, and
 * it is called for TWO unrelated reasons: a raster that genuinely FAILED, and a
 * region raster SUPERSEDED by a newer view (pdf_page_raster's generation gate —
 * normal, by design, and the newer ref holds the pixels). Both used to be marked
 * `"error"`, so `failedImageRefs()` reported the benign one and `settledFrame`
 * refused the frame. It compounds: settledFrame RE-RENDERS to settle, so each
 * pass superseded the previous pass's in-flight region and minted another phantom
 * failure. The `blob:` inside those refs is a red herring — it is the resolved
 * PDF src embedded in the synthetic cache key, already loaded.
 *
 * BOTH DIRECTIONS ARE PINNED, because the fix must not buy a green export with a
 * silent hole — the exact trade `failedImageRefs` was created to prevent:
 *   · a SUPERSEDED slot must NOT appear in failedImageRefs (no false refusal);
 *   · a FAILED slot MUST still appear (no silent hole).
 *
 * Bare node: image_registry's guts need a browser, but reserve/abandon/status are
 * pure bookkeeping over a Map, so this file needs no DOM and no pdf.js.
 */

import assert from "node:assert/strict";
import {
  reserveImageSlot, registerRasterizedBitmap, abandonImageSlot,
  failedImageRefs, pendingImageRefs, imageStatus, getImage, resetImageRegistry,
} from "../gpu/image_registry.js";

let passed = 0;
function test(name, fn) { resetImageRegistry(); fn(); passed++; console.log(`  ok  ${name}`); }

/** A stand-in for an ImageBitmap: registerRasterizedBitmap only stores it. */
const fakeBitmap = () => ({ width: 4, height: 4, close() {} });

// The shape the bug actually wore: a synthetic PDF cache key wrapping a blob: src.
const BLOB = "blob:https://host/2f9c1e30-aaaa-bbbb-cccc-1234567890ab";
const regionRef = (sw) => `pdfregion:${BLOB}:1:0.000000,0.000000,${sw},0.500000:2`;

// ── The benign direction: a superseded raster must not refuse a render ────────
test("a SUPERSEDED slot is terminal but NOT a failure", () => {
  const ref = regionRef("0.500000");
  reserveImageSlot(ref);
  assert.equal(imageStatus(ref), "loading");
  abandonImageSlot(ref, "region raster superseded by a newer view");

  assert.equal(imageStatus(ref), "abandoned");
  assert.deepEqual(failedImageRefs(), [], "a superseded raster must never refuse a render");
  assert.deepEqual(pendingImageRefs(), [], "…and must never be waited on either");
  assert.equal(getImage(ref), null, "no pixels: the async contract is unchanged");
});

test("the export case: the newer ref is ready, the superseded one refuses nothing", () => {
  const stale = regionRef("0.500000"); // the view a re-render pass moved past
  const fresh = regionRef("0.600000"); // the view that actually settled
  reserveImageSlot(stale);
  abandonImageSlot(stale, "region raster superseded by a newer view");
  reserveImageSlot(fresh);
  registerRasterizedBitmap(fresh, fakeBitmap());

  // This IS the frame settledFrame sees: nothing pending, everything it needs ready.
  assert.deepEqual(pendingImageRefs(), []);
  assert.notEqual(getImage(fresh), null);
  assert.deepEqual(failedImageRefs(), [], "the frame is whole — the render must proceed");
});

// ── The loud direction: a real failure must still stop the export ────────────
test("a FAILED slot still refuses (no silent hole)", () => {
  const ref = `pdfpage:${BLOB}:3:1.5`;
  reserveImageSlot(ref);
  abandonImageSlot(ref, "whole-page raster failed — Invalid PDF structure", true);

  assert.equal(imageStatus(ref), "error");
  assert.deepEqual(failedImageRefs(), [ref], "a real failure must still refuse the render");
});

test("mixed: only the genuine failure is reported", () => {
  reserveImageSlot("pdfregion:superseded");
  abandonImageSlot("pdfregion:superseded", "superseded by a newer view");
  reserveImageSlot("pdfregion:broken");
  abandonImageSlot("pdfregion:broken", "raster threw", true);

  assert.deepEqual(failedImageRefs(), ["pdfregion:broken"]);
});

// ── The contract abandonImageSlot documents, kept true for the new state ─────
test("abandoning is a no-op on a ready slot, and unknown refs are ignored", () => {
  const ref = regionRef("0.500000");
  reserveImageSlot(ref);
  registerRasterizedBitmap(ref, fakeBitmap());
  abandonImageSlot(ref, "superseded by a newer view");
  assert.equal(imageStatus(ref), "ready", "landed pixels are never retired out from under a paint");

  abandonImageSlot("never-reserved", "superseded by a newer view");
  assert.equal(imageStatus("never-reserved"), "unloaded");
});

console.log(`\nabandoned_slot_test: ${passed} passed`);
