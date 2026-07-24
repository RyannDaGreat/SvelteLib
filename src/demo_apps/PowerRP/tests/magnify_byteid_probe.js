/**
 * Byte-identity probe for the ISOTROPIC magnifier — plain node.
 * Run: node src/demo_apps/PowerRP/tests/magnify_byteid_probe.js
 *
 * Builds a fixed doc with a colorful checker backdrop + one ISOTROPIC
 * demo_magnify lens (single `magnification`), renders it via the CLI pipeline,
 * and prints the SHA-256 of the PNG. Run BEFORE and AFTER the anisotropic-zoom
 * change: the two SHAs MUST match (the per-axis params default to isotropic, so
 * an existing magnify doc renders byte-identically). Both supersample TRUE and
 * FALSE are covered.
 */

import { createHash } from "node:crypto";
import { newDocument, withNewItem, serialize } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { renderDocToPng } from "../cli/render.js";

const CELL = 40, SLIDE_W = 1280, SLIDE_H = 720;
const PALETTE = ["#f7768e", "#e0af68", "#9ece6a", "#7dcfff", "#bb9af7", "#ff9e64", "#2ac3de", "#c0caf5"];

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

async function shaFor(supersample) {
  const { out, z } = withChecker(newDocument());
  const [doc] = withNewItem(out, 0, {
    ...registry.get("demo_magnify").defaults,
    x: 500, y: 260, w: 280, h: 280, active: true, z: z + 1,
    magnification: 2.5, supersample, shape: "circle",
  });
  const png = await renderDocToPng(serialize(doc), { slide: 0, alpha: 1, width: SLIDE_W, height: SLIDE_H });
  return createHash("sha256").update(png).digest("hex");
}

for (const supersample of [true, false])
  console.log(`isotropic magnify supersample=${supersample}: sha256=${await shaFor(supersample)}`);
