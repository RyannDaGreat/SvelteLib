<!--
  RenderCenterModal — the RENDER CENTER. Two panes: SUBMIT on the left, this
  project's RENDERINGS on the right, with a DRAGGABLE divider between them.
  (App.svelte owns the <Modal> wrapper, mirroring BuiltinAssetBrowser.)

  THE DIVIDER IS THE SHARED SPLITTER, and it is SplitView rather than SplitPane
  deliberately. SplitPane is the styled wrapper: it positions its panes
  ABSOLUTELY inside a `height: 100%` root, which needs a definite height from an
  ancestor. This dialog has none — the shared Modal's `.modal-body` owns the
  vertical scroll, and it is CONTENT-SIZED whenever the content fits (measured at
  1400x900: an 810px panel, and a body whose clientHeight === scrollHeight === 666),
  so `height: 100%` would resolve to auto and every absolutely-positioned pane
  would collapse to zero height. Forcing
  a fixed pixel height instead would silently CLIP the form the first time someone
  adds a row. SplitView is the same component minus the layout: identical drag
  math, constraint resolution, spring-back and pixel floor, with the panes left in
  normal flow so the block keeps its content height and the Modal keeps owning the
  scroll (which tests/render_center_reach_probe.js asserts).

  WHY THIS REPLACED "Export as MP4". The old dialog WAS the render: it held the
  frame loop and the progress in component state, so closing it, refreshing, or an
  editor hot-reload destroyed an in-flight export with no way to find it again —
  a five-hour render lost to a stray reload. A render is now a JOB WITH A RECORD
  OUTSIDE THIS COMPONENT. Submitting hands over a snapshot and returns; this dialog
  then knows nothing the record store cannot re-tell it, which is exactly why it can
  be closed and reopened (or opened in a different tab tomorrow) and show the same
  truth. Everything on the right is POLLED, never remembered.

  ── TWO MODES, AND STATIC MODE IS NOT A DEGRADED ONE ────────────────────────────
  THE RULING (user, looking at the static site showing "Encoded by: Upload frames",
  a pink "Render jobs need the PowerRP project server" and a dead "Submit Render Job
  — needs a server" button): "We spent a long time creating an in-browser rendering
  system. When we're on a static site, why not just hook up that file system and only
  have the Browser option? Why even have the upload-frames option and why force a
  renderings list if we could just do it all in the browser? The storage here should
  be capable of holding such videos, right?"

  It is. The frames were ALWAYS made in this page for a Browser render; the only
  server-shaped thing was the RECORD, and that now has an IndexedDB home
  (web/localRenderStore.js) chosen at boot by web/renderBackend.js. So in static mode
  this dialog is not a reduced version of itself — it is the browser pipeline, whole:

    Rendered by  — fixed to Browser. Shown as a STATED FACT, not a one-option
                   dropdown: a picker you cannot pick from is furniture that looks
                   like a control, and the user's objection was precisely to being
                   offered choices that are not choices.
    Encoded by   — "Encode in page" only. "Upload frames" is a TRANSPORT (a PNG per
                   frame POSTed to a server that then runs ffmpeg), so with no server
                   it cannot work at all — it is not a slower alternative here, it is
                   an absent one. renderBackend.selectableEncoders() is the authority.
    Render       — a real button that runs the pipeline. Not "Submit Render Job":
                   nothing is being submitted anywhere, and the word promised a
                   detachment this mode does not have.
    Renderings   — read from browser storage, per project (or draft) key. The pink
                   error is GONE, and it should never have been shown: it was the
                   truth about server JOBS, but the LIST had no business asking a
                   server in a mode where the renders are local.

  What does NOT change in static mode: the frame walk, the motion blur, the letterbox
  composite, the encoder, pause/resume across a closed tab. Those are the same modules
  either way, which is the whole reason this was plumbing and not a new renderer.

  BACKENDS (HTTP mode; static mode has only the second). `backend` is a FIELD on one
  job rather than a second system, because the only thing that differs is WHO
  PRODUCES THE PIXELS — both end in the same job record, the same renders/ folder and
  this same list:
    Server  — detached; survives a closed laptop, a refresh, even a server
              restart. It renders in a headless browser running THIS app, so it
              draws everything this page draws (media, LaTeX, Mermaid, motion
              blur). The default, and the only honest answer to "will this still
              be going when I come back".
    Browser — this page renders the frames. It stays because the machine sitting
              in front of the user may have a GPU the server does not. Closing the
              tab PAUSES a browser render and reopening the project RESUMES it
              (web/browserRenderJobs.js); the rows say exactly that rather than
              implying it kept going, because it did not.

  BROWSER ENCODERS. Two, both resumable, differing in where the bytes are compressed
  and — the part the user must be told — how precisely a paused render resumes.
  "Upload frames" is faster at ordinary output sizes and resumes at an EXACT frame;
  "Encode in page" streams no pixels anywhere and needs no server scratch disk, but
  resumes at a segment boundary. The measurements behind that are in
  web/browserRenderJobs.js's header; the dropdown states the consequence.

  WHO KNOWS THE PROGRESS. For a server job, the server does (it counts frames on
  disk) — which is why everything on the right is POLLED. For a browser job the
  server has no handle on the tab making the frames, so the live truth comes from
  web/browserRenderJobs.js instead, read on the same poll. That is not a second
  system; it is the honest answer to "how far along is this".

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
  import SplitView from "../../../lib/SplitView.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { cameraRectAt } from "./cameraFrame.js";
  import { humanReadableFileSize } from "./fileSize.js";
  import { DEFAULT_FPS, DEFAULT_HOLD_SECONDS, DEFAULT_SAMPLES, planForParams, frameCount } from "./videoExport.js";
  // The form's pure vocabulary: bounds, codec constants, the job→settings
  // mapping and the persisted-settings sanitizer live in one doctested module.
  import {
    QUALITY_CRF, CRF_MIN, CRF_MAX, DEFAULT_CRF,
    MIN_DIM, MAX_DIM, MIN_FPS, MAX_FPS, MAX_HOLD_SECONDS, MIN_SAMPLES, MAX_SAMPLES,
    STANDARD_RESOLUTIONS, evenDim, settingsFromJob, sanitizeSettings, loadSettings, saveSettings,
  } from "./renderCenterSettings.js";
  // THE RECORD STORE, not projectApi directly — HTTP mode gets the server, static
  // mode gets IndexedDB, and every call below is identical either way. See the
  // header's "TWO MODES" and web/renderBackend.js.
  import { renderRecordStore, rendersAreLocal, selectableEncoders, defaultEncoderForMode, usableEncoder } from "./renderBackend.js";
  import { renderUrl } from "./projectApi.js";
  import { renderingBlob, renderQuotaWarning } from "./localRenderStore.js";
  // The job vocabulary (active? unseen? how far? what does this state MEAN?)
  // lives in one pure module because the toolbar badge reads the same
  // predicates — two copies would be two chances to disagree about what the
  // badge counts. See web/renderJobView.js.
  import { jobIsActive, defaultExpanded, jobProgress, jobStatusLine, warningPreview, etaEstimate, etaSuffix, STATE_ICONS, ACTIVE_STATES } from "./renderJobView.js";
  // A browser job's progress and its paused/rendering distinction come from the
  // browser, not the server — see the header's "WHO KNOWS THE PROGRESS".
  import {
    browserJobStatuses, forgetBrowserRenderJob, pruneFinishedBrowserJobs,
  } from "./browserRenderJobs.js";
  import { browserJobStatusLine, browserJobProgress, canResume } from "./browserJobView.js";

  let { app } = $props();

  // Form bounds and evenDim: imported from renderCenterSettings.js so the form
  // clamps with the SAME numbers the persisted-settings sanitizer uses.
  // How often the right pane re-asks the server. Progress is a directory listing
  // server-side, so this is cheap; 1 s reads as live without hammering a backend
  // that is also running the render.
  const POLL_MS = 1000;

  /** Pure. Clamp a 1-based slide number into [1, slideCount]. */
  function clampSlide(n) {
    return Math.max(1, Math.min(slideCount, Math.round(n)));
  }
  /**
   * Pure. Clamp a CRF into the codec's valid range [CRF_MIN, CRF_MAX]. THROWS on a
   * non-finite input rather than propagating NaN: NaN survives Math.round AND both
   * Math clamps, and JSON.stringify writes it as `null` — so the server could only
   * ever report "crf must be an int" about a value this dialog never meant to send.
   *
   * @param {number} n - Desired CRF
   * @returns {number} An integer in [CRF_MIN, CRF_MAX]
   *
   * @example clampCrf(23.4) // 23
   * @example clampCrf(-5)   // CRF_MIN
   * @example clampCrf(NaN)  // throws
   */
  function clampCrf(n) {
    if (!Number.isFinite(n))
      throw new Error(`RenderCenterModal: CRF is not a finite number (got ${JSON.stringify(n)})`);
    return Math.max(CRF_MIN, Math.min(CRF_MAX, Math.round(n)));
  }
  /**
   * Pure. The codec CRF a quality choice means. TOTAL AND LOUD: an unknown key used
   * to yield `undefined`, which JSON.stringify DROPS from the request body — turning
   * a one-word client mistake into an opaque server validation error about a field
   * the client never sent. Same idiom as web/mp4Encoder.js encoderQp.
   *
   * @param {string} key - A codecQuality choice ("low" | "medium" | "high")
   * @returns {number} That choice's CRF
   *
   * @example presetCrf("medium") // 23
   * @example presetCrf("lowish") // throws, naming the valid keys
   */
  function presetCrf(key) {
    const crf = QUALITY_CRF[key];
    if (crf === undefined)
      throw new Error(`RenderCenterModal: unknown codec quality ${JSON.stringify(key)} — expected one of ${Object.keys(QUALITY_CRF).join(", ")}, custom`);
    return crf;
  }
  /**
   * Pure. What choosing this backend MEANS, for the hint under the row. Total and
   * loud for presetCrf's reason: a missing key would otherwise render the string
   * "undefined" as help text, which is worse than no help at all.
   *
   * @param {string} key - A backend choice ("server" | "browser")
   * @returns {string} That choice's consequence, one paragraph
   *
   * @example backendHint("browser") // "THIS PAGE renders the frames, so the render uses your GPU rather than the server's."
   * @example backendHint("cloud")   // throws, naming the valid keys
   */
  function backendHint(key) {
    const entry = BACKENDS.find((b) => b.value === key);
    if (!entry)
      throw new Error(`RenderCenterModal: unknown backend ${JSON.stringify(key)} — expected one of ${BACKENDS.map((b) => b.value).join(", ")}`);
    return entry.hint;
  }

  // THE CAMERA's size at the current slide = the default output size (the camera
  // owns the frame). Read ONCE at mount via untrack (the modal remounts on each
  // open, so these snapshot the deck as the dialog opens).
  const cam = untrack(() => cameraRectAt(app.doc, app.slideIndex, 1, app.registry));
  const camW = evenDim(cam.w);
  const camH = evenDim(cam.h);
  const slideCount = untrack(() => app.doc.slides.length);
  // THE PROJECT KEY, and it is what keys the renderings too. For a saved project it
  // is its name; for an UNSAVED DRAFT it is the reserved draft key, so a draft's
  // renders live with the draft exactly the way its assets do (see
  // web/localRenderStore.js's keying note).
  const project = untrack(() => app.projectName());
  // The deck's HUMAN name for the heading. `project` is a storage key and for a
  // draft it reads "~draft/current", which is not what to put in front of a user.
  const projectLabel = untrack(() => app.projectDisplayName());

  // ── MODE: a BOOT CONSTANT, read once, exactly as the rest of the app reads
  // isStatic(). Not $derived: the storage mode cannot change while the page is
  // open, and a reactive read would invite a half-server, half-local dialog.
  const LOCAL_RENDERS = rendersAreLocal();
  const ENCODERS = selectableEncoders();

  const RESOLUTIONS = [
    { value: "camera", label: `Camera size — ${camW}×${camH}`, w: camW, h: camH },
    ...STANDARD_RESOLUTIONS,
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
  // The server backend renders in a headless browser running THIS app, so it draws
  // everything this page draws — media, LaTeX, Mermaid, motion blur. "needed for
  // media" was true of the old bare-node renderer and is no longer.
  //
  // ONE WORD PER LABEL, and the consequence in `hint`. The labels used to BE the
  // help text ("Server — keeps going if you close this", "Browser — this page
  // renders (uses your GPU)"), which sized the trigger to 354.9px inside a 300px
  // cell and sent the open menu 38.9px into the renderings pane and over a
  // finished render's <video>. app.css's `.render-center-control .dd { width:100% }`
  // is what stops a trigger outgrowing its cell now, so the geometry no longer
  // depends on how long a label is — but a dropdown row is still the wrong home
  // for a sentence: it can only ever ellipsize one. The hint paragraph under the
  // row is where this dialog already puts consequences (see the CRF, motion-blur
  // and letterbox rows), it is readable without hovering anything, and it can say
  // more than a row ever could.
  //
  // IN STATIC MODE THE SERVER ENTRY IS ABSENT, not disabled: there is no detached
  // process to hand a snapshot to, and "Browser" then stops being a choice at all
  // (see the header's TWO MODES). The Browser entry's hint changes with it, because
  // the sentence "rather than the server's" compares against something that does not
  // exist here — and because the thing a user most needs to know in this mode is
  // where the finished movie goes.
  const ALL_BACKENDS = [
    {
      value: "server",
      label: "Server",
      hint: "The SERVER renders it, in a headless browser running this app — so it draws everything this page draws. It keeps going if you close this dialog, refresh, or shut the laptop; come back here any time to check on it.",
    },
    {
      value: "browser",
      label: "Browser",
      hint: LOCAL_RENDERS
        ? "THIS PAGE renders and encodes the whole movie — no server is involved at any point. The finished .mp4 is kept in this browser's storage, listed on the right, and downloadable from there. Closing the tab PAUSES a render; reopen this deck and press Resume to continue."
        : "THIS PAGE renders the frames, so the render uses your GPU rather than the server's.",
    },
  ];
  const BACKENDS = LOCAL_RENDERS ? ALL_BACKENDS.filter((b) => b.value === "browser") : ALL_BACKENDS;
  const BACKEND_VALUES = BACKENDS.map((b) => b.value);

  // The form's initial share of the dialog's width, and the pixel floor the
  // divider may not squash either pane past.
  //
  // 0.5 lands the form at ~430px, which is the ~420px it was fixed at before the
  // divider existed; the user rebalances from there. The floor is NOT decoration:
  // the form's label column is a fixed --a-render-label-w and cannot compress, so
  // a pane narrower than its own min-content would make the rows overflow the pane
  // — re-creating, from the other direction, the exact "control paints over the
  // next pane" defect this dialog was just fixed for. 260px = that label column
  // plus a control still worth looking at.
  const INITIAL_FORM_SPLIT = 0.5;
  const MIN_PANE_PX = 260;
  // NOT persisted, deliberately: the app's other splitters (App.svelte's hSplits /
  // leftSplits / rightSplits) are plain $state and reset on reload, and the modal
  // remounts on every open, so remembering this one would be a new mechanism that
  // no sibling has. If it should be sticky, it belongs with those three.
  let splits = $state([INITIAL_FORM_SPLIT]);

  // ── Form state ──────────────────────────────────────────────────────────
  // Defaults double as the persisted-settings SCHEMA (sanitizeSettings): the
  // keys here decide which fields exist. The modal remounts on every open, so
  // the form's persistence across close/reopen — and across reloads — is the
  // localStorage round-trip below, sanitized on the way back in.
  const FORM_DEFAULTS = {
    name: projectLabel,
    // "server" is not a choice in static mode and not even a stored one — the whole
    // pipeline is this page. A persisted "server" from an HTTP session opened on the
    // static site would otherwise sit in the form and submit into nothing.
    backend: LOCAL_RENDERS ? "browser" : "server",
    resolution: "camera",
    customW: camW,
    customH: camH,
    fps: DEFAULT_FPS,
    codecQuality: "medium",
    customCrf: DEFAULT_CRF, // libx264 CRF when codecQuality === "custom"
    rangeMode: "all",
    rangeFrom: 1,
    rangeTo: slideCount,
    includeTransitions: true,
    holdSeconds: DEFAULT_HOLD_SECONDS,
    background: "#000000",
    samples: DEFAULT_SAMPLES, // temporal subsamples (1 = no motion blur)
    browserEncoder: defaultEncoderForMode(),
  };
  // The sanitizer is handed the encoders THIS MODE offers, so a settings blob
  // written by an HTTP session ("upload") resolves to the one that works here
  // instead of arming a submit that cannot encode a frame.
  const ENCODER_VALUES = ENCODERS.map((e) => e.value);
  const savedSettings = loadSettings(localStorage, FORM_DEFAULTS, slideCount, ENCODER_VALUES, BACKEND_VALUES);

  let jobName = $state(savedSettings.name);
  let backend = $state(savedSettings.backend);
  let resolution = $state(savedSettings.resolution);
  let customW = $state(savedSettings.customW);
  let customH = $state(savedSettings.customH);
  let fps = $state(savedSettings.fps);
  let codecQuality = $state(savedSettings.codecQuality);
  let customCrf = $state(savedSettings.customCrf);
  let rangeMode = $state(savedSettings.rangeMode);
  let rangeFrom = $state(savedSettings.rangeFrom);
  let rangeTo = $state(savedSettings.rangeTo);
  let includeTransitions = $state(savedSettings.includeTransitions);
  let holdSeconds = $state(savedSettings.holdSeconds);
  let background = $state(savedSettings.background);
  let samples = $state(savedSettings.samples);
  let browserEncoder = $state(savedSettings.browserEncoder);
  let submitError = $state(null);
  let submitting = $state(false);

  /** Query. The form as one settings object (the persistence/copy shape). */
  function currentSettings() {
    return {
      name: jobName, backend, resolution, customW, customH, fps, codecQuality,
      customCrf, rangeMode, rangeFrom, rangeTo, includeTransitions, holdSeconds,
      background, samples, browserEncoder,
    };
  }

  /** Command. Set every form field from a complete settings object. */
  function applySettings(s) {
    jobName = s.name; backend = s.backend; resolution = s.resolution;
    customW = s.customW; customH = s.customH; fps = s.fps;
    codecQuality = s.codecQuality; customCrf = s.customCrf;
    rangeMode = s.rangeMode; rangeFrom = s.rangeFrom; rangeTo = s.rangeTo;
    includeTransitions = s.includeTransitions; holdSeconds = s.holdSeconds;
    background = s.background; samples = s.samples; browserEncoder = s.browserEncoder;
  }

  // Persist on every form change. `name` is left out: it defaults to the
  // PROJECT's name, and remembering one project's render name across projects
  // would title the next deck's movie after this one.
  $effect(() => {
    const { name: _name, ...rest } = currentSettings();
    saveSettings(localStorage, rest);
  });

  /** Command. The "Reset to defaults" button: the form goes back to its
   *  defaults; the persistence effect then overwrites the stored settings. */
  function resetSettings() {
    applySettings(FORM_DEFAULTS);
  }

  /** Command. The per-job "use these settings" button: the job's params, mapped
   *  back into form words (settingsFromJob) and sanitized against the CURRENT
   *  form (so fields the record cannot know — browserEncoder — keep their
   *  values). Flashes the row's button as feedback, like copyPath. */
  let copiedSettings = $state(null);
  function copySettings(job) {
    applySettings(sanitizeSettings(settingsFromJob(job, slideCount, camW, camH), currentSettings(), slideCount, ENCODER_VALUES, BACKEND_VALUES));
    copiedSettings = job.id;
    setTimeout(() => { if (copiedSettings === job.id) copiedSettings = null; }, COPY_FLASH_MS);
  }

  // ── Render ETA (rp.eta's math — see renderJobView.etaEstimate) ───────────
  // One observed session per rendering job: first sight of it on a poll records
  // {frames already done, when} so pre-existing frames (a RESUMED job) never
  // count toward the rate. Plain Map, not $state: the poll's `jobs` update
  // already re-renders the rows each second, which re-runs renderEtaSuffix.
  const etaSessions = new Map();
  /** Query (reads the session map + the clock). The " · ETR …" suffix for a
   *  job row, "" until the session has progress to extrapolate from. */
  function renderEtaSuffix(job) {
    if (job.state !== "rendering" || !job.framesTotal) {
      etaSessions.delete(job.id);
      return "";
    }
    const now = Date.now();
    let s = etaSessions.get(job.id);
    if (!s || job.framesDone < s.startN) { // new sight, or the worker restarted behind us
      s = { startN: job.framesDone, startTime: now };
      etaSessions.set(job.id, s);
    }
    return etaSuffix(etaEstimate(job.framesDone, job.framesTotal, s.startN, (now - s.startTime) / 1000));
  }

  // ── Right pane: polled job list ─────────────────────────────────────────
  // `jobs` is server truth, refreshed on a timer. `browserStatus` is the BROWSER's
  // truth for browser jobs, read on the same poll (see the header's "WHO KNOWS THE
  // PROGRESS"). `overrides` records rows the user explicitly opened/closed — an
  // explicit choice must beat the default for as long as the dialog is open.
  let jobs = $state([]);
  let browserStatus = $state({});
  let listError = $state(null);
  let overrides = $state({});
  let poll = null;

  /** Command (async). Re-read the job list AND this browser's own view of its
   *  browser jobs. Errors are shown in the pane rather than thrown away — a
   *  backend that has gone away must be visible, not a list that silently stops
   *  updating. */
  async function refresh() {
    // NO STATIC BRANCH, and its removal is the user-visible half of this whole
    // change. This used to short-circuit to a pink "Render jobs need the PowerRP
    // project server" — which was TRUE OF SERVER JOBS and false of this list. The
    // renderings live in browser storage in static mode, so asking for them is the
    // same call it always was; renderRecordStore() decides who answers it.
    try {
      jobs = await renderRecordStore().listRenderJobs(project);
      browserStatus = await browserJobStatuses(project);
      listError = null;
    } catch (e) {
      listError = String(e?.message ?? e);
    }
  }

  refresh();
  // Resume data for a job the record store has already finished (or lost) is dead
  // weight AND a lie — it would let the dialog offer to resume something that is
  // over. One sweep per open, reported rather than silent. It runs in BOTH modes
  // now: it compares local resume data against a job list, and static mode has one.
  pruneFinishedBrowserJobs(project)
    .then((dropped) => { if (dropped.length) console.info(`Render Center: dropped local resume data for ${dropped.length} finished render job(s).`); })
    .catch((e) => console.error("Render Center: could not prune finished browser render jobs:", e));
  // POLLED IN BOTH MODES. In HTTP mode the poll is how server progress arrives; in
  // static mode the frames are being made in this very page and `live` is updated
  // between them, so the poll is what moves the bar. Same interval, same reason:
  // this dialog holds nothing and re-asks for everything.
  poll = setInterval(refresh, POLL_MS);
  onDestroy(() => clearInterval(poll));

  // ── Derived effective params ──────────────────────────────────────────────
  let preset = $derived(RESOLUTIONS.find((r) => r.value === resolution));
  let width = $derived(resolution === "custom" ? evenDim(customW) : preset.w);
  let height = $derived(resolution === "custom" ? evenDim(customH) : preset.h);
  let crf = $derived(codecQuality === "custom" ? clampCrf(customCrf) : presetCrf(codecQuality));
  let startIndex = $derived(rangeMode === "all" ? 0 : clampSlide(rangeFrom) - 1);
  let endIndex = $derived(rangeMode === "all" ? slideCount - 1 : clampSlide(rangeTo) - 1);
  // THE TIMELINE'S LENGTH, from the SAME pure planner the render itself walks
  // (videoExport.planForParams). Not an approximation of it: the summary line, the
  // storage estimate and the frames the pipeline actually produces must agree, and
  // re-deriving "range x hold plus transitions" by hand here would be a second
  // definition of how long a render is. The doc is read untracked-at-mount (`cam`
  // and `slideCount` above are too) — this modal remounts on every open.
  let estimatedDuration = $derived(
    planForParams(app.doc, { startIndex, endIndex, includeTransitions, holdSeconds }).duration,
  );
  let estimatedFrames = $derived(frameCount(estimatedDuration, fps));
  // (Motion blur used to be Browser-backend-only: the server rendered in bare node
  // with no canvas to average sub-frames on. The server worker now drives the SAME
  // frame sampler in a real headless browser, so both backends blur identically and
  // there is no restriction left to warn about.)

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
      renderRecordStore().markRenderJobSeen(project, job.id).then(refresh).catch((e) => (listError = String(e?.message ?? e)));
    }
  }

  // ── QUOTA HONESTY (static mode only) ──────────────────────────────────────
  // A long 1080p render is a real number of megabytes and browser storage is not a
  // disk. The user must hear the estimate BEFORE spending twenty minutes producing
  // it — not as a refused write afterwards, which in this mode loses the movie
  // outright (there are no frames on a server to finish from).
  //
  // IT WARNS AND NEVER REFUSES. The estimate is a generous guess over content whose
  // real H.264 rate varies by more than 10x, and browsers granularize their quota
  // numbers to resist fingerprinting — so a hard block would stop legitimate
  // renders on the strength of a number that is admittedly approximate. The
  // sentence is localRenderStore.quotaWarning's; the Render button beside it stays
  // live. Recomputed as the form changes, so it tracks resolution/fps/range edits.
  let quotaNotice = $state(null);
  $effect(() => {
    if (!LOCAL_RENDERS) return;
    // Read every dependency BEFORE the await — an $effect only tracks what it
    // touches synchronously, and reading these after it would make the notice stop
    // updating when the form changed.
    const shape = { width, height, fps, durationSeconds: estimatedDuration };
    let live = true;
    renderQuotaWarning(shape)
      .then((text) => { if (live) quotaNotice = text; })
      // A diagnostic readout must not break the dialog it sits in, but it must not
      // vanish silently either: the console gets the reason and the pane says the
      // check could not be made rather than implying it passed.
      .catch((e) => {
        console.error("Render Center: could not estimate storage headroom:", e);
        if (live) quotaNotice = `Could not check whether this render will fit in browser storage: ${String(e?.message ?? e)}`;
      });
    return () => { live = false; };
  });

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
        // SUBSTITUTED, not passed through, for the one case the sanitizer cannot
        // cover: settings persisted while the form was mounted in an HTTP session,
        // then reused here. The user asked for "encode this render", and in static
        // mode there is exactly one way to do that — the row above says which.
        encoder: usableEncoder(browserEncoder, ENCODERS, defaultEncoderForMode()), // ignored by the server backend
        // NO `quality` FIELD HERE. One used to be sent as "full" and read by
        // NOBODY — not server.py, not renderJobPage.js, not browserRenderJobs.js.
        // A dead field that looks live is a trap: the next person adding a
        // draft/proxy render tier would wire it here and get silence. If that tier
        // arrives, add the field AND its reader in the same change.
        params: {
          width, height, fps, crf, samples: Math.round(samples),
          startIndex, endIndex, includeTransitions, holdSeconds, background,
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

  /** Command (async). Cancel a running job; the list reflects it on refresh. A
   *  browser job's local resume data goes too — a cancelled render must not still
   *  offer to continue. */
  async function cancel(job) {
    try {
      await renderRecordStore().cancelRenderJob(project, job.id);
      if (job.backend === "client") await forgetBrowserRenderJob(job.id);
      await refresh();
    } catch (e) {
      listError = String(e?.message ?? e);
    }
  }

  /** Command (async). Delete a finished job's record AND its movie (and, for a
   *  browser job, any resume data still held here). */
  async function remove(job) {
    try {
      // Revoke the row's object URL BEFORE the record goes: it is minted from a
      // blob that is about to stop existing, and a leaked blob: URL pins the whole
      // movie in memory for the life of the page (the exact leak
      // localAssetStore's revokeUrl exists to prevent, in the same shape).
      dropLocalUrl(job.id);
      await renderRecordStore().deleteRenderJob(project, job.id);
      if (job.backend === "client") await forgetBrowserRenderJob(job.id);
      await refresh();
    } catch (e) {
      listError = String(e?.message ?? e);
    }
  }

  /** Command (async). Continue a PAUSED browser render from where it stopped. Not
   *  awaited to completion — the row tracks it on the poll, exactly as a submit
   *  does, so this dialog can be closed again immediately. */
  function resume(job) {
    app.resumeRender(job.id)
      .then(refresh)
      .catch((e) => (listError = String(e?.message ?? e)));
    refresh();
  }

  /** Command (async). Copy a job's absolute output path to the clipboard. */
  let copiedPath = $state(null);
  const COPY_FLASH_MS = 1200;
  async function copyPath(job) {
    await navigator.clipboard.writeText(job.outputPath);
    copiedPath = job.id;
    setTimeout(() => { if (copiedPath === job.id) copiedPath = null; }, COPY_FLASH_MS);
  }

  // ── A LOCAL RENDERING'S URL ───────────────────────────────────────────────
  // In HTTP mode a finished movie has a URL the server serves (renderUrl). A
  // rendering in browser storage has none until one is MINTED from its blob, so
  // this mints one per row, lazily and exactly once, and revokes it on delete and
  // on close.
  //
  // WHY LAZILY, AND ONLY FOR AN EXPANDED ROW: a blob: URL pins its blob for as long
  // as it lives, so minting one per finished render on open would hold every movie
  // in the project in memory at once — the same reason rows collapse by default
  // (see the header). Memoized rather than minted per read because a `src` is read
  // on every re-render of the row, and a fresh URL each time would restart the
  // <video> element's load a second at a time.

  /** jobId → blob: URL for renderings in browser storage. Page-lifetime memo,
   *  cleared on delete (dropLocalUrl) and on unmount. */
  const localUrls = new Map();
  /** jobIds whose blob is currently being fetched, so the poll's re-render cannot
   *  start a second read of the same movie while the first is in flight. */
  const localUrlPending = new Set();
  /** A $state counter bumped when a URL lands, so the row re-renders and picks it
   *  up. The Map itself is deliberately NOT $state — a reactive Map holding blob:
   *  URLs would be a proxy around values the <video> src reads on every frame. */
  let localUrlEpoch = $state(0);

  /**
   * Query (async on a miss; reads IndexedDB and mints an object URL). The URL for a
   * finished rendering's movie, or null while it is still being read. A null return
   * is a transient state, not an error: the row shows the meta line without a
   * <video> until the next epoch bump, milliseconds later.
   */
  function localUrl(jobId) {
    const url = localUrls.get(jobId);
    if (url) return url;
    if (localUrlPending.has(jobId)) return null;
    localUrlPending.add(jobId);
    renderingBlob(project, jobId)
      .then((blob) => {
        localUrls.set(jobId, URL.createObjectURL(blob));
        localUrlPending.delete(jobId);
        localUrlEpoch += 1;
      })
      .catch((e) => {
        localUrlPending.delete(jobId);
        // A finished row whose bytes cannot be read is a real failure the user must
        // see — the movie is gone, and silence would leave a Download button that
        // does nothing.
        listError = `Could not read the finished render from browser storage: ${String(e?.message ?? e)}`;
      });
    return null;
  }

  /**
   * Query. `localUrl(jobId)`, with the epoch taken as an argument so the template's
   * read of it is a real, visible dependency rather than a comma-expression trick.
   * The epoch's VALUE is unused — its only job is to be read, so that bumping it
   * re-runs the row.
   */
  function localUrlAt(_epoch, jobId) {
    return localUrl(jobId);
  }

  /** Command. Revoke and forget one rendering's object URL. */
  function dropLocalUrl(jobId) {
    const url = localUrls.get(jobId);
    if (!url) return;
    URL.revokeObjectURL(url);
    localUrls.delete(jobId);
  }

  // EVERY minted URL is revoked when the dialog closes. The modal remounts on each
  // open, so without this a user who opened the Render Center five times would be
  // holding five copies of every movie they looked at.
  onDestroy(() => { for (const id of [...localUrls.keys()]) dropLocalUrl(id); });
</script>

<div class="render-center">
<SplitView orientation="horizontal" bind:splits minPanePx={MIN_PANE_PX}>
{#snippet children(state, actions)}
<div class="render-center-panes" class:is-dragging={state.dragging}>
  <!-- ── LEFT: submit ────────────────────────────────────────────────────── -->
  <div class="render-center-submit" style:width={`${state.splits[0] * 100}%`}>
    <div class="render-center-heading-row">
      <h3 class="render-center-heading">New render</h3>
      <Tooltip text="Reset every setting below to its default">
        <button type="button" class="btn-icon" aria-label="Reset render settings to defaults" onclick={resetSettings}>
          <iconify-icon icon="mdi:restore" width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
    </div>

    <label class="render-center-row">
      <span class="render-center-label">Name</span>
      <span class="render-center-control">
        <input class="render-center-text" type="text" bind:value={jobName} aria-label="Render name" />
      </span>
    </label>

    <!-- NOT a <label>, for the reason the Transitions row below already states: a
         Dropdown's trigger is a <button>, and clicking anything inside a <label>
         makes the label ALSO activate its control — so picking an option bubbled
         to the label, which re-clicked the trigger and RE-OPENED the menu you had
         just chosen from. Reproduced with real mouse clicks on every Dropdown row
         in this dialog; the Inspector's rows are plain <div>s and never had it. -->
    <div class="render-center-row">
      <span class="render-center-label">Rendered by</span>
      <!-- ONE OPTION IS STATED, NOT OFFERED. In static mode the browser is the only
           renderer, and a dropdown with a single entry is furniture that looks like a
           control — the user's objection ("only have the Browser option") was to
           exactly that kind of decoration. So the value is printed. -->
      <span class="render-center-control">
        {#if BACKENDS.length === 1}
          <span class="render-center-fixed">{BACKENDS[0].label}</span>
        {:else}
          <Dropdown items={BACKENDS} bind:value={backend} />
        {/if}
      </span>
    </div>
    <!-- The chosen backend's consequence, in prose, where the row could not say
         it. Always visible: "will this still be going when I come back" is the
         one thing about this dialog a user must not have to hover to learn. -->
    <p class="render-center-hint">{backendHint(backend)}</p>
    {#if backend === "browser"}
      <div class="render-center-row">
        <span class="render-center-label">Encoded by</span>
        <!-- Same rule as the row above. In static mode the ONLY encoder is the
             in-page one: "Upload frames" is a transport to a server, not a slower
             alternative, so it is absent rather than disabled. -->
        <span class="render-center-control">
          {#if ENCODERS.length === 1}
            <span class="render-center-fixed">{ENCODERS[0].label}</span>
          {:else}
            <Dropdown items={ENCODERS} bind:value={browserEncoder} />
          {/if}
        </span>
      </div>
      <p class="render-center-hint">
        Closing this tab PAUSES a browser render — it does not keep going. Reopen the
        project and press Resume to continue from
        {ENCODERS.find((e) => e.value === usableEncoder(browserEncoder, ENCODERS, defaultEncoderForMode()))?.resume} .
      </p>
    {/if}

    <div class="render-center-row">
      <span class="render-center-label">Resolution</span>
      <span class="render-center-control"><Dropdown items={RESOLUTIONS} bind:value={resolution} /></span>
    </div>
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

    <div class="render-center-row">
      <span class="render-center-label">Codec quality</span>
      <span class="render-center-control"><Dropdown items={CODEC_QUALITIES} bind:value={codecQuality} /></span>
    </div>
    {#if codecQuality === "custom"}
      <label class="render-center-row">
        <span class="render-center-label">CRF</span>
        <span class="render-center-control render-center-inline">
          <DraggableNumber bind:value={customCrf} min={CRF_MIN} max={CRF_MAX} step={1} label="H.264 constant rate factor" />
          <span class="render-center-hint">Lower is higher quality &amp; larger (0 lossless … 51 worst)</span>
        </span>
      </label>
    {/if}

    <div class="render-center-row">
      <span class="render-center-label">Slides</span>
      <span class="render-center-control"><Dropdown items={RANGE_MODES} bind:value={rangeMode} /></span>
    </div>
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
      <span class="render-center-control"><DraggableNumber bind:value={holdSeconds} coefficient={0.5} min={0} max={MAX_HOLD_SECONDS} step={0.5} suffix=" s" label="Seconds each slide is held" /></span>
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

    <!-- The FRAME COUNT is here because it is the number that makes a render's cost
         concrete, and in static mode it is also the one this page is about to spend
         its own time on. Both numbers come from videoExport's own planner, so they
         cannot disagree with what gets rendered. -->
    <p class="render-center-summary">
      Output: {width}×{height} · {fps} fps · CRF {crf} (lower = higher quality) ·
      {estimatedFrames} frames ({estimatedDuration.toFixed(1)}s)
    </p>

    <!-- THE QUOTA WARNING. Static mode only, and it NEVER blocks the button beside
         it — see the `quotaNotice` effect for why a hard refusal on an admittedly
         rough estimate would be the wrong trade. -->
    {#if quotaNotice}
      <p class="render-center-warning-text render-center-quota">
        <iconify-icon icon="mdi:database-alert-outline" width="14" height="14"></iconify-icon>
        {quotaNotice}
      </p>
    {/if}

    {#if submitError}
      <p class="render-center-error">
        {LOCAL_RENDERS ? "Render failed" : "Submit failed"}: {submitError}
      </p>
    {/if}

    <div class="render-center-actions">
      <!-- ONE LIVE BUTTON IN BOTH MODES. This used to be DISABLED in static mode
           ("Submit Render Job — needs a server"), which was the visible face of the
           whole defect: the in-browser renderer existed and was unreachable. The WORD
           changes with the mode because the deed does — nothing is submitted anywhere
           in static mode; this page renders it. -->
      <button type="button" class="btn" disabled={submitting} onclick={submit}>
        <iconify-icon icon="mdi:movie-play-outline" width="16" height="16"></iconify-icon>
        {LOCAL_RENDERS ? "Render" : "Submit Render Job"}
      </button>
    </div>
    <!-- (The paragraph that used to sit here — "A Server job keeps rendering if
         you close this dialog…" — has moved into BACKENDS' server `hint`, up
         beside the choice it describes. It said the same thing while the BROWSER
         backend was selected, where it was simply not true of the job about to be
         submitted.) -->
  </div>

  <!-- THE DIVIDER. Absolutely positioned at the split boundary rather than being a
       flex column, so the two panes stay in normal flow (the whole reason this uses
       SplitView — see the header) while the handle still spans the full height. All
       drag behaviour is the shared splitter's; this element only reports mousedown. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="render-center-divider"
    style:left={`${state.splits[0] * 100}%`}
    role="separator"
    aria-orientation="vertical"
    onmousedown={(e) => actions.beginDrag(0, e)}
  ></div>

  <!-- ── RIGHT: this project's renderings ────────────────────────────────── -->
  <div class="render-center-list">
    <!-- The HUMAN name, not the storage key: for a draft `project` reads
         "~draft/current", which is where the renders live but not what to call the
         deck. -->
    <h3 class="render-center-heading">Renderings — {projectLabel}</h3>
    {#if LOCAL_RENDERS}
      <!-- WHERE THESE LIVE, said once. It matters: they are in this browser, not on
           a disk the user can browse to, and they travel with the deck's storage key
           — including a draft's, which is why an unsaved deck's renders are here at
           all and still here after a reload. -->
      <p class="render-center-hint">
        Kept in this browser's storage, with this deck. They survive a reload; Download
        saves one to your computer.
      </p>
    {/if}
    {#if listError}
      <p class="render-center-error">Could not read the job list: {listError}</p>
    {/if}
    {#if jobs.length === 0}
      <p class="render-center-empty">
        No renders yet. {LOCAL_RENDERS ? "Press Render on the left." : "Submit one on the left."}
      </p>
    {/if}
    <div class="render-center-scroll">
      {#each jobs as job (job.id)}
        {@const open = expanded(job)}
        <!-- A BROWSER job's progress and its paused/rendering distinction come from
             the browser; the server cannot see the tab making the frames. Falling
             back to the server's view for one would print "Rendering frame 412 of
             900" about a render that stopped when the tab closed. -->
        {@const isBrowser = job.backend === "client"}
        {@const bstatus = isBrowser ? (browserStatus[job.id] ?? null) : null}
        {@const active = jobIsActive(job)}
        {@const fraction = isBrowser ? browserJobProgress(bstatus, job) : jobProgress(job)}
        {@const paused = isBrowser && active && bstatus?.driver === "paused"}
        {@const resumable = canResume(job, bstatus, ACTIVE_STATES)}
        <div class="render-center-job" class:is-active={active} class:is-failed={job.state === "failed"}>
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
            <Tooltip text={copiedSettings === job.id ? "Settings copied to the form" : "Fill the form with this job's settings"}>
              <button type="button" class="btn-icon" aria-label={`Use ${job.name}'s render settings`} onclick={() => copySettings(job)}>
                <iconify-icon icon={copiedSettings === job.id ? "mdi:check" : "mdi:tune"} width="16" height="16"></iconify-icon>
              </button>
            </Tooltip>
            {#if resumable}
              <Tooltip text="Continue this render from where it stopped">
                <button type="button" class="btn-icon" aria-label={`Resume ${job.name}`} onclick={() => resume(job)}>
                  <iconify-icon icon="mdi:play-circle-outline" width="16" height="16"></iconify-icon>
                </button>
              </Tooltip>
            {/if}
            {#if active}
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

          <p class="render-center-job-status">
            {isBrowser && active ? browserJobStatusLine(job, bstatus) : jobStatusLine(job) + renderEtaSuffix(job)}
          </p>

          {#if active}
            <div class="render-center-bar">
              <!-- A PAUSED browser render must not animate: a sweeping bar reads as
                   work happening, and nothing is happening. -->
              <div
                class="render-center-bar-fill"
                class:is-paused={paused}
                class:is-indeterminate={!paused && (fraction === null || job.state === "encoding")}
                style:width={fraction !== null && (paused || job.state !== "encoding") ? `${Math.floor(fraction * 100)}%` : null}
              ></div>
            </div>
          {/if}

          {#if job.warning}
            <!-- Folded by default: a warning can be a deliberate essay (the
                 renderer reports once per render, loudly), and it must not bury
                 the video it sits on top of. The summary teases the first words;
                 the full text opens on demand. -->
            <details class="render-center-warning">
              <summary class="render-center-warning-summary">
                <iconify-icon class="render-center-warning-chevron" icon="mdi:chevron-right" width="14" height="14"></iconify-icon>
                <iconify-icon icon="mdi:alert-outline" width="14" height="14"></iconify-icon>
                <span class="render-center-warning-label">Warning</span>
                <span class="render-center-warning-preview">{warningPreview(job.warning)}</span>
              </summary>
              <p class="render-center-warning-text">{job.warning}</p>
            </details>
          {/if}
          {#if job.error}
            <p class="render-center-error">{job.error}</p>
          {/if}
          <!-- A browser render that stopped for a LOCAL reason (the encoder worker
               died, IndexedDB refused a write) leaves its explanation here and
               nowhere else: the server only ever learns "cancelled". Shown for a
               finished row too, which is exactly when the user is asking why. -->
          {#if bstatus?.error && bstatus.error !== job.error}
            <p class="render-center-error">{bstatus.error}</p>
          {/if}

          {#if open && job.state === "done" && job.output}
            <!-- ONE URL, TWO ORIGINS. A server-stored render has one the server
                 serves; a browser-stored one has none until it is minted from its
                 blob (localUrl, which reads IndexedDB once and memoizes). Both feed
                 the same <video> and the same Download link below, so the row's shape
                 does not fork with the mode. `localUrlEpoch` is read so the row
                 re-renders when a lazily-minted URL lands. -->
            {@const movieUrl = job.storage === "browser" ? localUrlAt(localUrlEpoch, job.id) : renderUrl(project, job.output)}
            <!-- Mounted ONLY while expanded — that is the whole reason rows
                 collapse by default (see the header). -->
            {#if movieUrl}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video class="render-center-video" src={movieUrl} controls preload="metadata"></video>
            {/if}
            <div class="render-center-meta">
              <span>{humanReadableFileSize(job.bytes)}</span>
              <span>{job.params.width}×{job.params.height} · {job.params.fps} fps</span>
              {#if job.durationSeconds}<span>{job.durationSeconds.toFixed(1)}s</span>{/if}
            </div>
            {#if job.outputPath}
              <!-- ONLY WHEN THERE IS A PATH. A browser-stored rendering has none, and
                   web/localRenderStore.js deliberately does not invent one — a fake
                   path is a lie the copy button would then put on the clipboard. -->
              <div class="render-center-path">
                <code class="render-center-pathtext">{job.outputPath}</code>
                <Tooltip text={copiedPath === job.id ? "Copied" : "Copy the full path"}>
                  <button type="button" class="btn-icon" aria-label="Copy the full file path" onclick={() => copyPath(job)}>
                    <iconify-icon icon={copiedPath === job.id ? "mdi:check" : "mdi:content-copy"} width="16" height="16"></iconify-icon>
                  </button>
                </Tooltip>
              </div>
            {/if}
            <div class="render-center-job-actions">
              <!-- `download` names the FILE the user gets. For a blob: URL it is the
                   only thing that does — without it the browser saves the object-URL
                   uuid with no extension, and the user is handed a file their player
                   refuses to open. -->
              <a class="btn" href={movieUrl} download={job.output} class:is-disabled={!movieUrl}>
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
{/snippet}
</SplitView>
</div>
