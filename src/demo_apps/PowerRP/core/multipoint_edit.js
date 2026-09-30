/**
 * MULTIPOINT CANVAS EDITING — the pure half of the in-canvas Multipoint editor
 * (the "island": web/MultipointIsland.svelte + web/multipointCanvas.js). The
 * manifest's "In-canvas Multipoint editing" section states the design and why.
 *
 * The canvas speaks in HANDLE IDS (app.handleSelection) and LOCAL POINTS; the
 * document speaks in feature paths, stop lists and arc-length offsets. Every
 * translation between the two lives here, DOM-free, so the rules are testable in
 * bare node (tests/multipoint_edit_test.js) and the web layer only moves data.
 *
 * Frames: nodes and stop offsets are in UNIT paint-box coordinates (the stored
 * frame, arc length measured there exactly as the stop beads and the solver do);
 * hit distances are in LOCAL px (unit × box size), because the box may be
 * non-square and a hit tolerance is a screen idea.
 */
import { evalCubic } from "./morph_geometry.js";
import { elementActive, withElementsOrderedBy } from "./lists.js";
import { getPath } from "./deltas.js";
import { rgbToHex } from "./interpolators.js";
import { MULTIPOINT_TYPE, featurePolyline, insertFeatureNode, nodeCubic, reversedNodeOrder } from "./multipoint.js";
import { multipointFeaturesPath, multipointHandleId, parseMultipointHandleId } from "./paint_handles.js";
import { parseColor } from "../render_gpu/ir.js";

/** How close (as a fraction of the path's arc length) a stop must sit to a node to
 *  be "the colour AT that node". Stops this editor inserts land exactly on the node;
 *  the tolerance only absorbs float noise and a bead dragged onto the node by hand. */
export const NODE_STOP_TOLERANCE = 1e-3;
/** Uniform samples per cubic before refinement. A heuristic, not a proof: a cubic's
 *  distance function has few local minima, and this many samples separate them for
 *  every curve the editor and the presets draw. */
const CUBIC_SEARCH_SAMPLES = 64;
/** Golden-section steps; each shrinks the bracket by GOLDEN, so 40 takes the
 *  two-sample bracket (1/32 in t) below 1e-9 — far under a pixel. */
const CUBIC_REFINE_ITERATIONS = 40;
const GOLDEN = (Math.sqrt(5) - 1) / 2;
/** A split this close to a segment end would stack a node on an existing one. */
const SPLIT_END_MARGIN = 1e-6;
const BYTE_MAX = 255;

/**
 * Pure function. Is a stored value an `=` equation rather than a literal? The
 * universal any-type marker (web/ColorField.svelte isEquationColor states the same
 * rule for the display side; core cannot import web).
 * @param {*} value - A stored leaf.
 * @returns {boolean}
 * @example isEquationString("= a.fill") // true
 * @example isEquationString("#ff0000") // false
 */
export function isEquationString(value) {
  return typeof value === "string" && /^\s*=/.test(value);
}

/**
 * Pure function. The paint keys of `state` that currently hold a Multipoint paint,
 * in the caller's (Inspector) order.
 * @param {object} state - Item state.
 * @param {string[]} keys - Paint-capable keys.
 * @returns {string[]}
 * @example multipointKeys({fill:{type:"multipointGradient"}, stroke:"#000"}, ["fill","stroke"]) // ["fill"]
 */
export function multipointKeys(state, keys) {
  return keys.filter((k) => state?.[k]?.type === MULTIPOINT_TYPE);
}

/**
 * Pure function. WHICH Multipoint paint the island edits: the key of the first
 * selected Multipoint handle, else the first Multipoint key in Inspector order.
 * @param {object} state - Item state.
 * @param {string[]} keys - Paint-capable keys.
 * @param {string[]} ids - Selected handle ids.
 * @returns {string|null}
 * @example multipointEditKey({fill:{type:"multipointGradient"}, stroke:{type:"multipointGradient"}}, ["fill","stroke"], ["stroke-mp-0-node-0"]) // "stroke"
 * @example multipointEditKey({fill:{type:"multipointGradient"}}, ["fill"], []) // "fill"
 * @example multipointEditKey({fill:"#fff"}, ["fill"], []) // null
 */
export function multipointEditKey(state, keys, ids) {
  const live = multipointKeys(state, keys);
  const selected = ids.map(parseMultipointHandleId).find((h) => h && live.includes(h.key));
  return selected?.key ?? live[0] ?? null;
}

/**
 * Pure function. Stored indices of a feature's visible nodes.
 * @param {object} feature - {nodes, nodesActive?}.
 * @returns {number[]}
 * @example visibleNodeIndices({nodes:[[0],[1],[2]], nodesActive:[true,false]}) // [0, 2]
 */
export function visibleNodeIndices(feature) {
  return feature.nodes.map((_, i) => i).filter((i) => elementActive(feature.nodesActive, i));
}

/**
 * Pure function. The DRAWN segments of a source, in traversal order, each with the
 * insertion index insertFeatureNode needs to split exactly that segment (a closing
 * segment splits at the seam, index N). Hidden nodes are bypassed as the renderer does.
 * @param {object} feature - Stored feature with numeric [N,6] nodes.
 * @returns {{insertIndex:number, from:number[], to:number[], cubic:number[][]}[]} [] for a point.
 * @example featureSegments({nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0]], closed:false}).map((s) => s.insertIndex) // [1]
 * @example featureSegments({nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0],[1,1,0,0,0,0]], closed:true}).map((s) => s.insertIndex) // [1, 2, 3]
 */
export function featureSegments(feature) {
  const visible = visibleNodeIndices(feature);
  if (visible.length < 2) return [];
  const pairs = visible.slice(1).map((after, k) => [visible[k], after, visible[k] + 1]);
  if (feature.closed) pairs.push([visible.at(-1), visible[0], feature.nodes.length]);
  return pairs.map(([a, b, insertIndex]) => ({
    insertIndex, from: feature.nodes[a], to: feature.nodes[b], cubic: nodeCubic(feature.nodes[a], feature.nodes[b]),
  }));
}

/**
 * Pure function. Nearest point on one cubic to `point`, in the control points' frame:
 * dense uniform samples, then golden-section refinement around the best one.
 * @param {number[][]} cubic - [[x0,y0],[x1,y1],[x2,y2],[x3,y3]].
 * @param {{x:number,y:number}} point - Query point.
 * @returns {{t:number, x:number, y:number, distance:number}}
 * @example Math.round(nearestOnCubic([[0,0],[0,0],[10,0],[10,0]], {x:5, y:3}).distance * 1e6) / 1e6 // 3
 * @example nearestOnCubic([[0,0],[0,0],[10,0],[10,0]], {x:-4, y:0}).t // 0 (beyond the start clamps to the end point)
 */
export function nearestOnCubic(cubic, point) {
  const distance = (t) => { const [x, y] = evalCubic(cubic, t); return Math.hypot(x - point.x, y - point.y); };
  let best = 0, bestDistance = Infinity;
  for (let i = 0; i <= CUBIC_SEARCH_SAMPLES; i++) {
    const d = distance(i / CUBIC_SEARCH_SAMPLES);
    if (d < bestDistance) { bestDistance = d; best = i / CUBIC_SEARCH_SAMPLES; }
  }
  let lo = Math.max(0, best - 1 / CUBIC_SEARCH_SAMPLES), hi = Math.min(1, best + 1 / CUBIC_SEARCH_SAMPLES);
  for (let i = 0; i < CUBIC_REFINE_ITERATIONS; i++) {
    const a = hi - GOLDEN * (hi - lo), b = lo + GOLDEN * (hi - lo);
    if (distance(a) < distance(b)) hi = b; else lo = a;
  }
  // The refinement can only improve on the sampled optimum; keep the sample when an
  // endpoint (t = 0 or 1) is the true answer, which golden section never reaches.
  const refined = (lo + hi) / 2;
  const t = distance(refined) < bestDistance ? refined : best;
  const [x, y] = evalCubic(cubic, t);
  return { t, x, y, distance: Math.hypot(x - point.x, y - point.y) };
}

/**
 * Pure function. The nearest drawn place on one source's path, in LOCAL px.
 * @param {object} feature - Stored feature with numeric nodes.
 * @param {{x:number,y:number}} point - Local px.
 * @param {{w:number,h:number}} box - Paint box size, local px.
 * @returns {{insertIndex:number, t:number, x:number, y:number, distance:number}|null} null for a point source.
 * @example nearestFeatureHit({nodes:[[0,0.5,0,0,0,0],[1,0.5,0,0,0,0]]}, {x:50, y:30}, {w:100, h:40}).insertIndex // 1
 * @example Math.round(nearestFeatureHit({nodes:[[0,0.5,0,0,0,0],[1,0.5,0,0,0,0]]}, {x:50, y:30}, {w:100, h:40}).distance) // 10
 */
export function nearestFeatureHit(feature, point, box) {
  let best = null;
  for (const segment of featureSegments(feature)) {
    const hit = nearestOnCubic(segment.cubic.map(([x, y]) => [x * box.w, y * box.h]), point);
    if (!best || hit.distance < best.distance) best = { insertIndex: segment.insertIndex, ...hit };
  }
  return best;
}

/**
 * Pure function. The nearest visible Multipoint PATH across `keys` within
 * `tolerance` local px — where a double-click or the split mode lands. Reads the
 * DRAWN (evaluated) state; the caller re-checks the RAW feature before writing.
 * @param {object} state - Evaluated item state with w/h (the unsigned box).
 * @param {string[]} keys - Paint-capable keys.
 * @param {{x:number,y:number}} point - Local px.
 * @param {number} tolerance - Local px.
 * @returns {{key:string, feature:number, featurePath:Array, insertIndex:number, t:number, x:number, y:number, distance:number}|null}
 * @example multipointPathHit({w:100,h:100,fill:{type:"multipointGradient",multipoint:{features:[{nodes:[[0,0.5,0,0,0,0],[1,0.5,0,0,0,0]],stops:[]}]}}}, ["fill"], {x:30,y:52}, 8).featurePath // ["fill","multipoint","features",0]
 * @example multipointPathHit({w:100,h:100,fill:{type:"multipointGradient",multipoint:{features:[{nodes:[[0,0.5,0,0,0,0],[1,0.5,0,0,0,0]],stops:[]}]}}}, ["fill"], {x:30,y:80}, 8) // null
 */
export function multipointPathHit(state, keys, point, tolerance) {
  let best = null;
  const box = { w: state.w ?? 0, h: state.h ?? 0 };
  for (const key of multipointKeys(state, keys)) {
    const paint = state[key], source = paint.multipoint ?? paint;
    source.features.forEach((feature, fi) => {
      if (!elementActive(source.featuresActive, fi)) return;
      const hit = nearestFeatureHit(feature, point, box);
      if (hit && hit.distance <= tolerance && (!best || hit.distance < best.distance))
        best = { key, feature: fi, featurePath: [...multipointFeaturesPath(paint, key), fi], ...hit };
    });
  }
  return best;
}

/**
 * Pure function. The split a path hit asks for, as a new stored feature, or a
 * refusal sentence. Refuses a hit sitting on an existing node (t at a segment end).
 * @param {object} feature - RAW stored feature.
 * @param {{insertIndex:number, t:number}} hit - From multipointPathHit.
 * @returns {{feature:object, node:number}|{refusal:string}} `node` is the new node's stored index.
 * @example splitAtHit({nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0]], stops:[{offset:0,color:"#f00"}]}, {insertIndex:1, t:0.5}).node // 1
 * @example splitAtHit({nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0]], stops:[]}, {insertIndex:1, t:0}).refusal // "That spot is an existing node — nothing to split."
 */
export function splitAtHit(feature, hit) {
  const refusal = featureEditRefusal(feature, "split");
  if (refusal) return { refusal };
  if (hit.t <= SPLIT_END_MARGIN || hit.t >= 1 - SPLIT_END_MARGIN) return { refusal: "That spot is an existing node — nothing to split." };
  return { feature: insertFeatureNode(feature, hit.insertIndex, hit.t), node: hit.insertIndex };
}

/**
 * Pure function. Normalized arc length at a visible node — the offset a colour stop
 * needs to sit ON that node. Same per-segment polylines and unit-box metric the
 * stop beads and the solver use (featurePolyline appends segments independently,
 * so per-segment lengths sum to the whole chain's).
 * @param {object} feature - Stored feature with numeric nodes.
 * @param {number} nodeIndex - Stored node index.
 * @returns {number|null} null for a hidden node or a point source.
 * @example featureNodeOffset({nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0],[1,1,0,0,0,0]], closed:false}, 1) // 0.5
 * @example featureNodeOffset({nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0],[1,1,0,0,0,0]], closed:false}, 2) // 1
 * @example featureNodeOffset({nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0]], nodesActive:[true,false]}, 1) // null
 */
export function featureNodeOffset(feature, nodeIndex) {
  const visible = visibleNodeIndices(feature);
  const k = visible.indexOf(nodeIndex);
  if (k < 0 || visible.length < 2) return null;
  const lengths = featureSegments(feature).map((s) => polylineLength(featurePolyline([s.from, s.to])));
  const total = lengths.reduce((sum, v) => sum + v, 0);
  if (!total) return 0;
  return lengths.slice(0, k).reduce((sum, v) => sum + v, 0) / total;
}

/**
 * Pure function. Total length of an (x,y) polyline.
 * @param {number[][]} points - [T,2].
 * @returns {number}
 * @example polylineLength([[0,0],[3,4],[3,5]]) // 6
 */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

/**
 * Pure function. The stored index of the visible, numeric-offset stop nearest
 * `offset` within `tolerance`, or -1. On a closed path offset 1 IS offset 0.
 * @param {object} feature - {stops, stopsActive?, closed?}.
 * @param {number} offset - Normalized arc length.
 * @param {number} tolerance - Arc-length fraction.
 * @returns {number}
 * @example stopIndexNear({stops:[{offset:0},{offset:0.5}]}, 0.5004, 1e-3) // 1
 * @example stopIndexNear({stops:[{offset:0},{offset:0.5}]}, 0.25, 1e-3) // -1
 * @example stopIndexNear({closed:true, stops:[{offset:1}]}, 0, 1e-3) // 0
 */
export function stopIndexNear(feature, offset, tolerance = NODE_STOP_TOLERANCE) {
  let best = -1, bestGap = Infinity;
  feature.stops.forEach((stop, i) => {
    if (!elementActive(feature.stopsActive, i) || !Number.isFinite(stop?.offset)) return;
    const raw = Math.abs(stop.offset - offset);
    const gap = feature.closed ? Math.min(raw, 1 - raw) : raw;
    if (gap <= tolerance && gap < bestGap) { best = i; bestGap = gap; }
  });
  return best;
}

/**
 * Pure function. A stored colour side interpolated along a source's visible stops at
 * normalized arc length `offset`, the way the solver reads stops: encoded sRGB,
 * PREMULTIPLIED before interpolating, coincident offsets last-wins, ends clamped.
 * This is the semantic twin of core/multipoint_diffusion.js's private sampleStops
 * (recorded debt in concerns.md: unify when that file is free). Quantized to 8-bit
 * hex because that is the stored colour form.
 * @param {object} feature - Stored feature (hex/CSS colours, numeric offsets).
 * @param {number} offset - In [0,1].
 * @param {"color"|"rightColor"} field - Stored side; a stop without rightColor reads color.
 * @returns {string} "#rrggbb", or "#rrggbbaa" when not opaque.
 * @example stopColorAt({stops:[{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}]}, 0.5, "color") // "#808080"
 * @example stopColorAt({stops:[{offset:0,color:"#ff0000"},{offset:1,color:"#0000ff00"}]}, 0.5, "color") // "#ff000080" (premultiplied: a transparent end fades, it does not tint)
 * @example stopColorAt({stops:[{offset:0.25,color:"#ff0000"},{offset:1,color:"#0000ff"}]}, 0, "color") // "#ff0000" (clamped before the first stop)
 * @example stopColorAt({stops:[{offset:0,color:"#000000",rightColor:"#ffffff"}]}, 0.7, "rightColor") // "#ffffff"
 */
export function stopColorAt(feature, offset, field) {
  const stops = feature.stops
    .filter((_, i) => elementActive(feature.stopsActive, i))
    .map((s) => ({ offset: Math.max(0, Math.min(1, s.offset)), rgba: parseColor(s[field] ?? s.color) }))
    .sort((a, b) => a.offset - b.offset); // stable, as parseMultipoint's sort
  if (!stops.length) throw new Error("stopColorAt: a Multipoint source needs at least one visible colour stop");
  let i = 0;
  while (i + 1 < stops.length && stops[i + 1].offset <= offset) i++;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  const u = a.offset === b.offset ? 0 : Math.max(0, Math.min(1, (offset - a.offset) / (b.offset - a.offset)));
  const pa = premultiplied(a.rgba), pb = premultiplied(b.rgba);
  return rgbaHex(unpremultiplied(pa.map((v, c) => v + u * (pb[c] - v))));
}

/** Pure function. Straight → premultiplied RGBA.
 *  @example premultiplied([1, 0.5, 0, 0.5]) // [0.5, 0.25, 0, 0.5] */
function premultiplied([r, g, b, a]) {
  return [r * a, g * a, b * a, a];
}

/** Pure function. Premultiplied → straight RGBA; fully transparent carries no colour.
 *  @example unpremultiplied([0.5, 0.25, 0, 0.5]) // [1, 0.5, 0, 0.5]
 *  @example unpremultiplied([0, 0, 0, 0]) // [0, 0, 0, 0] */
function unpremultiplied([r, g, b, a]) {
  return a > 0 ? [r / a, g / a, b / a, a] : [0, 0, 0, 0];
}

/** Pure function. Straight RGBA floats → stored hex (opaque collapses to 6 digits,
 *  the ColorField storage rule).
 *  @example rgbaHex([1, 0, 0, 1]) // "#ff0000"
 *  @example rgbaHex([1, 0, 0, 0.5]) // "#ff000080" */
function rgbaHex([r, g, b, a]) {
  const bytes = [r, g, b].map((v) => v * BYTE_MAX);
  const alpha = Math.round(a * BYTE_MAX);
  return rgbToHex(alpha >= BYTE_MAX ? bytes : [...bytes, alpha]);
}

/**
 * Pure function. Why a structural canvas edit would bake an equation on this RAW
 * stored feature, as a clause ("its … is equation-driven"), or null when it is safe.
 * Mirrors the Inspector's MultipointField gates.
 * @param {object} feature - RAW stored feature (equations are strings).
 * @param {"split"|"reverse"|"insertStop"|"twoSided"|"closed"|"ramp"} op - The edit.
 * @returns {string|null}
 * @example featureEditRefusal({nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0]], stops:[{offset:0,color:"#f00"}]}, "split") // null
 * @example featureEditRefusal({nodes:"= a.nodes", stops:[]}, "split") // "its nodes, node visibility or Closed flag are equation-driven"
 * @example featureEditRefusal({nodes:[], stops:[{offset:"= t", color:"#f00"}]}, "insertStop") // "its colour list, offsets or colour visibility are equation-driven"
 * @example featureEditRefusal({nodes:[], stops:[], twoSided:"= true"}, "twoSided") // "its Two sides flag is an equation"
 * @example featureEditRefusal({nodes:[], stops:[{offset:0, color:"= a.fill"}]}, "ramp") // "its colour list, offsets, visibility, colours or Closed flag are equation-driven"
 */
export function featureEditRefusal(feature, op) {
  const companionEquation = (active) => typeof active === "string" || Object.values(active ?? {}).some((v) => typeof v === "string");
  const nodesBound = !Array.isArray(feature?.nodes) || companionEquation(feature.nodesActive) || typeof feature.closed === "string"
    || feature.nodes.some((n) => !Array.isArray(n) || n.some((v) => !Number.isFinite(v)));
  const stopsBound = !Array.isArray(feature?.stops) || companionEquation(feature.stopsActive)
    || feature.stops.some((s) => !Number.isFinite(s?.offset));
  if (op === "split") return nodesBound ? "its nodes, node visibility or Closed flag are equation-driven" : null;
  if (op === "insertStop") return stopsBound ? "its colour list, offsets or colour visibility are equation-driven" : null;
  if (op === "reverse") return nodesBound || stopsBound || typeof feature.twoSided === "string"
    ? "its geometry, colour offsets, visibility, Closed or Two sides are equation-driven" : null;
  if (op === "twoSided" || op === "closed") return typeof feature?.[op] === "string" ? `its ${op === "twoSided" ? "Two sides" : "Closed"} flag is an equation` : null;
  // "ramp" REPLACES the whole stop list, so an equation anywhere in it would be lost.
  if (op === "ramp") return stopsBound || feature.stops.some((s) => isEquationString(s?.color) || isEquationString(s?.rightColor))
    || typeof feature.closed === "string" ? "its colour list, offsets, visibility, colours or Closed flag are equation-driven" : null;
  throw new Error(`featureEditRefusal: unknown operation "${op}"`);
}

/**
 * Pure function. The RAW stored feature a Multipoint handle belongs to, with its
 * item-relative path, or null when the paint/list/feature is not stored data.
 * @param {object} state - RAW item state.
 * @param {{key:string, feature:number}} h - A parsed handle id.
 * @returns {{feature:object, featurePath:Array}|null}
 * @example handleFeature({fill:{type:"multipointGradient",multipoint:{features:[{nodes:[],stops:[]}]}}}, {key:"fill", feature:0}).featurePath // ["fill","multipoint","features",0]
 */
export function handleFeature(state, h) {
  const paint = state?.[h.key];
  if (paint?.type !== MULTIPOINT_TYPE) return null;
  const features = (paint.multipoint ?? paint).features;
  const feature = Array.isArray(features) ? features[h.feature] : null;
  if (!feature || typeof feature !== "object" || Array.isArray(feature)) return null;
  return { feature, featurePath: [...multipointFeaturesPath(paint, h.key), h.feature] };
}

/**
 * Pure function. WHAT COLOUR EACH SELECTED HANDLE EDITS. A point's anchor → its
 * first visible stop's colour; a colour bead → that stop's side; a path node → the
 * colour AT the node (the stop within NODE_STOP_TOLERANCE, both sides on a two-sided
 * path) or a PENDING stop there when none exists; a Bézier control → nothing.
 * Equation-bound colours are reported in `skipped` instead of targeted, because a
 * picked colour would overwrite the equation.
 * @param {object} state - RAW item state (the committed fold; equations unevaluated).
 * @param {string[]} ids - Selected handle ids; non-Multipoint ids are ignored.
 * @returns {{targets: object[], skipped: string[]}} Each target is {side, path} for a
 *   stored colour leaf or {side, featurePath, offset} for a pending stop.
 * @example handleColorTargets({fill:{type:"multipointGradient",multipoint:{features:[{nodes:[[0.5,0.5,0,0,0,0]],stops:[{offset:0,color:"#f00"}]}]}}}, ["fill-mp-0-node-0"]).targets // [{side:"color", path:["fill","multipoint","features",0,"stops",0,"color"]}]
 * @example handleColorTargets({fill:{type:"multipointGradient",multipoint:{features:[{nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0]],stops:[{offset:0,color:"#f00"}]}]}}}, ["fill-mp-0-node-1"]).targets // [{side:"color", featurePath:["fill","multipoint","features",0], offset:1}]
 */
export function handleColorTargets(state, ids) {
  const targets = [], skipped = [], seen = new Set();
  const push = (target) => {
    const k = JSON.stringify(target);
    if (!seen.has(k)) { seen.add(k); targets.push(target); }
  };
  for (const id of ids) {
    const h = parseMultipointHandleId(id);
    if (!h || h.role === "control") continue;
    const owner = handleFeature(state, h);
    const name = `source ${h.feature + 1}`;
    if (!owner || !Array.isArray(owner.feature.stops) || !Array.isArray(owner.feature.nodes)) {
      skipped.push(`${name} is equation-driven`);
      continue;
    }
    const { feature, featurePath } = owner;
    const leaf = (index, side) => {
      if (isEquationString(feature.stops[index]?.[side])) skipped.push(`${name} colour ${index + 1} is an equation`);
      else push({ side, path: [...featurePath, "stops", index, side] });
    };
    if (h.role === "stop") { leaf(h.index, h.side); continue; }
    if (visibleNodeIndices(feature).length === 1) {
      const first = feature.stops.findIndex((_, i) => elementActive(feature.stopsActive, i));
      if (first < 0) skipped.push(`${name} has no visible colour`);
      else leaf(first, "color");
      continue;
    }
    const geometry = featureEditRefusal(feature, "split");
    if (geometry) { skipped.push(`${name}: ${geometry}`); continue; }
    const offset = featureNodeOffset(feature, h.index);
    if (offset === null) { skipped.push(`node ${h.index + 1} of ${name} is hidden, so it has no place on the path`); continue; }
    const sides = feature.twoSided === true ? ["color", "rightColor"] : ["color"];
    const at = stopIndexNear(feature, offset);
    if (at >= 0) { for (const side of sides) leaf(at, side); continue; }
    const stops = featureEditRefusal(feature, "insertStop");
    if (stops) { skipped.push(`${name}: ${stops}`); continue; }
    for (const side of sides) push({ side, featurePath, offset });
  }
  return { targets, skipped };
}

/**
 * Pure function. The colour a target currently shows: a leaf's stored value, or a
 * pending stop's interpolated colour.
 * @param {object} state - RAW item state.
 * @param {object} target - From handleColorTargets.
 * @returns {*} Stored colour (hex/CSS string).
 * @example targetColor({fill:{multipoint:{features:[{stops:[{offset:0,color:"#f00"}]}]}}}, {side:"color", path:["fill","multipoint","features",0,"stops",0,"color"]}) // "#f00"
 */
export function targetColor(state, target) {
  if (target.path) return getPath(state, target.path);
  return stopColorAt(getPath(state, target.featurePath), target.offset, target.side);
}

/**
 * Pure function. The setPreview pairs (item-relative paths) giving every target
 * `hex` as ONE edit. A leaf target writes its leaf. A feature with pending stops
 * gets ONE whole-stops-list write instead — its leaf targets folded in, each new stop
 * inserted in offset order with the unpicked side interpolated (so that side's
 * picture is unchanged), and the visibility companion aligned — so no two pairs can
 * address overlapping paths. Must be computed from the COMMITTED fold: the preview
 * is replaced wholesale on every tick.
 * @param {object} state - RAW committed item state.
 * @param {object[]} targets - From handleColorTargets.
 * @param {string} hex - The picked colour, stored form.
 * @returns {Array<[Array, *]>}
 * @example colorWritePairs({fill:{multipoint:{features:[{stops:[{offset:0,color:"#000"}]}]}}}, [{side:"color", path:["fill","multipoint","features",0,"stops",0,"color"]}], "#ff0000") // [[["fill","multipoint","features",0,"stops",0,"color"],"#ff0000"]]
 * @example colorWritePairs({fill:{multipoint:{features:[{stops:[{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}]}]}}}, [{side:"color", featurePath:["fill","multipoint","features",0], offset:0.5}], "#ff0000")[0][1] // [{offset:0,color:"#000000"},{offset:0.5,color:"#ff0000",rightColor:"#808080"},{offset:1,color:"#ffffff"}]
 */
export function colorWritePairs(state, targets, hex) {
  const pending = new Map();
  for (const t of targets) {
    if (!t.featurePath) continue;
    const k = JSON.stringify(t.featurePath);
    if (!pending.has(k)) pending.set(k, { featurePath: t.featurePath, offsets: new Map() });
    const sides = pending.get(k).offsets;
    if (!sides.has(t.offset)) sides.set(t.offset, new Set());
    sides.get(t.offset).add(t.side);
  }
  const leafFeature = (path) => JSON.stringify(path.slice(0, -3)); // [...featurePath, "stops", i, side]
  const pairs = targets.filter((t) => t.path && !pending.has(leafFeature(t.path))).map((t) => [t.path, hex]);
  for (const [k, { featurePath, offsets }] of pending) {
    const feature = getPath(state, featurePath);
    const refusal = featureEditRefusal(feature, "insertStop");
    if (refusal) throw new Error(`colorWritePairs: cannot insert a colour stop — ${refusal}`);
    const stops = feature.stops.map((s) => ({ ...s }));
    for (const t of targets) if (t.path && leafFeature(t.path) === k) stops[t.path.at(-2)][t.side] = hex;
    const added = [...offsets].map(([offset, sides]) => ({
      offset,
      color: sides.has("color") ? hex : stopColorAt(feature, offset, "color"),
      rightColor: sides.has("rightColor") ? hex : stopColorAt(feature, offset, "rightColor"),
    }));
    const list = [...stops, ...added];
    const active = feature.stopsActive != null ? [...feature.stops.map((_, i) => feature.stopsActive[i] ?? true), ...added.map(() => true)] : undefined;
    const ordered = withElementsOrderedBy({ list, active }, list.map((s) => s.offset));
    pairs.push([[...featurePath, "stops"], ordered.list]);
    if (ordered.active) pairs.push([[...featurePath, "stopsActive"], ordered.active]);
  }
  return pairs;
}

/**
 * Pure function. The distinct PATH sources (≥ 2 visible nodes) owning the selected
 * Multipoint handles — what Two sides / Closed / Reverse act on. Points are left out:
 * those flags mean nothing on a single node.
 * @param {object} state - RAW item state.
 * @param {string[]} ids - Selected handle ids.
 * @returns {{key:string, index:number, featurePath:Array, feature:object}[]}
 * @example selectedPathFeatures({fill:{type:"multipointGradient",multipoint:{features:[{nodes:[[0,0,0,0,0,0],[1,0,0,0,0,0]],stops:[]},{nodes:[[0,0,0,0,0,0]],stops:[]}]}}}, ["fill-mp-0-node-1","fill-mp-0-stop-0","fill-mp-1-node-0"]).map((f) => f.index) // [0]
 */
export function selectedPathFeatures(state, ids) {
  const out = [], seen = new Set();
  for (const id of ids) {
    const h = parseMultipointHandleId(id);
    const owner = h && handleFeature(state, h);
    const k = h && `${h.key}/${h.feature}`;
    if (!owner || seen.has(k) || !Array.isArray(owner.feature.nodes) || visibleNodeIndices(owner.feature).length < 2) continue;
    seen.add(k);
    out.push({ key: h.key, index: h.feature, featurePath: owner.featurePath, feature: owner.feature });
  }
  return out;
}

/**
 * Pure function. Handle ids after reverseFeature, so a selection keeps pointing at
 * the SAME physical nodes and beads: nodes follow reversedNodeOrder, incoming ↔
 * outgoing controls swap, stops reverse, and on a two-sided path a bead changes side
 * (reverseFeature swaps color/rightColor to keep the physical sides). Ids of other
 * sources pass through untouched.
 * @param {string[]} ids - Selected handle ids before the reverse.
 * @param {string} key - Paint key of the reversed source.
 * @param {number} index - Source index.
 * @param {object} feature - The source as it was BEFORE reversing.
 * @returns {string[]}
 * @example reversedHandleIds(["fill-mp-0-node-0", "fill-mp-0-node-1-outgoing", "fill-mp-0-stop-0"], "fill", 0, {nodes:[[0],[1],[2]], stops:[{},{}], closed:false}) // ["fill-mp-0-node-2", "fill-mp-0-node-1-incoming", "fill-mp-0-stop-1"]
 * @example reversedHandleIds(["fill-mp-0-stop-0"], "fill", 0, {nodes:[[0],[1]], stops:[{}], twoSided:true}) // ["fill-mp-0-stop-0-right"]
 */
export function reversedHandleIds(ids, key, index, feature) {
  const order = reversedNodeOrder(feature);
  return ids.map((id) => {
    const h = parseMultipointHandleId(id);
    if (!h || h.key !== key || h.feature !== index) return id;
    if (h.role === "stop") return multipointHandleId({ ...h, index: feature.stops.length - 1 - h.index,
      side: feature.twoSided ? (h.side === "color" ? "rightColor" : "color") : h.side });
    const moved = { ...h, index: order.indexOf(h.index) };
    if (h.role === "control") moved.control = h.control === "incoming" ? "outgoing" : "incoming";
    return multipointHandleId(moved);
  });
}
