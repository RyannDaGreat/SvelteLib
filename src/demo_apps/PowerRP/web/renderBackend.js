/**
 * renderBackend.js — WHERE A RENDER JOB'S RECORD LIVES, decided once per page.
 *
 * THE ONE SEAM. web/browserRenderJobs.js renders and encodes entirely in this page
 * — that has always been true, in both modes — but it used to reach for
 * web/projectApi.js to keep the RECORD: the row in the Render Center, its state,
 * its finished movie. That is the only server-shaped thing about a browser render,
 * and it is why the static site's Render Center could show the pipeline and then
 * refuse to run it.
 *
 * So the record's home became a choice, and this module is that choice:
 *
 *   HTTP   → web/projectApi.js      the server owns the job, the movie lands in
 *                                   the project's renders/ folder, and a SERVER
 *                                   backend job exists alongside this one.
 *   LOCAL  → web/localRenderStore.js the record and the movie live in IndexedDB
 *                                   under the project (or draft) key.
 *
 * BOTH SIDES ANSWER THE SAME FIVE CALLS with the same arguments and the same record
 * shape (server.py's `job_view`), which is what lets the orchestrator, the pure
 * view-model helpers and every row in the modal stay literally unchanged. The mode
 * split is here and nowhere else — the alternative, an `if (isStatic())` inside the
 * frame walk, would be a second definition of what a render IS, which is the exact
 * thing the "THE RENDERER IS ONE CODE PATH" ruling forbids.
 *
 * IT IS A BOOT CONSTANT, NOT A REACTIVE VALUE, matching how the rest of the app
 * reads `isStatic()`: the mode is decided once by web/storageMode.js during boot and
 * cannot change while the page is open. A render that began against one backend
 * must finish against the same one.
 *
 * WHAT IS NOT HERE. `renderUrl` has no local twin — a browser rendering has no URL
 * until one is minted from its blob, which the modal does per expanded row so it can
 * revoke it again. And `postRenderJobFrames`/the upload encoder is HTTP-only by
 * nature: it uploads PNGs TO a server. See selectableEncoders below.
 */

import { isStatic } from "./storageMode.js";
import * as projectApi from "./projectApi.js";
import * as localRenderStore from "./localRenderStore.js";
import { BROWSER_ENCODERS } from "./browserJobView.js";

/**
 * Query. The record backend for this page's storage mode — the module answering
 * submitRenderJob / listRenderJobs / cancelRenderJob / postRenderJobOutput /
 * deleteRenderJob / markRenderJobSeen.
 *
 * @returns {object} projectApi (http) or localRenderStore (local)
 *
 * @example
 * >>> renderRecordStore().submitRenderJob("RobotSim", {name: "Take 1", backend: "client", framesTotal: 12, params})
 * {id: "r-9f3a…", state: "rendering", …}
 */
export function renderRecordStore() {
  return isStatic() ? localRenderStore : projectApi;
}

/**
 * Query. Does this page keep finished renders in BROWSER STORAGE? The predicate the
 * Render Center branches on to offer Download-from-a-blob instead of a server URL
 * and a filesystem path.
 *
 * @returns {boolean}
 */
export function rendersAreLocal() {
  return isStatic();
}

/**
 * Query. The encoders a user may CHOOSE from in this mode.
 *
 * In static mode this is exactly one: "wasm", the in-page encoder. "upload" is not a
 * quality trade-off there, it is a TRANSPORT — it POSTs a PNG per frame to a server
 * and asks that server to run ffmpeg — so with no server it cannot work at all.
 * Offering it beside a live option would be the "lie of choice" the user objected
 * to: a dropdown whose second entry can only fail.
 *
 * In HTTP mode both remain, with the measured trade-off between them (see
 * web/browserJobView.js BROWSER_ENCODERS).
 *
 * @returns {{value: string, label: string, resume: string}[]}
 *
 * @example
 * >>> selectableEncoders().map((e) => e.value)   // static mode
 * ["wasm"]
 * >>> selectableEncoders().map((e) => e.value)   // http mode
 * ["upload", "wasm"]
 */
export function selectableEncoders() {
  if (!isStatic()) return BROWSER_ENCODERS;
  const wasm = BROWSER_ENCODERS.find((e) => e.value === "wasm");
  // THE LABEL IS REWRITTEN, and that is not cosmetic. The shared one reads "Encode
  // in page — fastest over a network, resumes per segment": every word of that
  // compares it against the upload encoder, which does not exist here. A comparative
  // label with nothing to compare to is noise at best and, at worst, implies there is
  // a faster option being withheld. `resume` is untouched — the segment-boundary
  // promise is a property of the encoder, not of the comparison.
  return [{ ...wasm, label: "Encode in page — no server involved" }];
}

/**
 * Query. The encoder this mode DEFAULTS to, and in static mode the only one that
 * exists. Named rather than derived at each call site so a stored setting naming an
 * unusable encoder ("upload", persisted from an HTTP session, then opened on the
 * static site) resolves to something that works instead of failing at frame zero.
 *
 * @returns {string} "wasm" | "upload"
 */
export function defaultEncoderForMode() {
  return selectableEncoders()[0].value;
}

// `usableEncoder` — the pure "which encoder can this form actually use" rule — lives
// in web/browserJobView.js, NOT here, for the same reason BROWSER_ENCODERS does:
// this module imports the fetch layer (projectApi reads `location` at module scope)
// and so cannot be loaded in bare node, while that rule is exactly the kind of claim
// a node test should be able to check. Re-exported because this is where a caller
// looks for it.
export { usableEncoder } from "./browserJobView.js";
