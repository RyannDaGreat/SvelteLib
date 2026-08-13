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

  ITS ARROWS GREY OUT WITH NOWHERE TO GO, AND THAT ARRIVED A DAY LATE — the
  lesson this file now carries. The availability was built for the ROW triad on
  2026-08-12 and did not reach here, because "SAME FAMILY, NOT A NEW INVENTION"
  above describes shared CSS CLASSES and copied markup, not shared behaviour. The
  user caught it from the outside (2026-08-13): "The small version didn't seem to
  have inherited this… They're not sharing the same base class or it was
  implemented in the wrong level. Perhaps it should be applied to the parent…
  The code is not the same." Both triads now read ONE descriptor —
  `app.jumpArrowFor` -> core/section_keyframes.jumpArrow — which hands over target,
  disabled and tooltip together, so neither can have half the answer. WHEN YOU ADD
  BEHAVIOUR TO EITHER TRIAD, PUT IT THERE, or this file will silently miss it
  again; tests/keyfr_tools_test.js enumerates the surfacings to make that fail loud.

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

  // EACH ARROW'S WHOLE STATE, from the ONE shared query the row triad also makes
  // (`app.jumpArrowFor` -> core/section_keyframes.jumpArrow). This is the fix for
  // the user's 2026-08-13 report that the row arrows greyed out and THESE did not:
  // this file is the row's markup COPIED, so it inherited nothing until the
  // availability moved into a layer both of them call. `title` rides along as the
  // subject, which is the one thing these tooltips legitimately say differently.
  let prev = $derived(app.jumpArrowFor(paths, -1, title));
  let next = $derived(app.jumpArrowFor(paths, +1, title));

  /** Command. Jumps unless there is nowhere to go — THE GUARD, because these
   * buttons are `aria-disabled` and never natively disabled (a natively disabled
   * button leaves the tab order, taking its own explanation with it). The
   * stopPropagation stays: the header behind this triad is a collapse button, and
   * a refused jump must still not fold the panel out from under the click. */
  function jump(e, direction, arrow) {
    e.stopPropagation();
    if (arrow.disabled) return;
    app.jumpSectionKeyframes(paths, direction);
  }

  // The three readings. `mdi:rhombus-split` is the row bubble's own half-fill
  // mark: at 70% scale a subtler device would stop reading as "partly", and
  // Audulus-restraint is about not being gaudy, not about being illegible.
  const TRI_ICONS = { all: "mdi:rhombus", some: "mdi:rhombus-split", none: "mdi:rhombus-outline" };
</script>

<span class="kf-controls kf-section">
  <Tooltip text={prev.tip}>
    <button
      class="jumpbtn"
      aria-disabled={prev.disabled}
      aria-label={`Previous ${title} keyframe`}
      onclick={(e) => jump(e, -1, prev)}
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
  <Tooltip text={next.tip}>
    <button
      class="jumpbtn"
      aria-disabled={next.disabled}
      aria-label={`Next ${title} keyframe`}
      onclick={(e) => jump(e, +1, next)}
    >
      <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
    </button>
  </Tooltip>
</span>
