/**
 * THE COLOUR-RAMP suite (core/ramps.js + core/ramp_migration.js + the shared
 * `ramp` property family). Bare node, DOM-free.
 *
 * WHAT IT GATES, in the order the reader should meet it:
 *   1. THE LOOP BOUNDARY — the semantics that "it wraps" hides, including the
 *      i/N vs i/(N−1) off-by-one that would change every sampled colour.
 *   2. THE BLEND SPACE — that sRGB and OKLab are genuinely different, that the
 *      DEFAULT is the one which leaves existing gradients unchanged, and that a
 *      ramp's space travels with the ramp.
 *   3. GENERALISATION — that the ramp is a DECLARED property family with Tier-0
 *      `=` on every slot including per-element, and that the preset library is
 *      mounted from the declaration rather than from one field.
 *   4. ONE PRESET LIBRARY — that the shared library is shared, not copied: the
 *      picker's cyclic family and the Mandelbrot plugin read the same objects.
 *   5. THE CAPABILITY WIN — that a palette now TWEENS, which it provably could
 *      not when it was a `select` plus a `text` override.
 *   6. THE MIGRATION — loud, lossless, folding, idempotent.
 */

import assert from "node:assert/strict";
import {
  RAMP_SPACES, RAMP_SPACE_LABELS, DEFAULT_RAMP_SPACE, COLOR_RAMP_LIBRARY, RAMP_PRESET_LIBRARIES,
  CYCLIC_RAMPS, DEFAULT_CYCLIC_RAMP, blendRampLinear, bakeRampLut, checkRampStops, cyclicRampStops,
  evenlySpacedRampStops, legacyOverrideColors, linearToSrgb, rampSegmentAt, rampStopsFromLegacyPalette,
  sampleRampHex, sampleRampLinear, srgbToLinear, stopRgba,
} from "../core/ramps.js";
import {
  LEGACY_PALETTE_KEYS, LEGACY_RAMP_ASPECTS, MANDELBROT_TYPE, RAMP_STOPS_KEY,
  paletteRampMigrations, rampMigrationReports, withPaletteRampMigrated,
} from "../core/ramp_migration.js";
import { BUNDLES, GRADIENT_STOPS_LIST, PROPS, RAMP_STOP_ELEMENT, bundle } from "../core/properties.js";
import { listSlotKind, resultKindForSlot } from "../core/expressions.js";
import { interpolate } from "../core/interpolators.js";
import { mandelbrotPlugin, rampOf } from "../plugins/demo/mandelbrot.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  NOT OK  ${name}`);
    throw e;
  }
}

const BW = [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }];
/** A two-colour CYCLIC ramp: stops at 0 and 0.5, so the wrap segment 0.5 → 1 is
 *  the same length as the declared one and the ramp is seamless. */
const BW_CYCLIC = [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ffffff" }];

// ── (1) THE LOOP BOUNDARY ─────────────────────────────────────────────────────

test("loop OFF clamps: outside the declared span the end colours hold", () => {
  assert.equal(sampleRampHex(BW, -5, {}), "#000000");
  assert.equal(sampleRampHex(BW, 0, {}), "#000000");
  assert.equal(sampleRampHex(BW, 1, {}), "#ffffff");
  assert.equal(sampleRampHex(BW, 99, {}), "#ffffff");
  assert.equal(sampleRampHex(BW, 0.5, {}), "#808080");
});

test("loop ON has period EXACTLY 1 — t, t+1 and t+1000 read the same", () => {
  for (const t of [0, 0.1, 0.37, 0.5, 0.99]) {
    const a = sampleRampHex(BW_CYCLIC, t, { loop: true });
    assert.equal(sampleRampHex(BW_CYCLIC, t + 1, { loop: true }), a, `t=${t} vs t+1`);
    assert.equal(sampleRampHex(BW_CYCLIC, t + 1000, { loop: true }), a, `t=${t} vs t+1000`);
    assert.equal(sampleRampHex(BW_CYCLIC, t - 3, { loop: true }), a, `t=${t} vs t-3`);
  }
});

test("loop ON SYNTHESISES the last→first segment — the wrap is a blend, not a jump", () => {
  // Stops at 0 (black) and 0.5 (white). The declared segment ramps black→white over
  // [0, 0.5]; the SYNTHESISED wrap segment ramps white→black over [0.5, 1].
  assert.equal(sampleRampHex(BW_CYCLIC, 0.25, { loop: true }), "#808080");
  assert.equal(sampleRampHex(BW_CYCLIC, 0.5, { loop: true }), "#ffffff");
  assert.equal(sampleRampHex(BW_CYCLIC, 0.75, { loop: true }), "#808080", "halfway back down the wrap segment");
  assert.equal(sampleRampHex(BW_CYCLIC, 0, { loop: true }), "#000000");
  // Seamless: approaching 1 from below converges on the value AT 0.
  assert.equal(sampleRampHex(BW_CYCLIC, 1 - 1e-9, { loop: true }), "#000000");
});

test("loop ON: offset 1 IS offset 0, so stops at BOTH give a deliberate HARD SEAM", () => {
  // The wrap segment's length is 1 − offset_last + offset_0 = 0 here, so there is
  // nothing to blend across and the seam is hard. That is the documented way to
  // author one — and it is what a ramp taken from the gradient library does, since
  // gradients are authored with stops at both ends.
  assert.equal(sampleRampHex(BW, 0.999, { loop: true }), "#ffffff");
  assert.equal(sampleRampHex(BW, 1, { loop: true }), "#000000", "one turn later: back to the first stop");
  assert.equal(sampleRampHex(BW, 0.5, { loop: true }), "#808080", "the declared segment is unaffected");
});

test("THE OFF-BY-ONE: an evenly spaced CYCLIC ramp is i/N, a clamped one is i/(N-1)", () => {
  // i/(N-1) would put the last stop at offset 1, squashing the wrap segment to zero
  // and changing EVERY sampled colour of a cyclic ramp.
  assert.deepEqual(evenlySpacedRampStops(["#a", "#b", "#c", "#d"].map(() => "#000000"), true).map((s) => s.offset), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(evenlySpacedRampStops(new Array(4).fill("#000000"), false).map((s) => s.offset), [0, 1 / 3, 2 / 3, 1]);
  assert.throws(() => evenlySpacedRampStops(["#000000"], true), /at least 2 colours/);
});

test("phase rotates the ramp, wraps with it, and applies BEFORE the wrap", () => {
  assert.equal(sampleRampHex(BW_CYCLIC, 0, { loop: true, phase: 0.5 }), "#ffffff");
  assert.equal(sampleRampHex(BW_CYCLIC, 0, { loop: true, phase: 1.5 }), "#ffffff", "1.25 looks exactly like 0.25");
  assert.equal(sampleRampHex(BW_CYCLIC, 0.25, { loop: true, phase: -0.25 }), "#000000");
});

test("rampSegmentAt: the segment a position falls in, and -1 outside every one", () => {
  const three = [{ offset: 0 }, { offset: 0.5 }, { offset: 1 }];
  assert.equal(rampSegmentAt(three, 0), 0);
  assert.equal(rampSegmentAt(three, 0.49), 0);
  assert.equal(rampSegmentAt(three, 0.5), 1);
  assert.equal(rampSegmentAt(three, 1), -1, "no segment STARTS at the last stop");
  assert.equal(rampSegmentAt([{ offset: 0.25 }, { offset: 0.75 }], 0.1), -1);
});

test("LOUD on a ramp that cannot be one: too short, non-finite, or out of order", () => {
  assert.throws(() => checkRampStops([{ offset: 0, color: "#000000" }]), /at least 2 stops/);
  assert.throws(() => checkRampStops("nope"), /at least 2 stops/);
  assert.throws(() => checkRampStops([{ offset: 0, color: "#000000" }, { color: "#fff" }]), /no finite "offset"/);
  assert.throws(() => checkRampStops([{ offset: 1, color: "#000000" }, { offset: 0, color: "#ffffff" }]), /before its predecessor/);
  assert.throws(() => sampleRampLinear(BW, 0.5, { space: "hsl" }), /unknown space/);
  assert.throws(() => stopRgba("rgb(1,2,3)"), /must be hex/);
});

// ── (2) THE BLEND SPACE ───────────────────────────────────────────────────────

test("the DEFAULT space is the one that leaves every existing gradient unchanged", () => {
  assert.equal(DEFAULT_RAMP_SPACE, "srgb");
  assert.ok(RAMP_SPACES.includes("oklab"));
  for (const s of RAMP_SPACES) assert.ok(RAMP_SPACE_LABELS[s], `no label for ${s}`);
  // sRGB blends the STORED channels, which is what Skia/SVG/PDF gradients do.
  assert.equal(sampleRampHex(BW, 0.5, {}), "#808080");
  assert.equal(sampleRampHex(BW, 0.5, { space: "srgb" }), "#808080");
});

test("OKLab is genuinely a different blend, and the difference is the MUD it avoids", () => {
  // Measured, not assumed. Black→white: OKLab's midpoint is #636363, DARKER than
  // the encoded #808080, because OKLab's L is PERCEPTUAL lightness and half the
  // perceived lightness of white is darker than half its encoded channel value.
  assert.equal(sampleRampHex(BW, 0.5, { space: "srgb" }), "#808080");
  assert.equal(sampleRampHex(BW, 0.5, { space: "oklab" }), "#636363");

  // THE CASE THE SPACE EXISTS FOR: two distant hues. sRGB drags red→blue through a
  // dark, desaturated purple (#800080); OKLab keeps the blend bright (#8c53a2).
  // "No ramp passes through mud" is exactly this, and it is measurable as light.
  const rb = [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }];
  const light = (hex) => [1, 3, 5].reduce((a, i) => a + srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255), 0);
  const muddy = light(sampleRampHex(rb, 0.5, { space: "srgb" }));
  const clean = light(sampleRampHex(rb, 0.5, { space: "oklab" }));
  assert.ok(clean > muddy * 1.5, `the OKLab red→blue midpoint must be markedly brighter: ${clean.toFixed(4)} vs ${muddy.toFixed(4)}`);
});

test("alpha blends in its own units in BOTH spaces — it is coverage, not colour", () => {
  const fade = [{ offset: 0, color: "#ff000000" }, { offset: 1, color: "#ff0000ff" }];
  for (const space of RAMP_SPACES) {
    const a = sampleRampLinear(fade, 0.5, { space })[3];
    assert.ok(Math.abs(a - 0.5) < 1e-9, `${space}: alpha ${a}`);
  }
  assert.equal(blendRampLinear([0, 0, 0, 0], [0, 0, 0, 1], 0.25, "oklab")[3], 0.25);
});

test("the sRGB transfer function round-trips, and a mid grey is NOT half the light", () => {
  for (const v of [0, 0.02, 0.25, 0.5, 0.7354, 1])
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(v)) - v) < 1e-9, `round-trip at ${v}`);
  assert.ok(Math.abs(srgbToLinear(0.5) - 0.2140) < 1e-3, "#808080 carries ~21% of white's light");
});

// ── (3) GENERALISATION: a DECLARED family with Tier-0 `=` everywhere ──────────

test("the ramp is a DECLARED property family, not a widget's private state", () => {
  assert.deepEqual(BUNDLES.ramp, ["rampStops", "rampLoop", "rampSpace", "rampPhase"]);
  assert.equal(PROPS.rampStops.kind, "list");
  assert.equal(PROPS.rampStops.order, "sorted");
  assert.equal(PROPS.rampStops.orderKey, "offset");
  assert.equal(PROPS.rampStops.activeKey, "rampStopsActive");
  assert.equal(PROPS.rampStops.minLength, 2);
  assert.equal(PROPS.rampLoop.default, false, "a gradient must keep clamping by default");
  assert.equal(PROPS.rampSpace.default, DEFAULT_RAMP_SPACE);
  assert.equal(PROPS.rampPhase.default, 0);
  assert.ok(PROPS.rampPhase.scrub, "an unbounded periodic knob with a 0 default MUST declare a scrub");
  assert.equal(bundle("ramp").length, 4);
});

test("TIER 0: every ramp slot is `=`-bindable, per ELEMENT included", () => {
  assert.equal(listSlotKind(["rampStops"]), "list");
  assert.equal(listSlotKind(["rampStops", 0, "offset"]), "number");
  assert.equal(listSlotKind(["rampStops", 9, "color"]), "color", "index-INDEPENDENT: from the declaration, not from a default list");
  assert.equal(listSlotKind(["rampStopsActive", 3]), "boolean");
  assert.equal(listSlotKind(["rampStops", 0]), null, "a whole ELEMENT is not a slot — its fields are");
  const plugin = { defaults: {} };
  assert.equal(resultKindForSlot(plugin, ["rampLoop"], "= true"), "boolean");
  assert.equal(resultKindForSlot(plugin, ["rampSpace"], '= "oklab"'), "select");
  assert.equal(resultKindForSlot(plugin, ["rampPhase"], "= 0.25"), "number");
});

test("the STOP ELEMENT is declared ONCE and both ramp declarations reference it", () => {
  assert.equal(GRADIENT_STOPS_LIST.element, RAMP_STOP_ELEMENT, "the paint's stops and rampStops must be the SAME element object");
  assert.equal(PROPS.rampStops.element, RAMP_STOP_ELEMENT);
  assert.deepEqual(RAMP_STOP_ELEMENT.fields.map((f) => f.name), ["offset", "color"]);
});

test("the PRESET LIBRARY is mounted from the DECLARATION, so any ramp can have one", () => {
  // This is the generalization: the library used to be mounted privately by
  // web/PaintField.svelte, which is why no property but a paint could have one.
  assert.equal(GRADIENT_STOPS_LIST.presets, COLOR_RAMP_LIBRARY);
  assert.equal(PROPS.rampStops.presets, COLOR_RAMP_LIBRARY);
  assert.ok(RAMP_PRESET_LIBRARIES.includes(COLOR_RAMP_LIBRARY));
  // A picked preset is a whole ramp VALUE, so the declaration says where each
  // aspect lands. The paint's stops declare no homes (it stores no loop/space
  // today), so picking a preset there changes only the stops — byte-identically.
  assert.deepEqual(PROPS.rampStops.presetAspectKeys, { loop: "rampLoop", space: "rampSpace" });
  assert.equal("presetAspectKeys" in GRADIENT_STOPS_LIST, false);
});

// ── (4) ONE PRESET LIBRARY, SHARED — not copied ───────────────────────────────

test("the six named palettes are shared RAMP DATA with their domain knowledge attached", () => {
  assert.equal(Object.keys(CYCLIC_RAMPS).length, 6);
  for (const [id, ramp] of Object.entries(CYCLIC_RAMPS)) {
    assert.equal(ramp.id, id);
    assert.ok(ramp.label, `${id} needs a human label`);
    assert.equal(ramp.loop, true, `${id}: cyclicity is MANDATORY at depth, not stylistic`);
    assert.equal(ramp.space, "oklab", `${id}: perceptual blending is why it does not pass through mud`);
    assert.deepEqual(ramp.stops, evenlySpacedRampStops(ramp.colors, true), `${id}: stops derive from colours — one home for the spacing`);
  }
});

test("the Mandelbrot plugin reads its ramp from that ONE home, and copies it", () => {
  assert.deepEqual(mandelbrotPlugin.defaults.rampStops, cyclicRampStops(DEFAULT_CYCLIC_RAMP));
  assert.notEqual(mandelbrotPlugin.defaults.rampStops, CYCLIC_RAMPS[DEFAULT_CYCLIC_RAMP].stops,
    "a document must hold a FRESH copy, never alias author-time data");
  assert.notEqual(cyclicRampStops("gold"), cyclicRampStops("gold"), "each call is a fresh array");
  assert.throws(() => cyclicRampStops("nope"), /unknown cyclic ramp/);
});

test("the migration's aspect values and the plugin's own defaults AGREE", () => {
  // Two declarations of the same fact (the migration is a pure function of the
  // document and cannot import the plugin), so this is the gate that keeps them
  // from drifting.
  for (const [key, value] of Object.entries(LEGACY_RAMP_ASPECTS))
    assert.equal(mandelbrotPlugin.defaults[key], value, `${key}: the migration writes ${value}`);
});

test("rampOf falls back to the WIDGET'S aspects, not the registry's clamped sRGB", () => {
  const stops = cyclicRampStops("gold");
  assert.equal(rampOf({ rampStops: stops }).loop, true);
  assert.equal(rampOf({ rampStops: stops }).space, "oklab");
  assert.equal(rampOf({ rampStops: stops, rampLoop: false }).loop, false);
});

// ── (5) THE CAPABILITY WIN: a palette TWEENS ──────────────────────────────────

test("A PALETTE NOW TWEENS — the thing a `select` + a `text` override could NOT do", () => {
  // BEFORE: the palette was a select id ("gold") plus a comma-separated string.
  // core/interpolators.js is DISCRETE for unlike strings, so any palette change
  // SNAPPED at alpha > 0. The old row's own help said so: "Being text, this
  // switches rather than tweens."
  assert.equal(interpolate("gold", "ice", 0.5), "ice", "the retired select snapped");
  assert.equal(interpolate("#001028, #ffd27f", "#0b0d10, #6e7680", 0.5), "#0b0d10, #6e7680", "the retired text override snapped");

  // AFTER: a ramp is a same-length list of records, so it tweens element-wise —
  // each offset lerps and each colour blends per channel.
  const gold = cyclicRampStops("gold");
  const ice = cyclicRampStops("ice");
  assert.equal(gold.length, ice.length, "gold and ice are both 8 stops");
  const half = interpolate(gold, ice, 0.5);
  assert.equal(half.length, 8);
  for (let i = 0; i < 8; i++) {
    assert.equal(half[i].offset, gold[i].offset, `stop ${i} keeps its position (both ramps are i/8)`);
    assert.notEqual(half[i].color, gold[i].color, `stop ${i} must have MOVED off gold`);
    assert.notEqual(half[i].color, ice[i].color, `stop ${i} must not have SNAPPED to ice`);
  }
  // And the tween is monotone in alpha: a quarter of the way is nearer gold.
  const quarter = interpolate(gold, ice, 0.25);
  const dist = (a, b) => Math.abs(parseInt(a.slice(1), 16) - parseInt(b.slice(1), 16));
  assert.ok(dist(quarter[3].color, gold[3].color) < dist(half[3].color, gold[3].color));
});

test("A DIFFERENT-LENGTH ramp still snaps — the universal STRUCTURAL rule, stated not hidden", () => {
  // core/interpolators.js treats ANY array length change as discrete (the same rule
  // a polygon gaining a vertex obeys). So gold (8) → twilight (6) snaps. This is a
  // real remaining bound, NOT a ramp defect, and closing it would mean a resampling
  // interpolator for every list property in the app.
  const gold = cyclicRampStops("gold");
  const twilight = cyclicRampStops("twilight");
  assert.notEqual(gold.length, twilight.length);
  assert.deepEqual(interpolate(gold, twilight, 0.5), twilight);
});

test("the LUT bake is sampled at i/count, so the shader's cyclic gather is seamless", () => {
  const { lut, mean } = bakeRampLut(BW_CYCLIC, 4, { loop: true });
  assert.equal(lut.length, 12);
  // t = 0, 0.25, 0.5, 0.75 → black, grey, white, grey (in LINEAR light)
  assert.equal(lut[0], 0);
  assert.ok(Math.abs(lut[6] - 1) < 1e-12, "t = 0.5 is the white stop");
  assert.ok(Math.abs(lut[3] - lut[9]) < 1e-12, "t = 0.25 and t = 0.75 are symmetric about the white stop");
  assert.ok(mean[0] > 0 && mean[0] < 1);
  assert.throws(() => bakeRampLut(BW, 0, {}), /positive integer/);
  assert.throws(() => bakeRampLut(BW, 2.5, {}), /positive integer/);
});

// ── (6) THE MIGRATION ─────────────────────────────────────────────────────────

/** Query→build. A minimal document with one mandelbrot item and the given
 *  per-slide legacy writes. */
function legacyDoc(perSlide) {
  return {
    meta: { name: "t", slideW: 100, slideH: 100 },
    slides: perSlide.map((writes, i) => ({
      id: `s${i}`, name: `${i}`, transition: { type: "tween", seconds: 1, curve: "linear", sound: null },
      delta: { items: { m: i === 0 ? { type: MANDELBROT_TYPE, ...writes } : writes } },
    })),
  };
}

test("the migration is LOUD, and names both retired keys", () => {
  assert.deepEqual(LEGACY_PALETTE_KEYS, ["paletteStops", "palette"]);
  const { migrated } = withPaletteRampMigrated(legacyDoc([{ palette: "ice", paletteStops: "" }]));
  const reports = rampMigrationReports(migrated);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /legacy palette \(paletteStops, palette\)/);
  assert.match(reports[0], /8-stop cyclic ramp \(rampStops\)/);
  assert.match(reports[0], /OKLab/);
});

test("the migration RESOLVES the old rule: an override of 2+ colours beats the name", () => {
  assert.deepEqual(legacyOverrideColors("#000000, #ffffff"), ["#000000", "#ffffff"]);
  assert.deepEqual(legacyOverrideColors("#ff0000"), [], "one colour cannot cycle");
  assert.deepEqual(legacyOverrideColors(""), []);
  assert.deepEqual(rampStopsFromLegacyPalette({ palette: "gold", paletteStops: "#000000, #ffffff" }), BW_CYCLIC);
  assert.deepEqual(rampStopsFromLegacyPalette({ palette: "ice" }), cyclicRampStops("ice"));
  assert.deepEqual(rampStopsFromLegacyPalette({ palette: "nope" }), cyclicRampStops(DEFAULT_CYCLIC_RAMP));
  assert.deepEqual(rampStopsFromLegacyPalette({}), cyclicRampStops(DEFAULT_CYCLIC_RAMP));
});

test("THE MIGRATION FOLDS — the case a per-slide conversion gets WRONG", () => {
  // The real projects/Fractals/doc.json shape: slide 1 sets an override, slide 2
  // sets a NAME which the still-folded override SHADOWS. Slide 2's picture was
  // never ember, so its migrated ramp must be the override's.
  const doc = legacyDoc([
    { palette: "gold", paletteStops: "" },
    { paletteStops: "#111111, #222222, #333333" },
    { palette: "ember" },
  ]);
  const { doc: out, migrated } = withPaletteRampMigrated(doc);
  assert.equal(migrated.length, 3);
  assert.deepEqual(out.slides[0].delta.items.m.rampStops, cyclicRampStops("gold"));
  assert.deepEqual(out.slides[1].delta.items.m.rampStops.map((s) => s.color), ["#111111", "#222222", "#333333"]);
  assert.deepEqual(out.slides[2].delta.items.m.rampStops.map((s) => s.color), ["#111111", "#222222", "#333333"],
    "the shadowed name must NOT become ember — that is not what the document looked like");
  assert.equal(migrated[2].shadowed, true);
  assert.match(rampMigrationReports(migrated)[2], /never rendered/);
  // The keyframe STRUCTURE survives: a keyframe the user placed on slide 2 is still
  // a keyframe, even though it resolves to the same ramp.
  assert.ok(RAMP_STOPS_KEY in out.slides[2].delta.items.m);
});

test("the migration writes the two constant ASPECTS once, at the CREATION slide", () => {
  const { doc: out } = withPaletteRampMigrated(legacyDoc([{}, { palette: "ice" }]));
  assert.equal(out.slides[0].delta.items.m.rampLoop, true);
  assert.equal(out.slides[0].delta.items.m.rampSpace, "oklab");
  assert.equal("rampLoop" in out.slides[1].delta.items.m, false, "an aspect is constant — one write, not one per slide");
});

test("the migration is IDEMPOTENT, leaves no legacy key, and ignores other widgets", () => {
  const once = withPaletteRampMigrated(legacyDoc([{ palette: "gold", paletteStops: "#001028, #ffd27f" }]));
  for (const key of LEGACY_PALETTE_KEYS) assert.equal(key in once.doc.slides[0].delta.items.m, false, `${key} must be gone`);
  assert.equal(withPaletteRampMigrated(once.doc).migrated.length, 0);
  assert.deepEqual(paletteRampMigrations(once.doc), []);
  const rect = { meta: {}, slides: [{ delta: { items: { r: { type: "rect", palette: "gold" } } } }] };
  assert.deepEqual(paletteRampMigrations(rect), [], "only the mandelbrot's palette is this migration's business");
});

test("a slide that ALREADY writes a ramp keeps it — the legacy keys are only dropped", () => {
  const doc = legacyDoc([{ palette: "ice", rampStops: BW_CYCLIC }]);
  const { doc: out, migrated } = withPaletteRampMigrated(doc);
  assert.deepEqual(out.slides[0].delta.items.m.rampStops, BW_CYCLIC, "the new key is authoritative");
  assert.equal("palette" in out.slides[0].delta.items.m, false);
  assert.equal(migrated[0].stale, true);
  assert.match(rampMigrationReports(migrated)[0], /stale legacy keys dropped/);
});

console.log(`\n${passed} ramp tests passed`);
