/**
 * Tests for the shared visible-region raster-sizing primitive (core/clip.js).
 * Plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/clip_test.js
 *
 * THE headline property (manifest RENDER PIVOT — "cost bounded by the SCREEN not
 * the zoom"): for an axis-aligned widget, deviceRect never exceeds the viewport
 * in device px, at ANY zoom (1×, 10×, 50×) — a window into a huge virtual
 * surface, never the whole zoomed surface. If this regresses, PDF re-raster
 * would allocate zoom-sized canvases and blow up memory.
 */

import assert from "node:assert/strict";
import { visibleSourceRect, intersectRect, aabbOfMappedRect } from "../core/clip.js";
import { identity } from "../core/transform.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}

// ── intersectRect / aabbOfMappedRect ────────────────────────────────────────
test("intersectRect: overlap / disjoint / edge-touch", () => {
  assert.deepEqual(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 });
  assert.equal(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 5, h: 5 }), null);
  assert.equal(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }), null); // edge touch = no interior
});

test("aabbOfMappedRect: identity is exact; scale halves", () => {
  assert.deepEqual(aabbOfMappedRect({ x: 0, y: 0, w: 10, h: 20 }, identity()), { x: 0, y: 0, w: 10, h: 20 });
  assert.deepEqual(aabbOfMappedRect({ x: 0, y: 0, w: 10, h: 20 }, { x: -5, y: 0, rotation: 0, scale: 0.5 }), { x: -5, y: 0, w: 5, h: 10 });
});

test("aabbOfMappedRect: 90° rotation swaps extents (conservative but exact for 90°)", () => {
  // invert of a 90° world; a 10×20 world rect maps to a 20×10 local AABB.
  const r = aabbOfMappedRect({ x: 0, y: 0, w: 10, h: 20 }, { x: 0, y: 0, rotation: Math.PI / 2, scale: 1 });
  approx(r.w, 20);
  approx(r.h, 10);
});

// ── visibleSourceRect: the core cases ───────────────────────────────────────
const view1 = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const bigBox = { world: identity(), w: 1000, h: 1000 };

test("visibleSourceRect: whole small widget visible → full box + full source", () => {
  const r = visibleSourceRect({ world: identity(), w: 10, h: 10 }, {}, view1, { viewW: 200, viewH: 200 });
  assert.equal(r.visible, true);
  assert.deepEqual(r.localRect, { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(r.sourceRect, { sx: 0, sy: 0, sw: 1, sh: 1 });
  assert.deepEqual(r.deviceRect, { w: 10, h: 10 });
});

test("visibleSourceRect: viewport window into a huge page (zoom 1)", () => {
  const r = visibleSourceRect(bigBox, {}, view1, { viewW: 200, viewH: 100 });
  assert.deepEqual(r.localRect, { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(r.sourceRect, { sx: 0, sy: 0, sw: 0.2, sh: 0.1 });
  assert.deepEqual(r.deviceRect, { w: 200, h: 100 });
});

test("visibleSourceRect: off-screen widget → not visible", () => {
  const r = visibleSourceRect({ world: { x: 500, y: 0, rotation: 0, scale: 1 }, w: 10, h: 10 }, {}, view1, { viewW: 200, viewH: 200 });
  assert.equal(r.visible, false);
  assert.equal(r.deviceRect, null);
});

test("visibleSourceRect: panned view maps to the correct source sub-rect", () => {
  const r = visibleSourceRect(bigBox, {}, { zoom: 2, panX: -100, panY: 0, dpr: 1 }, { viewW: 200, viewH: 100 });
  // worldView = {x:50,y:0,w:100,h:50}; ∩ [0,1000]² = same.
  assert.deepEqual(r.localRect, { x: 50, y: 0, w: 100, h: 50 });
  approx(r.sourceRect.sx, 0.05);
  approx(r.sourceRect.sw, 0.1);
  assert.deepEqual(r.deviceRect, { w: 200, h: 100 }); // still bounded
});

// ── THE BOUND: deviceRect ≤ viewport×dpr regardless of zoom (unrotated) ──────
test("BOUNDED RASTER: deviceRect ≤ viewport at 1×, 10×, 50× (a window, never the zoomed page)", () => {
  const viewW = 800, viewH = 600; // device px (already ×dpr)
  for (const zoom of [1, 10, 50]) {
    const r = visibleSourceRect(bigBox, {}, { zoom, panX: 0, panY: 0, dpr: 1 }, { viewW, viewH });
    assert.equal(r.visible, true, `zoom ${zoom} should see the huge page`);
    assert.ok(r.deviceRect.w <= viewW + 1e-6, `zoom ${zoom}: deviceRect.w ${r.deviceRect.w} > viewW ${viewW}`);
    assert.ok(r.deviceRect.h <= viewH + 1e-6, `zoom ${zoom}: deviceRect.h ${r.deviceRect.h} > viewH ${viewH}`);
  }
});

test("BOUNDED RASTER: holds under dpr=2 and world.scale=3 (device ≤ viewport)", () => {
  const viewW = 800, viewH = 600;
  const scaledBox = { world: { x: 0, y: 0, rotation: 0, scale: 3 }, w: 1000, h: 1000 };
  for (const zoom of [1, 10, 50]) {
    const r = visibleSourceRect(scaledBox, {}, { zoom, panX: 0, panY: 0, dpr: 2 }, { viewW, viewH });
    assert.ok(r.deviceRect.w <= viewW + 1e-6, `zoom ${zoom} dpr2 scale3: deviceRect.w ${r.deviceRect.w} > viewW ${viewW}`);
    assert.ok(r.deviceRect.h <= viewH + 1e-6, `zoom ${zoom} dpr2 scale3: deviceRect.h ${r.deviceRect.h} > viewH ${viewH}`);
  }
});

// ── crop composition (three-way intersection) ───────────────────────────────
test("visibleSourceRect: crop insets compose into the source rect", () => {
  // Whole box visible (small widget); crop 100 off the left of a 1000-wide box.
  const r = visibleSourceRect({ world: identity(), w: 1000, h: 1000 }, { cropLeft: 100 }, view1, { viewW: 2000, viewH: 2000 });
  assert.deepEqual(r.localRect, { x: 100, y: 0, w: 900, h: 1000 }); // cropped box
  approx(r.sourceRect.sx, 0.1);   // 100/1000 trimmed off the left
  approx(r.sourceRect.sw, 0.9);
});

test("visibleSourceRect: viewport ∩ crop (zoomed, only part of the cropped page on-screen)", () => {
  // Crop 100 off the left; zoom 2 so only a 100×50-world window is visible at origin.
  const r = visibleSourceRect({ world: identity(), w: 1000, h: 1000 }, { cropLeft: 100 }, { zoom: 2, panX: 0, panY: 0, dpr: 1 }, { viewW: 200, viewH: 100 });
  // worldView = {0,0,100,50}; ∩ croppedBox {100,0,900,1000} = {100,0,0,...}? worldView right edge x=100 == crop left → touch → empty visible? Pan so window overlaps the cropped region.
  assert.equal(r.visible, false); // the on-screen window (x:0..100) only touches the crop edge at x=100 — no interior
});

test("visibleSourceRect: overridable margin (less restrictive) grows the window", () => {
  const base = visibleSourceRect(bigBox, {}, { zoom: 2, panX: 0, panY: 0, dpr: 1 }, { viewW: 200, viewH: 100 });
  const wide = visibleSourceRect(bigBox, {}, { zoom: 2, panX: 0, panY: 0, dpr: 1 }, { viewW: 200, viewH: 100, margin: 25 });
  // base worldView = {0,0,100,50} → local {0,0,100,50}; margin 25 → {-25,-25,150,100} ∩ box = {0,0,125,75}.
  assert.deepEqual(base.localRect, { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(wide.localRect, { x: 0, y: 0, w: 125, h: 75 });
});

test("visibleSourceRect: full opt-out ignores the viewport (whole cropped box)", () => {
  const r = visibleSourceRect(bigBox, { cropLeft: 100 }, { zoom: 50, panX: 0, panY: 0, dpr: 1 }, { viewW: 200, viewH: 100, full: true });
  assert.deepEqual(r.localRect, { x: 100, y: 0, w: 900, h: 1000 }); // whole cropped box, not the tiny window
});

test("visibleSourceRect: fully cropped away → not visible", () => {
  const r = visibleSourceRect({ world: identity(), w: 100, h: 100 }, { cropLeft: 60, cropRight: 60 }, view1, { viewW: 500, viewH: 500 });
  assert.equal(r.visible, false);
});

test("visibleSourceRect: bad viewport dims throw loudly", () => {
  assert.throws(() => visibleSourceRect(bigBox, {}, view1, { viewW: 0, viewH: 100 }), /viewW\/viewH/);
});

console.log(`\n${passed} tests passed`);
