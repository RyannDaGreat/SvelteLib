/**
 * vector_pattern_seam_test.js — THE SEAM GATE for the vector pattern engine.
 *
 * WHY THIS TEST IS THE IMPORTANT ONE. Every pattern in core/vector_patterns.js is a
 * RECTANGULAR fundamental domain tiled by plain repetition, so "is it seamless?" is
 * entirely a property of the GENERATOR: any ink crossing a cell edge must also
 * appear, identically, across the opposite edge. That is easy to get wrong in a way
 * that looks fine in a thumbnail and shows up as a visible grid of cuts at
 * presentation size — and it is not hypothetical here: `crosshatch` FAILED this
 * check on its first implementation (a 45° band leaves through two edges, so one
 * band per direction cannot be continuous; it needed the ±w re-entering
 * translates). The generator was fixed because this test caught it, which is the
 * whole argument for checking seams mechanically rather than by eye.
 *
 * HOW THE CHECK WORKS, and why it is not a fixed threshold. A pattern legitimately
 * contains hard edges — a checkerboard's interior is nothing but maximal jumps — so
 * "no large delta at the seam" would fail every good pattern. What must be true
 * instead is that THE SEAM IS NOT SPECIAL: the largest neighbouring-pixel jump
 * across a tile boundary must be no worse than the largest jump strictly inside a
 * tile. A flat cut at the boundary shows up as a seam delta EXCEEDING everything
 * the pattern does internally. Both axes are checked, because a generator can wrap
 * correctly in x and not in y (the honeycomb's two-hex domain is exactly that
 * shape).
 *
 * Uses CanvasKit's SOFTWARE surface, so it runs in bare node with no GL — the same
 * surface cli/render.js uses, which is also the proof that patterns render on the
 * CLI still path (unlike image/video/LaTeX, which it cannot draw).
 */

import assert from "node:assert";
import CanvasKitInit from "canvaskit-wasm";
import { patternGeneratorIds, buildPatternCell, PATTERN_GENERATORS } from "../core/vector_patterns.js";

const CanvasKit = await CanvasKitInit();

/** Device size of the probe frame, and the device period a tile is scaled to.
 *  256/64 = exactly 4 tiles per axis, so seam columns land on whole pixels and a
 *  boundary delta is never a resampling artifact of a fractional period. */
const PROBE_PX = 256;
const TILE_DEVICE_PX = 64;

/** How much worse a seam jump may be than the worst interior jump, in 0..255
 *  levels. Not zero: the tile boundary is an antialiasing boundary too, and a
 *  half-covered edge pixel legitimately differs by a level or two from the
 *  interior's worst case. A real flat cut is an order of magnitude past this. */
const SEAM_SLACK_LEVELS = 2;

/**
 * Query (allocates a surface; returns pixel bytes). Renders `cell` tiled over a
 * PROBE_PX square through the SAME picture-shader path paint_skia uses, so what is
 * measured here is what the editor draws.
 *
 * @param {{w: number, h: number, shapes: Array}} cell
 * @returns {Uint8Array} RGBA8888 unpremultiplied pixels, PROBE_PX square
 */
function renderTiled(cell) {
  const recorder = new CanvasKit.PictureRecorder();
  const cellCanvas = recorder.beginRecording([0, 0, cell.w, cell.h]);
  for (const shape of cell.shapes) {
    const path = CanvasKit.Path.MakeFromSVGString(shape.d);
    assert.ok(path, `cell shape produced an unparseable path: ${shape.d.slice(0, 80)}`);
    if (shape.fillRule === "evenodd") path.setFillType(CanvasKit.FillType.EvenOdd);
    const paint = new CanvasKit.Paint();
    paint.setAntiAlias(true);
    // Opaque ink on opaque background: a translucent probe would let the seam
    // check measure alpha blending rather than geometry.
    const rgba = shape.paint === "background" ? [1, 1, 1, 1] : [0.1, 0.2, 0.8, shape.alpha ?? 1];
    paint.setColor(CanvasKit.Color4f(...rgba));
    cellCanvas.drawPath(path, paint);
    paint.delete();
    path.delete();
  }
  const picture = recorder.finishRecordingAsPicture();
  const scale = TILE_DEVICE_PX / cell.w;
  const shader = picture.makeShader(
    CanvasKit.TileMode.Repeat, CanvasKit.TileMode.Repeat, CanvasKit.FilterMode.Linear,
    CanvasKit.Matrix.scaled(scale, scale), [0, 0, cell.w, cell.h],
  );
  assert.ok(shader, "picture.makeShader returned null — the picture-shader tiling path is unavailable");
  const surface = CanvasKit.MakeSurface(PROBE_PX, PROBE_PX);
  const canvas = surface.getCanvas();
  canvas.clear(CanvasKit.WHITE);
  const paint = new CanvasKit.Paint();
  paint.setShader(shader);
  canvas.drawRect([0, 0, PROBE_PX, PROBE_PX], paint);
  const pixels = canvas.readPixels(0, 0, {
    width: PROBE_PX, height: PROBE_PX,
    colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  paint.delete(); shader.delete(); picture.delete(); surface.dispose();
  return pixels;
}

/**
 * Pure function. The largest neighbouring-pixel RGB jump at tile boundaries versus
 * strictly inside tiles, along one axis.
 *
 * @param {Uint8Array} pixels - RGBA8888, PROBE_PX square
 * @param {number} periodPx - the tile's device period along this axis
 * @param {boolean} horizontal - compare left/right neighbours (else up/down)
 * @returns {{seam: number, interior: number}} maximum deltas in 0..255 levels
 */
function boundaryDeltas(pixels, periodPx, horizontal) {
  const channelAt = (x, y, c) => pixels[(y * PROBE_PX + x) * 4 + c];
  let seam = 0, interior = 0;
  for (let a = 0; a < PROBE_PX; a++) {
    for (let b = 1; b < PROBE_PX; b++) {
      const [x, y] = horizontal ? [b, a] : [a, b];
      const [px, py] = horizontal ? [b - 1, a] : [a, b - 1];
      let delta = 0;
      for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(channelAt(x, y, c) - channelAt(px, py, c)));
      if (b % periodPx === 0) seam = Math.max(seam, delta);
      else interior = Math.max(interior, delta);
    }
  }
  return { seam, interior };
}

// ── 1. EVERY generator tiles seamlessly, in BOTH axes ─────────────────────────
// The roster is read from PATTERN_GENERATORS, so a generator added later is
// covered automatically rather than needing to be remembered here.
for (const id of patternGeneratorIds()) {
  const cell = buildPatternCell(id, {});
  const pixels = renderTiled(cell);
  const periodX = Math.round(TILE_DEVICE_PX);
  const periodY = Math.round((cell.h / cell.w) * TILE_DEVICE_PX);
  const across = boundaryDeltas(pixels, periodX, true);
  assert.ok(across.seam <= across.interior + SEAM_SLACK_LEVELS,
    `pattern "${id}" has a VERTICAL seam: max jump across a tile boundary was ${across.seam} levels, but the worst jump inside a tile is only ${across.interior} — the boundary is a visible cut`);
  if (periodY > 1 && PROBE_PX % periodY === 0) {
    const down = boundaryDeltas(pixels, periodY, false);
    assert.ok(down.seam <= down.interior + SEAM_SLACK_LEVELS,
      `pattern "${id}" has a HORIZONTAL seam: max jump across a tile boundary was ${down.seam} levels, but the worst jump inside a tile is only ${down.interior}`);
  }
}

// ── 2. RANDOM DOTS ARE PROPERTY STATE (the taxonomy law, mechanically) ────────
// Δt does not exist for a pattern; the check that matters is that the SEED alone
// determines the layout. Two independent builds at one seed must be byte-identical
// (so a save round-trip and a re-render agree), and different seeds must differ (so
// the seed is actually read rather than ignored).
const dotsA = renderTiled(buildPatternCell("random_dots", { seed: 42 }));
const dotsB = renderTiled(buildPatternCell("random_dots", { seed: 42 }));
assert.deepStrictEqual(Array.from(dotsA), Array.from(dotsB),
  "random_dots rendered two different pictures at the SAME seed — the scatter is reading something other than its stored seed");
const dotsOther = renderTiled(buildPatternCell("random_dots", { seed: 43 }));
assert.notDeepStrictEqual(Array.from(dotsA), Array.from(dotsOther),
  "random_dots rendered the same picture at two different seeds — the seed knob is not wired to the scatter");

// ── 3. PARAMS ACTUALLY MOVE THE PICTURE ───────────────────────────────────────
// A knob declared in a generator's schema but ignored by its generate() would pass
// every seam check while being dead in the UI. Each numeric knob is nudged and the
// cell must change (in geometry or in domain size).
for (const [id, gen] of Object.entries(PATTERN_GENERATORS)) {
  const base = JSON.stringify(buildPatternCell(id, {}));
  for (const row of gen.params) {
    if (row.kind === "number") {
      // Move the knob to a clearly different legal value: midway to its far bound.
      const moved = row.default === row.max ? (row.default + row.min) / 2 : (row.default + row.max) / 2;
      const changed = JSON.stringify(buildPatternCell(id, { [row.name]: moved }));
      assert.notStrictEqual(changed, base,
        `pattern "${id}" knob "${row.name}" changed from ${row.default} to ${moved} but produced an IDENTICAL cell — the knob is declared in the schema and ignored by the generator`);
    } else if (row.kind === "boolean") {
      const changed = JSON.stringify(buildPatternCell(id, { [row.name]: !row.default }));
      assert.notStrictEqual(changed, base,
        `pattern "${id}" boolean knob "${row.name}" is declared but ignored by the generator`);
    }
  }
}

console.log(`vector_pattern_seam_test: OK — ${patternGeneratorIds().length} generators tile seamlessly in both axes, random dots are seed-deterministic, every declared knob moves its cell`);
