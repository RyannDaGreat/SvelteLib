<!--
  RenderCenterModal — the RENDER CENTER. Two panes: SUBMIT on the left, this
  project's RENDERINGS on the right. (App.svelte owns the <Modal> wrapper,
  mirroring BuiltinAssetBrowser.)

  WHY THIS REPLACED "Export as MP4". The old dialog WAS the render: it held the
  frame loop and the progress in component state, so closing it, refreshing, or an
  editor hot-reload destroyed an in-flight export with no way to find it again —
  a five-hour render lost to a stray reload. A render is now a JOB THE SERVER
  OWNS. Submitting hands over a snapshot and returns; this dialog then knows
  nothing the server cannot re-tell it, which is exactly why it can be closed and
  reopened (or opened in a different tab tomorrow) and show the same truth.
  Everything on the right is POLLED, never remembered.

  BACKENDS. The encode was always server-side ffmpeg (WebCodecs needs a secure
  context, which plain HTTP cannot give), so the only thing that ever differed is
  who fills the frame directory — which makes `backend` a FIELD on one job rather
  than a second system:
    Server  — detached; survives a closed laptop, a refresh, even a server
              restart. The default, and the only honest answer to "will this
              still be going when I come back".
    Browser — this page renders the frames. Faster when the machine has a GPU,
              and it is currently the ONLY backend that draws image/video widgets
              (the headless renderer has no media decode yet) — so it stays.

  COLLAPSED BY DEFAULT, AND WHY THAT IS A CONSTRAINT NOT A TASTE: an expanded row
  mounts a <video>, so expanding everything on open would have the browser fetch
  every finished movie in the project at once. Rows therefore start collapsed,
  EXCEPT the ones the user actually needs to see — in-progress jobs and finished
  ones they have not seen yet. An explicit click always wins over that default and
  is remembered for the life of the dialog.

  STYLING: app.css (.render-center-*) — web/ components carry NO <style> block.
-->
<script>
  import { onDestroy, untrack } from "svelte";
  import "iconify-icon";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { cameraRectAt } from "./cameraFrame.js";
  import { humanReadableFileSize } from "./fileSize.js";
  import { DEFAULT_FPS, DEFAULT_HOLD_SECONDS, DEFAULT_SAMPLES } from "./videoExport.js";
  import { QUALITY_CRF, CRF_MIN, CRF_MAX, DEFAULT_CRF } from "./serverMp4Encoder.js";
  import { listRenderJobs, cancelRenderJob, deleteRenderJob, markRenderJobSeen, renderUrl } from "./projectApi.js";
  // The job vocabulary (active? unseen? how far? what does this state MEAN?)
  // lives in one pure module because the toolbar badge reads the same
  // predicates — two copies would be two chances to disagree about what the
  // badge counts. See web/renderJobView.js.
  import { jobIsActive, defaultExpanded, jobProgress, jobStatusLine, STATE_ICONS } from "./renderJobView.js";

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
  // How often the right pane re-asks the server. Progress is a directory listing
  // server-side, so this is cheap; 1 s reads as live without hammering a backend
  // that is also running the render.
  const POLL_MS = 1000;

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

  // THE CAMERA's size at the current slide = the default output size (the camera
  // owns the frame). Read ONCE at mount via untrack (the modal remounts on each
  // open, so these snapshot the deck as the dialog opens).
  const cam = untrack(() => cameraRectAt(app.doc, app.slideIndex, 1, app.registry));
  const camW = evenDim(cam.w);
  const camH = evenDim(cam.h);
  const slideCount = untrack(() => app.doc.slides.length);
  const project = untrack(() => app.projectName());

  const RESOLUTIONS = [
    { value: "camera", label: `Camera size — ${camW}×${camH}`, w: camW, h: camH },
    { value: "2160", label: "4K — 3840×2160", w: 3840, h: 2160 },
    { value: "1440", label: "QHD — 2560×1440", w: 2560, h: 1440 },
    { value: "1080", label: "1080p — 1920×1080", w: 1920, h: 1080 },
    { value: "720", label: "720p — 1280×720", w: 1280, h: 720 },
    { value: "480", label: "480p — 854×480", w: 854, h: 480 },
    { value: "custom", label: "Custom…" },
  ];
  // "Quality" alone was ambiguous — it reads as render quality, but it is the
  // H.264 rate factor. The row and every option say codec now.
  const CODEC_QUALITIES = [
    { value: "low", label: "Low (smaller file)" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High (crisper)" },
    { value: "custom", label: "Custom (CRF)…" },
  ];
  const RANGE_MODES = [
    { value: "all", label: "All slides" },
    { value: "custom", label: "Range…" },
  ];
  const BACKENDS = [
    { value: "server", label: "Server — keeps going if you close this" },
    { value: "browser", label: "Browser — this page renders (needed for media)" },
  ];

  // ── Form state ──────────────────────────────────────────────────────────
  let jobName = $state(untrack(() => app.projectName()));
  let backend = $state("server");
  let resolution = $state("camera");
  let customW = $state(camW);
  let customH = $state(camH);
  let fps = $state(DEFAULT_FPS);
  let codecQuality = $state("medium");
  let customCrf = $state(DEFAULT_CRF); // libx264 CRF when codecQuality === "custom"
  let rangeMode = $state("all");
  let rangeFrom = $state(1);
  let rangeTo = $state(slideCount);
  let includeTransitions = $state(true);
  let holdSeconds = $state(DEFAULT_HOLD_SECONDS);
  let background = $state("#000000");
  let samples = $state(DEFAULT_SAMPLES); // temporal subsamples (1 = no motion blur)
  let submitError = $state(null);
  let submitting = $state(false);

  // ── Right pane: polled job list ─────────────────────────────────────────
  // `jobs` is server truth, refreshed on a timer. `overrides` records rows the
  // user explicitly opened/closed — an explicit choice must beat the default for
  // as long as the dialog is open (see the header).
  let jobs = $state([]);
  let listError = $state(null);
  let overrides = $state({});
  let poll = null;

  /** Command (async). Re-read the job list. Errors are shown in the pane rather
   *  than thrown away — a backend that has gone away must be visible, not a list
   *  that silently stops updating. */
  async function refresh() {
    try {
      jobs = await listRenderJobs(project);
      listError = null;
    } catch (e) {
      listError = String(e?.message ?? e);
    }
  }

  refresh();
  poll = setInterval(refresh, POLL_MS);
  onDestroy(() => clearInterval(poll));

  // ── Derived effective params ──────────────────────────────────────────────
  let preset = $derived(RESOLUTIONS.find((r) => r.value === resolution));
  let width = $derived(resolution === "custom" ? evenDim(customW) : preset.w);
  let height = $derived(resolution === "custom" ? evenDim(customH) : preset.h);
  let crf = $derived(codecQuality === "custom" ? clampCrf(customCrf) : QUALITY_CRF[codecQuality]);
  let startIndex = $derived(rangeMode === "all" ? 0 : clampSlide(rangeFrom) - 1);
  let endIndex = $derived(rangeMode === "all" ? slideCount - 1 : clampSlide(rangeTo) - 1);
  // Motion blur AVERAGES sub-frames on a canvas, which the headless worker has no
  // equivalent for. The server REJECTS it at submit; saying so here turns a
  // rejection into a plain fact about the backend.
  let blurNeedsBrowser = $derived(backend === "server" && Math.round(samples) > 1);

  /** Query. Is a row expanded? An explicit toggle wins; otherwise the default. */
  function expanded(job) {
    return overrides[job.id] ?? defaultExpanded(job);
  }

  /** Command. Toggle one row, recording the choice so it beats the default. A
   *  finished job the user opens is also marked SEEN, which clears the badge. */
  function toggle(job) {
    const next = !expanded(job);
    overrides = { ...overrides, [job.id]: next };
    if (next && !job.seen && !jobIsActive(job)) {
      markRenderJobSeen(project, job.id).then(refresh).catch((e) => (listError = String(e?.message ?? e)));
    }
  }

  /** Command (async). Submit the form as a job. On success the right pane picks
   *  it up on the next poll — this dialog holds nothing. */
  async function submit() {
    if (submitting) return;
    submitting = true;
    submitError = null;
    try {
      await app.submitRender({
        name: jobName.trim() || "Render",
        // The dropdown says "browser" because that is what the user is choosing;
        // the wire word is "client".
        backend: backend === "browser" ? "client" : "server",
        params: {
          width, height, fps, crf, samples: Math.round(samples),
          startIndex, endIndex, includeTransitions, holdSeconds, background,
          quality: "full",
        },
      });
      await refresh();
    } catch (e) {
      submitError = String(e?.message ?? e);
      console.error("Render job submit failed:", e);
    } finally {
      submitting = false;
    }
  }

  /** Command (async). Cancel a running job; the list reflects it on refresh. */
  async function cancel(job) {
    try {
      await cancelRenderJob(project, job.id);
      await refresh();
    } catch (e) {
      listError = String(e?.message ?? e);
    }
  }

  /** Command (async). Delete a finished job's record AND its movie. */
  async function remove(job) {
    try {
      await deleteRenderJob(project, job.id);
      await refresh();
    } catch (e) {
      listError = String(e?.message ?? e);
    }
  }

  /** Command (async). Copy a job's absolute output path to the clipboard. */
  let copiedPath = $state(null);
  const COPY_FLASH_MS = 1200;
  async function copyPath(job) {
    await navigator.clipboard.writeText(job.outputPath);
    copiedPath = job.id;
    setTimeout(() => { if (copiedPath === job.id) copiedPath = null; }, COPY_FLASH_MS);
  }
</script>

<div class="render-center">
  <!-- ── LEFT: submit ────────────────────────────────────────────────────── -->
  <div class="render-center-submit">
    <h3 class="render-center-heading">New render</h3>

    <label class="render-center-row">
      <span class="render-center-label">Name</span>
      <span class="render-center-control">
        <input class="render-center-text" type="text" bind:value={jobName} aria-label="Render name" />
      </span>
    </label>

    <label class="render-center-row">
      <span class="render-center-label">Rendered by</span>
      <span class="render-center-control"><Dropdown items={BACKENDS} bind:value={backend} /></span>
    </label>

    <label class="render-center-row">
      <span class="render-center-label">Resolution</span>
      <span class="render-center-control"><Dropdown items={RESOLUTIONS} bind:value={resolution} /></span>
    </label>
    {#if resolution === "custom"}
      <div class="render-center-row">
        <span class="render-center-label">Width × Height</span>
        <span class="render-center-control render-center-inline">
          <DraggableNumber bind:value={customW} min={MIN_DIM} max={MAX_DIM} step={2} suffix=" px" label="Width" />
          <span class="render-center-times">×</span>
          <DraggableNumber bind:value={customH} min={MIN_DIM} max={MAX_DIM} step={2} suffix=" px" label="Height" />
        </span>
      </div>
    {/if}

    <label class="render-center-row">
      <span class="render-center-label">Frame rate</span>
      <span class="render-center-control"><DraggableNumber bind:value={fps} min={MIN_FPS} max={MAX_FPS} step={1} suffix=" fps" label="Frames per second" /></span>
    </label>

    <label class="render-center-row">
      <span class="render-center-label">Codec quality</span>
      <span class="render-center-control"><Dropdown items={CODEC_QUALITIES} bind:value={codecQuality} /></span>
    </label>
    {#if codecQuality === "custom"}
      <label class="render-center-row">
        <span class="render-center-label">CRF</span>
        <span class="render-center-control render-center-inline">
          <DraggableNumber bind:value={customCrf} min={CRF_MIN} max={CRF_MAX} step={1} label="H.264 constant rate factor" />
          <span class="render-center-hint">Lower is higher quality &amp; larger (0 lossless … 51 worst)</span>
        </span>
      </label>
    {/if}

    <label class="render-center-row">
      <span class="render-center-label">Slides</span>
      <span class="render-center-control"><Dropdown items={RANGE_MODES} bind:value={rangeMode} /></span>
    </label>
    {#if rangeMode === "custom"}
      <div class="render-center-row">
        <span class="render-center-label">From → To</span>
        <span class="render-center-control render-center-inline">
          <DraggableNumber bind:value={rangeFrom} min={1} max={slideCount} step={1} label="First slide" />
          <span class="render-center-times">→</span>
          <DraggableNumber bind:value={rangeTo} min={1} max={slideCount} step={1} label="Last slide" />
        </span>
      </div>
    {/if}

    <!-- THE app's standard boolean control, NOT a native checkbox (Inspector's
         "Plain boolean" branch precedent). Not a <label>: the control is a
         <button>, and a button inside a label would make the hint toggle it. -->
    <div class="render-center-row">
      <span class="render-center-label">Transitions</span>
      <span class="render-center-control render-center-inline">
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
        <span class="render-center-hint">Animate transitions between slides</span>
      </span>
    </div>

    <label class="render-center-row">
      <span class="render-center-label">Hold per slide</span>
      <span class="render-center-control"><DraggableNumber bind:value={holdSeconds} min={0} max={MAX_HOLD_SECONDS} step={0.5} suffix=" s" label="Seconds each slide is held" /></span>
    </label>

    <label class="render-center-row">
      <span class="render-center-label">Motion blur</span>
      <span class="render-center-control render-center-inline">
        <DraggableNumber bind:value={samples} min={MIN_SAMPLES} max={MAX_SAMPLES} step={1} suffix=" ×" label="Temporal subsamples per frame" />
        <span class="render-center-hint">1 = off; higher blurs transitions (slower)</span>
      </span>
    </label>

    <label class="render-center-row">
      <span class="render-center-label">Background</span>
      <span class="render-center-control render-center-inline">
        <input type="color" bind:value={background} class="render-center-color" aria-label="Letterbox background color" />
        <span class="render-center-hint">Fills letterbox bars when the aspect differs</span>
      </span>
    </label>

    <p class="render-center-summary">
      Output: {width}×{height} · {fps} fps · CRF {crf} (lower = higher quality)
    </p>

    {#if blurNeedsBrowser}
      <p class="render-center-warning">
        Motion blur averages sub-frames on a canvas, which the server renderer cannot do.
        Set it to 1, or choose the Browser backend.
      </p>
    {/if}
    {#if submitError}
      <p class="render-center-error">Submit failed: {submitError}</p>
    {/if}

    <div class="render-center-actions">
      <button type="button" class="btn" disabled={submitting} onclick={submit}>
        <iconify-icon icon="mdi:movie-play-outline" width="16" height="16"></iconify-icon>
        Submit Render Job
      </button>
    </div>
    <p class="render-center-hint">
      A Server job keeps rendering if you close this dialog, refresh, or shut the laptop.
      Come back here any time to check on it.
    </p>
  </div>

  <!-- ── RIGHT: this project's renderings ────────────────────────────────── -->
  <div class="render-center-list">
    <h3 class="render-center-heading">Renderings — {project}</h3>
    {#if listError}
      <p class="render-center-error">Could not read the job list: {listError}</p>
    {/if}
    {#if jobs.length === 0}
      <p class="render-center-empty">No renders yet. Submit one on the left.</p>
    {/if}
    <div class="render-center-scroll">
      {#each jobs as job (job.id)}
        {@const open = expanded(job)}
        {@const fraction = jobProgress(job)}
        <div class="render-center-job" class:is-active={jobIsActive(job)} class:is-failed={job.state === "failed"}>
          <div class="render-center-job-head">
            <button
              type="button"
              class="render-center-disclose"
              aria-expanded={open}
              aria-label={open ? `Collapse ${job.name}` : `Expand ${job.name}`}
              onclick={() => toggle(job)}
            >
              <iconify-icon icon={open ? "mdi:chevron-down" : "mdi:chevron-right"} width="16" height="16"></iconify-icon>
              <iconify-icon icon={STATE_ICONS[job.state]} width="16" height="16"></iconify-icon>
              <span class="render-center-job-name">{job.name}</span>
            </button>
            <span class="render-center-job-backend">{job.backend === "server" ? "server" : "browser"}</span>
            {#if !job.seen && job.state === "done"}<span class="render-center-dot" aria-label="Not yet seen"></span>{/if}
            {#if jobIsActive(job)}
              <Tooltip text="Cancel this render">
                <button type="button" class="btn-icon" aria-label={`Cancel ${job.name}`} onclick={() => cancel(job)}>
                  <iconify-icon icon="mdi:stop-circle-outline" width="16" height="16"></iconify-icon>
                </button>
              </Tooltip>
            {:else}
              <Tooltip text="Delete this render and its file">
                <button type="button" class="btn-icon" aria-label={`Delete ${job.name}`} onclick={() => remove(job)}>
                  <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
                </button>
              </Tooltip>
            {/if}
          </div>

          <p class="render-center-job-status">{jobStatusLine(job)}</p>

          {#if jobIsActive(job)}
            <div class="render-center-bar">
              <div
                class="render-center-bar-fill"
                class:is-indeterminate={fraction === null || job.state === "encoding"}
                style:width={fraction !== null && job.state !== "encoding" ? `${Math.floor(fraction * 100)}%` : null}
              ></div>
            </div>
          {/if}

          {#if job.warning}
            <p class="render-center-warning">{job.warning}</p>
          {/if}
          {#if job.error}
            <p class="render-center-error">{job.error}</p>
          {/if}

          {#if open && job.state === "done" && job.output}
            <!-- Mounted ONLY while expanded — that is the whole reason rows
                 collapse by default (see the header). -->
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="render-center-video" src={renderUrl(project, job.output)} controls preload="metadata"></video>
            <div class="render-center-meta">
              <span>{humanReadableFileSize(job.bytes)}</span>
              <span>{job.params.width}×{job.params.height} · {job.params.fps} fps</span>
            </div>
            <div class="render-center-path">
              <code class="render-center-pathtext">{job.outputPath}</code>
              <Tooltip text={copiedPath === job.id ? "Copied" : "Copy the full path"}>
                <button type="button" class="btn-icon" aria-label="Copy the full file path" onclick={() => copyPath(job)}>
                  <iconify-icon icon={copiedPath === job.id ? "mdi:check" : "mdi:content-copy"} width="16" height="16"></iconify-icon>
                </button>
              </Tooltip>
            </div>
            <div class="render-center-job-actions">
              <a class="btn" href={renderUrl(project, job.output)} download={job.output}>
                <iconify-icon icon="mdi:download" width="16" height="16"></iconify-icon>
                Download
              </a>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
