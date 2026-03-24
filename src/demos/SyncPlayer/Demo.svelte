<script>
  import SyncPlayer from "../../lib/SyncPlayer.svelte";
  import ScrubBar from "../../lib/ScrubBar.svelte";
</script>

<main class="demo-page">
  <h1>SyncPlayer Demo</h1>
  <p class="demo-hint">Synchronized multi-video playback with shared transport controls.</p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <SyncPlayer>
    {#snippet children(state, actions)}
      <div class="video-row">
        <video use:actions.register src="/videos/sample_24fps.mp4" muted></video>
        <video use:actions.register src="/videos/sample_48fps.mp4" muted></video>
      </div>
      <div class="controls-row">
        <ScrubBar {state} {actions} />
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

  .video-row video {
    flex: 1;
    min-width: 0;
    border-radius: 8px;
    background: #000;
  }

  .controls-row {
    width: 100%;
    max-width: 90vw;
  }
</style>
