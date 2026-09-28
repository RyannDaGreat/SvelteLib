/** Sparse list animation regressions. Run: node src/demo_apps/PowerRP/tests/list_sparse_animation_test.js */
import assert from "node:assert/strict";
import { applied, blendApplied, getPath, setPath } from "../core/deltas.js";
import { interpolate, setInterpolationListResolver } from "../core/interpolators.js";
import { interpModeIds, registerInterpMode } from "../core/interp_modes.js";
import { listDeclAt } from "../core/expressions.js";
import { multipointFeature, MULTIPOINT_TYPE } from "../core/multipoint.js";

let passed = 0;
/** Command. Runs assertions and reports success. @param {string} name @param {Function} check @returns {void} */
function test(name, check) { check(); passed++; console.log(`  ok  ${name}`); }

/**
 * Command. Asserts sparse samples equal whole-list samples at every addressed leaf.
 * Also checks both endpoints and that source/patch were not mutated.
 * @param {object} state - Original state.
 * @param {object} patch - Sparse delta.
 * @param {Array} listPath - Whole-array replacement path.
 * @param {Array[]} paths - Addressed leaf paths.
 * @returns {void}
 */
function equivalent(state, patch, listPath, paths) {
  const before = JSON.stringify([state, patch]);
  const target = applied(state, patch);
  const full = setPath(patch, listPath, getPath(target, listPath));
  for (const alpha of [0, 0.01, 0.25, 0.5, 0.9, 1]) {
    const sparse = blendApplied(state, patch, alpha);
    const whole = blendApplied(state, full, alpha);
    for (const path of paths) assert.deepEqual(getPath(sparse, path), getPath(whole, path), `${path.join(".")} at ${alpha}`);
  }
  assert.equal(JSON.stringify([state, patch]), before);
}

// No declaration hookup: current numeric arrays must retain their own value-shape law.
test("polygon integer endpoints retain whole-tuple continuous law", () => {
  const state = { type: "polygon", points: [[0, 0], [1, 0], [0, 1]] };
  const patch = { points: { 0: { 0: 1 } } };
  equivalent(state, patch, ["points"], [["points", 0, 0]]);
  assert.equal(blendApplied(state, patch, 0.25).points[0][0], 0.25);
  assert.equal(interpolate(0, 1, 0.25), 0);
});

test("unknown nested coordinate arrays work without property-name or paint-tag checks", () => {
  const state = { bundle: { rows: [{ shape: { coords: [[0, 2], [3, 4]] }, count: 0 }] } };
  const patch = { bundle: { rows: { 0: { shape: { coords: { 0: { 0: 1 } } }, count: 1 } } } };
  equivalent(state, patch, ["bundle", "rows"], [["bundle", "rows", 0, "shape", "coords", 0, 0], ["bundle", "rows", 0, "count"]]);
  const out = blendApplied(state, patch, 0.25);
  assert.equal(out.bundle.rows[0].shape.coords[0][0], 0.25);
  assert.equal(out.bundle.rows[0].count, 0, "untyped record integers retain legacy rounding");
  assert.equal(out.bundle.rows[0].shape.coords[1], state.bundle.rows[0].shape.coords[1]);
});

test("standing list step reaches fractional target immediately", () => {
  const state = { points: [[0, 0]], "points~interp": "step" };
  const patch = { points: { 0: { 0: 0.8 } } };
  equivalent(state, patch, ["points"], [["points", 0, 0]]);
  assert.equal(blendApplied(state, patch, 0.25).points[0][0], 0.8);
});

test("incoming parent modes win from first frame, independent of key order", () => {
  for (const [standing, incoming, expected] of [["step", "tween", 0.25], ["tween", "step", 1]]) {
    const state = { points: [[0, 0]], "points~interp": standing };
    for (const patch of [{ points: { 0: { 0: 1 } }, "points~interp": incoming }, { "points~interp": incoming, points: { 0: { 0: 1 } } }]) {
      equivalent(state, patch, ["points"], [["points", 0, 0]]);
      assert.equal(blendApplied(state, patch, 0.25).points[0][0], expected);
    }
  }
});

registerInterpMode({ id: "__list_test_hold", label: "Test hold", blend: (a) => a });
test("all shipped modes and registered hold preserve whole-array semantics", () => {
  assert.ok(!interpModeIds().includes("hold"), "hold is test extension, not a shipped mode");
  for (const mode of interpModeIds()) {
    const state = { nested: { points: [[0, 0], [1, 1]], "points~interp": mode } };
    const patch = { nested: { points: { 0: { 0: 1 } } } };
    equivalent(state, patch, ["nested", "points"], [["nested", "points", 0, 0]]);
  }
  const state = { points: [[0, 0]], "points~interp": "__list_test_hold" };
  assert.equal(blendApplied(state, { points: { 0: { 0: 1 } } }, 0.25).points[0][0], 0);
  assert.equal(blendApplied(state, { points: { 0: { 0: 1 } } }, 1).points[0][0], 1);
});

test("whole-value tokens survive sparse projection at root and nested lists", () => {
  for (const state of [
    { rows: [[0, 0]], "rows~interp": "blend" },
    { rows: [{ coords: [[0, 0]], "coords~interp": "blend" }] },
  ]) {
    const patch = Array.isArray(state.rows[0]) ? { rows: { 0: { 0: 1 } } } : { rows: { 0: { coords: { 0: { 0: 1 } } } } };
    equivalent(state, patch, ["rows"], [["rows"]]);
  }
});

test("nested list child overrides parent step/hold; leaf override wins again", () => {
  for (const parentMode of ["step", "__list_test_hold"]) {
    const state = { rows: [{ coords: [[0, 0]], "coords~interp": "tween", count: 0, "count~interp": "step" }], "rows~interp": parentMode };
    const patch = { rows: { 0: { coords: { 0: { 0: 1 } }, count: 1 } } };
    equivalent(state, patch, ["rows"], [["rows", 0, "coords", 0, 0], ["rows", 0, "count"]]);
    const out = blendApplied(state, patch, 0.25);
    assert.equal(out.rows[0].coords[0][0], 0.25);
    assert.equal(out.rows[0].count, 1);
  }
});

test("new child mode overrides parent hold without prior companion slot", () => {
  const state = { rows: [{ coords: [[0, 0]] }], "rows~interp": "__list_test_hold" };
  const patch = { rows: { 0: { coords: { 0: { 0: 1 } }, "coords~interp": "tween" } } };
  equivalent(state, patch, ["rows"], [["rows", 0, "coords", 0, 0], ["rows", 0, "coords~interp"]]);
  const out = blendApplied(state, patch, 0.25);
  assert.equal(out.rows[0].coords[0][0], 0.25);
  assert.equal(out.rows[0]["coords~interp"], "tween");
});

test("incoming nested override and parameters govern same transition", () => {
  registerInterpMode({ id: "__list_test_param", label: "Test parameter", params: [{ param: "amount", label: "Amount", default: 0.5 }], blend: (a, b, alpha, ctx) => a + (b - a) * ctx.params.amount });
  const state = { rows: [{ value: 0, "value~interp": "step", "value~interp~amount": 0.5 }] };
  const patch = { rows: { 0: { value: 1, "value~interp": "__list_test_param", "value~interp~amount": 0.25 } } };
  equivalent(state, patch, ["rows"], [["rows", 0, "value"]]);
  assert.equal(blendApplied(state, patch, 0.25).rows[0].value, 0.25);
});

test("untouched equation leaves and objects keep value/identity", () => {
  const sibling = { coords: [[0, 1]], equation: "= self.x" };
  const state = { rows: [{ coords: [[0, 0]], equation: "= self.y" }, sibling] };
  const patch = { rows: { 0: { coords: { 0: { 0: 1 } } } } };
  const out = blendApplied(state, patch, 0.25);
  assert.equal(out.rows[1], sibling);
  assert.equal(out.rows[0].equation, "= self.y");
  assert.equal(out.rows[0].coords[0][1], 0);
});

test("untouched mode is never invoked by sparse override traversal", () => {
  registerInterpMode({ id: "__list_test_untouched", label: "Must not run", blend: () => { throw new Error("untouched mode invoked"); } });
  const state = { rows: [{ x: 0, y: 2, "y~interp": "__list_test_untouched" }] };
  assert.equal(blendApplied(state, { rows: { 0: { x: 1 } } }, 0.25).rows[0].y, 2);
});

// The declaration owner must install this callback in production; importing
// expressions from interpolators/deltas would introduce a reverse core cycle.
setInterpolationListResolver(listDeclAt);

test("declared polygon tuples stay continuous alongside untouched equations", () => {
  const state = { points: [[0, "= 1 + 2"], [0, 1]] };
  const patch = { points: { 0: { 0: 1 } } };
  equivalent(state, patch, ["points"], [["points", 0, 0]]);
  assert.equal(blendApplied(state, patch, 0.25).points[0][0], 0.25);
  assert.equal(blendApplied(state, patch, 0.25).points[0][1], "= 1 + 2");
});

test("shipped fallback laws retain declared numeric tuple semantics", () => {
  for (const mode of ["tween", "fade", "expTween", "morph", "blurFade", "manim", "grow"]) {
    const state = { points: [[0, "= 2"]], "points~interp": mode };
    const patch = { points: { 0: { 0: 1 } } };
    equivalent(state, patch, ["points"], [["points", 0, 0]]);
    assert.equal(blendApplied(state, patch, 0.25).points[0][0], 0.25, mode);
  }
});

test("document item prefixes do not hide declared tuple typing", () => {
  const state = { items: { p: { type: "polygon", points: [[0, "= 2"]] } } };
  const patch = { items: { p: { points: { 0: { 0: 1 } } } } };
  assert.equal(blendApplied(state, patch, 0.25).items.p.points[0][0], 0.25);
});

test("two Multipoint geometry poses tween identically as whole and sparse lists", () => {
  const point = multipointFeature("point", "#f00");
  const state = { fill: { type: MULTIPOINT_TYPE, multipoint: { features: [{ ...point, nodes: [[0, 0, 0, 0, 0, 0]] }, { ...point, nodes: [[1, 1, 1, 1, 1, 1]] }] } } };
  const patch = { fill: { multipoint: { features: { 0: { nodes: { 0: { 0: 1, 4: 1 } }, weight: 2 }, 1: { nodes: { 0: { 1: 0, 5: 0 } } } } } } };
  const prefix = ["fill", "multipoint", "features"];
  equivalent(state, patch, prefix, [[...prefix, 0, "nodes", 0, 0], [...prefix, 0, "nodes", 0, 4], [...prefix, 1, "nodes", 0, 1], [...prefix, 1, "nodes", 0, 5], [...prefix, 0, "weight"]]);
  const out = blendApplied(state, patch, 0.25).fill.multipoint.features;
  assert.equal(out[0].nodes[0][0], 0.25);
  assert.equal(out[1].nodes[0][1], 0.75);
  assert.equal(out[0].weight, 1.25);
  assert.equal(out[0].stops, state.fill.multipoint.features[0].stops);
});

test("shape changes and deletion retain endpoint/whole-array laws", () => {
  const state = { rows: [{ coords: [[0, 0]], kept: true }] };
  for (const patch of [
    { rows: { 0: { coords: { 1: [1, 1] } } } },
    { rows: { 0: { coords: [[1, 1], [2, 2]] } } },
    { rows: { 0: { kept: null } } },
  ]) equivalent(state, patch, ["rows"], [["rows", 0, "coords"], ["rows", 0, "kept"]]);
});

test("hold governs sparse additions and deletions until endpoint", () => {
  const state = { rows: [{ coords: [[0, 0]], kept: true }], "rows~interp": "__list_test_hold" };
  const patch = { rows: { 0: { kept: null }, 1: { coords: [[1, 1]] } } };
  equivalent(state, patch, ["rows"], [["rows", 0, "kept"], ["rows", 1]]);
  assert.equal(blendApplied(state, patch, 0.25).rows[0].kept, true);
});

test("ordinary widget count keeps integer interpolation", () => {
  assert.equal(blendApplied({ type: "widget", count: 0 }, { count: 1 }, 0.25).count, 0);
  assert.equal(blendApplied({ count: 1 }, { count: 4 }, 0.5).count, 3);
});

console.log(`\n${passed} sparse list animation groups passed.`);
