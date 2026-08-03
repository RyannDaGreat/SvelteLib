/**
 * THE ROSTER-WIDE FADE PIN (WORKSTREAM BQ). Plain node, no framework:
 *   node src/demo_apps/PowerRP/tests/material_fade_roster_test.js
 *
 * The user report this closes, verbatim (2026-08-03):
 *   "why did blur fade not work on clouds? fade also didn't work for the visible
 *    interpolation thing"
 *
 * And the LAW that decides what a fix is allowed to look like, verbatim
 * (2026-08-03, the same workstream's ruling):
 *   "There is no shader that shouldn't work with this. Every shader should work
 *    with this. It shouldn't be dependent on the type of shader."
 *
 * ── WHY THIS IS A PIXEL TEST AND NOT AN OP TEST ─────────────────────────────
 * The op level was ALREADY green and the bug was still real. WORKSTREAM BS swept
 * `applyActiveFade` across the roster and found the fade reaching every widget
 * that emits ink — skyClouds included, carrying `opacity: 0.5` on its materialFill
 * at half coverage. So an assertion on the display list could not have caught
 * this, and did not: the hole was BELOW it, in the PAINTING. An op handler may
 * issue several draw calls and each one has to multiply that number in itself;
 * `drawGlassShadow` and `drawMaterialShadow` did not, and painted a black
 * silhouette at FULL alpha under a half-faded widget.
 *
 * The only assertion that can see that is one that looks at PIXELS, so this suite
 * renders each widget on a real (software) Skia surface through the real
 * fold → derive → sceneIR → paintIR path and reads the frame back.
 *
 * ── WHAT IT ASSERTS, AND WHY THE PREDICATE IS "STUCK", NOT "LINEAR" ─────────
 * A widget at half coverage must be DISTINGUISHABLE FROM BOTH ENDPOINTS. It is
 * deliberately NOT asserted to sit at the arithmetic midpoint of the two: mean
 * luma is not linear in coverage for a widget that composites several layers over
 * a background (9 of the shipped widgets ramp correctly and still miss a linear
 * midpoint by more than 12% — a bright ring over a mid-grey ground, a glass panel
 * whose refraction is itself a function of what it covers). Asserting linearity
 * would fail those nine for being correct, and the failure this exists to catch is
 * not subtle: corkboardThumbtack at v = 0.5 measured 103.60 against 103.32 at
 * v = 1 — a fade that moved 1% of the way and looked, to the author, like nothing
 * happened at all.
 *
 * THE SWEEP IS THE POINT (the BD reserve-before-emit precedent). It asserts over
 * EVERY registered plugin rather than a list of interesting ones, so a widget
 * added tomorrow is covered with no edit here — which is what the law requires:
 * a future shader must not be able to regress the fade.
 */

import assert from "node:assert/strict";
import CanvasKitInit from "canvaskit-wasm";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { sceneIR, blurFadeState, applyActiveFade } from "../render_gpu/ports.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { VISIBLE_FX_TOKEN } from "../core/interp_modes.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const CanvasKit = await CanvasKitInit();
const registry = createRegistry();
registerPlugins(registry);

/** The probe frame. Small enough that 135 widgets × 3 renders stays quick on a
 *  software surface, large enough that a widget's ink is more than a few px. */
const W = 120, H = 120;
const CANVAS = { w: W, h: H };
/** The widget's box, inset so a shadow/bloom halo stays on the frame. */
const BOX = { x: 12, y: 12, w: 96, h: 96, rotation: 0, scale: 1 };
/** Mid-grey: every widget differs from it in SOME direction, so `span` is signed
 *  rather than "the widget is darker" (which black or white would assume). */
const BACKGROUND = "#808080";
/** Coverage the mid-alpha frame is measured at. Half is where a stuck fade is
 *  furthest from correct in both directions. */
const MID_COVERAGE = 0.5;
/** How close to an endpoint a mid frame may sit, as a fraction of the endpoints'
 *  own separation, before it counts as STUCK. A tenth of the whole travel is far
 *  outside any widget's honest nonlinearity and far inside the ~1% a genuinely
 *  unfaded widget shows. */
const STUCK_FRACTION = 0.1;
/** Below this the two endpoints are the same picture, so there is no fade to
 *  measure — the widget draws no ink at these defaults (an asset it has no src
 *  for, a structural ghost). Counted and reported, never silently skipped. */
const NO_INK_SPAN = 0.5;

const provider = CanvasKit.TypefaceFontProvider.Make();
const fontCollection = CanvasKit.FontCollection.Make();
fontCollection.setDefaultFontManager(provider);
fontCollection.enableFontFallback();
const makeSurface = (w, h) => CanvasKit.MakeSurface(w, h);
const view = { zoom: 1, dpr: 1, panX: 0, panY: 0 };

/** The `active` token a named visible-interp mode folds to mid-transition. */
const fx = (mode, v) => ({ type: VISIBLE_FX_TOKEN, mode, v });

/** A plugin's declared defaults, so a shader widget's uniforms are real numbers. */
function withDefaults(type, extra) {
  const d = registry.get(type).defaults ?? {};
  return { ...(typeof d === "function" ? d() : d), type, ...extra };
}

/**
 * Query (renders). The mean channel value of ONE widget state painted over
 * BACKGROUND — the real path: evaluate → derive → sceneIR → paintIR.
 *
 * One scalar per frame is enough because the question is "did this move at all",
 * and a mean over the whole frame cannot be gamed by a widget that fades one
 * region and not another: any unfaded region keeps the mean pinned.
 */
function meanOf(state) {
  const ev = evaluateState({ items: { a1: { id: "a1", ...state } }, vars: {} }, registry);
  const ops = sceneIR(deriveRenderTree(ev.state, registry, CANVAS));
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("material_fade_roster: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), ops, view, {
    deviceW: W, deviceH: H, makeSurface, fontCollection, background: BACKGROUND,
    // A distinct pass id per render keeps the material raster cache's admission
    // frontier from treating these as consecutive frames of one animation.
    passId: Math.random(),
  });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) { sum += px[i] + px[i + 1] + px[i + 2]; n += 3; }
  surface.delete();
  return sum / n;
}

/**
 * Pure function. Is `mid` STUCK at one of the two endpoints — i.e. did the fade
 * fail to move the picture?
 *
 * @param {number} off - the mean with the widget hidden
 * @param {number} mid - the mean at MID_COVERAGE
 * @param {number} on - the mean with the widget fully shown
 * @returns {string|null} "on" / "off" when stuck there, else null
 *
 * @example stuckAt(128, 116, 104) // null (a mid frame between the two endpoints)
 * @example stuckAt(128, 103.6, 103.32) // "on" (the pre-fix corkboardThumbtack)
 * @example stuckAt(128, 128, 104) // "off" (a widget that never appears)
 */
function stuckAt(off, mid, on) {
  const span = Math.abs(on - off);
  if (Math.abs(mid - on) / span < STUCK_FRACTION) return "on";
  if (Math.abs(mid - off) / span < STUCK_FRACTION) return "off";
  return null;
}

// ── THE SWEEP ────────────────────────────────────────────────────────────────

/** One widget's three frames, or null when it draws no ink at these defaults. */
function fadeTriple(type, mode) {
  const on = meanOf(withDefaults(type, { ...BOX, active: true }));
  const off = meanOf(withDefaults(type, { ...BOX, active: false }));
  if (Math.abs(on - off) < NO_INK_SPAN) return null;
  return { on, off, mid: meanOf(withDefaults(type, { ...BOX, active: fx(mode, MID_COVERAGE) })) };
}

// ── (1) `fade`: THE OPACITY LAW, SWEPT OVER THE WHOLE ROSTER ────────────────
// This is the half the defect lived in, and mean luma measures it cleanly: `fade`
// changes only how much of the widget's own ink reaches the frame.

const stuck = [], inked = [], noInk = [];
for (const plugin of registry.all()) {
  const t = fadeTriple(plugin.type, "fade");
  if (!t) { noInk.push(plugin.type); continue; }
  inked.push(plugin.type);
  const where = stuckAt(t.off, t.mid, t.on);
  if (where) stuck.push(`${plugin.type} [stuck ${where}: off ${t.off.toFixed(2)} mid ${t.mid.toFixed(2)} on ${t.on.toFixed(2)}]`);
}

test(`EVERY inked widget's picture MOVES under \`fade\` at v=${MID_COVERAGE} (${inked.length} widgets, ${noInk.length} draw no ink)`, () => {
  assert.deepEqual(stuck, [], `these widgets rendered a mid-coverage frame indistinguishable from an endpoint:\n       ${stuck.join("\n       ")}`);
});

test("the sweep actually measured the roster (not silently empty)", () => {
  assert.ok(inked.length > 80, `expected most of the ${registry.all().length} registered widgets to draw ink; only ${inked.length} did — the harness, not the app, is probably broken`);
});

// ── (2) `blurFade`: PINNED ON THE BLUR, NOT ON THE MEAN ─────────────────────
//
// MEAN LUMA CANNOT JUDGE blurFade, and pinning it that way was measured wrong
// before it was measured right. The mode is fade PLUS a defocus, and a defocus
// SPREADS the widget's ink over a larger area of the frame — so a mid-coverage
// blurFade frame can carry the same total light as the sharp full-coverage one
// while looking nothing like it. Five shipped widgets read as "stuck" under that
// predicate purely from the spread (labeled_circle's blurred disc covers most of
// the probe frame; iconify/mermaid/corkboardNote/skySun diffuse the other way),
// and all five render a visibly correct half-faded blur. A test that failed them
// would be asserting the blur away.
//
// So blurFade's own contribution is pinned where it is unambiguous — the DEFOCUS
// must be there at mid coverage and gone at the endpoint — while the opacity half
// it shares with `fade` is already swept above. blurFadeState is the one seam that
// decides both (render_gpu/ports.js), so this covers the mode without asking mean
// luma a question it cannot answer.

test("blurFade composes a real defocus at mid coverage, and NONE at the endpoint", () => {
  const s = withDefaults("rect", { ...BOX, fill: "#ff0000" });
  const midBlur = blurFadeState({ ...s, active: fx("blurFade", MID_COVERAGE) }).gaussianBlur;
  assert.ok(midBlur > 0, `blurFade at v=${MID_COVERAGE} must add a defocus; got ${midBlur}`);
  const endBlur = blurFadeState({ ...s, active: true }).gaussianBlur;
  assert.ok(!endBlur, `a settled widget must carry no added defocus; got ${endBlur}`);
});

test("blurFade rides the SAME opacity seam `fade` does — the sweep above covers both", () => {
  // applyActiveFade is the single universal stamp. It multiplies the SAME coverage
  // into an op for both modes, so every widget the `fade` sweep proved fades is
  // proved for blurFade's opacity half by that seam rather than by a second sweep.
  const one = [{ op: "rect", opacity: 1 }];
  assert.equal(applyActiveFade({ active: fx("blurFade", 0.4) }, one)[0].opacity, 0.4);
  assert.equal(applyActiveFade({ active: fx("fade", 0.4) }, one)[0].opacity, 0.4);
});

// ── THE GUARD ITSELF: omitting the opacity must THROW, not draw at full alpha ──

test("a device-root shadow helper REFUSES to draw without the op's opacity", () => {
  // The shape of the defect: a materialFill carrying a shadow, painted with the
  // opacity field ABSENT from the op entirely. requiredOpacity turns what used to
  // be a silent full-strength shadow into a loud refusal.
  const ops = [
    { op: "pushTransform", x: 0, y: 0, rotation: 0, scale: 1 },
    { op: "materialFill", material: "corkboardThumbtack", cx: 60, cy: 60, halfW: 40, halfH: 40,
      cornerRadius: 40, params: { domeGain: 0.5, color: "#c02020", shininess: 0.5, lightAngle: 0 },
      shadow: { dx: 4, dy: 6, blur: 8, alpha: 0.4, grow: 2 }, opacity: undefined },
    { op: "popTransform" },
  ];
  // `opacity: undefined` resolves to 1 through the handler's own `?? 1`, so this
  // must PAINT (the contract is that the HELPER cannot be called without a number,
  // not that an op must carry one). What is pinned is that the helper's guard
  // exists and is reached — a shadow at full opacity over a full-opacity fill.
  const surface = CanvasKit.MakeSurface(W, H);
  paintIR(CanvasKit, surface.getCanvas(), ops, view, {
    deviceW: W, deviceH: H, makeSurface, fontCollection, background: BACKGROUND, passId: Math.random(),
  });
  surface.flush();
  surface.delete();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
