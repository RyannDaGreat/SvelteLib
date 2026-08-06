/**
 * THE SIMULATION HISTORY — the ambient service behind SIMULATED STATE, the FOURTH
 * kind of state (manifest R7-9; PowerRP CLAUDE.md "The four kinds of state", which
 * this amends). It answers exactly two questions for the equation engine:
 *
 *   `@`   what did this property hold at the PREVIOUS simulation step?
 *   `dt`  how many seconds of simulation does the current step cover?
 *
 * and it is the TWIN of render_gpu/particle_clock.js: one module-level ambient
 * service, a PAUSED default, an opt-in live regime, and an override seam for the
 * exporters. It is deliberately shaped that way — a second service with a different
 * shape would be a second thing to reason about at every render seam.
 *
 * ── WHY THE FOURTH KIND EXISTS ────────────────────────────────────────────────
 * USER, 2026-08-06, verbatim: "we can have reserved variables @ (meaning prev
 * value), and @self.value means (previous self.value) … The user is responsible for
 * correctly using another reserved variable dt — so like if we set property rotation
 * to @+dt it means we rotate 1 degree every second from whatever it was previously."
 *
 * `dt` IS REAL ELAPSED TIME, ONE SIMULATION STEP PER RENDERED FRAME. Not a fixed
 * document-level timestep: a fixed step of 0.1s under a 1000 fps render would leave
 * 100 consecutive frames sitting between two steps, and the only ways out are visible
 * judder or interpolation — a fudge (USER: "What do we do, interpolate?"). Elapsed
 * time is also the only reading under which the user's own example holds at every
 * framerate: `@ + dt` is one degree per second at 30 fps (30 steps × 1/30) and at
 * 1000 fps (1000 steps × 0.001), and a higher framerate is a SMALLER step and so a
 * more accurate integration — which is what "we have a smaller time step, things
 * will integrate better" means.
 *
 * ── THE COSTS, STATED SO THEY ARE NOT DISCOVERED LATER ────────────────────────
 * `dt = 0` WHEN TIME IS NOT ADVANCING IS THE TRUTH, NOT A BUG. Every still renderer
 * (editor viewport, thumbnails, minimap, PNG export, cli/render.js) runs on the
 * PAUSED particle clock, where particleTime() is a constant — so no step is ever
 * taken and the picture is byte-identical on re-render. A frozen simulation does not
 * move. Nothing here fabricates a nonzero dt to avoid that, and `x / dt` throwing at
 * dt = 0 goes through the ordinary equation-error path: "the user is responsible for
 * correctly using dt", and a clamp or an epsilon here would be exactly the silent
 * fallback this project forbids.
 *
 * FRAME N GENUINELY DEPENDS ON FRAMES 0..N-1. Simulated state is NOT seekable, which
 * is the property recordable state has and this one deliberately gives up. A video
 * render must therefore walk frames IN ORDER: `cli/render_job.js` shards by STRIDED
 * frame range, and a strided shard cannot compute its own prefix. That refusal is
 * built as a predicate rather than left to a comment — see core/document.js
 * documentIsSimulated / stridedShardRefusal. (N browsers is N processes is N
 * independent copies of this table, which is exactly why CONTIGUOUS sharding works
 * and strided does not.)
 *
 * EXPORTS ARE EXACTLY REPRODUCIBLE; LIVE PLAYBACK IS APPROXIMATELY SO. Same document,
 * same frame sequence, same fps ⇒ identical output. A different fps gives a slightly
 * different trajectory, converging as fps rises. The user accepted this in the brief:
 * "While it's not perfectly predictable, it is very close to perfectly predictable,
 * which is why it's okay."
 *
 * ── THE TWO TABLES, AND WHY ONE IS NOT ENOUGH ─────────────────────────────────
 * `prev` is what `@` reads. `cur` is what the running pass writes. `prev ← cur` rolls
 * ONLY when the clock has moved, and `dt` is computed AT THE ROLL and reused by every
 * pass at that instant. So the answer is invariant to HOW MANY TIMES the state is
 * evaluated at one clock instant.
 *
 * THAT INVARIANCE IS MANDATORY, NOT TIDINESS. `app.nodes()` is an un-memoized full
 * deriveRenderTree and web/CanvasView.svelte alone calls it ~28 times per frame,
 * several from pointermove handlers (measured this round —
 * .frenzy/round7/powerrp_audio_map.md § E). With ONE table a dt-free simulated
 * property (`= @ * 0.9`, a decay) would advance 28 times per frame, and the count
 * would change with mouse movement. Two tables make it advance exactly once per
 * clock tick no matter how many consumers look. DO NOT "SIMPLIFY" THIS BACK TO ONE
 * TABLE.
 *
 * ── THE SCOPING INVARIANT: ONE ADVANCER, EVERYONE ELSE READ-ONLY ──────────────
 * The table is keyed by SLOT KEY (`items.<id>.rotation`, `vars.speed`) and is
 * therefore GLOBAL to the process, while the app has several concurrent evaluation
 * consumers sitting at DIFFERENT slides (the canvas, a slide thumbnail, the minimap).
 * The invariant is:
 *
 *   EXACTLY ONE CONSUMER PER PROCESS MAY ADVANCE THE SIMULATION. EVERY OTHER
 *   CONSUMER IS READ-ONLY: it reads `prev`, renders the current step, and WRITES
 *   NOTHING.
 *
 * Read-only is not "dt is 0, so the write is harmless" — a dt-FREE equation still
 * computes f(prev) at dt = 0, and a thumbnail of slide 5 writing that value into the
 * slot the editor's timeline owns would be inherited by the next roll. Hence
 * withSimulationFrozen(), which makes a pass structurally unable to write, and which
 * every still consumer that can run WHILE the presenter's clock is live must use.
 * (In the paused regime the clock cannot move, so no roll is possible and a still
 * consumer is safe without doing anything; the seam is for the overlap case.)
 *
 * A VIOLATION IS LOUD, NOT SILENT: recordSimulationValue reports when two passes at
 * the SAME tick write DIFFERENT values to one key, which is precisely two timelines
 * blending. There is no timeline component in the key because there is no second
 * timeline: a presentation is one clock, and a second independent timeline would need
 * a second particle clock first.
 *
 * ── THE RESET RULE (explicit, because an ill-defined reset diverges silently) ──
 * History resets — `@` falls back to the AUTHORED initial condition — when:
 *   1. TIME MOVES BACKWARDS (`now < lastAdvanceTime`): scrubbing back, leaving
 *      present mode, restarting a presentation. Integrating a negative step is not a
 *      reset, it is a wrong answer that looks plausible, so it is never done.
 *   2. resetSimulation() is called explicitly: document load, jump-to-start, the
 *      start of a presentation or a render job.
 * After a reset the next pass has no previous value and takes dt = 0, so the frame it
 * renders IS the initial condition.
 *
 * ── THE MAX TIMESTEP (camera setting, USER 2026-08-06) ────────────────────────
 * "We can set a max timestep in the camera, under some settings, which can be none or
 * .1 seconds etc to prevent extreme lag spikes from driving it crazy." A GC pause, a
 * tab switch or a debugger breakpoint otherwise hands the integrator a multi-second
 * dt and the pendulum leaves the slide.
 *
 * THE CLAMPED TIME IS DISCARDED, NOT CAUGHT UP. After a hitch the simulation is
 * deliberately a little behind wall-clock. There is no substepping to recover the
 * lost interval, and adding some would be the classic death spiral: a slow frame
 * schedules extra work and produces an even slower frame. Falling behind is the
 * correct failure mode.
 *
 * IT APPLIES TO MEASURED TIME ONLY, AND THAT IS NOT A MODE BRANCH. A measured dt is
 * an OBSERVATION of how long a frame took, so a lag spike is a lie about elapsed
 * simulation time and the clamp corrects a measurement error. An export DICTATES
 * `dt = 1/fps` through setSimulationTimestepOverride — a different input, not the same
 * input with a flag — and a dictated step never reaches the clamp because there is no
 * measurement to correct. R7-2 forbids a mode branch on the playback path; this has
 * none.
 */

import { reportOnce } from "./report.js";
// THE ONE PRESENTATION CLOCK. core/ → render_gpu/ is established and
// particle_clock.js is DOM-free bare-node code by its own contract, which is the
// same justification core/expressions.js records for the same import.
import { particleTime, isParticleClockPaused } from "../render_gpu/particle_clock.js";

/** The camera property holding the max measured timestep, in SECONDS, or `null`
 *  for no clamp. It lives on THE CAMERA because the camera is the mandatory
 *  singleton that already owns the document's global view settings, and the user
 *  named it as this setting's home. Declared HERE rather than in core/document.js
 *  (which is where defaultCameraState lives) because core/expressions.js reads it
 *  and cannot import document.js — document.js imports expressions.js, and that
 *  edge is one-way. */
export const CAMERA_MAX_TIMESTEP_KEY = "maxTimestep";

/** 0.1 s — a tenth of a second of simulation is the most one displayed frame may
 *  claim to cover. Below a hitch (a 60 Hz frame is 0.017 s) so it never engages in
 *  normal playback, and small enough that the worst single step a lag spike can take
 *  is one an explicit integrator survives. `null` disables the clamp entirely (the
 *  row is nullable — NULLABLE_ROW_KINDS, core/properties.js). */
export const CAMERA_MAX_TIMESTEP_DEFAULT = 0.1;

/** What `@` reads: each recorded slot's value at the PREVIOUS step. */
let prevValues = new Map();
/** What the running pass writes: each recorded slot's value at the CURRENT step.
 *  SEEDED FROM `prev` at each roll, so a slot no pass touched this step keeps its
 *  last known value instead of being blanked. */
let curValues = new Map();
/** The keys actually WRITTEN this step — `cur` cannot answer that, because the roll
 *  pre-seeds it from `prev`. This is what makes the two-consumers-disagreeing check
 *  above a real detector rather than a false alarm on every ordinary second pass. */
let writtenThisStep = new Set();
/** The clock reading (seconds) at the last HISTORY ROLL, or null before the first
 *  simulated pass. Distinct from lastObservedTime below: rolling is a state ADVANCE
 *  that only a simulated document does, and measuring the frame interval is an
 *  OBSERVATION every consumer may make. Conflating them is what made the interval
 *  unreadable on a deck with no `@` in it. */
let lastAdvanceTime = null;
/** The clock reading (seconds) the CURRENT timestep was measured from, or null
 *  before the first observation. */
let lastObservedTime = null;
/** The seconds the CURRENT SIMULATION STEP covers — measured at a roll, from
 *  lastAdvanceTime, and reused by every pass at that instant, which is what makes the
 *  answer evaluation-count invariant. */
let stepDt = 0;
/** The seconds since the previous OBSERVED instant — what simulationTimestep answers.
 *
 *  IT IS A DIFFERENT GAP FROM stepDt, and deliberately so. They coincide whenever both
 *  happen every tick, which is the normal case; they diverge when the simulation skips
 *  a tick another consumer observed, and then each is still right about its OWN
 *  question ("how long since the previous parameter push" vs "how long since the
 *  previous simulation step"). Measuring the roll from the observation would let any
 *  consumer starve the simulation of elapsed time by looking at the clock first. */
let observedDt = 0;
/** Bumped by every roll and every reset — the equation memo's second invalidation
 *  axis (core/expressions.evaluateState). `clock` alone is not enough: an explicit
 *  reset changes every `@` without moving the clock. */
let generation = 0;
/** READ-ONLY depth. Nonzero ⇒ this pass may not roll and may not write `cur`. */
let frozenDepth = 0;
/** An EXPORT's dictated timestep in seconds (1/fps), or null when dt is MEASURED. */
let dictatedSeconds = null;

/**
 * Pure function. The timestep a measured elapsed interval is allowed to claim:
 * `elapsed`, clamped to `maxTimestep` when one is set. A null/undefined
 * `maxTimestep` means NO CLAMP (the camera row's "none").
 *
 * Args:
 *   elapsed (number): measured seconds since the previous step (≥ 0)
 *   maxTimestep (number|null): the camera's clamp in seconds, or null for none
 *
 * Returns:
 *   number: the seconds this step covers
 *
 * @example clampedTimestep(0.016, 0.1) // 0.016 (an ordinary 60 Hz frame is untouched)
 * @example clampedTimestep(3.4, 0.1) // 0.1 (a tab-switch hitch cannot move the sim 3.4 s)
 * @example clampedTimestep(3.4, null) // 3.4 (clamp disabled — the author asked for raw elapsed)
 */
export function clampedTimestep(elapsed, maxTimestep) {
  return maxTimestep == null ? elapsed : Math.min(elapsed, maxTimestep);
}

/**
 * Command (rolls the history tables; mutates module state). Opens a simulation step
 * at clock reading `now` and returns the `dt` every equation in this pass must see.
 *
 * Rolls `prev ← cur` and recomputes `dt` ONLY when the clock has advanced since the
 * last roll; a second pass at the same instant gets the identical `dt` and the
 * identical `prev`, which is the evaluation-count invariance the docblock explains.
 * Time moving BACKWARDS resets instead of integrating a negative step. A frozen pass
 * never rolls.
 *
 * Args:
 *   now (number): the presentation clock in seconds (render_gpu/particle_clock.particleTime)
 *   maxTimestep (number|null): the camera's clamp on a MEASURED step, or null
 *
 * Returns:
 *   number: the seconds this step covers (0 on the first pass, after a reset, and
 *   whenever the clock has not moved)
 *
 * @example // resetSimulation(); beginSimulationStep(0, 0.1) // 0 — the first frame is the initial condition
 * @example // then beginSimulationStep(0.5, 0.1) // 0.5 — half a second of simulation
 * @example // then beginSimulationStep(0.5, 0.1) // 0.5 again — same instant, same step, no second roll
 * @example // then beginSimulationStep(9.9, 0.1) // 0.1 — a hitch is clamped, and the lost time is DISCARDED
 * @example // then beginSimulationStep(0.2, 0.1) // 0 — time went backwards: reset to the initial condition
 */
export function beginSimulationStep(now, maxTimestep) {
  if (frozenDepth > 0) return stepDt; // read-only: renders the current step, cannot advance it
  // A PAUSED CLOCK CANNOT PRODUCE AN INTERVAL, so the step is 0 by definition rather
  // than by the arithmetic happening to come out that way. Tracking `now` keeps the
  // next live reading from measuring against a stale instant. See observeClock.
  if (isParticleClockPaused()) {
    lastAdvanceTime = now;
    stepDt = 0;
    return 0;
  }
  if (lastAdvanceTime !== null && now < lastAdvanceTime) resetSimulation();
  if (lastAdvanceTime === null) {
    lastAdvanceTime = now;
    stepDt = 0;
  } else if (now > lastAdvanceTime) {
    stepDt = dictatedSeconds ?? clampedTimestep(now - lastAdvanceTime, maxTimestep);
    // Carried forward, not emptied: a slot no pass touched this step keeps its last
    // known value, so a consumer that skips a slide does not blank the history of
    // every slot on it.
    prevValues = curValues;
    curValues = new Map(prevValues);
    writtenThisStep = new Set();
    lastAdvanceTime = now;
    generation++;
  }
  return stepDt;
}

/**
 * Command (updates the observed instant; no history roll). The seconds between the
 * previous clock instant and `now` — measured ONCE per instant and then reused, so
 * every consumer that asks at one instant is told the same number.
 *
 * MEASURING IS NOT ADVANCING, and separating the two is the point: the history rolls
 * only for a document that actually reads `@`, while the FRAME INTERVAL is a fact
 * about the clock that any consumer may need (an audio ramp, a meter) whether or not
 * anything is simulated.
 *
 * ITS ONE CALLER IS simulationTimestep. An earlier draft of this line claimed
 * beginSimulationStep called it too "so both can never disagree" — that was written
 * for a draft where the two shared one measurement, and sharing was REMOVED on
 * purpose (see observedDt: it would let any consumer starve the simulation by reading
 * the clock first). The code was right and the sentence was the defect.
 *
 * A frozen consumer MAY observe: it is reading a measurement, not advancing state.
 */
function observeClock(now, maxTimestep) {
  // THE PAUSED REGIME HAS NO INTERVALS. Every still consumer runs here, the clock is
  // fixed by contract, and a number measured across a REGIME CHANGE into it would then
  // be reported forever, because nothing ever displaces it: measured 2026-08-06,
  // presenting and leaving within EDITOR_FREEZE_TIME is a FORWARD jump into the freeze,
  // and every editor audio ramp afterwards was pinned at the clamp for the life of the
  // page. Answering 0 here makes "a frozen clock means dt = 0" structural instead of
  // incidental, and it is why the fix is a REGIME question rather than a bigger-than-a-
  // -frame heuristic: a genuine lag spike still clamps and still advances, which is what
  // the camera setting was asked for.
  if (isParticleClockPaused()) {
    lastObservedTime = now;
    observedDt = 0;
    return 0;
  }
  if (lastObservedTime === null || now < lastObservedTime) {
    lastObservedTime = now;
    observedDt = 0;
  } else if (now > lastObservedTime) {
    observedDt = dictatedSeconds ?? clampedTimestep(now - lastObservedTime, maxTimestep);
    lastObservedTime = now;
  }
  return observedDt;
}

/**
 * Query→value (observes the clock; never rolls the history). THE ONE ANSWER TO "HOW
 * LONG IS THIS FRAME?" in seconds — dictated by an export when one is running,
 * otherwise the measured interval since the previous instant, clamped.
 *
 * WHY IT EXISTS SEPARATELY FROM beginSimulationStep: that one is reached lazily, only
 * when an equation actually reads `@` or `dt`, so on a deck with no simulated state
 * it never runs. It also measures a DIFFERENT GAP — see observedDt: this one is "how
 * long since the previous look at the clock", the step is "how long since the previous
 * simulation step", and they only coincide while both happen every tick. A consumer that needs the frame interval REGARDLESS — an audio
 * parameter ramp is the first — would otherwise measure it a second time, and two
 * independent measurements of one physical quantity is the mirror-drift failure this
 * codebase keeps paying for. Cheap and allocation-free, so calling it every frame
 * from several consumers is fine.
 *
 * IT ANSWERS FOR THE PRESENTATION CLOCK, AND ONLY THAT. A consumer scheduled against
 * a DIFFERENT clock — the Web Audio context's `currentTime`, which keeps running when
 * presented time is frozen in the editor — must keep its own reading for that clock.
 * Those are two genuinely different clocks, not one concept spelled twice; do not
 * "unify" them.
 *
 * @param {number|null} maxTimestep - the resolved clamp (cameraMaxTimestep(state)),
 *   or null for none. Pass the DOCUMENT's value, not the default: a settings row that
 *   only half-applies is an inert control.
 * @returns {number} seconds
 *
 * @example // in the paused editor the clock does not move, so simulationTimestep(0.1) === 0
 * @example // under a 60 fps export override, simulationTimestep(0.1) === 1/60 (dictated, unclamped)
 */
export function simulationTimestep(maxTimestep) {
  return observeClock(particleTime(), maxTimestep);
}

/**
 * Pure function. THE CAMERA's max simulation timestep for a folded state, in
 * seconds, or null for "none" (no clamp).
 *
 * ABSENT ≡ NULL ≡ NONE, and that is the `nullable` row convention verbatim
 * (core/properties.js, THE `nullable` ROW ASPECT): "a nullable row's stored ABSENCE
 * may be `undefined` (never written) or `null` (cleared); both display as unset".
 * They must therefore also READ as unset — the Inspector's clear affordance writes
 * `null`, which is the fold's DELETE SENTINEL and lands as an ABSENT leaf, so a
 * reader that resolved absent to the default made "none" literally inexpressible
 * through the UI (measured, 2026-08-06).
 *
 * NO DEFAULT IS APPLIED HERE, and that is not the same as having no safe default.
 * The 0.1 s clamp reaches every real document as a BORN-WITH VALUE — `defaultCameraState`
 * writes it, and `repairedDocument`'s defaults-fill backfills it into any document
 * written before the setting existed — so absence survives only where the author
 * cleared it, or in a hand-built state fragment that has no camera and therefore no
 * setting to read. Compare `plugins/camera.naturalZoomOn`, where ABSENT IS ON: that
 * row is a BOOLEAN with two states and no "unset", so absent can only mean its
 * default. This one is nullable, so absent is a third thing and means it.
 *
 * IT LIVES HERE, NOT IN THE EQUATION ENGINE, so a consumer that must not depend on
 * core/expressions.js can still honour the AUTHOR's value rather than assuming the
 * default (`core/audio_mirror_diff.js` is the first: expressions → derive → plugins →
 * audio_nodes would close a cycle). This module imports core/report.js and the clock
 * and nothing else, so anyone can read it.
 *
 * AN EQUATION HERE CANNOT BE HONOURED and says so: the clamp is needed BEFORE the
 * pass that would evaluate it, so a `=` in this slot falls back to the default and is
 * reported rather than silently disabling the protection.
 *
 * @param {object} state - a folded or evaluated state ({items, vars})
 * @returns {number|null} seconds, or null for no clamp
 *
 * @example cameraMaxTimestep({items: {c1: {type: "camera", maxTimestep: 0.25}}}) // 0.25
 * @example cameraMaxTimestep({items: {c1: {type: "camera", maxTimestep: null}}}) // null (the author chose "none")
 * @example cameraMaxTimestep({items: {c1: {type: "camera"}}}) // null (cleared — the leaf is absent, which IS "none")
 * @example cameraMaxTimestep({items: {}}) // null (no camera, so no setting to read)
 */
export function cameraMaxTimestep(state) {
  for (const item of Object.values(state.items ?? {})) {
    if (item?.type !== "camera") continue;
    const value = item[CAMERA_MAX_TIMESTEP_KEY];
    if (typeof value === "number") return value;
    if (value === null || value === undefined) return null; // cleared, or never written — both are "none"
    const message = `the camera's ${CAMERA_MAX_TIMESTEP_KEY} is ${JSON.stringify(value)} — the simulation clamp is read before equations are evaluated, so it cannot be one; using the ${CAMERA_MAX_TIMESTEP_DEFAULT}s default`;
    reportOnce(message, `PowerRP simulation: ${message}`);
    return CAMERA_MAX_TIMESTEP_DEFAULT;
  }
  return null; // no camera at all: nothing declares a clamp
}

/**
 * Query. Has `slotKey` a previous value — i.e. is this NOT the first step of its
 * simulation? A false answer is what sends `@` to the authored initial condition.
 *
 * @example // resetSimulation(); hasSimulationValue("vars.theta") // false
 */
export function hasSimulationValue(slotKey) {
  return prevValues.has(slotKey);
}

/**
 * Query. The value `slotKey` held at the previous step, or undefined when it has
 * none. Callers must ask hasSimulationValue first — undefined is a legal recorded
 * value in an any-type slot, so it is not a usable sentinel.
 *
 * @example // recordSimulationValue("vars.theta", 3); after a roll, simulationValue("vars.theta") // 3
 */
export function simulationValue(slotKey) {
  return prevValues.get(slotKey);
}

/**
 * Command (writes the CURRENT step's table; reports a scoping violation loudly).
 * Records what `slotKey` evaluated to this step, so the next step's `@` can read it.
 * A FROZEN pass writes nothing — see the scoping invariant.
 *
 * TWO PASSES AT ONE TICK WRITING DIFFERENT VALUES TO ONE KEY IS THE VIOLATION, and
 * it is reported rather than merged: it means two consumers sitting at different
 * slides are both advancing, and the next roll would hand the winner's number to the
 * loser's timeline. Same value from both is the ordinary case (the same slot
 * evaluated twice) and says nothing.
 *
 * @example // recordSimulationValue("items.a1.rotation", 12.5) — the next step's `@` reads 12.5
 */
export function recordSimulationValue(slotKey, value) {
  if (frozenDepth > 0) return;
  if (writtenThisStep.has(slotKey)) {
    const already = curValues.get(slotKey);
    if (already !== value && !(Number.isNaN(already) && Number.isNaN(value))) {
      const message = `simulated slot "${slotKey}" was advanced twice in one step, to ${JSON.stringify(already)} and then ${JSON.stringify(value)} — two evaluation consumers are advancing the simulation from different states; every consumer but one must run inside withSimulationFrozen()`;
      reportOnce(message, `PowerRP simulation: ${message}`);
    }
  }
  curValues.set(slotKey, value);
  writtenThisStep.add(slotKey);
}

/**
 * Query. The current history generation — bumped by every roll and every reset. THE
 * EQUATION MEMO'S SECOND INVALIDATION AXIS: a simulated result is only reusable while
 * this still matches (core/expressions.evaluateState).
 *
 * @example // simulationGeneration() is a non-negative integer that never decreases within a run
 */
export function simulationGeneration() {
  return generation;
}

/**
 * Command. Drops all history and forgets the clock, so the next pass takes dt = 0 and
 * every `@` falls back to its authored initial condition. Bumps the generation, which
 * is what invalidates the equation memo without the clock having moved.
 *
 * WHO CALLS IT: a document load, a jump to the start, the start of a presentation or
 * of a render job. Also called automatically when the clock moves BACKWARDS.
 *
 * @example // resetSimulation(); hasSimulationValue("anything") // false
 */
export function resetSimulation() {
  prevValues = new Map();
  curValues = new Map();
  writtenThisStep = new Set();
  lastAdvanceTime = null;
  lastObservedTime = null;
  stepDt = 0;
  observedDt = 0;
  generation++;
}

/**
 * Command. Runs `fn` with the simulation READ-ONLY: it cannot roll and cannot record,
 * so it renders the current step and leaves the timeline exactly as it found it.
 * Re-entrant (a depth counter), and the depth is restored even if `fn` throws.
 *
 * EVERY STILL CONSUMER THAT CAN RUN WHILE THE PRESENTER'S CLOCK IS LIVE MUST USE
 * THIS — a thumbnail, the minimap, a PNG export. In the paused regime the clock
 * cannot move, so a still consumer is already safe; this is the seam for the overlap.
 *
 * @param {Function} fn - the render/evaluate work to run read-only
 * @returns {*} whatever `fn` returns
 *
 * @example // withSimulationFrozen(() => renderThumbnail(doc, 5)) — renders, records nothing
 */
export function withSimulationFrozen(fn) {
  frozenDepth++;
  try {
    return fn();
  } finally {
    frozenDepth--;
  }
}

/** Query. Is the simulation currently read-only? (Introspection; tests.)
 *  @example isSimulationFrozen() // false by default */
export function isSimulationFrozen() {
  return frozenDepth > 0;
}

/**
 * Command. DICTATES the timestep — the export seam, and the twin of
 * setParticleTimeOverride. A video render's `dt` is definitional (`1/fps`), not an
 * observation, so it never passes through the max-timestep clamp; passing null
 * returns the simulation to MEASURED time.
 *
 * The exporter sets this beside the time override it already sets per frame
 * (web/videoExport.createFrameSampler), so an export and the presenter differ in
 * WHICH INPUT they supply, never in a branch on the playback path.
 *
 * @example // setSimulationTimestepOverride(1 / 60) — every step is exactly 1/60 s
 * @example // setSimulationTimestepOverride(null) — back to measured elapsed time
 */
export function setSimulationTimestepOverride(seconds) {
  dictatedSeconds = seconds;
}

/**
 * Query. A serializable CHECKPOINT of the whole simulation — the shape a contiguous
 * render shard would carry so a worker can resume a trajectory instead of walking it
 * from frame 0.
 *
 * NOTHING CACHES THESE YET. The seam exists because the alternative to designing for
 * it is discovering, the day a long deck is rendered, that resuming is impossible
 * without changing this module's shape.
 *
 * @returns {{prev: Array, cur: Array, lastAdvanceTime: number|null, dt: number}}
 *
 * @example // const cp = simulationSnapshot(); … ; restoreSimulationSnapshot(cp)
 */
export function simulationSnapshot() {
  return {
    prev: [...prevValues],
    cur: [...curValues],
    lastAdvanceTime,
    dt: stepDt,
  };
}

/**
 * Command. Restores a checkpoint from simulationSnapshot, bumping the generation so
 * the equation memo cannot serve a result from the trajectory this replaced.
 *
 * @example // restoreSimulationSnapshot(simulationSnapshot()) is a no-op except for the generation
 */
export function restoreSimulationSnapshot(snapshot) {
  prevValues = new Map(snapshot.prev);
  curValues = new Map(snapshot.cur);
  writtenThisStep = new Set();
  lastAdvanceTime = snapshot.lastAdvanceTime;
  lastObservedTime = snapshot.lastAdvanceTime;
  stepDt = snapshot.dt;
  observedDt = snapshot.dt;
  generation++;
}
