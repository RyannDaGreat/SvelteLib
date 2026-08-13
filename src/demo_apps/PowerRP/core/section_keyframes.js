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
 *
 * ── WORKSTREAM KEYFR (2026-08-12) ADDED TWO THINGS AND NEITHER IS A SECTION ──
 * The functions here were never actually section-specific — they are generic over
 * "some list of full state paths, over one slide", which is what let WORKSTREAM BJ
 * reuse them for the ROW diamond over a multi-selection. The two additions extend
 * the same list along its two remaining axes, and live here for that reason rather
 * than in new modules that would have to restate the path grammar:
 *   `sectionJumpTip`     — the ‹ › arrows' state SENTENCE, so an arrow with no
 *                          target says why instead of silently doing nothing.
 *   `itemBakePaths` +    — the whole ITEM's path list, which is what the slide-wide
 *   `keyframeEverything… ` "Keyframe Everything In Slide" bake keys.
 * Each carries its own user quote and reasoning at its docstring.
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

/**
 * Pure function. The ‹ / › arrow's TOOLTIP, which is also the whole reason this
 * function exists rather than a bare boolean at the call site.
 *
 * ── WHAT THE USER ASKED FOR (2026-08-12, verbatim) ───────────────────────────
 * "The buttons for previous keyframe and next keyframe should be disabled if
 * there is no previous or next keyframe to go to."
 *
 * The no-target condition was ALREADY computed — `sectionJumpTarget` returns null
 * and `app.jumpSectionKeyframes` "stays put when there is none". So the arrow was
 * a live-looking control whose click did nothing, silently: the app knew the
 * answer and declined to say it. That is the shape this codebase forbids, and it
 * is the same defect the save-button ruling names — a control must not lie about
 * its own affordance.
 *
 * A DISABLED ARROW MUST STILL SAY WHY, so the reason is a SENTENCE and not an
 * absence. Both surfacings reflect it with `aria-disabled` + a handler guard
 * rather than the native `disabled` attribute, because a natively disabled button
 * is not focusable and the keyboard could then never reach this sentence (the
 * toolbar's standing rule — web/Toolbar.svelte's Save button is the precedent,
 * and the sentence there is likewise the only place its gate's reason is written
 * down).
 *
 * THE SENTENCE NAMES THE DIRECTION AND THE FACT, in the arrow's own words: the
 * user is looking at a greyed ‹, and "there is no earlier slide keyframing this"
 * answers the question that greying provokes. It deliberately does NOT read like
 * `unavailableMessage`'s "Unavailable — requires …" frame: that frame belongs to
 * the COMMAND REGISTRY's `requires` clauses (core/commands.js), and these two
 * arrows are not registry entries. Borrowing the frame here would imply a palette
 * entry that does not exist.
 *
 * ── `subject` IS WHAT MADE THIS SHAREABLE (WORKSTREAM KEYFR follow-up) ───────
 * The section header's arrows always named their section ("Previous slide
 * keyframing anything in Transform") while the row's said "Previous keyframe".
 * That difference is REAL — a section bubble speaks for many properties at once,
 * so the title is what tells you which — and it is exactly why the first pass at
 * this feature only reached one of the two: a tip function that could not say
 * "Transform" was not usable by the section variant, so the section variant kept
 * its own hand-written strings and inherited nothing. Taking the subject as an
 * argument is what lets ONE function serve both, which is the whole fix.
 *
 * @param {number|null} target `sectionJumpTarget`'s answer for this direction.
 * @param {number} direction -1 for previous, +1 for next.
 * @param {string|null} [subject] What these arrows speak for ("Transform"), or
 *   null/omitted for the row triad, which speaks for one property.
 * @returns {string}
 *
 * @example
 *     >>> sectionJumpTip(3, -1)
 *     'Previous keyframe'
 *     >>> sectionJumpTip(null, -1)
 *     'No earlier slide keyframes this — nothing to jump back to'
 *     >>> sectionJumpTip(7, +1)
 *     'Next keyframe'
 *     >>> sectionJumpTip(null, +1)
 *     'No later slide keyframes this — nothing to jump forward to'
 *     >>> // named, for a section header's smaller triad:
 *     >>> sectionJumpTip(3, -1, "Transform")
 *     'Previous slide keyframing anything in Transform'
 *     >>> sectionJumpTip(null, +1, "Transform")
 *     'No later slide keyframes anything in Transform — nothing to jump forward to'
 */
export function sectionJumpTip(target, direction, subject = null) {
  const later = direction > 0;
  if (target !== null) {
    if (subject === null) return later ? "Next keyframe" : "Previous keyframe";
    return `${later ? "Next" : "Previous"} slide keyframing anything in ${subject}`;
  }
  const what = subject === null ? "this" : `anything in ${subject}`;
  return later
    ? `No later slide keyframes ${what} — nothing to jump forward to`
    : `No earlier slide keyframes ${what} — nothing to jump back to`;
}

/**
 * Pure function. EVERYTHING one ‹ or › arrow needs to render itself: where it
 * would go, whether it may be clicked, and the sentence it shows either way.
 *
 * ── WHY THIS EXISTS, IN THE USER'S OWN DIAGNOSIS (2026-08-13, verbatim) ──────
 * "The disabling of next and previous keyframes for ones that don't have it seems
 * not to have transferred to the overall ones such as the ones that are small. The
 * small version didn't seem to have inherited this. This leads me to believe that
 * they're not sharing the same base class or it was implemented in the wrong
 * level. Perhaps it should be applied to the parent. I haven't looked at the code
 * though. To be honest, I'm not really sure what the issue is. Please tell the
 * agent thought. The code is not the same."
 *
 * THE LAST SENTENCE IS THE BUG REPORT AND IT IS EXACTLY RIGHT. There are two
 * surfacings of this triad — web/KeyframeControls.svelte (row) and
 * web/SectionKeyframeControls.svelte (the 70%-scale section header) — and they
 * were siblings by COPIED MARKUP, not by a shared component. Their headers even
 * say so, proudly: "the same three buttons in the same order… the same
 * `.keybtn`/`.jumpbtn` classes". SHARING A CSS CLASS IS NOT SHARING BEHAVIOUR, so
 * a fix applied to one file could not reach the other, and the availability
 * shipped to exactly half the arrows in the app. The user inferred all of that
 * from the outside, without reading the code.
 *
 * ── THE HOIST, AND WHY IT IS A DESCRIPTOR AND NOT A COMPONENT ───────────────
 * "Perhaps it should be applied to the parent" is the right instinct, and this is
 * the parent: the two variants differ in SCALE, in wrapper markup, in whether they
 * stop propagation, and in whether they name a subject — all presentational — but
 * they cannot differ in WHEN AN ARROW MAY BE CLICKED without one of them being
 * wrong. So the shared layer is the ANSWER, not the markup: each variant renders
 * its own button and reads `disabled`/`tip`/`target` off this one object. Merging
 * the markup instead would have meant one component growing scale/wrapper/subject
 * props to serve two visual designs the user deliberately asked to look different
 * ("maybe just 30% smaller"), which is a worse trade than sharing the derivation.
 *
 * A THIRD SURFACING CANNOT SHIP UNWIRED, because there is now nothing else to
 * call: the target walk, the guard condition and both sentences arrive together,
 * and `tests/keyfr_tools_test.js` ENUMERATES the `jumpbtn` surfacings and fails on
 * any that does not consume this. That enumeration is the real guarantee — the
 * first pass at this feature was also "correct", and still reached one file.
 *
 * @param {number|null} target `sectionJumpTarget`'s answer for this direction.
 * @param {number} direction -1 for previous, +1 for next.
 * @param {string|null} [subject] What the arrows speak for, or null for a row.
 * @returns {{target: number|null, disabled: boolean, tip: string}}
 *
 * @example
 *     >>> jumpArrow(3, -1)
 *     {target: 3, disabled: false, tip: 'Previous keyframe'}
 *     >>> jumpArrow(null, +1)
 *     {target: null, disabled: true, tip: 'No later slide keyframes this — nothing to jump forward to'}
 *     >>> // SLIDE 0 IS A TARGET, NOT AN ABSENCE — a falsy test would grey this:
 *     >>> jumpArrow(0, -1).disabled
 *     false
 */
export function jumpArrow(target, direction, subject = null) {
  return { target, disabled: target === null, tip: sectionJumpTip(target, direction, subject) };
}

/**
 * Pure function. EVERY keyframeable state path of one item — the "Keyframe
 * Everything In Slide" bake's per-item path set.
 *
 * ── WHAT THE USER ASKED FOR (2026-08-12, verbatim) ───────────────────────────
 * "A 'Keyframe Everything In Slide' tool".
 *
 * ── IT IS THE SECTION BUBBLE'S SET, UNIONED OVER THE WHOLE ITEM ──────────────
 * The additive keyframe primitive already exists — the section header diamond's
 * "click to keyframe all of it" — and it is per-section. A slide-wide bake is
 * that same act with a wider scope, so it is built by calling `sectionKeyPaths`
 * over the item's ROWS rather than by inventing a second notion of "everything".
 * That is what makes the two agree by construction: whatever a bubble would key,
 * the bake keys, and nothing else.
 *
 * ── WHY `plugin.inspector` AND NOT THE ITEM'S STORED KEYS ────────────────────
 * The stored fold is what the item HAPPENS to hold, which is both too much and
 * too little. Too much: `name` and `type` are stored leaves that are not per-slide
 * state (`keyframes: false` — a bake writing them would advertise a write the
 * document refuses, and a keyframed `name` is meaningless). Too little: a property
 * the author has never touched is ABSENT from the fold but is exactly the thing a
 * bake is for — it holds a default that the bake must pin here so a later slide
 * can tween away from it. So the DECLARATION is the authority, and the value comes
 * from the caller's `storedValueAtPath` (which resolves a sparse material knob to
 * its schema default for the same reason).
 *
 * ── UNIVERSAL ROWS ARE PASSED IN, NOT LOOKED UP ─────────────────────────────
 * `active` is a universal property no plugin declares (core/multiselect.js
 * `universalRows` owns that set and the camera's exemption from `active`), so the
 * caller supplies those rows. This function stays a pure row→path mapping and
 * gains no second opinion about what a universal row is.
 *
 * @param {string} itemId The item to bake.
 * @param {object[]} rows Its keyframeable row defs (plugin.inspector + universal).
 * @returns {string[][]} Full state paths, deduplicated (`sectionKeyPaths`' rule).
 *
 * @example
 *     >>> itemBakePaths("a", [{key: "x"}, {key: "cx", writeKey: "x"}, {key: "name", keyframes: false}])
 *     [["items", "a", "x"]]
 *     >>> // a dotted row keys the nested leaf, exactly as its diamond does:
 *     >>> itemBakePaths("a", [{key: "rotationAnchor.x"}])
 *     [["items", "a", "rotationAnchor", "x"]]
 */
export function itemBakePaths(itemId, rows) {
  return sectionKeyPaths(rows, () => [itemId], (row) => row.writeKey ?? row.key);
}

/**
 * The bake's HELP sentence, whose whole job is to make the cost explicit — so it
 * says BAKE, in the user's own vocabulary for this operation.
 *
 * A bake is not free. The document model is a SPARSE chain of deltas: a slide's
 * delta says only what CHANGES there, and everything else is inherited. Keyframing
 * every property of every item pins all of it on this one slide, which is a
 * deliberate act with two consequences a user must be told about BEFORE clicking
 * and not after: the slide's delta grows to hold the whole scene, and a value
 * pinned here no longer follows an edit made on an earlier slide. The Aug-4
 * feature review's ruling is exactly that shape — a bake is fine as an EXPLICIT
 * action and a bug as implicit behaviour — so the explicitness has to be carried
 * by the sentence, and there is nowhere else for it to live.
 *
 * IT STATES BOTH SCOPES RATHER THAN THE LIVE ONE, and that is forced rather than
 * chosen: core/commands.js rules that `help` is "A PLAIN STRING deliberately" and
 * every surfacing renders `cmd.help` directly, so a function here would render as
 * source text in a tooltip — the exact mistake `commandUnavailableReason` exists
 * to prevent for `requires`, which IS allowed to be a function. Stating both is
 * also the more useful sentence: the reader is deciding WHETHER to select first,
 * and a help that describes only the scope they currently have cannot answer that.
 *
 * IT ALSO NAMES THE ONE THING THE TOOL DOES NOT DO. A property that holds no
 * value anywhere — absent from the slide AND from the widget's defaults, with the
 * plugin supplying a fallback only when it paints — has nothing to pin, and is
 * skipped. MEASURED: 33 of 161 paths on a real five-widget slide. A help sentence
 * that promised "every property" without that clause would be the tool's own title
 * lying at greater length, and the run reports the count for the same reason.
 *
 * @example
 *     >>> keyframeEverythingHelp.startsWith("BAKES this slide")
 *     true
 *     >>> keyframeEverythingHelp.includes("Select some widgets first")
 *     true
 */
export const keyframeEverythingHelp = "BAKES this slide: writes a keyframe HERE for every property of every widget on it, using the values they already hold — so the picture does not change now, but each of those values is PINNED to this slide instead of being inherited from an earlier one. Select some widgets first to bake only those; with nothing selected it bakes the whole slide. That is the cost, and it is why this is a tool you run rather than something that happens on its own: the slide's delta stops being sparse and grows to hold the whole scene, and a later edit to an earlier slide no longer flows through to here. A property that holds no value at all is skipped and counted in the console — there is nothing there to pin. One undo takes all of it back.";
