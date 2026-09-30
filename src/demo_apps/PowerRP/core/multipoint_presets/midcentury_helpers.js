/**
 * Geometry and paint helpers shared by the "Mid-century to Memphis" preset
 * family (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { polylineNodes, catmullRomNodes, ellipseNodes, rectNodes, finiteGeometry } from "../multipoint_shapes.js";
import { arcNodes } from "./retro_eras.js";

const TAU = 2 * Math.PI;

/**
 * Pure function. Orders polygon vertices clockwise on screen (y down), so a two-sided closed
 * boundary's rightColor lands INSIDE.
 * @param {number[][]} points - [N,2] (x,y) vertices in either winding.
 * @returns {number[][]} [N,2] clockwise vertices (input untouched).
 * @example cwPolygon([[0,0],[0,1],[1,1],[1,0]])[1] // [1,1] (counter-clockwise on screen, so reversed)
 */
export function cwPolygon(points) {
  finiteGeometry(points.flat());
  const area = points.reduce((s, [x, y], i) => { const [x2, y2] = points[(i + 1) % points.length]; return s + x * y2 - x2 * y; }, 0);
  return area >= 0 ? points : [...points].reverse();
}

/**
 * Pure function. Flat sharp-cornered polygon: `outside` colour around it, `inside` colour within.
 * @param {number[][]} points - [N,2] vertices, any winding.
 * @param {string} outside - #rrggbb.
 * @param {string} inside - #rrggbb.
 * @returns {object} Closed two-sided feature.
 * @example polyShape([[0.1,0.1],[0.5,0.1],[0.3,0.5]], "#ffffff", "#000000").closed // true
 */
export function polyShape(points, outside, inside) {
  return boundary(polylineNodes(cwPolygon(points)), [outside], [inside], true);
}

/**
 * Pure function. Flat smooth (Catmull-Rom) closed blob.
 * @param {number[][]} points - [N,2] anchors, any winding, N >= 3.
 * @param {string} outside - #rrggbb.
 * @param {string} inside - #rrggbb.
 * @returns {object} Closed two-sided feature with N nodes.
 * @example smoothShape([[0.2,0.2],[0.8,0.2],[0.5,0.8]], "#fff000", "#000fff").nodes.length // 3
 */
export function smoothShape(points, outside, inside) {
  return boundary(catmullRomNodes(cwPolygon(points), true), [outside], [inside], true);
}

/**
 * Pure function. Flat ellipse: `outside` colour around it, `inside` colour within.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Horizontal radius.
 * @param {number} ry - Vertical radius (defaults to rx).
 * @param {string} outside - #rrggbb.
 * @param {string} inside - #rrggbb.
 * @returns {object} Closed two-sided feature, 4 nodes.
 * @example disc(0.5,0.5,0.2,0.2,"#ffffff","#000000").nodes.length // 4
 */
export function disc(cx, cy, rx, ry, outside, inside) {
  return boundary(ellipseNodes(cx, cy, rx, ry), [outside], [inside], true);
}

/**
 * Pure function. Single-sided closed frame exactly on the unit box: pins the whole ground to one colour.
 * @param {string} color - #rrggbb.
 * @returns {object} Closed single-sided feature, 4 nodes.
 * @example groundFrame("#ffffff").nodes.length // 4
 */
export function groundFrame(color) {
  return boundary(rectNodes(0, 0, 1, 1), [color], null, true);
}

/**
 * Pure function. Annular sector (a thick arc band with radial end cuts) as a closed outline:
 * outer arc a0→a1, straight cut, inner arc back, straight cut. a1 > a0 runs clockwise on screen
 * (y down), so the outline is clockwise and a two-sided feature's rightColor is the band's fill.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r0 - Inner radius.
 * @param {number} r1 - Outer radius, > r0.
 * @param {number} a0 - Start angle, radians (0 = +x, y down).
 * @param {number} a1 - End angle, > a0, sweep at most a full turn.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples with sharp corners.
 * @example annularSectorNodes(0.5, 0.5, 0.2, 0.3, 0, Math.PI / 2).length // 4
 */
export function annularSectorNodes(cx, cy, r0, r1, a0, a1) {
  finiteGeometry([cx, cy, r0, r1, a0, a1]);
  if (!(r1 > r0 && r0 >= 0 && a1 > a0 && a1 - a0 <= TAU)) throw new Error("annularSectorNodes needs r1 > r0 >= 0 and 0 < a1 - a0 <= 2π");
  const outer = arcNodes({ cx, cy, rx: r1, from: a0, to: a1 });
  const inner = arcNodes({ cx, cy, rx: r0, from: a1, to: a0 });
  outer[0][2] = outer[0][3] = 0; outer.at(-1)[4] = outer.at(-1)[5] = 0;
  inner[0][2] = inner[0][3] = 0; inner.at(-1)[4] = inner.at(-1)[5] = 0;
  return [...outer, ...inner];
}
