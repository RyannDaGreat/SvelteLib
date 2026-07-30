/**
 * THE WORKING-COPY MODEL — opening a .zip or a share link makes a DRAFT, not a
 * library entry.
 *
 * THE USER'S RULING, verbatim in intent: "It shouldn't have to save until the
 * user decides to save — that goes for uploading zips too. Most editors let you
 * edit things UNTIL you decide to save, and the browser can persist it until
 * later."
 *
 * WHAT THAT OVERTURNED. Import used to WRITE FIRST: a dropped zip landed on the
 * server (or in IndexedDB) as a new project folder before the editor ever showed
 * it, so merely LOOKING at someone's deck left "RobotSim", "RobotSim 2",
 * "RobotSim 3" behind in the library — and the fix that was being built for that
 * was a localStorage memo remembering url -> project name, which is a cache
 * papering over the real problem. Drafts make the memo unnecessary and it is
 * deleted: opening the same link twice is two clean drafts and zero library
 * entries, which is the honest answer rather than a remembered one.
 *
 * ====== THE INVARIANT ======================================================
 *
 *   WHILE A DRAFT IS OPEN, `app.projectName()` ANSWERS THE DRAFT KEY, AND THE
 *   DRAFT KEY IS UNUSABLE AS A REAL PROJECT NAME.
 *
 * Everything else follows from those two clauses, so read them as the contract:
 *
 *   1. `projectName()` IS THE STORAGE-KEY SEAM, not the title. Six production
 *      call sites derive with the bare project name, and `storageMode.js`
 *      installs it into `core/asset_ref`'s resolver — so making one function
 *      answer the draft key repoints EVERY reader (canvas, thumbnails, minimap,
 *      PNG/PDF/SVG export, the Asset Explorer, plugin assets) at the staged
 *      copies at once. Any design that instead threaded a "draft" flag through
 *      those readers would have to find all six, and would drift the first time
 *      a seventh appeared.
 *   2. THE HUMAN NAME IS SEPARATE AND STILL SHOWN. `doc.meta.name` keeps saying
 *      "RobotSim"; the title bar reads it through `app.displayName()`, and the
 *      save indicator reads UNSAVED because a draft is by definition not in the
 *      library. Storage identity and display identity are different questions,
 *      and this is the line between them.
 *   3. THE KEY IS IMPOSSIBLE BY CONSTRUCTION, not by convention. The server's
 *      name rule is `_SAFE_NAME = /^[^/\\\x00]+$/` (server.py), i.e. a project
 *      name may be ANY string with no slash, backslash or NUL. So a key
 *      containing "/" can never collide with a real project — `safe_name()`
 *      refuses it on every server write path, and the Save modal cannot produce
 *      it. That is why the prefix is `~draft/` and not `__draft__`: a name is
 *      excluded here by the EXISTING validation rule, so nothing new has to be
 *      kept in sync. (The leading "~" additionally sorts it out of the way and
 *      reads as "not a real name" to a human staring at IndexedDB.)
 *
 * The pure half of all this — the keys, the name rule, the share-URL shape —
 * lives in web/draftKeys.js so it can be tested in bare node. This file is the
 * part that touches storage.
 *
 * ====== WHERE DRAFT BYTES LIVE =============================================
 *
 * ALWAYS IN THE BROWSER (IndexedDB, `localAssetStore`), in BOTH storage modes —
 * this is the one place the app deliberately ignores `storageMode()`. The reason
 * is the ruling itself: the server has no folder for a project the user has not
 * decided to keep, and creating one would BE the library entry we are refusing
 * to create. So a draft stages locally, and Save is what moves it server-side.
 * It is also what makes "the browser can persist it until later" true across a
 * reload with no network at all.
 *
 * ====== WHAT IS NOT A DRAFT ================================================
 *
 * OPENING A SERVER (or browser-library) PROJECT IS NOT A DRAFT. It is the
 * library entry itself, edited and saved in place, exactly as before — `Save`
 * writes back to the same folder and the indicator returns to "saved". ONLY
 * zip/url IMPORTS draft, because only they would otherwise mint a library entry
 * the user never asked for. `app.draftMode` is null in the ordinary case and
 * every draft-aware branch is therefore inert; nothing about plain HTTP-mode
 * editing changes.
 */

import { adoptedArchiveRefs } from "./assetLocalize.js";
import { localAssetStore } from "./assetStore.js";
import { DRAFT_KEY, draftDisplayName } from "./draftKeys.js";
import { mimeForAsset, parseProjectZip } from "./projectZip.js";

// The pure key/name/share helpers are re-exported so a consumer needs ONE import
// for the whole model and does not have to know which half a given name lives
// in (the same convention assetStore.js uses for assetRef.js).
export { DRAFT_KEY, DRAFT_KEY_PREFIX, DRAFT_STATE_KEY, draftDisplayName, draftStateFromJson, isDraftKey, shareUrl, validProjectName } from "./draftKeys.js";

/**
 * Command (mutates IndexedDB). STAGE a parsed archive's assets into the draft
 * keyspace, replacing whatever the previous draft left there.
 *
 * WHY IT CLEARS FIRST: one draft at a time. Leaving the old draft's files under
 * the same key would make the new draft's Asset Explorer show a union of two
 * decks, and Save would then commit files the user never opened.
 *
 * @param {Array<{name: string, bytes: Uint8Array}>} assets From parseProjectZip.
 * @returns {Promise<number>} How many assets are staged.
 */
export async function stageDraftAssets(assets) {
  await localAssetStore.clearProject(DRAFT_KEY);
  for (const a of assets) await localAssetStore.put(DRAFT_KEY, new Blob([a.bytes], { type: mimeForAsset(a.name) }), a.name);
  // Object URLs must exist BEFORE the first paint: resolveUrl is synchronous by
  // contract (assetStore.js), so an unprimed draft renders every image as the
  // loud MISSING sentinel on the frame the deck opens.
  await localAssetStore.primeUrls(DRAFT_KEY);
  return assets.length;
}

/**
 * Command (parses + stages). Turn zip BYTES into an openable draft: the healed
 * document plus its assets staged under DRAFT_KEY.
 *
 * ARCHIVE ADOPTION IS REUSED, NOT FORKED (commit 7f52bae): `adoptedArchiveRefs`
 * rewrites an absolute ref whose file rides inside THIS archive to a relative
 * one, which is what makes a legacy `/asset/Untitled/clip.mp4` export resolve
 * against the draft keyspace instead of hunting a project called "Untitled".
 * Every pre-localization zip therefore opens as a working draft.
 *
 * The returned doc's `meta.name` is the HUMAN name (invariant clause 2) — the
 * draft key never appears in the document, only in storage.
 *
 * @param {Uint8Array} bytes The .zip bytes.
 * @param {string} requested Preferred display name ("" = let the archive decide).
 * @returns {Promise<{doc: object, name: string, assetCount: number}>}
 */
export async function draftFromZipBytes(bytes, requested) {
  const { root, doc: rawDoc, assets } = parseProjectZip(bytes);
  const name = draftDisplayName(requested, root);
  const healed = adoptedArchiveRefs(rawDoc, assets.map((a) => a.name));
  const assetCount = await stageDraftAssets(assets);
  return { doc: { ...healed, meta: { ...healed.meta, name } }, name, assetCount };
}
