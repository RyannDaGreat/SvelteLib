/**
 * THE MORPH WIRING — phase 2's laws, plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/morph_mode_test.js
 *
 * tests/morph_test.js pins the ENGINE (alignment and lerp, in isolation). This
 * suite pins the WIRING: what a document folds to, what a render node becomes,
 * and what pixels the display list asks for. The laws, one block each:
 *
 *   FOLD          — a keyframed `type` folds to a MORPH TOKEN strictly inside a
 *                   transition and to the EXACT endpoint type strings at 0 and 1.
 *                   The endpoints matter more than the middle: `applied()` IS
 *                   blendApplied(…, 1), so a mode that disagreed at 1 would
 *                   rewrite every cached slide state and every export.
 *   AUTO          — `auto` is defaultModeFor, not a registered id. A pair whose
 *                   two plugins both declare morphPaths morphs; a pair where
 *                   either side cannot falls back to the discrete switch, which
 *                   is exactly what the document did before this feature existed.
 *   UNIT SPACE    — THE DOUBLE-COUNTING TRAP. morphPaths returns unit-space
 *                   output and the box tweens separately as property state, so
 *                   two IDENTICAL squares in DIFFERENT boxes must render exactly
 *                   the tweened box's square. Getting this wrong squares the
 *                   scale factor rather than applying it once, and it is the
 *                   single easiest mistake at this seam.
 *   ITEM BAG      — the regression that this wave uncovered: an item bag is an
 *                   object with a string `type`, and the paint default used to
 *                   claim it. Pinned in both directions.
 *   PAINT         — MORPH NEVER OWNS PAINT (workstream AG). The morph decides
 *                   SHAPE; the paint pair goes through the ordinary paint
 *                   machinery — a tweenable pair lerps, an unlike pair takes the
 *                   crossfade paint, and an UNCHANGED ink (a material, a
 *                   gradient) is unchanged at every alpha rather than degraded to
 *                   a solid. That degradation was the reported bug: "the
 *                   equations always turn black when they morph."
 *
 * Geometry is hand-built or read from the real plugins on purpose: a failure
 * should name a rule, not a fixture.
 */

import assert from "node:assert/strict";
import { blendApplied, applied } from "../core/deltas.js";
import { deriveRenderTree } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { sceneIR, morphIR, scaledSubpath, morphedPaint } from "../render_gpu/ports.js";
import { pathPoints } from "../core/svg_paths.js";
import {
  MORPH_TYPE_TOKEN,
  isMorphToken,
  isPaintShaped,
  defaultModeFor,
  morphPairPolicy,
  interpMode,
  interpModeIds,
} from "../core/interp_modes.js";
import { morphPayloadFromPaths, pathDToSubpaths, lineToCubic, quadToCubic } from "../core/morph_payload.js";
import { MORPH_KEY, isUniversalMorphToken } from "../core/morph_property.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const registry = createRegistry();
registerPlugins(registry);

/** A one-item state bag, spread over a rect's shape. Local helper so each test
 * states only what it varies. */
function itemState(over = {}) {
  return {
    type: "rect", x: 0, y: 0, w: 100, h: 100, z: 0, rotation: 0, scale: 1,
    fill: "#000000", stroke: "#000000", strokeWidth: 0, opacity: 1, cornerRadius: 0,
    ...over,
  };
}

/** The ONE node a single-item document derives to. */
function soleNode(state) {
  const nodes = deriveRenderTree({ items: { a: state }, vars: {} }, registry);
  assert.equal(nodes.length, 1, "fixture should derive exactly one node");
  return nodes[0];
}

/** The x/y extent of a `d` string's control points — enough to catch a scale
 * error by an order of magnitude, which is what the unit-space trap produces. */
function extentOf(d) {
  const pts = pathPoints(d);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// ── (1) THE FOLD LAW ─────────────────────────────────────────────────────────

console.log("\nFOLD — a keyframed type folds to a token inside, exact strings at the ends");

test("MID-TRANSITION the retype is carried by the UNIVERSAL token, not the `type` leaf", () => {
  // SUPERSEDED BY WORKSTREAM MM, and rewritten rather than deleted because the
  // law it protects still matters — a retype must be RESOLVABLE mid-transition,
  // naming both endpoints. What changed is WHERE that lives.
  //
  // The `type` leaf used to hold a `~morph` token. It no longer does: morph is a
  // UNIVERSAL PROPERTY now (core/morph_property.js, user ruling 2026-08-02
  // night), so `type` is an ordinary discrete string again and the endpoints ride
  // the `morph` leaf — which is what lets an equation edit or a tooth-count
  // change morph too, none of which touch `type` at all.
  const mid = blendApplied({ items: { a: itemState() } }, { items: { a: { type: "circle" } } }, 0.5);
  assert.equal(mid.items.a.type, "circle", "`type` is a plain discrete leaf again");
  const tok = mid.items.a[MORPH_KEY];
  assert.ok(isUniversalMorphToken(tok), `the retype must ride the universal token, got ${JSON.stringify(tok)}`);
  assert.equal(tok.from.type, "rect");
  assert.equal(tok.to.type, "circle");
  assert.equal(tok.t, 0.5, "the token carries the transition alpha, so the render seam needs no clock");
});

test("THE ENDPOINTS ARE EXACT TYPE STRINGS — never a token", () => {
  const doc = { items: { a: itemState() } }, delta = { items: { a: { type: "circle" } } };
  // alpha 0 does not blend at all (blendApplied returns early), and alpha 1 is
  // enforced at mutBlendApply's call site rather than trusted to the mode.
  assert.equal(blendApplied(doc, delta, 0).items.a.type, "rect");
  assert.equal(blendApplied(doc, delta, 1).items.a.type, "circle");
  assert.equal(applied(doc, delta).items.a.type, "circle", "applied() IS blendApplied(…, 1)");
});

test("A TOKEN IS STRUCTURALLY UNMISTAKABLE for a widget type", () => {
  // The `~` sigil is the whole guarantee: no plugin type contains one, so no
  // reader can confuse the two. Proven against the REAL roster, not an assumption.
  for (const p of registry.all())
    assert.ok(!p.type.includes("~"), `plugin type "${p.type}" contains the machine sigil`);
  assert.equal(isMorphToken("rect"), false);
  assert.equal(isMorphToken(null), false);
  assert.equal(isMorphToken({ type: "crossfade", from: "a", to: "b" }), false, "a crossfade paint is not a morph");
});

test("AN UNCHANGED TYPE PRODUCES NO TOKEN — there is nothing to morph", () => {
  const mid = blendApplied({ items: { a: itemState() } }, { items: { a: { type: "rect", w: 200 } } }, 0.5);
  assert.equal(mid.items.a.type, "rect");
  assert.equal(mid.items.a.w, 150, "the box still tweens normally alongside");
});

test("AN ADDITION HAS ONE OPERAND, so it stays discrete", () => {
  // The item does not exist on the outgoing slide: there is no outline to morph
  // FROM, and the additions-are-discrete rule already covers it.
  const mid = blendApplied({ items: {} }, { items: { a: itemState({ type: "circle" }) } }, 0.5);
  assert.equal(mid.items.a.type, "circle");
});

// ── (2) AUTO, AND THE FALLBACK MATRIX ────────────────────────────────────────

console.log("\nAUTO — capability-present-on-both, else the discrete switch");

test("`morph` IS REGISTERED and carries help the Inspector can render", () => {
  assert.ok(interpModeIds().includes("morph"));
  assert.equal(interpMode("morph").label, "Morph");
  assert.ok(interpMode("morph").help.length > 20);
});

test("AUTO MOVED OFF THE `type` ROW — it is the universal property's default now", () => {
  // SUPERSEDED BY WORKSTREAM MM. `type` used to default to the `morph` interp
  // mode; it no longer does, because the universal Morph property mints the token
  // for the same transition and derive prefers it. Leaving the old default would
  // mint a SECOND, mid-tween-derived token for one transition — exactly the
  // re-derivation the endpoint law exists to stop.
  assert.equal(defaultModeFor("rect", "circle", "type"), "tween",
    "a type pair takes the ordinary discrete law here; the universal token carries the morph");
  assert.equal(defaultModeFor("bold", "italic", "fontStyle"), "tween", "an ordinary string row is untouched");
  assert.equal(defaultModeFor(0, 10, "x"), "tween");
  assert.ok(!interpModeIds().includes("auto"), "auto is a DEFAULT, not a registered interp mode id");
});

test("BOTH SIDES DECLARING morphPaths → the pair morphs", () => {
  const p = morphPairPolicy(registry.get("rect"), registry.get("circle"), {}, {});
  assert.equal(p.ok, true);
  assert.equal(p.reason, null);
});

test("A SIDE WITHOUT THE CAPABILITY REFUSES, and SAYS WHICH SIDE", () => {
  // `video` is a real widget with no outline — the honest unmorphable case.
  const into = morphPairPolicy(registry.get("rect"), registry.get("video"), {}, {});
  assert.equal(into.ok, false);
  assert.match(into.reason, /incoming/, "the reason must name which end lacks it");
  const from = morphPairPolicy(registry.get("video"), registry.get("rect"), {}, {});
  assert.equal(from.ok, false);
  assert.match(from.reason, /outgoing/);
});

test("AN UNFETCHED SOURCE REFUSES THROUGH morphNotReady, not by throwing", () => {
  // This is the whole reason the not-ready hook exists: iconify's art is fetched
  // asynchronously, and calling morphPaths on it in that window DOES throw.
  const ico = registry.get("iconify");
  const s = { ...ico.defaults, w: 100, h: 100 };
  assert.ok(ico.morphNotReady(s), "an un-loaded icon must report why it is not ready");
  const p = morphPairPolicy(registry.get("rect"), ico, {}, s);
  assert.equal(p.ok, false);
  assert.match(p.reason, /waiting for/);
});

test("AN UNMORPHABLE PAIR DERIVES AS THE INCOMING TYPE — identical to `step`", () => {
  const node = soleNode(itemState({ type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "video", t: 0.5 } }));
  assert.equal(node.type, "video", "the fallback is the target type, at every interior alpha");
  assert.equal(node.morph, undefined, "and no morph mark, so ports draws the plugin's own emit()");
  assert.equal(node.state.type, "video", "the token must not survive into the state bag");
});

test("A MORPHABLE PAIR DERIVES WITH A `.morph` MARK and a REAL resolved plugin", () => {
  const node = soleNode(itemState({ type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t: 0.5 } }));
  assert.equal(node.type, "circle", "the node presents as the INCOMING widget mid-transition");
  assert.ok(node.morph, "the pair rides a node mark, like .mirror and .cropTarget");
  assert.equal(node.morph.t, 0.5);
  assert.equal(typeof node.plugin.emit, "function", "the resolved plugin is a real one");
});

test("A MORPHING ITEM IS STILL DERIVED — it does not vanish mid-transition", () => {
  // The typeless-item filter tests `typeof s.type === "string"`, which a token
  // fails. Admitting it is what stops the widget disappearing for the whole
  // interior of its own transition and popping back at the end.
  const nodes = deriveRenderTree(
    { items: { a: itemState({ type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t: 0.01 } }) }, vars: {} },
    registry);
  assert.equal(nodes.length, 1);
});

// ── (3) THE UNIT-SPACE MAPPING (the trap) ────────────────────────────────────

console.log("\nUNIT SPACE — the box is counted ONCE, not twice");

test("TWO IDENTICAL SQUARES IN DIFFERENT BOXES render the TWEENED BOX's square", () => {
  // THE TRAP, stated as arithmetic. Both endpoints draw the same square, each
  // filling its own box; the boxes tween 100 → 300, so at alpha 0.5 the node's
  // box is 200. The rendered outline must therefore span 0..200 on both axes.
  // If the engine's output were treated as box-local instead of unit, the 200
  // box would multiply an already-200-sized outline and land at 400 — and if it
  // were divided twice it would collapse toward 100. Both failures are caught.
  const node = soleNode(itemState({
    type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "rect", t: 0.5 },
    w: 200, h: 200,
  }));
  const ops = sceneIR([node]).filter((o) => o.op === "path");
  assert.equal(ops.length, 1, "a morph emits one path op per contour");
  const e = extentOf(ops[0].d);
  assert.equal(e.x0, 0, "left edge at the box origin");
  assert.equal(e.y0, 0);
  assert.equal(e.x1, 200, `right edge must be the TWEENED BOX (200), got ${e.x1} — the box was counted twice`);
  assert.equal(e.y1, 200, `bottom edge must be the TWEENED BOX (200), got ${e.y1}`);
});

test("THE SAME MORPH IN A DIFFERENT BOX SCALES LINEARLY — the mapping is the box", () => {
  const at = (w) => {
    const node = soleNode(itemState({ type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t: 0.5 }, w, h: w }));
    return extentOf(sceneIR([node]).filter((o) => o.op === "path")[0].d);
  };
  const small = at(100), big = at(400);
  // Exactly 4x, not 16x: the outline is unit-space and the box multiplies once.
  assert.ok(Math.abs(big.x1 - small.x1 * 4) < 1e-9, `expected 4x (${small.x1 * 4}), got ${big.x1}`);
});

test("scaledSubpath IS A PLAIN PER-AXIS MULTIPLY (the mapping, in isolation)", () => {
  const sp = { start: [0.5, 0.5], curves: [[0, 0, 1, 1, 1, 1]], closed: true, winding: 1 };
  const out = scaledSubpath(sp, 100, 50);
  assert.deepEqual(out.start, [50, 25]);
  assert.deepEqual(out.curves[0], [0, 0, 100, 50, 100, 50]);
  assert.equal(out.closed, true, "the flags ride along untouched");
});

test("THE ENDPOINTS RENDER THE ENDPOINT SHAPES, at the right size", () => {
  // At t = 0 and t = 1 morphPaths short-circuits and returns an ORIGINAL payload,
  // which is in its OWN box space rather than unit space. Reading the scale off
  // the result's `space` is what makes this correct with no branch on t.
  for (const t of [0, 1]) {
    const node = soleNode(itemState({ type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t }, w: 300, h: 300 }));
    const e = extentOf(sceneIR([node]).filter((o) => o.op === "path")[0].d);
    assert.ok(Math.abs(e.x1 - 300) < 1e-6, `at t=${t} the outline must fill the 300 box, got ${e.x1}`);
  }
});

// ── (3b) THE VIEWBOX BAKE ────────────────────────────────────────────────────

console.log("\nVIEWBOX BAKE — an SVG-backed payload is in BOX px, not viewBox units");

// A "simple polygon" star in the 24×24 viewBox every iconify set is authored in —
// the user's own reproduction ("this was a basic svg that was just a simple
// polygon"). The 24-vs-box ratio is the whole point: it is what a dropped
// viewBox→box transform gets wrong, and by a factor big enough to be unmistakable.
const STAR_VIEWBOX = 24;
const STAR_SVG = `<svg viewBox="0 0 ${STAR_VIEWBOX} ${STAR_VIEWBOX}"><path d="M12 2L15 9L22 9L16 13L18 21L12 17L6 21L8 13L2 9L9 9Z" fill="currentColor"/></svg>`;
const STAR_BOX = 200;
/** The star widget's state, inline-sourced so this needs no fetch and runs in bare node. */
const starState = (over = {}) => ({
  ...registry.get("svg").defaults, w: STAR_BOX, h: STAR_BOX,
  svgSource: "inline", svgSrc: STAR_SVG, ...over,
});
/** A payload's control-point extent — `extentOf` for a MorphPaths. */
function payloadExtent(p) {
  return extentOf(p.subpaths.map((sp) =>
    `M${sp.start[0]} ${sp.start[1]}` + sp.curves.map((c) => `C${c[0]} ${c[1]} ${c[2]} ${c[3]} ${c[4]} ${c[5]}`).join("")).join(""));
}

test("AN SVG PAYLOAD'S COORDS FILL ITS DECLARED SPACE — the viewBox is baked in", () => {
  // THE BUG: flattenSvgTree leaves coords in VIEWBOX space and returns the
  // viewBox→box mapping as a separate pushTransform, so a provider that kept only
  // the `path` ops declared `space: {w: 200}` over coordinates that never left
  // 0..24. The engine then unit-ized by 200 and the icon rendered at ~10% of its
  // box, hard against the top-left — "a teeny tiny little star", in the wrong place.
  const p = registry.get("svg").morphPaths(starState());
  assert.equal(p.space.w, STAR_BOX, "the payload's space is the widget box");
  const e = payloadExtent(p);
  assert.ok(e.x1 > STAR_BOX / 2, `coords must reach across the box, got x1=${e.x1} (viewBox units would be < ${STAR_VIEWBOX})`);
  for (const v of [e.x0, e.y0, e.x1, e.y1])
    assert.ok(v >= -1e-6 && v <= STAR_BOX + 1e-6, `every coord must sit inside the declared space, got ${v}`);
});

test("A LETTERBOXED FIT KEEPS ITS OFFSET — the payload says where the ink really is", () => {
  // preserveAspect centers the slack, and the payload must describe THAT placement
  // or the endpoint will not match the widget's own emit. A WIDE viewBox in a
  // square box is inset vertically by exactly half the leftover.
  const wide = `<svg viewBox="0 0 20 10"><path d="M0 0L20 0L20 10Z"/></svg>`;
  const p = registry.get("svg").morphPaths(starState({ svgSrc: wide }));
  const e = payloadExtent(p);
  assert.ok(Math.abs(e.x0) < 1e-6 && Math.abs(e.x1 - STAR_BOX) < 1e-6, `the wide axis fills the box, got ${e.x0}..${e.x1}`);
  const inset = (STAR_BOX - STAR_BOX / 2) / 2;
  assert.ok(Math.abs(e.y0 - inset) < 1e-6, `the short axis is centered at ${inset}, got ${e.y0}`);
});

test("THE MIDPOINT SITS INSIDE THE TWEENED BOX — square → star does not collapse", () => {
  // The user's morph. Mid-transition the outline must still span most of its box;
  // the dropped-transform bug drove this monotonically toward a ~10% corner blob.
  const node = soleNode({
    ...starState(), type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "svg", t: 0.5 },
  });
  const e = extentOf(sceneIR([node]).filter((o) => o.op === "path")[0].d);
  for (const v of [e.x0, e.y0, e.x1, e.y1])
    assert.ok(v >= -1e-6 && v <= STAR_BOX + 1e-6, `a midpoint coord escaped the box: ${v}`);
  assert.ok(e.x1 - e.x0 > STAR_BOX * 0.8, `the midpoint must still span its box, got width ${e.x1 - e.x0}`);
});

test("AT alpha→1 THE MORPH MATCHES THE WIDGET'S OWN INK — this is what kills the flick", () => {
  // The endpoint short-circuit returns the icon's real payload, so t=1 was always
  // right; the bug lived strictly INSIDE the transition, which is precisely why
  // endpoint-only tests could not see it. Pinning t=0.999 against t=1 pins
  // CONTINUITY: a payload in the wrong space makes these two disagree hugely.
  const at = (t) => extentOf(sceneIR([soleNode({
    ...starState(), type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "svg", t },
  })]).filter((o) => o.op === "path")[0].d);
  const near = at(0.999), end = at(1);
  for (const k of ["x0", "y0", "x1", "y1"])
    assert.ok(Math.abs(near[k] - end[k]) < STAR_BOX * 0.01,
      `${k} must not jump at the endpoint: ${near[k]} vs ${end[k]}`);
});

// ── (4) THE ITEM-BAG REGRESSION ──────────────────────────────────────────────

console.log("\nITEM BAG — an item is not a paint, however much it looks like one");

test("AN ITEM BAG IS NOT PAINT-SHAPED (the bug: it has a string `type`)", () => {
  assert.equal(isPaintShaped(itemState()), false, "an item bag must never be read as a paint");
  assert.equal(isPaintShaped({ type: "material", material: { id: "crt" } }), true);
  assert.equal(isPaintShaped({ type: "linearGradient", stops: [] }), true);
  assert.equal(isPaintShaped({ type: "none" }), true, "an explicit OFF paint is still a paint");
});

test("A RETYPE KEYFRAME KEEPS THE ITEM'S OTHER PROPERTIES", () => {
  // The measured failure: `blend` claimed the whole item subtree and replaced it
  // with {type: "crossfade", from, to} — no w, no h, no fill — after which derive
  // threw `Unknown widget type "crossfade"`. Every property below is a witness.
  const mid = blendApplied(
    { items: { a: itemState({ w: 100, fill: "#000000" }) } },
    { items: { a: { type: "circle", w: 300, fill: "#ffffff" } } }, 0.5);
  const it = mid.items.a;
  assert.equal(it.w, 200, "w must still tween");
  assert.equal(it.fill, "#808080", "fill must still tween per channel");
  assert.equal(it.h, 100, "an untouched property must survive");
  assert.equal(it.type, "circle", "and the type is a plain string, NOT a crossfade paint wrapper");
  assert.ok(isUniversalMorphToken(it[MORPH_KEY]), "with the retype carried by the universal morph token");
});

test("THE WHOLE PIPELINE SURVIVES A RETYPE AT EVERY ALPHA", () => {
  // End to end: fold → derive → IR, which is the path that used to throw.
  for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
    const mid = blendApplied(
      { items: { a: itemState() } }, { items: { a: { type: "circle", w: 200 } } }, alpha);
    const ops = sceneIR(deriveRenderTree({ ...mid, vars: {} }, registry));
    assert.ok(ops.some((o) => o.op === "path" || o.op === "rect" || o.op === "ellipse"),
      `alpha ${alpha} drew no ink`);
  }
});

// ── (5) PAINT ACROSS A MORPH ─────────────────────────────────────────────────

console.log("\nPAINT — lerped through core/interpolators, never hand-rolled");

test("A FILL PAIR LERPS PER CHANNEL", () => {
  const p = morphedPaint(
    { subpaths: [{ paint: { fill: "#000000", strokeWidth: 0, opacity: 1 } }] },
    { subpaths: [{ paint: { fill: "#ffffff", strokeWidth: 0, opacity: 1 } }] }, {}, 0.5);
  assert.equal(p.fill, "#808080", "the same law core/interpolators already applies to a colour row");
});

// ── MORPH NEVER OWNS PAINT (workstream AG) ───────────────────────────────────
//
// User ruling, 2026-08-02, verbatim: "It's not the responsibility of morphing to
// handle any material properties, it's only about shape properties." Reported as
// "the equations always turn black when they morph". The four tests below are
// the four ways the seam could take that responsibility back.

const MATERIAL = { type: "material", material: { id: "crt" } };
/** A payload whose subpaths carry the given fills — the shape of any real one. */
const paintedPayload = (fills) => ({
  space: { w: 1, h: 1 },
  fillRule: "nonzero",
  subpaths: fills.map((fill) => ({ paint: { fill, stroke: null, strokeWidth: 0, opacity: 1 } })),
});

test("AN UNLIKE PAIR CROSSFADES rather than snapping", () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE — that a solid → material pair snapped
  // to the material, because `interpolate` snaps unlike-shaped values. The user's
  // ruling overruled it: "if we're, you know, cross-fading of course, interpolate
  // the material however the material would interpolate". So an unlike pair takes
  // the paint machinery's own answer, the {type: "crossfade"} paint the `blend`
  // mode mints, which the painter draws as both sides at complementary alpha.
  const p = morphedPaint(paintedPayload(["#ff0000"]), paintedPayload([MATERIAL]), {}, 0.5);
  assert.deepEqual(p.fill, { type: "crossfade", from: "#ff0000", to: MATERIAL, t: 0.5 });
});

test("A MULTI-GLYPH MATERIAL INK SURVIVES THE INTERIOR — the reported bug", () => {
  // An equation or a text box is MANY contours under ONE ink. The old carve-out
  // was a subpath COUNT test, so any multi-glyph widget took the engine's carried
  // per-subpath paint instead — which for a shader ink was a degraded solid. That
  // is the black.
  const p = morphedPaint(
    paintedPayload([MATERIAL, MATERIAL, MATERIAL]),
    paintedPayload([MATERIAL, MATERIAL]),
    { paint: { fill: "#000000" } }, 0.5);
  assert.deepEqual(p.fill, MATERIAL, "an unchanged ink is unchanged at every alpha");
});

test("A MULTI-GLYPH SOLID KEEPS ITS EXACT COLOUR — never the default black", () => {
  const p = morphedPaint(
    paintedPayload(["#22cc44", "#22cc44"]),
    paintedPayload(["#22cc44"]),
    { paint: { fill: "#000000" } }, 0.5);
  assert.equal(p.fill, "#22cc44");
});

test("GENUINELY MULTI-COLOURED ART KEEPS ITS PER-CONTOUR PAINT — the carve-out's real case", () => {
  // An SVG icon's contours DISAGREE, which is the condition the rule now tests.
  // The engine carried the aligned counterpart's paint through, and flattening
  // those to one widget-level colour is what the carve-out exists to prevent.
  const p = morphedPaint(
    paintedPayload(["#ff0000", "#00ff00"]),
    paintedPayload(["#0000ff", "#ffff00"]),
    { paint: { fill: "#00ff00" } }, 0.5);
  assert.equal(p.fill, "#00ff00");
});

test("A MORPHED OP CARRIES A MATERIAL FILL, so the material actually renders", () => {
  // The END of the chain, not the seam: a morph emits ORDINARY path ops, and
  // ports.resolveMaterialFillPaints resolves a material fill on a path op exactly
  // as it does on any emit()'s. If the material survives morphedPaint it reaches
  // the painter — which is the whole claim "path ops already wear materials".
  const node = soleNode(itemState({
    type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t: 0.5 },
    fill: MATERIAL,
  }));
  const op = sceneIR([node]).find((o) => o.op === "path");
  assert.ok(op, "the morph drew ink");
  assert.equal(op.fill?.type, "material", "a material rides the morphed path op");
  assert.ok(op.fill.resolvedParams, "and resolveMaterialFillPaints resolved it, like any other op's");
});

test("A MORPHED OP CARRIES THE TWEENED FILL through the real pipeline", () => {
  const node = soleNode(itemState({
    type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t: 0.5 },
    fill: "#808080",
  }));
  const op = sceneIR([node]).find((o) => o.op === "path");
  // parsePaint has turned it into a painter-ready rgba array by now.
  assert.ok(Array.isArray(op.fill), "the op's fill is parsed like any other paint");
  assert.ok(Math.abs(op.fill[0] - 0.5019607843137255) < 1e-9);
});

// ── (6) THE PROVIDER CONVERTER ───────────────────────────────────────────────

console.log("\nPROVIDER — `d` strings in, cubic contours out");

test("EVERY DECLARED PROVIDER PRODUCES A VALID PAYLOAD", () => {
  // The roster is read from the registry, so a widget that gains the capability
  // tomorrow is covered without touching this file.
  const providers = registry.all().filter((p) => typeof p.morphPaths === "function");
  assert.ok(providers.length >= 20, `expected the shape roster to be morphable, got ${providers.length}`);
  for (const p of providers) {
    if (p.morphNotReady?.({ ...p.defaults, w: 100, h: 100 })) continue; // async art: covered above
    const payload = p.morphPaths({ ...p.defaults, w: 100, h: 100 });
    assert.ok(payload.space.w >= 0 && payload.space.h >= 0, `${p.type}: space must be non-negative`);
    assert.ok(Array.isArray(payload.subpaths), `${p.type}: subpaths must be an array`);
    for (const sp of payload.subpaths)
      for (const c of sp.curves)
        assert.equal(c.length, 6, `${p.type}: every segment must be a CUBIC sextuple`);
  }
});

test("LINES AND QUADS ELEVATE EXACTLY — not by sampling", () => {
  // Exactness is load-bearing: the engine lerps control points, which is AFFINE,
  // so two exactly-straight segments stay exactly straight at every alpha. A
  // sampled elevation would put a wobble in a rect→rect morph.
  assert.deepEqual(lineToCubic([0, 0], [3, 0]), [1, 0, 2, 0, 3, 0]);
  assert.deepEqual(quadToCubic([0, 0], [3, 3], [6, 0]), [2, 2, 4, 2, 6, 0]);
});

test("A `Z` DRAWS ITS CLOSING EDGE — a triangle has THREE segments", () => {
  // Omitting it would make the payload describe less ink than the widget paints,
  // and the closing edge of a triangle is a third of its outline.
  const [sp] = pathDToSubpaths("M0 0L10 0L5 8Z");
  assert.equal(sp.curves.length, 3);
  assert.equal(sp.closed, true);
});

test("ARCS ARRIVE AS CUBICS — the grammar is not parsed twice", () => {
  // `A` is converted by core/svg_paths.transformPathD (arcToCubics), which is the
  // codebase's one absolute-izer. Real icon sets lean on arcs, so a second
  // spelling here is exactly where the two would silently differ.
  const [sp] = pathDToSubpaths("M0 0A5 5 0 0 1 10 0");
  assert.ok(sp.curves.length >= 1);
  for (const c of sp.curves) assert.equal(c.length, 6);
});

test("A CURVE-LESS SUBPATH IS DROPPED — it has no ink to pair against", () => {
  assert.deepEqual(pathDToSubpaths("M5 5"), []);
  assert.deepEqual(pathDToSubpaths(""), []);
});

test("PAINT TRAVELS WITH EVERY SUBPATH ITS SOURCE DREW", () => {
  const p = morphPayloadFromPaths([{ d: "M0 0L1 0", paint: { fill: "#f00" } }], { w: 1, h: 1 });
  assert.deepEqual(p.subpaths[0].paint, { fill: "#f00" });
});

// ── (7) THE MORPH EMIT, DIRECTLY ─────────────────────────────────────────────

console.log("\nEMIT — one path op per contour, through the shared display list");

test("morphIR EMITS ORDINARY `path` OPS, which every backend already paints", () => {
  const node = soleNode(itemState({ type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t: 0.5 } }));
  const ops = morphIR(node);
  assert.ok(ops.length >= 1);
  for (const o of ops) {
    assert.equal(o.op, "path", "a morph must not need a new IR op — that is why it exports everywhere");
    assert.ok(typeof o.d === "string" && o.d.length > 0);
  }
});

test("THE MORPH REPLACES THE PLUGIN'S OWN emit(), it does not add to it", () => {
  // At t = 0.4 the widget is neither a rect nor a circle, so drawing either
  // endpoint's ops would show a shape the transition never passes through.
  const node = soleNode(itemState({ type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t: 0.4 } }));
  const ops = sceneIR([node]);
  assert.equal(ops.filter((o) => o.op === "ellipse").length, 0, "the circle's own op must not appear");
  assert.equal(ops.filter((o) => o.op === "rect").length, 0, "nor the rect's");
  assert.equal(ops.filter((o) => o.op === "path").length, 1);
});

test("THE UNIVERSAL SEAMS STILL REACH A MORPHING NODE", () => {
  // A morph emits ordinary ops, so the fade seam (a fractional `active`) composes
  // with it exactly as with any widget — no special case, which is the point.
  const node = soleNode(itemState({
    type: { type: MORPH_TYPE_TOKEN, fromType: "rect", toType: "circle", t: 0.5 },
    active: 0.5, opacity: 1,
  }));
  const op = sceneIR([node]).find((o) => o.op === "path");
  assert.ok(Math.abs(op.opacity - 0.5) < 1e-9, `the fade seam must multiply a morph's opacity, got ${op.opacity}`);
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exit(1);
