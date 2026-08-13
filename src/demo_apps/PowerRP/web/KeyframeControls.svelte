<!--
  KeyframeControls — the ‹ ◆ › keyframe row shared by the Property Panel
  (Inspector) and the Variables Panel. ONE home for the triad that used to be
  hand-duplicated in both (cruft audit: "‹ ◆ › keyframe-controls row
  duplicated"):

    ‹   jump to the PREVIOUS slide holding a keyframe for this path
    ◆/◇ insert (◇→◆) / remove (◆→◇) a keyframe on the CURRENT slide (UPSERT:
        inserting where one exists just changes it — same motion)
    ›   jump to the NEXT slide holding a keyframe

  It operates on a FULL state `path` (e.g. ["items", id, "from", "x"] or
  ["vars", name]) through the app's path-based keyframe methods, so both
  panels reduce to the same three buttons. Inserting copies the RAW stored
  value (an equation keyframes as the equation).

  OVER A SET (`paths`, the multi-selection Property Panel), the diamond becomes
  the manifest's TRIAD — FILLED when every selected item is keyed here,
  HALF-FILLED (a split rhombus) when only some are, HOLLOW when none is.

  WHAT A CLICK DOES WHEN ONLY SOME ARE KEYED is a decision, not a default:
  it INSERTS on all of them. The standing ruling against a set toggle is "no
  toggle that has to guess the set's state", so the mixed case may not be left to
  guess — and of the two ways to make the set uniform, insert is an UPSERT
  (nothing is lost, and one undo reverts it) while remove destroys keyframes the
  user may not have known were there. Removal therefore requires the set to be
  uniformly keyed already, which is exactly what the FILLED diamond reports.

  WORKSTREAM BJ (2026-08-03) FIXED THE TWO DEFECTS THIS HEADER USED TO FLAG, BY
  REUSING BH's SECTION MECHANISM RATHER THAN INVENTING A SECOND ONE — a row's
  path SET is not conceptually different from a section's path set (both are
  "some list of full state paths, over one slide"; core/section_keyframes.js's
  functions were already generic over an arbitrary path list and never actually
  section-specific despite their names):
    - THE DIAMOND now calls `app.toggleSectionKeyframes(keyPaths)` — the SAME
      fold-once/commit-once method the section header bubble uses — instead of
      looping `keyframePath`/`removeKey` per path. One click over N selected
      items is now ONE undo unit, not N. For a single selection `keyPaths` is a
      one-element array, so `sectionKeyframeState` can only read "all"/"none"
      (never "some") — byte-identical to the old boolean behaviour.
    - THE ‹ › ARROWS now call `app.jumpSectionKeyframes(keyPaths, ±1)` — the
      UNION walk BH built for the section bubble — instead of following the
      PRIMARY path only. A one-element `keyPaths` reduces to exactly
      `jumpKeyframePath`'s own nearest-in-direction search, so single-selection
      behaviour is unchanged; over a set the arrows now agree with what the
      diamond itself reads (the tri-state already read the whole set — only the
      jump was still primary-only, which is what made the two halves of one
      control describe different things).
  No new core function was written for either fix — see core/section_keyframes.js
  for the pure logic and web/app.svelte.js for the two methods reused verbatim.

  WORKSTREAM KEYFR (2026-08-12) MADE THE ARROWS SAY WHEN THEY CANNOT GO (user:
  "The buttons for previous keyframe and next keyframe should be disabled if there
  is no previous or next keyframe to go to"). The condition was ALREADY computed
  and ALREADY thrown away: `sectionJumpTarget` returns null and
  `jumpSectionKeyframes` "stays put when there is none", so on the first and last
  keyframed slide these were live-looking controls that silently did nothing.

  THE HOUSE FORM IS `aria-disabled` + A HANDLER GUARD, NEVER THE NATIVE ATTRIBUTE
  (the toolbar's Save-button ruling): a natively disabled button is not focusable,
  so a keyboard user could never reach the tooltip — and the tooltip is the ONLY
  place the reason is written down. The guard is what actually refuses the click;
  `aria-disabled` is what says so — and it is ALSO what carries the greying, via
  app.css's `.jumpbtn[aria-disabled="true"]` rule, because the app already styles
  `[aria-disabled]` to read exactly as `:disabled` (app.css's `.btn` block states
  that rule and the reason). A second `.unavailable` class beside the attribute
  would be one state spelled twice — the drift this codebase keeps paying for.

  THE WHOLE ARROW STATE IS core's, not this file's. 2026-08-13 the user reported
  that the fix had reached the row arrows and NOT the section header's smaller
  ones — "The small version didn't seem to have inherited this… The code is not
  the same" — which was exactly true: web/SectionKeyframeControls.svelte is this
  file's markup COPIED, not a subclass of it, so nothing added here could reach it.
  Both now render off ONE descriptor (`app.jumpArrowFor` ->
  core/section_keyframes.jumpArrow), which carries target + disabled + tooltip
  together, so a variant either consumes the whole answer or has nothing to call.

  Renders exactly the three buttons (no wrapper) so it drops into each panel's
  existing `.kf-controls` grid cell — the Variables Panel appends its own
  delete button after it in the same cell. Styling is the global app.css
  .keybtn/.jumpbtn/.keybtn.keyed rules (app convention: no <style> blocks); the
  markup is pixel-identical to the two originals.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { keyframeTriState } from "../core/multiselect.js";

  let {
    /** @type {object} The PowerRPApp controller. */
    app,
    /** @type {string[]} The full state path this row keyframes (e.g. ["vars","speed"]). */
    path,
    /** @type {string[][]|null} Every path this row keyframes, for a multi-selection.
     *  null (the default) = the single path above, byte-identically as before. */
    paths = null,
  } = $props();

  // The set this row acts on. One entry in the single-selection case, so the
  // triad below collapses to the original keyed/not-keyed pair by construction.
  let keyPaths = $derived(paths ?? [path]);
  let triState = $derived(keyframeTriState(keyPaths.map((p) => app.hasKeyPath(p))));

  // The diamond's three readings (iconify only — never a Unicode glyph).
  const TRI_ICONS = { all: "mdi:rhombus", some: "mdi:rhombus-split", none: "mdi:rhombus-outline" };
  const TRI_TIPS = {
    all: "Remove keyframe on this slide",
    some: "Only SOME selected items are keyed here — insert on all of them",
    none: "Insert keyframe on this slide",
  };

  /** Command. Brings the whole set to a uniform keyframe state on the current
   * slide, in ONE undo unit: FILLED removes on every path, HALF/HOLLOW inserts on
   * every path (an UPSERT that copies each path's own raw stored value, so an
   * equation keyframes as the equation and no two items are given each other's
   * value). See the header for why the mixed case inserts rather than guessing.
   * Reuses BH's `app.toggleSectionKeyframes` verbatim — a row's path set and a
   * section's are the same shape, so the same fold-once/commit-once method
   * applies with no second mechanism. */
  function toggleKey() {
    app.toggleSectionKeyframes(keyPaths);
  }

  // EACH ARROW'S WHOLE STATE — target, disabled, tooltip — from the ONE shared
  // query every arrow in the app now makes (`app.jumpArrowFor` ->
  // core/section_keyframes.jumpArrow). The section header's smaller triad reads
  // the same thing with a subject; that is the fix for the user's "the small
  // version didn't seem to have inherited this".
  let prev = $derived(app.jumpArrowFor(keyPaths, -1));
  let next = $derived(app.jumpArrowFor(keyPaths, +1));

  /** Command. Jumps, unless there is nowhere to jump — THE GUARD that makes
   * `aria-disabled` real. Native `disabled` is not used here (see the header:
   * it would make the button unfocusable and its reason unreachable), so a
   * disabled-looking arrow is still clickable and this is what refuses it. */
  function jump(direction, arrow) {
    if (arrow.disabled) return;
    app.jumpSectionKeyframes(keyPaths, direction);
  }
</script>

<Tooltip text={prev.tip}>
  <button
    class="jumpbtn"
    aria-disabled={prev.disabled}
    aria-label="Previous keyframe"
    onclick={() => jump(-1, prev)}
  >
    <iconify-icon icon="mdi:chevron-left" width="16" height="16"></iconify-icon>
  </button>
</Tooltip>
<Tooltip text={TRI_TIPS[triState]}>
  <button
    class="keybtn"
    class:keyed={triState === "all"}
    class:keyed-some={triState === "some"}
    aria-label="Toggle keyframe on this slide"
    onclick={toggleKey}
  >
    <iconify-icon icon={TRI_ICONS[triState]} width="17" height="17"></iconify-icon>
  </button>
</Tooltip>
<Tooltip text={next.tip}>
  <button
    class="jumpbtn"
    aria-disabled={next.disabled}
    aria-label="Next keyframe"
    onclick={() => jump(+1, next)}
  >
    <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
  </button>
</Tooltip>
