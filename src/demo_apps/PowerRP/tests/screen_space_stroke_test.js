/**
 * SCREEN-SPACE STROKE WIDTH (#282) — the decision, gated in both directions.
 *
 * A screen-space stroke keeps a constant thickness in the CAMERA'S LOGICAL PIXELS:
 * zooming the canvas must not change it, and a higher-resolution export must scale
 * it like everything else. Those two pull in opposite directions through the same
 * `view.zoom` field, which is exactly why this file exists.
 *
 * ── THE ASSERTION THAT EARNS ITS KEEP ────────────────────────────────────────
 * core/view.js fitRectView returns `zoom = min(w/rect.w, h/rect.h)`, so a 4K render
 * of a 1080p camera arrives with view.zoom = 2 — from RESOLUTION, not magnification.
 * The obvious implementation (divide by world.scale · view.zoom) therefore renders
 * screen-space strokes at HALF thickness in every export while looking perfect on
 * the canvas: a silent GPU↔PDF/mp4 parity break, invisible to anyone testing only
 * the editor. Case (3) below is the one that fails against that implementation, and
 * it is the reason the divisor takes a third argument.
 *
 * Bare node: the decision is a pure function of (worldScale, zoom, fitZoom), so it
 * is tested as one, with no GPU and no browser.
 */
import assert from "node:assert/strict";
import { screenSpaceDivisor } from "../core/clip.js";
import { rect, path, normalizeStrokeSpace } from "../render_gpu/ir.js";
import { BUNDLES } from "../core/properties.js";

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

test("(1) ZOOM IS CANCELLED — the editor case the feature exists for", () => {
  // Same deck, same camera fit, user magnifies 4x: the stored width must be
  // quartered so the DEVICE thickness is unchanged.
  assert.equal(screenSpaceDivisor(1, 4, 1), 4);
  assert.equal(screenSpaceDivisor(1, 1, 1), 1);
  // Zooming OUT draws it thicker in world units, which is the same rule mirrored.
  assert.equal(screenSpaceDivisor(1, 0.5, 1), 0.5);
});

test("(2) THE NODE'S OWN SCALE IS CANCELLED TOO — a 2x group must not thicken it", () => {
  assert.equal(screenSpaceDivisor(2, 1, 1), 2);
  assert.equal(screenSpaceDivisor(2, 3, 1), 6); // both compose
});

test("(3) RESOLUTION IS **NOT** CANCELLED — the export case, and the trap", () => {
  // A 2x export: fitRectView hands us zoom 2 because the output is twice the
  // camera, not because anyone zoomed. fitZoom is 2 as well, so the ratio is 1 and
  // the stroke scales with the render — the user's DPI ruling.
  assert.equal(screenSpaceDivisor(1, 2, 2), 1,
    "a 2x EXPORT must leave the width alone (resolution is DPI, not magnification) — " +
    "dividing by view.zoom here is what silently halves every exported stroke");
  assert.equal(screenSpaceDivisor(1, 4, 4), 1, "…and a 4x export likewise");
  // Magnification INSIDE a scaled export still cancels: 8x view over a 4x fit is 2x zoom.
  assert.equal(screenSpaceDivisor(1, 8, 4), 2);
});

test("(4) DEGENERATE INPUTS FALL BACK TO WORLD SPACE, never to NaN", () => {
  for (const bad of [0, -1, NaN, Infinity, undefined, null])
    for (const d of [screenSpaceDivisor(bad, 2, 1), screenSpaceDivisor(1, bad, 1), screenSpaceDivisor(1, 2, bad)])
      assert.ok(Number.isFinite(d) && d > 0, `divisor became ${d} for input ${String(bad)}`);
  // EACH input degrades INDEPENDENTLY, which my first version of this test got
  // wrong by asserting the whole divisor collapses to 1. A degenerate world scale
  // falls back to 1 for the SCALE term only — the zoom ratio is still meaningful
  // and must still apply, so 2x magnification over a 1x fit is still 2.
  assert.equal(screenSpaceDivisor(0, 2, 1), 2);
  assert.equal(screenSpaceDivisor(2, NaN, 1), 2, "an unusable zoom leaves scale cancellation intact");
  assert.equal(screenSpaceDivisor(1, 3, 0), 1, "an unusable fit falls back to zoom itself → ratio 1");
});

test("(5) THE FLAG IS OPT-IN — an op that never sets it is byte-identical", () => {
  assert.deepEqual(normalizeStrokeSpace("rect", {}), {});
  assert.deepEqual(normalizeStrokeSpace("rect", { strokeScreenSpace: false }), {});
  assert.deepEqual(normalizeStrokeSpace("rect", { strokeScreenSpace: true }), { strokeScreenSpace: true });
  assert.throws(() => normalizeStrokeSpace("rect", { strokeScreenSpace: 1 }), /must be a boolean/);
  assert.ok(!("strokeScreenSpace" in rect({ x: 0, y: 0, w: 1, h: 1 })), "absent by default on rect");
  assert.ok(!("strokeScreenSpace" in path({ d: "M0 0h1" })), "absent by default on path");
});

test("(6) IT REACHES THE OPS THAT CAN STROKE, and the shared bundles offer it", () => {
  assert.equal(rect({ x: 0, y: 0, w: 1, h: 1, strokeScreenSpace: true }).strokeScreenSpace, true);
  assert.equal(path({ d: "M0 0h1", strokeScreenSpace: true }).strokeScreenSpace, true);
  // A bundle property, not a per-plugin one — the user's own correction ("this is
  // an OPTION FOR STROKE"), so every stroke-bearing widget inherits it at once.
  for (const b of ["strokedBorder", "strokedBox"])
    assert.ok(BUNDLES[b].includes("strokeScreenSpace"), `BUNDLES.${b} does not offer the option`);
});

console.log(`\n${passed} screen-space-stroke tests passed`);
