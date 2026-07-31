/**
 * THE BUILT-IN CLIP-ART LIBRARY — ship-with-the-app SVG drawings that are NOT
 * shapes.
 *
 * A shapeshifter FAMILY earns its place by being parametric: a knob turns and the
 * silhouette becomes a different, still-recognizable member of the same family
 * (a polygon's side count, a gear's teeth, a cloud's puffs). Some drawings have
 * no such knob. A lightning bolt's zigzag IS the drawing — there is no "bolt
 * parameter" whose sweep produces a family of bolts, only one good zigzag and a
 * lot of worse ones. Those belong in the asset library as vector CLIP-ART, which
 * the SVG widget already draws, scales, recolours and exports (user, on
 * lightning: "maybe better as a preset for an SVG").
 *
 * This is the third built-in asset category, alongside the cursors and the widget
 * library, and it deliberately mirrors the CURSOR loader's structure: a static
 * name list (the one thing bare node needs at plugin-load time), a Vite glob in
 * the browser, a disk read in node, and a LOUD report when the two disagree.
 *
 * Kept OUT of render_gpu/gpu/svg_raster.js on purpose even though the mechanism
 * is the same: that module is the cursor library's home and the raster seam's,
 * and clip-art is neither. One more category there would make it the dumping
 * ground for every bundled SVG.
 */

/**
 * The canonical built-in clip-art names. Matches
 * assets/builtin/clipart/<name>.svg exactly; loadBuiltinClipart cross-checks the
 * committed files against this list and reports drift, so the two never silently
 * diverge (the CURSOR_NAMES discipline).
 */
export const CLIPART_NAMES = ["lightning"];

/**
 * The committed clip-art directory, RELATIVE TO THIS MODULE — the dump is
 * PORTABLE, so no path here may be absolute (the bare-node reader resolves it
 * through `import.meta.url`). The bundler glob below MUST spell the same
 * directory inline: `import.meta.glob` is a compile-time macro whose pattern has
 * to be a literal, so it cannot read this constant.
 */
const CLIPART_DIR = "../assets/builtin/clipart/";

/** The clip-art file extension — the suffix both loaders strip to get a name. */
const CLIPART_EXT = ".svg";

/**
 * True in bare Node, false in the browser bundle — THE discriminator between the
 * two loaders below. `import.meta.glob` is a Vite TRANSFORM of the call
 * expression, so `typeof import.meta.glob` is "undefined" in the browser too and
 * cannot be tested; node's own presence is the honest signal (the svg_raster.js
 * precedent).
 */
const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

/**
 * Pure function. A clip-art asset path (or bare file name) → its NAME: the final
 * path segment with the `.svg` suffix stripped. Shared by both loaders so the
 * bundle and the disk agree on the keys.
 *
 * @param {string} p - an asset path, e.g. "../assets/builtin/clipart/lightning.svg"
 * @returns {string} the clip-art name, e.g. "lightning"
 *
 * @example clipartNameFromPath("../assets/builtin/clipart/lightning.svg") // "lightning"
 * @example clipartNameFromPath("lightning.svg") // "lightning"
 * @example clipartNameFromPath("README") // "README" (no extension — unchanged)
 */
export function clipartNameFromPath(p) {
  const base = String(p).split("/").pop();
  return base.endsWith(CLIPART_EXT) ? base.slice(0, -CLIPART_EXT.length) : base;
}

/** Query (browser — the Vite glob macro). The clip-art sources the BUNDLER
 *  inlined (eager `?raw`, so the strings ship with the app: no network fetch,
 *  offline- and data-URI-friendly). The literal pattern must match CLIPART_DIR. */
function clipartFromBundle() {
  const modules = import.meta.glob("../assets/builtin/clipart/*.svg", { eager: true, query: "?raw", import: "default" });
  const map = {};
  for (const [p, src] of Object.entries(modules)) map[clipartNameFromPath(p)] = src;
  return map;
}

/** Query (bare node — reads the committed asset files), resolved RELATIVE to this
 *  module (portable). A missing/renamed directory throws loudly out of
 *  readdirSync — never a silent empty library. */
function clipartFromDisk() {
  if (typeof process.getBuiltinModule !== "function")
    throw new Error("builtinClipart: node >= 22.3 needed to read the built-in clip-art from disk (process.getBuiltinModule)");
  const fs = process.getBuiltinModule("node:fs");
  const dir = new URL(CLIPART_DIR, import.meta.url); // fs takes file: URLs — no absolute path needed
  const map = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(CLIPART_EXT)) continue;
    map[clipartNameFromPath(file)] = fs.readFileSync(new URL(file, dir), "utf8");
  }
  return map;
}

let clipartCache = null;
/** Query (LAZY, memoized). The built-in clip-art SVG strings keyed by name — from
 *  the bundle in the browser, from disk in bare node. Drift against CLIPART_NAMES
 *  is REPORTED, never swallowed: a file that vanished is a tile that would
 *  silently stop existing. */
function loadBuiltinClipart() {
  if (clipartCache) return clipartCache;
  const map = IS_NODE ? clipartFromDisk() : clipartFromBundle();
  const found = Object.keys(map).sort();
  if (found.join(",") !== [...CLIPART_NAMES].sort().join(","))
    console.error(`PowerRP builtinClipart: committed clip-art files ${JSON.stringify(found)} differ from CLIPART_NAMES — update CLIPART_NAMES in web/builtinClipart.js`);
  clipartCache = map;
  return map;
}

/**
 * Query (browser/CLI). The raw SVG source string for a built-in clip-art name.
 * Throws loudly on an unknown name — a typo must not silently draw nothing (the
 * svg_raster.cursorSource discipline).
 *
 * @example // clipartSource("lightning").includes("<path")  // true
 * @example // clipartSource("nope")  // throws: unknown built-in clip-art "nope"
 */
export function clipartSource(name) {
  const map = loadBuiltinClipart();
  const src = map[name];
  if (typeof src !== "string")
    throw new Error(`builtinClipart.clipartSource: unknown built-in clip-art "${name}" (known: ${Object.keys(map).join(", ")})`);
  return src;
}

/** Pure function. A self-contained `image/svg+xml` data URI for an SVG string
 *  (base64 — the robust form an <img>-decodable SVG URI takes). */
function svgDataUri(svgString) {
  const bytes = new TextEncoder().encode(svgString);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(svgString, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

/**
 * Query (browser/CLI). The built-in clip-art library as ASSET-LIST entries, the
 * same shape builtinCursorAssets returns: `src` is the raw SVG string (what the
 * SVG widget flattens), `url` is a self-contained data URI for the thumbnail tile
 * (no server route — offline/CLI-friendly), `builtin: true` so the Explorer omits
 * the delete affordance.
 *
 * @example // builtinClipartAssets().map((a) => a.name)  // ["lightning.svg"]
 * @example // builtinClipartAssets()[0].kind             // "image"
 */
export function builtinClipartAssets() {
  const map = loadBuiltinClipart();
  return Object.entries(map).map(([name, src]) => ({
    name: `${name}${CLIPART_EXT}`,
    kind: "image",
    builtin: true,
    src,
    url: svgDataUri(src),
    size: new TextEncoder().encode(src).length,
  }));
}
