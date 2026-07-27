/**
 * THE BACKDROP-REACH CONTRACT — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/material_reach_test.js
 *
 * ── WHAT THIS PINS ────────────────────────────────────────────────────────────
 * handleMaterialBackdrop feeds a backdrop material's shader from a re-render of
 * the content beneath it. How much of that content it has to build depends on how
 * far outside its own panel the shader READS, and a material answers that with
 * `maxSampleReach(u)` (render_gpu/skia/materials.js materialSampleReach). Declaring
 * it bounds the backdrop to the panel's footprint + the reach; NOT declaring it
 * falls back to the whole surface, which is expensive but never wrong.
 *
 * The dangerous direction is an UNDER-estimate: the child image shaders tile
 * TileMode.Clamp, so a region smaller than the shader reads does not error — it
 * silently smears the region's edge pixel across the material's rim. That is
 * invisible in a unit test that only asks "did it draw something", so this suite
 * asks the only question that catches it:
 *
 *   for every material that DECLARES a reach, does the region-bounded render match
 *   the same scene rendered with the whole surface as the backdrop?
 *
 * It compares against the full-surface path by temporarily removing the declared
 * hook from the descriptor, so the reference is the code path that shipped before
 * the bound existed — not a second opinion about what the right answer is. The
 * scene is deliberately HIGH-FREQUENCY (4-px stripes both ways): over smooth
 * content a clamped rim samples nearly the right colour anyway, and measurably
 * nothing changes.
 *
 * ── WHY THE TOLERANCE IS NOT ZERO, AND WHAT IT STILL CATCHES ──────────────────
 * Byte equality is not available, and the reason has NOTHING to do with reach: a
 * region-bounded backdrop re-renders the content beneath into a smaller surface at
 * an integer device offset, and Skia's rasterization is not invariant under that.
 * Rendering the identical scene into 640×360 and into 200×200 at (+220,+85) differs
 * by 419 of 160,000 bytes in the overlap, max delta 52, ALL of it on a circle's
 * antialiased rim — measured with no material and no shader involved
 * (.frenzy/render_cost/probe_rerender_shift.js). Skia chooses its antialiasing scan
 * converter partly from the clip extent. `glassBackdrop` has always carried this;
 * the reach protocol only widens who does.
 *
 * So the assertion is on the SHAPE of the difference, which still separates the two
 * failure modes cleanly: a CLAMP replaces real content with a smeared edge pixel
 * across a contiguous BAND, so its byte count runs to thousands.
 * MAX_DIFFERING_FRACTION rejects that, and MAX_CHANNEL_DELTA holds the rim wobble to
 * the size measured for materials that merely SHADE the sample (crt, frosted: ≤ 2
 * levels on ≤ 0.003% of the frame). A material that divides by the sampled alpha
 * amplifies the same wobble to 82 levels and must not declare a reach at all — see
 * BRIGHTNESS_CONTRAST_MATERIAL, which withholds its (genuinely zero) reach for
 * exactly that reason.
 *
 * NOTE the declaring materials could not be made to CLAMP at all, which is worth
 * knowing on its own (.frenzy/render_cost/probe_clamp_calibration.js): frosted's
 * reach is literally zero, and the CRT turns out to be SELF-BOUNDING — its
 * barrel-warped sample is gated by the lit-screen SDF computed on that same warped
 * coordinate (`outc *= screen`), so a sample the warp pushes off the screen is
 * multiplied by zero. Zeroing the CRT's reach entirely, even at curvature 0.5 over
 * the striped scene, changed no byte. The reach it declares is therefore
 * CONSERVATIVE by design — see maxCrtSampleReach for why the provably inert barrel
 * term is kept rather than optimized away.
 *
 * Plus an INVENTORY (the material_proxy_coverage_test.js precedent): every backdrop
 * material is listed as declaring or not, so adding one is a visible, deliberate
 * choice and the remaining full-surface cost is never a surprise.
 *
 * Fixtures come from the PLUGINS' own defaults through the registry, not from
 * hand-written uniform maps: skia_material_proxy_probe.js documents how a mirrored
 * fixture drifts the moment a plugin gains a shader param, and a reach test that
 * silently stopped exercising a knob would be worse than useless.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { paintIR } from "../skia/paint_skia.js";
import { getMaterial, materialIds, isBackdropMaterial, materialSampleReach } from "../skia/materials.js";
import { deserialize, repairedDocument, foldState } from "../../core/document.js";
import { evaluateState } from "../../core/expressions.js";
import { createRegistry } from "../../core/registry.js";
import { createCommands } from "../../core/commands.js";
import { registerAll } from "../../plugins/index.js";
import { cameraRect } from "../../core/derive.js";
import { fitRectView } from "../../core/view.js";
import { cameraFrameIR } from "../../web/cameraFrame.js";
import { committedFaces, FALLBACK_FACES } from "../fonts.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts");

// Deliberately MODEST: the point is a panel much smaller than the frame, which is
// exactly the case a full-surface backdrop overpays for. Both renders in a pair
// use the same size, so the size itself is not load-bearing for the assertion.
const W = 640, H = 360;
const PANEL = { x: 240, y: 130, w: 160, h: 110, z: 100 };
// The tolerance, calibrated in the header. A clamped rim is a contiguous BAND of
// thousands of bytes; the rim wobble Skia's rasterizer introduces when the backdrop
// surface shrinks measured ≤ 2 levels over ≤ 30 bytes for these materials.
const MAX_CHANNEL_DELTA = 2;
const MAX_DIFFERING_FRACTION = 1e-4; // 0.01% of the buffer (measured wobble: ≤ 30 bytes in 921,600 ≈ 3e-5)

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

/**
 * Query (calls every plugin's emit). materialId → the widget type that emits it,
 * plus the plugin types whose emit() could not be called from bare defaults.
 * Derived from the registry so a NEW backdrop widget is picked up automatically
 * instead of being missed by a hand-kept list.
 *
 * A plugin whose emit() needs derive-time context it cannot get here (a sibling
 * query, a folded subtree, a rasterizer that needs a DOM) throws; those types are
 * RETURNED so the inventory can name them, because "which widgets this scan could
 * not look at" is exactly the information a silent skip would destroy.
 */
function backdropWidgetsByMaterial() {
  const byMaterial = new Map();
  const unscannable = [];
  for (const plugin of registry.all()) {
    if (!plugin.defaults || plugin.defaults.w === undefined) continue; // no box to place: not a panel widget
    let cmds;
    try {
      cmds = plugin.emit({ ...plugin.defaults, active: true });
    } catch (err) {
      unscannable.push(`${plugin.type} (${err.message.split("\n")[0].slice(0, 60)})`);
      continue;
    }
    for (const c of cmds) if (c.op === "materialBackdrop" && !byMaterial.has(c.material)) byMaterial.set(c.material, plugin.type);
  }
  return { byMaterial, unscannable };
}

/** Pure function. Plugin defaults + overrides (real params, never a mirrored fixture). */
function def(type, over) {
  return { ...registry.get(type).defaults, type, active: true, ...over };
}

const STRIPE_PITCH = 8;   // device px between stripe starts (the backdrop's spatial frequency)
const STRIPE_WIDTH = 4;   // width of each vertical stripe
const RUNG_HEIGHT = 3;    // height of each horizontal rung (a second, coarser frequency)

/**
 * Query→build. The backdrop content, as an id→item map. Two frequencies on purpose:
 * STRIPES so a clamped rim shows up as a flat smear where stripes belong, and a
 * CIRCLE straddling the panel edge because a curved antialiased rim is where the
 * rasterizer's own region sensitivity shows up (the tolerance's whole reason).
 */
function stripes() {
  const items = {};
  for (let i = 0; i * STRIPE_PITCH < W; i++)
    items[`st${i}`] = def("rect", { name: `ST${i}`, x: i * STRIPE_PITCH, y: 0, w: STRIPE_WIDTH, h: H, z: 1, fill: i % 2 ? "#f0f4ff" : "#101828" });
  for (let i = 0; i * STRIPE_PITCH < H; i++)
    items[`sh${i}`] = def("rect", { name: `SH${i}`, x: 0, y: i * STRIPE_PITCH, w: W, h: RUNG_HEIGHT, z: 2, fill: i % 3 ? "#ff2d55" : "#00e5ff" });
  items.rim = def("circle", { name: "RIM", x: 150, y: 200, w: 130, h: 130, z: 3, fill: "#ffd246" });
  return items;
}

/** Query→build. A one-slide doc: camera + scene content + one backdrop panel of `type`. */
function docWithPanel(type, over = {}) {
  return {
    meta: { name: "reach", slideW: W, slideH: H },
    slides: [{
      id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: def("camera", { name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, background: "#1a2740" }),
          // HIGH-FREQUENCY content, both axes: a clamped rim replaces stripes with a
          // flat smear, which is loud. Over smooth fills it is invisible — measured,
          // see the header.
          ...stripes(),
          s: def(type, { name: "S", ...PANEL, ...over }),
        },
      },
    }],
  };
}

/** Query→build. (ir, view, background) for a raw doc at W×H. */
function frameOf(rawDoc) {
  const { doc } = repairedDocument(deserialize(JSON.stringify(rawDoc)), registry);
  const state = evaluateState(foldState(doc, 0, 1), registry).state;
  const rect = cameraRect(state, doc.meta);
  return { ir: cameraFrameIR(state, doc.meta, registry), view: fitRectView(rect, W, H, 1), background: rect.background };
}

/** Command. Renders `frame` on a fresh software surface; returns its pixels + the
 *  total area of the offscreen surfaces paintIR allocated (the cost being bounded). */
function render(frame) {
  let surfacePx = 0;
  const makeSurface = (w, h) => { surfacePx += w * h; return CanvasKit.MakeSurface(w, h); };
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("material_reach_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), frame.ir, frame.view, { fontCollection, background: frame.background, makeSurface });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return { px, surfacePx };
}

/**
 * Pure function. How two equal-length pixel buffers differ: how many bytes, the
 * largest per-channel gap, and that count as a fraction of the buffer. The SHAPE of
 * a difference is what separates a rounding artifact (one byte, one level) from a
 * clamped rim (a band of large gaps) — see the header.
 *
 * @param {Uint8Array} a,b - RGBA pixel buffers of equal length
 * @returns {{bytes: number, maxDelta: number, fraction: number}}
 *
 * @example pixelDiff(new Uint8Array([1, 2]), new Uint8Array([1, 3])) // {bytes: 1, maxDelta: 1, fraction: 0.5}
 * @example pixelDiff(new Uint8Array([9, 9]), new Uint8Array([9, 9])) // {bytes: 0, maxDelta: 0, fraction: 0}
 */
function pixelDiff(a, b) {
  assert.equal(a.length, b.length, "pixel buffers must be the same length");
  let bytes = 0, maxDelta = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d !== 0) { bytes++; if (d > maxDelta) maxDelta = d; }
  }
  return { bytes, maxDelta, fraction: bytes / a.length };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

const { byMaterial: WIDGETS, unscannable: UNSCANNABLE } = backdropWidgetsByMaterial();
const BACKDROP_IDS = materialIds().filter((id) => isBackdropMaterial(getMaterial(id)));

// ── 1. validation is LOUD ────────────────────────────────────────────────────

test("materialSampleReach: undeclared ⇒ null (the whole-surface fallback, not an error)", () => {
  assert.equal(materialSampleReach({ id: "x" }, {}), null);
});

test("materialSampleReach: a nonsense reach throws instead of silently under-bounding", () => {
  for (const bad of [-1, NaN, Infinity, "3", null]) {
    assert.throws(() => materialSampleReach({ id: "x", maxSampleReach: () => bad }, {}),
      /must return a finite non-negative device-px reach/,
      `reach ${JSON.stringify(bad)} must be rejected — an under-bound region silently smears the material's rim`);
  }
});

// ── 2. INVENTORY: every backdrop material's reach status is explicit ──────────

test("INVENTORY: every backdrop material is reachable from a widget and its reach status is listed", () => {
  const rows = [];
  for (const id of BACKDROP_IDS) {
    const declared = typeof getMaterial(id).maxSampleReach === "function";
    const type = WIDGETS.get(id) ?? "(no plain backdrop widget)";
    rows.push({ id, declared, type });
  }
  console.log("");
  for (const r of rows) console.log(`    ${r.id.padEnd(20)}${(r.declared ? "DECLARED reach → region-bounded" : "undeclared → FULL-surface backdrop").padEnd(36)}${r.type}`);
  const declared = rows.filter((r) => r.declared).length;
  console.log(`\n    backdrop materials: ${rows.length}  (declared: ${declared}, full-surface: ${rows.length - declared})`);
  if (UNSCANNABLE.length) console.log(`    plugins this scan could not emit from bare defaults: ${UNSCANNABLE.join("; ")}`);
  console.log("");
  assert.ok(rows.length > 0, "no backdrop materials found — the registry scan is broken");
});

// ── 3. THE SAFETY PROPERTY: a declared reach changes COST, not PIXELS ────────

for (const id of BACKDROP_IDS) {
  const material = getMaterial(id);
  if (typeof material.maxSampleReach !== "function") continue;
  const type = WIDGETS.get(id);
  if (!type) continue; // covered by the inventory; nothing to render it with
  for (const [caseName, over] of [["axis-aligned", {}], ["rotated", { rotation: 0.4 }]]) {
    test(`${id} (${caseName}): the region-bounded backdrop matches the full-surface one, and is cheaper`, () => {
      const frame = frameOf(docWithPanel(type, over));
      const bounded = render(frame);
      // The reference: the SAME scene with the reach hook removed, i.e. exactly the
      // full-surface path this bound replaced. Restored in a finally so one failing
      // material cannot corrupt the next test's registry.
      const hook = material.maxSampleReach;
      delete material.maxSampleReach;
      let full;
      try { full = render(frame); } finally { material.maxSampleReach = hook; }
      const d = pixelDiff(bounded.px, full.px);
      assert.ok(d.maxDelta <= MAX_CHANNEL_DELTA,
        `${id} (${caseName}): a channel differs from the full-surface backdrop by ${d.maxDelta} levels (limit ${MAX_CHANNEL_DELTA}) — the declared maxSampleReach UNDER-estimates how far the shader reads, so the child sampler is clamping at the region edge and smearing it`);
      assert.ok(d.fraction <= MAX_DIFFERING_FRACTION,
        `${id} (${caseName}): ${d.bytes} of ${full.px.length} bytes differ (${(d.fraction * 100).toFixed(4)}%, limit ${MAX_DIFFERING_FRACTION * 100}%) — too many pixels to be the blur's resampling grid`);
      assert.ok(bounded.surfacePx < full.surfacePx,
        `${id} (${caseName}): the bounded backdrop allocated ${bounded.surfacePx} offscreen px vs ${full.surfacePx} full-surface — a declared reach that saves nothing is either wrong or pointless`);
      console.log(`      offscreen px ${full.surfacePx} → ${bounded.surfacePx} (${(full.surfacePx / bounded.surfacePx).toFixed(2)}x less); differing bytes ${d.bytes}, max delta ${d.maxDelta}`);
    });
  }
}

console.log(`\n${passed} material-reach checks passed`);
