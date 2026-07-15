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

  Renders exactly the three buttons (no wrapper) so it drops into each panel's
  existing `.kf-controls` grid cell — the Variables Panel appends its own
  delete button after it in the same cell. Styling is the global app.css
  .keybtn/.jumpbtn/.keybtn.keyed rules (app convention: no <style> blocks); the
  markup is pixel-identical to the two originals.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";

  let {
    /** @type {object} The PowerRPApp controller. */
    app,
    /** @type {string[]} The full state path this row keyframes (e.g. ["vars","speed"]). */
    path,
  } = $props();

  let keyed = $derived(app.hasKeyPath(path));

  /** Command. UPSERT/remove a keyframe on the current slide for `path`. Insert
   * copies the raw stored value (equations keyframe as equations). */
  function toggleKey() {
    if (app.hasKeyPath(path)) app.removeKey(app.slideIndex, path);
    else app.keyframePath(path, app.storedValueAtPath(path));
  }
</script>

<Tooltip text="Previous keyframe">
  <button class="jumpbtn" aria-label="Previous keyframe" onclick={() => app.jumpKeyframePath(path, -1)}>
    <iconify-icon icon="mdi:chevron-left" width="16" height="16"></iconify-icon>
  </button>
</Tooltip>
<Tooltip text={keyed ? "Remove keyframe on this slide" : "Insert keyframe on this slide"}>
  <button
    class="keybtn"
    class:keyed
    aria-label="Toggle keyframe on this slide"
    onclick={toggleKey}
  >
    <iconify-icon icon={keyed ? "mdi:rhombus" : "mdi:rhombus-outline"} width="17" height="17"></iconify-icon>
  </button>
</Tooltip>
<Tooltip text="Next keyframe">
  <button class="jumpbtn" aria-label="Next keyframe" onclick={() => app.jumpKeyframePath(path, +1)}>
    <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
  </button>
</Tooltip>
