/**
 * assetStore.js — THE storage seam. One interface, two backings.
 *
 * The user's ruling: "refactor it in such a way that the file saving and loading
 * of assets is agnostic to this". So every asset and every document moves
 * through ONE interface here, and the thing behind it is a choice made once at
 * boot (web/storageMode.js) instead of a fetch call hard-wired at each call site.
 *
 *   assetStore    list / get / put / delete / resolveUrl / quota
 *   projectStore  list / load / save / rename / delete / exists
 *
 * TWO ADAPTERS:
 *
 *   HTTP     — today's behavior, BYTE-IDENTICAL. It is a thin forward to
 *              web/projectApi.js, whose public functions are a FROZEN interface
 *              (other modules import them directly and must keep working). This
 *              adapter adds NO new requests, changes no URL, and returns the
 *              server's own listing objects untouched.
 *   LOCAL    — IndexedDB (web/localDb.js). Assets are Blobs; documents are JSON.
 *              resolveUrl mints blob: object URLs. This is what makes the app
 *              work as a STATIC SITE with no server at all.
 *
 * THE INVARIANT THAT MAKES THIS WORK: a document NEVER stores a resolved URL.
 * It stores `"/asset/<project>/<file>"` (web/assetRef.js), and resolution
 * happens at ONE seam — `app.#resolvedSrc` — which now delegates here. That is
 * why the same doc.json, the same .zip, and the same deck open under either
 * adapter with no migration: the reference is storage-agnostic by construction.
 *
 * OBJECT-URL LIFETIME (local adapter): `blob:` URLs are revoked when the page
 * unloads, but a deck can reference one asset from many widgets across many
 * slides, and a `src` is read on every derive. So the local adapter MEMOIZES one
 * object URL per asset ref and keeps it for the page's lifetime, revoking only
 * when that asset is DELETED or REPLACED. Minting per read would leak a URL per
 * frame; revoking eagerly would break a still-mounted <img>.
 *
 * RESOLUTION IS SYNCHRONOUS BY CONTRACT, because `#resolvedSrc` is called from
 * derive/paint paths that cannot await. The local adapter therefore PRELOADS a
 * project's asset URLs (`primeUrls`) when the project opens — one transaction,
 * before the first paint — and `resolveUrl` is then a map lookup. An
 * unprimed/missing ref returns a LOUD sentinel (see MISSING_ASSET_URL) rather
 * than an empty string, so a broken reference is visible instead of blank.
 */

import * as projectApi from "./projectApi.js";
import { ASSET_REF_PREFIX, assetKindForName, assetRef, parseAssetRef, plainDoc, quotaLine, quotaPercent, uniqueAssetName, uniqueProjectName } from "./assetRef.js";
import { ASSET_STORE, DOC_STORE, assetKey, deleteByPrefix, getAllByPrefix, promisify, requestPersistence, storageBudget, withStore } from "./localDb.js";
import { MISSING_ASSET_URL } from "../core/asset_ref.js"; // the re-export below is not a local binding

// What resolveUrl returns for a reference the local store has never heard of.
// DEFINED IN core/asset_ref.js, not here: the media registries under render_gpu/
// must recognize the sentinel before they hand it to an <img>/<video>, and no
// render_gpu or core module may import from web/. Re-exported so this seam stays
// the public face for web/ consumers (the same "one definition, re-exported"
// arrangement the ref grammar itself uses).
export { MISSING_ASSET_URL, isMissingAssetUrl } from "../core/asset_ref.js";

// ── HTTP adapter: today's server behavior, forwarded verbatim ────────────────

/** The HTTP asset store. Every method forwards to the FROZEN projectApi
 *  function that already implemented it, so server-mode behavior is unchanged
 *  by this refactor: same URLs, same listing objects, same loud errors. */
export const httpAssetStore = {
  mode: "http",

  /** Query. The server's asset listing for `project`:
   *  [{name, size, mtime, kind, url, thumbnail?, badge?, durationSec?}]. */
  list: (project) => projectApi.listAssets(project),

  /** Command. Upload one File/Blob; returns the server's {ok, name, url} with
   *  the FINAL de-collided basename. `onProgress(loaded, total)` is forwarded to
   *  the XHR upload progress the optimistic tile reads. */
  put: (project, file, filename = file.name, onProgress = null) => projectApi.uploadAsset(project, file, filename, onProgress),

  /**
   * Command. OVERWRITE an EXISTING asset's bytes, keeping its name.
   *
   * A DISTINCT VERB FROM `put`, and it has to be. `put` is "add a file to the
   * library" and DE-COLLIDES: hand it a name that is taken and it writes
   * "gear-2.plugin.js" instead, which is exactly right for a drop or an upload and
   * exactly wrong for a save. Editing a plugin asset's source through `put` wrote a
   * SECOND file and left the original untouched, so the editor reported success,
   * closed, and changed nothing — a silent failure, and one that also littered the
   * library with numbered copies. (Measured: four "probe_square.plugin-N.js" files
   * from four saves.)
   *
   * LOUD WHEN THE ASSET IS ABSENT: replacing something that is not there is a
   * caller bug (a typo'd name, a stale listing), and quietly creating the file
   * instead would turn "save my edit" into "create a new widget" without saying so.
   *
   * HTTP mode is delete-then-upload because that is what the backend offers, and it
   * is also the CORRECT order: the server's delete drops the asset's cached
   * thumbnail/frame derivatives, which are stale the moment the bytes change.
   *
   * @param {string} project
   * @param {Blob|File} file - the NEW bytes
   * @param {string} filename - the EXISTING asset's basename (kept)
   * @returns {Promise<{ok: boolean, name: string, url: string}>}
   */
  async replace(project, file, filename) {
    const existing = (await this.list(project)).some((a) => a.name === filename);
    if (!existing) throw new Error(`httpAssetStore.replace(${project}, ${filename}): no such asset — replace overwrites, it does not create`);
    await projectApi.deleteAsset(project, filename);
    const res = await projectApi.uploadAsset(project, file, filename);
    // The name must come back UNCHANGED: the delete freed it, so nothing should
    // have de-collided. If it did, the library now holds a copy the caller does not
    // know about, which is the very failure this method exists to prevent.
    if (res.name !== filename)
      throw new Error(`httpAssetStore.replace(${project}, ${filename}): the server stored it as "${res.name}" instead — the original was not freed, so the edit did not land on the file it was made against`);
    return res;
  },

  /** Command. Delete one asset (the server also drops its frame/thumb caches). */
  delete: (project, filename) => projectApi.deleteAsset(project, filename),

  /** Query. Fetch one asset's BYTES as a Blob — needed only by the client-side
   *  zip export, which must read the same bytes in either mode. Loud on a
   *  non-OK response. */
  async get(project, filename) {
    const url = projectApi.assetUrl(assetRef(project, filename));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`httpAssetStore.get(${project}, ${filename}): ${res.status} ${res.statusText}`);
    return res.blob();
  },

  /** Query. Resolve an in-document ref to a loadable URL: relative served paths
   *  go through the backend base (identity when same-origin/proxied), absolute
   *  URLs and data: URIs pass through. EXACTLY the prior #resolvedSrc rule. */
  resolveUrl: (ref) => (String(ref ?? "").startsWith("/") ? projectApi.assetUrl(ref) : ref),

  /** Query. No-op: the SERVER has no per-user quota to report, so the Asset
   *  Explorer shows no quota line in HTTP mode (user ruling: "in HTTP mode show
   *  nothing"). `supported:false` is the "render nothing" signal. */
  quota: async () => ({ supported: false, reason: "server-backed storage has no per-browser quota" }),

  /** Command. Nothing to prime — HTTP refs resolve by string rewrite alone. */
  primeUrls: async () => {},
};

// ── LOCAL adapter: IndexedDB blobs + memoized object URLs ────────────────────

/** ref string → blob: URL. Page-lifetime memo (see the module docblock on
 *  object-URL lifetime). Keyed by the REF, not by (project, file), because the
 *  ref is what every reader holds. */
const objectUrls = new Map();

/** Command. Drop and revoke the memoized object URL for one ref, if any. Called
 *  on delete/replace so a stale blob: URL can never outlive its bytes. */
function revokeUrl(ref) {
  const url = objectUrls.get(ref);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(ref);
  }
}

/**
 * Pure function (over its inputs). One stored asset record → the LISTING SHAPE
 * the server sends, so the Asset Explorer, the font registration and the
 * insert affordances read local and server assets through one field set. `url`
 * is the PORTABLE ref (not a blob: URL) precisely because that is what a widget
 * stores when the asset is dragged onto the canvas.
 *
 * @param {{project:string, file:string, size:number, mtime:number, blob:Blob}} rec - a stored record
 * @returns {{name:string, size:number, mtime:number, kind:string, url:string}}
 *
 * @example
 * >>> localAssetEntry({project: "Deck", file: "logo.png", size: 8213, mtime: 1769800000000})
 * {name: "logo.png", size: 8213, mtime: 1769800000, kind: "image", url: "/asset/Deck/logo.png"}
 */
export function localAssetEntry(rec) {
  return {
    name: rec.file,
    size: rec.size,
    // The server reports mtime in SECONDS (os.path.getmtime); IndexedDB records
    // hold ms. Converted here so relativeMtime() and the client thumbnail cache
    // key read one unit regardless of adapter.
    mtime: rec.mtime / 1000,
    kind: assetKindForName(rec.file),
    url: assetRef(rec.project, rec.file),
  };
}

/** The LOCAL (IndexedDB) asset store — the static-mode backing. */
export const localAssetStore = {
  mode: "local",

  /** Query. This project's assets in the server's listing shape, name-sorted
   *  (the server sorts too, so the grid's order does not change with adapter). */
  async list(project) {
    const recs = await getAllByPrefix(ASSET_STORE, `${project}/`);
    return recs.map(localAssetEntry).sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Command (mutates IndexedDB). Store one File/Blob as a project asset,
   * de-colliding the name against what is already there (the server's
   * unique_asset_name behavior), and return {ok, name, url} — the SAME reply
   * shape uploadAsset returns, so the optimistic-tile caller is adapter-blind.
   *
   * `onProgress` is called ONCE with (size, size): an IndexedDB put has no
   * streaming progress to report, and reporting completion is honest where
   * inventing intermediate percentages would not be.
   */
  async put(project, file, filename = file.name, onProgress = null) {
    const existing = (await this.list(project)).map((a) => a.name);
    const name = uniqueAssetName(filename, existing);
    const size = file.size ?? 0;
    const rec = { project, file: name, size, mtime: Date.now(), blob: file };
    await withStore(ASSET_STORE, "readwrite", (s) => promisify(s.put(rec, assetKey(project, name)), `localAssetStore.put(${project}, ${name})`));
    const ref = assetRef(project, name);
    revokeUrl(ref); // a replaced name must not keep the old bytes' URL
    objectUrls.set(ref, URL.createObjectURL(file));
    if (onProgress) onProgress(size, size);
    return { ok: true, name, url: ref };
  },

  /** Command (mutates IndexedDB). OVERWRITE an EXISTING asset's bytes, keeping its
   *  name — the local twin of httpAssetStore.replace (see its docblock for WHY this
   *  is a separate verb from `put`, which de-collides and therefore cannot save an
   *  edit). Loud when the asset is absent: replace overwrites, it never creates.
   *  The old blob: URL is revoked so a stale object URL cannot outlive its bytes. */
  async replace(project, file, filename) {
    const key = assetKey(project, filename);
    const found = await withStore(ASSET_STORE, "readonly", (s) => promisify(s.get(key), `localAssetStore.replace(${key})`));
    if (!found) throw new Error(`localAssetStore.replace(${project}, ${filename}): no such asset in local storage — replace overwrites, it does not create`);
    const size = file.size ?? 0;
    const rec = { project, file: filename, size, mtime: Date.now(), blob: file };
    await withStore(ASSET_STORE, "readwrite", (s) => promisify(s.put(rec, key), `localAssetStore.replace(${project}, ${filename})`));
    const ref = assetRef(project, filename);
    revokeUrl(ref);
    objectUrls.set(ref, URL.createObjectURL(file));
    return { ok: true, name: filename, url: ref };
  },

  /** Command (mutates IndexedDB). Delete one asset and revoke its object URL.
   *  Loud if the asset is absent — a stale list is a reportable state (matching
   *  the server's 404-on-missing contract). */
  async delete(project, filename) {
    const key = assetKey(project, filename);
    const found = await withStore(ASSET_STORE, "readonly", (s) => promisify(s.get(key), `localAssetStore.delete(${key})`));
    if (!found) throw new Error(`localAssetStore.delete(${project}, ${filename}): no such asset in local storage`);
    await withStore(ASSET_STORE, "readwrite", (s) => promisify(s.delete(key), `localAssetStore.delete(${key})`));
    revokeUrl(assetRef(project, filename));
    return { ok: true, name: filename };
  },

  /**
   * Command (mutates IndexedDB). Delete EVERY asset under one project key,
   * revoking each object URL. Unlike `delete`, an EMPTY keyspace is not an error
   * — the caller is asserting "nothing of mine is left here", and the first
   * draft ever opened clears a key that has never held anything.
   *
   * Exists for the DRAFT keyspace (web/projectDraft.js), where re-staging must
   * replace the previous working copy rather than union with it. Kept here
   * rather than reaching into localDb from the draft module so that object-URL
   * revocation stays the responsibility of the store that minted them — a
   * caller that deleted the records directly would leak one URL per asset.
   *
   * @param {string} project The project (or draft) key to empty.
   * @returns {Promise<number>} How many assets were removed.
   */
  async clearProject(project) {
    const recs = await getAllByPrefix(ASSET_STORE, `${project}/`);
    for (const rec of recs) revokeUrl(assetRef(project, rec.file));
    await deleteByPrefix(ASSET_STORE, `${project}/`);
    return recs.length;
  },

  /** Query. One asset's bytes as a Blob. Loud when absent. */
  async get(project, filename) {
    const rec = await withStore(ASSET_STORE, "readonly", (s) => promisify(s.get(assetKey(project, filename)), `localAssetStore.get(${project}, ${filename})`));
    if (!rec) throw new Error(`localAssetStore.get(${project}, ${filename}): no such asset in local storage`);
    return rec.blob;
  },

  /** Query. SYNCHRONOUS ref → blob: URL from the primed memo (see the module
   *  docblock). Non-asset srcs (http(s), data:, built-in paths) pass through
   *  untouched; an unknown /asset/ ref returns the loud MISSING sentinel and
   *  says so once on the console. */
  resolveUrl(ref) {
    const s = String(ref ?? "");
    if (!s.startsWith(ASSET_REF_PREFIX)) return s;
    const url = objectUrls.get(s);
    if (url) return url;
    console.error(`localAssetStore.resolveUrl: "${s}" is not in local storage (never imported, or a different project's asset)`);
    return MISSING_ASSET_URL;
  },

  /**
   * Command (mutates the object-URL memo). Mint an object URL for every asset of
   * `project` so `resolveUrl` can answer synchronously afterwards. Called when a
   * project OPENS and after any import — one transaction before the first paint.
   * Already-memoized refs keep their URL (a re-prime must not invalidate a
   * mounted <img>). Returns how many refs are now resolvable.
   */
  async primeUrls(project) {
    const recs = await getAllByPrefix(ASSET_STORE, `${project}/`);
    for (const rec of recs) {
      const ref = assetRef(rec.project, rec.file);
      if (!objectUrls.has(ref)) objectUrls.set(ref, URL.createObjectURL(rec.blob));
    }
    return objectUrls.size;
  },

  /** Query. The browser's storage budget for this origin — the number behind the
   *  Asset Explorer's "<used> of <quota> used" line. */
  quota: () => storageBudget(),

  /** Command. Ask the browser to make this origin's storage PERSISTENT and
   *  return its answer, so the caller can surface it. */
  requestPersistence,
};

// ── PROJECT (document) stores: the same seam for doc persistence ─────────────

/** The HTTP project store — a forward to the frozen projectApi document calls. */
export const httpProjectStore = {
  mode: "http",
  /** Query. Saved projects, newest first: [{name, mtime, slideCount}]. */
  list: () => projectApi.listProjects(),
  /** Query. {doc, assets} for one project. */
  load: (name) => projectApi.loadProject(name),
  /** Command. Write a project's document (creates the folder if new). */
  save: (name, doc) => projectApi.saveProject(name, doc),

  /** Command. RENAME = MOVE the project folder (one server-side os.rename). The
   *  assets travel with it and the document's RELATIVE refs need no rewriting —
   *  that is the whole payoff of the relative grammar. Loud on a missing source
   *  or an occupied destination; never merges. */
  rename: (from, to) => projectApi.renameProject(from, to),

  /** Command. SAVE-AS FORK: duplicate `from`'s assets into `to`, server-side, so
   *  a large video never transits the browser. The twin of localProjectStore's
   *  blob-by-blob copy; both leave the source project untouched. */
  copyAssets: (from, to) => projectApi.copyProjectAssets(from, to),
};

/**
 * Pure function. One stored doc record → the listing shape the Open modal
 * renders. `slideCount` comes from the stored document itself (the server reads
 * it out of doc.json for the same field).
 *
 * @param {{name:string, doc:object, mtime:number}} rec - a stored doc record
 * @returns {{name:string, mtime:number, slideCount:number|null}}
 *
 * @example
 * >>> localProjectEntry({name: "Deck", mtime: 1769800000000, doc: {slides: [{}, {}]}})
 * {name: "Deck", mtime: 1769800000, slideCount: 2}
 */
export function localProjectEntry(rec) {
  return {
    name: rec.name,
    mtime: rec.mtime / 1000, // seconds, matching the server's os.path.getmtime
    slideCount: Array.isArray(rec.doc?.slides) ? rec.doc.slides.length : null,
  };
}

/** The LOCAL (IndexedDB) project store — documents as JSON records. */
export const localProjectStore = {
  mode: "local",

  /** Query. Saved local projects, NEWEST FIRST (the server's order, so the Open
   *  modal's default listing does not depend on the adapter). */
  async list() {
    const recs = await withStore(DOC_STORE, "readonly", (s) => promisify(s.getAll(), "localProjectStore.list"));
    return recs.map(localProjectEntry).sort((a, b) => b.mtime - a.mtime);
  },

  /** Query. {doc, assets} for one local project — the SAME pair the server's
   *  load returns, so loadProject needs no adapter branch. Loud when absent. */
  async load(name) {
    const rec = await withStore(DOC_STORE, "readonly", (s) => promisify(s.get(name), `localProjectStore.load(${name})`));
    if (!rec) throw new Error(`localProjectStore.load(${name}): no such project in local storage`);
    return { doc: rec.doc, assets: await localAssetStore.list(name) };
  },

  /** Command (mutates IndexedDB). Write a project's document. Returns
   *  {ok, name} like the server's save. A quota-exceeded commit rejects LOUDLY
   *  through withStore's abort handler — a save that did not happen must never
   *  report success (the save indicator would then lie). */
  async save(name, doc) {
    const rec = { name, doc: plainDoc(doc), mtime: Date.now() };
    await withStore(DOC_STORE, "readwrite", (s) => promisify(s.put(rec, name), `localProjectStore.save(${name})`));
    return { ok: true, name };
  },

  /**
   * Command (mutates IndexedDB). RENAME = MOVE, the local twin of the server's
   * os.rename: re-key the doc record AND every asset record, because an asset's
   * IndexedDB key CARRIES the project name (localDb.assetKey) exactly the way a
   * server path carries the folder name. Nothing is duplicated; the old keys are
   * gone when this returns.
   *
   * The document's RELATIVE refs ("clip.mp4") name no project, so they are moved
   * verbatim and resolve against the new name for free. LEGACY ABSOLUTE self-refs
   * are relativized by the CALLER before this runs (app.renameProject) — doing it
   * here would need the ref grammar in the storage layer, and the caller is the
   * one place that also owns the save.
   *
   * Refuses a collision loudly rather than merging two projects. The moved
   * assets' memoized blob: URLs are revoked (their refs named the OLD project, so
   * they are dead keys) and the new name is re-primed, so a synchronous
   * resolveUrl answers immediately after the rename with no repaint gap.
   */
  async rename(from, to) {
    const rec = await withStore(DOC_STORE, "readonly", (s) => promisify(s.get(from), `localProjectStore.rename(${from})`));
    if (!rec) throw new Error(`localProjectStore.rename(${from} → ${to}): no such project in local storage`);
    const clash = await withStore(DOC_STORE, "readonly", (s) => promisify(s.get(to), `localProjectStore.rename(→ ${to})`));
    if (clash) throw new Error(`localProjectStore.rename(${from} → ${to}): "${to}" already exists locally`);
    const assets = await getAllByPrefix(ASSET_STORE, `${from}/`);
    await withStore(ASSET_STORE, "readwrite", async (s) => {
      for (const a of assets) {
        await promisify(s.put({ ...a, project: to }, assetKey(to, a.file)), `rename asset ${a.file}`);
        await promisify(s.delete(assetKey(from, a.file)), `rename drop ${a.file}`);
      }
    });
    // Old refs point at the old project name, so their memoized URLs are dead.
    for (const a of assets) revokeUrl(assetRef(from, a.file));
    await this.save(to, { ...rec.doc, meta: { ...rec.doc.meta, name: to } });
    await withStore(DOC_STORE, "readwrite", (s) => promisify(s.delete(from), `localProjectStore.rename(drop ${from})`));
    await localAssetStore.primeUrls(to);
    return { ok: true, name: to };
  },

  /**
   * Command (mutates IndexedDB). SAVE-AS FORK: copy every asset of `from` into
   * `to`, leaving `from` completely intact — the local twin of the server's
   * copy_project_assets, and the reason Save-As is a different verb from rename.
   *
   * The SAME Blob object is stored under both keys. IndexedDB stores blobs by
   * reference-counted backing file, so this does not double the bytes on disk the
   * way two independent uploads would, and neither project can mutate the other's
   * copy (a blob is immutable; `replace` puts a NEW blob under one key only).
   *
   * Existing destination files are SKIPPED, never overwritten — matching the
   * server's rule exactly, so a fork behaves the same in both modes — which makes
   * this idempotent. Returns {copied, skipped} in the server's reply shape.
   */
  async copyAssets(from, to) {
    if (from === to) throw new Error(`localProjectStore.copyAssets(${from} → ${to}): source and destination are the same project`);
    const existing = new Set((await localAssetStore.list(to)).map((a) => a.name));
    const copied = [], skipped = [];
    for (const a of await getAllByPrefix(ASSET_STORE, `${from}/`)) {
      if (existing.has(a.file)) {
        skipped.push(a.file);
        continue;
      }
      await withStore(ASSET_STORE, "readwrite", (s) => promisify(s.put({ ...a, project: to }, assetKey(to, a.file)), `copyAssets ${a.file}`));
      copied.push(a.file);
    }
    await localAssetStore.primeUrls(to);
    return { ok: true, copied: copied.sort(), skipped: skipped.sort() };
  },

  /** Command (mutates IndexedDB). Delete a local project: its document AND all
   *  of its assets. Loud when absent. */
  async delete(name) {
    const rec = await withStore(DOC_STORE, "readonly", (s) => promisify(s.get(name), `localProjectStore.delete(${name})`));
    if (!rec) throw new Error(`localProjectStore.delete(${name}): no such project in local storage`);
    for (const a of await getAllByPrefix(ASSET_STORE, `${name}/`)) revokeUrl(assetRef(name, a.file));
    await deleteByPrefix(ASSET_STORE, `${name}/`);
    await withStore(DOC_STORE, "readwrite", (s) => promisify(s.delete(name), `localProjectStore.delete(${name})`));
    return { ok: true, name };
  },

  /** Query. A local project name that does not collide — used by zip import so
   *  an archive NEVER overwrites the project already stored (the server's
   *  unique_project_name rule, client side). */
  async uniqueName(wanted) {
    return uniqueProjectName(wanted, (await this.list()).map((p) => p.name));
  },
};

// Re-exported from web/assetRef.js (the DOM-free module, so they are testable in
// bare node): the ref grammar, the doc de-proxying, and the quota formatters.
// Consumers import them from HERE because this is the seam's public face.
export { assetRef, parseAssetRef, assetKindForName, plainDoc, quotaLine, quotaPercent };
