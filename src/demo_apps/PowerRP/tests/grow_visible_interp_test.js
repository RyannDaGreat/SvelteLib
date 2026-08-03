/**
 * THE `grow` VISIBLE-INTERP MODE (WORKSTREAM BS). Plain node, no framework
 * (suite convention):
 *   node src/demo_apps/PowerRP/tests/grow_visible_interp_test.js
 *
 * The user request this implements, verbatim (2026-08-03):
 *   "Another intro... sorry, visible interp should be growing from nothing or
 *    shrinking back to nothing."
 *
 * And the LAW that decides where it may be implemented, verbatim (2026-08-03,
 * WORKSTREAM BQ's ruling):
 *   "There is no shader that shouldn't work with this. Every shader should work
 *    with this. It shouldn't be dependent on the type of shader."
 *
 * ── WHAT THIS PINS, and why each is worth a test rather than a comment ───────
 *
 *   (1) THE ENDPOINT LAW, BY IDENTITY. alpha 1 must be the EXACT authored
 *       render — not "within a tolerance". `applied()` IS `blendApplied(…, 1)`
 *       and core/document.js folds every slide through it, so an endpoint that
 *       drifted would rewrite the document's own cached states and every export.
 *       Pinned as object IDENTITY on the transform (growScaledWorld returns its
 *       input) AND as a deep-equal on the whole op list.
 *   (2) alpha 0 IS ABSENT. The widget collapses onto its anchor (scale 0), which
 *       is a zero-area picture — the "from nothing" the request names.
 *   (3) THE MIDPOINT SCALES ABOUT THE ANCHOR, measured on a RENDERED bbox rather
 *       than on the transform alone. This is the test that would catch a grow
 *       implemented about the box's top-left: the corner-anchored version passes
 *       every scale assertion and fails only on WHERE the ink lands.
 *   (4) THREE STRUCTURALLY DIFFERENT WIDGET TYPES, plus a roster-wide sweep. A
 *       vector rect, a TEXT widget (glyph layout, not a path), and a SHADER
 *       widget (skyClouds — a full-canvas material, the exact family BQ reported
 *       fade missing on) must all grow IDENTICALLY. The sweep is the law's real
 *       acceptance: it asserts over EVERY registered plugin so a future widget
 *       cannot regress it (the reserve-before-emit roster-sweep precedent).
 *   (5) ROTATION COMPOSES. A rotated widget grows in place at a CONSTANT angle
 *       and its anchor never moves. Pinned because the obvious implementation
 *       (reusing core/transform.aboutPivot) sweeps the widget along an arc — it
 *       re-parametrizes about a pivot in the PRE-scale frame, so it displaces the
 *       anchor even at alpha 1.
 *   (6) DISAPPEARING MIRRORS APPEARING. true→false at alpha t must render exactly
 *       what false→true renders at 1−t. One rule, no branch.
 *   (7) GROW DOES NOT FADE, and the other three named modes still do. The one
 *       behavioural difference between this mode and its siblings, in the one
 *       place it lives (growOpacityLevel).
 *   (8) IT DOES NOT ARM A MORPH (WORKSTREAM AV). Growing is a VISIBILITY effect,
 *       not a shape morph: `active` is in MORPH_NON_SHAPE_KEYS and the companion
 *       `active~interp` is an interp key, so a grow keyframe must leave
 *       morphEndpointsDiffer false. Pinned because a grow that armed the morph
 *       would route the widget through morphIR and paint a different picture.
 *   (9) IT COMPOSES WITH A SIMULTANEOUS TWEEN of other properties — the widget
 *       may grow WHILE it moves, and the two must multiply rather than one
 *       cancelling the other.
 */

import assert from "node:assert/strict";
import { blendApplied, applied, morphEndpointsDiffer } from "../core/deltas.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { sceneIR, growScaledWorld, applyActiveFade } from "../render_gpu/ports.js";
import { isVisibleFxToken, modesForKey, interpMode, VISIBLE_FX_TOKEN } from "../core/interp_modes.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const registry = createRegistry();
registerPlugins(registry);
const CANVAS = { w: 1920, h: 1080 };

/** The `active` token a named mode folds to mid-transition. */
const fx = (mode, v) => ({ type: VISIBLE_FX_TOKEN, mode, v });

/** A plugin's declared defaults, so a shader widget's uniforms are real numbers. */
function withDefaults(type, extra) {
  const d = registry.get(type).defaults ?? {};
  return { ...(typeof d === "function" ? d() : d), type, ...extra };
}

/** The full scene IR for one item (structural ops INCLUDED — the push is the point here). */
function ops(state) {
  const ev = evaluateState({ items: { a1: { id: "a1", ...state } }, vars: {} }, registry);
  return sceneIR(deriveRenderTree(ev.state, registry, CANVAS));
}

/** The node's own world push — the transform the whole widget is painted inside. */
const worldPush = (state) => ops(state).find((o) => o.op === "pushTransform");

/**
 * The RENDERED bounding box of a widget's ink, in world units: its box's four
 * corners carried out through the transform its ops are actually painted in.
 * This is deliberately measured from the emitted push rather than recomputed
 * from state — it is what the backends' CTM really is.
 */
function renderedBBox(state) {
  const t = worldPush(state);
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  const pts = [[0, 0], [state.w, 0], [state.w, state.h], [0, state.h]].map(([lx, ly]) => ({
    x: t.x + t.scale * (c * lx - s * ly),
    y: t.y + t.scale * (s * lx + c * ly),
  }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: expected ${b}, got ${a}`);

// THE THREE STRUCTURALLY DIFFERENT WIDGETS the founding block asks for: a vector
// shape, a TEXT widget (glyph layout, no path), and a SHADER widget (a full-canvas
// material — the family BQ reported fade missing on).
const BOX = { x: 40, y: 20, w: 200, h: 100, rotation: 0, scale: 1 };
const RECT = withDefaults("rect", { ...BOX, fill: "#ff0000", stroke: "#0000ff", strokeWidth: 3 });
const TEXT = withDefaults("plaintext", { ...BOX, text: "Grow" });
const CLOUDS = withDefaults("skyClouds", { ...BOX });
const KINDS = [["rect", RECT], ["plaintext (glyph layout)", TEXT], ["skyClouds (a SHADER)", CLOUDS]];
/** The box centre in WORLD units for the shared BOX — the anchor grow must hold fixed. */
const ANCHOR = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2 }; // (140, 70)

// ── THE FOLD: the mode mints the shared token, and the endpoints stay exact ───

test("grow folds to a NAMED token strictly inside the transition", () => {
  const mid = blendApplied({ active: false }, { active: true, "active~interp": "grow" }, 0.25).active;
  assert.ok(isVisibleFxToken(mid), "grow must mint a token, not a bare number — the render seam has to know WHICH mode");
  assert.equal(mid.mode, "grow");
  assert.equal(mid.v, 0.25);
});

test("THE ENDPOINTS ARE EXACT BOOLEANS — no token reaches a folded slide state", () => {
  const delta = { active: true, "active~interp": "grow" };
  assert.equal(applied({ active: false }, delta).active, true, "alpha 1 is the stored target");
  assert.equal(blendApplied({ active: false }, delta, 1).active, true);
  assert.equal(blendApplied({ active: false }, delta, 0).active, false, "alpha 0 leaves `a` untouched");
});

test("the Inspector picks it up automatically — appliesTo, not a hand-edited list", () => {
  const ids = modesForKey("active", false);
  assert.ok(ids.includes("grow"), `grow must be offered on a boolean row; got ${ids.join(", ")}`);
  assert.ok(!modesForKey("x", 0).includes("grow"), "a coordinate has no coverage to ramp — grow must not be offered there");
});

test('the label reads naturally beside Fade and Blur Fade', () => {
  assert.equal(interpMode("grow").label, "Grow");
  assert.ok(interpMode("grow").help.length > 40, "a mode must explain itself in the Inspector");
});

test("grow declares NO parameter — the default is restrained, with no dead control", () => {
  assert.deepEqual(interpMode("grow").params ?? [], [], "an overshoot knob whose default is 0 would be a control that does nothing");
});

// ── (1)+(2) THE ENDPOINTS, AS RENDERED ───────────────────────────────────────

test("alpha 1 is the EXACT authored render — byte-identical, by IDENTITY", () => {
  for (const [name, base] of KINDS) {
    const authored = ops({ ...base, active: true });
    const grown = ops({ ...base, active: fx("grow", 1) });
    assert.deepEqual(grown, authored, `${name}: v = 1 must be the authored picture exactly`);
  }
  // The transform is returned BY IDENTITY, not merely an equal copy — the
  // endpoint law enforced structurally rather than trusted to arithmetic.
  const w = { x: 0, y: 0, rotation: 0, scale: 1 };
  assert.equal(growScaledWorld(w, { active: fx("grow", 1), w: 200, h: 100 }), w);
});

test("alpha 0 IS ABSENT — the widget collapses onto its anchor, zero area", () => {
  for (const [name, base] of KINDS) {
    const b = renderedBBox({ ...base, active: fx("grow", 0) });
    near(b.x1 - b.x0, 0, `${name}: width at v = 0`);
    near(b.y1 - b.y0, 0, `${name}: height at v = 0`);
    near(b.x0, ANCHOR.x, `${name}: the collapse point is the anchor (x)`);
    near(b.y0, ANCHOR.y, `${name}: the collapse point is the anchor (y)`);
  }
});

test("a boolean `active` is untouched — every existing document is byte-identical", () => {
  const w = { x: 5, y: 6, rotation: 0.3, scale: 2 };
  assert.equal(growScaledWorld(w, { active: true, w: 200, h: 100 }), w, "same object back");
  assert.equal(growScaledWorld(w, {}), w, "absent means visible");
  assert.equal(growScaledWorld(w, { active: fx("blurFade", 0.5), w: 200, h: 100 }), w, "a DIFFERENT named mode must not scale");
});

// ── (3)+(4) THE MIDPOINT, MEASURED ON A RENDERED BBOX, ON THREE WIDGET KINDS ──

test("alpha 0.5 scales the RENDERED bbox by half, ABOUT THE ANCHOR", () => {
  for (const [name, base] of KINDS) {
    const full = renderedBBox({ ...base, active: true });
    const half = renderedBBox({ ...base, active: fx("grow", 0.5) });
    near(half.x1 - half.x0, (full.x1 - full.x0) / 2, `${name}: width halves`);
    near(half.y1 - half.y0, (full.y1 - full.y0) / 2, `${name}: height halves`);
    // THE ANCHOR TEST — the one a corner-anchored grow fails. The centre of the
    // rendered box must not have moved at all.
    near((half.x0 + half.x1) / 2, ANCHOR.x, `${name}: the centre is FIXED (x) — a corner-anchored grow slides here`);
    near((half.y0 + half.y1) / 2, ANCHOR.y, `${name}: the centre is FIXED (y)`);
  }
});

test("the ramp is linear in coverage, and monotonic", () => {
  let prev = -1;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const b = renderedBBox({ ...RECT, active: fx("grow", v) });
    const w = b.x1 - b.x0;
    near(w, BOX.w * v, `width at v = ${v} is linear in the coverage`);
    assert.ok(w > prev, "the size must increase with the coverage");
    prev = w;
  }
});

test("A MOVED ROTATION ANCHOR IS HONOURED — grow and rotate share one still point", () => {
  const anchored = { ...RECT, rotationAnchor: { x: BOX.x, y: BOX.y } }; // the box's top-left corner
  const b = renderedBBox({ ...anchored, active: fx("grow", 0.5) });
  near(b.x0, BOX.x, "the author's anchor is the fixed point (x)");
  near(b.y0, BOX.y, "the author's anchor is the fixed point (y)");
  near(b.x1 - b.x0, BOX.w / 2, "and it still halves");
});

test("THE EVERY-SHADER LAW — the sweep: every registered widget grows identically", () => {
  const failures = [];
  for (const plugin of registry.all()) {
    let full, half, zero;
    try {
      const base = withDefaults(plugin.type, BOX);
      full = worldPush({ ...base, active: true });
      half = worldPush({ ...base, active: fx("grow", 0.5) });
      zero = worldPush({ ...base, active: fx("grow", 0) });
    } catch (e) { failures.push(`${plugin.type}: threw ${e.message.slice(0, 50)}`); continue; }
    if (!full) continue; // a pure ghost (group, camera) draws nothing of its own
    const bad = [];
    if (Math.abs(half.scale - full.scale * 0.5) > 1e-9) bad.push(`scale ${half.scale} != ${full.scale * 0.5}`);
    if (Math.abs(half.x - (ANCHOR.x + (full.x - ANCHOR.x) * 0.5)) > 1e-9) bad.push("anchor moved (x)");
    if (Math.abs(half.y - (ANCHOR.y + (full.y - ANCHOR.y) * 0.5)) > 1e-9) bad.push("anchor moved (y)");
    if (Math.abs(zero.scale) > 1e-12) bad.push(`v = 0 must collapse, got scale ${zero.scale}`);
    if (Math.abs(half.rotation - full.rotation) > 1e-12) bad.push("rotation changed");
    if (bad.length) failures.push(`${plugin.type}: ${bad.join("; ")}`);
  }
  assert.deepEqual(failures, [], `every widget must grow the same way — no per-shader branch:\n  ${failures.join("\n  ")}`);
});

// ── (5) ROTATION COMPOSES ────────────────────────────────────────────────────

test("A ROTATED WIDGET GROWS IN PLACE — constant angle, anchor never moves", () => {
  const ANGLE = Math.PI / 5;
  for (const [name, base] of KINDS) {
    const rotated = { ...base, rotation: ANGLE };
    const full = worldPush({ ...rotated, active: true });
    for (const v of [0, 0.25, 0.5, 0.75]) {
      const t = worldPush({ ...rotated, active: fx("grow", v) });
      near(t.rotation, full.rotation, `${name}: the angle is CONSTANT at v = ${v} (a swept arc would change it)`);
      // The anchor is the fixed point of the map at every coverage.
      const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
      const px = t.x + t.scale * (c * (BOX.w / 2) - s * (BOX.h / 2));
      const py = t.y + t.scale * (s * (BOX.w / 2) + c * (BOX.h / 2));
      near(px, ANCHOR.x, `${name}: the anchor is FIXED at v = ${v} (x)`);
      near(py, ANCHOR.y, `${name}: the anchor is FIXED at v = ${v} (y)`);
    }
  }
});

test("a rotated grow's bbox is the UNROTATED one's, scaled — rotation and size are orthogonal", () => {
  const rotated = { ...RECT, rotation: Math.PI / 5 };
  const full = renderedBBox({ ...rotated, active: true });
  const half = renderedBBox({ ...rotated, active: fx("grow", 0.5) });
  near(half.x1 - half.x0, (full.x1 - full.x0) / 2, "rotated width still halves");
  near(half.y1 - half.y0, (full.y1 - full.y0) / 2, "rotated height still halves");
});

test("A FLIP SURVIVES THE RAMP — a reflection is orthogonal to a size change", () => {
  const flipped = { ...RECT, w: -RECT.w }; // a NEGATIVE extent IS the flip (the protocol)
  const t = ops({ ...flipped, active: fx("grow", 0.5) }).filter((o) => o.op === "pushTransform");
  assert.ok(t.some((o) => o.signX === -1 || o.signY === -1), "the mirror push must still be emitted mid-grow");
});

// ── (6) DISAPPEARING MIRRORS APPEARING ───────────────────────────────────────

test("SHRINKING IS THE SAME RULE REVERSED — one law, no branch", () => {
  // The fold: true → false at alpha t is the same coverage as false → true at 1 − t.
  const out = blendApplied({ active: true }, { active: false, "active~interp": "grow" }, 0.25).active;
  assert.equal(out.v, 0.75, "true → false at alpha 0.25 is still 75% grown");
  // And it RENDERS the same, on every kind.
  for (const [name, base] of KINDS) {
    const shrinking = renderedBBox({ ...base, active: blendApplied({ active: true }, { active: false, "active~interp": "grow" }, 0.75).active });
    const growing = renderedBBox({ ...base, active: blendApplied({ active: false }, { active: true, "active~interp": "grow" }, 0.25).active });
    assert.deepEqual(shrinking, growing, `${name}: shrinking at t must equal growing at 1 − t`);
  }
});

test("shrinking reaches nothing at the end — 'back to nothing', the user's words", () => {
  const end = blendApplied({ active: true }, { active: false, "active~interp": "grow" }, 1).active;
  assert.equal(end, false, "the endpoint is the exact stored boolean");
  const almost = blendApplied({ active: true }, { active: false, "active~interp": "grow" }, 0.999).active;
  assert.ok(almost.v < 0.002, "and it approaches zero size, not some floor");
});

// ── (7) GROW DOES NOT FADE ───────────────────────────────────────────────────

test("GROW STAYS OPAQUE — it says the arrival with size, not with a dissolve", () => {
  const drawn = (o) => o.op !== "pushTransform" && o.op !== "popTransform";
  for (const [name, base] of KINDS) {
    const full = ops({ ...base, active: true }).filter(drawn);
    const half = ops({ ...base, active: fx("grow", 0.5) }).filter(drawn);
    assert.equal(half.length, full.length, `${name}: same ops`);
    half.forEach((o, i) => near(o.opacity ?? 1, full[i].opacity ?? 1, `${name}: op ${i} (${o.op}) must keep its own opacity`));
  }
  // The seam itself: a grow token returns the very same array.
  const cmds = [{ op: "rect", opacity: 1 }];
  assert.equal(applyActiveFade({ active: fx("grow", 0.5) }, cmds), cmds, "the same array — not even a copy");
});

test("the OTHER named modes still fade — grow is the exception, not a new rule", () => {
  for (const mode of ["fade", "blurFade", "manim"]) {
    const a = mode === "fade" ? 0.5 : fx(mode, 0.5);
    const out = applyActiveFade({ active: a }, [{ op: "rect", opacity: 1 }]);
    near(out[0].opacity, 0.5, `${mode} must still ramp opacity`);
  }
});

// ── (8) AV: GROWING IS A VISIBILITY EFFECT, NOT A SHAPE MORPH ────────────────

test("A GROW KEYFRAME DOES NOT ARM A MORPH (WORKSTREAM AV's trigger law)", () => {
  // `active` is in MORPH_NON_SHAPE_KEYS and `active~interp` is an interp key, so
  // neither may make morphEndpointsDiffer true. A grow that armed the morph would
  // route the widget through morphIR and paint a different picture entirely.
  assert.equal(morphEndpointsDiffer({ type: "rect", active: false }, { type: "rect", active: true }), false);
  assert.equal(morphEndpointsDiffer(
    { type: "rect", active: false },
    { type: "rect", active: true, "active~interp": "grow" },
  ), false, "the mode is a companion key, not a shape leaf");
});

// ── (9) IT COMPOSES WITH A SIMULTANEOUS TWEEN ────────────────────────────────

test("GROWING COMPOSES WITH A MOVE — the widget may arrive while it travels", () => {
  // One transition that both moves the widget and grows it in. The tweened x/y
  // decide WHERE the anchor is; the grow ramp scales about THAT anchor. Neither
  // may cancel the other.
  const from = { ...RECT, x: 0, y: 0, active: false };
  const delta = { x: 400, y: 200, active: true, "active~interp": "grow" };
  const mid = blendApplied(from, delta, 0.5);
  near(mid.x, 200, "x tweens as it always would");
  near(mid.y, 100, "y tweens as it always would");
  const b = renderedBBox(mid);
  near((b.x0 + b.x1) / 2, mid.x + BOX.w / 2, "the grow is centred on the MOVED position");
  near((b.y0 + b.y1) / 2, mid.y + BOX.h / 2, "…in y too");
  near(b.x1 - b.x0, BOX.w * 0.5, "and it is half size there");
});

test("GROWING COMPOSES WITH A SCALE TWEEN — the ramp multiplies the authored scale", () => {
  const mid = blendApplied({ ...RECT, scale: 1, active: false }, { scale: 3, active: true, "active~interp": "grow" }, 0.5);
  near(mid.scale, 2, "the authored scale tweens 1 → 3");
  near(worldPush(mid).scale, 2 * 0.5, "the grow ramp MULTIPLIES it rather than replacing it");
});

test("an authored opacity survives the grow — it is not a fade and must not touch one", () => {
  const drawn = ops({ ...RECT, opacity: 0.4, active: fx("grow", 0.5) }).filter((o) => o.op === "rect");
  assert.ok(drawn.length > 0, "the rect still draws");
  drawn.forEach((o) => near(o.opacity ?? 1, 0.4, "the author's own opacity is untouched"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
