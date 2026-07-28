/**
 * Shapeshifter tests — the parametric family generators (core/outline.js) and
 * the family plugins' handle round-trips (plugins/shapeshifter.js). Plain node,
 * no framework (suite convention). Run from the SvelteLib repo root or here:
 *   node src/demo_apps/PowerRP/tests/shapeshifter_test.js
 *
 * Covers, per the task's VERIFY bar:
 *   - every generator: subpath counts, key vertices, CLOSED paths, dimensions;
 *   - the emitted path `d` contains NO `A` arc command (PDF-export-safe);
 *   - each family's modifierPoints apply() ROUND-TRIPS: placing the handle where
 *     the current param puts it and applying recovers that param (forward map =
 *     inverse map), with clamps holding.
 */

import assert from "node:assert/strict";
import {
  arcPoints, ringSectorOutline, roundedVerts, pointInOutlines,
  polygonStarOutline, cornerRectOutline, quadWedgeOutline, crossPlusOutline,
  frameOutline, gearOutline, calloutOutline, bannerOutline, bracketOutline, arrowOutline,
} from "../core/outline.js";
import { subpathsPathD } from "../core/shapes.js";
import { FAMILIES, makeFamilyPlugin, shapeshifterPlugins } from "../plugins/shapeshifter.js";
import { modifierWrite } from "../core/derive.js";

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const R = ([x, y]) => [Math.round(x), Math.round(y)];

// ── arc + ring sector (the radial-sweep substrate) ───────────────────────────
test("arcPoints: samples an elliptical arc inclusive, no arc command", () => {
  assert.deepEqual(arcPoints({ cx: 0, cy: 0, rx: 10, ry: 10, a0: 0, a1: Math.PI / 2, segments: 2 }).map(R), [[10, 0], [7, 7], [0, 10]]);
  assert.equal(arcPoints({ cx: 0, cy: 0, rx: 10, ry: 10, a0: 0, a1: Math.PI, segments: 4 }).length, 5);
});
test("ringSectorOutline: disc / ring / pie / gauge topologies", () => {
  assert.equal(ringSectorOutline({ cx: 50, cy: 50, rx: 50, ry: 50, inner: 0, a0: 0, a1: 2 * Math.PI }).length, 1); // disc
  assert.equal(ringSectorOutline({ cx: 50, cy: 50, rx: 50, ry: 50, inner: 0.5, a0: 0, a1: 2 * Math.PI }).length, 2); // ring hole
  assert.deepEqual(ringSectorOutline({ cx: 50, cy: 50, rx: 50, ry: 50, inner: 0, a0: -Math.PI / 2, a1: 0, cap: "pie" })[0][0], [50, 50]); // pie apex
  assert.equal(ringSectorOutline({ cx: 50, cy: 50, rx: 50, ry: 50, inner: 0.5, a0: -Math.PI / 2, a1: Math.PI }).length, 1); // annular band
});
test("ringSectorOutline: ring hole reads as empty (even-odd), band is filled", () => {
  const ring = ringSectorOutline({ cx: 50, cy: 50, rx: 50, ry: 50, inner: 0.5, a0: 0, a1: 2 * Math.PI });
  assert.equal(pointInOutlines(ring, 50, 50), false); // center is in the hole
  assert.equal(pointInOutlines(ring, 50, 8), true);   // near the outer rim = ring band
});

// ── generic outline invariants across every family generator ─────────────────
const GEN_CASES = [
  ["polygonStar tri", () => polygonStarOutline(100, 100, { points: 3, innerRatio: 1 })],
  ["polygonStar star5", () => polygonStarOutline(100, 100, { points: 5, innerRatio: 0.5 })],
  ["cornerRect round", () => cornerRectOutline(100, 100, { r0: 0.4, r1: 0.4, r2: 0.4, r3: 0.4 })],
  ["cornerRect snip", () => cornerRectOutline(100, 100, { r0: 0.4, r1: 0, r2: 0.4, r3: 0, cornerStyle: "snip" })],
  ["quadWedge trapezoid", () => quadWedgeOutline(100, 100, { taper: 0.5 })],
  ["crossPlus", () => crossPlusOutline(100, 100, { armThickness: 0.4 })],
  ["frame", () => frameOutline(100, 100, { thickness: 0.2, sides: "frame" })],
  ["gear hole", () => gearOutline(100, 100, { teeth: 8, holeRatio: 0.3 })],
  ["callout", () => calloutOutline(100, 100, { tailX: 20, tailY: 100 })],
  ["banner forked", () => bannerOutline(100, 60, { endStyle: "forked" })],
  ["bracket", () => bracketOutline(60, 120, {})],
  ["arrow straight", () => arrowOutline(100, 100, { curvature: 0 })],
  ["arrow bent", () => arrowOutline(100, 100, { curvature: 0.6 })],
];
for (const [name, gen] of GEN_CASES) {
  test(`${name}: closed subpaths, finite verts, path d has no A command`, () => {
    const subs = gen();
    assert.ok(subs.length >= 1, "at least one subpath");
    for (const sp of subs) {
      assert.ok(sp.length >= 3, "subpath is a polygon");
      for (const [x, y] of sp) assert.ok(Number.isFinite(x) && Number.isFinite(y), "finite vertex");
    }
    const d = subpathsPathD(subs);
    assert.ok(!/[A-Za-z]/.test(d.replace(/[MLZ]/g, "")), `only M/L/Z commands, got extras in ${d.slice(0, 40)}`);
    assert.ok(/Z/.test(d), "path is closed");
  });
}

// ── generators stay total (never throw) over their full slider domain ────────
test("generators are total over clamp-worthy extremes (never throw / never NaN)", () => {
  const extremes = [
    () => polygonStarOutline(100, 100, { points: 2, innerRatio: 2, cornerRadius: 5 }),   // points<3, inner>1
    () => ringSectorOutline({ cx: 50, cy: 50, rx: 50, ry: 50, inner: 5, a0: 0, a1: 10 }), // inner>1, sweep>2pi
    () => gearOutline(100, 100, { teeth: 1, innerRatio: 5, toothWidth: 5, holeRatio: 5 }),
    () => arrowOutline(100, 100, { headRatio: 5, headWidth: 5, shaftRatio: 5, curvature: 5 }),
    () => quadWedgeOutline(100, 100, { taper: 9, shear: 9 }),
  ];
  for (const fn of extremes) {
    const subs = fn();
    for (const sp of subs) for (const [x, y] of sp) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  }
});

// ── plugin emit: one `path` op, PDF-safe, effects-wrapped pass-through ────────
test("every family plugin emit()s a single path op with a PDF-safe `d`", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  for (const p of shapeshifterPlugins) {
    const ops = p.emit(p.defaults, null, world);
    const paths = ops.filter((o) => o.op === "path");
    assert.equal(paths.length, 1, `${p.type} emits exactly one path op`);
    assert.ok(!/[Aa]/.test(paths[0].d), `${p.type} d has no arc command`);
  }
  // zero-size widget emits nothing (no crash)
  assert.deepEqual(shapeshifterPlugins[0].emit({ ...shapeshifterPlugins[0].defaults, w: 0 }, null, world), []);
});

// ── THE handle round-trip invariant (forward map = inverse map) ──────────────
test("modifierPoints round-trip: placing a handle at its param and applying recovers that param", () => {
  for (const fam of FAMILIES) {
    const plugin = makeFamilyPlugin(fam);
    const state = { ...plugin.defaults };
    const mps = plugin.modifierPoints(state);
    for (const mp of mps) {
      const partial = mp.apply(state, { x: mp.x, y: mp.y });
      for (const [key, val] of Object.entries(partial)) {
        assert.ok(key in state, `${fam.type} handle ${mp.id} writes a known param ${key}`);
        approx(val, state[key], 1e-4);
      }
    }
  }
});

// ── handle CLAMPS hold under an out-of-range drag ────────────────────────────
// The clamps are now the handles' declared ALLOWED SETS (`constrain`), so a drag is
// driven through modifierWrite — the protocol's one composed driver (core/derive.js).
// The assertions are unchanged: an extreme drag still lands inside the domain.
test("modifierPoints clamp: an extreme drag stays inside the param's domain", () => {
  const radial = makeFamilyPlugin(FAMILIES.find((f) => f.type === "ss_radialSweep"));
  const st = { ...radial.defaults, startAngle: 0 }; // start dir = +x, so x-drags project onto it
  const inner = radial.modifierPoints(st).find((m) => m.id === "inner");
  approx(modifierWrite(inner, st, { x: 1e4, y: st.h / 2 }).inner, 1); // clamps to 1
  approx(modifierWrite(inner, st, { x: -1e4, y: st.h / 2 }).inner, 0); // clamps to 0
  const star = makeFamilyPlugin(FAMILIES.find((f) => f.type === "ss_polygonStar"));
  const ss = { ...star.defaults };
  const pts = star.modifierPoints(ss).find((m) => m.id === "points");
  assert.ok(modifierWrite(pts, ss, { x: ss.w / 2 + 0.01, y: ss.h / 2 }).points <= 60); // count clamps to <= 60
});

console.log(`\n${passed} shapeshifter tests passed`);
