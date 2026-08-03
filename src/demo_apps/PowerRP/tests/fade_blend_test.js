/**
 * THE `fade` AND `blend` INTERP MODES, and the DEFAULT-MODE seam that makes a
 * material switch cross-fade without anyone storing a mode. Plain node, no
 * framework (suite convention):
 *   node src/demo_apps/PowerRP/tests/fade_blend_test.js
 *
 * The two user requests these implement, verbatim (2026-08-02):
 *   "Even visible could have options for interpolate. We could have a fade
 *    interpolate option for visible… The default interpolation for toggling
 *    visibility is just step. But we would want to have an option called fade or
 *    opacity or something that would bring it in and out between 0 to 100
 *    opacity."
 *   "Different fill materials could just linearly blend between each other… you
 *    could just do alpha blending between the two, like, render both materials in
 *    the in-between and just, like, alpha blend the results. Even CRT could do
 *    that… So if I switch between any of those material options, it should be
 *    blend by default."
 *
 * WHAT THIS PINS, and why each half is worth a test rather than a comment:
 *
 *   (1) FADE MAKES THE BOOLEAN FRACTIONAL, IN BOTH DIRECTIONS — and the ENDPOINTS
 *       STAY EXACT BOOLEANS. The second half is the load-bearing one: `applied()`
 *       IS `blendApplied(…, 1)` and core/document.js folds EVERY slide through
 *       it, so a fraction leaking to alpha 1 would rewrite the document's own
 *       stored values in every cached slide state and every export.
 *   (2) A FRACTIONAL `active` STILL DERIVES. core/derive.js gates on
 *       `s.active !== false`; a number passes that, which is the only reason the
 *       fade is visible at all. Pinned because a future "tighten the gate to
 *       `=== true`" would silently delete every fading widget.
 *   (3) FADE COMPOSES BY MULTIPLICATION, THROUGH THE UNIVERSAL SEAM, AND INTO
 *       SUBTREES. A widget at opacity 0.4 half-faded reads 0.2, an effected or
 *       cropped widget fades as ONE unit, and a boolean `active` returns the very
 *       same array (the byte-identical promise).
 *   (4) A PAINT IS A TREE. THE regression this feature nearly shipped: two
 *       object-shaped paints look exactly like a sparse keyframe patch, so an
 *       un-hoisted mode lookup MERGES them key-wise into a chimera that is
 *       neither. Pinned in both directions — a switch crossfades, a genuine
 *       sparse patch still merges byte-identically.
 *   (5) THE DEFAULT-MODE SEAM. Paints default to `blend` with NOTHING stored;
 *       a stored mode still wins outright; colours and numbers are untouched.
 *   (6) THE CROSSFADE VALUE SURVIVES THE RENDER BOUNDARY. parsePaint parses both
 *       sides recursively, the op builders carry it, and crossfadeSide splits it
 *       into two ordinary ops whose opacities sum to the original.
 *   (7) BOTH VECTOR EXPORTERS ROUTE IT TO RASTER, LOUDLY. Not silently, and not
 *       by resolving to one side — which would export a picture the renderer
 *       never drew.
 *
 * DOM-free where it can be (core/), and the render half imports only the
 * DOM-free display-list layer (render_gpu/ir.js, render_gpu/ports.js), so the
 * whole suite runs in bare node.
 */

import assert from "node:assert/strict";
import { blendApplied, applied } from "../core/deltas.js";
import {
  fadeLevel, isCrossfadeValue, isPaintShaped, defaultModeFor, modeClaimsTrees,
  interpModeIds, interpMode, CROSSFADE_PAINT_TYPE,
} from "../core/interp_modes.js";
import { deriveRenderTree } from "../core/derive.js";
import { applyActiveFade } from "../render_gpu/ports.js";
import { isCrossfadePaint, opHasCrossfadePaint, crossfadeSide, parsePaint, rect } from "../render_gpu/ir.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// Two paints with NOTHING in common but their `type` key's existence — the pair
// whose key-wise merge produces the chimera (4) exists to forbid.
const CRT = { type: "material", material: { id: "crt" } };
const COMIC = { type: "material", material: { id: "comic" } };
const GRAD = { type: "linearGradient", stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] };

// ── (1) fade makes the boolean fractional; the endpoints stay booleans ────────

test("FADE: hidden → shown folds to the transition alpha itself", () => {
  const out = blendApplied({ active: false }, { active: true, "active~interp": "fade" }, 0.3);
  assert.equal(out.active, 0.3);
});

test("FADE: shown → hidden fades OUT — one lerp, no direction branch", () => {
  assert.equal(blendApplied({ active: true }, { active: false, "active~interp": "fade" }, 0.25).active, 0.75);
  assert.equal(blendApplied({ active: true }, { active: false, "active~interp": "fade" }, 0.75).active, 0.25);
});

test("FADE: the ENDPOINTS are exact booleans, never fractions", () => {
  // alpha 1 — the fold every cached slide state and every export is built from.
  assert.equal(blendApplied({ active: false }, { active: true, "active~interp": "fade" }, 1).active, true);
  assert.equal(applied({ active: false }, { active: true, "active~interp": "fade" }).active, true);
  assert.equal(blendApplied({ active: true }, { active: false, "active~interp": "fade" }, 1).active, false);
  // alpha 0 — blendApplied returns the outgoing state untouched, so the mode is
  // never consulted at all and `active` keeps the type it had.
  assert.equal(blendApplied({ active: false }, { active: true, "active~interp": "fade" }, 0).active, false);
  assert.equal(blendApplied({ active: true }, { active: false, "active~interp": "fade" }, 0).active, true);
});

test("FADE: a fraction ALREADY IN FLIGHT fades on from where it is", () => {
  // Two transitions in a row (a partial fold over an already-fading value): the
  // ramp re-anchors on the current level rather than snapping back to 0 or 1.
  assert.equal(blendApplied({ active: 0.5 }, { active: true, "active~interp": "fade" }, 0.5).active, 0.75);
});

test("FADE: it is CLAMPED to [0,1] — a coverage factor cannot leave the range", () => {
  assert.equal(fadeLevel(true), 1);
  assert.equal(fadeLevel(false), 0);
  assert.equal(fadeLevel(0.25), 0.25);
  assert.equal(fadeLevel(undefined), 1, "absent means visible — matching derive's `active !== false`");
});

test("FADE on a NON-boolean falls back to the ordinary tween, not an error", () => {
  // `fade` is selectable on any row (rowSupportsInterp), and there is no fading a
  // coordinate — a number's own lerp IS its fade.
  assert.equal(blendApplied({ x: 0 }, { x: 10, "x~interp": "fade" }, 0.5).x, 5);
  assert.equal(blendApplied({ s: "a" }, { s: "b", "x~interp": "fade" }, 0.5).s, "b");
});

test("VISIBLE keeps STEP as its default — fade is OPT-IN", () => {
  // The user: "The default interpolation for toggling visibility is just step."
  // With no companion stored, a boolean is discrete exactly as it always was.
  assert.equal(blendApplied({ active: true }, { active: false }, 0.5).active, false);
  assert.equal(defaultModeFor(false, true, "active"), "tween",
    "and the DEFAULT-MODE seam must not quietly promote it to fade either");
});

// ── (2) a fractional `active` still derives ──────────────────────────────────

test("A FRACTIONAL `active` STILL DERIVES — derive gates on `!== false`", () => {
  const registry = new Map([["rect", { emit: () => [] }]]);
  const nodes = deriveRenderTree({ items: { a: { type: "rect", active: 0.3, x: 0, y: 0, w: 10, h: 10 } } }, registry);
  assert.equal(nodes.length, 1, "a mid-fade item must still produce a node — otherwise the fade deletes it");
  // The bookends, so the gate's meaning is pinned on all three readings.
  assert.equal(deriveRenderTree({ items: { a: { type: "rect", active: false, x: 0, y: 0, w: 1, h: 1 } } }, registry).length, 0);
  assert.equal(deriveRenderTree({ items: { a: { type: "rect", active: true, x: 0, y: 0, w: 1, h: 1 } } }, registry).length, 1);
});

// ── (3) the universal fade seam composes by multiplication ───────────────────

test("FADE SEAM: a fraction multiplies into every op's opacity", () => {
  assert.equal(applyActiveFade({ active: 0.5 }, [{ op: "rect", opacity: 1 }])[0].opacity, 0.5);
});

test("FADE SEAM: it is a coverage factor OVER the widget's own opacity", () => {
  // A widget already at 0.4, half faded in, reads 0.2 — not 0.5.
  assert.equal(applyActiveFade({ active: 0.5 }, [{ op: "rect", opacity: 0.4 }])[0].opacity, 0.2);
  assert.equal(applyActiveFade({ active: 0.5 }, [{ op: "rect" }])[0].opacity, 0.5, "an ABSENT opacity is 1");
});

test("FADE SEAM: a SUBTREE fades as ONE unit (effects, crops, groups)", () => {
  const out = applyActiveFade({ active: 0.5 }, [
    { op: "effectSubtree", opacity: 1, content: [{ op: "rect", opacity: 1 }, { op: "text", opacity: 0.5 }] },
  ]);
  assert.equal(out[0].opacity, 0.5);
  assert.equal(out[0].content[0].opacity, 0.5);
  assert.equal(out[0].content[1].opacity, 0.25);
});

test("FADE SEAM: a BOOLEAN `active` returns the VERY SAME array (byte-identical)", () => {
  const cmds = [{ op: "rect", opacity: 1 }];
  assert.equal(applyActiveFade({ active: true }, cmds), cmds, "identity, not a copy — no allocation on the common path");
  assert.equal(applyActiveFade({ active: false }, cmds), cmds);
  assert.equal(applyActiveFade({}, cmds), cmds);
});

test("FADE SEAM: TRANSFORM BOOKKEEPING is left alone — no inert opacity", () => {
  const out = applyActiveFade({ active: 0.5 }, [{ op: "pushTransform", x: 1 }, { op: "rect", opacity: 1 }, { op: "popTransform" }]);
  assert.equal("opacity" in out[0], false, "a push carries no ink, so an opacity on it would be noise that reads as meaning");
  assert.equal("opacity" in out[2], false);
  assert.equal(out[1].opacity, 0.5);
});

// ── (4) A PAINT IS A TREE — the merge regression, both directions ────────────

test("BLEND: a WHOLE-PAINT SWITCH crossfades — it does NOT merge key-wise", () => {
  const out = blendApplied({ fill: GRAD }, { fill: CRT }, 0.5).fill;
  assert.ok(isCrossfadeValue(out), `expected a crossfade, got ${JSON.stringify(out)}`);
  assert.deepEqual(out.from, GRAD);
  assert.deepEqual(out.to, CRT);
  assert.equal(out.t, 0.5);
  // THE REGRESSION, named: the key-wise merge used to produce
  // {type: "material", stops: [...], material: {…}} — a value that is neither
  // paint and that parsePaint would happily accept as a material.
  assert.equal("stops" in out, false, "a crossfade must not carry the OTHER paint's keys");
});

test("BLEND: a genuine SPARSE KEYFRAME PATCH still merges, byte-identically", () => {
  // The case the tree recursion exists for, and the reason `blend` had to be
  // opt-in-by-shape rather than "any object claims the subtree".
  const before = { g: { stops: [{ offset: 0 }, { offset: 1 }] } };
  const out = blendApplied(before, { g: { stops: { 1: { offset: 0.8 } } } }, 0.5);
  assert.deepEqual(out, { g: { stops: [{ offset: 0 }, { offset: 0.9 }] } });
});

test("BLEND: only a CLAIMING mode takes a subtree whole", () => {
  assert.equal(modeClaimsTrees("blend"), true);
  assert.equal(modeClaimsTrees("tween"), false);
  assert.equal(modeClaimsTrees("step"), false);
  assert.equal(modeClaimsTrees("fade"), false);
  assert.equal(modeClaimsTrees("__not_a_mode"), false, "unknown answers false — the loud throw belongs to blendUnderMode");
});

test("BLEND: IDENTICAL paints do not pay to draw twice", () => {
  const out = blendApplied({ fill: CRT }, { fill: { type: "material", material: { id: "crt" } } }, 0.5).fill;
  assert.equal(isCrossfadeValue(out), false);
  assert.deepEqual(out, CRT);
});

test("BLEND: NESTING IS FLATTENED — never a 2^N shader chain", () => {
  const inFlight = { type: CROSSFADE_PAINT_TYPE, from: GRAD, to: CRT, t: 0.5 };
  const out = blendApplied({ fill: inFlight }, { fill: COMIC }, 0.5).fill;
  assert.ok(isCrossfadeValue(out));
  assert.deepEqual(out.from, CRT, "it re-anchors on the previous crossfade's `to` side, not on the crossfade itself");
  assert.equal(isCrossfadeValue(out.from), false);
  assert.deepEqual(out.to, COMIC);
});

test("BLEND: the ENDPOINTS are the stored paints, not a crossfade", () => {
  assert.equal(isCrossfadeValue(blendApplied({ fill: GRAD }, { fill: CRT }, 1).fill), false);
  assert.deepEqual(blendApplied({ fill: GRAD }, { fill: CRT }, 0).fill, GRAD);
});

test("BLEND: an ADDITION or a REMOVAL has ONE operand — nothing to composite", () => {
  // No `a` to blend from: the ordinary "additions apply at alpha > 0" rule.
  assert.deepEqual(blendApplied({}, { fill: CRT, "fill~interp": "blend" }, 0.5).fill, CRT);
});

// ── (5) the DEFAULT-MODE seam ────────────────────────────────────────────────

test("DEFAULT: a pair of OBJECT-SHAPED paints defaults to `blend`", () => {
  // The user's "if I switch between any of those material options, it should be
  // blend by default" — with NO `fill~interp` stored anywhere.
  assert.equal(defaultModeFor(CRT, COMIC, "fill"), "blend");
  assert.equal(defaultModeFor(GRAD, CRT, "fill"), "blend");
  assert.equal(defaultModeFor(CRT, GRAD, "stroke"), "blend");
  assert.ok(isCrossfadeValue(blendApplied({ fill: CRT }, { fill: COMIC }, 0.5).fill),
    "and it must actually fire through the fold, not merely from the helper");
});

test("DEFAULT: a STORED mode WINS — `step` still snaps a material", () => {
  const out = blendApplied({ fill: GRAD, "fill~interp": "step" }, { fill: CRT }, 0.5).fill;
  assert.equal(isCrossfadeValue(out), false, "an author who asks for a snap must get one");
  // The incoming delta's mode wins too (the mode-steps-at-start rule).
  assert.equal(isCrossfadeValue(blendApplied({ fill: GRAD }, { fill: CRT, "fill~interp": "step" }, 0.5).fill), false);
});

test("DEFAULT: COLOURS and NUMBERS are untouched — today's law exactly", () => {
  // A hex pair already tweens per channel, which is a true blend and cheaper than
  // drawing the op twice.
  assert.equal(defaultModeFor("#ff0000", "#0000ff", "fill"), "tween");
  assert.equal(blendApplied({ fill: "#000000" }, { fill: "#ffffff" }, 0.5).fill, "#808080");
  assert.equal(defaultModeFor(0, 10, "x"), "tween");
  assert.equal(blendApplied({ x: 0 }, { x: 10 }, 0.5).x, 5);
  // A parsed rgba ARRAY is not object-shaped either.
  assert.equal(defaultModeFor([1, 0, 0, 1], [0, 0, 1, 1], "fill"), "tween");
});

test("DEFAULT: the SHAPE test is what makes this reachable from mutBlendApply", () => {
  assert.equal(isPaintShaped(CRT), true);
  assert.equal(isPaintShaped(GRAD), true);
  assert.equal(isPaintShaped({ type: "none" }), true, "an explicit OFF paint is a paint");
  assert.equal(isPaintShaped("#ff0000"), false);
  assert.equal(isPaintShaped([1, 0, 0, 1]), false);
  assert.equal(isPaintShaped({ x: 1, y: 2 }), false, "an untagged record is not a paint — rotationAnchor must keep tweening");
  assert.equal(blendApplied({ rotationAnchor: { x: 0, y: 0 } }, { rotationAnchor: { x: 10, y: 20 } }, 0.5).rotationAnchor.x, 5);
});

test("THE MODE ROSTER IS REGISTERED, with the help text the Inspector renders", () => {
  // The full roster IN REGISTRATION ORDER, because that order IS the Inspector's
  // option order (interpModeIds' contract). `morph` joined it with the retype
  // wave; this list grows by design, and a wave that adds a mode updates it here.
  assert.deepEqual(interpModeIds(), ["tween", "step", "fade", "blend", "expTween", "morph", "blurFade", "manim"]);
  assert.equal(interpMode("fade").label, "Fade");
  assert.equal(interpMode("blend").label, "Blend");
  assert.equal(interpMode("morph").label, "Morph");
  // WORKSTREAM BG. The label is the user's own string, quoted twice to fix it
  // ("Exp Tween"), so it is asserted here as well as in tests/exp_tween_test.js.
  assert.equal(interpMode("expTween").label, "Exp Tween");
  // The two NAMED visibility modes (WORKSTREAMS FF2/JJ). "Manim" is the user's
  // own name for it, not a description — see its registration.
  assert.equal(interpMode("blurFade").label, "Blur Fade");
  assert.equal(interpMode("manim").label, "Manim");
  for (const id of ["fade", "blend", "morph", "blurFade", "manim"]) assert.ok(interpMode(id).help.length > 20, `${id} needs real help text`);
});

// ── (6) the crossfade value at the render boundary ───────────────────────────

test("RENDER: parsePaint parses BOTH SIDES recursively", () => {
  const p = parsePaint({ type: CROSSFADE_PAINT_TYPE, from: "#ff0000", to: CRT, t: 0.25 });
  assert.ok(isCrossfadePaint(p));
  assert.deepEqual(p.from, [1, 0, 0, 1], "a hex side arrives as a painter-ready rgba array");
  assert.deepEqual(p.to, CRT, "a material side passes through, as it does everywhere else");
  assert.equal(p.t, 0.25);
});

test("RENDER: a malformed mix factor is LOUD, never a silent 0.5", () => {
  assert.throws(() => parsePaint({ type: CROSSFADE_PAINT_TYPE, from: "#f00", to: "#00f" }), /mix "t" in \[0,1\]/);
  assert.throws(() => parsePaint({ type: CROSSFADE_PAINT_TYPE, from: "#f00", to: "#00f", t: 2 }), /mix "t" in \[0,1\]/);
});

test("RENDER: the op builders carry a crossfade fill through", () => {
  const cmd = rect({ x: 0, y: 0, w: 10, h: 10, fill: { type: CROSSFADE_PAINT_TYPE, from: "#ff0000", to: CRT, t: 0.25 } });
  assert.ok(opHasCrossfadePaint(cmd));
  assert.equal(opHasCrossfadePaint(rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" })), false);
});

test("RENDER: crossfadeSide splits one op into TWO ordinary ops", () => {
  const cmd = rect({ x: 0, y: 0, w: 10, h: 10, fill: { type: CROSSFADE_PAINT_TYPE, from: "#ff0000", to: CRT, t: 0.25 }, opacity: 1 });
  const from = crossfadeSide(cmd, "from");
  const to = crossfadeSide(cmd, "to");
  assert.equal(opHasCrossfadePaint(from), false, "each side must be an ORDINARY op — that is what lets it re-enter the painter's own dispatch");
  assert.equal(opHasCrossfadePaint(to), false);
  assert.deepEqual(from.fill, [1, 0, 0, 1]);
  assert.deepEqual(to.fill, CRT);
  assert.equal(from.opacity + to.opacity, 1, "the two passes sum to the op's original opacity");
  assert.equal(from.opacity, 0.75);
  assert.equal(to.opacity, 0.25);
});

test("RENDER: the split RESPECTS the op's own opacity", () => {
  const cmd = rect({ x: 0, y: 0, w: 10, h: 10, fill: { type: CROSSFADE_PAINT_TYPE, from: "#ff0000", to: "#0000ff", t: 0.5 }, opacity: 0.4 });
  assert.equal(crossfadeSide(cmd, "from").opacity + crossfadeSide(cmd, "to").opacity, 0.4);
});

test("RENDER: a NON-crossfading slot is untouched on both passes", () => {
  const cmd = rect({
    x: 0, y: 0, w: 10, h: 10, strokeWidth: 2, stroke: "#000000",
    fill: { type: CROSSFADE_PAINT_TYPE, from: "#ff0000", to: "#0000ff", t: 0.5 },
  });
  assert.deepEqual(crossfadeSide(cmd, "from").stroke, [0, 0, 0, 1]);
  assert.deepEqual(crossfadeSide(cmd, "to").stroke, [0, 0, 0, 1]);
});

test("RENDER: a crossfading STROKE routes too, not only a fill", () => {
  const cmd = rect({
    x: 0, y: 0, w: 10, h: 10, strokeWidth: 2, fill: "#ffffff",
    stroke: { type: CROSSFADE_PAINT_TYPE, from: "#ff0000", to: "#0000ff", t: 0.25 },
  });
  assert.ok(opHasCrossfadePaint(cmd));
  assert.deepEqual(crossfadeSide(cmd, "to").stroke, [0, 0, 1, 1]);
  assert.deepEqual(crossfadeSide(cmd, "to").fill, [1, 1, 1, 1], "the ordinary fill rides both passes");
});

// ── (7) both vector exporters route it to raster, LOUDLY ─────────────────────

test("EXPORT: BOTH vector backends name the crossfade in their raster OR-chain", async () => {
  // Asserted against the SOURCE rather than by running an export, because both
  // exporters need a rasterize callback, a font loader and a real scene to run at
  // all — a check that heavy would be pinning the harness, not the routing. What
  // matters is exactly this: the predicate is ON the chain in both files, and the
  // fallback is the general raster one rather than a resolve-to-one-side (which
  // would export a picture the renderer never drew).
  const { readFile } = await import("node:fs/promises");
  const here = new URL(".", import.meta.url);
  for (const file of ["../render_gpu/svg_backend.js", "../render_gpu/pdf_backend.js"]) {
    const src = await readFile(new URL(file, here), "utf8");
    assert.ok(src.includes("reportCrossfadeRaster(cmd)"), `${file} must consult the crossfade predicate on its raster chain`);
    assert.ok(/opHasCrossfadePaint\(cmd\)/.test(src), `${file} must actually test for a crossfade`);
    assert.ok(/reportExportFailureOnce\(\s*\n?\s*"(svg|pdf)_backend:crossfade"/.test(src),
      `${file} must REPORT the raster fallback once — a silent format change is the thing this forbids`);
  }
});

console.log(`\n${passed} passed`);
