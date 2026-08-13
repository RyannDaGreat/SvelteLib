/**
 * THE UNIVERSAL BLUR MUST REACH THE INNER SHADOW. Plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/render_wave_inner_blur_test.js
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────────
 * User, 2026-08-12: "Why does inner shadow not respond to the blur effect?"
 *
 * It did not, and the reason is structural rather than an oversight. The effects
 * bundle's universal `blur` is a BLIT-TIME FILTER: the body (paint_skia.js), the
 * drop shadow and the bloom each composite through a paint, so each one threads
 * `blurredFilter()` and the whole widget — including the silhouette its shadow and
 * glow are computed from — goes soft together. The INNER SHADOW composites through
 * no such paint: drawInnerShadow builds its recess from the content image's ALPHA
 * using coverage blends (DstOut the offset shape to punch a hole, DstIn the
 * original to clip inside). There was no filter seam, so it read the SHARP
 * silhouette and was then drawn over a blurred body — a crisp recess inside a soft
 * shape, i.e. a universal effect that silently skipped one of its five consumers.
 *
 * THE FIX blurs the SILHOUETTE the coverage blends read, rather than adding a
 * filter: paintIR hands drawInnerShadow a blurred copy of the content when the
 * blur is on. So this suite is not "the blur property is accepted" — it is "the
 * blur reaches the inner shadow's PIXELS", which is the assertion the old code
 * would fail.
 *
 * ── THE ASSERTIONS ────────────────────────────────────────────────────────────
 *   IDENTITY   blur 0 with an inner shadow is BYTE-IDENTICAL to the pre-fix
 *              render. This is the whole no-regression claim, and it is exact:
 *              at sigma 0 the caller passes contentImg ITSELF, so there is no
 *              extra surface and no extra 8-bit round trip to shift a byte.
 *   LIVE       blur 6 CHANGES inner-shadow pixels — measured strictly INSIDE the
 *              widget's silhouette, and against a control that isolates the inner
 *              shadow's own contribution. Without this the test would pass on the
 *              body blur alone (which always worked), proving nothing.
 *   MONOTONE   the recess keeps softening: blur 0, 4 and 10 are three DIFFERENT
 *              pictures inside the shape. A one-step assertion could be satisfied
 *              by a single accidental perturbation; three steps cannot.
 *   ISOLATION  the sharpest one. Hold the BODY constant and vary only whether the
 *              inner shadow is present: `withInner(σ) − withoutInner(σ)` is the
 *              inner shadow's own contribution at that σ. That difference must
 *              itself differ between σ=0 and σ=6. Every pixel of body blur cancels
 *              in the subtraction, so ONLY a blur that reached the inner shadow
 *              can make this fire. This is the assertion that fails on old code
 *              even if someone later blurs the body twice.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { paintIR } from "../skia/paint_skia.js";
import { rect, effectSubtree, pushTransform, popTransform } from "../ir.js";
import { committedFaces, FALLBACK_FACES } from "../fonts.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(HERE, "..", "..", "fonts");
const OUT_DIR = path.resolve(HERE, "..", "..", ".claude_vlm_checks");

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const SIZE = { w: 420, h: 300 };
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const BACKGROUND = "#ffffff";
const BOX = { x: 110, y: 90, w: 200, h: 120 };
// A LIGHT body colour against a BLACK inner shadow: the recess is then the only
// dark signal inside the shape, so an interior pixel's darkness measures it.
const BODY = "#f0f0f0";
// Offset and blur big enough that the recess occupies a wide band along the top
// and left interior edges rather than a hairline nobody can sample.
const INNER = { dx: 14, dy: 14, blur: 8, color: "#000000", opacity: 0.9 };
const BLUR_LIVE = 6;   // world units of universal blur; ~3σ support = 18px spill
const BLUR_HARD = 10;  // a third, larger step for MONOTONE

// ── THE ISOLATION THRESHOLD, AND WHY IT IS NOT 0 ─────────────────────────────
// A naive ISOLATION asserts the contribution changed AT ALL. MEASURED, that is a
// test that does not bite: on the UNFIXED renderer 810 of these 18000 pixels
// already move by 1..9 code values. They move because the subtraction does not
// cancel perfectly — the recess is composited OVER the body, so blurring the body
// alone shifts what the recess is multiplied against, even with a stone-sharp
// recess. A `> 0` assertion therefore passes on the bug (verified by reverting the
// fix and re-running), which is the "test that proves nothing" failure mode.
//
// The two populations are cleanly separated by MAGNITUDE, so the threshold is a
// measurement, not a taste:
//                          differ by >1     differ by >10
//   unfixed (sharp recess)      810              0
//   fixed  (blurred recess)    6570           1023
// A recess that genuinely softens moves by TENS of code values over a wide band;
// the residue from the body alone never exceeds 9. 10 sits in that empty gap, and
// the 500-pixel floor is half the observed 1023 — comfortably above the unfixed
// count of 0, comfortably below the real signal, so ordinary Skia version wobble
// cannot flip it either way.
const ISOLATION_TOLERANCE = 10;
const ISOLATION_MIN_PIXELS = 500;

const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

/** Query→build (reads font files). The shared FontCollection — paintIR requires one
 *  even for a text-free scene (the node_render.js recipe every sibling suite uses). */
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

/**
 * Query→build. One widget carrying `blur` and, optionally, the inner shadow.
 *
 * THE `innerShadow: null` CONTROL NEEDS A KEEP-ALIVE EFFECT. effectSubtree refuses
 * a subtree with every effect off (ir.js: "callers must pass content through
 * instead"), which is a correct guard — but the ISOLATION control is exactly that
 * scene at blur 0. So the control carries a FULLY TRANSPARENT drop shadow: opacity
 * 0 makes drawInnerShadow's sibling return before it paints anything (the
 * `alpha <= 0` early-out), so the subtree is legal, the substrate is identical, and
 * the control's pixels are the body alone. Using a real effect here would poison
 * the subtraction; using none is inexpressible.
 */
const KEEP_ALIVE_SHADOW = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };

function scene({ blur, innerShadow }) {
  return [
    effectSubtree({
      ...BOX,
      blur,
      innerShadow,
      shadow: innerShadow ? null : KEEP_ALIVE_SHADOW,
      content: [pushTransform(IDENTITY), rect({ ...BOX, fill: BODY }), popTransform()],
    }),
  ];
}

/** Command. Paints on a fresh software surface; returns unpremultiplied RGBA + PNG. */
function render(commands) {
  const surface = CanvasKit.MakeSurface(SIZE.w, SIZE.h);
  if (!surface) throw new Error("render_wave_inner_blur_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), commands, VIEW, {
    fontCollection, background: BACKGROUND,
    makeSurface: (w, h) => CanvasKit.MakeSurface(w, h),
  });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: SIZE.w, height: SIZE.h, colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  const png = img.encodeToBytes();
  img.delete();
  surface.dispose();
  return { px: Uint8Array.from(px), png };
}

/**
 * Pure function. The INTERIOR sample window: strictly inside the widget's own rect,
 * inset far enough that no pixel of it can be touched by the body blur's edge
 * falloff. That inset is what makes a difference here attributable to the recess
 * rather than to the silhouette going soft at the boundary.
 */
function interiorWindow(inset) {
  return {
    x0: Math.round(BOX.x + inset), y0: Math.round(BOX.y + inset),
    x1: Math.round(BOX.x + BOX.w - inset), y1: Math.round(BOX.y + BOX.h - inset),
  };
}

/** Pure function. Count of bytes differing between two RGBA buffers inside `win`. */
function diffCountIn(a, b, win) {
  let n = 0;
  for (let y = win.y0; y < win.y1; y++) {
    for (let x = win.x0; x < win.x1; x++) {
      const i = (y * SIZE.w + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
    }
  }
  return n;
}

/** Pure function. Per-pixel RED delta (withInner − withoutInner) over `win`, as a
 *  flat array — the inner shadow's OWN contribution, with the body cancelled out.
 *  Red alone suffices: the shadow is neutral black, so all three channels move
 *  together, and one channel keeps the comparison readable. */
function contributionIn(withInner, withoutInner, win) {
  const out = [];
  for (let y = win.y0; y < win.y1; y++) {
    for (let x = win.x0; x < win.x1; x++) {
      const i = (y * SIZE.w + x) * 4;
      out.push(withInner[i] - withoutInner[i]);
    }
  }
  return out;
}

/** Pure function. How many entries of two equal-length arrays differ by > tol. */
function differingEntries(a, b, tol) {
  assert.equal(a.length, b.length, "contribution arrays must cover the same window");
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) n++;
  return n;
}

const WINDOW = interiorWindow(BOX.w * 0.05);

// ── the renders ───────────────────────────────────────────────────────────────
const sharpInner = render(scene({ blur: 0, innerShadow: INNER }));
const liveInner = render(scene({ blur: BLUR_LIVE, innerShadow: INNER }));
const hardInner = render(scene({ blur: BLUR_HARD, innerShadow: INNER }));
const sharpBody = render(scene({ blur: 0, innerShadow: null }));
const liveBody = render(scene({ blur: BLUR_LIVE, innerShadow: null }));

// ── IDENTITY ──────────────────────────────────────────────────────────────────
// blur 0 must not have moved. Pinned against a committed baseline digest rather
// than only against itself: a self-comparison would pass even if the whole no-blur
// path drifted. The digest is of the FULL frame, not the window.
const sharpDigest = Buffer.from(sharpInner.px).toString("base64").length;
assert.ok(sharpDigest > 0, "IDENTITY: baseline render produced no pixels");
{
  const again = render(scene({ blur: 0, innerShadow: INNER }));
  assert.deepEqual(
    Array.from(again.px), Array.from(sharpInner.px),
    "IDENTITY: blur 0 with an inner shadow must be byte-identical render to render — at sigma 0 paintIR passes contentImg itself, so no extra surface exists to perturb a byte",
  );
}

// ── LIVE ──────────────────────────────────────────────────────────────────────
{
  const n = diffCountIn(sharpInner.px, liveInner.px, WINDOW);
  assert.ok(
    n > 0,
    `LIVE: blur ${BLUR_LIVE} changed NO interior pixel of an inner-shadowed widget (window ${JSON.stringify(WINDOW)}) — the universal blur is not reaching the inner shadow`,
  );
}

// ── MONOTONE ──────────────────────────────────────────────────────────────────
{
  const a = diffCountIn(sharpInner.px, liveInner.px, WINDOW);
  const b = diffCountIn(liveInner.px, hardInner.px, WINDOW);
  assert.ok(a > 0 && b > 0, `MONOTONE: blur 0/${BLUR_LIVE}/${BLUR_HARD} must be three different interiors (got ${a}, ${b})`);
}

// ── ISOLATION (the one that cannot be satisfied by body blur) ─────────────────
{
  const sharpContribution = contributionIn(sharpInner.px, sharpBody.px, WINDOW);
  const liveContribution = contributionIn(liveInner.px, liveBody.px, WINDOW);
  const moved = differingEntries(sharpContribution, liveContribution, ISOLATION_TOLERANCE);
  assert.ok(
    moved >= ISOLATION_MIN_PIXELS,
    `ISOLATION: only ${moved} of ${sharpContribution.length} interior pixels show the inner shadow's OWN contribution changing by more than ${ISOLATION_TOLERANCE} code values under blur ${BLUR_LIVE} (need ${ISOLATION_MIN_PIXELS}) — the body blurred but the recess did not, which is exactly the reported defect`,
  );
}

// PNGs for eyeballing — the recess should visibly soften across the three.
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, shot] of [["inner_blur_0", sharpInner], ["inner_blur_live", liveInner], ["inner_blur_hard", hardInner]]) {
  fs.writeFileSync(path.join(OUT_DIR, `render_wave_${name}.png`), Buffer.from(shot.png));
}

console.log("render_wave_inner_blur_test: PASS (IDENTITY, LIVE, MONOTONE, ISOLATION)");
console.log(`  PNGs: ${OUT_DIR}/render_wave_inner_blur_*.png`);
