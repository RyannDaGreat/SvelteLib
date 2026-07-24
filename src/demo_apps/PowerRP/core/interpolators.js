/**
 * Typed value interpolation — how a single leaf tweens from a → b.
 *
 * Chosen by VALUE SHAPE, not property name: numbers lerp (int pairs round),
 * booleans threshold, hex colors blend per-channel — INCLUDING the alpha
 * channel of #rrggbbaa colors (Round 10: "color properties support ALPHA";
 * plain #rrggbb stays legal and reads as opaque) — equal-length numeric
 * arrays blend elementwise, everything else is discrete (snaps to the target
 * as soon as alpha > 0 — matching tweenline/LIAC reference semantics; if you
 * want a fade, author one with opacity).
 *
 * STRUCTURAL RECURSION (the "structural keyframing" substrate): interpolate
 * recurses through arrays AND plain-object trees so a WHOLE list/record leaf
 * (e.g. a gradient's `stops` array, keyframed as one leaf) tweens element-wise.
 * The rule is uniform with the discrete-for-unlike-values philosophy, lifted to
 * SHAPE:
 *   - SAME shape  (equal-length arrays / identical object key-set) → tween each
 *     element/field recursively ("scalar keyframing" — values move, shape fixed).
 *   - DIFFERENT shape (length differs / key-set differs) → DISCRETE: snap to the
 *     target as soon as alpha > 0 ("structural keyframing" — the shape change is
 *     a discrete switch, never a half-built intermediate). Unchanged SIBLING
 *     leaves still tween, because the mismatch is localized to the sub-tree whose
 *     shape actually changed.
 * (Sparse per-element keyframes — a delta addressing `stops.<i>.offset` — are
 * handled in core/deltas.blendApplied, not here; both mechanisms converge on the
 * same rule.)
 */

/**
 * Pure function. True for plain object-literal trees (not arrays/class
 * instances) — the structural-recursion gate, kept local so interpolators.js
 * has NO import cycle with deltas.js (which imports interpolate). Identical
 * semantics to deltas.isTree.
 *
 * @example isPlainObject({a: 1}) // true
 * @example isPlainObject([1, 2]) // false
 * @example isPlainObject(null) // false
 */
function isPlainObject(x) {
  return x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
}

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
 * Pure function. True for CSS hex colors: "#rgb", "#rrggbb", and the alpha
 * forms "#rgba" / "#rrggbbaa" (8-digit hex is the alpha storage format;
 * plain #rrggbb stays legal = opaque).
 *
 * @example isHexColor("#aa33ff") // true
 * @example isHexColor("#aa33ff80") // true (alpha 0x80)
 * @example isHexColor("#a3f") // true
 * @example isHexColor("#a3f8") // true (shorthand with alpha)
 * @example isHexColor("blue") // false
 */
export function isHexColor(x) {
  return typeof x === "string" && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(x);
}

/**
 * Pure function. Hex color → channel array in 0..255: [r, g, b] for the
 * opaque forms, [r, g, b, a] when alpha digits are present. Shorthand
 * digits double ("#f08c" → "#ff0088cc").
 *
 * @example hexToRgb("#ff0080") // [255, 0, 128]
 * @example hexToRgb("#ff008080") // [255, 0, 128, 128]
 * @example hexToRgb("#f08") // [255, 0, 136]
 * @example hexToRgb("#f08c") // [255, 0, 136, 204]
 */
export function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const out = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

/**
 * Pure function. [r, g, b] or [r, g, b, a] (0..255) → "#rrggbb" / "#rrggbbaa".
 *
 * @example rgbToHex([255, 0, 128]) // "#ff0080"
 * @example rgbToHex([255, 0, 128, 128]) // "#ff008080"
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
 * @example interpolate("#ff000000", "#ff0000ff", 0.5) // "#ff000080" (alpha tweens per-channel)
 * @example interpolate("#ff0000", "#ff000000", 0.5) // "#ff000080" (plain hex = opaque: 255 → 0)
 * @example interpolate([0, 0], [10, 20], 0.5) // [5, 10]
 * @example interpolate("a", "b", 0.5) // "b" (discrete: alpha > 0 snaps)
 * @example interpolate(false, true, 0.2) // true (discrete)
 * @example // same-length list of records tweens element-wise (gradient stops;
 * @example // fractional offsets lerp — a 0↔1 pair would round per the int-rule):
 * @example interpolate([{offset: 0.25, color: "#000000"}], [{offset: 0.75, color: "#ffffff"}], 0.5) // [{offset: 0.5, color: "#808080"}]
 * @example // length change is STRUCTURAL → discrete snap to the target list:
 * @example interpolate([{offset: 0.5}], [{offset: 0.5}, {offset: 1}], 0.5) // [{offset: 0.5}, {offset: 1}]
 * @example // same key-set record tweens field-wise:
 * @example interpolate({x: 0, y: 0}, {x: 10, y: 20}, 0.5) // {x: 5, y: 10}
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
    // Mixed #rrggbb ↔ #rrggbbaa pairs: a missing alpha channel IS opaque
    // (255), so the alpha tweens from/to fully opaque instead of snapping.
    if (ca.length !== cb.length) {
      if (ca.length === 3) ca.push(255);
      if (cb.length === 3) cb.push(255);
    }
    return rgbToHex(ca.map((c, i) => lerp(c, cb[i], alpha)));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return b; // STRUCTURAL: length change is discrete
    // Pure-numeric arrays keep the historical plain-lerp path (NO int-rounding,
    // so point/coord lists stay byte-identical); mixed/record lists recurse.
    if (a.every((v) => typeof v === "number") && b.every((v) => typeof v === "number"))
      return a.map((v, i) => lerp(v, b[i], alpha));
    return a.map((v, i) => interpolate(v, b[i], alpha));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    // STRUCTURAL: any key-set difference is discrete (snap the whole record).
    if (ka.length !== Object.keys(b).length || !ka.every((k) => k in b)) return b;
    const out = {};
    for (const k of ka) out[k] = interpolate(a[k], b[k], alpha);
    return out;
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
