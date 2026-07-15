/**
 * Equation autocomplete — candidate discovery + ranking for the NumericField
 * text-entry path (manifest "EQUATION DISCOVERABILITY — Blender data-path
 * standard": typing `self.` or `<slug>.` must offer the item's ACTUAL
 * properties, "so no name is ever guessable-only"). DOM-free and decoupled
 * from any particular input widget (manifest DESIGN BOUND: the equation
 * language may grow into a multi-line "whole language type thing" later —
 * this module only knows about TEXT and CURSOR POSITION, never an <input>
 * element, so a future richer editor can reuse it unchanged).
 *
 * Two candidate modes, chosen by what's typed immediately before the cursor:
 *   - a dotted head ("self." or "<slug>.") → that item's numeric properties
 *     (numericPropertyPaths, core/expressions.js) — canonical snake_case,
 *     exactly what displayToStored accepts.
 *   - a bare identifier (no dot yet) → every item slug, every variable name,
 *     and the "self" keyword.
 * Ranking is rp's completion-ranker port (core/fuzzy.js rpFuzzyScore) — the
 * SAME algorithm that ranks the command palette (core/commands.js), reused
 * per the manifest's "natural reuse" note.
 */

import { slugMap, numericPropertyPaths, equationFunctionNames } from "./expressions.js";
import { rpFuzzyScore } from "./fuzzy.js";

// A trailing identifier chain: the token the cursor is currently inside/after.
// Mirrors expressions.js's REF_RE shape but anchored to the END of a string
// (partial input — the user hasn't finished typing, so the tokenizer's
// whole-token grammar doesn't apply here).
const TRAILING_REF_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.?$/;

/**
 * Pure function. The identifier chain immediately before `cursor` in `text`,
 * or "" if the cursor isn't inside/after one (e.g. right after an operator or
 * whitespace) — autocomplete has nothing to offer there. This is a PREFIX
 * match (unlike tokenize(), which demands a complete, validly-terminated
 * token): "self." and "box.en" are both valid fragments mid-type.
 *
 * @example currentFragment("self.end_wi", 11) // "self.end_wi"
 * @example currentFragment("box.x + 10 + spe", 16) // "spe"
 * @example currentFragment("box.x + 10 + spe", 5) // "box.x"  (cursor mid-token)
 * @example currentFragment("1 + ", 4) // ""
 */
export function currentFragment(text, cursor) {
  const before = text.slice(0, cursor);
  const m = TRAILING_REF_RE.exec(before);
  return m ? m[0] : "";
}

/**
 * Pure function. Splits a fragment into {headPath, partial}: headPath is the
 * dotted chain BEFORE the last segment (its own dots), partial is the
 * (possibly empty) segment being typed right now. A fragment with no dot has
 * an empty headPath — it's a bare identifier, not a property lookup.
 *
 * @example splitFragment("self.end_wi") // {headPath: "self", partial: "end_wi"}
 * @example splitFragment("self.") // {headPath: "self", partial: ""}
 * @example splitFragment("spe") // {headPath: "", partial: "spe"}
 * @example splitFragment("self.anchors.ce") // {headPath: "self.anchors", partial: "ce"}
 */
export function splitFragment(fragment) {
  const dot = fragment.lastIndexOf(".");
  return dot === -1 ? { headPath: "", partial: fragment } : { headPath: fragment.slice(0, dot), partial: fragment.slice(dot + 1) };
}

/**
 * Pure function. Resolves a fragment's dotted HEAD (everything before the
 * final segment) to the plugin whose numeric properties should be offered,
 * or null when the head isn't (yet) a recognizable item — a bare identifier
 * fragment (no dot), an unresolvable slug, or a deeper anchors/self.anchors
 * path (properties don't nest under an anchor — nothing to offer there).
 *
 * @example headPlugin("self", slugMap({items:{}}), registry, "a1") // the owner item's plugin
 * @example headPlugin("box", slugMap({items:{a1:{type:"rect",name:"Box"}}}), registry, null) // rectPlugin
 * @example headPlugin("", slugMap({items:{}}), registry, null) // null (bare identifier: not a property lookup)
 */
export function headPlugin(headPath, state, slugs, registry, selfId) {
  if (headPath === "") return null;
  if (headPath === "self") return selfId == null ? null : registry.get(state.items[selfId].type);
  if (headPath.includes(".")) return null; // e.g. "self.anchors": no nested properties to offer
  const itemId = slugs.toId.get(headPath);
  if (itemId == null) return null;
  return registry.get(state.items[itemId].type);
}

/**
 * Pure function. Ranked autocomplete candidates for `text` at `cursor`
 * (caret index into `text`), or [] when there's nothing to suggest (cursor
 * not inside/after an identifier chain). `state` is the item's OWNING
 * document state (app.rawState()); `selfId` is the equation's owner item
 * (enables `self.` completion — pass null outside an item's own equation,
 * e.g. the Variables Panel).
 *
 * Each candidate is {text, kind}: `text` is what REPLACES the current
 * fragment's final segment on accept; `kind` is "property" | "slug" |
 * "variable" | "keyword" | "function" (for the caller's icon/styling, not
 * ranking). A FUNCTION candidate's `text` carries a trailing "(" so accepting
 * it inserts "closest_to_rim(" with the caret parked inside the call (the
 * registry-driven set is equationFunctionNames(), core/expressions.js — ONE
 * source of truth, so a new equation function surfaces here automatically).
 * Empty `partial` (just typed "self." or "box.") returns ALL of that
 * head's properties, unranked-but-alphabetical (nothing to rank against yet).
 *
 * @example suggestEquation("self.end_wi", 11, state, registry, "a1") // [{text: "end_width", kind: "property"}, ...]
 * @example suggestEquation("spe", 3, {vars: {speed: 5}, items: {}}, registry, null) // [{text: "speed", kind: "variable"}]
 * @example suggestEquation("clos", 4, {items: {}}, registry, null) // [{text: "closest_to_rim(", kind: "function"}]
 */
export function suggestEquation(text, cursor, state, registry, selfId = null) {
  const fragment = currentFragment(text, cursor);
  if (!fragment) return [];
  const { headPath, partial } = splitFragment(fragment);
  const slugs = slugMap(state);

  const candidates = [];
  if (headPath === "") {
    if ("self".startsWith(partial.toLowerCase()) || !partial) candidates.push({ text: "self", kind: "keyword" });
    for (const slug of slugs.toId.keys()) candidates.push({ text: slug, kind: "slug" });
    for (const name of Object.keys(state.vars ?? {})) candidates.push({ text: name, kind: "variable" });
    // Equation FUNCTIONS (registry-driven — Lead scope addition): insert with
    // the open paren so the caret lands inside the call ("closest_to_rim(").
    for (const fn of equationFunctionNames()) candidates.push({ text: `${fn}(`, kind: "function" });
  } else {
    const plugin = headPlugin(headPath, state, slugs, registry, selfId);
    if (!plugin) return [];
    for (const path of numericPropertyPaths(plugin)) candidates.push({ text: path, kind: "property" });
  }

  if (!partial) return candidates.sort((a, b) => a.text.localeCompare(b.text));
  return candidates
    .map((c) => ({ c, score: rpFuzzyScore(partial, c.text) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.c);
}

/**
 * Pure function. Applies an accepted candidate to `text`/`cursor`: replaces
 * the CURRENT FRAGMENT's final segment with `candidate.text`, preserving
 * everything else. Returns {text, cursor} — the new field value and where to
 * place the caret (right after the inserted text).
 *
 * @example acceptSuggestion("self.end_wi + 2", 11, "end_width") // {text: "self.end_width + 2", cursor: 14}
 * @example acceptSuggestion("spe", 3, "speed") // {text: "speed", cursor: 5}
 */
export function acceptSuggestion(text, cursor, candidateText) {
  const fragment = currentFragment(text, cursor);
  const { headPath } = splitFragment(fragment);
  const prefix = headPath ? `${headPath}.` : "";
  const replaced = text.slice(0, cursor - fragment.length) + prefix + candidateText;
  return { text: replaced + text.slice(cursor), cursor: replaced.length };
}
