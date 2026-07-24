<!--
  ExportMp4Modal — the "Export as MP4…" options FORM (the content of the shared
  Modal; App.svelte owns the <Modal> wrapper, mirroring BuiltinAssetBrowser).

  Presents the export knobs — resolution (presets + custom, defaulting to THE
  CAMERA's size), fps, quality/bitrate, slide range, include-transitions, and a
  letterbox background — then runs app.exportMp4() with a live progress bar. The
  encode is many frames (one per 1/fps of the presentation timeline), so it is
  cancellable (AbortController) and disables the form while running.

  AVAILABILITY: WebCodecs VideoEncoder is a SECURE-CONTEXT API (https/localhost).
  On a plain-HTTP LAN origin it is absent; this form then shows the loud reason
  and disables Export rather than pretending to work (no MediaRecorder fallback —
  that would be non-deterministic).

  This component is self-contained (scoped <style> using theme tokens with
  fallbacks, like the SvelteLib lib components) rather than routing through the
  contended app.css — keeps the new export lane merge-safe alongside parallel work.
-->
<script>
  import { untrack } from "svelte";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import { cameraRectAt } from "./cameraFrame.js";
  import { DEFAULT_FPS, DEFAULT_HOLD_SECONDS, DEFAULT_SAMPLES } from "./videoExport.js";
  import { QUALITY_PRESETS, qualityBitrate, videoExportUnavailableReason } from "./mp4Encoder.js";

  let { app } = $props();

  // Bounds (named, not magic): H.264 needs EVEN dimensions (4:2:0). Cap fps and
  // dwell to sane authoring ranges; the encoder validates the real codec limits.
  const MIN_DIM = 16;
  const MAX_DIM = 7680; // 8K wide — beyond any level we emit, the encoder rejects loudly
  const MIN_FPS = 1;
  const MAX_FPS = 120;
  const MAX_HOLD_SECONDS = 60;
  const MAX_BITRATE_MBPS = 200;
  const MIN_SAMPLES = 1;
  const MAX_SAMPLES = 16; // temporal subsamples per frame (motion blur); >16 rarely worth the cost

  /** Pure. Largest even integer ≤ v, clamped to [MIN_DIM, MAX_DIM]. */
  function evenDim(v) {
    const n = Math.round(v);
    return Math.max(MIN_DIM, Math.min(MAX_DIM, n - (n % 2)));
  }
  /** Pure. Clamp a 1-based slide number into [1, slideCount]. */
  function clampSlide(n) {
    return Math.max(1, Math.min(slideCount, Math.round(n)));
  }
  /** Pure. Round to one decimal (Mbps display). */
  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  // THE CAMERA's size at the current slide = the default output size (the camera
  // owns the frame). Even-clamped. Read ONCE at mount via untrack (the modal
  // remounts on each open, so these snapshot the deck as the dialog opens — the
  // intentional "capture the initial value" the Svelte warning flags).
  const cam = untrack(() => cameraRectAt(app.doc, app.slideIndex, 1, app.registry));
  const camW = evenDim(cam.w);
  const camH = evenDim(cam.h);
  const slideCount = untrack(() => app.doc.slides.length);

  // Secure-context availability (null ⇒ export can run here).
  const unavailable = videoExportUnavailableReason();

  const RESOLUTIONS = [
    { value: "camera", label: `Camera size — ${camW}×${camH}`, w: camW, h: camH },
    { value: "2160", label: "4K — 3840×2160", w: 3840, h: 2160 },
    { value: "1440", label: "QHD — 2560×1440", w: 2560, h: 1440 },
    { value: "1080", label: "1080p — 1920×1080", w: 1920, h: 1080 },
    { value: "720", label: "720p — 1280×720", w: 1280, h: 720 },
    { value: "480", label: "480p — 854×480", w: 854, h: 480 },
    { value: "custom", label: "Custom…" },
  ];
  const QUALITIES = [
    { value: "low", label: "Low (smaller file)" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High (crisper)" },
    { value: "custom", label: "Custom bitrate…" },
  ];
  const RANGE_MODES = [
    { value: "all", label: "All slides" },
    { value: "custom", label: "Range…" },
  ];

  // ── Form state ──────────────────────────────────────────────────────────
  let resolution = $state("camera");
  let customW = $state(camW);
  let customH = $state(camH);
  let fps = $state(DEFAULT_FPS);
  let quality = $state("medium");
  let customMbps = $state(round1(qualityBitrate(camW, camH, DEFAULT_FPS, QUALITY_PRESETS.medium) / 1e6));
  let rangeMode = $state("all");
  let rangeFrom = $state(1);
  let rangeTo = $state(slideCount);
  let includeTransitions = $state(true);
  let holdSeconds = $state(DEFAULT_HOLD_SECONDS);
  let background = $state("#000000");
  let samples = $state(DEFAULT_SAMPLES); // temporal subsamples (1 = no motion blur)

  // ── Encode lifecycle ────────────────────────────────────────────────────
  let phase = $state("idle"); // "idle" | "encoding" | "done" | "error"
  let progress = $state(0); // 0..1 while encoding
  let errorMsg = $state(null);
  let controller = null; // AbortController while encoding

  // ── Derived effective params ──────────────────────────────────────────────
  let preset = $derived(RESOLUTIONS.find((r) => r.value === resolution));
  let width = $derived(resolution === "custom" ? evenDim(customW) : preset.w);
  let height = $derived(resolution === "custom" ? evenDim(customH) : preset.h);
  let bitrate = $derived(
    quality === "custom"
      ? Math.max(1, Math.round(Math.min(MAX_BITRATE_MBPS, customMbps) * 1e6))
      : qualityBitrate(width, height, fps, QUALITY_PRESETS[quality]),
  );
  let startIndex = $derived(rangeMode === "all" ? 0 : clampSlide(rangeFrom) - 1);
  let endIndex = $derived(rangeMode === "all" ? slideCount - 1 : clampSlide(rangeTo) - 1);
  let effectiveMbps = $derived(round1(bitrate / 1e6));

  let busy = $derived(phase === "encoding");
  let progressPct = $derived(Math.round(progress * 100));

  /** Command (async). Runs the export with the current form values, tracking
   *  progress; cancellable. Loud on failure (also surfaced in the form). */
  async function runExport() {
    if (unavailable || busy) return;
    phase = "encoding";
    progress = 0;
    errorMsg = null;
    controller = new AbortController();
    try {
      await app.exportMp4({
        width, height, fps, bitrate, samples: Math.round(samples),
        startIndex, endIndex, includeTransitions, holdSeconds, background,
        onProgress: (f) => (progress = f),
        signal: controller.signal,
      });
      phase = "done";
    } catch (e) {
      if (e?.name === "AbortError") {
        phase = "idle";
        return;
      }
      phase = "error";
      errorMsg = String(e?.message ?? e);
      console.error("MP4 export failed:", e);
    } finally {
      controller = null;
    }
  }

  /** Command. Aborts an in-flight encode (the loop checks the signal). */
  function cancelExport() {
    controller?.abort();
  }
</script>

<div class="emx">
  {#if unavailable}
    <p class="emx-unavailable">{unavailable}</p>
  {/if}

  <div class="emx-form" class:emx-disabled={busy || !!unavailable}>
    <label class="emx-row">
      <span class="emx-label">Resolution</span>
      <span class="emx-control"><Dropdown items={RESOLUTIONS} bind:value={resolution} /></span>
    </label>
    {#if resolution === "custom"}
      <div class="emx-row">
        <span class="emx-label">Width × Height</span>
        <span class="emx-control emx-dims">
          <DraggableNumber bind:value={customW} min={MIN_DIM} max={MAX_DIM} step={2} suffix=" px" label="Width" />
          <span class="emx-times">×</span>
          <DraggableNumber bind:value={customH} min={MIN_DIM} max={MAX_DIM} step={2} suffix=" px" label="Height" />
        </span>
      </div>
    {/if}

    <label class="emx-row">
      <span class="emx-label">Frame rate</span>
      <span class="emx-control"><DraggableNumber bind:value={fps} min={MIN_FPS} max={MAX_FPS} step={1} suffix=" fps" label="Frames per second" /></span>
    </label>

    <label class="emx-row">
      <span class="emx-label">Quality</span>
      <span class="emx-control"><Dropdown items={QUALITIES} bind:value={quality} /></span>
    </label>
    {#if quality === "custom"}
      <label class="emx-row">
        <span class="emx-label">Bitrate</span>
        <span class="emx-control"><DraggableNumber bind:value={customMbps} min={0.1} max={MAX_BITRATE_MBPS} step={0.1} suffix=" Mbps" label="Bitrate in megabits per second" /></span>
      </label>
    {/if}

    <label class="emx-row">
      <span class="emx-label">Slides</span>
      <span class="emx-control"><Dropdown items={RANGE_MODES} bind:value={rangeMode} /></span>
    </label>
    {#if rangeMode === "custom"}
      <div class="emx-row">
        <span class="emx-label">From → To</span>
        <span class="emx-control emx-dims">
          <DraggableNumber bind:value={rangeFrom} min={1} max={slideCount} step={1} label="First slide" />
          <span class="emx-times">→</span>
          <DraggableNumber bind:value={rangeTo} min={1} max={slideCount} step={1} label="Last slide" />
        </span>
      </div>
    {/if}

    <label class="emx-row">
      <span class="emx-label">Transitions</span>
      <span class="emx-control emx-inline">
        <input type="checkbox" bind:checked={includeTransitions} />
        <span class="emx-hint">Animate transitions between slides</span>
      </span>
    </label>

    <label class="emx-row">
      <span class="emx-label">Hold per slide</span>
      <span class="emx-control"><DraggableNumber bind:value={holdSeconds} min={0} max={MAX_HOLD_SECONDS} step={0.5} suffix=" s" label="Seconds each slide is held" /></span>
    </label>

    <label class="emx-row">
      <span class="emx-label">Motion blur</span>
      <span class="emx-control emx-inline">
        <DraggableNumber bind:value={samples} min={MIN_SAMPLES} max={MAX_SAMPLES} step={1} suffix=" ×" label="Temporal subsamples per frame" />
        <span class="emx-hint">Samples per frame — 1 = off; higher blurs transitions &amp; animated effects (slower)</span>
      </span>
    </label>

    <label class="emx-row">
      <span class="emx-label">Background</span>
      <span class="emx-control emx-inline">
        <input type="color" bind:value={background} class="emx-color" />
        <span class="emx-hint">Fills any letterbox bars (only visible when the size aspect differs from the camera)</span>
      </span>
    </label>
  </div>

  <p class="emx-summary">
    Output: {width}×{height} · {fps} fps · ~{effectiveMbps} Mbps
  </p>

  {#if phase === "encoding"}
    <div class="emx-progress">
      <div class="emx-bar"><div class="emx-bar-fill" style:width="{progressPct}%"></div></div>
      <span class="emx-progress-label">Encoding… {progressPct}%</span>
    </div>
  {:else if phase === "done"}
    <p class="emx-done">Done — the .mp4 has been downloaded.</p>
  {:else if phase === "error"}
    <p class="emx-error">Export failed: {errorMsg}</p>
  {/if}

  <div class="emx-actions">
    {#if busy}
      <button type="button" class="emx-btn" onclick={cancelExport}>Cancel</button>
    {:else}
      <button type="button" class="emx-btn emx-primary" disabled={!!unavailable} onclick={runExport}>
        Export MP4
      </button>
    {/if}
  </div>
</div>

<style>
  .emx {
    /* Chain to ambient theme tokens (light/dark aware) with literal fallbacks —
       same pattern as the SvelteLib lib components (Dropdown/Modal). */
    --emx-fg: var(--fg, #e6e6e6);
    --emx-fg-dim: var(--fg-dim, #8c8c8c);
    --emx-border: var(--border, rgba(255, 255, 255, 0.1));
    --emx-accent: var(--accent, #9a9a9a);
    --emx-control-bg: var(--control-bg, #242424);
    --emx-error: var(--a-eq-error, #ff6b6b);
    --emx-font: var(--a-font-md, 0.9rem);
    --emx-font-sm: var(--a-font-sm, 0.8rem);

    --emx-col-w: 560px; /* the form column max width inside the roomy 90% modal */
    --emx-row-gap: 14px;
    --emx-label-w: 130px;
    --emx-gap: 10px;
    --emx-pad: 8px 10px;
    --emx-radius: 6px;
    --emx-bar-h: 8px;

    display: flex;
    flex-direction: column;
    gap: var(--emx-row-gap);
    max-width: var(--emx-col-w);
    margin: 0 auto;
    color: var(--emx-fg);
    font-size: var(--emx-font);
  }

  .emx-unavailable {
    margin: 0;
    padding: var(--emx-pad);
    border: 1px solid var(--emx-error);
    border-radius: var(--emx-radius);
    color: var(--emx-error);
    font-size: var(--emx-font-sm);
    line-height: 1.4;
  }

  .emx-form {
    display: flex;
    flex-direction: column;
    gap: var(--emx-row-gap);
  }
  .emx-disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .emx-row {
    display: flex;
    align-items: center;
    gap: var(--emx-gap);
  }
  .emx-label {
    flex: 0 0 var(--emx-label-w);
    color: var(--emx-fg-dim);
  }
  .emx-control {
    flex: 1 1 auto;
    min-width: 0;
  }
  .emx-inline {
    display: flex;
    align-items: center;
    gap: var(--emx-gap);
  }
  .emx-dims {
    display: flex;
    align-items: center;
    gap: var(--emx-gap);
  }
  .emx-times {
    color: var(--emx-fg-dim);
  }
  .emx-hint {
    color: var(--emx-fg-dim);
    font-size: var(--emx-font-sm);
    line-height: 1.3;
  }
  .emx-color {
    width: 2.4em;
    height: 1.8em;
    padding: 0;
    background: none;
    border: 1px solid var(--emx-border);
    border-radius: var(--emx-radius);
    cursor: pointer;
  }

  .emx-summary {
    margin: 0;
    color: var(--emx-fg-dim);
    font-size: var(--emx-font-sm);
  }

  .emx-progress {
    display: flex;
    align-items: center;
    gap: var(--emx-gap);
  }
  .emx-bar {
    flex: 1 1 auto;
    height: var(--emx-bar-h);
    background: var(--emx-control-bg);
    border: 1px solid var(--emx-border);
    border-radius: var(--emx-radius);
    overflow: hidden;
  }
  .emx-bar-fill {
    height: 100%;
    background: var(--emx-accent);
    transition: width 120ms linear;
  }
  .emx-progress-label {
    flex: 0 0 auto;
    color: var(--emx-fg-dim);
    font-size: var(--emx-font-sm);
  }
  .emx-done {
    margin: 0;
    color: var(--emx-fg);
    font-size: var(--emx-font-sm);
  }
  .emx-error {
    margin: 0;
    color: var(--emx-error);
    font-size: var(--emx-font-sm);
    line-height: 1.4;
  }

  .emx-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--emx-gap);
  }
  .emx-btn {
    padding: var(--emx-pad);
    background: var(--emx-control-bg);
    color: var(--emx-fg);
    border: 1px solid var(--emx-border);
    border-radius: var(--emx-radius);
    font: inherit;
    cursor: pointer;
  }
  .emx-btn:hover:not(:disabled) {
    border-color: var(--emx-accent);
  }
  .emx-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .emx-primary {
    border-color: var(--emx-accent);
  }
</style>
