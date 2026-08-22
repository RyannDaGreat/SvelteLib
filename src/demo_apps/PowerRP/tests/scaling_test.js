/**
 * core/scaling.js — THE UNITS OF A SCALABLE PROPERTY (workstream SCALE_).
 *
 * WHY A SECOND SUITE BESIDE tests/scale_wholistic_test.js. That one pins the
 * MACHINERY (the lookup, the arithmetic, the dotted read, the modal gating) with
 * hand-made rows, and deliberately imports nothing but core/scaling.js and
 * dragKinds. This one asks a different question, and it needs two modules that suite
 * refuses to load: given the REAL row declaration in core/properties.js and the REAL
 * formula in render_gpu/ir.js, is the behaviour SHARED_SCALING assigns to a key
 * actually the one that keeps the picture right?
 *
 * IT EXISTS BECAUSE THE TABLE WAS WRONG ABOUT ONE KEY AND NOTHING COULD SEE IT.
 * `strokeOffset` was declared "linear" with the comment "beyond ±1 it detaches into
 * a parallel contour measured in canvas units". Both halves of that are false:
 *   strokeInsideFraction(o)              = (1 − o)/2          — a fraction of the WIDTH
 *   strokeDetachedNearDistance(w, o)     = (|o| − 1)·w/2      — a multiple of the WIDTH
 * There is no canvas length in either. Since `strokeWidth` is itself "linear", the
 * drawn offset ALREADY scales with the gesture, so scaling the number too applied k
 * twice: a fully-inside stroke (o = −1) scaled ×2 became o = −2, which is not an
 * inside stroke at all but a detached ring floating a full stroke width off the edge.
 * That is a silent wrong picture — no throw, no warning, and the shape still draws.
 *
 * THE INVARIANT THIS SUITE ASSERTS is the one that makes "wholistic" mean anything:
 * scaling a widget by k must multiply every drawn LENGTH by exactly k. So the check
 * is not "the number stayed the same" (that is the fix, not the reason) — it is that
 * ir.js's own stroke geometry, recomputed from the scaled state, is k times the
 * original. A future change to either the table or the formula that breaks the
 * agreement fails here regardless of which side moved.
 *
 * Bare node, DOM-free: core/scaling.js, core/properties.js and render_gpu/ir.js all
 * import clean in node (measured), so no roster and no host are involved.
 *
 * Run: node src/demo_apps/PowerRP/tests/scaling_test.js
 */

import { SHARED_SCALING, rowScaling, scalingCoverage, wholisticPairs } from "../core/scaling.js";
import { PROPS } from "../core/properties.js";
import { strokeInsideFraction, strokeDetachedNearDistance } from "../render_gpu/ir.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}\n  got:  ${a}\n  want: ${b}`);
};
/** Pure function. Absolute-tolerance float compare, for the k-times-the-length checks. */
const close = (name, got, want) => {
  if (Math.abs(got - want) <= 1e-12) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}\n  got:  ${got}\n  want: ${want}`);
};

// The two stroke keys under test, declared exactly as core/properties.js declares
// them — reading PROPS rather than hand-writing `{kind: "number"}` is what ties this
// suite to the shipped rows, so a row that changes kind cannot pass here silently.
const strokeRow = (key) => ({ key, kind: PROPS[key].kind });
const strokePlugin = { inspector: [strokeRow("strokeWidth"), strokeRow("strokeOffset")] };

// ── THE DEFECT, stated as the table entry ─────────────────────────────────────
eq("strokeOffset is dimensionless: it is a MULTIPLE of strokeWidth, which already scales",
  SHARED_SCALING.strokeOffset, "none");
eq("…and rowScaling agrees for the SHIPPED row", rowScaling(strokeRow("strokeOffset"), {}), "none");
eq("strokeMiter is the identical argument and was always right",
  rowScaling(strokeRow("strokeMiter"), {}), "none");
eq("strokeWidth IS a canvas length, so it still scales", rowScaling(strokeRow("strokeWidth"), {}), "linear");

// DECLARED "none" RATHER THAN DELETED, so `scalingCoverage` still counts the key as
// ANSWERED. An omitted key and a "none" key paint identically; they differ only in
// whether an author is told the row still needs thinking about, and this one does not.
eq("strokeOffset stays ANSWERED coverage, not an open gap",
  scalingCoverage(strokePlugin), { answered: ["strokeWidth", "strokeOffset"], unanswered: [] });

// ── THE INVARIANT: a wholistic scale multiplies every DRAWN length by exactly k ──
// Asked of ir.js's own formulas, in both regimes, so this fails if EITHER the table
// or the geometry moves without the other.
const scaled = (state, k) => {
  const out = { ...state };
  for (const [key, value] of wholisticPairs(state, strokePlugin, k)) out[key] = value;
  return out;
};
const K = 2.5;

// ATTACHED (|o| ≤ 1): the ink's inside/outside SPLIT is a fraction, so the fraction
// must be invariant and the two ink depths must each grow by k.
for (const offset of [-1, -0.5, 0, 0.5, 1]) {
  const before = { strokeWidth: 4, strokeOffset: offset };
  const after = scaled(before, K);
  eq(`attached o=${offset}: the inside FRACTION is invariant under a scale`,
    strokeInsideFraction(after.strokeOffset), strokeInsideFraction(before.strokeOffset));
  close(`attached o=${offset}: the inside ink DEPTH scales by k`,
    strokeInsideFraction(after.strokeOffset) * after.strokeWidth,
    K * strokeInsideFraction(before.strokeOffset) * before.strokeWidth);
}

// DETACHED (|o| > 1): the gap between the path edge and the band scales by k, and so
// does the band's own width — the whole parallel-contour construction is similar.
for (const offset of [-2, 1.5, 3]) {
  const before = { strokeWidth: 4, strokeOffset: offset };
  const after = scaled(before, K);
  close(`detached o=${offset}: the near-side GAP scales by k`,
    strokeDetachedNearDistance(after.strokeWidth, after.strokeOffset),
    K * strokeDetachedNearDistance(before.strokeWidth, before.strokeOffset));
  close(`detached o=${offset}: the band WIDTH scales by k`, after.strokeWidth, K * before.strokeWidth);
}

// THE REGRESSION IN ONE LINE, spelled out because it is the picture the user would
// have seen: a fully-INSIDE stroke must stay fully inside at any size.
const insideAfter = scaled({ strokeWidth: 4, strokeOffset: -1 }, 2);
eq("a fully-INSIDE stroke stays fully inside after a x2 wholistic scale",
  [insideAfter.strokeOffset, strokeInsideFraction(insideAfter.strokeOffset)], [-1, 1]);
eq("…and it does NOT detach (the old 'linear' entry made it o=-2, a floating ring)",
  strokeDetachedNearDistance(insideAfter.strokeWidth, insideAfter.strokeOffset) > 0, false);

// A WHOLISTIC SCALE MUST STILL WRITE THE WIDTH — the fix must not be "scale nothing".
eq("the width pair is still emitted", wholisticPairs({ strokeWidth: 4, strokeOffset: -1 }, strokePlugin, 2),
  [["strokeWidth", 8]]);

console.log(`\nscaling_test: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
