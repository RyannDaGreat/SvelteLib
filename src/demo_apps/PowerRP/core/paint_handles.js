/**
 * GRADIENT HANDLES — the on-canvas yellow squares that edit a fill's gradient
 * GEOMETRY directly, the shared half of the gradient-handle feature (the other
 * half is the storage/render in render_gpu/ir.js + skia/gradient.js).
 *
 * WHY IT LIVES HERE, ONCE: every shape widget (rect, circle, polygon, the
 * shapeshifter families) can carry a gradient fill, and the handles for that
 * gradient are IDENTICAL across all of them — a function of the PAINT, not the
 * shape. So a single pure helper produces the modifier-point rows and each plugin
 * SPREADS them into its own `modifierPoints` (additively — its shape handles are
 * untouched). No plugin re-derives gradient geometry, and the constraint math is
 * written down exactly once.
 *
 * THE HANDLES (all in LOCAL widget px, over the [0,w]×[0,h] box, exactly like
 * every other modifier point — core/derive.js nodeModifierPoints wraps them
 * local→world for display and inverts back before apply):
 *
 *   RADIAL — one CENTER bead at the gradient center (objectBoundingBox center ×
 *     box), free (drag anywhere). The radius is a NumericField in the Inspector,
 *     not a bead (kept out of scope).
 *
 *   LINEAR — a CENTER bead (same as radial), PLUS a DIRECTION bead that rides a
 *     FIXED RAY from the center along the gradient axis and encodes WAVELENGTH by
 *     its distance. THE MAPPING: the axis half-vector in local px is
 *     half = ((to − from)/2)·(w_box, h_box) (from/to are the objectBoundingBox
 *     endpoints the angle derives — core/properties.angleToLinearEndpoints). The
 *     bead sits at center + wavelength·half — i.e. at the END of ONE colour ramp.
 *     Dragging it OUT lengthens the ramp (wavelength up, fewer tiles); dragging it
 *     IN shortens it (wavelength down, more mirror-tiling). `constrain` projects a
 *     dragged point onto that ray (t ≥ GRADIENT_MIN_WAVELENGTH), so it is a metric
 *     projection — idempotent, its own displayed point is a fixed point, and
 *     apply(wavelength = t) round-trips the bead back to where the drag left it.
 *     Direction (the axis angle) is edited by the Inspector dial, not this bead.
 *
 * The `apply` of each bead returns `{[key]: <the whole rebuilt paint object>}`
 * because a modifier drag writes each apply-partial's top-level key straight to
 * the item (web/CanvasView.modifierDrag), and the gradient lives NESTED inside the
 * paint — so the write target is the paint field itself. The multi-sub-state
 * wrapper (or a legacy inline gradient) is rebuilt immutably, changing only the
 * one edited field.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { angleToLinearEndpoints, GRADIENT_DEFAULT_ANGLE, GRADIENT_DEFAULT_CENTER, GRADIENT_MIN_WAVELENGTH } from "./properties.js";
import { closestPointOnAxisRange } from "./outline.js";

/**
 * Pure function. The ACTIVE gradient sub-state of a paint value, or null if the
 * paint is not a gradient (a solid string/array, a material, an equation, null).
 * Handles BOTH stored shapes the paint union uses: the multi-sub-state WRAPPER the
 * PaintField writes ({type, linear:{...}, radial:{...}}) and a LEGACY INLINE
 * gradient whose fields sit on the object itself ({type, stops, from/to|center/r}).
 * `wrapped` records which, so a writer patches the right place.
 *
 * @param {*} paint - any paint value
 * @returns {{type: string, subKey: string, g: object, wrapped: boolean}|null}
 *
 * @example activeGradient("#f00") // null
 * @example activeGradient(null) // null
 * @example activeGradient({type: "solid", solid: "#f00"}) // null
 * @example activeGradient({type: "linearGradient", linear: {stops: []}}).subKey // "linear"
 * @example activeGradient({type: "linearGradient", linear: {stops: []}}).wrapped // true
 * @example activeGradient({type: "linearGradient", stops: []}).wrapped // false (legacy inline)
 * @example activeGradient({type: "radialGradient", radial: {stops: [], center: {x: 0.5, y: 0.5}, r: 0.5}}).subKey // "radial"
 */
export function activeGradient(paint) {
  if (!paint || typeof paint !== "object" || Array.isArray(paint)) return null;
  if (paint.type === "linearGradient") {
    const wrapped = paint.linear != null;
    return { type: "linearGradient", subKey: "linear", g: wrapped ? paint.linear : paint, wrapped };
  }
  if (paint.type === "radialGradient") {
    const wrapped = paint.radial != null;
    return { type: "radialGradient", subKey: "radial", g: wrapped ? paint.radial : paint, wrapped };
  }
  return null;
}

/**
 * Pure function. A linear sub-state's objectBoundingBox axis {from, to}. The
 * stored `angle` (degrees) is authoritative (a keyframed angle tweens as a
 * rotating axis); a stored from/to is the legacy fallback, then the 0° default.
 * This mirrors render_gpu/ir.js linearAxis — duplicated (3 lines) rather than
 * imported to keep core/ from depending UP on render_gpu/.
 *
 * @param {object} g - the linear sub-state ({angle?, from?, to?})
 * @returns {{from: {x, y}, to: {x, y}}}
 *
 * @example linearAxisOf({angle: 0}) // {from: {x: 0, y: 0.5}, to: {x: 1, y: 0.5}}
 * @example linearAxisOf({angle: 90}) // {from: {x: 0.5, y: 0}, to: {x: 0.5, y: 1}}
 * @example linearAxisOf({from: {x: 0, y: 0}, to: {x: 1, y: 0}}) // {from: {x: 0, y: 0}, to: {x: 1, y: 0}} (legacy fallback)
 */
export function linearAxisOf(g) {
  if (g.angle != null && Number.isFinite(g.angle)) return angleToLinearEndpoints(g.angle);
  if (g.from != null && g.to != null) return { from: g.from, to: g.to };
  return angleToLinearEndpoints(GRADIENT_DEFAULT_ANGLE);
}

/** Pure function. Rebuilds a paint with `patch` merged onto its active gradient
 *  sub-state (into the .linear/.radial wrapper, or onto the object itself for a
 *  legacy inline gradient) — immutable, everything else preserved. */
function withGradientPatch(paint, ag, patch) {
  if (ag.wrapped) return { ...paint, [ag.subKey]: { ...paint[ag.subKey], ...patch } };
  return { ...paint, ...patch };
}

/** Pure function. The linear gradient's local-px frame for the direction bead:
 *  the ray ORIGIN (center × box) and HALF vector (axis half-vector × box). The
 *  bead lives at origin + wavelength·half; wavelength is the ray parameter t. */
function linearFrame(state, ag) {
  const W = state.w ?? 0, H = state.h ?? 0;
  const c = ag.g.center ?? GRADIENT_DEFAULT_CENTER;
  const { from, to } = linearAxisOf(ag.g);
  return {
    origin: { x: c.x * W, y: c.y * H },
    half: { x: ((to.x - from.x) / 2) * W, y: ((to.y - from.y) / 2) * H },
  };
}

/**
 * Pure function. THE gradient modifier points for a shape's paint field — spread
 * into a plugin's `modifierPoints(state)`. Returns [] when `state[key]` is not a
 * gradient (a solid/material/equation/absent fill contributes NO handles, so a
 * non-gradient widget is byte-identical to before this feature). A RADIAL gradient
 * yields one center bead; a LINEAR gradient yields a center bead plus a direction
 * bead (see the module docstring for the wavelength mapping). Each point is
 * {id, x, y, apply, constrain?} in LOCAL px, the modifier-point contract.
 *
 * @param {object} state - the folded item state (reads state[key], state.w, state.h)
 * @param {string} [key="fill"] - which paint field ("fill" or "stroke")
 * @returns {object[]} modifier-point rows
 *
 * @example paintModifierPoints({w: 100, h: 100, fill: "#f00"}, "fill") // [] (solid: no handles)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "material", material: {id: "comic"}}}, "fill") // [] (material: no handles)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "linearGradient", linear: {stops: [], angle: 0}}}, "fill").map((m) => m.id) // ["fill-grad-center", "fill-grad-dir"]
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "linearGradient", linear: {stops: [], angle: 0}}}, "fill")[0].y // 50 (center bead at box center)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "linearGradient", linear: {stops: [], angle: 0}}}, "fill")[1].x // 100 (direction bead at the ramp end: center + 1·half)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "linearGradient", linear: {stops: [], angle: 0, wavelength: 0.5}}}, "fill")[1].x // 75 (half-wavelength: center + 0.5·half)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "radialGradient", radial: {stops: [], center: {x: 0.5, y: 0.5}, r: 0.5}}}, "fill").map((m) => m.id) // ["fill-grad-center"]
 */
export function paintModifierPoints(state, key = "fill") {
  const ag = activeGradient(state[key]);
  if (!ag) return [];
  const W = state.w ?? 0, H = state.h ?? 0;
  const c = ag.g.center ?? GRADIENT_DEFAULT_CENTER;

  // CENTER bead (both kinds) — free. apply writes the center back in
  // objectBoundingBox (local ÷ box); a zero-extent axis keeps its coordinate
  // (no fraction is derivable), the lens_flare division guard.
  const centerBead = {
    id: `${key}-grad-center`,
    x: c.x * W, y: c.y * H,
    apply(st, allowed) {
      const a = activeGradient(st[key]);
      if (!a) return {};
      const cw = st.w ?? 0, ch = st.h ?? 0;
      const cur = a.g.center ?? GRADIENT_DEFAULT_CENTER;
      return { [key]: withGradientPatch(st[key], a, { center: { x: cw === 0 ? cur.x : allowed.x / cw, y: ch === 0 ? cur.y : allowed.y / ch } }) };
    },
  };
  if (ag.type === "radialGradient") return [centerBead];

  // DIRECTION bead (linear only) — rides the ray center→(+axis); its distance is
  // wavelength. Displayed at the current (floored) wavelength so its own position
  // is always an allowed fixed point.
  const { origin, half } = linearFrame(state, ag);
  const wl = Math.max(GRADIENT_MIN_WAVELENGTH, ag.g.wavelength ?? 1);
  const directionBead = {
    id: `${key}-grad-dir`,
    x: origin.x + wl * half.x, y: origin.y + wl * half.y,
    constrain(st, desired) {
      const a = activeGradient(st[key]);
      if (!a || a.type !== "linearGradient") return desired;
      const f = linearFrame(st, a);
      return closestPointOnAxisRange(f.origin, f.half, desired, GRADIENT_MIN_WAVELENGTH);
    },
    apply(st, allowed) {
      const a = activeGradient(st[key]);
      if (!a || a.type !== "linearGradient") return {};
      const f = linearFrame(st, a);
      const denom = f.half.x * f.half.x + f.half.y * f.half.y;
      const t = denom === 0
        ? Math.max(GRADIENT_MIN_WAVELENGTH, a.g.wavelength ?? 1) // degenerate axis: keep
        : ((allowed.x - f.origin.x) * f.half.x + (allowed.y - f.origin.y) * f.half.y) / denom;
      return { [key]: withGradientPatch(st[key], a, { wavelength: Math.max(GRADIENT_MIN_WAVELENGTH, t) }) };
    },
  };
  return [centerBead, directionBead];
}
