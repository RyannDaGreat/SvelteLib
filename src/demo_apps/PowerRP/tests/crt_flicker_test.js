/**
 * THE CRT'S TWO PRESET FAMILIES + the flicker knob contract — plain node, no GPU.
 * Run: node src/demo_apps/PowerRP/tests/crt_flicker_test.js
 *
 * WHY THIS EXISTS SEPARATELY FROM tests/preset_contract_test.js. That suite proves
 * what is true of EVERY family in the app (no invented keys, distinct props, legal
 * values, no placement keys). The one thing it deliberately does NOT prove is
 * COMPLETENESS — "every preset in this family sets every knob in the family" —
 * because a sparse family is legal in general (its own header says so: shapeshifter's
 * cloud presets write three keys and never touch fill).
 *
 * But completeness is exactly what the SECOND family makes load-bearing here. The
 * Presets pane applies a card's `props` RAW, so a preset that omits a knob leaves
 * whatever the previous pick wrote — and with two families the user hovers back and
 * forth between them. If "Barely There" omitted scanDrift, hovering it after
 * "Failing Flyback" would leave a 1.5 line/sec roll under a preset whose whole
 * promise is that you cannot see it. So this file proves it PER FAMILY, which is the
 * form of the rule that a two-family widget needs.
 *
 * It also pins the thing the workstream is actually FOR, at the declaration level:
 * the two key sets are disjoint (the appearance family cannot touch motion and vice
 * versa) and the flicker family's OFF preset is the widget's default state, so
 * "Rock Steady" is a genuine no-op rather than a preset that merely looks like one.
 * The PIXEL versions of these claims are in tests/crt_flicker_probe.js.
 */

import assert from "node:assert/strict";
import { presetFamiliesOf } from "../core/registry.js";
import { crtPlugin } from "../plugins/demo/crt.js";
import { CRT_FILL_PARAMS, CRT_SKSL, CRT_FILL_SKSL, crtUniformParams, packCrtUniforms } from "../render_gpu/skia/crt_shader.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const FAMILIES = presetFamiliesOf(crtPlugin);
const byId = (id) => {
  const fam = FAMILIES.find((f) => f.id === id);
  assert.ok(fam, `demo_crt declares no preset family "${id}" (has: ${FAMILIES.map((f) => f.id).join(", ")})`);
  return fam;
};
const TUBE = byId("presets.tube");
const FLICKER = byId("presets.flicker");

/** The knobs the FLICKER family owns — read off the schema by category, NOT
 *  transcribed. A knob that joins the flicker category tomorrow is covered here with
 *  no edit, which is the whole point (a hand-written list would be the
 *  mirror defect preset_contract_test.js exists to kill). */
const FLICKER_KNOBS = CRT_FILL_PARAMS.filter((r) => r.category === "flicker").map((r) => r.name);

/** Pure function. The union of every key any preset in a family writes.
 *
 * @param {{presets: Array<{props: object}>}} family
 * @returns {Set<string>}
 *
 * @example keysOf({presets: [{props: {a: 1}}, {props: {b: 2}}]}) // Set {"a", "b"}
 */
function keysOf(family) {
  return new Set(family.presets.flatMap((p) => Object.keys(p.props ?? {})));
}

test("the widget declares exactly TWO preset families, tube and flicker", () => {
  assert.equal(FAMILIES.length, 2, `expected 2 families, got ${FAMILIES.map((f) => f.id).join(", ")}`);
  assert.equal(TUBE.title, "Tube presets");
  assert.equal(FLICKER.title, "Flicker presets");
});

test("the flicker category is a REAL knob group of four (amount, rate, drift, seed)", () => {
  assert.deepEqual([...FLICKER_KNOBS].sort(), ["flicker", "flickerRate", "flickerSeed", "scanDrift"]);
});

test("EVERY flicker preset writes EVERY flicker knob — no stale knob on hover", () => {
  for (const preset of FLICKER.presets) {
    const wrote = Object.keys(preset.props);
    for (const knob of FLICKER_KNOBS)
      assert.ok(wrote.includes(knob), `flicker preset "${preset.name}" omits "${knob}" — hovering it after another flicker preset would leave that knob's previous value`);
  }
});

test("the two families' key sets are DISJOINT — neither can clobber the other", () => {
  const tubeKeys = keysOf(TUBE), flickerKeys = keysOf(FLICKER);
  const overlap = [...tubeKeys].filter((k) => flickerKeys.has(k));
  assert.deepEqual(overlap, [], `both families write ${overlap.join(", ")}`);
  // And specifically: NO tube preset may write a flicker knob. This is the
  // regression that would undo the workstream — the eight tube presets all wrote
  // `flicker: 0` before this change, which is precisely what had to be removed.
  for (const preset of TUBE.presets)
    for (const knob of FLICKER_KNOBS)
      assert.ok(!(knob in preset.props), `tube preset "${preset.name}" writes "${knob}" — picking a tube would silently reset the user's flicker choice`);
});

test("a flicker preset writes NOTHING but flicker knobs", () => {
  for (const preset of FLICKER.presets)
    for (const key of Object.keys(preset.props))
      assert.ok(FLICKER_KNOBS.includes(key), `flicker preset "${preset.name}" writes "${key}", which is not a flicker knob — picking it would change the tube's look`);
});

test("the OFF preset IS the widget's default state (so it is a true no-op)", () => {
  const off = FLICKER.presets.find((p) => p.name === "Rock Steady");
  assert.ok(off, "the flicker family has no OFF preset");
  assert.equal(off.props.flicker, 0);
  assert.equal(off.props.scanDrift, 0);
  for (const knob of FLICKER_KNOBS)
    assert.equal(off.props[knob], crtPlugin.defaults[knob],
      `"Rock Steady" sets ${knob}=${off.props[knob]} but the widget defaults to ${crtPlugin.defaults[knob]} — the OFF preset must restore the default state exactly`);
});

test("the DEFAULT widget has flicker off — the option is opt-IN", () => {
  assert.equal(crtPlugin.defaults.flicker, 0, "a fresh CRT must not flicker until the user asks");
  assert.equal(crtPlugin.defaults.scanDrift, 0, "a fresh CRT's raster must be locked");
});

test("the presets span off → barely-there → gentle → notable, and stay SUBTLE", () => {
  const amounts = FLICKER.presets.map((p) => p.props.flicker);
  assert.equal(Math.min(...amounts), 0, "no OFF preset");
  // The user asked for "just a little bit of flicker". The RECOMMENDED band is the
  // presets other than the one explicitly named a fault; none of them may reach the
  // quarter-swing that reads as a strobe rather than a tube.
  const recommended = FLICKER.presets.filter((p) => !/flyback/i.test(p.name));
  for (const p of recommended)
    assert.ok(p.props.flicker <= 0.1, `"${p.name}" swings ${p.props.flicker} — a non-fault preset must stay subtle`);
  assert.ok(FLICKER.presets.length >= 4 && FLICKER.presets.length <= 6, `expected 4-6 flicker presets, got ${FLICKER.presets.length}`);
});

test("flicker knobs reach the SHADER: schema → uniform params → packed floats", () => {
  // The declaration is worthless if the value stops at the plugin. This walks the
  // real seam both the widget and the fill-material path use.
  const resolved = { ...crtPlugin.defaults, ...FLICKER.presets.find((p) => p.name === "Tired Tube").props };
  const u = crtUniformParams(resolved);
  assert.equal(u.flicker, 0.07);
  assert.equal(u.flickerRate, 6);
  assert.equal(u.scanDrift, 0.35);
  assert.equal(u.seed, 9001, "flickerSeed must arrive as the packer's `seed`");
  const packed = packCrtUniforms({ cx: 0, cy: 0, halfW: 100, halfH: 75, cornerRadius: 10, angle: 0, scale: 1, ...u });
  assert.equal(packed.length, 32, "the CRT uniform block is 32 floats (27 + the 5 temporal slots)");
  // the five temporal slots are LAST, in declaration order
  assert.deepEqual([...packed.slice(27)], [u.time, 9001, 0.07, 6, 0.35].map((v) => Math.fround(v)));
});

test("crtUniformParams reads the ONE seamed clock — Δt=0 gives the same params", () => {
  const resolved = { ...crtPlugin.defaults, ...FLICKER.presets.find((p) => p.name === "Mains Hum").props };
  setParticleTimeOverride(4.25);
  const a = crtUniformParams(resolved);
  const b = crtUniformParams(resolved);
  assert.equal(a.time, 4.25, "the injected time must be the override, not a wall clock");
  assert.deepEqual(a, b, "two reads at the same particle time produced different params");
  setParticleTimeOverride(9.5);
  const c = crtUniformParams(resolved);
  assert.equal(c.time, 9.5);
  setParticleTimeOverride(null);
  assert.notEqual(a.time, c.time, "advancing the clock must change the injected time");
});

/**
 * Pure function. Every ALL-CAPS SkSL identifier a shader program NAMES, minus the
 * ones it DECLARES — i.e. the constants it would fail to compile on.
 *
 * The two CRT variants are separate standalone SkSL programs with no shared scope,
 * so a constant used by one must be declared in that one. This caught a real bug the
 * moment it was written: the temporal stage was added to both `main` bodies, but its
 * five constants landed only in the base variant's preamble, so CRT_FILL_SKSL named
 * FLICKER_STEP_SHARE, HASH_MUL and three others it never declared. That does not
 * throw at import — it is a RUNTIME compile failure reachable only by painting a
 * CRT as a SHAPE'S FILL, which is why two unrelated suites went red instead of this
 * file. Cheap text check, no GPU, and it fails on the file rather than on a picture.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not incidental: these shaders are
 * heavily commented in SHOUTING PROSE ("the LIT SCREEN", "INPUT BAND-LIMIT"), so
 * scanning raw text reports fifty English words as undeclared identifiers. Only
 * CODE can name a constant.
 *
 * @param {string} sksl - a shader program's source
 * @returns {string[]} names used but not declared, sorted
 *
 * @example undeclaredConstants("const float A = 1.0;\nfloat f() { return A * B; }") // ["B"]
 * @example undeclaredConstants("const float A = 1.0;\nfloat f() { return A; }")     // []
 * @example undeclaredConstants("// the LIT SCREEN\nfloat f() { return 1.0; }")      // [] (prose is not code)
 */
function undeclaredConstants(sksl) {
  const code = sksl.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = new Set([...code.matchAll(/const\s+\w+\s+([A-Z][A-Z0-9_]*)\s*=/g)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]));
  return [...used].filter((n) => !declared.has(n)).sort();
}

test("BOTH shader variants declare every constant they use (separate programs)", () => {
  assert.deepEqual(undeclaredConstants(CRT_SKSL), [], "CRT_SKSL uses an undeclared constant");
  assert.deepEqual(undeclaredConstants(CRT_FILL_SKSL), [], "CRT_FILL_SKSL uses an undeclared constant — it is a SEPARATE program and needs its own declaration");
});

test("BOTH variants carry the temporal stage (a fill flickers like the widget)", () => {
  for (const [name, sksl] of [["CRT_SKSL", CRT_SKSL], ["CRT_FILL_SKSL", CRT_FILL_SKSL]]) {
    for (const u of ["uTime", "uFlicker", "uFlickerRate", "uScanDrift", "uSeed"])
      assert.ok(sksl.includes(`uniform float ${u};`), `${name} does not declare the uniform ${u}`);
    assert.ok(/flickerGain\(uTime, uFlicker, uFlickerRate, uSeed\)/.test(sksl), `${name} never CALLS flickerGain — the uniforms would be dead`);
    assert.ok(/uScanDrift \* uTime/.test(sksl), `${name} never applies the raster drift`);
  }
});

test("persistence stays OUT of the uniform params (still honestly inert)", () => {
  const u = crtUniformParams({ ...crtPlugin.defaults, persistence: 0.8 });
  assert.ok(!("persistence" in u), "persistence must not be packed — it has no shader uniform and is documented inert");
});

console.log(`\n${passed} CRT flicker tests passed`);
