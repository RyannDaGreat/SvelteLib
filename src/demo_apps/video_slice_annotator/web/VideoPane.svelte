<!--
  VideoPane — the pan/zoomable video area. The frame is sized EXACTLY to the
  video's real aspect (read from the element, never guessed), centered in the
  pane with the green/red glow hugging it. PanZoom (wheel/pinch) transforms the
  whole stage. The minimap mirrors the pane: the current-frame JPEG positioned
  where the video sits, with a rectangle marking the visible (zoomed) region.
-->
<script>
  import "iconify-icon";
  import PanZoom from "../../../lib/PanZoom.svelte";
  import MiniMap from "../../../lib/MiniMap.svelte";
  import { frameUrl } from "./api.js";

  let {
    /** @type {import('../../../lib/player.svelte.js').Player} */
    player,
    src,
    proxySrc = undefined,
    /** @type {string} clip name (for the minimap frame JPEG) */
    name,
  } = $props();

  let paneW = $state(0);
  let paneH = $state(0);
  let vp = $state({ zoom: 1, panX: 0, panY: 0 });
  let isDefault = $derived(vp.zoom === 1 && vp.panX === 0 && vp.panY === 0);

  // Exact contained frame: the real video aspect scaled to fit the pane.
  let frame = $derived.by(() => {
    const vw = player.videoW, vh = player.videoH;
    if (!vw || !vh || !paneW || !paneH) return { w: 0, h: 0, left: 0, top: 0 };
    const s = Math.min(paneW / vw, paneH / vh);
    const w = vw * s, h = vh * s;
    return { w, h, left: (paneW - w) / 2, top: (paneH - h) / 2 };
  });

  // Frame JPEG, refreshed ~1×/s (backend caches per frame index; browser caches img).
  let frameSrc = $derived(name && player.duration ? frameUrl(name, Math.floor(player.currentTime)) : "");

  // Press R anywhere (outside a text field) to reset the view — same as the
  // reset button. Routed through the button so the disabled (already-default)
  // state is respected for free.
  let resetBtn = $state(undefined);
  $effect(() => {
    function onKey(e) {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // let Cmd/Ctrl+R reload the page
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      e.preventDefault();
      resetBtn?.click();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="videopane" bind:clientWidth={paneW} bind:clientHeight={paneH}>
  <PanZoom onviewport={(v) => (vp = v)}>
    {#snippet children(viewport, actions)}
      <div
        class="vp-stage"
        style="transform: translate({viewport.panX}px, {viewport.panY}px) scale({viewport.zoom}); transform-origin: 0 0"
      >
        <div
          class="vp-frame"
          class:glow-good={player.currentLabel === "good"}
          class:glow-bad={player.currentLabel === "bad"}
          style="left: {frame.left}px; top: {frame.top}px; width: {frame.w}px; height: {frame.h}px"
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
        >
          {#snippet children()}
            {#if frameSrc}
              <!-- World-space image of the current frame, where the video sits. -->
              <image href={frameSrc} x={frame.left} y={frame.top} width={frame.w} height={frame.h} preserveAspectRatio="none" />
            {/if}
          {/snippet}
        </MiniMap>
      </div>

      <button class="reset" bind:this={resetBtn} onclick={actions.reset} disabled={isDefault} title="Reset view (R)">
        <iconify-icon icon="mdi:fit-to-screen-outline" width="18" height="18"></iconify-icon>
      </button>
    {/snippet}
  </PanZoom>
</div>
