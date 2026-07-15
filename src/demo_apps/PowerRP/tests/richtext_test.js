/**
 * core/richtext.js tests — the rich-text model, string→runs migration, and the
 * pure box-constrained layout (word wrap, alignment incl. justify, line/char/
 * word spacing, underline/strike decorations). Bare node, no framework (suite
 * conventions). Mirrors the module's @example doctests plus behavioral cases.
 */

import assert from "node:assert/strict";
import {
  normalizeRichText, runFrom, isLegacyString, richTextToPlain, richTextIsEmpty,
  splitParagraphs, paraStyleFor, wrapParagraph, layoutRichText, richTextDraws, monoMeasure,
  richTextMigrations, withRichTextMigrated, DEFAULT_PARA,
  NATURAL_LINE_HEIGHT, UNDERLINE_OFFSET_FRAC, STRIKE_OFFSET_FRAC,
  runsLength, styleOf, sameStyle, mergeAdjacentRuns, splitRunAt, applyRunStyle,
  runStyleAt, commonStyle,
  // Round 15.6 — vertical align + paragraph-style application
  valignOffset, VALIGN_VALUES, DEFAULT_VALIGN, paragraphRanges, applyParaStyle,
} from "../core/richtext.js";

let passed = 0;
function test(name, fn) { fn(); console.log(`  ok  ${name}`); passed += 1; }
function approx(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`); }

// ── model + migration ─────────────────────────────────────────────────────────

test("normalizeRichText: string → one run, one para per line", () => {
  const r = normalizeRichText("Hi", { font: "inter", size: 20, color: "#000", bold: false });
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].text, "Hi");
  assert.equal(r.runs[0].font, "inter");
  assert.equal(r.runs[0].size, 20);
  assert.equal(r.paras.length, 1);
  assert.equal(normalizeRichText("a\nb", {}).paras.length, 2);
});

test("normalizeRichText: already-rich passes through, paras backfilled", () => {
  const r = normalizeRichText({ runs: [{ text: "x" }], paras: [] }, {});
  assert.equal(r.paras.length, 1);
  assert.equal(r.runs[0].text, "x");
  // multi-line rich value → paras count from the joined text
  const r2 = normalizeRichText({ runs: [{ text: "a\nb\nc" }], paras: [{ align: "center" }] }, {});
  assert.equal(r2.paras.length, 3);
  assert.equal(r2.paras[0].align, "center"); // preserved override
  assert.equal(r2.paras[1].align, "left");   // backfilled default
});

test("normalizeRichText: junk value → empty single run (never throws)", () => {
  assert.equal(normalizeRichText(null, {}).runs.length, 1);
  assert.equal(normalizeRichText(42, {}).runs[0].text, "");
});

test("runFrom: inheritance + defaults", () => {
  assert.equal(runFrom({ text: "x" }, { size: 20, color: "#111" }).size, 20);
  assert.equal(runFrom({ text: "x", bold: true }, {}).bold, true);
  assert.equal(runFrom({ text: "x" }, {}).italic, false);
  assert.equal(runFrom({ text: "x" }, {}).font, "system");
});

test("isLegacyString / richTextToPlain / richTextIsEmpty", () => {
  assert.equal(isLegacyString("Hi"), true);
  assert.equal(isLegacyString({ runs: [], paras: [] }), false);
  assert.equal(richTextToPlain({ runs: [{ text: "Hi " }, { text: "there" }], paras: [{}] }), "Hi there");
  assert.equal(richTextToPlain("legacy"), "legacy");
  assert.equal(richTextIsEmpty({ runs: [{ text: "" }], paras: [{}] }), true);
  assert.equal(richTextIsEmpty("hi"), false);
  assert.equal(richTextIsEmpty({ runs: [{ text: " " }], paras: [{}] }), false);
});

test("richTextMigrations: only legacy-string text on text widgets", () => {
  const doc = { slides: [{ delta: { items: { a: { type: "text", text: "Hi" }, b: { type: "rect", text: "x" } } } }] };
  assert.equal(richTextMigrations(doc, (t) => t === "text").length, 1);
  const rich = { slides: [{ delta: { items: { a: { type: "text", text: { runs: [], paras: [] } } } } }] };
  assert.equal(richTextMigrations(rich, (t) => t === "text").length, 0);
});

test("richTextMigrations: keyframed later-slide string ALSO migrates", () => {
  const doc = { slides: [
    { delta: { items: { a: { type: "text", text: "Hi", size: 20 } } } },
    { delta: { items: { a: { text: "Bye" } } } }, // keyframed text change, no type
  ] };
  const m = richTextMigrations(doc, (t) => t === "text");
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((e) => e.slideIndex).sort(), [0, 1]);
});

test("withRichTextMigrated: converts in place, inherits style, reports, idempotent", () => {
  const doc = { slides: [{ delta: { items: { a: { type: "text", text: "Hi", size: 20, color: "#abc", bold: true } } } }] };
  const { doc: out, migrated } = withRichTextMigrated(doc, (t) => t === "text");
  assert.equal(migrated.length, 1);
  const run = out.slides[0].delta.items.a.text.runs[0];
  assert.equal(run.text, "Hi");
  assert.equal(run.size, 20);      // inherited from the same delta
  assert.equal(run.bold, true);
  assert.equal(out.slides[0].delta.items.a.size, 20); // widget-level keys untouched
  // idempotent: a second pass finds nothing
  assert.equal(withRichTextMigrated(out, (t) => t === "text").migrated.length, 0);
});

test("withRichTextMigrated: folded inheritance seam supplies earlier-slide size", () => {
  const doc = { slides: [{ delta: { items: { a: { type: "text", text: "Hi" } } } }] };
  const folded = () => ({ size: 99, color: "#f00" });
  const { doc: out } = withRichTextMigrated(doc, (t) => t === "text", folded);
  assert.equal(out.slides[0].delta.items.a.text.runs[0].size, 99);
});

// ── paragraph split + style ─────────────────────────────────────────────────

test("splitParagraphs: newline splits, empty → one empty para", () => {
  assert.equal(splitParagraphs([{ text: "ab", size: 10 }]).length, 1);
  assert.equal(splitParagraphs([{ text: "a\nb", size: 10 }]).length, 2);
  assert.equal(splitParagraphs([{ text: "a\nb" }])[0][0].text, "a");
  assert.equal(splitParagraphs([]).length, 1);
  // trailing newline → trailing empty paragraph (PPT blank line)
  assert.equal(splitParagraphs([{ text: "a\n" }]).length, 2);
  assert.equal(splitParagraphs([{ text: "a\n" }])[1].length, 0);
  // a run boundary crossing works: two runs, no newline → one paragraph, two pieces
  assert.equal(splitParagraphs([{ text: "a", bold: true }, { text: "b" }]).length, 1);
  assert.equal(splitParagraphs([{ text: "a", bold: true }, { text: "b" }])[0].length, 2);
});

test("paraStyleFor: default ‹ box ‹ para override layering", () => {
  assert.equal(paraStyleFor([{ align: "center" }], 0).align, "center");
  assert.equal(paraStyleFor([{ align: "right" }], 5).align, "right");
  assert.equal(paraStyleFor([], 0).align, "left");
  assert.equal(paraStyleFor([], 0, { align: "center" }).align, "center");
  assert.equal(paraStyleFor([{ align: "right" }], 0, { align: "center" }).align, "right");
});

// ── wrap ──────────────────────────────────────────────────────────────────────

const w1 = (t) => ({ width: t.length });

test("wrapParagraph: no wrap under Infinity, wraps at width, empty → one line", () => {
  assert.equal(wrapParagraph([{ text: "a b", style: {} }], Infinity, w1).length, 1);
  assert.equal(wrapParagraph([{ text: "aa bb", style: {} }], 3, w1).length, 2);
  assert.equal(wrapParagraph([], 100, w1).length, 1);
});

test("wrapParagraph: overlong unbreakable word overflows on its own line", () => {
  const lines = wrapParagraph([{ text: "verylongword ok", style: {} }], 5, w1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].map((p) => p.text).join(""), "verylongword"); // overflowed, not broken
  assert.equal(lines[1].map((p) => p.text).join(""), "ok");
});

test("wrapParagraph: trailing whitespace at a wrap point is dropped", () => {
  const lines = wrapParagraph([{ text: "aa bb cc", style: {} }], 5, w1);
  // no line should end in whitespace
  for (const line of lines) {
    const last = line[line.length - 1];
    if (last) assert.ok(!/\s$/.test(last.text), `line ends in space: ${JSON.stringify(line)}`);
  }
});

test("wrapParagraph: mixed-style pieces keep their style across the wrap", () => {
  const lines = wrapParagraph(
    [{ text: "aa ", style: { bold: true } }, { text: "bb", style: { italic: true } }], 3, w1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0].style.bold, true);
  assert.equal(lines[1][0].style.italic, true);
});

// ── layout ──────────────────────────────────────────────────────────────────

test("layoutRichText: single line, multi-line, empty", () => {
  assert.equal(layoutRichText({ runs: [{ text: "ab", size: 10, color: "#000" }], paras: [{ align: "left" }] }, Infinity, monoMeasure).lines.length, 1);
  assert.equal(layoutRichText({ runs: [{ text: "a\nb", size: 10, color: "#000" }], paras: [{}, {}] }, Infinity, monoMeasure).lines.length, 2);
  assert.equal(layoutRichText({ runs: [], paras: [] }, 100, monoMeasure).lines.length, 1);
});

test("layoutRichText: line height = (ascent+descent)·lineSpacing; y advances", () => {
  const out = layoutRichText({ runs: [{ text: "a\nb", size: 10, color: "#000" }], paras: [{}, {}] }, Infinity, monoMeasure);
  // mono: ascent 8, descent 2 → natural height 10
  approx(out.lines[0].height, 10);
  approx(out.lines[1].y, 10); // second line sits below the first
  // baseline = halfLeading + ascent; lineSpacing 1 ⇒ halfLeading 0 ⇒ baseline = ascent = 8
  approx(out.lines[0].baseline, 8);
  const spaced = layoutRichText({ runs: [{ text: "a", size: 10, color: "#000" }], paras: [{ lineSpacing: 2 }] }, Infinity, monoMeasure);
  approx(spaced.lines[0].height, 20); // 10 · 2
  approx(spaced.lines[0].baseline, 5 + 8); // halfLeading (20-10)/2=5 + ascent 8
});

test("layoutRichText: left/center/right alignment shifts glyph run x", () => {
  const rt = (align) => layoutRichText({ runs: [{ text: "ab", size: 10, color: "#000" }], paras: [{ align }] }, 100, monoMeasure);
  approx(rt("left").lines[0].glyphRuns[0].x, 0);
  approx(rt("center").lines[0].glyphRuns[0].x, (100 - 20) / 2); // slack 80 / 2
  approx(rt("right").lines[0].glyphRuns[0].x, 100 - 20);
});

test("layoutRichText: justify stretches inter-piece gaps on non-last lines", () => {
  // Two words that wrap: line 1 "aa bb" should justify to boxW; last line stays left.
  const rich = { runs: [{ text: "aa bb cc", size: 10, color: "#000" }], paras: [{ align: "justify" }] };
  const out = layoutRichText(rich, 60, monoMeasure); // "aa"=20 "bb"=20 -> wrap; each word 20 wide, space 10
  assert.ok(out.lines.length >= 2);
  const first = out.lines[0];
  // first line's last glyph run should be pushed toward the right edge by justify
  const lastRun = first.glyphRuns[first.glyphRuns.length - 1];
  const lastRight = lastRun.x + monoMeasure(lastRun.text, lastRun.style).width;
  assert.ok(lastRight > first.width, "justify did not stretch the first line");
});

test("layoutRichText: box style underlies paragraph align", () => {
  const out = layoutRichText({ runs: [{ text: "ab", size: 10, color: "#000" }], paras: [{}] }, 100, monoMeasure, { align: "right" });
  approx(out.lines[0].glyphRuns[0].x, 100 - 20);
});

test("layoutRichText: word wrap keeps text within boxW (the user's bug)", () => {
  const rich = { runs: [{ text: "one two three four five", size: 10, color: "#000" }], paras: [{ align: "left" }] };
  const out = layoutRichText(rich, 100, monoMeasure);
  assert.ok(out.lines.length > 1, "did not wrap");
  for (const line of out.lines) {
    assert.ok(line.width <= 100 + 1e-9, `line width ${line.width} exceeds boxW 100`);
  }
});

test("layoutRichText: underline + strike decoration lines positioned at baseline offsets", () => {
  const out = layoutRichText({ runs: [{ text: "ab", size: 10, color: "#f00", underline: true, strike: true }], paras: [{}] }, Infinity, monoMeasure);
  assert.equal(out.decorations.length, 2);
  const u = out.decorations.find((d) => d.kind === "underline");
  const s = out.decorations.find((d) => d.kind === "strike");
  assert.equal(u.color, "#f00");
  approx(u.w, 20);         // spans the piece
  // baseline for a single line: ascent 8 (lineSpacing 1). underline below, strike above.
  approx(u.y, 0 + 8 + 10 * UNDERLINE_OFFSET_FRAC);
  approx(s.y, 0 + 8 + 10 * STRIKE_OFFSET_FRAC);
  assert.ok(s.y < u.y, "strike should be above underline");
});

test("layoutRichText: char/word spacing widen advances", () => {
  const base = layoutRichText({ runs: [{ text: "a b", size: 10, color: "#000" }], paras: [{}] }, Infinity, monoMeasure);
  const spaced = layoutRichText({ runs: [{ text: "a b", size: 10, color: "#000" }], paras: [{ charSpacing: 2, wordSpacing: 5 }] }, Infinity, monoMeasure);
  assert.ok(spaced.width > base.width, "spacing did not widen the line");
});

test("layoutRichText: per-run size drives line ascent (mixed sizes)", () => {
  const out = layoutRichText({ runs: [{ text: "a", size: 10, color: "#000" }, { text: "B", size: 40, color: "#000" }], paras: [{}] }, Infinity, monoMeasure);
  // one line; ascent from the 40px run: 0.8*40 = 32; height = 32 + 8 = 40
  approx(out.lines[0].height, 40);
});

// ── richTextDraws (the backend-neutral positioned draws) ─────────────────────

test("richTextDraws: op origin offsets every draw; single run → one textDraw", () => {
  const cmd = { rich: { runs: [{ text: "ab", size: 10, color: "#000" }], paras: [{}] }, x: 5, y: 3, boxW: Infinity, opacity: 1 };
  const d = richTextDraws(cmd, monoMeasure);
  assert.equal(d.textDraws.length, 1);
  assert.equal(d.textDraws[0].x, 5);          // op origin x + glyph run x (0)
  approx(d.textDraws[0].baselineY, 3 + 0 + 8); // op y + line top 0 + baseline 8
  assert.equal(d.textDraws[0].text, "ab");
});

test("richTextDraws: mixed sizes share ONE baseline (baselineY equal)", () => {
  const cmd = { rich: { runs: [{ text: "a", size: 10, color: "#000" }, { text: "B", size: 40, color: "#000" }], paras: [{}] }, x: 0, y: 0, boxW: Infinity, opacity: 1 };
  const d = richTextDraws(cmd, monoMeasure);
  assert.equal(d.textDraws.length, 2);
  approx(d.textDraws[0].baselineY, d.textDraws[1].baselineY); // shared baseline
  approx(d.textDraws[0].baselineY, 32); // line ascent from 40px run = 0.8*40
});

test("richTextDraws: underline/strike become lines offset by op origin", () => {
  const cmd = { rich: { runs: [{ text: "a", size: 10, color: "#f00", underline: true }], paras: [{}] }, x: 7, y: 2, boxW: Infinity, opacity: 1 };
  const d = richTextDraws(cmd, monoMeasure);
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].x, 7);       // origin x + decoration x (0)
  assert.equal(d.lines[0].color, "#f00");
});

// ── outline + highlight (Round 13.4) ─────────────────────────────────────────

test("runFrom: outline/highlight default OFF; explicit values kept", () => {
  assert.equal(runFrom({ text: "x" }, {}).outlineWidth, 0);
  assert.equal(runFrom({ text: "x" }, {}).outlineColor, "#000000");
  assert.equal(runFrom({ text: "x" }, {}).highlight, "");
  assert.equal(runFrom({ text: "x", outlineWidth: 2, outlineColor: "#f00" }, {}).outlineWidth, 2);
  assert.equal(runFrom({ text: "x", highlight: "#ff0" }, {}).highlight, "#ff0");
});

test("normalizeRichText: an OLD rich value (no outline/highlight keys) gains OFF defaults", () => {
  const old = { runs: [{ text: "Hi", size: 20, color: "#000" }], paras: [{}] };
  const r = normalizeRichText(old, {});
  assert.equal(r.runs[0].outlineWidth, 0); // migrated off — old docs render byte-identically
  assert.equal(r.runs[0].highlight, "");
});

test("layoutRichText/richTextDraws: highlight rect spans the piece box, drawn behind", () => {
  const cmd = { rich: { runs: [{ text: "ab", size: 10, color: "#000", highlight: "#ff0" }], paras: [{}] }, x: 3, y: 5, boxW: Infinity, opacity: 1 };
  const d = richTextDraws(cmd, monoMeasure);
  assert.equal(d.highlights.length, 1);
  assert.equal(d.highlights[0].x, 3);          // op origin x + piece x (0)
  approx(d.highlights[0].w, 20);               // "ab" = 20 wide
  approx(d.highlights[0].h, 10);               // ascent 8 + descent 2
  assert.equal(d.highlights[0].color, "#ff0");
});

test("richTextDraws: no highlight ('' sentinel) emits no highlight rect", () => {
  const cmd = { rich: { runs: [{ text: "ab", size: 10, color: "#000", highlight: "" }], paras: [{}] }, x: 0, y: 0, boxW: Infinity, opacity: 1 };
  assert.equal(richTextDraws(cmd, monoMeasure).highlights.length, 0);
});

test("richTextDraws: outline carried onto each textDraw", () => {
  const cmd = { rich: { runs: [{ text: "ab", size: 10, color: "#000", outlineColor: "#f00", outlineWidth: 2 }], paras: [{}] }, x: 0, y: 0, boxW: Infinity, opacity: 1 };
  const d = richTextDraws(cmd, monoMeasure);
  assert.equal(d.textDraws[0].outlineColor, "#f00");
  assert.equal(d.textDraws[0].outlineWidth, 2);
});

// ── run split / merge / per-selection style (SET-2 substrate) ─────────────────

test("runsLength / styleOf / sameStyle", () => {
  assert.equal(runsLength([{ text: "ab" }, { text: "cde" }]), 5);
  assert.equal(runsLength([]), 0);
  assert.deepEqual(styleOf({ text: "x", bold: true, size: 10 }), { bold: true, size: 10 });
  assert.equal(sameStyle({ text: "a", bold: true }, { text: "b", bold: true }), true);
  assert.equal(sameStyle({ text: "a", bold: true }, { text: "b", bold: false }), false);
});

test("splitRunAt: cuts a run at an interior offset, no-op at boundaries", () => {
  assert.equal(splitRunAt([{ text: "abcd", bold: true }], 2).length, 2);
  assert.equal(splitRunAt([{ text: "abcd", bold: true }], 2)[0].text, "ab");
  assert.equal(splitRunAt([{ text: "abcd", bold: true }], 2)[1].text, "cd");
  assert.equal(splitRunAt([{ text: "abcd", bold: true }], 2)[1].bold, true); // style preserved
  assert.equal(splitRunAt([{ text: "abcd" }], 0).length, 1);
  assert.equal(splitRunAt([{ text: "abcd" }], 4).length, 1);
});

test("mergeAdjacentRuns: merges identical-style, drops empties, keeps a lone empty", () => {
  assert.equal(mergeAdjacentRuns([{ text: "a", bold: true }, { text: "b", bold: true }]).length, 1);
  assert.equal(mergeAdjacentRuns([{ text: "a", bold: true }, { text: "b", bold: true }])[0].text, "ab");
  assert.equal(mergeAdjacentRuns([{ text: "a", bold: true }, { text: "b", bold: false }]).length, 2);
  assert.equal(mergeAdjacentRuns([{ text: "" }, { text: "x" }]).length, 1);
  assert.equal(mergeAdjacentRuns([{ text: "" }]).length, 1); // lone empty kept
});

test("applyRunStyle: styles a middle range, splitting then merging to canonical", () => {
  const out = applyRunStyle([{ text: "abcd" }], 1, 3, { bold: true });
  assert.equal(out.length, 3);                    // a | bc | d
  assert.equal(out[1].text, "bc");
  assert.equal(out[1].bold, true);
  assert.equal(out[0].bold, undefined);
  // whole-range unbold collapses back to one run (canonical form — no leftover splits)
  const merged = applyRunStyle([{ text: "abcd", bold: true }], 0, 4, { bold: false });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].bold, false);
});

test("applyRunStyle: empty selection is a no-op (returns canonicalized input)", () => {
  const out = applyRunStyle([{ text: "abcd" }], 2, 2, { bold: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].bold, undefined);
});

test("applyRunStyle: bold-then-unbold a range round-trips to one run", () => {
  const bolded = applyRunStyle([{ text: "hello world" }], 0, 5, { bold: true });
  assert.equal(bolded.length, 2); // "hello" bold, " world" not
  const back = applyRunStyle(bolded, 0, 5, { bold: false });
  assert.equal(back.length, 1);   // merged back — canonical
  assert.equal(back[0].text, "hello world");
});

test("applyRunStyle: outline + highlight deltas thread through", () => {
  const out = applyRunStyle([{ text: "abcd" }], 1, 3, { outlineColor: "#f00", outlineWidth: 2, highlight: "#ff0" });
  assert.equal(out[1].outlineWidth, 2);
  assert.equal(out[1].highlight, "#ff0");
});

test("runStyleAt: covers offset; left run wins at a boundary", () => {
  const runs = [{ text: "ab", bold: true }, { text: "cd", bold: false }];
  assert.equal(runStyleAt(runs, 1).bold, true);
  assert.equal(runStyleAt(runs, 2).bold, true);  // boundary → left wins
  assert.equal(runStyleAt(runs, 3).bold, false);
  assert.deepEqual(runStyleAt([], 0), {});
});

test("commonStyle: shared value across selection, else undefined (mixed)", () => {
  const runs = [{ text: "ab", bold: true }, { text: "cd", bold: true }];
  assert.equal(commonStyle(runs, 0, 4, "bold"), true);
  const mixed = [{ text: "ab", bold: true }, { text: "cd", bold: false }];
  assert.equal(commonStyle(mixed, 0, 4, "bold"), undefined);
  assert.equal(commonStyle([{ text: "abcd", bold: true }], 1, 3, "bold"), true);
});

// ── Round 15.6: VERTICAL ALIGN (valign) ──────────────────────────────────────

test("valignOffset: top=0; middle/bottom split slack; loud-rejects a bad value", () => {
  assert.equal(valignOffset("top", 100, 40), 0);
  approx(valignOffset("middle", 100, 40), 30); // slack 60, half above
  approx(valignOffset("bottom", 100, 40), 60); // all slack above
  assert.equal(valignOffset("middle", Infinity, 40), 0); // no box to center in
  assert.equal(valignOffset("bottom", 30, 40), 0);       // content overflows ⇒ grows down, not up
  assert.deepEqual(VALIGN_VALUES, ["top", "middle", "bottom"]);
  assert.equal(DEFAULT_VALIGN, "top");
  // ONE canonical form — no tolerant aliasing; a non-canonical value throws.
  assert.throws(() => valignOffset("centre", 100, 40), /must be one of/);
  assert.throws(() => valignOffset("center", 100, 40), /must be one of/); // horizontal word ≠ valign
  assert.throws(() => valignOffset(undefined, 100, 40), /must be one of/);
});

test("layoutRichText: valign top is the historical no-op (y=0); backward-compatible", () => {
  const rich = { runs: [{ text: "a", size: 10, color: "#000" }], paras: [{}] };
  // default (no valign, no boxH) — unchanged
  approx(layoutRichText(rich, Infinity, monoMeasure).lines[0].y, 0);
  // explicit top with a boxH — still 0
  approx(layoutRichText(rich, Infinity, monoMeasure, { valign: "top" }, 100).lines[0].y, 0);
});

test("layoutRichText: valign middle/bottom shift the whole line stack within boxH", () => {
  const rich = { runs: [{ text: "a", size: 10, color: "#000" }], paras: [{}] }; // one 10-tall line
  approx(layoutRichText(rich, Infinity, monoMeasure, { valign: "middle" }, 100).lines[0].y, 45); // (100-10)/2
  approx(layoutRichText(rich, Infinity, monoMeasure, { valign: "bottom" }, 100).lines[0].y, 90); // 100-10
});

test("layoutRichText: valign shifts decorations AND highlights by the same offset", () => {
  const rich = { runs: [{ text: "a", size: 10, color: "#000", underline: true, highlight: "#ff0" }], paras: [{}] };
  const top = layoutRichText(rich, Infinity, monoMeasure, { valign: "top" }, 100);
  const bot = layoutRichText(rich, Infinity, monoMeasure, { valign: "bottom" }, 100);
  const dOff = bot.decorations[0].y - top.decorations[0].y;
  const hOff = bot.highlights[0].y - top.highlights[0].y;
  approx(dOff, 90); // same offset the lines got
  approx(hOff, 90);
  approx(bot.highlights[0].y, 90); // highlight box top now at the box bottom minus its own height... top+offset
});

test("layoutRichText: valign accounts for MULTI-LINE (wrap) + MULTI-PARAGRAPH stacks", () => {
  // Two paragraphs, the first wraps into two lines: total height 3 lines × 10 = 30.
  const rich = { runs: [{ text: "aa bb\ncc", size: 10, color: "#000" }], paras: [{}, {}] };
  const wrapW = 30; // "aa"=20, " "=10, "bb"=20 ⇒ wraps to 2 lines
  const top = layoutRichText(rich, wrapW, monoMeasure, { valign: "top" }, 100);
  assert.equal(top.lines.length, 3); // 2 wrapped + 1 for para 2
  approx(top.height, 30);
  const bot = layoutRichText(rich, wrapW, monoMeasure, { valign: "bottom" }, 100);
  // bottom offset = boxH - contentH = 100 - 30 = 70; every line shifts by 70.
  for (let i = 0; i < top.lines.length; i++) approx(bot.lines[i].y, top.lines[i].y + 70);
  approx(bot.height, 30); // reported content height is unchanged (extent, not placement)
});

test("layoutRichText: valign middle preserves horizontal align (orthogonal axes)", () => {
  const rich = { runs: [{ text: "ab", size: 10, color: "#000" }], paras: [{ align: "right" }] };
  const out = layoutRichText(rich, 100, monoMeasure, { valign: "middle" }, 100);
  approx(out.lines[0].glyphRuns[0].x, 100 - 20); // right align intact
  approx(out.lines[0].y, 45);                    // vertical center intact
});

test("richTextDraws: boxH threads into the layout so valign offsets the draws", () => {
  const cmd = {
    rich: { runs: [{ text: "a", size: 10, color: "#000" }], paras: [{}] },
    x: 5, y: 3, boxW: Infinity, boxH: 100,
    boxStyle: { valign: "bottom" }, opacity: 1,
  };
  const d = richTextDraws(cmd, monoMeasure);
  // baseline = op y (3) + line top (0 + valign offset 90) + baseline (8) = 101
  approx(d.textDraws[0].baselineY, 3 + 90 + 8);
});

// ── Round 15.6: paragraph ranges + applyParaStyle (horizontal-align UI substrate)

test("paragraphRanges: char ranges per paragraph; separator owned by none", () => {
  assert.deepEqual(paragraphRanges([{ text: "ab" }]), [{ start: 0, end: 2 }]);
  assert.deepEqual(paragraphRanges([{ text: "ab\ncd" }]), [{ start: 0, end: 2 }, { start: 3, end: 5 }]);
  assert.deepEqual(paragraphRanges([{ text: "a\n" }]), [{ start: 0, end: 1 }, { start: 2, end: 2 }]);
  assert.deepEqual(paragraphRanges([]), [{ start: 0, end: 0 }]);
  // ranges agree with splitParagraphs' paragraph COUNT (the shared invariant)
  const runs = [{ text: "one\ntwo\nthree" }];
  assert.equal(paragraphRanges(runs).length, splitParagraphs(runs).length);
});

test("applyParaStyle: overlays a delta on touched paragraphs, leaves others", () => {
  // single paragraph fully selected
  assert.equal(applyParaStyle([{}], [{ text: "ab" }], 0, 2, { align: "center" })[0].align, "center");
  // two paragraphs; select only the first → second untouched (raw entry, no default)
  const out = applyParaStyle([{}, {}], [{ text: "ab\ncd" }], 0, 2, { align: "right" });
  assert.equal(out[0].align, "right");
  assert.equal(out[1].align, undefined);
  // selection spanning both → both set
  const both = applyParaStyle([{}, {}], [{ text: "ab\ncd" }], 1, 4, { align: "right" });
  assert.equal(both[0].align, "right");
  assert.equal(both[1].align, "right");
});

test("applyParaStyle: an empty caret selects its containing paragraph only", () => {
  // caret at offset 4 (inside para 2 "cd", which spans [3,5]) → only para 2
  const out = applyParaStyle([{}, {}], [{ text: "ab\ncd" }], 4, 4, { align: "center" });
  assert.equal(out[0].align, undefined);
  assert.equal(out[1].align, "center");
  // caret at the "\n" (offset 2, the end of para 1 [0,2]) → para 1 (end inclusive)
  const b = applyParaStyle([{}, {}], [{ text: "ab\ncd" }], 2, 2, { align: "right" });
  assert.equal(b[0].align, "right");
  assert.equal(b[1].align, undefined);
});

test("applyParaStyle: does not mutate the input paras; backfills a short paras array", () => {
  const paras = [{ align: "left" }];
  const runs = [{ text: "ab\ncd" }]; // 2 paragraphs, but paras has 1 entry
  const out = applyParaStyle(paras, runs, 0, 5, { align: "center" });
  assert.equal(out.length, 2);           // backfilled to the paragraph count
  assert.equal(out[0].align, "center");
  assert.equal(out[1].align, "center");
  assert.equal(paras.length, 1);         // input untouched
  assert.equal(paras[0].align, "left");
});

console.log(`\n${passed} richtext tests passed`);
