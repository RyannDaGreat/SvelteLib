/**
 * fuzzyMatch — the DEFAULT type-to-filter engine for SearchableDropdown, and a
 * standalone pure module any consumer can reuse or REPLACE. Three pure,
 * DOM-free, doctested functions:
 *   - fuzzyMatch(query, text)  → {score, spans} | null  (one candidate)
 *   - rankItems(query, items)  → ranked, span-annotated subset  (a whole list)
 *   - segmentSpans(text, spans)→ highlight segments  (for rendering <mark>s)
 *
 * PLUGGABILITY CONTRACT (why this file is small and replaceable):
 *   SearchableDropdown takes a `rankFn(query, items) -> items[]` prop that
 *   DEFAULTS to `rankItems` here. A custom ranker need only return the surviving
 *   items best-first; to get highlighting it attaches a `_spans` array of
 *   [start,end) index ranges (end-exclusive, into the item's label) on each
 *   returned item. That is the entire seam — matching AND sorting are one
 *   function, so a caller swaps both at once (e.g. wire an n-gram or a
 *   server-side ranker) without touching the component. `rankItems` itself takes
 *   `matchFn`/`textOf` options for the lighter case of keeping the ranking but
 *   swapping the per-candidate scorer.
 */

// Word-boundary separators: a matched char right after one of these (or at
// index 0) reads as the start of a "word" and scores a boundary bonus, so
// "gla" ranks "Glass" (boundary G) above an interior hit.
const SEPARATOR = /[\s\-_/.]/;

// Score weights. All positive so a score is a plain non-negative integer and
// ranking never depends on float ties; ordering among equal scores is broken by
// earliness and brevity in rankItems, not by a fractional penalty here.
const BASE = 1; // every matched character
const CONSECUTIVE_BONUS = 8; // a matched char immediately after the previous match
const BOUNDARY_BONUS = 10; // a matched char at a word boundary (start / post-separator)

/**
 * Pure function. Greedy, case-insensitive subsequence match of `query` against
 * `text`. Returns the matched character index runs and a relevance score, or
 * null when `text` does not contain `query` as a subsequence.
 *
 * Matched indices are the LEFTMOST subsequence (greedy first hit for each query
 * char). Consecutive matched indices are merged into [start, end) spans (end
 * exclusive), ready to wrap in <mark>. Higher score = better; the score rewards
 * consecutive runs (CONSECUTIVE_BONUS) and word-boundary starts (BOUNDARY_BONUS)
 * on top of a per-char BASE. Position tie-breaks live in rankItems, not here.
 *
 * @param {string} query - The search fragment. Empty ⇒ {score:0, spans:[]}.
 * @param {string} text - The candidate label.
 * @returns {{score:number, spans:[number,number][]}|null}
 *
 * @example
 * // "gla" hits the run "Gla" inside "Liquid Glass" (G is post-space ⇒ boundary).
 * fuzzyMatch("gla", "Liquid Glass")
 * // => { score: 29, spans: [[7, 10]] }
 * @example
 * // Not a subsequence ⇒ no match.
 * fuzzyMatch("xyz", "Liquid Glass") // => null
 * @example
 * // Empty query matches everything, neutrally, with no spans to highlight.
 * fuzzyMatch("", "Anything") // => { score: 0, spans: [] }
 */
export function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return { score: 0, spans: [] };

  const indices = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    while (ti < t.length && t[ti] !== c) ti++;
    if (ti === t.length) return null; // ran out of text before matching this char
    indices.push(ti);
    ti++;
  }

  let score = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    score += BASE;
    if (k > 0 && indices[k - 1] === i - 1) score += CONSECUTIVE_BONUS;
    if (i === 0 || SEPARATOR.test(text[i - 1])) score += BOUNDARY_BONUS;
  }
  return { score, spans: mergeIndices(indices) };
}

/**
 * Pure function. Merges a sorted array of character indices into contiguous
 * [start, end) spans (end exclusive), the shape fuzzyMatch and segmentSpans use.
 *
 * @param {number[]} indices - Ascending, distinct character indices.
 * @returns {[number,number][]}
 *
 * @example mergeIndices([7, 8, 9]) // => [[7, 10]]
 * @example mergeIndices([1, 3, 4]) // => [[1, 2], [3, 5]]
 * @example mergeIndices([]) // => []
 */
export function mergeIndices(indices) {
  const spans = [];
  for (const i of indices) {
    const last = spans[spans.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else spans.push([i, i + 1]);
  }
  return spans;
}

/**
 * Pure function. Filters and ranks `items` by fuzzy relevance to `query`, best
 * first. Each surviving item is returned as a SHALLOW CLONE carrying its match
 * `_spans` so the caller can highlight without mutating the source. An empty
 * query is the identity: the original items, in order, untouched (no clone, no
 * spans).
 *
 * Ordering: score DESC, then earliest first-match index ASC, then shorter label
 * ASC, then original position ASC (a stable last resort). Non-string / span-less
 * entries (e.g. Dropdown `insert` captions, which have no `label`) are dropped
 * while filtering — a searched list is flat by construction.
 *
 * @param {string} query - The search fragment.
 * @param {any[]} items - Candidate items (each typically {value, label}).
 * @param {object} [opts]
 * @param {(it:any)=>string} [opts.textOf] - Label extractor. Default: it.label.
 * @param {(q:string,text:string)=>({score:number,spans:[number,number][]}|null)} [opts.matchFn] - Per-candidate scorer. Default: fuzzyMatch.
 * @returns {any[]} Ranked items, each a clone with `_spans` attached.
 *
 * @example
 * rankItems("gl", [{value:1,label:"Sky"},{value:2,label:"Liquid Glass"},{value:3,label:"Glow"}])
 * // => [ {value:3, label:"Glow", _spans:[[0,2]]}, {value:2, label:"Liquid Glass", _spans:[[7,9]]} ]
 * @example
 * rankItems("", [{value:1,label:"A"},{value:2,label:"B"}])
 * // => [ {value:1,label:"A"}, {value:2,label:"B"} ]   // identity, no _spans
 */
export function rankItems(query, items, opts = {}) {
  const textOf = opts.textOf ?? ((it) => it.label);
  const matchFn = opts.matchFn ?? fuzzyMatch;
  if (query.trim().length === 0) return items;

  const scored = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const text = textOf(it);
    if (typeof text !== "string") continue; // captions / inserts have no label
    const m = matchFn(query, text);
    if (!m) continue;
    scored.push({ it, idx, score: m.score, first: m.spans.length ? m.spans[0][0] : 0, len: text.length, spans: m.spans });
  }
  scored.sort((a, b) =>
    b.score - a.score || a.first - b.first || a.len - b.len || a.idx - b.idx);
  return scored.map(({ it, spans }) => ({ ...it, _spans: spans }));
}

/**
 * Pure function. Splits `text` into consecutive segments tagged by whether each
 * lies inside a match span, so a renderer can wrap only the matched runs in
 * <mark>. `spans` are [start,end) ranges (from fuzzyMatch), assumed sorted and
 * non-overlapping. Nullish / empty spans yield a single unmatched segment.
 *
 * @param {string} text - The label to split.
 * @param {[number,number][]} [spans] - Sorted, non-overlapping match spans.
 * @returns {{text:string, match:boolean}[]}
 *
 * @example
 * segmentSpans("Liquid Glass", [[7,10]])
 * // => [ {text:"Liquid ",match:false}, {text:"Gla",match:true}, {text:"ss",match:false} ]
 * @example
 * segmentSpans("abc", []) // => [ {text:"abc", match:false} ]
 */
export function segmentSpans(text, spans) {
  if (!spans || spans.length === 0) return [{ text, match: false }];
  const out = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), match: false });
    out.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
  return out;
}
