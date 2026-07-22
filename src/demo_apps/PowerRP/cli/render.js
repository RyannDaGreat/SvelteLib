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
 * KNOWN BOUND (render rewrite Phase 1a): paint_skia.js does not yet implement
 * the backdrop/effect/latex ops — blurBackdrop, magnifyBackdrop, cropSubtree,
 * effectSubtree (shadows/bloom/blend), latexVector — and throws loudly on them.
 * So a document using blur/magnifier widgets, live shadows/bloom, crop boxes,
 * or latex cannot render here until Phase 1b lands (owned by the paint_skia
 * engineer). Widgets with effects OFF (the default) render fine.
 *
 * Image/video media is not yet decoded on the Node side: an empty media map is
 * passed, so a document containing image/video widgets fails LOUDLY inside
 * paint_skia ("no media Image for ref ...") rather than drawing blanks. Wiring
 * node-side media decode (file/dataURL → CanvasKit.MakeImageFromEncoded) is a
 * follow-up.
 *
 * Usage (from the SvelteLib repo root):
 *   node src/demo_apps/PowerRP/cli/render.js doc.powerrp.json out.png \
 *     [--slide 2] [--alpha 1] [--width 1920] [--height 1080]
 */

import { readFile, writeFile } from "node:fs/promises";
import { deserialize, foldState, repairedDocument, printRepairReports } from "../core/document.js";
import { cameraRect } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR } from "../web/cameraFrame.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";

const DEFAULTS = { slide: 0, alpha: 1, width: 1280, height: 720 };
const DPR = 1; // one PNG pixel per device pixel — matches the editor's PNG export.

/**
 * Pure function. Parses `[<doc>, <out>, --flag value ...]` into positionals +
 * numeric flags. Every flag value is coerced with Number (alpha may be
 * fractional, slide/width/height integers).
 *
 * @param {string[]} argv Args after the script name (process.argv.slice(2)).
 * @returns {{positional: string[], flags: Object<string, number>}}
 *
 * @example parseArgs(["d.json", "o.png", "--slide", "2", "--alpha", "0.5"]) // {positional: ["d.json", "o.png"], flags: {slide: 2, alpha: 0.5}}
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = Number(argv[++i]);
    else positional.push(argv[i]);
  }
  return { positional, flags };
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
 *
 * Returns:
 *   Promise<Uint8Array>: encoded PNG bytes
 */
export async function renderDocToPng(docJson, { slide, alpha, width, height }) {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  // EXACTLY the editor's load-boundary repair (orphans→renames→fps-strip→fill→
  // duration→camera→bindings) so the CLI and editor can never drift. Reports are
  // console.errored — silent repairs are forbidden.
  const { doc, reports } = repairedDocument(deserialize(docJson), registry);
  printRepairReports(reports);
  // The one pipeline: fold → EVALUATE (equations become numbers) → derive → emit.
  const state = evaluateState(foldState(doc, slide, alpha), registry).state;
  // THE CAMERA's bbox at this (slide, alpha) is the view; its background clears
  // the frame. Same rect the camera-frame IR draws as its first world rect.
  const rect = cameraRect(state, doc.meta);
  const view = fitRectView(rect, width, height, DPR);
  const commands = cameraFrameIR(state, doc.meta, registry);
  return renderToPng(commands, view, { width, height, background: rect.background, media: {} });
}

/** Command (reads doc file, writes PNG, prints a summary). The CLI entry. */
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length !== 2) {
    console.error("Usage: node render.js <doc.powerrp.json> <out.png> [--slide N] [--alpha A] [--width W] [--height H]");
    process.exit(1);
  }
  const [docPath, outPath] = positional;
  const opts = { ...DEFAULTS, ...flags };
  const docJson = await readFile(docPath, "utf8");
  const png = await renderDocToPng(docJson, opts);
  await writeFile(outPath, Buffer.from(png));
  console.log(`Rendered slide ${opts.slide} (alpha ${opts.alpha}) at ${opts.width}x${opts.height} -> ${outPath}`);
}

// Run only as a script, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) await main();
