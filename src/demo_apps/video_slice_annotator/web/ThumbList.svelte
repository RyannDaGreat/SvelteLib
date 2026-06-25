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
  import ThumbnailContainer from "../../../lib/ThumbnailContainer.svelte";
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
  const THUMB_MIN_PX = 120; // smallest square tile; tiles grow past this to fill
  const THUMB_GAP_PX = 10;
  const THUMB_PAD_PX = 10;

  const FILTERS = [
    { value: "all", label: "All clips" },
    { value: "annotated", label: "Annotated" },
    { value: "unannotated", label: "Not annotated" },
  ];
  const SORTS = [
    { value: "name", label: "Name" },
    { value: "duration", label: "Duration" },
    { value: "annotated", label: "Annotated first" },
    { value: "random", label: "Random" },
  ];

  let filter = $state("all");
  let sort = $state("name");

  // Random sort: give each clip a stable random rank, re-rolled when Random is
  // (re-)selected or the clip list changes — so the order doesn't reshuffle on
  // every unrelated re-render.
  let randomRank = $state(new Map());
  $effect(() => {
    if (sort !== "random") return;
    randomRank = new Map(videos.map((v) => [v.name, Math.random()]));
  });

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
      random: (a, b) => (randomRank.get(a.name) ?? 0) - (randomRank.get(b.name) ?? 0),
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

  {#if shown.length === 0}
    <p class="empty">No clips.</p>
  {:else}
    <ThumbnailContainer class="scroll" minSize={THUMB_MIN_PX} gap={THUMB_GAP_PX} padding={THUMB_PAD_PX}>
      {#each shown as v (v.name)}
        <Thumbnail
          src={frameUrl(v.name, (v.duration ?? 0) / 2, THUMB_SIZE_PX)}
          badge={formatTimeMinSec(v.duration)}
          ring={v.name === currentName ? "current" : v.hasAnnotations ? "comment" : "none"}
          title={v.name}
          onclick={() => onselect(v.name)}
        />
      {/each}
    </ThumbnailContainer>
  {/if}
</div>
