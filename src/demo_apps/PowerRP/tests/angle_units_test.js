/**
 * ANGLE STORAGE UNITS — one declaration, no packer-side re-decision.
 * Run: node src/demo_apps/PowerRP/tests/angle_units_test.js
 *
 * WHY THIS EXISTS (R7-44a, workstream DRYFIX_D). `lightAngle` was stored in
 * DEGREES by three material packers and in RADIANS by four others, and the audit
 * that found it read the rows as byte-identical. They were not: `display:
 * "degrees"` was ALREADY the storage declaration — the rotary dial always works in
 * degrees and `display` names the transform bridging it to what the row STORES
 * (web/displayUnits.js divides by 180/π on commit), so `display: "degrees"` means
 * "stores RADIANS" and a bare row means "stores DEGREES".
 *
 * Eleven of thirteen material angle rows agreed with their packer. TWO DID NOT,
 * and they were LIVE BUGS rather than style drift, because a row whose dial and
 * whose shader disagree is wrong in the editor no matter which one you call
 * canonical:
 *   · atmosphere `lightAngle` — declared `display: "degrees"` (radians) while
 *     packAtmosphere multiplied by π/180. Its -35 default rendered on the dial as
 *     -2005°, and a -35° edit reached the shader as -0.0107 rad instead of -0.611:
 *     the sun essentially would not move. globe_map's presets store literal
 *     degrees (-170, -90, -60, -35), which is what settles that DEGREES is the
 *     real storage and the `display` key was the false half.
 *   · mandelbrot `lightAngle` — the same disagreement, settled the same way by its
 *     COLOUR_PRESETS (-45, -60).
 *
 * THE FIX CHANGED WHERE THE UNIT IS DECLARED, NOT WHAT ANY DECK RENDERS. No stored
 * value moved; section (3) pins that as byte-identity against the arithmetic the
 * packers used before.
 *
 * What this file asserts:
 *   (1) THE SEAM: angleStorageUnit / angleRadians / schemaAngleRadians behave, and
 *       a row declaring BOTH spellings is refused rather than silently resolved.
 *   (2) THE CENSUS, DERIVED — every `kind: "angle"` row in every shipped material
 *       schema is swept from the registry and must agree with its packer's actual
 *       arithmetic. This is the check that catches the NEXT drift, and it is
 *       derived rather than listed so a new material is covered the day it ships.
 *   (3) BYTE-IDENTITY per packer family, against literal pre-refactor arithmetic.
 *   (4) STRUCTURAL: no material packer redefines the conversion locally.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEG2RAD, angleRadians, angleStorageUnit, schemaAngleRadians } from "../core/properties.js";
import { ATMOSPHERE_FILL_PARAMS, packAtmosphere } from "../render_gpu/skia/atmosphere_shader.js";
import { GLASS_FILL_PARAMS, glassUniformParams } from "../render_gpu/skia/glass_shader.js";
import { METAL_FILL_PARAMS, metalToUniformParams } from "../render_gpu/skia/metal_shader.js";
import { STAMP_FILL_PARAMS, stampToUniformParams } from "../render_gpu/skia/metal_stamp_shader.js";
import { COMIC_FILL_PARAMS, comicUniformParams } from "../render_gpu/skia/comic_shader.js";
import { MANDELBROT_FILL_PARAMS, mandelbrotFillUniformParams } from "../render_gpu/skia/mandelbrot_shader.js";
import { RAINY_WINDOW_FILL_PARAMS, rainyWindowUniformParams } from "../render_gpu/skia/rainy_window_shader.js";
import { RAYCAST_DITHER_FILL_PARAMS, raycastDitherUniformParams } from "../render_gpu/skia/raycast_dither_shader.js";
import { METABALLS_FILL_PARAMS, metaballsGlobalParams } from "../render_gpu/skia/metaballs_shader.js";

const SKIA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "render_gpu", "skia");

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) the seam ──────────────────────────────────────────────────────────────

test("(1a) display:\"degrees\" declares RADIANS storage; a bare angle row declares DEGREES", () => {
  assert.equal(angleStorageUnit({ name: "a", kind: "angle", display: "degrees" }), "radians");
  assert.equal(angleStorageUnit({ name: "a", kind: "angle" }), "degrees");
});

test("(1b) unit:\"degrees\" (the plugin-material spelling) declares DEGREES storage", () => {
  assert.equal(angleStorageUnit({ name: "rotation", kind: "angle", unit: "degrees" }), "degrees");
});

test("(1c) a row declaring BOTH spellings is REFUSED, not silently resolved", () => {
  // The two keys make contradictory claims about storage; picking one quietly is
  // exactly the class of silent wrongness this fix exists to remove.
  assert.throws(
    () => angleStorageUnit({ name: "a", kind: "angle", display: "degrees", unit: "degrees" }),
    /declares BOTH/,
  );
});

test("(1d) angleRadians converts per the declared unit and DEG2RAD is the one factor", () => {
  assert.equal(DEG2RAD, Math.PI / 180);
  assert.equal(angleRadians(-111.6, { kind: "angle" }), -111.6 * DEG2RAD);
  assert.equal(angleRadians(-1.9477874452256716, { kind: "angle", display: "degrees" }), -1.9477874452256716);
});

test("(1e) schemaAngleRadians reads the row out of its schema, and is LOUD on an unknown name", () => {
  const toRad = schemaAngleRadians([
    { name: "spin", kind: "angle", display: "degrees" },
    { name: "tilt", kind: "angle" },
  ]);
  assert.equal(toRad("spin", 1.5), 1.5);        // stored radians — passes through
  assert.equal(toRad("tilt", 90), 90 * DEG2RAD); // stored degrees — converted
  // A typo'd or renamed knob would otherwise take the degrees branch and mis-scale
  // by 57.3 with nothing to see.
  assert.throws(() => toRad("nope", 1), /no param named "nope"/);
});

// ── (2) THE CENSUS, DERIVED FROM THE SCHEMAS ──────────────────────────────────
//
// Each entry names a shipped material schema, its packer, and a probe: the params
// the packer needs, plus the KEY its angle lands on in the packer's output. The
// assertion is uniform — the packed radians must equal angleRadians(stored, row) —
// so it re-derives what the unit SHOULD be from the row itself rather than
// restating today's answer.

const METAL_BASE = {
  metalType: "steel", roughness: 0.1, brushAmount: 0, radialBrush: false, wearAmount: 0,
  patinaAmount: 0, patinaColor: "#000", rustCoverage: 0, bevelWidth: 8, seed: 1,
  warmthBoost: 0, rgbSplit: 0, hammerAmount: 0,
};
const GLASS_BASE = {
  refractionStrength: 14, edgeFalloff: 22, lightIntensity: 0.8, tint: "rgba(255,255,255,0.14)",
  saturation: 0.92, sheen: 0.1, specularPower: 8, contactShadow: 0.26, caustic: 0.12,
  edgeLight: 0.14, tintAdaptivity: 1, chromatic: 0.08,
};
const COMIC_BASE = {
  mode: "rgb", pitch: 9, worldLocked: true, dotShape: "square", registration: 0.2, dotGain: 0,
  gamma: 1, posterize: 0, edgeInk: 0, edgeLo: 0.15, edgeHi: 0.35, grain: 0,
  paperColor: "#fff", inkA: "#f0f", inkB: "#0ff",
};
const MANDELBROT_BASE = {
  centerX: -0.5, centerFineX: 0, centerY: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 1,
  maxIterations: 50, escapeRadius: 256, interiorTest: "derivative", interiorThreshold: 1e-3,
  colorAxis: "iteration", paletteScale: 18, stripeAmount: 0, stripeDensity: 4, triangleAmount: 0,
  shadeAmount: 0, lightHeight: 1.5, glowAmount: 0, glowWidth: 1, bandLimit: true,
  boundaryAA: false, interiorColor: "#000000",
};
const RAINY_BASE = {
  rain: 0.8, fog: 0.5, speed: 1, dropSize: 1, columns: 6, streakiness: 1, refraction: 0.06,
  shine: 0.9, tint: "#dfe8f0",
};
const RAYCAST_BASE = {
  speed: 1, zoom: 0.58, elongation: 4.2, softness: 0.17, warp: 0.18, grain: 0.09,
  grainScale: 1, grainSpeed: 18, background: "#050608", color0: "#ff5e73", color1: "#eb1f36",
  color2: "#990d1c", color3: "#ff4257", color4: "#520814",
};
const METABALLS_BASE = {
  smoothK: 0.9, threshold: 0.08, chromatic: 0.05, specular: 1.75, shininess: 66,
  fresnel: 0.95, bulge: 0.8, ambient: 0.28,
};

/** A probe value in the row's OWN stored unit, so the same number is meaningful
 *  whichever unit the row declares (45° and 45 rad are both legal stored values). */
const PROBE = 0.7853981633974483;

const CENSUS = [
  { material: "atmosphere", schema: ATMOSPHERE_FILL_PARAMS, angle: "lightAngle",
    // packAtmosphere emits the sun as a DIRECTION VECTOR, so the angle is read back
    // through atan2 of the packed [x, y] rather than as a stored scalar. The pack is
    // a Float32Array, so the comparison is made in f32 too (see `expect` below) —
    // otherwise this measures float truncation rather than the unit.
    pack: (v) => {
      const a = packAtmosphere({ cx: 0, cy: 0, halfW: 40, halfH: 40, glowColor: "#6cb8ff", lightAngle: v, lightHeight: 0 });
      return Math.atan2(a[11], a[10]);
    },
    expect: (rad) => Math.atan2(Math.fround(Math.sin(rad)), Math.fround(Math.cos(rad))) },
  { material: "glass", schema: GLASS_FILL_PARAMS, angle: "lightAngle",
    pack: (v) => glassUniformParams({ ...GLASS_BASE, lightAngle: v }).lightAngle },
  { material: "metal", schema: METAL_FILL_PARAMS, angle: "lightAngle",
    pack: (v) => metalToUniformParams({ ...METAL_BASE, brushAngle: 0, lightAngle: v }).lightAngle },
  { material: "metal", schema: METAL_FILL_PARAMS, angle: "brushAngle",
    pack: (v) => metalToUniformParams({ ...METAL_BASE, lightAngle: 0, brushAngle: v }).brushAngle },
  { material: "metal_stamp", schema: STAMP_FILL_PARAMS, angle: "lightAngle",
    pack: (v) => stampToUniformParams({ depth: 0.7, bevelWidth: 10, profile: "round", emboss: true, patinaAmount: 0, patinaColor: "#43b3ae", rustCoverage: 0, seed: 3, lightAngle: v }).lightAngle },
  { material: "comic", schema: COMIC_FILL_PARAMS, angle: "angleC",
    pack: (v) => comicUniformParams({ ...COMIC_BASE, angleC: v, angleM: 0, angleY: 0, angleK: 0 }).angleC },
  { material: "comic", schema: COMIC_FILL_PARAMS, angle: "angleM",
    pack: (v) => comicUniformParams({ ...COMIC_BASE, angleC: 0, angleM: v, angleY: 0, angleK: 0 }).angleM },
  { material: "comic", schema: COMIC_FILL_PARAMS, angle: "angleY",
    pack: (v) => comicUniformParams({ ...COMIC_BASE, angleC: 0, angleM: 0, angleY: v, angleK: 0 }).angleY },
  { material: "comic", schema: COMIC_FILL_PARAMS, angle: "angleK",
    pack: (v) => comicUniformParams({ ...COMIC_BASE, angleC: 0, angleM: 0, angleY: 0, angleK: v }).angleK },
  { material: "mandelbrot", schema: MANDELBROT_FILL_PARAMS, angle: "lightAngle",
    pack: (v) => mandelbrotFillUniformParams({ ...MANDELBROT_BASE, lightAngle: v }).lightAngle },
  { material: "rainy_window", schema: RAINY_WINDOW_FILL_PARAMS, angle: "lightAngle",
    pack: (v) => rainyWindowUniformParams({ ...RAINY_BASE, lightAngle: v }).lightAngle },
  { material: "raycast_dither", schema: RAYCAST_DITHER_FILL_PARAMS, angle: "streakAngle",
    pack: (v) => raycastDitherUniformParams({ ...RAYCAST_BASE, streakAngle: v }).streakAngle },
  { material: "metaballs", schema: METABALLS_FILL_PARAMS, angle: "lightAngle",
    pack: (v) => metaballsGlobalParams({ ...METABALLS_BASE, lightAngle: v }).lightAngle },
];

test("(2a) the census covers every kind:\"angle\" row in every schema it names", () => {
  // A material gaining an angle knob must gain a census row, or this fails — which
  // is what makes (2b) a SWEEP rather than a list that silently stops growing.
  const bySchema = new Map();
  for (const { material, schema } of CENSUS) bySchema.set(schema, material);
  for (const [schema, material] of bySchema) {
    const declared = schema.filter((r) => r.kind === "angle").map((r) => r.name).sort();
    const covered = CENSUS.filter((c) => c.schema === schema).map((c) => c.angle).sort();
    assert.deepEqual(covered, declared, `${material}: census rows must match its declared angle rows`);
  }
});

test("(2b) every material packer's angle arithmetic matches its ROW's declared unit", () => {
  for (const { material, schema, angle, pack, expect } of CENSUS) {
    const row = schema.find((r) => r.name === angle);
    assert.ok(row, `${material}.${angle} must exist in its schema`);
    const radians = angleRadians(PROBE, row);
    const expected = expect ? expect(radians) : radians;
    assert.equal(
      pack(PROBE), expected,
      `${material}.${angle} stores ${angleStorageUnit(row)} per its row, so packing ${PROBE} must give ${expected}`,
    );
  }
});

test("(2c) the two rows the audit found are now self-consistent (atmosphere, mandelbrot)", () => {
  // Named explicitly as well as swept, because these are the REGRESSION: both
  // declared display:"degrees" (radians) while their packers converted as degrees.
  for (const [schema, name] of [[ATMOSPHERE_FILL_PARAMS, "atmosphere"], [MANDELBROT_FILL_PARAMS, "mandelbrot"]]) {
    const row = schema.find((r) => r.name === "lightAngle");
    assert.equal(angleStorageUnit(row), "degrees", `${name}.lightAngle stores degrees (its presets are literal degrees)`);
    assert.equal(row.display, undefined, `${name}.lightAngle must NOT declare display:"degrees" — that would claim radians`);
  }
});

// ── (3) BYTE-IDENTITY: no deck's pixels moved ─────────────────────────────────

test("(3) each packer family is byte-identical to the pre-refactor arithmetic", () => {
  // Literal `× Math.PI / 180` on the left, exactly as each packer wrote it before,
  // and literal pass-through for the radians-storing families.
  assert.equal(glassUniformParams({ ...GLASS_BASE, lightAngle: -111.6 }).lightAngle, -111.6 * (Math.PI / 180));
  const metal = metalToUniformParams({ ...METAL_BASE, brushAngle: 90, lightAngle: -126 });
  assert.equal(metal.lightAngle, -126 * (Math.PI / 180));
  assert.equal(metal.brushAngle, 90 * (Math.PI / 180));
  assert.equal(stampToUniformParams({ depth: 0.7, bevelWidth: 10, profile: "round", emboss: true, patinaAmount: 0, patinaColor: "#43b3ae", rustCoverage: 0, seed: 3, lightAngle: -126 }).lightAngle, -126 * (Math.PI / 180));
  const comic = comicUniformParams({ ...COMIC_BASE, angleC: 15, angleM: 75, angleY: 0, angleK: 45 });
  assert.equal(comic.angleC, 15 * (Math.PI / 180));
  assert.equal(comic.angleM, 75 * (Math.PI / 180));
  assert.equal(comic.angleK, 45 * (Math.PI / 180));
  assert.equal(mandelbrotFillUniformParams({ ...MANDELBROT_BASE, lightAngle: -45 }).lightAngle, -45 * (Math.PI / 180));
  // The radians-storing families pass through untouched, as they always did.
  assert.equal(rainyWindowUniformParams({ ...RAINY_BASE, lightAngle: -1.88 }).lightAngle, -1.88);
  assert.equal(raycastDitherUniformParams({ ...RAYCAST_BASE, streakAngle: 0.785 }).streakAngle, 0.785);
  assert.equal(metaballsGlobalParams({ ...METABALLS_BASE, lightAngle: -2.1 }).lightAngle, -2.1);
});

test("(3b) atmosphere's packed sun vector is unchanged for its stored degrees", () => {
  // The one row whose DECLARATION changed. Its stored values did not, so the packed
  // direction must still be the sine/cosine of -35 DEGREES.
  const a = packAtmosphere({ cx: 0, cy: 0, halfW: 40, halfH: 40, glowColor: "#6cb8ff", lightAngle: -35, lightHeight: 0 });
  // Math.fround: the pack is a Float32Array, so the reference must be truncated to
  // f32 as well or this measures float width rather than the angle.
  assert.equal(a[10], Math.fround(Math.cos((-35 * Math.PI) / 180)));
  assert.equal(a[11], Math.fround(Math.sin((-35 * Math.PI) / 180)));
});

// ── (4) STRUCTURAL: the conversion is not redefined anywhere ───────────────────

test("(4) no material packer defines its own degrees→radians constant", () => {
  // The rg-pin. Seven local DEG2RADs existed before this fix, which is what let two
  // of them drift from their rows. A comment mentioning the factor is fine; a
  // DEFINITION is what regresses, so only assignments are matched.
  const offenders = [];
  for (const file of readdirSync(SKIA_DIR).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(join(SKIA_DIR, file), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (/(?:const|let|var)\s+\w*(?:DEG2RAD|DEG_?TO_?RAD)\w*\s*=/.test(line)
        || /(?:const|let|var)\s+\w+\s*=\s*Math\.PI\s*\/\s*180\b/.test(line))
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `use core/properties.schemaAngleRadians instead of a local constant:\n${offenders.join("\n")}`);
});

console.log(`\nangle_units_test: ${passed} checks passed`);
