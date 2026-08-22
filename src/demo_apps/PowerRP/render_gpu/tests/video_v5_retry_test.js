/**
 * VIDEO V5 SCRUB — A TRANSIENT DECODE FAILURE MUST NOT BE PERMANENT.
 *
 * WHAT WENT WRONG. `render_gpu/skia/video_v5.js` kept a `scrubFailed` map and gated
 * the LIVE paint path on `scrubFailed.has(key)`. `createImageBitmap` on an
 * already-loaded <video> throws InvalidStateError TRANSIENTLY — observed clustering
 * into windows on this host, with the same tree green minutes later
 * (tests/image_stack_live_probe.js's docblock records exactly what is and is not
 * established about the trigger, and deliberately does NOT claim a mechanism). One
 * such throw blacklisted that (scope, source, time, wrap) frame for the LIFE OF THE
 * PAGE: the widget went blank and no paint, scrub or reselect could bring it back,
 * because the only gate that could re-request it was the one that had latched. A
 * transient browser state was recorded as a permanent document one.
 *
 * WHAT THIS PINS, AND WHY IT IS SHAPED THIS WAY. The failing decode itself cannot be
 * INDUCED from a probe — that is a standing, recorded limitation of this branch, not
 * a gap this file could close by trying harder — so this suite pins the RULE rather
 * than the weather:
 *   1. `v5ScrubGivenUp` is the whole gate's logic, extracted as a pure function so
 *      it is checkable without a browser: never-failed and under-cap are BOTH "not
 *      given up on", at-cap and over-cap are both "given up on".
 *   2. The gate is WIRED to it. A structural check, because the defect was never a
 *      wrong predicate — it was the CALL SITE reading `.has()`. A test that only
 *      exercised the pure function would have passed on the broken build, which is
 *      the failure mode worth spending a grep on.
 *   3. The failure record COUNTS rather than overwrites, and the reported sentence
 *      distinguishes a pending retry from a give-up — a blank quad about to recover
 *      and one that never will look identical, so the console line is the only
 *      thing that tells them apart.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/render_gpu/tests/video_v5_retry_test.js
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { v5ScrubGivenUp } from "../skia/video_v5.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "../skia/video_v5.js"), "utf8");

/** The cap the module ships, read from its source — so this file cannot drift from
 *  it silently and cannot pin a number the module does not use. */
const CAP = Number(/const V5_SCRUB_MAX_ATTEMPTS = (\d+);/.exec(SOURCE)?.[1]);

let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log(`  ok  ${label}`); };

/** A failure map holding one key at `attempts`. */
const failedAt = (attempts) => new Map([["k", { message: "InvalidStateError", attempts }]]);

console.log("video_v5_retry_test");

// ── 1. THE RULE ──────────────────────────────────────────────────────────────
check("the cap is a real integer > 1 (a cap of 1 is the old latch)", () => {
  assert.ok(Number.isInteger(CAP), `V5_SCRUB_MAX_ATTEMPTS not found in source (got ${CAP})`);
  assert.ok(CAP > 1, `cap ${CAP} would give up on the first failure — that IS the defect`);
});

check("a key that never failed is not given up on", () => {
  assert.equal(v5ScrubGivenUp(new Map(), "k"), false);
});

check("a key under the cap is not given up on (this is the whole fix)", () => {
  for (let n = 1; n < CAP; n++) {
    assert.equal(v5ScrubGivenUp(failedAt(n), "k"), false, `attempts=${n} of cap ${CAP} must still retry`);
  }
});

check("a key at the cap is given up on", () => {
  assert.equal(v5ScrubGivenUp(failedAt(CAP), "k"), true);
});

check("a key past the cap stays given up on", () => {
  assert.equal(v5ScrubGivenUp(failedAt(CAP + 7), "k"), true);
});

check("an explicit cap argument overrides the default", () => {
  assert.equal(v5ScrubGivenUp(failedAt(2), "k", 2), true);
  assert.equal(v5ScrubGivenUp(failedAt(2), "k", 99), false);
});

check("a malformed record (no attempts) reads as not-failed rather than throwing", () => {
  assert.equal(v5ScrubGivenUp(new Map([["k", {}]]), "k"), false);
});

// ── 2. THE WIRING — the half a pure-function test cannot see ─────────────────
check("the live paint gate calls v5ScrubGivenUp, not scrubFailed.has", () => {
  const gate = /export function getVideoV5ScrubFrame[\s\S]*?\n}/.exec(SOURCE)?.[0];
  assert.ok(gate, "getVideoV5ScrubFrame not found");
  assert.match(gate, /v5ScrubGivenUp\(scrubFailed, key\)/, "the gate must consult the attempt count");
  assert.doesNotMatch(gate, /scrubFailed\.has\(/, "`scrubFailed.has` in the gate is the permanent-blacklist defect");
});

// ── 3. THE RECORD AND THE SENTENCE ───────────────────────────────────────────
check("noteV5ScrubFailure increments the previous count instead of overwriting", () => {
  const fn = /function noteV5ScrubFailure[\s\S]*?\n}/.exec(SOURCE)?.[0];
  assert.ok(fn, "noteV5ScrubFailure not found");
  assert.match(fn, /\.attempts\s*\?\?\s*0\s*\)\s*\+\s*1/, "must read the prior attempts and add one");
  assert.match(fn, /scrubFailed\.set\(key,\s*\{\s*message,\s*attempts\s*\}\)/, "must store both fields");
});

check("the reported sentence distinguishes a pending retry from a give-up", () => {
  const fn = /function noteV5ScrubFailure[\s\S]*?\n}/.exec(SOURCE)?.[0];
  assert.match(fn, /will retry/, "a recoverable failure must say so");
  assert.match(fn, /giving up/, "an exhausted failure must say so");
  assert.match(fn, /console\.error/, "every failure is still reported LOUDLY");
});

check("the stats split given-up from retrying rather than reporting one number", () => {
  assert.match(SOURCE, /retrying:\s*\[\.\.\.scrubFailed\.keys\(\)\]/, "the retrying population must be reported, not folded into `failed`");
});

console.log(`video_v5_retry_test: ${checks} checks passed`);
