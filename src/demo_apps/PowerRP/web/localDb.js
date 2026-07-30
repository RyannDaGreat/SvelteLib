/**
 * localDb.js — the IndexedDB substrate for STATIC MODE (no backend).
 *
 * ONE database with two stores, mirroring the server's project folder layout
 * (server/server.py: `projects/<name>/doc.json` + `projects/<name>/assets/`):
 *
 *   docs    key = project name          → {name, doc, mtime}
 *   assets  key = "<project>/<file>"    → {project, file, name, blob, size, mtime}
 *
 * WHY INDEXEDDB AND NOT localStorage: assets are BLOBS. localStorage is
 * string-only (a video would have to be base64'd, inflating it ~33%) and caps at
 * ~5 MB per origin, which one screenshot can exceed. IndexedDB stores Blob
 * objects natively, is asynchronous (so a 100 MB import does not freeze the
 * paint loop), and its quota is the origin's real storage budget — the number
 * the Asset Explorer's quota line reports. localStorage keeps exactly its
 * existing job: the crash-safety autosave of the OPEN document (app.svelte.js
 * AUTOSAVE_KEY), which is a single small string and wants synchronous writes.
 *
 * WHY THE ASSET KEY IS "<project>/<file>": IndexedDB has no folders, so the
 * compound key gives a per-project prefix range — `IDBKeyRange.bound("P/",
 * "P/￿")` enumerates exactly one project's assets, which is what `list()`
 * needs, without an index or a full-store scan.
 *
 * Errors are LOUD. Every request's onerror rejects with the underlying
 * DOMException message; a browser with IndexedDB disabled (private mode in some
 * browsers, a hardened profile) fails at open() with a message that says so,
 * rather than silently behaving like an empty library.
 */

const DB_NAME = "powerrp";
const DB_VERSION = 1;
export const DOC_STORE = "docs";
export const ASSET_STORE = "assets";

/** Module-level memo of the open connection. One connection per page: IndexedDB
 *  serializes transactions per database anyway, and re-opening per call would
 *  race the upgrade handler. */
let dbPromise = null;

/**
 * Query (opens/creates the database — mutates browser storage on first call).
 * The memoized IDBDatabase. Throws loudly if IndexedDB is unavailable or the
 * open is blocked.
 *
 * @returns {Promise<IDBDatabase>}
 *
 * @example
 * >>> const db = await openDb();
 * >>> db.objectStoreNames.contains("assets")
 * true
 */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("openDb: this browser exposes no indexedDB — local (static) storage is unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // keyPath-less stores: both are written with an explicit out-of-line key,
      // so the key grammar lives in this file rather than inside the records.
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
      if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`openDb: ${req.error?.message ?? "indexedDB open failed"}`));
    req.onblocked = () => reject(new Error("openDb: indexedDB open blocked by another tab holding an older version"));
  });
  return dbPromise;
}

/**
 * Pure function. The asset store's compound key for one project file.
 *
 * @param {string} project - project name
 * @param {string} file - asset basename
 * @returns {string}
 *
 * @example assetKey("Imitations", "logo.png")  // "Imitations/logo.png"
 */
export function assetKey(project, file) {
  return `${project}/${file}`;
}

/**
 * Query. Wrap one IDBRequest as a promise, rejecting LOUDLY with `label` for
 * context (an IndexedDB DOMException on its own rarely says which call failed).
 *
 * @param {IDBRequest} req - the pending request
 * @param {string} label - caller name, for the error message
 * @returns {Promise<any>} the request's result
 *
 * @example
 * >>> await promisify(store.get("Deck"), "loadDoc(Deck)")
 * {name: "Deck", doc: {...}, mtime: 1769800000000}
 */
export function promisify(req, label) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`${label}: ${req.error?.message ?? "indexedDB request failed"}`));
  });
}

/**
 * Query. Run `body(store)` inside a transaction on ONE store and resolve with
 * whatever `body` returns (awaited). `mode` is "readonly" or "readwrite".
 *
 * The transaction's own `onabort`/`onerror` also reject: a write that fails on
 * COMMIT (the classic quota-exceeded case — the individual put() succeeds and
 * only the commit is refused) would otherwise resolve as if it had been stored,
 * which is exactly the silent data loss the house rules forbid. QuotaExceeded
 * arrives here, so a full library reports as full.
 *
 * @param {string} storeName - DOC_STORE or ASSET_STORE
 * @param {"readonly"|"readwrite"} mode - transaction mode
 * @param {(store: IDBObjectStore) => any} body - the work
 * @returns {Promise<any>}
 *
 * @example
 * >>> await withStore(DOC_STORE, "readonly", (s) => promisify(s.getAllKeys(), "names"))
 * ["Imitations", "My Talk"]
 */
export async function withStore(storeName, mode, body) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    tx.onabort = () => reject(new Error(`withStore(${storeName}, ${mode}): transaction aborted — ${tx.error?.message ?? "unknown reason (storage quota exceeded?)"}`));
    tx.onerror = () => reject(new Error(`withStore(${storeName}, ${mode}): ${tx.error?.message ?? "transaction failed"}`));
    tx.oncomplete = () => resolve(result);
    // Body may return a promise over its own requests; those settle before
    // oncomplete fires, so awaiting here cannot deadlock the transaction.
    Promise.resolve(body(tx.objectStore(storeName))).then(
      (r) => {
        result = r;
      },
      (e) => {
        try {
          tx.abort();
        } catch {} // already aborting/finished — the reject below is the report
        reject(e);
      },
    );
  });
}

/**
 * Query. Every record in `storeName` whose key starts with `prefix`, using a
 * bound key range (NOT a full scan). "￿" is the last code unit IndexedDB's
 * string collation will order, so the range covers every key under the prefix.
 *
 * @param {string} storeName - DOC_STORE or ASSET_STORE
 * @param {string} prefix - key prefix, e.g. "Imitations/"
 * @returns {Promise<any[]>} the matching records
 *
 * @example
 * >>> await getAllByPrefix(ASSET_STORE, "Imitations/")
 * [{project: "Imitations", file: "logo.png", blob: Blob, size: 8213, mtime: 1769800000000}]
 */
export function getAllByPrefix(storeName, prefix) {
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  return withStore(storeName, "readonly", (s) => promisify(s.getAll(range), `getAllByPrefix(${storeName}, ${prefix})`));
}

/**
 * Command (mutates browser storage). Delete every record in `storeName` under
 * `prefix` — how deleting a whole project drops its assets in one transaction.
 *
 * @param {string} storeName - DOC_STORE or ASSET_STORE
 * @param {string} prefix - key prefix
 * @returns {Promise<void>}
 *
 * @example
 * >>> await deleteByPrefix(ASSET_STORE, "Old Deck/")  // that project's assets are gone
 */
export function deleteByPrefix(storeName, prefix) {
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  return withStore(storeName, "readwrite", (s) => promisify(s.delete(range), `deleteByPrefix(${storeName}, ${prefix})`));
}

// ── Storage BUDGET (the Asset Explorer's quota line) ─────────────────────────
// The user asked: "if there is a certain amount of storage per user, per
// browser, it should say that amount of storage so they know how close they are
// to filling it up." navigator.storage.estimate() is that number. It is an
// ORIGIN-WIDE estimate (all of this site's IndexedDB + Cache + localStorage,
// not just PowerRP's stores) and browsers deliberately GRANULARIZE it to resist
// fingerprinting, so it is reported as an estimate, never as an exact ledger.

/**
 * Query. This origin's storage budget: `{usage, quota, persisted, supported}`
 * in bytes. `supported` is false where the Storage API is missing (older Safari,
 * a non-secure context in some browsers) — the caller then says "unavailable"
 * instead of rendering "0 of 0", which would read as a full disk.
 *
 * NOT loud on failure, deliberately and by exception: this is a DIAGNOSTIC
 * READOUT, and a browser that declines to estimate must not break the pane that
 * displays it. The refusal is still REPORTED — it comes back as
 * `{supported: false, error}` and the caller renders that text — so nothing is
 * silently swallowed.
 *
 * @returns {Promise<{usage: number, quota: number, persisted: boolean, supported: boolean, error?: string}>}
 *
 * @example
 * >>> await storageBudget()
 * {usage: 4823129, quota: 2147483648, persisted: false, supported: true}
 * >>> // browser without the Storage API:
 * >>> await storageBudget()
 * {usage: 0, quota: 0, persisted: false, supported: false, error: "navigator.storage.estimate is unavailable"}
 */
export async function storageBudget() {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { usage: 0, quota: 0, persisted: false, supported: false, error: "navigator.storage.estimate is unavailable" };
  }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usage, quota, persisted, supported: true };
  } catch (e) {
    return { usage: 0, quota: 0, persisted: false, supported: false, error: String(e?.message ?? e) };
  }
}

/**
 * Command (asks the browser for a permission). Request PERSISTENT storage, so
 * the browser stops treating this origin's data as evictable cache. Resolves to
 * the browser's ANSWER (true = granted), which the caller SURFACES — that is the
 * point of returning it rather than firing and forgetting: in static mode the
 * user's decks live only here, and "best effort" versus "persistent" is the
 * difference between storage that can vanish under pressure and storage that
 * cannot.
 *
 * Chrome grants this silently based on site engagement; Firefox prompts; Safari
 * grants it for installed web apps. A denial is NORMAL, not an error, so it is
 * reported as `false` rather than thrown.
 *
 * @returns {Promise<boolean>} whether storage is now persistent
 *
 * @example
 * >>> await requestPersistence()   // Chrome, low engagement
 * false
 * >>> await requestPersistence()   // after the user installs/engages
 * true
 */
export async function requestPersistence() {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
  return navigator.storage.persist();
}
