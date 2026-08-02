/**
 * BRACE GEOMETRY — core/brace.js.
 *
 * User, 2026-08-02: "a three-point thing where the points are all like arrow
 * points … the third one determines where the pointy bit of this curly bracket
 * is, and that also determines how it's flipped, and it's always orthogonal to
 * the other two, but can be shifted right or left."
 *
 * Each clause of that sentence is a test below.
 *
 * Run: node src/demo_apps/PowerRP/tests/brace_test.js
 */
import assert from "node:assert/strict";
import { axisFrame, cornerRadius, braceSkeleton, bracePathD, braceInkRect, handleSegments, segmentT, segmentAt, clamp01 } from "../core/brace.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const A = { x: 0, y: 0 }, B = { x: 100, y: 0 };

// ── "SHIFTED RIGHT OR LEFT": the along-span component ────────────────────────

test("the tip's ALONG component is where the pointy bit sits", () => {
  assert.equal(axisFrame(A, B, { x: 25, y: 40 }).along, 25);
  assert.equal(axisFrame(A, B, { x: 75, y: 40 }).along, 75, "shifted the other way");
  assert.equal(braceSkeleton(25, 40, 100)[3].s, 25, "and the nub follows it");
});

test("the along component is measured on the AXIS, not in screen x — a diagonal span works", () => {
  const d = { x: 30, y: 40 }; // length 50
  const f = axisFrame({ x: 0, y: 0 }, d, { x: 15, y: 20 });
  assert.ok(near(f.along, 25), `midpoint of a 3-4-5 span is 25 along, got ${f.along}`);
  assert.ok(near(f.out, 0), "and exactly ON the axis");
});

// ── "ALWAYS ORTHOGONAL": the perpendicular component ─────────────────────────

test("the nub is PERPENDICULAR to the span by construction, whatever the span's angle", () => {
  // A vertical span: the nub must displace in x, never in y.
  const from = { x: 50, y: 0 }, to = { x: 50, y: 100 };
  const f = axisFrame(from, to, { x: 90, y: 60 });
  // Rebuild the nub's world position the way bracePathD does.
  const nub = { x: from.x + f.ux * f.along + f.nx * f.out, y: from.y + f.uy * f.along + f.ny * f.out };
  assert.ok(near(nub.y, 60), "its along-span position is preserved");
  assert.ok(near(nub.x, 90), "and its offset is purely perpendicular");
  // Perpendicularity, stated directly: (nub - footOfPerpendicular) · axis == 0
  const foot = { x: from.x + f.ux * f.along, y: from.y + f.uy * f.along };
  assert.ok(near((nub.x - foot.x) * f.ux + (nub.y - foot.y) * f.uy, 0), "the nub offset is orthogonal to the axis");
});

// ── "THAT ALSO DETERMINES HOW IT'S FLIPPED" ──────────────────────────────────

test("THE SIGN OF THE PERPENDICULAR COMPONENT IS THE FLIP", () => {
  const above = axisFrame(A, B, { x: 50, y: -30 });
  const below = axisFrame(A, B, { x: 50, y: 30 });
  assert.ok(above.out < 0 && below.out > 0, "opposite sides give opposite signs");
  assert.equal(above.along, below.along, "…with the same along-span position");
  assert.equal(braceSkeleton(50, above.out, 100)[3].w, above.out, "and the nub follows the sign");
  assert.equal(braceSkeleton(50, below.out, 100)[3].w, below.out);
});

test("flipping is a MIRROR, not a different shape: the two paths differ only in w", () => {
  const up = braceSkeleton(50, 40, 100);
  const down = braceSkeleton(50, -40, 100);
  assert.deepEqual(up.map((p) => p.s), down.map((p) => p.s), "identical along the span");
  // `+ 0` normalizes -0 to 0: negating an on-axis 0 yields -0, which deepStrictEqual
  // treats as a different value. The distinction is meaningless for a coordinate.
  assert.deepEqual(up.map((p) => p.w + 0), down.map((p) => -p.w + 0), "and exactly negated across it");
});

// ── THE SKELETON'S PROPORTIONS ───────────────────────────────────────────────

test("ends sit ON the axis, arms at HALF the bulge, the nub at FULL bulge", () => {
  const pts = braceSkeleton(50, 40, 100);
  assert.equal(pts[0].w, 0, "end 1 on the axis");
  assert.equal(pts[6].w, 0, "end 2 on the axis");
  assert.equal(pts[3].w, 40, "the nub reaches the full bulge");
  for (const i of [1, 2, 4, 5]) assert.equal(pts[i].w, 20, `shoulder ${i} runs at half`);
});

test("CORNERS SHRINK rather than overlap when the brace is squat or lopsided", () => {
  assert.ok(cornerRadius(40, 50, 100) <= 50, "never wider than an arm");
  assert.equal(cornerRadius(0, 50, 100), 0, "no bulge → no corner to round");
  assert.ok(cornerRadius(40, 2, 100) <= 2, "a nub crowded against one end gets a tiny corner, not a crossing one");
  assert.ok(cornerRadius(1000, 50, 100) <= 50, "an enormous bulge is still bounded by the arms");
  assert.ok(cornerRadius(-40, 50, 100) > 0, "a flipped brace rounds the same amount (magnitude, not sign)");
});

test("a nub AT an end does not produce a negative radius", () => {
  assert.ok(cornerRadius(40, 0, 100) >= 0);
  assert.ok(cornerRadius(40, 100, 100) >= 0);
  // …and past the end, which a free anchorable tip can absolutely reach.
  assert.ok(cornerRadius(40, -50, 100) >= 0, "a tip dragged BEFORE the span start");
  assert.ok(cornerRadius(40, 150, 100) >= 0, "and one dragged past its end");
});

// ── THE EMITTED PATH ─────────────────────────────────────────────────────────

test("ONE SKELETON, TWO SHAPES: curl 0 is straight segments, curl 1 has curves", () => {
  const square = bracePathD(A, B, { x: 50, y: 40 }, 0);
  const curly = bracePathD(A, B, { x: 50, y: 40 }, 1);
  assert.ok(!square.includes("C"), "a square bracket emits no cubic");
  assert.ok(square.includes("L"), "…it is lines");
  assert.ok(curly.includes("C"), "a curly brace rounds its corners");
});

test("PDF-SAFE: only M, L and C — never an elliptical arc", () => {
  for (const curl of [0, 0.5, 1])
    for (const tip of [{ x: 50, y: 40 }, { x: 10, y: -80 }, { x: 95, y: 5 }]) {
      const d = bracePathD(A, B, tip, curl);
      const cmds = [...d.matchAll(/[A-Za-z]/g)].map((m) => m[0]);
      assert.deepEqual([...new Set(cmds)].sort().filter((c) => !"MLC".includes(c)), [],
        `curl ${curl}, tip ${JSON.stringify(tip)}: found a command outside M/L/C in "${d}"`);
    }
});

test("A DEGENERATE SPAN DRAWS NOTHING rather than dividing by zero", () => {
  assert.equal(bracePathD({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 9, y: 9 }), "");
});

test("NO BULGE degrades to a plain line — a brace with its tip on the axis is a line", () => {
  const d = bracePathD(A, B, { x: 50, y: 0 }, 1);
  assert.equal(d, "M 0 0 L 100 0");
});

test("the path STARTS at `from` and ENDS at `to`, so the two ends are where the points are", () => {
  const d = bracePathD(A, { x: 100, y: 60 }, { x: 40, y: -20 }, 1);
  assert.ok(d.startsWith("M 0 0"), `starts at from — got "${d.slice(0, 20)}…"`);
  const nums = d.trim().split(/\s+/);
  assert.equal(`${nums.at(-2)} ${nums.at(-1)}`, "100 60", "ends at to");
});

test("curl is CLAMPED, so a nonsense value cannot produce nonsense geometry", () => {
  assert.equal(bracePathD(A, B, { x: 50, y: 40 }, 5), bracePathD(A, B, { x: 50, y: 40 }, 1));
  assert.equal(bracePathD(A, B, { x: 50, y: 40 }, -3), bracePathD(A, B, { x: 50, y: 40 }, 0));
});

// ── BOUNDS ───────────────────────────────────────────────────────────────────

test("THE BOUNDS PROTOCOL: the hull of the three points, like an arrow's endpoint hull", () => {
  assert.deepEqual(braceInkRect({ from: A, to: B, tip: { x: 50, y: 40 } }), { x: 0, y: 0, w: 100, h: 40 });
  assert.deepEqual(braceInkRect({ from: { x: 10, y: 10 }, to: { x: 10, y: 90 }, tip: { x: -20, y: 50 } }),
    { x: -20, y: 10, w: 30, h: 80 }, "a flipped vertical brace still reports a positive-size rect");
});

test("THE DRAWN CURVE CANNOT ESCAPE THE BOUNDS — sampled, not asserted", () => {
  // THIS TEST HAD THE RIGHT IDEA AND THE WRONG FIXTURE, and it is worth saying so
  // where the next author will read it. It samples the REAL skeleton — exactly the
  // right instrument — but every case used the HORIZONTAL span A→B, which is the
  // one family of spans where escape is arithmetically impossible: the shoulders'
  // perpendicular offset lands on the same axis the hull already spans. So a
  // bounds function that under-reported by up to 17.32 units on a diagonal passed
  // this test every time. THE SPAN ANGLE IS NOW PART OF THE SWEEP, which is the
  // whole of the repair.
  const SPANS = [
    ["horizontal", { x: 0, y: 0 }, { x: 100, y: 0 }],
    ["vertical", { x: 0, y: 0 }, { x: 0, y: 100 }],
    ["diagonal 45", { x: 0, y: 0 }, { x: 100, y: 100 }],
    ["shallow", { x: 20, y: 30 }, { x: 140, y: 68 }],
    ["backwards", { x: 90, y: 60 }, { x: -30, y: 10 }],
  ];
  for (const [label, from, to] of SPANS)
    for (const tip of [{ x: 50, y: 40 }, { x: 5, y: -60 }, { x: 120, y: 30 }, { x: -30, y: -10 }])
      for (const shoulder of [0, 0.5, 1]) {
        const r = braceInkRect({ from, to, tip });
        const f = axisFrame(from, to, tip);
        for (const p of braceSkeleton(f.along, f.out, f.len, shoulder)) {
          const wx = from.x + f.ux * p.s + f.nx * p.w, wy = from.y + f.uy * p.s + f.ny * p.w;
          const where = `${label} tip ${JSON.stringify(tip)} shoulder ${shoulder}`;
          assert.ok(wx >= r.x - 1e-9 && wx <= r.x + r.w + 1e-9, `${where}: x ${wx} outside [${r.x}, ${r.x + r.w}]`);
          assert.ok(wy >= r.y - 1e-9 && wy <= r.y + r.h + 1e-9, `${where}: y ${wy} outside [${r.y}, ${r.y + r.h}]`);
        }
      }
});

// ── THE LOOK: TWO CONTINUOUS KNOBS (user: "interpolate … smoothly") ─────────

test("SHOULDER 1 is the bracket profile; SHOULDER 0 collapses to a straight chevron", () => {
  const bracket = braceSkeleton(50, 40, 100, 1);
  const chevron = braceSkeleton(50, 40, 100, 0);
  assert.equal(bracket[1].w, 20, "bracket arms run at half the bulge");
  // On a chevron every intermediate point lies ON the end→nub line: w = out·s/along.
  for (const i of [1, 2]) assert.ok(near(chevron[i].w, (40 * chevron[i].s) / 50), `point ${i} is on the straight line`);
  for (const i of [4, 5]) assert.ok(near(chevron[i].w, (40 * (100 - chevron[i].s)) / 50), `point ${i} is on the other straight line`);
});

test("SHOULDER INTERPOLATES — a continuous sweep, not a switch", () => {
  // MONOTONIC, not exactly-linear, and the difference is real rather than sloppy:
  // the corner radius ALSO scales with shoulder, so the sampled skeleton point's
  // own `s` moves as the knob turns. Asserting an exact midpoint would be
  // asserting a formula the geometry does not claim; what the user asked for is
  // that it slides smoothly, which is monotonicity with no jumps.
  const at = (k) => braceSkeleton(50, 40, 100, k)[1].w;
  const xs = [0, 0.2, 0.4, 0.6, 0.8, 1].map(at);
  for (let i = 1; i < xs.length; i++)
    assert.ok(xs[i] >= xs[i - 1] - 1e-12, `step ${i} went backwards: ${xs[i - 1]} → ${xs[i]}`);
  assert.ok(xs.at(-1) > xs[0], `the sweep actually moves (${xs[0]} → ${xs.at(-1)})`);
  const mid = at(0.5);
  assert.ok(mid > xs[0] && mid < xs.at(-1), `halfway lies strictly between the ends (${mid})`);
});

test("THE THREE NAMED LOOKS ARE ALL REACHABLE and all different", () => {
  const tip = { x: 50, y: 40 };
  const curly = bracePathD(A, B, tip, 1, 1);
  const rightAngle = bracePathD(A, B, tip, 0, 1);
  const straight = bracePathD(A, B, tip, 0, 0);
  assert.equal(new Set([curly, rightAngle, straight]).size, 3, "curly / right-angle / straight are three distinct paths");
  assert.ok(curly.includes("C") && !rightAngle.includes("C"), "curly curves, right-angle does not");
});

test("both knobs are CLAMPED, so a nonsense value cannot make nonsense geometry", () => {
  assert.equal(clamp01(NaN), 0, "NaN does not poison the path");
  assert.equal(bracePathD(A, B, { x: 50, y: 40 }, 1, 9), bracePathD(A, B, { x: 50, y: 40 }, 1, 1));
  assert.equal(bracePathD(A, B, { x: 50, y: 40 }, 1, -9), bracePathD(A, B, { x: 50, y: 40 }, 1, 0));
});

// ── THE HANDLES ─────────────────────────────────────────────────────────────

test("segmentT and segmentAt are INVERSES, which is what keeps a handle honest", () => {
  const a = { x: 10, y: 20 }, b = { x: 90, y: 60 };
  for (const t of [0, 0.25, 0.5, 0.9, 1]) assert.ok(near(segmentT(a, b, segmentAt(a, b, t)), t, 1e-9), `t=${t}`);
});

test("EACH HANDLE ROUND-TRIPS: dragged to an end of its segment it reads exactly 0 or 1", () => {
  const s = { from: A, to: B, tip: { x: 50, y: 40 }, shoulder: 1, curl: 1 };
  const seg = handleSegments(s);
  for (const id of ["shoulder", "curl"]) {
    assert.equal(segmentT(...seg[id], seg[id][0]), 0, `${id} at its 0 end`);
    assert.equal(segmentT(...seg[id], seg[id][1]), 1, `${id} at its 1 end`);
  }
});

test("THE SHOULDER HANDLE HAS REAL TRAVEL — the midpoint trap, pinned", () => {
  // The chevron and bracket profiles COINCIDE at the arm's midpoint (out·s/along
  // = out/2 at s = along/2), so a handle sampled there silently always reads 0.
  // The first implementation did exactly that. This asserts the two ends of the
  // shoulder segment are genuinely apart.
  const seg = handleSegments({ from: A, to: B, tip: { x: 50, y: 40 }, shoulder: 1 });
  const [p0, p1] = seg.shoulder;
  assert.ok(Math.hypot(p1.x - p0.x, p1.y - p0.y) > 1, `the segment has length, got ${Math.hypot(p1.x - p0.x, p1.y - p0.y)}`);
});

test("NO HANDLES when there is nothing to shape", () => {
  assert.equal(handleSegments({ from: A, to: A, tip: { x: 5, y: 5 }, shoulder: 1 }), null, "degenerate span");
  assert.equal(handleSegments({ from: A, to: B, tip: { x: 50, y: 0 }, shoulder: 1 }), null, "tip on the axis — no bulge, no corner");
});

console.log(`\n${passed} brace geometry tests passed`);
