/**
 * storageTree.js — ONE TREE VIEW OVER EVERY STORE THIS EDITOR CAN REACH.
 *
 * The user's ask (R6-19.1): "It is getting rather annoying how many things there
 * are to keep track of." Renderings, caches and assets live in five unrelated
 * key-value stores plus a real directory tree behind HTTP, and until now the only
 * way to see them all at once was the Debug console's Storage page — a debug tool,
 * grouped by size, with no navigation.
 *
 * THIS MODULE IS THE SEAM, NOT A SECOND STORE. Every byte it reports comes from a
 * store the app already uses: web/assetStore.js's two adapters, web/localDb.js,
 * web/localRenderStore.js, web/projectApi.js, web/debugStorage.js's Cache and
 * `indexedDB.databases()` readers, and web/builtinAssets.js. It adds NO new
 * request, NO new key grammar and NO cached copy of anything. What it adds is
 * HIERARCHY and ONE VOCABULARY — which is what R6-19 was actually missing. The
 * grammar itself lives in web/storagePath.js (DOM-free and doctested); this file
 * is the I/O half, exactly as web/assetStore.js is the I/O half of assetRef.js.
 *
 * ── THE THREE ROOTS, AND WHY THERE ARE THREE ─────────────────────────────────
 *   local:    THIS BROWSER. Present in EVERY mode — not just static. A DRAFT's
 *             bytes live here regardless of storageMode() (web/storageMode.js's
 *             assetStoreFor), and so do the service-worker caches and any stray
 *             IndexedDB database. Hiding it in HTTP mode would be a lie.
 *   server:   THE PROJECT SERVER. Present only in HTTP mode. A REAL filesystem
 *             with real directories — the only root where `assets/` and
 *             `renders/` are folders rather than a presentation choice.
 *   builtin:  THE BUNDLED LIBRARY, read-only. A SIBLING root and never a folder
 *             inside a project, because web/builtinAssets.js's rule is that
 *             built-ins "must NEVER appear in that project asset list" (task #68,
 *             which pulled the cursors back out of the Asset Explorer). Under a
 *             project keyspace they would be exactly that again.
 *
 * SO IN HTTP MODE THE TREE GENUINELY HAS TWO WRITABLE ROOTS. That is not a wart
 * to be smoothed over: documents and assets are behind HTTP while renderings,
 * caches and the draft are in this page, and web/debugStorage.js:27-35 already
 * states it. A single-rooted browser would have to lie about one of them.
 *
 * ── list() NEVER SWALLOWS ────────────────────────────────────────────────────
 * It returns `{entries, errors}`. A store that FAILED and a store that is EMPTY
 * must never look the same — that is the single most important behavioural rule
 * here, and it is why the return is a pair rather than an array. One root being
 * unreachable must not blank the other two either, which a plain throw would do.
 * Each error carries the path it belongs to and a sentence, and the pane renders
 * them ABOVE the rows it did get.
 *
 * ── WHAT IT DELIBERATELY CANNOT DO, AND HOW IT SAYS SO ───────────────────────
 * Every root declares `capabilities`, and an operation it cannot perform carries
 * A SENTENCE saying why and what to use instead — never a missing button and
 * never an empty list. The mechanism is web/storageMode.js's
 * `UNAVAILABLE_IN_STATIC` + `refuseInStatic` pattern (a table of user-facing
 * reason strings, one per feature, and one function that throws the right one),
 * extended rather than duplicated: see UNAVAILABLE_HERE and refuseOperation.
 *
 * THE BROWSER IS READ-ONLY IN THIS VERSION, and that is a SAFETY choice, not an
 * omission. Deleting an asset from the Asset Explorer first counts the widgets
 * still pointing at it and makes you confirm (its `assetUsers`/`deleteTip`);
 * deleting a rendering goes through the Render Center, which knows whether a job
 * is still encoding. A delete button here would bypass both checks, so the
 * capability sentences send the user to the surface that has them.
 */

import { assetRef } from "./assetRef.js";
import { builtinCategories, BUILTIN_URL_PREFIX } from "./builtinAssets.js";
import { DRAFT_KEY, isDraftKey } from "./draftKeys.js";
import { downloadBytes } from "./fileDownload.js";
import { gatherCacheRows, gatherOtherDatabaseRows, KNOWN_DATABASE_NAMES, rowLabel } from "./debugStorage.js";
import { DOC_STORE, promisify, withStore } from "./localDb.js";
import { listRenderJobs as listLocalRenderJobs, renderingBlob } from "./localRenderStore.js";
import { localAssetStore, httpAssetStore } from "./assetStore.js";
import * as projectApi from "./projectApi.js";
import { isStatic } from "./storageMode.js";
import { CACHES_KEYSPACE, OTHER_DB_KEYSPACE, childPath, joinPath, parsePath } from "./storagePath.js";

/** The three CATEGORIES a project keyspace holds, in fixed display order. These
 *  are REAL DIRECTORIES on the server and a presentation grouping in the browser
 *  store (three separate databases wearing one parent's name) — which is why
 *  every category node carries a `note` saying which it is. */
export const PROJECT_CATEGORIES = Object.freeze(["document", "assets", "renders"]);

/**
 * THE UNAVAILABILITY TABLE — one full user-facing sentence per operation this
 * browser does not perform, naming WHY and WHAT TO USE INSTEAD. The twin of
 * web/storageMode.js's `UNAVAILABLE_IN_STATIC`, and deliberately the same shape:
 * a flat map of operation → sentence, read by the UI to label a disabled
 * affordance and thrown by `refuseOperation` when code reaches one anyway.
 *
 * NOT MERGED INTO `UNAVAILABLE_IN_STATIC` because that table answers a different
 * question — "this needs a backend" — and these hold in EVERY mode.
 */
export const UNAVAILABLE_HERE = Object.freeze({
  remove:
    "Deleting is done where the consequences are known: the Asset Explorer counts the widgets still pointing at a file before it asks, and the Render Center knows whether a job has finished encoding.",
  rename:
    "Neither store has a rename verb for a single file — a name IS the identity in both (there is no content hash), so renaming one would orphan every document reference to it. Rename the whole project instead.",
  write:
    "Uploading is done in the Asset Explorer, which also registers fonts, rasterizes PDF previews and de-collides the name against what is already there.",
  nest:
    "A slash inside a browser-store key is part of the name, not a folder — IndexedDB has no directories, and this app's one path-like convention is a single level (web/localDb.js).",
  listDerivedCaches:
    "The server keeps derived caches in assets/.thumbs/ and assets/frames/, but exposes no route that lists them — list_assets is deliberately non-recursive, so a cached thumbnail can be fetched by name and never enumerated.",
  quota:
    "Server-backed storage has no per-browser quota to report — the budget shown in browser-local mode is this origin's, and the server's disk is not.",
});

/**
 * Command. Throw the NAMED sentence for an operation this browser does not
 * perform — the loud half of the capability contract, and the exact twin of
 * web/storageMode.js's `refuseInStatic`. A caller that reaches a refused path
 * gets the explanation, never a silent no-op or a fetch against a route that
 * was never going to exist.
 *
 * @param {keyof UNAVAILABLE_HERE} operation
 * @throws {Error} always
 *
 * @example
 * >>> refuseOperation("rename")
 * Error: Neither store has a rename verb for a single file — …
 */
export function refuseOperation(operation) {
  throw new Error(UNAVAILABLE_HERE[operation] ?? `"${operation}" is not something the File Browser does.`);
}

/**
 * Pure function. One storage entry, in the ONE shape every node of the tree has.
 * A constructor rather than an object literal at nine call sites, so a new field
 * cannot be present on some node kinds and absent on others.
 *
 * `bytes: null` means GENUINELY UNKNOWN and is rendered "size unknown" or
 * "server-side" — never 0. That distinction is not new: `gatherOtherDatabaseRows`
 * already returns null rather than "a fabricated number", because
 * `indexedDB.databases()` reports no size.
 *
 * @param {object} fields
 * @param {string} fields.path - canonical, round-trips through storagePath
 * @param {string} fields.name - the display leaf
 * @param {"dir"|"file"} fields.type
 * @param {string} [fields.kind] - an asset kind (image/video/pdf/…) for preview dispatch
 * @param {?number} [fields.bytes] - null = unknown, never 0-as-unknown
 * @param {?number} [fields.mtime] - SECONDS (both stores already normalise; assetStore.js:176)
 * @param {?string} [fields.url] - a RESOLVED, directly loadable URL for preview, or null
 * @param {?string} [fields.thumbnail] - a cached preview bitmap's URL (a rasterized PDF page 1), or null
 * @param {?string} [fields.badge] - corner text (a PDF page count)
 * @param {string} fields.note - ONE honest sentence naming what actually backs this node
 * @returns {object}
 *
 * `thumbnail` IS PART OF THE RECORD because the tile layer reads it
 * (web/AssetThumb.svelte, through assetThumbnail.js's tile presentation). It was
 * missing from this destructure while the reader already looked for it, so a
 * server-cached PDF page-1 bitmap was gathered, passed in, and dropped on the
 * floor — the tile fell back to rasterizing it again, or to a glyph, silently. A
 * field a consumer reads must exist on the object the constructor mints.
 *
 * @example
 * >>> entry({path: "server:/D/assets/a.png", name: "a.png", type: "file", kind: "image", bytes: 812, mtime: 1769800000, url: "/asset/D/a.png", note: "A file in this project's assets/ folder on the server."})
 * {path: 'server:/D/assets/a.png', name: 'a.png', type: 'file', kind: 'image', bytes: 812, mtime: 1769800000, url: '/asset/D/a.png', thumbnail: null, badge: null, note: "A file in this project's assets/ folder on the server."}
 */
export function entry({ path, name, type, kind = "other", bytes = null, mtime = null, url = null, thumbnail = null, badge = null, note }) {
  return { path, name, type, kind, bytes, mtime, url, thumbnail, badge, note };
}

// ── THE ROOTS ────────────────────────────────────────────────────────────────
// Each declares a label, an icon, its capabilities, and a `list(parsed)` Query
// that answers for ONE parsed path. They never catch into an empty list: a
// failure propagates to `listPath`, which turns it into an `errors[]` entry
// carrying the path it belongs to.

/**
 * Query (reads IndexedDB). The keyspaces the LOCAL root holds: every stored
 * document's name, plus the DRAFT key, plus the two reserved keyspaces holding
 * this browser's non-project storage.
 *
 * THE DRAFT IS ADDED EXPLICITLY, not discovered. An opened-but-unsaved draft has
 * ASSETS BUT NO DOCUMENT RECORD (its document rides `localStorage
 * powerrp.autosave`), so enumerating doc names alone would drop the user's
 * unsaved work from the inventory entirely. web/DebugStoragePage.svelte's gather
 * does the same thing for the same reason, and web/localDb.js:29-59 explains why
 * the reverse — sweeping assets with no project — would delete it.
 *
 * @returns {Promise<string[]>} keyspace names
 */
async function localKeyspaces() {
  const recs = await withStore(DOC_STORE, "readonly", (s) => promisify(s.getAll(), "storageTree: reading local documents"));
  const names = new Set(recs.map((r) => r.name));
  names.add(DRAFT_KEY);
  return [...names];
}

/** THIS BROWSER — present in every mode (see the module docblock). */
const localRoot = {
  id: "local",
  label: "This browser",
  icon: "mdi:web",
  capabilities: {
    write: false,
    remove: false,
    rename: false,
    nest: false,
    bytes: true,
    mtime: true,
    unavailable: { write: UNAVAILABLE_HERE.write, remove: UNAVAILABLE_HERE.remove, rename: UNAVAILABLE_HERE.rename, nest: UNAVAILABLE_HERE.nest },
  },

  async list({ keyspace, category }) {
    if (keyspace === null) return listLocalKeyspaceNodes();
    if (keyspace === CACHES_KEYSPACE) return category === null ? listCacheNodes() : listCacheEntryNodes(category);
    if (keyspace === OTHER_DB_KEYSPACE) return listOtherDatabaseNodes();
    if (category === null) return projectCategoryNodes("local", keyspace);
    if (category === "document") return listLocalDocumentNodes(keyspace);
    if (category === "assets") return listAssetNodes("local", keyspace, localAssetStore);
    if (category === "renders") return listLocalRenderNodes(keyspace);
    throw new Error(`storageTree: "${category}" is not a category of a local keyspace (${PROJECT_CATEGORIES.join(", ")})`);
  },

  /** Query. One entry's bytes as a Blob. */
  async read({ keyspace, category, name }) {
    if (category === "assets") return localAssetStore.get(keyspace, name);
    if (category === "renders") return renderingBlob(keyspace, name);
    refuseOperation("read");
  },
};

/** THE PROJECT SERVER — HTTP mode only, and the one root with real directories. */
const serverRoot = {
  id: "server",
  label: "Project server",
  icon: "mdi:server",
  capabilities: {
    write: false,
    remove: false,
    rename: false,
    nest: true,
    bytes: true,
    mtime: true,
    unavailable: {
      write: UNAVAILABLE_HERE.write,
      remove: UNAVAILABLE_HERE.remove,
      rename: UNAVAILABLE_HERE.rename,
      listDerivedCaches: UNAVAILABLE_HERE.listDerivedCaches,
      quota: UNAVAILABLE_HERE.quota,
    },
  },

  async list({ keyspace, category }) {
    if (keyspace === null) {
      const projects = await projectApi.listProjects();
      return projects.map((p) =>
        entry({
          path: joinPath("server", p.name),
          name: p.name,
          type: "dir",
          mtime: p.mtime ?? null,
          note: "A real directory under the server's projects/ folder.",
        }));
    }
    if (category === null) return projectCategoryNodes("server", keyspace);
    if (category === "document") return [
      entry({
        path: joinPath("server", keyspace, "document", "doc.json"),
        name: "doc.json",
        type: "file",
        kind: "data",
        // The project listing carries no byte size for doc.json, and fetching one
        // per project purely to fill this column is a second network round trip
        // for a number nobody navigated here to read (the same call the Debug
        // page declines to make, DebugStoragePage.svelte's documents branch).
        bytes: null,
        note: "The project document itself, on the server. Its size is not in the project listing, so it is not counted here rather than guessed.",
      })];
    if (category === "assets") return listAssetNodes("server", keyspace, httpAssetStore);
    if (category === "renders") return listServerRenderNodes(keyspace);
    throw new Error(`storageTree: "${category}" is not a category of a server project (${PROJECT_CATEGORIES.join(", ")})`);
  },

  async read({ keyspace, category, name }) {
    if (category === "assets") return httpAssetStore.get(keyspace, name);
    if (category === "renders") {
      const res = await fetch(projectApi.renderUrl(keyspace, name));
      if (!res.ok) throw new Error(`storageTree: reading the rendering "${name}" — ${res.status} ${res.statusText}`);
      return res.blob();
    }
    refuseOperation("read");
  },
};

/** THE BUNDLED LIBRARY — read-only, and a sibling root by rule (see the docblock). */
const builtinRoot = {
  id: "builtin",
  label: "Built-in library",
  icon: "mdi:package-variant-closed",
  capabilities: {
    write: false,
    remove: false,
    rename: false,
    nest: false,
    bytes: false,
    mtime: false,
    unavailable: {
      write: "Built-ins ship with the app — they are the same for every project and cannot be added to, deleted or renamed from here.",
      remove: "Built-ins ship with the app — they are the same for every project and cannot be added to, deleted or renamed from here.",
      rename: "Built-ins ship with the app — they are the same for every project and cannot be added to, deleted or renamed from here.",
    },
  },

  async list({ keyspace, category }) {
    const cats = builtinCategories();
    // ONE keyspace, "library", so the built-in root reads at the same depth as
    // the other two rather than putting its categories where a project name goes.
    if (keyspace === null) return [
      entry({
        path: joinPath("builtin", "library"),
        name: "library",
        type: "dir",
        note: "Assets bundled with the app. Deliberately separate from a project's own library — a built-in must never appear in the project asset list (task #68).",
      })];
    if (category === null) return cats.map((c) =>
      entry({
        path: joinPath("builtin", "library", c.id),
        name: c.id,
        type: "dir",
        note: c.description,
      }));
    const cat = cats.find((c) => c.id === category);
    if (!cat) throw new Error(`storageTree: "${category}" is not a built-in category (${cats.map((c) => c.id).join(", ")})`);
    return cat.assets.map((a) =>
      entry({
        path: joinPath("builtin", "library", category, a.name),
        name: a.name,
        type: "file",
        kind: a.kind,
        bytes: a.size ?? null,
        url: a.url,
        note: `Bundled with the app; its ref is "${BUILTIN_URL_PREFIX}…", which can never collide with a project asset.`,
      }));
  },

  async read() {
    refuseOperation("read");
  },
};

/** Every root, by id. The ONE table; `activeRoots()` filters it by mode. */
const ROOTS = Object.freeze({ local: localRoot, server: serverRoot, builtin: builtinRoot });

/**
 * Query (reads the boot-time storage mode). The roots that EXIST on this page,
 * in display order. `server:` is absent in browser-local mode because there is no
 * server — an empty server root would be indistinguishable from one that failed.
 *
 * @returns {object[]} root descriptors ({id, label, icon, capabilities, …})
 *
 * @example
 * >>> activeRoots().map((r) => r.id)     // HTTP mode
 * ['server', 'local', 'builtin']
 * >>> activeRoots().map((r) => r.id)     // static mode
 * ['local', 'builtin']
 */
export function activeRoots() {
  return isStatic() ? [localRoot, builtinRoot] : [serverRoot, localRoot, builtinRoot];
}

/**
 * Query. One root descriptor by id. Throws on an unknown id rather than
 * answering with the local root, which would silently show the wrong store.
 *
 * @param {string} id
 * @returns {object}
 */
export function rootFor(id) {
  const root = ROOTS[id];
  if (!root) throw new Error(`storageTree.rootFor("${id}"): unknown root (${Object.keys(ROOTS).join(", ")})`);
  return root;
}

/**
 * Query (reads every store the path touches). THE ONE ENTRY POINT: list a path's
 * children as `{entries, errors}`.
 *
 * IT NEVER CATCHES INTO AN EMPTY LIST. A failure becomes an `errors` element
 * carrying the path and a sentence, and whatever entries WERE obtained still
 * render — because a store that failed and a store that is empty must never look
 * the same, and one broken root must not blank the rest of the tree.
 *
 * @param {string} path - a canonical storage path
 * @returns {Promise<{entries: object[], errors: {path: string, message: string}[]}>}
 *
 * @example
 * >>> await listPath("server:/RobotSim/assets")
 * {entries: [{name: 'arm.png', …}, …], errors: []}
 * @example // a backend that stopped answering REPORTS, and does not read as empty:
 * >>> await listPath("server:/")
 * {entries: [], errors: [{path: 'server:/', message: 'listProjects: 500'}]}
 */
export async function listPath(path) {
  const parsed = parsePath(path);
  try {
    return { entries: await rootFor(parsed.root).list(parsed), errors: [] };
  } catch (e) {
    // THE ONE CAUGHT EXCEPTION IN THIS MODULE, and it is not swallowed: it is
    // converted into a REPORTED error on the returned pair, which the pane
    // renders above the rows. Rethrowing instead would blank the whole browser
    // because one keyspace is unreadable.
    console.error(`storageTree.listPath("${path}"):`, e);
    return { entries: [], errors: [{ path, message: String(e?.message ?? e) }] };
  }
}

/**
 * Query. Read one entry's bytes as a Blob, through the root that owns it. Loud
 * on a path whose root has no reader for that category — a preview or a download
 * that cannot happen says so rather than producing an empty file.
 *
 * @param {string} path
 * @returns {Promise<Blob>}
 */
export async function readPath(path) {
  const parsed = parsePath(path);
  if (parsed.name === null) throw new Error(`storageTree.readPath("${path}"): only a file has bytes — this path names a ${parsed.level}`);
  return rootFor(parsed.root).read(parsed);
}

/**
 * Command (reads a store, then triggers a browser download). Save one entry to
 * disk. Goes through web/fileDownload.js's `downloadBytes`, the ONE definition of
 * that gesture in this app — a fourth hand-written copy of the object-URL dance
 * is exactly the defect this browser exists to stop multiplying.
 *
 * @param {object} e - an entry() naming a file
 * @returns {Promise<void>}
 */
export async function downloadEntry(e) {
  downloadBytes(await readPath(e.path), e.name);
}

/** How much of a non-media file an inline preview reads BY DEFAULT. A PREVIEW IS A
 *  PEEK, not a second copy of a multi-megabyte asset held in component state.
 *  Module-top and EXPORTED per core/endpoints.js:23's precedent for a named
 *  constant with a justification — it was function-local in
 *  web/DebugStoragePage.svelte, which is how a second surface could have picked a
 *  different number. */
export const PREVIEW_TEXT_BYTES = 4096;

/** The budget a caller passes when a peek is not good enough and the WHOLE file is
 *  the preview. Exactly one class of file qualifies: a TABLE. web/CsvTable.svelte
 *  is a virtual scroller built for a 100,000-row file, so it wants the real thing —
 *  and it is the one consumer for which a peek is not merely partial but WRONG (see
 *  `truncated` below). Named rather than written as a bare Infinity at the call
 *  site, because "why is this one unbounded" is the question a reader will have. */
export const PREVIEW_WHOLE_FILE = Number.POSITIVE_INFINITY;

/**
 * Query (may create an object URL). THE inline preview for one file's bytes:
 * images and video get an object URL, everything else a UTF-8 read bounded by
 * `maxTextBytes`.
 *
 * ONE DEFINITION, because there were two — web/AssetExplorer.svelte's
 * `loadPreviewText` and web/DebugStoragePage.svelte's `togglePreview` were the
 * same intent in two shapes, and a third written for the File Browser would have
 * made it three. The caller owns the returned object's lifetime and MUST hand it
 * to `releasePreview` when the preview closes.
 *
 * THAT PARAGRAPH WAS FALSE FOR ITS FIRST DAY, and the correction is worth keeping.
 * Only the Debug console's copy was actually converted; `loadPreviewText` went on
 * reading `blob.text()` itself, under a docblock here asserting it had stopped.
 * It could not have been converted as this function was first written, because a
 * table needs the WHOLE file — which is why `maxTextBytes` exists and why all
 * three surfaces can now share one definition. A prose claim about a sweep is only
 * true if the sweep is in the same commit.
 *
 * TRUNCATION IS RETURNED, NOT DRAWN INTO THE TEXT. The first version appended a
 * "\n…" marker to `text`, which is fine in a <pre> and CORRUPTING in a table: the
 * File Browser hands a `data` preview to CsvTable, so a 4 KB peek of a CSV
 * arrived as a mangled final row (the cut lands mid-line) followed by a phantom
 * "…" row, with nothing on screen saying either was an artefact. A flag the
 * caller must render is the same information without the forgery — and it is why
 * `maxTextBytes` exists at all: a table's honest answer is to read the file.
 *
 * @param {Blob} blob - the bytes
 * @param {string} kind - an asset kind (web/assetRef.js assetKindForName)
 * @param {number} maxTextBytes - byte budget for the text branch; PREVIEW_WHOLE_FILE reads it all
 * @returns {Promise<{kind: string, url?: string, text?: string, truncated?: boolean}>}
 *
 * @example
 * >>> await previewOfBlob(pngBlob, "image")
 * {kind: 'image', url: 'blob:http://…'}
 * @example // anything not media is peeked at as text, and SAYS when there is more:
 * >>> await previewOfBlob(bigCsvBlob, "data")
 * {kind: 'text', text: 'a,b,c\n1,2,3\n4,5', truncated: true}
 * @example // a table asks for the file itself, and is told it got all of it:
 * >>> await previewOfBlob(bigCsvBlob, "data", PREVIEW_WHOLE_FILE)
 * {kind: 'text', text: 'a,b,c\n1,2,3\n4,5,6\n', truncated: false}
 */
export async function previewOfBlob(blob, kind, maxTextBytes = PREVIEW_TEXT_BYTES) {
  if (kind === "image" || kind === "video") return { kind, url: URL.createObjectURL(blob) };
  const truncated = blob.size > maxTextBytes;
  const text = await (truncated ? blob.slice(0, maxTextBytes) : blob).text();
  return { kind: "text", text, truncated };
}

/**
 * Command (revokes an object URL). Release a preview made by `previewOfBlob`.
 * Safe on a text preview, which holds no URL — so a caller closing previews in a
 * loop needs no branch of its own.
 *
 * @param {?{url?: string}} preview
 * @returns {void}
 */
export function releasePreview(preview) {
  if (preview?.url) URL.revokeObjectURL(preview.url);
}

/**
 * Query (reads the app's current project). HOME — the directory the File Browser
 * opens at and the Home button returns to (R6-19.4). ONE function, so the draft
 * rule is written down once: a DRAFT is always `local:/~draft/current`, in EVERY
 * storage mode, because that is what `assetStoreFor` and `renderRecordStore`
 * already do with its bytes. An ordinary project is under whichever root actually
 * holds it.
 *
 * @param {object} app - the live PowerRPApp
 * @returns {string} a canonical storage path
 *
 * @example
 * >>> homePath(appWithDraftOpen)
 * 'local:/~draft/current'
 * >>> homePath(appInHttpModeOnRobotSim)
 * 'server:/RobotSim'
 */
export function homePath(app) {
  const project = app.projectName();
  if (isDraftKey(project)) return joinPath("local", project);
  return joinPath(isStatic() ? "local" : "server", project);
}

/**
 * Query (reads the app's current project). WHERE A "REVEAL" AFFORDANCE POINTS
 * (R6-19.6: "Open in file browser from Renderings and from the asset panel") —
 * one of the open project's category folders, under whichever root actually holds
 * it. Its two callers are the Asset Explorer's toolbar and the Render Center's,
 * and neither may spell the path itself: `homePath` is the only place that knows
 * a draft lives under `local:` in EVERY storage mode, and re-deriving that in a
 * pane is how the two would eventually disagree.
 *
 * The category is CHECKED against PROJECT_CATEGORIES rather than concatenated, so
 * a typo is a thrown sentence here instead of an empty folder in the browser.
 *
 * @param {object} app - the live PowerRPApp
 * @param {"document"|"assets"|"renders"} category
 * @returns {string} a canonical storage path
 * @throws {Error} if `category` is not one of PROJECT_CATEGORIES
 *
 * @example
 * >>> projectCategoryPath(appInHttpModeOnRobotSim, "renders")
 * 'server:/RobotSim/renders'
 * @example // a draft's bytes are browser-local whatever the mode, so its path is too:
 * >>> projectCategoryPath(appWithDraftOpen, "assets")
 * 'local:/~draft/current/assets'
 */
export function projectCategoryPath(app, category) {
  if (!PROJECT_CATEGORIES.includes(category)) {
    throw new Error(`storageTree: "${category}" is not a project category (${PROJECT_CATEGORIES.join(", ")})`);
  }
  return childPath(homePath(app), category);
}

/**
 * Pure function. The display label for a keyspace — DELEGATED to
 * web/debugStorage.js's `rowLabel`, so "~draft/current (unsaved draft)" is
 * written down once and the Debug console's Storage page and the File Browser
 * cannot disagree about how an unsaved draft announces itself.
 *
 * @param {string} keyspace
 * @returns {string}
 *
 * @example keyspaceLabel("~draft/current")
 * '~draft/current (unsaved draft)'
 * @example keyspaceLabel("RobotSim")
 * 'RobotSim'
 */
export function keyspaceLabel(keyspace) {
  return rowLabel(keyspace);
}

// ── The per-level listers ────────────────────────────────────────────────────

/** Query (reads IndexedDB). The LOCAL root's keyspace nodes: every stored
 *  document's project, the draft, and the two reserved non-project keyspaces. */
async function listLocalKeyspaceNodes() {
  const nodes = (await localKeyspaces()).map((k) =>
    entry({
      path: joinPath("local", k),
      name: keyspaceLabel(k),
      type: "dir",
      note: isDraftKey(k)
        ? "The unsaved working copy. Its bytes live in this browser in EVERY storage mode — the server has no folder for a project you have not decided to keep."
        : "A project in this browser's IndexedDB. The three folders below it are three separate databases, not directories.",
    }));
  nodes.push(entry({
    path: joinPath("local", CACHES_KEYSPACE),
    name: "caches",
    type: "dir",
    note: "The service worker's offline caches — the app itself, its icons and its version record. This is what the storage tooltip calls \"website code\".",
  }));
  nodes.push(entry({
    path: joinPath("local", OTHER_DB_KEYSPACE),
    name: "other",
    type: "dir",
    note: "Any other IndexedDB database this origin holds. Named honestly even when this app has no reader for it.",
  }));
  return nodes;
}

/** Pure function. The three category nodes under a project keyspace, with the
 *  note that tells the truth about whether they are real directories.
 *
 *  @param {"local"|"server"} rootId
 *  @param {string} keyspace
 *  @returns {object[]}
 *
 *  @example
 *  >>> projectCategoryNodes("server", "RobotSim").map((n) => n.name)
 *  ['document', 'assets', 'renders']
 */
function projectCategoryNodes(rootId, keyspace) {
  const note = rootId === "server"
    ? "A real directory on the server's disk."
    : "NOT a directory: browser storage has none. This groups one IndexedDB store's keys under the project that owns them.";
  return PROJECT_CATEGORIES.map((c) => entry({ path: joinPath(rootId, keyspace, c), name: c, type: "dir", note }));
}

/** Query (reads IndexedDB). A local keyspace's document node — or an honest
 *  explanation when it is a draft, whose document is not in this store at all. */
async function listLocalDocumentNodes(keyspace) {
  if (isDraftKey(keyspace)) return [
    entry({
      path: childPath(joinPath("local", keyspace, "document"), "(autosave)"),
      name: "(autosave)",
      type: "file",
      kind: "data",
      bytes: null,
      note: "A draft has assets but NO document record — its document rides localStorage's powerrp.autosave, which is why it survives a reload and why it is not listed as a file here.",
    })];
  const rec = await withStore(DOC_STORE, "readonly", (s) => promisify(s.get(keyspace), `storageTree: reading the document "${keyspace}"`));
  if (!rec) return [];
  return [
    entry({
      path: joinPath("local", keyspace, "document", "doc.json"),
      name: "doc.json",
      type: "file",
      kind: "data",
      bytes: new Blob([JSON.stringify(rec.doc)]).size,
      mtime: rec.mtime / 1000, // seconds — the unit both stores speak at the seam (assetStore.js:176)
      note: "The project document, stored as a JSON record in IndexedDB. The size is what it serializes to.",
    })];
}

/**
 * Query (reads an asset store; mints object URLs in the local adapter). One
 * keyspace's assets, through the SAME listing call the Asset Explorer uses —
 * `localAssetEntry` already mints the server's own listing shape, which is the
 * whole reason one lister serves both roots.
 *
 * IT RESOLVES `url` HERE, and that is the seam doing its job rather than the
 * view doing storage. `assetRef(keyspace, name)` is a REF, not something an
 * `<img>` can load, and the local adapter's `resolveUrl` is a synchronous map
 * lookup that answers only for a project it has PRIMED — so a view that resolved
 * refs itself would `console.error` once per row and render the loud
 * missing-asset sentinel the moment you browsed a project other than the open
 * one. `primeUrls` is idempotent, is one transaction, and is a documented no-op
 * on the HTTP adapter, so one call per folder visit makes every row's URL true
 * in both modes.
 */
async function listAssetNodes(rootId, keyspace, store) {
  const assets = await store.list(keyspace);
  await store.primeUrls(keyspace);
  return assets.map((a) =>
    entry({
      path: joinPath(rootId, keyspace, "assets", a.name),
      name: a.name,
      type: "file",
      kind: a.kind,
      bytes: a.size ?? null,
      mtime: a.mtime ?? null,
      url: store.resolveUrl(a.url ?? assetRef(keyspace, a.name)),
      thumbnail: a.thumbnail ? store.resolveUrl(a.thumbnail) : null,
      badge: a.badge ?? null,
      note: rootId === "server"
        ? "A file in this project's assets/ folder on the server, which is the source of truth for the library."
        : "An IndexedDB record keyed \"<project>/<file>\". The basename IS the identity — there is no content hash.",
    }));
}

/** Query (reads IndexedDB). One keyspace's browser-local renderings. A rendering
 *  has NO FILENAME of its own until download, which the note states rather than
 *  inventing one. */
async function listLocalRenderNodes(keyspace) {
  const jobs = await listLocalRenderJobs(keyspace);
  return jobs.map((j) =>
    entry({
      path: joinPath("local", keyspace, "renders", j.id),
      name: j.name,
      type: "file",
      kind: "video",
      bytes: j.bytes ?? null,
      note: `A browser rendering (${j.state}). The movie is a Blob inside the record — it has no stored filename; one is minted when you download it.`,
    }));
}

/** Query (network). One server project's renderings. Unlike a browser rendering
 *  these DO have a real, de-collided .mp4 filename on disk, so the entry can name
 *  the file itself. */
async function listServerRenderNodes(keyspace) {
  const jobs = await projectApi.listRenderJobs(keyspace);
  return jobs.map((j) =>
    entry({
      path: joinPath("server", keyspace, "renders", j.output ?? j.id),
      name: j.output ?? j.name,
      type: "file",
      kind: "video",
      bytes: j.bytes ?? null,
      note: j.output
        ? "A finished movie in this project's renders/ folder — a sibling of assets/, so a render can never grow the asset library."
        : `A render job that has produced no file yet (${j.state}). Its bookkeeping lives in renders/.jobs/.`,
    }));
}

/** Query (reads CacheStorage). One node per service-worker cache, through
 *  web/debugStorage.js's existing reader — not a second enumeration. */
async function listCacheNodes() {
  const rows = await gatherCacheRows();
  return rows.map((c) =>
    entry({
      path: joinPath("local", CACHES_KEYSPACE, c.name),
      name: c.name,
      type: "dir",
      bytes: c.bytes,
      note: `${c.entries.length} cached response${c.entries.length === 1 ? "" : "s"}. This is the app itself, kept so the editor opens offline.`,
    }));
}

/** Query (reads CacheStorage). One cache's entries. Their "names" are whole URLs
 *  — the one place in this tree where the path-like thing really IS a path. */
async function listCacheEntryNodes(cacheName) {
  const rows = await gatherCacheRows();
  const cache = rows.find((c) => c.name === cacheName);
  if (!cache) throw new Error(`storageTree: no cache named "${cacheName}" (${rows.map((c) => c.name).join(", ") || "this origin has none"})`);
  return cache.entries.map((e) =>
    entry({
      path: joinPath("local", CACHES_KEYSPACE, cacheName, e.url),
      name: e.url,
      type: "file",
      bytes: e.bytes,
      note: "A cached HTTP response, keyed by its request URL.",
    }));
}

/** Query (reads IndexedDB metadata). Every database this app has no reader for,
 *  reported with `bytes: null` because `indexedDB.databases()` gives no size —
 *  "size unknown" is the truth and 0 would be a fabrication. */
async function listOtherDatabaseNodes() {
  const rows = await gatherOtherDatabaseRows(KNOWN_DATABASE_NAMES);
  return rows.map((d) =>
    entry({
      path: joinPath("local", OTHER_DB_KEYSPACE, d.name),
      name: d.name,
      type: "file",
      bytes: null,
      note: `IndexedDB database, version ${d.version}. Its size is not reported by the browser, so none is shown rather than a fabricated zero.`,
    }));
}
