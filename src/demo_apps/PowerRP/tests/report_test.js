/**
 * core/report.js tests — the log-once reporting home (bare node, no
 * framework — suite conventions). console.error is captured per test; the
 * module-level dedup memory persists across calls BY DESIGN (once per
 * process/session — the documented throttle semantics), so each test uses
 * its own unique keys.
 */

import assert from "node:assert/strict";
import { reportOnce } from "../core/report.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

/** Runs fn with console.error captured; returns the captured lines. */
function capturedErrors(fn) {
  const orig = console.error;
  const seen = [];
  console.error = (...args) => seen.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return seen;
}

test("first report logs and returns true; repeat key is silent and false", () => {
  const seen = capturedErrors(() => {
    assert.equal(reportOnce("rt: alpha"), true);
    assert.equal(reportOnce("rt: alpha"), false);
    assert.equal(reportOnce("rt: alpha"), false);
  });
  assert.deepEqual(seen, ["rt: alpha"]);
});

test("distinct keys each log once", () => {
  const seen = capturedErrors(() => {
    reportOnce("rt: beta");
    reportOnce("rt: gamma");
    reportOnce("rt: beta");
  });
  assert.deepEqual(seen, ["rt: beta", "rt: gamma"]);
});

test("line defaults to key; explicit line prints prefixed, dedupes on key", () => {
  const seen = capturedErrors(() => {
    reportOnce("rt: delta", "PowerRP expression error at items.a.x: rt: delta");
    reportOnce("rt: delta", "PowerRP expression error at items.b.y: rt: delta"); // same key: silent
  });
  assert.deepEqual(seen, ["PowerRP expression error at items.a.x: rt: delta"]);
});

console.log(`\n${passed} report tests passed`);
