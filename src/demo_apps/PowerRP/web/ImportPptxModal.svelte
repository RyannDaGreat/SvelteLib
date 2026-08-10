<!--
  ImportPptxModal — drag a .pptx onto the canvas, get asked "Would you like to
  import?", then watch it happen. Two stages inside ONE Modal (App.svelte owns
  the Modal wrapper, mirroring every other app dialog):

    Stage "confirm" — "Would you like to import '<filename>' as a new
    project?" plus the SlideRangeField (defaulting to ALL, per the user's
    spec: "by default it imports all") and Import/Cancel buttons. Also where a
    PARSE failure (a corrupt/non-.pptx file) shows up — deck.js throws loudly
    on that, and readDeck's rejection lands here as a refusal, before any
    "would you like to" question is even meaningful.

    Stage "progress" — a live, scrolling, timestamped log of every progress
    event pptxImport.js's runImport emits, a bar per phase, and — once
    translation finishes — the translator's own report (font substitutions,
    refusals/warnings), SHOWN rather than folded away, because the user asked
    for something "very super informative" that "shows in detail everything
    that's happening", not a spinner with a summary at the end.

  OWNS NO DRAG/DROP WIRING — that lives in web/CanvasView.svelte's drop
  handler, which opens this modal already holding the dropped File (mirroring
  exactly how a dropped .zip reaches app.importProjectZip). This component's
  job starts at "here is a File" and ends at "the draft is open" or "here is
  why it isn't".

  STYLE: no <style> block (app-shell convention) — every class here is
  `.pptx-import-*` in app.css, chained to --a-* tokens.
-->
<script>
  import Modal from "../../../lib/Modal.svelte";
  import SlideRangeField from "./SlideRangeField.svelte";
  import { readDeck, runImport } from "./pptxImport.js";

  let {
    /** @type {object} The PowerRPApp instance. */
    app,
    /** @type {boolean} Bindable — whether the modal is shown. */
    open = $bindable(false),
    /** @type {File|null} The dropped/picked .pptx file. Set by the opener
     *  alongside `open = true`; this component reads it once per open. */
    file = null,
  } = $props();

  /** @typedef {"confirm"|"progress"} Stage */
  /** @type {Stage} */
  let stage = $state("confirm");

  let deckIR = $state(null); // parsed once the file is read (stage "confirm")
  let parseError = $state(null); // a readDeck() rejection — shown in place of the range picker

  let rangeMode = $state("all");
  let rangeFrom = $state(1);
  let rangeTo = $state(1);

  /** @typedef {{phase: string, detail: string, current?: number, total?: number, translateReport?: object}} ProgressEvent */
  /** @type {ProgressEvent[]} Every event runImport has emitted this run, oldest first — the log. */
  let log = $state([]);
  let latestByPhase = $state({}); // phase -> latest event, for the per-phase bars
  let importError = $state(null); // a runImport rejection (translator missing, translate threw, etc.)
  let finalResult = $state(null); // {ok, name, assetCount, translateReport} once runImport resolves

  const PHASES = [
    { id: "translating", label: "Translating" },
    { id: "uploading", label: "Staging assets" },
    { id: "finalizing", label: "Finalizing" },
  ];

  // Reset all per-open state and read the file the instant the modal opens —
  // the confirm dialog needs the slide COUNT to size the range picker, so
  // parsing (fast: ~91ms per core/pptx/deck.js's own measurement) happens
  // before the user sees anything but a brief "Reading…" state.
  $effect(() => {
    if (!open) return;
    stage = "confirm";
    deckIR = null;
    parseError = null;
    log = [];
    latestByPhase = {};
    importError = null;
    finalResult = null;
    rangeMode = "all";
    rangeFrom = 1;
    rangeTo = 1;
    const f = file;
    if (!f) return;
    f.arrayBuffer()
      .then((buf) => readDeck(new Uint8Array(buf)))
      .then((deck) => {
        deckIR = deck;
        rangeTo = deck.slides.length;
      })
      .catch((e) => { parseError = String(e?.message ?? e); });
  });

  /** Command. Appends one progress event to the log and updates that phase's
   *  latest-known state (what the per-phase bars read). */
  function onProgress(event) {
    log = [...log, { ...event, at: Date.now() }];
    latestByPhase = { ...latestByPhase, [event.phase]: event };
  }

  /** Command (async; may mutate app — opens a new draft). Runs stage 2. */
  async function startImport() {
    stage = "progress";
    importError = null;
    try {
      const result = await runImport(app, deckIR, { mode: rangeMode, from: rangeFrom, to: rangeTo }, file.name, onProgress);
      if (!result.ok) {
        // Cancelled at the unsaved-work guard — the CURRENT project's own
        // Save/Discard/Cancel dialog answered "cancel", so nothing was
        // imported. Closing this modal is the honest response; there is no
        // error to show.
        open = false;
        return;
      }
      finalResult = result;
    } catch (e) {
      console.error("PowerRP: .pptx import failed:", e);
      importError = String(e?.message ?? e);
    }
  }

  /** Pure. A phase's progress fraction in [0,1], or null when indeterminate
   *  (no total yet, or the phase hasn't started).
   *
   *  @example phaseFraction({current: 2, total: 4}) // 0.5
   *  @example phaseFraction(undefined) // null
   */
  function phaseFraction(event) {
    if (!event || !Number.isFinite(event.total) || event.total <= 0) return null;
    return Math.max(0, Math.min(1, (event.current ?? 0) / event.total));
  }

  /** Pure. Which PHASES entry is currently active/most-recent, for highlighting. */
  function isPhaseDone(phaseId) {
    const e = latestByPhase[phaseId];
    return Boolean(e && Number.isFinite(e.total) && e.current >= e.total);
  }
</script>

<Modal bind:open title="Import PowerPoint" titleIcon="mdi:microsoft-powerpoint" size={stage === "progress" ? "large" : "compact"} closeOnBackdrop={stage !== "progress"} closeOnEscape={stage !== "progress"}>
  {#if stage === "confirm"}
    <div class="pptx-import-confirm">
      <p class="pptx-import-question">
        Would you like to import <strong>“{file?.name ?? "this file"}”</strong> as a new project?
      </p>
      {#if parseError}
        <div class="name-modal-warning">Could not read “{file?.name}”: {parseError}</div>
        <div class="name-modal-note">Nothing was changed — the open project is untouched.</div>
      {:else if !deckIR}
        <p class="pptx-import-reading">Reading “{file?.name}”…</p>
      {:else}
        <p class="name-modal-note">{deckIR.slides.length} slide{deckIR.slides.length === 1 ? "" : "s"} found.</p>
        <SlideRangeField slideCount={deckIR.slides.length} bind:mode={rangeMode} bind:from={rangeFrom} bind:to={rangeTo} />
        <div class="name-modal-note">Opens as an unsaved draft — nothing is added to your project library until you save it.</div>
      {/if}
      <div class="name-modal-actions">
        <button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
        <button type="button" class="btn" disabled={!deckIR || parseError} onclick={startImport}>Import</button>
      </div>
    </div>
  {:else}
    <div class="pptx-import-progress">
      <div class="pptx-import-phases">
        {#each PHASES as p (p.id)}
          {@const event = latestByPhase[p.id]}
          {@const frac = phaseFraction(event)}
          <div class="pptx-import-phase" class:is-active={Boolean(event) && !isPhaseDone(p.id)} class:is-done={isPhaseDone(p.id)}>
            <div class="pptx-import-phase-label">
              <span>{p.label}</span>
              {#if event && Number.isFinite(event.total)}
                <span class="pptx-import-phase-count">{event.current ?? 0} / {event.total}</span>
              {/if}
            </div>
            <div class="pptx-import-bar" class:is-indeterminate={Boolean(event) && frac === null}>
              <div class="pptx-import-bar-fill" style={frac === null ? "" : `width: ${frac * 100}%`}></div>
            </div>
          </div>
        {/each}
      </div>

      <div class="pptx-import-log" role="log" aria-live="polite">
        {#each log as entry, i (i)}
          <div class="pptx-import-log-row">
            <span class="pptx-import-log-phase">{entry.phase}</span>
            <span class="pptx-import-log-detail">{entry.detail}</span>
          </div>
        {/each}
      </div>

      {#if importError}
        <div class="name-modal-warning">Import failed: {importError}</div>
        <div class="name-modal-note">Nothing was changed — the previously open project (if any) is untouched.</div>
      {/if}

      {#if finalResult?.translateReport}
        {@const r = finalResult.translateReport}
        <div class="pptx-import-report">
          <h4 class="pptx-import-report-heading">Translation report</h4>
          {#if r.fontSubstitutions?.length}
            <div class="pptx-import-report-section">
              <div class="pptx-import-report-title">Font substitutions</div>
              <ul class="pptx-import-report-list">
                {#each r.fontSubstitutions as sub, i (i)}
                  <li>{typeof sub === "string" ? sub : `${sub.from} → ${sub.to}${sub.reason ? ` (${sub.reason})` : ""}`}</li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if r.warnings?.length}
            <div class="pptx-import-report-section">
              <div class="pptx-import-report-title">Warnings</div>
              <ul class="pptx-import-report-list is-warning">
                {#each r.warnings as w, i (i)}
                  <li>{typeof w === "string" ? w : (w.sentence ?? JSON.stringify(w))}</li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if r.refusals?.length}
            <div class="pptx-import-report-section">
              <div class="pptx-import-report-title">Not translated</div>
              <ul class="pptx-import-report-list is-warning">
                {#each r.refusals as ref, i (i)}
                  <li>{typeof ref === "string" ? ref : (ref.sentence ?? `${ref.where ?? ""}: ${ref.what ?? ""}`)}</li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if !r.fontSubstitutions?.length && !r.warnings?.length && !r.refusals?.length}
            <p class="name-modal-note">No substitutions, warnings, or refusals — everything translated cleanly.</p>
          {/if}
        </div>
      {/if}

      <div class="name-modal-actions">
        <button type="button" class="btn" disabled={!finalResult && !importError} onclick={() => (open = false)}>
          {finalResult ? "Done" : "Close"}
        </button>
      </div>
    </div>
  {/if}
</Modal>
