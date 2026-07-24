/**
 * Anisotropic magnify + general-sandwich tangent probe — plain node.
 * Run: node src/demo_apps/PowerRP/tests/telescopic_aniso_probe.js
 *
 * Renders (for VLM inspection, under .claude_vlm_checks/):
 *   1. aniso_box     — a WIDE source box + a TALL lens box, lens zoom DERIVED
 *      per-axis from the sizes (magnificationX = self.w/@src.w, magnificationY =
 *      self.h/@src.h). Asserts magX !== magY and that the magnified content is
 *      stretched. Proves anisotropic zoom + zoom-from-sizes.
 *   2. aniso_ellipse — same, with ellipse source/lens + ellipse tangents.
 *   3. sandwich_shapes — one frame with THREE tangent pairs over the backdrop:
 *      stretched + rotated ellipses, two 5-point STARS, and two pies with a
 *      slice removed (concave). Proves the general sandwich hugs the real
 *      (convex-hull) boundary of any shape.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { newDocument, withNewItem, foldState, serialize } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { renderDocToPng } from "../cli/render.js";
import { polygonStarOutline, ringSectorOutline } from "../core/outline.js";
import { TELESCOPIC } from "../plugins/tangent_lines.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../.claude_vlm_checks");
const CELL = 40, SLIDE_W = 1280, SLIDE_H = 720;
const PALETTE = ["#f7768e", "#e0af68", "#9ece6a", "#7dcfff", "#bb9af7", "#ff9e64", "#2ac3de", "#c0caf5"];
const RIM = TELESCOPIC.RIM_COLOR, NO_FILL = TELESCOPIC.NO_FILL, RIM_W = TELESCOPIC.RIM_WIDTH;

const registry = createRegistry();
registerAll(registry, createCommands());

let Z = 1;
const add = (doc, type, over) => withNewItem(doc, 0, { ...registry.get(type).defaults, ...over, active: true, z: Z++ });

function withChecker(doc) {
  let out = doc;
  for (let gy = 0; gy < Math.ceil(SLIDE_H / CELL); gy++)
    for (let gx = 0; gx < Math.ceil(SLIDE_W / CELL); gx++)
      [out] = add(out, "rect", { x: gx * CELL, y: gy * CELL, w: CELL, h: CELL, fill: PALETTE[(gx + gy) % PALETTE.length], strokeWidth: 0 });
  return out;
}

/** Command (over doc value). A WIDE→TALL anisotropic rig (static). shapeKind
 * "box"→rect source + square lens; "circle"→circle source + circle lens. */
function withStretchRig(doc, shapeKind) {
  const srcW = 160, srcH = 70, lensW = 240, lensH = 340;
  const ox = 330, oy = 430, lensCx = 760, lensCy = 240;
  const srcType = shapeKind === "box" ? "rect" : "circle";
  const lensShape = shapeKind === "box" ? "square" : "circle";
  let out = doc, sourceId, lensId;
  [out, sourceId] = add(out, srcType, { x: ox - srcW / 2, y: oy - srcH / 2, w: srcW, h: srcH, fill: NO_FILL, stroke: RIM, strokeWidth: RIM_W, rotation: 0, scale: 1 });
  [out, lensId] = add(out, "demo_magnify", {
    shape: lensShape, x: lensCx - lensW / 2, y: lensCy - lensH / 2, w: lensW, h: lensH, rotation: 0, scale: 1,
    stroke: RIM, strokeWidth: RIM_W,
    origin: { x: `@${sourceId}_cm.x`, y: `@${sourceId}_cm.y` },
    magnificationX: `= self.w / @${sourceId}.w`, magnificationY: `= self.h / @${sourceId}.h`,
  });
  const ref = (id) => ({ x: `= @${id}_cm.x`, y: `= @${id}_cm.y`, halfW: `= @${id}.w / 2`, halfH: `= @${id}.h / 2`, rotation: `= @${id}.rotation` });
  [out] = add(out, "tangent_lines", { shapeKind, a: ref(sourceId), b: ref(lensId), stroke: RIM, strokeWidth: RIM_W });
  return { out, sourceId, lensId };
}

/** Command. Renders `doc` to a PNG under OUT_DIR. */
async function render(doc, name) {
  const png = await renderDocToPng(serialize(doc), { slide: 0, alpha: 1, width: SLIDE_W, height: SLIDE_H });
  const p = resolve(OUT_DIR, `${name}.png`);
  await writeFile(p, Buffer.from(png));
  return p.split("/").slice(-2).join("/");
}

/** Local star outline vertices (centered), matching an ss_polygonStar of (w,h). */
function starPolygon(w, h, points, innerRatio) {
  return polygonStarOutline(w, h, { points, innerRatio, startAngle: 0 })[0].map(([x, y]) => [x - w / 2, y - h / 2]);
}
/** Local pie-with-slice outline vertices (centered), matching an ss_radialSweep. */
function piePolygon(w, h, sweepDeg) {
  const a0 = -Math.PI / 2, a1 = a0 + (sweepDeg * Math.PI) / 180;
  return ringSectorOutline({ cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, inner: 0, a0, a1, cap: "pie" })[0].map(([x, y]) => [x - w / 2, y - h / 2]);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // 1 & 2 — anisotropic magnify (box + ellipse).
  for (const shapeKind of ["box", "circle"]) {
    Z = 1;
    const { out, lensId } = withStretchRig(withChecker(newDocument()), shapeKind);
    const { state, errors } = evaluateState(foldState(out, 0, 1), registry);
    assert.equal([...errors.keys()].filter((k) => k.includes(lensId)).length, 0, `${shapeKind}: lens eval errors`);
    const lens = state.items[lensId];
    assert.ok(Number.isFinite(lens.magnificationX) && Number.isFinite(lens.magnificationY), "mag resolved");
    assert.notEqual(lens.magnificationX, lens.magnificationY, "expected ANISOTROPIC magnification");
    const where = await render(out, `aniso_${shapeKind}`);
    console.log(`  ok  aniso_${shapeKind}: magX=${lens.magnificationX.toFixed(2)} magY=${lens.magnificationY.toFixed(2)} (anisotropic) -> ${where}`);
  }

  // 3 — the general sandwich on weird shapes (ellipses rotated, stars, pies).
  Z = 1;
  let doc = withChecker(newDocument());
  const bind = (id) => ({ x: `= @${id}_cm.x`, y: `= @${id}_cm.y`, halfW: `= @${id}.w / 2`, halfH: `= @${id}.h / 2`, rotation: `= @${id}.rotation` });
  const DEG = Math.PI / 180;

  // (a) stretched + rotated ellipses
  let e1, e2;
  [doc, e1] = add(doc, "circle", { x: 120, y: 90, w: 150, h: 70, rotation: 25 * DEG, fill: NO_FILL, stroke: RIM, strokeWidth: RIM_W, scale: 1 });
  [doc, e2] = add(doc, "circle", { x: 470, y: 60, w: 120, h: 220, rotation: -15 * DEG, fill: NO_FILL, stroke: RIM, strokeWidth: RIM_W, scale: 1 });
  [doc] = add(doc, "tangent_lines", { shapeKind: "circle", a: bind(e1), b: bind(e2), stroke: RIM, strokeWidth: RIM_W });

  // (b) two 5-point stars — explicit outline polygons; tangents graze the tips
  const starA = { cx: 250, cy: 380, w: 150, h: 150 }, starB = { cx: 620, cy: 400, w: 260, h: 260 };
  [doc] = add(doc, "ss_polygonStar", { x: starA.cx - starA.w / 2, y: starA.cy - starA.h / 2, w: starA.w, h: starA.h, points: 5, innerRatio: 0.45, fill: NO_FILL, stroke: RIM, strokeWidth: RIM_W });
  [doc] = add(doc, "ss_polygonStar", { x: starB.cx - starB.w / 2, y: starB.cy - starB.h / 2, w: starB.w, h: starB.h, points: 5, innerRatio: 0.45, fill: NO_FILL, stroke: RIM, strokeWidth: RIM_W });
  [doc] = add(doc, "tangent_lines", {
    shapeKind: "circle", stroke: RIM, strokeWidth: RIM_W,
    a: { x: starA.cx, y: starA.cy, halfW: starA.w / 2, halfH: starA.h / 2, rotation: 0, polygon: starPolygon(starA.w, starA.h, 5, 0.45) },
    b: { x: starB.cx, y: starB.cy, halfW: starB.w / 2, halfH: starB.h / 2, rotation: 0, polygon: starPolygon(starB.w, starB.h, 5, 0.45) },
  });

  // (c) two pies with a 90° slice removed (concave) — tangents graze the outer arc
  const pieA = { cx: 250, cy: 610, w: 150, h: 150, sweep: 270 }, pieB = { cx: 640, cy: 600, w: 250, h: 250, sweep: 270 };
  [doc] = add(doc, "ss_radialSweep", { x: pieA.cx - pieA.w / 2, y: pieA.cy - pieA.h / 2, w: pieA.w, h: pieA.h, inner: 0, startAngle: -90, sweep: pieA.sweep, cap: "pie", fill: NO_FILL, stroke: RIM, strokeWidth: RIM_W });
  [doc] = add(doc, "ss_radialSweep", { x: pieB.cx - pieB.w / 2, y: pieB.cy - pieB.h / 2, w: pieB.w, h: pieB.h, inner: 0, startAngle: -90, sweep: pieB.sweep, cap: "pie", fill: NO_FILL, stroke: RIM, strokeWidth: RIM_W });
  [doc] = add(doc, "tangent_lines", {
    shapeKind: "circle", stroke: RIM, strokeWidth: RIM_W,
    a: { x: pieA.cx, y: pieA.cy, halfW: pieA.w / 2, halfH: pieA.h / 2, rotation: 0, polygon: piePolygon(pieA.w, pieA.h, pieA.sweep) },
    b: { x: pieB.cx, y: pieB.cy, halfW: pieB.w / 2, halfH: pieB.h / 2, rotation: 0, polygon: piePolygon(pieB.w, pieB.h, pieB.sweep) },
  });

  const { errors } = evaluateState(foldState(doc, 0, 1), registry);
  assert.equal(errors.size, 0, `sandwich_shapes eval errors: ${[...errors.entries()].map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  console.log(`  ok  sandwich_shapes: rotated ellipses + stars + pies, eqs resolve -> ${await render(doc, "sandwich_shapes")}`);
  console.log("\nAnisotropic magnify + general-sandwich renders written.");
}

await main();
