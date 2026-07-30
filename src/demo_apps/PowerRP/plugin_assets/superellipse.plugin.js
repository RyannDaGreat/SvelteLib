// superellipse.plugin.js — A PLUGIN ASSET: a widget delivered as a project asset
// rather than a source file. Loaded and sandboxed by core/plugin_assets.js.
//
// WHAT IT PROVES. The built-in roster has `rect` (corner RADIUS) and `circle`
// (a pure ellipse) but nothing in between: the SQUIRCLE family, the continuous
// morph iOS icons and Figma's "smooth corners" use. It is parameterized by an
// EXPONENT, not a radius, which is a genuinely different knob — so this is the
// "new kinds of shapes that are parameterized in different ways" case from the
// ruling, not a re-skin of an existing widget.
//
// THE CURVE.  |x/a|^n + |y/b|^n = 1   (Lamé, 1818)
//   n = 1     a diamond (rhombus)
//   n = 2     an exact ellipse — the `circle` widget's shape
//   n = 4     the squircle (the iOS-icon look)
//   n → ∞     approaches the full rectangle
// Sampled parametrically so no branch of the implicit form is missed:
//   x(t) = a · sign(cos t) · |cos t|^(2/n)
//   y(t) = b · sign(sin t) · |sin t|^(2/n)
// which traces the whole closed curve once over t ∈ [0, 2π) for every n > 0.
//
// The exponent is a MODIFIER POINT (a PPT-style yellow square), so `n` is draggable
// on canvas as well as typeable — and because it is ordinary number state it is
// keyframable and `=`-equation bindable with nothing added.

// ── The shape math. Pure functions, no host access. ──────────────────────────

// Sample count for the outline. 96 keeps a 4000-unit-wide squircle smooth (each
// segment under ~1 unit of chord error at n = 4) while staying cheap to re-emit
// on every drag frame.
const SAMPLES = 96;
// `n` below this makes the curve collapse toward its axes and the path degenerate;
// clamped rather than refused so a drag or a runaway equation cannot crash a paint.
const MIN_EXPONENT = 0.2;
const MAX_EXPONENT = 20;

/** Pure function. Clamp the Lamé exponent into the drawable range. */
function clampExponent(n) {
  const v = Number(n);
  if (!isFinite(v)) return 2; // a NaN equation result falls back to the ellipse case
  return Math.max(MIN_EXPONENT, Math.min(MAX_EXPONENT, v));
}

/**
 * Pure function. Superellipse outline as an SVG path string, in LOCAL box
 * coordinates (0,0)–(w,h): the curve is centred in the box and touches all four
 * edge midpoints for every exponent, so changing `n` never moves the silhouette's
 * extent — which is what lets localBounds be the plain box.
 */
function superellipsePath(w, h, n) {
  const a = w / 2, b = h / 2;
  const p = 2 / clampExponent(n);
  let d = "";
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const ct = Math.cos(t), st = Math.sin(t);
    const x = a + a * Math.sign(ct) * Math.pow(Math.abs(ct), p);
    const y = b + b * Math.sign(st) * Math.pow(Math.abs(st), p);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(3)} ${y.toFixed(3)}`;
  }
  return `${d}Z`;
}

/** Pure function. Is a LOCAL point inside the superellipse? The implicit form,
 *  which is exact — used for hit testing so clicking a diamond's empty corner
 *  does not select it (the whole reason a shape declares hitTest). */
function insideSuperellipse(w, h, n, lx, ly) {
  const a = w / 2, b = h / 2;
  if (a <= 0 || b <= 0) return false;
  const e = clampExponent(n);
  return Math.pow(Math.abs((lx - a) / a), e) + Math.pow(Math.abs((ly - b) / b), e) <= 1;
}

// ── The declarative plugin (core/registry.js's protocols). ───────────────────

// The exponent knob, declared as a CUSTOM self.* property, so it appears in the
// Inspector's "Custom" region and is referenceable as `self.exponent` from this
// widget's other equations — exactly as a built-in demo widget's knob is.
const CUSTOM = customProps([
  {
    name: "exponent",
    kind: "number",
    default: 4, // the squircle — the shape no built-in can draw, visible on insert
    min: MIN_EXPONENT,
    max: MAX_EXPONENT,
    step: 0.1,
    help: "The Lamé exponent n in |x/a|^n + |y/b|^n = 1. 1 = diamond, 2 = ellipse, 4 = squircle, large = rectangle. Drag the triangular handle on the right edge, or bind it with an equation.",
  },
]);

return {
  type: "superellipse",
  title: "Superellipse",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "superellipse", x: 220, y: 180, w: 200, h: 200, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#7aa2f7", stroke: "#000000", strokeWidth: 2,
    ...defaults("opacity"),
    ...CUSTOM.defaults,
  },
  // Rows compose from the SHARED property registry, exactly as circle.js does —
  // no cornerRadius (the exponent is this widget's corner knob).
  inspector: [
    ...bundle("positioning"),
    ...props("fill", "stroke", "strokeWidth"),
    ...props(...STROKE_TRIM_KEYS), // draw-on / dash phase, free at the ports seam
    ...props("opacity"),
    ...CUSTOM.rows,
  ],
  /** Pure function. State → display-list commands (LOCAL space) — THE render API.
   *  The universal effects bundle is INJECTED by the registry for an eligible
   *  plugin, so this emit does not call applyEffects itself. */
  emit(s) {
    return [path({
      d: superellipsePath(s.w ?? 0, s.h ?? 0, s.exponent),
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
      strokeStart: s.strokeStart, strokeEnd: s.strokeEnd,
      strokePhase: s.strokePhase, strokeCap: s.strokeCap,
    })];
  },
  // BOUNDS protocol: the curve is inscribed in the box for every exponent, so the
  // ink rect IS the box — the `bbox` default would be right, but declaring it
  // states the fact rather than relying on a default meaning the same thing.
  localBounds: (s) => ({ x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 }),
  hitTest: (s, lx, ly) => insideSuperellipse(s.w ?? 0, s.h ?? 0, s.exponent, lx, ly),
  anchors: standardBBoxAnchors,
  /** The exponent as a draggable handle. THE HANDLE-CONSTRAINT PROTOCOL: it rides
   *  the box's right-edge half-line, and `constrain` declares that projection
   *  separately from `apply`, so an equation or an anchor binding can drive it too
   *  — not only a mouse. Mapping is geometric: the handle sits where the curve
   *  crosses the horizontal centre line at 45°, which advances outward as n grows. */
  modifierPoints(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const a = w / 2, b = h / 2;
    const frac = Math.pow(0.5, 1 / clampExponent(s.exponent)); // |cos 45°|^(2/n) form at t = π/4
    return [{
      id: "exponent",
      shape: "triangle", // a distinct glyph: this handle writes a parameter, not a size
      x: a + a * frac,
      y: b + b * frac,
      stem: { x: a, y: b }, // dashed tether to the centre it is measured from
      /** Pure function. Project a dragged point onto the box's 45° diagonal ray,
       *  the locus the handle is allowed to occupy. */
      constrain(state, desired) {
        const sa = (state.w ?? 0) / 2, sb = (state.h ?? 0) / 2;
        if (sa <= 0 || sb <= 0) return { x: sa, y: sb };
        // Normalize into the unit square, clamp the diagonal parameter, map back.
        const u = Math.max(0, Math.min((desired.x - sa) / sa, 1));
        const v = Math.max(0, Math.min((desired.y - sb) / sb, 1));
        const t = Math.max(0, Math.min((u + v) / 2, 1));
        return { x: sa + sa * t, y: sb + sb * t };
      },
      /** Pure function. The allowed point's diagonal fraction back to an exponent:
       *  frac = 0.5^(1/n)  ⟹  n = ln(0.5) / ln(frac). */
      apply(state, allowed) {
        const sa = (state.w ?? 0) / 2, sb = (state.h ?? 0) / 2;
        if (sa <= 0 || sb <= 0) return { exponent: clampExponent(state.exponent) };
        const t = Math.max(0, Math.min(((allowed.x - sa) / sa + (allowed.y - sb) / sb) / 2, 1));
        // t → 0 and t → 1 are the exponent's own asymptotes (0 and ∞), so the
        // fraction is held inside the range that maps back to the clamped domain.
        const lo = Math.pow(0.5, 1 / MIN_EXPONENT), hi = Math.pow(0.5, 1 / MAX_EXPONENT);
        const frac = Math.max(lo, Math.min(t, hi));
        return { exponent: clampExponent(Math.log(0.5) / Math.log(frac)) };
      },
    }];
  },
  // Documented for the reader of the template: a plugin asset may NOT declare
  // `commands` (core/plugin_assets.js pluginShapeProblem refuses it — a command's
  // run(app) receives the live app). The app surfaces asset plugins in its own
  // "Insert Plugin Asset" menu instead, built from the registry.
};
