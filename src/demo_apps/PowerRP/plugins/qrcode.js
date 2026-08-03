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
 * DOUBLE-CLICK opens a FLOATING CANVAS TOOLBAR (`activate: "overlay_palette"` +
 * the `floatingToolbar`/`fieldWrites` pair at the bottom of this file) holding one
 * field: the encoded payload. The point is that a QR's content is its whole
 * meaning, and reading it off the canvas is impossible — so it is editable AT the
 * widget, not only in the Inspector. It works on a GHOSTED (empty-data) code too,
 * because hit testing is bbox-based and never asks emit() what it drew.
 *
 * Structure mirrors plugins/shape.js: it composes the SHARED PROPERTY REGISTRY
 * (positioning + opacity + the effects bundle), rides the effects bundle for
 * shadow/glow/border via applyEffects, and uses the standard bbox anchors — the
 * math lives in the pure helpers below, emit() stays thin.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect } from "../core/outline.js";
import { morphPayloadFromPaths } from "../core/morph_payload.js";
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

// Two quiet zones above the spec minimum, expressed as multiples of it because the
// multiple IS the explanation. Half again wider survives a scuffed printed edge;
// double is what a TRANSPARENT background needs, since with no light rect drawn the
// clear margin has to be bought as blank MODULES of grid instead of as paint.
const WIDE_QUIET_ZONE_MODULES = QR_SPEC_QUIET_ZONE_MODULES * 1.5;
const TRANSPARENT_QUIET_ZONE_MODULES = QR_SPEC_QUIET_ZONE_MODULES * 2;

/**
 * THE TEN CODES: SAFE ROWS FIRST, CAVEATED ROWS LAST — one FLAT family.
 *
 * ONE FLAT `presets`. With four look knobs there is no disjoint split that
 * composes, and a split would be worse than merely stylistic here: these presets
 * carry a SCANNABILITY claim, and letting two families compose into a third state
 * neither of them vouched for turns a taste question into a correctness one.
 *
 * EVERY PRESET SETS ALL FOUR LOOK KNOBS (`ecLevel`, `dark`, `light`,
 * `quietModules`) — application is an overlay, and this is the one family in the
 * instruments set with no inert value anywhere: all four move pixels in all ten.
 *
 * THE ORDER IS THE CONTENT, and here it is a SAFETY ordering as much as an
 * aesthetic one: three neutral codes by rising error correction, then five coloured
 * ones, then the two whose scannability carries a condition. The rows an author
 * reaches for without thinking are the ones at the top.
 *
 * WHY COLOUR IS FREE AND BRIGHTNESS IS NOT. A decoder takes only the BRIGHTNESS
 * information from the image, so a code's hue is unconstrained while its LUMINANCE
 * GAP is the whole ballgame. That is why "Oxblood" is a very dark red rather than a
 * bright one, and why "Signal Yellow" puts the near-black on the yellow rather than
 * the other way round: yellow is a HIGH-luminance colour, so it belongs on the light
 * side of the pair however saturated it looks.
 *
 * WHY NO PRESET GOES BELOW FOUR QUIET-ZONE MODULES. The format requires a
 * four-module margin on all four sides. A tighter margin is a real design temptation
 * and it is deliberately not offered — an unscannable code is worse than no preset —
 * and a one-module row drafted for this table was dropped rather than shipped. The
 * Inspector row still allows it for an author who knows what they are giving up.
 *
 * NO NUMERIC CONTRAST THRESHOLD IS CLAIMED. No citable reflectance or symbol-contrast
 * figure could be sourced for this table, so every contrast judgement below rests on
 * the luminance-only decoding rule plus a visibly large brightness gap, and no
 * description quotes a number it cannot support.
 *
 * NO PRESET SETS `data` — the payload is the author's content, the purest case of a
 * preset refusing to overwrite the reading. AND NO PRESET SETS AN EFFECT: a shadow
 * or a bloom changes the local luminance around and inside the modules, which is the
 * one property decoding actually depends on, so a family carrying a scannability
 * claim leaves the effects bundle alone. That is a decision, not an omission.
 */
const PRESETS = [
  { name: "Screen Minimum", description: "The lightest encoding, for a code on a screen where nothing can damage it: 7% recovery and the smallest grid the payload allows, so the modules stay as large as possible.", props: { ecLevel: "L", dark: "#000000", light: "#ffffff", quietModules: QR_SPEC_QUIET_ZONE_MODULES } },
  { name: "Sticker Quartile", description: "The code for a printed sticker that will get scuffed: quartile recovery at 25%, on a margin half again wider than the format's minimum.", props: { ecLevel: "Q", dark: "#000000", light: "#ffffff", quietModules: WIDE_QUIET_ZONE_MODULES } },
  { name: "Label Print", description: "Maximum recovery for a label that will be creased, wet or partly covered: 30% of codewords restorable, at the cost of the densest grid in the set.", props: { ecLevel: "H", dark: "#000000", light: "#ffffff", quietModules: QR_SPEC_QUIET_ZONE_MODULES } },
  { name: "Ink Navy", description: "A printed code in navy ink on cream stock: the hue costs nothing, because a decoder takes only brightness from the image and navy on cream is still a wide gap.", props: { ecLevel: "M", dark: "#10233f", light: "#f7f3e8", quietModules: QR_SPEC_QUIET_ZONE_MODULES } },
  { name: "Deep Forest", description: "The same trick in bottle green, at quartile recovery, for packaging that has to survive being handled before anyone points a camera at it.", props: { ecLevel: "Q", dark: "#0f3d2e", light: "#ffffff", quietModules: QR_SPEC_QUIET_ZONE_MODULES } },
  { name: "Oxblood", description: "A dark red code — dark being the operative word: the modules are near-black wine, because a bright red is not a dark module to a decoder no matter how red it looks.", props: { ecLevel: "M", dark: "#5a0f14", light: "#ffffff", quietModules: QR_SPEC_QUIET_ZONE_MODULES } },
  { name: "Ultraviolet", description: "Deep violet on pale lilac at the lightest encoding: a screen-only code that only has to work once, so it spends its budget on the largest possible modules.", props: { ecLevel: "L", dark: "#2a1348", light: "#f0eaff", quietModules: QR_SPEC_QUIET_ZONE_MODULES } },
  { name: "Signal Yellow", description: "The high-visibility signage pair: near-black modules on saturated yellow, which belongs on the LIGHT side of the pair because yellow is a high-luminance colour however loud it is.", props: { ecLevel: "M", dark: "#1a1400", light: "#ffd400", quietModules: QR_SPEC_QUIET_ZONE_MODULES } },
  // The two caveated rows, last on purpose. INVERSION is not something every reader
  // is known to handle and no source settled it either way, so this one spends
  // maximum error correction buying back the margin and sits second-to-last.
  { name: "Negative", description: "The inverted code for a dark slide — light modules on black. Inversion is not something every reader handles, so this spends maximum error correction buying back the margin.", props: { ecLevel: "H", dark: "#ffffff", light: "#000000", quietModules: QR_SPEC_QUIET_ZONE_MODULES } },
  // TRANSPARENT `light`: the widget draws no background rect at all (see
  // isTransparentColor), so the quiet zone becomes whatever is behind the widget.
  // The doubled margin buys SPACING only — it cannot buy contrast, which is exactly
  // why this row is conditional on the backdrop and is placed last.
  { name: "Overlay", description: "No background at all: the code drops straight onto the slide behind it, with a doubled quiet zone and maximum recovery, so it only holds over a light and uncluttered backdrop.", props: { ecLevel: "H", dark: "#000000", light: "#ffffff00", quietModules: TRANSPARENT_QUIET_ZONE_MODULES } },
];

export const qrcodePlugin = {
  type: "qrcode",
  ephemeral: EPHEMERAL.NONE,
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
   *   >>> qrcodePlugin.isGhost({ data: "https://example.com" }) // false
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
    data: "https://www.example.com", ecLevel: "M",
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
  presets: PRESETS,
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
  /**
   * Pure function. Why this QR cannot morph YET, or null — the `morphNotReady`
   * half of the morph protocol (core/registry.js). It shares `qrDataIsEmpty`
   * with emit()'s ghost short-circuit, so the gate cannot disagree with what is
   * actually drawn: a ghosted code draws NOTHING, and morphing a real contour
   * against an empty payload would pair it with nothing.
   *
   * @example qrcodePlugin.morphNotReady({data: ""}) // 'data to encode (this code is empty)'
   * @example // qrcodePlugin.morphNotReady({data: "https://x"}) // null
   */
  morphNotReady(s) {
    return qrDataIsEmpty(s.data) ? "data to encode (this code is empty)" : null;
  },
  /**
   * Near-pure function (delegates the matrix to qrMatrix → the qrcode library;
   * DETERMINISTIC). THE MORPH OUTLINE (core/registry.js's `morphPaths`
   * protocol): the dark modules as cubic contours, from the SAME
   * `qrMatrix` + `qrMatrixToPathD` pair emit() draws with — so what morphs is
   * exactly what renders, run-merging and all.
   *
   * THE QUIET ZONE IS WHY THE PAYLOAD IS NOT SIMPLY "THE BOX". `qrMatrixToPathD`
   * already places every module at its true box-local position: the grid is
   * scaled by min(w,h)/(N + 2·quiet) and CENTERED, so the modules occupy an inset
   * sub-rect of the box and a non-square box leaves slack on the long axis. That
   * offset must ride along or the morph's first frame jumps away from what the
   * widget was showing at alpha 0 — the LL lesson (a payload has to describe
   * where the ink ACTUALLY sits in the box, not where the box is). Since the `d`
   * is generated in box coordinates already, the honest space IS the box and
   * there is nothing to bake; the inset is inside the coordinates.
   *
   * THE BACKGROUND RECT IS DELIBERATELY NOT IN THE PAYLOAD. emit() draws an
   * optional light rect UNDER the modules, and it is a backdrop rather than ink:
   * including it would hand the aligner a box-sized contour that dominates
   * pairing (it is by far the largest subpath), so a QR→circle would pair the
   * circle with the BACKGROUND and collapse the whole grid into the middle. The
   * "Overlay" preset draws no rect at all, so it would also make the payload
   * depend on a paint choice. What morphs is the code.
   *
   * NONZERO WINDING, matching emit()'s `path` op (which declares no fillRule and
   * therefore fills nonzero). The module rectangles are disjoint, so the two
   * rules agree on a real code — stating it keeps them from drifting apart if a
   * future style ever overlaps runs.
   *
   * PERFORMANCE, MEASURED rather than assumed: a version-4 code (33×33) merges to
   * ~180 subpaths and a dense version-10 to ~450, and the aligner pairs subpaths
   * with an O(n·m) score matrix. tests/morph_qrcode_test.js times a real
   * QR→circle alignment and records the number.
   */
  morphPaths(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const matrix = qrMatrix(s.data ?? "", s.ecLevel ?? "M");
    const d = qrMatrixToPathD(matrix, { boxW: w, boxH: h, quietModules: s.quietModules ?? QR_SPEC_QUIET_ZONE_MODULES });
    return morphPayloadFromPaths([{ d, paint: { fill: s.dark ?? null, stroke: null, strokeWidth: 0, opacity: s.opacity ?? 1 } }], { w, h });
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
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): mount the
  // floating canvas toolbar below. The hit path is BBOX-based (core/derive.hitNode
  // falls to `capabilities.bbox` because this plugin declares no hitTest), so it
  // does NOT consult emit() or isGhost — a GHOSTED code (data cleared, drawing
  // nothing) is still double-clickable at its box, which is exactly the case the
  // toolbar has to be reachable for: it is the only way to type the payload back
  // in without going to the Inspector.
  activate: "overlay_palette",
  /**
   * Pure function. THE CANVAS TOOLBAR: one field for the encoded payload, so a
   * QR's actual CONTENT is editable where the code is, instead of only in the
   * Inspector's formatting accordion. `keys: ["data"]` is what lets
   * web/CanvasToolbar.svelte disable the field when `data` holds an `=` equation
   * (committing would overwrite the binding with its current text).
   *
   * The value is the STORED string verbatim — no trimming, no placeholder for the
   * empty/ghost case: a cleared code shows an empty field, which is the true
   * reading and the thing the author is about to fix.
   *
   * @param {object} s folded, EVALUATED item state
   * @returns {object} the CanvasToolbar spec
   *
   * @example qrcodePlugin.floatingToolbar({data: "https://x"}).fields[0].value // "https://x"
   * @example qrcodePlugin.floatingToolbar({data: ""}).fields[0].id // "data"
   */
  floatingToolbar(s) {
    return {
      label: "QR Code",
      fields: [
        {
          id: "data", label: "Data", value: String(s.data ?? ""), keys: ["data"], size: "wide",
          help: "The text or URL this code encodes. Longer payloads need a denser grid; clearing it leaves the widget blank but still selectable.",
        },
      ],
    };
  },
  /**
   * Pure function. The toolbar field's typed text → the property writes storing
   * it. The payload is FREE TEXT, so every string is accepted verbatim —
   * including the empty one, which is the documented "nothing to encode yet"
   * ghost state (qrDataIsEmpty), not a refusal. That is why this never returns
   * null the way the numeric bars (globe_map, scene3d) do: there is no
   * unparseable QR payload.
   *
   * @param {object} _s folded state (unused — the write does not depend on it)
   * @param {string} id the field id from floatingToolbar
   * @param {string} text the raw typed text
   * @returns {object} the property writes
   *
   * @example qrcodePlugin.fieldWrites({}, "data", "https://example.org") // {data: "https://example.org"}
   * @example qrcodePlugin.fieldWrites({}, "data", "") // {data: ""} (clears the code — an expected ghost state)
   */
  fieldWrites(_s, id, text) {
    if (id === "data") return { data: String(text) };
    throw new Error(`qrcode fieldWrites: unknown field "${id}" (declared: data)`);
  },
  commands: [
    // Arms crosshair placement (the SAME gesture every Add button uses —
    // CanvasView drives click-drag-places off the plugin's type + defaults).
    { id: "add-qrcode", title: "Add QR Code", icon: "mdi:qrcode", run: (app) => app.armCrosshairPlacement(qrcodePlugin) },
  ],
};
