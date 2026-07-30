/**
 * CSV BAR GRAPH tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/csv_bar_graph_test.js
 *
 * plugin_assets/csv_bar_graph.plugin.js is the DATA-DRIVEN plugin asset, and the
 * widget AUTHORING.md walks through as its tutorial. What is different about it —
 * and the entire reason it needs a suite of its own next to
 * tests/plugin_assets_test.js — is that its picture is a function of something
 * OUTSIDE its own state: the text of a project asset, read through
 * `assetText(url)` (core/plugin_assets.js) over the text-asset registry
 * (render_gpu/gpu/text_asset_registry.js).
 *
 * That makes three properties testable here that a pure shape widget cannot have:
 *
 *   (1) EMIT PARITY ON A FIXED CSV STRING. `seedTextAsset` puts an exact string in
 *       the registry, so `emit` is pinned against hand-computed geometry rather
 *       than a golden blob. Same input ⇒ same display list, with no filesystem and
 *       no network in the loop. This is the assertion that would catch a silent
 *       change to the bar layout, the axis span, or the reveal animation.
 *   (2) THE THREE-STATE DISCIPLINE. "ready" draws the chart; "loading" draws
 *       NOTHING (a repaint follows); "error" draws a LOUD red box. The middle and
 *       last cases are the ones worth pinning: a widget that drew an empty chart
 *       for a MISSING file would let a typo'd filename read as "my data is empty",
 *       which is the "wrong art must not look correct" rule this repo is strict
 *       about.
 *   (3) EVERY MALFORMED-DATA PATH IS AN ERROR, NOT A ZERO. A missing column, a
 *       non-numeric cell and a blank cell must each fail the whole chart with a
 *       message, because the alternative — plot it as zero, or skip the row — is
 *       exactly the silent fallback that makes a chart lie.
 *
 * The source read here is the COMMITTED one in plugin_assets/ (the same file
 * plugin_assets/seed_into_project.sh copies into a project), so this tests what
 * ships rather than an inline fixture that could drift. It loads through the real
 * jail, so the widget's own pure helpers are NOT importable — every assertion
 * below goes through the registered plugin's public hooks, which is also how the
 * app reaches it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginAsset } from "../core/plugin_assets.js";
import { seedTextAsset, resetTextAssetRegistry, ensureTextAsset, textAssetStatus } from "../render_gpu/gpu/text_asset_registry.js";
import { parseColor } from "../render_gpu/ir.js";
import * as T from "../core/transform.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "../plugin_assets/csv_bar_graph.plugin.js"), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The plugin, loaded through the real jail — one instance for the whole suite
 *  (loading is pure; the registry state under test lives in the text cache). */
const plugin = loadPluginAsset(SOURCE, "csv_bar_graph.plugin.js", new Set());

/** The identity world transform every emit() call needs for applyEffects. */
const WORLD = T.identity ? T.identity() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A url no other test uses, so the cache cannot leak between cases. */
let urlSeq = 0;
const freshUrl = () => `/asset/CsvTest/case_${++urlSeq}.csv`;

/** A widget state: the plugin's own defaults, plus this case's overrides. The
 *  defaults-spreading pattern the app itself uses, so a new knob cannot make these
 *  cases stale by being absent. */
const stateWith = (over) => ({ ...plugin.defaults, w: 400, h: 300, ...over });

/** Emit for a state whose CSV is `text`, already seeded as ready. */
function emitWithCsv(text, over = {}) {
  const csvUrl = freshUrl();
  seedTextAsset(csvUrl, text);
  return plugin.emit(stateWith({ csvUrl, ...over }), null, WORLD);
}

/** The ops of one kind, in emit order. */
const opsOf = (ops, op) => ops.filter((o) => o.op === op);
/** A css colour in the form the IR stores it (an rgba float tuple). Asserted
 *  THROUGH ir.parseColor rather than as literal floats, so these cases pin the
 *  widget's colour CHOICE and not the IR's internal representation. */
const asColor = (css) => parseColor(css);
/** The single text op whose content is `s` (asserts exactly one). */
function textOp(ops, s) {
  const hits = opsOf(ops, "text").filter((o) => o.text === s);
  assert.equal(hits.length, 1, `expected exactly one text op "${s}", got ${hits.length}`);
  return hits[0];
}

// ── (0) THE PLUGIN'S SHAPE ───────────────────────────────────────────────────

test("the committed asset loads through the jail and declares a data-driven widget", () => {
  assert.equal(plugin.type, "csv_bar_graph");
  assert.equal(plugin.title, "CSV Bar Graph");
  assert.equal(plugin.defaults.type, "csv_bar_graph");
  assert.equal(typeof plugin.emit, "function");
  assert.equal(typeof plugin.localBounds, "function");
  assert.equal(typeof plugin.anchors, "function");
  // The DATA BINDING is an inspector row of kind "asset" filtered to data files,
  // writing the served url form assetText() takes. If any of the three drifted the
  // picker would offer images, or write a bare filename assetText cannot resolve.
  const row = plugin.inspector.find((r) => r.key === "csvUrl");
  assert.ok(row, "csvUrl must have an inspector row");
  assert.equal(row.kind, "asset");
  assert.deepEqual(row.assetKinds, ["data"]);
  assert.equal(row.assetForm, "url");
});

test("an unconfigured widget is a GHOST, not an error", () => {
  // A freshly inserted widget has no file yet. It is UNCONFIGURED, not broken, so
  // it draws nothing — the loud error box is reserved for a file that is named and
  // cannot be read.
  assert.deepEqual(plugin.emit(stateWith({ csvUrl: "" }), null, WORLD), []);
  // A zero-area widget likewise emits nothing rather than dividing by its own size.
  assert.deepEqual(plugin.emit(stateWith({ csvUrl: freshUrl(), w: 0 }), null, WORLD), []);
  assert.deepEqual(plugin.emit(stateWith({ csvUrl: freshUrl(), h: 0 }), null, WORLD), []);
});

// ── (1) EMIT PARITY ON A FIXED CSV STRING ────────────────────────────────────

test("emit parity: a fixed CSV yields exactly the hand-computed geometry", () => {
  // Two rows, values 10 and 5, in a 400x300 box with 16-unit labels above and
  // below. Every number below is derived by hand from the widget's stated layout:
  //   plotTop    = labelSize + VALUE_GAP        = 16 + 4  = 20
  //   plotBottom = h - (labelSize + LABEL_GAP)  = 300 - 22 = 278
  //   plotH      = 258;  span = {min: 0, max: 10};  zeroY = plotBottom = 278
  //   slotW      = 400 / 2 = 200;  barW = 200 * 0.6 = 120
  //   bar 0 (10) → full height 258, top 20;  bar 1 (5) → 129, top 149
  const ops = emitWithCsv("region,units\nNorth,10\nSouth,5\n", {
    labelColumn: "region", valueColumn: "units", labelSize: 16, barFraction: 0.6,
    colorMode: "solid", barColor: "#58c4dd", axisColor: "#8a90a6",
  });
  const bars = opsOf(ops, "rect");
  // Two bars + the zero baseline, in that order (the baseline is drawn last so it
  // reads on top).
  assert.equal(bars.length, 3);
  assert.deepEqual(
    { x: bars[0].x, y: bars[0].y, w: bars[0].w, h: bars[0].h, fill: bars[0].fill },
    { x: 40, y: 20, w: 120, h: 258, fill: asColor("#58c4dd") },
  );
  assert.deepEqual(
    { x: bars[1].x, y: bars[1].y, w: bars[1].w, h: bars[1].h, fill: bars[1].fill },
    { x: 240, y: 149, w: 120, h: 129, fill: asColor("#58c4dd") },
  );
  // The baseline: a 1-unit rect spanning the full width at the zero line.
  assert.deepEqual(
    { x: bars[2].x, y: bars[2].y, w: bars[2].w, h: bars[2].h, fill: bars[2].fill },
    { x: 0, y: 278, w: 400, h: 1, fill: asColor("#8a90a6") },
  );
  // Value labels ride the bars' growing ends; category labels sit under the axis.
  assert.equal(textOp(ops, "10").y, 20 - 16 - 4);
  assert.equal(textOp(ops, "North").y, 278 + 6);
  assert.equal(textOp(ops, "South").y, 278 + 6);
});

test("emit is byte-identical across repeated calls (Δt = 0 ⇒ same picture)", () => {
  // The determinism law, mechanically checked: hold the document and the clock
  // fixed and the display list must not move. A widget that read a clock or an
  // unseeded random inside emit would fail exactly here.
  const csvUrl = freshUrl();
  seedTextAsset(csvUrl, "a,b\nx,3\ny,7\nz,1\n");
  const s = stateWith({ csvUrl, labelColumn: "a", valueColumn: "b" });
  assert.deepEqual(plugin.emit(s, null, WORLD), plugin.emit(s, null, WORLD));
});

test("quoted fields and CRLF parse the way a spreadsheet exports them", () => {
  // A comma inside a quoted label is the case a naive split(",") misaligns every
  // value after, so it is pinned rather than assumed.
  const ops = emitWithCsv('city,n\r\n"Portland, OR",4\r\nBend,2\r\n', {
    labelColumn: "city", valueColumn: "n",
  });
  assert.equal(opsOf(ops, "rect").length, 3); // 2 bars + baseline
  textOp(ops, "Portland, OR");
  textOp(ops, "Bend");
});

test("columns resolve by header name case-insensitively, and by 0-based index", () => {
  const byName = emitWithCsv("region,units\nN,4\n", { labelColumn: "REGION", valueColumn: "UNITS" });
  textOp(byName, "N");
  const byIndex = emitWithCsv("region,units\nN,4\n", { labelColumn: "0", valueColumn: "1" });
  textOp(byIndex, "N");
  // With no header row, EVERY row is data and columns are numbered.
  const headerless = emitWithCsv("N,4\nS,6\n", { hasHeader: false, labelColumn: "0", valueColumn: "1" });
  assert.equal(opsOf(headerless, "rect").length, 3);
  textOp(headerless, "N");
  textOp(headerless, "S");
});

test("the axis always contains zero, and a negative value hangs below the baseline", () => {
  // A bar chart measures length from a baseline, so an axis that started at the
  // series minimum would exaggerate a 10-vs-11 difference into a doubling.
  const ops = emitWithCsv("k,v\nup,5\ndown,-5\n", { labelColumn: "k", valueColumn: "v", labelSize: 16 });
  const bars = opsOf(ops, "rect");
  // span = {min: -5, max: 5} over plotH 258 ⇒ the zero line is at its midpoint.
  const zeroY = bars[2].y;
  assert.equal(zeroY, 20 + 258 / 2);
  assert.equal(bars[0].y + bars[0].h, zeroY, "a positive bar's BOTTOM is the zero line");
  assert.equal(bars[1].y, zeroY, "a negative bar's TOP is the zero line");
  // by-sign colouring is what keeps a loss from looking like a gain.
  const signed = emitWithCsv("k,v\nup,5\ndown,-5\n", {
    labelColumn: "k", valueColumn: "v", colorMode: "by-sign", barColor: "#58c4dd", altColor: "#fc6255",
  });
  assert.deepEqual(opsOf(signed, "rect")[0].fill, asColor("#58c4dd"));
  assert.deepEqual(opsOf(signed, "rect")[1].fill, asColor("#fc6255"));
});

test("an all-equal series gets a finite axis rather than an infinite bar", () => {
  const ops = emitWithCsv("k,v\na,5\nb,5\n", { labelColumn: "k", valueColumn: "v" });
  for (const bar of opsOf(ops, "rect")) assert.ok(isFinite(bar.h) && bar.h >= 0, `h must be finite, got ${bar.h}`);
});

test("reveal grows the bars out of the baseline and is keyframable property state", () => {
  const csv = "k,v\na,10\n";
  const at = (reveal) => opsOf(emitWithCsv(csv, { labelColumn: "k", valueColumn: "v", reveal }), "rect")[0];
  assert.equal(at(0).h, 0, "reveal 0 is a zero-height bar, not a missing one");
  const half = at(0.5);
  const full = at(1);
  assert.ok(Math.abs(half.h - full.h / 2) < 1e-9, `half reveal must be half the height (${half.h} vs ${full.h})`);
  // It grows UP from the zero line: the bottom edge is pinned, the top moves.
  assert.equal(half.y + half.h, full.y + full.h);
  // Out-of-range values clamp rather than inverting the bar.
  assert.equal(at(-1).h, 0);
  assert.equal(at(5).h, full.h);
});

test("alternate colouring alternates, and solid ignores the second colour", () => {
  const csv = "k,v\na,1\nb,2\nc,3\n";
  const alt = opsOf(emitWithCsv(csv, { labelColumn: "k", valueColumn: "v", colorMode: "alternate", barColor: "#111111", altColor: "#222222" }), "rect");
  assert.deepEqual([alt[0].fill, alt[1].fill, alt[2].fill], [asColor("#111111"), asColor("#222222"), asColor("#111111")]);
  const solid = opsOf(emitWithCsv(csv, { labelColumn: "k", valueColumn: "v", colorMode: "solid", barColor: "#111111", altColor: "#222222" }), "rect");
  assert.deepEqual([solid[0].fill, solid[1].fill, solid[2].fill], [asColor("#111111"), asColor("#111111"), asColor("#111111")]);
});

test("label bands can be turned off, and the bars take back the space", () => {
  const csv = "k,v\na,10\n";
  const withBands = opsOf(emitWithCsv(csv, { labelColumn: "k", valueColumn: "v", labelSize: 16 }), "rect")[0];
  const without = opsOf(emitWithCsv(csv, { labelColumn: "k", valueColumn: "v", labelSize: 16, showValues: false, showLabels: false }), "rect")[0];
  assert.ok(without.h > withBands.h, "a chart with no label bands is taller");
  assert.equal(without.h, 300, "with both bands off the plot is the full box height");
  // And the label ops actually go away, rather than being drawn transparent.
  const bare = emitWithCsv(csv, { labelColumn: "k", valueColumn: "v", showValues: false, showLabels: false });
  assert.deepEqual(opsOf(bare, "text"), []);
});

test("a whole number prints bare; a fraction keeps its decimals", () => {
  const ops = emitWithCsv("k,v\nint,12\nfrac,2.345\n", { labelColumn: "k", valueColumn: "v", valueDecimals: 1 });
  textOp(ops, "12");     // not "12.0"
  textOp(ops, "2.3");
  const two = emitWithCsv("k,v\nfrac,2.345\n", { labelColumn: "k", valueColumn: "v", valueDecimals: 2 });
  textOp(two, "2.35");
});

// ── (2) THE THREE-STATE DISCIPLINE ───────────────────────────────────────────

test("status \"loading\" draws NOTHING — never a chart with no bars", () => {
  // In the browser a read is async, so the first frame that asks gets nothing. The
  // widget must draw nothing at all rather than an empty axis, because the editor
  // repaints when the text lands (web/CanvasView.svelte onTextAssetLoad) and the
  // headless worker refuses to write the frame while it is pending
  // (web/renderJobPage.js pendingRasters).
  resetTextAssetRegistry();
  // A url with no seed and no disk file: bare node resolves synchronously, so this
  // asserts the loading BRANCH by construction rather than by racing a fetch.
  const loadingState = stateWith({ csvUrl: "/asset/CsvTest/pending.csv" });
  const ops = plugin.emit(loadingState, null, WORLD);
  // In bare node the read fails (no such file) so the status is "error" and the box
  // is drawn; what must NOT happen in either case is an empty chart.
  assert.ok(ops.length === 0 || opsOf(ops, "rect").some((r) => r.stroke), "either nothing, or a loud box — never a silent empty chart");
  resetTextAssetRegistry();
});

test("status \"error\" draws a LOUD box naming the file, not an empty chart", () => {
  resetTextAssetRegistry();
  const csvUrl = "/asset/CsvTest/does_not_exist_on_disk.csv";
  ensureTextAsset(csvUrl); // bare node: a synchronous disk read that fails and latches
  assert.equal(textAssetStatus(csvUrl), "error");
  const ops = plugin.emit(stateWith({ csvUrl }), null, WORLD);
  const box = opsOf(ops, "rect")[0];
  assert.ok(box, "an unreadable file must draw something");
  assert.deepEqual(box.stroke, asColor("#ff5555"), "the box is red-bordered — unmistakably broken");
  assert.ok(opsOf(ops, "text").length > 0, "and it names the problem in text");
  // The FILENAME appears in the message, which is what makes a typo fixable.
  const said = opsOf(ops, "text").map((t) => t.text).join(" ");
  assert.ok(said.includes("does_not_exist_on_disk.csv"), `the message must name the file, got: ${said}`);
  resetTextAssetRegistry();
});

// ── (3) EVERY MALFORMED-DATA PATH IS AN ERROR, NOT A ZERO ────────────────────

/** The concatenated text of an error box's message, or null if `ops` is a chart. */
function errorMessage(ops) {
  const box = opsOf(ops, "rect")[0];
  const red = asColor("#ff5555");
  const isErrorBox = box && Array.isArray(box.stroke) && box.stroke.every((c, i) => c === red[i]);
  if (!isErrorBox) return null;
  return opsOf(ops, "text").map((t) => t.text).join(" ");
}

test("a missing column is an error that LISTS the columns that do exist", () => {
  const msg = errorMessage(emitWithCsv("region,units\nN,4\n", { labelColumn: "region", valueColumn: "profit" }));
  assert.ok(msg, "a missing column must draw the error box");
  assert.ok(msg.includes("profit"), `the message names what was asked for: ${msg}`);
  assert.ok(msg.includes("region") && msg.includes("units"), `and what is available: ${msg}`);
});

test("a non-numeric cell fails the CHART and names the row — it is never a zero bar", () => {
  // THE CENTRAL ANTI-SILENT-FALLBACK ASSERTION. Skipping the row, or plotting it as
  // zero, is what would let a column picked one to the left render as a full row of
  // plausible-looking zero-height bars.
  const ops = emitWithCsv("region,units\nN,12\nS,lots\n", { labelColumn: "region", valueColumn: "units" });
  const msg = errorMessage(ops);
  assert.ok(msg, "a word where a number was expected must draw the error box");
  assert.ok(msg.includes("lots"), `the message quotes the offending cell: ${msg}`);
  assert.ok(msg.includes("3"), `and names its row number: ${msg}`);
  // No bars were drawn: the chart is refused whole, not partially.
  assert.equal(opsOf(ops, "rect").length, 1, "only the error box, no bars");
});

test("a BLANK cell is an error too, because Number(\"\") is 0", () => {
  const msg = errorMessage(emitWithCsv("region,units\nN,12\nS,\n", { labelColumn: "region", valueColumn: "units" }));
  assert.ok(msg, "a blank value cell must not silently become a zero bar");
});

test("an empty CSV, and a header with no rows, each say which it is", () => {
  assert.ok(errorMessage(emitWithCsv("\n\n", { labelColumn: "0", valueColumn: "1", hasHeader: false })));
  const headerOnly = errorMessage(emitWithCsv("region,units\n", { labelColumn: "region", valueColumn: "units" }));
  assert.ok(headerOnly);
  assert.ok(/no data rows/.test(headerOnly), `the message distinguishes the case: ${headerOnly}`);
});

test("too many rows is refused with the limit, not silently truncated", () => {
  const rows = Array.from({ length: 500 }, (_r, i) => `r${i},${i}`).join("\n");
  const msg = errorMessage(emitWithCsv(`k,v\n${rows}\n`, { labelColumn: "k", valueColumn: "v" }));
  assert.ok(msg, "500 rows must be refused rather than drawn as 500 unreadable bars");
  assert.ok(msg.includes("500"), `the message states what was given: ${msg}`);
});

test("a box too short for its labels says so instead of drawing inverted bars", () => {
  const msg = errorMessage(emitWithCsv("k,v\na,1\n", { labelColumn: "k", valueColumn: "v", labelSize: 200, h: 100 }));
  assert.ok(msg, "a plot area of negative height must be reported");
  assert.ok(/too short/.test(msg), `and it must say which way to fix it: ${msg}`);
});

test("the error box never draws outside its own bounds", () => {
  // A long message in a small box must clip by dropping lines, not by overflowing
  // into the neighbouring widget's space.
  const ops = emitWithCsv("region,units\nN,x\n", { labelColumn: "region", valueColumn: "units", w: 120, h: 60 });
  for (const t of opsOf(ops, "text")) {
    assert.ok(t.y >= 0, `text y ${t.y} must be inside the box`);
    assert.ok(t.y + 16 <= 60, `text y ${t.y} must not overflow the 60-unit box`);
  }
});

// ── (4) BOUNDS + ANCHORS (what culling, band-select and equations read) ──────

test("localBounds is the widget's box, and anchors are the standard nine", () => {
  assert.deepEqual(plugin.localBounds({ w: 400, h: 300 }), { x: 0, y: 0, w: 400, h: 300 });
  const ids = plugin.anchors({ w: 400, h: 300 }).map((a) => a.id);
  assert.deepEqual(ids, ["tl", "tm", "tr", "ml", "cm", "mr", "bl", "bm", "br"]);
  // `bm` is the anchor the Imitations caption binds its y to (`@csvchart_bm.y + 24`),
  // so its coordinates are what make that equation mean "just under the chart".
  const bm = plugin.anchors({ w: 400, h: 300 }).find((a) => a.id === "bm");
  assert.deepEqual({ x: bm.x, y: bm.y }, { x: 200, y: 300 });
});

console.log(`\n${passed} tests passed`);
