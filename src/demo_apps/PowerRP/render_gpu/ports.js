/**
 * Widget ports: plugin state → IR commands.
 *
 * Each function mirrors the corresponding plugin's paint() but EMITS the
 * display list instead of touching a ctx. In the full migration these bodies
 * replace plugin.paint (plugins gain `emit(state, env) → commands`); they live
 * here for the prototype so the live canvas2D pipeline stays untouched.
 *
 * Geometry conventions are identical to the plugins: commands are in the
 * widget's LOCAL space, and the caller wraps them in the node's world
 * transform (see sceneIR). The arrow is the exception — like arrowPlugin it
 * has no transform of its own, so its IR is world-space directly.
 *
 * DOM-free pure JS (bare-node testable).
 */

import { rect, ellipse, polyline, polygon, text, video, pushTransform, popTransform, blurBackdrop, magnifyBackdrop } from "./ir.js";
import { resolveEndpoints } from "../plugins/arrow.js";
import { lensGeom } from "../plugins/magnifier.js";

/** Arrowhead half-angle — matches arrowPlugin's hardcoded 0.44 rad flare. */
const ARROWHEAD_FLARE = 0.44;
/** Fraction of headSize the shaft stops short of the tip (arrowPlugin's 0.6). */
const SHAFT_PULLBACK = 0.6;

/**
 * Pure function. Rect widget state → IR (local space).
 *
 * @example rectIR({w: 10, h: 5, fill: "#f00", stroke: "#000", strokeWidth: 2, cornerRadius: 1})[0].op // "rect"
 * @example rectIR({w: 10, h: 5, fill: "#f00", strokeWidth: 0}).length // 1
 */
export function rectIR(s) {
  return [rect({
    x: 0, y: 0, w: s.w, h: s.h,
    cornerRadius: s.cornerRadius ?? 0,
    fill: s.fill,
    stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
    strokeWidth: s.strokeWidth ?? 0,
    opacity: s.opacity ?? 1,
  })];
}

/**
 * Pure function. Circle/ellipse widget state → IR (local space).
 *
 * @example circleIR({w: 10, h: 6, fill: "#f00", strokeWidth: 0})[0].rx // 5
 */
export function circleIR(s) {
  return [ellipse({
    cx: s.w / 2, cy: s.h / 2, rx: s.w / 2, ry: s.h / 2,
    fill: s.fill,
    stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
    strokeWidth: s.strokeWidth ?? 0,
    opacity: s.opacity ?? 1,
  })];
}

/**
 * Pure function. Arrow widget state → IR (WORLD space — arrows have no
 * transform, matching arrowPlugin). Returns [] when a bound endpoint is
 * missing on this slide (the arrow simply doesn't draw, same as the plugin).
 * Shaft = capsule polyline stopped short of the tip; head = filled triangle.
 *
 * Args:
 *   s (object): arrow state {from, to, color, width, headSize, opacity}
 *   resolveBinding (function): env.resolveBinding — (binding, towardX, towardY) → {x,y}|null
 *
 * @example arrowIR({from: {x: 0, y: 0}, to: {x: 10, y: 0}, color: "#000", width: 2, headSize: 4}, (b) => b).map((c) => c.op) // ["polyline", "polygon"]
 * @example arrowIR({from: {x: 0, y: 0}, to: {item: "gone", anchor: "cm"}, color: "#000", width: 2, headSize: 4}, () => null) // []
 */
export function arrowIR(s, resolveBinding) {
  const pts = resolveEndpoints(s, resolveBinding);
  if (!pts) return [];
  const { from, to } = pts;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = s.headSize;
  const opacity = s.opacity ?? 1;
  const shaftEnd = { x: to.x - Math.cos(angle) * head * SHAFT_PULLBACK, y: to.y - Math.sin(angle) * head * SHAFT_PULLBACK };
  return [
    polyline({ points: [[from.x, from.y], [shaftEnd.x, shaftEnd.y]], width: s.width, color: s.color, opacity }),
    polygon({
      points: [
        [to.x, to.y],
        [to.x - Math.cos(angle - ARROWHEAD_FLARE) * head, to.y - Math.sin(angle - ARROWHEAD_FLARE) * head],
        [to.x - Math.cos(angle + ARROWHEAD_FLARE) * head, to.y - Math.sin(angle + ARROWHEAD_FLARE) * head],
      ],
      fill: s.color, opacity,
    }),
  ];
}

/**
 * Pure function. Text widget state → IR (local space, top-left origin like
 * the plugin's textBaseline="top").
 *
 * @example textIR({text: "Hi", size: 36, color: "#000", bold: true})[0].bold // true
 */
export function textIR(s) {
  return [text({ text: s.text, x: 0, y: 0, size: s.size, color: s.color, bold: s.bold ?? false, opacity: s.opacity ?? 1 })];
}

/**
 * Pure function. Video widget state → IR (local space). `ref` names an entry
 * in the backend's media registry (a <video> element for raster backends).
 *
 * @example videoIR({ref: "clip1", w: 320, h: 180})[0].op // "video"
 */
export function videoIR(s) {
  return [video({ ref: s.ref, x: 0, y: 0, w: s.w, h: s.h, opacity: s.opacity ?? 1 })];
}

/**
 * Pure function. Blur-layer widget state → IR. No geometry — it blurs the
 * whole composite below its z (matching blurPlugin).
 *
 * @example blurIR({blur: 6, opacity: 0.8})[0] // {op: "blurBackdrop", radius: 6, opacity: 0.8}
 * @example blurIR({blur: 0}) // []
 */
export function blurIR(s) {
  if ((s.blur ?? 0) <= 0) return [];
  return [blurBackdrop({ radius: s.blur, opacity: s.opacity ?? 1 })];
}

/**
 * Pure function. Magnifier widget state → IR (local space; lens circle from
 * lensGeom, i.e. radius min(w,h)/2 centered in the bbox — same as the plugin).
 *
 * @example magnifierIR({x: 0, y: 0, w: 100, h: 100, magnification: 2, rimColor: "#000", rimWidth: 4})[0].r // 50
 */
export function magnifierIR(s) {
  const { cx, cy, r } = lensGeom(s);
  return [magnifyBackdrop({
    cx, cy, r,
    magnification: s.magnification,
    rimColor: (s.rimWidth ?? 0) > 0 ? s.rimColor : null,
    rimWidth: s.rimWidth ?? 0,
    opacity: s.opacity ?? 1,
  })];
}

/** emitter per widget type — sceneIR's dispatch table. */
export const EMITTERS = {
  rect: rectIR,
  circle: circleIR,
  text: textIR,
  video: videoIR,
  blur: blurIR,
  magnifier: magnifierIR,
  // arrow is special-cased in sceneIR (needs resolveBinding, world-space)
};

/**
 * Pure function. A full render tree (core/derive.js nodes, already z-sorted)
 * → one flat IR command list: each node's local IR wrapped in its world
 * transform. This is the display-list analogue of the canvas compositor's
 * per-node save/transform/paint/restore loop.
 *
 * Args:
 *   nodes (object[]): deriveRenderTree output
 *   resolveBinding (function): (binding, towardX, towardY) → {x,y}|null
 *
 * Returns:
 *   object[]: IR commands (z-ordered because nodes are)
 *
 * @example // sceneIR(deriveRenderTree(state, registry), env.resolveBinding) → [pushTransform, rect, popTransform, polyline, polygon, ...]
 * @example sceneIR([], () => null) // []
 */
export function sceneIR(nodes, resolveBinding) {
  const out = [];
  for (const node of nodes) {
    if (node.type === "arrow") {
      out.push(...arrowIR(node.state, resolveBinding)); // world-space, no wrap
      continue;
    }
    const emit = EMITTERS[node.type];
    if (!emit) throw new Error(`sceneIR: no IR emitter for widget type "${node.type}"`);
    const cmds = emit(node.state);
    if (cmds.length === 0) continue;
    out.push(pushTransform(node.world), ...cmds, popTransform());
  }
  return out;
}
