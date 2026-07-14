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

const ACTIVE_CAMERA_COLOR = "#00ffff"; // user spec: active camera marked cyan

export const cameraPlugin = {
  type: "camera",
  title: "Camera",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
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
    if (!env.editorChrome) return;
    // Screen-constant stroke/dash regardless of canvas zoom.
    const px = 1.5 / env.view.zoom;
    ctx.strokeStyle = ACTIVE_CAMERA_COLOR;
    ctx.lineWidth = px;
    ctx.setLineDash([6 / env.view.zoom, 4 / env.view.zoom]);
    ctx.strokeRect(0, 0, s.w, s.h);
    ctx.setLineDash([]);
    ctx.font = `${12 / env.view.zoom}px system-ui, sans-serif`;
    ctx.fillStyle = ACTIVE_CAMERA_COLOR;
    ctx.fillText("Camera", 4 / env.view.zoom, -6 / env.view.zoom);
  },
  // Hit only near the border, not the interior — the camera frames content;
  // clicks inside should select the content, not the camera.
  hitTest(s, lx, ly) {
    const m = 6; // world-units border grab margin (matches handle feel)
    const inOuter = lx >= -m && lx <= s.w + m && ly >= -m && ly <= s.h + m;
    const inInner = lx >= m && lx <= s.w - m && ly >= m && ly <= s.h - m;
    return inOuter && !inInner;
  },
  anchors: standardBBoxAnchors,
};
