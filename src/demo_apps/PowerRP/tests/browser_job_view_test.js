/**
 * BROWSER-RENDER VOCABULARY TEST — the pure functions that decide what the Render
 * Center SAYS about a render whose frames are made in a tab
 * (web/browserJobView.js), and the store predicates that decide where such a
 * render resumes from (web/browserJobStore.js).
 *
 * These are small functions guarding one large claim: a paused render must never be
 * described as a running one. The server records a browser job as "rendering" until
 * its movie arrives, so if the UI took the server's word it would print "Rendering
 * frame 412 of 900" about a render that stopped when the tab closed an hour ago.
 * That sentence is the bug; these tests pin the wording and the arithmetic that
 * prevent it.
 *
 * Bare node, no DOM, no IndexedDB — the impure store functions need a browser, but
 * the ones that decide MEANING do not, which is why they are separable.
 *
 * Run:  node src/demo_apps/PowerRP/tests/browser_job_view_test.js
 */
import assert from "node:assert";
import {
  browserJobStatusLine, browserJobProgress, canResume,
  BROWSER_ENCODERS, DEFAULT_BROWSER_ENCODER,
} from "../web/browserJobView.js";
import { assertContiguous, framesPersisted, driverState, LEASE_STALE_MS } from "../web/browserJobStore.js";
import { segmentFrames, encoderQp, QUALITY_QP, QP_MIN, QP_MAX, SEGMENT_SECONDS } from "../web/mp4Encoder.js";
import { frameCount, planForParams } from "../web/videoExport.js";

let checks = 0;
function ok(label, fn) {
  fn();
  checks++;
  console.log(`PASS  ${label}`);
}

const ACTIVE = ["queued", "rendering", "encoding"];

ok("a PAUSED browser render is never described as rendering", () => {
  const line = browserJobStatusLine(
    { state: "rendering", framesTotal: 900 },
    { driver: "paused", framesDone: 400, framesTotal: 900, resumeGranularity: "segment boundary" },
  );
  assert.match(line, /Paused/);
  assert.match(line, /nothing is rendering/);
  assert.match(line, /400 of 900/);
  // And it says WHERE it will pick up, because "resume" without a granularity
  // invites the assumption that no work is redone.
  assert.match(line, /segment boundary/);
  assert.doesNotMatch(line, /^Rendering/);
});

ok("a render this tab is driving says so, and names the phase", () => {
  const base = { driver: "here", framesDone: 12, framesTotal: 900 };
  assert.match(browserJobStatusLine({ state: "rendering" }, base), /Rendering frame 12 of 900 in this tab/);
  assert.match(browserJobStatusLine({ state: "rendering" }, { ...base, phase: "encoding" }), /Finishing the movie/);
  assert.match(browserJobStatusLine({ state: "rendering" }, { ...base, phase: "uploading" }), /Saving the movie/);
});

ok("another tab holding the render is distinguished from both", () => {
  const line = browserJobStatusLine({ state: "rendering" }, { driver: "elsewhere", framesDone: 5, framesTotal: 90 });
  assert.match(line, /another tab/);
  assert.doesNotMatch(line, /Paused/);
});

ok("a job whose progress this browser does not hold refuses to look resumable", () => {
  const line = browserJobStatusLine({ state: "rendering", framesTotal: 900 }, null);
  assert.match(line, /cannot be resumed here/);
  assert.equal(canResume({ backend: "client", state: "rendering" }, null, ACTIVE), false);
});

ok("an error on a stored browser job is surfaced, not swallowed", () => {
  assert.match(
    browserJobStatusLine({ state: "rendering" }, { driver: "paused", error: "the encoder worker crashed" }),
    /Stopped: the encoder worker crashed/,
  );
});

ok("Resume is offered only for an unfinished browser job nothing is driving", () => {
  assert.equal(canResume({ backend: "client", state: "rendering" }, { canResumeHere: true }, ACTIVE), true);
  assert.equal(canResume({ backend: "client", state: "rendering" }, { canResumeHere: false }, ACTIVE), false);
  assert.equal(canResume({ backend: "client", state: "done" }, { canResumeHere: true }, ACTIVE), false);
  assert.equal(canResume({ backend: "server", state: "rendering" }, { canResumeHere: true }, ACTIVE), false);
});

ok("browser progress is a fraction, never past 1, null without a denominator", () => {
  assert.equal(browserJobProgress({ framesDone: 45, framesTotal: 90 }), 0.5);
  assert.equal(browserJobProgress({ framesDone: 100, framesTotal: 90 }), 1);
  assert.equal(browserJobProgress({ framesDone: 0, framesTotal: 0 }), null);
  assert.equal(browserJobProgress(null), null);
});

ok("the resume point counts CLOSED segments only", () => {
  // The frames of a segment that was still encoding when the tab closed were never
  // written down. Counting them would resume past work that does not exist and
  // produce a movie with a hole in it.
  assert.equal(framesPersisted([{ frames: 20 }, { frames: 20 }]), 40);
  assert.equal(framesPersisted([]), 0);
});

ok("a gap in the persisted segments is refused, not resumed around", () => {
  assert.doesNotThrow(() => assertContiguous([
    { index: 0, firstFrame: 0, frames: 20 },
    { index: 1, firstFrame: 20, frames: 20 },
  ], "j"));
  assert.throws(
    () => assertContiguous([{ index: 0, firstFrame: 0, frames: 20 }, { index: 2, firstFrame: 40, frames: 20 }], "j"),
    /segment 1 is missing/,
  );
  assert.throws(
    () => assertContiguous([{ index: 0, firstFrame: 0, frames: 20 }, { index: 1, firstFrame: 25, frames: 20 }], "j"),
    /claims to start at frame 25/,
  );
});

ok("the lease distinguishes this tab, another tab, and nobody", () => {
  const now = 100_000;
  assert.equal(driverState({ driverId: "a", heartbeatAt: now - 100 }, "a", now), "here");
  assert.equal(driverState({ driverId: "b", heartbeatAt: now - 100 }, "a", now), "elsewhere");
  // A lease nobody refreshed is stale: the tab that held it is gone.
  assert.equal(driverState({ driverId: "b", heartbeatAt: now - LEASE_STALE_MS - 1 }, "a", now), "paused");
  assert.equal(driverState({ driverId: null, heartbeatAt: 0 }, "a", now), "paused");
  // Even OUR OWN stale lease is paused — a reloaded page is a new driver.
  assert.equal(driverState({ driverId: "a", heartbeatAt: now - LEASE_STALE_MS - 1 }, "a", now), "paused");
});

ok("segment length is the keyframe period AND the resume granularity", () => {
  assert.equal(segmentFrames(30), SEGMENT_SECONDS * 30);
  assert.equal(segmentFrames(10), SEGMENT_SECONDS * 10);
  // Never zero, whatever the fps: a zero-frame segment would never close.
  assert.equal(segmentFrames(0.2), 1);
  assert.ok(segmentFrames(0.01) >= 1);
});

ok("the quality control maps onto the encoder's own quantizer range", () => {
  assert.equal(encoderQp("medium"), QUALITY_QP.medium);
  assert.equal(encoderQp(18), 18);
  // The Render Center's CRF range is 0..51; the encoder's is 10..51, so the ends
  // clamp rather than making initialize() reject.
  assert.equal(encoderQp(0), QP_MIN);
  assert.equal(encoderQp(99), QP_MAX);
  assert.throws(() => encoderQp("lossless"), /unknown quality/);
});

ok("both browser encoders exist, are distinct, and state their resume precision", () => {
  assert.equal(BROWSER_ENCODERS.length, 2);
  assert.ok(BROWSER_ENCODERS.some((e) => e.value === DEFAULT_BROWSER_ENCODER));
  const resumes = BROWSER_ENCODERS.map((e) => e.resume);
  assert.equal(new Set(resumes).size, 2, "the two encoders must not claim the same resume precision");
  for (const e of BROWSER_ENCODERS) assert.ok(e.label.length > 0 && e.resume.length > 0);
});

ok("the browser backend derives its timeline from the same pure helpers", () => {
  const doc = { slides: [{ transition: { type: "tween", seconds: 0, curve: "smooth" } }, { transition: { type: "tween", seconds: 0, curve: "smooth" } }] };
  const params = { startIndex: 0, endIndex: 1, includeTransitions: false, holdSeconds: 1, fps: 10 };
  const plan = planForParams(doc, params);
  assert.equal(plan.duration, 2);
  assert.equal(frameCount(plan.duration, params.fps), 20);
});

console.log(`\nAll ${checks} browser-render vocabulary checks passed.`);
