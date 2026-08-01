/**
 * ONE GEOMETRY, TWO SPELLINGS, ONE PDF — the property that would have caught a
 * silent geometry drop, and cannot rot.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
 * SVG lets a drawing command REPEAT IMPLICITLY: `M0 0L10 0 20 10 30 0 40 10` is four
 * line segments, spelled without repeating the `L`. It is not an exotic form — it is
 * what SVGO, Illustrator and Figma emit, because dropping the repeated letters is
 * their main size win.
 *
 * `render_gpu/pdf_backend.js` used to carry its own tokenizer that split only on
 * command letters, so every number up to the next letter landed in ONE run, and the
 * consumer read one segment's worth of arguments from it. That path exported **one of
 * its four segments**. Two implicit cubics exported as one. **Exit 0, no warning, no
 * error box** — while Skia and the SVG backend rendered the same input correctly.
 *
 * It was scope creep rather than carelessness: that tokenizer was written for MathJax
 * glyph paths, which spell every command explicitly, so one-run-per-letter was
 * one-run-per-segment and it was CORRECT for its only input. It was later pointed at
 * authored artwork without its grammar widening.
 *
 * ── WHY THIS HAS NO FIXTURE, AND WHY THAT IS THE POINT ───────────────────────
 * A fixture of expected PDF operators would pin today's output, and a fixture can be
 * SILENCED BY REGENERATING IT — the failure mode where "update the golden file" is
 * indistinguishable from "ratify the regression", and the reader of the diff cannot
 * tell which one happened. That is not a hypothetical risk here: the bug this file
 * exists for produced perfectly well-formed PDF operators. They were just fewer than
 * the path had segments. A captured-bytes fixture would have recorded the amputated
 * output as correct on the day it was captured.
 *
 * THIS INVARIANT NEEDS NO EXPECTED VALUE AT ALL. The SVG specification DEFINES the
 * explicit and implicit spellings to denote the same path, so the oracle is the
 * codebase's own other answer to the same question:
 *
 *     svgPathToPdfOps(explicit) === svgPathToPdfOps(implicit)
 *
 * BOTH SIDES ARE COMPUTED. There is nothing to transcribe, nothing to regenerate, and
 * no way to "fix" a failure except by making the exporter agree with itself. It also
 * costs nothing to extend: a newly supported grammar is covered by adding one PAIR,
 * not by capturing new bytes — and the pair is readable as a claim about SVG rather
 * than as an opaque blob.
 *
 * Prefer this shape wherever a spec says two inputs must mean the same thing. It is
 * rarer than it should be, because reaching for a golden file is the reflex.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { svgPathToPdfOps, normalizedRuns } from "../render_gpu/pdf_backend.js";

/**
 * Pairs of `d` strings that DESCRIBE THE SAME PATH, spelled explicitly and implicitly.
 * Each pair is a separate assertion so a failure names the grammar that broke.
 *
 * The arc pair is here because arcs are the case most likely to be got wrong and least
 * likely to appear in a hand-written corpus: `A` carries seven arguments of which three
 * (x-rotation, large-arc flag, sweep flag) are NOT coordinates, so an arity walk that
 * assumes "pairs of numbers" mis-splits an implicit arc run without any coordinate
 * looking obviously wrong. Both flag combinations are exercised.
 */
const SAME_PATH = [
  ["line run", "M0 0L10 0L20 10L30 0L40 10", "M0 0L10 0 20 10 30 0 40 10"],
  ["cubic run", "M0 0C1 1 2 2 3 3C4 4 5 5 6 6", "M0 0C1 1 2 2 3 3 4 4 5 5 6 6"],
  ["quadratic run", "M0 0Q10 0 10 10Q20 20 30 30", "M0 0Q10 0 10 10 20 20 30 30"],
  ["horizontal run", "M0 0H10H20H30", "M0 0H10 20 30"],
  ["vertical run", "M0 0V10V20V30", "M0 0V10 20 30"],
  ["implicit-L after moveto", "M0 0L3 4L5 6", "M0 0 3 4 5 6"],
  ["relative line run", "m0 0l10 0l10 10l10 -10", "m0 0l10 0 10 10 10 -10"],
  ["relative cubic run", "m0 0c1 1 2 2 3 3c4 4 5 5 6 6", "m0 0c1 1 2 2 3 3 4 4 5 5 6 6"],
  ["arc run, sweep 1", "M0 0A5 5 0 0 1 10 0A5 5 0 0 1 20 0", "M0 0A5 5 0 0 1 10 0 5 5 0 0 1 20 0"],
  ["arc run, large-arc", "M0 0A5 5 0 1 0 10 0A5 5 0 1 0 20 0", "M0 0A5 5 0 1 0 10 0 5 5 0 1 0 20 0"],
  ["smooth-cubic run", "M0 0C1 1 2 2 3 3S5 5 6 6S8 8 9 9", "M0 0C1 1 2 2 3 3S5 5 6 6 8 8 9 9"],
  ["smooth-quad run", "M0 0Q10 0 10 10T20 20T30 10", "M0 0Q10 0 10 10T20 20 30 10"],
  ["closed subpath", "M0 0L10 0L10 10Z", "M0 0 10 0 10 10Z"],
];

for (const [label, explicit, implicit] of SAME_PATH)
  test(`${label}: the implicit spelling exports exactly like the explicit one`, () => {
    const a = svgPathToPdfOps(explicit);
    const b = svgPathToPdfOps(implicit);
    assert.equal(b, a,
      `these two 'd' strings describe the SAME path and must produce identical PDF operators.\n  explicit: ${explicit}\n  implicit: ${implicit}\n  explicit ops:\n${a}\n  implicit ops:\n${b}`);
  });

test("a real minified path survives: SVGO output is not a special case", () => {
  // Straight from the SVGO/Illustrator idiom — relative, run-together decimals
  // (".7.09" is two numbers), implicit cubic repeat, closed. If the tokenizer's number
  // grammar or its arity walk is wrong, this is where an ordinary asset breaks.
  const minified = "M.5.5c.7.09 1.5.3 2.1-.2 1.2-.4 2-1 3-1.5z";
  const expanded = "M0.5 0.5c0.7 0.09 1.5 0.3 2.1 -0.2c1.2 -0.4 2 -1 3 -1.5z";
  assert.equal(svgPathToPdfOps(minified), svgPathToPdfOps(expanded),
    "a minified path and its expanded twin must export identically");
  assert.equal(svgPathToPdfOps(minified).split("c").length - 1, 2, "both cubics survive");
});

test("every command in a run becomes its own operator — the drop, counted", () => {
  // The bug's signature was a COUNT, so the count is asserted directly: an N-segment
  // run must emit N operators. Pre-fix this emitted 1.
  assert.equal(svgPathToPdfOps("M0 0L10 0 20 10 30 0 40 10").split("l").length - 1, 4);
  assert.equal(svgPathToPdfOps("M0 0C1 1 2 2 3 3 4 4 5 5 6 6").split("c").length - 1, 2);
  assert.equal(normalizedRuns("M0 0L10 0 20 10 30 0 40 10").length, 5, "1 moveto + 4 lines");
});

test("the arc grammar reaches the page at all — it used to throw", () => {
  // Not a spelling property: a capability. The retired tokenizer passed `A` through to
  // a consumer that had no branch for it, so ANY arc failed the whole export.
  const ops = svgPathToPdfOps("M0 0A5 5 0 0 1 10 0");
  assert.equal(ops.split("c").length - 1, 2, "the arc bakes to its standard cubic approximation");
  assert.ok(!/[Aa]/.test(ops), "no arc operator survives — PDF has none");
});
