/**
 * The shared TEXT-ASSET registry — the text of a project asset, keyed by its
 * served URL (`/asset/<Project>/<file>`). This is the DATA seam: a widget whose
 * picture is a function of a CSV, a JSON table or any other textual asset reads it
 * through here.
 *
 * ── WHY A SECOND REGISTRY AND NOT svg_source_registry ────────────────────────
 * render_gpu/gpu/svg_source_registry.js already caches text by URL, and the
 * mechanism here is deliberately its twin (see the async contract below, which is
 * copied from it, which copied it from image_registry.js). It is NOT reused,
 * for one reason that is about MEANING rather than tidiness: that module's
 * failures are reported as `PowerRP svg_source_registry: failed to load …`, its
 * pending set is what web/renderJobPage.js gates SVG rasters on, and
 * plugins/svg.js + plugins/iconify.js draw their error affordances off its status.
 * Feeding CSV through it would make a missing spreadsheet report itself as a
 * broken SVG, and would put a data load in the raster gate under a name that
 * denies it is one. Two registries, two vocabularies, one shared contract shape.
 *
 * ── THE ASYNC CONTRACT (the image_registry precedent, verbatim) ──────────────
 *   - `ensureTextAsset(url)` kicks an idempotent load. Fire-and-forget; safe to
 *     call every frame (an already loading/ready/errored url is a no-op).
 *   - `getTextAsset(url)` is the SYNC query emit() uses: the text when ready,
 *     else null (draw nothing this frame; a repaint follows the load).
 *   - `onTextAssetLoad(cb)` nudges the reactive repaint drivers (the editor's
 *     paint loop is not a continuous rAF), returns an unsubscribe fn.
 *   - `pendingTextAssets()` is the headless render-job gate
 *     (web/renderJobPage.js pendingRasters) — a one-shot renderer must not write
 *     a frame while a data file is still in flight, or it ships a chart with no
 *     bars and exits 0.
 *
 * ── DETERMINISM (why a widget may read this at all) ─────────────────────────
 * A project asset's bytes are part of the DOCUMENT, not of the host: the zip
 * round-trip carries assets/, so every machine rendering a deck sees the same
 * CSV. So `getTextAsset(url)` is a pure function of the document once loaded —
 * property state, in CLAUDE.md's taxonomy, not recordable and certainly not
 * ephemeral. That is the whole reason this seam can exist without breaking
 * frame-range sharding: Δt = 0 leaves it byte-identical, and so does re-running
 * it on another machine.
 *
 * Loud failure discipline: a load that FAILS is reported once via console.error
 * and latched to "error" — never retried silently, never a silent blank. A
 * consumer must draw a visible error for an errored url (the "wrong art must not
 * look correct" rule), which is what makes a typo'd filename a red box rather
 * than an empty chart the author reads as "no data".
 *
 * Texts are cached forever by design (the image_registry argument: a project
 * asset URL is stable and the key space is bounded by the document's distinct
 * urls). resetTextAssetRegistry() is the test/invalidation hook.
 *
 * ── BARE NODE (cli/render.js — no fetch target, no browser) ─────────────────
 * `/asset/<Project>/<file>` urls are read STRAIGHT OFF DISK, synchronously
 * (projects/<Project>/assets/<file>, resolved RELATIVE to this module through
 * import.meta.url — the dump is portable). Synchronous on purpose: the same
 * emit() pass that asks for the text gets it, so the CLI renders a data-driven
 * chart in ONE pass with zero async machinery. This is why a CSV chart is one of
 * the few asset-backed widgets cli/render.js can actually draw. A non-asset URL
 * in bare node fails LOUDLY (latched "error") — the CLI has no origin to resolve
 * it against, and pretending otherwise is how holed pictures happen.
 *
 * DOM-free apart from `fetch`, and bare-node tested
 * (tests/csv_bar_graph_test.js).
 */

/** True in bare Node (cli/render.js + node suites), false in the browser bundle
 * — the svg_source_registry.js IS_NODE discriminator, verbatim. */
const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

/** url → {status: "loading"|"ready"|"error", text: string|null, error: Error|null, promise: Promise|null} */
const texts = new Map();

/** Repaint subscribers (see onTextAssetLoad); notified when any load resolves. */
const listeners = new Set();

/**
 * Query. The text of `url` if it is ready, else null. SYNC — what a data widget's
 * emit() calls on the render path. Null means "not loaded yet" (still in flight,
 * or a load error): draw nothing, or an error affordance, this frame.
 *
 * @param {string} url - a served asset url
 * @returns {string|null}
 *
 * @example getTextAsset("/asset/Deck/sales.csv") // null  (until ensureTextAsset resolves it)
 * @example // after a successful load: getTextAsset("/asset/Deck/sales.csv") // "region,units\nNorth,12\n"
 */
export function getTextAsset(url) {
  const entry = texts.get(url);
  return entry && entry.status === "ready" ? entry.text : null;
}

/**
 * Query. The load status of `url`: "unloaded" (never requested), "loading",
 * "ready", or "error" — lets emit() distinguish in-flight (draw nothing, a
 * repaint is coming) from failed (draw the loud error affordance).
 *
 * @param {string} url - a served asset url
 * @returns {"unloaded"|"loading"|"ready"|"error"}
 *
 * @example textAssetStatus("/asset/Deck/never_asked.csv") // "unloaded"
 */
export function textAssetStatus(url) {
  return texts.get(url)?.status ?? "unloaded";
}

/**
 * Query. The latched load-error message for `url`, or null when it has none —
 * the text a consumer puts inside its red error affordance.
 *
 * @param {string} url - a served asset url
 * @returns {string|null}
 *
 * @example textAssetError("/asset/Deck/sales.csv") // null  (no error latched)
 */
export function textAssetError(url) {
  const e = texts.get(url)?.error;
  return e ? e.message : null;
}

/**
 * Command (near-pure: idempotent). Ensures `url`'s text is loading into the
 * cache. A no-op if it is already loading, ready, or errored — safe to call on
 * every frame from a sync render pass. Browser: fetch → text (async). Bare node:
 * /asset/ urls are read off disk SYNCHRONOUSLY (status is "ready" or "error" by
 * the time this returns — see the module header).
 *
 * @param {string} url - a served asset url
 * @returns {Promise<string|null>} the text, or null on a (reported) failure
 *
 * @example // ensureTextAsset(url); ...later... getTextAsset(url) // "region,units\n…"
 */
export function ensureTextAsset(url) {
  if (typeof url !== "string" || url.length === 0)
    throw new Error(`ensureTextAsset: url must be a non-empty string, got ${JSON.stringify(url)}`);
  const existing = texts.get(url);
  if (existing) return existing.promise;

  const entry = { status: "loading", text: null, error: null, promise: null };
  texts.set(url, entry);

  const fail = (e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    console.error(`PowerRP text_asset_registry: failed to load "${url}" — ${entry.error.message}`);
    notify(url);
    return null;
  };

  if (IS_NODE) {
    // Synchronous disk read — same-pass availability for the bare-node CLI.
    try {
      entry.text = assetTextFromDisk(url);
      entry.status = "ready";
      entry.promise = Promise.resolve(entry.text);
      notify(url);
    } catch (e) {
      entry.promise = Promise.resolve(null);
      fail(e);
    }
    return entry.promise;
  }

  entry.promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    entry.status = "ready";
    entry.text = text;
    notify(url);
    return text;
  })().catch(fail);
  return entry.promise;
}

/**
 * Query. Every url still loading — what the headless render-job worker gates on
 * (web/renderJobPage.js pendingRasters): render, ask this, re-render after the
 * next onTextAssetLoad until the answer is empty. Returning URLS (not a count) is
 * what lets a stalled render name what stalled.
 *
 * @returns {string[]}
 *
 * @example pendingTextAssets() // []  (nothing requested yet)
 */
export function pendingTextAssets() {
  const urls = [];
  for (const [url, entry] of texts) if (entry.status === "loading") urls.push(url);
  return urls;
}

/**
 * Command. Subscribes to load-resolution events (a url became ready or errored);
 * returns an unsubscribe function. The editor's paint loop is reactive, so text
 * that arrives after the frame that requested it needs this to trigger a repaint.
 *
 * @param {function(string): void} cb - called with the resolved url
 * @returns {function(): void} unsubscribe
 *
 * @example // const off = onTextAssetLoad((url) => scheduleRepaint()); ... off();
 */
export function onTextAssetLoad(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Command. Notifies every repaint subscriber that `url` resolved. */
function notify(url) {
  for (const cb of listeners) cb(url);
}

/**
 * Command. Drops all cached texts — the test hook. Listeners are kept (they are
 * wiring, not data).
 *
 * @returns {void}
 *
 * @example // resetTextAssetRegistry(); textAssetStatus(anyUrl) // "unloaded"
 */
export function resetTextAssetRegistry() {
  texts.clear();
}

/**
 * Command (test hook). Seeds `url` with `text` as if a load had succeeded — how a
 * bare-node test pins a data widget's emit against a FIXED input string without
 * touching the filesystem, and how a caller with the bytes already in hand (an
 * import, a paste) can hand them over.
 *
 * @param {string} url - the key to seed
 * @param {string} text - the content
 * @returns {void}
 *
 * @example // seedTextAsset("/asset/T/x.csv", "a,b\n1,2\n"); getTextAsset("/asset/T/x.csv") // "a,b\n1,2\n"
 */
export function seedTextAsset(url, text) {
  if (typeof url !== "string" || !url) throw new Error(`seedTextAsset: url must be a non-empty string, got ${JSON.stringify(url)}`);
  if (typeof text !== "string") throw new Error(`seedTextAsset: text must be a string, got ${typeof text}`);
  texts.set(url, { status: "ready", text, error: null, promise: Promise.resolve(text) });
  notify(url);
}

/**
 * Query (bare node only). `/asset/<Project>/<file...>` → the file's text, read
 * from projects/<Project>/assets/<file...> RELATIVE to this module (dump-
 * portable; percent-encoding undone per segment, matching how the server mints
 * asset URLs). Anything else throws — the CLI has no origin to fetch against.
 *
 * @param {string} url - an /asset/ url
 * @returns {string} the file's utf8 text
 *
 * @example // assetTextFromDisk("/asset/Imitations/sample_data.csv") // "label,value\n…"
 */
function assetTextFromDisk(url) {
  const parts = url.split("/").filter(Boolean); // ["asset", project, ...file]
  if (parts[0] !== "asset" || parts.length < 3)
    throw new Error(`bare node can only load "/asset/<Project>/<file>" urls, got "${url}"`);
  if (typeof process.getBuiltinModule !== "function")
    throw new Error("node >= 22.3 needed to read text assets from disk (process.getBuiltinModule)");
  const fs = process.getBuiltinModule("node:fs");
  const project = decodeURIComponent(parts[1]);
  const file = parts.slice(2).map(decodeURIComponent).join("/");
  return fs.readFileSync(new URL(`../../projects/${project}/assets/${file}`, import.meta.url), "utf8");
}
