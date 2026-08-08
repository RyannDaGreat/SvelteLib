/**
 * SURGE'S BIG BINARIES — fetched from the WebSurge deploy, cached beside the app,
 * and NEVER in the service worker's shell cache.
 *
 * ── THE RULING, AND WHAT IT COSTS (user, 2026-08-08) ────────────────────────
 * "it pulls presets on the fly form server (u can refernce urls from the other repo
 * it's stable to keep storage git cost down in our repo if that helps)".
 *
 * Surge's runtime is 56 MB in three files. Vendoring them would MORE THAN DOUBLE
 * this repository — 30 MB of packed patches and wavetables plus a 19 MB GUI wasm,
 * none of which compresses or deltas usefully across commits, all of it duplicated
 * in every clone forever. So the SMALL, TEXTUAL half is vendored (the worklet
 * bundle, the Emscripten glue, the 57 KB archive index, the licence — 292 KB total,
 * in `vendor/websurge/`) and the three LARGE BINARIES are fetched at runtime from
 * the upstream Pages deploy. MEASURED: it answers `access-control-allow-origin: *`,
 * so this works from the dev server AND from PowerRP's own Pages build; and the
 * three `content-length`s match the vendored index exactly (the archive's last
 * entry ends at byte 30,477,332, which IS the blob's size).
 *
 * ── THE THREE COSTS, STATED RATHER THAN HIDDEN ──────────────────────────────
 * These are real and they are the trade the ruling makes. They are written here so
 * a future reader finds them beside the decision instead of discovering them:
 *   1. **IT DOES NOT WORK OFFLINE UNTIL SOMETHING IS CACHED.** The first Surge node
 *      on a fresh install needs the network. Every other widget in PowerRP works
 *      offline; this one does not, and it is the only one.
 *   2. **IT IS A HARD DEPENDENCY ON A THIRD-PARTY HOST STAYING UP.** If
 *      `ryanndagreat.github.io/WebSurge` moves or goes away, every Surge node in
 *      every saved deck stops making sound. Nothing here can repair that, which is
 *      why `remoteFailure()` names the host in its sentence — the one useful thing
 *      a failure can do is say who did not answer.
 *   3. **56 MB IS A REAL DOWNLOAD.** Hence `onProgress`: a modal that sits blank
 *      for a minute is indistinguishable from a broken one.
 *
 * ── THE CACHE IS SEPARATE FROM THE SHELL, AND THAT IS LOAD-BEARING ──────────
 * CLAUDE.md: "THE SERVICE WORKER'S LAW IS ATOMICITY … A version's shell cache is
 * written by exactly ONE thing — `install`'s all-or-nothing `addAll` … A network
 * response is never stored in a shell cache; that write is what built the chimera."
 *
 * So these bytes go in their OWN Cache Storage bucket, opened directly from here,
 * and `web/sw.js` neither knows nor precaches them. That is not a workaround, it is
 * the invariant working as designed: the shell cache guarantees that a page's
 * assets all come from ONE app version, and these are not app assets at all — they
 * are a pinned third-party artifact whose identity is the URL itself. Putting them
 * in the shell would mean a 56 MB `addAll` that must succeed atomically before the
 * app boots at all, which would make every deploy fail on a slow link. Putting them
 * in a separate, VERSION-NAMED bucket means they survive app deploys (they are not
 * invalidated by a new shell) and are re-fetched only when the pin below changes.
 *
 * Bare-node safe: no Vite syntax, no top-level browser globals, no AudioContext. It
 * is imported by `synth/modules_surge.js`, which the whole node test lane reaches
 * through `synth/modules.js`; everything browser-only is behind a function call.
 */

/**
 * THE PIN. Every byte Surge loads comes from this one origin+path, and it is
 * spelled ONCE so a move is a one-line change rather than a hunt.
 *
 * A COMMIT-PINNED URL WOULD BE SAFER AND IS NOT AVAILABLE: GitHub Pages serves only
 * the published branch, with no per-commit addressing, so "stable" here means the
 * upstream author not moving the files — which is exactly the dependency cost #2
 * above names. `raw.githubusercontent.com/<user>/<repo>/<sha>/…` WOULD be
 * immutable, and is the upgrade to make if this ever breaks.
 */
export const SURGE_REMOTE_BASE = "https://ryanndagreat.github.io/WebSurge/src";

/** The 5.4 MB DSP module. Fetched by the MAIN thread and handed to the worklet as an
 *  ArrayBuffer through `processorOptions` — an AudioWorkletGlobalScope has neither
 *  `fetch` nor XHR, so the worklet structurally cannot load this itself. */
export const SURGE_ENGINE_WASM_URL = `${SURGE_REMOTE_BASE}/js/surge-engine.wasm`;
/** The 18.9 MB GUI module. Fetched by EMSCRIPTEN'S OWN GLUE, not by us: the ES6
 *  build resolves `surge-gui.wasm` against its module URL, so the vendored glue
 *  would look for it next to itself. `locateFile` is the documented override and is
 *  how web/surgeGui.js points it here. */
export const SURGE_GUI_WASM_URL = `${SURGE_REMOTE_BASE}/js/surge-gui.wasm`;
/** The 29 MB packed archive: factory patches and wavetables. Unpacked into each
 *  module's MEMFS *before* its init call — SurgeStorage scans in its constructor, so
 *  a tree that appears afterwards is invisible to Surge forever. */
export const SURGE_DATA_BIN_URL = `${SURGE_REMOTE_BASE}/data/surge-data.bin`;
/** The on-demand third-party patch index (2,920 entries). Each `.fxp` under
 *  `data/patches_3rdparty/` is fetched individually when the author picks it. */
export const SURGE_REMOTE_INDEX_URL = `${SURGE_REMOTE_BASE}/data/surge-remote.json`;

/**
 * THE CACHE NAME, and the reason it carries a version. Bumping it re-fetches
 * everything; nothing else does, because a URL under a fixed pin is treated as
 * immutable. Deliberately prefixed `powerrp-surge-` so it is obvious in devtools
 * that it is neither the shell cache nor anything the service worker manages.
 */
export const SURGE_CACHE = "powerrp-surge-remote-v1";

/**
 * Pure function. The sentence a failed Surge fetch reports.
 *
 * IT NAMES THE HOST, because that is the only actionable thing about this failure:
 * the user cannot fix a network, but they can tell "my wifi is off" from "the
 * upstream project moved its files", and those need different responses. A bare
 * "failed to load Surge" is the silent-ish failure this project forbids.
 *
 * @param {string} url - the URL that did not answer
 * @param {string} why - the underlying reason (an HTTP status or an error message)
 * @returns {string}
 *
 * @example remoteFailure("https://x/y.wasm", "HTTP 404").includes("y.wasm") // true
 * @example remoteFailure("https://x/y.wasm", "HTTP 404").includes("offline") // true
 */
export function remoteFailure(url, why) {
  return `Surge could not load ${url} (${why}). Surge XT's 56 MB runtime is NOT vendored in this repository — it is fetched from ${SURGE_REMOTE_BASE} and cached locally, so the FIRST use on a machine needs network access and cannot work offline. If that host is unreachable or has moved, every Surge node is silent until it is back.`;
}

/**
 * Command (network + cache; browser-only). The bytes at `url`, from the Surge cache
 * when present and from the network otherwise, reporting download progress.
 *
 * ── WHY IT WRITES THE CACHE ITSELF RATHER THAN LETTING THE SW DO IT ─────────
 * See the header: the service worker must never store a network response in a shell
 * cache. This function owns a DIFFERENT cache, so the invariant is untouched — and
 * the write is explicit and local, which is what makes that reviewable.
 *
 * PROGRESS COMES FROM THE STREAM, not from `content-length` alone, because a 30 MB
 * blob on a slow link is otherwise a frozen dialog. A response with no readable body
 * (or a browser without `body.getReader`) falls back to `arrayBuffer()` and reports
 * one 100% tick rather than failing — degrading the progress bar is fine; failing
 * the load because progress was unavailable is not.
 *
 * @param {string} url - one of the URLs above
 * @param {(p: {loaded: number, total: number}) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 * @throws {Error} with `remoteFailure`'s sentence, on any network or status failure
 */
export async function fetchSurgeAsset(url, onProgress = undefined) {
  const cache = await caches?.open(SURGE_CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(remoteFailure(url, err?.message ?? String(err)));
  }
  if (!response.ok) throw new Error(remoteFailure(url, `HTTP ${response.status}`));

  // The cache is written from a CLONE, before the body is consumed for progress —
  // a Response body may be read exactly once, and reading it for the progress
  // stream would leave nothing to store.
  const total = Number(response.headers.get("content-length")) || 0;
  if (cache) await cache.put(url, response.clone()).catch(() => {});

  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ loaded: buffer.byteLength, total: buffer.byteLength });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out.buffer;
}
