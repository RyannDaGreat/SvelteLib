/**
 * CSS COLOUR SPELLING guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/named_color_test.js
 *
 * THE ONE QUESTION THIS FILE ANSWERS: which colour spellings does PowerRP accept,
 * and does it refuse only what a browser would also refuse? Two defects of the
 * identical shape have shipped here — a VALID CSS colour treated as garbage — and
 * each one red-boxed a whole widget out of the paint path, in the EDITOR. So the
 * vocabulary and its case rule are pinned together.
 *
 * WHY THIS EXISTS. `render_gpu/ir.js parseColor` accepted `#hex` and `rgb()`
 * and refused everything else, and TWO suites pinned that refusal using
 * `cornflowerblue` — a VALID CSS colour — as their example of GARBAGE. So an
 * SVG spelled the way half the web spells it (`fill="red"`, measured on
 * skill-icons:fediverse-light) threw out of the paint path and red-boxed the
 * WHOLE widget in the EDITOR, not just in an export.
 *
 * The distinction the old code missed: **a valid CSS colour we merely do not
 * support is not garbage.** Widening the capability is not weakening the
 * refusal, so this file pins both halves at once.
 *
 * WHAT IT PROVES:
 *   (1) every keyword in the vocabulary parses — the SET, not one membership
 *       (the DRAW_OPS lesson: a one-entry tautology gates nothing);
 *   (2) the table's values are the spec's, spot-checked, and the spec's
 *       gray/grey and aqua/cyan ALIASES really are equal;
 *   (3) keywords are ASCII case-insensitive, as CSS requires;
 *   (4) genuine garbage still throws, including an inherited Object key
 *       ("constructor") which a bare table index would have accepted;
 *   (5) THE MEASURED REGRESSION: an SVG whose only paint is `fill="red"`
 *       flattens, emits and resolves to red — no throw, no error affordance,
 *       and no flatten WARNING either (a named colour is not a degrade, so it
 *       must not borrow the first-stop-solid band's voice);
 *   (6) EVERY spelling is ASCII case-insensitive, swept over the whole
 *       vocabulary rather than a hand-picked sample — because the second defect
 *       was `RGB(255,0,0)` throwing while `#FF0000` and `RED` did not, i.e. two
 *       of three spellings had remembered the rule and one had not;
 *   (7) but an SVG **id** is case-SENSITIVE, so `url(#GradA)` must NOT find a
 *       def named `grada`. A blanket lowercase would have broken that, and it is
 *       the reason resolvePaint folds per comparison instead of folding `v`.
 *
 * THE ORACLE for (6) and (7) is a real browser, not the CSS spec as I read it:
 * `.frenzy/round6/scratchpad_W4S_cssoracle.mjs` renders each spelling as an SVG
 * presentation attribute and reads getComputedStyle. Measured there —
 * `fill="NONE"` computes to `none`, `fill="RGB(255,0,0)"` and `fill="RED"` to
 * `rgb(255, 0, 0)`, and all three of `currentcolor` / `currentColor` /
 * `CURRENTCOLOR` to the element's `color`. (It also showed `fill="notacolour"`
 * computing to BLACK — a browser's silent fallback. We throw instead, and keep
 * throwing: that is the one place we deliberately differ.)
 */

import assert from "node:assert/strict";
import { parseColor, parsePaint, cssNamedColorKeywords } from "../render_gpu/ir.js";
import { flattenSvgTree, resolvePaint } from "../core/svg_paths.js";
import { parseSvgToTree } from "../render_gpu/gpu/svg_raster.js";
import { svgPlugin } from "../plugins/svg.js";

const BOX = 200; // the widget box these checks emit into
const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };
const INK = "#000000"; // resolvePaint's currentColor ink; irrelevant to a named colour
// A minimal collectGradients-shaped def, for the url(#id) case checks.
const LINEAR_GRADIENT = { type: "linearGradient", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };

// The measured failure: skill-icons:fediverse-light spells its paint `fill="red"`.
const NAMED_FILL_SVG = '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="red"/></svg>';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) the whole vocabulary parses ───────────────────────────────────────────

test("every keyword in the vocabulary parses to four finite 0..1 channels", () => {
  const names = cssNamedColorKeywords();
  // 148 <named-color> keywords (CSS Color Module Level 4) + the `transparent`
  // CSS-wide keyword. A drop in this count means the table lost entries.
  assert.equal(names.length, 149, "148 named colours + transparent");
  assert.deepEqual(names, [...new Set(names)], "no duplicate keyword");
  for (const name of names) {
    const rgba = parseColor(name);
    assert.equal(rgba.length, 4, `${name}: four channels`);
    for (const c of rgba) assert.ok(Number.isFinite(c) && c >= 0 && c <= 1, `${name}: channel ${c} out of 0..1`);
  }
});

test("a named colour is a PAINT too — parsePaint resolves it, so any fill/stroke row takes one", () => {
  assert.deepEqual(parsePaint("red"), [1, 0, 0, 1]);
  assert.deepEqual(parsePaint("transparent"), [0, 0, 0, 0]);
});

// ── (2) the values are the spec's, and the spec's aliases agree ───────────────

test("spot values match the CSS spec", () => {
  assert.deepEqual(parseColor("red"), [1, 0, 0, 1]);
  assert.deepEqual(parseColor("white"), [1, 1, 1, 1]);
  assert.deepEqual(parseColor("black"), [0, 0, 0, 1]);
  assert.deepEqual(parseColor("cornflowerblue"), parseColor("#6495ed"));
  assert.deepEqual(parseColor("rebeccapurple"), parseColor("#663399"));
  assert.deepEqual(parseColor("transparent"), [0, 0, 0, 0]);
});

test("the spec's SPELLING ALIASES are the same colour", () => {
  // These pairs are one colour with two spellings in the spec, not two colours
  // that happen to match — a table typo shows up here before it shows up on screen.
  for (const [a, b] of [["gray", "grey"], ["darkgray", "darkgrey"], ["dimgray", "dimgrey"],
    ["lightgray", "lightgrey"], ["slategray", "slategrey"], ["darkslategray", "darkslategrey"],
    ["lightslategray", "lightslategrey"], ["aqua", "cyan"], ["fuchsia", "magenta"]])
    assert.deepEqual(parseColor(a), parseColor(b), `${a} === ${b}`);
});

// ── (3) case-insensitivity ────────────────────────────────────────────────────

/** Pure function. "cornflowerblue" -> "CoRnFlOwErBlUe" — the spelling most likely
 * to catch a comparison that folded only one side.
 * @example alternatingCase("rgb(1,2,3)") // "RgB(1,2,3)"
 */
function alternatingCase(s) {
  return [...s].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join("");
}

test("EVERY accepted spelling is ASCII case-insensitive — swept, not sampled", () => {
  // The whole vocabulary plus one instance of each non-name spelling. The sweep
  // is the point: "cornflowerblue" and "#FF0000" both worked while
  // "RGB(255,0,0)" threw, so any hand-picked sample can miss the one that drifted.
  const corpus = [...cssNamedColorKeywords(), "#f00", "#f00c", "#ff0000", "#ff0000cc",
    "rgb(255,0,0)", "rgba(255,0,0,0.5)", "rgb( 12 , 34 , 56 )"];
  for (const spelling of corpus) {
    const canonical = parseColor(spelling);
    for (const variant of [spelling.toUpperCase(), spelling.toLowerCase(), alternatingCase(spelling)])
      assert.deepEqual(parseColor(variant), canonical, `${variant} must equal ${spelling}`);
  }
});

// ── (4) the refusal survives ──────────────────────────────────────────────────

test("genuine garbage still throws, loudly", () => {
  assert.throws(() => parseColor("notacolour"), /unsupported color/);
  assert.throws(() => parseColor("#gg"), /unsupported color/);
  assert.throws(() => parseColor("reddish"), /unsupported color/, "a prefix of a keyword is not a keyword");
  assert.throws(() => parseColor(" red"), /unsupported color/, "parseColor does not trim — callers hand it a trimmed value");
  // A bare `TABLE[name]` index would have returned Object.prototype.constructor
  // here (truthy), and the hex parser would then have died on a function with a
  // TypeError instead of this sentence.
  for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"])
    assert.throws(() => parseColor(inherited), /unsupported color/, inherited);
});

// ── (5) the measured regression ───────────────────────────────────────────────

test("REGRESSION: an SVG whose only paint is fill=\"red\" renders red, in the EDITOR path", () => {
  const flat = flattenSvgTree(parseSvgToTree(NAMED_FILL_SVG), BOX, BOX, {});
  assert.deepEqual(flat.warnings, [], "a named colour is not a degrade — no warning band");
  assert.equal(flat.ops.length, 1, "one path op");
  assert.equal(flat.ops[0].fill, "red", "flatten passes the keyword through verbatim");

  const ops = svgPlugin.emit({ ...svgPlugin.defaults, svgSrc: NAMED_FILL_SVG, x: 0, y: 0, w: BOX, h: BOX }, null, IDENTITY_WORLD);
  // The old failure was a THROW here, out of emit's parsePaint, which the
  // per-node paint boundary turned into the full-box red errorAffordance.
  const paths = ops.filter((o) => o.op === "path");
  assert.equal(paths.length, 1, "the art still emits (not replaced by an error affordance)");
  assert.deepEqual(paths[0].fill, [1, 0, 0, 1], "and it is RED");
});

test("resolvePaint hands a named colour straight through, with no warning", () => {
  const warnings = new Set();
  assert.equal(resolvePaint("red", INK, {}, warnings), "red");
  assert.equal(resolvePaint("  CornflowerBlue  ", INK, {}, warnings), "CornflowerBlue", "trimmed, case preserved");
  assert.deepEqual([...warnings], [], "no punt notice — the colour is honoured exactly");
});

test("resolvePaint's KEYWORDS fold too — `fill=\"NONE\"` is paint-nothing, not a dead widget", () => {
  // Before the fold, "NONE" fell through as a colour string and threw in
  // parseColor: the worst reading of the two, since it turned "paint nothing"
  // into "kill the widget". Every case of every keyword, derived by folding.
  for (const spelling of ["none", "NONE", "None", alternatingCase("none")])
    assert.equal(resolvePaint(spelling, INK, {}, new Set()), null, spelling);
  // `currentcolor` is the CSS Color 4 canonical spelling; `currentColor` is the
  // historical SVG one. Both, and any case, resolve to the ink.
  for (const spelling of ["currentColor", "currentcolor", "CURRENTCOLOR", alternatingCase("currentcolor")])
    assert.equal(resolvePaint(spelling, INK, {}, new Set()), INK, spelling);
  for (const spelling of ["url(#g)", "URL(#g)", "Url( #g )"])
    assert.equal(resolvePaint(spelling, INK, { g: LINEAR_GRADIENT }, new Set()), LINEAR_GRADIENT, spelling);
});

test("but an SVG **id** is case-SENSITIVE — the fold is per keyword, never on the whole value", () => {
  // This is why resolvePaint does not simply lowercase `v`. If it did, this
  // lookup would succeed and an author's two distinct gradients would collide.
  const warnings = new Set();
  assert.equal(resolvePaint("url(#GradA)", INK, { grada: LINEAR_GRADIENT }, warnings), null,
    "a lowercase def must NOT answer for an uppercase reference");
  assert.equal([...warnings].length, 1, "and the miss is reported, not silent");
  assert.match([...warnings][0], /not found/);
  assert.equal(resolvePaint("url(#GradA)", INK, { GradA: LINEAR_GRADIENT }, new Set()), LINEAR_GRADIENT,
    "the exactly-spelled def is found");
});

console.log(`\n${passed} CSS colour spelling tests passed.`);
