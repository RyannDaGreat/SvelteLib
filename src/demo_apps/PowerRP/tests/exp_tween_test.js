/**
 * "Exp Tween" — THE GEOMETRIC SCALAR INTERP MODE, and the camera's zoom coupling
 * (WORKSTREAM BG). Plain node, no framework (suite convention):
 *   node src/demo_apps/PowerRP/tests/exp_tween_test.js
 *
 * The user's ruling, 2026-08-02 night, verbatim across three messages: "its scale
 * should interpolate exponentially… that should be the default for height and
 * width for the camera and well and X and Y too. It's the Mandelbrot. Look at the
 * Mandelbrot interpolation logic. It took a while to get it right… because when a
 * camera zooms in, just like in Mendelbrot, it's gotta look natural", then "Exp
 * Tween", then "\"Exp Tween\"".
 *
 * WHAT THIS PINS, and why each matters:
 *
 *   (1) THE LABEL IS EXACTLY "Exp Tween". The user quoted it twice, which is how
 *       a name gets fixed rather than paraphrased. A test is the only thing that
 *       stops a later tidy-up renaming it to "Exponential".
 *   (2) THE MIDPOINT IS GEOMETRIC. 1 → 100 at alpha 0.5 reads 10, not 50.5. This
 *       is the whole feature in one number: if this passes, the law is log-space.
 *   (3) ENDPOINTS ARE EXACT. The fold calls `applied()` = blend at alpha 1 on
 *       every slide, so a mode that missed its endpoints would rewrite the
 *       document's own stored values in every cached state and every export.
 *   (4) MONOTONICITY. A zoom that overshoots and comes back is the "it curved
 *       around and it was weird" the reference work existed to kill.
 *   (5) THE DEGENERATE FALLBACKS ARE LINEAR AND NEVER NaN. A zero endpoint and a
 *       sign flip are ORDINARY for a camera (the default camera is at x = 0), so
 *       these are the common path, not an exotic one. NaN here would poison a
 *       transform and stop the canvas painting.
 *   (6) THE CAMERA DECLARES THE MODE ON ALL FOUR FRAME LEAVES, in a fresh
 *       document — the ruling's literal ask.
 *   (7) A STORED EXPLICIT MODE IS UNTOUCHED. The default must never overrule an
 *       author who picked something else.
 *   (8) THE ZOOM COUPLING BEATS PER-AXIS EXP AT THE THING IT IS FOR. Asserted as
 *       a MEASUREMENT (does the zoom target stay on screen?), not as a spot
 *       value, because that is the acceptance the user actually stated.
 *   (9) NOTHING ELSE BECAME EXPONENTIAL. The mode is scoped to the camera; an
 *       ordinary widget's x must still tween linearly.
 *
 * DOM-free (core/ + one plugin's pure hook), so it runs in bare node.
 */

import assert from "node:assert/strict";
import { blendApplied } from "../core/deltas.js";
import {
  expLerp, expTweenApplies, EXP_TWEEN_MODE, interpModeLabels, interpModeIds,
  modesForKey, blendUnderMode, interpKeyFor,
} from "../core/interp_modes.js";
import { defaultCameraState, newDocument, CAMERA_EXP_TWEEN_KEYS } from "../core/document.js";
import { interpolateCameraState, cameraZoomLam } from "../plugins/camera.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) THE NAME ──────────────────────────────────────────────────────────────

test('the label is EXACTLY "Exp Tween" (the user quoted it twice)', () => {
  assert.equal(interpModeLabels()[EXP_TWEEN_MODE], "Exp Tween");
  assert.ok(interpModeIds().includes(EXP_TWEEN_MODE), "the mode is registered");
});

// ── (2) THE GEOMETRIC MIDPOINT — the feature in one number ───────────────────

test("1 → 100 at alpha 0.5 reads 10 (geometric mean), NOT the arithmetic ~50", () => {
  assert.equal(expLerp(1, 100, 0.5), 10);
  assert.equal(blendUnderMode(1, 100, 0.5, { key: "w", mode: EXP_TWEEN_MODE }), 10);
  // The contrast that makes the number mean something. (`tween` ROUNDS an
  // integer→integer pair — see the int-rounding test below — so this is 51, not
  // 50.5. The point stands either way: 10 is nowhere near halfway.)
  assert.equal(blendUnderMode(1, 100, 0.5, { key: "w", mode: "tween" }), 51);
});

test("EXP TWEEN DOES NOT INT-ROUND, and that divergence from `tween` is deliberate", () => {
  // core/interpolators.interpolate rounds an integer→integer pair (so an integer
  // property stays integral mid-tween). `expLerp` does NOT, and must not: a
  // geometric path's whole value is its RATIO, and rounding a camera width to
  // whole world units would quantize a deep zoom into visible steps — the frame
  // spends most of a 320x zoom below 100 units wide, where ±0.5 is a percent of
  // the picture. The camera's frame is a continuous world-space rect, not a pixel
  // count, so nothing downstream needs it integral (core/view.fitRectView divides
  // by it).
  assert.equal(blendUnderMode(1, 100, 0.5, { key: "w", mode: "tween" }), 51, "tween rounds");
  assert.equal(expLerp(1, 1000, 0.5), 31.622776601683793, "exp does not round");
  // And a non-integer pair shows the two laws differ by the LAW, not the rounding.
  assert.equal(expLerp(1, 100.0, 0.25), 3.1622776601683795);
});

test("the ratio per unit time is CONSTANT — the definition of the law", () => {
  // Three equal alpha steps over 1 → 1000 must multiply by the same factor (10).
  const at = (t) => expLerp(1, 1000, t);
  const r1 = at(1 / 3) / at(0), r2 = at(2 / 3) / at(1 / 3), r3 = at(1) / at(2 / 3);
  for (const [i, r] of [r1, r2, r3].entries())
    assert.ok(Math.abs(r - 10) < 1e-9, `step ${i} ratio ${r} is not 10`);
});

// ── (3) ENDPOINT EXACTNESS — the fold depends on it ──────────────────────────

test("alpha 0 and alpha 1 are EXACT (the fold folds every slide through this)", () => {
  for (const [a, b] of [[1, 100], [1280, 4], [-1, -100], [0.5, 0.5]]) {
    assert.equal(expLerp(a, b, 0), a, `alpha 0 of ${a}→${b}`);
    assert.equal(expLerp(a, b, 1), b, `alpha 1 of ${a}→${b}`);
  }
});

// ── (4) MONOTONICITY — no overshoot, in either direction ─────────────────────

test("monotone between the endpoints, zooming IN and OUT alike", () => {
  for (const [a, b] of [[1280, 4], [4, 1280], [-1, -100], [100, 1]]) {
    let prev = expLerp(a, b, 0);
    const rising = b > a;
    for (let i = 1; i <= 200; i++) {
      const v = expLerp(a, b, i / 200);
      assert.ok(rising ? v >= prev - 1e-9 : v <= prev + 1e-9,
        `${a}→${b} reversed direction at alpha ${i / 200}: ${prev} → ${v}`);
      prev = v;
    }
  }
});

test("the path never leaves the endpoint interval (no overshoot)", () => {
  for (let i = 0; i <= 100; i++) {
    const v = expLerp(1280, 4, i / 100);
    assert.ok(v <= 1280 + 1e-9 && v >= 4 - 1e-9, `overshoot at alpha ${i / 100}: ${v}`);
  }
});

// ── (5) DEGENERATE ENDPOINTS: LINEAR, DOCUMENTED, NEVER NaN ──────────────────

test("a ZERO endpoint falls back to linear — a geometric path cannot leave zero", () => {
  assert.equal(expTweenApplies(0, 100), false);
  assert.equal(expLerp(0, 100, 0.5), 50, "the linear midpoint");
  assert.equal(expLerp(100, 0, 0.25), 75);
  // And still exact at the endpoints, which is what the fold needs.
  assert.equal(expLerp(0, 100, 0), 0);
  assert.equal(expLerp(0, 100, 1), 100);
});

test("a SIGN FLIP falls back to linear — no real path crosses the origin", () => {
  assert.equal(expTweenApplies(-10, 10), false);
  assert.equal(expLerp(-10, 10, 0.5), 0);
  assert.equal(expLerp(-10, 10, 0.75), 5);
});

test("BOTH-NEGATIVE is NOT degenerate — exact, which a flipped camera needs", () => {
  assert.equal(expTweenApplies(-1, -100), true, "same sign: the ratio is positive");
  assert.equal(expLerp(-1, -100, 0.5), -10, "the geometric mean, below zero");
});

test("NEVER NaN, over a sweep that includes every degenerate pair", () => {
  const values = [-100, -1, -0.001, 0, 0.001, 1, 100];
  for (const a of values)
    for (const b of values)
      for (let i = 0; i <= 10; i++) {
        const v = expLerp(a, b, i / 10);
        assert.ok(Number.isFinite(v), `expLerp(${a}, ${b}, ${i / 10}) = ${v}`);
      }
});

test("a NON-SCALAR pair defers to the ordinary law rather than inventing one", () => {
  // `fade`-on-`x` precedent: a mode picked on a row it cannot describe defers.
  assert.equal(blendUnderMode("a", "b", 0.5, { key: "s", mode: EXP_TWEEN_MODE }), "b",
    "strings switch discretely, as they always have");
  assert.equal(expTweenApplies("a", 10), false);
  assert.equal(expTweenApplies(Infinity, 10), false, "non-finite is not a scalar pair");
  assert.equal(expTweenApplies(NaN, 10), false);
});

// ── THE SELECT OFFERS IT ON NUMERIC ROWS ONLY ────────────────────────────────

test("offered on numeric rows, withheld where it would be a second name for Tween", () => {
  assert.ok(modesForKey("w", 1280).includes(EXP_TWEEN_MODE), "a scalar row offers it");
  assert.ok(!modesForKey("active", false).includes(EXP_TWEEN_MODE), "a boolean has no ratio");
  assert.ok(!modesForKey("type", "rect").includes(EXP_TWEEN_MODE), "a type has no ratio");
  assert.ok(!modesForKey("fill", { type: "material", material: { id: "crt" } }).includes(EXP_TWEEN_MODE),
    "a paint has no ratio");
});

// ── (6) THE CAMERA DEFAULT — the ruling's literal ask ────────────────────────

test("a fresh camera declares Exp Tween on x, y, w AND h", () => {
  const cam = defaultCameraState();
  for (const key of CAMERA_EXP_TWEEN_KEYS)
    assert.equal(cam[interpKeyFor(key)], EXP_TWEEN_MODE, `${key} does not declare the mode`);
  assert.deepEqual(CAMERA_EXP_TWEEN_KEYS, ["x", "y", "w", "h"], "the ruling names these four");
});

test("a NEW DOCUMENT's camera carries the companions (not just the plugin default)", () => {
  const doc = newDocument();
  const cam = Object.values(doc.slides[0].delta.items).find((i) => i.type === "camera");
  for (const key of CAMERA_EXP_TWEEN_KEYS)
    assert.equal(cam[interpKeyFor(key)], EXP_TWEEN_MODE, `${key} missing in a fresh document`);
});

// ── (7) A STORED MODE STILL WINS ─────────────────────────────────────────────

test("an explicitly stored mode is UNTOUCHED — the default never overrules an author", () => {
  // The author picked `step` on the camera's width; it must step, not zoom.
  const state = { w: 100, "w~interp": "step" };
  assert.equal(blendApplied(state, { w: 1 }, 0.5).w, 1, "step must still snap");
  // And picking `tween` back must give the plain linear midpoint (int-rounded).
  const linear = { w: 100, "w~interp": "tween" };
  assert.equal(blendApplied(linear, { w: 1 }, 0.5).w, 51);
  // While the camera's own declared mode gives the geometric one.
  const geo = { w: 100, "w~interp": EXP_TWEEN_MODE };
  assert.equal(blendApplied(geo, { w: 1 }, 0.5).w, 10);
});

// ── (9) THE MODE IS SCOPED TO THE CAMERA ─────────────────────────────────────

test("an ordinary widget's x still tweens LINEARLY (nothing else went exponential)", () => {
  // No companion key stored: a rect's x must fold exactly as it always did,
  // int-rounding and all — this is the byte-identical-legacy promise.
  assert.equal(blendApplied({ x: 1 }, { x: 100 }, 0.5).x, 51);
  assert.equal(blendApplied({ w: 2 }, { w: 8 }, 0.5).w, 5, "arithmetic, not geometric (which would be 4)");
  assert.equal(blendApplied({ x: 1.5 }, { x: 100.5 }, 0.5).x, 51, "a non-integer pair is the plain lerp");
});

// ── (8) THE CAMERA'S ZOOM COUPLING ───────────────────────────────────────────

test("cameraZoomLam: 1 at alpha 0, 0 at alpha 1, NaN for a pure pan", () => {
  assert.equal(cameraZoomLam(100, 1, 0), 1);
  assert.equal(cameraZoomLam(100, 1, 1), 0);
  assert.ok(Number.isNaN(cameraZoomLam(50, 50, 0.5)), "no zoom → no coupling");
  // Zooming out is the exact time-reverse of zooming in.
  assert.ok(Math.abs(cameraZoomLam(1, 100, 0.5) + cameraZoomLam(100, 1, 0.5) - 1) < 1e-12);
});

test("the coupling defers when it has nothing to say, rather than guessing", () => {
  const to = { x: 9, y: 0, w: 1, h: 0.5 };
  assert.deepEqual(interpolateCameraState({ x: 0, y: 0, w: 100, h: 50 }, { ...to, w: 100 }, 0.5), {},
    "no zoom → the per-leaf pan is already right");
  assert.deepEqual(interpolateCameraState({ x: "= 1 + 1", y: 0, w: 100, h: 50 }, to, 0.5), {},
    "an equation-bound frame is the equation's business");
  assert.deepEqual(interpolateCameraState({ x: 0, y: 0, w: 0, h: 50 }, to, 0.5), {},
    "a zero width has no geometric path, so no coupling either");
});

test("the coupling is EXACT at both endpoints", () => {
  const from = { x: 0, y: 0, w: 100, h: 50 }, to = { x: 9, y: 0, w: 1, h: 0.5 };
  assert.deepEqual(interpolateCameraState(from, to, 0), { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(interpolateCameraState(from, to, 1), { x: 9, y: 0, w: 1, h: 0.5 });
});

test("the coupled width is geometric (the mode's own law, applied to the frame)", () => {
  const mid = interpolateCameraState({ x: 0, y: 0, w: 100, h: 50 }, { x: 9, y: 0, w: 1, h: 0.5 }, 0.5);
  assert.equal(mid.w, 10, "the geometric mean of 100 and 1");
  assert.equal(mid.h, 5, "height rides width's OWN lam, so the aspect is one motion");
});

test("THE ACCEPTANCE: a deep zoom's target approaches MONOTONICALLY, never swinging away", () => {
  // The user's stated acceptance is the picture: "when a camera zooms in, just
  // like in Mendelbrot, it's gotta look natural". Natural = the point you are
  // zooming into gets steadily closer to the centre and NEVER retreats.
  //
  // NOT "always on screen": at alpha 0 the target is legitimately 13 half-widths
  // away — that is the authored starting frame, and no interpolation law may
  // change it. The defect this pins is the target moving FARTHER as the zoom
  // proceeds and then snapping back, which is what the reference measured.
  //
  // A 320x zoom onto a point 9000 units out — the case that breaks the naive laws.
  const from = { x: 0, y: 0, w: 1280, h: 720 };
  const target = 9000;
  const to = { x: target - 2, y: 0, w: 4, h: 2.25 };
  const offsetAt = (r) => Math.abs((target - (r.x + r.w / 2)) / (r.w / 2));

  const startOffset = offsetAt(from);
  let prev = Infinity, peak = 0;
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const r = t === 0 ? from : t === 1 ? to : interpolateCameraState(from, to, t);
    const off = offsetAt(r);
    peak = Math.max(peak, off);
    assert.ok(off <= prev + 1e-9,
      `the target swung AWAY at alpha ${t}: ${prev.toFixed(2)} → ${off.toFixed(2)} half-widths`);
    prev = off;
  }
  // The peak is therefore the AUTHORED starting offset and nothing worse: the
  // tween never makes the framing worse than the slide the author drew. The
  // naive laws peak near 286 on this same pair, i.e. 22x the starting offset.
  assert.ok(Math.abs(peak - startOffset) < 1e-9,
    `peak offset ${peak.toFixed(2)} exceeds the authored start ${startOffset.toFixed(2)}`);
  assert.equal(prev, 0, "and it lands exactly on target at alpha 1");

  // AND THE CONTRAST, so this test fails loudly if the coupling is ever removed:
  // per-leaf Exp Tween on the same pair is NOT monotone.
  let naivePeak = 0;
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    naivePeak = Math.max(naivePeak, offsetAt({
      x: expLerp(from.x, to.x, t), w: expLerp(from.w, to.w, t),
    }));
  }
  assert.ok(naivePeak > 50,
    `per-axis exp was expected to swing far off frame (it peaked at ${naivePeak.toFixed(1)}) — ` +
    "if this ever fails, the coupling may no longer be needed and the plugin header's measurement should be redone");
});

console.log(`\n${passed} Exp Tween tests passed`);
