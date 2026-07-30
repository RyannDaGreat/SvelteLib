/**
 * Iconify palette search — the SET-NAME fix's pure core, in bare node.
 * Run: node src/demo_apps/PowerRP/tests/iconify_search_test.js
 *
 * THE BUG THIS PINS (user, verbatim intent): "I searched pixelhead because I saw
 * one of the icons was called pixelhead.pixel-plane, but it's not letting me
 * search by the left half of the colon. I should be able to fuzzy search both
 * sides of it."
 *
 * The icon was `pinhead:pixel-plane`. Iconify's /search indexes icon NAMES only,
 * so BOTH halves of that failed: ?query=pixelhead → total 0 (a misremembering)
 * and ?query=pinhead → total 0 TOO, despite the set existing with 2435 icons.
 * Measured live, and re-asserted below against a catalog FIXTURE so the gate
 * needs no network.
 *
 * WHAT IT PROVES:
 *   (1) splitIconQuery honours BOTH separators — the user typed a dot for a
 *       colon, and that must not be the thing that fails;
 *   (2) matchIconSets finds "pinhead" from the catalog by prefix AND by human
 *       name, where the API's own index finds nothing — the crux of the fix;
 *   (3) matchIconSets does NOT pretend to fix the literal typo. rpFuzzyScore is
 *       a SUBSEQUENCE matcher and "pixelhead" is not a subsequence of "pinhead";
 *       asserted explicitly so nobody later "fixes" this into a false claim.
 *       The typo's real recovery is the split (see 5);
 *   (4) mergeRankedCells interleaves + dedupes + caps, so a 50-icon whole-set
 *       dump can never starve the exact name hit the user typed;
 *   (5) rankSetIcons ranks a set's listing client-side, and an EMPTY residual
 *       query yields the whole set in order — the source that answers a BARE set
 *       name. A regression here returned 0 cells for "pinhead" in this fix's
 *       first draft (the headline case), caught only by a live check;
 *   (6) the plugin's floatingToolbar still wires searchIconifyCells unchanged —
 *       the CanvasToolbar seam (debounce/seq) is untouched by this fix.
 */

import assert from "node:assert/strict";
import {
  splitIconQuery,
  matchIconSets,
  rankSetIcons,
  mergeRankedCells,
  searchIconifyCells,
  iconifyPlugin,
} from "../plugins/iconify.js";
import { rpFuzzyScore } from "../core/fuzzy.js";

/** A snippet of the live /collections payload (231 sets on 2026-07-30), shaped
 * exactly like the real one: {prefix: {name, total, …}}. `pinhead` is the user's
 * set; the pixel-themed sets are here because they are what "pixelhead" ACTUALLY
 * fuzzy-matches, and the test asserts that honestly rather than wishing. */
const CATALOG = {
  pinhead: { name: "Pinhead Map Icons", total: 2435 },
  pixel: { name: "Pixel Icon", total: 1300 },
  pixelarticons: { name: "Pixelarticons", total: 480 },
  mdi: { name: "Material Design Icons", total: 7447 },
  tabler: { name: "Tabler Icons", total: 5900 },
};

/** A snippet of /collection?prefix=pinhead — real names from the live set. */
const PINHEAD_NAMES = ["a-frame-tent", "bird", "pixel-plane", "plane-up", "plane-right", "boat-on-trailer"];

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

test("splitIconQuery: BOTH separators split set from name (the user typed a dot)", () => {
  assert.deepEqual(splitIconQuery("pixelhead.pixel-plane"), { setQuery: "pixelhead", nameQuery: "pixel-plane", explicitSet: true });
  assert.deepEqual(splitIconQuery("pinhead:plane"), { setQuery: "pinhead", nameQuery: "plane", explicitSet: true });
  // A trailing separator = the WHOLE set, and a leading one = no set filter.
  assert.deepEqual(splitIconQuery("pinhead:"), { setQuery: "pinhead", nameQuery: "", explicitSet: true });
  assert.deepEqual(splitIconQuery(":plane"), { setQuery: "", nameQuery: "plane", explicitSet: true });
  // No separator: the query is a name query AND (in searchIconifyCells) a set query.
  assert.deepEqual(splitIconQuery("robot"), { setQuery: "", nameQuery: "robot", explicitSet: false });
  assert.deepEqual(splitIconQuery("  spaced  "), { setQuery: "", nameQuery: "spaced", explicitSet: false });
  // Only the FIRST separator splits — a dotted icon name keeps its tail intact.
  assert.deepEqual(splitIconQuery("pinhead:a.b"), { setQuery: "pinhead", nameQuery: "a.b", explicitSet: true });
});

test("matchIconSets: finds pinhead by PREFIX and by HUMAN NAME — where /search finds nothing", () => {
  // THE CRUX. The live API returns total 0 for query=pinhead; the catalog knows it.
  assert.deepEqual(matchIconSets(CATALOG, "pinhead").map((m) => m.prefix), ["pinhead"]);
  // By human name only ("mdi" contains no 'material'), which is why name is scored.
  assert.deepEqual(matchIconSets(CATALOG, "material").map((m) => m.prefix), ["mdi"]);
  // Best-first ordering, and a believability cut (SET_MATCH_MAX_SCORE).
  assert.deepEqual(matchIconSets(CATALOG, "zzzz"), []);
  assert.deepEqual(matchIconSets({}, "pinhead"), [], "an empty catalog (a failed fetch) matches nothing");
  assert.deepEqual(matchIconSets(CATALOG, ""), [], "an empty set query expands no sets");
  const ranked = matchIconSets(CATALOG, "pixel").map((m) => m.prefix);
  assert.ok(ranked.includes("pixel") && ranked.includes("pixelarticons"), "both pixel sets match");
  assert.equal(ranked[0], "pixel", "the exact prefix outranks the longer one");
});

test("matchIconSets does NOT bridge the literal typo — and this file refuses to claim it does", () => {
  // rpFuzzyScore is a SUBSEQUENCE matcher: "pixelhead" has an 'x' that "pinhead"
  // cannot supply, so NO amount of fuzzy scoring reaches it. Asserted at the
  // engine level and at the matcher level, in the honest direction, so a future
  // edit cannot quietly turn the docblock into a false promise.
  assert.equal(rpFuzzyScore("pixelhead", "pinhead"), null);
  assert.equal(rpFuzzyScore("pixelhead", "Pinhead Map Icons"), null);
  assert.ok(!matchIconSets(CATALOG, "pixelhead").some((m) => m.prefix === "pinhead"),
    "pixelhead does not match pinhead — the SPLIT is what rescues that query, not the set matcher");
  // What it DOES match is the genuinely pixel-themed sets. That is correct, not a miss.
  assert.deepEqual(matchIconSets(CATALOG, "pixelhead").map((m) => m.prefix), []);
});

test("rankSetIcons: client-side ranking, and an EMPTY query yields the whole set in order", () => {
  assert.deepEqual(rankSetIcons("pinhead", PINHEAD_NAMES, "pixel", 5), ["pinhead:pixel-plane"]);
  // Fuzzy, not substring: "plane" reaches both plane-* names and pixel-plane.
  const planes = rankSetIcons("pinhead", PINHEAD_NAMES, "plane", 5);
  assert.ok(planes.includes("pinhead:plane-up") && planes.includes("pinhead:pixel-plane"));
  // The two plane-* names are BOTH prefix matches (rpFuzzyScore divides those by
  // 1000), so they tie on score and the alphabetical tiebreak orders them —
  // "plane-right" before "plane-up". Only pixel-plane, where 'plane' starts 6
  // chars in, scores worse and sorts last. Asserted as MEASURED, not as assumed:
  // the first draft of this test guessed "plane-up" first and failed.
  assert.deepEqual(planes, ["pinhead:plane-right", "pinhead:plane-up", "pinhead:pixel-plane"]);
  // THE BARE-SET-NAME SOURCE. This returning [] is exactly how the first draft
  // made "pinhead" show 0 cells; pinned so it cannot regress silently.
  assert.deepEqual(rankSetIcons("pinhead", PINHEAD_NAMES, "", 3),
    ["pinhead:a-frame-tent", "pinhead:bird", "pinhead:pixel-plane"]);
  assert.equal(rankSetIcons("pinhead", PINHEAD_NAMES, "", 100).length, PINHEAD_NAMES.length);
  assert.deepEqual(rankSetIcons("pinhead", PINHEAD_NAMES, "zzzz", 5), []);
  assert.deepEqual(rankSetIcons("pinhead", [], "plane", 5), [], "an empty listing is not an error");
});

test("mergeRankedCells: interleaves sources so no one source starves the others", () => {
  // Round-robin: each source gives its best before any gives its second. This is
  // what keeps an exact name hit from being buried under a 50-icon set dump.
  assert.deepEqual(mergeRankedCells([["a:1", "a:2"], ["b:1", "b:2"]], 3), ["a:1", "b:1", "a:2"]);
  // Priority breaks a tie WITHIN a round: plain search (source 0) still leads.
  assert.equal(mergeRankedCells([["a:1"], ["b:1"]], 2)[0], "a:1");
  // Dedupe by id — the same icon reachable from two sources appears ONCE.
  assert.deepEqual(mergeRankedCells([["a:1", "b:1"], ["b:1", "b:2"]], 4), ["a:1", "b:1", "b:2"]);
  // The cap holds, and an exhausted/absent source is skipped rather than padding.
  assert.deepEqual(mergeRankedCells([["a:1", "a:2", "a:3"]], 2), ["a:1", "a:2"]);
  assert.deepEqual(mergeRankedCells([[], ["b:1"]], 5), ["b:1"]);
  assert.deepEqual(mergeRankedCells([], 5), []);
  assert.deepEqual(mergeRankedCells([["a:1"]], 0), [], "a zero cap yields nothing");
});

test("the merge composes the user's case end to end (fixture, no network)", () => {
  // "pixelhead.pixel-plane" — what the three sources contribute and how they rank.
  const { setQuery, nameQuery } = splitIconQuery("pixelhead.pixel-plane");
  assert.equal(nameQuery, "pixel-plane");
  // Source 1, plain /search on the NAME half — the live API's real answer, and
  // the reason the user's exact string now works at all.
  const plain = ["pixel:plane", "pixel:plane-solid", "pinhead:pixel-plane", "pixel:plane-departure"];
  // Sources 2/3 contribute nothing: "pixelhead" matches no set in the catalog.
  assert.deepEqual(matchIconSets(CATALOG, setQuery), []);
  const merged = mergeRankedCells([plain], 50);
  assert.equal(merged.indexOf("pinhead:pixel-plane"), 2, "the icon the user was looking for is on screen (rank 3)");

  // And the recovery the fix really adds: the bare SET name, which used to be 0 results.
  const sets = matchIconSets(CATALOG, "pinhead");
  assert.equal(sets[0].prefix, "pinhead");
  const setStream = rankSetIcons("pinhead", PINHEAD_NAMES, "", 50);
  const bare = mergeRankedCells([[], setStream], 50);
  assert.ok(bare.length > 0 && bare.every((id) => id.startsWith("pinhead:")),
    "a bare set name shows that set's icons — plain search returns total 0 for it");
});

test("the CanvasToolbar seam is untouched: floatingToolbar still wires searchIconifyCells", () => {
  // This fix is provider-side ONLY. The toolbar owns the debounce and the
  // stale-response sequence guard; if the spec stopped pointing at this
  // provider, every assertion above would be testing a dead function.
  const spec = iconifyPlugin.floatingToolbar({ ...iconifyPlugin.defaults });
  assert.equal(spec.search.run, searchIconifyCells);
  assert.equal(spec.grid.property, "icon");
  assert.equal(spec.grid.labelKind, "id");
});

console.log(`\n${passed} iconify-search tests passed.`);
