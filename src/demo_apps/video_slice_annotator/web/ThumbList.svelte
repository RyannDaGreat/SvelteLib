<!--
  ThumbList — left pane: filter + sort dropdowns over a scrollable list of video
  thumbnails. Each thumbnail is the clip's middle-frame JPEG (from the backend),
  its duration, and a yellow outline when it already has annotations/comments.
  Clicking a thumbnail loads that clip.
-->
<script>
  import Dropdown from "../../../lib/Dropdown.svelte";
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
    let list = videos;
    if (filter === "annotated") list = list.filter((v) => v.hasAnnotations);
    else if (filter === "unannotated") list = list.filter((v) => !v.hasAnnotations);
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      duration: (a, b) => (a.duration ?? 0) - (b.duration ?? 0),
      annotated: (a, b) => Number(b.hasAnnotations) - Number(a.hasAnnotations),
    }[sort];
    return [...list].sort(by);
  });
</script>

<div class="thumblist">
  <div class="controls">
    <label>Filter <Dropdown items={FILTERS} bind:value={filter} /></label>
    <label>Sort <Dropdown items={SORTS} bind:value={sort} /></label>
  </div>

  <div class="scroll">
    {#each shown as v (v.name)}
      <button
        class="thumb"
        class:annotated={v.hasAnnotations}
        class:current={v.name === currentName}
        onclick={() => onselect(v.name)}
        title={v.name}
      >
        <div class="thumb-img">
          <img src={frameUrl(v.name, (v.duration ?? 0) / 2)} alt="" loading="lazy" />
          <span class="dur">{formatTimeMinSec(v.duration)}</span>
        </div>
      </button>
    {/each}
    {#if shown.length === 0}
      <p class="empty">No clips.</p>
    {/if}
  </div>
</div>

