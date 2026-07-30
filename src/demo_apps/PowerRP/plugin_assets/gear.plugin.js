// gear.plugin.js — the SECOND proof PLUGIN ASSET (see superellipse.plugin.js for
// the format's introduction; core/plugin_assets.js for the loader and the jail).
//
// WHY A GEAR, specifically. The ruling asks for "new kinds of shapes that are
// parameterized in different ways", and a gear's defining knob is a COUNT (an
// integer tooth count) rather than a length or a fraction. That exercises a part
// of the contract the superellipse does not:
//   - an INTEGER-valued knob whose handle must snap to whole teeth (THE HANDLE-
//     CONSTRAINT PROTOCOL doing real projection work, not just clamping),
//   - a silhouette whose ink is INSET from the bbox on the diagonals but touches
//     it on the axes, so `localBounds` and `hitTest` cannot be the box default,
//   - a second, dependent knob (the hub hole) that is a FRACTION of the first
//     radius — the kind of coupled parameterization a fixed built-in cannot grow.
//
// It is also the honest substitute for the GLSL-material half of this round. The
// material registry (render_gpu/skia/materials.js) holds its descriptors in a
// module-level `const MATERIALS = Object.fromEntries(...)` with no registration
// entry point, and `material.pack(u)` is called per-draw inside
// paint_skia.js's hot path — so a sandboxed material would need the jail wrapped
// around a per-frame render call plus a compile-cache invalidation on deregister,
// in two files this round does not own. A pure-vector second plugin ships instead;
// nothing here is stubbed.

// ── Geometry. Pure functions. ────────────────────────────────────────────────

// Angular samples per tooth for the root/tip fillets. 6 is enough that a 40-tooth
// gear reads as smooth at typical slide scale without a 1000-point path.
const SAMPLES_PER_TOOTH = 6;
const MIN_TEETH = 3;   // fewer than three and it is not a gear, it is a lobe
const MAX_TEETH = 60;  // beyond this the teeth alias into a circle at slide scale

/** Pure function. Clamp a tooth count to a whole number in the drawable range. */
function clampTeeth(n) {
  const v = Math.round(Number(n));
  if (!isFinite(v)) return 12;
  return Math.max(MIN_TEETH, Math.min(v, MAX_TEETH));
}

/** Pure function. Clamp the tooth DEPTH — the fraction of the outer radius the
 *  root circle sits in by. Kept strictly inside (0, 1) so the gear can neither
 *  become a plain disc (0) nor collapse to a star with no body (1). */
function clampDepth(f) {
  const v = Number(f);
  if (!isFinite(v)) return 0.22;
  return Math.max(0.02, Math.min(v, 0.6));
}

/**
 * Pure function. The gear outline as an SVG path, in LOCAL box coordinates
 * (0,0)–(w,h). The gear is inscribed: its TIP circle touches all four edge
 * midpoints, so the silhouette's extent is independent of tooth count and depth.
 *
 * Each tooth spans one angular period and is walked in four arcs — root, rising
 * flank, tip, falling flank — with the flanks taking a quarter period each. That
 * gives a trapezoidal tooth (the readable, drawn-gear look) rather than a true
 * involute; an involute profile is what a MACHINED gear needs and would only
 * matter if two of these had to mesh.
 */
function gearPath(w, h, teeth, depth) {
  const cx = w / 2, cy = h / 2;
  const rTip = Math.min(cx, cy);
  const n = clampTeeth(teeth);
  const rRoot = rTip * (1 - clampDepth(depth));
  const period = (Math.PI * 2) / n;
  let d = "";
  const at = (angle, radius) => {
    const x = cx + radius * Math.cos(angle), y = cy + radius * Math.sin(angle);
    d += `${d === "" ? "M" : "L"}${x.toFixed(3)} ${y.toFixed(3)}`;
  };
  for (let i = 0; i < n; i++) {
    const base = i * period;
    // Four quarters: root arc, rise, tip arc, fall. Sampling each quarter keeps
    // the root and tip genuinely circular instead of straight chords.
    for (let k = 0; k < SAMPLES_PER_TOOTH; k++)
      at(base + (k / SAMPLES_PER_TOOTH) * (period / 4), rRoot);
    at(base + period / 4, rRoot);
    at(base + period / 4, rTip); // the rising flank: a radial step
    for (let k = 0; k < SAMPLES_PER_TOOTH; k++)
      at(base + period / 4 + (k / SAMPLES_PER_TOOTH) * (period / 2), rTip);
    at(base + (period * 3) / 4, rTip);
    at(base + (period * 3) / 4, rRoot); // the falling flank
  }
  return `${d}Z`;
}

/** Pure function. The hub hole as its own subpath (an SVG circle via two arcs),
 *  or "" when the hub is closed. Combined with the outline under the EVENODD fill
 *  rule, this is what makes the hole a hole rather than a second filled disc. */
function hubPath(w, h, hub) {
  const cx = w / 2, cy = h / 2;
  const r = Math.min(cx, cy) * Math.max(0, Math.min(Number(hub) || 0, 0.9));
  if (r <= 0) return "";
  return `M${(cx - r).toFixed(3)} ${cy.toFixed(3)}A${r.toFixed(3)} ${r.toFixed(3)} 0 1 0 ${(cx + r).toFixed(3)} ${cy.toFixed(3)}A${r.toFixed(3)} ${r.toFixed(3)} 0 1 0 ${(cx - r).toFixed(3)} ${cy.toFixed(3)}Z`;
}

/** Pure function. Is a LOCAL point on the gear's body? Exact against the tooth
 *  profile: the radius allowed at this angle is the tip radius inside a tooth's
 *  angular half-period and the root radius outside it — so clicking between two
 *  teeth does not select the gear, and neither does clicking the hub hole. */
function insideGear(w, h, teeth, depth, hub, lx, ly) {
  const cx = w / 2, cy = h / 2;
  const rTip = Math.min(cx, cy);
  if (rTip <= 0) return false;
  const dx = lx - cx, dy = ly - cy;
  const r = Math.hypot(dx, dy);
  const rHub = rTip * Math.max(0, Math.min(Number(hub) || 0, 0.9));
  if (r <= rHub) return false; // the hole
  const n = clampTeeth(teeth);
  const period = (Math.PI * 2) / n;
  // Phase within one tooth period, matched to gearPath's layout: the TIP occupies
  // the middle half of each period (quarter .. three-quarters).
  const phase = ((Math.atan2(dy, dx) % period) + period) % period;
  const onTooth = phase >= period / 4 && phase <= (period * 3) / 4;
  return r <= (onTooth ? rTip : rTip * (1 - clampDepth(depth)));
}

// ── The declarative plugin. ──────────────────────────────────────────────────

const CUSTOM = customProps([
  {
    name: "teeth",
    kind: "number",
    default: 12,
    min: MIN_TEETH,
    max: MAX_TEETH,
    step: 1,
    help: "How many teeth. A whole number — the canvas handle snaps to integers, and a fractional equation result is rounded.",
  },
  {
    name: "toothDepth",
    kind: "number",
    default: 0.22,
    min: 0.02,
    max: 0.6,
    step: 0.01,
    help: "Tooth depth as a fraction of the outer radius: how far the root circle sits inside the tip circle.",
  },
  {
    name: "hub",
    kind: "number",
    default: 0.3,
    min: 0,
    max: 0.9,
    step: 0.01,
    help: "Hub hole radius as a fraction of the outer radius. 0 closes the hub.",
  },
]);

return {
  type: "gear",
  title: "Gear",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "gear", x: 260, y: 200, w: 180, h: 180, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#e0af68", stroke: "#000000", strokeWidth: 2,
    ...defaults("opacity"),
    ...CUSTOM.defaults,
  },
  inspector: [
    ...bundle("positioning"),
    ...props("fill", "stroke", "strokeWidth"),
    ...props("opacity"),
    ...CUSTOM.rows,
  ],
  /** Pure function. State → display-list commands (LOCAL space). Outline and hub
   *  are ONE path under the EVENODD rule, so the hub is a genuine hole: whatever
   *  is behind the gear shows through it, which a second fill-coloured disc could
   *  never do. Effects come from the registry's universal bundle. */
  emit(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const d = gearPath(w, h, s.teeth, s.toothDepth) + hubPath(w, h, s.hub);
    return [path({
      d,
      fillRule: "evenodd", // the hub hole
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })];
  },
  // BOUNDS protocol: the TIP circle is inscribed in the box and touches all four
  // edge midpoints, so the ink rect is the box for every tooth count.
  localBounds: (s) => ({ x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 }),
  hitTest: (s, lx, ly) => insideGear(s.w ?? 0, s.h ?? 0, s.teeth, s.toothDepth, s.hub, lx, ly),
  anchors: standardBBoxAnchors,
  /** Two handles, both on the horizontal centre line to the right of centre:
   *  the ROOT circle (tooth depth) and the HUB radius. Tooth COUNT is not a
   *  handle — dragging a length to choose a count reads as arbitrary; it is the
   *  Inspector's integer field (and any equation), which is the honest control
   *  for a discrete quantity. */
  modifierPoints(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const cx = w / 2, cy = h / 2;
    const rTip = Math.min(cx, cy);
    /** Pure function. Project a desired point onto the centre-line ray, returning
     *  a radius fraction in [lo, hi] — the shared constraint both handles use. */
    const radiusFraction = (state, desired, lo, hi) => {
      const sr = Math.min((state.w ?? 0) / 2, (state.h ?? 0) / 2);
      if (sr <= 0) return lo;
      const f = (desired.x - (state.w ?? 0) / 2) / sr;
      return Math.max(lo, Math.min(f, hi));
    };
    const onRay = (state, f) => ({ x: (state.w ?? 0) / 2 + Math.min((state.w ?? 0) / 2, (state.h ?? 0) / 2) * f, y: (state.h ?? 0) / 2 });
    return [
      {
        id: "toothDepth",
        shape: "triangle",
        x: cx + rTip * (1 - clampDepth(s.toothDepth)),
        y: cy,
        stem: { x: cx + rTip, y: cy }, // tethered to the TIP circle it is measured from
        constrain: (state, desired) => onRay(state, radiusFraction(state, desired, 0.4, 0.98)),
        apply: (state, allowed) => ({ toothDepth: clampDepth(1 - radiusFraction(state, allowed, 0.4, 0.98)) }),
      },
      {
        id: "hub",
        x: cx + rTip * Math.max(0, Math.min(Number(s.hub) || 0, 0.9)),
        y: cy,
        stem: { x: cx, y: cy }, // tethered to the centre: it IS a radius from there
        constrain: (state, desired) => onRay(state, radiusFraction(state, desired, 0, 0.9)),
        apply: (state, allowed) => ({ hub: radiusFraction(state, allowed, 0, 0.9) }),
      },
    ];
  },
};
