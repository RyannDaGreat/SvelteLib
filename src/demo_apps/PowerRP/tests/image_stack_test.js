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
import {
  imageStackPlugin, stackAlphas, stackLayout, shadowReach,
  REFERENCE, REFERENCE_SIDE, DEFAULT_SHIFT_FRACTION,
} from "../plugins/image_stack.js";
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
  assert.equal(quads.length, 3, "one videoV5Frame op per visible frame");
  assert.deepEqual(quads.map((q) => q.seekTime), [2, 1, 0], "deepest card first, frame 0 last");
  assert.equal(quads[quads.length - 1].opacity, 1, "the front card is solid");
  for (let i = 1; i < quads.length; i++)
    assert.ok(quads[i].opacity > quads[i - 1].opacity, "each card painted later is stronger than the one under it");
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
  assert.deepEqual(ops.filter((o) => o.op === "videoV5Frame").map((q) => q.seekTime), [2, 0]);
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
