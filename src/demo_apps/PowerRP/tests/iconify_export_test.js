/**
 * A REAL ICON EXPORTS AS ITS ART, NOT AS THE RED BOX — the user's bug report,
 * pinned end to end.
 *
 * ── THE DEFECT THIS EXISTS FOR (todo #226) ───────────────────────────────────
 * Reported verbatim: *"I had an iconify of a cat and I exported to PDF and then
 * it was the big red box in the PDF… Let's try a green pickle. Yeah it doesn't
 * like pickle either… I think it's an issue with color based iconify icons."*
 * The monochrome icons and a plain checkmark SVG exported fine.
 *
 * The bisection was accurate and the conclusion was a CORRELATE. The causal
 * variable is the SVG path grammar, not colour: `render_gpu/pdf_backend.js`'s
 * path writer had no branch for the smooth-cubic command `S`/`s` and threw
 * `unsupported SVG path command "s"`, which the per-node export boundary
 * (pdf_backend.js emitRegion) correctly contained as a red box. Colour icon sets
 * are TRACED artwork run through an SVG minifier, which emits `s` constantly;
 * monochrome sets are drawn on a small grid from lines and arcs, and arcs never
 * reach the writer (core/svg_paths.js:1093 rewrites them to cubics even on the
 * identity fast path). Measured over 1080 real Iconify icons sampled across 18
 * sets: 66% of colour-set icons carry `s` against 13% of monochrome-set ones.
 * That ratio is the whole of "it's the colour ones".
 *
 * ── WHY A SECOND GATE BESIDE pdf_path_grammar_test.js ────────────────────────
 * That suite pins the WRITER against itself (one path spelled two ways must
 * export identically) and is the right shape for a grammar law. It cannot see
 * this failure class, because it never runs a real asset through the flatten:
 * anything that breaks BETWEEN `svgToIRWithWarnings` and the page — an op field
 * the writer cannot take, a paint it cannot parse — is invisible to it. This
 * suite covers that seam and asserts the user-visible outcome he reported.
 * Sampling for it found one such live defect the unit gate structurally cannot
 * reach (a CSS NAMED colour, `fill="red"`, is rejected by `ir.js parseColor`).
 *
 * ── THE ORACLES ARE DERIVED, NOT TRANSCRIBED ─────────────────────────────────
 * No golden bytes. "Update the fixture" and "ratify the regression" must not
 * look the same in a diff — the sibling suite's docblock makes that argument at
 * length and it applies here twice over, because the pre-fix output was a
 * perfectly well-formed PDF.
 *
 *   1. NO ERROR AFFORDANCE — the detector's colours come from
 *      `core/paint_containment.js`'s exported palette, not from a hex literal
 *      copied out of it. A palette change re-derives the gate instead of
 *      silently disarming it.
 *   2. EVERY COLOUR ARRIVES — each distinct fill the flatten produced must
 *      appear as its PDF `rg` operator. "No red box" alone passes on a blank
 *      page, which is the silent failure the affordance exists to prevent.
 *   3. NO GEOMETRY IS LOST — the PDF must contain at least as many `m`
 *      (moveto) operators as the fixture TEXT has `M`/`m` commands in its `d`
 *      attributes. That count is read off the file with a regex, so it is an
 *      oracle from outside the system under test. `>=` and not `==` because a
 *      `<circle>`/`<rect>` element contributes a subpath with no `d` attribute.
 *
 * ── THE FIXTURES ARE THE USER'S OWN THREE CASES ──────────────────────────────
 * `noto-cat.svg` and `noto-cucumber.svg` (the "green pickle") are the two he
 * reported broken; `tabler-circle-check.svg` is the checkmark he reported fine,
 * and it is the CONTROL — it must export identically before and after the fix,
 * or the gate is measuring the wrong axis. Measured against the pre-fix commit
 * ac1a8c4: both colour fixtures lose every fill and collapse to 0-3 movetos
 * while the control is unchanged.
 *
 * Icons are committed rather than fetched: a gate that needs api.iconify.design
 * is a gate that fails on a plane. noto-* are from Google's Noto Emoji
 * (Apache-2.0); tabler-* are MIT and predate this suite (commit 5920566).
 *
 * Run: node src/demo_apps/PowerRP/tests/iconify_export_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { svgToIRWithWarnings } from "../render_gpu/gpu/svg_raster.js";
import { irToPDF, pdfNum } from "../render_gpu/pdf_backend.js";
import { irToSVG } from "../render_gpu/svg_backend.js";
import { ERROR_BG, ERROR_BORDER } from "../core/paint_containment.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/iconify");

/** The widget box the two SVG-family plugins hand the flatten, and a page big
 *  enough that nothing is culled. Neither number is load-bearing. */
const BOX = 96;
const PAGE = { width: 200, height: 200, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff" };

/** The flatten options `plugins/iconify.js emit` passes for an untouched widget:
 *  black ink, aspect preserved, fully opaque, no fill override. */
const ICON_OPTS = { ink: "#000000", preserveAspect: true, opacity: 1 };

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

/**
 * Pure function. A parsed rgba (0..1) as the PDF operator that paints it in the
 * given slot — the exporter's own number formatting, so the expectation is
 * derived from `pdfNum` rather than from a transcribed decimal.
 *
 * @param {number[]} c - [r, g, b, a] in 0..1
 * @param {string} op - "rg" (nonstroking) or "RG" (stroking)
 * @returns {string}
 *
 * @example pdfPaintOperator([1, 0, 0, 1], "rg") // "1 0 0 rg"
 * @example pdfPaintOperator(ERROR_BORDER, "RG") // "0.7529 0.2235 0.1686 RG"
 */
function pdfPaintOperator(c, op) {
  return `${pdfNum(c[0])} ${pdfNum(c[1])} ${pdfNum(c[2])} ${op}`;
}

/**
 * Pure function. A parsed rgba (0..1) as the `rgba()` string `svg_backend.js
 * paintAttrs` writes — the SVG twin of pdfPaintOperator, derived the same way.
 *
 * @param {number[]} c - [r, g, b, a] in 0..1
 * @returns {string}
 *
 * @example svgRgba([1, 0, 0, 1]) // "rgba(255,0,0,1)"
 * @example svgRgba(ERROR_BORDER) // "rgba(192,57,43,1)"
 */
function svgRgba(c) {
  const byte = (v) => Math.round(v * 255);
  return `rgba(${byte(c[0])},${byte(c[1])},${byte(c[2])},${c[3]})`;
}

/** Query (reads the fixture off disk). The committed icon's SVG text. */
function fixture(name) {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

/**
 * Pure function. How many subpaths the SOURCE TEXT declares — the `M`/`m`
 * command letters across every `d` attribute. Read with a regex over the file
 * so the count owes nothing to the parser it is used to check.
 *
 * @param {string} svgText - the raw SVG source
 * @returns {number}
 *
 * @example sourceMovetoCount('<svg><path d="M0 0L1 1"/><path d="m2 2z"/></svg>')
 * 2
 * @example sourceMovetoCount('<svg><circle cx="1" cy="1" r="1"/></svg>')
 * 0
 */
function sourceMovetoCount(svgText) {
  const ds = [...svgText.matchAll(/\sd="([^"]*)"/g)].map((m) => m[1]).join(" ");
  return (ds.match(/[Mm]/g) ?? []).length;
}

/**
 * A committed icon and what it is here to prove. `colour: true` marks the two
 * cases the user reported; the monochrome one is the control that must be
 * unaffected by anything this suite is about.
 */
const CASES = [
  { name: "noto-cat.svg", colour: true, why: 'the user\'s "iconify of a cat"' },
  { name: "noto-cucumber.svg", colour: true, why: 'the user\'s "green pickle"' },
  { name: "tabler-circle-check.svg", colour: false, why: "the checkmark he reported FINE — the control" },
];

for (const { name, colour, why } of CASES) {
  test(`${name} (${why}): exports to PDF as art, not as the containment box`, async () => {
    const src = fixture(name);
    const flat = svgToIRWithWarnings(src, BOX, BOX, ICON_OPTS);
    const pdf = latin1(await irToPDF(flat.ops, PAGE));

    assert.ok(pdf.startsWith("%PDF-"), "a real PDF came out");
    assert.ok(!pdf.includes(pdfPaintOperator(ERROR_BORDER, "RG")),
      `the error affordance's border was drawn — this icon was CONTAINED. Re-run the export with the console visible: emitRegion reports the real throw before drawing the box.`);
    assert.ok(!pdf.includes(pdfPaintOperator(ERROR_BG, "rg")), "the error affordance's background was drawn — this icon was CONTAINED");

    const movetos = (pdf.match(/^-?[\d.]+ -?[\d.]+ m$/gm) ?? []).length;
    assert.ok(movetos >= sourceMovetoCount(src),
      `geometry was dropped: the source declares ${sourceMovetoCount(src)} subpaths, the PDF has ${movetos} movetos`);

    if (!colour) return;
    // Only a colour icon has intrinsic fills to lose; the monochrome control is
    // stroke-only and would make this assertion vacuously true.
    const fills = new Map();
    for (const o of flat.ops) if (o.op === "path" && Array.isArray(o.fill)) fills.set(String(o.fill), o.fill);
    assert.ok(fills.size > 1, `control: a colour icon must flatten to several distinct fills, got ${fills.size}`);
    for (const c of fills.values())
      assert.ok(pdf.includes(pdfPaintOperator(c, "rg")), `the fill ${JSON.stringify(c)} never reached the page`);
  });

  test(`${name}: the SVG exporter agrees — no containment box there either`, async () => {
    const out = await irToSVG(svgToIRWithWarnings(fixture(name), BOX, BOX, ICON_OPTS).ops, PAGE);
    assert.ok(out.includes("<svg"), "a real SVG came out");
    assert.ok(!out.includes(svgRgba(ERROR_BORDER)), "the error affordance's border was drawn — this icon was CONTAINED");
    assert.ok(!out.includes("failed to export"), "the containment message was written into the SVG");
  });
}

test("the detectors can fire: a deliberately poisoned run IS caught by them", () => {
  // A gate whose detector cannot match is not a gate. Both spellings of the
  // affordance palette are asserted to be what the two backends would write, so
  // a silent format change (pdfNum precision, paintAttrs spacing) fails HERE
  // with a readable message rather than turning every assertion above green.
  assert.equal(pdfPaintOperator(ERROR_BORDER, "RG"), "0.7529 0.2235 0.1686 RG");
  assert.equal(svgRgba(ERROR_BORDER), "rgba(192,57,43,1)");
});
