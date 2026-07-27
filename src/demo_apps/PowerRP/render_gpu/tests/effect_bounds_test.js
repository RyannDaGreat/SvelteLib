/**
 * THE EFFECT-SUBSTRATE BOUNDS CONTRACT — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/effect_bounds_test.js
 *
 * ── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ────────────────────────────────────
 * An effect (shadow / bloom / soft edges / inner shadow / blend) renders its widget
 * into an offscreen SUBSTRATE first. handleEffectSubtree sizes that substrate from
 * effectRegion → contentDeviceBounds → opLocalBounds, and an op opLocalBounds cannot
 * bound makes the whole thing fall back to THE WHOLE SURFACE.
 *
 * `text` and `mermaidVector` had no case there, so a drop shadow on a caption
 * allocated and processed a full-canvas offscreen for a few lines of type. Measured
 * at 960×540 (.frenzy/render_cost/probe_region_cost.js): 518,400 substrate px and
 * 137.0 ms for a 240×60 caption, against 40,836 px and 16.6 ms for the SAME shadow on
 * a rect of the same size. Worse, it scaled with the CANVAS instead of the widget —
 * 34.4 / 137.0 / 311.0 ms at 480×270 / 960×540 / 1440×810 — so the cost of a caption's
 * shadow grew every time the window did. Soft edges, which allocate twice, measured
 * 3710 ms for one caption.
 *
 * So this suite pins the property that actually distinguishes bounded from unbounded,
 * with no reference render to drift against:
 *
 *   1. NON-GROWTH. Hold the widget's device geometry fixed and GROW the canvas. A
 *      bounded substrate stays the same size; an unbounded one tracks the canvas.
 *      This is the defect stated as an invariant.
 *   2. SUBSTRATE INVARIANCE (a PIXEL check, not a cost one). The same two renders
 *      must agree pixel-for-pixel over the overlap. They cannot when the substrate is
 *      the canvas: the substrate changes size, and Skia's rasterization is not
 *      invariant under that (measured separately in
 *      .frenzy/render_cost/probe_rerender_shift.js — 419 of 160,000 bytes on a curved
 *      antialiased rim). So this assertion FAILS before the bound exists and holds
 *      after, which is exactly what a regression gate needs.
 *   3. NOT COLLAPSED. The substrate must still be at least as large as the widget's
 *      own device ink, or an under-bound would be "cheap" by clipping the effect away.
 *
 * Full pixel identity against the pre-bound painter was proven separately over 35
 * subject × effect combinations (0 differing bytes):
 * .frenzy/render_cost/probe_text_bounds_identity.js, which generates its reference by
 * removing ONLY those two switch cases from paint_skia.js.
 *
 * `mermaidVector` is exercised from a SYNTHETIC op, because a mermaid widget cannot
 * rasterize its diagram in bare node (MathJax/mermaid need a DOM) and emits only its
 * cropSubtree frame there — an unsynthesized test would silently prove nothing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { paintIR } from "../skia/paint_skia.js";
import { rect, text, mermaidVector, effectSubtree, pushTransform, popTransform } from "../ir.js";
import { committedFaces, FALLBACK_FACES } from "../fonts.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts");

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const SMALL = { w: 480, h: 270 };
const LARGE = { w: 960, h: 540 };   // the SAME view, so the widget lands on the same device pixels
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const BACKGROUND = "#f4f4f0";
// The widget sits well inside SMALL, so growing the canvas adds only empty pixels.
const BOX = { x: 60, y: 60, w: 240, h: 90 };
const SHADOW = { dx: 12, dy: 16, blur: 18, color: "#000000", opacity: 0.7 };
// ir.js computes an effectSubtree's own halo `margin` from its effects; the shadow
// above reaches offset + 3σ, and this mirrors that so the fixture is self-consistent.
const SHADOW_MARGIN = Math.hypot(SHADOW.dx, SHADOW.dy) + SHADOW.blur * 3;

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

/** Query→build. Backdrop content the effected widget sits over (a curved antialiased
 *  rim is what makes assertion 2 bite). */
const backdrop = () => [
  pushTransform(IDENTITY),
  rect({ x: 20, y: 20, w: 200, h: 140, fill: "#50dcc8" }),
  rect({ x: 150, y: 100, w: 180, h: 120, fill: "#ffd246" }),
  popTransform(),
];

/** Query→build. `inner` (local ops) wrapped in a shadowed effectSubtree over BOX. */
function shadowed(inner) {
  return [
    ...backdrop(),
    effectSubtree({ ...BOX, shadow: SHADOW, margin: SHADOW_MARGIN, content: [pushTransform(IDENTITY), ...inner, popTransform()] }),
  ];
}

/** Query→build. A synthetic mermaidVector op — two stroked paths and one label,
 *  fitted into BOX. Synthetic because bare node cannot render a real diagram. */
function mermaidOp() {
  return mermaidVector({
    ref: "m1", x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h,
    viewBox: { minX: 0, minY: 0, w: 120, h: 45 },
    paths: [
      { d: "M4 4 L116 4 L116 41 L4 41 Z", fill: "#ffffff", stroke: "#334155", strokeWidth: 2 },
      { d: "M10 22 L110 22", fill: null, stroke: "#ef4444", strokeWidth: 3 },
    ],
    texts: [{ text: "node", x: 20, y: 10, size: 10, color: "#0f172a", bold: false, font: "system" }],
  });
}

const SUBJECTS = {
  text_caption: [text({ text: "Bounded ink", x: BOX.x, y: BOX.y, size: 36, color: "#101828", boxW: BOX.w, boxH: BOX.h })],
  text_rich_mixed: [text({
    text: "Big small", x: BOX.x, y: BOX.y, size: 24, color: "#101828", boxW: BOX.w, boxH: BOX.h,
    rich: { runs: [{ text: "Big ", size: 48, color: "#101828" }, { text: "small", size: 18, color: "#101828" }], paras: [{}] },
  })],
  mermaid_synthetic: [mermaidOp()],
  rect_control: [rect({ ...BOX, fill: "#ffffff" })],
};

/**
 * Command. Paints `commands` on a fresh `size` software surface; returns the pixels
 * and the LARGEST offscreen surface paintIR allocated (the substrate — not the sum,
 * because an effect allocates helpers of its own size and the question here is how
 * big the substrate got).
 */
function render(commands, size) {
  let maxOffscreen = 0;
  const makeSurface = (w, h) => { maxOffscreen = Math.max(maxOffscreen, w * h); return CanvasKit.MakeSurface(w, h); };
  const surface = CanvasKit.MakeSurface(size.w, size.h);
  if (!surface) throw new Error("effect_bounds_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), commands, VIEW, { fontCollection, background: BACKGROUND, makeSurface });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: size.w, height: size.h, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return { px, maxOffscreen };
}

/** Pure function. Differing bytes between the SMALL frame and the top-left SMALL
 * region of the LARGE frame.
 * @example overlapDiff(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 4]), {w: 1, h: 1}, {w: 1, h: 1}) // 0
 */
function overlapDiff(smallPx, largePx, small, large) {
  let diff = 0;
  for (let y = 0; y < small.h; y++) {
    for (let x = 0; x < small.w * 4; x++) {
      if (smallPx[y * small.w * 4 + x] !== largePx[y * large.w * 4 + x]) diff++;
    }
  }
  return diff;
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

console.log(`\n${"subject".padEnd(20)}${"substrate px".padStart(14)}${"vs canvas".padStart(22)}${"overlap diff".padStart(14)}`);
for (const [name, inner] of Object.entries(SUBJECTS)) {
  const commands = shadowed(inner);
  const small = render(commands, SMALL);
  const large = render(commands, LARGE);
  const inkDevicePx = BOX.w * BOX.h; // the widget's own box; the substrate must cover at least this
  console.log(`${name.padEnd(20)}${String(small.maxOffscreen).padStart(14)}${`${SMALL.w * SMALL.h} / ${LARGE.w * LARGE.h}`.padStart(22)}${String(overlapDiff(small.px, large.px, SMALL, LARGE)).padStart(14)}`);

  test(`${name}: the effect substrate does NOT grow with the canvas`, () => {
    assert.equal(small.maxOffscreen, large.maxOffscreen,
      `${name}: substrate ${small.maxOffscreen} px at ${SMALL.w}×${SMALL.h} but ${large.maxOffscreen} px at ${LARGE.w}×${LARGE.h} — the op is reporting UNBOUNDED bounds, so the effect pays for every canvas pixel instead of its own ink`);
    assert.ok(small.maxOffscreen < SMALL.w * SMALL.h,
      `${name}: substrate ${small.maxOffscreen} px is the whole ${SMALL.w}×${SMALL.h} canvas — not bounded at all`);
  });

  test(`${name}: growing the canvas leaves the overlap PIXEL-IDENTICAL`, () => {
    const diff = overlapDiff(small.px, large.px, SMALL, LARGE);
    assert.equal(diff, 0,
      `${name}: ${diff} bytes differ between the ${SMALL.w}×${SMALL.h} and ${LARGE.w}×${LARGE.h} renders of the same device geometry — the effect substrate is following the canvas, so the widget is being rasterized into a different-sized offscreen`);
  });

  test(`${name}: the substrate still covers the widget's own ink`, () => {
    assert.ok(small.maxOffscreen >= inkDevicePx,
      `${name}: substrate ${small.maxOffscreen} px is smaller than the widget's ${inkDevicePx} px box — a bound this tight would be clipping the effect, not optimizing it`);
  });
}

console.log(`\n${passed} effect-bounds checks passed`);
