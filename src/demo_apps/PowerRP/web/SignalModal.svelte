<!--
  SignalModal — THE MIDI EDITOR, WHICH IS ryohey's `signal` AND NOT OURS.

  User, 2026-08-08: the MIDI widgets should "bring up full fledged UI's in giant
  modals when duoble clicked … a fullscreen midi piano roll editor ported over".
  And, standing, stated three times: "the piano roll open source thing should NOT
  be vibecoded" / "Hopefully your agent is LITERALLY USING the midi code I gave?
  Not just trying to reimplement it" / "Again, USE IT dont imitate it".

  So this component draws NO piano roll. It holds ONE same-origin <iframe> at the
  vendored web/public/signal/edit.html — https://github.com/ryohey/signal, MIT,
  pinned in PROVENANCE.txt — and does two things beside it: it IMPORTS the song
  into the document, and it MONITORS the transport into the live engine. Everything
  visible inside the frame is signal's: the WebGL roll, the arrange view, the tempo
  graph, the automation lanes, the transport, the shortcuts.

  A hand-rolled lookalike stood here until this landed. It is deleted, not kept
  beside this one. If something is missing, the answer is in signal's embed patch,
  never in a new canvas here.

  ── SAME-ORIGIN IS FORCED, NOT PREFERRED ───────────────────────────────────
  signal's patch posts with `postMessage(message, window.location.origin)` — it
  targets ITS OWN origin — and this side pins `event.source !== frame.contentWindow`
  (web/signalBridge.js). A cross-origin copy therefore receives nothing and delivers
  nothing, in both directions. The URL is `import.meta.env.BASE_URL + "signal/…"`,
  which is Vite's `public/` guarantee: the identical path in `npm run dev` and in
  the built bundle. Never `/@fs/` — Vite TRANSFORMS HTML it serves, so that would
  frame a rewritten page rather than the artifact that was tested.

  ── THE TWO PIPES ──────────────────────────────────────────────────────────
  IMPORT is PROPERTY STATE: signal's localStorage autosave → core/signal_song.js →
  the `clip` and `ctrl` list leaves, in one undo unit. That is what renders and what
  exports.
  MONITORING is EPHEMERAL and reaches nothing but the audio engine
  (web/signalBridge.js states the fence).

  ── WHY THE IMPORT IS A BUTTON AND NOT AUTOMATIC ───────────────────────────
  signal autosaves on a 10-SECOND INTERVAL, only while its song is dirty, and
  DELETES the entry on New/Open/Import/Export MIDI (core/signal_song.js documents
  all three, measured). An import that fired on its own would therefore sometimes
  write a song ten seconds behind what is on screen — a silent, permanent, wrong
  write into the document. So the author asks, and the button SAYS how old the
  snapshot it would write is. A stale import is still possible; an unannounced one
  is not.

  Styling: app.css `.sig-*` + `--a-sig-*` tokens (the annotator convention: web app
  components carry no <style> block).
-->
<script>
  import { onMount } from "svelte";
  import Modal from "../../../lib/Modal.svelte";
  // NEVER a native `title=`: tests/native_tooltip_ban_test.js bans them in app
  // chrome (OS delay, unthemed). SvelteLib's Tooltip is immediate and anchors on
  // keyboard focus.
  import Tooltip from "../../../lib/Tooltip.svelte";
  import {
    importSummary, SIGNAL_AUTOSAVE_INTERVAL_MS, SIGNAL_AUTOSAVE_KEY, songFromAutosave,
  } from "../core/signal_song.js";
  import { attachSignalBridge, signalMonitorNote } from "./signalBridge.js";
  import { moduleControlFor } from "./audioMirror.svelte.js";

  let {
    /** @type {object} The app store — read for the target, written through its
     *  import seam. */
    app,
  } = $props();

  /** Modal `open` is bindable but we never set it false ourselves: dismissal
   *  always routes through `done()`, so there is exactly one close path. */
  let open = $state(true);
  let frame = $state(null);
  let footer = $state("");
  let monitor = $state(null);

  /** THE LATEST SNAPSHOT WE HAVE EVER SEEN, held in memory rather than re-read at
   *  import time. That is defence against a measured behaviour, not caution:
   *  signal's `onUserExplicitAction` DELETES the autosave on New/Open/Import and on
   *  EXPORT MIDI, so an author who exports their song would otherwise also lose the
   *  ability to import it. Keeping the last snapshot means an export costs nothing.
   *  @type {{raw: string, seenAt: number}|null} */
  let snapshot = $state(null);

  /** The vendored editor's URL. `BASE_URL` because a Pages deploy serves the app
   *  from a subpath and a root-absolute "/signal/…" would 404 there — the same
   *  reason registerServiceWorker.js reads it. */
  const SIGNAL_URL = `${import.meta.env.BASE_URL || "/"}signal/edit.html`;

  /** A clock that ticks only while this dialog is open, so the button's "…s ago"
   *  is honest without anything else re-rendering. Declared BEFORE the derived
   *  that reads it: `$derived` is lazy, so the reversed order happened to work, but
   *  a reader should not have to know that to believe the file. */
  let now = $state(Date.now());

  /** How stale the held snapshot is, in seconds, or null when there is none. */
  const staleSeconds = $derived(snapshot ? Math.max(0, Math.round((now - snapshot.seenAt) / 1000)) : null);

  /** Command. Reads signal's autosave and keeps it if it is NEW. Compared by RAW
   *  STRING rather than by timestamp: the timestamp is signal's own `Date.now()`
   *  and a clock change could make it go backwards, where a byte-difference is
   *  exactly the question "is this a different song than the one I hold". */
  function pollAutosave() {
    now = Date.now();
    let raw = null;
    try { raw = window.localStorage.getItem(SIGNAL_AUTOSAVE_KEY); } catch { return; }
    if (typeof raw !== "string" || raw === "") return; // deleted (see `snapshot`) — keep what we have
    if (snapshot?.raw === raw) return;
    snapshot = { raw, seenAt: Date.now() };
  }

  /**
   * Command. THE IMPORT. Converts the held snapshot and writes it as ONE undo unit.
   *
   * The footer always says what happened — including, and especially, when nothing
   * was imported. A conversion that refuses must produce a sentence, never a
   * silently unchanged clip (the ABC parser's rule: half a song looks like it
   * worked, and so does none of it).
   */
  function importSong() {
    pollAutosave();
    const song = songFromAutosave(snapshot?.raw ?? null);
    if (!song.ok) { footer = importSummary(song); return; }
    const written = app.commitSignalImport(song);
    footer = `${importSummary(song)}${written.controls === 0 && song.controls.length > 0 ? " (automation could not be stored on this widget — see the console.)" : ""}`;
  }

  /** Command. Close. Any uncommitted preview is dropped by the app. */
  function done() {
    app.closeSignalEditor();
  }

  onMount(() => {
    const timer = setInterval(pollAutosave, POLL_MS);
    pollAutosave();

    // THE MONITORING BRIDGE. Attached here rather than inside the bridge module so
    // that its lifetime is exactly this dialog's: the returned detach panics every
    // routed instrument, so closing mid-playback cannot leave a note sounding.
    const detach = attachSignalBridge({
      frame: { get contentWindow() { return frame?.contentWindow ?? null; } },
      items: () => app.state()?.items ?? {},
      registry: app.registry,
      itemId: app.signalEditor?.itemId,
      // INJECTED, not imported by the bridge — see its header: importing this would
      // put a module-level `$state` rune in the bridge's import graph and make it
      // unloadable in bare node, which is where its logic is tested.
      controlFor: moduleControlFor,
      onStatus: (s) => { monitor = signalMonitorNote(s); },
    });

    // Headless test/dev seam, mirroring web/CodeEditorModal.svelte's
    // `window.__powerrp_codeModal`: a probe drives the REAL import — the conversion,
    // the write, the footer — without needing signal's UI to have finished booting
    // or a 10-second autosave to have elapsed. Cleared on unmount.
    window.__powerrp_signal = {
      url: () => SIGNAL_URL,
      frameSrc: () => frame?.getAttribute("src") ?? null,
      /** The snapshot the dialog would import, and how it reads it. A probe writes
       *  `localStorage` itself and asserts this picks it up — which is the whole
       *  authoring seam, minus signal's own ten-second wait. */
      poll: () => { pollAutosave(); return snapshot ? { seenAt: snapshot.seenAt, bytes: snapshot.raw.length } : null; },
      importSong,
      footer: () => footer,
      monitorNote: () => monitor,
      close: done,
    };
    return () => {
      clearInterval(timer);
      detach();
      if (window.__powerrp_signal) delete window.__powerrp_signal;
    };
  });

  /** How often the parent looks for a new snapshot. Well under signal's own 10 s
   *  write interval, so the age the button reports is never rounded up by our own
   *  laziness; a `localStorage.getItem` of a few hundred KB once a second is not a
   *  cost worth optimizing against a 2.35 MB editor running beside it. */
  const POLL_MS = 1000;
</script>

<Modal bind:open size="large" title="signal" titleIcon="mdi:piano" onclose={done}>
  <div class="sig-root">
    <div class="sig-toolbar">
      <Tooltip text={snapshot
        ? `Writes signal's song into this widget's clip, as one undo unit. signal saves its song every ${SIGNAL_AUTOSAVE_INTERVAL_MS / 1000} seconds while you edit, so this imports what it last saved — ${staleSeconds} second${staleSeconds === 1 ? "" : "s"} ago.`
        : `Nothing to import yet. signal writes its song every ${SIGNAL_AUTOSAVE_INTERVAL_MS / 1000} seconds while it has unsaved changes, so draw a note and wait a moment.`}>
        <button class="sig-import" onclick={importSong} disabled={!snapshot}>
          Import to clip{snapshot ? ` (saved ${staleSeconds}s ago)` : ""}
        </button>
      </Tooltip>
      {#if footer}<span class="sig-footer" role="status">{footer}</span>{/if}
      {#if monitor}<span class="sig-warn" role="status">{monitor}</span>{/if}
    </div>
    <!-- ONE IFRAME, AND NOTHING ELSE. Everything a MIDI editor does happens in
         here and belongs to ryohey/signal. `allow` is deliberately narrow: signal
         builds an AudioContext unconditionally (unused and suspended when embedded,
         because the parent owns the audio), and needs nothing else. -->
    <!-- `aria-label` and NOT `title`, though `title` is the attribute an iframe
         conventionally carries: browsers render a `title` as a hover tooltip, which
         is what tests/native_tooltip_ban_test.js bans in app chrome (OS delay,
         unthemed) and it caught this file. `aria-label` gives the frame the same
         accessible name to a screen reader and paints nothing.

         TWO GATES DISAGREE HERE AND THIS IS THE RESOLUTION. Svelte's a11y check
         asks specifically for `title` on an iframe and does not accept `aria-label`
         as satisfying it, so it warns; the project's ban forbids `title`. The
         ACCESSIBILITY REQUIREMENT — that the frame have an accessible name — is
         met either way, so the tie goes to the rule that changes what a user sees.
         Suppressed narrowly, on this one element, with the reason attached. -->
    <!-- svelte-ignore a11y_missing_attribute -->
    <iframe
      bind:this={frame}
      class="sig-frame"
      src={SIGNAL_URL}
      aria-label="signal — MIDI sequencer"
    ></iframe>
  </div>
</Modal>
