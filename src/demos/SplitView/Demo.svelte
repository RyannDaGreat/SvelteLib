<script>
  import SplitView from "../../lib/SplitView.svelte";

  let outerSplits = $state([0.12, 0.38, 0.62, 0.82]);
  let editorSplits = $state([0.55, 0.8]);
  let midSplits = $state([0.5]);
  let propSplits = $state([0.4, 0.7]);
  let navSplits = $state([0.6]);

  function resetAll() {
    outerSplits = [0.12, 0.38, 0.62, 0.82];
    editorSplits = [0.55, 0.8];
    midSplits = [0.5];
    propSplits = [0.4, 0.7];
    navSplits = [0.6];
  }
</script>

<main class="demo-page">
  <h1>SplitView Demo</h1>
  <p class="demo-hint">Drag handles to resize. Handles push neighbors and spring back.</p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <div class="controls demo-controls">
    <button onclick={resetAll}>Reset Layout</button>
    <span class="demo-label">
      outer: [{outerSplits.map(v => v.toFixed(2)).join(', ')}]
    </span>
  </div>

  <div class="demo-frame">
    <SplitView orientation="horizontal" bind:splits={outerSplits} minPaneSize={0.06}>
      {#snippet children(paneIdx)}
        {#if paneIdx === 0}
          <!-- Sidebar: vertical split — file tree / bookmarks -->
          <SplitView orientation="vertical" bind:splits={navSplits} minPaneSize={0.15}>
            {#snippet children(innerIdx)}
              {#if innerIdx === 0}
                <div class="panel nav">Explorer</div>
              {:else}
                <div class="panel bookmarks">Bookmarks</div>
              {/if}
            {/snippet}
          </SplitView>
        {:else if paneIdx === 1}
          <!-- Editor area: vertical 3-way — source / preview / console -->
          <SplitView orientation="vertical" bind:splits={editorSplits} minPaneSize={0.08}>
            {#snippet children(innerIdx)}
              {#if innerIdx === 0}
                <div class="panel editor">Source</div>
              {:else if innerIdx === 1}
                <div class="panel preview">Preview</div>
              {:else}
                <div class="panel terminal">Console</div>
              {/if}
            {/snippet}
          </SplitView>
        {:else if paneIdx === 2}
          <!-- Middle: vertical 2-way — diff / merge -->
          <SplitView orientation="vertical" bind:splits={midSplits} minPaneSize={0.15}>
            {#snippet children(innerIdx)}
              {#if innerIdx === 0}
                <div class="panel diff">Diff</div>
              {:else}
                <div class="panel merge">Merge</div>
              {/if}
            {/snippet}
          </SplitView>
        {:else if paneIdx === 3}
          <!-- Properties: vertical 3-way — props / inspector / outline -->
          <SplitView orientation="vertical" bind:splits={propSplits} minPaneSize={0.1}>
            {#snippet children(innerIdx)}
              {#if innerIdx === 0}
                <div class="panel properties">Properties</div>
              {:else if innerIdx === 1}
                <div class="panel inspector">Inspector</div>
              {:else}
                <div class="panel outline">Outline</div>
              {/if}
            {/snippet}
          </SplitView>
        {:else}
          <div class="panel minimap">Minimap</div>
        {/if}
      {/snippet}
    </SplitView>
  </div>
</main>

<style>
  .controls {
    margin-bottom: 0.5rem;
  }

  .panel {
    --panel-pad: 1rem;

    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--panel-pad);
    font-size: 0.9rem;
    opacity: 0.7;
    user-select: none;
  }

  .nav        { background: #252526; }
  .bookmarks  { background: #1c2333; }
  .editor     { background: #1e1e1e; }
  .preview    { background: #1a2a1a; }
  .terminal   { background: #000; color: #4af626; font-family: monospace; }
  .diff       { background: #2a1e1e; }
  .merge      { background: #1e2a2a; }
  .properties { background: #2d2d30; }
  .inspector  { background: #2a2535; }
  .outline    { background: #1f2937; }
  .minimap    { background: #1a1a2e; }
</style>
