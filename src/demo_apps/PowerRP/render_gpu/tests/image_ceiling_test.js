/**
 * THE IMAGE HALF OF THE CANVASKIT HEAP GUARD (#213 did surfaces; #267 is this).
 *
 * BARE NODE, DELIBERATELY. The defect is invisible in a browser on this hardware:
 * measured, MakeImageFromCanvasImageSource returned a 20000x20000 image — ~1.6 GB
 * of RGBA — on a host reporting MAX_TEXTURE_SIZE 8192, because SwiftShader
 * allocates CPU-side and never complains. A browser probe would therefore pass
 * forever against a broken build, which is the repo's standing "parameterise the
 * environment you do not have" case. The decision is a pure function of
 * (w, h, maxEdge), so it is tested as one, here, with no GPU in the picture.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rasterFitFactor, MAX_SURFACE_DIM } from "../../core/clip.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../gpu/image_registry.js"), "utf8");
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

test("the ceiling is the SURFACE ceiling, not a second opinion about 'too big'", () => {
  assert.ok(src.includes('from "../../core/clip.js"'), "image_registry does not import the shared ceiling");
  assert.ok(/maxEdge = MAX_SURFACE_DIM/.test(src), "the default ceiling is not MAX_SURFACE_DIM");
  assert.ok(!/=\s*8192/.test(src), "a literal 8192 in image_registry is a second ceiling that will drift");
});

test("the raw MakeImageFromCanvasImageSource call is no longer reachable un-guarded", () => {
  const calls = [...src.matchAll(/MakeImageFromCanvasImageSource\(/g)].length;
  assert.equal(calls, 2, `expected exactly the two calls inside the guard (got ${calls})`);
  const guard = src.slice(src.indexOf("function skiaImageWithin"));
  assert.equal([...guard.slice(0, guard.indexOf("\n}")).matchAll(/MakeImageFromCanvasImageSource\(/g)].length, 2,
    "both calls must live INSIDE skiaImageWithin — one outside it is an unguarded door to the heap");
  assert.ok(/const img = skiaImageWithin\(/.test(src), "getSkiaImage does not go through the guard");
});

test("THE DECISION: an oversized source is downscaled, aspect preserved, and it FITS", () => {
  // The exact shape that kills a real GPU, and the one this host silently allowed.
  const k = rasterFitFactor(20000, 20000, MAX_SURFACE_DIM);
  assert.ok(k < 1, "a 20000-square source must be scaled down");
  const w = Math.max(1, Math.floor(20000 * k)), h = Math.max(1, Math.floor(20000 * k));
  assert.ok(w <= MAX_SURFACE_DIM && h <= MAX_SURFACE_DIM, `still oversized after scaling: ${w}x${h}`);
  assert.equal(w, h, "a square source must stay square");
  // A 1.6 GB allocation becomes a 268 MB one — the whole point.
  assert.ok(20000 * 20000 * 4 > 1e9 && w * h * 4 < 3e8, "the guard does not actually bound the allocation");
});

test("the WIDE edge decides, so a long thin source is not silently letterboxed", () => {
  const k = rasterFitFactor(30000, 100, MAX_SURFACE_DIM);
  assert.ok(Math.floor(30000 * k) <= MAX_SURFACE_DIM, "the long edge still exceeds the ceiling");
  assert.ok(Math.floor(100 * k) >= 1, "the short edge collapsed below one pixel");
});

test("A SOURCE THAT ALREADY FITS IS UNTOUCHED — no scratch canvas, byte-identical path", () => {
  assert.equal(rasterFitFactor(1024, 768, MAX_SURFACE_DIM), 1);
  assert.equal(rasterFitFactor(MAX_SURFACE_DIM, MAX_SURFACE_DIM, MAX_SURFACE_DIM), 1, "exactly at the ceiling must not be scaled");
  assert.ok(/if \(k === 1\) return CanvasKit\.MakeImageFromCanvasImageSource\(bitmap\);/.test(src),
    "the k===1 fast path is gone — every image would pay for a scratch canvas");
});

test("THE CLAMP IS REPORTED — clip.js's ask-vs-got law names two shipped defects caused by a silent one", () => {
  const guard = src.slice(src.indexOf("function skiaImageWithin"));
  assert.ok(/reportOnce\(/.test(guard.slice(0, guard.indexOf("\n}"))), "the downscale is silent");
});

console.log(`\n${passed} image-ceiling tests passed`);
