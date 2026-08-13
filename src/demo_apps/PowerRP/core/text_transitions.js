/**
 * STRING-TRANSITION FUNCTIONS — pure, deterministic text interpolators for the
 * equation FUNCTIONS registry (core/expressions.js). Each maps (text…, alpha)
 * to a STRING, so an `=` equation in any string slot (especially the plaintext
 * widget) can ANIMATE its text over a presentation's tween alpha:
 *
 *   text_type("Reveal", alpha)          typewriter — first ⌊alpha·len⌋ chars
 *   text_scramble("Resolve", alpha)     decoding noise → clear, left to right
 *   text_dissolve("From", "To", alpha)  From → To by a shuffled crossfade
 *
 * DETERMINISM (the hard requirement): RenderTree = pure(document, alpha), so
 * these NEVER read Date/Math.random. Every bit of apparent "randomness" (scramble
 * glyphs, dissolve order) is SEEDED from the input text via a tiny FNV-1a hash +
 * an integer avalanche — same inputs ⇒ same output, on every derivation pass.
 * Endpoints are EXACT: alpha ≤ 0 and alpha ≥ 1 return the untouched source/target
 * strings, character for character.
 *
 * DOM-free / bare-node (the tests enforce it). No plugin or renderer imports.
 */

import { clamp01Or0 as clamp01 } from "./unit_interval.js";

// FNV-1a 32-bit constants (the reference offset basis + prime). Used for the
// deterministic seed hash and reused as the multiply step of the index mixer.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// The glyph pool a not-yet-resolved character is drawn from (the classic
// "decoding" look). Punctuation-only so it reads as noise against real letters;
// its size is only ever consulted via modulo, so nothing depends on the count.
const SCRAMBLE_GLYPHS = "!<>-_/[]{}=+*^?#%&@$~";

/**
 * Pure function. Clamps a number into [0, 1] — the alpha guard shared by every
 * transition (a tween may briefly overshoot; endpoints must still be exact). THE
 * SHARED fail-closed clamp (core/unit_interval.js `clamp01Or0`), imported at the
 * top of this file and re-exported under this name for the suites that read it
 * from here.
 *
 * @param {number} x - any number
 * @returns {number} x confined to [0, 1]
 *
 * @example clamp01(-0.2) // 0
 * @example clamp01(0.5) // 0.5
 * @example clamp01(1.7) // 1
 */
export { clamp01 };

/**
 * Pure function. FNV-1a hash of a string → a uint32. The deterministic seed
 * source for every transition's "randomness" (so output depends only on the
 * inputs, never the wall clock). Not cryptographic — just a fast, well-spread
 * mix.
 *
 * @param {string} s - the string to hash
 * @returns {number} a uint32 (0 … 2³²−1)
 *
 * @example hashText("") // 2166136261 (the bare FNV offset basis)
 * @example hashText("a") !== hashText("b") // true
 */
export function hashText(s) {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * Pure function. Derives a fresh uint32 from a base seed and an integer index —
 * a per-position "draw" with NO shared RNG state (so it is trivially
 * reproducible). A standard integer avalanche: xor-in the index, FNV-multiply,
 * xor-fold, multiply, fold again. The `+ 1` keeps index 0 from being a no-op.
 *
 * @param {number} seed - a uint32 (typically from hashText)
 * @param {number} i - a non-negative integer position
 * @returns {number} a uint32
 *
 * @example // mix(hashText("x"), 0) !== mix(hashText("x"), 1)  (adjacent indices decorrelate)
 * @example // mix(123, 4) === mix(123, 4)  (deterministic)
 */
function mix(seed, i) {
  let h = Math.imul((seed ^ (i + 1)) >>> 0, FNV_PRIME);
  h ^= h >>> 15;
  h = Math.imul(h, FNV_PRIME);
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Pure function. Picks a deterministic scramble glyph for a draw value — the
 * decoding-noise character shown in place of a not-yet-resolved letter. Indexes
 * SCRAMBLE_GLYPHS by the draw modulo its length.
 *
 * @param {number} draw - a uint32 (from mix)
 * @returns {string} a single-character string from SCRAMBLE_GLYPHS
 *
 * @example // scrambleGlyph(mix(hashText("x"), 0)) is one char of SCRAMBLE_GLYPHS
 * @example // typeof scrambleGlyph(0) === "string"
 */
function scrambleGlyph(draw) {
  return SCRAMBLE_GLYPHS[draw % SCRAMBLE_GLYPHS.length];
}

/**
 * Pure function. A deterministic permutation of the indices [0, length) — the
 * ORDER in which positions commit during a dissolve. Each index gets a draw from
 * mix(seed, i); indices are sorted by that draw (ties broken by index, so the
 * sort is stable and reproducible). A genuine shuffle: order is decorrelated from
 * position, so a dissolve SCATTERS rather than wipes left-to-right.
 *
 * @param {number} length - how many indices (≥ 0)
 * @param {number} seed - a uint32 (from hashText)
 * @returns {number[]} a permutation of [0 … length−1]
 *
 * @example shuffledOrder(0, 123) // []
 * @example shuffledOrder(3, 123).slice().sort((a, b) => a - b) // [0, 1, 2] (it is a permutation)
 * @example JSON.stringify(shuffledOrder(4, 7)) === JSON.stringify(shuffledOrder(4, 7)) // true (deterministic)
 */
export function shuffledOrder(length, seed) {
  const indices = Array.from({ length }, (_, i) => i);
  return indices.sort((a, b) => mix(seed, a) - mix(seed, b) || a - b);
}

/**
 * Pure function. TYPEWRITER reveal: the first ⌊alpha·len⌋ characters of `str`,
 * so the text appears one glyph at a time as alpha runs 0→1. Fully deterministic
 * (no randomness — alpha alone chooses the cut). Endpoints exact: alpha ≤ 0 → ""
 * (nothing typed yet), alpha ≥ 1 → the whole string.
 *
 * @param {string} str - the text to reveal
 * @param {number} alpha - progress in [0, 1] (clamped)
 * @returns {string} the revealed prefix
 *
 * @example textType("Hello", 0) // ""
 * @example textType("Hello", 1) // "Hello"
 * @example textType("Hello", 0.5) // "He" (⌊0.5·5⌋ = 2)
 * @example textType("Hello", 0.6) // "Hel" (⌊0.6·5⌋ = 3)
 */
export function textType(str, alpha) {
  const s = String(str);
  const revealed = Math.floor(clamp01(alpha) * s.length);
  return s.slice(0, revealed);
}

/**
 * Pure function. SCRAMBLE-RESOLVE: the string emerges from decoding noise. The
 * first ⌊alpha·len⌋ characters are RESOLVED (their true glyph); the rest show a
 * deterministic scramble glyph — but whitespace is always preserved so word
 * shape stays legible. The scramble is seeded from BOTH the text and the current
 * resolved-count, so it re-draws as alpha advances (the "flicker while decoding"
 * look) while staying fully reproducible for a given (str, alpha). Same length as
 * `str` at every alpha. Endpoints exact: alpha ≥ 1 → `str` verbatim; alpha ≤ 0 →
 * every non-space glyph scrambled.
 *
 * @param {string} str - the target (resolved) text
 * @param {number} alpha - progress in [0, 1] (clamped)
 * @returns {string} a string the same length as `str`
 *
 * @example textScramble("Hello", 1) // "Hello"
 * @example textScramble("Hello", 1).length // 5
 * @example textScramble("Hello", 0).length // 5 (fully scrambled, same length)
 * @example textScramble("abc", 0.5) === textScramble("abc", 0.5) // true (deterministic)
 */
export function textScramble(str, alpha) {
  const s = String(str);
  const resolved = Math.floor(clamp01(alpha) * s.length);
  const frameSeed = mix(hashText(s), resolved); // re-seeds per resolved-count → flicker
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += i < resolved || /\s/.test(ch) ? ch : scrambleGlyph(mix(frameSeed, i));
  }
  return out;
}

/**
 * Pure function. DISSOLVE (crossfade) from `from` to `to`: as alpha runs 0→1, a
 * shuffled-order set of character positions flips from the `from` glyph to the
 * `to` glyph, so the first string scatters into the second (NOT a left-to-right
 * wipe — that is textType's job). Positions are laid over the LONGER of the two
 * lengths; a position past a string's end contributes no character, so the
 * visible length grows/shrinks toward the target. Deterministic: the flip order
 * is seeded from `from`+`to`. Endpoints EXACT: alpha ≤ 0 → `from` verbatim,
 * alpha ≥ 1 → `to` verbatim.
 *
 * @param {string} from - the starting text
 * @param {string} to - the ending text
 * @param {number} alpha - progress in [0, 1] (clamped)
 * @returns {string}
 *
 * @example textDissolve("cat", "dog", 0) // "cat"
 * @example textDissolve("cat", "dog", 1) // "dog"
 * @example textDissolve("cat", "dog", 0.5) === textDissolve("cat", "dog", 0.5) // true (deterministic)
 * @example textDissolve("hi", "hello", 1) // "hello" (grows to the longer target)
 * @example textDissolve("hello", "hi", 0) // "hello" (starts at the longer source)
 */
export function textDissolve(from, to, alpha) {
  const a = String(from);
  const b = String(to);
  const t = clamp01(alpha);
  if (t <= 0) return a;
  if (t >= 1) return b;
  const len = Math.max(a.length, b.length);
  const committed = Math.floor(t * len);
  // "\0" separates the two operands so "ab"+"c" and "a"+"bc" seed differently.
  const order = shuffledOrder(len, hashText(a + "\0" + b));
  const showsTo = new Array(len).fill(false);
  for (let k = 0; k < committed; k++) showsTo[order[k]] = true;
  let out = "";
  for (let i = 0; i < len; i++) {
    const src = showsTo[i] ? b : a;
    if (i < src.length) out += src[i];
  }
  return out;
}
