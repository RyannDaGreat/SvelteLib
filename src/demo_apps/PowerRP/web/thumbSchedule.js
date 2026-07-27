/**
 * Thumbnail dirty-keying + off-main-thread render scheduling for SlideNav.
 *
 * TWO independent concerns, both DOM-free and unit-testable in bare node (the
 * browser globals are dependency-injected), so the .svelte shell stays a thin
 * consumer:
 *
 *  1. PER-SLIDE DIRTY KEYS (thumbnailDirtyKeys). A slide's thumbnail renders the
 *     FORWARD FOLD of deltas 0..i (a disabled slide contributes nothing), so its
 *     dirty key must change iff any of deltas 0..i change, any of slides 0..i
 *     flips `enabled`, the document meta changes, or an image decode lands.
 *     Delta objects are reference-stable under structural sharing (core/document.js
 *     keyframed replaces ONLY the edited slide's delta object; siblings keep their
 *     reference), so a stable identity→serial map turns "editing slide N" into
 *     "only keys i>=N change" — slides before N keep byte-identical keys and never
 *     repaint. This is the fix for the whole-document dirty key that repainted
 *     every visible thumbnail on every commit.
 *
 *  2. IDLE RATIONING + GESTURE GATING (makeIdleThumbScheduler). Rendering a
 *     thumbnail costs a CanvasKit raster plus a GPU→CPU pixel readback and a PNG
 *     encode on the main thread; firing N of them in one flush blocks input. The
 *     scheduler drains queued renders at most `perTick` per requestIdleCallback
 *     (rAF fallback) tick, so a burst never monopolizes the main thread — each
 *     tile shows its last render until its turn. MEASURED per thumbnail at the
 *     size SlideNav actually asks for (187×112 device px, quality "proxy"):
 *     ~2.1 ms, of which the raster is ~0.4 ms and the readback → 2D canvas → PNG
 *     data-URL tail is ~1.7 ms. So the tail, not the raster, dominates.
 *
 *     GESTURE GATING (setPaused): while a user gesture is in flight — a canvas
 *     drag, an Inspector scrub, a picker, a preset hover — the queue HOLDS and no
 *     thumbnail renders at all. A live thumbnail mid-gesture has no value (the
 *     user is looking at the canvas), and the render competes with the very frames
 *     the gesture needs. Unpausing drains, so the tile is correct once the gesture
 *     settles: each tile coalesces its own pending run and re-reads visible+dirty
 *     when its turn comes, so a held burst becomes ONE render of the final state.
 *     Callers gate with thumbRenderPaused(app).
 *
 *     PROFILING (flush). requestIdleCallback only fires when the main thread goes
 *     idle, so this work DISAPPEARS under an attached profiler (which keeps the
 *     thread busy) — the class of cost that cannot be seen by the tool you would
 *     reach for. flush() therefore drains the whole queue SYNCHRONOUSLY, ignoring
 *     both `perTick` and the pause, so the cost lands inside a profile (and inside
 *     a test) as one attributable task. SlideNav exposes it as the
 *     window.__powerrp_thumbs dev/test seam.
 *
 *     NOTE the renders themselves are ASYNC (gpuService.renderCameraFrame returns
 *     a promise): a drained run STARTS a render and the raster/readback land in a
 *     later microtask, outside the idle callback. Nothing here reads the
 *     IdleDeadline, so the ration is per-tick COUNT, not a time budget.
 *
 * (The commit-burst DEBOUNCE lives in SlideNav, on key PUBLICATION, so rapid
 * edits coalesce into one render of the final state while scroll-in renders stay
 * prompt — see SlideNav.svelte.)
 */

/**
 * Near-pure factory (returns a stateful closure; the closure is a Query — same
 * input identity always yields the same serial for the life of the source).
 * Builds `serialOf(obj)`: a stable, monotonic integer per OBJECT IDENTITY,
 * backed by a WeakMap (GC'd objects don't leak). The first object seen is 1, the
 * next new one 2, and so on; a repeat of an already-seen object returns its
 * original serial. Used to turn reference-stable delta objects into comparable
 * primitives for the dirty keys.
 *
 * @returns {(obj: object) => number} identity → stable serial.
 *
 * @example
 * const serialOf = makeSerialSource();
 * const a = {}, b = {};
 * serialOf(a) // => 1
 * serialOf(b) // => 2
 * serialOf(a) // => 1  (stable per identity)
 */
export function makeSerialSource() {
  const serials = new WeakMap();
  let next = 0;
  return (obj) => {
    let s = serials.get(obj);
    if (s === undefined) serials.set(obj, (s = ++next));
    return s;
  };
}

/**
 * Pure function (given a stable `serialOf`). Per-slide thumbnail dirty keys for
 * a document. keys[i] changes iff slide i's rendered thumbnail could change:
 * any of deltas 0..i got a new identity, any of slides 0..i flipped `enabled`,
 * the meta changed, or `imageEpoch` bumped (an async image decode landed). The
 * cumulative prefix is why editing slide N dirties only i>=N.
 *
 * @param {{meta: object, slides: {delta: object, enabled?: boolean}[]}} doc
 * @param {number} imageEpoch  Bumped when an async image decode lands (folds into every key).
 * @param {(obj: object) => number} serialOf  Identity→serial from makeSerialSource.
 * @returns {string[]} keys[i] is slide i's dirty key (compared with !== by DirtyImage).
 *
 * @example
 * const serialOf = makeSerialSource();
 * const meta = {}, d0 = {}, d1 = {};
 * const doc = { meta, slides: [{ delta: d0 }, { delta: d1 }] };
 * thumbnailDirtyKeys(doc, 0, serialOf)
 * // => ["m1|2+#0", "m1|2+|3+#0"]  (meta→1, d0→2, d1→3; "+"=enabled)
 * @example
 * // A disabled slide encodes "-" so toggling it re-keys it and every slide after.
 * const serialOf2 = makeSerialSource();
 * thumbnailDirtyKeys({ meta: {}, slides: [{ delta: {}, enabled: false }] }, 0, serialOf2)
 * // => ["m1|2-#0"]
 */
export function thumbnailDirtyKeys(doc, imageEpoch, serialOf) {
  const keys = [];
  // Meta (slide dimensions / camera-frame inputs) is a global prefix: a meta
  // edit keeps every slide/delta reference but changes the frame, so it must
  // re-key ALL thumbnails.
  let prefix = "m" + serialOf(doc.meta);
  for (const s of doc.slides) {
    prefix += "|" + serialOf(s.delta) + (s.enabled === false ? "-" : "+");
    keys.push(prefix + "#" + imageEpoch);
  }
  return keys;
}

/**
 * Near-pure factory (returns a stateful controller whose methods are Commands
 * that schedule/cancel work via the injected deps). An idle-rationed render
 * queue: callers `request(run)` a render; the queue drains at most `perTick`
 * runs per `requestTick` (a requestIdleCallback, or rAF where idle is absent),
 * yielding to input between ticks so a burst of thumbnail renders never blocks
 * the main thread. The queue is bounded by the number of VISIBLE dirty tiles
 * (each DirtyImage enqueues at most one pending run — it coalesces its own).
 *
 * @param {object} deps
 * @param {(cb: () => void) => any} deps.requestTick  Schedule a drain tick; returns a handle.
 * @param {(handle: any) => void} deps.cancelTick  Cancel a scheduled drain tick.
 * @param {number} deps.perTick  Max runs to execute per drain tick (a small N).
 * @returns {{request: (run: () => void) => (() => void), setPaused: (p: boolean) => void, flush: () => number, pending: () => number, dispose: () => void}}
 *   request(run) enqueues and returns a canceller (drops the run if it hasn't
 *   executed yet); setPaused(true) HOLDS the queue for the duration of a gesture
 *   and setPaused(false) resumes draining; flush() runs the whole queue
 *   synchronously (ignoring perTick AND the pause) and returns how many ran;
 *   pending() is the queue length; dispose() cancels the pending tick and clears
 *   the queue.
 *
 * @example
 * // A synchronous fake tick + perTick 1 drains one run per tick:
 * const ticks = [];
 * const s = makeIdleThumbScheduler({ requestTick: (cb) => (ticks.push(cb), ticks.length), cancelTick: () => {}, perTick: 1 });
 * const log = [];
 * s.request(() => log.push("a"));
 * s.request(() => log.push("b"));
 * ticks.shift()();      // drain tick 1 → runs "a", re-schedules
 * // log is now ["a"]; "b" waits for the next tick
 * @example
 * // Paused, a request schedules NO tick; flush() runs it anyway (the profiling seam).
 * // s.setPaused(true); s.request(run); s.pending() // => 1  (no tick scheduled)
 * // s.flush()                                     // => 1  (ran synchronously)
 */
export function makeIdleThumbScheduler({ requestTick, cancelTick, perTick }) {
  const queue = []; // pending run callbacks, FIFO
  let tickHandle = null; // handle of the scheduled drain tick, or null when idle
  let paused = false; // a gesture is in flight — hold the queue (see the header)

  /** Command. Cancels the scheduled drain tick, if any, and forgets its handle. */
  function cancelPendingTick() {
    if (tickHandle === null) return;
    cancelTick(tickHandle);
    tickHandle = null;
  }

  /** Command. Ensures a drain tick is scheduled iff there is queued work, none is
   *  pending, and no gesture is holding the queue. */
  function scheduleDrain() {
    if (paused || tickHandle !== null || queue.length === 0) return;
    tickHandle = requestTick(drain);
  }

  /** Command. Runs up to `perTick` queued renders, then re-schedules if any remain. */
  function drain() {
    tickHandle = null;
    for (let n = 0; n < perTick && queue.length; n++) queue.shift()();
    scheduleDrain();
  }

  return {
    request(run) {
      queue.push(run);
      scheduleDrain();
      return () => {
        const i = queue.indexOf(run);
        if (i !== -1) queue.splice(i, 1);
      };
    },
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      if (paused) cancelPendingTick();
      else scheduleDrain();
    },
    flush() {
      // Deliberately ignores `paused` and `perTick`: this is the seam that makes
      // idle-scheduled work observable (profiler / test), so it must run NOW and
      // as ONE task. Re-entrancy is not a concern — a run never calls flush.
      cancelPendingTick();
      let ran = 0;
      while (queue.length) {
        queue.shift()();
        ran++;
      }
      return ran;
    },
    pending() {
      return queue.length;
    },
    dispose() {
      cancelPendingTick();
      queue.length = 0;
    },
  };
}

/**
 * Pure function. Is a user GESTURE in flight, so thumbnail rendering must HOLD?
 * A live thumbnail mid-gesture has no value (the user is watching the canvas) and
 * its raster + readback competes with the very frames the gesture needs, so the
 * answer gates both the dirty-key freeze and the render queue (SlideNav.svelte).
 *
 * Two independent signals, because neither alone covers every gesture:
 *   · `dragging` — the canvas drag flag, set at POINTER-DOWN (CanvasView), i.e.
 *     before the first move stages a preview, and true for gestures that stage no
 *     preview at all (band select, crosshair placement).
 *   · `previewDelta` — any staged live preview, including gestures that never
 *     touch the canvas: Inspector scrubs, the colour/angle pickers, preset hovers,
 *     the modal transform. An EMPTY staged delta ({}) still counts as in-flight —
 *     setPreview([]) is how a zero-offset move holds the committed pose.
 *
 * @param {{dragging?: boolean, previewDelta?: object|null}} app  The app store (or any shape with these two).
 * @returns {boolean} True while a gesture is in flight.
 *
 * @example
 * // Idle editor: thumbnails may render.
 * thumbRenderPaused({ dragging: false, previewDelta: null })
 * // => false
 * @example
 * // A canvas drag holds from pointer-down, before any preview is staged.
 * thumbRenderPaused({ dragging: true, previewDelta: null })
 * // => true
 * @example
 * // An Inspector scrub stages a preview with no canvas drag — also holds.
 * thumbRenderPaused({ dragging: false, previewDelta: { items: { a: { x: 5 } } } })
 * // => true
 */
export function thumbRenderPaused({ dragging, previewDelta }) {
  return Boolean(dragging) || previewDelta != null;
}

/**
 * Query. Real-browser deps for makeIdleThumbScheduler: requestIdleCallback when
 * present (Chrome/Firefox), else requestAnimationFrame (Safari has no rIC). Kept
 * separate from the scheduler so the scheduler stays DOM-free and testable.
 *
 * @returns {{requestTick: (cb: () => void) => any, cancelTick: (h: any) => void}}
 *
 * @example
 * // makeIdleThumbScheduler({ ...browserTickDeps(), perTick: 2 })
 */
export function browserTickDeps() {
  const hasIdle = typeof requestIdleCallback === "function";
  return hasIdle
    ? { requestTick: (cb) => requestIdleCallback(cb), cancelTick: (h) => cancelIdleCallback(h) }
    : { requestTick: (cb) => requestAnimationFrame(cb), cancelTick: (h) => cancelAnimationFrame(h) };
}
