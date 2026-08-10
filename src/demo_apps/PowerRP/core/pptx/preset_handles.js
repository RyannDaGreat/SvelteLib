/**
 * PRESET SHAPE ADJUST HANDLES ("ahLst") — parses a preset shape's `<a:ahLst>`
 * (stored raw on `preset_shape_defs.json`'s `shapes[name].ahLst`, per
 * preset_geometry.js's header note that the vendored table keeps it as an
 * unparsed XML fragment) into structured handle descriptors, computes each
 * handle's ON-CANVAS POSITION from the shape's current adjustment values, and
 * INVERTS a drag back into new adjustment value(s). Pure, DOM-free, no
 * cross-module imports besides `core/pptx/xml.js` (the app's own bare-node XML
 * parser) and `core/pptx/preset_geometry.js` (the guide-folding/formula
 * evaluator every preset shape's geometry already goes through) — so a
 * PowerRP plugin wiring these into draggable handles needs nothing else.
 *
 * ── WHAT ahLst LOOKS LIKE (ECMA-376 §20.1.9.5/§20.1.9.6) ─────────────────────
 * Each `<a:ahXY>` or `<a:ahPolar>` element is ONE draggable handle. `ahXY`
 * carries `gdRefX`/`gdRefY` (each OPTIONAL — a handle may constrain only one
 * axis), each with a `minX/maxX` or `minY/maxY` RANGE the referenced guide is
 * clamped to. `ahPolar` carries `gdRefR`/`gdRefAng` analogously (`minR/maxR`,
 * `minAng/maxAng`, angles in 60,000ths of a degree). Every handle has exactly
 * one `<a:pos x="..." y="...">` child — the LOCAL point (in the shape's own
 * `[0,w]x[0,h]` box) the handle is drawn at, each coordinate a GUIDE NAME
 * (never a literal, confirmed by grepping the whole 187-shape vendored table:
 * every `pos` x/y token matches `^[A-Za-z_][A-Za-z0-9_]*$`).
 *
 * `min*`/`max*` ARE ALSO GUIDE-NAME-OR-LITERAL TOKENS, NOT ALWAYS NUMBERS.
 * 92 of the 243 vendored handle instances give a bound as a NAME (e.g.
 * `rightArrow`'s `maxX="maxAdj2"`, itself `gdLst`-declared as the
 * multiply-divide of 100000, w and ss; `circularArrow`'s `maxAng="maxAng"`,
 * declared `abs u21`) rather than a literal like `maxX="50000"`. So every bound is resolved through
 * `resolveArg` against the shape's CURRENT folded guide table (the same
 * `foldGuides` position/inversion already use) at the moment it is needed —
 * never `Number()`'d directly off the XML attribute, which would silently
 * produce NaN for every named bound and was this module's first bug (caught
 * by hand-checking `rightArrow` against its own gdLst before writing the test
 * suite). A bound may depend on the CURRENT value of some other adjustment
 * (`maxAdj1 = a5*2` on `circularArrow` depends on `adj5`), so it is
 * re-resolved on every read, not cached once.
 *
 * ── THE INVERSION PROBLEM ─────────────────────────────────────────────────
 * A handle's `pos` is some guide (e.g. `x1`), which is some formula chain
 * ultimately depending on the handle's own `gdRef*` adjustment(s) plus fixed
 * shape geometry (`w`, `h`, other adj values NOT this handle's own). Dragging
 * the handle means: given a DESIRED (x,y), solve for the adj value(s) that
 * make the guide evaluate back to that position.
 *
 * TWO STRATEGIES, chosen by handle kind:
 *
 *   ahXY axis — SOLVED NUMERICALLY, by BISECTION against the REAL guide
 *     evaluator (`foldGuides` + `resolveArg`, the exact same code
 *     `presetShapePath` renders with — so the handle can never disagree with
 *     the picture it drags). This is EXACT, not a heuristic approximation:
 *     every `pos` guide observed in the vendored table is an AFFINE (usually
 *     literally `scale * adj / 100000 + offset`) function of its own handle's
 *     adj value, hence strictly monotonic on the handle's declared
 *     `[min,max]` range, and bisection converges to the exact root of a
 *     monotonic continuous function to within `BISECTION_TOLERANCE` guide
 *     units (60,000ths of a degree or 1/100,000 of a dimension — far finer
 *     than a screen pixel). It is written as bisection rather than a symbolic
 *     affine solve so it needs no per-shape special-casing and stays correct
 *     even for a formula chain that is monotonic but not literally affine
 *     (none observed, but the table is LibreOffice's, not ours, and a future
 *     shape added to it should not need this file touched). A handle whose
 *     two AXES (`gdRefX`+`gdRefY`, both present) each reference a DIFFERENT
 *     adj name is solved per-axis independently — this holds for all 40
 *     dual-axis handles in the table (the `*Callout` family), each axis's own
 *     guide reading only its own adj.
 *
 *   ahPolar — APPROXIMATE, BY DESIGN, and this is the one place this module
 *     is not exact (documented loudly per the "never silently wrong" rule).
 *     TWO bugs were found and fixed while building this against the FULL
 *     187-shape catalog (both by the round-trip sweep in
 *     tests/pptx_preset_handles_test.js catching them, neither left in):
 *       1. A first version solved the angle guide DIRECTLY via `atan2`
 *          (reading it as the point's raw heading from the box center),
 *          reasoning that `dx/dy = cat2/sat2(radius, cos ang, sin ang)` in
 *          every vendored `ahPolar`'s gdLst makes the DRAWN POINT's heading
 *          equal the angle argument. True, but the guide the handle WRITES is
 *          not always that argument directly — `circularArrow`'s angle
 *          handles write an OFFSET from another angle (`ptAng = enAng +
 *          adj2`, not `adj2` alone) — so solving `adj2 = atan2(...)` directly
 *          answered a different question (measured round-trip error up to
 *          31.8 units on a 240x180 box). Fixed by bisecting on angular
 *          distance (`angularDelta`) between a CANDIDATE adj's resulting
 *          heading and the target heading, instead of assuming the adj IS
 *          the heading — exact whenever the angle argument is a monotonic
 *          function of the adj, which `circularArrow`'s offset form still is.
 *       2. That per-sample bisection then broke on `pie`/`blockArc`/`chord`,
 *          whose declared range is a FULL TURN (`minAng="0"
 *          maxAng="21599999"`): the two range ENDPOINTS have nearly identical
 *          headings (0deg and ~360deg-epsilon both read as ~0deg) even though
 *          the true root sits in the middle, and independently normalizing
 *          each sample's `angularDelta` ALSO manufactured a spurious sign
 *          change at the ±180deg branch cut. Fixed by UNWRAPPING the sampled
 *          headings into one continuous running total before bisecting — see
 *          the implementation comment above `solveAngleForGuide` for the
 *          mechanics.
 *     The RADIUS (when `gdRefR` is present) is solved the same bisection way
 *     as an ahXY axis, as distance from center, with the angle held at its
 *     just-solved value — matching PowerPoint's own two-pass feel (angle
 *     snaps first, radius follows).
 *     THE REMAINING APPROXIMATION: this all assumes the point's heading moves
 *     MONOTONICALLY with the adj across the declared range, which holds for
 *     every vendored `ahPolar` (asserted by the catalog round-trip sweep) but
 *     is not derived from the formula grammar the way the ahXY guarantee is —
 *     a future shape whose angle guide is non-monotonic in the adj would
 *     still converge to A root, not necessarily the intended one.
 *
 * DRAGGING PAST A HANDLE'S DECLARED RANGE CLAMPS TO THE NEAREST REACHABLE
 * POSITION, exactly like every other `constrain` in this codebase — that is
 * ordinary user interaction (a handle dragged past the shape's own box), not
 * an error. What DOES throw loudly is a guide that turns out to be FLAT
 * across its whole declared range (its `pos` does not actually vary with the
 * `gdRef*` adj its own `ahLst` entry claims controls it) — a genuine
 * data/wiring bug, not a reachability question; see `solveAdjForGuide`.
 */

import { parseXml, xmlChild, xmlAttr } from "./xml.js";
import { foldGuides, resolveArg } from "./preset_geometry.js";

const DEG60000 = 21600000; // one full turn, in 60,000ths of a degree (same constant preset_geometry.js's arc code uses)

/**
 * Pure function. Parses a shape's raw `ahLst` XML fragment (the bare sequence
 * of sibling `<ahXY>`/`<ahPolar>` elements PowerRP's vendoring step stores,
 * with NO wrapping root element and no `a:` namespace prefix) into structured
 * handle descriptors, in declaration order (handle index = drag priority order
 * PowerPoint itself uses, e.g. pie's start-angle handle before its end-angle
 * handle).
 *
 * Args:
 *   ahLstRaw (string|null|undefined): the raw fragment, or null/empty for a
 *     shape with no adjust handles (67 of 187 vendored shapes, e.g. "rect").
 *
 * Returns:
 *   Array<{kind: "xy"|"polar", posX: string, posY: string,
 *          gdRefX?: string, minX?: string, maxX?: string,
 *          gdRefY?: string, minY?: string, maxY?: string,
 *          gdRefR?: string, minR?: string, maxR?: string,
 *          gdRefAng?: string, minAng?: string, maxAng?: string}>
 *   (`min*`/`max*` are RAW TOKENS — guide names or numeric literals, both as
 *   strings — resolved via `resolveHandleBound` at use time; see header.)
 *
 * @example parseAhLst(null) // []
 * @example parseAhLst('<ahXY gdRefX="adj" minX="0" maxX="50000"><pos x="x1" y="t"/></ahXY>')
 * // [{kind: "xy", gdRefX: "adj", minX: "0", maxX: "50000", posX: "x1", posY: "t"}]
 */
export function parseAhLst(ahLstRaw) {
  if (!ahLstRaw || !ahLstRaw.trim()) return [];
  const root = parseXml(`<ahLst>${ahLstRaw}</ahLst>`);
  const tokAttr = (node, local) => xmlAttr(node, null, local, null) ?? undefined;
  const out = [];
  for (const child of root.children) {
    if (child.type !== "element") continue;
    const pos = xmlChild(child, null, "pos");
    if (!pos) throw new Error(`preset_handles: <${child.local}> has no <pos> child`);
    const posX = xmlAttr(pos, null, "x", null);
    const posY = xmlAttr(pos, null, "y", null);
    if (posX === null || posY === null) throw new Error(`preset_handles: <pos> missing x/y on <${child.local}>`);
    if (child.local === "ahXY") {
      const h = { kind: "xy", posX, posY };
      const gdRefX = xmlAttr(child, null, "gdRefX", null);
      const gdRefY = xmlAttr(child, null, "gdRefY", null);
      if (gdRefX !== null) Object.assign(h, { gdRefX, minX: tokAttr(child, "minX"), maxX: tokAttr(child, "maxX") });
      if (gdRefY !== null) Object.assign(h, { gdRefY, minY: tokAttr(child, "minY"), maxY: tokAttr(child, "maxY") });
      if (gdRefX === null && gdRefY === null)
        throw new Error(`preset_handles: <ahXY> declares neither gdRefX nor gdRefY`);
      out.push(h);
    } else if (child.local === "ahPolar") {
      const h = { kind: "polar", posX, posY };
      const gdRefR = xmlAttr(child, null, "gdRefR", null);
      const gdRefAng = xmlAttr(child, null, "gdRefAng", null);
      if (gdRefR !== null) Object.assign(h, { gdRefR, minR: tokAttr(child, "minR"), maxR: tokAttr(child, "maxR") });
      if (gdRefAng !== null) Object.assign(h, { gdRefAng, minAng: tokAttr(child, "minAng"), maxAng: tokAttr(child, "maxAng") });
      if (gdRefR === null && gdRefAng === null)
        throw new Error(`preset_handles: <ahPolar> declares neither gdRefR nor gdRefAng`);
      out.push(h);
    } else {
      throw new Error(`preset_handles: unknown adjust-handle element <${child.local}> (expected ahXY or ahPolar)`);
    }
  }
  return out;
}

/**
 * Pure function. Resolves a `min*`/`max*` bound TOKEN (a guide name or a
 * numeric literal, both stored as strings by `parseAhLst` — see header) to a
 * number against a folded guide table, or `undefined` through when the bound
 * itself is absent (an unbounded side — none observed in the vendored table,
 * kept as the honest default rather than inventing a limit).
 *
 * @example resolveHandleBound(undefined, new Map()) // undefined
 * @example resolveHandleBound("50000", new Map()) // 50000
 * @example resolveHandleBound("maxAdj2", new Map([["maxAdj2", 33333]])) // 33333
 */
export function resolveHandleBound(token, guides) {
  return token === undefined ? undefined : resolveArg(token, guides);
}

/**
 * Pure function. Every adj guide NAME a shape's ahLst references (its
 * `avLst` keys that are drag-controllable), in ahLst declaration order, each
 * name listed once even if several handles share it. Used by callers that
 * need to know which Inspector rows have an on-canvas counterpart.
 *
 * @example adjustableGuideNames([{kind:"xy", gdRefX:"adj1"}, {kind:"xy", gdRefY:"adj1"}, {kind:"polar", gdRefAng:"adj2"}])
 * // ["adj1", "adj2"]
 */
export function adjustableGuideNames(handles) {
  const seen = new Set();
  for (const h of handles) for (const k of ["gdRefX", "gdRefY", "gdRefR", "gdRefAng"]) if (h[k]) seen.add(h[k]);
  return [...seen];
}

/**
 * Pure function. This handle's drawn LOCAL position (in the shape's own
 * `[0,w]x[0,h]` box) given the shape's CURRENT adjustment overrides — folds
 * guides exactly as `presetShapePath` does (same `foldGuides`), then reads the
 * two guide names the handle's `<pos>` names.
 *
 * @param {object} handle - one entry from `parseAhLst`
 * @param {object} shapeDef - the preset table entry (`{avLst, gdLst, ...}`)
 * @param {object} adj - current instance adjustment overrides (`{gdName: value}`)
 * @param {number} w
 * @param {number} h
 * @returns {{x: number, y: number}}
 *
 * @example // roundRect at default adj=16667, box 200x100: x1 = ss*a/100000 = 100*16667/100000 ≈ 16.667, t = 0
 * // handlePosition({kind:"xy", gdRefX:"adj", posX:"x1", posY:"t"}, ROUND_RECT_DEF, {}, 200, 100) // {x: 16.667, y: 0}
 */
export function handlePosition(handle, shapeDef, adj, w, h) {
  const guides = foldGuides(shapeDef.avLst, adj, shapeDef.gdLst, w, h);
  return { x: resolveArg(handle.posX, guides), y: resolveArg(handle.posY, guides) };
}

/**
 * Pure function. Every handle's current LOCAL position for a preset shape, in
 * ahLst declaration order, each carrying a stable `id` (`"h0"`, `"h1"`, ...
 * positional, since ahLst declares no names of its own).
 *
 * @param {string} name - preset shape name (key into `defs`)
 * @param {object} adj - current instance adjustment overrides
 * @param {number} w
 * @param {number} h
 * @param {object} defs - the compiled preset table (`preset_shape_defs.json`'s `.shapes`)
 * @returns {Array<{id: string, x: number, y: number}>}
 *
 * @example handlePositions("roundRect", {}, 200, 100, DEFS).length // 1
 */
export function handlePositions(name, adj, w, h, defs) {
  const def = defs[name];
  if (!def) throw new Error(`preset_handles: unknown preset shape "${name}"`);
  const handles = parseAhLst(def.ahLst);
  return handles.map((handle, i) => ({ id: `h${i}`, ...handlePosition(handle, def, adj, w, h) }));
}

const BISECTION_TOLERANCE = 1e-6; // guide units: 100,000ths of a dimension, or 60,000ths of a degree — far under a screen pixel
const BISECTION_MAX_ITERS = 60; // 2^-60 of any real [min,max] range is below float noise; a real root converges in under half this

/**
 * Near-pure function (throws only on a genuinely DEGENERATE guide — see
 * below, otherwise pure). Solves `adjName` (bounded to `[lo, hi]`) so that,
 * after refolding this shape's guides with that one adj value changed,
 * `readGuide` of the resulting table equals `target` — by BISECTION against
 * the real evaluator (see module header: exact for the monotonic chains every
 * vendored shape uses, general enough for one that only stays monotonic).
 *
 * DRAGGING PAST AN ENDPOINT CLAMPS, IT DOES NOT THROW — this is the ordinary
 * case (the user drags a handle beyond the shape's own box, or past the range
 * PowerPoint itself enforces) and matches every other `constrain` in this
 * codebase (shapeshifter.js's `clamp`): when `target` is beyond what the
 * guide reaches across `[lo,hi]`, the nearer endpoint wins, silently. What
 * DOES throw is a guide that is FLAT across its whole declared range
 * (`readGuide(lo) === readGuide(hi)` while `lo !== hi`) — that is not a
 * reachability question at all, it means this handle's own `pos` guide does
 * not actually depend on `adjName` the way its `gdRef*` claims, which is a
 * genuine data/wiring bug this function cannot silently paper over by
 * guessing an answer. None of the 243 vendored handle instances hits this
 * (asserted by tests/pptx_preset_handles_test.js's full-catalog sweep).
 *
 * Args:
 *   adjName (string): the adj guide name to solve for (e.g. "adj", "adj2").
 *   lo, hi (number): the handle's declared min/max for this guide (may be
 *     undefined = unbounded; falls back to `held`, making an unbounded axis
 *     with no numeric range a no-op rather than an invented limit).
 *   target (number): the desired value of the guide `readGuide` reads.
 *   readGuide (adjValue: number) => number: refolds guides with `adjName` set
 *     to `adjValue` (all other current adj values held) and returns the
 *     guide's resulting numeric value. Supplied by the caller so this
 *     function stays generic over ahXY/ahPolar and over which guide (`posX`
 *     vs `posY` vs an angle/radius reading) is being solved.
 *   held (number): the CURRENT value of `adjName`, returned unchanged when
 *     `lo === hi` (a zero-width range has nothing to solve — the KEEP
 *     precedent shapeshifter.js's `ratioOf`/`readOrKeep` already use for a
 *     degenerate divisor).
 *
 * Returns:
 *   number — the solved adj value, clamped into `[lo, hi]`.
 *
 * @example solveAdjForGuide("adj", 0, 50000, 25, (a) => a / 1000, 16667) // 25000 (readGuide(a)=a/1000, want 25 -> a=25000)
 * @example solveAdjForGuide("adj", 10, 10, 999, (a) => a, 10) // 10 (zero-width range — KEEP, no solve attempted)
 * @example solveAdjForGuide("adj", 0, 50000, 999999, (a) => a / 1000, 16667) // 50000 (target past the reachable range — CLAMPS to the endpoint, never throws)
 */
export function solveAdjForGuide(adjName, lo, hi, target, readGuide, held) {
  const loB = lo ?? held, hiB = hi ?? held;
  if (loB === hiB) return held;
  let a = Math.min(loB, hiB), b = Math.max(loB, hiB);
  const ga = readGuide(a), gb = readGuide(b);
  if (ga === gb)
    throw new Error(`preset_handles: guide "${adjName}" is FLAT across its declared range [${loB},${hiB}] (both ends give ${ga}) — its pos does not actually depend on this handle's own gdRef, which the ahLst declaration claims it does`);
  // Clamp the TARGET to what this guide can actually reach before bisecting —
  // this is what makes an out-of-box drag land on the endpoint rather than
  // throwing (see header). Increasing/decreasing orientation may run either
  // direction (ga < gb or ga > gb), so clamp against the actual pair, not
  // assumed monotonic-increasing order.
  const gLo = Math.min(ga, gb), gHi = Math.max(ga, gb);
  const t = Math.max(gLo, Math.min(target, gHi));
  let fa = ga - t, fb = gb - t;
  if (fa === 0) return a;
  if (fb === 0) return b;
  for (let i = 0; i < BISECTION_MAX_ITERS && b - a > BISECTION_TOLERANCE; i++) {
    const mid = (a + b) / 2;
    const fm = readGuide(mid) - t;
    if (fm === 0) return mid;
    if ((fm > 0) === (fa > 0)) { a = mid; fa = fm; } else { b = mid; }
  }
  return (a + b) / 2;
}

/**
 * Pure function. A guide table identical to `foldGuides(shapeDef.avLst, adj,
 * shapeDef.gdLst, w, h)` except with ONE adj name overridden — the primitive
 * `solveAdjForGuide`'s `readGuide` callbacks are built from.
 *
 * @example guidesWithAdj(ROUND_RECT_DEF, {}, 200, 100, "adj", 25000).get("a") // 25000
 */
function guidesWithAdj(shapeDef, adj, w, h, adjName, value) {
  return foldGuides(shapeDef.avLst, { ...adj, [adjName]: value }, shapeDef.gdLst, w, h);
}

/**
 * Pure function. Normalizes an angle in 60,000ths of a degree into `[0,
 * DEG60000)`.
 *
 * @example normalizeAngle60000(-5400000) // 16200000 (-90deg -> 270deg)
 * @example normalizeAngle60000(27000000) // 5400000 (390deg -> 30deg)
 */
export function normalizeAngle60000(a) {
  return ((a % DEG60000) + DEG60000) % DEG60000;
}

/**
 * Pure function. The signed angular distance FROM `from` TO `to` (both in
 * 60,000ths of a degree), in `(-DEG60000/2, DEG60000/2]` — the SHORT way
 * around, positive = counter-clockwise-of (in the increasing-angle sense
 * `at2`/`atan2` already use). This is the bisection objective
 * `solveAngleForGuide` roots: monotonic in the handle's own adj exactly when
 * the underlying heading is, and well-behaved across the 0/360 seam (a plain
 * subtraction is not — 359deg minus 1deg would read as 358deg apart instead
 * of 2).
 *
 * @example angularDelta(0, 5400000) // 5400000 (0deg -> 90deg is +90deg)
 * @example angularDelta(21000000, 1200000) // 1800000 (350deg -> 20deg the SHORT way is +30deg, not -330deg)
 */
export function angularDelta(from, to) {
  const raw = normalizeAngle60000(to - from);
  return raw > DEG60000 / 2 ? raw - DEG60000 : raw;
}

/**
 * Near-pure function (throws only when the heading is FLAT across the whole
 * declared range — the same "genuine wiring bug" contract as
 * `solveAdjForGuide`, restated for an angular objective). Solves `adjName` so
 * that, after refolding guides, the ANGLE of the point `readPoint(adjValue)`
 * (measured from `center` via `atan2`) matches `targetAngle` (60,000ths of a
 * degree) — by BISECTING ON SIGNED ANGULAR DISTANCE (`angularDelta`) rather
 * than reading the adj as the heading directly, because (per the module
 * header's `circularArrow` finding) an `ahPolar` angle guide is not always
 * the point's raw heading, only a monotonic function of it. Wraparound-safe:
 * the bisection's error term is the SHORTEST signed turn from the candidate
 * heading to the target, continuous across the 0/360 seam where a plain angle
 * subtraction would not be.
 *
 * DRAGGING PAST THE DECLARED RANGE CLAMPS to whichever endpoint's heading is
 * angularly nearer the target — the same "ordinary user interaction, not an
 * error" contract `solveAdjForGuide` documents, restated because angular
 * clamping needs its own "nearer" (by shortest turn, not by raw subtraction).
 *
 * Args:
 *   adjName (string): the adj guide name to solve for.
 *   lo, hi (number): declared min/max for this guide (60,000ths of a degree).
 *   targetAngle (number): desired heading from `center`, 60,000ths of a degree.
 *   readPoint (adjValue: number) => {x, y}: the handle's LOCAL position with
 *     `adjName` set to `adjValue` (other current adj values held).
 *   center ({x, y}): the point headings are measured from.
 *   held (number): current value of `adjName` (see `solveAdjForGuide`).
 *
 * Returns:
 *   number — the solved adj value, clamped into `[lo, hi]`.
 *
 * @example // pie's start handle: pos = center + r*(cos ang, sin ang), ang IS the adj directly (60,000ths/deg)
 * // readPoint = (a) => ({x: 100 + 100*Math.cos(a*Math.PI/10800000), y: 100 + 100*Math.sin(a*Math.PI/10800000)})
 * // solveAngleForGuide("adj1", 0, 21599999, 0, readPoint, {x:100,y:100}, 0) // 0 (3 o'clock stays 3 o'clock)
 */
// A declared angle range up to a FULL TURN (21599999/21600000, one shy of
// 360deg, is the vendored table's own way of spelling "the whole circle") is
// common (pie/blockArc/chord all declare `minAng="0" maxAng="21599999"`), so a
// naive two-point bracket on `angularDelta(target, heading)` is unreliable in
// TWO ways: (1) the range's own endpoints can have nearly identical headings
// (0deg and ~360deg-epsilon both read as ~0deg) even though the true root is
// in the middle, and (2) `angularDelta`'s ±180deg BRANCH CUT can itself look
// like a sign change between two samples that never crossed the target at
// all — both were hit and measured while building this function (see
// concerns.md-style note: a naive per-sample independent `angularDelta` call
// found a spurious "bracket" exactly at the ±180deg seam and solved pie's
// end-angle handle to 90deg instead of the intended 270deg). The fix is to
// UNWRAP the heading into a continuous running total across samples — each
// step's true turn is `angularDelta(prevHeading, curHeading)` (always the
// SHORT way, and with `ANGLE_SAMPLE_COUNT` steps across at most one full turn,
// each step is well under 180deg so the short way IS the real way) — then
// walk the unwrapped sequence for a crossing of the target's own unwrapped
// equivalent nearest that sequence. This turns "does a periodic function
// cross a value" into an ordinary monotonic bracket search over an unwrapped
// (non-periodic) function, which is what `solveAdjForGuide`-style bisection
// is built for. 32 samples resolves any vendored handle's heading-vs-adj
// curve, which turns at most one full turn total across its whole declared
// range (asserted by the catalog round-trip sweep in
// tests/pptx_preset_handles_test.js).
const ANGLE_SAMPLE_COUNT = 32;

export function solveAngleForGuide(adjName, lo, hi, targetAngle, readPoint, center, held) {
  const loB = lo ?? held, hiB = hi ?? held;
  if (loB === hiB) return held;
  const heading = (v) => {
    const p = readPoint(v);
    return normalizeAngle60000(Math.round((Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI * 60000));
  };
  const lo2 = Math.min(loB, hiB), hi2 = Math.max(loB, hiB);

  // Unwrap: sample evenly, accumulate each step's SHORT turn into a running
  // continuous total. `unwrapped[i]` is the heading at sample i, expressed on
  // the same continuous number line as `unwrapped[0]` (no longer wrapped to
  // [0, 360deg)).
  const samples = [{ v: lo2, h: heading(lo2) }];
  let running = samples[0].h;
  for (let i = 1; i <= ANGLE_SAMPLE_COUNT; i++) {
    const v = lo2 + ((hi2 - lo2) * i) / ANGLE_SAMPLE_COUNT;
    const h = heading(v);
    running += angularDelta(samples[i - 1].h, h);
    samples.push({ v, h, unwrapped: running });
  }
  samples[0].unwrapped = samples[0].h;
  if (samples.every((s) => s.unwrapped === samples[0].unwrapped))
    throw new Error(`preset_handles: angle guide "${adjName}" is FLAT across its declared range [${lo2},${hi2}] (every sample gives the same heading) — its pos does not actually depend on this handle's own gdRefAng, which the ahLst declaration claims it does`);

  // The target's own unwrapped equivalent NEAREST the sampled sequence — picks
  // the correct "which lap" (target, target±360deg, target±720deg, ...) so a
  // range spanning more than one turn still finds the right crossing.
  const seqMid = (samples[0].unwrapped + samples[ANGLE_SAMPLE_COUNT].unwrapped) / 2;
  const targetUnwrapped = targetAngle + DEG60000 * Math.round((seqMid - targetAngle) / DEG60000);

  const f = (s) => s.unwrapped - targetUnwrapped;
  let a, b, fa, fb;
  for (let i = 0; i < ANGLE_SAMPLE_COUNT; i++) {
    if (f(samples[i]) === 0) return samples[i].v;
    if ((f(samples[i]) > 0) !== (f(samples[i + 1]) > 0)) {
      a = samples[i].v; b = samples[i + 1].v; fa = f(samples[i]); fb = f(samples[i + 1]);
      break;
    }
  }
  if (a === undefined) {
    if (f(samples[ANGLE_SAMPLE_COUNT]) === 0) return samples[ANGLE_SAMPLE_COUNT].v;
    // No crossing anywhere: the target lies outside every reachable heading in
    // this range — CLAMP to the sample angularly nearest the target (never
    // throw: an out-of-range drag is ordinary user interaction, see header).
    let best = samples[0];
    for (const s of samples) if (Math.abs(f(s)) < Math.abs(f(best))) best = s;
    return best.v;
  }
  // Bisect the bracketed sub-interval on the now-UNWRAPPED (non-periodic)
  // running total, re-accumulating from `a`'s own unwrapped value so the
  // comparison never crosses a wrap seam within the bisection itself.
  let runningLocal = samples.find((s) => s.v === a).unwrapped;
  let prevHeading = heading(a);
  for (let i = 0; i < BISECTION_MAX_ITERS && b - a > BISECTION_TOLERANCE; i++) {
    const mid = (a + b) / 2;
    const midHeading = heading(mid);
    const midUnwrapped = runningLocal + angularDelta(prevHeading, midHeading);
    const fm = midUnwrapped - targetUnwrapped;
    if (fm === 0) return mid;
    if ((fm > 0) === (fa > 0)) { a = mid; fa = fm; runningLocal = midUnwrapped; prevHeading = midHeading; } else { b = mid; }
  }
  return (a + b) / 2;
}

/**
 * Command in name only — Near-pure function (no I/O; reads nothing but its
 * arguments). Inverts a drag of handle `handleId` (as produced by
 * `handlePositions`, e.g. `"h0"`) on preset shape `name` to a desired LOCAL
 * point, returning the NEW `adj` object (a shallow copy of the input with the
 * handle's controlled guide name(s) updated) clamped to the handle's declared
 * range(s). Throws on an unknown `handleId` — never silently no-ops a drag on
 * a typo'd id.
 *
 * See the module header for which strategy each handle kind uses: `ahXY`
 * solves each present axis (`gdRefX`/`gdRefY`) by bisection, independently
 * when both are present (holds for every dual-axis handle in the vendored
 * table — see header); `ahPolar` solves its angle by angular-distance
 * bisection (`solveAngleForGuide` — APPROXIMATE in the sense the header
 * explains, exact for every vendored shape) and its radius (when `gdRefR` is
 * present) by ordinary bisection with the angle held at its just-solved value.
 *
 * Args:
 *   name (string): preset shape name.
 *   handleId (string): a `handlePositions`-produced id ("h0", "h1", ...).
 *   desiredX, desiredY (number): the LOCAL point the user dragged the handle to
 *     (already box-local; the caller/plugin is responsible for any world
 *     transform and for CONSTRAIN-ing the point into the box if it wants a
 *     hard box clamp before calling this — this function only clamps the
 *     resulting ADJUSTMENT VALUE(S), not the input point).
 *   adj (object): current instance adjustment overrides.
 *   w, h (number): the shape's target box.
 *   defs (object): the compiled preset table (`.shapes`).
 *
 * Returns:
 *   object — a new `adj`, shallow-copied and updated.
 *
 * @example // roundRect, box 200x100, dragging its one handle to local (50, 0):
 * // x1 = ss*adj/100000 with ss=min(200,100)=100, so adj = 100000*50/100 = 50000 (clamped to declared max 50000)
 * // adjFromHandleDrag("roundRect", "h0", 50, 0, {}, 200, 100, DEFS) // {adj: 50000}
 */
export function adjFromHandleDrag(name, handleId, desiredX, desiredY, adj, w, h, defs) {
  const def = defs[name];
  if (!def) throw new Error(`preset_handles: unknown preset shape "${name}"`);
  const handles = parseAhLst(def.ahLst);
  const i = handleId.startsWith("h") ? Number(handleId.slice(1)) : NaN;
  const handle = Number.isInteger(i) ? handles[i] : undefined;
  if (!handle) throw new Error(`preset_handles: unknown handle id "${handleId}" for shape "${name}" (has ${handles.length} handle(s))`);

  const next = { ...adj };
  // Bounds are resolved against the CURRENT (pre-drag) folded guide table —
  // they may name another adj's guide (`maxAdj2`) but never the axis being
  // solved itself in the vendored table, so reading them once up front (not
  // per bisection sample) matches what PowerPoint itself shows on grab.
  const guidesBefore = foldGuides(def.avLst, adj, def.gdLst, w, h);
  const bound = (token) => resolveHandleBound(token, guidesBefore);

  if (handle.kind === "xy") {
    if (handle.gdRefX) {
      const held = adj[handle.gdRefX] ?? def.avLst[handle.gdRefX];
      const readX = (v) => resolveArg(handle.posX, guidesWithAdj(def, next, w, h, handle.gdRefX, v));
      next[handle.gdRefX] = solveAdjForGuide(handle.gdRefX, bound(handle.minX), bound(handle.maxX), desiredX, readX, held);
    }
    if (handle.gdRefY) {
      const held = adj[handle.gdRefY] ?? def.avLst[handle.gdRefY];
      const readY = (v) => resolveArg(handle.posY, guidesWithAdj(def, next, w, h, handle.gdRefY, v));
      next[handle.gdRefY] = solveAdjForGuide(handle.gdRefY, bound(handle.minY), bound(handle.maxY), desiredY, readY, held);
    }
    return next;
  }

  // ahPolar: angle first (bisected on angular distance — see header for why
  // this is NOT a direct atan2 read), THEN radius against the now-updated angle.
  const cx = w / 2, cy = h / 2; // every vendored ahPolar's pos resolves through hc/vc-centered dx/dy (cat2/sat2) — see header
  const targetAngle = normalizeAngle60000(Math.round((Math.atan2(desiredY - cy, desiredX - cx) * 180) / Math.PI * 60000));
  if (handle.gdRefAng) {
    const held = adj[handle.gdRefAng] ?? def.avLst[handle.gdRefAng];
    const readPoint = (v) => {
      const gg = guidesWithAdj(def, next, w, h, handle.gdRefAng, v);
      return { x: resolveArg(handle.posX, gg), y: resolveArg(handle.posY, gg) };
    };
    next[handle.gdRefAng] = solveAngleForGuide(handle.gdRefAng, bound(handle.minAng), bound(handle.maxAng), targetAngle, readPoint, { x: cx, y: cy }, held);
  }
  if (handle.gdRefR) {
    const held = adj[handle.gdRefR] ?? def.avLst[handle.gdRefR];
    // Radius read as DISTANCE FROM CENTER along the (now-fixed) drag direction,
    // in the same units the guide's own x/y formulas produce — bisected exactly
    // like an ahXY axis, holding the just-solved angle constant.
    const dist = Math.hypot(desiredX - cx, desiredY - cy);
    const readR = (v) => {
      const gg = guidesWithAdj(def, next, w, h, handle.gdRefR, v);
      const px = resolveArg(handle.posX, gg), py = resolveArg(handle.posY, gg);
      return Math.hypot(px - cx, py - cy);
    };
    next[handle.gdRefR] = solveAdjForGuide(handle.gdRefR, bound(handle.minR), bound(handle.maxR), dist, readR, held);
  }
  return next;
}
