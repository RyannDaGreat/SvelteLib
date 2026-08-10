/**
 * PLACEHOLDER INHERITANCE — slide -> layout -> master -> master txStyles -> theme.
 *
 * research_01 (§4) names this "THE critical finding": python-pptx (and every
 * naive reader) hands back `None`/absent for anything a slide shape doesn't
 * set directly, but PowerPoint ITSELF walks a resolution chain at render time.
 * A high-fidelity importer has to walk the SAME chain, by hand, because no
 * library does it for you. This module is that chain, decomposed into pure
 * lookup steps so shapes.js/text.js can ask "what SHOULD this property be"
 * without re-deriving the chain at every call site.
 *
 * THE CHAIN, for a SLIDE SHAPE that is a placeholder (`<p:nvPr><p:ph .../></p:nvPr>`):
 *   1. The slide shape's OWN direct properties (highest precedence — always
 *      checked by the CALLER first; this module starts at step 2).
 *   2. The LAYOUT placeholder with the SAME `idx` (placeholderKey below) —
 *      layouts are matched to slides by index, ECMA-376 §19.3.1.36 `p:ph@idx`.
 *   3. The MASTER placeholder with the SAME `type` (NOT idx — masters only
 *      have one placeholder per type, e.g. exactly one `title`, one `body`) —
 *      confirmed against the real deck: slideMaster1.xml declares
 *      `type="title"`, `type="body" idx="1"`, `type="dt" idx="2"`, etc., while
 *      slideLayout2.xml's matching placeholders carry `type="title"` (idx
 *      absent -> defaults to matching by type) and bare `idx="1"` (type absent
 *      -> defaults to "body" per ECMA-376 ST_PlaceholderType's documented
 *      default), so BOTH idx and type must be read with defaulting, not
 *      assumed present.
 *   4. For TEXT run/paragraph properties specifically, the master's
 *      `p:txStyles` (`titleStyle`/`bodyStyle`/`otherStyle`) at the paragraph's
 *      OUTLINE LEVEL (`lvlNpPr`, level = paragraph's `lvl` 0-8, N = level+1).
 *   5. The THEME (colors via theme.js's schemeClr resolution, fonts via
 *      `+mj-lt`/`+mn-lt` tokens) — the terminal fallback for anything txStyles
 *      itself leaves unset (txStyles.js's own `<a:defRPr><a:latin
 *      typeface="+mn-lt"/></a:defRPr>` is ITSELF a theme-font token, so theme
 *      resolution is really interleaved with step 4, not strictly after it —
 *      text.js resolves color/font tokens through theme.js at whichever step
 *      in the chain they're found, rather than this module trying to
 *      pre-flatten theme references out of txStyles).
 *
 * NON-PLACEHOLDER SHAPES (plain `p:sp`/`p:pic` with no `p:ph`) skip steps 2-4
 * entirely — there is no layout/master shape to inherit FROM, only the theme
 * default run properties (ECMA-376's `otherStyle`-equivalent baseline, which
 * this module treats as an empty base so text.js's OWN hardcoded ECMA-376
 * defaults apply — see text.js's DEFAULT_RUN_PROPS). This matters concretely
 * for THIS APP'S REAL DECK: research_10 found ZERO placeholders anywhere in
 * the primary deck ("Every shape is top-level... no `<p:ph>` present" was
 * independently confirmed while building this module — every slide shape is a
 * plain textbox/autoshape), so the placeholder chain is architecturally
 * required (the fixture MUST exercise it, and any other real-world deck WILL
 * use placeholders) but is inert for this particular deck's own shapes.
 */

import { xmlChild, xmlAttr } from "./xml.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";

/** ECMA-376 ST_PlaceholderType's default when `<p:ph>` omits `type` — "body".
 * Confirmed against the real layouts: `<p:ph idx="1"/>` with no type is the
 * layout's content placeholder, matched to the master's `type="body"`. */
const DEFAULT_PLACEHOLDER_TYPE = "body";

/**
 * Pure function. Read a shape's `<p:nvPr><p:ph .../></p:nvPr>` (if any) into
 * `{type, idx}` with ECMA-376 defaults applied, or `null` if the shape is not
 * a placeholder at all.
 *
 * @param {object} nvPrNode - the shape's `p:nvSpPr/p:nvPr` (or `p:nvPicPr/p:nvPr` etc.) element
 * @returns {{type: string, idx: number|null}|null}
 *
 * @example
 * >>> placeholderKey(parseXml('<p:nvPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:ph type="ctrTitle"/></p:nvPr>'))
 * {"type": "ctrTitle", "idx": null}
 * @example
 * >>> placeholderKey(parseXml('<p:nvPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:ph idx="1"/></p:nvPr>'))
 * {"type": "body", "idx": 1}
 * @example placeholderKey(parseXml('<p:nvPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'))
 * null
 */
export function placeholderKey(nvPrNode) {
  const ph = xmlChild(nvPrNode, P, "ph");
  if (!ph) return null;
  const type = xmlAttr(ph, null, "type", DEFAULT_PLACEHOLDER_TYPE);
  const idxRaw = xmlAttr(ph, null, "idx");
  return { type, idx: idxRaw === undefined ? null : Number(idxRaw) };
}

/**
 * Pure function. Index a container's (layout's or master's) top-level shapes
 * by their placeholder key, for O(1) lookup by idx or by type. Non-placeholder
 * shapes are skipped (they cannot be inherited FROM).
 *
 * @param {object[]} shapeNvPrNodes - array of `{key: {type, idx}, node: <the p:sp/p:pic element>}`
 * @returns {{byIdx: Map<number, object>, byType: Map<string, object>}}
 *
 * @example
 * >>> const idx1 = {type: "body", idx: 1};
 * >>> const shapes = [{key: idx1, node: "SHAPE_A"}];
 * >>> indexPlaceholders(shapes).byIdx.get(1)
 * "SHAPE_A"
 */
export function indexPlaceholders(shapeNvPrNodes) {
  const byIdx = new Map();
  const byType = new Map();
  for (const { key, node } of shapeNvPrNodes) {
    if (!key) continue;
    if (key.idx !== null && !byIdx.has(key.idx)) byIdx.set(key.idx, node);
    // A type may appear more than once at LAYOUT level (rare) but the MASTER
    // has at most one placeholder per type by construction — first-wins is the
    // correct read for both, since a duplicate is a malformed authoring case
    // this resolver should not need an opinion about.
    if (!byType.has(key.type)) byType.set(key.type, node);
  }
  return { byIdx, byType };
}

/**
 * Pure function. Resolve which LAYOUT shape a slide placeholder inherits
 * from: the layout placeholder with the SAME idx (§19.3.1.36); when the
 * slide placeholder has no idx (title/ctrTitle placeholders often omit it,
 * matched by type alone at the master), fall back to matching by type.
 *
 * @param {{type: string, idx: number|null}} slideKey
 * @param {{byIdx: Map, byType: Map}} layoutIndex - indexPlaceholders() of the layout's shapes
 * @returns {object|null} the matching layout shape node, or null if none matches
 *
 * @example resolveLayoutPlaceholder({type:"body",idx:1}, {byIdx:new Map([[1,"L"]]), byType:new Map()}) // "L"
 * @example resolveLayoutPlaceholder({type:"ctrTitle",idx:null}, {byIdx:new Map(), byType:new Map([["ctrTitle","L2"]])}) // "L2"
 */
export function resolveLayoutPlaceholder(slideKey, layoutIndex) {
  if (slideKey.idx !== null && layoutIndex.byIdx.has(slideKey.idx)) return layoutIndex.byIdx.get(slideKey.idx);
  if (layoutIndex.byType.has(slideKey.type)) return layoutIndex.byType.get(slideKey.type);
  return null;
}

/**
 * Pure function. Resolve which MASTER shape a placeholder inherits from: the
 * master placeholder with the SAME TYPE (masters key by type, never by idx —
 * research_01 §4: "master placeholders are keyed by type"). `PLACEHOLDER_TYPE_ALIASES`
 * folds title-family variants (`title`/`ctrTitle`) onto the master's `title`
 * bucket and body-family variants (`body`/`subTitle`) onto `body`, because a
 * layout's `ctrTitle`/`subTitle` (Title Slide layout's vocabulary) has no
 * literal master counterpart — the master only ever declares `title`/`body` —
 * and PowerPoint itself visually inherits Title-Slide placeholders from the
 * master's ordinary title/body.
 *
 * @param {{type: string, idx: number|null}} key - slide or layout placeholder key
 * @param {{byIdx: Map, byType: Map}} masterIndex - indexPlaceholders() of the master's shapes
 * @returns {object|null}
 *
 * @example resolveMasterPlaceholder({type:"ctrTitle",idx:null}, {byIdx:new Map(), byType:new Map([["title","M"]])}) // "M"
 */
export function resolveMasterPlaceholder(key, masterIndex) {
  const aliased = PLACEHOLDER_TYPE_ALIASES[key.type] ?? key.type;
  return masterIndex.byType.get(aliased) ?? null;
}

/** Layout-only placeholder type vocabulary that maps onto the master's
 * title/body buckets — ECMA-376 §19.7.13 `ST_PlaceholderType` lists `title`,
 * `ctrTitle` ("Center Title", the Title Slide layout's title placeholder),
 * `body`, `subTitle` ("Subtitle", the Title Slide layout's body placeholder)
 * as distinct enum values that nonetheless share ONE master ancestor each. */
export const PLACEHOLDER_TYPE_ALIASES = { ctrTitle: "title", subTitle: "body" };

/** Which master `p:txStyles` bucket a placeholder type's paragraph/run
 * defaults come from (ECMA-376 §19.3.1.53: titleStyle for title-family, bodyStyle
 * for body-family and content placeholders, otherStyle for everything else
 * including non-placeholder text boxes). */
export function txStylesBucketFor(placeholderType) {
  const aliased = PLACEHOLDER_TYPE_ALIASES[placeholderType] ?? placeholderType;
  if (aliased === "title") return "titleStyle";
  if (aliased === "body") return "bodyStyle";
  return "otherStyle";
}

/**
 * Pure function. Read one outline LEVEL's paragraph-default run properties
 * (`<a:lvlNpPr><a:defRPr .../></a:lvlNpPr>`) from a txStyles bucket
 * (`p:titleStyle`/`p:bodyStyle`/`p:otherStyle`) or a shape's own
 * `<a:lstStyle>` — same shape, same reader, since both are ECMA-376
 * `CT_TextListStyle`. `level` is 0-based (paragraph `lvl`); XML levels are
 * 1-based (`lvl1pPr`..`lvl9pPr`).
 *
 * @param {object|null} listStyleNode - a `<p:titleStyle>`/`<a:lstStyle>` element, or null
 * @param {number} level - 0-8
 * @returns {object|null} the `<a:lvlNpPr>` element for that level, or null if absent
 *
 * @example
 * >>> const ls = parseXml('<a:lstStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:lvl1pPr algn="ctr"/></a:lstStyle>');
 * >>> readLevelPPr(ls, 0).attrs.find(a=>a.local==="algn").value
 * "ctr"
 * @example readLevelPPr(null, 0)
 * null
 */
export function readLevelPPr(listStyleNode, level) {
  if (!listStyleNode) return null;
  const tag = `lvl${level + 1}pPr`;
  return xmlChild(listStyleNode, A, tag);
}

/**
 * Query (reads the package). Build the layout/master index structures for one
 * slide, given its resolved layout and master shape lists (each entry
 * `{node, nvPrNode}` for a top-level `p:sp`/`p:pic`/etc.). Bundles
 * indexPlaceholders() for both levels plus the master's raw `p:txStyles`
 * element, so shapes.js/text.js call this ONCE per slide rather than
 * re-indexing per shape.
 *
 * @param {{node: object, nvPr: object}[]} layoutShapes
 * @param {{node: object, nvPr: object}[]} masterShapes
 * @param {object|null} txStylesNode - the master's `<p:txStyles>` element, or null
 * @returns {{layoutIndex: object, masterIndex: object, txStyles: object|null}}
 */
export function buildInheritanceContext(layoutShapes, masterShapes, txStylesNode) {
  const layoutIndex = indexPlaceholders(layoutShapes.map((s) => ({ key: placeholderKey(s.nvPr), node: s.node })));
  const masterIndex = indexPlaceholders(masterShapes.map((s) => ({ key: placeholderKey(s.nvPr), node: s.node })));
  return { layoutIndex, masterIndex, txStyles: txStylesNode };
}

/**
 * Pure function. The full chain of `<a:lvlNpPr>` (or the shape's own
 * `<a:pPr>`/`<a:lstStyle>` level) nodes to check, in PRECEDENCE ORDER
 * (highest first), for a placeholder shape's paragraph at outline `level`.
 * Callers (text.js) walk this list and take the first defined value per
 * property — this function only computes the CHAIN, not the merge.
 *
 * @param {{type: string, idx: number|null}|null} slideKey - null for a non-placeholder shape
 * @param {object|null} layoutShapeNode - the resolved layout shape (or null)
 * @param {object|null} masterShapeNode - the resolved master shape (or null)
 * @param {object|null} txStylesNode - the master's `<p:txStyles>`
 * @param {number} level - 0-based outline level
 * @returns {object[]} `<a:lvlNpPr>`-shaped elements, highest precedence first (never includes the slide shape's own pPr — the caller checks that first)
 */
export function levelPPrChain(slideKey, layoutShapeNode, masterShapeNode, txStylesNode, level) {
  const chain = [];
  const pushListStyle = (shapeNode) => {
    if (!shapeNode) return;
    const txBody = xmlChild(shapeNode, P, "txBody");
    const lstStyle = txBody ? xmlChild(txBody, A, "lstStyle") : null;
    const lvl = readLevelPPr(lstStyle, level);
    if (lvl) chain.push(lvl);
  };
  pushListStyle(layoutShapeNode);
  pushListStyle(masterShapeNode);
  if (txStylesNode) {
    const bucketName = slideKey ? txStylesBucketFor(slideKey.type) : "otherStyle";
    const bucket = xmlChild(txStylesNode, P, bucketName);
    const lvl = readLevelPPr(bucket, level);
    if (lvl) chain.push(lvl);
  }
  return chain;
}
