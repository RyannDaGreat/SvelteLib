/**
 * Browser Skia media resolver — turns a scene's image/video refs into the
 * `media` map (ref → CanvasKit.Image) that paint_skia.js draws from.
 *
 * THE MISSING SEAM (2026-07-23 render rewrite): the retired WebGPU compositor
 * consulted image_registry/video_registry ITSELF, resolving each ref to a GPU
 * texture inside the render. The Skia paint path instead takes a plain
 * {ref → CanvasKit.Image} map from its caller — and nobody was building it, so
 * every image/video op drew nothing (or threw "no media Image for ref"). This
 * module is that caller-side bridge, shared by BOTH on-screen surfaces
 * (render_gpu/skia/browser_surface.js) and the offscreen pixel service
 * (web/gpuService.js — thumbnails/minimap/PNG export):
 *   - IMAGES (real data:/URL widgets AND injected pdf-page rasters) resolve
 *     through image_registry.getSkiaImage — decoded once, cached by ref forever
 *     (static sources). An undecoded ref is simply ABSENT from the map, so
 *     paint_skia draws nothing for it and repaints when image_registry's
 *     onImageLoad fires (the async contract; never a placeholder, never a block).
 *   - VIDEOS resolve through video_registry.getSkiaVideoFrame, which grabs the
 *     <video> element's CURRENT frame — a FRESH CanvasKit Image per paint (a
 *     video moves), collected in `release()` and deleted after the frame is
 *     painted. onVideoFrame drives the per-frame repaint.
 *
 * Browser-only (the registries need fetch/createImageBitmap/<video>). The Node
 * CLI passes its own media map (today: empty — see cli/render.js).
 */

import { getSkiaImage } from "../gpu/image_registry.js";
import { getSkiaVideoFrame } from "../gpu/video_registry.js";

/**
 * Pure function. The DISTINCT refs of `op` in an IR list, recursing into the
 * content-carrying ops (cropSubtree/effectSubtree) exactly like pdf_backend's
 * refsOfOp — a bordered/cropped/effected image nests its op inside `content`,
 * so a top-level-only scan would miss it. Kept local (NOT imported from
 * pdf_backend) so the editor hot path never pulls pdf-lib into its bundle.
 *
 * @example refsForOp([{op: "image", ref: "a"}, {op: "image", ref: "a"}], "image") // ["a"]
 * @example refsForOp([{op: "rect"}], "image") // []
 * @example refsForOp([{op: "cropSubtree", content: [{op: "video", ref: "c"}]}], "video") // ["c"]
 */
export function refsForOp(commands, op) {
  const seen = new Set();
  const walk = (cmds) => {
    for (const c of cmds) {
      if (c.op === op) seen.add(c.ref);
      if ((c.op === "cropSubtree" || c.op === "effectSubtree") && Array.isArray(c.content)) walk(c.content);
    }
  };
  walk(commands);
  return [...seen];
}

/**
 * Query→build (kicks async image decodes; grabs current video frames). Builds
 * the {ref → CanvasKit.Image} media map for every image/video ref present in
 * `commands`, using the shared browser `CanvasKit`. Returns {media, release}:
 *   media   — the map: a ready image / current video frame per resolvable ref.
 *             An undecoded image ref is OMITTED (paint_skia draws nothing and
 *             repaints on load); a genuinely failed asset was reported loudly by
 *             the registry, not here.
 *   release — Command. Deletes the per-paint VIDEO frame Images (still images
 *             are cached in the registry and must NOT be deleted). Call AFTER
 *             the frame is flushed / read back.
 *
 * @example // const {media, release} = sceneMedia(CanvasKit, ir); paintIR(CanvasKit, canvas, ir, view, {media, ...}); surface.flush(); release();
 */
export function sceneMedia(CanvasKit, commands) {
  const media = {};
  const frames = [];
  for (const ref of refsForOp(commands, "image")) {
    const img = getSkiaImage(CanvasKit, ref);
    if (img) media[ref] = img;
  }
  for (const ref of refsForOp(commands, "video")) {
    const frame = getSkiaVideoFrame(CanvasKit, ref);
    if (frame) { media[ref] = frame; frames.push(frame); }
  }
  return { media, release() { for (const f of frames) f.delete(); } };
}
