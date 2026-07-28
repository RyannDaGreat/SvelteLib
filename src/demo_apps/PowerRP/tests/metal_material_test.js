/**
 * METAL MATERIALS gate (bare node, software Skia) — pins the metal FILL (id "metal")
 * and the metal STAMP (id "metalStamp") through the FULL fill pipeline (renderDocToPng
 * → resolveMaterialFillPaints → ports → toUniformParams → pack → paint_skia), the same
 * seam material_shape_conform_test uses. Pure SkSL fills render on the node software
 * surface with NO browser (cli/render.js proves it), so the whole family is testable in
 * the fast node gate and on a Mac with no GPU. The browser material_fill_probe covers
 * clip-held / auto-registration; THIS test pins the pixel-level CLAIMS the look rests on:
 *
 *   1. metalType drives the F0 HUE — brass is chromatic (R≫B), steel achromatic (R≈B).
 *   2. patinaAmount COUPLES to the crevice: it darkens the EDGE band (recesses) MORE
 *      than the interior faces — the silhouette-SDF crevice mask, not a flat tint.
 *   3. the STAMP visibly EMBOSSES a backdrop: the stamped region differs from the flat
 *      backdrop, its groove FLOOR is darker, and a bright bevel catch-line appears.
 *   4. the stamp's patina ACCUMULATES in its own groove (the crevice coupling on the
 *      stamp side): patinaAmount shifts the engraved region toward the patina hue.
 *   5. DETERMINISM: identical params ⇒ byte-identical pixels; a different seed differs.
 *
 * Run: node src/demo_apps/PowerRP/tests/metal_material_test.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";
import { PNG } from "pngjs";

import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { newDocument, withNewItem, serialize } from "../core/document.js";
import { renderDocToPng } from "../cli/render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const W = 240, H = 240, CELL = 200, AT = { x: 20, y: 20 };
const BG = "#0d1116";

const registry = createRegistry();
registerAll(registry, createCommands());

const GEAR = { type: "ss_gear", over: { teeth: 12, innerRatio: 0.72, toothWidth: 0.5 } };
const RECT = { type: "rect", over: { cornerRadius: 0 } };

/** Near-pure (fresh ids). A document: a tone underlay + the given shapes (each
 * {shape:{type,over}, fill}), added in order so a later one composites over an earlier. */
function metalDoc(shapes) {
  let doc = newDocument(), z = 1;
  doc.meta = { ...doc.meta, slideW: W, slideH: H };
  const items0 = doc.slides[0].delta.items;
  const camId = Object.keys(items0)[0];
  items0[camId] = { ...items0[camId], x: 0, y: 0, w: W, h: H, background: BG };
  const add = (type, over) => { [doc] = withNewItem(doc, 0, { ...registry.get(type).defaults, ...over, active: true, z: z++ }); };
  add("rect", { x: 0, y: 0, w: W, h: H, strokeWidth: 0,
    fill: { type: "linearGradient", solid: "#888", linear: { stops: [{ offset: 0, color: "#8a8f96" }, { offset: 1, color: "#6c7178" }], angle: 20 }, radial: { stops: [], center: { x: .5, y: .5 }, r: .5 } } });
  for (const { shape, fill } of shapes)
    add(shape.type, { x: AT.x, y: AT.y, w: CELL, h: CELL, ...shape.over, strokeWidth: 0, fill });
  return serialize(doc);
}
const metalFill = (params) => ({ type: "material", material: { id: "metal", params } });
const stampFill = (params) => ({ type: "material", material: { id: "metalStamp", params } });

/** Query→pixels. Renders a doc to a decoded PNG (RGBA). */
async function render(docJson) {
  const bytes = await renderDocToPng(docJson, { slide: 0, alpha: 1, width: W, height: H });
  return PNG.sync.read(Buffer.from(bytes));
}

/** Pure. Bright-interior mask (1 = shape pixel, from a solid opaque fill over the dark BG). */
function interiorMask(solidPng) {
  const { width: w, height: h, data } = solidPng;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = data[i * 4] > 210 && data[i * 4 + 1] > 210 && data[i * 4 + 2] > 210 ? 1 : 0;
  return m;
}
/** Pure. Erode a mask by `r` px (all-neighbours-set). Used to split interior into a deep
 * CENTRE (heavily eroded) and an EDGE band (interior minus a lightly-eroded core). */
function erode(mask, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    let ok = true;
    for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r && ok; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) ok = false;
    }
    out[y * w + x] = ok ? 1 : 0;
  }
  return out;
}
/** Pure. Mean [r,g,b] over a mask. */
function meanRGB(png, mask) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < mask.length; i++) { if (!mask[i]) continue; const o = i * 4; r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++; }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}
/** Pure. Mean absolute RGB difference between two PNGs over a mask. */
function maskedMeanDiff(a, b, mask) {
  let s = 0, n = 0;
  for (let i = 0; i < mask.length; i++) { if (!mask[i]) continue; const o = i * 4; s += (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2])) / 3; n++; }
  return n ? s / n : 0;
}
/** Pure. Mean luminance (Rec.601-ish) over a mask. */
function meanLum(png, mask) { const [r, g, b] = meanRGB(png, mask); return 0.299 * r + 0.587 * g + 0.114 * b; }
/** Pure. Byte count where two buffers differ. */
function byteDiff(a, b) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }

const fails = [];
const ok = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else console.log(`  ok   ${msg}`); };

// Interior masks (from a solid-white fill of each shape).
const gearMask = interiorMask(await render(metalDoc([{ shape: GEAR, fill: "#ffffff" }])));
const rectMask = interiorMask(await render(metalDoc([{ shape: RECT, fill: "#ffffff" }])));
ok(gearMask.reduce((a, b) => a + b, 0) > 3000, `gear interior mask non-trivial (${gearMask.reduce((a, b) => a + b, 0)} px)`);

// The EDGE band vs CENTRE core of the gear (for the crevice-coupling metric).
const gearCentre = erode(gearMask, W, H, 26);
const gearCore = erode(gearMask, W, H, 4);
const gearEdge = new Uint8Array(W * H);
for (let i = 0; i < gearMask.length; i++) gearEdge[i] = gearMask[i] && !gearCore[i] ? 1 : 0;

// ── 1. metalType drives the F0 HUE ────────────────────────────────────────────
{
  const brass = await render(metalDoc([{ shape: GEAR, fill: metalFill({ metalType: "brass", roughness: 0.2, warmthBoost: 0.3 }) }]));
  const steel = await render(metalDoc([{ shape: GEAR, fill: metalFill({ metalType: "steel", roughness: 0.2 }) }]));
  fs.writeFileSync(resolve(SHOTS, "metal_test_brass_gear.png"), PNG.sync.write(brass));
  const [br, bg, bb] = meanRGB(brass, gearMask);
  const [sr, sg, sb] = meanRGB(steel, gearMask);
  const brassSpread = br - bb, steelSpread = Math.abs(sr - sb);
  ok(br > bg && bg > bb, `brass is R>G>B (${br.toFixed(0)}>${bg.toFixed(0)}>${bb.toFixed(0)}) — warm chromatic spec`);
  ok(brassSpread > 25, `brass spec is CHROMATIC (R-B ${brassSpread.toFixed(0)} > 25)`);
  ok(steelSpread < 12, `steel spec is ACHROMATIC (|R-B| ${steelSpread.toFixed(0)} < 12)`);
  ok(brassSpread > steelSpread + 15, `metalType changes the hue (brass Δ ${brassSpread.toFixed(0)} ≫ steel Δ ${steelSpread.toFixed(0)})`);
}

// ── 2. patina COUPLES to the crevice (edge darkens more than faces) ────────────
{
  const clean = await render(metalDoc([{ shape: GEAR, fill: metalFill({ metalType: "brass", roughness: 0.3, patinaAmount: 0 }) }]));
  const aged = await render(metalDoc([{ shape: GEAR, fill: metalFill({ metalType: "brass", roughness: 0.3, patinaAmount: 0.9, patinaColor: "rgb(43,90,82)" }) }]));
  fs.writeFileSync(resolve(SHOTS, "metal_test_patina_gear.png"), PNG.sync.write(aged));
  const edgeChange = maskedMeanDiff(clean, aged, gearEdge);
  const faceChange = maskedMeanDiff(clean, aged, gearCentre);
  ok(edgeChange > 8, `patina visibly ages the crevices (edge Δ ${edgeChange.toFixed(1)} > 8)`);
  ok(edgeChange > faceChange * 1.5, `patina COUPLES to the crevice — edge Δ ${edgeChange.toFixed(1)} ≫ face Δ ${faceChange.toFixed(1)} (SDF recess mask, not a flat tint)`);
}

// ── 3. the STAMP embosses a backdrop (relit, darker floor, bright bevel) ───────
{
  const flat = await render(metalDoc([{ shape: RECT, fill: "#9aa0a6" }]));               // plain grey plate
  const stamped = await render(metalDoc([
    { shape: RECT, fill: "#9aa0a6" },
    { shape: GEAR, fill: stampFill({ depth: 0.9, bevelWidth: 12, profile: "chamfer", emboss: false }) },
  ]));
  fs.writeFileSync(resolve(SHOTS, "metal_test_stamp_gear.png"), PNG.sync.write(stamped));
  const changed = maskedMeanDiff(flat, stamped, gearMask);
  const flatLum = meanLum(flat, gearMask), stampLum = meanLum(stamped, gearMask);
  // brightest bevel catch-line vs the flat plate
  let maxLum = 0; for (let i = 0; i < gearMask.length; i++) { if (!gearMask[i]) continue; const o = i * 4; const l = 0.299 * stamped.data[o] + 0.587 * stamped.data[o + 1] + 0.114 * stamped.data[o + 2]; if (l > maxLum) maxLum = l; }
  ok(changed > 10, `the stamp RELIGHTS the backdrop (Δ ${changed.toFixed(1)} > 10)`);
  ok(stampLum < flatLum - 5, `the engraved floor is DARKER than the flat plate (${stampLum.toFixed(0)} < ${flatLum.toFixed(0)})`);
  ok(maxLum > flatLum + 20, `a bright bevel catch-line appears (max ${maxLum.toFixed(0)} > plate ${flatLum.toFixed(0)}+20)`);
}

// ── 4. the stamp's patina accumulates in its OWN groove (crevice coupling) ─────
{
  const plain = await render(metalDoc([
    { shape: RECT, fill: "#9aa0a6" },
    { shape: GEAR, fill: stampFill({ depth: 0.8, bevelWidth: 12, emboss: false, patinaAmount: 0 }) },
  ]));
  const patinaed = await render(metalDoc([
    { shape: RECT, fill: "#9aa0a6" },
    { shape: GEAR, fill: stampFill({ depth: 0.8, bevelWidth: 12, emboss: false, patinaAmount: 0.9, patinaColor: "rgb(43,90,82)" }) },
  ]));
  const [pr, pg, pb] = meanRGB(plain, gearMask);
  const [ar, ag, ab] = meanRGB(patinaed, gearMask);
  const change = maskedMeanDiff(plain, patinaed, gearMask);
  ok(change > 6, `stamp patina accumulates in the groove (Δ ${change.toFixed(1)} > 6)`);
  ok((ag - ab) - (pg - pb) > 4 || (pr - ar) > 6, `the groove shifts toward the patina hue (teal: G-B rose ${((ag - ab) - (pg - pb)).toFixed(0)}, R fell ${(pr - ar).toFixed(0)})`);
}

// ── 5. DETERMINISM ────────────────────────────────────────────────────────────
{
  const params = { metalType: "steel", roughness: 0.4, brushAmount: 0.8, seed: 7 };
  const a = await renderDocToPng(metalDoc([{ shape: GEAR, fill: metalFill(params) }]), { slide: 0, alpha: 1, width: W, height: H });
  const b = await renderDocToPng(metalDoc([{ shape: GEAR, fill: metalFill(params) }]), { slide: 0, alpha: 1, width: W, height: H });
  const c = await renderDocToPng(metalDoc([{ shape: GEAR, fill: metalFill({ ...params, seed: 99 }) }]), { slide: 0, alpha: 1, width: W, height: H });
  ok(byteDiff(Buffer.from(a), Buffer.from(b)) === 0, `identical params ⇒ byte-identical (${byteDiff(Buffer.from(a), Buffer.from(b))} diffs)`);
  ok(byteDiff(Buffer.from(a), Buffer.from(c)) > 100, `a different seed changes the brushing (${byteDiff(Buffer.from(a), Buffer.from(c))} diffs > 100)`);
}

if (fails.length) {
  console.error(`\nFAILED: ${fails.length} — metal materials`);
  process.exit(1);
}
console.log(`\nPASS — metal materials (F0 hue, patina crevice coupling, stamp emboss + groove patina, determinism)`);
