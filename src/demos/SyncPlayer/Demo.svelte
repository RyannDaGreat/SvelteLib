<script>
  import SyncPlayer from "../../lib/SyncPlayer.svelte";
  import ScrubBar from "../../lib/ScrubBar.svelte";
  import SwapPair from "../../lib/SwapPair.svelte";
  import PanZoom from "../../lib/PanZoom.svelte";
  import MiniMap from "../../lib/MiniMap.svelte";

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
</script>

<main class="demo-page">
  <h1>SyncPlayer Demo</h1>
  <p class="demo-hint">Synchronized multi-video playback with shared transport controls.</p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <SyncPlayer>
    {#snippet children(state, actions)}
      <div class="video-row">
        <SwapPair {swapped}>
          {#snippet a()}
            <PanZoom onviewport={syncFrom("a")}>
              {#snippet children(viewport, pzActs)}
                {@const _ = (pzActions.a = pzActs)}
                <video
                  use:actions.register
                  src="/videos/sample_24fps.mp4"
                  muted
                  bind:clientWidth={vidClientW.a}
                  bind:clientHeight={vidClientH.a}
                  style="transform: translate({viewport.panX}px, {viewport.panY}px) scale({viewport.zoom}); transform-origin: 0 0"
                ></video>
                <div class="minimap-container">
                  <MiniMap
                    {viewport}
                    containerWidth={vidClientW.a}
                    containerHeight={vidClientH.a}
                    worldBounds={{ x: 0, y: 0, w: vidClientW.a, h: vidClientH.a }}
                  />
                </div>
              {/snippet}
            </PanZoom>
          {/snippet}
          {#snippet b()}
            <PanZoom onviewport={syncFrom("b")}>
              {#snippet children(viewport, pzActs)}
                {@const _ = (pzActions.b = pzActs)}
                <video
                  use:actions.register
                  src="/videos/sample_48fps.mp4"
                  muted
                  bind:clientWidth={vidClientW.b}
                  bind:clientHeight={vidClientH.b}
                  style="transform: translate({viewport.panX}px, {viewport.panY}px) scale({viewport.zoom}); transform-origin: 0 0"
                ></video>
                <div class="minimap-container">
                  <MiniMap
                    {viewport}
                    containerWidth={vidClientW.b}
                    containerHeight={vidClientH.b}
                    worldBounds={{ x: 0, y: 0, w: vidClientW.b, h: vidClientH.b }}
                  />
                </div>
              {/snippet}
            </PanZoom>
          {/snippet}
        </SwapPair>
      </div>
      <div class="controls-row">
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
      </div>
    {/snippet}
  </SyncPlayer>
</main>

<style>
  .video-row {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
    max-width: 90vw;
  }

  /* SwapPair wrapper divs are the flex children */
  .video-row > :global(.swap-item) {
    flex: 1;
    min-width: 0;
  }

  .video-row video {
    width: 100%;
    border-radius: 8px;
    background: #000;
  }

  .minimap-container {
    position: absolute;
    bottom: 8px;
    right: 8px;
  }

  .controls-row {
    width: 100%;
    max-width: 90vw;
  }
</style>
