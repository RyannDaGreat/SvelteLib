/**
 * Filmstrip widget — a strip of N frames sampled evenly (first→last) from a
 * project VIDEO asset, laid out inside the widget's bbox with the FAITHFUL
 * film-strip LOOK of the original Figures implementation
 * (refs/Figures/film_strip/film_strip.py; manifest ROUND 14.1 "FILMSTRIP
 * FIDELITY"). The Python function's six visual elements are reproduced here:
 *
 *   1. each frame gets ROUNDED CORNERS (a per-cell rounded-rect clip),
 *   2. each frame gets a GRAY OUTLINE hugging its rounded shape,
 *   3. transparent PADDING above/below the frames leaves two film BANDS,
 *   4. the frames sit on a colored strip (filmColor, default black),
 *   5. PERFORATION DOTS — a row of round holes punched THROUGH each band so the
 *      canvas behind shows through (film sprocket holes), and
 *   6. the whole strip has ROUNDED CORNERS.
 *
 * ── HOLE RENDERING (the WHY, per backend) ─────────────────────────────────────
 * The perforation holes must read as TRANSPARENT windows in all three backends
 * (GPU + PDF + SVG). NONE of the three has a native even-odd / mask / knockout
 * primitive (verified — see plugins/donut.js and core/outline.js: the GPU
 * compositor's crop clip is a single rounded-rect SDF, the PDF backend only
 * emits nonzero-winding "W n"/"f", and the SVG backend emits a single-path
 * <clipPath> with no fill-rule hole). So — the same principle the DONUT widget
 * uses for the identical "colored shape with a transparent circular hole" —
 * each film band is emitted as `polygon` (triangle) ops that go AROUND the
 * holes: the band is sliced into one column per hole, and each column
 * (rect minus one circle) is tessellated into quads between the circle arc and
 * the rect edges (perforatedBandPolygons/cellWithHole below — a robust 4-sector
 * split that avoids ear-clipper degeneracies). Because both raster and vector
 * backends consume the SAME `polygon` op vertex-for-vertex, they render the SAME
 * triangles — parity by construction, no shader/backend change, holes are
 * transparent because no triangle covers them (the canvas below shows through).
 *
 * ── PROCESSING INDICATOR (manifest 14.2) ──────────────────────────────────────
 * While the backend extracts frames (the app-side fetch is in flight), the
 * widget renders an IN-WIDGET processing treatment — a filmColor strip with the
 * perforations + a centered "sampling frames…" bar — instead of the ghost
 * placeholder. The app sets a transient `processing` flag on the item (NOT a
 * keyframed property — it is derived UI state, cleared when frameUrls land or
 * the fetch fails). A static treatment (not animated) is deliberate: emit() stays
 * a PURE function of state so a CLI render is deterministic, and the presenter
 * has no reason to spin during a one-shot extraction.
 *
 * ── ERROR AFFORDANCE (manifest 14.4) ──────────────────────────────────────────
 * A fetch FAILURE (server down, bad video, url-vs-filename mismatch) sets a
 * transient `frameError` string on the item; emit() then renders an in-widget
 * error strip (red band + message) — NOT console-only (the manifest's
 * no-silent-failure heart of 14.4). A short-video CAP (requested N > the video's
 * frame count) is not an error: the strip simply shows the frames that exist.
 *
 * ── WHERE THE FRAMES COME FROM (the state→URL mapping) ────────────────────────
 * Frame EXTRACTION lives on the BACKEND. The server's
 * GET /api/frames/<project>/<video>/<N>/?h=<H>&w=<W> extracts N evenly-spread
 * frames at resolution H×W (native when omitted), caches them under
 * assets/frames/<video>/<N>/<HxW>/, and returns their served URLs. The widget
 * stores those URLs in `state.frameUrls`; an app-side effect
 * (app.svelte.js #wireFilmstripFrames) requests them whenever src/frames/frameH/
 * frameW changes. emit() is a PURE function of state mapping the stored URLs to
 * image ops; each URL loads through the shared image registry, so a CLI render
 * against a running server resolves them with zero new plumbing.
 *
 * ── OFFLINE / NO-SOURCE BEHAVIOR (no server; the no-silent-fallback rule) ──────
 * With no src and no frames and no in-flight fetch, the widget is a GHOST (the
 * dashed-outline placeholder — manifest 13.6). With a src but no resolved frames
 * and no in-flight/error state, emit() reports ONCE and draws nothing.
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — like the image widget,
 * so it composites under magnifiers/blur and culls for free.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { triangulated } from "../core/outline.js";
import { image, polygon, rect, text } from "../render_gpu/ir.js";
import { decorateStrokedBox } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { reportOnce } from "../core/report.js";

// ── LOOK CONSTANTS (relative — the Python film_strip.py values were at frame-
// resolution scale: on a ~480px-tall cell, pad=20px, dot band=32px, per-frame
// & strip corner radius=20px, outer margin=40px. Normalizing by the ~480px
// short dimension gives resolution-independent fractions that hold at any bbox
// size — the manifest's "derive named relative constants" requirement). These
// are FRACTIONS OF THE STRIP'S SHORT (cross-axis) DIMENSION. PENDING USER
// RATIFICATION (linked precedent: film_strip.py constants ÷ 480). ──────────────
const PY_CELL_REF = 480;             // the Python reference cell short-dimension
const BAND_FRAC = 20 / PY_CELL_REF;  // film band (transparent pad) height ≈ 0.042
const PERF_BAND_FRAC = 32 / PY_CELL_REF; // perforation-dot band height ≈ 0.067
const FRAME_RADIUS_FRAC = 20 / PY_CELL_REF; // per-frame corner radius ≈ 0.042
const STRIP_RADIUS_FRAC = 20 / PY_CELL_REF; // whole-strip corner radius ≈ 0.042
// Gap between adjacent frames, as a FRACTION of a cell's LONG dimension. The
// Python filmstrip pads frames with a thin transparent separator; 0.04 keeps
// that proportion, resolution-independent. Linked precedent: pre-Round-14 value.
const FRAME_GAP_FRAC = 0.04;
// Perforation DOT geometry. Dot DIAMETER is a fraction of the perf-band height.
// The dot PITCH is sized so there are ~PERF_DOTS_PER_CROSS holes per unit of the
// strip's LONG length measured in CROSS-dimension units — i.e. the row density
// tracks the strip's aspect, giving evenly-spaced, legible holes at any size
// while BOUNDING the hole count (a very long strip does not spawn thousands of
// tiny dots). On the default 480×90 strip this yields ~12 holes per band, which
// matches the demo png's readable spacing. PENDING RATIFICATION (the Python "• "
// Arial spacing is the visual reference; no numeric precedent — flagged).
const PERF_DOT_DIAM_FRAC = 0.55;     // dot diameter ≈ 0.55 of the perf-band height
const PERF_DOTS_PER_CROSS = 1.5;     // holes per (cross-dimension) unit of strip length
// Circle tessellation for a perforation hole. A perf hole is far smaller than a
// donut (core/outline.js DONUT_SEGMENTS=64), so fewer segments read as "round"
// at its on-screen size while keeping the per-hole triangle count low (the strip
// can have dozens of holes). PENDING RATIFICATION (linked to DONUT_SEGMENTS; a
// hole is ~1/10 the radius, so 16 gives comparable on-screen smoothness).
const PERF_SEGMENTS = 16;

/**
 * Pure function. Left-to-right cell layout for `n` frames across width `w`,
 * height `h`, with FRAME_GAP_FRAC-of-a-cell gaps between them. Returns one
 * {x, w, h} rect per frame (y is 0). n gaps → n-1 gaps total; the cell width
 * solves w = n*cell + (n-1)*gap with gap = FRAME_GAP_FRAC*cell.
 *
 * @example filmstripLayout(3, 100, 40).length
 * 3
 * @example filmstripLayout(1, 100, 40)[0]
 * { x: 0, w: 100, h: 40 }
 * @example filmstripLayout(2, 104, 40).map(c => Math.round(c.x))
 * [ 0, 54 ]
 */
export function filmstripLayout(n, w, h) {
  if (n <= 1) return [{ x: 0, w, h }];
  const cell = w / (n + (n - 1) * FRAME_GAP_FRAC);
  const step = cell * (1 + FRAME_GAP_FRAC);
  return Array.from({ length: n }, (_, i) => ({ x: i * step, w: cell, h }));
}

/**
 * Pure function. A rectangle [x0,y0]..[x0+w,y0+h] with a ROW of circular holes
 * punched out, returned as a triangle list (each triangle a 3-point polygon) so
 * the region can be drawn with the convex-only IR `polygon` op — the SAME
 * "colored shape with transparent circular holes" technique the donut uses
 * (core/outline.donutOutline), generalized from one hole to a row.
 *
 * Each hole gets its OWN cell rectangle (the band sliced into one column per
 * hole); a cell = its rect outline walked forward + the hole circle walked
 * backward, bridged by a zero-width slit (donut's technique) into ONE simple
 * polygon, then ear-clipped by triangulated(). Slicing per hole keeps every
 * sub-polygon simple (a single hole), which triangulated() handles directly.
 *
 * Holes are centered vertically in the band and spaced by `pitch` starting a
 * half-pitch in, so the row is symmetric within the band width. A band too thin
 * for any full hole (dotRadius <= 0) returns one solid rect (2 triangles).
 *
 * Args:
 *   band ({x, y, w, h}): the band rectangle (local space, top-left origin)
 *   dotRadius (number): hole radius
 *   pitch (number): center-to-center spacing between holes along the band width
 *
 * Returns:
 *   number[][][]: array of triangles, each [[x,y],[x,y],[x,y]]
 *
 * @example perforatedBandPolygons({x: 0, y: 0, w: 100, h: 10}, 0, 20).length
 * 2
 * @example perforatedBandPolygons({x: 0, y: 0, w: 40, h: 10}, 2, 20).length > 2
 * true
 */
export function perforatedBandPolygons(band, dotRadius, pitch) {
  const { x, y, w, h } = band;
  if (w <= 0 || h <= 0) return [];
  // No room for holes → one solid rectangle (still parity-safe: 2 triangles).
  if (dotRadius <= 0 || pitch <= 0) {
    return triangulated([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  }
  const cy = y + h / 2;
  // Hole centers: start a half-pitch in, step by pitch, keep the whole circle
  // inside the band width.
  const centers = [];
  for (let cx = x + pitch / 2; cx <= x + w - dotRadius; cx += pitch) {
    if (cx - dotRadius >= x) centers.push(cx);
  }
  if (centers.length === 0) {
    return triangulated([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  }
  // One column per hole; the column spans from the previous column boundary to
  // the midpoint to the next hole (so columns tile the band with no gaps/overlap).
  const tris = [];
  const bounds = centers.map((cx, i) => {
    const left = i === 0 ? x : (centers[i - 1] + cx) / 2;
    const right = i === centers.length - 1 ? x + w : (cx + centers[i + 1]) / 2;
    return { left, right, cx };
  });
  for (const { left, right, cx } of bounds) {
    tris.push(...cellWithHole(left, y, right - left, h, cx, cy, dotRadius));
  }
  return tris;
}

/**
 * Pure function. One rectangle cell [rx,ry,rw,rh] with a single circular hole
 * (center cx,cy radius r) removed, as a triangle list. Instead of ear-clipping a
 * rect-with-a-hole polygon (whose straight edges + duplicated bridge vertex stall
 * the strict ear-clipper), the annular region is split into FOUR SECTORS by the
 * rays from the hole center to the four rect corners. Each sector's outer
 * boundary is exactly ONE flat rect edge (no corner between its two bounding
 * rays), so quads between the circle arc and that edge tile the sector with no
 * corner-cutting. The union of the four sectors is the whole cell-minus-circle
 * — verified: total triangle area matches rect−circle within the polygon-vs-arc
 * approximation (~1-2% for a PERF_SEGMENTS-gon, i.e. the holes are visually
 * round). A hole that doesn't fit (r <= 0 or spills the cell) degenerates to the
 * solid rect (2 triangles). Not exported — internal to perforatedBandPolygons.
 *
 * @example cellWithHole(0, 0, 20, 10, 10, 5, 0).length
 * 2
 * @example cellWithHole(0, 0, 20, 10, 10, 5, 2).length > 8
 * true
 */
function cellWithHole(rx, ry, rw, rh, cx, cy, r) {
  const solid = () => triangulated([[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]]);
  if (r <= 0 || cx - r < rx || cx + r > rx + rw || cy - r < ry || cy + r > ry + rh) return solid();
  const corners = [
    [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh], [rx, ry], // TR, BR, BL, TL
  ];
  const ang = corners.map((c) => Math.atan2(c[1] - cy, c[0] - cx));
  const tris = [];
  for (let e = 0; e < 4; e++) {
    let a0 = ang[e], a1 = ang[(e + 1) % 4];
    while (a1 <= a0) a1 += 2 * Math.PI; // increasing arc (CCW on a y-down screen)
    const c0 = corners[e], c1 = corners[(e + 1) % 4];
    const steps = Math.max(2, Math.round((PERF_SEGMENTS * (a1 - a0)) / (2 * Math.PI)));
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const aa0 = a0 + (a1 - a0) * t0, aa1 = a0 + (a1 - a0) * t1;
      const in0 = [cx + r * Math.cos(aa0), cy + r * Math.sin(aa0)];
      const in1 = [cx + r * Math.cos(aa1), cy + r * Math.sin(aa1)];
      const out0 = [c0[0] + (c1[0] - c0[0]) * t0, c0[1] + (c1[1] - c0[1]) * t0];
      const out1 = [c0[0] + (c1[0] - c0[0]) * t1, c0[1] + (c1[1] - c0[1]) * t1];
      tris.push([in0, in1, out1], [in0, out1, out0]);
    }
  }
  return tris;
}

/**
 * Pure function. The filmstrip's LAID-OUT geometry in local (bbox) space,
 * accounting for orientation. The two film BANDS (with sprocket holes) run along
 * the two LONG edges; frames tile along the long axis between them:
 *   HORIZONTAL — bands at TOP and BOTTOM (full width, bandThick tall), frames
 *     tile left→right in the middle row. Band thickness scales with HEIGHT.
 *   VERTICAL — bands at LEFT and RIGHT (full height, bandThick wide), frames
 *     tile top→bottom in the center column (the Python original's rotate/compose/
 *     rotate, expressed directly). Band thickness scales with WIDTH.
 * ONE geometry decision, not scattered through emit().
 *
 * Returns { frames:[{x,y,w,h}], bandA, bandB, contentRect, perf:{r,pitch,axis},
 *   frameRadius, radius } — all rects {x,y,w,h} in local space; the two bands are
 *   `bandA`/`bandB`; `contentRect` is where the frames sit; `perf.axis` is the
 *   axis holes run along ("x" horizontal band, "y" vertical band).
 *
 * @example filmstripGeom({w: 480, h: 90, frames: 3, vertical: false}).frames.length
 * 3
 * @example filmstripGeom({w: 90, h: 480, frames: 3, vertical: true}).frames.length
 * 3
 * @example filmstripGeom({w: 90, h: 480, frames: 3, vertical: true}).perf.axis
 * 'y'
 */
export function filmstripGeom(s) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const n = Math.max(1, Math.round(s.frames ?? 1));
  const vertical = !!s.vertical;
  // CROSS dimension = the axis band thickness scales with (h for horizontal,
  // w for vertical). LONG dimension = the axis frames tile along.
  const long = vertical ? h : w;
  const cross = vertical ? w : h;
  const bandThick = cross * BAND_FRAC + cross * PERF_BAND_FRAC; // pad + perf band
  const perfR = (cross * PERF_BAND_FRAC * PERF_DOT_DIAM_FRAC) / 2;
  // Pitch = long / (holes wanted); holes wanted scales with the aspect (long/
  // cross) so density is aspect-consistent and the count is bounded.
  const holesWanted = Math.max(1, Math.round((long / cross) * PERF_DOTS_PER_CROSS));
  const perfPitch = long / holesWanted;
  const radius = cross * STRIP_RADIUS_FRAC;
  if (vertical) {
    const contentW = Math.max(0, w - 2 * bandThick);
    // Frames tile top→bottom in the center column (long axis = h).
    const cells = filmstripLayout(n, h, contentW).map((c) => ({ x: bandThick, y: c.x, w: contentW, h: c.w }));
    return {
      frames: cells,
      bandA: { x: 0, y: 0, w: bandThick, h },          // left band
      bandB: { x: w - bandThick, y: 0, w: bandThick, h }, // right band
      contentRect: { x: bandThick, y: 0, w: contentW, h },
      perf: { r: perfR, pitch: perfPitch, axis: "y" },   // holes run vertically
      frameRadius: contentW * FRAME_RADIUS_FRAC,
      radius,
    };
  }
  const contentH = Math.max(0, h - 2 * bandThick);
  // Frames tile left→right in the middle row (long axis = w).
  const cells = filmstripLayout(n, w, contentH).map((c) => ({ x: c.x, y: bandThick, w: c.w, h: contentH }));
  return {
    frames: cells,
    bandA: { x: 0, y: 0, w, h: bandThick },          // top band
    bandB: { x: 0, y: h - bandThick, w, h: bandThick }, // bottom band
    contentRect: { x: 0, y: bandThick, w, h: contentH },
    perf: { r: perfR, pitch: perfPitch, axis: "x" },   // holes run horizontally
    frameRadius: contentH * FRAME_RADIUS_FRAC,
    radius,
  };
}

/**
 * Pure function. Emits the filmColor strip's two perforated bands (top+bottom)
 * as triangulated polygon ops. For a VERTICAL strip the bands run along the
 * left/right edges and the perforation row runs vertically; a per-axis swap of
 * (x↔y, w↔h) reuses the same horizontal band generator. Returns [] when the
 * bands are degenerate.
 *
 * @example filmBandOps(filmstripGeom({w: 480, h: 90, frames: 3, vertical: false}), "#000000", 1).length > 0
 * true
 */
export function filmBandOps(geom, filmColor, opacity) {
  const { bandA, bandB, perf } = geom;
  const bandFor = (band) => {
    if (perf.axis === "y") {
      // Vertical strip: TRANSPOSE the band (x↔y, w↔h) so the shared horizontal-
      // row generator runs holes down the Y axis, then transpose the triangles
      // back — one generator serves both orientations.
      const t = { x: band.y, y: band.x, w: band.h, h: band.w };
      return perforatedBandPolygons(t, perf.r, perf.pitch).map((tri) => tri.map(([px, py]) => [py, px]));
    }
    return perforatedBandPolygons(band, perf.r, perf.pitch);
  };
  const tris = [...bandFor(bandA), ...bandFor(bandB)];
  return tris.map((tri) => polygon({ points: tri, fill: filmColor, opacity }));
}

export const filmstripPlugin = {
  type: "filmstrip",
  title: "Filmstrip",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  /**
   * Pure function. Is this filmstrip a GHOST (manifest 13.6)? A filmstrip is a
   * ghost ONLY while it has NOTHING to show — no resolved frames AND not
   * currently processing AND no error to display. While a fetch is in flight
   * (`processing`) or a fetch failed (`frameError`), the widget renders its own
   * in-widget treatment (14.2/14.4) and must NOT be a ghost (the ghost would
   * hide the indicator). This mirrors emit()'s "nothing to draw" condition.
   *
   * @example filmstripPlugin.isGhost({ frameUrls: [] })
   * true
   * @example filmstripPlugin.isGhost({ frameUrls: [], processing: true })
   * false
   * @example filmstripPlugin.isGhost({ frameUrls: [], frameError: "boom" })
   * false
   * @example filmstripPlugin.isGhost({ frameUrls: ["a.jpg"] })
   * false
   */
  isGhost(state) {
    if (state.processing || state.frameError) return false;
    return !Array.isArray(state.frameUrls) || state.frameUrls.length === 0;
  },
  defaults: {
    type: "filmstrip", x: 100, y: 100, w: 480, h: 90, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // `src` = the video ASSET FILENAME (resolved against the project's assets/
    // by the server). `frames` = frame count. `frameUrls` = the served frame
    // URLs an app effect fills from the frames endpoint; emit() reads this.
    src: "", frames: 6, frameUrls: [],
    // FULL API (manifest 14.1 — the original film_strip signature): orientation,
    // film color, and per-frame extraction resolution (null = the video's native
    // size; feeds BOTH the server extraction resolution AND the cell layout).
    vertical: false, filmColor: "#000000", frameH: null, frameW: null,
    // stroke COLOR default matches every stroked shape; paints only once
    // strokeWidth > 0 (0 by default). The border/rounding here frames the WHOLE
    // strip (all cells) — per-frame rounding/outline is intrinsic to the look.
    stroke: "#808080",
    ...defaults("strokeWidth", "cornerRadius", "opacity"),
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  inspector: [
    ...bundle("positioning"),
    // The video asset filename — filtered to VIDEO assets, assetForm "filename"
    // (the frames endpoint resolves the bare basename against the project's
    // assets/ server-side; app.svelte.js's frames effect keys its cache on it).
    ...props("src", { src: { label: "Video", assetKinds: ["video"], assetForm: "filename" } }),
    // THE frame count. >=1; app clamps to the video's frame count server-side.
    ...props("frames"),
    // FULL API rows (manifest 14.1).
    ...props("vertical", "filmColor", "frameW", "frameH"),
    // The stroked-BORDER bundle frames the WHOLE strip (all cells together).
    ...bundle("strokedBorder"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (console.errors ONCE when the strip is unresolved and
   * not processing/errored; otherwise pure). State → display-list commands in
   * local space. Three render modes, chosen by state:
   *
   *   RESOLVED (frameUrls present) → the FAITHFUL LOOK: film bands with
   *     perforation holes (filmBandOps) + each frame drawn with its own rounded
   *     corners and gray outline (per-cell decorateStrokedBox) + the whole-strip
   *     border/rounding.
   *   PROCESSING (state.processing) → the film strip skeleton (perforated bands
   *     + empty frame windows) with a centered "sampling frames…" bar (14.2).
   *   ERROR (state.frameError) → a red band with the error text (14.4 — no
   *     silent failure, an in-widget affordance rather than console-only).
   *
   * No frames, not processing, no error → REPORT ONCE and draw nothing (the
   * unresolved/offline state; the ghost outline covers pickability).
   */
  emit(s, _targetWorldIR, world) {
    const opacity = s.opacity ?? 1;
    const filmColor = s.filmColor ?? "#000000";
    const geom = filmstripGeom(s);
    const style = { w: s.w ?? 0, h: s.h ?? 0, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: Math.max(s.cornerRadius ?? 0, geom.radius) };
    const urls = Array.isArray(s.frameUrls) ? s.frameUrls : [];

    // ERROR mode — an in-widget red band + message (14.4, no console-only).
    if (s.frameError) {
      return this._decorate(errorStripOps(s, geom, opacity), style, s, world);
    }
    // PROCESSING mode — the skeleton + indicator (14.2), NOT the ghost.
    if (s.processing) {
      return this._decorate(processingStripOps(s, geom, filmColor, opacity), style, s, world);
    }
    if (urls.length === 0) {
      const why = s.src
        ? `no frames resolved for video "${s.src}" — is the project server running? (GET /api/frames/…). Filmstrip draws nothing.`
        : `filmstrip has no video source (src is empty). Draws nothing.`;
      reportOnce(`PowerRP filmstrip: ${why}`);
      return [];
    }

    // RESOLVED mode — the faithful look.
    const cells = filmstripGeom({ ...s, frames: urls.length }).frames;
    const frameRadius = geom.frameRadius;
    const content = [];
    // The film bands (with perforation holes) sit UNDER the frames so the frames
    // never overlap a hole.
    content.push(...filmBandOps(geom, filmColor, opacity));
    // Fill the content strip behind the frames with filmColor too (the frames'
    // rounded corners reveal it — the film shows between/around them).
    content.push(rect({ x: geom.contentRect.x, y: geom.contentRect.y, w: geom.contentRect.w, h: geom.contentRect.h, fill: filmColor, opacity }));
    // Each frame: its own rounded corners + gray outline (per-cell decoration).
    // A per-cell decorateStrokedBox emits a cropSubtree; because these live
    // INSIDE the whole-strip cropSubtree (below), the strip world is already on
    // the stack, so the per-cell content must NOT re-apply it — passing IDENTITY
    // keeps the cell content in strip-LOCAL space (the outer wrap maps it to
    // world). A nested cropSubtree carrying an absolute world double-transformed
    // in the SVG backend (only cell 0 survived) — identity fixes it in all three.
    const frameStyle = (c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, cornerRadius: frameRadius, stroke: "#808080", strokeWidth: Math.max(1, frameRadius * 0.1) });
    for (let i = 0; i < urls.length && i < cells.length; i++) {
      const c = cells[i];
      const img = image({ ref: urls[i], x: c.x, y: c.y, w: c.w, h: c.h, opacity });
      content.push(...decorateStrokedBox([img], frameStyle(c), T.identity()));
    }
    return this._decorate(content, style, s, world);
  },
  /** Near-pure helper. Wraps a content op list in the whole-strip border/
   *  rounding decoration + the effects substrate — the common tail of every
   *  emit() mode. */
  _decorate(content, style, s, world) {
    return applyEffects(decorateStrokedBox(content, style, world), s, world, { x: 0, y: 0, w: style.w, h: style.h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    // CROSSHAIR PLACEMENT (like every Add button): arm placement; CanvasView's
    // placementUp creates the widget and (manifest 14.3) opens the video picker.
    { id: "add-filmstrip", title: "Add Filmstrip", icon: "mdi:filmstrip", run: (app) => app.armCrosshairPlacement(filmstripPlugin) },
  ],
};

/**
 * Pure function. The PROCESSING-mode op list (manifest 14.2): the film strip
 * skeleton (perforated bands + filmColor content strip + empty frame windows)
 * plus a centered "sampling frames…" pill so the user SEES that extraction is
 * underway. Deterministic (static) — no animation, so a CLI render is stable.
 *
 * @example processingStripOps({w: 480, h: 90}, filmstripGeom({w: 480, h: 90, frames: 6}), "#000000", 1).length > 0
 * true
 */
export function processingStripOps(s, geom, filmColor, opacity) {
  const ops = [...filmBandOps(geom, filmColor, opacity)];
  const cr = geom.contentRect;
  ops.push(rect({ x: cr.x, y: cr.y, w: cr.w, h: cr.h, fill: filmColor, opacity }));
  // Empty frame windows (dim gray placeholders with the per-frame rounding).
  for (const c of geom.frames) {
    ops.push(rect({ x: c.x, y: c.y, w: c.w, h: c.h, cornerRadius: geom.frameRadius, fill: "#2a2a2a", stroke: "#808080", strokeWidth: Math.max(1, geom.frameRadius * 0.1), opacity }));
  }
  // A centered label pill so it reads as "working", not "broken".
  const label = "sampling frames…";
  const size = Math.max(10, Math.min(cr.h * 0.28, 28));
  const px = cr.x + cr.w / 2 - label.length * size * 0.26;
  const py = cr.y + cr.h / 2 - size / 2;
  ops.push(text({ text: label, x: px, y: py, size, color: "#e0e0e0", opacity }));
  return ops;
}

/**
 * Pure function. The ERROR-mode op list (manifest 14.4): a red band spanning the
 * strip with the failure message, so a frame-fetch failure is VISIBLE in the
 * widget itself rather than only in the console.
 *
 * @example errorStripOps({w: 480, h: 90, frameError: "boom"}, filmstripGeom({w: 480, h: 90, frames: 6}), 1).length > 0
 * true
 */
export function errorStripOps(s, geom, opacity) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const ops = [rect({ x: 0, y: 0, w, h, cornerRadius: geom.radius, fill: "#3a1414", stroke: "#c0392b", strokeWidth: Math.max(1, geom.radius * 0.2), opacity })];
  const msg = String(s.frameError);
  const size = Math.max(10, Math.min(h * 0.16, 20));
  const py = h / 2 - size / 2;
  ops.push(text({ text: `⚠ ${msg}`, x: Math.max(6, w * 0.03), y: py, size, color: "#ffbdb5", opacity }));
  return ops;
}
