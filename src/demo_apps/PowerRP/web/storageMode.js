/**
 * storageMode.js — WHICH storage adapter this page boots with, decided ONCE.
 *
 * The user asked for "a statically hostable version of this on the github too".
 * A static host serves files and nothing else: there is no Python backend to
 * save a project to, no ffmpeg to encode a render, no ffprobe to measure a clip.
 * So the app must be able to run entirely out of the BROWSER'S OWN storage — and
 * it must be honest about the features that genuinely cannot exist there.
 *
 * THE DECISION, in priority order:
 *
 *   1. `?static=1`  → LOCAL, unconditionally. The escape hatch for testing the
 *                     static build while a backend happens to be running, and
 *                     what the Pages deploy links to.
 *   2. `?backend=…` → HTTP, unconditionally. An explicitly named backend is a
 *                     statement of intent; falling back to local storage because
 *                     it happened to be down would silently open the WRONG
 *                     library and let the user edit a deck that isn't theirs.
 *   3. otherwise    → PROBE `/api/projects/`. It answers → HTTP. It does not →
 *                     LOCAL.
 *
 * WHY A PROBE AND NOT A BUILD FLAG: the same bundle is served by the dev server
 * (backend present) and by GitHub Pages (backend absent), and `run_server.sh`
 * users must keep getting server storage with no flag to remember. One cheap GET
 * at boot decides it. The probe is the EXISTING project-list route — no server
 * change, and a route the app calls seconds later anyway.
 *
 * NOT A SILENT FALLBACK: choosing LOCAL is a loud, VISIBLE state, not a quiet
 * degradation. It is reported on the console at boot, the app shows a static-mode
 * notice, and every server-only feature reports itself UNAVAILABLE by name
 * (`UNAVAILABLE_IN_STATIC`) instead of failing with a fetch error or a 404. The
 * rule that stays inviolate: a backend that was ASKED FOR and did not answer is
 * an ERROR (case 2), never a fallback.
 */

import { httpAssetStore, httpProjectStore, localAssetStore, localProjectStore } from "./assetStore.js";

/** How long the boot probe waits before calling the backend absent. Short
 *  because it gates the first paint, and a real backend is same-origin (the Vite
 *  proxy) or explicitly named — either way it answers in single-digit ms. A slow
 *  backend that misses this window still works: only the STORAGE CHOICE is
 *  timed out, and case 2 (?backend=) never probes at all. */
const PROBE_TIMEOUT_MS = 2000;

/** The route the probe pings — an EXISTING read-only endpoint (server.py
 *  `["api","projects"]`), so no server change was needed to add a health check. */
const PROBE_PATH = "/api/projects/";

/** The features that exist ONLY with a server, named so a UI can say WHICH thing
 *  is missing rather than showing a dead button. Each value is the user-facing
 *  reason string. These are the honest bounds of a static deployment:
 *
 *  - RENDER JOBS need a detached server process + ffmpeg (cli/render_job.js).
 *  - SERVER MP4 export needs ffmpeg. (The IN-PAGE encoder still works, so video
 *    export is not gone in static mode — only its server-side backend is.)
 *  - VIDEO DURATION probing needs ffprobe.
 *  - The CROSS-TAB CLIPBOARD needs the server's session store; the localStorage
 *    mirror already in app.svelte.js covers same-browser copy/paste, which is
 *    what static mode keeps.
 *  - THUMBNAIL PERSISTENCE needs the server's disk cache; thumbnails still
 *    render in-session (ensureAssetThumbnail already degrades loudly-once here). */
export const UNAVAILABLE_IN_STATIC = {
  renderJobs: "Render jobs need the PowerRP project server (they run ffmpeg in a detached process). Use in-page video export instead.",
  serverMp4: "Server-side MP4 encoding needs ffmpeg on a backend. The in-page encoder still works.",
  videoDuration: "Measuring a clip's length needs ffprobe on a backend. Enter the duration manually.",
  serverClipboard: "The cross-presentation clipboard needs a backend session. Copy/paste within this browser still works.",
  thumbnailCache: "Thumbnails are rendered fresh each session (persisting them needs a backend disk cache).",
};

/** The resolved mode: "http" | "local" | null before detect() has run. Read
 *  through storageMode() so a caller can never observe the null. */
let mode = null;

/** Why the mode is what it is — one sentence, shown in the static-mode notice
 *  and logged at boot. */
let reason = "";

/**
 * Pure function. The mode forced by the URL, or null when the URL forces
 * nothing (the probe then decides). Split out so it is testable without a
 * `location`.
 *
 * @param {string} search - a location.search string
 * @returns {{mode: "http"|"local", reason: string} | null}
 *
 * @example
 * >>> forcedMode("?static=1")
 * {mode: "local", reason: "?static=1 — forced browser-local storage"}
 * >>> forcedMode("?backend=http://box:3638")
 * {mode: "http", reason: "?backend=http://box:3638 — explicitly named backend"}
 * >>> forcedMode("")
 * null
 */
export function forcedMode(search) {
  const params = new URLSearchParams(search);
  if (params.get("static") === "1") return { mode: "local", reason: "?static=1 — forced browser-local storage" };
  const backend = params.get("backend");
  if (backend) return { mode: "http", reason: `?backend=${backend} — explicitly named backend` };
  return null;
}

/**
 * Query (network). Whether a backend answers at `base`. Any HTTP response counts
 * as PRESENT — even a 500 — because the question is "is a server there", and a
 * server that is there but unwell must be reported as a server error by the real
 * call, not silently swapped for local storage. Only a transport failure
 * (nothing listening, DNS, CORS) or the timeout counts as absent.
 *
 * @param {string} base - backend origin ("" = same origin, through the proxy)
 * @returns {Promise<boolean>}
 *
 * @example
 * >>> await backendAnswers("")        // dev server proxying to server.py
 * true
 * >>> await backendAnswers("")        // GitHub Pages: nothing behind /api/
 * false
 */
export async function backendAnswers(base = "") {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${PROBE_PATH}`, { signal: abort.signal });
    // A static host answers /api/projects/ with its own 404 HTML page, which is
    // a RESPONSE but not a backend. Requiring JSON is what tells the two apart —
    // without this check, GitHub Pages would look like a healthy server.
    if (!res.ok) return false;
    const type = res.headers.get("content-type") ?? "";
    return type.includes("json");
  } catch {
    // Transport failure or timeout: nothing is listening. This is the ONE place
    // a caught error legitimately becomes a boolean — it is the probe's ANSWER,
    // not a swallowed failure, and the answer is reported loudly by detect().
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Command (network + module state). Decide the storage mode ONCE and remember
 * it. Idempotent: later calls return the decision already made, so any number of
 * modules may await it during boot without re-probing.
 *
 * Reports the decision on the console either way — in static mode that console
 * line is the developer-facing half of the user-facing notice.
 *
 * @param {string} search - location.search (injectable for tests)
 * @returns {Promise<"http"|"local">}
 *
 * @example
 * >>> await detectStorageMode("")     // dev server running
 * "http"
 * >>> await detectStorageMode("")     // static host, no backend
 * "local"
 */
export async function detectStorageMode(search = typeof location === "undefined" ? "" : location.search) {
  if (mode) return mode;
  const forced = forcedMode(search);
  if (forced) {
    ({ mode, reason } = forced);
  } else if (await backendAnswers(new URLSearchParams(search).get("backend") ?? "")) {
    mode = "http";
    reason = "a project server answered /api/projects/";
  } else {
    mode = "local";
    reason = "no project server answered /api/projects/ — running on browser-local storage";
  }
  const say = mode === "local" ? console.warn : console.log;
  say(`PowerRP storage: ${mode.toUpperCase()} (${reason})`);
  return mode;
}

/** Query. The decided mode. Throws if read before detectStorageMode() — a
 *  module that reads storage before boot resolved it is a load-order BUG, and a
 *  default would hide it (and could open the wrong library). */
export function storageMode() {
  if (!mode) throw new Error("storageMode(): read before detectStorageMode() resolved — call it during boot");
  return mode;
}

/** Query. Whether this page is running WITHOUT a backend. The one predicate the
 *  UI branches on for server-only affordances. */
export function isStatic() {
  return storageMode() === "local";
}

/** Query. The one-sentence explanation of the current mode (for the notice). */
export function storageModeReason() {
  return reason;
}

/** Query. The asset store for this page's mode. */
export function assetStore() {
  return storageMode() === "local" ? localAssetStore : httpAssetStore;
}

/** Query. The project (document) store for this page's mode. */
export function projectStore() {
  return storageMode() === "local" ? localProjectStore : httpProjectStore;
}

/**
 * Command. Throw a NAMED unavailability error for a server-only feature. The
 * loud half of the static-mode contract: a caller that reaches a server-only
 * path in static mode gets a sentence explaining WHY and WHAT to use instead —
 * never a fetch error against a URL that was never going to exist.
 *
 * @param {keyof UNAVAILABLE_IN_STATIC} feature - which feature was reached
 * @throws {Error} always
 *
 * @example
 * >>> refuseInStatic("renderJobs")
 * Error: Render jobs need the PowerRP project server (they run ffmpeg in a detached process). Use in-page video export instead.
 */
export function refuseInStatic(feature) {
  const why = UNAVAILABLE_IN_STATIC[feature] ?? `"${feature}" needs the PowerRP project server.`;
  throw new Error(why);
}
