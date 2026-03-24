<script>
  import SyncPlayer from "../../lib/SyncPlayer.svelte";
  import ScrubBar from "../../lib/ScrubBar.svelte";
  import SwapPair from "../../lib/SwapPair.svelte";
  import PanZoom from "../../lib/PanZoom.svelte";

  let swapped = $state(false);

  /* Synced PanZoom: whichever one the user interacts with drives the other.
     The guard prevents infinite onviewport ping-pong. */
  let pzActions = { a: null, b: null };
  let syncing = false;

  function syncFrom(source) {
    return (vp) => {
      if (syncing) return;
      syncing = true;
      const target = source === "a" ? pzActions.b : pzActions.a;
      target?.setViewport(vp);
      syncing = false;
    };
  }
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
                  style="transform: translate({viewport.panX}px, {viewport.panY}px) scale({viewport.zoom}); transform-origin: 0 0"
                ></video>
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
                  style="transform: translate({viewport.panX}px, {viewport.panY}px) scale({viewport.zoom}); transform-origin: 0 0"
                ></video>
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
            <button onclick={() => { pzActions.a?.reset(); pzActions.b?.reset(); }} title="Reset zoom">
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

  .controls-row {
    width: 100%;
    max-width: 90vw;
  }
</style>
