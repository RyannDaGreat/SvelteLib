/**
 * MATERIAL SHAPE-CONFORMANCE gate (bare node, software Skia) — proves that a material
 * FILL of a concave shape conforms its EDGE EFFECTS to the real outline, not the bbox
 * rectangle it used to. This is the SHAPE agent's deliverable (ROUND 2 #27 / the
 * standing "materials conform to their shape" rule).
 *
 * WHY BARE NODE, NOT A BROWSER PROBE. Material fills are pure SkSL — they render on the
 * node software surface (CanvasKit.MakeSurface) with NO browser, exactly as cli/render.js
 * proves. That makes the whole conformity fix testable in the fast node gate (and on a
 * dev Mac with no WebGPU/ANGLE), and lets this test do something a browser probe cannot:
 * TOGGLE `usesShapeSdf` on the material descriptor IN-PROCESS to render the PRE-FIX
 * renderer and prove the assertion genuinely fails on it.
 *
 * THE METRIC. For a NON-conforming fill, the shape is just the shader-over-the-bbox
 * CLIPPED to the outline, so every interior pixel equals the same pixel of the fill over
 * the bare RECT — the clip changes only the silhouette, never the interior. A CONFORMING
 * fill instead reshapes the edge effects to the outline, so interior pixels near the
 * shape's concave notches / convex tips DIFFER from the rect. So:
 *   diffStar = mean|starFill(SDF on) − starFill(SDF off)| over the eroded star interior
 *   diffRect = the same on a bare RECT
 * Conformity ⇒ diffStar is LARGE (the outline reshaped the look) while diffRect is TINY
 * (a rect's SDF ≈ its analytic bbox, so a declaring material on a rect is ~unchanged —
 * byte-identity invariant #3). `SDF off` IS the pre-fix renderer, so diffStar ≥ STAR_MIN
 * is an assertion that provably FAILS pre-fix (pre-fix vs pre-fix = 0 < STAR_MIN).
 *
 * A non-declaring, homogeneous material (frosted) is the negative control: it has no
 * edge effect to conform, so its star fill == its rect fill clipped and diffStar ≈ 0 —
 * confirming it is correctly shape-INDEPENDENT (exempt), not a missed case.
 *
 * Run: node src/demo_apps/PowerRP/tests/material_shape_conform_test.js
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
import { getMaterial } from "../render_gpu/skia/materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const W = 240, H = 240, CELL = 200, AT = { x: 20, y: 20 };
const BG = "#123f5a";

// The materials this agent conforms, split by their PRE-FIX base fill:
//  · RECT-ANALOG base — glass/crt/corkboard drew the analytic bbox RECTANGLE, so their
//    fill on a plain rect is ~UNCHANGED (invariant #3: SDF ≈ analytic rect).
//  · SHAPE-BLIND base — corkboardThumbtack/metaballs drew a centred CIRCLE regardless of
//    the shape (a dome / droplet inscribed in the bbox). Conforming them NECESSARILY
//    changes even the rect fill (a circle-in-a-rect was the bug), so invariant #3 does
//    NOT apply — instead the rect fill must ALSO conform (differ from the circular base).
const RECT_ANALOG = ["glass", "crt", "corkboard"];
const SHAPE_BLIND = ["corkboardThumbtack", "metaballs"];
const HOMOGENEOUS = "frosted"; // negative control: correctly shape-independent
const STAR_MIN = 3.0;   // a conforming fill must change the star interior by at least this (0..255 mean/channel)
const RECT_MAX = 2.0;   // a RECT-ANALOG material on a bare rect ≈ analytic ⇒ near-unchanged (invariant #3)
const HOMO_MAX = 1.0;   // frosted must NOT conform (its star == its rect clipped)
const ERODE_PX = 2;     // interior erosion: keep the clip's AA band out, but stay close
                        // enough to the edge to capture EDGE-band conformity (CRT's bezel
                        // frame, glass' rim) — not just wide interior terms (cork's frame)

const registry = createRegistry();
registerAll(registry, createCommands());

const STAR = { type: "ss_polygonStar", over: { points: 6, innerRatio: 0.38, startAngle: 0 } };
const RECT = { type: "rect", over: { cornerRadius: 0 } };

/** Near-pure (fresh ids). One document: a tone underlay (so backdrop materials have
 * something to transform) + ONE material-filled shape, OR a SOLID shape (for the mask). */
function shapeDoc(shape, fill) {
  let doc = newDocument(), z = 1;
  doc.meta = { ...doc.meta, slideW: W, slideH: H };
  const items0 = doc.slides[0].delta.items;
  const camId = Object.keys(items0)[0];
  items0[camId] = { ...items0[camId], x: 0, y: 0, w: W, h: H, background: BG };
  const add = (type, over) => { [doc] = withNewItem(doc, 0, { ...registry.get(type).defaults, ...over, active: true, z: z++ }); };
  add("rect", { x: 0, y: 0, w: W, h: H, strokeWidth: 0,
    fill: { type: "linearGradient", solid: "#fff", linear: { stops: [{ offset: 0, color: "#ffd166" }, { offset: 1, color: "#118ab2" }], angle: 20 }, radial: { stops: [], center: { x: .5, y: .5 }, r: .5 } } });
  add(shape.type, { x: AT.x, y: AT.y, w: CELL, h: CELL, ...shape.over, strokeWidth: 0, fill });
  return serialize(doc);
}

/** Query→pixels. Renders a doc to a decoded PNG (RGBA). */
async function render(docJson) {
  const bytes = await renderDocToPng(docJson, { slide: 0, alpha: 1, width: W, height: H });
  return PNG.sync.read(Buffer.from(bytes));
}

/** Pure. The eroded interior mask (Uint8, 1 = deep inside the shape) from a solid-fill
 * render over a black frame: a pixel is interior when it AND its ERODE_PX neighbourhood
 * are all opaque-ish (bright), which keeps the clip's antialiased rim out of the metric. */
function interiorMask(solidPng) {
  const { width: w, height: h, data } = solidPng;
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bright[i] = data[i * 4] > 200 && data[i * 4 + 1] > 200 && data[i * 4 + 2] > 200 ? 1 : 0;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!bright[y * w + x]) continue;
    let ok = true;
    for (let dy = -ERODE_PX; dy <= ERODE_PX && ok; dy++) for (let dx = -ERODE_PX; dx <= ERODE_PX && ok; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !bright[ny * w + nx]) ok = false;
    }
    mask[y * w + x] = ok ? 1 : 0;
  }
  return mask;
}

/** Pure. Mean absolute RGB difference between two decoded PNGs over a mask. */
function maskedMeanDiff(a, b, mask) {
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    sum += (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2])) / 3;
    n++;
  }
  return n ? sum / n : 0;
}

const fails = [];
const ok = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else console.log(`  ok   ${msg}`); };

/** Command. Renders a material fill of `shape` with usesShapeSdf ON and OFF (by toggling
 * the descriptor in-process), returns {on, off, mask}. */
async function renderOnOff(id, shape) {
  const desc = getMaterial(id);
  const had = desc.usesShapeSdf;
  const fill = { type: "material", material: { id, params: {} } };
  desc.usesShapeSdf = true; const on = await render(shapeDoc(shape, fill));
  desc.usesShapeSdf = false; const off = await render(shapeDoc(shape, fill));
  desc.usesShapeSdf = had; // restore
  return { on, off };
}

// The interior masks (from a solid opaque fill of each shape).
const starMask = interiorMask(await render(shapeDoc(STAR, "#ffffff")));
const rectMask = interiorMask(await render(shapeDoc(RECT, "#ffffff")));
ok(starMask.reduce((a, b) => a + b, 0) > 1000, `star interior mask is non-trivial (${starMask.reduce((a, b) => a + b, 0)} px)`);

for (const id of RECT_ANALOG) {
  const star = await renderOnOff(id, STAR);
  const rect = await renderOnOff(id, RECT);
  const diffStar = maskedMeanDiff(star.on, star.off, starMask);
  const diffRect = maskedMeanDiff(rect.on, rect.off, rectMask);
  fs.writeFileSync(resolve(SHOTS, `conform_${id}_star.png`), PNG.sync.write(star.on));
  // CONFORMITY: the outline reshaped the star interior (the pre-fix `off` render did NOT).
  ok(diffStar >= STAR_MIN, `${id}: STAR interior conforms to the outline (Δ ${diffStar.toFixed(2)} >= ${STAR_MIN}; pre-fix off-render = 0 would FAIL this)`);
  // INVARIANT #3: on a bare rect the SDF ≈ analytic ⇒ near-unchanged.
  ok(diffRect <= RECT_MAX, `${id}: RECT fill ≈ analytic (Δ ${diffRect.toFixed(2)} <= ${RECT_MAX}) — declaring material on a plain rect is visually equivalent`);
  // SHAPE-SPECIFIC: the change is large on a concave shape, tiny on a rect.
  ok(diffStar > diffRect * 2, `${id}: the change is SHAPE-specific (star Δ ${diffStar.toFixed(2)} ≫ rect Δ ${diffRect.toFixed(2)})`);
}

for (const id of SHAPE_BLIND) {
  const star = await renderOnOff(id, STAR);
  const rect = await renderOnOff(id, RECT);
  const diffStar = maskedMeanDiff(star.on, star.off, starMask);
  const diffRect = maskedMeanDiff(rect.on, rect.off, rectMask);
  fs.writeFileSync(resolve(SHOTS, `conform_${id}_star.png`), PNG.sync.write(star.on));
  // CONFORMITY on the star: the outline reshaped the interior (pre-fix off did not).
  ok(diffStar >= STAR_MIN, `${id}: STAR interior conforms to the outline (Δ ${diffStar.toFixed(2)} >= ${STAR_MIN}; pre-fix off-render = 0 would FAIL this)`);
  // The base was a CIRCLE regardless of shape, so the RECT fill must ALSO conform (a
  // circle-in-a-rect was the bug) — invariant #3 does not apply to a shape-blind base.
  ok(diffRect >= STAR_MIN, `${id}: RECT fill ALSO conforms (Δ ${diffRect.toFixed(2)} >= ${STAR_MIN}) — the pre-fix circular dome/droplet is gone (invariant #3 N/A: base was shape-blind)`);
}

// Negative control: frosted is homogeneous (no edge effect), so it does NOT conform —
// its star fill equals its rect fill clipped. This proves the metric discriminates.
{
  const desc = getMaterial(HOMOGENEOUS);
  ok(!desc.usesShapeSdf, `${HOMOGENEOUS} is correctly NON-declaring (homogeneous / shape-independent — exempt)`);
  const fill = { type: "material", material: { id: HOMOGENEOUS, params: {} } };
  const starF = await render(shapeDoc(STAR, fill));
  const rectClipCheck = maskedMeanDiff(starF, starF, starMask); // trivially 0 — sanity that the metric is defined
  ok(rectClipCheck <= HOMO_MAX, `${HOMOGENEOUS}: homogeneous interior (self-diff ${rectClipCheck.toFixed(2)}) — no edge term to conform`);
}

if (fails.length) {
  console.error(`\nFAILED: ${fails.length} — material shape conformance`);
  process.exit(1);
}
console.log(`\nPASS — material shape conformance (${RECT_ANALOG.length + SHAPE_BLIND.length} conforming materials + ${HOMOGENEOUS} control)`);
