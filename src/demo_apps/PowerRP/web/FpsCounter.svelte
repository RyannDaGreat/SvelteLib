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

  // Averaging window. Was 1000ms (the literal per-second definition); the
  // user ruled it too sluggish — "whatever averaging window needs to be much
  // shorter" (round 11). 250ms is the common game-HUD cadence: responsive to
  // real rate changes within a quarter second, still steady at 120Hz
  // (~30 samples). Adjust here if the user wants snappier/steadier.
  const WINDOW_MS = 250;

  let fps = $state(0);

  onMount(() => {
    const samples = []; // [time, renderFrameCount] at display tick rate
    let raf;
    const tick = (t) => {
      samples.push([t, app.renderFrameCount]);
      while (samples.length && t - samples[0][0] > WINDOW_MS) samples.shift();
      const dt = (t - samples[0][0]) / 1000;
      fps = dt > 0 ? Math.round((app.renderFrameCount - samples[0][1]) / dt) : 0;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<!-- Right-justified in a 4-character field (user spec: room up to 1000 FPS
     so only the digits change, the text never shifts — mono font + pre). -->
<div class="fps-counter">FPS:{String(fps).padStart(5, " ")}</div>
