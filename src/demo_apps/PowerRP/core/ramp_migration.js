/**
 * THE LEGACY MANDELBROT PALETTE → RAMP MIGRATION: the load-boundary step that
 * turns the two retired properties into the one shared ramp property.
 *
 *   BEFORE   palette: "gold"                 a `select` over six hard-coded names
 *            paletteStops: "#001028, #ffd27f" a comma-separated `text` OVERRIDE
 *                                             which WON when it named >= 2 colours
 *   AFTER    rampStops: [{offset, color}, …]  a declared, sorted, keyframable LIST
 *                                             (core/properties.js PROPS.rampStops)
 *
 * ── HOME: THIS BELONGS IN core/document.js ────────────────────────────────────
 * It is the EIGHTH value migration and its seven siblings (legacy key renames,
 * fancy-arrow fill, antialias boolean→select, filmstrip frames, rich text,
 * duration, linear-gradient angle) all live in core/document.js beside
 * repairedDocument. This one is in its own module ONLY because core/document.js
 * was owned by another agent when it was written — MOVE IT there as a
 * self-contained cleanup, exactly as core/expressions.js's PAINT_LEAF_KINDS block
 * records the same debt about its own home. Until then repairedDocument must call
 * withPaletteRampMigrated; wiring it is three lines and the ORDER matters (below).
 *
 * ── WHY IT CANNOT USE THE DECLARATIVE `legacyKeys` SEAM ───────────────────────
 * `legacyKeys: {oldKey: newKey}` MOVES a value from one key name to another,
 * verbatim. Here TWO keys collapse into ONE and the value's TYPE changes (a name
 * or a comma-separated string becomes a stop list), so a verbatim move would land
 * a string in a list slot. `paletteOffset` → `rampPhase` IS a pure rename and does
 * go through that seam (plugins/demo/mandelbrot.js legacyKeys) — this module
 * handles only what a rename cannot express.
 *
 * ── WHY IT MUST FOLD, with the real document that proves it ───────────────────
 * The old resolution rule was "the override wins when it names two or more
 * colours, else the named palette" — evaluated against the FOLDED state, not
 * against one slide's delta. `projects/Fractals/doc.json` (a real shipped
 * document) is exactly the case a naive per-slide conversion gets wrong:
 *
 *   slide 0   palette: "gold",  paletteStops: ""                → gold
 *   slide 1   paletteStops: "#03010a, #1b0a3a, …"                → the override
 *   slide 2   palette: "ember"                                   → STILL the
 *             override, because slide 1's paletteStops is still folded in and it
 *             SHADOWS the name. Slide 2's picture is not ember.
 *
 * So the migration walks the slides in order carrying the folded pair, and writes
 * the ramp the fold actually resolved to. That shadowing is also REPORTED, because
 * a user who set a palette on slide 2 and got no change deserves to be told why
 * their document looked the way it did.
 *
 * ── WHAT IT WRITES, and the one ordering requirement ──────────────────────────
 * `rampStops` at every slide that wrote either legacy key — INCLUDING a slide
 * whose resolved ramp is unchanged (slide 2 above), so the document keeps the same
 * keyframe STRUCTURE it had rather than silently losing a keyframe the user
 * placed. Plus the two constant ASPECTS (`rampLoop: true`, `rampSpace: "oklab"`)
 * once, at the item's CREATION slide, because a migrated document must be
 * self-describing: leaving them to withMissingDefaultsFilled worked but made a
 * saved document depend on a later pipeline step to mean the right thing, and it
 * left one repair report behind on every reload. `rampPhase` is not written here —
 * it is the declarative `paletteOffset` rename (plugins/demo/mandelbrot.js
 * legacyKeys) and arrives with its keyframes intact.
 *
 * ORDER: this must still run BEFORE withMissingDefaultsFilled, for the same reason
 * and in the same position as the filmstrip frames migration — a document whose
 * only palette write is on slide 3 gets no slide-0 `rampStops` from here, and the
 * fill must be the thing that supplies the creation slide's default ramp.
 *
 * ── IDEMPOTENT AND PIXEL-PRESERVING ──────────────────────────────────────────
 * A migrated document writes neither legacy key, so a second pass reports nothing.
 * The stop offsets are i/N (core/ramps.js evenlySpacedRampStops with loop) because
 * that is precisely what the old bake's `x = (i/count)·N` floor-and-wrap gather
 * meant — measured, the resulting 32-entry palette uniform is bit-identical in
 * float32 for all six named palettes and for a text override, so the GPU receives
 * the same bytes and the pixels cannot differ.
 */

import { getPath } from "./deltas.js";
import { keyframed, unkeyframed } from "./document.js";
import { rampStopsFromLegacyPalette, legacyOverrideColors } from "./ramps.js";

/** The widget type whose palette this migrates. Named because the plugin's own
 *  `type` string and this must agree, and a typo here would silently migrate
 *  nothing at all rather than failing. */
export const MANDELBROT_TYPE = "demo_mandelbrot";

/** The two retired property keys, in the order the old resolution rule read them
 *  (the override first, because it shadowed the name). */
export const LEGACY_PALETTE_KEYS = ["paletteStops", "palette"];

/** The property they collapse into. */
export const RAMP_STOPS_KEY = "rampStops";

/**
 * The ramp ASPECTS a migrated palette carries, written once at the item's creation
 * slide. They are CONSTANT for this widget and are the two pieces of domain
 * knowledge the retired properties held implicitly: the palette must CYCLE (a
 * clamped ramp renders as one flat colour at depth) and it blends in OKLab (which
 * is why no palette passes through mud). Stated here rather than read from the
 * plugin so the migration is a pure function of the document — but they are the
 * SAME values plugins/demo/mandelbrot.js RAMP_DEFAULTS declares, and
 * tests/ramps_test.js asserts the two agree so they cannot drift.
 *
 * @example LEGACY_RAMP_ASPECTS // {rampLoop: true, rampSpace: "oklab"}
 */
export const LEGACY_RAMP_ASPECTS = { rampLoop: true, rampSpace: "oklab" };

/**
 * Pure function. The palette→ramp migrations a document needs: one entry per
 * slide-delta that writes either retired key on an item whose CREATION type is
 * the mandelbrot widget. Each entry carries the ramp the FOLDED legacy pair
 * resolved to at that slide, and `shadowed: true` when the slide wrote a palette
 * NAME that a still-folded override made ineffective.
 *
 * `stale: true` marks a slide that also already writes `rampStops` — there the
 * new key is authoritative and the legacy writes are only dropped (the
 * legacyKeyRenames convention, verbatim).
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, slideIndex, stops, wrote, shadowed, stale}[] (empty when nothing needs it)
 *
 * @example paletteRampMigrations({slides: [{delta: {items: {a: {type: "demo_mandelbrot", palette: "gold", paletteStops: ""}}}}]}).length // 1
 * @example paletteRampMigrations({slides: [{delta: {items: {a: {type: "demo_mandelbrot", palette: "gold"}}}}]})[0].stops.length // 8
 * @example paletteRampMigrations({slides: [{delta: {items: {a: {type: "rect", palette: "gold"}}}}]}) // [] (not a mandelbrot)
 * @example paletteRampMigrations({slides: [{delta: {items: {a: {type: "demo_mandelbrot", rampStops: []}}}}]}) // [] (already migrated)
 */
export function paletteRampMigrations(doc) {
  const typeOf = new Map(); // id → first type written anywhere (creation type)
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && typeof item === "object" && typeof item.type === "string" && !typeOf.has(id))
        typeOf.set(id, item.type);
  const folded = new Map(); // id → the folded legacy pair so far
  const out = [];
  doc.slides.forEach((slide, slideIndex) => {
    for (const [id, item] of Object.entries(slide.delta.items ?? {})) {
      if (!(item && typeof item === "object") || typeOf.get(id) !== MANDELBROT_TYPE) continue;
      const wrote = LEGACY_PALETTE_KEYS.filter((k) => k in item);
      if (wrote.length === 0) continue;
      const legacy = { ...(folded.get(id) ?? {}) };
      for (const key of wrote) legacy[key] = item[key];
      folded.set(id, legacy);
      // The slide SET a name, but a still-folded override shadows it — so the
      // picture did not change and the migrated ramp is the override's.
      const shadowed = wrote.includes("palette") && !wrote.includes("paletteStops")
        && legacyOverrideColors(legacy.paletteStops).length > 0;
      out.push({
        id, slideIndex, wrote, shadowed,
        stops: rampStopsFromLegacyPalette(legacy),
        stale: RAMP_STOPS_KEY in item,
      });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy palette pair converted to a
 * `rampStops` keyframe and the retired keys removed. REPORTING IS THE CALLER'S
 * JOB (console.error per entry at the load boundary — silent repairs are
 * forbidden). Idempotent: a migrated document reports nothing and is returned
 * unchanged.
 *
 * Where the slide ALREADY writes `rampStops` the legacy writes are only dropped
 * (the new key is authoritative), so re-running over a half-migrated document
 * cannot clobber a real ramp.
 *
 * @example withPaletteRampMigrated({slides: [{delta: {items: {a: {type: "demo_mandelbrot", palette: "gold", paletteStops: ""}}}}]}).doc.slides[0].delta.items.a.rampStops.length // 8
 * @example withPaletteRampMigrated({slides: [{delta: {items: {a: {type: "demo_mandelbrot", palette: "gold"}}}}]}).doc.slides[0].delta.items.a.palette // undefined
 * @example withPaletteRampMigrated({slides: [{delta: {items: {a: {type: "demo_mandelbrot", rampStops: [{offset: 0, color: "#000000"}, {offset: 0.5, color: "#ffffff"}]}}}}]}).migrated.length // 0
 */
export function withPaletteRampMigrated(doc) {
  const migrated = paletteRampMigrations(doc);
  let out = doc;
  for (const { id, slideIndex, stops, stale } of migrated) {
    for (const key of LEGACY_PALETTE_KEYS)
      if (getPath(out.slides[slideIndex].delta, ["items", id, key]) !== undefined)
        out = unkeyframed(out, slideIndex, ["items", id, key]);
    if (!stale) out = keyframed(out, slideIndex, ["items", id, RAMP_STOPS_KEY], stops);
  }
  // The two constant aspects, once, at each migrated item's CREATION slide (where
  // its `type` is written), and only where they are not already present — so a
  // re-run writes nothing and a document that already declares them is untouched.
  for (const id of new Set(migrated.map((m) => m.id))) {
    const creation = out.slides.findIndex((s) => typeof s.delta.items?.[id]?.type === "string");
    if (creation < 0) continue; // an item with no creation write is the orphan case
    for (const [key, value] of Object.entries(LEGACY_RAMP_ASPECTS))
      if (getPath(out.slides[creation].delta, ["items", id, key]) === undefined)
        out = keyframed(out, creation, ["items", id, key], value);
  }
  return { doc: out, migrated };
}

/**
 * Pure function. The repair-report lines for a migration list — the exact strings
 * repairedDocument should push, kept HERE beside the migration so the wiring is
 * three lines and the message cannot drift from what the step actually did.
 *
 * @param {object[]} migrated - paletteRampMigrations output
 * @returns {string[]} one console.error line per entry
 *
 * @example rampMigrationReports([{id: "a", slideIndex: 0, wrote: ["palette"], shadowed: false, stops: [1, 2], stale: false}])
 * // ['PowerRP repair: item "a" slide 0: legacy palette (palette) → a 2-stop cyclic ramp (rampStops), interpolated in OKLab']
 * @example rampMigrationReports([]) // []
 */
export function rampMigrationReports(migrated) {
  return migrated.map(({ id, slideIndex, wrote, shadowed, stops, stale }) => {
    const head = `PowerRP repair: item "${id}" slide ${slideIndex}: legacy palette (${wrote.join(", ")}) → a ${stops.length}-stop cyclic ramp (${RAMP_STOPS_KEY}), interpolated in OKLab`;
    const shadowNote = shadowed ? " — NOTE: this slide set a palette NAME that an earlier slide's paletteStops override was still shadowing, so the name never rendered; the migrated ramp is the override's, which is what the document actually looked like" : "";
    return head + shadowNote + (stale ? " (stale legacy keys dropped — the slide already wrote a ramp)" : "");
  });
}
