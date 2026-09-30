/** Colour brainstorming from the ramp library — the pure rules behind the gradient map
 * and "ramp along path" (core/multipoint_recolor.js). Properties the doctests cannot
 * state: no closed-path seam for EVERY shipped ramp, the gradient map never touching
 * geometry, and the path ramp keeping the other side's picture.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_recolor_test.js */
import assert from "node:assert/strict";
import { rampPathStops, rampAppliedStops, gradientMapWrites, colorLightness } from "../core/multipoint_recolor.js";
import { stopColorAt, featureEditRefusal } from "../core/multipoint_edit.js";
import { CYCLIC_RAMPS, SEQUENTIAL_RAMPS, sampleRampHex } from "../core/ramps.js";
import { MULTIPOINT_PRESETS } from "../core/multipoint_presets.js";
import { RAMP_PRESET_FAMILIES } from "../web/ramp_preset_families.js";
import { setPath, blendApplied } from "../core/deltas.js";
import { parsePaint } from "../render_gpu/ir.js";

let passed = 0;
/** Command. Runs one assertion group and reports it. */
function test(name, check) { check(); passed++; console.log(`  ok  ${name}`); }
const LIBRARY = RAMP_PRESET_FAMILIES.flatMap((f) => f.presets);

test("every library ramp lays on a path; closed paths never show a seam", () => {
  assert.ok(LIBRARY.length > 300, "the whole ramp library, not a sample");
  for (const ramp of LIBRARY) {
    for (const closed of [false, true]) for (const reversed of [false, true]) {
      const stops = rampPathStops(ramp, { closed, reversed });
      assert.ok(stops.every((s, i) => s.offset >= 0 && s.offset <= 1 && (!i || s.offset >= stops[i - 1].offset)), `${ramp.name}: sorted offsets in [0,1]`);
      if (closed) assert.equal(stops[0].color, stops.at(-1).color, `${ramp.name}: closed seam`);
    }
  }
});

test("an sRGB clamped ramp lands verbatim; an OKLab ramp hits its authored stops exactly", () => {
  const srgb = LIBRARY.find((r) => r.space === "srgb" && !r.loop);
  assert.deepEqual(rampPathStops(srgb).map((s) => s.color), srgb.stops.map((s) => s.color));
  for (const ramp of [...Object.values(CYCLIC_RAMPS), ...Object.values(SEQUENTIAL_RAMPS)].filter((r) => r.space === "oklab")) {
    const stops = rampPathStops(ramp);
    for (const s of ramp.stops) assert.equal(stopColorAt({ stops }, s.offset, "color"), sampleRampHex(ramp.stops, s.offset, ramp), `${ramp.label} @${s.offset}`);
  }
});

test("a one-sided path ramp keeps the other side's picture", () => {
  const feature = { stops: [{ offset: 0, color: "#102030", rightColor: "#ff0000" }, { offset: 0.7, color: "#405060", rightColor: "#00ff00" }] };
  const ramp = rampPathStops({ stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], loop: false, space: "srgb" });
  const after = { stops: rampAppliedStops(feature, ramp, "color") };
  for (const t of [0, 0.2, 0.5, 0.7, 0.9, 1]) {
    assert.equal(stopColorAt(after, t, "rightColor"), stopColorAt(feature, t, "rightColor"), `right side unchanged at ${t}`);
    assert.equal(stopColorAt(after, t, "color"), sampleRampHex(ramp, t, {}), `left side is the ramp at ${t}`);
  }
});

test("the gradient map recolours every shipped preset without touching geometry", () => {
  const ramp = LIBRARY.find((r) => r.space === "srgb" && !r.loop && r.stops.length >= 3);
  for (const preset of MULTIPOINT_PRESETS) {
    const { writes, skipped } = gradientMapWrites(preset.paint.multipoint, ramp);
    assert.deepEqual(skipped, [], preset.id);
    assert.ok(writes.every(([p]) => p[0] === "features" && p[2] === "stops" && (p[4] === "color" || p[4] === "rightColor")), `${preset.id}: colour leaves only`);
    let d = {};
    for (const [p, v] of writes) d = setPath(d, p, v);
    const recoloured = blendApplied(structuredClone(preset.paint.multipoint), d, 1);
    parsePaint({ type: preset.paint.type, multipoint: recoloured });
    assert.deepEqual(recoloured.features.map((f) => f.nodes), preset.paint.multipoint.features.map((f) => f.nodes), `${preset.id}: geometry untouched`);
  }
});

test("the gradient map keeps light/dark order and leaves equations alone", () => {
  const ramp = { stops: [{ offset: 0, color: "#200040" }, { offset: 1, color: "#ffe080" }], loop: false, space: "srgb" };
  const mp = { features: ["#101010", "#808080", "#f0f0f0"].map((color, i) => ({ nodes: [[i / 2, 0.5, 0, 0, 0, 0]], stops: [{ offset: 0, color }] })) };
  mp.features.push({ nodes: [[0, 0, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0]], stops: [{ offset: 0, color: "= a.fill" }] });
  const { writes, skipped } = gradientMapWrites(mp, ramp);
  const out = writes.map(([, hex]) => colorLightness(hex));
  assert.ok(out[0] < out[1] && out[1] < out[2], "darker stays darker");
  assert.equal(writes[0][1], "#200040", "darkest takes the ramp start");
  assert.equal(writes[2][1], "#ffe080", "lightest takes the ramp end");
  assert.deepEqual(skipped, ["source 4 colour 1 is an equation"]);
  assert.equal(gradientMapWrites(mp, ramp, { reversed: true }).writes[0][1], "#ffe080", "Reverse maps dark to the end");
  assert.ok(featureEditRefusal(mp.features[3], "ramp"), "a path ramp would erase that equation, so it is refused");
});

console.log(`\n${passed} multipoint recolour tests passed`);
