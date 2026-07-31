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
 *     The dev server also has a backend, so there is nothing to rescue.
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
 * 1. NAVIGATIONS → the cached `index.html`, network-first. The app is a single
 *    page, so any navigation (including a share link with `?zip=`/`?repo=`)
 *    resolves to that one document. Network-first so a deploy is picked up on
 *    the next online visit; cache is the fallback that makes offline work.
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
 * ── UPDATES ──────────────────────────────────────────────────────────────────
 * A new worker installs in the background and takes over on the NEXT load. No
 * `skipWaiting`, deliberately: swapping the bundle under a running editor could
 * load a new module against old in-memory state, and the user did not ask for a
 * reload in the middle of their work. Old caches are deleted on activate, so a
 * stale bundle cannot accumulate or be served after its version is gone.
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

/** The one third-party origin whose responses are runtime-cached. */
const ICONIFY_ORIGIN = "https://api.iconify.design";

/** The cached document every navigation resolves to (rule 1). Registration
 *  passes the scope-correct path, which matters under the `/SvelteLib/` base
 *  path on Pages — a hardcoded "/index.html" would miss. */
const SHELL_URL = self.__POWERRP_SHELL ?? "index.html";

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
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop superseded shell caches. The icon cache is deliberately spared.
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("powerrp-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n)),
      );
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
 * Query (async; network + cache). Rule 1 — network-first for the app shell.
 *
 * Network-first so a new deploy is seen on the next online visit rather than
 * being masked by the cache; the cached shell is the fallback that makes an
 * offline boot possible at all. A shell missing from BOTH is a broken install
 * and rethrows rather than returning a synthetic error page, because a fabricated
 * 200 would hide the failure from the very error surface built to report it.
 */
async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) {
      cache.put(SHELL_URL, res.clone());
      return res;
    }
    // A non-ok navigation (a 404 from a misconfigured host) still deserves the
    // cached shell if we have one — the app itself can then say what went wrong.
    const cached = await cache.match(SHELL_URL);
    return cached ?? res;
  } catch (e) {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    throw e;
  }
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
