/**
 * The shared SVG-SOURCE registry — SVG text keyed by its source URL (what the
 * svg widget stores in `svgUrl` when `svgSource: "url"`). The image_registry.js
 * contract, mirrored for TEXT instead of bitmaps: the render path is SYNC-shaped
 * (emit → sceneIR), a URL fetch is not, so emit() consults this cache and the
 * fetch happens strictly upstream of the flatten (render_gpu/gpu/svg_raster.js
 * stays synchronous and pure — the fetch NEVER lives inside parse/flatten).
 *
 * ── THE ASYNC CONTRACT (the image_registry precedent, verbatim) ───────────────
 *   - `ensureSvgSource(url)` kicks an idempotent load. Fire-and-forget; safe to
 *     call every frame (an already loading/ready/errored url is a no-op).
 *   - `getSvgSource(url)` is the SYNC query emit() uses: the SVG text when
 *     ready, else null (draw nothing this frame; a repaint follows the load).
 *   - `onSvgSourceLoad(cb)` nudges the reactive repaint drivers (the editor's
 *     paint loop is not a continuous rAF), returns an unsubscribe fn.
 *   - `pendingSvgSources()` is the headless render-job gate
 *     (web/renderJobPage.js pendingRasters) — a one-shot renderer must not
 *     write a frame while an SVG source is still in flight, or it ships a hole.
 *
 * Loud failure discipline: a load that FAILS is reported once via console.error
 * and latched to "error" — never retried silently, never a silent blank. The
 * svg widget draws its red errorAffordance for an errored url (the same "wrong
 * art must not look correct" rule its malformed-source path follows).
 *
 * Sources are cached forever by design (the image_registry argument: a project
 * asset URL is stable and the key space is bounded by the document's distinct
 * SVG urls). resetSvgSourceRegistry() is the test/invalidation hook.
 *
 * ── BARE NODE (cli/render.js — no fetch target, no browser) ──────────────────
 * The one renderer with no system dependency reads `/asset/<Project>/<file>`
 * URLs STRAIGHT OFF DISK, synchronously (projects/<Project>/assets/<file>,
 * resolved RELATIVE to this module through import.meta.url — the dump is
 * portable, the svg_raster.js cursorsFromDisk precedent). Synchronous on
 * purpose: the same emit() pass that asks for the source gets it, so the CLI
 * still renders icon decks in one pass with zero async machinery. A non-asset
 * URL in bare node fails LOUDLY (latched "error") — the CLI has no origin to
 * resolve it against, and pretending otherwise is how holed pictures happen.
 */

/** True in bare Node (cli/render.js + node suites), false in the browser bundle
 * — the svg_raster.js IS_NODE discriminator, verbatim. */
const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

/** url → {status: "loading"|"ready"|"error", text: string|null, error: Error|null, promise: Promise|null} */
const sources = new Map();

/** Repaint subscribers (see onSvgSourceLoad); notified when any load resolves. */
const listeners = new Set();

/**
 * Query. The SVG text for `url` if it is ready, else null. SYNC — what the svg
 * widget's emit() calls on the render path. Null means "not loaded yet" (still
 * in flight, or a load error): draw nothing this frame.
 *
 * @example getSvgSource("/asset/Deck/logo.svg") // null  (until ensureSvgSource resolves it)
 */
export function getSvgSource(url) {
  const entry = sources.get(url);
  return entry && entry.status === "ready" ? entry.text : null;
}

/**
 * Query. The load status of `url`: "unloaded" (never requested), "loading",
 * "ready", or "error" — lets emit() distinguish in-flight (draw nothing, a
 * repaint is coming) from failed (draw the loud error affordance).
 *
 * @example svgSourceStatus("nope://x") // "unloaded"
 */
export function svgSourceStatus(url) {
  return sources.get(url)?.status ?? "unloaded";
}

/**
 * Query. The latched load-error message for `url`, or null when it has none —
 * the text the svg widget puts inside its red errorAffordance.
 *
 * @example svgSourceError("/asset/Deck/logo.svg") // null  (no error latched)
 */
export function svgSourceError(url) {
  const e = sources.get(url)?.error;
  return e ? e.message : null;
}

/**
 * Command (near-pure: idempotent). Ensures `url`'s SVG text is loading into the
 * cache. A no-op if it is already loading, ready, or errored — safe to call on
 * every frame from a sync render pass. Browser: fetch → text (async). Bare
 * node: /asset/ urls are read off disk SYNCHRONOUSLY (status is "ready" or
 * "error" by the time this returns — see the module header).
 *
 * @example // ensureSvgSource(url); ...later... getSvgSource(url) → "<svg .../>"
 */
export function ensureSvgSource(url) {
  if (typeof url !== "string" || url.length === 0)
    throw new Error(`ensureSvgSource: url must be a non-empty string, got ${JSON.stringify(url)}`);
  const existing = sources.get(url);
  if (existing) return existing.promise;

  const entry = { status: "loading", text: null, error: null, promise: null };
  sources.set(url, entry);

  const fail = (e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    console.error(`PowerRP svg_source_registry: failed to load "${url}" — ${entry.error.message}`);
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
 * Query. Every url still loading — what the headless render-job worker gates
 * on (web/renderJobPage.js pendingRasters): render, ask this, re-render after
 * the next onSvgSourceLoad until the answer is empty. Returning URLS (not a
 * count) is what lets a stalled render name what stalled.
 *
 * @example pendingSvgSources() // []  (nothing requested yet)
 */
export function pendingSvgSources() {
  const urls = [];
  for (const [url, entry] of sources) if (entry.status === "loading") urls.push(url);
  return urls;
}

/**
 * Query. Every one of the SVG sources whose fetch/parse PERMANENTLY FAILED — the counterpart of pendingSvgSources.
 *
 * NOT A PARTITION WITH IT, deliberately: "pending" means wait longer, so a
 * permanently failed entry is excluded there and, until this existed, belonged to
 * NEITHER set. A one-shot render read "nothing pending" as "the frame is whole"
 * and wrote a hole at exit 0 — the R6-12.1 mechanism, which was fixed for video
 * only. Added alongside failedImageRefs so all four registries answer the same
 * two questions.
 *
 * @returns {string[]} entries whose status is "error"
 *
 * @example failedSvgSources() // [] on a clean registry
 */
export function failedSvgSources() {
  const urls = [];
  for (const [url, entry] of sources) if (entry.status === "error") urls.push(url);
  return urls;
}

/**
 * Command. Subscribes to load-resolution events (a url became ready or
 * errored); returns an unsubscribe function. The editor's paint loop is
 * reactive, so a source that arrives after the frame that requested it needs
 * this to trigger a repaint.
 *
 * @example // const off = onSvgSourceLoad((url) => scheduleRepaint()); ... off();
 */
export function onSvgSourceLoad(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Command. Notifies every repaint subscriber that `url` resolved. */
function notify(url) {
  for (const cb of listeners) cb(url);
}

/**
 * Command. Drops all cached sources and state — the test hook. Listeners are
 * kept (they are wiring, not data).
 */
export function resetSvgSourceRegistry() {
  sources.clear();
}

/**
 * Query (bare node only). `/asset/<Project>/<file...>` → the file's text, read
 * from projects/<Project>/assets/<file...> RELATIVE to this module (dump-
 * portable; percent-encoding undone per segment, matching how the server mints
 * asset URLs). Anything else throws — the CLI has no origin to fetch against.
 *
 * @example // assetTextFromDisk("/asset/Imitations/icons/database.svg") // "<svg ...>"
 */
function assetTextFromDisk(url) {
  const parts = url.split("/").filter(Boolean); // ["asset", project, ...file]
  if (parts[0] !== "asset" || parts.length < 3)
    throw new Error(`bare node can only load "/asset/<Project>/<file>" svg urls, got "${url}"`);
  if (typeof process.getBuiltinModule !== "function")
    throw new Error("node >= 22.3 needed to read asset svgs from disk (process.getBuiltinModule)");
  const fs = process.getBuiltinModule("node:fs");
  const project = decodeURIComponent(parts[1]);
  const file = parts.slice(2).map(decodeURIComponent).join("/");
  return fs.readFileSync(new URL(`../../projects/${project}/assets/${file}`, import.meta.url), "utf8");
}
