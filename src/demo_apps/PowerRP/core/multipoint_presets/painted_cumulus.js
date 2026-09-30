/**
 * "Animation backgrounds" — native Multipoint presets. A towering hand-painted cumulus bank over a summer meadow.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { hermiteNodes, finiteGeometry, polylineNodes, catmullRomNodes } from "../multipoint_shapes.js";

const sin = Math.sin, cos = Math.cos;

/**
 * Pure function. Constant/ramped line lying exactly ON a box edge: a broad wash pin.
 * @param {"top"|"bottom"|"left"|"right"} side - Box edge.
 * @param {string[]} colors - Ramp along the edge (left->right or top->bottom).
 * @returns {object} Open single-sided feature.
 * @example edge("top", ["#ffffff"]).nodes[0].slice(0, 2) // [0,0]
 */
export function edge(side, colors) {
  const ends = { top: [[0, 0], [1, 0]], bottom: [[0, 1], [1, 1]], left: [[0, 0], [0, 1]], right: [[1, 0], [1, 1]] }[side];
  if (!ends) throw new Error(`Unknown box edge: ${side}`);
  return boundary(polylineNodes(ends), colors);
}

/**
 * Pure function. Horizontal line across the whole box; one colour above, optionally another below.
 * @param {number} y - Line height in [0,1].
 * @param {string[]} above - Colour ramp above the line (left->right).
 * @param {string[]|null} below - Ramp below (same length), or null for a single-sided pin.
 * @returns {object} Open feature from x=0 to x=1.
 * @example hline(0.5, ["#ffffff"], ["#000000"]).twoSided // true
 */
export function hline(y, above, below = null) {
  return boundary(polylineNodes([[0, y], [1, y]]), above, below);
}

/**
 * Pure function. Closed cumulus outline (flat base, scalloped top), clockwise on screen from
 * the base's right corner: base right->left, up the left flank, over the domes, down the right.
 * @param {number} cx - Centre x of the base.
 * @param {number} base - Base y.
 * @param {number} width - Base width.
 * @param {number[]} domes - Dome heights as fractions of `height`, left->right.
 * @param {number} height - Tallest possible dome height.
 * @returns {number[][]} [4 + 2*domes.length, 6] closed-curve nodes.
 * @example cumulusNodes(0.5, 0.8, 0.4, [0.6, 1, 0.7], 0.2).length // 10
 */
export function cumulusNodes(cx, base, width, domes, height) {
  finiteGeometry([cx, base, width, height, ...domes]);
  if (domes.length < 2) throw new Error("cumulusNodes needs at least two domes");
  const left = cx - width / 2, n = domes.length;
  const pts = [[left + width, base], [cx, base + 0.004], [left, base]];
  domes.forEach((d, i) => {
    if (i === 0) pts.push([left + 0.004, base - 0.35 * height * d]);
    else pts.push([left + width * i / n, base - height * 0.42 * Math.min(domes[i - 1], d)]);
    pts.push([left + width * (i + 0.5) / n, base - height * d]);
  });
  pts.push([left + width - 0.004, base - 0.3 * height * domes[n - 1]]);
  return catmullRomNodes(pts, true);
}

/**
 * Pure function. A painted cumulus: lit white top, cool shadowed base, crisp poster-colour edge.
 * Inside ramp (4 stops, closed seam repeats): base shade -> shade -> lit top -> shade.
 * @param {object} o - {cx, base, width, height, domes, sky, lit, shade}.
 * @returns {object} Closed two-sided feature (outside = sky, inside = shade/lit ramp).
 * @example cumulus({cx:.5,base:.8,width:.4,height:.2,domes:[.6,1,.7],sky:"#9cc8ec",lit:"#ffffff",shade:"#a3b1de"}).closed // true
 */
export function cumulus({ cx, base, width, height, domes, sky, lit, shade }) {
  const f = boundary(cumulusNodes(cx, base, width, domes, height), [sky, sky, sky, sky], [shade, shade, lit, shade], true);
  return { ...f, stops: f.stops.map((s, i) => ({ ...s, offset: [0, 0.3, 0.62, 1][i] })) };
}

/**
 * Pure function. Upper envelope of overlapping circles as cubic nodes running left->right
 * (clockwise on screen over the top), with sharp valleys where neighbours meet.
 * @param {number[][]} circles - [[cx, cy, r], ...] left->right; adjacent circles must intersect.
 * @param {number} startAngle - Screen angle on circle 0 where the chain starts (-PI = leftmost).
 * @param {number} endAngle - Screen angle on the last circle where it ends (0 = rightmost).
 * @returns {number[][]} nodes; one span per <=120 degrees of arc.
 * @example arcChain([[0.3,0.5,0.1],[0.42,0.45,0.12]], -Math.PI, 0).length // 4
 */
export function arcChain(circles, startAngle, endAngle) {
  finiteGeometry([...circles.flat(), startAngle, endAngle]);
  const n = circles.length, THIRD_TURN = 2 * Math.PI / 3;
  if (n < 2) throw new Error("arcChain needs at least two circles");
  const valley = ([x1, y1, r1], [x2, y2, r2]) => {
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d >= r1 + r2 || d <= Math.abs(r1 - r2)) throw new Error("arcChain: adjacent circles must properly intersect");
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(r1 * r1 - a * a);
    const mx = x1 + a * (x2 - x1) / d, my = y1 + a * (y2 - y1) / d;
    const c = [[mx + h * (y2 - y1) / d, my - h * (x2 - x1) / d], [mx - h * (y2 - y1) / d, my + h * (x2 - x1) / d]];
    return c[0][1] < c[1][1] ? c[0] : c[1];
  };
  const valleys = circles.slice(1).map((c, i) => valley(circles[i], c));
  const angleOn = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const arcs = circles.map((c, i) => {
    let a = i === 0 ? startAngle : angleOn(c, valleys[i - 1]);
    const b = i === n - 1 ? endAngle : angleOn(c, valleys[i]);
    if (a > Math.PI / 2) a -= 2 * Math.PI;
    if (!(b > a)) throw new Error(`arcChain: circle ${i} hidden by its neighbours (${a.toFixed(2)} to ${b.toFixed(2)})`);
    const k = Math.ceil((b - a) / THIRD_TURN), step = (b - a) / k, r = c[2];
    return hermiteNodes(Array.from({ length: k + 1 }, (_, j) => {
      const t = a + step * j;
      return [c[0] + r * cos(t), c[1] + r * sin(t), -r * sin(t), r * cos(t)];
    }), step);
  });
  const nodes = [];
  arcs.forEach((arc, i) => {
    if (i === 0) nodes.push(...arc);
    else { const last = nodes.pop(), first = arc[0]; nodes.push([first[0], first[1], last[2], last[3], first[4], first[5]], ...arc.slice(1)); }
  });
  return nodes;
}

/**
 * Pure function. A cloud bank line: the circles' upper envelope spanning the whole box,
 * from exactly x=0 to exactly x=1. Colours: above = sky side, below = cloud body.
 * @param {number[][]} circles - As arcChain; the first must reach x=0 and the last x=1.
 * @returns {number[][]} open nodes with endpoints exactly on the box sides.
 * @example bankNodes([[0.1,0.5,0.15],[0.3,0.48,0.14],[0.6,0.5,0.15],[0.9,0.5,0.15]])[0].slice(0,2) // [0,0.5+something]
 */
export function bankNodes(circles) {
  const [c0, cn] = [circles[0], circles.at(-1)];
  const nodes = arcChain(circles, -Math.acos(-c0[0] / c0[2]), -Math.acos((1 - cn[0]) / cn[2]));
  nodes[0][0] = 0; nodes[nodes.length - 1][0] = 1;
  return nodes;
}

export const PRESETS = [
  preset("painted-cumulus", "Painted cumulus", "Poster-colour cumulus banks: white lit domes over lavender-grey bases in a deep cerulean sky.", [
    edge("top", ["#1a55b8"]),
    hline(0.2, ["#2f78d2"]),
    boundary(bankNodes([[0.04, 0.56, 0.1], [0.2, 0.5, 0.14], [0.42, 0.53, 0.13], [0.62, 0.47, 0.16], [0.86, 0.53, 0.14], [1.0, 0.57, 0.1]]),
      ["#6fb0e8"], ["#fbfdff"]),
    boundary(bankNodes([[0.1, 0.74, 0.14], [0.32, 0.7, 0.16], [0.55, 0.73, 0.14], [0.8, 0.7, 0.17], [1.0, 0.75, 0.12]]),
      ["#b7b9e4"], ["#ffffff"]),
    edge("bottom", ["#9fa4d6"]),
  ]),
];
