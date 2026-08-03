/**
 * sw.js — THE SERVICE WORKER, and the reason the static site works with no
 * internet at all.
 *
 * User ruling: "This is a progressive app and should be able to work offline and
 * online. I would like the site to be able to save itself regardless, like in the
 * browser when you're not there, even the static site."
 *
 * ── STATIC MODE ONLY (this is a hard rule, enforced at the registration site) ─
 * `web/registerServiceWorker.js` registers this ONLY on a built static deploy,
 * never on the Vite dev server and never in Electron:
 *   · DEV SERVER — a service worker serving a cached bundle to a page that HMR
 *     is trying to hot-patch is a debugging nightmare with no upside: it would
 *     answer with yesterday's module while the editor insists it just reloaded.
 *     The dev server also has a backend, so there is nothing to rescue. AND
 *     ABSTAINING IS NOT SUFFICIENT: a worker survives the code that registered
 *     it, and `localhost` is one origin shared with `vite preview` and any
 *     locally-served build — so the registration site also UNREGISTERS in dev.
 *     See its docblock; that cleanup was a suspect in the incident behind the
 *     atomic swap below.
 *   · ELECTRON — loads local files off disk. Those are already offline; a cache
 *     in front of them is pure overhead. The CONNECTIVITY SEAM still works there,
 *     which is the part of "offline capable" Electron actually needs.
 * The static deploy is the only place with a real problem to solve: a page whose
 * every byte, including a ~7 MB wasm, arrives over the network.
 *
 * ── WHAT IS PRECACHED, AND WHY THE LIST IS GENERATED ─────────────────────────
 * `self.__POWERRP_PRECACHE` is substituted at BUILD time by the vite plugin in
 * `web/swBuildPlugin.js` — it is literally every file vite emitted. It is
 * generated rather than hand-written because the bundle's filenames are content
 * hashes: any hand-maintained list is wrong the moment a source file changes,
 * and wrong here means an app that boots offline into a blank screen.
 *
 * THE ~7 MB CANVASKIT WASM IS THE POINT. It is the single biggest asset and the
 * one the boot splash meters; without it in the cache the editor cannot paint a
 * frame, so an "offline-capable" app that omitted it would show its own loading
 * bar forever. It is in the emitted set, so it is precached by construction —
 * and `install` FAILS LOUDLY if any precache entry does not land, rather than
 * activating a worker that will strand the user at the splash.
 *
 * ── THE THREE ROUTING RULES ──────────────────────────────────────────────────
 * 1. NAVIGATIONS → THIS VERSION'S cached `index.html`, CACHE-FIRST. See "THE
 *    ATOMIC SWAP" below for why this is cache-first and not network-first: a
 *    document fetched from the network belongs to whatever version the server is
 *    serving RIGHT NOW, and this worker only has THIS version's chunks.
 * 2. PRECACHED BUNDLE ASSETS → cache-first. They are content-hashed, so a hit is
 *    by definition the right bytes and revalidating would be wasted latency on
 *    every boot.
 * 3. api.iconify.design → STALE-WHILE-REVALIDATE. An icon already fetched keeps
 *    rendering offline (the user's "previously-fetched icons render offline"),
 *    while an online visit quietly refreshes it. Note the DIVISION OF LABOUR
 *    with the connectivity seam: this makes already-seen icons DRAW offline; it
 *    does NOT make SEARCH work, because a search is a query for icons never
 *    fetched. That is exactly why the palette still needs its own offline
 *    notice — the cache cannot invent results, and pretending otherwise by
 *    silently returning nothing is the bug the notice exists to prevent.
 *
 * EVERYTHING ELSE IS NOT INTERCEPTED. Backend `/api/` and `/asset/` calls, the
 * GitHub API and arbitrary zip URLs all pass straight through to the network:
 * caching a project save would be a correctness disaster, and caching a
 * reachability-sensitive call would let a dead network look healthy (which is
 * why connectivity.js's own probe sets `cache: "no-store"`).
 *
 * ── THE ATOMIC SWAP (WORKSTREAM AI) ──────────────────────────────────────────
 * THE LAW: at no instant may a page load assets from two different versions.
 *
 * This is not a hypothetical. The incident, user verbatim: "it actually crashed
 * when it was loading and I couldn't tell". The crash was
 * `properties.bundle: unknown bundle "transform"` — a PRE-rename properties chunk
 * evaluated against POST-rename plugin chunks. HEAD was consistent; the browser
 * was not. The two halves of that build never existed together in any deploy: the
 * service worker assembled the chimera locally.
 *
 * HOW IT ASSEMBLED IT, precisely, because the mechanism is not obvious. Rule 1
 * used to be NETWORK-FIRST and, on success, wrote the fetched document into the
 * RUNNING worker's own shell cache:
 *     const res = await fetch(request);
 *     if (res.ok) { cache.put(SHELL_URL, res.clone()); return res; }
 * After a deploy, a page controlled by version A navigates, the network answers
 * with version B's index.html, and that document — naming B's content-hashed
 * chunks — is stored in A'S CACHE. A's precache does not contain B's chunks, so
 * rule 2 misses and falls through to the network, which papers over it while the
 * user is online and the deploy is intact. The moment either is untrue (offline,
 * a flaky request, an atomically-replaced deploy, a CDN mid-propagation) the page
 * gets B's HTML and whatever mix of A and B chunks the network happens to yield.
 * That cache entry OUTLIVES the session: A's cache is now permanently poisoned
 * with a document it cannot satisfy, and every later offline boot from A is the
 * chimera. One line, and the whole offline guarantee is conditional on luck.
 *
 * THE FIX IS A RULE ABOUT OWNERSHIP, not a retry or a checksum: A VERSION'S CACHE
 * CONTAINS ONLY THAT VERSION'S BYTES. Nothing writes into `SHELL_CACHE` except
 * `install`'s single `addAll`, which is all-or-nothing. So:
 *   · Rule 1 is CACHE-FIRST from this version's shell (`shellFirst` below). The
 *     cached document is the one whose chunks this worker provably holds — that
 *     is the entire content of "complete". The network is the fallback for the
 *     one case the cache cannot answer (a first navigation racing install).
 *   · Nothing puts a network response into a shell cache. Ever. The only writer
 *     is `addAll`.
 * A version therefore either serves a COMPLETE self-consistent set or does not
 * exist. There is no partial state to observe, which is what makes it atomic.
 *
 * WHAT REPLACED NETWORK-FIRST AS THE UPDATE MECHANISM. Network-first existed so a
 * deploy was picked up on the next online visit; that job now belongs where it
 * always should have — to the SERVICE WORKER LIFECYCLE, which is atomic by
 * construction. The browser byte-compares `sw.js` on navigation (and on
 * `registration.update()`, which `registerServiceWorker.js` calls); a changed
 * VERSION constant means a new worker, which precaches the WHOLE new bundle into
 * a NEW cache name, and only reaches `activate` if every byte landed. The version
 * string is a hash of the precache list, so any bundle change is a new worker by
 * construction. A user is never more than one reload behind, and the reload they
 * get is a complete version rather than a fresh document over stale chunks.
 *
 * ── THE MID-SESSION UPDATE ───────────────────────────────────────────────────
 * A new version installing while the editor is open must not disturb it, and
 * does not:
 *   1. INSTALL precaches into its OWN new cache name. The running page's cache is
 *      a different name and is never written to, so every asset the live page
 *      lazily loads (a font, a plugin chunk, the mermaid bundle) still comes from
 *      the version it booted with.
 *   2. NO `skipWaiting`, deliberately and now doubly so. Swapping the controller
 *      under a running editor is exactly how you get new modules against old
 *      in-memory state — the same class of mismatch, one layer up. It waits.
 *   3. THE NEXT RELOAD activates it, at which point `activate` claims and the page
 *      loads entirely from the new complete cache.
 * `install`-time pruning (below) is what keeps this from costing unbounded disk,
 * and it is careful never to delete the generation the live page is pinned to.
 *
 * BECAUSE of that, `activate` (where the old cleanup lived) never runs while any
 * tab from a prior deploy stays open — the new worker sits WAITING forever behind
 * the live page. A user who keeps a tab open across N deploys therefore installs
 * N full ~33 MB shell generations before a single one is ever collected: that is
 * the 131.9 MB-for-33.3 MB-precache bug this file was patched to fix. The install
 * handler below prunes DURING INSTALL instead of waiting for activate, capping the
 * damage at two generations (the one still serving live pages, plus the one that
 * just finished installing) no matter how many deploys accumulate behind it.
 *
 * The one thing install-time pruning must never do is delete the cache an OPEN
 * TAB is being served from — that tab has no way to re-fetch bytes it already
 * has a cache handle for, so deleting them out from under it would break offline
 * support for a page this very deploy promised to keep working. The installing
 * worker cannot read "which worker is currently active" directly (there is no
 * such accessor), so `activate` writes its OWN version into a tiny durable
 * record (`recordActiveVersion`, stored as a Response body in `META_CACHE` —
 * reusing Cache Storage rather than adding an IndexedDB dependency for one
 * string) every time a worker actually takes over. `install` then reads that
 * record (`readActiveVersion`) and treats it, plus the version installing right
 * now, as the two names `pruneShellCacheNames` must never delete. Everything
 * else named `powerrp-shell-*` is a generation no live page can be pinned to
 * (its worker either finished activating, in which case the record has moved
 * past it, or it never activated at all) and is safe to delete immediately
 * rather than waiting for this worker's own activate.
 *
 * `activate`'s sweep (below) still runs too, unchanged — it is what collects
 * THIS worker's predecessor once this worker finally does take over, and it is
 * the backstop if the meta record is ever missing (e.g. the very first install
 * on a fresh browser, where "no record yet" correctly prunes nothing).
 *
 * `pruneShellCacheNames` itself lives in `swPrune.js`, not here — see that
 * file's header for why the decision function needs to be a real ES module
 * (bare-node testable) even though this file, its only runtime caller, cannot
 * contain an `import` statement. `swBuildPlugin.js` inlines its source into
 * the emitted worker at build time.
 */

/** The precache manifest, substituted at build time (see swBuildPlugin.js).
 *  The empty default is what makes this file readable/lintable as-is; a real
 *  build always replaces it, and `install` refuses an empty list rather than
 *  activating a worker that caches nothing and silently does nothing. */
const PRECACHE_URLS = self.__POWERRP_PRECACHE ?? [];

/** Cache version, substituted at build time from the manifest's content hash so
 *  a new deploy gets a new cache and old entries are collectable. */
const VERSION = self.__POWERRP_SW_VERSION ?? "dev";

/** The precached app shell. */
const SHELL_CACHE = `powerrp-shell-${VERSION}`;

/** Runtime cache for third-party icon requests (rule 3). NOT versioned: its
 *  entries are icons, which are valid across deploys, and dropping them on every
 *  release would silently un-cache the offline icon set the user built up. */
const ICON_CACHE = "powerrp-icons";

/** Tiny durable record of which version is currently ACTIVE — one Response
 *  whose body is the version string, stored under `ACTIVE_VERSION_KEY`. Cache
 *  Storage rather than IndexedDB: it is the one persistence API already in use
 *  here, available synchronously alongside the caches this file already opens,
 *  and a single string needs nothing IndexedDB adds (schemas, transactions). */
const META_CACHE = "powerrp-meta";
const ACTIVE_VERSION_KEY = "https://powerrp.internal/active-shell-version";

/** The one third-party origin whose responses are runtime-cached. */
const ICONIFY_ORIGIN = "https://api.iconify.design";

/** The cached document every navigation resolves to (rule 1). Registration
 *  passes the scope-correct path, which matters under the `/SvelteLib/` base
 *  path on Pages — a hardcoded "/index.html" would miss. */
const SHELL_URL = self.__POWERRP_SHELL ?? "index.html";

/** Query (async). Reads the recorded active shell-cache name, or null if no
 *  worker has activated yet (fresh install) or the meta cache was never
 *  written for some other reason — both are treated as "nothing provably safe
 *  to delete", never as license to guess. */
async function readActiveVersion() {
  const cache = await caches.open(META_CACHE);
  const res = await cache.match(ACTIVE_VERSION_KEY);
  return res ? res.text() : null;
}

/** Command. Records `SHELL_CACHE` as the active version, for the NEXT worker's
 *  install-time prune to read. Called from `activate`, i.e. only once this
 *  worker has actually taken over — recording earlier would claim a version is
 *  live before any page is served from it. */
async function recordActiveVersion() {
  const cache = await caches.open(META_CACHE);
  await cache.put(ACTIVE_VERSION_KEY, new Response(SHELL_CACHE));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (!PRECACHE_URLS.length) {
        // LOUD, not silent. A worker with nothing cached would install happily
        // and then leave the user at a dead boot splash the first time they
        // opened the app without a network — a failure that would look like a
        // broken app rather than a broken build.
        throw new Error("PowerRP SW: empty precache manifest — the build plugin did not substitute __POWERRP_PRECACHE");
      }
      const cache = await caches.open(SHELL_CACHE);
      // addAll is ATOMIC: any single 404 rejects the whole install, so a worker
      // never activates holding a partial shell. That is the behaviour we want
      // — a missing chunk offline is indistinguishable from a broken app.
      await cache.addAll(PRECACHE_URLS);

      // Prune stale generations NOW rather than waiting for activate, which may
      // never run while a prior deploy's tab stays open (see the UPDATES
      // docblock above). Keeps at most this generation plus whichever one is
      // currently live.
      const activeVersion = await readActiveVersion();
      const names = await caches.keys();
      const stale = pruneShellCacheNames(names, SHELL_CACHE, activeVersion);
      await Promise.all(stale.map((n) => caches.delete(n)));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop superseded shell caches. Install already pruned everything it
      // could prove stale; this sweep is the backstop for the one case install
      // could not resolve on its own — no active record yet on a fresh browser
      // — and for a generation that only becomes provably stale by THIS
      // worker's own takeover. The icon cache is deliberately spared.
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("powerrp-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n)),
      );
      await recordActiveVersion();
      await self.clients.claim();
    })(),
  );
});

/**
 * Query (async; network + cache). Rule 3 — stale-while-revalidate.
 *
 * Returns the cached response IMMEDIATELY when there is one, and refreshes it in
 * the background. A background refresh that fails is EXPECTED (that is the
 * offline case, and the whole reason the cache exists), so it does not reject
 * the response the caller already has — but it is not swallowed either: with no
 * cached copy to fall back on, the error propagates to the page, where the
 * iconify registry reports it exactly as it always has.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(ICON_CACHE);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch((e) => {
      if (cached) return cached; // offline with a cached icon: the point of this cache
      throw e; // nothing cached and no network — the page must hear about it
    });
  return cached ?? fresh;
}

/**
 * Query (async; cache, then network only as a fallback). Rule 1 — the app shell,
 * CACHE-FIRST, and cache-first is the load-bearing half of the atomic swap.
 *
 * THIS FUNCTION USED TO BE NETWORK-FIRST AND THAT WAS THE VERSION-SKEW BUG. See
 * "THE ATOMIC SWAP" in the header: fetching the document from the network hands
 * back whatever version the server is serving right now, while THIS worker holds
 * only its own version's chunks — and the old code additionally STORED that
 * foreign document in this version's cache, poisoning it permanently. Both are
 * gone. The cached shell is served because it is the one document whose every
 * chunk this worker provably has, which is the whole definition of a complete
 * version. Staleness is not the cost people assume: the browser re-checks `sw.js`
 * on navigation, so a deploy still lands on the next reload — through the worker
 * lifecycle, which swaps a whole version at once instead of one file at a time.
 *
 * THE NETWORK FALLBACK is for the one case the cache genuinely cannot answer: a
 * navigation controlled by a worker whose install has not finished (or whose
 * cache a browser has evicted). Its response is NOT cached — writing it would
 * reintroduce exactly the mixing this function was rewritten to prevent.
 *
 * A shell missing from BOTH is a broken install and rethrows rather than
 * returning a synthetic error page, because a fabricated 200 would hide the
 * failure from the very error surface built to report it.
 */
async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_URL);
  if (cached) return cached;
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only GET is ever cacheable, and only same-origin plus the one named third
  // party is ever intercepted. A POST to the backend or the GitHub API must
  // reach the network untouched.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(shellFirst(request)); // rule 1
    return;
  }

  if (url.origin === ICONIFY_ORIGIN) {
    event.respondWith(staleWhileRevalidate(request)); // rule 3
    return;
  }

  if (url.origin === self.location.origin) {
    // Rule 2 — cache-first, but ONLY for what we actually precached. An
    // uncached same-origin path is a backend call (/api/, /asset/, /render/)
    // and must not be intercepted: falling through to the network is what keeps
    // a project save a project save.
    event.respondWith(
      (async () => {
        const cached = await caches.match(request, { cacheName: SHELL_CACHE });
        return cached ?? fetch(request);
      })(),
    );
  }
});
