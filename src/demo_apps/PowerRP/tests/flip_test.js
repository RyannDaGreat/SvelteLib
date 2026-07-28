/**
 * THE FLIP — negative w/h as a content reflection (user: "we need flip horizontal
 * and flip vert tools in our command palette....and thus the abilitty to have a
 * negative height or width", then "a flip simply should change the height and
 * width to negative and put the position to where it would have to be to
 * accommodate").
 *
 * WHAT THIS SUITE IS FOR. The flip is unusual in that its correctness is almost
 * entirely a set of INVARIANTS rather than expected values: a flipped widget must
 * occupy the SAME footprint as its unflipped self, flip twice must be the exact
 * identity, and nothing downstream of the derivation may ever meet a negative
 * extent. Those are the properties asserted here, because they are what makes the
 * representation safe to let loose across ~74 plugins and three render backends.
 *
 * Run: node src/demo_apps/PowerRP/tests/flip_test.js
 */
import assert from "node:assert/strict";
import * as T from "../core/transform.js";
import { flippedBox, normalizedBox, unmirroredLocal } from "../core/geometry.js";
import { worldTransform, deriveRenderTree, pickNode, pointInNodeBox, nodeAnchors, nodeFeatures, standardBBoxAnchors } from "../core/derive.js";
import { rotatedBBoxAABB, localBoundsOf } from "../core/view.js";
import { interpolate } from "../core/interpolators.js";
import { newDocument, foldState, withNewItem, keyframed } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { sceneIR, mirrorPush } from "../render_gpu/ports.js";
import { flattenIR, pushTransform, signedCompose, signedApply, isReflected } from "../render_gpu/ir.js";
import { cmSimilarity } from "../render_gpu/pdf_backend.js";
import { similarityTransform } from "../render_gpu/svg_backend.js";

let n = 0;
const test = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };
const eq = (a, b) => assert.deepEqual(a, b);
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const registry = createRegistry();
registerAll(registry, createCommands());

/** Query. The evaluated, folded state of a one-rect document with `over` applied. */
let RAT_ID = null;
function ratState(over) {
  let doc = newDocument(), id;
  [doc, id] = withNewItem(doc, 0, { type: "rect", active: true, x: 100, y: 60, w: 240, h: 140, rotation: 0, scale: 1, fill: "#ff0000", ...over });
  RAT_ID = id;
  return evaluateState(foldState(doc, 0, 1), registry).state;
}
/** Query. The rect's render node in such a document (the camera is the other node). */
const ratNode = (over) => { const s = ratState(over); return deriveRenderTree(s, registry).find((x) => x.itemId === RAT_ID); };

// ── flippedBox: the user's two-leaf formula ────────────────────────────────
test("flippedBox: doctests — negate the size, advance the origin", () => {
  eq(flippedBox({ x: 10, y: 20, w: 100, h: 50 }, "x"), { x: 110, w: -100 });
  eq(flippedBox({ x: 10, y: 20, w: 100, h: 50 }, "y"), { y: 70, h: -50 });
  eq(flippedBox({ x: 10, y: 20, w: 100, h: 50, scale: 2 }, "x"), { x: 210, w: -100 });
});
test("flippedBox: writes ONLY the two leaves of its own axis (minimal delta)", () => {
  eq(Object.keys(flippedBox({ x: 10, y: 20, w: 100, h: 50 }, "x")).sort(), ["w", "x"]);
  eq(Object.keys(flippedBox({ x: 10, y: 20, w: 100, h: 50 }, "y")).sort(), ["h", "y"]);
});
// THE cheapest strong test of the formula: a sign error cannot survive it.
test("flippedBox: DOUBLE FLIP is the EXACT identity — every rotation × scale", () => {
  for (const rotation of [0, 0.001, Math.PI / 6, Math.PI / 2, Math.PI, 2.7, -1.3, 7 * Math.PI])
    for (const scale of [1, 0.25, 3.7, 100]) {
      const s = { x: 137.5, y: -42.25, w: 240, h: 140, rotation, scale };
      for (const axis of ["x", "y"]) {
        const once = { ...s, ...flippedBox(s, axis) };
        const twice = { ...once, ...flippedBox(once, axis) };
        assert.deepEqual(
          { x: twice.x, y: twice.y, w: twice.w, h: twice.h },
          { x: s.x, y: s.y, w: s.w, h: s.h },
          `double ${axis}-flip at rotation ${rotation} scale ${scale}`,
        );
      }
    }
});
test("flippedBox: the two axes COMMUTE (a double flip is one point reflection)", () => {
  const s = { x: 100, y: 60, w: 240, h: 140, scale: 1.5 };
  const xy = { ...s, ...flippedBox(s, "x") };
  const yx = { ...s, ...flippedBox(s, "y") };
  eq({ ...xy, ...flippedBox(xy, "y") }, { ...yx, ...flippedBox(yx, "x") });
});

// ── normalizedBox: the derivation-stage split ──────────────────────────────
test("normalizedBox: an unflipped box passes through with both flags false", () => {
  eq(normalizedBox({ x: 10, y: 20, w: 100, h: 50 }), { x: 10, y: 20, w: 100, h: 50, mirrorX: false, mirrorY: false });
});
test("normalizedBox: normalizing a FLIPPED box returns the ORIGINAL box exactly", () => {
  // This is the property the whole design rests on: because the flip is an
  // involution, a flipped widget derives to byte-identical geometry, so its
  // footprint / anchors / snap points / AABB / cull result cannot drift. Only the
  // mirror flag differs.
  for (const rotation of [0, Math.PI / 5, -2.2])
    for (const scale of [1, 0.4, 6]) {
      const s = { x: 100, y: 60, w: 240, h: 140, rotation, scale };
      for (const axis of ["x", "y"]) {
        const flipped = { ...s, ...flippedBox(s, axis) };
        const norm = normalizedBox(flipped);
        eq({ x: norm.x, y: norm.y, w: norm.w, h: norm.h }, { x: s.x, y: s.y, w: s.w, h: s.h });
        assert.equal(axis === "x" ? norm.mirrorX : norm.mirrorY, true);
        assert.equal(axis === "x" ? norm.mirrorY : norm.mirrorX, false);
      }
    }
});
test("normalizedBox: a ZERO extent is not a flip (0 is a value, not a sign)", () => {
  eq(normalizedBox({ x: 10, y: 20, w: 0, h: 50 }), { x: 10, y: 20, w: 0, h: 50, mirrorX: false, mirrorY: false });
});
test("unmirroredLocal: reflects about the box center and is its own inverse", () => {
  eq(unmirroredLocal({ x: 10, y: 5 }, { w: 100, h: 50, mirrorX: true, mirrorY: false }), { x: 90, y: 5 });
  eq(unmirroredLocal({ x: 10, y: 5 }, { w: 100, h: 50, mirrorX: true, mirrorY: true }), { x: 90, y: 45 });
  const box = { w: 100, h: 50, mirrorX: true, mirrorY: true };
  eq(unmirroredLocal(unmirroredLocal({ x: 17, y: 3 }, box), box), { x: 17, y: 3 });
  // The center is the fixed point.
  eq(unmirroredLocal({ x: 50, y: 25 }, box), { x: 50, y: 25 });
});

// ── THE FOOTPRINT INVARIANT (what the user actually asked for) ─────────────
test("derive: a FLIPPED node normalizes to a POSITIVE box and carries mirror flags", () => {
  const flipped = ratNode({ x: 340, w: -240 });
  eq({ x: flipped.state.x, w: flipped.state.w }, { x: 100, w: 240 });
  eq(flipped.mirror, { x: true, y: false });
  // …and an unflipped node carries NO mirror key at all (the optional-mark idiom,
  // so nothing about the unflipped path changed shape).
  assert.equal("mirror" in ratNode({}), false);
});
test("derive: a flipped node's WORLD TRANSFORM is byte-identical to the unflipped one", () => {
  for (const rotation of [0, Math.PI / 7, -1.9])
    for (const scale of [1, 2.5]) {
      const plain = ratNode({ rotation, scale });
      const fx = { ...plain.state, ...flippedBox(plain.state, "x") };
      const flipped = ratNode({ rotation, scale, x: fx.x, w: fx.w });
      eq(flipped.world, plain.world);
    }
});
test("view: the world AABB is UNCHANGED by a flip — same footprint, mirrored content", () => {
  for (const rotation of [0, 0.4, Math.PI / 2, 2.9, -0.7])
    for (const scale of [1, 0.6, 3]) {
      const plain = ratNode({ rotation, scale });
      const base = rotatedBBoxAABB(plain);
      for (const axis of ["x", "y"]) {
        const f = flippedBox(plain.state, axis);
        const flipped = ratNode({ rotation, scale, ...f });
        eq(rotatedBBoxAABB(flipped), base);
        eq(localBoundsOf(flipped), localBoundsOf(plain));
      }
      // BOTH axes at once (a point reflection) also keeps the footprint.
      const fx = flippedBox(plain.state, "x");
      const both = { ...plain.state, ...fx, ...flippedBox({ ...plain.state, ...fx }, "y") };
      eq(rotatedBBoxAABB(ratNode({ rotation, scale, x: both.x, y: both.y, w: both.w, h: both.h })), base);
    }
});
test("view: an EXPLICIT rotationAnchor also keeps the footprint (no rotation term needed)", () => {
  // The formula has no cos/sin in it. That is only correct because worldTransform
  // re-pivots AFTER reading x/y — verified here against the OTHER pivot branch,
  // where the anchor is a stored world point rather than the derived center.
  const over = { rotation: 1.1, scale: 1.4, rotationAnchor: { x: 33, y: 400 } };
  const plain = ratNode(over);
  const base = rotatedBBoxAABB(plain);
  for (const axis of ["x", "y"]) eq(rotatedBBoxAABB(ratNode({ ...over, ...flippedBox(plain.state, axis) })), base);
});

// ── HIT TESTING ───────────────────────────────────────────────────────────
test("hit test: a flipped widget is hit at exactly the same world points", () => {
  const probes = [[100, 60], [340, 200], [220, 130], [101, 61], [99, 60], [341, 200]];
  const plain = ratState({});
  const flipped = ratState({ x: 340, w: -240 });
  for (const [wx, wy] of probes) {
    const a = pickNode(deriveRenderTree(plain, registry), wx, wy);
    const b = pickNode(deriveRenderTree(flipped, registry), wx, wy);
    assert.equal(b?.type, a?.type, `probe ${wx},${wy}`);
  }
});
test("hit test: an ASYMMETRIC plugin hitTest sees the point REFLECTED back", () => {
  // The whole point of unmirroredLocal at the hitNode seam: a plugin's hitTest is
  // written against its own unmirrored content, so a click on the visually-left
  // half of a flipped widget must arrive as a click on the plugin's RIGHT half.
  const seen = [];
  const node = { ...ratNode({ x: 340, w: -240 }) };
  node.plugin = { capabilities: { bbox: true }, hitTest: (s, lx, ly) => { seen.push([lx, ly]); return true; } };
  pickNode([node], 110, 130); // 10 units in from the visual LEFT edge
  approx(seen[0][0], 230); // → 10 units in from the plugin's RIGHT edge (w - 10)
  approx(seen[0][1], 70);
});
test("pointInNodeBox: normalizes the sign itself (it reads RAW stored state)", () => {
  assert.ok(pointInNodeBox({ x: 300, y: 100, w: -200, h: 120, rotation: 0, scale: 1 }, 150, 160));
  assert.ok(!pointInNodeBox({ x: 300, y: 100, w: -200, h: 120, rotation: 0, scale: 1 }, 350, 160));
});

// ── ANCHORS AND SNAP: THE DECISION ────────────────────────────────────────
test("anchors FOLLOW THE GEOMETRY, not the flip — a bound arrow does NOT move", () => {
  // THE DECISION, recorded here because it is a choice and not a derivation:
  // anchor ids are GEOMETRIC names ("ml" = middle-LEFT) and a flipped widget
  // occupies the same rect, so its left edge is still in the same place. Making
  // anchors ride the mirror would rename them by stealth AND yank every arrow
  // bound to one across a widget whose silhouette did not move. Consequence: an
  // existing binding to `@item.ml` keeps its exact world position through a flip;
  // the content mirrors underneath it.
  const plain = ratNode({});
  const flipped = ratNode({ x: 340, w: -240 });
  // Feature/anchor ids are prefixed with the node's UUID, which differs between the
  // two throwaway documents — compare the GEOMETRY, keyed by the id's suffix.
  const keyed = (list) => Object.fromEntries(list.map(({ id, ...rest }) => [id.split(":").pop(), rest]));
  eq(keyed(nodeAnchors(flipped)), keyed(nodeAnchors(plain)));
  eq(keyed(nodeFeatures(flipped)), keyed(nodeFeatures(plain)));
  eq(standardBBoxAnchors(flipped.state), standardBBoxAnchors(plain.state));
});

// ── AN ANIMATED FLIP ──────────────────────────────────────────────────────
test("animated flip: at alpha 0.5 the widget collapses onto its own center line", () => {
  // Keyframing w from +240 to -240 passes through 0. interpolate() ROUNDS a lerp
  // between two INTEGERS (the tweenline integer rule), so the midpoint is EXACTLY
  // 0 rather than a float crumb — the widget becomes a zero-width sliver and
  // re-expands mirrored. x tweens to the box's own center at the same instant, so
  // the collapse happens ON the center line: a card-flip, which is the right
  // reading of an animated flip and not a defect.
  assert.equal(interpolate(240, -240, 0.5), 0);
  assert.equal(interpolate(100, 340, 0.5), 220); // x: 100 → 100+240, midpoint = center
  // Non-integer extents pass through 0 too (no rounding involved).
  assert.equal(interpolate(240.5, -240.5, 0.5), 0);
  // Just past the midpoint the sign has committed, so the mirror is on.
  assert.ok(normalizedBox({ x: 0, y: 0, w: interpolate(240, -240, 0.75), h: 10 }).mirrorX);
  assert.ok(!normalizedBox({ x: 0, y: 0, w: interpolate(240, -240, 0.25), h: 10 }).mirrorX);
  // And the tween is monotone through the flip: |w| shrinks to 0, then grows.
  const widths = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.abs(interpolate(240, -240, t)));
  eq(widths, [240, 120, 0, 120, 240]);
});

// ── THE RENDER SEAM ───────────────────────────────────────────────────────
test("ir: pushTransform omits a +1 sign, so an unflipped display list is unchanged", () => {
  eq(pushTransform({ x: 5, y: 6 }), { op: "pushTransform", x: 5, y: 6, rotation: 0, scale: 1 });
  eq(pushTransform({ x: 100, signX: -1 }), { op: "pushTransform", x: 100, y: 0, rotation: 0, scale: 1, signX: -1 });
  assert.throws(() => pushTransform({ signX: -2 }), /exactly \+1 or -1/);
  assert.throws(() => pushTransform({ signY: 0 }), /exactly \+1 or -1/);
});
test("ir: signedCompose — sign products, reversed inner rotation, reflected translation", () => {
  const id = { x: 0, y: 0, rotation: 0, scale: 1 };
  eq(signedCompose(id, { ...id, x: 5, y: 6, scale: 2 }), { x: 5, y: 6, rotation: 0, scale: 2, signX: 1, signY: 1 });
  eq(signedCompose({ ...id, signX: -1 }, { ...id, rotation: 1 }), { x: 0, y: 0, rotation: -1, scale: 1, signX: -1, signY: 1 });
  eq(signedCompose({ ...id, x: 100, signX: -1 }, { ...id, x: 30, y: 5 }), { x: 70, y: 5, rotation: 0, scale: 1, signX: -1, signY: 1 });
  // Reflecting twice on the same axis cancels; the two axes multiply independently.
  eq(signedCompose({ ...id, signX: -1 }, { ...id, signX: -1 }).signX, 1);
  eq(signedCompose({ ...id, signX: -1 }, { ...id, signY: -1 }), { x: 0, y: 0, rotation: 0, scale: 1, signX: -1, signY: -1 });
  assert.equal(isReflected(id), false);
  assert.equal(isReflected({ ...id, signY: -1 }), true);
});
test("ir: signedCompose agrees with core/transform compose whenever there is no sign", () => {
  const a = { x: 13, y: -7, rotation: 0.9, scale: 2.5 }, b = { x: -4, y: 11, rotation: -0.3, scale: 0.4 };
  const s = signedCompose(a, b), c = T.compose(a, b);
  for (const k of ["x", "y", "rotation", "scale"]) approx(s[k], c[k], 1e-12);
});
test("ports: mirrorPush is the reflection about the box center line", () => {
  eq(mirrorPush({ state: { w: 100, h: 50 } }), null);
  eq(mirrorPush({ mirror: { x: true, y: false }, state: { w: 100, h: 50 } }),
    { op: "pushTransform", x: 100, y: 0, rotation: 0, scale: 1, signX: -1 });
  eq(mirrorPush({ mirror: { x: false, y: true }, state: { w: 100, h: 50 } }),
    { op: "pushTransform", x: 0, y: 50, rotation: 0, scale: 1, signY: -1 });
  // The reflection maps the box onto ITSELF (its center is the FIXED POINT) —
  // which is why a flipped widget covers the same rect. core/transform.apply knows
  // nothing about signs (deliberately — the similarity model stays sign-free), so
  // the signed map is spelled out here.
  const m = mirrorPush({ mirror: { x: true, y: true }, state: { w: 100, h: 50 } });
  const signedApply = (t, px, py) => ({ x: t.x + (t.signX ?? 1) * px, y: t.y + (t.signY ?? 1) * py });
  eq(signedApply(m, 50, 25), { x: 50, y: 25 });   // center: fixed
  eq(signedApply(m, 0, 0), { x: 100, y: 50 });    // corners: swapped
  eq(signedApply(m, 100, 50), { x: 0, y: 0 });
});
test("sceneIR: a FLIPPED node's ops are identical to the unflipped ones, plus ONE mirror push", () => {
  // The strongest statement available about the render path: the flip does not
  // perturb a single emitted command — it only adds the reflection frame.
  const plain = sceneIR(deriveRenderTree(ratState({}), registry));
  const flipped = sceneIR(deriveRenderTree(ratState({ x: 340, w: -240 }), registry));
  const pushes = flipped.filter((c) => c.op === "pushTransform" && c.signX === -1);
  assert.equal(pushes.length, 1);
  eq(pushes[0], { op: "pushTransform", x: 240, y: 0, rotation: 0, scale: 1, signX: -1 });
  const strip = (ir) => ir.filter((c) => !(c.op === "pushTransform" && (c.signX === -1 || c.signY === -1)));
  // Transform pushes/pops are balanced differently, so compare the DRAW ops.
  const draws = (ir) => strip(ir).filter((c) => c.op !== "pushTransform" && c.op !== "popTransform");
  eq(draws(flipped), draws(plain));
});
test("flattenIR: an unflipped scene folds through core/transform compose (exact shape)", () => {
  const flat = flattenIR(sceneIR(deriveRenderTree(ratState({}), registry)));
  for (const { world } of flat) eq(Object.keys(world).sort(), ["rotation", "scale", "x", "y"]);
});
test("flattenIR: a flipped node's draw ops land on the SAME footprint, reflected", () => {
  const flat = flattenIR(sceneIR(deriveRenderTree(ratState({ x: 340, w: -240 }), registry)));
  const rectCmd = flat.find((f) => f.cmd.op === "rect" && f.cmd.w === 240);
  assert.ok(rectCmd, "the rect op is still emitted with a POSITIVE width");
  assert.equal(rectCmd.world.signX, -1);
  assert.equal(rectCmd.world.scale, 1); // magnitude stays positive: lengths are safe
  // Its two local x extremes map to the box's two world edges, swapped.
  approx(T.apply({ ...rectCmd.world, scale: rectCmd.world.scale * rectCmd.world.signX }, 0, 0).x, 340);
  approx(T.apply({ ...rectCmd.world, scale: rectCmd.world.scale * rectCmd.world.signX }, 240, 0).x, 100);
});

// ── signedApply: THE MATERIAL / BACKDROP CENTER (a caught defect) ──────────
test("ir: signedApply reduces to core/transform apply BIT-EXACTLY without signs", () => {
  // The byte-identity requirement for the 13 backend call sites that swapped to it:
  // `1 * px === px` in IEEE754, so an unmirrored scene maps every point identically.
  for (const t of [{ x: 10, y: 0, rotation: 0, scale: 2 }, { x: -3.75, y: 8.125, rotation: 1.234, scale: 0.3 }])
    for (const [px, py] of [[3, 4], [0, 0], [-17.5, 99.25]]) {
      const s = signedApply(t, px, py), c = T.apply(t, px, py);
      assert.equal(s.x, c.x); assert.equal(s.y, c.y);
    }
});
test("ir: signedApply reflects the local point, and the box CENTER is its fixed point", () => {
  eq(signedApply({ x: 200, y: 0, rotation: 0, scale: 1, signX: -1 }, 80, 50), { x: 120, y: 50 });
  eq(signedApply({ x: 200, y: 0, rotation: 0, scale: 1, signX: -1 }, 200, 0), { x: 0, y: 0 });
});
test("REGRESSION: a flipped MATERIAL widget's region center is where it always was", () => {
  // THE DEFECT THIS PINS (measured on the CPU Skia surface before the fix): the
  // per-pixel material/backdrop handlers compute their region's device center by
  // mapping the box center THEMSELVES and drawing at the device root, so they never
  // ride the CTM reflection. With a sign-blind apply, a 160-wide corkboard stored at
  // x 40 rendered at x 200 — the whole widget on the wrong side of its own box.
  // Note what was NOT the hazard: half-extents. core/derive normalizes the sign
  // away before emit(), so a shader's halfW/halfH are always positive.
  const BOX = { x: 40, y: 30, w: 160, h: 100, rotation: 0, scale: 1 };
  const flippedState = { ...BOX, ...flippedBox(BOX, "x") };
  // Reproduce exactly what the render path builds: derive normalizes the box, then
  // ports.mirrorPush composes the reflection into the frame emit() is handed.
  const norm = normalizedBox(flippedState);
  const normState = { ...flippedState, x: norm.x, y: norm.y, w: norm.w, h: norm.h };
  const frame = signedCompose(worldTransform(normState), mirrorPush({ mirror: { x: norm.mirrorX, y: norm.mirrorY }, state: normState }));
  // materialFill/materialBackdrop/glass all emit cx/cy = the box center (w/2, h/2).
  eq(signedApply(frame, norm.w / 2, norm.h / 2), T.apply(worldTransform(BOX), BOX.w / 2, BOX.h / 2));
  // And the half-extents the shader receives are POSITIVE.
  assert.ok(norm.w / 2 > 0 && norm.h / 2 > 0);
});

// ── THE VECTOR EXPORTERS ──────────────────────────────────────────────────
test("pdf: cmSimilarity reflects a column, and is unchanged without signs", () => {
  assert.equal(cmSimilarity({ x: 10, y: 20, rotation: 0, scale: 2 }), "2 0 0 2 10 20 cm");
  assert.equal(cmSimilarity({ x: 0, y: 0, rotation: 0, scale: 1, signX: -1 }), "-1 0 0 1 0 0 cm");
  assert.equal(cmSimilarity({ x: 0, y: 0, rotation: 0, scale: 1, signY: -1 }), "1 0 0 -1 0 0 cm");
  // A reflection has determinant −1 (an unmirrored similarity has +1) — the
  // invariant that says the exported page really is mirrored.
  const det = (cm) => { const [a, b, c, d] = cm.split(" ").map(Number); return a * d - b * c; };
  assert.ok(det(cmSimilarity({ x: 0, y: 0, rotation: 0.7, scale: 2 })) > 0);
  assert.ok(det(cmSimilarity({ x: 0, y: 0, rotation: 0.7, scale: 2, signX: -1 })) < 0);
});
test("svg: similarityTransform spells a reflection as a per-axis scale", () => {
  assert.equal(similarityTransform({ x: 10, y: 0, rotation: 0, scale: 2 }), "translate(10 0) scale(2)");
  assert.equal(similarityTransform({ x: 0, y: 0, rotation: 0, scale: 1 }), "");
  assert.equal(similarityTransform({ x: 0, y: 0, rotation: 0, scale: 1, signX: -1 }), "scale(-1 1)");
  assert.equal(similarityTransform({ x: 0, y: 0, rotation: 0, scale: 2, signY: -1 }), "scale(2 -2)");
});

// ── NO NEGATIVE EXTENT ESCAPES THE DERIVATION ─────────────────────────────
test("derive: NO plugin ever sees a negative w/h — swept over EVERY bbox widget type", () => {
  // The claim that makes this feature safe across ~74 plugins and every SkSL
  // material (a negative halfW is nonsense in a shader). Asserted by construction
  // rather than by inspection: build one of EVERY registered bbox widget, flip it
  // on both axes, and derive.
  const types = registry.all().filter((p) => p.capabilities.bbox).map((p) => p.type);
  assert.ok(types.length > 20, `expected many bbox widget types, got ${types.length}`);
  let checked = 0;
  for (const type of types) {
    let doc = newDocument(), id;
    [doc, id] = withNewItem(doc, 0, { type, active: true, x: 400, y: 300, w: -240, h: -140, rotation: 0, scale: 1 });
    const state = evaluateState(foldState(doc, 0, 1), registry).state;
    for (const node of deriveRenderTree(state, registry)) {
      assert.ok((node.state.w ?? 0) >= 0, `${type}: derived w must not be negative (got ${node.state.w})`);
      assert.ok((node.state.h ?? 0) >= 0, `${type}: derived h must not be negative (got ${node.state.h})`);
    }
    const flipped = deriveRenderTree(state, registry).find((x) => x.itemId === id);
    if (flipped) {
      eq(flipped.mirror, { x: true, y: true });
      eq({ x: flipped.state.x, y: flipped.state.y, w: flipped.state.w, h: flipped.state.h }, { x: 160, y: 160, w: 240, h: 140 });
      checked++;
    }
  }
  assert.ok(checked > 20, `expected to have flipped many widgets, only reached ${checked}`);
});

console.log(`\nflip tests: ${n} passed`);
