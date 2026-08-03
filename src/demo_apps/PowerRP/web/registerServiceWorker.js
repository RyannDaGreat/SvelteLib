/**
 * registerServiceWorker.js — WHERE the static-mode-only rule is enforced.
 *
 * `web/sw.js` documents WHY the worker must never run on the dev server or in
 * Electron; this is the one place that decides. It is deliberately separate from
 * the worker itself, because the worker cannot decline to exist — by the time
 * its code runs it is already installed.
 *
 * ── THE THREE CONDITIONS, ALL REQUIRED ───────────────────────────────────────
 * 1. `import.meta.env.PROD` — a BUILD-time constant, so on the Vite dev server
 *    this whole function is dead code and the browser never sees a registration
 *    call at all. That is what keeps a cached bundle from ever fighting HMR: not
 *    a runtime check that could be wrong, but a branch that is not in the dev
 *    bundle. (`vite build` + `vite preview` DOES register — that is the static
 *    rehearsal, and it is exactly the thing the offline probe needs to test.)
 * 2. `serviceWorker` in navigator — absent in older/embedded webviews, and its
 *    absence is not an error: the app works, it simply is not offline-capable.
 * 3. NOT a `file:` origin — Electron loads local files, where service workers
 *    are unavailable AND unnecessary (those files are already on disk). Checking
 *    the protocol rather than sniffing for Electron keeps this true for any
 *    local-file host, present or future.
 *
 * ── NOT REGISTERING IS NOT ENOUGH IN DEV (WORKSTREAM AI) ─────────────────────
 * A service worker OUTLIVES the code that registered it. Condition 1 has always
 * meant "dev never registers one", which is not the same claim as "dev is never
 * CONTROLLED by one" — and the difference is a real machine state, not a corner
 * case. Any developer who has ever run `vite build && vite preview`, or opened
 * the deployed site, on `localhost` has a worker registered against that ORIGIN;
 * scope is per-origin-and-path, and the dev server is the same origin. The dev
 * page then boots under a worker serving a months-old precached bundle while the
 * terminal happily reports HMR updates for files the browser will never see.
 * That is a phantom-bug factory, and it was a suspect in the incident this
 * workstream exists for: symptoms that survive a source fix, "fixes" that
 * reappear, and a stale mixed bundle set indistinguishable from a real bug.
 *
 * So dev does not merely abstain — it CLEANS UP, loudly (`unregisterInDev`). It
 * is one line of API and its console.info fires only when there was actually
 * something to remove, which makes it a diagnosis rather than noise: seeing that
 * line is the explanation for whatever inexplicable staleness came before it.
 * The caches are left alone deliberately; they are inert once no worker is
 * controlling the page, and deleting a build's precache from a dev session would
 * be this file reaching outside its own mode.
 *
 * ── SCOPE AND THE BASE PATH ──────────────────────────────────────────────────
 * The worker is registered at `import.meta.env.BASE_URL`, which vite bakes to
 * "/SvelteLib/" for the Pages deploy and "/" elsewhere. A worker's scope cannot
 * exceed its own path, so registering the base-root `sw.js` at the base scope is
 * what lets it control the app — and hardcoding "/sw.js" is precisely the bug
 * that would make it control nothing on Pages.
 *
 * ── ASKING FOR THE UPDATE, ONCE (WORKSTREAM AI) ──────────────────────────────
 * The worker's navigation routing is CACHE-FIRST now (see sw.js's "THE ATOMIC
 * SWAP"), so the shell document no longer carries deploy discovery. Discovery
 * belongs to the lifecycle instead, and `reg.update()` is the explicit ask: it
 * byte-compares `sw.js` and, on a change, installs the whole new version into a
 * new cache. It matters most for the case with no navigations at all — an
 * installed PWA left open for days, which is the very shape the manifest's
 * `display: standalone` encourages. It is fire-and-forget and it cannot disturb
 * the running session: without `skipWaiting` the new worker waits, and the page
 * keeps loading every byte from the version it booted with.
 *
 * ── FAILURE IS REPORTED, NEVER SWALLOWED ─────────────────────────────────────
 * A failed registration means the app is NOT offline-capable, which is a real
 * regression worth a console error even though the app keeps working. It does
 * not throw: an unavailable offline cache must not take down a boot that is
 * otherwise fine, and the page is by definition online at that moment.
 */

/**
 * Command (async; unregisters service workers). Removes any worker previously
 * registered against this origin. Called ONLY on the dev server — see the
 * docblock above for why abstaining from registration does not, by itself, mean
 * dev is uncontrolled.
 *
 * Silent when there was nothing to remove (the overwhelmingly common case, and
 * a log there would be pure noise); LOUD when it actually fires, because that
 * line is the answer to "why was this page serving stale modules".
 *
 * @returns {Promise<number>} how many registrations were removed
 *
 * @example // one planted by an earlier `vite preview` on the same origin:
 * // await unregisterInDev()  // logs "PowerRP dev: unregistered 1 service worker…" → 1
 * @example // the normal case, nothing registered:
 * // await unregisterInDev()  // → 0, no output
 */
export async function unregisterInDev() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return 0;
  const regs = await navigator.serviceWorker.getRegistrations();
  if (!regs.length) return 0;
  await Promise.all(regs.map((r) => r.unregister()));
  console.info(
    `PowerRP dev: unregistered ${regs.length} service worker(s) left over from a build on this origin. ` +
      `A dev page controlled by one serves CACHED modules while HMR reports updates you never see — reload once to be sure this page is clean.`,
  );
  return regs.length;
}

/**
 * Command (async; registers a service worker). Registers the offline cache in
 * static builds only, and in dev actively removes any worker a previous build
 * left behind. Safe to call unconditionally at boot.
 *
 * @returns {Promise<ServiceWorkerRegistration|null>} the registration, or null
 *   when this environment deliberately has no worker.
 *
 * @example // await registerServiceWorker() // null on the dev server; a registration on Pages
 */
export async function registerServiceWorker() {
  if (!import.meta.env.PROD) {
    await unregisterInDev();
    return null;
  }
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  if (location.protocol === "file:") return null;

  const base = import.meta.env.BASE_URL || "/";
  try {
    const reg = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
    console.info(`PowerRP: offline cache registered (scope ${reg.scope}) — this deck opens with no internet after this visit.`);
    // Deploy discovery, now that navigation is cache-first. Not awaited: an
    // update check is background work and its result changes nothing about this
    // page — a new version waits for the next reload by design.
    reg.update().catch((e) => console.info(`PowerRP: update check skipped (${e?.message ?? e})`));
    return reg;
  } catch (e) {
    console.error(`PowerRP: the offline cache could not be registered (${e?.message ?? e}) — the app works, but will NOT open offline.`);
    return null;
  }
}
