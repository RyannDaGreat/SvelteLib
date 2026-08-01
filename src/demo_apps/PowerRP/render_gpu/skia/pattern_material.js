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
 *
 * ── `generator` IS A MODE SELECTOR ────────────────────────────────────────────
 * A MODE SELECTOR is a property whose VALUE decides which of its SIBLINGS are
 * applicable; the inapplicable ones are HIDDEN, not shown inert. `generator` is
 * one: the schema below is 8 TILING knobs plus 26 PER-GENERATOR ones, and a
 * generator reads between zero (plaid) and six (cobble, plank) of the 26 — so
 * every pattern used to show 20 to 26 controls that could not change its picture.
 * The panel now shows 8 to 14. materials.visibleKnobRows carries the general rule
 * and the affordance argument behind it; what is local to this file is that the
 * predicate is DERIVED from each generator's own `params` declaration — the SAME
 * declaration patternCellFor forwards from — so it cannot disagree with what the
 * generator actually consumes, and a generator that gains a knob offers it with
 * no edit here. A hand-written generator→knobs map would be this codebase's
 * most-found defect (a mirror of another module's shape, edited in lockstep or
 * silently wrong); it would rot the instant a generator changed.
 *
 * ── AND SO ARE THE ROWS THEMSELVES ────────────────────────────────────────────
 * The per-generator rows are not merely TAGGED from the roster, they are BUILT
 * from it. They used to be hand-typed beside it, and the two had drifted on 30
 * aspects — the flat default WINS at resolution, so every generator's own
 * authored default was unreachable. The measured worst case: `radius` was
 * declared by four generators meaning two different things, a FRACTION of the
 * spacing for dots (0.01–0.5) and an ABSOLUTE length for scallop (0.5–400), and
 * the flat row was the fraction, so choosing Scallop from the dropdown drew a
 * degenerate pattern whose slider could not reach a usable value. Deriving the
 * rows makes that class of divergence unrepresentable, and the collision gate
 * below turns "one name, two quantities" into an import-time refusal rather than
 * a wrong picture.
 */

import { PATTERN_GENERATORS, patternGeneratorIds, buildPatternCell } from "../../core/vector_patterns.js";

/** The material id a pattern paint names. Lower_snake_case, like every other. */
export const PATTERN_MATERIAL_ID = "vector_pattern";

/**
 * The generator an untouched pattern is. The schema default, patternCellFor's
 * resolution of an unwritten `generator`, and the row-visibility predicate all read
 * THIS one constant, so the three cannot disagree about what a fresh pattern draws.
 */
export const PATTERN_DEFAULT_GENERATOR = "stripes";

/**
 * Pure function. Does the generator called `generatorId` READ the knob called
 * `name`? Answered from the generator's OWN `params` declaration in
 * core/vector_patterns.js, which is the same declaration patternCellFor forwards
 * from — so this can never claim a knob applies that the generator ignores, nor
 * hide one it reads.
 *
 * AN UNRESOLVABLE MODE SHOWS EVERY KNOB, and that is not a silent fallback. The
 * `generator` knob is equation-bindable like every other material param, so its
 * stored value may be an "=" expression the panel has no way to evaluate. The
 * honest answer to "which knobs apply when the mode is not statically known" is
 * "possibly any of them", and hiding on a guess would take controls away from
 * precisely the author who is driving the mode from an equation. A genuinely
 * invalid id is still refused LOUDLY — by patternCellFor, at the point where it
 * would otherwise draw the wrong picture.
 *
 * @param {string} generatorId - a PATTERN_GENERATORS key, or anything else
 * @param {string} name - a knob name
 * @returns {boolean}
 *
 * @example generatorReadsKnob("stripes", "ratio") // true
 * @example generatorReadsKnob("stripes", "brickW") // false (brick's knob)
 * @example generatorReadsKnob("plaid", "period") // false (plaid declares no knobs at all)
 * @example generatorReadsKnob("= pick(n)", "brickW") // true (mode unknown → show everything)
 */
export function generatorReadsKnob(generatorId, name) {
  const gen = PATTERN_GENERATORS[generatorId];
  if (!gen) return true;
  return gen.params.some((row) => row.name === name);
}

/**
 * Pure function. One per-generator knob's `visibleWhen` row aspect — the
 * `(params) => boolean` materials.visibleKnobRows resolves for the paint panel.
 * An unwritten `generator` is PATTERN_DEFAULT_GENERATOR, exactly as patternCellFor
 * resolves it.
 *
 * @param {string} name - the knob this predicate governs
 * @returns {function(object): boolean}
 *
 * @example knobVisibleWhen("ratio")({generator: "stripes"}) // true
 * @example knobVisibleWhen("ratio")({generator: "brick"}) // false
 * @example knobVisibleWhen("ratio")({}) // true (unwritten generator IS stripes, which reads ratio)
 */
function knobVisibleWhen(name) {
  return (params) => generatorReadsKnob(params?.generator ?? PATTERN_DEFAULT_GENERATOR, name);
}

/**
 * THE TILING KNOBS — the ones EVERY generator's output is drawn with, because they
 * belong to the tiling rather than to the motif: which generator, the two paints,
 * and the local matrix (scale/offset/rotation). No generator declares any of these
 * names, and the gate below refuses one that tries: a generator knob shadowing a
 * tiling knob would write the same document leaf as the transform and hide a
 * control that is always meaningful.
 */
const PATTERN_TILING_PARAMS = [
  {
    name: "generator", kind: "select", default: PATTERN_DEFAULT_GENERATOR,
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
];

/**
 * Pure function. Every generator that declares a knob called `name`, in ROSTER
 * ORDER — which is the order the dropdown lists them and the order every other
 * derivation in this file reads, so nothing here depends on a second ordering.
 *
 * @param {string} name - a knob name
 * @returns {string[]} generator ids
 *
 * @example generatorsDeclaring("side") // ["honeycomb", "triangles"]
 * @example generatorsDeclaring("lobe") // ["quatrefoil"]
 * @example generatorsDeclaring("scale") // [] (a TILING knob: no generator reads it)
 */
function generatorsDeclaring(name) {
  return patternGeneratorIds().filter((id) => PATTERN_GENERATORS[id].params.some((row) => row.name === name));
}

/**
 * Pure function. The one value that satisfies the MOST declarers — the mode of
 * `values`, ties broken by first appearance. A flat leaf can hold exactly one
 * default, so the honest choice is the one that is wrong for the fewest
 * generators; picking "the first declarer's" instead would silently re-default
 * fourteen generators to please one.
 *
 * THE RULE WAS CHOSEN TO FIT THE DATA, and here is the measurement, so nobody has
 * to assume it was arbitrary. Against the hand-written schema it replaced, it
 * reproduces the previous default EXACTLY for period, thickness, radius, ratio,
 * count, domain, seed and side — eight of the ten shared knobs — and moves only
 * the two that are genuine two-way TIES with no majority to find: `size`
 * (diamonds 1 vs star8 0.85 → 1) and `gap` (basket_weave 0.12 vs plank 0.1 →
 * 0.12). Both ties fix one generator's default and shift the other's by an
 * imperceptible amount; neither is degenerate. All 50 presets render
 * byte-identically, because a preset writes its knobs explicitly.
 *
 * WHAT IT CANNOT FIX is inherent to flattening: `period` cannot be 10 for stripes
 * and 14 for diamonds at the same leaf. The merge minimizes that cost; only a
 * nested per-generator param would remove it.
 *
 * @param {Array} values - one declarer's default per declaring generator, in roster order
 * @returns {*} the most frequent value; the earliest on a tie
 *
 * @example mostCommon([0.28, 0.12, 0.12, 0.16, 0.1, 0.16]) // 0.12 (two-way tie, earliest wins)
 * @example mostCommon([10, 10, 12, 14, 14, 12, 16]) // 10
 * @example mostCommon([0.2]) // 0.2
 */
function mostCommon(values) {
  let best = values[0], bestCount = 0;
  for (const v of values) {
    const count = values.filter((other) => other === v).length;
    if (count > bestCount) { best = v; bestCount = count; }
  }
  return best;
}

/**
 * Pure function. The FLAT row for one per-generator knob, MERGED from the
 * declarations of every generator that reads it.
 *
 * WHY A MERGE EXISTS AT ALL: a knob is stored at ONE document leaf
 * (`…material.params.<name>`), so fifteen generators that each declare `period`
 * share one row and one stored value. Bounds take the UNION (the widest range any
 * declarer accepts) and `step` the FINEST, so no declarer's usable values are out
 * of reach; the default is `mostCommon`. Everything comes from the generators, so
 * the flat schema cannot DRIFT from them — it is a function of them, not a copy.
 *
 * THE MERGE IS ONLY HONEST IF THE NAME MEANS ONE QUANTITY, which the gate below
 * enforces: every declarer's own default must be a legal value for every OTHER
 * declarer. That is the mechanical tell for a name carrying two units, and it is
 * how `radius` was caught meaning both "a fraction of the spacing" (0.01–0.5 for
 * dots) and "an absolute length" (0.5–400 for scallop) at once.
 *
 * A PRESENTATIONAL ASPECT (help, label) COMES FROM THE FIRST DECLARER, and the
 * hand-written "(random dots)" parentheticals the old flat rows carried are GONE:
 * they existed to tell the reader which generator a row belonged to, which is a
 * job row visibility now does properly. Several of them were already stale —
 * `count` said "(random dots)" after cobble started reading it too.
 *
 * @param {string} name - a knob some generator declares
 * @returns {object} a customProps-shaped row
 *
 * @example mergeKnobDeclarations("lobe").max // 0.5 (one declarer: quatrefoil's own row)
 * @example mergeKnobDeclarations("side") // {name: "side", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Hexagon side length"}
 * @example mergeKnobDeclarations("period").max // 400
 */
function mergeKnobDeclarations(name) {
  const declarers = generatorsDeclaring(name);
  const rows = declarers.map((id) => PATTERN_GENERATORS[id].params.find((row) => row.name === name));
  const merged = { ...rows[0], default: mostCommon(rows.map((row) => row.default)) };
  const present = (aspect) => rows.map((row) => row[aspect]).filter((v) => v !== undefined);
  if (present("min").length) merged.min = Math.min(...present("min"));
  if (present("max").length) merged.max = Math.max(...present("max"));
  if (present("step").length) merged.step = Math.min(...present("step"));
  return merged;
}

/**
 * Pure function. Every per-generator knob name, in the order the roster FIRST
 * mentions it — so the flat schema's row order is the generators' own order and
 * needs no second list to maintain.
 *
 * @returns {string[]}
 *
 * @example generatorKnobNames()[0] // "period" (the first knob the first generator declares)
 * @example generatorKnobNames().includes("scale") // false (a TILING knob)
 */
function generatorKnobNames() {
  const names = [];
  for (const id of patternGeneratorIds())
    for (const row of PATTERN_GENERATORS[id].params)
      if (!names.includes(row.name)) names.push(row.name);
  return names;
}

/**
 * THE PER-GENERATOR KNOBS — DERIVED from the roster, never restated. Each carries
 * the `visibleWhen` that shows it only while a generator that reads it is chosen.
 */
const PATTERN_GENERATOR_KNOBS = generatorKnobNames().map((name) => ({
  ...mergeKnobDeclarations(name),
  visibleWhen: knobVisibleWhen(name),
}));

/**
 * Pure function. Why can this generator roster NOT be flattened into one knob
 * schema? Returns a reason, or null when it can. Shaped like
 * core/material_plugins.materialParamsProblem: a checker the caller turns into a
 * throw, so the RULE is testable against a synthetic roster while the real one is
 * refused at import.
 *
 * THREE THINGS MUST HOLD, and every one of them was silently false before it was
 * checked:
 *   1. NO GENERATOR MAY DECLARE A TILING KNOB'S NAME. Both would write the same
 *      document leaf, and the tiling row — always meaningful — would start hiding.
 *   2. DECLARERS OF A SHARED NAME MUST AGREE ON `kind`, since one leaf renders
 *      one control.
 *   3. EVERY DECLARER OF A SHARED NAME MUST MEAN THE SAME QUANTITY, tested by
 *      "every declarer's own default is a legal value for every OTHER declarer".
 *      That is the mechanical tell for one name carrying two units, and it is not
 *      a merge problem — it is a collision (ledger C-6: two things wanting one
 *      name usually ARE one thing, and when they are not, the answer is to
 *      rename, never to average). It caught all three the roster had: `radius`
 *      as both a fraction of spacing and an absolute length, `size` as both a
 *      stone's fraction of its domain and a star's of its cell, and `ratio` as
 *      both an INKED fraction and a MOTIF size.
 *
 * @param {object} [generators] - a PATTERN_GENERATORS-shaped roster
 * @returns {string|null}
 *
 * @example patternSchemaProblem() // null (the shipped roster flattens cleanly)
 * @example patternSchemaProblem({a: {params: [{name: "scale", default: 1}]}})
 * // 'generator(s) a declare a knob "scale", which is also a TILING knob …'
 * @example patternSchemaProblem({a: {params: [{name: "r", kind: "number", default: 0.2, min: 0, max: 0.5}]}, b: {params: [{name: "r", kind: "number", default: 10, min: 1, max: 400}]}})
 * // '"r" defaults to 0.2 on a, which is outside b\'s 1..400 …'
 */
export function patternSchemaProblem(generators = PATTERN_GENERATORS) {
  const tilingNames = PATTERN_TILING_PARAMS.map((row) => row.name);
  const ids = Object.keys(generators);
  const names = [];
  for (const id of ids)
    for (const row of generators[id].params) if (!names.includes(row.name)) names.push(row.name);
  for (const name of names) {
    const declarers = ids.filter((id) => generators[id].params.some((row) => row.name === name));
    if (tilingNames.includes(name))
      return `generator(s) ${declarers.join(", ")} declare a knob "${name}", which is also a TILING knob — the two would share one document leaf. Rename the generator's knob.`;
    const rows = declarers.map((id) => generators[id].params.find((row) => row.name === name));
    for (const [i, row] of rows.entries()) {
      if (row.kind !== rows[0].kind)
        return `"${name}" is kind "${rows[0].kind}" on ${declarers[0]} but "${row.kind}" on ${declarers[i]} — one leaf renders one control.`;
      for (const [j, other] of rows.entries())
        if (typeof row.default === "number" && (row.default < (other.min ?? -Infinity) || row.default > (other.max ?? Infinity)))
          return `"${name}" defaults to ${row.default} on ${declarers[i]}, which is outside ${declarers[j]}'s ${other.min}..${other.max} for the SAME knob — the name is carrying two different quantities. Rename one of them (core/vector_patterns.js).`;
    }
  }
  return null;
}

// LOUD IMPORT-TIME GATE (core/multiselect.js's row-kind block and
// core/properties.js's label gates use the same polarity: a declaration that
// cannot be honoured fails beside its author, not in a rendered picture).
{
  const problem = patternSchemaProblem();
  if (problem) throw new Error(`pattern_material: ${problem}`);
}

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
 *
 * FLATTENING USED TO COST TWO THINGS, AND BOTH ARE PAID BACK HERE. The rows are
 * now DERIVED from the generators (so a knob's bounds, step and unit are the
 * generators' own, not a hand-typed copy that had drifted on 30 aspects), and each
 * carries a `visibleWhen` (so a knob the chosen generator does not read is not
 * shown). Contrast the MATERIAL selector one level up, which never had either
 * problem: PaintField renders the CHOSEN material's `fillParams`, so registry
 * DISPATCH preserves a variant sub-schema for free. Flattening is what destroyed
 * it — worth remembering before flattening the next one.
 */
export const PATTERN_FILL_PARAMS = Object.freeze([...PATTERN_TILING_PARAMS, ...PATTERN_GENERATOR_KNOBS]);

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
  { id: "harlequin", title: "Harlequin Diamonds", description: "Offset diamond lattice", params: { generator: "diamonds", period: 18, size: 1, ink: "#2d1b4e", background: "#f0e6d2" } },
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
  { id: "fanned", title: "Fanned / Fish Scale", description: "Overlapping fanned scales — the CAD fanned hatch", params: { generator: "scallop", period: 9, overlap: 0.12, ink: "#666666", background: "#ffffff" } },
  { id: "scallop", title: "Scallop Shell", description: "Larger overlapping scallops — shell trim", params: { generator: "scallop", period: 14, overlap: 0.2, ink: "#2f6690", background: "#eaf4f4" } },
  { id: "floorboard", title: "Floorboard", description: "Offset plank courses, plain (no grain) — parquet floor", params: { generator: "plank", boardW: 28, boardH: 7, gap: 0.08, waveAmp: 0, ink: "#7a5230", background: "#c9a679" } },
  { id: "woodgrain", title: "Wood Grain", description: "Plank courses with a wavy grain line down each board", params: { generator: "plank", boardW: 24, boardH: 8, gap: 0.08, waveAmp: 0.16, waveCycles: 3, seed: 4, ink: "#6b4423", background: "#c9a679" } },
  { id: "wavygrain", title: "Wavy Grain (Bold)", description: "A stronger, slower grain wave — coarse timber", params: { generator: "plank", boardW: 30, boardH: 10, gap: 0.06, waveAmp: 0.32, waveCycles: 2, seed: 9, ink: "#4a2f1a", background: "#d8b98c" } },
  { id: "cedarshake", title: "Cedar Shake", description: "Narrow shingle courses with a rough grain — roofing shake", params: { generator: "plank", boardW: 14, boardH: 6, gap: 0.14, waveAmp: 0.22, waveCycles: 4, seed: 2, ink: "#6e4b2a", background: "#e6d3b3" } },
  { id: "roofslate", title: "Roof Slate", description: "Broad flat slate courses, minimal grain", params: { generator: "plank", boardW: 22, boardH: 9, gap: 0.1, waveAmp: 0.06, waveCycles: 2, seed: 5, ink: "#3a4750", background: "#c7ced1" } },
  { id: "spanish_roof", title: "Spanish Roof Tile", description: "Scalloped courses over a warm terracotta ground — Spanish barrel tile", params: { generator: "scallop", period: 11, overlap: 0.22, ink: "#9c4a2e", background: "#e2a262" } },
  { id: "pebble", title: "Pebble", description: "Scattered rounded stones — seeded, so it never changes underneath you", params: { generator: "cobble", count: 12, seed: 11, domain: 3, stoneSize: 0.24, roundness: 0.85, sides: 8, ink: "#8a8578", background: "#d9d4c4" } },
  { id: "cobblestone", title: "Cobblestone", description: "Larger rounded stones, tightly packed", params: { generator: "cobble", count: 8, seed: 6, domain: 2, stoneSize: 0.34, roundness: 0.7, sides: 7, ink: "#6b6559", background: "#a8a190" } },
  { id: "rubblestone", title: "Rubblestone", description: "Irregular angular stones — dry-stone rubble wall", params: { generator: "cobble", count: 9, seed: 21, domain: 3, stoneSize: 0.3, roundness: 0.95, sides: 6, ink: "#7d7264", background: "#c4b9a3" } },
  { id: "gravel", title: "Gravel", description: "Many small rounded stones — fine aggregate", params: { generator: "cobble", count: 30, seed: 8, domain: 3, stoneSize: 0.12, roundness: 0.9, sides: 6, ink: "#9a9284", background: "#cfc9bc" } },
  { id: "granules", title: "Granules", description: "Very fine scattered grains — the finest CAD aggregate hatch", params: { generator: "cobble", count: 60, seed: 15, domain: 2, stoneSize: 0.08, roundness: 0.8, sides: 5, ink: "#8f8a7e", background: "#ded9cc" } },
  { id: "squared_stones", title: "Squared Stones", description: "Hard-edged rectangular ashlar blocks", params: { generator: "cobble", count: 8, seed: 13, domain: 2, stoneSize: 0.32, roundness: 0.08, sides: 4, ink: "#8c8c8c", background: "#e0e0e0" } },
  { id: "stonewall", title: "Stone Wall", description: "Larger squared blocks, coarse coursing", params: { generator: "cobble", count: 6, seed: 17, domain: 2, stoneSize: 0.38, roundness: 0.15, sides: 5, ink: "#75726b", background: "#b8b3a8" } },
  { id: "paving", title: "Paving", description: "Regular squared paving slabs, tight joints", params: { generator: "cobble", count: 9, seed: 19, domain: 3, stoneSize: 0.28, roundness: 0.05, sides: 4, ink: "#9a9a9a", background: "#dcdcdc" } },
  { id: "limestone", title: "Limestone Block", description: "Pale squared masonry — limestone ashlar", params: { generator: "cobble", count: 7, seed: 23, domain: 2, stoneSize: 0.34, roundness: 0.1, sides: 4, ink: "#c9c2ac", background: "#f0ead9" } },
  { id: "swamp", title: "Swamp / Grass Tufts", description: "Scattered irregular tufts — the CAD wetland/vegetation hatch", params: { generator: "cobble", count: 16, seed: 25, domain: 3, stoneSize: 0.18, roundness: 1, sides: 5, ink: "#4a7c3f", background: "#dcedd0" } },
  { id: "star_hatch", title: "Star Hatch", description: "Small eight-point stars as a CAD masonry star hatch", params: { generator: "star8", period: 8, size: 0.7, ink: "#555555", background: "#ffffff" } },
]);
