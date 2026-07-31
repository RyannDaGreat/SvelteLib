/**
 * debugStorage.js — THE STORAGE INVENTORY behind the Debug console's Storage
 * page: every byte this origin holds, GROUPED, with a subtotal per group and a
 * grand total checked against the browser's own `navigator.storage.estimate()`.
 *
 * ── WHY A SEPARATE ENUMERATION FROM assetStore.js/localDb.js ─────────────────
 * Those modules answer "what does THIS project have" for the live editor. This
 * module answers "what does THIS ORIGIN have, across every project, every
 * draft, every rendering and every cache" — a cross-cutting question no single
 * existing store answers, and a debug tool's whole job is to see past the
 * per-project seam. It reads the SAME underlying stores (localDb's `powerrp`
 * database, localRenderStore's `powerrp-renderings`, the Cache API) rather than
 * duplicating their key grammars, so a change to how an asset is keyed cannot
 * silently desync the inventory from reality.
 *
 * ── GROUPS, in the fixed order the Storage page renders them ─────────────────
 *   documents   one row per saved project's doc.json + one for the DRAFT
 *               keyspace (labeled, not hidden — draftKeys.isDraftKey names it)
 *   assets      one row per stored asset blob, across EVERY project keyspace
 *               including the draft
 *   renderings  one row per finished/in-progress browser rendering
 *   caches      one row per CacheStorage cache (entry count + summed bytes;
 *               per-entry detail is a separate, foldable listing)
 *   other       any OTHER IndexedDB database `indexedDB.databases()` reveals,
 *               named honestly even when this module does not know its schema
 *
 * ── HTTP MODE IS HONEST, NOT HIDDEN ───────────────────────────────────────────
 * In server mode, project documents and assets live behind HTTP, not in this
 * browser's storage — `inventoryGroups` still lists them (byte sizes come from
 * the SAME listing calls the Asset Explorer already uses), but callers must
 * label that group "server-side" rather than implying it counts against the
 * browser quota. Renderings, caches and "other" IndexedDB databases are
 * ALWAYS browser-local, in either storage mode (a render can be a browser job
 * even against an HTTP project; the service worker's caches exist regardless
 * of storageMode()).
 *
 * ── WHAT IS PURE HERE, AND WHAT IS NOT ────────────────────────────────────────
 * Grouping, subtotaling and the byte-delta line are PURE functions over plain
 * data, so they are node-testable with no DOM. Gathering that data — reading
 * three IndexedDB databases, CacheStorage, and the storage estimate — is
 * necessarily browser-only I/O and lives in the `gather*` QUERY functions below
 * them, kept thin so the interesting logic stays pure and testable.
 */

import { humanReadableFileSize } from "./fileSize.js";
import { DRAFT_KEY, isDraftKey } from "./draftKeys.js";

/** The group ids, in FIXED DISPLAY ORDER — the Storage page iterates this array
 *  rather than `Object.keys` on a grouped map, so the order can never depend on
 *  insertion or a JS engine's key-iteration quirks. */
export const STORAGE_GROUPS = Object.freeze(["documents", "assets", "renderings", "caches", "other"]);

/** Display metadata for each group — title and one-line explanation, read by
 *  the Storage page so a new group added to STORAGE_GROUPS needs no parallel
 *  edit to a second table of titles. */
export const GROUP_INFO = Object.freeze({
  documents: { title: "Project Documents", help: "Every saved project's doc.json, plus the unsaved draft keyspace." },
  assets: { title: "Assets", help: "Uploaded files (images, video, audio, fonts, plugin sources) per project, including the draft." },
  renderings: { title: "Renderings", help: "Finished and in-progress browser-rendered videos (the powerrp-renderings database)." },
  caches: { title: "CacheStorage", help: "The offline service-worker caches: the app shell, icons, and page metadata." },
  other: { title: "Other IndexedDB", help: "Any other IndexedDB database this origin holds that the inventory does not have a specific reader for." },
});

/**
 * Pure function. One inventory ROW's display label, given a project/draft name.
 * The draft keyspace is LABELED, never hidden or shown under its raw key — a
 * user auditing storage must be able to tell "my unsaved work" from a project
 * named literally "~draft/current" (which cannot exist — draftKeys.js's
 * validProjectName forbids the slash — but the row must say so regardless of
 * that guarantee holding elsewhere).
 *
 * @param {string} key - a project name or the draft key
 * @returns {string}
 *
 * @example rowLabel("RobotSim")
 * 'RobotSim'
 * @example rowLabel("~draft/current")
 * '~draft/current (unsaved draft)'
 */
export function rowLabel(key) {
  return isDraftKey(key) ? `${key} (unsaved draft)` : key;
}

/**
 * Pure function. Sort rows BIGGEST FIRST — the one rule every group in the
 * Storage page follows, because the whole point of a debug storage view is
 * finding the pigs. Stable on ties (Array.prototype.sort is stable per spec),
 * so equal-size rows keep their original relative order rather than jittering.
 *
 * @param {{bytes: number}[]} rows
 * @returns {{bytes: number}[]} a NEW array, descending by `bytes`
 *
 * @example
 * >>> biggestFirst([{name: "a", bytes: 10}, {name: "b", bytes: 90}, {name: "c", bytes: 50}]).map(r => r.name)
 * ['b', 'c', 'a']
 */
export function biggestFirst(rows) {
  return [...rows].sort((a, b) => b.bytes - a.bytes);
}

/**
 * Pure function. One group's rows → `{rows, subtotal}`, rows sorted
 * biggest-first (see biggestFirst) and `subtotal` the sum of every row's
 * bytes. The one shape every group in the Storage page renders.
 *
 * @param {{bytes: number}[]} rows
 * @returns {{rows: object[], subtotal: number}}
 *
 * @example
 * >>> summarizeGroup([{name: "logo.png", bytes: 8000}, {name: "clip.mp4", bytes: 92000}])
 * {rows: [{name: 'clip.mp4', bytes: 92000}, {name: 'logo.png', bytes: 8000}], subtotal: 100000}
 * @example // an empty group is a real, zero-subtotal answer — not an absent one:
 * >>> summarizeGroup([])
 * {rows: [], subtotal: 0}
 */
export function summarizeGroup(rows) {
  return { rows: biggestFirst(rows), subtotal: rows.reduce((sum, r) => sum + r.bytes, 0) };
}

/**
 * Pure function. The full inventory, GROUPED in STORAGE_GROUPS order, each with
 * its own subtotal, plus a GRAND TOTAL across every group — the one shape the
 * Storage page renders top to bottom.
 *
 * `rowsByGroup` need not declare every group; a missing key is treated as an
 * empty group (a store that gathered nothing is not an error — see the
 * `gather*` functions' honest-empty contract below).
 *
 * @param {Object<string, {bytes: number}[]>} rowsByGroup - group id → its rows
 * @returns {{groups: {id: string, rows: object[], subtotal: number}[], grandTotal: number}}
 *
 * @example
 * >>> const inv = inventoryReport({documents: [{name: "RobotSim", bytes: 4000}], assets: [{name: "RobotSim/logo.png", bytes: 8000}]});
 * >>> inv.groups.map(g => [g.id, g.subtotal])
 * [['documents', 4000], ['assets', 8000], ['renderings', 0], ['caches', 0], ['other', 0]]
 * >>> inv.grandTotal
 * 12000
 */
export function inventoryReport(rowsByGroup) {
  const groups = STORAGE_GROUPS.map((id) => ({ id, ...summarizeGroup(rowsByGroup[id] ?? []) }));
  return { groups, grandTotal: groups.reduce((sum, g) => sum + g.subtotal, 0) };
}

/**
 * Pure function. The honest COMPARISON line between the inventory's own count
 * and the browser's `navigator.storage.estimate()` — "browsers round
 * deliberately" (fingerprinting resistance), so the two numbers are expected to
 * differ, and a delta is reported rather than either being asserted as truth.
 *
 * `estimate.supported === false` (older Safari, a non-secure context) is
 * reported as "estimate unavailable" rather than comparing against a fabricated
 * zero, which would read as a suspiciously precise 100% usage figure.
 *
 * @param {number} grandTotal - inventoryReport(...).grandTotal
 * @param {{usage: number, quota: number, supported: boolean}} estimate - localDb.storageBudget()'s shape
 * @param {(bytes: number) => string} format - a byte formatter (fileSize.js humanReadableFileSize)
 * @returns {string}
 *
 * @example estimateDeltaLine(12000, {usage: 20000, quota: 1e9, supported: true}, humanReadableFileSize)
 * 'Inventory counts 11.7KB; the browser estimates 19.5KB in use (browsers round deliberately).'
 * @example estimateDeltaLine(12000, {supported: false}, humanReadableFileSize)
 * 'Inventory counts 11.7KB; the browser storage estimate is unavailable here.'
 */
export function estimateDeltaLine(grandTotal, estimate, format) {
  const counted = `Inventory counts ${format(grandTotal)}`;
  if (!estimate?.supported) return `${counted}; the browser storage estimate is unavailable here.`;
  return `${counted}; the browser estimates ${format(estimate.usage)} in use (browsers round deliberately).`;
}

// ── GATHERING (browser I/O) ───────────────────────────────────────────────────
// Each function below reads ONE live source and returns rows in the
// `{bytes: number, ...}` shape inventoryReport expects. None of them throw on
// an empty/absent source — an empty database, a missing cache, a browser with
// no IndexedDB support for a store this app does not use are all legitimate
// "nothing here" answers, not failures. A genuine read error (a blocked
// IndexedDB open, a corrupt record) is still LOUD, because that is a real
// defect in what should be a passive inventory.

/**
 * Query (reads IndexedDB). Every saved project's document as one DOCUMENTS row
 * (JSON-serialized byte size), plus the draft keyspace's document when one is
 * open. Local (static) mode only — see the module docblock for why HTTP-mode
 * documents are gathered by the caller from the existing project listing
 * instead (this function does not reach the network).
 *
 * @param {{name: string, doc: object}[]} localDocs - raw records from localDb DOC_STORE
 * @returns {{name: string, bytes: number}[]}
 */
export function documentRowsFromLocalDocs(localDocs) {
  return localDocs.map((rec) => ({ name: rowLabel(rec.name), bytes: new Blob([JSON.stringify(rec.doc)]).size }));
}

/**
 * Pure function. Group ASSET rows by their owning project/draft key, for the
 * "per keyspace" subheadings the Storage page's Assets group renders above
 * each keyspace's own file list — a project with 40 small assets and a draft
 * with one giant video should both read as distinct keyspaces, not one
 * undifferentiated per-file dump.
 *
 * UNLIKE THE EARLIER SHAPE THIS REPLACES, individual FILES are kept (sorted
 * biggest-first within their keyspace) rather than collapsed to a bare
 * subtotal — per-file download/preview affordances need the individual rows,
 * and a debug storage view whose files you cannot reach defeats its own
 * purpose ("finding the pigs" means finding the ONE file, not just the folder).
 *
 * @param {{project: string, name: string, bytes: number, kind?: string}[]} assetRows - every asset, any project
 * @returns {{project: string, bytes: number, files: object[]}[]} one entry per keyspace, UNSORTED
 * (the caller sorts biggest-first via summarizeGroup/biggestFirst)
 *
 * @example
 * >>> const g = assetsByKeyspace([{project: "A", name: "x.png", bytes: 100}, {project: "A", name: "y.png", bytes: 50}, {project: "~draft/current", name: "z.mp4", bytes: 900}]);
 * >>> g.map(k => [k.project, k.bytes, k.files.map(f => f.name)])
 * [['A', 150, ['x.png', 'y.png']], ['~draft/current', 900, ['z.mp4']]]
 */
export function assetsByKeyspace(assetRows) {
  const byProject = new Map();
  for (const a of assetRows) {
    const entry = byProject.get(a.project) ?? { project: a.project, bytes: 0, files: [] };
    entry.bytes += a.bytes;
    entry.files.push(a);
    byProject.set(a.project, entry);
  }
  for (const entry of byProject.values()) entry.files = biggestFirst(entry.files);
  return [...byProject.values()];
}

/**
 * Query (reads CacheStorage). One row per cache this origin owns: entry count
 * and summed response body bytes, via `Response.blob().size` on every cached
 * entry (the Cache API exposes no cheaper per-cache size figure).
 *
 * FOLDED DETAIL ROWS ARE ALSO RETURNED (not just the subtotal), because the
 * user ruling asks for "per-entry listing behind a fold, since 159 shell
 * entries is noise most of the time" — the fold is a PRESENTATION choice made
 * by the Storage page, not a reason to throw the per-entry data away here.
 *
 * @returns {Promise<{name: string, bytes: number, entries: {url: string, bytes: number}[]}[]>}
 */
export async function gatherCacheRows() {
  if (typeof caches === "undefined") return [];
  const names = await caches.keys();
  const rows = [];
  for (const name of names) {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    const entries = [];
    for (const req of requests) {
      const res = await cache.match(req);
      const bytes = res ? (await res.blob()).size : 0;
      entries.push({ url: req.url, bytes });
    }
    rows.push({ name, bytes: entries.reduce((s, e) => s + e.bytes, 0), entries });
  }
  return rows;
}

/**
 * Query (reads IndexedDB metadata only — opens no connection). Every database
 * `indexedDB.databases()` reveals that this module has NO dedicated reader
 * for, reported HONESTLY as "unknown contents" rather than silently omitted.
 *
 * KNOWN DATABASE NAMES ARE EXCLUDED via `knownNames`, so the caller's own
 * localDb/localRenderStore/browserJobStore readers are not double-counted here
 * as a mystery entry. `indexedDB.databases()` reports `{name, version}` only —
 * no size — which is why this group's rows carry `bytes: null` rather than a
 * fabricated number; the Storage page renders that as "size unknown" instead
 * of a misleading 0.
 *
 * @param {Set<string>} knownNames - database names already covered by a specific reader
 * @returns {Promise<{name: string, bytes: null, version: number}[]>}
 */
export async function gatherOtherDatabaseRows(knownNames) {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return [];
  const dbs = await indexedDB.databases();
  return dbs.filter((d) => d.name && !knownNames.has(d.name)).map((d) => ({ name: d.name, bytes: null, version: d.version }));
}

/** The database names this module has SPECIFIC readers for — passed to
 *  gatherOtherDatabaseRows so those three do not also appear as "unknown". */
export const KNOWN_DATABASE_NAMES = Object.freeze(new Set(["powerrp", "powerrp-renderings", "powerrp-browser-renders"]));

/**
 * Pure function. The debug page id web/DebugConsole.svelte should open on,
 * given what was persisted (localStorage) and the known DEBUG_PAGES table —
 * falls back to the FIRST page when nothing is stored yet, or when a stored id
 * no longer names a real page (a page was removed, or the value is a stale /
 * hand-edited localStorage entry). Kept here rather than in the .svelte file
 * so it is testable in bare node (Node cannot parse Svelte's module script).
 *
 * @param {string|null} storedId - localStorage.getItem(LAST_DEBUG_PAGE_KEY)
 * @param {{id: string}[]} pages - DEBUG_PAGES
 * @returns {string} a page id guaranteed to be IN `pages`
 *
 * @example resolveInitialPage("storage", [{id: "storage"}, {id: "network"}])
 * 'storage'
 * @example // an id from a page that no longer exists falls back to the first:
 * resolveInitialPage("removed-tool", [{id: "storage"}, {id: "network"}])
 * 'storage'
 * @example resolveInitialPage(null, [{id: "storage"}])
 * 'storage'
 */
export function resolveInitialPage(storedId, pages) {
  return pages.some((p) => p.id === storedId) ? storedId : pages[0].id;
}

export { DRAFT_KEY };
