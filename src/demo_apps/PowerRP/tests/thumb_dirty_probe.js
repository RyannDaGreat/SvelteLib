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
 * cwd-independent (ESM relative imports). Exits non-zero on the first failure.
 */
import assert from "node:assert";
import { newDocument, keyframed, withNewSlide, withSlideToggled } from "../core/document.js";
import { makeSerialSource, thumbnailDirtyKeys, makeIdleThumbScheduler } from "../web/thumbSchedule.js";

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

console.log(`\n${passed} checks passed`);
