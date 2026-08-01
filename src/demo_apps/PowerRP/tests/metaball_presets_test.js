/**
 * THE `metaball` PRESET LIBRARY suite — plain node, no browser.
 * Run: node src/demo_apps/PowerRP/tests/metaball_presets_test.js
 *
 * The shape is tests/frosted_presets_test.js's, because these are the same facts about
 * a different backdrop material, and a second dialect of the same suite is how the
 * hand-maintained-mirror defect spreads. What is METABALL-specific lives in checks
 * (5)-(7).
 *
 *   THE LIBRARY'S RULES (checks 1-4): every preset sets EVERY look knob (applyPreset
 *     writes `props` as an OVERLAY, so one missing key makes two rows' renders depend on
 *     hover order), no preset writes a COMPOSITION key, names are unique and described,
 *     and every value is legal for its own Inspector row.
 *
 *   DISTINCTNESS IN PIXELS (check 5). The library is rendered over one deliberately
 *     VARIED backdrop and scored pairwise. The varied backdrop is not decoration: this
 *     is a backdrop SAMPLER, so over a flat colour `refraction`, `chromatic` and
 *     `blurRadius` are ALL INERT — displacing a sample of a uniform fill returns the
 *     same pixel — and a table of twelve refractors would score as one picture for a
 *     reason that has nothing to do with the presets.
 *
 *   THE `smoothK` INERTNESS FACT (check 6), in bytes, BOTH WAYS. With ONE ball
 *     sceneField's smooth-union seed is FIELD_FAR, h clamps to 0 and f = d exactly, so
 *     the merge width provably cannot move a pixel; with TWO adjacent widgets it must.
 *     Every preset states its fluid's real surface tension in this knob, so the table
 *     would be quietly meaningless if the second half of that ever stopped being true.
 *
 *   THE `threshold` CEILING (check 7). Past a point the material op's clip — the fused
 *     region's CIRCUMRADIUS — cuts the droplet into a literal SQUARE. Measured at
 *     threshold ~1.26 for a lone widget, which is about 2.1x the 0.6 the manifest
 *     records (that figure reasoned from the region RECT and missed that the clip is
 *     its circumradius). The presets stay far below either number; this pins the real
 *     bound so the next author does not have to re-derive it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { newDocument } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { cameraRect } from "../core/derive.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR, evaluatedStateAt } from "../web/cameraFrame.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(here, "../.claude_vlm_checks/metaball_presets_test");
const TYPE = "metaball";

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());
const plugin = registry.get(TYPE);

// The knobs a preset may NOT write, each for a stated reason (see the PRESETS docblock
// in plugins/demo/metaballs.js): the hairline edge and the ball PRIMITIVE are the
// author's framing and layout, the light is composition, and backdropScale is the
// resolution/performance dial.
const EXCLUDED = new Set(["stroke", "strokeWidth", "shape", "lightAngle", "backdropScale"]);
// State the Inspector shows for every widget alike; a preset is a LOOK, so none of it
// belongs in one — including the universal EFFECTS (a preset must not switch a user's
// shadow or feather on).
const NOT_LOOK = new Set([
  "type", "x", "y", "cx", "cy", "w", "h", "z", "rotation", "scale", "rotationAnchor", "opacity", "animated",
  "shadow", "innerShadow", "bloom", "softEdges", "blendMode",
]);
// The eleven look knobs this widget has. Asserted rather than assumed, so a
// mis-deriving filter fails here instead of silently weakening check (1).
const LOOK_KEY_COUNT = 11;

/**
 * Pure function. The widget's LOOK keys, derived from the plugin's REGISTERED
 * inspector — so a knob added tomorrow joins this set with no edit here and check (1)
 * starts demanding it of every preset. Dotted effect rows ("shadow.dx") are dropped by
 * the `in defaults` test, which only top-level item state satisfies.
 *
 * @param {object} p - a registered plugin
 * @returns {string[]} look keys, inspector order
 *
 * @example // lookKeys(registry.get("metaball"))
 * // ["fluidColor", "refraction", "smoothK", "threshold", "bulge", "chromatic",
 * //  "specular", "shininess", "fresnel", "ambient", "blurRadius"]
 */
function lookKeys(p) {
  return (p.inspector ?? [])
    .map((r) => r.key)
    .filter((k) => !NOT_LOOK.has(k) && !EXCLUDED.has(k) && k in p.defaults);
}

// ── (1) THE COMPLETENESS RULE ────────────────────────────────────────────────
test("(1) every preset sets EVERY look knob", () => {
  const want = lookKeys(plugin);
  assert.equal(want.length, LOOK_KEY_COUNT, `lookKeys found ${want.length} look keys (${want.join(", ")}), not ${LOOK_KEY_COUNT} — the filter is mis-deriving and every check below is weaker than it reads`);
  assert.ok(Array.isArray(plugin.presets) && plugin.presets.length >= 8,
    `${TYPE} declares ${plugin.presets?.length ?? 0} presets — R6-3.9 asks this widget for a library, not a token`);
  for (const preset of plugin.presets) {
    const missing = want.filter((k) => !(k in preset.props));
    assert.deepEqual(missing, [], `"${preset.name}" omits ${missing.join(", ")} — an incomplete overlay makes this row's render depend on which row was hovered before it`);
  }
});

test("(2) no preset writes a COMPOSITION key (geometry, border, primitive, light, resolution, effects)", () => {
  for (const preset of plugin.presets) {
    const illegal = Object.keys(preset.props).filter((k) => EXCLUDED.has(k) || NOT_LOOK.has(k));
    assert.deepEqual(illegal, [], `"${preset.name}" writes ${illegal.join(", ")} — a pick would undo the user's own framing`);
  }
});

test("(3) every preset has a unique name and its own description (the pane's hover tip)", () => {
  const seen = new Set();
  for (const preset of plugin.presets) {
    assert.ok(typeof preset.name === "string" && preset.name.length > 0, "a preset with no name");
    assert.ok(!seen.has(preset.name), `duplicate preset name "${preset.name}"`);
    seen.add(preset.name);
    // Without one, web/ToolsPane.svelte falls back to "Apply the … preset" — the row
    // that explains nothing.
    assert.ok(typeof preset.description === "string" && preset.description.length > 20,
      `"${preset.name}" has no real description, so its row would show ToolsPane's generic fallback`);
  }
});

// ── (4) WAS HERE, AND IT IS NOW UNIVERSAL ────────────────────────────────────
// "every preset value is legal for its own Inspector row" had nothing
// metaball-specific in it: it read the plugin's OWN registered rows, so the same
// twelve lines were correct for every widget in the roster — and were copied here
// from tests/frosted_presets_test.js. It now lives ONCE, in
// tests/preset_contract_test.js, which sweeps every registered plugin through
// builtinRoster() and checks number ranges, colour parsing, select membership and
// boolean type — so this widget is still covered, along with the 500-odd presets
// this copy could never see.

// ── the RENDER rig, shared by checks (5) and (6) ─────────────────────────────
const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const CK_BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(CK_BIN, f) });
const fontCollection = CanvasKit.FontCollection.Make(); // these scenes carry no text

// Small on purpose: every frame is per-pixel SkSL over a Gaussian-blurred backdrop on a
// SOFTWARE surface, re-rendered at the material's own backdropScale, and this renders
// one per preset plus four more.
const RENDER_W = 320, RENDER_H = 180;
const CAM = { x: 0, y: 0, w: 960, h: 540 };
// SQUARE: a metaball sphere fills the box's SHORT side, so a square box gives the
// largest droplet the frame holds and the widest sample of the varied backdrop.
const BALL_BOX = { x: 300, y: 30, w: 480, h: 480 };

/**
 * Pure function. THE VARIED BACKDROP, as item specs — the rig
 * tests/frosted_presets_test.js established, reused verbatim so the two material
 * families are judged against the same content. A BRIGHT half and a DARK half (tone),
 * five saturated hues (the tint's hue and the dispersion), and a stripe FREQUENCY RAMP
 * (the lens displacement and the environment blur).
 *
 * @returns {object[]} [{type, ...state}] in z order
 *
 * @example // backdropSpecs()[0].fill // "#f2efe6"  (the bright half)
 * @example // backdropSpecs().filter((s) => s.type === "circle").length // 5
 */
function backdropSpecs() {
  const out = [
    { type: "rect", x: 0, y: 0, w: CAM.w / 2, h: CAM.h, z: 1, fill: "#f2efe6", strokeWidth: 0 },
    { type: "rect", x: CAM.w / 2, y: 0, w: CAM.w / 2, h: CAM.h, z: 1, fill: "#12141c", strokeWidth: 0 },
  ];
  const HUE_D = 130, HUE_GAP = 175;
  ["#e5484d", "#30a46c", "#0090ff", "#ffb224", "#d6409f"].forEach((fill, i) =>
    out.push({ type: "circle", x: 60 + i * HUE_GAP, y: 40, w: HUE_D, h: HUE_D, z: 2, fill, strokeWidth: 0 }));
  const STRIPE_TOP = 330, STRIPE_H = 170, BANDS = 4;
  [6, 14, 30, 60].forEach((sw, band) => {
    const x0 = band * (CAM.w / BANDS), x1 = x0 + CAM.w / BANDS;
    for (let x = x0; x < x1; x += sw * 2)
      out.push({ type: "rect", x, y: STRIPE_TOP, w: Math.min(sw, x1 - x), h: STRIPE_H, z: 2, fill: "#7b61ff", strokeWidth: 0 });
  });
  out.push({ type: "rect", x: 300, y: 200, w: 160, h: 110, z: 3, fill: "#ffffff", strokeWidth: 0 });
  out.push({ type: "rect", x: 500, y: 200, w: 160, h: 110, z: 3, fill: "#05060a", strokeWidth: 0 });
  return out;
}

/**
 * Query→build. A one-slide document holding THE camera, the varied backdrop, and one
 * metaball widget per entry of `boxes` at the plugin's defaults with `props` overlaid.
 * Slide 0's delta creates everything, which is the document model's own rule.
 *
 * @param {object[]} boxes - {x, y, w, h} per metaball widget
 * @param {object} props - look-knob overrides applied to every one of them
 * @returns {object} a PowerRP document
 */
function docOf(boxes, props) {
  const doc = newDocument();
  const items = doc.slides[0].delta.items;
  Object.assign(items[Object.keys(items)[0]], CAM, { background: "#6b7280" });
  backdropSpecs().forEach((spec, i) => { items[`bg${i}`] = { ...registry.get(spec.type).defaults, ...spec }; });
  boxes.forEach((box, i) => { items[`ball${i}`] = { ...plugin.defaults, ...box, z: 100 + i, ...props }; });
  return doc;
}

/**
 * Command (allocates and frees a CanvasKit surface; writes a PNG). Renders a document's
 * camera frame through the SAME path the editor and the CLI use — evaluate, derive,
 * sceneIR, paint_skia — and returns unpremultiplied RGBA bytes.
 *
 * @param {object[]} boxes - metaball widget boxes
 * @param {object} props - look-knob overrides
 * @param {string} label - PNG basename written under .claude_vlm_checks/
 * @returns {Uint8Array} RGBA, RENDER_W x RENDER_H
 */
function render(boxes, props, label) {
  const doc = docOf(boxes, props);
  const state = evaluatedStateAt(doc, 0, 1, registry);
  const rect = cameraRect(state, doc.meta);
  const surface = CanvasKit.MakeSurface(RENDER_W, RENDER_H);
  if (!surface) throw new Error("metaball_presets_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cameraFrameIR(state, doc.meta, registry), fitRectView(rect, RENDER_W, RENDER_H, 1), {
    fontCollection, background: rect.background, makeSurface: (w, h) => CanvasKit.MakeSurface(w, h), quality: "full",
  });
  surface.flush();
  const img = surface.makeImageSnapshot();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, `${label}.png`), Buffer.from(img.encodeToBytes()));
  const px = img.readPixels(0, 0, { width: RENDER_W, height: RENDER_H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return px;
}

// ── the metric ───────────────────────────────────────────────────────────────
const D65 = [0.95047, 1.0, 1.08883];
const SRGB_LINEAR_KNEE = 0.04045, LAB_EPSILON = 0.008856;
/**
 * Pure function. An sRGB byte triple as CIE L*a*b* (D65). Lab rather than a raw RGB
 * distance because the bar below is PERCEPTUAL — "would a user see two different looks"
 * — and RGB distance is not. Same function as tests/frosted_presets_test.js, which is
 * the family that calibrated the bar these numbers are compared against.
 *
 * @param {number} r,g,b - 0..255
 * @returns {[number, number, number]} [L*, a*, b*]
 *
 * @example lab(255, 255, 255).map(Math.round) // [100, 0, 0]
 * @example lab(0, 0, 0)[0] // 0
 */
function lab(r, g, b) {
  const lin = (c) => (c / 255 <= SRGB_LINEAR_KNEE ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const rl = lin(r), gl = lin(g), bl = lin(b);
  const f = [
    (0.4124 * rl + 0.3576 * gl + 0.1805 * bl) / D65[0],
    (0.2126 * rl + 0.7152 * gl + 0.0722 * bl) / D65[1],
    (0.0193 * rl + 0.1192 * gl + 0.9505 * bl) / D65[2],
  ].map((t) => (t > LAB_EPSILON ? Math.cbrt(t) : 7.787 * t + 16 / 116));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

// The droplet INTERIOR: the INSCRIBED ball disc, shrunk so no coverage-AA rim pixel is
// counted. Every preset's isosurface is at least this big, because `threshold` can only
// fatten it — so the same pixels are compared for every row.
const DISC_INSET_FRAC = 0.92;
const SX = RENDER_W / CAM.w, SY = RENDER_H / CAM.h;
const DISC = {
  cx: (BALL_BOX.x + BALL_BOX.w / 2) * SX,
  cy: (BALL_BOX.y + BALL_BOX.h / 2) * SY,
  r: (Math.min(BALL_BOX.w, BALL_BOX.h) / 2) * Math.min(SX, SY) * DISC_INSET_FRAC,
};

/**
 * Pure function. Mean CIE76 ΔE*ab between two RGBA buffers over the droplet interior.
 *
 * @param {Uint8Array} a,b - RGBA bytes, RENDER_W x RENDER_H
 * @returns {number} mean ΔE*ab (0 = identical; ~2.3 = one just-noticeable difference)
 *
 * @example // meanDeltaE(quicksilverPixels, quicksilverPixels) // 0
 * @example // meanDeltaE(lavaLampPixels, blobbyPixels) // ~62.8 (opposite ends of the library)
 */
function meanDeltaE(a, b) {
  let sum = 0, n = 0;
  for (let y = 0; y < RENDER_H; y++)
    for (let x = 0; x < RENDER_W; x++) {
      if (Math.hypot(x + 0.5 - DISC.cx, y + 0.5 - DISC.cy) > DISC.r) continue;
      const i = (y * RENDER_W + x) * 4;
      const la = lab(a[i], a[i + 1], a[i + 2]), lb = lab(b[i], b[i + 1], b[i + 2]);
      sum += Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
      n++;
    }
  assert.ok(n > 1000, `meanDeltaE: only ${n} interior pixels — the droplet framing and the render size disagree`);
  return sum / n;
}

// ── (5) DISTINCTNESS, IN PIXELS ──────────────────────────────────────────────
// The bar is the frosted-glass family's 8 — around three JNDs averaged over every pixel
// — and it is used unchanged BECAUSE it was calibrated against real cut candidates
// there (8.9 and 9.5), which is the only way a threshold like this earns a number. The
// shipped metaball minimum is 17.8, so this fails on a NEW near-duplicate rather than on
// ordinary retuning of an existing one.
const MIN_PAIRWISE_DELTA_E = 8;
const ONE_WIDGET = [BALL_BOX];
test("(5) every pair of presets is VISIBLY different over a varied backdrop", () => {
  const shots = plugin.presets.map((p) => ({ name: p.name, px: render(ONE_WIDGET, p.props, p.name.replace(/\W+/g, "_").toLowerCase()) }));
  let worst = { d: Infinity, a: null, b: null };
  for (let i = 0; i < shots.length; i++)
    for (let j = i + 1; j < shots.length; j++) {
      const d = meanDeltaE(shots[i].px, shots[j].px);
      if (d < worst.d) worst = { d, a: shots[i].name, b: shots[j].name };
    }
  assert.ok(worst.d >= MIN_PAIRWISE_DELTA_E,
    `"${worst.a}" and "${worst.b}" render at mean ΔE ${worst.d.toFixed(2)} over the droplet — below the ${MIN_PAIRWISE_DELTA_E} bar, so the pane would show two rows a user cannot tell apart. Move one along an axis that changes pixels, or drop it.`);
  console.log(`      closest pair: "${worst.a}" vs "${worst.b}" at ΔE ${worst.d.toFixed(2)} (bar ${MIN_PAIRWISE_DELTA_E})`);
});

// ── (6) `smoothK`: PROVABLY INERT ALONE, LIVE IN A CLUSTER ───────────────────
// Two boxes close enough that their balls fuse. The GAP is what makes this a merge
// rather than two separate droplets; at this spacing the neck is well inside the fused
// region, so the only thing under test is the merge width.
const FUSED_PAIR = [{ x: 200, y: 130, w: 280, h: 280 }, { x: 570, y: 130, w: 280, h: 280 }];
const SMOOTH_K_LOW = 0.05, SMOOTH_K_HIGH = 2.6;
test("(6) smoothK moves NO pixel on a lone widget and DOES on a fused pair", () => {
  const base = plugin.presets[0].props;
  const bytesDiffer = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
  const aloneLow = render(ONE_WIDGET, { ...base, smoothK: SMOOTH_K_LOW }, "smoothk_alone_low");
  const aloneHigh = render(ONE_WIDGET, { ...base, smoothK: SMOOTH_K_HIGH }, "smoothk_alone_high");
  assert.equal(bytesDiffer(aloneLow, aloneHigh), 0,
    `smoothK ${SMOOTH_K_LOW} vs ${SMOOTH_K_HIGH} changed pixels on a LONE widget — the smooth-union seed no longer cancels, so the PRESETS docblock's "provably inert alone" claim is now false and the pane could carry distinctness on this knob`);
  const pairLow = render(FUSED_PAIR, { ...base, smoothK: SMOOTH_K_LOW }, "smoothk_pair_low");
  const pairHigh = render(FUSED_PAIR, { ...base, smoothK: SMOOTH_K_HIGH }, "smoothk_pair_high");
  const moved = bytesDiffer(pairLow, pairHigh);
  assert.ok(moved > 0,
    `smoothK ${SMOOTH_K_LOW} vs ${SMOOTH_K_HIGH} changed NOTHING on two fused widgets either — then every preset's surface-tension value is dead everywhere and the table says something untrue`);
  console.log(`      smoothK ${SMOOTH_K_LOW}→${SMOOTH_K_HIGH}: 0 bytes alone, ${moved} bytes fused`);
});

// ── (7) THE `threshold` CEILING ──────────────────────────────────────────────
// The fused region is the balls' box grown by REGION_PAD_FRAC (0.6) of the largest
// ball's reach, and handleMaterialBackdrop clips the op to that region's CIRCUMRADIUS —
// so for a lone widget the droplet is cut into a square once r*(1+threshold) exceeds
// r*1.6*sqrt(2), i.e. at threshold sqrt(2)*1.6 - 1. MEASURED: the ink tracks the
// analytic radius exactly at 0.30 / 0.60 / 0.90 / 1.26 and freezes above it.
const THRESHOLD_SQUARE_CUT = Math.SQRT2 * 1.6 - 1;
test("(7) no preset's threshold approaches the square-cut ceiling", () => {
  assert.ok(THRESHOLD_SQUARE_CUT > 1.2 && THRESHOLD_SQUARE_CUT < 1.3, `the ceiling arithmetic drifted: ${THRESHOLD_SQUARE_CUT}`);
  for (const preset of plugin.presets)
    assert.ok(preset.props.threshold < THRESHOLD_SQUARE_CUT / 2,
      `"${preset.name}" sets threshold ${preset.props.threshold}, over half the ${THRESHOLD_SQUARE_CUT.toFixed(2)} point where the op's clip cuts the droplet into a square`);
});

console.log(`\n${passed} checks passed over ${plugin.presets.length} presets; shots in ${SHOT_DIR.replace(path.resolve(here, "../../../.."), ".")}`);
