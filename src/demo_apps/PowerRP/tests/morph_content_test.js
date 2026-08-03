/**
 * MORPH PHASE 3 — THE CONTENT MORPHS, plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/morph_content_test.js
 *
 * tests/morph_test.js pins the ENGINE and tests/morph_mode_test.js pins the
 * TYPE-CHANGE wiring. This suite pins what phase 3 added — the two widgets whose
 * ink is TYPE (an equation and a text box), and the morph that runs when the
 * `type` never changes at all:
 *
 *   LATEX PAYLOAD   — the provider maps MathJax's ROOT VIEWBOX onto the widget
 *                     box with the SAME letterbox fit the PDF/SVG backends apply
 *                     to those same glyphs. A fourth spelling of that mapping is
 *                     how a morph's first frame would jump away from the pixels
 *                     the widget was showing at alpha 0, so it is one function
 *                     and this block measures it against a REAL captured
 *                     equation (tests/fixtures/latex_equation_vector.js — the
 *                     quadratic formula, flattened by the runtime path itself).
 *   TEXT PAYLOAD    — the glyph-outline seam, which is INJECTED (bare node has
 *                     no faces until a render side installs one) and therefore
 *                     has to behave honestly when it is absent: no outlines, a
 *                     named wait, and NO morph rather than a collapsed one.
 *   CONTENT TOKEN   — the user's sharpest catch: editing an equation's source
 *                     never changes `type`, so the type-morph never engages. The
 *                     fold law for the content token, endpoints included.
 *   APPLICABILITY   — the mode select must stop offering modes that mean nothing
 *                     for a row. The TYPE row's option list is pinned exactly.
 *
 * Bare node throughout: no MathJax (browser-only), no CanvasKit faces. That is
 * not a limitation being worked around — it is the condition the not-ready hooks
 * exist for, so two of these blocks measure the ABSENT case on purpose.
 */

import assert from "node:assert/strict";
import { blendApplied, applied } from "../core/deltas.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { morphPayloadFromViewBox, viewBoxToBoxMatrix } from "../core/morph_payload.js";
import { assertMorphPaths } from "../core/morph.js";
import {
  CONTENT_MORPH_TOKEN,
  isContentMorphToken,
  contentMorphKeyFor,
  modesForKey,
  interpMode,
  TYPE_KEY,
} from "../core/interp_modes.js";
import { glyphOutlinesReady, setGlyphOutlines, textMorphPayload } from "../core/glyph_outlines.js";
import { LATEX_EQUATION_VIEWBOX, LATEX_EQUATION_GLYPHS } from "./fixtures/latex_equation_vector.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const registry = createRegistry();
registerPlugins(registry);
const latexPlugin = registry.get("latex");
const plaintextPlugin = registry.get("plaintext");

// ── LATEX PAYLOAD ─────────────────────────────────────────────────────────────

test("latex: a REAL captured equation becomes a valid morph payload", () => {
  // The fixture is the runtime flatten's own output for the quadratic formula,
  // so this measures the provider against geometry MathJax actually produced —
  // not against a hand-drawn square that would agree with any mapping at all.
  const box = { w: 360, h: 92 };
  const payload = morphPayloadFromViewBox(
    LATEX_EQUATION_GLYPHS.map((g) => ({ d: g.d, paint: { fill: "#000000", stroke: null, strokeWidth: 0, opacity: 1 } })),
    LATEX_EQUATION_VIEWBOX, box,
  );
  // assertMorphPaths is the engine's own gate: cubics only, non-negative space,
  // every subpath well-formed. A payload that passes it can be morphed.
  assertMorphPaths(payload, "latex fixture");
  assert.deepEqual(payload.space, box, "the payload's space IS the widget box");
  assert.ok(payload.subpaths.length >= LATEX_EQUATION_GLYPHS.length,
    `every glyph must contribute at least one contour (${LATEX_EQUATION_GLYPHS.length} glyphs → ${payload.subpaths.length} subpaths)`);
  assert.equal(payload.fillRule, "nonzero", "font-derived outlines are nonzero-wound — counters are holes, not fills");
});

test("latex: the payload lands INSIDE the widget box, letterboxed like the ink", () => {
  // THE MAPPING TEST. MathJax's viewBox has a NEGATIVE minY (the ascender space
  // above the baseline) and a wildly non-square aspect, so a provider that
  // forgot the origin subtraction or the fit would put the equation outside its
  // own box — visible instantly at alpha 0.01 and invisible in every unit test
  // that only checks "some subpaths came out".
  // A DELIBERATELY TALL box (aspect 1.6 against the equation's ~3.93), so the
  // letterbox slack is large and the final assertion below is decisive. A box at
  // the equation's own aspect would leave almost no slack and the same assertion
  // would pass whether the fit were uniform or not — a test that cannot fail.
  const box = { w: 360, h: 225 };
  const payload = morphPayloadFromViewBox(
    LATEX_EQUATION_GLYPHS.map((g) => ({ d: g.d })), LATEX_EQUATION_VIEWBOX, box,
  );
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of payload.subpaths) {
    const pts = [sp.start, ...sp.curves.flatMap((c) => [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]]])];
    for (const [x, y] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  // A small tolerance for Bézier CONTROL points, which may sit marginally outside
  // the ink they draw — the ink itself is what the box contains.
  const slack = 2;
  assert.ok(minX >= -slack && maxX <= box.w + slack, `x extent ${minX}..${maxX} must sit within 0..${box.w}`);
  assert.ok(minY >= -slack && maxY <= box.h + slack, `y extent ${minY}..${maxY} must sit within 0..${box.h}`);
  // The equation is much wider than it is tall, so a UNIFORM fit must letterbox
  // it vertically — i.e. it may NOT reach the box's full height. This is the
  // assertion that fails if preserveAspect is dropped and the fit becomes a
  // per-axis stretch.
  assert.ok(maxY - minY < box.h, "a wide equation letterboxes: its ink is shorter than the box");
});

test("latex: preserveAspect OFF stretches each axis independently", () => {
  const vb = { minX: 0, minY: 0, w: 20, h: 10 };
  const uniform = viewBoxToBoxMatrix(vb, { w: 20, h: 20 }, true);
  const stretched = viewBoxToBoxMatrix(vb, { w: 20, h: 20 }, false);
  assert.equal(uniform.a, uniform.d, "a uniform fit scales both axes alike");
  assert.ok(uniform.f > 0, "and centres the slack it leaves");
  assert.notEqual(stretched.a, stretched.d, "the OFF form fills the box on both axes");
  assert.equal(stretched.f, 0, "and leaves no slack to centre");
});

test("latex: morphNotReady names the THREE distinct waits", () => {
  // Bare node has no MathJax, so every equation here is genuinely un-typeset —
  // which is exactly the state the hook exists to describe. A morph that ran
  // anyway would blend against an empty payload: every contour collapsing to a
  // point, which reads as the equation imploding rather than as "not ready".
  assert.match(latexPlugin.morphNotReady({ latex: "" }), /has none/, "an empty widget says so");
  assert.match(latexPlugin.morphNotReady({ latex: "x^2" }), /typesetting/, "an un-typeset equation names MathJax");
  assert.equal(typeof latexPlugin.morphPaths, "function", "the capability is declared, so the pair policy can see it");
});

// ── TEXT PAYLOAD (the injected glyph-outline seam) ────────────────────────────

test("text: with NO outline source installed, the seam refuses rather than lying", () => {
  // THE HONEST-ABSENCE LAW. CanvasKit 0.41.1 has no glyph-outline API (measured:
  // Font exposes getGlyphBounds/getGlyphIDs/getGlyphWidths and nothing that
  // returns a path), so outlines come from an INJECTED source that only a render
  // side installs. In bare node with nothing installed there is no honest
  // payload, and the alternative to refusing is a payload of empty contours —
  // which morphs as a collapse to a point and looks like a bug in the engine.
  setGlyphOutlines(null);
  assert.equal(glyphOutlinesReady(), false, "nothing installed ⇒ not ready");
  assert.match(plaintextPlugin.morphNotReady({ text: "hi" }), /outline/i,
    "and the widget says which seam is missing, not merely that it failed");
});

test("text: an EMPTY box is not-ready for a reason of its own", () => {
  assert.match(plaintextPlugin.morphNotReady({ text: "" }), /no text|has none/i,
    "an empty text box has no ink to morph, which is a different sentence from a missing seam");
});

test("text: an INSTALLED outline source produces a laid-out payload in the box", () => {
  // A STUB source, deliberately: this block is about the seam's contract (the
  // layout, the frame, the per-glyph placement), not about any particular font's
  // letterforms. Each glyph becomes a unit square at its own pen position, so
  // the assertions below can state exact numbers — a real face is exercised by
  // the render side that installs one.
  setGlyphOutlines({
    // (text, style) → [{d, advance}] in EM units, y-UP from the baseline, the
    // shape a font file's own outlines have.
    glyphPaths: (text) => [...text].map(() => ({ d: "M0 0L1 0L1 1L0 1Z", advance: 1 })),
    unitsPerEm: 1,
  });
  try {
    const payload = textMorphPayload({ text: "abc", size: 10, w: 200, h: 40 });
    assertMorphPaths(payload, "text stub");
    assert.equal(payload.subpaths.length, 3, "one contour per glyph");
    assert.deepEqual(payload.space, { w: 200, h: 40 }, "the payload's space IS the widget box");
    // The three glyphs must be at DISTINCT pen positions — a provider that
    // forgot to advance would stack every letter on the first one, which morphs
    // as a single blob and is invisible in a glyph-COUNT assertion.
    const xs = payload.subpaths.map((sp) => sp.start[0]);
    assert.equal(new Set(xs).size, 3, `the glyphs must be laid out left to right, got xs=${xs}`);
    assert.ok(xs[0] < xs[1] && xs[1] < xs[2], `and in reading order, got xs=${xs}`);
  } finally {
    setGlyphOutlines(null);
  }
});

test("text: the payload is y-DOWN, like every other payload in the engine", () => {
  // A font's outlines are y-UP from the baseline; the engine's frame is y-DOWN
  // box-local (core/morph.js's Subpath contract). Getting this wrong renders
  // every morph into text UPSIDE DOWN, and it is the single easiest mistake at
  // this seam because both frames are "obviously" correct in their own world.
  setGlyphOutlines({
    // One glyph, an L-shaped mark whose ink sits ABOVE the baseline (positive y
    // in font space) — so a correct flip puts it ABOVE the baseline in box
    // space too, i.e. at a SMALLER y than the baseline.
    glyphPaths: () => [{ d: "M0 0L1 0L1 1L0 1Z", advance: 1 }],
    unitsPerEm: 1,
  });
  try {
    const payload = textMorphPayload({ text: "a", size: 10, w: 100, h: 100 });
    const ys = payload.subpaths[0].curves.map((c) => c[5]);
    const top = Math.min(...ys), bottom = Math.max(...ys);
    assert.ok(bottom - top > 0, "the glyph has vertical extent");
    // The ink is above the baseline, and the baseline sits below it in y-DOWN
    // coordinates, so every ink y must be less than the baseline's.
    assert.ok(bottom <= payload.baselineY + 1e-9,
      `ink at y ${bottom} must sit at or above the baseline y ${payload.baselineY} (y-DOWN)`);
  } finally {
    setGlyphOutlines(null);
  }
});

// ── THE CONTENT TOKEN ────────────────────────────────────────────────────────

test("content: a keyframed SOURCE folds to a content token strictly inside", () => {
  // The user's catch: editing an equation between slides never touches `type`,
  // so the type-morph never engages. `morph` on the CONTENT key is what makes
  // that edit continuous.
  const from = { type: "latex", latex: "a^2", "latex~interp": "morph" };
  const delta = { latex: "b^2" };
  const mid = blendApplied(from, delta, 0.5);
  assert.ok(isContentMorphToken(mid.latex), `mid-transition must be a content token, got ${JSON.stringify(mid.latex)}`);
  assert.equal(mid.latex.from, "a^2", "carrying the OUTGOING source verbatim");
  assert.equal(mid.latex.to, "b^2", "and the INCOMING one");
  assert.equal(mid.latex.t, 0.5, "plus the alpha");
});

test("content: THE ENDPOINT LAW — alpha 1 is the exact target string", () => {
  // This is the law that matters most. `applied()` IS blendApplied(…, 1), and
  // core/document.js slideState folds every slide through it — so a mode that
  // left a token at alpha 1 would write that token into every cached slide
  // state, every undo entry and every serialized document.
  const from = { type: "latex", latex: "a^2", "latex~interp": "morph" };
  const delta = { latex: "b^2" };
  assert.equal(applied(from, delta).latex, "b^2", "alpha 1 is the stored string, not a token");
  assert.equal(blendApplied(from, delta, 1).latex, "b^2");
  assert.equal(blendApplied(from, delta, 0).latex, "a^2", "and alpha 0 is the outgoing one, untouched");
});

test("content: the token carries STRINGS, which is why it may ride the fold", () => {
  // The geometry deliberately does NOT go in the token — core/interp_modes.js's
  // argument for `~morph`, one layer down. Two source strings are three scalars'
  // worth of state; two payloads would put a whole path list into every cached
  // slide state the fold touches.
  const from = { text: "hello", "text~interp": "morph" };
  const mid = blendApplied(from, { text: "world" }, 0.25);
  assert.equal(typeof mid.text.from, "string");
  assert.equal(typeof mid.text.to, "string");
  assert.equal(mid.text.type, CONTENT_MORPH_TOKEN);
  assert.ok(!("subpaths" in mid.text), "no geometry in the fold");
});

test("content: an UNCHANGED source produces no token", () => {
  const from = { latex: "a^2", "latex~interp": "morph" };
  assert.equal(blendApplied(from, { latex: "a^2" }, 0.5).latex, "a^2",
    "nothing changed, so there is nothing to morph — and a token would make the render do work for no picture");
});

test("content: contentMorphKeyFor names each widget's content leaf", () => {
  assert.equal(contentMorphKeyFor("latex"), "latex", "the equation's source");
  assert.equal(contentMorphKeyFor("plaintext"), "text", "the text box's string");
  assert.equal(contentMorphKeyFor("rect"), null, "a shape has no content leaf — its outline IS its geometry");
});

// ── APPLICABILITY ────────────────────────────────────────────────────────────

test("applicability: the TYPE row offers auto/morph/step and NOTHING else", () => {
  // User ruling, verbatim: "Tween doesn't really make sense in terms of widget
  // type interpolation... blend and tween, those don't really make any sense".
  // A select that offers a mode which cannot do anything for the row is a
  // confident wrong answer, so the list is pinned EXACTLY rather than as a
  // subset check — an option added by a later wave must come here and argue for
  // itself.
  const ids = modesForKey(TYPE_KEY, "rect");
  assert.deepEqual(ids, ["auto", "step", "morph"],
    `the type row's options are pinned; got ${JSON.stringify(ids)}`);
  // Stated separately from the deepEqual so a failure names the RULE rather than
  // just a list mismatch: these three are the modes the user said do not belong.
  for (const gone of ["tween", "fade", "blend"])
    assert.ok(!ids.includes(gone), `"${gone}" must not be offered on the type row — it has no meaning for a widget type`);
});

test("applicability: `visible`/`active` offers step and fade, not morph", () => {
  const ids = modesForKey("active", false);
  assert.ok(ids.includes("step") && ids.includes("fade"), `a boolean fades or steps, got ${ids}`);
  assert.ok(!ids.includes("morph"), "there is no outline to reshape on a boolean");
  assert.ok(!ids.includes("blend"), "and nothing to composite");
});

test("applicability: a NUMERIC row offers tween and step, not blend or morph", () => {
  const ids = modesForKey("x", 0);
  assert.ok(ids.includes("tween") && ids.includes("step"), `a number tweens or steps, got ${ids}`);
  assert.ok(!ids.includes("morph"), "a coordinate has no outline");
  assert.ok(!ids.includes("blend"), "and no second operand to draw");
});

test("applicability: a PAINT row offers blend, and a CONTENT key offers morph", () => {
  const paintIds = modesForKey("fill", { type: "material", material: { id: "crt" } });
  assert.ok(paintIds.includes("blend"), `a material must offer the crossfade, got ${paintIds}`);
  const contentIds = modesForKey("latex", "x^2", "latex");
  assert.ok(contentIds.includes("morph"), `an equation's source must offer morph, got ${contentIds}`);
});

test("applicability: every mode's help says what it DOES, in one sentence", () => {
  // User, verbatim: "what the hell is the difference between fade and blend?".
  // The answer has to be in the UI, and it has to distinguish the pair rather
  // than describe each one in isolation — so both help strings are required to
  // name their own mechanism.
  assert.match(interpMode("fade").help, /opacity/i, "Fade is an opacity ramp");
  assert.match(interpMode("blend").help, /both/i, "Blend draws BOTH and composites — the distinguishing fact");
  assert.match(interpMode("morph").help, /outline/i, "Morph reshapes outlines");
  assert.match(interpMode("step").help, /start|instant|jump/i, "Step snaps at the start");
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exit(1);
