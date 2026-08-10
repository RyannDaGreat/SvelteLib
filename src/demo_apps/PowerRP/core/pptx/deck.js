/**
 * DECK — the top-level entry point: `parsePptx(bytes) -> DeckIR`. This is
 * STAGE 1 of a 2-stage PowerPoint importer (parse -> translate, this app's
 * CLAUDE.md). It converts raw `.pptx` bytes into a documented, normalized JSON
 * IR ("DeckIR") — nothing here understands PowerRP's own document model
 * (`core/document.js`, `core/deltas.js`); stage 2 (a separate, parallel
 * effort) reads DeckIR and builds a PowerRP document from it. Splitting the
 * work this way means DeckIR can be inspected, diffed, and tested completely
 * independent of anything PowerRP-specific — a `.pptx` either parses into a
 * faithful IR or it doesn't, regardless of what the translator does with it.
 *
 * DOM-FREE, RUNS IN BARE NODE AND THE BROWSER (this app's hard requirement):
 * no `DOMParser`, no Node-only `fs`/`Buffer` APIs anywhere in `core/pptx/*` —
 * only `Uint8Array`, `TextDecoder`/`TextEncoder`, and `fflate` (already a repo
 * dependency, the same library `web/projectZip.js` uses for PowerRP's own
 * .zip round-trip). `tests/pptx_parse_test.js` runs via plain `node`;
 * `tests/pptx_dev/parse_real_deck.mjs` likewise. Nothing in this module tree
 * reads a file path — the caller reads bytes (via `node:fs` in a dev script,
 * or a `<input type=file>`/`fetch` in the browser) and hands them in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE UNIT CONVENTION — READ THIS BEFORE TOUCHING ANY NUMBER IN THIS IR
 * ═══════════════════════════════════════════════════════════════════════════
 * PowerPoint's native length unit is the EMU (English Metric Unit): 914400
 * EMU = 1 inch, 12700 EMU = 1 point. Every position/size field in this IR
 * ending in `Emu` (`offEmu`, `extEmu`, `slideSizeEmu`, `chOffEmu`, `chExtEmu`)
 * is a RAW EMU integer, UNCONVERTED — this parser does NOT rescale to pixels,
 * points, or PowerRP's own coordinate space, because that conversion depends
 * on a target DPI/zoom stage 2 owns, not stage 1. Rotation (`rot60k`) is kept
 * in PowerPoint's native 60,000ths-of-a-degree integer, likewise unconverted
 * (divide by 60000 for degrees). Text size (`sizePt`) is the ONE exception —
 * `text.js`'s `centipointsToPoints` converts the XML's raw centipoints
 * (`sz="2800"`) to POINTS (28) at parse time, because points are already the
 * unit every downstream text consumer (CSS, Skia, PowerRP's own font-size
 * property) wants, and there is no meaningful "raw" alternative the way there
 * is for EMU-vs-pixels. Durations (`durMs`, `delayMs`) are milliseconds,
 * matching the XML's own `p14:dur`/timing-tree units exactly.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DECKIR v1 SHAPE
 * ═══════════════════════════════════════════════════════════════════════════
 * {
 *   slideSizeEmu: {w, h},
 *   slides: [{
 *     index,                    // 0-based, in AUTHORED order (p:sldIdLst — see below)
 *     name: string,             // this deck's own slide name if set, else ""
 *     transition: {type, durMs, morphOption, advClick, advTmMs} | null,
 *     clickSteps: [{trigger: "click"|"auto"|"after", effects: [{shapeId, presetClass, presetId, presetSubtype, durMs, delayMs, kind, cmd}]}],
 *     shapes: ShapeIR[],        // top-level shape tree (groups nest their own `children`)
 *     mediaByShapeId: {[id]: media},  // convenience index — every `media` also sits on its owning ShapeIR
 *   }],
 *   mediaParts: [{path, contentType, bytes}],  // every media part referenced by ANY slide, deduped by archive path
 *   fontsUsed: string[],        // every distinct resolved font family name seen in any run, sorted
 *   warnings: string[],         // non-fatal notes (a migration, a fallback taken) — see "LOUD, NEVER SILENT" below
 *   refusals: [{where, what, sentence}],  // every construct this parser did not understand — see below
 * }
 *
 * ShapeIR (produced by shapes.js, walked here for embedding into DeckIR):
 * {
 *   id, name, hidden, type: "sp"|"pic"|"video"|"audio"|"grpSp"|"cxnSp"|"graphicFrame",
 *   xfrm: {offEmu:{x,y}, extEmu:{w,h}, rot60k, flipH, flipV, chOffEmu, chExtEmu} | null,
 *   geometry: {preset:{name,adjustments}} | {custGeom:{...}} | null,
 *   fill, line, effects,        // shapes.js's raw descriptors — see that file's header
 *   text: {paragraphs: [{level, align, bullet, runs: [{text, sizePt, bold, italic, underline, color, font}]}]} | null,
 *   placeholder: {type, idx} | null,
 *   media: {kind, relTarget, embedded, posterRel, trim, fade, loop, autoplay, volume, mute, fullScreen, isNarration, showWhenStopped} | null,
 *   image: {relTarget, embedded} | null,  // a PLAIN (non-media) pic's own blipFill reference — mutually exclusive with `media`
 *   children: ShapeIR[],        // grpSp only
 * }
 * `type` is "video"/"audio" (NOT "pic") whenever `media !== null` — see
 * classifyShapeType below; a plain picture keeps type "pic" and carries
 * `image` instead of `media`. Exactly one of `media`/`image` is non-null on
 * any `pic`-kind shape (never both — a shape is either a timed video/audio
 * asset or a plain picture, per detectMediaReference's either/or read of
 * `<a:videoFile>`/`<a:audioFile>` vs. absence of either).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTHORED SLIDE ORDER — A REAL TRAP, MEASURED ON THIS DECK
 * ═══════════════════════════════════════════════════════════════════════════
 * research_10: "slide numbering... is authored order (from p:sldIdLst), which
 * is NOT guaranteed to equal filename numeric order in general." This parser
 * NEVER iterates `ppt/slides/slideN.xml` by filename — it walks
 * `presentation.xml`'s `<p:sldIdLst>` (each `<p:sldId r:id="rIdN"/>`, resolved
 * through `ppt/_rels/presentation.xml.rels`) and that walk order IS
 * `slides[].index`. On THIS deck the two orders happen to coincide (verified
 * against research_10 and cross-checked live during development), which is
 * exactly the trap: a parser that took filename order and never hit a
 * counterexample would ship looking correct.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "LOUD, NEVER SILENT" — AND WHY THIS PARSER STILL DOESN'T THROW ON GAPS
 * ═══════════════════════════════════════════════════════════════════════════
 * This app's OWN doctrine (core/abc.js) is stricter than this parser: a tune
 * with ANY unrecognized construct produces ZERO notes, because "half a tune
 * looks like it worked" is a worse failure than an obvious empty one. THIS
 * PARSER DELIBERATELY DEVIATES from that, and the deviation is load-bearing
 * enough to write down rather than leave as an unstated inconsistency:
 *
 *   A `.pptx` is not a tune. It is commonly 50-150 MB with 18-70 slides, each
 *   an independent unit of content (research_10's own census: a 70-slide,
 *   97-media-item deck). Refusing the WHOLE DECK because slide 43 has one
 *   `<a:gradFill>` this parser doesn't resolve would throw away 69 correctly
 *   parsed slides to protect against one incompletely parsed one — the
 *   opposite trade black-and-white "refuse everything" makes for a single
 *   30-second tune. So: parse what you can, and REPORT — not silently skip —
 *   every gap, at the SHAPE or SLIDE granularity the gap actually occurred
 *   at, via `refusals: [{where, what, sentence}]`. A `sentence` always states
 *   what was skipped and what a reader should do about it (extend which
 *   module, or accept the degradation). `refusals` is a first-class OUTPUT of
 *   this parser, not a side channel — `parse_real_deck.mjs`'s whole point is
 *   printing it, because it is the importer's own feature-gap roadmap.
 *
 * Malformed XML/zip is DIFFERENT from an unrecognized-but-well-formed
 * construct, and is NOT caught here: xml.js/zip.js/opc.js throw REAL errors
 * (line/column, missing required parts) that propagate straight out of
 * `parsePptx` — a corrupt byte stream is a hard failure, never a refusal
 * entry, because there is no partial picture to salvage from bytes that
 * don't parse as XML/zip at all.
 *
 * `warnings` (distinct from `refusals`) is for things this parser DID resolve
 * but with a caveat worth surfacing (e.g. a migration it silently-but-loudly
 * performed) — currently unused by this module (no migrations exist at parse
 * time; DeckIR has no legacy version to migrate FROM) but kept in the shape
 * per the task spec for forward compatibility and because deck.js's callers
 * (the future translator) may want a place to append their own.
 */

import { unzipPptx } from "./zip.js";
import { openPackage, contentTypeFor as opcContentTypeFor } from "./opc.js";
import { parseXml, xmlChild, xmlChildren, xmlAttr } from "./xml.js";
import { loadTheme, parseColorMap } from "./theme.js";
import { buildInheritanceContext } from "./inherit.js";
import { parseSlideShapes } from "./shapes.js";
import { parseTransition } from "./transition_parse.js";
import { flattenClickSteps, mediaPlaybackSettings } from "./timing.js";
import { resolveMediaForShape, resolvePictureImage } from "./media.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const REL_TYPE_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_TYPE_SLIDE_LAYOUT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const REL_TYPE_SLIDE_MASTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const REL_TYPE_THEME = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";

/**
 * Pure function. The deck's slide size in EMU, from `presentation.xml`'s
 * `<p:sldSz cx cy>` — one value for the whole deck (ECMA-376 has no per-slide
 * size).
 *
 * @param {object} presentationRoot - parseXml() of ppt/presentation.xml
 * @returns {{w: number, h: number}}
 *
 * @example parseSlideSize(parseXml('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>')) // {"w": 12192000, "h": 6858000}
 */
export function parseSlideSize(presentationRoot) {
  const sldSz = xmlChild(presentationRoot, P, "sldSz");
  if (!sldSz) throw new Error("presentation.xml has no <p:sldSz> — cannot determine slide dimensions");
  return { w: Number(xmlAttr(sldSz, null, "cx")), h: Number(xmlAttr(sldSz, null, "cy")) };
}

/**
 * Pure function. The deck's slides in AUTHORED order (see this file's header)
 * as an array of relationship ids, from `<p:sldIdLst><p:sldId r:id="…"/>`.
 *
 * @param {object} presentationRoot
 * @returns {string[]}
 *
 * @example authoredSlideRIds(parseXml('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="rId2"/></p:sldIdLst></p:presentation>')) // ["rId2"]
 */
export function authoredSlideRIds(presentationRoot) {
  const sldIdLst = xmlChild(presentationRoot, P, "sldIdLst");
  if (!sldIdLst) return [];
  return xmlChildren(sldIdLst, P, "sldId").map((s) => xmlAttr(s, R, "id"));
}

/**
 * Pure function. Classify a ShapeIR's final `type` — "video"/"audio" when a
 * `pic` carries resolved media, else the shape-tree type unchanged. Applied
 * as a thin post-pass over shapes.js's output (which only knows "pic" — media
 * detection needs the slide's relationships and timing tree, which shapes.js
 * doesn't have).
 *
 * @param {object} shape - a ShapeIR node (post shapes.js parse)
 * @returns {string}
 *
 * @example classifyShapeType({type: "pic", media: {kind: "video"}}) // "video"
 * @example classifyShapeType({type: "pic", media: null}) // "pic"
 */
export function classifyShapeType(shape) {
  if (shape.type === "pic" && shape.media) return shape.media.kind;
  return shape.type;
}

/**
 * Command (mutates `mediaAccum.parts`). Register one resolved reference
 * (a media file, a poster, or a plain picture's own blip) into the deck-wide
 * deduped media-parts map — skipped for `TargetMode="External"` references
 * (nothing embedded to read bytes for) and for a path already registered
 * (research_10 finding #8: `image3.png` reused across 8 slides must be
 * counted ONCE, not once per referencing shape). A resolution failure
 * (content-type lookup finding neither an Override nor a Default extension
 * entry) becomes a refusal unless `silentFailure` is set — used for posters,
 * where a missing content-type is a lost thumbnail, not a lost asset.
 *
 * @param {{parts: Map<string,object>}} mediaAccum
 * @param {string} path - resolved archive path, or an external URI
 * @param {boolean} embedded
 * @param {{slideIndex: number}} context
 * @param {{name: string, id: number}} shape
 * @param {object[]} refusals
 * @param {(path:string)=>string} contentTypeFor
 * @param {boolean} [silentFailure]
 */
function registerMediaPart(mediaAccum, path, embedded, context, shape, refusals, contentTypeFor, silentFailure = false) {
  if (!embedded || !path || mediaAccum.parts.has(path)) return;
  try {
    mediaAccum.parts.set(path, { path, contentType: contentTypeFor(path) });
  } catch (e) {
    if (!silentFailure) refusals.push({ where: `slide ${context.slideIndex}, shape "${shape.name}" (id ${shape.id})`, what: `media part "${path}"`, sentence: e.message });
  }
}

/**
 * Command (recurses, attaches `.media`, strips `.node`, and reclassifies
 * `.type`). Walk a ShapeIR tree attaching resolved media info to every `pic`,
 * collecting `{shapeId: media}` and `{path, contentType}` media-part
 * references, and producing the FINAL clean ShapeIR (the raw XML `.node`
 * shapes.js attached for this pass's own use is removed — it must never leak
 * into the emitted JSON).
 *
 * @param {object[]} shapeList - shapes.js output for one slide
 * @param {Map<string,object>} slideRels
 * @param {Map<number,object>} playbackByShapeId
 * @param {{slideIndex: number}} context
 * @param {object[]} refusals
 * @param {{parts: Map<string,{path:string,contentType:string}>, byShapeId: Map<number,object>}} mediaAccum - mutated
 * @param {(path:string)=>string} contentTypeFor
 * @returns {object[]} the final ShapeIR array (node stripped)
 */
export function attachMedia(shapeList, slideRels, playbackByShapeId, context, refusals, mediaAccum, contentTypeFor) {
  return shapeList.map((shape) => {
    if (shape.type === "grpSp") {
      const { node, ...rest } = shape;
      return { ...rest, children: attachMedia(shape.children, slideRels, playbackByShapeId, context, refusals, mediaAccum, contentTypeFor) };
    }
    const { node, ...rest } = shape;
    let media = null;
    let image = null;
    if (shape.type === "pic") {
      try {
        media = resolveMediaForShape(node, shape.id, slideRels, playbackByShapeId, { where: `slide ${context.slideIndex}, shape "${shape.name}" (id ${shape.id})` });
      } catch (e) {
        refusals.push({ where: `slide ${context.slideIndex}, shape "${shape.name}" (id ${shape.id})`, what: "media reference", sentence: e.message });
      }
      if (media) {
        mediaAccum.byShapeId.set(shape.id, media);
        registerMediaPart(mediaAccum, media.relTarget, media.embedded, context, shape, refusals, contentTypeFor);
        if (media.posterRel) registerMediaPart(mediaAccum, media.posterRel, true, context, shape, refusals, contentTypeFor, /* silent */ true);
      } else {
        // Not video/audio — a PLAIN picture's own blipFill is its content,
        // resolved and registered the exact same way (see media.js's
        // resolvePictureImage doc for why one reader backs all three roles).
        try {
          image = resolvePictureImage(node, slideRels);
        } catch (e) {
          refusals.push({ where: `slide ${context.slideIndex}, shape "${shape.name}" (id ${shape.id})`, what: "picture reference", sentence: e.message });
        }
        if (image) registerMediaPart(mediaAccum, image.relTarget, image.embedded, context, shape, refusals, contentTypeFor);
      }
    }
    const type = classifyShapeType({ ...rest, media });
    return { ...rest, type, media, image };
  });
}

/**
 * Command (recurses; collects font names into `into`). Walk a final ShapeIR
 * tree collecting every resolved run font family name.
 *
 * @param {object[]} shapeList
 * @param {Set<string>} into - mutated
 */
export function collectFonts(shapeList, into) {
  for (const shape of shapeList) {
    if (shape.type === "grpSp") { collectFonts(shape.children, into); continue; }
    if (shape.text) for (const p of shape.text.paragraphs) for (const r of p.runs) into.add(r.font);
  }
}

/**
 * Query (reads the package). Resolve one slide's layout, its master, and the
 * theme those pull from, into the `inheritance` context shapes.js/text.js
 * need. Layouts point at their OWN master via the layout's `.rels`
 * (`REL_TYPE_SLIDE_MASTER`); the master points at the theme the same way.
 *
 * @param {object} pkg - openPackage() result
 * @param {string} slidePartPath
 * @returns {{layoutIndex: object, masterIndex: object, txStyles: object|null, colorMap: object, colorScheme: object, fontScheme: object, layoutPartPath: string, masterPartPath: string}}
 */
function resolveSlideInheritance(pkg, slidePartPath) {
  const slideRels = pkg.relationshipsFor(slidePartPath);
  const layoutRel = [...slideRels.values()].find((r) => r.type === REL_TYPE_SLIDE_LAYOUT);
  if (!layoutRel) throw new Error(`${slidePartPath} has no slideLayout relationship`);
  const layoutPartPath = layoutRel.resolvedPath;

  const layoutRels = pkg.relationshipsFor(layoutPartPath);
  const masterRel = [...layoutRels.values()].find((r) => r.type === REL_TYPE_SLIDE_MASTER);
  if (!masterRel) throw new Error(`${layoutPartPath} has no slideMaster relationship`);
  const masterPartPath = masterRel.resolvedPath;

  const masterRels = pkg.relationshipsFor(masterPartPath);
  const themeRel = [...masterRels.values()].find((r) => r.type === REL_TYPE_THEME);
  if (!themeRel) throw new Error(`${masterPartPath} has no theme relationship`);
  const theme = loadTheme(pkg, themeRel.resolvedPath);

  const layoutRoot = parseXml(pkg.partText(layoutPartPath));
  const masterRoot = parseXml(pkg.partText(masterPartPath));
  const layoutSpTree = xmlChild(xmlChild(layoutRoot, P, "cSld"), P, "spTree");
  const masterSpTree = xmlChild(xmlChild(masterRoot, P, "cSld"), P, "spTree");
  const toShapeEntry = (el) => {
    const wrapperTag = { sp: "nvSpPr", pic: "nvPicPr", grpSp: "nvGrpSpPr", cxnSp: "nvCxnSpPr", graphicFrame: "nvGraphicFramePr" }[el.local];
    if (!wrapperTag) return null;
    const wrapper = xmlChild(el, P, wrapperTag);
    const nvPr = wrapper ? xmlChild(wrapper, P, "nvPr") : null;
    return nvPr ? { node: el, nvPr } : null;
  };
  const layoutShapes = layoutSpTree.children.filter((c) => c.type === "element").map(toShapeEntry).filter(Boolean);
  const masterShapes = masterSpTree.children.filter((c) => c.type === "element").map(toShapeEntry).filter(Boolean);
  const txStylesNode = xmlChild(masterRoot, P, "txStyles");
  const { layoutIndex, masterIndex } = buildInheritanceContext(layoutShapes, masterShapes, txStylesNode);
  const clrMapNode = xmlChild(masterRoot, P, "clrMap");
  const colorMap = parseColorMap(clrMapNode);

  return { layoutIndex, masterIndex, txStyles: txStylesNode, colorMap, colorScheme: theme.colorScheme, fontScheme: theme.fontScheme, layoutPartPath, masterPartPath };
}

/**
 * Command (reads bytes; the top-level entry point). Parse `.pptx` bytes into
 * DeckIR — see this file's header for the complete shape and its design
 * rationale. THROWS on malformed zip/XML/missing-required-parts (a hard
 * package-integrity failure); reports everything else it doesn't understand
 * via the returned `refusals` array instead of throwing, per the "loud, never
 * silent" section above.
 *
 * @param {Uint8Array} bytes - raw .pptx file contents
 * @returns {{slideSizeEmu: {w:number,h:number}, slides: object[], mediaParts: object[], fontsUsed: string[], warnings: string[], refusals: object[]}}
 *
 * @example
 * >>> const deckIR = parsePptx(bytes);
 * >>> typeof deckIR.slideSizeEmu.w
 * "number"
 * @example
 * >>> deckIR.slides.length > 0
 * true
 */
export function parsePptx(bytes) {
  const files = unzipPptx(bytes);
  const pkg = openPackage(files);
  const refusals = [];
  const warnings = [];

  const presentationRoot = parseXml(pkg.partText("ppt/presentation.xml"));
  const slideSizeEmu = parseSlideSize(presentationRoot);
  const rIds = authoredSlideRIds(presentationRoot);
  const presRels = pkg.relationshipsFor("ppt/presentation.xml");

  const mediaAccum = { parts: new Map(), byShapeId: new Map() };
  const fontsUsed = new Set();

  const slides = rIds.map((rId, index) => {
    const rel = presRels.get(rId);
    if (!rel || rel.type !== REL_TYPE_SLIDE) throw new Error(`presentation.xml's sldIdLst references r:id="${rId}", which is not a slide relationship`);
    const slidePartPath = rel.resolvedPath;
    const slideRoot = parseXml(pkg.partText(slidePartPath));
    const context = { slideIndex: index };

    const inheritance = resolveSlideInheritance(pkg, slidePartPath);
    const cSld = xmlChild(slideRoot, P, "cSld");
    const name = xmlAttr(cSld, null, "name", "");

    const rawShapes = parseSlideShapes(slideRoot, context, inheritance, refusals);

    const slideRels = pkg.relationshipsFor(slidePartPath);
    const timingNode = xmlChild(slideRoot, P, "timing");
    const playbackByShapeId = mediaPlaybackSettings(timingNode);
    // Per-slide media accumulator: shapes.js/media.js resolve media by SHAPE
    // (shape ids are scoped per-slide in OOXML, not deck-wide), so each
    // slide's own resolved media entries are captured fresh into
    // slideMediaAccum and folded into the deck-wide mediaAccum.parts (deduped
    // by archive path) separately from the per-slide mediaByShapeId this
    // slide's record carries.
    const slideMediaAccum = { parts: mediaAccum.parts, byShapeId: new Map() };
    const shapes = attachMedia(rawShapes, slideRels, playbackByShapeId, context, refusals, slideMediaAccum, (path) => contentTypeForPart(pkg, path));
    collectFonts(shapes, fontsUsed);

    const transition = parseTransition(slideRoot, context, refusals);
    const { clickSteps } = flattenClickSteps(timingNode);

    const mediaByShapeId = {};
    for (const [id, media] of slideMediaAccum.byShapeId) mediaByShapeId[id] = media;

    return { index, name, transition, clickSteps, shapes, mediaByShapeId };
  });

  const mediaParts = [...mediaAccum.parts.values()].map((entry) => ({ ...entry, bytes: pkg.partBytes(entry.path) }));

  return { slideSizeEmu, slides, mediaParts, fontsUsed: [...fontsUsed].sort(), warnings, refusals };
}

/** Content-type lookup for a resolved media part path — thin wrapper around
 * opc.js's contentTypeFor, reading `pkg`'s own contentTypes table. Named
 * locally so deck.js's call sites read as "ask the package" without
 * re-deriving the plumbing at each one. */
function contentTypeForPart(pkg, path) {
  return opcContentTypeFor(pkg.contentTypes, path);
}
