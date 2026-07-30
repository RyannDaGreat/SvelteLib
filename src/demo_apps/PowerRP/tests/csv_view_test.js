/**
 * CSV VIEWER tests — plain node, no framework, no DOM.
 * Run: node src/demo_apps/PowerRP/tests/csv_view_test.js
 *
 * WHAT IS UNDER TEST is the pure half of the CSV asset viewer (core/csv.js): the
 * RFC 4180 parse, the numeric-column vote that decides alignment, and the
 * virtual-scroll window math.
 *
 * WHY THESE THREE AND NOT THE COMPONENT: each is a place where being wrong is
 * INVISIBLE in a screenshot. A parser that splits on newlines produces a table
 * that looks perfectly plausible and is shifted by one column from the first
 * quoted line break onward. A window off-by-one duplicates or drops a row 5,000
 * rows down, where nobody scrolls during a manual check. So the component is
 * verified by eye and by a scroll probe, and the arithmetic is verified here.
 *
 * The DELIBERATE DIVERGENCE from plugin_assets/csv_bar_graph.plugin.js's local
 * parseCsv is asserted, not just documented (see the last group): the chart's
 * parser trims cells and cannot hold a quoted newline; the viewer's must do
 * neither. If someone later "unifies" them by making the viewer line-based, the
 * quoted-newline assertion is what fails.
 */

import assert from "node:assert/strict";
import {
  columnAlignments,
  csvDelimiterForName,
  csvHeaders,
  csvSummary,
  csvWindow,
  isNumericCell,
  parseDelimited,
} from "../core/csv.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── The parse ───────────────────────────────────────────────────────────────

test("parseDelimited handles the plain case and both line endings", () => {
  assert.deepEqual(parseDelimited("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseDelimited("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseDelimited("a,b\r1,2\r"), [["a", "b"], ["1", "2"]]); // classic Mac
  assert.deepEqual(parseDelimited("a,b\n1,2"), [["a", "b"], ["1", "2"]]); // no trailing newline
  assert.deepEqual(parseDelimited(""), []);
});

test("parseDelimited keeps a delimiter inside a quoted field", () => {
  assert.deepEqual(parseDelimited('city,n\n"Portland, OR",4\n'), [["city", "n"], ["Portland, OR", "4"]]);
  // The failure this prevents: a split(",") parse yields THREE cells here, and
  // every value after the comma is one column to the right of its header.
  assert.equal(parseDelimited('city,n\n"Portland, OR",4\n')[1].length, 2);
});

test("parseDelimited unescapes a doubled quote", () => {
  assert.deepEqual(parseDelimited('q\n"say ""hi"""\n'), [["q"], ['say "hi"']]);
  assert.deepEqual(parseDelimited('a\n""""\n'), [["a"], ['"']]);
});

test("parseDelimited keeps a NEWLINE inside a quoted field in one cell", () => {
  // THE reason this parser is a character walk and not a line split.
  assert.deepEqual(parseDelimited('note,n\n"two\nlines",7\n'), [["note", "n"], ["two\nlines", "7"]]);
  assert.deepEqual(parseDelimited('note\n"a\r\nb"\n'), [["note"], ["a\nb"]]);
});

test("parseDelimited does not trim cells (unlike the chart plugin's parser)", () => {
  assert.deepEqual(parseDelimited("a, b ,c\n"), [["a", " b ", "c"]]);
});

test("parseDelimited preserves a blank line in the middle, drops the trailing newline", () => {
  assert.deepEqual(parseDelimited("a,b\n\nc,d"), [["a", "b"], [""], ["c", "d"]]);
  assert.deepEqual(parseDelimited("a,b\n"), [["a", "b"]]); // trailing newline is not a row
  assert.deepEqual(parseDelimited("a,b\n\n"), [["a", "b"], [""]]); // a blank row then the newline
});

test("parseDelimited handles empty cells and ragged rows", () => {
  assert.deepEqual(parseDelimited("a,,c\n"), [["a", "", "c"]]);
  assert.deepEqual(parseDelimited(",,\n"), [["", "", ""]]);
  assert.deepEqual(parseDelimited("a,b,c\n1\n"), [["a", "b", "c"], ["1"]]); // short row stays short
});

test("parseDelimited parses tabs when told to", () => {
  assert.deepEqual(parseDelimited("a\tb\n1\t2", "\t"), [["a", "b"], ["1", "2"]]);
  // A comma is ordinary data in a TSV.
  assert.deepEqual(parseDelimited("a\tb\n1,5\t2", "\t"), [["a", "b"], ["1,5", "2"]]);
});

test("csvDelimiterForName is extension-driven, case-insensitive", () => {
  assert.equal(csvDelimiterForName("sales.csv"), ",");
  assert.equal(csvDelimiterForName("readings.TSV"), "\t");
  assert.equal(csvDelimiterForName("noextension"), ",");
});

// ── Alignment: the numeric-column vote ──────────────────────────────────────

test("isNumericCell accepts what a spreadsheet reader calls a number", () => {
  for (const yes of ["42", "-3.2e4", "0", "1,234", "$12.50", "-3.2%", " 7 "]) assert.equal(isNumericCell(yes), true, yes);
  for (const no of ["North", "", "12 units", "1.2.3", "-", "N/A"]) assert.equal(isNumericCell(no), false, no);
});

test("columnAlignments excludes the header from the vote and lets blanks abstain", () => {
  assert.deepEqual(columnAlignments([["region", "units"], ["North", "12"], ["South", "8"]], true), ["left", "right"]);
  // A column headed "2024" is a LABEL: the header must not vote it numeric.
  assert.deepEqual(columnAlignments([["2024", "n"], ["a", "1"]], true), ["left", "right"]);
  // A sparse numeric column is still numeric.
  assert.deepEqual(columnAlignments([["h", "n"], ["a", ""], ["b", "3"]], true), ["left", "right"]);
  // Nothing proved it numeric → left.
  assert.deepEqual(columnAlignments([["h"], [""]], true), ["left"]);
  assert.deepEqual(columnAlignments([], true), []);
  // With NO header both rows vote, so a lone numeric beside a blank still wins.
  // (This case's doctest asserted ["left","left"] and was WRONG — the doctest
  // runner caught it, which is why doctests are executed and not decorative.)
  assert.deepEqual(columnAlignments([["a", "1"], ["b", ""]], false), ["left", "right"]);
});

test("columnAlignments bounds its scan with `sample`", () => {
  // 300 numeric rows then a text row: a 200-row sample never sees the text one,
  // so the column reads right. This is the documented, deliberate imprecision —
  // pinned so nobody "fixes" it into a full 100k-row scan on the render path.
  const rows = [["n"], ...Array.from({ length: 300 }, (_, i) => [String(i)]), ["oops"]];
  assert.deepEqual(columnAlignments(rows, true, 200), ["right"]);
  assert.deepEqual(columnAlignments(rows, true, rows.length), ["left"]);
});

// ── Headers + summary ───────────────────────────────────────────────────────

test("csvHeaders names columns, numbering the blank and the headerless", () => {
  assert.deepEqual(csvHeaders([["region", "units"], ["North", "12"]], true), ["region", "units"]);
  assert.deepEqual(csvHeaders([["North", "12"]], false), ["1", "2"]);
  assert.deepEqual(csvHeaders([["region", " "], ["North", "12"]], true), ["region", "2"]);
  // The header row may be SHORTER than a body row; the extra columns still name.
  assert.deepEqual(csvHeaders([["a"], ["1", "2"]], true), ["a", "2"]);
  assert.deepEqual(csvHeaders([], true), []);
});

test("csvSummary counts BODY rows, not lines", () => {
  assert.equal(csvSummary([["a", "b"], ["1", "2"], ["3", "4"]], true), "2 rows × 2 columns");
  assert.equal(csvSummary([["a", "b"], ["1", "2"]], false), "2 rows × 2 columns");
  assert.equal(csvSummary([["a"], ["1"]], true), "1 row × 1 column");
  assert.equal(csvSummary([], true), "empty");
  // Six-digit counts are the case this viewer exists for; they are separated.
  const big = [["h"], ...Array.from({ length: 100000 }, () => ["x"])];
  assert.equal(csvSummary(big, true), "100,000 rows × 1 column");
});

// ── The virtual-scroll window ───────────────────────────────────────────────

test("csvWindow mounts a viewport's worth of rows, never the file", () => {
  const w = csvWindow(100000, 0, 400, 20, 0);
  assert.deepEqual(w, { start: 0, end: 20, padTop: 0, padBottom: 1999600 });
  // The invariant that makes 100k rows cheap: mounted count is O(viewport).
  assert.ok(w.end - w.start <= 21);
});

test("csvWindow's spacers always sum to the full scroll height", () => {
  const total = 100000;
  const rowH = 20;
  for (const scrollTop of [0, 19, 20, 1234, 10000, 999980, 1e9]) {
    const { start, end, padTop, padBottom } = csvWindow(total, scrollTop, 400, rowH, 8);
    assert.equal(padTop + (end - start) * rowH + padBottom, total * rowH, `scrollTop=${scrollTop}`);
    assert.ok(start >= 0 && end <= total);
  }
});

test("csvWindow keeps the scrolled-to row inside the window", () => {
  const total = 100000;
  const rowH = 20;
  for (const scrollTop of [0, 20, 21, 5000, 12345, 1999600]) {
    const { start, end } = csvWindow(total, scrollTop, 400, rowH, 8);
    const firstVisible = Math.floor(scrollTop / rowH);
    assert.ok(start <= firstVisible, `start ${start} > firstVisible ${firstVisible}`);
    assert.ok(end > firstVisible, `end ${end} <= firstVisible ${firstVisible}`);
  }
});

test("csvWindow clamps degenerate inputs instead of producing negatives", () => {
  assert.deepEqual(csvWindow(0, 0, 400, 20), { start: 0, end: 0, padTop: 0, padBottom: 0 });
  assert.deepEqual(csvWindow(5, 0, 400, 20, 0), { start: 0, end: 5, padTop: 0, padBottom: 0 });
  assert.deepEqual(csvWindow(100, 1e9, 400, 20, 0), { start: 80, end: 100, padTop: 1600, padBottom: 0 });
  assert.deepEqual(csvWindow(10, -500, 400, 20, 0), { start: 0, end: 10, padTop: 0, padBottom: 0 });
  assert.deepEqual(csvWindow(10, 0, 400, 0), { start: 0, end: 0, padTop: 0, padBottom: 0 }); // rowH unmeasured
});

// ── A real-world file, end to end ───────────────────────────────────────────

test("a quoted, ragged, mixed CSV parses into the table the viewer shows", () => {
  const text = [
    'city,"units sold",note',
    '"Portland, OR",1234,"line one',
    'line two"',
    'Boise,"2,500",',
    'Reno,-3.5%,"He said ""hi"""',
  ].join("\n");
  const rows = parseDelimited(text);
  assert.deepEqual(rows, [
    ["city", "units sold", "note"],
    ["Portland, OR", "1234", "line one\nline two"],
    ["Boise", "2,500", ""],
    ["Reno", "-3.5%", 'He said "hi"'],
  ]);
  assert.deepEqual(csvHeaders(rows, true), ["city", "units sold", "note"]);
  assert.deepEqual(columnAlignments(rows, true), ["left", "right", "left"]);
  assert.equal(csvSummary(rows, true), "3 rows × 3 columns");
});

console.log(`\n${passed} CSV viewer tests passed.`);
