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
 *  2. IDLE RATIONING (makeIdleThumbScheduler). Rendering a thumbnail is a
 *     synchronous CanvasKit raster + pixel readback on the main thread; firing N
 *     of them in one microtask flush blocks input. The scheduler drains queued
 *     renders at most `perTick` per requestIdleCallback (rAF fallback) tick, so a
 *     burst never monopolizes the main thread — each tile shows its last render
 *     until its turn.
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
 * @returns {{request: (run: () => void) => (() => void), dispose: () => void}}
 *   request(run) enqueues and returns a canceller (drops the run if it hasn't
 *   executed yet); dispose() cancels the pending tick and clears the queue.
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
 */
export function makeIdleThumbScheduler({ requestTick, cancelTick, perTick }) {
  const queue = []; // pending run callbacks, FIFO
  let tickHandle = null; // handle of the scheduled drain tick, or null when idle

  /** Command. Ensures a drain tick is scheduled iff there is queued work and none is pending. */
  function scheduleDrain() {
    if (tickHandle !== null || queue.length === 0) return;
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
    dispose() {
      if (tickHandle !== null) cancelTick(tickHandle);
      queue.length = 0;
    },
  };
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
