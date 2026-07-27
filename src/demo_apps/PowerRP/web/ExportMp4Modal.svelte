<!--
  ExportMp4Modal — the "Export as MP4…" options FORM (the content of the shared
  Modal; App.svelte owns the <Modal> wrapper, mirroring BuiltinAssetBrowser).

  Presents the export knobs — resolution (presets + custom, defaulting to THE
  CAMERA's size), fps, quality (CRF), slide range, include-transitions, and a
  letterbox background — then runs app.exportMp4(), disabling the form while it
  works.

  PROGRESS IS TWO PHASES, and the distinction is the whole point (see the
  lifecycle note in the script): a DETERMINATE bar while the client renders and
  uploads one frame per 1/fps of the timeline, then an INDETERMINATE bar with an
  elapsed clock while the server runs ffmpeg and returns the file. Only the frame
  phase is cancellable (AbortController — videoExport's loop is what checks the
  signal), so the Cancel button exists only there and the encoding phase says so.

  AVAILABILITY: the encode is SERVER-SIDE (the client renders frames, the backend
  ffmpeg encodes) precisely so it works everywhere — including plain HTTP on a LAN
  IP, where the browser's secure-context-only WebCodecs VideoEncoder is absent.
  There is no secure-context gate: Export is always enabled.

  RESULT BOX: on success the finished movie is shown right here — a <video
  controls> plus an explicit download link — so the file is reachable even when
  the automatic download does not happen (a blocked/silent programmatic click, a
  browser that discards it, …). WHERE THE FILE LIVES: nowhere on disk. The server
  DELETES its frame/encode scratch as soon as ffmpeg returns (server.py's
  encode_export_mp4), so the only copy is the "video/mp4" Blob app.exportMp4()
  hands back; the box plays it through an object URL, revoked when the dialog
  closes or a new export starts. There is no server URL to link to and this file
  must never invent one.

  STYLING: app.css (.export-mp4-*) — web/ components carry NO <style> block. The
  Transitions row is the app's STANDARD boolean control (.boolfield/.boolbtn),
  not a native checkbox.
-->
<script>
  import { onDestroy, untrack } from "svelte";
  import "iconify-icon";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import { cameraRectAt } from "./cameraFrame.js";
  import { humanReadableFileSize } from "./fileSize.js";
  import { DEFAULT_FPS, DEFAULT_HOLD_SECONDS, DEFAULT_SAMPLES } from "./videoExport.js";
  import { QUALITY_CRF, CRF_MIN, CRF_MAX, DEFAULT_CRF } from "./serverMp4Encoder.js";

  let { app } = $props();

  // Bounds (named, not magic): H.264 needs EVEN dimensions (4:2:0). Cap fps and
  // dwell to sane authoring ranges; the server validates the real codec limits.
  const MIN_DIM = 16;
  const MAX_DIM = 7680; // 8K wide — beyond that, encoding gets impractical
  const MIN_FPS = 1;
  const MAX_FPS = 120;
  const MAX_HOLD_SECONDS = 60;
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
  /** Pure. Clamp a CRF into the libx264 valid range [CRF_MIN, CRF_MAX]. */
  function clampCrf(n) {
    return Math.max(CRF_MIN, Math.min(CRF_MAX, Math.round(n)));
  }

  /**
   * Pure function. The .mp4 filename for a presentation name — the SAME rule
   * app.exportMp4() uses for its automatic download, restated here so the
   * in-dialog download link saves the file under an identical name.
   *
   * @param {string} docName The presentation's meta.name (may be blank).
   * @returns {string} filename ending in ".mp4"
   *
   * @example mp4FileName("Quarterly Review") // "Quarterly Review.mp4"
   * @example mp4FileName("") // "presentation.mp4"
   */
  function mp4FileName(docName) {
    return `${docName || "presentation"}.mp4`;
  }

  // THE CAMERA's size at the current slide = the default output size (the camera
  // owns the frame). Even-clamped. Read ONCE at mount via untrack (the modal
  // remounts on each open, so these snapshot the deck as the dialog opens — the
  // intentional "capture the initial value" the Svelte warning flags).
  const cam = untrack(() => cameraRectAt(app.doc, app.slideIndex, 1, app.registry));
  const camW = evenDim(cam.w);
  const camH = evenDim(cam.h);
  const slideCount = untrack(() => app.doc.slides.length);

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
    { value: "custom", label: "Custom (CRF)…" },
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
  let customCrf = $state(DEFAULT_CRF); // libx264 CRF when quality === "custom"
  let rangeMode = $state("all");
  let rangeFrom = $state(1);
  let rangeTo = $state(slideCount);
  let includeTransitions = $state(true);
  let holdSeconds = $state(DEFAULT_HOLD_SECONDS);
  let background = $state("#000000");
  let samples = $state(DEFAULT_SAMPLES); // temporal subsamples (1 = no motion blur)

  // ── Export lifecycle ────────────────────────────────────────────────────
  // TWO PHASES, AND WHY THEY MUST BE SHOWN SEPARATELY. The progress fraction
  // videoExport hands us counts FRAMES RENDERED AND UPLOADED: it reaches 100%
  // the instant the last PNG lands on the server, which is BEFORE ffmpeg has
  // encoded a single byte. Everything after that — the whole server-side libx264
  // run plus transferring the finished file back — used to be unreported dead
  // air, so the user sat watching a full bar long enough to conclude the export
  // had died. A full determinate bar must therefore NEVER be the last thing
  // shown. On reaching 1 we switch to an INDETERMINATE phase with a running
  // elapsed clock: an honest "still working, duration unknown" beats a
  // determinate bar that lies.
  //
  // WHY THE SERVER PHASE IS ONE PHASE, NOT TWO: the encode and the file transfer
  // are a single awaited call (projectApi.encodeMp4Export → fetch → .blob()), so
  // this dialog cannot see the boundary between "ffmpeg finished" and "bytes
  // arrived", and it will not invent one. The label names both honestly.
  const ENCODE_CLOCK_MS = 250; // elapsed-clock tick — smooth enough to read as alive

  let phase = $state("idle"); // "idle" | "rendering" | "encoding" | "done" | "error"
  let progress = $state(0); // 0..1 — frames uploaded, NOT overall completion
  let framesDone = $state(0); // frames rendered so far (one onProgress call each)
  let renderSeconds = $state(0); // wall clock of the render + upload phase
  let encodeSeconds = $state(0); // wall clock of the server encode + transfer
  let errorMsg = $state(null);
  let controller = null; // AbortController while running
  let phaseStartedMs = 0;
  let ticker = null; // interval id driving the elapsed clock

  // The finished movie: an object URL over the returned Blob (the only copy —
  // the server deleted its scratch). Revoked before a re-export and on destroy.
  let resultUrl = $state(null);
  let resultBytes = $state(0);
  const fileName = mp4FileName(untrack(() => app.doc.meta.name));

  /** Command. Drops the current result box and frees its object URL (leaking
   *  one per export would pin whole movies in memory for the page's lifetime). */
  function releaseResult() {
    if (!resultUrl) return;
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    resultBytes = 0;
  }

  /** Command. Stops the elapsed clock, if one is running. */
  function stopClock() {
    if (ticker === null) return;
    clearInterval(ticker);
    ticker = null;
  }

  /** Command. Enters the indeterminate server phase: freezes the render timing
   *  and starts the elapsed clock that proves the dialog is still alive. */
  function beginEncodePhase() {
    renderSeconds = (performance.now() - phaseStartedMs) / 1000;
    phase = "encoding";
    phaseStartedMs = performance.now();
    encodeSeconds = 0;
    ticker = setInterval(() => {
      encodeSeconds = (performance.now() - phaseStartedMs) / 1000;
    }, ENCODE_CLOCK_MS);
  }

  onDestroy(() => {
    stopClock();
    releaseResult();
  });

  // ── Derived effective params ──────────────────────────────────────────────
  let preset = $derived(RESOLUTIONS.find((r) => r.value === resolution));
  let width = $derived(resolution === "custom" ? evenDim(customW) : preset.w);
  let height = $derived(resolution === "custom" ? evenDim(customH) : preset.h);
  let crf = $derived(quality === "custom" ? clampCrf(customCrf) : QUALITY_CRF[quality]);
  let startIndex = $derived(rangeMode === "all" ? 0 : clampSlide(rangeFrom) - 1);
  let endIndex = $derived(rangeMode === "all" ? slideCount - 1 : clampSlide(rangeTo) - 1);

  let busy = $derived(phase === "rendering" || phase === "encoding");
  // FLOOR, not round: with a long timeline, rounding shows "100%" while frames
  // are still rendering (at 1000 frames it reads 100% from frame 996 on), which
  // is the same lie the phase split exists to kill. 100% means "all frames in".
  let progressPct = $derived(progress >= 1 ? 100 : Math.min(99, Math.floor(progress * 100)));

  /** Command (async). Runs the export with the current form values, reporting
   *  BOTH phases (render+upload, then the server encode); cancellable. On
   *  success publishes the returned Blob to the result box. Loud on failure
   *  (also surfaced in the form). */
  async function runExport() {
    if (busy) return;
    releaseResult();
    phase = "rendering";
    progress = 0;
    framesDone = 0;
    renderSeconds = 0;
    encodeSeconds = 0;
    errorMsg = null;
    phaseStartedMs = performance.now();
    controller = new AbortController();
    try {
      const blob = await app.exportMp4({
        width, height, fps, crf, samples: Math.round(samples),
        startIndex, endIndex, includeTransitions, holdSeconds, background,
        // onProgress fires once per rendered+uploaded frame and ends at exactly
        // 1 (videoExport: `onProgress((i + 1) / total)`), which is the ONLY
        // signal we get that the frame phase is over and the server phase has
        // begun — hence the switch here rather than a separate callback.
        onProgress: (f) => {
          progress = f;
          framesDone += 1;
          if (f >= 1 && phase === "rendering") beginEncodePhase();
        },
        signal: controller.signal,
      });
      stopClock();
      encodeSeconds = (performance.now() - phaseStartedMs) / 1000;
      resultUrl = URL.createObjectURL(blob);
      resultBytes = blob.size;
      phase = "done";
    } catch (e) {
      stopClock();
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

  /** Command. Aborts an in-flight export. Only the FRAME phase checks the
   *  signal (videoExport's loop): once the frames are uploaded and ffmpeg is
   *  running, the server call cannot be interrupted, so the button says so. */
  function cancelExport() {
    controller?.abort();
  }
</script>

<div class="export-mp4">
  <div class="export-mp4-form" class:is-busy={busy}>
    <label class="export-mp4-row">
      <span class="export-mp4-label">Resolution</span>
      <span class="export-mp4-control"><Dropdown items={RESOLUTIONS} bind:value={resolution} /></span>
    </label>
    {#if resolution === "custom"}
      <div class="export-mp4-row">
        <span class="export-mp4-label">Width × Height</span>
        <span class="export-mp4-control export-mp4-inline">
          <DraggableNumber bind:value={customW} min={MIN_DIM} max={MAX_DIM} step={2} suffix=" px" label="Width" />
          <span class="export-mp4-times">×</span>
          <DraggableNumber bind:value={customH} min={MIN_DIM} max={MAX_DIM} step={2} suffix=" px" label="Height" />
        </span>
      </div>
    {/if}

    <label class="export-mp4-row">
      <span class="export-mp4-label">Frame rate</span>
      <span class="export-mp4-control"><DraggableNumber bind:value={fps} min={MIN_FPS} max={MAX_FPS} step={1} suffix=" fps" label="Frames per second" /></span>
    </label>

    <label class="export-mp4-row">
      <span class="export-mp4-label">Quality</span>
      <span class="export-mp4-control"><Dropdown items={QUALITIES} bind:value={quality} /></span>
    </label>
    {#if quality === "custom"}
      <label class="export-mp4-row">
        <span class="export-mp4-label">CRF</span>
        <span class="export-mp4-control export-mp4-inline">
          <DraggableNumber bind:value={customCrf} min={CRF_MIN} max={CRF_MAX} step={1} label="H.264 constant rate factor" />
          <span class="export-mp4-hint">Lower is higher quality &amp; larger (0 lossless … 51 worst)</span>
        </span>
      </label>
    {/if}

    <label class="export-mp4-row">
      <span class="export-mp4-label">Slides</span>
      <span class="export-mp4-control"><Dropdown items={RANGE_MODES} bind:value={rangeMode} /></span>
    </label>
    {#if rangeMode === "custom"}
      <div class="export-mp4-row">
        <span class="export-mp4-label">From → To</span>
        <span class="export-mp4-control export-mp4-inline">
          <DraggableNumber bind:value={rangeFrom} min={1} max={slideCount} step={1} label="First slide" />
          <span class="export-mp4-times">→</span>
          <DraggableNumber bind:value={rangeTo} min={1} max={slideCount} step={1} label="Last slide" />
        </span>
      </div>
    {/if}

    <!-- THE app's standard boolean control, NOT a native checkbox. The
         BooleanField component itself is keyframe-path bound (it writes
         app.setPreview([["items", id, …]])) so it cannot drive a local form
         value; the Inspector hits the identical case for its non-keyframed
         booleans and answers it with exactly this markup (Inspector.svelte's
         "Plain boolean" branch), so this reuses that precedent and the shared
         .boolfield/.boolbtn rules rather than inventing a third look. Not a
         <label>: the control is a <button>, and a button inside a label would
         make the hint text toggle it. -->
    <div class="export-mp4-row">
      <span class="export-mp4-label">Transitions</span>
      <span class="export-mp4-control export-mp4-inline">
        <div class="boolfield">
          <button
            type="button"
            class="boolbtn"
            class:on={includeTransitions}
            aria-label="Animate transitions between slides"
            aria-pressed={includeTransitions}
            onclick={() => (includeTransitions = !includeTransitions)}
          >
            <iconify-icon icon={includeTransitions ? "mdi:check" : "mdi:checkbox-blank-outline"} width="16" height="16"></iconify-icon>
          </button>
        </div>
        <span class="export-mp4-hint">Animate transitions between slides</span>
      </span>
    </div>

    <label class="export-mp4-row">
      <span class="export-mp4-label">Hold per slide</span>
      <span class="export-mp4-control"><DraggableNumber bind:value={holdSeconds} min={0} max={MAX_HOLD_SECONDS} step={0.5} suffix=" s" label="Seconds each slide is held" /></span>
    </label>

    <label class="export-mp4-row">
      <span class="export-mp4-label">Motion blur</span>
      <span class="export-mp4-control export-mp4-inline">
        <DraggableNumber bind:value={samples} min={MIN_SAMPLES} max={MAX_SAMPLES} step={1} suffix=" ×" label="Temporal subsamples per frame" />
        <span class="export-mp4-hint">1 = off; higher blurs transitions (slower)</span>
      </span>
    </label>

    <label class="export-mp4-row">
      <span class="export-mp4-label">Background</span>
      <span class="export-mp4-control export-mp4-inline">
        <input type="color" bind:value={background} class="export-mp4-color" aria-label="Letterbox background color" />
        <span class="export-mp4-hint">Fills letterbox bars when the aspect differs</span>
      </span>
    </label>
  </div>

  <p class="export-mp4-summary">
    Output: {width}×{height} · {fps} fps · CRF {crf} (lower = higher quality)
  </p>

  <!-- PROGRESS. Two visually distinct states, because they mean different
       things: a DETERMINATE bar while frames render+upload, then an
       INDETERMINATE bar plus an elapsed clock while the server encodes — see the
       lifecycle note in the script. A full bar is never the last thing shown. -->
  {#if phase === "rendering"}
    <div class="export-mp4-progress">
      <div class="export-mp4-bar"><div class="export-mp4-bar-fill" style:width="{progressPct}%"></div></div>
      <span class="export-mp4-progress-label">Rendering frames… {progressPct}%</span>
    </div>
  {:else if phase === "encoding"}
    <div class="export-mp4-progress">
      <div class="export-mp4-bar"><div class="export-mp4-bar-fill is-indeterminate"></div></div>
      <span class="export-mp4-progress-label">Encoding on the server… {encodeSeconds.toFixed(0)}s</span>
    </div>
    <p class="export-mp4-hint">
      All {framesDone} frames were rendered and uploaded in {renderSeconds.toFixed(1)}s.
      The server is now running ffmpeg and sending the finished file back — this step
      reports no percentage and cannot be cancelled.
    </p>
  {:else if phase === "done"}
    <!-- THE RESULT BOX. The finished movie exists ONLY as this Blob (the server
         deleted its scratch the moment ffmpeg returned), so the box plays it and
         the link saves it from an object URL. The automatic download has already
         been attempted by app.exportMp4(); this is the guaranteed manual path. -->
    <div class="export-mp4-result">
      <p class="export-mp4-done">
        Done — {fileName} ({humanReadableFileSize(resultBytes)}). Downloaded automatically;
        use the button below if your browser did not save it.
      </p>
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="export-mp4-video" src={resultUrl} controls></video>
      <div class="export-mp4-result-actions">
        <a class="btn export-mp4-download" href={resultUrl} download={fileName}>
          <iconify-icon icon="mdi:download" width="16" height="16"></iconify-icon>
          Download {fileName}
        </a>
      </div>
      <p class="export-mp4-hint">
        {framesDone} frames rendered in {renderSeconds.toFixed(1)}s · server encode
        and transfer {encodeSeconds.toFixed(1)}s
      </p>
    </div>
  {:else if phase === "error"}
    <p class="export-mp4-error">Export failed: {errorMsg}</p>
  {/if}

  <div class="export-mp4-actions">
    {#if phase === "rendering"}
      <button type="button" class="btn" onclick={cancelExport}>Cancel</button>
    {:else if phase !== "encoding"}
      <button type="button" class="btn" onclick={runExport}>
        {phase === "done" ? "Export again" : "Export MP4"}
      </button>
    {/if}
  </div>
</div>
