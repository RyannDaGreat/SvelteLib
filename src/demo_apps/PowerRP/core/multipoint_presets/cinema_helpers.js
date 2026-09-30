/**
 * Geometry and paint helpers shared by the "Cinema grades" and "Film & print processes" preset
 * families (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary, point } from "./builders.js";
import { polylineNodes, ellipseNodes, finiteGeometry } from "../multipoint_shapes.js";
import { boxEdge, ribbonNodes, arcNodes } from "./retro_eras.js";

const SHOULDER_RATIO = 0.55;

 // same shoulder/rim proportion builders.glow uses
const HALF_TURN = Math.PI;

/**
 * Pure function. A straight two-sided line from (0,y0) to (1,y1): `above` on top, `below` under.
 * @param {number} y0 - Left-edge height in [0,1].
 * @param {number} y1 - Right-edge height in [0,1].
 * @param {string[]} above - Colours on the upper side (left to right).
 * @param {string[]} below - Matching colours on the lower side.
 * @returns {object} Open two-sided feature.
 * @example hline(0.5, 0.5, ["#ffffff"], ["#000000"]).twoSided // true
 */
export function hline(y0, y1, above, below) {
  finiteGeometry([y0, y1]);
  return boundary(polylineNodes([[0, y0], [1, y1]]), above, below);
}

/**
 * Pure function. A smooth vertical ramp: the left and right box edges pinned with top-to-bottom ramps
 * over the fraction [from, to] of their height (so a ground below `to` is not flooded by the sky).
 * @param {string[]} left - Colours down the left edge (top to bottom).
 * @param {string[]} right - Colours down the right edge; defaults to `left`.
 * @param {number} from - Start fraction of the edge.
 * @param {number} to - End fraction of the edge.
 * @returns {object[]} Two open single-sided features.
 * @example vramp(["#000000", "#ffffff"]).length // 2
 */
export function vramp(left, right = left, from = 0, to = 1) {
  return [boxEdge("left", left, from, to), boxEdge("right", right, from, to)];
}

/**
 * Pure function. A tapered closed blob along a centreline: outside rim colour, inside fill colour.
 * @param {number[][]} points - [N,2] centreline, N <= 5.
 * @param {number[]} widths - [N] full widths.
 * @param {string} outside - Colour just outside the shape.
 * @param {string} inside - Fill colour.
 * @returns {object} Closed two-sided feature.
 * @example streak([[0.2,0.5],[0.5,0.5],[0.8,0.5]],[0,0.1,0],"#000000","#ffffff").closed // true
 */
export function streak(points, widths, outside, inside) {
  return boundary(ribbonNodes(points, widths), [outside], [inside], true);
}

/**
 * Pure function. Elliptical light pool: bright centre point, coloured shoulder ellipse, dark rim ellipse.
 * Like builders.glow but with independent radii (a light lying on a floor is wider than tall).
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Outer horizontal radius.
 * @param {number} ry - Outer vertical radius.
 * @param {string[]} colors - [centre, shoulder, rim].
 * @param {number} shoulder - Shoulder radius as a fraction of the rim (default 0.55).
 * @returns {object[]} Three features (1 + 4 + 4 nodes).
 * @example pool(0.5, 0.5, 0.3, 0.15, ["#ffffff", "#ff8800", "#220000"]).length // 3
 */
export function pool(cx, cy, rx, ry, [centre, shoulder, rim], shoulderRatio = SHOULDER_RATIO) {
  finiteGeometry([cx, cy, rx, ry, shoulderRatio]);
  return [point(cx, cy, centre),
    boundary(ellipseNodes(cx, cy, rx * shoulderRatio, ry * shoulderRatio), [shoulder], null, true),
    boundary(ellipseNodes(cx, cy, rx, ry), [rim], null, true)];
}

/**
 * Pure function. Circular glow: a pool with equal radii.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Outer radius.
 * @param {string[]} colors - [centre, shoulder, rim].
 * @param {number} shoulderRatio - Shoulder radius as a fraction of r.
 * @returns {object[]} Three features.
 * @example glow(0.5, 0.5, 0.2, ["#ffffff", "#ff8800", "#220000"]).length // 3
 */
export function glow(cx, cy, r, colors, shoulderRatio) {
  return pool(cx, cy, r, r, colors, shoulderRatio);
}

/**
 * Pure function. Closed arched doorway, clockwise from the bottom-left corner: up the left jamb,
 * over a semicircular top, down the right jamb, back along the base. `rightColors` is INSIDE.
 * @param {number} x0 - Left jamb x.
 * @param {number} x1 - Right jamb x.
 * @param {number} yTop - Highest point of the arch.
 * @param {number} yBase - Base y.
 * @returns {number[][]} [5,6] anchor/relative-handle tuples.
 * @example archNodes(0.4, 0.6, 0.3, 0.8).length // 5
 */
export function archNodes(x0, x1, yTop, yBase) {
  finiteGeometry([x0, x1, yTop, yBase]);
  const rx = (x1 - x0) / 2, springY = yTop + rx;
  if (!(rx > 0) || !(springY < yBase)) throw new Error("Arch needs x1 > x0 and a straight jamb below the springing line");
  const dome = arcNodes({ cx: (x0 + x1) / 2, cy: springY, rx, from: HALF_TURN, to: 2 * HALF_TURN });
  return [[x0, yBase, 0, 0, 0, 0], ...dome, [x1, yBase, 0, 0, 0, 0]];
}

/**
 * Pure function. The four open arcs that draw two overlapping equal circles as three flat regions
 * (left crescent, lens, right crescent), each clockwise on screen so `rightColors` is INSIDE the region.
 * Circle centres are (cx-d, cy) and (cx+d, cy) with radius r, 0 < d < r. Arc ends are trimmed by `gap`
 * radians (outer arcs) and `lensGap` (lens arcs) so no two curves ever touch at a cusp.
 * @param {object} options - {cx,cy,r,d,gap=0.05,lensGap=0.14}.
 * @returns {{rightOuter:number[][], leftOuter:number[][], lensRight:number[][], lensLeft:number[][]}} Node lists.
 *   rightOuter: right circle, top to bottom round the right side (inside = right crescent + lens).
 *   leftOuter: left circle, bottom to top round the left side.
 *   lensRight: left circle's right arc, top to bottom (outside = right crescent).
 *   lensLeft: right circle's left arc, bottom to top (outside = left crescent).
 * @example overlapArcs({cx:0.5,cy:0.5,r:0.3,d:0.13}).lensLeft.length // 3
 */
export function overlapArcs({ cx, cy, r, d, gap = 0.05, lensGap = 0.14 }) {
  finiteGeometry([cx, cy, r, d, gap, lensGap]);
  if (!(r > d && d > 0)) throw new Error("Overlapping circles need 0 < d < r");
  const a = Math.acos(d / r), left = cx - d, right = cx + d;
  return {
    rightOuter: arcNodes({ cx: right, cy, rx: r, from: -(HALF_TURN - a) + gap, to: HALF_TURN - a - gap }),
    leftOuter: arcNodes({ cx: left, cy, rx: r, from: a + gap, to: 2 * HALF_TURN - a - gap }),
    lensRight: arcNodes({ cx: left, cy, rx: r, from: -a + lensGap, to: a - lensGap }),
    lensLeft: arcNodes({ cx: right, cy, rx: r, from: HALF_TURN - a + lensGap, to: HALF_TURN + a - lensGap }),
  };
}

/**
 * Pure function. Leaflet centrelines and widths for a pinnate frond hanging off a quadratic spine.
 * Spine P(t) = (1-t)^2 p0 + 2(1-t)t p1 + t^2 p2. Leaflets leave at parameter values evenly spaced in
 * (tStart, tEnd), angled `angle` radians off the spine tangent on both sides, shrinking linearly to `tipScale`.
 * @param {object} options - {p0,p1,p2,count,tStart,tEnd,length,angle,tipScale,gap}.
 * @returns {number[][][]} Array of [3,2] centreline point triples (start near spine, mid, tip).
 * @example leafletLines({p0:[0.5,1],p1:[0.5,0.5],p2:[0.5,0],count:2,tStart:0.3,tEnd:0.7,length:0.2,angle:1,tipScale:0.5,gap:0.01}).length // 4
 */
export function leafletLines({ p0, p1, p2, count, tStart, tEnd, length, angle, tipScale, gap }) {
  finiteGeometry([...p0, ...p1, ...p2, count, tStart, tEnd, length, angle, tipScale, gap]);
  const at = (t) => [0, 1].map((k) => (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * p1[k] + t * t * p2[k]);
  const tangent = (t) => [0, 1].map((k) => 2 * (1 - t) * (p1[k] - p0[k]) + 2 * t * (p2[k] - p1[k]));
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? tStart : tStart + (tEnd - tStart) * i / (count - 1);
    const [x, y] = at(t), [tx, ty] = tangent(t), norm = Math.hypot(tx, ty);
    const heading = Math.atan2(ty / norm, tx / norm), len = length * (1 - (1 - tipScale) * i / Math.max(1, count - 1));
    return [-1, 1].map((side) => {
      const h = heading + side * angle, ux = Math.cos(h), uy = Math.sin(h);
      const sx = x + ux * gap, sy = y + uy * gap;
      return [[sx, sy], [sx + ux * len / 2, sy + uy * len / 2], [sx + ux * len, sy + uy * len]];
    });
  }).flat();
}

/**
 * Pure function. A pointed leaf as ONE closed two-node shape: base and tip corners joined by two
 * cubics that bulge to opposite sides. Clockwise when the tip lies to the right of the base and
 * `width` > 0 bulges first to the walker's left, so the fill (rightColors) is INSIDE.
 * @param {number[]} base - (x,y) leaf base.
 * @param {number[]} tip - (x,y) leaf tip.
 * @param {number} width - Control-point offset from the axis; the visible half-width is about 0.75 of it.
 * @returns {number[][]} [2,6] anchor/relative-handle tuples.
 * @example leafNodes([0,0],[1,0],0.2).length // 2
 */
export function leafNodes([bx, by], [tx, ty], width) {
  finiteGeometry([bx, by, tx, ty, width]);
  const length = Math.hypot(tx - bx, ty - by);
  if (!length) throw new Error("A leaf needs distinct base and tip");
  const ux = (tx - bx) / length, uy = (ty - by) / length, nx = uy * width, ny = -ux * width, along = length / 3;
  // Left-of-travel normal in y-down screen space is (uy, -ux); first cubic bulges that way.
  return [[bx, by, ux * along - nx, uy * along - ny, ux * along + nx, uy * along + ny],
    [tx, ty, -ux * along + nx, -uy * along + ny, -ux * along - nx, -uy * along - ny]];
}
