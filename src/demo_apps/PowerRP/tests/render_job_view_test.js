/**
 * RENDER JOB VIEW-MODEL TEST — the pure vocabulary the Render Center list and the
 * toolbar badge both read a job record through (web/renderJobView.js).
 *
 * These are small functions, but they encode two rules that are easy to get
 * quietly wrong and expensive when they are:
 *   - WHAT THE BADGE COUNTS. If the badge and the list disagree about "active"
 *     or "unseen", the toolbar shows a number that matches nothing in the pane.
 *     One module, one definition, tested here.
 *   - WHAT OPENS ITSELF. Rows are collapsed by default because an expanded row
 *     mounts a <video>; defaulting wrong means opening the Render Center fetches
 *     every movie in the project at once. So defaultExpanded is pinned to exactly
 *     "still working, or finished and not yet seen".
 *
 * Bare node, no DOM — that is why the helpers live in a .js module and not inside
 * the .svelte component.
 *
 * Run:  node src/demo_apps/PowerRP/tests/render_job_view_test.js
 */
import assert from "node:assert";
import {
  ACTIVE_STATES, STATE_ICONS, jobIsActive, jobIsUnseenResult, renderBadgeCount,
  defaultExpanded, jobProgress, jobStatusLine,
} from "../web/renderJobView.js";

let checks = 0;
function ok(label, fn) {
  fn();
  checks++;
  console.log(`PASS  ${label}`);
}

/** Pure helper. A job record with the fields these helpers read. */
const job = (state, extra = {}) => ({ state, seen: false, framesDone: 0, framesTotal: 0, ...extra });

ok("active states are exactly queued/rendering/encoding", () => {
  assert.deepEqual(ACTIVE_STATES, ["queued", "rendering", "encoding"]);
  for (const s of ACTIVE_STATES) assert.equal(jobIsActive(job(s)), true, s);
  for (const s of ["done", "failed", "cancelled", "interrupted"])
    assert.equal(jobIsActive(job(s)), false, s);
});

ok("every state has an icon (a state with none would render an empty box)", () => {
  for (const s of [...ACTIVE_STATES, "done", "failed", "cancelled", "interrupted"])
    assert.ok(STATE_ICONS[s], `no icon for state ${s}`);
});

ok("unseen result means DONE and not seen — not merely unseen", () => {
  assert.equal(jobIsUnseenResult(job("done", { seen: false })), true);
  assert.equal(jobIsUnseenResult(job("done", { seen: true })), false);
  // A failed job is not a "result" to go and look at proudly; it shows its error
  // in the list, but it must not sit on the toolbar badge forever.
  assert.equal(jobIsUnseenResult(job("failed", { seen: false })), false);
  assert.equal(jobIsUnseenResult(job("rendering", { seen: false })), false);
});

ok("badge counts working jobs plus unseen finished ones", () => {
  assert.equal(renderBadgeCount([]), 0);
  assert.equal(renderBadgeCount([job("done", { seen: true })]), 0);
  assert.equal(renderBadgeCount([job("rendering"), job("done", { seen: true })]), 1);
  assert.equal(renderBadgeCount([job("done", { seen: false }), job("queued")]), 2);
  // A pile of finished-and-seen work must not keep the badge lit.
  assert.equal(renderBadgeCount([job("done", { seen: true }), job("cancelled", { seen: true }), job("failed", { seen: true })]), 0);
});

ok("defaultExpanded opens working and unseen-finished rows only", () => {
  assert.equal(defaultExpanded(job("rendering")), true);
  assert.equal(defaultExpanded(job("queued")), true);
  assert.equal(defaultExpanded(job("encoding")), true);
  assert.equal(defaultExpanded(job("done", { seen: false })), true);
  // THE constraint: a project full of finished, seen renders opens with every
  // row shut, so no <video> is mounted until asked for.
  assert.equal(defaultExpanded(job("done", { seen: true })), false);
  assert.equal(defaultExpanded(job("failed", { seen: true })), false);
  assert.equal(defaultExpanded(job("cancelled", { seen: true })), false);
});

ok("progress is null without a denominator, and never exceeds 1", () => {
  assert.equal(jobProgress(job("rendering", { framesDone: 0, framesTotal: 0 })), null);
  assert.equal(jobProgress(job("rendering", { framesDone: 5, framesTotal: 10 })), 0.5);
  // The worker can finish a shard's last frames between two polls of the total,
  // so done > total is reachable; a bar past 100% would look broken.
  assert.equal(jobProgress(job("rendering", { framesDone: 12, framesTotal: 10 })), 1);
});

ok("every state produces a status sentence, and it says what it means", () => {
  assert.match(jobStatusLine(job("rendering", { framesDone: 4, framesTotal: 10 })), /frame 4 of 10/);
  // An unknown total must not read as "frame 4 of 0".
  assert.match(jobStatusLine(job("rendering", { framesDone: 4, framesTotal: 0 })), /frame 4 of \?/);
  assert.match(jobStatusLine(job("queued")), /Queued/);
  assert.match(jobStatusLine(job("encoding")), /ffmpeg/);
  assert.match(jobStatusLine(job("done", { framesTotal: 120 })), /120 frames/);
  assert.match(jobStatusLine(job("interrupted")), /restart/);
  assert.equal(jobStatusLine(job("failed")), "Failed");
});

console.log(`\nAll ${checks} render-job view checks passed.`);
