/**
 * PROGRESS BAR PLUGIN ASSET — bare-node tests.
 *
 * WHAT THIS GUARDS. The user reported that at LOW progress the fill "looks a
 * little bit weird": it rendered as a detached rounded PILL that ignored the
 * track's geometry — its own four corners fully rounded regardless of width, and
 * its square left corners painting OUTSIDE the track's rounded cap. The fix
 * restates the fill as a definition rather than a second box: the INTERSECTION of
 * the progress rect with the track's rounded-rect.
 *
 * That definition is what makes the widget testable without a renderer, because
 * every property the report asked for is a statement about a POLYGON:
 *
 *   - CONTAINMENT. The fill is a subset of the track, so no vertex may lie
 *     outside the track's rounded rim. This is the "paints outside the corner"
 *     half of the bug, and it is the one that cannot be caught by eye at a glance
 *     — a two-pixel spill at 1% reads as antialiasing until you zoom in.
 *   - HUGGING THE LEFT CAP. The fill's leftmost vertex must sit ON the track's
 *     left cap at EVERY fraction, which is exactly what a floating pill does not
 *     do. Asserted as "min x is 0 at a square corner / on the arc when rounded",
 *     never as "the fill is near the left".
 *   - NO INK AT ZERO. fraction 0 must emit NO fill op at all. The histogram's
 *     empty-bin lesson: a zero-extent filled path is not invisible — it still
 *     antialiases along its own edge — so "draw nothing" has to mean "emit
 *     nothing", and a test that only checked `w === 0` would have passed the bug.
 *
 * The sweep runs 0, 0.01, 0.05, 0.5, 0.99, 1 because the interesting transitions
 * are all at the ends: below the corner radius the cut crosses the ARCS (two
 * partial arcs joined by a straight edge), above it the cut crosses the straight
 * edges, and at 1 the fill must be the whole track.
 *
 * THE HANDLE is tested through the same protocol the app drives it with
 * (core/derive.js modifierWrite = constrain-then-apply), not by reaching into its
 * internals — including at fraction 0 and 1, where the handle must still be
 * grabbable even though the fill has no ink.
 *
 * Bare node, no DOM, no GPU: the widget is property state throughout (CLAUDE.md's
 * three kinds of state), which is what lets it be tested this way.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginAsset } from "../core/plugin_assets.js";
import { modifierWrite, UNCONSTRAINED } from "../core/derive.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "../assets/builtin/library/progress_bar.plugin.js"), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The loaded plugin, through the real jail — the same path a project load takes. */
const bar = loadPluginAsset(SOURCE, "progress_bar.plugin.js", new Set());
/** An identity world transform: applyEffects needs one, and with every effect off
 *  it passes the ops through untouched. */
const WORLD = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Query (calls the jailed emit). State overrides → the display list.
 *  Injects DISTINCTIVE paints (pure red fill, pure green track) so the two
 *  clipped path ops can be told apart from their parsed RGBA without
 *  reimplementing the color parser; geometry is color-independent, so every
 *  geometric claim in this file is unaffected. */
const emit = (overrides) => bar.emit({ ...bar.defaults, fillColor: "#ff0000", trackColor: "#00ff00", ...overrides }, null, WORLD);

/** The fractions swept. The ends are where the geometry changes kind. */
const SWEEP = [0, 0.01, 0.05, 0.5, 0.99, 1];
/** A track shaped like the reported screenshot: wide, short, heavily rounded so
 *  the corner arcs are a large share of the width (r = h/2 → a pill). */
const W = 240, H = 20, R = 10;

/**
 * Pure function. Every [x, y] vertex of an SVG path `d` built from M/L/Z only
 * (which is all this widget emits — arcs are pre-sampled upstream, so a path
 * containing an `A` would be a PDF-export regression and is asserted against).
 *
 * @param {string} d SVG path data
 * @returns {number[][]} the vertices
 */
function pathVerts(d) {
  assert.ok(!/[AaSs]/.test(d), `path must be PDF-export-safe (no arc/smooth commands): ${d}`);
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/**
 * Pure function. The SIGNED distance from a point to the boundary of a w×h
 * rounded rect (top-left origin, radius r): negative strictly inside, 0 on the
 * rim, positive outside. This is the containment oracle — it is written
 * INDEPENDENTLY of the plugin's own clipper (nearest-point-on-the-arc-center-box
 * plus radius, the standard rounded-rect SDF) so that a bug in the clipper cannot
 * hide behind the same mistake in the test.
 *
 * @param {number} px point x
 * @param {number} py point y
 * @param {number} w rect width
 * @param {number} h rect height
 * @param {number} r corner radius
 * @returns {number} signed distance to the rim
 */
function roundedRectSDF(px, py, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  // Distance to the centered box inset by `rad`, minus `rad` (the standard
  // rounded-box SDF), expressed about the rect's center.
  const qx = Math.abs(px - w / 2) - (w / 2 - rad);
  const qy = Math.abs(py - h / 2) - (h / 2 - rad);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - rad;
}

// Since the two-material split (ff561e8) BOTH regions are clipped `path` ops —
// "the path op" no longer names the fill, and no `rect` op exists at all. The
// ops are told apart by the distinctive paints `emit` injects above (parsed to
// RGBA by the op constructor: red → [1,0,0,1], green → [0,1,0,1]).
/** Pure function. The fill-region op of a display list, or null when none was emitted. */
const fillOp = (ops) => ops.find((o) => o.op === "path" && o.fill?.[0] === 1) ?? null;
/** Pure function. The track-region op — null when the bar is fully filled. */
const trackOp = (ops) => ops.find((o) => o.op === "path" && o.fill?.[1] === 1) ?? null;

// TWO tolerances, and they are different KINDS of thing — collapsing them into
// one fudge factor is how a containment test stops meaning anything.
//
// EPS is float noise on the clip arithmetic: interpolating a cut point is a
// couple of multiplies, so the answer is right to nearly the last bit.
const EPS = 1e-9;
// PATH_QUANTUM is the SERIALIZATION grid. core/shapes.js `num` writes path data
// at 3 decimals (deliberately — it keeps `d` short and doctests stable), so a
// vertex sampled exactly ON the rim can be written up to half a unit-in-the-last-
// place off it, in either direction. Every shape in the codebase carries this,
// the track's own rim included; it is ~1/2000 of a local unit, four orders of
// magnitude below a pixel at any sane zoom. Containment is therefore asserted
// against the rim PLUS this grid: tight enough that the reported bug (a fill
// spilling visibly past the corner, a whole radius out) fails by four orders of
// magnitude, loose enough that rounding alone cannot manufacture a failure.
const PATH_QUANTUM = 5e-4;

// ── the track is the UNFILLED REMAINDER, not a base coat ─────────────────────
// REWRITTEN for the two-material split (ff561e8). This test used to pin the
// track as an always-present full-bbox rect the fill painted OVER; the user
// ruling "separate materials for each half... instead of having one on top of
// the other" made the track a clipped region BESIDE the fill — a translucent
// fill must not double-darken over a base coat. Partition exactness (no gap,
// no overlap) is progress_bar_two_materials_test.js's job; this file keeps the
// claims that survive the model change: the track exists exactly while some
// bar is unfilled, and its ink never leaves the rounded rim.
test("track is the unfilled remainder: present below fraction 1, absent at 1, rim-contained", () => {
  for (const fraction of SWEEP) {
    const t = trackOp(emit({ w: W, h: H, cornerRadius: R, fraction }));
    if (fraction === 1) {
      assert.equal(t, null, "fraction 1: a full bar has no track ink left");
      continue;
    }
    assert.ok(t, `fraction ${fraction}: an unfilled bar must draw its track`);
    for (const [x, y] of pathVerts(t.d)) {
      assert.ok(
        roundedRectSDF(x, y, W, H, R) <= PATH_QUANTUM,
        `fraction ${fraction}: track vertex (${x}, ${y}) lies outside the rounded rim`,
      );
    }
  }
});

// ── THE BUG, HALF ONE: no ink at all when there is no progress ───────────────
test("fraction 0 emits NO fill op (a zero-extent path still inks)", () => {
  assert.equal(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction: 0 })), null);
  assert.equal(fillOp(emit({ w: W, h: H, cornerRadius: 0, fraction: 0 })), null);
  assert.equal(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction: -3 })), null, "a clamped-to-0 binding is still 0");
  assert.equal(fillOp(emit({ w: 0, h: 0, cornerRadius: 0, fraction: 0.5 })), null, "a zero-size bar has no interior to fill");
});

test("every non-zero fraction DOES emit a fill", () => {
  for (const fraction of SWEEP.filter((f) => f > 0))
    assert.ok(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction })), `fraction ${fraction} must draw something`);
});

// ── THE BUG, HALF TWO: the fill may never leave the track ────────────────────
test("fill stays inside the track's rounded rim at every fraction", () => {
  for (const fraction of SWEEP.filter((f) => f > 0)) {
    const verts = pathVerts(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction })).d);
    for (const [x, y] of verts) {
      assert.ok(
        roundedRectSDF(x, y, W, H, R) <= PATH_QUANTUM,
        `fraction ${fraction}: vertex (${x}, ${y}) is OUTSIDE the track's rounded rim — this is the "paints past the corner" bug`,
      );
      assert.ok(x >= -PATH_QUANTUM && x <= W + PATH_QUANTUM && y >= -PATH_QUANTUM && y <= H + PATH_QUANTUM,
        `fraction ${fraction}: vertex (${x}, ${y}) escapes the bbox entirely`);
    }
  }
});

test("fill never extends past the progress cut on the long axis", () => {
  for (const fraction of SWEEP.filter((f) => f > 0)) {
    const verts = pathVerts(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction })).d);
    const maxX = Math.max(...verts.map(([x]) => x));
    assert.ok(maxX <= W * fraction + PATH_QUANTUM, `fraction ${fraction}: fill reaches x=${maxX}, past the cut at ${W * fraction}`);
  }
});

// ── THE BUG, HALF THREE: it must HUG the left cap, not float ─────────────────
test("fill hugs the track's left cap at every fraction (no floating pill)", () => {
  for (const fraction of SWEEP.filter((f) => f > 0)) {
    const verts = pathVerts(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction })).d);
    const minX = Math.min(...verts.map(([x]) => x));
    // The leftmost fill vertex is ON the track's left cap: x = 0 for a square
    // track; for a rounded one, at least one vertex lies on the rim (SDF 0).
    assert.ok(minX <= PATH_QUANTUM, `fraction ${fraction}: fill starts at x=${minX}, detached from the left cap`);
    const onRim = verts.filter(([x, y]) => Math.abs(roundedRectSDF(x, y, W, H, R)) <= PATH_QUANTUM);
    assert.ok(onRim.length >= 2, `fraction ${fraction}: fill shares only ${onRim.length} vertices with the track's rim — it is not seated in the groove`);
  }
});

test("a narrow fill spans LESS cross-axis height than a wide one (it follows the cap's curve)", () => {
  // The signature of the correct figure: inside the corner radius the fill is a
  // sliver bounded by the ARCS, so it is SHORTER than the track. The old
  // pill-shaped fill was full height right down to a hair's width, which is what
  // made it read as a detached blob.
  const span = (fraction) => {
    const ys = pathVerts(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction })).d).map(([, y]) => y);
    return Math.max(...ys) - Math.min(...ys);
  };
  const thin = span(0.01), wide = span(0.5);
  assert.ok(thin < wide, `a 1% fill spans ${thin}, a 50% fill ${wide} — the thin one must be pinched by the cap's arc`);
  assert.ok(Math.abs(wide - H) <= PATH_QUANTUM, `past the corner radius the fill must be full height, got ${wide}`);
});

test("fraction 1 fills the whole track (fill rim === track rim)", () => {
  const verts = pathVerts(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction: 1 })).d);
  const xs = verts.map(([x]) => x), ys = verts.map(([, y]) => y);
  assert.ok(Math.abs(Math.min(...xs)) <= PATH_QUANTUM && Math.abs(Math.max(...xs) - W) <= PATH_QUANTUM, "full bar must span the track's width");
  assert.ok(Math.abs(Math.min(...ys)) <= PATH_QUANTUM && Math.abs(Math.max(...ys) - H) <= PATH_QUANTUM, "full bar must span the track's height");
  for (const [x, y] of verts)
    assert.ok(Math.abs(roundedRectSDF(x, y, W, H, R)) <= PATH_QUANTUM, `full bar vertex (${x}, ${y}) must lie ON the track's rim`);
});

test("an UNROUNDED bar is still the plain rectangle it always was", () => {
  const verts = pathVerts(fillOp(emit({ w: W, h: H, cornerRadius: 0, fraction: 0.5 })).d);
  assert.deepEqual(verts, [[0, 0], [120, 0], [120, 20], [0, 20]]);
});

// ── vertical bars fill bottom-up, with the same containment law ──────────────
test("vertical bars hug the BOTTOM cap and stay inside the rim", () => {
  const vw = 20, vh = 240, vr = 10;
  for (const fraction of SWEEP.filter((f) => f > 0)) {
    const verts = pathVerts(fillOp(emit({ w: vw, h: vh, cornerRadius: vr, fraction, orientation: "vertical" })).d);
    const maxY = Math.max(...verts.map(([, y]) => y));
    const minY = Math.min(...verts.map(([, y]) => y));
    assert.ok(maxY >= vh - PATH_QUANTUM, `fraction ${fraction}: vertical fill must reach the bottom cap, got maxY=${maxY}`);
    assert.ok(minY >= vh * (1 - fraction) - PATH_QUANTUM, `fraction ${fraction}: vertical fill rises past its cut`);
    for (const [x, y] of verts)
      assert.ok(roundedRectSDF(x, y, vw, vh, vr) <= PATH_QUANTUM, `vertical fraction ${fraction}: vertex (${x}, ${y}) escapes the rim`);
  }
});

// ── THE HANDLE ───────────────────────────────────────────────────────────────
test("one modifier point, on the fill's leading edge, at every fraction", () => {
  for (const fraction of SWEEP) {
    const mps = bar.modifierPoints({ ...bar.defaults, w: W, h: H, fraction });
    assert.equal(mps.length, 1, `fraction ${fraction}: expected exactly one handle`);
    assert.equal(mps[0].id, "fraction");
    assert.ok(Number.isFinite(mps[0].x) && Number.isFinite(mps[0].y),
      `fraction ${fraction}: the handle must have a real position — it is grabbable even where the fill has no ink`);
    assert.equal(mps[0].x, W * fraction, `fraction ${fraction}: handle sits on the leading edge`);
    assert.equal(mps[0].y, H / 2, "handle sits at the cross-axis midpoint");
  }
});

test("handle at fraction 0 sits ON the track's left cap (grabbable with no fill ink)", () => {
  const mp = bar.modifierPoints({ ...bar.defaults, w: W, h: H, cornerRadius: R, fraction: 0 })[0];
  assert.deepEqual({ x: mp.x, y: mp.y }, { x: 0, y: H / 2 });
  assert.equal(fillOp(emit({ w: W, h: H, cornerRadius: R, fraction: 0 })), null, "...and there is indeed no fill to grab instead");
});

test("dragging the handle writes `fraction`, clamped to 0..1", () => {
  const state = { ...bar.defaults, w: W, h: H, fraction: 0.5 };
  const mp = { ...bar.modifierPoints(state)[0], constrain: bar.modifierPoints(state)[0].constrain ?? UNCONSTRAINED };
  // modifierWrite is THE composed driver (constrain, then apply) — the same one
  // CanvasView's drag goes through, so this is the real path, not a shortcut.
  assert.deepEqual(modifierWrite(mp, state, { x: 180, y: 10 }), { fraction: 0.75 });
  assert.deepEqual(modifierWrite(mp, state, { x: 0, y: 10 }), { fraction: 0 });
  assert.deepEqual(modifierWrite(mp, state, { x: W, y: 10 }), { fraction: 1 });
  assert.deepEqual(modifierWrite(mp, state, { x: 9999, y: 10 }), { fraction: 1 }, "past the end clamps, never overshoots");
  assert.deepEqual(modifierWrite(mp, state, { x: -9999, y: 10 }), { fraction: 0 }, "before the start clamps too");
  // The cross-axis component is dropped by the CONSTRAINT, so a sloppy drag that
  // wanders off the bar still scrubs cleanly rather than doing nothing.
  assert.deepEqual(modifierWrite(mp, state, { x: 180, y: -500 }), { fraction: 0.75 });
});

test("the handle writes the SAME key the Inspector and equations do", () => {
  // It is a surfacing, not a second store: a drag must be indistinguishable from
  // typing the number, or keyframing/binding `fraction` would silently diverge.
  const state = { ...bar.defaults, w: W, h: H, fraction: 0.2 };
  const written = modifierWrite(bar.modifierPoints(state)[0], state, { x: 60, y: 10 });
  assert.deepEqual(Object.keys(written), ["fraction"]);
  assert.deepEqual(emit({ w: W, h: H, cornerRadius: R, ...written }), emit({ w: W, h: H, cornerRadius: R, fraction: 0.25 }));
});

test("the handle round-trips: drag to a point, and it reappears there", () => {
  const state = { ...bar.defaults, w: W, h: H, fraction: 0 };
  for (const target of [0, 0.01, 0.37, 0.99, 1]) {
    const next = { ...state, ...modifierWrite(bar.modifierPoints(state)[0], state, { x: W * target, y: 3 }) };
    assert.ok(Math.abs(bar.modifierPoints(next)[0].x - W * target) < 1e-9,
      `handle dragged to ${target} must redraw at ${target}`);
  }
});

test("vertical handle runs up the middle and reads bottom-up", () => {
  const state = { ...bar.defaults, w: 20, h: 240, fraction: 0.25, orientation: "vertical" };
  const mp = bar.modifierPoints(state)[0];
  assert.deepEqual({ x: mp.x, y: mp.y }, { x: 10, y: 180 }, "25% up a 240-tall bar is 60 above the bottom");
  assert.deepEqual(modifierWrite(mp, state, { x: 99, y: 60 }), { fraction: 0.75 });
  assert.deepEqual(modifierWrite(mp, state, { x: 10, y: 9999 }), { fraction: 0 }, "below the bottom is empty");
});

console.log(`progress_bar_plugin_test: ${passed} checks passed`);
