/**
 * BENTO BOX — a grid LAYOUT SCAFFOLD widget whose PRIMARY product is ANCHORS.
 *
 * A "bento grid" (rows x cols of cells, separated by gutters, inset by a
 * padding, optionally with merged/spanning cells for the varied bento look) that
 * a user drops as a layout scaffold. It renders only FAINT guide lines so the
 * grid is visible while placing widgets against it — but the VALUE is the rich,
 * named ANCHOR set it exposes: other widgets snap to those anchors and reference
 * them in `=` equations (`= <bento>_c1x2cm.x`) to lay themselves out on the grid.
 *
 * ── ANCHOR NAMING (the core deliverable) ──────────────────────────────────────
 * The equation reference grammar (core/expressions.resolveRef) resolves an
 * anchor ref as `<itemSlug>_<anchorId>.x|y`, splitting the head on its LAST "_"
 * and requiring the left part to be an item slug. Therefore an anchorId MUST
 * contain NO underscore (an "_" in the id would be mis-split and become
 * unreferenceable). So this scheme uses `x` as the numeric separator instead:
 *
 *   - Widget bbox:      the 9 standard anchors  tl tm tr ml cm mr bl bm br.
 *   - Each cell (r,c):  `c{r}x{c}` + a standard bbox suffix  (0-based r,c) —
 *                       CENTER `c{r}x{c}cm`, CORNERS `…tl/…tr/…bl/…br`,
 *                       EDGE-MIDS `…tm/…mr/…bm/…ml`. e.g. cell row 1 col 2
 *                       center = `c1x2cm`. Merged spans expose the same 9 on
 *                       the merged rect, keyed at the span's origin (r,c).
 *   - Grid-line INTERSECTIONS: the (rows+1) x (cols+1) lattice of line centers,
 *                       `j{i}x{k}`  (i = row line 0..rows, k = col line 0..cols).
 *
 * Every id round-trips through the ref grammar as `<bentoSlug>_<id>.x|y` for both
 * a named slug ("grid" -> `grid_c1x2cm.x`) and a default slug (`bento_ab12` ->
 * `bento_ab12_c1x2cm.x`): the LAST-"_" split peels off the underscore-free id and
 * leaves the (possibly underscore-bearing) slug intact.
 *
 * ── PARAMETRIC ────────────────────────────────────────────────────────────────
 * `rows`/`cols`/`rowGap`/`colGap`/`padding` are plain numeric state slots, so
 * (shapeshifter-style) each is Inspector-editable AND equation-bindable/tween-
 * able for free. `spans` (optional merged cells) is a structural list read from
 * state; it is honored by the geometry/anchors/render but has no Inspector editor
 * (no list-of-objects row kind) — set it via a saved doc / a delta. See BOUNDS.
 *
 * ── BOUNDS (deliberate) ───────────────────────────────────────────────────────
 * - Guides render through emit(), so a NEUTRAL mid-gray at low opacity is the
 *   "theme-following" approximation: the display list is theme-INDEPENDENT (the
 *   CSS --a-* tokens live only in the DOM shell), and this reads as a faint
 *   scaffold on both light and dark camera backgrounds.
 * - Grid-line snapping is delivered via the junction-lattice POINTS (correct
 *   under any transform), not infinite-line snap features: core/derive.
 *   nodeFeatures world-transforms only a feature's point, not a line's
 *   direction, so plugin line-features would be wrong under rotation (every
 *   existing plugin's snapFeatures is likewise points-only).
 * - `spans` has no Inspector editor (see above).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, defaults, props } from "../core/properties.js";
import { rect } from "../render_gpu/ir.js";

// Faint scaffold guide styling. NOT tied to the live CSS theme (the render
// pipeline is theme-independent — see BOUNDS): a neutral mid-gray at low opacity
// reads as a subtle scaffold on light OR dark camera backgrounds.
const GUIDE_COLOR = "#808080"; // neutral mid-gray
const GUIDE_OPACITY = 0.45; // faint — visible as scaffold, never dominant
const GUIDE_STROKE_WIDTH = 1.5; // thin guide line (canvas units)

// Inline Inspector row builder — a numeric, equation-capable row in the
// "formatting" accordion region (the shapeshifter/donut precedent: bento-
// specific rows live in the plugin, so core/properties.js needs no edit).
const ROW = (key, label, extra = {}) => ({ key, label, kind: "number", category: "formatting", ...extra });

/**
 * Pure function. The 1-D cell layout along one axis: `n` equal cells spanning
 * [start, start + extent], separated by `gap`. Returns each cell's {pos, size}.
 * Cell size = (extent - (n-1)*gap) / n (clamped >= 0); cell i starts at
 * start + i*(size + gap). `n` is floored and clamped to >= 1.
 *
 * @param {number} n - cell count along the axis (>= 1)
 * @param {number} start - axis origin (local coords)
 * @param {number} extent - total span available for cells + gutters
 * @param {number} gap - gutter between adjacent cells
 * @returns {{pos: number, size: number}[]}
 *
 * @example bentoAxisTracks(2, 0, 100, 0) // [{pos: 0, size: 50}, {pos: 50, size: 50}]
 * @example bentoAxisTracks(2, 0, 100, 20) // [{pos: 0, size: 40}, {pos: 60, size: 40}]
 * @example bentoAxisTracks(1, 5, 40, 99).length // 1
 */
export function bentoAxisTracks(n, start, extent, gap) {
  const count = Math.max(1, Math.floor(n));
  const size = Math.max(0, (extent - (count - 1) * gap) / count);
  return Array.from({ length: count }, (_, i) => ({ pos: start + i * (size + gap), size }));
}

/**
 * Pure function. The n+1 grid-LINE center positions along an axis whose cells
 * are `tracks` (from bentoAxisTracks), spanning [start, start + extent]. Line 0
 * is the leading content edge, line n the trailing edge, and each interior line
 * is the CENTER of the gutter between adjacent cells (so with gap=0 it lands
 * exactly on the shared cell edge). These are the intersection-lattice coords.
 *
 * @param {{pos: number, size: number}[]} tracks - the axis cell tracks
 * @param {number} start - axis origin
 * @param {number} extent - total span
 * @returns {number[]} n+1 line-center positions
 *
 * @example bentoLineCenters([{pos: 0, size: 40}, {pos: 60, size: 40}], 0, 100) // [0, 50, 100]
 * @example bentoLineCenters([{pos: 0, size: 50}, {pos: 50, size: 50}], 0, 100) // [0, 50, 100]
 */
export function bentoLineCenters(tracks, start, extent) {
  const lines = [start];
  for (let i = 1; i < tracks.length; i++)
    lines.push((tracks[i - 1].pos + tracks[i - 1].size + tracks[i].pos) / 2);
  lines.push(start + extent);
  return lines;
}

/**
 * Pure function. Bento content geometry from widget state: the padding-inset
 * content rect, the per-axis cell tracks, and the per-axis line-center lattices.
 * `rows`/`cols` are floored + clamped to >= 1; missing gaps/padding are 0.
 *
 * @param {object} state - widget state {w, h, rows, cols, rowGap, colGap, padding}
 * @returns {{rows, cols, left, top, contentW, contentH, xTracks, yTracks, xLines, yLines}}
 *
 * @example bentoGeom({w: 100, h: 100, rows: 2, cols: 2, padding: 0, rowGap: 0, colGap: 0}).xLines // [0, 50, 100]
 * @example bentoGeom({w: 100, h: 100, rows: 3, cols: 1, padding: 10, rowGap: 0, colGap: 0}).contentW // 80
 */
export function bentoGeom(state) {
  const rows = Math.max(1, Math.floor(state.rows ?? 1));
  const cols = Math.max(1, Math.floor(state.cols ?? 1));
  const pad = state.padding ?? 0;
  const rowGap = state.rowGap ?? 0, colGap = state.colGap ?? 0;
  const left = pad, top = pad;
  const contentW = (state.w ?? 0) - 2 * pad, contentH = (state.h ?? 0) - 2 * pad;
  const xTracks = bentoAxisTracks(cols, left, contentW, colGap);
  const yTracks = bentoAxisTracks(rows, top, contentH, rowGap);
  return {
    rows, cols, left, top, contentW, contentH, xTracks, yTracks,
    xLines: bentoLineCenters(xTracks, left, contentW),
    yLines: bentoLineCenters(yTracks, top, contentH),
  };
}

/**
 * Pure function. The VISIBLE cell rectangles (local coords) of a bento grid,
 * with any merged `spans` absorbing the base cells they cover. Each cell is
 * {r, c, rowSpan, colSpan, x, y, w, h}: an ordinary cell is 1x1; a span at
 * (r,c) becomes ONE rect over its rowSpan x colSpan block (internal gutters
 * absorbed) and the base cells it covers are dropped.
 *
 * `spans` is an optional list of {r, c, rowSpan, colSpan} (0-based origin),
 * honored best-effort in declaration order: a span whose origin is off-grid or
 * already claimed by an earlier span is skipped (never resurrects a covered
 * cell, never emits overlapping merged rects). Spans come FIRST in the result.
 *
 * @param {object} state - widget state (see bentoGeom) plus optional `spans`
 * @returns {{r, c, rowSpan, colSpan, x, y, w, h}[]}
 *
 * @example bentoCellRects({w: 100, h: 100, rows: 2, cols: 2, padding: 0, rowGap: 0, colGap: 0}).length // 4
 * @example bentoCellRects({w: 100, h: 100, rows: 2, cols: 2, padding: 0, rowGap: 0, colGap: 0, spans: [{r: 0, c: 0, rowSpan: 2, colSpan: 1}]}).length // 3
 */
export function bentoCellRects(state) {
  const g = bentoGeom(state);
  const spans = Array.isArray(state.spans) ? state.spans : [];
  const covered = new Set(); // "r,c" of base cells absorbed by a span
  const spanCells = [];
  for (const sp of spans) {
    const r0 = Math.max(0, Math.floor(sp.r ?? 0)), c0 = Math.max(0, Math.floor(sp.c ?? 0));
    if (r0 >= g.rows || c0 >= g.cols || covered.has(`${r0},${c0}`)) continue; // off-grid / conflicting origin
    const rEnd = Math.min(g.rows - 1, r0 + Math.max(1, Math.floor(sp.rowSpan ?? 1)) - 1);
    const cEnd = Math.min(g.cols - 1, c0 + Math.max(1, Math.floor(sp.colSpan ?? 1)) - 1);
    for (let r = r0; r <= rEnd; r++) for (let c = c0; c <= cEnd; c++) covered.add(`${r},${c}`);
    const x = g.xTracks[c0].pos, y = g.yTracks[r0].pos;
    spanCells.push({
      r: r0, c: c0, rowSpan: rEnd - r0 + 1, colSpan: cEnd - c0 + 1,
      x, y,
      w: g.xTracks[cEnd].pos + g.xTracks[cEnd].size - x,
      h: g.yTracks[rEnd].pos + g.yTracks[rEnd].size - y,
    });
  }
  const cells = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    if (covered.has(`${r},${c}`)) continue;
    cells.push({ r, c, rowSpan: 1, colSpan: 1, x: g.xTracks[c].pos, y: g.yTracks[r].pos, w: g.xTracks[c].size, h: g.yTracks[r].size });
  }
  return [...spanCells, ...cells];
}

/**
 * Pure function. The grid's OWN local anchors [{id, x, y}] — the cell 9-anchor
 * sets (id `c{r}x{c}` + standard bbox suffix) plus the grid-line intersection
 * lattice (id `j{i}x{k}`). Excludes the widget's own bbox anchors (those come
 * from standardBBoxAnchors, added by `anchors` below) so this can also feed
 * snapFeatures without double-counting the bbox 9.
 *
 * @param {object} state - widget state
 * @returns {{id: string, x: number, y: number}[]}
 *
 * @example bentoGridAnchors({w: 100, h: 100, rows: 2, cols: 2, padding: 0, rowGap: 0, colGap: 0}).find((a) => a.id === "c0x0cm") // {id: "c0x0cm", x: 25, y: 25}
 * @example bentoGridAnchors({w: 100, h: 100, rows: 1, cols: 1, padding: 0, rowGap: 0, colGap: 0}).find((a) => a.id === "j1x1") // {id: "j1x1", x: 100, y: 100}
 */
export function bentoGridAnchors(state) {
  const g = bentoGeom(state);
  const out = [];
  for (const cell of bentoCellRects(state)) {
    const prefix = `c${cell.r}x${cell.c}`;
    for (const a of standardBBoxAnchors({ w: cell.w, h: cell.h }))
      out.push({ id: `${prefix}${a.id}`, x: cell.x + a.x, y: cell.y + a.y });
  }
  for (let i = 0; i < g.yLines.length; i++)
    for (let k = 0; k < g.xLines.length; k++)
      out.push({ id: `j${i}x${k}`, x: g.xLines[k], y: g.yLines[i] });
  return out;
}

// The 9 bbox suffixes a cell anchor id may end in — DERIVED from the one home
// (standardBBoxAnchors), never re-listed, so bentoCellAnchorId cannot mint an id
// bentoGridAnchors does not actually publish.
const CELL_ANCHOR_SUFFIXES = new Set(standardBBoxAnchors({ w: 0, h: 0 }).map((a) => a.id));

/**
 * Pure function. THE cell anchor id — `c{r}x{c}` + a standard bbox suffix, the
 * grammar the file docstring specifies. Exists so no caller string-builds an id:
 * an id is only referenceable if it contains NO underscore and IS published by
 * bentoGridAnchors, and both facts live here. Throws LOUDLY on an unknown suffix
 * (a typo'd suffix would produce an id that resolveRef accepts syntactically and
 * evaluateState then rejects at paint time — much later, and once per frame).
 *
 * @param {number} r - cell row (0-based)
 * @param {number} c - cell column (0-based)
 * @param {string} suffix - one of the 9 standard bbox anchor ids
 * @returns {string}
 *
 * @example bentoCellAnchorId(1, 2) // "c1x2cm" (the cell CENTRE — the default)
 * @example bentoCellAnchorId(0, 0, "tl") // "c0x0tl"
 * @example // bentoCellAnchorId(0, 0, "middle") throws: not a standard bbox anchor id
 */
export function bentoCellAnchorId(r, c, suffix = "cm") {
  if (!CELL_ANCHOR_SUFFIXES.has(suffix))
    throw new Error(`bentoCellAnchorId: "${suffix}" is not a standard bbox anchor id (${[...CELL_ANCHOR_SUFFIXES].join("/")}) — bentoGridAnchors publishes no such cell anchor.`);
  return `c${r}x${c}${suffix}`;
}

/**
 * Pure function. The VISIBLE cell (bentoCellRects entry) at a LOCAL point — the
 * cell CONTAINING it, or, for a point in a gutter / in the padding / outside the
 * widget entirely, the NEAREST cell by squared clamped rect distance.
 *
 * NEAREST rather than "the containing cell or null" on purpose: the gutters and
 * the padding inset are real areas of the widget, so a containment-only lookup
 * would make a press there a dead no-op — and the caller (a cell-aiming click)
 * has no better answer to give than "the one you were nearest". Ties resolve to
 * the earlier cell in bentoCellRects order (merged spans first, then row-major),
 * so the result is deterministic. Never null: bentoCellRects always yields at
 * least one cell (rows/cols are clamped to >= 1).
 *
 * @param {object} state - widget state (see bentoGeom) plus optional `spans`
 * @param {number} localX - point x in the widget's own local frame
 * @param {number} localY - point y in the widget's own local frame
 * @returns {{r, c, rowSpan, colSpan, x, y, w, h}}
 *
 * @example bentoCellNear({w: 100, h: 100, rows: 2, cols: 2, padding: 0, rowGap: 0, colGap: 0}, 75, 25) // the {r: 0, c: 1} cell (containing)
 * @example bentoCellNear({w: 100, h: 100, rows: 2, cols: 2, padding: 0, rowGap: 0, colGap: 0}, -500, -500).r // 0 (far outside → nearest: the top-left cell)
 */
export function bentoCellNear(state, localX, localY) {
  const cells = bentoCellRects(state);
  let best = cells[0], bestD = Infinity;
  for (const cell of cells) {
    const dx = Math.max(cell.x - localX, 0, localX - (cell.x + cell.w));
    const dy = Math.max(cell.y - localY, 0, localY - (cell.y + cell.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = cell; }
  }
  return best;
}

/**
 * Pure function. A cell's 4 LOCAL corners as [x, y] pairs, clockwise from its
 * top-left. Feeds an editor overlay that must draw the cell CORRECTLY under the
 * widget's transform: a caller maps these 4 points through the world transform
 * and strokes the ring, where an axis-aligned {x, y, w, h} rect would be wrong
 * the moment the bento is rotated.
 *
 * @param {{x: number, y: number, w: number, h: number}} cell - a bentoCellRects entry
 * @returns {[number, number][]}
 *
 * @example bentoCellCorners({x: 0, y: 0, w: 10, h: 20}) // [[0, 0], [10, 0], [10, 20], [0, 20]]
 */
export function bentoCellCorners(cell) {
  return [[cell.x, cell.y], [cell.x + cell.w, cell.y], [cell.x + cell.w, cell.y + cell.h], [cell.x, cell.y + cell.h]];
}

/**
 * Pure function. The bento's FULL local anchor set: the widget bbox 9
 * (standardBBoxAnchors) followed by every cell + junction anchor. This is the
 * plugin `anchors(state)` capability — core/derive.nodeAnchors world-transforms
 * these; they feed hit-tests, the anchor hover-copy chips, and `=` equations.
 *
 * @param {object} state - widget state
 * @returns {{id: string, x: number, y: number}[]}
 *
 * @example bentoAnchors({w: 100, h: 100, rows: 2, cols: 2, padding: 0, rowGap: 0, colGap: 0}).find((a) => a.id === "c0x1cm") // {id: "c0x1cm", x: 75, y: 25}
 * @example bentoAnchors({w: 100, h: 100, rows: 1, cols: 1, padding: 0, rowGap: 0, colGap: 0}).find((a) => a.id === "j0x0") // {id: "j0x0", x: 0, y: 0}
 */
export function bentoAnchors(state) {
  return [...standardBBoxAnchors(state), ...bentoGridAnchors(state)];
}

export const bentoPlugin = {
  type: "bento",
  title: "Bento Grid",
  // A bbox scaffold: body-drag moves it, resize handles resize the whole grid.
  // Not a ghost — it emits its own faint grid guides (a ghost would only get a
  // plain bbox outline, hiding the grid structure).
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK = AIM A CELL AT A WIDGET (web/bentoBind.js). The scaffold is
  // never EDITED by it; the WIDGET is — it gains `=` equations reading a cell
  // anchor, so it follows the grid from then on. That is the whole point of a
  // widget whose product is anchors, and it is one string here (the registry
  // owns the behaviour — web/widget_handlers.js).
  activate: "bento_bind_cell",
  /**
   * THE CELL-GRID DESCRIPTOR — the CONTENT that activation operates on, in the
   * `interiorView` / `insertPointAt` shape: three PURE functions the handler asks
   * questions of, so the handler knows about "a widget with addressable cells"
   * rather than about the bento. That is what lets its `claims` be a SHAPE test
   * (`!!plugin.cellGrid`) instead of the literal type check the handler registry
   * exists to have removed — and it means `web/` imports no named plugin.
   *
   *   at(state, localX, localY) → the cell at a point (nearest; never null)
   *   corners(cell)             → the cell's 4 local corners, for an overlay
   *   anchorId(cell, suffix)    → that cell's referenceable anchor id
   */
  cellGrid: {
    at: bentoCellNear,
    corners: bentoCellCorners,
    /** Pure function. A cell's anchor id (bentoCellAnchorId by row/col).
     * @example // cellGrid.anchorId({r: 1, c: 2}, "cm") === "c1x2cm" */
    anchorId: (cell, suffix) => bentoCellAnchorId(cell.r, cell.c, suffix),
  },
  defaults: {
    type: "bento", x: 120, y: 120, w: 480, h: 320, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about own center (an equation — the standard widget default).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A 2-row x 3-col landscape starter with even gutters + a matching inset.
    rows: 2, cols: 3, rowGap: 16, colGap: 16, padding: 16,
    ...defaults("opacity"),
  },
  inspector: [
    ...bundle("positioning"),
    ROW("rows", "Rows", { min: 1, help: "Number of grid rows (one or more). Each row of cells gets its own anchor set." }),
    ROW("cols", "Columns", { min: 1, help: "Number of grid columns (one or more). Each column of cells gets its own anchor set." }),
    ROW("rowGap", "Row gap", { min: 0, help: "Vertical gutter between rows, in canvas units. The gap centers become grid-line intersection anchors." }),
    ROW("colGap", "Column gap", { min: 0, help: "Horizontal gutter between columns, in canvas units. The gap centers become grid-line intersection anchors." }),
    ROW("padding", "Padding", { min: 0, help: "Inset from the widget's bounding box to the grid content, in canvas units." }),
    ...props("opacity"),
  ],
  /**
   * Pure function. Faint scaffold guides: a stroke-only rect per visible cell
   * (the gaps between them show the gutters). The VALUE is the anchors; this is
   * only the visible layout aid. Local coords (the render layer applies the
   * world transform). Zero/negative-size cells emit nothing.
   */
  emit(s) {
    if ((s.w ?? 0) <= 0 || (s.h ?? 0) <= 0) return [];
    const op = s.opacity ?? 1;
    return bentoCellRects(s)
      .filter((cell) => cell.w > 0 && cell.h > 0)
      .map((cell) => rect({
        x: cell.x, y: cell.y, w: cell.w, h: cell.h,
        fill: null, stroke: GUIDE_COLOR, strokeWidth: GUIDE_STROKE_WIDTH,
        opacity: op * GUIDE_OPACITY,
      }));
  },
  anchors: bentoAnchors,
  /**
   * Pure function. Snap POINTS for every cell + junction anchor (so a dragged
   * widget snaps to a bento cell or a grid-line intersection). The widget's own
   * bbox points + edge lines are auto-added by core/derive.nodeFeatures, so they
   * are NOT repeated here. Points only — see the file BOUNDS note.
   */
  snapFeatures(s) {
    return bentoGridAnchors(s).map((a) => ({ kind: "point", x: a.x, y: a.y, id: a.id }));
  },
  // NOTE: the `add-bento` insert command is registered ONCE, in web/App.svelte's
  // coreCommands (its "Add menu entry"), so it is not declared here — a second
  // registration of the same id throws in the command registry.
};
