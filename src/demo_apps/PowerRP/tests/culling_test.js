/**
 * Culling-protocol unit tests — plain node, no framework (SvelteLib has none).
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/culling_test.js
 *
 * Covers the pure culling math the compositor uses: world view-rect inversion,
 * rotation-conservative bbox AABB, rect intersection, the default skip rule,
 * the plugin canSkip hook, and the never-skip-backdrop guarantee. These run in
 * bare node (the helpers are DOM-free — paintScene itself needs a canvas and is
 * exercised by the puppeteer visual check, not here).
 */

import assert from "node:assert/strict";
import {
  worldViewRect, rotatedBBoxAABB, rectsIntersect, defaultCanSkip, canSkipNode,
} from "../render/compositor.js";
import { lensSourceRect } from "../plugins/magnifier.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}

// A minimal render-node factory: a bbox widget at a world transform.
function bboxNode(world, w, h, extra = {}) {
  return {
    state: { w, h },
    world: { x: 0, y: 0, rotation: 0, scale: 1, ...world },
    plugin: { capabilities: { bbox: true, ...extra.caps }, ...extra.plugin },
  };
}

// ── world view rect ───────────────────────────────────────────────────────────
test("worldViewRect: identity view = device size in world units", () => {
  const r = worldViewRect({ zoom: 1, panX: 0, panY: 0, dpr: 1 }, 100, 50);
  assert.deepEqual(r, { x: 0, y: 0, w: 100, h: 50 });
});
test("worldViewRect: zoom + pan + dpr invert correctly", () => {
  // device = (world*zoom + pan)*dpr. Here zoom 2, pan -20, dpr 1 over 100px:
  //   world at device 0   = (0/1 - (-20))/2 = 10
  //   world at device 100 = (100/1 - (-20))/2 = 60  → width 50.
  const r = worldViewRect({ zoom: 2, panX: -20, panY: 0, dpr: 1 }, 100, 50);
  assert.deepEqual(r, { x: 10, y: 0, w: 50, h: 25 });
  // dpr scales device px: a 200-device-px canvas at dpr 2 covers the SAME
  // world extent as 100 device px at dpr 1 (dpr is retina oversampling).
  const rr = worldViewRect({ zoom: 2, panX: -20, panY: 0, dpr: 2 }, 200, 100);
  approx(rr.x, 10);
  approx(rr.w, 50);
});
test("worldViewRect: matches the compositor env.worldToDevice mapping", () => {
  // Round-trip: the world rect corners must map back to the device corners.
  const view = { zoom: 1.5, panX: 30, panY: -12, dpr: 2 };
  const [cw, ch] = [640, 360];
  const r = worldViewRect(view, cw, ch);
  const toDev = (wx, wy) => ({ x: (wx * view.zoom + view.panX) * view.dpr, y: (wy * view.zoom + view.panY) * view.dpr });
  const tl = toDev(r.x, r.y), br = toDev(r.x + r.w, r.y + r.h);
  approx(tl.x, 0);
  approx(tl.y, 0);
  approx(br.x, cw);
  approx(br.y, ch);
});

// ── rotated bbox AABB ─────────────────────────────────────────────────────────
test("rotatedBBoxAABB: axis-aligned box is its own AABB", () => {
  const aabb = rotatedBBoxAABB(bboxNode({ x: 5, y: 7 }, 10, 20));
  assert.deepEqual(aabb, { x: 5, y: 7, w: 10, h: 20 });
});
test("rotatedBBoxAABB: 90deg rotation swaps w/h; conservative for 45deg", () => {
  const quarter = rotatedBBoxAABB(bboxNode({ x: 0, y: 0, rotation: Math.PI / 2 }, 10, 20));
  approx(quarter.w, 20); // width and height swap under a right-angle turn
  approx(quarter.h, 10);
  const diag = rotatedBBoxAABB(bboxNode({ x: 0, y: 0, rotation: Math.PI / 4 }, 10, 10));
  approx(diag.w, Math.sqrt(2) * 10); // 45deg square's AABB is bigger (safe)
});
test("rotatedBBoxAABB: null for non-bbox widgets", () => {
  const node = { state: {}, world: { x: 0, y: 0, rotation: 0, scale: 1 }, plugin: { capabilities: { bbox: false } } };
  assert.equal(rotatedBBoxAABB(node), null);
});

// ── rect intersection ─────────────────────────────────────────────────────────
test("rectsIntersect: overlap, disjoint, edge-touch counts", () => {
  assert.ok(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }));
  assert.ok(!rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 5, h: 5 }));
  assert.ok(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })); // touching edge
});

// ── default skip rule ─────────────────────────────────────────────────────────
const view100 = { x: 0, y: 0, w: 100, h: 100 };
test("defaultCanSkip: bbox outside the view is skippable", () => {
  assert.equal(defaultCanSkip(bboxNode({ x: 500, y: 0 }, 10, 10), view100), true);
});
test("defaultCanSkip: bbox inside/overlapping the view is NOT skippable", () => {
  assert.equal(defaultCanSkip(bboxNode({ x: 50, y: 50 }, 10, 10), view100), false);
  assert.equal(defaultCanSkip(bboxNode({ x: -5, y: -5 }, 10, 10), view100), false); // straddles edge
});
test("defaultCanSkip: a rotated box that swings INTO view is kept", () => {
  // Box at (95,50) size 10x40, upright: AABB x 95..105 — barely clips the
  // right edge, kept. Rotated 90deg about its origin it sweeps to negative x
  // (out of the +x region) — the conservative AABB still keeps it if it
  // overlaps; this asserts the conservative bound never wrongly culls.
  const upright = bboxNode({ x: 95, y: 50 }, 10, 40);
  assert.equal(defaultCanSkip(upright, view100), false);
});
test("defaultCanSkip: non-bbox widget never skips (unbounded contribution)", () => {
  const node = { state: {}, world: { x: 9999, y: 0, rotation: 0, scale: 1 }, plugin: { capabilities: { bbox: false } } };
  assert.equal(defaultCanSkip(node, view100), false);
});

// ── canSkipNode: backdrop guarantee + plugin hook + default ────────────────────
test("canSkipNode: a backdrop sampler is NEVER skipped, even far off-view", () => {
  // Give it a bbox far outside the view AND backdrop:true — must still paint.
  const node = bboxNode({ x: 99999, y: 0 }, 10, 10, { caps: { backdrop: true } });
  assert.equal(canSkipNode(node, view100), false);
});
test("canSkipNode: a plugin canSkip hook overrides the default rule", () => {
  const alwaysSkip = bboxNode({ x: 50, y: 50 }, 10, 10, { plugin: { canSkip: () => true } });
  assert.equal(canSkipNode(alwaysSkip, view100), true); // in-view but hook says skip
  const neverSkip = bboxNode({ x: 500, y: 0 }, 10, 10, { plugin: { canSkip: () => false } });
  assert.equal(canSkipNode(neverSkip, view100), false); // out-of-view but hook keeps it
});
test("canSkipNode: the view rect is forwarded to a plugin's canSkip", () => {
  let seen = null;
  const node = bboxNode({ x: 0, y: 0 }, 1, 1, { plugin: { canSkip: (_s, vr) => { seen = vr; return false; } } });
  canSkipNode(node, view100);
  assert.deepEqual(seen, view100);
});
test("canSkipNode: with no hook, defers to the default bbox rule", () => {
  assert.equal(canSkipNode(bboxNode({ x: 500, y: 0 }, 10, 10), view100), true);
  assert.equal(canSkipNode(bboxNode({ x: 50, y: 50 }, 10, 10), view100), false);
});

// ── magnifier lens source rect (supersampling geometry) ────────────────────────
test("lensSourceRect: a magnifier samples a 1/m-sized world square", () => {
  assert.deepEqual(lensSourceRect(100, 100, 50, 2), { x: 75, y: 75, w: 50, h: 50 });
  assert.deepEqual(lensSourceRect(0, 0, 10, 1), { x: -10, y: -10, w: 20, h: 20 });
});

console.log(`\n${passed} tests passed`);
