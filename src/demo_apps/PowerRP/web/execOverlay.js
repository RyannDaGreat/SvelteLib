/**
 * THE EXEC OVERLAY'S ONE BINDING — `core/exec_flow.js` bound to the app's real
 * evaluator (manifest R7-8, triggers).
 *
 * ── WHY THIS IS ITS OWN MODULE AND NOT A LINE IN cameraFrame.js ─────────────
 * `execOverlayAt` replays the deck from slide 0 and must EVALUATE at every boundary,
 * and evaluation needs two things the fold does not carry: the project script and
 * the intrinsic content sizes. That is exactly the argument that put both at
 * `web/cameraFrame.evaluationAt` — so the binding belongs beside them.
 *
 * BUT TWO CONSUMERS NEED IT, NOT ONE. `cameraFrame.evaluationAt` covers every PIXEL
 * consumer (thumbnails, PNG/MP4 export, the presenter, the CLI hook); the EDITOR
 * reads its state through `web/app.svelte.js`'s `rawState()` instead. That is the
 * same split content sizes already have, and the same reason app.svelte.js threads
 * them separately. Events must show up while AUTHORING — an event is a function of
 * slide position, and the editor has a slide position — so both call sites need the
 * overlay, and a second hand-written evaluator in the second one could differ by a
 * content size and make the canvas disagree with the export.
 *
 * So the evaluator is spelled ONCE, here, in a module light enough for app.svelte.js
 * to import: `cameraFrame.js` additionally pulls in the PDF, map, 3D and live-analysis
 * registries, and app.svelte.js has no business depending on those.
 *
 * IT IS NOT A FUNCTION OF ALPHA, and that is the performance story rather than an
 * omission: events fire at slide boundaries, so one overlay serves every frame of a
 * transition, and a deck with no exec wires pays one structural scan. See
 * core/exec_flow.js, THE FIRING SCHEDULE IS THE SLIDE GRID.
 */

import { execOverlayAt } from "../core/exec_flow.js";
import { evaluateState } from "../core/expressions.js";
import { contentSizesFor } from "./contentSizes.js";

/**
 * Query (memoized per document inside core/exec_flow.js; O(slideIndex) evaluations
 * on a miss, none at all for a deck with no exec wires). THE EXEC OVERLAY for a
 * slide: everything the deck's triggers have written by the time the audience
 * reaches it, as a document delta — or null.
 *
 * @param {object} doc PowerRP document.
 * @param {number} slideIndex Slide index.
 * @param {object} registry Plugin registry.
 * @returns {object|null} a document delta ({items: {...}}), or null
 *
 * @example // execOverlayFor(newDocument(), 0, registry) // null — no triggers, no cost
 */
export function execOverlayFor(doc, slideIndex, registry) {
  return execOverlayAt(doc, slideIndex, registry, (folded) => evaluateState(folded, registry, doc?.meta?.script ?? "", contentSizesFor(folded, doc?.meta?.name ?? ""), doc?.meta?.varKinds ?? null).state);
}
