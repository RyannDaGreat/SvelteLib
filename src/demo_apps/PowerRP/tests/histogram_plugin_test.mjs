/**
 * HISTOGRAM PLUGIN ASSET — bare-node tests.
 *
 * WHAT THIS GUARDS. `projects/Imitations/assets/histogram.plugin.js` is a jailed
 * plugin asset, so it cannot be imported: its helpers are private to a function
 * body evaluated inside core/plugin_assets.js's sandbox. What IS observable is
 * `emit(state)` → a display list, so that is what these tests assert against, with
 * EXACT expected geometry rather than snapshots.
 *
 * WHY THE EDGE CASES ARE THE POINT. Binning is where a histogram is silently wrong
 * rather than loudly wrong, and every case below was chosen because getting it
 * wrong produces a picture that LOOKS like data:
 *
 *   - the MAXIMUM SAMPLE. Bins are half-open [lo, hi), so with auto-range the
 *     single largest sample sits exactly on the top edge and falls outside every
 *     bin unless the last one closes. The classic off-by-one; it loses one count
 *     from the rightmost bar, which nobody notices.
 *   - ALL-IDENTICAL samples (and one sample). lo === hi, so a naive
 *     (value - lo)/width is 0/0 → NaN geometry, or a division that makes every bar
 *     infinitely tall.
 *   - NEGATIVE samples. A count axis is always zero-based (a count cannot be
 *     negative), but the DATA axis is not, so the range and the edge labels must
 *     carry the sign while the bars still grow up from the baseline.
 *   - EMPTY data. Must be a loud error, never an empty chart — "no samples" and
 *     "all bins empty" are indistinguishable once drawn.
 *   - a MANUAL RANGE that excludes samples. Dropping them is requested behaviour;
 *     doing it silently is not.
 *
 * Bare node, no DOM, no GPU — the whole widget is pure over its state, which is
 * exactly the property that lets it be tested this way (CLAUDE.md's three kinds of
 * state: this widget is property state throughout).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginAsset, registerPluginAssets } from "../core/plugin_assets.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { ROW_KINDS } from "../core/properties.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "../projects/Imitations/assets/histogram.plugin.js"), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The loaded plugin, through the real jail — the same path a project load takes. */
const histogram = loadPluginAsset(SOURCE, "histogram.plugin.js", new Set());
/** An identity world transform: applyEffects needs one, and with every effect off
 *  it passes the ops through untouched. */
const WORLD = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Query (calls the jailed emit). State overrides → the display list. */
const emit = (overrides) => histogram.emit({ ...histogram.defaults, ...overrides }, null, WORLD);

/** Pure function. The BAR rects of a display list: every rect except the 1-unit
 *  baseline strip and the error box (which is the full width AND has a stroke). */
const bars = (ops) => ops.filter((o) => o.op === "rect" && o.h !== 1 && o.fill !== null && o.h !== undefined && !(o.stroke && o.w === o.h));
/** Pure function. Is this display list the loud error box? Identified by its
 *  STROKED full-box panel, NOT by the presence of text: a box too short for even
 *  one line of type draws the panel alone (errorBox refuses to spill text outside
 *  its own bounds), and that case still has to read as an error. */
const isError = (ops) =>
  ops.length >= 1 && ops[0].op === "rect" && ops[0].stroke !== null && ops[0].strokeWidth === 2 && ops[0].x === 0 && ops[0].y === 0;
/** Pure function. Every text op's string. */
const texts = (ops) => ops.filter((o) => o.op === "text").map((o) => o.text);

// ── LOADING + DECLARATION ────────────────────────────────────────────────────

test("it loads through the jail and declares a well-formed plugin", () => {
  assert.equal(histogram.type, "histogram");
  assert.equal(histogram.title, "Histogram");
  assert.equal(histogram.defaults.type, "histogram");
  assert.equal(typeof histogram.emit, "function");
  assert.equal(typeof histogram.localBounds, "function");
  assert.equal(typeof histogram.anchors, "function");
  assert.equal(typeof histogram.cullMargin, "function");
  // `commands` is refused for a plugin asset (it would receive the live app).
  assert.equal(histogram.commands, undefined);
});

test("it registers alongside the whole built-in roster without collision", () => {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const { loaded, reports } = registerPluginAssets(registry, [{ name: "histogram.plugin.js", source: SOURCE }]);
  assert.deepEqual(reports, []);
  assert.deepEqual(loaded, ["histogram"]);
  assert.equal(registry.get("histogram").title, "Histogram");
});

test("every custom Inspector row uses a real row kind and has a default", () => {
  const custom = histogram.inspector.filter((r) => r.category === "custom");
  assert.ok(custom.length >= 20, `expected the histogram's knobs, got ${custom.length}`);
  for (const row of custom) {
    assert.ok(ROW_KINDS.includes(row.kind), `row ${row.key} has kind ${row.kind}`);
    assert.ok(row.key in histogram.defaults, `row ${row.key} has no default`);
    assert.ok(typeof row.help === "string" && row.help.length > 0, `row ${row.key} has no help`);
  }
  // The rows the histogram exists FOR.
  const keys = custom.map((r) => r.key);
  for (const key of ["source", "values", "csvUrl", "csvColumn", "binMode", "binCount", "binWidth", "rangeMode", "rangeMin", "rangeMax"])
    assert.ok(keys.includes(key), `missing the ${key} row`);
});

test("localBounds is the box, and the standard nine anchors are declared", () => {
  assert.deepEqual(histogram.localBounds({ w: 300, h: 200 }), { x: 0, y: 0, w: 300, h: 200 });
  const anchors = histogram.anchors({ x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(anchors.map((a) => a.id), ["tl", "tm", "tr", "ml", "cm", "mr", "bl", "bm", "br"]);
  assert.deepEqual(anchors.find((a) => a.id === "cm"), { id: "cm", x: 50, y: 25 });
});

// ── THE BINNING, through emit's exact geometry ───────────────────────────────

/** A base state with the label bands OFF, so the plot fills the box and a bar's
 *  height is exactly (count / maxCount) * h — which makes the counts readable
 *  straight off the geometry. */
const PLAIN = {
  w: 400, h: 100, showCounts: false, showEdges: false, showBaseline: false,
  barStrokeWidth: 0, binMode: "count",
};

test("binning: four bins over 0..4, and the MAXIMUM SAMPLE lands in the last bin", () => {
  // [0,1,2,3,4] over range 0..4 in 4 bins ⇒ edges 0,1,2,3,4.
  // Half-open bins would put the 4 outside every bin and lose it; the last bin
  // CLOSES, so bin 3 holds both 3 and 4 and the counts sum to 5.
  const ops = emit({ ...PLAIN, source: "inline", values: "0 1 2 3 4", binCount: 4 });
  const rects = bars(ops);
  assert.equal(rects.length, 4);
  const counts = rects.map((r) => Math.round((r.h / 100) * 2)); // maxCount is 2
  assert.deepEqual(counts, [1, 1, 1, 2]);
  assert.equal(counts.reduce((a, b) => a + b, 0), 5, "every sample must be counted exactly once");
  // Bars TILE the width at the default bar fraction of 1: 4 slots of 100.
  assert.deepEqual(rects.map((r) => r.x), [0, 100, 200, 300]);
  assert.deepEqual(rects.map((r) => r.w), [100, 100, 100, 100]);
  // The tallest bar fills the plot; a 1-count bar is half of it.
  assert.deepEqual(rects.map((r) => r.h), [50, 50, 50, 100]);
  assert.deepEqual(rects.map((r) => r.y), [50, 50, 50, 0]);
});

test("binning: an EMPTY bin emits NO INK AT ALL, and prints no count", () => {
  // 0 and 10 only, in 5 bins over 0..10 ⇒ bins 1,2,3 are empty.
  //
  // A zero-height bar must not be emitted, because a STROKED rect of height 0
  // still paints its outline: a 1-unit sliver on the baseline that reads as "a
  // sample or two here" when the truth is none. Found by looking at a CLI still,
  // so it is pinned here.
  const ops = emit({ ...PLAIN, showCounts: true, barStrokeWidth: 1, values: "0 10", binCount: 5 });
  const rects = bars(ops);
  assert.equal(rects.length, 2, "only the two OCCUPIED bins emit a rect");
  assert.deepEqual(rects.map((r) => r.x), [0, 320], "and they sit in bins 0 and 4");
  assert.ok(rects.every((r) => r.h > 0));
  // Only the two occupied bins print a label — a column of "0"s would be noise.
  assert.deepEqual(texts(ops), ["1", "1"]);
});

test("edge case: ALL-IDENTICAL samples give one full bar on a widened ±0.5 range", () => {
  // lo === hi would be a zero-width range: every bin zero-wide, every position
  // 0/0. The interval is widened to [6.5, 7.5], which is the truthful picture of
  // "all the mass is at 7".
  const ops = emit({ ...PLAIN, showEdges: true, values: "7 7 7 7", binCount: 1 });
  const rects = bars(ops);
  assert.equal(rects.length, 1);
  assert.equal(rects[0].h > 0, true);
  assert.ok(Number.isFinite(rects[0].y), "a degenerate range must not produce NaN geometry");
  assert.ok(Number.isFinite(rects[0].h));
  assert.deepEqual(texts(ops), ["6.5", "7.5"]);
});

test("edge case: ONE sample behaves like the all-identical case", () => {
  const ops = emit({ ...PLAIN, showCounts: true, showEdges: true, values: "7", binCount: 1 });
  const rects = bars(ops);
  assert.equal(rects.length, 1);
  // With both label bands on, the plot is the 100-unit box minus a
  // (labelSize + gap) band top and bottom: 100 - (14 + 4) - (14 + 6) = 62. The
  // one bin is the tallest, so its bar fills exactly that.
  assert.equal(rects[0].h, 62, "the single sample's bin is the tallest, so it fills the plot");
  assert.equal(rects[0].y, 18, "the bar starts just below the count-label band");
  assert.deepEqual(texts(ops), ["1", "6.5", "7.5"]);
});

test("edge case: NEGATIVE samples keep the sign on the data axis, bars still grow UP", () => {
  // Range -10..10 in 4 bins ⇒ edges -10,-5,0,5,10. One sample per bin.
  const ops = emit({ ...PLAIN, showEdges: true, values: "-10 -3 3 10", binCount: 4 });
  const rects = bars(ops);
  assert.equal(rects.length, 4);
  // Every count is 1, so every bar is full height and starts at the plot's top —
  // a count axis is zero-based regardless of the data's sign. The edge-label band
  // takes (labelSize + gap) = 20 off the bottom of the 100-unit box.
  assert.deepEqual(rects.map((r) => r.h), [80, 80, 80, 80]);
  assert.deepEqual(rects.map((r) => r.y), [0, 0, 0, 0]);
  // The EDGE labels carry the negative range.
  assert.deepEqual(texts(ops), ["-10", "-5", "0", "5", "10"]);
});

test("edge case: EMPTY data is a loud error, never an empty chart", () => {
  const blank = emit({ ...PLAIN, values: "   " });
  assert.ok(isError(blank), "no samples must draw the error box");
  assert.match(texts(blank).join(" "), /no samples/);
  // And a non-numeric token fails the whole parse, naming the token — it is not
  // skipped and not read as zero.
  const bad = emit({ ...PLAIN, values: "1 2 n/a 4" });
  assert.ok(isError(bad));
  assert.match(texts(bad).join(" "), /"n\/a" is not a number/);
});

test("bin modes: auto (Sturges), fixed count, and fixed width", () => {
  // 16 samples ⇒ ceil(log2(16) + 1) = 5 bins.
  const sixteen = "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16";
  assert.equal(bars(emit({ ...PLAIN, binMode: "auto", values: sixteen })).length, 5);
  assert.equal(bars(emit({ ...PLAIN, binMode: "count", binCount: 12, values: sixteen })).length, 12);
  // Fixed width: range 1..16 is a span of 15, at width 5 ⇒ ceil(15/5) = 3 bins.
  assert.equal(bars(emit({ ...PLAIN, binMode: "width", binWidth: 5, values: sixteen })).length, 3);
  // ceil(15/4) = 4.
  assert.equal(bars(emit({ ...PLAIN, binMode: "width", binWidth: 4, values: sixteen })).length, 4);
  // A width of zero is REPORTED, not guessed — it would be an infinite bin count.
  const zero = emit({ ...PLAIN, binMode: "width", binWidth: 0, values: sixteen });
  assert.ok(isError(zero));
  assert.match(texts(zero).join(" "), /bin width must be above zero/);
});

test("manual range: it clips, it ANNOUNCES what it dropped, and it refuses inversion", () => {
  const ops = emit({
    ...PLAIN, showCounts: true, values: "-5 1 2 3 99",
    rangeMode: "manual", rangeMin: 0, rangeMax: 4, binCount: 2,
  });
  assert.ok(!isError(ops));
  const rects = bars(ops);
  assert.equal(rects.length, 2);
  // Edges 0,2,4: bin 0 holds 1, bin 1 holds 2 and 3.
  assert.deepEqual(rects.map((r) => Math.round((r.h / 100) * 2)), [1, 2]);
  // The two excluded samples are named on the chart, not inferred from short bars.
  assert.ok(texts(ops).includes("2 outside range"), `got ${JSON.stringify(texts(ops))}`);
  // An inverted range is the author's typo, and is refused.
  const inverted = emit({ ...PLAIN, values: "1 2 3", rangeMode: "manual", rangeMin: 5, rangeMax: 1 });
  assert.ok(isError(inverted));
  assert.match(texts(inverted).join(" "), /minimum \(5\) is above the maximum \(1\)/);
  // A range that excludes EVERY sample would draw an all-empty chart: refused.
  const disjoint = emit({ ...PLAIN, values: "1 2 3", rangeMode: "manual", rangeMin: 10, rangeMax: 20 });
  assert.ok(isError(disjoint));
  assert.match(texts(disjoint).join(" "), /no sample falls in the range 10 … 20/);
});

test("reveal: 0 emits nothing, 1 draws full bars, and the BASE stays put", () => {
  const base = { ...PLAIN, values: "1 1 2", binCount: 2 };
  // reveal 0 makes every bar zero-height, and a zero-height bar emits no ink —
  // so a fully-unrevealed histogram is an EMPTY display list, not a row of
  // baseline slivers.
  assert.deepEqual(bars(emit({ ...base, reveal: 0 })), []);
  const half = bars(emit({ ...base, reveal: 0.5 }));
  assert.deepEqual(half.map((r) => r.h), [50, 25]);
  const full = bars(emit({ ...base, reveal: 1 }));
  assert.deepEqual(full.map((r) => r.h), [100, 50]);
});

test("bar fraction: 1 tiles the slots, below 1 centers a gapped bar in each", () => {
  const tiled = bars(emit({ ...PLAIN, values: "1 2", binCount: 2, barFraction: 1 }));
  assert.deepEqual(tiled.map((r) => [r.x, r.w]), [[0, 200], [200, 200]]);
  const gapped = bars(emit({ ...PLAIN, values: "1 2", binCount: 2, barFraction: 0.5 }));
  assert.deepEqual(gapped.map((r) => [r.x, r.w]), [[50, 100], [250, 100]]);
});

test("edge labels THIN OUT when there are more bins than fit, keeping first and last", () => {
  const many = emit({ ...PLAIN, w: 200, showEdges: true, binCount: 40, values: "0 10 20 30 40" });
  const labels = texts(many);
  // A 200-unit box cannot carry 41 labels; it carries a handful, and the last one
  // is always the range's top edge.
  assert.ok(labels.length < 41 / 2, `expected thinned labels, got ${labels.length}`);
  assert.equal(labels[0], "0");
  assert.equal(labels[labels.length - 1], "40");
});

test("edge labels never COLLIDE: every drawn label clears its neighbour", () => {
  // The right-hand end is where thinning and the always-drawn final upper edge
  // crowd together, and a budget guessed from an average character count put
  // "21.43 22.21 23" on top of each other in a CLI still. So: sweep the bin
  // counts a real chart uses and assert the labels are actually disjoint, using
  // the same glyph estimate the widget lays them out with.
  const GLYPH = 0.55;
  for (const binCount of [3, 7, 9, 14, 20, 33]) {
    for (const w of [300, 560, 900]) {
      const ops = emit({ ...PLAIN, w, showEdges: true, binMode: "count", binCount, values: "12 14 16 18 20 23" });
      const labels = ops.filter((o) => o.op === "text");
      const size = histogram.defaults.labelSize;
      for (let i = 1; i < labels.length; i++) {
        const prevEnd = labels[i - 1].x + labels[i - 1].text.length * size * GLYPH;
        assert.ok(
          labels[i].x >= prevEnd,
          `at ${binCount} bins in ${w} units, "${labels[i - 1].text}" overlaps "${labels[i].text}" (${prevEnd.toFixed(1)} > ${labels[i].x.toFixed(1)})`,
        );
      }
      // The range's two ends are always stated, whatever the thinning did.
      assert.equal(labels[0].text, "12");
      assert.equal(labels[labels.length - 1].text, "23");
    }
  }
});

test("non-round bin edges are formatted to significant figures, not raw floats", () => {
  // Range 0..10 in 3 bins ⇒ edges 0, 3.3333333333333335, 6.666666666666667, 10.
  const labels = texts(emit({ ...PLAIN, showEdges: true, values: "0 5 10", binCount: 3 }));
  assert.deepEqual(labels, ["0", "3.333", "6.667", "10"]);
});

test("a degenerate box, and a box too short for its labels", () => {
  assert.deepEqual(emit({ w: 0, h: 100 }), []);
  assert.deepEqual(emit({ w: 400, h: 0 }), []);
  // 20 units of box cannot hold 20-unit type, so the error PANEL draws and its
  // text is withheld rather than spilling outside the widget's own bounds. It
  // still reads as an error, which is the property that matters.
  const squashed = emit({ w: 400, h: 20, labelSize: 20, showCounts: true, showEdges: true });
  assert.ok(isError(squashed));
  assert.deepEqual(texts(squashed), []);
  assert.equal(squashed.length, 1);
  // Given room for its own type but still not for a plot — the two 20-unit label
  // bands need 24 + 26 = 50 of the box's height — the same failure states itself
  // in words.
  const roomy = emit({ w: 400, h: 44, labelSize: 20, showCounts: true, showEdges: true });
  assert.ok(isError(roomy));
  assert.match(texts(roomy).join(" "), /too short/);
});

test("the CSV source is GHOST until a file is named, and loud when it cannot be read", () => {
  // No url yet: unconfigured, not broken ⇒ draw nothing.
  assert.deepEqual(emit({ ...PLAIN, source: "csv", csvUrl: "" }), []);
  // A url that resolves to nothing IS an error, and it names the url. (In bare
  // node the text-asset registry reads from disk synchronously, so this settles
  // within the call rather than reporting "loading".)
  const missing = emit({ ...PLAIN, source: "csv", csvUrl: "/asset/Imitations/definitely_absent.csv" });
  assert.ok(isError(missing), `expected the error box, got ${JSON.stringify(missing.map((o) => o.op))}`);
  assert.match(texts(missing).join(" "), /definitely_absent\.csv/);
});

test("the CSV source bins one column of a REAL project asset", () => {
  // projects/Imitations/assets/sample_data.csv is stage,seconds over 5 rows —
  // every ROW is one sample here, which is the histogram/bar-chart difference:
  // csv_bar_graph would draw 5 bars, this bins 5 samples into 2.
  const ops = emit({
    ...PLAIN, showCounts: true, source: "csv",
    csvUrl: "/asset/Imitations/sample_data.csv", csvColumn: "seconds", hasHeader: true,
    binCount: 2,
  });
  assert.ok(!isError(ops), `expected a chart, got ${JSON.stringify(texts(ops))}`);
  const rects = bars(ops);
  assert.equal(rects.length, 2);
  // Samples 0.8, 2.4, 3.1, 6.5, 4.2 ⇒ range 0.8..6.5, 2 bins split at 3.65:
  // bin 0 holds 0.8, 2.4, 3.1 (three); bin 1 holds 4.2 and 6.5 (two).
  assert.deepEqual(texts(ops), ["3", "2"]);
  // A column of words is an error naming the row, not a chart of zeros.
  const wrong = emit({
    ...PLAIN, source: "csv", csvUrl: "/asset/Imitations/sample_data.csv",
    csvColumn: "stage", hasHeader: true,
  });
  assert.ok(isError(wrong));
  assert.match(texts(wrong).join(" "), /row 2: "Parse" in column "stage" is not a number/);
  // A misnamed column lists the ones that exist.
  const noColumn = emit({
    ...PLAIN, source: "csv", csvUrl: "/asset/Imitations/sample_data.csv",
    csvColumn: "milliseconds", hasHeader: true,
  });
  assert.ok(isError(noColumn));
  assert.match(texts(noColumn).join(" "), /no column "milliseconds" — this CSV has: stage, seconds/);
});

// ── DETERMINISM ──────────────────────────────────────────────────────────────

test("determinism: the same state emits a BYTE-IDENTICAL display list every time", () => {
  // The Δt = 0 law (CLAUDE.md): this widget reads no clock and no ambient input,
  // so repeated emits must agree exactly. That is what lets a sharded export
  // render frame 200 without frame 199.
  const state = { ...PLAIN, showCounts: true, showEdges: true, values: "4 8 15 16 23 42", binMode: "auto" };
  const first = JSON.stringify(emit(state));
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(emit(state)), first);
  // And the CSV path is equally stable — a project asset is document state.
  const csv = { ...PLAIN, source: "csv", csvUrl: "/asset/Imitations/sample_data.csv", csvColumn: "seconds" };
  assert.equal(JSON.stringify(emit(csv)), JSON.stringify(emit(csv)));
});

console.log(`\n${passed} tests passed`);
