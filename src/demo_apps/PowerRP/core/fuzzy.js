/**
 * Fuzzy ranking — a JavaScript port of rp's completion ranking algorithm
 * (rp/rp_ptpython/completion_ranker.py: calculate_match_score), the engine
 * behind rp's IDE autocomplete. Ported per manifest; verified against live rp
 * output on 10 ranking scenarios before adoption. LOWER score = better match
 * (opposite of the naive scorer this replaced).
 *
 * Deliberately not ported (python-REPL-specific, per the port analysis):
 * the REPL-history frequency boost (the palette's MRU ordering covers
 * recency), the literal 'mro' filter, and dunder/underscore prefix staging.
 *
 * ── SPACES ARE NOT WORD BOUNDARIES (measured, and user-visible) ──────────────
 * A skipped '_' costs a flat 0.1 because word-boundary skips are cheap; every
 * OTHER skipped character costs 1.0, and ' ' is every other character. So a
 * multi-word command title pays for the whole of its first word before a second
 * initial can match, and the ACRONYM reading of a query ranks LAST: for "dh",
 * "Dashed thing" scores 2.0011 and "Distribute Horizontally" 10.0012. That is
 * faithful to the python original, where candidates are identifiers and have no
 * spaces — but the palette's candidates are titled commands, so the port inherits
 * a discount it can never earn. The doctests below now STATE this; the one they
 * replace asserted the opposite, and nothing executed it.
 */

/**
 * Pure function. rp's subsequence match score. Lower = better; null = no match.
 *
 * Algorithm (faithful to calculate_match_score):
 * - Walk candidate left→right consuming query chars in order (case-insensitive).
 * - score starts at 0.001; each match adds the skip distance accumulated since
 *   the last match (+0.0001 first if the case differs), then resets it.
 * - '_' while not matching: reset skip distance, add flat 0.1 (word-boundary
 *   skips are cheap). Any other unmatched char: skip distance += 1.
 * - Afterwards add 2.0 × (index of the first matched char) — earlier is better.
 * - Case-insensitive prefix match divides the whole score by 1000.
 *
 * @example rpFuzzyScore("d", "dict") // 0.000001 (prefix: tiny = best)
 * @example rpFuzzyScore("xyz", "abc") // null (no match)
 * @example rpFuzzyScore("dh", "Dashed thing") // 2.0011 (the 'h' is 3 chars in: 2 skipped, +0.0001 for matching 'd' against 'D')
 * @example rpFuzzyScore("dh", "Distribute Horizontally") // 10.0012 (10 chars skipped to reach the 'H', so the word-initial match scores WORSE — see the header)
 */
export function rpFuzzyScore(query, candidate) {
  const isPrefixMatch = candidate.toLowerCase().startsWith(query.toLowerCase());
  const queryChars = Array.from(query);
  const candidateChars = Array.from(candidate);
  let score = 0.001;
  let skipDistance = 0;
  let firstMatchPosition = null;
  let charsProcessed = 0;

  while (queryChars.length && candidateChars.length) {
    charsProcessed += 1;
    const candidateChar = candidateChars.shift();
    if (queryChars[0].toUpperCase() === candidateChar.toUpperCase()) {
      const queryChar = queryChars.shift();
      if (firstMatchPosition === null) firstMatchPosition = charsProcessed - 1;
      if (queryChar !== candidateChar) skipDistance += 0.0001;
      score += skipDistance;
      skipDistance = 0;
    } else if (candidateChar === "_") {
      skipDistance = 0;
      score += 0.1;
    } else {
      skipDistance += 1;
    }
  }

  if (firstMatchPosition !== null) score += firstMatchPosition * 2.0;
  if (isPrefixMatch) score /= 1000;
  return queryChars.length ? null : score;
}

/**
 * Pure function. Candidate character indices consumed by rpFuzzyScore's match.
 *
 * Mirrors rpFuzzyScore's greedy left→right walk EXACTLY (same case-insensitive
 * comparison, same order): each query char is consumed by the first not-yet-used
 * candidate char that matches it case-insensitively. Returns those candidate
 * indices (into Array.from(candidate), i.e. code-point positions — the same unit
 * rpFuzzyScore iterates, so multi-code-point graphemes count as their pieces),
 * or null when the query does not fully match. This is the walk used to
 * highlight the matched characters; scoring itself stays in rpFuzzyScore.
 *
 * @example rpFuzzyMatchIndices("dh", "Distribute Horizontally") // [0, 11]
 * @example rpFuzzyMatchIndices("dict", "dict") // [0, 1, 2, 3]
 * @example rpFuzzyMatchIndices("xyz", "abc") // null
 * @example rpFuzzyMatchIndices("", "abc") // []
 */
export function rpFuzzyMatchIndices(query, candidate) {
  const queryChars = Array.from(query);
  const candidateChars = Array.from(candidate);
  const indices = [];
  let q = 0;
  for (let i = 0; i < candidateChars.length && q < queryChars.length; i += 1) {
    if (queryChars[q].toUpperCase() === candidateChars[i].toUpperCase()) {
      indices.push(i);
      q += 1;
    }
  }
  return q < queryChars.length ? null : indices;
}

/**
 * Pure function. Rank a list of items by rpFuzzyScore against a key read off each
 * one, BEST FIRST, dropping the non-matches. The one place the
 * score/filter/sort trio is written down, so two surfaces filtering the same kind
 * of list cannot disagree about what "vid" matches or which match wins.
 *
 * AN EMPTY QUERY IS NOT A FILTER: the list passes through in its incoming order,
 * so opening a search box never reshuffles what is already on screen. A query
 * matching nothing returns [] — the caller is expected to say "nothing matched",
 * because an empty result and an empty collection must never look the same.
 *
 * @param {T[]} items - anything with a rankable string on it
 * @param {string} query - the raw filter text (trimmed here)
 * @param {(item: T) => string} keyOf - the string to rank each item by
 * @returns {T[]} the matching items, lowest score (best) first
 * @template T
 *
 * @example
 * >>> rpFuzzyRank([{f: "clip.mp4"}, {f: "logo.png"}], "cmp4", (x) => x.f)
 * [{f: 'clip.mp4'}]
 * @example // an empty query keeps the incoming order, unfiltered:
 * >>> rpFuzzyRank([{f: "b"}, {f: "a"}], "  ", (x) => x.f).map((x) => x.f)
 * ['b', 'a']
 * @example
 * >>> rpFuzzyRank([{f: "logo.png"}], "zzz", (x) => x.f)
 * []
 */
export function rpFuzzyRank(items, query, keyOf) {
  const list = items ?? [];
  const q = String(query ?? "").trim();
  if (q === "") return list;
  return list
    .map((item) => ({ item, score: rpFuzzyScore(q, keyOf(item) ?? "") }))
    .filter((r) => r.score !== null)
    .sort((x, y) => x.score - y.score) // LOWER is better (this module's convention)
    .map((r) => r.item);
}
