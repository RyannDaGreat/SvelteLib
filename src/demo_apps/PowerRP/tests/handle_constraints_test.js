/**
 * THE HANDLE-CONSTRAINT PROTOCOL suite — the sweep that turns a convention into a
 * protocol. Plain node, no framework (suite convention). Run from the SvelteLib
 * repo root or here:
 *   node src/demo_apps/PowerRP/tests/handle_constraints_test.js
 *
 * Every widget's constrained handles now DECLARE their allowed set as a pure
 * projection `constrain(state, desired) → allowed` (core/derive.js), with `apply`
 * reduced to reading an already-allowed point back as a parameter. That split is
 * only worth anything if it holds for EVERY handle in EVERY plugin, so this file
 * enumerates the whole registry and asserts, per handle, per state:
 *
 *   PURE          calling twice gives the same answer, and neither the state nor
 *                 the desired point is mutated.
 *   IDEMPOTENT    constrain(constrain(p)) == constrain(p). A projection must be;
 *                 if one is not, the allowed set is misexpressed.
 *   FIXED POINT   the handle's OWN displayed position is allowed, i.e. it comes
 *                 back unchanged — otherwise the widget draws its handle
 *                 somewhere the widget itself would refuse to put it.
 *   ROUND TRIP    apply(state, allowed) then re-derive: the handle LANDS on
 *                 `allowed`. This is the contract "projection answers WHERE,
 *                 apply answers HOW to store it" stated as an equation, and it is
 *                 what catches an `apply` that silently re-clamps.
 *   NEAREST       no sampled point near the answer is BOTH allowed and strictly
 *                 closer to the desired point. This is the one that catches a
 *                 clamp masquerading as a projection.
 *   PULL          constraintPull == |desired − allowed|, and 0 for an allowed point.
 *
 * EXACTNESS: the projections are metric projections in FLOATING POINT, so a
 * coordinate the constraint does not pin re-rounds through the affine round-trip
 * o + ((p−o)·d/|d|²)·d. The suite therefore asserts to a measured tolerance and
 * PRINTS the worst observed residual, rather than claiming bit-identity it cannot
 * have. Coordinates a constraint DOES pin (a y held to a constant) are exact.
 *
 * DECLARED EXEMPTIONS from NEAREST live in NOT_NEAREST below, each with the reason
 * — an exemption with a reason is honest, a silently skipped invariant is not.
 * They are the finding of this sweep: six handles were never metric projections.
 */

import assert from "node:assert/strict";
import {
  closestPointOnAxisRange, closestPointOnSegment, closestPointInAnnulus, distToSegment,
} from "../core/outline.js";
import { UNCONSTRAINED, modifierWrite, constraintPull, nodeModifierPoints } from "../core/derive.js";
// builtinRoster(), NOT allPlugins. This suite is a PROTOCOL SWEEP over "every
// shipped widget", and allPlugins is only the SOURCE-MODULE half of the roster —
// the batch-1 migration moved donut, progress_bar, number and both clocks into the
// built-in plugin-asset library, so sweeping allPlugins silently stopped covering
// them. The required-coverage assertion below is what caught that; builtinRoster()
// is the fix. See plugins/index.js builtinRoster for the full account.
import { builtinRoster } from "../plugins/index.js";

const roster = builtinRoster();

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// Tolerances. Both are ULP-scale for the magnitudes involved (local px in the
// hundreds, parameters of order 1): the residual comes from the affine
// round-trip described in the header, and the measured worsts are printed at the
// end so a real regression cannot hide behind a loose bound.
const POINT_EPS = 1e-6;   // local px — a millionth of a pixel
const PARAM_EPS = 1e-6;   // parameter units (ratios of order 1, angles in degrees)

/**
 * Handles whose declared map is NOT the metric nearest point, with the reason.
 * Keyed "<type>/<handleId>". Every OTHER invariant is still asserted on them.
 */
const NOT_NEAREST = {
  // A width is a MAGNITUDE and the head is symmetric about the shaft, so crossing
  // the axis widens the far barb by the same amount instead of collapsing to zero:
  // an idempotent mirror RETRACTION onto the +normal ray (plugins/fancy_arrow.js
  // widthRetraction).
  "fancy_arrow/tipWidth": "magnitude mirror onto the +normal ray",
  "fancy_arrow/startWidth": "magnitude mirror onto the +normal ray",
  "fancy_arrow/endWidth": "magnitude mirror onto the +normal ray",
  // A tooth is symmetric about its centre line — same mirror, in angle.
  "ss_gear/toothWidth": "magnitude mirror in angle about the tooth centre line",
  // These two handles are an INNER CORNER: thickening moves them along a diagonal,
  // and the reading is "how thick", a horizontal measurement — so the drag reads x
  // alone and the handle rides the diagonal. An oblique retraction, not the nearest.
  "ss_crossPlus/armThickness": "oblique (x-only) retraction onto a diagonal segment",
  "ss_frame/thickness": "oblique (x-only) retraction onto a diagonal segment",
  // A discrete set: the count is rounded in COUNT, so the chosen rim point is the
  // nearest allowed COUNT rather than the nearest allowed ANGLE. The two differ
  // only in a thin band around each half-integer count.
  "ss_polygonStar/points": "nearest allowed COUNT, not nearest allowed angle",
  // The same discrete set, for the same reason: an iris's blade count is read
  // from the angular gap between two adjacent blade normals and rounded in
  // COUNT, so the rim point chosen is the nearest allowed COUNT.
  "aperture/blades": "nearest allowed COUNT, not nearest allowed angle",
};

/**
 * Handles exempt from ROUND TRIP, with the reason. Only one, and it is a
 * PRE-EXISTING DEFECT this sweep found rather than a design choice — see the
 * KNOWN PRE-EXISTING DEFECT note in plugins/fancy_arrow.js.
 */
const NOT_ROUND_TRIP = {
  "fancy_arrow/tipDimple": "displayed at the renderer's dimple bound but allowed out to tipLength — pre-existing bound mismatch, reported not changed",
  // A DIFFERENT cause, found by this same check: the endWidth handle hangs off the
  // dimple point, and the dimple point's DISPLAY bound depends on endWidth itself
  // (fancyArrowOutline's maxD shrinks as the shaft approaches the head's width). So
  // past a threshold the handle's own anchor slides out from under it as it writes.
  // Characterized exactly by the dedicated test below — it round-trips EXACTLY
  // below the threshold, which is what makes this a bounded defect and not a
  // broken projection.
  "fancy_arrow/endWidth": "its anchor (the dimple point) depends on endWidth itself — exact below the threshold measured below",
};

/**
 * Ellipse-fitted families measure "nearest" in the ellipse's NORMALIZED frame
 * (the same convention donut/circle closestAnchor use: exact when rx === ry), so
 * their NEAREST check runs on SQUARE boxes only. Stated, not skipped.
 */
const ELLIPSE_NORMALIZED = new Set(["ss_radialSweep", "ss_polygonStar", "ss_gear", "aperture"]);

// ── The states every handle is exercised against ──────────────────────────────
// Each entry: an item state. Sizes are ordinary, plus a non-square variant (which
// is where a normalized-frame projection differs from a local-space one) — the
// DEGENERATE zero-extent cases are deliberately not here: a zero-extent widget
// declares no handles at all, or declares one whose allowed set is a single point.
//
// x/y are ALSO concretized here, exactly like w/h: a plugin's own `defaults` may
// leave x/y as an EQUATION (e.g. lens_flare's `"= camera.x"`), which is normal —
// in the real app `modifierPoints` only ever sees a state that has already been
// through evaluateState, never a raw default. Most widgets' apply()/constrain()
// never read x/y at all (COORDINATE SPACE: LOCAL units, always — core/derive.js),
// so this went unnoticed until a widget that maps to WORLD space internally
// (lens_flare's light handle, via core/derive.worldTransform) needed a real
// number there; overriding x/y here closes that gap for every plugin at once
// rather than special-casing one.
//
// lens_flare's OWN lightWorldX/lightWorldY default is likewise an equation (it
// must resolve against ITS box, which only the real app's fold knows) — given a
// concrete world point here, exactly like the `from`/`to` override below gives
// the two-point widgets a concrete pair.
const ENDPOINTS = { from: { x: 120, y: 200 }, to: { x: 420, y: 340 } };
const FLARE_LIGHT = { lightWorldX: 620, lightWorldY: 240 };
const STATE_VARIANTS = [
  (defaults) => ({ ...defaults, x: 0, y: 0, w: 240, h: 180, ...(defaults.from ? ENDPOINTS : {}), ...(defaults.lightWorldX !== undefined ? FLARE_LIGHT : {}) }),
  (defaults) => ({ ...defaults, x: 50, y: -30, w: 200, h: 200, ...(defaults.from ? { from: { x: 60, y: 60 }, to: { x: 260, y: 60 } } : {}), ...(defaults.lightWorldX !== undefined ? FLARE_LIGHT : {}) }),
  (defaults) => ({ ...defaults, x: -100, y: 40, w: 90, h: 300, ...(defaults.from ? { from: { x: 400, y: 90 }, to: { x: 120, y: 300 } } : {}), ...(defaults.lightWorldX !== undefined ? FLARE_LIGHT : {}) }),
];

/** Pure function. Every (plugin, state, handle) triple in the registry that
 *  declares modifier points — the sweep's subject list. */
function handleCases() {
  const out = [];
  for (const plugin of roster) {
    if (!plugin.modifierPoints) continue;
    for (const makeState of STATE_VARIANTS) {
      const state = makeState(plugin.defaults ?? {});
      for (const mp of plugin.modifierPoints(state))
        if (mp.apply) out.push({ type: plugin.type, state, id: mp.id, plugin });
    }
  }
  return out;
}

/** Pure function. A handle re-read from a state (handles are derived, never held:
 *  after a write the list is rebuilt, which is exactly what a consumer does). */
function handleOf(plugin, state, id) {
  const mp = plugin.modifierPoints(state).find((m) => m.id === id);
  return mp && { ...mp, constrain: mp.constrain ?? UNCONSTRAINED };
}

/** Pure function. A ring of probe points around `p` at the given radius — the
 *  neighbourhood the NEAREST check searches for a closer allowed point. */
function ring(p, radius, count = 16) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count;
    out.push({ x: p.x + radius * Math.cos(a), y: p.y + radius * Math.sin(a) });
  }
  return out;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const DESIRED = [
  { x: 0, y: 0 }, { x: 500, y: 40 }, { x: -260, y: 130 }, { x: 130, y: -220 },
  { x: 60, y: 95 }, { x: 205, y: 178 }, { x: 900, y: 900 }, { x: -400, y: 600 },
];

const cases = handleCases();
const worst = { idempotent: 0, fixed: 0, roundTrip: 0, pull: 0 };

test(`registry sweep covers every declared handle (${cases.length} handle×state cases)`, () => {
  assert.ok(cases.length > 40, `expected the whole registry, got ${cases.length}`);
  const types = new Set(cases.map((c) => c.type));
  // THE FLOOR. A sweep over a list can "pass" by covering nothing, so the types it
  // MUST reach are named. This is not belt-and-braces: it is the assertion that
  // caught the batch-1 migration dropping five widgets out of this suite (see the
  // builtinRoster import above). `donut` and `clock_analog` are LIBRARY widgets —
  // naming them here is what pins that builtinRoster() really does include the
  // plugin-asset half, from the consumer's side rather than its own. (progress_bar
  // and number are library widgets too, but declare NO handles, so they correctly
  // have no place in this sweep; the effects/row-kind sweeps are where they land.)
  for (const required of ["donut", "elbow_arrow", "curved_arrow", "fancy_arrow", "clock_analog", "polygon", "demo_lens_flare", "ss_radialSweep"])
    assert.ok(types.has(required), `${required} declares handles but was not swept`);
});

test("PURE: constrain and apply are deterministic and mutate nothing", () => {
  for (const c of cases) {
    const mp = handleOf(c.plugin, c.state, c.id);
    for (const d of DESIRED) {
      const stateBefore = JSON.stringify(c.state);
      const desired = { ...d };
      const a = mp.constrain(c.state, desired);
      const b = mp.constrain(c.state, desired);
      assert.deepEqual(a, b, `${c.type}/${c.id}: constrain is not deterministic`);
      assert.deepEqual(desired, d, `${c.type}/${c.id}: constrain mutated its argument`);
      assert.equal(JSON.stringify(c.state), stateBefore, `${c.type}/${c.id}: constrain mutated the state`);
      mp.apply(c.state, a);
      assert.equal(JSON.stringify(c.state), stateBefore, `${c.type}/${c.id}: apply mutated the state`);
    }
  }
});

test("IDEMPOTENT: constrain(constrain(p)) == constrain(p) for every handle", () => {
  for (const c of cases) {
    const mp = handleOf(c.plugin, c.state, c.id);
    for (const d of DESIRED) {
      const once = mp.constrain(c.state, d);
      const twice = mp.constrain(c.state, once);
      const residual = dist(once, twice);
      worst.idempotent = Math.max(worst.idempotent, residual);
      assert.ok(residual < POINT_EPS, `${c.type}/${c.id}: not idempotent at (${d.x},${d.y}) — moved ${residual}`);
    }
  }
});

test("FIXED POINT: a handle's own displayed position is allowed", () => {
  for (const c of cases) {
    const mp = handleOf(c.plugin, c.state, c.id);
    const here = { x: mp.x, y: mp.y };
    const back = mp.constrain(c.state, here);
    const residual = dist(here, back);
    worst.fixed = Math.max(worst.fixed, residual);
    assert.ok(residual < POINT_EPS, `${c.type}/${c.id}: its OWN position is not allowed — moved ${residual}`);
  }
});

test("ROUND TRIP: apply(state, allowed) puts the handle AT allowed", () => {
  for (const c of cases) {
    if (NOT_ROUND_TRIP[`${c.type}/${c.id}`]) continue;
    const mp = handleOf(c.plugin, c.state, c.id);
    for (const d of DESIRED) {
      const allowed = mp.constrain(c.state, d);
      const next = { ...c.state, ...modifierWrite(mp, c.state, d) };
      const moved = handleOf(c.plugin, next, c.id);
      if (!moved) continue; // the write removed this handle (a count change re-indexes the set)
      const residual = dist(allowed, { x: moved.x, y: moved.y });
      worst.roundTrip = Math.max(worst.roundTrip, residual);
      assert.ok(residual < POINT_EPS, `${c.type}/${c.id}: landed ${residual} from the allowed point at (${d.x},${d.y})`);
    }
  }
});

test("NEAREST: no sampled neighbour is both allowed and strictly closer", () => {
  for (const c of cases) {
    const key = `${c.type}/${c.id}`;
    if (NOT_NEAREST[key]) continue;
    // A normalized-frame projection only coincides with nearest-in-local on a
    // square box, which is exactly the state this check keeps for those families.
    if (ELLIPSE_NORMALIZED.has(c.type) && c.state.w !== c.state.h) continue;
    const mp = handleOf(c.plugin, c.state, c.id);
    for (const d of DESIRED) {
      const allowed = mp.constrain(c.state, d);
      const best = dist(d, allowed);
      for (const radius of [0.5, 5, 40]) {
        for (const probe of ring(allowed, radius)) {
          // `probe` is allowed iff it is its own projection.
          if (dist(probe, mp.constrain(c.state, probe)) > POINT_EPS) continue;
          assert.ok(dist(d, probe) >= best - POINT_EPS,
            `${key}: an allowed point (${probe.x},${probe.y}) is closer to (${d.x},${d.y}) than the projection — ${dist(d, probe)} < ${best}`);
        }
      }
    }
  }
});

test("PULL: constraintPull is the distance the constraint moved the point", () => {
  for (const c of cases) {
    const mp = handleOf(c.plugin, c.state, c.id);
    for (const d of DESIRED) {
      const allowed = mp.constrain(c.state, d);
      const residual = Math.abs(constraintPull(mp, c.state, d) - dist(d, allowed));
      worst.pull = Math.max(worst.pull, residual);
      assert.ok(residual < POINT_EPS, `${c.type}/${c.id}: pull disagrees with |p − constrain(p)|`);
      assert.ok(constraintPull(mp, c.state, allowed) < POINT_EPS, `${c.type}/${c.id}: an allowed point still reports pull`);
    }
  }
});

test("UNCONSTRAINED is the default, supplied once by nodeModifierPoints", () => {
  const node = { world: { x: 0, y: 0, rotation: 0, scale: 1 }, state: {}, plugin: { modifierPoints: () => [{ id: "free", x: 1, y: 2 }] } };
  const [mp] = nodeModifierPoints(node);
  assert.equal(mp.constrain, UNCONSTRAINED);
  assert.deepEqual(mp.constrain({}, { x: 7, y: 9 }), { x: 7, y: 9 });
  assert.equal(constraintPull(mp, {}, { x: 7, y: 9 }), 0);
  // A handle that declares one keeps it.
  const pinned = (s, p) => ({ x: p.x, y: 0 });
  assert.equal(nodeModifierPoints({ ...node, plugin: { modifierPoints: () => [{ id: "p", x: 0, y: 0, constrain: pinned }] } })[0].constrain, pinned);
});

test("modifierWrite composes the two hooks in the one documented order", () => {
  const mp = { constrain: (s, p) => ({ x: p.x, y: 0 }), apply: (s, p) => ({ v: p.y }) };
  assert.deepEqual(modifierWrite(mp, {}, { x: 5, y: 99 }), { v: 0 }); // the constraint removed the y before apply saw it
});

// ── the core projection primitives ───────────────────────────────────────────
test("closestPointOnAxisRange: line, ray, segment, degenerate direction", () => {
  assert.deepEqual(closestPointOnAxisRange({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 30, y: 5 }), { x: 30, y: 0 });
  assert.deepEqual(closestPointOnAxisRange({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -8, y: 5 }, 0), { x: 0, y: 0 });
  assert.deepEqual(closestPointOnAxisRange({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 40, y: 5 }, 0, 1), { x: 10, y: 0 });
  assert.deepEqual(closestPointOnAxisRange({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 9, y: 9 }), { x: 3, y: 4 });
});

test("closestPointOnSegment: foot of the perpendicular, clamped; distToSegment shares it", () => {
  assert.deepEqual(closestPointOnSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 7 }), { x: 4, y: 0 });
  assert.deepEqual(closestPointOnSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: -6, y: 3 }), { x: 0, y: 0 });
  assert.deepEqual(closestPointOnSegment({ x: 2, y: 2 }, { x: 2, y: 2 }, { x: 9, y: 9 }), { x: 2, y: 2 });
  assert.equal(distToSegment(0, 5, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(distToSegment(-3, 0, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
});

test("closestPointInAnnulus: radial clamp, exact inside, explicit centre fallback", () => {
  assert.deepEqual(closestPointInAnnulus({ x: 0, y: 0 }, 2, 10, { x: 100, y: 0 }, { x: 1, y: 0 }), { x: 10, y: 0 });
  assert.deepEqual(closestPointInAnnulus({ x: 0, y: 0 }, 2, 10, { x: 0.6, y: 0.8 }, { x: 1, y: 0 }), { x: 1.2, y: 1.6 });
  assert.deepEqual(closestPointInAnnulus({ x: 0, y: 0 }, 2, 10, { x: 3, y: 4 }, { x: 1, y: 0 }), { x: 3, y: 4 });
  assert.deepEqual(closestPointInAnnulus({ x: 5, y: 5 }, 2, 10, { x: 5, y: 5 }, { x: 0, y: 1 }), { x: 5, y: 7 });
});

test("CROSS-DEPENDENT SET: fancy_arrow/endWidth round-trips below its threshold", () => {
  // The one handle whose allowed set moves as it writes (see NOT_ROUND_TRIP). The
  // coupling is through the renderer's dimple bound tipLength·(1 − halfEnd/halfTip):
  // while it still admits the stored tipDimple, the anchor is stationary and the
  // round trip is EXACT. Defaults tipLength 15, tipWidth 30, tipDimple 5 put that
  // threshold at endWidth 20 — below it the handle lands where the drag left it,
  // above it the anchor slides. Asserting BOTH sides is what makes the exemption a
  // measured bound rather than a shrug.
  const arrow = roster.find((p) => p.type === "fancy_arrow");
  const state = { ...arrow.defaults, from: { x: 100, y: 300 }, to: { x: 400, y: 300 } };
  const landing = (targetWidth) => {
    const mp = handleOf(arrow, state, "endWidth");
    const desired = { x: mp.x, y: 300 + targetWidth / 2 }; // +normal side, half-width out
    const allowed = mp.constrain(state, desired);
    const next = { ...state, ...modifierWrite(mp, state, desired) };
    const moved = handleOf(arrow, next, "endWidth");
    return { drift: dist(allowed, { x: moved.x, y: moved.y }), written: next.endWidth };
  };
  const below = landing(18);
  assert.ok(Math.abs(below.written - 18) < PARAM_EPS, `expected endWidth 18, got ${below.written}`);
  assert.ok(below.drift < POINT_EPS, `below the threshold the handle must land exactly — drifted ${below.drift}`);
  const above = landing(60);
  assert.ok(Math.abs(above.written - 60) < PARAM_EPS, `expected endWidth 60, got ${above.written}`);
  assert.ok(above.drift > 1, `above the threshold the anchor is expected to slide — drift was only ${above.drift}`);
});

test("MULTI-HANDLE DRAG: one shared delta, INDEPENDENT projections", () => {
  // A polygon vertex is free and a donut's inner radius is not; the same local delta
  // must move the free one exactly and the constrained one only along its own
  // trajectory. That divergence is the constraint working, not drift.
  const donut = roster.find((p) => p.type === "donut"), poly = roster.find((p) => p.type === "polygon");
  const dState = { ...donut.defaults, w: 140, h: 140, inner: 0.5 };
  const dMp = handleOf(donut, dState, "inner");
  const delta = { x: 20, y: 37 };
  const moved = dMp.constrain(dState, { x: dMp.x + delta.x, y: dMp.y + delta.y });
  assert.ok(Math.abs(moved.y - dMp.y) < POINT_EPS, "the donut handle must not follow the y delta");
  assert.ok(Math.abs(moved.x - (dMp.x + delta.x)) < POINT_EPS, "the donut handle must follow the x delta exactly");
  const pState = { ...poly.defaults, w: 200, h: 150, points: [[0, 0], [1, 0], [0.5, 1]] };
  const pMp = handleOf(poly, pState, "p1");
  const pMoved = pMp.constrain(pState, { x: pMp.x + delta.x, y: pMp.y + delta.y });
  assert.deepEqual(pMoved, { x: pMp.x + delta.x, y: pMp.y + delta.y }, "a free vertex must follow the whole delta");
});

console.log(`\n  measured worst residuals (local px): idempotent ${worst.idempotent.toExponential(2)}  fixed-point ${worst.fixed.toExponential(2)}  round-trip ${worst.roundTrip.toExponential(2)}  pull ${worst.pull.toExponential(2)}`);
console.log(`  ${Object.keys(NOT_NEAREST).length} declared NEAREST exemptions, ${Object.keys(NOT_ROUND_TRIP).length} declared ROUND-TRIP exemption`);
console.log(`\nhandle_constraints_test: ${passed} tests passed over ${cases.length} handle×state cases (PARAM_EPS ${PARAM_EPS})`);
