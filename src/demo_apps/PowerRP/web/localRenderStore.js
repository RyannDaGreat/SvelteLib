/**
 * localRenderStore.js — THE RENDERINGS KEYSPACE, and the static-mode twin of the
 * server's render-job record.
 *
 * ── THE RULING THAT PRODUCED THIS FILE ────────────────────────────────────────
 * The user, looking at the static site's Render Center — a "Rendered by" dropdown
 * whose Browser option was live, an "Encoded by: Upload frames" that needs a server
 * to upload TO, a pink "Render jobs need the PowerRP project server" and a dead
 * "Submit Render Job — needs a server" button:
 *
 *   "We spent a long time creating an in-browser rendering system. When we're on a
 *    static site, why not just hook up that file system and only have the Browser
 *    option? Why even have the upload-frames option and why force a renderings list
 *    if we could just do it all in the browser? The storage here should be capable
 *    of holding such videos, right?"
 *
 * It is, and every piece already existed: web/browserRenderJobs.js renders and
 * encodes in the page with pause/resume, web/mp4Encoder.js produces .mp4 BYTES
 * without a server, and IndexedDB holds multi-gigabyte blobs. The ONLY thing that
 * was server-shaped was the JOB RECORD — the row in the list, its state, its
 * finished movie. This module is that record, in the browser.
 *
 * ── IT IMPLEMENTS THE SERVER'S INTERFACE, NOT A NEW ONE ───────────────────────
 * browserRenderJobs.js makes exactly five calls into web/projectApi.js:
 * submitRenderJob, listRenderJobs, cancelRenderJob, postRenderJobOutput, and (from
 * the modal) deleteRenderJob/markRenderJobSeen. Every function here has the SAME
 * NAME, SAME ARGUMENTS and returns the SAME RECORD SHAPE as server.py's `job_view`,
 * so the orchestrator, the view-model helpers (web/renderJobView.js,
 * web/browserJobView.js) and the modal's rows are UNCHANGED. The mode split is one
 * import-time choice in web/renderBackend.js, not a second render pipeline — which
 * is the whole point: "THE RENDERER IS ONE CODE PATH" applies here too, and a
 * static-only fork of the frame walk would be a second definition of what a render
 * IS.
 *
 * ── THE KEYING, AND WHY IT IS THE PROJECT KEY ─────────────────────────────────
 * A rendering is keyed by `(projectKey, jobId)`, where projectKey is EXACTLY what
 * `app.projectName()` answers — the same string the asset store keys blobs under.
 * For a saved library project that is its name ("RobotSim"); for an UNSAVED DRAFT it
 * is the reserved draft key ("~draft/current", web/projectDraft.js DRAFT_KEY).
 *
 * That identity is deliberate and it is the whole answer to "the ~draft/current case
 * must work". A draft's renders then live with the draft exactly the way its ASSETS
 * do: same key, same database lifetime, surviving a reload for the same reason, and
 * listed by the same "everything under this project" prefix query. Any other choice
 * — a per-render UUID namespace, a "renders belong to the document id" scheme — would
 * need its own migration story for the moment a draft is SAVED, and would make the
 * Render Center's list disagree with the Asset Explorer's about which project you
 * are looking at.
 *
 * THE COROLLARY, STATED SO IT IS NOT A SURPRISE: saving a draft under a real name
 * does NOT carry its renders over, because a save is `localProjectStore.save(name)`
 * plus an asset copy and this keyspace is not part of either. A render is an OUTPUT,
 * not a source: it is reproducible from the document by pressing Render again, and
 * it is the one thing in the project that the user can simply Download. Copying
 * potentially gigabytes of MP4 on every Save-As, silently, to keep a list looking
 * tidy, is the worse bargain. The renders stay under the draft key and are listed
 * whenever that draft is open again.
 *
 * ── WHAT IS STORED ────────────────────────────────────────────────────────────
 *   renderings  key = "<projectKey>/<jobId>"  → a JOB RECORD in server.py's
 *               `job_view` shape, plus `blob` (the finished .mp4) on a done job.
 *               The blob lives IN the record because IndexedDB stores Blobs by
 *               reference-counted backing file: it is not copied into the record's
 *               structured clone, and one transaction keeps a movie and the row
 *               describing it atomically consistent.
 *
 * The IN-FLIGHT half of a browser render (its document snapshot, its encoded
 * segments, its lease) is NOT here — that is web/browserJobStore.js's database and
 * it already existed. This module holds the LIST: what the user sees, and what
 * survives to be downloaded.
 *
 * Errors are LOUD, and one in particular is load-bearing: a finished movie that
 * cannot be WRITTEN (quota) must not report success, because the render is gone the
 * moment the page closes. See `postRenderJobOutput`.
 */

import { humanReadableFileSize } from "./fileSize.js";
import { storageBudget } from "./localDb.js";

/** Database and store names. A version bump needs a migration here; a user's
 *  finished renders are not disposable cache. */
const DB_NAME = "powerrp-renderings";
const DB_VERSION = 1;
const RENDERINGS_STORE = "renderings";

/** The one open connection, opened lazily (the localDb.js idiom). */
let dbPromise = null;

/**
 * Command (async; opens/creates the database). The shared connection. Loud when
 * IndexedDB is unavailable — in static mode this store is the ONLY place a finished
 * render can live, so a browser that refuses it must say so rather than silently
 * rendering into nothing.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openRenderingsDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined" || indexedDB === null)
    return Promise.reject(new Error("Renderings are kept in IndexedDB, and this browser does not expose it — a finished render would have nowhere to live."));
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RENDERINGS_STORE)) db.createObjectStore(RENDERINGS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`Could not open the renderings database: ${req.error?.message ?? "unknown IndexedDB error"}`));
    req.onblocked = () => reject(new Error("The renderings database is blocked by another tab holding an older version open. Close other PowerRP tabs and retry."));
  });
  return dbPromise;
}

/**
 * Pure function. The renderings store's key for one job. The SAME
 * "<project>/<file>" grammar localDb.assetKey uses, and for the same reason: a
 * prefix range enumerates exactly one project's renderings with no index.
 *
 * @param {string} projectKey - what app.projectName() answers (a name, or the draft key)
 * @param {string} jobId - this render's id
 * @returns {string}
 *
 * @example renderingKey("RobotSim", "r-abc123")      // "RobotSim/r-abc123"
 * @example renderingKey("~draft/current", "r-abc123") // "~draft/current/r-abc123"
 */
export function renderingKey(projectKey, jobId) {
  return `${projectKey}/${jobId}`;
}

/**
 * Pure function. A fresh render-job id. `crypto.randomUUID` is SECURE-CONTEXT ONLY
 * and measured absent on the plain-HTTP origins this app must run on (see
 * web/browserJobStore.js newDriverId), so this is built from
 * `crypto.getRandomValues`, which is not gated. In HTTP mode the SERVER mints ids;
 * this is the static-mode twin of that.
 *
 * Near-pure: consumes randomness.
 *
 * @returns {string}
 *
 * @example newRenderId() // "r-9f3a1c2e8b7d4056"
 */
export function newRenderId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `r-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Command (async). Run `body(store)` in one transaction and resolve with its value
 * once the transaction COMMITS — not merely once the request fires. That
 * distinction is the entire quota story: a put() of a 300 MB movie SUCCEEDS and
 * only the COMMIT is refused, so resolving on the request would tell the user their
 * render was saved and lose it at page close.
 *
 * @param {"readonly"|"readwrite"} mode
 * @param {(store: IDBObjectStore) => any} body
 * @returns {Promise<any>}
 */
async function withRenderings(mode, body) {
  const db = await openRenderingsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RENDERINGS_STORE, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(new Error(`renderings transaction aborted — ${tx.error?.message ?? "unknown reason (storage quota exceeded?)"}`));
    tx.onerror = () => reject(new Error(`renderings transaction failed — ${tx.error?.message ?? "unknown"}`));
    Promise.resolve(body(tx.objectStore(RENDERINGS_STORE))).then(
      (r) => { result = r; },
      (e) => {
        try { tx.abort(); } catch { /* already finished; the reject below is the report */ }
        reject(e);
      },
    );
  });
}

/** Command (async). Await one IDBRequest, naming the caller on failure. */
function request(req, label) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`${label}: ${req.error?.message ?? "IndexedDB request failed"}`));
  });
}

/**
 * Pure function. A stored record → the JOB VIEW the Render Center reads, which is
 * server.py's `job_view` shape minus the fields that are server nouns. `blob` is
 * dropped: the list must never hold a movie in memory just to render a row (a
 * project with ten finished 1080p renders would otherwise pin gigabytes), and the
 * bytes are fetched by id when a row is expanded or downloaded.
 *
 * `outputPath` is deliberately ABSENT rather than faked. In HTTP mode it is a real
 * filesystem path the user can copy and paste into a terminal; in the browser there
 * is no such path, and inventing one ("browser storage / …") would be a lie the
 * copy-path button would then put on the clipboard. The modal shows the Download
 * button instead — see its `isLocalRendering` branch.
 *
 * @param {object} rec - a stored rendering record
 * @returns {object} the job view
 *
 * @example
 * >>> renderingView({id: "r-1", projectKey: "Deck", name: "Take 1", state: "done", bytes: 40960, framesTotal: 12, framesDone: 12, seen: false, createdAt: 1769800000000, params: {width: 320, height: 240, fps: 6}, durationSeconds: 2, blob: new Blob()})
 * {id: "r-1", name: "Take 1", backend: "client", state: "done", framesDone: 12, framesTotal: 12, bytes: 40960, seen: false, storage: "browser", durationSeconds: 2, …}
 */
export function renderingView(rec) {
  const { blob: _blob, projectKey: _projectKey, ...view } = rec;
  return view;
}

/**
 * Command (async; writes). Submit a render job to BROWSER STORAGE — the static-mode
 * twin of projectApi.submitRenderJob, same arguments, same returned record shape.
 *
 * The `doc` snapshot the server would keep is NOT stored here: web/browserJobStore.js
 * already holds the serialized document for exactly this job (it is what makes the
 * render resumable), and two copies of a multi-megabyte deck would be two chances
 * for them to disagree about which document is being rendered. That store is the
 * snapshot's home; this one is the list.
 *
 * @param {string} projectKey - app.projectName()
 * @param {object} o
 * @param {string} o.name - the render's name (also the download filename stem)
 * @param {string} o.backend - always "client" here; a "server" job in static mode is a caller bug
 * @param {number} o.framesTotal
 * @param {object} o.params - width/height/fps/crf/samples/range/background/…
 * @returns {Promise<object>} the created job record
 */
export async function submitRenderJob(projectKey, { name, backend = "client", framesTotal, params }) {
  if (backend !== "client")
    throw new Error(`localRenderStore.submitRenderJob: backend ${JSON.stringify(backend)} has no meaning without a server — only "client" (this page renders the frames) exists in static mode.`);
  const rec = {
    id: newRenderId(),
    projectKey,
    name,
    backend: "client",
    state: "rendering",
    framesDone: 0,
    framesTotal,
    params,
    output: null,
    bytes: 0,
    durationSeconds: framesTotal / params.fps,
    error: null,
    warning: null,
    seen: false,
    storage: "browser", // the field the modal branches on to offer Download instead of a path
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    blob: null,
  };
  await withRenderings("readwrite", (s) => request(s.put(rec, renderingKey(projectKey, rec.id)), `submitRenderJob(${projectKey}, ${name})`));
  return renderingView(rec);
}

/**
 * Query (async). Every rendering of `projectKey`, NEWEST FIRST — matching
 * server.py's job listing order, so the Render Center's rows do not reorder when the
 * same deck is opened with a backend running.
 *
 * @param {string} projectKey
 * @returns {Promise<object[]>} job views
 */
export async function listRenderJobs(projectKey) {
  const range = IDBKeyRange.bound(`${projectKey}/`, `${projectKey}/￿`);
  const recs = await withRenderings("readonly", (s) => request(s.getAll(range), `listRenderJobs(${projectKey})`));
  return recs.map(renderingView).sort((a, b) => b.createdAt - a.createdAt);
}

/** Query (async). One stored record (blob included), or null. */
async function getRecord(projectKey, jobId) {
  return (await withRenderings("readonly", (s) => request(s.get(renderingKey(projectKey, jobId)), `getRendering(${projectKey}, ${jobId})`))) ?? null;
}

/**
 * Command (async; writes). Merge `fields` into a stored rendering. Loud when the
 * record is gone — a caller updating a render that no longer exists has lost track
 * of state, and a silent no-op there is how a progress bar spins forever.
 *
 * @param {string} projectKey
 * @param {string} jobId
 * @param {object} fields
 * @returns {Promise<object>} the updated job view
 */
export async function updateRenderJob(projectKey, jobId, fields) {
  const key = renderingKey(projectKey, jobId);
  return withRenderings("readwrite", async (s) => {
    const rec = await request(s.get(key), `updateRenderJob(${key})`);
    if (!rec) throw new Error(`localRenderStore.updateRenderJob: no rendering ${jobId} under "${projectKey}" — it was deleted, or this page is looking at a different project.`);
    const next = { ...rec, ...fields };
    await request(s.put(next, key), `updateRenderJob(${key})`);
    return renderingView(next);
  });
}

/**
 * Query (async). One finished rendering's BYTES as a Blob, for Download and for the
 * expanded row's <video>. Loud when the render is absent or unfinished — an
 * unfinished render has no movie, and handing back an empty blob would produce a
 * 0-byte .mp4 download that looks like a successful save.
 *
 * @param {string} projectKey
 * @param {string} jobId
 * @returns {Promise<Blob>}
 */
export async function renderingBlob(projectKey, jobId) {
  const rec = await getRecord(projectKey, jobId);
  if (!rec) throw new Error(`localRenderStore.renderingBlob: no rendering ${jobId} under "${projectKey}".`);
  if (!rec.blob) throw new Error(`localRenderStore.renderingBlob: rendering "${rec.name}" is ${rec.state}, not done — it has no movie yet.`);
  return rec.blob;
}

/**
 * Command (async; writes a possibly very large blob). Store a finished render's
 * bytes and mark the job done — the static-mode twin of
 * projectApi.postRenderJobOutput.
 *
 * THE QUOTA FAILURE IS THE INTERESTING PATH AND IT IS DELIBERATELY LOUD. In HTTP
 * mode a failed write leaves the frames on the server's disk and the render can be
 * finished again. Here the movie exists ONLY in this page's memory: if the commit is
 * refused there is no second chance, so the error must name the SIZE and the REMEDY
 * rather than surfacing IndexedDB's own "QuotaExceededError". The record is also
 * left in a `failed` state carrying that sentence, so the row explains itself after
 * a reload instead of appearing to have vanished.
 *
 * IT MUST NOT EVICT DRAFT ASSETS. It cannot, structurally: this is a separate write
 * that either commits or aborts as a whole, and IndexedDB never evicts PART of an
 * origin to make room — under pressure a browser drops a whole origin's
 * best-effort storage, which is what `requestPersistence()` (offered in the Asset
 * Explorer) exists to prevent. So the failure mode here is a refused write, never a
 * silently smaller asset library.
 *
 * @param {string} projectKey
 * @param {string} jobId
 * @param {Uint8Array} mp4 - the finished movie
 * @param {number} frames - how many frames it holds
 * @returns {Promise<object>} the finished job view
 */
export async function postRenderJobOutput(projectKey, jobId, mp4, frames) {
  const rec = await getRecord(projectKey, jobId);
  if (!rec) throw new Error(`localRenderStore.postRenderJobOutput: no rendering ${jobId} under "${projectKey}" — it was deleted while it was rendering.`);
  const blob = new Blob([mp4], { type: "video/mp4" });
  const next = {
    ...rec,
    state: "done",
    framesDone: frames,
    framesTotal: frames,
    output: `${rec.name}.mp4`,
    bytes: blob.size,
    durationSeconds: frames / rec.params.fps,
    finishedAt: Date.now(),
    blob,
  };
  try {
    await withRenderings("readwrite", (s) => request(s.put(next, renderingKey(projectKey, jobId)), `postRenderJobOutput(${projectKey}, ${jobId})`));
  } catch (e) {
    const budget = await storageBudget();
    const headroom = budget.supported ? ` This browser reports ${humanReadableFileSize(Math.max(0, budget.quota - budget.usage))} of storage headroom left.` : "";
    const message = `The finished render "${rec.name}" is ${humanReadableFileSize(blob.size)} and browser storage refused to keep it (${String(e?.message ?? e)}).${headroom} Download it now — it is still in this page and will be gone when the tab closes — or free space (delete old renderings or assets) and render again.`;
    // Record the reason so the row can explain itself after a reload. Best effort by
    // nature: the write that just failed may fail again, and reporting THAT would
    // bury the real message, so it is logged rather than thrown over the top.
    await updateRenderJob(projectKey, jobId, { state: "failed", error: message })
      .catch((err) => console.error(`localRenderStore: could not record the quota failure on rendering ${jobId}:`, err));
    throw new Error(message);
  }
  return renderingView(next);
}

/**
 * Command (async; writes). Mark a rendering cancelled. Same name and arguments as
 * projectApi.cancelRenderJob. A rendering that is already finished is left alone —
 * cancelling something that is over is a no-op, not an error, because the frame walk
 * and the UI race on exactly this at the end of a render.
 *
 * @param {string} projectKey
 * @param {string} jobId
 * @returns {Promise<object|null>} the updated view, or null if it was already gone
 */
export async function cancelRenderJob(projectKey, jobId) {
  const rec = await getRecord(projectKey, jobId);
  if (!rec) return null;
  if (rec.state === "done") return renderingView(rec);
  return updateRenderJob(projectKey, jobId, { state: "cancelled", finishedAt: Date.now() });
}

/**
 * Command (async; writes). Delete a rendering AND its movie. Loud when absent, so a
 * stale list is a reportable state (matching localAssetStore.delete's contract and
 * the server's 404-on-missing).
 *
 * @param {string} projectKey
 * @param {string} jobId
 * @returns {Promise<{ok: boolean, id: string}>}
 */
export async function deleteRenderJob(projectKey, jobId) {
  const key = renderingKey(projectKey, jobId);
  const rec = await getRecord(projectKey, jobId);
  if (!rec) throw new Error(`localRenderStore.deleteRenderJob: no rendering ${jobId} under "${projectKey}".`);
  await withRenderings("readwrite", (s) => request(s.delete(key), `deleteRenderJob(${key})`));
  return { ok: true, id: jobId };
}

/** Command (async; writes). Mark a finished rendering as seen — what clears the
 *  toolbar's badge. Same name/arguments as projectApi.markRenderJobSeen. */
export async function markRenderJobSeen(projectKey, jobId) {
  return updateRenderJob(projectKey, jobId, { seen: true });
}

/**
 * Command (async; writes). Delete EVERY rendering under one project key, returning
 * how many went. Exists for the same reason localAssetStore.clearProject does: the
 * draft keyspace is RE-STAGED rather than merged when a new working copy is opened,
 * and renderings of the previous draft must not be listed under the new one — they
 * are a different deck's movies.
 *
 * An empty keyspace is NOT an error here (unlike deleteRenderJob): the caller is
 * asserting "nothing of mine is left here", and the first draft ever opened clears a
 * key that has never held anything.
 *
 * @param {string} projectKey
 * @returns {Promise<number>}
 */
export async function clearProjectRenderings(projectKey) {
  const range = IDBKeyRange.bound(`${projectKey}/`, `${projectKey}/￿`);
  const recs = await withRenderings("readonly", (s) => request(s.getAll(range), `clearProjectRenderings(${projectKey})`));
  await withRenderings("readwrite", (s) => request(s.delete(range), `clearProjectRenderings(${projectKey})`));
  return recs.length;
}

// ── QUOTA HONESTY: what a render will cost, before it is started ─────────────
//
// A 1080p minute at 30 fps is a real number of megabytes and the user must hear it
// BEFORE spending twenty minutes producing it, not as a refused write afterwards.
// The two functions below are the whole mechanism: one pure estimate, one query
// that compares it against the browser's own headroom.

/**
 * Bits per pixel per frame, for the SIZE ESTIMATE only — never for encoding.
 *
 * WHERE IT COMES FROM: the in-page encoder measured ~1.4 KiB per 1080p frame at its
 * default quantizer (web/mp4Encoder.js's header, and the A/B table in
 * web/browserJobView.js) — 1434 bytes over 1920x1080 pixels is 0.0057 bits per
 * pixel. That is a fairly still deck; a full-frame animation costs several times
 * more. This constant is therefore rounded UP by an order of magnitude, because the
 * two error directions are not symmetric: an over-estimate shows a warning the user
 * can dismiss, while an under-estimate is the render that fills the disk at frame
 * 4000 and is lost. It is an ESTIMATE and the warning says so.
 */
export const ESTIMATE_BITS_PER_PIXEL = 0.05;

/**
 * Pure function. A rough BYTE SIZE for a render, from its output geometry alone.
 * width x height x fps x seconds x bits-per-pixel / 8.
 *
 * NOT a prediction of the file. H.264's rate depends on the content — a static
 * title card and a particle storm at the same settings differ by more than 10x —
 * so this is a budgeting number, deliberately generous (see
 * ESTIMATE_BITS_PER_PIXEL), used to decide whether to WARN. Nothing downstream
 * treats it as a fact.
 *
 * @param {object} o
 * @param {number} o.width - output width in px
 * @param {number} o.height - output height in px
 * @param {number} o.fps - frames per second
 * @param {number} o.durationSeconds - the timeline's length
 * @returns {number} estimated bytes
 *
 * @example
 * // 10 seconds of 1080p30 — the "is this going to be a problem" ballpark:
 * estimatedRenderBytes({width: 1920, height: 1080, fps: 30, durationSeconds: 10}) // 38880000
 * @example
 * // The probe's tiny render is a rounding error against any quota:
 * estimatedRenderBytes({width: 160, height: 120, fps: 6, durationSeconds: 1}) // 7200
 * @example estimatedRenderBytes({width: 1920, height: 1080, fps: 30, durationSeconds: 0}) // 0
 */
export function estimatedRenderBytes({ width, height, fps, durationSeconds }) {
  return (width * height * fps * durationSeconds * ESTIMATE_BITS_PER_PIXEL) / 8;
}

/**
 * Pure function. The fraction of free storage a render is estimated to consume,
 * above which the user is WARNED. 0.5 rather than something closer to 1 because the
 * estimate is generous in one direction only (see ESTIMATE_BITS_PER_PIXEL) and
 * because a browser's reported quota is itself an estimate that shrinks under disk
 * pressure — a render that would fill half of what is left is already worth a
 * sentence.
 */
export const QUOTA_WARN_FRACTION = 0.5;

/**
 * Pure function. THE WARNING SENTENCE for a render of `estimateBytes` against a
 * `storageBudget()` reading, or null when there is nothing to say.
 *
 * IT NEVER REFUSES, and that is a ruling, not an oversight: estimates lie in both
 * directions, browsers granularize their quota numbers to resist fingerprinting, and
 * a user who knows their deck is a static title card must be able to render it. So
 * this returns TEXT and the caller renders it beside a Render button that still
 * works.
 *
 * Three cases, in the order they matter:
 *   - the browser will not estimate at all → say the check could not be made
 *   - the estimate exceeds the free space  → the strongest wording
 *   - the estimate exceeds QUOTA_WARN_FRACTION of it → a caution
 *
 * @param {number} estimateBytes - from estimatedRenderBytes
 * @param {{usage:number, quota:number, supported:boolean}} budget - from storageBudget()
 * @returns {string|null} the warning, or null when the render comfortably fits
 *
 * @example
 * // A 39 MB estimate against 2 GB free: nothing to say.
 * quotaWarning(38880000, {usage: 100e6, quota: 2e9, supported: true}) // null
 * @example
 * // A 1.5 GB estimate against 1 GB free — the strongest wording, and it still
 * // does not refuse:
 * quotaWarning(1.5e9, {usage: 1e9, quota: 2e9, supported: true})
 * // "This render is estimated at 1.4GB, and this browser reports only 953.7MB of storage free. It may not fit — download it as soon as it finishes, or free space first. (H.264 size depends on the content, so this estimate can be well off in either direction.)"
 * @example
 * // Over half of what is left: a caution, not an alarm.
 * quotaWarning(600e6, {usage: 1e9, quota: 2e9, supported: true})
 * // "This render is estimated at 572.2MB, which is over half of the 953.7MB of storage this browser reports free. (H.264 size depends on the content, so this estimate can be well off in either direction.)"
 * @example
 * // No Storage API: say the check could not be made rather than implying it passed.
 * quotaWarning(600e6, {usage: 0, quota: 0, supported: false})
 * // "This render is estimated at 572.2MB. This browser will not report how much storage is free, so whether it fits cannot be checked in advance."
 */
export function quotaWarning(estimateBytes, budget) {
  const size = humanReadableFileSize(Math.round(estimateBytes));
  const caveat = "(H.264 size depends on the content, so this estimate can be well off in either direction.)";
  if (!budget.supported)
    return `This render is estimated at ${size}. This browser will not report how much storage is free, so whether it fits cannot be checked in advance.`;
  const free = Math.max(0, budget.quota - budget.usage);
  const freeText = humanReadableFileSize(free);
  if (estimateBytes > free)
    return `This render is estimated at ${size}, and this browser reports only ${freeText} of storage free. It may not fit — download it as soon as it finishes, or free space first. ${caveat}`;
  if (estimateBytes > free * QUOTA_WARN_FRACTION)
    return `This render is estimated at ${size}, which is over half of the ${freeText} of storage this browser reports free. ${caveat}`;
  return null;
}

/**
 * Query (async; reads the browser's storage estimate). The warning for a render
 * about to be submitted, or null. The one call the Render Center makes before
 * starting; it exists so the modal does not have to know about `storageBudget` or
 * the estimate constants.
 *
 * @param {{width:number, height:number, fps:number, durationSeconds:number}} shape
 * @returns {Promise<string|null>}
 */
export async function renderQuotaWarning(shape) {
  return quotaWarning(estimatedRenderBytes(shape), await storageBudget());
}
