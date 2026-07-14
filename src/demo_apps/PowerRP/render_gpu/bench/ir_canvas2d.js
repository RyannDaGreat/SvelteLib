/**
 * BENCHMARK-ONLY canvas2D interpreter for the IR.
 *
 * NOT a product render mode (the decision is WebGPU + VECTOR only) — this
 * exists so the benchmark's A/B compares the two rasterizers on the SAME
 * display list. It intentionally mirrors how the live plugins paint:
 * roundRect/ellipse/fillText, full-canvas snapshot + ctx.filter for
 * blurBackdrop, snapshot + circular clip + scaled drawImage for
 * magnifyBackdrop (the plugin's non-supersample path — the CHEAPER canvas2D
 * magnifier, so the comparison is conservative in canvas2D's favor).
 */

import { flattenIR, rgbaToCss } from "../ir.js";

/**
 * Command (draws on ctx). Renders IR commands through `view`
 * ({zoom, panX, panY, dpr}) onto ctx's canvas.
 */
export function paintIR(ctx, commands, view, { media = {}, background = "#ffffff" } = {}) {
  const canvas = ctx.canvas;
  const deviceScale = view.zoom * view.dpr;
  const applyView = () => ctx.setTransform(
    deviceScale, 0, 0, deviceScale,
    view.panX * view.dpr, view.panY * view.dpr,
  );

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const { cmd, world } of flattenIR(commands)) {
    ctx.save();
    applyView();
    ctx.translate(world.x, world.y);
    ctx.rotate(world.rotation);
    ctx.scale(world.scale, world.scale);
    ctx.globalAlpha = cmd.opacity ?? 1;
    switch (cmd.op) {
      case "rect": {
        ctx.beginPath();
        ctx.roundRect(cmd.x, cmd.y, cmd.w, cmd.h, cmd.cornerRadius);
        if (cmd.fill) { ctx.fillStyle = rgbaToCss(cmd.fill); ctx.fill(); }
        if (cmd.stroke && cmd.strokeWidth > 0) {
          ctx.strokeStyle = rgbaToCss(cmd.stroke);
          ctx.lineWidth = cmd.strokeWidth;
          ctx.stroke();
        }
        break;
      }
      case "ellipse": {
        ctx.beginPath();
        ctx.ellipse(cmd.cx, cmd.cy, cmd.rx, cmd.ry, 0, 0, Math.PI * 2);
        if (cmd.fill) { ctx.fillStyle = rgbaToCss(cmd.fill); ctx.fill(); }
        if (cmd.stroke && cmd.strokeWidth > 0) {
          ctx.strokeStyle = rgbaToCss(cmd.stroke);
          ctx.lineWidth = cmd.strokeWidth;
          ctx.stroke();
        }
        break;
      }
      case "polyline": {
        ctx.beginPath();
        ctx.moveTo(cmd.points[0][0], cmd.points[0][1]);
        for (let i = 1; i < cmd.points.length; i++) ctx.lineTo(cmd.points[i][0], cmd.points[i][1]);
        ctx.strokeStyle = rgbaToCss(cmd.color);
        ctx.lineWidth = cmd.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        break;
      }
      case "polygon": {
        ctx.beginPath();
        ctx.moveTo(cmd.points[0][0], cmd.points[0][1]);
        for (let i = 1; i < cmd.points.length; i++) ctx.lineTo(cmd.points[i][0], cmd.points[i][1]);
        ctx.closePath();
        ctx.fillStyle = rgbaToCss(cmd.fill);
        ctx.fill();
        break;
      }
      case "text": {
        ctx.font = `${cmd.bold ? "bold " : ""}${cmd.size}px system-ui, sans-serif`;
        ctx.fillStyle = rgbaToCss(cmd.color);
        ctx.textBaseline = "top";
        ctx.fillText(cmd.text, cmd.x, cmd.y);
        break;
      }
      case "image":
      case "video": {
        const src = media[cmd.ref];
        if (!src) throw new Error(`paintIR: no media for ref "${cmd.ref}"`);
        ctx.drawImage(src, cmd.x, cmd.y, cmd.w, cmd.h);
        break;
      }
      case "blurBackdrop": {
        const snap = snapshot(canvas);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.filter = `blur(${cmd.radius * world.scale * deviceScale}px)`;
        ctx.drawImage(snap, 0, 0);
        ctx.filter = "none";
        break;
      }
      case "magnifyBackdrop": {
        const snap = snapshot(canvas);
        // Lens center in device px (world → device)
        const cwx = world.x + world.scale * (Math.cos(world.rotation) * cmd.cx - Math.sin(world.rotation) * cmd.cy);
        const cwy = world.y + world.scale * (Math.sin(world.rotation) * cmd.cx + Math.cos(world.rotation) * cmd.cy);
        const cxDev = cwx * deviceScale + view.panX * view.dpr;
        const cyDev = cwy * deviceScale + view.panY * view.dpr;
        const rDev = cmd.r * world.scale * deviceScale;
        const srcR = rDev / cmd.magnification;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cxDev, cyDev, rDev, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(snap, cxDev - srcR, cyDev - srcR, srcR * 2, srcR * 2, cxDev - rDev, cyDev - rDev, rDev * 2, rDev * 2);
        ctx.restore();
        if (cmd.rimColor && cmd.rimWidth > 0) {
          ctx.beginPath();
          ctx.arc(cxDev, cyDev, rDev, 0, Math.PI * 2);
          ctx.strokeStyle = rgbaToCss(cmd.rimColor);
          ctx.lineWidth = cmd.rimWidth * world.scale * deviceScale;
          ctx.stroke();
        }
        break;
      }
      default:
        throw new Error(`paintIR: unknown op "${cmd.op}"`);
    }
    ctx.restore();
  }
}

/** Query (reads canvas). Device-pixel copy — the canvas2D backdrop snapshot. */
function snapshot(canvas) {
  const snap = document.createElement("canvas");
  snap.width = canvas.width;
  snap.height = canvas.height;
  snap.getContext("2d").drawImage(canvas, 0, 0);
  return snap;
}
