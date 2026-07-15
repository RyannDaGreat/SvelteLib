<!--
  FpsCounter — rolling frames-per-second readout. BROWSER setting, OFF by
  default, toggled via the palette ("Toggle FPS Counter"). Always bottom-LEFT,
  including present mode (user spec: "little box with some green numbers").

  Measures REAL RENDERED FRAMES: the editor viewport and the presenter bump
  app.renderFrameCount on every actual paint, and this shows renders in the
  trailing 1000 ms — the literal fps of what's drawn (user round-11
  refinement: in present mode this is the PRESENTATION's frame rate, never
  the UI thread's idle tick rate, which sits at the display rate even while
  nothing paints). 0 at rest is truthful: nothing repainted.

  Styling lives in app.css (.fps-counter; app convention: no <style> blocks).
-->
<script>
  import { onMount } from "svelte";

  let { app } = $props();

  let fps = $state(0);

  onMount(() => {
    const samples = []; // [time, renderFrameCount] at display tick rate
    let raf;
    const tick = (t) => {
      samples.push([t, app.renderFrameCount]);
      while (samples.length && t - samples[0][0] > 1000) samples.shift();
      const dt = (t - samples[0][0]) / 1000;
      fps = dt > 0 ? Math.round((app.renderFrameCount - samples[0][1]) / dt) : 0;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="fps-counter">{fps}</div>
