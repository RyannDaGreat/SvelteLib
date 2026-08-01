/**
 * THE SHARED `settled` PREDICATES — the CONVERGES half of core/ephemeral.js.
 *
 * Lives in render_gpu/gpu/ and not in core/ for one reason: settling is a
 * question about live raster state (which refs have decoded), and core/ is
 * DOM-free and must run in bare node. core/ephemeral.js therefore defines the
 * VOCABULARY and CALLS the predicate; this file supplies the predicates that read
 * the registries.
 *
 * WHY A SHARED HELPER RATHER THAN A PREDICATE PER WIDGET: fourteen widgets settle
 * on the same condition — "the raster ref I am about to draw has arrived". Writing
 * that fourteen times is the hand-maintained-mirror defect this codebase keeps
 * rediscovering (a widget's copy drifts, and a drifted `settled` is worse than
 * none: it reports READY for a frame that is not). So a widget names its REFS and
 * this file owns the meaning of ready.
 */

import { imageStatus } from "./image_registry.js";

/**
 * Pure-ish Query (reads the image registry). Have ALL of `refs` stopped changing?
 *
 * "ERROR" COUNTS AS SETTLED, and this is the subtle half. A ref that failed to
 * decode will never decode; treating it as unsettled would hang an export forever
 * on a broken asset, turning a visible missing-image into an invisible stall — a
 * strictly worse failure. Settling asks "will another frame differ", and for an
 * errored ref the answer is no. The MISSING-MEDIA path (gpu/missing_media.js) is
 * what tells the user about it; that is a reporting concern, not a waiting one.
 *
 * A ref that is "unloaded" IS unsettled: nobody has asked for it yet, so a decode
 * is still to come. That is the state a freshly-opened export sits in, and it is
 * exactly the case that shipped holes into mp4s before this existed.
 *
 * @param {string[]} refs - the registry refs this widget is about to draw
 * @returns {boolean}
 *
 * @example refsReady([]) // true (a widget with nothing to load is settled)
 * @example // refsReady(["a.png"]) // false while it is "loading" or "unloaded"
 * @example // refsReady(["a.png"]) // true once it is "ready" — and also once it is "error"
 */
export function refsReady(refs) {
  for (const ref of refs) {
    if (typeof ref !== "string" || ref.length === 0) continue; // nothing requested
    const st = imageStatus(ref);
    if (st !== "ready" && st !== "error") return false;
  }
  return true;
}

/**
 * Pure function. The CONVERGES declaration for a widget whose whole ephemerality
 * is "my raster refs must arrive" — the common case. `refsOf(state)` returns the
 * refs that state will draw.
 *
 * @param {function} refsOf - state → string[] (the refs this state draws)
 * @returns {object} an `ephemeral` declaration
 *
 * @example // ephemeral: convergesOnRefs((s) => [s.src])
 * @example convergesOnRefs(() => []).kind // "converges"
 * @example convergesOnRefs(() => []).settled({}) // true (nothing to wait for)
 */
export function convergesOnRefs(refsOf) {
  return { kind: "converges", settled: (state) => refsReady(refsOf(state) ?? []) };
}
