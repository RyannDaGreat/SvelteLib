<script>
  const components = [
    { name: "PanZoom", description: "Headless pan/zoom viewport controller", href: "/src/demos/PanZoom/demo.html" },
  ];
</script>

<main>
  <h1>Svelte Components</h1>
  <ul>
    {#each components as c}
      <li><a href={c.href}>{c.name}</a> — {c.description}</li>
    {/each}
  </ul>
</main>

<style>
  :root {
    --bg: #1a1a2e;
    --fg: #eee;
    --accent: #e94560;
  }

  main {
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    min-height: 100vh;
    padding: 2rem;
  }

  ul {
    list-style: none;
    padding: 0;
  }

  li {
    margin: 0.5rem 0;
    font-size: 1.1rem;
  }

  a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  a:hover { text-decoration: underline; }
</style>
