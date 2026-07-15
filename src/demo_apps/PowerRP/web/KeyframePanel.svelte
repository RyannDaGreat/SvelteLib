<!--
  KeyframePanel — the chronological delta browser from the manifest spec:
  every keyframe leaf across all slides, labeled with its (display) slide
  number, with a "Go To" per slide and a remove button per keyframe.
  Slide numbers may shift on insert; UUIDs (shown on hover) never do.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { allKeyframes } from "../core/document.js";

  let { app } = $props();

  let groups = $derived.by(() => {
    const ks = allKeyframes(app.doc);
    const bySlide = new Map();
    for (const k of ks) {
      if (!bySlide.has(k.slideIndex)) bySlide.set(k.slideIndex, []);
      bySlide.get(k.slideIndex).push(k);
    }
    return [...bySlide.entries()].sort((a, b) => a[0] - b[0]);
  });

  // Set-aware: every selected item's keyframes highlight (multi-select
  // substrate) — falls back to the single primary when nothing multi is set.
  let selectedIds = $derived(new Set(app.selectedIds()));

  // null (the delete sentinel) renders in the template as an mdi icon +
  // "delete" (iconify-only rule — no Unicode ∅ glyph), so fmt never sees it.
  function fmt(v) {
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
    return String(v);
  }
</script>

<div class="kfpanel">
  {#each groups as [slideIndex, ks] (app.doc.slides[slideIndex].id)}
    <div class="kfslide" class:current={slideIndex === app.slideIndex}>
      <div class="kfslide-head">
        <Tooltip text={app.doc.slides[slideIndex].id}>
          <span class="num">Slide {slideIndex + 1}</span>
        </Tooltip>
        <button class="btn goto" onclick={() => (app.slideIndex = slideIndex)}>Go To</button>
      </div>
      {#each ks as k}
        <div class="kf" class:selected={selectedIds.has(k.path[1])}>
          <Tooltip text={k.path.join(".")}>
            <span class="path">{[app.displayName(k.path[1]), ...k.path.slice(2)].join(".")}</span>
          </Tooltip>
          <span class="value">
            {#if k.value === null}
              <!-- The delete sentinel: this keyframe REMOVES the key. -->
              <iconify-icon icon="mdi:cancel" width="12" height="12"></iconify-icon> delete
            {:else}
              {fmt(k.value)}
            {/if}
          </span>
          <Tooltip text="Remove this keyframe">
            <button class="remove" aria-label="Remove keyframe" onclick={() => app.removeKey(slideIndex, k.path)}>
              <iconify-icon icon="mdi:close" width="13" height="13"></iconify-icon>
            </button>
          </Tooltip>
        </div>
      {/each}
    </div>
  {/each}
</div>
