/**
 * THE ONE-CURVE TEST for Liquid Glass. The widget's boundary is now a two-parameter
 * family (corner exponent x surface tension) evaluated in two places — the SkSL
 * distance field that shades the body, and the JS point generator that strokes the
 * hairline, casts the shadow and fills the thumbnail. Before this, those were two
 * DIFFERENT curves (an Lp squircle in the shader, a circular CanvasKit.RRectXY
 * everywhere else) that disagreed by 18.9% of the corner radius on the diagonal.
 * This suite exists so they cannot drift apart again, in four steps:
 *
 *  1. ALGEBRA — at surfaceTension 0 the new SDF reduces to the pre-tension squircle
 *     formula EXACTLY (same operations, same operands, zero difference in float64),
 *     which is why the shipped look is untouched by default.
 *  2. GENERATOR — every point the outline generator emits sits on the SDF's zero
 *     set, the chords between them stay inside the declared sagitta bound, and the
 *     outline keeps touching the widget's box at all four edge midpoints.
 *  3. PIXELS — rendered through the REAL SkSL compiler on a transparent surface,
 *     the shader's coverage is 1/2 exactly where the JS generator says the edge is,
 *     ~1 just inside and ~0 just outside. This is the step that pins the JS twin to
 *     the shader; the other three are arithmetic about it.
 *  4. NO STALE PICTURE — moving ONLY surfaceTension moves pixels. The renderer keeps
 *     a static material raster keyed on the PACKED UNIFORM BYTES, so a knob missing
 *     from the packer would silently serve a previous frame's picture.
 *
 * Run: node render_gpu/tests/glass_outline_test.js
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { renderToPng } from "../skia/node_render.js";
import {
  GLASS_OUTLINE_MAX_SAGITTA_PX, glassOutlinePoints, glassSdf, glassShapeParams,
  packGlassUniforms,
} from "../skia/glass_shader.js";
import { glassBackdrop, pushTransform, popTransform } from "../ir.js";
import { glassPlugin } from "../../plugins/demo/glass.js";
import { presetFamiliesOf } from "../../core/registry.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude_vlm_checks");
let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

// ── (1) ALGEBRA: tension 0 is the pre-tension formula, operation for operation ──

/**
 * Pure function. The squircle SDF EXACTLY as it shipped before surface tension
 * existed (render_gpu/skia/glass_shader.js sdSquircle at commit 1eafc07),
 * transliterated so the reduction can be asserted rather than asserted-about.
 *
 * @example legacySdSquircle(220, 0, 220, 75, 48, 4) // 0
 * @example legacySdSquircle(0, 0, 220, 75, 48, 4) // -75
 */
function legacySdSquircle(px, py, halfW, halfH, r, n) {
  const qx = Math.abs(px) - (halfW - r);
  const qy = Math.abs(py) - (halfH - r);
  const qpx = Math.max(qx, 0), qpy = Math.max(qy, 0);
  const corner = (qpx ** n + qpy ** n) ** (1 / n);
  return corner + Math.min(Math.max(qx, qy), 0) - r;
}

test("tension 0 reduces to the pre-tension squircle SDF with ZERO difference", () => {
  // A deterministic LCG so a failure is reproducible from the seed alone.
  let seed = 20260728;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let worst = 0, worstAt = null;
  for (let i = 0; i < 300000; i++) {
    const halfW = 0.5 + rnd() * 400, halfH = 0.5 + rnd() * 400;
    const cornerRadius = rnd() * 1.4 * Math.min(halfW, halfH); // deliberately overshoots, to exercise the clamp
    const n = 2 + rnd() * 10;
    const px = (rnd() * 2 - 1) * 600, py = (rnd() * 2 - 1) * 600;
    const r = Math.min(cornerRadius, Math.min(halfW, halfH));
    const d = Math.abs(glassSdf(px, py, halfW, halfH, cornerRadius, n, 0) - legacySdSquircle(px, py, halfW, halfH, r, n));
    if (d > worst) { worst = d; worstAt = { px, py, halfW, halfH, cornerRadius, n }; }
  }
  assert.equal(worst, 0, `tension 0 must be bit-identical; worst |delta| ${worst} at ${JSON.stringify(worstAt)}`);
});

test("tension 0 stays exact at cornerRadius 0 and at NEGATIVE half-extents", () => {
  // A stored w/h may be negative (core/geometry.js unsignedState normalizes before
  // emit, but nothing in the shader path depends on that), and cornerRadius 0 is the
  // case where the pre-scale's guard branch is the one that runs.
  for (const halfW of [-220, -1, 1, 220]) {
    for (const halfH of [-75, -1, 1, 75]) {
      for (const cornerRadius of [0, 12, 400]) {
        for (const n of [2, 4, 9]) {
          for (const [px, py] of [[0, 0], [halfW, 0], [0, halfH], [halfW, halfH], [500, 500], [-3, 7]]) {
            const r = Math.min(cornerRadius, Math.min(halfW, halfH));
            const got = glassSdf(px, py, halfW, halfH, cornerRadius, n, 0);
            assert.ok(Number.isFinite(got), `non-finite SDF at half=(${halfW},${halfH}) r=${cornerRadius} n=${n} p=(${px},${py})`);
            assert.equal(got, legacySdSquircle(px, py, halfW, halfH, r, n),
              `tension 0 diverged at half=(${halfW},${halfH}) r=${cornerRadius} n=${n} p=(${px},${py})`);
          }
        }
      }
    }
  }
});

// ── (2) GENERATOR: on the zero set, inside the sagitta bound, tangent to the box ─

// The shape sweep every generator assertion runs over: square and elongated panels
// (anisotropy is what the pre-scale exists for), radius 0 through past the clamp,
// exponents from a circular arc to a near-square blob, and the whole tension axis.
const SHAPES = [];
for (const [halfW, halfH] of [[220, 75], [150, 150], [300, 40], [40, 300], [8, 6]])
  for (const cornerRadius of [0, 6, 48, 5000])
    for (const squircle of [2, 3, 4, 8, 12])
      for (const surfaceTension of [0, 0.15, 0.5, 0.85, 1])
        SHAPES.push({ halfW, halfH, cornerRadius, squircle, surfaceTension });

test(`every generated outline point lies ON the SDF zero set (${SHAPES.length} shapes)`, () => {
  let worst = 0, worstAt = null;
  for (const s of SHAPES) {
    const scale = Math.max(s.halfW, s.halfH);
    for (const [x, y] of glassOutlinePoints(s.halfW, s.halfH, s.cornerRadius, s.squircle, s.surfaceTension, 2)) {
      const d = Math.abs(glassSdf(x, y, s.halfW, s.halfH, s.cornerRadius, s.squircle, s.surfaceTension));
      // Scale-relative: the generator is exact on the zero set by construction, so
      // all that is left is the rounding of a handful of pow/cos evaluations.
      if (d / scale > worst) { worst = d / scale; worstAt = { ...s, x, y, d }; }
    }
  }
  assert.ok(worst < 1e-12, `outline left the zero set: worst relative |SDF| ${worst} at ${JSON.stringify(worstAt)}`);
});

test(`chord midpoints stay inside the declared ${GLASS_OUTLINE_MAX_SAGITTA_PX} device-px sagitta bound`, () => {
  let worst = 0, worstAt = null;
  for (const deviceScale of [0.5, 1, 2, 8]) {
    for (const s of SHAPES) {
      const pts = glassOutlinePoints(s.halfW, s.halfH, s.cornerRadius, s.squircle, s.surfaceTension, deviceScale);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        // The deviation is a LOCAL length; compare it in device px, which is what
        // the bound is stated in.
        const devDev = Math.abs(glassSdf(mx, my, s.halfW, s.halfH, s.cornerRadius, s.squircle, s.surfaceTension)) * deviceScale;
        if (devDev > worst) { worst = devDev; worstAt = { ...s, deviceScale, mid: [mx, my] }; }
      }
    }
  }
  assert.ok(worst <= GLASS_OUTLINE_MAX_SAGITTA_PX,
    `chord deviation ${worst.toFixed(4)} device px exceeds the ${GLASS_OUTLINE_MAX_SAGITTA_PX} bound at ${JSON.stringify(worstAt)}`);
  console.log(`       (worst chord deviation actually achieved: ${worst.toExponential(2)} device px)`);
});

test("the outline still TOUCHES the widget's box at all four edge midpoints, at every tension", () => {
  for (const s of SHAPES) {
    if (s.halfW <= 0 || s.halfH <= 0) continue;
    const pts = glassOutlinePoints(s.halfW, s.halfH, s.cornerRadius, s.squircle, s.surfaceTension, 2);
    const maxX = Math.max(...pts.map((p) => Math.abs(p[0])));
    const maxY = Math.max(...pts.map((p) => Math.abs(p[1])));
    // The Minkowski construction keeps inner + rr == half on both axes, so the
    // extent is the box for every tension — which is why resize handles and hit
    // tests do not have to know surface tension exists.
    assert.ok(Math.abs(maxX - s.halfW) < 1e-9 * s.halfW, `x extent ${maxX} != halfW ${s.halfW} for ${JSON.stringify(s)}`);
    assert.ok(Math.abs(maxY - s.halfH) < 1e-9 * s.halfH, `y extent ${maxY} != halfH ${s.halfH} for ${JSON.stringify(s)}`);
  }
});

test("degenerate geometry produces a finite, duplicate-free loop (never NaN)", () => {
  for (const halfW of [0, -0, 1e-6, 220])
    for (const halfH of [0, -0, 1e-6, 75])
      for (const cornerRadius of [0, 48])
        for (const squircle of [2, 4])
          for (const surfaceTension of [0, 0.5, 1]) {
            const pts = glassOutlinePoints(halfW, halfH, cornerRadius, squircle, surfaceTension, 2);
            assert.ok(pts.length >= 1, `empty outline for half=(${halfW},${halfH})`);
            for (const [x, y] of pts)
              assert.ok(Number.isFinite(x) && Number.isFinite(y), `non-finite point (${x},${y}) for half=(${halfW},${halfH}) t=${surfaceTension}`);
            for (let i = 1; i < pts.length; i++)
              assert.ok(!(pts[i][0] === pts[i - 1][0] && pts[i][1] === pts[i - 1][1]), "consecutive duplicate point");
          }
});

test("radius 0 at tension 0 is the bare rectangle; tension 1 is the superellipse (no straight run)", () => {
  assert.deepEqual(glassOutlinePoints(100, 60, 0, 4, 0, 1), [[100, 60], [-100, 60], [-100, -60], [100, -60]]);
  const relaxed = glassShapeParams(220, 75, 48, 4, 1);
  assert.deepEqual(relaxed, { n: 4, rrX: 220, rrY: 75, innerX: 0, innerY: 0 });
  // Half-way along the top: tension 0 is exactly on the box, tension 1 is inside it.
  assert.equal(glassSdf(110, 75, 220, 75, 48, 4, 0), 0);
  assert.ok(glassSdf(110, 75, 220, 75, 48, 4, 1) > 1, "at tension 1 the top edge has pulled away from the box");
});

test("the flattening is OUTPUT-SENSITIVE: it buys points with zoom, and refuses to buy them for a thin arc", () => {
  const at = (scale) => glassOutlinePoints(220, 75, 48, 4, 0, scale).length;
  assert.ok(at(8) > at(2) && at(2) > at(0.5), "more device pixels must buy finer chords");
  // The tolerance is a sagitta, so halving it (4x the scale) roughly doubles the
  // count — sub-linear, which is what keeps a deep zoom affordable.
  const ratio = at(8) / at(2);
  assert.ok(ratio > 1.2 && ratio < 3, `4x zoom should cost well under 4x the points, got ${ratio.toFixed(2)}x`);
  // The cases a closed-form curvature bound could not survive. A corner whose
  // semi-axes differ by six orders of magnitude is a straight line to within a
  // millionth of a pixel, and a 100:1 panel relaxed all the way is still cheap.
  assert.ok(glassOutlinePoints(1e-6, 75, 48, 4, 0.5, 2).length < 32,
    `a 1e-6-wide corner should need almost no points, got ${glassOutlinePoints(1e-6, 75, 48, 4, 0.5, 2).length}`);
  assert.ok(glassOutlinePoints(1000, 10, 10, 4, 1, 2).length < 400,
    `a fully relaxed 100:1 panel should stay cheap, got ${glassOutlinePoints(1000, 10, 10, 4, 1, 2).length}`);
});

// ── (3) IR + plugin plumbing ──────────────────────────────────────────────────

test("the op clamps surfaceTension to the family's own endpoints and defaults to 0", () => {
  const box = { cx: 0, cy: 0, halfW: 80, halfH: 40 };
  assert.equal(glassBackdrop({ ...box }).surfaceTension, 0, "default is the shipped un-relaxed shape");
  assert.equal(glassBackdrop({ ...box, surfaceTension: 2 }).surfaceTension, 1);
  assert.equal(glassBackdrop({ ...box, surfaceTension: -3 }).surfaceTension, 0);
  assert.equal(glassBackdrop({ ...box, surfaceTension: 0.42 }).surfaceTension, 0.42);
  assert.throws(() => glassBackdrop({ ...box, surfaceTension: NaN }), /surfaceTension/);
});

test("the packed uniform block carries surfaceTension (a knob outside it cannot reach the shader)", () => {
  const u = {
    cx: 1, cy: 2, halfW: 3, halfH: 4, cornerRadius: 5, edgeFalloff: 6, refractionStrength: 7,
    angle: 0, lightAngle: -1.57, lightIntensity: 0.6, saturation: 0.9, tint: [1, 1, 1, 0.14],
    materialize: 1, squircle: 4, sheen: 0.1, specPower: 8, contactShadow: 0.26, caustic: 0.12,
    edgeLight: 0.14, adaptivity: 1, chromatic: 0.08, surfaceTension: 0.37,
  };
  const packed = packGlassUniforms(u);
  assert.equal(packed.length, 25);
  assert.ok(Math.abs(packed[24] - 0.37) < 1e-6, "surfaceTension is the last uniform slot");
  const other = packGlassUniforms({ ...u, surfaceTension: 0.91 });
  assert.notDeepEqual([...packed], [...other], "changing only surfaceTension MUST change the packed bytes");
});

test("the plugin threads surfaceTension through emit() and defaults it to 0", () => {
  assert.equal(glassPlugin.defaults.surfaceTension, 0);
  const ops = glassPlugin.emit({ ...glassPlugin.defaults, w: 400, h: 120, surfaceTension: 0.6 });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].surfaceTension, 0.6);
});

// ── (4) PRESETS: two orthogonal families, complete within themselves ──────────

test("the two preset families are complete, in range, and write disjoint keys", () => {
  const families = presetFamiliesOf(glassPlugin);
  assert.deepEqual(families.map((f) => f.id), ["presets.material", "presets.silhouette"]);
  const keySets = families.map((f) => new Set(f.presets.flatMap((p) => Object.keys(p.props))));
  assert.equal([...keySets[0]].filter((k) => keySets[1].has(k)).length, 0, "families must not clobber each other");
  for (const [i, fam] of families.entries()) {
    assert.ok(fam.presets.length >= 9, `${fam.id} has only ${fam.presets.length} presets`);
    const names = new Set();
    for (const p of fam.presets) {
      assert.ok(p.name && p.description, `${fam.id}: a preset is missing name/description`);
      assert.ok(!names.has(p.name), `${fam.id}: duplicate preset name "${p.name}"`);
      names.add(p.name);
      // EVERY preset sets EVERY key its family owns — app.applyPreset writes exactly
      // the keys present, so an omission inherits the previously hovered preset.
      assert.deepEqual(new Set(Object.keys(p.props)), keySets[i], `${fam.id}/"${p.name}" does not set every key its family owns`);
      // Every value must survive the op's own clamps unchanged, i.e. no preset is
      // secretly asking for something the shader will refuse.
      const emitted = glassPlugin.emit({ ...glassPlugin.defaults, ...p.props, w: 440, h: 160 })[0];
      for (const [k, v] of Object.entries(p.props)) {
        if (k === "tint") continue; // a paint, normalized to an rgba array
        const want = k === "cornerRadius" ? Math.max(0, v) : v;
        assert.equal(emitted[k], want, `${fam.id}/"${p.name}": ${k}=${v} was clamped to ${emitted[k]}`);
      }
    }
  }
  // The knobs deliberately absent from every preset (composition, animation, perf).
  const allKeys = new Set([...keySets[0], ...keySets[1]]);
  for (const k of ["lightAngle", "materialize", "backdropScale"])
    assert.ok(!allKeys.has(k), `${k} must not be in any preset (composition/animation/perf, not look)`);
});

// How far apart two silhouettes must be SOMEWHERE to count as different shapes,
// in device px. DERIVED: the shader's coverage ramp spans +-AA_PX = 1 device px, so
// two outlines that never separate by more than that could be told apart only from
// each other's antialiasing. Twice the ramp is the smallest gap that is a shape
// difference rather than an edge-softness difference. (Enclosed AREA was tried
// first and is the wrong measure — "Softened" and "Pillow" enclose areas within
// 75 px^2 of each other while looking nothing alike, one being a barely-bowed
// panel and the other a fat pillow.)
const MIN_SILHOUETTE_SEPARATION_PX = 2;

test("the SILHOUETTE presets are visibly distinct shapes, not neighbours", () => {
  const silhouette = presetFamiliesOf(glassPlugin).find((f) => f.id === "presets.silhouette");
  const HALF_W = 220, HALF_H = 80, SCALE = 2;
  const outlines = silhouette.presets.map((p) => ({
    name: p.name,
    pts: glassOutlinePoints(HALF_W, HALF_H, p.props.cornerRadius, p.props.squircle, p.props.surfaceTension, SCALE),
  }));
  // The symmetric Hausdorff distance between the two curves, in device px: the
  // furthest either outline ever strays from the other. That is exactly "how far
  // apart do these look at their most different point".
  const oneWay = (A, B) => Math.max(...A.map(([ax, ay]) => Math.min(...B.map(([bx, by]) => Math.hypot(ax - bx, ay - by)))));
  const hausdorff = (A, B) => Math.max(oneWay(A, B), oneWay(B, A)) * SCALE;
  const worst = { d: Infinity, pair: null };
  for (let i = 0; i < outlines.length; i++)
    for (let j = i + 1; j < outlines.length; j++) {
      const d = hausdorff(outlines[i].pts, outlines[j].pts);
      if (d < worst.d) { worst.d = d; worst.pair = [outlines[i].name, outlines[j].name]; }
      assert.ok(d > MIN_SILHOUETTE_SEPARATION_PX,
        `"${outlines[i].name}" and "${outlines[j].name}" never separate by more than ${d.toFixed(2)} device px — not visibly distinct`);
    }
  console.log(`       closest pair: ${worst.pair.join(" / ")} at ${worst.d.toFixed(1)} device px apart`);
});

// ── (5) PIXELS: the shader's coverage is 1/2 where the JS generator says ───────

// Just big enough to hold the panel and its refraction margin: the shader runs on a
// SOFTWARE surface here (~6 us per pixel), so every pixel outside the panel is time
// spent proving nothing. The panel is 440x160 world = 880x320 device.
const DPR = 2, W = 500, H = 230;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: DPR };
const DEVICE_SCALE = VIEW.zoom * VIEW.dpr; // world.scale is 1 in these scenes

/** Query→build. Renders ONE glass panel centred on the surface over a TRANSPARENT
 * background with the stroke and drop shadow off, so the PNG's alpha channel IS the
 * shader's own coverage. Returns {w, h, alpha} with alpha as a 0..1 Float32Array. */
async function coverageOf(overrides) {
  const panelW = 440, panelH = 160;
  const s = { ...glassPlugin.defaults, w: panelW, h: panelH, strokeWidth: 0, shadowStrength: 0, ...overrides };
  const ops = [
    pushTransform({ x: W / 2 - panelW / 2, y: H / 2 - panelH / 2 }),
    ...glassPlugin.emit(s),
    popTransform(),
  ];
  const png = await renderToPng(ops, VIEW, { width: W * DPR, height: H * DPR, background: "rgba(0,0,0,0)" });
  const { default: CKInit } = await import("canvaskit-wasm");
  const CanvasKit = await CKInit();
  const img = CanvasKit.MakeImageFromEncoded(png);
  if (!img) throw new Error("coverageOf: could not decode the render");
  const w = img.width(), h = img.height();
  const raw = new Uint8Array(img.readPixels(0, 0, {
    width: w, height: h, colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB,
  }));
  img.delete();
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = raw[i * 4 + 3] / 255;
  // The panel centre in DEVICE px, so a LOCAL boundary point can be looked up.
  const centreX = (W / 2) * DEVICE_SCALE, centreY = (H / 2) * DEVICE_SCALE;
  const sample = (lx, ly) => {
    // Bilinear, because a boundary point almost never lands on a pixel centre.
    const fx = centreX + lx * DEVICE_SCALE - 0.5, fy = centreY + ly * DEVICE_SCALE - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : alpha[y * w + x]);
    return (1 - tx) * (1 - ty) * at(x0, y0) + tx * (1 - ty) * at(x0 + 1, y0)
      + (1 - tx) * ty * at(x0, y0 + 1) + tx * ty * at(x0 + 1, y0 + 1);
  };
  return { s, sample, png };
}

// The shader's coverage is 1 - smoothstep(-1, 1, d) over a +-1 device px band, so on
// the boundary it is smoothstep's midpoint, 1/2, and its slope there is 0.75 per
// device px. TOLERANCE is therefore a DISTANCE budget expressed in coverage: 0.12
// admits the curve being wrong by 0.16 device px, six tenths of the polyline sagitta
// bound plus the bilinear reconstruction of a curved edge inside one pixel.
const COVERAGE_SLOPE_PER_PX = 0.75;
const EDGE_COVERAGE_TOLERANCE = 0.12;
// Where coverage must be saturated. The antialias band is +-1 device px, so 3 px
// out is a full band clear of it on either side; the probe walks the SDF's own
// gradient, since the radial direction from the panel centre is NOT the normal
// anywhere along a flat edge and would under-step the band there.
const SATURATION_PROBE_PX = 3;

/** Pure function. Outward unit normal of the glass region at a LOCAL point, from
 * central differences of the SDF (the shader's own normalLocal, in JS). `eps` is a
 * local length; any value well under the local radius of curvature gives the same
 * direction, so the probe below uses a fraction of a device pixel. */
function outwardNormal(px, py, s, eps) {
  const sd = (x, y) => glassSdf(x, y, s.w / 2, s.h / 2, s.cornerRadius, s.squircle, s.surfaceTension);
  const gx = sd(px + eps, py) - sd(px - eps, py);
  const gy = sd(px, py + eps) - sd(px, py - eps);
  const len = Math.hypot(gx, gy);
  return len > 0 ? [gx / len, gy / len] : [0, -1];
}

for (const overrides of [
  { squircle: 4, surfaceTension: 0 },
  { squircle: 2, surfaceTension: 0 },
  { squircle: 8, surfaceTension: 0 },
  { squircle: 4, surfaceTension: 0.5 },
  { squircle: 4, surfaceTension: 1 },
  { squircle: 2, surfaceTension: 1 },
  { squircle: 4, surfaceTension: 1, cornerRadius: 0 },
  { squircle: 4, surfaceTension: 0, cornerRadius: 5000 },
]) {
  const label = `squircle ${overrides.squircle}, tension ${overrides.surfaceTension}${overrides.cornerRadius !== undefined ? `, radius ${overrides.cornerRadius}` : ""}`;
  await atest(`SkSL coverage is 1/2 on the JS outline, saturated either side — ${label}`, async () => {
    const { s, sample } = await coverageOf(overrides);
    const pts = glassOutlinePoints(s.w / 2, s.h / 2, s.cornerRadius, s.squircle, s.surfaceTension, DEVICE_SCALE);
    let worstEdge = 0, worstAt = null, inMin = 1, outMax = 0;
    // Every 7th point: enough coverage of the whole loop without 600 renders' worth
    // of arithmetic, and 7 is coprime with the per-quadrant count so the samples do
    // not land on the same phase of every quadrant.
    for (let i = 0; i < pts.length; i += 7) {
      const [x, y] = pts[i];
      const a = sample(x, y);
      if (Math.abs(a - 0.5) > worstEdge) { worstEdge = Math.abs(a - 0.5); worstAt = [x, y, a]; }
      const step = SATURATION_PROBE_PX / DEVICE_SCALE;
      const [nx, ny] = outwardNormal(x, y, s, 0.25 / DEVICE_SCALE);
      inMin = Math.min(inMin, sample(x - nx * step, y - ny * step));
      outMax = Math.max(outMax, sample(x + nx * step, y + ny * step));
    }
    assert.ok(worstEdge <= EDGE_COVERAGE_TOLERANCE,
      `coverage on the outline strayed ${worstEdge.toFixed(3)} from 1/2 (~${(worstEdge / COVERAGE_SLOPE_PER_PX).toFixed(2)} device px) at ${JSON.stringify(worstAt)}`);
    assert.ok(inMin > 0.9, `coverage ${SATURATION_PROBE_PX} px INSIDE the outline dropped to ${inMin.toFixed(3)}`);
    assert.ok(outMax < 0.1, `coverage ${SATURATION_PROBE_PX} px OUTSIDE the outline rose to ${outMax.toFixed(3)}`);
    console.log(`       edge |cov - 1/2| <= ${worstEdge.toFixed(3)} (~${(worstEdge / COVERAGE_SLOPE_PER_PX).toFixed(2)} device px); inside ${inMin.toFixed(3)}, outside ${outMax.toFixed(3)}`);
  });
}

// ── (6) NO STALE PICTURE: only-surfaceTension-changed must move pixels ─────────

await atest("moving ONLY surfaceTension changes the rendered bytes (the raster-cache failure mode)", async () => {
  const hashes = new Map();
  for (const surfaceTension of [0, 0.25, 0.5, 0.75, 1]) {
    const { png } = await coverageOf({ surfaceTension });
    const h = crypto.createHash("md5").update(png).digest("hex");
    for (const [t, prev] of hashes)
      assert.notEqual(h, prev, `tension ${surfaceTension} rendered byte-identically to tension ${t} — a stale picture`);
    hashes.set(surfaceTension, h);
  }
  console.log("       " + [...hashes].map(([t, h]) => `t=${t}:${h.slice(0, 8)}`).join("  "));
});

// A look at the tension axis for the record, at the widget's own defaults.
await atest("wrote the surface-tension ramp for inspection", async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const t of [0, 0.5, 1]) {
    const { png } = await coverageOf({ surfaceTension: t });
    fs.writeFileSync(path.join(OUT_DIR, `glass_tension_coverage_${String(t).replace(".", "p")}.png`), Buffer.from(png));
  }
});

console.log(failures ? `\nglass_outline_test: ${failures} FAILED` : "\nglass_outline_test: all checks passed");
process.exit(failures ? 1 : 0);
