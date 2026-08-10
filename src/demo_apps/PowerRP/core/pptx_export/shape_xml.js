/**
 * ONE ITEM -> ONE (OR MORE) <p:sp>/<p:pic> ELEMENTS. The per-widget-type
 * dispatch table export.js walks a slide's z-sorted render-tree nodes
 * through. Mirrors this app's own plugin-registry shape (a declarative
 * lookup by `type`, never a giant if/else chain) so a THIRD widget type gains
 * export support by adding one table entry, per the importer's own
 * extensibility law (core/pptx/deck.js's "refusals... first-class output").
 *
 * v1 SCOPE (task spec): rect/box family, ellipse/circle, text/plaintext,
 * image (+media part), polygon (custGeom). Every OTHER widget type falls
 * through to `placeholderShapeXml` — a plain rect carrying the item's own
 * name/size/position, so the deck's LAYOUT survives even where its exact
 * picture cannot, plus a REPORT line (this app's "loud, never silent" rule,
 * the same one core/pptx/deck.js's `refusals` applies on the read side).
 */

import { xfrmXml, nodeXfrmEmu } from "./xfrm_xml.js";
import { rectPrstGeomXml, ellipsePrstGeomXml, polygonCustGeomXml } from "./geometry_xml.js";
import { fillXml, solidFillXml } from "./paint_xml.js";
import { textBodyXml } from "./text_xml.js";
import { morphShapeName } from "./shape_identity.js";
import { tag, xmlEscape } from "./xml_writer.js";
import { decodeImageSrc } from "./media_parts.js";
import { pxToEmu } from "./units.js";

/** `<p:nvSpPr>` shared by every plain-shape (`p:sp`) builder: forced-morph
 * name (shape_identity.js) + a fresh numeric id (OOXML requires each shape's
 * `cNvPr id` unique WITHIN ITS SLIDE — deck-wide item-id uniqueness is a
 * PowerRP invariant, not an OOXML one, so `spId` is a per-slide counter the
 * caller threads, never the item's own uuid). */
function nvSpPrXml(spId, itemId, itemName) {
  const cNvPr = tag("p:cNvPr", { id: spId, name: morphShapeName(itemId), descr: itemName || null });
  return tag("p:nvSpPr", {}, cNvPr + tag("p:cNvSpPr") + tag("p:nvPr"));
}

/**
 * Pure function. `<a:ln>` for a stroke (width>0) or "" (no stroke element —
 * OOXML's own "absent means no visible line" convention).
 */
function lineXml(stroke, strokeWidthPx, where, report) {
  if (!(strokeWidthPx > 0) || !stroke) return "";
  return tag("a:ln", { w: pxToEmu(strokeWidthPx) }, fillXml(stroke, where, report));
}

/** rect / roundRect (cornerRadius>0) -> <p:sp prstGeom="rect|roundRect">. */
function rectShapeXml(node, spId, report) {
  const s = node.state;
  const where = `shape "${s.name || node.id}"`;
  const geom = rectPrstGeomXml(s.w ?? 0, s.h ?? 0, s.cornerRadius ?? 0);
  const spPr = xfrmXml(node) + geom + fillXml(s.fill, where, report) + lineXml(s.stroke, s.strokeWidth, where, report);
  return tag("p:sp", {}, nvSpPrXml(spId, node.itemId, s.name) + tag("p:spPr", {}, spPr));
}

/** circle/ellipse -> <p:sp prstGeom="ellipse">. */
function ellipseShapeXml(node, spId, report) {
  const s = node.state;
  const where = `shape "${s.name || node.id}"`;
  const spPr = xfrmXml(node) + ellipsePrstGeomXml() + fillXml(s.fill, where, report) + lineXml(s.stroke, s.strokeWidth, where, report);
  return tag("p:sp", {}, nvSpPrXml(spId, node.itemId, s.name) + tag("p:spPr", {}, spPr));
}

/** polygon (straight-edge point list, box-fraction coords) -> <p:sp custGeom>. */
function polygonShapeXml(node, spId, report) {
  const s = node.state;
  const where = `shape "${s.name || node.id}"`;
  const { extEmu } = nodeXfrmEmu(node);
  const points = Array.isArray(s.points) ? s.points : [];
  const geom = polygonCustGeomXml(points, !!s.closed, extEmu.w, extEmu.h);
  const fill = s.closed ? fillXml(s.fill, where, report) : "";
  const spPr = xfrmXml(node) + geom + fill + lineXml(s.stroke, s.strokeWidth, where, report);
  return tag("p:sp", {}, nvSpPrXml(spId, node.itemId, s.name) + tag("p:spPr", {}, spPr));
}

/** text/plaintext -> <p:sp> with a real <p:txBody>, no fill/line by default
 * (a text box is transparent unless the widget itself paints a background,
 * which text/plaintext do not declare — matching plugins/text.js's own
 * behavior of drawing glyphs only, no box chrome).
 *
 * `plaintext`'s own state names its text color `fill` (plugins/plaintext.js
 * emit(): `color: s.fill ?? "#000000"`), NOT `color` the way `text` does —
 * textBodyXml reads `state.color`, so this normalizes that ONE field name
 * difference at the call site rather than teaching text_xml.js both widgets'
 * private spellings. */
function textShapeXml(node, spId, report) {
  const s = node.state;
  const spPr = xfrmXml(node) + rectPrstGeomXml(s.w ?? 0, s.h ?? 0, 0) + tag("a:noFill");
  const textState = node.type === "plaintext" ? { ...s, color: s.fill ?? s.color } : s;
  const txBody = textBodyXml(textState);
  return tag("p:sp", {}, nvSpPrXml(spId, node.itemId, s.name) + tag("p:spPr", {}, spPr) + txBody);
}

/**
 * image -> <p:pic> + a per-slide relationship pointing at a DECK-WIDE-DEDUPED
 * media part. Returns `{xml, media}` where `media` is
 * `{relId, deckFileName} | null` (null when the src cannot be embedded —
 * decodeImageSrc's own contract — in which case a placeholder rect is emitted
 * instead and the caller's report gets a line).
 *
 * `deckMedia` is `Map<src, {deckFileName, ext, bytes}>`, owned by export.js
 * and shared across EVERY slide's call: the same item persisting across
 * multiple slides (this app's "symlink" model) — or two different items that
 * happen to share one copy-pasted `src` — must embed its bytes exactly ONCE.
 * `nextMediaRelId` still mints a FRESH id every call regardless of dedup,
 * because a relationship id is scoped to the SLIDE part declaring it, not to
 * the underlying media (two slides referencing the same image each need
 * their own local rIdN pointing at the one shared media part).
 */
function imageShapeXml(node, spId, nextMediaRelId, deckMedia, report) {
  const s = node.state;
  const where = `shape "${s.name || node.id}"`;
  let entry = deckMedia.get(s.src);
  if (!entry) {
    const decoded = decodeImageSrc(s.src);
    if (!decoded) {
      report.push(`${where}: image src is not an embeddable data: URI (a bare URL/asset reference this offline exporter cannot fetch) — downgraded to a placeholder rect`);
      return { xml: placeholderShapeXml(node, spId, "image (unembeddable src)"), media: null };
    }
    entry = { deckFileName: `image${deckMedia.size + 1}.${decoded.ext}`, ext: decoded.ext, bytes: decoded.bytes };
    deckMedia.set(s.src, entry);
  }
  const relId = nextMediaRelId();
  const spPr = xfrmXml(node) + rectPrstGeomXml(s.w ?? 0, s.h ?? 0, s.cornerRadius ?? 0) + lineXml(s.stroke, s.strokeWidth, where, report);
  const nvPicPr = tag("p:nvPicPr", {}, tag("p:cNvPr", { id: spId, name: morphShapeName(node.itemId) }) + tag("p:cNvPicPr") + tag("p:nvPr"));
  const blipFill = tag("p:blipFill", {}, tag("a:blip", { "r:embed": relId }) + tag("a:stretch", {}, tag("a:fillRect")));
  const xml = tag("p:pic", {}, nvPicPr + blipFill + tag("p:spPr", {}, spPr));
  return { xml, media: { relId, deckFileName: entry.deckFileName } };
}

/**
 * Pure function (well, generates a report line, but writes nothing itself —
 * export.js's caller owns pushing to the shared report array). A plain rect
 * carrying the item's own box + a text label naming both the item and its
 * PowerRP type — the "layout survives even where the picture cannot" fallback
 * every unsupported widget type falls through to.
 *
 * @param {object} node
 * @param {number} spId
 * @param {string} typeLabel
 * @returns {string}
 */
export function placeholderShapeXml(node, spId, typeLabel) {
  const s = node.state;
  const label = s.name || `${typeLabel} (${node.itemId.slice(0, 4)})`;
  const spPr = xfrmXml(node) + rectPrstGeomXml(s.w ?? 0, s.h ?? 0, 0) + solidFillXml("#cccccc") + tag("a:ln", { w: 12700 }, solidFillXml("#888888"));
  const txBody = tag(
    "p:txBody",
    {},
    tag("a:bodyPr", { wrap: "square", anchor: "ctr" }) +
      tag("a:lstStyle") +
      tag("a:p", {}, tag("a:pPr", { algn: "ctr" }) + tag("a:r", {}, tag("a:rPr", { sz: 1200, lang: "en-US" }, tag("a:solidFill", {}, '<a:srgbClr val="333333"/>')) + tag("a:t", {}, xmlEscape(label)))),
  );
  return tag("p:sp", {}, nvSpPrXml(spId, node.itemId, label) + tag("p:spPr", {}, spPr) + txBody);
}

/** The v1 dispatch table: PowerRP widget `type` -> builder. Types absent here
 * fall through to placeholderShapeXml in export.js's own walk. */
export const SHAPE_BUILDERS = {
  rect: rectShapeXml,
  circle: ellipseShapeXml,
  text: textShapeXml,
  plaintext: textShapeXml,
  polygon: polygonShapeXml,
};

/** image is handled separately (it returns a media part too, not just XML) —
 * exported by name so export.js's dispatch can special-case it without
 * SHAPE_BUILDERS' callers needing to know which entries return extra state. */
export { imageShapeXml };
