/**
 * VECTOR backend: IR → a standalone, self-contained SVG document, directly from
 * the display list (the same flattened commands the WebGPU compositor
 * rasterizes and the PDF backend serializes — manifest "RENDER MODES DECISION").
 * This is the PDF backend's SIBLING (render_gpu/pdf_backend.js): same design,
 * different syntax. Read that file's header first — every architectural choice
 * here mirrors one there, and the shared, backend-agnostic helpers
 * (balancedSlice, magnifiedView) are IMPORTED from it, not re-derived.
 *
 * THE HYBRID RULE (user, applies to SVG too — the manifest's SVG spec): every
 * op that CAN be vector IS vector; only content that must be pixelated (backdrop
 * blur) renders at pixel resolution and is embedded as a raster <image> region
 * UNDER the subsequent vector elements. The split algorithm is the SAME "split
 * at the region's LAST blurBackdrop" as pdf_backend.emitRegion (mirrored below,
 * with a comment linking the two — the split is one `flat.forEach` line, too
 * trivial to hoist into a shared helper without obscuring both backends).
 *
 * TEXT IS TEXT: real <text> elements (SELECTABLE + searchable in a viewer), in
 * the COMMITTED fonts (fonts.js) embedded as @font-face data: URIs inside
 * <defs><style> so the document is fully OFFLINE (manifest OFFLINE RULE: no
 * external refs). Per-run font/bold is honored (the IR text op is already
 * per-run-shaped — rich text drops in unchanged). `system` text uses the OS
 * system-ui stack (no committed file — the pre-fonts-task behavior).
 *
 * Coordinates: SVG user space is y-DOWN, the SAME as the world/IR space every
 * backend uses, so — unlike the PDF backend's y-flip cm — no global flip is
 * needed. The camera view maps world → output px (out = world·zoom + pan) via a
 * root <g> transform; each drawable adds its own similarity world transform.
 * The camera region IS the viewBox (1 world px = 1 SVG user unit at zoom 1).
 *
 * Effects:
 *   blurBackdrop    — cannot be vector: the region's LAST blur splits it,
 *                     everything at/below renders through the injected
 *                     `rasterize` callback (the GPU pipeline, blur applied) and
 *                     embeds as ONE <image> covering the region; above = vector.
 *   magnifyBackdrop — VECTOR lens: a <clipPath> circle + a magnify-about-center
 *                     <g transform> re-emit of the commands below the lens (the
 *                     display list is re-interpretable — the SAME trick as the
 *                     GPU supersample and the PDF Form-XObject lens). Recursion
 *                     capped at MAX_LENS_DEPTH (pdf_backend's bound); a lens
 *                     beyond it embeds as a raster region (pixelated — user OK).
 *   cropSubtree     — rounded-rect <clipPath> + re-emit of the target's OWN
 *                     content (the vector-lens precedent generalized to a
 *                     rounded rect and ONE named subtree — manifest ARCH #3).
 *   ANY OTHER op that has no SVG vector form (glassBackdrop today; any future
 *                     backdrop/effect op) — the GENERAL raster fallback
 *                     (emitRasterOpSVG, the twin of pdf_backend.emitRasterOp):
 *                     rasterize JUST that op's own region (the content it samples
 *                     + the op, through the SAME GPU compositor the editor uses)
 *                     and embed it as one <image> data URI, keeping everything
 *                     around it vector. The hybrid rule generalized from an
 *                     enumerated list to "not in SVG_VECTOR_OPS → rasterize the
 *                     component". No rasterize seam → still throws loudly.
 *
 * DOM-free: the backend builds strings only (bare-node testable, doctested).
 * All environment-specific work (GPU rasterization, image/video bytes, font
 * bytes) is injected as callbacks, exactly like irToPDF — a browser passes the
 * pixel service + fetch adapters, node tests pass stubs/fixtures.
 */

import { flattenIR, parseColor, parsePaint, rgbaToCss, isGradientPaint, opHasMaterialFill, opHasMaterialStroke, opStrokeNeedsRaster, opStrokeIsOffset, strokeInsideFraction, linearGradientRender, rect, text, pushTransform, popTransform, signedApply, isPaintableFrame, SUPERSAMPLE_DENSITY, MAX_LENS_DEPTH as LENS_DEPTH_CAP } from "./ir.js";
// THE PER-NODE EXPORT BOUNDARY (emitRegionSVG) — see render_gpu/skia/paint_skia.js
// paintNodeRun for the doctrine and core/paint_containment.js for why it exists.
import { reportOnce as reportExportFailureOnce } from "../core/report.js";
import { errorAffordanceArgs, errorMessage, describeOwner, throwMessage, ownerRunEnd, containmentBoxSize, configurationError, isConfigurationError } from "../core/paint_containment.js";
import * as T from "../core/transform.js";
import { balancedSlice, magnifiedView, imageRefs, videoRefs, textFaces, decodeDataUri, rasterOpPlaceRect, droppedRasterOnlyEffects, regionOverBackground, blendNeedsBelowRaster } from "./pdf_backend.js";
import { DEFAULT_FONT, cssFamilyFor, fontFileFor, hasEmbeddableFile } from "./fonts.js";
import { fitBox } from "../core/geometry.js";
import { DEFAULT_TEXT_SIZE } from "./skia/text_layout.js";
import { richTextDraws } from "../core/richtext.js";

/**
 * Lens re-emit recursion cap — re-exported from ir.js (the single source: the
 * SAME bound the PDF backend and the GPU/Skia compositors use). One level of true
 * vector lens re-interpretation; a lens inside a lens falls back to a raster embed.
 */
export const MAX_LENS_DEPTH = LENS_DEPTH_CAP;

/** Raster <image> px per output user-unit for hybrid regions — the shared
 * ir.js SUPERSAMPLE_DENSITY (the retina-dpr 2× precedent), so a PDF and an SVG
 * of the same scene embed equal-resolution raster regions. */
export const RASTER_SCALE = SUPERSAMPLE_DENSITY;

/**
 * Pure function. Escapes text for XML content (and, with the double-quote rule,
 * attribute values).
 *
 * @example xmlEscape("a<b&c") // "a&lt;b&amp;c"
 * @example xmlEscape(`say "hi" <b>`) // "say &quot;hi&quot; &lt;b&gt;"
 */
export function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Pure function. Compact number formatting for SVG attrs (4 decimals, trimmed).
 * @example fmt(1.230000001) // "1.23"
 * @example fmt(-0.5) // "-0.5"
 */
export function fmt(n) {
  return String(+n.toFixed(4));
}

/**
 * Pure function. A similarity transform → SVG transform attr value. SVG composes
 * transforms LEFT-to-right (the opposite reading order of PDF's cm stack), so a
 * point maps as translate(x,y)·rotate(θ)·scale(s) — read left to right, that is
 * "translate, then rotate, then scale the local geometry", which is exactly the
 * core/transform.js similarity T.apply order. Omits identity components so the
 * output stays compact and the doctests read cleanly.
 *
 * `world.signX`/`signY` (render_gpu/ir.js: the FLIP — a ±1 per-axis reflection,
 * absent = +1) fold into that trailing scale as a per-axis `scale(sx sy)`, which is
 * how SVG spells a reflection; the magnitude stays `world.scale` so a flip changes
 * only handedness. With no signs the output is byte-identical to before.
 *
 * @example similarityTransform({x: 10, y: 0, rotation: 0, scale: 2}) // "translate(10 0) scale(2)"
 * @example similarityTransform({x: 0, y: 0, rotation: Math.PI / 2, scale: 1}) // "rotate(90)"
 * @example similarityTransform({x: 0, y: 0, rotation: 0, scale: 1}) // ""
 * @example similarityTransform({x: 0, y: 0, rotation: 0, scale: 1, signX: -1}) // "scale(-1 1)"
 * @example similarityTransform({x: 0, y: 0, rotation: 0, scale: 2, signY: -1}) // "scale(2 -2)"
 */
export function similarityTransform(world) {
  const parts = [];
  const sx = world.signX ?? 1, sy = world.signY ?? 1;
  if (world.x !== 0 || world.y !== 0) parts.push(`translate(${fmt(world.x)} ${fmt(world.y)})`);
  if (world.rotation !== 0) parts.push(`rotate(${fmt((world.rotation * 180) / Math.PI)})`);
  if (sx !== 1 || sy !== 1) parts.push(`scale(${fmt(world.scale * sx)} ${fmt(world.scale * sy)})`);
  else if (world.scale !== 1) parts.push(`scale(${fmt(world.scale)})`);
  return parts.join(" ");
}

/**
 * Pure function. A camera view {zoom, panX, panY} → SVG transform attr value
 * (out = world·zoom + pan, read left to right: translate(pan) then scale(zoom)).
 *
 * @example viewTransform({zoom: 1, panX: 0, panY: 0}) // ""
 * @example viewTransform({zoom: 2, panX: 5, panY: 6}) // "translate(5 6) scale(2)"
 */
export function viewTransform(view) {
  const parts = [];
  if (view.panX !== 0 || view.panY !== 0) parts.push(`translate(${fmt(view.panX)} ${fmt(view.panY)})`);
  if (view.zoom !== 1) parts.push(`scale(${fmt(view.zoom)})`);
  return parts.join(" ");
}

/** Pure function. Wraps SVG fragment `inner` in a <g transform> iff `t` is
 * non-empty (avoids a redundant identity group).
 * @example groupWrap("", "<rect/>") // "<rect/>"
 * @example groupWrap("scale(2)", "<rect/>") // '<g transform="scale(2)"><rect/></g>'
 */
export function groupWrap(t, inner) {
  return t ? `<g transform="${t}">${inner}</g>` : inner;
}

/**
 * Pure function. fill / stroke / opacity presentation attrs shared by the shape
 * serializers. A per-command `opacity` maps to SVG `opacity` (group alpha),
 * matching the IR's per-item opacity semantics (the GPU multiplies it into every
 * channel; SVG group opacity is the vector equivalent).
 *
 * @example paintAttrs({fill: [1, 0, 0, 1], stroke: null, strokeWidth: 0, opacity: 1}) // 'fill="rgba(255,0,0,1)"'
 * @example paintAttrs({fill: null, stroke: [0, 0, 0, 1], strokeWidth: 2, opacity: 0.5}) // 'fill="none" stroke="rgba(0,0,0,1)" stroke-width="2" opacity="0.5"'
 */
export function paintAttrs(cmd, ctx) {
  const a = [];
  a.push(cmd.fill ? `fill="${paintRef(ctx, cmd.fill)}"` : `fill="none"`);
  if (cmd.stroke && cmd.strokeWidth > 0)
    a.push(`stroke="${paintRef(ctx, cmd.stroke)}" stroke-width="${fmt(cmd.strokeWidth)}"`);
  if ((cmd.opacity ?? 1) !== 1) a.push(`opacity="${fmt(cmd.opacity)}"`);
  return a.join(" ");
}

/**
 * Command (may register a <defs> gradient, via paintRef). The presentation attrs
 * for a STROKE-ONLY element at an explicit width — the half-stroke element the
 * offset construction clips. No fill (the caller drew it once already) and no
 * `opacity` (it rides on the shape's own element, so folding it in here would
 * double-apply it).
 */
function strokeOnlyAttrs(cmd, width, ctx) {
  return `fill="none" stroke="${paintRef(ctx, cmd.stroke)}" stroke-width="${fmt(width)}"` +
    ((cmd.opacity ?? 1) !== 1 ? ` opacity="${fmt(cmd.opacity)}"` : "");
}

/**
 * Pure function. An ellipse op's outline as an SVG path `d` (two arcs), so the
 * offset-stroke clip can reference the SAME geometry the <ellipse> draws —
 * <clipPath> children may be shapes, but a path keeps ONE clip-building code
 * path for every shape op.
 *
 * @example ellipsePathD({cx: 10, cy: 10, rx: 5, ry: 3}) // "M5 10 A5 3 0 1 0 15 10 A5 3 0 1 0 5 10 Z"
 */
export function ellipsePathD({ cx, cy, rx, ry }) {
  return `M${fmt(cx - rx)} ${fmt(cy)} A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx + rx)} ${fmt(cy)} ` +
    `A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx - rx)} ${fmt(cy)} Z`;
}

/**
 * Command (registers up to two <clipPath> defs on `ctx`). THE SVG twin of
 * paint_skia's drawOffsetOpStroke: an off-center stroke (cmd.strokeOffset ≠ 0)
 * as TWO CLIPPED STROKES, staying fully VECTOR.
 *
 * SVG HAS NO STROKE-ALIGNMENT ATTRIBUTE — the SVG 2 `stroke-alignment` property
 * was dropped and no renderer ships it — so the construction is the only faithful
 * way to express this, and it is the same one Skia uses: at inside fraction
 * a = (1−o)/2, draw a centered stroke of width 2aw clipped to the shape's
 * interior, plus one of width 2(1−a)w clipped to its EXTERIOR. SVG clips are
 * intersect-only, so the exterior clip is built by the even-odd sandwich instead
 * of a difference op: a huge covering rect PLUS the shape, under
 * clip-rule="evenodd", is exactly "everything except the shape".
 *
 * `geometryD` is the shape's own outline as a path `d` in LOCAL units (the clip
 * geometry — the same geometry the visible element draws), and `element(width)`
 * renders the shape's stroke-only element at a given stroke width.
 *
 * @param {object} cmd - the stroked op (reads strokeOffset/strokeWidth/stroke)
 * @param {string} geometryD - the shape outline as an SVG path `d`, local units
 * @param {function} element - (strokeWidth: number) => SVG element string
 * @param {object} ctx - the SvgAssembly (nextId/addDef)
 * @returns {string} the SVG fragment for the offset stroke (local space)
 */
export function offsetStrokeSVG(cmd, geometryD, element, ctx) {
  const inside = strokeInsideFraction(cmd.strokeOffset);
  // A single rect big enough to cover any content, for the even-odd exterior clip.
  // It is the clip's OUTER loop; the shape is the hole punched in it.
  const COVER = 1e6;
  const parts = [];
  for (const [depth, isInside] of [[inside, true], [1 - inside, false]]) {
    if (depth <= 0) continue; // a fully inner/outer stroke has no ink on the other side
    const clipId = ctx.nextId(isInside ? "sinclip" : "soutclip");
    ctx.addDef(isInside
      ? `<clipPath id="${clipId}"><path d="${geometryD}"/></clipPath>`
      : `<clipPath id="${clipId}" clip-rule="evenodd"><path d="M${-COVER} ${-COVER} H${COVER} V${COVER} H${-COVER} Z ${geometryD}" clip-rule="evenodd"/></clipPath>`);
    parts.push(`<g clip-path="url(#${clipId})">${element(2 * depth * cmd.strokeWidth)}</g>`);
  }
  return parts.join("");
}

/**
 * Command (may register a <defs> gradient on `ctx`). A fill/stroke Paint → an SVG
 * paint value: a SOLID returns an rgba() string (byte-identical to the old
 * rgbaToCss path); a GRADIENT registers a <linearGradient>/<radialGradient> def
 * (objectBoundingBox — the SVG default, matching the Skia objectBoundingBox
 * shader) and returns "url(#id)". `opacity` folds into the color/stop alpha (for
 * the crop/lens paths that pre-fold item opacity; shape paths pass 1 and use the
 * group `opacity` attr instead). A gradient requires `ctx` (to mint the def).
 */
export function paintRef(ctx, paint, opacity = 1) {
  if (!isGradientPaint(paint)) {
    const [r, g, b, a] = paint;
    return rgbaToCss([r, g, b, a * opacity]);
  }
  if (!ctx || !ctx.nextId) throw new Error("svg_backend: a gradient paint needs the SvgAssembly ctx (to mint a <defs> gradient) — pass it to paintAttrs/paintRef");
  const id = ctx.nextId(paint.type === "radialGradient" ? "rg" : "lg");
  ctx.addDef(gradientDefSVG(paint, id, opacity));
  return `url(#${id})`;
}

/**
 * Pure function. A parsed gradient Paint → its SVG <linearGradient>/
 * <radialGradient> def fragment (default gradientUnits="objectBoundingBox", so
 * from/to/center are the same 0..1 numbers the Skia shader uses). `opacity` folds
 * into each stop's stop-opacity.
 *
 * @example gradientDefSVG({type: "linearGradient", stops: [{offset: 0, color: [1,0,0,1]}, {offset: 1, color: [0,0,1,1]}], from: {x: 0, y: 0}, to: {x: 1, y: 0}}, "lg1", 1) // '<linearGradient id="lg1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgb(255,0,0)" stop-opacity="1"/><stop offset="1" stop-color="rgb(0,0,255)" stop-opacity="1"/></linearGradient>'
 * @example gradientDefSVG({type: "radialGradient", stops: [{offset: 0, color: [1,1,1,1]}, {offset: 1, color: [0,0,0,1]}], center: {x: 0.5, y: 0.5}, r: 0.5}, "rg1", 1).startsWith('<radialGradient id="rg1" cx="0.5" cy="0.5" r="0.5">') // true
 */
export function gradientDefSVG(paint, id, opacity = 1) {
  const stops = paint.stops.map((s) => {
    const [r, g, b, a] = s.color;
    const byte = (v) => Math.round(v * 255);
    return `<stop offset="${fmt(s.offset)}" stop-color="rgb(${byte(r)},${byte(g)},${byte(b)})" stop-opacity="${fmt(a * opacity)}"/>`;
  }).join("");
  if (paint.type === "linearGradient") {
    // CENTER + WAVELENGTH + PHASE fold in via linearGradientRender: the axis
    // endpoints move to the centered (phase-shifted), wavelength-scaled ramp and a
    // mirror-tiled ramp (wavelength ≠ 1) becomes spreadMethod="reflect" — SVG
    // expresses the tiling vectorially, no raster fallback needed. A default/legacy
    // paint returns the untouched from/to with mirror false, so its def string is
    // byte-identical.
    const { from, to, mirror } = linearGradientRender(paint);
    const spread = mirror ? ` spreadMethod="reflect"` : "";
    return `<linearGradient id="${id}" x1="${fmt(from.x)}" y1="${fmt(from.y)}" x2="${fmt(to.x)}" y2="${fmt(to.y)}"${spread}>${stops}</linearGradient>`;
  }
  return `<radialGradient id="${id}" cx="${fmt(paint.center.x)}" cy="${fmt(paint.center.y)}" r="${fmt(paint.r)}">${stops}</radialGradient>`;
}

/**
 * Pure function. A rounded-rect path `d` string (used for crop-box clip regions,
 * where a <rect rx> can't be a <clipPath> child as cleanly across the rotation
 * wrap). Radius clamps to the half-extents like the GPU shader's sdRoundBox and
 * pdf_backend.rectPath. Uses arcs (A) — the compact SVG rounded-corner idiom.
 *
 * @example roundedRectPathD({x: 0, y: 0, w: 10, h: 5, cornerRadius: 0}) // "M0 0 H10 V5 H0 Z"
 * @example roundedRectPathD({x: 0, y: 0, w: 10, h: 6, cornerRadius: 2}).startsWith("M2 0") // true
 */
export function roundedRectPathD({ x, y, w, h, cornerRadius = 0 }) {
  const r = Math.min(cornerRadius, w / 2, h / 2);
  const n = fmt;
  if (r <= 0) return `M${n(x)} ${n(y)} H${n(x + w)} V${n(y + h)} H${n(x)} Z`;
  const arc = (ex, ey) => `A${n(r)} ${n(r)} 0 0 1 ${n(ex)} ${n(ey)}`;
  return [
    `M${n(x + r)} ${n(y)}`,
    `H${n(x + w - r)}`, arc(x + w, y + r),
    `V${n(y + h - r)}`, arc(x + w - r, y + h),
    `H${n(x + r)}`, arc(x, y + h - r),
    `V${n(y + r)}`, arc(x + r, y),
    "Z",
  ].join(" ");
}

/**
 * The ops vectorCommandToSVG can represent directly — THE single source of truth
 * for "is this op vector-representable in SVG". emitRegionSVG routes any op NOT in
 * this set (and not one of its own compositing ops handled earlier —
 * magnifyBackdrop / cropSubtree / effectSubtree, and blurBackdrop / add-blend,
 * consumed by the raster split) through the general raster fallback
 * (emitRasterOpSVG) rather than throwing. The SVG companion to
 * pdf_backend.VECTOR_OPS (identical vocabulary today — the same IR); kept local
 * because it must stay in lockstep with THIS file's switch below (whose `default`
 * remains a LOUD guard for a set/switch drift — no silent geometry drop).
 */
export const SVG_VECTOR_OPS = new Set(["rect", "ellipse", "polyline", "polygon", "path", "text", "latexVector", "image", "video", "videoV5"]);

/**
 * Pure function. Serializes one PLAIN VECTOR drawable command (no effects) to an
 * SVG fragment, positioned by its world transform. Effect ops (blur / magnify /
 * crop) are handled by the walker (emitRegionSVG), never here. Image and video
 * consult `ctx` for the resolved href (pre-loaded, like pdf_backend's XObjects).
 * Unknown ops throw — a backend must NEVER silently drop geometry (manifest: no
 * silent fallbacks). NB: emitRegionSVG routes unrepresentable ops to the raster
 * fallback BEFORE reaching here, so this `default` is a defensive guard (it still
 * fires for a direct call, e.g. the render_gpu_test unknown-op check).
 */
/**
 * Command (pushes the red error-box fragments for a failed owner run onto
 * `out`). The SVG half of the containment affordance — the SAME two ops the
 * painter and the PDF exporter draw (core/paint_containment.errorAffordanceOps),
 * pushed through this backend's own vector path, so a contained item looks the
 * same in the editor, the PDF and the SVG.
 *
 * Its own try mirrors the other two backends' and is NOT a silent swallow: the
 * caller has already reported the real failure, and an affordance that could
 * abort the export would defeat the boundary it belongs to.
 */
function emitContainmentBoxSVG(flat, start, end, out, ctx) {
  try {
    const owner = flat[start].owner;
    const box = containmentBoxSize(flat, start, end);
    const world = isPaintableFrame(flat[start].world) ? flat[start].world : { x: 0, y: 0, rotation: 0, scale: 1 };
    const a = errorAffordanceArgs(box.w, box.h, errorMessage(describeOwner(owner), "failed to export"));
    for (const op of [rect(a.rect), text(a.text)]) out.push(vectorCommandToSVG(op, world, ctx));
  } catch {
    // Already reported; the remaining items still deserve their turn.
  }
}

export function vectorCommandToSVG(cmd, world, ctx) {
  const g = (inner) => groupWrap(similarityTransform(world), inner);
  switch (cmd.op) {
    case "rect": {
      if (!cmd.fill && !(cmd.stroke && cmd.strokeWidth > 0)) return "";
      const rectEl = (attrs) => `<rect x="${fmt(cmd.x)}" y="${fmt(cmd.y)}" width="${fmt(cmd.w)}" height="${fmt(cmd.h)}"` +
        (cmd.cornerRadius > 0 ? ` rx="${fmt(cmd.cornerRadius)}"` : "") + ` ${attrs}/>`;
      if (!opStrokeIsOffset(cmd)) return g(rectEl(paintAttrs(cmd, ctx)));
      // OFFSET STROKE: the fill draws once as usual, then the stroke is rebuilt as
      // two clipped strokes over the rect's own outline (offsetStrokeSVG).
      return g(rectEl(paintAttrs({ ...cmd, stroke: null }, ctx)) +
        offsetStrokeSVG(cmd, roundedRectPathD(cmd), (w) => rectEl(strokeOnlyAttrs(cmd, w, ctx)), ctx));
    }
    case "ellipse": {
      if (!cmd.fill && !(cmd.stroke && cmd.strokeWidth > 0)) return "";
      const ellEl = (attrs) => `<ellipse cx="${fmt(cmd.cx)}" cy="${fmt(cmd.cy)}" rx="${fmt(cmd.rx)}" ry="${fmt(cmd.ry)}" ${attrs}/>`;
      if (!opStrokeIsOffset(cmd)) return g(ellEl(paintAttrs(cmd, ctx)));
      return g(ellEl(paintAttrs({ ...cmd, stroke: null }, ctx)) +
        offsetStrokeSVG(cmd, ellipsePathD(cmd), (w) => ellEl(strokeOnlyAttrs(cmd, w, ctx)), ctx));
    }
    case "polyline":
      return g(`<polyline points="${pointsAttr(cmd.points)}" fill="none" ` +
        `stroke="${rgbaToCss(cmd.color)}" stroke-width="${fmt(cmd.width)}" stroke-linecap="round" stroke-linejoin="round"` +
        ((cmd.opacity ?? 1) !== 1 ? ` opacity="${fmt(cmd.opacity)}"` : "") + `/>`);
    case "polygon":
      // A polygon is FILL-ONLY (it has no stroke slot at all), so an OFF fill —
      // parsePaint's null — leaves nothing whatsoever to draw and the op is
      // dropped entirely, exactly like the rect/ellipse/path cases above. Without
      // this guard the null reached paintRef and threw "paint is not iterable",
      // which is what an arrow head or a donut with its Fill turned Off produced.
      if (!cmd.fill) return "";
      return g(`<polygon points="${pointsAttr(cmd.points)}" fill="${paintRef(ctx, cmd.fill)}"` +
        ((cmd.opacity ?? 1) !== 1 ? ` opacity="${fmt(cmd.opacity)}"` : "") + `/>`);
    case "path":
      // Generic vector path (Wave 2): the `d` string is already native SVG path
      // syntax → emitted verbatim (xml-escaped). fill/stroke/opacity via the
      // shared paintAttrs; fill-rule only when evenodd (nonzero is SVG's default).
      if (!cmd.fill && !(cmd.stroke && cmd.strokeWidth > 0)) return "";
      {
        const rule = cmd.fillRule === "evenodd" ? ` fill-rule="evenodd"` : "";
        const pathEl = (attrs) => `<path d="${xmlEscape(cmd.d)}" ${attrs}${rule}/>`;
        if (!opStrokeIsOffset(cmd)) return g(pathEl(paintAttrs(cmd, ctx)));
        // A `path`'s own `d` IS the clip geometry, so the construction generalizes
        // to any outline the shape library or an svg import produces.
        return g(pathEl(paintAttrs({ ...cmd, stroke: null }, ctx)) +
          offsetStrokeSVG(cmd, xmlEscape(cmd.d), (w) => pathEl(strokeOnlyAttrs(cmd, w, ctx)), ctx));
      }
    case "text":
      return g(textToSVG(cmd, ctx));
    case "image":
    case "video": {
      // A bitmap is embedded as an <image> with a data-URI href (manifest: the
      // SVG must be SELF-CONTAINED — no external asset refs). Image = the source
      // pixels; video = the grabbed CURRENT FRAME (the PDF precedent). Both were
      // pre-resolved to a data URI by ctx; a null href = blank/undrawable src
      // (draw nothing, matching the GPU skip and pdf_backend's null XObject).
      const href = cmd.op === "image" ? ctx.imageHref(cmd.ref) : ctx.videoHref(cmd.ref);
      if (href === null) return "";
      return g(`<image x="${fmt(cmd.x)}" y="${fmt(cmd.y)}" width="${fmt(cmd.w)}" height="${fmt(cmd.h)}"` +
        ((cmd.opacity ?? 1) !== 1 ? ` opacity="${fmt(cmd.opacity)}"` : "") +
        ` preserveAspectRatio="none" href="${href}"/>`);
    }
    case "latexVector": {
      // TRUE VECTOR EQUATION (Round 15.1): MathJax glyph <path>s embedded INLINE
      // (no nested <svg>, no <use>/<defs>/id refs — the glyphs were flattened to
      // plain absolute-coord `d` strings at typeset, so the SVG stays fully
      // SELF-CONTAINED, the parity suite's no-external-ref assertion). A MathJax
      // `d` string IS native SVG path syntax → emitted verbatim, no conversion
      // (the PDF backend converts to operators; SVG passes through). Two nested
      // <g>s (the file's coordinate-mapping convention, never a nested <svg>):
      // the world <g> (via g()) wraps an inner <g> mapping the glyph viewBox onto
      // the draw box {x,y,w,h} — a plain box→box scale+translate (both y-DOWN, no
      // flip), the same shape emitLensSVG's `magnify` uses.
      const vb = cmd.viewBox;
      if (cmd.glyphs.length === 0 || vb.w <= 0 || vb.h <= 0) return "";
      // preserveAspect (default): UNIFORM fit + center (letterbox) so export
      // matches the on-screen render; else the legacy non-uniform box→box scale.
      let sx, sy, ox = 0, oy = 0;
      if (cmd.preserveAspect !== false) {
        const f = fitBox(vb.w, vb.h, cmd.w, cmd.h);
        sx = sy = f.scale; ox = f.offsetX; oy = f.offsetY;
      } else {
        sx = cmd.w / vb.w; sy = cmd.h / vb.h;
      }
      const boxT = `translate(${fmt(cmd.x + ox - vb.minX * sx)} ${fmt(cmd.y + oy - vb.minY * sy)}) scale(${fmt(sx)} ${fmt(sy)})`;
      const paths = cmd.glyphs
        .map((gl) => `<path d="${xmlEscape(gl.d)}" fill="${rgbaToCss(parseColor(gl.fill))}"/>`)
        .join("");
      const inner = `<g transform="${boxT}">${paths}</g>`;
      // Per-item opacity rides the world <g> (a group opacity over all glyphs —
      // matching the image op's single-element opacity attr, but on the group).
      return g((cmd.opacity ?? 1) !== 1 ? `<g opacity="${fmt(cmd.opacity)}">${inner}</g>` : inner);
    }
    case "videoV5":
      // V5 off-main-thread video is an EDITOR perf experiment with no vector-export
      // frame source (its <video> is in the browser-only V5 registry), so it draws
      // NOTHING here — deterministic, crash-free. Matches pdf_backend; in
      // SVG_VECTOR_OPS so it routes to this switch, not the raster fallback.
      return "";
    default:
      throw new Error(`svg_backend: unknown op "${cmd.op}"`);
  }
}

/** Pure function. IR point list → an SVG points="x,y x,y …" attribute value.
 * @example pointsAttr([[0, 0], [10, 5]]) // "0,0 10,5"
 */
export function pointsAttr(points) {
  return points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
}

/**
 * Pure function. One text op → a <text> element (SELECTABLE). The IR text origin
 * is TOP-LEFT (canvas textBaseline="top"); SVG <text> y is the BASELINE, so the
 * baseline sits at top + ascentFraction·size — the SAME per-font metric the PDF
 * backend and glyph atlas use (ctx.ascentFraction, measured from the committed
 * face). Font family comes from fonts.js (cssFamilyFor); a bold run adds
 * font-weight. `xml:space="preserve"` keeps leading/interior spaces (SVG would
 * otherwise collapse them, unlike the raster layout).
 *
 * @example // textToSVG(text({text:"Hi",x:2,y:4,size:36,color:"#000"}), {ascentFraction:()=>0.8}) → '<text x="2" y="32.8" ...>Hi</text>'
 */
export function textToSVG(cmd, ctx) {
  // RICH TEXT (Round 13.4): when the op carries a {runs,paras} value AND a
  // measure seam is available, run the SHARED pure layout (core/richtext) — the
  // SAME layout the GPU/PDF backends use (the parity lever) — and emit one REAL
  // <text> per run (SELECTABLE, the parity requirement) plus highlight/decoration
  // rects. This is the SVG twin of pdf_backend's rich text case. Falls through to
  // the legacy single-run path below when there is no rich value or no seam.
  if (cmd.rich && ctx.measureText) {
    const draws = richTextDraws(cmd, ctx.richMeasure());
    const out = [];
    // HIGHLIGHT backgrounds FIRST (painter's order — behind the glyphs). A plain
    // filled <rect> spanning the run's laid-out box, mirroring the decoration bar.
    for (const h of draws.highlights) {
      out.push(`<rect x="${fmt(h.x)}" y="${fmt(h.y)}" width="${fmt(h.w)}" height="${fmt(h.h)}" fill="${rgbaToCss(parseColor(h.color))}"` +
        ((h.opacity ?? 1) !== 1 ? ` opacity="${fmt(h.opacity)}"` : "") + `/>`);
    }
    // One <text> per run at the layout's shared baseline (baselineY is already
    // top+ascent from the layout — no ascentFraction needed here).
    for (const d of draws.textDraws) {
      if (d.text.length === 0) continue;
      out.push(richRunTextSVG(d, ctx));
    }
    // Underline / strike decoration bars (on TOP of glyphs), filled <rect>s.
    for (const ln of draws.lines) {
      out.push(`<rect x="${fmt(ln.x)}" y="${fmt(ln.y - ln.thickness / 2)}" width="${fmt(ln.w)}" height="${fmt(ln.thickness)}" fill="${rgbaToCss(parseColor(ln.color))}"` +
        ((ln.opacity ?? 1) !== 1 ? ` opacity="${fmt(ln.opacity)}"` : "") + `/>`);
    }
    return out.join("");
  }
  // LEGACY single-run text op (parity scenes / hand-built IR / no measure seam).
  const fontId = cmd.font || DEFAULT_FONT;
  const baseline = cmd.y + ctx.ascentFraction(fontId, cmd.bold) * cmd.size;
  const attrs = [
    `x="${fmt(cmd.x)}"`, `y="${fmt(baseline)}"`,
    `font-family="${xmlEscape(cssFamilyFor(fontId))}"`,
    `font-size="${fmt(cmd.size)}"`,
  ];
  if (cmd.bold) attrs.push(`font-weight="bold"`);
  attrs.push(`fill="${paintRef(ctx, cmd.color)}"`);
  if ((cmd.opacity ?? 1) !== 1) attrs.push(`opacity="${fmt(cmd.opacity)}"`);
  attrs.push(`xml:space="preserve"`);
  return `<text ${attrs.join(" ")}>${xmlEscape(cmd.text)}</text>`;
}

/**
 * Pure function. One rich-text run draw → a REAL <text> element (SELECTABLE).
 * `d` is a richTextDraws textDraw: {text, x, baselineY, size, color, bold,
 * italic, font, opacity, outlineColor, outlineWidth}. Bold → font-weight,
 * italic → font-style (the browser uses the face's real italic if it has one,
 * else synthesizes oblique — matching the GPU atlas's canvas2D-synth italic).
 * OUTLINE (Round 13.4): outlineWidth > 0 adds stroke + stroke-width +
 * paint-order="stroke" (the stroke paints UNDER the fill, so the glyph body
 * stays crisp — the standard SVG glyph-outline idiom). Stroke width is LOCAL
 * units (the ancestor world <g> scales it with the glyphs — never
 * pre-multiplied, the concerns.md scale² guard).
 *
 * A GRADIENT run fill (Axis-1 Paint) registers a <linearGradient>/<radialGradient>
 * def on `ctx` and fills with url(#id) (objectBoundingBox = the <text>'s own bbox,
 * matching the Skia glyph-gradient objectBoundingBox) — so gradient text survives
 * vector export too. A solid run fill is the byte-identical rgba() path.
 *
 * @example // richRunTextSVG({text:"Hi",x:5,baselineY:32,size:36,color:"#000",bold:false,italic:false,font:"system",opacity:1,outlineWidth:0}) → '<text x="5" y="32" ...>Hi</text>'
 */
export function richRunTextSVG(d, ctx) {
  const attrs = [
    `x="${fmt(d.x)}"`, `y="${fmt(d.baselineY)}"`,
    `font-family="${xmlEscape(cssFamilyFor(d.font || DEFAULT_FONT))}"`,
    `font-size="${fmt(d.size)}"`,
  ];
  if (d.bold) attrs.push(`font-weight="bold"`);
  if (d.italic) attrs.push(`font-style="italic"`);
  attrs.push(`fill="${paintRef(ctx, parsePaint(d.color))}"`);
  if ((d.outlineWidth ?? 0) > 0) {
    attrs.push(`stroke="${rgbaToCss(parseColor(d.outlineColor))}"`, `stroke-width="${fmt(d.outlineWidth)}"`, `paint-order="stroke"`);
  }
  if ((d.opacity ?? 1) !== 1) attrs.push(`opacity="${fmt(d.opacity)}"`);
  attrs.push(`xml:space="preserve"`);
  return `<text ${attrs.join(" ")}>${xmlEscape(d.text)}</text>`;
}

/**
 * Command (async; appends SVG fragments to `out`, registers resources via ctx).
 * The hybrid-rule walker for ONE region (the page, or a lens's source square) —
 * the SVG twin of pdf_backend.emitRegion, with the IDENTICAL split algorithm:
 * split at the region's LAST blurBackdrop (everything at/below it becomes one
 * raster <image> covering the region), emit everything above as vector, and
 * re-enter per magnifier lens / crop box.
 *
 * region: {view: world→output-px mapping incl. lens magnifications,
 *          worldRect: the region's visible world AABB,
 *          depth: lens recursion depth, background}
 */
export async function emitRegionSVG(commands, region, out, ctx) {
  const flat = flattenIR(commands);
  // Map each flattened drawable back to its RAW index — effect ops slice the
  // raw list (rasterize + lens re-emits consume raw commands). Same bookkeeping
  // as pdf_backend.emitRegion.
  const rawIndexOf = [];
  {
    let f = 0;
    commands.forEach((c, i) => {
      if (c.op !== "pushTransform" && c.op !== "popTransform") rawIndexOf[f++] = i;
    });
  }

  // HYBRID RULE split — IDENTICAL to pdf_backend.emitRegion's `lastBlurFlat`,
  // through the SAME shared predicate: an effect widget whose blend has no
  // vector-blend spelling (blendNeedsBelowRaster — "add" plus every Photoshop
  // mode that only exists as SkSL) splits like a blur, because its composite
  // needs the real backdrop pixels.
  let lastBlurFlat = -1;
  flat.forEach((fc, i) => {
    if (fc.cmd.op === "blurBackdrop" || (fc.cmd.op === "effectSubtree" && blendNeedsBelowRaster(fc.cmd.blend))) lastBlurFlat = i;
  });

  if (lastBlurFlat >= 0) {
    const below = balancedSlice(commands, rawIndexOf[lastBlurFlat] + 1);
    out.push(await ctx.rasterRegion(below, {
      placeRect: region.worldRect,
      srcView: region.view,
      background: region.background,
    }));
  }

  // THE PER-NODE EXPORT BOUNDARY — identical in intent and shape to
  // pdf_backend.emitRegion's (and to the painter's, which is the original; see
  // render_gpu/skia/paint_skia.js paintNodeRun and core/paint_containment.js).
  // An SVG export of a poisoned deck yields the deck with a red box on the one
  // broken item, never a thrown export.
  let runStart = lastBlurFlat + 1;
  while (runStart < flat.length) {
    const runEnd = ownerRunEnd(flat, runStart);
    try {
      await emitOpRangeSVG(flat, runStart, runEnd, commands, rawIndexOf, region, out, ctx);
    } catch (e) {
      // The caller's wiring escapes; only document poison is contained (see the
      // PDF twin and core/paint_containment.configurationError).
      if (isConfigurationError(e)) throw e;
      const owner = flat[runStart].owner;
      const msg = throwMessage(e);
      if (reportExportFailureOnce(
        `svg_backend:node:${owner?.itemId ?? "unowned"}:${msg}`,
        `PowerRP SVG export: item ${describeOwner(owner)} failed to render — ${msg}. It is exported as an error box; every other item exports normally.`,
      )) console.error(e);
      emitContainmentBoxSVG(flat, runStart, runEnd, out, ctx);
    }
    runStart = runEnd;
  }
}

/** Command (async; pushes SVG fragments for flat[start..end) — THE ORIGINAL
 *  per-op walk, unchanged, now called once per owner run. No try/catch here:
 *  the boundary is the caller's. */
async function emitOpRangeSVG(flat, start, end, commands, rawIndexOf, region, out, ctx) {
  for (let i = start; i < end; i++) {
    const { cmd, world } = flat[i];
    if (cmd.op === "magnifyBackdrop") {
      out.push(await emitLensSVG(cmd, world, commands, rawIndexOf[i], region, ctx));
    } else if (cmd.op === "cropSubtree") {
      out.push(await emitCropSVG(cmd, world, region, ctx));
    } else if (cmd.op === "effectSubtree") {
      out.push(await emitEffectSVG(cmd, world, region, ctx));
    } else if (!SVG_VECTOR_OPS.has(cmd.op) || opHasMaterialFill(cmd) || opHasMaterialStroke(cmd) || opStrokeNeedsRaster(cmd)) {
      // (A MATERIAL-filled shape op has no vector form — same raster fallback as pdf_backend.
      //  A TRIMMED / TAPER-capped stroke (opStrokeNeedsRaster) likewise rasterizes its
      //  own region rather than silently drawing the untrimmed stroke; a plain round cap
      //  stays vector — SVG expresses stroke-linecap natively.)
      // GENERAL RASTER FALLBACK (the HYBRID RULE generalized — the SVG twin of
      // pdf_backend.emitRegion's emitRasterOp branch): an op with no SVG vector
      // form (glassBackdrop today; any FUTURE such op automatically) rasterizes
      // JUST its own region as an <image>, never throws. Vector content around it
      // stays vector.
      out.push(await emitRasterOpSVG(cmd, world, commands, rawIndexOf[i], region, ctx));
    } else {
      out.push(vectorCommandToSVG(cmd, world, ctx));
    }
  }
}

/**
 * Command (async; returns an SVG fragment). One EFFECTED widget (manifest
 * Round 12D; ir.js effectSubtree): V1 renders the WHOLE effected widget
 * (shadow + content + bloom + blend, GPU-composited) as ONE raster <image> —
 * exact pixels, the safe hybrid path (same machinery as the blur split /
 * deep-lens fallback). Multiply/screen against the page content below is
 * approximated by baking the widget over transparency and compositing
 * normally — a KNOWN, DOCUMENTED divergence for non-normal blends in SVG.
 *
 * NATIVE-FILTER UPGRADE PATH (spec'd for the SVG owner, deliberately not
 * built here): shadow = <filter> feGaussianBlur(SourceAlpha) + feOffset +
 * feFlood/feComposite under vector content; bloom = feGaussianBlur +
 * feComposite(arithmetic k2=k3=1) or feBlend screen; blend = a
 * `style="mix-blend-mode:multiply|screen"` group (needs `isolation` control
 * on the parent). Registered through ctx.addDef like the lens clipPaths.
 * Until then this raster path keeps SVG export CORRECT for every effect.
 *
 * A CONSTRAINT ON THAT UPGRADE — OVERDRIVEN SHADOWS. shadow.opacity has no
 * ceiling (core/properties.js) and above 1 it is a COVERAGE MULTIPLIER, not an
 * alpha; `flood-opacity`, `fill-opacity` and `opacity` are all specified in
 * [0, 1], so the sketched feFlood spelling CANNOT express it and would clamp
 * silently. The raster path below has no such problem — the multiplier is
 * applied by the rasterizer and its saturated result is baked into the <image>
 * pixels — so an overdriven shadow must either stay raster or be expressed as a
 * saturating transfer on the blurred alpha (feComponentTransfer type="linear"
 * slope=opacity on the alpha channel, which clamps at 1 per channel exactly as
 * the renderer's colour matrix does) BEFORE the feFlood composite. Feeding the
 * raw opacity to flood-opacity is the one forbidden option.
 *
 * WHY THERE IS NO vectorSafeEffects BRANCH HERE (and what guards it instead):
 * pdf_backend gates its vector-preserving branch on the shared
 * vectorSafeEffects predicate; V1 SVG has no such branch — it rasters EVERY
 * effected widget — so it is correct for the whole predicate's domain by
 * construction, and inventing a branch to "use" the predicate would change
 * exported pixels for no gain. What IS shared is the anti-drop invariant below:
 * this function re-spreads the op before rasterizing (exactly where pdf_backend's
 * sibling silently lost softEdges/innerShadow for months), so it runs the SAME
 * droppedRasterOnlyEffects check. When the native-filter upgrade above lands and
 * SVG grows a vector-preserving branch, it MUST gate on vectorSafeEffects — the
 * cross-backend test in render_gpu/tests/effects_export_guard_test.js pins that.
 */
export async function emitEffectSVG(cmd, world, region, ctx) {
  if (blendNeedsBelowRaster(cmd.blend)) throw new Error(`svg_backend: a "${cmd.blend}"-blend effectSubtree must be consumed by emitRegionSVG's raster split — an isolated raster cannot reproduce a composite with no vector-blend spelling (blendNeedsBelowRaster)`);
  const m = cmd.margin;
  const corners = [
    [cmd.x - m, cmd.y - m], [cmd.x + cmd.w + m, cmd.y - m],
    [cmd.x - m, cmd.y + cmd.h + m], [cmd.x + cmd.w + m, cmd.y + cmd.h + m],
  ].map(([lx, ly]) => signedApply(world, lx, ly));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const placeRect = {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
  };
  // Blend NEUTRALIZED inside the isolated raster: multiply/screen against a
  // TRANSPARENT raster background would blacken/blow out the widget (the GPU
  // would blend against zeros); the divergence-vs-page note is in the header.
  const rasterCmd = { ...cmd, blend: "normal" };
  const dropped = droppedRasterOnlyEffects(cmd, rasterCmd);
  if (dropped.length) throw new Error(`svg_backend: emitEffectSVG's raster re-issue lost live effect(s) ${JSON.stringify(dropped)} — a raster-only effect must survive the re-spread or it exports as nothing`);
  return ctx.rasterRegion([pushTransform(world), rasterCmd, popTransform()], {
    placeRect, srcView: region.view, background: [0, 0, 0, 0],
  });
}

/**
 * Command (async; returns an SVG fragment). The GENERAL raster fallback for an op
 * the vector path cannot represent — the SVG twin of pdf_backend.emitRasterOp
 * (identical strategy, `<image>` output instead of a Form XObject). It rasterizes
 * the commands UP TO AND INCLUDING this op (balancedSlice through rawIdx) through
 * the injected GPU rasterizer — so the GPU applies the op's REAL effect (e.g. the
 * Liquid Glass SkSL) to exactly the below-content it samples — over the region
 * background, capturing ONLY the op's own placeRect (rasterOpPlaceRect: the
 * shared bbox+spill derivation, clamped to the visible region so an extreme-size
 * op can never mint an unbounded raster), and embeds it as one `<image>` with a
 * base64 PNG data URI (inline, OFFLINE — the same path image ops use). Content
 * around/below the rect stays fully VECTOR: only this component pixelates. An
 * OPAQUE tile (over the opaque region background) at the op's z-position cleanly
 * overpaints the vector below within the rect, while later vector ops draw on top
 * (SVG document order = z-order). Returns "" when the op is off-region.
 *
 * @param {object} cmd the unrepresentable op.
 * @param {number[]} world its absolute transform.
 * @param {object[]} commands the region's raw IR list.
 * @param {number} rawIdx this op's index in `commands`.
 * @param {object} region {view, worldRect, background, ...} — the enclosing region.
 * @param {SvgAssembly} ctx the document assembler.
 * @returns {Promise<string>} an `<image>` fragment, or "".
 */
export async function emitRasterOpSVG(cmd, world, commands, rawIdx, region, ctx) {
  const placeRect = rasterOpPlaceRect(cmd, world, region);
  if (!placeRect || !(placeRect.w > 0) || !(placeRect.h > 0)) return ""; // off-region → nothing to draw
  const through = balancedSlice(commands, rawIdx + 1); // include this op so the GPU applies its effect
  return ctx.rasterRegion(through, {
    placeRect,
    srcView: region.view,
    background: region.background,
  });
}

/**
 * Command (async; returns an SVG fragment). One SHAPED-LENS magnifier — the SVG
 * twin of pdf_backend.emitLens (manifest "BOX-SHAPED MAGNIFIERS + magnifier
 * ORIGIN"): a shaped <clipPath> (circle | rounded rect) + a magnify-about-ORIGIN
 * <g transform> re-emit of the commands below the lens (depth-capped → raster
 * embed), then the vector rim/border ring.
 *
 * ORIGIN: the magnify transform maps the origin to the lens CENTER —
 * `translate(C − M·O) scale(M)` (page' = C + M·(page − O), the same algebra as
 * magnifiedView / the GPU lensRenderView), read left-to-right. A default
 * origin = center reduces to the pre-origin `translate(C·(1−M)) scale(M)`
 * BYTE-IDENTICALLY (C − M·C = C·(1−M), same fmt output).
 *
 * SHAPE: a CIRCLE is rotation-invariant, so its clip circle + rim are emitted
 * directly in WORLD coordinates about the world center (unchanged from before
 * shapes existed — circle output stays byte-identical, reading rimColor/
 * rimWidth). A ROUNDED RECT genuinely has orientation, so its clip path +
 * border are emitted in LOCAL coordinates with the box's world transform baked
 * onto the clip child / border group (the emitCropSVG rotation convention),
 * reading the stroked-box bundle (stroke/strokeWidth).
 */
export async function emitLensSVG(cmd, world, commands, rawIdx, region, ctx) {
  const isBox = cmd.shape === "box";
  const center = signedApply(world, cmd.cx, cmd.cy);
  const originWorld = signedApply(world, cmd.originX ?? cmd.cx, cmd.originY ?? cmd.cy);
  const m = Math.max(cmd.magnification, 0.01);
  const below = balancedSlice(commands, rawIdx);
  // Hybrid-raster source rect: centered on the ORIGIN (what shows at the lens
  // center), sized by the lens extent / M (pdf_backend.emitLens's rule,
  // generalized to the box's half-extents).
  const halfSrcX = (isBox ? cmd.halfW : cmd.r) * world.scale / m;
  const halfSrcY = (isBox ? cmd.halfH : cmd.r) * world.scale / m;
  const sub = {
    view: magnifiedView(region.view, center, m, originWorld),
    worldRect: { x: originWorld.x - halfSrcX, y: originWorld.y - halfSrcY, w: halfSrcX * 2, h: halfSrcY * 2 },
    depth: region.depth + 1,
    background: region.background,
  };

  // Local-space rounded rect for the box lens (clip + border share it) — the
  // (cx, cy)-centered half-extent form, oriented by the box's world transform.
  const boxLocal = isBox
    ? { x: cmd.cx - cmd.halfW, y: cmd.cy - cmd.halfH, w: cmd.halfW * 2, h: cmd.halfH * 2, cornerRadius: cmd.cornerRadius }
    : null;
  const boxT = isBox ? similarityTransform(world) : "";

  const clipId = ctx.nextId("lensclip");
  if (isBox) {
    // Rounded-rect clip in the box's LOCAL frame, world transform baked onto the
    // clip child (SVG clipPathUnits defaults to userSpaceOnUse, so the clipped
    // group below stays in plain world space — the emitCropSVG convention).
    const tAttr = boxT ? ` transform="${boxT}"` : "";
    ctx.addDef(`<clipPath id="${clipId}"><path d="${roundedRectPathD(boxLocal)}"${tAttr}/></clipPath>`);
  } else {
    ctx.addDef(`<clipPath id="${clipId}"><circle cx="${fmt(center.x)}" cy="${fmt(center.y)}" r="${fmt(cmd.r * world.scale)}"/></clipPath>`);
  }

  let inner;
  if (region.depth < MAX_LENS_DEPTH) {
    // VECTOR lens: magnify about the origin (origin lands at center), re-emit
    // the display list below.
    const sub2 = [];
    await emitRegionSVG(below, sub, sub2, ctx);
    const magnify = `translate(${fmt(center.x - m * originWorld.x)} ${fmt(center.y - m * originWorld.y)}) scale(${fmt(m)})`;
    inner = `<g transform="${magnify}">${sub2.join("")}</g>`;
  } else {
    // Depth cap (the GPU / PDF recursion bound): a lens inside a lens embeds as
    // raster — the user-ratified pixelated fallback. Sample the SOURCE region
    // (about the origin), place it over the lens bbox (that IS magnification).
    const placeHalfX = (isBox ? cmd.halfW : cmd.r) * world.scale;
    const placeHalfY = (isBox ? cmd.halfH : cmd.r) * world.scale;
    inner = await ctx.rasterRegion(below, {
      placeRect: { x: center.x - placeHalfX, y: center.y - placeHalfY, w: placeHalfX * 2, h: placeHalfY * 2 },
      srcRect: sub.worldRect,
      srcView: region.view,
      background: region.background,
    });
  }

  // Border: ONE stroke ring for both shapes (ir.js collapsed the legacy circle
  // rim into stroke/strokeWidth). Width 0 = NO ring (manifest spec), matching pdf
  // emitLens. The box border's stroke-width stays LOCAL (its <g transform> scales
  // it); the circle border is in WORLD coords so its width pre-multiplies scale.
  let rim = "";
  const strokeColor = cmd.stroke;
  const strokeW = strokeColor ? cmd.strokeWidth * world.scale : 0;
  if (strokeW > 0) {
    const c = [...strokeColor.slice(0, 3), strokeColor[3] * cmd.opacity];
    rim = isBox
      ? groupWrap(boxT, `<path d="${roundedRectPathD(boxLocal)}" fill="none" stroke="${rgbaToCss(c)}" stroke-width="${fmt(cmd.strokeWidth)}"/>`)
      : `<circle cx="${fmt(center.x)}" cy="${fmt(center.y)}" r="${fmt(cmd.r * world.scale)}" fill="none" ` +
        `stroke="${rgbaToCss(c)}" stroke-width="${fmt(strokeW)}"/>`;
  }
  return `<g clip-path="url(#${clipId})">${inner}</g>${rim}`;
}

/**
 * Command (async; returns an SVG fragment). One crop box — the SVG twin of
 * pdf_backend.emitCrop (manifest ARCHITECTURE PLAN #3): fill the rounded-rect
 * region, clip to it, re-emit `cmd.content` (the target's OWN commands, already
 * wrapped in their ABSOLUTE world transform by sceneIR — a SELF-CONTAINED IR
 * list, so no balancedSlice/rawIdx), then stroke the border on top.
 *
 * ROTATION: the fill/clip/stroke GEOMETRY is emitted in LOCAL coordinates under
 * the crop box's own world transform (a <g transform="similarity(world)">), the
 * same convention vectorCommandToSVG uses for a rect. But `content` carries its
 * OWN absolute world transforms, so it must NOT sit inside the box's transform
 * group (that would double-apply the box's rotation/translation — the exact bug
 * pdf_backend.emitCrop documents). The clip-path reference works across that
 * separation: an SVG clip-path clips whatever element carries the `clip-path`
 * attribute, in the USER space of that element — so we clip a group that holds
 * the content in its absolute space, referencing a clipPath whose geometry is
 * pre-baked into the box's world space via `clipPathUnits="userSpaceOnUse"` and
 * a transform on the clip child. (Equivalent to the PDF's "clip fixed in device
 * space, then reset the CTM before content" — the clip region is established
 * once, in world space, and content re-emits in that same world space.)
 */
export async function emitCropSVG(cmd, world, region, ctx) {
  const local = { x: 0, y: 0, w: cmd.w, h: cmd.h, cornerRadius: cmd.cornerRadius };
  const boxT = similarityTransform(world);
  const parts = [];

  if (cmd.fill) {
    parts.push(groupWrap(boxT, `<path d="${roundedRectPathD(local)}" fill="${paintRef(ctx, cmd.fill, cmd.opacity)}"/>`));
  }

  // Clip region in WORLD space: the rounded rect's path under the box's world
  // transform, baked in via a transform on the clip child (userSpaceOnUse). This
  // lets the clipped group hold content in ABSOLUTE world space (content's own
  // transforms) without composing the box's transform onto it.
  const clipId = ctx.nextId("cropclip");
  const clipChildT = boxT ? ` transform="${boxT}"` : "";
  ctx.addDef(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${roundedRectPathD(local)}"${clipChildT}/></clipPath>`);

  const sub = { view: region.view, worldRect: region.worldRect, depth: region.depth + 1, background: region.background };
  const contentOut = [];
  await emitRegionSVG(cmd.content, sub, contentOut, ctx);
  parts.push(`<g clip-path="url(#${clipId})">${contentOut.join("")}</g>`);

  const strokeW = cmd.strokeWidth ?? 0;
  if (cmd.stroke && strokeW > 0) {
    parts.push(groupWrap(boxT, `<path d="${roundedRectPathD(local)}" fill="none" stroke="${paintRef(ctx, cmd.stroke, cmd.opacity)}" stroke-width="${fmt(strokeW)}"/>`));
  }
  return parts.join("");
}

/**
 * Command (async; builds an SVG document string). IR command list → a standalone,
 * self-contained SVG document. The SVG sibling of irToPDF — same options shape,
 * same injected seams (DOM-free backend).
 *
 * Args:
 *   commands (object[]): raw IR (transforms nested), z-ordered
 *   opts.width/opts.height (number): output size in px (camera rect dims — the
 *     camera region IS the viewBox)
 *   opts.view (object): {zoom, panX, panY} world → output-px mapping
 *     (fitRectView(cameraRect, width, height, 1))
 *   opts.background (string|number[]|null): page fill; also the clear color
 *     handed to `rasterize` so raster regions composite seamlessly
 *   opts.rasterize (async fn|null): (rawCmds, {zoom, panX, panY, dpr: 1}, wPx,
 *     hPx, background) → PNG bytes (Uint8Array). The GPU pixel service in
 *     browsers, a stub in node tests. null → scenes needing raster regions THROW.
 *   opts.rasterScale (number): raster-region px per output px. Default 2 (the
 *     retina-dpr precedent; matches pdf_backend so PDF/SVG raster regions agree).
 *   opts.textAscent (number|fn|null): baseline offset as a FRACTION of font size
 *     (IR text is top-anchored; baseline = top + fraction·size). PER-FONT: pass
 *     a (fontId, bold) → fraction fn (the browser measures each committed face's
 *     canvas fontBoundingBoxAscent/size so SVG baselines land where the GPU atlas
 *     top-anchors them — pdfFonts.measureTextAscent, SHARED with the PDF path). A
 *     bare number applies to every face; null → a conservative 0.8 default (a
 *     loud one-time console.warn — the metric should come from measurement).
 *   opts.loadFontBytes (async fn|null): (basename) → Uint8Array of a committed
 *     TTF (../fonts/<basename>). Needed to embed the committed fonts as
 *     @font-face data: URIs (the OFFLINE rule — no external font refs). null →
 *     committed fonts are NAMED in font-family but not embedded (a loud warning;
 *     the viewer falls back to a system face for them). `system` never needs it.
 *   opts.resolveImageHref (async fn|null): (ref) → a data: URI for an image ref
 *     (the SVG must be self-contained). A ref that is ALREADY a data URI is used
 *     as-is with no resolver; a URL ref needs this to fetch+inline it. null + a
 *     URL image ref → THROWS (no external ref allowed; no silent drop).
 *   opts.videoFrame (async fn|null): (ref) → {mime, bytes} of the video's CURRENT
 *     FRAME (the manifest rule: a video exports as its current frame — a raster
 *     embed). null → a scene with a video op THROWS loudly.
 *
 * Returns:
 *   Promise<string>: the SVG document text
 *
 * @example // await irToSVG(sceneIR(nodes), {width: 1280, height: 720, view: fitRectView(camRect, 1280, 720, 1), background: "#fff"}) → "<svg …>…</svg>"
 * @example (await irToSVG([], {width: 10, height: 10, view: {zoom: 1, panX: 0, panY: 0}})).startsWith("<svg") // true
 */
export async function irToSVG(commands, {
  width, height, view, background = null, rasterize = null, rasterScale = RASTER_SCALE,
  textAscent = null, loadFontBytes = null, resolveImageHref = null, videoFrame = null,
  measureText = null,
}) {
  const ctx = new SvgAssembly({ rasterize, rasterScale, textAscent, loadFontBytes, resolveImageHref, videoFrame, background, measureText });
  await ctx.ensureFonts(textFaces(commands)); // embed each distinct committed face as @font-face
  await ctx.ensureImages(imageRefs(commands)); // resolve each image ref to a data URI up-front
  await ctx.ensureVideoFrames(videoRefs(commands)); // grab + inline each video's current frame

  const pageWorldRect = {
    x: -view.panX / view.zoom,
    y: -view.panY / view.zoom,
    w: width / view.zoom,
    h: height / view.zoom,
  };
  const body = [];
  await emitRegionSVG(commands, { view, worldRect: pageWorldRect, depth: 0, background }, body, ctx);

  const bgRect = background !== null
    ? `<rect width="${fmt(width)}" height="${fmt(height)}" fill="${rgbaToCss(Array.isArray(background) ? background : parseColor(background))}"/>`
    : "";
  const content = groupWrap(viewTransform(view), body.join(""));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">\n` +
    `<defs>${ctx.defsString()}</defs>\n` +
    bgRect + (bgRect ? "\n" : "") +
    content + `\n</svg>`;
}

/**
 * The SVG assembly context — the DOM-free string builder's resource registry
 * (mirrors pdf_backend's PdfAssembly): owns embedded fonts (@font-face rules),
 * resolved image/video hrefs, <defs> (clip paths + font styles), and unique id
 * minting. Command object (accumulates state as the walk proceeds).
 */
class SvgAssembly {
  constructor({ rasterize, rasterScale, textAscent, loadFontBytes, resolveImageHref, videoFrame, background, measureText = null }) {
    this.rasterize = rasterize;
    this.rasterScale = rasterScale;
    this.textAscent = textAscent; // number | (fontId, bold)=>fraction | null
    this.measureText = measureText; // (str, {size,bold,font,italic}) → {width,ascent,descent} | null
    this.loadFontBytes = loadFontBytes;
    this.resolveImageHref = resolveImageHref;
    this.videoFrame = videoFrame;
    this.background = background;
    this._defs = [];          // clipPath / other <defs> fragments (order-preserving)
    this._fontFaces = [];      // @font-face CSS blocks
    this._imageHrefs = new Map(); // image ref → data URI, or null (blank/undrawable)
    this._videoHrefs = new Map(); // video ref → data URI, or null
    this._idCount = 0;
    this._warnedAscent = false;
  }

  /** Command. Mints a document-unique id with a readable prefix. */
  nextId(prefix) {
    return `${prefix}${++this._idCount}`;
  }

  /** Command. Registers a <defs> child (clipPath, etc.). */
  addDef(fragment) {
    this._defs.push(fragment);
  }

  /** Query. The full <defs> inner string: embedded @font-face styles first
   * (so text resolves the faces), then clip paths in registration order. */
  defsString() {
    const style = this._fontFaces.length ? `<style>${this._fontFaces.join("\n")}</style>` : "";
    return style + this._defs.join("");
  }

  /**
   * Command (async). Embeds each distinct committed (fontId, bold) face the
   * scene uses as an @font-face rule with a base64 data: URI (the OFFLINE rule:
   * no external font ref). The family name is the committed face's UNIQUE family
   * (fonts.js cssFamily), so <text font-family> resolves the embedded face and
   * never a same-named OS font. `system` (no file) needs no rule — it uses the OS
   * system-ui stack. A committed font with no loadFontBytes seam is NAMED but not
   * embedded (a loud warning — the viewer substitutes; a reported degradation).
   */
  async ensureFonts(faces) {
    for (const { font: fontId, bold } of faces) {
      if (!hasEmbeddableFile(fontId)) continue; // system — OS stack, nothing to embed
      const basename = fontFileFor(fontId, bold);
      if (!this.loadFontBytes) {
        console.warn(`svg_backend: font "${fontId}" (${bold ? "bold" : "regular"}) has a committed file (${basename}) but no loadFontBytes seam was provided — the family is named but NOT embedded, so a viewer substitutes it (not offline-clean). Pass irToSVG opts.loadFontBytes.`);
        continue;
      }
      const bytes = await this.loadFontBytes(basename);
      const b64 = bytesToBase64(bytes);
      // Unique family per fonts.js (cssFamily), so no OS-font collision.
      const family = FAMILY_BARE(fontId);
      this._fontFaces.push(
        `@font-face{font-family:"${family}";font-weight:${bold ? "700" : "400"};font-style:normal;` +
        `src:url("data:font/ttf;base64,${b64}") format("truetype");}`,
      );
    }
  }

  /**
   * Command (async). Resolves each distinct image `ref` to a self-contained
   * data: URI (the SVG must inline every asset — OFFLINE rule). A ref that is
   * ALREADY a data URI is used verbatim (no resolver needed); any other ref (a
   * URL) requires the injected resolveImageHref to fetch + inline it. A 1×1
   * fully-transparent blank (the widget's default src) maps to null → draw
   * nothing (matching the GPU skip / pdf_backend's null XObject). No resolver +
   * a URL ref = a loud error (no external ref, no silent drop).
   */
  async ensureImages(refs) {
    for (const ref of refs) {
      if (this._imageHrefs.has(ref)) continue;
      this._imageHrefs.set(ref, await this._resolveHref(ref, "image"));
    }
  }

  /**
   * Command (async). Grabs each distinct video `ref`'s CURRENT FRAME (via the
   * injected videoFrame resolver) and inlines it as a data: URI (manifest: a
   * video exports as its current frame — a raster embed). A blank/undrawable
   * frame maps to null. No videoFrame resolver + a video op = a loud error.
   */
  async ensureVideoFrames(refs) {
    if (refs.length === 0) return;
    if (!this.videoFrame)
      throw new Error(`svg_backend: scene has a video op but no videoFrame resolver was provided (a video exports as its current frame — pass irToSVG opts.videoFrame)`);
    for (const ref of refs) {
      if (this._videoHrefs.has(ref)) continue;
      const frame = await this.videoFrame(ref); // {mime, bytes} | null
      if (!frame || !frame.bytes || frame.bytes.length === 0) { this._videoHrefs.set(ref, null); continue; }
      this._videoHrefs.set(ref, `data:${frame.mime};base64,${bytesToBase64(frame.bytes)}`);
    }
  }

  /** Query (async). One image ref → data URI or null (blank). A data-URI ref is
   * checked for the 1×1 blank marker in-module; a URL ref uses the resolver. */
  async _resolveHref(ref, kind) {
    if (typeof ref !== "string" || ref.length === 0)
      throw new Error(`svg_backend: ${kind} ref must be a non-empty string, got ${JSON.stringify(ref)}`);
    if (ref.startsWith("data:")) {
      // The widget's BLANK_SRC default is a 1×1 transparent PNG — inline it, the
      // viewer draws a 1×1 nothing; matching pdf_backend, treat a byte-tiny PNG
      // as blank so it draws nothing. Cheap heuristic (decode length) — a real
      // image is far larger than a 1×1.
      const { bytes } = decodeDataUri(ref);
      if (bytes.length <= BLANK_PNG_MAX_BYTES) return null;
      return ref;
    }
    if (!this.resolveImageHref)
      throw new Error(`svg_backend: ${kind} ref "${truncateRef(ref)}" is a URL, but no resolveImageHref seam was provided — the SVG must be self-contained (inline every asset). Pass irToSVG opts.resolveImageHref.`);
    const href = await this.resolveImageHref(ref);
    if (typeof href !== "string" || !href.startsWith("data:"))
      throw new Error(`svg_backend: resolveImageHref("${truncateRef(ref)}") must return a data: URI (the SVG must be self-contained), got ${JSON.stringify(truncateRef(String(href)))}`);
    return href;
  }

  /** Query. The resolved data-URI href for a pre-loaded image ref, or null for a
   * blank/undrawable src. Throws if the ref was never loaded (a bug — emit runs
   * only after ensureImages scanned the same list). */
  imageHref(ref) {
    if (!this._imageHrefs.has(ref))
      throw new Error(`svg_backend: image ref "${truncateRef(ref)}" not resolved (image op outside the scanned command list?)`);
    return this._imageHrefs.get(ref);
  }

  /** Query. The resolved data-URI href for a pre-loaded video current frame, or
   * null. Throws if the ref was never loaded. */
  videoHref(ref) {
    if (!this._videoHrefs.has(ref))
      throw new Error(`svg_backend: video ref "${truncateRef(ref)}" not resolved (video op outside the scanned command list?)`);
    return this._videoHrefs.get(ref);
  }

  /** Query. Baseline offset as a fraction of font size for (fontId, bold): the
   * caller-measured canvas ascent when provided (GPU-atlas parity — see irToSVG
   * textAscent), else a conservative default with a one-time loud warning. */
  ascentFraction(fontId, bold) {
    if (typeof this.textAscent === "function") return this.textAscent(fontId, bold);
    if (this.textAscent !== null) return this.textAscent;
    if (!this._warnedAscent) {
      console.warn(`svg_backend: no textAscent measure provided — using the ${DEFAULT_ASCENT_FRACTION} default baseline fraction, which will NOT match the GPU atlas per-font baselines. Pass irToSVG opts.textAscent (pdfFonts.measureTextAscent).`);
      this._warnedAscent = true;
    }
    return DEFAULT_ASCENT_FRACTION;
  }

  /** Query. The rich-text layout measure seam (str, run-style) → {width, ascent,
   * descent}, adapting the injected measureText to the shape core/richtext's
   * layout expects — the SAME seam the PDF backend uses (ctx.richMeasure), so
   * both vector backends lay text out identically (the parity lever). Throws if
   * no seam was provided (a rich op needs real metrics — no silent default). */
  richMeasure() {
    if (!this.measureText) throw new Error("svg_backend: rich text layout needs a measureText seam (irToSVG opts.measureText)");
    return (str, style) => this.measureText(str, { size: style.size ?? DEFAULT_TEXT_SIZE, bold: !!style.bold, font: style.font ?? DEFAULT_FONT, italic: !!style.italic });
  }

  /**
   * Command (async; returns an SVG <image> fragment). Rasterizes `rawCmds`
   * through the injected callback and returns an <image> embedding the PNG as a
   * data URI — the SVG twin of pdf_backend.emitRasterRegion. `placeRect` (WORLD
   * coords in the current view <g> frame) is where the image lands; `srcRect`
   * (default placeRect) is the world region the pixels sample (they differ only
   * for the deep-lens fallback). Resolution: placeRect at the region view's px
   * density × rasterScale. Unlike PDF's y-up flip, SVG <image> is already y-down,
   * so the placeRect maps 1:1 (top-left origin, no flip).
   */
  async rasterRegion(rawCmds, { placeRect, srcRect = placeRect, srcView, background }) {
    // BRANDED so the per-node export boundary (emitRegionSVG) RETHROWS it instead
    // of containing it — the PDF twin's reasoning, verbatim.
    if (!this.rasterize)
      throw configurationError(new Error("svg_backend: scene needs a raster region (blur / deep lens) but no rasterize callback was provided"));
    const density = srcView.zoom * this.rasterScale; // px per world unit at the placed location
    const wPx = Math.max(1, Math.round(placeRect.w * density));
    const hPx = Math.max(1, Math.round(placeRect.h * density));
    const rasterView = {
      zoom: wPx / srcRect.w,
      panX: -srcRect.x * (wPx / srcRect.w),
      panY: -srcRect.y * (hPx / srcRect.h),
      dpr: 1,
    };
    // The region background goes to the rasterizer BOTH as a drawn rect and as the
    // clear — the pdf_backend.emitRasterRegion convention, imported not re-derived.
    // A BACKDROP SAMPLER inside the region re-renders the below-content into its own
    // offscreen and never sees a surface clear, so without the drawn rect a material
    // (metaballs / comic halftone / glass) samples transparency and exports BLACK.
    const png = await this.rasterize(regionOverBackground(rawCmds, srcRect, background), rasterView, wPx, hPx, background);
    const href = `data:image/png;base64,${bytesToBase64(png)}`;
    return `<image x="${fmt(placeRect.x)}" y="${fmt(placeRect.y)}" width="${fmt(placeRect.w)}" height="${fmt(placeRect.h)}"` +
      ` preserveAspectRatio="none" href="${href}"/>`;
  }
}

/** The @font-face `font-family` value for a committed id (fonts.js cssFamily,
 * bare — cssFamilyFor adds the generic fallback for <text>, but @font-face names
 * exactly the face). */
function FAMILY_BARE(fontId) {
  // cssFamilyFor returns `"Family", generic`; @font-face wants just `Family`.
  return cssFamilyFor(fontId).replace(/^"([^"]*)".*/, "$1");
}

/** Conservative top→baseline fraction when no measure is available. ~0.8em is
 * the usual cap-plus-ascent fraction for a Latin sans face; a real export always
 * passes a measured per-font value (pdfFonts.measureTextAscent). */
const DEFAULT_ASCENT_FRACTION = 0.8;

/** A data-URI PNG at or below this many bytes is treated as the widget's 1×1
 * blank default (draw nothing) — the same "no visible content" skip as
 * pdf_backend's 1×1 XObject check, applied to the encoded size (a 1×1 PNG is
 * ~70 bytes; any real image is far larger). */
const BLANK_PNG_MAX_BYTES = 128;

/** Pure function. Uint8Array → base64 (Buffer in node, btoa in the browser).
 * Chunked so a large image can't blow the call stack on the spread.
 * @example bytesToBase64(new Uint8Array([0, 0, 0])) // "AAAA"
 */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** Pure function. Shortens a long ref (a data URI) for an error message: the
 * first 40 chars plus a "…(N chars)" suffix; short refs pass through unchanged.
 * @example truncateRef("short") // "short"
 * @example truncateRef("data:image/png;base64," + "A".repeat(40)) // "data:image/png;base64,AAAAAAAAAAAAAAAAAA…(62 chars)"
 */
export function truncateRef(ref) {
  return ref.length <= 40 ? ref : `${ref.slice(0, 40)}…(${ref.length} chars)`;
}
