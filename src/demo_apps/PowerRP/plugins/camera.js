/**
 * THE camera — a bounding box that determines every rendered view: export
 * aspect ratio, per-slide thumbnails, and the presentation viewport (the view
 * fits the camera's bbox, letterboxing the rest). One per document, created
 * with the document, tweened between slides like any other item.
 *
 * Paints ONLY in the editor (env.editorChrome): a dashed cyan bbox — cyan per
 * user spec / the annotator's --a-current precedent. Invisible in exports,
 * presentations, thumbnails, and CLI renders.
 */

import { standardBBoxAnchors } from "../core/derive.js";

// Border color comes from the THEME via env.chromeColor (user rule: hardcoded
// cyan breaks in other themes); this is only the last-resort fallback.
const FALLBACK_CHROME = "#00ffff";

export const cameraPlugin = {
  type: "camera",
  title: "Camera",
  // purgeable:false — the camera is mandatory: exactly one, cannot be deleted
  // or purged (capability-based, not type special-cased; manifest rule).
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, purgeable: false },
  defaults: {
    type: "camera", x: 0, y: 0, w: 1280, h: 720, z: 1000, rotation: 0, scale: 1,
    background: "#ffffff", // the view's background comes FROM the camera
  },
  inspector: [
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "w", label: "Width", kind: "number" },
    { key: "h", label: "Height", kind: "number" },
    { key: "background", label: "Background", kind: "color" },
  ],
  paint(ctx, s, env) {
    // Editor-only, and only while hovered or selected (user rule) — the
    // camera frames content invisibly the rest of the time. No text label.
    if (!env.editorChrome) return;
    const id = env.node.itemId;
    if (env.hoveredId !== id && env.selectedId !== id) return;
    ctx.strokeStyle = env.chromeColor ?? FALLBACK_CHROME;
    ctx.lineWidth = 1.5 / env.view.zoom; // screen-constant regardless of zoom
    ctx.setLineDash([6 / env.view.zoom, 4 / env.view.zoom]);
    ctx.strokeRect(0, 0, s.w, s.h);
    ctx.setLineDash([]);
  },
  // Hit only near the border, not the interior — the camera frames content;
  // clicks inside should select the content, not the camera. `tol` is the
  // editor's world-unit grab tolerance (constant screen-space feel).
  hitTest(s, lx, ly, tol = 6) {
    const m = tol;
    const inOuter = lx >= -m && lx <= s.w + m && ly >= -m && ly <= s.h + m;
    const inInner = lx >= m && lx <= s.w - m && ly >= m && ly <= s.h - m;
    return inOuter && !inInner;
  },
  anchors: standardBBoxAnchors,
};
