/**
 * <a:xfrm> BUILDER — world position/size/rotation/flip for one shape, shared by
 * every shape kind (sp/pic/graphicFrame all carry the same xfrm shape inside
 * their own spPr). Reads a core/derive.js render-tree NODE (world-space
 * translation/rotation/scale + the resolved LOCAL positive-w/h state + mirror
 * flags), not a raw item state — see export.js for how a node is produced
 * (deriveRenderTree already resolves negative-w/h flips via unsignedState and
 * z-sorts, so this module does no geometry of its own beyond EMU conversion).
 *
 * ── WHY OFF/EXT ARE DERIVED FROM THE WORLD-SPACE CENTER, NOT node.world.x/y ────
 * core/derive.js's worldTransform pivots a rotated item about its OWN box
 * center (core/transform.js aboutPivot), so node.world.{x,y} is where the
 * LOCAL origin (top-left, unrotated) lands in world space — NOT the same point
 * as the rotated shape's own unrotated bounding-box corner once rotation != 0.
 * OOXML's <a:xfrm> instead wants <a:off>/<a:ext> as the shape's OWN unrotated
 * bounding box (rot then applies about ITS center at render time) — which
 * happens to be exactly what PowerRP's rotation convention already assumes
 * (rotationAnchor defaults to the item's own center). So this module computes
 * the world-space CENTER via T.apply(node.world, w/2, h/2), then backs out an
 * unrotated top-left half a (scaled) box-size away in each axis — the inverse
 * of worldTransform's own pivot-about-center math, landing on the one <a:off>
 * OOXML's own rotate-about-center semantics actually wants.
 */

import * as T from "../transform.js";
import { pxToEmu, radiansToRot60k } from "./units.js";
import { tag } from "./xml_writer.js";

/**
 * Pure function. World-space EMU geometry for one render-tree node: unrotated
 * bounding-box top-left (off) + size (ext) in EMU, rotation in 60,000ths of a
 * degree, and flip flags. `node.state.w/h` are ALREADY POSITIVE (deriveRenderTree
 * ran unsignedState) and `node.mirror` (or null) carries the flip PowerRP applied
 * to reach that positive box — both fed straight to OOXML's own flipH/flipV,
 * which apply BEFORE rotation in both systems (PowerRP's normalizedBox and
 * OOXML's xfrm agree on that order).
 *
 * @param {{world: {x:number,y:number,rotation:number,scale:number}, state: {w?:number,h?:number}, mirror: {x:boolean,y:boolean}|null}} node
 * @returns {{offEmu:{x:number,y:number}, extEmu:{w:number,h:number}, rot60k:number, flipH:boolean, flipV:boolean}}
 *
 * @example nodeXfrmEmu({world:{x:0,y:0,rotation:0,scale:1}, state:{w:100,h:50}, mirror:null}) // {offEmu:{x:0,y:0}, extEmu:{w:952500,h:476250}, rot60k:0, flipH:false, flipV:false}
 */
export function nodeXfrmEmu(node) {
  const w = node.state.w ?? 0, h = node.state.h ?? 0;
  const scale = node.world.scale ?? 1;
  const worldW = scale * w, worldH = scale * h;
  const center = T.apply(node.world, w / 2, h / 2);
  return {
    offEmu: { x: pxToEmu(center.x - worldW / 2), y: pxToEmu(center.y - worldH / 2) },
    extEmu: { w: pxToEmu(worldW), h: pxToEmu(worldH) },
    rot60k: radiansToRot60k(node.world.rotation ?? 0),
    flipH: !!node.mirror?.x,
    flipV: !!node.mirror?.y,
  };
}

/**
 * Pure function. `<a:xfrm>` XML for one node — the one element every shape
 * kind's spPr embeds.
 *
 * @param {object} node - a core/derive.js render-tree node
 * @returns {string}
 */
export function xfrmXml(node) {
  const { offEmu, extEmu, rot60k, flipH, flipV } = nodeXfrmEmu(node);
  const inner = tag("a:off", { x: offEmu.x, y: offEmu.y }) + tag("a:ext", { cx: extEmu.w, cy: extEmu.h });
  return tag("a:xfrm", { rot: rot60k || null, flipH: flipH ? "1" : null, flipV: flipV ? "1" : null }, inner);
}
