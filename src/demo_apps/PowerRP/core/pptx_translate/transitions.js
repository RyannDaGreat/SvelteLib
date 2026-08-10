/**
 * TRANSITIONS — DeckIR slide `transition` -> PowerRP `slide.transition`
 * (core/transitions.js's `{type, seconds, curve, sound}`), per the design
 * doc's "Transitions between PPT slides" section.
 *
 * PowerRP has exactly two transition TYPES today (core/transitions.js
 * TRANSITION_TYPES): "tween" and "fade". There is no "push" and no "none"/
 * cut type — a cut is `{type:"tween", seconds:0}` (0 = instant, per that
 * module's own docblock), and PUSH is expressed as a TWEEN plus camera
 * keyframes (design doc), not a third transition type.
 *
 *   none  -> tween, seconds 0 (a cut).
 *   fade  -> fade, seconds = durMs/1000.
 *   morph -> tween (the matched-identity chains do the interpolation work;
 *            this function only picks the transition TYPE/seconds — morph
 *            identity itself is morph_identity.js's job).
 *   push  -> tween (camera-keyframe construction is translate.js's job,
 *            since it needs the CAMERA's own state, not just the transition
 *            record).
 *   anything else (an ECMA-376 legacy type this translator has no camera
 *            treatment for: wipe/blinds/checker/...) -> tween, with a
 *            refusal naming the dropped visual effect.
 */

/** PPT transition types this translator can express EXACTLY (as "fade").
 * Every other known type (mapping spec §8: wipe/blinds/checker/... + push,
 * handled specially by translate.js) falls through to a plain tween cut. */
const FADE_TYPES = new Set(["fade"]);

/**
 * Pure function. DeckIR `slide.transition` (or `null` for a slide with none)
 * -> PowerRP's `{type, seconds, curve, sound}` PLUS a refusal string when
 * the PPT type isn't one this translator faithfully reproduces (`null` when
 * fully faithful). Does NOT handle push's camera-keyframe construction —
 * translate.js reads `transitionIR.type === "push"` itself for that, since
 * it needs the deck's slide size and the camera item, which this pure
 * function deliberately does not take.
 *
 * @param {{type:string, durMs:number, morphOption:string|null}|null} transitionIR
 * @returns {{transition: {type:string, seconds:number, curve:string, sound:null}, refusal: string|null}}
 *
 * @example translateTransition(null) // {transition: {type: "tween", seconds: 0, curve: "smooth", sound: null}, refusal: null}
 * @example translateTransition({type:"fade", durMs:1500, morphOption:null}) // {transition: {type: "fade", seconds: 1.5, curve: "smooth", sound: null}, refusal: null}
 * @example translateTransition({type:"morph", durMs:1500, morphOption:"byObject"}) // {transition: {type: "tween", seconds: 1.5, curve: "smooth", sound: null}, refusal: null}
 */
export function translateTransition(transitionIR) {
  if (!transitionIR) return { transition: { type: "tween", seconds: 0, curve: "smooth", sound: null }, refusal: null };
  const seconds = transitionIR.durMs / 1000;
  if (FADE_TYPES.has(transitionIR.type)) {
    return { transition: { type: "fade", seconds, curve: "smooth", sound: null }, refusal: null };
  }
  const knownTween = new Set(["none", "morph", "push", "cut"]);
  const refusal = knownTween.has(transitionIR.type)
    ? (transitionIR.type === "morph" && transitionIR.morphOption && transitionIR.morphOption !== "byObject"
      ? `morph option "${transitionIR.morphOption}" (byWord/byChar sub-object text matching) is not built — translated as a whole-object morph (byObject)`
      : null)
    : `transition type "${transitionIR.type}" has no translator mapping yet — translated as a plain tween cut, losing the ${transitionIR.type} visual effect`;
  return { transition: { type: "tween", seconds, curve: "smooth", sound: null }, refusal };
}

/** PPT push direction -> the camera-keyframe axis + sign this translator
 * moves it along (design doc: "camera keyframes offset by slide size in the
 * push direction"). `dx`/`dy` are in SLIDE-SIZE MULTIPLES (1 = one full
 * slide width/height), applied to the OUTGOING camera position so the
 * INCOMING slide's content, laid out at its normal position, ends up
 * exactly framed once the camera arrives — see translate.js's push
 * construction for how this combines with content offset + visibility
 * bracketing. */
const PUSH_DIRECTIONS = {
  u: { dx: 0, dy: -1 }, // push up: camera moves UP (content enters from below)
  d: { dx: 0, dy: 1 },
  l: { dx: -1, dy: 0 },
  r: { dx: 1, dy: 0 },
};

/**
 * Pure function. The camera-offset vector (in PX, already scaled by slide
 * size) for a `p:push@dir` value, or `null` for an unrecognized direction
 * (reported by the caller).
 *
 * @param {string} dir - "u"|"d"|"l"|"r"
 * @param {number} slideWPx
 * @param {number} slideHPx
 * @returns {{dx:number, dy:number}|null}
 *
 * @example pushOffsetPx("u", 1280, 720) // {dx: 0, dy: -720}
 */
export function pushOffsetPx(dir, slideWPx, slideHPx) {
  const v = PUSH_DIRECTIONS[dir];
  if (!v) return null;
  return { dx: v.dx * slideWPx, dy: v.dy * slideHPx };
}

export { PUSH_DIRECTIONS };
