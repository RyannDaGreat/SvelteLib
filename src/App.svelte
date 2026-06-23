<script>
  const components = [
    { name: "PanZoom", description: "Headless pan/zoom viewport controller", href: "/src/demos/PanZoom/demo.html" },
    { name: "SyncPlayer", description: "Headless synchronized multi-video controller", href: "/src/demos/SyncPlayer/demo.html" },
    { name: "SplitView + SplitPane", description: "Headless split controller + styled resizable panes", href: "/src/demos/SplitView/demo.html" },
    { name: "Dropdown", description: "Themable single-select with snippet hooks for trigger/item/header/footer", href: "/src/demos/Dropdown/demo.html" },
    { name: "ScrubSelect", description: "Video scrub + region annotation widget (paint good/bad, zoomable timeline)", href: "/src/demos/ScrubSelect/demo.html" },
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
