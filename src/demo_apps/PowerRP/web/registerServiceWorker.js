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
 * ── SCOPE AND THE BASE PATH ──────────────────────────────────────────────────
 * The worker is registered at `import.meta.env.BASE_URL`, which vite bakes to
 * "/SvelteLib/" for the Pages deploy and "/" elsewhere. A worker's scope cannot
 * exceed its own path, so registering the base-root `sw.js` at the base scope is
 * what lets it control the app — and hardcoding "/sw.js" is precisely the bug
 * that would make it control nothing on Pages.
 *
 * ── FAILURE IS REPORTED, NEVER SWALLOWED ─────────────────────────────────────
 * A failed registration means the app is NOT offline-capable, which is a real
 * regression worth a console error even though the app keeps working. It does
 * not throw: an unavailable offline cache must not take down a boot that is
 * otherwise fine, and the page is by definition online at that moment.
 */

/**
 * Command (async; registers a service worker). Registers the offline cache in
 * static builds only. Safe to call unconditionally at boot — it is a no-op
 * everywhere the three conditions above are not all met.
 *
 * @returns {Promise<ServiceWorkerRegistration|null>} the registration, or null
 *   when this environment deliberately has no worker.
 *
 * @example // await registerServiceWorker() // null on the dev server; a registration on Pages
 */
export async function registerServiceWorker() {
  if (!import.meta.env.PROD) return null;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  if (location.protocol === "file:") return null;

  const base = import.meta.env.BASE_URL || "/";
  try {
    const reg = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
    console.info(`PowerRP: offline cache registered (scope ${reg.scope}) — this deck opens with no internet after this visit.`);
    return reg;
  } catch (e) {
    console.error(`PowerRP: the offline cache could not be registered (${e?.message ?? e}) — the app works, but will NOT open offline.`);
    return null;
  }
}
