/**
 * Pure grid-layout math for the "Arrange Selection into Grid" tool (the bento
 * box). DOM-free core (runs in bare node; core_test.js enforces it). Two jobs,
 * kept separate so each is trivially testable without the bento widget:
 *
 *   gridAssign(n, rows, cols)          — which cell (row-major) each of n items lands in
 *   cellCenters(bounds, rows, cols, g) — the world-space CENTER of every cell
 *
 * The arrange command composes them: assign item i → cell (r,c), then move item
 * i so its own center sits on cellCenters[...] for (r,c). `rows` is a REQUESTED
 * MINIMUM — with a fixed column count and row-major fill, an item's row/col is
 * driven purely by `cols`, so more items than rows*cols simply spill into extra
 * rows (the "overflow → grow rows" rule). The caller grows the bento's row count
 * to match (see effectiveRows below) so cellCenters sizes cells for every row.
 *
 * Cell geometry MUST match the bento widget's own (#86): a `padding` inset on
 * all four sides, then rows×cols equal cells separated by `rowGap`/`colGap`.
 * This is the standard CSS-grid track model.
 */

/**
 * Pure function. The number of rows actually needed to hold `itemCount` items
 * in `cols` columns, never fewer than the requested `rows` — the "overflow →
 * grow rows to fit" rule as one named value. Both the bento's row count and
 * cellCenters below take this so empty trailing cells (n < rows*cols) keep the
 * requested shape while overflow (n > rows*cols) grows downward.
 *
 * @param {number} itemCount — number of items to place (>= 0)
 * @param {number} rows — requested minimum row count (>= 1)
 * @param {number} cols — column count (>= 1)
 * @returns {number} rows actually used
 *
 * @example effectiveRows(5, 2, 3) // 2   (5 items fit in 2×3, one cell empty)
 * @example effectiveRows(7, 2, 3) // 3   (7 > 2×3 → grow to ceil(7/3) rows)
 * @example effectiveRows(0, 2, 3) // 2   (no items → keep the requested shape)
 */
export function effectiveRows(itemCount, rows, cols) {
  return Math.max(rows, Math.ceil(itemCount / cols));
}

/**
 * Pure function. Row-major cell assignment for `itemCount` items across a grid
 * with `cols` columns. Returns one `{row, col}` per item, in item order: item i
 * fills column (i mod cols) of row floor(i / cols). `rows` is the requested
 * MINIMUM and never caps the output — with a fixed column count the row index is
 * a pure function of the item index, so more items than rows*cols overflow into
 * extra rows (rows grow to fit; see effectiveRows).
 *
 * @param {number} itemCount — number of items (>= 0)
 * @param {number} rows — requested minimum rows (>= 1); does not cap overflow
 * @param {number} cols — columns (>= 1)
 * @returns {{row: number, col: number}[]} length === itemCount, row-major order
 *
 * @example gridAssign(4, 2, 2) // [{row:0,col:0},{row:0,col:1},{row:1,col:0},{row:1,col:1}]
 * @example gridAssign(5, 2, 3)[4] // {row:1,col:1}   (5th item, 2nd row, 2nd col)
 * @example gridAssign(7, 2, 3)[6] // {row:2,col:0}   (overflow → a 3rd row appears)
 */
export function gridAssign(itemCount, rows, cols) {
  return Array.from({ length: itemCount }, (_, i) => ({
    row: Math.floor(i / cols),
    col: i % cols,
  }));
}

/**
 * Pure function. The world-space CENTER of every cell of a rows×cols grid laid
 * out inside `bounds` (the bento's rect {x, y, w, h}). `gaps` gives the
 * `padding` inset on all four sides plus the `rowGap`/`colGap` between tracks
 * (each absent gap defaults to 0). Returns one `{row, col, x, y}` per cell in
 * row-major order (length rows*cols). Because padding is symmetric and the
 * tracks divide the remaining space evenly, the collective center of the cells
 * equals the center of `bounds`.
 *
 * Cell size:   cellW = (w - 2·padding - colGap·(cols-1)) / cols   (cellH analogous)
 * Cell (r,c) center:
 *   x = bounds.x + padding + c·(cellW + colGap) + cellW/2
 *   y = bounds.y + padding + r·(cellH + rowGap) + cellH/2
 *
 * @param {{x:number,y:number,w:number,h:number}} bounds — the grid's world rect
 * @param {number} rows — row count (>= 1)
 * @param {number} cols — column count (>= 1)
 * @param {{rowGap?:number,colGap?:number,padding?:number}} gaps — track gaps + outer padding
 * @returns {{row:number,col:number,x:number,y:number}[]} cell centers, row-major
 *
 * @example cellCenters({x:0,y:0,w:100,h:100}, 1, 1, {}) // [{row:0,col:0,x:50,y:50}]
 * @example cellCenters({x:0,y:0,w:100,h:100}, 1, 2, {})[1] // {row:0,col:1,x:75,y:50}
 * @example cellCenters({x:0,y:0,w:120,h:120}, 1, 1, {padding:10})[0] // {row:0,col:0,x:60,y:60}
 * @example cellCenters({x:0,y:0,w:110,h:100}, 1, 2, {colGap:10})[1] // {row:0,col:1,x:85,y:50}
 */
export function cellCenters(bounds, rows, cols, gaps = {}) {
  const padding = gaps.padding ?? 0;
  const rowGap = gaps.rowGap ?? 0;
  const colGap = gaps.colGap ?? 0;
  const cellW = (bounds.w - 2 * padding - colGap * (cols - 1)) / cols;
  const cellH = (bounds.h - 2 * padding - rowGap * (rows - 1)) / rows;
  const centers = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      centers.push({
        row,
        col,
        x: bounds.x + padding + col * (cellW + colGap) + cellW / 2,
        y: bounds.y + padding + row * (cellH + rowGap) + cellH / 2,
      });
    }
  }
  return centers;
}

/**
 * Pure function. A near-square {rows, cols} that holds at least `n` cells —
 * cols = ceil(√n), rows = ceil(n / cols). Used to seed the grid-size picker
 * with a sensible default highlight for a selection of `n` items (so a 9-item
 * selection opens on 3×3, not an arbitrary hardcoded shape). Never returns 0 in
 * either dimension (n <= 0 → 1×1).
 *
 * @param {number} n — item count
 * @returns {{rows:number, cols:number}}
 *
 * @example nearSquareGrid(1) // {rows:1,cols:1}
 * @example nearSquareGrid(5) // {rows:2,cols:3}
 * @example nearSquareGrid(9) // {rows:3,cols:3}
 * @example nearSquareGrid(12) // {rows:3,cols:4}
 */
export function nearSquareGrid(n) {
  if (n <= 1) return { rows: 1, cols: 1 };
  const cols = Math.ceil(Math.sqrt(n));
  return { rows: Math.ceil(n / cols), cols };
}
