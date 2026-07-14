/**
 * 2D similarity transforms — translate, rotate, uniform scale. NO skew (by
 * decree: affine is excluded from core; a widget wanting skew implements it in
 * its own paint). Stored parametrically as {x, y, rotation, scale} — never a
 * matrix — so each component tweens independently and correctly. rotation is
 * an unwrapped angle in radians (deltas may spin 720°).
 *
 * Similarity ∘ similarity = similarity, so parent chains (future armatures)
 * stay closed and can never manufacture shear.
 */

/** Pure function. The identity transform.
 * @example identity() // {x: 0, y: 0, rotation: 0, scale: 1}
 */
export function identity() {
  return { x: 0, y: 0, rotation: 0, scale: 1 };
}

/**
 * Pure function. Applies transform t to a local point → world point.
 *
 * @example apply({x: 10, y: 0, rotation: 0, scale: 2}, 3, 4) // {x: 16, y: 8}
 * @example apply(identity(), 3, 4) // {x: 3, y: 4}
 */
export function apply(t, px, py) {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  return {
    x: t.x + t.scale * (c * px - s * py),
    y: t.y + t.scale * (s * px + c * py),
  };
}

/**
 * Pure function. Composes two transforms: result acts like "apply inner, then
 * outer". apply(compose(o, i), p) === apply(o, apply(i, p)).
 *
 * @example compose(identity(), {x: 1, y: 2, rotation: 0, scale: 3}) // {x: 1, y: 2, rotation: 0, scale: 3}
 * @example compose({x: 10, y: 0, rotation: 0, scale: 2}, identity()) // {x: 10, y: 0, rotation: 0, scale: 2}
 */
export function compose(outer, inner) {
  const p = apply(outer, inner.x, inner.y);
  return {
    x: p.x,
    y: p.y,
    rotation: outer.rotation + inner.rotation,
    scale: outer.scale * inner.scale,
  };
}

/**
 * Pure function. Inverse transform: apply(invert(t), apply(t, p)) === p.
 *
 * @example invert({x: 10, y: 0, rotation: 0, scale: 2}) // {x: -5, y: 0, rotation: 0, scale: 0.5}
 */
export function invert(t) {
  const inv = { x: 0, y: 0, rotation: -t.rotation, scale: 1 / t.scale };
  const p = apply(inv, -t.x, -t.y);
  return { x: p.x, y: p.y, rotation: inv.rotation, scale: inv.scale };
}

/**
 * Pure function. Reads an item state's transform, defaulting missing parts.
 * Items store x/y/rotation/scale flat in their state.
 *
 * @example fromState({x: 5, y: 6, type: "rect"}) // {x: 5, y: 6, rotation: 0, scale: 1}
 */
export function fromState(state) {
  return {
    x: state.x ?? 0,
    y: state.y ?? 0,
    rotation: state.rotation ?? 0,
    scale: state.scale ?? 1,
  };
}
