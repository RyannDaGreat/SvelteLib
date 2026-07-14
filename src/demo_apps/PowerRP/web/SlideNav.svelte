<!--
  SlideNav — the left-hand slide navigator. Shows display NUMBERS (which
  shift on insert) while slides keep permanent UUIDs underneath.
-->
<script>
  import "iconify-icon";

  let { app } = $props();
</script>

<div class="slidenav">
  <div class="slides">
    {#each app.doc.slides as slide, i (slide.id)}
      <button
        class="slide"
        class:current={i === app.slideIndex}
        class:disabled={slide.enabled === false}
        onclick={() => (app.slideIndex = i)}
        title={slide.id}
      >
        <span class="num">{i + 1}</span>
        <span class="name">{slide.name}</span>
        <span class="kfcount">{Object.keys(slide.delta).length ? "◆" : ""}</span>
        <span
          class="eye"
          role="button"
          tabindex="-1"
          title={slide.enabled === false ? "Enable slide (apply its delta)" : "Disable slide (skip its delta)"}
          onclick={(e) => { e.stopPropagation(); app.toggleSlide(i); }}
          onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); app.toggleSlide(i); } }}
        >
          <iconify-icon icon={slide.enabled === false ? "mdi:eye-off" : "mdi:eye"} width="14" height="14"></iconify-icon>
        </span>
      </button>
    {/each}
  </div>
  <div class="nav-actions">
    <button class="btn-icon" onclick={() => app.runCommand("new-slide")} title="New slide after current">
      <iconify-icon icon="mdi:plus" width="16" height="16"></iconify-icon>
    </button>
    <button class="btn-icon" onclick={() => app.runCommand("move-slide-up")} title="Move slide up">
      <iconify-icon icon="mdi:arrow-up" width="16" height="16"></iconify-icon>
    </button>
    <button class="btn-icon" onclick={() => app.runCommand("move-slide-down")} title="Move slide down">
      <iconify-icon icon="mdi:arrow-down" width="16" height="16"></iconify-icon>
    </button>
    <button class="btn-icon" onclick={() => app.runCommand("delete-slide")} title="Delete slide" disabled={app.doc.slides.length <= 1}>
      <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
    </button>
  </div>
</div>
