<script>
  import SyncCompare from "../../lib/SyncCompare.svelte";
</script>

<main class="demo-page">
  <h1>SyncCompare Demo</h1>
  <p class="demo-hint">Synchronized two-video comparison with shared transport, pan/zoom, and swap.</p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <h2>Natural speed</h2>
  <div class="compare-frame">
    <SyncCompare
      srcA="https://www.shutterstock.com/shutterstock/videos/3931908835/preview/stock-footage-brown-and-white-border-collie-running-in-mountains-in-autumn-slow-motion.webm"
      srcB="https://www.shutterstock.com/shutterstock/videos/3838561601/preview/stock-footage-slow-motion-portrait-wet-brown-and-white-dog-wades-through-shallow-river-water-carrying-a-stick.webm"
    />
  </div>

  <h2>Synced to 3 seconds</h2>
  <div class="compare-frame">
    <SyncCompare
      srcA="https://www.shutterstock.com/shutterstock/videos/3931908835/preview/stock-footage-brown-and-white-border-collie-running-in-mountains-in-autumn-slow-motion.webm"
      srcB="https://www.shutterstock.com/shutterstock/videos/3838561601/preview/stock-footage-slow-motion-portrait-wet-brown-and-white-dog-wades-through-shallow-river-water-carrying-a-stick.webm"
      syncDuration={3}
    />
  </div>
</main>

<style>
  .compare-frame {
    width: 100%;
    max-width: 90vw;
    margin-bottom: 2rem;
  }

  h2 {
    margin-top: 1rem;
    margin-bottom: 0.5rem;
  }
</style>
