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
  threadFlankPts, boltOutline, screwOutline, screwHeadOutline,
  logSpiralPoints, ribbonOutline, scrollOutline, scrollPairOutline, ironFinialOutline,
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
  // ── HARDWARE + VICTORIAN families (manifest #56, #57) ──
  ["bolt", () => boltOutline(120, 260, {})],
  ["bolt washer", () => boltOutline(120, 260, { washer: true })],
  ["screw flat", () => screwOutline(120, 280, { headStyle: "flat" })],
  ["screw round", () => screwOutline(120, 280, { headStyle: "round" })],
  ["screwHead phillips", () => screwHeadOutline(200, 200, { drive: "phillips" })],
  ["screwHead torx", () => screwHeadOutline(200, 200, { drive: "torx" })],
  ["scroll", () => scrollOutline(200, 200, {})],
  ["scrollPair S", () => scrollPairOutline(300, 180, { symmetry: "S" })],
  ["scrollPair C", () => scrollPairOutline(300, 180, { symmetry: "C" })],
  ["ironFinial spear", () => ironFinialOutline(180, 300, { profile: "spear" })],
  ["ironFinial fleur", () => ironFinialOutline(180, 300, { profile: "fleur" })],
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
    () => boltOutline(120, 260, { headWidth: 9, shankWidth: 9, threads: 300, threadDepth: 9, chamfer: 9, washer: true, washerWidth: 9 }),
    () => screwOutline(120, 280, { headWidth: 9, shankWidth: 9, threads: 400, threadDepth: 9, taper: 9 }),
    () => screwHeadOutline(200, 200, { driveSize: 9, barWidth: 9 }),
    () => scrollOutline(200, 200, { turns: 0, growth: 0.01, ribbonWidth: 9, taper: 9 }),
    () => scrollPairOutline(300, 180, { turns: 0, growth: 0.01, stemLength: -9, ribbonWidth: 9 }),
    () => ironFinialOutline(180, 300, { voluteCount: 80, voluteSize: 9, turns: 0, growth: 0.01 }),
  ];
  for (const fn of extremes) {
    const subs = fn();
    for (const sp of subs) for (const [x, y] of sp) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  }
});

// ── gear: NO ARBITRARY FLOORS (user ruling, 2026-08-02) ───────────────────────
// innerRatio/toothWidth used to be clamped to [0.05, 0.98]/[0.02, 0.98] with no
// stated reason ("why does gear have arbitrary minimums... there's no reason to
// make it minimum at 0.05"). Both are plain multiplications with no division, so
// the whole [0, 1] domain is already finite; each end renders a DEFINED shape
// rather than a floored-away one.
test("gear: root radius 0 renders a toothed star (valleys collapse to the center)", () => {
  const subs = gearOutline(100, 100, { teeth: 6, innerRatio: 0, toothWidth: 0.5 });
  for (const sp of subs) for (const [x, y] of sp) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  // Every "valley" vertex sits at the ellipse center (radius 0).
  const valleys = subs[0].filter((_, i) => i % 4 === 0 || i % 4 === 3);
  for (const [x, y] of valleys) { assert.ok(Math.abs(x - 50) < 1e-9); assert.ok(Math.abs(y - 50) < 1e-9); }
});
test("gear: root radius 1 renders a plain circle (no depth left to cut)", () => {
  const subs = gearOutline(100, 100, { teeth: 8, innerRatio: 1, toothWidth: 0.5 });
  for (const [x, y] of subs[0]) {
    const r = Math.hypot(x - 50, y - 50);
    assert.ok(Math.abs(r - 50) < 1e-6, `vertex ${x},${y} should sit on the rim (r=50), got r=${r}`);
  }
});
test("gear: tooth width 0 renders spikes (tooth tops collapse to a point)", () => {
  const subs = gearOutline(100, 100, { teeth: 6, innerRatio: 0.7, toothWidth: 0 });
  for (const sp of subs) for (const [x, y] of sp) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  // The two "tip" vertices of each tooth (indices 1,2 mod 4) coincide when the
  // tooth top has zero angular width.
  for (let i = 0; i < subs[0].length; i += 4) {
    const [x1, y1] = subs[0][i + 1], [x2, y2] = subs[0][i + 2];
    assert.ok(Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9, "tooth tip should collapse to a point");
  }
});
test("gear: tooth width 1 merges adjacent teeth into a smooth ring", () => {
  const subs = gearOutline(100, 100, { teeth: 8, innerRatio: 1, toothWidth: 1 });
  for (const [x, y] of subs[0]) {
    const r = Math.hypot(x - 50, y - 50);
    assert.ok(Math.abs(r - 50) < 1e-6, "merged teeth at root=1 still trace the rim");
  }
});

// ── new-family SHAPE-SPECIFIC invariants (manifest #56, #57) ──────────────────
test("threadFlankPts: crest/root triangle wave, half-pitch phase, smooth degenerate", () => {
  assert.deepEqual(threadFlankPts(0, 40, 10, 6, 2, 0), [[10, 0], [6, 10], [10, 20], [6, 30], [10, 40]]);
  assert.deepEqual(threadFlankPts(0, 40, 10, 6, 2, 1), [[6, 0], [10, 10], [6, 20], [10, 30], [6, 40]]); // phase = opposite flank
  assert.deepEqual(threadFlankPts(0, 40, 10, 6, 0, 0), [[10, 0], [10, 40]]); // 0 threads ⇒ smooth edge
});
test("bolt/screw: point counts RESPOND to the thread + washer knobs", () => {
  const few = boltOutline(120, 260, { threads: 4 })[0].length;
  const many = boltOutline(120, 260, { threads: 20 })[0].length;
  assert.ok(many > few, "more threads ⇒ more vertices");
  assert.ok(boltOutline(120, 260, { washer: true })[0].length > boltOutline(120, 260, { washer: false })[0].length, "washer adds vertices");
  // screw tapers to a SHARP point at bottom-center.
  assert.ok(screwOutline(120, 280, { threads: 9 })[0].some(([x, y]) => Math.abs(x - 60) < 1e-9 && y === 280), "screw tip at bottom center");
});
test("screwHead: outer disc + drive recess as an even-odd HOLE", () => {
  for (const drive of ["slot", "phillips", "hex", "torx"]) {
    const subs = screwHeadOutline(200, 200, { drive });
    assert.equal(subs.length, 2, `${drive} = disc + recess`);
    assert.equal(pointInOutlines(subs, 100, 100), false, `${drive} center is in the recess hole`);
    assert.equal(pointInOutlines(subs, 100, 12), true, `${drive} near the rim is head metal`);
  }
});
test("logSpiral/ribbon: a turn multiplies the radius; ribbon closes to an even vertex count", () => {
  approx(logSpiralPoints({ cx: 0, cy: 0, r0: 1, growth: 2, a0: 0, a1: 2 * Math.PI, samples: 1 })[1][0], 2); // one turn ⇒ ×2
  assert.equal(ribbonOutline([[0, 0], [10, 0], [20, 0]], 2).length % 2, 0); // right edge + left edge
});
test("scrollPair: S and C both produce ONE continuous ribbon, in-bounds", () => {
  for (const symmetry of ["S", "C"]) {
    const subs = scrollPairOutline(300, 180, { symmetry });
    assert.equal(subs.length, 1, `${symmetry} = one ribbon`);
    for (const [x, y] of subs[0]) assert.ok(x >= -0.01 && x <= 300.01 && y >= -0.01 && y <= 180.01, "fitted in-bounds");
  }
});
test("ironFinial: subpath count = profile + 2·voluteCount", () => {
  assert.equal(ironFinialOutline(180, 300, { voluteCount: 0 }).length, 1);
  assert.equal(ironFinialOutline(180, 300, { voluteCount: 1 }).length, 3);
  assert.equal(ironFinialOutline(180, 300, { voluteCount: 2 }).length, 5);
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

// ── GEOMETRY PRESETS validation (manifest #70 — the presets mantra) ───────────
// Every ornament family that ships presets must: hold ≥10 (the mantra's floor);
// carry unique names; only touch knobs the family DECLARES; keep every numeric
// value inside that knob's declared [min, max]; and produce a real, closed,
// non-empty outline — the same non-degeneracy bar GEN_CASES enforces above.
test("family presets: ≥10, unique names, declared knobs, in-range, non-degenerate outlines", () => {
  const withPresets = FAMILIES.filter((f) => Array.isArray(f.presets));
  assert.ok(withPresets.length >= 6, "the six ornament families all declare presets");
  for (const fam of withPresets) {
    const rowByKey = new Map(fam.rows.map((r) => [r.key, r]));
    assert.ok(fam.presets.length >= 10, `${fam.type}: ${fam.presets.length} presets (mantra floor is 10)`);

    const names = new Set();
    for (const preset of fam.presets) {
      assert.ok(preset.name && typeof preset.name === "string", `${fam.type}: preset has a name`);
      assert.ok(typeof preset.description === "string" && preset.description.length > 0, `${fam.type} "${preset.name}": has a one-line description`);
      assert.ok(!names.has(preset.name), `${fam.type}: duplicate preset name "${preset.name}"`);
      names.add(preset.name);
      assert.ok(preset.props && typeof preset.props === "object", `${fam.type} "${preset.name}": has a props object`);

      for (const [key, val] of Object.entries(preset.props)) {
        const row = rowByKey.get(key);
        // A preset prop must be a declared knob OR a family-defaults state slot:
        // callout's tailX/tailY are real state controlled by an on-canvas handle
        // with deliberately no Inspector row (stated at its defaults), and the
        // roster-wide preset_contract_test's rule is defaults-or-rows for the
        // same reason. Row-shape validation applies only where a row exists.
        assert.ok(row || key in fam.defaults, `${fam.type} "${preset.name}": prop "${key}" is a declared knob or defaults slot`);
        if (row && row.kind === "number") {
          assert.equal(typeof val, "number", `${fam.type} "${preset.name}": numeric knob "${key}" gets a number`);
          assert.ok(Number.isFinite(val), `${fam.type} "${preset.name}": knob "${key}" is finite`);
          if (row.min !== undefined) assert.ok(val >= row.min, `${fam.type} "${preset.name}": "${key}"=${val} ≥ min ${row.min}`);
          if (row.max !== undefined) assert.ok(val <= row.max, `${fam.type} "${preset.name}": "${key}"=${val} ≤ max ${row.max}`);
        } else if (row?.kind === "select") {
          assert.ok(row.options.includes(val), `${fam.type} "${preset.name}": "${key}"="${val}" is a declared option`);
        } else if (row?.kind === "boolean") {
          assert.equal(typeof val, "boolean", `${fam.type} "${preset.name}": boolean knob "${key}" gets a boolean`);
        }
      }

      // The preset must actually draw: fold props over defaults and run outline().
      // Fold over the PLUGIN's defaults, not the family's four knobs: presets are
      // applied to a real item in the app, and outline() reads box geometry (w/h)
      // that only the built plugin's defaults carry. The family-only fold NaN'd
      // every radialSweep preset the first time that family ever HAD presets.
      const subs = fam.outline({ ...makeFamilyPlugin(fam).defaults, ...preset.props });
      assert.ok(subs.length >= 1, `${fam.type} "${preset.name}": outline has ≥1 subpath`);
      for (const sp of subs) {
        assert.ok(sp.length >= 3, `${fam.type} "${preset.name}": each subpath is a polygon`);
        for (const [x, y] of sp) assert.ok(Number.isFinite(x) && Number.isFinite(y), `${fam.type} "${preset.name}": finite vertex`);
      }
      const d = subpathsPathD(subs);
      assert.ok(/Z/.test(d), `${fam.type} "${preset.name}": path is closed`);
      assert.ok(!/[A-Za-z]/.test(d.replace(/[MLZ]/g, "")), `${fam.type} "${preset.name}": only M/L/Z commands`);
    }
  }
});

console.log(`\n${passed} shapeshifter tests passed`);
