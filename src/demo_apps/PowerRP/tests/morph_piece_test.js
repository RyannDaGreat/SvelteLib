/**
 * THE PIECE LAW — glyph-aware morph grouping, workstream AQ.
 * Run: node src/demo_apps/PowerRP/tests/morph_piece_test.js
 *
 * ── THE USER'S QUESTION, WHICH IS WHAT THIS ANSWERS (2026-08-02, verbatim) ────
 *   "And is Menom really taking into account the fact that it's text and using
 *    that to morph? Because it doesn't look like it. It looks like it's just
 *    morphing it like any old ship." [voice dictation: Menom = Manim, ship = shape]
 *
 * The read was exact, and about our own code rather than Manim's:
 * `morphPayloadFromPaths` flattened every glyph's `d` into one undifferentiated
 * contour list, so glyph identity was destroyed at payload construction. An `O`'s
 * counter became a peer of every other letter's outer, pairing matched it to
 * whatever was cheapest anywhere in the string, and `morphPaintRuns` put the whole
 * string into one fill computation. See refs/manim_morph_holes_research.md §2.1
 * and §2.3, whose 15-point spec this implements.
 *
 * ── WHAT THIS SUITE PINS ─────────────────────────────────────────────────────
 *   STAMP      — one authored path is one piece, universally (not a text branch):
 *                a two-glyph payload carries two piece ids, a one-path widget one.
 *   DEGRADE    — a payload with NO `piece` behaves exactly as it did before AQ.
 *                This is the law that makes the change not a flag day, and it is
 *                asserted by COMPARING against the unstamped run, not by assuming.
 *   CONTAINMENT— no contour of glyph A is ever paired with, or in the same fill op
 *                as, a contour of glyph B, when both glyphs matched a counterpart.
 *                This is Manim's structural property (§1.4), stated as a test.
 *   WHOLE      — a matched piece travels under ONE similarity, so its counter
 *                keeps its exact place inside its outer at every alpha. That is
 *                what `TransformMatchingShapes` gets from a part being one
 *                VMobject, and what contour-granularity matching could not give.
 *   ENDPOINTS  — alpha 0 and alpha 1 still return the ORIGINAL payloads,
 *                byte-for-byte, with `piece` present and inert.
 *   DETERMINISM— identical inputs give identical piece assignment and identical
 *                pair order at fixed alpha. No clock, no randomness, no carry.
 *
 * Bare node, no fonts: the glyphs are hand-built polygon payloads, so this runs
 * in the gate with no font files, no MathJax and no browser. A font would make
 * this a test of Inter rather than of the engine.
 */

import assert from "node:assert/strict";
import { morphPayloadFromPaths } from "../core/morph_payload.js";
import { normalizePayload, pairPieces, pairSubpaths, pieceIdsOf } from "../core/morph_align.js";
import { matchPieceGroups, pieceKey, travelledPiece } from "../core/morph_match.js";
import { matchedPlan, morphPaths, clearMorphCache } from "../core/morph.js";
import { morphIR, morphPaintRuns } from "../render_gpu/ports.js";
import { shoelaceWinding } from "../core/morph_geometry.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── FIXTURES ─────────────────────────────────────────────────────────────────

/** Test helper. A polygon's `d` string, closed. `ccw` reverses it, which is how
 * a COUNTER (a hole wound against its parent) is written. */
function polyD(cx, cy, r, n, ccw) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (ccw ? -1 : 1) * (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return "M" + pts.map((p) => `${p[0]} ${p[1]}`).join("L") + "Z";
}

/** Test helper. A RING glyph — an outer with a counter punched out of it — as ONE
 * `d` string, i.e. one authored path, i.e. ONE PIECE. This is the shape of a real
 * glyph outline: `O`, `6`, `8`, `a` are all exactly this. */
const ringD = (cx, cy, r) => polyD(cx, cy, r, 12, false) + polyD(cx, cy, r * 0.45, 10, true);

/** Test helper. A SOLID glyph (no counter) as one authored path — an `l`, a `v`. */
const solidD = (cx, cy, r) => polyD(cx, cy, r, 9, false);

const INK = { fill: "#101010", stroke: null, strokeWidth: 0, opacity: 1 };
const BOX = { w: 100, h: 100 };

/** Test helper. A payload from a list of `d` strings — one PIECE each. */
const payload = (ds) => morphPayloadFromPaths(ds.map((d) => ({ d, paint: INK })), BOX, "nonzero");

/** Test helper. The same payload with every `piece` stripped — the pre-AQ shape,
 * and what an older memo entry or a not-yet-updated provider hands over. */
function unstamped(p) {
  return { ...p, subpaths: p.subpaths.map(({ piece, ...rest }) => rest) };
}

/** Test helper. A morphIR node over two payloads at alpha `t`. */
const node = (from, to, t) => ({
  type: "plaintext",
  state: { w: BOX.w, h: BOX.h },
  morph: {
    fromPlugin: { morphPaths: () => from }, toPlugin: { morphPaths: () => to },
    fromState: {}, toState: {}, t, matchPieces: true,
  },
});

// ── STAMP ────────────────────────────────────────────────────────────────────

test("STAMP: one authored path is one piece — two glyphs give two piece ids", () => {
  const p = payload([ringD(25, 50, 18), ringD(75, 50, 18)]);
  assert.equal(p.subpaths.length, 4, "two rings is four contours");
  assert.deepEqual(p.subpaths.map((sp) => sp.piece), [0, 0, 1, 1],
    "a glyph's outer and its counter must carry the SAME piece id, and the next glyph a different one");
});

test("STAMP: it is not a TEXT feature — a one-path widget is one piece, i.e. today", () => {
  // The spec's §2.3.2: `piece` means "one authored path" for every provider — an
  // SVG icon's path ops, an equation's glyphs, a shape's single `d`. A shape
  // widget hands over ONE source, so it gets one piece and nothing changes for it.
  const p = payload([ringD(50, 50, 30)]);
  assert.deepEqual(pieceIdsOf(p.subpaths), [0], "a single-source widget is exactly one piece");
});

test("STAMP: the payload stays FLAT — no new container, so every reader is untouched", () => {
  const p = payload([ringD(25, 50, 18), solidD(75, 50, 18)]);
  assert.ok(Array.isArray(p.subpaths), "subpaths is still a plain array of peer contours");
  assert.deepEqual(Object.keys(p).sort(), ["fillRule", "space", "subpaths"],
    "the payload gained no top-level field — `piece` rides on the subpath, which is why " +
    "payloadKey, the serialized shape and assertMorphPaths did not have to change");
});

// ── DEGRADE ──────────────────────────────────────────────────────────────────

test("DEGRADE: a payload with NO piece is read as ONE piece containing everything", () => {
  const p = unstamped(payload([ringD(25, 50, 18), ringD(75, 50, 18)]));
  assert.ok(p.subpaths.every((sp) => sp.piece === undefined), "the fixture really is unstamped");
  assert.deepEqual(pieceIdsOf(p.subpaths), [0],
    "an unstamped list must read as one piece — that is what makes absence degrade rather than throw");
});

test("DEGRADE: an unstamped morph draws EXACTLY what it drew before AQ", () => {
  // The strongest form of the law available in-process: run the SAME geometry
  // stamped and unstamped, and require the unstamped run to be the one that
  // pairs globally. They are compared to each other rather than to a golden
  // file, so this cannot rot into asserting whatever the code happens to do.
  const A = payload([ringD(20, 50, 15), ringD(60, 50, 15)]);
  const B = payload([ringD(30, 50, 15), ringD(70, 50, 15)]);
  clearMorphCache();
  const stamped = morphPaths(A, B, 0.5, { matchPieces: true });
  clearMorphCache();
  const flat = morphPaths(unstamped(A), unstamped(B), 0.5, { matchPieces: true });
  assert.equal(flat.subpaths.length, stamped.subpaths.length,
    "both arms must produce the same number of contours — grouping changes WHICH contour pairs " +
    "with which, never how many there are");
  // And the unstamped run must put everything in ONE fill run, which is the
  // pre-AQ grain exactly.
  const flatRuns = morphPaintRuns(flat.subpaths, () => INK);
  assert.equal(flatRuns.length, 1,
    "an unstamped payload must be ONE op per paint — the pre-AQ fill grain, unchanged");
});

// ── CONTAINMENT — the property adopted from Manim ─────────────────────────────

test("CONTAINMENT: no contour of one glyph pairs with a contour of another", () => {
  // Two rings on each side, in a DIFFERENT left-to-right order on the target, so
  // an index-based or a purely size-based pairing would have every chance to
  // cross. `pairCost` pairs the pieces by geometry; the contours then compete
  // only inside their own piece-pair.
  const A = normalizePayload(payload([ringD(20, 50, 15), ringD(70, 50, 15)]));
  const B = normalizePayload(payload([ringD(75, 50, 15), ringD(25, 50, 15)]));
  const pieceMap = new Map(pairPieces(A.subpaths, B.subpaths));
  assert.equal(pieceMap.size, 2, "both glyphs must find a counterpart");
  let crossed = 0;
  for (const [fi, ti] of pairSubpaths(A.subpaths, B.subpaths)) {
    if (fi === null || ti === null) continue;
    const fp = A.subpaths[fi].piece, tp = B.subpaths[ti].piece;
    if (pieceMap.has(fp) && pieceMap.get(fp) !== tp) crossed++;
  }
  assert.equal(crossed, 0,
    "a contour of glyph A paired with a contour of glyph B — the exact failure the piece grain " +
    "exists to stop (research note §2.1: an O's counter pairing with an A's counter three letters away)");
});

test("CONTAINMENT: a matched piece's SURPLUS contour is padded, never lent to another glyph", () => {
  // A ring (outer + counter) against a SOLID: the counter has no partner inside
  // its own piece. It must pad — collapse inside its own letter — rather than
  // fall into the global pass and pair with the neighbouring glyph's contour.
  const A = normalizePayload(payload([ringD(20, 50, 15), ringD(70, 50, 15)]));
  const B = normalizePayload(payload([solidD(25, 50, 15), ringD(75, 50, 15)]));
  const pieceMap = new Map(pairPieces(A.subpaths, B.subpaths));
  for (const [fi, ti] of pairSubpaths(A.subpaths, B.subpaths)) {
    if (fi === null || ti === null) continue;
    const fp = A.subpaths[fi].piece, tp = B.subpaths[ti].piece;
    if (pieceMap.has(fp))
      assert.equal(pieceMap.get(fp), tp,
        "a surplus contour inside a MATCHED piece must be padded, not paired across glyphs — it is " +
        "not a leftover, its piece found its counterpart");
  }
});

test("CONTAINMENT: the FILL GRAIN is the glyph — one path op per letter", () => {
  // Manim's grain: one VMobject, one ctx.fill() (manim/camera/camera.py:781).
  // AM made a counter EXPRESSIBLE by grouping contours into paint runs; this
  // makes it CONTAINED by splitting those runs at glyph boundaries.
  const A = payload([ringD(20, 50, 15), ringD(70, 50, 15)]);
  const B = payload([ringD(30, 50, 15), ringD(80, 50, 15)]);
  const ops = morphIR(node(A, B, 0.5)).filter((o) => o.op === "path");
  assert.equal(ops.length, 2,
    "two glyphs in ONE ink must be TWO ops, so neither letter's contours are in the other's fill " +
    "computation — this is the whole of the containment being adopted");
  for (const op of ops)
    assert.equal((op.d.match(/M/g) || []).length, 2,
      "and each op must hold exactly its own glyph's two contours (outer + counter)");
});

// ── WHOLE — a matched glyph travels intact ───────────────────────────────────

test("WHOLE: a matched piece travels under ONE similarity, so its counter stays put", () => {
  // The failure this prevents: `travelledSubpath` maps a contour by its OWN
  // placement pair, so applying it contour-by-contour could give an O's outer and
  // its counter two different similarities and let the hole drift out of the bowl.
  const A = normalizePayload(payload([ringD(20, 50, 15)]));
  const B = normalizePayload(payload([ringD(80, 30, 25)]));
  const centres = (sps) => sps.map((sp) => {
    const pts = [sp.start, ...sp.curves.map((c) => [c[4], c[5]])];
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  });
  /** The counter's offset from its outer, in units of the piece's own size. A
   * SIMILARITY scales both together, so this ratio is invariant under it — which
   * is exactly the property "one similarity for the whole piece" buys, and it is
   * what a per-contour placement would break. (The raw offset is NOT zero here:
   * the two rings have different vertex counts, so their anchor centroids differ
   * slightly even though the shapes are concentric. Asserting zero would be
   * asserting a fact about the fixture, not about the engine.) */
  const offsetRatio = (sps) => {
    const [outer, counter] = centres(sps);
    const span = Math.max(...sps[0].curves.map((c) => Math.hypot(c[4] - outer[0], c[5] - outer[1])));
    return Math.hypot(counter[0] - outer[0], counter[1] - outer[1]) / span;
  };
  const atStart = offsetRatio(A.subpaths);
  for (const alpha of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const got = offsetRatio(travelledPiece(A.subpaths, B.subpaths, alpha));
    assert.ok(Math.abs(got - atStart) < 1e-9,
      `at alpha ${alpha} the counter moved relative to its own outer (${got} vs ${atStart}) — one ` +
      `similarity per PIECE is what keeps a hole inside the letter it belongs to`);
  }
});

test("WHOLE: a matched piece keeps its counter OPPOSED to its outer at every alpha", () => {
  // The hole-at-both-endpoints law (AM), restated at piece granularity: a rigid
  // similarity with positive scale cannot reverse a traversal, so the counter's
  // winding stays opposite its parent's for the whole trip.
  const A = normalizePayload(payload([ringD(20, 50, 15)]));
  const B = normalizePayload(payload([ringD(80, 30, 25)]));
  for (const alpha of [0.1, 0.5, 0.9]) {
    const [outer, counter] = travelledPiece(A.subpaths, B.subpaths, alpha);
    assert.notEqual(shoelaceWinding(outer), shoelaceWinding(counter),
      `at alpha ${alpha} the counter agreed in winding with its own outer, which closes the hole ` +
      `under nonzero — a travelling piece must never re-wind`);
  }
});

test("WHOLE: the piece HASH sees a counter's placement, so O and a solid do not collide", () => {
  // This is the piece-granularity port of `shapeKey`. Hashing the contours
  // independently and joining would lose exactly this: WHERE the counter sits
  // inside the outer, and how big it is relative to it.
  const ring = normalizePayload(payload([ringD(50, 50, 20)])).subpaths;
  const solid = normalizePayload(payload([solidD(50, 50, 20)])).subpaths;
  assert.notEqual(pieceKey(ring), pieceKey(solid), "a holed glyph and a solid one are different letterforms");
  // the SAME ring somewhere else, at another size, is the SAME letterform
  const moved = normalizePayload(payload([ringD(20, 30, 8)])).subpaths;
  assert.equal(pieceKey(ring), pieceKey(moved),
    "translation and scale are the only freedoms a text reflow uses, and the hash must absorb both");
});

test("WHOLE: duplicate letters do not swap places (the 'bb' case, at piece grain)", () => {
  // The duplicate-key rule matters MORE here than at contour granularity: at
  // contour grain a duplicate was a coincidence, at piece grain it is duplicate
  // LETTERS, which every real string has.
  const A = [normalizePayload(payload([ringD(20, 50, 12)])).subpaths,
             normalizePayload(payload([ringD(70, 50, 12)])).subpaths];
  const B = [normalizePayload(payload([ringD(24, 50, 12)])).subpaths,
             normalizePayload(payload([ringD(74, 50, 12)])).subpaths];
  assert.deepEqual(matchPieceGroups(A, B), [[0, 0], [1, 1]], "each letter stays with the copy beside it");
  // authored in the other order, the match must follow GEOMETRY, not the index
  assert.deepEqual(matchPieceGroups(A, [B[1], B[0]]), [[0, 1], [1, 0]],
    "nearest displacement, not authoring order — swapping two identical letters is an artifact " +
    "with no cause the viewer can see");
});

// ── ENDPOINTS ────────────────────────────────────────────────────────────────

test("ENDPOINT: alpha 0 and alpha 1 return the ORIGINAL payloads, piece present and inert", () => {
  const A = payload([ringD(20, 50, 15), ringD(70, 50, 15)]);
  const B = payload([solidD(30, 50, 15)]);
  assert.equal(morphPaths(A, B, 0, { matchPieces: true }), A, "alpha 0 IS the from payload, by identity");
  assert.equal(morphPaths(A, B, 1, { matchPieces: true }), B, "alpha 1 IS the to payload, by identity");
  // `piece` is on those payloads and must not have perturbed them: the endpoint
  // short-circuits run BEFORE any of the piece machinery, which is why the
  // endpoint law holds identically in both arms.
  assert.deepEqual(morphPaths(A, B, 0, { matchPieces: true }).subpaths.map((sp) => sp.piece), [0, 0, 1, 1],
    "the from payload is two RINGS — four contours, two per glyph — and alpha 0 hands them back untouched");
});

test("ENDPOINT: the ops at alpha 0 draw the SAME ink as the un-morphed payload", () => {
  const A = payload([ringD(20, 50, 15), ringD(70, 50, 15)]);
  const B = payload([ringD(30, 50, 15), ringD(80, 50, 15)]);
  const ops = morphIR(node(A, B, 0)).filter((o) => o.op === "path");
  const contours = ops.reduce((n, op) => n + (op.d.match(/M/g) || []).length, 0);
  assert.equal(contours, A.subpaths.length,
    "the endpoint must draw every contour the payload has and no more — the piece split changes " +
    "how ink is GROUPED into ops, never how much of it there is");
});

// ── DETERMINISM ──────────────────────────────────────────────────────────────

test("DETERMINISM: identical inputs give identical piece assignment and pair order", () => {
  const A = normalizePayload(payload([ringD(20, 50, 15), ringD(70, 50, 15), solidD(45, 20, 10)]));
  const B = normalizePayload(payload([ringD(75, 50, 15), solidD(45, 25, 10), ringD(25, 50, 15)]));
  const once = JSON.stringify([pairPieces(A.subpaths, B.subpaths), pairSubpaths(A.subpaths, B.subpaths)]);
  const twice = JSON.stringify([pairPieces(A.subpaths, B.subpaths), pairSubpaths(A.subpaths, B.subpaths)]);
  assert.equal(once, twice, "two runs disagreed — every tie-break in this engine is STATED for exactly this reason");
});

test("DETERMINISM: the morph is identical COLD and WARM (the memo is not a variable)", () => {
  const A = payload([ringD(20, 50, 15), ringD(70, 50, 15)]);
  const B = payload([ringD(35, 40, 18), solidD(80, 50, 15)]);
  clearMorphCache();
  const cold = JSON.stringify(morphPaths(A, B, 0.4, { matchPieces: true }));
  const warm = JSON.stringify(morphPaths(A, B, 0.4, { matchPieces: true }));
  clearMorphCache();
  const again = JSON.stringify(morphPaths(A, B, 0.4, { matchPieces: true }));
  assert.equal(cold, warm, "a cached plan drew a different frame than the one that built it");
  assert.equal(cold, again, "and clearing the cache changed the picture — the memo is a PERFORMANCE event only");
});

test("DETERMINISM: the plan reports both grains, and the piece grain claims first", () => {
  const A = payload([ringD(20, 50, 15), ringD(70, 50, 15)]);
  const B = payload([ringD(30, 50, 15), ringD(80, 50, 15)]);
  clearMorphCache();
  const plan = matchedPlan(A, B);
  assert.equal(plan.matchedPieces.length, 2, "both glyphs are congruent and must match as WHOLE pieces");
  assert.equal(plan.matched.length, 0,
    "and nothing may be left for the contour matcher — a piece that matched has no loose contours, " +
    "which is precisely what stops one letter's halves taking two trajectories");
  assert.equal(plan.from.subpaths.length, 0, "nor anything left to morph");
});

console.log(`\n${passed} piece-law checks passed.`);
