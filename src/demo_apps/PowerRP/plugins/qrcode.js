/**
 * QR-Code widget — a bbox widget that renders a scannable QR code from a data
 * string as TRUE VECTOR. The dark modules become ONE `path` IR op (a merged set
 * of square subpaths), so the code is crisp at any zoom and exports to SVG/PDF
 * as real vector geometry (a `<path>` / PDF path ops), never a rasterized
 * bitmap — the same win the preset-shape widget (plugins/shape.js) gets from the
 * unified path op, applied to a QR silhouette.
 *
 * The MODULE MATRIX (the bit grid) comes from the `qrcode` npm library
 * (QRCode.create(data, {errorCorrectionLevel}).modules — a row-major 0/1
 * BitMatrix); this file NEVER touches the library's canvas/PNG renderers, only
 * its matrix, and rasterizes the grid to a vector path itself (qrMatrixToPathD).
 *
 * EMPTY vs INVALID (no silent fallback): blank/whitespace-only data is an
 * EXPECTED "nothing to encode yet" state (a freshly-added widget, or one whose
 * text the user cleared) — emit() GHOSTS it (draws nothing, stays selectable),
 * matching the mermaid/text widgets, NOT a failure. Genuinely-invalid NON-empty
 * data (over the format's capacity) still throws LOUDLY out of qrMatrix — never
 * a silent blank or a wrong code. The default data is a valid URL, so normal use
 * never throws.
 *
 * Structure mirrors plugins/shape.js: it composes the SHARED PROPERTY REGISTRY
 * (positioning + opacity + the effects bundle), rides the effects bundle for
 * shadow/glow/border via applyEffects, and uses the standard bbox anchors — the
 * math lives in the pure helpers below, emit() stays thin.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect } from "../core/outline.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { num } from "../core/shapes.js";
import * as T from "../core/transform.js";
import { path, rect } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import QRCode from "qrcode";

// ── named constants (no magic numbers) ───────────────────────────────────────
// The QR spec (ISO/IEC 18004) mandates a LIGHT "quiet zone" of at least FOUR
// modules on every side so scanners can isolate the symbol from surrounding
// content; it is the default margin the grid is inset by.
const QR_SPEC_QUIET_ZONE_MODULES = 4;
// The four QR error-correction levels, lowest→highest recovery (and lowest→
// highest data overhead): L≈7%, M≈15%, Q≈25%, H≈30% of codewords recoverable.
const EC_LEVELS = ["L", "M", "Q", "H"];
const EC_LEVEL_LABELS = { L: "Low (~7%)", M: "Medium (~15%)", Q: "Quartile (~25%)", H: "High (~30%)" };

/**
 * Near-pure function (delegates matrix generation to the `qrcode` library;
 * DETERMINISTIC — the same data + ecLevel always yields the same grid, incl. the
 * penalty-selected mask). Builds the QR module matrix for `data` and throws
 * LOUDLY on any generation failure (empty data, data over the format's capacity)
 * — no silent fallback, no wrong code.
 *
 * Args:
 *   data (string): the payload to encode (URL, text, …)
 *   ecLevel (string): an EC_LEVELS entry ("L"|"M"|"Q"|"H")
 *
 * Returns:
 *   boolean[][]: an N×N row-major grid, matrix[row][col], dark module = true.
 *     N (the "module count") grows with data length: 21 for a version-1 symbol.
 *
 * Examples:
 *   >>> qrMatrix("HELLO", "M").length // 21  (a version-1 symbol is 21×21)
 *   >>> qrMatrix("HELLO", "M")[0][0]  // true (the top-left finder pattern is always dark)
 *   >>> qrMatrix("", "M")             // throws: "qrMatrix: ... No input text"
 */
export function qrMatrix(data, ecLevel) {
  if (!EC_LEVELS.includes(ecLevel)) throw new Error(`qrMatrix: ecLevel must be one of ${EC_LEVELS.join("/")}, got ${JSON.stringify(ecLevel)}`);
  let modules;
  try {
    modules = QRCode.create(data, { errorCorrectionLevel: ecLevel }).modules;
  } catch (e) {
    // Re-raise loudly with context — the library's own message (e.g. "No input
    // text", "data too long") is preserved; NEVER swallowed into a blank code.
    throw new Error(`qrMatrix: QR generation failed for ${JSON.stringify(String(data).slice(0, 40))} @${ecLevel}: ${e.message}`);
  }
  const size = modules.size;
  const grid = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(modules.data[r * size + c] === 1);
    grid.push(row);
  }
  return grid;
}

/**
 * Pure function. Renders a QR module matrix to a SINGLE SVG path `d` string in
 * BBOX-LOCAL space (0..boxW, 0..boxH, y-DOWN — the same frame every render_gpu/
 * ir.js geometry op uses). Modules are drawn as SQUARES; horizontally-adjacent
 * dark modules are MERGED into one rectangle subpath (fewer subpaths, and no
 * hairline seams between neighbours). The (N + 2·quietModules)-module grid is
 * scaled by a single module size = min(boxW,boxH)/(N+2·quietModules) so modules
 * stay square, and CENTERED in the box; the quietModules-wide light margin is
 * left blank (the background/quiet zone fills it).
 *
 * Args:
 *   matrix (boolean[][]): N×N row-major grid, matrix[row][col], dark = true
 *   opts.boxW, opts.boxH (number): the widget box size in local units
 *   opts.quietModules (number): light-margin width in modules (spec ≥ 4)
 *
 * Returns:
 *   string: SVG path data (dark modules only). "" when the matrix has no dark
 *     modules (a degenerate input — a real QR always has finder patterns).
 *
 * Examples:
 *   >>> qrMatrixToPathD([[true]], {boxW: 3, boxH: 3, quietModules: 1}) // "M1 1 h1 v1 h-1 z"
 *   >>> qrMatrixToPathD([[true, true], [false, false]], {boxW: 4, boxH: 4, quietModules: 1}) // "M1 1 h2 v1 h-2 z"  (adjacent modules merged)
 *   >>> qrMatrixToPathD([[true, false, true], [false, false, false], [false, false, false]], {boxW: 3, boxH: 3, quietModules: 0}) // "M0 0 h1 v1 h-1 z M2 0 h1 v1 h-1 z"
 */
export function qrMatrixToPathD(matrix, { boxW, boxH, quietModules }) {
  const N = matrix.length; // module count (a QR grid is square: rows === cols)
  const total = N + 2 * quietModules;
  const moduleSize = Math.min(boxW, boxH) / total;
  const gridExtent = moduleSize * total;
  const originX = (boxW - gridExtent) / 2; // center the square grid in the box
  const originY = (boxH - gridExtent) / 2;
  const subpaths = [];
  for (let r = 0; r < N; r++) {
    const cols = matrix[r].length;
    let c = 0;
    while (c < cols) {
      if (!matrix[r][c]) { c++; continue; }
      const start = c;
      while (c < cols && matrix[r][c]) c++; // extend the horizontal run of dark modules
      const runW = (c - start) * moduleSize;
      const x = originX + (quietModules + start) * moduleSize;
      const y = originY + (quietModules + r) * moduleSize;
      subpaths.push(`M${num(x)} ${num(y)} h${num(runW)} v${num(moduleSize)} h${num(-runW)} z`);
    }
  }
  return subpaths.join(" ");
}

/**
 * Pure function. Is a background/light color a TRANSPARENT sentinel (so emit
 * skips the background rect)? True for the empty-string / absent sentinel and
 * for any zero-alpha color (#rrggbb00, #rgba with a=0, rgba(...,0)). The
 * ColorField stores #rrggbbaa (opaque collapses to #rrggbb), so a user dialing
 * alpha to 0 turns the background off.
 *
 * Args:
 *   color (string|null|undefined): a CSS-ish color, "" or null/undefined
 *
 * Returns:
 *   boolean
 *
 * Examples:
 *   >>> isTransparentColor("")           // true
 *   >>> isTransparentColor("#ffffff")    // false
 *   >>> isTransparentColor("#ffffff00")  // true (zero alpha)
 *   >>> isTransparentColor("rgba(0,0,0,0)") // true
 */
export function isTransparentColor(color) {
  if (color === null || color === undefined || color === "") return true;
  const hex8 = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/.exec(color);
  if (hex8) return parseInt(hex8[1], 16) === 0;
  const hex4 = /^#[0-9a-fA-F]{3}([0-9a-fA-F])$/.exec(color);
  if (hex4) return parseInt(hex4[1], 16) === 0;
  if (/^rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color)) return true;
  return false;
}

/**
 * Pure function. Is QR `data` EMPTY — blank or whitespace-only, so there is
 * nothing to encode yet? The ONE canonical predicate driving BOTH the ghost hook
 * and emit()'s short-circuit (the mermaid/text ghost convention). An empty QR is
 * an EXPECTED state (a freshly-added widget, or one the user cleared), NOT a
 * failure — so it is guarded here as control flow rather than thrown out of
 * qrMatrix (which keeps throwing LOUDLY for genuinely-invalid NON-empty data).
 *
 * Args:
 *   data (string|null|undefined): the payload to encode
 *
 * Returns:
 *   boolean
 *
 * Examples:
 *   >>> qrDataIsEmpty("")            // true
 *   >>> qrDataIsEmpty("   ")         // true (whitespace-only — nothing to encode)
 *   >>> qrDataIsEmpty(null)          // true
 *   >>> qrDataIsEmpty("https://x")   // false
 */
export function qrDataIsEmpty(data) {
  return data === null || data === undefined || String(data).trim() === "";
}

export const qrcodePlugin = {
  type: "qrcode",
  title: "QR Code",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  /**
   * Pure function. Is this QR widget currently a GHOST? STATE-dependent — a QR
   * widget is a ghost only while its data is empty/blank (qrDataIsEmpty is the
   * canonical predicate, shared with emit()'s short-circuit); core/derive.
   * isGhostNode calls this hook to grant the dashed-outline/findable-when-Show-
   * Ghosts affordance exactly while the widget would otherwise render nothing —
   * the same opt-in the empty text/mermaid widgets make.
   *
   * Examples:
   *   >>> qrcodePlugin.isGhost({ data: "" })                    // true
   *   >>> qrcodePlugin.isGhost({ data: "https://netflix.com" }) // false
   */
  isGhost(state) {
    return qrDataIsEmpty(state.data);
  },
  // Composes the SHARED PROPERTY REGISTRY like shape/rect: positioning + opacity
  // + the effects bundle. The QR-specific rows (data/ecLevel/dark/light/
  // quietModules) are inline plain rows (the text.js precedent for widget-local
  // props not in the shared registry). Default data is a valid URL, so a
  // freshly-placed widget always renders a real, scannable code.
  defaults: {
    type: "qrcode", x: 100, y: 100, w: 200, h: 200, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (the shared
    // equation — manifest Round 11). Absent on old docs → derive falls to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    data: "https://www.netflix.com", ecLevel: "M",
    dark: "#000000", light: "#ffffff", quietModules: QR_SPEC_QUIET_ZONE_MODULES,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  // QR identity FIRST (data + encoding + colors + margin), then the shared paint
  // props. `category: "formatting"` groups them into the Inspector's formatting
  // accordion, beside opacity.
  inspector: [
    ...bundle("positioning"),
    { key: "data", label: "Data", kind: "text", category: "formatting", help: "The text or URL encoded in the QR code. Longer data needs a denser (higher-version) grid." },
    { key: "ecLevel", label: "Error correction", kind: "select", options: EC_LEVELS, optionLabels: EC_LEVEL_LABELS, category: "formatting", help: "How much of the code can be damaged/covered and still scan — higher levels recover more but pack the grid denser." },
    { key: "dark", label: "Dark", kind: "color", category: "formatting", help: "The color of the dark modules (the pattern). Keep strong contrast with the light color so scanners read it." },
    { key: "light", label: "Light", kind: "color", category: "formatting", help: "The background/quiet-zone color. Set its alpha to 0 (transparent) to drop the background and show the slide behind the code." },
    { key: "quietModules", label: "Quiet zone", kind: "number", min: 0, category: "formatting", help: "Width of the blank light margin around the code, in modules. The spec requires at least 4 for reliable scanning." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /** Near-pure function (delegates matrix generation to qrMatrix → the qrcode
   * library; deterministic). State → display-list commands (local space).
   * GHOST short-circuit: empty/blank data draws NOTHING (returns []) via
   * qrDataIsEmpty — the mermaid/text ghost convention — so a fresh or cleared
   * widget never calls (and never crashes) qrMatrix. Otherwise: an optional light
   * background rect (skipped when the light color is transparent) THEN ONE `path`
   * op of all dark modules (vector — crisp at zoom, real vector in SVG/PDF
   * export). Effects (the shared EFFECTS BUNDLE) wrap the ops, all-off =
   * pass-through. A QR-generation failure on genuinely-invalid NON-empty data
   * throws loudly out of qrMatrix (no silent fallback). */
  emit(s, _targetWorldIR, world) {
    // GHOST short-circuit (the mermaid/text convention): blank/whitespace-only
    // data has nothing to encode — an EXPECTED state, not a failure — so draw
    // NOTHING before ever calling qrMatrix (which throws LOUDLY on empty).
    // Guarding the empty case here is expected control flow, NOT a silent
    // fallback; isGhost keeps the empty widget selectable/findable.
    if (qrDataIsEmpty(s.data)) return [];
    const w = s.w ?? 0, h = s.h ?? 0;
    const matrix = qrMatrix(s.data ?? "", s.ecLevel ?? "M");
    const d = qrMatrixToPathD(matrix, { boxW: w, boxH: h, quietModules: s.quietModules ?? QR_SPEC_QUIET_ZONE_MODULES });
    const opacity = s.opacity ?? 1;
    const ops = [];
    if (!isTransparentColor(s.light)) ops.push(rect({ x: 0, y: 0, w, h, fill: s.light, opacity }));
    ops.push(path({ d, fill: s.dark, opacity }));
    return applyEffects(ops, s, world, { x: 0, y: 0, w, h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — a QR is a square
  // box, so the bounding rim IS its silhouette (same choice rect/shape make).
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    // Closest point on the bbox border (cornerRadius 0), like a plain rect.
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRoundedRect(state.w ?? 0, state.h ?? 0, 0, local.x, local.y);
  },
  commands: [
    // Arms crosshair placement (the SAME gesture every Add button uses —
    // CanvasView drives click-drag-places off the plugin's type + defaults).
    { id: "add-qrcode", title: "Add QR Code", icon: "mdi:qrcode", run: (app) => app.armCrosshairPlacement(qrcodePlugin) },
  ],
};
