<script>
  const components = [
    { name: "PanZoom", description: "Headless pan/zoom viewport controller", href: "/src/demos/PanZoom/demo.html" },
    { name: "SyncPlayer", description: "Headless synchronized multi-video controller", href: "/src/demos/SyncPlayer/demo.html" },
    { name: "SplitView + SplitPane", description: "Headless split controller + styled resizable panes", href: "/src/demos/SplitView/demo.html" },
    { name: "Dropdown", description: "Themable single-select with snippet hooks for trigger/item/header/footer", href: "/src/demos/Dropdown/demo.html" },
    { name: "DraggableNumber", description: "Click-drag numeric scrubber (pointer-lock, unbounded, optional grip wheel)", href: "/src/demos/DraggableNumber/demo.html" },
    { name: "ScrubSelect", description: "Video scrub + region annotation widget (paint good/bad, zoomable timeline)", href: "/src/demos/ScrubSelect/demo.html" },
    { name: "SpeechToText", description: "Headless live dictation via the Web Speech API (interim streaming + finalized log)", href: "/src/demos/SpeechToText/demo.html" },
    { name: "Tooltip", description: "Immediate hover/focus tooltip wrapper (optional delay, auto-flip top/bottom, text or rich snippet)", href: "/src/demos/Tooltip/demo.html" },
    { name: "DirtyImage", description: "Lazy, dirty-tracked raster tile — renders via a callback at displayed-size × dpr only when visible AND dirty (crisp thumbnails at scale)", href: "/src/demos/DirtyImage/demo.html" },
  ];
</script>

<main class="hub-page">
  <h1>Svelte Components</h1>
  <ul>
    {#each components as c}
      <li><a href={c.href}>{c.name}</a> — {c.description}</li>
    {/each}
  </ul>
</main>
