<!--
  KeyframePanel — the chronological delta browser from the manifest spec:
  every keyframe leaf across all slides, labeled with its (display) slide
  number, with a "Go To" per slide and a remove button per keyframe.
  Slide numbers may shift on insert; UUIDs (shown on hover) never do.
-->
<script>
  import "iconify-icon";
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

  function fmt(v) {
    if (v === null) return "∅ (delete)";
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
    return String(v);
  }
</script>

<div class="kfpanel">
  {#each groups as [slideIndex, ks] (app.doc.slides[slideIndex].id)}
    <div class="kfslide" class:current={slideIndex === app.slideIndex}>
      <div class="kfslide-head" title={app.doc.slides[slideIndex].id}>
        <span class="num">Slide {slideIndex + 1}</span>
        <button class="btn goto" onclick={() => (app.slideIndex = slideIndex)}>Go To</button>
      </div>
      {#each ks as k}
        <div class="kf" class:selected={k.path[1] === app.selection}>
          <span class="path" title={k.path.join(".")}>{[app.displayName(k.path[1]), ...k.path.slice(2)].join(".")}</span>
          <span class="value">{fmt(k.value)}</span>
          <button class="remove" title="Remove this keyframe" onclick={() => app.removeKey(slideIndex, k.path)}>
            <iconify-icon icon="mdi:close" width="13" height="13"></iconify-icon>
          </button>
        </div>
      {/each}
    </div>
  {/each}
</div>
