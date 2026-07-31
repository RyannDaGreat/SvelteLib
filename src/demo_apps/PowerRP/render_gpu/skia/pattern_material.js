/**
 * THE PATTERN MATERIAL — the FOURTH material kind, and the one that is VECTOR all
 * the way to the exporters.
 *
 * ── WHY A NEW KIND, RATHER THAN A MATERIAL PLUGIN ─────────────────────────────
 * THE DESIGN DECISION, recorded because the brief explicitly anticipated it as a
 * possible outcome. core/material_plugins.js's contract REQUIRES `sksl` (a
 * non-empty SkSL source string) and a non-empty `uniforms` block, and its whole
 * data-only argument rests on "the shader is a STRING compiled by Skia". A vector
 * pattern has no shader and no uniform block: its content is GEOMETRY (SVG path
 * strings), and the entire point of the feature — the user's "it's a special
 * material because it uses vector graphics to do it" — is that the geometry
 * survives into the PDF/SVG exporters as real vectors. Declaring a fake one-float
 * uniform and an empty shader to satisfy the existing validator would be
 * shoehorning: it would register a material whose SkSL is never compiled and whose
 * uniforms are never packed, and every future reader would have to discover that
 * by tracing the painter.
 *
 * So this extends the KIND DISPATCH deliberately, exactly as the brief specified.
 * The precedent is already in materials.js and is not a new idea: MAGNIFY_MATERIAL
 * is a registered material carrying NO SkSL at all, declaring `sampler: true` and
 * naming its own IR op. This file adds the same move for `pattern: true` — a
 * material that is DISCOVERABLE through the one registry (so the Mat tab lists it
 * like any other), fill-capable through the ordinary `fillParams` schema (so its
 * knobs are equation-bindable with zero engine change), and routed by the painter
 * to a picture-shader rather than a RuntimeEffect.
 *
 * ── THE THREE BACKENDS, AND WHY ONE CELL SERVES ALL OF THEM ───────────────────
 * `patternCellFor(params)` returns core/vector_patterns' rectangular cell. Then:
 *   · SKIA (editor, render job, CLI still) — the cell's paths are recorded into a
 *     PictureRecorder and tiled with `picture.makeShader(Repeat, Repeat, …)` under
 *     a local matrix carrying scale/offset/rotation. VERIFIED available in the
 *     bundled CanvasKit 0.41.1, on the SOFTWARE surface too, so cli/render.js
 *     draws patterns — unlike image/video/LaTeX, which it cannot.
 *   · SVG export — a native `<pattern>` element with `patternTransform`. Real
 *     vectors, infinitely zoomable, a few hundred bytes regardless of area.
 *   · PDF export — the tile geometry stamped over the shape's bbox and clipped to
 *     it (PDF tiling patterns exist but the stamped form reuses the exporter's
 *     already-proven path emitter; bounded and correct, verbose is fine).
 * All three consume the SAME `{d, paint}` records, so they cannot disagree about
 * what a pattern looks like — which is the property the parity test pins.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────────
 * A pattern introduces NO new kind of state (CLAUDE.md's taxonomy). It is PROPERTY
 * STATE: pure geometry from its own knobs, with a stored integer seed for the
 * scattered variants. It reads no clock — there is no `animated` flag and no route
 * to one — so Δt = 0 renders a byte-identical frame by construction.
 */

import { PATTERN_GENERATORS, patternGeneratorIds, buildPatternCell } from "../../core/vector_patterns.js";

/** The material id a pattern paint names. Lower_snake_case, like every other. */
export const PATTERN_MATERIAL_ID = "vector_pattern";

/**
 * The pattern material's KNOB SCHEMA — its `fillParams`, in the customProps row
 * shape every other fill material uses. Because these are ordinary op params
 * (already-evaluated item state), ANY of them may be authored as a `=` equation
 * with zero engine change, which is the property the brief asked for.
 *
 * `generator` is a SELECT over the generator roster, so adding a generator to
 * core/vector_patterns.js offers it here automatically — the roster is read, never
 * restated. The per-generator knobs (period, radius, seed…) are FLATTENED into one
 * schema rather than nested: a nested param would need its own Inspector row kind,
 * while a flat number row is the vocabulary the paint dropdown already renders.
 * Knobs that do not apply to the selected generator are simply unread by it.
 */
export const PATTERN_FILL_PARAMS = Object.freeze([
  {
    name: "generator", kind: "select", default: "stripes",
    options: patternGeneratorIds(),
    optionLabels: patternGeneratorIds().map((id) => PATTERN_GENERATORS[id].title),
    help: "Which pattern to tile",
  },
  { name: "ink", kind: "color", default: "#1b3fa0", help: "The pattern's foreground colour" },
  { name: "background", kind: "color", default: "#ffffff", help: "The pattern's background colour" },
  { name: "backgroundOff", kind: "boolean", default: false, help: "Leave the background transparent, showing what is behind" },
  { name: "scale", kind: "number", default: 1, min: 0.02, max: 50, step: 0.01, help: "Tile size multiplier" },
  { name: "offsetX", kind: "number", default: 0, min: -1000, max: 1000, step: 1, help: "Horizontal shift of the tiling, in pattern units" },
  { name: "offsetY", kind: "number", default: 0, min: -1000, max: 1000, step: 1, help: "Vertical shift of the tiling, in pattern units" },
  { name: "rotation", kind: "angle", default: 0, min: -360, max: 360, step: 1, unit: "degrees", help: "Rotation of the whole tiling" },
  // ── per-generator knobs (each read only by the generators that declare it) ──
  { name: "period", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Repeat size, for the generators that use one" },
  { name: "side", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Side length (honeycomb, triangles)" },
  { name: "ratio", kind: "number", default: 0.5, min: 0, max: 1, step: 0.01, help: "Inked fraction (stripes, gingham, diamonds)" },
  { name: "thickness", kind: "number", default: 0.12, min: 0.01, max: 0.9, step: 0.01, help: "Line/wall thickness" },
  { name: "radius", kind: "number", default: 0.2, min: 0.01, max: 1.5, step: 0.01, help: "Dot or ring radius, as a fraction of the spacing" },
  { name: "count", kind: "number", default: 14, min: 1, max: 200, step: 1, help: "Dots per domain (random dots)" },
  { name: "seed", kind: "number", default: 1, min: 0, max: 99999, step: 1, help: "Scatter seed (random dots) — the same seed always lays out the same dots" },
  { name: "domain", kind: "number", default: 3, min: 1, max: 8, step: 1, help: "Domain size in cells (random dots) — larger hides the repeat" },
  { name: "jitterSize", kind: "number", default: 0.4, min: 0, max: 1, step: 0.01, help: "Dot size variation (random dots)" },
  { name: "rows", kind: "number", default: 2, min: 1, max: 16, step: 1, help: "Zigzag rows per cell (chevron)" },
  { name: "both", kind: "boolean", default: true, help: "Hatch both diagonals (crosshatch)" },
  { name: "gap", kind: "number", default: 0.1, min: 0, max: 0.45, step: 0.01, help: "Gap between slats/boards (basket weave, plank)" },
  { name: "lobe", kind: "number", default: 0.42, min: 0.1, max: 0.5, step: 0.01, help: "Petal length, as a fraction of spacing (quatrefoil)" },
  { name: "size", kind: "number", default: 0.85, min: 0.05, max: 1, step: 0.01, help: "Motif size, as a fraction of spacing (star, stone size)" },
  { name: "brickW", kind: "number", default: 20, min: 0.5, max: 400, step: 0.5, help: "Brick length (brick)" },
  { name: "brickH", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Brick course height (brick)" },
  { name: "mortar", kind: "number", default: 0.08, min: 0, max: 0.3, step: 0.01, help: "Mortar gap (brick)" },
  { name: "overlap", kind: "number", default: 0.15, min: 0, max: 0.5, step: 0.01, help: "Scale overlap (scallop)" },
  { name: "roundness", kind: "number", default: 0.6, min: 0, max: 1, step: 0.01, help: "0 = squared masonry, 1 = rounded pebbles (stone coursing)" },
  { name: "sides", kind: "number", default: 7, min: 4, max: 12, step: 1, help: "Polygon sides per stone (stone coursing)" },
  { name: "boardW", kind: "number", default: 24, min: 0.5, max: 400, step: 0.5, help: "Board length (plank)" },
  { name: "boardH", kind: "number", default: 8, min: 0.5, max: 400, step: 0.5, help: "Board course height (plank)" },
  { name: "waveAmp", kind: "number", default: 0.18, min: 0, max: 0.45, step: 0.01, help: "Grain wave amplitude (plank)" },
  { name: "waveCycles", kind: "number", default: 3, min: 1, max: 8, step: 1, help: "Grain wave cycles (plank)" },
  { name: "steps", kind: "number", default: 3, min: 2, max: 5, step: 1, help: "Staircase treads per meander (Greek key)" },
]);

/**
 * Pure function. A pattern paint's resolved params → the CELL to tile. The ONE
 * seam every backend calls, so the three of them cannot disagree about geometry.
 *
 * Only the knobs the chosen generator actually declares are forwarded, so a
 * generator never sees a knob it has no schema row for (its own defaults then
 * apply to anything the flat schema does not carry).
 *
 * @param {object} params - resolved pattern knobs (generator + its own)
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example patternCellFor({generator: "stripes", period: 8, ratio: 0.25}).w // 8
 * @example patternCellFor({generator: "checkerboard", period: 6}).w // 12
 * @example patternCellFor({generator: "honeycomb", side: 10}).shapes.length // 5
 */
export function patternCellFor(params) {
  const id = params?.generator ?? "stripes";
  const gen = PATTERN_GENERATORS[id];
  if (!gen) throw new Error(`pattern_material: unknown generator "${id}" (known: ${patternGeneratorIds().join(", ")})`);
  const own = {};
  for (const row of gen.params) if (params[row.name] !== undefined) own[row.name] = params[row.name];
  return buildPatternCell(id, own);
}

/**
 * Pure function. The pattern's LOCAL MATRIX — the affine that carries scale,
 * offset and rotation from knob values into the tiling, as a 6-tuple
 * [a, b, c, d, e, f] in the SVG/PDF convention (x' = a·x + c·y + e).
 *
 * ORDER IS ROTATE-THEN-SCALE-THEN-TRANSLATE, applied to the pattern space: the
 * offsets are in PATTERN units (so nudging offsetX by one period moves the tiling
 * exactly one tile regardless of scale, which is what makes the knob usable), and
 * the rotation turns the whole tiling about the shape's origin.
 *
 * @param {{scale: number, offsetX: number, offsetY: number, rotation: number}} params
 * @returns {number[]} [a, b, c, d, e, f]
 *
 * @example patternMatrix({scale: 1, offsetX: 0, offsetY: 0, rotation: 0}) // [1, 0, 0, 1, 0, 0]
 * @example patternMatrix({scale: 2, offsetX: 0, offsetY: 0, rotation: 0}) // [2, 0, 0, 2, 0, 0]
 * @example patternMatrix({scale: 1, offsetX: 3, offsetY: 4, rotation: 0}) // [1, 0, 0, 1, 3, 4]
 */
export function patternMatrix({ scale = 1, offsetX = 0, offsetY = 0, rotation = 0 } = {}) {
  for (const [name, v] of Object.entries({ scale, offsetX, offsetY, rotation }))
    if (!Number.isFinite(v)) throw new Error(`pattern_material.patternMatrix: "${name}" is ${v} — every pattern transform knob must be finite`);
  const s = Math.max(scale, 1e-6);
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // Rotation composed with uniform scale; the translation is the offset carried
  // through the same rotation+scale so a shifted tiling stays aligned with itself.
  // `+ 0` normalizes -0 to 0: at rotation 0 the `-s·sin` term is NEGATIVE ZERO,
  // which is numerically identical but SERIALIZES as "-0" into the SVG's
  // patternTransform and the PDF's Matrix. Harmless to a renderer, but it makes
  // export bytes differ for two documents that are the same, which defeats the
  // byte-comparison the parity tests rely on.
  return [s * cos + 0, s * sin + 0, -s * sin + 0, s * cos + 0, offsetX + 0, offsetY + 0];
}

/**
 * Pure function. A cell shape's abstract paint slot → the concrete RGBA the
 * consumer should use, or null when the slot is OFF (a transparent background —
 * the first-class OFF state the user asked for, so a pattern can overlay whatever
 * is behind it).
 *
 * @param {{paint: string, alpha?: number}} shape - a cell shape record
 * @param {object} params - resolved pattern knobs
 * @param {function(string): number[]} parseColor - colour string → [r,g,b,a]
 * @returns {number[]|null} [r, g, b, a], or null when the slot is off
 *
 * @example shapeColor({paint: "ink"}, {ink: "#000"}, () => [0, 0, 0, 1]) // [0, 0, 0, 1]
 * @example shapeColor({paint: "background"}, {backgroundOff: true}, () => [1, 1, 1, 1]) // null
 * @example shapeColor({paint: "ink", alpha: 0.5}, {ink: "#000"}, () => [0, 0, 0, 1]) // [0, 0, 0, 0.5]
 */
export function shapeColor(shape, params, parseColor) {
  if (shape.paint === "background") {
    if (params.backgroundOff) return null;
    return parseColor(params.background ?? "#ffffff");
  }
  const rgba = parseColor(params.ink ?? "#000000");
  // A cell shape's own `alpha` (gingham's overlapping bands, plaid's tone stack)
  // MULTIPLIES the ink's alpha — that is what builds the third and fourth tones
  // out of a single ink colour.
  return shape.alpha === undefined ? rgba : [rgba[0], rgba[1], rgba[2], rgba[3] * shape.alpha];
}

/**
 * THE PATTERN MATERIAL DESCRIPTOR — registered into the ONE material registry, so
 * the Mat tab lists it beside glass and CRT.
 *
 * `pattern: true` is the kind flag, the exact analogue of magnify's `sampler:
 * true`: it keeps this descriptor out of the SkSL compile and backdrop paths
 * (isBackdropMaterial → false via `backdrop: false`; there is no `sksl` to
 * compile) and tells the painter to route through the picture-shader path.
 *
 * `backdrop: false` makes it a FOREGROUND material — it synthesizes its own look
 * and reads nothing beneath it, so it needs no below-content re-render. That also
 * means it participates in the existing static raster cache for free.
 */
export const PATTERN_MATERIAL = Object.freeze({
  id: PATTERN_MATERIAL_ID,
  title: "Vector Pattern",
  pattern: true,
  backdrop: false,
  fillParams: PATTERN_FILL_PARAMS,
});

/**
 * Pure function. Is this material the vector-pattern kind — i.e. does it draw by
 * TILING VECTOR GEOMETRY rather than by running a shader? The predicate the
 * painter and both vector exporters route on, and the twin of
 * materials.isSamplerMaterial.
 *
 * @param {{pattern?: boolean}} material - a descriptor from getMaterial()
 * @returns {boolean}
 *
 * @example isPatternMaterial({id: "vector_pattern", pattern: true}) // true
 * @example isPatternMaterial({id: "crt"}) // false
 */
export function isPatternMaterial(material) {
  return material?.pattern === true;
}

/**
 * THE PRESET ROSTER — structured as DATA so a follow-up wave can add the long tail
 * without touching the engine. Each entry is the `{id, title, description, params}`
 * shape render_gpu/skia/material_presets.js already serves, with `params` sparse
 * over PATTERN_FILL_PARAMS (only what the preset means to change).
 *
 * The roster spans the reference imagery the ruling named: fabric (chevron,
 * gingham, houndstooth, lattice, plaid) and CAD hatch sheets (hex, crosshatch,
 * herringbone, zigzag, triangles).
 */
export const PATTERN_PRESETS = Object.freeze([
  { id: "pinstripe", title: "Pinstripe", description: "Fine navy pinstripe on white — suiting cloth", params: { generator: "stripes", period: 12, ratio: 0.08, ink: "#1b2a5e", background: "#f5f5f0" } },
  { id: "awning", title: "Awning Stripe", description: "Bold even stripes, the market-stall awning", params: { generator: "stripes", period: 16, ratio: 0.5, ink: "#c1272d", background: "#fdfdfd" } },
  { id: "checkerboard", title: "Checkerboard", description: "Hard two-tone check", params: { generator: "checkerboard", period: 10, ink: "#1a1a1a", background: "#fafafa" } },
  { id: "gingham", title: "Gingham", description: "Woven two-tone check — the overlaps make the third tone", params: { generator: "gingham", period: 14, ratio: 0.5, ink: "#c1272d", background: "#ffffff" } },
  { id: "harlequin", title: "Harlequin Diamonds", description: "Offset diamond lattice", params: { generator: "diamonds", period: 18, ratio: 1, ink: "#2d1b4e", background: "#f0e6d2" } },
  { id: "polka", title: "Polka Dots", description: "Even staggered dots", params: { generator: "polka_dots", period: 16, radius: 0.22, ink: "#ffffff", background: "#d63384" } },
  { id: "confetti", title: "Random Dots", description: "Scattered dots of varied size — seeded, so it never changes underneath you", params: { generator: "random_dots", period: 14, radius: 0.13, count: 18, seed: 7, domain: 3, jitterSize: 0.5, ink: "#2b8a3e", background: "#ffffff" } },
  { id: "tartan", title: "Plaid", description: "Banded tartan; the crossings build the deeper tones", params: { generator: "plaid", ink: "#1f4d2b", background: "#e8d9b0" } },
  { id: "chevron", title: "Chevron", description: "Zigzag bands — the fabric sheet's chevron", params: { generator: "chevron", period: 20, thickness: 0.3, rows: 2, ink: "#264653", background: "#f4f1de" } },
  { id: "honeycomb", title: "Honeycomb", description: "Hex grid — a hexagonal tiling as a rectangular cell", params: { generator: "honeycomb", side: 10, thickness: 0.1, ink: "#b8860b", background: "#fffbe6" } },
  { id: "triangles", title: "Triangles", description: "Equilateral triangle grid", params: { generator: "triangles", side: 14, ink: "#e76f51", background: "#fdf0e9" } },
  { id: "crosshatch", title: "Crosshatch", description: "Diagonal hatch in both directions — the CAD hatch sheet", params: { generator: "crosshatch", period: 9, thickness: 0.09, both: true, ink: "#333333", background: "#ffffff" } },
  { id: "hatch45", title: "Hatch 45°", description: "Single-direction section hatch", params: { generator: "crosshatch", period: 8, thickness: 0.1, both: false, ink: "#444444", background: "#ffffff" } },
  { id: "herringbone", title: "Herringbone", description: "Interlocking brick courses — parquet and tweed", params: { generator: "herringbone", period: 14, thickness: 0.16, ink: "#6b4423", background: "#f3e9dc" } },
  { id: "houndstooth", title: "Houndstooth", description: "The broken check", params: { generator: "houndstooth", period: 9, ink: "#111111", background: "#ffffff" } },
  { id: "lattice", title: "Lattice", description: "Interlaced rings — quatrefoil-adjacent trellis", params: { generator: "lattice", period: 22, radius: 0.5, thickness: 0.06, ink: "#4a7c9e", background: "#fbfbfb" } },
  { id: "blueprint", title: "Blueprint Grid", description: "White rule on drafting blue — the graph-paper ground", params: { generator: "crosshatch", period: 10, thickness: 0.05, both: true, ink: "#ffffff", background: "#0d3b66", rotation: 45 } },
  { id: "ghost_dots", title: "Ghost Dots", description: "Dots over a transparent background — overlays whatever is behind", params: { generator: "polka_dots", period: 14, radius: 0.16, ink: "#ffffff", backgroundOff: true } },

  // ── THE LONG TAIL — fabric sheet (56.png) ───────────────────────────────────
  { id: "basket_weave", title: "Basket Weave", description: "Over-under woven slats — the fabric sheet's basket weave", params: { generator: "basket_weave", period: 10, gap: 0.12, ink: "#8a6d3b", background: "#f2e7d0" } },
  { id: "buffalo_check", title: "Buffalo Check", description: "Bold oversized two-tone block check — the flannel classic", params: { generator: "checkerboard", period: 22, ink: "#1a1a1a", background: "#c1272d" } },
  { id: "fret", title: "Greek Key", description: "Right-angle meander border, tiled as a field — the fabric sheet's fret/key", params: { generator: "fret", period: 12, thickness: 0.18, ink: "#2b2b2b", background: "#f4f1de" } },
  { id: "greek_key", title: "Greek Key (Bold)", description: "A bolder, larger-scale fret", params: { generator: "fret", period: 20, thickness: 0.22, ink: "#0d3b66", background: "#ffffff" } },
  { id: "moroccan", title: "Moroccan Tile", description: "Four-lobed medallion lattice — Moroccan zellige tilework", params: { generator: "quatrefoil", period: 18, lobe: 0.44, ink: "#0d5c63", background: "#f6e7d8" } },
  { id: "quatrefoil", title: "Quatrefoil", description: "Classic four-petal quatrefoil lattice", params: { generator: "quatrefoil", period: 16, lobe: 0.38, ink: "#5b2a86", background: "#ffffff" } },
  { id: "trellis", title: "Trellis", description: "Diagonal interlaced lattice — garden trellis", params: { generator: "lattice", period: 20, radius: 0.55, thickness: 0.07, ink: "#3d5a3d", background: "#fbfbf5", rotation: 45 } },
  { id: "star8", title: "Eight-Point Star", description: "Two overlapping squares — the classic quilt star tile", params: { generator: "star8", period: 16, size: 0.85, ink: "#8b1e3f", background: "#f5f0e6" } },
  { id: "fleur_star", title: "Star Medallion", description: "A finer, more crowded eight-point star field", params: { generator: "star8", period: 10, size: 0.95, ink: "#1b2a5e", background: "#ffffff" } },

  // ── THE LONG TAIL — CAD hatch sheet (57.png) ────────────────────────────────
  { id: "brick", title: "Brick", description: "Running-bond brick coursing — the plain CAD brick hatch", params: { generator: "brick", brickW: 20, brickH: 10, mortar: 0.08, ink: "#9c3b2e", background: "#e8e0d5" } },
  { id: "zline", title: "Brick (Fine)", description: "A finer running-bond course, section-hatch scale", params: { generator: "brick", brickW: 12, brickH: 6, mortar: 0.1, ink: "#555555", background: "#ffffff" } },
  { id: "zigzag2", title: "Zigzag (CAD)", description: "Section zigzag hatch at CAD scale", params: { generator: "chevron", period: 10, thickness: 0.22, rows: 3, ink: "#333333", background: "#ffffff" } },
  { id: "hex2", title: "Hex Grid (Filled)", description: "Solid-filled hex cells rather than an outline ring — the CAD sheet's second hex hatch", params: { generator: "honeycomb", side: 9, thickness: 0.48, ink: "#ffffff", background: "#444444" } },
  { id: "fanned", title: "Fanned / Fish Scale", description: "Overlapping fanned scales — the CAD fanned hatch", params: { generator: "scallop", radius: 9, overlap: 0.12, ink: "#666666", background: "#ffffff" } },
  { id: "scallop", title: "Scallop Shell", description: "Larger overlapping scallops — shell trim", params: { generator: "scallop", radius: 14, overlap: 0.2, ink: "#2f6690", background: "#eaf4f4" } },
  { id: "floorboard", title: "Floorboard", description: "Offset plank courses, plain (no grain) — parquet floor", params: { generator: "plank", boardW: 28, boardH: 7, gap: 0.08, waveAmp: 0, ink: "#7a5230", background: "#c9a679" } },
  { id: "woodgrain", title: "Wood Grain", description: "Plank courses with a wavy grain line down each board", params: { generator: "plank", boardW: 24, boardH: 8, gap: 0.08, waveAmp: 0.16, waveCycles: 3, seed: 4, ink: "#6b4423", background: "#c9a679" } },
  { id: "wavygrain", title: "Wavy Grain (Bold)", description: "A stronger, slower grain wave — coarse timber", params: { generator: "plank", boardW: 30, boardH: 10, gap: 0.06, waveAmp: 0.32, waveCycles: 2, seed: 9, ink: "#4a2f1a", background: "#d8b98c" } },
  { id: "cedarshake", title: "Cedar Shake", description: "Narrow shingle courses with a rough grain — roofing shake", params: { generator: "plank", boardW: 14, boardH: 6, gap: 0.14, waveAmp: 0.22, waveCycles: 4, seed: 2, ink: "#6e4b2a", background: "#e6d3b3" } },
  { id: "roofslate", title: "Roof Slate", description: "Broad flat slate courses, minimal grain", params: { generator: "plank", boardW: 22, boardH: 9, gap: 0.1, waveAmp: 0.06, waveCycles: 2, seed: 5, ink: "#3a4750", background: "#c7ced1" } },
  { id: "spanish_roof", title: "Spanish Roof Tile", description: "Scalloped courses over a warm terracotta ground — Spanish barrel tile", params: { generator: "scallop", radius: 11, overlap: 0.22, ink: "#9c4a2e", background: "#e2a262" } },
  { id: "pebble", title: "Pebble", description: "Scattered rounded stones — seeded, so it never changes underneath you", params: { generator: "cobble", count: 12, seed: 11, domain: 3, size: 0.24, roundness: 0.85, sides: 8, ink: "#8a8578", background: "#d9d4c4" } },
  { id: "cobblestone", title: "Cobblestone", description: "Larger rounded stones, tightly packed", params: { generator: "cobble", count: 8, seed: 6, domain: 2, size: 0.34, roundness: 0.7, sides: 7, ink: "#6b6559", background: "#a8a190" } },
  { id: "rubblestone", title: "Rubblestone", description: "Irregular angular stones — dry-stone rubble wall", params: { generator: "cobble", count: 9, seed: 21, domain: 3, size: 0.3, roundness: 0.95, sides: 6, ink: "#7d7264", background: "#c4b9a3" } },
  { id: "gravel", title: "Gravel", description: "Many small rounded stones — fine aggregate", params: { generator: "cobble", count: 30, seed: 8, domain: 3, size: 0.12, roundness: 0.9, sides: 6, ink: "#9a9284", background: "#cfc9bc" } },
  { id: "granules", title: "Granules", description: "Very fine scattered grains — the finest CAD aggregate hatch", params: { generator: "cobble", count: 60, seed: 15, domain: 2, size: 0.08, roundness: 0.8, sides: 5, ink: "#8f8a7e", background: "#ded9cc" } },
  { id: "squared_stones", title: "Squared Stones", description: "Hard-edged rectangular ashlar blocks", params: { generator: "cobble", count: 8, seed: 13, domain: 2, size: 0.32, roundness: 0.08, sides: 4, ink: "#8c8c8c", background: "#e0e0e0" } },
  { id: "stonewall", title: "Stone Wall", description: "Larger squared blocks, coarse coursing", params: { generator: "cobble", count: 6, seed: 17, domain: 2, size: 0.38, roundness: 0.15, sides: 5, ink: "#75726b", background: "#b8b3a8" } },
  { id: "paving", title: "Paving", description: "Regular squared paving slabs, tight joints", params: { generator: "cobble", count: 9, seed: 19, domain: 3, size: 0.28, roundness: 0.05, sides: 4, ink: "#9a9a9a", background: "#dcdcdc" } },
  { id: "limestone", title: "Limestone Block", description: "Pale squared masonry — limestone ashlar", params: { generator: "cobble", count: 7, seed: 23, domain: 2, size: 0.34, roundness: 0.1, sides: 4, ink: "#c9c2ac", background: "#f0ead9" } },
  { id: "swamp", title: "Swamp / Grass Tufts", description: "Scattered irregular tufts — the CAD wetland/vegetation hatch", params: { generator: "cobble", count: 16, seed: 25, domain: 3, size: 0.18, roundness: 1, sides: 5, ink: "#4a7c3f", background: "#dcedd0" } },
  { id: "star_hatch", title: "Star Hatch", description: "Small eight-point stars as a CAD masonry star hatch", params: { generator: "star8", period: 8, size: 0.7, ink: "#555555", background: "#ffffff" } },
]);
