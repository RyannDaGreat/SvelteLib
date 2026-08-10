/**
 * THE MINIMAL PACKAGE SCAFFOLD — every non-slide part a .pptx needs to open
 * without PowerPoint's repair dialog (research_09 section 4's checklist:
 * [Content_Types].xml, root .rels, presentation.xml + its .rels, one theme,
 * one slideMaster, one slideLayout — "required by PowerPoint's schema even for
 * a minimal deck: a slide's layout relationship must resolve"). This module
 * builds all of them from scratch; export.js supplies only the slide count and
 * dimensions.
 *
 * DELIBERATELY MINIMAL, NOT EMPTY: research_09's repair-trigger list names
 * "phantom [Content_Types].xml Override entries — one per slide rather than
 * one per actual slide master" as a real PowerPoint-only bug in a mature
 * library (pptxgenjs#1449) — so this module registers exactly ONE Override
 * per PART THAT NEEDS ONE (each slide, the one master, the one layout, the one
 * theme, presentation.xml itself), never one per slide for a shared part, and
 * carries no unused extension Defaults / empty scaffold directories (the same
 * checklist's items 2/4/5).
 */

import { tag, xmlDocument } from "./xml_writer.js";

const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

export const CT = {
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  slideMaster: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  slideLayout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
};

export const REL_TYPE = {
  officeDocument: `${R_NS}/officeDocument`,
  slideMaster: `${R_NS}/slideMaster`,
  slideLayout: `${R_NS}/slideLayout`,
  slide: `${R_NS}/slide`,
  theme: `${R_NS}/theme`,
  image: `${R_NS}/image`,
};

/**
 * Pure function. `[Content_Types].xml` — Default extension entries for the
 * extensions actually used (rels/xml always; image extensions only when
 * `imageExtensions` names them, never a static list of unused ones per the
 * checklist) plus one Override per slide + the fixed scaffold parts.
 *
 * @param {number} slideCount
 * @param {string[]} imageExtensions - lowercase, no dot, deduped (e.g. ["png","jpeg"])
 * @returns {string}
 */
export function contentTypesXml(slideCount, imageExtensions) {
  const IMAGE_CT = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
  let defaults = tag("Default", { Extension: "rels", ContentType: "application/vnd.openxmlformats-package.relationships+xml" }) + tag("Default", { Extension: "xml", ContentType: "application/xml" });
  for (const ext of imageExtensions) {
    const ct = IMAGE_CT[ext];
    if (!ct) throw new Error(`contentTypesXml: no known content type for image extension "${ext}"`);
    defaults += tag("Default", { Extension: ext, ContentType: ct });
  }
  let overrides =
    tag("Override", { PartName: "/ppt/presentation.xml", ContentType: CT.presentation }) +
    tag("Override", { PartName: "/ppt/slideMasters/slideMaster1.xml", ContentType: CT.slideMaster }) +
    tag("Override", { PartName: "/ppt/slideLayouts/slideLayout1.xml", ContentType: CT.slideLayout }) +
    tag("Override", { PartName: "/ppt/theme/theme1.xml", ContentType: CT.theme });
  for (let i = 1; i <= slideCount; i++) overrides += tag("Override", { PartName: `/ppt/slides/slide${i}.xml`, ContentType: CT.slide });
  return xmlDocument(tag("Types", { xmlns: CT_NS }, defaults + overrides));
}

/** `_rels/.rels` — the one root relationship, to presentation.xml. */
export function rootRelsXml() {
  const rel = tag("Relationship", { Id: "rId1", Type: REL_TYPE.officeDocument, Target: "ppt/presentation.xml" });
  return xmlDocument(tag("Relationships", { xmlns: REL_NS }, rel));
}

/**
 * Pure function. `ppt/presentation.xml` — slide size (EMU) + the ordered slide
 * id list (r:id "rIdS1".."rIdS<N>", walked by export's own presentationRelsXml
 * using the SAME ids so the two never drift).
 *
 * @param {number} slideCount
 * @param {{w: number, h: number}} slideSizeEmu
 * @returns {string}
 */
export function presentationXml(slideCount, slideSizeEmu) {
  const sldIds = Array.from({ length: slideCount }, (_, i) => tag("p:sldId", { id: 256 + i, "r:id": `rIdS${i + 1}` })).join("");
  const body =
    tag("p:sldMasterIdLst", {}, tag("p:sldMasterId", { id: 2147483648, "r:id": "rIdM1" })) +
    tag("p:sldIdLst", {}, sldIds) +
    tag("p:sldSz", { cx: slideSizeEmu.w, cy: slideSizeEmu.h }) +
    tag("p:notesSz", { cx: 6858000, cy: 9144000 });
  return xmlDocument(tag("p:presentation", { "xmlns:a": A_NS, "xmlns:r": R_NS, "xmlns:p": P_NS }, body));
}

/**
 * Pure function. `ppt/_rels/presentation.xml.rels` — one relationship to the
 * master, one per slide, with r:ids MATCHING presentationXml's sldIdLst.
 *
 * @param {number} slideCount
 * @returns {string}
 */
export function presentationRelsXml(slideCount) {
  let rels = tag("Relationship", { Id: "rIdM1", Type: REL_TYPE.slideMaster, Target: "slideMasters/slideMaster1.xml" });
  for (let i = 1; i <= slideCount; i++) rels += tag("Relationship", { Id: `rIdS${i}`, Type: REL_TYPE.slide, Target: `slides/slide${i}.xml` });
  return xmlDocument(tag("Relationships", { xmlns: REL_NS }, rels));
}

/** A minimal but complete theme — one color scheme, one font scheme. Every
 * slideMaster relationship must resolve to a theme (research_09 §4), and a
 * slide's own solid/gradient fills in this exporter are always literal
 * srgbClr (never schemeClr), so the theme's actual color VALUES are cosmetic
 * — what matters is that the part exists and is well-formed. */
export function themeXml() {
  const clrScheme = tag(
    "a:clrScheme",
    { name: "PowerRP Export" },
    tag("a:dk1", {}, tag("a:sysClr", { val: "windowText", lastClr: "000000" })) +
      tag("a:lt1", {}, tag("a:sysClr", { val: "window", lastClr: "FFFFFF" })) +
      tag("a:dk2", {}, tag("a:srgbClr", { val: "1F2A44" })) +
      tag("a:lt2", {}, tag("a:srgbClr", { val: "E7E6E6" })) +
      tag("a:accent1", {}, tag("a:srgbClr", { val: "4472C4" })) +
      tag("a:accent2", {}, tag("a:srgbClr", { val: "ED7D31" })) +
      tag("a:accent3", {}, tag("a:srgbClr", { val: "A5A5A5" })) +
      tag("a:accent4", {}, tag("a:srgbClr", { val: "FFC000" })) +
      tag("a:accent5", {}, tag("a:srgbClr", { val: "5B9BD5" })) +
      tag("a:accent6", {}, tag("a:srgbClr", { val: "70AD47" })) +
      tag("a:hlink", {}, tag("a:srgbClr", { val: "0563C1" })) +
      tag("a:folHlink", {}, tag("a:srgbClr", { val: "954F72" })),
  );
  const fontScheme = tag(
    "a:fontScheme",
    { name: "PowerRP Export" },
    tag("a:majorFont", {}, tag("a:latin", { typeface: "Calibri" }) + tag("a:ea", { typeface: "" }) + tag("a:cs", { typeface: "" })) +
      tag("a:minorFont", {}, tag("a:latin", { typeface: "Calibri" }) + tag("a:ea", { typeface: "" }) + tag("a:cs", { typeface: "" })),
  );
  const themeElements = tag("a:themeElements", {}, clrScheme + fontScheme);
  return xmlDocument(tag("a:theme", { "xmlns:a": A_NS, name: "PowerRP Export" }, themeElements));
}

/** A minimal slideMaster: empty spTree (no placeholder shapes — this
 * exporter's slides never reference a placeholder, they carry every shape
 * inline), a default color map, and a layout relationship. */
export function slideMasterXml() {
  const spTree =
    tag("p:nvGrpSpPr", {}, tag("p:cNvPr", { id: 1, name: "" }) + tag("p:cNvGrpSpPr") + tag("p:nvPr")) +
    tag("p:grpSpPr", {}, tag("a:xfrm", {}, tag("a:off", { x: 0, y: 0 }) + tag("a:ext", { cx: 0, cy: 0 }) + tag("a:chOff", { x: 0, y: 0 }) + tag("a:chExt", { cx: 0, cy: 0 })));
  const cSld = tag("p:cSld", {}, tag("p:spTree", {}, spTree));
  const clrMap = tag("p:clrMap", { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2", accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6", hlink: "hlink", folHlink: "folHlink" });
  const layoutIdLst = tag("p:sldLayoutIdLst", {}, tag("p:sldLayoutId", { id: 2147483649, "r:id": "rIdL1" }));
  return xmlDocument(tag("p:sldMaster", { "xmlns:a": A_NS, "xmlns:r": R_NS, "xmlns:p": P_NS }, cSld + clrMap + layoutIdLst));
}

/** `ppt/slideMasters/_rels/slideMaster1.xml.rels` — layout + theme. */
export function slideMasterRelsXml() {
  const rels = tag("Relationship", { Id: "rIdL1", Type: REL_TYPE.slideLayout, Target: "../slideLayouts/slideLayout1.xml" }) + tag("Relationship", { Id: "rIdT1", Type: REL_TYPE.theme, Target: "../theme/theme1.xml" });
  return xmlDocument(tag("Relationships", { xmlns: REL_NS }, rels));
}

/** A minimal blank slideLayout: empty spTree, inherits the master's color map. */
export function slideLayoutXml() {
  const spTree =
    tag("p:nvGrpSpPr", {}, tag("p:cNvPr", { id: 1, name: "" }) + tag("p:cNvGrpSpPr") + tag("p:nvPr")) +
    tag("p:grpSpPr", {}, tag("a:xfrm", {}, tag("a:off", { x: 0, y: 0 }) + tag("a:ext", { cx: 0, cy: 0 }) + tag("a:chOff", { x: 0, y: 0 }) + tag("a:chExt", { cx: 0, cy: 0 })));
  const cSld = tag("p:cSld", { name: "Blank" }, tag("p:spTree", {}, spTree));
  const clrMapOvr = tag("p:clrMapOvr", {}, tag("a:masterClrMapping"));
  return xmlDocument(tag("p:sldLayout", { "xmlns:a": A_NS, "xmlns:r": R_NS, "xmlns:p": P_NS, type: "blank", preserve: "1" }, cSld + clrMapOvr));
}

/** `ppt/slideLayouts/_rels/slideLayout1.xml.rels` — points back at the master. */
export function slideLayoutRelsXml() {
  const rel = tag("Relationship", { Id: "rIdM1", Type: REL_TYPE.slideMaster, Target: "../slideMasters/slideMaster1.xml" });
  return xmlDocument(tag("Relationships", { xmlns: REL_NS }, rel));
}
