/**
 * TRANSLATE — stage 2 of the PPTX importer: DeckIR (core/pptx/deck.js's
 * `parsePptx` output) -> a PowerRP document. `translateDeck(deckIR, options)
 * -> {doc, assets, report}` is PURE and DETERMINISTIC (task spec) — no I/O,
 * no clock, no randomness: item ids are minted via a seeded counter (see
 * `mintId` below), never `Math.random()`/`crypto.randomUUID()`, so the same
 * DeckIR always produces byte-identical output.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE — A RULE TABLE, PER THE EXTENSIBILITY REQUIREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 * `SHAPE_TRANSLATORS` maps a ShapeIR `type` ("sp"/"pic"/"video"/"audio"/
 * "cxnSp"/"graphicFrame") to a translator function. An unrecognized shape
 * type (a future OOXML construct, a `graphicFrame` this app's parser already
 * refuses at stage 1) becomes a REPORT entry, never a thrown error and never
 * a silently dropped shape — the deck keeps translating (dump manifest
 * request 18: "don't crystallize it too hard").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MECHANISM (dump manifest, user request 3, verbatim law)
 * ═══════════════════════════════════════════════════════════════════════════
 * One PPT slide with N click steps -> 1+N PowerRP slides. `translateDeck`'s
 * own per-slide loop builds slide 0 (the BASE state, every shape's full
 * resolved properties, entrance-later shapes `active:false`) then one
 * PowerRP slide per click step (core/pptx_translate/mechanism.js). THE
 * MORPH IDENTITY (dump manifest, user request 4) decides which items carry
 * the SAME id across PPT slide boundaries (core/pptx_translate/
 * morph_identity.js) — a matched chain is one PowerRP item across every PPT
 * slide it appears matched on; an unmatched shape at a morph boundary
 * exits/enters via `active:false` with a `"fade"` `active~interp`
 * (mirroring PPT's own crossfade-on-no-match behavior) — see the base-state
 * construction's "UNMATCHED SHAPES AT A MORPH BOUNDARY CROSSFADE" block.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DELTAS ARE BUILT BY DIFFING, NEVER HAND-ROLLED (manifest law)
 * ═══════════════════════════════════════════════════════════════════════════
 * Every PowerRP slide after the first is a `diffState`-computed delta
 * against the PREVIOUS PowerRP slide's fully-resolved item states (this
 * translator's own tracked `priorItemStates`, which mirrors what
 * `core/document.slideState` would fold — computed directly rather than by
 * calling `slideState` on a partially-built doc, since this module never
 * constructs an intermediate document to fold).
 */

import { createRegistry } from "../registry.js";
import { createCommands } from "../commands.js";
import { registerAll } from "../../plugins/index.js";
import { diffState } from "../deltas.js";
import { defaultCameraState } from "../document.js";
import { FONTS } from "../../render_gpu/fonts.js";

import { emuToPx, rot60kToDegrees, emuBoxToPx } from "./units.js";
import { resolveFillPaint, resolveLine } from "./paint.js";
import { fontTitleIndex } from "./fonts.js";
import { translateText } from "./text.js";
import { classifyGeometry } from "./shape_geometry.js";
import { decollidedAssetName, assetBasename, imageState, videoState } from "./media.js";
import { translateTransition, pushOffsetPx } from "./transitions.js";
import { matchSlidePair, resolveSlideChainKeys, flattenMatchable } from "./morph_identity.js";
import { entranceLaterShapeIds, stepEffects, stepTransitionSeconds, interpModeForPreset } from "./mechanism.js";
import { translateEffects } from "./effects.js";

/**
 * Query (constructs a fresh plugin registry every call — createRegistry()/
 * registerAll() are themselves pure/idempotent, so this is a query, not a
 * command: no shared mutable state escapes it). The plugin registry this
 * translator writes zero-report items against.
 *
 * @returns {object} a fully-populated PowerRP plugin registry
 */
function buildRegistry() {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  return registry;
}

/**
 * Pure function. A deterministic item-id minter — sequential, prefixed, so
 * two translations of the SAME DeckIR produce byte-identical ids (the
 * determinism law; core/document.uuid() reads crypto/Math.random and is
 * unusable here). Ids never collide with the app's own 8-char uuid()
 * outputs (a leading "p" is not a hex digit, but ids are opaque strings
 * everywhere they're read, so this needs no special-casing beyond staying
 * unique within one translated document).
 *
 * @returns {() => string}
 *
 * @example const mint = idMinter(); [mint(), mint()] // ["p1", "p2"]
 */
export function idMinter() {
  let n = 0;
  return () => `p${++n}`;
}

/**
 * Pure function. `type: "camera"` -> the fully-defaulted camera plugin
 * state a fresh item of this type needs for a zero-repair-report document
 * (per the research: `repairedDocument`'s `withMissingDefaultsFilled`
 * fills any gap silently for a KNOWN type, but starting complete avoids
 * even that quiet fill). For every OTHER widget type, spreads
 * `registry.get(type).defaults` — the verified zero-report recipe.
 *
 * @param {object} registry
 * @param {string} type
 * @param {object} meta - {slideW, slideH} in px, for the camera's own defaults
 * @returns {object}
 */
function pluginDefaults(registry, type, meta) {
  if (type === "camera") return defaultCameraState(meta);
  try {
    return { ...registry.get(type).defaults };
  } catch {
    // pptxPreset (and any other future rule-table target not yet a
    // registered plugin — task spec: "that plugin is being built in
    // parallel") has no registry entry to spread. A minimal transform-only
    // bag keeps the item renderable-adjacent (position/size/rotation are
    // real) without inventing widget-specific leaves this translator does
    // not own; repairedDocument reports it as an unknown-type ORPHAN until
    // the plugin lands, which is the documented, expected pending state.
    return { type, x: 0, y: 0, w: 0, h: 0, z: 0, rotation: 0, scale: 1 };
  }
}

/**
 * Pure function. THE base transform+paint leaves every DIRECT-mapped shape
 * widget (rect/circle) shares, from a ShapeIR's xfrm/fill/line — px
 * position/size (negative-extents flip contract via emuBoxToPx), rotation
 * in degrees, and resolved fill/stroke.
 *
 * @param {object} shapeIR
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @returns {{state: object, refusals: string[]}}
 */
function baseShapeState(shapeIR, colorMap, colorScheme) {
  const refusals = [];
  const box = shapeIR.xfrm ? emuBoxToPx(shapeIR.xfrm) : { x: 0, y: 0, w: 0, h: 0 };
  const rotation = shapeIR.xfrm ? rot60kToDegrees(shapeIR.xfrm.rot60k) : 0;
  const { paint: fill, refusal: fillRefusal } = resolveFillPaint(shapeIR.fill, colorMap, colorScheme);
  const { stroke, strokeWidth, refusal: lineRefusal } = resolveLine(shapeIR.line, colorMap, colorScheme);
  if (fillRefusal) refusals.push(fillRefusal);
  if (lineRefusal) refusals.push(lineRefusal);
  return { state: { x: box.x, y: box.y, w: box.w, h: box.h, rotation, fill, stroke, strokeWidth }, refusals };
}

/**
 * Pure function (the RULE TABLE, keyed by DeckIR shape `type`). Each rule:
 * `(shapeIR, ctx) -> {widgetType, extraState, refusals}` where `ctx` carries
 * everything a rule might need (colorMap/colorScheme/fontTitleIndex/
 * projectName/assetNameByArchivePath). Unrecognized shape types are NOT
 * listed here — `translateShapeToItemState` below reports them itself,
 * which is the "never throws mid-deck" contract at the dispatch layer, one
 * level up from the individual rules.
 */
const SHAPE_TRANSLATORS = {
  sp(shapeIR, ctx) {
    const { state: base, refusals } = baseShapeState(shapeIR, ctx.colorMap, ctx.colorScheme);
    const paints = { fillHex: typeof base.fill === "string" ? base.fill : null, strokeHex: base.strokeWidth > 0 ? base.stroke : null };
    const { widgetType, extraState, refusal } = classifyGeometry(shapeIR.geometry, base.w, base.h, paints);
    if (refusal) refusals.push(refusal);
    if (shapeIR.effects.length) {
      const { extraState: effectsState, refusals: effectsRefusals } = translateEffects(shapeIR.effects, ctx.colorMap, ctx.colorScheme);
      Object.assign(extraState, effectsState);
      refusals.push(...effectsRefusals);
    }
    let textState = {};
    if (shapeIR.text && (shapeIR.text.paragraphs.length > 1 || shapeIR.text.paragraphs.some((p) => p.runs.length))) {
      const { rich, fontSubstitutions, gaps } = translateText(shapeIR.text, ctx.colorMap, ctx.colorScheme, ctx.fontTitleIndex);
      textState = { hasText: true, rich, fontSubstitutions, textGaps: gaps };
    }
    return { widgetType, state: { ...base, ...extraState }, refusals, textState };
  },
  pic(shapeIR, ctx) {
    const { state: base, refusals } = baseShapeState(shapeIR, ctx.colorMap, ctx.colorScheme);
    if (!shapeIR.image) {
      refusals.push(`picture shape "${shapeIR.name}" has no resolvable image reference — rendered as an empty rect`);
      return { widgetType: "rect", state: base, refusals, textState: {} };
    }
    const archivePath = shapeIR.image.relTarget;
    const assetName = ctx.assetNameFor(archivePath);
    const { x, y, w, h, rotation } = base;
    return { widgetType: "image", state: { x, y, w, h, rotation, ...imageState(ctx.projectName, assetName), strokeWidth: 0, cornerRadius: 0 }, refusals, textState: {} };
  },
  video(shapeIR, ctx) {
    const { state: base, refusals } = baseShapeState(shapeIR, ctx.colorMap, ctx.colorScheme);
    const { x, y, w, h, rotation } = base;
    if (!shapeIR.media) {
      refusals.push(`video shape "${shapeIR.name}" has no resolvable media reference — rendered as an empty rect`);
      return { widgetType: "rect", state: base, refusals, textState: {} };
    }
    const assetName = ctx.assetNameFor(shapeIR.media.relTarget);
    // THE POSTER FRAME lands on the widget's `thumbnail`. This same call already
    // registered the poster into assets/ back when nothing could reference it;
    // now its return value is the asset name the state points at. `showThumbnail`
    // stays false on purpose — see core/pptx_translate/media.js's header.
    const posterAssetName = shapeIR.media.posterRel ? ctx.assetNameFor(shapeIR.media.posterRel) : null;
    if (shapeIR.media.trim) refusals.push(`video "${shapeIR.name}" has a p14:trim (start ${shapeIR.media.trim.stMs}ms, end ${shapeIR.media.trim.endMs}ms) — plugins/video.js has no trim state yet (mapping spec §7 TWEAK); playing the full clip`);
    return { widgetType: "video", state: { x, y, w, h, rotation, ...videoState(ctx.projectName, assetName, shapeIR.media, posterAssetName) }, refusals, textState: {} };
  },
  audio(shapeIR) {
    return { widgetType: null, state: {}, refusals: [`audio shape "${shapeIR.name}" — PowerRP has no standalone audio widget yet (mapping spec §7 NEW-WIDGET) — dropped`], textState: {} };
  },
  cxnSp(shapeIR, ctx) {
    // Connector shapes (mapping spec §3 DIRECT via arrow.js/elbow_arrow.js/
    // curved_arrow.js) — deck 1 has none (confirmed by research_10); the
    // real-deck smoke may exercise this on a later deck. Reported rather
    // than built blind, per the "no speculative mappings" discipline —
    // the arrow-family widgets' endpoint model needs its own translator
    // pass once a real cxnSp sample is available to test numerically.
    return { widgetType: null, state: {}, refusals: [`connector shape "${shapeIR.name}" (cxnSp) has no translator mapping yet — deck 1 does not exercise this path (mapping spec §3 DIRECT, not yet implemented) — dropped`], textState: {} };
  },
  graphicFrame(shapeIR) {
    return { widgetType: null, state: {}, refusals: [`graphicFrame shape "${shapeIR.name}" (table/chart/SmartArt/OLE) — stage 1 does not parse its content and this translator has no target widget — dropped`], textState: {} };
  },
};

export { SHAPE_TRANSLATORS };

/**
 * Pure function. The flat list of top-level + nested (group-recursed)
 * ShapeIR nodes on one slide, in document order — the unit
 * `translateOneSlideState` iterates. Deck 1 has no groups; the walk is
 * still recursive so a future group-bearing deck needs no change here
 * (groups themselves also become an item — mapping spec §3/CLAUDE.md
 * "PPT handles groups slightly differently; ideally real PowerRP groups").
 *
 * @param {object[]} shapes
 * @returns {object[]}
 */
function flattenShapes(shapes) {
  const out = [];
  for (const s of shapes) {
    out.push(s);
    if (s.type === "grpSp") out.push(...flattenShapes(s.children));
  }
  return out;
}

/**
 * Command (mutates `report.refusals`/`report.fontSubstitutions`/
 * `usedAssetPaths`; reads `ctx`). Translates ONE ShapeIR leaf (never a
 * group node itself — groups contribute no item of their own yet, see
 * flattenShapes) into `{itemId, widgetType, state}` via the SHAPE_TRANSLATORS
 * rule table, or `null` when the shape produced no item (a refusal-only
 * drop). `itemId` comes from `ctx.chainKeyFor(shapeId)` — the morph
 * identity assigned to this PPT slide's shape (morph_identity.js), so a
 * matched chain reuses the SAME id every appearance.
 *
 * @param {object} shapeIR
 * @param {object} ctx
 * @param {object} report
 * @returns {{itemId:string, widgetType:string, state:object}|null}
 */
function translateOneShape(shapeIR, ctx, report) {
  const rule = SHAPE_TRANSLATORS[shapeIR.type];
  if (!rule) {
    report.refusals.push(`shape "${shapeIR.name}" has unrecognized DeckIR type "${shapeIR.type}" — dropped`);
    return null;
  }
  const { widgetType, state, refusals, textState } = rule(shapeIR, ctx);
  for (const r of refusals) report.refusals.push(`shape "${shapeIR.name}": ${r}`);
  if (!widgetType) return null;
  if (textState.fontSubstitutions) for (const sub of textState.fontSubstitutions) report.fontSubstitutions.push(sub);
  if (textState.textGaps) for (const g of textState.textGaps) report.refusals.push(`shape "${shapeIR.name}": ${g}`);
  const itemId = ctx.chainKeyFor(shapeIR.id);
  const full = { ...pluginDefaults(ctx.registry, widgetType, ctx.metaPx), ...state, name: shapeIR.name };
  if (textState.hasText) full.text = textState.rich;
  if (widgetType !== "camera" && shapeIR.hidden) full.active = false;
  return { itemId, widgetType, state: full };
}

/**
 * Pure function. Every shapeId this PPT slide's mainSeq click-step timeline
 * ever targets with an ENTRANCE effect (mechanism.js) — the base (step-0)
 * slide starts these `active:false`.
 *
 * @param {object} deckSlide - DeckIR slides[i]
 * @returns {Set<number>}
 */
function baseHiddenShapeIds(deckSlide) {
  return entranceLaterShapeIds(deckSlide.clickSteps);
}

/**
 * Pure function. Builds the FULL flat item-state map (itemId -> full state)
 * for one PPT slide's BASE (step-0) pose — every shape on the slide,
 * translated, with entrance-later shapes forced `active:false`.
 *
 * @param {object} deckSlide
 * @param {object} ctx
 * @param {object} report
 * @returns {Map<string, object>}
 */
function translateSlideBaseState(deckSlide, ctx, report) {
  const hidden = baseHiddenShapeIds(deckSlide);
  const itemStates = new Map();
  for (const shapeIR of flattenShapes(deckSlide.shapes)) {
    const translated = translateOneShape(shapeIR, ctx, report);
    if (!translated) continue;
    if (hidden.has(shapeIR.id)) translated.state.active = false;
    itemStates.set(translated.itemId, translated.state);
  }
  return itemStates;
}

/**
 * Pure function. THE keys to diff between two item states — the union of
 * both states' own keys (diffState only reports keys present in this list;
 * a key present in only one side must still be in the union so its
 * appearance/disappearance is captured).
 *
 * @param {object} a
 * @param {object} b
 * @returns {string[]}
 */
function unionKeys(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

/**
 * Pure function. Builds ONE PowerRP slide delta from the previous fully-
 * resolved item-state map to the next — creation (a NEW itemId gets its
 * FULL state, `type` included) plus property diffs (an EXISTING itemId
 * gets only `diffState`'s changed keys, per the manifest's fold-then-diff
 * law). An item present in `prior` but absent from `next` is left alone
 * entirely (PowerPoint shapes are never "deleted" across an ordinary PPT
 * slide boundary in this translator's model — only visibility changes;
 * see THE MECHANISM's active:false treatment for exits).
 *
 * @param {Map<string,object>} prior - itemId -> full state, or empty Map for slide 0
 * @param {Map<string,object>} next - itemId -> full state
 * @returns {object} a slide delta's `items` object
 */
function deltaFromStates(prior, next) {
  const items = {};
  for (const [id, nextState] of next) {
    const priorState = prior.get(id);
    if (!priorState) {
      items[id] = nextState; // creation — full state, `type` included
      continue;
    }
    const diff = diffState(priorState, nextState, unionKeys(priorState, nextState));
    if (Object.keys(diff).length) items[id] = diff;
  }
  return items;
}

/**
 * Pure function. Applies one click step's entrance/exit/delay effects onto
 * a COPY of `baseState` (the slide's step-0 full item states), returning
 * the new full state map for that step's PowerRP slide, plus the step's
 * own transition seconds (mechanism.js's `stepTransitionSeconds`) and any
 * gaps. `chainKeyFor` resolves a DeckIR shapeId to its item id (the SAME
 * resolver translateSlideBaseState used, so a step's effects land on the
 * exact item its base-slide translation created).
 *
 * @param {Map<string,object>} runningState - mutated via copy — the FOLDED state going into this step (starts as the base slide's, evolves step to step)
 * @param {object} clickStep - DeckIR clickSteps[i]
 * @param {(shapeId:number) => string} chainKeyFor
 * @param {string[]} refusals - mutated
 * @returns {{nextState: Map<string,object>, seconds: number}}
 */
function applyClickStep(runningState, clickStep, chainKeyFor, refusals) {
  // `delay` IS THE PER-TRANSITION WINDOW (core/document.js itemDelayAlpha's
  // "occupies the window [d, T] of the transition"), never a standing
  // property — a shape delayed 0.75s into ITS entrance step must NOT carry
  // that same 0.75s into an unrelated later step's transition just because
  // this translator's tracked state still remembers the leaf. So EVERY
  // item starts this step with `delay` stripped (a fresh shallow copy,
  // never mutating `runningState`'s own objects, which stay shared with
  // the PREVIOUS slide's tracked state) — the effects loop below re-sets
  // it only where this step's own delayMs > 0 applies.
  const nextState = new Map();
  for (const [id, state] of runningState) {
    if (!("delay" in state)) { nextState.set(id, state); continue; }
    const { delay, ...rest } = state;
    nextState.set(id, rest);
  }
  const effects = stepEffects(clickStep);
  for (const e of effects) {
    const itemId = chainKeyFor(e.shapeId);
    const cur = nextState.get(itemId);
    if (!cur) continue; // an effect targeting a shape this translator dropped (e.g. a graphicFrame) — nothing to animate
    const next = { ...cur };
    if (e.kind === "entr") {
      next.active = true;
      const { mode, refusal } = interpModeForPreset(e.presetId);
      if (mode) next["active~interp"] = mode;
      else delete next["active~interp"];
      if (refusal) refusals.push(refusal);
    } else if (e.kind === "exit") {
      next.active = false;
      const { mode, refusal } = interpModeForPreset(e.presetId);
      if (mode) next["active~interp"] = mode;
      if (refusal) refusals.push(refusal);
    } else {
      refusals.push(`click-step effect kind "${e.kind}" (presetId ${e.presetId}) on item ${itemId} has no visible PowerRP translation yet (emphasis/media-call effects) — its delay/timing is not reproduced`);
    }
    if (e.delayMs > 0) next.delay = e.delayMs / 1000;
    nextState.set(itemId, next);
  }
  return { nextState, seconds: stepTransitionSeconds(effects) };
}

export {
  buildRegistry, pluginDefaults, baseShapeState, flattenShapes, translateOneShape,
  translateSlideBaseState, deltaFromStates, applyClickStep, unionKeys,
};

/**
 * Pure function. Resolves `options.slideIndices` (default: every slide, per
 * the task spec's "default all — user request: slide selection") against
 * `deckIR.slides.length` — sorted, deduped, and range-checked so a caller's
 * malformed input fails loudly rather than silently translating the wrong
 * slides.
 *
 * @param {number} slideCount
 * @param {number[]|undefined} requested
 * @returns {number[]}
 *
 * @example resolveSlideIndices(3, undefined) // [0, 1, 2]
 * @example resolveSlideIndices(3, [2, 0]) // [0, 2]
 */
export function resolveSlideIndices(slideCount, requested) {
  const indices = requested ?? Array.from({ length: slideCount }, (_, i) => i);
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  for (const i of sorted) if (i < 0 || i >= slideCount) throw new Error(`translateDeck: slideIndices contains ${i}, out of range for a ${slideCount}-slide deck`);
  return sorted;
}

/**
 * Pure function. Whether the PPT transition INTO `deckSlideB` from
 * `deckSlideA` is a morph — the only transition type that chains item
 * identity across a PPT slide boundary (design doc: a non-morph transition
 * never carries identity across it, matching PowerPoint's own behavior).
 *
 * @param {object} deckSlideB - DeckIR slides[j], the LATER of the pair
 * @returns {boolean}
 */
function boundaryIsMorph(deckSlideB) {
  return deckSlideB.transition?.type === "morph";
}

/**
 * Command (mutates `report.refusals`). Builds THE camera keyframe pair for
 * a `push` transition boundary: the OUTGOING slide's PowerRP slide (the
 * predecessor's LAST step slide) gets the camera nudged by
 * `pushOffsetPx`'s vector so the tween carries it across the gap; the
 * INCOMING slide's content is offset by the SAME vector (design doc:
 * "entering content laid out offset") so it lands in its normal position
 * only once the camera arrives. Deck-1-general (direction u/d/l/r) per the
 * design doc's v1 scope — repeated pushes are bounded because each
 * boundary's offset is relative to the CURRENT camera position, not an
 * absolute walk, so N pushes in the same direction after each other still
 * only ever needs the camera to have moved N slide-heights, matching what
 * PowerPoint itself shows (no wraparound built — v1 scope, same as the
 * design doc).
 *
 * @param {string} dir - p:push@dir
 * @param {number} slideWPx
 * @param {number} slideHPx
 * @param {string[]} refusals
 * @returns {{cameraOffset:{dx:number,dy:number}, contentOffset:{dx:number,dy:number}}|null}
 */
function pushVectors(dir, slideWPx, slideHPx, refusals) {
  const offset = pushOffsetPx(dir, slideWPx, slideHPx);
  if (!offset) {
    refusals.push(`push transition direction "${dir}" is not one of u/d/l/r — translated as a plain tween cut instead of a push`);
    return null;
  }
  // The camera chases the push DIRECTION (moves toward where the new
  // content enters from); the entering content is pre-offset by the SAME
  // vector so it lands at its authored position exactly when the camera
  // arrives there — two offsets of one vector, not independent choices.
  return { cameraOffset: offset, contentOffset: offset };
}

/**
 * Query (constructs bare-node-safe context objects; no I/O). Builds the
 * `ctx` object every SHAPE_TRANSLATORS rule reads: theme/color context, the
 * font title index, the project name for asset src strings, and the
 * chain-key resolver (morph identity) for the CURRENT ppt slide.
 *
 * @param {object} params
 * @returns {object}
 */
function buildShapeCtx({ registry, colorMap, colorScheme, fontIndex, projectName, metaPx, chainKeyMap, mintId, assetNameByArchivePath, usedAssetPaths }) {
  return {
    registry, colorMap, colorScheme, fontTitleIndex: fontIndex, projectName, metaPx,
    chainKeyFor(shapeId) {
      let key = chainKeyMap.get(shapeId);
      if (!key) { key = mintId(); chainKeyMap.set(shapeId, key); }
      return key;
    },
    assetNameFor(archivePath) {
      usedAssetPaths.add(archivePath);
      let name = assetNameByArchivePath.get(archivePath);
      if (!name) { name = decollidedAssetName(assetBasename(archivePath), assetNameByArchivePath.claimedNames); assetNameByArchivePath.set(archivePath, name); }
      return name;
    },
  };
}

/**
 * Pure function. THE deck's per-slide theme context — DeckIR does not embed
 * resolved colorMap/colorScheme per slide (that lives in stage 1's
 * inheritance resolution, already folded into each run's/fill's OWN
 * resolved descriptor by the time it reaches DeckIR — `readColorNode`
 * outputs already carry `{kind:"scheme", slot}` needing only clrMap+scheme
 * to finish resolving, per core/pptx/text.js's header). Since DeckIR does
 * not surface the deck's theme tables directly, this translator reads them
 * off `deckIR.themeColorMap`/`deckIR.themeColorScheme` if present (a future
 * stage-1 addition), else falls back to the ECMA-376 DEFAULT color map
 * identity (bg1->lt1, tx1->dk1, ...) with an EMPTY scheme — which resolves
 * every `schemeClr` to black and is reported, never silent. Deck 1's own
 * fixture DOES carry scheme colors (accent1/accent2 on slide 2), so the
 * fixture test exercises the real theme path via deckIR.themeColorMap/
 * themeColorScheme rather than this fallback.
 *
 * @param {object} deckIR
 * @param {string[]} refusals
 * @returns {{colorMap: Record<string,string>, colorScheme: Record<string,string>}}
 */
function deckThemeContext(deckIR, refusals) {
  if (deckIR.themeColorMap && deckIR.themeColorScheme) return { colorMap: deckIR.themeColorMap, colorScheme: deckIR.themeColorScheme };
  refusals.push("deck carries no resolved theme color map/scheme — any schemeClr-based fill/line/text color resolves to black");
  return { colorMap: {}, colorScheme: {} };
}

/**
 * Query. `deckIR.mediaParts` entries whose archive path is in `usedPaths`,
 * each read to `{name, bytes}` under its DE-COLLIDED asset name — filtered
 * to exactly what the SELECTED slides reference (user ruling, verbatim:
 * "If I translate a subset of the slides, only a subset of the assets
 * should be transferred... the ones that are referenced by those slides"),
 * poster frames included (registered into `usedPaths` the same way a
 * primary media reference is, by `ctx.assetNameFor` — see the `video` rule
 * in SHAPE_TRANSLATORS). This function itself never COPIES bytes for an
 * unreferenced part into its OWN output — `deckIR.mediaParts[i].bytes` for
 * a part outside `usedPaths` is simply skipped, not duplicated.
 *
 * THE MEMORY BOUND THIS DOES **NOT** COVER (recorded, not silently
 * assumed): `core/pptx/deck.js parsePptx` — stage 1, committed, read-only
 * — already reads EVERY media part's bytes into `deckIR.mediaParts` eagerly,
 * before `translateDeck` ever runs or knows which slides will be selected.
 * So a 70-slide/1.25GB deck's FULL media set is in memory the moment
 * `parsePptx` returns, regardless of `options.slideIndices` — this
 * function's own filtering only stops the TRANSLATOR from holding a SECOND
 * copy of the unreferenced bytes in its returned `assets` array. Closing
 * the stage-1 gap (bytes read lazily, per referenced part) would need a
 * `parsePptx` change outside this task's file ownership (core/pptx/* is
 * read-only here) — flagged for a future stage-1 revision, not fixed here.
 *
 * @param {object[]} mediaParts - deckIR.mediaParts
 * @param {Set<string>} usedPaths
 * @param {Map<string,string>} assetNameByArchivePath
 * @returns {{name:string, bytes:Uint8Array}[]}
 */
function collectAssets(mediaParts, usedPaths, assetNameByArchivePath) {
  const out = [];
  for (const part of mediaParts) {
    if (!usedPaths.has(part.path)) continue;
    const name = assetNameByArchivePath.get(part.path);
    out.push({ name, bytes: part.bytes });
  }
  return out;
}

/**
 * Pure function (modulo the deterministic `idMinter` counter, which is
 * itself seeded fresh per call — see this file's header). THE STAGE-2 ENTRY
 * POINT: DeckIR -> a PowerRP document, per this file's header and the
 * design doc. `options.name` names the project (used to build `/asset/
 * <name>/<file>` src strings); `options.slideIndices` (default all) selects
 * which PPT slides translate.
 *
 * @param {object} deckIR - core/pptx/deck.js parsePptx() output
 * @param {{name?: string, slideIndices?: number[]}} [options]
 * @returns {{doc: object, assets: {name:string, bytes:Uint8Array}[], report: object}}
 */
export function translateDeck(deckIR, options = {}) {
  const projectName = options.name ?? "Imported Deck";
  const registry = buildRegistry();
  const mintId = idMinter();
  const report = { refusals: [], fontSubstitutions: [], ambiguities: [], mappings: [] };
  for (const r of deckIR.refusals) report.refusals.push(`(from PPTX parser) [${r.where}] ${r.what}: ${r.sentence}`);
  for (const w of deckIR.warnings) report.refusals.push(`(from PPTX parser, warning) ${w}`);

  const { colorMap, colorScheme } = deckThemeContext(deckIR, report.refusals);
  const fontIndex = fontTitleIndex(FONTS);
  const slideWPx = emuToPx(deckIR.slideSizeEmu.w);
  const slideHPx = emuToPx(deckIR.slideSizeEmu.h);
  const metaPx = { slideW: slideWPx, slideH: slideHPx };

  const selectedIndices = resolveSlideIndices(deckIR.slides.length, options.slideIndices);

  const assetNameByArchivePath = new Map();
  assetNameByArchivePath.claimedNames = new Set();
  const usedAssetPaths = new Set();

  const slides = [];
  let priorItemStates = new Map(); // itemId -> full state, across the whole translated document
  let prevChainKeyMap = null; // the PREVIOUS selected slide's COMPLETE chain-key map (morph_identity.resolveSlideChainKeys) — threaded incrementally, never a two-pass precompute (see that function's header for why)

  selectedIndices.forEach((deckIdx, k) => {
    const deckSlide = deckIR.slides[deckIdx];
    const flat = flattenMatchable(deckSlide.shapes);

    // ── Morph identity: match THIS boundary (against the PREVIOUS selected
    // slide) only when it is a morph transition — chain propagation reads
    // the predecessor's just-computed COMPLETE map (fresh keys included),
    // never a precomputed inherited-only one. ──
    let boundaryMatch = null;
    const predecessorChainKeyMap = prevChainKeyMap; // captured BEFORE this slide's own map replaces it below
    if (k > 0 && boundaryIsMorph(deckSlide)) {
      const prevDeckIdx = selectedIndices[k - 1];
      boundaryMatch = matchSlidePair(deckIR.slides[prevDeckIdx].shapes, deckSlide.shapes);
      for (const a of boundaryMatch.ambiguities) report.ambiguities.push(`slide ${prevDeckIdx}->${deckIdx} morph match: ${a}`);
    }
    const chainKeyMap = resolveSlideChainKeys(prevChainKeyMap, boundaryMatch, flat, mintId);
    prevChainKeyMap = chainKeyMap;

    const ctx = buildShapeCtx({ registry, colorMap, colorScheme, fontIndex, projectName, metaPx, chainKeyMap, mintId, assetNameByArchivePath, usedAssetPaths });

    // ── Base (step-0) full state for this PPT slide. ──
    const baseState = translateSlideBaseState(deckSlide, ctx, report);

    // ── UNMATCHED SHAPES AT A MORPH BOUNDARY CROSSFADE (design doc): a
    // shape PowerPoint's own morph could not pair up still enters/exits —
    // just not by tweening its OWN properties (there is no partner to tween
    // toward). Mirrored here as a plain active:false + "fade" active~interp,
    // exactly like an ordinary entrance/exit, on whichever side each
    // unmatched shape sits: `unmatchedB` (new on THIS slide, no predecessor)
    // starts hidden so its creation-delta addition ITSELF crossfades in over
    // this slide's transition; `unmatchedA` (present on the PREVIOUS slide,
    // no successor here) is hidden ON THIS SLIDE so it crossfades out. ──
    if (boundaryMatch) {
      for (const s of boundaryMatch.unmatchedB) {
        const itemId = ctx.chainKeyFor(s.shapeId);
        const st = baseState.get(itemId);
        if (st) { st.active = false; st["active~interp"] = "fade"; }
      }
      for (const s of boundaryMatch.unmatchedA) {
        // The id this shape was assigned on the PREVIOUS slide —
        // resolveSlideChainKeys already left it OUT of this slide's own
        // chainKeyMap (unmatched = no inherited key), so it will not
        // otherwise appear in baseState at all; write it explicitly so its
        // continued existence (PowerRP keeps items unless purged) crossfades
        // out on this transition rather than lingering unchanged forever.
        const itemId = predecessorChainKeyMap?.get(s.shapeId);
        if (itemId) baseState.set(itemId, { active: false, "active~interp": "fade" });
      }
    }

    // ── The transition INTO this PPT slide's FIRST PowerRP slide. ──
    const { transition: baseTransition, refusal: transitionRefusal } = translateTransition(k === 0 ? null : deckSlide.transition);
    if (transitionRefusal) report.refusals.push(`slide ${deckIdx} transition: ${transitionRefusal}`);

    // ── PUSH: camera nudge on the OUTGOING side + content offset on the
    // incoming side, per pushVectors' header. Applied only k>0 (slide 0 has
    // no predecessor to push from). ──
    let cameraState = k === 0 ? { [CAMERA_ITEM_ID]: defaultCameraState(metaPx) } : null;
    if (k > 0 && deckSlide.transition?.type === "push") {
      // DeckIR's core/pptx/transition_parse.js does NOT surface push's own
      // `dir` attribute today (confirmed by reading it — the module reads
      // type/duration/morphOption only) — reported rather than silently
      // guessed, defaulting to "u" (deck 1's slide17 push-up case) until a
      // future DeckIR field carries the real direction.
      const dir = deckSlide.transition.pushDir ?? "u";
      if (!deckSlide.transition.pushDir) report.refusals.push(`slide ${deckIdx} push transition: DeckIR does not carry the push direction (p:push@dir) yet — assumed "u" (up)`);
      const vectors = pushVectors(dir, slideWPx, slideHPx, report.refusals);
      if (vectors) {
        for (const [, st] of baseState) { st.x += vectors.contentOffset.dx; st.y += vectors.contentOffset.dy; }
        const priorCamera = [...priorItemStates.entries()].find(([, s]) => s.type === "camera");
        if (priorCamera) {
          const [, camState] = priorCamera;
          cameraState = { [priorCamera[0]]: { ...camState, x: camState.x + vectors.cameraOffset.dx, y: camState.y + vectors.cameraOffset.dy } };
        }
      }
    }
    if (cameraState) for (const [id, st] of Object.entries(cameraState)) baseState.set(id, st);

    const baseDelta = { items: deltaFromStates(priorItemStates, baseState) };
    slides.push({ id: mintId(), name: deckSlide.name || `Slide ${deckIdx + 1}`, transition: baseTransition, delta: baseDelta });
    priorItemStates = baseState;

    // ── THE MECHANISM: one PowerRP slide per click step. ──
    let runningState = baseState;
    deckSlide.clickSteps.forEach((step, stepIdx) => {
      const { nextState, seconds } = applyClickStep(runningState, step, ctx.chainKeyFor, report.refusals);
      const stepDelta = { items: deltaFromStates(priorItemStates, nextState) };
      slides.push({
        id: mintId(),
        name: `${deckSlide.name || `Slide ${deckIdx + 1}`} · click ${stepIdx + 1}`,
        transition: { type: "tween", seconds, curve: "smooth", sound: null },
        delta: stepDelta,
      });
      priorItemStates = nextState;
      runningState = nextState;
    });

    // ── autoAdvance (slide-level linger — mapping spec: advTmMs -> seconds). ──
    if (deckSlide.transition?.advTmMs != null) {
      slides[slides.length - 1].autoAdvance = deckSlide.transition.advTmMs / 1000;
    }
  });

  const doc = { meta: { name: projectName, slideW: slideWPx, slideH: slideHPx, script: "" }, slides };
  const assets = collectAssets(deckIR.mediaParts, usedAssetPaths, assetNameByArchivePath);
  return { doc, assets, report };
}

/** The camera's item id within one translateDeck() call — minted once,
 * ahead of the per-shape mintId sequence, so it is always "cam" rather than
 * colliding with or depending on shape-translation order (a translator
 * detail, never read by anything outside this module). */
const CAMERA_ITEM_ID = "camera";
