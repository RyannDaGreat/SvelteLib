/**
 * DrawingML shape GEOMETRY EVALUATOR: turns OOXML preset shapes (the
 * `prstGeom prst="..."` name + adjustment overrides every ~187 named
 * PowerPoint AutoShapes reduce to) and custGeom paths (per-shape custom
 * geometry, including PowerPoint's "Merge Shapes" boolean results, which
 * PowerPoint bakes to an ordinary custGeom with no separate boolean-op
 * vocabulary — there is nothing left to special-case by the time the file
 * exists) into SVG path data. Pure, DOM-free, no cross-module imports — the
 * two exported entry points, `presetShapePath` and `custGeomPath`, take only
 * plain-data inputs and plain numbers, so a parser feeding real slide XML
 * conforms to the shapes documented below without this module reading XML
 * itself.
 *
 * SOURCE OF THE PRESET TABLE (`preset_shape_defs.json`, vendored by
 * `tests/pptx_dev/vendor_preset_shapes.mjs`): LibreOffice's typo-corrected
 * mirror of the ECMA-376/ISO-29500 Appendix D `presetShapeDefinitions.xml`,
 * `https://raw.githubusercontent.com/LibreOffice/core/master/oox/source/drawingml/customshapes/presetShapeDefinitions.xml`,
 * MPL-2.0, vendored at LibreOffice/core commit `6f4ddc4bcb2674b5256802094ebd0f6ccc2ce4d5`
 * (2026-08-10). The base ECMA/ISO text alone under-specifies four operators —
 * see FORMULA DEVIATIONS below — so a naive port of the written spec renders
 * arcs, and any shape using `sqrt`/`mod` on values that can go negative,
 * wrong; this module implements Office's actual behavior, per
 * [MS-OI29500] Part 1 S20.1.9.11.
 *
 * THE FORMULA LANGUAGE (`fmla` on a `<gd>` guide). 17 operators, evaluated in
 * DECLARATION ORDER into a single mutable name -> number table (guides may be
 * REASSIGNED by a later `<gd>` of the same name within one gdLst — confirmed
 * in the vendored file, e.g. `gear6` redeclares `a1`; a later reference reads
 * the LATEST value, so this module folds guides with a `Map`, not a
 * build-once dictionary):
 *
 *   val x        -> x                              (literal constant)
 *   +- x y z     -> x + y - z
 *   +/ x y z     -> (x + y) / z
 *   *' x y z     -> (x * y) / z        [multiply-divide, the single most common op]
 *   ?: x y z     -> x > 0 ? y : z                   (condition on arg 1's sign)
 *   abs x        -> |x|
 *   min x y      -> min(x, y)
 *   max x y      -> max(x, y)
 *   pin x y z    -> clamp y between low x and high z (y < x ? x : y > z ? z : y)
 *   sqrt x       -> sqrt(|x|)           [OFFICE DEVIATION: ECMA says sqrt(x)]
 *   sin x y      -> x * sin(y), y in 60,000ths of a degree
 *   cos x y      -> x * cos(y), y in 60,000ths of a degree
 *   tan x y      -> x * tan(y), y in 60,000ths of a degree
 *   at2 x y      -> atan2(y, x) in 60,000ths of a degree, (0,0) -> 0
 *                   [OFFICE DEVIATION: ECMA prose says arctan(y/x), which
 *                   loses the quadrant; Office implements true atan2]
 *   cat2 x y z   -> x * cos(atan2(z, y))      ["cosine-arctangent" x-delta]
 *   sat2 x y z   -> x * sin(atan2(z, y))      ["sine-arctangent" y-delta]
 *   mod x y z    -> sqrt(x^2 + y^2 + z^2)     [OFFICE DEVIATION: 3D vector
 *                   magnitude, NOT arithmetic modulo -- ECMA's own prose
 *                   mislabels this operator too]
 *
 * Multiply-divide is written as a two-character asterisk-slash token in
 * real files; this docblock spells its table row with a leading apostrophe
 * above only because the literal asterisk-slash token would close this
 * comment.
 *
 * BUILT-IN GUIDES, always available with no declaration (per spec, §1 of the
 * geometry research): `w`, `h` (the PATH's own local w/h, see custGeomPath),
 * `ss` = min(w,h), `hc`/`vc` = w/2, h/2 (horizontal/vertical CENTER), `l`,
 * `t`, `r`, `b` = 0, 0, w, h -- plus TWO GENERAL PATTERNS resolved directly
 * in `resolveArg` rather than enumerated here (the vendored table uses more
 * divisors than any fixed list would anticipate): the `wdN`/`hdN`/`ssdN`
 * DIVISOR family (w, h or ss divided by any integer N -- `wd2`=w/2 duplicates
 * `hc`/`vc` under a different spelling; both appear in real files; the
 * corpus alone uses N in {2,3,4,5,6,8,10,12,32}), and the `[N]cdM` ANGLE
 * family (360deg/M times integer multiplier N, default N=1 -- `cd2`/`cd4`/
 * `cd8` = 180/90/45 degrees in 60,000ths are just this family's N=1 case;
 * `3cd4` = 270deg is the corpus's one N>1 instance, 82 occurrences).
 *
 * THE PATH LANGUAGE (pathLst / custGeom). Both a preset's `<pathLst>` and a
 * per-shape `<a:custGeom>` share one grammar (`custGeom` is literally an
 * inline gdLst/avLst + pathLst attached to one shape instance), so
 * `emitPathCommands` below serves both `presetShapePath` and `custGeomPath`.
 * Each `<a:path>` has its OWN local `w`/`h` coordinate space (default 0),
 * INDEPENDENT of the shape's `w`/`h` guides and independent of every sibling
 * path in the same pathLst -- coordinates inside are authored in
 * `[0..path.w] x [0..path.h]` and scaled by `(shapeW/path.w, shapeH/path.h)`
 * to land in the shape's actual box (guarded: a zero-w-or-h path is a
 * malformed/degenerate declaration and throws rather than dividing by zero).
 *
 * ARC CONVERSION (arcTo -> SVG `A`). DrawingML's arcTo is CENTER-parameterized
 * (implicit ellipse of half-axes wR,hR, positioned so the arc starts at the
 * CURRENT pen point; stAng/swAng in 60,000ths of a degree, sweep direction
 * given by swAng's sign -- negative is a real, observed value and means
 * counter-clockwise). SVG's `A` is endpoint-parameterized, so this module:
 *   1. Maps stAng from a GEOMETRIC angle to the ellipse's PARAMETRIC angle
 *      (`ellipseParametricAngle` -- see THE ANGLE CONVENTION below), then
 *      solves the center backward from the pen point at that parametric angle.
 *   2. Computes the endpoint the same way, mapping the ABSOLUTE end angle
 *      stAng+swAng through the same correction (never by adding a "corrected
 *      sweep" to the corrected start -- the mapping is not additive).
 *   3. large-arc-flag = 1 iff |swAng| > 180deg (cd2); sweep-flag = 1 iff
 *      swAng > 0.
 *   4. |swAng| >= 360deg (a full or near-full turn -- `blockArc`,
 *      `circularArrow`, `pie`/`chord`, `arc` all sweep this far) is split
 *      into TWO `A` commands of swAng/2 each, because SVG refuses to render
 *      a full ellipse via one endpoint-arc command when start === end.
 *
 * THE ANGLE CONVENTION: stAng IS A GEOMETRIC ANGLE, NOT A PARAMETRIC ONE, and
 * this module got it wrong until workstream PPTXPAINT. `stAng` names the angle
 * of the RAY from the ellipse centre to the arc's start point -- so the start
 * point is where that ray CROSSES the ellipse -- whereas the standard
 * parametric form `(cx + wR*cos t, cy + hR*sin t)` wants the ECCENTRIC ANOMALY
 * `t`. The two are related by
 *
 *     t = atan2(wR * sin(stAng), hR * cos(stAng))
 *
 * (equivalently tan t = (wR/hR) * tan(stAng)), which is what
 * `ellipseParametricAngle` below computes. SOURCE: LibreOffice's
 * `lcl_getNormalizedCircleAngleRad` (svx/source/customshapes/
 * EnhancedCustomShape2d.cxx, used by its ARCANGLETO handler, whose pre-2020
 * form logged the step literally as "angles -> parameters"), corroborated by an
 * INDEPENDENT implementation in Apache POI (`ArcToCommandIf.java`: "calculate
 * the inverse angle - taken from the (reversed) preset definition", plus
 * `ArcToCommand.java`'s "Arc2D angles are skewed, OOXML aren't ... so we need to
 * unskew them"). ECMA-376's own prose does not specify the mapping -- it says
 * only that wR/hR "define the supposed circle" -- which is why this is derived
 * from the two reference implementations rather than quoted from the standard.
 *
 * THE CORRECTION IS IDENTITY ON THE AXES, which is exactly why the bug survived
 * so long: at 0/90/180/270deg the two conventions agree exactly (LibreOffice
 * short-circuits those four cases for the same reason), so every CIRCULAR arc
 * (wR === hR) and every elliptical arc that starts and sweeps on quadrant
 * boundaries renders identically either way. MEASURED on this table: `leftBrace`,
 * `can` and `blockArc` resolve byte-identical centres under both conventions,
 * while `curvedRightArrow`'s eight arcs collapse from SIX scattered centres
 * (including one 77.4 units off the shape) to the TWO concentric centres the
 * shape is actually built from.
 *
 * CONCENTRICITY IS NOT THE TEST, despite being the symptom that exposed this.
 * Both conventions chain SELF-CONSISTENTLY -- each solves the centre and the
 * endpoint through the same mapping, so a closure/round-trip check passes under
 * either. What actually differs is WHERE the arc lands. The discriminating
 * property, and the one `tests/pptx_subpath_paint_test.js` pins, is that under
 * the correct convention `atan2` of (start point - centre) returns `stAng`
 * itself for a non-quadrant angle; under the raw-parametric reading it does not.
 *
 * FLIP/ROTATE/GROUP TRANSFORMS ARE OUT OF SCOPE HERE. This module returns
 * path data in the shape's own `[0,w] x [0,h]` local space; xfrm-level
 * flipH/flipV/rot and grpSp chOff/chExt composition are the PARSER's job
 * (research doc §5) -- they touch the placement matrix, not the geometry.
 */

const RAD_PER_60000TH = Math.PI / (180 * 60000);

/** Built-in guide names computable from `w`/`h` alone with no gdLst entry:
 * `w`, `h`, `ss` (shortest side), `l`/`t`/`r`/`b`, `hc`/`vc` (center). The
 * DIVISOR FAMILIES -- `wdN`/`hdN`/`ssdN` (w, h, or ss divided by any N) and
 * `cdN` (360deg/N in 60,000ths) -- are NOT enumerated here; they are general
 * patterns resolved directly in `resolveArg` (see `DIVISOR_RE`), because the
 * vendored table uses divisors 2/3/4/5/6/8/10/12/32 for `wd`/`hd` alone and
 * an enumerated object would need extending every time a new preset shape
 * introduces a divisor this module hasn't seen yet -- the spec's own
 * grammar is general, so this module matches it generally instead of
 * chasing individual observed values. Built as a function so each
 * evaluation gets a fresh base -- these are never mutated, only read, but
 * keeping them out of a shared module-level object avoids any risk of a
 * caller's Map polluting it. */
function builtinGuides(w, h) {
  const ss = Math.min(w, h);
  return {
    w, h, ss,
    l: 0, t: 0, r: w, b: h,
    hc: w / 2, vc: h / 2,
  };
}

/** Matches the angle-constant family `[<digits>]cd<digits>`: `cdM` alone
 * (implicit multiplier 1 -- this is how `cd2`/`cd4`/`cd8`, 180/90/45deg,
 * the three names the research doc calls out as "turn up in nearly every
 * arc-based shape", are covered) or the compact multiple shorthand `NcdM`,
 * e.g. `3cd4` = 3 * cd4 = 3 * 90deg = 270deg (16,200,000 in 60,000ths;
 * appears 82 times in the vendored table, always as this one instance).
 * Both are the SAME general rule -- `NcdM` = N * (360deg / M) -- so a bare
 * `cdM` is just N=1, not a separate lookup-table entry. */
const ANGLE_MULTIPLE_RE = /^(\d*)cd(\d+)$/;

/** Matches the `wdN`/`hdN`/`ssdN` DIVISOR family -- w, h, or ss (shortest
 * side) divided by any positive integer N (`wd2` = w/2, `hd3` = h/3, `ssd32`
 * = ss/32, ...). The vendored table alone uses divisors 2, 3, 4, 5, 6, 8,
 * 10, 12 and 32 for `wd`/`hd`, so this resolves the family GENERALLY (per
 * the spec's own grammar) rather than as an enumerated lookup table that
 * would need extending for every newly observed divisor. */
const DIVISOR_RE = /^(w|h|ss)d(\d+)$/;

/**
 * Pure function. Resolves one formula ARGUMENT token to a number: a bare
 * numeric literal (`"0"`, `"21599999"`, `"-5400000"`) parses directly; the
 * compact angle-multiple shorthand `NcdM` (see `ANGLE_MULTIPLE_RE`) and the
 * `wdN`/`hdN`/`ssdN` divisor family (see `DIVISOR_RE`) compute directly
 * (the latter reads `w`/`h`/`ss` back out of `guides`, where
 * `builtinGuides` always seeds them); any other token is looked up in
 * `guides` (adjustment values `adj`/`adj1..N`, prior `<gd>` names, or a
 * built-in guide) and throws loudly if absent -- an unresolved name is a
 * malformed shape definition, never a silent 0.
 *
 * @example resolveArg("21599999", new Map()) // 21599999
 * @example resolveArg("hc", new Map([["hc", 50]])) // 50
 * @example resolveArg("3cd4", new Map()) // 16200000 (3 * cd4 = 3 * 90deg, in 60,000ths)
 * @example resolveArg("wd4", new Map([["w", 100]])) // 25 (w/4)
 */
export function resolveArg(token, guides) {
  const n = Number(token);
  if (Number.isFinite(n) && token.trim() !== "") return n;
  const angleMultiple = ANGLE_MULTIPLE_RE.exec(token);
  if (angleMultiple) {
    const [, multiplier, divisor] = angleMultiple;
    return (multiplier === "" ? 1 : Number(multiplier)) * (21600000 / Number(divisor));
  }
  const divisorMatch = DIVISOR_RE.exec(token);
  if (divisorMatch) {
    const [, base, divisor] = divisorMatch;
    if (!guides.has(base))
      throw new Error(`preset_geometry: divisor guide "${token}" needs base guide "${base}", which is not set`);
    return guides.get(base) / Number(divisor);
  }
  if (guides.has(token)) return guides.get(token);
  throw new Error(`preset_geometry: unresolved guide reference "${token}" (not a number, not a declared guide)`);
}

/** The 17 recognized `fmla` operator keywords, each mapped to its argument
 * count, for the "malformed formula" arity check in `evaluateFormula`. */
const FORMULA_ARITY = {
  val: 1, "+-": 3, "+/": 3, "*/": 3, "?:": 3, abs: 1, min: 2, max: 2, pin: 3,
  sqrt: 1, sin: 2, cos: 2, tan: 2, at2: 2, cat2: 3, sat2: 3, mod: 3,
};

/**
 * Pure function. Evaluates one `fmla="op arg1 arg2..."` string against the
 * current `guides` table (a `name -> number` Map) and returns the numeric
 * result. Implements all 17 DrawingML formula operators, including the four
 * Office deviations from the written ECMA/ISO text: `sqrt` absolutes its
 * input, `mod` is 3D vector magnitude (not arithmetic modulo), `at2` is a
 * true quadrant-aware atan2, and every trig argument is in 60,000ths of a
 * degree. Throws loudly on an unknown operator or wrong argument count --
 * never silently returns 0 or NaN for a formula this module doesn't
 * understand.
 *
 * @example evaluateFormula("val 16667", new Map()) // 16667
 * @example # multiply-divide (op = asterisk then slash) computes (x*y)/z; see the module's own FORMULA_ARITY test in tests/pptx_geometry_test.js for a runnable case -- the literal two-char operator token can't appear in this comment without closing it
 * @example evaluateFormula("pin 0 adj 50000", new Map([["adj", 75000]])) // 50000
 * @example evaluateFormula("sqrt x", new Map([["x", -16]])) // 4 (Office: sqrt(abs(x)))
 * @example evaluateFormula("at2 x y", new Map([["x", 0], ["y", 0]])) // 0 (the (0,0) special case)
 *
 * SOURCE ANOMALY, tolerated rather than rejected: the vendored table
 * contains 8 instances (circularArrow/leftCircularArrow/
 * leftRightCircularArrow's `xB`/`yB`/`xI`/`yI` guides) of `+- A 0 B 0` -- a
 * `+-` (3-arg) formula with a 4th, extra trailing `0` token. Comparing each
 * to its structural sibling (e.g. `xG = "+- xH dxG 0"`, correctly 3-arg,
 * computing `xH + dxG`) shows the 4-arg form is a stray-token typo meaning
 * exactly the same 3-arg operation with an inert trailing zero: `xB = "+-
 * xH 0 dxB 0"` computes `xH + 0 - dxB` (a leading zero, not a 4th operand).
 * EXTRA trailing tokens beyond an operator's declared arity are therefore
 * accepted and IGNORED (only the first N resolve/participate); too FEW
 * tokens is still a hard error -- that direction has no such precedent in
 * the vendored corpus and remains a genuine malformed-formula signal.
 */
export function evaluateFormula(fmla, guides) {
  const tokens = fmla.trim().split(/\s+/);
  const op = tokens[0];
  const arity = FORMULA_ARITY[op];
  if (arity === undefined)
    throw new Error(`preset_geometry: unknown formula operator "${op}" in fmla "${fmla}"`);
  const argTokens = tokens.slice(1);
  if (argTokens.length < arity)
    throw new Error(`preset_geometry: formula "${fmla}" expects ${arity} argument(s), got ${argTokens.length}`);
  const [a, b, c] = argTokens.slice(0, arity).map((t) => resolveArg(t, guides));

  switch (op) {
    case "val": return a;
    case "+-": return a + b - c;
    case "+/": return (a + b) / c;
    case "*/": return (a * b) / c;
    case "?:": return a > 0 ? b : c;
    case "abs": return Math.abs(a);
    case "min": return Math.min(a, b);
    case "max": return Math.max(a, b);
    case "pin": return b < a ? a : b > c ? c : b;
    case "sqrt": return Math.sqrt(Math.abs(a));
    case "sin": return a * Math.sin(b * RAD_PER_60000TH);
    case "cos": return a * Math.cos(b * RAD_PER_60000TH);
    case "tan": return a * Math.tan(b * RAD_PER_60000TH);
    case "at2": {
      if (a === 0 && b === 0) return 0;
      return Math.atan2(b, a) / RAD_PER_60000TH;
    }
    case "cat2": {
      const angle = Math.atan2(c, b);
      return a * Math.cos(angle);
    }
    case "sat2": {
      const angle = Math.atan2(c, b);
      return a * Math.sin(angle);
    }
    case "mod": return Math.sqrt(a * a + b * b + c * c);
    /* c8 ignore next */
    default: throw new Error(`preset_geometry: operator "${op}" declared in FORMULA_ARITY but not implemented`);
  }
}

/**
 * Pure function. Folds a shape's `avLst` (default adjustment values) merged
 * with instance-level `adjustments` overrides, then a shape's `gdLst`
 * (ordered `[name, fmla]` pairs) into one flat `name -> number` guide table,
 * seeded with the built-in `w`/`h`-derived guides (`builtinGuides`).
 * Guides fold IN DECLARATION ORDER and a later `<gd>` of the same name
 * REASSIGNS it (observed in the vendored table, e.g. `gear6`'s `a1`) -- so
 * this is a sequential reduce over a mutable Map, not a one-shot object
 * spread.
 *
 * Args:
 *   avLst (object): `{gdName: defaultValue}`, already-numeric defaults.
 *   adjustments (object): `{gdName: value}` instance overrides layered over avLst.
 *   gdLst (Array<[string, string]>): ordered `[name, fmla]` guide declarations.
 *   w, h (number): the shape's (or path's) local coordinate-space size.
 *
 * Returns:
 *   Map<string, number>
 *
 * @example foldGuides({adj: 16667}, {}, [["a", "pin 0 adj 50000"]], 100, 100).get("a") // 16667
 * @example foldGuides({adj: 16667}, {adj: 30000}, [["a", "pin 0 adj 50000"]], 100, 100).get("a") // 30000
 */
export function foldGuides(avLst, adjustments, gdLst, w, h) {
  const guides = new Map(Object.entries(builtinGuides(w, h)));
  for (const [name, value] of Object.entries(avLst ?? {})) guides.set(name, value);
  for (const [name, value] of Object.entries(adjustments ?? {})) {
    if (!guides.has(name) && !(avLst && name in avLst))
      throw new Error(`preset_geometry: adjustment "${name}" does not exist on this shape's avLst`);
    guides.set(name, value);
  }
  for (const [name, fmla] of gdLst ?? []) guides.set(name, evaluateFormula(fmla, guides));
  return guides;
}

/**
 * Pure function. Maps a DrawingML GEOMETRIC angle (60,000ths of a degree, the
 * angle of the ray from the ellipse centre to a point ON the ellipse) to the
 * PARAMETRIC angle (eccentric anomaly, in RADIANS) that the standard form
 * `(cx + wR*cos t, cy + hR*sin t)` takes. See THE ANGLE CONVENTION in this
 * module's header for the sources and for why this is not optional.
 *
 * `t = atan2(wR*sin(a), hR*cos(a))`, i.e. `tan t = (wR/hR) * tan a`. IDENTITY on
 * the four axis angles (0/90/180/270deg) and for any circular arc (wR === hR) --
 * those return exactly rather than through `atan2`, matching LibreOffice's own
 * short-circuit and keeping every circular preset's output byte-identical to
 * what this module produced before the correction existed.
 *
 * A DEGENERATE RADIUS (wR or hR === 0) falls back to the raw angle: `atan2(0,0)`
 * is 0 and would silently collapse every angle on a zero-extent ellipse to the
 * same point, which is a worse answer than the uncorrected one and hides the
 * degeneracy from the caller.
 *
 * Args:
 *   wR, hR (number): ellipse half-axes.
 *   angle60000ths (number): the geometric angle, in 60,000ths of a degree.
 *
 * Returns:
 *   number -- the parametric angle in radians.
 *
 * @example ellipseParametricAngle(50, 50, 2700000) // 0.7853981633974483 (a CIRCLE: 45deg unchanged)
 * @example ellipseParametricAngle(100, 50, 5400000) // 1.5707963267948966 (90deg is on an axis: identity)
 * @example ellipseParametricAngle(100, 50, 2700000) // 1.1071487177940904 (45deg on a 2:1 ellipse: skewed toward the long axis)
 * @example ellipseParametricAngle(0, 50, 2700000) // 0.7853981633974483 (degenerate: the raw angle, not a collapse to 0)
 */
export function ellipseParametricAngle(wR, hR, angle60000ths) {
  const raw = angle60000ths * RAD_PER_60000TH;
  if (wR === hR || wR === 0 || hR === 0) return raw;
  const QUARTER_TURN_60000THS = 5400000; // 90deg — the period of the identity cases
  if (angle60000ths % QUARTER_TURN_60000THS === 0) return raw;
  // atan2 returns (-PI, PI]; carry `raw`'s turn count back so a start angle past
  // one full turn stays on its own turn rather than folding — the sweep is
  // applied to the ABSOLUTE end angle, so a folded start would move the arc.
  const folded = Math.atan2(wR * Math.sin(raw), hR * Math.cos(raw));
  const TWO_PI = Math.PI * 2;
  return folded + TWO_PI * Math.round((raw - folded) / TWO_PI);
}

/**
 * Pure function. Converts one DrawingML `arcTo` (center-parameterized: an
 * ellipse of half-axes wR,hR, positioned so the arc starts at the CURRENT
 * pen point `(x0,y0)`) into one or two SVG elliptical-arc path fragments
 * (`A rx,ry 0 largeArc,sweep ex,ey`, without the leading command letter's
 * argument-count ambiguity -- returned as ready-to-join `"A ..."` strings).
 * Splits any arc with `|swAng| >= 360deg` (`cd2*2` = 21,600,000 sixty-
 * thousandths) into two half-sweep `A` commands, because SVG cannot express
 * a full-ellipse traversal as one endpoint-arc command when start === end.
 *
 * Args:
 *   x0, y0 (number): current pen position (arc start point).
 *   wR, hR (number): ellipse half-axes (radii).
 *   stAng (number): start angle, 60,000ths of a degree.
 *   swAng (number): signed sweep, 60,000ths of a degree (negative = CCW).
 *
 * Returns:
 *   {segments: string[], endX: number, endY: number} -- one or two `"A ..."`
 *   fragments in draw order, plus the final pen position.
 *
 * @example arcToSvgSegments(50, 0, 50, 50, 0, 5400000) // pen at (50,0), stAng=0 -> center (0,0); 90deg CW sweep ends at angle 90deg -> endX ~= 0 (float noise, not exactly 0), endY = 50
 * @example arcToSvgSegments(100, 50, 50, 50, 0, 10800000).segments.length // 1 (exactly 180deg: |swAng| > cd2 is false)
 * @example arcToSvgSegments(100, 50, 50, 50, 0, 21600000).segments.length // 2 (full turn, split)
 */
export function arcToSvgSegments(x0, y0, wR, hR, stAng, swAng) {
  const FULL_TURN_60000THS = 21600000; // 360deg
  const HALF_TURN_60000THS = 10800000; // 180deg
  // GEOMETRIC -> PARAMETRIC on every angle this function touches (see the
  // module header's THE ANGLE CONVENTION). Both the centre solve and every
  // endpoint go through it, and each maps its own ABSOLUTE angle — the
  // correction is NOT additive, so a "corrected sweep" added to a corrected
  // start would be a different (wrong) arc.
  const toParam = (a) => ellipseParametricAngle(wR, hR, a);

  // Center solved backward from the pen point: the arc starts at (x0,y0), so
  // cx = x0 - wR*cos(t0) where t0 is stAng's PARAMETRIC angle.
  const cx = x0 - wR * Math.cos(toParam(stAng));
  const cy = y0 - hR * Math.sin(toParam(stAng));

  const pointAt = (ang) => ({ x: cx + wR * Math.cos(toParam(ang)), y: cy + hR * Math.sin(toParam(ang)) });
  const oneArc = (fromAng, sweep) => {
    const end = pointAt(fromAng + sweep);
    const largeArc = Math.abs(sweep) > HALF_TURN_60000THS ? 1 : 0;
    const sweepFlag = sweep > 0 ? 1 : 0;
    return { seg: `A ${wR},${hR} 0 ${largeArc},${sweepFlag} ${end.x},${end.y}`, end };
  };

  if (Math.abs(swAng) >= FULL_TURN_60000THS) {
    const half = swAng / 2;
    const first = oneArc(stAng, half);
    const second = oneArc(stAng + half, half);
    return { segments: [first.seg, second.seg], endX: second.end.x, endY: second.end.y };
  }
  const only = oneArc(stAng, swAng);
  return { segments: [only.seg], endX: only.end.x, endY: only.end.y };
}

/**
 * Pure function. Resolves one path command's numeric point/radius/angle
 * fields (each may be a literal or a guide name) via `guides`, and returns
 * the plain-number version of that command. Used by `emitPathCommands` as a
 * per-command normalization step before drawing.
 */
function resolveCommand(cmd, guides) {
  const r = (token) => resolveArg(String(token), guides);
  switch (cmd.cmd) {
    case "moveTo": case "lnTo":
      return { cmd: cmd.cmd, x: r(cmd.x), y: r(cmd.y) };
    case "cubicBezTo":
      return { cmd: cmd.cmd, x1: r(cmd.x1), y1: r(cmd.y1), x2: r(cmd.x2), y2: r(cmd.y2), x: r(cmd.x), y: r(cmd.y) };
    case "quadBezTo":
      return { cmd: cmd.cmd, x1: r(cmd.x1), y1: r(cmd.y1), x: r(cmd.x), y: r(cmd.y) };
    case "arcTo":
      return { cmd: cmd.cmd, wR: r(cmd.wR), hR: r(cmd.hR), stAng: r(cmd.stAng), swAng: r(cmd.swAng) };
    case "close":
      return { cmd: "close" };
    default:
      throw new Error(`preset_geometry: unknown path command "${cmd.cmd}"`);
  }
}

/**
 * Pure function. Emits ONE SVG path `d` string from a DrawingML command list
 * already resolved against `guides`, scaled from the path's own local
 * `[0,pathW] x [0,pathH]` space into the shape's `[0,shapeW] x [0,shapeH]`
 * space via `(sx, sy) = (shapeW/pathW, shapeH/pathH)`. `arcTo` has no direct
 * SVG primitive (center-param vs endpoint-param) and is expanded via
 * `arcToSvgSegments`, tracking the pen position so the next command (and any
 * arc-splits) start from the right point. Radii are scaled by `sx`/`sy` too
 * (an arcTo's wR/hR are lengths in the same local space as points) --
 * NON-UNIFORM scale on a circular arc turns it elliptical, which is exactly
 * what the source geometry intends (its wR/hR are already independent per
 * axis).
 *
 * Args:
 *   commands (Array<object>): raw path commands (guide-name or literal args).
 *   guides (Map<string, number>): the shape's folded guide table.
 *   pathW, pathH (number): this path's OWN declared local coordinate space.
 *   shapeW, shapeH (number): the shape's target box to scale into.
 *
 * Returns:
 *   string -- an SVG path `d` attribute value.
 *
 * @example emitPathCommands([{cmd:"moveTo",x:0,y:0},{cmd:"lnTo",x:"gw",y:"gh"}], new Map([["gw",10],["gh",10]]), 10, 10, 100, 100) // "M 0,0 L 100,100"
 */
export function emitPathCommands(commands, guides, pathW, pathH, shapeW, shapeH) {
  if (pathW === 0 || pathH === 0)
    throw new Error(`preset_geometry: degenerate path coordinate space (w=${pathW}, h=${pathH})`);
  const sx = shapeW / pathW, sy = shapeH / pathH;
  let penX = 0, penY = 0;
  const parts = [];

  for (const raw of commands) {
    const c = resolveCommand(raw, guides);
    switch (c.cmd) {
      case "moveTo":
        penX = c.x * sx; penY = c.y * sy;
        parts.push(`M ${penX},${penY}`);
        break;
      case "lnTo":
        penX = c.x * sx; penY = c.y * sy;
        parts.push(`L ${penX},${penY}`);
        break;
      case "cubicBezTo":
        penX = c.x * sx; penY = c.y * sy;
        parts.push(`C ${c.x1 * sx},${c.y1 * sy} ${c.x2 * sx},${c.y2 * sy} ${penX},${penY}`);
        break;
      case "quadBezTo":
        penX = c.x * sx; penY = c.y * sy;
        parts.push(`Q ${c.x1 * sx},${c.y1 * sy} ${penX},${penY}`);
        break;
      case "arcTo": {
        const { segments, endX, endY } = arcToSvgSegments(penX, penY, c.wR * sx, c.hR * sy, c.stAng, c.swAng);
        parts.push(...segments);
        penX = endX; penY = endY;
        break;
      }
      case "close":
        parts.push("Z");
        break;
      /* c8 ignore next */
      default:
        throw new Error(`preset_geometry: unhandled resolved command "${c.cmd}"`);
    }
  }
  return parts.join(" ");
}

/**
 * Pure function. Converts one resolved `<a:rect l t r b>` (the shape's
 * text-bounding rect, each field a guide name or literal) into a
 * `{x,y,w,h}` box in the SAME scaled shape space `emitPathCommands` targets.
 * Returns null when `rectSpec` itself is null/undefined (some presets, e.g.
 * `line`, `chartX`, declare no `<rect>` at all -- there is no text box).
 *
 * @example resolveTextRect({l:"l",t:"t",r:"r",b:"b"}, new Map([["l",0],["t",0],["r",100],["b",50]])) // {x:0,y:0,w:100,h:50}
 * @example resolveTextRect(null, new Map()) // null
 */
export function resolveTextRect(rectSpec, guides) {
  if (!rectSpec) return null;
  const l = resolveArg(String(rectSpec.l), guides);
  const t = resolveArg(String(rectSpec.t), guides);
  const r = resolveArg(String(rectSpec.r), guides);
  const b = resolveArg(String(rectSpec.b), guides);
  return { x: l, y: t, w: r - l, h: b - t };
}

/**
 * THE PER-SUBPATH FILL MODIFIERS (`<a:path fill="...">`, ST_PathFillMode), as
 * a BLEND FRACTION toward black (negative) or white (positive). A DrawingML
 * preset paints its 3D shading by declaring the SAME widget fill on several
 * subpaths and asking for it darker or lighter per face — `cube`'s three
 * visible faces are norm/darkenLess/lightenLess of one colour, which is why a
 * renderer that ignores these draws a flat silhouette where a cube should be.
 *
 * ECMA-376 DOES NOT DEFINE THE MATH — it gives these enumerants display names
 * only ("Darken Path Fill Less") and no factor — so these come from the two
 * reference implementations:
 *   - LibreOffice `EnhancedCustomShape2d.cxx`'s `CreateSubPath`, which sets
 *     `dBrightness` to -0.4 / -0.2 / +0.4 / +0.2 for DARKEN / DARKENLESS /
 *     LIGHTEN / LIGHTENLESS, applied by `GetColorData` as a straight per-channel
 *     RGB lerp toward 0 or 255 (NO HSL/HSV, no gamma — its HSV path is the
 *     LEGACY binary-MS branch, gated off for `ooxml-*` shapes).
 *   - [MS-OI29500] S2.1.1327, which documents Office's own behaviour as
 *     "blended with 40% black" / "20% white" etc., i.e. the same model.
 * MEASURED AGAINST THE REFERENCE RENDERER, which is why these exact numbers are
 * here rather than Office's: LibreOffice's headless PDF of this very table,
 * with the widget's own `#7DCFFF` fill, writes `#4B7C99` for a `darken` face
 * (= c * 0.6), `#64A5CC` for `darkenLess` (= c * 0.8), `#B1E2FF` for `lighten`
 * and `#97D8FF` for `lightenLess` — each exact on all three channels, and
 * confirmed one-to-one against the declared flags on cube, bevel, can,
 * actionButtonHome and curvedDownArrow.
 *
 * OFFICE DIVERGES BY ABOUT ONE CODE VALUE on the "Less" pair and it is
 * deliberately NOT matched: [MS-OI29500] notes Office uses 50/255 (~0.196)
 * rather than 0.2. This app's measurable reference is LibreOffice (the one
 * renderer the acceptance sweep compares against and the only one this project
 * may drive headlessly), so it matches LibreOffice exactly rather than splitting
 * the difference with a renderer it cannot check. Neither factor reproduces the
 * reference on its own, incidentally — the last code value comes from the
 * TRUNCATION documented at the return below, and chasing it with the factor
 * instead would have hidden a real rule behind a fudged constant.
 */
const PATH_FILL_BRIGHTNESS = {
  norm: 0,
  darken: -0.4,
  darkenLess: -0.2,
  lighten: 0.4,
  lightenLess: 0.2,
};

/**
 * Pure function. Applies one `<a:path fill="...">` modifier to a hex colour,
 * per `PATH_FILL_BRIGHTNESS` above: a straight per-channel lerp toward black
 * (darken*) or white (lighten*), leaving ALPHA untouched — the shading changes
 * a face's brightness, never its coverage.
 *
 * `"none"` is NOT handled here and must be branched on by the caller: it means
 * the subpath is not filled AT ALL (a stroke-only detail line), which is the
 * absence of a colour rather than a modification of one. Passing it throws,
 * because silently returning the unmodified colour would flood-fill exactly the
 * subpaths that must stay empty — the defect this whole path exists to fix.
 *
 * A non-hex paint (a gradient object, a named colour) passes through UNCHANGED
 * rather than throwing: the shading is a convenience on a solid fill, and a
 * widget whose fill is a gradient still draws its faces — undifferentiated,
 * which is visibly imperfect but is a picture, not a crash. `norm` short-
 * circuits so the overwhelmingly common case is identity by construction.
 *
 * Args:
 *   color (string): the widget's fill, "#rgb"/"#rrggbb"/"#rrggbbaa".
 *   mode (string): "norm" | "darken" | "darkenLess" | "lighten" | "lightenLess".
 *
 * Returns:
 *   string -- the shaded colour, or `color` itself when unmodified.
 *
 * @example shadeSubpathFill("#7DCFFF", "norm") // "#7DCFFF" (identity, by short-circuit)
 * @example shadeSubpathFill("#7dcfff", "darken") // "#4b7c99" (c * 0.6 — LibreOffice's own cube face)
 * @example shadeSubpathFill("#7dcfff", "darkenLess") // "#64a5cc" (c * 0.8, truncated)
 * @example shadeSubpathFill("#7dcfff", "lighten") // "#b1e2ff" (c + (255-c) * 0.4)
 * @example shadeSubpathFill("#7dcfff", "lightenLess") // "#97d8ff" (c + (255-c) * 0.2, truncated)
 * @example shadeSubpathFill("#7dcfff80", "darken") // "#4b7c9980" (alpha survives untouched)
 * @example shadeSubpathFill("rgba(1,2,3,0.5)", "darken") // "rgba(1,2,3,0.5)" (non-hex passes through)
 */
export function shadeSubpathFill(color, mode) {
  if (mode === "none")
    throw new Error('preset_geometry: shadeSubpathFill got fill="none" — that subpath must not be filled at all, not filled with a shaded colour');
  const brightness = PATH_FILL_BRIGHTNESS[mode];
  if (brightness === undefined)
    throw new Error(`preset_geometry: unknown path fill mode "${mode}" (expected one of ${Object.keys(PATH_FILL_BRIGHTNESS).join(", ")}, none)`);
  if (brightness === 0) return color;
  if (typeof color !== "string" || !/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) return color;

  let h = color.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const channels = [];
  for (let i = 0; i < h.length; i += 2) channels.push(parseInt(h.slice(i, i + 2), 16));
  const CHANNEL_MAX = 255;
  // Only R/G/B shade; a 4th channel (alpha) is carried through as-is.
  const shaded = channels.map((c, i) =>
    i >= 3 ? c : brightness >= 0 ? c * (1 - brightness) + brightness * CHANNEL_MAX : c * (1 + brightness));
  // TRUNCATED, NOT ROUNDED, and this is measured rather than stylistic:
  // LibreOffice's `Color` takes `sal_uInt8`, so its double -> byte conversion
  // truncates. Rounding disagrees with the reference on exactly the channels
  // whose product lands mid-step — `darkenLess` of #7DCFFF is #64A5CC truncated
  // and #64A6CC rounded, and LibreOffice writes the former. All four modes match
  // on all three channels under truncation and only two of four under rounding.
  return "#" + shaded
    .map((c) => Math.floor(Math.max(0, Math.min(CHANNEL_MAX, c))).toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Pure function. Folds one `pathLst` (array of `{w?, h?, fill?, stroke?,
 * commands}`) into the `subpaths` half of this module's return contract,
 * scaling each path's own local space into the shape's `[0,shapeW] x
 * [0,shapeH]` box independently (§3 of the geometry research: sibling
 * `<a:path>` elements may declare DIFFERENT local w/h, so the scale factor
 * is recomputed per path, never shared). `fill`/`stroke` default to DrawingML's
 * own defaults ("norm" / true) when absent, matching the schema.
 *
 * @example foldPathList([{w:10,h:10,commands:[{cmd:"moveTo",x:0,y:0},{cmd:"lnTo",x:10,y:10}]}], new Map(), 100, 100) // [{d:"M 0,0 L 100,100", fill:"norm", stroke:true}]
 */
export function foldPathList(pathLst, guides, shapeW, shapeH) {
  return pathLst.map((p) => {
    const pathW = p.w ?? shapeW, pathH = p.h ?? shapeH;
    return {
      d: emitPathCommands(p.commands, guides, pathW, pathH, shapeW, shapeH),
      fill: p.fill ?? "norm",
      stroke: p.stroke ?? true,
    };
  });
}

/**
 * Turns a compiled preset shape definition (from `preset_shape_defs.json`)
 * plus instance adjustment overrides and a target box into SVG path data.
 *
 * Args:
 *   name (string): a preset shape name (`prstGeom prst="..."`, e.g. "roundRect").
 *   adjustments (object): `{gdName: value}` -- instance-level overrides of
 *     the shape's `avLst` defaults (a slide's own `<a:avLst>`), pre-parsed
 *     to numbers. May be `{}` to use every default.
 *   w, h (number): the shape's target box (EMU or any consistent unit --
 *     this module is unit-agnostic; the caller's `w`/`h` define the space
 *     every returned coordinate is expressed in).
 *   defs (object): the compiled preset table (defaults to the vendored
 *     `preset_shape_defs.json`; overridable for testing against a hand-built
 *     definition without touching the vendored file).
 *
 * Returns:
 *   {subpaths: Array<{d: string, fill: string, stroke: boolean}>,
 *    textRect: {x,y,w,h} | null}
 *
 * The two examples below need the vendored defs installed first
 * (installPresetDefs — see tests/pptx_geometry_test.js), so they are
 * comment-form; the same assertions run for real in that test file.
 *
 * @example // presetShapePath("rect", {}, 100, 50).subpaths[0].d → "M 0,0 L 100,0 L 100,50 L 0,50 Z"
 * @example // presetShapePath("roundRect", {}, 100, 100).subpaths.length → 1
 */
export function presetShapePath(name, adjustments, w, h, defs = null) {
  const table = defs ?? loadDefaultDefs();
  const def = table[name];
  if (!def) throw new Error(`preset_geometry: unknown preset shape "${name}"`);
  const guides = foldGuides(def.avLst, adjustments, def.gdLst, w, h);
  return {
    subpaths: foldPathList(def.pathLst, guides, w, h),
    textRect: resolveTextRect(def.rect, guides),
  };
}

/**
 * Turns a parsed `<a:custGeom>` (plain-data IR, identical in shape to one
 * compiled preset table entry -- custGeom IS an inline avLst+gdLst+pathLst
 * attached to a single shape instance) plus a target box into SVG path data.
 *
 * Args:
 *   custGeom (object): `{avLst?: {gdName: defaultValue}, gdLst?: [[name,
 *     fmla], ...], rect?: {l,t,r,b} | null, pathLst: [{w?, h?, fill?,
 *     stroke?, commands: [{cmd: "moveTo"|"lnTo"|"arcTo"|"cubicBezTo"|
 *     "quadBezTo"|"close", ...args}]}]}`. `commands` args per cmd:
 *       moveTo/lnTo:      {x, y}
 *       cubicBezTo:       {x1, y1, x2, y2, x, y}
 *       quadBezTo:        {x1, y1, x, y}
 *       arcTo:            {wR, hR, stAng, swAng}
 *       close:            {} (no args)
 *     Every numeric field may instead be a guide-name STRING (resolved
 *     through `avLst`/`gdLst`/built-ins exactly like a preset). `avLst`,
 *     `gdLst` and `rect` are each optional (custGeom commonly has no
 *     adjustable guides at all -- e.g. the deck's one hand-drawn freeform,
 *     which is pure `moveTo`/`lnTo` literals with no avLst/gdLst).
 *   w, h (number): the shape's target box, same units contract as
 *     `presetShapePath`.
 *
 * Returns:
 *   {subpaths: Array<{d: string, fill: string, stroke: boolean}>,
 *    textRect: {x,y,w,h} | null} -- identical shape to `presetShapePath`'s
 *   return, so a caller can treat every shape (preset or custom) uniformly.
 *
 * @example custGeomPath({pathLst:[{w:10,h:10,commands:[{cmd:"moveTo",x:0,y:10},{cmd:"lnTo",x:0,y:0},{cmd:"lnTo",x:10,y:0}]}]}, 100, 100).subpaths[0].d // "M 0,100 L 0,0 L 100,0"
 */
export function custGeomPath(custGeom, w, h) {
  if (!custGeom.pathLst || custGeom.pathLst.length === 0)
    throw new Error("preset_geometry: custGeom has no pathLst");
  const guides = foldGuides(custGeom.avLst, {}, custGeom.gdLst, w, h);
  return {
    subpaths: foldPathList(custGeom.pathLst, guides, w, h),
    textRect: resolveTextRect(custGeom.rect ?? null, guides),
  };
}

// Lazily loaded so a bare-node test can import this module before the
// vendored JSON exists (e.g. while iterating on the evaluator itself) and
// only pay the read cost for callers that actually reach `presetShapePath`
// without passing their own `defs`.
let cachedDefs = null;
function loadDefaultDefs() {
  if (cachedDefs) return cachedDefs;
  throw new Error(
    "preset_geometry: no preset defs loaded -- call installPresetDefs(json) once " +
    "(see tests/pptx_geometry_test.js) or pass `defs` explicitly to presetShapePath()"
  );
}

/**
 * Command. Installs the compiled preset shape table (parsed
 * `preset_shape_defs.json`) as the DEFAULT `defs` for `presetShapePath` calls
 * that don't pass their own. This module stays import-free of Node's `fs`
 * (so it also runs unmodified in the browser/Vite bundle, per this app's
 * `core/` rule of DOM-free-but-also-fs-free purity) -- the caller (a test, or
 * the real pptx-import parser module) is responsible for reading the JSON
 * file and calling this once at startup.
 *
 * @example installPresetDefs({rect: {avLst:{}, gdLst:[], rect:{l:"l",t:"t",r:"r",b:"b"}, pathLst:[{commands:[]}]}}) // undefined
 */
export function installPresetDefs(defs) {
  cachedDefs = defs;
}
