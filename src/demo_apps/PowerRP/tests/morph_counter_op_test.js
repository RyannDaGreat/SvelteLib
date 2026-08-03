/**
 * THE COUNTER LAW, AT THE OP LEVEL — workstream AM.
 * Run: node src/demo_apps/PowerRP/tests/morph_counter_op_test.js
 *
 * USER BUG (2026-08-02, verbatim, with a screenshot of a Σ … = π²/6 equation
 * mid-tween where the ∞ rendered as two solid dots and the 6's counter was
 * filled): "why does the number 6, the hole gets filled in in the middle of
 * morphing? As does infinity. Why is this? Can you please debug that and fix
 * that?"
 *
 * ── WHY THIS SUITE EXISTS ALONGSIDE morph_hole_test.js ───────────────────────
 * That suite pins the fill rule, and it was GREEN throughout this bug. It had to
 * be: it asks `morphPaths` for a payload and judges the payload's own ink under
 * the payload's own `fillRule`, and at that level everything was already correct.
 * The defect was one level down, at the seam that turns a payload into DRAW
 * COMMANDS — `render_gpu/ports.js morphIR` emitted one path op PER SUBPATH, so a
 * glyph's outer and its counter were never in the same path. A fill rule is a
 * property of a WHOLE path; split across two ops it can express nothing, and the
 * painter filled the outer solid and then filled the counter solid on top of it
 * in the same ink. Measured on "6" → "8" before the fix: ZERO hole pixels at
 * every alpha, under either rule.
 *
 * SO THE LAW IS STATED ON THE OPS, not on the payload. That is the whole point of
 * the suite: a payload-level assertion is exactly the assertion that could not
 * see this.
 *
 * THE LAW: a counter that is a hole at BOTH endpoints is a hole at every alpha.
 * (The user's sentence, mechanically. Pieces legitimately merging or splitting
 * may do what they must between; a paired hole → hole never fills.)
 *
 * Bare node, no fonts: the glyphs here are hand-built polygon payloads handed
 * straight to `morphIR`, so this suite runs in the gate with no font files, no
 * MathJax and no browser. The real-font version of the same measurement lives in
 * the workstream's report; a font would make this a test of Inter, not of ports.
 */

import assert from "node:assert/strict";
import { morphIR, morphPaintRuns } from "../render_gpu/ports.js";
import { shoelaceWinding } from "../core/morph_geometry.js";
import { hasSameWindingOverlap } from "../core/morph_fill.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── FIXTURES ─────────────────────────────────────────────────────────────────

/** Test helper. A closed polygon as straight cubics, in box-local coordinates. */
function poly(points) {
  const curves = [];
  const ring = [...points, points[0]];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i - 1], q = ring[i];
    curves.push([
      p[0] + (q[0] - p[0]) / 3, p[1] + (q[1] - p[1]) / 3,
      p[0] + (2 * (q[0] - p[0])) / 3, p[1] + (2 * (q[1] - p[1])) / 3,
      q[0], q[1],
    ]);
  }
  const sp = { start: [points[0][0], points[0][1]], curves, closed: true };
  sp.winding = shoelaceWinding(sp);
  return sp;
}

/** Test helper. An n-gon; `clockwise` false makes it a COUNTER (winding -1). */
function ngon(cx, cy, r, n, clockwise) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (clockwise ? 1 : -1) * (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return poly(pts);
}

const INK = { fill: "#101010", stroke: null, strokeWidth: 0, opacity: 1 };

/** Test helper. A glyph payload: an outer with a counter punched out of it,
 * both carrying the SAME ink — a letter, an equation, any single-inked text. */
function glyphPayload(cx, cy, r) {
  const outer = { ...ngon(cx, cy, r, 10, true), paint: INK };
  const counter = { ...ngon(cx, cy + r * 0.3, r * 0.4, 10, false), paint: INK };
  return { space: { w: 1, h: 1 }, fillRule: "nonzero", subpaths: [outer, counter] };
}

/** Test helper. A plugin stub whose morphPaths returns a fixed payload. */
const pluginFor = (payload) => ({ morphPaths: () => payload });

/** Test helper. A derive node carrying a `.morph` mark, as ports expects one. */
function morphNode(from, to, t) {
  return {
    type: "shape",
    state: { w: 100, h: 100 },
    morph: {
      fromPlugin: pluginFor(from), toPlugin: pluginFor(to),
      fromState: {}, toState: {}, t, matchPieces: true,
    },
  };
}

// ── INK, JUDGED FROM THE OPS ─────────────────────────────────────────────────

/** Test helper. One op's `d` flattened into rings of points. Written out here
 * rather than imported so this suite is an INDEPENDENT judge of the ink: a bug
 * in the engine's own containment helpers cannot make it agree by construction. */
function ringsOfD(d) {
  const out = [];
  let cur = null, pen = [0, 0];
  for (const m of d.matchAll(/([MCZ])([^MCZ]*)/g)) {
    const nums = (m[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) || []).map(Number);
    if (m[1] === "M") {
      if (cur && cur.length) out.push(cur);
      cur = [[nums[0], nums[1]]];
      pen = [nums[0], nums[1]];
    } else if (m[1] === "C") {
      for (let i = 0; i + 5 < nums.length; i += 6) {
        const [x1, y1, x2, y2, x, y] = nums.slice(i, i + 6);
        for (let k = 1; k <= 8; k++) {
          const s = k / 8, u = 1 - s;
          cur.push([
            u * u * u * pen[0] + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x,
            u * u * u * pen[1] + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y,
          ]);
        }
        pen = [x, y];
      }
    }
  }
  if (cur && cur.length) out.push(cur);
  return out;
}

/** Test helper. Even-odd crossing count — "is this point inside this ring". */
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Test helper. A ring's own winding sign, from its sampled points. */
function ringSign(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a >= 0 ? 1 : -1;
}

/** Test helper. Does ONE op paint this point, under its own declared fill rule? */
function opPaints(op, pt) {
  const rings = ringsOfD(op.d);
  if (op.fillRule === "evenodd") {
    let inside = false;
    for (const r of rings) if (inRing(pt, r)) inside = !inside;
    return inside;
  }
  let wind = 0;
  for (const r of rings) if (inRing(pt, r)) wind += ringSign(r);
  return wind !== 0;
}

/** Test helper. THE PAINTER'S ANSWER: ops are drawn in order, each over the
 * last, so a point is ink if ANY op paints it. This is the seam the payload-level
 * suite cannot see, and it is where the bug lived. */
const painted = (ops, pt) => ops.some((op) => opPaints(op, pt));

/** Test helper. The centre of the op-space counter — found from the ops
 * themselves, because the counter TRAVELS and a fixed point would miss it. */
function counterCentre(ops) {
  const rings = ops.flatMap((op) => ringsOfD(op.d));
  const inner = rings.filter((r) => ringSign(r) < 0);
  assert.ok(inner.length, "the ops must still contain a negative contour");
  const r = inner[0];
  return [
    r.reduce((a, p) => a + p[0], 0) / r.length,
    r.reduce((a, p) => a + p[1], 0) / r.length,
  ];
}

// ── THE LAW ──────────────────────────────────────────────────────────────────

test("LAW: a counter that is a hole at both endpoints is a hole at EVERY alpha", () => {
  // THE USER'S PICTURE, as an assertion, at the op level. Two glyphs, each an
  // outer with a counter, at different places; the morph slides one into the
  // other. The counter's own centre must never be painted, at any alpha.
  //
  // BEFORE THE FIX this failed at the FIRST alpha and at every alpha after it,
  // because morphIR emitted the outer and the counter as two separate ops and the
  // counter was simply filled solid.
  const from = glyphPayload(0.3, 0.5, 0.22);
  const to = glyphPayload(0.7, 0.5, 0.22);
  for (const alpha of [0.25, 0.5, 0.75]) {
    const ops = morphIR(morphNode(from, to, alpha));
    const centre = counterCentre(ops);
    assert.ok(!painted(ops, centre),
      `alpha ${alpha}: the counter filled in — this is the bug the user photographed`);
  }
});

test("LAW: the counter is open at the ENDPOINTS too, so the interior is not a special case", () => {
  // The endpoint law says alpha 0 and 1 return the ORIGINAL payloads. Those are
  // real glyphs with real holes, so the same op-level question must answer the
  // same way — otherwise "the hole survives the morph" would be a claim about
  // three frames rather than about the transition.
  const from = glyphPayload(0.3, 0.5, 0.22);
  const to = glyphPayload(0.7, 0.5, 0.22);
  for (const alpha of [0, 1]) {
    const ops = morphIR(morphNode(from, to, alpha));
    assert.ok(!painted(ops, counterCentre(ops)), `alpha ${alpha}: the endpoint's own counter is filled`);
  }
});

test("RULE: two crossing COUNTERS do not disqualify evenodd; two crossing OUTERS do", () => {
  // THE SECOND HALF OF THE BUG (core/morph_fill.js `isCounter`), pinned at the
  // predicate rather than through a morph. A 6 has ONE counter and an 8 has TWO,
  // so the unmatched second counter TRAVELS across the first — and two counters
  // have the SAME winding, which the guard used to treat as disqualifying. That
  // is precisely backwards: two OUTERS crossing is the case evenodd gets wrong,
  // two COUNTERS crossing is the case it gets RIGHT, and refusing evenodd there
  // is what left the user's counters filled on the frames that most needed it.
  //
  // MEASURED at the predicate because the honest evidence for this half is a font
  // corpus, not a polygon: over 12 glyph pairs × 9 alphas of real Inter outlines,
  // counter interiors painted solid went 198 probes / 46 frames → 154 / 41, which
  // is blanket evenodd's own score. A hand-built fixture reproduces the DECISION
  // reliably and the pixel difference only sometimes, so this asserts the decision.
  const cw = (cx, cy, r) => ngon(cx, cy, r, 12, true);
  const ccw = (cx, cy, r) => ngon(cx, cy, r, 12, false);
  // Two counters overlapping inside one outer — the "6" → "8" frame.
  assert.equal(
    hasSameWindingOverlap([cw(0.5, 0.5, 0.4), ccw(0.42, 0.58, 0.14), ccw(0.55, 0.58, 0.14)]),
    false, "two crossing COUNTERS must not force nonzero — this is the AM bug");
  // Two outers overlapping — the case the guard exists for, unchanged.
  assert.equal(
    hasSameWindingOverlap([cw(0.4, 0.5, 0.25), cw(0.55, 0.5, 0.25)]),
    true, "two crossing OUTERS must still force nonzero, or the guard traded one artifact for another");
  // And an outer pair still disqualifies even when a glyph sits elsewhere in the
  // frame: the exclusion is per PAIR, not "does this payload contain a counter".
  assert.equal(
    hasSameWindingOverlap([cw(0.2, 0.2, 0.12), cw(0.28, 0.2, 0.12), cw(0.7, 0.7, 0.2), ccw(0.7, 0.78, 0.07)]),
    true, "a counter elsewhere must not excuse a genuine outer/outer overlap");
});

test("LAW: two counters crossing mid-flight stay open through the whole morph", () => {
  // The same configuration carried through morphIR, so the two halves are pinned
  // together at the seam the user actually sees.
  const one = glyphPayload(0.5, 0.5, 0.3);
  const two = {
    ...one,
    subpaths: [
      one.subpaths[0],
      { ...ngon(0.42, 0.62, 0.1, 10, false), paint: INK },
      { ...ngon(0.58, 0.38, 0.1, 10, false), paint: INK },
    ],
  };
  for (const alpha of [0.25, 0.5, 0.75]) {
    const ops = morphIR(morphNode(one, two, alpha));
    const rings = ops.flatMap((op) => ringsOfD(op.d)).filter((r) => ringSign(r) < 0);
    assert.ok(rings.length, `alpha ${alpha}: the counters vanished entirely`);
    for (const r of rings) {
      const c = [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
      // Only judge a probe that is genuinely inside its own contour — a crescent
      // mid-flight can put its centroid outside itself, and that is not a hole.
      if (!inRing(c, r)) continue;
      assert.ok(!painted(ops, c), `alpha ${alpha}: a counter filled in while two counters overlapped`);
    }
  }
});

// ── THE GRAIN, AND THE ARTIFACT IT MUST NOT TRADE FOR ────────────────────────

test("GRAIN: one ink ⇒ ONE op, so the fill rule has something to act on", () => {
  // The direct statement of the fix. A single-inked glyph is one op carrying both
  // contours; the old code made it two, which is what made a hole unexpressible.
  const ops = morphIR(morphNode(glyphPayload(0.3, 0.5, 0.22), glyphPayload(0.7, 0.5, 0.22), 0.5));
  assert.equal(ops.length, 1, "a single-inked glyph must be ONE path op");
  assert.ok((ops[0].d.match(/M/g) || []).length >= 2, "and that op must carry BOTH contours");
});

test("GRAIN: genuinely multi-coloured art still gets one op PER COLOUR", () => {
  // THE ARTIFACT THE FIX MUST NOT TRADE FOR. An SVG icon's contours really do
  // carry different fills — that is why morphedPaint has a heterogeneous
  // carve-out — so merging everything into one op would flatten it to a single
  // colour. Measured through morphPaintRuns directly, because morphedPaint's own
  // routing is what decides the paint and this asserts the GRAIN, not the colour.
  const runs = morphPaintRuns(
    [{ start: [0, 0] }, { start: [1, 0] }, { start: [2, 0] }],
    (sp) => ({ fill: ["#f00", "#00f", "#00f"][sp.start[0]] }));
  assert.equal(runs.length, 2, "a colour change starts a new run");
  assert.deepEqual(runs.map((r) => r.subpaths.length), [1, 2], "and equal-inked neighbours share one");
});

test("GRAIN: runs are CONSECUTIVE, because paint order is semantic", () => {
  // Gathering all the reds together would reorder a stack of overlapping shapes:
  // a later op draws OVER an earlier one, so red/blue/red is three runs and not
  // two. Cheap to state, and the alternative is an invisible z-order bug.
  const runs = morphPaintRuns(
    [{ start: [0, 0] }, { start: [1, 0] }, { start: [2, 0] }],
    (sp) => ({ fill: ["#f00", "#00f", "#f00"][sp.start[0]] }));
  assert.equal(runs.length, 3, "an interleaved stack must keep its order");
});

console.log(`\n${passed} passed`);
