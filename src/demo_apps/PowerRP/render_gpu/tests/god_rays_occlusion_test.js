/**
 * GOD RAYS — THE OCCLUSION PIXEL TEST, on the CanvasKit CPU surface.
 *
 * The user's requirement is a pixel claim and nothing else can check it: "if there's
 * a square in front that blocks the Sun, it would block all the god rays". This
 * renders exactly that scene through the real Skia backend (node_render's software
 * MakeSurface — the same paint_skia handler and the same SkSL the editor runs) and
 * MEASURES that the sector of sky the square shadows accumulates less light than the
 * mirrored sector beside it that the square does not shadow.
 *
 * WHY A RENDER TEST AND NOT A UNIT TEST: the whole effect is an integral along screen
 * rays through the composite-so-far. There is no state to assert on — the occlusion
 * exists only in the pixels, and only once the backdrop child is really bound.
 *
 * WHY THIS IS ALSO THE REGRESSION PIN FOR TWO REAL DEFECTS, both of which rendered
 * a plausible-looking picture rather than an error:
 *   1. A NaN tint uniform (parseColor returns 0..1, not 0..255) poisoned the multiply
 *      chain and made the effect a perfect no-op — everything compiled, nothing drew.
 *      Caught here as "the rays added no light at all".
 *   2. An alpha derived from the ray's own brightness made bright rays OPAQUE, so they
 *      REPLACED the scene instead of adding to it. That inverts the effect: the sun
 *      came out dimmer than its own white and the shadowed sector came out BRIGHTER
 *      than the clear one. Caught here as a negative contrast, and by the sun check.
 *
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/god_rays_occlusion_test.js
 */

import test from "node:test";
import assert from "node:assert";
import { PNG } from "pngjs";

import { renderToPng } from "../skia/node_render.js";
import { materialBackdrop, rect } from "../ir.js";
import { GOD_RAYS_FILL_PARAMS, godRaysUniformParams } from "../skia/god_rays_shader.js";

const W = 640, H = 400;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const SKY = "#8fb4d8";                          // a bright daylight sky: the field the rays scatter through
const SUN = { x: 320, y: 60, r: 55 };           // the light: the brightest thing in the frame
const OCC = { x: 250, y: 150, w: 120, h: 70 };  // the user's "square in front", opaque and near-black

// Sampling line, well BELOW the occluder (which ends at y = 220), where a shadow
// volume has had room to form. SHADOW_X is on the sun→occluder axis; the two CLEAR
// columns are mirrored far to either side, where the ray to the sun misses the square.
const SAMPLE_Y = 330, SHADOW_X = 310, CLEAR_L = 140, CLEAR_R = 500;

/** Pure function. Rec.709 luminance (0..255) of one RGB triple.
 *  @example luma255([255, 255, 255]) // 255
 *  @example Math.round(luma255([255, 0, 0])) // 54 */
function luma255([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The default knob set, as the plugin's own schema declares it. */
const DEFAULT_KNOBS = Object.fromEntries(GOD_RAYS_FILL_PARAMS.map((d) => [d.name, d.default]));

/** Query (renders). The fixture at a given knob override; returns a pixel reader. */
async function renderScene({ withRays = true, knobs = {} } = {}) {
  const scene = [
    rect({ x: 0, y: 0, w: W, h: H, fill: SKY }),
    rect({ x: SUN.x - SUN.r, y: SUN.y - SUN.r, w: SUN.r * 2, h: SUN.r * 2, fill: "#ffffff", cornerRadius: SUN.r }),
    rect({ ...OCC, fill: "#000000" }),
  ];
  if (withRays) {
    scene.push(materialBackdrop({
      material: "god_rays",
      cx: W / 2, cy: H / 2, halfW: W / 2, halfH: H / 2, cornerRadius: 0, blurRadius: 0,
      params: {
        lightOffsetX: SUN.x - W / 2, lightOffsetY: SUN.y - H / 2,
        ...godRaysUniformParams({ ...DEFAULT_KNOBS, ...knobs }),
      },
    }));
  }
  const buf = await renderToPng(scene, VIEW, { width: W, height: H, background: "#111111" });
  const png = PNG.sync.read(Buffer.from(buf));
  return (x, y) => {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
}

test("god rays: an occluder between the sun and a patch of sky SHADOWS the beams there", async () => {
  const on = await renderScene();
  const off = await renderScene({ withRays: false });

  // What the RAYS contributed at each column: the on-minus-off difference. Measuring
  // the difference rather than the absolute value is what makes this an assertion
  // about the rays rather than about the fixture's own left/right symmetry.
  const gain = (x) => luma255(on(x, SAMPLE_Y)) - luma255(off(x, SAMPLE_Y));
  const shadowed = gain(SHADOW_X);
  const clear = (gain(CLEAR_L) + gain(CLEAR_R)) / 2;

  // (a) The effect must actually be doing something. A silent no-op — the NaN-tint
  //     defect — lands exactly here.
  assert.ok(clear > 0.5,
    `the rays added no light to the unoccluded sky (contribution ${clear.toFixed(2)}/255) — the effect is not rendering at all`);

  // (b) THE REQUIREMENT: the shadowed sector must gain LESS than the clear one.
  assert.ok(shadowed < clear,
    `OCCLUSION FAILED: the sector shadowed by the square gained ${shadowed.toFixed(2)} but the mirrored clear sector gained ${clear.toFixed(2)} — a dark square between the sun and a patch of sky must reduce the light that patch accumulates`);
});

test("god rays ADD light — they never dim what is already bright", async () => {
  // The inverted-alpha defect showed up first as the sun disc rendering DIMMER than
  // the pure white it is drawn with. Additive light cannot darken anything, so this
  // is a total invariant rather than a tuning question.
  const on = await renderScene();
  const off = await renderScene({ withRays: false });
  for (const [label, x, y] of [["sun disc", SUN.x, SUN.y], ["clear sky left", CLEAR_L, SAMPLE_Y], ["clear sky right", CLEAR_R, SAMPLE_Y]]) {
    const a = luma255(on(x, y)), b = luma255(off(x, y));
    assert.ok(a >= b - 1, `${label}: the rays DARKENED it (${b.toFixed(1)} → ${a.toFixed(1)}) — additive light cannot subtract`);
  }
});

test("god rays: exposure 0 is exactly the unlit scene (the knob really is a master)", async () => {
  const zero = await renderScene({ knobs: { exposure: 0 } });
  const off = await renderScene({ withRays: false });
  for (const [x, y] of [[SHADOW_X, SAMPLE_Y], [CLEAR_L, SAMPLE_Y], [SUN.x, SUN.y]])
    assert.deepEqual(zero(x, y), off(x, y), `exposure 0 must leave the scene untouched at (${x}, ${y})`);
});

test("god rays: DETERMINISM — the same scene renders byte-identically twice", async () => {
  // The dither is a positional hash, not a clock (CLAUDE.md's property-state law).
  const a = await renderScene(), b = await renderScene();
  for (const [x, y] of [[SHADOW_X, SAMPLE_Y], [CLEAR_L, SAMPLE_Y], [CLEAR_R, SAMPLE_Y], [SUN.x, SUN.y], [5, 5]])
    assert.deepEqual(a(x, y), b(x, y), `two renders of one scene differ at (${x}, ${y}) — the shader is reading something that is not document state`);
});
