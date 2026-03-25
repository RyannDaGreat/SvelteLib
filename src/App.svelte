<script>
  const components = [
    { name: "PanZoom", description: "Headless pan/zoom viewport controller", href: "/src/demos/PanZoom/demo.html" },
    { name: "SyncPlayer", description: "Headless synchronized multi-video controller", href: "/src/demos/SyncPlayer/demo.html" },
    { name: "SplitView", description: "Resizable split pane layout with push & spring-back", href: "/src/demos/SplitView/demo.html" },
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
