/**
 * PER-SLIDE THUMBNAIL DIRTY-KEY + IDLE-SCHEDULER PROBE.
 *
 * Proves the two SlideNav thumbnail fixes without a browser (both units are
 * DOM-free — see web/thumbSchedule.js):
 *
 *  A. Editing slide N re-keys ONLY slides >= N. Slide deltas fold forward and
 *     are reference-stable under structural sharing (core/document.js keyframed),
 *     so a stable identity→serial map makes slides < N keep byte-identical keys
 *     (they never repaint) while slides >= N change. Toggling `enabled` and
 *     bumping the image epoch are covered too.
 *
 *  B. The idle scheduler drains at most `perTick` renders per tick, coalesces a
 *     burst into one scheduled tick, and honors cancellation + dispose — i.e.
 *     thumbnail renders ride idle/rAF ticks off the critical path, not one
 *     synchronous flush that blocks input.
 *
 *  C. The GESTURE HOLD: thumbRenderPaused's two signals, that a pause queues but
 *     never runs (and cancels an already-scheduled tick — the hole the dirty-key
 *     freeze alone left open), that release drains, and that flush() — the seam
 *     that makes this idle work visible to a profiler — runs the whole queue
 *     synchronously in spite of both the ration and the pause.
 *
 * cwd-independent (ESM relative imports). Exits non-zero on the first failure.
 */
import assert from "node:assert";
import { newDocument, keyframed, withNewSlide, withSlideToggled } from "../core/document.js";
import { makeSerialSource, thumbnailDirtyKeys, makeIdleThumbScheduler, thumbRenderPaused } from "../web/thumbSchedule.js";

let passed = 0;
function check(cond, name) {
  assert(cond, name);
  console.log("  ok  " + name);
  passed++;
}

// A 5-slide doc: slide 0 carries the camera delta, slides 1..4 are fresh empty
// deltas (distinct objects) — exactly what the editor produces via New Slide.
let doc = newDocument();
while (doc.slides.length < 5) [doc] = withNewSlide(doc, doc.slides.length - 1);
check(doc.slides.length === 5, "setup: built a 5-slide document");

// ── A. Structural sharing: editing slide 3 replaces ONLY slide 3's delta ──────
const beforeDeltas = doc.slides.map((s) => s.delta);
const editedN = keyframed(doc, 3, ["items", "obj", "x"], 42);
const afterDeltas = editedN.slides.map((s) => s.delta);
check(
  afterDeltas[0] === beforeDeltas[0] && afterDeltas[1] === beforeDeltas[1] &&
    afterDeltas[2] === beforeDeltas[2] && afterDeltas[4] === beforeDeltas[4],
  "structural sharing: editing slide 3 keeps every OTHER slide's delta identity",
);
check(afterDeltas[3] !== beforeDeltas[3], "structural sharing: edited slide 3 gets a NEW delta object");

// ── A. Per-slide keys: editing slide N re-keys only i >= N ────────────────────
// One serialOf for the whole probe — identities must stay comparable across the
// simulated commits, exactly as the component holds one for its lifetime.
const serialOf = makeSerialSource();
const base = thumbnailDirtyKeys(doc, 0, serialOf);
const afterEditN = thumbnailDirtyKeys(editedN, 0, serialOf);
check(
  afterEditN[0] === base[0] && afterEditN[1] === base[1] && afterEditN[2] === base[2],
  "per-slide keys: editing slide 3 leaves slides 0,1,2 keys UNCHANGED (no repaint)",
);
check(
  afterEditN[3] !== base[3] && afterEditN[4] !== base[4],
  "per-slide keys: editing slide 3 changes slides 3,4 keys (repaint)",
);

// Editing slide 0 re-keys EVERY slide (its delta is the root of every fold).
const edited0 = keyframed(doc, 0, ["items", "cam", "x"], 1);
const afterEdit0 = thumbnailDirtyKeys(edited0, 0, serialOf);
check(base.every((_, i) => afterEdit0[i] !== base[i]), "per-slide keys: editing slide 0 re-keys ALL slides");

// ── A. Enabled toggle: same delta identity, yet must re-key slide + successors ─
const toggled = withSlideToggled(doc, 2);
check(
  toggled.slides[2].delta === doc.slides[2].delta,
  "toggle: enabled flip keeps delta identity (so a delta-ONLY key would MISS it)",
);
const afterToggle = thumbnailDirtyKeys(toggled, 0, serialOf);
check(
  afterToggle[0] === base[0] && afterToggle[1] === base[1],
  "per-slide keys: toggling slide 2 leaves slides 0,1 UNCHANGED",
);
check(
  afterToggle[2] !== base[2] && afterToggle[3] !== base[3] && afterToggle[4] !== base[4],
  "per-slide keys: toggling slide 2 re-keys slides 2,3,4 (enabled folded into the key)",
);

// ── A. Image epoch: an async decode landing re-keys every visible thumbnail ───
const afterEpoch = thumbnailDirtyKeys(doc, 1, serialOf);
check(base.every((_, i) => afterEpoch[i] !== base[i]), "per-slide keys: bumping imageEpoch re-keys ALL slides");

// ── B. Idle scheduler: rationing + burst coalescing ──────────────────────────
const ticks = [];
const fakeDeps = { requestTick: (cb) => (ticks.push(cb), ticks.length), cancelTick: () => {}, perTick: 2 };
const sched = makeIdleThumbScheduler(fakeDeps);
const log = [];
for (const label of ["a", "b", "c", "d", "e"]) sched.request(() => log.push(label));
check(log.length === 0, "scheduler: NOTHING runs until a tick fires (off the critical path)");
check(ticks.length === 1, "scheduler: a 5-request burst schedules ONE drain tick (coalesced)");
ticks.shift()();
check(log.join("") === "ab", "scheduler: at most perTick=2 renders run per tick");
ticks.shift()();
check(log.join("") === "abcd", "scheduler: the next tick drains the next 2");
ticks.shift()();
check(log.join("") === "abcde", "scheduler: a final tick drains the remainder");
check(ticks.length === 0, "scheduler: no further tick once the queue is empty");

// ── B. Cancellation: a cancelled request never runs ──────────────────────────
const ticks2 = [];
const sched2 = makeIdleThumbScheduler({ requestTick: (cb) => (ticks2.push(cb), ticks2.length), cancelTick: () => {}, perTick: 10 });
const log2 = [];
const cancelX = sched2.request(() => log2.push("x"));
sched2.request(() => log2.push("y"));
cancelX();
ticks2.shift()();
check(log2.join("") === "y", "scheduler: a cancelled request is dropped (its turn is skipped)");

// ── B. Dispose: cancels the pending tick ──────────────────────────────────────
let cancelledHandle = null;
const sched3 = makeIdleThumbScheduler({ requestTick: () => 42, cancelTick: (h) => (cancelledHandle = h), perTick: 1 });
sched3.request(() => {});
sched3.dispose();
check(cancelledHandle === 42, "scheduler: dispose() cancels the pending idle tick");

// ── C. Gesture hold: no thumbnail renders while a gesture is in flight ───────
// The predicate first — two independent signals, because previewDelta alone
// misses the pointer-down→first-move window and every preview-less gesture.
check(thumbRenderPaused({ dragging: false, previewDelta: null }) === false, "gesture: idle editor is NOT paused");
check(thumbRenderPaused({ dragging: true, previewDelta: null }) === true, "gesture: a canvas drag pauses from pointer-down (no preview staged yet)");
check(thumbRenderPaused({ dragging: false, previewDelta: {} }) === true, "gesture: an EMPTY staged preview still counts as in flight (zero-offset move)");
check(thumbRenderPaused({ dragging: false, previewDelta: { items: { a: { x: 1 } } } }) === true, "gesture: an Inspector scrub (preview, no canvas drag) pauses");
check(thumbRenderPaused({}) === false, "gesture: a store with neither signal set is NOT paused");

// Paused: a request enqueues but schedules NO tick, and an ALREADY-scheduled
// tick is cancelled — the hole the dirty-key freeze alone left open.
const ticks4 = [];
let cancelled4 = [];
const sched4 = makeIdleThumbScheduler({
  requestTick: (cb) => (ticks4.push(cb), ticks4.length),
  cancelTick: (h) => cancelled4.push(h),
  perTick: 2,
});
const log4 = [];
sched4.request(() => log4.push("pre")); // queued BEFORE the gesture → one tick scheduled
check(ticks4.length === 1 && sched4.pending() === 1, "gesture: a pre-gesture request schedules a tick");
sched4.setPaused(true);
check(cancelled4.length === 1, "gesture: pausing CANCELS the already-scheduled drain tick");
sched4.request(() => log4.push("mid")); // e.g. a tile scrolled into view mid-drag
check(ticks4.length === 1, "gesture: requests made while paused schedule NO tick");
check(sched4.pending() === 2, "gesture: paused requests still queue (nothing is dropped)");
check(log4.length === 0, "gesture: NOTHING renders while the gesture is in flight");
sched4.setPaused(false);
check(ticks4.length === 2, "gesture: releasing the hold schedules a drain tick");
ticks4.pop()();
check(log4.join(",") === "pre,mid", "gesture: the held queue drains after the gesture (tiles catch up)");

// setPaused is idempotent — repeated identical values must not cancel/re-schedule.
const ticks5 = [];
const cancelled5 = [];
const sched5 = makeIdleThumbScheduler({ requestTick: (cb) => (ticks5.push(cb), ticks5.length), cancelTick: (h) => cancelled5.push(h), perTick: 1 });
sched5.request(() => {});
sched5.setPaused(true);
sched5.setPaused(true);
check(cancelled5.length === 1, "gesture: setPaused(true) twice cancels ONCE (idempotent)");
sched5.setPaused(false);
sched5.setPaused(false);
check(ticks5.length === 2, "gesture: setPaused(false) twice schedules ONCE (idempotent)");

// ── C. flush(): the profiling seam — synchronous, ignores ration AND pause ────
const ticks6 = [];
const cancelled6 = [];
const sched6 = makeIdleThumbScheduler({ requestTick: (cb) => (ticks6.push(cb), ticks6.length), cancelTick: (h) => cancelled6.push(h), perTick: 1 });
const log6 = [];
sched6.setPaused(true);
for (const label of ["a", "b", "c"]) sched6.request(() => log6.push(label));
check(log6.length === 0 && sched6.pending() === 3, "flush: three renders held by the pause");
check(sched6.flush() === 3, "flush: returns how many renders it ran");
check(log6.join("") === "abc", "flush: runs the WHOLE queue synchronously despite perTick=1 AND the pause");
check(sched6.pending() === 0, "flush: leaves the queue empty");
check(sched6.flush() === 0, "flush: an empty queue flushes to 0 (no-op)");
// A flush must also retire a scheduled tick so the drain does not double-run.
const ticks7 = [];
const cancelled7 = [];
const sched7 = makeIdleThumbScheduler({ requestTick: (cb) => (ticks7.push(cb), ticks7.length), cancelTick: (h) => cancelled7.push(h), perTick: 1 });
const log7 = [];
sched7.request(() => log7.push("z"));
sched7.flush();
check(cancelled7.length === 1, "flush: cancels the pending idle tick (no double drain)");
ticks7.shift()(); // even if the stale tick were delivered, the queue is empty
check(log7.join("") === "z", "flush: a stale delivered tick after a flush runs nothing extra");

console.log(`\n${passed} checks passed`);
