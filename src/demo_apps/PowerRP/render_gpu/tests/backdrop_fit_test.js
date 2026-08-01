/**
 * THE ASK-VS-GOT LAW FOR BACKDROP MATERIALS — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/backdrop_fit_test.js
 *
 * ── THE LAW ───────────────────────────────────────────────────────────────────
 *
 *   the size a backdrop's offscreen is ALLOCATED at and the scale its sampleMatrix
 *   is built from MUST come from the same number.
 *
 * They are both derived from `backdropScale` in paint_skia.js glassBackdropImages.
 * But every surface factory CLAMPS an oversized request rather than failing it
 * (render_gpu/skia/browser_surface.js, web/gpuService.js, both via
 * core/clip.js clampSurfaceSize), so past the ceiling the two numbers part company:
 * the texture is narrower than the matrix claims, the shader samples off its end,
 * and TileMode.Clamp smears the last column across everything beyond. Silently,
 * because a clamp is not an error. The sibling instance in the PDF raster path is
 * pinned by render_gpu/tests/pdf_raster_fit_test.js; this is the other half, and
 * core/clip.js rasterFitFactor is the one number both now derive from.
 *
 * ── WHY THIS IS NOT A PATHOLOGICAL CASE (R6-15.1, the user's report: "move it
 *    toward the edge and only a fraction renders") ─────────────────────────────
 *
 * `metaballs` is the ONE material that both declares no `maxSampleReach` — so its
 * backdrop region is the WHOLE device surface — and defaults `backdropScale` to
 * 1.5, where every other material defaults to 1. It therefore asks for
 * deviceW·1.5 px, which passes MAX_SURFACE_DIM at 5461 device px: an ordinary
 * maximised HiDPI window, no zoom and no unusual document required.
 *
 * MEASURED at HEAD before the fix, at exactly that size (5600x200, the widget at
 * the right edge): 31,523 differing bytes, max channel delta 213, a contiguous band
 * whose first differing column is 5447 against a predicted 8192/1.5 = 5461 — the
 * 14 px are the refraction's own outward reach. At `backdropScale: 1` the same
 * scene differs by 0 bytes, which is what identifies the resolution factor rather
 * than the widget as the trigger.
 *
 * ── WHY BYTE EQUALITY IS THE RIGHT ASSERTION HERE ─────────────────────────────
 *
 * Unlike material_reach_test.js, both sides of this comparison render the SAME
 * scene into the SAME sized offscreen through the SAME code path — the only
 * difference is whether the factory was allowed to clamp. A correct fix makes the
 * request fit, so the clamp never bites and the two runs are identical to the byte.
 * No rasterizer tolerance is needed or wanted.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { paintIR } from "../skia/paint_skia.js";
import { deserialize, repairedDocument, foldState } from "../../core/document.js";
import { evaluateState } from "../../core/expressions.js";
import { createRegistry } from "../../core/registry.js";
import { createCommands } from "../../core/commands.js";
import { registerAll } from "../../plugins/index.js";
import { cameraRect } from "../../core/derive.js";
import { fitRectView } from "../../core/view.js";
import { cameraFrameIR } from "../../web/cameraFrame.js";
import { committedFaces, FALLBACK_FACES } from "../fonts.js";
import { clampSurfaceSize, rasterFitFactor, MAX_SURFACE_DIM } from "../../core/clip.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts");

// The frame is WIDE AND SHORT on purpose: the ceiling is per EDGE, so one long edge
// reproduces the defect at a twentieth of the pixels a 16:9 frame of the same width
// would cost. 5600 > MAX_SURFACE_DIM / 1.5 = 5461, so the metaball default trips it.
const W = 5600, H = 200;
// The droplet sits against the right edge — the user's reported trigger, and the
// side the smear runs off.
const PANEL = { x: W - 220, y: 10, w: 200, h: 180 };
// High-frequency content only where it can matter (around and past the cut column),
// so the fixture stays cheap: a full-width stripe field costs seconds, this costs none.
const BAR_PITCH = 12, BAR_WIDTH = 6, BARS_FROM = 5200;

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
const registry = createRegistry();
registerAll(registry, createCommands());

/** Pure function. Plugin defaults + overrides (real params, never a mirrored fixture). */
const def = (type, over) => ({ ...registry.get(type).defaults, type, active: true, ...over });

/** Query→build. A one-slide doc: camera + contrasty bars + one metaball at the right edge. */
function docWithPanel(over) {
  const items = { cam: def("camera", { name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, background: "#101828" }) };
  for (let x = BARS_FROM; x < W; x += BAR_PITCH)
    items[`bar${x}`] = def("rect", { name: `BAR${x}`, x, y: 0, w: BAR_WIDTH, h: H, z: 1, fill: (x / BAR_PITCH) % 2 ? "#f0f4ff" : "#ff2d55" });
  items.mb = def("metaball", { name: "MB", z: 100, ...PANEL, ...over });
  return { meta: { name: "backdrop-fit", slideW: W, slideH: H }, slides: [{ id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items } }] };
}

/** Query→build. (ir, view, background) for a raw doc at W×H. */
function frameOf(rawDoc) {
  const { doc } = repairedDocument(deserialize(JSON.stringify(rawDoc)), registry);
  const state = evaluateState(foldState(doc, 0, 1), registry).state;
  const rect = cameraRect(state, doc.meta);
  return { ir: cameraFrameIR(state, doc.meta, registry), view: fitRectView(rect, W, H, 1), background: rect.background };
}

/**
 * Command. Renders `frame` through a surface factory that either CLAMPS like the
 * real browser factories or allocates whatever is asked for. Returns the pixels and
 * every size that was requested, so a failure can say what the ask actually was.
 */
function render(frame, { clamp }) {
  const asks = [];
  const makeSurface = (w, h) => {
    asks.push([w, h]);
    const c = clamp ? clampSurfaceSize(w, h, MAX_SURFACE_DIM) : { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
    return CanvasKit.MakeSurface(c.w, c.h);
  };
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("backdrop_fit_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), frame.ir, frame.view, { fontCollection, background: frame.background, makeSurface });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return { px, asks };
}

/**
 * Pure function. How two equal-length pixel buffers differ, plus WHERE: the leftmost
 * device column carrying any difference, which for this defect is the cut column and
 * is therefore the diagnostic worth printing.
 *
 * @param {Uint8Array} a,b - RGBA buffers of equal length, `width` px per row
 * @returns {{bytes: number, maxDelta: number, firstColumn: number|null}}
 *
 * @example pixelDiff(new Uint8Array([0, 0, 0, 0, 9, 0, 0, 0]), new Uint8Array(8), 2)
 * // {bytes: 1, maxDelta: 9, firstColumn: 1}
 * @example pixelDiff(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 4]), 1)
 * // {bytes: 0, maxDelta: 0, firstColumn: null}
 */
function pixelDiff(a, b, width) {
  assert.equal(a.length, b.length, "pixel buffers must be the same length");
  let bytes = 0, maxDelta = 0, firstColumn = null;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d === 0) continue;
    bytes++;
    if (d > maxDelta) maxDelta = d;
    const col = (i >> 2) % width;
    if (firstColumn === null || col < firstColumn) firstColumn = col;
  }
  return { bytes, maxDelta, firstColumn };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

console.log("backdrop ask-vs-got:");

// ── 1. THE LAW, as arithmetic, over every scale the Inspector can reach ───────
// backdropScale's declared bounds are 0.25..2 (metaballs_shader.METABALLS_FILL_PARAMS);
// the widths bracket the ceiling from both sides.
test("a fitted request never exceeds the surface ceiling, at any reachable scale/size", () => {
  for (const w of [1920, 3840, 5461, 5600, 7680, 16000]) {
    for (const scale of [0.25, 0.5, 1, 1.5, 2]) {
      const eff = scale * rasterFitFactor(w * scale, H * scale, MAX_SURFACE_DIM);
      assert.ok(eff <= scale, `fit must never RAISE the scale (${w}px @${scale}× → ${eff}×)`);
      assert.ok(Math.round(w * eff) <= MAX_SURFACE_DIM,
        `${w}px @${scale}× fits to ${eff}× ⇒ ${Math.round(w * eff)} px, over the ${MAX_SURFACE_DIM} ceiling`);
      const c = clampSurfaceSize(w * eff, H * eff, MAX_SURFACE_DIM);
      assert.equal(c.w, Math.floor(w * eff), `the factory must not have to clamp a fitted width (${w}px @${scale}×)`);
    }
  }
});

test("a request that already fits is left exactly alone (no resolution lost for free)", () => {
  for (const w of [1920, 3840, 5000]) {
    assert.equal(rasterFitFactor(w * 1.5, H * 1.5, MAX_SURFACE_DIM), 1, `${w}px @1.5× is inside the ceiling`);
  }
});

// ── 2. THE PIXELS. The defect is invisible to arithmetic alone: what it produces
//      is a smear, and only a render shows it. ───────────────────────────────────
const frame = frameOf(docWithPanel({}));
const clamped = render(frame, { clamp: true });
const unclamped = render(frame, { clamp: false });

test(`metaball at the right edge of a ${W}×${H} frame renders the same whether or not the factory clamps`, () => {
  const d = pixelDiff(clamped.px, unclamped.px, W);
  assert.equal(d.bytes, 0,
    `${d.bytes} bytes differ (max delta ${d.maxDelta}, first differing column ${d.firstColumn}) — the backdrop was allocated smaller than the sampleMatrix claims, so the shader is sampling past the end of its texture and TileMode.Clamp is smearing the last column. Surfaces asked for: ${JSON.stringify(clamped.asks)}`);
});

test("and the request it makes is one no factory has to clamp", () => {
  for (const [w, h] of clamped.asks) {
    const c = clampSurfaceSize(w, h, MAX_SURFACE_DIM);
    assert.ok(c.safe, `paintIR asked for ${w}×${h}, which the factory must clamp to ${c.w}×${c.h}`);
  }
});

// ── 3. THE CONTROL that identifies the resolution factor as the trigger ───────
test("backdropScale 1 was never affected (the control that isolates the cause)", () => {
  const f = frameOf(docWithPanel({ backdropScale: 1 }));
  const d = pixelDiff(render(f, { clamp: true }).px, render(f, { clamp: false }).px, W);
  assert.equal(d.bytes, 0, `${d.bytes} bytes differ at backdropScale 1 — this frame is inside the ceiling, so something OTHER than the fit is now wrong`);
});

console.log(`\nPASS: backdrop ask-vs-got (${passed} checks)`);
