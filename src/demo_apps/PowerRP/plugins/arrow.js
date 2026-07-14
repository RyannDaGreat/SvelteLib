/**
 * Arrow widget — endpoints are BINDINGS, not just points:
 *   {x, y}                       free world point
 *   {item, anchor: "tl"|...}     preset anchor on another widget
 *   {item, anchor: "closest"}    computed: nearest outline point toward the
 *                                other endpoint (two bound "closest" ends
 *                                fixpoint via one re-resolve pass)
 * The arrow has no transform of its own (world == local); if a bound item is
 * missing on the current slide the arrow simply doesn't draw that frame.
 */

export const arrowPlugin = {
  type: "arrow",
  title: "Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "arrow", z: 1,
    from: { x: 200, y: 300 }, to: { x: 420, y: 300 },
    color: "#1a1a2e", width: 3, headSize: 14, opacity: 1,
  },
  inspector: [
    { key: "color", label: "Color", kind: "color" },
    { key: "width", label: "Width", kind: "number" },
    { key: "headSize", label: "Head size", kind: "number" },
    { key: "z", label: "Z order", kind: "number" },
    { key: "opacity", label: "Opacity", kind: "number" },
  ],
  paint(ctx, s, env) {
    const pts = resolveEndpoints(s, env.resolveBinding);
    if (!pts) return;
    const { from, to } = pts;
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = s.headSize;
    // Shorten the shaft so it doesn't poke through the head tip.
    const shaftEnd = { x: to.x - Math.cos(angle) * head * 0.6, y: to.y - Math.sin(angle) * head * 0.6 };
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(shaftEnd.x, shaftEnd.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - Math.cos(angle - 0.44) * head, to.y - Math.sin(angle - 0.44) * head);
    ctx.lineTo(to.x - Math.cos(angle + 0.44) * head, to.y - Math.sin(angle + 0.44) * head);
    ctx.closePath();
    ctx.fill();
  },
  hitTestWorld(node, wx, wy, nodesById) {
    const pts = resolveEndpointsForNode(node, nodesById);
    if (!pts) return false;
    return distToSegment(wx, wy, pts.from, pts.to) <= (node.state.width ?? 3) + 5;
  },
  /**
   * Generic editable-point interface: the editor renders a draggable handle
   * per entry; dragging one writes a binding into state[key]. Any widget with
   * bindable points implements this — the UI never special-cases arrows.
   */
  editPoints(node, nodesById) {
    const pts = resolveEndpointsForNode(node, nodesById);
    if (!pts) return [];
    return [
      { key: "from", x: pts.from.x, y: pts.from.y },
      { key: "to", x: pts.to.x, y: pts.to.y },
    ];
  },
  commands: [
    { id: "add-arrow", title: "Add Arrow", icon: "mdi:arrow-top-right", run: (app) => app.addItem(arrowPlugin.defaults) },
  ],
};

/**
 * Pure function. Resolves both endpoints, handling mutual "closest" bindings
 * with a two-pass fixpoint: first pass aims at the other binding's rough
 * position (free point or bound item's transform origin), second re-aims at
 * the pass-1 results.
 */
export function resolveEndpoints(s, resolveBinding) {
  const rough = (b) => (b?.item === undefined ? b : null);
  let from = resolveBinding(s.from, rough(s.to)?.x ?? 0, rough(s.to)?.y ?? 0);
  let to = resolveBinding(s.to, from?.x ?? 0, from?.y ?? 0);
  if (!from || !to) return null;
  from = resolveBinding(s.from, to.x, to.y);
  if (!from) return null;
  return { from, to };
}

/** Pure function. resolveEndpoints when all you have is a node + nodesById. */
function resolveEndpointsForNode(node, nodesById) {
  // Local import cycle avoidance: mirror env.resolveBinding via derive.js API.
  const { resolveBinding } = nodeDeps;
  return resolveEndpoints(node.state, (b, tx, ty) => resolveBinding(b, nodesById, tx, ty));
}

// Injected once at registration time (plugins may import core, but this keeps
// derive.js from being loaded twice under mixed static/dynamic import setups).
import { resolveBinding as _resolveBinding } from "../core/derive.js";
const nodeDeps = { resolveBinding: _resolveBinding };

/**
 * Pure function. Distance from point to segment ab.
 *
 * @example distToSegment(0, 5, {x: 0, y: 0}, {x: 10, y: 0}) // 5
 * @example distToSegment(-3, 0, {x: 0, y: 0}, {x: 10, y: 0}) // 3
 */
export function distToSegment(px, py, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / len2));
  return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
}
