/**
 * projectApi.js — thin client for the PowerRP project server (server/server.py).
 *
 * Projects are FOLDERS server-side (doc.json + assets/); this module is the
 * fetch layer the app's Save/Open/Download commands call. Same-origin by
 * default: the Vite dev server proxies /api and /asset to the Python backend
 * (see vite.config.js), so the app uses relative paths and keeps HMR on one
 * URL. Override the backend with ?backend=http://host:port.
 *
 * Every call throws LOUDLY on a non-OK response (no silent fallback) — the
 * command layer surfaces the error to the user/console.
 */

const params = new URLSearchParams(location.search);
export const BACKEND = params.get("backend") || "";

const enc = encodeURIComponent;

/** DataTransfer MIME type for an asset-tile drag (Asset Explorer → canvas).
 *  Payload: JSON {name, kind, url}. ONE home so the drag source (the pane)
 *  and the drop target (CanvasView) can never disagree. */
export const ASSET_DRAG_MIME = "application/x-powerrp-asset";

/** Query. Absolute (proxied) URL of an asset file, given the server's relative
 *  url ("/asset/<name>/<file>"). Used by the asset explorer / image widget. */
export const assetUrl = (relativeUrl) => `${BACKEND}${relativeUrl}`;

async function jsonOrThrow(res, label) {
  if (!res.ok) {
    // Prefer the server's {error} message; fall back to the status text.
    let detail = res.statusText;
    try {
      detail = (await res.json()).error ?? detail;
    } catch {} // body may be empty/non-JSON — status text is enough
    throw new Error(`${label}: ${res.status} ${detail}`);
  }
  return res.json();
}

/** Query. List saved projects, newest first: [{name, mtime, slideCount}]. */
export async function listProjects() {
  return jsonOrThrow(await fetch(`${BACKEND}/api/projects/`), "listProjects");
}

/** Query. Load a project: {doc, assets:[{name,size,kind,url}]}. */
export async function loadProject(name) {
  return jsonOrThrow(await fetch(`${BACKEND}/api/project/${enc(name)}/`), `loadProject(${name})`);
}

/** Command. Save a project's document (creates the folder if new). */
export async function saveProject(name, doc) {
  const res = await fetch(`${BACKEND}/api/project/${enc(name)}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  return jsonOrThrow(res, `saveProject(${name})`);
}

/** Query. List a project's assets: [{name, size, kind, url}]. Reflects the
 *  assets/ folder on disk — the source of truth (manual drops appear here). */
export async function listAssets(name) {
  return jsonOrThrow(await fetch(`${BACKEND}/api/assets/${enc(name)}/`), `listAssets(${name})`);
}

/** Command. Upload one asset (raw bytes; filename rides in the query string).
 *  `file` is a File/Blob. Returns a Promise<{ok, name, url}> — name is the FINAL
 *  basename (de-collided server-side).
 *
 *  Uses XMLHttpRequest, NOT fetch: only xhr.upload.onprogress reports UPLOAD
 *  progress in browsers (fetch exposes download progress only), and the
 *  optimistic asset-tile overlay needs live bytes-sent. The request itself is
 *  byte-identical to the old fetch (same URL, POST, raw-file body, JSON reply /
 *  {error} on failure) so the server contract (server.py _handle_upload) is
 *  unchanged. `onProgress(loaded, total)` is optional; `total` is 0 when the
 *  browser can't compute it (lengthComputable false) — the caller shows an
 *  indeterminate state rather than dividing by zero. Rejects LOUDLY on any
 *  non-2xx, network error, or abort (no silent fallback). */
export function uploadAsset(name, file, filename = file.name, onProgress = null) {
  const label = `uploadAsset(${name}, ${filename})`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BACKEND}/api/upload/${enc(name)}/?filename=${enc(filename)}`);
    if (onProgress) {
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : 0);
    }
    xhr.onload = () => {
      // Mirror jsonOrThrow: prefer the server's {error}, fall back to statusText.
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {} // body may be empty/non-JSON
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error(`${label}: ${xhr.status} ${data?.error ?? xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error(`${label}: network error (is the project server running?)`));
    xhr.onabort = () => reject(new Error(`${label}: upload aborted`));
    xhr.send(file);
  });
}

/** Command. Persist a client-rendered asset THUMBNAIL (manifest #25). `png` is
 *  the raster bytes (Blob/ArrayBuffer/Uint8Array); `mtime` is the asset's mtime
 *  (the server cache key — a replaced file regenerates); `badge` is optional
 *  corner text (e.g. a PDF's page count). The server has no PDF engine, so the
 *  CLIENT rasterizes page 1 and POSTs it here to persist for next session.
 *  Returns {ok, thumbnail:<url>, badge}. Throws loudly on a non-OK response. */
export async function storeThumb(name, filename, mtime, badge, png) {
  const q = new URLSearchParams({ mtime: String(mtime) });
  if (badge != null) q.set("badge", String(badge));
  const res = await fetch(`${BACKEND}/api/thumb/${enc(name)}/${enc(filename)}/?${q}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: png,
  });
  return jsonOrThrow(res, `storeThumb(${name}, ${filename})`);
}

/** Command. Delete one asset from a project's assets/ folder (the server also
 *  drops the asset's cached filmstrip frames). Returns {ok, name}. 404s (loud
 *  throw) if the asset does not exist — a stale list is a reportable state. */
export async function deleteAsset(name, filename) {
  const res = await fetch(`${BACKEND}/api/asset/${enc(name)}/${enc(filename)}/`, { method: "DELETE" });
  return jsonOrThrow(res, `deleteAsset(${name}, ${filename})`);
}

/** Query (the server extracts on first request, then serves from its cache).
 *  N evenly-spread frames of a project video asset: {count, frames: [url,…]}.
 *  `video` is the asset FILENAME (the filmstrip widget's src); count may be
 *  less than n for a video shorter than n frames. `h`/`w` are the OPTIONAL
 *  per-frame extraction resolution in pixels (manifest 14.1 frameH/frameW; null/
 *  undefined = the video's native size) — passed as ?h=&w= query params, folded
 *  into the server's cache key so a resolution change re-extracts. */
export async function fetchFrames(name, video, n, h = null, w = null) {
  const q = new URLSearchParams();
  if (h != null && h > 0) q.set("h", String(Math.round(h)));
  if (w != null && w > 0) q.set("w", String(Math.round(w)));
  const qs = q.toString() ? `?${q}` : "";
  const res = await fetch(`${BACKEND}/api/frames/${enc(name)}/${enc(video)}/${encodeURIComponent(n)}/${qs}`);
  return jsonOrThrow(res, `fetchFrames(${name}, ${video}, ${n})`);
}

/** Command. Store `payload` (a JSON STRING — the serialized item) on THIS
 *  browser session's server-side clipboard (manifest 14.10 AMENDED). The
 *  server keys it by a session cookie, so two open presentations of the same
 *  browser share it. `credentials:"include"` sends/receives that cookie even
 *  when the backend is a different origin (?backend=…); same-origin (the Vite
 *  proxy, the normal case) sends it anyway. Throws loudly on a non-OK response. */
export async function setClipboard(payload) {
  const res = await fetch(`${BACKEND}/api/clipboard/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ payload }),
  });
  return jsonOrThrow(res, "setClipboard");
}

/** Query. This browser session's last server-side clipboard payload (the JSON
 *  STRING stored by setClipboard), or null if this session never copied.
 *  Throws loudly on a non-OK response. */
export async function getClipboard() {
  const res = await fetch(`${BACKEND}/api/clipboard/`, { credentials: "include" });
  const { payload } = await jsonOrThrow(res, "getClipboard");
  return payload ?? null;
}

/** Command. Begin a SERVER-SIDE MP4-export session; returns the server-minted
 *  sessionId. The SERVER mints the id (not the client) so no secure-context-only
 *  crypto (crypto.randomUUID) is needed — MP4 export must work on plain HTTP,
 *  which is the whole reason it moved server-side. Throws loudly on a non-OK
 *  response (or an unreachable server). */
export async function beginMp4Export() {
  const res = await fetch(`${BACKEND}/api/export-mp4/`, { method: "POST" });
  const { sessionId } = await jsonOrThrow(res, "beginMp4Export");
  return sessionId;
}

/** Command. Upload one rendered PNG frame (raw bytes `png`, a Blob) as frame
 *  `index` (0-based) of an export session. The caller awaits this so frames land
 *  in order and the browser holds only one PNG at a time (backpressure). Throws
 *  loudly on a non-OK response. */
export async function postMp4ExportFrame(sessionId, index, png) {
  const res = await fetch(`${BACKEND}/api/export-mp4/${enc(sessionId)}/frame/${enc(String(index))}/`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: png,
  });
  return jsonOrThrow(res, `postMp4ExportFrame(${sessionId}, ${index})`);
}

/** Command. Finish an export: the server runs ffmpeg over the uploaded frames at
 *  `fps`/`crf`, returns the encoded MP4, and deletes the session scratch.
 *  Resolves to a "video/mp4" Blob. Throws loudly on a non-OK response — the body
 *  is binary, so (like downloadProjectZip) the status is checked before .blob(),
 *  preferring the server's JSON {error} on failure. */
export async function encodeMp4Export(sessionId, { fps, crf }) {
  const res = await fetch(`${BACKEND}/api/export-mp4/${enc(sessionId)}/encode/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fps, crf }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).error ?? detail;
    } catch {} // body may be empty/non-JSON — status text is enough
    throw new Error(`encodeMp4Export(${sessionId}): ${res.status} ${detail}`);
  }
  return res.blob();
}

/** Command. Download the whole project as a .zip (browser save dialog). The
 *  ZIP is built server-side from the folder (doc.json + assets). */
export async function downloadProjectZip(name) {
  const res = await fetch(`${BACKEND}/api/download/${enc(name)}/`);
  if (!res.ok) throw new Error(`downloadProjectZip(${name}): ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}
