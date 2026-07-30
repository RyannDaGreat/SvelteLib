/**
 * THE PROJECT SCRIPT — one JavaScript function library per document, reusable
 * from every property equation.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * An equation slot is a ONE-LINER: `= self.w / 2 + margin`. That is the right
 * shape for the 99% case, and it is deliberately so — a property is a value, and
 * an editor that made every property a code file would be unusable. But the
 * consequence was that anything genuinely COMPLEX had to be written INLINE, once
 * per slot, in a single expression. A twelve-item deck whose widgets all sit on
 * the same easing curve carried twelve copies of that curve, each one an
 * independently-editable transcription of the same intent — which is the drift
 * hazard this codebase pays for everywhere else it appears. User ruling, verbatim:
 *
 *   "a global script per project … which would actually be a repository of
 *    functions written in JavaScript that can then be used in different
 *    properties so that we would expose these functions and variables and
 *    values … complex code can be reused in many places."
 *
 * ── THE SOLUTION ────────────────────────────────────────────────────────────
 * `doc.meta.script` is a string of JavaScript, edited in the SAME Monaco modal
 * the codeblock/mermaid/latex widgets use, saved as part of the project, and
 * committed through the SAME undo path as every other edit. It is compiled in
 * THE SAME JAIL core/expressions.js compiles equations in (`new Function` with a
 * proxy scope whose `has` trap is always true, so there is no fall-through to the
 * real globals) and its exported bindings are merged into the EQUATION SCOPE, so
 * any property equation can call them:
 *
 *   script:    exports.ease = (t) => t * t * (3 - 2 * t);
 *              exports.GUTTER = 24;
 *   equation:  = 100 + 200 * ease(t)          (in ANY item's any property)
 *   equation:  = other.x + GUTTER             (in another item's, same binding)
 *
 * ── THE EXPORT CONVENTION, AND WHY THIS ONE ─────────────────────────────────
 * A binding is EXPORTED iff it is assigned to the provided `exports` object.
 * Nothing else escapes: the script's own `const`/`let`/`function` declarations are
 * private to it, which is what makes helper decomposition possible (a function may
 * be split into five, only one of which is a property's business).
 *
 * ESM `export` syntax was rejected: `new Function` bodies are SCRIPTS, not
 * modules, so `export` there is a syntax error — supporting it would mean
 * shipping a parser/transpiler for a keyword whose only advantage is looking
 * familiar. Auto-exporting every top-level declaration was rejected for the
 * opposite reason: it makes every rename of a local helper a potential break of a
 * property equation somewhere else in the deck, with no way to say "this one is
 * mine". An explicit object is one word per exported thing and leaves the
 * boundary visible in the source.
 *
 * ── DETERMINISM IS NOT NEGOTIABLE ───────────────────────────────────────────
 * The script runs in the equation jail, so the manifest's THREE KINDS OF STATE
 * law still holds: `Date`, `performance`, `Math.random`, `fetch`, `window` and
 * friends are unreachable (core/expressions.BLOCKED_GLOBALS), `Math` is
 * SAFE_MATH (every member except `random`), and a SEEDED `random` plus the ONE
 * presentation clock `time` are available exactly as they are inside an equation.
 * A project script therefore cannot introduce EPHEMERAL state, and
 * `RenderTree = pure(document, [[slide, alpha]])` survives it — which is the whole
 * reason the script is compiled here rather than with a bare `new Function`.
 *
 * A script gets MORE of the language than an equation does — the pure value-level
 * built-ins (`Object`, `Array`, `JSON`, `Map`, `Error`, …) listed and justified at
 * SCRIPT_STDLIB. Every one of them is a function of its arguments alone, so none
 * weakens the guarantee above; a library that cannot construct an `Error` or shape
 * an object is not a library.
 *
 * WHAT THE SCRIPT DOES *NOT* GET, deliberately: the document. There is no `items`
 * / `vars` / `self` in the script's own scope, because the script body runs ONCE
 * per compile, not once per slot — a reference read there would be a snapshot
 * from whichever pass happened to compile first, which is exactly the silent
 * wrongness this file exists to avoid. An exported FUNCTION, by contrast, is
 * CALLED from a slot, so its arguments are that slot's values: pass the state in
 * (`= ease(self.w / 100)`). Free identifiers inside an exported function body
 * resolve against the SCRIPT's scope, not the calling slot's.
 *
 * ── SHADOWING IS A LOUD COMPILE ERROR ───────────────────────────────────────
 * A script export named `time`, `Math`, `random`, `self`, or any function-library
 * name (`closest_to_rim`, `text_type`, …) is REFUSED at compile time, naming the
 * collision. It is not silently ignored and it does not silently win. Either
 * precedence would make the meaning of `= time` depend on a file the reader of
 * the equation is not looking at; refusing keeps one spelling with one meaning.
 * Item SLUGS are not checked here (they are per-document, dynamic, and a slug can
 * be renamed after the script is written) — a slug wins over a script export at
 * READ time, because a slug is a reference to a thing on the canvas the author
 * can see. That precedence is pinned by tests.
 */

import { BLOCKED_GLOBALS, FUNCTIONS, SAFE_MATH } from "./expressions.js";

// The evaluator's own scope keywords — resolved by core/expressions.js's
// `scopeGet` BEFORE script exports are consulted, so an export using one could
// never be reached, which makes accepting it a silent no-op (the exact failure
// this file refuses). `self` is here too: it is the owning-item keyword, handled
// as a reference head.
const RESERVED_KEYWORD_NAMES = ["time", "random", "Math", "self", "undefined", "NaN", "Infinity"];

/**
 * THE DETERMINISTIC STANDARD LIBRARY a project script may reach — beyond `Math`,
 * `time` and the seeded `random`, which the evaluator serves itself.
 *
 * WHY THIS EXISTS AT ALL. An EQUATION is one expression, so it needs almost nothing
 * from the language. A SCRIPT is a library: it declares helpers, validates their
 * arguments and shapes data, and it cannot do any of that if `Error`, `Object` and
 * `Array` are unreachable. Without this list a script could not even
 * `throw new Error("bad angle")` — the throw failed with "Error is not a
 * constructor", which blames the jail for the author's perfectly good code. That is
 * a worse failure than the one the jail is there to prevent.
 *
 * EVERY NAME HERE IS A PURE VALUE-LEVEL BUILT-IN — a function of its arguments and
 * nothing else. NONE of them can read a clock, a device, a network or an entropy
 * source, so the determinism law is untouched: `Object`, `Array`, `String`,
 * `Number`, `Boolean`, `JSON`, `Symbol`, `Map`, `Set`, `RegExp`, `parseFloat`,
 * `parseInt`, `isNaN`, `isFinite` and the error constructors.
 *
 * DELIBERATELY ABSENT, each for a stated reason rather than by oversight:
 *   Date, performance          a clock (BLOCKED_GLOBALS — the whole point)
 *   Math.random                excised by SAFE_MATH; `random` is the seeded one
 *   fetch/XHR/WebSocket        I/O, so a frame would depend on a network
 *   Promise, setTimeout        asynchrony: `emit()` is synchronous, so an async
 *                              result could only arrive after the frame was drawn
 *   Function, eval             a second, UNJAILED compiler — the escape hatch
 *   Proxy, Reflect             can forge the jail's own scope objects
 *   globalThis, window         the ambient world this jail exists to hide
 *   WeakMap/WeakRef            observable GC timing (an identity-keyed cache is
 *                              still available through Map)
 */
const SCRIPT_STDLIB = Object.freeze({
  Object, Array, String, Number, Boolean, JSON, Symbol, Map, Set, RegExp,
  parseFloat, parseInt, isNaN, isFinite,
  Error, TypeError, RangeError, SyntaxError,
});

/**
 * Query (reads a module const of core/expressions.js; memoized). Names a script
 * export may NOT take: the evaluator keywords, every FUNCTION-library name, and
 * every SCRIPT_STDLIB name. The latter two are FOLDED IN from their own
 * declarations rather than restated, so a new library function or a new stdlib
 * entry becomes reserved automatically instead of by remembering to edit a list.
 *
 * COMPUTED LAZILY, not at module scope, because this module and
 * core/expressions.js import EACH OTHER: expressions.js needs
 * compileProjectScript and this needs its jail constants. Under ESM the cycle
 * evaluates this module's body FIRST, so `FUNCTIONS` is still in its temporal
 * dead zone at that moment — reading it at module scope threw a
 * ReferenceError at import time. Every read here happens inside a compile, long
 * after both modules are initialized.
 *
 * @example scriptReservedNames().has("time") // true
 * @example scriptReservedNames().has("closest_to_rim") // true (a FUNCTIONS name)
 * @example scriptReservedNames().has("ease") // false
 */
export function scriptReservedNames() {
  return (reservedMemo ??= new Set([
    ...RESERVED_KEYWORD_NAMES, ...Object.keys(FUNCTIONS), ...Object.keys(SCRIPT_STDLIB),
  ]));
}
let reservedMemo = null;

/**
 * Pure function. Is `name` a legal JavaScript identifier — i.e. can an equation
 * actually SPELL this export? An export keyed by anything else (a space, a dash,
 * a number) is unreachable from an equation, so it is refused rather than
 * silently accepted.
 *
 * @example isIdentifier("ease") // true
 * @example isIdentifier("GUTTER_2") // true
 * @example isIdentifier("my ease") // false
 * @example isIdentifier("2fast") // false
 */
export function isIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/**
 * Pure function. The jail scope a PROJECT SCRIPT body runs against — the same
 * determinism guarantee an equation gets, minus the document references (see this
 * file's header for why the script body has none).
 *
 * `has: () => true` is what closes the jail: every free identifier in the script
 * routes through `get`, so there is no fall-through to the real globals. `get`
 * hands back the deterministic host (SAFE_MATH, the seeded `random`, the ONE
 * presentation clock via `time`), the `exports` collector, and `undefined` for
 * everything else — so `Date.now()` inside a script throws loudly rather than
 * reaching the wall clock, exactly as it does inside an equation.
 *
 * `exports` COMES THROUGH THE SCOPE, not through a function parameter, and it has
 * to: `with(scope)` sits INSIDE the compiled function, so its always-true `has`
 * trap shadows every parameter name the body could see — an `exports` argument
 * resolved to the proxy's `undefined` and the first assignment threw "Cannot set
 * properties of undefined". Serving it here keeps ONE definition of what a script
 * can see, which is the whole point of having a scope object.
 *
 * ── `time` AND `random` COME FROM A CELL, AND WHY ───────────────────────────
 * `cell.host` is read at every access, never captured, because the compile is
 * MEMOIZED per source (see scriptCache) while the clock advances every frame. A
 * scope that closed over one pass's host would hand an exported function the FIRST
 * pass's clock forever — the whole document would animate except the script, with
 * no error. The evaluator re-points `cell.host` before each pass instead, so an
 * exported function called from a slot reads that pass's clock and that pass's
 * seeded PRNG.
 *
 * A read at the script's TOP LEVEL is REFUSED (`cell.host` is null while the body
 * runs) for the same reason: the body runs once per source, so a top-level value
 * would be frozen at whatever the first pass saw. The refusal is a thrown Error, so
 * it surfaces as the script's compile error naming the fix.
 *
 * Args:
 *   cell (object): {host} — re-pointed per pass to {random, time}, or null while
 *     the script body runs (see above).
 *   exported (object): the collector the script assigns its public bindings to.
 *
 * Returns:
 *   Proxy usable as the `with(scope)` object of a compiled script body.
 *
 * @example // const scope = scriptScope({host: {random: () => 0.5, time: () => 0}}, {});
 * @example // "anythingAtAll" in scope // true — the `has` trap closes the jail
 * @example // scriptScope({host: null}, {}).time // throws: `time` is unavailable at the top level
 */
export function scriptScope(cell, exported) {
  /** The host, or a loud refusal when this is a top-level read. */
  const host = (name) => {
    if (!cell.host)
      throw new Error(`"${name}" is unavailable at the project script's top level — the script body runs once, so a value read here would be frozen forever. Read it inside an exported function instead (exports.f = () => ${name}), which runs per frame.`);
    return cell.host;
  };
  return new Proxy(Object.create(null), {
    has: () => true,
    get: (_t, prop) => {
      if (typeof prop === "symbol") return undefined;
      switch (prop) {
        case "exports": return exported;
        case "undefined": return undefined;
        case "NaN": return NaN;
        case "Infinity": return Infinity;
        case "Math": return SAFE_MATH; // no random
        case "time": return host("time").time();
        case "random": return host("random").random;
      }
      // BLOCKED_GLOBALS is listed explicitly for the same reason expressions.js
      // lists it: `has: () => true` already blocks the fall-through, so this is
      // the self-documenting half of the guard. It is checked BEFORE the stdlib so
      // a name appearing in both could only ever resolve to the refusal.
      if (BLOCKED_GLOBALS.has(prop)) return undefined;
      if (prop in SCRIPT_STDLIB) return SCRIPT_STDLIB[prop]; // pure value-level built-ins
      // Everything else is undefined, so a member access on it throws loudly and
      // names the identifier.
      return undefined;
    },
  });
}

// Compile cache: script SOURCE → the compiled result. Keyed on the source string
// (not the document) because the result is a pure function of it, and because the
// editor re-derives on every keystroke elsewhere in the app — recompiling a
// 200-line script per reactive pass would be the equation memo's problem all over
// again. Unbounded is fine: one entry per distinct script source a session sees.
//
// ── WHY THE HOST IS *NOT* PART OF THE KEY, AND WHY THAT IS SAFE ──────────────
// The cache means the script BODY runs ONCE per source, with whichever pass's host
// happened to be first. Two consequences, both handled rather than hoped away:
//
//   1. A TOP-LEVEL read of `time`/`random` would freeze that reading forever — a
//      silent determinism break of exactly the kind the manifest's Δt law forbids.
//      It is REFUSED: the scope's host cell is null while the body runs, so such a
//      read throws and becomes the script's compile error, naming the fix.
//   2. An EXPORTED FUNCTION reading them must see the CURRENT pass's values, not the
//      first pass's. Each cached entry therefore carries the host CELL its scope
//      reads through, and compileProjectScript re-points it on every call. So the
//      function body is compiled once and the clock behind it is always live.
const scriptCache = new Map(); // source → {exports, error, cell}

/** The result every blank script shares — a stable identity, so a caller may use
 *  it as a cheap "nothing to merge" test. */
const EMPTY_SCRIPT = Object.freeze({ exports: Object.freeze({}), error: null });

/**
 * Near-pure function (memoizes into a module cache; NEVER throws). Compiles a
 * PROJECT SCRIPT source into `{exports, error}`:
 *
 *   exports  a frozen name → value map of everything the script assigned to
 *            `exports`, ready to merge into the equation scope. `{}` when the
 *            source is blank or the compile failed.
 *   error    null on success, else the human-readable message (a syntax error, a
 *            throw from the script body, a RESERVED-NAME collision, or a
 *            non-identifier export key). The caller REPORTS it — this function
 *            does not touch the console, so the modal and the report path get the
 *            same string and cannot describe the failure differently.
 *
 * FAILURE IS TOTAL, ON PURPOSE: a script that throws halfway exports NOTHING,
 * rather than the half it managed to assign before failing. A partial library is
 * worse than none — the equations referencing the missing half would fail with
 * "Unknown variable", which points at the equation instead of at the script that
 * is actually broken. With an empty export map, every equation using ANY export
 * fails loudly through the existing equation-error path and the script's own error
 * is surfaced once, at the script.
 *
 * WHY IT RETURNS THE ERROR RATHER THAN THROWING: this runs inside the derivation
 * pass, which must always produce a frame (a broken script must not blank the
 * canvas), and the SAME call backs the modal's error line. One return shape serves
 * both.
 *
 * Args:
 *   src (string): the script source (doc.meta.script).
 *   host (object): {random, time} — the seeded PRNG and a `() => number` clock
 *     reader for THIS pass. Re-pointed into the cached entry's cell on every call,
 *     so an exported function always reads the current clock (see scriptCache).
 *
 * Returns:
 *   {exports: object, error: string|null}
 *
 * @example // compileProjectScript("exports.two = 2;", host) // {exports: {two: 2}, error: null}
 * @example // compileProjectScript("exports.ease = t => t*t;", host).exports.ease(2) // 4
 * @example // compileProjectScript("exports.time = 1;", host).error // 'Project script export "time" collides with a built-in…'
 * @example // compileProjectScript("(", host).error // a syntax-error message
 * @example // compileProjectScript("", host) // {exports: {}, error: null}
 */
export function compileProjectScript(src, host) {
  const source = typeof src === "string" ? src : "";
  if (source.trim() === "") return EMPTY_SCRIPT;
  const cached = scriptCache.get(source);
  if (cached) {
    cached.cell.host = host; // this pass's clock + PRNG, behind the once-compiled functions
    return cached;
  }
  const result = computeProjectScript(source, host);
  scriptCache.set(source, result);
  return result;
}

/**
 * Query (reads the compile cache; NEVER compiles and never mutates it). Why `src`
 * does not compile, or null when it does — the UI's read, for the code modal's
 * footer problem line.
 *
 * IT DOES NOT COMPILE, deliberately: `compileProjectScript` would have to be handed
 * a host, and a UI-supplied one would overwrite the live cell that this pass's
 * exported functions read their clock through (see scriptCache) — a status line has
 * no business changing what the canvas evaluates. So this reports on the compile the
 * EVALUATOR already did, which is also the only compile whose verdict matters. A
 * source the evaluator has not reached yet reads as null (nothing known against it),
 * and the next derivation pass — which a commit always triggers — fills it in.
 *
 * @example // projectScriptProblem("") // null (a blank script always compiles)
 * @example // after the evaluator compiled a broken script: projectScriptProblem(src) // "Project script syntax error: …"
 */
export function projectScriptProblem(src) {
  const source = typeof src === "string" ? src : "";
  if (source.trim() === "") return null;
  return scriptCache.get(source)?.error ?? null;
}

/**
 * Query (reads the compile cache; NEVER compiles and never mutates it). The exports
 * of `src` as the EVALUATOR compiled them, or `{}` when it has not compiled this
 * source (or the source failed). Same non-perturbing contract as
 * projectScriptProblem, and for the same reason.
 *
 * The UI's read: the equation-field highlighter needs to know which bare
 * identifiers the script legitimately provides, so it does not paint a working
 * equation red. Reading the EVALUATOR's compile is what makes the paint and the
 * value agree by construction rather than by two lists staying in step.
 *
 * @example // projectScriptExports("") // {} (a blank script exports nothing)
 * @example // after the evaluator compiled "exports.ease = t => t;": Object.keys(projectScriptExports(src)) // ["ease"]
 */
export function projectScriptExports(src) {
  const source = typeof src === "string" ? src : "";
  if (source.trim() === "") return EMPTY_SCRIPT.exports;
  return scriptCache.get(source)?.exports ?? EMPTY_SCRIPT.exports;
}

/** Pure-core of compileProjectScript (see its docs); uncached, never throws.
 *  Returns the same shape PLUS the host `cell` the cache re-points per pass. */
function computeProjectScript(source, host) {
  const cell = { host: null }; // null WHILE THE BODY RUNS — see scriptScope
  const failed = (error) => ({ exports: Object.freeze({}), error, cell });
  let body;
  try {
    // `with(scope)` closes the jail over the WHOLE body (the equation compiler's
    // exact mechanism); "use strict" is deliberately ABSENT because `with` is a
    // strict-mode syntax error, which is the same trade equations already make.
    // The trailing newline neutralizes a trailing line comment.
    body = new Function("scope", `with(scope){\n${source}\n}`);
  } catch (e) {
    return failed(`Project script syntax error: ${e.message}`);
  }
  const exported = Object.create(null);
  try {
    body(scriptScope(cell, exported));
  } catch (e) {
    return failed(`Project script threw: ${e.message}`);
  }
  cell.host = host; // the body is done; exported functions may now read the clock
  const reserved = scriptReservedNames();
  for (const name of Object.keys(exported)) {
    if (!isIdentifier(name))
      return failed(`Project script export "${name}" is not a legal identifier, so no equation could reference it — export a name matching /^[A-Za-z_$][A-Za-z0-9_$]*$/`);
    if (reserved.has(name))
      return failed(`Project script export "${name}" collides with a built-in of the same name — built-ins are not shadowable, so rename the export. Reserved: ${[...reserved].sort().join(", ")}`);
  }
  // `cell` rides along so the cache can re-point it per pass — an exported function
  // reads the CURRENT clock through it, not the clock of the pass that compiled it.
  return { exports: Object.freeze({ ...exported }), error: null, cell };
}
