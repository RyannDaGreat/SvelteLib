<!--
  INTERSECTION ⇄ UNION — the control that decides what a multi-selection pane is
  MADE OF, and the one element-level expression of it.

  USER, 2026-08-02 (properties): "when I have a selection of multiple objects, on
  the very top it should let me say intersection or union … Same behaviour for
  both."
  USER, 2026-08-06 (tools): "When I select multiple objects, just like properties,
  I sholud be able to select intersection OR union of available tools."

  ONE STATE, TWO ELEMENTS. `app.multiSelectMode` is the state and both panes read
  it, so the Property Panel and the Tools pane can never show different modes —
  the Save-dot/Save-button ruling's shape ("I said they share the same state, not
  the same element"). Each pane needs its own ELEMENT because panels are
  independently hideable (web/App.svelte's visiblePanels), so a user working with
  the Property Panel closed must still be able to flip it.

  THE WORDS AND THE VENN GLYPHS come from core/multiselect.js
  MULTISELECT_MODE_CHOICES, so the two panes cannot drift on either. The TIPS are
  passed in: each pane's is a different sentence about a different noun (a
  property unifies and keyframes; a tool RUNS), so there is no shared sentence for
  a shared home to hold.

  Styling: `.multi-mode` in app.css (app convention: no <style> blocks). The
  buttons are plain `.btn` taking their toggled state from `.btn.active`, the
  house's one labeled quick-switch language — this mints no new segmented control.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { MULTISELECT_MODE_CHOICES } from "../core/multiselect.js";

  /** `tips` is {intersection, union} — the hover sentence for each mode, this
   *  pane's own. `label` is the group's accessible name ("Which properties to
   *  show" / "Which tools to show"). */
  let { app, tips, label } = $props();

  // LOUD ON A MISSING TIP. A Tooltip with no text renders an empty bubble, which
  // is the "absent, not empty" rule broken in the worst direction — a control
  // that looks like it explains itself and does not. Checked here, at mount,
  // beside the author of the call site rather than in a screenshot.
  for (const { mode } of MULTISELECT_MODE_CHOICES)
    if (!tips?.[mode])
      throw new Error(`MultiSelectModeToggle: no tip for mode "${mode}" — every mode needs the sentence explaining what this pane shows in it.`);

  // The ICON SIZE is the toggle's own, one notch below the pane's 16px action
  // icons: the Venn glyph is a HINT for the word beside it, not the control's
  // subject, so it reads as a mark on the label rather than a second icon button.
  const ICON_PX = 14;
</script>

<div class="multi-mode" role="group" aria-label={label}>
  {#each MULTISELECT_MODE_CHOICES as choice (choice.mode)}
    <Tooltip text={tips[choice.mode]}>
      <button
        class="btn"
        class:active={app.multiSelectMode === choice.mode}
        aria-pressed={app.multiSelectMode === choice.mode}
        onclick={() => app.setMultiSelectMode(choice.mode)}
      >
        <iconify-icon icon={choice.icon} width={ICON_PX} height={ICON_PX}></iconify-icon>
        {choice.label}
      </button>
    </Tooltip>
  {/each}
</div>
