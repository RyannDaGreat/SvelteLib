/**
 * GOD RAYS — bare-node suite for the screen-space light-scattering widget
 * (plugins/demo/god_rays.js + render_gpu/skia/god_rays_shader.js).
 *
 * Covers the four claims the widget makes that a browser probe cannot cheaply
 * check: the material is registered as a BACKDROP kind (which is what gives the
 * shader the composite-so-far it treats as an occlusion buffer), the world→device
 * light seam round-trips, the uniform packing is stable and NaN-refusing, and emit()
 * is a pure function of state (byte-identical twice, which is the determinism law).
 *
 * The visual claims — beams emanate from the sun, an opaque rect shadows them,
 * clouds dapple them — are pixel assertions and live in god_rays_probe.js, which
 * renders a real deck through the real Skia backend.
 */

import test from "node:test";
import assert from "node:assert";

import { allPlugins } from "../plugins/index.js";
import { godRaysLightOffset, lightLocal } from "../plugins/demo/god_rays.js";
import {
  GOD_RAYS_FILL_PARAMS, GOD_RAYS_MATERIAL, GOD_RAYS_SKSL,
  godRaysLightDevice, godRaysUniformParams, packGodRaysUniforms,
} from "../render_gpu/skia/god_rays_shader.js";
import { getMaterial, isBackdropMaterial, isSamplerMaterial, materialIds } from "../render_gpu/skia/materials.js";

const plugin = allPlugins.find((p) => p.type === "demo_god_rays");

/** A fully-evaluated item state (equations already folded), as ports.js hands emit(). */
function state(over = {}) {
  return {
    type: "demo_god_rays", x: 60, y: 60, w: 1000, h: 620, z: 200, rotation: 0, scale: 1,
    rotationAnchor: { x: 560, y: 370 },
    lightWorldX: 560, lightWorldY: 171.6,
    cornerRadius: 0, stroke: "rgba(255,255,255,0.18)", strokeWidth: 0, opacity: 1,
    ...Object.fromEntries(GOD_RAYS_FILL_PARAMS.map((d) => [d.name, d.default])),
    ...over,
  };
}

test("(1) registered as a BACKDROP material — which is what makes occlusion work at all", () => {
  assert.ok(plugin, "demo_god_rays is not in allPlugins");
  assert.equal(plugin.capabilities.backdrop, true, "must declare capabilities.backdrop: the shader reads the scene beneath");
  assert.ok(materialIds().includes("god_rays"), "god_rays absent from the material registry");

  const m = getMaterial("god_rays");
  assert.equal(isBackdropMaterial(m), true, "must be a BACKDROP material (the {blurred, sharp} child pair), not a foreground fill");
  assert.equal(isSamplerMaterial(m), false, "it IS SkSL — it must compile, not dispatch its own op");
  assert.equal(m.usesBlurredBackdrop, false, "a ray march reads sharp taps; a blurred occluder leaks light through blockers");

  // The reach is UNDECLARED on purpose: a pixel marches to a light that may be
  // outside the region, so the honest answer is 'the whole surface'. Declaring a
  // number would clamp the march mid-flight and smear one edge pixel along the beam.
  assert.equal(typeof m.maxSampleReach, "undefined", "god_rays must NOT declare maxSampleReach — its march reaches the whole surface");
});

test("(2) the shader really samples the backdrop, and only the sharp one", () => {
  const body = GOD_RAYS_SKSL.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.match(body, /sharpBackdrop\s*\.\s*eval/, "no sharpBackdrop.eval: nothing to scatter and nothing to be occluded by");
  assert.doesNotMatch(body, /blurredBackdrop\s*\.\s*eval/, "evals blurredBackdrop while declaring usesBlurredBackdrop:false");
  // The march must sample AWAY from the fragment — that displacement IS the effect.
  assert.match(body, /sharpBackdrop\s*\.\s*eval\s*\(\s*pos\s*\)/, "the backdrop tap must be at the marched position, not at the fragment");
  // No clock, no RNG: property state (CLAUDE.md's taxonomy).
  assert.doesNotMatch(body, /\buTime\b/, "a time uniform would make this recordable state, not property state");
});

test("(3) the world light maps into the widget's local frame, and back out again", () => {
  // Widget at (60,60); a light at world (560, 171.6) is local (500, 111.6).
  assert.deepEqual(lightLocal(state()), { x: 500, y: 111.6 });

  // The op carries the CENTRE-relative offset: local (500,111.6) minus centre (500,310).
  const off = godRaysLightOffset(state());
  assert.equal(off.x, 0);
  assert.ok(Math.abs(off.y - -198.4) < 1e-9, `expected -198.4, got ${off.y}`);

  // Moving the WIDGET must move the local light the opposite way — that is what
  // "the light is pinned in the document, not in the box" means.
  const moved = lightLocal(state({ x: 260 }));
  assert.equal(moved.x, 300, "widget moved +200 in world ⇒ same world light is 200 further left in local");

  // A light ABOVE the region is legal and must not be clamped (the off-frame sun).
  assert.deepEqual(lightLocal(state({ lightWorldX: 500, lightWorldY: -180 })), { x: 440, y: -240 });
});

test("(4) THE WORLD→SCREEN SEAM: offset + device centre + device scale = the light in device px", () => {
  // Identity camera: the offset is added straight to the device centre.
  assert.deepEqual(godRaysLightDevice({ cx: 480, cy: 270, scale: 1, angle: 0, lightOffsetX: 100, lightOffsetY: -50 }),
    { x: 580, y: 220 });

  // Zoom scales the OFFSET, not the centre (the framework already placed the centre).
  assert.deepEqual(godRaysLightDevice({ cx: 480, cy: 270, scale: 2, angle: 0, lightOffsetX: 100, lightOffsetY: 0 }),
    { x: 680, y: 270 });

  // A light AT the centre is a fixed point of the map under ANY rotation/zoom.
  const at = godRaysLightDevice({ cx: 300, cy: 200, scale: 3, angle: 1.2, lightOffsetX: 0, lightOffsetY: 0 });
  assert.ok(Math.hypot(at.x - 300, at.y - 200) < 1e-9);

  // A quarter turn takes +x to +y — the light rotates with the box it is measured from.
  const rot = godRaysLightDevice({ cx: 0, cy: 0, scale: 1, angle: Math.PI / 2, lightOffsetX: 10, lightOffsetY: 0 });
  assert.ok(Math.abs(rot.x) < 1e-9 && Math.abs(rot.y - 10) < 1e-9, `expected ~(0,10), got (${rot.x},${rot.y})`);
});

test("(5) emit() produces ONE materialBackdrop op carrying the light and every knob", () => {
  const ops = plugin.emit(state());
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "materialBackdrop");
  assert.equal(ops[0].material, "god_rays");
  assert.equal(ops[0].blurRadius, 0, "no blurred child is built, so a nonzero radius would be a lying field");

  for (const d of GOD_RAYS_FILL_PARAMS)
    assert.ok(d.name in ops[0].params, `knob "${d.name}" never reaches the op`);
  assert.ok("lightOffsetX" in ops[0].params && "lightOffsetY" in ops[0].params, "the light never reaches the op");
});

test("(6) DETERMINISM: same state ⇒ byte-identical uniforms, twice", () => {
  const pack = () => {
    const op = plugin.emit(state())[0];
    return packGodRaysUniforms({ cx: 500, cy: 310, halfW: 500, halfH: 310, cornerRadius: 0, angle: 0, scale: 1, ...op.params });
  };
  const a = pack(), b = pack();
  assert.equal(a.length, 20);
  assert.deepEqual([...a], [...b], "two renders of one document must pack identically — the determinism law");

  // Byte-level, not just value-level.
  assert.deepEqual([...new Uint8Array(a.buffer)], [...new Uint8Array(b.buffer)]);
});

test("(7) a non-finite uniform is REFUSED loudly (a NaN silently blackens the region)", () => {
  const base = { cx: 0, cy: 0, halfW: 10, halfH: 10, cornerRadius: 0, angle: 0, scale: 1,
    lightOffsetX: 0, lightOffsetY: 0, ...godRaysUniformParams(state()) };
  assert.throws(() => packGodRaysUniforms({ ...base, density: NaN }), /density.*finite/);
  assert.throws(() => packGodRaysUniforms({ ...base, exposure: Infinity }), /exposure.*finite/);
  // An off-screen light is NOT an error — it is the ordinary off-frame-sun case.
  assert.doesNotThrow(() => packGodRaysUniforms({ ...base, lightOffsetX: -99999, lightOffsetY: -99999 }));
});

test("(8) samples is clamped to the shader's compile-time loop bound", () => {
  assert.equal(godRaysUniformParams({ ...state(), samples: 1000 }).samples, 128, "must clamp to MAX_SAMPLES, not pack a value the loop cannot reach");
  assert.equal(godRaysUniformParams({ ...state(), samples: 0 }).samples, 1, "must floor at 1: a zero-tap march would divide the step by zero");
  assert.equal(godRaysUniformParams({ ...state(), samples: 63.7 }).samples, 64, "a fractional tap count is rounded, not truncated into a different march");
});

test("(9) presets tune the march as a set and NEVER move the light", () => {
  assert.ok(plugin.presets.length >= 3, "at least three presets were specified");
  for (const p of plugin.presets) {
    assert.ok(p.name && p.description, `preset ${p.name} lacks a description`);
    assert.ok(!("lightWorldX" in p.props) && !("lightWorldY" in p.props),
      `preset "${p.name}" carries a light position — a preset describes how light SCATTERS, not where it IS`);
    // Every prop a preset sets must be a real knob, or it silently does nothing.
    const known = new Set(GOD_RAYS_FILL_PARAMS.map((d) => d.name));
    for (const k of Object.keys(p.props))
      assert.ok(known.has(k), `preset "${p.name}" sets unknown knob "${k}"`);
    // The pack must accept it — a preset that cannot render is worse than none.
    assert.doesNotThrow(() => packGodRaysUniforms({
      cx: 0, cy: 0, halfW: 10, halfH: 10, cornerRadius: 0, angle: 0, scale: 1,
      lightOffsetX: 0, lightOffsetY: 0, ...godRaysUniformParams({ ...state(), ...p.props }),
    }), `preset "${p.name}" does not pack`);
  }
});

test("(10) the light handle round-trips a drag through world space", () => {
  const s = state();
  const mp = plugin.modifierPoints(s).find((m) => m.id === "light");
  assert.ok(mp, "no draggable light handle");
  // The handle sits exactly where the beams emanate from.
  assert.deepEqual({ x: mp.x, y: mp.y }, lightLocal(s));
  // Dragging to a local point writes the WORLD point that maps back to it.
  const patch = mp.apply(s, { x: 250, y: 40 });
  assert.deepEqual(patch, { lightWorldX: 310, lightWorldY: 100 });
  assert.deepEqual(lightLocal({ ...s, ...patch }), { x: 250, y: 40 }, "a drag must round-trip");
});

test("(12) NO packed uniform is EVER NaN — the bug that made the whole effect invisible", () => {
  // parseColor returns [r,g,b,a] in 0..1; reading it as {r,g,b} in 0..255 packed three
  // NaNs, one NaN poisoned the multiply chain, and the rays came out as a perfect
  // no-op — compiling, running, drawing nothing, raising nothing. A silent invisible
  // effect is the worst failure mode this widget has, so it is pinned on every knob
  // set the widget can actually be in: the defaults, and every preset.
  const packOf = (over) => packGodRaysUniforms({
    cx: 320, cy: 200, halfW: 320, halfH: 200, cornerRadius: 0, angle: 0, scale: 1,
    lightOffsetX: 40, lightOffsetY: -110, ...godRaysUniformParams({ ...state(), ...over }),
  });
  for (const [label, over] of [["defaults", {}], ...plugin.presets.map((p) => [p.name, p.props])]) {
    const packed = packOf(over);
    const bad = [...packed].map((v, i) => [i, v]).filter(([, v]) => !Number.isFinite(v));
    assert.equal(bad.length, 0, `${label}: non-finite uniforms at slots ${JSON.stringify(bad)}`);
  }

  // And specifically the tint, in the 0..1 range the shader multiplies by. A pure
  // white tint must be exactly 1,1,1 — not 1/255.
  const white = packOf({ tint: "#ffffff" });
  assert.deepEqual([white[17], white[18], white[19]], [1, 1, 1], "white tint must pack as 1,1,1 (parseColor is already 0..1)");
  const warm = packOf({ tint: "#ff8000" });
  assert.equal(warm[17], 1, "red channel of #ff8000");
  assert.ok(warm[19] === 0, "blue channel of #ff8000 is zero");
  assert.ok(warm[18] > 0 && warm[18] < 1, `green channel of #ff8000 should be a mid value, got ${warm[18]}`);
});

test("(13) the shader composites ADDITIVELY — alpha 0, premultiplied rgb", () => {
  // Skia's source-over is dst' = src.rgb + dst.rgb·(1 − src.a). Alpha 0 makes that
  // exactly dst + rays. Deriving alpha from the ray brightness instead INVERTS the
  // effect — bright rays become opaque and REPLACE the scene, so the sun renders
  // dimmer than its own white and shadowed patches read brighter than clear ones
  // (measured, before the fix). The shader carries an import-time guard for this;
  // this test pins it from the outside too, so the guard cannot be quietly deleted.
  const body = GOD_RAYS_SKSL.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const returns = [...body.matchAll(/return\s+half4\(([^;]*)\)\s*;/g)].map((m) => m[1].trim());
  assert.ok(returns.length > 0, "main() has no half4 return at all");
  // The FINAL return is the ray contribution; the early-outs are all half4(0.0).
  const last = returns[returns.length - 1];
  assert.match(last, /,\s*0\.0\s*$/, `the ray return must end in alpha 0.0 for additive compositing, got: half4(${last})`);
});

test("(11) a 'light' anchor is published so other widgets can bind TO the rays", () => {
  const anchors = plugin.anchors(state());
  assert.ok(Array.isArray(anchors), "anchors must be an ARRAY of {id,x,y} (the standardBBoxAnchors shape)");
  const light = anchors.find((a) => a.id === "light");
  assert.ok(light, "no 'light' anchor");
  assert.deepEqual({ x: light.x, y: light.y }, lightLocal(state()));
  for (const id of ["tl", "cm", "br"]) assert.ok(anchors.find((a) => a.id === id), `standard anchor ${id} lost`);
});
