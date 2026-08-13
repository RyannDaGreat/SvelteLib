/**
 * SCREEN-SPACE SIZING (#282 strokes, #283 text) — the decision, gated both ways.
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
import { rect, path, text as textOp, normalizeStrokeSpace } from "../render_gpu/ir.js";
import { BUNDLES, STROKE_SPACE_KEYS } from "../core/properties.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { sceneIR } from "../render_gpu/ports.js";

const registry = createRegistry();
registerPlugins(registry);

/** Query→build. A derived node for `plugin` at a fixed world, carrying `extra` over
 *  the plugin's own defaults — the universal_effects_test.js idiom. A visible
 *  strokeWidth is forced so there is always a stroked op for the flag to land on. */
function widgetNode(plugin, extra) {
  return {
    itemId: "i",
    type: plugin.type,
    plugin,
    world: { x: 0, y: 0, rotation: 0, scale: 1 },
    state: { ...plugin.defaults, x: 0, y: 0, w: 200, h: 150, rotation: 0, scale: 1, stroke: "#000000", strokeWidth: 4, ...extra },
  };
}

/** Pure function. Every op in a flat IR array that OWNS a stroke — the ops the
 *  stamper is contracted to reach, and the only ones a divisor could apply to. */
function strokedOps(cmds) {
  const out = [];
  const walk = (list) => {
    for (const c of list) {
      if (c.stroke != null) out.push(c);
      if (Array.isArray(c.content)) walk(c.content);
    }
  };
  walk(cmds);
  return out;
}

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
  // The key is single-sourced (STROKE_SPACE_KEYS) rather than a literal in each
  // bundle. It was a literal, and that is exactly why the four hand-splicing shape
  // widgets never got the row: there was no list for them to splice.
  assert.deepEqual(STROKE_SPACE_KEYS, ["strokeScreenSpace"]);
});

/**
 * ── (8)-(10): THE ASSERTIONS WHOSE ABSENCE LET THIS SHIP INERT ───────────────
 *
 * User, 2026-08-12: "Im solidly convinced that the screen-space size checkbox for
 * stroke does jack shit". He was right, and tests (5)-(6) above are the reason
 * nobody noticed: they assert that the IR BUILDER accepts the key, and that the
 * BUNDLE offers the row. Both passed for the feature's whole broken life, because
 * neither one joins the two halves. Nothing ever asked the question in between —
 * does a REAL WIDGET, given the state its own checkbox writes, emit an op carrying
 * the flag? — and the answer was no for every widget in the app except the media
 * family (which reaches it through decorate.js, a helper the shape widgets do not
 * call).
 *
 * So these drive `sceneIR` over real registered plugins. That is deliberately the
 * whole pipeline and not `plugin.emit()` alone: the fix is a STAMPER at the ports
 * seam (ir.js applyStrokeSpace), so a test that called emit() directly would miss
 * it entirely and a test that only checked the stamper in isolation would not
 * prove the seam is wired into the walk.
 */
test("(8) IT REACHES A REAL WIDGET'S OPS — rect and circle, through the ports seam", () => {
  for (const type of ["rect", "circle"]) {
    const plugin = registry.get(type);
    assert.ok(plugin, `${type} is not registered — the gate has no subject`);
    const on = strokedOps(sceneIR([widgetNode(plugin, { strokeScreenSpace: true })]));
    assert.ok(on.length > 0, `${type}: emitted no stroked op to carry the flag`);
    assert.ok(
      on.every((o) => o.strokeScreenSpace === true),
      `${type}: the checkbox is ON but ${on.filter((o) => o.strokeScreenSpace !== true).length}/${on.length} stroked ops do not carry strokeScreenSpace — this is the "does jack shit" defect`,
    );
  }
});

test("(9) OFF IS BYTE-IDENTICAL — the absent-is-legacy contract, on real widgets", () => {
  for (const type of ["rect", "circle"]) {
    const plugin = registry.get(type);
    for (const off of [{}, { strokeScreenSpace: false }]) {
      const ops = strokedOps(sceneIR([widgetNode(plugin, off)]));
      assert.ok(ops.length > 0, `${type}: no stroked op emitted for the OFF control`);
      assert.ok(
        ops.every((o) => !("strokeScreenSpace" in o)),
        `${type}: an un-opted widget emitted the key — false must never become a field, or every pre-feature document's ops change shape`,
      );
    }
  }
});

test("(10) LINE IS EXCLUDED ON PURPOSE — baked cap geometry has no width to scale", () => {
  // line's round-cap branch emits `polyline` (width in cmd.width, no cmd.stroke)
  // and its flat-cap branch emits a FILLED path whose caps were built at world
  // width. The stamper's `cmd.stroke != null` rule skips both by construction —
  // asserted here so the exclusion is a recorded decision rather than something a
  // later reader "fixes" into a knob that cannot work.
  const plugin = registry.get("line");
  assert.ok(plugin, "line is not registered");
  assert.ok(
    !(plugin.inspector ?? []).some((r) => r.key === "strokeScreenSpace"),
    "line must not offer a checkbox its geometry cannot honour — a visible inert knob is the defect this whole suite exists for",
  );
  const ops = sceneIR([widgetNode(plugin, { strokeScreenSpace: true })]);
  assert.ok(
    ops.every((o) => !("strokeScreenSpace" in o)),
    "line emitted the flag onto an op that cannot honour it",
  );
});

test("(7) TEXT SHARES THE RULE AND THE DIVISOR (#283) — same opt-in, same absence", () => {
  const base = { text: "hi", x: 0, y: 0, size: 20, color: "#000" };
  assert.ok(!("sizeScreenSpace" in textOp(base)), "absent by default — an un-opted text op is byte-identical");
  assert.ok(!("sizeScreenSpace" in textOp({ ...base, sizeScreenSpace: false })), "false must not become a key either");
  assert.equal(textOp({ ...base, sizeScreenSpace: true }).sizeScreenSpace, true);
  // The point of reusing screenSpaceDivisor: text and stroke cannot drift apart
  // about what "screen space" means, including the export case.
  assert.equal(screenSpaceDivisor(1, 4, 1), 4, "text at 4x editor zoom shrinks its local size 4x");
  assert.equal(screenSpaceDivisor(1, 4, 4), 1, "…and a 4x EXPORT leaves it alone, exactly as for strokes");
});

console.log(`\n${passed} screen-space tests passed`);
