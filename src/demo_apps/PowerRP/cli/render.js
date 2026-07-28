/**
 * PowerRP headless CLI renderer (Skia/CanvasKit, Node).
 *
 * Renders any slide (at any tween alpha) of a .powerrp.json presentation to a
 * PNG, entirely in Node — no browser, no Vite, no puppeteer. It runs the EXACT
 * pipeline the editor's headless hook (web/main.js) runs: repair the document,
 * fold+evaluate the requested (slide, alpha), build THE camera-frame IR
 * (web/cameraFrame.js cameraFrameIR — the same recipe thumbnails/export/PNG
 * use), and paint it through render_gpu/skia/node_render.js onto a CanvasKit
 * CPU surface. Because paint_skia.js is shared with the browser WebGL2 path,
 * headless output matches the editor's.
 *
 * The camera rect at (slide, alpha) is the view: fitRectView maps it to fill
 * width×height at dpr 1 (identical to the editor's PNG export at that size),
 * and the camera background clears the frame (letterbox edges included).
 *
 * ══ THIS IS A STILL RENDERER. IT IS NOT THE VIDEO PATH, AND MUST NOT BECOME IT ══
 *
 * The server-side video backend USED to drive this file, and that was a mistake the
 * user overruled (manifest: "THE RENDERER IS ONE CODE PATH. THE BACKEND MUST USE
 * IT."). Video now renders through cli/render_job.js, which boots the real editor in
 * headless Chrome. Anyone tempted to wire this module to video again should read the
 * list below first — every item on it is something this path silently omits, and a
 * 900-frame render omitting them looks exactly like a 900-frame render.
 *
 * WHAT THIS PATH CANNOT DRAW, and why:
 *   · IMAGES, VIDEO, PDF PAGES, FILMSTRIP FRAMES — decoding needs
 *     `createImageBitmap`, which node does not have. An empty media map is passed, so
 *     these draw as NOTHING (paint_skia skips an unresolved ref — the async media
 *     contract — rather than throwing). `mediaOpCount` below counts them and the
 *     render prints a LOUD warning naming the count, because a blank where a
 *     photograph belongs must never be discovered later.
 *   · LATEX — MathJax needs a DOM; latex_raster reports the failure loudly and the
 *     equation draws as nothing.
 *   · MERMAID — its font load fails in node; likewise reported, likewise blank.
 *   · MOTION BLUR — sub-frame averaging needs a canvas.
 *   · A GPU, EVER — node_render.js calls `CanvasKit.MakeSurface`, a software surface
 *     with no grContext. It never asks for a context, so it is CPU-only on eight A100s
 *     just as it is here. (render_gpu/skia/browser_surface.js, by contrast, has no CPU
 *     branch at all: it always asks for WebGL2 and lets ANGLE bind SwiftShader, Mesa,
 *     or a real driver. That is why the browser worker gets a GPU for free and this
 *     cannot.)
 *
 * WHY IT IS KEPT ANYWAY (the ruling): it is the ONE renderer with no system
 * dependencies beyond node itself. cli/render_job.js needs Chrome and its ~30 shared
 * libraries (setup.sh installs them) and pays ~1.7 s of browser boot; this needs
 * neither, and renders a light vector/text slide in ~0.10 s. For a scripted figure
 * export, a CI check, or any machine where Chrome will not run, that is worth having
 * — and because paint_skia.js is shared, a deck WITHOUT the items listed above comes
 * out matching the editor. Reach for cli/render_job.js whenever the deck contains
 * media, LaTeX, Mermaid, or more than one frame.
 *
 * KNOWN BOUND (render rewrite Phase 1a, still open): paint_skia.js throws loudly on
 * some backdrop/effect ops it has not implemented. Widgets with effects OFF (the
 * default) render fine.
 *
 * ── WHY A HEAVY SLIDE TAKES MINUTES HERE, AND WHAT THE FLAG DOES ─────────────
 * This path shares paint_skia.js with the editor but NOT the GPU: node_render.js
 * rasterizes on `CanvasKit.MakeSurface`, a SOFTWARE surface, because node has no GL
 * context. Every generative material (lens flare, sky, halftone, CRT, glass,
 * corkboard, raycast) therefore runs its per-pixel SkSL on the CPU. Measured on a
 * 1920×1080 slide carrying nine heavy widgets plus an effected caption
 * (.frenzy/render_cost/probe_headless_cost.js): 56 s at full quality. The editor
 * draws the same slide at 60 fps because a GPU runs those shaders.
 *
 * Bounding the OFFSCREENS helped and cost nothing: the region-bounded backdrop
 * children (materials.materialSampleReach) and the bounded text/mermaid effect
 * substrates (paint_skia opLocalBounds) took that same slide from 64.7 s to 56.2 s
 * with BYTE-IDENTICAL output (33.3 M offscreen px down to 22.7 M). What is left is
 * not overhead — it is the shaders painting the pixels the slide actually asks for,
 * and at FULL quality it is irreducible on a CPU.
 *
 * So `--quality proxy` is offered as an EXPLICIT ESCAPE HATCH (0.16 s on that same
 * slide, ~350x), and it is deliberately awkward: it is never the default, an unknown
 * value is a hard error, and choosing it prints a LOUD warning naming exactly what it
 * is — the thumbnail stand-ins, NOT the editor's render. The invariant
 * `RenderTree = pure(document, [[slide, alpha]])` means a CLI render must not
 * silently differ from the editor; substituting cheap stand-ins for a real export
 * without saying so would be exactly the silent lie this codebase forbids. At full
 * quality a heavy slide instead prints a heads-up BEFORE the render, so a long wait
 * is explained rather than looking hung.
 *
 * Usage (from the SvelteLib repo root) — ONE still:
 *   node src/demo_apps/PowerRP/cli/render.js doc.powerrp.json out.png \
 *     [--slide 2] [--alpha 1] [--width 1920] [--height 1080] [--quality full|proxy]
 */

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "./args.js";
import { deserialize, repairedDocument, printRepairReports } from "../core/document.js";
import { cameraRect } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR, evaluatedStateAt } from "../web/cameraFrame.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { cameraAntialias, antialiasCoverage } from "../render_gpu/skia/render_settings.js";

const DEFAULTS = { slide: 0, alpha: 1, width: 1280, height: 720, quality: "full" };
const DPR = 1; // one PNG pixel per device pixel — matches the editor's PNG export.
// THE render tiers. "full" is the editor's render and the only default there can be;
// "proxy" is paint_skia's thumbnail stand-in path (see the header for why it is opt-in
// and loud). Anything else is a typo, and a typo must not pick a tier.
const QUALITIES = ["full", "proxy"];
// Ops whose cost is per-pixel SkSL on this software surface — what makes a heavy slide
// slow. Counted only to explain the wait; the render itself is unaffected.
const HEAVY_OPS = new Set(["materialBackdrop", "materialFill", "glassBackdrop", "magnifyBackdrop", "blurBackdrop"]);
// Below this many heavy ops the render is quick enough that a heads-up would be noise.
const HEAVY_OP_NOTICE_MIN = 1;
// Ops that resolve through a MEDIA map — images (real photos, PDF-page rasters,
// filmstrip frames, latex/mermaid rasters) and video frames. This path passes an EMPTY
// media map because node has no createImageBitmap, so every one of them draws NOTHING.
// They are counted so the omission is ANNOUNCED rather than discovered in the output.
const MEDIA_OPS = new Set(["image", "video", "videoFrame", "videoV5Frame"]);

// THE argument parser now lives in cli/args.js so that cli/render_job.js — which
// drives a browser and has no use for this module's WASM stack — can share it
// without `require`ing the canvaskit binary into every render worker. Re-exported
// here so `import { parseArgs } from "../cli/render.js"` keeps working.
export { parseArgs };

/**
 * Pure function. How many ops in a display list cost per-pixel SkSL on this software
 * surface (HEAVY_OPS), recursing into subtree content — the number that explains a
 * long headless render.
 *
 * @param {object[]} commands IR display list (unflattened; subtree ops carry `content`)
 * @returns {number} count of heavy ops, nested ones included
 *
 * @example heavyOpCount([{op: "rect"}, {op: "materialFill"}]) // 1
 * @example heavyOpCount([{op: "effectSubtree", content: [{op: "glassBackdrop"}, {op: "rect"}]}]) // 1
 * @example heavyOpCount([{op: "rect"}, {op: "text"}]) // 0
 */
export function heavyOpCount(commands) {
  let n = 0;
  for (const cmd of commands) {
    if (HEAVY_OPS.has(cmd.op)) n++;
    if (Array.isArray(cmd.content)) n += heavyOpCount(cmd.content);
  }
  return n;
}

/**
 * Pure function. How many ops in a display list would draw a MEDIA bitmap
 * (MEDIA_OPS), recursing into subtree content — i.e. how many things this bare-node
 * path will leave BLANK, since it has no image decoder.
 *
 * A latex or mermaid raster reaches the painter as an `image` op too, so a count of 0
 * genuinely means "nothing is missing from this PNG".
 *
 * @param {object[]} commands IR display list (unflattened; subtree ops carry `content`)
 * @returns {number} count of media ops, nested ones included
 *
 * @example mediaOpCount([{op: "rect"}, {op: "image", ref: "a"}]) // 1
 * @example mediaOpCount([{op: "cropSubtree", content: [{op: "video", ref: "v"}]}]) // 1
 * @example mediaOpCount([{op: "rect"}, {op: "text"}]) // 0
 */
export function mediaOpCount(commands) {
  let n = 0;
  for (const cmd of commands) {
    if (MEDIA_OPS.has(cmd.op)) n++;
    if (Array.isArray(cmd.content)) n += mediaOpCount(cmd.content);
  }
  return n;
}

/**
 * Pure function. The render tier for a requested value, or a throw naming the valid
 * ones. Rejecting an unknown tier rather than defaulting is the point: a mistyped
 * `--quality prox` must not quietly produce the editor's render (or, worse, quietly
 * produce the cheap one) — a silent fallback here is an unreproducible export.
 *
 * @param {string} requested the --quality value (DEFAULTS.quality when absent)
 * @returns {string} the validated tier
 *
 * @example validatedQuality("full") // "full"
 * @example validatedQuality("proxy") // "proxy"
 * @example // validatedQuality("prox") throws: unknown --quality "prox" (valid: full, proxy)
 */
export function validatedQuality(requested) {
  if (!QUALITIES.includes(requested))
    throw new Error(`cli/render.js: unknown --quality ${JSON.stringify(requested)} (valid: ${QUALITIES.join(", ")})`);
  return requested;
}

/**
 * Command (reads font/wasm files, allocates a CanvasKit surface). Builds a
 * node-safe plugin registry, repairs `docJson`, evaluates (slide, alpha), and
 * returns the encoded PNG bytes for the camera frame at width×height. This is
 * the byte-for-byte Node twin of web/main.js's __powerrp_render hook.
 *
 * Args:
 *   docJson (string): serialized .powerrp.json contents
 *   opts.slide (number): slide index (default 0)
 *   opts.alpha (number): tween alpha in [0, 1] (default 1)
 *   opts.width, opts.height (number): output size in pixels (dpr 1)
 *   opts.quality (string): "full" (the editor's render, the default) or "proxy"
 *     (paint_skia's cheap stand-ins — NOT the editor's render). Validated LOUDLY,
 *     and a non-full tier is REPORTED to stderr before the render, because a caller
 *     who ends up with stand-in pixels must be told, not left to discover it.
 *
 * Returns:
 *   Promise<Uint8Array>: encoded PNG bytes
 */
export async function renderDocToPng(docJson, { slide, alpha, width, height, quality = DEFAULTS.quality }) {
  const tier = validatedQuality(quality);
  const registry = createRegistry();
  registerAll(registry, createCommands());
  // EXACTLY the editor's load-boundary repair (orphans→renames→fps-strip→fill→
  // duration→camera→bindings) so the CLI and editor can never drift. Reports are
  // console.errored — silent repairs are forbidden.
  const { doc, reports } = repairedDocument(deserialize(docJson), registry);
  printRepairReports(reports);
  // The one pipeline: fold → EVALUATE (equations become numbers) → derive → emit,
  // through web/cameraFrame's evaluatedStateAt — the ONE home for it, so the CLI
  // cannot drift from the editor. (It already imports cameraFrameIR from there;
  // this retires the last hand-assembled half of the same recipe, and with it the
  // CLI's blindness to a widget's declared coupled-state tween.)
  const state = evaluatedStateAt(doc, slide, alpha, registry);
  // THE CAMERA's bbox at this (slide, alpha) is the view; its background clears
  // the frame. Same rect the camera-frame IR draws as its first world rect.
  const rect = cameraRect(state, doc.meta);
  const view = fitRectView(rect, width, height, DPR);
  const commands = cameraFrameIR(state, doc.meta, registry);
  // Honor THE camera's Anti-aliasing setting in the headless path too (the same
  // way gpuService reads it for thumbnails/PNG export), so the CLI never renders
  // with a different edge treatment than the editor: "off" ⇒ crisp jagged edges.
  const antialias = antialiasCoverage(cameraAntialias(state));
  // THE THREE REPORTS. None changes a pixel; all three exist because the alternative is
  // a caller who cannot tell a slow render from a hung one, a stand-in render from a
  // real one, or a complete picture from one with holes in it.
  const heavy = heavyOpCount(commands);
  if (tier !== "full")
    console.error(`cli/render.js: --quality ${tier} — this PNG is NOT the editor's render. It substitutes paint_skia's cheap thumbnail stand-ins for every per-pixel material shader (${heavy} such op(s) in this slide). Use it for previews and layout checks, never for a deliverable.`);
  else if (heavy >= HEAVY_OP_NOTICE_MIN)
    console.error(`cli/render.js: ${heavy} per-pixel material/backdrop op(s) at ${width}x${height}, full quality, on a SOFTWARE surface (node has no GL context) — this can take tens of seconds to minutes and is not stuck. --quality proxy renders cheap stand-ins instead (explicitly NOT the editor's render).`);
  // THE BLANK-MEDIA REPORT. Bare node has no image decoder, so these ops draw NOTHING
  // and the PNG comes out with holes where photographs, videos, PDF pages, filmstrip
  // frames, equations and diagrams belong — while the process still exits 0. That was
  // the actual failure that got this path retired as the video renderer, and agents
  // "rendered and looked" through it for a whole session without noticing.
  const media = mediaOpCount(commands);
  if (media > 0)
    console.error(`cli/render.js: ${media} media op(s) in this slide (image/video/PDF/filmstrip/latex/mermaid raster) WILL BE BLANK — bare node has no createImageBitmap, so an empty media map is passed. This PNG is NOT what the editor shows. For a faithful render use cli/render_job.js, which draws it in a real headless browser.`);
  return renderToPng(commands, view, { width, height, background: rect.background, media: {}, antialias, quality: tier });
}

/** Command (reads doc file, writes PNG, prints a summary). The CLI entry. */
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length !== 2) {
    console.error(`Usage: node render.js <doc.powerrp.json> <out.png> [--slide N] [--alpha A] [--width W] [--height H] [--quality ${QUALITIES.join("|")}]`);
    process.exit(1);
  }
  const [docPath, outPath] = positional;
  const opts = { ...DEFAULTS, ...flags };
  const docJson = await readFile(docPath, "utf8");
  const started = performance.now();
  const png = await renderDocToPng(docJson, opts);
  await writeFile(outPath, Buffer.from(png));
  // The elapsed time is part of the summary so a slow slide is legible in a log, and
  // the tier is named so no PNG's provenance has to be guessed at later.
  console.log(`Rendered slide ${opts.slide} (alpha ${opts.alpha}) at ${opts.width}x${opts.height}, quality ${opts.quality}, in ${((performance.now() - started) / 1000).toFixed(2)}s -> ${outPath}`);
}

// Run only as a script, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) await main();
