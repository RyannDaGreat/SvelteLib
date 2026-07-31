/**
 * STORAGE-MODE DETECTION. Plain node, no framework (suite convention):
 *   node src/demo_apps/PowerRP/tests/storage_mode_test.js
 *
 * THE BUG THIS EXISTS FOR — the SPA-FALLBACK FALSE POSITIVE. Detection probes
 * `/api/projects/` and, before hardening, counted ANY HTTP response as "a backend
 * is present". A static host with SPA fallback (GitHub Pages; any `try_files …
 * /index.html` deploy) answers every unmatched path with the app's own index.html
 * — a 200 with a body. So the probe concluded "server present" on a host with no
 * server at all, and the app booted into HTTP mode where nothing could work. This
 * was found during static acceptance, where the workaround was to pass `?static=1`.
 *
 * WHY IT NEEDS A TEST AND NOT JUST THE FIX: the failure is invisible from inside
 * the app. Both worlds return a 200; only the content-type separates them, and
 * nothing else in the suite exercises a probe response at all. A future refactor
 * that simplified the check back to `if (res.ok) return true` would look correct,
 * pass every other suite, and silently restore the bug on the deploy target that
 * matters most.
 *
 * THE PRECEDENCE HALF is pinned too, because the JSON rule must not be allowed to
 * override an EXPLICIT instruction: `?static=1` and `?backend=` are statements of
 * intent and never probe (module docblock cases 1 and 2).
 */

import assert from "node:assert/strict";

// storageMode.js pulls in the storage adapters, which read `location` AT MODULE
// SCOPE (web/projectApi.js). Bare node has no browser globals, so the shim must
// be in place before that module body runs — and a static `import` would NOT do
// it, because static imports are hoisted and evaluated before any statement here.
// Hence the shim first and a DYNAMIC import after. (This suite is deliberately in
// the fast lane: the decision under test is pure logic over one fetch response,
// so it needs no browser to be exercised honestly.)
globalThis.location = { search: "", origin: "http://localhost" };

const { backendAnswers, forcedMode } = await import("../web/storageMode.js");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** Command (replaces the global fetch). Make the probe see one canned response. */
function respondWith({ status, contentType, body }) {
  globalThis.fetch = async () => new Response(body, { status, headers: { "content-type": contentType } });
}

/** Command (replaces the global fetch). Make the probe see a transport failure —
 *  nothing listening, DNS, or CORS: the genuine "no backend" case. */
function respondWithTransportFailure() {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
}

// ── THE REGRESSION: an SPA fallback is a RESPONSE, not a backend ─────────────

await test("THE REPRO — SPA fallback (200 + text/html) is NOT a backend", async () => {
  respondWith({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><html><body>the app's own index.html</body></html>" });
  assert.equal(await backendAnswers(""), false, "a 200 of HTML is the static host echoing index.html — booting HTTP mode here breaks every project call");
});

await test("a real backend (200 + application/json) IS a backend", async () => {
  respondWith({ status: 200, contentType: "application/json", body: "[]" });
  assert.equal(await backendAnswers(""), true, "server.py answers this route with a JSON array — an EMPTY library is still a library");
});

await test("the JSON check reads the media type, not the whole header verbatim", async () => {
  respondWith({ status: 200, contentType: "application/json; charset=utf-8", body: "[]" });
  assert.equal(await backendAnswers(""), true, "a charset parameter is normal and must not read as 'not JSON'");
});

await test("nothing listening (transport failure) is absent — the plain static case", async () => {
  respondWithTransportFailure();
  assert.equal(await backendAnswers(""), false);
});

await test("a 500 reads as absent, which is the ACCEPTED COST of the JSON rule", async () => {
  // Documenting a deliberate reversal, not asserting an ideal. An unwell server
  // now yields local storage rather than a surfaced server error; `?backend=`
  // (below) is the escape hatch that still turns it into a real error, because it
  // never probes. If this ever flips back, the SPA-fallback test above must be
  // the thing that justifies it.
  respondWith({ status: 500, contentType: "application/json", body: "{}" });
  assert.equal(await backendAnswers(""), false);
});

// ── PRECEDENCE: an explicit instruction outranks the probe ──────────────────

await test("?static=1 forces local and never probes", () => {
  assert.deepEqual(forcedMode("?static=1"), { mode: "local", reason: "?static=1 — forced browser-local storage" });
});

await test("?backend= forces http and never probes (an unwell named backend stays an ERROR)", () => {
  assert.deepEqual(forcedMode("?backend=http://box:3638"), { mode: "http", reason: "?backend=http://box:3638 — explicitly named backend" });
});

await test("no flag forces nothing — the probe decides", () => {
  assert.equal(forcedMode(""), null);
  assert.equal(forcedMode("?slide=3"), null, "an unrelated param must not be read as a storage instruction");
});

console.log(`\nstorage_mode_test: ${passed} passed`);
