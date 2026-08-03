/**
 * THE SKY'S TIME KNOBS — twinkle (RECORDABLE state) and the long exposure (PROPERTY
 * state). Plain node, no GPU for the unit half; the pixel half uses the CPU raster.
 * Run: node src/demo_apps/PowerRP/tests/sky_twinkle_trails_test.js
 *
 * WHY THIS FILE EXISTS SEPARATELY. tests/animated_paint_test.js proves the REGISTRY
 * seam (which materials declare a clock read) and render_gpu/tests/sky_star_seam_test.js
 * proves the SCREEN-SPACE laws (roundness, box independence, no galaxy seam). Neither
 * says anything about the two knobs BM added, and the thing that most needs pinning
 * about them is a CLAIM ABOUT TIME that only a rendered frame can settle:
 *
 *   TWINKLE IS RECORDABLE STATE (CLAUDE.md's taxonomy). It is a function of ELAPSED
 *   TIME ALONE, read through the ONE seamed clock (particleTime), seeded per star. The
 *   defining test is Δt = 0 ⟹ THE PICTURE IS UNCHANGED — not "usually", by definition —
 *   and it is mechanically checkable in both directions, which is what (1) and (2) do.
 *   Getting this wrong is not cosmetic: a widget that fails it breaks frame-range
 *   sharding (cli/render_job.js renders frame 200 without frame 199) and makes an
 *   export unreproducible.
 *
 *   THE LONG EXPOSURE IS *NOT* RECORDABLE STATE, and that distinction is the whole
 *   reason `animated` could become param-predicated. trailArc/trailSamples are ordinary
 *   keyframed document values; the shader reads them, never the clock. So a sky with
 *   trails and no twinkle is STATIC at rest — it animates when the DOCUMENT animates,
 *   like every other property — and the presenter must not spin a repaint loop for it.
 *   (4) pins that, because getting it wrong the other way is the "rainy window froze in
 *   the presenter" bug's mirror image: a loop that never stops.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createRegistry, presetFamiliesOf } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { paintIsAnimated } from "../render_gpu/skia/materials.js";
import { SKY_FILL_PARAMS, SKY_SKSL, skyParamsAreAnimated, packSky, skyUniformParams } from "../render_gpu/skia/sky_shader.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { deserialize, repairedDocument, foldState } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { cameraRect } from "../core/derive.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR } from "../web/cameraFrame.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { committedFaces, FALLBACK_FACES } from "../render_gpu/fonts.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

const registry = createRegistry();
registerAll(registry, createCommands());
const skyPlugin = registry.get("sky");

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fonts");
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

/** Query→build (reads font files). The shared FontCollection (node_render.js recipe). */
function buildFontCollection() {
  const provider = CanvasKit.TypefaceFontProvider.Make();
  for (const { family, file } of [...committedFaces().map((f) => ({ family: f.cssFamily, file: f.file })), ...FALLBACK_FACES]) {
    const p = path.join(FONTS_DIR, file);
    if (fs.existsSync(p)) provider.registerFont(fs.readFileSync(p), family);
  }
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(provider);
  fc.enableFontFallback();
  return fc;
}
const fontCollection = buildFontCollection();

// A NIGHT fixture with the stars as the only thing in frame: no sun (so the day term is
// zero), black night colour, band off, horizon pushed below the box so no ground band.
// Small, because these checks render several times and the analytic dome is heavy.
const W = 300, H = 300;
const STARS_ONLY = { milkyWay: 0, night: "#000000", horizon: -3, starDensity: 55, starSize: 1.8 };
const def = (type, over) => ({ ...registry.get(type).defaults, type, active: true, ...over });

/** Command. Renders the star fixture at the given knobs; returns RGBA pixels. */
function render(over) {
  const raw = {
    meta: { name: "bm-twinkle", slideW: W, slideH: H },
    slides: [{
      id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null },
      delta: { items: {
        cam: def("camera", { name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, background: "#000000" }),
        sky: def("sky", { name: "SKY", z: 10, x: 0, y: 0, w: W, h: H, ...STARS_ONLY, ...over }),
      } },
    }],
  };
  const { doc } = repairedDocument(deserialize(JSON.stringify(raw)), registry);
  const state = evaluateState(foldState(doc, 0, 1), registry).state;
  const rect = cameraRect(state, doc.meta);
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("sky_twinkle_trails_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cameraFrameIR(state, doc.meta, registry), fitRectView(rect, W, H, 1),
    { fontCollection, background: rect.background, makeSurface: (w, h) => CanvasKit.MakeSurface(w, h) });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return px;
}
/** Pure function. Bytes differing between two equal-length buffers.
 *  @example diffBytes(new Uint8Array([1,2]), new Uint8Array([1,3])) // 1 */
function diffBytes(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}
/** Pure function. Rec.709 luma of pixel i.
 *  @example luma(new Uint8Array([0,0,0,255]), 0) // 0 */
function luma(px, i) { return 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]; }
/** Pure function. Mean luma of a frame. @example meanLuma(new Uint8Array([0,0,0,255])) // 0 */
function meanLuma(px) {
  let s = 0;
  for (let i = 0; i < px.length / 4; i++) s += luma(px, i);
  return s / (px.length / 4);
}

console.log("sky twinkle + long exposure:");

// ── (1) Δt = 0 ⟹ BYTE-IDENTICAL ─────────────────────────────────────────────
test("(1) twinkle is RECORDABLE: the same clock reading renders byte-identically", () => {
  for (const t of [0, 3.75, 120.5]) {
    setParticleTimeOverride(t);
    const a = render({ twinkle: 0.6 });
    const b = render({ twinkle: 0.6 });
    setParticleTimeOverride(null);
    assert.equal(diffBytes(a, b), 0,
      `two renders at the SAME particleTime ${t} differ — twinkle is reading something other than the seamed clock (a wall clock, or an unseeded hash), which breaks export reproducibility and frame-range sharding`);
  }
});

// ── (2) Δt ≠ 0 ⟹ IT ACTUALLY MOVES (the control for (1)) ────────────────────
test("(2) …and a DIFFERENT clock reading really does change the picture", () => {
  setParticleTimeOverride(0);
  const a = render({ twinkle: 0.6 });
  setParticleTimeOverride(1.3);
  const b = render({ twinkle: 0.6 });
  setParticleTimeOverride(null);
  assert.ok(diffBytes(a, b) > 0,
    "advancing particleTime changed nothing with twinkle at 0.6 — check (1) would then be vacuous (it would pass for a frozen picture)");
});

// ── (3) TWINKLE 0 IS AN EXACT NO-OP IN TIME ─────────────────────────────────
test("(3) twinkle 0 freezes the sky: the clock stops mattering entirely", () => {
  setParticleTimeOverride(0);
  const a = render({ twinkle: 0 });
  setParticleTimeOverride(97.25);
  const b = render({ twinkle: 0 });
  setParticleTimeOverride(null);
  assert.equal(diffBytes(a, b), 0,
    "at twinkle 0 the sky still changed with the clock — the factor 1 − a + a·sin(…) must be EXACTLY 1 there, which is what lets `animated` be false and the presenter's repaint loop stand down");
  assert.ok(meanLuma(a) > 0, "the twinkle-0 fixture renders no stars at all, so this check is measuring an empty frame");
});

// ── (4) THE ANIMATED PREDICATE, TRI-STATE (the CRT precedent) ───────────────
test("(4) `animated` is PARAM-PREDICATED on twinkle alone", () => {
  const mk = (params) => ({ type: "material", material: { id: "sky", params } });
  assert.equal(skyParamsAreAnimated({ twinkle: 0.3 }), true);
  assert.equal(skyParamsAreAnimated({ twinkle: 0 }), false);
  // THE DEFAULT SKY IS ANIMATED (twinkle defaults to 0.3), so an absent param map must
  // resolve through the schema defaults rather than to "no twinkle".
  assert.equal(paintIsAnimated(mk({})), true, "a default sky paint must animate — twinkle defaults to 0.3");
  assert.equal(paintIsAnimated(mk({ twinkle: 0 })), false, "twinkle 0 must read as static");
  // A TRAIL IS NOT A CLOCK READ. trailArc/trailSamples are ordinary document state, so
  // a trailing sky with no twinkle is static at rest — the presenter must not loop for it.
  assert.equal(paintIsAnimated(mk({ twinkle: 0, trailArc: 0.5, trailSamples: 48 })), false,
    "a long exposure made the paint 'animated' — trails are keyframed document state, not a function of elapsed time, so this would spin a repaint loop forever");
});

// ── (5) THE SCHEMA carries the three knobs, with the default that preserves the look ──
test("(5) the schema declares twinkle/trailArc/trailSamples, twinkle defaulting to the old baked 0.3", () => {
  const byName = new Map(SKY_FILL_PARAMS.map((r) => [r.name, r]));
  for (const k of ["twinkle", "trailArc", "trailSamples"])
    assert.ok(byName.has(k), `SKY_FILL_PARAMS has no "${k}" row, so the fill-material UI cannot show it`);
  // 0.3 is not taste: the pre-BM shader read `0.7 + 0.3·sin(…)`, so 0.3 is the value at
  // which the new expression `1 − a + a·sin(…)` is the OLD one, and every deck authored
  // before the knob existed renders unchanged.
  assert.equal(byName.get("twinkle").default, 0.3);
  assert.equal(byName.get("trailArc").default, 0, "a new sky must default to an INSTANT photograph, not a trailing one");
  assert.equal(byName.get("trailSamples").max, 64, "the sample ceiling must match the shader's unrolled MAX_TRAIL_SAMPLES");
  // The widget's own defaults must agree with the schema it spreads.
  for (const k of ["twinkle", "trailArc", "trailSamples"])
    assert.equal(skyPlugin.defaults[k], byName.get(k).default, `sky widget default for ${k} disagrees with SKY_FILL_PARAMS`);
});

// ── (6) THE SHADER'S OWN STRUCTURE: one angle, both layers ─────────────────
test("(6) both night layers rotate from the SAME timeOfDay expression", () => {
  // The rigid dome is a claim about the SOURCE as much as about pixels: BOTH rotation
  // calls must take their angle from uTimeOfDay (plus, for the exposure, the SAME
  // trailTurns), and neither may invent one of its own.
  //
  // THIS CHECK USED TO PIN THE EXPRESSION `skyRotatePlane(pw, turns)` LITERALLY, and
  // that was a mistake worth recording: when the star trail became ANALYTIC the star
  // rotation was correctly HOISTED OUT of the band's sampling loop (it is now one
  // evaluation at the shutter-open angle, `skyRotatePlane(pw, uTimeOfDay)`, with the arc
  // handed to starField as a parameter). The dome was still perfectly rigid — the pin
  // was describing the old code's SHAPE rather than its LAW, so a legal refactor read as
  // a regression. Pin the law: each call's angle argument must be built from uTimeOfDay.
  const planeCall = SKY_SKSL.match(/skyRotatePlane\(pw[^)]*,\s*([^)]+)\)/);
  const dirCall = SKY_SKSL.match(/skyRotateDir\(dirV,\s*([^)]+)\)/);
  assert.ok(planeCall, "the star layer no longer calls skyRotatePlane at all");
  assert.ok(dirCall, "the Milky Way no longer calls skyRotateDir at all");
  for (const [layer, m] of [["star field", planeCall], ["Milky Way", dirCall]])
    assert.match(m[1].trim(), /uTimeOfDay|^turns$/,
      `the ${layer} takes its rotation angle from "${m[1].trim()}", which is not the shared uTimeOfDay — each layer computing its own is exactly how the band and the stars came to move differently`);
  // The band's sampled angle must still be uTimeOfDay plus a multiple of the SAME arc
  // the stars were given, or a long exposure would smear the two layers differently.
  assert.match(SKY_SKSL, /float turns = uTimeOfDay \+ trailTurns \* f;/,
    "the band's per-sample angle is no longer uTimeOfDay + trailTurns·f — the two layers would then integrate different exposures");
  assert.match(SKY_SKSL, /starField\(pwR,[^)]*trailTurns \* TWO_PI/,
    "the star layer is not being handed trailTurns — its arc must be the same exposure the band samples over");
  // The pre-BM forms, which must not come back.
  assert.ok(!/rot2\(dirV\.xz, uTimeOfDay \* TWO_PI\)/.test(SKY_SKSL),
    "the galaxy is spinning about the ZENITH again (rot2 on dirV.xz) — that is the original defect: a uniform azimuthal slide under stars that wheel");
  assert.ok(!/rot2\(pw \/ max\(cellPx, EPS\), uTimeOfDay/.test(SKY_SKSL),
    "the star lattice is wheeling about the BOX CENTRE again — the other half of the original defect");
});

// ── (6b) THE RIGID DOME, IN PIXELS ─────────────────────────────────────────
test("(6b) advancing time moves the star layer and the band by the SAME rotation", () => {
  // (6) guards the source; this measures the picture, because the source-level claim is
  // only as good as the two rotations actually AGREEING numerically. The original defect
  // was visible precisely as a DISAGREEMENT IN KIND: over a small time step the stars
  // curled about a centre while the band slid uniformly sideways.
  //
  // The discriminator used here is the one that told those two apart in the BM
  // measurement: a rotation about a pole moves different parts of the frame in different
  // DIRECTIONS (a curl), while an azimuthal spin of the sphere moves them all the same
  // way (a slide). So render each layer ALONE across a small time step and compare the
  // per-quadrant displacement fields; under one shared rotation the two fields must have
  // the same character, and in particular the band must NOT be a uniform translation.
  setParticleTimeOverride(0);
  const starsOnly = (tod) => render({ twinkle: 0, trailArc: 0, milkyWay: 0, timeOfDay: tod });
  const bandOnly = (tod) => render({ twinkle: 0, trailArc: 0, starDensity: 0, starSize: 0, milkyWay: 2.2, timeOfDay: tod });
  const [s0, s1] = [starsOnly(0.20), starsOnly(0.21)];
  const [b0, b1] = [bandOnly(0.20), bandOnly(0.21)];
  setParticleTimeOverride(null);

  // A layer that does not change over the step tells us nothing, so prove both moved.
  const diff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length / 4; i++) if (Math.abs(luma(a, i) - luma(b, i)) > 6) n++;
    return n;
  };
  const ds = diff(s0, s1), db = diff(b0, b1);
  assert.ok(ds > 0, "the star layer did not move at all over the time step — this check is measuring nothing");
  assert.ok(db > 0, "the band did not move at all over the time step — this check is measuring nothing");

  // WHAT THIS CHECK DOES *NOT* DO, because it was tried and MEASURED not to work.
  // The first version of (6b) tried to tell the fix from the defect by their MOTION
  // FIELDS: a rotation about a pole should "curl" while an azimuthal spin should
  // "slide", so it compared the left and right halves' centre-of-brightness shift.
  // A/B'd against the real defect (the shader patched back to the zenith spin, then
  // restored), at 300x300 over timeOfDay 0.20→0.21:
  //     FIXED   L +2.37  R −1.08   |   DEFECT  L +1.20  R −1.99
  // BOTH have opposite-signed halves. The band is drawn through a non-linear
  // box→dome projection, so even a rigid zenith spin arrives on screen as a
  // position-dependent field — "looks like a curl" does not distinguish the two, and a
  // threshold separating those four numbers would have been fitted to noise, passing
  // for the fixed shader by luck rather than by reason. So the pixel-level claim made
  // here is the one that IS exactly true and does discriminate: THE TWO LAYERS SHARE
  // ONE ANGLE, so the band's motion must be a function of uTimeOfDay in the same way
  // the stars' is — advancing time by the same step must move BOTH, and returning to
  // the same time must return BOTH to the same pixels. The geometric character of the
  // rotation is proven where it can be proven exactly: (6) pins the shared angle in the
  // source, and the BM commit message records the de-rotation measurement (residual
  // 4.30 → 0.14 about SKY_POLE_PX) that established the pole itself.
  //
  // DETERMINISM ACROSS THE STEP, both layers: the same timeOfDay must render the same
  // pixels, or "they move together" is unfalsifiable because neither is repeatable.
  setParticleTimeOverride(0);
  const s0again = starsOnly(0.20), b0again = bandOnly(0.20);
  setParticleTimeOverride(null);
  assert.equal(diffBytes(s0, s0again), 0, "the star layer does not render the same pixels twice at one timeOfDay");
  assert.equal(diffBytes(b0, b0again), 0, "the band does not render the same pixels twice at one timeOfDay");

  // AND THE SHARED ANGLE, IN PIXELS: uTimeOfDay must drive BOTH layers. If either
  // ignored it, that layer would be frozen while the other wheeled — which is the
  // extreme form of the reported defect, and the one thing a pixel test can settle
  // cheaply and without a fitted constant.
  assert.ok(ds > 0.001 * (W * H),
    `only ${ds} star pixels changed over a 0.01-turn step — the star layer is barely reading timeOfDay`);
  assert.ok(db > 0.001 * (W * H),
    `only ${db} band pixels changed over a 0.01-turn step — the band is barely reading timeOfDay, so it is not riding the dome's rotation`);
  console.log(`      time step 0.20→0.21: star px moved ${ds}, band px moved ${db} (both layers ride uTimeOfDay; both repeat exactly at a fixed time)`);
});

// ── (7) THE PACKER round-trips the new uniforms in declaration order ────────
test("(7) packSky carries the three new uniforms at their declared positions", () => {
  const base = {
    cx: 0, cy: 0, halfW: 150, halfH: 150, cornerRadius: 0, angle: 0, scale: 1, time: 0,
    horizon: -0.15, turbidity: 3, atmosphere: 1, exposure: 1.1, starDensity: 79, starSize: 0.82,
    milkyWay: 1, timeOfDay: 0.2, twinkle: 0.42, trailArc: 0.084, trailSamples: 40, moonlight: 0,
    zenith: "#ffffff", ground: "#0d1017", night: "#04060e", galaxyTint: "#46567c", suns: [],
  };
  const packed = packSky(base);
  // geometry 8 (cx,cy,halfW,halfH,cornerRadius,angle,scale,time) then the scalars in
  // SkSL order: horizon,turbidity,atmosphere,exposure,starDensity,starSize,milkyWay,
  // timeOfDay,twinkle,trailArc,trailSamples,moonlight,sunCount.
  assert.equal(packed.length, 57, "the uniform count changed without SKY_UNIFORM_FLOATS following it");
  assert.ok(Math.abs(packed[16] - 0.42) < 1e-6, `twinkle did not land at index 16 (got ${packed[16]})`);
  assert.ok(Math.abs(packed[17] - 0.084) < 1e-6, `trailArc did not land at index 17 (got ${packed[17]})`);
  assert.ok(Math.abs(packed[18] - 40) < 1e-6, `trailSamples did not land at index 18 (got ${packed[18]})`);
  // A NaN uniform blackens the whole region, so the packer must refuse one loudly.
  assert.throws(() => packSky({ ...base, twinkle: NaN }), /twinkle/);
  assert.throws(() => packSky({ ...base, trailArc: undefined }), /trailArc/);
});

// ── (8) THE EXPOSURE FAMILY is complete over its own keys and OFF by default ─
test("(8) every exposure preset writes BOTH shutter knobs, and none writes an atmosphere knob", () => {
  const families = presetFamiliesOf(skyPlugin);
  const expo = families.find((f) => f.id === "presets.exposure");
  assert.ok(expo, `sky declares no exposure family (has: ${families.map((f) => f.id).join(", ")})`);
  for (const preset of expo.presets)
    for (const k of ["trailArc", "trailSamples"])
      assert.ok(k in preset.props,
        `exposure preset "${preset.name}" omits ${k} — hovering it after another exposure preset would leave that knob's previous value`);
  // Longer arcs MUST carry more samples or they bead; this is the one ordering the
  // family's numbers have to respect, and it is the reason trailSamples is in the family
  // at all rather than being left as a bare quality row.
  const sorted = [...expo.presets].filter((p) => p.props.trailArc > 0).sort((a, b) => a.props.trailArc - b.props.trailArc);
  for (let i = 1; i < sorted.length; i++)
    assert.ok(sorted[i].props.trailSamples >= sorted[i - 1].props.trailSamples,
      `"${sorted[i].name}" has a LONGER arc than "${sorted[i - 1].name}" but no more samples — the longer trail will break into beads`);
});

// ── (9) A TRAIL ACTUALLY SMEARS, in pixels ─────────────────────────────────
test("(9) opening the shutter smears the stars (more lit pixels, lower peaks)", () => {
  setParticleTimeOverride(0);
  const instant = render({ twinkle: 0, trailArc: 0, trailSamples: 24 });
  const trailed = render({ twinkle: 0, trailArc: 0.08, trailSamples: 40 });
  setParticleTimeOverride(null);
  const LIT = 24; // above the black night of this fixture
  const litCount = (px) => {
    let n = 0;
    for (let i = 0; i < px.length / 4; i++) if (luma(px, i) >= LIT) n++;
    return n;
  };
  const peak = (px) => {
    let m = 0;
    for (let i = 0; i < px.length / 4; i++) m = Math.max(m, luma(px, i));
    return m;
  };
  const li = litCount(instant), lt = litCount(trailed);
  const total = W * H;
  assert.ok(li > 0, "the instant fixture shows no stars, so this check is measuring nothing");
  // THE SATURATION BOUND, and it is the reason this check is worth its render cost.
  // "More pixels lit" is satisfied just as well by a frame boosted to solid white, and
  // an early normalization did exactly that (90000 of 90000 pixels lit at peak 255) while
  // passing a version of this check that only compared counts. A night sky with trails is
  // still mostly EMPTY SKY, so cap the lit fraction well below saturation.
  assert.ok(lt < total * 0.35,
    `${lt} of ${total} pixels are lit in the trailed frame — the exposure is not smearing the stars, it is flooding the sky (an over-boosted accumulation blows the frame to white)`);
  // A long exposure spreads each star's light along an arc, so MORE pixels carry light.
  // The trap this check exists for: it must spread WITHOUT DIMMING. A star is a point
  // source crossing the pixel, so the film integrates it while it is there — normalize
  // by the sample count instead of by arc length and a trailed frame comes out DARKER
  // than an instant one (measured: 281 lit pixels against 793), which is the opposite of
  // a photograph. Both halves are asserted because either alone is satisfiable wrongly:
  // "more lit pixels" by simply brightening everything, "same peak" by doing nothing.
  assert.ok(lt > li * 1.3,
    `trailing lit ${lt} pixels against the instant frame's ${li} — the shutter is open but nothing smeared (if lt is LOWER, the accumulation is dividing by the sample count and the trail is fading itself out)`);
  // The trail should hold roughly the star's own surface brightness along its length —
  // neither collapsing (the dimming bug) nor blowing out (which a raw sum would do).
  const pi = peak(instant), pt = peak(trailed);
  assert.ok(pt > pi * 0.5,
    `the trailed frame peaks at ${pt.toFixed(1)} against the instant frame's ${pi.toFixed(1)} — the arc is losing more than half the star's brightness, so the exposure is normalizing by samples rather than by arc length`);
  assert.ok(pt <= pi + 1,
    `the trailed frame peaks at ${pt.toFixed(1)} against the instant frame's ${pi.toFixed(1)} — a long exposure must not exceed the star's own brightness, which a raw SUM over samples would`);
  console.log(`      lit px: instant ${li} -> trailed ${lt}   peak luma ${pi.toFixed(1)} -> ${pt.toFixed(1)}`);
});

console.log(`\nPASS: sky twinkle + long exposure (${passed} checks)`);
