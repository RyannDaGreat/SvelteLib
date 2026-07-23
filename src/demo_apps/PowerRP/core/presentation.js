/**
 * Presentation playback. The ONLY state tracked while presenting is the
 * ordered list of [slideId, alpha] pairs (per the manifest); since V1 decks
 * are linear that reduces to {index, alpha} — slides 0..index-1 at alpha 1,
 * slide `index` at `alpha`, later slides at 0.
 *
 * Transition triggers (user question, 2026-07-14): V1 = arrow keys, plus an
 * optional per-slide `autoAdvance` (seconds to linger AFTER the tween into
 * that slide completes before self-advancing — the linear-deck version of
 * Lab-In-A-Cube's `transitions.auto` chaining). Conditional/interactive
 * triggers are V2+.
 */

import { ease } from "./interpolators.js";
import { resolveTransition } from "./transitions.js";

/** Command (throws). The default frame scheduler: refuses loudly. An animated
 * transition needs a real frame clock, which is a HOST concern (rAF in the
 * browser) — core/ stays scheduler-agnostic and DOM-free, so a caller that
 * wants animation MUST inject one. Reaching this means the animated path ran in
 * an environment (bare node) with no scheduler passed — a bug, not a silent
 * no-op. The instant path (seconds 0 / slide 0) never calls it, so bare-node
 * instant-transition callers may omit the scheduler. */
function noFrameScheduler() {
  throw new Error(
    "createPresenter: an animated transition needs a frame scheduler — pass requestFrame (browser: requestAnimationFrame) + cancelFrame as args. Core stays scheduler-agnostic (DOM-free); the instant path needs no scheduler.",
  );
}

/**
 * @param getDoc  () → the live document.
 * @param onFrame (frame) → paints {index, alpha, transition}.
 * @param onTransitionStart (transition) → OPTIONAL side-effect seam fired ONCE
 *   at the instant a transition begins animating INTO a slide (not per alpha
 *   frame). This is where a DOM owner (web/PresentMode.svelte) plays a
 *   transition's SOUND — audio lives on the DOM side so core/ stays DOM-free
 *   and the CLI never emits sound (the SPARKLER RULE: sounds are playback-only,
 *   never rendered; a headless render has no speaker and needs none). Absent in
 *   node/tests → no-op (sound is a browser-only concern).
 * @param requestFrame (tickCallback) → handle. The injected FRAME SCHEDULER,
 *   with requestAnimationFrame's contract: it calls `tickCallback(now)` with a
 *   timestamp and returns a handle for cancelFrame. Kept out of core so
 *   core/presentation.js runs in BARE NODE (the manifest's "core runs in bare
 *   node" rule) — the browser injects rAF; a headless/test caller can inject a
 *   synchronous clock or omit it entirely for instant-only playback. Defaults
 *   to a loud refusal (only ever hit on the animated path — see noFrameScheduler).
 * @param cancelFrame (handle) → cancels a pending scheduled frame (paired with
 *   requestFrame; requestAnimationFrame's cancelAnimationFrame). Defaults to a
 *   no-op — harmless when requestFrame was never called (instant playback).
 */
export function createPresenter(
  getDoc,
  onFrame,
  onTransitionStart = () => {},
  requestFrame = noFrameScheduler,
  cancelFrame = () => {},
) {
  let index = 0;
  let alpha = 1;
  let raf = null;
  let autoTimer = null;

  function cancel() {
    if (raf !== null) cancelFrame(raf);
    if (autoTimer) clearTimeout(autoTimer);
    raf = autoTimer = null;
  }

  // The transition being animated INTO the current index (its type/seconds/
  // curve). null at rest / on slide 0 / after an instant step. Carried in every
  // emitted frame so the render surface (PresentMode) picks tween vs fade — a
  // fade is a crossfade of two COMPLETED-state snapshots, not a delta tween, so
  // it needs a different draw path (and stays a pure function of alpha for CLI).
  let transition = null;

  function emit() {
    onFrame({ index, alpha, transition });
  }

  function armAutoAdvance() {
    const doc = getDoc();
    const secs = doc.slides[index].autoAdvance;
    if (typeof secs === "number" && index < doc.slides.length - 1)
      autoTimer = setTimeout(() => api.next(), secs * 1000);
  }

  /** Command. Animates alpha 0→1 into slide `to` over its transition's seconds,
   * honoring the transition's curve (smooth = eased, linear = raw). The
   * transition TYPE (tween|fade) is carried to the render surface via emit(). */
  function transitionTo(to) {
    cancel();
    const doc = getDoc();
    index = to;
    // Slide 0 has no predecessor to transition FROM — no animation, no
    // transition record in flight (its stored transition is inert).
    transition = to === 0 ? null : resolveTransition(doc, to);
    // SOUND (Round 12B: "a transition can play a sound"). Fired ONCE here, at
    // the START of the transition (not per alpha frame), so the DOM owner plays
    // the asset exactly once. A null/absent sound is silence — normal, not an
    // error (see PresentMode.playTransitionSound). Core does NOT touch audio
    // itself (DOM-free; SPARKLER RULE — sounds never render headlessly).
    if (transition) onTransitionStart(transition);
    const duration = (transition?.seconds ?? 0) * 1000;
    // Curve: "smooth" = the existing eased alpha (cubic); "linear" = raw alpha.
    const easeFn = ease(transition?.curve === "linear" ? "linear" : "cubic");
    if (duration <= 0 || to === 0) {
      alpha = 1;
      emit();
      armAutoAdvance();
      return;
    }
    // UNCAPPED, always (round 11: "No more optional caps") — one frame per
    // scheduler tick, so every monitor gets its native rate with no detection.
    // Tweens are time-parameterized: more frames add smoothness, never speed.
    // (The removed fps cap's history — including the gap-comparison bug that
    // halved 120Hz to 60 — lives in concerns.md.) requestFrame is the INJECTED
    // scheduler (browser: rAF) so this path stays bare-node-runnable.
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      alpha = easeFn(t);
      emit();
      if (t < 1) raf = requestFrame(tick);
      else armAutoAdvance();
    }
    alpha = 0;
    emit();
    raf = requestFrame(tick);
  }

  /** Pure-ish query. Next enabled slide index in `dir`, or null. */
  function enabledNeighbor(from, dir) {
    const doc = getDoc();
    for (let i = from + dir; i >= 0 && i < doc.slides.length; i += dir)
      if (doc.slides[i].enabled !== false) return i;
    return null;
  }

  const api = {
    get index() { return index; },
    get alpha() { return alpha; },
    /** Command. Advance to the next ENABLED slide (tweened); no-op at the end. */
    next() {
      const to = enabledNeighbor(index, +1);
      if (to !== null) transitionTo(to);
    },
    /** Command. Back to the previous ENABLED slide (instant — matches PPT). */
    prev() {
      cancel();
      const to = enabledNeighbor(index, -1);
      if (to !== null) index = to;
      alpha = 1;
      transition = null; // instant step: no crossfade/tween in flight
      emit();
    },
    /** Command. Jump straight to a slide, fully applied. */
    goTo(i) {
      cancel();
      index = Math.max(0, Math.min(getDoc().slides.length - 1, i));
      alpha = 1;
      transition = null; // instant jump
      emit();
      armAutoAdvance();
    },
    /** Command. Stops timers/animation (call when leaving present mode). */
    stop: cancel,
  };
  return api;
}
