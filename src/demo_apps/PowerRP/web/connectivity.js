/**
 * connectivity.js — THE ONE SEAM that answers "is the INTERNET reachable".
 *
 * User ruling: "every widget should be online and offline capable and be able
 * to tell. So for the iconify, it should give you a notice that you can't
 * search through it because you're offline. It should know that. And that's
 * true even if I'm on the online one and my internet goes down or I'm using the
 * Electron app or however I'm running it locally — it's the same mechanism. You
 * should just know that it's offline."
 *
 * ── THE BOUNDARY: TWO AXES, AND THIS MODULE OWNS EXACTLY ONE ─────────────────
 * PowerRP has TWO independent reachability questions, and conflating them is
 * how an app tells a user the wrong thing with total confidence:
 *
 *   1. INTERNET reachable — can we reach a THIRD-PARTY host on the open web?
 *      api.iconify.design, api.github.com, an arbitrary .zip URL. THIS MODULE.
 *   2. BACKEND reachable — is the PowerRP project server there? That is
 *      `storageMode.js`'s question, decided ONCE at boot, and every server call
 *      reports its own failure. NOT this module's business, and deliberately so.
 *
 * They come apart in both directions, which is the whole reason for the split.
 * In ELECTRON the backend is a local process on loopback: the user's wifi can
 * die and saving keeps working perfectly. On a STATIC deploy (GitHub Pages)
 * there is no backend at ALL, yet the internet is plainly reachable — the page
 * itself came over it. A single "are we online" boolean would be a lie in both
 * cases. So: ask THIS module before touching the open web, ask storageMode /
 * the server call itself about the project server, and never substitute one
 * answer for the other.
 *
 * ── WHY navigator.onLine IS NOT ENOUGH, AND WHY IT IS STILL THE PRIMARY ──────
 * `navigator.onLine === false` is TRUSTWORTHY: the OS has no route, nothing
 * will reach anything, and we can say "offline" instantly with no request.
 * `navigator.onLine === true` is nearly MEANINGLESS: it reports only that some
 * interface has a link. A captive portal, a dead uplink, a VPN that dropped, an
 * airplane-wifi paywall — all report `true` while every request fails.
 *
 * Hence the two-tier design:
 *   · The FAST SIGNAL is `navigator.onLine` plus the `online`/`offline` events.
 *     Free, synchronous, and reactive. It is what the UI renders from.
 *   · VERIFICATION is a real request, and it runs ONLY when a consumer reports
 *     that a genuine call just failed (`reportFailure`). onLine=true plus a
 *     failed fetch is exactly the suspicious state the fast signal cannot
 *     resolve, and it is the only state worth spending a request on. We never
 *     poll: a background heartbeat would burn battery and data to answer a
 *     question nobody asked.
 *
 * ── WHY A DEDICATED SEAM RATHER THAN navigator.onLine AT EACH CALL SITE ──────
 * Three reasons, all of which bit other features in this repo first:
 *   1. ONE PLACE TO BE WRONG. The `true` caveat above is subtle. Written out
 *      once it is a documented design; copy-pasted to six call sites it is six
 *      chances to write `if (navigator.onLine)` and ship a confident lie.
 *   2. VERIFICATION IS SHARED. Six consumers failing at once must cost ONE
 *      probe, not six. The in-flight promise is memoized here.
 *   3. IT IS TESTABLE. A probe can drive this module's state; it cannot drive
 *      `navigator.onLine`, which is read-only in the page.
 * `tests/connectivity_seam_test.js` ENFORCES this by grep — a `navigator.onLine`
 * anywhere outside this file fails the bare-node gate. (Precedent: the native
 * `title=` guard test, same shape, same reason.)
 *
 * ── THE VERIFICATION TARGET ──────────────────────────────────────────────────
 * We probe a host we ALREADY depend on (api.iconify.design) rather than a
 * generic connectivity endpoint, with `mode: "no-cors"`. That answers the
 * question the app actually has — "can I reach the services I use" — and adds
 * no new third party to the trust surface. An opaque response is a SUCCESS: we
 * only care that bytes came back, never what they were. `cache: "no-store"` so
 * the service worker's runtime cache cannot answer a liveness question from
 * disk and report a dead network as healthy.
 */

/** How long a verification probe may take before we call the internet
 *  unreachable. Deliberately short: this runs only AFTER a consumer's real
 *  request already failed, so the user is already waiting, and a slow answer is
 *  worth less than a fast approximate one. */
const VERIFY_TIMEOUT_MS = 4000;

/** How long a verification RESULT is trusted before another failure may trigger
 *  a fresh probe. Without it, a burst of six failing consumers would each queue
 *  their own probe the instant the previous one resolved. */
const VERIFY_TTL_MS = 5000;

/** The host the probe pings — one we already depend on, so verification adds no
 *  new third party. See the docblock. */
const VERIFY_URL = "https://api.iconify.design/collections?prefix=mdi";

/** THE reactive online flag. `navigator.onLine` seeded at module load, then
 *  driven by the online/offline events and by verification results. This is the
 *  ONE place in the codebase that reads `navigator.onLine`. */
let online = typeof navigator === "undefined" ? true : navigator.onLine !== false;

/** Subscribers notified on every transition. A Set so double-subscription is
 *  impossible and unsubscribe is exact. */
const listeners = new Set();

/** The in-flight verification promise, so N simultaneous failures cost ONE
 *  request (docblock reason 2). Null when nothing is in flight. */
let verifyInFlight = null;

/** When the last verification RESOLVED (epoch ms), for VERIFY_TTL_MS. */
let verifiedAt = 0;

/**
 * Command. Sets the flag and notifies subscribers — but ONLY on a real
 * transition, so a listener never re-renders for an event that changed nothing.
 * A throwing listener is reported and the remaining listeners still run: one
 * broken consumer must not silence the others (the per-node paint boundary
 * rule, applied to notifications).
 */
function setOnline(next) {
  const value = next !== false;
  if (value === online) return;
  online = value;
  for (const fn of listeners) {
    try {
      fn(online);
    } catch (e) {
      console.error(`PowerRP connectivity: a listener threw on the ${online ? "online" : "offline"} transition —`, e);
    }
  }
}

/**
 * Query. Is the internet believed reachable right now?
 *
 * "BELIEVED" is the operative word and the honest one: this is the fast signal,
 * possibly refined by the last verification. `false` is reliable (see docblock);
 * `true` means "no reason to think otherwise". A consumer must still handle its
 * own request failing — this answers whether to TRY and what to SAY, never
 * whether a call will succeed.
 *
 * @returns {boolean}
 *
 * @example isOnline() // true — on a normal connection
 * @example // With wifi switched off: isOnline() === false, and no request was made to find out.
 */
export function isOnline() {
  return online;
}

/**
 * Command. Subscribes to connectivity transitions. Returns an unsubscribe
 * function — Svelte `$effect` teardown, or a probe's cleanup.
 *
 * Fires ONLY on a change, and the current value is available synchronously from
 * `isOnline()`, so a consumer reads first and subscribes for updates rather than
 * waiting for an initial callback that may never come.
 *
 * @param {(online: boolean) => void} fn
 * @returns {() => void} unsubscribe
 *
 * @example
 * // const stop = onConnectivityChange((up) => { if (up) retrySearch(); });
 * // …later: stop();
 */
export function onConnectivityChange(fn) {
  if (typeof fn !== "function") throw new TypeError(`onConnectivityChange: expected a function, got ${typeof fn}`);
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Command (async; network). VERIFIES reachability with a real request, updating
 * the flag from the answer. Shared: concurrent callers get the SAME in-flight
 * promise, and a result is reused for VERIFY_TTL_MS.
 *
 * Short-circuits to `false` without a request when `navigator.onLine` already
 * says offline — that direction is trustworthy, so spending a request on it
 * would be pure waste.
 *
 * NOT A SILENT FALLBACK: a failed probe is a real ANSWER ("the internet is not
 * reachable"), which the app then states in the consumer's own surface. Nothing
 * is swallowed — the caller's original error is still the caller's to report.
 *
 * @returns {Promise<boolean>}
 *
 * @example // await verifyConnectivity() // false behind a captive portal, though navigator.onLine is true
 */
export function verifyConnectivity() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setOnline(false);
    return Promise.resolve(false);
  }
  if (verifyInFlight) return verifyInFlight;
  if (Date.now() - verifiedAt < VERIFY_TTL_MS) return Promise.resolve(online);

  verifyInFlight = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), VERIFY_TIMEOUT_MS);
    let reachable = false;
    try {
      // An OPAQUE response counts: no-cors gives us no body and no status, and
      // that is fine — bytes came back, which is the entire question.
      await fetch(VERIFY_URL, { mode: "no-cors", cache: "no-store", signal: abort.signal });
      reachable = true;
    } catch {
      // The ONE expected condition this module exists to detect. Not swallowed:
      // it becomes the returned answer and the flag every consumer renders from.
      reachable = false;
    } finally {
      clearTimeout(timer);
    }
    verifiedAt = Date.now();
    verifyInFlight = null;
    setOnline(reachable);
    return reachable;
  })();
  return verifyInFlight;
}

/**
 * Command (async). What a consumer calls when one of ITS requests just failed:
 * "this broke — was it the network?". Returns whether the internet is reachable,
 * verifying when the fast signal is the untrustworthy `true`.
 *
 * This is the seam's main entry point for error paths, and the reason the module
 * never polls: a suspicious failure is the only evidence worth spending a
 * request on, and the consumer is the only thing that has it.
 *
 * @returns {Promise<boolean>} true if the internet is reachable (so the failure
 *   was something else — a 404, CORS, a bad URL, a dead third party)
 *
 * @example
 * // try { await fetch(url); }
 * // catch (e) {
 * //   if (!(await reportFailure())) throw new Error(offlineMessage("Icon search"));
 * //   throw e;   // genuinely online: the original error is the true one
 * // }
 */
export async function reportFailure() {
  if (!online) return false;
  return await verifyConnectivity();
}

/**
 * Pure function. THE offline sentence for a named capability — one phrasing,
 * everywhere, so the app never has two voices for one condition.
 *
 * It names the CAPABILITY, not the mechanism: "Offline — icon search needs the
 * internet" tells a user what they cannot do and why. "fetch failed" does not.
 *
 * @param {string} capability - what is unavailable, capitalized, e.g. "Icon search"
 * @returns {string}
 *
 * @example offlineMessage("Icon search")
 * 'Offline — icon search needs the internet'
 * @example offlineMessage("Saving to GitHub")
 * 'Offline — saving to GitHub needs the internet'
 */
export function offlineMessage(capability) {
  const name = String(capability ?? "").trim();
  if (!name) throw new Error("offlineMessage: needs a capability name");
  return `Offline — ${name.charAt(0).toLowerCase()}${name.slice(1)} needs the internet`;
}

/**
 * Pure function. The clause completing "Unavailable — requires …" for a command
 * that cannot run offline. Registry entries pass this as a function-valued
 * `requires` (the `save-project` precedent), read through
 * `commandUnavailableReason` — never off the raw field.
 *
 * @returns {string}
 *
 * @example offlineRequirement()
 * 'an internet connection'
 */
export function offlineRequirement() {
  return "an internet connection";
}

/**
 * Command. Wires the browser's online/offline events into the flag. Called ONCE
 * at boot (web/main.js). Idempotent, and a no-op outside a browser so bare-node
 * importers (tests, the CLI renderer) can read the module without a window.
 *
 * The events are the FAST signal: the OS knows about a lost route long before a
 * request times out, so an unplugged cable turns the iconify palette's notice on
 * with no request at all.
 */
let started = false;
export function startConnectivityWatch() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("online", () => {
    // The OS says a route exists; that is only the untrustworthy `true`. Show
    // it optimistically so the UI recovers immediately, then CONFIRM — if the
    // route is a captive portal, verification puts the notice straight back.
    setOnline(true);
    verifiedAt = 0; // this is new evidence: do not reuse a stale verdict
    verifyConnectivity();
  });
  window.addEventListener("offline", () => setOnline(false));
}

/**
 * Command. TEST SEAM: forces the flag and notifies, bypassing the browser.
 * Exists because `navigator.onLine` is read-only in the page, so a probe has no
 * other way to drive an offline state (docblock reason 3). Named to be obvious
 * in a grep — nothing in the app may call it.
 *
 * @param {boolean} value
 */
export function __setOnlineForTest(value) {
  verifiedAt = Date.now(); // suppress a probe that would immediately undo this
  setOnline(value);
}
