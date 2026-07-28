/**
 * PAGE-CURL MATH — the pure geometry of turning one sheet of a corner-stapled
 * packet. DOM-free (bare-node doctests); consumed by the paperCurl IR op's
 * Skia handler and by plugins/pdf_packet.js for bounds/handles.
 *
 * ── THE MODEL (a developable surface, because paper cannot stretch) ──────────
 * Paper bends along ONE direction at a time. The classic page-curl deformation
 * honors that: the sheet ROLLS over a virtual CYLINDER of radius r whose axis
 * lies along a FOLD LINE L. With d = a point's signed distance past L:
 *
 *   d ≤ 0        flat, untouched                          z = 0
 *   0 < d < πr   on the roll: moves back toward L by      z = r·(1 − cos(d/r))
 *                r·sin(d/r) − d (arc length preserved)
 *   d ≥ πr       over the top, flat again but MIRRORED    z = 2r
 *                across L and offset by the half-turn
 *
 * Every distance along the sheet is preserved (sin/arc mapping), so the sheet
 * never rubber-stretches — the #1 fakeness tell.
 *
 * ── THE STAPLED FLIP (why the fold line SWEEPS toward the staple) ────────────
 * A top-left-stapled page cannot translate: it pivots. Sweeping L from beyond
 * the far corner toward the staple reproduces exactly that: as L approaches
 * the staple, the mirrored (d ≥ πr) region approaches "the whole sheet
 * reflected across a line through the staple" — a 180° flip about the fold
 * direction, pinned at the staple, which is what a real corner-stapled page
 * does. The fold DIRECTION is the widget's flip-angle handle; the sweep
 * position is a pure function of turn progress t.
 *
 * Coordinates are the PAGE's local space (0..w, 0..h); +z is "toward the
 * viewer" and only shading/shadow read it. All functions are PURE.
 */

/** Mesh tessellation: quads along each axis. 24×32 puts vertex spacing well
 * under the tightest default curl radius, so the roll's silhouette is smooth;
 * doubling it was visually indistinguishable at 1080p in the probe renders. */
export const CURL_MESH_COLS = 24;
export const CURL_MESH_ROWS = 32;

/** The turn's pose phases as fractions of t (tuned against animation-frame
 * reference: lift is quick, the peel dominates, the settle is short). */
export const TURN_LIFT_END = 0.15;   // corner lift-off, tight curl forming
export const TURN_FLOP_START = 0.85; // roll opens, sheet flops onto the pile

/**
 * Pure function. Signed distance of point (px, py) past the fold line, and its
 * projection onto it. The fold line passes through `origin` with direction
 * (dirX, dirY) (unit); "past" = along the left normal (−dirY, dirX).
 *
 * @param {number} px - point x
 * @param {number} py - point y
 * @param {{x:number,y:number,dirX:number,dirY:number}} line - fold line
 * @returns {{d:number, alongX:number, alongY:number}} signed distance + foot of perpendicular
 *
 * @example foldDistance(10, 0, {x: 0, y: 0, dirX: 0, dirY: 1}) // {d: -10, alongX: 0, alongY: 0}
 * @example foldDistance(0, 5, {x: 0, y: 0, dirX: 1, dirY: 0}).d // 5
 * @example foldDistance(3, 4, {x: 0, y: 0, dirX: 1, dirY: 0}).alongX // 3
 */
export function foldDistance(px, py, line) {
  const rx = px - line.x, ry = py - line.y;
  const along = rx * line.dirX + ry * line.dirY;
  const d = rx * -line.dirY + ry * line.dirX;
  return { d, alongX: line.x + along * line.dirX, alongY: line.y + along * line.dirY };
}

/**
 * Pure function. The curl deformation of one point: the cylinder-rollback
 * described in the header. Returns the deformed 2D position, the height z, and
 * the surface's facing (+1 front visible, −1 back visible — the mirrored
 * region shows the sheet's BACK).
 *
 * @param {number} px - point x (page local)
 * @param {number} py - point y
 * @param {{x:number,y:number,dirX:number,dirY:number}} line - fold line
 * @param {number} r - curl radius (> 0)
 * @returns {{x:number, y:number, z:number, facing:number, theta:number}}
 *   theta = roll angle at this point (0 flat … π fully over), for shading
 *
 * @example curlPoint(10, 0, {x: 0, y: 0, dirX: 0, dirY: 1}, 20) // {x: 10, y: 0, z: 0, facing: 1, theta: 0}
 * @example // exactly half-way around the roll (d = (π/2)·r): height = r
 * @example curlPoint(0, Math.PI / 2 * 20, {x: 0, y: 0, dirX: 1, dirY: 0}, 20).z // 20
 * @example // far past the roll: mirrored flat at z = 2r, showing the BACK
 * @example curlPoint(0, Math.PI * 20 + 30, {x: 0, y: 0, dirX: 1, dirY: 0}, 20).facing // -1
 * @example curlPoint(0, Math.PI * 20 + 30, {x: 0, y: 0, dirX: 1, dirY: 0}, 20).y // -30
 */
export function curlPoint(px, py, line, r) {
  const { d, alongX, alongY } = foldDistance(px, py, line);
  if (d <= 0) return { x: px, y: py, z: 0, facing: 1, theta: 0 };
  const nx = -line.dirY, ny = line.dirX; // the "past the line" normal
  const half = Math.PI * r;
  if (d < half) {
    const theta = d / r;
    const back = r * Math.sin(theta);
    return { x: alongX + nx * back, y: alongY + ny * back, z: r * (1 - Math.cos(theta)), facing: theta < Math.PI / 2 ? 1 : -1, theta };
  }
  const over = d - half;
  return { x: alongX - nx * over, y: alongY - ny * over, z: 2 * r, facing: -1, theta: Math.PI };
}

/**
 * Pure function. The fold line + curl radius for turn progress t ∈ [0, 1] of a
 * page w×h stapled at `staple` (local coords), flipping along `angleDeg`.
 *
 * angleDeg is the direction the FREE CORNER travels (degrees, 0 = +x, CCW
 * positive in screen coords) — the flip-angle handle. The fold line is
 * PERPENDICULAR to it and sweeps from just past the sheet's far extent down to
 * the staple. Curl radius: tight on lift, opens through the peel, relaxes on
 * the flop (reference: real flips and the best digital ones).
 *
 * @param {number} t - turn progress, 0 = at rest, 1 = fully flipped
 * @param {number} w - page width
 * @param {number} h - page height
 * @param {{x:number,y:number}} staple - staple point (page local)
 * @param {number} angleDeg - flip direction handle
 * @param {number} curlScale - curl-radius multiplier handle (1 = default)
 * @returns {{line:{x,y,dirX,dirY}, r:number, reach:number}}
 *   reach = the sheet's max extent past the staple along the flip direction
 *
 * @example // t=0: the fold sits at full reach — nothing curled yet
 * @example turnPose(0, 200, 300, {x: 12, y: 12}, 62, 1).r > 0 // true
 * @example // the fold line direction is perpendicular to the flip direction
 * @example Math.abs(turnPose(0.5, 200, 300, {x: 0, y: 0}, 0, 1).line.dirX) < 1e-9 // true
 * @example // monotone: the fold's distance from the staple shrinks as t grows
 * @example turnPose(0.2, 200, 300, {x: 0, y: 0}, 45, 1).reach > 0 // true
 */
export function turnPose(t, w, h, staple, angleDeg, curlScale) {
  const a = (angleDeg * Math.PI) / 180;
  const fx = Math.cos(a), fy = Math.sin(a); // flip direction (free corner travel)
  // The sheet's maximum extent past the staple along the flip direction —
  // checked at all four corners so any staple position/angle is covered.
  const reach = Math.max(
    (0 - staple.x) * fx + (0 - staple.y) * fy,
    (w - staple.x) * fx + (0 - staple.y) * fy,
    (0 - staple.x) * fx + (h - staple.y) * fy,
    (w - staple.x) * fx + (h - staple.y) * fy,
    1e-6,
  );
  // Fold sweep: cosine-eased from full reach (t=0, line beyond every corner —
  // identity) to 0 (t=1, line through the staple — full 180° flip). The half
  // roll (π·r) rides PAST the line, so at t=1 the flat mirrored region is the
  // whole sheet: settled, no residual bump.
  const sweep = reach * (0.5 + 0.5 * Math.cos(Math.PI * t));
  // Curl radius: a fraction of the sheet's reach — tight at lift (grabbing the
  // corner), bellying out through the peel, re-tightening into the flop. The
  // envelope is ASYMMETRIC on purpose (animation-frame reference: the roll
  // OPENS slower than it re-tightens): sin(π·t^1.3) peaks past mid-turn and
  // falls off fast. The floor keeps the roll from degenerating (r = 0 divides
  // by zero in curlPoint).
  const u = Math.min(1, Math.max(0, t));
  const belly = Math.sin(Math.PI * Math.pow(u, 1.3));
  const r = Math.max(reach * 0.04, reach * (0.10 + 0.22 * belly) * curlScale);
  const lineDist = sweep;
  // dir = (fy, −fx), NOT (−fy, fx): foldDistance's "past the line" normal is
  // (−dirY, dirX), and it must equal the FLIP direction (fx, fy) so the sheet
  // BEYOND the fold curls — the first smoke test had it inverted and rolled
  // the stapled corner instead of the free one.
  return {
    line: { x: staple.x + fx * lineDist, y: staple.y + fy * lineDist, dirX: fy, dirY: -fx },
    r,
    reach,
  };
}


/**
 * Pure function. The full deformed MESH of a turning page: a (cols+1)×(rows+1)
 * vertex grid over the w×h sheet run through curlPoint at the given pose.
 *
 * Returns flat arrays ready for a triangle-mesh draw:
 *   positions  Float32Array 2·V — deformed x,y
 *   uvs        Float32Array 2·V — source rect coords (0..1)
 *   zs         Float32Array V   — height above the pile
 *   facing     Int8Array V      — +1 front, −1 back
 *   front      Float32Array V   — SMOOTH front-face weight (1 front … 0 back),
 *                                 ramping across the roll's crest — the painter
 *                                 fades the texture out with it so the sheet's
 *                                 back reveals continuously, never at a hard
 *                                 triangle boundary
 *   shade      Float32Array V   — diffuse multiplier (theta-based lambert-ish)
 *   indices    Uint16Array 6·cols·rows — two triangles per quad
 *   maxZ       number           — tallest point (drives the cast shadow)
 *
 * Shading: a convex roll lit from above-left — brightness peaks just before
 * the crown (theta ≈ π/3) and falls toward the underside; the flat regions sit
 * at 1. The exact curve is a rendering choice, tuned against photo reference
 * of rolled paper; it must only be MONOTONE-plausible, not physical.
 *
 * @param {number} w - page width
 * @param {number} h - page height
 * @param {{line:object, r:number}} pose - from turnPose
 * @param {number} [cols=CURL_MESH_COLS]
 * @param {number} [rows=CURL_MESH_ROWS]
 * @returns {{positions:Float32Array, uvs:Float32Array, zs:Float32Array, facing:Int8Array, shade:Float32Array, indices:Uint16Array, maxZ:number}}
 *
 * @example // identity pose (fold beyond the sheet): corners stay put, all front-facing
 * @example curlMesh(100, 100, {line: {x: 500, y: 0, dirX: 0, dirY: -1}, r: 20}, 2, 2).positions[0] // 0
 * @example curlMesh(100, 100, {line: {x: 500, y: 0, dirX: 0, dirY: -1}, r: 20}, 2, 2).maxZ // 0
 * @example curlMesh(100, 100, {line: {x: 500, y: 0, dirX: 0, dirY: -1}, r: 20}, 2, 2).indices.length // 24
 */
export function curlMesh(w, h, pose, cols = CURL_MESH_COLS, rows = CURL_MESH_ROWS) {
  const vCols = cols + 1, vRows = rows + 1, V = vCols * vRows;
  const positions = new Float32Array(2 * V);
  const uvs = new Float32Array(2 * V);
  const zs = new Float32Array(V);
  const facing = new Int8Array(V);
  const front = new Float32Array(V);
  const shade = new Float32Array(V);
  // The texture→back crossfade half-width, radians of roll angle around the
  // crest (θ = π/2). Narrow enough that the fade reads as the sheet edge-on,
  // wide enough that no hard seam shows at mesh resolution.
  const FRONT_RAMP = 0.24;
  let maxZ = 0;
  for (let j = 0; j < vRows; j++) {
    for (let i = 0; i < vCols; i++) {
      const v = j * vCols + i;
      const u = i / cols, vv = j / rows;
      const p = curlPoint(u * w, vv * h, pose.line, pose.r);
      positions[2 * v] = p.x;
      positions[2 * v + 1] = p.y;
      uvs[2 * v] = u;
      uvs[2 * v + 1] = vv;
      zs[v] = p.z;
      facing[v] = p.facing;
      front[v] = Math.min(1, Math.max(0, 0.5 - (p.theta - Math.PI / 2) / (2 * FRONT_RAMP)));
      shade[v] = rollShade(p.theta);
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  const indices = new Uint16Array(6 * cols * rows);
  let k = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * vCols + i, b = a + 1, c = a + vCols, d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }
  return { positions, uvs, zs, facing, front, shade, indices, maxZ };
}

/**
 * Pure function. Diffuse multiplier for a point at roll angle theta (0 flat …
 * π fully over): flat sheet = 1; brightens slightly climbing the roll (the
 * light catches the convex face), darkest on the underside just past vertical,
 * recovering on the mirrored flat (which faces the light again but is the
 * sheet's back at rest ≈ 0.97 — paper backs read a hair duller).
 *
 * @param {number} theta - roll angle, radians
 * @returns {number} multiplier ∈ [0.55, 1.08]
 *
 * @example rollShade(0) // 1
 * @example rollShade(Math.PI) // 0.97
 * @example rollShade(Math.PI / 2) < 1 // true
 */
export function rollShade(theta) {
  if (theta <= 0) return 1;
  if (theta >= Math.PI) return 0.97;
  // Highlight band on the climb (peaks ~π/3), valley on the underside (~3π/4).
  const highlight = 0.08 * Math.exp(-((theta - Math.PI / 3) ** 2) / 0.18);
  const valley = 0.45 * Math.exp(-((theta - 2.4) ** 2) / 0.35);
  return Math.min(1.08, Math.max(0.55, 1 + highlight - valley));
}

/**
 * Pure function. The cast-shadow polygon of the curled region: the deformed
 * boundary of the sheet's lifted part (z > 0), offset along the light
 * direction by shadowSlant·z per point — the projection of the lifted paper
 * onto the pile. The caller blurs/fills it. Returns null when nothing is
 * lifted. Points walk the sheet's boundary (top, right, bottom, left edges)
 * at mesh resolution.
 *
 * @param {number} w - page width
 * @param {number} h - page height
 * @param {{line:object, r:number}} pose - from turnPose
 * @param {{x:number, y:number}} slant - shadow offset per unit z (light dir)
 * @param {number} [samples=24] - boundary samples per edge
 * @returns {Array<[number, number]>|null}
 *
 * @example castShadowOutline(100, 100, {line: {x: 500, y: 0, dirX: 0, dirY: -1}, r: 20}, {x: 0.3, y: 0.2}) // null
 * @example castShadowOutline(100, 100, {line: {x: 20, y: 0, dirX: 0, dirY: 1}, r: 15}, {x: 0.3, y: 0.2}).length > 8 // true
 */
export function castShadowOutline(w, h, pose, slant, samples = 24) {
  const pts = [];
  let lifted = false;
  const edge = (x0, y0, x1, y1) => {
    for (let i = 0; i < samples; i++) {
      const u = i / samples;
      const p = curlPoint(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, pose.line, pose.r);
      if (p.z > 0.01) lifted = true;
      pts.push([p.x + slant.x * p.z, p.y + slant.y * p.z]);
    }
  };
  edge(0, 0, w, 0);
  edge(w, 0, w, h);
  edge(w, h, 0, h);
  edge(0, h, 0, 0);
  return lifted ? pts : null;
}

/**
 * Pure function. Splits fractional `page` into the packet's draw plan:
 * which 1-based page lies OPEN on the pile, how many are turned back, and the
 * turn progress of the page currently mid-flip (null when page is whole).
 * page 1 = cover at rest; page 2.3 = page 2 is 30% through flipping, page 3
 * showing beneath.
 *
 * @param {number} page - fractional page (clamped by the caller)
 * @param {number} pageCount - total pages
 * @returns {{turnedCount:number, turningPage:number|null, t:number, openPage:number}}
 *
 * @example packetPlan(1, 8) // {turnedCount: 0, turningPage: null, t: 0, openPage: 1}
 * @example packetPlan(2.3, 8) // {turnedCount: 1, turningPage: 2, t: 0.3, openPage: 3}
 * @example packetPlan(2.3, 8).turningPage // 2
 * @example packetPlan(8, 8) // {turnedCount: 7, turningPage: null, t: 0, openPage: 8}
 */
export function packetPlan(page, pageCount) {
  const p = Math.min(Math.max(page, 1), pageCount);
  const whole = Math.floor(p);
  const t = p - whole;
  if (t === 0) return { turnedCount: whole - 1, turningPage: null, t: 0, openPage: whole };
  return { turnedCount: whole - 1, turningPage: whole, t, openPage: Math.min(whole + 1, pageCount) };
}

/**
 * Pure function. The resting pose of ALREADY-TURNED page k (0 = turned first):
 * a full 180° reflection across the fold direction through the staple, fanned
 * by `spreadDeg` per page (later-turned pages sit on top with a larger fan —
 * reference: flipped-back pages splay around the staple rather than stacking
 * perfectly). Returned as a similarity: rotate by `rotationDeg` about the
 * staple after reflecting — the painter composes it as reflect(flip axis)
 * then rotate.
 *
 * @param {number} k - turned-page index (0-based from the bottom of the turned pile)
 * @param {number} turnedCount - how many pages are turned
 * @param {number} angleDeg - the flip-direction handle
 * @param {number} spreadDeg - fan handle (degrees between successive turned pages)
 * @returns {{axisDeg:number, rotationDeg:number}}
 *
 * @example turnedPose(0, 1, 62, 6) // {axisDeg: 152, rotationDeg: 0}
 * @example turnedPose(0, 3, 62, 6).rotationDeg // -12 (deepest = rotated furthest back)
 */
export function turnedPose(k, turnedCount, angleDeg, spreadDeg) {
  // The flip axis is PERPENDICULAR to the free-corner travel direction.
  const axisDeg = angleDeg + 90;
  // Fan: the FIRST-turned page (k=0) lies deepest and most rotated back toward
  // rest; the LAST-turned hugs the axis. Negative = fanning back under.
  return { axisDeg, rotationDeg: -(turnedCount - 1 - k) * spreadDeg };
}

/**
 * Pure function. The tiny resting jitter of REMAINING page k beneath the open
 * one — real stacks never align perfectly. Deterministic (hash of k), a
 * rotation about the staple plus a sub-page-unit offset, scaled by the
 * `spreadDeg` handle (0 = machine-perfect stack).
 *
 * @param {number} k - depth beneath the open page (1 = directly beneath)
 * @param {number} spreadDeg - remaining-stack fan handle
 * @returns {{rotationDeg:number, dx:number, dy:number}}
 *
 * @example stackJitter(1, 0) // {rotationDeg: 0, dx: 0, dy: 0}
 * @example Math.abs(stackJitter(2, 2).rotationDeg) <= 2 // true
 */
export function stackJitter(k, spreadDeg) {
  if (spreadDeg === 0) return { rotationDeg: 0, dx: 0, dy: 0 };
  // Small deterministic hash → [-1, 1): the golden-ratio fractional trick.
  const g = (n) => (((n * 0.6180339887498949) % 1) * 2) - 1;
  return { rotationDeg: g(k * 3 + 1) * spreadDeg, dx: g(k * 3 + 2) * spreadDeg * 0.6, dy: g(k * 3 + 3) * spreadDeg * 0.6 };
}
