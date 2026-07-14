/**
 * Typed value interpolation — how a single leaf tweens from a → b.
 *
 * Chosen by VALUE SHAPE, not property name: numbers lerp (int pairs round),
 * booleans threshold, #rrggbb colors blend per-channel, equal-length numeric
 * arrays blend elementwise, everything else is discrete (snaps to the target
 * as soon as alpha > 0 — matching tweenline/LIAC reference semantics; if you
 * want a fade, author one with opacity).
 */

/**
 * Pure function. Linear interpolation.
 *
 * @example lerp(0, 10, 0.5) // 5
 * @example lerp(2, 4, 0) // 2
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Pure function. True for CSS hex colors like "#a3f" or "#aa33ff".
 *
 * @example isHexColor("#aa33ff") // true
 * @example isHexColor("#a3f") // true
 * @example isHexColor("blue") // false
 */
export function isHexColor(x) {
  return typeof x === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(x);
}

/**
 * Pure function. "#rgb"/"#rrggbb" → [r, g, b] in 0..255.
 *
 * @example hexToRgb("#ff0080") // [255, 0, 128]
 * @example hexToRgb("#f08") // [255, 0, 136]
 */
export function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/**
 * Pure function. [r, g, b] (0..255) → "#rrggbb".
 *
 * @example rgbToHex([255, 0, 128]) // "#ff0080"
 */
export function rgbToHex(rgb) {
  return "#" + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("");
}

/**
 * Pure function. Interpolate leaf value a → b at alpha in [0,1].
 *
 * @example interpolate(0, 10, 0.5) // 5
 * @example interpolate(1, 4, 0.5) // 3 (int pair → rounded, tweenline rule)
 * @example interpolate(1.0, 4, 0.5) // 3 (JS can't tell 1.0 from 1; ints round)
 * @example interpolate("#000000", "#ffffff", 0.5) // "#808080"
 * @example interpolate([0, 0], [10, 20], 0.5) // [5, 10]
 * @example interpolate("a", "b", 0.5) // "b" (discrete: alpha > 0 snaps)
 * @example interpolate(false, true, 0.2) // true (discrete)
 */
export function interpolate(a, b, alpha) {
  if (alpha <= 0) return a;
  if (alpha >= 1) return b;
  if (typeof a === "number" && typeof b === "number") {
    const v = lerp(a, b, alpha);
    return Number.isInteger(a) && Number.isInteger(b) ? Math.round(v) : v;
  }
  if (isHexColor(a) && isHexColor(b)) {
    const ca = hexToRgb(a), cb = hexToRgb(b);
    return rgbToHex(ca.map((c, i) => lerp(c, cb[i], alpha)));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((v) => typeof v === "number") && b.every((v) => typeof v === "number")) {
    return a.map((v, i) => lerp(v, b[i], alpha));
  }
  return b; // discrete
}

/**
 * Pure function. Ease names → f(t). Same set as tweenline.py.
 *
 * @example ease("linear")(0.5) // 0.5
 * @example ease("cubic")(0) // 0
 * @example ease("cubic")(1) // 1
 */
export function ease(name) {
  const eases = {
    linear: (t) => t,
    cubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
    quad_in: (t) => t * t,
    quad_out: (t) => 1 - (1 - t) * (1 - t),
  };
  if (!(name in eases)) throw new Error(`Unknown ease "${name}". Valid: ${Object.keys(eases).join(", ")}`);
  return eases[name];
}
