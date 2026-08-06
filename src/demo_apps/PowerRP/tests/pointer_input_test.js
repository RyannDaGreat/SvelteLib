/**
 * THE AMBIENT POINTER (manifest R7-24) — `mouse_x` / `mouse_y` / `mouse_left` as
 * RECORDABLE state. Bare node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/pointer_input_test.js
 *
 * WHAT IS PINNED HERE, and why each one is a LAW rather than a behaviour:
 *   - the THREE REGIMES are particleTime()'s, in its precedence: an override beats a
 *     live feed beats the frozen default. A seam of a different shape would need its
 *     own rules in every consumer;
 *   - THE DEFINING TEST OF THE KIND, in PIXELS and through the CLI's real pipeline:
 *     hold the ambient input and the document fixed and the frame is BYTE-IDENTICAL;
 *     move the pointer and it differs. PowerRP CLAUDE.md: "A widget that fails
 *     either half is not recordable — it is EPHEMERAL, and we have none";
 *   - A STILL CONSUMER CANNOT SEE LIVE POINTER MOVEMENT. This is what makes every
 *     thumbnail, CLI still and export reproducible, and it is the half a naive
 *     "just read the mouse" implementation fails;
 *   - THE OVERRIDE DRIVES IT, fed a synthetic sequence — the seam a future recorded
 *     pointer track plugs into, which is the whole reason the design is a seam;
 *   - the FOUR GRAMMAR PASSES agree about the keywords (a round-trip that loses one
 *     corrupts a document silently — RESERVED_KEYWORDS' own docblock), and the
 *     autocomplete offers them (a keyword nobody can find does not exist);
 *   - the evaluation MEMO gets a pointer axis: a still pointer never invalidates, a
 *     moved one always does, and a document with no pointer keyword is untouched.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { newDocument, withNewItem, foldState, serialize } from "../core/document.js";
import {
  evaluateState, RESERVED_KEYWORDS, displayToStored, storedToDisplay, resolveRef,
  equationTokenSpans, tokenize,
} from "../core/expressions.js";
import { suggestEquation } from "../core/equationSuggest.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { renderDocToPng } from "../cli/render.js";
import {
  POINTER_KEYWORDS, POINTER_REST, pointerInput, pointerSample, samplePointer,
  startPointerFeed, stopPointerFeed, isPointerFeedLive, setPointerInputOverride,
  withPointerFrozen,
} from "../core/pointer_input.js";

const registry = createRegistry();
registerAll(registry, createCommands());

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

/** Pure function. sha256 of bytes, hex — the byte-identity comparator.
 * @example // sha256(new Uint8Array([1])) // "4bf5122f…" (64 hex chars) */
function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Query (reads the plugin registry). A folded one-rect state whose position and
 *  size are bound to the pointer — the shape R7-25's cursor preset stamps.
 *  A FRESH object every call, because the evaluation memo is keyed on identity.
 *
 * @example // pointerBoundState().items.a1.x === "= mouse_x" */
function pointerBoundState() {
  return {
    vars: {},
    items: {
      a1: {
        ...registry.get("rect").defaults, type: "rect", active: true,
        x: "= mouse_x", y: "= mouse_y", w: "= mouse_left ? 200 : 40", h: 40,
      },
    },
  };
}

/** Command (drives the seam). Reads the three keywords off one evaluation at the
 *  ambient pointer's current value. */
function readKeywords() {
  const evaluated = evaluateState(pointerBoundState(), registry).state.items.a1;
  return { x: evaluated.x, y: evaluated.y, w: evaluated.w };
}

// ── (1) THE THREE REGIMES, in particleTime()'s precedence ────────────────────

test("the DEFAULT regime is FROZEN at POINTER_REST — every still consumer inherits it", () => {
  assert.equal(isPointerFeedLive(), false);
  assert.equal(pointerInput(), POINTER_REST); // identity, not just equality — the memo leans on it
  assert.deepEqual(readKeywords(), { x: 0, y: 0, w: 40 });
});

test("startPointerFeed opens the LIVE regime; samplePointer drives it; stop returns to rest", () => {
  startPointerFeed();
  assert.equal(isPointerFeedLive(), true);
  assert.equal(pointerInput(), POINTER_REST, "a feed starts from the authored initial condition, not the last session");
  assert.equal(samplePointer(120, -40, true), true, "a first sample is a move");
  assert.deepEqual(readKeywords(), { x: 120, y: -40, w: 200 });
  assert.equal(samplePointer(120, -40, true), false, "an unchanged sample is not a move");
  assert.equal(samplePointer(120, -40, false), true, "the BUTTON alone is a move");
  assert.deepEqual(readKeywords(), { x: 120, y: -40, w: 40 });
  stopPointerFeed();
  assert.equal(pointerInput(), POINTER_REST);
  assert.deepEqual(readKeywords(), { x: 0, y: 0, w: 40 });
});

test("samplePointer OUTSIDE a feed is inert — a producer never has to ask who is listening", () => {
  assert.equal(isPointerFeedLive(), false);
  assert.equal(samplePointer(999, 999, true), false);
  assert.deepEqual(readKeywords(), { x: 0, y: 0, w: 40 }, "a sample leaked into the frozen regime");
});

test("an OVERRIDE beats BOTH regimes, exactly as setParticleTimeOverride does", () => {
  setPointerInputOverride({ x: -7, y: 3, left: true });
  assert.deepEqual(readKeywords(), { x: -7, y: 3, w: 200 });
  startPointerFeed();
  samplePointer(1000, 1000, false);
  assert.deepEqual(readKeywords(), { x: -7, y: 3, w: 200 }, "the live feed beat the override");
  stopPointerFeed();
  setPointerInputOverride(null);
  assert.deepEqual(readKeywords(), { x: 0, y: 0, w: 40 });
});

test("a non-finite or non-boolean sample is REFUSED loudly, never stored", () => {
  assert.throws(() => pointerSample(NaN, 0, false), /x must be finite/);
  assert.throws(() => pointerSample(0, Infinity, false), /y must be finite/);
  assert.throws(() => pointerSample(0, 0, 1), /left must be a boolean/);
  startPointerFeed();
  assert.throws(() => samplePointer(0 / 0, 0, false), /x must be finite/);
  assert.equal(pointerInput(), POINTER_REST, "a refused sample must not have been half-applied");
  stopPointerFeed();
});

// ── (2) A STILL CONSUMER CANNOT SEE LIVE POINTER MOVEMENT ────────────────────
//
// TWO SEPARATE MECHANISMS, because a still consumer sits in one of two places.
// A process that never opens a feed (cli/render.js, the render-job page) is frozen
// by DEFAULT. The editor is NOT such a process: PresentMode is mounted alongside it,
// so web/gpuService.js's thumbnails and minimap render behind a live presentation —
// and those need the SCOPE. The scope half of this was written after the pixel proof
// at the bottom of this file caught a live sample reaching a still render.

test("a live pointer that has MOVED is invisible outside the feed (the CLI's regime)", () => {
  startPointerFeed();
  samplePointer(640, 360, true);
  const live = readKeywords();
  assert.deepEqual(live, { x: 640, y: 360, w: 200 }, "the live regime did not see its own sample");
  stopPointerFeed(); // ← a process with no feed
  assert.deepEqual(readKeywords(), { x: 0, y: 0, w: 40 });
  assert.notDeepEqual(readKeywords(), live);
});

test("withPointerFrozen hides a LIVE pointer from a still consumer in the SAME process", () => {
  startPointerFeed();
  samplePointer(640, 360, true);
  assert.deepEqual(readKeywords(), { x: 640, y: 360, w: 200 });
  assert.deepEqual(withPointerFrozen(readKeywords), { x: 0, y: 0, w: 40 });
  assert.equal(withPointerFrozen(pointerInput), POINTER_REST);
  assert.deepEqual(withPointerFrozen(() => withPointerFrozen(readKeywords)), { x: 0, y: 0, w: 40 }, "the scope must nest");
  assert.deepEqual(readKeywords(), { x: 640, y: 360, w: 200 }, "the scope leaked past its own call");
  // A THROW inside must not leave the process frozen forever.
  assert.throws(() => withPointerFrozen(() => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(readKeywords(), { x: 640, y: 360, w: 200 });
  stopPointerFeed();
});

test("an OVERRIDE still wins inside a freeze — a DICTATED pointer is not the ambient one", () => {
  // web/gpuService.js renders a MOVIE's frames as well as a thumbnail's; freezing an
  // exporter's per-frame override would export a permanently resting pointer.
  setPointerInputOverride({ x: 12, y: 34, left: true });
  assert.deepEqual(withPointerFrozen(readKeywords), { x: 12, y: 34, w: 200 });
  setPointerInputOverride(null);
});

// ── (3) THE OVERRIDE DRIVES IT — a synthetic sequence arrives intact ─────────
//
// The seam a future recorded pointer TRACK plugs into. Nothing about the design
// changes when one arrives: it is one more supplier of exactly this call.

test("a synthetic per-frame sequence arrives at the equations, frame by frame", () => {
  const track = [
    { x: 0, y: 0, left: false },
    { x: 100, y: 50, left: false },
    { x: 100, y: 50, left: true },
    { x: -25.5, y: 12.25, left: true },
  ];
  const seen = track.map((sample) => {
    setPointerInputOverride(sample);
    return readKeywords();
  });
  setPointerInputOverride(null);
  assert.deepEqual(seen, [
    { x: 0, y: 0, w: 40 },
    { x: 100, y: 50, w: 40 },
    { x: 100, y: 50, w: 200 },
    { x: -25.5, y: 12.25, w: 200 },
  ]);
});

// ── (4) THE FOUR GRAMMAR PASSES AGREE ────────────────────────────────────────

test("the keywords are in RESERVED_KEYWORDS, folded in from POINTER_KEYWORDS (one list)", () => {
  for (const name of Object.keys(POINTER_KEYWORDS))
    assert.ok(RESERVED_KEYWORDS.has(name), `${name} is not a reserved keyword`);
  assert.deepEqual(Object.keys(POINTER_KEYWORDS), ["mouse_x", "mouse_y", "mouse_left"]);
});

test("PASS 1 — the parser reads each one as a KEYWORD, never as a variable", () => {
  const slugs = { toId: new Map(), toSlug: new Map() };
  for (const name of Object.keys(POINTER_KEYWORDS))
    assert.deepEqual(resolveRef(name, slugs), { kind: "keyword", name });
  // …and a following "(" makes it a call NAME, the same rule `time` follows.
  assert.equal(tokenize("mouse_x(1)")[1].value, "(");
});

test("PASS 2 — display↔stored is the IDENTITY (the seam has no id to rewrite)", () => {
  for (const name of Object.keys(POINTER_KEYWORDS)) {
    const src = `${name} + 1`;
    assert.equal(displayToStored(src, { items: {} }), src);
    assert.equal(storedToDisplay(src, { items: {} }), src);
    // The round trip a save/load performs, both directions, with no loss.
    assert.equal(storedToDisplay(displayToStored(src, { items: {} }), { items: {} }), src);
  }
});

test("PASS 3 — mapRefTokens sees GRAMMAR: a rename cannot rewrite a keyword", () => {
  // withVariableRenamed goes through mapRefTokens; a keyword must survive a rename
  // that shares its spelling prefix, and a variable named after one must not be
  // rewritten INTO the equation (the keyword shadows it — see scopeGet).
  const src = "mouse_x + speed";
  assert.equal(displayToStored(src, { items: {}, vars: { speed: 1 } }), src);
});

test("PASS 4 — the highlighter paints each as a keyword, never an unknown-ref error", () => {
  for (const name of Object.keys(POINTER_KEYWORDS)) {
    const spans = equationTokenSpans(`${name} + 1`, { items: {} });
    assert.equal(spans[0].cls, "self", `${name} painted as ${spans[0].cls}`);
  }
});

test("the AUTOCOMPLETE offers them — derived from RESERVED_KEYWORDS, not a fifth list", () => {
  const names = suggestEquation("mou", 3, { items: {} }, registry, null).map((c) => c.text);
  assert.deepEqual(names, ["mouse_x", "mouse_y", "mouse_left"]);
});

test("a keyword is UNSHADOWABLE — a document variable of the same name loses", () => {
  const state = pointerBoundState();
  state.vars = { mouse_x: 1234 };
  setPointerInputOverride({ x: 55, y: 0, left: false });
  const x = evaluateState(state, registry).state.items.a1.x;
  setPointerInputOverride(null);
  assert.equal(x, 55);
});

// ── (5) THE EVALUATION MEMO's pointer axis ───────────────────────────────────

test("`pointer` is null unless an equation read it (a pointer-free deck caches as before)", () => {
  const plain = { vars: {}, items: { a1: { ...registry.get("rect").defaults, type: "rect", active: true, x: 5 } } };
  assert.equal(evaluateState(plain, registry).pointer, null);
  assert.notEqual(evaluateState(pointerBoundState(), registry).pointer, null);
  // …and the pointer-free result is served from cache even while the pointer moves.
  const first = evaluateState(plain, registry);
  startPointerFeed();
  samplePointer(11, 22, true);
  assert.equal(evaluateState(plain, registry), first, "a pointer-free document lost its unconditional cache hit");
  stopPointerFeed();
});

test("a STILL pointer never invalidates; a MOVED one always does (same state object)", () => {
  startPointerFeed();
  samplePointer(10, 10, false);
  const state = pointerBoundState(); // ONE object — the memo is keyed on identity
  const a = evaluateState(state, registry);
  assert.equal(samplePointer(10, 10, false), false);
  assert.equal(evaluateState(state, registry), a, "a stationary pointer re-evaluated (the identity contract broke)");
  samplePointer(10, 11, false);
  const b = evaluateState(state, registry);
  assert.notEqual(b, a, "a moved pointer served a stale evaluation");
  assert.equal(b.state.items.a1.y, 11);
  stopPointerFeed();
});

// ── (6) THE DEFINING TEST OF THE KIND, IN PIXELS ─────────────────────────────
//
// Through the CLI's real pipeline (repairedDocument → evaluate → camera frame →
// Skia), which is the renderer whose output an export must be able to reproduce.

const RENDER = { slide: 0, alpha: 1, width: 240, height: 240 };

/** Query (renders). PNG bytes for `docJson` with the ambient pointer dictated.
 * @example // await pngAt(json, {x: 0, y: 0, left: false}) — the resting frame */
async function pngAt(docJson, sample) {
  setPointerInputOverride(sample);
  try { return await renderDocToPng(docJson, RENDER); }
  finally { setPointerInputOverride(null); }
}

await atest("PIXELS: Δpointer = 0 ⟹ BYTE-IDENTICAL; a moved pointer ⟹ a different frame", async () => {
  const meta = newDocument().meta;
  const [doc] = withNewItem(newDocument(), 0, {
    ...registry.get("rect").defaults, active: true,
    x: "= mouse_x", y: "= mouse_y", w: meta.slideW / 4, h: meta.slideH / 4, fill: "#ff0000",
  });
  const json = serialize(doc);
  const rest = { x: 0, y: 0, left: false };
  const moved = { x: meta.slideW / 2, y: meta.slideH / 2, left: false };
  const a = sha256(await pngAt(json, rest));
  const b = sha256(await pngAt(json, moved));
  const aAgain = sha256(await pngAt(json, rest));
  assert.notEqual(a, b, "the widget rendered IDENTICAL pixels at two pointer positions — it is not bound to the pointer");
  assert.equal(a, aAgain, "the same pointer rendered different pixels — the render is not deterministic");
});

await atest("PIXELS: a producer's samples cannot reach a still consumer that never opted in", async () => {
  // THE CLI's REAL SITUATION, and the render-job page's: a process with no feed.
  // Non-vacuous because the SAME coordinates, delivered through the seam's override,
  // demonstrably move the picture — so the equality below is a closed regime and not
  // an inert binding. (The in-process case, where a still consumer sits beside a LIVE
  // feed, is the withPointerFrozen test in §2: that scope is SYNCHRONOUS, and
  // renderDocToPng is not, which is why the scope is proven at the evaluation it
  // actually wraps in web/gpuService.js rather than around an await here.)
  const meta = newDocument().meta;
  const [doc] = withNewItem(newDocument(), 0, {
    ...registry.get("rect").defaults, active: true,
    x: "= mouse_x", y: "= mouse_y", w: meta.slideW / 4, h: meta.slideH / 4, fill: "#00ff00",
  });
  const json = serialize(doc);
  const far = { x: meta.slideW / 2, y: meta.slideH / 2, left: true };
  const atRest = sha256(await renderDocToPng(json, RENDER));
  assert.equal(isPointerFeedLive(), false);
  samplePointer(far.x, far.y, far.left); // inert: nobody opted in
  assert.equal(sha256(await renderDocToPng(json, RENDER)), atRest, "a sample leaked into a still render");
  assert.notEqual(sha256(await pngAt(json, far)), atRest, "that position had no effect at all — the check above proved nothing");
});

// Never leak a regime into a sibling suite (the run_all processes share nothing,
// but this file's own later imports and any future appended test do).
setPointerInputOverride(null);
stopPointerFeed();

if (failures) {
  console.log(`\n${failures} pointer-input test(s) FAILED`);
  process.exit(1);
}
console.log("\nall pointer-input tests passed");
