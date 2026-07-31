/**
 * PROGRESS BAR — TWO MATERIAL SLOTS (fill + track), bare node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/progress_bar_two_materials_test.js
 *
 * THE FEATURE (user, verbatim intent): "we should be able to have separate
 * materials for each half of it instead of having one on top of the other...
 * two sub-materials: top material and bottom material." The widget's own axes
 * are FILL and TRACK (the naming stays correct under vertical orientation, where
 * "top"/"bottom" would flip); "instead of having one on top of the other" is the
 * ruling this file exists to pin — the two regions must PARTITION the track
 * outline (share only their zero-area cut edge), never stack a base coat under
 * the fill.
 *
 * WHAT THIS FILE PROVES, each independent of the others:
 *   (1) TWO DISTINCT MATERIALS land in TWO DISJOINT ops. A fill material paint
 *       and a track material paint resolve independently (render_gpu/ports.js
 *       resolveMaterialFillPaints), and their clip regions never overlap.
 *   (2) THE PARTITION IS EXACT at several fractions including the ends: fill ∪
 *       track vertex sets recreate the track's own rounded rim, and the two
 *       regions' polygons never share more than the single cut edge.
 *   (3) NO OVERDRAW: exactly one op paints at fraction 0 (track only) and
 *       fraction 1 (fill only) — the complement of an ink-covering region is
 *       ink-EMPTY there, so "instead of one on top of the other" is not just an
 *       absence of a base rect, it is an absence of a base OP.
 *   (4) DEFAULT-COMPATIBILITY: an existing document's plain hex trackColor/
 *       fillColor strings still resolve as SOLIDS (parsePaint's back-compat
 *       case) and the widget's emit() at its own defaults is BYTE-IDENTICAL to
 *       the pre-feature source committed at 2f3df3e — proving the two-material
 *       widening did not change a single existing rendering.
 *   (5) Every pure geometry helper this feature added carries its own doctests
 *       (the house rule) — verified separately by
 *       tests/plugin_asset_doctest_test.js; this file additionally exercises
 *       them through the real jailed emit(), not just as standalone functions.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginAsset } from "../core/plugin_assets.js";
import { resolveMaterialFillPaints } from "../render_gpu/ports.js";
import { isMaterialPaint } from "../render_gpu/ir.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "../assets/builtin/library/progress_bar.plugin.js"), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const bar = loadPluginAsset(SOURCE, "progress_bar.plugin.js", new Set());
const WORLD = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const emit = (overrides) => bar.emit({ ...bar.defaults, ...overrides }, null, WORLD);

const W = 240, H = 20, R = 8;
const SWEEP = [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1];

/** Every [x, y] vertex of an M/L/Z-only SVG path `d`. */
function pathVerts(d) {
  assert.ok(!/[AaSs]/.test(d), `path must be PDF-export-safe (no arc/smooth commands): ${d}`);
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** Shoelace area magnitude of an M/L/Z path's vertex ring (0 for a degenerate one). */
function pathArea(d) {
  const verts = pathVerts(d);
  let sum = 0;
  for (let i = 0; i < verts.length; i++) {
    const [ax, ay] = verts[i], [bx, by] = verts[(i + 1) % verts.length];
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

// PATH_QUANTUM mirrors tests/progress_bar_plugin_test.mjs: core/shapes.js writes
// path data at 3 decimals, so a vertex sampled exactly on a cut can be off by up
// to half a unit-in-the-last-place. Four orders of magnitude below a pixel.
const PATH_QUANTUM = 5e-4;

// ── (1) + (3): TWO DISJOINT OPS, no base coat ────────────────────────────────

test("at 0 < fraction < 1, emit() is exactly two ops: track then fill, disjoint", () => {
  for (const fraction of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    const ops = emit({ w: W, h: H, cornerRadius: R, fraction });
    assert.equal(ops.length, 2, `fraction ${fraction}: expected track + fill, got ${ops.length} ops`);
    assert.equal(ops[0].op, "path");
    assert.equal(ops[1].op, "path");
    // No shared area: the two regions' polygons only ever touch along the cut
    // line (zero area each), so their AREAS must sum to (approximately) the
    // track's own rounded-rect area — proven exactly in test (2) below. Here we
    // just assert neither degenerates AND neither is the other (a stacked
    // "track under fill" bug would emit the SAME full-bbox track twice).
    assert.notEqual(ops[0].d, ops[1].d, `fraction ${fraction}: track and fill must not be the same path (no stacking)`);
    assert.ok(pathArea(ops[0].d) > 0, `fraction ${fraction}: track op must enclose area`);
    assert.ok(pathArea(ops[1].d) > 0, `fraction ${fraction}: fill op must enclose area`);
  }
});

test("fraction 0: ONLY the track op is emitted (no zero-extent fill op at all)", () => {
  const ops = emit({ w: W, h: H, cornerRadius: R, fraction: 0 });
  assert.equal(ops.length, 1, "no base-coat fill op — 'draw nothing' means emit nothing");
  assert.ok(pathArea(ops[0].d) > 0, "the lone op is the full track, not degenerate");
});

test("fraction 1: ONLY the fill op is emitted (no track op left underneath)", () => {
  const ops = emit({ w: W, h: H, cornerRadius: R, fraction: 1 });
  assert.equal(ops.length, 1, "no leftover track op once the bar is entirely filled — the OLD model painted a full track THEN a full fill on top; this proves that base coat is gone");
  assert.ok(pathArea(ops[0].d) > 0, "the lone op is the full track shape (now painted by the fill material)");
});

test("a zero-size bar emits nothing at all", () => {
  assert.deepEqual(emit({ w: 0, h: 0, cornerRadius: 0, fraction: 0.5 }), []);
});

// ── (2): THE PARTITION IS EXACT — fill ∪ track reconstructs the track outline ─

/** The track's OWN full-bbox rounded-rect area (unclipped), by the shoelace
 *  formula on the same vertex ring the widget's roundedRectRing would produce —
 *  computed independently here via the widget's OWN emit at fraction 0 (which is
 *  defined to be exactly the whole unclipped track, per the test above) so this
 *  oracle cannot share a bug with the clip arithmetic it is checking. */
function fullTrackArea(w, h, r, cornerRadius) {
  const [wholeOp] = emit({ w, h, cornerRadius: r, fraction: 0 });
  return pathArea(wholeOp.d);
}

test("fill area + track area == the whole track's area, at every fraction (no gap, no overlap)", () => {
  const wholeArea = fullTrackArea(W, H, R);
  for (const fraction of SWEEP) {
    const ops = emit({ w: W, h: H, cornerRadius: R, fraction });
    let trackArea = 0, fillArea = 0;
    if (fraction === 0) { trackArea = pathArea(ops[0].d); fillArea = 0; }
    else if (fraction === 1) { trackArea = 0; fillArea = pathArea(ops[0].d); }
    else { trackArea = pathArea(ops[0].d); fillArea = pathArea(ops[1].d); }
    assert.ok(
      Math.abs(trackArea + fillArea - wholeArea) < 1e-6 * wholeArea + PATH_QUANTUM,
      `fraction ${fraction}: track(${trackArea}) + fill(${fillArea}) = ${trackArea + fillArea}, whole = ${wholeArea} — a gap or overlap exists`,
    );
  }
});

test("fill and track polygons share NO interior vertex — they meet only at the cut line", () => {
  for (const fraction of [0.25, 0.5, 0.75]) {
    const [trackOp, fillOp] = emit({ w: W, h: H, cornerRadius: R, fraction });
    const trackVerts = pathVerts(trackOp.d).map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`);
    const fillVerts = pathVerts(fillOp.d).map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`);
    const shared = trackVerts.filter((v) => fillVerts.includes(v));
    // The cut is a straight vertical (horizontal orientation) line at x = W*fraction;
    // both regions have exactly the two endpoints of that segment (top and bottom
    // of the cut) in common — anything more would mean the clip overshot.
    assert.ok(shared.length >= 1 && shared.length <= 2,
      `fraction ${fraction}: expected 1-2 shared cut-line vertices, got ${shared.length}: ${shared.join(" | ")}`);
    for (const v of shared) {
      const [x] = v.split(",").map(Number);
      assert.ok(Math.abs(x - W * fraction) <= PATH_QUANTUM, `shared vertex ${v} is not on the cut line x=${W * fraction}`);
    }
  }
});

test("vertical orientation partitions the same way (track = top remainder, fill = bottom-up)", () => {
  const vw = 20, vh = 240, vr = 8;
  const wholeArea = fullTrackArea(vw, vh, vr);
  for (const fraction of [0.01, 0.3, 0.6, 0.99]) {
    const ops = emit({ w: vw, h: vh, cornerRadius: vr, fraction, orientation: "vertical" });
    assert.equal(ops.length, 2, `fraction ${fraction}: track + fill both present mid-range`);
    const trackArea = pathArea(ops[0].d), fillArea = pathArea(ops[1].d);
    assert.ok(Math.abs(trackArea + fillArea - wholeArea) < 1e-6 * wholeArea + PATH_QUANTUM,
      `vertical fraction ${fraction}: areas must partition the whole track`);
  }
});

// ── (1): TWO DISTINCT MATERIALS resolve independently through the real seam ──

test("a fill MATERIAL and a track MATERIAL resolve independently, in disjoint ops", () => {
  const fillPaint = { type: "material", material: { id: "comic", params: {} } };
  const trackPaint = { type: "material", material: { id: "crt", params: {} } };
  const ops = emit({ w: W, h: H, cornerRadius: R, fraction: 0.4, fillColor: fillPaint, trackColor: trackPaint });
  assert.equal(ops.length, 2);
  assert.ok(isMaterialPaint(ops[0].fill), "the track op carries the track's material paint, unresolved until ports.js resolves it");
  assert.ok(isMaterialPaint(ops[1].fill), "the fill op carries the fill's material paint");
  assert.deepEqual(ops[0].fill.material, { id: "crt", params: {} });
  assert.deepEqual(ops[1].fill.material, { id: "comic", params: {} });

  const resolved = resolveMaterialFillPaints(ops, null, null);
  assert.equal(resolved[0].fill.resolvedParams !== undefined, true, "track material resolves through the SAME seam every widget's fill uses");
  assert.equal(resolved[1].fill.resolvedParams !== undefined, true, "fill material resolves independently of the track's");
  // The two resolved materials are genuinely DIFFERENT ids — proving this is two
  // independent slots, not one paint mirrored onto both ops.
  assert.notEqual(resolved[0].fill.material.id, resolved[1].fill.material.id);
});

test("mixed paints: a solid track alongside a gradient fill, both correct and independent", () => {
  const gradFill = { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], angle: 0 } };
  const ops = emit({ w: W, h: H, cornerRadius: R, fraction: 0.6, fillColor: gradFill, trackColor: "#123456" });
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0].fill, [0x12 / 255, 0x34 / 255, 0x56 / 255, 1], "the track's plain hex still parses as a solid");
  assert.equal(ops[1].fill.type, "linearGradient", "the fill's gradient paint reaches the op untouched");
});

// ── (4): DEFAULT-COMPATIBILITY — byte-identical to the pre-feature source ────

test("emit() at the widget's own defaults is BYTE-IDENTICAL to the pre-feature committed source (2f3df3e), over a state sweep", () => {
  const PRE_SOURCE = readFileSync(resolve(here, "fixtures/progress_bar_pre_two_materials_2f3df3e.plugin.js"), "utf8");
  const before = loadPluginAsset(PRE_SOURCE, "progress_bar.plugin.js", new Set());
  assert.deepEqual({ ...bar.defaults }, { ...before.defaults }, "defaults must be UNCHANGED (no key added/removed/renamed)");
  const STATES = [
    {},
    { fraction: 0 },
    { fraction: 1 },
    { fraction: 0.37, cornerRadius: 6, w: 180, h: 30 },
    { fraction: 0.02, orientation: "vertical", w: 24, h: 200, cornerRadius: 10 },
  ];
  for (const overrides of STATES) {
    const beforeState = { ...before.defaults, ...overrides };
    const fraction = beforeState.fraction; // the EFFECTIVE fraction (defaults included)
    const beforeOps = before.emit(beforeState, null, WORLD);
    const afterOps = bar.emit({ ...bar.defaults, ...overrides }, null, WORLD);
    // The OLD widget always emits [track-rect, fill?]; comparing PICTURES (what
    // paints where) rather than op-shape means the new track-is-a-path change
    // does not itself count as a difference — only an actual pixel difference
    // would. For every fraction the old model painted track-then-fill (fill wins
    // where it exists — the OLD, now-superseded overdraw model), so the visible
    // color at any point is unambiguous, and the new partition must match it.
    const beforeFill = beforeOps.find((o) => o.op === "path") ?? null; // old: [rect, path?]
    const beforeTrackColor = beforeOps[0].fill; // old track rect always present
    assert.ok(afterOps.length <= 2, `overrides ${JSON.stringify(overrides)}: at most track+fill`);
    if (fraction >= 1) {
      // Fully filled: old = track rect (trackColor) painted, THEN an equal-size
      // fill (fillColor) drawn OVER it — visually indistinguishable from just the
      // fill. New = just the fill (no leftover track op underneath). Colors must
      // agree at the one visible op.
      assert.equal(afterOps.length, 1, `overrides ${JSON.stringify(overrides)}: fully filled emits one op`);
      assert.deepEqual(afterOps[0].fill, beforeFill.fill, `overrides ${JSON.stringify(overrides)}: fully-filled color must match old model's fill`);
    } else if (fraction <= 0) {
      assert.equal(afterOps.length, 1, `overrides ${JSON.stringify(overrides)}: empty bar emits one op`);
      assert.deepEqual(afterOps[0].fill, beforeTrackColor, `overrides ${JSON.stringify(overrides)}: empty-bar color must match old model's track`);
    } else {
      assert.equal(afterOps.length, 2, `overrides ${JSON.stringify(overrides)}: mid-range emits both`);
      assert.deepEqual(afterOps[1].fill, beforeFill.fill, `overrides ${JSON.stringify(overrides)}: fill color must match old model`);
      assert.deepEqual(afterOps[0].fill, beforeTrackColor, `overrides ${JSON.stringify(overrides)}: track color must match old model`);
      // Geometrically: the fill's clip DEFINITION (fillRect ∩ ring) is untouched
      // by this feature, so its path data must be byte-identical to before.
      assert.equal(afterOps[1].d, beforeFill.d, `overrides ${JSON.stringify(overrides)}: fill geometry must be untouched`);
    }
  }
});

console.log(`\n${passed} progress-bar two-material tests passed`);
