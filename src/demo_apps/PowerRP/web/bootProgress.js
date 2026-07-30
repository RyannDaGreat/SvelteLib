/**
 * THE BOOT-PROGRESS SEAM — the one channel between the loaders that take time
 * (CanvasKit's ~7 MB wasm, the font files, the storage-mode probe) and the
 * INLINE splash in web/index.html that covers the gray canvas from t=0.
 *
 * WHY IT IS A TINY MODULE AND NOT AN IMPORT: the splash script runs BEFORE any
 * bundle exists (that is the entire point — a module import cannot paint at
 * document-parse time), so it cannot import this file and this file cannot
 * import it. They meet at ONE global, `window.__powerrp_boot`, installed by the
 * inline script and consumed here. Everything in this module is a no-op when
 * that global is absent (the `?cli=1` page, a probe harness, bare node), so a
 * loader never has to ask whether a splash exists.
 *
 * HONEST NUMBERS ONLY (the ruling precedent: the desktop first-run page shows
 * REAL progress, not a fake spinner). A stage reports bytes ONLY when the server
 * gave a Content-Length; otherwise it reports bytes-so-far with no total and the
 * splash renders an indeterminate bar. There is no synthetic percentage anywhere
 * in this path — a made-up number is worse than an honest "still working".
 */

/** Query. The splash's control object, or null when no splash is on the page. */
function splash() {
  return typeof window === "undefined" ? null : (window.__powerrp_boot ?? null);
}

/**
 * Command (updates the splash; no-op without one). Reports a named stage.
 *
 * @param {string} id Stable stage key ("wasm", "fonts", "storage", "frame").
 * @param {string} label Human text shown on the splash line.
 * @param {{loaded?: number, total?: number, unit?: "bytes"|"count", done?: boolean}} [detail]
 *   `loaded`/`total` are BYTES by default; `unit: "count"` means they are ITEM
 *   counts (the font stage counts faces, which arrive in parallel), and the
 *   splash formats accordingly instead of printing "7.0 MB" for "7 faces".
 *   `total` omitted ⇒ indeterminate.
 *
 * @example // bootStage("wasm", "Graphics engine", {loaded: 1048576, total: 7340032})
 * @example // bootStage("fonts", "Fonts", {loaded: 7, total: 14, unit: "count"})
 */
export function bootStage(id, label, detail = {}) {
  splash()?.stage(id, label, detail);
}

/**
 * Command (removes the splash; no-op without one). Called at the FIRST REAL
 * CANVAS PAINT — not on a timer — so the splash lifts exactly when there is
 * something behind it. Idempotent: the splash ignores repeat calls.
 *
 * @example // bootDone() — called from CanvasView once gpu.render has run
 */
export function bootDone() {
  splash()?.done();
}

/**
 * Command (shows the failure on the splash; no-op without one). A boot that
 * throws before the first frame must SAY SO — "a gray box forever" is the
 * current failure mode and is exactly what this replaces.
 *
 * @example // bootFailed("Skia/WebGL init failed: MakeWebGLContext returned null")
 */
export function bootFailed(message) {
  splash()?.fail(String(message));
}

/**
 * Command (fetches `url` streaming; reports byte progress through bootStage).
 * Returns the complete bytes as an ArrayBuffer.
 *
 * THE POINT: this is how the big wasm download gets a REAL number. `fetch` +
 * a ReadableStream reader lets us count bytes as they arrive; Content-Length
 * gives the denominator when the server sends one. It is absent for a
 * gzip/br-encoded response and on some static hosts, and in that case we report
 * bytes-so-far with NO total rather than inventing a denominator — the splash
 * shows an indeterminate bar and the megabyte counter still ticks, which is
 * honest and still tells the user the download is alive.
 *
 * Failure is LOUD: a rejected fetch or a non-OK status throws, and the caller
 * (browser_canvaskit) lets it reach the splash's error surface. Nothing here
 * silently falls back to a second download — the bytes it returns are handed
 * straight to CanvasKitInit, so the wasm is fetched exactly ONCE.
 *
 * @param {string} url Absolute or base-relative URL of the asset.
 * @param {string} id Stage key for bootStage.
 * @param {string} label Human stage label.
 * @returns {Promise<ArrayBuffer>}
 *
 * @example // await fetchWithProgress("/assets/canvaskit-abc123.wasm", "wasm", "Graphics engine")
 */
export async function fetchWithProgress(url, id, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchWithProgress: ${url} → HTTP ${res.status} ${res.statusText}`);
  // Content-Length is the honest denominator when present. It is absent for a
  // compressed response (the header then describes the COMPRESSED size and the
  // browser strips it) — treated as unknown, never guessed.
  const header = res.headers.get("content-length");
  const total = header ? Number(header) : 0;
  // No streaming body (an opaque or already-buffered response): fall back to
  // arrayBuffer() and report the one final number. Still honest — just coarse.
  if (!res.body?.getReader) {
    const buf = await res.arrayBuffer();
    bootStage(id, label, { loaded: buf.byteLength, total: buf.byteLength, done: true });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  bootStage(id, label, { loaded: 0, total: total > 0 ? total : undefined });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    bootStage(id, label, { loaded, total: total > 0 ? total : undefined });
  }
  // Concatenate once at the end — CanvasKitInit wants one contiguous buffer.
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  bootStage(id, label, { loaded, total: loaded, done: true });
  return out.buffer;
}
