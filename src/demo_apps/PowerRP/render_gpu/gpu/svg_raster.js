/**
 * The SVG → IR browser/CLI ADAPTER — the DOM-facing sibling of
 * render_gpu/gpu/latex_raster.js. It turns an SVG source STRING into a list of
 * render_gpu/ir.js `path` ops (mapped into a widget box) by:
 *   1. parsing the string to a plain `{tag, attrs, children}` tree via DOMParser
 *      (the ONLY DOM dependency — kept out of the pure core),
 *   2. handing that tree to the pure, bare-node core/svg_paths.js `flattenSvgTree`
 *      (all the geometry/paint math lives there, doctested),
 *   3. building the IR `path()` ops + (for preserveAspect ON) the one
 *      pushTransform/popTransform that maps the viewBox into the box.
 *
 * Both the SVG widget (plugins/svg.js) and the cursor demo widget
 * (plugins/demo/cursor.js) call `svgToIR` — the SVG-flatten logic has ONE home,
 * and neither plugin imports the other (the "no plugin imports another" rule).
 *
 * ── BARE-NODE SAFETY (the latex_raster / pdfjs lazy-import lesson) ─────────────
 * This module is reached at import time by plugins/index.js's static chain
 * (index → cursor.js → here), and core/ + render_gpu/ node suites MUST stay
 * bare-node importable. So NOTHING DOM- or Vite-only runs at module top level:
 *   - DOMParser is referenced only INSIDE functions (called in the browser/CLI;
 *     a bare-node call throws loudly at call time — correct, this is browser/CLI-
 *     facing, exactly like latex_raster).
 *   - `import.meta.glob` (the built-in cursor library) sits inside a LAZY memoized
 *     loader, never at top level, so a bare-node import never evaluates the
 *     Vite-only macro. The static `CURSOR_NAMES` list (the demo select's options,
 *     needed at bare-node plugin-load) is the only cursor data at module scope.
 *
 * ── LOUD FAILURE DISCIPLINE (no silent fallbacks) ─────────────────────────────
 * A malformed SVG (not well-formed XML, or no root <svg>) THROWS from
 * `parseSvgToTree`; the widget catches it and draws a loud in-widget error
 * affordance (plugins/svg.js, the latex errorAffordance precedent). Punted
 * features (arcs, radial/userSpace gradients, masks/clip/filters, <text>/<use>,
 * inline style=) are reported ONCE via core/report.reportOnce (the flatten
 * collects them as `warnings`; this adapter surfaces them) — never a silent blank.
 */

import { path, pushTransform, popTransform } from "../ir.js";
import { flattenSvgTree } from "../../core/svg_paths.js";
import { reportOnce } from "../../core/report.js";

/**
 * Pure function. True iff an SVG source is empty / has no root <svg> — the
 * CONDITIONAL-GHOST predicate (the latexIsEmpty / richTextIsEmpty precedent): an
 * empty SVG renders nothing and is a ghost. Import-time safe (no DOM).
 *
 * @example svgIsEmpty("") // true
 * @example svgIsEmpty("   ") // true
 * @example svgIsEmpty(undefined) // true
 * @example svgIsEmpty("<svg viewBox='0 0 1 1'></svg>") // false
 */
export function svgIsEmpty(src) {
  return typeof src !== "string" || !/<svg[\s>]/i.test(src);
}

/** svgString → parsed `{tag, attrs, children}` tree, memoized (DOMParser is the
 * one expensive step; the pure flatten is cheap, so we cache the TREE and
 * re-flatten per call — no box-size-keyed cache explosion on resize). */
const treeCache = new Map();

/**
 * Query (browser/CLI — needs DOMParser). Parses an SVG string into the plain
 * `{tag, attrs, children}` tree the pure core consumes. Throws LOUDLY on a
 * malformed document or a missing root <svg> (no silent fallback). XML parse
 * mode preserves attribute case (viewBox stays viewBox).
 *
 * @example // parseSvgToTree("<svg viewBox='0 0 2 2'><rect width='2' height='2'/></svg>")
 * @example // → {tag: "svg", attrs: {viewBox: "0 0 2 2"}, children: [{tag: "rect", attrs: {width: "2", height: "2"}, children: []}]}
 */
export function parseSvgToTree(svgString) {
  if (typeof DOMParser === "undefined")
    throw new Error("svg_raster: DOMParser needed (this module is browser/CLI-facing, not bare node)");
  const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  const perr = doc.querySelector("parsererror");
  if (perr) throw new Error(`svg_raster: malformed SVG — ${perr.textContent?.trim().slice(0, 160) || "XML parse error"}`);
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg")
    throw new Error(`svg_raster: root element is <${root?.tagName ?? "?"}>, expected <svg>`);
  return domToTree(root);
}

/** Query. One DOM element → a plain `{tag, attrs, children}` node (element
 * children only; attribute case preserved). */
function domToTree(el) {
  const attrs = {};
  for (const a of el.attributes) attrs[a.name] = a.value;
  const children = [];
  for (const c of el.children) children.push(domToTree(c));
  return { tag: el.tagName.toLowerCase(), attrs, children };
}

function treeFor(svgString) {
  let t = treeCache.get(svgString);
  if (!t) { t = parseSvgToTree(svgString); treeCache.set(svgString, t); }
  return t;
}

/**
 * Command (near-pure: memoized parse + reportOnce on punts). An SVG string →
 * ready render_gpu/ir.js ops mapped into a `boxW × boxH` widget box: the flattened
 * `path` ops, wrapped (preserveAspect ON) in the one pushTransform/popTransform
 * that maps the viewBox into the box. THE shared entry both the SVG widget and
 * the cursor demo widget call. Malformed SVG throws (the widget draws its error
 * affordance); punted features are reported once, never silently dropped.
 *
 * Args:
 *   svgString (string): the SVG source
 *   boxW, boxH (number): the widget box size (box-local units)
 *   opts ({ink, preserveAspect}): ink for currentColor; preserveAspect default true
 *
 * Returns:
 *   object[]: render_gpu/ir.js ops (path ops + optional viewBox→box transform)
 */
export function svgToIR(svgString, boxW, boxH, opts = {}) {
  const { ops, transform, warnings } = flattenSvgTree(treeFor(svgString), boxW, boxH, opts);
  for (const w of warnings) reportOnce(`svg_raster:${w}`, `PowerRP svg_raster: ${w}`);
  const irOps = ops.map((o) => path(o));
  return transform ? [pushTransform(transform), ...irOps, popTransform()] : irOps;
}

// ── the BUILT-IN CURSOR LIBRARY (ship-with-the-app SVGs) ──────────────────────

/**
 * The canonical built-in cursor names (the demo cursor widget's select options).
 * This static list is the ONE thing needed at bare-node plugin-load time (the
 * glob below is browser/CLI-only); loadBuiltinCursors cross-checks it against the
 * committed files and warns loudly on drift, so the two never silently diverge.
 * Matches assets/builtin/cursors/<name>.svg exactly (39 real macOS-style cursors).
 */
export const CURSOR_NAMES = [
  "beachball", "busy", "cell", "contextualmenu", "copy", "cross", "default",
  "handgrabbing", "handopen", "handpointing", "help", "makealias", "move",
  "notallowed", "poof", "resizedown", "resizeeast", "resizeleft",
  "resizeleftright", "resizenorth", "resizenortheast", "resizenortheastsouthwest",
  "resizenorthsouth", "resizenorthwest", "resizenorthwestsoutheast", "resizeright",
  "resizesouth", "resizesoutheast", "resizesouthwest", "resizeup", "resizeupdown",
  "resizewest", "resizewesteast", "screenshotselection", "screenshotwindow",
  "textcursor", "textcursorvertical", "zoomin", "zoomout",
];

/** The busy/spinner cursor whose ephemeral rotation the demo spins by default —
 * the recognizable macOS "beach ball" wait indicator. This is the ONLY cursor
 * that spins; every other cursor is static (the spin is gated on this name). */
export const SPINNING_CURSOR = "beachball";

/**
 * The per-cursor HOTSPOT — the pointing tip, in the shared 0..32 viewBox
 * coordinate frame (every built-in cursor SVG is `viewBox="0 0 32 32"`). This is
 * the point a real macOS cursor "clicks with": the arrow's sharp tip, the
 * I-beam's midline, the crosshair's center. The cursor widget maps it into
 * box-local space (via the same fitBox letterbox the flatten uses) and uses it
 * as the widget's PLACEMENT anchor + a bindable `hotspot` anchor — so placing a
 * cursor lands the TIP where you point, not the bounding-box center.
 *
 * POINTER cursors (arrow/finger tips) carry their tip; symmetric cursors
 * (cross, resize arrows, zoom, …) carry their artwork center (≈16,16). Values
 * were computed offline from the flattened geometry (tests/…geom sweep) — the
 * beach ball's true center is exactly (16.5, 16.5).
 */
export const CURSOR_HOTSPOTS = {
  default: [10, 7], contextualmenu: [8, 7], copy: [7, 1], makealias: [11, 9],
  notallowed: [7, 1], poof: [7, 1], busy: [7, 1],
  cross: [16, 16], cell: [16, 16], help: [16, 16],
  handopen: [15, 14], handgrabbing: [15, 16], handpointing: [13, 8],
  textcursor: [3.5, 8], textcursorvertical: [8.5, 4],
  zoomin: [16, 16], zoomout: [16, 16], move: [16, 16],
  resizenorth: [16, 16], resizesouth: [16, 16], resizeeast: [16, 16], resizewest: [16, 16],
  resizeup: [16, 16], resizedown: [16, 16], resizeleft: [16, 16], resizeright: [16, 16],
  resizenortheast: [16, 16], resizenorthwest: [16, 16], resizesoutheast: [16, 16], resizesouthwest: [16, 16],
  resizenorthsouth: [16, 16], resizewesteast: [16, 16], resizeleftright: [16, 16], resizeupdown: [16, 16],
  resizenortheastsouthwest: [16, 16], resizenorthwestsoutheast: [16, 16],
  screenshotselection: [16, 16], screenshotwindow: [16, 16], beachball: [16.5, 16.5],
};

/** The shared viewBox extent every built-in cursor is authored in (0..32). The
 * cursor widget uses this to map a hotspot (viewBox coords) into box-local. */
export const CURSOR_VIEWBOX = 32;

let builtinCursorCache = null;
/** Query (browser/CLI — LAZY glob). Loads the built-in cursor SVG strings keyed
 * by name via Vite's `import.meta.glob` (eager `?raw`). Memoized. The glob is the
 * runtime source of the actual SVG content; CURSOR_NAMES is the static
 * enumeration — a mismatch is reported loudly. */
function loadBuiltinCursors() {
  if (builtinCursorCache) return builtinCursorCache;
  const modules = import.meta.glob("../../assets/builtin/cursors/*.svg", { eager: true, query: "?raw", import: "default" });
  const map = {};
  for (const [p, src] of Object.entries(modules)) map[p.split("/").pop().replace(/\.svg$/, "")] = src;
  const globNames = Object.keys(map).sort();
  if (globNames.join(",") !== [...CURSOR_NAMES].sort().join(","))
    reportOnce("svg_raster:cursor-drift", `PowerRP svg_raster: built-in cursor files ${JSON.stringify(globNames)} differ from CURSOR_NAMES — update CURSOR_NAMES in svg_raster.js`);
  builtinCursorCache = map;
  return map;
}

/**
 * Query (browser/CLI). The raw SVG source string for a built-in cursor name.
 * Throws loudly on an unknown name (a typo must not silently draw nothing) — the
 * cursor widget's cursorKind is a select over CURSOR_NAMES, so this only throws
 * on a corrupt document / removed asset.
 */
export function cursorSource(name) {
  const map = loadBuiltinCursors();
  const src = map[name];
  if (typeof src !== "string") throw new Error(`svg_raster.cursorSource: unknown built-in cursor "${name}" (known: ${Object.keys(map).join(", ")})`);
  return src;
}

/**
 * Query (browser/CLI). The built-in cursor library as ASSET-LIST entries to
 * MERGE into app.listProjectAssets (so they appear in the Asset Explorer for
 * every project, marked `builtin:true` so the Explorer omits the delete
 * affordance). `src` is the raw SVG string (the vector source the SVG/cursor
 * widgets flatten); `url` is a self-contained data URI for the thumbnail tile /
 * image insert — no server route needed (offline/CLI-friendly, the design's
 * Vite-glob integration).
 */
export function builtinCursorAssets() {
  const map = loadBuiltinCursors();
  return Object.entries(map).map(([name, src]) => ({
    name: `${name}.svg`, kind: "image", builtin: true,
    src, url: svgDataUri(src), size: new TextEncoder().encode(src).length,
  }));
}

/** Pure function. A self-contained `image/svg+xml` data URI for an SVG string
 * (base64 — the robust form latex_raster uses for an <img>-decodable SVG URI). */
function svgDataUri(svgString) {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgString)))}`;
}
