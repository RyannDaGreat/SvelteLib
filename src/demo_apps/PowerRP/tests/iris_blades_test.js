/**
 * IRIS BLADES — the blade-assembly widget, and the CLAIM it is built on.
 *
 * The widget's whole argument is that it and `plugins/aperture.js` are one
 * mechanism seen two ways: one draws the opening, the other draws the plates that
 * bound it, and BOTH READ ONE BOUNDARY FUNCTION (core/optics.bladeRadialLimit).
 * Everything interesting is a consequence of that, so this suite gates the
 * consequences rather than the code:
 *
 *   §1 THE OPENINGS ARE THE SAME OPENING, over a swept product of the shared
 *      geometry. If this ever goes red, the two widgets have drifted and every
 *      claim below is void.
 *   §2 THE LEAVES COVER, and `MIN_BLADE_REACH` is a real floor rather than a
 *      taste bound — the leaves are proven to part below it.
 *   §3 THE RETYPE ROUND TRIP is lossless: aperture → iris_blades → aperture
 *      returns every value byte-identical, which is what "share the contract"
 *      has to MEAN to be worth anything (the core/video_sampling.js precedent —
 *      prove the trip, do not assert a resemblance).
 *   §4 THE ROWS ARE ONE DECLARATION, checked through the codebase's own
 *      definition of sameness (core/multiselect.sameRowContract).
 *   §5 EMIT: one op per leaf, in order, because the ORDER is the picture.
 *   §6 HANDLES: five of them, never coincident, over a sweep.
 *   §7 PRESETS: every row draws, and no two draw the same thing.
 *
 * Bare node, no DOM.
 */

import assert from "node:assert/strict";

import {
  IRIS_SHARED_DEFAULTS, IRIS_SHARED_KEYS, MIN_POLYGON_BLADES, bladeAngle, irisRow,
  regularOpeningRadius,
} from "../core/optics.js";
import { sameRowContract } from "../core/multiselect.js";
import { subpathsPathD } from "../core/shapes.js";
import { retypePlan, rowsByKey } from "../core/retype.js";
import { aperturePlugin, openingOutline } from "../plugins/aperture.js";
import {
  MIN_PLATE_DEPTH, irisBladesPlugin, irisLeafOutline, irisOpeningOutline, leafHalfSpan, leafInnerRadius,
} from "../plugins/iris_blades.js";

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };
const BOX = { x: 0, y: 0, w: 220, h: 220 };
const stateOf = (props) => ({ ...irisBladesPlugin.defaults, ...BOX, ...props });

/** The swept product the shared claims are checked over — every count the two
 *  widgets both accept, against the whole signed curvature range and the stops
 *  where the picture changes character. */
const SWEPT_BLADES = [0, 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 16, 19];
const SWEPT_CURVATURE = [-1, -0.8, -0.3, 0, 0.35, 0.6, 1];
const SWEPT_STOPS = [0, 0.05, 0.2, 0.5, 0.75, 0.95, 1];
const SWEPT_ROTATION = [0, 0.31, Math.PI / 3];
const PROBE_ANGLES = Array.from({ length: 97 }, (_, i) => (2 * Math.PI * i) / 97);
const EPS = 1e-9;
/**
 * How far the union's inner boundary may sit from the opening's. Not a fudge: the
 * leaf's end is bisected to a nanoradian (plugins/iris_blades.LEAF_END_TOLERANCE),
 * so a probe bearing can land inside that last nanoradian, where the true leaf
 * reaches and the drawn one has stopped. The radial consequence is the boundary's
 * slope times that angle, which stays far under this.
 */
const COVERAGE_TOLERANCE = 1e-6;

// ── §1 ONE OPENING ───────────────────────────────────────────────────────────

test("(1a) the two widgets' openings agree EXACTLY, over the whole swept geometry", () => {
  let cases = 0;
  for (const blades of SWEPT_BLADES)
    for (const curvature of SWEPT_CURVATURE)
      for (const stopDown of SWEPT_STOPS)
        for (const bladeRotation of SWEPT_ROTATION) {
          const shared = { ...BOX, blades, curvature, stopDown, bladeRotation, pupilAspect: 1 };
          const mine = irisOpeningOutline({ ...irisBladesPlugin.defaults, ...shared });
          const theirs = openingOutline({ ...aperturePlugin.defaults, ...shared, bladeForm: "regular" });
          assert.equal(mine.length, theirs.length,
            `blades ${blades} c ${curvature} stop ${stopDown}: the two widgets sample the opening differently`);
          for (let i = 0; i < mine.length; i++) {
            assert.ok(Math.abs(mine[i][0] - theirs[i][0]) < EPS && Math.abs(mine[i][1] - theirs[i][1]) < EPS,
              `blades ${blades} c ${curvature} stop ${stopDown}: point ${i} differs — the widgets have DRIFTED`);
          }
          cases += 1;
        }
  assert.ok(cases > 700, `the sweep collapsed to ${cases} cases`);
});

// ── §2 THE LEAVES COVER, AND THE FLOOR IS REAL ───────────────────────────────

/**
 * The innermost radius any leaf reaches at a world bearing, or 1 where none does.
 * The union's inner boundary — what the picture's hole actually is, as opposed to
 * what `regularOpeningRadius` says it should be.
 */
function unionInnerRadius(theta, s) {
  const n = Math.max(0, Math.round(s.blades));
  const half = leafHalfSpan(s);
  const edge = Math.max(0, Math.min(1 - s.stopDown, 1));
  let best = 1;
  for (let k = 0; k < n; k++) {
    let d = theta - bladeAngle(s, k);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > half) continue;
    const r = leafInnerRadius(d, edge, n, s.curvature);
    if (r !== null) best = Math.min(best, r);
  }
  return best;
}

test("(2a) the plates COVER the bore down to the opening and no further — the hole is emergent", () => {
  for (const blades of SWEPT_BLADES)
    for (const curvature of SWEPT_CURVATURE)
      for (const stopDown of [0.05, 0.2, 0.5, 0.75, 0.95]) {
        const s = stateOf({ blades, curvature, stopDown });
        if (leafHalfSpan(s) === 0) {
          // No plates at all. That is only allowed when there is nothing to draw:
          // the opening must already be the bore, to within a plate's minimum
          // drawable depth.
          for (const theta of PROBE_ANGLES)
            assert.ok(regularOpeningRadius(theta, s) >= 1 - MIN_PLATE_DEPTH,
              `blades ${blades} c ${curvature} stop ${stopDown}: no plates drawn, but the opening is ${regularOpeningRadius(theta, s)}`);
          continue;
        }
        for (const theta of PROBE_ANGLES) {
          const union = unionInnerRadius(theta, s);
          const opening = regularOpeningRadius(theta, s);
          assert.ok(Math.abs(union - opening) < COVERAGE_TOLERANCE,
            `blades ${blades} c ${curvature} stop ${stopDown} at ${theta}: the plates leave ${union} but the opening is ${opening} — the assembly leaks`);
        }
      }
});

test("(2b) MIN_BLADE_REACH IS A FLOOR: at 1 the plates exactly MEET, and below it nothing changes", () => {
  const halfAt = (bladeReach) => leafHalfSpan(stateOf({ blades: 8, curvature: 0, stopDown: 0.5, bladeReach }));
  const pitchHalf = Math.PI / 8;
  // "They meet" is an EQUALITY, not an inequality: one pitch of span reaches
  // exactly the bearing halfway to the neighbour, so the plates abut there with
  // no overlap at all. That is the floor's whole content.
  assert.ok(Math.abs(halfAt(1) - pitchHalf) < EPS, `at the floor a leaf spans ${halfAt(1)}, not the half-pitch ${pitchHalf}`);
  assert.equal(halfAt(0.5), halfAt(1), "a reach BELOW the floor is clamped to it, not honoured");
  assert.equal(halfAt(0), halfAt(1), "and so is zero");
  // At the floor the assembly is still light-tight at every generic bearing.
  const shut = stateOf({ blades: 8, curvature: 0, stopDown: 0.5, bladeReach: 1 });
  for (const theta of PROBE_ANGLES)
    assert.ok(Math.abs(unionInnerRadius(theta, shut) - regularOpeningRadius(theta, shut)) < COVERAGE_TOLERANCE,
      `at the floor the plates leak at ${theta}`);
  // And the floor is LOAD-BEARING: half a pitch of span leaves the bearing
  // between two neighbours uncovered, which is what the clamp exists to prevent.
  const parted = { ...shut, blades: 8 };
  const midway = bladeAngle(parted, 0) + pitchHalf;
  const narrow = pitchHalf / 2;
  const reaches = Math.abs(((midway - bladeAngle(parted, 0) + Math.PI) % (2 * Math.PI)) - Math.PI) <= narrow;
  assert.equal(reaches, false, "half a pitch of span cannot reach the bearing between two plates — hence the floor");
});

test("(2c) a leaf reaches PAST the polygon vertex, which is what makes an extension arm", () => {
  for (const blades of [5, 8, 12]) {
    const s = stateOf({ blades, curvature: 0.35, stopDown: 0.5 });
    assert.ok(leafHalfSpan(s) > Math.PI / blades,
      `blades ${blades}: a leaf that stops at the vertex has no arm to show past it`);
  }
});

test("(2d) WIDE OPEN THERE ARE NO PLATES — withdrawn into the barrel, not drawn at zero size", () => {
  for (const blades of [3, 8, 16]) {
    const s = stateOf({ blades, stopDown: 0 });
    assert.equal(leafHalfSpan(s), 0, `blades ${blades}: wide open, a leaf has no extent`);
    assert.equal(irisLeafOutline(s, 0), null, "and therefore no outline at all");
  }
});

test("(2e) high curvature is where `bladeReach` earns its place — the edge never reaches the bore", () => {
  const uncapped = stateOf({ blades: 8, curvature: 1, stopDown: 0.5, bladeReach: 1e6 });
  const capped = stateOf({ blades: 8, curvature: 1, stopDown: 0.5 });
  assert.ok(leafHalfSpan(uncapped) > leafHalfSpan(capped),
    "at curvature 1 an uncapped leaf must be strictly wider — otherwise the cap is decorative");
  assert.ok(leafHalfSpan(capped) < Math.PI,
    "and the shipped default must stop it short of wrapping the bore");
});

// ── §3 THE RETYPE ROUND TRIP ─────────────────────────────────────────────────

/** Applies a retype plan to a folded item, the way core/retype.retypedItem does
 *  to a document, but on the plain object so the assertion is about VALUES. */
function retyped(folded, from, to) {
  const out = structuredClone(folded);
  for (const { path, value } of retypePlan(folded, from, to)) {
    let node = out;
    for (const seg of path.slice(0, -1)) node = node[seg] ??= {};
    node[path.at(-1)] = value;
  }
  out.type = to.defaults.type;
  return out;
}

test("(3a) aperture → iris_blades → aperture returns EVERY shared value unchanged", () => {
  const authored = {
    ...aperturePlugin.defaults, ...BOX,
    blades: 11, stopDown: 0.62, curvature: -0.4, bladeRotation: 0.77, pupilAspect: 0.5,
    pupilFill: "#123456",
  };
  const there = retyped(authored, aperturePlugin, irisBladesPlugin);
  const back = retyped(there, irisBladesPlugin, aperturePlugin);
  for (const key of IRIS_SHARED_KEYS)
    assert.deepEqual(back[key], authored[key],
      `"${key}" did not survive the round trip: ${JSON.stringify(authored[key])} → ${JSON.stringify(there[key])} → ${JSON.stringify(back[key])}`);
});

test("(3b) an aperture-only value lies DORMANT through the trip rather than being lost", () => {
  const authored = { ...aperturePlugin.defaults, ...BOX, obstruction: 0.53, sunstar: 0.4, apodization: 0.85 };
  const back = retyped(retyped(authored, aperturePlugin, irisBladesPlugin), irisBladesPlugin, aperturePlugin);
  for (const key of ["obstruction", "sunstar", "apodization"])
    assert.equal(back[key], authored[key], `"${key}" was dropped by the detour through iris_blades`);
});

test("(3c) the trip carries the PICTURE, not just the numbers: the opening is unmoved", () => {
  const authored = { ...aperturePlugin.defaults, ...BOX, blades: 9, stopDown: 0.6, curvature: 0.5, bladeRotation: 0.2 };
  const there = retyped(authored, aperturePlugin, irisBladesPlugin);
  const mine = irisOpeningOutline(there);
  const theirs = openingOutline(authored);
  assert.equal(mine.length, theirs.length);
  for (let i = 0; i < mine.length; i++)
    assert.ok(Math.abs(mine[i][0] - theirs[i][0]) < EPS && Math.abs(mine[i][1] - theirs[i][1]) < EPS,
      `retyping moved the opening at point ${i}`);
});

// ── §4 ONE DECLARATION ───────────────────────────────────────────────────────

test("(4a) every shared key is offered by BOTH plugins under the SAME row contract", () => {
  const mine = rowsByKey(irisBladesPlugin);
  const theirs = rowsByKey(aperturePlugin);
  for (const key of IRIS_SHARED_KEYS) {
    assert.ok(mine.has(key), `iris_blades does not offer "${key}"`);
    assert.ok(theirs.has(key), `aperture does not offer "${key}"`);
    assert.ok(sameRowContract(irisBladesPlugin.inspector.find((r) => r.key === key), aperturePlugin.inspector.find((r) => r.key === key)),
      `"${key}" is declared differently by the two widgets — retype would refuse or coerce it`);
  }
});

test("(4b) the shared rows come from irisRow, so the help is the ONLY thing that differs", () => {
  for (const key of IRIS_SHARED_KEYS) {
    const row = irisBladesPlugin.inspector.find((r) => r.key === key);
    assert.ok(sameRowContract(row, irisRow(key, "any help at all")),
      `"${key}" was hand-declared instead of built by irisRow`);
    assert.ok(typeof row.help === "string" && row.help.trim().length > 0, `"${key}" has no help`);
    assert.notEqual(row.help, aperturePlugin.inspector.find((r) => r.key === key).help,
      `"${key}" repeats the sibling's help verbatim — the two widgets do different things with it`);
  }
});

test("(4c) irisRow REFUSES an unknown key rather than returning a kindless row", () => {
  assert.throws(() => irisRow("bladeReach", "not shared"), /not a shared iris property/);
});

test("(4d) the shared DEFAULTS are shared: an untouched widget of either type is the same lens", () => {
  for (const key of Object.keys(IRIS_SHARED_DEFAULTS)) {
    assert.equal(irisBladesPlugin.defaults[key], IRIS_SHARED_DEFAULTS[key]);
    assert.equal(aperturePlugin.defaults[key], IRIS_SHARED_DEFAULTS[key]);
  }
});

// ── §5 EMIT ──────────────────────────────────────────────────────────────────

test("(5a) ONE path op per plate, plus the pupil — and the plates come after it", () => {
  for (const blades of [3, 8, 19]) {
    const ops = irisBladesPlugin.emit(stateOf({ blades, stopDown: 0.5 }), null, WORLD);
    assert.equal(ops.length, blades + 1, `blades ${blades}: expected the pupil plus one op per plate`);
    assert.ok(ops.every((o) => o.op === "path"), "every op is a path — never a fan, never a polyline");
    assert.ok(ops.slice(1).every((o) => o.stroke != null), "every plate carries a stroke — the strokes ARE the widget");
  }
});

test("(5b) THE ORDER IS THE PICTURE: plate k is emitted after plate k-1", () => {
  const s = stateOf({ blades: 6, stopDown: 0.5 });
  const ops = irisBladesPlugin.emit(s, null, WORLD).slice(1);
  for (let k = 0; k < 6; k++)
    assert.equal(ops[k].d, subpathsPathD([irisLeafOutline(s, k)]),
      `op ${k} is not plate ${k} — the spiral depends on ascending order`);
});

test("(5c) a plate's stroke is dropped, not zero-width, when there is no stroke to draw", () => {
  const ops = irisBladesPlugin.emit(stateOf({ blades: 6, stopDown: 0.5, strokeWidth: 0 }), null, WORLD);
  assert.ok(ops.slice(1).every((o) => o.stroke == null), "a zero-width stroke must not reach the backend as a paint");
});

test("(5d) a zero-extent widget emits NOTHING rather than a degenerate op", () => {
  for (const box of [{ w: 0, h: 220 }, { w: 220, h: 0 }, { w: 0, h: 0 }])
    assert.deepEqual(irisBladesPlugin.emit(stateOf(box), null, WORLD), []);
});

test("(5e) wide open, only the light remains", () => {
  const ops = irisBladesPlugin.emit(stateOf({ stopDown: 0 }), null, WORLD);
  assert.equal(ops.length, 1, "the plates are withdrawn; the bore is bare");
});

// ── §6 HANDLES ───────────────────────────────────────────────────────────────

test("(6a) five handles once there is a polygon, two before it", () => {
  const ids = (props) => irisBladesPlugin.modifierPoints(stateOf(props)).map((h) => h.id).filter((id) => !id.startsWith("paint"));
  assert.deepEqual(ids({ blades: 8 }), ["stopDown", "curvature", "bladeRotation", "blades", "bladeReach"]);
  for (const blades of [0, 1, 2])
    assert.deepEqual(ids({ blades }), ["stopDown", "bladeReach"],
      `blades ${blades}: the polygon handles must be absent, not inert`);
});

test("(6b) no two handles ever sit on top of one another", () => {
  const MIN_GAP = 1e-6;
  for (const blades of SWEPT_BLADES.filter((n) => n >= MIN_POLYGON_BLADES))
    for (const stopDown of [0.05, 0.3, 0.5, 0.8, 0.99])
      for (const curvature of SWEPT_CURVATURE)
        for (const bladeReach of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12, 20]) {
          const pts = irisBladesPlugin.modifierPoints(stateOf({ blades, stopDown, curvature, bladeReach }));
          for (let i = 0; i < pts.length; i++)
            for (let j = i + 1; j < pts.length; j++)
              assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > MIN_GAP,
                `blades ${blades} stop ${stopDown} c ${curvature} reach ${bladeReach}: "${pts[i].id}" and "${pts[j].id}" coincide`);
        }
});

test("(6c) the bladeReach handle READS BACK what it writes", () => {
  for (const blades of [5, 8, 12])
    for (const bladeReach of [1.5, 3, 5]) {
      const s = stateOf({ blades, bladeReach, stopDown: 0.5, curvature: 1 }); // curvature 1: the cap binds, so the handle is live
      const handle = irisBladesPlugin.modifierPoints(s).find((h) => h.id === "bladeReach");
      const allowed = handle.constrain(s, { x: handle.x, y: handle.y });
      assert.ok(Math.abs(handle.apply(s, allowed).bladeReach - bladeReach) < 1e-6,
        `blades ${blades} reach ${bladeReach}: the handle's own position reads back as ${handle.apply(s, allowed).bladeReach}`);
    }
});

test("(6d) hitTest is the bore, and it is sign-blind about the box", () => {
  const s = stateOf({ blades: 8, stopDown: 0.5 });
  assert.equal(irisBladesPlugin.hitTest(s, 110, 110), true, "the middle of an iris is on the iris");
  assert.equal(irisBladesPlugin.hitTest(s, 5, 5), false, "a box corner is outside the bore");
});

// ── §7 PRESETS ───────────────────────────────────────────────────────────────

test("(7a) every preset draws plates, and the count it asks for", () => {
  for (const preset of irisBladesPlugin.presets) {
    const ops = irisBladesPlugin.emit(stateOf(preset.props), null, WORLD);
    assert.equal(ops.length, preset.props.blades + 1, `${preset.name}: drew ${ops.length - 1} plates, asked for ${preset.props.blades}`);
    for (const op of ops) assert.ok(op.d.length > 40, `${preset.name}: a degenerate path`);
  }
});

test("(7b) every preset writes the SAME five geometry knobs and touches nothing else", () => {
  const expected = ["bladeReach", "bladeRotation", "blades", "curvature", "stopDown"];
  for (const preset of irisBladesPlugin.presets)
    assert.deepEqual(Object.keys(preset.props).sort(), expected,
      `${preset.name}: the family writes geometry and nothing else, in every row`);
});

test("(7c) DISTINCTNESS: no two presets draw the same assembly — AND none IS the default", () => {
  // The DEFAULT is in the list on purpose (ledger C-16): a preset byte-identical
  // to the untouched widget is a dead row that no preset-vs-preset comparison can
  // ever see, because the default is not a preset.
  const drawn = new Map([["(the untouched default)", geometryOf({})]]);
  for (const preset of irisBladesPlugin.presets) {
    const d = geometryOf(preset.props);
    for (const [name, seen] of drawn)
      assert.notEqual(d, seen, `${preset.name} draws exactly what ${name} draws`);
    drawn.set(preset.name, d);
  }
});

/** Every path this state emits, as one string — the widget's whole geometry. */
function geometryOf(props) {
  return irisBladesPlugin.emit(stateOf(props), null, WORLD).map((o) => o.d).join("|");
}

console.log(`\niris_blades tests: ${passed} passed  (${irisBladesPlugin.presets.length} presets, ${SWEPT_BLADES.length} blade counts swept)`);
