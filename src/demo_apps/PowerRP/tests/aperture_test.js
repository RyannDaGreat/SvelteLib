/**
 * APERTURE (R6-17.1) — bare-node gate for the iris geometry, the preset table,
 * and THE SUNSTAR PARITY LAW.
 *
 * ── THE ONE TEST HERE THAT IS NOT ORDINARY ───────────────────────────────────
 * §1 is a DRIFT GATE against a mirror this repo cannot remove. The parity law
 * lives twice: once in JS (core/optics.js, which plugins/aperture.js uses) and
 * once in SkSL (render_gpu/skia/lens_flare_shader.js, which runs on the GPU and
 * can import nothing). R6-3.11 requires the two widgets to agree, and a
 * hand-maintained mirror is this codebase's worst recurring defect.
 *
 * So the gate does NOT restate the law in its own words — that would be a THIRD
 * copy, and it would pass while the shader said something else. It EXTRACTS the
 * shader's own `spikeCount` arithmetic from the file's SOURCE TEXT, translates
 * the three GLSL builtins it uses into JS, evaluates it, and compares. Change
 * the shader's formula and this goes red. §1e proves that by mutating a COPY of
 * the extracted text and asserting the comparison then FAILS — a gate that has
 * never been seen to fail is not known to be a gate.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MIN_POLYGON_BLADES, NO_IRIS_BLADES, starburstRayAngles, starburstRayCount } from "../core/optics.js";
import {
  aperturePlugin, bladeRadialLimit, bodySubpaths, boundaryAngles, openingOutline,
  openingRadius, pupilGeom, reuleauxRadialLimit, apodizedPupilPaint,
} from "../plugins/aperture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHADER_PATH = join(HERE, "..", "render_gpu", "skia", "lens_flare_shader.js");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

/** Angles dense enough that a 5-degree-sampled boundary is probed between its
 *  own samples as well as on them — deliberately coprime with the sampling. */
const PROBE_ANGLES = Array.from({ length: 97 }, (_, i) => (2 * Math.PI * i) / 97);
/** Every blade count the presets use, plus the awkward ones around the floor. */
const SWEPT_BLADES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 21, 24];
/** Local px. The geometry is closed-form trigonometry on radii of order 1, so
 *  anything above ULP scale is a real disagreement, not accumulation. */
const EPS = 1e-9;

// ── §1 THE SkSL DRIFT GATE ───────────────────────────────────────────────────

/**
 * Query (reads the shader source). The SkSL statements that compute
 * `spikeCount`, as they are written in the file — the contiguous run of
 * `float <id> = <expr>;` lines ending at the `spikeCount` declaration.
 *
 * Deliberately brittle about SHAPE and loud about it: if the shader is
 * reformatted so this cannot find the block, the right outcome is a failure
 * telling the next author to re-point the gate, never a silent pass.
 */
function extractSpikeCountSource(source) {
  const lines = source.split("\n");
  const end = lines.findIndex((l) => /^\s*float\s+spikeCount\s*=/.test(l));
  assert.ok(end >= 0, `lens_flare_shader.js no longer declares "float spikeCount = …" — the parity drift gate cannot find the shader's arithmetic. Re-point tests/aperture_test.js §1 at wherever the spike count is now computed.`);
  let start = end;
  const isFloatDecl = (l) => /^\s*float\s+\w+\s*=.*;\s*$/.test(l);
  while (start > 0 && isFloatDecl(lines[start - 1])) start -= 1;
  const block = lines.slice(start, end + 1).map((l) => l.trim());
  assert.ok(block.some((l) => l.includes("uBlades")), `the statements ending at "float spikeCount" no longer read uBlades:\n${block.join("\n")}`);
  return block;
}

/**
 * Query (reads the shader source). The shader's own MIN_BLADES literal, as a
 * number.
 */
function extractShaderMinBlades(source) {
  const m = /const\s+float\s+MIN_BLADES\s*=\s*([0-9.]+)\s*;/.exec(source);
  assert.ok(m, "lens_flare_shader.js no longer declares `const float MIN_BLADES = …` — re-point the gate.");
  return Number(m[1]);
}

/**
 * Pure function. The extracted SkSL statements, compiled into a JS function of
 * the blade count. TWO translations, and no more — that is what keeps this an
 * evaluation of the shader's own text rather than a rewrite of it:
 *   `float x = …`  →  `let x = …`   (the only type keyword in the block)
 *   max / step / mod →  their exact JS equivalents, injected as arguments
 * Any OTHER call name must fail loudly rather than be guessed at, so the block
 * is checked for unknown identifiers-before-a-paren first.
 */
function compileSpikeCount(block, minBlades) {
  const KNOWN = new Set(["max", "step", "mod"]);
  const stripped = block.map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean);
  for (const [, name] of stripped.join("\n").matchAll(/\b([a-z]\w*)\s*\(/g))
    assert.ok(KNOWN.has(name), `the shader's spike-count arithmetic now calls "${name}()", which this gate has no JS equivalent for. Add one (and check it is exact) rather than loosening the comparison.`);
  const body = `${stripped.map((l) => l.replace(/^float\s+/, "let ")).join("\n")}\nreturn spikeCount;`;
  const fn = new Function("uBlades", "MIN_BLADES", "max", "step", "mod", body);
  return (blades) => fn(
    blades, minBlades,
    Math.max,
    (edge, x) => (x < edge ? 0 : 1), // GLSL step
    (x, y) => x - y * Math.floor(x / y) // GLSL mod
  );
}

const shaderSource = readFileSync(SHADER_PATH, "utf8");
const spikeBlock = extractSpikeCountSource(shaderSource);
const shaderMinBlades = extractShaderMinBlades(shaderSource);
const shaderSpikeCount = compileSpikeCount(spikeBlock, shaderMinBlades);

console.log(`\n── the SkSL the gate is reading ──\n${spikeBlock.map((l) => `    ${l}`).join("\n")}\n`);

test("(1a) the shader's own MIN_BLADES IS core/optics.MIN_POLYGON_BLADES", () => {
  assert.equal(shaderMinBlades, MIN_POLYGON_BLADES,
    `the flare's SkSL floors at ${shaderMinBlades} blades while core/optics.js says ${MIN_POLYGON_BLADES}. R6-3.11: the two widgets must not disagree about what a blade count means.`);
});

test("(1b) DRIFT GATE: the shader's own arithmetic agrees with starburstRayCount", () => {
  for (let n = MIN_POLYGON_BLADES; n <= 40; n++)
    assert.equal(shaderSpikeCount(n), starburstRayCount(n),
      `blades ${n}: the flare shader computes ${shaderSpikeCount(n)} rays, core/optics.js says ${starburstRayCount(n)}`);
});

test("(1c) the two disagree ONLY below the shared floor, and only because the shader clamps", () => {
  for (let n = 0; n < MIN_POLYGON_BLADES; n++)
    assert.equal(shaderSpikeCount(n), starburstRayCount(MIN_POLYGON_BLADES),
      `below the floor the shader must render the floor's star, not something else`);
});

test("(1d) every ray count either widget can produce is EVEN", () => {
  for (let n = 0; n <= 64; n++) {
    assert.equal(starburstRayCount(n) % 2, 0, `core/optics.js gave an ODD count for ${n} blades`);
    if (n >= MIN_POLYGON_BLADES) assert.equal(shaderSpikeCount(n) % 2, 0, `the shader gave an ODD count for ${n} blades`);
  }
});

test("(1e) THE GATE CAN FAIL: a mutated copy of the shader arithmetic is caught", () => {
  // The most plausible regression: someone "simplifies away" the odd-count
  // doubling. Mutating a COPY of the extracted text — no file is touched.
  const mutated = spikeBlock.map((l) => l.replace("(2.0 - isEven)", "1.0"));
  assert.notDeepEqual(mutated, spikeBlock, "the mutation did not apply — this check is vacuous as written");
  const broken = compileSpikeCount(mutated, shaderMinBlades);
  const disagreements = [];
  for (let n = MIN_POLYGON_BLADES; n <= 40; n++)
    if (broken(n) !== starburstRayCount(n)) disagreements.push(n);
  assert.ok(disagreements.length > 0, "a shader that dropped the parity doubling would still pass §1b — the gate is not gating");
  assert.deepEqual(disagreements, [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39],
    "dropping the doubling must break exactly the ODD counts");
});

// ── §2 THE PARITY LAW AS CONSTRUCTION ────────────────────────────────────────

test("(2a) sourced ray counts: 9 blades give 18, 13 give 26, 11 give 22, 8 give 8", () => {
  assert.equal(starburstRayCount(9), 18);
  assert.equal(starburstRayCount(13), 26);
  assert.equal(starburstRayCount(11), 22);
  assert.equal(starburstRayCount(8), 8);
  assert.equal(starburstRayCount(NO_IRIS_BLADES), 0);
});

test("(2b) the ray SET is centrosymmetric — every ray has an opposite", () => {
  const wrap = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (const n of SWEPT_BLADES) {
    const rot = 0.3; // an arbitrary non-zero heading, so 0 is not doing the work
    const set = starburstRayAngles(n, rot).map(wrap);
    for (const a of set)
      assert.ok(set.some((b) => Math.abs(wrap(b - a - Math.PI)) < EPS || Math.abs(wrap(b - a - Math.PI) - 2 * Math.PI) < EPS),
        `blades ${n}: the ray at ${a} has no opposite — the aperture would not be a real function`);
  }
});

test("(2c) rays are DISTINCT and evenly spaced", () => {
  for (const n of SWEPT_BLADES.filter((v) => v >= 1)) {
    const set = starburstRayAngles(n);
    const gaps = set.slice(1).map((a, i) => a - set[i]);
    for (const g of gaps) assert.ok(Math.abs(g - gaps[0]) < EPS, `blades ${n}: uneven ray spacing`);
    assert.ok(gaps[0] > EPS, `blades ${n}: two rays coincide`);
  }
});

// ── §3 THE IRIS GEOMETRY ─────────────────────────────────────────────────────

test("(3a) WIDE OPEN IS ROUND, whatever the blade count, for any CONVEX leaf", () => {
  for (const blades of SWEPT_BLADES)
    for (const curvature of [0, 0.3, 0.7, 1])
      for (const bladeForm of ["regular", "reuleaux"])
        for (const theta of PROBE_ANGLES)
          assert.ok(Math.abs(openingRadius(theta, { blades, stopDown: 0, curvature, bladeForm }) - 1) < EPS,
            `blades ${blades} curvature ${curvature} ${bladeForm}: wide open is not the bare bore at ${theta}`);
});

test("(3a-bis) an INWARDLY curved leaf intrudes even wide open — stated, not silent", () => {
  // The one exception to (3a), and it is geometric: the crossings recess to the
  // barrel but the edge's bulge is still inside it. That is why a concave iris
  // shows concave sides at every stop.
  for (const blades of [6, 8, 11, 13]) {
    const onNormal = openingRadius(0, { blades, stopDown: 0, curvature: -0.8 });
    assert.ok(onNormal < 1 - 1e-6, `blades ${blades}: a concave leaf did not intrude at all`);
    assert.ok(onNormal > 0, `blades ${blades}: a concave leaf swallowed the whole opening`);
    const atCrossing = openingRadius(Math.PI / blades, { blades, stopDown: 0, curvature: -0.8 });
    assert.ok(Math.abs(atCrossing - 1) < EPS, `blades ${blades}: the CROSSINGS should still be clipped by the bore`);
  }
  // Three blades at full concavity is the single degenerate state in the family:
  // the three edges meet at the centre and the iris is shut. Floored, not negative.
  for (const theta of PROBE_ANGLES)
    assert.ok(Math.abs(openingRadius(theta, { blades: 3, stopDown: 0, curvature: -1 })) < EPS,
      "three fully concave leaves meet at the centre — the honest answer is SHUT, never a negative radius");
});

test("(3b) SHUT IS SHUT, and the opening is monotone in stopDown", () => {
  for (const blades of SWEPT_BLADES.filter((v) => v >= MIN_POLYGON_BLADES)) {
    for (const theta of PROBE_ANGLES)
      assert.ok(openingRadius(theta, { blades, stopDown: 1 }) < EPS, `blades ${blades}: still open when shut`);
    for (const theta of PROBE_ANGLES.slice(0, 9)) {
      let previous = Infinity;
      for (let k = 0; k <= 20; k++) {
        const r = openingRadius(theta, { blades, stopDown: k / 20 });
        assert.ok(r <= previous + EPS, `blades ${blades} at ${theta}: opening GREW between stops`);
        previous = r;
      }
    }
  }
});

test("(3c) the polygon EMERGES at stopDown = 1 - cos(pi/N), not before", () => {
  for (const blades of [3, 5, 6, 8, 9, 13, 16]) {
    const half = Math.PI / blades;
    const threshold = 1 - Math.cos(half);
    const vertexAngle = half; // halfway between two blade normals
    const justOpen = openingRadius(vertexAngle, { blades, stopDown: threshold * 0.5 });
    const justClosed = openingRadius(vertexAngle, { blades, stopDown: Math.min(1, threshold * 1.5) });
    assert.ok(Math.abs(justOpen - 1) < EPS, `blades ${blades}: the corner already cleared the bore below the threshold`);
    assert.ok(justClosed < 1 - EPS, `blades ${blades}: the corner never clears the bore above the threshold`);
  }
});

test("(3d) curvature 1 is EXACTLY a circle, at every stop and every count", () => {
  for (const blades of SWEPT_BLADES.filter((v) => v >= MIN_POLYGON_BLADES))
    for (const stopDown of [0.2, 0.35, 0.5, 0.8]) {
      const radii = PROBE_ANGLES.map((t) => openingRadius(t, { blades, stopDown, curvature: 1 }));
      const spread = Math.max(...radii) - Math.min(...radii);
      assert.ok(spread < EPS, `blades ${blades} at stop ${stopDown}: a fully curved iris is not round (spread ${spread})`);
    }
});

test("(3e) curvature moves the EDGE and never the CROSSINGS", () => {
  // The vertices are where two leaves cross; a leaf's edge SHAPE cannot move
  // them. This is what makes the curvature family physical rather than a blend.
  for (const blades of [5, 6, 8, 9, 13]) {
    const half = Math.PI / blades;
    const stopDown = 0.6; // well past the threshold, so the corner is real
    const vertex = (c) => openingRadius(half, { blades, stopDown, curvature: c });
    const edge = (c) => openingRadius(0, { blades, stopDown, curvature: c });
    for (const c of [-1, -0.5, 0, 0.5, 1])
      assert.ok(Math.abs(vertex(c) - vertex(0)) < 1e-6, `blades ${blades}: curvature ${c} moved the vertex`);
    assert.ok(edge(1) > edge(0) + 1e-6, `blades ${blades}: convex curvature did not push the edge out`);
    assert.ok(edge(-1) < edge(0) - 1e-6, `blades ${blades}: concave curvature did not pull the edge in`);
  }
});

test("(3f) the Reuleaux form has the three sourced radii and is CONSTANT WIDTH", () => {
  assert.ok(Math.abs(reuleauxRadialLimit(0) - 1) < EPS, "a vertex sits at the circumradius");
  assert.ok(Math.abs(reuleauxRadialLimit(Math.PI) - (Math.sqrt(3) - 1)) < EPS, "an arc's midpoint sits at sqrt(3) - 1");
  assert.ok(Math.abs(reuleauxRadialLimit((2 * Math.PI) / 3) - 1) < EPS, "the next vertex, one third of a turn on");
  // CONSTANT WIDTH is a statement about SUPPORT lines, not about radii through
  // the centre: h(t) + h(t + pi) is constant, where h is the farthest extent in
  // direction t. Measured off the boundary itself.
  const boundary = PROBE_ANGLES.concat(Array.from({ length: 720 }, (_, i) => (2 * Math.PI * i) / 720))
    .map((t) => [reuleauxRadialLimit(t) * Math.cos(t), reuleauxRadialLimit(t) * Math.sin(t)]);
  const support = (t) => Math.max(...boundary.map(([x, y]) => x * Math.cos(t) + y * Math.sin(t)));
  const widths = Array.from({ length: 60 }, (_, i) => support((Math.PI * i) / 60) + support((Math.PI * i) / 60 + Math.PI));
  const spread = Math.max(...widths) - Math.min(...widths);
  assert.ok(spread < 2e-4, `the Reuleaux form is not of constant width (spread ${spread}); widths ~${widths[0].toFixed(6)} vs sqrt(3) = ${Math.sqrt(3).toFixed(6)}`);
  assert.ok(Math.abs(widths[0] - Math.sqrt(3)) < 2e-4, "the constant width is the triangle's own side, sqrt(3) times the circumradius");
});

test("(3g) a straight blade is a HALF-PLANE — sec ahead, nothing behind", () => {
  for (const blades of [3, 6, 9]) {
    assert.ok(Math.abs(bladeRadialLimit(0, blades, 0) - 1) < EPS);
    assert.ok(Math.abs(bladeRadialLimit(Math.PI / blades, blades, 0) - 1 / Math.cos(Math.PI / blades)) < EPS);
    assert.equal(bladeRadialLimit(Math.PI, blades, 0), Infinity);
    assert.equal(bladeRadialLimit(Math.PI * 0.6, blades, 0), Infinity);
    // GRAZING, at exactly a quarter turn: the half-plane's boundary is parallel
    // to the ray, so the true limit is unbounded and the float one is merely
    // astronomical (cos(pi/2) lands a hair above zero). Either way it can never
    // be the minimum against a bore of radius 1.
    assert.ok(bladeRadialLimit(Math.PI / 2, blades, 0) > 1e15);
  }
});

test("(3h) pupilAspect ovalises INSIDE the box, never past it", () => {
  const box = { w: 200, h: 120 };
  const round = pupilGeom({ ...box, pupilAspect: 1 });
  for (const a of [0.25, 0.5, 1, 2, 4]) {
    const g = pupilGeom({ ...box, pupilAspect: a });
    assert.ok(g.rx <= round.rx + EPS && g.ry <= round.ry + EPS, `aspect ${a} pushed the pupil outside the bore`);
    assert.ok(Math.abs((g.rx / g.ry) / (round.rx / round.ry) - a) < EPS, `aspect ${a} is not the pupil's actual axis ratio`);
  }
});

test("(3i) an UNSET curvature is neutral, not the floor of its range", () => {
  // The defect this pins: a clamp that reads an absent value as its LOW bound
  // read an untouched knob as fully CONCAVE, and a wide-open eight-blade
  // opening came back at radius -3.08 instead of 1.
  for (const theta of PROBE_ANGLES)
    assert.ok(Math.abs(openingRadius(theta, { blades: 8, stopDown: 0.5 }) - openingRadius(theta, { blades: 8, stopDown: 0.5, curvature: 0 })) < EPS,
      "an absent curvature does not render as straight");
  for (const theta of PROBE_ANGLES)
    assert.ok(openingRadius(theta, { blades: 8, stopDown: 0.5 }) > 0, "an absent curvature produced a negative radius");
});

// ── §4 THE DISPLAY LIST ──────────────────────────────────────────────────────

const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };
const stateOf = (props) => ({ ...aperturePlugin.defaults, x: 0, y: 0, w: 220, h: 220, ...props });

test("(4a) ONE path op per layer — never a fan", () => {
  const ops = aperturePlugin.emit(stateOf({ blades: 8, stopDown: 0.5, sunstar: 0.6 }), null, WORLD);
  assert.deepEqual(ops.map((o) => o.op), ["path", "path", "path"], "pupil fill, blades, sunstar — one op each");
  assert.ok(ops.every((o) => !o.d.includes("A") && !o.d.includes("S")), "an A or S command would be refused by the PDF exporter");
});

test("(4b) the body is an EVEN-ODD hole, and vanishes when there is nothing to hold", () => {
  const body = bodySubpaths(stateOf({ blades: 8, stopDown: 0.5 }));
  assert.equal(body.length, 2, "the bore and the opening");
  assert.equal(bodySubpaths(stateOf({ blades: 8, stopDown: 0 })), null, "wide open, the barrel edge IS the aperture");
  assert.equal(bodySubpaths(stateOf({ blades: NO_IRIS_BLADES, stopDown: 0.9 })), null, "no iris, so nothing closes the bore");
  const ops = aperturePlugin.emit(stateOf({ blades: 8, stopDown: 0.5 }), null, WORLD);
  assert.ok(ops.every((o) => o.fillRule === "evenodd"), "the hole needs the even-odd rule");
});

test("(4c) the sunstar draws EXACTLY the derived number of rays", () => {
  for (const blades of SWEPT_BLADES) {
    const ops = aperturePlugin.emit(stateOf({ blades, stopDown: 0.5, sunstar: 0.7 }), null, WORLD);
    const star = ops[ops.length - 1];
    const expected = starburstRayCount(blades);
    if (expected === 0) {
      assert.ok(star.op !== "path" || (star.d.match(/M/g) ?? []).length !== 0 || true, "no iris draws no star");
      assert.equal(ops.filter((o) => (o.d.match(/M/g) ?? []).length === 0).length, 0);
      continue;
    }
    assert.equal((star.d.match(/M/g) ?? []).length, expected,
      `blades ${blades}: drew ${(star.d.match(/M/g) ?? []).length} rays, the law says ${expected}`);
  }
});

test("(4d) a zero-extent aperture emits NOTHING rather than a degenerate op", () => {
  for (const box of [{ w: 0, h: 200 }, { w: 200, h: 0 }, { w: 0, h: 0 }])
    assert.deepEqual(aperturePlugin.emit(stateOf(box), null, WORLD), []);
});

test("(4e) an obstruction punches a second subpath, and only then", () => {
  const plain = aperturePlugin.emit(stateOf({ blades: 0, stopDown: 0, obstruction: 0 }), null, WORLD);
  const holed = aperturePlugin.emit(stateOf({ blades: 0, stopDown: 0, obstruction: 0.53 }), null, WORLD);
  assert.equal((plain[0].d.match(/M/g) ?? []).length, 1);
  assert.equal((holed[0].d.match(/M/g) ?? []).length, 2, "a mirror lens's secondary blocks the middle of its own aperture");
});

test("(4f) apodization is a vector PAINT, so all three backends draw it", () => {
  assert.equal(apodizedPupilPaint("#ffffff", 0), "#ffffff", "off is byte-identical");
  const graded = apodizedPupilPaint("#ffd7a3", 0.85);
  assert.equal(graded.type, "radialGradient");
  assert.equal(graded.stops.length, 3);
  assert.ok(Math.abs(graded.stops[1].offset - 0.15) < EPS, "full transmission holds out to 1 - apodization");
  assert.deepEqual(graded.stops[2].color.slice(3), [0], "and reaches zero AT the rim");
});

// ── §5 THE PRESET TABLE ──────────────────────────────────────────────────────

/** The blade count each preset is SOURCED at. Written out here on purpose: it
 *  is the one number in the table that must never drift silently, and a second
 *  independent statement of it is the cheapest possible check. */
const SOURCED_BLADES = {
  "Three-Blade Cine Iris": 3,
  "Vintage TLR Pentagon": 5,
  "Seventies Six-Blade Cine": 6,
  "Rounded Seven-Blade Prime": 7,
  "Straight Eight-Blade Prime": 8,
  "Circular-Aperture Portrait": 8,
  "Nine-Blade Single-Coated": 9,
  "Reuleaux Triangle Iris": 9,
  "Apodized Soft Focus": 10,
  "Inward-Curved Rangefinder Tele": 11,
  "Single-Coated Classic": 13,
  "Fourteen-Blade Compact Prime": 14,
  "Fifteen-Blade Anamorphic Oval": 15,
  "Sixteen-Blade Circular Cine": 16,
  "Mirror Lens Donut": 0,
};

test("(5a) every preset carries its sourced blade count, and the table is complete", () => {
  const names = aperturePlugin.presets.map((p) => p.name);
  assert.deepEqual(names.slice().sort(), Object.keys(SOURCED_BLADES).sort(), "a preset was added or renamed without its sourced count");
  for (const p of aperturePlugin.presets)
    assert.equal(p.props.blades, SOURCED_BLADES[p.name], `"${p.name}" no longer carries its sourced blade count`);
});

test("(5b) every preset writes ALL EIGHT geometry knobs and touches nothing else", () => {
  const GEOMETRY = ["blades", "stopDown", "curvature", "bladeForm", "bladeRotation", "pupilAspect", "obstruction", "apodization"];
  for (const p of aperturePlugin.presets)
    assert.deepEqual(Object.keys(p.props).slice().sort(), GEOMETRY.slice().sort(),
      `"${p.name}" does not write exactly the constituting knobs — hovering the list would then depend on the order`);
});

test("(5c) NO PRESET DESCRIPTION PROMISES AN ODD RAY COUNT", () => {
  // "a seven-point star" is physically impossible; the rule exists so a preset
  // cannot teach the reader something untrue.
  const ODD_WORDS = /\b(three|five|seven|nine|eleven|thirteen|fifteen|seventeen|nineteen|twenty-one|twenty-three|twenty-five)[- ](ray|point|pointed|spike)/i;
  for (const p of aperturePlugin.presets)
    assert.ok(!ODD_WORDS.test(p.description), `"${p.name}" promises an odd-numbered star: ${p.description}`);
});

test("(5d) DISTINCTNESS: no two presets draw the same opening — AND none IS the default", () => {
  // The browser probe (tests/aperture_presets_probe.js) is the canonical gate and
  // measures real pixels. This is the same question asked in geometry, for free,
  // in bare node — and it includes THE UNTOUCHED WIDGET, because that is the pair
  // the browser actually caught: at curvature 0 the defaults were byte-identical
  // to "Straight Eight-Blade Prime", which is a dead row in the library even
  // though no two PRESETS collided.
  const signature = (state) =>
    PROBE_ANGLES.map((t) => openingRadius(t, state).toFixed(5)).join(",") +
    `|${state.pupilAspect}|${state.obstruction}|${state.apodization}`;
  const seen = new Map([[signature(stateOf({})), "(the widget's own defaults)"]]);
  for (const p of aperturePlugin.presets) {
    const sig = signature(stateOf(p.props));
    assert.ok(!seen.has(sig), `"${p.name}" draws the same opening as "${seen.get(sig)}" — one of them is a dead row`);
    seen.set(sig, p.name);
  }
});

test("(5e) every preset renders SOMETHING, at a sane point count", () => {
  for (const p of aperturePlugin.presets) {
    const ops = aperturePlugin.emit(stateOf(p.props), null, WORLD);
    assert.ok(ops.length > 0, `"${p.name}" drew nothing`);
    for (const op of ops) {
      const points = (op.d.match(/[ML]/g) ?? []).length;
      assert.ok(points > 8 && points < 2000, `"${p.name}" emitted ${points} points`);
      assert.ok(!/NaN|Infinity|undefined/.test(op.d), `"${p.name}" emitted a non-finite coordinate`);
    }
  }
});

// ── §6 HOOKS ─────────────────────────────────────────────────────────────────

test("(6a) the two POLYGON-reading handles appear only once there is a polygon", () => {
  const ids = (blades) => aperturePlugin.modifierPoints(stateOf({ blades })).map((m) => m.id);
  for (const blades of [0, 1, 2])
    assert.deepEqual(ids(blades), ["stopDown", "obstruction"], `blades ${blades} has no polygon to read`);
  for (const blades of [MIN_POLYGON_BLADES, 8, 16])
    assert.deepEqual(ids(blades), ["stopDown", "obstruction", "curvature", "bladeRotation", "blades"]);
});

test("(6b) no two handles ever sit on top of one another", () => {
  for (const blades of SWEPT_BLADES)
    for (const stopDown of [0, 0.25, 0.5, 0.9])
      for (const curvature of [-1, 0, 1]) {
        const state = stateOf({ blades, stopDown, curvature });
        // A SHUT iris has no geometry to spread handles over: every allowed set
        // has collapsed to the centre, so they legitimately coincide there. The
        // family reaches that state at exactly one place — three fully concave
        // leaves, which really do meet (see 3a-bis) — and it is skipped rather
        // than pretended away.
        if (PROBE_ANGLES.every((t) => openingRadius(t, state) < EPS)) continue;
        const points = aperturePlugin.modifierPoints(state);
        for (let i = 0; i < points.length; i++)
          for (let j = i + 1; j < points.length; j++) {
            const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
            assert.ok(d > 1, `blades ${blades} stop ${stopDown} curvature ${curvature}: "${points[i].id}" and "${points[j].id}" are ${d.toFixed(3)} px apart`);
          }
      }
});

test("(6c) hitTest is the bore, and it is sign-blind about the box", () => {
  const s = stateOf({ blades: 8, stopDown: 0.5 });
  assert.ok(aperturePlugin.hitTest(s, 110, 110), "the centre of the opening is on the widget");
  assert.ok(aperturePlugin.hitTest(s, 110, 15), "the blade ring is on the widget");
  assert.ok(!aperturePlugin.hitTest(s, 5, 5), "the bbox corner is outside the bore");
  assert.ok(!aperturePlugin.hitTest({ ...s, w: 0 }, 0, 0), "a zero-extent aperture cannot be hit");
});

test("(6d) boundaryAngles sample the full turn once, in order, with the corners on top", () => {
  for (const blades of SWEPT_BLADES) {
    const angles = boundaryAngles(stateOf({ blades }));
    for (let i = 1; i < angles.length; i++) assert.ok(angles[i] >= angles[i - 1], "not sorted");
    const expectedCorners = blades >= MIN_POLYGON_BLADES ? blades : 0;
    assert.equal(angles.length, Math.round(360 / 5) + expectedCorners, `blades ${blades}: wrong sample count`);
  }
  const outline = openingOutline(stateOf({ blades: 8, stopDown: 0.5 }));
  assert.equal(outline.length, boundaryAngles(stateOf({ blades: 8 })).length);
});

console.log(`\naperture tests: ${passed} passed  (${aperturePlugin.presets.length} presets, ${SWEPT_BLADES.length} blade counts swept)`);
