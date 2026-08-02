/**
 * THE NATIVE SIZE OF A DROPPED ASSET — one measurer per asset kind.
 *
 * A widget made by dropping a file lands at the file's OWN size (manifest Round
 * 12: "because we have pixels to measure things"), so something has to ask the
 * asset how big it is. That question has a different answer per kind and there is
 * no way around it: an image decodes through `new Image()`, a video loads
 * metadata through a `<video>` element, and a PDF page's size is only known once
 * pdf.js has opened the document. Three unrelated browser APIs.
 *
 * ── WHY THIS IS A MAP AND NOT A MIRROR ──────────────────────────────────────
 * Keyed by kind, this LOOKS like the hand-maintained pair that caused the bug it
 * is part of fixing (`kind === "image" || kind === "video"`, in three places, so
 * a PDF could not be dropped even though `pdf_page` existed — core/registry.js
 * assetDropKindOf tells that story). It is a different thing, in the one way that
 * matters: it does not decide WHAT IS DROPPABLE. The registry decides that, from
 * what widgets declare. This only answers "how do I measure one", and a kind that
 * is droppable with no measurer here THROWS, naming both sides. So the failure
 * mode of forgetting an entry is a loud error at the drop, not a gesture that
 * silently does nothing — which is exactly what the old code did.
 *
 * NOT TO BE CONFUSED WITH THE DEAD `naturalSize` PLUGIN PROTOCOL (task #265),
 * which two widgets implement and nothing reads. This module is about a FILE's
 * intrinsic dimensions before any widget exists; that one was about a widget
 * resizing itself to its content. Different question, unfortunate near-collision
 * of names, hence the `asset` prefix here.
 *
 * EVERY MEASURER REJECTS LOUDLY on a load failure. A drop that cannot be measured
 * must say so — inserting at a guessed size would put a wrongly-shaped box on the
 * slide and look like the asset simply rendered badly.
 */

import { ensurePdfPagePointSize } from "../render_gpu/gpu/pdf_page_raster.js";

/**
 * The page a bare PDF drop measures and shows. 1-based, matching pdf_page's own
 * `page` default — a dropped PDF opens at its first page.
 */
const PDF_DROP_PAGE = 1;

/**
 * Command (async query — reads the network/decoder, mutates nothing). Decoded
 * pixel size of an image URL.
 *
 * @param {string} url - a LOADABLE url (already through the storage adapter)
 * @returns {Promise<{w: number, h: number}>} native pixel size
 *
 * @example // await imageNaturalSize("/asset/Deck/logo.png") // {w: 512, h: 512}
 */
function imageNaturalSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error(`could not load image "${url}"`));
    img.src = url;
  });
}

/**
 * Command (async query). Native frame size of a video URL. Loads METADATA only —
 * the dimensions are known long before any frame decodes, and pulling the whole
 * clip to place a widget would stall the drop.
 *
 * @param {string} url - a LOADABLE url
 * @returns {Promise<{w: number, h: number}>} native frame size
 *
 * @example // await videoNaturalSize("/asset/Deck/clip.mp4") // {w: 1920, h: 1080}
 */
function videoNaturalSize(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => reject(new Error(`could not load video "${url}"`));
    v.src = url;
  });
}

/**
 * Command (async query). Size of a PDF's first page, in POINTS (1/72"), which is
 * what pdf.js's unit viewport reports and what the widget's own raster math is
 * already expressed in — so a dropped US Letter page arrives 612 x 792 and a
 * dropped A4 arrives 595 x 842, each with its true aspect.
 *
 * Delegates to the raster module's existing measurement + cache rather than
 * opening a second copy of the document: `ensurePdfPagePointSize` is described in
 * its own docblock as "what naturalWidth/naturalHeight plays for an image
 * widget's aspect", which is precisely this call site.
 *
 * @param {string} url - a LOADABLE url
 * @returns {Promise<{w: number, h: number}>} first page's point size
 *
 * @example // await pdfNaturalSize("/asset/Deck/paper.pdf") // {w: 612, h: 792}
 */
async function pdfNaturalSize(url) {
  const size = await ensurePdfPagePointSize(url, PDF_DROP_PAGE);
  // null means pdf.js could not open it or the page is out of range; the raster
  // module has already reported the detail, so this only has to refuse.
  if (!size) throw new Error(`could not read page ${PDF_DROP_PAGE} of PDF "${url}"`);
  return size;
}

/** Asset kind -> how to measure one. See the module docblock on why a map here is
 *  not the mirror the registry replaced. */
const MEASURERS = {
  image: imageNaturalSize,
  video: videoNaturalSize,
  pdf: pdfNaturalSize,
};

/**
 * Command (async query). Native size of an asset of `kind` at `url`.
 *
 * LOUD ON AN UNMEASURABLE KIND, and the message names both halves — the widget
 * that claimed the kind and this module — because that is the exact seam a
 * contributor adding a droppable widget will have missed.
 *
 * @param {string} kind - asset kind ("image" | "video" | "pdf")
 * @param {string} url - a LOADABLE url (already through the storage adapter)
 * @param {string} [claimedBy] - the widget type that claims this kind, for the error
 * @returns {Promise<{w: number, h: number}>}
 *
 * @example // await assetNaturalSize("image", "/asset/Deck/logo.png") // {w: 512, h: 512}
 * @example // await assetNaturalSize("sound", "/asset/Deck/ding.wav") // throws: no measurer
 */
export async function assetNaturalSize(kind, url, claimedBy = "a widget") {
  const measure = MEASURERS[kind];
  if (!measure)
    throw new Error(
      `assetNaturalSize: "${claimedBy}" claims dropped "${kind}" assets, but web/assetNaturalSize.js has no measurer for that kind — ` +
      `add one beside image/video/pdf so a dropped ${kind} can land at its own size`);
  return measure(url);
}

/** Query. The kinds this module can measure — for tests that gate the registry's
 *  claims against it, so a droppable-but-unmeasurable widget is caught at the
 *  suite rather than at a user's drop. */
export function measurableAssetKinds() {
  return Object.keys(MEASURERS);
}
