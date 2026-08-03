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
</script>

<Tooltip text="Previous keyframe">
  <button class="jumpbtn" aria-label="Previous keyframe" onclick={() => app.jumpSectionKeyframes(keyPaths, -1)}>
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
<Tooltip text="Next keyframe">
  <button class="jumpbtn" aria-label="Next keyframe" onclick={() => app.jumpSectionKeyframes(keyPaths, +1)}>
    <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
  </button>
</Tooltip>
