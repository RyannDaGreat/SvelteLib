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

import { downloadBytes } from "./fileDownload.js";

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

/** Command. RENAME = MOVE projects/<old> → projects/<new> on the server (one
 *  os.rename; the project's assets travel with it and its relative refs need no
 *  rewriting). Returns {ok, name}. Throws loudly on a missing source (404) or an
 *  occupied destination (409) — a rename never merges or overwrites. */
export async function renameProject(oldName, newName) {
  const res = await fetch(`${BACKEND}/api/rename-project/${enc(oldName)}/${enc(newName)}/`, { method: "POST" });
  return jsonOrThrow(res, `renameProject(${oldName} → ${newName})`);
}

/** Command. SAVE-AS FORK: copy every asset of `src` into `dst` SERVER-SIDE, so a
 *  fork of a deck holding a large video never pulls those bytes through the
 *  browser. Returns {ok, copied:[…], skipped:[…]} — `skipped` names files the
 *  destination already had (never overwritten). */
export async function copyProjectAssets(src, dst) {
  const res = await fetch(`${BACKEND}/api/copy-assets/${enc(src)}/${enc(dst)}/`, { method: "POST" });
  return jsonOrThrow(res, `copyProjectAssets(${src} → ${dst})`);
}

/** Query. List a project's assets: [{name, size, kind, url}]. Reflects the
 *  assets/ folder on disk — the source of truth (manual drops appear here). */
export async function listAssets(name) {
  return jsonOrThrow(await fetch(`${BACKEND}/api/assets/${enc(name)}/`), `listAssets(${name})`);
}

/** Query. The ffprobe container duration (seconds) of ONE project video —
 *  the deterministic `self.length` a time-driven scrubber's presets divide by
 *  (`time % self.length`). Returns a Promise<{durationSec}>. Loud on a missing
 *  or unprobeable video (the video scrubber's "Probe clip length" command surfaces
 *  the throw); the same number rides on each video's listAssets entry, so this is
 *  only needed when a single fresh probe is wanted. `file` is the asset's basename
 *  (NOT the /asset/ URL — the endpoint resolves it inside the project's assets/). */
export async function videoDuration(name, file) {
  return jsonOrThrow(await fetch(`${BACKEND}/api/duration/${enc(name)}/${enc(file)}`), `videoDuration(${name}, ${file})`);
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

// THE FRAME-EXTRACTION CLIENT IS GONE. `GET /api/frames/<project>/<video>/<N>` had
// exactly one caller — an app effect that filled the filmstrip's `frameUrls` — and the
// filmstrip now decodes its frames in the BROWSER from ordinary document state (the
// video scrub path), so there is nothing left here to call it. The ENDPOINT itself is
// deliberately left standing in server/server.py (with its own test,
// tests/frames_endpoint_test.py): it is a general "N stills of a video" service, and
// removing a working server route is a separate decision from removing this widget's
// dependency on it. If nothing adopts it, deleting it is a one-line follow-up.

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

// ── DETACHED RENDER JOBS ────────────────────────────────────────────────────
// A render is a JOB THE SERVER OWNS, not a promise this page is holding. That is
// the entire point: submitRenderJob returns as soon as the server has the
// snapshot, and from then on the browser is optional — it may close, refresh or
// crash. Progress is read back by POLLING listRenderJobs, which counts frames on
// disk, so a tab opened tomorrow sees exactly what a tab opened at submit sees.
// There is deliberately NO client-side job handle to lose.

/** Query. Absolute (proxied) URL of a finished render, for <video src> and the
 *  download link. `output` is the job's basename inside the project's renders/. */
export const renderUrl = (project, output) => `${BACKEND}/render/${enc(project)}/${enc(output)}`;

/** Query. A project's render jobs, newest first. Each job carries
 *  {id, name, backend, state, framesDone, framesTotal, params, output, outputPath,
 *  bytes, error, warning, seen, createdAt, startedAt, finishedAt}. */
export async function listRenderJobs(project) {
  const { jobs } = await jsonOrThrow(await fetch(`${BACKEND}/api/render-jobs/${enc(project)}/`), `listRenderJobs(${project})`);
  return jobs;
}

/** Command. Submit a render job. `doc` is SNAPSHOTTED server-side at submit, so
 *  editing the deck afterwards cannot splice two documents into one video.
 *  `backend` is "server" (detached; survives everything) or "client" (this page
 *  renders the frames and POSTs them, then calls finishRenderJob). Returns the
 *  new job record. Throws loudly on a rejected submit (bad CRF, bad backend,
 *  motion blur on the server backend, …). */
export async function submitRenderJob(project, { name, backend, framesTotal, params, doc }) {
  const res = await fetch(`${BACKEND}/api/render-jobs/${enc(project)}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, backend, framesTotal, params, doc }),
  });
  const { job } = await jsonOrThrow(res, `submitRenderJob(${project})`);
  return job;
}

/** Command. Upload one rendered PNG frame for a CLIENT-backend job — the same
 *  frames directory a server worker would fill, so the encode step is shared. */
export async function postRenderJobFrame(project, jobId, index, png) {
  const res = await fetch(`${BACKEND}/api/render-job/${enc(project)}/${enc(jobId)}/frame/${enc(String(index))}/`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: png,
  });
  return jsonOrThrow(res, `postRenderJobFrame(${project}, ${index})`);
}

/** Command. Deliver a FINISHED MOVIE for a browser-backend job whose frames were
 *  encoded IN THE PAGE (web/mp4Encoder.js), so nothing was ever uploaded frame by
 *  frame. `mp4` is the container bytes (Uint8Array/ArrayBuffer/Blob) and `frames`
 *  is how many frames they hold — the server records that count and stops
 *  believing its own (empty) frames directory. The movie lands in the project's
 *  renders/ folder exactly like a server-rendered one, so the two backends share
 *  one output location and one list entry. Returns the finished job record. */
export async function postRenderJobOutput(project, jobId, mp4, frames) {
  const q = new URLSearchParams({ frames: String(frames) });
  const res = await fetch(`${BACKEND}/api/render-job/${enc(project)}/${enc(jobId)}/output/?${q}`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: mp4,
  });
  const { job } = await jsonOrThrow(res, `postRenderJobOutput(${project}, ${jobId})`);
  return job;
}

/** Command. Tell the server a CLIENT-backend job's frames are all uploaded and
 *  it should run the shared ffmpeg encode. Returns the finished job record. */
export async function finishRenderJob(project, jobId) {
  const res = await fetch(`${BACKEND}/api/render-job/${enc(project)}/${enc(jobId)}/finish/`, { method: "POST" });
  const { job } = await jsonOrThrow(res, `finishRenderJob(${project}, ${jobId})`);
  return job;
}

/** Command. Cancel a queued or running job (kills its workers server-side).
 *  Throws loudly for a job that already finished. */
export async function cancelRenderJob(project, jobId) {
  const res = await fetch(`${BACKEND}/api/render-job/${enc(project)}/${enc(jobId)}/cancel/`, { method: "POST" });
  const { job } = await jsonOrThrow(res, `cancelRenderJob(${project}, ${jobId})`);
  return job;
}

/** Command. Mark a finished job as SEEN, so it stops counting toward the toolbar
 *  badge and stops auto-expanding in the Render Center. */
export async function markRenderJobSeen(project, jobId) {
  const res = await fetch(`${BACKEND}/api/render-job/${enc(project)}/${enc(jobId)}/seen/`, { method: "POST" });
  const { job } = await jsonOrThrow(res, `markRenderJobSeen(${project}, ${jobId})`);
  return job;
}

/** Command. Delete a job's record AND its output movie. Refused (loud throw)
 *  while the job is still active — cancel it first. */
export async function deleteRenderJob(project, jobId) {
  const res = await fetch(`${BACKEND}/api/render-job/${enc(project)}/${enc(jobId)}/`, { method: "DELETE" });
  return jsonOrThrow(res, `deleteRenderJob(${project}, ${jobId})`);
}

/** Command. Download the whole project as a .zip (browser save dialog). The
 *  ZIP is built server-side from the folder (doc.json + assets), and it is
 *  SELF-CONTAINED: the server copies in any asset the document borrows from
 *  another project and rewrites the archived doc.json (server.py
 *  zip_project_bytes).
 *
 *  Returns the warnings the server attached, so the caller can SAY that an asset
 *  could not be localized. They arrive as the X-PowerRP-Warning header rather than
 *  in the body because the body IS the archive — there is nowhere else to put
 *  them. The header is CORS-exposed for the ?backend= case; absent (an older
 *  server, or a proxy that stripped it) reads as "no warnings", which is why the
 *  server also logs each one to stderr unconditionally. */
export async function downloadProjectZip(name) {
  const res = await fetch(`${BACKEND}/api/download/${enc(name)}/`);
  if (!res.ok) throw new Error(`downloadProjectZip(${name}): ${res.status}`);
  const warning = res.headers.get("X-PowerRP-Warning");
  // The objectURL + a[download] + revoke gesture is web/fileDownload.js's
  // `downloadBytes` — the one definition of it in this app.
  downloadBytes(await res.blob(), `${name}.zip`);
  // " | " is the server's join (header_safe_warning) — an HTTP header value is one
  // line, and it must be latin-1, so the separator is ASCII on purpose.
  return { warnings: warning ? warning.split(" | ") : [] };
}

/** Pure function. The project name a dropped/picked .zip file wants: its
 *  basename with the ".zip" extension stripped (any path the browser may have
 *  prefixed goes too). An empty result means "let the archive's own root folder
 *  name it" — the server's fallback — so this never invents a name.
 *
 *  @example projectZipName("Imitations.zip")        // "Imitations"
 *  @example projectZipName("decks/My Talk.ZIP")     // "My Talk"
 *  @example projectZipName(".zip")                  // ""
 */
export function projectZipName(filename) {
  const base = String(filename ?? "").split(/[\\/]/).pop();
  return base.replace(/\.zip$/i, "").trim();
}

/** Pure function. Whether a dropped/picked OS File is a project ARCHIVE rather
 *  than an asset. THE one rule, exported so every drop surface (canvas, asset
 *  pane) classifies a .zip identically — a file that means "open this whole
 *  other project" must never be an asset on one surface and a project on
 *  another. Extension-tested as well as MIME-tested because the OS reports zips
 *  under several types, and sometimes none at all.
 *
 *  @example isProjectZip({name: "Imitations.zip", type: "application/zip"}) // true
 *  @example isProjectZip({name: "Deck.ZIP", type: ""})                      // true (extension alone)
 *  @example isProjectZip({name: "logo.png", type: "image/png"})             // false
 */
export function isProjectZip(file) {
  return /\.zip$/i.test(file?.name ?? "") || ["application/zip", "application/x-zip-compressed"].includes(file?.type);
}

/** Pure function. Whether a dropped/picked OS File is a PowerPoint deck
 *  (.pptx/.pptm — the macro-enabled variant parses identically, since
 *  core/pptx/deck.js reads the same OOXML parts either way). Mirrors
 *  isProjectZip's extension-and-MIME test so every drop surface classifies a
 *  deck the same way.
 *
 *  @example isPptxFile({name: "Talk.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"}) // true
 *  @example isPptxFile({name: "Deck.PPTM", type: ""})  // true (extension alone)
 *  @example isPptxFile({name: "logo.png", type: "image/png"}) // false
 */
export function isPptxFile(file) {
  return /\.ppt[xm]?$/i.test(file?.name ?? "") || file?.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

/** Pure function. The project name a dropped/picked .pptx file wants: its
 *  basename with the .pptx/.pptm extension stripped. Unlike projectZipName, a
 *  deck has no archive root folder to fall back on if this is blank — the
 *  caller is responsible for a final "Imported Presentation" fallback.
 *
 *  ── THE PATTERN MISSED THE COMMONEST EXTENSION (2026-08-22) ────────────────
 *  It was `/\.pptm?$/i`, which matches `.ppt` and `.pptm` and NOT `.pptx` — so
 *  the ONE extension every modern deck has fell through, and a dropped
 *  "Q3 Roadmap.pptx" named its project "Q3 Roadmap.pptx". The doctest below said
 *  otherwise and had been red in the gate. `isPptxFile` above carried the same
 *  pattern, where it mattered more: a .pptx was recognised only by its MIME type,
 *  so a drop from a source that supplies no type was not recognised as a deck at
 *  all. `[xm]?` is the fix in both, and `m?` was never a superset of it.
 *
 *  @example pptxDisplayName("Q3 Roadmap.pptx")   // "Q3 Roadmap"
 *  @example pptxDisplayName("decks/Talk.PPTM")   // "Talk"
 *  @example pptxDisplayName("Deck.ppt")          // "Deck"
 */
export function pptxDisplayName(filename) {
  const base = String(filename ?? "").split(/[\\/]/).pop();
  return base.replace(/\.ppt[xm]?$/i, "").trim();
}

/** Command. Import an exported project .zip as a NEW project on the server —
 *  the inverse of downloadProjectZip. `file` is the raw archive (a File/Blob);
 *  `name` is the preferred project name (blank = the archive's root folder
 *  names it). NEVER overwrites: a colliding name lands as "<Name> 2", and the
 *  resolved {name, requested} pair comes back so the caller can SAY SO rather
 *  than quietly opening something with a different title. A rejected archive
 *  (not a zip, no doc.json, unsafe member) throws loudly with the server's
 *  reason — the body is JSON on both paths, so jsonOrThrow surfaces it. */
export async function importProjectZip(file, name = "") {
  const q = name ? `?${new URLSearchParams({ name })}` : "";
  const res = await fetch(`${BACKEND}/api/import-zip/${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
  return jsonOrThrow(res, `importProjectZip(${name || "unnamed"})`);
}
