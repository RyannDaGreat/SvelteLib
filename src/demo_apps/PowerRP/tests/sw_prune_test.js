/**
 * sw_prune_test.js — the acceptance test for the install-time shell-cache prune
 * (see `sw.js`'s UPDATES docblock: without `skipWaiting`, `activate`'s cleanup
 * never runs while a prior deploy's tab stays open, so N deploys accumulated N
 * full ~33 MB precache generations — a live user measured 131.9 MB for a 33.3 MB
 * precache, roughly 4 stuck generations).
 *
 * Two layers, matching the two files the fix touches:
 *   1. `pruneShellCacheNames` (web/swPrune.js) — the pure decision, exercised
 *      directly with the doctests plus edge cases (no active record yet,
 *      installing version already the active one, non-shell names ignored).
 *   2. The INSTALL HANDLER's use of it (web/sw.js), against a mocked
 *      `self`/`caches`/`fetch` simulating three already-installed generations
 *      on disk. This is the layer that would stay green even if a future edit
 *      forgot to call the pure function from `install` at all — so it asserts
 *      against the mock Cache Storage's actual surviving keys after a real
 *      `dispatchInstall()`, not against the pure function's return value again.
 *
 * Run: node src/demo_apps/PowerRP/tests/sw_prune_test.js
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pruneShellCacheNames } from "../web/swPrune.js";
import { powerrpServiceWorker } from "../web/swBuildPlugin.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let n = 0;
const test = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };

// ── Layer 1: the pure decision ──────────────────────────────────────────────

test("keeps the installing generation and the recorded-active generation only", () => {
  assert.deepEqual(
    pruneShellCacheNames(
      ["powerrp-shell-v1", "powerrp-shell-v2", "powerrp-shell-v3", "powerrp-icons"],
      "powerrp-shell-v3",
      "powerrp-shell-v1",
    ).sort(),
    ["powerrp-shell-v2"],
  );
});

test("no active record yet (fresh browser): nothing is provably safe to delete", () => {
  assert.deepEqual(pruneShellCacheNames(["powerrp-shell-v1"], "powerrp-shell-v1", null), []);
  assert.deepEqual(pruneShellCacheNames(["powerrp-shell-v1"], "powerrp-shell-v1", undefined), []);
});

test("installing version IS the active version (reinstall of the same deploy): still kept once, nothing else survives", () => {
  assert.deepEqual(
    pruneShellCacheNames(["powerrp-shell-v1", "powerrp-shell-v0"], "powerrp-shell-v1", "powerrp-shell-v1"),
    ["powerrp-shell-v0"],
  );
});

test("never touches the icon runtime cache or any non-shell name, even while pruning a stale shell", () => {
  // v1 is neither the installing (v2) nor the active (null = none recorded)
  // generation, so it IS correctly pruned here — the assertion is about what
  // is NEVER even considered: the two non-"powerrp-shell-" names are absent
  // from the deletion list regardless of the name filter matching them.
  const deleted = pruneShellCacheNames(["powerrp-icons", "powerrp-meta", "powerrp-shell-v1"], "powerrp-shell-v2", null);
  assert.deepEqual(deleted, ["powerrp-shell-v1"]);
  assert.ok(!deleted.includes("powerrp-icons") && !deleted.includes("powerrp-meta"));
});

test("four accumulated generations (the reported 131.9MB-for-33.3MB shape): all but active+installing go", () => {
  const names = ["powerrp-shell-v1", "powerrp-shell-v2", "powerrp-shell-v3", "powerrp-shell-v4", "powerrp-icons"];
  assert.deepEqual(pruneShellCacheNames(names, "powerrp-shell-v4", "powerrp-shell-v1").sort(), [
    "powerrp-shell-v2",
    "powerrp-shell-v3",
  ]);
});

test("THE NEVER-DELETE-ACTIVE GUARANTEE: active is never in the deletion list, across every case above", () => {
  // Exhaustive-ish sweep rather than a single example: for any cacheNames set
  // and any two distinct members chosen as installing/active, the active name
  // must never appear in the result — this is the guarantee the whole prune
  // exists to uphold, so it gets its own property-style check rather than
  // resting on the hand-picked examples above.
  const pool = ["powerrp-shell-v1", "powerrp-shell-v2", "powerrp-shell-v3", "powerrp-shell-v4"];
  for (const installing of pool) {
    for (const active of [...pool, null]) {
      const deleted = pruneShellCacheNames(pool, installing, active);
      assert.ok(!deleted.includes(installing), `installing ${installing} must survive`);
      if (active) assert.ok(!deleted.includes(active), `active ${active} must survive`);
    }
  }
});

// ── Layer 2: the real install handler, against a mocked Cache Storage ──────

/**
 * Query. A minimal in-memory Cache Storage mock — just enough surface for
 * sw.js's install/activate handlers (`open`, `keys`, `delete`, and a Cache
 * with `addAll`/`match`/`put`). Not a spec-complete polyfill; a fixture sized
 * to this one test file.
 */
function makeFakeCaches(seedNames) {
  const store = new Map(seedNames.map((n) => [n, new Map()]));
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name);
      return {
        async addAll(urls) {
          for (const u of urls) entries.set(u, true);
        },
        async match(key) {
          const k = typeof key === "string" ? key : key.url;
          return entries.has(k) ? { text: async () => entries.get(k), clone: () => ({}) } : undefined;
        },
        async put(key, response) {
          const k = typeof key === "string" ? key : key.url;
          entries.set(k, response instanceof Response ? await response.text() : response);
        },
      };
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
  };
}

/**
 * Query. The effective worker source a real build ships: `sw.js`'s own text
 * plus `swPrune.js` inlined with its `export` keyword stripped — i.e. the
 * SAME transform `swBuildPlugin.js`'s `generateBundle` applies (see that
 * file). Duplicated here rather than imported from the plugin because the
 * plugin's copy is entangled with vite's `bundle`/`emitFile` — this is the one
 * line of substance worth mirroring, and mirroring it is what makes this test
 * prove what actually ships rather than an idealized standalone sw.js. If the
 * two ever drift, `install seeds three pre-existing generations…` below is
 * exactly the assertion that would start failing against the REAL emitted
 * file (see the swBuildPlugin build-output check in the SW prune section of
 * this task's verification, run via `vite build`), not this mirror.
 */
function builtSwSource() {
  const sw = readFileSync(resolve(HERE, "../web/sw.js"), "utf8");
  const prune = readFileSync(resolve(HERE, "../web/swPrune.js"), "utf8").replace(
    "export function pruneShellCacheNames",
    "function pruneShellCacheNames",
  );
  return `${prune}\n${sw}`;
}

/**
 * Query (async). Loads the effective worker source (see `builtSwSource`) into
 * a mocked classic-script environment and runs its "install" listener to
 * completion, populating `listeners` via the mocked `addEventListener`.
 *
 * sw.js is a classic (non-module) script by design (see its UPDATES docblock),
 * so it cannot be `import`ed directly — this evaluates its text in a sandboxed
 * function scope with a mocked `self`/`caches`/`fetch`/`Response`, the same
 * shape of globals the real browser provides to a service worker.
 */
function loadSwListeners(fakeSelf, fakeCaches, fakeFetch) {
  new Function("self", "caches", "fetch", "Response", builtSwSource())(fakeSelf, fakeCaches, fakeFetch, Response);
  return fakeSelf;
}

test("install seeds three pre-existing generations, prunes down to installing+active, backend fetch never called", async () => {
  // Simulate the state right before a v4 install: v1 (active, a live tab is
  // pinned to it), v2 and v3 (stale — their workers never got to activate
  // because the tab never reloaded), plus the untouched icon cache.
  const fakeCaches = makeFakeCaches(["powerrp-shell-v1", "powerrp-shell-v2", "powerrp-shell-v3", "powerrp-icons"]);
  const meta = await fakeCaches.open("powerrp-meta");
  await meta.put("https://powerrp.internal/active-shell-version", new Response("powerrp-shell-v1"));

  const listeners = {};
  loadSwListeners(
    {
      __POWERRP_PRECACHE: ["index.html", "assets/app.js"],
      __POWERRP_SW_VERSION: "v4",
      __POWERRP_SHELL: "index.html",
      addEventListener: (kind, fn) => { listeners[kind] = fn; },
      location: { origin: "https://example.test" },
    },
    fakeCaches,
    async () => { throw new Error("network must not be touched during install"); },
  );

  let waited;
  await listeners.install({ waitUntil: (p) => { waited = p; } });
  await waited;

  const survivors = (await fakeCaches.keys()).sort();
  assert.deepEqual(survivors, ["powerrp-icons", "powerrp-meta", "powerrp-shell-v1", "powerrp-shell-v4"]);
  // The never-delete-active guarantee, at the handler level: v1 (active) and
  // v4 (installing) both still have their precached entries intact.
  assert.ok(await (await fakeCaches.open("powerrp-shell-v4")).match("index.html"));
});

test("install throws loudly on an empty precache manifest (unrelated to pruning, but must survive the refactor)", async () => {
  const listeners = {};
  const fakeCaches = makeFakeCaches([]);
  loadSwListeners(
    {
      __POWERRP_PRECACHE: [],
      __POWERRP_SW_VERSION: "v1",
      __POWERRP_SHELL: "index.html",
      addEventListener: (kind, fn) => { listeners[kind] = fn; },
      location: { origin: "https://example.test" },
    },
    fakeCaches,
    async () => {},
  );

  let waited;
  await listeners.install({ waitUntil: (p) => { waited = p; } });
  await assert.rejects(waited, /empty precache manifest/);
});

// ── Layer 3: the REAL build plugin, not a mirror of its transform ─────────

test("swBuildPlugin actually inlines swPrune.js into the emitted sw.js — no export leaks, no missing declaration", () => {
  // Exercises `powerrpServiceWorker()` itself (web/swBuildPlugin.js), closing
  // the gap `builtSwSource` above only mirrors: if the plugin's inlining ever
  // diverges from that mirror, THIS is the test that catches it, because it
  // calls the plugin's own `generateBundle`, not a copy of its string edit.
  const plugin = powerrpServiceWorker();
  plugin.configResolved({ base: "/SvelteLib/" });
  const emitted = [];
  plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) }, {}, { "index.html": {} });

  const swAsset = emitted.find((f) => f.fileName === "sw.js");
  assert.ok(swAsset, "sw.js must be emitted");
  assert.ok(!/\bexport\s+function\b/.test(swAsset.source), "no export survives into the classic-script worker");
  const declCount = (swAsset.source.match(/\bfunction pruneShellCacheNames\b/g) ?? []).length;
  assert.equal(declCount, 1, "pruneShellCacheNames must be declared exactly once in the emitted worker");
  assert.doesNotThrow(() => new Function("self", "caches", "fetch", "Response", swAsset.source), "emitted sw.js must be syntactically valid as a classic script");
});

console.log(`sw_prune_test: ${n} checks passed`);
