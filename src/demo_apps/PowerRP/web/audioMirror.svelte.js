/**
 * THE AUDIO MIRROR — one AudioContext, one engine, and the document reflected into
 * it. web/gpuService.js is the precedent: a single shared service that a whole
 * category of consumers goes through, owning the expensive resource nobody else
 * should construct.
 *
 * ── WHAT IT MIRRORS, AND IN WHICH DIRECTION ─────────────────────────────────
 * ONE WAY, ALWAYS: document → engine. The evaluated item map is the truth; the
 * engine is a rendering of it, exactly as the canvas is. Nothing the engine does
 * ever writes back into the document — not a meter level, not a playhead, not a
 * "currently playing" flag. That is what keeps the core invariant intact
 * (RenderTree = pure(document, [[slide, alpha]])), and it is why a patch that
 * sounds different on two machines is impossible: the document says the same
 * thing on both, and the sound is downstream of it.
 *
 * The DECISIONS — which items are modules, which wires are real, what calls turn
 * scene A into scene B — are NOT here. They are pure functions in
 * core/audio_mirror_diff.js, checked in bare node by tests/audio_nodes_test.js.
 * This file owns the three things that cannot be pure: the AudioContext, the
 * promise lifetimes, and the subscriptions.
 *
 * ── DETERMINISM: THE ENGINE IS A LIVE CONSUMER, DELIBERATELY ────────────────
 * Blueprint §7 and CLAUDE.md's taxonomy. The GRAPH and every KNOB are PROPERTY
 * STATE: ordinary keyframable leaves, folded from the document, reproducible under
 * a shuffle of time. The SOUND is not state at all — it runs on the browser's audio
 * clock, the same way the video PLAYER does, and is equally not reproducible in an
 * export. That is a deliberate boundary, not an oversight, and it is stated in the
 * manifest rather than hidden: a player's playing is not document state.
 *
 * What DOES stay deterministic is TIMING. Anything that has to agree with the
 * presentation's own clock reads particleTime() through the one seam
 * (render_gpu/particle_clock.js) rather than a wall clock — see `scheduleFrom`
 * below. That is the seam the presenter drives live and the editor/CLI freeze.
 *
 * ── AUTOPLAY: STATED, NEVER HIDDEN ──────────────────────────────────────────
 * Browsers refuse to start an AudioContext without a user gesture, so a patch on a
 * freshly loaded slide is SILENT and that silence is indistinguishable from a
 * broken patch. The mirror therefore has an explicit `status` — "idle", "blocked",
 * "starting", "running", "failed" — which web/AudioBadge.svelte surfaces as a small
 * "audio off — click to enable" control. The engine's own docblock makes the same
 * point about dev.html: "a synth that is silently suspended looks exactly like a
 * synth that is broken."
 *
 * IMPORTANT CONSEQUENCE, and the reason the graph is built before the context runs:
 * the mirror keeps the engine's GRAPH in sync from the moment a patch exists, even
 * while the context is suspended. So enabling audio is instantaneous and correct
 * rather than a rebuild — and a patch edited while muted is already right when the
 * sound arrives.
 */

import { createEngine } from "../synth/engine.js";
import { diffAudioScene, initialParamOps, readAudioScene } from "../core/audio_mirror_diff.js";
import { noteRoutes, triggerRoutes } from "../core/live_control.js";
import { reportOnce } from "../core/report.js";

/** The one engine instance for the page. Created lazily: a deck with no audio
 *  widgets must not construct an AudioContext at all (Chrome logs a warning for
 *  every suspended context, and an unused one is a real resource). */
let engine = null;
let engineReady = null;

/** The scene the ENGINE currently holds — the `prev` half of every diff. Kept here
 *  rather than re-read from the engine because the engine's own `inspect()` reports
 *  its live graph, which lags by the settle time of any in-flight rewire; diffing
 *  against a lagging picture would re-issue calls that are already on their way. */
let engineScene = { modules: {}, connections: [] };

/** In-flight guard. Engine topology calls RETURN PROMISES that resolve when the
 *  wire actually switches (~33 ms — the guarded ramp). Two overlapping applies
 *  would interleave their connects and disconnects, so a second one waits. */
let applying = null;
let pending = null;

/**
 * The mirror's own reactive state, for the badge. Svelte 5 runes — this module is
 * `.svelte.js` for exactly this one object; everything else here is plain JS.
 *
 * `status` values and what each MEANS to a user looking at the badge:
 *   idle     — no audio widgets on this slide. The badge is not shown.
 *   blocked  — there IS a patch, and the browser has not let us start. CLICKABLE.
 *   starting — a resume() is in flight.
 *   running  — sound is on.
 *   failed   — resume() was refused or the engine could not init. The REASON is
 *              carried, because "audio failed" with no sentence is the same
 *              unhelpful silence the badge exists to replace.
 */
export const audioState = $state({ status: "idle", reason: null, moduleCount: 0 });

/**
 * Command. Ensure the engine exists and its worklets are loaded.
 *
 * The AudioContext is constructed SUSPENDED (browsers give us no choice without a
 * gesture) and stays that way until enableAudio(). Worklet loading is awaited here
 * rather than at resume, so the first click is not also the first module compile.
 */
function ensureEngine() {
  if (engineReady) return engineReady;
  engine = createEngine();
  engineReady = engine.init().catch((e) => {
    // A FAILURE HERE IS FATAL TO AUDIO AND MUST SAY SO. The most common cause is
    // the worklet module failing to load (a 404 on processors.js under a changed
    // base path), which otherwise presents as "everything is wired and nothing
    // makes noise" — indistinguishable from a bad patch.
    audioState.status = "failed";
    audioState.reason = `the synth engine could not start: ${e.message}`;
    reportOnce(`PowerRP: audio engine failed to initialise — ${e.message}`);
    throw e;
  });
  return engineReady;
}

/**
 * Command. THE ENTRY POINT: reflect `items` (an EVALUATED, folded item map) into
 * the engine. Called from the app's derivation pass.
 *
 * Cheap when nothing audio-shaped changed, which is the common case by far: reading
 * the scene is a walk over the item map, and an unchanged scene diffs to zero ops,
 * so a node DRAG (which re-evaluates on every pointermove) issues no engine calls
 * at all. That is the property that lets a patch keep playing while it is edited.
 *
 * @param {object} items - the evaluated folded item map
 * @param {object} registry - the plugin registry
 */
export function mirrorAudio(items, registry) {
  const scene = readAudioScene(items, registry);
  const count = Object.keys(scene.modules).length;
  audioState.moduleCount = count;

  if (count === 0 && Object.keys(engineScene.modules).length === 0) {
    // NOTHING TO DO AND NOTHING TO TEAR DOWN. The overwhelmingly common case (a
    // deck with no audio), and it must not construct an AudioContext.
    if (audioState.status === "idle" || audioState.status === "blocked") audioState.status = "idle";
    return;
  }
  if (audioState.status === "idle" && count > 0) audioState.status = "blocked";

  const ops = diffAudioScene(engineScene, scene);
  if (ops.length === 0) return;
  engineScene = scene;
  queueApply(ops, scene);
}

/**
 * Command. Serialize an op batch onto the engine.
 *
 * COLLAPSING RATHER THAN QUEUEING: if a batch is already running, only the LATEST
 * pending scene is kept — an author dragging a knob generates a batch per frame,
 * and running all of them in sequence would make the sound lag the UI by however
 * long the drag lasted. The intermediate values are not interesting; the current
 * one is. The stored scene is diffed against what the engine actually reached, so
 * collapsing cannot lose a change, only skip a stale one.
 */
function queueApply(ops, scene) {
  if (applying) { pending = scene; return; }
  applying = applyOps(ops)
    .catch((e) => {
      audioState.status = "failed";
      audioState.reason = `an audio graph change failed: ${e.message}`;
      reportOnce(`PowerRP: audio graph change failed — ${e.message}`);
    })
    .finally(() => {
      applying = null;
      const next = pending;
      pending = null;
      // ── THE SELF-HEALING PASS, AND WHY IT RUNS EVEN WITH NOTHING PENDING ────
      // applyOps SKIPS any op whose module the engine no longer holds (see the race
      // documented there), so a batch can finish having done less than its transcript
      // said. `engineScene` would then be a claim rather than a fact.
      //
      // So the truth is re-read from the ENGINE and re-diffed against the target. A
      // skipped op is recomputed and re-issued on this pass; if the engine really did
      // reach the target, the diff is empty and this costs one walk of a handful of
      // modules. That is what makes "skip it and move on" safe rather than lossy.
      const target = next ?? engineScene;
      const held = new Set(engine ? engine.inspect().modules.map((m) => m.id) : []);
      const reached = {
        modules: Object.fromEntries(Object.entries(engineScene.modules).filter(([id]) => held.has(id))),
        connections: engineScene.connections.filter((c) => held.has(c.sourceId) && held.has(c.targetId)),
      };
      engineScene = target;
      const followUp = diffAudioScene(reached, target);
      if (followUp.length) queueApply(followUp, target);
    });
}

/**
 * Command. Execute one ordered op batch, AWAITING the topology calls.
 *
 * WHY THE AWAITS ARE LOAD-BEARING (NF-SYNTH's landed report): add/remove/connect/
 * disconnect resolve when the wire ACTUALLY switches, about 33 ms later, because
 * the engine ramps a guard gain down, waits four time constants, switches, and ramps
 * back up. Firing a `connect` at a module whose `addModule` has not settled is not a
 * race we can win by ordering alone — the await is what makes the ordering real.
 *
 * setParam is NOT awaited: it is an AudioParam schedule, not a topology change, and
 * it takes effect on the audio thread without a settle.
 */
async function applyOps(ops) {
  await ensureEngine();
  // WHAT THE ENGINE ACTUALLY HOLDS, RE-READ BEFORE EVERY OP THAT NAMES A MODULE.
  //
  // ── THE RACE THIS FIXES, WHICH A PROBE CAUGHT AND REASONING DID NOT ────────
  // EVERY `await` HERE IS A YIELD POINT, and each one lasts about 33 ms (the guarded
  // rewire ramp). During that window the document can change, `queueApply` can stash
  // a newer scene, and the REST OF THIS BATCH becomes stale — it was computed against
  // a picture of the engine that is no longer true. The symptom measured by
  // tests/audio_mirror_probe.js was `setParam` on a module id the engine had already
  // dropped: "No module with id …", thrown from the engine, surfaced as a failed
  // graph change. Harmless in that instance and NOT harmless in general — the same
  // window can put a `connect` after its module's removal.
  //
  // The fix is not more locking; it is asking the engine rather than assuming. Each
  // op that names a module checks that the module is THERE at the moment it runs. A
  // skipped op is not a lost change: the follow-up diff in `queueApply` re-diffs
  // against the scene the engine actually reached, so whatever this batch could not
  // do is recomputed from the truth.
  const holds = (id) => engine.inspect().modules.some((m) => m.id === id);
  for (const op of ops) {
    switch (op.op) {
      case "disconnect":
        // Both ends must still exist. Disconnecting a wire whose module is gone is
        // not merely useless — removeModule already dropped its connections.
        if (holds(op.sourceId) && holds(op.targetId))
          await engine.disconnect(op.sourceId, op.sourcePort, op.targetId, op.targetPort);
        break;
      case "removeModule":
        if (holds(op.id)) await engine.removeModule(op.id);
        unsubscribeAnalysis(op.id);
        break;
      case "addModule": {
        // A rebuild's remove may have been skipped above (already gone), or a
        // concurrent batch may have added this id. Adding twice throws.
        if (holds(op.id)) break;
        await engine.addModule(op.module, op.id, op.params);
        // The LIVE knobs, pushed once: addModule carries only construct-time params,
        // so without this a module born mid-session sits at the engine's factory
        // defaults while the Inspector shows the author's values.
        const scene = engineScene.modules[op.id];
        if (scene && holds(op.id)) {
          for (const p of initialParamOps(scene, op.id)) engine.setParam(p.id, p.key, p.value, { rampSeconds: 0 });
          subscribeAnalysis(op.id, scene);
        }
        break;
      }
      case "connect":
        if (holds(op.sourceId) && holds(op.targetId))
          await engine.connect(op.sourceId, op.sourcePort, op.targetId, op.targetPort);
        break;
      case "setParam":
        if (holds(op.id)) engine.setParam(op.id, op.key, op.value, { rampSeconds: op.rampSeconds });
        break;
      default:
        // A NEW OP KIND MUST NOT BE SILENTLY DROPPED. If core/audio_mirror_diff.js
        // grows a verb this switch does not implement, the symptom would be a
        // change that the transcript makes and the sound does not.
        throw new Error(`audioMirror: unknown engine op "${op.op}"`);
    }
  }
}

// ── LIVE ANALYSIS DATA (the meter and spectrum overlays) ─────────────────────
//
// THE SEAM, STATED PLAINLY. An analysis node's bouncing bar is LIVE AUDIO, which is
// not document state and cannot be: reading it inside a plugin's emit() would make
// Δt = 0 produce two different pictures, which breaks the determinism law, frame
// range sharding and export reproducibility at once (CLAUDE.md).
//
// So it never touches emit(). The plugin paints the node's STATIC form — card,
// frame, label — and the live bar is drawn by web/AudioOverlay.svelte as a CANVAS
// OVERLAY on top, exactly the way selection handles are: a separate layer, in
// screen space, that no export and no cli/render.js ever consults. Turn audio off,
// or render the deck headlessly, and what remains is the static form, which is the
// honest picture of a document that has no sound in it.
//
// The data lands in a plain Map rather than in reactive state on purpose: these
// callbacks fire at rAF for every subscribed node, and routing them through Svelte's
// reactivity would schedule a component update per frame per meter. The overlay
// reads the Map on its own rAF instead.

/** id → {rms, db} for meter nodes, and id → Uint8Array for spectrum nodes. */
export const analysisData = new Map();
const analysisSubs = new Map();

/** Command. Subscribe to a module's live data, if it is an analysis node. */
function subscribeAnalysis(id, module) {
  if (!module?.spec?.overlay) return;
  unsubscribeAnalysis(id);
  if (module.spec.overlay === "meter") {
    analysisSubs.set(id, engine.subscribeMeter(id, (level) => analysisData.set(id, level)));
  } else if (module.spec.overlay === "spectrum") {
    // THE ENGINE REUSES ITS BUFFER (NF-SYNTH's API note: "REUSED buffer — copy if
    // kept"). The overlay reads this on its own rAF, strictly after the callback, so
    // it is read before the next fill and a copy per frame would be pure garbage —
    // ~1 KB per node per frame at 60 Hz. Stored by reference deliberately.
    analysisSubs.set(id, engine.subscribeSpectrum(id, (bins) => analysisData.set(id, bins)));
  }
}

/** Command. Drop a module's subscription and its last data. A subscription that
 *  outlived its module would hold the callback and the buffer forever. */
function unsubscribeAnalysis(id) {
  const off = analysisSubs.get(id);
  if (off) { off(); analysisSubs.delete(id); }
  analysisData.delete(id);
}

// ── THE AUTOPLAY GATE ────────────────────────────────────────────────────────

/**
 * Command. Start the audio context. MUST be called from a real user gesture — that
 * is a browser rule, not ours, and it is why the badge is a button.
 *
 * Idempotent and safe to call when already running.
 */
export async function enableAudio() {
  if (audioState.status === "running" || audioState.status === "starting") return;
  audioState.status = "starting";
  try {
    await ensureEngine();
    await engine.resume();
    audioState.status = engine.isRunning() ? "running" : "blocked";
    audioState.reason = engine.isRunning() ? null : "the browser did not start the audio context — try clicking again";
  } catch (e) {
    audioState.status = "failed";
    audioState.reason = e.message;
    reportOnce(`PowerRP: could not start audio — ${e.message}`);
  }
}

/** Command. Suspend the context without tearing the graph down, so re-enabling is
 *  instant and the patch survives. */
export async function disableAudio() {
  if (!engine) return;
  await engine.suspend();
  audioState.status = audioState.moduleCount > 0 ? "blocked" : "idle";
}

/**
 * Command. Run or hold the engine's SEQUENCER TRANSPORT according to the
 * presentation clock's regime.
 *
 * ── THE TIMING SEAM, AND WHAT IT HONESTLY IS ────────────────────────────────
 * `particleTime()` is the ONE clock the app's time-dependent things read
 * (render_gpu/particle_clock.js): the presenter drives it live, the editor and the
 * CLI freeze it. The rule this seam enforces is the one that matters — WHEN THE
 * PRESENTATION CLOCK IS FROZEN, THE SEQUENCER DOES NOT ADVANCE. An author scrubbing
 * slides in the editor does not get a drum machine running underneath them, and a
 * frozen clock produces a frozen pattern.
 *
 * WHAT THIS IS NOT, said plainly rather than implied: it is not a per-step drive
 * and it does not phase-lock the sequencer to `t`. Between calls the scheduler runs
 * on the AUDIO clock, which it must — the whole point of the two-clock lookahead is
 * that a JS timer cannot place a note accurately, and a scheduler slaved to rAF
 * would jitter audibly. So a sequence STARTED at the same presentation time twice
 * will not be sample-identical; it will be pattern-identical. That is the same
 * boundary the video player sits on (blueprint §7: the engine is a live consumer),
 * and phase-locking it is a wave-3 job that needs a seek-capable transport in
 * synth/scheduler.js, which today has start/stop/reset and no cursor set.
 *
 * @param {boolean} live - whether the presentation clock is running
 */
export function setTransportLive(live) {
  if (!engine || !engine.isRunning()) return;
  const running = engine.scheduler.isRunning();
  if (live && !running) engine.scheduler.start();
  else if (!live && running) engine.scheduler.stop();
}

// ── LIVE CONTROL EVENTS (the button and the keyboard) ────────────────────────
//
// THE SECOND DIRECTION INTO THE ENGINE, and it is not a violation of the one-way
// law stated at the top of this file. That law is about the DOCUMENT: nothing the
// engine does ever writes back into it, and nothing here does either. What a
// press adds is a path INTO the engine that does not pass THROUGH the document —
// because a press is a moment, and a moment is not a value any leaf could hold.
// Storing one would be ephemeral state, which the project has none of
// (core/control_nodes.js states the ruling and its consequences in full).
//
// The ROUTING is still document state, and that is what keeps this honest: the
// press names only its source item, and core/live_control.js reads the document's
// wires to decide which module is struck. So a rewired patch routes the next
// press differently with no bookkeeping, and the decision is a pure function
// covered in bare node — the same split diffAudioScene already makes, for the
// same reason (a missed route is silent).
//
// NOTHING HAPPENS IF THE ENGINE IS NOT RUNNING, and that is deliberate rather
// than an oversight: the badge already tells the user audio is off, and queueing
// presses to fire later would produce a burst of notes at the moment they enable
// sound. A press while muted is a press nobody heard.

/**
 * Command. Fire one live TRIGGER from a control widget — the Button's press.
 *
 * ONE PRESS IS ONE EDGE. This is called once per press gesture (not per
 * pointermove and not per frame while held), which is what makes the engine's
 * rising-edge semantics mean what they say.
 *
 * @param {object} items - the evaluated folded item map
 * @param {object} registry - the plugin registry
 * @param {string} sourceId - the pressed widget's item id
 * @param {string} [sourcePort] - which output fired
 */
export function fireLiveTrigger(items, registry, sourceId, sourcePort = "out") {
  if (!engine || !engine.isRunning()) return;
  for (const route of triggerRoutes(items, registry, sourceId, sourcePort)) {
    // GUARDED THE SAME WAY applyOps GUARDS ITS OPS: the document can name a
    // module the engine has not built yet (a patch added on this very frame,
    // whose addModule is still inside its ~33 ms rewire settle). Throwing here
    // would surface a race as a failed presentation.
    if (!engine.inspect().modules.some((m) => m.id === route.id)) continue;
    engine.trigger(route.id, route.port);
  }
}

/**
 * Command. Play or release ONE NOTE from a keyboard widget.
 *
 * Routes to `engine.noteOn`/`noteOff` for a POLY target (which owns the voice
 * pool, so a chord allocates and steals correctly) and to `engine.trigger` with
 * the note's frequency for a mono method port — so a keyboard plays a bell
 * melody with no poly module in the patch. core/live_control.noteRoutes makes
 * that decision; this only executes it.
 *
 * @param {object} items - the evaluated folded item map
 * @param {object} registry - the plugin registry
 * @param {string} sourceId - the keyboard's item id
 * @param {"on"|"off"} phase - key down or key up
 * @param {number} note - the note identity (MIDI number)
 * @param {number} frequency - the pitch in Hz
 */
export function playLiveNote(items, registry, sourceId, phase, note, frequency) {
  if (!engine || !engine.isRunning()) return;
  const held = new Set(engine.inspect().modules.map((m) => m.id));
  for (const route of noteRoutes(items, registry, sourceId, phase, note, frequency)) {
    if (!held.has(route.id)) continue;
    if (route.op === "noteOn") engine.noteOn(route.id, route.note, route.frequency);
    else if (route.op === "noteOff") engine.noteOff(route.id, route.note);
    else engine.trigger(route.id, route.port, undefined, { frequency: route.frequency });
  }
}

/**
 * Command. Release every note on every poly module — what a slide change owes a
 * held chord.
 *
 * WITHOUT THIS, LEAVING A SLIDE MID-CHORD LEAVES IT SOUNDING FOREVER. The keys
 * are released by a pointerup that the new slide's canvas never sees, so the
 * note-offs are simply never sent, and a poly voice with no release scheduled
 * holds its envelope open. That is a drone with no visible source — the
 * un-debuggable case the mirror's own `active: false` handling exists to prevent.
 */
export function releaseAllLiveNotes() {
  if (!engine || !engine.isRunning()) return;
  for (const m of engine.inspect().modules) {
    // Ask rather than assume: only a poly module has notes to release, and
    // engine.allNotesOff refuses a mono one by name.
    const scene = engineScene.modules[m.id];
    if (scene?.spec?.poly) engine.allNotesOff(m.id);
  }
}

/** Query. The engine, for dev seams and probes. Null before anything audio exists —
 *  callers must handle that rather than being handed a stub that silently no-ops. */
export function audioEngine() {
  return engine;
}

/** Query. What the ENGINE currently holds, for tests and the dev seam. Returns the
 *  mirror's own record, which is the scene the last applied batch reached. */
export function mirroredScene() {
  return engineScene;
}
