/**
 * THE TEXT-FAMILY PRESET LIBRARIES — plain node, no browser.
 * Run: node src/demo_apps/PowerRP/tests/text_presets_test.js
 *
 * Six widgets that all draw ONE ir.js text() op: the rich text widget, plaintext,
 * the number readout, and the three text-morph demo widgets. The seventh sibling,
 * `latex`, is NOT here and cannot be: MathJax needs a DOM, so a bare-node render of
 * it draws nothing at all (measured — the raster module says so out loud). Its
 * library is proven by tests/latex_presets_probe.js in a real browser.
 *
 * WHAT IS ALREADY PROVEN ELSEWHERE AND IS NOT REPEATED HERE. Invented keys, empty
 * props, name/description presence and uniqueness, equation form, identical-props
 * pairs, placement keys, and per-row value legality (range, colour parse, select
 * options, boolean type) are all checked over EVERY registered plugin by
 * tests/preset_contract_test.js. Family key-set disjointness is checked over every
 * plugin by tests/tool_groups_test.js. Duplicating any of them here would be a
 * second copy of a rule, which is the defect this round exists to remove.
 *
 * WHAT ONLY THIS FILE CAN PROVE, in four checks:
 *
 *   (1) COMPLETENESS. app.applyPreset writes `props` as an OVERLAY, so a knob one
 *       row omits keeps whatever the PREVIOUSLY hovered row left there — one
 *       missing key makes two rows' rendering depend on hover order. The expected
 *       key set is DERIVED as the union over the family's own rows, so the gate
 *       cannot go stale against a table it does not read.
 *
 *   (2) NO PRESET WRITES THE CONTENT. These widgets' content is the user's own
 *       words (`text`, `source`, `from`/`to`) or its live equation binding
 *       (`value`), and `alpha` is the morph widgets' ANIMATION CHANNEL — writing it
 *       on the current slide overwrites the keyframe the whole widget exists for.
 *       The forbidden set is derived from each subject's own sample content, so it
 *       cannot drift from what the widget actually holds.
 *
 *   (3) DISTINCTNESS IN PIXELS, INCLUDING AGAINST THE WIDGET'S OWN DEFAULTS. A
 *       preset table whose rows differ is worthless if its RENDERS do not, and the
 *       defaults row is the one comparison a preset-versus-preset sweep can never
 *       make: a widget whose untouched state renders identically to a shipped row
 *       has a dead row nothing else can see. Scored with the SHARED metric
 *       (tests/imageDistinctness.js) rather than a seventh transcription of a
 *       per-probe pixel diff.
 *
 *   (4) THE SEGMENT-FACE GATE, DERIVED FROM THE SHIPPED FONT FILE. DSEG7 carries 69
 *       codepoints and none of `$ % , + /`. A missing glyph does NOT draw as tofu:
 *       it resolves through the Skia fallback chain, so a proportional comma appears
 *       in the middle of the segment digits — a plausible-looking wrong picture,
 *       which is worse than an obvious one. The expectation is read out of
 *       fonts/DSEG7Classic-Regular.ttf's own cmap rather than restated here, so it
 *       cannot disagree with the font the app actually ships.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { newDocument } from "../core/document.js";
import { createRegistry, presetFamiliesOf } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { cameraRect } from "../core/derive.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR, evaluatedStateAt } from "../web/cameraFrame.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { committedFaces, FALLBACK_FACES } from "../render_gpu/fonts.js";
import { closestPair, imageDistance, indistinguishable, DISPLAYABLE_CODE_VALUE } from "./imageDistinctness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(here, "../.claude_vlm_checks/text_presets_test");
const FONTS_DIR = path.resolve(here, "../fonts");

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

// ── the subjects ─────────────────────────────────────────────────────────────
// One sentence, used for every widget that takes free text, chosen so that every
// knob these libraries touch actually moves: several WORDS (so wordSpacing and
// justify have something to act on), enough characters to WRAP at body size in the
// box below (so lineSpacing and align move pixels), mixed case and figures (so a
// face change is visible in more than one letter shape).
const SAMPLE = "Hamburgefonstiv quick brown fox 0123";
// The morph widgets are frozen MID-TRANSITION so their transition contributes to
// the picture — at alpha 1 a scramble is just plain text and the widget's own
// character would be untested. Deterministic: the transitions are pure functions
// of (strings, alpha), with no clock in the path.
const MORPH_ALPHA = 0.62;
// A value that exercises every numeric format in the readout library at once: four
// fractional digits to round away, four integer digits to group, and no leading
// zero of its own so the pad styles are visible.
const READOUT_VALUE = 1234.5678;

/**
 * THE SUBJECTS. `content` is BOTH the sample state each widget is rendered with AND
 * the derivation of check (2)'s forbidden key set — one declaration, so a preset
 * that started writing the content could never slip past by the table forgetting to
 * list the key.
 */
// TWO ORTHOGONAL FAMILIES HAVE TO BE SCORED AGAINST EACH OTHER. The rich text
// widget's ink family writes no type keys at all, so left alone it would be scored
// at the widget's 36u default — and an ink specified RELATIVE to the type it sits
// on (a 1.5u letterpress lip, a 1.4u feather, a 4u poster offset) barely exists at
// 36u. That is a fact about the FIXTURE, not about the presets: the same rows read
// plainly on the headline they are for. So the ink family is scored on a headline,
// centred so it crosses the colour band. Naming the companion here rather than
// widening the bar keeps the gate honest about what it measured.
const INK_COMPANION_SIZE = 96;
const SUBJECTS = [
  {
    type: "text",
    content: { text: { runs: [{ text: SAMPLE }], paras: [{}] } },
    companions: { "presets.ink": { size: INK_COMPANION_SIZE, align: "center", valign: "middle" } },
  },
  { type: "plaintext", content: { text: SAMPLE } },
  { type: "number", content: { value: READOUT_VALUE } },
  { type: "demo_text_type", content: { source: SAMPLE, alpha: MORPH_ALPHA } },
  { type: "demo_text_scramble", content: { source: SAMPLE, alpha: MORPH_ALPHA } },
  { type: "demo_text_dissolve", content: { from: SAMPLE, to: "Departure 1945 Platform 4", alpha: MORPH_ALPHA } },
];

// ── (1) completeness ─────────────────────────────────────────────────────────
/**
 * Pure function. The union of every key any row of a family writes — the key set
 * that family has committed to, derived rather than restated.
 *
 * @param {object[]} presets - one family's presets
 * @returns {string[]} sorted key names
 *
 * @example familyKeys([{props: {size: 1, bold: true}}, {props: {bold: false}}])
 * // ["bold", "size"]
 */
function familyKeys(presets) {
  return [...new Set(presets.flatMap((p) => Object.keys(p.props ?? {})))].sort();
}

test("(1) within a family, every preset writes EVERY key the family uses", () => {
  for (const { type } of SUBJECTS)
    for (const family of presetFamiliesOf(registry.get(type))) {
      const want = familyKeys(family.presets);
      assert.ok(want.length >= 6, `${type}/${family.id}: only ${want.length} keys — a look family that thin should be a row on another family`);
      for (const preset of family.presets) {
        const missing = want.filter((k) => !(k in preset.props));
        assert.deepEqual(missing, [],
          `${type}/${family.id} "${preset.name}" omits ${missing.join(", ")} — an incomplete overlay makes this row's render depend on which row was hovered before it`);
      }
    }
});

test("(1b) a nested effect object is written COMPLETE, never partially", () => {
  // A PARTIAL nested object MERGES with what is already there rather than replacing
  // it, so `shadow: {opacity: 0}` alone inherits the previously hovered row's blur
  // and colour. The expected leaf set is derived from the widget's OWN registered
  // default for that bundle, so a sixth shadow key added tomorrow is demanded here.
  for (const { type } of SUBJECTS) {
    const plugin = registry.get(type);
    for (const family of presetFamiliesOf(plugin))
      for (const preset of family.presets)
        for (const [key, value] of Object.entries(preset.props)) {
          const reference = plugin.defaults?.[key];
          if (typeof value !== "object" || value === null || typeof reference !== "object" || reference === null) continue;
          const missing = Object.keys(reference).filter((leaf) => !(leaf in value));
          assert.deepEqual(missing, [],
            `${type}/${family.id} "${preset.name}".${key} omits ${missing.join(", ")} — a partial nested object MERGES, so those leaves keep the previously hovered row's values`);
        }
  }
});

// ── (2) no preset writes the content ─────────────────────────────────────────
test("(2) no preset writes the widget's CONTENT or its morph channel", () => {
  for (const { type, content } of SUBJECTS) {
    const forbidden = Object.keys(content);
    for (const family of presetFamiliesOf(registry.get(type)))
      for (const preset of family.presets) {
        const illegal = forbidden.filter((k) => k in preset.props);
        assert.deepEqual(illegal, [],
          `${type}/${family.id} "${preset.name}" writes ${illegal.join(", ")} — that is the user's own words, their live equation binding, or the keyframe channel the widget exists for`);
      }
  }
});

// ── the render rig ───────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const CK_BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(CK_BIN, f) });

/**
 * Query→build (reads the font files). The FontCollection these scenes need, built
 * exactly the way render_gpu/skia/node_render.js builds it — the committed
 * selectable families plus the Noto fallback chain, with fallback enabled. Every
 * check below is about GLYPHS, so an empty collection (which is all a scene with no
 * text needs, and what the sibling material suites make) would render six blank
 * frames and pass every distinctness comparison for the wrong reason.
 *
 * @returns {object} a CanvasKit FontCollection
 */
function buildFontCollection() {
  const provider = CanvasKit.TypefaceFontProvider.Make();
  const faces = [
    ...committedFaces().map((f) => ({ family: f.cssFamily, file: f.file })),
    ...FALLBACK_FACES.map((f) => ({ family: f.family, file: f.file })),
  ];
  const missing = [];
  for (const { family, file } of faces) {
    const p = path.join(FONTS_DIR, file);
    if (!fs.existsSync(p)) { missing.push(file); continue; }
    provider.registerFont(fs.readFileSync(p), family);
  }
  assert.deepEqual(missing, [], `font files missing from fonts/: ${missing.join(", ")} — every face below would silently degrade to the default`);
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(provider);
  fc.enableFontFallback();
  return fc;
}
const fontCollection = buildFontCollection();

// A 1920x1080 camera because every size in these libraries was chosen against that
// canvas, rendered at half of it — so the smallest row in the set (the 18u legal
// fine print) still gets 9 render px of body size and resolves as letters rather
// than as a grey smear.
const RENDER_W = 960, RENDER_H = 540;
const CAM = { x: 0, y: 0, w: 1920, h: 1080 };
// The 5% graphics-safe box of that canvas, which is the box these libraries assume:
// wide enough that a body-size row WRAPS (so leading and align move pixels) and tall
// enough that the three vertical alignments land in three different places.
const SAFE_INSET_X = CAM.w * 0.05, SAFE_INSET_Y = CAM.h * 0.05;
const BOX = { x: SAFE_INSET_X, y: SAFE_INSET_Y, w: CAM.w - 2 * SAFE_INSET_X, h: CAM.h - 2 * SAFE_INSET_Y };

// The vertical stripe pitch, in canvas units. Chosen against the type it has to
// serve: at 40 units a stripe is narrower than one glyph of the biggest row in the
// set (220u) and about four glyphs of the smallest (18u), so EVERY row has some of
// its ink over light ground and some over dark, whatever its size or alignment.
const STRIPE_PITCH = 40;

/**
 * Pure function. THE BACKDROP, as item specs — fine light/dark vertical stripes
 * crossed by a band of saturated blocks.
 *
 * THE STRIPES ARE THE WHOLE POINT, and both simpler grounds were tried first and
 * MEASURED WRONG, in opposite directions:
 *   A LIGHT HALF AND A DARK HALF put each preset's ink wholly on one side, because
 *     a preset also chooses its own alignment: the right-aligned near-black readouts
 *     all landed on the dark half and the left-aligned near-white terminal rows all
 *     landed on the light one. Both groups rendered nearly invisible, and the check
 *     then passed them as "distinct" on a handful of antialiased pixels — the
 *     closest number pair came back at maxAbs 8 for two plainly different strings.
 *   ONE MID TONE fixed those two and broke the MID-GREY inks instead: a #6b7280
 *     footnote against a #7a7a7a ground is a 15-code-value difference, so a
 *     perfectly ordinary caption measured as nearly invisible.
 * A ground with no tone is impossible, so the answer is a ground with BOTH tones at
 * a pitch finer than a word: every ink in the set — near-black, near-white and mid
 * grey alike — then has part of its own line over contrasting ground. This is a
 * DISTINCTNESS fixture, not a picture of a slide.
 *
 * The blocks sit in the vertical middle, where the centred and middle-aligned rows
 * land: they give the one `multiply` row something to multiply into (multiply over a
 * neutral ground is a look nobody would recognise) and they put a face change over
 * colour as well as over neutral.
 *
 * @returns {object[]} [{type, ...state}] in z order
 *
 * @example backdropSpecs()[0].fill // "#f2efe6"  (the light field the stripes sit on)
 * @example backdropSpecs().filter((s) => s.fill === "#12141c").length // 24 (the dark stripes)
 */
function backdropSpecs() {
  const BLOCK_W = 300, BLOCK_H = 260, BLOCK_GAP = 120, BLOCK_X0 = 160;
  const stripes = [];
  for (let x = 0; x < CAM.w; x += STRIPE_PITCH * 2)
    stripes.push({ type: "rect", x, y: 0, w: STRIPE_PITCH, h: CAM.h, z: 2, fill: "#12141c", strokeWidth: 0 });
  return [
    { type: "rect", x: 0, y: 0, w: CAM.w, h: CAM.h, z: 1, fill: "#f2efe6", strokeWidth: 0 },
    ...stripes,
    ...["#e5484d", "#30a46c", "#0090ff", "#ffb224"].map((fill, i) => ({
      type: "rect", x: BLOCK_X0 + i * (BLOCK_W + BLOCK_GAP), y: (CAM.h - BLOCK_H) / 2, w: BLOCK_W, h: BLOCK_H, z: 3, fill, strokeWidth: 0,
    })),
  ];
}

/**
 * Command (allocates and frees a CanvasKit surface; writes a PNG). Renders one
 * widget through the SAME path the editor and the CLI use — evaluate, derive,
 * sceneIR, paint_skia — over the varied backdrop, and returns a decoded-image-shaped
 * record the shared metric accepts.
 *
 * @param {string} type - the widget type id
 * @param {object} state - sample content plus the preset's props
 * @param {string} label - PNG basename written under .claude_vlm_checks/
 * @returns {{width: number, height: number, data: Uint8Array}} RGBA
 */
function renderSubject(type, state, label) {
  const doc = newDocument();
  const items = doc.slides[0].delta.items;
  Object.assign(items[Object.keys(items)[0]], CAM, { background: "#808080" });
  backdropSpecs().forEach((spec, i) => { items[`bg${i}`] = { ...registry.get(spec.type).defaults, ...spec }; });
  items.subject = { ...registry.get(type).defaults, ...BOX, z: 100, ...state };
  const evaluated = evaluatedStateAt(doc, 0, 1, registry);
  const rect = cameraRect(evaluated, doc.meta);
  const surface = CanvasKit.MakeSurface(RENDER_W, RENDER_H);
  if (!surface) throw new Error("text_presets_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cameraFrameIR(evaluated, doc.meta, registry), fitRectView(rect, RENDER_W, RENDER_H, 1), {
    fontCollection, background: rect.background, makeSurface: (w, h) => CanvasKit.MakeSurface(w, h), quality: "full",
  });
  surface.flush();
  const img = surface.makeImageSnapshot();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, `${label}.png`), Buffer.from(img.encodeToBytes()));
  const data = img.readPixels(0, 0, { width: RENDER_W, height: RENDER_H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return { width: RENDER_W, height: RENDER_H, data };
}

/**
 * Pure function. A filesystem-safe basename for one rendered row.
 *
 * @example shotName("demo_text_type", "presets", "Green Terminal")
 * // "demo_text_type-presets-green_terminal"
 */
function shotName(type, familyId, name) {
  return `${type}-${familyId}-${name.replace(/\W+/g, "_").toLowerCase()}`;
}

// ── (3) distinctness in pixels ───────────────────────────────────────────────
// TWO BARS, BECAUSE A GLYPH LIBRARY BREAKS THE USUAL ONE. The shared metric ships
// only the floor that is DERIVABLE — one 8-bit code value, below which no display
// can show a pair apart — and says the rest is a judgement each family calibrates
// against a pair it knows to be correctly distinct. For a material family, meanAbs
// over the whole frame is that judgement. For TEXT it is a poor one on its own,
// because type is mostly BACKGROUND: two rows can sit at opposite ends of the box
// in different faces at different sizes and still agree on 97% of the frame, so
// meanAbs reads "small" for a pair nobody could confuse. Measured: the plaintext
// table's closest pair by meanAbs is Deck Caption versus Footnote at 0.024 — and
// looking at the two frames, one is sans at the TOP and the other a smaller serif
// at the BOTTOM. Correctly distinct, diluted by area.
//
//   MIN_MAX_ABS is the area-INDEPENDENT bar and does the real work: somewhere in
//     the frame, some channel must differ by this much. It is shared across all
//     seven families precisely because it does not depend on how much ink a row
//     puts down. Calibrated the same way as the meanAbs bars — two thirds of the
//     faintest pair measured anywhere in the set, which is the rich widget's
//     untouched default against "Paper Black" at 26. That pair is worth naming: the
//     preset's ink is #1a1a1a and the widget's default is #000000, exactly 26 code
//     values apart, so it is the CLOSEST row to a widget default in the whole
//     family — the ledger's dead-row case in its mildest form. It is kept because
//     its job is not its colour: it is the row that takes every effect back OFF,
//     and a comparison that starts from an already-effect-free default is
//     structurally unable to show that.
//   MIN_MEAN_ABS is the per-family area bar, set from each table's own measured
//     closest pair at roughly two thirds of it, so the gate fails on a NEW
//     near-duplicate rather than on ordinary retuning of a shipped row.
const MIN_MAX_ABS = 16;
const MIN_MEAN_ABS = {
  "text/presets.type": 0.09,
  "text/presets.ink": 0.2,
  "plaintext/presets": 0.1,
  "number/presets": 0.1,
  "demo_text_type/presets": 0.08,
  "demo_text_scramble/presets": 0.07,
  "demo_text_dissolve/presets": 0.2,
};

/**
 * Pure function. The pair with the SMALLEST maxAbs — the area-independent narrowest
 * margin, which the shared closestPair cannot answer because it ranks by meanAbs.
 *
 * @param {Array<{name: string, png: object}>} frames - decoded frames, each named
 * @returns {{a: string, b: string, maxAbs: number}|null} null for fewer than two
 *
 * @example // faintestPair([{name: "A", png: p}, {name: "B", png: q}])
 * // {a: "A", b: "B", maxAbs: 143}
 */
function faintestPair(frames) {
  let best = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const { maxAbs } = imageDistance(frames[i].png, frames[j].png);
      if (!best || maxAbs < best.maxAbs) best = { a: frames[i].name, b: frames[j].name, maxAbs };
    }
  return best;
}

test("(3) every preset renders DISTINCTLY from every sibling AND from the widget's own defaults", () => {
  for (const { type, content, companions } of SUBJECTS)
    for (const family of presetFamiliesOf(registry.get(type))) {
      const base = { ...content, ...(companions?.[family.id] ?? {}) };
      // THE DEFAULTS ARE IN THE COMPARISON. A widget whose untouched state renders
      // identically to a shipped row has a dead row, and no preset-versus-preset
      // sweep can see it — the default is not a preset. If this fires, the right
      // correction is to move the DEFAULT: the preset models a real thing and
      // carries a citation, the default is ours to choose.
      const frames = [
        { name: "(widget defaults)", png: renderSubject(type, base, shotName(type, family.id, "widget_defaults")) },
        ...family.presets.map((p) => ({
          name: p.name,
          png: renderSubject(type, { ...base, ...p.props }, shotName(type, family.id, p.name)),
        })),
      ];
      for (const frame of frames)
        assert.ok(imageDistance(frame.png, frames[0].png).maxAbs > 0 || frame.name === "(widget defaults)",
          `${type}/${family.id} "${frame.name}" is byte-identical to the untouched widget`);
      const worst = closestPair(frames);
      const faintest = faintestPair(frames);
      const key = `${type}/${family.id}`;
      const bar = MIN_MEAN_ABS[key];
      assert.ok(bar !== undefined, `no distinctness bar calibrated for ${key}`);
      assert.ok(!indistinguishable(worst.distance),
        `${key}: "${worst.a}" and "${worst.b}" differ by less than ${DISPLAYABLE_CODE_VALUE} code value anywhere — the same picture under two names`);
      assert.ok(faintest.maxAbs >= MIN_MAX_ABS,
        `${key}: "${faintest.a}" and "${faintest.b}" never differ by more than ${faintest.maxAbs} of 255 in any channel anywhere — below the ${MIN_MAX_ABS} bar, so the pane would show two rows a reader cannot tell apart`);
      assert.ok(worst.distance.meanAbs >= bar,
        `${key}: "${worst.a}" and "${worst.b}" render at meanAbs ${worst.distance.meanAbs.toFixed(3)}, below the ${bar} bar — move one along an axis that changes pixels, or drop it`);
      console.log(`      ${key.padEnd(30)} ${String(frames.length).padStart(2)} frames | narrowest meanAbs ${worst.distance.meanAbs.toFixed(3)} (bar ${bar}) "${worst.a}" vs "${worst.b}" | narrowest maxAbs ${faintest.maxAbs} (bar ${MIN_MAX_ABS}) "${faintest.a}" vs "${faintest.b}"`);
    }
});

// ── (4) the segment-face gate ────────────────────────────────────────────────
/**
 * Query (reads a font file). The Unicode codepoints a TrueType font's format-4
 * cmap subtable maps to a real glyph. Used to DERIVE what a segment-face preset may
 * name, rather than restating a character list that could drift from the shipped
 * font — the two-places-must-agree rule.
 *
 * @param {string} file - a filename under fonts/
 * @returns {Set<number>} mapped codepoints
 *
 * @example // cmapCodepoints("DSEG7Classic-Regular.ttf").size // 69
 * @example // cmapCodepoints("DSEG7Classic-Regular.ttf").has(0x30) // true (the digit 0)
 * @example // cmapCodepoints("DSEG7Classic-Regular.ttf").has(0x24) // false (no dollar sign)
 */
function cmapCodepoints(file) {
  const buf = fs.readFileSync(path.join(FONTS_DIR, file));
  const TABLE_DIR = 12, TABLE_RECORD = 16, FORMAT_4 = 4, LAST_CODE = 0xffff;
  let cmapOffset = 0;
  for (let i = 0; i < buf.readUInt16BE(4); i++) {
    const record = TABLE_DIR + i * TABLE_RECORD;
    if (buf.toString("ascii", record, record + 4) === "cmap") cmapOffset = buf.readUInt32BE(record + 8);
  }
  assert.ok(cmapOffset, `${file}: no cmap table`);
  let sub = 0;
  for (let i = 0; i < buf.readUInt16BE(cmapOffset + 2); i++) {
    const offset = cmapOffset + buf.readUInt32BE(cmapOffset + 4 + i * 8 + 4);
    if (buf.readUInt16BE(offset) === FORMAT_4) sub = offset;
  }
  assert.ok(sub, `${file}: no format-4 cmap subtable`);
  const segCountX2 = buf.readUInt16BE(sub + 6);
  const endO = sub + 14, startO = endO + segCountX2 + 2, deltaO = startO + segCountX2, rangeO = deltaO + segCountX2;
  const out = new Set();
  for (let i = 0; i < segCountX2 / 2; i++) {
    const end = buf.readUInt16BE(endO + i * 2), start = buf.readUInt16BE(startO + i * 2);
    const delta = buf.readInt16BE(deltaO + i * 2), rangeOffset = buf.readUInt16BE(rangeO + i * 2);
    for (let code = start; code <= end && code !== LAST_CODE; code++) {
      let glyph;
      if (rangeOffset === 0) glyph = (code + delta) & LAST_CODE;
      else {
        const at = rangeO + i * 2 + rangeOffset + (code - start) * 2;
        if (at + 1 >= buf.length) continue;
        glyph = buf.readUInt16BE(at);
        if (glyph) glyph = (glyph + delta) & LAST_CODE;
      }
      if (glyph) out.add(code);
    }
  }
  return out;
}

// The thousands separator formatNumber inserts. Named because the gate below is
// about THIS character being absent from THAT font, and a bare "," in an assertion
// reads as punctuation rather than as the subject.
const GROUPING_SEPARATOR = ",";
const SEGMENT_FONT_ID = "seg7";

test("(4) no segment-face preset names a character the segment font cannot draw", () => {
  const face = committedFaces().find((f) => f.file.startsWith("DSEG7"));
  assert.ok(face, "no DSEG7 face is registered — the segment presets below name a font that does not exist");
  const codepoints = cmapCodepoints(face.file);
  assert.ok(codepoints.size > 40 && codepoints.size < 200,
    `DSEG7 cmap reports ${codepoints.size} codepoints — that is not a segment font's coverage, so this gate is reading the wrong table and would pass anything`);
  assert.ok(!codepoints.has(GROUPING_SEPARATOR.codePointAt(0)),
    "DSEG7 now HAS a comma, so the grouping half of this gate no longer describes the shipped font — re-derive it");

  for (const { type } of SUBJECTS)
    for (const family of presetFamiliesOf(registry.get(type)))
      for (const preset of family.presets) {
        if (preset.props.font !== SEGMENT_FONT_ID) continue;
        assert.notEqual(preset.props.group, true,
          `${type}/${family.id} "${preset.name}" pairs the segment face with thousands grouping — the separator has no glyph there and falls through to a PROPORTIONAL face mid-number, which reads as a typo rather than as an error`);
        for (const key of ["prefix", "suffix"])
          for (const ch of [...(preset.props[key] ?? "")])
            assert.ok(codepoints.has(ch.codePointAt(0)),
              `${type}/${family.id} "${preset.name}".${key} contains ${JSON.stringify(ch)}, which the segment face cannot draw — it would fall back to another face beside the digits`);
      }
});

const total = SUBJECTS.reduce((n, s) => n + presetFamiliesOf(registry.get(s.type)).reduce((m, f) => m + f.presets.length, 0), 0);
console.log(`\n${passed} checks passed over ${total} presets in ${SUBJECTS.length} widgets; shots in ${SHOT_DIR.replace(path.resolve(here, "../../../.."), ".")}`);
