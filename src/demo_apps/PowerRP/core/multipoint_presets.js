/**
 * Editable native Multipoint fills, not images or material shaders.
 * Coordinates/relative handles use the unit paint box; stops address arc length,
 * independently of nodes. Two-sided curves require diffusion boundaries, not IDW.
 * Bokeh means smooth circular glows, not a photographic depth-of-field model.
 * Visual acceptance awaits the real solver/gallery; tests here verify DATA only.
 */
import { MULTIPOINT_TYPE, multipointFeature } from "./multipoint.js";

const FULL_TURN = 2 * Math.PI;
// Eight cubic spans per turn keep spirals/waves editable without coarse corners.
const MAX_ANGLE_STEP = Math.PI / 4;
const QUARTER_CIRCLE_HANDLE = 4 * (Math.SQRT2 - 1) / 3;
const GLOW_SHOULDER_RATIO = 0.55;

/**
 * Pure function. Rejects nonfinite geometry before it can become stored data.
 * @param {number[]} values - Numeric geometry parameters.
 * @returns {void}
 * @example finiteGeometry([0.5, 0.25]) // undefined
 */
function finiteGeometry(values) {
  if (!values.every(Number.isFinite)) throw new Error("Multipoint preset geometry must be finite");
}

/**
 * Pure function. Converts uniform Hermite samples to relative Bézier handles.
 * For parameter step h, outgoing = h·tangent/3, incoming = −outgoing.
 * @param {number[][]} samples - [N,4] tuples (x,y,dx/dt,dy/dt), e.g. [3,4].
 * @param {number} step - Positive spacing in the samples' parameter t.
 * @returns {number[][]} [N,6] tuples (x,y,inX,inY,outX,outY), e.g. [3,6].
 * @example hermiteNodes([[0,0,1,0],[1,1,1,2]], 1)[1] // [1,1,-1/3,-2/3,1/3,2/3]
 */
export function hermiteNodes(samples, step) {
  finiteGeometry([step]);
  if (step <= 0 || !samples.length) throw new Error("Hermite samples need a positive step and at least one sample");
  return samples.map((sample) => {
    if (sample.length !== 4) throw new Error("Hermite samples must be [x,y,dx/dt,dy/dt] tuples");
    finiteGeometry(sample);
    const [x, y, dx, dy] = sample;
    const hx = dx * step / 3, hy = dy * step / 3;
    finiteGeometry([hx, hy]);
    return [x, y, -hx, -hy, hx, hy];
  });
}

/**
 * Pure function. Four quarter-circle cubics, scaled to an axis-aligned ellipse.
 * Starts at the rightmost point; positive traversal is clockwise in screen space.
 * Close the feature rather than duplicating its first node. Maximum radial error
 * for a circle is below 0.000273 times its radius (not an exact rational circle).
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} rx - Positive horizontal radius.
 * @param {number} ry - Positive vertical radius; defaults to rx.
 * @returns {number[][]} [4,6] anchor/relative-handle tuples.
 * @example ellipseNodes(0.5, 0.5, 0.25)[0].slice(0, 2) // [0.75,0.5]
 */
export function ellipseNodes(cx, cy, rx, ry = rx) {
  finiteGeometry([cx, cy, rx, ry]);
  if (rx <= 0 || ry <= 0) throw new Error("Ellipse radii must be positive");
  const kx = rx * QUARTER_CIRCLE_HANDLE, ky = ry * QUARTER_CIRCLE_HANDLE;
  const nodes = [
    [cx + rx, cy, 0, -ky, 0, ky],
    [cx, cy + ry, kx, 0, -kx, 0],
    [cx - rx, cy, 0, ky, 0, -ky],
    [cx, cy - ry, -kx, 0, kx, 0],
  ];
  finiteGeometry(nodes.flat());
  return nodes;
}

/**
 * Pure function. Cubic approximation of an Archimedean spiral with exact tangents.
 * r(t) = startRadius + (endRadius − startRadius)·t; θ(t) = phase + 2π·turns·t.
 * @param {object} options - {cx,cy,startRadius,endRadius,turns,phase=0}; turns signed, nonzero.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 9 nodes for one turn.
 * @example spiralNodes({cx:0.5,cy:0.5,startRadius:0.1,endRadius:0.4,turns:1})[0].slice(0,2) // [0.6,0.5]
 */
export function spiralNodes({ cx, cy, startRadius, endRadius, turns, phase = 0 }) {
  const sweep = FULL_TURN * turns, radialStep = endRadius - startRadius;
  finiteGeometry([cx, cy, startRadius, endRadius, sweep, radialStep, phase]);
  if (startRadius < 0 || endRadius < 0 || turns === 0) throw new Error("Spiral radii must be nonnegative and turns nonzero");
  const segments = Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP);
  const samples = Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments, r = startRadius + radialStep * t, angle = phase + sweep * t;
    const c = Math.cos(angle), s = Math.sin(angle);
    return [cx + r * c, cy + r * s, radialStep * c - r * sweep * s, radialStep * s + r * sweep * c];
  });
  return hermiteNodes(samples, 1 / segments);
}

/**
 * Pure function. Cubic approximation of a sine wave, including exact tangents.
 * x(t) = x0 + (x1 − x0)·t; y(t) = y + amplitude·sin(2π·cycles·t + phase).
 * @param {object} options - {x0,x1,y,amplitude,cycles=1,phase=0}; cycles may be signed or zero.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 9 nodes for one cycle.
 * @example waveNodes({x0:0,x1:1,y:0.5,amplitude:0.2,cycles:0.5})[2].slice(0,2) // [0.5,0.7]
 */
export function waveNodes({ x0, x1, y, amplitude, cycles = 1, phase = 0 }) {
  const sweep = FULL_TURN * cycles, width = x1 - x0;
  finiteGeometry([x0, x1, y, amplitude, sweep, width, phase]);
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP));
  const samples = Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments, angle = sweep * t + phase;
    return [x0 + width * t, y + amplitude * Math.sin(angle), width, amplitude * sweep * Math.cos(angle)];
  });
  return hermiteNodes(samples, 1 / segments);
}

/**
 * Pure function. Builds a feature with independent, evenly spaced arc-length stops.
 * Explicit right palette means two-sided; a single palette constrains both sides.
 * @param {number[][]} nodes - [N,6] geometry, copied into the result.
 * @param {string[]} colors - Main/left colors; one color means a constant boundary.
 * @param {string[]|null} rightColors - Matching opposite-side palette, or null.
 * @param {boolean} closed - Connect last node to first.
 * @returns {object} Editable native feature with unit weight.
 * @example boundary(ellipseNodes(0.5,0.5,0.2), ["#ff0000"], null, true).closed // true
 */
function boundary(nodes, colors, rightColors = null, closed = false) {
  if (!colors.length || (rightColors && rightColors.length !== colors.length))
    throw new Error("Boundary palettes must be nonempty with matching lengths");
  return { nodes: nodes.map((node) => [...node]), stops: colors.map((color, i) => ({
    offset: colors.length === 1 ? 0 : i / (colors.length - 1), color, rightColor: rightColors ? rightColors[i] : color,
  })), twoSided: rightColors !== null, closed, weight: 1 };
}

/**
 * Pure function. A point source at a chosen anchor, using the native point schema.
 * @param {number} x - Anchor x.
 * @param {number} y - Anchor y.
 * @param {string} color - Main color.
 * @returns {object} Feature with [1,6] nodes and one stop.
 * @example point(0.2,0.3,"#ff0000").nodes // [[0.2,0.3,0,0,0,0]]
 */
function point(x, y, color) {
  return { ...multipointFeature("point", color), nodes: [[x, y, 0, 0, 0, 0]] };
}

/**
 * Pure function. Concentric glow constraints: light center, colored shoulder, dark rim.
 * The contours share their center geometrically; no hidden linkage or radius field.
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} radius - Outer contour radius.
 * @param {string[]} colors - [center,shoulder,rim] palette.
 * @returns {object[]} Three editable features, with 1 + 4 + 4 nodes.
 * @example glow(0.5,0.5,0.2,["#ffffff","#ff8800","#221100"]).length // 3
 */
function glow(cx, cy, radius, [center, shoulder, rim]) {
  return [point(cx, cy, center),
    boundary(ellipseNodes(cx, cy, radius * GLOW_SHOULDER_RATIO), [shoulder], null, true),
    boundary(ellipseNodes(cx, cy, radius), [rim], null, true)];
}

/**
 * Pure function. Wraps authored features in the public stored-paint schema.
 * @param {string} id - Permanent kebab-case key, independent of display text.
 * @param {string} label - Menu label.
 * @param {string} description - Authored design intent, not a render guarantee.
 * @param {object[]} features - Native features; owned by the new entry.
 * @returns {object} {id,label,description,paint}.
 * @example preset("red-dot","Red dot","Single red source",[point(0.5,0.5,"#f00")]).paint.type // "multipointGradient"
 */
function preset(id, label, description, features) {
  return { id, label, description, paint: { type: MULTIPOINT_TYPE, multipoint: { features } } };
}

/**
 * Command. Freezes this module's newly built catalog recursively, never user paint.
 * @param {object} value - Owned JSON-compatible catalog subtree.
 * @returns {object} Same subtree, frozen at every object/array level.
 * @example freezeCatalog({ids:["neon-spiral"]}).ids // ["neon-spiral"] (frozen)
 */
function freezeCatalog(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freezeCatalog(child);
  return Object.freeze(value);
}

// Numeric rows below are authored composition data (unit-box positions/radii),
// not solver parameters. Repeated endpoint colors make closed ramps seam-free.
export const MULTIPOINT_PRESETS = freezeCatalog([
  preset("neon-spiral", "Neon spiral", "A cyan–pink spiral with violet opposite banks.", [
    boundary(spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.06, endRadius: 0.49, turns: 1.5 }),
      ["#fff5b2", "#29f5dd", "#ff41b4"], ["#5727a3", "#102764", "#350a55"]),
    point(0.08, 0.1, "#120d30"), point(0.92, 0.9, "#191342"),
  ]),
  preset("twin-spiral", "Twin spiral", "Two interleaved arms: hot coral and cool turquoise.",
    [0, Math.PI].map((phase, i) => boundary(
      spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.1, endRadius: 0.5, turns: 1.25, phase }),
      i ? ["#ecffb8", "#34e7ce", "#307fff"] : ["#fff0c2", "#ff647c", "#ae36d9"],
      i ? ["#153657", "#10234e", "#271646"] : ["#6b255d", "#491c66", "#28174d"]))),
  preset("acid-ribbons", "Acid ribbons", "Three broad sine boundaries in lime, pink and electric blue.",
    [0.22, 0.5, 0.78].map((y, i) => boundary(
      waveNodes({ x0: -0.08, x1: 1.08, y, amplitude: 0.12, cycles: 1.25 }),
      [["#faff52", "#62ff8a", "#fe70ea"], ["#ff54d5", "#faff65", "#44fff0"], ["#52b5ff", "#dd67ff", "#a1ff55"]][i],
      ["#301255", "#202071", "#441343"]))),
  preset("chromatic-rings", "Chromatic rings", "Nested off-center circles with contrasting rainbow banks.",
    [0.13, 0.27, 0.43, 0.61].map((radius, i) => boundary(ellipseNodes(0.42, 0.48, radius),
      ["#ff737e", "#ffe46e", "#58eddb", "#ff737e"],
      ["#6b1c8e", "#123777", "#30236c", "#6b1c8e"].map((color, j, colors) => colors[(j + i) % (colors.length - 1)]), true))),
  preset("aurora-curtains", "Aurora curtains", "Sweeping green, cyan and lilac curtains over deep blue.", [
    ...[0.25, 0.49, 0.73].map((y, i) => boundary(
      waveNodes({ x0: -0.08, x1: 1.08, y, amplitude: 0.1, cycles: 0.75, phase: -Math.PI / 2 }),
      [["#215e78", "#91ffc4", "#427fc1"], ["#38568f", "#46eed7", "#cc92ff"], ["#263968", "#648dca", "#ac6ce0"]][i],
      ["#09182f", "#122e4c", "#201738"])),
    point(0.5, 0.02, "#080f28"), point(0.5, 0.98, "#11172d"),
  ]),
  preset("prism-fan", "Prism fan", "Separated straight rays spread from a narrow throat into a spectrum.",
    ["#fa4869", "#ffb84d", "#e4f878", "#51e6cb", "#718cff", "#c579f0"].map((color, i, colors) => {
      const t = i / (colors.length - 1);
      return boundary([[0.06, 0.36 + 0.28 * t, 0, 0, 0, 0], [1.06, -0.06 + 1.12 * t, 0, 0, 0, 0]],
        ["#fff1ce", color]);
    })),
  preset("rainbow-arches", "Rainbow arches", "Six broad nested rainbow waves with independent color stops.",
    ["#ff527a", "#ffae55", "#ffe77a", "#73efb8", "#65c6ff", "#ae8bfa"].map((color, i) => boundary(
      waveNodes({ x0: -0.08, x1: 1.08, y: 0.4 + i * 0.1, amplitude: -0.3, cycles: 0.5 }),
      [color, "#fff0ec", color]))),
  preset("warm-bokeh", "Warm bokeh", "Three amber, rose and peach circular glows on a wine-dark field.", [
    ...glow(0.23, 0.27, 0.2, ["#fff7d6", "#edaa58", "#2e1525"]),
    ...glow(0.73, 0.37, 0.23, ["#ffe3d8", "#ef7884", "#2e1525"]),
    ...glow(0.43, 0.79, 0.16, ["#fff0cf", "#d98551", "#2e1525"]),
  ]),
  preset("cool-bokeh", "Cool bokeh", "Four mint, ice-blue and lavender glows on midnight blue.", [
    ...glow(0.2, 0.22, 0.16, ["#ecffff", "#70d8ea", "#101b38"]),
    ...glow(0.7, 0.26, 0.21, ["#f1edff", "#a493ed", "#101b38"]),
    ...glow(0.3, 0.72, 0.22, ["#e3fff4", "#62c8b9", "#101b38"]),
    ...glow(0.8, 0.78, 0.13, ["#e5eeff", "#699bdf", "#101b38"]),
  ]),
  preset("lava-lagoons", "Lava lagoons", "Tall molten pools, orange rims and dark plum surrounding banks.", [
    ...[[0.22, 0.36, 0.13, 0.3], [0.73, 0.66, 0.18, 0.29], [0.68, 0.13, 0.23, 0.09]].flatMap(([cx, cy, rx, ry]) => [
      point(cx, cy, "#ffe79b"),
      boundary(ellipseNodes(cx, cy, rx, ry), ["#ff8148", "#ef345f", "#ff8148"], ["#431027", "#210e31", "#431027"], true),
    ]),
  ]),
  preset("candy-vortex", "Candy vortex", "A reverse pastel spiral with strawberry and mint opposite banks.", [
    boundary(spiralNodes({ cx: 0.47, cy: 0.52, startRadius: 0.08, endRadius: 0.48, turns: -1.25, phase: Math.PI / 3 }),
      ["#fff2c5", "#ff9dc7", "#d7b4ff", "#a6f3ed"], ["#f29bbc", "#b88ce6", "#75ced7", "#ffe0ed"]),
    boundary(ellipseNodes(0.5, 0.5, 0.68), ["#fce4ee"], null, true),
  ]),
  preset("sunset-tide", "Sunset tide", "A peach sun above plum, coral and indigo tidal bands.", [
    ...glow(0.5, 0.2, 0.15, ["#fff4b8", "#ffbb76", "#ef7f89"]),
    ...[0.48, 0.69, 0.9].map((y, i) => boundary(
      waveNodes({ x0: -0.08, x1: 1.08, y, amplitude: 0.055, cycles: 0.75 }),
      [["#ba5b89", "#ffc19a", "#ad538c"], ["#5b4a87", "#f38c9c", "#514b89"], ["#223357", "#79669f", "#283956"]][i])),
  ]),
  preset("tidal-lagoon", "Tidal lagoon", "An open turquoise curl winding between sand and deep ocean.", [
    boundary(spiralNodes({ cx: 0.4, cy: 0.5, startRadius: 0.12, endRadius: 0.59, turns: 0.75, phase: Math.PI }),
      ["#fff1c6", "#70e1c6", "#259bc0"], ["#34a1b0", "#17617e", "#112e57"]),
    point(0.08, 0.08, "#f3d9a7"), point(0.93, 0.88, "#122e59"),
  ]),
  preset("velvet-folds", "Velvet folds", "Two slow burgundy waves edged with mauve and warm rose.", [
    ...[0.3, 0.7].map((y) => boundary(waveNodes({ x0: -0.08, x1: 1.08, y, amplitude: 0.18, cycles: 0.5, phase: -Math.PI / 2 }),
      ["#4b1949", "#e69bb6", "#83345d"], ["#190e2b", "#642449", "#251030"])),
    point(0.82, 0.12, "#d39aa4"),
  ]),
]);

/**
 * Pure function. Looks up a stable id and clones its immutable native paint.
 * Callers may edit every nested node/stop without touching catalog or other fills.
 * Unknown ids throw; there is no default/fallback preset.
 * @param {string} id - One of MULTIPOINT_PRESETS' permanent ids.
 * @returns {object} Fresh mutable {type:'multipointGradient',multipoint:{features}}.
 * @example getMultipointPreset("warm-bokeh").multipoint.features.length // 9
 */
export function getMultipointPreset(id) {
  const entry = MULTIPOINT_PRESETS.find((preset) => preset.id === id);
  if (!entry) throw new Error(`Unknown Multipoint preset: ${String(id)}`);
  return structuredClone(entry.paint);
}
