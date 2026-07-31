/**
 * SHAPE CONTACT SHEET — renders every System-B shapeshifter family at its
 * defaults plus a spread of param/preset settings, through the SAME Skia painter
 * the editor uses (render_gpu/skia/node_render.js), into one PNG.
 *
 * WHY this exists as a checked-in tool rather than a scratch script: a shape that
 * renders WRONG while every test passes is this subsystem's known failure mode —
 * an outline generator can return a well-formed, in-bounds, correctly-counted
 * point ring that draws as a tangle. Numbers cannot catch that; only looking can.
 * So the consolidation carries a way to LOOK at all of it at once, and to re-look
 * after any geometry edit.
 *
 * Not a *_test.mjs / *_probe.mjs — it asserts nothing and is not collected by the
 * gate. It is a rendering tool whose output a human (or a VLM) reads.
 *
 * Usage: node tests/shape_contact_sheet.mjs [outPng] [--band=N]
 *   --band=N  render ONLY families [N*BAND_FAMILIES, +BAND_FAMILIES) into
 *             <outPng stem>_bandN.png. One tall sheet downsamples past legibility
 *             when viewed whole, so the bands are how the shapes actually get
 *             LOOKED at; the full sheet stays the deliverable.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAMILIES } from "../plugins/shapeshifter.js";
import { subpathsPathD } from "../core/shapes.js";
import { path as pathOp, text as textOp } from "../render_gpu/ir.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { fitRectView } from "../core/view.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const bandArg = args.find((a) => a.startsWith("--band="));
const BAND = bandArg ? Number(bandArg.slice("--band=".length)) : null;
const outArg = args.find((a) => !a.startsWith("--"));
const BASE = outArg ? resolve(outArg) : resolve(HERE, "../../../../.claude_logs/shapesplit2/contact_sheet.png");
const OUT = BAND === null ? BASE : BASE.replace(/\.png$/, `_band${BAND}.png`);
// Families per band — enough rows to stay legible at a glance, few enough that the
// PNG is not downsampled into mush by a viewer.
const BAND_FAMILIES = 5;

// Sheet geometry. One CELL per (family, variant); families run down, variants across.
const CELL = 170;          // cell pitch in px
const SHAPE_BOX = 108;     // the w×h the family outline is generated in
const LABEL_H = 26;        // room under each shape for its caption
const COLS_PER_FAMILY = 4; // defaults + up to 3 extra settings
const MARGIN = 14;
const INK = "#dfe4f2";
const SHEET_BG = "#14151f";

/**
 * Pure function. The VARIANTS to draw for one family: its defaults first, then up
 * to three more — its own `presets` when it has them (the curated settings the
 * author chose), otherwise a spread over its most characteristic numeric row.
 *
 * Presets are preferred because a family that ships them has already answered
 * "what should this look like"; inventing param values for such a family would
 * show something nobody chose.
 *
 * @example familyVariants({defaults: {a: 1}, rows: [], presets: [{name: "P", props: {a: 2}}]}).map((v) => v.label) // ["defaults", "P"]
 * @example familyVariants({defaults: {n: 5}, rows: [{key: "n", kind: "number", min: 3}]}).length // 4 (defaults + a 3-point spread)
 */
export function familyVariants(fam) {
  const out = [{ label: "defaults", props: {} }];
  if (fam.presets?.length) {
    for (const p of fam.presets.slice(0, COLS_PER_FAMILY - 1)) out.push({ label: p.name, props: p.props });
    return out;
  }
  // No presets: sweep the first numeric row that has a finite range to sweep.
  const row = fam.rows.find((r) => r.kind === "number" && Number.isFinite(r.min) && Number.isFinite(r.max))
    ?? fam.rows.find((r) => r.kind === "number");
  if (row) {
    const lo = Number.isFinite(row.min) ? row.min : 0;
    const hi = Number.isFinite(row.max) ? row.max : (fam.defaults[row.key] ?? 1) * 2;
    for (let i = 0; i < COLS_PER_FAMILY - 1; i++) {
      const v = lo + ((hi - lo) * (i + 1)) / COLS_PER_FAMILY;
      const rounded = Math.round(v * 100) / 100;
      out.push({ label: `${row.key}=${rounded}`, props: { [row.key]: rounded } });
    }
    return out;
  }
  // No numeric row at all (a select-only family): show each option instead.
  const sel = fam.rows.find((r) => r.kind === "select");
  if (sel) for (const o of sel.options.slice(0, COLS_PER_FAMILY - 1)) out.push({ label: `${sel.key}=${o}`, props: { [sel.key]: o } });
  return out;
}

/** Command. Builds the display list for the whole sheet and writes the PNG. */
async function main() {
  const commands = [];
  let row = 0;
  const misdraws = [];

  const shown = BAND === null ? FAMILIES : FAMILIES.slice(BAND * BAND_FAMILIES, (BAND + 1) * BAND_FAMILIES);
  for (const fam of shown) {
    const variants = familyVariants(fam);
    variants.forEach((variant, col) => {
      const state = { ...fam.defaults, ...variant.props, w: SHAPE_BOX, h: SHAPE_BOX };
      const ox = MARGIN + col * CELL, oy = MARGIN + row * (CELL + LABEL_H);
      let subpaths;
      try {
        subpaths = fam.outline(state);
      } catch (e) {
        misdraws.push(`${fam.type}/${variant.label}: outline THREW ${e.message}`);
        return;
      }
      const pts = subpaths.flat();
      if (pts.length === 0) { misdraws.push(`${fam.type}/${variant.label}: EMPTY outline`); return; }
      if (pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
        misdraws.push(`${fam.type}/${variant.label}: NON-FINITE point`);
        return;
      }
      // Report a silhouette that escapes its own generation box — the culling and
      // capture-rect contract says the ink lives in 0..w, 0..h.
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const slack = SHAPE_BOX * 0.02;
      if (Math.min(...xs) < -slack || Math.max(...xs) > SHAPE_BOX + slack
        || Math.min(...ys) < -slack || Math.max(...ys) > SHAPE_BOX + slack) {
        misdraws.push(`${fam.type}/${variant.label}: ink escapes the box`
          + ` x[${Math.round(Math.min(...xs))},${Math.round(Math.max(...xs))}]`
          + ` y[${Math.round(Math.min(...ys))},${Math.round(Math.max(...ys))}]`);
      }
      commands.push(pathOp({
        d: subpathsPathD(subpaths.map((sp) => sp.map(([x, y]) => [x + ox, y + oy]))),
        fill: fam.fill ?? "#7dcfff",
        stroke: "#0b0c12", strokeWidth: 1.5,
        fillRule: fam.fillRule ?? "nonzero",
        opacity: 1,
      }));
      commands.push(textOp({
        text: col === 0 ? `${fam.type} · ${variant.label}` : variant.label,
        x: ox, y: oy + SHAPE_BOX + 4,
        size: col === 0 ? 11 : 10, color: col === 0 ? INK : "#8b93b0",
      }));
    });
    row++;
  }

  const width = MARGIN * 2 + COLS_PER_FAMILY * CELL;
  const height = MARGIN * 2 + row * (CELL + LABEL_H);
  // The sheet is authored directly in device pixels, so the view is the identity
  // one fitRectView produces for a rect exactly the size of the surface.
  const view = fitRectView({ x: 0, y: 0, w: width, h: height }, width, height, 1);
  const png = await renderToPng(commands, view, { width, height, background: SHEET_BG });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, png);

  console.log(`families: ${shown.length}/${FAMILIES.length}   cells: ${commands.length / 2}   ${width}x${height}`);
  console.log(`wrote ${OUT}`);
  if (misdraws.length) {
    console.log(`\nGEOMETRY REPORTS (${misdraws.length}) — look at these cells:`);
    for (const m of misdraws) console.log("  " + m);
  } else {
    console.log("\nno geometry reports: every cell drew a finite, in-box silhouette");
  }
}

main();
