/**
 * THE EIGHT BOX-LEVEL TEXT ROWS MUST MOVE PIXELS.
 *
 * plugins/text.js exposes eight Inspector rows that are box-level FALLBACKS under
 * the rich value: font / size / bold / color underlie each RUN (resolved by
 * core/richtext.runFrom through emit's `inherited`), and align / lineSpacing /
 * charSpacing / wordSpacing underlie each PARAGRAPH (resolved by
 * core/richtext.paraStyleFor through the layout's `boxStyle`). All eight were
 * measured DEAD — byte-identical renderDocToPng output when changed — by two
 * distinct mechanisms, and this suite locks both fixes:
 *
 *   1. INERT (the paragraph four). normalizeRichText stamped
 *      `{...DEFAULT_PARA, ...stored}` into every paragraph, and paraStyleFor
 *      spreads the paragraph LAST, so the box layer could not win for ANY
 *      document shape. Fixed by storing only what was set.
 *   2. SHADOWED (the typography four). runFrom's `r.X ?? inherited.X ?? default`
 *      chain is correct and its unit tests pass; the app's own DEFAULT STATE
 *      pre-empted it by materializing all ten run keys into `defaults.text`.
 *      A live fallback outranked by a value the user never chose is SHADOWED, not
 *      inert — the sub-class that survives code review, because every piece is
 *      individually right and only the real default state exposes it.
 *
 * Bare node, no framework (suite conventions). The layout assertions use the
 * DOM-free monoMeasure seam so every number below is exact, not approximate.
 */

import assert from "node:assert/strict";
import { normalizeRichText, layoutRichText, paraStyleFor, monoMeasure, DEFAULT_PARA } from "../core/richtext.js";
import { leaves } from "../core/deltas.js";
import { textPlugin } from "../plugins/text.js";
import { DEFAULT_FONT } from "../render_gpu/fonts.js";

let passed = 0;
function test(name, fn) { fn(); console.log(`  ok  ${name}`); passed += 1; }

// monoMeasure: every glyph is `size` wide, ascent 0.8·size, descent 0.2·size — so
// with SIZE below, "ab" advances 2·SIZE and one line is exactly SIZE tall.
const SIZE = 10;
const BOX_W = 100;          // wide enough that "ab" leaves alignment slack
const AB_WIDTH = 2 * SIZE;  // monoMeasure("ab", {size: SIZE}).width
const AB_SLACK = BOX_W - AB_WIDTH;
const LINE_H = SIZE;        // (ascent 0.8 + descent 0.2) · size · lineSpacing 1

/** Pure function. The rich value a text box holds when the user has typed content
 * and set NO per-run/per-paragraph style — the shape `defaults.text` must be. */
function contentOnly(text = "ab") {
  return { runs: [{ text }], paras: [{}] };
}

/** Pure function. Lays `value` out under a box-level paragraph style, going
 * through normalizeRichText exactly as emit() does. Returns the layout. */
function laid(value, boxStyle, inherited = { size: SIZE }) {
  return layoutRichText(normalizeRichText(value, inherited), BOX_W, monoMeasure, boxStyle);
}

// ── mechanism 1: the normalizer must not resolve the paragraph layer ───────────

test("normalizeRichText stores NO paragraph default (the box layer survives)", () => {
  // A rich value whose paragraphs set nothing must come back with EMPTY override
  // objects, not DEFAULT_PARA — paraStyleFor is the one place the default belongs.
  assert.deepEqual(normalizeRichText(contentOnly(), {}).paras, [{}]);
  assert.deepEqual(normalizeRichText({ runs: [{ text: "a\nb" }], paras: [] }, {}).paras, [{}, {}]);
  // A legacy plain string carried no paragraph style either.
  assert.deepEqual(normalizeRichText("a\nb", {}).paras, [{}, {}]);
  // Junk (the never-throw path) likewise.
  assert.deepEqual(normalizeRichText(null, {}).paras, [{}]);
  // The default itself is untouched — paraStyleFor still layers it UNDER the box.
  assert.equal(paraStyleFor([{}], 0).align, DEFAULT_PARA.align);
});

test("all four box-level PARAGRAPH rows reach the layout through normalizeRichText", () => {
  const left = laid(contentOnly(), { align: "left" });
  assert.equal(left.lines[0].glyphRuns[0].x, 0);
  // align: the whole line shifts by the box slack.
  assert.equal(laid(contentOnly(), { align: "right" }).lines[0].glyphRuns[0].x, AB_SLACK);
  assert.equal(laid(contentOnly(), { align: "center" }).lines[0].glyphRuns[0].x, AB_SLACK / 2);
  // lineSpacing: multiplies the natural line height.
  const TRIPLE_SPACING = 3;
  assert.equal(left.lines[0].height, LINE_H);
  assert.equal(laid(contentOnly(), { align: "left", lineSpacing: TRIPLE_SPACING }).lines[0].height, LINE_H * TRIPLE_SPACING);
  // charSpacing: adds px per character to the advance.
  const CHAR_SPACING = 5;
  assert.equal(left.lines[0].width, AB_WIDTH);
  assert.equal(laid(contentOnly(), { align: "left", charSpacing: CHAR_SPACING }).lines[0].width, AB_WIDTH + 2 * CHAR_SPACING);
  // wordSpacing: adds px per SPACE character, so the sample must contain one.
  const WORD_SPACING = 7;
  const spaced = laid(contentOnly("a b"), { align: "left" }).lines[0].width;
  assert.equal(laid(contentOnly("a b"), { align: "left", wordSpacing: WORD_SPACING }).lines[0].width, spaced + WORD_SPACING);
});

test("a PER-PARAGRAPH override still beats the box row (the feature, not the fallback)", () => {
  // Box says right, paragraph says left ⇒ left wins, and the result is identical
  // to a left box with no override at all.
  const boxRightParaLeft = laid({ runs: [{ text: "ab" }], paras: [{ align: "left" }] }, { align: "right" });
  assert.equal(boxRightParaLeft.lines[0].glyphRuns[0].x, 0);
  assert.equal(laid(contentOnly(), { align: "right" }).lines[0].glyphRuns[0].x, AB_SLACK);
  // Per-paragraph spacing too, and only on the paragraph that set it.
  const PARA_SPACING = 2;
  const mixed = laid({ runs: [{ text: "ab\ncd" }], paras: [{ lineSpacing: PARA_SPACING }, {}] }, { lineSpacing: 1 });
  assert.equal(mixed.lines[0].height, LINE_H * PARA_SPACING);
  assert.equal(mixed.lines[1].height, LINE_H);
});

// ── mechanism 2: the plugin default must not shadow the run layer ──────────────

test("the text plugin default stores CONTENT ONLY (no run/paragraph style)", () => {
  const d = textPlugin.defaults;
  assert.deepEqual(d.text.runs, [{ text: "Text" }], "a stored run key would shadow its box row");
  assert.deepEqual(d.text.paras, [{}], "a stored paragraph key would shadow its box row");
});

test("the default's DELTA-LEAF structure is unchanged (missingDefaults cannot clobber it)", () => {
  // The reason the default is a rich OBJECT and not a bare string: arrays are leaf
  // values to the delta walker, so `text` folds to exactly two leaves regardless
  // of run count OR run key set. Emptying the run must not disturb that.
  const textLeaves = leaves(textPlugin.defaults).map(([path]) => path.join(".")).filter((p) => p.startsWith("text"));
  assert.deepEqual(textLeaves, ["text.runs", "text.paras"]);
});

test("all four box-level TYPOGRAPHY rows reach the emitted run (SHADOWED regression)", () => {
  // emit() is the resolution point: the box row flows in as `inherited` and
  // runFrom layers it under the run. A run that stored the key would win instead.
  const BOX_SIZE = 60, BOX_COLOR = "#ff0000", BOX_FONT = "lora";
  const s = { ...textPlugin.defaults, size: BOX_SIZE, color: BOX_COLOR, font: BOX_FONT, bold: true };
  const [op] = textPlugin.emit(s, null, null);
  assert.equal(op.rich.runs[0].size, BOX_SIZE);
  assert.equal(op.rich.runs[0].color, BOX_COLOR);
  assert.equal(op.rich.runs[0].font, BOX_FONT);
  assert.equal(op.rich.runs[0].bold, true);
  // And the untouched default still resolves to the values that used to be stamped
  // into the run — which is why removing them changed no pixels.
  const [plain] = textPlugin.emit(textPlugin.defaults, null, null);
  assert.deepEqual(plain.rich.runs[0], {
    text: "Text", bold: false, italic: false, underline: false, strike: false,
    size: textPlugin.defaults.size, font: DEFAULT_FONT, color: "#000000",
    outlineColor: "#000000", outlineWidth: 0, highlight: "",
  });
});

test("a PER-RUN override still beats the box row (the feature, not the fallback)", () => {
  const RUN_SIZE = 76, BOX_SIZE = 20;
  const s = { ...textPlugin.defaults, text: { runs: [{ text: "ab", size: RUN_SIZE }], paras: [{}] }, size: BOX_SIZE };
  const [op] = textPlugin.emit(s, null, null);
  assert.equal(op.rich.runs[0].size, RUN_SIZE);
});

test("emit carries all four paragraph rows into boxStyle, and the layout honors them", () => {
  const BOX_LINE_SPACING = 1.5, BOX_CHAR_SPACING = 3, BOX_WORD_SPACING = 4;
  const s = {
    ...textPlugin.defaults, w: BOX_W, h: BOX_W, size: SIZE,
    text: contentOnly("a b"),
    align: "right", lineSpacing: BOX_LINE_SPACING, charSpacing: BOX_CHAR_SPACING, wordSpacing: BOX_WORD_SPACING,
  };
  const [op] = textPlugin.emit(s, null, null);
  assert.deepEqual(op.boxStyle, {
    align: "right", lineSpacing: BOX_LINE_SPACING, charSpacing: BOX_CHAR_SPACING,
    wordSpacing: BOX_WORD_SPACING, valign: "top",
  });
  // End-to-end through the SAME layout both render backends run.
  const out = layoutRichText(op.rich, op.boxW, monoMeasure, op.boxStyle, op.boxH);
  const A_SPACE_B = 3; // "a b" = 3 characters, one of which is a space
  const spacedWidth = A_SPACE_B * SIZE + A_SPACE_B * BOX_CHAR_SPACING + BOX_WORD_SPACING;
  assert.equal(out.lines[0].width, spacedWidth);
  assert.equal(out.lines[0].height, LINE_H * BOX_LINE_SPACING);
  assert.equal(out.lines[0].glyphRuns[0].x, BOX_W - spacedWidth); // right-aligned
});

// ── round trip: an OLD stored value must resolve exactly as it always did ──────

test("an OLD fully-stamped value round-trips unchanged (its stored style still wins)", () => {
  // The shape every pre-fix document carries. Its explicit keys must keep beating
  // the box rows — that is what makes the change render-neutral for old docs (and
  // why no migration can strip them: a user who really did set size 36 / align
  // left per run authors the byte-identical object).
  const stamped = {
    runs: [{ text: "ab", bold: false, italic: false, underline: false, strike: false, size: SIZE, font: "system", color: "#000000", outlineColor: "#000000", outlineWidth: 0, highlight: "" }],
    paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }],
  };
  const BOX_SIZE = 60;
  const [op] = textPlugin.emit({ ...textPlugin.defaults, text: stamped, size: BOX_SIZE, align: "right" }, null, null);
  assert.equal(op.rich.runs[0].size, SIZE);   // the stored run size still wins
  const out = layoutRichText(op.rich, BOX_W, monoMeasure, op.boxStyle);
  assert.equal(out.lines[0].glyphRuns[0].x, 0); // the stored align: "left" still wins
});

console.log(`\n${passed} text-row tests passed`);
