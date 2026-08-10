/**
 * <p:transition> BUILDER — PowerRP's per-slide `transition` record
 * (core/transitions.js: {type, seconds, curve, sound}) -> OOXML. Neither
 * pptxgenjs nor python-pptx emits `<p:transition>`/`<p:timing>` at all
 * (.frenzy/research_09_export_pptx.md sections 1/2/6), so this is hand-emitted
 * raw XML, per the lead's architecture decision to write the whole package
 * ourselves rather than adopt a library that cannot express this.
 *
 * TWO POWERRP TYPES, TWO OOXML SHAPES:
 *   tween -> MORPH, wrapped in the exact mc:AlternateContent/p159 shape
 *            research_09 captured by diffing a real PowerPoint-authored morph
 *            (scanny/python-pptx#942, confirmed independently by
 *            MartinPacker/md2pptx) — Choice requires the 2015 p159 namespace,
 *            Fallback is a plain <p:fade/> for older readers. PowerRP's tween
 *            IS a continuous item-by-item interpolation, which is exactly what
 *            morph performs in PowerPoint's own engine — no other OOXML
 *            transition expresses "objects glide from their slide-N position
 *            to their slide-(N+1) position", so morph is the ONLY faithful
 *            target for a tween, not merely the fanciest available.
 *   fade  -> <p:fade/>, no AlternateContent needed (a plain built-in transition
 *            every PowerPoint version understands).
 * `seconds` -> BOTH `p14:dur` (milliseconds, morph's own duration extension)
 *   AND the plain transition's implicit speed bucket (`spd`) — OOXML's base
 *   <p:transition> has no numeric duration attribute pre-2010 (only
 *   spd="slow"/"med"/"fast"), so `spd` is derived from `seconds` as the
 *   closest bucket for readers that ignore p14:dur, while p14:dur carries the
 *   EXACT authored duration for any reader that honors it (PowerPoint does).
 *
 * autoAdvance (core/transitions.js's slide-field row, PowerRP's post-transition
 * LINGER before the next slide) maps to the SAME <p:transition> element's
 * `advClick`/`advTm` attributes (OOXML has no separate auto-advance block —
 * they live on the transition itself), so autoAdvanceAttrs()'s result is
 * merged into whichever transition element (morph's Choice+Fallback pair, or
 * the plain fade) slideTransitionXml builds.
 */

import { tag, attrs } from "./xml_writer.js";

const P159_NS = "http://schemas.microsoft.com/office/powerpoint/2015/09/main";
const P14_NS = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/**
 * Pure function. `seconds` -> OOXML's coarse `spd` bucket (slow/med/fast) —
 * the fallback-reader hint every <p:transition> carries regardless of whether
 * a numeric duration extension is also present.
 *
 * @param {number} seconds
 * @returns {string}
 *
 * @example transitionSpeedBucket(0.3) // "fast"
 * @example transitionSpeedBucket(1) // "med"
 * @example transitionSpeedBucket(2) // "slow"
 */
export function transitionSpeedBucket(seconds) {
  if (seconds <= 0.5) return "fast";
  if (seconds <= 1.5) return "med";
  return "slow";
}

/**
 * Pure function. `{advClick, advTm}` attribute values for PowerRP's nullable
 * `autoAdvance` (seconds — core/transitions.js slideFieldKeys): `null` (never
 * auto-advance, the default) omits both; any number sets `advClick="1"` (a
 * click STILL also advances — PowerPoint's own dual-trigger convention) plus
 * `advTm` in milliseconds.
 *
 * @param {number|null|undefined} autoAdvanceSeconds
 * @returns {{advClick: string|null, advTm: number|null}}
 *
 * @example autoAdvanceAttrs(null) // {advClick: null, advTm: null}
 * @example autoAdvanceAttrs(3) // {advClick: "1", advTm: 3000}
 * @example autoAdvanceAttrs(0) // {advClick: "1", advTm: 0}
 */
export function autoAdvanceAttrs(autoAdvanceSeconds) {
  if (autoAdvanceSeconds === null || autoAdvanceSeconds === undefined) return { advClick: null, advTm: null };
  return { advClick: "1", advTm: Math.round(autoAdvanceSeconds * 1000) };
}

/**
 * Command. `<mc:AlternateContent>` wrapping a p159 morph transition (Choice)
 * with a plain fade fallback — the VERBATIM shape research_09 captured from a
 * real PowerPoint file, parameterized on `seconds` and the slide's
 * auto-advance attrs (merged onto BOTH the Choice and Fallback transitions, so
 * either reader honors the same auto-advance timing).
 *
 * @param {number} seconds
 * @param {{advClick: string|null, advTm: number|null}} adv
 * @returns {string}
 */
export function morphTransitionXml(seconds, adv) {
  const spd = transitionSpeedBucket(seconds);
  const durMs = Math.round(seconds * 1000);
  const choiceAttrs = attrs({ spd, "xmlns:p14": P14_NS, "p14:dur": durMs, advClick: adv.advClick, advTm: adv.advTm });
  const choiceTransition = `<p:transition${choiceAttrs}><p159:morph option="byObject"/></p:transition>`;
  const fallbackTransition = tag("p:transition", { spd, advClick: adv.advClick, advTm: adv.advTm }, tag("p:fade"));
  return (
    `<mc:AlternateContent xmlns:mc="${MC_NS}">` +
    `<mc:Choice xmlns:p159="${P159_NS}" Requires="p159">${choiceTransition}</mc:Choice>` +
    `<mc:Fallback>${fallbackTransition}</mc:Fallback>` +
    `</mc:AlternateContent>`
  );
}

/** `<p:fade>` transition (+ auto-advance attrs), no AlternateContent needed —
 * every PowerPoint version understands a plain built-in fade. */
export function fadeTransitionXml(seconds, adv) {
  return tag("p:transition", { spd: transitionSpeedBucket(seconds), advClick: adv.advClick, advTm: adv.advTm }, tag("p:fade"));
}

/**
 * Command (throws on an unrecognized PowerRP transition type — loud, per this
 * app's no-silent-fallback rule). The full transition XML block for one
 * slide's RESOLVED transition record (core/transitions.resolveTransition) plus
 * its own `autoAdvance` slide field, or "" for slide 0 (no predecessor to
 * transition from — this app's own convention, core/transitions.js: "Slide 0
 * has no predecessor... its transition... is inert").
 *
 * @param {{type: string, seconds: number}} transition
 * @param {number|null|undefined} autoAdvanceSeconds
 * @param {boolean} isFirstSlide
 * @returns {string}
 */
export function slideTransitionXml(transition, autoAdvanceSeconds, isFirstSlide) {
  if (isFirstSlide) return "";
  const adv = autoAdvanceAttrs(autoAdvanceSeconds);
  if (transition.type === "tween") return morphTransitionXml(transition.seconds, adv);
  if (transition.type === "fade") return fadeTransitionXml(transition.seconds, adv);
  throw new Error(`slideTransitionXml: unrecognized PowerRP transition type ${JSON.stringify(transition.type)} (known: tween, fade)`);
}
