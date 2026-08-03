/**
 * THE `sky*` FAMILY suite — plain node, no browser.
 * Run: node src/demo_apps/PowerRP/tests/sky_family_test.js
 *
 * Two things live here because both are facts about the same four widgets that a bare
 * node run can PROVE, and neither has a home elsewhere:
 *
 *   THE PRESET LIBRARY's rules (checks 1–6). tests/tool_groups_test.js already proves
 *     the RESOLUTION rules over every plugin (a preset group exists; families are
 *     disjoint) and says nothing about a library's contents. The rule that actually
 *     bites is the one plugins/demo/lens_flare.js states in prose and nothing
 *     enforced: EVERY PRESET SETS EVERY LOOK KNOB. app.applyPreset writes exactly the
 *     keys in `props` as an OVERLAY, so a knob one preset omits keeps whatever the
 *     PREVIOUSLY hovered preset left there — the pane's whole purpose is comparing
 *     looks by running down the list, and one missing key makes two rows' rendering
 *     depend on the order they were hovered in. Twenty-nine presets over four widgets
 *     is well past what an eye can audit, so it is a check now.
 *
 *   THE DARK-HALO REGRESSION (check 7), in PIXELS, through the real pipeline. The
 *     user's report was "why does the sun have a dark shadow behind it?", and the
 *     cause was `skySun` compositing an EMISSION alpha with source-over (see the
 *     blendMode note in plugins/demo/sky.js). A unit assertion on the default string
 *     would pass while any of registry injection, ports.js's effects seam, or
 *     paint_skia's blend mapping quietly stopped honouring it — so this renders the
 *     sun over its own sky and measures the aureole annulus against the same sky with
 *     no sun in it. It costs a few seconds of CPU raster and it is the only check here
 *     that would have caught the bug.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { newDocument } from "../core/document.js";
import { createRegistry, presetFamiliesOf } from "../core/registry.js";
import { BUNDLES } from "../core/properties.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { cameraRect } from "../core/derive.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR, evaluatedStateAt } from "../web/cameraFrame.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { parseColor } from "../render_gpu/ir.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(here, "../.claude_vlm_checks/sky_family_test");

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
/** Command. Same, for a check that awaits. */
async function asyncTest(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

// THE FAMILY, and for each member the keys a preset may NOT write. `horizon` says how
// the dome FITS its box and `cornerRadius` is geometry, so both are composition, not
// look — the same exclusion plugins/demo/lens_flare.js makes for lightX/lightY/
// flareScale, for the same complaint (a pick must not undo a framing the user chose).
//
// `starSize` (R6-9.1) joins them, and its reason is the one the Bortle ladder gives:
// naked-eye star images are SEEING-limited, so their apparent size is a property of
// the atmosphere and the optics rather than of how dark the site is, and every rung
// of the ladder would carry the same number. It is also the knob an author reaches
// for to stylise a sky, which is exactly what the exclusion protects. See the STAR
// SIZE paragraph in plugins/demo/sky.js's preset doctrine.
const MEMBERS = ["sky", "skySun", "skyMoon", "skyClouds"];
const EXCLUDED = new Set(["horizon", "cornerRadius", "starSize"]);
// `trailSamples` is EXCLUDED FROM THE LOOK for a reason none of the three above give:
// it is a QUALITY/COST knob, not an appearance. It says how many samples the long
// exposure accumulates along its arc, and its only visible effect is whether a trail
// reads as a continuous line or beads — so it belongs to the exposure family (which
// does set it, and must, since a longer arc needs more samples) but it must not be
// demanded of the ATMOSPHERE presets, which have no opinion about render cost.
// It is handled by the per-family rule below rather than by this set: see FAMILY_KEYS.
// State the Inspector shows for every widget alike; a preset is a LOOK, so none of it
// belongs in one. The universal EFFECTS are in here too — a preset must not switch
// a user's shadow or feather on — with ONE exception, below.
// THE EFFECTS HALF IS DERIVED FROM BUNDLES.effects, not listed. It used to name the
// five by hand, and when the bundle gained a SIXTH (`gaussianBlur`) that list went
// stale in the most confusing possible way: the new row was not in NOT_LOOK, so
// lookKeys admitted it as a LOOK knob and this suite started demanding every preset
// SET a universal effect — the exact opposite of its own rule. Deriving it means the
// bundle can grow without this suite inverting its contract.
const EFFECT_KEYS = [...new Set(BUNDLES.effects.map((k) => k.split(".")[0]))];
const NOT_LOOK = new Set([
  "type", "x", "y", "w", "h", "z", "rotation", "scale", "rotationAnchor", "opacity", "animated",
  ...EFFECT_KEYS,
]);
// THE EXCEPTION. For `skySun` the blend is not an effect the user layered on, it is the
// difference between the widget ADDING light and SUBTRACTING it: source-over there
// composites an emission alpha and puts a grey ring round the disc (the reported bug).
// So its presets must all pin it, and its "Total Eclipse" — the one look where the disc
// OCCLUDES rather than emits — pins the other value. Same shape as demo_lens_flare,
// where all twelve name the blend and one names "add".
const BLEND_IS_LOOK = new Set(["skySun"]);

/**
 * Pure function. The keys of a widget's own LOOK, derived from the plugin's REGISTERED
 * inspector — so a knob added to a widget tomorrow joins this set with no edit here and
 * check (1) starts demanding it of every preset.
 *
 * @param {object} plugin - a registered plugin
 * @returns {string[]} look keys, inspector order
 *
 * @example // lookKeys(registry.get("skyClouds")) // ["coverage","softness","cloudScale","speed","ambient","base"]
 * @example // lookKeys(registry.get("skySun")) // ["color","intensity","size","glow","glowRadius","blendMode"]
 */
function lookKeys(plugin) {
  const blendIsLook = BLEND_IS_LOOK.has(plugin.type);
  return (plugin.inspector ?? [])
    .map((r) => r.key)
    .filter((k) => (k === "blendMode" ? blendIsLook : !NOT_LOOK.has(k) && !EXCLUDED.has(k) && k in plugin.defaults));
}

// THE EXPOSURE FAMILY'S OWN KEY SET (BM). `sky` now declares TWO families over
// disjoint keys — the ATMOSPHERE (the ten look knobs) and the EXPOSURE (the shutter).
// Completeness is therefore a PER-FAMILY rule, which is the form tests/crt_flicker_test.js
// states for the two-family case: with two families the user hovers back and forth
// between them, so a preset that omits one of its OWN family's knobs leaves whatever
// the previously hovered card in that family wrote. It must NOT be read as "every
// preset sets every knob of the widget" — that would demand the shutter of every
// atmosphere and the atmosphere of every shutter, which is exactly what splitting them
// was for.
const EXPOSURE_KEYS = ["trailArc", "trailSamples"];

/** Pure function. A family's own key set: the keys ANY of its presets writes.
 *
 * @param {{presets: Array<{props: object}>}} family
 * @returns {string[]}
 *
 * @example familyKeys({presets: [{props: {a: 1}}, {props: {b: 2}}]}) // ["a", "b"]
 */
function familyKeys(family) {
  return [...new Set(family.presets.flatMap((p) => Object.keys(p.props ?? {})))];
}


/** Query. Every preset of a widget, across ALL its families (BM: `sky` has two).
 *  Checks 2-5 are statements about EVERY preset regardless of which family it is in,
 *  so they iterate this rather than a `.presets` field that a multi-family widget
 *  does not have. */
function allPresets(type) {
  return presetFamiliesOf(registry.get(type)).flatMap((f) => f.presets);
}

// ── (1) THE COMPLETENESS RULE, PER FAMILY ────────────────────────────────────
test("(1) every preset sets EVERY knob of its OWN family", () => {
  for (const type of MEMBERS) {
    const plugin = registry.get(type);
    const families = presetFamiliesOf(plugin);
    assert.ok(families.length > 0, `${type} declares no presets`);
    for (const family of families) {
      assert.ok(family.presets.length > 0, `${type} / ${family.id}: an empty family`);
      // The family's own key set. For a single-family widget this IS the look-key set
      // (every preset writes every look knob), and the assertion below is the original
      // rule unchanged; for a multi-family widget it is that family's slice.
      const want = families.length === 1 ? lookKeys(plugin) : familyKeys(family);
      assert.ok(want.length >= 2, `${type} / ${family.id}: only ${want.length} keys — the key derivation is wrong`);
      for (const preset of family.presets) {
        const missing = want.filter((k) => !(k in preset.props));
        assert.deepEqual(missing, [], `${type} / ${family.id} / "${preset.name}" omits ${missing.join(", ")} — an incomplete overlay makes this row's render depend on which row in its family was hovered before it`);
      }
    }
  }
});

// THE SPLIT ITSELF, pinned: `sky` must keep TWO families and they must stay disjoint.
// tests/tool_groups_test.js proves disjointness generically; this names the two and
// asserts the ATMOSPHERE family still covers the look knobs, so folding the shutter
// back into the flat list (or letting an atmosphere start writing trailArc) is caught.
test("(1b) sky declares an ATMOSPHERE family and a disjoint EXPOSURE family", () => {
  const families = presetFamiliesOf(registry.get("sky"));
  assert.deepEqual(families.map((f) => f.id), ["presets.atmosphere", "presets.exposure"]);
  const atmo = new Set(familyKeys(families[0])), expo = familyKeys(families[1]);
  assert.deepEqual([...expo].sort(), [...EXPOSURE_KEYS].sort(),
    `the exposure family writes ${expo.join(",")} — it owns the shutter and nothing else`);
  const overlap = expo.filter((k) => atmo.has(k));
  assert.deepEqual(overlap, [], `both sky families write ${overlap.join(",")} — picking one would undo the other`);
  // "Instant" is the widget's DEFAULT state, so it is an exact no-op — the role
  // "Rock Steady" plays in CRT's flicker family. Without it there is no way back to a
  // normal photograph once a trail has been picked.
  const off = families[1].presets.find((p) => p.name === "Instant");
  assert.ok(off, "the exposure family has no OFF preset — a trail could not be cleared");
  assert.equal(off.props.trailArc, registry.get("sky").defaults.trailArc,
    "the exposure family's OFF preset does not match the widget's own default trailArc");
});

test("(2) no preset writes a COMPOSITION key (framing, geometry, transform, opacity)", () => {
  for (const type of MEMBERS)
    for (const preset of allPresets(type)) {
      const illegal = Object.keys(preset.props).filter((k) => EXCLUDED.has(k) || (NOT_LOOK.has(k) && !(k === "blendMode" && BLEND_IS_LOOK.has(type))));
      assert.deepEqual(illegal, [], `${type} / "${preset.name}" writes ${illegal.join(", ")} — a pick would undo the user's own framing`);
    }
});

test("(3) every preset has a unique name and its own description (the pane's hover tip)", () => {
  for (const type of MEMBERS) {
    const seen = new Set();
    for (const preset of allPresets(type)) {
      assert.equal(typeof preset.name, "string");
      assert.ok(preset.name.length > 0, `${type}: a preset with no name`);
      assert.ok(!seen.has(preset.name), `${type}: duplicate preset name "${preset.name}"`);
      seen.add(preset.name);
      // Without one, web/ToolsPane.svelte falls back to "Apply the … preset", which is
      // the row explaining nothing — the defect tests/lens_flare_presets_probe.js
      // check (2) exists to catch on the browser side.
      assert.ok(typeof preset.description === "string" && preset.description.length > 20,
        `${type} / "${preset.name}" has no real description, so its row would show ToolsPane's generic fallback`);
    }
  }
});

// ── (4) THE MULTI-WIDGET PAIRING, made checkable ─────────────────────────────
// A sky look spans several widgets and the preset mechanism cannot reach siblings, so
// the pairing is carried by SHARED NAMES: picking the same name on `sky` and on
// `skySun` is one look. That is only discoverable if the names really do match, and a
// rename on one side would silently break it.
const PAIRED_NAMES = ["High Mountain Air", "Clear Blue Noon", "Golden Hour", "City Haze", "Dust Haze"];
test("(4) sky and skySun share the paired names, and every description names its companions", () => {
  const names = (type) => allPresets(type).map((p) => p.name);
  const skyNames = names("sky"), sunNames = names("skySun");
  for (const n of PAIRED_NAMES) {
    assert.ok(skyNames.includes(n), `sky lost the paired preset "${n}"`);
    assert.ok(sunNames.includes(n), `skySun lost the paired preset "${n}"`);
  }
  // Each `sky` preset must point somewhere: at a companion widget, or at the one thing
  // no preset can do (place the sun, which IS the time of day).
  for (const preset of presetFamiliesOf(registry.get("sky"))[0].presets)
    assert.match(preset.description, /Sky Sun|Sky Moon|Sky Clouds|sun/,
      `sky / "${preset.name}" description names no companion — the pairing is then implicit, which is what this rule forbids`);
});

test("(5) every preset value is legal for its own Inspector row", () => {
  for (const type of MEMBERS) {
    const plugin = registry.get(type);
    const rows = new Map((plugin.inspector ?? []).map((r) => [r.key, r]));
    for (const preset of allPresets(type))
      for (const [key, value] of Object.entries(preset.props)) {
        const row = rows.get(key);
        assert.ok(row, `${type} / "${preset.name}" writes "${key}", which is not an Inspector row`);
        if (row.kind === "color") {
          const c = parseColor(value);
          assert.ok(Array.isArray(c) && c.length >= 3, `${type} / "${preset.name}".${key} = ${value} does not parse as a colour`);
        } else if (row.kind === "number" || row.kind === "angle") {
          assert.ok(typeof value === "number" && Number.isFinite(value), `${type} / "${preset.name}".${key} = ${value} is not a finite number`);
          if (row.min !== undefined) assert.ok(value >= row.min, `${type} / "${preset.name}".${key} = ${value} is below the row's min ${row.min}`);
          if (row.max !== undefined) assert.ok(value <= row.max, `${type} / "${preset.name}".${key} = ${value} is above the row's max ${row.max}`);
          if (row.step !== undefined) assert.equal(value % row.step, 0, `${type} / "${preset.name}".${key} = ${value} is off the row's step ${row.step}`);
        } else if (row.kind === "select") {
          assert.ok(row.options.includes(value), `${type} / "${preset.name}".${key} = ${value} is not one of ${row.options.join(", ")}`);
        }
      }
  }
});

// ── (6) THE EMISSIVE BLEND, as a declaration ─────────────────────────────────
test("(6) skySun alone defaults to an ADDITIVE blend; the three matter widgets stay normal", () => {
  assert.equal(registry.get("skySun").defaults.blendMode, "screen",
    "skySun must default to an additive blend — its shader's alpha is an EMISSION amount, so source-over subtracts light around the disc (the dark halo)");
  for (const type of ["sky", "skyMoon", "skyClouds"])
    assert.equal(registry.get(type).defaults.blendMode, "normal",
      `${type} carries a COVERAGE alpha over an albedo that does not scale with it, so it must stay source-over — under "screen" the moon's unlit limb goes transparent and the clouds' dark cores dissolve`);
  // skySun composes the bundle itself (it must, to default one effect ON —
  // tests/universal_effects_test.js (3)); the other three are injected.
  assert.equal(registry.get("skySun").effectsInjected, undefined, "skySun must compose the effects bundle itself, like demo_lens_flare");
  for (const type of ["sky", "skyMoon", "skyClouds"])
    assert.equal(registry.get(type).effectsInjected, true, `${type} changes no effect default, so it must stay INJECTED rather than hand-copy the bundle`);
  for (const preset of allPresets("skySun"))
    assert.ok(typeof preset.props.blendMode === "string",
      `skySun / "${preset.name}" omits blendMode — it could inherit a stale "normal" and bring the dark halo back`);
});

// ── (7) THE DARK-HALO REGRESSION, IN PIXELS ──────────────────────────────────
// Small on purpose: the sky dome is per-pixel SkSL on a software surface, and the halo
// is a ~50-luma effect that a 256x144 frame resolves with room to spare.
const RENDER_W = 256, RENDER_H = 144;
// The sun's aureole, as a fraction of its box half-extent: outside the disc (0.26 at
// the widget's default size) and inside the compact-support halo (HALO_REACH 0.99).
const AUREOLE_INNER = 0.30, AUREOLE_OUTER = 0.55;
// A dark ring this shallow is invisible; the measured defect was ~50 luma. The bar sits
// where a REGRESSION would have to be to matter, not at exact equality, because the
// blend arithmetic is not obliged to be bit-exact with "no sun at all".
const DARKENING_TOLERANCE = 1.0;

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const CK_BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(CK_BIN, f) });
const fontCollection = CanvasKit.FontCollection.Make(); // these scenes carry no text

// THE camera, sized so the sky covers it exactly and the render letterboxes nothing.
const CAM = { x: 0, y: 0, w: 1280, h: 720 };
const SUN_BOX = 300;
const SUN_CENTRE = { x: 440, y: 250 };

/**
 * Query→build. A one-slide document holding THE camera plus each spec at its plugin's
 * defaults. Slide 0's delta creates everything, which is the document model's own rule.
 *
 * @param {Array<object>} specs - [{type, ...state overrides}]
 * @returns {object} a PowerRP document
 */
function docOf(specs) {
  const doc = newDocument();
  const items = doc.slides[0].delta.items;
  Object.assign(items[Object.keys(items)[0]], CAM, { background: "#000000" });
  specs.forEach((spec, i) => { items[`sky${i}`] = { ...registry.get(spec.type).defaults, ...spec }; });
  return doc;
}

/**
 * Command (allocates and frees a CanvasKit surface; writes a PNG). Renders a document's
 * camera frame through the SAME path the editor and the CLI use — evaluate, derive
 * (so the sibling sky query runs), sceneIR (so the effects seam applies blendMode),
 * paint_skia — and returns unpremultiplied RGBA bytes.
 *
 * @param {object} doc - a PowerRP document
 * @param {string} label - PNG basename written under .claude_vlm_checks/
 * @returns {Uint8Array} RGBA, RENDER_W x RENDER_H
 */
function renderFrame(doc, label) {
  const state = evaluatedStateAt(doc, 0, 1, registry);
  const rect = cameraRect(state, doc.meta);
  const surface = CanvasKit.MakeSurface(RENDER_W, RENDER_H);
  if (!surface) throw new Error("sky_family_test: MakeSurface returned null");
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

/**
 * Pure function. Mean Rec.709 luma over the annulus [r0, r1) of the sun's box frame,
 * measured about the sun's centre in RENDER pixels.
 *
 * @param {Uint8Array} px - RGBA bytes, RENDER_W x RENDER_H
 * @param {number} r0 - inner radius, fraction of the sun box's half-extent
 * @param {number} r1 - outer radius, same units
 * @returns {number} 0..255
 *
 * @example // annulusLuma(bareSkyPixels, 0.30, 0.55) // ~250 (the sky's own aureole)
 */
function annulusLuma(px, r0, r1) {
  const sx = RENDER_W / CAM.w, sy = RENDER_H / CAM.h;
  const cx = SUN_CENTRE.x * sx, cy = SUN_CENTRE.y * sy, half = (SUN_BOX / 2) * sx;
  let sum = 0, n = 0;
  for (let y = 0; y < RENDER_H; y++)
    for (let x = 0; x < RENDER_W; x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / half;
      if (r < r0 || r >= r1) continue;
      const i = (y * RENDER_W + x) * 4;
      sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      n++;
    }
  assert.ok(n > 50, `annulusLuma: only ${n} pixels in [${r0}, ${r1}) — the framing constants and the render size disagree`);
  return sum / n;
}

await asyncTest("(7) the sun's aureole never DARKENS the sky it sits in (the reported dark halo)", () => {
  const sky = { type: "sky", x: 0, y: 0, w: CAM.w, h: CAM.h };
  const sun = { type: "skySun", x: SUN_CENTRE.x - SUN_BOX / 2, y: SUN_CENTRE.y - SUN_BOX / 2, w: SUN_BOX, h: SUN_BOX };
  // THE BASELINE is the sun present as a LIGHT but not DRAWN (opacity 0), not a sky with
  // no sun at all: the dome's day/night ramp is driven by the highest sun's elevation,
  // so removing the sun gives a NIGHT sky and nothing to compare an aureole against.
  // core/derive.collectSkyScene reads the sun's frame and colour regardless of opacity,
  // so the dome is identical and only the disc+halo op is withheld.
  const bare = annulusLuma(renderFrame(docOf([sky, { ...sun, opacity: 0 }]), "bare_sky"), AUREOLE_INNER, AUREOLE_OUTER);
  const shipped = annulusLuma(renderFrame(docOf([sky, sun]), "sun_shipped_default"), AUREOLE_INNER, AUREOLE_OUTER);
  const sourceOver = annulusLuma(renderFrame(docOf([sky, { ...sun, blendMode: "normal" }]), "sun_forced_normal"), AUREOLE_INNER, AUREOLE_OUTER);

  // THE DEFECT still exists under source-over — if this stops holding, the shader's
  // alpha convention changed and the reasoning in plugins/demo/sky.js is stale.
  assert.ok(sourceOver < bare - 10,
    `source-over should still darken the aureole by tens of luma (that is the defect this default avoids); bare ${bare.toFixed(1)} vs normal ${sourceOver.toFixed(1)}`);
  // THE FIX: at the shipped default the sun may only ADD light.
  assert.ok(shipped >= bare - DARKENING_TOLERANCE,
    `the shipped skySun default DARKENS its own sky's aureole by ${(bare - shipped).toFixed(1)} luma (bare ${bare.toFixed(1)} vs with-sun ${shipped.toFixed(1)}) — the dark halo is back`);
  console.log(`      aureole luma: bare sky ${bare.toFixed(1)} | shipped default ${shipped.toFixed(1)} | forced source-over ${sourceOver.toFixed(1)}`);
});

const totalPresets = MEMBERS.reduce((n, t) => n + allPresets(t).length, 0);
console.log(`\n${passed} checks passed over ${totalPresets} presets in ${MEMBERS.length} widgets; halo shots in ${SHOT_DIR.replace(path.resolve(here, "../../../.."), ".")}`);
