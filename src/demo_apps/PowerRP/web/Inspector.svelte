<!--
  Inspector — properties of the selected item, rows declared BY THE PLUGIN
  (plugin.inspector), rendered generically. Every row carries keyframe
  controls per the manifest spec:
    ◆/◇  insert/remove keyframe for this property on the CURRENT slide
    ‹ ›  jump to prev/next slide holding a keyframe for it
  Editing a value always writes a keyframe on the current slide.
  The item dropdown includes non-bbox widgets (blur layers) — selection
  doesn't require canvas geometry.
-->
<script>
  let { app } = $props();

  let nodes = $derived(app.nodes());
  let sel = $derived(app.selectedNode());

  function commitField(key, kind, raw) {
    const value = kind === "number" ? Number(raw) : kind === "checkbox" ? Boolean(raw) : raw;
    if (kind === "number" && Number.isNaN(value)) return;
    app.keyframeSelected(key, value);
  }

  function toggleKey(key) {
    if (app.hasKey(key)) app.removeKey(app.slideIndex, ["items", app.selection, key]);
    else app.keyframeSelected(key, sel.state[key]);
  }
</script>

<div class="inspector">
  <div class="inspector-head">
    <select
      value={app.selection ?? ""}
      onchange={(e) => (app.selection = e.target.value || null)}
    >
      <option value="">— select item —</option>
      {#each nodes as n (n.id)}
        <option value={n.itemId}>{n.plugin.title} ({n.itemId})</option>
      {/each}
    </select>
  </div>

  {#if sel}
    <div class="rows">
      {#each sel.plugin.inspector ?? [] as row (row.key)}
        <div class="row">
          <span class="label">{row.label}</span>
          {#if row.kind === "number"}
            <input
              type="number"
              step="any"
              value={Math.round((sel.state[row.key] ?? 0) * 1000) / 1000}
              onchange={(e) => commitField(row.key, row.kind, e.target.value)}
            />
          {:else if row.kind === "color"}
            <input
              type="color"
              value={sel.state[row.key] ?? "#000000"}
              onchange={(e) => commitField(row.key, row.kind, e.target.value)}
            />
          {:else if row.kind === "checkbox"}
            <input
              type="checkbox"
              checked={Boolean(sel.state[row.key])}
              onchange={(e) => commitField(row.key, row.kind, e.target.checked)}
            />
          {:else}
            <input
              type="text"
              value={sel.state[row.key] ?? ""}
              onchange={(e) => commitField(row.key, row.kind, e.target.value)}
            />
          {/if}
          <button
            class="keybtn"
            class:keyed={app.hasKey(row.key)}
            title={app.hasKey(row.key) ? "Remove keyframe on this slide" : "Insert keyframe on this slide"}
            onclick={() => toggleKey(row.key)}
          >◆</button>
          <button class="jumpbtn" title="Previous keyframe" onclick={() => app.jumpKeyframe(row.key, -1)}>‹</button>
          <button class="jumpbtn" title="Next keyframe" onclick={() => app.jumpKeyframe(row.key, +1)}>›</button>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty">Nothing selected</div>
  {/if}
</div>
