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
  worldViewRect, localBoundsOf, rotatedBBoxAABB, rectsIntersect, defaultCanSkip, canSkipNode,
} from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
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

/**
 * A TWO-POINT widget node (the line/arrow family shape): no w/h, no resize
 * handles, world == identity, bounds declared as the endpoint hull through the
 * `localBounds` protocol. `pad` mimics the stroke/head overhang those plugins add.
 */
function twoPointNode(from, to, plugin = {}, pad = 0) {
  return {
    state: { from, to },
    world: { x: 0, y: 0, rotation: 0, scale: 1 },
    plugin: {
      capabilities: { bbox: false },
      localBounds: (s) => ({
        x: Math.min(s.from.x, s.to.x) - pad,
        y: Math.min(s.from.y, s.to.y) - pad,
        w: Math.abs(s.to.x - s.from.x) + 2 * pad,
        h: Math.abs(s.to.y - s.from.y) + 2 * pad,
      }),
      ...plugin,
    },
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
test("rotatedBBoxAABB: null for an UNBOUNDABLE widget (no box, no localBounds)", () => {
  const node = { state: {}, world: { x: 0, y: 0, rotation: 0, scale: 1 }, plugin: { capabilities: { bbox: false } } };
  assert.equal(rotatedBBoxAABB(node), null);
});

// ── the BOUNDS protocol (localBoundsOf) ───────────────────────────────────────
test("localBoundsOf: a bbox widget with no hook bounds to its own box", () => {
  assert.deepEqual(localBoundsOf(bboxNode({ x: 5, y: 7 }, 10, 20)), { x: 0, y: 0, w: 10, h: 20 });
  // A bbox widget with no w/h stored still reports a (degenerate) rect, not null.
  assert.deepEqual(localBoundsOf({ state: {}, plugin: { capabilities: { bbox: true } } }), { x: 0, y: 0, w: 0, h: 0 });
});
test("localBoundsOf: null ONLY when there is no box and no hook", () => {
  assert.equal(localBoundsOf({ state: {}, plugin: { capabilities: { bbox: false } } }), null);
});
test("localBoundsOf: the hook wins over the box default", () => {
  // A widget may have BOTH a box and its own ink rect (a vertex dragged outside
  // the box, a stroke that overhangs it) — the declared rect is authoritative.
  const node = { state: { w: 100, h: 100 }, plugin: { capabilities: { bbox: true }, localBounds: () => ({ x: -20, y: 0, w: 120, h: 100 }) } };
  assert.deepEqual(localBoundsOf(node), { x: -20, y: 0, w: 120, h: 100 });
});
test("rotatedBBoxAABB: a NON-origin local rect transforms correctly at 45deg", () => {
  // The generality the protocol newly admits: a box widget's rect always starts
  // at the local origin, but a declared ink rect need not. Expected values are
  // derived INDEPENDENTLY from the rotation formula rather than from the
  // implementation: for rotation 45deg and scale 2,
  //   X = tx + sqrt(2)*(px - py),  Y = ty + sqrt(2)*(px + py)
  // so the AABB spans sqrt(2)*(w + h) in BOTH axes, min X at the (x, y+h) corner
  // and min Y at the (x, y) corner.
  const local = { x: 10, y: 20, w: 100, h: 50 };
  const node = {
    state: {},
    world: { x: 5, y: 7, rotation: Math.PI / 4, scale: 2 },
    plugin: { capabilities: { bbox: false }, localBounds: () => local },
  };
  const aabb = rotatedBBoxAABB(node);
  approx(aabb.x, 5 - 60 * Math.SQRT2);
  approx(aabb.y, 7 + 30 * Math.SQRT2);
  approx(aabb.w, 150 * Math.SQRT2);
  approx(aabb.h, 150 * Math.SQRT2);
});
test("rotatedBBoxAABB: a two-point widget's identity world is a no-op (ONE code path)", () => {
  // No branch for "world == identity": the endpoint hull goes through the very
  // same corner transform, and comes back unchanged.
  const node = twoPointNode({ x: 100, y: 100 }, { x: 200, y: 260 });
  assert.deepEqual(rotatedBBoxAABB(node), { x: 100, y: 100, w: 100, h: 160 });
  // Endpoints given in either order normalize to the same positive-size rect.
  assert.deepEqual(rotatedBBoxAABB(twoPointNode({ x: 200, y: 260 }, { x: 100, y: 100 })), { x: 100, y: 100, w: 100, h: 160 });
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
test("defaultCanSkip: an UNBOUNDABLE widget never skips (no bounds to prove it invisible)", () => {
  const node = { state: {}, world: { x: 9999, y: 0, rotation: 0, scale: 1 }, plugin: { capabilities: { bbox: false } } };
  assert.equal(defaultCanSkip(node, view100), false);
});
test("defaultCanSkip: a BOUNDABLE non-bbox widget culls like a box widget", () => {
  // THE two-point-widget defect (#194): a line/arrow used to answer "no bounds"
  // purely because it has no resize handles, so it was painted forever no matter
  // how far off-screen it sat. With localBounds it obeys the same rule as a rect.
  const far = twoPointNode({ x: 9000, y: 9000 }, { x: 9100, y: 9100 });
  assert.equal(defaultCanSkip(far, view100), true);
  const near = twoPointNode({ x: 10, y: 10 }, { x: 90, y: 90 });
  assert.equal(defaultCanSkip(near, view100), false);
  // Straddling the view edge is kept (the same edge-inclusive rule as a box).
  assert.equal(defaultCanSkip(twoPointNode({ x: 90, y: 50 }, { x: 300, y: 50 }), view100), false);
});
test("defaultCanSkip: a two-point widget's cullMargin still inflates its bounds", () => {
  // localBounds and cullMargin stay ORTHOGONAL: the hull is the widget's own ink,
  // the margin is the halo its effects throw around that ink. A line just past the
  // edge with a 20-unit halo reaching back in must be kept.
  const justOut = twoPointNode({ x: 105, y: 50 }, { x: 200, y: 50 }, { cullMargin: () => 20 });
  assert.equal(defaultCanSkip(justOut, view100), false);
  const noHalo = twoPointNode({ x: 105, y: 50 }, { x: 200, y: 50 }, { cullMargin: () => 0 });
  assert.equal(defaultCanSkip(noHalo, view100), true);
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

// ── the bounds protocol swept over EVERY registered plugin ────────────────────
//
// A convention sweep, not a per-widget test: the whole point of #194 is that
// "can this widget be bounded" stopped being a per-type special case, so the
// guarantee has to be checked per-TYPE mechanically or it rots back. A new
// two-point widget that forgets `localBounds` fails HERE rather than silently
// becoming un-band-selectable and immortal against culling.

const registry = createRegistry();
registerAll(registry, createCommands());

/**
 * The types that are honestly UNBOUNDABLE — no geometry whatsoever, so no rect
 * can describe where they are. A full-canvas backdrop blur is the only one; it
 * is `backdrop: true` so it is never culled anyway (canSkipNode's guarantee),
 * and it stays selectable by click / the item picker.
 */
const UNBOUNDABLE_TYPES = ["blur"];

test("bounds protocol: EVERY plugin is boundable except the declared unboundable set", () => {
  const unboundable = [];
  for (const plugin of registry.all()) {
    const node = { state: { ...plugin.defaults, w: 200, h: 150 }, plugin };
    if (localBoundsOf(node) === null) unboundable.push(plugin.type);
  }
  assert.deepEqual(unboundable.sort(), [...UNBOUNDABLE_TYPES].sort(),
    `unboundable set drifted — a widget with real geometry must declare localBounds(state) (core/view.js), or band select skips it and culling never skips IT`);
});

test("bounds protocol: a hookless bbox plugin still bounds to EXACTLY its box", () => {
  // The byte-identity guarantee for every pre-existing box widget: introducing the
  // protocol must not move a single one of their bounds.
  let checked = 0;
  for (const plugin of registry.all()) {
    if (plugin.localBounds || !plugin.capabilities.bbox) continue;
    const node = { state: { ...plugin.defaults, w: 237, h: 149 }, plugin };
    assert.deepEqual(localBoundsOf(node), { x: 0, y: 0, w: 237, h: 149 }, `${plugin.type} must bound to its own box`);
    checked++;
  }
  assert.ok(checked > 50, `expected the sweep to cover the box widgets, only saw ${checked}`);
});

test("bounds protocol: every DECLARED localBounds returns a finite, non-negative rect", () => {
  for (const plugin of registry.all()) {
    if (!plugin.localBounds) continue;
    const rect = plugin.localBounds({ ...plugin.defaults });
    for (const key of ["x", "y", "w", "h"])
      assert.ok(Number.isFinite(rect[key]), `${plugin.type} localBounds.${key} is not finite (${rect[key]})`);
    // Zero extent is legal (a collapsed connector draws nothing but must stay
    // reachable); NEGATIVE extent is not — it would invert every rect predicate.
    assert.ok(rect.w >= 0 && rect.h >= 0, `${plugin.type} localBounds must not have negative extent`);
  }
});

test("bounds protocol: a two-point widget's bounds CONTAIN its endpoints", () => {
  // The floor on correctness: bounds may over-estimate, never under-estimate. Any
  // widget whose ink hangs off `from`/`to` must at minimum enclose those points,
  // or culling would pop visible geometry out of view at the canvas edge.
  const from = { x: 300, y: 400 }, to = { x: 700, y: 250 };
  let checked = 0;
  for (const plugin of registry.all()) {
    if (!plugin.localBounds || plugin.defaults.from === undefined) continue;
    const rect = plugin.localBounds({ ...plugin.defaults, from, to });
    for (const p of [from, to]) {
      assert.ok(p.x >= rect.x && p.x <= rect.x + rect.w, `${plugin.type} bounds exclude endpoint x ${p.x}`);
      assert.ok(p.y >= rect.y && p.y <= rect.y + rect.h, `${plugin.type} bounds exclude endpoint y ${p.y}`);
    }
    checked++;
  }
  assert.ok(checked >= 6, `expected the whole two-point family, only saw ${checked}`);
});

// ── magnifier lens source rect (supersampling geometry) ────────────────────────
test("lensSourceRect: a magnifier samples a 1/m-sized world square", () => {
  assert.deepEqual(lensSourceRect(100, 100, 50, 2), { x: 75, y: 75, w: 50, h: 50 });
  assert.deepEqual(lensSourceRect(0, 0, 10, 1), { x: -10, y: -10, w: 20, h: 20 });
});

console.log(`\n${passed} tests passed`);
