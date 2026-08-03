/**
 * SECTION-HEADER KEYFRAME BUBBLE — the pure half. DOM-free (bare-node testable);
 * web/SectionKeyframeControls.svelte is a thin renderer over these functions and
 * holds none of the reasoning.
 *
 * ── WHAT THE USER ASKED FOR (2026-08-02, night, verbatim) ─────────────────────
 * "In each drop-down, it would be helpful if the menu itself actually had a
 * slightly different-looking, maybe a bit smaller keyframe bubble on it too, that
 * would be half-filled if some of them are keyframed, completely unfilled if none
 * of them are keyframed, and fully filled if all of them are keyframed. And upon
 * clicking it, we'll toggle between all or none. It's a quick and easy way of
 * toggling the keyframes for an entire property section. We should add that. Maybe
 * just 30% smaller than the normal one. We don't need the left and right parts for
 * it. Actually, you know, we can get the left and right parts for it. Yeah. Okay."
 *
 * So the section header carries a SMALLER SIBLING of the row diamond
 * (web/KeyframeControls.svelte), reading the whole section at once. The mid-
 * message reversal is the final word: the ‹ › parts STAY, acting section-wide.
 *
 * ── THE ROW BUBBLE IS THE PARENT DESIGN, AND THIS ONE INHERITS ITS TRIAD ─────
 * A row diamond over a SET already means exactly this: FILLED = every path keyed
 * here, HALF = some, HOLLOW = none (`keyframeTriState`, core/multiselect.js). A
 * section bubble is the same reading over a DIFFERENT axis — many PROPERTIES of
 * one item rather than one property of many items — so it reuses that function
 * verbatim rather than restating the rule. Over a MULTI-SELECTION both axes apply
 * at once and the paths are simply the UNION (sectionKeyPaths flattens them), so
 * the tri-state answers about the whole grid of (rows × selected items) with no
 * second concept: half means "somewhere in this section, on some item".
 *
 * ── THE HALF STATE GOES TO ALL, AND THAT IS A RULING, NOT A COIN FLIP ────────
 * The user said "toggle between all or none" and did not say what a HALF-filled
 * bubble does, so the direction is chosen here and documented rather than left to
 * whichever branch an implementation happens to write first. HALF → ALL:
 *   1. THE CLICK ALWAYS COMPLETES BEFORE IT CLEARS. From any state the sequence
 *      is deterministic and short — half→all→none→all→none — so the control has a
 *      two-step cycle the user can learn, and never a state where clicking it
 *      twice returns you to where you started with work destroyed in between.
 *   2. IT MATCHES THE ROW BUBBLE'S OWN MIXED RULE, which is already shipped and
 *      already reasoned: an insert is an UPSERT (nothing is lost, one undo takes
 *      it back) while a remove DESTROYS keyframes the user may not have known were
 *      there. Sending half to `none` would delete the very keyframes that made it
 *      half — the destructive branch, chosen on the state that is least sure of
 *      what the user meant. Removal therefore requires the section to be
 *      uniformly keyed already, which is exactly what the FULL bubble reports.
 * The tooltip states the resulting verb (`sectionToggleTip`), so the click is
 * never a guess.
 *
 * ── ONE UNDO UNIT ────────────────────────────────────────────────────────────
 * The toggle is a BULK EDIT of N paths and must be one undo step, the BE/unify
 * precedent. These functions are PURE and return the PAIRS/PATHS to write; the
 * caller (web/app.svelte.js `toggleSectionKeyframes`) folds them into ONE document
 * and commits once. Nothing here touches a document.
 */

import { keyframeTriState } from "./multiselect.js";

/**
 * Pure function. The state paths a section's keyframe bubble acts on: every
 * keyframeable row in the section, crossed with every item the row applies to.
 *
 * A row is EXCLUDED when it declares `keyframes: false` (Name and Widget type in
 * the Universal section — a name is not per-slide state), because a bubble that
 * claimed to key them would advertise a write the document refuses. A section
 * left with NO keyframeable rows yields `[]`, which reads as "none" and — per
 * `sectionBubbleApplies` — renders no bubble at all rather than a dead control.
 *
 * `itemIdsFor(row)` is the multi-selection seam: it answers which items this row
 * applies to (core/multiselect.js gives a row its own `appliesTo`, which in UNION
 * mode is a SUBSET of the selection — writing such a row to the others would store
 * a property their plugin never declared). Single selection passes the one id.
 *
 * @param {Array<object>} rows A section's row defs, in order.
 * @param {(row: object) => string[]} itemIdsFor Which item ids each row writes.
 * @param {(row: object) => string} keyOf The row's REAL stored key (Inspector's
 *   `writeKey` — a `cx` row stores through `x`), dotted for nested leaves.
 * @returns {string[][]} Full state paths, row-major, deduplicated.
 *
 * @example
 *     >>> sectionKeyPaths([{key: "x"}, {key: "y"}], () => ["a"], (r) => r.key)
 *     [["items", "a", "x"], ["items", "a", "y"]]
 *     >>> // a not-keyframeable row is skipped, and cx stores through x:
 *     >>> sectionKeyPaths([{key: "name", keyframes: false}, {key: "cx", writeKey: "x"}],
 *     ...                 () => ["a"], (r) => r.writeKey ?? r.key)
 *     [["items", "a", "x"]]
 *     >>> // multi-selection: the union over every selected item
 *     >>> sectionKeyPaths([{key: "opacity"}], () => ["a", "b"], (r) => r.key)
 *     [["items", "a", "opacity"], ["items", "b", "opacity"]]
 */
export function sectionKeyPaths(rows, itemIdsFor, keyOf) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (row.keyframes === false) continue;
    const segments = keyOf(row).split(".");
    for (const id of itemIdsFor(row)) {
      const path = ["items", id, ...segments];
      // A dedupe is not paranoia: cx/cy and x/y can BOTH be declared in one
      // section (core/properties.js PROPS.cx writes through "x"), so the same
      // leaf would otherwise be keyed twice — harmless on insert, but it would
      // make a count-based assertion lie about how many paths the section holds.
      const seal = path.join("\u0000");
      if (seen.has(seal)) continue;
      seen.add(seal);
      out.push(path);
    }
  }
  return out;
}

/**
 * Pure function. The section bubble's tri-state, from whether each of its paths
 * is keyed on the CURRENT slide. Exactly the row diamond's triad over the
 * section's whole path set — see the header for why this is one shared rule.
 *
 * @param {boolean[]} keyedFlags One flag per `sectionKeyPaths` entry.
 * @returns {"all"|"some"|"none"}
 *
 * @example
 *     >>> sectionTriState([true, true, true])
 *     'all'
 *     >>> sectionTriState([true, false, true])
 *     'some'
 *     >>> sectionTriState([false, false])
 *     'none'
 *     >>> sectionTriState([])
 *     'none'
 */
export function sectionTriState(keyedFlags) {
  return keyframeTriState(keyedFlags);
}

/**
 * Pure function. Does this section get a bubble at all? False when the section
 * has no keyframeable path — a transition's config rows, a not-yet-created item's
 * grayed rows, or a section of nothing but Name/Widget type.
 *
 * A dead bubble would be worse than no bubble: it would report "none" forever and
 * do nothing when clicked, which is the shape of a broken control rather than of
 * an absent feature.
 *
 * @example
 *     >>> sectionBubbleApplies([["items", "a", "x"]])
 *     true
 *     >>> sectionBubbleApplies([])
 *     false
 */
export function sectionBubbleApplies(paths) {
  return paths.length > 0;
}

/**
 * Pure function. WHAT A CLICK DOES, from the current tri-state — the single
 * decision point, so the tooltip and the command can never disagree about it.
 * "insert" for none AND some (the HALF → ALL ruling, justified in the header);
 * "remove" only from a uniformly-keyed section.
 *
 * @example
 *     >>> sectionToggleAction("none")
 *     'insert'
 *     >>> sectionToggleAction("some")
 *     'insert'
 *     >>> sectionToggleAction("all")
 *     'remove'
 */
export function sectionToggleAction(triState) {
  return triState === "all" ? "remove" : "insert";
}

/**
 * Pure function. The bubble's tooltip: it SAYS WHAT THE CLICK WILL DO, naming the
 * section, because a tri-state control whose click direction depends on its own
 * state is exactly the control a user should not have to experiment with. The
 * "some" sentence also reports the state it found, so the half fill is explained
 * rather than merely shown.
 *
 * @param {"all"|"some"|"none"} triState
 * @param {string} title The section's display title ("Transform").
 * @returns {string}
 *
 * @example
 *     >>> sectionToggleTip("none", "Transform")
 *     'Keyframe every property in Transform on this slide'
 *     >>> sectionToggleTip("some", "Transform")
 *     'Some of Transform is keyframed on this slide — click to keyframe all of it'
 *     >>> sectionToggleTip("all", "Transform")
 *     'Remove every Transform keyframe on this slide'
 */
export function sectionToggleTip(triState, title) {
  if (triState === "all") return `Remove every ${title} keyframe on this slide`;
  if (triState === "some") return `Some of ${title} is keyframed on this slide — click to keyframe all of it`;
  return `Keyframe every property in ${title} on this slide`;
}

/**
 * Pure function. The slide a section-wide ‹ / › jump lands on: the nearest slide
 * in `direction` holding a keyframe for ANY of the section's paths, or null when
 * there is none.
 *
 * THIS IS THE SET-AWARE JUMP web/KeyframeControls.svelte's header FLAGGED and
 * deliberately did not guess at ("the nearest slide where ANY selected item is
 * keyed"). A section has no primary property the way a set has a primary item, so
 * "the previous keyframe of the Transform section" has no other honest answer:
 * following one arbitrary row would skip past slides where the section demonstrably
 * changes. The union is also what makes the arrows agree with the bubble beside
 * them — the bubble reads the union, so the arrows must walk the union or the two
 * halves of one control would be describing different things.
 *
 * @param {number[][]} indicesPerPath Each path's keyframed slide indices.
 * @param {number} current The current slide index.
 * @param {number} direction -1 for previous, +1 for next.
 * @returns {number|null}
 *
 * @example
 *     >>> // x keys on slides 0 and 5, opacity on slide 2; from slide 1:
 *     >>> sectionJumpTarget([[0, 5], [2]], 1, +1)
 *     2
 *     >>> sectionJumpTarget([[0, 5], [2]], 1, -1)
 *     0
 *     >>> sectionJumpTarget([[0, 5], [2]], 5, +1)
 *     null
 */
export function sectionJumpTarget(indicesPerPath, current, direction) {
  let best = null;
  for (const indices of indicesPerPath) {
    for (const i of indices) {
      if (direction > 0 ? i <= current : i >= current) continue;
      // NEAREST, not first: the paths arrive in row order, so a later row can
      // hold a closer slide than an earlier one.
      if (best === null || (direction > 0 ? i < best : i > best)) best = i;
    }
  }
  return best;
}
