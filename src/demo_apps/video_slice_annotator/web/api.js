/**
 * api.js — thin client for the Video Slice Annotator backend.
 *
 * Same-origin by default: the Vite dev server proxies /api, /video, /lowres and
 * /frame to the Python backend (see vite.config.js), so the app uses relative
 * paths and keeps HMR on one URL. Override with ?backend=http://host:port.
 */

const params = new URLSearchParams(location.search);
export const BACKEND = params.get("backend") || "";

const enc = encodeURIComponent;

/** Query. URL of the full-res source video (HTTP Range supported). */
export const videoUrl = (name) => `${BACKEND}/video/${enc(name)}`;

/** Query. URL of the low-res proxy (built on first request, server-side). */
export const lowresUrl = (name) => `${BACKEND}/lowres/${enc(name)}`;

/** Query. URL of a JPEG of the frame nearest `t` seconds. */
export const frameUrl = (name, t) => `${BACKEND}/frame/${enc(name)}?t=${t}`;

/** Query. List every clip: [{name, duration, hasAnnotations}]. */
export async function listVideos() {
  const res = await fetch(`${BACKEND}/api/videos`);
  if (!res.ok) throw new Error(`listVideos: ${res.status}`);
  return res.json();
}

/** Query. Load a clip's annotation: { labels, comments }. */
export async function loadAnnotation(name) {
  const res = await fetch(`${BACKEND}/api/annotation/${enc(name)}`);
  if (!res.ok) throw new Error(`loadAnnotation(${name}): ${res.status}`);
  return res.json();
}

/** Command. Persist a clip's annotation JSON. */
export async function saveAnnotation(name, data) {
  const res = await fetch(`${BACKEND}/api/annotation/${enc(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`saveAnnotation(${name}): ${res.status}`);
  return res.json();
}
