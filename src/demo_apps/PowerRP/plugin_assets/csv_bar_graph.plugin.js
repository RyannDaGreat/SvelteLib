// csv_bar_graph.plugin.js — the DATA-DRIVEN proof PLUGIN ASSET, and the widget
// AUTHORING.md walks through line by line as its tutorial.
//
// WHAT IT IS. A bar chart whose numbers come from a CSV FILE IN THE PROJECT'S
// ASSETS, not from the widget's own state. Point it at `sales.csv`, name a label
// column and a value column, and it draws one bar per row. Edit the CSV, reload,
// and the chart follows.
//
// WHY THIS EXAMPLE, specifically. The other proof assets (superellipse, gear) are
// shapes: everything they draw is a function of their own knobs. This one is the
// first plugin asset whose picture depends on something OUTSIDE itself, which is
// the case a "vibe-coded custom widget" most often actually is — somebody has a
// spreadsheet and wants it on a slide. It therefore exercises the one part of the
// contract a pure shape never touches: `assetText(url)` (core/plugin_assets.js),
// the read-only data seam, and the THREE-STATE discipline that comes with it.
//
// THREE STATES, AND WHY DRAWING NOTHING IS NOT AN OPTION. A file read is not
// instantaneous in a browser, so `assetText` answers with a status, and this
// widget MUST render all three differently:
//
//   "ready"   → the chart.
//   "loading" → nothing (one frame, maybe two). The editor repaints when the text
//               lands (web/CanvasView.svelte subscribes to onTextAssetLoad) and
//               the video worker refuses to write a frame while a text asset is
//               pending (web/renderJobPage.js pendingRasters), so nothing is lost.
//   "error"   → a LOUD red box naming the problem. This is the one that matters:
//               a mistyped filename, a missing column, a column of words where
//               numbers were expected — every one of those would otherwise render
//               as a chart with no bars, which an author reads as "my data is
//               empty" and debugs in the wrong place entirely. Wrong art must
//               never look correct.
//
// DETERMINISM. Reading a project asset is NOT a clock read and not a network
// call: the asset travels with the document (the zip round-trip carries assets/),
// so the same deck plots the same numbers on every machine and in every frame of
// a sharded export. That is why this seam is allowed to exist at all — see
// CLAUDE.md's three kinds of state, and core/plugin_assets.js assetText.
//
// WHAT IT IS NOT. plugins/graph_bars.js is the built-in programmatic bar graph —
// N bars from an EQUATION, with Riemann sums, lagged grow-up animation, axis
// scaling and presets. It is a better tool for every job except this one, and if
// your data fits an equation you should use it. This widget exists because a
// built-in cannot name your CSV. The two do not import each other (no plugin may
// import another); the overlap in vocabulary is deliberate reuse of names, not
// code.

// ── 1. PARSING. Pure functions, no host, no state. ───────────────────────────

/** Hard cap on plotted rows. A CSV with 10k rows would emit 10k bars into every
 *  frame's display list and hang the paint; refusing loudly at a readable limit
 *  is better than a chart nobody can read on a slide anyway. */
const MAX_ROWS = 200;
/** Bar width as a fraction of each row's slot, leaving the rest as the gap.
 *  Matches plugins/graph_bars.js's Manim-derived default so a CSV chart and a
 *  programmatic one sitting on the same slide look like siblings. */
const DEFAULT_BAR_FRACTION = 0.6;
/** Type size for the value printed above a bar, and for an axis label. */
const DEFAULT_LABEL_SIZE = 16;
/** Gap in local units between a bar's top and its printed value. */
const VALUE_GAP = 4;
/** Gap between the baseline and a category label's top. */
const LABEL_GAP = 6;
/** Rough advance width per glyph as a fraction of type size, for centering a
 *  label without a font metric (the graph_tick_marks.js constant). A plugin asset
 *  cannot measure text — no DOM — so centering is estimated, deliberately. */
const GLYPH_ADVANCE_RATIO = 0.55;
/** The error box's palette. Red on near-black: the loud "this is broken" look the
 *  built-in widgets' errorAffordance uses, restated here because a plugin asset
 *  cannot import core/graph_equation.js. */
const ERROR_FILL = "#2a0d0d";
const ERROR_STROKE = "#ff5555";
const ERROR_TEXT = "#ffb4b4";
const ERROR_PAD = 8;

/**
 * Pure function. Split CSV text into rows of cells.
 *
 * QUOTES ARE HANDLED, and that is not gold-plating: a label column is exactly
 * where a comma inside a quoted field shows up ("Portland, OR"), and a naive
 * `split(",")` turns that one row into two columns and silently misaligns every
 * value after it. CRLF is normalized because a spreadsheet exported on Windows is
 * the common case. Blank trailing lines are dropped — a text file usually ends
 * with a newline and that is not an empty row.
 *
 * NOT a full RFC 4180 parser: an escaped quote inside a quoted field ("" → ") IS
 * supported, but a literal newline inside a quoted field is not — it would need a
 * character-level state machine across lines, and a chart label containing a line
 * break is not a case worth that code. Such a file parses as extra rows, visibly
 * wrong rather than subtly wrong.
 *
 * @param {string} text - CSV file contents
 * @returns {Array<string[]>} rows of trimmed cells
 *
 * @example parseCsv("a,b\n1,2\n") // [["a", "b"], ["1", "2"]]
 * @example parseCsv('city,n\r\n"Portland, OR",4\r\n') // [["city", "n"], ["Portland, OR", "4"]]
 * @example parseCsv('q\n"say ""hi"""\n') // [["q"], ['say "hi"']]
 * @example parseCsv("\n\n") // []
 */
function parseCsv(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const rows = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    rows.push(parseCsvLine(line));
  }
  return rows;
}

/**
 * Pure function. One CSV line → its cells, honouring double-quoted fields.
 *
 * @param {string} line - a single line, no newline
 * @returns {string[]} trimmed cells
 *
 * @example parseCsvLine("1, 2 ,3") // ["1", "2", "3"]
 * @example parseCsvLine('"a,b",c') // ["a,b", "c"]
 * @example parseCsvLine("") // [""]
 */
function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      // A doubled quote inside a quoted field is one literal quote (RFC 4180).
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { cells.push(cell.trim()); cell = ""; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Pure function. Which column index does `name` refer to, in `header`?
 *
 * Accepts EITHER a header name (case-insensitively, so "Units" finds "units") OR
 * a 0-based numeric index, because a CSV exported without a header row has no
 * names to type. Returns -1 when it resolves to nothing — the caller turns that
 * into the loud error, listing the names that DO exist, which is the difference
 * between a fixable message and "no data".
 *
 * @param {string[]} header - the header row's cells
 * @param {string} name - a column name or a numeric index
 * @returns {number} the column index, or -1
 *
 * @example columnIndex(["region", "units"], "units") // 1
 * @example columnIndex(["region", "units"], "UNITS") // 1
 * @example columnIndex(["region", "units"], "1") // 1
 * @example columnIndex(["region", "units"], "profit") // -1
 */
function columnIndex(header, name) {
  const wanted = String(name ?? "").trim();
  if (wanted === "") return -1;
  const byName = header.findIndex((h) => h.toLowerCase() === wanted.toLowerCase());
  if (byName >= 0) return byName;
  if (/^\d+$/.test(wanted)) {
    const i = parseInt(wanted, 10);
    return i >= 0 && i < header.length ? i : -1;
  }
  return -1;
}

/**
 * Pure function. CSV text + two column choices → `{rows, error}`, where `rows` is
 * `[{label, value}]` and `error` is a message or null. EXACTLY ONE of them is
 * meaningful: a non-null error means the caller draws the error box instead of a
 * chart, so a partially-parsed file never becomes a partially-drawn chart.
 *
 * A ROW WHOSE VALUE IS NOT A NUMBER FAILS THE WHOLE CHART, naming the row. The
 * tempting alternative — skip it, or plot it as zero — is the exact silent
 * fallback that makes a chart lie: a column picked one to the left of the intended
 * one would render as a full row of zero-height bars, which looks like real data
 * that happens to be zero.
 *
 * @param {string} text - the CSV file's contents
 * @param {string} labelColumn - header name or index for the category labels
 * @param {string} valueColumn - header name or index for the numbers
 * @param {boolean} hasHeader - is row 0 a header row?
 * @returns {{rows: Array<{label: string, value: number}>, error: string|null}}
 *
 * @example csvSeries("region,units\nNorth,12\nSouth,8\n", "region", "units", true)
 * // {rows: [{label: "North", value: 12}, {label: "South", value: 8}], error: null}
 * @example csvSeries("region,units\nNorth,12\n", "region", "profit", true).error
 * // 'no column "profit" — this CSV has: region, units'
 * @example csvSeries("region,units\nNorth,lots\n", "region", "units", true).error
 * // 'row 2: "lots" in column "units" is not a number'
 * @example csvSeries("", "0", "1", false).error // "the CSV is empty"
 */
function csvSeries(text, labelColumn, valueColumn, hasHeader) {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], error: "the CSV is empty" };
  // With no header row, columns can only be named by index, so the synthetic
  // header is "0","1","2",… — which makes columnIndex's numeric branch the only
  // one that can match, without a second code path for the headerless case.
  const header = hasHeader ? table[0] : table[0].map((_cell, i) => String(i));
  const body = hasHeader ? table.slice(1) : table;
  if (body.length === 0) return { rows: [], error: "the CSV has a header row but no data rows" };
  if (body.length > MAX_ROWS)
    return { rows: [], error: `${body.length} data rows is more than this chart draws (${MAX_ROWS}) — filter the CSV first` };
  const li = columnIndex(header, labelColumn);
  const vi = columnIndex(header, valueColumn);
  const names = header.join(", ");
  if (li < 0) return { rows: [], error: `no column ${JSON.stringify(String(labelColumn ?? ""))} — this CSV has: ${names}` };
  if (vi < 0) return { rows: [], error: `no column ${JSON.stringify(String(valueColumn ?? ""))} — this CSV has: ${names}` };
  const rows = [];
  for (let r = 0; r < body.length; r++) {
    const cells = body[r];
    const raw = cells[vi] ?? "";
    // Number("") is 0, which would turn a blank cell into a real zero bar.
    const value = raw === "" ? NaN : Number(raw);
    if (!isFinite(value))
      return { rows: [], error: `row ${r + (hasHeader ? 2 : 1)}: ${JSON.stringify(raw)} in column ${JSON.stringify(header[vi])} is not a number` };
    rows.push({ label: cells[li] ?? "", value });
  }
  return { rows, error: null };
}

// ── 2. SCALING + LAYOUT. Still pure, still testable in isolation. ────────────

/**
 * Pure function. The value → local-Y mapping for a set of rows: `{min, max}` of
 * the axis. The axis ALWAYS includes zero, because a bar chart measures length
 * from a baseline and one that starts at 9.8 exaggerates a 10-vs-11 difference
 * into a doubling. A single-valued (or all-equal) series gets a 1-unit span so it
 * does not divide by zero and does not draw a bar of infinite height.
 *
 * @param {Array<{value: number}>} rows - the parsed series
 * @returns {{min: number, max: number}} the axis span, always containing 0
 *
 * @example axisSpan([{value: 4}, {value: 10}]) // {min: 0, max: 10}
 * @example axisSpan([{value: -3}, {value: 6}]) // {min: -3, max: 6}
 * @example axisSpan([{value: 5}, {value: 5}]) // {min: 0, max: 5}
 * @example axisSpan([{value: 0}]) // {min: 0, max: 1}
 */
function axisSpan(rows) {
  let min = 0;
  let max = 0;
  for (const row of rows) {
    if (row.value < min) min = row.value;
    if (row.value > max) max = row.value;
  }
  if (max - min === 0) return { min: 0, max: 1 };
  return { min, max };
}

/**
 * Pure function. One bar's local rectangle, given its slot.
 *
 * The bar hangs from the ZERO LINE, so a negative value draws downward from it
 * rather than as a positive bar somewhere else — the thing a chart of profit and
 * loss has to get right. Height is always non-negative (the IR has no notion of a
 * negative-height rect); the sign lives in which side of the zero line the rect
 * starts on.
 *
 * @param {number} value - the row's value
 * @param {number} slotX - left edge of this row's slot (local)
 * @param {number} slotW - slot width
 * @param {number} barFraction - bar width as a fraction of the slot (0..1)
 * @param {number} plotTop - local Y of the axis maximum
 * @param {number} plotH - plot height in local units
 * @param {{min: number, max: number}} span - the axis span
 * @returns {{x: number, y: number, w: number, h: number, zeroY: number}}
 *
 * @example barRect(10, 0, 100, 0.6, 0, 200, {min: 0, max: 10})
 * // {x: 20, y: 0, w: 60, h: 200, zeroY: 200}
 * @example barRect(5, 0, 100, 0.6, 0, 200, {min: 0, max: 10}).h // 100
 * @example barRect(-5, 0, 100, 0.6, 0, 200, {min: -5, max: 5}).y // 100
 */
function barRect(value, slotX, slotW, barFraction, plotTop, plotH, span) {
  const w = slotW * barFraction;
  const x = slotX + (slotW - w) / 2;
  const unit = plotH / (span.max - span.min); // local units per data unit
  const zeroY = plotTop + (span.max - 0) * unit;
  const valueY = plotTop + (span.max - value) * unit;
  return { x, y: Math.min(zeroY, valueY), w, h: Math.abs(zeroY - valueY), zeroY };
}

/**
 * Pure function. The colour of bar `i` of `n`, under the chosen mode.
 *
 *   "solid"    — every bar `barColor`.
 *   "alternate"— `barColor` / `altColor` by parity: the cheapest way to make
 *                adjacent categories legible without a legend.
 *   "by-sign"  — `barColor` above zero, `altColor` below. A signed chart wants
 *                this; anything else makes a loss look like a gain.
 *
 * @param {string} mode - one of COLOR_MODES
 * @param {number} index - bar index
 * @param {number} value - the bar's value (only "by-sign" reads it)
 * @param {string} barColor - the primary colour
 * @param {string} altColor - the secondary colour
 * @returns {string} a css colour string
 *
 * @example barColorFor("solid", 3, -2, "#58c4dd", "#fc6255") // "#58c4dd"
 * @example barColorFor("alternate", 1, 5, "#58c4dd", "#fc6255") // "#fc6255"
 * @example barColorFor("by-sign", 0, -2, "#58c4dd", "#fc6255") // "#fc6255"
 */
function barColorFor(mode, index, value, barColor, altColor) {
  if (mode === "alternate") return index % 2 === 0 ? barColor : altColor;
  if (mode === "by-sign") return value < 0 ? altColor : barColor;
  return barColor;
}

/**
 * Pure function. Approximate local X to start `label` at so it CENTERS on `cx`,
 * with no font metrics available. Overestimating the width would push a label off
 * its bar, so the ratio is the conservative one plugins/graph_tick_marks.js uses.
 *
 * @param {string} label - the text
 * @param {number} cx - the local X to center on
 * @param {number} size - type size
 * @returns {number} the text op's x
 *
 * @example centeredTextX("ab", 50, 10) // 44.5
 * @example centeredTextX("", 50, 10) // 50
 */
function centeredTextX(label, cx, size) {
  return cx - (String(label).length * size * GLYPH_ADVANCE_RATIO) / 2;
}

/**
 * Pure function. Format a value for the label above its bar: an integer stays
 * bare, anything else keeps `decimals` places. Trailing-zero noise ("12.00" over
 * a bar of exactly 12) is what this avoids.
 *
 * @param {number} value - the number
 * @param {number} decimals - places for a non-integer
 * @returns {string}
 *
 * @example formatValue(12, 1) // "12"
 * @example formatValue(12.345, 1) // "12.3"
 * @example formatValue(-0.5, 2) // "-0.50"
 */
function formatValue(value, decimals) {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.max(0, Math.min(Math.round(Number(decimals) || 0), 6)));
}

/**
 * Pure function. The LOUD error box: a red-bordered panel with the message
 * wrapped across lines. Drawn instead of the chart whenever anything is wrong, so
 * a broken chart is unmistakably broken (the built-ins' errorAffordance, restated
 * — a plugin asset cannot import core/graph_equation.js).
 *
 * @param {number} w - widget width (local)
 * @param {number} h - widget height
 * @param {string} message - what went wrong
 * @returns {Array<object>} display-list commands
 *
 * @example errorBox(200, 100, "no column \"profit\"").length >= 2 // true
 * @example errorBox(200, 100, "boom")[0].op // "rect"
 */
function errorBox(w, h, message) {
  const size = DEFAULT_LABEL_SIZE;
  const perLine = Math.max(8, Math.floor((w - ERROR_PAD * 2) / (size * GLYPH_ADVANCE_RATIO)));
  const words = String(message).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line === "") { line = word; continue; }
    if ((line + " " + word).length <= perLine) { line += " " + word; continue; }
    lines.push(line);
    line = word;
  }
  if (line !== "") lines.push(line);
  const ops = [rect({ x: 0, y: 0, w, h, fill: ERROR_FILL, stroke: ERROR_STROKE, strokeWidth: 2 })];
  for (let i = 0; i < lines.length; i++) {
    const y = ERROR_PAD + i * (size + 2);
    if (y + size > h) break; // never draw outside the box
    ops.push(text({ text: lines[i], x: ERROR_PAD, y, size, color: ERROR_TEXT }));
  }
  return ops;
}

// ── 3. THE KNOBS. Each becomes an Inspector row, keyframable and `=`-bindable.

const COLOR_MODES = ["solid", "alternate", "by-sign"];

const CUSTOM = customProps([
  {
    // The DATA FILE. kind "asset" gives this row the standard AssetField — a
    // picker over the project's assets, an upload button, and drag-and-drop from
    // the Asset Explorer or Finder. assetKinds ["data"] filters that picker to
    // CSV/TSV/JSON (server.py DATA_EXTS), so it offers spreadsheets and nothing
    // else. assetForm "url" writes the served path ("/asset/<Project>/x.csv"),
    // which is exactly what assetText() takes.
    name: "csvUrl",
    kind: "asset",
    assetKinds: ["data"],
    assetForm: "url",
    default: "",
    label: "CSV file",
    help: "The CSV this chart plots — pick one from the project's assets, upload one, or drag one in. Every machine that opens the deck reads the same file, so the chart is the same everywhere.",
  },
  {
    name: "hasHeader",
    kind: "boolean",
    default: true,
    label: "First row is a header",
    help: "On: row 1 names the columns, and you can type those names below. Off: every row is data, and columns are named by number (0 is the first).",
  },
  {
    name: "labelColumn",
    kind: "text",
    default: "0",
    label: "Label column",
    help: "Which column holds each bar's category name — a header name (case-insensitive) or a 0-based column number.",
  },
  {
    name: "valueColumn",
    kind: "text",
    default: "1",
    label: "Value column",
    help: "Which column holds the numbers — a header name or a 0-based column number. A non-numeric cell in it is an error, not a zero bar.",
  },
  {
    name: "barColor",
    kind: "color",
    default: "#58c4dd",
    label: "Bar colour",
    help: "The main bar colour. Under 'By sign' this is the colour of positive bars.",
  },
  {
    name: "altColor",
    kind: "color",
    default: "#fc6255",
    label: "Alternate colour",
    help: "The second colour: every other bar under 'Alternate', or negative bars under 'By sign'. Ignored when the colour mode is Solid.",
  },
  {
    name: "colorMode",
    kind: "select",
    default: "solid",
    options: COLOR_MODES,
    optionLabels: { solid: "Solid", alternate: "Alternate", "by-sign": "By sign (±)" },
    label: "Colour mode",
    help: "How the two colours are used across the bars.",
  },
  {
    name: "barFraction",
    kind: "number",
    default: DEFAULT_BAR_FRACTION,
    min: 0.05,
    max: 1,
    step: 0.05,
    label: "Bar width",
    help: "How much of each bar's slot the bar fills; the rest is the gap. 1 leaves no gap at all.",
  },
  {
    name: "reveal",
    kind: "number",
    default: 1,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Reveal",
    help: "How far the bars have grown up from the baseline, 0 to 1. Keyframe it 0 on one slide and 1 on the next for a Manim-style grow-in — it is property state, so it animates AND exports.",
  },
  {
    name: "showValues",
    kind: "boolean",
    default: true,
    label: "Show values",
    help: "Print each bar's number just above it.",
  },
  {
    name: "showLabels",
    kind: "boolean",
    default: true,
    label: "Show labels",
    help: "Print each bar's category name under the baseline.",
  },
  {
    name: "valueDecimals",
    kind: "number",
    default: 1,
    min: 0,
    max: 6,
    step: 1,
    label: "Decimals",
    help: "Decimal places for a non-integer value label. Whole numbers are always printed bare.",
  },
  {
    name: "labelSize",
    kind: "number",
    default: DEFAULT_LABEL_SIZE,
    min: 4,
    label: "Label size",
    help: "Type size for the value and category labels, in canvas units.",
  },
  {
    name: "axisColor",
    kind: "color",
    default: "#8a90a6",
    label: "Axis colour",
    help: "Colour of the zero baseline and of both label rows.",
  },
]);

// ── 4. THE PLUGIN. ───────────────────────────────────────────────────────────

return {
  type: "csv_bar_graph",
  title: "CSV Bar Graph",
  capabilities: {
    bbox: true,
    transform: true,
    resizable: true,
    backdrop: false,
  },
  defaults: {
    type: "csv_bar_graph",
    x: 200, y: 200, w: 720, h: 420, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    ...defaults("opacity"),
    ...bundleNestedDefaults("effects"),
    ...CUSTOM.defaults,
  },
  inspector: [
    ...bundle("transform"),
    ...CUSTOM.rows,
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function of (state, loaded asset text). State → display-list commands in
   * LOCAL coordinates. The asset read is a cache lookup, not I/O (the load is
   * kicked upstream and awaited by the render gate), so this stays same-input →
   * same-output and is safe to call every frame.
   *
   * @param {object} s - evaluated widget state (equations already resolved)
   * @param {*} _subtree - unused (no group/crop role)
   * @param {object} world - this widget's world transform (applyEffects needs it)
   * @returns {Array<object>} display-list commands
   *
   * @example // with no CSV chosen yet, the widget is a GHOST:
   * //   emit({...defaults, w: 400, h: 300}) // []
   */
  emit(s, _subtree, world) {
    const w = s.w ?? 0;
    const h = s.h ?? 0;
    const box = { x: 0, y: 0, w, h };
    if (w <= 0 || h <= 0) return [];
    // GHOST: no file chosen yet. Drawing nothing (rather than an error) is right
    // here — a freshly inserted widget is not broken, it is unconfigured, and the
    // editor grants it its own placeholder affordance.
    if (!s.csvUrl) return [];

    const asset = assetText(s.csvUrl);
    if (asset.status === "error")
      return applyEffects(errorBox(w, h, `could not read ${s.csvUrl}: ${asset.error}`), s, world, box);
    // IN FLIGHT: nothing this frame. A repaint follows the load, and a headless
    // render will not write the frame until it lands.
    if (asset.status !== "ready") return [];

    const { rows, error } = csvSeries(asset.text, s.labelColumn, s.valueColumn, s.hasHeader !== false);
    if (error) return applyEffects(errorBox(w, h, error), s, world, box);

    const labelSize = Math.max(4, Number(s.labelSize) || DEFAULT_LABEL_SIZE);
    const showValues = s.showValues !== false;
    const showLabels = s.showLabels !== false;
    // The plot area is the box minus the two label bands it actually uses, so
    // turning a band off gives the bars that space rather than leaving a gutter.
    const plotTop = showValues ? labelSize + VALUE_GAP : 0;
    const plotBottom = h - (showLabels ? labelSize + LABEL_GAP : 0);
    const plotH = plotBottom - plotTop;
    if (plotH <= 0)
      return applyEffects(errorBox(w, h, `the widget is too short (${Math.round(h)}) for ${Math.round(labelSize)}-unit labels — make it taller or turn the labels off`), s, world, box);

    const span = axisSpan(rows);
    const slotW = w / rows.length;
    const reveal = Math.max(0, Math.min(Number(s.reveal ?? 1), 1));
    const barFraction = Math.max(0.05, Math.min(Number(s.barFraction) || DEFAULT_BAR_FRACTION, 1));
    const axisColor = s.axisColor ?? "#8a90a6";
    const ops = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const bar = barRect(row.value, i * slotW, slotW, barFraction, plotTop, plotH, span);
      // REVEAL grows the bar out of the zero line, so a negative bar grows
      // downward and a positive one upward — both from the same edge.
      const grown = bar.h * reveal;
      const top = row.value < 0 ? bar.zeroY : bar.zeroY - grown;
      ops.push(rect({
        x: bar.x, y: top, w: bar.w, h: grown,
        fill: barColorFor(s.colorMode ?? "solid", i, row.value, s.barColor, s.altColor),
        opacity: s.opacity ?? 1,
      }));
      const cx = bar.x + bar.w / 2;
      if (showValues) {
        const label = formatValue(row.value, s.valueDecimals ?? 1);
        // The value rides the bar's growing end, so it travels with the reveal.
        const y = row.value < 0 ? bar.zeroY + grown + VALUE_GAP : top - labelSize - VALUE_GAP;
        ops.push(text({
          text: label, x: centeredTextX(label, cx, labelSize),
          y: Math.max(0, Math.min(y, h - labelSize)),
          size: labelSize, color: axisColor, opacity: s.opacity ?? 1,
        }));
      }
      if (showLabels)
        ops.push(text({
          text: row.label, x: centeredTextX(row.label, cx, labelSize),
          y: plotBottom + LABEL_GAP, size: labelSize, color: axisColor, opacity: s.opacity ?? 1,
        }));
    }
    // THE ZERO BASELINE, drawn last so it reads on top of the bars. A chart with
    // negative values needs it to be legible at all; one without still benefits
    // from an explicit floor.
    const zeroBar = barRect(0, 0, slotW, barFraction, plotTop, plotH, span);
    ops.push(rect({ x: 0, y: zeroBar.zeroY, w, h: 1, fill: axisColor, opacity: s.opacity ?? 1 }));
    return applyEffects(ops, s, world, box);
  },
  /** The LOCAL rect this widget's ink occupies — the whole box (the chart fills
   *  it, and the labels live inside it by construction). */
  localBounds: (s) => ({ x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 }),
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
};
