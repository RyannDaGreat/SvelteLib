/**
 * EDITOR ANIMATION — runs THE PRESENTATION CLOCK while you are still authoring, so
 * a simulated widget MOVES in the editor instead of sitting on its initial
 * condition. Off by default; one registry entry turns it on.
 *
 * ── WHY IT EXISTS (the user's report, 2026-08-06, verbatim) ───────────────────
 * *"Right now btw I tried making spring motion in the vars with like
 * self.vars.p=@self.vars.p+@self.vars.v and self.vars.v=@self.vars.v+@self.vars.a
 * etc but it didnn't animate - are the vars even listening to updates?"*
 *
 * THE VARS WERE LISTENING FINE. Measured in bare node and then in a real browser
 * (.frenzy/round7/w_sim/): with the clock driven, a document-level `@` var and a
 * per-item `@self.vars.*` var both integrate correctly, and the shipped double
 * pendulum swings. What did not move was THE CLOCK: outside a presentation
 * `particleTime()` is the fixed EDITOR_FREEZE_TIME (render_gpu/particle_clock.js's
 * PAUSED regime), so `beginSimulationStep` returns 0 and never rolls the history
 * (core/simulation_history.js) — `@` reads the initial condition forever, at every
 * frame, with no error to notice. **A frozen simulation and a broken one look
 * identical, which is why the report was about `@` and the cause was the clock.**
 *
 * ── WHY IT IS A TOGGLE AND NOT SIMPLY ON ──────────────────────────────────────
 * The paused regime is not an oversight; it is what makes every STILL in this app
 * byte-reproducible (a slide thumbnail, the minimap, a PNG export, cli/render.js —
 * see particle_clock.js's header). Turning the clock on unconditionally would make
 * the editor's own picture a function of wall-clock time, which is the Δt = 0 law
 * in PowerRP CLAUDE.md § "The three kinds of state". So this is opt-in, per
 * session, and OFF is exactly the behaviour that shipped before it existed.
 *
 * IT IS NOT SIMULATION-SPECIFIC, deliberately. It runs the ONE clock, so
 * everything time-driven wakes up together: `@`/`dt` simulated state, `= time`
 * equations, particle emitters, the cursor spin, a trail's ring. A second
 * "simulate only" regime would be a second answer to "what time is it", which is
 * the mirror-drift failure this codebase keeps paying for.
 *
 * ── THE PRESENTER OWNS THE CLOCK WHEN IT IS RUNNING ───────────────────────────
 * web/PresentMode.svelte calls startParticleClock() on mount and
 * stopParticleClock() on exit, and CanvasView STAYS MOUNTED behind it. So this
 * loop STANDS ASIDE while presenting (`presenting()` true): it neither touches the
 * clock nor wakes the editor's paint. Two reasons, and the second is the load-bearing
 * one — the editor may be parked on a DIFFERENT SLIDE from the presentation, and two
 * evaluation passes advancing one history table from different states is precisely
 * the violation core/simulation_history.recordSimulationValue reports.
 *
 * ON RETURN FROM A PRESENTATION the clock has been stopped under us, so the tick
 * re-claims it — which re-bases `t` to 0 and therefore RESTARTS the preview from the
 * initial condition. That is the documented reset rule, not an accident: history
 * resets when time moves backwards.
 */

import { startParticleClock, stopParticleClock, isParticleClockLive } from "../render_gpu/particle_clock.js";
import { resetSimulation, isSimulationTimestepDictated } from "../core/simulation_history.js";

/**
 * The reactive flag every surfacing reads — the same module-level `$state` store
 * shape web/audioMirror.svelte.js's `audioState` established, and for the same
 * reason: the state lives with the command that changes it, so a toolbar button and
 * the palette cannot disagree about whether it is on.
 */
export const editorAnimationState = $state({ running: false });

/** The rAF handle while the loop runs, else null. */
let raf = null;
/** Query→boolean supplied by whoever started the loop: is a presentation running?
 *  Held rather than reading `app` so this module needs nothing from the app object
 *  but the one fact it cannot know. */
let presenting = () => false;
/** Subscribers woken on every tick (the editor's paint). */
const listeners = new Set();

/**
 * Command (drives the ambient clock; wakes subscribers). One tick: claim the clock
 * if the presenter has not, then wake every subscriber. Reschedules itself.
 */
function tick() {
  raf = requestAnimationFrame(tick);
  if (presenting()) return; // the presenter owns the clock and its own repaint loop
  // AN EXPORT OWNS THE TRAJECTORY FRAME BY FRAME, so this loop stands aside for the
  // same reason it does for the presenter, and the consequence is worse: an MP4
  // export runs from the EDITOR (mode is still "edit"), it dictates `dt` and drives
  // `t` per sub-frame, and the editor is parked on ONE slide while the export walks
  // all of them. A repaint interleaved into that evaluates a DIFFERENT frame at the
  // export's own instant and writes its numbers into the same history slots — so the
  // damage lands in the VIDEO, which is the silently-wrong output this project
  // forbids. (The hazard predates this file: any incidental editor repaint during an
  // in-browser export could do it. What a per-frame loop changes is that it would go
  // from rare to certain.)
  if (isSimulationTimestepDictated()) return;
  if (!isParticleClockLive()) startParticleClock(); // first tick, or a return from Present
  for (const listener of listeners) listener();
}

/**
 * Command. Starts or stops the editor's animation clock, resetting the simulation
 * either way so a run always begins — and ends — at the authored initial condition.
 *
 * @param {function} isPresenting - Query→boolean: is a presentation running?
 * @param {boolean} next - true to run the clock in the editor
 *
 * @example // setEditorAnimation(() => app.mode === "present", true) — the pendulum starts swinging
 */
export function setEditorAnimation(isPresenting, next) {
  presenting = isPresenting;
  if (next === editorAnimationState.running) return;
  editorAnimationState.running = next;
  resetSimulation();
  if (next) {
    raf = requestAnimationFrame(tick);
    return;
  }
  cancelAnimationFrame(raf);
  raf = null;
  stopParticleClock(); // back to the PAUSED freeze: every still is byte-reproducible again
  // ONE LAST WAKE, and it is not tidiness. MEASURED (.frenzy/round7/w_sim/diag_stale_frame.mjs):
  // without it the canvas kept the LAST LIVE FRAME after the toggle went off — a
  // mid-swing pose that then held indefinitely, because the editor's paint is reactive
  // and nothing had invalidated it. Repeated screenshots agreed with each other, so it
  // read as a correct frozen still and was not one; forcing any unrelated repaint
  // snapped it back to the initial condition, byte-for-byte. Stopping the clock is a
  // change to what the frame SHOWS, so it has to wake the paint like every other one.
  for (const listener of listeners) listener();
}

/**
 * Command. Subscribes `listener` to every editor animation tick; returns the
 * unsubscriber, which is the shape web/CanvasView.svelte's other "something
 * arrived, repaint" hooks already take (onImageLoad, onAnalysisFrame).
 *
 * @param {function} listener - called once per animation frame while the clock runs
 * @returns {function} unsubscribe
 *
 * @example // $effect(() => onEditorAnimationFrame(() => (imageEpoch += 1)))
 */
export function onEditorAnimationFrame(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * THE EDITOR ANIMATION COMMAND — one registry entry, every surfacing (palette,
 * tool pane, a future toolbar button) for free, per the house law that those are
 * views of ONE action layer.
 *
 * DECLARED HERE rather than inline in web/App.svelte's `coreCommands` because the
 * state it toggles lives in this module — the standing AUDIO_MUTE_COMMAND
 * precedent (web/audioMirror.svelte.js), which App.svelte spreads in the same way.
 *
 * GATED ON NOT PRESENTING, because a presentation already runs the clock: the
 * command would be inert there, and an inert control is the thing this project
 * forbids shipping. Shown DISABLED with that reason rather than hidden, per
 * core/commands.js's availability rule.
 */
export const EDITOR_ANIMATION_COMMAND = {
  id: "toggle-editor-animation",
  title: "Toggle Editor Animation",
  icon: "mdi:motion-play-outline",
  // NOT "pendulum" AND NOT "physics", though both were measured to rank this entry
  // first for them. Those words name a THING TO INSERT, not a viewing mode, and an
  // alias that outranks the noun it borrowed is a land-grab — the same defect as
  // #301's "select all of kind" outranking Select All for its own name. Everything
  // here describes what the toggle itself does.
  aliases: ["animate in editor", "play", "preview animation", "run the clock", "simulate", "particles", "live editor"],
  when: (a) => a.mode !== "present",
  requires: "the editor — a presentation already runs the clock",
  help: "Runs the presentation clock while you author, so anything time-driven MOVES on the editor canvas: simulated properties (= @ + dt), = time equations, particles and trails. It is a viewing preference, not document state — nothing about the document changes, and turning it off returns the canvas to the frozen first frame, which is what keeps a thumbnail or a PNG export byte-reproducible.",
  run: (a) => setEditorAnimation(() => a.mode === "present", !editorAnimationState.running),
};
