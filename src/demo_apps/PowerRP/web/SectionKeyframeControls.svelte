<!--
  SectionKeyframeControls — the ‹ ◆ › triad on an Inspector SECTION HEADER, a
  SMALLER SIBLING of web/KeyframeControls.svelte (WORKSTREAM BH; the user's
  verbatim request and every design ruling are in core/section_keyframes.js's
  header, which is the doctrine for this pair of files).

    ‹   jump to the nearest PREVIOUS slide keyframing ANY of the section's
        properties
    ◆/◐/◇ keyframe every property in the section on the CURRENT slide, or — from
        a fully-keyed section — remove every one of them. ONE UNDO UNIT.
    ›   the same jump forward

  SAME FAMILY, NOT A NEW INVENTION. It is the row triad's markup and vocabulary:
  the same three buttons in the same order, the same `mdi:rhombus*` triad, the
  same amber/partial colour tokens, the same `.keybtn`/`.jumpbtn` classes so a
  theme that restyles keyframe chrome restyles this too and cannot forget it. What
  differs is SCALE and one modifier class (`.kf-section`, --a-kf-section-scale =
  0.7, the user's "maybe just 30% smaller"), which is the whole of "slightly
  different-looking": a reader must be able to tell at a glance that this diamond
  speaks for a section rather than for a property, without having to learn a
  second visual language to do it.

  WHY IT IS NOT ONE MERGED BUTTON WITH THE HEADER. `.cat-header` is itself a
  <button> (the collapse toggle), and a button may not contain a button — so the
  header row is a `.cat-header-row` FLEX WRAPPER holding the collapse button and
  this triad as SIBLINGS. That is also the honest affordance: collapsing a section
  and keyframing it are two different actions, and clicking the diamond must not
  fold the panel out from under the click. The triad stops the click from reaching
  the header for the same reason.

  IT RENDERS ONLY WHERE IT CAN ACT (`sectionBubbleApplies`): a section with no
  keyframeable path — a transition's config rows, a not-yet-created item's grayed
  rows — gets NO bubble, rather than a permanently hollow one that does nothing
  when clicked.

  Renders exactly the three buttons wrapped in one `.kf-controls.kf-section` span.
  Styling is app.css (app convention: no <style> blocks here).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { sectionToggleTip } from "../core/section_keyframes.js";

  let {
    /** @type {object} The PowerRPApp controller. */
    app,
    /** @type {string[][]} Every state path this section keyframes — already the
     *  UNION over the section's rows and, in a multi-selection, over every
     *  selected item (core/section_keyframes.sectionKeyPaths). */
    paths,
    /** @type {string} The section's display title, for the tooltip's sentences. */
    title,
  } = $props();

  // The SAME triad the row diamond shows, over the section's whole path set.
  let triState = $derived(app.sectionKeyframeState(paths));

  // The three readings. `mdi:rhombus-split` is the row bubble's own half-fill
  // mark: at 70% scale a subtler device would stop reading as "partly", and
  // Audulus-restraint is about not being gaudy, not about being illegible.
  const TRI_ICONS = { all: "mdi:rhombus", some: "mdi:rhombus-split", none: "mdi:rhombus-outline" };
</script>

<span class="kf-controls kf-section">
  <Tooltip text={`Previous slide keyframing anything in ${title}`}>
    <button
      class="jumpbtn"
      aria-label={`Previous ${title} keyframe`}
      onclick={(e) => { e.stopPropagation(); app.jumpSectionKeyframes(paths, -1); }}
    >
      <iconify-icon icon="mdi:chevron-left" width="16" height="16"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text={sectionToggleTip(triState, title)}>
    <button
      class="keybtn"
      class:keyed={triState === "all"}
      class:keyed-some={triState === "some"}
      aria-label={`Toggle every ${title} keyframe on this slide`}
      onclick={(e) => { e.stopPropagation(); app.toggleSectionKeyframes(paths); }}
    >
      <iconify-icon icon={TRI_ICONS[triState]} width="17" height="17"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text={`Next slide keyframing anything in ${title}`}>
    <button
      class="jumpbtn"
      aria-label={`Next ${title} keyframe`}
      onclick={(e) => { e.stopPropagation(); app.jumpSectionKeyframes(paths, +1); }}
    >
      <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
    </button>
  </Tooltip>
</span>
