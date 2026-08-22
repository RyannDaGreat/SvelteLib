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

/**
 * Pure function. `appRankItems` for a list carrying Dropdown `insert` CAPTIONS —
 * the grouped select rows (blendMode's six families). Survivors keep the
 * AUTHORED ORDER, and a caption survives exactly when the family it heads still
 * has one.
 *
 * WHY A SECOND RANKER RATHER THAN A FLAG ON THE FIRST. These are two different
 * answers to "what is a good order", and both are right for their list. A flat
 * list has no structure to lose, so BEST-FIRST is the whole point of typing —
 * the top row is the one you meant. A GROUPED list's order IS information the
 * author wrote down (core/properties.js's BLEND_MODE_GROUPS: "the three most
 * reached-for come first, then lightening, then darkening…"), and sorting
 * globally by score would interleave families under captions that no longer
 * describe what sits beneath them — a caption reading "Darkening" above a row
 * from the contrast group is not a worse order, it is a FALSE STATEMENT. So a
 * grouped list filters in place and never reorders.
 *
 * AN ORPHANED CAPTION IS THE OTHER HALF, and it is why dropping inserts (which
 * is what appRankItems does, correctly, for a flat list) is not enough on its
 * own: keep every caption and a filtered menu grows headers over nothing;
 * drop every caption and the families silently merge into one flat list whose
 * order then looks arbitrary. A caption is kept iff a labelled row between it
 * and the next caption survived.
 *
 * A LEADING RUN WITH NO CAPTION IS LEGAL and passes through: `selectRowItems`
 * only emits captions for a row declaring `optionGroups`, but nothing forbids a
 * caller prepending ungrouped rows, and dropping them would lose options.
 *
 * @param {string} query - the raw filter text
 * @param {any[]} items - candidates: {value, label} rows and {insert} captions
 * @returns {any[]} the surviving rows in authored order, labelled ones carrying
 *   `_spans`; the originals when query is blank
 *
 * @example // the matching family keeps its caption; the other family goes entirely
 * appRankGrouped("scr", [
 *   {insert: "Lightening"}, {value: "screen", label: "Screen"},
 *   {insert: "Darkening"}, {value: "multiply", label: "Multiply"},
 * ])
 * // => [ {insert: "Lightening"}, {value: "screen", label: "Screen", _spans: [[0, 3]]} ]
 * @example // a blank query is the identity — the authored groups, untouched
 * appRankGrouped("", [{insert: "G"}, {value: 1, label: "A"}])
 * // => [ {insert: "G"}, {value: 1, label: "A"} ]
 * @example // no survivors anywhere ⇒ no captions either, not a menu of headers
 * appRankGrouped("zzz", [{insert: "G"}, {value: 1, label: "A"}]) // => []
 */
export function appRankGrouped(query, items) {
  const list = items ?? [];
  const q = String(query ?? "").trim();
  if (q === "") return list;

  // Rank flat FIRST, so "does this row survive" is decided by exactly the one
  // scorer the whole app uses — this function owns ORDER and captions, never
  // matching. Keyed by list position because labels repeat across families.
  const survivors = new Map();
  for (const [idx, item] of list.entries()) {
    if (isCaption(item)) continue;
    const [ranked] = appRankItems(q, [item]);
    if (ranked) survivors.set(idx, ranked);
  }

  const out = [];
  let pendingCaption = null; // the caption awaiting proof its family survived
  for (const [idx, item] of list.entries()) {
    if (isCaption(item)) {
      pendingCaption = item;
      continue;
    }
    const ranked = survivors.get(idx);
    if (!ranked) continue;
    if (pendingCaption) {
      out.push(pendingCaption);
      pendingCaption = null;
    }
    out.push(ranked);
  }
  return out;
}

/**
 * Pure function. True for a Dropdown `insert` entry (a decoration between rows)
 * rather than a selectable option. The discriminator is Dropdown's own: the
 * PRESENCE of an `insert` key, not its truthiness — `{insert: ""}` is a caption
 * with an empty title, and a blank divider is a real thing a caller may write.
 *
 * @param {any} it - a Dropdown item
 * @returns {boolean}
 *
 * @example isCaption({insert: "Lightening"}) // => true
 * @example isCaption({value: "screen", label: "Screen"}) // => false
 * @example isCaption(null) // => false
 */
export function isCaption(it) {
  return it != null && Object.prototype.hasOwnProperty.call(it, "insert");
}
