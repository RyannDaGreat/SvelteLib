<!--
  VideoPane — the pan/zoomable video area. Wraps the main + proxy <video> in a
  PanZoom viewport (wheel/pinch zoom + pan, scoped to this pane), shows a green/
  red glow for the region under the playhead, a MiniMap overview, and a reset.
  The Player (passed in) drives the video elements via its attach actions.
-->
<script>
  import PanZoom from "../../../lib/PanZoom.svelte";
  import MiniMap from "../../../lib/MiniMap.svelte";

  let {
    /** @type {import('../../../lib/player.svelte.js').Player} */
    player,
    src,
    proxySrc = undefined,
  } = $props();

  let paneW = $state(0);
  let paneH = $state(0);
  let viewport = $state({ zoom: 1, panX: 0, panY: 0 });
  let isDefault = $derived(viewport.zoom === 1 && viewport.panX === 0 && viewport.panY === 0);
</script>

<div class="videopane" bind:clientWidth={paneW} bind:clientHeight={paneH}>
  <PanZoom onviewport={(v) => (viewport = v)}>
    {#snippet children(vp, actions)}
      <!-- World = full pane; the video is centered inside it, so MiniMap's
           container-sized world bounds stay exact under pan/zoom. -->
      <div
        class="world"
        style="transform: translate({vp.panX}px, {vp.panY}px) scale({vp.zoom}); transform-origin: 0 0"
      >
        <div
          class="frame"
          class:glow-good={player.currentLabel === "good"}
          class:glow-bad={player.currentLabel === "bad"}
        >
          {#if proxySrc}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="proxy" use:player.attachProxy src={proxySrc} muted playsinline preload="auto"></video>
          {/if}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            class="main"
            class:revealing={proxySrc && player.mainSeeking}
            use:player.attachMain
            {src}
            muted
            playsinline
            preload="metadata"
          ></video>
        </div>
      </div>

      <div class="minimap" class:hidden={isDefault}>
        <MiniMap
          viewport={vp}
          containerWidth={paneW}
          containerHeight={paneH}
          worldBounds={{ x: 0, y: 0, w: paneW, h: paneH }}
          visible={!isDefault}
        />
      </div>

      <button class="reset" onclick={actions.reset} disabled={isDefault} title="Reset view">
        <iconify-icon icon="mdi:fit-to-screen-outline" width="18" height="18"></iconify-icon>
      </button>
    {/snippet}
  </PanZoom>
</div>

