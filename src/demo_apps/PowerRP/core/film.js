/**
 * FILM STOCK DATA — the perforation geometry and the by-type base colours the FILMSTRIP
 * widget is drawn from. A pure, DOM-free data module, and it lives in core/ for the same
 * reason core/shapes.js does: core/properties.js declares the Inspector SELECT whose
 * options are this table's keys, and core/ may never import a plugin. ONE table, so
 * adding a format or a base colour is DATA, never code.
 *
 * ── WHAT THE AXES ACTUALLY ARE (the correction that shaped this file) ─────────
 * Perforation geometry tracks NEGATIVE-vs-PRINT, GAUGE and PULLDOWN — *not*
 * manufacturer. Fuji labels its own release-print perforation "KS", for "Kodak
 * Standard", so a "Kodak perfs vs Fuji perfs" table would be factually wrong. Base
 * colour tracks film TYPE: colour negative is orange-masked, black-and-white stock is on
 * a GREY acetate base, intermediate and print stock is on a CLEAR base.
 *
 * What genuinely identifies a manufacturer is EDGE-PRINT TEXT GRAMMAR (Kodak negative
 * carries a 12-character keycode plus a barcode; Kodak release print 2383 carries
 * neither; print-stock edge print is set in RED so it stays transparent to a
 * red-illuminated soundtrack reader). This widget draws no edge text, so NO brand
 * presets ship — they would be look-alikes. That feature is where they belong.
 *
 * ── WHY THE ROWS LOOK DIFFERENT FROM EACH OTHER (the point of this table) ─────
 * A perforation family alone is a NEARLY INVARIANT axis: BH and KS pitch differ by
 * 0.010 mm (4.740 vs 4.750), which at any on-screen size is a fraction of a pixel. A
 * preset set built on that axis alone renders look-alikes — measured, not guessed: three
 * of the five presets this table used to serve produced BYTE-IDENTICAL perforation
 * geometry and the fourth differed by 0.025 canvas units of pitch on a 480x90 strip.
 * The axes that DO vary visibly, and that this table therefore carries, are:
 *
 *   PULLDOWN  — `perfsPerFrame`. 35 mm runs 4-perf, 3-perf and 2-perf (Techniscope);
 *               16 mm runs 1-perf. Four holes per picture versus two is unmistakable,
 *               and it is the same integer relationship that makes the holes LINE UP
 *               with the frames instead of drifting past them.
 *   SIDES     — `perfSides`. 16 mm ships double-perf (2R, both edges) and single-perf
 *               (1R, one edge, the other carrying sound/edge print). Holes down one
 *               edge only is the single most distinctive silhouette here.
 *   GAUGE     — `filmWidthMm`. Every millimetre is divided by it, so a 16 mm hole is
 *               proportionally far larger and further apart than a 35 mm one.
 *   SHAPE     — `alongMm`/`acrossMm`/`cornerRadiusMm`. A KS print perforation is a true
 *               rounded rectangle; a BH negative perforation has curved ends; and when
 *               along == across == 2*radius the same shape function draws a CIRCLE.
 *
 * ── PUBLISHED vs MEASURED vs ESTIMATE ─────────────────────────────────────────
 * Every numeric field is tagged. PUBLISHED values are specification dimensions.
 * MEASURED values were read off a rendered image and the measurement is stated.
 * ESTIMATE values are tunable defaults and are NOT presented as spec: base thickness
 * (120-135 micrometres across essentially every stock) and mask HUE are deliberately not
 * modelled at all, because no manufacturer publishes a base colour and any brand
 * difference in it would be invented.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

/**
 * The 35 mm perforation geometry shared by every 35 mm CAMERA NEGATIVE row — BH / "N".
 * Spread into the rows that differ only in PULLDOWN, so 3-perf and 2-perf are not
 * hand-maintained copies of the 4-perf numbers.
 *
 * `cornerRadiusMm` is ESTIMATE because the specification gives BH straight long sides
 * with outward-curving ends and NO radius — a full half-height radius is the plain
 * reading of "outward curving" (it makes the ends semicircular), and it is a TUNABLE
 * default, not a spec value. `edgeInsetMm` is likewise an ESTIMATE: it is not among the
 * published figures available here, so it is carried over from the proportion the
 * previous (Python-derived) look used.
 */
const BH_PERF = {
  filmWidthMm: 35,          // PUBLISHED (the gauge's name)
  acrossMm: 2.794,          // PUBLISHED — across the film, i.e. along the strip's CROSS axis
  alongMm: 1.854,           // PUBLISHED — along film travel, i.e. along the strip's LONG axis
  cornerRadiusMm: 0.927,    // ESTIMATE = alongMm / 2: straight long sides + outward-curving ends, radius unspecified
  pitchMm: 4.740,           // PUBLISHED
  edgeInsetMm: 1.6,         // ESTIMATE (not published here) — the CLEAR film in the band, half outside the hole and half inside
  perfSides: 2,             // PUBLISHED — 35 mm is perforated on both edges
  pitchBasis: "frame",      // real perforations are locked to the picture (see PITCH_BASES)
};

/** The 16 mm perforation geometry shared by the double-perf (2R) and single-perf (1R)
 *  rows, which differ ONLY in how many edges carry holes. */
const R16_PERF = {
  filmWidthMm: 16,          // PUBLISHED
  acrossMm: 1.829,          // PUBLISHED
  alongMm: 1.270,           // PUBLISHED
  cornerRadiusMm: 0.25,     // ESTIMATE — no radius published for this gauge here
  pitchMm: 7.605,           // PUBLISHED (short pitch; the long-pitch variant is 7.620)
  edgeInsetMm: 0.7,         // ESTIMATE (see BH_PERF)
  perfsPerFrame: 1,         // PUBLISHED — one perforation per 16 mm frame
  pitchBasis: "frame",
};

/**
 * HOW A ROW'S PERFORATION PITCH IS DECIDED. Two bases, and every row states which one it
 * uses — there is no default and no fallback.
 *
 *   "frame" — REAL PERFORATIONS. The pitch is the drawn FRAME pitch divided by
 *     `perfsPerFrame`, so the holes keep film's exact integer relationship to the
 *     pictures: 4 holes per 35 mm frame, 1 per 16 mm frame, and every hole lands inside
 *     the frame cell it belongs to instead of drifting past it. The published `pitchMm`
 *     is the cross-check that the integer is right (4 x 4.740 = 18.96 mm, the 35 mm
 *     frame pitch; 1 x 7.605 mm, the 16 mm frame pitch) — the widget's frame cell is
 *     whatever size the user's bbox gives it, so the film is effectively stretched along
 *     its length and the perforations must stretch with it.
 *   "film" — A DECORATIVE PATTERN. The pitch is `pitchMm` scaled by the film width and
 *     ignores the frames entirely. Only the stylised DOTS row uses this, because the
 *     dot row it reproduces was typeset at an absolute size and was never locked to the
 *     pictures.
 *
 * @example PITCH_BASES // ["frame", "film"]
 */
export const PITCH_BASES = ["frame", "film"];

/**
 * PERFORATION FAMILIES — one row per GAUGE x PULLDOWN x SIDES combination the widget can
 * draw, in MILLIMETRES, keyed by the axes that actually determine perforation geometry:
 * NEGATIVE-vs-PRINT, gauge and pulldown, NOT manufacturer. Adding a format is DATA — one
 * entry, no code.
 *
 * Row fields: `title` (the select's caption), `filmWidthMm`, `acrossMm`, `alongMm`,
 * `cornerRadiusMm`, `pitchMm`, `edgeInsetMm`, `perfsPerFrame`, `perfSides` and
 * `pitchBasis` (PITCH_BASES).
 *
 * @example PERF_FAMILIES.KS.cornerRadiusMm // 0.51
 * @example PERF_FAMILIES.BH2.perfsPerFrame // 2
 * @example PERF_FAMILIES.R16S.perfSides // 1
 * @example PERF_FAMILIES.DOTS.alongMm === PERF_FAMILIES.DOTS.acrossMm // true (a circle)
 */
export const PERF_FAMILIES = {
  BH: {
    title: 'BH / "N" — 35 mm camera negative, 4-perf',
    ...BH_PERF,
    perfsPerFrame: 4,       // PUBLISHED — the standard 35 mm pulldown
  },
  BH3: {
    title: "35 mm camera negative, 3-perf",
    ...BH_PERF,
    perfsPerFrame: 3,       // PUBLISHED — the 3-perf pulldown (a 25% shorter frame)
  },
  BH2: {
    title: "35 mm camera negative, 2-perf (Techniscope)",
    ...BH_PERF,
    perfsPerFrame: 2,       // PUBLISHED — the 2-perf/Techniscope pulldown
  },
  KS: {
    title: 'KS / "P" — 35 mm release print & 135 still, 4-perf',
    filmWidthMm: 35,        // PUBLISHED
    acrossMm: 2.794,        // PUBLISHED
    alongMm: 1.981,         // PUBLISHED
    cornerRadiusMm: 0.510,  // PUBLISHED — a true rounded rectangle
    pitchMm: 4.750,         // PUBLISHED
    edgeInsetMm: 1.6,       // ESTIMATE (see BH_PERF)
    perfsPerFrame: 4,       // PUBLISHED
    perfSides: 2,           // PUBLISHED
    pitchBasis: "frame",
  },
  R16: {
    title: "16 mm double-perf (2R)",
    ...R16_PERF,
    perfSides: 2,           // PUBLISHED — 2R stock is perforated on both edges
  },
  R16S: {
    title: "16 mm single-perf (1R)",
    ...R16_PERF,
    perfSides: 1,           // PUBLISHED — 1R stock carries holes on ONE edge only
  },
  DOTS: {
    title: "Dots — the stylised figure look",
    // NOT A GAUGE. This row reproduces the dot row of the original Figures film_strip
    // drawing (refs/Figures/film_strip/film_strip.py stamps a row of "• " glyphs through
    // the strip's alpha), which is a decorative pattern rather than a film format. Every
    // number is MEASURED off that function's own committed render
    // (refs/Figures/assets/film_strip_demo.png, a 3048 x 560 px strip): round holes 16 px
    // across at a 40.0 px pitch (median over 75 holes, sd 0.24), the hole band occupying
    // rows 7..22 from the film edge. The measurements are expressed here as millimetres
    // of a NOMINAL 35 mm width purely so this row shares the table's one unit system —
    // 16/560 x 35 = 1.000, 40/560 x 35 = 2.500, 7/560 x 35 = 0.4375 — and they come out
    // as round numbers because the pattern was laid out in fractions to begin with. The
    // band's clear film is split EVENLY outside and inside the hole (see edgeInsetMm), so
    // reproducing a 7 px outer margin takes twice that as the row's value.
    filmWidthMm: 35,        // NOMINAL — the unit the other numbers are expressed in
    acrossMm: 1.000,        // MEASURED (16 px of 560)
    alongMm: 1.000,         // MEASURED (16 px of 560) — equal to acrossMm, so the hole is round
    cornerRadiusMm: 0.500,  // MEASURED = half the diameter, which makes the rounded rect a CIRCLE
    pitchMm: 2.500,         // MEASURED (40.0 px of 560; duty cycle 0.40)
    edgeInsetMm: 0.875,     // MEASURED — twice the 7 px outer margin, since the clear film is split either side of the hole
    perfsPerFrame: 19,      // MEASURED (19.05 dots per 762 px frame cell) — unused under the "film" basis, recorded as the observed ratio
    perfSides: 2,           // MEASURED — the original stamps the row at both the top and the bottom
    pitchBasis: "film",     // the original's dots are typeset at an absolute size, not locked to the pictures
  },
};

/** The default perforation family a fresh strip uses: camera negative at the standard
 *  4-perf pulldown, the stock a filmstrip of someone's own footage is conceptually cut
 *  from. THE one declaration — plugins/filmstrip.js imports this rather than restating
 *  it, so the widget default and the table cannot drift apart. */
export const DEFAULT_PERF_FAMILY = "BH";

/**
 * FILM BASE COLOURS by film TYPE — which is the axis that actually varies. Colour
 * NEGATIVE stock is orange-masked; B&W stock is on a GREY acetate base (Kodak 5222 /
 * 7266 "grey acetate safety base", ORWO UN54 "grey coloured" triacetate); intermediate
 * and release print stock is on a CLEAR base, which reads as the strip's dense rebate.
 *
 * The three masked entries are MEASURED — Status M D-min densitometry from the
 * manufacturer's own stock publication (H-387), converted to sRGB — so they are not
 * invented, but they are also not "spec colours": no manufacturer publishes a base
 * COLOUR. The green and blue D-min are near-constant across the VISION3 line, so one
 * colour serves 5203/5207/5213/5219. "Kodak orange vs Fuji orange" is folklore and is
 * NOT modelled.
 *
 * @example FILM_BASE_COLORS.bwNegative // "#4a4a4a"
 * @example Object.keys(FILM_BASE_COLORS).length // 5
 */
export const FILM_BASE_COLORS = {
  colorNegative: "#da8c6a",        // MEASURED — VISION3 50D D-min (Status M, H-387)
  intermediate: "#ed9189",         // MEASURED — Intermediate 2242 D-min (Status M, H-387)
  digitalIntermediate: "#ee7a7d",  // MEASURED — DI 5254 D-min (Status M, H-387)
  bwNegative: "#4a4a4a",           // ESTIMATE — grey acetate base
  print: "#101010",                // ESTIMATE — clear base reads near-black in the rebate
};

/** Every perforation-family id, in declaration order — the Inspector select's options
 *  (core/properties.js PROPS.perfFamily), derived from the table so the two cannot drift.
 *
 *  @example PERF_FAMILY_IDS // ["BH", "BH3", "BH2", "KS", "R16", "R16S", "DOTS"]
 */
export const PERF_FAMILY_IDS = Object.keys(PERF_FAMILIES);

/** id → the select's caption, derived from each entry's own `title`.
 *
 *  @example PERF_FAMILY_LABELS.R16S // "16 mm single-perf (1R)"
 */
export const PERF_FAMILY_LABELS = Object.fromEntries(PERF_FAMILY_IDS.map((id) => [id, PERF_FAMILIES[id].title]));
