/**
 * web/gifVideo.js — WHICH WIDGET AN UPLOADED FILE BECOMES, when the file is a GIF.
 *
 * THE DEFECT (user, verbatim): "how does our powerrp handle gifs? as videos
 * hopefully?" The measured answer was no. `.gif` sits in the image bucket of every
 * classifier we have (server.py IMAGE_EXTS, assetRef.js KIND_EXTS,
 * AssetField.svelte's own copy), so an animated GIF became an IMAGE widget and the
 * image paint path is `createImageBitmap` — ONE bitmap. The canvas showed a FROZEN
 * FIRST FRAME and said nothing about it.
 *
 * A `<video>` ELEMENT CANNOT PLAY A GIF, so "as videos" cannot be a classification
 * change alone — the bytes have to become an mp4. That happens SERVER-SIDE at
 * upload (server.py transcode_uploaded_gif), which is why this module is about a
 * REPLY rather than about a file: by the time the client decides what to insert,
 * the question "is this animated" has already been answered authoritatively by
 * ffprobe, and the mp4 (if any) already exists.
 *
 * WHY A SEPARATE MODULE FOR ONE DECISION. The decision has THREE call sites — the
 * canvas drop (CanvasView.svelte), the paste-to-upload path and the Asset
 * Explorer's upload — and it is exactly the kind of two-line ternary that gets
 * hand-copied and then fixed in only one place. assetRef.js records that history:
 * one question about a dropped file's kind once had FIVE implementations, and the
 * PDF-drop bug lived in the copies. So this ships as ONE named function with
 * doctests, in a DOM-free module bare node can test.
 *
 * IT IS ALSO WHERE STATIC MODE IS HONEST. A page with no Python backend has no
 * ffmpeg, so the transcode CANNOT happen there — and a static host's upload reply
 * simply carries no `transcode` block. Read naively, "no block" is indistinguishable
 * from "a still GIF", which would put the silent frozen frame back on exactly the
 * deployment least able to explain it. `gifStaticRefusal` is the sentence that gets
 * said instead. Its WORDING lives in storageMode.js's UNAVAILABLE_IN_STATIC roster,
 * beside every other server-only feature, and is PASSED IN rather than imported:
 * storageMode.js reaches `assetStore.js` → `projectApi.js`, which reads `location`
 * at module scope, so importing it would make this module unloadable in bare node —
 * and being bare-node testable is the entire reason the decision lives here rather
 * than inline in a `.svelte` file. Both call sites pass
 * `UNAVAILABLE_IN_STATIC.gifTranscode`, so there is still exactly one wording.
 */

/**
 * Pure function. Whether an upload reply describes an ANIMATED GIF that was
 * transcoded — i.e. whether an mp4 sibling exists to back a video widget.
 *
 * BOTH FIELDS ARE REQUIRED, not just the flag: a reply claiming `animated` with no
 * mp4 name is a server that changed its contract, and treating it as animated would
 * insert a video widget pointing at nothing. The flag alone is not evidence.
 *
 * @param {{transcode?: {animated?: boolean, name?: string, url?: string}}} reply - an uploadAsset reply
 * @returns {boolean}
 *
 * @example
 * >>> isTranscodedGif({name: "spin.gif", transcode: {animated: true, frames: 24, name: "spin.mp4", url: "/asset/D/spin.mp4"}})
 * true
 * >>> isTranscodedGif({name: "logo.gif", transcode: {animated: false, frames: 1}})
 * false
 * >>> isTranscodedGif({name: "photo.png"})
 * false
 */
export function isTranscodedGif(reply) {
  const t = reply?.transcode;
  return Boolean(t?.animated && t?.name && t?.url);
}

/**
 * Pure function. THE INSERT DECISION for one finished upload: the {name, kind, url}
 * a canvas insert should use.
 *
 * An animated GIF resolves to its MP4 SIBLING — a `video` kind pointing at the
 * transcoded file — so the widget that lands is the ordinary video widget, with the
 * ordinary player, scrubber, export and render-job support behind it. Everything
 * else (a still GIF, a png, an mp4, a pdf) resolves to the uploaded file itself with
 * the kind the caller already computed, byte-identical to the behaviour before this
 * feature existed.
 *
 * THE ORIGINAL .gif IS NOT REPLACED — it stays in the asset library. Only what gets
 * INSERTED changes. A user who wants the still frame can still drag the GIF from the
 * Asset Explorer onto an image field.
 *
 * @param {{name: string, url: string, transcode?: object}} reply - an uploadAsset reply
 * @param {string} fallbackKind - the kind the caller classified the FILE as (assetKindForFile)
 * @returns {{name: string, kind: string, url: string}} what to insert
 *
 * @example
 * >>> insertTargetForUpload({name: "spin.gif", url: "/asset/D/spin.gif",
 * ...   transcode: {animated: true, frames: 24, name: "spin.mp4", url: "/asset/D/spin.mp4"}}, "image")
 * {name: "spin.mp4", kind: "video", url: "/asset/D/spin.mp4"}
 * >>> insertTargetForUpload({name: "logo.gif", url: "/asset/D/logo.gif",
 * ...   transcode: {animated: false, frames: 1}}, "image")
 * {name: "logo.gif", kind: "image", url: "/asset/D/logo.gif"}
 * >>> insertTargetForUpload({name: "clip.mp4", url: "/asset/D/clip.mp4"}, "video")
 * {name: "clip.mp4", kind: "video", url: "/asset/D/clip.mp4"}
 */
export function insertTargetForUpload(reply, fallbackKind) {
  if (isTranscodedGif(reply)) {
    return { name: reply.transcode.name, kind: "video", url: reply.transcode.url };
  }
  return { name: reply?.name, kind: fallbackKind, url: reply?.url };
}

/**
 * Pure function. THE STATIC-MODE SENTENCE for a GIF upload that could not be
 * transcoded, or null when nothing needs saying.
 *
 * Said when — and ONLY when — a `.gif` was uploaded on a page with no backend. In
 * that case nobody probed the file, so we do not know whether it is animated; the
 * honest report is that this deployment cannot tell and cannot convert, and the GIF
 * has landed as a still image. WITH the sentence, never silently.
 *
 * NOT SAID for a still GIF in server mode (the server probed it and answered: one
 * frame, an image is correct), and not said for any non-GIF.
 *
 * @param {{name?: string, transcode?: object}} reply - an uploadAsset reply
 * @param {boolean} staticMode - isStatic(): this page has no backend
 * @param {string} reason - UNAVAILABLE_IN_STATIC.gifTranscode (passed, not imported —
 *   see the module docblock: importing storageMode.js would cost bare-node loadability)
 * @returns {string|null} the sentence to report, or null
 *
 * @example
 * >>> gifStaticRefusal({name: "spin.gif"}, true, "Playing an animated GIF needs a backend…")
 * '"spin.gif" was added as a still image: Playing an animated GIF needs a backend…'
 * >>> gifStaticRefusal({name: "logo.gif", transcode: {animated: false, frames: 1}}, false, r)
 * null
 * >>> gifStaticRefusal({name: "photo.png"}, true, r)
 * null
 */
export function gifStaticRefusal(reply, staticMode, reason) {
  if (!staticMode) return null;
  if (!String(reply?.name ?? "").toLowerCase().endsWith(".gif")) return null;
  if (!reason) throw new Error("gifStaticRefusal: a reason is required (pass UNAVAILABLE_IN_STATIC.gifTranscode) — a refusal with no sentence is the silent frozen GIF this exists to prevent");
  return `"${reply.name}" was added as a still image: ${reason}`;
}
