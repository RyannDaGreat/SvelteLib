<!--
  PianoRollModal — THE fullscreen (90vw × 90vh) MIDI clip editor.

  User, 2026-08-08: the MIDI widgets should "bring up full fledged UI's in giant
  modals when duoble clicked … a fullscreen midi piano roll editor ported over".

  ── WHAT THIS COMPONENT OWNS, AND WHAT IT DELIBERATELY DOES NOT ──────────────
  It owns the DOM and the GESTURES. It owns no arithmetic: every beat↔pixel and
  pitch↔row mapping, and the hit test that decides whether a press moves a note or
  resizes it, is `core/piano_roll.js`, and every edit to the clip is
  `core/midi_clip.js`. Both are DOM-free and pinned in bare node by
  tests/piano_roll_test.js and tests/midi_clip_test.js.

  That split is not tidiness. A piano roll is mostly coordinate arithmetic with a
  lot of off-by-one places to hide in, and arithmetic living in a `.svelte` file
  can only be tested by booting a browser — which is slow, flaky, and (measured on
  this host, per CLAUDE.md's preflight note) can fail for reasons that have nothing
  to do with the app. So the unit tests prove the mapping and the browser probe is
  free to ask only what a browser can answer: does the modal open, does a drag
  write the document, is it one undo unit.

  ── IT EDITS THE RAW LIST, BY RAW INDEX ─────────────────────────────────────
  `app.pianoRollClip()` returns the STORED list, equations included. Two
  consequences that are contracts rather than quirks:

    A NOTE WHOSE FIELD IS AN EQUATION IS NOT DRAWN AND NOT DRAGGABLE. It has no
    numeric position to draw at (`noteRecord` returns null), and inventing one
    would mean a drag silently overwriting the author's binding with a literal.
    The Inspector's Clip rows are where a bound note is edited. The footer SAYS
    how many notes are hidden this way, so it is never implied by omission.

    A HIDDEN NOTE (core/lists.js per-element visibility) is likewise absent here
    and counted in the footer. Hiding is the Inspector's affordance; this editor
    adds, moves, resizes and PURGES.

  Everything the editor draws therefore maps back to a RAW index, which is what
  every write addresses — `rows[i].index`, never the position in the drawn array.

  ── ONE GESTURE IS ONE UNDO UNIT ────────────────────────────────────────────
  A drag calls `app.previewPianoRollClip` on every pointermove (so the canvas
  behind the dialog updates live) and `app.commitPianoRollClip` once on release.
  That is the universal setPreview→commitPreview seam every other editor in this
  app uses, so a clip edited on slide 2 is keyframed on slide 2 with no code here.

  Styling: app.css `.pr-*` + `--a-pr-*` tokens (the annotator convention: web app
  components carry no <style> block).
-->
<script>
  import { onMount } from "svelte";
  import Modal from "../../../lib/Modal.svelte";
  // NEVER a native `title=` attribute: tests/native_tooltip_ban_test.js bans them in
  // app chrome (they appear after a long OS delay and are unthemed). SvelteLib's
  // Tooltip shows immediately, follows the app theme, and anchors on keyboard focus.
  import Tooltip from "../../../lib/Tooltip.svelte";
  import {
    DEFAULT_VELOCITY, MIN_DURATION_BEATS, SNAP_DIVISIONS, VELOCITY_MAX, VELOCITY_MIN,
    noteRecord, snapBeat, withNoteAdded, withNoteAt, withNoteRemoved,
  } from "../core/midi_clip.js";
  import {
    DEFAULT_VIEW, beatToX, isBlackPitch, noteHitAt, noteRect, pitchName, pitchToY,
    scrolledView, snapLabel, xToBeat, yToPitch, zoomedView,
  } from "../core/piano_roll.js";
  import { elementActive } from "../core/lists.js";

  let {
    /** @type {object} The app store — read for the clip, written through its
     *  preview/commit seam. */
    app,
  } = $props();

  /** Modal `open` is bindable but we never set it false ourselves: dismissal
   *  always routes through `done()`, so there is exactly one close path. */
  let open = $state(true);
  let gridEl = $state(null);
  let gridW = $state(0);
  let gridH = $state(0);

  /** THE VIEW — scroll and zoom, and nothing else (core/piano_roll.js). */
  let view = $state({ ...DEFAULT_VIEW });

  /** The grid division new notes snap to and are born the length of. A quarter
   *  note by default: the coarsest division that still lets an author place a
   *  melody, so the first thing a new user draws lands somewhere musical. */
  let snap = $state(0.25);

  /** The velocity a NEW note is born at, and — while a note is selected — the
   *  velocity that note carries. One control for both, because "how hard is this
   *  note" and "how hard is the next one" are the same question asked twice, and
   *  two sliders would be two answers to keep in step. */
  let velocity = $state(DEFAULT_VELOCITY);

  /** The RAW list index of the selected note, or null. Raw, never a drawn
   *  position — see the header. */
  let selected = $state(null);

  /** The live gesture, or null: `{kind, index, grabBeat, origin}`. Plain (not
   *  `$state`) where it is only read inside handlers, but it gates the cursor
   *  class, so it is reactive. */
  let drag = $state(null);

  /** The clip as stored. Re-read from the app on every render, so an undo, a
   *  slide change or an Inspector edit behind the dialog is reflected here. */
  const clip = $derived(app.pianoRoll ? app.pianoRollClip() : { list: [], active: undefined });

  /**
   * THE DRAWN NOTES, each carrying the RAW index it must be written back to.
   * Skips equation-bound and hidden elements (see the header) — `skipped` is what
   * the footer reports so their absence is stated rather than implied.
   */
  const rows = $derived(
    clip.list
      .map((tuple, index) => ({ index, note: noteRecord(tuple) }))
      .filter((r) => r.note !== null && elementActive(clip.active, r.index)),
  );
  const skipped = $derived(clip.list.length - rows.length);

  /** Every pitch with a row on screen, top to bottom — what the lanes and the key
   *  column are drawn from, so the two cannot disagree about which row is where. */
  const visiblePitches = $derived(
    Array.from({ length: Math.ceil(gridH / view.rowHeight) + 1 }, (_, i) => view.topPitch - i).filter((p) => p >= 0),
  );

  /** Every BEAT line on screen. Derived rather than looped in markup so the
   *  bar-vs-beat decision is made once. */
  const visibleBeats = $derived(
    Array.from({ length: Math.ceil(gridW / view.beatWidth) + 2 }, (_, i) => Math.floor(view.originBeat) + i),
  );

  /** Query. Pointer coordinates in the GRID's own pixel space. */
  function gridPoint(event) {
    const r = gridEl.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  }

  /** Command. Begin a gesture. Empty grid ADDS a note; a note's body MOVES it; a
   *  note's edge RESIZES it (core/piano_roll.noteZoneAt decides which). */
  function onPointerDown(event) {
    if (event.button !== 0) return;
    gridEl.setPointerCapture(event.pointerId);
    const { x, y } = gridPoint(event);
    const hit = noteHitAt(rows.map((r) => r.note), x, y, view);
    if (!hit) {
      // ADD. Born one grid cell long (a whole beat when snapping is off), at the
      // toolbar's velocity, and SELECTED — so the velocity slider immediately
      // governs the note just drawn rather than only the next one.
      const start = snapBeat(xToBeat(x, view), snap);
      const note = { start, duration: snap > 0 ? snap : 1, pitch: yToPitch(y, view), velocity };
      const next = withNoteAdded(clip, note);
      selected = next.list.length - 1;
      app.previewPianoRollClip(next);
      app.commitPianoRollClip();
      return;
    }
    const row = rows[hit.index];
    selected = row.index;
    velocity = row.note.velocity;
    drag = {
      kind: hit.zone === "body" ? "move" : hit.zone,
      index: row.index,
      // WHERE IN THE NOTE the pointer grabbed, so a move does not jump the note's
      // start to the pointer. Without it, grabbing a whole note near its end and
      // nudging it would snap its start under the cursor — a jump of most of a bar.
      grabOffset: xToBeat(x, view) - row.note.start,
      origin: row.note,
    };
  }

  /** Command. Continue a gesture as a LIVE PREVIEW (no undo entry). */
  function onPointerMove(event) {
    if (!drag) return;
    const { x, y } = gridPoint(event);
    const beat = xToBeat(x, view);
    const o = drag.origin;
    let note;
    if (drag.kind === "move") {
      note = { ...o, start: snapBeat(beat - drag.grabOffset, snap), pitch: yToPitch(y, view) };
    } else if (drag.kind === "end") {
      // The END edge moves; the start stays. Floored at the model's shortest note
      // so a drag past the start cannot invert the note.
      note = { ...o, duration: Math.max(MIN_DURATION_BEATS, snapBeat(beat, snap) - o.start) };
    } else {
      // The START edge moves and the END stays put, so the duration absorbs the
      // difference. Clamped so the start can never cross its own end.
      const end = o.start + o.duration;
      const start = Math.min(snapBeat(beat, snap), end - MIN_DURATION_BEATS);
      note = { ...o, start, duration: end - start };
    }
    app.previewPianoRollClip(withNoteAt(clip, drag.index, note));
  }

  /** Command. Finish the gesture — ONE undo unit. */
  function onPointerUp(event) {
    if (!drag) return;
    gridEl.releasePointerCapture?.(event.pointerId);
    drag = null;
    app.commitPianoRollClip();
  }

  /** Command. Right-click ERASES the note under the pointer. Purge, not hide —
   *  hiding is the Inspector's affordance and means something different
   *  (core/midi_clip.withNoteRemoved states the cost). */
  function onContextMenu(event) {
    event.preventDefault();
    const { x, y } = gridPoint(event);
    const hit = noteHitAt(rows.map((r) => r.note), x, y, view);
    if (!hit) return;
    eraseNote(rows[hit.index].index);
  }

  /** Command. Purge one note by RAW index, as one undo unit. */
  function eraseNote(index) {
    app.previewPianoRollClip(withNoteRemoved(clip, index));
    app.commitPianoRollClip();
    selected = null;
  }

  /** Command. Set the selected note's velocity (and the velocity new notes are
   *  born at). One undo unit per change. */
  function setVelocity(v) {
    velocity = Number(v);
    if (selected === null) return;
    const note = noteRecord(clip.list[selected]);
    if (!note) return;
    app.previewPianoRollClip(withNoteAt(clip, selected, { ...note, velocity }));
    app.commitPianoRollClip();
  }

  /**
   * Command. The wheel: PLAIN scrolls, CTRL/CMD zooms — the canvas's own
   * vocabulary one frame down (web/interiorNav.js uses the identical pairing), so
   * an author who has learned the canvas has already learned this.
   *
   * SHIFT+wheel zooms the PITCH axis rather than the beat axis, because the two
   * are independent here in a way a canvas's zoom is not: a dense chord wants
   * taller rows without wider beats.
   */
  function onWheel(event) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      view = zoomedView(view, event.shiftKey ? "rowHeight" : "beatWidth", factor);
      return;
    }
    view = scrolledView(view, event.shiftKey ? event.deltaY : event.deltaX, event.shiftKey ? 0 : event.deltaY);
  }

  /** How much one wheel notch zooms. 1.15 is small enough that a trackpad's many
   *  small deltas feel continuous rather than steppy. */
  const ZOOM_STEP = 1.15;

  /** Command. Delete/Backspace purges the selection. Scoped to this dialog: the
   *  Modal's panel carries role="dialog", so App.svelte's focusContext has already
   *  stood the canvas shortcuts down and this cannot also delete the WIDGET. */
  function onKeyDown(event) {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (selected === null) return;
    event.preventDefault();
    eraseNote(selected);
  }

  /** Command. Close. Any uncommitted preview is dropped by the app (a dialog
   *  dismissed mid-drag must not leave half a gesture on the canvas). */
  function done() {
    app.closePianoRoll();
  }

  onMount(() => {
    // Headless test/dev seam, mirroring web/CodeEditorModal.svelte's
    // `window.__powerrp_codeModal`: a probe drives the REAL editor — its geometry,
    // its writes, its selection — without simulating pixel-accurate pointer
    // gestures against an SVG. Cleared on unmount.
    window.__powerrp_pianoRoll = {
      view: () => ({ ...view }),
      rows: () => rows.map((r) => ({ index: r.index, ...r.note })),
      skipped: () => skipped,
      selected: () => selected,
      snap: () => snap,
      setSnap: (v) => { snap = Number(v); },
      setVelocity,
      erase: eraseNote,
      /** The grid rect in CLIENT coordinates, so a probe can aim a real pointer
       *  event at a beat/pitch it computed with core/piano_roll.js. */
      gridRect: () => gridEl?.getBoundingClientRect().toJSON(),
      close: done,
    };
    return () => { if (window.__powerrp_pianoRoll) delete window.__powerrp_pianoRoll; };
  });
</script>

<Modal bind:open size="large" title="Piano roll" titleIcon="mdi:piano" onclose={done}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="pr-root" role="application" aria-label="Piano roll editor" tabindex="-1" onkeydown={onKeyDown}>
    <div class="pr-toolbar">
      <label class="pr-field">
        <span class="pr-field-label">Snap</span>
        <select class="pr-select" value={snap} onchange={(e) => { snap = Number(e.currentTarget.value); }}>
          {#each SNAP_DIVISIONS as d (d)}
            <option value={d}>{snapLabel(d)}</option>
          {/each}
        </select>
      </label>
      <label class="pr-field">
        <span class="pr-field-label">Velocity</span>
        <input
          class="pr-range" type="range" min={VELOCITY_MIN} max={VELOCITY_MAX} step="1"
          value={velocity} oninput={(e) => setVelocity(e.currentTarget.value)}
        />
        <span class="pr-field-value">{velocity}</span>
      </label>
      <span class="pr-toolbar-gap"></span>
      <span class="pr-zoom">
        <Tooltip text="Narrower beats — show more of the clip"><button type="button" class="pr-btn" aria-label="Narrower beats" onclick={() => { view = zoomedView(view, "beatWidth", 1 / 1.4); }}>−</button></Tooltip>
        <span class="pr-field-label">Beat</span>
        <Tooltip text="Wider beats — more room per note"><button type="button" class="pr-btn" aria-label="Wider beats" onclick={() => { view = zoomedView(view, "beatWidth", 1.4); }}>+</button></Tooltip>
        <Tooltip text="Shorter rows — show more of the pitch range"><button type="button" class="pr-btn" aria-label="Shorter rows" onclick={() => { view = zoomedView(view, "rowHeight", 1 / 1.4); }}>−</button></Tooltip>
        <span class="pr-field-label">Row</span>
        <Tooltip text="Taller rows — easier to hit"><button type="button" class="pr-btn" aria-label="Taller rows" onclick={() => { view = zoomedView(view, "rowHeight", 1.4); }}>+</button></Tooltip>
      </span>
    </div>

    <div class="pr-body">
      <!-- THE KEY COLUMN. Drawn from the same `visiblePitches` the lanes are, so a
           label can never sit beside the wrong row. -->
      <div class="pr-keys" style="--a-pr-row-h: {view.rowHeight}px">
        {#each visiblePitches as pitch (pitch)}
          <div class="pr-key" class:pr-key-black={isBlackPitch(pitch)} class:pr-key-c={pitch % 12 === 0}>
            {#if view.rowHeight >= 10 && (pitch % 12 === 0 || view.rowHeight >= 18)}<span class="pr-key-name">{pitchName(pitch)}</span>{/if}
          </div>
        {/each}
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="pr-grid" class:pr-grid-dragging={drag !== null}
        bind:this={gridEl} bind:clientWidth={gridW} bind:clientHeight={gridH}
        onpointerdown={onPointerDown} onpointermove={onPointerMove}
        onpointerup={onPointerUp} onpointercancel={onPointerUp}
        oncontextmenu={onContextMenu} onwheel={onWheel}
      >
        <svg class="pr-svg" width={gridW} height={gridH} aria-hidden="true">
          {#each visiblePitches as pitch (pitch)}
            <rect
              class="pr-lane" class:pr-lane-black={isBlackPitch(pitch)}
              x="0" y={pitchToY(pitch, view)} width={gridW} height={view.rowHeight}
            />
          {/each}
          {#each visibleBeats as beat (beat)}
            <line
              class="pr-rule" class:pr-rule-bar={beat % 4 === 0}
              x1={beatToX(beat, view)} y1="0" x2={beatToX(beat, view)} y2={gridH}
            />
          {/each}
          {#each rows as row (row.index)}
            {@const r = noteRect(row.note, view)}
            <rect
              class="pr-note" class:pr-note-selected={row.index === selected}
              x={r.x} y={r.y} width={r.w} height={r.h}
              opacity={0.35 + 0.65 * (row.note.velocity / VELOCITY_MAX)}
            />
          {/each}
        </svg>
      </div>
    </div>

    <div class="pr-footer">
      <span class="pr-hint">
        Click empty grid to add · drag to move · drag an edge to resize · right-click or Delete to erase · wheel scrolls, {navigator.platform?.startsWith("Mac") ? "⌘" : "Ctrl"}+wheel zooms
      </span>
      <span class="pr-status">
        {rows.length} note{rows.length === 1 ? "" : "s"}{#if skipped > 0}<Tooltip text="Notes that are hidden, or whose fields are bound to equations. They are still in the clip — edit those in the Inspector's Clip rows."><span class="pr-skipped">{" · "}{skipped} not shown</span></Tooltip>{/if}
      </span>
      <button type="button" class="pr-btn pr-primary" onclick={done}>Done</button>
    </div>
  </div>
</Modal>
