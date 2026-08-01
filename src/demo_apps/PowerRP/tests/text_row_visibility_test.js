/**
 * A BOX-LEVEL TEXT ROW THAT CANNOT MOVE THE RENDER MUST NOT BE ON SCREEN.
 *
 * tests/text_rows_test.js proves the eight box rows DO reach the render on a value
 * whose runs and paragraphs leave them something to supply. This suite covers the
 * other half, which the user reported (R6-13.4): on a value where EVERY run stores
 * the run keys and EVERY paragraph stores the paragraph keys, those same rows reach
 * nothing — runFrom puts the run's own key first, paraStyleFor puts the paragraph's
 * own key last — and the panel then DISPLAYS A VALUE THE CANVAS CONTRADICTS.
 * projects/"Untitled cheese" slide 3 is the shipped instance: the box reads
 * 36 / system / #1a1a2e while the glyphs render 76 / futura / #000000, and all
 * three of the user's real decks store runs of exactly that shape.
 *
 * THE ANSWER IS THE USER'S OWN, ALREADY RULED: hide the row. core/properties.js
 * strokeMaterialIsOn carries the ruling verbatim — "I still have stroke width
 * options even when stroke material is off, which is kind of dumb" — seven rows
 * already declare `visibleWhen`, and tests/stroke_off_test.js pins them. This suite
 * is that suite's twin for the text widget. (Ruled OUT: a disabled-with-reason row.
 * core/commands.commandUnavailableReason governs COMMANDS; rows have their own,
 * older mechanism and it drops the row.)
 *
 * THE GATE IS TWO-DIRECTIONAL, which is what stops it from decaying into "the
 * rows have a property": for each of the eight, HIDDEN must coincide with "changing
 * it leaves the display list byte-identical" and VISIBLE with "changing it moves
 * it". The display list is richTextDraws over the plugin's own emit(), i.e. exactly
 * what every backend paints, measured through the DOM-free monoMeasure seam.
 *
 * Bare node, no framework (suite conventions).
 * Run: node src/demo_apps/PowerRP/tests/text_row_visibility_test.js
 */

import assert from "node:assert/strict";
import {
  boxStyleRowVisibility, richTextDraws, monoMeasure,
  RUN_STYLE_KEYS, PARA_STYLE_KEYS, DEFAULT_PARA,
} from "../core/richtext.js";
import { textPlugin } from "../plugins/text.js";

let passed = 0;
function test(name, fn) { fn(); console.log(`  ok  ${name}`); passed += 1; }

// monoMeasure makes every glyph `size` wide, so the box is far wider than the
// sample and nothing wraps: a row change moves the draws for its own reason only.
const SIZE = 10;
const BOX_W = 400, BOX_H = 200;
const SAMPLE = "Te xt"; // carries a SPACE, so the wordSpacing row can move anything

/** The eight BOX-LEVEL rows, each with a value that visibly differs from the
 *  fixture's. Four underlie a RUN, four underlie a PARAGRAPH. */
const BOX_ROWS = [
  ["size", SIZE * 3], ["font", "inter"], ["bold", true], ["color", "#ff0000"],
  ["align", "right"], ["lineSpacing", 2], ["charSpacing", 6], ["wordSpacing", 12],
];

/** Pure function. A text item's state with the given rich value, at the box-level
 *  style the BOX_ROWS above are perturbations of. */
function stateWith(text) {
  return {
    ...textPlugin.defaults, w: BOX_W, h: BOX_H, text,
    size: SIZE, font: "system", bold: false, color: "#000000",
    align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0, valign: "top",
  };
}

/** Query-free pure function. The device-independent DISPLAY LIST a state paints —
 *  the plugin's own emit() run through the shared layout, serialized so two can be
 *  compared for equality. This is the pixel proxy: every backend consumes it. */
function drawsFor(state) {
  const [op] = textPlugin.emit(state, null, null);
  const cmd = { rich: op.rich, x: 0, y: 0, boxW: op.boxW, boxH: op.boxH, boxStyle: op.boxStyle, opacity: 1 };
  return JSON.stringify(richTextDraws(cmd, monoMeasure));
}

/** Pure function. Does changing box row `key` to `value` move the display list? */
function rowMovesDraws(text, key, value) {
  const base = stateWith(text);
  return drawsFor({ ...base, [key]: value }) !== drawsFor(base);
}

/** Pure function. The row object plugins/text.js declares for `key`. */
function rowFor(key) {
  const row = textPlugin.inspector.find((r) => r.key === key);
  assert.ok(row, `plugins/text.js declares no "${key}" row`);
  return row;
}

// The two shapes. BARE is what a freshly typed text box holds; STAMPED is what
// every text item in the user's three real decks holds.
const BARE = { runs: [{ text: SAMPLE }], paras: [{}] };
const STAMPED = {
  runs: [{ text: SAMPLE, bold: false, italic: false, underline: false, strike: false, size: 76, font: "futura", color: "#1a1a2e", outlineColor: "#000000", outlineWidth: 0, highlight: "" }],
  paras: [{ ...DEFAULT_PARA }],
};

// ── the predicate ─────────────────────────────────────────────────────────────

test("boxStyleRowVisibility: a bare value keeps every row, a fully stamped one keeps none", () => {
  for (const [key] of BOX_ROWS) {
    assert.equal(boxStyleRowVisibility(key)({ text: BARE }), true, `${key}: a bare value inherits it from the box`);
    assert.equal(boxStyleRowVisibility(key)({ text: STAMPED }), false, `${key}: every element overrides it — the row would contradict the canvas`);
  }
});

test("ONE element still inheriting is enough to keep the row (a partial override is not a dead row)", () => {
  const half = { runs: [{ text: "Te", size: 76 }, { text: " xt" }], paras: [{}] };
  assert.equal(boxStyleRowVisibility("size")({ text: half }), true);
  assert.equal(boxStyleRowVisibility("size")({ text: { runs: [{ text: "Te", size: 76 }, { text: " xt", size: 40 }], paras: [{}] } }), false);
  // Paragraphs are backfilled to the paragraph COUNT, so a second paragraph the
  // stored paras never reached still inherits — the row must stay.
  const twoParas = { runs: [{ text: "a\nb" }], paras: [{ align: "center" }] };
  assert.equal(boxStyleRowVisibility("align")({ text: twoParas }), true);
});

test("an absent/junk rich value keeps every row (nothing can be overriding it)", () => {
  for (const [key] of BOX_ROWS) {
    assert.equal(boxStyleRowVisibility(key)({}), true);
    assert.equal(boxStyleRowVisibility(key)({ text: null }), true);
    assert.equal(boxStyleRowVisibility(key)({ text: "a legacy plain string" }), true);
  }
});

test("an unknown key THROWS rather than guessing an axis", () => {
  // A typo must not produce a row that hides for a reason nobody can name — that
  // is the same defect class this whole item is removing.
  assert.throws(() => boxStyleRowVisibility("valign"), /neither a run style key/);
  assert.throws(() => boxStyleRowVisibility("opacity"), /nor a paragraph style key/);
});

// ── the rows declare it, and nothing else does ────────────────────────────────

test("all EIGHT box-level rows declare visibleWhen — four run keys, four paragraph keys", () => {
  const runKeys = BOX_ROWS.map(([k]) => k).filter((k) => RUN_STYLE_KEYS.includes(k));
  const paraKeys = BOX_ROWS.map(([k]) => k).filter((k) => PARA_STYLE_KEYS.includes(k));
  assert.deepEqual(runKeys, ["size", "font", "bold", "color"]);
  assert.deepEqual(paraKeys, ["align", "lineSpacing", "charSpacing", "wordSpacing"]);
  for (const [key] of BOX_ROWS)
    assert.equal(typeof rowFor(key).visibleWhen, "function", `${key}: a fallback row must hide when it falls back to nothing`);
});

test("a row with NO per-run/per-paragraph twin must NOT hide", () => {
  // valign moves the whole line stack within h and opacity is the widget's own:
  // no run or paragraph can override either, so neither can ever go dead.
  assert.equal(rowFor("valign").visibleWhen, undefined);
  assert.equal(rowFor("opacity").visibleWhen, undefined);
  // Nor may a shared BUNDLE row acquire one here (x/y/w/h and the effects).
  const declared = textPlugin.inspector.filter((r) => r.visibleWhen).map((r) => r.key).sort();
  assert.deepEqual(declared, BOX_ROWS.map(([k]) => k).sort());
});

// ── the two-directional gate: visible ⇔ observable ────────────────────────────

test("EVERY row the predicate keeps DOES move the display list (no row hidden that works)", () => {
  const stuck = [];
  for (const [key, value] of BOX_ROWS) {
    assert.equal(rowFor(key).visibleWhen({ text: BARE }), true);
    if (!rowMovesDraws(BARE, key, value)) stuck.push(key);
  }
  assert.deepEqual(stuck, [], "a VISIBLE row that changes nothing is the defect in the other direction");
});

test("EVERY row the predicate hides moves NOTHING (that is why it hides)", () => {
  const live = [];
  for (const [key, value] of BOX_ROWS) {
    assert.equal(rowFor(key).visibleWhen({ text: STAMPED }), false);
    if (rowMovesDraws(STAMPED, key, value)) live.push(key);
  }
  assert.deepEqual(live, [], "hiding a row that still works would remove a real control");
});

test("the user's REAL shape: the panel and the canvas can no longer disagree", () => {
  // What "Untitled cheese" slide 3 shows today — box 36/system/#1a1a2e, glyphs
  // 76/futura/#000000. The draws must report the RUN's values, and every row that
  // claims otherwise must be gone.
  const [op] = textPlugin.emit(stateWith(STAMPED), null, null);
  const { textDraws } = richTextDraws({ rich: op.rich, x: 0, y: 0, boxW: op.boxW, boxH: op.boxH, boxStyle: op.boxStyle, opacity: 1 }, monoMeasure);
  assert.equal(textDraws[0].size, 76);
  assert.equal(textDraws[0].font, "futura");
  assert.equal(textDraws[0].color, "#1a1a2e");
  const visible = textPlugin.inspector.filter((r) => !r.visibleWhen || r.visibleWhen(stateWith(STAMPED))).map((r) => r.key);
  for (const [key] of BOX_ROWS) assert.ok(!visible.includes(key), `${key}: still on screen, still contradicting the glyphs`);
});

console.log(`\n${passed} text row-visibility tests passed`);
