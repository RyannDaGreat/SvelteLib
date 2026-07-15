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
 * Items store x/y/rotation/scale flat in their state. Rotation pivots about
 * the LOCAL origin (0,0) = the bbox top-left; to pivot about another point,
 * post-process with aboutPivot().
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

/**
 * Pure function. Re-parametrizes a similarity transform so its rotation pivots
 * about the given WORLD point (ax, ay) instead of the local origin, WITHOUT
 * changing its rotation/scale. Returns a transform with the same rotation and
 * scale but a translation adjusted so (ax, ay) is the fixed point of rotation.
 *
 * WHY THIS SHAPE: PowerRP stores transforms parametrically {x,y,rotation,scale}
 * (never a matrix, so components tween correctly). "Rotate an object about an
 * anchor" (manifest Round 11) changes only the EFFECTIVE translation — the
 * pivot leaves rotation/scale untouched — so the parametric form survives and
 * the result is still a plain similarity transform every consumer already
 * handles (compositor translate/rotate/scale, GPU wrap, hit-test invert,
 * anchors, snap, culling AABB). At rotation 0 the result is byte-identical to
 * the input, so unrotated content renders exactly as before.
 *
 * Derivation: let s=scale, θ=rotation, and (px,py) the anchor in the input
 * transform's rotation-0 layout, i.e. px=(ax−t.x)/s, py=(ay−t.y)/s. The output
 * translation is chosen so apply(out, px, py) === (ax, ay):
 *   out.x = ax − s(cosθ·px − sinθ·py),  out.y = ay − s(sinθ·px + cosθ·py).
 *
 * @example aboutPivot({x: 100, y: 100, rotation: 0, scale: 1}, 220, 170) // {x: 100, y: 100, rotation: 0, scale: 1}
 * @example aboutPivot({x: 100, y: 100, rotation: Math.PI / 2, scale: 1}, 220, 170) // {x: 290, y: 50, rotation: 1.5707963267948966, scale: 1}
 */
export function aboutPivot(t, ax, ay) {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  const px = (ax - t.x) / t.scale, py = (ay - t.y) / t.scale;
  return {
    x: ax - t.scale * (c * px - s * py),
    y: ay - t.scale * (s * px + c * py),
    rotation: t.rotation,
    scale: t.scale,
  };
}
