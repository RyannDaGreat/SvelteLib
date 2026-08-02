/**
 * IMAGE STACK node test — plain node, no framework, no DOM.
 * Run: node src/demo_apps/PowerRP/tests/image_stack_test.js
 *
 * WHAT IT PINS, and why each one:
 *   (1) FIDELITY TO THE REFERENCE. The widget replicates
 *       refs/Figures/image_stack/image_stack.py, so the assertions are written in the
 *       reference's own numbers — ten 256 px cards stepping 20 px across a 436 px
 *       square, and the exact fade ladder its compositing loop produces. Faithfulness
 *       is the requirement, so it is the thing that gets a gate.
 *   (2) THE FADE LADDER IS THE LOOP, CLOSED. stackAlphas is an algebraic rewrite of a
 *       cumulative fade, so it is checked against the loop it replaces, run directly.
 *   (3) THE LAYOUT SOLVES THE CARD FROM THE BOX, in both signs, and degenerates
 *       correctly at one card and at zero shift.
 *   (4) BACK-TO-FRONT ORDER. Frame 0 must be drawn LAST and at full opacity, or the
 *       pile reads inside out.
 *   (5) THE DEGENERATE CASES ARE LOUD, not silent: no source draws nothing (the ghost
 *       symmetry), and a shift that leaves no card draws nothing AND reports.
 *   (6) THE BOUNDS PROTOCOL counts the card shadows, which are ink outside the box.
 */

import assert from "node:assert/strict";
import { imageStackPlugin, stackAlphas, stackLayout, shadowReach, REFERENCE, REFERENCE_SIDE, DEFAULT_SHIFT_FRACTION, rectSubtract, spreadFromHandle, spreadHandlePoint } from "../plugins/image_stack.js";
import { flattenIR, BLUR_SUPPORT_SIGMAS } from "../render_gpu/ir.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 }; // identity; effects-off emit ignores it
const SOURCED = { ...imageStackPlugin.defaults, src: "clip.mp4", videoStart: 0, videoEnd: 5 };

function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
}

/** Query. Every drawable op inside `ops`, in paint order, paired with the ABSOLUTE
 *  world it will be painted at — recursing into cropSubtree content exactly as the
 *  backends do, and exactly as tests/filmstrip_test.js drawablesWithWorld does (each
 *  content list is flattened INDEPENDENTLY from identity, which is why a card's
 *  content must carry its own absolute world). */
function drawables(ops) {
  const out = [];
  const walk = (list) => {
    for (const { cmd, world } of flattenIR(list)) {
      if (cmd.op === "cropSubtree") walk(cmd.content);
      else out.push({ ...cmd, world });
    }
  };
  walk(ops);
  return out;
}

// ── (1) THE REFERENCE'S OWN GEOMETRY ─────────────────────────────────────────

test("a fresh stack has the reference figure's own pile geometry at 1:1", () => {
  // 256 px frames + nine 20 px steps = a 436 px square of INK, which is the widget's
  // default box. (The reference's saved raster is 30 px per side larger — the
  // transparent border it pads each frame with so the shadows have room in a fixed
  // array. A display list needs no such margin; localBounds carries the reach.)
  assert.equal(REFERENCE_SIDE, 436);
  assert.equal(imageStackPlugin.defaults.w, REFERENCE_SIDE);
  assert.equal(imageStackPlugin.defaults.h, REFERENCE_SIDE);
  assert.equal(imageStackPlugin.defaults.frames.length, REFERENCE.frames);
  const cards = stackLayout(REFERENCE.frames, REFERENCE_SIDE, REFERENCE_SIDE, DEFAULT_SHIFT_FRACTION, DEFAULT_SHIFT_FRACTION);
  assert.deepEqual(cards[0], { x: 0, y: 0, w: REFERENCE.frameSize, h: REFERENCE.frameSize });
  const last = cards[cards.length - 1];
  approx(last.x, (REFERENCE.frames - 1) * REFERENCE.totalShift / REFERENCE.frames); // 180
  approx(last.y, 180);
  assert.equal(last.w, REFERENCE.frameSize);
});

// ── (2) THE FADE LADDER IS THE PYTHON LOOP, CLOSED ───────────────────────────

test("stackAlphas equals the reference's own cumulative fade, run as a loop", () => {
  // The reference fades the WHOLE accumulated image by (m/N)^e at step m and then
  // draws the next card over it, back to front. Simulated literally here, so the
  // closed form is compared against the thing it is a rewrite OF — not against a
  // second copy of itself.
  const n = REFERENCE.frames, e = REFERENCE.alphaExponent;
  const loop = new Array(n).fill(0);
  for (let step = 0; step < n; step++) {
    const alpha = Math.pow(step / n, e);
    for (let j = 0; j < n; j++) loop[j] *= alpha;   // fade what is already composited
    loop[n - 1 - step] = 1;                          // then draw this card over it
  }
  const closed = stackAlphas(n, e);
  for (let j = 0; j < n; j++) approx(closed[j], loop[j], 1e-12);
});

test("the fade is monotone, tops out at 1, and the exponent controls the drop-off", () => {
  const a = stackAlphas(10, REFERENCE.alphaExponent);
  assert.equal(a[0], 1, "the front card is always solid");
  for (let j = 1; j < a.length; j++) assert.ok(a[j] < a[j - 1], `card ${j} must be fainter than card ${j - 1}`);
  assert.ok(stackAlphas(10, 1)[9] < stackAlphas(10, 0.25)[9], "a HIGHER exponent hides the pile faster");
  assert.deepEqual(stackAlphas(4, 0), [1, 1, 1, 1], "exponent 0 turns the fade off entirely");
  assert.deepEqual(stackAlphas(1, 0.5), [1], "one card is one solid card");
});

// ── (3) THE LAYOUT ───────────────────────────────────────────────────────────

test("the card size is SOLVED from the box, in both shift signs", () => {
  assert.deepEqual(stackLayout(1, 100, 80, 0.5, 0.5), [{ x: 0, y: 0, w: 100, h: 80 }],
    "one card fills the box whatever the shift is");
  assert.deepEqual(stackLayout(3, 100, 100, 0, 0).map((c) => c.x), [0, 0, 0],
    "zero shift stacks them exactly on top of one another");
  const positive = stackLayout(2, 100, 100, 0.5, 0);
  const negative = stackLayout(2, 100, 100, -0.5, 0);
  assert.deepEqual(positive.map((c) => c.x), [0, 25], "positive recedes right");
  assert.deepEqual(negative.map((c) => c.x), [25, 0], "negative recedes LEFT and still starts inside the box");
  assert.equal(positive[0].w, negative[0].w, "the sign changes the direction, never the card size");
  for (const c of [...positive, ...negative])
    assert.ok(c.x >= 0 && c.x + c.w <= 100 + 1e-9, `card ${JSON.stringify(c)} escapes the box`);
});

// ── (4) BACK-TO-FRONT, AND WHAT EACH CARD DRAWS ──────────────────────────────

test("emit draws BACK TO FRONT: frame 0 is painted last and at full opacity", () => {
  const ops = drawables(imageStackPlugin.emit({ ...SOURCED, frames: [[0], [1], [2]] }, null, WORLD));
  const quads = ops.filter((o) => o.op === "videoV5Frame");
  // ONE DRAW PER VISIBLE REGION, NOT PER CARD — changed by the occlusion fix (#268).
  // A lower card is now clipped to the part of it the card above does not cover, and
  // that region is an L, so it takes TWO clipped draws. Only the top card is a single
  // unclipped draw. The pixel cost goes DOWN (the strips together are smaller than a
  // whole card); it is the op COUNT that rises. The property this test is really
  // about — back to front, frame 0 last, at full opacity — is asserted below on the
  // DISTINCT frames rather than on a raw count.
  const bySeek = [...new Set(quads.map((q) => q.seekTime))];
  assert.deepEqual(bySeek, [2, 1, 0], "deepest card first, frame 0 last");
  assert.equal(quads[quads.length - 1].opacity, 1, "the front card is solid");
  // Opacity rises with depth ACROSS DISTINCT CARDS; the two strips of one card share
  // its alpha, so a strict per-op increase is no longer the right statement.
  const alphaOf = (t) => quads.find((q) => q.seekTime === t).opacity;
  for (let i = 1; i < bySeek.length; i++)
    assert.ok(alphaOf(bySeek[i]) > alphaOf(bySeek[i - 1]), "each card painted later is stronger than the one under it");
  // Every card is a SCRUB frame — the same deterministic op the filmstrip's cells and
  // the V5 scrubber emit, so the pile is pure(document, slide, alpha).
  for (const q of quads) {
    assert.equal(q.ref, "clip.mp4");
    assert.equal(q.wrap, "clamp");
    assert.equal(q.preserveAspect, true, "the reference letterboxes each frame (resize_images_to_hold)");
  }
});

test("each card carries its own blurred drop shadow, under it, fading with the pile", () => {
  const ops = drawables(imageStackPlugin.emit({ ...SOURCED, frames: [[0], [1]] }, null, WORLD));
  const shadows = ops.filter((o) => o.op === "path");
  assert.equal(shadows.length, 2, "one shadow per card (the reference's with_drop_shadows)");
  for (const s of shadows) assert.ok(s.blur > 0, "the reference's shadow_blur is a soft shadow, not a hard offset");
  assert.ok(shadows[0].opacity < shadows[1].opacity, "the deeper card's shadow recedes with its card");
  // A shadow is drawn BEFORE its card, or it would cover the picture it belongs to.
  assert.ok(ops.findIndex((o) => o.op === "path") < ops.findIndex((o) => o.op === "videoV5Frame"));
  // Turning it off removes the ops entirely rather than drawing invisible ones.
  const none = drawables(imageStackPlugin.emit({ ...SOURCED, frames: [[0], [1]], shadowOpacity: 0 }, null, WORLD));
  assert.equal(none.filter((o) => o.op === "path").length, 0);
});

test("a HIDDEN frame leaves the pile — the list's hide-vs-purge, through the shared reader", () => {
  const ops = drawables(imageStackPlugin.emit(
    { ...SOURCED, frames: [[0], [1], [2]], framesActive: [true, false, true] }, null, WORLD));
  // DISTINCT seek times, not raw op count: the lower card is clipped into an L by
  // the occlusion fix (#268) and so draws twice. What this test is about — the
  // hidden frame leaves the pile entirely — is unchanged.
  assert.deepEqual([...new Set(ops.filter((o) => o.op === "videoV5Frame").map((q) => q.seekTime))], [2, 0]);
});

// ── (5) THE DEGENERATE CASES ARE LOUD ────────────────────────────────────────

test("no source → a GHOST that emits NOTHING (the filmstrip symmetry)", () => {
  assert.equal(imageStackPlugin.isGhost({ src: "" }), true);
  assert.equal(imageStackPlugin.isGhost({}), true);
  assert.equal(imageStackPlugin.isGhost({ src: "clip.mp4" }), false);
  assert.deepEqual(imageStackPlugin.emit({ ...imageStackPlugin.defaults }, null, WORLD), []);
});

test("a shift that leaves NO CARD draws nothing and SAYS so", () => {
  const lines = [];
  const realError = console.error;
  console.error = (line) => lines.push(line);
  try {
    // Ten cards stepping a full box-width each: the run is 9/10 of the box per card,
    // which is far past the whole box, so no card has positive width.
    assert.deepEqual(imageStackPlugin.emit({ ...SOURCED, shiftX: 2 }, null, WORLD), []);
  } finally {
    console.error = realError;
  }
  assert.equal(lines.length, 1, "exactly one report, not one per card");
  assert.ok(lines[0].includes("Shift X"), "the notice must name the Inspector row that fixes it");
});

// ── (6) THE BOUNDS PROTOCOL COUNTS THE SHADOWS ───────────────────────────────

test("localBounds inflates by the shadow's reach, because a shadow is INK", () => {
  const noShadow = { w: 100, h: 100, shadowOpacity: 0 };
  assert.deepEqual(imageStackPlugin.localBounds(noShadow), { x: 0, y: 0, w: 100, h: 100 });
  const offsetOnly = { w: 100, h: 100, frames: [[0], [1]], shiftX: 0, shiftY: 0, shadowOpacity: 0.25, shadowShift: 0.1, shadowBlur: 0 };
  assert.deepEqual(imageStackPlugin.localBounds(offsetOnly), { x: -10, y: -10, w: 120, h: 120 });
  // The blur's own support is the SAME 3σ the effects halo uses — the two must agree
  // about where a Gaussian stops, or one of them clips the other's picture.
  assert.equal(shadowReach(100, 0, 0.1), 10 * BLUR_SUPPORT_SIGMAS);
  const dflt = imageStackPlugin.localBounds({ ...imageStackPlugin.defaults });
  assert.ok(dflt.w > imageStackPlugin.defaults.w, "the default shadow really does reach outside the box");
});

console.log(`\n${passed} tests passed`);

// ── OCCLUSION, NOT BLENDING (#268) ──────────────────────────────────────────
// User: "alpha blending is WRONG (you can see one image under another)."
//
// The Python reference fades the ACCUMULATED image and then pastes the next frame
// OPAQUE, so at any pixel only the TOPMOST covering card shows. Drawing every card
// translucent instead BLENDS them, and a lower card bleeds through an upper one.
// stackAlphas' docblock used to assert the two were the same picture; they agree
// about how much a card is DARKENED and disagree about whether it is OCCLUDED.

test("THE BLEED IS REAL AND MEASURABLE — the arithmetic that made this a bug", () => {
  const a = stackAlphas(3, 0.5);
  // A pixel covered by cards 1 and 2 must show card 1 alone.
  const correct = a[1];
  const blended = a[1] + a[2] * (1 - a[1]); // what translucent back-to-front gives
  assert.ok(blended - correct > 0.08,
    `card 2 bled ${(blended - correct).toFixed(4)} into a pixel it must not touch (correct ${correct.toFixed(4)}, blended ${blended.toFixed(4)})`);
});

test("rectSubtract returns DISJOINT pieces — an overlap would re-create the bug in miniature", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const parts = rectSubtract(a, { x: -5, y: -5, w: 10, h: 10 });
  let area = 0;
  for (const p of parts) area += p.w * p.h;
  assert.equal(area, 75, "a diagonal twin leaves exactly the L, counted once");
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      const p = parts[i], q = parts[j];
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      assert.ok(!(ox > 0 && oy > 0), `pieces ${i} and ${j} overlap — the same card would draw over itself`);
    }
});

test("rectSubtract's degenerate cases", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(rectSubtract(a, { x: 50, y: 50, w: 10, h: 10 }), [a], "no overlap → the whole rect");
  assert.deepEqual(rectSubtract(a, a), [], "fully covered → nothing to draw");
  assert.deepEqual(rectSubtract(a, { x: -20, y: -20, w: 100, h: 100 }), [], "swallowed → nothing");
});

test("EVERY LOWER CARD IS CLIPPED, and the TOP one is not", () => {
  const p = imageStackPlugin;
  const st = { ...p.defaults, src: "clip.mp4", w: 400, h: 300, shiftX: 0.2, shiftY: 0.15,
    frames: [[0], [1], [2]], videoStart: 0, videoEnd: 3, shadowOpacity: 0, cardRadius: 0 };
  const ops = p.emit(st, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  const clips = ops.filter((o) => o.op === "cropSubtree");
  // 2 lower cards, each leaving an L of 2 strips = 4. There is NO extra card clip
  // here because cardRadius is 0 — decorateStrokedBox only wraps a card in its own
  // rounded cropSubtree when there is a radius to round. (At the default radius the
  // count is 5; pinning the radius-0 case keeps this assertion about occlusion and
  // nothing else.)
  assert.equal(clips.length, 4, `expected 4 occlusion clips, got ${clips.length}`);
  // The strips are exactly one step wide / tall — the geometry, not a guess.
  const stepX = (0.2 * 400) / 3, stepY = (0.15 * 300) / 3;
  const widths = new Set(clips.map((c) => Math.round(c.w)));
  assert.ok(widths.has(Math.round(stepX)), `an occlusion strip should be one step (${stepX.toFixed(1)}) wide; got ${[...widths].join(", ")}`);
  const heights = new Set(clips.map((c) => Math.round(c.h)));
  assert.ok(heights.has(Math.round(stepY)), `and one step (${stepY.toFixed(1)}) tall; got ${[...heights].join(", ")}`);
});

test("A SINGLE CARD IS NEVER CLIPPED — nothing is above it", () => {
  const p = imageStackPlugin;
  const st = { ...p.defaults, src: "clip.mp4", w: 200, h: 200, shiftX: 0.2, shiftY: 0.2,
    frames: [[0]], videoStart: 0, videoEnd: 1, shadowOpacity: 0, cardRadius: 0 };
  const ops = p.emit(st, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  assert.equal(ops.filter((o) => o.op === "cropSubtree").length, 0,
    "one card means no occlusion clip at all");
});

test("SHIFT 0 — every card coincident — leaves only the top one visible", () => {
  // The pile seen exactly end-on. Each lower card is FULLY covered, so it
  // contributes nothing: the honest answer, and the one the reference gives.
  const p = imageStackPlugin;
  const st = { ...p.defaults, src: "clip.mp4", w: 200, h: 200, shiftX: 0, shiftY: 0,
    frames: [[0], [1], [2]], videoStart: 0, videoEnd: 3, shadowOpacity: 0, cardRadius: 0 };
  const ops = p.emit(st, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  assert.equal(ops.filter((o) => o.op === "cropSubtree").length, 0,
    "no occlusion clips are emitted, because every lower card is fully hidden");
});

// ── THE SPREAD HANDLE (#268) ────────────────────────────────────────────────

test("ONE handle, at the deepest card's corner — the point that IS the spread", () => {
  const st = { ...SOURCED, w: 400, h: 300, shiftX: 0.2, shiftY: 0.15, frames: [[0], [1], [2]] };
  const mp = imageStackPlugin.modifierPoints(st);
  assert.equal(mp.length, 1);
  assert.equal(mp[0].id, "spread");
  const cards = stackLayout(3, 400, 300, 0.2, 0.15);
  assert.equal(mp[0].x, cards[2].x, "it sits on the deepest card");
  assert.equal(mp[0].y, cards[2].y);
  assert.deepEqual(mp[0].stem, { x: cards[0].x, y: cards[0].y }, "tethered to the first card, so the ghost line reads as travel");
});

test("THE HANDLE ROUND-TRIPS — what you grab is what you get", () => {
  // apply() must be the exact inverse of stackLayout's placement, or the pile
  // jumps out from under the cursor on the first pixel of a drag.
  for (const [sx, sy] of [[0.2, 0.15], [0.4, 0], [0, 0.3], [0.05, 0.05]]) {
    const st = { ...SOURCED, w: 400, h: 300, shiftX: sx, shiftY: sy, frames: [[0], [1], [2]] };
    const h = imageStackPlugin.modifierPoints(st)[0];
    const back = h.apply(st, { x: h.x, y: h.y });
    assert.ok(Math.abs(back.shiftX - sx) < 1e-9 && Math.abs(back.shiftY - sy) < 1e-9,
      `(${sx}, ${sy}) round-tripped to (${back.shiftX}, ${back.shiftY})`);
  }
});

test("NO HANDLE when there is nothing to spread — never an inert one", () => {
  const one = { ...SOURCED, w: 400, h: 300, frames: [[0]] };
  assert.deepEqual(imageStackPlugin.modifierPoints(one), [], "a single card has no spread");
  assert.deepEqual(imageStackPlugin.modifierPoints({ ...SOURCED, frames: [] }), [], "and neither has none");
});

test("dragging the handle to the origin flattens the pile rather than dividing by zero", () => {
  const st = { ...SOURCED, w: 400, h: 300, shiftX: 0.2, shiftY: 0.15, frames: [[0], [1], [2]] };
  assert.deepEqual(imageStackPlugin.modifierPoints(st)[0].apply(st, { x: 0, y: 0 }), { shiftX: 0, shiftY: 0 });
  assert.deepEqual(spreadFromHandle({ x: 10, y: 10 }, 3, 0, 0), { shiftX: 0, shiftY: 0 }, "a zero-size box cannot solve a shift");
});

// ── THE PRESETS (#268) ──────────────────────────────────────────────────────

test("presets are whole LOOKS, and none of them is the default wearing a name", () => {
  const ps = imageStackPlugin.presets ?? [];
  assert.ok(ps.length >= 5, `expected a real set, got ${ps.length}`);
  for (const p of ps) {
    assert.ok(p.name && p.description, `${p.name}: a preset needs both a name and a description`);
    const identical = Object.entries(p.props).every(([k, v]) => imageStackPlugin.defaults[k] === v);
    assert.ok(!identical, `"${p.name}" is identical to the defaults — a row that does nothing`);
  }
});

test("every preset is DISTINCT from every other", () => {
  const seen = new Map();
  for (const p of imageStackPlugin.presets ?? []) {
    const key = JSON.stringify(p.props);
    assert.ok(!seen.has(key), `"${p.name}" and "${seen.get(key)}" set the same values`);
    seen.set(key, p.name);
  }
});

test("presets move the THREE things that change how a pile reads, not one knob", () => {
  // A preset that moved a single value would just be a slider with a name.
  for (const p of imageStackPlugin.presets ?? [])
    assert.ok(Object.keys(p.props).length >= 3, `"${p.name}" sets only ${Object.keys(p.props).length} value(s)`);
});

test("every preset writes only keys the widget actually has", () => {
  for (const p of imageStackPlugin.presets ?? [])
    for (const k of Object.keys(p.props))
      assert.ok(k in imageStackPlugin.defaults, `"${p.name}" writes "${k}", which is not a property of this widget`);
});
