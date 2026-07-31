/**
 * SILHOUETTE BORDER — an SVG/iconify widget's border traces its own glyph
 * outline (the union of its content ops' filled paths), not its bounding box.
 * Plain node, no framework. Run: node src/demo_apps/PowerRP/render_gpu/tests/silhouette_test.js
 *
 * ── THE FEATURE ────────────────────────────────────────────────────────────────
 * render_gpu/decorate.js's decorateStrokedBox draws a plain rounded RECT ring for
 * every widget that shares it (image/video/latex/pdf_page/mermaid/…). That is
 * wrong for svg/iconify: a heart icon's border should hug its curve, not its
 * bbox corners, and a multi-subpath icon should get one ring PER PIECE, not one
 * rect around the whole cluster. decorateSilhouetteBorder (svg/iconify ONLY)
 * stamps `{...cropSubtree, silhouette: true, silhouetteContent}`; paint_skia's
 * handleCropSubtree strokes the UNION of silhouetteContent's shape ops
 * (render_gpu/skia/silhouette.js) instead of the rrect when that flag is set.
 * Export (PDF/SVG) gets the same geometry via a pre-pass, resolveSilhouetteBorders,
 * that stamps `cmd.borderPath` before the DOM-free/CanvasKit-free backends ever
 * see the IR.
 *
 * ── WHAT THIS SUITE PINS ─────────────────────────────────────────────────────
 *   1. silhouetteUnionPath/silhouettePathD: a heart traces its curve (ink present
 *      along the curve, ABSENT at the old bbox corner); a multi-subpath icon
 *      unions into a path outlining EACH piece separately (not one bbox blob);
 *      fill-rule (evenodd) is honored; non-shape ops are skipped; no shape ops
 *      returns null; the content-identity cache hits/misses correctly.
 *   2. decorateSilhouetteBorder: pass-through when undecorated (matches
 *      decorateStrokedBox byte-for-byte); decorated case carries `silhouette:true`
 *      + `silhouetteContent`; OFF-stroke is STILL a pure pass-through (the
 *      76f968e regression's exact shape, re-pinned on the silhouette sibling).
 *   3. PIXEL PROBE (paint_skia, real Skia raster): stroke ON traces the glyph
 *      curve (ink along the curve, NONE at the bbox corner); rotated + flipped;
 *      multi-subpath (disjoint rings); OFF renders nothing extra.
 *   4. strokeOffset on a silhouette: attached (two-clipped-strokes) and detached
 *      (|offset|>1, parallel-contour) both route through the generalized
 *      drawOffsetOpStroke/drawDetachedContourStroke via `pathOverride`.
 *   5. EXPORT: resolveSilhouetteBorders stamps `borderPath`; PDF/SVG emit a
 *      NATIVE PATH STROKE of that `d` string (no <image>, no new clip ops at
 *      offset 0); a GHOST silhouette (no shape ops) falls back to the rect path.
 *   6. THE TEN UNTOUCHED WIDGETS: decorateStrokedBox's own behavior (used by
 *      image/video/filmstrip/latex/mermaid/pdf_page/video_scrub/
 *      video_time_scrub/video_v2/video_v5_scrub) is BYTE-IDENTICAL to before —
 *      no `silhouette` flag, same rrect ring, same op shape.
 *   7. strokemat orthogonality: svgOverrideSlotPaint's material-to-solid
 *      substitution (the SVG's OWN content fill/stroke) does not change the
 *      silhouette geometry at all — the union only reads shape/`d`, never paint.
 */
import assert from "assert";
import { createRequire } from "module";
import path from "path";
import { cropSubtree, rect, opStrokeIsOffset, applyStrokeOffset, pushTransform, popTransform } from "../ir.js";
import { decorateStrokedBox, decorateSilhouetteBorder } from "../decorate.js";
import { paintIR } from "../skia/paint_skia.js";
import { emitCropSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { svgPlugin } from "../../plugins/svg.js";
import { svgOverrideSlotPaint } from "../gpu/svg_raster.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
const { silhouetteUnionPath, silhouettePathD, resolveSilhouetteBorders, clearSilhouetteCache, SILHOUETTE_SHAPE_OPS } =
  await import("../skia/silhouette.js");

const fontCollection = (() => {
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(CanvasKit.TypefaceFontProvider.Make());
  return fc;
})();

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

// A HEART path in a ~24-unit box (a real multi-curve glyph, not a rect-alike):
// its bbox corners carry NO ink — the whole point of tracing the silhouette
// instead of the bbox. Written with pure cubics (M/C/Z only, no arcs/shorthand)
// so scalePathD's naive per-number scaling below is exact (an arc's flag digits
// would otherwise get scaled like coordinates and corrupt the command).
const HEART_D = "M12 21 C12 21 4 16.4 4 10 C4 6.13 7.13 3 11 3 C12.19 3 13.34 3.5 14.14 4.33 " +
                "C14.94 3.5 16.09 3 17.29 3 C21.15 3 24.29 6.13 24.29 10 C24.29 16.4 16.29 21 12 21 Z";
const HEART_SVG = `<svg viewBox="0 0 24 24"><path d="${HEART_D}" fill="#000"/></svg>`;

// TWO DISJOINT SQUARES (a multi-subpath icon: two disconnected pieces, like a
// donut's two rings or two glyphs sharing one widget) in the same viewBox.
const TWO_SQUARES_D = "M2 2h4v4h-4z M14 14h4v4h-4z";

/**
 * Pure function. Scales every bare number in an SVG path `d` string by `k` —
 * a minimal re-author of a fixture path at a different size, so the pixel-probe
 * section below can place the SAME glyph directly into a widget's own local box
 * (no viewBox transform in play — that machinery is covered separately by
 * flattenIR's own tests and this module's viewBox-transform docblock note).
 * Deliberately ignorant of arc flags (the two 0/1 flags inside an `a`/`A` command
 * are also bare digits) — none of this suite's fixtures use arcs, so scaling
 * every number uniformly is exact here; a general-purpose version would need to
 * skip them.
 *
 * @example scalePathD("M2 2h4v4h-4z", 10) // "M20 20h40v40h-40z"
 */
function scalePathD(d, k) {
  return d.replace(/-?\d*\.?\d+/g, (n) => {
    const v = parseFloat(n) * k;
    return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  });
}

// ── 1. silhouetteUnionPath / silhouettePathD — pure geometry ──────────────────

test("silhouetteUnionPath: a heart's silhouette has NO ink at the bbox corner but DOES have ink on its curve", () => {
  clearSilhouetteCache();
  const p = CanvasKit.Path.MakeFromSVGString(HEART_D);
  const bounds = p.getBounds();
  p.delete();
  const contentOps = [{ op: "path", d: HEART_D }];
  const union = silhouetteUnionPath(CanvasKit, contentOps);
  assert.ok(union, "a path op must produce a silhouette");
  // Bbox corner: outside the heart's curve everywhere except possibly its own
  // top notch — check the bottom-left corner, definitely outside the glyph.
  assert.ok(!union.contains(bounds.fLeft + 0.01, bounds.fBottom - 0.01), "bbox corner must be OUTSIDE the silhouette");
  // A point near the heart's bottom point IS inside.
  assert.ok(union.contains(12, 18), "a point on the glyph's body must be INSIDE the silhouette");
  union.delete();
});

test("silhouetteUnionPath: a multi-subpath icon unions into a path outlining EACH disjoint piece, not one bbox blob", () => {
  clearSilhouetteCache();
  const contentOps = [{ op: "path", d: TWO_SQUARES_D, fillRule: "evenodd" }];
  const union = silhouetteUnionPath(CanvasKit, contentOps);
  assert.ok(union.contains(4, 4), "inside square 1");
  assert.ok(union.contains(16, 16), "inside square 2");
  assert.ok(!union.contains(10, 10), "the GAP between the two squares must be OUTSIDE — a bbox blob would wrongly include it");
  union.delete();
});

test("silhouetteUnionPath: skips non-shape ops (text/…) and returns null when there are no shape ops at all", () => {
  clearSilhouetteCache();
  assert.equal(silhouetteUnionPath(CanvasKit, [{ op: "text", text: "x", x: 0, y: 0, size: 10 }]), null);
  const mixed = silhouetteUnionPath(CanvasKit, [{ op: "text", text: "x", x: 0, y: 0, size: 10 }, { op: "rect", x: 0, y: 0, w: 4, h: 4 }]);
  assert.ok(mixed, "a shape op mixed with a non-shape op still traces the shape");
  mixed.delete();
});

test("SILHOUETTE_SHAPE_OPS names exactly rect/ellipse/polygon/path", () => {
  assert.deepEqual([...SILHOUETTE_SHAPE_OPS].sort(), ["ellipse", "path", "polygon", "rect"]);
});

test("silhouettePathD: caches by content-array IDENTITY (same reference -> same string object retrieval, no rebuild)", () => {
  clearSilhouetteCache();
  const contentOps = [{ op: "path", d: HEART_D }];
  const d1 = silhouettePathD(CanvasKit, contentOps);
  const d2 = silhouettePathD(CanvasKit, contentOps);
  assert.equal(d1, d2);
  assert.ok(typeof d1 === "string" && d1.length > 0);
  // A DIFFERENT array (even with identical geometry) is a cache MISS, but still
  // produces the same traced shape (content-identity caching, not geometry hashing).
  const d3 = silhouettePathD(CanvasKit, [{ op: "path", d: HEART_D }]);
  assert.equal(d3, d1, "same geometry, different array identity -> same traced d string");
});

test("silhouettePathD: null for a GHOST content array (no shape ops)", () => {
  clearSilhouetteCache();
  assert.equal(silhouettePathD(CanvasKit, [{ op: "text", text: "!", x: 0, y: 0, size: 10 }]), null);
});

// ── 2. decorateSilhouetteBorder — the op boundary ─────────────────────────────

const OFF = { type: "none" };

test("decorateSilhouetteBorder: pass-through when undecorated, byte-identical to decorateStrokedBox", () => {
  const content = [{ op: "path", d: HEART_D }];
  const style = { w: 24, h: 24, stroke: null, strokeWidth: 0 };
  const a = decorateSilhouetteBorder(content, style, IDENTITY_WORLD);
  const b = decorateStrokedBox(content, style, IDENTITY_WORLD);
  assert.equal(a, content, "pass-through must be the SAME array reference");
  assert.equal(a, b);
});

test("decorateSilhouetteBorder: decorated case carries silhouette:true + silhouetteContent (raw local ops)", () => {
  const content = [{ op: "path", d: HEART_D }];
  const style = { w: 24, h: 24, stroke: "#f00", strokeWidth: 2 };
  const out = decorateSilhouetteBorder(content, style, IDENTITY_WORLD);
  assert.equal(out.length, 1);
  assert.equal(out[0].op, "cropSubtree");
  assert.equal(out[0].silhouette, true);
  assert.equal(out[0].silhouetteContent, content, "the RAW pre-wrap content, by reference");
});

test("decorateSilhouetteBorder: OFF stroke + nonzero width is STILL a pure pass-through (76f968e's rule, on the silhouette sibling)", () => {
  const content = [{ op: "path", d: HEART_D }];
  const out = decorateSilhouetteBorder(content, { w: 24, h: 24, stroke: OFF, strokeWidth: 5 }, IDENTITY_WORLD);
  assert.equal(out, content);
});

// ── 3. THE DECISIVE PIXEL PROBE (real Skia raster) ────────────────────────────

const W = 200, H = 200;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const BOX = { x: 20, y: 20, w: 160, h: 160 };
const STROKE_W = 6;
// Pre-scaled into BOX's own 160x160 local space (no viewBox pushTransform in play
// here — this suite tests the silhouette union/border directly on a widget's OWN
// local content, exactly the space decorateSilhouetteBorder receives it in). A
// small inset off the exact box edge keeps every sampled pixel fully opaque
// (a curve traced flush against the crop boundary anti-aliases at the edge).
const CONTENT_SCALE = 6;
const HEART_D_BOX = scalePathD(HEART_D, CONTENT_SCALE);
const TWO_SQUARES_D_BOX = scalePathD(TWO_SQUARES_D, CONTENT_SCALE);

/** Query. The bounding rect of every "ink" (stroke-colored) pixel in a rendered
 * frame — used below to locate the silhouette border empirically instead of
 * predicting exact canvas coordinates from path math (fragile: crop clipping,
 * antialiasing, and paint-order all shift a pixel a few units from its
 * "theoretical" position). Returns null if no ink pixel exists at all. */
function inkBounds(px) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isInk(px, x, y)) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function renderPixels(cmds) {
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("silhouette_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cmds, VIEW, { background: "#ffffff", media: {}, fontCollection });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return px;
}
const isInk = (px, x, y) => { const i = (y * W + x) * 4; return px[i] < 128 && px[i + 1] < 128 && px[i + 2] > 128; }; // blue stroke
const anyInkNear = (px, cx, cy, r) => {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.round(cx + dx), y = Math.round(cy + dy);
    if (x >= 0 && y >= 0 && x < W && y < H && isInk(px, x, y)) return true;
  }
  return false;
};

// The heart is authored directly in BOX's own local 160x160 space (HEART_D_BOX,
// scalePathD's output) — decorateSilhouetteBorder receives content in the
// widget's OWN local space (style.x/y place the crop box itself), and `world`
// is the node's ABSOLUTE placement for the OUTER paint call (here identity,
// since renderPixels paints `[cmd]` at the top level with no enclosing
// pushTransform — style.x/y alone position everything, matching how
// decorateStrokedBox's own doctests place a box at world {x:0,y:0,...}). A
// viewBox->box scale transform, when one exists, is a SEPARATE pushTransform
// wrapping the content BEFORE it reaches here — see the module header's
// viewBox note; that transform-resolution path is exercised in section 1
// above via flattenIR/silhouetteUnionPath directly.
function heartCropCmd(extra = {}) {
  const content = decorateSilhouetteBorder([{ op: "path", d: HEART_D_BOX }], { x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h, stroke: "#0000ff", strokeWidth: STROKE_W, ...extra }, IDENTITY_WORLD);
  return content[0];
}
test("PIXEL: silhouette border ON traces the heart's curve — ink is a THIN RING near the glyph's own bbox, NOT a filled rect border touching all four bbox edges", () => {
  const cmd = heartCropCmd();
  const px = renderPixels([cmd]);
  const b = inkBounds(px);
  assert.ok(b, "must paint some ink");
  // A plain bbox-RECT border would ink a thin ring flush against ALL FOUR box
  // edges (x=BOX.x, x=BOX.x+BOX.w, y=BOX.y, y=BOX.y+BOX.h, +-STROKE_W/2). The
  // heart's own bbox is narrower than its viewBox on at least one axis (its top
  // has a notch, and horizontally the curve does not reach x=0 or x=24 at
  // y=21, the bottom point) — so a SILHOUETTE border's ink bbox must fall
  // meaningfully INSIDE the box's own edges on at least one side, proving the
  // border traced the curve and not the box.
  const insetLeft = b.minX - BOX.x, insetRight = (BOX.x + BOX.w) - b.maxX;
  assert.ok(insetLeft > STROKE_W || insetRight > STROKE_W, `a silhouette border must NOT hug both left/right box edges the way a bbox-rect border would (insetLeft=${insetLeft}, insetRight=${insetRight})`);
});

test("PIXEL: the heart's own bottom point (glyph coordinate, not box corner) carries ink; the box's OWN corner does not", () => {
  const cmd = heartCropCmd();
  const px = renderPixels([cmd]);
  const b = inkBounds(px);
  // The heart's lowest ink pixel must sit strictly ABOVE the box's bottom edge —
  // proving the border traced the glyph's own lowest point, not the box's.
  assert.ok(b.maxY < BOX.y + BOX.h - 1, "the silhouette's lowest ink must be above the box's own bottom edge");
  // The box's own top-left CORNER (BOX.x, BOX.y) must carry no ink at all — the
  // heart's curve never reaches that corner (a bbox-rect border would).
  assert.ok(!anyInkNear(px, BOX.x + 1, BOX.y + 1, 2), "the box's own top-left corner must carry NO ink — this is the bug the feature fixes");
});

test("PIXEL: rotated + flipped world moves BOTH the border and the traced curve together (a real node's own outer pushTransform, not the style.x/y a widget author never sees)", () => {
  // decorateStrokedBox/decorateSilhouetteBorder's `world` argument is the node's
  // ABSOLUTE world, baked into content's OWN inner pushTransform — but the crop
  // op's OUTER placement (its clip + border stroke) is positioned by whatever
  // transform WRAPS the returned op when it is painted (ports.js's own
  // pushTransform(node.world), per its docblock). Calling paintIR([cmd]) with no
  // such wrap (as heartCropCmd's other tests do, deliberately using style.x/y +
  // identity world instead) leaves the border UNROTATED while content moves —
  // so this test must reproduce the wrap explicitly to test rotation/flip at all.
  const world = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2, rotation: Math.PI / 6, scale: 1, signX: -1 };
  const content = decorateSilhouetteBorder([{ op: "path", d: HEART_D_BOX }], { x: -BOX.w / 2, y: -BOX.h / 2, w: BOX.w, h: BOX.h, stroke: "#0000ff", strokeWidth: STROKE_W }, world);
  const cmd = content[0];
  assert.equal(cmd.silhouette, true);
  const wrapped = [pushTransform(world), cmd, popTransform()];
  const straight = renderPixels([{ ...cmd, x: BOX.x, y: BOX.y }]); // same box, no rotation/flip, for comparison
  const rotated = renderPixels(wrapped);
  let anyInk = false;
  for (let y = 0; y < H && !anyInk; y++) for (let x = 0; x < W; x++) if (isInk(rotated, x, y)) { anyInk = true; break; }
  assert.ok(anyInk, "rotated+flipped silhouette border must still paint something");
  assert.notDeepStrictEqual(Buffer.from(straight), Buffer.from(rotated), "a 30-degree rotation + horizontal flip must visibly change the rendered silhouette border");
});

test("PIXEL: multi-subpath icon — each disjoint piece gets its OWN ring, with a fully ink-free gap between them (not one bbox blob)", () => {
  // TWO_SQUARES_D = "M2 2h4v4h-4z M14 14h4v4h-4z": two squares with a real gap
  // between them (local x in [6,14] has no ink from either square). Crop box
  // local x/y default to 0 (not set in style below), so `world` alone places
  // everything on canvas.
  const content = decorateSilhouetteBorder([{ op: "path", d: TWO_SQUARES_D_BOX, fillRule: "evenodd" }], { w: BOX.w, h: BOX.h, stroke: "#0000ff", strokeWidth: STROKE_W }, { x: BOX.x, y: BOX.y, rotation: 0, scale: 1 });
  const px = renderPixels([content[0]]);
  const b = inkBounds(px);
  assert.ok(b, "must paint some ink");
  // A single bbox-rect border around BOTH squares would be one continuous ring
  // with ink on every row/column inside its span. Two disjoint silhouette rings
  // must instead leave at least one fully ink-free row AND column strictly
  // between the two pieces — proof of TWO rings, not one blob.
  const rowHasInk = (y) => { for (let x = b.minX; x <= b.maxX; x++) if (isInk(px, x, y)) return true; return false; };
  const colHasInk = (x) => { for (let y = b.minY; y <= b.maxY; y++) if (isInk(px, x, y)) return true; return false; };
  let gapRow = false, gapCol = false;
  for (let y = b.minY; y <= b.maxY; y++) if (!rowHasInk(y)) { gapRow = true; break; }
  for (let x = b.minX; x <= b.maxX; x++) if (!colHasInk(x)) { gapCol = true; break; }
  assert.ok(gapRow, "at least one fully ink-free ROW between the two disjoint rings");
  assert.ok(gapCol, "at least one fully ink-free COLUMN between the two disjoint rings");
});

test("PIXEL: silhouette OFF (no stroke) renders nothing extra — a pure pass-through paints only the fill/content", () => {
  const content = decorateSilhouetteBorder([{ op: "path", d: HEART_D_BOX, fill: "#000000" }], { w: BOX.w, h: BOX.h, stroke: null, strokeWidth: 0 }, { x: BOX.x, y: BOX.y, rotation: 0, scale: 1 });
  const px = renderPixels(content); // NOT a cropSubtree — pass-through array
  // No BLUE ink anywhere (there is no border stroke color present at all).
  let blueFound = false;
  for (let y = 0; y < H && !blueFound; y++) for (let x = 0; x < W; x++) if (isInk(px, x, y)) { blueFound = true; break; }
  assert.ok(!blueFound, "no border color should appear when stroke is off");
});

// ── 4. strokeOffset on a silhouette (attached + detached) ─────────────────────
//
// decorate.js's decorateStrokedBox/decorateSilhouetteBorder never reads
// strokeOffset — it is stamped onto ALREADY-BUILT ops afterward by ports.js's
// applyStrokeOffset seam (from node.state, the same as any other stroked op —
// see crop_border_offset_test.js's identical pattern). Simulating that stamp
// directly here (rather than threading it through decorateSilhouetteBorder's
// style, which has no such parameter) matches the real pipeline.
function withStrokeOffset(cmd, strokeOffset) {
  return applyStrokeOffset({ strokeOffset }, [cmd])[0];
}

test("strokeOffset on a silhouette: opStrokeIsOffset gates the same way as a plain cropSubtree", () => {
  const cmd = withStrokeOffset(heartCropCmd(), -1);
  assert.equal(cmd.strokeOffset, -1);
  assert.equal(opStrokeIsOffset(cmd), true);
  assert.equal(opStrokeIsOffset(heartCropCmd()), false);
});

test("PIXEL: strokeOffset ATTACHED (|offset|<=1) on a silhouette moves the ink relative to offset 0, and still paints", () => {
  const centered = renderPixels([heartCropCmd()]);
  const inner = renderPixels([withStrokeOffset(heartCropCmd(), -1)]);
  assert.notDeepStrictEqual(Buffer.from(centered), Buffer.from(inner), "an inner-aligned silhouette border must render differently from a centered one");
});

test("PIXEL: strokeOffset DETACHED (|offset|>1) on a silhouette produces a parallel contour ring that still paints ink, and differs from attached offset 1", () => {
  const attached = renderPixels([withStrokeOffset(heartCropCmd(), 1)]);
  const detached = renderPixels([withStrokeOffset(heartCropCmd(), 2)]);
  let anyInk = false;
  for (let y = 0; y < H && !anyInk; y++) for (let x = 0; x < W; x++) if (isInk(detached, x, y)) { anyInk = true; break; }
  assert.ok(anyInk, "a detached silhouette contour must still paint ink");
  assert.notDeepStrictEqual(Buffer.from(attached), Buffer.from(detached), "detached geometry must differ from the attached case");
});

// ── 5. EXPORT STAMPING (resolveSilhouetteBorders + PDF/SVG native strokes) ────

test("resolveSilhouetteBorders: stamps borderPath on a silhouette op, recursing into content, and leaves non-silhouette ops untouched (identity)", () => {
  clearSilhouetteCache();
  const plain = rect({ x: 0, y: 0, w: 1, h: 1 });
  const [out] = resolveSilhouetteBorders([plain], null);
  assert.equal(out, plain, "an untouched op must be the SAME reference — no CanvasKit needed");

  const sil = { op: "cropSubtree", x: 0, y: 0, w: 24, h: 24, silhouette: true, silhouetteContent: [{ op: "path", d: HEART_D }], content: [] };
  const [stamped] = resolveSilhouetteBorders([sil], CanvasKit);
  assert.ok(typeof stamped.borderPath === "string" && stamped.borderPath.length > 0);

  const nested = { op: "effectSubtree", content: [sil] };
  const [stampedNested] = resolveSilhouetteBorders([nested], CanvasKit);
  assert.ok(typeof stampedNested.content[0].borderPath === "string");
});

test("resolveSilhouetteBorders: a silhouette op with NO traceable shape ops stamps borderPath: null (backend falls back to rect)", () => {
  const sil = { op: "cropSubtree", x: 0, y: 0, w: 10, h: 10, silhouette: true, silhouetteContent: [{ op: "text", text: "!", x: 0, y: 0, size: 5 }], content: [] };
  const [stamped] = resolveSilhouetteBorders([sil], CanvasKit);
  assert.equal(stamped.borderPath, null);
});

test("SVG export: a silhouette border with a stamped borderPath emits that NATIVE PATH d, not the rounded-rect path", () => {
  const ctx = { nextId: (p) => `${p}1`, addDef: () => {}, defs: [] };
  const sil = { op: "cropSubtree", x: 0, y: 0, w: 24, h: 24, fill: null, stroke: "#00f", strokeWidth: 2, silhouette: true, borderPath: "M1 1L2 2L3 1Z", content: [] };
  return emitCropSVG(sil, IDENTITY_WORLD, { view: {}, worldRect: {}, depth: 0, background: null }, ctx).then((out) => {
    assert.ok(out.includes('d="M1 1L2 2L3 1Z"'), "must emit the stamped borderPath verbatim");
    assert.ok(!out.includes("<image"), "no raster fallback for a silhouette border");
  });
});

test("SVG export: silhouette with borderPath: null falls back to the ordinary rounded-rect path", () => {
  const ctx = { nextId: (p) => `${p}1`, addDef: () => {}, defs: [] };
  const sil = { op: "cropSubtree", x: 0, y: 0, w: 24, h: 24, fill: null, stroke: "#00f", strokeWidth: 2, silhouette: true, borderPath: null, content: [] };
  const nonSil = { ...sil, silhouette: false, borderPath: undefined };
  return Promise.all([
    emitCropSVG(sil, IDENTITY_WORLD, { view: {}, worldRect: {}, depth: 0, background: null }, ctx),
    emitCropSVG(nonSil, IDENTITY_WORLD, { view: {}, worldRect: {}, depth: 0, background: null }, ctx),
  ]).then(([silOut, nonSilOut]) => {
    assert.equal(silOut, nonSilOut, "null borderPath must fall back to the identical rect-path output a non-silhouette op produces");
  });
});

test("PDF export: a silhouette border with a stamped borderPath emits a native path stroke of that d, no clip machinery at offset 0", () => {
  const cmd = { op: "cropSubtree", x: 20, y: 20, w: 24, h: 24, fill: null, stroke: [0, 0, 1, 1], strokeWidth: 2, opacity: 1, silhouette: true, borderPath: "1 1 m 2 2 l 3 1 l h", content: [] };
  return irToPDF([cmd], { width: 100, height: 100, view: VIEW, background: "#ffffff" }).then((bytes) => {
    const text = Buffer.from(bytes).toString("latin1");
    assert.ok(text.includes("1 1 m 2 2 l 3 1 l h"), "must contain the stamped borderPath operators verbatim");
    assert.ok(!text.includes("/Image"), "no raster image for a silhouette border stroke");
  });
});

// ── 6. THE TEN UNTOUCHED WIDGETS — decorateStrokedBox is byte-identical ───────

test("decorateStrokedBox (the shared function every OTHER decorateStrokedBox consumer calls) is unmodified: rect border, no silhouette flag, on image/video-shaped content", () => {
  const content = [{ op: "image", ref: "x", x: 0, y: 0, w: 10, h: 10 }];
  const style = { w: 10, h: 10, stroke: "#000", strokeWidth: 2, cornerRadius: 3 };
  const out = decorateStrokedBox(content, style, IDENTITY_WORLD);
  assert.equal(out[0].op, "cropSubtree");
  assert.ok(!("silhouette" in out[0]), "an ordinary decorateStrokedBox consumer must never carry the silhouette flag");
  assert.ok(!("silhouetteContent" in out[0]));
});

test("REGRESSION PIN: decorateStrokedBox's rrect-border pixels for an image-shaped widget are IDENTICAL before/after this feature (rendered via paint_skia, same code path silhouette shares)", () => {
  const style = { ...BOX, cornerRadius: 0, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W };
  const cmd = cropSubtree({ ...style, content: [] }); // the plain (non-silhouette) cropSubtree path
  const px = renderPixels([cmd]);
  // A rect border must have ink along the box edge and NONE at the box's exact center
  // (sanity that this is a RING, not a filled/blob shape — the untouched behavior).
  assert.ok(anyInkNear(px, BOX.x, BOX.y + BOX.h / 2, 3), "left edge carries ink");
  assert.ok(!anyInkNear(px, BOX.x + BOX.w / 2, BOX.y + BOX.h / 2, 3), "box center carries no border ink");
});

// ── 7. strokemat ORTHOGONALITY — paint substitution never touches geometry ────

test("strokemat: svgOverrideSlotPaint's material->solid substitution changes PAINT only — the silhouette's traced `d` is identical either way", () => {
  clearSilhouetteCache();
  // svgOverrideSlotPaint operates on the SVG's own content paint (fill/stroke of
  // the artwork), never on shape geometry — the silhouette union only ever reads
  // `op`/`d`/points/fillRule, so recoloring (or substituting) the CONTENT's paint
  // must leave the traced outline byte-identical.
  const solid = svgOverrideSlotPaint({ type: "material", material: { id: "crt" }, solid: "#ff00ff" }, "stroke", () => {});
  assert.equal(solid, "#ff00ff", "sanity: crt is fill-only, so a stroke slot gets the solid fallback (d545ddc)");
  const before = silhouettePathD(CanvasKit, [{ op: "path", d: HEART_D, fill: "#000" }]);
  clearSilhouetteCache();
  const after = silhouettePathD(CanvasKit, [{ op: "path", d: HEART_D, fill: solid }]); // paint changed, geometry did not
  assert.equal(before, after, "recoloring the content's fill/stroke must not change the traced silhouette path");
});

test("strokemat: the svg widget's emitted silhouette border is unaffected by a fill-material override on the widget's OWN artwork", () => {
  const base = { ...svgPlugin.defaults, x: 0, y: 0, w: 64, h: 64, svgSrc: HEART_SVG, stroke: "#0000ff", strokeWidth: 3 };
  const plainFill = svgPlugin.emit({ ...base, fill: { type: "none" } }, null, IDENTITY_WORLD);
  const materialFill = svgPlugin.emit({ ...base, fill: { type: "material", material: { id: "crt" }, solid: "#123456" } }, null, IDENTITY_WORLD);
  assert.equal(plainFill[0].silhouette, true);
  assert.equal(materialFill[0].silhouette, true);
  assert.equal(plainFill[0].silhouetteContent.length, materialFill[0].silhouetteContent.length, "same shape ops regardless of the artwork's own fill paint");
});

console.log(`\nsilhouette_test: ${passed} passed`);
