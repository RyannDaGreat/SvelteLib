/**
 * core/csv.js — THE delimited-text parser, and the pure half of the CSV asset
 * VIEWER (web/CsvTable.svelte). DOM-free, bare-node testable.
 *
 * ── WHY A HAND-ROLLED PARSER AND NOT A DEPENDENCY ────────────────────────────
 * The candidates were Papa Parse (~45 KB min) and d3-dsv (~4 KB). Both are good;
 * neither earns its place here. The whole job is a 40-line character-level state
 * machine, this file is IT (with doctests, in the house style), and the app
 * already carries a heavy dependency budget (monaco, canvaskit, pdfjs, mermaid,
 * mathjax) that every added package makes worse for a static Pages build. The
 * decisive argument is a house one: the CSV BAR-GRAPH PLUGIN ASSET
 * (plugin_assets/csv_bar_graph.plugin.js) needs a parser too and CANNOT import
 * one — a plugin asset runs inside core/plugin_assets.js's jail, with no module
 * loader. A dependency would therefore be a parser the plugin cannot share, i.e.
 * TWO parsers whose disagreements are invisible: the viewer would show a table
 * the chart does not plot. A small pure function can be copied into the jail's
 * source (or read as the reference implementation it is) and stay one algorithm.
 *
 * ── WHY IT IS A FULL RFC 4180 STATE MACHINE (the plugin's is not) ─────────────
 * The plugin's local parseCsv splits on "\n" first and so cannot represent a
 * newline INSIDE a quoted field; it says so, and for a chart LABEL that is a fair
 * trade. A VIEWER cannot make that trade. Its whole purpose is to answer "what is
 * actually in this file", and a line-splitting parser answers that question
 * WRONGLY — silently, with every row after the offending one shifted — which is
 * the exact failure mode the house rules forbid. So this walks characters, and a
 * quoted newline is one cell containing a newline.
 *
 * ── THE VIEWER'S OTHER HALF IS ALSO HERE ─────────────────────────────────────
 * csvWindow (which rows a virtual scroller must mount) and columnAlignments (is a
 * column numeric, hence right-aligned and tabular-nums) are pure functions of the
 * parse, so they live here with doctests rather than inside a .svelte component
 * where nothing can execute them.
 */

/** The delimiter guessed for a filename's extension. TSV is tab-delimited; a
 *  .csv (and anything else offered to the viewer) is comma-delimited. */
const EXT_DELIMITERS = { tsv: "\t", tab: "\t", csv: ",", txt: "," };

/**
 * Pure function. The delimiter to parse `filename` with, from its extension.
 *
 * Extension-driven rather than sniffed: the asset library knows the filename, a
 * wrong guess from content sniffing is silent, and TSV-vs-CSV is the only split
 * that matters in practice (server.py DATA_EXTS is .csv/.tsv/.json).
 *
 * @param {string} filename - an asset basename
 * @returns {string} "," or "\t"
 *
 * @example csvDelimiterForName("sales.csv")     // ","
 * @example csvDelimiterForName("readings.TSV")  // "\t"  (case-insensitive)
 * @example csvDelimiterForName("noextension")   // ","   (comma is the default)
 */
export function csvDelimiterForName(filename) {
  const ext = String(filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return EXT_DELIMITERS[ext] ?? ",";
}

/**
 * Pure function. Parse delimited text into rows of cells — a full RFC 4180 walk:
 * quoted fields may contain the delimiter, a doubled quote inside a quoted field
 * is one literal quote, and a NEWLINE INSIDE A QUOTED FIELD stays in the cell.
 *
 * CRLF and lone CR are normalized to "\n" (a Windows- or classic-Mac-exported
 * spreadsheet is the common case). A single trailing newline is dropped — text
 * files end with one and that is not an empty row — but a BLANK LINE IN THE
 * MIDDLE is preserved as a one-empty-cell row, because a viewer's job is to show
 * the file, not a tidied version of it.
 *
 * Cells are NOT trimmed, unlike the chart plugin's parser: leading whitespace is
 * data to a reader inspecting a file, and hiding it would hide the reason a chart
 * refused to parse a column.
 *
 * @param {string} text - the file's contents
 * @param {string} [delimiter=","] - single-character field separator
 * @returns {Array<string[]>} rows of cells
 *
 * @example parseDelimited("a,b\n1,2\n") // [["a", "b"], ["1", "2"]]
 * @example parseDelimited('city,n\r\n"Portland, OR",4\r\n') // [["city", "n"], ["Portland, OR", "4"]]
 * @example parseDelimited('q\n"say ""hi"""\n') // [["q"], ['say "hi"']]
 * @example parseDelimited('note\n"two\nlines"\n') // [["note"], ["two\nlines"]]
 * @example parseDelimited("a\tb\n1\t2", "\t") // [["a", "b"], ["1", "2"]]
 * @example parseDelimited("") // []
 * @example parseDelimited("a,b\n\nc,d") // [["a", "b"], [""], ["c", "d"]]
 */
export function parseDelimited(text, delimiter = ",") {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  if (src === "") return [];
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; continue; }
      if (ch === '"') { quoted = false; continue; }
      cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  // The final cell/row: emitted unless the file simply ended with its newline
  // (in which case row is empty and cell is "" — nothing was started).
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Pure function. Is `cell` a number a reader would want right-aligned?
 *
 * Deliberately strict-ish but currency/percent/thousands-aware, because a real
 * spreadsheet column is full of "1,234", "$12.50", "-3.2%" and those are numeric
 * to a human even though Number() rejects them. An EMPTY cell is not numeric on
 * its own (it decides nothing) — see numericColumn, which ignores blanks.
 *
 * @param {string} cell - one cell's text
 * @returns {boolean}
 *
 * @example isNumericCell("42")      // true
 * @example isNumericCell("-3.2e4")  // true
 * @example isNumericCell("1,234")   // true
 * @example isNumericCell("$12.50")  // true
 * @example isNumericCell("-3.2%")   // true
 * @example isNumericCell("North")   // false
 * @example isNumericCell("")        // false
 * @example isNumericCell("12 units") // false
 */
export function isNumericCell(cell) {
  const s = String(cell ?? "").trim().replace(/^[$€£¥]/, "").replace(/%$/, "").replace(/,/g, "");
  return s !== "" && Number.isFinite(Number(s));
}

/**
 * Pure function. Per-column alignment for a parsed table: "right" when the
 * column's non-blank body cells are ALL numeric, else "left".
 *
 * The HEADER row is excluded from the vote (a column called "2024" is a label,
 * not a number) and blank cells abstain (a sparse numeric column is still
 * numeric). A column with no non-blank body cells is "left" — nothing proved it
 * numeric, and left is the safe default for unknown text.
 *
 * `sample` bounds the vote so a 100k-row file does not pay a full scan to decide
 * a cosmetic property; the first rows of a spreadsheet are representative, and
 * being wrong costs an alignment, not a value.
 *
 * @param {Array<string[]>} rows - parsed rows INCLUDING the header row
 * @param {boolean} hasHeader - whether rows[0] is a header
 * @param {number} [sample=200] - how many body rows to inspect
 * @returns {Array<"left"|"right">} one alignment per column of the widest row seen
 *
 * @example columnAlignments([["region", "units"], ["North", "12"], ["South", "8"]], true)
 * // ["left", "right"]
 * @example columnAlignments([["2024", "2025"], ["1", "2"]], true) // ["right", "right"]
 * @example columnAlignments([["a", "1"], ["b", ""]], false) // ["left", "left"]
 * @example columnAlignments([], true) // []
 */
export function columnAlignments(rows, hasHeader, sample = 200) {
  const body = (rows ?? []).slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + sample);
  const width = Math.max(0, ...(rows ?? []).map((r) => r.length));
  const alignments = [];
  for (let c = 0; c < width; c += 1) {
    let sawValue = false;
    let allNumeric = true;
    for (const r of body) {
      const cell = r[c];
      if (cell === undefined || String(cell).trim() === "") continue;
      sawValue = true;
      if (!isNumericCell(cell)) { allNumeric = false; break; }
    }
    alignments.push(sawValue && allNumeric ? "right" : "left");
  }
  return alignments;
}

/**
 * Pure function. Which rows a fixed-row-height virtual scroller must MOUNT for a
 * given scroll offset, plus the spacer heights above and below them.
 *
 * This is the whole reason a 100k-row CSV does not freeze the tab: the component
 * renders `end - start` rows (a screenful plus `overscan`) and two empty spacer
 * divs that stand in for the rest, so DOM node count is bounded by the VIEWPORT,
 * not by the file. Pure and doctested here because a scroll-math off-by-one is
 * invisible in a screenshot and obvious in an assertion.
 *
 * Clamped so an over-scrolled container (elastic scrolling, a shrinking
 * viewport) can never produce a negative index or a start past the end.
 *
 * @param {number} total - total body rows
 * @param {number} scrollTop - pixels scrolled
 * @param {number} viewportH - visible height in pixels
 * @param {number} rowH - one row's height in pixels
 * @param {number} [overscan=8] - extra rows rendered beyond each edge
 * @returns {{start: number, end: number, padTop: number, padBottom: number}}
 *
 * @example csvWindow(100000, 0, 400, 20, 0) // {start: 0, end: 20, padTop: 0, padBottom: 1999600}
 * @example csvWindow(100000, 10000, 400, 20, 0) // {start: 500, end: 520, padTop: 10000, padBottom: 1989600}
 * @example csvWindow(5, 0, 400, 20, 0) // {start: 0, end: 5, padTop: 0, padBottom: 0}
 * @example csvWindow(0, 0, 400, 20) // {start: 0, end: 0, padTop: 0, padBottom: 0}
 * @example csvWindow(100, 1e9, 400, 20, 0) // {start: 80, end: 100, padTop: 1600, padBottom: 0}
 */
export function csvWindow(total, scrollTop, viewportH, rowH, overscan = 8) {
  if (!(total > 0) || !(rowH > 0)) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const visible = Math.ceil(Math.max(0, viewportH) / rowH);
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const start = Math.max(0, Math.min(total - Math.min(total, visible), first) - overscan);
  const end = Math.min(total, start + visible + overscan * 2);
  return { start, end, padTop: start * rowH, padBottom: (total - end) * rowH };
}

/**
 * Pure function. The viewer's summary caption: row and column counts, in the
 * reader's terms (BODY rows, so a 1000-data-row file with a header says 1,000 and
 * not 1,001 — off-by-one in a caption is how a reader concludes the parse is
 * broken). Thousands-separated because the counts are routinely six digits.
 *
 * @param {Array<string[]>} rows - parsed rows including any header
 * @param {boolean} hasHeader - whether rows[0] is a header
 * @returns {string}
 *
 * @example csvSummary([["a", "b"], ["1", "2"], ["3", "4"]], true) // "2 rows × 2 columns"
 * @example csvSummary([["a", "b"], ["1", "2"]], false) // "2 rows × 2 columns"
 * @example csvSummary([["a"], ["1"]], true) // "1 row × 1 column"
 * @example csvSummary([], true) // "empty"
 */
export function csvSummary(rows, hasHeader) {
  const all = rows ?? [];
  if (all.length === 0) return "empty";
  const bodyCount = hasHeader ? all.length - 1 : all.length;
  const cols = Math.max(0, ...all.map((r) => r.length));
  const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(bodyCount, "row")} × ${plural(cols, "column")}`;
}

/**
 * Pure function. Column headers to DISPLAY for a parsed table.
 *
 * With a header row: its cells, with a blank one shown as its 1-based column
 * number rather than an empty pinned cell the reader cannot refer to. Without
 * one: the column numbers themselves, which is what the chart plugin's
 * numeric-index column selector accepts (csv_bar_graph's columnIndex), so the
 * viewer's labels are the strings the author types into the widget.
 *
 * @param {Array<string[]>} rows - parsed rows
 * @param {boolean} hasHeader - whether rows[0] is a header
 * @returns {string[]}
 *
 * @example csvHeaders([["region", "units"], ["North", "12"]], true) // ["region", "units"]
 * @example csvHeaders([["North", "12"]], false) // ["1", "2"]
 * @example csvHeaders([["region", ""], ["North", "12"]], true) // ["region", "2"]
 * @example csvHeaders([], true) // []
 */
export function csvHeaders(rows, hasHeader) {
  const all = rows ?? [];
  if (all.length === 0) return [];
  const width = Math.max(0, ...all.map((r) => r.length));
  const header = hasHeader ? all[0] : null;
  return Array.from({ length: width }, (_, c) => {
    const label = header?.[c];
    return label !== undefined && String(label).trim() !== "" ? String(label) : String(c + 1);
  });
}
