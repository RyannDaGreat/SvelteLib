/**
 * THE TWO NAMED VISIBILITY MODES — blurFade (WORKSTREAM FF2) and Manim
 * (WORKSTREAM JJ). Plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/manim_blurfade_test.js
 *
 * The laws, one block each:
 *
 *   TOKEN         — both modes fold to `~visibleFx` carrying a NAME and a
 *                   coverage, and the ENDPOINTS stay exact booleans. The
 *                   endpoints matter more than the middle: applied() IS
 *                   blendApplied(…, 1), so a mode disagreeing at 1 would rewrite
 *                   every cached slide state and every export.
 *   BLURFADE      — opacity and radius are pinned at three alphas, and v = 1 is
 *                   BYTE-IDENTICAL to the same widget with no mode at all.
 *   MANIM PHASES  — at v = 0.3 there is a partial outline and NO fill; at
 *                   v = 0.75 a full outline and a partial fill. That is the
 *                   user's own sentence ("the border is kind of drawn first and
 *                   then the inside is filled") as an assertion.
 *   ARC LENGTH    — THE ONE PLACE WE BEAT MANIM, and the one a regression would
 *                   silently undo. A long-straight-plus-short-curl payload
 *                   trimmed at half must cut inside the LONG curve; a
 *                   curve-index port cuts at the junction instead, which looks
 *                   plausible and is wrong.
 *   STAGGER       — the per-subpath ordering: earlier contours are never behind
 *                   later ones, and a full lag makes them strictly sequential.
 *   REVERSAL      — v decreasing is the SAME function, verified rather than
 *                   built: the plan at v and at 1 − v are mirror images.
 *   FALLBACK      — a widget with no outline fades and does not throw.
 */

import assert from "node:assert/strict";
import { blendApplied, applied } from "../core/deltas.js";
import { repairedDocument, tweenedState } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { sceneIR, manimIR, manimSketchStroke, manimStatePaint, canStrokeWithPaint, blurFadeState, BLUR_FADE_MAX_RADIUS } from "../render_gpu/ports.js";
import {
  VISIBLE_FX_TOKEN,
  isVisibleFxToken,
  visibleLevel,
  interpMode,
  interpParamKeyFor,
  isInterpParamKey,
  modeParams,
  modesForKey,
} from "../core/interp_modes.js";
import {
  MANIM_PHASE_SPLIT,
  MANIM_SKETCH_STROKE_WIDTH,
  doubleSmooth,
  manimDrawPlan,
  manimLagRatio,
  sketchPaintTiers,
  sketchStrokePaint,
  subpathLengths,
  trimSubpathByLength,
} from "../core/manim_draw.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const registry = createRegistry();
registerPlugins(registry);

/** A rect with a blue stroke over a red fill — the widget every render law below is measured on. */
const RECT = { type: "rect", x: 0, y: 0, w: 100, h: 60, fill: "#ff0000", stroke: "#0000ff", strokeWidth: 3 };
const CANVAS = { w: 1920, h: 1080 };

/** The scene IR for one item, with the structural push/pop ops dropped. */
function inkOps(state) {
  const tree = deriveRenderTree({ items: { a1: state }, vars: {} }, registry, CANVAS);
  return sceneIR(tree).filter((o) => o.op !== "pushTransform" && o.op !== "popTransform");
}

/** The `active` token a named mode folds to mid-transition. */
const fx = (mode, v) => ({ type: VISIBLE_FX_TOKEN, mode, v });

// ── THE TOKEN, AND THE ENDPOINT LAW ──────────────────────────────────────────

test("both modes fold to a NAMED token strictly inside the transition", () => {
  for (const mode of ["blurFade", "manim"]) {
    const mid = blendApplied({ active: false }, { active: true, "active~interp": mode }, 0.25).active;
    assert.ok(isVisibleFxToken(mid), `${mode} must mint a token, not a bare number`);
    assert.equal(mid.mode, mode, "the token names WHICH mode — that is its whole reason to exist");
    assert.equal(mid.v, 0.25);
  }
});

test("THE ENDPOINTS ARE EXACT BOOLEANS — no token ever reaches a folded slide state", () => {
  for (const mode of ["blurFade", "manim"]) {
    const delta = { active: true, "active~interp": mode };
    assert.equal(applied({ active: false }, delta).active, true, "alpha 1 is the stored target");
    assert.equal(blendApplied({ active: false }, delta, 1).active, true);
    assert.equal(blendApplied({ active: false }, delta, 0).active, false, "alpha 0 leaves `a` untouched");
  }
});

test("HIDING is the same rule reversed, with no branch", () => {
  const out = blendApplied({ active: true }, { active: false, "active~interp": "manim" }, 0.25).active;
  assert.equal(out.v, 0.75, "true → false at alpha 0.25 is still 75% visible");
});

test("the Inspector picks both up automatically — appliesTo, not a hand-edited list", () => {
  const ids = modesForKey("active", false);
  assert.ok(ids.includes("blurFade") && ids.includes("manim"));
  assert.ok(!modesForKey("x", 0).includes("manim"), "a coordinate has no coverage to draw in");
  assert.equal(interpMode("blurFade").label, "Blur Fade");
  assert.equal(interpMode("manim").label, "Manim", "the user's own name for it");
});

test("visibleLevel reads every `active` shape, token included", () => {
  assert.equal(visibleLevel(true), 1);
  assert.equal(visibleLevel(false), 0);
  assert.equal(visibleLevel(undefined), 1, "absent means visible — matching derive's `active !== false`");
  assert.equal(visibleLevel(0.25), 0.25, "a plain `fade` fraction still works");
  assert.equal(visibleLevel(fx("manim", 0.4)), 0.4);
});

// ── BLURFADE: OPACITY AND RADIUS, PINNED ─────────────────────────────────────

test("BLURFADE: opacity and radius at three alphas", () => {
  // AGAINST THE CONSTANT, not against three literals: the amount is the mode's
  // declared default now (WORKSTREAM AP raised it 24 → 64), and a hardcoded
  // triple here would pin the number rather than the LAW it is supposed to pin.
  for (const v of [0.25, 0.5, 0.75]) {
    const blur = BLUR_FADE_MAX_RADIUS * (1 - v);
    const ops = inkOps({ ...RECT, active: fx("blurFade", v) });
    assert.equal(ops.length, 1, "the whole widget composites as ONE effect subtree");
    assert.equal(ops[0].op, "effectSubtree");
    assert.equal(ops[0].blur, blur, `radius is ${BLUR_FADE_MAX_RADIUS}·(1 − v)`);
    assert.equal(ops[0].opacity, v, "and the coverage rides the same multiplication `fade` uses");
  }
});

test("BLURFADE: v = 1 is BYTE-IDENTICAL to the same widget with no mode", () => {
  const plain = inkOps({ ...RECT, active: true });
  const ended = inkOps({ ...RECT, active: fx("blurFade", 1) });
  assert.deepEqual(ended, plain);
  assert.equal(plain[0].op, "rect", "no effectSubtree at all — the effects seam never engaged");
});

test("BLURFADE ADDS to the author's own blur, never replacing it", () => {
  assert.equal(blurFadeState({ active: fx("blurFade", 0.5), gaussianBlur: 4 }).gaussianBlur, 4 + BLUR_FADE_MAX_RADIUS / 2);
  const settled = blurFadeState({ active: fx("blurFade", 1), gaussianBlur: 4 });
  assert.equal(settled.gaussianBlur, 4, "at v = 1 the widget lands on EXACTLY its authored blur");
});

test("BLURFADE state is returned BY IDENTITY for every other node", () => {
  const s = { ...RECT, active: true };
  assert.equal(blurFadeState(s), s);
  const m = { ...RECT, active: fx("manim", 0.5) };
  assert.equal(blurFadeState(m), m, "a different named mode adds no blur");
});

// ── WORKSTREAM AP: THE TARGET BLUR, AND THE AMOUNT KNOB ──────────────────────
//
// User, 2026-08-02, verbatim, two messages: "the blur fade should be animating
// from big blur to whatever blur is in the target. Right now it always animates
// to zero blur, which is not the right move when the element has blur that it's
// going towards." and "BlurFade should have suboptions, by the way… I should be
// able to choose how blurry was it… BlurFade is too subtle for me right now…
// also by default have it blurrier".
//
// The first message was REPRODUCED through the whole real pipeline before
// anything was changed, and the composition arithmetic was already converging to
// the target. The convergence-to-zero an author sees comes from the UNIVERSAL
// MORPH swallowing the effects bundle (WORKSTREAM AV), which the last test in
// this block pins as a live defect so it cannot be forgotten or mistaken for
// this mode's business again.

/** The whole shipped path a real author's document takes: repair → fold → evaluate → IR. */
function documentInkOps(itemExtra, enteringDelta, alpha) {
  const doc = repairedDocument({
    meta: { name: "ap", w: CANVAS.w, h: CANVAS.h },
    slides: [
      { id: "s0", name: "one", transition: { type: "cut", seconds: 0 }, delta: { items: { cam: { type: "camera" }, a1: { ...RECT, active: false, ...itemExtra } } } },
      { id: "s1", name: "two", transition: { type: "fade", seconds: 1 }, delta: { items: { a1: { active: true, "active~interp": "blurFade", ...enteringDelta } } } },
    ],
  }, registry).doc;
  const state = evaluateState(tweenedState(doc, 1, alpha, registry), registry).state;
  const tree = deriveRenderTree(state, registry, CANVAS);
  return sceneIR(tree).filter((o) => o.op !== "pushTransform" && o.op !== "popTransform");
}

test("AP REPRO: an authored blur is the TARGET — the radius converges to it, not to zero", () => {
  const TARGET = 10;
  // `morph: "snap"` isolates this mode from WORKSTREAM AV's defect (pinned below).
  const radii = [0.25, 0.5, 0.75].map((a) => {
    const ops = documentInkOps({ morph: "snap", gaussianBlur: TARGET }, {}, a);
    const sub = ops.find((o) => o.op === "effectSubtree");
    assert.ok(sub, "a defocused widget composites through the effects seam");
    return sub.blur;
  });
  for (const [i, v] of [0.25, 0.5, 0.75].entries())
    assert.equal(radii[i], TARGET + BLUR_FADE_MAX_RADIUS * (1 - v), "radius is target + amount·(1 − v)");
  assert.ok(radii[0] > radii[1] && radii[1] > radii[2], "and it descends TOWARD the target, monotonically");

  // THE ENDPOINT: the widget lands on its own blur EXACTLY, which is the user's
  // "whatever blur is in the target" as an assertion.
  const ended = documentInkOps({ morph: "snap", gaussianBlur: TARGET }, {}, 1);
  const endSub = ended.find((o) => o.op === "effectSubtree");
  assert.equal(endSub.blur, TARGET, "at alpha 1 the blur IS the authored blur — no residue, no zero");
});

test("AP: the amount is a PARAMETER — fold → token → radius, round trip", () => {
  const AMOUNT = 8;
  const mid = blendApplied(
    { active: false },
    { active: true, "active~interp": "blurFade", "active~interp~blur": AMOUNT },
    0.5,
  ).active;
  assert.equal(mid.blur, AMOUNT, "the fold reads the parameter key and folds it INTO the token");
  assert.equal(blurFadeState({ active: mid }).gaussianBlur, AMOUNT / 2, "and the render seam spends it");
  // The key grammar itself, so a rename cannot pass silently.
  assert.equal(interpParamKeyFor("active", "blur"), "active~interp~blur");
  assert.ok(isInterpParamKey("active~interp~blur"));
  assert.ok(!isInterpParamKey("active~interp"), "a parameter key is NOT a mode key — the two grammars stay disjoint");
});

test("AP: ABSENT parameter = the declared default, byte-identically (no migration)", () => {
  const legacy = blendApplied({ active: false }, { active: true, "active~interp": "blurFade" }, 0.5).active;
  assert.equal(legacy.blur, BLUR_FADE_MAX_RADIUS, "a document storing no parameter folds to the default");
  // And a token minted BEFORE the parameter existed (no `blur` field at all)
  // renders identically to one carrying the default — that is the migration.
  assert.equal(
    blurFadeState({ active: fx("blurFade", 0.5) }).gaussianBlur,
    blurFadeState({ active: { ...fx("blurFade", 0.5), blur: BLUR_FADE_MAX_RADIUS } }).gaussianBlur,
  );
});

test("AP: the parameter follows the MODE's own rule — target wins, standing carries", () => {
  const withParam = (outgoing, delta) => blendApplied(outgoing, delta, 0.5).active.blur;
  assert.equal(withParam({ active: false, "active~interp~blur": 10 }, { active: true, "active~interp": "blurFade" }), 10, "the standing value carries when the delta is silent");
  assert.equal(withParam({ active: false, "active~interp~blur": 10 }, { active: true, "active~interp": "blurFade", "active~interp~blur": 3 }), 3, "the target wins from the first frame");
});

test("AP: amount 0 degrades to a plain fade, and the endpoint law holds at every amount", () => {
  assert.equal(blurFadeState({ active: { ...fx("blurFade", 0.5), blur: 0 } }).gaussianBlur, undefined, "zero extra blur adds nothing at any coverage");
  for (const amount of [0, 8, BLUR_FADE_MAX_RADIUS, 200]) {
    const ended = inkOps({ ...RECT, active: { ...fx("blurFade", 1), blur: amount } });
    assert.deepEqual(ended, inkOps({ ...RECT, active: true }), `v = 1 is byte-identical to no mode at amount ${amount}`);
  }
});

test("AP: the parameter DECLARATION is what the Inspector renders — general, not blurFade-shaped", () => {
  const decls = modeParams("blurFade");
  assert.equal(decls.length, 1);
  assert.equal(decls[0].param, "blur");
  assert.ok(decls[0].label && decls[0].help, "a row needs a label and a tip");
  assert.equal(typeof decls[0].default, "number");
  // EVERY OTHER MODE DECLARES NONE, which is what keeps the gutter unchanged
  // everywhere else and proves the machinery is opt-in rather than universal.
  for (const id of ["tween", "step", "fade", "manim"])
    assert.deepEqual(modeParams(id), [], `${id} declares no parameters`);
});

test("AP: the new default is BLURRIER than the constant the user overruled", () => {
  // The user's ruling was that 24 is "too subtle". This pins the DIRECTION of the
  // fix (a number, not a feeling) without freezing the exact value: a future
  // retune may move it, but never back below what was overruled.
  const OVERRULED_DEFAULT = 24;
  assert.ok(BLUR_FADE_MAX_RADIUS > OVERRULED_DEFAULT, `default ${BLUR_FADE_MAX_RADIUS} must exceed the overruled ${OVERRULED_DEFAULT}`);
});

test("AP → AV: keyframing the blur on the ENTERING slide loses the effects bundle (WORKSTREAM AV)", () => {
  // THE MEASURED CAUSE of the user's "it always animates to zero blur", pinned
  // here as a KNOWN-BAD so the next reader does not re-attribute it to blurFade.
  // `gaussianBlur` is not in core/deltas MORPH_PLACEMENT_KEYS, so setting it on
  // the entering slide arms the `auto` universal morph, and a morphed node is
  // routed away from its plugin's emit() — painting with no effect subtree at
  // all. WHEN AV LANDS THIS TEST GOES RED, and the assertion below should be
  // inverted rather than deleted.
  const ops = documentInkOps({}, { gaussianBlur: 10 }, 0.5);
  assert.ok(!ops.some((o) => o.op === "effectSubtree"), "AV still open: a morphed node emits no effect subtree");
  assert.ok(ops.every((o) => !o.blur), "…so the composed defocus never reaches the picture");
  // The composition itself is CORRECT even here — the loss is downstream.
  const state = evaluateState(tweenedState(repairedDocument({
    meta: { name: "ap", w: CANVAS.w, h: CANVAS.h },
    slides: [
      { id: "s0", name: "one", transition: { type: "cut", seconds: 0 }, delta: { items: { cam: { type: "camera" }, a1: { ...RECT, active: false } } } },
      { id: "s1", name: "two", transition: { type: "fade", seconds: 1 }, delta: { items: { a1: { active: true, "active~interp": "blurFade", gaussianBlur: 10 } } } },
    ],
  }, registry).doc, 1, 0.5, registry), registry).state;
  assert.equal(blurFadeState(state.items.a1).gaussianBlur, 10 + BLUR_FADE_MAX_RADIUS / 2, "blurFadeState composed it correctly; the morph seam dropped it");
});

// ── MANIM: THE PHASES ────────────────────────────────────────────────────────

test("MANIM at v = 0.3: a PARTIAL OUTLINE and no fill", () => {
  const ops = inkOps({ ...RECT, active: fx("manim", 0.3) });
  assert.ok(ops.length > 0, "something is drawn");
  assert.ok(ops.every((o) => o.op === "path"), "every op is a sketch path — the widget's own ink is absent");
  assert.ok(ops.every((o) => o.fill === null), "fill is forced off through phase 0 (research §2.1)");
  assert.ok(ops.every((o) => o.strokeWidth === MANIM_SKETCH_STROKE_WIDTH), "the sketch width, not the widget's own 3");
  const plan = manimDrawPlan(0.3, 1);
  assert.equal(plan.phase, 0);
  assert.ok(plan.trims[0] > 0 && plan.trims[0] < 1, "the border is PARTLY drawn, neither absent nor complete");
});

test("MANIM at v = 0.75: a FULL outline and a PARTIAL fill", () => {
  const ops = inkOps({ ...RECT, active: fx("manim", 0.75) });
  const real = ops.filter((o) => o.op === "rect");
  const sketch = ops.filter((o) => o.op === "path");
  assert.equal(real.length, 1, "the widget's OWN ink is drawn now — the fill is the widget's actual fill");
  assert.ok(sketch.length > 0, "and the sketch is still handing off rather than popping out");
  const plan = manimDrawPlan(0.75, 1);
  assert.equal(plan.phase, 1);
  assert.deepEqual(plan.trims, [1], "the border is COMPLETE before any fill begins — the phases do not overlap");
  assert.ok(plan.fillAlpha > 0 && plan.fillAlpha < 1, "and the fill is only partway up");
  assert.equal(plan.sketchWeight, 1 - plan.fillAlpha, "the sketch fades out exactly as the fill rises");
});

test("MANIM at v = 1 is BYTE-IDENTICAL to the same widget with no mode", () => {
  assert.deepEqual(inkOps({ ...RECT, active: fx("manim", 1) }), inkOps({ ...RECT, active: true }));
});

test("MANIM's phase boundary is a hard 0.5, ported verbatim", () => {
  assert.equal(MANIM_PHASE_SPLIT, 0.5);
  assert.equal(manimDrawPlan(0.4999, 1).phase, 0);
  assert.equal(manimDrawPlan(0.5001, 1).phase, 1);
  assert.equal(manimDrawPlan(0.5, 1).fillAlpha, 0, "the fill has not started at the seam itself");
  assert.deepEqual(manimDrawPlan(0.5, 1).trims, [1], "and the border is exactly complete there");
});

const anyPaint = () => true;

test("MANIM's sketch colour is the THREE-TIER ladder, middle tier intact", () => {
  // The tier a port loses by accident: a red-filled, blue-stroked widget sketches
  // in BLUE (research §6 names exactly this case).
  assert.equal(sketchStrokePaint({ fill: "#ff0000", stroke: "#0000ff", strokeWidth: 3 }, anyPaint), "#0000ff");
  assert.equal(sketchStrokePaint({ fill: "#ff0000", stroke: "#0000ff", strokeWidth: 0 }, anyPaint), "#ff0000");
  assert.equal(sketchStrokePaint({ fill: "#ff0000" }, anyPaint, "#00ff00"), "#00ff00");
  assert.equal(sketchStrokePaint({}, anyPaint), null, "nothing paintable ⇒ no sketch, and the caller decides what that means");
  const ops = inkOps({ ...RECT, active: fx("manim", 0.3) });
  assert.equal(ops[0].stroke[2], 1, "and it reaches the op: the blue channel is full");
});

// ── WORKSTREAM AO: THE SKETCH USES THE WIDGET'S REAL STROKE ──────────────────
// User ruling, 2026-08-02: "wouldn't it make sense to use the material stroke if
// provided for the manum entry effect instead of always using white? … if I
// select a red stroke, then the manum effect should use that stroke, or a
// material stroke, then manum should use that material stroke to draw."
// As shipped, a non-string tier was DROPPED, so a material-inked widget's sketch
// was not drawn at all — the "always white" the user reported.

test("AO: the tier LADDER is a list, so a refused tier can fall through", () => {
  // The shape change the ruling required: a tier's answer is any paint, and a
  // tier the renderer cannot stroke with must yield to the NEXT one rather than
  // ending the ladder at nothing.
  const wavy = { type: "material", material: { id: "wavy", params: {} } };
  assert.deepEqual(sketchPaintTiers({ fill: "#ff0000", stroke: wavy, strokeWidth: 4 }), [wavy, "#ff0000"],
    "both tiers are offered, best first — the material does not disappear on the way out");
  assert.deepEqual(sketchPaintTiers({ fill: "#ff0000" }, "#00ff00"), ["#00ff00", "#ff0000"]);
  assert.deepEqual(sketchPaintTiers({}), []);
});

test("AO: a RED stroke sketches RED — the user's own first example", () => {
  const ops = inkOps({ type: "circle", x: 0, y: 0, w: 80, h: 80, fill: "#0000ff", stroke: "#ff0000", strokeWidth: 4, active: fx("manim", 0.3) });
  assert.ok(ops.length > 0 && ops.every((o) => o.op === "path"), "mid-trace, so every op is a sketch path");
  assert.deepEqual(ops[0].stroke, [1, 0, 0, 1], "pure red, not the blue fill and not a default");
});

test("AO: a MATERIAL stroke draws the sketch, and arrives RESOLVED", () => {
  const stroke = { type: "material", material: { id: "wavy", params: {} } };
  const ops = inkOps({ type: "circle", x: 0, y: 0, w: 80, h: 80, fill: "#0000ff", stroke, strokeWidth: 4, active: fx("manim", 0.3) });
  assert.ok(ops.length > 0, "the sketch is DRAWN — before AO this was zero ops, which is the bug");
  assert.equal(ops[0].stroke.type, "material");
  assert.equal(ops[0].stroke.material.id, "wavy");
  // An unresolved material reaching the painter is a hard throw by contract
  // (paint_skia.drawMaterialStroke), and resolveMaterialFillPaints runs BEFORE
  // manimIR, so it never sees this paint — manimIR must resolve it itself.
  assert.ok(ops[0].stroke.resolvedParams, "resolved here, because the op seam upstream cannot reach a paint read out of STATE");
});

test("AO: a GRADIENT stroke draws the sketch too", () => {
  const stroke = { type: "linearGradient", stops: [{ color: "#ff0000", offset: 0 }, { color: "#0000ff", offset: 1 }] };
  const ops = inkOps({ type: "circle", x: 0, y: 0, w: 80, h: 80, fill: "#00ff00", stroke, strokeWidth: 4, active: fx("manim", 0.3) });
  assert.ok(ops.length > 0, "drawn, where a non-string tier used to be dropped");
  assert.equal(ops[0].stroke.type, "linearGradient");
});

test("AO: a FILL-ONLY material tier falls THROUGH — never reaching getStrokeMaterial", () => {
  // THE CRASH GUARD. `crt` is a fill material with no stroke renderer, and handing
  // it to getStrokeMaterial throws — the `d545ddc` crash that bricked the app
  // across reloads (core/paint_containment.js's third case). It must be refused,
  // and the refusal must not end the ladder: the widget still has a fill tier.
  assert.equal(canStrokeWithPaint({ type: "material", material: { id: "crt" } }), false, "fill-only: refused");
  assert.equal(canStrokeWithPaint({ type: "material", material: { id: "wavy" } }), true, "stroke roster: accepted");
  assert.equal(canStrokeWithPaint({ type: "none" }), false, "a paint that draws nothing is not a usable tier");
  const crt = { type: "material", material: { id: "crt", params: {} } };
  assert.equal(manimSketchStroke({ fill: "#ff0000", stroke: crt, strokeWidth: 4 }), "#ff0000",
    "the ladder continued to the fill instead of crashing or drawing nothing");
  // And end to end, through the whole walk: it draws, and it does not throw.
  const ops = inkOps({ type: "circle", x: 0, y: 0, w: 80, h: 80, fill: "#ff0000", stroke: crt, strokeWidth: 4, active: fx("manim", 0.3) });
  assert.ok(ops.length > 0 && ops.every((o) => o.op === "path"));
  assert.deepEqual(ops[0].stroke, [1, 0, 0, 1], "sketched in the FILL's red");
  // A crossfade is only strokeable if BOTH sides are — the painter draws each
  // side as its own pass, so a bad side would throw on that pass.
  assert.equal(canStrokeWithPaint({ type: "crossfade", from: "#f00", to: crt, t: 0.5 }), false);
  assert.equal(canStrokeWithPaint({ type: "crossfade", from: "#f00", to: { type: "material", material: { id: "wavy" } }, t: 0.5 }), true);
});

test("AO: for TEXT the widget's-own-stroke tier is glyphStroke, not the box border", () => {
  // plugins/plaintext.js declares NO `stroke` row and plugins/latex.js spends
  // `stroke` on the BOX BORDER, so statePaint's middle tier read null for both and
  // an authored letterform outline was invisible to the trace.
  assert.equal(manimStatePaint({ fill: "#000", glyphStroke: "#ff0000", glyphStrokeWidth: 3 }).stroke, "#ff0000");
  assert.equal(manimStatePaint({ fill: "#000", glyphStroke: "#ff0000", glyphStrokeWidth: 0 }).stroke, null,
    "width 0 = no outline, the same gate emit() uses");
  assert.equal(manimStatePaint({ fill: "#000", stroke: "#00ff00", strokeWidth: 2, glyphStroke: "#ff0000", glyphStrokeWidth: 3 }).stroke, "#ff0000",
    "the GLYPH row wins: the payload being traced is the letterforms, not the box");
  // A shape has no glyph row, so this is byte-identical to statePaint for it.
  assert.deepEqual(manimStatePaint({ fill: "#f00", stroke: "#00f", strokeWidth: 2 }),
    { fill: "#f00", stroke: "#00f", strokeWidth: 2, opacity: 1 });
});

test("AO: the ENDPOINT LAW still holds — v = 1 is byte-identical to no mode", () => {
  // The ruling changed which paint the SKETCH uses, and the sketch exists only
  // during the draw-in. A material-stroked widget at rest must be untouched.
  const stroke = { type: "material", material: { id: "wavy", params: {} } };
  const base = { type: "circle", x: 0, y: 0, w: 80, h: 80, fill: "#0000ff", stroke, strokeWidth: 4 };
  assert.deepEqual(inkOps({ ...base, active: fx("manim", 1) }), inkOps({ ...base, active: true }),
    "v = 1 IS the widget, with none of this mode's ink in it");
  // And phase 0 still draws NO fill — the sketch is the only ink before the seam.
  const mid = inkOps({ ...base, active: fx("manim", 0.3) });
  assert.ok(mid.every((o) => o.op === "path" && o.fill === null), "phase 0: outline only, fill forced off");
});

// ── ARC LENGTH, NOT CURVE INDEX ──────────────────────────────────────────────

test("ARC LENGTH: a long straight then a short curl trims INSIDE the long one", () => {
  // Curve 0 is a straight run of length 100; curve 1 is a short curl of ~10.
  // Half the LENGTH (55) lands well inside curve 0. A curve-INDEX port — Manim's
  // own parameterization — would instead cut exactly at the junction, drawing the
  // whole straight and none of the curl, which looks plausible and is wrong.
  const sp = {
    start: [0, 0],
    curves: [[100 / 3, 0, 200 / 3, 0, 100, 0], [103, 0, 107, 5, 110, 0]],
    closed: false, winding: 1,
  };
  const { lengths, total } = subpathLengths(sp);
  assert.ok(lengths[0] > 8 * lengths[1], `the fixture really is lopsided (${lengths})`);
  const half = trimSubpathByLength(sp, 0.5);
  assert.equal(half.curves.length, 1, "one partial curve — the trace has not reached the junction");
  const endX = half.curves[0][4];
  assert.ok(Math.abs(endX - total / 2) < 1, `the pen stopped at half the LENGTH (${endX} ≈ ${total / 2})`);
  assert.ok(endX < 100, "and it is strictly inside the long curve, not at its end");
});

test("a trimmed subpath is never CLOSED, whatever the source was", () => {
  const ring = { start: [0, 0], curves: [[10, 0, 20, 0, 30, 0], [30, 10, 20, 20, 0, 0]], closed: true, winding: 1 };
  assert.equal(trimSubpathByLength(ring, 0.4).closed, false, "a half-drawn ring has an open end, structurally");
  assert.equal(trimSubpathByLength(ring, 1).closed, true, "and gets its Z back only when complete");
  assert.equal(trimSubpathByLength(ring, 0), null, "nothing drawn yet is nothing, not an empty path");
});

// ── THE STAGGER ──────────────────────────────────────────────────────────────

test("STAGGER: earlier contours are never behind later ones", () => {
  for (const v of [0.1, 0.25, 0.4, 0.6, 0.9]) {
    const { trims } = manimDrawPlan(v, 3);
    for (let i = 1; i < trims.length; i++)
      assert.ok(trims[i - 1] >= trims[i], `at v=${v}, contour ${i - 1} must lead contour ${i} (got ${trims})`);
  }
});

test("STAGGER: a full lag makes the three contours strictly sequential", () => {
  // L = 1 gives each unit its own non-overlapping 1/N slice (research §4.1).
  assert.deepEqual(manimDrawPlan(0.1, 3, 1).trims.map((t) => t > 0), [true, false, false]);
  assert.deepEqual(manimDrawPlan(0.9, 3, 1).trims.map((t) => t > 0), [true, true, true]);
  assert.equal(manimDrawPlan(1, 3, 1).trims.every((t) => t === 1), true, "and all three finish by v = 1");
});

test("STAGGER: the default lag is ManimGL's min(4/(N+1), 0.2), not ManimCE's", () => {
  assert.equal(manimLagRatio(1), 0.2, "the ceiling stops a lone contour staggering absurdly");
  assert.equal(manimLagRatio(19), 0.2);
  // N = 20 is where the two upstream forms first disagree: ManimCE says 0.2,
  // ManimGL says 4/21. Pinning it is what makes the pick a decision, not a vibe.
  assert.ok(Math.abs(manimLagRatio(20) - 4 / 21) < 1e-12);
});

test("STAGGER: a lag of 0 is lockstep — every contour shares one clock", () => {
  const { trims } = manimDrawPlan(0.3, 4, 0);
  assert.ok(trims.every((t) => t === trims[0]));
});

// ── REVERSAL: VERIFIED, NOT BUILT ────────────────────────────────────────────

test("REVERSAL: v decreasing is the SAME formula, and it MIRRORS", () => {
  // double_smooth is symmetric, so the plan at v and at 1 − v are reflections.
  // That symmetry is the precondition the research note (§8.3) names for a
  // scrubbed exit to mirror the entrance instead of reading fast-then-slow; if a
  // future rate function loses it, this fails rather than looking subtly wrong.
  for (const v of [0.1, 0.3, 0.5, 0.7, 0.9])
    assert.ok(Math.abs(doubleSmooth(v) + doubleSmooth(1 - v) - 1) < 1e-12, `asymmetric at v=${v}`);
  // The EXIT ORDER, which §8.2 warns is the easy thing to get backward: as v
  // falls, the FILL goes first and the border un-traces only below 0.5.
  const inbound = manimDrawPlan(0.3, 1), outbound = manimDrawPlan(0.7, 1);
  assert.equal(inbound.phase, 0, "at 0.3 the border is still drawing");
  assert.deepEqual(outbound.trims, [1], "at 0.7 the border is whole — only the fill is moving");
  assert.ok(outbound.fillAlpha > 0 && outbound.fillAlpha < 1);
  // THE MIRROR, stated exactly: how much border is drawn at `v` and how much
  // fill remains at `1 − v` are COMPLEMENTARY, because one symmetric
  // double_smooth drives both halves. So the second half of an exit undoes the
  // first half of an entrance at matching distances from the ends — a scrub
  // backwards is a true reflection, not an approximation of one. If a future
  // rate function loses the symmetry, this fails loudly instead of looking
  // subtly wrong (fast-then-slow where slow-then-fast belongs).
  for (const v of [0.1, 0.2, 0.3, 0.4]) {
    const drawn = manimDrawPlan(v, 1).trims[0];
    const remaining = manimDrawPlan(1 - v, 1).fillAlpha;
    assert.ok(Math.abs(drawn + remaining - 1) < 1e-12, `mirror broken at v=${v}: ${drawn} + ${remaining} != 1`);
  }
});

// ── THE OUTLINE-LESS FALLBACK ────────────────────────────────────────────────

test("FALLBACK: a widget with no outline FADES, and never throws", () => {
  const node = {
    itemId: "photo1", type: "image",
    plugin: { /* no morphPaths — an image has no border to trace */ },
    state: { active: fx("manim", 0.4), w: 100, h: 60 },
  };
  const cmds = [{ op: "image", opacity: 1 }];
  assert.equal(manimIR(node, cmds), cmds, "the same array back — the plain fade seam then covers it");
});

test("FALLBACK: an EMPTY payload is a WAIT, not a refusal", () => {
  // An icon mid-fetch. The next frame has the outline, so nothing is permanently
  // degraded and this must be silent where the branch above is loud.
  const node = {
    itemId: "icon1", type: "iconify",
    plugin: { morphPaths: () => ({ space: { w: 10, h: 10 }, subpaths: [], fillRule: "nonzero" }) },
    state: { active: fx("manim", 0.4), w: 10, h: 10 },
  };
  const cmds = [{ op: "rect" }];
  assert.equal(manimIR(node, cmds), cmds);
});

test("FALLBACK: an outline-less widget renders through the WHOLE walk, faded", () => {
  // A `clock_analog` draws and declares no morphPaths. Through the whole walk it
  // must come out as an ordinary faded picture — not an error box, not nothing,
  // and not a half-traced anything.
  const ops = inkOps({ type: "clock_analog", x: 0, y: 0, w: 100, h: 60, active: fx("manim", 0.4) });
  assert.ok(ops.length > 0, "it still draws");
  assert.ok(ops.every((o) => (o.opacity ?? 1) <= 0.4 + 1e-9), "faded to the token's coverage, nothing more");
});

// ── A REAL VECTOR WIDGET, END TO END ─────────────────────────────────────────

test("a CIRCLE draws its own outline — the payload is the path the pen follows", () => {
  const mid = inkOps({ type: "circle", x: 0, y: 0, w: 80, h: 80, fill: "#00ff00", active: fx("manim", 0.2) });
  assert.ok(mid.length > 0 && mid.every((o) => o.op === "path"));
  assert.ok(mid[0].d.startsWith("M"), "a real path, from the circle plugin's own morphPaths");
  assert.equal(inkOps({ type: "circle", x: 0, y: 0, w: 80, h: 80, fill: "#00ff00", active: fx("manim", 1) })[0].op,
    "ellipse", "and at v = 1 it is the plugin's own ellipse again");
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
