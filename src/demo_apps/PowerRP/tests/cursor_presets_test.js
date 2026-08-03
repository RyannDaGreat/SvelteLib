/**
 * THE `cursor` PRESET LIBRARY suite — plain node, no browser.
 * Run: node src/demo_apps/PowerRP/tests/cursor_presets_test.js
 *
 * The shape is tests/frosted_presets_test.js's, minus the half that moved:
 * placement keys, values legal for their own Inspector row, names, descriptions,
 * uniqueness, equation form and identical-props are proven ONCE for the whole
 * roster in tests/preset_contract_test.js, so a second dialect of them here would
 * be the mirror defect this round exists to remove.
 *
 * THREE FACTS ABOUT THIS WIDGET DECIDED THE SHAPE OF THIS FILE, and each was
 * MEASURED rather than assumed:
 *
 *   (a) IT IS PURE VECTOR, so bare node is enough. The glyph name reaches
 *     render_gpu/gpu/svg_raster.js, which reads like the image path that the
 *     software surface cannot draw (no createImageBitmap) — and it is not:
 *     emit() returns pushTransform + six `path` ops. No Chrome, no capture hang,
 *     ~2 s for the whole library.
 *
 *   (b) IT IS A THIN SUBJECT, so the distinctness mean is taken over the LIT SET
 *     and not the frame. A pointer glyph inks a small share of any frame that
 *     contains it, so a whole-frame mean divides the real difference by the
 *     large area neither preset touches — the reduction W4-G measured at 185x
 *     dilution on connectors, where it turned a real collision (5.53 lit-set)
 *     into 0.030 and no whole-frame threshold could separate it from a real
 *     distinction. Coverage is PRINTED beside the mean, because a family that
 *     adopts the lit-set reduction without measuring its own coverage is
 *     borrowing a connector's problem: god rays covers 96.5% and the two means
 *     agree there within 3%.
 *
 *   (c) THE EDITOR'S FROZEN CLOCK MAKES SPIN RATES ALIAS, and check (3) pins it
 *     as a rule rather than leaving it to be rediscovered. particleTime()
 *     returns a fixed 2 s outside the presenter (core/particles.js) and the angle
 *     is t * revs * 2*PI, so the frozen angle is 4*PI*revs: two spin rates
 *     differing by any multiple of 0.5 rev/s render BYTE-IDENTICALLY in the
 *     editor, the CLI, a thumbnail AND this suite. 0.5, 1.0, 1.5 and 2.0 all
 *     freeze at angle 0. One spinning preset ships, so nothing collides today —
 *     but the next author needs to be stopped, not warned in prose.
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
import { imageDistance, litSetDistance } from "./imageDistinctness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(here, "../.claude_vlm_checks/cursor_presets_test");
const TYPE = "cursor";

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

// `preserveAspect` is how the glyph FITS its box — the flareScale test
// (plugins/demo/lens_flare.js), so it is composition, not look. A user who
// stretched a pointer deliberately must not lose that to a look pick.
const EXCLUDED = new Set(["preserveAspect"]);
// Universal chrome. `animated` is deliberately NOT here: unlike a performance
// flag it is the ON/OFF switch for the very thing `spin` configures, so a preset
// writing `spin: true` without it silently does nothing in the presenter.
const NOT_LOOK = new Set([
  "type", "x", "y", "cx", "cy", "w", "h", "z", "rotation", "scale", "rotationAnchor"
]);

/**
 * Pure function. The widget's LOOK keys, derived from its REGISTERED inspector, so
 * a knob added tomorrow joins the set with no edit here and check (1) starts
 * demanding it of every preset.
 *
 * TOP-LEVEL SEGMENTS, because that is the granularity a preset writes at:
 * `app.applyPreset` builds `["items", id, key]` with no dotted-path split, so a
 * bundle is written as a WHOLE OBJECT. The effects rows are declared dotted
 * (`shadow.dx`, `bloom.radius`) and their bundle heads appear in `defaults` but
 * never as a row key, so reading row keys verbatim finds SEVEN look knobs where
 * this widget has eleven — which is how a completeness check quietly stops
 * demanding the five effects a pointer treatment is mostly made of.
 *
 * @param {object} p - a registered plugin
 * @returns {string[]} top-level look keys, inspector order, deduplicated
 *
 * @example // lookKeys(registry.get("cursor"))
 * // ["cursorKind", "spin", "spinRevsPerSec", "animated", "opacity",
 * //  "shadow", "bloom", "blendMode", "innerShadow", "softEdges"]
 */
function lookKeys(p) {
  const heads = (p.inspector ?? []).map((r) => r.key).filter(Boolean).map((k) => k.split(".")[0]);
  return [...new Set(heads)].filter((k) => !NOT_LOOK.has(k) && !EXCLUDED.has(k) && k in p.defaults);
}

test("(1) every preset sets EVERY look knob", () => {
  const want = lookKeys(plugin);
  assert.ok(want.length >= 8, `only ${want.length} look keys found — lookKeys is mis-deriving`);
  assert.ok(plugin.presets?.length >= 10, `${TYPE} declares ${plugin.presets?.length ?? 0} presets`);
  for (const preset of plugin.presets) {
    const missing = want.filter((k) => !(k in preset.props));
    assert.deepEqual(missing, [],
      `"${preset.name}" omits ${missing.join(", ")} — applyPreset is an OVERLAY, so an omitted knob keeps whatever the previously HOVERED row left there and this row's render becomes hover-order dependent`);
  }
});

test("(2) no preset writes a knob that says how the glyph FITS its box", () => {
  for (const preset of plugin.presets) {
    const illegal = Object.keys(preset.props).filter((k) => EXCLUDED.has(k) || NOT_LOOK.has(k));
    assert.deepEqual(illegal, [], `"${preset.name}" writes ${illegal.join(", ")} — a pick would undo the user's own framing`);
  }
});

// ── (3) the frozen-clock aliasing rule ───────────────────────────────────────
// core/particles.js freezes the editor clock, and plugins/demo/cursor.js turns the
// glyph by t * revs * 2*PI. At the freeze the angle is 4*PI*revs, so rates a whole
// multiple of 0.5 apart are the SAME PICTURE everywhere a preset is previewed.
const ALIASING_PERIOD_REVS_PER_SEC = 0.5;

/**
 * Pure function. Do two spin rates land on the same frozen angle?
 *
 * @param {number} a - revolutions per second
 * @param {number} b - revolutions per second
 * @returns {boolean}
 *
 * @example spinRatesAlias(0.5, 1.5) // true  (both freeze at angle 0)
 * @example spinRatesAlias(1.06, 0.75) // false
 */
function spinRatesAlias(a, b) {
  const turns = Math.abs(a - b) / ALIASING_PERIOD_REVS_PER_SEC;
  return Math.abs(turns - Math.round(turns)) < 1e-9;
}

test("(3) no two SPINNING rows sit an aliasing period apart, the defaults included", () => {
  // The DEFAULT spins too, so it is a row here for the same reason it is a row in
  // the pixel sweep: a preset that freezes at the default's angle is a dead row
  // that no preset-vs-preset comparison can see.
  const spinning = [{ name: "(widget defaults)", props: plugin.defaults }, ...plugin.presets]
    .filter((p) => p.props.spin === true);
  assert.ok(spinning.length >= 2, `only ${spinning.length} spinning row(s) — this check would be vacuous`);
  for (let i = 0; i < spinning.length; i++)
    for (let j = i + 1; j < spinning.length; j++)
      assert.ok(!spinRatesAlias(spinning[i].props.spinRevsPerSec, spinning[j].props.spinRevsPerSec),
        `"${spinning[i].name}" and "${spinning[j].name}" spin at ${spinning[i].props.spinRevsPerSec} and ${spinning[j].props.spinRevsPerSec} rev/s — a whole multiple of ${ALIASING_PERIOD_REVS_PER_SEC} apart, so at the editor's frozen clock they are the SAME ANGLE and render byte-identically in every preview the user will ever see`);
  assert.ok(spinRatesAlias(0.5, 1.5) && !spinRatesAlias(1.06, 0.75),
    "the aliasing predicate is not discriminating — this check would pass vacuously");
});

// ── the RENDER rig, shared by check (4) ──────────────────────────────────────
const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const CK_BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(CK_BIN, f) });
const fontCollection = CanvasKit.FontCollection.Make(); // these scenes carry no text

// The pointer is drawn LARGE relative to the frame on purpose. A preset here is a
// treatment of a small glyph — a 3-sigma contact shadow, a feathered edge — and at
// a realistic slide scale those differences are a handful of pixels. The camera is
// tight so the suite measures the TREATMENT rather than the page.
const RENDER_W = 220, RENDER_H = 220;
const CAM = { x: 0, y: 0, w: 220, h: 220 };
const POINTER = { x: 50, y: 40, w: 120, h: 120 };
// Mid-grey: a pointer is black ink with a black shadow and a white glow, so a light
// backdrop hides the halo presets and a dark one hides the shadow presets.
const BACKDROP = "#8a8f98";

/**
 * Query→build. A one-slide document holding THE camera and one pointer at the
 * plugin's defaults with `props` overlaid. Slide 0's delta creates everything,
 * which is the document model's own rule.
 *
 * @param {object} props - look-knob overrides, {} for the untouched widget
 * @returns {object} a PowerRP document
 */
function docOf(props) {
  const doc = newDocument();
  const items = doc.slides[0].delta.items;
  Object.assign(items[Object.keys(items)[0]], CAM, { background: BACKDROP });
  items.pointer = { ...plugin.defaults, ...POINTER, z: 100, ...props };
  return doc;
}

/**
 * Command (allocates and frees a CanvasKit surface; writes a PNG). Renders through
 * the SAME path the editor and the CLI use — evaluate, derive, sceneIR, paint_skia.
 *
 * @param {object|null} props - overrides, or null for an EMPTY frame (the reference)
 * @param {string} label - PNG basename written under .claude_vlm_checks/
 * @returns {{width: number, height: number, data: Buffer}} decoded RGBA
 */
function renderPointer(props, label) {
  const doc = docOf(props ?? {});
  if (!props) delete doc.slides[0].delta.items.pointer;
  const state = evaluatedStateAt(doc, 0, 1, registry);
  const camera = cameraRect(state, doc.meta);
  const surface = CanvasKit.MakeSurface(RENDER_W, RENDER_H);
  if (!surface) throw new Error("cursor_presets_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cameraFrameIR(state, doc.meta, registry), fitRectView(camera, RENDER_W, RENDER_H, 1), {
    fontCollection, background: camera.background, makeSurface: (w, h) => CanvasKit.MakeSurface(w, h), quality: "full"
  });
  surface.flush();
  const img = surface.makeImageSnapshot();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, `${label}.png`), Buffer.from(img.encodeToBytes()));
  const data = Buffer.from(img.readPixels(0, 0, {
    width: RENDER_W, height: RENDER_H,
    colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB
  }));
  img.delete();
  surface.dispose();
  return { width: RENDER_W, height: RENDER_H, data };
}

/**
 * Pure function. A filesystem-safe basename for a preset.
 *
 * @param {string} name - a preset name
 * @returns {string}
 *
 * @example slug("Contact Shadow Pointer") // "contact-shadow-pointer"
 */
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const emptyFrame = renderPointer(null, "00-no-pointer");
// THE UNTOUCHED WIDGET IS A ROW IN THE COMPARISON (ledger C-16): a default that
// renders as some preset is a dead row no preset-vs-preset check can ever see.
const frames = [{ name: "(widget defaults)", png: renderPointer({}, "01-defaults") }];
plugin.presets.forEach((p, i) => frames.push({ name: p.name, png: renderPointer(p.props, `${String(i + 2).padStart(2, "0")}-${slug(p.name)}`) }));

// ── (4) pixel distinctness ───────────────────────────────────────────────────
// CALIBRATED BETWEEN TWO MEASURED ANCHORS, both of which this file re-measures on
// every run so neither can rot into a transcribed number:
//   MUST FAIL — the cut "Highlight Halo" against "Recording Pointer", 1.657.
//   MUST PASS — "Crisp Pointer" against "Contact Shadow Pointer", 4.209, which is
//     a shadow against no shadow and is plainly two pictures.
// 2.5 sits between them. The floor below which no display can show a pair apart is
// one code value (DISPLAYABLE_CODE_VALUE), so this is 2.5x that as well.
const MIN_PAIR_LIT_MEAN = 2.5;

// The row cut by measurement, kept as a FIXTURE so the gate proves it can fail on
// every run rather than on the day someone reads this comment. It is "Recording
// Pointer" plus bloom 30 @ 0.65; if a future change to the bloom path makes that
// stack visible, THIS CHECK FAILS and says the preset may come back.
const REJECTED_HIGHLIGHT_HALO = {
  cursorKind: "default", spin: false, spinRevsPerSec: 0.75, animated: false, opacity: 1,
  shadow: { dx: 0, dy: 0, blur: 8, color: "#000000", opacity: 0.6 },
  bloom: { radius: 30, strength: 0.65 },
  innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
  softEdges: 0, blendMode: "normal", gaussianBlur: 0
};

test("(4) every pair renders distinguishably over the lit set, the defaults included", () => {
  const tight = [];
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const lit = litSetDistance(frames[i].png, frames[j].png, emptyFrame);
      const whole = imageDistance(frames[i].png, frames[j].png);
      const pair = { a: frames[i].name, b: frames[j].name, lit, whole };
      if (lit.meanAbs < MIN_PAIR_LIT_MEAN) tight.push(`${pair.a} <-> ${pair.b} (lit-set mean ${lit.meanAbs.toFixed(3)}, maxAbs ${whole.maxAbs})`);
      if (!narrowest || lit.meanAbs < narrowest.lit.meanAbs) narrowest = pair;
    }
  assert.deepEqual(tight, [],
    `these render as the same pointer: ${tight.join("; ")}. If one side is "(widget defaults)" the fix is normally to move the DEFAULT — unless the default is the sourced side, in which case the preset moves.`);
  console.log(`      narrowest: ${narrowest.a} vs ${narrowest.b} — lit-set mean ${narrowest.lit.meanAbs.toFixed(3)} over ${(100 * narrowest.lit.coverage).toFixed(1)}% of the frame, maxAbs ${narrowest.whole.maxAbs} (whole-frame mean ${narrowest.whole.meanAbs.toFixed(3)})`);
});

// ── (5) THE GATE MUST BE ABLE TO FAIL ────────────────────────────────────────
// Four gates found this round could not fail, each proving only the case its
// author pictured. A PIXEL gate cannot self-test on synthetic fixtures the way
// tests/square_chrome_test.js does, so it does the equivalent: it renders the row
// this library CUT and asserts the bound rejects it.
test("(5) the bound rejects the row that was cut, and the cut row is why the bound is where it is", () => {
  const recording = frames.find((f) => f.name === "Recording Pointer");
  assert.ok(recording, "the anchor preset was renamed — recalibrate before trusting check (4)");
  const rejected = litSetDistance(renderPointer(REJECTED_HIGHLIGHT_HALO, "99-rejected-highlight-halo"), recording.png, emptyFrame);
  assert.ok(rejected.meanAbs < MIN_PAIR_LIT_MEAN,
    `the cut "Highlight Halo" now measures ${rejected.meanAbs.toFixed(3)} against "Recording Pointer", ABOVE the bound of ${MIN_PAIR_LIT_MEAN} — either the bloom path changed and the preset can come back, or the bound has drifted. Do not silently raise it.`);
  console.log(`      the cut row measures ${rejected.meanAbs.toFixed(3)} against its collision partner; the bound is ${MIN_PAIR_LIT_MEAN}`);
});

console.log(`\n${passed} checks passed over ${plugin.presets.length} presets; shots in ${path.relative(process.cwd(), SHOT_DIR)}`);
