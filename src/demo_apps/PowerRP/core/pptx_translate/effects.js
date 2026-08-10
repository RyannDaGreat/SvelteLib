/**
 * EFFECTS — DeckIR's raw `effectLst` entries (`{type, node}`, node = the
 * UNRESOLVED `<a:outerShdw>`/etc. XML element — core/pptx/shapes.js
 * parseEffects deliberately does not interpret effect parameters) ->
 * PowerRP's `shadow` bundle (mapping spec §4, `outerShdw` DIRECT verdict).
 *
 * POLAR -> CARTESIAN: PPTX stores shadow offset as polar (`dist` = EMU
 * magnitude, `dir` = 60,000ths-of-a-degree angle) while PowerRP stores
 * cartesian (`dx`, `dy`) canvas-unit offsets — `dx = dist·cos(dir), dy =
 * dist·sin(dir)` (mapping spec §4's own formula). `blurRad` -> `shadow.blur`
 * via the same EMU->px scale as everything else. Opacity comes from the
 * shadow color's OWN alpha, not a separate field (mapping spec).
 *
 * Only `outerShdw` is translated — `innerShdw`/`glow`/`reflection`/`softEdge`
 * are reported as gaps (mapping spec: innerShadow is DIRECT but not built
 * here yet; glow/reflection are NEW-WIDGET/TWEAK-tier; deck 1 uses only
 * outerShdw, confirmed against the real deck).
 */

import { xmlAttr } from "../pptx/xml.js";
import { resolveColorHex } from "./paint.js";
import { emuToPx } from "./units.js";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";

/**
 * Pure function. `dist` (EMU) + `dir` (60,000ths of a degree, CLOCKWISE
 * from 3 o'clock, ECMA-376's own convention — matching canvas y-down, so no
 * sign flip) -> `{dx, dy}` in px.
 *
 * @param {number} distEmu
 * @param {number} dir60k
 * @returns {{dx: number, dy: number}}
 *
 * @example polarShadowOffsetPx(38100, 0) // {dx: 4, dy: 0}
 * @example polarShadowOffsetPx(0, 5400000) // {dx: 0, dy: 0} (zero distance — direction is moot)
 */
export function polarShadowOffsetPx(distEmu, dir60k) {
  const distPx = emuToPx(distEmu);
  const radians = (dir60k / 60000) * (Math.PI / 180);
  return { dx: distPx * Math.cos(radians), dy: distPx * Math.sin(radians) };
}

/**
 * Pure function. One DeckIR `{type:"outerShdw", node}` effect -> the
 * `shadow` bundle's leaves (`{dx, dy, blur, color, opacity}`), plus a
 * refusal for `algn`/scale (`sx`/`sy`) or `rotWithShape:"0"` — RASTERIZE-
 * tier edge cases per the mapping spec that this translator does not
 * attempt (PowerRP has no shadow-scale/anchor concept at all).
 *
 * @param {object} effectIR - {type: "outerShdw", node}
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @returns {{shadow: object, refusal: string|null}}
 */
export function translateOuterShadow(effectIR, colorMap, colorScheme) {
  const node = effectIR.node;
  const distEmu = Number(xmlAttr(node, null, "dist", "0"));
  const dir60k = Number(xmlAttr(node, null, "dir", "0"));
  const blurRadEmu = Number(xmlAttr(node, null, "blurRad", "0"));
  const { dx, dy } = polarShadowOffsetPx(distEmu, dir60k);

  const colorNode = node.children.find((c) => c.type === "element" && c.ns === A && (c.local === "srgbClr" || c.local === "schemeClr"));
  let color = "#000000";
  let opacity = 1;
  const refusals = [];
  if (colorNode) {
    const descriptor = colorNode.local === "srgbClr"
      ? { kind: "srgb", hex: xmlAttr(colorNode, null, "val", "000000").toUpperCase() }
      : { kind: "scheme", slot: xmlAttr(colorNode, null, "val"), transforms: [] };
    const { hex, themeUnresolved } = resolveColorHex(descriptor, colorMap, colorScheme);
    color = hex;
    if (themeUnresolved) refusals.push(`outer shadow color references an unresolved theme color — used a placeholder`);
    const alphaNode = colorNode.children.find((c) => c.type === "element" && c.ns === A && c.local === "alpha");
    if (alphaNode) opacity = Number(xmlAttr(alphaNode, null, "val", "100000")) / 100000;
  }

  const sx = xmlAttr(node, null, "sx");
  const sy = xmlAttr(node, null, "sy");
  if ((sx && sx !== "100000") || (sy && sy !== "100000")) refusals.push(`outer shadow has a non-uniform scale (sx=${sx ?? "100000"}, sy=${sy ?? "100000"}) — PowerRP's shadow has no scale concept (mapping spec: RASTERIZE-tier edge case); ignored`);
  if (xmlAttr(node, null, "rotWithShape") === "0") refusals.push(`outer shadow has rotWithShape="0" (screen-fixed direction) — PowerRP's shadow is always local-space (rotates with the shape); direction may differ once the shape is rotated`);

  return {
    shadow: { dx, dy, blur: emuToPx(blurRadEmu), color, opacity },
    refusal: refusals.length ? refusals.join("; ") : null,
  };
}

/**
 * Pure function. A ShapeIR's full `effects` list -> PowerRP `shadow` bundle
 * state (or `{}` when there is nothing this translator maps) plus every
 * gap. Only the FIRST `outerShdw` is applied — PowerRP has one shadow slot,
 * matching PowerPoint's own effect list (a shape practically never
 * authors two outer shadows).
 *
 * @param {{type:string, node:object}[]} effectsIR
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @returns {{extraState: object, refusals: string[]}}
 */
export function translateEffects(effectsIR, colorMap, colorScheme) {
  const refusals = [];
  const extraState = {};
  const outer = effectsIR.find((e) => e.type === "outerShdw");
  if (outer) {
    const { shadow, refusal } = translateOuterShadow(outer, colorMap, colorScheme);
    extraState.shadow = shadow;
    if (refusal) refusals.push(refusal);
  }
  for (const e of effectsIR) {
    if (e.type === "outerShdw") continue;
    refusals.push(`effect "${e.type}" has no translator mapping yet (mapping spec §4) — dropped`);
  }
  return { extraState, refusals };
}
