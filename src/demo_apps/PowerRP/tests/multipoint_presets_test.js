/** Data/geometry checks only. Real-solver visual acceptance is a separate gallery gate. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MULTIPOINT_PRESETS, getMultipointPreset, hermiteNodes, ellipseNodes, spiralNodes, waveNodes,
} from "../core/multipoint_presets.js";
import { nodeCubic, featurePolyline } from "../core/multipoint.js";
import { evalCubic } from "../core/morph_geometry.js";
import { parsePaint, parseColor } from "../render_gpu/ir.js";

const EXPECTED_IDS = [
  "neon-spiral", "twin-spiral", "acid-ribbons", "chromatic-rings", "aurora-curtains",
  "prism-fan", "rainbow-arches", "warm-bokeh", "cool-bokeh", "lava-lagoons",
  "candy-vortex", "sunset-tide", "tidal-lagoon", "velvet-folds",
];
const ROUND_OFF = 1e-12;
const MAX_UNIT_BOX_CURVE_ERROR = 0.001; // one pixel at 1000 px, independent of solver
const MAX_RELATIVE_CIRCLE_ERROR = 0.000273; // standard four-cubic circle bound
const SAMPLES_PER_SEGMENT = 40; // includes extrema between anchors and midpoints
const MIN_BOUND = -0.3, MAX_BOUND = 1.3; // modest overscan, not remote constraints
const MAX_FEATURES = 12, MAX_NODES_PER_FEATURE = 13, MAX_NODES_PER_PAINT = 40;

/**
 * Command. Asserts two numeric vectors agree within an explicit tolerance.
 * @param {number[]} actual - Measured vector.
 * @param {number[]} expected - Reference vector.
 * @param {number} tolerance - Maximum component error.
 * @returns {void}
 * @example near([0.1 + 0.2], [0.3]) // undefined; assertion passes
 */
function near(actual, expected, tolerance = ROUND_OFF) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance,
    `${value} != ${expected[i]} (tolerance ${tolerance})`));
}

/**
 * Command. Walks owned objects to reject shared mutable structure and check freezing.
 * @param {object} value - Catalog subtree.
 * @param {Set<object>} seen - Visited identities; mutated as this walk progresses.
 * @returns {void}
 * @example uniqueFrozenObjects(Object.freeze({nodes:Object.freeze([])}), new Set()) // undefined
 */
function uniqueFrozenObjects(value, seen) {
  assert.ok(!seen.has(value), "catalog must not share feature/node/stop objects");
  assert.ok(Object.isFrozen(value), "catalog template must be deeply frozen");
  seen.add(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") uniqueFrozenObjects(child, seen);
}

/**
 * Command. Compares every open cubic with an independently evaluated analytic curve.
 * @param {number[][]} nodes - [N,6] native nodes, with uniform parameter spacing.
 * @param {function(number):number[]} analytic - Exact [x,y] position at t in [0,1].
 * @param {number} tolerance - Maximum position error per component.
 * @returns {void}
 * @example checkCurve(hermiteNodes([[0,0,1,0],[1,0,1,0]],1), t => [t,0], ROUND_OFF) // undefined
 */
function checkCurve(nodes, analytic, tolerance) {
  for (let segment = 0; segment < nodes.length - 1; segment++) {
    const cubic = nodeCubic(nodes[segment], nodes[segment + 1]);
    for (let sample = 0; sample <= SAMPLES_PER_SEGMENT; sample++) {
      const local = sample / SAMPLES_PER_SEGMENT;
      near(evalCubic(cubic, local), analytic((segment + local) / (nodes.length - 1)), tolerance);
    }
  }
}

test("catalog has pinned stable IDs, meaningful metadata and distinct native data", () => {
  assert.deepEqual(MULTIPOINT_PRESETS.map(({ id }) => id), EXPECTED_IDS);
  assert.ok(MULTIPOINT_PRESETS.length >= 12);
  assert.equal(new Set(MULTIPOINT_PRESETS.map(({ label }) => label)).size, EXPECTED_IDS.length);
  assert.equal(new Set(MULTIPOINT_PRESETS.map(({ paint }) => JSON.stringify(paint))).size, EXPECTED_IDS.length);
  // Distinct geometry, not merely a palette swap on a single recipe.
  const layouts = MULTIPOINT_PRESETS.map(({ paint }) => JSON.stringify(paint.multipoint.features.map(({ nodes, closed }) => ({ nodes, closed }))));
  assert.equal(new Set(layouts).size, EXPECTED_IDS.length);
  uniqueFrozenObjects(MULTIPOINT_PRESETS, new Set());
  for (const entry of MULTIPOINT_PRESETS) {
    assert.deepEqual(Object.keys(entry).sort(), ["description", "id", "label", "paint"]);
    assert.match(entry.id, /^[a-z]+(?:-[a-z]+)+$/);
    assert.ok(entry.label.trim() && entry.description.trim());
    assert.deepEqual(Object.keys(entry.paint).sort(), ["multipoint", "type"]);
    assert.equal(entry.paint.type, "multipointGradient");
    assert.deepEqual(Object.keys(entry.paint.multipoint), ["features"]);
  }
});

test("every preset parses losslessly to native features with finite colors", () => {
  for (const { id, paint } of MULTIPOINT_PRESETS) {
    const before = JSON.stringify(paint);
    const parsed = parsePaint(paint);
    assert.equal(parsed.type, paint.type, id);
    assert.equal(parsed.features.length, paint.multipoint.features.length, id);
    assert.deepEqual(parsePaint(parsed), parsed, `${id}: parsed IR is reentrant`);
    assert.deepEqual(JSON.parse(before), paint, `${id}: JSON round-trip`);
    parsed.features.forEach((feature, index) => {
      const original = paint.multipoint.features[index];
      assert.deepEqual(Object.keys(original).sort(), ["closed", "nodes", "stops", "twoSided", "weight"]);
      assert.deepEqual(feature.nodes, original.nodes, id);
      assert.equal(feature.twoSided, original.twoSided, id);
      assert.equal(feature.closed, original.closed, id);
      assert.equal(original.weight, 1, id);
      assert.equal(feature.weight, 1, id);
      assert.equal(feature.stops.length, original.stops.length, id);
      original.stops.forEach((stop, i) => {
        assert.deepEqual(Object.keys(stop).sort(), ["color", "offset", "rightColor"]);
        assert.match(stop.color, /^#[0-9a-f]{6}$/);
        assert.match(stop.rightColor, /^#[0-9a-f]{6}$/);
        assert.ok(stop.offset >= 0 && stop.offset <= 1);
        if (i) assert.ok(stop.offset > original.stops[i - 1].offset);
        assert.equal(feature.stops[i].offset, stop.offset);
        assert.deepEqual(feature.stops[i].color, parseColor(stop.color));
        assert.deepEqual(feature.stops[i].rightColor, parseColor(stop.rightColor));
        assert.ok([...feature.stops[i].color, ...feature.stops[i].rightColor].every(Number.isFinite));
      });
      if (original.closed && original.stops.length > 1) {
        assert.equal(original.stops[0].color, original.stops.at(-1).color, `${id}: no accidental closed-ramp seam`);
        assert.equal(original.stops[0].rightColor, original.stops.at(-1).rightColor);
      }
      if (original.nodes.length === 1) {
        assert.equal(original.stops.length, 1);
        assert.equal(original.stops[0].offset, 0);
        assert.equal(original.twoSided, false);
        assert.equal(original.closed, false);
        assert.deepEqual(original.nodes[0].slice(2), [0, 0, 0, 0]);
      }
    });
    assert.equal(JSON.stringify(paint), before, `${id}: parsing does not mutate stored paint`);
  }
});

test("lookup returns fresh deep mutable paints; unknown IDs throw", () => {
  for (const entry of MULTIPOINT_PRESETS) {
    const a = getMultipointPreset(entry.id), b = getMultipointPreset(entry.id);
    assert.deepEqual(a, entry.paint);
    assert.deepEqual(b, a);
    assert.notEqual(a, b);
    assert.notEqual(a.multipoint, b.multipoint);
    a.multipoint.features.forEach((feature, i) => {
      assert.notEqual(feature, b.multipoint.features[i]);
      assert.notEqual(feature.nodes, b.multipoint.features[i].nodes);
      assert.notEqual(feature.stops, b.multipoint.features[i].stops);
      feature.nodes.forEach((node, j) => {
        assert.notEqual(node, b.multipoint.features[i].nodes[j]);
        node[0] += 1;
      });
      feature.stops.forEach((stop, j) => {
        assert.notEqual(stop, b.multipoint.features[i].stops[j]);
        stop.color = "#000000";
        stop.rightColor = "#ffffff";
        stop.offset = 0.375;
      });
      feature.closed = !feature.closed;
      feature.twoSided = !feature.twoSided;
      feature.weight = 2;
    });
    a.multipoint.features.pop();
    a.multipoint.featuresActive = [false];
    assert.deepEqual(b, entry.paint);
    assert.deepEqual(getMultipointPreset(entry.id), entry.paint);
  }
  for (const id of ["missing", "NEON-SPIRAL", "", "constructor", undefined, null, 0])
    assert.throws(() => getMultipointPreset(id), /Unknown Multipoint preset:/);
  assert.throws(() => { MULTIPOINT_PRESETS[0].id = "changed"; }, TypeError);
  assert.throws(() => { MULTIPOINT_PRESETS[0].paint.multipoint.features[0].nodes[0][0] = 99; }, TypeError);
});

test("Hermite conversion reproduces a cubic exactly, including scaled derivatives", () => {
  const samples = [0, 0.25, 0.5, 0.75, 1].map((t) => [t, t ** 3, 1, 3 * t ** 2]);
  const before = structuredClone(samples);
  const nodes = hermiteNodes(samples, 0.25);
  checkCurve(nodes, (t) => [t, t ** 3], ROUND_OFF);
  assert.deepEqual(samples, before);
  near(hermiteNodes([[0, 0, 1, 0], [1, 1, 1, 2]], 1)[1], [1, 1, -1 / 3, -2 / 3, 1 / 3, 2 / 3]);
  nodes[0][0] = 10;
  assert.deepEqual(samples, before, "returned anchors do not alias samples");
});

test("ellipse cubics meet circle-error bound with smooth closing seam and no duplicate node", () => {
  const cx = 0.5, cy = 0.4, rx = 0.3, ry = 0.2;
  const nodes = ellipseNodes(cx, cy, rx, ry);
  assert.equal(nodes.length, 4);
  near(nodes[0].slice(0, 2), [0.8, 0.4]);
  near(ellipseNodes(0.5, 0.5, 0.25)[0].slice(0, 2), [0.75, 0.5]);
  for (let segment = 0; segment < nodes.length; segment++) {
    const node = nodes[segment], next = nodes[(segment + 1) % nodes.length];
    near(node.slice(2, 4), node.slice(4, 6).map((v) => -v));
    for (let sample = 0; sample <= SAMPLES_PER_SEGMENT; sample++) {
      const [x, y] = evalCubic(nodeCubic(node, next), sample / SAMPLES_PER_SEGMENT);
      const radialError = Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
      assert.ok(radialError <= MAX_RELATIVE_CIRCLE_ERROR, `ellipse radial error ${radialError}`);
    }
  }
  const polyline = featurePolyline(nodes, true);
  near(polyline[0], polyline.at(-1));
  assert.notDeepEqual(nodes[0].slice(0, 2), nodes.at(-1).slice(0, 2));
});

test("spiral cubics track the analytic spiral for both traversal directions", () => {
  for (const turns of [0.75, 1, 1.25, 1.5, -1.25]) {
    const options = { cx: 0.4, cy: 0.5, startRadius: 0.06, endRadius: 0.59, turns, phase: Math.PI / 3 };
    const nodes = spiralNodes(options);
    checkCurve(nodes, (t) => {
      const r = options.startRadius + (options.endRadius - options.startRadius) * t;
      const angle = options.phase + 2 * Math.PI * turns * t;
      return [options.cx + r * Math.cos(angle), options.cy + r * Math.sin(angle)];
    }, MAX_UNIT_BOX_CURVE_ERROR);
    for (const node of nodes) near(node.slice(2, 4), node.slice(4, 6).map((v) => -v));
  }
  const example = spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.1, endRadius: 0.4, turns: 1 });
  assert.equal(example.length, 9);
  near(example[0].slice(0, 2), [0.6, 0.5]);
  near(example.at(-1).slice(0, 2), [0.9, 0.5]);
});

test("wave cubics track sine, half-wave peaks, reversed axes and zero cycles", () => {
  for (const cycles of [0, 0.5, 0.75, 1, 1.25, -1]) {
    for (const [x0, x1] of [[-0.08, 1.08], [1, 0]]) {
      const y = 0.5, amplitude = 0.3, phase = Math.PI / 3;
      const nodes = waveNodes({ x0, x1, y, amplitude, cycles, phase });
      checkCurve(nodes, (t) => [x0 + (x1 - x0) * t, y + amplitude * Math.sin(2 * Math.PI * cycles * t + phase)], MAX_UNIT_BOX_CURVE_ERROR);
    }
  }
  near(waveNodes({ x0: 0, x1: 1, y: 0.5, amplitude: 0.2, cycles: 0.5 })[2].slice(0, 2), [0.5, 0.7]);
  assert.equal(waveNodes({ x0: 0, x1: 1, y: 0.5, amplitude: 0.2 }).length, 9);
});

test("all stored nodes and whole cubic hulls stay within modest bounds/budgets", () => {
  for (const { id, paint } of MULTIPOINT_PRESETS) {
    const features = paint.multipoint.features;
    assert.ok(features.length > 0 && features.length <= MAX_FEATURES, id);
    assert.ok(features.reduce((sum, feature) => sum + feature.nodes.length, 0) <= MAX_NODES_PER_PAINT, id);
    for (const feature of features) {
      assert.ok(feature.nodes.length > 0 && feature.nodes.length <= MAX_NODES_PER_FEATURE, id);
      assert.ok(feature.stops.length > 0 && feature.stops.length <= 4, id);
      for (const node of feature.nodes) {
        assert.equal(node.length, 6);
        assert.ok(node.every(Number.isFinite), id);
        for (const [x, y] of [[node[0], node[1]], [node[0] + node[2], node[1] + node[3]], [node[0] + node[4], node[1] + node[5]]]) {
          assert.ok(x >= MIN_BOUND && x <= MAX_BOUND && y >= MIN_BOUND && y <= MAX_BOUND, `${id}: control hull (${x},${y})`);
        }
      }
      // The adaptive helper is the backend's geometry seam, not a mock curve.
      for (const [x, y] of featurePolyline(feature.nodes, feature.closed))
        assert.ok(x >= MIN_BOUND && x <= MAX_BOUND && y >= MIN_BOUND && y <= MAX_BOUND, id);
    }
  }
});

test("bokeh centers and nested contours share geometry without shared references", () => {
  for (const id of ["warm-bokeh", "cool-bokeh"]) {
    const { features } = getMultipointPreset(id).multipoint;
    for (let i = 0; i < features.length; i += 3) {
      const [center, shoulder, rim] = features.slice(i, i + 3);
      const [cx, cy] = center.nodes[0];
      assert.equal(center.nodes.length, 1);
      for (const contour of [shoulder, rim]) {
        assert.equal(contour.closed, true);
        assert.equal(contour.twoSided, false);
        assert.equal(contour.nodes.length, 4);
        near([(contour.nodes[0][0] + contour.nodes[2][0]) / 2, (contour.nodes[1][1] + contour.nodes[3][1]) / 2], [cx, cy]);
        near([contour.nodes[0][0] - cx], [contour.nodes[1][1] - cy]);
      }
      assert.ok(shoulder.nodes[0][0] - cx < rim.nodes[0][0] - cx);
      assert.notEqual(center.stops[0].color, shoulder.stops[0].color);
      assert.notEqual(shoulder.stops[0].color, rim.stops[0].color);
    }
  }
  assert.equal(getMultipointPreset("warm-bokeh").multipoint.features.length, 9);
});

test("nonfinite geometry and corrupted presets fail loudly instead of storing NaN", () => {
  const spiral = { cx: 0.5, cy: 0.5, startRadius: 0.1, endRadius: 0.4, turns: 1, phase: 0 };
  const wave = { x0: 0, x1: 1, y: 0.5, amplitude: 0.2, cycles: 1, phase: 0 };
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const key of Object.keys(spiral)) assert.throws(() => spiralNodes({ ...spiral, [key]: value }), /finite/);
    for (const key of Object.keys(wave)) assert.throws(() => waveNodes({ ...wave, [key]: value }), /finite/);
    for (let i = 0; i < 4; i++) {
      const args = [0.5, 0.5, 0.2, 0.3]; args[i] = value;
      assert.throws(() => ellipseNodes(...args), /finite/);
      const sample = [0, 0, 1, 1]; sample[i] = value;
      assert.throws(() => hermiteNodes([sample], 1), /finite/);
    }
    assert.throws(() => hermiteNodes([[0, 0, 1, 1]], value), /finite/);
    for (let component = 0; component < 6; component++) {
      const bad = getMultipointPreset("neon-spiral");
      bad.multipoint.features[0].nodes[0][component] = value;
      assert.throws(() => parsePaint(bad), /finite/);
    }
    for (const field of ["weight", "offset", "color", "rightColor"]) {
      const bad = getMultipointPreset("neon-spiral"), feature = bad.multipoint.features[0];
      if (field === "weight") feature.weight = value;
      else feature.stops[0][field] = field === "offset" ? value : [value, 0, 0, 1];
      assert.throws(() => parsePaint(bad), /finite/);
    }
  }
  assert.throws(() => ellipseNodes(0, 0, 0), /positive/);
  assert.throws(() => ellipseNodes(0, 0, 1, -1), /positive/);
  assert.throws(() => spiralNodes({ ...spiral, turns: 0 }), /nonzero/);
  assert.throws(() => spiralNodes({ ...spiral, startRadius: -1 }), /nonnegative/);
  assert.throws(() => hermiteNodes([], 1), /at least one/);
  assert.throws(() => hermiteNodes([[0, 0, 1, 1]], 0), /positive step/);
  assert.throws(() => hermiteNodes([[0, 0, 1]], 1), /tuples/);
  assert.throws(() => hermiteNodes([[0, 0, Number.MAX_VALUE, 0]], Number.MAX_VALUE), /finite/);
  assert.throws(() => ellipseNodes(Number.MAX_VALUE, 0, Number.MAX_VALUE), /finite/);
});
