/**
 * SHAPES — the `<p:spTree>` walk: `p:sp` (autoshape/textbox), `p:pic`
 * (picture, or a video/audio in picture's clothing — see media.js for the
 * video/audio detection this module DEFERS to), `p:grpSp` (group, recursive),
 * `p:cxnSp` (connector), `p:graphicFrame` (table/chart/SmartArt container —
 * this deck has none, but the type is still recognized and REFUSED with
 * context rather than silently skipped).
 *
 * GEOMETRY IS A REFERENCE ONLY, per this task's ownership split: a parallel
 * agent owns core/pptx/preset_geometry.js (resolving `prst` names + `avLst`
 * adjustments into actual vector paths). This module records EXACTLY what the
 * XML says and nothing more:
 *   `{preset: {name, adjustments: {gdName: fmlaValue, ...}}}` for `<a:prstGeom>`
 *   `{custGeom: <parsed pathLst IR>}` for `<a:custGeom>`
 * — see parseGeometryRef's doctest for the exact custGeom IR shape (a plain-data
 * mirror of `<a:pathLst><a:path w h><a:moveTo>/<a:lnTo>/<a:cubicBezTo>/<a:arcTo>/<a:close>`,
 * preserving the path's OWN local w/h coordinate space per research_01 §1.4 —
 * resolving that local space onto the shape's `ext` is the geometry module's job).
 *
 * GROUP CHILD COORDINATE SPACE (chOff/chExt) is recorded on the xfrm exactly
 * as the XML states it (research_01 §1.5's documented gap: python-pptx does
 * NOT resolve this, and neither does this module — the affine composition
 * `scale = group.ext/group.chExt; child_slide_pos = group.off + (child_pos -
 * group.chOff) * scale` belongs to whichever module walks the RESOLVED tree
 * for rendering/translation, stage 2's job, not stage 1's). This module just
 * makes sure `chOffEmu`/`chExtEmu` survive the parse when present.
 *
 * NEGATIVE w/h (xfrm `<a:ext cx cy>` can be negative in real files — not
 * observed in THIS deck's group/shape ext, but `<a:off>` IS negative on
 * slide18's four debug videos, used as a de-facto off-slide crop per
 * research_10 finding #6) is preserved as-is; this module does not normalize
 * or reject a negative offset or extent, matching the app's own
 * "NEGATIVE EXTENTS are a REFLECTION, resolved at ONE seam" doctrine
 * (CLAUDE.md) — that seam is stage 2's translator, not this parser.
 */

import { xmlChild, xmlChildren, xmlAttr } from "./xml.js";
import { readColorNode, resolveTextBody } from "./text.js";
import { placeholderKey, resolveLayoutPlaceholder, resolveMasterPlaceholder } from "./inherit.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";

/** Recognized top-level shape-tree element local names -> our `type` tag. */
const SHAPE_ELEMENT_TYPES = { sp: "sp", pic: "pic", grpSp: "grpSp", cxnSp: "cxnSp", graphicFrame: "graphicFrame" };

/**
 * Pure function. Parse an `<a:xfrm>` element (present on `p:spPr` for `sp`/
 * `pic`/`cxnSp`, or directly on `p:grpSpPr` for a group) into
 * `{offEmu, extEmu, rot60k, flipH, flipV, chOffEmu, chExtEmu}`. `rot60k` stays
 * in ECMA-376's native 60,000ths-of-a-degree unit (never converted to degrees
 * here — deck.js's header documents the EMU/60k-degree unit convention this
 * whole IR uses, so every consumer converts the same way once). Absent
 * `<a:xfrm>` (legal — a shape can omit it and inherit position from its
 * placeholder, which is stage-2/inherit.js territory, not this parser)
 * returns `null`.
 *
 * @param {object|null} xfrmNode - the `<a:xfrm>` element, or null if absent
 * @returns {{offEmu: {x:number,y:number}, extEmu: {w:number,h:number}, rot60k: number, flipH: boolean, flipV: boolean, chOffEmu: {x:number,y:number}|null, chExtEmu: {w:number,h:number}|null}|null}
 *
 * @example
 * >>> parseXfrm(parseXml('<a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" rot="5400000" flipH="1"><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm>'))
 * {"offEmu": {"x": 100, "y": 200}, "extEmu": {"w": 300, "h": 400}, "rot60k": 5400000, "flipH": true, "flipV": false, "chOffEmu": null, "chExtEmu": null}
 * @example parseXfrm(null)
 * null
 */
export function parseXfrm(xfrmNode) {
  if (!xfrmNode) return null;
  const off = xmlChild(xfrmNode, A, "off");
  const ext = xmlChild(xfrmNode, A, "ext");
  const chOff = xmlChild(xfrmNode, A, "chOff");
  const chExt = xmlChild(xfrmNode, A, "chExt");
  return {
    offEmu: off ? { x: Number(xmlAttr(off, null, "x", "0")), y: Number(xmlAttr(off, null, "y", "0")) } : { x: 0, y: 0 },
    extEmu: ext ? { w: Number(xmlAttr(ext, null, "cx", "0")), h: Number(xmlAttr(ext, null, "cy", "0")) } : { w: 0, h: 0 },
    rot60k: Number(xmlAttr(xfrmNode, null, "rot", "0")),
    flipH: xmlAttr(xfrmNode, null, "flipH", "0") === "1",
    flipV: xmlAttr(xfrmNode, null, "flipV", "0") === "1",
    chOffEmu: chOff ? { x: Number(xmlAttr(chOff, null, "x", "0")), y: Number(xmlAttr(chOff, null, "y", "0")) } : null,
    chExtEmu: chExt ? { w: Number(xmlAttr(chExt, null, "cx", "0")), h: Number(xmlAttr(chExt, null, "cy", "0")) } : null,
  };
}

/**
 * Pure function. Parse an `<a:avLst>` (adjustment-value list) into a plain
 * `{gdName: numericValue}` map — each `<a:gd name="adj" fmla="val 30346"/>`'s
 * `fmla` is `"val <number>"` for a literal adjustment (the only form a
 * PRESET's own avLst uses; the general guide-formula grammar with references
 * to other guides is a custGeom-only concept, handled separately by
 * parseGuideList for gdLst).
 *
 * @param {object|null} avLstNode
 * @returns {Record<string, number>}
 *
 * @example parseAdjustmentList(parseXml('<a:avLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:gd name="adj" fmla="val 30346"/></a:avLst>')) // {"adj": 30346}
 * @example parseAdjustmentList(null) // {}
 */
export function parseAdjustmentList(avLstNode) {
  if (!avLstNode) return {};
  const out = {};
  for (const gd of xmlChildren(avLstNode, A, "gd")) {
    const name = xmlAttr(gd, null, "name");
    const fmla = xmlAttr(gd, null, "fmla", "");
    const m = /^val\s+(-?\d+)$/.exec(fmla.trim());
    out[name] = m ? Number(m[1]) : fmla; // non-"val N" formulas (rare on preset avLst) kept as the raw string, refusal territory for the geometry module, not this one
  }
  return out;
}

/** One path-command IR entry from a `<a:pathLst>/<a:path>`. Coordinates are
 * kept in the PATH's own local units (its `<a:path w h>` attributes define
 * that local space — NOT slide EMU), per research_01 §1.4. */
const PATH_COMMAND_ELEMENTS = { moveTo: "moveTo", lnTo: "lnTo", cubicBezTo: "cubicBezTo", quadBezTo: "quadBezTo", arcTo: "arcTo", close: "close" };

function parsePathPoint(ptNode) {
  return { x: Number(xmlAttr(ptNode, null, "x", "0")), y: Number(xmlAttr(ptNode, null, "y", "0")) };
}

/**
 * Pure function. Parse one `<a:path>` element (a member of `<a:pathLst>`)
 * into `{w, h, fill, stroke, extrusionOk, commands}` — `w`/`h` are the path's
 * OWN local coordinate-space bounds (research_01 §1.4's "each path having its
 * own local w/h coordinate space distinct from the shape's own bounding
 * box"), `commands` a plain-data list of `{type, points}` (points in that
 * local space) plus `arcTo`'s angle attributes and `close`'s empty points.
 *
 * @param {object} pathNode - an `<a:path>` element
 * @returns {{w: number, h: number, fill: string, stroke: boolean, commands: object[]}}
 *
 * @example
 * >>> const p = parseXml('<a:path xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" w="100" h="50"><a:moveTo><a:pt x="0" y="50"/></a:moveTo><a:lnTo><a:pt x="0" y="0"/></a:lnTo><a:close/></a:path>');
 * >>> parseCustGeomPath(p).commands
 * [{"type": "moveTo", "points": [{"x": 0, "y": 50}]}, {"type": "lnTo", "points": [{"x": 0, "y": 0}]}, {"type": "close", "points": []}]
 */
export function parseCustGeomPath(pathNode) {
  const commands = [];
  for (const child of pathNode.children) {
    if (child.type !== "element" || child.ns !== A) continue;
    const kind = PATH_COMMAND_ELEMENTS[child.local];
    if (!kind) continue; // unrecognized path-command element — geometry module's concern to refuse, not this reader's to guess at
    if (kind === "close") { commands.push({ type: "close", points: [] }); continue; }
    if (kind === "arcTo") {
      commands.push({
        type: "arcTo",
        points: [],
        wR: Number(xmlAttr(child, null, "wR", "0")),
        hR: Number(xmlAttr(child, null, "hR", "0")),
        stAng60k: Number(xmlAttr(child, null, "stAng", "0")),
        swAng60k: Number(xmlAttr(child, null, "swAng", "0")),
      });
      continue;
    }
    commands.push({ type: kind, points: xmlChildren(child, A, "pt").map(parsePathPoint) });
  }
  return {
    w: Number(xmlAttr(pathNode, null, "w", "0")),
    h: Number(xmlAttr(pathNode, null, "h", "0")),
    fill: xmlAttr(pathNode, null, "fill", "norm"),
    stroke: xmlAttr(pathNode, null, "stroke", "1") !== "0",
    commands,
  };
}

/**
 * Pure function. Parse a `<a:custGeom>` element into the custGeom path-list
 * IR: `{adjustments, paths}` — `adjustments` from its OWN `<a:avLst>`
 * (custGeom can carry adjustment guides too, distinct from a preset's), and
 * `paths` = every `<a:pathLst>/<a:path>` via parseCustGeomPath. The
 * `<a:gdLst>`/`<a:ahLst>`/`<a:cxnLst>`/`<a:rect>` machinery (guide formulas,
 * adjustment handles, connection sites, the text-inset rect) is recorded
 * separately as `guides`/raw XML string where present, since it participates
 * in the geometry MODULE's resolution, not this reader's — a caller that
 * doesn't need it (this parser doesn't evaluate guide formulas) still gets it
 * verbatim rather than silently losing it.
 *
 * @param {object} custGeomNode
 * @returns {{adjustments: Record<string,number>, paths: object[]}}
 */
export function parseCustGeom(custGeomNode) {
  const avLst = xmlChild(custGeomNode, A, "avLst");
  const pathLst = xmlChild(custGeomNode, A, "pathLst");
  const paths = pathLst ? xmlChildren(pathLst, A, "path").map(parseCustGeomPath) : [];
  return { adjustments: parseAdjustmentList(avLst), paths };
}

/**
 * Pure function. The shape's geometry REFERENCE (never a resolved outline —
 * see this file's header): `<a:prstGeom>` -> `{preset: {name, adjustments}}`,
 * `<a:custGeom>` -> `{custGeom: {...}}`, neither present -> `null` (legal —
 * e.g. a `p:pic` commonly has no explicit geometry, implying `rect`; the
 * translator stage decides the implied-rect default, this parser just
 * reports what's literally there).
 *
 * @param {object} spPrNode - a shape's `<p:spPr>` (or `<p:grpSpPr>`)
 * @returns {{preset: {name: string, adjustments: object}}|{custGeom: object}|null}
 *
 * @example parseGeometryRef(parseXml('<p:spPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 30346"/></a:avLst></a:prstGeom></p:spPr>')) // {"preset": {"name": "roundRect", "adjustments": {"adj": 30346}}}
 */
export function parseGeometryRef(spPrNode) {
  const prstGeom = xmlChild(spPrNode, A, "prstGeom");
  if (prstGeom) return { preset: { name: xmlAttr(prstGeom, null, "prst", ""), adjustments: parseAdjustmentList(xmlChild(prstGeom, A, "avLst")) } };
  const custGeom = xmlChild(spPrNode, A, "custGeom");
  if (custGeom) return { custGeom: parseCustGeom(custGeom) };
  return null;
}

/**
 * Pure function. Parse a shape's fill from its `<p:spPr>` into an unresolved
 * descriptor. Recognizes `noFill`, `solidFill` (delegates to
 * text.readColorNode), and reports `gradFill`/`blipFill`/`pattFill`/`grpFill`
 * by KIND with their raw child untouched — this parser does not resolve
 * gradient stops/picture-fill/pattern details (that is downstream work); it
 * only distinguishes "there IS a fill, of this kind" so a caller can decide
 * whether to refusal-list it. Absent fill (no fill element at all — the shape
 * inherits fill from its style/theme) returns `null`.
 *
 * @param {object} spPrNode
 * @returns {{kind: "none"}|{kind: "solid", color: object}|{kind: "gradient"|"picture"|"pattern"|"group", raw: object}|null}
 *
 * @example parseFill(parseXml('<p:spPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:noFill/></p:spPr>')) // {"kind": "none"}
 * @example parseFill(parseXml('<p:spPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>')).kind // "solid"
 */
export function parseFill(spPrNode) {
  if (xmlChild(spPrNode, A, "noFill")) return { kind: "none" };
  const solid = xmlChild(spPrNode, A, "solidFill");
  if (solid) return { kind: "solid", color: readColorNode(solid) };
  const grad = xmlChild(spPrNode, A, "gradFill");
  if (grad) return { kind: "gradient", raw: grad };
  const blip = xmlChild(spPrNode, A, "blipFill");
  if (blip) return { kind: "picture", raw: blip };
  const patt = xmlChild(spPrNode, A, "pattFill");
  if (patt) return { kind: "pattern", raw: patt };
  const grpFill = xmlChild(spPrNode, A, "grpFill");
  if (grpFill) return { kind: "group", raw: grpFill };
  return null;
}

/**
 * Pure function. Parse a shape's line/stroke (`<a:ln>`) into
 * `{widthEmu, fill, dash, cap, compound}`, or `null` if `<a:ln>` is absent
 * (inherits from style/theme — not this parser's job to resolve).
 *
 * @param {object} spPrNode
 * @returns {{widthEmu: number, fill: object|null, dash: string|null, cap: string|null, compound: string|null}|null}
 *
 * @example
 * >>> const spPr = parseXml('<p:spPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:ln w="88900"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>');
 * >>> parseLine(spPr).widthEmu
 * 88900
 */
export function parseLine(spPrNode) {
  const ln = xmlChild(spPrNode, A, "ln");
  if (!ln) return null;
  const fill = parseFill(ln);
  const dashNode = xmlChild(ln, A, "prstDash");
  return {
    widthEmu: Number(xmlAttr(ln, null, "w", "0")),
    fill,
    dash: dashNode ? xmlAttr(dashNode, null, "val", "solid") : null,
    cap: xmlAttr(ln, null, "cap", null),
    compound: xmlAttr(ln, null, "cmpd", null),
  };
}

/**
 * Pure function. Parse a shape's `<a:effectLst>` into a RAW list of
 * `{type, node}` entries (shadow/glow/reflection/softEdge/blur/…) — per the
 * task spec ("effects (shadow raw)"), this module does not interpret effect
 * parameters (blur radius units, angle conventions), it preserves the element
 * so a later stage can. `type` is the effect element's local name
 * (`outerShdw`, `innerShdw`, `glow`, `reflection`, `softEdge`, `blur`) so a
 * caller can filter without re-parsing.
 *
 * @param {object} spPrNode
 * @returns {{type: string, node: object}[]}
 *
 * @example parseEffects(parseXml('<p:spPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:effectLst><a:outerShdw blurRad="1"/></a:effectLst></p:spPr>')).map(e=>e.type) // ["outerShdw"]
 * @example parseEffects(parseXml('<p:spPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>')) // []
 */
export function parseEffects(spPrNode) {
  const effectLst = xmlChild(spPrNode, A, "effectLst");
  if (!effectLst) return [];
  return effectLst.children.filter((c) => c.type === "element" && c.ns === A).map((c) => ({ type: c.local, node: c }));
}

/**
 * Pure function. The shape's `<p:nvPr>` element, wherever it lives for this
 * shape kind (`p:nvSpPr/p:nvPr` for sp, `p:nvPicPr/p:nvPr` for pic,
 * `p:nvGrpSpPr/p:nvPr` for grpSp, `p:nvCxnSpPr/p:nvPr` for cxnSp,
 * `p:nvGraphicFramePr/p:nvPr` for graphicFrame) — one lookup so callers don't
 * each re-derive the wrapper tag name per shape kind.
 *
 * @param {object} shapeNode - a `p:sp`/`p:pic`/`p:grpSp`/`p:cxnSp`/`p:graphicFrame` element
 * @param {string} type - one of SHAPE_ELEMENT_TYPES' values
 * @returns {object|null}
 */
function nvPrFor(shapeNode, type) {
  const wrapperTag = { sp: "nvSpPr", pic: "nvPicPr", grpSp: "nvGrpSpPr", cxnSp: "nvCxnSpPr", graphicFrame: "nvGraphicFramePr" }[type];
  const wrapper = xmlChild(shapeNode, P, wrapperTag);
  return wrapper ? xmlChild(wrapper, P, "nvPr") : null;
}

/**
 * Pure function. The shape's non-visual identity: `{id, name, hidden}` from
 * `<p:cNvPr id name hidden?>`, present identically across every shape kind's
 * non-visual-properties wrapper.
 *
 * @param {object} shapeNode
 * @param {string} type
 * @returns {{id: number, name: string, hidden: boolean}}
 */
function shapeIdentity(shapeNode, type) {
  const wrapperTag = { sp: "nvSpPr", pic: "nvPicPr", grpSp: "nvGrpSpPr", cxnSp: "nvCxnSpPr", graphicFrame: "nvGraphicFramePr" }[type];
  const wrapper = xmlChild(shapeNode, P, wrapperTag);
  const cNvPr = wrapper ? xmlChild(wrapper, P, "cNvPr") : null;
  if (!cNvPr) throw new Error(`shape of type "${type}" has no <p:cNvPr> — malformed slide XML`);
  return {
    id: Number(xmlAttr(cNvPr, null, "id", "0")),
    name: xmlAttr(cNvPr, null, "name", ""),
    hidden: xmlAttr(cNvPr, null, "hidden", "0") === "1",
  };
}

/**
 * Pure function (given its already-resolved inheritance context — see
 * buildShapeInheritance below for how `inheritance` is built once per slide).
 * Parse ONE shape tree node (recursing into `p:grpSp` children) into ShapeIR,
 * per this file's header. `refusals` accumulates `{where, what, sentence}`
 * entries for anything genuinely unhandled (an unrecognized top-level element
 * kind, `graphicFrame` content since tables/charts/SmartArt are out of scope
 * for this parser) — appended to the array passed in, never thrown, per this
 * project's "parse what you can, report every gap" deviation (documented in
 * deck.js).
 *
 * @param {object} node - a `p:sp`/`p:pic`/`p:grpSp`/`p:cxnSp`/`p:graphicFrame` element
 * @param {{slideIndex: number}} context - for refusal messages
 * @param {{
 *   layoutIndex: {byIdx: Map, byType: Map},
 *   masterIndex: {byIdx: Map, byType: Map},
 *   txStyles: object|null,
 *   colorMap: Record<string,string>,
 *   colorScheme: Record<string,string>,
 *   fontScheme: object,
 * }} inheritance - the slide's resolved layout/master/theme context (inherit.buildInheritanceContext + theme.loadTheme)
 * @param {object[]} refusals - mutated: pushed to on unhandled content
 * @returns {object|null} ShapeIR, or null if this element is not a recognized shape kind (pushed to refusals instead)
 */
export function parseShapeNode(node, context, inheritance, refusals) {
  const type = SHAPE_ELEMENT_TYPES[node.local];
  if (!type || node.ns !== P) {
    refusals.push({ where: `slide ${context.slideIndex}`, what: `<${node.name}>`, sentence: `Unrecognized shape-tree element "<${node.local}>" — expected one of ${Object.keys(SHAPE_ELEMENT_TYPES).join(", ")}. It was skipped; if it carries visible content, this slide will render incomplete.` });
    return null;
  }
  const identity = shapeIdentity(node, type);
  const nvPr = nvPrFor(node, type);
  const phKey = nvPr ? placeholderKey(nvPr) : null;

  if (type === "graphicFrame") {
    refusals.push({ where: `slide ${context.slideIndex}, shape "${identity.name}" (id ${identity.id})`, what: "p:graphicFrame", sentence: "graphicFrame content (table/chart/SmartArt/OLE) is not parsed by this importer — the shape's position is recorded but its content is empty. Extend core/pptx/shapes.js's graphicFrame handling if this deck relies on one." });
  }

  if (type === "grpSp") {
    const grpSpPr = xmlChild(node, P, "grpSpPr");
    const xfrm = grpSpPr ? parseXfrm(xmlChild(grpSpPr, A, "xfrm")) : null;
    const children = node.children
      .filter((c) => c.type === "element" && c.local !== "grpSpPr" && c.local !== "nvGrpSpPr")
      .map((c) => parseShapeNode(c, context, inheritance, refusals))
      .filter(Boolean);
    return { id: identity.id, name: identity.name, hidden: identity.hidden, type, xfrm, placeholder: phKey, children };
  }

  const spPr = xmlChild(node, P, "spPr");
  const xfrm = spPr ? parseXfrm(xmlChild(spPr, A, "xfrm")) : null;
  const geometry = spPr ? parseGeometryRef(spPr) : null;
  const fill = spPr ? parseFill(spPr) : null;
  const line = spPr ? parseLine(spPr) : null;
  const effects = spPr ? parseEffects(spPr) : [];

  let text = null;
  if (type === "sp") {
    const txBody = xmlChild(node, P, "txBody");
    if (txBody) {
      const layoutShapeNode = phKey ? resolveLayoutPlaceholder(phKey, inheritance.layoutIndex) : null;
      const masterKey = phKey ?? { type: "body", idx: null }; // a non-placeholder textbox still resolves against otherStyle via txStylesBucketFor's default branch
      const masterShapeNode = phKey ? resolveMasterPlaceholder(masterKey, inheritance.masterIndex) : null;
      text = resolveTextBody(txBody, phKey, layoutShapeNode, masterShapeNode, inheritance.txStyles, inheritance.colorMap, inheritance.colorScheme, inheritance.fontScheme);
    }
  }

  return {
    id: identity.id, name: identity.name, hidden: identity.hidden, type,
    xfrm, geometry, fill, line, effects, text,
    placeholder: phKey,
    node, // the raw XML element — media.js reads p:pic-specific children off this; deck.js strips it before emitting DeckIR JSON
  };
}

/**
 * Pure function. Parse a slide's `<p:cSld><p:spTree>` into a top-level
 * ShapeIR array (each entry a full recursive tree per parseShapeNode).
 *
 * @param {object} slideRoot - parseXml() result of a slideN.xml part
 * @param {{slideIndex: number}} context
 * @param {object} inheritance
 * @param {object[]} refusals
 * @returns {object[]}
 */
export function parseSlideShapes(slideRoot, context, inheritance, refusals) {
  const cSld = xmlChild(slideRoot, P, "cSld");
  if (!cSld) throw new Error(`slide ${context.slideIndex} has no <p:cSld> — not a valid slide part`);
  const spTree = xmlChild(cSld, P, "spTree");
  if (!spTree) throw new Error(`slide ${context.slideIndex} has no <p:spTree> — not a valid slide part`);
  return spTree.children
    .filter((c) => c.type === "element" && !(c.ns === P && (c.local === "nvGrpSpPr" || c.local === "grpSpPr")))
    .map((c) => parseShapeNode(c, context, inheritance, refusals))
    .filter(Boolean);
}
