<!--
  SlideRangeField — "which slides" picker: All slides, or a custom From→To
  range. EXTRACTED from RenderCenterModal (the video-render area's slide-range
  selector), per the app's rule that a selector used in two places lives in
  one component — the import dialog needs the identical picker, not a second
  hand-written copy that can drift from the render one.

  THREE BINDABLE PRIMITIVES, NOT ONE OBJECT PROP. RenderCenterModal already
  holds `rangeMode`/`rangeFrom`/`rangeTo` as three separate persisted $state
  fields (see its currentSettings()/applySettings()); mirroring that shape
  here means the refactor is a drop-in replacement — swap three <Dropdown>/
  <DraggableNumber> rows for one <SlideRangeField>, no wrapper object to
  pack/unpack on every read. A caller that wants one bundle can trivially wrap
  these three at its own call site.

  `mode` is "all" | "custom"; `from`/`to` are 1-BASED slide numbers, inclusive,
  clamped to [1, slideCount] — the same convention startIndex/endIndex derive
  from (subtract 1 for a 0-based index). `to` is not force-clamped above
  `from`; a caller reading a 0-length range decides what that means (the
  render planner and the pptx translator both already tolerate empty ranges).

  Usage:
    <SlideRangeField slideCount={12} bind:mode bind:from bind:to />
-->
<script>
  import Dropdown from "../../../lib/Dropdown.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";

  const RANGE_MODES = [
    { value: "all", label: "All slides" },
    { value: "custom", label: "Range…" },
  ];

  let {
    /** @type {number} Total slides in the deck being ranged over. */
    slideCount,
    /** @type {"all"|"custom"} Bindable. */
    mode = $bindable("all"),
    /** @type {number} Bindable. 1-based first slide (inclusive). */
    from = $bindable(1),
    /** @type {number} Bindable. 1-based last slide (inclusive). */
    to = $bindable(slideCount),
  } = $props();
</script>

<div class="range-field-row">
  <span class="range-field-label">Slides</span>
  <span class="range-field-control"><Dropdown items={RANGE_MODES} bind:value={mode} /></span>
</div>
{#if mode === "custom"}
  <div class="range-field-row">
    <span class="range-field-label">From → To</span>
    <span class="range-field-control range-field-inline">
      <DraggableNumber bind:value={from} min={1} max={slideCount} step={1} label="First slide" />
      <span class="range-field-times">→</span>
      <DraggableNumber bind:value={to} min={1} max={slideCount} step={1} label="Last slide" />
    </span>
  </div>
{/if}
