<!--
  SyncCompare [composed, opinionated] — synchronized two-video comparison.

  Batteries-included binary video comparator. Assembles SyncPlayer,
  SwapPair, PanZoom, MiniMap, and ScrubBar into a complete comparison
  UI with synced pan/zoom, hold-to-swap, and shared transport controls.

  Usage:
    <SyncCompare srcA="/videos/a.mp4" srcB="/videos/b.mp4" />

  With clip ranges:
    <SyncCompare
      srcA="/videos/a.mp4" startA={2} endA={8}
      srcB="/videos/b.mp4" startB={0} endB={6}
      syncDuration={6}
    />
-->
<script>
  import "iconify-icon";
  import SyncPlayer from "./SyncPlayer.svelte";
  import ScrubBar from "./ScrubBar.svelte";
  import SwapPair from "./SwapPair.svelte";
  import PanZoom from "./PanZoom.svelte";
  import MiniMap from "./MiniMap.svelte";

  let {
    /** @type {string} Video source A */
    srcA,
    /** @type {string} Video source B */
    srcB,
    /** @type {number} [startA] Clip start for A in seconds */
    startA = undefined,
    /** @type {number} [endA] Clip end for A in seconds */
    endA = undefined,
    /** @type {number} [startB] Clip start for B in seconds */
    startB = undefined,
    /** @type {number} [endB] Clip end for B in seconds */
    endB = undefined,
    /** @type {number} [syncDuration] Force both clips to this duration */
    syncDuration = undefined,
  } = $props();

  /* Build register configs, omitting undefined keys so SyncPlayer uses defaults */
  function regConfig(start, end) {
    const c = {};
    if (start != null) c.start = start;
    if (end != null) c.end = end;
    return c;
  }

  let swapped = $state(false);

  /* Synced PanZoom: whichever one the user interacts with drives the other.
     The guard prevents infinite onviewport ping-pong. */
  let pzActions = { a: null, b: null };
  let syncing = false;
  let pzViewport = $state({ zoom: 1, panX: 0, panY: 0 });
  let isDefaultVp = $derived(pzViewport.zoom === 1 && pzViewport.panX === 0 && pzViewport.panY === 0);

  function syncFrom(source) {
    return (vp) => {
      pzViewport = vp;
      if (syncing) return;
      syncing = true;
      const target = source === "a" ? pzActions.b : pzActions.a;
      target?.setViewport(vp);
      syncing = false;
    };
  }

  /* Reactive container dimensions via Svelte bindings */
  let vidClientW = $state({ a: 0, b: 0 });
  let vidClientH = $state({ a: 0, b: 0 });

  /* Pan/zoom only active when focused — click to focus, click outside to blur */
  let focused = $state(false);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="sync-compare"
  class:focused
  tabindex="0"
  onfocusin={() => focused = true}
  onfocusout={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) focused = false; }}
>
  <SyncPlayer {syncDuration}>
    {#snippet children(state, actions)}
      <div class="sync-compare-videos">
        <SwapPair {swapped}>
          {#snippet a()}
            <PanZoom active={focused} onviewport={syncFrom("a")}>
              {#snippet children(viewport, pzActs)}
                {@const _ = (pzActions.a = pzActs)}
                <video
                  use:actions.register={regConfig(startA, endA)}
                  src={srcA}
                  muted
                  bind:clientWidth={vidClientW.a}
                  bind:clientHeight={vidClientH.a}
                  style="transform: translate({viewport.panX}px, {viewport.panY}px) scale({viewport.zoom}); transform-origin: 0 0"
                ></video>
                <div class="sync-compare-minimap">
                  <MiniMap
                    {viewport}
                    containerWidth={vidClientW.a}
                    containerHeight={vidClientH.a}
                    worldBounds={{ x: 0, y: 0, w: vidClientW.a, h: vidClientH.a }}
                    visible={focused && !isDefaultVp}
                  />
                </div>
              {/snippet}
            </PanZoom>
          {/snippet}
          {#snippet b()}
            <PanZoom active={focused} onviewport={syncFrom("b")}>
              {#snippet children(viewport, pzActs)}
                {@const _ = (pzActions.b = pzActs)}
                <video
                  use:actions.register={regConfig(startB, endB)}
                  src={srcB}
                  muted
                  bind:clientWidth={vidClientW.b}
                  bind:clientHeight={vidClientH.b}
                  style="transform: translate({viewport.panX}px, {viewport.panY}px) scale({viewport.zoom}); transform-origin: 0 0"
                ></video>
                <div class="sync-compare-minimap">
                  <MiniMap
                    {viewport}
                    containerWidth={vidClientW.b}
                    containerHeight={vidClientH.b}
                    worldBounds={{ x: 0, y: 0, w: vidClientW.b, h: vidClientH.b }}
                    visible={focused && !isDefaultVp}
                  />
                </div>
              {/snippet}
            </PanZoom>
          {/snippet}
        </SwapPair>
      </div>
      <ScrubBar {state} {actions}>
        {#snippet extra()}
          <button
            onpointerdown={() => swapped = true}
            onpointerup={() => swapped = false}
            onpointerleave={() => swapped = false}
            onpointercancel={() => swapped = false}
            title="Hold to swap"
          >
            <iconify-icon icon="mdi:swap-horizontal" width="20" height="20"></iconify-icon>
          </button>
          <button
            onclick={() => { pzActions.a?.reset(); pzActions.b?.reset(); }}
            title="Reset zoom"
            disabled={isDefaultVp}
          >
            <iconify-icon icon="mdi:magnify-close" width="20" height="20"></iconify-icon>
          </button>
        {/snippet}
      </ScrubBar>
    {/snippet}
  </SyncPlayer>
</div>

<style>
  .sync-compare {
    outline: none;
    border-radius: var(--sync-compare-radius, 8px);
  }
  .sync-compare.focused {
    outline: 1px solid rgba(255, 255, 255, 0.5);
  }

  .sync-compare-videos {
    display: flex;
    gap: var(--sync-compare-gap, 12px);
    margin-bottom: var(--sync-compare-gap, 12px);
  }

  .sync-compare-videos > :global(.swap-item) {
    flex: 1;
    min-width: 0;
  }

  .sync-compare-videos :global(video) {
    width: 100%;
    border-radius: var(--sync-compare-radius, 8px);
    background: #000;
  }

  .sync-compare-minimap {
    position: absolute;
    bottom: 8px;
    right: 8px;
  }
</style>
