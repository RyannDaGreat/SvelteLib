/**
 * project_list_draft_filter_test.js — plain node, no DOM, no IndexedDB.
 *
 * THE DEFECT THIS GUARDS: the "Open Project" grid (App.svelte) renders one card
 * per `app.listProjects()` entry, and `app.listProjects()` is a bare forward to
 * `projectStore().list()` (web/storageMode.js) — so ANY row that adapter returns
 * becomes a project card, including "~draft/current" if one ever reaches it. A
 * draft is explicitly NOT a library entry (web/projectDraft.js's working-copy
 * model), so the fix is at the LIST SEAM: both adapters' `list()` must exclude
 * any name for which `isDraftKey` is true, filtering with the SAME predicate the
 * rest of the draft model reads through rather than restating the "~draft/"
 * string.
 *
 * WHAT IS COVERED HERE vs THE BROWSER PROBE. `httpProjectStore` is DOM-free
 * enough for bare node once `location` is stubbed (projectApi.js reads
 * `location.search` at module scope for the `?backend=` override; a test never
 * sets it, so BACKEND stays "" and every fetch is same-origin-relative, exactly
 * like production) — so it is exercised HERE, fetch mocked, against a fixture
 * server response that includes a draft row (proving the client-side filter
 * holds even if a stray key ever appeared over HTTP, though server.py's
 * `_SAFE_NAME` means it structurally cannot — `list_projects()` names come
 * straight from `os.listdir(PROJECTS_DIR)`, and every write path that could
 * create a folder there rejects any name containing "/" via `safe_name()`,
 * which `DRAFT_KEY` ("~draft/current") always fails; see the commit message
 * for the full verdict).
 *
 * `localProjectStore` needs a REAL IndexedDB (web/localDb.js's `openDb` calls
 * `indexedDB.open` directly), which bare node does not have and this repo does
 * not fake — reimplementing IndexedDB well enough to trust its semantics would
 * be exactly the "second, weaker validator" the project avoids elsewhere. Per
 * tests/asset_store_test.js's own precedent ("The adapters themselves are NOT
 * tested here: they need IndexedDB and Blob... covered by the browser rehearsal
 * instead"), the LOCAL half of this acceptance criterion —seed a draft doc + two
 * projects into IndexedDB, assert listProjects returns the two with the draft
 * absent— is asserted by tests/open_project_grid_probe.js instead, which runs a
 * real browser.
 *
 * Run: node src/demo_apps/PowerRP/tests/project_list_draft_filter_test.js
 */

import assert from "node:assert/strict";

// projectApi.js reads `location.search` at module scope (the ?backend= override).
// A test never sets it, so BACKEND resolves to "" exactly like an ordinary same-
// origin production boot — this stub exists so importing the module doesn't
// throw in bare node, not to change its behavior.
globalThis.location = { search: "" };

const { httpProjectStore } = await import("../web/assetStore.js");
const { DRAFT_KEY, isDraftKey } = await import("../web/draftKeys.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

async function asyncTest(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Command (mutates globalThis.fetch for the duration of `fn`). Run `fn` with
 *  `fetch` replaced by one that returns `body` (JSON-encoded) for every call,
 *  then restore the real fetch (or its absence) afterwards — so one test's mock
 *  can never leak into the next. */
async function withFetchReturning(body, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  try {
    await fn();
  } finally {
    if (real === undefined) delete globalThis.fetch;
    else globalThis.fetch = real;
  }
}

const TWO_PROJECTS = [
  { name: "RobotSim", mtime: 1769800000, slideCount: 5 },
  { name: "Q3 Slides", mtime: 1769700000, slideCount: 12 },
];
// The exact shape a stray draft row would carry if the server ever answered
// with one (it structurally cannot — see the docblock above) — included to
// prove the CLIENT filter holds even so, not to claim the server does this.
const WITH_STRAY_DRAFT = [...TWO_PROJECTS, { name: DRAFT_KEY, mtime: 1769900000, slideCount: 3 }];

await asyncTest("httpProjectStore.list passes an ordinary listing through unchanged", async () => {
  await withFetchReturning(TWO_PROJECTS, async () => {
    const listed = await httpProjectStore.list();
    assert.deepEqual(listed, TWO_PROJECTS);
  });
});

await asyncTest("httpProjectStore.list excludes the draft key even if the server ever answered with one", async () => {
  await withFetchReturning(WITH_STRAY_DRAFT, async () => {
    const listed = await httpProjectStore.list();
    assert.deepEqual(listed.map((p) => p.name).sort(), TWO_PROJECTS.map((p) => p.name).sort());
    assert.ok(!listed.some((p) => isDraftKey(p.name)), "a draft-keyed row must never survive the list seam");
  });
});

await asyncTest("httpProjectStore.list of an empty library is an empty array, not a missing one", async () => {
  await withFetchReturning([], async () => {
    assert.deepEqual(await httpProjectStore.list(), []);
  });
});

test("isDraftKey is the exact predicate the filter runs — restating '~draft/' anywhere else would drift", () => {
  // Pinned here too (not just in draft_keys_test.js) because THIS file's claim is
  // "the list seam filters with THIS predicate", which only means something if
  // the predicate itself is pinned at the point of use.
  assert.equal(isDraftKey(DRAFT_KEY), true);
  assert.equal(isDraftKey("RobotSim"), false);
});

console.log(`\n${passed} project-list draft-filter tests passed.`);
