<!--
  ThumbList — left pane: a toolbar (filter + sort + scroll-to-current) over a
  scrollable grid of square video thumbnails. Each thumbnail is the clip's
  middle-frame JPEG (from the backend), its duration, and a yellow outline when
  it has annotations/comments. Clicking a thumbnail loads that clip. The current
  clip is always shown even if the filter would exclude it.
-->
<script>
  import "iconify-icon";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import Thumbnail from "../../../lib/Thumbnail.svelte";
  import { frameUrl } from "./api.js";
  import { formatTimeMinSec } from "../../../lib/format.js";

  let {
    /** @type {{name:string,duration:number,hasAnnotations:boolean}[]} */
    videos = [],
    /** @type {string|null} currently-loaded clip name */
    currentName = null,
    /** @type {(name:string)=>void} */
    onselect = () => {},
  } = $props();

  const THUMB_SIZE_PX = 480; // thumbnails are small — fetch a downscaled JPEG

  const FILTERS = [
    { value: "all", label: "All clips" },
    { value: "annotated", label: "Annotated" },
    { value: "unannotated", label: "Not annotated" },
  ];
  const SORTS = [
    { value: "name", label: "Name" },
    { value: "duration", label: "Duration" },
    { value: "annotated", label: "Annotated first" },
  ];

  let filter = $state("all");
  let sort = $state("name");

  let shown = $derived.by(() => {
    // The current clip is always kept, regardless of the filter.
    const keep = (v) => v.name === currentName;
    let list = videos;
    if (filter === "annotated") list = list.filter((v) => v.hasAnnotations || keep(v));
    else if (filter === "unannotated") list = list.filter((v) => !v.hasAnnotations || keep(v));
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      duration: (a, b) => (a.duration ?? 0) - (b.duration ?? 0),
      annotated: (a, b) => Number(b.hasAnnotations) - Number(a.hasAnnotations),
    }[sort];
    return [...list].sort(by);
  });

  function scrollToCurrent() {
    document.querySelector(".thumb.ring-current")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
</script>

<div class="thumblist">
  <div class="controls">
    <Dropdown items={FILTERS} bind:value={filter} />
    <Dropdown items={SORTS} bind:value={sort} />
    <button class="scrollto" onclick={scrollToCurrent} disabled={!currentName} title="Scroll to current clip">
      <iconify-icon icon="mdi:target" width="18" height="18"></iconify-icon>
    </button>
  </div>

  <div class="scroll">
    {#each shown as v (v.name)}
      <Thumbnail
        src={frameUrl(v.name, (v.duration ?? 0) / 2, THUMB_SIZE_PX)}
        badge={formatTimeMinSec(v.duration)}
        ring={v.name === currentName ? "current" : v.hasAnnotations ? "comment" : "none"}
        title={v.name}
        onclick={() => onselect(v.name)}
      />
    {/each}
    {#if shown.length === 0}
      <p class="empty">No clips.</p>
    {/if}
  </div>
</div>
