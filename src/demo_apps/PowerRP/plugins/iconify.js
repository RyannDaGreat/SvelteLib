/**
 * Iconify Icon — the WHOLE Iconify catalog (200k+ icons, every major set) as a
 * first-class vector widget. A thin specialization built ON the SVG widget's
 * capability WITHOUT importing it (the cursor-widget pattern, verbatim): state
 * stores only an ICON ID ("prefix:name", e.g. "tabler:database"); the icon's
 * SVG text is loaded from the Iconify API URL through the SAME
 * svg_source_registry the url-mode svg widget uses, and flattened through the
 * SAME svgToIRWithWarnings — so the SVG pipeline keeps ONE home and this file
 * is a thin curated-picker (id → url → shared flatten).
 *
 * ── WHY URLS AND NOT BUNDLED SETS ─────────────────────────────────────────────
 * The user ruling: "it loads via urls so we search thru all of iconify."
 * Bundling even one full icon set would be megabytes and always incomplete;
 * the API serves any icon of any set as a tiny SVG, and svg_source_registry
 * caches each one forever (bounded by the document's distinct icons). The
 * trade is honest: rendering an iconify widget needs NETWORK the first time
 * (like an image widget with a remote src). The bare-node cli/render.js
 * cannot fetch (its registry reads /asset/ urls off disk only) — an iconify
 * icon there draws the red error affordance and the render REPORTS it; the
 * real renderers (editor, presenter, cli/render_job.js's headless Chrome)
 * fetch it like any asset. A deck that must render fully offline should drop
 * the icon's .svg into project assets and use the svg widget's url mode
 * instead — this widget is the browse-everything convenience.
 *
 * ── THE CANVAS-TOOLBAR SEARCH PALETTE ─────────────────────────────────────────
 * Double-click opens the floating canvas toolbar (activate: "overlay_palette",
 * the cursor precedent) with a SEARCH BAR on top of a scrollable icon grid
 * (PALETTE_COLS wide): `floatingToolbar()` returns the standard `grid` spec
 * plus a `search` provider — CanvasToolbar owns the debounce and swaps the
 * grid's cells for each query's results (hover previews, click commits, the
 * same preview→commit seam as every palette). An EMPTY query shows a curated
 * starter set (DEFAULT_PALETTE) so the grid is never blank. Each result cell's
 * thumbnail is the icon's real SVG text, fetched through svg_source_registry
 * (cached, deduped, loud on failure). The palette writes `icon` — the one property
 * emit() reads for its url — so a pick lands on the canvas; nothing here writes a
 * colour, which is what the two colour rows below are for.
 *
 * ── WHY A FRESH ICON IS BLACK, AND THE TWO ROWS THAT DECIDE ITS COLOUR ────────
 * The mono sets are authored with `currentColor`: `tabler:star` is literally
 * `fill="none" stroke="currentColor"`. So its colour is not in the icon at all — it
 * is whatever the host says currentColor is, and here that is the INK row, which
 * defaults to #000000. That is the whole mechanism behind "it's just always black".
 * Ink WORKS (setting it recolours the icon), but it is a plain solid and it reaches
 * only currentColor parts, so it cannot touch a full-colour set like `logos:*`.
 * The FILL row (a full PAINT row — solid / gradient / material / equation,
 * keyframable, DEFAULT OFF) is the general answer: on, every path takes that one
 * paint for its fill AND stroke, like a stencil, so ANY icon tints — including a
 * multi-colour one. Off, the icon keeps its own paints and ink still governs
 * currentColor, i.e. exactly the prior behaviour. Both rows and the shared help
 * strings live in render_gpu/gpu/svg_raster.js, spread by this plugin AND the svg
 * widget (no plugin imports another).
 *
 * ── SEARCHING BY SET, AND WHY PLAIN /search CANNOT ────────────────────────────
 * The user's report: "I searched pixelhead because I saw one of the icons was
 * called pixelhead.pixel-plane, but it's not letting me search by the left half
 * of the colon. I should be able to fuzzy search both sides of it."
 *
 * The icon was `pinhead:pixel-plane`, and the API is the reason both halves of
 * that failed. Iconify's `/search` indexes icon NAMES and set KEYWORDS only — it
 * does not match a set prefix at all. Measured: `?query=pixelhead` → total 0
 * (expected, it is a misremembering), but `?query=pinhead` → total 0 TOO, even
 * though the set exists and has 2435 icons. A user who reads a set prefix off a
 * label and types it therefore gets a blank grid, which reads as "the search is
 * broken" rather than "that word is not in any icon's name".
 *
 * The route that DOES work is the prefix filter: `?query=plane&prefixes=pinhead`
 * returns `pinhead:pixel-plane` and friends. So the fix is not a better query
 * string — it is knowing which SETS exist, which `/collections` answers (~231
 * sets: `{prefix: {name: "Pinhead Map Icons", total, …}}`, fetched once and
 * memoized per session). With that catalog in hand a query is fuzzy-matched
 * against every set's PREFIX and its human NAME through core/fuzzy.js — the
 * app's ONE fuzzy engine, the same rp completion ranker behind the palette, the
 * equation suggester and the Asset Explorer's filter. "pixelhead" is a
 * subsequence of neither "pinhead" nor "Pinhead Map Icons"… but it IS a
 * subsequence of the CONCATENATION the matcher actually scores, and more to the
 * point the user's real recovery is typing "pinhead", which now works.
 *
 * ── THE THREE SOURCES, AND HOW THEY MERGE ────────────────────────────────────
 * One search composes up to three result streams, in this rank order:
 *   1. PLAIN /search — the unchanged existing behaviour, and deliberately still
 *      first. "pixel-plane" must keep winning through the name index; a set
 *      match must never bury an exact name hit under a whole-set dump.
 *   2. PREFIX-FILTERED /search — for each well-matching set, `?query=<residual>
 *      &prefixes=<set>`. This is what makes "pinhead plane" work.
 *   3. THE COLLECTION LISTING — `/collection?prefix=<set>` (every icon name in
 *      the set), fuzzy-ranked CLIENT-SIDE. This is the only source that can
 *      answer a bare set name with no residual query ("pinhead" alone → that
 *      set's icons), and it is also the fallback when the residual query is a
 *      fuzzy-but-not-substring match that the API's own index would miss.
 * `mergeRankedCells` interleaves them by (source rank, per-source rank) and
 * dedupes by icon id, so each source contributes its best before any contributes
 * its second-best — the cap (SEARCH_LIMIT) then never lets one source starve the
 * others. All of that ordering logic is PURE and doctested; the fetches are thin
 * seams around it.
 *
 * ── COLON AND DOT SYNTAX ─────────────────────────────────────────────────────
 * A query containing ":" or "." splits into a SET filter (left) and a NAME query
 * (right), both fuzzy. The dot is there because the user typed
 * "pixelhead.pixel-plane" — they had read an id off a label and retyped it with
 * the wrong separator, and both spellings must work. Empty right side = the
 * whole set.
 *
 * A failed /collections fetch degrades to plain search and says so through
 * console.warn — never a silent narrowing of results.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, customProps, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { decorateStrokedBox } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { errorAffordance, warningAffordance } from "../render_gpu/affordances.js";
import { svgToIRWithWarnings, SVG_FILL_ROW, SVG_FILL_OFF, SVG_INK_HELP, svgOverridePaint } from "../render_gpu/gpu/svg_raster.js";
import { ensureSvgSource, getSvgSource, svgSourceStatus, svgSourceError } from "../render_gpu/gpu/svg_source_registry.js";
import { rpFuzzyScore } from "../core/fuzzy.js";

/** The Iconify API host — icon SVGs (`/<prefix>/<name>.svg`) and the search
 * endpoint (`/search?query=`) both live here. */
const ICONIFY_API = "https://api.iconify.design";

/** How many results one palette search asks for — 2 columns beyond a full
 * 5-row screen of PALETTE_COLS, so scrolling is obviously available without
 * fetching a whole set. */
const SEARCH_LIMIT = 50;

/** The palette grid's column count — the user spec: a 5-wide scrollable
 * palette under the search bar. */
const PALETTE_COLS = 5;

/** How many SETS one query may expand into. A short query fuzzy-matches many of
 * the ~231 sets (every set containing those letters in order), and each match
 * costs a request; two is enough for the "I typed a set name" case while keeping
 * a search to a handful of round trips. */
const MAX_MATCHED_SETS = 2;

/** The worst rpFuzzyScore a set match may have and still be believed. Scores are
 * "lower is better" and a case-insensitive PREFIX match is divided by 1000, so
 * anything under 1 is essentially "the query is a prefix of, or an early
 * subsequence in, this set's prefix or name". Above it the match is an accident
 * of letters scattered through a long title, and expanding a whole set on that
 * evidence would bury the plain-search hits the user actually asked for. */
const SET_MATCH_MAX_SCORE = 1.0;

/**
 * Pure function. Splits a palette query into a SET filter and a NAME query on
 * the first ":" or ".", per the docblock's colon/dot syntax. No separator means
 * the whole query is the name query and there is no explicit set filter.
 *
 * The dot is accepted because the user retyped an id they had read off a label
 * ("pixelhead.pixel-plane") — the separator they remembered wrong must not be
 * the thing that fails. Both halves are trimmed; either may end up empty
 * ("pinhead:" = the whole set, ":plane" = no set filter).
 *
 * Args:
 *   query (string): the raw query as typed
 *
 * Returns:
 *   {setQuery: string, nameQuery: string, explicitSet: boolean}
 *
 * @example splitIconQuery("pixelhead.pixel-plane") // {setQuery: "pixelhead", nameQuery: "pixel-plane", explicitSet: true}
 * @example splitIconQuery("pinhead:plane") // {setQuery: "pinhead", nameQuery: "plane", explicitSet: true}
 * @example splitIconQuery("pinhead:") // {setQuery: "pinhead", nameQuery: "", explicitSet: true}
 * @example splitIconQuery("robot") // {setQuery: "", nameQuery: "robot", explicitSet: false}
 */
export function splitIconQuery(query) {
  const q = (query ?? "").trim();
  const at = q.search(/[:.]/);
  if (at < 0) return { setQuery: "", nameQuery: q, explicitSet: false };
  return { setQuery: q.slice(0, at).trim(), nameQuery: q.slice(at + 1).trim(), explicitSet: true };
}

/**
 * Pure function. Fuzzy-ranks an Iconify collections catalog against a set query,
 * best first, keeping only believable matches (see SET_MATCH_MAX_SCORE).
 *
 * A set is scored against three candidate strings and keeps its BEST: its
 * PREFIX ("pinhead"), its human NAME ("Pinhead Map Icons"), and the two joined
 * ("pinhead Pinhead Map Icons" — for queries that straddle the halves, like
 * "pinhead map").
 *
 * WHAT THIS DOES NOT DO, stated because the bug report invites the opposite
 * assumption: it does NOT fix the user's literal typo. rpFuzzyScore is a
 * SUBSEQUENCE matcher, and "pixelhead" is not a subsequence of "pinhead" (the
 * 'x' has nothing to match) — measured against the live 231-set catalog, the
 * best it can do is the genuinely pixel-themed sets (pixelarticons, pixel,
 * streamline-pixel), never pinhead. No subsequence scorer can bridge an inserted
 * character, and adding an edit-distance scorer alongside the app's one fuzzy
 * engine was explicitly out of scope. What rescues the user's typed string is
 * the OTHER half of the fix — splitIconQuery drops "pixelhead" as the set filter
 * and sends "pixel-plane" to plain search, which returns pinhead:pixel-plane.
 * A set filter that matches nothing is a no-op, not an error, precisely so that
 * fallback works.
 *
 * Args:
 *   catalog (object): the /collections payload, {prefix: {name, total, …}}
 *   setQuery (string): the fuzzy set query
 *
 * Returns:
 *   Array<{prefix: string, name: string, score: number}> — best (lowest) first
 *
 * @example // The user's case: the set catalog knows "pinhead" even though /search does not.
 * @example matchIconSets({pinhead: {name: "Pinhead Map Icons"}, mdi: {name: "Material Design Icons"}}, "pinhead").map((m) => m.prefix) // ["pinhead"]
 * @example matchIconSets({pinhead: {name: "Pinhead Map Icons"}, mdi: {name: "Material Design Icons"}}, "material").map((m) => m.prefix) // ["mdi"]
 * @example matchIconSets({pinhead: {name: "Pinhead Map Icons"}}, "zzz") // []
 * @example matchIconSets({}, "pinhead") // []
 */
export function matchIconSets(catalog, setQuery) {
  const q = (setQuery ?? "").trim();
  if (!q) return [];
  const scored = [];
  for (const [prefix, info] of Object.entries(catalog ?? {})) {
    const name = String(info?.name ?? prefix);
    const candidates = [prefix, name, `${prefix} ${name}`];
    const scores = candidates.map((c) => rpFuzzyScore(q, c)).filter((s) => s !== null);
    if (!scores.length) continue;
    const score = Math.min(...scores);
    if (score <= SET_MATCH_MAX_SCORE) scored.push({ prefix, name, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.prefix.localeCompare(b.prefix));
}

/**
 * Pure function. Fuzzy-ranks a set's icon NAMES against a query, best first,
 * returning full "prefix:name" ids capped at `limit`.
 *
 * This is source 3 of the merge — the client-side ranking of a whole
 * /collection listing. An EMPTY query keeps the set's own listing order (its
 * icons as authored), which is what makes a bare set name ("pinhead") show that
 * set's icons rather than nothing.
 *
 * Args:
 *   prefix (string): the set prefix, e.g. "pinhead"
 *   names (string[]): every icon name in the set
 *   nameQuery (string): the fuzzy name query ("" = the whole set, in order)
 *   limit (number): maximum ids returned
 *
 * Returns:
 *   string[] — icon ids, best match first
 *
 * @example rankSetIcons("pinhead", ["plane-up", "pixel-plane", "bird"], "pixel", 5) // ["pinhead:pixel-plane"]
 * @example rankSetIcons("pinhead", ["plane-up", "pixel-plane", "bird"], "plane", 5) // ["pinhead:plane-up", "pinhead:pixel-plane"]
 * @example rankSetIcons("pinhead", ["a-frame-tent", "bird"], "", 2) // ["pinhead:a-frame-tent", "pinhead:bird"]
 * @example rankSetIcons("pinhead", ["bird"], "zzz", 5) // []
 */
export function rankSetIcons(prefix, names, nameQuery, limit) {
  const q = (nameQuery ?? "").trim();
  const all = names ?? [];
  if (!q) return all.slice(0, limit).map((n) => `${prefix}:${n}`);
  return all
    .map((name) => ({ name, score: rpFuzzyScore(q, name) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((r) => `${prefix}:${r.name}`);
}

/**
 * Pure function. Merges the search's ranked id lists into ONE capped list,
 * deduped by id, INTERLEAVING the sources so each contributes its best result
 * before any contributes its second.
 *
 * Sources arrive in priority order (plain /search, then prefix-filtered
 * /search, then collection listings). Interleaving rather than concatenating is
 * the whole point: concatenation lets a 50-icon whole-set dump consume the cap
 * and starve the exact name hit the user typed, while a pure priority sort would
 * let plain search starve the set expansion that is this fix's reason to exist.
 * A tie inside one round is broken by source priority, so an exact name hit from
 * plain search still leads the list.
 *
 * Args:
 *   sources (string[][]): ranked id lists, highest-priority source first
 *   limit (number): maximum ids returned
 *
 * Returns:
 *   string[] — deduped ids
 *
 * @example mergeRankedCells([["a:1", "a:2"], ["b:1", "b:2"]], 3) // ["a:1", "b:1", "a:2"]
 * @example mergeRankedCells([["a:1", "b:1"], ["b:1", "b:2"]], 4) // ["a:1", "b:1", "b:2"] — "b:1" deduped, not repeated
 * @example mergeRankedCells([[], ["b:1"]], 5) // ["b:1"]
 * @example mergeRankedCells([["a:1", "a:2", "a:3"]], 2) // ["a:1", "a:2"]
 */
export function mergeRankedCells(sources, limit) {
  const lists = (sources ?? []).filter(Boolean);
  const out = [];
  const seen = new Set();
  const deepest = Math.max(0, ...lists.map((l) => l.length));
  for (let round = 0; round < deepest && out.length < limit; round += 1) {
    for (const list of lists) {
      if (out.length >= limit) break;
      const id = list[round];
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Ink for `currentColor` icons (most mono sets: tabler, mdi, lucide…) — the
 * shared INK convention (#000000). Full-color sets (logos, twemoji…) carry
 * explicit colors and ignore it. */
const ICONIFY_INK = "#000000";

/** A freshly added widget's icon — instantly recognizable, obviously an icon. */
const DEFAULT_ICON = "tabler:star";

/** The curated starter palette an EMPTY search shows (the grid must never be
 * blank). One row per theme: symbols, arrows, media, objects, tech. */
const DEFAULT_PALETTE = [
  "tabler:star", "tabler:heart", "tabler:check", "tabler:x", "tabler:alert-triangle",
  "tabler:arrow-right", "tabler:arrow-left", "tabler:arrow-up", "tabler:arrow-down", "tabler:refresh",
  "tabler:photo", "tabler:movie", "tabler:music", "tabler:video", "tabler:camera",
  "tabler:home", "tabler:user", "tabler:settings", "tabler:search", "tabler:folder",
  "tabler:database", "tabler:cpu", "tabler:cloud", "tabler:rocket", "tabler:bulb",
];

/**
 * Pure function. An Iconify icon id ("prefix:name") → the API URL serving its
 * SVG. Throws on anything that is not exactly `prefix:name` — a malformed id
 * must fail loudly at the seam, not 404 mysteriously later.
 *
 * Args:
 *   icon (string): the icon id, e.g. "tabler:database"
 *
 * Returns:
 *   string: the SVG URL
 *
 * @example iconifyIconUrl("tabler:database") // "https://api.iconify.design/tabler/database.svg"
 * @example iconifyIconUrl("mdi:robot-industrial-outline") // "https://api.iconify.design/mdi/robot-industrial-outline.svg"
 */
export function iconifyIconUrl(icon) {
  const m = typeof icon === "string" && icon.match(/^([a-z0-9-]+):([a-z0-9-]+)$/);
  if (!m) throw new Error(`iconifyIconUrl: expected "prefix:name" (lowercase, dashes), got ${JSON.stringify(icon)}`);
  return `${ICONIFY_API}/${m[1]}/${m[2]}.svg`;
}

/** The memoized /collections catalog — ONE fetch per session (the payload is
 * ~231 sets and never changes mid-session). Holds the in-flight PROMISE, so N
 * keystrokes racing during the first search share one request. Null after a
 * failure, so a later search may retry. */
let collectionsPromise = null;

/**
 * Query (async; network, memoized). The Iconify collections catalog,
 * {prefix: {name, total, …}}. Fetched at most once per session.
 *
 * A failure DEGRADES to `{}` — an empty catalog matches no set, so the search
 * falls back to exactly the plain-search behaviour that predates this feature
 * — but says so through console.warn. It is deliberately not a throw: losing
 * the set-name feature must not take the working icon-name search down with it.
 * It is equally deliberately not silent, per the repo's no-silent-fallback rule.
 *
 * @example // await fetchIconCollections() // {mdi: {name: "Material Design Icons", total: 7447, …}, pinhead: {name: "Pinhead Map Icons", …}, …}
 */
export async function fetchIconCollections() {
  if (!collectionsPromise) {
    collectionsPromise = (async () => {
      const res = await fetch(`${ICONIFY_API}/collections`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    })().catch((e) => {
      console.warn(`PowerRP iconify: collections catalog unavailable (${e instanceof Error ? e.message : e}) — search by SET NAME is disabled this session; icon-name search still works.`);
      collectionsPromise = null; // a later search may retry
      return {};
    });
  }
  return collectionsPromise;
}

/** Command (async; network). Icon ids from the plain/prefix-filtered search
 * endpoint. `prefixes` empty = the plain search. Returns [] rather than throwing
 * for a prefix-filtered miss is NOT done here — every failure is loud; the
 * CALLER decides which streams are optional. */
async function fetchSearchIds(query, prefixes, limit) {
  const p = prefixes ? `&prefixes=${encodeURIComponent(prefixes)}` : "";
  const res = await fetch(`${ICONIFY_API}/search?query=${encodeURIComponent(query)}&limit=${limit}${p}`);
  if (!res.ok) throw new Error(`Iconify search failed: HTTP ${res.status} ${res.statusText}`);
  return (await res.json()).icons ?? [];
}

/** Command (async; network). Every icon name in one set, from /collection. The
 * payload splits names across `uncategorized` and a `categories` map; this
 * flattens both (and ignores `hidden`, which are deprecated aliases the palette
 * should not offer). */
async function fetchCollectionNames(prefix) {
  const res = await fetch(`${ICONIFY_API}/collection?prefix=${encodeURIComponent(prefix)}`);
  if (!res.ok) throw new Error(`Iconify collection failed: HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  return [...(data.uncategorized ?? []), ...Object.values(data.categories ?? {}).flat()];
}

/**
 * Command (async; network). One palette search, composing the three sources the
 * docblock describes: plain /search, prefix-filtered /search for each
 * fuzzy-matched set, and a client-side ranking of a matched set's full
 * /collection listing. Ids are merged by `mergeRankedCells` (interleaved,
 * deduped, capped at SEARCH_LIMIT), then each gets its SVG text through
 * svg_source_registry (cached across searches; a failed icon fetch was reported
 * loudly by the registry and its cell is dropped).
 *
 * An EMPTY/whitespace query returns the curated DEFAULT_PALETTE without touching
 * the API. Returns CanvasToolbar grid cells: [{value, label, svg}].
 *
 * The SET streams are best-effort: a failed prefix-filtered search or collection
 * listing warns and contributes nothing, because plain search's results are
 * still worth showing. Plain search itself still THROWS — that is the toolbar's
 * "the search is down" path, and it predates this change.
 *
 * @example // await searchIconifyCells("robot")                // plain search: [{value: "material-symbols:robot", …}, …]
 * @example // await searchIconifyCells("pinhead")              // a bare SET NAME: that set's listing — pinhead:a, pinhead:a-frame-sidewall-tent, …
 * @example // await searchIconifyCells("pinhead:plane")         // set-filtered: pinhead:plane-up rank 2, pinhead:pixel-plane rank 4
 * @example // await searchIconifyCells("pixelhead.pixel-plane") // the user's typo: the set filter misses, "pixel-plane" finds pinhead:pixel-plane (rank 3)
 */
export async function searchIconifyCells(query) {
  const raw = (query ?? "").trim();
  let ids;
  if (!raw) {
    ids = DEFAULT_PALETTE;
  } else {
    const { setQuery, nameQuery, explicitSet } = splitIconQuery(raw);
    // Source 1 — plain search, on the WHOLE query when no separator was typed
    // (so "pixel-plane" keeps hitting the name index exactly as before), or on
    // the name half when one was.
    const plainQuery = explicitSet ? nameQuery : raw;
    const plain = plainQuery ? await fetchSearchIds(plainQuery, "", SEARCH_LIMIT) : [];

    // Sources 2 and 3 — the sets whose prefix/name fuzzy-matches. Without a
    // separator the whole query doubles as the set query, which is what makes a
    // bare "pinhead" work.
    const catalog = await fetchIconCollections();
    const sets = matchIconSets(catalog, explicitSet ? setQuery : raw).slice(0, MAX_MATCHED_SETS);
    // The RESIDUAL query — what to look for INSIDE a matched set. Only an
    // explicit separator produces one: for a bare "pinhead" the query names the
    // SET, not an icon in it, so searching the set for "pinhead" finds nothing
    // (no pinhead icon is called that) and the headline case would come back
    // empty. That was a real bug in this fix's first draft, caught by the live
    // check; the whole-set listing is the ONLY correct source here.
    const residual = explicitSet ? nameQuery : "";
    const setStreams = await Promise.all(sets.map(async (set) => {
      try {
        // With a residual name query the API's own index is the better ranker
        // and far cheaper than pulling a whole set; without one, only the
        // listing can answer "show me this set".
        if (residual) return await fetchSearchIds(residual, set.prefix, SEARCH_LIMIT);
        return rankSetIcons(set.prefix, await fetchCollectionNames(set.prefix), "", SEARCH_LIMIT);
      } catch (e) {
        console.warn(`PowerRP iconify: set "${set.prefix}" contributed no results (${e instanceof Error ? e.message : e}); showing name-search results only.`);
        return [];
      }
    }));
    ids = mergeRankedCells([plain, ...setStreams], SEARCH_LIMIT);
  }
  const cells = await Promise.all(ids.map(async (id) => {
    const svg = await ensureSvgSource(iconifyIconUrl(id)); // resolves null on a (loudly reported) failure
    return svg ? { value: id, label: id, svg } : null;
  }));
  return cells.filter(Boolean);
}

// The icon id — the ONE piece of iconify-specific document state. A text row
// round-trips it; the floating-toolbar search palette is the real picker.
const CUSTOM = customProps([
  {
    name: "icon",
    kind: "text",
    default: DEFAULT_ICON,
    label: "Icon",
    category: "formatting",
    help: 'The Iconify icon id, "set:name" — e.g. "tabler:database" or "logos:openai-icon". Double-click the widget for a searchable palette over the whole Iconify catalog. Loaded from api.iconify.design, so first render needs network; use an SVG widget with a project asset for fully-offline decks.',
  },
]);

export const iconifyPlugin = {
  type: "iconify",
  title: "Iconify Icon",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // Double-click mounts the canvas-overlay palette (the cursor precedent);
  // floatingToolbar() below is its content — search bar + icon grid.
  activate: "overlay_palette",
  defaults: {
    type: "iconify", x: 140, y: 140, w: 96, h: 96, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    preserveAspect: true, // an icon must keep its shape — uniform scale-to-fit
    ink: ICONIFY_INK, // currentColor resolution for the mono sets
    // FILL — the whole-icon recolour override, default OFF (the SAME declaration and
    // the SAME default the svg widget uses; see the docblock's colouring section).
    fill: SVG_FILL_OFF,
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth:0, cornerRadius:0, opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    ...CUSTOM.defaults, // icon
  },
  inspector: [
    ...bundle("positioning"),
    ...CUSTOM.rows, // the icon id
    // INK — the currentColor resolution. Help SHARED with the svg widget, because it
    // is the same system and the pair only makes sense read together (see docblock).
    { key: "ink", label: "Color", kind: "color", category: "formatting", help: SVG_INK_HELP },
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Scale the icon uniformly to fit the box (keeps its shape). Off stretches it to the box's exact width and height." },
    // THE FILL OVERRIDE — the very same shared row declaration the svg widget mounts,
    // default OFF. This is what "iconify inherits the row" means concretely: one
    // declaration, spread by both plugins, so the two can never disagree about the
    // property name, its category, its off semantics or its help text.
    SVG_FILL_ROW,
    ...bundle("strokedBorder"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (the RETURNED IR is a pure function of state + the
   * source registry's cache; emit kicks an idempotent load as a side effect).
   * State → display-list commands (local space): icon id → API URL →
   * svg_source_registry text → the SHARED flatten. In flight → nothing this
   * frame (onSvgSourceLoad repaints — the url-mode svg contract). Failed →
   * the loud red error affordance naming the icon. Flatten warnings keep the
   * art and gain the amber band, exactly like the svg widget.
   */
  emit(s, _targetWorldIR, world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    if (!s.icon) return []; // GHOST — no icon authored
    const style = { x: 0, y: 0, w, h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const finish = (ops) => applyEffects(decorateStrokedBox(ops, style, world), s, world, { x: 0, y: 0, w, h });
    let url;
    try {
      url = iconifyIconUrl(s.icon);
    } catch (e) {
      return finish(errorAffordance(w, h, e instanceof Error ? e.message : String(e)));
    }
    let src = getSvgSource(url);
    if (src === null) {
      ensureSvgSource(url); // idempotent kick (sync-resolving in bare node, where it fails loudly for non-asset urls)
      src = getSvgSource(url);
    }
    if (src === null) {
      if (svgSourceStatus(url) === "error")
        return finish(errorAffordance(w, h, `failed to load icon "${s.icon}": ${svgSourceError(url)}`));
      return []; // in flight — a repaint follows the load
    }
    let ops;
    try {
      // `overridePaint` is the Fill row — OFF → null → byte-identical to before it
      // existed (the shared svgOverridePaint is the one place OFF becomes "no
      // override", so both SVG-family widgets agree by construction).
      const flat = svgToIRWithWarnings(src, w, h, { ink: s.ink ?? ICONIFY_INK, preserveAspect: s.preserveAspect !== false, opacity: s.opacity ?? 1, overridePaint: svgOverridePaint(s) });
      ops = flat.warnings.length ? [...flat.ops, ...warningAffordance(w, h, flat.warnings)] : flat.ops;
    } catch (e) {
      ops = errorAffordance(w, h, e instanceof Error ? e.message : String(e));
    }
    return finish(ops);
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  /**
   * Pure function (a spec; the CELLS arrive asynchronously through `search.run`).
   * The declarative floating-toolbar content: the standard `grid` picker over
   * `icon`, plus a `search` provider — CanvasToolbar renders the search bar,
   * debounces input, and swaps the grid's cells for each query's results
   * (empty query → the curated starter palette). `cols` narrows the grid to
   * the user-spec 5-wide scrollable palette. `labelKind: "id"` says each cell's
   * label is an IDENTIFIER ("tabler:star") and not prose, so the toolbar renders
   * the hover tip in the app's identifier font (--a-mono) rather than the UI font
   * — the same voice as an equation or a variable name. The cursor palette, whose
   * labels are human titles ("Spinning"), omits it and gets the UI font.
   */
  floatingToolbar(state) {
    return {
      label: "Iconify icons",
      grid: { property: "icon", value: state.icon ?? DEFAULT_ICON, cells: [], cols: PALETTE_COLS, labelKind: "id" },
      search: { placeholder: "Search all of Iconify…", run: searchIconifyCells },
    };
  },
  commands: [
    { id: "add-iconify", title: "Add Iconify Icon", icon: "simple-icons:iconify", run: (app) => app.armCrosshairPlacement(iconifyPlugin) },
  ],
};
