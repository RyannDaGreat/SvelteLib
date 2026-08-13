<!--
  SurgeGuiModal — Surge XT's REAL interface, in a PowerRP dialog.

  Three regions, top to bottom, mirroring the WebSurge site the user set as the
  quality bar:

    THE CANVAS   Surge's own pixels — the C++ SurgeGUIEditor painting through the
                 wasm ComponentPeer, with Surge's embedded fonts and its own SVG
                 skin re-rasterised at the display's density. Nothing here draws
                 a single control; every knob, menu and readout is Surge's.
    THE BAR      the preset selector (both banks, 3,559 patches), zoom, HiDPI,
                 and the one line where a failure gets to speak.
    THE PIANO    128 keys. NOT part of the wasm canvas — plain divs, positioned
                 from `keyLayout()`, because the pixels above have no keyboard in
                 them and because a note has to leave this dialog as an EVENT,
                 not as a click Surge swallows.

  IT IS PROP-DRIVEN AND OWNS NO AUDIO. `onparam`, `onpatch` and `onnote` are
  forwarded straight up; the caller connects them to the engine. This component
  never constructs an AudioContext and never posts to an AudioWorkletNode — which
  is also why the piano reports notes instead of playing them.

  Props:
    onclose  called on Escape / backdrop / the header ×. The caller unmounts us,
             which is what destroys the session (see the lifecycle note below).
    onparam  (index, value) — ONE parameter Surge's GUI moved, from the per-frame
             diff. The first frame reports all 766, which is the baseline a
             freshly connected engine needs.
    onpatch  ({path, name, bytes?, readBytes}) — a patch was loaded. `bytes` is an
             ArrayBuffer ONLY for an on-demand remote patch; an archive patch is
             already in the audio half's filesystem. `readBytes()` is always there
             and returns the file's bytes for EITHER kind — that is the one to
             call to persist a patch into the document.
    onnote   ({type: "on"|"off", note, velocity}) — the piano. `velocity` is 100
             for a mouse press and 0 on release.
    title    the dialog header text.

  LIFECYCLE. The wasm module is a page-lifetime singleton owned by
  web/surgeGui.js (49 MB and several seconds to build, and Surge's editor is a C++
  singleton anyway). This component owns a SESSION — one canvas, one frame loop,
  one set of listeners — and `onMount`'s cleanup destroys it. So closing and
  reopening the dialog is fast and the patch the author left loaded is still
  loaded, while nothing keeps listening once the dialog is gone.

  THE BOOT IS A FIRST-CLASS SCREEN, NOT A SPINNER. 49 MB arrives from a foreign
  origin on first use; the overlay names the phase and the megabytes, says when
  the bytes came from the cache instead, and — if it fails — renders THE SENTENCE
  in the dialog. That is the project's no-silent-failure law applied to the one
  place it matters most here: a Surge that mounted nothing still draws a complete,
  responsive, entirely dead interface, so "looks fine" is not evidence.

  Styling: app.css `.surge-*` + `--a-surge-*` tokens (the annotator convention —
  web app components carry no <style> block). The canvas draws its own skin.
-->
<script>
  import { onMount } from "svelte";
  import Modal from "../../../lib/Modal.svelte";
  import GatedIconButton from "./GatedIconButton.svelte";
  import {
    createSurgeGuiSession,
    keyLayout,
    noteName,
    filterPatches,
    MOUSE_VELOCITY,
    SURGE_REMOTE_ORIGIN,
  } from "./surgeGui.js";

  let {
    /** @type {(() => void)|undefined} Dismissal — Escape, backdrop, or the ×. */
    onclose = undefined,
    /** @type {((index: number, value: number) => void)|undefined} */
    onparam = undefined,
    /** @type {((p: {path: string, name: string, bytes?: ArrayBuffer}) => void)|undefined} */
    onpatch = undefined,
    /** @type {((n: {type: "on"|"off", note: number, velocity: number}) => void)|undefined} */
    onnote = undefined,
    /** @type {string} Dialog header text. */
    title = "Surge XT",
  } = $props();

  /**
   * How many patch options are rendered at once.
   *
   * The index is 3,559 entries and the filter is right there, so a cap costs the
   * reader nothing and keeps every keystroke's re-render cheap. It is announced
   * in the option list rather than silently truncating — a selector that quietly
   * hides two thousand patches is lying about what the library contains.
   */
  const OPTION_CAP = 400;

  /** Zoom steps the picker offers. 1 is Surge's native 913×569. */
  const ZOOM_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.25, 1.5, 2];

  // The Modal's `open` is bindable but we never set it false: dismissal always
  // routes through onclose (the caller unmounts us), so there is one close path.
  let open = $state(true);

  let canvasEl = $state(null);
  let stageEl = $state(null);
  let pianoEl = $state(null);

  /** The live session, or null while booting / after a failure. Not $state's
   *  concern beyond "is it there", so the handle itself is plain. */
  let session = $state(null);

  /** Boot progress, straight from surgeGui's onProgress. */
  let phase = $state("glue");
  let loaded = $state(0);
  let total = $state(0);
  let fromCache = $state(false);
  /** The name of the on-demand patch currently downloading, if any. */
  let fetchingPatch = $state("");
  /** Every progress report, in order. Kept because the ONE thing about this
   *  feature that cannot be seen in a finished frame is where the 49 MB came
   *  from — the cache or the network — and `fromCache` above only ever holds the
   *  latest report. The probe reads this to prove the cache is really used. */
  let progressLog = $state([]);

  /** THE SENTENCE. Non-null means something failed and the dialog says so. */
  let failure = $state(null);

  /** Patch selection state. */
  let bank = $state("");
  let query = $state("");
  let selectedPath = $state("");
  let loadingPatch = $state(false);

  /** View controls. */
  let zoom = $state(1);
  let retina = $state(true);

  /** Notes currently held, as an array so Svelte 5 sees the reassignment. 128
   *  keys × an `includes` is nothing; a reactive Set would be more machinery for
   *  the same answer. */
  let heldNotes = $state([]);

  /** Surge's own counts, once it has reported them. */
  let patchCount = $state(0);
  let wavetableCount = $state(0);
  let paramCount = $state(0);

  /** The full index; a plain array (never mutated, only read). */
  let patches = $state([]);

  const layout = keyLayout();

  /**
   * Pure function. Megabytes, to one decimal, for the progress line.
   *
   * @param {number} bytes
   * @returns {string}
   *
   * @example mb(19772078) // "18.9"
   */
  function mb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  /** Query. The sentence under the progress bar for the current phase. */
  const bootLine = $derived.by(() => {
    const where = fromCache ? "from cache" : `from ${SURGE_REMOTE_ORIGIN}`;
    switch (phase) {
      case "glue":
        return "Loading Surge's WebAssembly glue…";
      case "joining":
        return "Surge is already loading for another view — waiting for it…";
      case "wasm":
        return total
          ? `Surge's editor — ${mb(loaded)} / ${mb(total)} MB ${where}`
          : `Surge's editor — ${mb(loaded)} MB ${where}`;
      case "archive":
        return total
          ? `Factory patches and wavetables — ${mb(loaded)} / ${mb(total)} MB ${where}`
          : `Factory patches and wavetables — ${mb(loaded)} MB ${where}`;
      case "mount":
        return `Mounting ${total} files into Surge's filesystem — ${loaded} done`;
      case "init":
        return "Starting Surge's editor…";
      case "attach":
        return "Sizing the canvas…";
      default:
        return "Ready.";
    }
  });

  /** Query. 0..1 for the bar, or null for an indeterminate phase. */
  const bootFraction = $derived(total > 0 ? Math.max(0, Math.min(1, loaded / total)) : null);

  /** Query. The patches the bank picker and the search box select. */
  const matches = $derived(filterPatches(patches, bank, query));

  /** Query. What actually goes into the <select>, grouped by category.
   *
   *  Grouped here rather than in the markup so the CAP is applied to the whole
   *  result before grouping — capping per group would silently drop the tail of
   *  every category instead of the tail of the list. */
  const optionGroups = $derived.by(() => {
    const groups = [];
    let current = null;
    for (const p of matches.slice(0, OPTION_CAP)) {
      const label = `${p.bank} · ${p.category}`;
      if (!current || current.label !== label) {
        current = { label, items: [] };
        groups.push(current);
      }
      current.items.push(p);
    }
    return groups;
  });

  /** Query. How many matches the cap is hiding. */
  const hiddenCount = $derived(Math.max(0, matches.length - OPTION_CAP));

  /**
   * Command. Records a progress report from the session.
   *
   * @param {{phase: string, loaded?: number, total?: number, cached?: boolean, name?: string}} p
   */
  function handleProgress(p) {
    if (p.phase === "patch") {
      fetchingPatch = p.name ?? "";
      return;
    }
    phase = p.phase;
    loaded = p.loaded ?? 0;
    total = p.total ?? 0;
    fromCache = !!p.cached;
    // One entry PER PHASE, not per chunk: a 30 MB download reports thousands of
    // times and the only thing worth keeping is that the phase happened and where
    // its bytes came from.
    const last = progressLog[progressLog.length - 1];
    if (!last || last.phase !== p.phase) progressLog = [...progressLog, { phase: p.phase, cached: !!p.cached }];
    else if (p.cached) last.cached = true;
  }

  /**
   * Command. Records a note the session decided on and forwards it up.
   *
   * The session owns the held set (so a glissando releases the previous note and
   * a window that loses focus releases everything, in one place); this mirrors it
   * for the key highlighting and passes it to the caller. One path, no second
   * opinion about what is sounding.
   *
   * @param {{type: "on"|"off", note: number, velocity: number}} n
   */
  function handleNote(n) {
    heldNotes = n.type === "on" ? [...heldNotes, n.note] : heldNotes.filter((x) => x !== n.note);
    onnote?.(n);
  }

  /**
   * Command. Turns any failure into THE SENTENCE in the dialog.
   *
   * Also logged: the dialog gets the sentence, the console gets the stack, and
   * neither is a substitute for the other.
   *
   * @param {unknown} err
   * @param {string} what What was being attempted, for the console line.
   */
  function fail(err, what) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`SurgeGuiModal: ${what}`, err);
    failure = message;
  }

  /** The live session handle, outside `$state` because nothing renders it — only
   *  `session` above answers "is it up", and this is what `teardown` acts on. */
  let liveSession = null;
  /** One-way latch: once torn down, a late-resolving boot must not attach. */
  let disposed = false;

  /**
   * Command. Destroys the session, once.
   *
   * Called from BOTH the unmount cleanup and the close handler, because those are
   * genuinely different events: the caller unmounts us when it clears its state,
   * but the shared Modal's own dismissal (Escape, backdrop, ×) removes the
   * dialog's DOM while this component is still mounted. Without the second call a
   * dismissed dialog would leave a rAF loop painting into a detached canvas —
   * and, because surgeGui refuses a second attachment to its singleton editor,
   * the dialog could never be opened again.
   */
  function teardown() {
    disposed = true;
    liveSession?.destroy();
    liveSession = null;
    session = null;
  }

  onMount(() => {
    createSurgeGuiSession({
      canvas: canvasEl,
      onParam: (index, value) => onparam?.(index, value),
      onPatch: (p) => onpatch?.(p),
      onProgress: handleProgress,
      onNote: handleNote,
      onError: (err) => fail(err, "the running session reported a failure"),
    })
      .then((s) => {
        // The dialog can be closed DURING a 49 MB boot. Without this the session
        // would attach to a canvas that is no longer in the document and keep a
        // rAF loop running against it forever — and, because the module refuses a
        // second attachment, the dialog would never open again.
        if (disposed) {
          s.destroy();
          return;
        }
        liveSession = s;
        session = s;
        patches = s.patchIndex;
        patchCount = s.patchCount;
        wavetableCount = s.wavetableCount;
        paramCount = s.paramCount;
        retina = s.view().retina;
        phase = "ready";
        // FIT ON OPEN. Surge is 913×569 and this dialog is 90vw × 90vh, so a
        // native-size canvas sits in a large field of nothing on any modern
        // display. Fitting is done ONCE, here, rather than on every resize:
        // re-fitting as the window changes would move every control out from
        // under the author's cursor mid-drag, which is worse than an imperfect
        // fit. `zoom` is read back from the session afterwards so the picker
        // shows what was actually applied.
        fitZoom();
        zoom = s.view().zoom;
      })
      .catch((err) => fail(err, "the session could not be created"));

    // Headless test seam, mirroring web/CodeEditorModal.svelte's
    // `window.__powerrp_codeModal`: a probe drives the REAL component rather than
    // simulating gestures at pixels it has to guess. Cleared on unmount.
    window.__powerrp_surgeModal = {
      phase: () => phase,
      progressLog: () => progressLog.map((p) => ({ ...p })),
      zoom: () => zoom,
      failure: () => failure,
      ready: () => session !== null,
      counts: () => ({ patchCount, wavetableCount, paramCount, indexSize: patches.length }),
      matches: () => matches.length,
      setQuery: (q) => {
        query = q;
      },
      setBank: (b) => {
        bank = b;
      },
      held: () => [...heldNotes],
      pressNote: (note) => session?.noteOn(note, MOUSE_VELOCITY),
      releaseNote: (note) => session?.noteOff(note),
      loadPatchAt: (i) => choose(matches[i]),
      session: () => session,
    };

    return () => {
      teardown();
      if (window.__powerrp_surgeModal) delete window.__powerrp_surgeModal;
    };
  });

  /** Command. The dialog was dismissed — tear the session down, then tell the
   *  caller (which will normally unmount us, where `teardown` is a no-op). */
  function handleClose() {
    teardown();
    onclose?.();
  }

  /**
   * Command. Loads a patch entry, reporting any failure in the footer.
   *
   * @param {object|undefined} entry An element of the filtered list.
   */
  async function choose(entry) {
    if (!entry || !session) return;
    selectedPath = entry.path;
    loadingPatch = true;
    failure = null;
    try {
      await session.loadPatch(entry);
    } catch (err) {
      fail(err, `loading the patch "${entry.name}"`);
    } finally {
      loadingPatch = false;
      fetchingPatch = "";
    }
  }

  /** Query. Are the jog arrows gated shut? Two independent causes, which is why
   *  `jogReason` below is a function of state rather than one fixed string. */
  let jogBlocked = $derived(!session || matches.length === 0);

  /** Query. WHICH condition is shutting the arrows, as a `requires` clause. A
   *  fixed sentence would be a confident wrong answer for one of the two cases —
   *  the same argument core/commands.js makes for a functional `requires`. */
  let jogReason = $derived(!session ? "the Surge editor to finish loading" : "at least one patch matching the current filter");

  /** Command. Steps through the CURRENTLY FILTERED list — the jog buttons act on
   *  what the author can see, not on the 3,559-entry index behind it. */
  function jog(delta) {
    if (matches.length === 0) return;
    const at = matches.findIndex((p) => p.path === selectedPath);
    const next = at === -1 ? (delta > 0 ? 0 : matches.length - 1) : at + delta;
    choose(matches[(next + matches.length) % matches.length]);
  }

  /** Command. Applies a zoom step. */
  function applyZoom(z) {
    zoom = z;
    try {
      session?.setZoom(z);
    } catch (err) {
      fail(err, `setting zoom to ${z}`);
    }
  }

  /** Command. The largest ZOOM_STEP whose canvas still fits the stage. Picked
   *  from the steps rather than computed continuously so the readout stays a
   *  round number the author can find again. */
  function fitZoom() {
    if (!session || !stageEl) return;
    const { width, height } = session.size();
    if (!width || !height) return;
    // 24px of breathing room so "fit" does not mean "touching both scrollbars".
    const fitW = (stageEl.clientWidth - 24) / width;
    const fitH = (stageEl.clientHeight - 24) / height;
    const room = Math.min(fitW, fitH);
    const best = [...ZOOM_STEPS].reverse().find((z) => z <= room) ?? ZOOM_STEPS[0];
    applyZoom(best);
  }

  /** Command. Toggles HiDPI rasterisation. */
  function applyRetina(on) {
    retina = on;
    try {
      session?.setRetina(on);
    } catch (err) {
      fail(err, `turning HiDPI ${on ? "on" : "off"}`);
    }
  }

  // ── THE PIANO'S GESTURE ───────────────────────────────────────────────────
  // Hit-tested with elementFromPoint reading `data-note`, rather than per-key
  // handlers, because that is what makes a DRAG glissando work: the pointer is
  // captured by the container on pointerdown, so every subsequent move is
  // delivered here no matter which key it is actually over, and the element under
  // the cursor is the only thing that still knows the answer.

  /** Query. The MIDI note under a pointer event, or null. */
  function noteAt(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const raw = el?.dataset?.note;
    return raw === undefined ? null : Number(raw);
  }

  function pianoDown(e) {
    if (!session) return;
    pianoEl?.setPointerCapture?.(e.pointerId);
    const note = noteAt(e);
    if (note !== null) session.noteOn(note, MOUSE_VELOCITY);
    e.preventDefault();
  }

  function pianoMove(e) {
    // Glissando only while a button is held; a bare hover must not sound.
    if (!session || !e.buttons || heldNotes.length === 0) return;
    const note = noteAt(e);
    if (note === null || heldNotes.includes(note)) return;
    // Release the previous note BEFORE pressing the next, so a drag across the
    // keyboard is monophonic the way a real finger is.
    session.allNotesOff();
    session.noteOn(note, MOUSE_VELOCITY);
  }

  function pianoUp(e) {
    session?.allNotesOff();
    pianoEl?.releasePointerCapture?.(e.pointerId);
  }
</script>

<Modal bind:open size="large" {title} titleIcon="mdi:piano" onclose={handleClose}>
  <div class="surge-root">
    <!-- THE STAGE. Scrolls in both axes, because Surge's canvas at 200% is
         larger than any dialog and cropping an interface is worse than
         scrolling one. -->
    <div class="surge-stage" bind:this={stageEl}>
      <!-- `tabindex` so the canvas can take focus and therefore keystrokes;
           `touch-action: none` (in app.css) so a drag on a knob is a drag on a
           knob and not a page scroll. Hidden from the layout entirely until the
           session is up, so the boot screen is not framed by a black rectangle. -->
      <canvas
        class="surge-canvas"
        class:surge-canvas-live={session !== null}
        bind:this={canvasEl}
        tabindex="0"
        aria-label="Surge XT interface"
      ></canvas>

      {#if !session}
        <div class="surge-boot" role="status">
          {#if failure}
            <!-- THE SENTENCE. In the dialog the author is looking at, not only in
                 a console they have no reason to open. -->
            <p class="surge-boot-title surge-boot-failed">Surge could not start</p>
            <p class="surge-failure" role="alert">{failure}</p>
          {:else}
            <p class="surge-boot-title">Loading Surge XT</p>
            <div class="surge-progress" class:surge-progress-indeterminate={bootFraction === null}>
              <div class="surge-progress-fill" style="width: {(bootFraction ?? 1) * 100}%"></div>
            </div>
            <p class="surge-boot-line">{bootLine}</p>
            <p class="surge-boot-note">
              Surge XT's 19 MB editor and 30 MB factory library stream from
              {SURGE_REMOTE_ORIGIN} the first time this dialog is opened, then live in a
              local cache.
            </p>
          {/if}
        </div>
      {/if}
    </div>

    <!-- THE BAR: presets on the left, view controls on the right. -->
    <div class="surge-bar">
      <span class="surge-bar-group">
        <!-- THE JOG ARROWS. web/GatedIconButton — `aria-disabled` + a guarded
             handler + an iconify glyph, replacing native `disabled` on a literal
             `‹`/`›`. Both halves mattered here: the native attribute made the pair
             unfocusable, and they carried NO tooltip, so two inert chevrons
             explained themselves in no modality at all. The glyphs were also
             typographic QUOTATION MARKS standing in for arrows — they inherited
             the text font instead of the icon set, so they matched no other arrow
             in the app.

             THE REASON NAMES WHICH CONDITION IS SHUT, because there are two and a
             fixed string would be a confident wrong answer for one of them (the
             `requires`-may-be-a-function argument in core/commands.js, applied to
             a non-registry control). -->
        <GatedIconButton
          icon="mdi:chevron-left"
          label="Previous patch"
          buttonClass="surge-btn"
          disabled={jogBlocked}
          disabledReason={jogReason}
          onclick={() => jog(-1)}
        />
        <GatedIconButton
          icon="mdi:chevron-right"
          label="Next patch"
          buttonClass="surge-btn"
          disabled={jogBlocked}
          disabledReason={jogReason}
          onclick={() => jog(1)}
        />
        <select
          class="surge-select surge-select-bank"
          aria-label="Patch bank"
          bind:value={bank}
          disabled={!session}
        >
          <option value="">All banks</option>
          <option value="Factory">Factory</option>
          <option value="3rd Party">3rd Party</option>
        </select>
        <input
          class="surge-search"
          type="search"
          placeholder="Filter patches…"
          aria-label="Filter patches"
          bind:value={query}
          disabled={!session}
        />
        <select
          class="surge-select surge-select-patch"
          aria-label="Patch"
          value={selectedPath}
          disabled={!session || matches.length === 0}
          onchange={(e) => choose(matches.find((p) => p.path === e.currentTarget.value))}
        >
          <!-- A placeholder that is not a patch, so the field is never showing the
               name of something that was not loaded. -->
          <option value="" disabled>{matches.length} patches…</option>
          {#each optionGroups as group (group.label)}
            <optgroup label={group.label}>
              {#each group.items as p (p.path)}
                <option value={p.path}>{p.name}{p.remote ? " ↓" : ""}</option>
              {/each}
            </optgroup>
          {/each}
          {#if hiddenCount > 0}
            <option value="" disabled>… {hiddenCount} more — narrow the filter</option>
          {/if}
        </select>
      </span>

      <span class="surge-bar-group surge-bar-right">
        {#if failure && session}
          <span class="surge-failure" role="alert">{failure}</span>
        {:else if fetchingPatch}
          <span class="surge-status">Downloading “{fetchingPatch}”…</span>
        {:else if loadingPatch}
          <span class="surge-status">Loading…</span>
        {:else if session}
          <span class="surge-status">
            {patchCount} patches · {wavetableCount} wavetables · {paramCount} parameters
          </span>
        {/if}
        <label class="surge-toggle">
          <input
            type="checkbox"
            checked={retina}
            disabled={!session}
            onchange={(e) => applyRetina(e.currentTarget.checked)}
          />
          HiDPI
        </label>
        <select
          class="surge-select surge-select-zoom"
          aria-label="Zoom"
          value={zoom}
          disabled={!session}
          onchange={(e) => applyZoom(Number(e.currentTarget.value))}
        >
          {#each ZOOM_STEPS as z (z)}
            <option value={z}>{Math.round(z * 100)}%</option>
          {/each}
        </select>
        <!-- FIT carries the same contract as the jog arrows: it is a BUTTON, so a
             native `disabled` would take it out of the tab order along with the
             only sentence saying why it is dead. It keeps its TEXT label (it is a
             word, not a glyph — there is no icon that reads as "fit to window"),
             so it is written out here rather than through GatedIconButton, which
             exists for the icon case. -->
        <button
          type="button"
          class="surge-btn"
          aria-disabled={!session}
          title={session ? "Fit the editor to the window" : "Fit the editor to the window — unavailable until the Surge editor finishes loading"}
          onclick={() => { if (session) fitZoom(); }}
        >Fit</button>
      </span>
    </div>

    <!-- THE PIANO. Handlers live on the CONTAINER (see the gesture note in the
         script) — the keys themselves are presentational, which is why they are
         divs and why the interaction is announced on the group. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="surge-piano"
      class:surge-piano-idle={!session}
      bind:this={pianoEl}
      role="group"
      aria-label="Piano keyboard, MIDI notes 0 to 127"
      onpointerdown={pianoDown}
      onpointermove={pianoMove}
      onpointerup={pianoUp}
      onpointercancel={pianoUp}
    >
      <!-- White keys first so the black ones paint over them. -->
      {#each layout.white as k (k.note)}
        <div
          class="surge-key surge-key-white"
          class:surge-key-held={heldNotes.includes(k.note)}
          style="left: {k.x * 100}%; width: {k.w * 100}%"
          data-note={k.note}
          data-label={k.note % 12 === 0 ? noteName(k.note) : undefined}
        ></div>
      {/each}
      {#each layout.black as k (k.note)}
        <div
          class="surge-key surge-key-black"
          class:surge-key-held={heldNotes.includes(k.note)}
          style="left: {k.x * 100}%; width: {k.w * 100}%"
          data-note={k.note}
        ></div>
      {/each}
    </div>
  </div>
</Modal>
