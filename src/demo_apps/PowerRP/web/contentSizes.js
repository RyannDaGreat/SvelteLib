/**
 * THE CONTENT-SIZE PRODUCER — the web layer's half of #277.
 *
 * core/content_size.js explains WHY intrinsic size is an INPUT to evaluation
 * rather than a lookup from inside it. This is the thing that produces that
 * input: it asks the media registries what they have already measured and hands
 * back a table keyed by itemId.
 *
 * ── A PULL, NOT A PUBLISH ────────────────────────────────────────────────────
 * The obvious design is push — each registry calls `publishContentSize` when a
 * decode lands. This does the opposite: it READS the registries on demand, from
 * the current state. Three reasons, and the third is the one that decided it:
 *   · the registries ALREADY hold the sizes (getImage's bitmap, getVideo's
 *     element, pdfPagePointSize's cache), so a push would be a second copy of
 *     something already recorded — the mirror defect this codebase keeps finding;
 *   · a push needs every raster path to remember to call it, and the one that
 *     forgets fails silently, which is exactly how R6-12's holes happened;
 *   · a pull cannot go stale. There is no ordering to get wrong.
 *
 * ── THE NEW-MAP CONTRACT ─────────────────────────────────────────────────────
 * `evaluateState` compares its content table BY REFERENCE, so a mutated Map would
 * be invisible to it and the bug would present as "it only updates when I nudge
 * something". This module therefore returns the SAME Map object while nothing has
 * changed and a FRESH one the moment anything has — decided by a signature string
 * over (itemId, src, measured size). That keeps the evaluator's memo hot during a
 * drag (the thing drag latency depends on) while still re-evaluating the instant
 * a decode lands.
 */

import { getImage } from "../render_gpu/gpu/image_registry.js";
import { getVideo } from "../render_gpu/gpu/video_registry.js";
import { pdfPagePointSize, ensurePdfPagePointSize } from "../render_gpu/gpu/pdf_page_raster.js";
/**
 * HOW A STORED REF BECOMES A LOADABLE URL — INJECTED, NOT IMPORTED.
 *
 * The obvious line here is `import { assetStoreFor } from "./storageMode.js"`,
 * and it was written that way first. It broke TWENTY-ONE bare-node suites:
 * web/cameraFrame.js imports this module, storageMode reaches web/projectApi.js,
 * and that file reads `location` at module scope — so every bare-node consumer of
 * the evaluation seam (cli/render.js among them) died on `location is not
 * defined` before running a line of its own.
 *
 * So the resolver is SET at boot by the browser app and defaults to identity.
 * Bare node then resolves a ref to itself, finds no measurement for it, and
 * degrades to exactly the unmeasured behaviour core/content_size.js already
 * defines — which is correct for a renderer that has no asset store anyway.
 */
let resolveSrc = (src) => src;

/** Command. Installs the ref → loadable-URL resolver (web/main.js, at boot).
 *  Called with `assetStoreFor(project).resolveUrl`-shaped access. */
export function setContentSrcResolver(fn) {
  resolveSrc = typeof fn === "function" ? fn : ((src) => src);
}

/**
 * How to measure each widget type's content, given its already-resolved src.
 * Keyed by widget TYPE rather than by asset kind, because the widget is what the
 * item declares and what decides which registry holds its pixels.
 *
 * A TYPE ABSENT HERE SIMPLY HAS NO INTRINSIC SIZE, which is the correct answer
 * for a rectangle. This is not the droppable-kinds roster (core/registry.js
 * `assetDrop`) and must not be conflated with it: `filmstrip` reads a video but
 * has no single intrinsic size, and `pdf_packet` shows many pages.
 */
const MEASURERS = {
  image: (src) => { const b = getImage(src); return b ? { w: b.width, h: b.height } : null; },
  video: (src) => { const v = getVideo(src); return v?.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null; },
  pdf_page: (src, s) => {
    const page = Number(s.page) || 1;
    // Idempotent kick: a PDF's size needs the document open, and nothing else on
    // this path would ask. Safe every call — it no-ops once cached or errored.
    ensurePdfPagePointSize(src, page);
    return pdfPagePointSize(src, page);
  },
};

/** The last table handed out, and the signature it was built from. */
let cached = new Map();
let cachedSignature = "";

/**
 * Query. The intrinsic-size table for a folded state — itemId → {w, h} for every
 * item whose content is measured and ready.
 *
 * SAME REFERENCE while nothing has changed, a fresh Map when anything has. See
 * the module docblock on why that matters to the evaluator's memo.
 *
 * @param {object} state - a folded/tweened state ({items})
 * @param {string} project - the owning project, for src resolution
 * @returns {Map<string, {w: number, h: number}>}
 */
export function contentSizesFor(state, project) {
  const items = state?.items ?? {};
  const next = new Map();
  const parts = [];
  for (const [itemId, s] of Object.entries(items)) {
    const measure = MEASURERS[s?.type];
    if (!measure || typeof s.src !== "string" || s.src.length === 0) continue;
    // THE ONE RESOLUTION SEAM (web/assetStore.js): a document stores a portable
    // ref and the registries are keyed by what can actually be loaded right now,
    // so the lookup has to go through the same adapter the renderer used.
    const size = measure(resolveSrc(s.src, project), s);
    if (!size || !(size.w > 0) || !(size.h > 0)) continue;
    next.set(itemId, { w: size.w, h: size.h });
    parts.push(`${itemId}:${s.src}:${size.w}x${size.h}`);
  }
  const signature = parts.sort().join("|");
  if (signature === cachedSignature) return cached;
  cachedSignature = signature;
  cached = next;
  return next;
}

/** Command. Drops the cache — a project switch changes which srcs resolve, so a
 *  table built under the old project must not be reused under the new one. */
export function resetContentSizes() {
  cached = new Map();
  cachedSignature = "";
}
