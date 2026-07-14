/**
 * VECTOR backend stub: IR → SVG string.
 *
 * Proves the seam: the same flattened display list the WebGPU compositor
 * rasterizes serializes losslessly to vector primitives. PDF export follows
 * the same shape (walk flattened commands, emit PDF content-stream operators
 * from the IR DIRECTLY — not by converting this SVG).
 *
 * The `view` is the same camera mapping every backend uses (fitRectView
 * output): world → output px via  out = world * zoom + pan.  dpr is 1 for
 * vector output (vectors have no device pixels).
 *
 * STUB SCOPE (documented, loud where unfinished):
 *   rect / ellipse / polyline / polygon / text  — fully serialized
 *   image / video — placeholder <rect> + comment (real impl: <image href>,
 *                   poster frame for video)
 *   blurBackdrop / magnifyBackdrop — SKIPPED with an SVG comment; the vector
 *                   story for backdrop effects is an <feGaussianBlur> filter
 *                   over a group of the preceding commands (blur) and a
 *                   <clipPath>-ed re-render of the sub-list (magnifier —
 *                   trivially expressible because the IR is re-interpretable)
 *
 * DOM-free pure JS (string building only; bare-node testable).
 */

import { flattenIR, parseColor, rgbaToCss } from "./ir.js";

/**
 * Pure function. Escapes text for XML content.
 *
 * @example xmlEscape("a<b&c") // "a&lt;b&amp;c"
 */
export function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Pure function. A similarity transform + camera view → SVG transform attr.
 * Output-space = ((world ∘ local) * zoom + pan); SVG composes right-to-left,
 * so: translate(pan) scale(zoom) translate(x,y) rotate(deg) scale(s).
 *
 * @example svgTransform({x: 10, y: 0, rotation: 0, scale: 2}, {zoom: 1, panX: 0, panY: 0}) // "translate(10 0) scale(2)"
 * @example svgTransform({x: 0, y: 0, rotation: 0, scale: 1}, {zoom: 2, panX: 5, panY: 0}) // "translate(5 0) scale(2)"
 */
export function svgTransform(world, view) {
  const parts = [];
  if (view.panX !== 0 || view.panY !== 0) parts.push(`translate(${fmt(view.panX)} ${fmt(view.panY)})`);
  if (view.zoom !== 1) parts.push(`scale(${fmt(view.zoom)})`);
  if (world.x !== 0 || world.y !== 0) parts.push(`translate(${fmt(world.x)} ${fmt(world.y)})`);
  if (world.rotation !== 0) parts.push(`rotate(${fmt((world.rotation * 180) / Math.PI)})`);
  if (world.scale !== 1) parts.push(`scale(${fmt(world.scale)})`);
  return parts.join(" ");
}

/** Pure function. Compact number formatting for SVG attrs.
 * @example fmt(1.230000001) // "1.23"
 */
export function fmt(n) {
  return String(+n.toFixed(4));
}

/** Pure function. fill/stroke/opacity attrs shared by shape serializers.
 * @example paintAttrs({fill: [1, 0, 0, 1], stroke: null, strokeWidth: 0, opacity: 1}) // 'fill="rgba(255,0,0,1)"'
 */
export function paintAttrs(cmd) {
  const a = [];
  a.push(cmd.fill ? `fill="${rgbaToCss(cmd.fill)}"` : `fill="none"`);
  if (cmd.stroke && cmd.strokeWidth > 0)
    a.push(`stroke="${rgbaToCss(cmd.stroke)}" stroke-width="${fmt(cmd.strokeWidth)}"`);
  if ((cmd.opacity ?? 1) !== 1) a.push(`opacity="${fmt(cmd.opacity)}"`);
  return a.join(" ");
}

/**
 * Pure function. Serializes one flattened command to an SVG fragment.
 * Unknown ops throw (a backend must never silently drop geometry).
 */
export function commandToSVG({ cmd, world }, view) {
  const g = (inner) => {
    const t = svgTransform(world, view);
    return t ? `<g transform="${t}">${inner}</g>` : inner;
  };
  switch (cmd.op) {
    case "rect":
      return g(`<rect x="${fmt(cmd.x)}" y="${fmt(cmd.y)}" width="${fmt(cmd.w)}" height="${fmt(cmd.h)}"` +
        (cmd.cornerRadius > 0 ? ` rx="${fmt(cmd.cornerRadius)}"` : "") + ` ${paintAttrs(cmd)}/>`);
    case "ellipse":
      return g(`<ellipse cx="${fmt(cmd.cx)}" cy="${fmt(cmd.cy)}" rx="${fmt(cmd.rx)}" ry="${fmt(cmd.ry)}" ${paintAttrs(cmd)}/>`);
    case "polyline":
      return g(`<polyline points="${cmd.points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}" fill="none" ` +
        `stroke="${rgbaToCss(cmd.color)}" stroke-width="${fmt(cmd.width)}" stroke-linecap="round" stroke-linejoin="round"` +
        ((cmd.opacity ?? 1) !== 1 ? ` opacity="${fmt(cmd.opacity)}"` : "") + `/>`);
    case "polygon":
      return g(`<polygon points="${cmd.points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}" ` +
        `fill="${rgbaToCss(cmd.fill)}"` + ((cmd.opacity ?? 1) !== 1 ? ` opacity="${fmt(cmd.opacity)}"` : "") + `/>`);
    case "text":
      // dominant-baseline can't express canvas's textBaseline="top" portably;
      // dy≈0.8em approximates ascent (real impl: measured font metrics).
      return g(`<text x="${fmt(cmd.x)}" y="${fmt(cmd.y)}" dy="0.8em" font-size="${fmt(cmd.size)}"` +
        ` font-family="system-ui, sans-serif"` + (cmd.bold ? ` font-weight="bold"` : "") +
        ` fill="${rgbaToCss(cmd.color)}"` + ((cmd.opacity ?? 1) !== 1 ? ` opacity="${fmt(cmd.opacity)}"` : "") +
        `>${xmlEscape(cmd.text)}</text>`);
    case "image":
    case "video":
      return g(`<!-- ${cmd.op} ref=${xmlEscape(cmd.ref)} (stub: real impl embeds href/poster) -->` +
        `<rect x="${fmt(cmd.x)}" y="${fmt(cmd.y)}" width="${fmt(cmd.w)}" height="${fmt(cmd.h)}" fill="#888888"/>`);
    case "blurBackdrop":
      return `<!-- blurBackdrop radius=${fmt(cmd.radius)} (stub: feGaussianBlur over preceding group) -->`;
    case "magnifyBackdrop":
      return `<!-- magnifyBackdrop (stub: clipPath circle + re-serialized sub-list under lens view) -->`;
    default:
      throw new Error(`commandToSVG: unknown op "${cmd.op}"`);
  }
}

/**
 * Pure function. Full IR command list → standalone SVG document string.
 *
 * Args:
 *   commands (object[]): raw IR (transforms still nested)
 *   opts.width/opts.height (number): output size in px
 *   opts.view (object): {zoom, panX, panY} camera mapping (fitRectView, dpr-free)
 *   opts.background (string|number[]|null): optional page fill
 *
 * @example irToSVG([], {width: 10, height: 10, view: {zoom: 1, panX: 0, panY: 0}}).startsWith("<svg") // true
 * @example // irToSVG(sceneIR(nodes, rb), {width: 1280, height: 720, view: fitRectView(cameraRect(...), 1280, 720)}) → full document
 */
export function irToSVG(commands, { width, height, view, background = null }) {
  const body = flattenIR(commands).map((fc) => commandToSVG(fc, view));
  if (background !== null)
    body.unshift(`<rect width="${fmt(width)}" height="${fmt(height)}" fill="${rgbaToCss(parseColor(background))}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">\n` +
    body.join("\n") + `\n</svg>`;
}
