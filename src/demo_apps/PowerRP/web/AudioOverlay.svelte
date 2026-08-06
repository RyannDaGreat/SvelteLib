<!--
  AudioOverlay [NF-BIND] — the LIVE half of the analysis nodes' pictures.

  ── THE SEAM THIS COMPONENT IS ──────────────────────────────────────────────
  A level meter's bar and a spectrum node's spectrogram are LIVE AUDIO. That is not
  document state and cannot be made into it: reading a sample buffer inside a
  plugin's emit() would make Δt = 0 produce two different pictures, which breaks the
  determinism law, frame-range sharding and export reproducibility at once
  (CLAUDE.md's "four kinds of state").

  So the picture is split in two, along the line the app already uses for selection
  handles:
    THE PLUGIN paints the STATIC form — the card, the well the bar sits in, the
      family chrome. That is pure, it is in the display list, and it appears in
      exports, in the presenter and in cli/render.js.
    THIS COMPONENT paints the MOTION on top, in screen space, on a 2D canvas that
      no export and no headless renderer ever consults.

  Turn audio off, or render the deck headlessly, and what remains is the static
  form. That is the honest picture of a document that has no sound in it — which is
  why this degrades to nothing rather than to a placeholder: the placeholder is
  already painted, by the plugin, underneath.

  ── WHY A CANVAS AND NOT SVG ────────────────────────────────────────────────
  The spectrogram is a SCROLLING image: every frame shifts the previous frame left
  by one column and draws one new column. On a canvas that is one drawImage of the
  canvas onto itself — the cheapest possible operation, and the reason the history
  needs no buffer at all. In SVG it would be a thousand <rect>s per node, recreated
  every frame, and the DOM cost would show up as jank on the whole editor.

  ── WHY IT RUNS ITS OWN rAF ─────────────────────────────────────────────────
  The data arrives in web/audioMirror.analysisData, a plain Map written by the
  engine's own poll loop. Reading it through Svelte reactivity would schedule a
  component update per meter per frame. Instead this loop reads the Map directly,
  which also means a node with no data simply draws nothing that frame rather than
  needing a "no data" state.

  Styling is in app.css per the app convention (no <style> blocks in app components).
-->
<script>
  import { analysisData, audioState } from "./audioMirror.svelte.js";

  /** `rects`: the geometry from CanvasView's nodeOverlay — [{id, kind, x, y, w, h}]
   *  in SCREEN coordinates. `dpr`: device pixel ratio for a crisp raster. */
  let { rects = [] } = $props();

  /** One <canvas> per analysis node, keyed by item id. Kept because the SPECTROGRAM
   *  IS ITS OWN HISTORY: the scroll is a self-blit, so the pixels already on the
   *  canvas are the last N frames. A shared canvas would make every spectrum node
   *  show the same trace. */
  const canvases = new Map();

  /** The spectrogram's colour ramp: dark blue → teal → warm white. Deliberately
   *  monotonic in LIGHTNESS as well as in hue, so it reads correctly in greyscale
   *  and for a colour-blind viewer — a rainbow ramp (the default choice everywhere)
   *  is neither, and it makes quiet noise look like loud structure. */
  function spectrumColor(v) {
    const t = v / 255;
    if (t < 0.5) {
      const u = t * 2;
      return `rgb(${Math.round(18 + 40 * u)}, ${Math.round(24 + 90 * u)}, ${Math.round(38 + 70 * u)})`;
    }
    const u = (t - 0.5) * 2;
    return `rgb(${Math.round(58 + 197 * u)}, ${Math.round(114 + 130 * u)}, ${Math.round(108 + 80 * u)})`;
  }

  /** The meter bar's colour at a given level: green through amber to red, with the
   *  thresholds where a mixing engineer expects them rather than spread evenly —
   *  amber from -12 dBFS, red from -3, because the top 3 dB is the part that
   *  actually clips. */
  function meterColor(db) {
    if (db > -3) return "#e05a6a";
    if (db > -12) return "#e0af68";
    return "#6ac48a";
  }

  /** THE FLOOR of the meter's scale, in dBFS. -60 is quiet-but-audible; going
   *  lower would spend most of the bar on silence. */
  const METER_FLOOR_DB = -60;

  let frame = null;

  /** Command. One animation frame: draw every visible analysis node from whatever
   *  the mirror last received. A node with no entry in the Map draws nothing — its
   *  static form is already underneath. */
  function tick() {
    frame = requestAnimationFrame(tick);
    if (audioState.status !== "running") return; // nothing live to draw; the plugin's static form stands
    for (const r of rects) {
      const canvas = canvases.get(r.id);
      if (!canvas) continue;
      const data = analysisData.get(r.id);
      if (data === undefined) continue;
      const w = Math.max(1, Math.round(r.w));
      const h = Math.max(1, Math.round(r.h));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext("2d");
      if (r.kind === "meter") drawMeter(ctx, w, h, data);
      else drawSpectrum(ctx, w, h, data);
    }
  }

  /** Command. THE BOUNCING BAR. `data` is {rms, db} from subscribeMeter. */
  function drawMeter(ctx, w, h, data) {
    ctx.clearRect(0, 0, w, h);
    const db = Number.isFinite(data.db) ? data.db : METER_FLOOR_DB;
    // dB, not linear amplitude. A linear meter spends 90% of its travel in the top
    // 20 dB and shows nothing at all for quiet material, which is why every real
    // meter is logarithmic.
    const frac = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
    const barH = Math.max(1, h * frac);
    ctx.fillStyle = meterColor(db);
    ctx.fillRect(0, h - barH, w, barH);
  }

  /** Command. THE FLOWING SPECTROGRAM. `data` is a Uint8Array of bin magnitudes,
   *  REUSED by the engine between calls — read here and never retained, which is
   *  what that contract asks for. */
  function drawSpectrum(ctx, w, h, bins) {
    // THE SCROLL IS A SELF-BLIT: shift everything one column left, then draw the new
    // column at the right edge. The canvas IS the history buffer.
    ctx.drawImage(ctx.canvas, -1, 0);
    const n = bins.length;
    // LOG FREQUENCY AXIS. A linear axis puts everything musical in the bottom eighth
    // of the picture and spends the top half on inaudible air. Each output row maps
    // back to a bin geometrically, so an octave is a constant distance — which is
    // what makes a harmonic series read as evenly spaced.
    for (let y = 0; y < h; y++) {
      const t = 1 - y / h; // bottom = low
      const bin = Math.min(n - 1, Math.floor(Math.pow(n, t) - 1));
      ctx.fillStyle = spectrumColor(bins[Math.max(0, bin)]);
      ctx.fillRect(w - 1, y, 1, 1);
    }
  }

  $effect(() => {
    frame = requestAnimationFrame(tick);
    return () => { if (frame) cancelAnimationFrame(frame); frame = null; };
  });

  /** Command. Drop the canvas of a node that is gone, so the Map does not grow for
   *  the life of the session. */
  $effect(() => {
    const live = new Set(rects.map((r) => r.id));
    for (const id of [...canvases.keys()]) if (!live.has(id)) canvases.delete(id);
  });
</script>

{#each rects as r (r.id)}
  <canvas
    class="nf-audio-overlay"
    style={`left: ${r.x}px; top: ${r.y}px; width: ${r.w}px; height: ${r.h}px;`}
    bind:this={() => canvases.get(r.id), (el) => el && canvases.set(r.id, el)}
  ></canvas>
{/each}
