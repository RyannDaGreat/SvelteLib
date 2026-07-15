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

export function createPresenter(getDoc, onFrame) {
  let index = 0;
  let alpha = 1;
  let raf = null;
  let autoTimer = null;

  function cancel() {
    if (raf) cancelAnimationFrame(raf);
    if (autoTimer) clearTimeout(autoTimer);
    raf = autoTimer = null;
  }

  function emit() {
    onFrame({ index, alpha });
  }

  function armAutoAdvance() {
    const doc = getDoc();
    const secs = doc.slides[index].autoAdvance;
    if (typeof secs === "number" && index < doc.slides.length - 1)
      autoTimer = setTimeout(() => api.next(), secs * 1000);
  }

  /** Command. Animates alpha 0→1 into slide `to` over its duration. */
  function transitionTo(to) {
    cancel();
    const doc = getDoc();
    index = to;
    const duration = (doc.slides[to].duration ?? 0.5) * 1000;
    const easeFn = ease("cubic");
    if (duration <= 0 || to === 0) {
      alpha = 1;
      emit();
      armAutoAdvance();
      return;
    }
    // FPS is a presentation-level setting (meta.fps, default 120). rAF runs at
    // the display's rate; frames are skipped only when the display outpaces it.
    // ABSOLUTE DEADLINES, not now-vs-last gaps: comparing the gap against
    // exactly one frame period skips every jittered vsync tick whenever the
    // display rate EQUALS meta.fps — the classic cap bug that halved a 120Hz
    // presentation to 60fps (user-measured). Deadlines advance by the period
    // and snap forward when behind, so vsync jitter self-corrects at any rate.
    const frameMs = 1000 / (doc.meta.fps ?? 120);
    const start = performance.now();
    let nextEmit = start;
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      if (t < 1 && now < nextEmit) {
        raf = requestAnimationFrame(tick);
        return;
      }
      nextEmit = Math.max(nextEmit + frameMs, now);
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
      emit();
    },
    /** Command. Jump straight to a slide, fully applied. */
    goTo(i) {
      cancel();
      index = Math.max(0, Math.min(getDoc().slides.length - 1, i));
      alpha = 1;
      emit();
      armAutoAdvance();
    },
    /** Command. Stops timers/animation (call when leaving present mode). */
    stop: cancel,
  };
  return api;
}
