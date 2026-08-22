/**
 * THE `paraAndLocal → undefined.charCount` CRASH — bare-node gate.
 * Run: node src/demo_apps/PowerRP/tests/text_layout_disposed_test.js
 *
 * THE BUG, from the user's console (production bundle, 2026-08-21, a node-graph
 * deck; it repeated ~100 times):
 *
 *     Uncaught TypeError: Cannot read properties of undefined (reading 'charCount')
 *         at Sjt.paraAndLocal
 *         at Sjt.wordAt            ← a dblclick handler on a div
 *     Uncaught TypeError: Cannot read properties of undefined (reading 'charCount')
 *         at Sjt.paraAndLocal
 *         at Sjt.caretRect         ← a Svelte effect flush ($derived recompute)
 *
 * THE ROOT CAUSE IS A USE-AFTER-FREE, NOT A BAD OFFSET AND NOT AN EMPTY BOX.
 * `getTextLayout` keeps a bounded LRU of laid-out Paragraph stacks and calls
 * `dispose()` on the victim past CACHE_MAX — which deletes the WASM Paragraphs and
 * sets `built = []`. `paraAndLocal` then walks a zero-length list and falls through
 * to `built[built.length - 1]`, i.e. `built[-1]`, i.e. `undefined.charCount`.
 * `web/TextEditController.svelte` was holding the returned layout in a memoized
 * Svelte `$derived`, which recomputes only when the DOCUMENT changes — while
 * eviction is driven by OTHER text ops the renderer lays out. A node-graph slide
 * lays out far more than CACHE_MAX distinct text ops per frame (each visual_node
 * contributes a label, a body string and one text op per named port bead), so the
 * whole cache turns over between one caret query and the next, and every caret
 * recompute afterwards threw.
 *
 * WHAT THIS PINS
 *   (A) THE INNOCENT STATES, so nobody "fixes" this by clamping something that was
 *       never wrong. An EMPTY text box is a legitimate state and the layout answers
 *       it honestly (one empty line: a caret rect with the line's real height, a
 *       word range of [0,0]); an offset past the end, or negative, clamps.
 *       Section (A) passes both before and after the fix — that is its whole job.
 *   (B) THE BITE. A layout the cache EVICTED refuses every read with a NAMED
 *       sentence naming the ownership contract, instead of `undefined.charCount`.
 *       This section fails against the unfixed text_layout.js.
 *   (C) EVICTION IS REAL AND IS REACHED THROUGH THE PUBLIC DOOR — CACHE_MAX+1
 *       distinct `getTextLayout` calls free an earlier layout — so (B) is the
 *       shipped path and not a hand-called `dispose()`.
 *   (D) THE CALLER. `web/TextEditController.svelte` no longer STORES the layout: it
 *       derives the plain-data cmd and re-enters the cache at each geometry read.
 *       This section fails against the unfixed controller.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { getTextLayout, TextLayout } from "../render_gpu/skia/text_layout.js";
import { splitParagraphs, paragraphRanges } from "../core/richtext.js";
import { committedFaces, FALLBACK_FACES } from "../render_gpu/fonts.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONTS_DIR = path.join(APP_DIR, "fonts");

const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

/** Query (reads the fonts/ directory). The REAL FontCollection node_render builds —
 *  committed families plus the Noto fallback chain — so line metrics below are the
 *  shipped ones and an empty box's caret has its true height rather than 0. */
function realFontCollection() {
  const provider = CanvasKit.TypefaceFontProvider.Make();
  for (const { family, file } of [
    ...committedFaces().map((f) => ({ family: f.cssFamily, file: f.file })),
    ...FALLBACK_FACES.map((f) => ({ family: f.family, file: f.file })),
  ]) {
    const p = path.join(FONTS_DIR, file);
    if (fs.existsSync(p)) provider.registerFont(fs.readFileSync(p), family);
  }
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(provider);
  fc.enableFontFallback();
  return fc;
}
const fc = realFontCollection();

/** Pure function. A legacy single-run text op (what plaintext and visual_node emit,
 *  and what TextEditController's PLAIN mode builds) with `text` as its string. */
function op(text, extra = {}) {
  return { text, size: 36, color: "#000000", bold: false, font: "inter", boxW: 300, boxH: 120,
    boxStyle: { align: "left", valign: "top" }, ...extra };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok — ${name}`);
}

// ── (A) THE INNOCENT STATES — an empty box and an out-of-range offset ──────────
// These were the two obvious suspects and NEITHER is the bug. They are asserted so
// that stays measured rather than remembered.

test("an empty text has ONE empty paragraph, not zero (the model half)", () => {
  assert.deepEqual(splitParagraphs([]), [[]]);
  assert.deepEqual(paragraphRanges([]), [{ start: 0, end: 0 }]);
  assert.deepEqual(splitParagraphs([{ text: "" }]), [[]]);
});

test("an EMPTY box lays out one empty line and answers its caret honestly", () => {
  const l = getTextLayout(CanvasKit, fc, op(""));
  assert.equal(l.built.length, 1, "an empty text is one empty paragraph, never zero");
  // THE INVARIANT, rather than three font metrics: a blank line's caret is exactly
  // where the caret before the FIRST CHARACTER would be, because the blank line is
  // laid out with an injected U+200B carrying the same strut. Measured on Inter@36
  // it is {x:0, top:0.44, h:43.56} for both — but stating it as an equality keeps
  // the assertion true when the committed typeface changes.
  const filled = getTextLayout(CanvasKit, fc, op("x"));
  assert.deepEqual(l.caretRect(0), filled.caretRect(0),
    "an empty box's caret must sit exactly where a first-character caret sits");
  assert.ok(l.caretRect(0).h > 0, "…with the line's real height, not zero");
  assert.deepEqual(l.wordAt(0), { start: 0, end: 0 }, "no word in an empty box, and that is not an error");
  assert.equal(l.offsetAtPoint(50, 50), 0, "every point in an empty box is offset 0");
  assert.deepEqual(l.selectionRects(0, 0), []);
});

test("an offset PAST THE END or NEGATIVE clamps rather than falling off the list", () => {
  const l = getTextLayout(CanvasKit, fc, op("hello world"));
  for (const off of [999, -5, Number.MAX_SAFE_INTEGER]) {
    const c = l.caretRect(off);
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.top), `caretRect(${off}) must answer, got ${JSON.stringify(c)}`);
    const w = l.wordAt(off);
    assert.ok(w.start >= 0 && w.end >= w.start, `wordAt(${off}) must answer, got ${JSON.stringify(w)}`);
  }
});

test("a MULTI-paragraph layout still routes each offset to its own paragraph", () => {
  const l = getTextLayout(CanvasKit, fc, op("one\ntwo\nthree"));
  assert.equal(l.built.length, 3);
  assert.equal(l.paraAndLocal(0).i, 0);
  assert.equal(l.paraAndLocal(3).i, 0, "the caret before a \\n stays in its own paragraph");
  assert.equal(l.paraAndLocal(4).i, 1, "the next paragraph starts AFTER the \\n");
  assert.equal(l.paraAndLocal(99).i, 2, "past the end lands on the last paragraph");
});

// ── (B) THE BITE — a freed layout refuses, by name ─────────────────────────────

/** Pure function. The message of whatever `fn` throws, or null if it returned. */
function threw(fn) {
  try { fn(); return null; } catch (e) { return e.message; }
}

test("a DISPOSED layout refuses every reader with a NAMED sentence", () => {
  const l = getTextLayout(CanvasKit, fc, op("disposed me"));
  l.dispose();
  const readers = {
    "caretRect": () => l.caretRect(0),
    "wordAt": () => l.wordAt(1),
    "paraAndLocal": () => l.paraAndLocal(0),
    "offsetAtPoint": () => l.offsetAtPoint(10, 10),
    "selectionRects": () => l.selectionRects(0, 3),
    "contentWidth": () => l.contentWidth(),
    "contentBottom": () => l.contentBottom,
    "shapedGlyphs": () => l.shapedGlyphs(),
  };
  for (const [name, fn] of Object.entries(readers)) {
    const msg = threw(fn);
    assert.ok(msg, `${name}() on a disposed layout must THROW, it returned instead`);
    // THE EXACT REGRESSION: the shipped stack said only this, from paraAndLocal.
    assert.ok(!/reading 'charCount'/.test(msg),
      `${name}() still fails as the anonymous TypeError this test exists to remove: ${msg}`);
    assert.ok(/text_layout/.test(msg) && /DISPOSED/.test(msg) && /getTextLayout/.test(msg),
      `${name}()'s refusal must name the module, the disposal and the ownership contract — got: ${msg}`);
  }
});

test("live() is the ONE guard, and a LIVE layout is untouched by it", () => {
  assert.equal(typeof TextLayout.prototype.live, "function", "the guard must be a real method, not an inline check");
  const l = getTextLayout(CanvasKit, fc, op("still alive"));
  assert.equal(l.disposed, false);
  assert.equal(l.live(), l, "live() returns the layout so readers can chain it");
  assert.ok(l.caretRect(3).h > 0, "a live layout still answers exactly as before");
});

// ── (C) EVICTION IS THE REAL DOOR — nothing here calls dispose() by hand ───────

test("the LRU frees a HELD layout once enough other layouts are built", () => {
  const held = getTextLayout(CanvasKit, fc, op("held across an eviction"));
  assert.equal(held.built.length, 1);
  assert.equal(held.disposed, false);
  // The count is deliberately well past CACHE_MAX rather than equal to it: this
  // asserts that a busy slide evicts, not what the exact bound is (a slide full of
  // node widgets builds far more than this per frame).
  for (let i = 0; i < 64; i++) getTextLayout(CanvasKit, fc, op(`filler ${i}`));
  assert.equal(held.disposed, true, "getTextLayout's LRU must have freed the held layout");
  assert.equal(held.built.length, 0, "…and disposal is what empties `built` — the only way it can be empty");
  const msg = threw(() => held.caretRect(0));
  assert.ok(/DISPOSED/.test(msg), `the shipped path must reach the named refusal, got: ${msg}`);
});

// ── (D) THE CALLER — the editor must not STORE a cache-owned layout ────────────

/** Pure function. A .svelte source with its PROSE removed — the leading HTML
 *  comment block and every whole-line `//` or jsdoc `*` comment. The assertions
 *  below are about what the file DOES, and the file explains this very bug in
 *  comments that quote the buggy line verbatim; matching those would make the
 *  gate fail on its own documentation.
 *
 *  @example stripComments("<!--h-->\nlet a = 1; // why\n  // dead\n") // "\nlet a = 1; // why\n"
 */
function stripComments(src) {
  return src
    .replace(/^<!--[\s\S]*?-->/, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

test("TextEditController fetches the layout fresh instead of memoizing it", () => {
  const src = stripComments(fs.readFileSync(path.join(APP_DIR, "web", "TextEditController.svelte"), "utf8"));
  assert.ok(/function textLayout\(\)\s*\{[^}]*getTextLayout\(/.test(src),
    "the ONE getTextLayout call must live in a plain function, re-entered per read");
  assert.ok(!/\blet\s+layout\s*=\s*\$derived/.test(src),
    "`let layout = $derived(…getTextLayout…)` is the bug: a $derived MEMOIZES the cache-owned object");
  assert.ok(!/\blayout\./.test(src),
    "no reader may dot into a stored `layout` binding — every geometry query goes through textLayout()");
  // The caret derivation is the one the crash arrived from, so it is named.
  assert.ok(/let\s+caret\s*=\s*\$derived\.by\(\(\)\s*=>\s*\{\s*const l = textLayout\(\);/.test(src),
    "the caret derivation must re-fetch; it is the read the reported effect-flush crash came from");
});

console.log(`\ntext_layout disposed gate: ${passed} checks passed`);
