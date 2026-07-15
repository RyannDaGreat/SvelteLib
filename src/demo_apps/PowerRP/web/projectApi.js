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
 *  `file` is a File/Blob. Returns {ok, name, url} — name is the FINAL basename
 *  (de-collided server-side). */
export async function uploadAsset(name, file, filename = file.name) {
  const res = await fetch(`${BACKEND}/api/upload/${enc(name)}/?filename=${enc(filename)}`, {
    method: "POST",
    body: file,
  });
  return jsonOrThrow(res, `uploadAsset(${name}, ${filename})`);
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
 *  less than n for a video shorter than n frames. */
export async function fetchFrames(name, video, n) {
  const res = await fetch(`${BACKEND}/api/frames/${enc(name)}/${enc(video)}/${encodeURIComponent(n)}/`);
  return jsonOrThrow(res, `fetchFrames(${name}, ${video}, ${n})`);
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
