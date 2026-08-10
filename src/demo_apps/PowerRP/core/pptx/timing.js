/**
 * ANIMATION TIMING — `<p:timing>` -> ordered CLICK STEPS, per research_04's
 * flattening algorithm, MEASURED against the primary deck's actual timing
 * trees (slide2, slide15, slide17, slide18) rather than assumed from schema
 * docs alone.
 *
 * THE REAL SHAPE (confirmed by walking slide15's tree node-by-node):
 * ```
 * p:timing/p:tnLst/p:par/p:cTn[nodeType=tmRoot]/p:childTnLst/
 *   p:seq[nodeType=mainSeq]/p:cTn/p:childTnLst/
 *     p:par/p:cTn (id=3, NO nodeType, stCondLst: delay="indefinite")   <- CLICK STEP 1's wrapper
 *       /p:childTnLst/p:par/p:cTn (id=4, NO nodeType, stCondLst: delay="0")   <- grouping wrapper
 *         /p:childTnLst/
 *           p:par/p:cTn (id=5, nodeType=clickEffect, presetClass=mediacall, delay="0")  <- the actual effect
 *           p:par/p:cTn (id=7, nodeType=withEffect, presetClass=mediacall, delay="0")   <- same click step
 *     p:par/p:cTn (id=9, NO nodeType, stCondLst: delay="indefinite")   <- CLICK STEP 2's wrapper
 *       ...
 * ```
 * TWO OBSERVATIONS THAT DIVERGE FROM A NAIVE "count nodeType=clickEffect" READ:
 *   1. The mainSeq's OWN direct `par` children (id 3, 9, ...) carry NO
 *      `nodeType` at all — the thing that actually marks "this waits for a
 *      click" is their `<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>`,
 *      exactly as research_04 §3 warns: "Always read the actual
 *      `p:stCondLst/p:cond/@evt`... don't trust nodeType blindly." This
 *      parser's click-step BOUNDARY detector is therefore keyed on
 *      `startsOnClick` (a `delay="indefinite"` start condition with no `evt`,
 *      OR an explicit `evt="onNext"`/`onClick"`), checked on every `par`/`seq`
 *      node during the walk — not on a fixed nodeType string, and not on a
 *      fixed nesting depth (real depth varies: slide17's single click-step
 *      wrapper instead carries `<p:cond evt="onBegin" delay="0"><p:tn
 *      val="2"/></p:cond>` — AUTOSTART on slide entry, zero user clicks).
 *   2. `nodeType=clickEffect`/`withEffect`/`afterEffect` appear TWO LAYERS
 *      DEEPER, on the cTn that actually carries `presetClass`/the behavior —
 *      exactly matching research_04's "two layers of wrapper par/cTn between
 *      mainSeq and the animation-bearing cTn" finding. This parser recurses
 *      GENERICALLY (walk every descendant `par`, check its own cTn's
 *      nodeType) rather than assuming that fixed depth, so a deck with extra
 *      grouping layers (a "with" GROUP, research_04 §3's `withGroup`) still
 *      resolves correctly.
 *
 * `interactiveSeq` (trigger-shape sequences, e.g. click-the-video-to-
 * toggle-pause — every media slide in this deck has one) is a SIBLING of
 * `mainSeq` under the root `p:cTn/p:childTnLst`, confirmed structurally, and
 * is NOT part of the click-step count (research_04 §2) — it is returned
 * separately as `interactiveSeqs`.
 *
 * `p:video`/`p:audio` root-level media nodes (also siblings of `mainSeq`) are
 * NOT surfaced as click steps either — media.js reads them for playback
 * settings (vol/mute/loop/fullScreen), keyed by `spid`.
 */

import { xmlChild, xmlChildren, xmlAttr } from "./xml.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";

/** Trigger events (ECMA-376 ST_TLTriggerEvent) that mean "advance/click", as
 * opposed to "begin automatically" or "chained to another node's end". */
const CLICK_EVENTS = new Set(["onClick", "onNext"]);

/**
 * Pure function. Whether a `<p:cTn>`'s start-condition list means "this node
 * waits for the presentation to advance" (a new click-triggered step
 * boundary). MEASURED against the real deck rather than assumed: PowerPoint
 * writes a bare `<p:cond delay="indefinite"/>` on EVERY mainSeq top-level
 * wrapper regardless of whether it is click- or auto-triggered — slide2's
 * click-triggered wrapper has ONLY that bare condition, but slide17's
 * autostart-on-load wrapper has the SAME bare condition PLUS a second
 * `<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>` chained to
 * mainSeq's own id (2) beginning. So a chained condition (one carrying a
 * `<p:tn>` reference, `evt` `onBegin`/`begin`/`onEnd`/`end`) ALWAYS wins over
 * a co-occurring bare `delay="indefinite"` — the chain is the REAL trigger;
 * the bare indefinite is inert filler. Only when NO chained condition exists
 * does a bare `delay="indefinite"` (or an explicit `onClick`/`onNext`) mean
 * "waits for a click".
 *
 * @param {object|null} cTnNode - a `<p:cTn>` element
 * @returns {boolean}
 *
 * @example startsOnClick(parseXml('<p:cTn xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn>')) // true
 * @example startsOnClick(parseXml('<p:cTn xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>')) // false
 * @example startsOnClick(parseXml('<p:cTn xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst></p:cTn>')) // false (chained onBegin wins over the bare indefinite)
 */
export function startsOnClick(cTnNode) {
  if (!cTnNode) return false;
  const stCondLst = xmlChild(cTnNode, P, "stCondLst");
  if (!stCondLst) return false;
  const conds = xmlChildren(stCondLst, P, "cond");
  const chained = conds.find((c) => xmlChild(c, P, "tn"));
  if (chained) return CLICK_EVENTS.has(xmlAttr(chained, null, "evt"));
  return conds.some((c) => {
    const evt = xmlAttr(c, null, "evt");
    if (evt) return CLICK_EVENTS.has(evt);
    return xmlAttr(c, null, "delay") === "indefinite";
  });
}

/**
 * Pure function. Classify a mainSeq top-level step wrapper's trigger as
 * `"click"` (startsOnClick), `"after"` (its start condition CHAINS to
 * another node via `<p:tn>` with an `end`/`onEnd` event — this step begins
 * when a PRIOR node finishes, PowerPoint's "After Previous" applied at the
 * whole-step level), or `"auto"` (anything else that isn't click-triggered —
 * an `onBegin`/`begin` chain, e.g. slide17's autostart-on-load, or a bare
 * numeric delay).
 *
 * @param {object|null} cTnNode - a mainSeq top-level `par`'s `<p:cTn>`
 * @returns {"click"|"auto"|"after"}
 *
 * @example classifyStepTrigger(parseXml('<p:cTn xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn>')) // "click"
 * @example classifyStepTrigger(parseXml('<p:cTn xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst></p:cTn>')) // "auto"
 */
export function classifyStepTrigger(cTnNode) {
  if (startsOnClick(cTnNode)) return "click";
  const stCondLst = cTnNode ? xmlChild(cTnNode, P, "stCondLst") : null;
  const conds = stCondLst ? xmlChildren(stCondLst, P, "cond") : [];
  const chained = conds.find((c) => xmlChild(c, P, "tn"));
  if (chained) {
    const evt = xmlAttr(chained, null, "evt");
    if (evt === "end" || evt === "onEnd") return "after";
  }
  return "auto";
}

/**
 * Pure function. The `spid` this cBhvr/cMediaNode/cTn's `<p:tgtEl><p:spTgt
 * spid="N"/></p:tgtEl>` targets, or `null` if untargeted (some effects target
 * the slide itself via `<p:sldTgt/>`, not a shape).
 *
 * @param {object} node - an element with a `<p:tgtEl>` child (cBhvr, cMediaNode)
 * @returns {number|null}
 *
 * @example targetShapeId(parseXml('<p:cBhvr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cBhvr>')) // 4
 * @example targetShapeId(parseXml('<p:cBhvr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cBhvr>')) // null
 */
export function targetShapeId(node) {
  const tgtEl = xmlChild(node, P, "tgtEl");
  if (!tgtEl) return null;
  const spTgt = xmlChild(tgtEl, P, "spTgt");
  if (!spTgt) return null;
  const spid = xmlAttr(spTgt, null, "spid");
  return spid === undefined ? null : Number(spid);
}

/** nodeType values that mark an ANIMATION-BEARING cTn (carries presetClass/
 * behavior children) as opposed to a pure grouping wrapper. `clickPar`,
 * `withGroup`, `afterGroup` (research_04 §3) group several behaviors under
 * one with/after start — treated the same as their singular counterparts
 * since this parser flattens to one EFFECT ENTRY per behavior leaf regardless
 * of how many grouping layers wrap it. */
const EFFECT_NODE_TYPES = { clickEffect: "click", withEffect: "with", afterEffect: "after", clickPar: "click", withGroup: "with", afterGroup: "after" };

/**
 * Pure function. Extract ONE effect entry from an animation-bearing `<p:par>`
 * (a cTn whose nodeType is in EFFECT_NODE_TYPES): `{shapeId, presetClass,
 * presetId, presetSubtype, durMs, delayMs, kind}`. `kind` is `"mediacall"`
 * when the behavior is a `<p:cmd>` (research_08/04's media play/pause/stop
 * commands — recorded verbatim as `cmd` too, e.g. `"playFrom(0.0)"`), else
 * the behavior element's local name (`anim`/`set`/`animEffect`/`animMotion`/
 * `animRot`/`animScale`). `durMs` reads the INNER cBhvr's own `<p:cTn dur=…>`
 * (the actual effect duration — e.g. a video's play command's `dur="4840"` is
 * the clip length in ms); `delayMs` is this par's OWN start-condition delay
 * (0 for with-previous, a numeric ms for after-previous or a raw numeric
 * click-step delay — `indefinite`/click-triggered entries report `delayMs:
 * 0`, since the CLICK itself is what starts the step, not an internal delay
 * within it).
 *
 * @param {object} effectParNode - the `<p:par>` whose `<p:cTn>` carries an EFFECT_NODE_TYPES nodeType
 * @returns {{shapeId: number|null, presetClass: string|null, presetId: number|null, presetSubtype: number|null, durMs: number|null, delayMs: number, kind: string, cmd: string|null}}
 */
export function parseEffectEntry(effectParNode) {
  const cTn = xmlChild(effectParNode, P, "cTn");
  const presetClass = xmlAttr(cTn, null, "presetClass", null);
  const presetIdRaw = xmlAttr(cTn, null, "presetID");
  const presetSubtypeRaw = xmlAttr(cTn, null, "presetSubtype");
  const stCondLst = xmlChild(cTn, P, "stCondLst");
  const ownCond = stCondLst ? xmlChildren(stCondLst, P, "cond")[0] : null;
  const ownDelay = ownCond ? xmlAttr(ownCond, null, "delay", "0") : "0";
  const delayMs = ownDelay === "indefinite" ? 0 : Number(ownDelay);

  const childTnLst = xmlChild(cTn, P, "childTnLst");
  const behavior = childTnLst ? childTnLst.children.find((c) => c.type === "element") : null;
  let shapeId = null, durMs = null, kind = "unknown", cmd = null;
  if (behavior) {
    if (behavior.local === "cmd") {
      kind = "mediacall";
      cmd = xmlAttr(behavior, null, "cmd", null);
      const cBhvr = xmlChild(behavior, P, "cBhvr");
      if (cBhvr) {
        shapeId = targetShapeId(cBhvr);
        const innerCTn = xmlChild(cBhvr, P, "cTn");
        const dur = innerCTn ? xmlAttr(innerCTn, null, "dur") : undefined;
        durMs = dur !== undefined && dur !== "indefinite" ? Number(dur) : null;
      }
    } else {
      kind = behavior.local;
      const cBhvr = xmlChild(behavior, P, "cBhvr");
      if (cBhvr) {
        shapeId = targetShapeId(cBhvr);
        const innerCTn = xmlChild(cBhvr, P, "cTn");
        const dur = innerCTn ? xmlAttr(innerCTn, null, "dur") : undefined;
        durMs = dur !== undefined && dur !== "indefinite" ? Number(dur) : null;
      }
    }
  }
  return {
    shapeId, presetClass,
    presetId: presetIdRaw !== undefined ? Number(presetIdRaw) : null,
    presetSubtype: presetSubtypeRaw !== undefined ? Number(presetSubtypeRaw) : null,
    durMs, delayMs, kind, cmd,
  };
}

/**
 * Pure function. Recursively collect every EFFECT_NODE_TYPES entry under
 * `node` (depth-first, document order) — generic on nesting depth per this
 * file's header, so extra grouping `par` layers (a `withGroup` wrapping
 * several behaviors) are transparent. Stops descending into a NESTED
 * click-step boundary (a `par` whose own cTn `startsOnClick`), since that
 * belongs to the NEXT step, not this one — `collectClickSteps` is what walks
 * those boundaries at the top level.
 *
 * @param {object} node - a `<p:par>` or `<p:childTnLst>` element to search under
 * @returns {object[]} effect entries (parseEffectEntry() output), document order
 */
export function collectEffectEntries(node) {
  const out = [];
  const walk = (n, isRoot) => {
    if (n.type !== "element") return;
    if (n.local === "par" && n.ns === P) {
      const cTn = xmlChild(n, P, "cTn");
      const nodeType = cTn ? xmlAttr(cTn, null, "nodeType") : null;
      if (!isRoot && cTn && startsOnClick(cTn)) return; // a nested click boundary belongs to a LATER step
      if (nodeType && EFFECT_NODE_TYPES[nodeType]) {
        out.push(parseEffectEntry(n));
        return; // an effect-bearing par's own children are the BEHAVIOR (cmd/anim/...), not more effects
      }
    }
    for (const c of n.children) walk(c, false);
  };
  walk(node, true);
  return out;
}

/**
 * Pure function. Flatten a `<p:timing>` element's `mainSeq` into ordered
 * click steps, per this file's header. Each top-level `par` directly under
 * `mainSeq`'s `<p:childTnLst>` becomes one step; `trigger` is `"click"` when
 * that par's cTn `startsOnClick`, `"auto"` when it starts on `onBegin`/a
 * numeric delay chained to another node (slide17's pattern), or `"after"`
 * when chained to a sibling step's end (rare at this outer level — afterEffect
 * chains normally live WITHIN a step, not between mainSeq's top-level pars,
 * but the classification is read from the actual condition either way, never
 * assumed from position).
 *
 * @param {object|null} timingNode - a slide's `<p:timing>` element, or null
 * @returns {{clickSteps: {trigger: "click"|"auto"|"after", effects: object[]}[], interactiveSeqCount: number}}
 *
 * @example flattenClickSteps(null) // {clickSteps: [], interactiveSeqCount: 0}
 */
export function flattenClickSteps(timingNode) {
  if (!timingNode) return { clickSteps: [], interactiveSeqCount: 0 };
  const tnLst = xmlChild(timingNode, P, "tnLst");
  const rootPar = tnLst ? xmlChild(tnLst, P, "par") : null;
  const rootCTn = rootPar ? xmlChild(rootPar, P, "cTn") : null;
  const rootChildTnLst = rootCTn ? xmlChild(rootCTn, P, "childTnLst") : null;
  if (!rootChildTnLst) return { clickSteps: [], interactiveSeqCount: 0 };

  const seqs = xmlChildren(rootChildTnLst, P, "seq");
  const mainSeq = seqs.find((s) => {
    const cTn = xmlChild(s, P, "cTn");
    return cTn && xmlAttr(cTn, null, "nodeType") === "mainSeq";
  });
  const interactiveSeqCount = seqs.filter((s) => {
    const cTn = xmlChild(s, P, "cTn");
    return cTn && xmlAttr(cTn, null, "nodeType") === "interactiveSeq";
  }).length;
  if (!mainSeq) return { clickSteps: [], interactiveSeqCount };

  const mainCTn = xmlChild(mainSeq, P, "cTn");
  const mainChildTnLst = mainCTn ? xmlChild(mainCTn, P, "childTnLst") : null;
  if (!mainChildTnLst) return { clickSteps: [], interactiveSeqCount };

  const clickSteps = xmlChildren(mainChildTnLst, P, "par").map((stepPar) => {
    const cTn = xmlChild(stepPar, P, "cTn");
    return { trigger: classifyStepTrigger(cTn), effects: collectEffectEntries(stepPar) };
  });

  return { clickSteps, interactiveSeqCount };
}

/**
 * Query (pure given its inputs). Read every root-level `<p:video>`/`<p:audio>`
 * media node's playback settings, keyed by target shapeId — see media.js's
 * header for how deck.js merges this into each media shape's `media` field.
 * Separated into timing.js (not media.js) because it is fundamentally a
 * TIMING-TREE read (research_08 §3B: "the actual playing of the video... is
 * done within the timing node list"), even though its OUTPUT feeds media.js.
 *
 * @param {object|null} timingNode
 * @returns {Map<number, {kind: "video"|"audio", vol: number, mute: boolean, numSld: number, showWhenStopped: boolean, fullScrn: boolean, isNarration: boolean, repeatCount: string|number, autoplay: boolean}>}
 */
export function mediaPlaybackSettings(timingNode) {
  const out = new Map();
  if (!timingNode) return out;
  const tnLst = xmlChild(timingNode, P, "tnLst");
  const rootPar = tnLst ? xmlChild(tnLst, P, "par") : null;
  const rootCTn = rootPar ? xmlChild(rootPar, P, "cTn") : null;
  const rootChildTnLst = rootCTn ? xmlChild(rootCTn, P, "childTnLst") : null;
  if (!rootChildTnLst) return out;

  for (const kind of ["video", "audio"]) {
    for (const mediaNode of xmlChildren(rootChildTnLst, P, kind)) {
      const cMediaNode = xmlChild(mediaNode, P, "cMediaNode");
      if (!cMediaNode) continue;
      const spid = targetShapeId(cMediaNode);
      if (spid === null) continue;
      const cTn = xmlChild(cMediaNode, P, "cTn");
      const stCondLst = cTn ? xmlChild(cTn, P, "stCondLst") : null;
      const firstCond = stCondLst ? xmlChildren(stCondLst, P, "cond")[0] : null;
      const autoplay = !!firstCond && xmlAttr(firstCond, null, "delay") !== "indefinite";
      out.set(spid, {
        kind,
        vol: Number(xmlAttr(cMediaNode, null, "vol", "50000")),
        mute: xmlAttr(cMediaNode, null, "mute", "0") === "1",
        numSld: Number(xmlAttr(cMediaNode, null, "numSld", "1")),
        showWhenStopped: xmlAttr(cMediaNode, null, "showWhenStopped", "1") === "1",
        fullScrn: xmlAttr(mediaNode, null, "fullScrn", "0") === "1",
        isNarration: xmlAttr(mediaNode, null, "isNarration", "0") === "1",
        repeatCount: cTn ? xmlAttr(cTn, null, "repeatCount", "1") : "1",
        autoplay,
      });
    }
  }
  return out;
}
