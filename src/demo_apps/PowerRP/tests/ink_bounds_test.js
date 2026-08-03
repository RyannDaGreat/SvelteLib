/**
 * INK BOUNDS — a text widget's ACTUAL size versus its property size.
 *
 * The defect this feature removes (user, 2026-08-02): "the text can go below the
 * bottom of the text box and it's weird because then it gets culled … when I
 * click the text, when the text is out of the box, it doesn't work."
 *
 * plugins/plaintext.js declared no `localBounds`, so the BOUNDS protocol fell
 * back to the property box for text — and text OVERFLOWS its box in both
 * directions by design (core/richtext.valignOffset: content taller than h "grows
 * DOWNWARD past h … never clip"; wrapParagraph puts an unbreakable word past the
 * right edge). Every BOUNDS consumer inherited that wrong rect at once.
 *
 * WHAT IS PINNED HERE is the DOM-free half — the ink rect itself, the hit-test
 * union, and that culling follows from the rect rather than from a second code
 * path. Measurement goes through core/richtext.monoMeasure, the deterministic
 * stub the rest of the text suites use, so every number below is exact rather
 * than font-dependent: one glyph is `size` wide, ascent 0.8·size, descent
 * 0.2·size. The CanvasKit-backed measure that the editor and CLI actually install
 * is a different SEAM, not different math — core/ink_metrics is the seam, and its
 * uninstalled state is asserted to be loud rather than silently wrong.
 */

import assert from "assert";
import { textInkBounds, monoMeasure } from "../core/richtext.js";
import { setInkMeasure, inkMeasure, hasInkMeasure } from "../core/ink_metrics.js";
import { plaintextPlugin, plaintextInkBounds } from "../plugins/plaintext.js";
import { clickableLocalRect, pickNode } from "../core/derive.js";
import { localBoundsOf, defaultCanSkip } from "../core/view.js";
import { graphLinePlugin } from "../plugins/graph_line.js";
import { GRAPH_LINE_PRESETS } from "../plugins/graph_presets.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// monoMeasure: every glyph is `size` wide. At size 10 a one-line "ab" is 20x10.
const SIZE = 10;

/** A derived-node shell around a plaintext state, at the identity world. */
const plaintextNode = (state, world = { x: 0, y: 0, rotation: 0, scale: 1 }) => ({
  id: "t", itemId: "t", type: "plaintext", state, plugin: plaintextPlugin, world,
});

// ── the rect itself ───────────────────────────────────────────────────────────

test("textInkBounds: the BOX wins on width when the text fits inside it", () => {
  const r = textInkBounds({ runs: [{ text: "ab", size: SIZE, color: "#000" }], paras: [{}] }, 100, monoMeasure, {}, 100);
  assert.deepEqual(r, { x: 0, y: 0, w: 100, h: 10 });
});

test("textInkBounds: OVERFLOW — two lines in a 5-tall box report the full 20, not the box", () => {
  const r = textInkBounds({ runs: [{ text: "a\nb", size: SIZE, color: "#000" }], paras: [{}, {}] }, 100, monoMeasure, {}, 5);
  assert.equal(r.h, 20, "the ink is the two laid-out lines, four times the box height");
});

test("textInkBounds: an UNBREAKABLE word overruns a narrow box, and the rect follows it", () => {
  // wrapParagraph places an overlong word on its own line "and allowed to
  // overflow" — so the ink is wider than the wrap box, and the rect must say so.
  const r = textInkBounds({ runs: [{ text: "aaaa", size: SIZE, color: "#000" }], paras: [{}] }, 15, monoMeasure, {}, 100);
  assert.equal(r.w, 40, "four glyphs at size 10, against a box of 15");
});

test("textInkBounds: valign moves the stack, and the rect covers where it landed", () => {
  const rich = { runs: [{ text: "a", size: SIZE, color: "#000" }], paras: [{}] };
  const top = textInkBounds(rich, 100, monoMeasure, { valign: "top" }, 100);
  const bottom = textInkBounds(rich, 100, monoMeasure, { valign: "bottom" }, 100);
  assert.equal(top.h, 10, "top-aligned: the ink ends where the one line ends");
  assert.equal(bottom.h, 100, "bottom-aligned: the ink reaches the bottom of the box it was pushed to");
});

test("plaintext declares localBounds, and an EMPTY box reports no ink", () => {
  assert.equal(typeof plaintextPlugin.localBounds, "function", "the BOUNDS protocol hook must be declared");
  // Consistent with emit(), which returns [] for an empty string: an empty box
  // draws nothing, so it claims nothing. Its findability is isGhost's job.
  assert.deepEqual(plaintextInkBounds({ text: "" }), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(plaintextInkBounds({ text: "   " }), { x: 0, y: 0, w: 0, h: 0 }, "whitespace-only is empty too");
});

test("plaintext ink EXCEEDS a box the text overflows, and equals it when it fits", () => {
  const overflowing = plaintextInkBounds({ text: "aaaa bbbb cccc", w: 40, h: 12, size: SIZE });
  assert.ok(overflowing.h > 12, `overflowing text must report ink taller than its box (got ${overflowing.h})`);
  const fitting = plaintextInkBounds({ text: "ab", w: 400, h: 200, size: SIZE });
  assert.equal(fitting.h, 10, "one line of size-10 type is 10 tall however big the box is");
});

// ── the seam ──────────────────────────────────────────────────────────────────

test("ink_metrics: an uninstalled measure FALLS BACK loudly; install/uninstall round-trips", () => {
  // This suite runs in bare node with no CanvasKit, so nothing is installed and
  // the fallback path is the one under test. It is restored at the end so test
  // order cannot matter.
  setInkMeasure(null);
  assert.equal(hasInkMeasure(), false);
  // The fallback is a REAL answer (monoMeasure) — not the property box, which is
  // the exact wrong answer this feature exists to stop returning, and not a throw.
  assert.equal(inkMeasure()("ab", { size: SIZE }).width, 20);

  const stub = () => ({ width: 999, ascent: 1, descent: 1 });
  setInkMeasure(stub);
  assert.equal(hasInkMeasure(), true);
  assert.equal(inkMeasure(), stub, "the installed measure is used verbatim");

  assert.throws(() => setInkMeasure(42), /expected a function or null/, "a non-function install is refused LOUDLY");
  setInkMeasure(null);
  assert.equal(hasInkMeasure(), false, "null uninstalls, spelled explicitly rather than by omission");
});

// ── the hit test ──────────────────────────────────────────────────────────────

test("clickableLocalRect: no localBounds hook leaves the grab rect BIT-IDENTICAL to the box", () => {
  const r = clickableLocalRect({ state: { w: 10, h: 20 }, plugin: { capabilities: { bbox: true } } });
  assert.deepEqual(r, { x: 0, y: 0, w: 10, h: 20 });
});

test("clickableLocalRect: the UNION keeps BOTH rects — this is the whole design", () => {
  // Ink LARGER than the box (overflowing text): the overflow becomes grabbable.
  const bigInk = clickableLocalRect({ state: { w: 10, h: 20 }, plugin: { capabilities: { bbox: true }, localBounds: () => ({ x: 0, y: 0, w: 10, h: 90 }) } });
  assert.deepEqual(bigInk, { x: 0, y: 0, w: 10, h: 90 });
  // Ink SMALLER than the box (a half-empty text box): the empty half STAYS
  // grabbable. Taking the ink alone would fix one report and create its mirror.
  const smallInk = clickableLocalRect({ state: { w: 100, h: 80 }, plugin: { capabilities: { bbox: true }, localBounds: () => ({ x: 0, y: 0, w: 12, h: 9 }) } });
  assert.deepEqual(smallInk, { x: 0, y: 0, w: 100, h: 80 });
});

test("clickableLocalRect: a widget that draws NOTHING does not drag the rect to the origin", () => {
  const r = clickableLocalRect({ state: { w: 100, h: 80 }, plugin: { capabilities: { bbox: true }, localBounds: () => ({ x: 0, y: 0, w: 0, h: 0 }) } });
  assert.deepEqual(r, { x: 0, y: 0, w: 100, h: 80 }, "an empty rect encloses nothing, so there is nothing to add");
});

test("THE REPORTED DEFECT: a click on text BELOW its box now selects it", () => {
  // A box 200x40 holding type that lays out far taller than 40.
  const node = plaintextNode({ text: "aaaa bbbb cccc dddd", x: 0, y: 0, w: 200, h: 40, size: 36 });
  const ink = localBoundsOf(node);
  assert.ok(ink.h > 40, `precondition: the type must overflow its box (ink ${ink.h} vs box 40)`);
  const belowBox = 40 + (ink.h - 40) / 2; // inside the ink, outside the property box
  assert.ok(pickNode([node], 50, belowBox) !== null, "a click on the overflowing type must hit the item");
  assert.ok(pickNode([node], 50, 20) !== null, "and a click inside the box still hits, as it always did");
  assert.equal(pickNode([node], 50, ink.h + 500), null, "a click past ALL the ink still misses");
});

// ── culling follows from the rect, rather than from a second code path ────────

test("CULLING: text whose BOX is offscreen but whose INK reaches into view is NOT skipped", () => {
  // defaultCanSkip reads localBoundsOf, so declaring the rect is the entire fix —
  // this asserts the consequence rather than re-implementing it.
  const node = plaintextNode({ text: "aaaa bbbb cccc dddd", x: 0, y: 0, w: 200, h: 40, size: 36 });
  const ink = localBoundsOf(node);
  // A view sitting BELOW the property box, but within the overflowing ink.
  const view = { x: 0, y: 60, w: 400, h: ink.h - 60 };
  assert.equal(defaultCanSkip(node, view), false, "the overflowing ink is visible, so the node must be drawn");
  const farAway = plaintextNode({ text: "aaaa bbbb", x: 0, y: 0, w: 200, h: 40, size: 36 }, { x: 0, y: 99999, rotation: 0, scale: 1 });
  assert.equal(defaultCanSkip(farAway, view), true, "genuinely offscreen text still culls");
});

// ── A CURVE'S INK IS WHAT IT PAINTS (the equation-zoo "wackadoodle" report) ────
//
// User, 2026-08-02: "There's a glitch I'm worried about when I am selecting
// different equations in the equation zoo … the ink bounds just go crazy … did
// our distinction between ink bounds and other bounds just make a lot of widgets
// go crazy?"
//
// MEASURED ANSWER: NO. graphLine's rect is EXACT — it equals the hull of the `d`
// its own emit() produces, inflated by half the stroke, for every zoo preset.
// The rects really are enormous (an Epicycloid in the DEFAULT ±6.28 window paints
// a 21179x68248 local rect out of a 400x300 box), but that is HONEST: the plugin
// clips nothing, so the polyline genuinely paints there. The size comes from the
// preset FRAMING tension introduced by 83acbd6 (a zoo preset writes only the
// equation and RETAINS the author's xRange/yRange, and zoo amplitudes span three
// orders of magnitude), not from the BOUNDS protocol.
//
// What is pinned is the property that made that diagnosis possible and that any
// future edit to either half must preserve: emit() and localBounds() read the ONE
// shared sampler (graph_line.curveLocal), so they cannot drift apart. A clip added
// to emit without teaching localBounds — or a hull widened past the paint — fails
// here rather than in a user's hands.

/** Hull of every coordinate pair in an all-M/L path `d` (what polylinePathD emits). */
const pathDHull = (d) => {
  const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

test("graphLine: localBounds equals the hull of what emit() actually PAINTS", () => {
  // polylinePathD rounds coordinates to 3dp, so the hull can differ from the
  // unrounded bounds by at most half a unit in the last place.
  const ROUNDING = 0.001;
  for (const preset of GRAPH_LINE_PRESETS) {
    const state = { ...graphLinePlugin.defaults, ...preset.props };
    const op = graphLinePlugin.emit(state).find((o) => o.op === "path");
    assert.ok(op, `${preset.name}: the zoo preset must emit a path, not an error box`);
    const hull = pathDHull(op.d), pad = state.strokeWidth / 2, ink = graphLinePlugin.localBounds(state);
    for (const [what, inkV, paintV] of [
      ["left", ink.x, hull.minX - pad], ["top", ink.y, hull.minY - pad],
      ["right", ink.x + ink.w, hull.maxX + pad], ["bottom", ink.y + ink.h, hull.maxY + pad],
    ])
      assert.ok(
        Math.abs(inkV - paintV) <= ROUNDING,
        `${preset.name}: ink claims ${what}=${inkV} but emit paints ${paintV} — the rect must describe the paint`
      );
  }
});

test("graphLine: a discontinuous equation keeps the ink FINITE (non-finite samples are dropped)", () => {
  // tan's asymptotes sample to ±Infinity; sampleCurve nulls them and breakSubpaths
  // drops them, so an infinity must never reach the hull. An Infinity here would
  // poison every consumer at once (cull, band-select, capture rect, hit union) —
  // which is what "wackadoodle" would look like if the rect were genuinely broken.
  const state = { ...graphLinePlugin.defaults, mode: "explicit", source: "Math.tan(x)", tStart: -3.2, tEnd: 3.2, numPoints: 257 };
  const ink = graphLinePlugin.localBounds(state);
  for (const [k, v] of Object.entries(ink))
    assert.ok(Number.isFinite(v), `tan's ink.${k} must be finite, got ${v}`);
});

test("graphLine: the ink is the CURVE's, so it tracks the data window rather than the box", () => {
  // The framing tension in one assertion. Same equation, same box: widening the
  // window shrinks the ink. This is why a zoo preset that keeps the author's
  // window can report a rect hundreds of times the box — and why the fix belongs
  // to framing, not to the BOUNDS protocol.
  const curve = { ...graphLinePlugin.defaults, mode: "polar", source: "250*Math.cos(5*t)", tStart: 0, tEnd: 3.1416, numPoints: 400 };
  const tight = graphLinePlugin.localBounds({ ...curve, xRange: "[-270, 270, 50]", yRange: "[-270, 270, 50]" });
  const retained = graphLinePlugin.localBounds({ ...curve }); // the ±6.28 default window
  assert.ok(tight.w <= curve.w * 1.1, `the curve's OWN window frames it inside the box (got w=${tight.w} for a ${curve.w}-wide box)`);
  // Measured: 339.5 -> 14462.3 local px, a 42.6x magnification of the same equation.
  assert.ok(retained.w > tight.w * 40, `the retained narrow window magnifies the same curve (got ${retained.w} vs ${tight.w})`);
});

// ── runner ────────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}
console.log(`\nink_bounds_test: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
