<!--
  CsvTable — THE tabular preview for a DATA asset (.csv/.tsv), rendered inside the
  Asset Explorer's EXISTING preview Modal alongside <img>/<video>/<audio>. It is a
  fourth branch of that one surface, deliberately not a second dialog: a user
  ruling asked to "view CSVs just like we can view other assets", and "just like"
  means the same double-click, the same dialog, the same title bar.

  WHAT IT IS: a fixed-row-height VIRTUAL SCROLLER. The header row is pinned
  (position: sticky), the body mounts only the rows the viewport can show plus a
  small overscan, and two spacer rows stand in for the rest of the file's height.
  So a 100,000-row CSV mounts ~30 <tr> elements, not 100,000 — the difference
  between a preview and a frozen tab. The scroll arithmetic is core/csv.js's
  csvWindow (pure, doctested, node-tested): an off-by-one there duplicates a row
  five thousand rows down where no manual check would ever look.

  WHY NO GRID DEPENDENCY (Tabulator / Grid.js / AG Grid). Those are EDITORS —
  sorting, filtering, column resize, pagination, cell editing, their own theme
  layer. This is a PREVIEW: the question it answers is "what is in this file",
  and every one of those features is a way to show something that is not what is
  in the file. Concretely against them: (1) Tabulator is ~400 KB of JS+CSS and
  Grid.js ~120 KB, added to a bundle that already carries monaco + canvaskit +
  pdfjs + mermaid + mathjax, and this app ships as a static Pages build; (2) both
  bring their own CSS with their own colors, so they would be the one surface in
  the app that does not follow the --a-* theme tokens and would need to be
  re-skinned per theme (there are a dozen themes, several light); (3) the virtual
  scroll they provide is the twenty lines in core/csv.js that are already tested.
  The house rule is minimal deps, token-styled, self-contained, and here that is
  not asceticism — it is the smaller amount of code.

  CELL OVERFLOW is ELLIPSIZED at a hard per-column max width (.csv-cell in
  app.css), because one 4 KB cell in a log export would otherwise stretch the
  table to a width where every other column is off-screen. A truncated cell is
  read by SELECTING it — the table is real selectable text, so a copy gets the
  full cell — and NOT by a per-cell tooltip: a tooltip on every cell of a
  screenful is hundreds of hover targets, and this repo's hover invariant says
  hovering must be free.

  NUMERIC COLUMNS are right-aligned with tabular-nums (core/csv.js
  columnAlignments votes on the body rows only, never the header), so a column of
  numbers reads as a column of numbers and the digits line up vertically.

  Chrome per house rules: NO <style> block (all classes in app.css via --a-csv-*
  tokens), square corners, iconify glyphs only.

  Props:
    text      the file's full contents (the caller fetched it; this component
              does no I/O, so it is equally usable from an HTTP asset and an
              IndexedDB blob — the storage seam is the caller's problem)
    filename  used ONLY to pick the delimiter (csvDelimiterForName)
-->
<script module>
  /**
   * Pure function. A cell's DISPLAY text: a quoted newline inside a cell is shown
   * as a visible pilcrow-ish "⏎ " rather than being allowed to break the row's
   * fixed height, which the virtual scroller's arithmetic depends on absolutely.
   *
   * The alternative — letting the cell wrap — silently invalidates csvWindow's
   * every-row-is-rowH premise, so one multi-line cell would misalign the spacers
   * and the scrollbar for the whole file. Showing the break is honest AND keeps
   * the geometry true.
   *
   * @param {string} cell - one parsed cell
   * @returns {string}
   *
   * @example cellText("North") // "North"
   * @example cellText("two\nlines") // "two ⏎ lines"
   * @example cellText(undefined) // ""  (a ragged row's missing cell)
   */
  export function cellText(cell) {
    return cell === undefined ? "" : String(cell).replace(/\n/g, " ⏎ ");
  }
</script>

<script>
  import { columnAlignments, csvDelimiterForName, csvHeaders, csvSummary, csvWindow, parseDelimited } from "../core/csv.js";

  let {
    /** @type {string} The file's full contents. */
    text = "",
    /** @type {string} Asset basename — picks the delimiter only. */
    filename = "",
  } = $props();

  // ROW HEIGHT is measured, not assumed: it comes from the same --a-csv-row-h
  // token app.css sizes the rows with, read off the mounted body. A hardcoded
  // number here and a different one in the CSS is the classic virtual-scroll
  // desync (rows drift out of their spacers as you scroll), and a token read at
  // runtime cannot disagree with itself. Falls back to the token's own default
  // until the first measure lands.
  const ROW_H_FALLBACK = 22;

  let scroller = $state(null); // the scrolling body element
  let scrollTop = $state(0);
  let viewportH = $state(0);
  let rowH = $state(ROW_H_FALLBACK);

  // THE PARSE happens ONCE per (text, filename) — $derived, so scrolling a 100k
  // row file never re-parses it. This is the single most important reactivity
  // decision in the component: parseDelimited is O(bytes), and putting it on the
  // scroll path would make every wheel tick a full re-parse of the file.
  let rows = $derived(parseDelimited(text, csvDelimiterForName(filename)));
  // The first row is treated as a header whenever there are at least two rows: a
  // spreadsheet exported by anything has one, and a headerless file's first row
  // shown as a header is a cosmetic misread the numbered fallback makes obvious.
  let hasHeader = $derived(rows.length > 1);
  let headers = $derived(csvHeaders(rows, hasHeader));
  let alignments = $derived(columnAlignments(rows, hasHeader));
  let body = $derived(hasHeader ? rows.slice(1) : rows);
  let summary = $derived(csvSummary(rows, hasHeader));

  let window_ = $derived(csvWindow(body.length, scrollTop, viewportH, rowH));
  // The mounted slice, carrying each row's ABSOLUTE index so the row-number
  // gutter shows the row's place in the FILE and not in the window.
  let mounted = $derived(
    body.slice(window_.start, window_.end).map((cells, i) => ({ index: window_.start + i, cells })),
  );

  /** Command. Tracks the scroll offset + viewport height that decide the window.
   *  Reads layout synchronously in the scroll handler — the values are already
   *  computed by the time a scroll event fires, so this is a read of a resolved
   *  layout, not a forced reflow. */
  function onScroll() {
    if (!scroller) return;
    scrollTop = scroller.scrollTop;
    viewportH = scroller.clientHeight;
  }

  /** Command. Measures the viewport and ONE real row (see ROW_H_FALLBACK). Runs on
   *  mount and whenever the parse changes — a different file may have a different
   *  number of columns and therefore a different measured row height if a theme
   *  wraps, and an unmeasured rowH is the one input csvWindow cannot guess. */
  $effect(() => {
    void rows; // re-measure when the file changes
    if (!scroller) return;
    viewportH = scroller.clientHeight;
    const firstRow = scroller.querySelector(".csv-row");
    const measured = firstRow?.getBoundingClientRect().height ?? 0;
    if (measured > 0) rowH = measured;
    scrollTop = scroller.scrollTop;
  });
</script>

<div class="csv-view">
  <!-- SUMMARY LINE: body rows × columns, and the delimiter actually used. The
       delimiter is stated because a .tsv parsed as a CSV (or the reverse) shows
       ONE enormous column, and a reader who can see which delimiter was chosen
       can tell that apart from "the file really is one column". -->
  <div class="csv-summary">
    <iconify-icon icon="mdi:table-large" width="14" height="14"></iconify-icon>
    <span>{summary}</span>
    <span class="csv-summary-dim">{csvDelimiterForName(filename) === "\t" ? "tab-separated" : "comma-separated"}</span>
  </div>

  {#if rows.length === 0}
    <!-- An EMPTY data file is reported, not shown as a blank table: a zero-row
         table and a failed read look identical, and only one of them is fine. -->
    <div class="csv-empty">This file is empty — no rows to show.</div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="csv-scroll" bind:this={scroller} onscroll={onScroll}>
      <table class="csv-table">
        <thead>
          <tr>
            <!-- The row-number gutter's own header is the "#" glyph column. -->
            <th class="csv-gutter csv-head">#</th>
            {#each headers as h, c (c)}
              <th class="csv-head" class:csv-right={alignments[c] === "right"}>{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          <!-- THE TOP SPACER stands in for every row above the window. A single
               <tr> of the right height, not the rows themselves. -->
          {#if window_.padTop > 0}
            <tr class="csv-spacer" style={`--a-csv-spacer-h:${window_.padTop}px`}><td colspan={headers.length + 1}></td></tr>
          {/if}
          {#each mounted as row (row.index)}
            <tr class="csv-row">
              <td class="csv-gutter">{(row.index + 1).toLocaleString("en-US")}</td>
              {#each headers as _h, c (c)}
                <td class="csv-cell" class:csv-right={alignments[c] === "right"}>{cellText(row.cells[c])}</td>
              {/each}
            </tr>
          {/each}
          {#if window_.padBottom > 0}
            <tr class="csv-spacer" style={`--a-csv-spacer-h:${window_.padBottom}px`}><td colspan={headers.length + 1}></td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>
