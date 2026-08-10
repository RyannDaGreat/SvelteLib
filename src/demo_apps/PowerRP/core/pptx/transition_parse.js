/**
 * SLIDE TRANSITIONS — `<p:transition>`, including the `mc:AlternateContent`
 * wrapper PowerPoint 2016+ uses to offer a modern transition (Morph, and any
 * other post-2010 type) alongside a legacy fallback for older readers.
 *
 * THE REAL SHAPE, measured against the primary deck (slide11) rather than
 * assumed from the schema docs alone: `mc:AlternateContent` is the DIRECT
 * CHILD of `<p:sld>` — there is no bare top-level `<p:transition>` on a morph
 * slide at all. EACH BRANCH (`mc:Choice`, `mc:Fallback`) contains its OWN
 * COMPLETE `<p:transition>` element, including its own `spd`/`p14:dur`:
 * ```xml
 * <p:sld>...<p:clrMapOvr/>
 *   <mc:AlternateContent xmlns:mc="..." xmlns:p159="...2015/09/main">
 *     <mc:Choice Requires="p159">
 *       <p:transition spd="slow" p14:dur="2000"><p159:morph option="byObject"/></p:transition>
 *     </mc:Choice>
 *     <mc:Fallback xmlns="">
 *       <p:transition spd="slow"><p:fade/></p:transition>
 *     </mc:Fallback>
 *   </mc:AlternateContent>
 * <p:timing>...
 * ```
 * So THIS module selects a whole `<p:transition>` element (not a type-child
 * within one shared `<p:transition>`) — `findSlideTransition` walks `p:sld`'s
 * direct children looking for a bare `<p:transition>` OR an
 * `mc:AlternateContent` and resolves the alternate-content choice at that
 * level, then `parseTransition` reads duration/type/morph-option off
 * WHICHEVER `<p:transition>` element won.
 *
 * THE ALTERNATE-CONTENT RULE (research_03, research_10 finding #2): prefer
 * the `mc:Choice` whose `Requires` namespace this parser UNDERSTANDS, else
 * `mc:Fallback` — NEVER first-XML-match. `p159` (the 2015/09 PowerPoint
 * transitions namespace, carrying Morph plus every other PPT2013+ type) is
 * the ONE `Requires` value this parser declares support for; any other
 * `Requires` falls through to `mc:Fallback` (and if there is no Fallback
 * either, to a refusal — never a silently-empty transition).
 *
 * DURATION: `p14:dur` (milliseconds, PPT2013+ fine-grained) wins over `spd`
 * (the legacy slow/med/fast enum) when both are present on the WINNING
 * `<p:transition>` element — `p14:dur` is what modern PowerPoint actually
 * uses for playback; `spd` is written alongside it purely for pre-2013 reader
 * back-compat (research_03). `spd`-only decks map through SPD_MS.
 */

import { xmlChild, xmlChildren, xmlAttr } from "./xml.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const P159 = "http://schemas.microsoft.com/office/powerpoint/2015/09/main";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";

/** The ONE `mc:Choice[@Requires]` namespace this parser understands. */
const UNDERSTOOD_REQUIRES_NAMESPACES = new Set([P159]);

/** `spd` (legacy ST_TransitionSpeed) -> approximate milliseconds, used only
 * when a transition has no `p14:dur`. PowerPoint's own documented legacy
 * mapping — not exercised by this deck's own transitions (every real one here
 * carries `p14:dur`), but required for spec completeness. */
const SPD_MS = { fast: 500, med: 1000, slow: 1500 };

/** Transition-type child element local names this parser recognizes — every
 * ECMA-376 legacy type plus `morph` (p159). An unrecognized element still
 * parses (duration/advance are independent of type) but `type` is reported as
 * `"unknown:<localname>"` with a refusal, per the loud-never-silent rule. */
const KNOWN_TRANSITION_TYPES = new Set([
  "blinds", "checker", "circle", "comb", "cover", "cut", "diamond", "dissolve", "fade",
  "newsflash", "plus", "pull", "push", "random", "randomBar", "split", "strips", "wedge",
  "wheel", "wipe", "zoom", "morph",
]);

/**
 * Pure function. Find the winning `<p:transition>` element among a slide's
 * direct children: a bare `<p:transition>` if present (slide17's `<p:push>`,
 * no AlternateContent needed since Push predates the 2015/09 extension
 * namespace), else the `<p:transition>` inside whichever `mc:Choice`/
 * `mc:Fallback` branch wins per the alternate-content rule.
 *
 * @param {object} slideRoot - parseXml() result of a slideN.xml part
 * @returns {{node: object|null, source: "direct"|"choice"|"fallback"|"absent"}}
 *
 * @example
 * >>> const direct = parseXml('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:transition spd="slow"><p:push dir="u"/></p:transition></p:sld>');
 * >>> findSlideTransition(direct).source
 * "direct"
 * @example
 * >>> const none = parseXml('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld/></p:sld>');
 * >>> findSlideTransition(none).source
 * "absent"
 */
export function findSlideTransition(slideRoot) {
  const direct = xmlChild(slideRoot, P, "transition");
  if (direct) return { node: direct, source: "direct" };

  const alt = xmlChild(slideRoot, MC, "AlternateContent");
  if (!alt) return { node: null, source: "absent" };

  for (const choice of xmlChildren(alt, MC, "Choice")) {
    const transitionInChoice = xmlChild(choice, P, "transition");
    if (!transitionInChoice) continue;
    // `Requires` is a whitespace-separated list of PREFIXES, resolved in the
    // Choice element's OWN scope (mc: spec) — rather than re-deriving that
    // scope from the raw attribute string, ask what namespace the choice's
    // OWN transition-type content actually resolved to (xml.js already did
    // that resolution): if that namespace is one we understand, this Choice
    // is usable regardless of exactly how its Requires string spelled the
    // prefix.
    const typeEl = transitionInChoice.children.find((c) => c.type === "element");
    if (typeEl && UNDERSTOOD_REQUIRES_NAMESPACES.has(typeEl.ns)) return { node: transitionInChoice, source: "choice" };
  }
  const fallback = xmlChild(alt, MC, "Fallback");
  if (fallback) {
    const transitionInFallback = xmlChild(fallback, P, "transition");
    if (transitionInFallback) return { node: transitionInFallback, source: "fallback" };
  }
  return { node: null, source: "absent" };
}

/**
 * Pure function. Parse a slide's transition (searched per findSlideTransition)
 * into the DeckIR record `{type, durMs, morphOption, advClick, advTmMs}`, or
 * `null` if the slide has none (most of the primary deck — slides 1-10).
 *
 * @param {object} slideRoot - parseXml() result of a slideN.xml part
 * @param {{slideIndex: number}} context - for refusal messages
 * @param {object[]} refusals - mutated: pushed to on an unrecognized transition type or empty AlternateContent
 * @returns {{type: string, durMs: number, morphOption: string|null, advClick: boolean, advTmMs: number|null}|null}
 *
 * @example parseTransition(parseXml('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld/></p:sld>'), {slideIndex:0}, []) // null
 */
export function parseTransition(slideRoot, context, refusals) {
  const { node: transitionNode, source } = findSlideTransition(slideRoot);
  if (!transitionNode) {
    const alt = xmlChild(slideRoot, MC, "AlternateContent");
    if (alt) refusals.push({ where: `slide ${context.slideIndex} transition`, what: "mc:AlternateContent", sentence: "The slide has an AlternateContent transition wrapper but neither a recognized Choice nor a Fallback yielded a <p:transition>. No transition will play." });
    return null;
  }

  const advClick = xmlAttr(transitionNode, null, "advClick", "1") !== "0";
  const advTmRaw = xmlAttr(transitionNode, null, "advTm");
  const advTmMs = advTmRaw !== undefined ? Number(advTmRaw) : null;
  const p14dur = xmlAttr(transitionNode, P14, "dur");
  const spd = xmlAttr(transitionNode, null, "spd", "fast");
  let durMs = p14dur !== undefined ? Number(p14dur) : SPD_MS[spd];
  if (durMs === undefined) {
    refusals.push({ where: `slide ${context.slideIndex} transition`, what: `spd="${spd}"`, sentence: `Unrecognized transition speed "${spd}" — expected fast/med/slow. Falling back to ${SPD_MS.fast}ms; check the deck's spd attribute if the timing looks wrong.` });
    durMs = SPD_MS.fast;
  }

  const typeNode = transitionNode.children.find((c) => c.type === "element");
  if (!typeNode) {
    refusals.push({ where: `slide ${context.slideIndex} transition`, what: "<p:transition>", sentence: "A <p:transition> element exists but declares no transition-type child. No transition will play on this slide." });
    return { type: "none", durMs, morphOption: null, advClick, advTmMs };
  }
  const type = typeNode.local;
  if (!KNOWN_TRANSITION_TYPES.has(type)) {
    refusals.push({ where: `slide ${context.slideIndex} transition`, what: `<${typeNode.name}>`, sentence: `Unrecognized transition type "<${type}>" (namespace ${typeNode.ns ?? "none"}) — this parser knows the ECMA-376 legacy set plus p159:morph. Recorded as type "unknown:${type}"; a translator must special-case it or it will render as no transition.` });
    return { type: `unknown:${type}`, durMs, morphOption: null, advClick, advTmMs };
  }
  if (source === "fallback") {
    refusals.push({ where: `slide ${context.slideIndex} transition`, what: "mc:Fallback", sentence: `This slide's preferred transition needed a Requires namespace this parser does not recognize, so it fell back to the legacy "${type}" transition. Fidelity is reduced versus what modern PowerPoint would show.` });
  }
  const morphOption = type === "morph" ? xmlAttr(typeNode, null, "option", null) : null;
  if (type === "morph" && !morphOption) refusals.push({ where: `slide ${context.slideIndex} transition`, what: "<p159:morph>", sentence: `<p159:morph> is missing its required "option" attribute (byObject/byWord/byChar). Treating as byObject.` });
  return { type, durMs, morphOption: type === "morph" ? (morphOption ?? "byObject") : null, advClick, advTmMs };
}
