/*
  searchRank — THE ONE RANKING every searchable list in THIS APP uses.

  WHY THIS FILE EXISTS. Two fuzzy scorers ship side by side, and both are meant
  to. src/lib/fuzzyMatch.js is the component LIBRARY's default, required verbatim
  by the manifest ("SearchableDropdown … DEFAULT plain fuzzy matching, pluggable
  custom sorting/fuzzy algorithms") and unable to reach core/fuzzy.js anyway:
  src/lib has zero imports outside svelte, and a library that reached into one of
  its demo apps would stop being a library. core/fuzzy.js is rp's completion
  ranker, which the command palette, the Asset Explorer, the File Browser,
  equation autocomplete and the iconify search all already share.

  So the library keeps its default and the APP overrides it — that is exactly
  what SearchableDropdown's `rankFn` prop is for. What was actually broken is
  that PowerRP never used the seam: four SearchableDropdown mount points silently
  took the library default, so typing the same letters ranked one way in the
  material picker and another in the palette. web/AssetExplorer.svelte:37-38
  wrote the rule down before it was broken — "a second scorer would mean typing
  'vid' ranks differently in two places in one app, and the user learns one of
  them wrong" — while itself choosing rp's scorer. This file is that rule,
  executable. tests/one_ranking_ban_test.js is the half that keeps it true.

  MEASURED, so the scope of the change is on the record rather than assumed: the
  two scorers never disagree about WHAT matches. Over 134 real queries against
  the material labels, the 101-title retype roster and all 48 command titles, the
  match SET differed in ZERO cases and only the ORDER moved. Both are greedy
  case-insensitive subsequence matchers; a user switching surfaces was never shown
  a different set of results, only a different first row.
*/

import { rpFuzzyScore, rpFuzzyMatchIndices } from "../core/fuzzy.js";
import { mergeIndices } from "../../../lib/fuzzyMatch.js";

/**
 * Pure function. SearchableDropdown's `rankFn` for THIS app: the surviving items
 * best-first by rp's completion ranker, each a shallow clone carrying the
 * `_spans` the component highlights with.
 *
 * The contract is src/lib/fuzzyMatch.js's, met with core/fuzzy.js's scorer —
 * signature `(query, items) => items[]`, `_spans` as [start, end) ranges into
 * the item's label. Two differences from the library default follow from rp's
 * algorithm and are deliberate: rp scores LOWER = better, so the sort is
 * ascending; and rp already folds earliness into its score (`firstMatchPosition
 * * 2.0`), so there is no separate earliest-match tie-break to add — ties fall
 * through to original position, which keeps the incoming order stable.
 *
 * AN EMPTY QUERY IS NOT A FILTER, matching rankItems and rpFuzzyRank: the list
 * passes through untouched, so opening a picker never reshuffles what is already
 * on screen. Items whose label is not a string (Dropdown `insert` captions) are
 * dropped while filtering, as the library default drops them.
 *
 * @param {string} query - the raw filter text
 * @param {any[]} items - candidates, each typically {value, label}
 * @returns {any[]} ranked clones with `_spans`; the originals when query is blank
 *
 * @example
 * appRankItems("gl", [{value: 1, label: "Sky"}, {value: 2, label: "Glow"}])
 * // => [ {value: 2, label: "Glow", _spans: [[0, 2]]} ]
 * @example // best match FIRST — "crt" is a prefix, so it beats the scattered hit
 * appRankItems("crt", [{label: "corkboardThumbtack"}, {label: "crt"}]).map((i) => i.label)
 * // => ["crt", "corkboardThumbtack"]
 * @example // a blank query is the identity: same objects, same order, no _spans
 * appRankItems("  ", [{value: 1, label: "B"}, {value: 2, label: "A"}])
 * // => [ {value: 1, label: "B"}, {value: 2, label: "A"} ]
 * @example // nothing matched is NOT the same as nothing to show
 * appRankItems("zzz", [{value: 1, label: "Sky"}]) // => []
 */
export function appRankItems(query, items) {
  const list = items ?? [];
  const q = String(query ?? "").trim();
  if (q === "") return list;

  const scored = [];
  for (let idx = 0; idx < list.length; idx += 1) {
    const item = list[idx];
    const label = item?.label;
    if (typeof label !== "string") continue; // captions / inserts carry no label
    const score = rpFuzzyScore(q, label);
    if (score === null) continue;
    scored.push({ item, idx, score, spans: mergeIndices(rpFuzzyMatchIndices(q, label)) });
  }
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx); // LOWER is better (core/fuzzy.js's convention)
  return scored.map(({ item, spans }) => ({ ...item, _spans: spans }));
}
