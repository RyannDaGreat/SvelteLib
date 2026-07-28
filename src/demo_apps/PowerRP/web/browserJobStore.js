/**
 * THE BROWSER JOB STORE — IndexedDB, and the reason a browser render can be paused
 * by closing the tab and resumed by opening it again.
 *
 * ── WHY INDEXEDDB AND NOT SOMETHING NICER ─────────────────────────────────────
 * The obvious home for "a few hundred KiB of finished video, appended as it is
 * produced" is the Origin Private File System. It is not available: measured on a
 * real plain-HTTP LAN origin, `navigator.storage.getDirectory` is undefined
 * because OPFS is SECURE-CONTEXT GATED, and PowerRP must work on plain HTTP. So is
 * the Web Locks API, which would otherwise have arbitrated between two tabs.
 * IndexedDB is available there, and is what this uses. localStorage is not an
 * option: it is synchronous, string-only, and capped around 5 MB.
 *
 * ── WHAT IS STORED, AND WHY EACH PIECE IS NECESSARY ───────────────────────────
 *   jobs     one record per in-flight browser render:
 *              id/project/name           which server job this belongs to
 *              params                    width/height/fps/crf/samples/range/…
 *                                        (the codec field is `crf`, NOT `quality`.
 *                                        This line said `quality` while the wire
 *                                        field was `crf` — and the word carries
 *                                        two more meanings nearby: the encoder's
 *                                        `quality` ARGUMENT accepts a preset name
 *                                        or a raw number, and a dead params field
 *                                        of that name was removed. Name the field,
 *                                        not the concept.)
 *              docJson                   THE SNAPSHOT (see below)
 *              framesTotal               the denominator
 *              segmentFrames             the resume granularity, recorded so a
 *                                        later session cannot reinterpret it
 *              driverId/heartbeatAt      the lease (see below)
 *              createdAt/error
 *   segments the encoded output so far: one record per closed segment, keyed
 *            [jobId, index], holding its bytes, its first frame and its length.
 *
 * THE SNAPSHOT IS THE WHOLE CORRECTNESS ARGUMENT, and it is the same argument the
 * server makes for its own backend: a render is pure(document, [slide, alpha]), so
 * if the deck were edited between two sittings, a resumed render would splice two
 * different documents into one video AND REPORT SUCCESS. That is the worst failure
 * available here. The document is therefore serialized ONCE at submit — the same
 * string that is POSTed to the server as its snapshot — and every sitting renders
 * from that string. The live project can be edited freely.
 *
 * THE LEASE, because two tabs are one origin. IndexedDB is shared across tabs, so
 * without arbitration both could resume the same job and interleave segments. Web
 * Locks would be the right tool and is unavailable (above), so each driving tab
 * stamps `driverId` + `heartbeatAt` while it works; another tab treats a job whose
 * heartbeat is younger than LEASE_STALE_MS as taken and says so, rather than
 * fighting over it. This is advisory, and honestly so: it prevents the accident,
 * not a determined race.
 *
 * THE LEASE IS FOR OTHER TABS ONLY, and that boundary is now enforced rather than
 * assumed. A tab asking whether IT is driving a job must answer from its own memory:
 * the frame walk blocks the main thread for a whole output frame, so this record's
 * `heartbeatAt` is arbitrarily late for a completely healthy driver, and reading it
 * to answer "am I working?" made the Render Center announce "nothing is rendering"
 * about a render it was itself producing. `driverState` therefore takes that fact as
 * an argument and refuses to guess it. See LEASE_STALE_MS and driverState.
 *
 * Everything here is a Query or a Command over one database — no rendering, no
 * encoding, no HTTP. The pure helpers at the bottom (the ones that decide what a
 * stored job MEANS) are node-testable.
 */

/** Database name and version. A version bump must come with a migration in
 *  `upgradeSchema`; there is no silent reset of a user's in-flight render. */
const DB_NAME = "powerrp-browser-renders";
const DB_VERSION = 1;
const JOBS_STORE = "jobs";
const SEGMENTS_STORE = "segments";

/** How often a driving tab refreshes its lease. */
export const LEASE_HEARTBEAT_MS = 2000;
/**
 * How long a lease survives without a heartbeat before ANOTHER tab may take the
 * job. Three heartbeats: short enough that reopening after a crash does not wait,
 * and it must stay a MULTIPLE of the heartbeat — a threshold at or below the
 * interval would declare every healthy driver dead between two of its own beats.
 *
 * THIS THRESHOLD CANNOT BOUND A STARVED HEARTBEAT, and this comment used to claim
 * the opposite ("long enough that a tab busy inside one slow 1080p frame is not
 * declared dead"). Measured, with the frame walk running: a 4K frame at 16 temporal
 * subsamples holds the main thread for 7.4 s in one uninterruptible block, and the
 * first frame of a shader-backed deck blocked for 77 s while its shaders compiled.
 * A timer cannot fire inside either, so the heartbeat of a perfectly healthy driver
 * IS arbitrarily late — bounded by the cost of one output frame, which is unbounded.
 * The consequence, before this was understood, was the Render Center announcing
 * "nothing is rendering" about a render it was itself producing frames for
 * (tests/browser_lease_liveness_probe.js).
 *
 * So the lease is NOT how a reader learns whether IT is driving a job — that is a
 * fact held in memory, and `driverState` now takes it as an argument. The threshold
 * governs only the question it can actually answer: may this tab take over a job
 * some OTHER tab claimed? For that question a late heartbeat is still indistinguish-
 * able from a dead tab, and no timeout fixes it; see driverState's docstring.
 */
export const LEASE_STALE_MS = 3 * LEASE_HEARTBEAT_MS;

/** Command. Create this version's object stores. Called only from onupgradeneeded. */
function upgradeSchema(db) {
  if (!db.objectStoreNames.contains(JOBS_STORE)) db.createObjectStore(JOBS_STORE, { keyPath: "id" });
  if (!db.objectStoreNames.contains(SEGMENTS_STORE)) db.createObjectStore(SEGMENTS_STORE, { keyPath: ["jobId", "index"] });
}

/** The one open connection, opened lazily. */
let dbPromise = null;

/**
 * Command (async; opens/creates the database). The shared IndexedDB connection.
 * Throws LOUDLY when IndexedDB is unavailable or blocked (private-browsing modes
 * refuse it) — a browser render that cannot persist must not pretend it can.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openBrowserJobDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined" || indexedDB === null)
    return Promise.reject(new Error("Browser renders need IndexedDB to survive the page closing, and this browser does not expose it."));
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => upgradeSchema(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`Could not open the browser-render database: ${req.error?.message ?? "unknown IndexedDB error"}`));
    req.onblocked = () => reject(new Error("The browser-render database is blocked by another tab holding an older version open. Close other PowerRP tabs and retry."));
  });
  return dbPromise;
}

/**
 * Command (async). Run `fn(store)` in a transaction over `storeName` and resolve
 * with `fn`'s value once the transaction COMMITS (not merely once the request
 * fires) — so a caller that has been told a segment is persisted is telling the
 * truth even if the tab closes in the next millisecond.
 *
 * @param {string|string[]} storeNames
 * @param {"readonly"|"readwrite"} mode
 * @param {(stores: object) => any} fn Receives {storeName: IDBObjectStore}.
 * @returns {Promise<any>}
 */
async function transact(storeNames, mode, fn) {
  const db = await openBrowserJobDb();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let value;
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(new Error(`browser-render database transaction failed: ${tx.error?.message ?? "unknown"}`));
    tx.onabort = () => reject(new Error(`browser-render database transaction aborted: ${tx.error?.message ?? "unknown"}`));
    const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    value = fn(stores);
  });
}

/** Command (async). Await one IDBRequest as a promise. */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(req.error?.message ?? "IndexedDB request failed"));
  });
}

/**
 * Command (async; writes). Record a new browser render job. `docJson` must be the
 * SAME serialized document that was POSTed to the server as this job's snapshot —
 * see the header for why that identity is the correctness argument.
 *
 * @param {object} job {id, project, name, params, docJson, framesTotal, segmentFrames}
 * @returns {Promise<object>} the stored record
 */
export async function putBrowserJob(job) {
  const record = {
    ...job,
    driverId: null,
    heartbeatAt: 0,
    error: null,
    createdAt: Date.now(),
  };
  await transact(JOBS_STORE, "readwrite", (s) => s[JOBS_STORE].put(record));
  return record;
}

/** Query (async). One stored job, or null. */
export async function getBrowserJob(id) {
  const db = await openBrowserJobDb();
  return (await request(db.transaction(JOBS_STORE, "readonly").objectStore(JOBS_STORE).get(id))) ?? null;
}

/** Query (async). Every stored browser job for `project`, oldest first (submit
 *  order is resume order). Pass null for every project. */
export async function listBrowserJobs(project = null) {
  const db = await openBrowserJobDb();
  const all = await request(db.transaction(JOBS_STORE, "readonly").objectStore(JOBS_STORE).getAll());
  return all
    .filter((j) => project === null || j.project === project)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Command (async; writes). Merge `fields` into a stored job. Throws if the job is
 * gone — a caller updating a job that no longer exists has lost track of state and
 * must hear about it.
 */
export async function updateBrowserJob(id, fields) {
  const db = await openBrowserJobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOBS_STORE, "readwrite");
    const store = tx.objectStore(JOBS_STORE);
    const get = store.get(id);
    get.onsuccess = () => {
      if (!get.result) { reject(new Error(`browser render job ${id} is not in this browser's store`)); tx.abort(); return; }
      const next = { ...get.result, ...fields };
      store.put(next);
      tx.oncomplete = () => resolve(next);
    };
    tx.onerror = () => reject(new Error(`browser-render database update failed: ${tx.error?.message ?? "unknown"}`));
  });
}

/**
 * Command (async; writes). Persist one closed encode segment. The bytes are copied
 * into a plain ArrayBuffer because a Uint8Array VIEW would store its whole backing
 * buffer.
 *
 * @param {string} jobId
 * @param {{index:number, firstFrame:number, frames:number, bytes:Uint8Array}} segment
 */
export async function putBrowserJobSegment(jobId, segment) {
  const bytes = segment.bytes.slice().buffer;
  await transact(SEGMENTS_STORE, "readwrite", (s) => s[SEGMENTS_STORE].put({
    jobId, index: segment.index, firstFrame: segment.firstFrame, frames: segment.frames, bytes,
  }));
}

/**
 * Query (async). A job's persisted segments in index order, as
 * `{index, firstFrame, frames, bytes: Uint8Array}`.
 *
 * The read is CONTIGUITY-CHECKED: indices must be 0..n-1 with each segment
 * starting where the previous ended. A gap would mean resuming from the wrong
 * frame and silently producing a movie that skips, so it throws instead.
 *
 * @param {string} jobId
 * @returns {Promise<{index:number, firstFrame:number, frames:number, bytes:Uint8Array}[]>}
 */
export async function getBrowserJobSegments(jobId) {
  const db = await openBrowserJobDb();
  const all = await request(
    db.transaction(SEGMENTS_STORE, "readonly").objectStore(SEGMENTS_STORE)
      .getAll(IDBKeyRange.bound([jobId, -Infinity], [jobId, Infinity])),
  );
  const segments = all
    .sort((a, b) => a.index - b.index)
    .map((r) => ({ index: r.index, firstFrame: r.firstFrame, frames: r.frames, bytes: new Uint8Array(r.bytes) }));
  assertContiguous(segments, jobId);
  return segments;
}

/** Command (async; writes). Drop a job and every segment it owns. */
export async function deleteBrowserJob(jobId) {
  await transact([JOBS_STORE, SEGMENTS_STORE], "readwrite", (s) => {
    s[JOBS_STORE].delete(jobId);
    s[SEGMENTS_STORE].delete(IDBKeyRange.bound([jobId, -Infinity], [jobId, Infinity]));
  });
}

// ── Pure helpers: what a stored job MEANS ────────────────────────────────────

/**
 * Pure function. Throws unless `segments` are indices 0..n-1 with each one
 * starting exactly where the previous ended. Returns nothing.
 *
 * @param {{index:number, firstFrame:number, frames:number}[]} segments In index order.
 * @param {string} jobId Named in the error.
 *
 * @example assertContiguous([{index: 0, firstFrame: 0, frames: 20}, {index: 1, firstFrame: 20, frames: 20}], "j") // undefined
 * @example
 * // A missing middle segment throws rather than resuming from the wrong frame:
 * // assertContiguous([{index: 0, firstFrame: 0, frames: 20}, {index: 2, firstFrame: 40, frames: 20}], "j")
 */
export function assertContiguous(segments, jobId) {
  let expectedFrame = 0;
  for (const [i, s] of segments.entries()) {
    if (s.index !== i)
      throw new Error(`browser render job ${jobId}: persisted segment ${i} is missing (found index ${s.index}) — resuming would skip frames, so this job cannot continue. Delete it and re-submit.`);
    if (s.firstFrame !== expectedFrame)
      throw new Error(`browser render job ${jobId}: segment ${i} claims to start at frame ${s.firstFrame} but the previous segments end at ${expectedFrame}.`);
    expectedFrame += s.frames;
  }
}

/**
 * Pure function. Frames already encoded and persisted for a job — i.e. THE RESUME
 * POINT. Deliberately counts only CLOSED segments: frames of a segment that was
 * still being encoded when the tab closed were never written down and must be
 * re-rendered.
 *
 * @param {{frames:number}[]} segments
 * @returns {number}
 *
 * @example framesPersisted([{frames: 20}, {frames: 20}]) // 40
 * @example framesPersisted([]) // 0
 */
export function framesPersisted(segments) {
  return segments.reduce((n, s) => n + s.frames, 0);
}

/**
 * Pure function. What a stored job is doing right now, from this tab's point of
 * view: "here" (this tab is driving it), "elsewhere" (another tab's lease is
 * still warm), or "paused" (nothing is driving it — resuming continues it).
 *
 * The distinction exists because the UI must never imply that a render kept going
 * while the tab was shut. It did not; it PAUSED.
 *
 * `drivingHere` IS THE WHOLE CORRECTNESS ARGUMENT, and it is why this function takes
 * four arguments instead of three. "Am I driving this?" is a FACT the caller holds in
 * memory (browserRenderJobs.js's `live`), and a fact cannot go stale. Deriving it
 * from the lease instead made the answer depend on scheduling: the frame walk blocks
 * the main thread for the length of one output frame, so a stored heartbeat read
 * BEFORE such a block, compared against a `Date.now()` taken AFTER it, is older than
 * LEASE_STALE_MS however healthy the driver is. Measured: this tab reported "paused"
 * for a job it was mid-frame on, with the heartbeat in the store 0 ms old
 * (tests/browser_lease_liveness_probe.js). It is required, not optional: an omitted
 * argument would be falsy and would reinstate exactly that bug at the new call site,
 * so a non-boolean throws.
 *
 * THE HONEST BOUND, which no timeout removes. When `drivingHere` is false the lease
 * is all there is, and it CANNOT distinguish "that tab died" from "that tab is inside
 * one very slow frame" — a blocked tab cannot heartbeat. So a warm lease means
 * "recently alive", and a cold one means "either gone, or busy longer than
 * LEASE_STALE_MS". This function reports the second case as "paused" because that is
 * what the user can act on (resuming re-claims the lease), and because the
 * alternative — refusing forever on a lease nobody will ever refresh — is worse. The
 * residual risk is two tabs interleaving frames after a >LEASE_STALE_MS block, which
 * is the advisory nature of the lease and is stated in this file's header. Removing
 * it needs a heartbeat that cannot be starved (a Worker's timer), not a bigger number.
 *
 * @param {{driverId: string|null, heartbeatAt: number}} job
 * @param {string} thisDriverId This tab's driver id.
 * @param {number} now Milliseconds (Date.now()). Callers reading `job` from the
 *   database must capture this BEFORE that read, so a delayed read makes the
 *   heartbeat look YOUNGER than it is (erring toward "taken") instead of older
 *   (erring toward the "nothing is rendering" lie).
 * @param {boolean} drivingHere Is this tab driving this job right now? A fact from
 *   the caller's own memory, never inferred from the record.
 * @returns {"here"|"elsewhere"|"paused"}
 *
 * @example
 * // A tab that IS driving is "here" — the lease is not even consulted, so an
 * // ancient heartbeat cannot turn a running render into a paused one:
 * driverState({driverId: "tab-a", heartbeatAt: 0}, "tab-a", 99000, true) // "here"
 * @example driverState({driverId: "tab-b", heartbeatAt: 1000}, "tab-a", 1500, false) // "elsewhere"
 * @example driverState({driverId: "tab-b", heartbeatAt: 1000}, "tab-a", 99000, false) // "paused"
 * @example driverState({driverId: null, heartbeatAt: 0}, "tab-a", 1500, false) // "paused"
 * @example
 * // OUR OWN id on a job we are NOT driving: a lease our drive left behind when it
 * // ended without cleanup. Nothing is producing frames, so it is paused.
 * driverState({driverId: "tab-a", heartbeatAt: 1000}, "tab-a", 1500, false) // "paused"
 */
export function driverState(job, thisDriverId, now, drivingHere) {
  if (typeof drivingHere !== "boolean")
    throw new Error(`driverState: drivingHere must be a boolean fact from the caller's own state, got ${JSON.stringify(drivingHere)} — inferring it from the lease is the bug this argument exists to prevent.`);
  if (drivingHere) return "here";
  if (!job.driverId) return "paused";
  // OUR id without our work behind it is a leftover, not a driver.
  if (job.driverId === thisDriverId) return "paused";
  if (now - job.heartbeatAt > LEASE_STALE_MS) return "paused";
  return "elsewhere";
}

/**
 * Pure function. A per-tab driver id. `crypto.randomUUID` is SECURE-CONTEXT ONLY
 * and measured absent on the plain-HTTP origins this app must run on, so the id is
 * built from `crypto.getRandomValues` (which is not gated) — the same reason the
 * server, not the client, mints render-job ids.
 *
 * Near-pure: consumes randomness.
 *
 * @returns {string}
 *
 * @example newDriverId() // "d-3f9a1c2e8b7d4056"
 */
export function newDriverId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `d-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
