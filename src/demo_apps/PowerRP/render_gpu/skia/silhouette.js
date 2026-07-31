/**
 * THE SILHOUETTE UNION PATH — the geometry behind an SVG/iconify widget's border
 * tracing its true glyph outline instead of its bounding box.
 *
 * ── THE PROBLEM IT SOLVES ─────────────────────────────────────────────────────
 * `render_gpu/decorate.js`'s shared stroked-box border (decorateStrokedBox) draws
 * a plain rounded RECT ring — correct for image/video/latex/pdf_page/mermaid/…
 * (rectangular content), wrong for an SVG/iconify glyph: a heart icon's border hugs
 * its bbox corners, not its curve, and a multi-subpath icon (e.g. a donut, or two
 * disjoint glyphs sharing one widget) gets one rect around the whole cluster
 * instead of a ring around each piece.
 *
 * ── THE FIX ───────────────────────────────────────────────────────────────────
 * The border traces the UNION of every content op's own filled path (respecting
 * that op's own fill rule), built ONCE via successive CanvasKit.Path.MakeFromOp
 * unions — exactly the boolean-op machinery drawDetachedContourStroke
 * (paint_skia.js) already uses for a detached parallel contour, generalized from
 * "one shape's own outline" to "the union of N shapes' outlines". A disjoint
 * subpath contributes its own separate outline to the union (CanvasKit's boolean
 * ops handle disjoint operands natively — verified in bare-node canvaskit-wasm, no
 * fallback needed), so the union's boundary is exactly "one ring per visible piece".
 *
 * DOM-free at import (pure CanvasKit calls only, the shape_sdf.js documented
 * pattern), so this runs on the bare-node software surface the CLI uses.
 *
 * Deliberately does NOT import from ./paint_skia.js (paint_skia is the painter and
 * imports helpers, never the reverse — see shape_sdf.js/materials.js for the same
 * shape) — it owns a minimal, local copy of "shape op -> local Skia path" geometry
 * building, mirroring shapeOpLocalPath's addOpGeometry switch.
 *
 * ── THE VIEWBOX TRANSFORM (why this imports flattenIR) ─────────────────────────
 * A decorated widget's content is NOT always bare shape ops: render_gpu/gpu/
 * svg_raster.js's svgToIRWithWarnings wraps its flattened path ops in ONE
 * pushTransform/popTransform pair whenever `preserveAspect` maps a non-1:1
 * viewBox into the widget's box (the common case — nearly every iconify icon is
 * authored at viewBox="0 0 24 24" and dropped into an arbitrarily-sized box).
 * Filtering `contentOps` down to SILHOUETTE_SHAPE_OPS BEFORE resolving that
 * transform would silently drop the push/pop and union the paths in raw
 * viewBox-local coordinates — geometrically the right SHAPE, but at the wrong
 * SCALE and POSITION relative to the box the border must actually trace (a
 * viewBox="0 0 24 24" icon in a 200x200 box would trace a border confined to
 * the top-left ~25x25 px corner). ir.js's flattenIR is the codebase's one
 * transform-stack resolver (every backend already flattens `content` through
 * it — see decorate.js's module header), so this module runs contentOps
 * through it FIRST and only then filters + unions, exactly like a backend would.
 */

import { flattenIR } from "../ir.js";

/**
 * Command (mutates `b`). Appends ONE shape op's geometry (rect/ellipse/polygon/
 * path) to a PathBuilder, in the op's own LOCAL space — the silhouette twin of
 * paint_skia.js's addOpGeometry (kept local rather than imported; see module
 * header). Non-shape ops (text, image, …) are the caller's concern — this throws
 * on them exactly like the painter's copy does, since a caller that reaches here
 * is expected to have already filtered to shape ops (see silhouettePathD).
 */
function addSilhouetteOpGeometry(CanvasKit, b, cmd) {
  switch (cmd.op) {
    case "rect":
      b.addRRect(CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h), cmd.cornerRadius ?? 0, cmd.cornerRadius ?? 0));
      break;
    case "ellipse":
      b.addOval(CanvasKit.LTRBRect(cmd.cx - cmd.rx, cmd.cy - cmd.ry, cmd.cx + cmd.rx, cmd.cy + cmd.ry));
      break;
    case "polygon": {
      b.moveTo(cmd.points[0][0], cmd.points[0][1]);
      for (let i = 1; i < cmd.points.length; i++) b.lineTo(cmd.points[i][0], cmd.points[i][1]);
      b.close();
      break;
    }
    case "path": {
      const p = CanvasKit.Path.MakeFromSVGString(cmd.d);
      if (!p) throw new Error(`silhouette: op "d" failed to parse as an SVG path: ${JSON.stringify(cmd.d).slice(0, 64)}`);
      b.addPath(p);
      p.delete();
      break;
    }
    default:
      throw new Error(`silhouette: op "${cmd.op}" is not a shape op (rect/ellipse/polygon/path) — filter to SILHOUETTE_SHAPE_OPS before calling`);
  }
}

/** The op kinds silhouettePathD can trace. Non-shape ops (text, image, the error/
 * warning affordance's `text` op, …) are skipped by callers before reaching here —
 * see plugins/svg.js and plugins/iconify.js's decorateSilhouetteBorder call sites. */
export const SILHOUETTE_SHAPE_OPS = new Set(["rect", "ellipse", "polygon", "path"]);

/**
 * Pure→build (allocates; caller deletes). The CanvasKit.Matrix for a flattened
 * `world` similarity ({x, y, rotation, scale, signX?, signY?} — core/transform.js
 * shape), composed translate·rotate·scale exactly like paint_skia.js's
 * deviceMatrix/applyView build the same similarity elsewhere in this codebase
 * (rotation is RADIANS — CanvasKit.Matrix.rotated's own unit, verified against
 * deviceMatrix's identical call with no degree conversion).
 */
function worldMatrix(CanvasKit, world) {
  return CanvasKit.Matrix.multiply(
    CanvasKit.Matrix.translated(world.x, world.y),
    CanvasKit.Matrix.rotated(world.rotation),
    CanvasKit.Matrix.scaled(world.scale * (world.signX ?? 1), world.scale * (world.signY ?? 1)),
  );
}

/**
 * Query→build (allocates; caller deletes). ONE content op's own filled path, in
 * ITS OWN LOCAL space then mapped into the content array's shared space by
 * `world` (the flattened transform silhouetteUnionPath resolved from any
 * pushTransform/popTransform wrapping — see the module header's viewBox note;
 * `world` is the identity transform when there was none to resolve). Fill rule
 * honored (setFillType) — matching paint_skia.js shapeOpLocalPath's pattern,
 * generalized to also respect fillRule (a shape op's winding choice affects
 * which regions of a self-intersecting path are "inside" for the union below).
 */
function contentOpPath(CanvasKit, cmd, world) {
  const b = new CanvasKit.PathBuilder();
  addSilhouetteOpGeometry(CanvasKit, b, cmd);
  // Applied on the BUILDER, before detach: CanvasKit's Path (unlike PathBuilder)
  // has no transform() method in this canvaskit-wasm build (verified) — the
  // world matrix must be baked in here, not on the detached Path afterward.
  b.transform(worldMatrix(CanvasKit, world));
  const path = b.detach();
  b.delete();
  if (cmd.fillRule === "evenodd") path.setFillType(CanvasKit.FillType.EvenOdd);
  return path;
}

/**
 * Query→build (allocates; deletes its own scratch paths). The UNION of every
 * shape op's own filled path — the silhouette outline a border should trace.
 * Ops that are not in SILHOUETTE_SHAPE_OPS (text, image, …) are skipped (a
 * decorated SVG's error/warning affordance mixes `text` ops into `content`; they
 * contribute no ink to the glyph silhouette). Returns `null` for no shape ops at
 * all (nothing to trace — caller falls back to the ordinary rect border).
 *
 * `contentOps` is run through ir.js's flattenIR FIRST (the module header's
 * viewBox note): any pushTransform/popTransform wrapping the shape ops (the
 * viewBox→box mapping svgToIRWithWarnings emits) is resolved into a `world`
 * similarity per op BEFORE its geometry is built, so a scaled/offset viewBox
 * traces its border at the box's actual scale — not at raw viewBox coordinates.
 *
 * VERIFIED FACT (this module's whole reason to need no fallback): CanvasKit.Path.
 * MakeFromOp(a, b, Union) unions disjoint operands correctly in bare-node
 * canvaskit-wasm — a multi-subpath icon (e.g. two disconnected glyph pieces)
 * unions into a path whose boundary traces BOTH pieces separately, not a single
 * bbox-spanning blob.
 *
 * @param {object} CanvasKit
 * @param {object[]} contentOps - a widget's own content ops (local space,
 *   possibly wrapped in pushTransform/popTransform)
 * @returns {object|null} a CanvasKit Path (caller deletes), or null
 */
export function silhouetteUnionPath(CanvasKit, contentOps) {
  const shapeOps = flattenIR(contentOps).filter(({ cmd }) => SILHOUETTE_SHAPE_OPS.has(cmd.op));
  if (shapeOps.length === 0) return null;
  let union = contentOpPath(CanvasKit, shapeOps[0].cmd, shapeOps[0].world);
  for (let i = 1; i < shapeOps.length; i++) {
    const next = contentOpPath(CanvasKit, shapeOps[i].cmd, shapeOps[i].world);
    const merged = CanvasKit.Path.MakeFromOp(union, next, CanvasKit.PathOp.Union);
    union.delete();
    next.delete();
    if (!merged) throw new Error(`silhouette: Path.MakeFromOp(Union) returned null unioning content op ${i} — a malformed op pair (report, do not swallow)`);
    union = merged;
  }
  return union;
}

// ── the CONTENT-IDENTITY cache ────────────────────────────────────────────────
// Building the union is a handful of path-parse + boolean-op calls per frame per
// widget — cheap once, wasteful to redo every paint when the widget's OWN content
// hasn't changed. Cached by CONTENT IDENTITY (the same `contentOps` array
// reference plugins/svg.js and plugins/iconify.js already memoize their parsed IR
// under — see svgToIRWithWarnings's adapter memo), not by geometry hash: a cheap
// `===` check, and a fresh contentOps array (new SVG source, resized box, …) is
// always a genuinely different silhouette anyway.
const SILHOUETTE_CACHE_MAX = 24; // distinct widgets' silhouettes kept at once
const _silhouetteCache = new Map(); // contentOps (array identity) -> {d, CanvasKit}

/**
 * Query→build (near-pure: reads/writes the module cache; the RESULT is a pure
 * function of contentOps' geometry). The silhouette border path, as an SVG `d`
 * string, for a widget's own content ops — cached by content-array IDENTITY so a
 * repaint of an unchanged widget reuses the prior union instead of rebuilding it.
 * `null` when there are no shape ops to trace (caller keeps the ordinary rect
 * border).
 *
 * A cache hit from a DIFFERENT CanvasKit instance (module reload, node vs
 * browser) is a miss (the two runtimes' path objects don't interoperate) — the
 * cache clears itself on that switch instead of serving a stale string (stale
 * strings are harmless here since the store is just text, but clearing keeps the
 * cache from growing unboundedly across instances).
 *
 * @param {object} CanvasKit
 * @param {object[]} contentOps - a widget's own content ops (local space)
 * @returns {string|null}
 *
 * @example // silhouettePathD(CanvasKit, [{op: "path", d: "M0 0 L10 0 L10 10 Z"}]) -> "M10 0L0 0L10 10Z" (a triangle, traced not boxed)
 * @example // silhouettePathD(CanvasKit, [{op: "text", ...}]) -> null (no shape ops; caller falls back to a rect border)
 */
export function silhouettePathD(CanvasKit, contentOps) {
  const cached = _silhouetteCache.get(contentOps);
  if (cached && cached.CanvasKit === CanvasKit) {
    _silhouetteCache.delete(contentOps); _silhouetteCache.set(contentOps, cached); // LRU touch
    return cached.d;
  }
  const union = silhouetteUnionPath(CanvasKit, contentOps);
  const d = union ? union.toSVGString() : null;
  if (union) union.delete();
  _silhouetteCache.set(contentOps, { d, CanvasKit });
  while (_silhouetteCache.size > SILHOUETTE_CACHE_MAX) {
    const oldest = _silhouetteCache.keys().next().value;
    _silhouetteCache.delete(oldest);
  }
  return d;
}

/** Command. Drops the entire silhouette-path cache — exposed for tests that
 * assert a clean slate (the shape_sdf.js clearShapeSdfCache precedent). */
export function clearSilhouetteCache() {
  _silhouetteCache.clear();
}

// ── EXPORT-TIME STAMPING ───────────────────────────────────────────────────────

/**
 * Pure function (the silhouette cache aside — see silhouettePathD). Stamps
 * `cmd.borderPath` (an SVG `d` string) onto every `cmd.silhouette` cropSubtree op
 * in a flat IR list, recursing into `content` exactly like render_gpu/ports.js
 * resolveMaterialFillPaints does (crop/effect subtrees are flattened
 * independently and would otherwise escape). Ops without `cmd.silhouette` pass
 * through IDENTICALLY (same object, zero cost on the common path) — this
 * mirrors resolveMaterialFillPaints' "untouched ops are untouched" contract.
 *
 * WHY A SEPARATE PRE-PASS AND NOT PAINT-TIME COMPUTATION: the PDF/SVG vector
 * backends (pdf_backend.js, svg_backend.js) are DOM-free/CanvasKit-free by
 * manifest rule — they cannot call CanvasKit.Path.MakeFromOp themselves. This
 * pass runs ONCE, before handing the IR to either backend, with a CanvasKit
 * instance the browser (web/app.svelte.js exportPdf/exportSvg) or the CLI
 * (cli/render.js, cli/render_job.js's page half) already has in hand — never
 * inside render_gpu/ports.js sceneIR itself, which stays sync and
 * CanvasKit-free (the manifest's "ports.js sceneIR is DOM-free pure JS" rule).
 *
 * A `cmd.silhouette` op with no traceable shape ops (silhouettePathD returns
 * null — e.g. a GHOST svg with only an error/warning affordance) is stamped with
 * `borderPath: null`, telling the backends to fall back to their ordinary
 * rounded-rect border path (pdf_backend.js emitCrop / svg_backend.js
 * emitCropSVG), exactly matching paint_skia.js handleCropSubtree's own fallback.
 *
 * @param {object[]} cmds - a flat IR command list (sceneIR's output, or any
 *   node's own emitted ops before flattening — recurses into `content`)
 * @param {object} CanvasKit - a loaded CanvasKit instance
 * @returns {object[]}
 *
 * @example // a silhouette op's `d` traces the union, not the bbox — see silhouette_test.js
 * @example // resolveSilhouetteBorders([{op: "cropSubtree", silhouette: true, silhouetteContent: [{op: "path", d: "M0 0h10v10h-10z"}], content: []}], CanvasKit)[0].borderPath -> a "d" string tracing the 10x10 square, not a rounded-rect literal
 * @example resolveSilhouetteBorders([{op: "rect", x: 0, y: 0, w: 1, h: 1}], null) // [{op: "rect", x: 0, y: 0, w: 1, h: 1}] (no silhouette op -> untouched, no CanvasKit needed)
 */
export function resolveSilhouetteBorders(cmds, CanvasKit) {
  return cmds.map((cmd) => {
    let out = cmd;
    if (cmd.silhouette) out = { ...out, borderPath: silhouettePathD(CanvasKit, cmd.silhouetteContent) };
    if (Array.isArray(cmd.content)) {
      const content = resolveSilhouetteBorders(cmd.content, CanvasKit);
      if (content.some((c, i) => c !== cmd.content[i])) out = { ...out, content };
    }
    return out;
  });
}
