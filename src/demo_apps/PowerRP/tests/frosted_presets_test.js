/**
 * THE `demo_frosted_glass` PRESET LIBRARY suite — plain node, no browser.
 * Run: node src/demo_apps/PowerRP/tests/frosted_presets_test.js
 *
 * Three things live here, all facts about ONE widget that a bare node run can PROVE:
 *
 *   THE LIBRARY'S RULES (checks 1-4), the shape tests/sky_family_test.js established:
 *     every preset sets EVERY look knob (app.applyPreset writes `props` as an OVERLAY,
 *     so a knob one row omits keeps whatever the PREVIOUSLY hovered row left there —
 *     one missing key makes two rows' rendering depend on hover order), no preset
 *     writes a COMPOSITION key, names are unique and described, and every value is
 *     legal for its own Inspector row.
 *
 *   DISTINCTNESS IN PIXELS (check 5), which is why this file exists at all. A preset
 *     table whose ROWS differ is worthless if its RENDERS do not, and the failure is
 *     invisible to every rule above: a sibling widget shipped five presets this same
 *     session of which four were byte-identical, and the parameters looked fine. So the
 *     whole library is rendered over one deliberately VARIED backdrop — a bright half
 *     and a dark half, five saturated hues, and a stripe frequency ramp, because a
 *     backdrop material evaluated over a flat colour makes every preset look alike for
 *     the wrong reason — and scored pairwise. Two candidates were cut by this check
 *     before shipping; see the PRESETS header in plugins/demo/frosted_glass.js.
 *
 *   THE `absorb` GATE (check 6), in bytes. `absorb` was added FOR this library, and its
 *     whole licence to exist is that 0 changes nothing: at frost 0 / absorb 0 the tint
 *     must not reach a single pixel, so the same scene rendered with a saturated tint
 *     and with white must be BYTE-IDENTICAL. An ungated term anywhere in the tint path
 *     would break this and nothing else here would notice.
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
import { BUNDLES } from "../core/properties.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR, evaluatedStateAt } from "../web/cameraFrame.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(here, "../.claude_vlm_checks/frosted_presets_test");
const TYPE = "demo_frosted_glass";

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

// The keys a preset may NOT write. `cornerRadius` is the panel's own rounding and
// `stroke`/`strokeWidth` its hairline edge: both are things the USER shapes for their
// layout, so a look pick must not overwrite them (plugins/demo/lens_flare.js's
// exclusion, and what comic / glitch / brightness_contrast all already do).
const EXCLUDED = new Set(["cornerRadius", "stroke", "strokeWidth"]);
// State the Inspector shows for every widget alike; a preset is a LOOK, so none of it
// belongs in one — including the universal EFFECTS (a preset must not switch a
// user's shadow or feather on). This material has no emissive-blend exception.
//
// THE EFFECTS HALF IS DERIVED FROM BUNDLES.effects, not listed. It used to name the
// five by hand, and when the bundle gained a SIXTH (`gaussianBlur`) that list went
// stale in the most confusing possible way: the new row was not in NOT_LOOK, so
// lookKeys admitted it as a look knob and check (1) started demanding every frosted
// preset SET a universal effect — the exact opposite of this file's rule. Deriving
// it means the bundle can grow without this suite inverting its own contract.
const EFFECT_KEYS = [...new Set(BUNDLES.effects.map((k) => k.split(".")[0]))];
const NOT_LOOK = new Set([
  "type", "x", "y", "w", "h", "z", "rotation", "scale", "rotationAnchor", "opacity", "animated",
  ...EFFECT_KEYS,
]);

/**
 * Pure function. The widget's LOOK keys, derived from the plugin's REGISTERED
 * inspector — so a knob added tomorrow joins this set with no edit here and check (1)
 * starts demanding it of every preset.
 *
 * @param {object} p - a registered plugin
 * @returns {string[]} look keys, inspector order
 *
 * @example // lookKeys(registry.get("demo_frosted_glass"))
 * // ["blurRadius", "frost", "tint", "absorb"]
 */
function lookKeys(p) {
  return (p.inspector ?? [])
    .map((r) => r.key)
    .filter((k) => !NOT_LOOK.has(k) && !EXCLUDED.has(k) && k in p.defaults);
}

// ── (1) THE COMPLETENESS RULE ────────────────────────────────────────────────
test("(1) every preset sets EVERY look knob", () => {
  const want = lookKeys(plugin);
  assert.ok(want.length >= 4, `only ${want.length} look keys found — lookKeys is mis-deriving`);
  assert.ok(Array.isArray(plugin.presets) && plugin.presets.length >= 8,
    `${TYPE} declares ${plugin.presets?.length ?? 0} presets — the user's complaint was that there were not enough`);
  for (const preset of plugin.presets) {
    const missing = want.filter((k) => !(k in preset.props));
    assert.deepEqual(missing, [], `"${preset.name}" omits ${missing.join(", ")} — an incomplete overlay makes this row's render depend on which row was hovered before it`);
  }
});

// The PLACEMENT subset of the two sets above (type/x/y/z/rotation/scale/
// rotationAnchor) is now gated for EVERY plugin in tests/preset_contract_test.js
// and is not restated here. What stays is the part that is a judgement about THIS
// widget rather than a law: w/h (a layout family may legitimately write one — the
// crop-aspect ruling), opacity and the effects bundle (plugins/graph_presets.js
// writes a `bloom` bundle and every lens_flare preset writes `blendMode`, so
// neither can be banned globally), and this panel's own cornerRadius/stroke.
test("(2) no preset writes a COMPOSITION key (geometry, border, transform, opacity, effects)", () => {
  for (const preset of plugin.presets) {
    const illegal = Object.keys(preset.props).filter((k) => EXCLUDED.has(k) || NOT_LOOK.has(k));
    assert.deepEqual(illegal, [], `"${preset.name}" writes ${illegal.join(", ")} — a pick would undo the user's own framing`);
  }
});

test("(3) every preset has a unique name and its own description (the pane's hover tip)", () => {
  const seen = new Set();
  for (const preset of plugin.presets) {
    assert.equal(typeof preset.name, "string");
    assert.ok(preset.name.length > 0, "a preset with no name");
    assert.ok(!seen.has(preset.name), `duplicate preset name "${preset.name}"`);
    seen.add(preset.name);
    // Without one, web/ToolsPane.svelte falls back to "Apply the … preset" — the row
    // that explains nothing (tests/lens_flare_presets_probe.js check (2)).
    assert.ok(typeof preset.description === "string" && preset.description.length > 20,
      `"${preset.name}" has no real description, so its row would show ToolsPane's generic fallback`);
  }
});

// ── (4) WAS HERE, AND IT IS NOW UNIVERSAL ────────────────────────────────────
// "every preset value is legal for its own Inspector row" had nothing
// frosted-specific in it: it read the plugin's OWN registered rows, so the same
// twelve lines were correct for every widget in the roster — and had already been
// copied once, into tests/metaball_presets_test.js. That is the
// hand-maintained-mirror defect reproducing itself in the tooling. It now lives
// ONCE, in tests/preset_contract_test.js, which sweeps every registered plugin
// through builtinRoster() and checks number ranges, colour parsing, select
// membership and boolean type — so this widget is still covered, along with the
// 500-odd presets this copy could never see.

// ── the RENDER rig, shared by checks (5) and (6) ─────────────────────────────
const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const CK_BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(CK_BIN, f) });
const fontCollection = CanvasKit.FontCollection.Make(); // these scenes carry no text

// Small on purpose: every frame is per-pixel SkSL over a Gaussian-blurred backdrop on
// a SOFTWARE surface, and this renders one per preset. 320x180 still resolves the
// finest stripe band below (6 world px -> 2 render px).
const RENDER_W = 320, RENDER_H = 180;
const CAM = { x: 0, y: 0, w: 960, h: 540 };
const PANEL = { x: 140, y: 90, w: 680, h: 360 };

/**
 * Pure function. THE VARIED BACKDROP, as item specs. A backdrop material reads the
 * composite below it, so over a FLAT colour a dark preset and a tinted one can land on
 * the same pixel value and the whole check would pass while looking identical. This
 * carries the three things the look knobs act on: a BRIGHT half and a DARK half (tone),
 * five saturated hues (the tint's hue), and a stripe FREQUENCY RAMP (the blur).
 *
 * @returns {object[]} [{type, ...state}] in z order
 *
 * @example // backdropSpecs().length // 32
 * @example // backdropSpecs()[0].fill // "#f2efe6"  (the bright half)
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
 * frosted panel at the plugin's defaults with `props` overlaid. Slide 0's delta creates
 * everything, which is the document model's own rule.
 *
 * @param {object} props - look-knob overrides for the panel
 * @returns {object} a PowerRP document
 */
function docOf(props) {
  const doc = newDocument();
  const items = doc.slides[0].delta.items;
  Object.assign(items[Object.keys(items)[0]], CAM, { background: "#6b7280" });
  backdropSpecs().forEach((spec, i) => { items[`bg${i}`] = { ...registry.get(spec.type).defaults, ...spec }; });
  items.panel = { ...plugin.defaults, ...PANEL, z: 100, ...props };
  return doc;
}

/**
 * Command (allocates and frees a CanvasKit surface; writes a PNG). Renders a document's
 * camera frame through the SAME path the editor and the CLI use — evaluate, derive,
 * sceneIR, paint_skia — and returns unpremultiplied RGBA bytes.
 *
 * @param {object} props - look-knob overrides for the panel
 * @param {string} label - PNG basename written under .claude_vlm_checks/
 * @returns {Uint8Array} RGBA, RENDER_W x RENDER_H
 */
function renderPanel(props, label) {
  const doc = docOf(props);
  const state = evaluatedStateAt(doc, 0, 1, registry);
  const rect = cameraRect(state, doc.meta);
  const surface = CanvasKit.MakeSurface(RENDER_W, RENDER_H);
  if (!surface) throw new Error("frosted_presets_test: MakeSurface returned null");
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
 * Pure function. An sRGB byte triple as CIE L*a*b* (D65). Lab is used rather than a
 * raw RGB distance because the bar below is PERCEPTUAL — "would a user see these as
 * two different looks" — and RGB distance is not.
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

// The panel interior in RENDER px, inset so no antialiased rim or hairline border pixel
// is counted — the comparison must be of the MATERIAL, not of the shared edge.
const RIM_INSET_PX = 5;
const SX = RENDER_W / CAM.w, SY = RENDER_H / CAM.h;
const BOX = {
  x0: Math.round(PANEL.x * SX) + RIM_INSET_PX, y0: Math.round(PANEL.y * SY) + RIM_INSET_PX,
  x1: Math.round((PANEL.x + PANEL.w) * SX) - RIM_INSET_PX, y1: Math.round((PANEL.y + PANEL.h) * SY) - RIM_INSET_PX,
};

/**
 * Pure function. Mean CIE76 ΔE*ab between two RGBA buffers over the panel interior.
 *
 * @param {Uint8Array} a,b - RGBA bytes, RENDER_W x RENDER_H
 * @returns {number} mean ΔE*ab (0 = identical; ~2.3 = one just-noticeable difference)
 *
 * @example // meanDeltaE(milkGlassPixels, milkGlassPixels) // 0
 * @example // meanDeltaE(milkGlassPixels, smokedGlassPixels) // ~62 (opposite ends of the library)
 */
function meanDeltaE(a, b) {
  let sum = 0, n = 0;
  for (let y = BOX.y0; y < BOX.y1; y++)
    for (let x = BOX.x0; x < BOX.x1; x++) {
      const i = (y * RENDER_W + x) * 4;
      const la = lab(a[i], a[i + 1], a[i + 2]), lb = lab(b[i], b[i + 1], b[i + 2]);
      sum += Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
      n++;
    }
  assert.ok(n > 1000, `meanDeltaE: only ${n} interior pixels — the panel framing and the render size disagree`);
  return sum / n;
}

// ── (5) DISTINCTNESS, IN PIXELS ──────────────────────────────────────────────
// One JND is ΔE ~2.3 and a MEAN of 2.3 over a whole panel would still be a pair a user
// could not tell apart while comparing rows. The bar is set at 8 — around three JNDs
// averaged over every pixel — which is where the cut candidates sat (8.9 and 9.5) and
// comfortably below the shipped minimum, so it fails on a NEW near-duplicate rather
// than on ordinary retuning of an existing one.
const MIN_PAIRWISE_DELTA_E = 8;
test("(5) every pair of presets is VISIBLY different over a varied backdrop", () => {
  const shots = plugin.presets.map((p) => ({ name: p.name, px: renderPanel(p.props, p.name.replace(/\s+/g, "_").toLowerCase()) }));
  let worst = { d: Infinity, a: null, b: null };
  for (let i = 0; i < shots.length; i++)
    for (let j = i + 1; j < shots.length; j++) {
      const d = meanDeltaE(shots[i].px, shots[j].px);
      if (d < worst.d) worst = { d, a: shots[i].name, b: shots[j].name };
    }
  assert.ok(worst.d >= MIN_PAIRWISE_DELTA_E,
    `"${worst.a}" and "${worst.b}" render at mean ΔE ${worst.d.toFixed(2)} over the panel — below the ${MIN_PAIRWISE_DELTA_E} bar, so the pane would show two rows a user cannot tell apart. Move one along an axis that changes pixels, or drop it.`);
  console.log(`      closest pair: "${worst.a}" vs "${worst.b}" at ΔE ${worst.d.toFixed(2)} (bar ${MIN_PAIRWISE_DELTA_E})`);
});

// ── (6) THE `absorb` GATE, IN BYTES ──────────────────────────────────────────
test("(6) at frost 0 / absorb 0 the tint reaches NO pixel (the gate that made `absorb` safe to add)", () => {
  const clear = { blurRadius: 12, frost: 0, absorb: 0 };
  const white = renderPanel({ ...clear, tint: "rgb(255,255,255)" }, "gate_tint_white");
  const red = renderPanel({ ...clear, tint: "rgb(255,0,0)" }, "gate_tint_red");
  let differing = 0;
  for (let i = 0; i < white.length; i++) if (white[i] !== red[i]) differing++;
  assert.equal(differing, 0,
    `${differing} of ${white.length} bytes differ between a white and a saturated tint at frost 0 / absorb 0 — the tint is reaching pixels through an UNGATED term, so "absorb 0 renders exactly what this material shipped with" is no longer true`);
});

console.log(`\n${passed} checks passed over ${plugin.presets.length} presets; shots in ${SHOT_DIR.replace(path.resolve(here, "../../../.."), ".")}`);
