/**
 * Byte-identity probe for the ISOTROPIC magnifier — plain node.
 * Run: node src/demo_apps/PowerRP/tests/magnify_byteid_probe.js
 *
 * Builds a fixed doc with a colorful checker backdrop + one demo_magnify lens,
 * renders it via the CLI pipeline, and prints the SHA-256 of each PNG. Both
 * supersample TRUE and FALSE are covered.
 *
 * IT WAS A ONE-SHOT BEFORE/AFTER INSTRUMENT AND IS NOW A STANDING GATE. As
 * written for 86b5f0f (the anisotropic-zoom change) it printed two SHAs for a
 * human to eyeball against a pre-change run — so once that run was gone it could
 * not fail, and it sat in the canonical gate manufacturing confidence. The
 * property it was checking, though, is permanent and is stated in the plugin
 * itself (plugins/demo/magnify.js:45-52, "0 = AUTO → fall back to the isotropic
 * `magnification` … so a plain magnifier is unchanged / byte-identical"). So the
 * comparison moved INSIDE one run, which is also the house pattern — every other
 * sha256 user here compares renders to each other, never to a stored golden
 * (tests/imageDistinctness.js's docblock records that history):
 *
 *   (1) the per-axis params left at their 0 defaults render BYTE-IDENTICALLY to
 *       the same doc with them written out explicitly as `magnification`;
 *   (2) an ANISOTROPIC doc renders DIFFERENTLY — without which (1) would pass
 *       vacuously on a build that ignored magnificationX/Y altogether, and the
 *       lens could even be drawing nothing at all.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newDocument, withNewItem, serialize } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { renderDocToPng } from "../cli/render.js";

const CELL = 40, SLIDE_W = 1280, SLIDE_H = 720;
const PALETTE = ["#f7768e", "#e0af68", "#9ece6a", "#7dcfff", "#bb9af7", "#ff9e64", "#2ac3de", "#c0caf5"];
// The lens under test. MAGNIFICATION is the plugin's own default (magnify.js:43),
// so case (1) exercises the doc an author actually writes. ANISO_Y only has to be
// a DIFFERENT positive number: > 0 means "not AUTO", and ≠ MAGNIFICATION is what
// makes the render anisotropic. Half of it is the plainest such value.
const MAGNIFICATION = 2.5;
const ANISO_Y = MAGNIFICATION / 2;

const registry = createRegistry();
registerAll(registry, createCommands());

function withChecker(doc) {
  let out = doc, z = 1;
  for (let gy = 0; gy < Math.ceil(SLIDE_H / CELL); gy++)
    for (let gx = 0; gx < Math.ceil(SLIDE_W / CELL); gx++) {
      [out] = withNewItem(out, 0, {
        ...registry.get("rect").defaults,
        x: gx * CELL, y: gy * CELL, w: CELL, h: CELL,
        fill: PALETTE[(gx + gy) % PALETTE.length], strokeWidth: 0, active: true, z: z++,
      });
    }
  return { out, z };
}

/**
 * Query (renders through the CLI pipeline; touches no app state). SHA-256 of the
 * checker-plus-one-lens slide, with `lens` merged over the magnifier's defaults.
 *
 * @param {boolean} supersample - The lens's crisp-resample switch
 * @param {object} lens - Extra magnifier properties, e.g. {magnificationY: 1.25}
 * @returns {Promise<string>} lowercase hex digest of the PNG bytes
 */
async function shaFor(supersample, lens = {}) {
  const { out, z } = withChecker(newDocument());
  const [doc] = withNewItem(out, 0, {
    ...registry.get("demo_magnify").defaults,
    x: 500, y: 260, w: 280, h: 280, active: true, z: z + 1,
    magnification: MAGNIFICATION, supersample, shape: "circle",
    ...lens,
  });
  const png = await renderDocToPng(serialize(doc), { slide: 0, alpha: 1, width: SLIDE_W, height: SLIDE_H });
  return createHash("sha256").update(png).digest("hex");
}

for (const supersample of [true, false]) {
  const iso = await shaFor(supersample);
  const isoExplicit = await shaFor(supersample, { magnificationX: MAGNIFICATION, magnificationY: MAGNIFICATION });
  const aniso = await shaFor(supersample, { magnificationX: MAGNIFICATION, magnificationY: ANISO_Y });
  console.log(`isotropic magnify supersample=${supersample}: sha256=${iso}`);
  console.log(`  per-axis written out explicitly: sha256=${isoExplicit}`);
  console.log(`  anisotropic (Y=${ANISO_Y}):        sha256=${aniso}`);
  assert.equal(iso, isoExplicit,
    `supersample=${supersample}: magnificationX/Y at their 0 AUTO defaults must render byte-identically to writing them out as magnification=${MAGNIFICATION} — an existing magnify doc changed appearance`);
  assert.notEqual(aniso, iso,
    `supersample=${supersample}: magnificationY=${ANISO_Y} rendered byte-identically to the isotropic lens, so the per-axis zoom is not reaching the raster at all (which would also make the identity above vacuous)`);
}
console.log("(magnify_byteid_probe done — AUTO defaults are byte-identical, and per-axis zoom demonstrably changes pixels)");
