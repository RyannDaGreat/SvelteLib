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
 * WHAT IS DETERMINISTIC IS THE SCENE, NOT THE SOUND, and the line between them is
 * mirrorAudioFrame: everything ABOVE it is a pure function of [[slide, alpha]] —
 * which modules exist, which wires are real, what every knob is set to, and now the
 * transport's tempo and pattern length too. Everything BELOW it runs on the
 * AudioContext clock and is not reproducible, in either backend.
 *
 * THE CLOCKS THIS FILE READS, AND THE ONE THING NEITHER OF THEM DECIDES. It reads
 * two — the presentation clock, through core/simulation_history.simulationTimestep,
 * and the AudioContext's own — and both are read for exactly one purpose: how long
 * a parameter ramp should be (frameTimestepSeconds). NEITHER DECIDES WHAT THE SCENE
 * SAYS. A slow frame changes how smoothly a knob arrives at its value, never what
 * that value is, so Δt = 0 still produces an identical scene and the invariant above
 * is untouched. The transport is likewise NOT gated on the presentation clock's
 * regime (see syncTransport for that ruling and its reason).
 *
 * This paragraph twice described a file that had stopped existing — first a
 * `scheduleFrom` that was never written, then "reads no clock at all", true for
 * about an hour until the adaptive ramp landed. Both times the code moved and the
 * prose did not.
 *
 * ── AUTOPLAY: HARVESTED, NEVER ASKED ────────────────────────────────────────
 * USER RULING, 2026-08-06: "Of course I fucking want audio on. I always want audio
 * on. Never make me ask that again." The browser's gesture requirement is real
 * (synth/engine.js's own accounting) and is NOT what was overruled — the PROMPT
 * was. So the gesture is taken from one the user is already making: the first
 * pointerdown or keydown anywhere in the app after a patch exists (armAudioGesture
 * below), which covers clicking the canvas, typing, pressing a Keyboard node's key
 * and hitting Present, because all of those ARE a pointerdown or a keydown.
 *
 * WHAT SURVIVES IS THE FAILURE SURFACE, NOT THE PERMISSION SURFACE. `status` still
 * carries "failed" with a reason and web/AudioBadge.svelte still renders it, because
 * the no-silent-failure law binds and "audio failed" with no sentence is the same
 * unhelpful silence. What no longer exists is a control that asks whether sound is
 * wanted.
 *
 * IMPORTANT CONSEQUENCE, and the reason the graph is built before the context runs:
 * the mirror keeps the engine's GRAPH in sync from the moment a patch exists, even
 * while the context is suspended. So enabling audio is instantaneous and correct
 * rather than a rebuild — and a patch edited while muted is already right when the
 * sound arrives.
 */

import { createEngine } from "../synth/engine.js";
import { diffAudioScene, initialParamOps, knobRampSeconds, readAudioScene, transportOf } from "../core/audio_mirror_diff.js";
import { noteRoutes, triggerRoutes } from "../core/live_control.js";
import { cameraMaxTimestep, simulationTimestep } from "../core/simulation_history.js";
import { meterColumnValues, spectrumColumnValues } from "../core/analysis_display.js";
import { dropAnalysis, pushAnalysisFrame } from "../render_gpu/gpu/live_analysis_registry.js";
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

/** The AUDIO clock reading the previous mirror pass took, or null before the first.
 *  There is no matching `lastPresentedTime`: core/simulation_history.simulationTimestep
 *  keeps that reading for the whole app now. See frameTimestepSeconds. */
let lastAudioTime = null;
/** The ramp the CURRENT batch is using, in seconds. Held here rather than passed
 *  around because queueApply's self-healing follow-up diff must ramp like the batch
 *  it is repairing, not like a fresh one. Starts at the FLOOR, not at 0: a 0 would
 *  be a step discontinuity, which is an audible click, and "no pass has run yet" is
 *  exactly the no-measurement case the floor exists for. */
let frameRamp = knobRampSeconds(0);

/**
 * Command (observes the presentation clock; advances this module's audio-clock
 * reading). THE GAP a parameter push has to bridge — how long since the previous
 * mirror pass.
 *
 * ── TWO CLOCKS, AND THEY ARE NOT ONE CONCEPT SPELLED TWICE ──────────────────
 *   THE PRESENTATION CLOCK is asked through core/simulation_history.simulationTimestep,
 *     which is THE one answer to "how long is this frame?" for the whole app:
 *     dictated by an export when one is running (so a 10 fps render ramps over
 *     100 ms with no export-only code here), measured and clamped otherwise. It is
 *     read-only — it never rolls the simulation, which matters because a ramp that
 *     advanced the integrator would let audio make a pendulum run slow.
 *   THE AUDIO CLOCK is this module's own, and it stays. Presented time is
 *     deliberately FROZEN in the editor, where a patch is nonetheless audible and
 *     being edited; and it is the clock the ramp is actually scheduled against
 *     (synth/engine.js:597 reads context.currentTime), so a gap measured on it is
 *     precisely the gap the hardware will experience. Different clock, different
 *     question — not a duplicate reading.
 *
 * A suspended context's clock does not advance, so a patch built before the first
 * gesture measures 0 and takes the floor — correct, since nothing is audible yet.
 *
 * @param {number|null} maxTimestep - the author's camera clamp, or null for none
 * @returns {number} seconds since the previous pass, or 0 when neither clock moved
 */
function frameTimestepSeconds(maxTimestep) {
  const presentedStep = simulationTimestep(maxTimestep);
  // THE AUDIO READING IS ADVANCED EVEN WHEN THE PRESENTED STEP WINS, and it has to
  // be: skip it through a presentation and the first editor pass afterwards measures
  // the whole show as one gap. `lastAudioTime` means "when this module last looked",
  // so every look must move it, whichever answer is returned.
  const audio = engine ? engine.context.currentTime : null;
  const audioStep = (lastAudioTime === null || audio === null) ? 0 : audio - lastAudioTime;
  lastAudioTime = audio;
  return presentedStep > 0 ? presentedStep : audioStep;
}

/**
 * The mirror's own reactive state, for the badge. Svelte 5 runes — this module is
 * `.svelte.js` for exactly this one object; everything else here is plain JS.
 *
 * `status` values, and which of them a user ever SEES:
 *   idle     — no audio widgets on this slide. Nothing is shown.
 *   blocked  — there IS a patch and the context has not started yet, because no
 *              gesture has happened. NOT SURFACED: it resolves itself the moment
 *              the user touches anything, and surfacing it is the prompt the user
 *              overruled.
 *   starting — a resume() is in flight. Not surfaced, for the same reason.
 *   running  — sound is on.
 *   failed   — resume() was refused or the engine could not init. THE ONE SURFACED
 *              STATE, and it carries its REASON, because "audio failed" with no
 *              sentence is the unhelpful silence the badge exists to replace.
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
 * Command. THE ONE AUDIO FRAME SEAM: reflect the EVALUATED FRAME `state` into the
 * engine.
 *
 * ── IT TAKES A FRAME, NOT A SLIDE, AND THAT IS THE WHOLE POINT ──────────────
 * `RenderTree = pure(document, [[slide, alpha]])`. Sound is downstream of the same
 * pair, so this takes exactly what the PICTURE's entry point takes —
 * web/cameraFrame.cameraFrameIR(state, …) — an already-evaluated folded state at
 * some [[slide, alpha]]. Every surface therefore hands the mirror the SAME object
 * it hands its renderer, and sound and picture cannot disagree by construction.
 *
 * WHAT THIS REPLACED, because the shape is the fix: the mirror used to be driven by
 * a `$effect` inside web/CanvasView.svelte whose dependencies were `app.doc`,
 * `app.previewDelta` and `app.slideIndex`. Two consequences, both reported by the
 * user (R7-2, R7-4):
 *   - NO ALPHA REACHED IT, so a cutoff animated from one slide to the next stepped
 *     at the boundary instead of sweeping. There was no whoosh because there was no
 *     mid-transition value anywhere on the path.
 *   - PRESENT MODE NEVER RE-FIRED IT. web/PresentMode.svelte writes app.slideIndex
 *     only on exit and CanvasView stays mounted underneath it, so the engine was
 *     frozen at whatever slide the editor was on when Present started — for the
 *     whole presentation. Slide changes, per-slide patches and `active:false`
 *     deletions were all invisible to the engine.
 * There is now NO mode branch anywhere below this line: both surfaces call this one
 * function, and the only thing that differs is which frame each one is showing.
 *
 * Cheap when nothing audio-shaped changed, which is the common case by far: reading
 * the scene is a walk over the item map, and an unchanged scene diffs to zero ops,
 * so a node DRAG (which re-evaluates on every pointermove) and a presenter REPAINT
 * (which runs per rAF tick) both issue no engine calls at all. That is the property
 * that lets a patch keep playing while it is edited AND lets the presenter call this
 * every frame, which is what makes a tweened knob a glide.
 *
 * @param {object} state - the EVALUATED folded state for this frame ({items, vars})
 * @param {object} registry - the plugin registry
 */
export function mirrorAudioFrame(state, registry) {
  // MEASURED FIRST AND UNCONDITIONALLY, before any early return: the gap this pass
  // has to bridge is the gap since the previous PASS, so a pass that turns out to
  // have nothing to do still has to move the reading. Skipping it on quiet passes
  // would report the whole quiet stretch as one interval to the next real one.
  //
  // THE CEILING IS THE AUTHOR'S. cameraMaxTimestep reads the camera's `maxTimestep`
  // row off this very frame, so raising it to 0.3 or choosing "none" applies to the
  // audio ramp exactly as it applies to the simulation. A constant here would have
  // made that row half-apply, which is worse than not having it.
  const maxTimestep = cameraMaxTimestep(state ?? {});
  frameRamp = knobRampSeconds(frameTimestepSeconds(maxTimestep), maxTimestep);
  const scene = readAudioScene(state?.items ?? {}, registry);
  const count = Object.keys(scene.modules).length;
  audioState.moduleCount = count;

  if (count === 0 && Object.keys(engineScene.modules).length === 0) {
    // NOTHING TO DO AND NOTHING TO TEAR DOWN. The overwhelmingly common case (a
    // deck with no audio), and it must not construct an AudioContext.
    if (audioState.status === "idle" || audioState.status === "blocked") audioState.status = "idle";
    return;
  }
  if (audioState.status === "idle" && count > 0) audioState.status = "blocked";
  // A PATCH EXISTS AND THE CONTEXT IS SUSPENDED: take the next gesture rather than
  // asking for one. Idempotent, and it disarms itself the moment sound is running.
  // Not armed for a scene being TORN DOWN (count 0 with modules still in the
  // engine) — there would be nothing for the gesture to make audible.
  if (count > 0) armAudioGesture();

  const ops = diffAudioScene(engineScene, scene, frameRamp);
  if (ops.length === 0) {
    // THE TRANSPORT STILL HAS TO BE SYNCED HERE. Zero ops means the DOCUMENT said
    // nothing new — but the ENGINE may have started since the last pass (the first
    // gesture arrives long after the patch was built), and a scheduler that was
    // stopped when the context was suspended would never be started by anything.
    syncTransport(scene);
    return;
  }
  engineScene = scene;
  queueApply(ops, scene);
  syncTransport(scene);
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
      // THE SAME INTERVAL AS THE BATCH THIS REPAIRS. A re-issued setParam is the
      // same push arriving late, not a new one, so giving it a fresh (and, on this
      // path, always-zero) measurement would put the floor back exactly where a
      // slow frame needs the ramp widest.
      const followUp = diffAudioScene(reached, target, frameRamp);
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

// ── LIVE ANALYSIS DATA (the meter and spectrum displays) ─────────────────────
//
// THE SEAM, STATED PLAINLY. An analysis node's bouncing bar is LIVE AUDIO, which is
// not document state and cannot be: reading it inside a plugin's emit() would make
// Δt = 0 produce two different pictures, which breaks the determinism law, frame
// range sharding and export reproducibility at once (CLAUDE.md).
//
// That is UNCHANGED, and it is worth saying because the DRAWING changed completely
// (R7-5). What used to happen is that the plugin painted a static card and
// web/AudioOverlay.svelte painted the motion on top, in screen space, on a DOM
// canvas. The user rejected that: it drew above everything, it did not rotate, no
// export contained it, and — the symptom he named first — IT RESTARTED ON ZOOM,
// because the waterfall's history lived in that canvas's PIXELS and a resize resets
// a canvas's backing store.
//
// So the history is now DATA: this seam pushes one column of magnitudes per frame
// into render_gpu/gpu/live_analysis_registry.js, the node's own emit() draws those
// columns into the display list, and a zoom re-renders the same columns at a new
// size. The determinism law is honoured the same way `pdfDisplay` and `mapTiles`
// honour it — the columns reach emit() as a render-time ARGUMENT that only a
// surface with a running AudioContext supplies, never as a global and never from
// inside a plugin. A headless render is byte-identical to what it was.
//
// The push stays OUT of Svelte's reactivity, as it always was: these callbacks fire
// at rAF for every subscribed node, and routing them through runes would schedule a
// component update per frame per meter.

/** id → unsubscribe, for the modules whose analysis this mirror is watching. */
const analysisSubs = new Map();

/** Command. Subscribe to a module's live data, if it is an analysis node.
 *
 *  UNITS ARE CONVERTED HERE, at the one place that knows the engine's: the ring
 *  buffer is unit-free (magnitudes in 0..1), so the drawing never has to know
 *  whether a value arrived as an FFT byte or as dBFS. */
function subscribeAnalysis(id, module) {
  const kind = module?.spec?.overlay;
  if (!kind) return;
  unsubscribeAnalysis(id);
  if (kind === "meter") {
    analysisSubs.set(id, engine.subscribeMeter(id, (level) => pushAnalysisFrame(id, kind, meterColumnValues(level.db))));
  } else if (kind === "spectrum") {
    // THE ENGINE REUSES ITS BUFFER (NF-SYNTH's API note: "REUSED buffer — copy if
    // kept"). spectrumColumnValues reads it and returns a fresh Float32Array, which
    // pushColumn copies into the ring — so the reuse is respected without this seam
    // having to reason about lifetime at all. The per-frame allocation it does make
    // is one column, not one history.
    analysisSubs.set(id, engine.subscribeSpectrum(id, (bins) => pushAnalysisFrame(id, kind, spectrumColumnValues(bins))));
  }
}

/** Command. Drop a module's subscription and its history. A subscription that
 *  outlived its module would hold the callback and the buffer forever. */
function unsubscribeAnalysis(id) {
  const off = analysisSubs.get(id);
  if (off) { off(); analysisSubs.delete(id); }
  dropAnalysis(id);
}

// ── THE AUTOPLAY GATE ────────────────────────────────────────────────────────

/** The events a browser accepts as a genuine user activation, and the only ones
 *  this module listens for. `pointerdown` covers mouse, pen and touch — including
 *  a press on a Keyboard node's key, which is an ordinary pointerdown on the
 *  canvas — and `keydown` covers typing and every shortcut, so Present (entered by
 *  key or by a click on its button) is covered by whichever one the user used. */
const GESTURE_EVENTS = ["pointerdown", "keydown"];

/** Whether the one-shot gesture listeners are currently installed. Module scratch,
 *  not state: nothing renders it, and it must not be reactive or arming would
 *  schedule a component update. */
let gestureArmed = false;

/**
 * Command. Take the NEXT user gesture, whatever it is, and start audio with it.
 *
 * ── WHY THIS EXISTS INSTEAD OF A BUTTON ─────────────────────────────────────
 * The user's ruling is that being asked is the defect ("Never make me ask that
 * again"), not that the browser rule is wrong. A browser will not start an
 * AudioContext without a user activation, but it does not care WHICH activation —
 * so the correct answer is to spend one the user was making anyway. In practice
 * that is the first click on the canvas or the first key pressed, which for any
 * session that gets as far as looking at a patch has already happened.
 *
 * ONE-SHOT AND CAPTURE-PHASE: capture so a handler that stops propagation (present
 * mode's key dispatch does exactly this) cannot swallow it, and one-shot so the
 * listeners are gone the instant they are not needed. If the context did NOT start
 * — some browsers refuse an activation they consider spent — this re-arms, so the
 * next gesture tries again instead of the deck being permanently silent.
 *
 * Idempotent: arming twice installs one set of listeners.
 */
function armAudioGesture() {
  if (gestureArmed || audioState.status === "running" || audioState.status === "starting") return;
  gestureArmed = true;
  const onGesture = () => {
    for (const type of GESTURE_EVENTS) window.removeEventListener(type, onGesture, true);
    gestureArmed = false;
    enableAudio().then(() => { if (audioState.status !== "running") armAudioGesture(); });
  };
  for (const type of GESTURE_EVENTS) window.addEventListener(type, onGesture, true);
}

/**
 * Command. Start the audio context, and with it the shared transport.
 *
 * MUST be reached from a real user gesture the first time — that is a browser rule,
 * not ours. `armAudioGesture` is how that happens without asking; this stays
 * exported so a surface that IS a gesture (entering Present) can spend it directly
 * and so the failure badge can retry.
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
    audioState.reason = engine.isRunning() ? null : "the browser did not start the audio context — the next click or keypress will try again";
    // THE TRANSPORT CANNOT BE STARTED BEFORE THE CONTEXT IS: the scheduler places
    // events on the audio clock, which does not advance while suspended, so a
    // transport started early would dump its whole lookahead window at time zero.
    // This is the first moment it is legal, and the mirror's own pass covers every
    // later one.
    syncTransport(engineScene);
  } catch (e) {
    audioState.status = "failed";
    audioState.reason = e.message;
    reportOnce(`PowerRP: could not start audio — ${e.message}`);
  }
}

/** Command. Suspend the context without tearing the graph down, so re-enabling is
 *  instant and the patch survives.
 *
 *  NO CALLER TODAY, and worth knowing before you add one: the next gesture will
 *  turn sound back on, because a suspended context with a patch on screen is
 *  exactly the condition armAudioGesture exists to resolve. A real MUTE is a
 *  different feature — it needs document state saying so, which is what would stop
 *  the gesture harvest from undoing it. */
export async function disableAudio() {
  if (!engine) return;
  await engine.suspend();
  audioState.status = audioState.moduleCount > 0 ? "blocked" : "idle";
}

/**
 * Command. Bring the engine's SHARED TRANSPORT into line with the scene — tempo,
 * pattern length, and whether it runs at all.
 *
 * ── THIS FUNCTION REPLACES ONE THAT HAD ZERO CALLERS ────────────────────────
 * Its predecessor, `setTransportLive(live)`, was written to bind the transport to
 * the presentation clock's regime and was never called from anywhere in the repo;
 * `engine.scheduler.start()` was likewise never reached from app code. **The
 * Sequencer node had therefore never emitted a single step, in either mode.** A
 * shipped widget that does nothing is worse than an absent one, because the author
 * blames their patch.
 *
 * ── WHY IT NO LONGER BRANCHES ON THE PRESENTATION CLOCK ─────────────────────
 * The old design held the transport whenever `particleTime()` was frozen, so a
 * sequencer would step in Present and stand still in the editor. That is precisely
 * the editor/presentation split the user overruled this round ("the presentation
 * mode should be just the same audio as editor mode. There should be no
 * difference."), and it was never consistent with its neighbours anyway: an
 * oscillator drones in the editor today, because THE ENGINE IS A LIVE CONSUMER by
 * design (see this file's header). A sequencer is the same kind of thing and now
 * behaves the same way — it runs whenever there is sound.
 *
 * WHAT IS UNCHANGED, said plainly rather than implied: the transport is not
 * phase-locked to presentation time. Between calls the scheduler runs on the AUDIO
 * clock, which it must — the whole point of the two-clock lookahead is that a JS
 * timer cannot place a note accurately. So a sequence started twice at the same
 * presentation time is pattern-identical, not sample-identical. That is the same
 * live-consumer boundary the video PLAYER sits on, and closing it needs a
 * seek-capable transport in synth/scheduler.js, which today has start/stop/reset
 * and no cursor set.
 *
 * @param {object} scene - a readAudioScene result (the scene the engine holds)
 */
function syncTransport(scene) {
  if (!engine || !engine.isRunning()) return;
  const { bpm, stepCount } = transportOf(scene);
  // A null is "nothing on this slide declares it" — leave the scheduler's current
  // setting alone rather than inventing one (core/audio_mirror_diff.transportOf).
  if (bpm !== null) engine.scheduler.setTempo(bpm);
  if (stepCount !== null) engine.scheduler.setStepCount(stepCount);
  // NO MODULES MEANS NO TRANSPORT: an empty scene leaves a 25 ms timer ticking
  // forever with nothing subscribed to it.
  const wanted = Object.keys(scene.modules ?? {}).length > 0;
  if (wanted && !engine.scheduler.isRunning()) engine.scheduler.start();
  else if (!wanted && engine.scheduler.isRunning()) engine.scheduler.stop();
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
