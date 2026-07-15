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
 */
export function createPresenter(getDoc, onFrame, onTransitionStart = () => {}) {
  let index = 0;
  let alpha = 1;
  let raf = null;
  let autoTimer = null;

  function cancel() {
    if (raf) cancelAnimationFrame(raf);
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
    // rAF tick, so every monitor gets its native rate with no detection.
    // Tweens are time-parameterized: more frames add smoothness, never speed.
    // (The removed fps cap's history — including the gap-comparison bug that
    // halved 120Hz to 60 — lives in concerns.md.)
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      alpha = easeFn(t);
      emit();
      if (t < 1) raf = requestAnimationFrame(tick);
      else armAutoAdvance();
    }
    alpha = 0;
    emit();
    raf = requestAnimationFrame(tick);
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
