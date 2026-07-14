/**
 * Benchmark scene builder — ONE IR list consumed by BOTH the WebGPU
 * compositor and the canvas2D reference interpreter, so the A/B compares
 * renderers, not scenes. DOM-free pure JS.
 *
 * The scene: N animated rounded squares orbiting deterministic centers, a few
 * animated arrows, text labels, then a blurBackdrop layer (with squares above
 * it to prove partial-stack blurring), and an orbiting magnifier lens on top —
 * the exact widget mix PowerRP renders (rect/arrow/text/blur/magnifier).
 */

import { rect, polyline, polygon, text, pushTransform, popTransform, blurBackdrop, magnifyBackdrop } from "../ir.js";

/** World-space stage the scene lives on (16:9, PowerRP's default slide feel). */
export const WORLD_W = 1600;
export const WORLD_H = 900;

/** Tokyo-night-ish palette (rect plugin's defaults live here too). */
const PALETTE = ["#7aa2f7", "#f7768e", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#ff9e64", "#73daca"];

/**
 * Pure function. Deterministic pseudo-random in [0, 1) from (i, salt) —
 * stateless, so every frame recomputes identical per-item parameters.
 *
 * @example hash01(1, 0) === hash01(1, 0) // true
 * @example hash01(1, 0) !== hash01(2, 0) // true (with overwhelming probability)
 * @example hash01(42, 7) >= 0 && hash01(42, 7) < 1 // true
 */
export function hash01(i, salt = 0) {
  let x = (Math.imul(i + 1, 374761393) + Math.imul(salt + 1, 668265263)) >>> 0; // Knuth-style multiplicative mix
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * Pure function. The benchmark display list at time t (seconds).
 *
 * Args:
 *   t (number): animation clock in seconds
 *   opts.n (number): square count
 *   opts.effects (bool): include blurBackdrop + magnifier lens
 *
 * Returns:
 *   object[]: IR commands
 *
 * @example benchScene(0, {n: 1, effects: false}).filter((c) => c.op === "rect").length // 1
 * @example benchScene(0, {n: 2, effects: true}).some((c) => c.op === "magnifyBackdrop") // true
 * @example benchScene(1.5, {n: 3, effects: false}).length === benchScene(2.5, {n: 3, effects: false}).length // true (animation moves, structure fixed)
 */
export function benchScene(t, { n, effects = true }) {
  const cmds = [];
  const BELOW_BLUR_FRACTION = 0.8; // 80% of squares under the blur layer, 20% above — proves partial-stack blurring
  const nBelow = Math.round(n * BELOW_BLUR_FRACTION);

  const square = (i) => {
    const size = 20 + hash01(i, 1) * 40;
    const cx = hash01(i, 2) * WORLD_W;
    const cy = hash01(i, 3) * WORLD_H;
    const orbitR = 30 + hash01(i, 4) * 90;
    const speed = 0.3 + hash01(i, 5) * 0.9; // rad/s
    const phase = hash01(i, 6) * Math.PI * 2;
    const x = cx + orbitR * Math.cos(t * speed + phase);
    const y = cy + orbitR * Math.sin(t * speed + phase);
    const spin = (hash01(i, 7) - 0.5) * 2 * t + phase;
    const stroked = hash01(i, 8) > 0.5;
    cmds.push(
      pushTransform({ x, y, rotation: spin, scale: 1 }),
      rect({
        x: -size / 2, y: -size / 2, w: size, h: size,
        cornerRadius: size * 0.15,
        fill: PALETTE[i % PALETTE.length],
        stroke: stroked ? "#1a1a2e" : null,
        strokeWidth: stroked ? 2 : 0,
        opacity: 0.85,
      }),
      popTransform(),
    );
  };

  for (let i = 0; i < nBelow; i++) square(i);

  // Animated arrows (shaft capsule + head triangle, like arrowIR emits)
  const N_ARROWS = 8;
  for (let a = 0; a < N_ARROWS; a++) {
    const x0 = (0.1 + 0.8 * hash01(a, 20)) * WORLD_W;
    const y0 = (0.1 + 0.8 * hash01(a, 21)) * WORLD_H;
    const ang = t * (0.5 + hash01(a, 22)) + a;
    const len = 120 + hash01(a, 23) * 120;
    const x1 = x0 + Math.cos(ang) * len;
    const y1 = y0 + Math.sin(ang) * len;
    const head = 14;
    const shaftEnd = { x: x1 - Math.cos(ang) * head * 0.6, y: y1 - Math.sin(ang) * head * 0.6 };
    cmds.push(
      polyline({ points: [[x0, y0], [shaftEnd.x, shaftEnd.y]], width: 3, color: "#1a1a2e", opacity: 0.9 }),
      polygon({
        points: [
          [x1, y1],
          [x1 - Math.cos(ang - 0.44) * head, y1 - Math.sin(ang - 0.44) * head],
          [x1 - Math.cos(ang + 0.44) * head, y1 - Math.sin(ang + 0.44) * head],
        ],
        fill: "#1a1a2e", opacity: 0.9,
      }),
    );
  }

  cmds.push(text({ text: "PowerRP WebGPU display-list benchmark", x: 30, y: 24, size: 36, color: "#1a1a2e", bold: true }));
  cmds.push(
    pushTransform({ x: WORLD_W / 2, y: WORLD_H - 80, rotation: Math.sin(t) * 0.2, scale: 1 }),
    text({ text: "rotating text run — glyph atlas", x: -220, y: 0, size: 32, color: "#7a3a3a" }),
    popTransform(),
  );

  if (effects) cmds.push(blurBackdrop({ radius: 6, opacity: 0.9 }));

  for (let i = nBelow; i < n; i++) square(i);
  cmds.push(text({ text: "above the blur", x: 30, y: 70, size: 24, color: "#1a1a2e" }));

  if (effects) {
    const LENS_R = 130;
    const lx = WORLD_W / 2 + Math.cos(t * 0.4) * WORLD_W * 0.25;
    const ly = WORLD_H / 2 + Math.sin(t * 0.4) * WORLD_H * 0.25;
    cmds.push(
      pushTransform({ x: lx, y: ly }),
      magnifyBackdrop({ cx: 0, cy: 0, r: LENS_R, magnification: 2.5, rimColor: "#1a1a2e", rimWidth: 4 }),
      popTransform(),
    );
  }
  return cmds;
}
