<!--
  FpsCounter — rolling frames-per-second readout. BROWSER setting, OFF by
  default, toggled via the palette ("Toggle FPS Counter"). Always bottom-LEFT,
  including present mode (user spec: "little box with some green numbers").

  Measures THIS page's requestAnimationFrame tick rate — the UI thread's real
  frame rate (rAF fires at display refresh when smooth; any jank shows up
  immediately). fps = frames observed in the trailing 1000 ms — the literal
  definition, no tuning constants.

  Styling lives in app.css (.fps-counter; app convention: no <style> blocks).
-->
<script>
  import { onMount } from "svelte";

  let fps = $state(0);

  onMount(() => {
    const stamps = [];
    let raf;
    const tick = (t) => {
      stamps.push(t);
      while (stamps.length && t - stamps[0] > 1000) stamps.shift();
      fps = stamps.length > 1 ? Math.round(((stamps.length - 1) * 1000) / (t - stamps[0])) : 0;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="fps-counter">{fps}</div>
