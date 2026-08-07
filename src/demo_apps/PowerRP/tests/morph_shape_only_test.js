/**
 * WORKSTREAM AV — A MORPH OWNS THE SHAPE AND NOTHING ELSE.
 * Run: node src/demo_apps/PowerRP/tests/morph_shape_only_test.js
 *
 * The user's ruling, verbatim (2026-08-02): "why do effects that are normally
 * interpolated during a morph not interpolate in the middle of the morph? … If I
 * have bloom at zero strength and then another one at full strength in the middle
 * of the morph, just like anything else, in the middle of that morph, it should
 * be interpolating, just like it normally would if it wasn't morphing. This
 * should be the same for every single property."
 *
 * THE METHOD IS A CONTROL, not a table of expected numbers, and that is the point.
 * Every assertion below renders the SAME document TWICE — once with the morph
 * live and once with `morph: "snap"`, which turns the morph off and changes
 * nothing else — and demands the non-shape half of the picture MATCH. A pinned
 * literal would go stale the moment a tween law is retuned and would never have
 * caught this bug in the first place (the wrong values were plausible: a lerp of
 * the endpoints, which is right whenever the author has not touched the interp
 * mode). The control is exactly the sentence "as if it wasn't morphing".
 *
 * The blocks:
 *
 *   TRIGGER      — a non-shape delta must not ARM a morph. An effect, a paint, a
 *                  crop or a transform keyframe is not a shape change, so
 *                  morphEndpointsDiffer says no and the auto morph never fires.
 *                  A real outline change still says yes.
 *   EFFECTS      — a genuinely morphing node composites through the effects seam,
 *                  and the whole bundle interpolates across the interior rather
 *                  than stepping at the endpoint. Matrixed over every effect key.
 *   PARITY       — the general law, leaf for leaf: at alpha 0.5 the rendered
 *                  non-shape leaves of a morphing doc equal those of the same doc
 *                  with the morph off.
 *   INTERP MODES — the sharpest case, because it is the one an endpoint blend
 *                  CANNOT get right by luck: `fill~interp: "step"` must paint the
 *                  stepped colour, not a lerp of the two endpoints.
 *   ENDPOINTS    — alpha 0 and alpha 1 stay byte-identical to no-morph, which is
 *                  the law every morph workstream inherits.
 *   TEXT GUARD   — the trap that makes the paint fix gated rather than universal:
 *                  a text/latex payload must NOT be repainted from the state's
 *                  `stroke`/`strokeWidth`, which on those widgets are the BOX
 *                  BORDER and not the letterform ink.
 */

import assert from "node:assert/strict";
import { morphEndpointsDiffer } from "../core/deltas.js";
import { repairedDocument, tweenedState } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { sceneIR, morphStateInk } from "../render_gpu/ports.js";
import { statePaint, STATE_PAINT_MARK } from "../core/morph_payload.js";
import { setGlyphOutlines } from "../core/glyph_outlines.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const registry = createRegistry();
registerPlugins(registry);
const CANVAS = { w: 1920, h: 1080 };

/** The outgoing widget every case below morphs FROM — an ordinary filled, stroked rect. */
const START = { type: "rect", x: 100, y: 100, w: 200, h: 200, fill: "#ff0000", stroke: "#000000", strokeWidth: 2, opacity: 1 };

/**
 * Query (reads the plugin registry). The rendered picture of a two-slide document
 * whose second slide applies `enter` to the one item, sampled at `alpha`.
 *
 * `enter` normally retypes the item, which is what makes a REAL shape morph; the
 * caller adds `morph: "snap"` to get the no-morph control.
 */
function render(start, enter, alpha) {
  const doc = repairedDocument({
    meta: { name: "av", w: CANVAS.w, h: CANVAS.h },
    slides: [
      { id: "s0", name: "one", transition: { type: "cut", seconds: 0 }, delta: { items: { cam: { type: "camera" }, a1: { ...start } } } },
      { id: "s1", name: "two", transition: { type: "fade", seconds: 1 }, delta: { items: { a1: enter } } },
    ],
  }, registry).doc;
  const state = evaluateState(tweenedState(doc, 1, alpha, registry), registry).state;
  const tree = deriveRenderTree(state, registry, CANVAS);
  const ops = sceneIR(tree).filter((o) => o.op !== "pushTransform" && o.op !== "popTransform");
  return { state: state.items.a1, ops };
}

/** The morphing render and its morph-off control, from the standard START pose. */
function bothWays(enter, alpha) {
  return bothWaysFrom(START, enter, alpha);
}

/** The same pair, from a caller-chosen outgoing pose (so a key can have a start VALUE to tween from).
 *  Both sides state their mode OUTRIGHT. The morphed side relied on the absent
 *  value being `auto` until the 2026-08-07 ruling made it `snap` — at which point
 *  the pair silently became two copies of the control, and a file built to prove
 *  "these are genuinely two pictures" would have gone on passing for the ones
 *  that did not compare the two. */
function bothWaysFrom(start, enter, alpha) {
  return {
    morphed: render(start, { ...enter, morph: "auto" }, alpha),
    control: render(start, { ...enter, morph: "snap" }, alpha),
  };
}

/** The ONE op a single-widget scene draws, whatever its kind (path, rect, ellipse, effectSubtree). */
function soleOp(r) {
  assert.equal(r.ops.length, 1, `expected exactly one op, got ${r.ops.map((o) => o.op).join(",")}`);
  return r.ops[0];
}

/** An effectSubtree's content ops, or the ops themselves when nothing wrapped them. */
function inkOf(r) {
  const sub = r.ops.find((o) => o.op === "effectSubtree");
  return (sub ? sub.content : r.ops).filter((o) => o.op !== "pushTransform" && o.op !== "popTransform");
}

// ── TRIGGER: WHICH DELTAS ARM A MORPH AT ALL ─────────────────────────────────

test("TRIGGER: a NON-SHAPE delta does not arm the morph — every family", () => {
  // The bug this file exists for: keyframing an effect on the entering slide (the
  // natural way to give an appearing widget its look) used to arm the auto morph,
  // and a morphed node then painted through a seam that dropped the effect.
  const cases = {
    "the effects bundle": { gaussianBlur: 12, bloom: { strength: 1 }, shadow: { opacity: 0.7 }, innerShadow: { opacity: 0.3 }, softEdges: 4, blendMode: "multiply" },
    "paint": { fill: "#0000ff", stroke: "#00ff00", strokeWidth: 9 },
    "stroke trim / join / offset": { strokeStart: 0.2, strokeEnd: 0.8, strokePhase: 0.5, strokeJoin: "round", strokeOffset: "inner" },
    "crop insets": { cropTop: 5, cropLeft: 5, cropRight: 5, cropBottom: 5 },
    "the transform": { x: 400, y: 400, w: 50, h: 50, rotation: 45, z: 3 },
    "presentation + bookkeeping": { opacity: 0.2, active: false, name: "renamed" },
  };
  for (const [family, delta] of Object.entries(cases))
    assert.equal(morphEndpointsDiffer(START, { ...START, ...delta }), false, `${family} is not a shape change`);
});

test("TRIGGER: a REAL outline change still arms it — the denylist did not become a wall", () => {
  assert.equal(morphEndpointsDiffer(START, { ...START, type: "circle" }), true, "a retype");
  assert.equal(morphEndpointsDiffer(START, { ...START, cornerRadius: 40 }), true, "a corner radius genuinely reshapes the silhouette");
  assert.equal(morphEndpointsDiffer({ type: "gear", teeth: 8 }, { type: "gear", teeth: 12 }), true, "a plugin leaf core has never heard of");
});

test("TRIGGER: a blur keyframe on the entering slide renders WITHOUT a morph at all", () => {
  // The end-to-end form of the case above: not merely "the predicate says no" but
  // "the picture is the ordinary widget". Its op is the plugin's own `rect`,
  // wrapped in the effects seam — never the morph's generic `path`.
  const { morphed } = bothWays({ gaussianBlur: 10 }, 0.5);
  const sub = soleOp(morphed);
  assert.equal(sub.op, "effectSubtree", "it composites through the effects seam");
  assert.equal(sub.blur, 10, "with the tweened radius");
  assert.equal(inkOf(morphed)[0].op, "rect", "and its ink is the plugin's OWN op — no morph was armed");
});

// ── EFFECTS: A GENUINELY MORPHING NODE STILL GETS THE BUNDLE ─────────────────

test("EFFECTS: a real shape morph composites through the effects seam", () => {
  // A retype ALONE arms the morph (that is a shape change), and the blur riding
  // along must still reach the picture. This is the second half of the fix: the
  // seam, not the trigger.
  const { morphed, control } = bothWays({ type: "circle", gaussianBlur: 10 }, 0.5);
  assert.equal(soleOp(morphed).op, "effectSubtree", "the morphed node is wrapped");
  assert.equal(soleOp(morphed).blur, soleOp(control).blur, "with the SAME radius the un-morphed control carries");
  assert.equal(inkOf(morphed)[0].op, "path", "…and its ink really is the morph's blended outline");
  assert.equal(inkOf(control)[0].op, "ellipse", "…while the control drew the plugin's own op — so these are genuinely two pictures");
});

test("EFFECTS: the whole bundle INTERPOLATES across the interior, per key", () => {
  // The user's sentence as a matrix. Each key is tweened from a SMALL start value
  // to a large one across a real shape morph, and read at three interior alphas:
  // it must rise monotonically and never merely appear at the end.
  //
  // THE START VALUE MUST EXIST ON SLIDE 0, and that is not a detail of this test —
  // it is the app's lazy-start-capture rule (core/deltas.js): a delta that ADDS a
  // key is a discrete change and lands whole at alpha > 0, because there is no
  // start value to lerp from. So a bloom that is genuinely absent beforehand
  // snapping on is CORRECT, and pinning a rise on it would pin the wrong law.
  // The user's own phrasing already says the interesting case out loud — "bloom at
  // zero strength and then another one at full strength" — a keyframe on both ends.
  // TWO ASSERTIONS PER KEY, and only one of them is about AV. PARITY (morphing ==
  // not morphing) is AV's law and holds for every key in the bundle. The RISE is
  // asserted only for the keys that are FLAT SCALARS, because the app's tween law
  // for a NESTED tree (bloom, shadow, innerShadow) is `blend`, which switches at
  // the midpoint rather than lerping — MEASURED, and identical in the control, so
  // it is a pre-existing question about nested-tree interp and NOT something a
  // morph does. Asserting a rise there would be pinning a law this workstream
  // neither owns nor changed.
  const matrix = [
    ["gaussianBlur", { gaussianBlur: 0 }, { gaussianBlur: 20 }, (o) => o.blur, true],
    ["softEdges", { softEdges: 0 }, { softEdges: 16 }, (o) => o.softEdges ?? 0, true],
    ["bloom.strength", { bloom: { radius: 10, strength: 0 } }, { bloom: { strength: 1 } }, (o) => o.bloom?.strength ?? 0, false],
    ["shadow.opacity", { shadow: { blur: 6, opacity: 0 } }, { shadow: { opacity: 1 } }, (o) => o.shadow?.opacity ?? 0, false],
    ["innerShadow.opacity", { innerShadow: { blur: 6, opacity: 0 } }, { innerShadow: { opacity: 1 } }, (o) => o.innerShadow?.opacity ?? 0, false],
  ];
  for (const [label, start, delta, read, scalar] of matrix) {
    const at = [0.25, 0.5, 0.75].map((a) => {
      const { morphed, control } = bothWaysFrom({ ...START, ...start }, { type: "circle", ...delta }, a);
      // AV'S LAW: whatever the value is, it is the SAME value the un-morphed
      // control carries — read off the whole op, so an absent effect subtree on one
      // side and not the other is itself a failure.
      assert.deepEqual(readEffect(morphed, read), readEffect(control, read), `${label} at ${a}: morphing and not morphing must agree`);
      return readEffect(morphed, read);
    });
    if (!scalar) continue;
    assert.ok(at[0] < at[1] && at[1] < at[2], `${label} RISES through the interior (${at.join(" < ")}) — it does not step at the end`);
    assert.ok(at[0] > 0, `${label} is already on at alpha 0.25 — the user's "it just flicks on" is exactly this being 0`);
  }
});

/** One effect field off a render's effectSubtree, or 0 when nothing composited (the effect is off). */
function readEffect(r, read) {
  const sub = r.ops.find((o) => o.op === "effectSubtree");
  return sub ? read(sub) : 0;
}

test("EFFECTS: blendMode is a DISCRETE leaf and still reaches a morphed node", () => {
  // Not every effect is a number. A blend mode switches at alpha > 0 like any
  // other discrete value, and the control proves the morph does not swallow it.
  const { morphed, control } = bothWays({ type: "circle", blendMode: "multiply" }, 0.5);
  assert.equal(soleOp(morphed).blend, "multiply");
  assert.equal(soleOp(morphed).blend, soleOp(control).blend);
});

// ── PARITY: THE GENERAL LAW, LEAF FOR LEAF ───────────────────────────────────

test("PARITY: every non-shape leaf of the rendered ink matches the morph-off control", () => {
  // The deliverable's real assertion. One document exercising all four families at
  // once — an effect, a paint, a transform leaf and an opacity — read off the
  // PAINTED op rather than off the state, because the state was never the broken
  // half (it is identical either way; the seams downstream were not).
  const enter = { type: "circle", gaussianBlur: 8, fill: "#0000ff", strokeWidth: 12, opacity: 0.4, w: 320 };
  for (const alpha of [0.2, 0.5, 0.8]) {
    const { morphed, control } = bothWays(enter, alpha);
    assert.equal(soleOp(morphed).blur, soleOp(control).blur, `alpha ${alpha}: blur`);
    const m = inkOf(morphed)[0], c = inkOf(control)[0];
    for (const leaf of ["fill", "stroke", "strokeWidth", "opacity"])
      assert.deepEqual(m[leaf], c[leaf], `alpha ${alpha}: ${leaf} must not depend on whether a morph is running`);
  }
});

test("PARITY: the STATE bag was never the broken half — it is identical either way", () => {
  // Stated as an assertion because it is what makes the fix small and it is what a
  // future reader will doubt. core/derive.js resolves the morph token and leaves
  // every other leaf exactly where the fold put it, which is why reading
  // node.state at the render seams is sound.
  const enter = { type: "circle", gaussianBlur: 8, fill: "#0000ff", strokeWidth: 12, opacity: 0.4 };
  const { morphed, control } = bothWays(enter, 0.5);
  for (const k of ["gaussianBlur", "fill", "strokeWidth", "opacity", "x", "y", "w", "h"])
    assert.deepEqual(morphed.state[k], control.state[k], `state.${k}`);
});

// ── INTERP MODES: THE CASE AN ENDPOINT BLEND CANNOT GET RIGHT BY LUCK ────────

test("INTERP: a `step` fill paints the STEPPED colour, not a lerp of the endpoints", () => {
  // MEASURED BEFORE THE FIX: the fold said #0000ff (step switches at alpha > 0) and
  // the morph painted #800080 — an independent re-derivation of the fold, silently
  // overriding the row's own interp mode. Every mode and every equation-valued
  // paint had the same exposure; reading the tweened bag has none of it.
  const enter = { type: "circle", fill: "#0000ff", "fill~interp": "step" };
  const { morphed, control } = bothWays(enter, 0.5);
  assert.deepEqual(inkOf(morphed)[0].fill, inkOf(control)[0].fill, "the morph must honour the row's mode");
  assert.deepEqual(inkOf(morphed)[0].fill, [0, 0, 1, 1], "…which here is the target blue, in full");
});

test("INTERP: a plain TWEEN fill still lerps — the fix did not freeze paint", () => {
  const { morphed, control } = bothWays({ type: "circle", fill: "#0000ff" }, 0.5);
  assert.deepEqual(inkOf(morphed)[0].fill, inkOf(control)[0].fill);
  const [r, g, b] = inkOf(morphed)[0].fill;
  assert.ok(r > 0 && b > 0 && g === 0, `a red→blue midpoint is purple, got ${[r, g, b]}`);
});

// ── ENDPOINTS: THE LAW EVERY MORPH WORKSTREAM INHERITS ───────────────────────

test("ENDPOINTS: alpha 0 and alpha 1 are BYTE-IDENTICAL to the morph-off control", () => {
  const enter = { type: "circle", gaussianBlur: 8, fill: "#0000ff", strokeWidth: 12, opacity: 0.4 };
  for (const alpha of [0, 1]) {
    const { morphed, control } = bothWays(enter, alpha);
    assert.deepEqual(morphed.ops, control.ops, `alpha ${alpha}: an endpoint has no morph in it to differ by`);
  }
});

// ── THE TEXT GUARD: WHY THE PAINT REREAD IS GATED ────────────────────────────

test("GUARD: the state reread fires only for payloads that DECLARE state-described ink", () => {
  // plaintext and latex spend `stroke`/`strokeWidth` on the BOX BORDER and carry
  // their glyph ink on `glyphStroke`, so an ungated reread would paint an
  // equation's letterforms with its frame's border width. The gate is the
  // payload's own mark, not a key list in core.
  const marked = { subpaths: [{ paint: statePaint({ fill: "#f00", strokeWidth: 0 }) }] };
  const unmarked = { subpaths: [{ paint: { fill: "#f00", stroke: null, strokeWidth: 0, opacity: 1 } }] };
  assert.equal(morphStateInk({ fill: "#00f" }, marked, marked).fill, "#00f", "both marked: the tweened ink wins");
  assert.equal(morphStateInk({ fill: "#00f" }, marked, unmarked), null, "one side unmarked: the endpoint blend stands");
  assert.equal(morphStateInk({ fill: "#00f" }, unmarked, unmarked), null, "neither marked: likewise");
});

test("GUARD: the mark is INVISIBLE to a key walk — the record is unchanged for every consumer", () => {
  // It is deep-equalled by tests, spread into ops and compared for run-grouping.
  const p = statePaint({ fill: "#fff", stroke: "#000", strokeWidth: 2 });
  assert.deepEqual(Object.keys(p), ["fill", "stroke", "strokeWidth", "opacity"]);
  assert.deepEqual(p, { fill: "#fff", stroke: "#000", strokeWidth: 2, opacity: 1 }, "deep-equal against a plain literal still holds");
  assert.equal(p[STATE_PAINT_MARK], true, "…while a consumer that asks by name gets its answer");
  assert.equal(JSON.parse(JSON.stringify(p))[STATE_PAINT_MARK], undefined, "and it never serializes");
});

test("GUARD: a TEXT morph is not repainted from the box border", () => {
  // End to end, and THE reason the paint reread is gated at all. A plaintext box
  // with a fat BOX-border width morphs its content; the glyph ops must not acquire
  // that width. plaintext spends `strokeWidth` on the box and carries its
  // letterform ink on `glyphStroke`, so an ungated "read s.strokeWidth" would
  // outline every letter at 30 units.
  //
  // BARE NODE HAS NO FONT ENGINE, so the real glyph-outline source is absent here
  // and a text morph would refuse (loudly, correctly). A SQUARE-PER-CHARACTER stub
  // is installed for the duration: the letterforms are wrong and irrelevant — what
  // is being measured is the PAINT on the ops, and a square carries paint exactly
  // as a real glyph does. Uninstalled in `finally` so no later suite inherits it.
  setGlyphOutlines({
    unitsPerEm: 1000,
    glyphPaths: (text) => [...text].map(() => ({ d: "M100 0L900 0L900 700L100 700Z", advance: 1000 })),
    glyphPathById: () => null,
  });
  try {
    assertTextMorphKeepsGlyphPaint();
  } finally {
    setGlyphOutlines(null);
  }
});

/** The body of the text guard above, split out so the install/uninstall pair reads as one gesture. */
function assertTextMorphKeepsGlyphPaint() {
  const doc = repairedDocument({
    meta: { name: "av-text", w: CANVAS.w, h: CANVAS.h },
    slides: [
      { id: "s0", name: "one", transition: { type: "cut", seconds: 0 }, delta: { items: { cam: { type: "camera" },
        t1: { type: "plaintext", x: 100, y: 100, w: 400, h: 120, text: "abc", font: "inter", fill: "#111111", strokeWidth: 30 } } } },
      { id: "s1", name: "two", transition: { type: "fade", seconds: 1 }, delta: { items: { t1: { text: "abd", "text~interp": "morph" } } } },
    ],
  }, registry).doc;
  const state = evaluateState(tweenedState(doc, 1, 0.5, registry), registry).state;
  const ops = sceneIR(deriveRenderTree(state, registry, CANVAS)).filter((o) => o.op === "path");
  assert.ok(ops.length > 0, "the text morph drew glyph paths");
  for (const o of ops)
    assert.notEqual(o.strokeWidth, 30, "a glyph outline must never inherit the BOX border's width");
}

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
