<script>
  let count = $state(0);
</script>

<main>
  <h1>Svelte Playground</h1>
  <button onclick={() => count++}>
    Clicked {count} {count === 1 ? 'time' : 'times'}
  </button>
</main>

<style>
  :root {
    --bg: #1a1a2e;
    --fg: #eee;
    --accent: #ff6b6b;
  }

  main {
    font-family: system-ui, sans-serif;
    text-align: center;
    padding: var(--pad, 2rem);
  }

  button {
    font-size: 1.2rem;
    padding: 0.5em 1em;
    cursor: pointer;
  }
</style>
