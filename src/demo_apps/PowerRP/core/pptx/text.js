/**
 * TEXT — `<p:txBody>` -> paragraphs -> runs, with EVERY run's effective
 * font/size/color/bold/italic/underline/align/spacing RESOLVED after walking
 * the inheritance chain (core/pptx/inherit.js) down to the theme. This is the
 * module research_01 §3 calls out as needing hand-rolled work beyond what any
 * existing reader exposes ("no bullet-reading API at all... these can also be
 * INHERITED from the list style / layout / master, compounding the inheritance
 * problem").
 *
 * RESOLUTION ORDER for a run property (highest precedence first), per
 * ECMA-376 §21.1.2.3.9 CT_TextCharacterProperties / the DrawingML text model:
 *   1. The run's own `<a:rPr>` (or the paragraph's `<a:endParaRPr>` for an
 *      empty trailing paragraph mark's formatting).
 *   2. The paragraph's `<a:pPr><a:defRPr>` (paragraph-level run defaults).
 *   3. The CHAIN from inherit.levelPPrChain (layout lstStyle -> master
 *      lstStyle -> master txStyles), each level's `<a:lvlNpPr><a:defRPr>`.
 *   4. Theme defaults (font: `+mn-lt`/`+mj-lt` resolution; color: none — a
 *      run with NO color anywhere in the chain and no theme "default text
 *      color" concept gets this module's ECMA-376 baseline, tx1 mapped
 *      through clrMap, since `<a:defRPr>` at every real level in this deck's
 *      OWN master already sets `<a:solidFill><a:schemeClr val="tx1"/>`).
 * Each SCALAR property is walked independently — ECMA-376 does NOT require
 * that a lower-precedence level's `sz` "goes together" with its `b`; a run can
 * inherit font size from the master while its own rPr sets bold directly, and
 * a different-precedence source can supply color. `resolveRunProps` does the
 * per-property walk explicitly instead of copying whole `<a:defRPr>` blocks.
 *
 * PARAGRAPH-LEVEL PROPERTIES (`algn`, `lnSpc`, `spcBef`, `spcAft`, `marL`,
 * `indent`) walk the SAME chain, minus the run-level step — see
 * resolveParagraphProps.
 *
 * BULLETS (`buChar`/`buAutoNum`/`buNone`) walk the SAME pPr/lvlNpPr chain and
 * are recorded as `{kind: "char", char} | {kind: "autoNum", type} | {kind: "none"}`.
 * An explicit `<a:buNone/>` at any level in the chain WINS outright (it is a
 * terminal "no bullet" — ECMA-376 does not define combining a buNone with a
 * lower level's buChar), matching PowerPoint's own behavior of buNone
 * overriding an inherited bullet rather than merely being itself overridable.
 */

import { xmlChild, xmlChildren, xmlAttr, xmlText as innerText } from "./xml.js";
import { resolveThemeColor, resolveThemeFont } from "./theme.js";
import { levelPPrChain } from "./inherit.js";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";

/** ECMA-376's baseline when NOTHING in the whole chain sets a property —
 * §21.1.2.3.9's documented defaults for CT_TextCharacterProperties (sz in the
 * XML's centipoints-of-a-point unit, i.e. sz="1800" = 18pt; converted to
 * points in the resolved output, see PT_PER_CENTIPOINT). PowerPoint's own
 * built-in fallback (b/i/u false, no color, sz 18pt, Calibri) — used only when
 * a document is missing even a master txStyles entry, which is malformed but
 * should still resolve to SOMETHING rather than throw. */
const DEFAULT_RUN_PROPS = { sizePt: 18, bold: false, italic: false, underline: "none", color: null, fontLatin: "Calibri" };
const DEFAULT_PARAGRAPH_PROPS = { align: "l", level: 0 };

const CENTIPOINTS_PER_POINT = 100;

/**
 * Pure function. `sz="2800"` (centipoints) -> 28 (points) — the XML integer
 * attribute PowerPoint calls "hundredths of a point" (ECMA-376
 * ST_TextFontSize).
 *
 * @param {string} sz
 * @returns {number}
 *
 * @example centipointsToPoints("2800") // 28
 */
export function centipointsToPoints(sz) {
  return Number(sz) / CENTIPOINTS_PER_POINT;
}

/**
 * Pure function. Read one `<a:rPr>`/`<a:defRPr>`/`<a:endParaRPr>`-shaped
 * element's OWN DIRECT properties (no inheritance) into a partial props
 * object — only keys that are actually SET on this element are present, so
 * callers can distinguish "unset, keep walking the chain" from "set to a
 * falsy value" (e.g. `b="0"` really does mean bold:false, not "unset").
 *
 * @param {object|null} rPrNode - an `<a:rPr>`-shaped element, or null
 * @returns {{sizePt?: number, bold?: boolean, italic?: boolean, underline?: string, color?: object, fontLatin?: string}}
 *
 * @example
 * >>> directRunProps(parseXml('<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" sz="2800" b="1" i="1" u="sng"/>')))
 * {"sizePt": 28, "bold": true, "italic": true, "underline": "sng"}
 * @example directRunProps(null)
 * {}
 */
export function directRunProps(rPrNode) {
  if (!rPrNode) return {};
  const out = {};
  const sz = xmlAttr(rPrNode, null, "sz");
  if (sz !== undefined) out.sizePt = centipointsToPoints(sz);
  const b = xmlAttr(rPrNode, null, "b");
  if (b !== undefined) out.bold = b === "1" || b === "true";
  const i = xmlAttr(rPrNode, null, "i");
  if (i !== undefined) out.italic = i === "1" || i === "true";
  const u = xmlAttr(rPrNode, null, "u");
  if (u !== undefined) out.underline = u; // "none"|"sng"|"dbl"|"heavy"|"dotted"|... — kept as-is, not enumerated here
  const solidFill = xmlChild(rPrNode, A, "solidFill");
  if (solidFill) out.color = readColorNode(solidFill);
  const latin = xmlChild(rPrNode, A, "latin");
  if (latin) out.fontLatin = xmlAttr(latin, null, "typeface", "");
  return out;
}

/**
 * Pure function. Read the color descriptor inside a `<a:solidFill>` (or any
 * paint-holding element with a single color child) into an UNRESOLVED
 * descriptor: `{kind: "srgb", hex}` or `{kind: "scheme", slot, transforms}`.
 * Resolution to a final hex (for scheme colors) needs the document's clrMap +
 * theme, which this function deliberately does not have — see
 * resolveColorDescriptor.
 *
 * @param {object} fillNode - element containing exactly one color child
 * @returns {{kind: "srgb", hex: string}|{kind: "scheme", slot: string, transforms: {name:string,val:string}[]}}
 *
 * @example readColorNode(parseXml('<a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="FF0000"/></a:solidFill>')) // {"kind": "srgb", "hex": "FF0000"}
 * @example readColorNode(parseXml('<a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:schemeClr val="bg1"/></a:solidFill>')).slot // "bg1"
 */
export function readColorNode(fillNode) {
  const srgb = xmlChild(fillNode, A, "srgbClr");
  if (srgb) return { kind: "srgb", hex: xmlAttr(srgb, null, "val", "").toUpperCase() };
  const scheme = xmlChild(fillNode, A, "schemeClr");
  if (scheme) {
    const slot = xmlAttr(scheme, null, "val");
    const transforms = scheme.children.filter((c) => c.type === "element" && c.ns === A).map((c) => ({ name: c.local, val: xmlAttr(c, null, "val", "") }));
    return { kind: "scheme", slot, transforms };
  }
  return { kind: "unsupported" };
}

/**
 * Pure function. Resolve a readColorNode() descriptor to a final hex string
 * plus its unapplied transform list (mirrors theme.resolveThemeColor's
 * return shape). An `srgb` descriptor needs no theme and returns immediately.
 *
 * @param {object} descriptor - readColorNode() output
 * @param {Record<string,string>} colorMap - the effective p:clrMap
 * @param {Record<string,string>} colorScheme - theme.parseColorScheme() output
 * @returns {{hex: string, transforms: object[]}|null} null for an "unsupported" descriptor
 *
 * @example resolveColorDescriptor({kind:"srgb", hex:"FF0000"}, {}, {}) // {hex: "FF0000", transforms: []}
 */
export function resolveColorDescriptor(descriptor, colorMap, colorScheme) {
  if (descriptor.kind === "srgb") return { hex: descriptor.hex, transforms: [] };
  if (descriptor.kind === "scheme") return resolveThemeColor(descriptor.slot, colorMap, colorScheme, descriptor.transforms.map((t) => ({ type: "element", ns: A, local: t.name, attrs: [{ ns: null, local: "val", name: "val", value: t.val }], children: [] })));
  return null;
}

/**
 * Pure function. Read one `<a:pPr>`/`<a:lvlNpPr>`-shaped element's OWN DIRECT
 * paragraph properties (align, indentation, spacing) — same "only present
 * keys are set" contract as directRunProps.
 *
 * @param {object|null} pPrNode
 * @returns {{align?: string, marL?: number, indent?: number}}
 *
 * @example directParagraphProps(parseXml('<a:pPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" algn="ctr" marL="228600"/>')) // {"align": "ctr", "marL": 228600}
 */
export function directParagraphProps(pPrNode) {
  if (!pPrNode) return {};
  const out = {};
  const algn = xmlAttr(pPrNode, null, "algn");
  if (algn !== undefined) out.align = algn;
  const marL = xmlAttr(pPrNode, null, "marL");
  if (marL !== undefined) out.marL = Number(marL);
  const indent = xmlAttr(pPrNode, null, "indent");
  if (indent !== undefined) out.indent = Number(indent);
  return out;
}

/**
 * Pure function. Read one level's bullet setting from a `<a:pPr>`/`<a:lvlNpPr>`
 * element: `<a:buNone/>` -> `{kind:"none"}`, `<a:buChar char="…"/>` ->
 * `{kind:"char", char}`, `<a:buAutoNum type="…"/>` -> `{kind:"autoNum", type}`,
 * or `null` if this level sets no bullet directive at all (keep walking).
 *
 * @param {object|null} pPrNode
 * @returns {{kind: "none"}|{kind: "char", char: string}|{kind: "autoNum", type: string}|null}
 *
 * @example directBullet(parseXml('<a:pPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:buNone/></a:pPr>')) // {"kind": "none"}
 * @example directBullet(parseXml('<a:pPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:buChar char="•"/></a:pPr>')).char // "•"
 * @example directBullet(parseXml('<a:pPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>'))
 * null
 */
export function directBullet(pPrNode) {
  if (!pPrNode) return null;
  if (xmlChild(pPrNode, A, "buNone")) return { kind: "none" };
  const buChar = xmlChild(pPrNode, A, "buChar");
  if (buChar) return { kind: "char", char: xmlAttr(buChar, null, "char", "") };
  const buAutoNum = xmlChild(pPrNode, A, "buAutoNum");
  if (buAutoNum) return { kind: "autoNum", type: xmlAttr(buAutoNum, null, "type", "") };
  return null;
}

/**
 * Pure function. Resolve one run's EFFECTIVE properties: the run's own rPr,
 * then the paragraph's `<a:pPr><a:defRPr>`, then each level in `chain`
 * (highest precedence first — inherit.levelPPrChain's own `<a:defRPr>`
 * children), then theme font-token resolution and finally
 * DEFAULT_RUN_PROPS. Colors are resolved to hex via `colorMap`/`colorScheme`;
 * a resolved color's `transforms` list is folded into the result as
 * `colorTransforms` so deck.js can refusal-list a non-empty one without this
 * function losing the base hex.
 *
 * @param {object|null} rPrNode - the run's own `<a:rPr>`, or null
 * @param {object|null} paragraphDefRPr - the paragraph's `<a:pPr><a:defRPr>`, or null
 * @param {object[]} chain - inherit.levelPPrChain() output (each entry's `<a:defRPr>` is read)
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @param {object} fontScheme - theme.parseFontScheme() output
 * @returns {{sizePt: number, bold: boolean, italic: boolean, underline: string, color: string|null, colorTransforms: object[], font: string}}
 *
 * @example
 * >>> const rPr = parseXml('<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" sz="2800" b="1"/>');
 * >>> resolveRunProps(rPr, null, [], {}, {}, {major:{latin:"Calibri Light",ea:"",cs:""},minor:{latin:"Calibri",ea:"",cs:""}}).sizePt
 * 28
 */
export function resolveRunProps(rPrNode, paragraphDefRPr, chain, colorMap, colorScheme, fontScheme) {
  const layers = [directRunProps(rPrNode), directRunProps(paragraphDefRPr), ...chain.map((lvl) => directRunProps(xmlChild(lvl, A, "defRPr")))];
  const pick = (key) => {
    for (const layer of layers) if (key in layer) return layer[key];
    return undefined;
  };
  const sizePt = pick("sizePt") ?? DEFAULT_RUN_PROPS.sizePt;
  const bold = pick("bold") ?? DEFAULT_RUN_PROPS.bold;
  const italic = pick("italic") ?? DEFAULT_RUN_PROPS.italic;
  const underline = pick("underline") ?? DEFAULT_RUN_PROPS.underline;
  const colorDescriptor = pick("color");
  let color = null, colorTransforms = [];
  if (colorDescriptor) {
    const resolved = resolveColorDescriptor(colorDescriptor, colorMap, colorScheme);
    if (resolved) { color = resolved.hex; colorTransforms = resolved.transforms; }
  }
  const fontRaw = pick("fontLatin") ?? "+mn-lt"; // ECMA-376's own effective baseline when nothing sets a typeface: the minor (body) theme font
  const font = resolveThemeFont(fontRaw, fontScheme);
  return { sizePt, bold, italic, underline, color, colorTransforms, font };
}

/**
 * Pure function. Resolve one paragraph's EFFECTIVE align/indentation: the
 * paragraph's own `<a:pPr>`, then each level in `chain`.
 *
 * @param {object|null} pPrNode
 * @param {object[]} chain
 * @returns {{align: string, marL: number|undefined, indent: number|undefined}}
 *
 * @example resolveParagraphProps(parseXml('<a:pPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" algn="ctr"/>'), []).align // "ctr"
 */
export function resolveParagraphProps(pPrNode, chain) {
  const layers = [directParagraphProps(pPrNode), ...chain.map((lvl) => directParagraphProps(lvl))];
  const pick = (key) => {
    for (const layer of layers) if (key in layer) return layer[key];
    return undefined;
  };
  return { align: pick("align") ?? DEFAULT_PARAGRAPH_PROPS.align, marL: pick("marL"), indent: pick("indent") };
}

/**
 * Pure function. Resolve one paragraph's EFFECTIVE bullet: the paragraph's
 * own pPr, then each level in `chain`, taking the FIRST level that declares
 * ANY bullet directive (none/char/autoNum) — see this file's header for why
 * buNone at a lower level is terminal rather than merely a value to override.
 *
 * @param {object|null} pPrNode
 * @param {object[]} chain
 * @returns {{kind: "none"}|{kind: "char", char: string}|{kind: "autoNum", type: string}}
 *
 * @example resolveBullet(null, []) // {"kind": "none"}
 */
export function resolveBullet(pPrNode, chain) {
  const direct = directBullet(pPrNode);
  if (direct) return direct;
  for (const lvl of chain) {
    const b = directBullet(lvl);
    if (b) return b;
  }
  return { kind: "none" }; // ECMA-376's own terminal default: no txStyles bullet found means no bullet
}

/**
 * Query (pure given its inputs — reads no package state, but named "resolve"
 * rather than "parse" because it performs the FULL inheritance walk). Parse a
 * `<p:txBody>` element into `{paragraphs}`, each paragraph's runs carrying
 * fully RESOLVED effective properties.
 *
 * @param {object} txBodyNode - a shape's `<p:txBody>` element
 * @param {{type: string, idx: number|null}|null} slideKey - placeholderKey() of the owning shape
 * @param {object|null} layoutShapeNode - resolveLayoutPlaceholder() result
 * @param {object|null} masterShapeNode - resolveMasterPlaceholder() result
 * @param {object|null} txStylesNode - the master's `<p:txStyles>`
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @param {object} fontScheme
 * @returns {{paragraphs: {align: string, bullet: object, runs: object[]}[]}}
 */
export function resolveTextBody(txBodyNode, slideKey, layoutShapeNode, masterShapeNode, txStylesNode, colorMap, colorScheme, fontScheme) {
  const paragraphs = xmlChildren(txBodyNode, A, "p").map((pNode) => {
    const pPr = xmlChild(pNode, A, "pPr");
    const level = pPr ? Number(xmlAttr(pPr, null, "lvl", "0")) : 0;
    const chain = levelPPrChain(slideKey, layoutShapeNode, masterShapeNode, txStylesNode, level);
    const paragraphDefRPr = pPr ? xmlChild(pPr, A, "defRPr") : null;
    const runs = xmlChildren(pNode, A, "r").map((rNode) => {
      const rPr = xmlChild(rNode, A, "rPr");
      const tNode = xmlChild(rNode, A, "t");
      return { text: tNode ? innerText(tNode) : "", ...resolveRunProps(rPr, paragraphDefRPr, chain, colorMap, colorScheme, fontScheme) };
    });
    const paraProps = resolveParagraphProps(pPr, chain);
    return { level, align: paraProps.align, marL: paraProps.marL, indent: paraProps.indent, bullet: resolveBullet(pPr, chain), runs };
  });
  return { paragraphs };
}
