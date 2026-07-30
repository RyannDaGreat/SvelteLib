/**
 * projectZip.js — the .zip round-trip, CLIENT SIDE.
 *
 * THE ZIP IS THE TRANSFER STORY. In static mode there is no server to build an
 * archive or unpack one, but a deck still has to be able to leave the browser
 * (back it up, mail it, open it on another machine, hand it to the server-backed
 * app) and come back. So this module does in the browser exactly what
 * `server/server.py`'s `zip_project_bytes` / `import_project_zip` do on disk.
 *
 * THE ARCHIVE LAYOUT IS THE SERVER'S, VERBATIM — that is the whole point, and it
 * is what makes the two halves interchangeable:
 *
 *     <project>/doc.json          the document
 *     <project>/assets/<file>     every asset, flat
 *
 * Entries are rooted at "<project>/" (zip_project_bytes: `arcname =
 * os.path.join(name, relpath)`), so a client-exported archive imports through
 * the SERVER's /api/import-zip untouched, and a server-exported archive imports
 * here untouched. Neither side may "improve" the layout alone.
 *
 * The import rules are the server's too, re-implemented rather than trusted:
 * a single root folder names the project (zip_root_name), every member is
 * validated as a contained relative path (zip_relative_path — absolute paths,
 * drive letters and ".." are REFUSED, and __MACOSX sidecars skipped), a missing
 * doc.json means "not a PowerRP export", and a name collision NEVER overwrites.
 * A crafted archive must fail loudly in the browser for the same reason it must
 * on the server: the caller cannot tell a hostile archive from a benign one.
 *
 * fflate does the deflate. It is ~8 kB, synchronous, and dependency-free —
 * chosen over JSZip (an order of magnitude larger) because the whole reason this
 * module exists is a static bundle that has to stay small.
 */

import { unzipSync, zipSync } from "fflate";
import { assetKindForName, uniqueAssetName, uniqueProjectName } from "./assetRef.js";
import { adoptedArchiveRefs, documentAssetRefs, localizationPlan, rewriteAssetRefs } from "./assetLocalize.js";

/** The document's filename inside the archive — the server's DOC_FILENAME. */
export const DOC_FILENAME = "doc.json";

/** The assets subfolder inside the archive — the server's ASSETS_SUBDIR. */
export const ASSETS_SUBDIR = "assets";

/**
 * Pure function. The single top-level folder every entry sits under, or null
 * when the entries are not rooted in one folder. Our own export roots everything
 * at "<project>/…", so that root IS the exported project's name — which is how a
 * dropped .zip knows what it wants to be called. The client twin of the server's
 * zip_root_name, matching it case for case.
 *
 * @param {string[]} names - archive member names
 * @returns {string|null}
 *
 * @example zipRootName(["My Talk/doc.json", "My Talk/assets/a.png"]) // "My Talk"
 * @example zipRootName(["doc.json", "assets/a.png"])                  // null (flat)
 * @example zipRootName(["A/doc.json", "B/doc.json"])                  // null (two roots)
 */
export function zipRootName(names) {
  const roots = new Set(names.filter((n) => n.trim()).map((n) => n.replace(/\\/g, "/").split("/")[0]));
  if (roots.size !== 1) return null;
  const [root] = roots;
  return names.some((n) => n.replace(/\\/g, "/").startsWith(`${root}/`)) ? root : null;
}

/**
 * Pure function. A zip member's path RELATIVE to `root`, validated as a
 * contained relative path, or null for entries to SKIP (directory entries, the
 * root itself, Finder sidecars). THROWS on a member that tries to ESCAPE —
 * absolute paths, drive letters, any ".." segment — because a crafted archive
 * must fail loudly rather than write somewhere it was not invited. The client
 * twin of the server's zip_relative_path.
 *
 * @param {string} member - the archive member name
 * @param {string|null} root - the archive's single root folder, or null if flat
 * @returns {string|null} a "/"-separated relative path, or null to skip
 * @throws {Error} on an escaping member
 *
 * @example zipRelativePath("My Talk/assets/a.png", "My Talk") // "assets/a.png"
 * @example zipRelativePath("My Talk/", "My Talk")             // null (directory entry)
 * @example zipRelativePath("doc.json", null)                  // "doc.json"
 * @example zipRelativePath("__MACOSX/._doc.json", null)       // null (Finder sidecar)
 * @example zipRelativePath("../escape.json", null)            // throws
 */
export function zipRelativePath(member, root) {
  const path = member.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new Error(`unsafe zip member (absolute path): ${JSON.stringify(member)}`);
  let parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new Error(`unsafe zip member (traversal): ${JSON.stringify(member)}`);
  if (root !== null) {
    if (parts.length === 0 || parts[0] !== root) throw new Error(`zip member outside the archive root ${JSON.stringify(root)}: ${JSON.stringify(member)}`);
    parts = parts.slice(1);
  }
  if (parts.length === 0 || path.endsWith("/")) return null; // a directory entry
  if (parts[0] === "__MACOSX") return null; // Finder's resource-fork sidecar
  return parts.join("/");
}

/**
 * Pure function. The archive ENTRY MAP for a project — filename → bytes, in the
 * server's layout. Separated from the store reads (which are async) so the layout
 * itself is testable in bare node with no IndexedDB and no fetch.
 *
 * @param {string} project - project name (becomes the archive root folder)
 * @param {object} doc - the document to write as doc.json
 * @param {Array<{name: string, bytes: Uint8Array}>} assets - asset bytes
 * @returns {Record<string, Uint8Array>} fflate's entry map
 *
 * @example
 * >>> Object.keys(zipEntries("My Talk", {slides: []}, [{name: "logo.png", bytes: new Uint8Array([1])}]))
 * ["My Talk/doc.json", "My Talk/assets/logo.png"]
 */
export function zipEntries(project, doc, assets) {
  const entries = { [`${project}/${DOC_FILENAME}`]: new TextEncoder().encode(JSON.stringify(doc, null, 2)) };
  for (const a of assets) entries[`${project}/${ASSETS_SUBDIR}/${a.name}`] = a.bytes;
  return entries;
}

/**
 * Query (reads the asset store). Build a project .zip in the browser and return
 * `{bytes, warnings}` — the client twin of the server's zip_project_bytes, and the
 * archive a static-mode Download produces.
 *
 * Assets are read one at a time (not Promise.all) so a 500 MB library holds one
 * blob in memory at a time rather than all of them; the deflate itself is the
 * memory ceiling either way. A missing/unreadable asset OF THIS PROJECT throws
 * LOUDLY — a silently incomplete archive is worse than no archive, because it
 * looks fine until someone opens it.
 *
 * THE ARCHIVE IS SELF-CONTAINED, matching the server exactly. A document may
 * reference `/asset/<OTHER project>/<file>` — Save-As mints exactly that, by
 * renaming doc.meta.name while leaving the assets in the folder they were uploaded
 * to. Those bytes are COPIED IN under a non-colliding local name and the ARCHIVED
 * doc's refs rewritten (web/assetLocalize.js plans it; the same plan the server
 * computes, so the two archives stay interchangeable). The stored document is NOT
 * modified — only the copy that goes in the archive.
 *
 * A FOREIGN ASSET THAT CANNOT BE READ does not throw, unlike a local one: it is
 * dropped from the plan (its ref stays as authored, so it remains findable) and
 * named in `warnings`. The asymmetry is deliberate and matches the server — a
 * missing LOCAL asset means this project's own storage is inconsistent, which is a
 * bug; a missing FOREIGN asset just means the other project moved on, which is an
 * author's problem to see and fix, not a reason to refuse them their deck.
 *
 * @param {string} project - project name (the archive's root folder)
 * @param {object} doc - the document to include
 * @param {{list: Function, get: Function}} store - an asset store (either adapter)
 * @returns {Promise<{bytes: Uint8Array, warnings: string[]}>}
 *
 * @example
 * >>> const {bytes, warnings} = await buildProjectZip("My Talk", app.doc, assetStore());
 * >>> bytes.length > 22          // at minimum a zip end-of-central-directory
 * true
 * >>> warnings                    // empty = every reference resolved into the archive
 * []
 */
export async function buildProjectZip(project, doc, store) {
  const listing = await store.list(project);
  const assets = [];
  for (const a of listing) {
    const blob = await store.get(project, a.name);
    assets.push({ name: a.name, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  const plan = localizationPlan(
    documentAssetRefs(doc),
    project,
    listing.map((a) => a.name),
    uniqueAssetName,
  );
  const warnings = [];
  const localized = {};
  for (const c of plan.copies) {
    let blob;
    try {
      blob = await store.get(c.project, c.file);
    } catch (e) {
      warnings.push(
        `asset not found: /asset/${c.project}/${c.file} — referenced by ${project}'s document but ` +
          `unreadable from that project's storage (${e?.message ?? e}); the archive keeps the ` +
          `original reference, which will not resolve after import`,
      );
      continue;
    }
    assets.push({ name: c.as, bytes: new Uint8Array(await blob.arrayBuffer()) });
    localized[c.ref] = c.to;
  }
  const archivedDoc = Object.keys(localized).length ? rewriteAssetRefs(doc, (e) => localized[e.ref] ?? null) : doc;
  // level 6 = fflate's default deflate: the same tradeoff Python's
  // ZIP_DEFLATED makes, so a client archive is about the size of a server one.
  return { bytes: zipSync(zipEntries(project, archivedDoc, assets), { level: 6 }), warnings };
}

/**
 * Pure function. Parse archive bytes into `{root, doc, assets}` WITHOUT touching
 * storage — every validation rule, none of the writes. Splitting parse from
 * write is what lets a hostile archive be REFUSED before anything is stored, and
 * lets the rules be tested in bare node.
 *
 * @param {Uint8Array} bytes - the .zip bytes
 * @returns {{root: string|null, doc: object, assets: Array<{name: string, bytes: Uint8Array}>}}
 * @throws {Error} not a zip, no doc.json, unparseable doc.json, or an unsafe member
 *
 * @example
 * >>> const {root, doc, assets} = parseProjectZip(bytes);
 * >>> root
 * "My Talk"
 * >>> assets.map((a) => a.name)
 * ["logo.png"]
 */
export function parseProjectZip(bytes) {
  let files;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new Error(`not a .zip archive: ${e?.message ?? e}`);
  }
  const names = Object.keys(files);
  const root = zipRootName(names);
  const rel = new Map();
  for (const member of names) {
    const path = zipRelativePath(member, root); // throws on an escaping member
    if (path !== null) rel.set(path, files[member]);
  }
  const docBytes = rel.get(DOC_FILENAME);
  if (!docBytes) throw new Error(`archive has no ${DOC_FILENAME} — not a PowerRP project export`);
  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(docBytes));
  } catch (e) {
    throw new Error(`archive's ${DOC_FILENAME} is not valid JSON: ${e?.message ?? e}`);
  }
  const assets = [];
  const prefix = `${ASSETS_SUBDIR}/`;
  for (const [path, data] of rel) {
    if (!path.startsWith(prefix)) continue;
    // Only files DIRECTLY in assets/ are assets — the server's list_assets is
    // non-recursive for the same reason: assets/frames/ and assets/.thumbs/ are
    // regenerable CACHES, and importing them would restore a stale thumbnail as
    // if it were content.
    const name = path.slice(prefix.length);
    if (name.includes("/")) continue;
    assets.push({ name, bytes: data });
  }
  return { root, doc, assets };
}

/**
 * Command (mutates local storage). Import a project .zip into LOCAL storage as a
 * NEW project and return `{ok, name, requested}` — the same reply shape the
 * server's /api/import-zip returns, so `app.importProjectZip` needs no adapter
 * branch in its result handling.
 *
 * NEVER OVERWRITES: a colliding name lands as "<Name> 2" (the server's
 * unique_project_name rule), and the resolved name comes back so the caller can
 * SAY SO rather than quietly opening something with a different title. A refusal
 * throws before anything is written.
 *
 * @param {Uint8Array} bytes - the .zip bytes
 * @param {string} requested - preferred project name ("" = let the archive's root name it)
 * @param {object} stores - {projects: localProjectStore, assets: localAssetStore}
 * @returns {Promise<{ok: true, name: string, requested: string}>}
 *
 * @example
 * >>> await importProjectZipLocal(bytes, "My Talk", {projects, assets})
 * {ok: true, name: "My Talk 2", requested: "My Talk"}   // "My Talk" already existed
 */
export async function importProjectZipLocal(bytes, requested, stores) {
  const { root, doc: rawDoc, assets } = parseProjectZip(bytes);
  const wanted = (requested || root || "Imported Project").trim();
  const existing = (await stores.projects.list()).map((p) => p.name);
  const name = uniqueProjectName(wanted, existing);
  // ARCHIVE ADOPTION (assetLocalize.adoptedArchiveRefs): an absolute ref whose
  // file rode inside THIS archive goes relative, so a legacy zip — every
  // pre-localization export, incl. ones made by a stale server process — opens
  // working under any name on any host (the user's "/asset/Untitled/…" zips).
  const doc = adoptedArchiveRefs(rawDoc, assets.map((a) => a.name));
  // The document's own meta.name must agree with the folder it landed in — the
  // one-name model (app.svelte.js loadProject sets the same thing server-side).
  await stores.projects.save(name, { ...doc, meta: { ...doc.meta, name } });
  for (const a of assets) {
    const type = mimeForAsset(a.name);
    await stores.assets.put(name, new Blob([a.bytes], { type }), a.name);
  }
  await stores.assets.primeUrls(name);
  return { ok: true, name, requested: wanted };
}

/** Extension → MIME type for a re-imported asset blob. A Blob built from raw zip
 *  bytes has an EMPTY type, and an empty type breaks <img>/<video> in some
 *  browsers and every `type.startsWith("image/")` check — so the type is restored
 *  from the extension, the same classification the kind table uses. */
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
  mkv: "video/x-matroska", avi: "video/x-msvideo",
  wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4",
  aac: "audio/aac", flac: "audio/flac",
  pdf: "application/pdf",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
};

/**
 * Pure function. The MIME type to rebuild an asset Blob with, by extension.
 * Falls back to "application/octet-stream" for anything unrecognized — the
 * server's own content_type_for fallback.
 *
 * @param {string} filename - asset basename
 * @returns {string}
 *
 * @example mimeForAsset("logo.PNG")  // "image/png"
 * @example mimeForAsset("clip.mp4")  // "video/mp4"
 * @example mimeForAsset("notes.txt") // "application/octet-stream"
 */
export function mimeForAsset(filename) {
  const ext = String(filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Command (triggers a browser download). Save `bytes` as `filename` through an
 * object-URL anchor click — the same gesture projectApi.downloadProjectZip uses
 * for the server-built archive, so both modes produce one download experience.
 *
 * @param {Uint8Array} bytes - file bytes
 * @param {string} filename - the download's name
 * @param {string} type - MIME type
 *
 * @example
 * >>> downloadBytes(zipBytes, "My Talk.zip", "application/zip")  // save dialog
 */
export function downloadBytes(bytes, filename, type = "application/zip") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export { assetKindForName };
