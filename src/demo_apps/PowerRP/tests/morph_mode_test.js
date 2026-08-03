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
 *   PAINT         — a fill pair lerps through core/interpolators; an unlike pair
 *                   snaps rather than inventing a midpoint.
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

test("MID-TRANSITION the `type` leaf is a MORPH TOKEN naming both endpoints", () => {
  const mid = blendApplied({ items: { a: itemState() } }, { items: { a: { type: "circle" } } }, 0.5);
  const t = mid.items.a.type;
  assert.ok(isMorphToken(t), `expected a morph token, got ${JSON.stringify(t)}`);
  assert.equal(t.type, MORPH_TYPE_TOKEN);
  assert.equal(t.fromType, "rect");
  assert.equal(t.toType, "circle");
  assert.equal(t.t, 0.5, "the token carries the transition alpha, so the render seam needs no clock");
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

test("AUTO IS defaultModeFor — a `type` pair defaults to morph, other strings do not", () => {
  assert.equal(defaultModeFor("rect", "circle", "type"), "morph");
  assert.equal(defaultModeFor("bold", "italic", "fontStyle"), "tween", "an ordinary string row is untouched");
  assert.equal(defaultModeFor(0, 10, "x"), "tween");
  assert.ok(!interpModeIds().includes("auto"), "auto is a DEFAULT, not a registered mode id");
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
  assert.ok(isMorphToken(it.type), "and the type is a morph token, not a crossfade paint");
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

test("AN UNLIKE PAIR SNAPS rather than inventing a midpoint", () => {
  // A material has no numeric halfway point with a hex colour; `interpolate`
  // snaps unlike-shaped values, and this seam inherits that rather than guessing.
  const p = morphedPaint(
    { subpaths: [{ paint: { fill: "#ff0000", strokeWidth: 0, opacity: 1 } }] },
    { subpaths: [{ paint: { fill: { type: "material", material: { id: "crt" } }, strokeWidth: 0, opacity: 1 } }] }, {}, 0.5);
  assert.deepEqual(p.fill, { type: "material", material: { id: "crt" } });
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
