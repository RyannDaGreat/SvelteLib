/**
 * GOD RAYS — EXPORTER BEHAVIOUR (PDF + SVG).
 *
 * Neither vector exporter can run SkSL, so a screen-space ray march has no vector
 * form at all. Both therefore take the documented fallback the whole backdrop family
 * takes (pdf_backend.js / svg_backend.js: "ANY OTHER unrepresentable op … rasterizes
 * JUST that region"): the op is handed to the injected `rasterize` callback and the
 * result is embedded as an image. That is the SAME path glassBackdrop and the other
 * material backdrops already use, so god rays needed no exporter change.
 *
 * What this pins is that the behaviour is REACHED rather than assumed — an
 * unrepresentable op that silently vanished would export a slide with a hole in it,
 * and one that threw would fail a whole export over one widget. So: exactly one
 * rasterize call per exporter, and a document that comes back non-empty.
 *
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/god_rays_export_test.js
 */

import test from "node:test";
import assert from "node:assert";
import { PNG } from "pngjs";

import { materialBackdrop, rect } from "../ir.js";
import { irToPDF } from "../pdf_backend.js";
import { irToSVG } from "../svg_backend.js";
import { GOD_RAYS_FILL_PARAMS, godRaysUniformParams } from "../skia/god_rays_shader.js";

const W = 640, H = 400;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const KNOBS = Object.fromEntries(GOD_RAYS_FILL_PARAMS.map((d) => [d.name, d.default]));

/** The scene: a lit field with a god-rays region over it. */
const scene = () => ([
  rect({ x: 0, y: 0, w: W, h: H, fill: "#8fb4d8" }),
  materialBackdrop({
    material: "god_rays",
    cx: W / 2, cy: H / 2, halfW: W / 2, halfH: H / 2, cornerRadius: 0, blurRadius: 0,
    params: { lightOffsetX: 0, lightOffsetY: -140, ...godRaysUniformParams(KNOBS) },
  }),
]);

/** Pure. A 1x1 PNG standing in for the rasterized region. */
function onePixelPng() {
  const p = new PNG({ width: 1, height: 1 });
  [p.data[0], p.data[1], p.data[2], p.data[3]] = [200, 220, 255, 255];
  return new Uint8Array(PNG.sync.write(p));
}

test("PDF export rasterizes the god-rays region instead of dropping or throwing", async () => {
  let calls = 0;
  // Both backends' rasterize contract returns the raw PNG bytes (pdf_backend
  // emitRasterRegion feeds the result straight to embedPng; svg_backend base64s it).
  const rasterize = async () => { calls++; return onePixelPng(); };
  const pdf = await irToPDF(scene(), { width: W, height: H, view: VIEW, rasterize });
  assert.equal(calls, 1, `expected exactly one rasterized region, got ${calls}`);
  assert.ok((pdf?.length ?? pdf?.byteLength ?? 0) > 0, "irToPDF produced an empty document");
});

test("SVG export rasterizes the god-rays region instead of dropping or throwing", async () => {
  let calls = 0;
  // The SVG backend's rasterize contract returns the raw PNG bytes.
  const rasterize = async () => { calls++; return onePixelPng(); };
  const svg = await irToSVG(scene(), { width: W, height: H, view: VIEW, rasterize });
  assert.equal(calls, 1, `expected exactly one rasterized region, got ${calls}`);
  assert.ok(typeof svg === "string" && svg.length > 0, "irToSVG produced an empty document");
  assert.match(svg, /<image\b/, "the rasterized region must be embedded as an <image>, not silently dropped");
});
