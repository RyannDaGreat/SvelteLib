/**
 * The SVG → IR browser/CLI ADAPTER — the DOM-facing sibling of
 * render_gpu/gpu/latex_raster.js. It turns an SVG source STRING into a list of
 * render_gpu/ir.js `path` ops (mapped into a widget box) by:
 *   1. parsing the string to a plain `{tag, attrs, children}` tree — via DOMParser
 *      in the browser (the ONLY DOM dependency — kept out of the pure core) and
 *      via the strict pure scanner below in bare node, which has no DOM,
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
 *   - DOMParser is referenced only INSIDE functions, and only where it EXISTS:
 *     `parseSvgToTree` picks the DOM branch in the browser and the pure scanner in
 *     bare node, so a headless render flattens the same SVG as the editor.
 *   - The built-in cursor library loads through TWO environment-specific paths
 *     behind ONE lazy memoized loader (the fonts precedent: render_gpu/fonts.js
 *     names the files, browser_canvaskit.js loads their bytes with a Vite glob and
 *     node_render.js loads the SAME files with fs). In the browser the bundler
 *     inlines them (`import.meta.glob`, eager `?raw`); in bare node — the headless
 *     cli/render.js and every node suite — they are read off disk. The static
 *     `CURSOR_NAMES` list (the demo select's options, needed at bare-node
 *     plugin-load) is the only cursor data at module scope.
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
 * Query (browser/CLI). Parses an SVG string into the plain `{tag, attrs,
 * children}` tree the pure core consumes — through DOMParser where there IS one
 * (browser) and through the pure scanner below in bare node (the headless
 * cli/render.js has no DOM). Both branches yield the SAME shape: lowercased tag
 * names, attribute case preserved (viewBox stays viewBox), element children only.
 * Throws LOUDLY on a malformed document or a missing root <svg> (no silent
 * fallback) — the widget turns that throw into its error affordance.
 *
 * @example // parseSvgToTree("<svg viewBox='0 0 2 2'><rect width='2' height='2'/></svg>")
 * @example // → {tag: "svg", attrs: {viewBox: "0 0 2 2"}, children: [{tag: "rect", attrs: {width: "2", height: "2"}, children: []}]}
 */
export function parseSvgToTree(svgString) {
  const root = typeof DOMParser === "undefined" ? parseSvgTreeText(svgString) : parseSvgTreeDom(svgString);
  if (!root || root.tag !== "svg")
    throw new Error(`svg_raster: root element is <${root?.tag ?? "?"}>, expected <svg>`);
  return root;
}

/** Query (browser — needs DOMParser). The DOM branch of parseSvgToTree: XML parse
 * mode (preserves attribute case), loud on a parser error. */
function parseSvgTreeDom(svgString) {
  const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  const perr = doc.querySelector("parsererror");
  if (perr) throw new Error(`svg_raster: malformed SVG — ${perr.textContent?.trim().slice(0, 160) || "XML parse error"}`);
  const root = doc.documentElement;
  return root ? domToTree(root) : null;
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

// ── the BARE-NODE XML PARSE (no DOM anywhere in Node) ─────────────────────────
// Node ships no DOMParser, so the headless renderer needs its own way from source
// text to the tree. It lives HERE, beside the DOM branch, because this module IS
// the parse step (core/svg_paths.js stays pure geometry). It is a STRICT scanner
// over the XML subset SVG assets are written in — well-formedness violations THROW
// (the same loud contract DOMParser's parsererror gives the browser), so a bad SVG
// still reaches the widget's error affordance instead of half-rendering.

/** The five predefined XML entities (the only named ones a document may use
 * without declaring them). Numeric references are decoded arithmetically. */
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Matches ONE element tag at the scan position: `<name attr="v" ...>`,
 * `<name .../>` or `</name>`. Attribute values MUST be quoted (XML requires it);
 * anything else fails to match and is reported loudly by the scanner. */
const TAG_AT = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;

/** Matches ONE `name="value"` attribute inside a tag's attribute run. */
const ATTR_G = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Pure function. Decodes XML character data: the five predefined entities plus
 * decimal/hex numeric references. An UNDECLARED named entity throws (loud) — a
 * document relying on a DTD entity is not something this scanner may guess at.
 *
 * @param {string} s - raw attribute text
 * @returns {string} the decoded text
 *
 * @example decodeXmlText("M0 0 L1 1") // "M0 0 L1 1"
 * @example decodeXmlText("a &amp; b &lt;c&gt;") // "a & b <c>"
 * @example decodeXmlText("&#65;&#x42;") // "AB"
 */
export function decodeXmlText(s) {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return String.fromCodePoint(parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10));
    }
    const c = XML_ENTITIES[body];
    if (c === undefined) throw new Error(`svg_raster: undeclared XML entity "${whole}" (only ${Object.keys(XML_ENTITIES).join("/")} and numeric references are supported)`);
    return c;
  });
}

/**
 * Pure function. Bare-node XML parse: an SVG source string → the ROOT
 * `{tag, attrs, children}` node (the DOMParser branch's twin — lowercased tags,
 * attribute case preserved, element children only; text, comments, the XML
 * declaration, DOCTYPEs and processing instructions are skipped). Throws on any
 * well-formedness violation: an unquoted attribute, a mismatched or unclosed tag,
 * junk after the root, or no element at all.
 *
 * @param {string} svgString - the SVG source
 * @returns {{tag: string, attrs: Object<string,string>, children: object[]}}
 *
 * @example parseSvgTreeText("<svg viewBox='0 0 2 2'/>") // {tag: "svg", attrs: {viewBox: "0 0 2 2"}, children: []}
 * @example parseSvgTreeText("<svg><g fill='red'><path d='M0 0h1'/></g></svg>").children[0].children[0].attrs.d // "M0 0h1"
 * @example parseSvgTreeText("<svg><linearGradient/></svg>").children[0].tag // "lineargradient"  (tags lowercase, like DOMParser + domToTree)
 */
export function parseSvgTreeText(svgString) {
  if (typeof svgString !== "string") throw new Error(`svg_raster: SVG source must be a string, got ${typeof svgString}`);
  let root = null;
  const stack = [];
  let i = 0;
  while (i < svgString.length) {
    const lt = svgString.indexOf("<", i);
    if (lt < 0) break; // only trailing text left
    i = lt;
    const skipped = skipNonElement(svgString, i);
    if (skipped > i) { i = skipped; continue; } // comment / declaration / DOCTYPE / PI
    const m = TAG_AT.exec(svgString.slice(i));
    if (!m) throw new Error(`svg_raster: malformed SVG — cannot parse tag at "${svgString.slice(i, i + 60)}"`);
    const [whole, close, rawName, attrRun, selfClose] = m;
    const tag = rawName.toLowerCase();
    if (close) {
      const open = stack.pop();
      if (!open) throw new Error(`svg_raster: malformed SVG — closing </${tag}> with no open element`);
      if (open.tag !== tag) throw new Error(`svg_raster: malformed SVG — </${tag}> closes <${open.tag}>`);
    } else {
      const node = { tag, attrs: parseAttrRun(attrRun), children: [] };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (root) throw new Error(`svg_raster: malformed SVG — a second root element <${tag}> after <${root.tag}>`);
      else root = node;
      if (!selfClose) stack.push(node);
    }
    i += whole.length;
  }
  if (stack.length) throw new Error(`svg_raster: malformed SVG — unclosed <${stack[stack.length - 1].tag}>`);
  if (!root) throw new Error("svg_raster: malformed SVG — no element found");
  return root;
}

/**
 * Pure function. The index just past a NON-ELEMENT construct starting at `at`
 * (comment, CDATA, DOCTYPE/declaration, processing instruction), or `at` itself
 * when the position starts a real tag. An unterminated construct throws.
 *
 * @param {string} s - the source
 * @param {number} at - index of a "<"
 * @returns {number} the index to continue scanning from
 *
 * @example skipNonElement("<!-- hi --><svg/>", 0) // 11
 * @example skipNonElement("<svg/>", 0) // 0  (a real tag — nothing skipped)
 */
export function skipNonElement(s, at) {
  const OPENERS = [["<!--", "-->"], ["<![CDATA[", "]]>"], ["<!", ">"], ["<?", "?>"]];
  for (const [open, close] of OPENERS) {
    if (!s.startsWith(open, at)) continue;
    const end = s.indexOf(close, at + open.length);
    if (end < 0) throw new Error(`svg_raster: malformed SVG — unterminated "${open}" construct`);
    return end + close.length;
  }
  return at;
}

/**
 * Pure function. A tag's attribute run (`  fill="red" d='M0 0'`) → the attrs
 * object, values entity-decoded, NAMES CASE-PRESERVED (viewBox stays viewBox).
 *
 * @param {string} run - the whitespace-led attribute text from TAG_AT
 * @returns {Object<string,string>}
 *
 * @example parseAttrRun(' viewBox="0 0 4 4" fill=\'none\'') // {viewBox: "0 0 4 4", fill: "none"}
 * @example parseAttrRun("") // {}
 */
export function parseAttrRun(run) {
  const attrs = {};
  ATTR_G.lastIndex = 0;
  for (let m; (m = ATTR_G.exec(run)); ) attrs[m[1]] = decodeXmlText(m[2] ?? m[3] ?? "");
  return attrs;
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
 * that maps the viewBox into the box. THE shared flatten entry — the OPS-ONLY
 * view of svgToIRWithWarnings below, for a caller that has no place to show a
 * notice (the cursor demo widget's built-ins are trusted committed assets).
 * Malformed SVG throws (the widget draws its error affordance); punted features
 * are reported once, never silently dropped.
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
  return svgToIRWithWarnings(svgString, boxW, boxH, opts).ops;
}

/**
 * Command (near-pure: memoized parse + reportOnce on punts). svgToIR's body, also
 * handing back the flatten WARNINGS so a caller can surface them IN-APP: an
 * unsupported feature (mask, clip-path, filter, inline style=, an arc, a radial
 * gradient, <text>/<use>) draws DEGRADED art, and a console.error alone lets that
 * pass for correct — the SVG widget turns these into its notice band
 * (plugins/svg.js warningAffordance). The `{value, reports}` shape mirrors
 * core/document.js repairedDocument, the codebase's "loud but non-fatal" seam.
 *
 * Args:
 *   svgString (string), boxW/boxH (number), opts (object): exactly svgToIR's
 *
 * Returns:
 *   {ops: object[], warnings: string[]}: the ready IR ops + the deduped punt
 *   notices, each naming the feature and the element ([] for a fully supported SVG)
 */
export function svgToIRWithWarnings(svgString, boxW, boxH, opts = {}) {
  const { ops, transform, warnings } = flattenSvgTree(treeFor(svgString), boxW, boxH, opts);
  for (const w of warnings) reportOnce(`svg_raster:${w}`, `PowerRP svg_raster: ${w}`);
  const irOps = ops.map((o) => path(o));
  return { ops: transform ? [pushTransform(transform), ...irOps, popTransform()] : irOps, warnings };
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

/**
 * The committed cursor asset directory, RELATIVE TO THIS MODULE — the dump is
 * PORTABLE, so no path here may be absolute (the bare-node reader resolves it
 * through `import.meta.url`). The bundler glob below MUST spell the same
 * directory inline: `import.meta.glob` is a compile-time macro whose pattern has
 * to be a literal, so it cannot read this constant.
 */
const CURSOR_DIR = "../../assets/builtin/cursors/";

/** The cursor asset file extension — the suffix both loaders strip to get a name. */
const CURSOR_EXT = ".svg";

/**
 * True in bare Node (the headless cli/render.js + every node suite), false in the
 * browser bundle — THE discriminator between the two cursor loaders below.
 *
 * WHY the runtime and not the macro: `import.meta.glob` is a Vite TRANSFORM of the
 * CALL expression, so `typeof import.meta.glob` is "undefined" in the browser too
 * and cannot be tested. Node's own presence is the honest signal, and it is the
 * `typeof document === "undefined"` discriminator video_v2.js / latex_raster.js
 * already use, tightened to name the runtime it actually needs.
 */
const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

let builtinCursorCache = null;
/** Query (LAZY, memoized). Loads the built-in cursor SVG strings keyed by name —
 * from the bundle in the browser, from disk in bare node. The loaded files are the
 * runtime source of the actual SVG content; CURSOR_NAMES is the static
 * enumeration — a mismatch is reported loudly. */
function loadBuiltinCursors() {
  if (builtinCursorCache) return builtinCursorCache;
  const map = IS_NODE ? cursorsFromDisk() : cursorsFromBundle();
  const foundNames = Object.keys(map).sort();
  if (foundNames.join(",") !== [...CURSOR_NAMES].sort().join(","))
    reportOnce("svg_raster:cursor-drift", `PowerRP svg_raster: built-in cursor files ${JSON.stringify(foundNames)} differ from CURSOR_NAMES — update CURSOR_NAMES in svg_raster.js`);
  builtinCursorCache = map;
  return map;
}

/** Query (browser — the Vite glob macro). The cursor sources the BUNDLER inlined
 * (eager `?raw`, so the strings ship with the app: no network fetch, offline- and
 * data-URI-friendly). The literal pattern must match CURSOR_DIR (see it). */
function cursorsFromBundle() {
  const modules = import.meta.glob("../../assets/builtin/cursors/*.svg", { eager: true, query: "?raw", import: "default" });
  const map = {};
  for (const [p, src] of Object.entries(modules)) map[cursorNameFromPath(p)] = src;
  return map;
}

/** Query (bare node — reads the committed asset files). The cursor sources read
 * off disk, resolved RELATIVE to this module (portable). A missing/renamed
 * directory throws loudly out of readdirSync — never a silent empty library. */
function cursorsFromDisk() {
  if (typeof process.getBuiltinModule !== "function")
    throw new Error("svg_raster: node >= 22.3 needed to read the built-in cursors from disk (process.getBuiltinModule)");
  const fs = process.getBuiltinModule("node:fs");
  const dir = new URL(CURSOR_DIR, import.meta.url); // fs takes file: URLs — no absolute path, no node:path/node:url import
  const map = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(CURSOR_EXT)) continue;
    map[cursorNameFromPath(file)] = fs.readFileSync(new URL(file, dir), "utf8");
  }
  return map;
}

/**
 * Pure function. A cursor asset path (or bare file name) → its cursor NAME: the
 * final path segment with the `.svg` suffix stripped. Shared by both loaders so
 * the bundle and the disk agree on the keys.
 *
 * @param {string} p - an asset path, e.g. "../../assets/builtin/cursors/zoomin.svg"
 * @returns {string} the cursor name, e.g. "zoomin"
 *
 * @example cursorNameFromPath("../../assets/builtin/cursors/zoomin.svg") // "zoomin"
 * @example cursorNameFromPath("beachball.svg") // "beachball"
 */
export function cursorNameFromPath(p) {
  const base = p.split("/").pop();
  return base.endsWith(CURSOR_EXT) ? base.slice(0, -CURSOR_EXT.length) : base;
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
