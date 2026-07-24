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
 *     <video> element's CURRENT frame via the caller-supplied UPLOADER. On the
 *     GPU uploader (on-screen/presenter surface) the frame is a REUSED
 *     texture-backed Image (uploaded straight to a GL texture, no CPU readback)
 *     the registry owns — NOT released here. On the CPU uploader (this offscreen
 *     pixel service, headless) it is a FRESH readback Image, collected in
 *     `release()` and deleted after the frame is painted. onVideoFrame drives the
 *     per-frame repaint.
 *
 * THE UPLOADER (render_gpu/gpu/video_registry.makeGpuUploader / makeCpuUploader)
 * is the seam that lets ONE grab path serve both a GPU surface (fast, no readback)
 * and a software surface (the guarded CPU fallback); it also carries the shared
 * `CanvasKit` module (uploader.CanvasKit) the still-image path reads.
 *
 * Browser-only (the registries need fetch/createImageBitmap/<video>). The Node
 * CLI passes its own media map (today: empty — see cli/render.js).
 */

import { getSkiaImage } from "../gpu/image_registry.js";
import { getSkiaVideoFrame, getScrubFrame, requestScrubFrame } from "../gpu/video_registry.js";
import { scrubFrameKey } from "../ir.js";

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
 * Pure function. The DISTINCT scrubber requests in `commands` — one {ref,
 * seekTime, wrap} per unique scrubFrameKey — recursing into cropSubtree/
 * effectSubtree content like refsForOp (a bordered/cropped/effected scrubber
 * nests its videoFrame op inside `content`). Deduped by key so N synced
 * scrubbers (same source + time) collapse to ONE decode request.
 *
 * @example scrubOpsOf([{op: "videoFrame", ref: "a", seekTime: 1, wrap: "clamp"}]).length // 1
 * @example scrubOpsOf([{op: "videoFrame", ref: "a", seekTime: 1, wrap: "clamp"}, {op: "videoFrame", ref: "a", seekTime: 1, wrap: "clamp"}]).length // 1 (same key)
 * @example scrubOpsOf([{op: "cropSubtree", content: [{op: "videoFrame", ref: "c", seekTime: 2, wrap: "loop"}]}])[0].ref // "c"
 */
export function scrubOpsOf(commands) {
  const byKey = new Map();
  const walk = (cmds) => {
    for (const c of cmds) {
      if (c.op === "videoFrame") byKey.set(scrubFrameKey(c.ref, c.seekTime, c.wrap), { ref: c.ref, seekTime: c.seekTime, wrap: c.wrap });
      if ((c.op === "cropSubtree" || c.op === "effectSubtree") && Array.isArray(c.content)) walk(c.content);
    }
  };
  walk(commands);
  return [...byKey.values()];
}

/**
 * Command (async). Seeks + awaits EVERY scrubber frame the scene needs, so the
 * one-shot pixel paths (web/gpuService.js: thumbnails, PNG export, the puppeteer
 * render hook) are DETERMINISTIC — sceneMedia's sync getScrubFrame then finds
 * each frame already in the LRU. A no-op for a scene with no scrubbers. Failed
 * frames resolve null (reported loudly by the registry) and simply draw nothing.
 *
 * @param uploader a GPU or CPU uploader (video_registry.makeGpuUploader / makeCpuUploader)
 * @example // await prepareSceneScrubFrames(uploader, ir); const {media} = sceneMedia(uploader, ir);
 */
export async function prepareSceneScrubFrames(uploader, commands) {
  const ops = scrubOpsOf(commands);
  if (ops.length === 0) return;
  await Promise.all(ops.map((o) => requestScrubFrame(uploader, o.ref, o.seekTime, o.wrap)));
}

/**
 * Query→build (kicks async image decodes; grabs current video frames). Builds
 * the {ref → CanvasKit.Image} media map for every image/video ref present in
 * `commands`, using the caller's `uploader` (which carries the shared
 * `CanvasKit`). Returns {media, release}:
 *   media   — the map: a ready image / current video frame per resolvable ref.
 *             An undecoded image ref is OMITTED (paint_skia draws nothing and
 *             repaints on load); a genuinely failed asset was reported loudly by
 *             the registry, not here.
 *   release — Command. Deletes ONLY the CPU-uploader per-paint video frame Images.
 *             GPU player frames are REUSED texture Images the registry owns (never
 *             deleted here — that would destroy the reusable texture); still images
 *             and scrub frames are registry/LRU-owned too. Call AFTER the frame is
 *             flushed / read back.
 *
 * @param uploader a GPU or CPU uploader (video_registry.makeGpuUploader / makeCpuUploader)
 * @example // const {media, release} = sceneMedia(uploader, ir); paintIR(uploader.CanvasKit, canvas, ir, view, {media, ...}); surface.flush(); release();
 */
export function sceneMedia(uploader, commands) {
  const CanvasKit = uploader.CanvasKit;
  const media = {};
  const frames = []; // CPU per-paint player frames to delete after paint; GPU frames are registry-owned (reused in place)
  for (const ref of refsForOp(commands, "image")) {
    const img = getSkiaImage(CanvasKit, ref);
    if (img) media[ref] = img;
  }
  for (const ref of refsForOp(commands, "video")) {
    const frame = getSkiaVideoFrame(uploader, ref);
    if (frame) {
      media[ref] = frame;
      if (!uploader.isGpu) frames.push(frame); // CPU: fresh readback Image → release deletes it. GPU: reused in place → do NOT delete.
    }
  }
  // SCRUBBER frames: keyed by scrubFrameKey (ref+time+wrap) so two scrubbers on
  // one source at different times don't collide. getScrubFrame returns a CACHED
  // (LRU-owned) Image or null (draw nothing + repaint on land) — so these are
  // NOT pushed to `frames`: release() must NOT delete them (unlike per-paint
  // player frames), the LRU owns their lifetime.
  for (const o of scrubOpsOf(commands)) {
    const frame = getScrubFrame(uploader, o.ref, o.seekTime, o.wrap);
    if (frame) media[scrubFrameKey(o.ref, o.seekTime, o.wrap)] = frame;
  }
  return { media, release() { for (const f of frames) f.delete(); } };
}
