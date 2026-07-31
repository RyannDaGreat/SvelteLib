/**
 * THE BACKEND PRECONDITION, said OUT LOUD, for probes that cannot run without one.
 *
 * WHAT WENT WRONG WITHOUT IT. Several probes boot the real editor, which calls
 * /api/projects/ on load. `run_all.mjs` starts a backend and hands every browser
 * child a BACKEND_URL precisely because ~9 of one sweep's 12 failures were
 * `listAssets: 500` from nothing listening. But a probe run ALONE — which is what
 * triage does, and the FIRST thing anyone does with a red probe — gets no such
 * backend. Vite's /api proxy then answers ECONNREFUSED, the page logs a 500, and
 * a blanket "no boot errors" check fails with `console.error: Failed to load
 * resource: 500`. That message names neither the backend nor the missing env var,
 * so the probe reads as a broken app when the truth is a missing dependency. Two
 * probes (eq_highlight_ref, demo_widget) were unreadable this way.
 *
 * WHY A SKIP AND NOT A SILENT PASS OR A FAIL. A silent skip is indistinguishable
 * from a pass, which is how a suite stops being believed; a failure would make an
 * absent dependency look like a defect, which is the bug being fixed here. So the
 * probe exits 0 and PRINTS why, the same contract github_live_probe.js uses for an
 * offline machine. Under the gate the backend is always up, so this never fires
 * there — it changes nothing about what the gate proves.
 *
 * WHY NOT JUST ADD /500/ TO THE BOOT-NOISE FILTER. Because a 500 from a backend
 * that IS running is a real defect, and ignoring the string would swallow it
 * forever. The dependency is checked ONCE, up front, by asking the backend
 * directly — so a running-but-broken backend still fails the probe loudly.
 */

/** Where run_all.mjs (and vite.config.js's /api proxy) agree the backend lives. */
export const BACKEND_URL = process.env.BACKEND_URL || "";

/**
 * Query. Is a project backend actually answering at `url`?
 *
 * Near-pure (one HTTP GET, no mutation). A non-2xx counts as REACHABLE: this
 * answers "is something listening", not "is it healthy" — an unhealthy backend
 * must still fail the probe loudly rather than skip it.
 *
 * @param {string} url Backend origin, e.g. "http://localhost:8000".
 * @returns {Promise<boolean>}
 *
 * @example await backendIsUp("http://localhost:8000")
 * // true  — run_all.mjs's backend is listening; the probe runs for real
 * @example await backendIsUp("http://localhost:9")
 * // false — nothing listening; caller skips loudly instead of reporting a 500
 * @example await backendIsUp("")
 * // false — BACKEND_URL unset, which is the standalone-run case
 */
export async function backendIsUp(url) {
  if (!url) return false;
  try {
    await fetch(`${url}/api/projects/`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    // Connection refused / DNS / timeout — nothing is listening. The caller
    // turns this into a NAMED skip; it is never swallowed.
    return false;
  }
}

/**
 * Command. Exit 0 with a printed reason unless a backend is reachable.
 *
 * Call this before launching the browser in any probe whose page boot hits /api.
 * Returns normally when the backend is up, so the probe proceeds unchanged.
 *
 * @param {string} probeName Probe basename, for the printed line.
 * @returns {Promise<void>} Resolves if the backend is up; otherwise exits 0.
 *
 * @example await requireBackendOrSkip("eq_highlight_ref_probe");
 * // backend up   -> returns, probe runs
 * // backend down -> prints "SKIP — eq_highlight_ref_probe needs a project
 * //                 backend …" and exits 0
 */
export async function requireBackendOrSkip(probeName) {
  if (await backendIsUp(BACKEND_URL)) return;
  console.log(`SKIP — ${probeName} needs a project backend and BACKEND_URL names none that is listening` +
    (BACKEND_URL ? ` (tried ${BACKEND_URL})` : " (BACKEND_URL is unset)"));
  console.log("SKIPPED: this probe boots the editor, whose load calls /api/projects/; without a backend");
  console.log("         Vite's proxy answers ECONNREFUSED and the page logs a 500 that is NOT an app defect.");
  console.log("         Run it under the gate (node tests/run_all.mjs --only=browser --filter=<name>),");
  console.log("         which starts a backend and passes BACKEND_URL, or set BACKEND_URL yourself.");
  process.exit(0);
}
