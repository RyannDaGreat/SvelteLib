/**
 * THE UNIVERSAL MORPH PROPERTY + THE ENDPOINT LAW — workstreams MM and II.
 * Run: node src/demo_apps/PowerRP/tests/morph_universal_test.js
 *
 * tests/morph_test.js pins the ENGINE, tests/morph_mode_test.js the per-key
 * wiring it replaces. This suite pins the UNIVERSAL property and the law that
 * makes it stable:
 *
 *   FOLD LAW      — Auto folds a token when the ENDPOINT outlines differ, and
 *                   the exact endpoint values survive at alpha 0 and 1. A pure
 *                   move mints NOTHING, so an ordinary document pays nothing.
 *   ENDPOINTS     — the token carries the two FIXED endpoint bags, never a
 *                   mid-tween one. This is the whole jiggle fix, so it is
 *                   asserted directly and then measured below.
 *   CONTINUITY    — THE II METRIC, and the deliverable's real proof. A gear→square
 *                   morph WITH w/h tweening underneath must move each sampled
 *                   point CONTINUOUSLY: the frame-to-frame travel of a point has
 *                   no discontinuity spike. The old design failed this because
 *                   alignment was re-decided against a moving state, so pairing
 *                   and cyclic start could FLIP between adjacent frames and every
 *                   point jumped to a new counterpart.
 *   MEMO          — the same law from the other side, and mechanically: ONE
 *                   alignment for a whole transition. A hit rate below that means
 *                   an endpoint is leaking a mid-tween value.
 *   CONTENT       — latex→latex morphs under PLAIN AUTO with no per-row mode set,
 *                   which is the case the per-key design structurally could not
 *                   reach (the user's sharpest catch).
 *   CROSSFADE     — both endpoint states drawn, complementary opacity, exact at
 *                   the endpoints.
 *   SURFACING     — the type row's interp affordance is GONE (the universal row
 *                   covers it), and its absence is pinned so it cannot come back.
 */

import assert from "node:assert/strict";
import { blendApplied, applied, morphEndpointsDiffer } from "../core/deltas.js";
import { deriveRenderTree } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { morphIR, crossfadeIR, morphBox } from "../render_gpu/ports.js";
import { pathPoints } from "../core/svg_paths.js";
import { clearMorphCache, alignedPair } from "../core/morph.js";
import {
  MORPH_KEY,
  MORPH_MODES,
  isUniversalMorphToken,
  morphModeForBlend,
  universalMorphToken,
} from "../core/morph_property.js";
import { modesForKey, TYPE_KEY } from "../core/interp_modes.js";

const registry = createRegistry();
registerPlugins(registry);

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    failed++;
  }
}

/** The fold of one item across one transition, at alpha. */
const foldItem = (from, to, alpha) =>
  blendApplied({ items: { a: from } }, { items: { a: to } }, alpha).items.a;

console.log("\nthe universal morph property — MM + II\n");

// ── FOLD LAW ─────────────────────────────────────────────────────────────────

test("AUTO folds a token when the endpoint outlines differ", () => {
  const mid = foldItem({ type: "rect", w: 10, h: 10 }, { type: "circle" }, 0.5);
  assert.ok(isUniversalMorphToken(mid[MORPH_KEY]),
    `a retype must mint the universal token, got ${JSON.stringify(mid[MORPH_KEY])}`);
  assert.equal(mid[MORPH_KEY].mode, "auto", "with nothing stored the mode IS auto");
});

test("a PURE MOVE mints nothing — an ordinary document pays nothing", () => {
  const mid = foldItem({ type: "rect", x: 0, y: 0, w: 10, h: 10 }, { x: 100, w: 40, rotation: 1 }, 0.5);
  assert.ok(!(MORPH_KEY in mid),
    `position/size/rotation ride the node's own box, so they must mint NO token — got ${JSON.stringify(mid[MORPH_KEY])}`);
});

test("the ENDPOINTS are exact — no token at alpha 0 or 1", () => {
  const from = { type: "rect", w: 10, h: 10 }, to = { type: "circle" };
  const end = applied({ items: { a: from } }, { items: { a: to } }).items.a;
  assert.equal(end.type, "circle", "alpha 1 IS the document's own stored value");
  assert.ok(!(MORPH_KEY in end),
    "a folded slide state must never carry a token — it would land in every cache, undo entry and export");
  assert.deepEqual(foldItem(from, to, 0), from, "alpha 0 is the outgoing state untouched");
});

test("SNAP mints nothing — the discrete opt-out costs the render seam nothing", () => {
  const mid = foldItem({ type: "rect", [MORPH_KEY]: "snap", w: 10 }, { type: "circle" }, 0.5);
  assert.ok(!isUniversalMorphToken(mid[MORPH_KEY]), "snap asks for no cross-endpoint work at all");
  assert.equal(mid.type, "circle", "and the type switches at once, exactly as it did before morphing existed");
});

test("the mode STEPS at the transition's start, like every interp value", () => {
  assert.equal(morphModeForBlend(undefined, undefined), "auto", "absent is auto");
  assert.equal(morphModeForBlend("snap", undefined), "snap", "a standing mode carries");
  assert.equal(morphModeForBlend("snap", "crossfade"), "crossfade", "the TARGET wins from frame 1");
  const mid = foldItem({ type: "rect", w: 10 }, { type: "circle", [MORPH_KEY]: "crossfade" }, 0.5);
  assert.equal(mid[MORPH_KEY].mode, "crossfade", "and the fold honours it from the first interior frame");
});

test("morphEndpointsDiffer is a DENYLIST — a new shape leaf defaults to 'might morph'", () => {
  assert.equal(morphEndpointsDiffer({ type: "rect", w: 10 }, { type: "rect", w: 99 }), false, "a resize rides the box");
  assert.equal(morphEndpointsDiffer({ type: "gear", teeth: 8 }, { type: "gear", teeth: 12 }), true, "a plugin parameter");
  assert.equal(morphEndpointsDiffer({ type: "a", whateverIsNext: 1 }, { type: "a", whateverIsNext: 2 }), true,
    "an UNKNOWN leaf must default to morphable — an allowlist would silently fail every widget it had not been taught");
});

// ── THE ENDPOINT LAW ─────────────────────────────────────────────────────────

test("the token carries the two FIXED ENDPOINT BAGS, never a mid-tween one", () => {
  const from = { type: "gear", teeth: 8, w: 100, h: 100 };
  const to = { type: "gear", teeth: 20, w: 300, h: 300 };
  for (const alpha of [0.1, 0.5, 0.9]) {
    const tok = foldItem(from, to, alpha)[MORPH_KEY];
    assert.deepEqual(tok.from, from, `at alpha ${alpha} the FROM endpoint must be the transition's start, not a tween`);
    assert.deepEqual(tok.to, to, `at alpha ${alpha} the TO endpoint must be the transition's end, not a tween`);
    assert.equal(tok.t, alpha, "only `t` moves across the transition");
  }
});

test("the token carries NO GEOMETRY — the fold stays cheap and serializable", () => {
  const tok = foldItem({ type: "rect", w: 10 }, { type: "circle" }, 0.5)[MORPH_KEY];
  const json = JSON.stringify(tok);
  assert.ok(!json.includes("curves") && !json.includes("subpaths"),
    "a path list in a folded state would land in every cached slide state, undo entry and serialized form");
});

// ── THE II CONTINUITY METRIC ─────────────────────────────────────────────────

/**
 * The sampled outline of a mid-morph node, as a flat [x0,y0,x1,y1,…] array.
 * Sampling the DRAWN ops is the honest measurement: it is what the user sees.
 */
function morphSamples(node) {
  return morphIR(node).flatMap((o) => pathPoints(o.d).flatMap((p) => [p.x, p.y]));
}

/**
 * THE METRIC. The largest single-frame travel of any sampled point across a
 * transition, divided by the median such travel — a DISCONTINUITY RATIO.
 *
 * A continuous morph moves every point by roughly the same small amount each
 * frame, so the ratio sits near 1. An alignment FLIP re-labels the points, so one
 * frame shows a travel many times the median — that spike IS the jiggle, and it
 * is what this number catches. Using a ratio rather than an absolute distance
 * makes the test independent of the shape's size and of the frame count.
 */
/**
 * Sampled over the transition's INTERIOR, deliberately. core/morph.js
 * short-circuits both endpoints and returns an ORIGINAL payload there — so the
 * point count legitimately differs at exactly alpha 0 and 1, and including them
 * would measure that documented identity rather than the continuity in question.
 */
function continuityOf(nodeAt, frames = 60) {
  const FIRST = 0.001, LAST = 0.999;
  const at = (i) => FIRST + (LAST - FIRST) * (i / frames);
  const steps = [];
  let recounts = 0;
  let prev = morphSamples(nodeAt(FIRST));
  for (let i = 1; i <= frames; i++) {
    const cur = morphSamples(nodeAt(at(i)));
    // A CHANGE IN POINT COUNT IS THE JIGGLE ITSELF — the outline was re-decided
    // between two adjacent frames, so every sampled point is now a different
    // point and the eye sees the shape snap. Counted rather than averaged in,
    // because a distance between two differently-labelled point sets is
    // meaningless and would quietly dilute the very spike being measured.
    if (cur.length !== prev.length) { recounts++; prev = cur; continue; }
    let travel = 0;
    for (let k = 0; k < cur.length; k += 2)
      travel = Math.max(travel, Math.hypot(cur[k] - prev[k], cur[k + 1] - prev[k + 1]));
    steps.push(travel);
    prev = cur;
  }
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-9;
  return { recounts, ratio: Math.max(...steps) / median };
}

test("II: gear→square WITH w/h tweening travels CONTINUOUSLY (no alignment flip)", () => {
  // THE USER'S BUG, verbatim: gear→square morphs "jiggle and spazz" when SIZE
  // tweens simultaneously. Size tweening is the trigger, so the test tweens it.
  const from = { type: "ss_gear", w: 120, h: 120, teeth: 9, fill: "#888888", strokeWidth: 0 };
  const to = { type: "rect", w: 340, h: 260, fill: "#ff0000", strokeWidth: 0 };
  const gear = registry.get("ss_gear"), rect = registry.get("rect");
  assert.ok(gear?.morphPaths && rect?.morphPaths, "both endpoints must be outline providers for this to test anything");

  const nodeAt = (t) => ({
    type: "rect",
    // The box TWEENS underneath the morph — the whole point of the test.
    state: { type: "rect", w: from.w + (to.w - from.w) * t, h: from.h + (to.h - from.h) * t },
    morph: { fromPlugin: gear, toPlugin: rect, fromState: from, toState: to, t },
  });

  const { recounts, ratio } = continuityOf(nodeAt);
  // THE PRIMARY ASSERTION. A re-decided outline changes the point count, and that
  // is the jiggle in its purest observable form: not a big number, a DIFFERENT
  // SET OF POINTS. Under the old mid-tween derivation this measured 5 across 60
  // frames of exactly this transition; the endpoint law makes it structurally 0.
  assert.equal(recounts, 0,
    `the outline was re-decided ${recounts} time(s) mid-transition — every sampled point jumps to a new ` +
    `counterpart on such a frame, which IS the "jiggle and spazz". The alignment must come from the two ` +
    `FIXED endpoint states, never from the moving mid-tween one.`);
  // And the travel that remains is smooth: no frame moves a point far more than
  // the typical frame does. Measured at 1.26 for this pair.
  assert.ok(ratio < 4,
    `frame-to-frame point travel must have no discontinuity spike; got a max/median ratio of ${ratio.toFixed(2)}`);
});

test("II: the OLD mid-tween derivation really did re-decide the outline (the A/B)", () => {
  // THE CONTROL FOR THE TEST ABOVE, and the reason it is worth having: an
  // assertion that something is 0 proves nothing unless the measurement can
  // produce a non-zero. This reconstructs precisely what the legacy resolvers did
  // — read BOTH endpoint payloads out of the ONE MID-TWEEN bag, which is moving —
  // and shows the same metric catching it.
  const gear = registry.get("ss_gear"), rect = registry.get("rect");
  const lerp = (a, b, t) => a + (b - a) * t;
  const nodeAt = (t) => {
    // the single moving bag both sides used to be read from
    const mid = { type: "ss_gear", w: lerp(120, 340, t), h: lerp(120, 260, t), teeth: lerp(9, 4, t), fill: "#888888", strokeWidth: 0 };
    return {
      type: "rect", state: { type: "rect", w: mid.w, h: mid.h },
      morph: { fromPlugin: gear, toPlugin: rect, fromState: mid,
        toState: { type: "rect", w: mid.w, h: mid.h, fill: "#ff0000", strokeWidth: 0 }, t },
    };
  };
  const { recounts } = continuityOf(nodeAt);
  assert.ok(recounts > 0,
    "the old derivation must still demonstrate the defect — if this is 0 the metric has stopped measuring " +
    "anything and the test above is vacuous");
});

test("II: the alignment is computed ONCE for a whole transition (memo hit rate)", () => {
  // The same law from the other side, and mechanically checkable. Because both
  // endpoint payloads are FIXED, their content key is identical on every frame, so
  // core/morph.js's content-keyed memo holds exactly ONE entry for the transition.
  const from = { type: "ss_gear", w: 120, h: 120, teeth: 9, fill: "#888888", strokeWidth: 0 };
  const to = { type: "rect", w: 340, h: 260, fill: "#ff0000", strokeWidth: 0 };
  const gear = registry.get("ss_gear"), rect = registry.get("rect");

  let aligned = 0;
  clearMorphCache();
  const fromPayload = gear.morphPaths(from), toPayload = rect.morphPaths(to);
  // Count DISTINCT alignments by asking the memo directly: a repeat call on the
  // same content returns the very same object (documented identity), so a new
  // object means a new alignment was run.
  let last = null;
  const FRAMES = 60;
  for (let i = 1; i < FRAMES; i++) {
    const pair = alignedPair(fromPayload, toPayload);
    if (pair !== last) { aligned++; last = pair; }
  }
  assert.equal(aligned, 1,
    `${FRAMES - 1} frames of one transition must share ONE alignment, got ${aligned}. ` +
    `More than one means an endpoint payload is changing — i.e. a mid-tween value leaked into it.`);
});

// ── CONTENT UNDER PLAIN AUTO ─────────────────────────────────────────────────

test("latex→latex morphs under PLAIN AUTO with NO per-row mode set", () => {
  // The user's sharpest catch: editing an equation does not change `type`, so the
  // type row's morph mode could never reach it however it was set. Under the
  // universal property it needs no setting at all.
  const mid = foldItem({ type: "latex", latex: "x^2", w: 100, h: 60 }, { latex: "y^3" }, 0.5);
  const tok = mid[MORPH_KEY];
  assert.ok(isUniversalMorphToken(tok), "an equation EDIT must mint the universal token with nothing configured");
  assert.equal(tok.mode, "auto");
  assert.equal(tok.from.latex, "x^2", "the outgoing source");
  assert.equal(tok.to.latex, "y^3", "the incoming source");
  assert.equal(mid.latex, "y^3", "and the leaf itself resolves to the target — no token on a content key");
});

test("derive turns the token into a `.morph` mark and a clean state", () => {
  const mid = blendApplied(
    { items: { a: { type: "rect", w: 100, h: 80, fill: "#123456", strokeWidth: 0 } }, vars: {} },
    { items: { a: { type: "circle" } } }, 0.5);
  const [node] = deriveRenderTree(mid, registry);
  assert.ok(node.morph, "the node must carry the pair mark");
  assert.deepEqual(node.morph.fromState.type, "rect");
  assert.deepEqual(node.morph.toState.type, "circle");
  assert.equal(node.state[MORPH_KEY], "auto",
    "the state's own morph leaf must be a plain string — a token must never reach a plugin, row or equation");
});

// ── CROSSFADE ────────────────────────────────────────────────────────────────

test("CROSSFADE draws BOTH endpoint states at complementary opacity", () => {
  const rect = registry.get("rect");
  const node = {
    type: "rect", state: { type: "rect", w: 100, h: 60 }, world: null,
    morph: {
      fromPlugin: rect, toPlugin: rect,
      fromState: { type: "rect", w: 100, h: 60, fill: "#ff0000", strokeWidth: 0 },
      toState: { type: "rect", w: 100, h: 60, fill: "#0000ff", strokeWidth: 0 },
      t: 0.25, crossfade: true,
    },
  };
  const ops = crossfadeIR(node);
  assert.ok(ops.length >= 2, "both sides must draw");
  assert.ok(Math.abs(ops[0].opacity - 0.75) < 1e-9, `the outgoing side fades OUT: expected 0.75, got ${ops[0].opacity}`);
  assert.ok(Math.abs(ops.at(-1).opacity - 0.25) < 1e-9, `the incoming side fades IN: expected 0.25, got ${ops.at(-1).opacity}`);
});

test("CROSSFADE is exact at the endpoints", () => {
  const rect = registry.get("rect");
  const mark = (t) => ({
    type: "rect", state: { type: "rect", w: 100, h: 60 }, world: null,
    morph: {
      fromPlugin: rect, toPlugin: rect,
      fromState: { type: "rect", w: 100, h: 60, fill: "#ff0000", strokeWidth: 0 },
      toState: { type: "rect", w: 100, h: 60, fill: "#0000ff", strokeWidth: 0 },
      t, crossfade: true,
    },
  });
  assert.equal(crossfadeIR(mark(0))[0].opacity, 1, "at t=0 the outgoing widget is at full strength");
  assert.equal(crossfadeIR(mark(1)).at(-1).opacity, 1, "at t=1 the incoming widget is at full strength");
});

test("AUTO falls to CROSSFADE for a pair that cannot outline", () => {
  // A video has no outline to flow into, so `auto` must cross-render rather than
  // blink — and it does so SILENTLY, because choosing sensibly is what auto is.
  const mid = blendApplied(
    { items: { a: { type: "rect", w: 100, h: 80, fill: "#123456", strokeWidth: 0 } }, vars: {} },
    { items: { a: { type: "video" } } }, 0.5);
  const [node] = deriveRenderTree(mid, registry);
  assert.ok(node.morph?.crossfade,
    "a pair with no second outline must CROSSFADE under auto — two pictures still dissolve, even when they cannot flow");
});

// ── THE MID-MORPH FRAME ──────────────────────────────────────────────────────

test("morphBox: a bbox node is untouched, a boxless one gets the tweened ink rect", () => {
  assert.deepEqual(morphBox({ state: { w: 100, h: 60 } }, { space: { w: 1, h: 1 } }, { space: { w: 1, h: 1 } }, 0.5),
    { w: 100, h: 60, ox: 0, oy: 0 }, "a bbox widget's own tweened box, and no offset");
  assert.deepEqual(
    morphBox({ state: {} }, { space: { w: 200, h: 10 }, origin: { x: 20, y: 5 } },
      { space: { w: 100, h: 50 }, origin: { x: 0, y: 25 } }, 0.5),
    { w: 150, h: 30, ox: 10, oy: 15 }, "a boxless one: both the extent AND the origin tween");
});

// ── SURFACING ────────────────────────────────────────────────────────────────

test("the TYPE row's interp affordance is GONE — the universal row covers it", () => {
  // User ruling: "Maybe that widget type doesn't have an interpolation option, so
  // when I mouse over it, I don't get that. And it would just be under a universal
  // option." Pinned as an ABSENCE so it cannot quietly come back.
  const ids = modesForKey(TYPE_KEY, "rect");
  assert.ok(!ids.includes("morph"),
    `the type row must no longer offer Morph — it is a universal property now. Got ${JSON.stringify(ids)}`);
});

test("the universal property offers exactly the four ruled options", () => {
  assert.deepEqual(MORPH_MODES, ["auto", "morph", "crossfade", "snap"]);
});

test("universalMorphToken mints nothing for an inert mode", () => {
  assert.equal(universalMorphToken("snap", { type: "a" }, { type: "b" }, 0.5), "snap");
  assert.ok(isUniversalMorphToken(universalMorphToken("auto", { type: "a" }, { type: "b" }, 0.5)));
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}\n`);
process.exit(failed ? 1 : 0);
