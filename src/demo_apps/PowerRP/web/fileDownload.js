/**
 * fileDownload.js — SAVE BYTES TO THE USER'S DISK. One gesture, one definition.
 *
 * ── WHY THIS MODULE EXISTS (CLAUDE-ORIGINATED, round 6) ──────────────────────
 * The object-URL + `a[download]` + revoke idiom was written out by hand ELEVEN
 * times across web/ — AssetExplorer, DebugStoragePage twice, projectApi's zip
 * download, projectZip's `downloadBytes`, and seven more in app.svelte.js (deck
 * JSON, slide PNG/PDF/SVG, MP4, selection PDF). One of those copies documents in
 * its own docstring that it is a copy of another. That is the hand-maintained
 * mirror class: every copy looks reasonable when written, and they drift in
 * silence — these already had, on whether a failed download reports itself.
 *
 * `downloadBytes` KEEPS ITS NAME rather than being re-christened, because it was
 * already the one EXPORTED, DOCUMENTED spelling of this action (web/projectZip.js,
 * imported by app.svelte.js) and the rest were unnamed local expedients. A second
 * better name would still be a second name. What changed is its HOME — a general
 * "save this to disk" does not belong to the zip exporter — and its INPUT, which
 * now also takes a Blob, since most callers already hold one.
 *
 * A BLOB IS PASSED THROUGH, NOT RE-WRAPPED. `new Blob([existingBlob])` copies the
 * whole buffer, and the biggest caller here is a finished MP4 that can be
 * gigabytes (web/localRenderStore.js: "IndexedDB holds multi-gigabyte blobs").
 *
 * THE COPIES HAD ALREADY DRIFTED, WHICH IS THE POINT. Only two of them appended
 * the anchor to the document before clicking it, and web/AssetExplorer.svelte's
 * copy is the one that recorded WHY (see the body). The others would have failed
 * on that browser and nobody would have known which copy was right, because the
 * knowledge lived in a comment on one of them. Consolidating keeps the strictest
 * behaviour and its reason together.
 */

/**
 * Command (triggers a browser download; touches the DOM). Save `data` to the
 * user's disk as `filename`, through an object-URL anchor click.
 *
 * The object URL is revoked immediately after the click. That is safe — the
 * browser has already taken its own reference to the blob by then — and it is
 * what keeps a page that has downloaded fifty assets from holding fifty blobs
 * alive for its whole lifetime.
 *
 * LOUD ON A MISSING FILENAME: an anchor with an empty `download` attribute saves
 * the object URL's random UUID instead, which looks like a successful download of
 * a file the user can no longer identify.
 *
 * @param {Blob|Uint8Array|ArrayBuffer} data - the bytes. A Blob is used as-is.
 * @param {string} filename - the name to save under
 * @param {string} type - MIME type, used ONLY when `data` is not already a Blob
 * @returns {void}
 *
 * @example
 * >>> downloadBytes(zipBytes, "My Talk.zip", "application/zip")   // save dialog
 * @example
 * >>> downloadBytes(await assetStore().get("Deck", "clip.mp4"), "clip.mp4")
 */
export function downloadBytes(data, filename, type = "application/octet-stream") {
  const name = String(filename ?? "").trim();
  if (!name) throw new Error("downloadBytes: needs a filename — an empty one saves the object URL's UUID instead");
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  // Must be IN the document for the synthetic click to navigate in Firefox;
  // removed immediately after, so no stray node outlives the download. (Carried
  // verbatim from web/AssetExplorer.svelte's copy, the only one of the eleven
  // that recorded this — the others omitted the append and would have silently
  // failed there.)
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
