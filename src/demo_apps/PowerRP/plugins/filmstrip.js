/**
 * Filmstrip widget — a strip of N frames sampled evenly (first→last) from a
 * project VIDEO asset and laid out left-to-right inside the widget's bbox
 * (manifest Round 12 "FILMSTRIP widget"; Figures precedent
 * refs/Figures/film_strip/film_strip.py — frames resized to a common cell and
 * joined left-to-right with a thin separator).
 *
 * ── THE ONE CONTROL ──────────────────────────────────────────────────────────
 * `frames` (a count) is the SOLE authored control (manifest: "for now we'll
 * just have one particular control, which is the number"; "Simplicity here is
 * good"). No per-frame styling, no perforation dots, no vertical mode — those
 * are Figures bells/whistles deferred by the ruling.
 *
 * ── WHERE THE FRAMES COME FROM (the state→URL mapping) ────────────────────────
 * Frame EXTRACTION lives on the BACKEND (manifest: "the backend is probably a
 * better place to do that"). The server's GET /api/frames/<project>/<video>/<N>/
 * extracts N evenly-spread frames, caches them under assets/frames/<video>/<N>/,
 * and returns their served URLs. The widget stores those URLs in
 * `state.frameUrls` (an app-side effect requests them whenever `src`/`frames`
 * changes — see the projectApi spec in the W2c report; that wiring is Opus14's
 * AssetExplorer/projectApi fence, NOT this plugin's job). emit() is then a PURE
 * function of state: it maps the stored URLs to image ops. Each URL loads
 * through the SAME image registry as a still image (gpu/image_registry.js
 * resolves data: URIs and http/relative URLs uniformly via fetch), so a CLI
 * render against a RUNNING server resolves the URLs with zero new plumbing.
 *
 * ── OFFLINE BEHAVIOR (no server; the no-silent-fallback rule) ─────────────────
 * With no server, `frameUrls` is empty (nothing populated it). emit() then
 * console.errors ONCE (core/report.js throttle) and draws NOTHING — an
 * unresolved filmstrip is loudly reported, never a silent placeholder and never
 * a silent success. (A parity/CLI harness that wants an offline strip populates
 * frameUrls with data: URIs directly — see the parity scene.)
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — identical to the
 * image widget, so it composites under magnifiers/blur and culls for free
 * (core/view.js canSkipNode), and sceneIR wraps its LOCAL-space image ops in
 * the node world transform (no world-space special case).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import * as T from "../core/transform.js";
import { image } from "../render_gpu/ir.js";
import { reportOnce } from "../core/report.js";

/** Gap between adjacent frames, as a FRACTION of a cell's width. The Figures
 * filmstrip joins frames with a thin separator + transparent padding
 * (film_strip.py: pad height 20 on a ~480–720px cell ≈ 3–4%); 0.04 is that
 * proportion, resolution-independent so it holds at any bbox size. */
const FRAME_GAP_FRAC = 0.04;

/**
 * Pure function. Left-to-right cell layout for `n` frames across width `w`,
 * height `h`, with FRAME_GAP_FRAC-of-a-cell gaps between them. Returns one
 * {x, w} rect per frame (y is 0, height is h). n gaps → n-1 gaps total; the
 * cell width solves w = n*cell + (n-1)*gap with gap = FRAME_GAP_FRAC*cell.
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

export const filmstripPlugin = {
  type: "filmstrip",
  title: "Filmstrip",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "filmstrip", x: 100, y: 100, w: 480, h: 90, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // `src` = the video ASSET FILENAME (resolved against the project's assets/
    // by the server). `frames` = THE one control. `frameUrls` = the served
    // frame URLs (or data: URIs) an app effect fills from the frames endpoint;
    // emit() reads this. Empty by default → a fresh widget draws nothing (loud)
    // until src+frames resolve, exactly like a not-yet-sourced image.
    src: "", frames: 6, frameUrls: [], opacity: 1,
  },
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees", category: "positioning" }, // core stores radians; field shows degrees (round-10 ruling)
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number", category: "positioning" }, // world pivot; default self.anchors.center
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    // The video asset filename; a generic string row today — the asset-picker
    // control lands with the asset explorer (Opus14).
    { key: "src", label: "Video", kind: "text", category: "formatting" },
    // THE one control (manifest: "just the number"). >=1; app clamps to the
    // video's frame count server-side.
    { key: "frames", label: "Frames", kind: "number", min: 1, category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
  ],
  /**
   * Near-pure function (console.errors ONCE when the strip is unresolved;
   * otherwise pure). State → display-list commands (local space): the resolved
   * frame URLs laid out left-to-right within the bbox as image ops. Every URL
   * loads through the shared image registry (data: URIs and server URLs alike).
   *
   * No resolved frames (empty frameUrls) → REPORT ONCE and draw nothing (the
   * no-silent-fallback rule): an unresolved filmstrip is a loud console.error,
   * never a silent placeholder. A `src` set but frameUrls still empty is the
   * normal in-flight / no-server state — the report says which.
   */
  emit(s) {
    const urls = Array.isArray(s.frameUrls) ? s.frameUrls : [];
    if (urls.length === 0) {
      // Distinguish "nothing configured" from "configured but unresolved" so
      // the console message points at the real cause (missing server vs empty
      // widget). Keyed on src so each distinct source reports at most once.
      const why = s.src
        ? `no frames resolved for video "${s.src}" — is the project server running? (GET /api/frames/…). Filmstrip draws nothing.`
        : `filmstrip has no video source (src is empty). Draws nothing.`;
      reportOnce(`PowerRP filmstrip: ${why}`);
      return [];
    }
    const opacity = s.opacity ?? 1;
    const cells = filmstripLayout(urls.length, s.w ?? 0, s.h ?? 0);
    return urls.map((ref, i) =>
      image({ ref, x: cells[i].x, y: 0, w: cells[i].w, h: cells[i].h, opacity }));
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-filmstrip", title: "Add Filmstrip", icon: "mdi:filmstrip", run: (app) => app.addItem(filmstripPlugin.defaults) },
  ],
};
