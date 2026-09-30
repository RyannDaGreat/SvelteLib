/**
 * MULTIPOINT COLOUR BRAINSTORMING — the app-level half: the setPreview pairs for a
 * GRADIENT MAP of a whole Multipoint fill and for a RAMP ALONG ONE PATH, shared by the
 * Inspector (web/MultipointField.svelte) and the canvas island. The pure rules live in
 * core/multipoint_recolor.js; the manifest section "Colour brainstorming from the ramp
 * library" states the design.
 *
 * EVERY PAIR IS BUILT FROM THE COMMITTED FOLD (`foldState(doc, slide, 1)`), never from
 * rawState(): a hover preview is replaced wholesale on every tick, and reading the
 * preview-inclusive state would recolour the PREVIOUS hover's recolour, so sweeping
 * the cursor across ramps would drift instead of showing each ramp on the same design.
 *
 * DOM-free at import, like web/multipointCanvas.js.
 */
import { foldState } from "../core/document.js";
import { getPath } from "../core/deltas.js";
import { gradientMapWrites, rampAppliedStops, rampPathStops } from "../core/multipoint_recolor.js";
import { featureEditRefusal } from "../core/multipoint_edit.js";

/** Which side(s) of a two-sided path a ramp lands on, in tab order. */
export const RAMP_SIDES = Object.freeze(["both", "color", "rightColor"]);
export const RAMP_SIDE_LABELS = Object.freeze({ both: "Both", color: "Left", rightColor: "Right" });

/**
 * Query. The COMMITTED stored value at a full document path.
 * @param {object} app - The app store.
 * @param {Array} path - Document path (["items", id, …]).
 * @returns {*}
 */
export function committedAt(app, path) {
  return getPath(foldState(app.doc, app.slideIndex, 1), path);
}

/**
 * Query. Why a ramp cannot be laid along the source at `featurePath`, or null.
 * @param {object} app - The app store.
 * @param {Array} featurePath - Full document path of one Multipoint source.
 * @returns {string|null} A clause for "Unavailable — requires …"-style notes.
 */
export function pathRampRefusal(app, featurePath) {
  const feature = committedAt(app, featurePath);
  if (!feature || typeof feature !== "object" || Array.isArray(feature)) return "this source is equation-driven";
  return featureEditRefusal(feature, "ramp");
}

/**
 * Query. The setPreview pairs that lay `ramp` along one path source (one undo unit
 * when committed): its new stop list, plus a reset of its colour-visibility companion
 * when one is stored (every new stop is visible). A linked-side source takes the ramp
 * on both sides whatever `side` says.
 * @param {object} app - The app store.
 * @param {Array} featurePath - Full document path of the source.
 * @param {{stops: object[], loop?: boolean, space?: string}} ramp - Library ramp value.
 * @param {{side: "both"|"color"|"rightColor", reversed: boolean}} options - Side; direction.
 * @returns {Array<[Array, *]>}
 */
export function pathRampPairs(app, featurePath, ramp, { side, reversed }) {
  const refusal = pathRampRefusal(app, featurePath);
  if (refusal) throw new Error(`pathRampPairs: cannot lay a ramp along this source — ${refusal}`);
  const feature = committedAt(app, featurePath);
  const stops = rampAppliedStops(feature, rampPathStops(ramp, { closed: feature.closed === true, reversed }),
    feature.twoSided === true ? side : "both");
  const pairs = [[[...featurePath, "stops"], stops]];
  if (feature.stopsActive != null) pairs.push([[...featurePath, "stopsActive"], null]);
  return pairs;
}

/**
 * Query. The GRADIENT MAP of a whole fill: setPreview pairs recolouring every literal
 * colour of the Multipoint sub-state at `multipointPath`, plus what was left alone.
 * @param {object} app - The app store.
 * @param {Array} multipointPath - Full document path of the {features, …} sub-state.
 * @param {{stops: object[], loop?: boolean, space?: string}} ramp - Library ramp value.
 * @param {{reversed: boolean}} options - Direction.
 * @returns {{pairs: Array<[Array, string]>, skipped: string[]}}
 */
export function gradientMapPairs(app, multipointPath, ramp, { reversed }) {
  const { writes, skipped } = gradientMapWrites(committedAt(app, multipointPath), ramp, { reversed });
  return { pairs: writes.map(([p, v]) => [[...multipointPath, ...p], v]), skipped };
}
