<!--
  ResizeHandles [visual, general] — reusable SVG resize handles.
  Takes screen-space handle positions [{id, x, y}] and reports pointerdowns.
  Pure presentation: owns no geometry logic, so any widget/editor can reuse it.
-->
<script>
  let { handles = [], onstart } = $props();

  const CURSORS = {
    tl: "nwse-resize", br: "nwse-resize",
    tr: "nesw-resize", bl: "nesw-resize",
    tm: "ns-resize", bm: "ns-resize",
    ml: "ew-resize", mr: "ew-resize",
  };
</script>

{#each handles as h}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <rect
    class="handle"
    x={h.x - 4}
    y={h.y - 4}
    width="8"
    height="8"
    style:cursor={CURSORS[h.id]}
    onpointerdown={(e) => onstart(h.id, e)}
  />
{/each}

<!-- Styling lives in app.css (app convention: no <style> blocks in app components). -->
