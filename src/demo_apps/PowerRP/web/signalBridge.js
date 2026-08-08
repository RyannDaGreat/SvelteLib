/**
 * THE MONITORING BRIDGE — signal's live transport, made audible, and fenced.
 *
 * ── TWO PIPES, AND THIS IS THE ONE THAT MUST NEVER REACH A RENDER ───────────
 * The embedded editor talks to us twice over, and the two could not be more
 * different in kind:
 *
 *   AUTHORING   `localStorage["signal_autosave"]` → core/signal_song.js → the
 *               `clip` and `ctrl` LIST PROPERTIES. **PROPERTY STATE**: folded,
 *               keyframable, saved, byte-identical on every machine, and what an
 *               export renders. That is the pipe that matters.
 *   MONITORING  this file. signal's transport posts each MIDI event to the parent
 *               as it plays. **EPHEMERAL STATE, and irreducibly so** — every
 *               message carries `delayMs` RELATIVE TO POST TIME (a reading of
 *               `performance.now()`, whose origin differs per browsing context, so
 *               a timestamp would be meaningless across the frame boundary), and
 *               this file lands it on a `setTimeout`. A wall clock, twice.
 *
 * CLAUDE.md's four-kinds law forbids ephemeral state from reaching a render tree,
 * so NOTHING HERE TOUCHES THE DOCUMENT. It calls the live audio engine directly and
 * writes nothing, exactly as a hand on the Surge modal's piano does — the same
 * fence, for the same reason. Hearing your song while you draw it is a PERFORMANCE.
 *
 * ── THE `io` FACADE, AND WHY IT IS WIDER THAN WEBSURGE'S ────────────────────
 * WebSurge's mode interface is `{noteOn, noteOff, allNotesOff, setModeStatus}`, and
 * their own manifest calls what that costs "the biggest gap": signal has full
 * automation lanes for pitch bend and CC, their worklet implements both, and the
 * events were dropped at this exact boundary because the facade had no method to
 * receive them. That gap is not shipped forward. `PITCH BEND` and `CC` are members
 * here, and the AUTHORING pipe carries them too (core/midi_clip.js's control lane),
 * so an author's filter sweep survives in BOTH directions.
 *
 * ── ONE THING IS STILL MISSING AND IT IS SAID OUT LOUD ──────────────────────
 * The engine-side facade a route resolves to (`synth/modules_surge.js`'s
 * `surgeControl`, reached through `web/audioMirror.moduleControlFor`) exposes
 * `noteOn`/`noteOff`/`allNotesOff` and NOT `pitchBend`/`cc` — although the worklet
 * behind it implements both message types in full. So a bend monitored from signal
 * has nowhere to land TODAY. `attachSignalBridge` therefore COUNTS what it could
 * not deliver and reports it in the modal's footer, rather than dropping it in
 * silence the way the integration we inherited did. Closing it is two methods on
 * `surgeControl`:
 *
 *     pitchBend: (value) => post({ type: "pitchBend", channel: 0, value }),
 *     cc: (cc, value)   => post({ type: "cc", channel: 0, cc, value }),
 *
 * — the worklet's own message names, values already in raw MIDI units. That file is
 * owned by another workstream at the time of writing, which is why this one is
 * built to detect the methods rather than to require them.
 */

import { midiRoutes } from "../core/clip_playback.js";

/** The message `type` signal's embed patch posts. THEIRS, not ours — it is what
 *  `ParentPortOutput.sendEvent` writes, and grepping this constant is how a reader
 *  finds the other end.
 *  @example SIGNAL_OUTPUT_MESSAGE // "signal:synth-output" */
export const SIGNAL_OUTPUT_MESSAGE = "signal:synth-output";

/**
 * Command (attaches a window listener; schedules timeouts). Routes signal's live
 * transport into the engine modules this clip is WIRED to.
 *
 * ── THE TWO CHECKS ON EVERY MESSAGE, AND WHY BOTH ARE NEEDED ───────────────
 * `event.source !== frame.contentWindow` is the one that matters: it pins the
 * sender to THIS frame, so no other frame, opener or extension content script can
 * play notes through us. It is also why the vendored copy must be SAME-ORIGIN and
 * not merely same-looking — signal posts with `postMessage(msg, location.origin)`,
 * targeting its OWN origin, so a cross-origin copy delivers nothing at all and the
 * pairing is enforced from both sides.
 *
 * The `type` check is ordinary discrimination: a window receives messages from
 * many places and most are not ours.
 *
 * ── ROUTING IS THE DOCUMENT'S, NOT A GUESS ─────────────────────────────────
 * Which instrument to play is `core/clip_playback.midiRoutes` — the same query the
 * deterministic scheduler uses, so what you HEAR while authoring is what the deck
 * will PLAY. A clip wired to nothing is silent here too, which is correct and is
 * reported rather than looking broken.
 *
 * ── THE ENGINE LOOKUP IS INJECTED, AND THAT IS WHY THIS FILE IS TESTABLE ───
 * `controlFor` is `web/audioMirror.moduleControlFor` in the app. It is a PARAMETER
 * rather than an import because importing it would drag in a `.svelte.js` module
 * holding a module-level `$state` rune, which bare node cannot evaluate — so this
 * file would have had to join tests/doctest_test.js's HOST_BOUND list, its
 * `@example`s would never run, and the three-way delivery outcome below (the whole
 * point of the widened facade) could not be unit-tested at all. One parameter buys
 * the module back: tests/signal_bridge_test.js drives every branch with a fake
 * control, which is how the `deliver` bug in the paragraph below was caught.
 *
 * @param {object} opts
 * @param {HTMLIFrameElement} opts.frame - the signal iframe
 * @param {() => object} opts.items - the folded item map, read per event
 * @param {object} opts.registry - the plugin registry
 * @param {string} opts.itemId - the clip node being edited
 * @param {(id: string) => object|null} opts.controlFor - the live engine facade for a module id
 * @param {(status: object) => void} [opts.onStatus] - called when the counts change
 * @returns {() => void} detach — removes the listener, clears pending timeouts and
 *   panics every route, so closing the dialog cannot leave a note stuck on.
 */
export function attachSignalBridge({ frame, items, registry, itemId, controlFor, onStatus }) {
  const pending = new Set();
  const status = { notes: 0, controls: 0, undelivered: 0, unroutable: 0 };

  /** The engine facades this clip's `midi` output reaches, resolved PER EVENT.
   *  Per event rather than once, because a cable dragged while the dialog is open
   *  must take effect — the modal is not modal to the document. */
  const targets = () => midiRoutes(items() ?? {}, registry, itemId)
    .map((r) => controlFor?.(r.id))
    .filter(Boolean);

  /**
   * THE `io` FACADE. Five members where WebSurge's had three; see the file header.
   * Each returns whether it was DELIVERED, so the caller can count what the engine
   * could not take instead of assuming it could.
   */
  const io = {
    noteOn: (key, velocity) => deliver("noteOn", [key, velocity]),
    noteOff: (key) => deliver("noteOff", [key]),
    allNotesOff: () => deliver("allNotesOff", []),
    pitchBend: (value) => deliver("pitchBend", [value]),
    cc: (controller, value) => deliver("cc", [controller, value]),
  };

  /**
   * Calls `method` on every routed engine facade, and answers WHICH of three
   * things happened. Three outcomes and not a boolean, because the two failures
   * have different fixes and the footer has to say which one to apply: "unroutable"
   * means drag a cable, "undelivered" means the instrument's live surface has no
   * such method (see the header — that is `pitchBend`/`cc` today).
   *
   * PRESENCE IS TESTED, NOT THE RETURN VALUE. These facade methods are commands and
   * return `undefined` on success, so `t.noteOn?.(…) !== undefined` — which this
   * function did in its first draft — reports every successful note as undelivered.
   * The bug is invisible in the audio (the note plays) and shows up only as a false
   * warning, which is the kind that gets believed.
   */
  function deliver(method, args) {
    const list = targets();
    if (list.length === 0) return "unroutable";
    let any = false;
    for (const t of list) {
      if (typeof t?.[method] !== "function") continue;
      any = true;
      t[method](...args);
    }
    return any ? "delivered" : "undelivered";
  }

  function onMessage(event) {
    if (event.source !== frame?.contentWindow) return;
    if (event.data?.type !== SIGNAL_OUTPUT_MESSAGE) return;
    const midi = event.data.event;
    // `delayMs` IS A LEAD TIME, NOT A TIMESTAMP (their choice, and the right one —
    // see the header). Clamped at 0 because a message that took longer to cross the
    // boundary than its own lead has already missed its moment and must sound NOW,
    // not be dropped: late is a performance artefact, silent is a bug.
    const delay = Math.max(0, Number(event.data.delayMs) || 0);
    const timer = setTimeout(() => { pending.delete(timer); play(midi); }, delay);
    pending.add(timer);
  }

  /** Translates ONE of signal's MIDI event objects into an `io` call. Its shape is
   *  the `midifile` event vocabulary signal uses internally: `{subtype, noteNumber,
   *  velocity, controllerType, value}`. Anything else is ignored — a monitoring
   *  path must never throw into a keystroke. */
  function play(midi) {
    const subtype = midi?.subtype;
    let outcome = null;
    if (subtype === "noteOn" && midi.velocity > 0) { outcome = io.noteOn(midi.noteNumber, midi.velocity); status.notes++; }
    else if (subtype === "noteOn" || subtype === "noteOff") outcome = io.noteOff(midi.noteNumber);
    else if (subtype === "pitchBend") { outcome = io.pitchBend(midi.value); status.controls++; }
    else if (subtype === "controller") {
      // 120 (all sound off) and 123 (all notes off) are PANICS, not automation:
      // signal sends them on stop, and forwarding them as ordinary CC would leave
      // every note sounding on an engine that does not map them.
      if (midi.controllerType === 120 || midi.controllerType === 123) outcome = io.allNotesOff();
      else { outcome = io.cc(midi.controllerType, midi.value); status.controls++; }
    } else return;
    if (outcome === "undelivered") status.undelivered++;
    else if (outcome === "unroutable") status.unroutable++;
    onStatus?.({ ...status });
  }

  window.addEventListener("message", onMessage);
  const detach = () => {
    window.removeEventListener("message", onMessage);
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
    // PANIC ON THE WAY OUT. A dialog closed mid-playback must not leave a voice
    // sounding forever; `allNotesOff` is wholesale and that is what is wanted here.
    for (const t of targets()) t.allNotesOff?.();
  };
  // THE TRANSLATOR IS HUNG OFF THE DETACH FUNCTION so a test can drive one MIDI
  // event straight through the real `play` → `io` → `deliver` chain without a
  // window, an iframe or a timer. Not a second entry point: `onMessage` calls the
  // same function, so a test that exercised a copy would prove nothing.
  detach.play = play;
  detach.status = () => ({ ...status });
  return detach;
}

/**
 * Pure function. The monitoring status as ONE SENTENCE for the modal's footer, or
 * null when there is nothing worth saying.
 *
 * NULL WHEN EVERYTHING IS FINE, so a working setup shows no chrome at all. The
 * three abnormal states each get their own sentence because their FIXES are
 * different: wire a cable, widen the engine facade, or nothing (idle).
 *
 * @param {object} status - the counts `attachSignalBridge` reports
 * @returns {string|null}
 *
 * @example signalMonitorNote({notes: 0, controls: 0, undelivered: 0, unroutable: 0}) // null
 * @example signalMonitorNote({notes: 4, controls: 0, undelivered: 0, unroutable: 4}) // "Playing in signal is not audible: this node's midi output is not wired to an instrument."
 */
export function signalMonitorNote(status) {
  if (!status) return null;
  if (status.unroutable > 0)
    return "Playing in signal is not audible: this node's midi output is not wired to an instrument.";
  if (status.undelivered > 0)
    return `${status.undelivered} pitch-bend/CC message${status.undelivered === 1 ? "" : "s"} could not be monitored — the wired instrument's live control surface takes notes only. They are still IMPORTED and still play back from the document.`;
  return null;
}
