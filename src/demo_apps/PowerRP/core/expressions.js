/**
 * THE UNIFICATION — expressions over variables, item properties, and anchors.
 *
 * "The properties can all be strings. If a numerical property is a string, it
 * means it's an equation. If it's an equation, it can read from variables.
 * And anchors are just variables that can be visualized." (manifest, round 5)
 *
 * WHAT IS AN EQUATION: a property is an equation slot iff the plugin's default
 * for that (possibly nested) key is a NUMBER and the folded value is a STRING.
 * That single rule keeps `name`, `text`, and `fill` (string defaults) out of
 * the expression system with no per-plugin annotations. Variables (state.vars)
 * are numbers by definition, so every string var is an equation.
 *
 * GRAMMAR (tiny recursive descent — arithmetic over references and function
 * calls):
 *   expr    := term (("+" | "-") term)*
 *   term    := factor (("*" | "/") factor)*
 *   factor  := "-" factor | primary ("." ("x"|"y"))?
 *   primary := NUMBER | CALL | REF | "(" expr ")"
 *   CALL    := REF "(" (expr ("," expr)*)? ")"
 * A CALL evaluates to a POINT value ({x, y}); the optional ".x"/".y" suffix
 * PROJECTS it to a scalar (from.x = `closest_to_rim(circle1, circle2).x`). The
 * function names are REGISTRY-DRIVEN (the FUNCTIONS table below), not baked into
 * the tokenizer: `foo` tokenizes as an ordinary identifier and is only treated
 * as a call when followed by "(" — an unknown function name is a LOUD error.
 * Widget arguments (a bare item slug / stored "@id") are converted display↔stored
 * exactly like any item reference, driven by the function's declared parameter
 * kinds (see FUNCTIONS).
 *
 * REFERENCE SYNTAX (display form — what the user types and sees):
 *   speed                bare identifier         → variable state.vars.speed
 *   circle.x             <itemSlug>.<prop...>    → item property (world state)
 *   circle_tm.x          <itemSlug>_<anchorId>.x → anchor world coordinate
 *   circle_closest.x     the computed closest-point anchor (arrow endpoints)
 * Ambiguity rule (documented, deterministic): a dotted head resolves as an
 * item slug FIRST; only if no item has that slug is it split on its LAST "_"
 * and tried as <itemSlug>_<anchorId>. Bare names are ALWAYS variables.
 *
 * STORED SYNTAX (what lives in the document): identical grammar, but item
 * references use "@<itemId>" in place of the slug: "@ab12cd34.x + 10",
 * "@ab12cd34_tm.x". DESIGN DECISION — store by itemId, display as slugs:
 * renames then need NO document rewrites (a slug is derived from the current
 * name at display time), which is the failure-proof option; slug-at-parse
 * with rename-rewrites would silently break any reference a rewrite missed.
 * Variables are referenced by NAME in both forms (a variable's name IS its
 * identity, like a CSS custom property), so variable renames DO rewrite
 * equations — see withVariableRenamed. Display-form refs inside stored docs
 * are also legal (hand-written save files resolve against current slugs);
 * the editor always stores the @id form.
 *
 * PROPERTY-PATH CASE (manifest "EQUATION DISCOVERABILITY — Blender data-path
 * standard"): the SAME display↔stored duality applies one level deeper, to a
 * property path's individual segments. Display is ALWAYS snake_case
 * ("end_width", "rotation_anchor.x"); stored is the plugin's native camelCase
 * key ("endWidth", "rotationAnchor.x") — converted per-segment at the field
 * boundary via snakeToCamel/camelToSnake (pathToStored/pathToDisplay),
 * exactly where item slugs already convert (displayToStored/storedToDisplay).
 * ONE canonical form, NO tolerant aliasing: a camelCase segment typed into an
 * equation is not silently accepted as the same property — it is rejected as
 * unknown (checkCanonicalPath), the same loud-typo-protection discipline
 * unknown variables already get. `self.anchors.<id>` and item-anchor refs
 * (`slug_anchorId.x`) are UNAFFECTED — anchor ids are short internal codes
 * ("tm", "cm"), never multi-word plugin properties.
 *
 * EVALUATION lives in the derivation stage, post-fold: evaluateState() takes
 * a folded state, builds the dependency graph over all equation slots,
 * topo-sorts (Kahn), and evaluates. Cycles are a LOUD error: every slot on
 * the cycle gets an error message (rendered as the Property Panel's error
 * affordance), the console explains the cycle once, and the slot falls back
 * to its plugin default (never a silent NaN). RenderTree stays
 * pure(Document, [[delta, alpha]]) — evaluation is deterministic.
 *
 * DYNAMIC-ANCHOR FUNCTION LIBRARY (manifest "Dynamic anchors — USER
 * REFINEMENT"): the grammar has FUNCTION CALLS returning POINT values, projected
 * with `.x`/`.y` — `closest_to_rim(widget, x, y)` (the rim point nearest a
 * point) and `closest_to_rim(widgetA, widgetB)` (the point on A's rim of the
 * nearest PAIR between two rims). Function names are REGISTRY-driven (FUNCTIONS),
 * not baked into the tokenizer; widget args convert display↔stored like any item
 * ref. The rim-vs-rim case is solved as ONE joint nearest-pair problem
 * (outline.nearestRimPair, generic over rim geometry) reading only the two rims'
 * GEOMETRY — so a mutual pair's two endpoints are topologically INDEPENDENT (they
 * do NOT depend on each other), which kills the mutual-closest wobble class by
 * construction: NO fixpoint sweeps, one deterministic solve per pass, memoized so
 * from.x/from.y (and the symmetric to-side call) share it. The legacy
 * `@id_closest.x` anchor sugar (still written by the drag-to-rim UX) is routed to
 * the SAME solver — mutual (its toward endpoint is also a closest ref) → joint
 * pair; otherwise → rim-vs-point toward the arrow's other endpoint. This REPLACES
 * the old Gauss-Seidel two-sweep fixpoint (which needed ~82 sweeps at a 1px gap
 * and left visible error near tangency).
 */

import { isTree, copied, getPath, setPath, leaves } from "./deltas.js";
import * as T from "./transform.js";
import { worldTransform } from "./derive.js";
import { reportOnce } from "./report.js";
import { nearestRimPair, NEAREST_PAIR_MAX_ITERS } from "./outline.js";

// ── Tokenizer ────────────────────────────────────────────────────────────────

const OP_CHARS = "+-*/()";
const NUM_RE = /^(?:\d+\.?\d*|\.\d+)/;
// A reference token: optional "@" (stored item ref), then an identifier chain.
const REF_RE = /^@?[A-Za-z0-9_]+(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;

/**
 * Pure function. Tokenizes an expression source string.
 *
 * Returns [{kind: "num"|"ref"|"op"|"comma"|"dot", value, start, end}] with
 * source positions (so display↔stored conversion can rewrite refs in place).
 * "comma" separates function-call arguments; "dot" is a STANDALONE "." (member
 * projection after a call/paren, e.g. `f(a).x`) — dots INSIDE an identifier
 * chain (`a.b.c`) are eaten by REF_RE and never surface as a dot token, so a
 * lone dot only appears where a projection can. Throws on any character
 * outside the grammar.
 *
 * @example tokenize("speed * 2").map((t) => t.kind) // ["ref", "op", "num"]
 * @example tokenize("@ab12_tm.x + 10")[0].value // "@ab12_tm.x"
 * @example tokenize("f(a, b).x").map((t) => t.kind) // ["ref", "op", "ref", "comma", "ref", "op", "dot", "ref"]
 * @example // tokenize("3 $ 4") throws: Unexpected character "$" at 2
 */
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === ",") {
      tokens.push({ kind: "comma", value: ",", start: i, end: i + 1 });
      i++;
    } else if (OP_CHARS.includes(ch)) {
      tokens.push({ kind: "op", value: ch, start: i, end: i + 1 });
      i++;
    } else if (ch === "." && !/[0-9]/.test(src[i + 1] ?? "")) {
      // A standalone "." (not the start of a ".5"-style number) — member
      // projection. `a.b` refs are handled by REF_RE above; this only fires
      // for a dot that starts a token, i.e. right after a ")" or another ref.
      tokens.push({ kind: "dot", value: ".", start: i, end: i + 1 });
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = NUM_RE.exec(src.slice(i));
      if (!m) throw new Error(`Malformed number at ${i} in "${src}"`);
      tokens.push({ kind: "num", value: parseFloat(m[0]), start: i, end: i + m[0].length });
      i += m[0].length;
    } else if (ch === "@" || /[A-Za-z_]/.test(ch)) {
      const m = REF_RE.exec(src.slice(i));
      if (!m || m[0] === "@") throw new Error(`Malformed reference at ${i} in "${src}"`);
      tokens.push({ kind: "ref", value: m[0], start: i, end: i + m[0].length });
      i += m[0].length;
    } else {
      throw new Error(`Unexpected character "${ch}" at ${i} in "${src}"`);
    }
  }
  return tokens;
}

// ── Equation special forms + highlight spans (Opus25, round-3 equation field) ──
// FLAG (Opus24 owns this file's grammar+outline): these two pure functions are
// ADDITIVE and self-contained — they build ONLY on tokenize/resolveRef, add no
// grammar, and are grep-able as "Opus25". They power NumericField's special-form
// GUI (constant scrubber / reference write-through / general text) and its
// syntax-highlight overlay. If the grammar grows (new token kinds, function
// calls), extend TOKEN_CLS below; nothing else here needs to change.

/**
 * Pure function. Classifies an equation STRING into its special form (manifest
 * "Equation special forms" — the GUI keys off this):
 *   "constant"  — a bare number literal ("42", "-3.5"): rendered as a scrubber.
 *   "reference" — a bare, UNMODIFIED dotted path ("speed", "box.x", "self.w",
 *                 "box_tm.x"): the reference-scrub write-through target.
 *   "general"   — anything else (arithmetic over refs): plain text editing.
 * A leading "=" (spreadsheet affordance) is tolerated. Structure ONLY — it does
 * not resolve refs against state (an unknown-but-well-formed path is still a
 * "reference" shape; whether it RESOLVES is a separate question for the caller).
 *
 * @example classifyEquation("42") // "constant"
 * @example classifyEquation("-3.5") // "constant"
 * @example classifyEquation("speed") // "reference"
 * @example classifyEquation("box_tm.x") // "reference"
 * @example classifyEquation("self.w / 2") // "general"
 * @example classifyEquation("a + b") // "general"
 */
export function classifyEquation(src) {
  let tokens;
  try {
    tokens = tokenize(String(src).replace(/^\s*=\s*/, ""));
  } catch {
    return "general"; // unparseable text is edited as general
  }
  if (tokens.length === 1 && tokens[0].kind === "num") return "constant";
  // A leading unary minus on a lone number is still a constant (-3.5).
  if (tokens.length === 2 && tokens[0].kind === "op" && tokens[0].value === "-" && tokens[1].kind === "num")
    return "constant";
  if (tokens.length === 1 && tokens[0].kind === "ref") return "reference";
  return "general";
}

// Non-ref, non-call token → highlight class. Ref tokens get their class from
// resolveRef (var/prop/anchor/self) — a real resolution, never a regex re-lex.
// comma/dot are call/projection punctuation; parens are handled inline.
const TOKEN_CLS = { num: "num", op: "op", comma: "punct", dot: "punct" };

/**
 * Pure function. Maps an equation's SOURCE positions to highlight classes for
 * the syntax overlay (NumericField renders one colored <span> per span behind a
 * transparent input). Reuses tokenize + resolveRef (the REAL tokenizer/
 * resolver, never a second lexer), so highlighting can never diverge from what
 * evaluation actually parses; and it flags UNKNOWN refs as errors on the SAME
 * criteria displayToStored throws on (unknown variable, unknown item/anchor,
 * malformed self) — so the overlay's red always matches the field's invalid
 * affordance.
 *
 * Returns [{start, end, cls}] over the (leading-"="-stripped) source, in order,
 * covering exactly the token characters (gaps = whitespace, rendered as plain
 * text by the caller). Classes: "num", "op", "paren" (a "("/")"), "punct"
 * (comma / projection dot), "call" (a ref immediately followed by "(" — a
 * function name, classified positionally EXACTLY as the parser decides so an
 * unknown function name never looks like an unknown variable), "self", "var",
 * "prop", "anchor" (resolved ref kinds), "error" (a ref that does not resolve
 * to a REAL var/item/anchor, or a source that does not tokenize). `state` is the
 * raw state (for slugs + the vars set); `selfId` (optional) enables `self.…`.
 *
 * DESIGN BOUND (manifest "don't corner the field"): span-based classification is
 * substrate-agnostic — it names character ranges, making no single-line
 * assumption. A future multi-line editor reuses this unchanged (feed it each
 * line's source, offset the spans) — the overlay TECHNIQUE, not this function,
 * is what would generalize.
 *
 * @example // one bare variable, resolvable → a single "var" span
 * @example equationTokenSpans("speed", {vars: {speed: 1}, items: {}}) // [{start: 0, end: 5, cls: "var"}]
 * @example // number + operator + UNKNOWN var → the var is flagged "error"
 * @example equationTokenSpans("2 + ghost", {items: {}}) // [{start: 0, end: 1, cls: "num"}, {start: 2, end: 3, cls: "op"}, {start: 4, end: 9, cls: "error"}]
 * @example // a ref followed by "(" is a function CALL name (not a var/error)
 * @example equationTokenSpans("f(2)", {items: {}}).map((s) => s.cls) // ["call", "paren", "num", "paren"]
 */
export function equationTokenSpans(src, state, selfId = null) {
  const clean = String(src).replace(/^\s*=\s*/, "");
  let tokens;
  try {
    tokens = tokenize(clean);
  } catch {
    // Malformed source: one error span over the whole thing (evaluateState /
    // the invalid affordance report the specifics; the overlay just shows red).
    return clean.length ? [{ start: 0, end: clean.length, cls: "error" }] : [];
  }
  const slugs = slugMap(state);
  const vars = state.vars ?? {};
  // Widget-arg token spans (a bare item ref at a "widget" call position) — so a
  // widget name argument highlights as an item ref, not as an unknown variable.
  // Best-effort: an unparseable/unknown-function source yields no spans (each
  // token still classifies on its own, below).
  let wSpans = new Set();
  try {
    wSpans = widgetArgSpans(parseExpression(clean));
  } catch {
    // no widget-arg classification for malformed input; per-token below still runs
  }
  return tokens.map((t, i) => {
    if (t.kind !== "ref") {
      const cls = t.kind === "op" && (t.value === "(" || t.value === ")") ? "paren" : TOKEN_CLS[t.kind] ?? "op";
      return { start: t.start, end: t.end, cls };
    }
    // A member-projection coord (the x/y right after a standalone "."): grammar.
    if (tokens[i - 1]?.kind === "dot") return { start: t.start, end: t.end, cls: "member" };
    // A ref immediately followed by "(" is a FUNCTION NAME — classify it exactly
    // as the parser does (primary(): ref then peek() "(" → call), so an unknown
    // function name reads as a call, not as an unknown variable.
    const next = tokens[i + 1];
    if (next?.kind === "op" && next.value === "(") return { start: t.start, end: t.end, cls: "call" };
    // A WIDGET argument (bare item slug / "@id" at a widget param): an item ref.
    if (wSpans.has(`${t.start}:${t.end}`)) {
      const ok = t.value === "self" || t.value.startsWith("@") || slugs.toId.has(t.value);
      return { start: t.start, end: t.end, cls: ok ? "prop" : "error" };
    }
    if (t.value === "self" || t.value.startsWith("self.")) {
      try {
        parseSelfRef(t.value, selfId); // validate shape (throws on bare/malformed self)
        return { start: t.start, end: t.end, cls: "self" };
      } catch {
        return { start: t.start, end: t.end, cls: "error" };
      }
    }
    try {
      const d = resolveRef(t.value, slugs, selfId);
      // A bare identifier resolves to {kind:"var"} STRUCTURALLY even when no such
      // variable exists (resolveRef defers the existence check to displayToStored)
      // — flag the nonexistent var as an error so the overlay matches the field.
      if (d.kind === "var" && !(d.name in vars)) return { start: t.start, end: t.end, cls: "error" };
      return { start: t.start, end: t.end, cls: d.kind === "var" ? "var" : d.kind }; // "prop" | "anchor" | "var"
    } catch {
      return { start: t.start, end: t.end, cls: "error" };
    }
  });
}

/**
 * Pure function. Parses an expression into an AST.
 *
 * AST nodes: {kind: "num", value} | {kind: "ref", name} |
 * {kind: "call", name, args} | {kind: "member", obj, prop} |
 * {kind: "neg", arg} | {kind: "bin", op, left, right}. A `call` evaluates to a
 * POINT ({x, y}); a `member` projects it to `.x`/`.y`. Throws (with position)
 * on syntax errors. A leading "=" is tolerated and ignored — the
 * spreadsheet-style equation affordance.
 *
 * @example parseExpression("2 + 3 * x") // {kind: "bin", op: "+", left: {kind: "num", value: 2}, right: {kind: "bin", op: "*", left: {kind: "num", value: 3}, right: {kind: "ref", name: "x"}}}
 * @example parseExpression("-(a.x)") // {kind: "neg", arg: {kind: "ref", name: "a.x"}}
 * @example parseExpression("f(a, b).x") // {kind: "member", obj: {kind: "call", name: "f", args: [{kind: "ref", name: "a"}, {kind: "ref", name: "b"}]}, prop: "x"}
 * @example // parseExpression("1 +") throws: Unexpected end of expression
 */
export function parseExpression(src) {
  const clean = src.replace(/^\s*=\s*/, ""); // spreadsheet-style leading "="
  const tokens = tokenize(clean);
  let pos = 0;
  const peek = () => tokens[pos];
  const takeOp = (...ops) => {
    const t = tokens[pos];
    if (t?.kind === "op" && ops.includes(t.value)) return tokens[pos++].value;
    return null;
  };
  const takeKind = (kind) => (tokens[pos]?.kind === kind ? tokens[pos++] : null);
  function expr() {
    let node = term();
    let op;
    while ((op = takeOp("+", "-"))) node = { kind: "bin", op, left: node, right: term() };
    return node;
  }
  function term() {
    let node = factor();
    let op;
    while ((op = takeOp("*", "/"))) node = { kind: "bin", op, left: node, right: factor() };
    return node;
  }
  function factor() {
    if (takeOp("-")) return { kind: "neg", arg: factor() };
    let node = primary();
    // Optional member projection ".x"/".y" on a point-valued primary (a call
    // result, or a parenthesized point). Only x/y are valid coords.
    if (takeKind("dot")) {
      const p = tokens[pos];
      if (p?.kind !== "ref" || (p.value !== "x" && p.value !== "y"))
        throw new Error(`Expected .x or .y at ${p?.start ?? clean.length} in "${clean}"`);
      pos++;
      node = { kind: "member", obj: node, prop: p.value };
    }
    return node;
  }
  function primary() {
    if (takeOp("(")) {
      const inner = expr();
      if (!takeOp(")")) throw new Error(`Missing ")" at ${peek()?.start ?? clean.length} in "${clean}"`);
      return inner;
    }
    const t = peek();
    if (!t) throw new Error(`Unexpected end of expression in "${clean}"`);
    if (t.kind === "num") return { kind: "num", value: tokens[pos++].value };
    if (t.kind === "ref") {
      const tok = tokens[pos++];
      if (peek()?.kind === "op" && peek().value === "(") return call(tok.value);
      // start/end are the source span of this ref token — lets the display↔
      // stored converters and the dependency collector locate widget-arg tokens.
      return { kind: "ref", name: tok.value, start: tok.start, end: tok.end };
    }
    throw new Error(`Unexpected "${t.value}" at ${t.start} in "${clean}"`);
  }
  function call(name) {
    takeOp("("); // consumed the "("
    const args = [];
    if (!(peek()?.kind === "op" && peek().value === ")")) {
      args.push(expr());
      while (takeKind("comma")) args.push(expr());
    }
    if (!takeOp(")")) throw new Error(`Missing ")" in call "${name}(...)" at ${peek()?.start ?? clean.length} in "${clean}"`);
    return { kind: "call", name, args };
  }
  const ast = expr();
  if (pos < tokens.length)
    throw new Error(`Unexpected "${tokens[pos].value}" at ${tokens[pos].start} in "${clean}"`);
  return ast;
}

const parseCache = new Map(); // src → {ast, refs} (parse is pure; cache is safe)

/**
 * Near-pure function (memoizes into a module cache). Parsed form of an
 * expression: {ast, refs} where refs is the unique reference tokens.
 *
 * @example compiled("speed * 2 + speed").refs // ["speed"]
 */
export function compiled(src) {
  let c = parseCache.get(src);
  if (!c) {
    const ast = parseExpression(src);
    const refs = [];
    const calls = [];
    (function walk(n) {
      if (n.kind === "ref" && !refs.includes(n.name)) refs.push(n.name);
      if (n.kind === "neg") walk(n.arg);
      if (n.kind === "member") walk(n.obj);
      if (n.kind === "call") { calls.push(n); n.args.forEach(walk); }
      if (n.kind === "bin") { walk(n.left); walk(n.right); }
    })(ast);
    parseCache.set(src, (c = { ast, refs, calls }));
  }
  return c;
}

/**
 * Pure function. Evaluates an AST. `lookup(refToken)` supplies reference values
 * (and throws on unknown references); the optional `callFn(name, argAsts,
 * evalArg)` evaluates a function CALL to a POINT value ({x, y}) — a `.x`/`.y`
 * member then projects it. `callFn` receives the raw arg ASTs plus an `evalArg`
 * helper (evaluates a numeric arg with the same lookup) so it can distinguish a
 * WIDGET argument (a bare item ref) from a numeric one. A call/member in an AST
 * with no callFn is a loud error.
 *
 * @example evalAst(parseExpression("2 + x * 3"), () => 4) // 14
 * @example evalAst(parseExpression("-(1 + 1)"), () => 0) // -2
 * @example evalAst(parseExpression("f(a).x"), () => 0, () => ({x: 7, y: 9})) // 7
 */
export function evalAst(ast, lookup, callFn = null) {
  switch (ast.kind) {
    case "num": return ast.value;
    case "ref": return lookup(ast.name);
    case "neg": return -evalAst(ast.arg, lookup, callFn);
    case "member": {
      const pt = evalAstPoint(ast.obj, lookup, callFn);
      return pt[ast.prop];
    }
    case "call":
      // A bare (unprojected) call is a POINT, not a number — the grammar
      // requires a .x/.y projection to use it in arithmetic. Still evaluate it
      // so a genuine solve error surfaces before this message.
      evalCall(ast, lookup, callFn);
      throw new Error(`Function "${ast.name}(...)" returns a point — project it with .x or .y`);
    case "bin": {
      const a = evalAst(ast.left, lookup, callFn);
      const b = evalAst(ast.right, lookup, callFn);
      switch (ast.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
      }
    }
  }
  throw new Error(`Unknown AST node: ${JSON.stringify(ast)}`);
}

/** Pure function. Evaluates a point-valued AST node (a call or a projected-away member's object). */
function evalAstPoint(ast, lookup, callFn) {
  if (ast.kind === "call") return evalCall(ast, lookup, callFn);
  throw new Error(`Only a function call is a point value here (got ${ast.kind})`);
}

/** Pure function. Evaluates a call node to a point via callFn. */
function evalCall(ast, lookup, callFn) {
  if (!callFn) throw new Error(`Function calls need a call handler (got "${ast.name}")`);
  const pt = callFn(ast.name, ast.args, (argAst) => evalAst(argAst, lookup, callFn));
  if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number")
    throw new Error(`Function "${ast.name}" did not return a point`);
  return pt;
}

// ── Function library (dynamic-anchor equation functions) ─────────────────────
//
// The FUNCTIONS table is the registry-driven function library (manifest
// "Dynamic anchors — USER REFINEMENT": "widgets that support dynamic anchoring
// expose functions … registry-driven, not hardcoded in the tokenizer"). Each
// entry lists its OVERLOADS by parameter-kind signature; a "widget" param is an
// item reference (a bare item slug in display form, "@id" in stored form — the
// SAME conversion machinery as any item ref, driven by these kinds so the
// converter and dependency collector know which args are widgets). A "number"
// param is an ordinary numeric sub-expression. Every function returns a POINT
// ({x, y}); the grammar's ".x"/".y" projects it.
//
// The actual SOLVE (nearest point / nearest pair over rim geometry) lives in
// evaluateState's call handler — it needs the folded item states, the plugin
// registry, and the per-pass solve MEMO (so from.x and from.y of one arrow
// share ONE joint solve). This table is pure metadata: signatures + arity +
// autocomplete surface, no engine state.
//
// closest_to_rim:
//   (widget, x, y)     rim-vs-point — the point ON widget's rim nearest (x, y).
//   (widgetA, widgetB) rim-vs-rim   — the point on widgetA's rim of the nearest
//                                     PAIR between the two rims (solved jointly;
//                                     the symmetric call (B, A) gives B's point).

/**
 * The equation function library, keyed by canonical (snake_case) name. Each
 * value: {overloads: [{params: ("widget"|"number")[]}], doc}. Exported as the
 * ONE source of truth for autocomplete (equationFunctionNames) — nothing else
 * enumerates function names.
 */
export const FUNCTIONS = {
  closest_to_rim: {
    doc: "The point on a widget's rim nearest a point, or the nearest-pair point between two rims.",
    overloads: [
      { params: ["widget", "number", "number"] }, // rim vs point
      { params: ["widget", "widget"] },            // rim vs rim (joint solve)
    ],
  },
};

/**
 * Pure function. The function-library names, for equation autocomplete (the ONE
 * exported list — manifest EQUATION DISCOVERABILITY: "expose the function table
 * for equationSuggest"). Each entry is a ready-to-type stub with its first
 * overload's arity, e.g. "closest_to_rim(" — the caller appends args.
 *
 * @example equationFunctionNames() // ["closest_to_rim"]
 */
export function equationFunctionNames() {
  return Object.keys(FUNCTIONS);
}

/**
 * Pure function. Resolves the OVERLOAD of a function call by its argument count,
 * throwing loudly (unknown function / bad arity) — the entry-time and eval-time
 * guard. `name` is the function name; `argCount` the number of args supplied.
 *
 * @example resolveOverload("closest_to_rim", 3).params // ["widget", "number", "number"]
 * @example resolveOverload("closest_to_rim", 2).params // ["widget", "widget"]
 * @example // resolveOverload("nope", 1) throws: Unknown function "nope"
 * @example // resolveOverload("closest_to_rim", 5) throws: "closest_to_rim" has no 5-argument form
 */
export function resolveOverload(name, argCount) {
  const fn = FUNCTIONS[name];
  if (!fn) throw new Error(`Unknown function "${name}"`);
  const overload = fn.overloads.find((o) => o.params.length === argCount);
  if (!overload) {
    const arities = fn.overloads.map((o) => o.params.length).join(" or ");
    throw new Error(`"${name}" has no ${argCount}-argument form (takes ${arities})`);
  }
  return overload;
}

/**
 * Pure function. Is this arg AST a WIDGET reference (a bare item ref, i.e. an
 * identifier token that is NOT a variable / property / anchor / self / call)?
 * A widget arg is a lone `{kind:"ref"}` whose name has no "." (item slug in
 * display form, "@id" in stored form) — anything with a coordinate suffix, a
 * variable, or an arithmetic node is NOT a widget. Used to type-check and
 * resolve widget args against the function signature.
 *
 * @example widgetArgToken({kind: "ref", name: "circle1"}) // "circle1"
 * @example widgetArgToken({kind: "ref", name: "@ab12"}) // "@ab12"
 * @example widgetArgToken({kind: "ref", name: "box.x"}) // null (a property, not a bare widget)
 * @example widgetArgToken({kind: "bin", op: "+"}) // null
 */
export function widgetArgToken(argAst) {
  if (argAst.kind !== "ref") return null;
  return argAst.name.includes(".") ? null : argAst.name;
}

/**
 * Pure function. Resolves a widget-arg token (display slug or stored "@id") to
 * an itemId, throwing if it names no item. `slugs` is a slugMap(state);
 * `selfId` lets `self` name the owner item (a widget arg may be `self`).
 *
 * @example resolveWidgetArg("@ab12", slugMap({items: {ab12: {type: "circle"}}})) // "ab12"
 * @example resolveWidgetArg("box", slugMap({items: {a1: {type: "rect", name: "Box"}}})) // "a1"
 * @example resolveWidgetArg("self", slugMap({items: {}}), "a1") // "a1"
 */
export function resolveWidgetArg(token, slugs, selfId = null) {
  if (token === "self") {
    if (selfId == null) throw new Error(`"self" is only valid in an item's own equation`);
    return selfId;
  }
  if (token.startsWith("@")) {
    const id = token.slice(1);
    return id;
  }
  if (slugs.toId.has(token)) return slugs.toId.get(token);
  throw new Error(`Unknown widget "${token}" — no item with that name`);
}

/**
 * Pure function. The source spans of every WIDGET-argument ref token in an
 * expression (a bare item ref sitting at a "widget"-declared parameter position
 * of a known function call). Returned as a Set of "start:end" keys so the
 * display↔stored converters can rewrite JUST those tokens as item refs
 * (slug↔@id) instead of the default variable treatment. Also VALIDATES arity
 * (resolveOverload throws on unknown functions / bad arity) and that a
 * widget-position arg is actually a bare widget token (not arithmetic).
 *
 * @example widgetArgSpans(parseExpression("closest_to_rim(a, b).x")) // Set { "15:16", "18:19" }
 * @example widgetArgSpans(parseExpression("closest_to_rim(a, 1, 2).x")) // Set { "15:16" } (only the widget param)
 * @example widgetArgSpans(parseExpression("x + 1")) // Set {} (no calls)
 */
export function widgetArgSpans(ast) {
  const spans = new Set();
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.kind === "call") {
      const overload = resolveOverload(n.name, n.args.length); // throws loudly
      n.args.forEach((arg, i) => {
        if (overload.params[i] === "widget") {
          const tok = widgetArgToken(arg);
          if (tok === null) throw new Error(`Argument ${i + 1} of "${n.name}" must be a widget name, not an expression`);
          if (arg.start != null) spans.add(`${arg.start}:${arg.end}`);
        }
        walk(arg);
      });
      return;
    }
    if (n.kind === "neg") walk(n.arg);
    if (n.kind === "member") walk(n.obj);
    if (n.kind === "bin") { walk(n.left); walk(n.right); }
  })(ast);
  return spans;
}

// ── Slugs (identifier naming) ────────────────────────────────────────────────

/**
 * Pure function. One property-path segment, DISPLAY form → STORED form:
 * snake_case → camelCase ("end_width" → "endWidth"). The canonical equation
 * grammar (manifest "EQUATION DISCOVERABILITY — Blender data-path standard")
 * — property segments always DISPLAY snake_case and convert EXPLICITLY at the
 * field boundary, exactly like item refs already convert (@id.x ↔
 * circle_top.x). Single-word segments ("x", "w") round-trip unchanged; this
 * is a bijection with camelToSnake for every stored key actually produced by
 * a plugin (verified by the round-trip test in expressions_test.js).
 *
 * @example snakeToCamel("end_width") // "endWidth"
 * @example snakeToCamel("x") // "x"
 * @example snakeToCamel("rotation_anchor") // "rotationAnchor"
 */
export function snakeToCamel(segment) {
  return segment.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Pure function. One property-path segment, STORED form → DISPLAY form:
 * camelCase → snake_case ("endWidth" → "end_width"). Inverse of
 * snakeToCamel — see its docs for the design rationale.
 *
 * @example camelToSnake("endWidth") // "end_width"
 * @example camelToSnake("x") // "x"
 * @example camelToSnake("rotationAnchor") // "rotation_anchor"
 */
export function camelToSnake(segment) {
  return segment.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Pure function. Item name → identifier slug: lowercase, runs of
 * non-alphanumerics collapse to "_", trimmed; a leading digit gets a "_"
 * prefix (identifiers can't start with a digit); empty names become "item".
 *
 * @example slugify("Circle Top") // "circle_top"
 * @example slugify("2nd Box!") // "_2nd_box"
 * @example slugify("---") // "item"
 */
export function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return "item";
  return /^\d/.test(s) ? `_${s}` : s;
}

/**
 * Pure function. The slug↔itemId maps for a folded state. Named items slug
 * from their name; unnamed items get "<type>_<id-prefix>" (stable across
 * sessions — the id prefix never changes). Collisions dedupe in items-map
 * iteration order (fold order = creation order) by appending _2, _3, ...
 *
 * @example slugMap({items: {ab12cd34: {type: "rect", name: "Box"}}}).toId.get("box") // "ab12cd34"
 * @example slugMap({items: {ab12cd34: {type: "rect"}}}).toSlug.get("ab12cd34") // "rect_ab12"
 */
export function slugMap(state) {
  const toId = new Map();
  const toSlug = new Map();
  for (const [id, item] of Object.entries(state.items ?? {})) {
    // Not-yet-created items (type hasn't folded in — imaginary-slide
    // semantics) are unreferencable: no slug. References to them resolve as
    // unknown and fall back LOUDLY in evaluation — correct, not silent.
    if (typeof item?.type !== "string") continue;
    const base = item.name ? slugify(item.name) : `${item.type}_${id.slice(0, 4)}`;
    let slug = base;
    for (let n = 2; toId.has(slug); n++) slug = `${base}_${n}`;
    toId.set(slug, id);
    toSlug.set(id, slug);
  }
  return { toId, toSlug };
}

/**
 * Pure function. The referencable display name of an anchor —
 * "<itemSlug>_<anchorId>" (what the hover tooltip shows and what the user
 * types before ".x"/".y").
 *
 * @example anchorRefName({items: {ab12cd34: {type: "circle", name: "Moon"}}}, "ab12cd34", "tm") // "moon_tm"
 */
export function anchorRefName(state, itemId, anchorId) {
  return `${slugMap(state).toSlug.get(itemId) ?? itemId}_${anchorId}`;
}

/**
 * Pure function. The canonical EQUATION PATH for a property row — what the
 * GUI reveals through the row-label tooltip and the copy-path affordance
 * (manifest "EQUATION DISCOVERABILITY — Blender data-path standard": "every
 * property row exposes its referencable EQUATION PATH through the GUI").
 * `key` is a plugin inspector row's dotted STORED key ("endWidth",
 * "rotationAnchor.x" — what row.key already is); the result converts every
 * segment to the canonical snake_case display grammar via camelToSnake.
 *
 * Returns BOTH forms: `self` (valid only inside the item's OWN equations —
 * "self.end_width") and `absolute` (valid from anywhere — the item's slug
 * prefixed, "fancy_arrow_8595.end_width"), so a caller can show the short
 * form when inspecting the owner and the long form as a second line.
 *
 * @example canonicalPropPath({items: {a1: {type: "fancy_arrow"}}}, "a1", "endWidth") // {self: "self.end_width", absolute: "fancy_arrow_a1.end_width"}
 * @example canonicalPropPath({items: {a1: {type: "rect", name: "Box"}}}, "a1", "rotationAnchor.x") // {self: "self.rotation_anchor.x", absolute: "box.rotation_anchor.x"}
 */
export function canonicalPropPath(state, itemId, key) {
  const display = pathToDisplay(key.split(".")).join(".");
  const slug = slugMap(state).toSlug.get(itemId) ?? itemId;
  return { self: `self.${display}`, absolute: `${slug}.${display}` };
}

// ── Reference resolution ─────────────────────────────────────────────────────

/**
 * Pure function. Parses a STORED "@"-form reference token.
 *
 * Forms: "@<itemId>.<prop...>" (item property) and "@<itemId>_<anchorId>.x|y"
 * (anchor coordinate). Item ids never contain "_", so the split is
 * unambiguous. Returns {kind: "prop", itemId, path} or
 * {kind: "anchor", itemId, anchorId, coord}.
 *
 * @example parseStoredRef("@ab12cd34.x") // {kind: "prop", itemId: "ab12cd34", path: ["x"]}
 * @example parseStoredRef("@ab12cd34_tm.y") // {kind: "anchor", itemId: "ab12cd34", anchorId: "tm", coord: "y"}
 */
export function parseStoredRef(token) {
  const dot = token.indexOf(".");
  if (dot === -1) throw new Error(`Item reference needs a property: "${token}"`);
  const head = token.slice(1, dot);
  const path = token.slice(dot + 1).split(".");
  const us = head.indexOf("_");
  if (us === -1) return { kind: "prop", itemId: head, path };
  const anchorId = head.slice(us + 1);
  if (path.length !== 1 || (path[0] !== "x" && path[0] !== "y"))
    throw new Error(`Anchor reference must end in .x or .y: "${token}"`);
  return { kind: "anchor", itemId: head.slice(0, us), anchorId, coord: path[0] };
}

/** "center" reads far better than the internal "cm" anchor id in the default
 * rotation pivot self.anchors.center — the two name the same point. */
const CENTER_ANCHOR_ALIAS = "cm";

/**
 * Pure function. Parses a `self.…` reference for the item that OWNS the slot.
 * `selfId` is that owner's itemId (the derivation stage knows it — the
 * expression lives in items.<selfId>.…). `self` is IDENTITY-STABLE: it names
 * the owner directly, so it needs NO document rewrite on rename (unlike a slug
 * reference), and it is stored LITERALLY as "self" (never rewritten to @id).
 *
 * Forms:
 *   self.<prop...>              → {kind: "prop", itemId: selfId, path}
 *   self.anchors.<id>.x|y       → {kind: "anchor", itemId: selfId, anchorId,
 *                                   coord, selfBase: true}
 * "center" is an alias for the "cm" center anchor. selfBase marks the anchor
 * for BASE-FRAME (rotation-zeroed) evaluation: a self anchor used as the
 * rotation pivot must be a FIXED point, not one that spins with the object.
 *
 * @example parseSelfRef("self.w", "a1") // {kind: "prop", itemId: "a1", path: ["w"]}
 * @example parseSelfRef("self.anchors.center.x", "a1") // {kind: "anchor", itemId: "a1", anchorId: "cm", coord: "x", selfBase: true}
 */
export function parseSelfRef(token, selfId) {
  if (selfId == null) throw new Error(`"self" is only valid in an item's own equation: "${token}"`);
  const parts = token.split(".");
  const path = parts.slice(1); // drop "self"
  if (path.length === 0) throw new Error(`"self" needs a property: "${token}"`);
  if (path[0] === "anchors") {
    const coord = path[path.length - 1];
    if (path.length !== 3 || (coord !== "x" && coord !== "y"))
      throw new Error(`Self anchor reference must be self.anchors.<id>.x|y: "${token}"`);
    const anchorId = path[1] === "center" ? CENTER_ANCHOR_ALIAS : path[1];
    return { kind: "anchor", itemId: selfId, anchorId, coord, selfBase: true };
  }
  return { kind: "prop", itemId: selfId, path };
}

/**
 * Pure function. Resolves any reference token (display or stored form) to a
 * descriptor: {kind: "var", name} | {kind: "prop", itemId, path} |
 * {kind: "anchor", itemId, anchorId, coord}. Throws with a helpful message
 * when nothing matches. `slugs` is a slugMap(state). `selfId` (optional) is
 * the owner item's id, enabling `self.…` references.
 *
 * @example resolveRef("speed", slugMap({items: {}})) // {kind: "var", name: "speed"}
 * @example resolveRef("box.x", slugMap({items: {a1: {type: "rect", name: "Box"}}})) // {kind: "prop", itemId: "a1", path: ["x"]}
 * @example resolveRef("box_tm.x", slugMap({items: {a1: {type: "rect", name: "Box"}}})) // {kind: "anchor", itemId: "a1", anchorId: "tm", coord: "x"}
 * @example resolveRef("self.w", slugMap({items: {}}), "a1") // {kind: "prop", itemId: "a1", path: ["w"]}
 */
export function resolveRef(token, slugs, selfId = null) {
  if (token.startsWith("@")) return parseStoredRef(token);
  if (token === "self" || token.startsWith("self.")) return parseSelfRef(token, selfId);
  const [head, ...path] = token.split(".");
  if (path.length === 0) return { kind: "var", name: token };
  if (slugs.toId.has(head)) return { kind: "prop", itemId: slugs.toId.get(head), path };
  const us = head.lastIndexOf("_");
  if (us > 0) {
    const itemSlug = head.slice(0, us);
    if (slugs.toId.has(itemSlug)) {
      if (path.length !== 1 || (path[0] !== "x" && path[0] !== "y"))
        throw new Error(`Anchor reference must end in .x or .y: "${token}"`);
      return { kind: "anchor", itemId: slugs.toId.get(itemSlug), anchorId: head.slice(us + 1), coord: path[0] };
    }
  }
  throw new Error(`Unknown reference "${token}" — no item slug or variable named "${head}"`);
}

/**
 * Pure function. Rewrites an expression's reference tokens via mapToken,
 * preserving all spacing/operators exactly (tokens carry positions).
 *
 * A ref that is a MEMBER PROJECTION coordinate (the `x`/`y` right after a
 * standalone "." — e.g. the `.x` in `f(a).x`) is GRAMMAR, not a reference, so
 * it is left verbatim (the mapper is never called for it). A function NAME ref
 * (before "(") IS passed to the mapper — the mapper decides what to do with it
 * (displayToStored/storedToDisplay pass known function names through verbatim).
 *
 * @example mapRefTokens("a + b", (t) => t.toUpperCase()) // "A + B"
 * @example mapRefTokens("f(a).x", (t) => t.toUpperCase()) // "F(A).x" (name + arg mapped; the projection .x is grammar, untouched)
 * @example mapRefTokens("a + b", (v, tok) => `${v}@${tok.start}`) // "a@0 + b@4" (mapper gets the token for its span)
 */
export function mapRefTokens(src, mapToken) {
  let out = "";
  let last = 0;
  const tokens = tokenize(src);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "ref") continue;
    if (tokens[i - 1]?.kind === "dot") continue; // member projection coord (.x/.y): grammar, not a ref
    out += src.slice(last, t.start) + mapToken(t.value, t);
    last = t.end;
  }
  return out + src.slice(last);
}

/**
 * Pure function. True iff every char of `segment` is lowercase/digit/"_" —
 * i.e. it could not possibly be anything but snake_case. This is the guard
 * that keeps snakeToCamel from silently ACCEPTING camelCase input: a
 * camelCase segment has no "_" for snakeToCamel to act on, so it round-trips
 * as itself and would otherwise pass an existence check by accident (the
 * exact silent-aliasing the manifest ruling vetoes). Rejecting any uppercase
 * letter up front makes "is this canonical" a property of the TEXT the user
 * typed, not of whether it happens to already match a stored key.
 *
 * @example isCanonicalSegment("end_width") // true
 * @example isCanonicalSegment("endWidth") // false
 * @example isCanonicalSegment("x") // true
 */
function isCanonicalSegment(segment) {
  return !/[A-Z]/.test(segment);
}

/**
 * Pure function. Throws unless every DISPLAY path segment is canonical
 * snake_case — the ENTRY-TIME "unknown property" guard (mirrors the existing
 * "Unknown variable" typo protection in displayToStored, at the same
 * boundary). Rejects camelCase input even when it happens to name a real key
 * (isCanonicalSegment) — ONE canonical form, no tolerant aliasing: a
 * camelCase identifier IS an unknown identifier in this grammar, exactly
 * like a misspelled slug is. Existence of the property itself (does the item
 * actually HAVE this key) is left to evaluateState's existing "has no
 * property" check — same division of labor as anchor refs, which
 * displayToStored also doesn't verify against a real plugin (only
 * evaluateState does); duplicating that check here would need the folded
 * item's FULL default-filled shape, which isn't guaranteed at this boundary
 * (e.g. slug-resolution-only call sites use minimal item shapes). `path` is
 * the segments the user typed; `displayToken` is the whole token, for the
 * error message.
 *
 * @example checkCanonicalPath(["end_width"], "self.end_width") // undefined (no throw)
 * @example // checkCanonicalPath(["endWidth"], "self.endWidth") throws: Unknown property "endWidth" (self.endWidth) — not canonical snake_case
 */
function checkCanonicalPath(path, displayToken) {
  const bad = path.find((seg) => !isCanonicalSegment(seg));
  if (bad !== undefined) throw new Error(`Unknown property "${bad}" (${displayToken}) — not canonical snake_case`);
}

/**
 * Pure function. Splits a `self.…` token's path into its two grammars:
 * `self.anchors.<id>.x|y` (STRUCTURAL — "anchors" and the anchor id are not
 * plugin properties, so segments are never case-converted) vs `self.<prop…>`
 * (an ordinary property path, case-converted like any other). Delegates the
 * actual parse to parseSelfRef with a placeholder owner id ("self" is never a
 * real itemId, so it never collides) — this function only needs the SHAPE of
 * the reference, not a real owner (display↔stored conversion has no owner to
 * resolve against; only evaluation does).
 *
 * @example selfRefShape("self.end_width") // {kind: "prop", path: ["end_width"]}
 * @example selfRefShape("self.anchors.center.x") // {kind: "anchor"}
 */
function selfRefShape(token) {
  const d = parseSelfRef(token, "self");
  return d.kind === "prop" ? { kind: "prop", path: d.path } : { kind: "anchor" };
}

/**
 * Pure function. Property-path segments, DISPLAY form → STORED form, applying
 * snakeToCamel per segment ("end_width" → "endWidth", "rotation_anchor.x" →
 * "rotationAnchor.x") — the canonical grammar's per-segment bijection over a
 * whole dotted path.
 *
 * @example pathToStored(["end_width"]) // ["endWidth"]
 * @example pathToStored(["rotation_anchor", "x"]) // ["rotationAnchor", "x"]
 */
function pathToStored(path) {
  return path.map(snakeToCamel);
}

/**
 * Pure function. Property-path segments, STORED form → DISPLAY form, applying
 * camelToSnake per segment. Inverse of pathToStored.
 *
 * @example pathToDisplay(["endWidth"]) // ["end_width"]
 * @example pathToDisplay(["rotationAnchor", "x"]) // ["rotation_anchor", "x"]
 */
function pathToDisplay(path) {
  return path.map(camelToSnake);
}

/**
 * Pure function. Display form → stored form: item slugs become @itemIds
 * (variables stay bare), and property-path segments convert snake_case →
 * camelCase (the canonical grammar — manifest "EQUATION DISCOVERABILITY").
 * Throws on syntax errors, unresolvable slugs, UNKNOWN VARIABLES, and UNKNOWN
 * PROPERTIES (typo protection at entry time — ONE canonical form; a typed
 * camelCase property name is NOT silently accepted, it resolves as an unknown
 * snake_case identifier and errors) — the equation field surfaces the throw
 * as its invalid affordance. A leading "=" (spreadsheet affordance) is
 * stripped.
 *
 * `self.…` tokens are IDENTITY-STABLE (they name the owner, not a slug) and
 * the `self`/`self.anchors.<id>` structure is stored VERBATIM (no @id
 * rewrite, so it survives renames untouched) — but a `self.<prop...>` path's
 * segments still convert, same as any other property reference.
 *
 * @example displayToStored("box.x + 10", {items: {a1: {type: "rect", name: "Box"}}}) // "@a1.x + 10"
 * @example displayToStored("speed * 2", {vars: {speed: 5}, items: {}}) // "speed * 2"
 * @example displayToStored("self.end_width / 2", {items: {}}) // "self.endWidth / 2"
 * @example displayToStored("closest_to_rim(box, c).x", {items: {a1: {type: "rect", name: "Box"}, a2: {type: "circle", name: "C"}}}) // "closest_to_rim(@a1, @a2).x"
 * @example // displayToStored("sped * 2", {vars: {speed: 5}}) throws: Unknown variable "sped"
 * @example // displayToStored("self.endWidth", {items: {}}) throws: Unknown property "endWidth" (self.endWidth) — camelCase is not accepted, one canonical form only
 */
export function displayToStored(src, state) {
  const clean = src.replace(/^\s*=\s*/, "");
  const ast = parseExpression(clean); // validate the full grammar, not just the tokens
  const wSpans = widgetArgSpans(ast); // validates function arity/kinds; marks widget-arg tokens
  const slugs = slugMap(state);
  return mapRefTokens(clean, (token, tok) => {
    // A function NAME (a ref immediately followed by "(") stays verbatim —
    // it is grammar, not a reference; widgetArgSpans already validated it.
    if (token in FUNCTIONS && clean[tok.end] === "(") return token;
    // A WIDGET argument: a bare item slug → "@id" (or verbatim "self").
    if (wSpans.has(`${tok.start}:${tok.end}`)) {
      if (token === "self") return token;
      const id = resolveWidgetArg(token, slugs); // throws on unknown widget
      return `@${id}`;
    }
    if (token === "self" || token.startsWith("self.")) {
      const shape = selfRefShape(token); // throws "needs a property" on bare "self"
      if (shape.kind !== "prop") return token; // self.anchors.<id>.x|y: structural, stored verbatim
      checkCanonicalPath(shape.path, token);
      return `self.${pathToStored(shape.path).join(".")}`;
    }
    const d = resolveRef(token, slugs); // throws on unknown refs
    if (d.kind === "var") {
      if (!(d.name in (state.vars ?? {}))) throw new Error(`Unknown variable "${d.name}"`);
      return token;
    }
    if (d.kind === "prop") {
      checkCanonicalPath(d.path, token);
      return `@${d.itemId}.${pathToStored(d.path).join(".")}`;
    }
    return `@${d.itemId}_${d.anchorId}.${d.coord}`;
  });
}

/**
 * Pure function. Stored form → display form: @itemIds become current slugs,
 * and property-path segments convert camelCase → snake_case (the inverse of
 * displayToStored's pathToStored — see its docs). This is what makes
 * PRE-EXISTING stored equations (authored before this canonical grammar
 * landed, or hand-written) render in the canonical display grammar the first
 * time the field shows them — no migration needed, since storage was already
 * camelCase (the plugin's native key spelling). Unknown ids (purged items)
 * are left in @-form so the user can still see and fix the reference. Never
 * throws on resolvable syntax; malformed sources are returned unchanged (the
 * error affordance reports them).
 *
 * @example storedToDisplay("@a1.x + 10", {items: {a1: {type: "rect", name: "Box"}}}) // "box.x + 10"
 * @example storedToDisplay("@a1_tm.y", {items: {a1: {type: "rect", name: "Box"}}}) // "box_tm.y"
 * @example storedToDisplay("@a1.endWidth", {items: {a1: {type: "fancy_arrow", name: "Arrow"}}}) // "arrow.end_width"
 * @example storedToDisplay("self.rotationAnchor.x") // "self.rotation_anchor.x"
 * @example storedToDisplay("closest_to_rim(@a1, @a2).x", {items: {a1: {type: "rect", name: "Box"}, a2: {type: "circle", name: "C"}}}) // "closest_to_rim(box, c).x"
 */
export function storedToDisplay(src, state) {
  const slugs = slugMap(state);
  let tokens;
  try {
    tokens = tokenize(src);
  } catch {
    return src; // malformed stays visible verbatim; evaluateState reports it
  }
  // Widget-arg token spans (bare "@id" at a widget param position). Best-effort:
  // if the source doesn't parse, wSpans stays empty and bare @ids fall through
  // to parseStoredRef's error path (kept verbatim), exactly as before.
  let wSpans = new Set();
  try {
    wSpans = widgetArgSpans(parseExpression(src));
  } catch {
    // unparseable / unknown function — no widget-arg rewrites, verbatim fallback
  }
  let out = "";
  let last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "ref") continue;
    if (tokens[i - 1]?.kind === "dot") continue; // member projection coord (.x/.y): grammar, unchanged
    let mapped = t.value;
    if (wSpans.has(`${t.start}:${t.end}`) && t.value.startsWith("@")) {
      // A widget argument stored as a bare "@id" → its current slug.
      const slug = slugs.toSlug.get(t.value.slice(1));
      if (slug) mapped = slug; // unknown id stays "@id" verbatim (purged widget)
    } else if (t.value.startsWith("@")) {
      try {
        const d = parseStoredRef(t.value);
        const slug = slugs.toSlug.get(d.itemId);
        if (slug) mapped = d.kind === "prop" ? `${slug}.${pathToDisplay(d.path).join(".")}` : `${slug}_${d.anchorId}.${d.coord}`;
      } catch {
        // Unparseable @token: keep it verbatim (evaluateState reports it).
      }
    } else if (t.value === "self" || t.value.startsWith("self.")) {
      try {
        const shape = selfRefShape(t.value);
        if (shape.kind === "prop") mapped = `self.${pathToDisplay(shape.path).join(".")}`;
        // self.anchors.<id>.x|y: structural, shown verbatim.
      } catch {
        // Malformed self ref (e.g. bare "self"): keep it verbatim (evaluateState reports it).
      }
    } else {
      continue; // bare variable name: unchanged
    }
    out += src.slice(last, t.start) + mapped;
    last = t.end;
  }
  return out + src.slice(last);
}

// ── Equation slots ───────────────────────────────────────────────────────────

/**
 * Pure function. Is this (possibly nested) item property a NUMERIC slot —
 * i.e. may a string stored there be treated as an equation? True iff the
 * plugin's default for the path is a NUMBER, or a COMPUTED-DEFAULT equation
 * string (one beginning with "self." — e.g. rotationAnchor.x defaults to
 * "self.anchors.center.x"). The "self." form is the ONLY string default that
 * is itself an equation; every label/color default (name "Text", fill
 * "#7aa2f7") is a plain string that is NOT self-prefixed, so this stays
 * structural (derived from the default's form) with no per-plugin annotations
 * — the rule that keeps name/text/fill out of the expression system holds.
 *
 * @example isNumericSlot({defaults: {x: 100, name: "?"}}, ["x"]) // true
 * @example isNumericSlot({defaults: {name: "?"}}, ["name"]) // false
 * @example isNumericSlot({defaults: {from: {x: 0}}}, ["from", "x"]) // true
 * @example isNumericSlot({defaults: {rotationAnchor: {x: "self.anchors.center.x"}}}, ["rotationAnchor", "x"]) // true
 */
export function isNumericSlot(plugin, path) {
  const def = getPath(plugin.defaults, path);
  if (typeof def === "number") return true;
  return typeof def === "string" && def.startsWith("self.");
}

/**
 * Pure function. Every referencable equation path on a plugin's own
 * properties, in CANONICAL DISPLAY (snake_case, dot-joined) form — the
 * candidate list for the autocomplete AND the discoverability guarantee's
 * source of truth: only isNumericSlot leaves are offered, so what's typeable
 * is exactly what's referenceable ("if a name can be referenced, the GUI
 * reveals it" — manifest). Walks plugin.defaults (leaves(), core/deltas.js)
 * rather than a live item's state, so it lists what EVERY instance of the
 * type offers, independent of any particular item's current values.
 *
 * @example numericPropertyPaths(rectPlugin) // ["x", "y", "w", "h", "z", "rotation", "scale", "rotation_anchor.x", "rotation_anchor.y", "stroke_width", "corner_radius", "opacity"]
 * @example numericPropertyPaths(fancyArrowPlugin) // [..., "start_width", "end_width"] (camelCase startWidth/endWidth shown as snake_case)
 */
export function numericPropertyPaths(plugin) {
  const out = [];
  for (const [path] of leaves(plugin.defaults))
    if (isNumericSlot(plugin, path)) out.push(pathToDisplay(path).join("."));
  return out;
}

/** Command (mutates tree in place). Sets a leaf at path, creating nodes. */
function mutSetPath(tree, path, value) {
  let cur = tree;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isTree(cur[path[i]])) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

// ── Rim solving (dynamic-anchor functions + the `closest` sugar) ─────────────
//
// The point ON a widget's rim, generic over rim geometry: every bbox plugin
// exposes closestAnchor(state, worldX, worldY, world) returning the LOCAL rim
// point nearest a world target, evaluated through the item's PAINTED transform
// (worldTransform — rotation pivoted about rotationAnchor, so a rotated rim
// resolves on the visible rim). rimProjector wraps that into a world→world
// closest-point map — the exact interface outline.nearestRimPair consumes, so
// circle / rect / rounded-rect / crop box / future custom outlines all solve
// through ONE path with no per-shape branch here.

/** Pure function. The world-space CENTER of a bbox item (its rim's facing-seed hint). */
function rimCenter(item) {
  return T.apply(worldTransform(item), (item.w ?? 0) / 2, (item.h ?? 0) / 2);
}

/**
 * Pure function (closure over the item's evaluated state). A world→world
 * closest-point map for one widget's rim: (qx, qy) → the world rim point nearest
 * (qx, qy). Throws if the plugin has no closestAnchor (not a rim widget).
 */
function rimProjector(item, plugin) {
  if (!plugin.closestAnchor) throw new Error(`"${item.type}" has no rim (no closestAnchor) for closest_to_rim`);
  const world = worldTransform(item);
  return (qx, qy) => {
    const local = plugin.closestAnchor(item, qx, qy, world);
    return T.apply(world, local.x, local.y);
  };
}

/**
 * Pure function. If the `toward` endpoint (the arrow's OTHER endpoint, as
 * returned by closestToward — an {x, y} whose coords may be equation strings) is
 * ITSELF a closest-rim reference to some item, returns that item's id — the
 * mutual-closest case, which routes to the JOINT nearest-pair solve. Otherwise
 * null (an ordinary point target → rim-vs-point). It suffices to inspect the x
 * coordinate: the writer (CanvasView / migration) always writes the pair
 * `@id_closest.x` / `@id_closest.y` together.
 *
 * @example closestPartnerRimId({x: "@c2_closest.x", y: "@c2_closest.y"}, {toId: new Map(), toSlug: new Map()}) // "c2"
 * @example closestPartnerRimId({x: 100, y: 50}, {toId: new Map()}) // null (a plain point)
 */
function closestPartnerRimId(toward, slugs) {
  if (!toward || typeof toward.x !== "string") return null;
  let d;
  try {
    d = resolveRef(toward.x.replace(/^\s*=\s*/, "").trim(), slugs);
  } catch {
    return null; // not a resolvable ref → treat as a point target
  }
  return d.kind === "anchor" && d.anchorId === "closest" ? d.itemId : null;
}

/**
 * Pure function. The key (e.g. "from"/"to") of the endpoint OBJECT `toward`
 * within the owner item's state, by object identity — so a rim-vs-point closest
 * can depend on that endpoint's own coordinate slots. Returns null if `toward`
 * isn't one of the owner's own endpoint objects (defensive; then the caller
 * simply adds no toward dependency).
 *
 * @example // owner = {from: {x:1,y:2}, to: {x:3,y:4}}; siblingEndpointKey(owner, owner.to) === "to"
 */
function siblingEndpointKey(owner, toward) {
  for (const [key, value] of Object.entries(owner ?? {}))
    if (value === toward) return key;
  return null;
}

// ── Evaluation (the derivation-stage expression pass) ────────────────────────

const evalMemo = new WeakMap(); // state object → {registry, result}
// The geometry a base-frame self anchor (rotation pivot) reads — never
// rotation or rotationAnchor, so the pivot is a stable fixed point.
const SELF_ANCHOR_DEP_PROPS = new Set(["x", "y", "w", "h", "scale"]);

/**
 * Near-pure function (memoized on state identity; console.errors each NEW
 * error message once — never silently). THE derivation-stage expression
 * pass: folded state → same-shaped state with every equation slot replaced
 * by its evaluated number, plus an error map.
 *
 * Returns {state, errors} where errors maps "items.a1.x"-style joined paths
 * to human messages. Errored slots (syntax errors, unknown references,
 * cycles, non-finite results) fall back to the plugin default for the key
 * (0 for variables) — deterministic, never a silent NaN; the UI renders the
 * error affordance from the map.
 *
 * Dependency rules:
 *   - variable ref  → that vars slot (if it is itself an equation)
 *   - property ref  → that item-property slot (if it is an equation)
 *   - anchor ref    → ALL equation slots of the referenced item
 *     (conservative: anchors read the item's transform + bbox)
 *   - closest_to_rim(W, x, y) / a `@id_closest` ref toward a plain point →
 *     depends on W's geometry slots + the toward point's own slots (the
 *     point is a RIM-VS-POINT projection, so the point must evaluate first)
 *   - closest_to_rim(A, B) / a MUTUAL `@id_closest` pair → depends on BOTH
 *     rims' geometry slots and NOTHING else. The nearest PAIR is solved
 *     jointly from the two rims' GEOMETRY, so the two endpoints do NOT depend
 *     on each other — no fixpoint, no wobble (manifest USER REFINEMENT: "the
 *     rim-vs-rim solver computes the nearest PAIR internally as ONE joint
 *     problem … kills the observed mutual-closest wobble"). Identical solves
 *     within one pass are MEMOIZED, so from.x/from.y (and the symmetric
 *     to-side call) share ONE solve.
 *
 * @example evaluateState({vars: {speed: 5}, items: {a1: {type: "rect", x: "speed * 2"}}}, registry).state.items.a1.x // 10
 * @example // Cycle: {vars: {a: "b", b: "a"}} → errors.get("vars.a") mentions the cycle; values fall back to 0
 */
export function evaluateState(state, registry) {
  const memo = evalMemo.get(state);
  if (memo && memo.registry === registry) return memo.result;
  const result = computeEvaluatedState(state, registry);
  evalMemo.set(state, { registry, result });
  return result;
}

/** Pure-core of evaluateState (see its docs); uncached. */
function computeEvaluatedState(state, registry) {
  const out = copied(state);
  const errors = new Map();
  const slugs = slugMap(state);
  const slots = new Map(); // key ("items.a1.x") → slot

  const fallbackFor = (path) => {
    if (path[0] !== "items") return 0; // variables have no plugin defaults
    const item = state.items[path[1]];
    return getPath(registry.get(item.type).defaults, path.slice(2)) ?? 0;
  };
  const fail = (slot, message) => {
    errors.set(slot.key, message);
    mutSetPath(out, slot.path, fallbackFor(slot.path));
    // Dedupe on the message, print the slot-prefixed line (core/report.js
    // documents the once-per-session throttle semantics).
    reportOnce(message, `PowerRP expression error at ${slot.key}: ${message}`);
  };

  // 1. Collect equation slots (string-valued numeric leaves).
  for (const [name, value] of Object.entries(state.vars ?? {}))
    if (typeof value === "string")
      slots.set(`vars.${name}`, { key: `vars.${name}`, path: ["vars", name], src: value });
  for (const [id, item] of Object.entries(state.items ?? {})) {
    // An item whose `type` hasn't folded in yet DOES NOT EXIST YET (the
    // imaginary-slide semantics) — legitimate mid-document state when a
    // creation slide sits BELOW a slide that keyframes the item (e.g. after
    // Move Slide Down; Opus3's 3-keystroke crash repro). Skip, never throw:
    // it "exists" again on folds that include its creation delta.
    if (typeof item?.type !== "string") continue;
    const plugin = registry.get(item.type);
    for (const [path, value] of leaves(item))
      if (typeof value === "string" && isNumericSlot(plugin, path)) {
        const key = ["items", id, ...path].join(".");
        slots.set(key, { key, path: ["items", id, ...path], src: value });
      }
  }

  // 2. Parse + resolve references → dependency edges.
  const itemSlotKeys = new Map(); // itemId → [slot keys] (for anchor deps)
  for (const slot of slots.values())
    if (slot.path[0] === "items") {
      if (!itemSlotKeys.has(slot.path[1])) itemSlotKeys.set(slot.path[1], []);
      itemSlotKeys.get(slot.path[1]).push(slot.key);
    }
  for (const slot of [...slots.values()]) {
    slot.deps = new Set();
    slot.descriptors = new Map(); // ref token → descriptor
    // `self` resolves to the item that OWNS this slot (its equations live in
    // items.<selfId>.…). Variable slots have no self (self is meaningless
    // there); a `self.…` token in a variable throws, reported per-slot.
    const selfId = slot.path[0] === "items" ? slot.path[1] : null;
    // Depend on ALL of an item's equation slots (its transform + bbox) — the
    // conservative geometry dependency anchors and rim solves need.
    const dependOnItemGeometry = (itemId) => {
      for (const depKey of itemSlotKeys.get(itemId) ?? [])
        if (depKey !== slot.key) slot.deps.add(depKey);
    };
    try {
      const { ast, refs, calls } = compiled(slot.src);
      slot.ast = ast;
      // A) Function CALLS (closest_to_rim, …): validate arity/kinds, resolve
      //    widget args, and depend on each widget's geometry. The joint solve
      //    reads only rim GEOMETRY, so a mutual pair's two endpoints never
      //    depend on each other — that is what removes the fixpoint. (The eval
      //    handler re-resolves widget ids from the AST + slugs; this pass only
      //    needs the DEPS and the entry-time validation, not stored ids.)
      const widgetArgNames = new Set(); // widget-arg tokens: handled here, skipped in the refs loop
      for (const c of calls) {
        const overload = resolveOverload(c.name, c.args.length); // loud on unknown fn / bad arity
        c.args.forEach((arg, i) => {
          if (overload.params[i] !== "widget") return;
          const tok = widgetArgToken(arg);
          if (tok === null) throw new Error(`Argument ${i + 1} of "${c.name}" must be a widget name`);
          widgetArgNames.add(tok);
          const wid = resolveWidgetArg(tok, slugs, selfId);
          const witem = state.items?.[wid];
          if (!witem || typeof witem.type !== "string") throw new Error(`Unknown widget "${tok}" in "${c.name}(…)"`);
          const wplugin = registry.get(witem.type);
          if (!wplugin.closestAnchor) throw new Error(`"${slugs.toSlug.get(wid) ?? wid}" has no rim (no closestAnchor) for ${c.name}`);
          dependOnItemGeometry(wid);
        });
      }
      for (const token of refs) {
        // A widget-argument token (a bare item name inside a call) is resolved
        // in the calls block above; skip it here UNLESS the same identifier also
        // resolves to a variable (a name used both as a widget and a variable —
        // pathological but possible), in which case it still needs its var dep.
        // resolveRef of a bare item slug throws (no such var), so this check
        // cleanly keeps genuine variables and drops pure widget names.
        if (widgetArgNames.has(token)) {
          if (!(token in (state.vars ?? {}))) continue; // pure widget name — handled by the calls block
        }
        const d = resolveRef(token, slugs, selfId);
        slot.descriptors.set(token, d);
        if (d.kind === "var") {
          if (!(d.name in (state.vars ?? {})))
            throw new Error(`Unknown variable "${d.name}"`);
          if (slots.has(`vars.${d.name}`)) slot.deps.add(`vars.${d.name}`);
        } else if (d.kind === "prop") {
          const item = state.items?.[d.itemId];
          if (!item) throw new Error(`Unknown item "@${d.itemId}" in "${token}"`);
          const raw = getPath(item, d.path);
          if (raw === undefined) throw new Error(`Item "${slugs.toSlug.get(d.itemId)}" has no property "${d.path.join(".")}"`);
          const depKey = ["items", d.itemId, ...d.path].join(".");
          if (typeof raw === "string" && !slots.has(depKey))
            throw new Error(`"${token}" is not a numeric property`);
          if (slots.has(depKey)) slot.deps.add(depKey);
        } else {
          // anchor
          const item = state.items?.[d.itemId];
          if (!item) throw new Error(`Unknown item "@${d.itemId}" in "${token}"`);
          const plugin = registry.get(item.type);
          if (d.anchorId === "closest") {
            // The `@id_closest` sugar. Route to the rim solver: rim-vs-point
            // toward the arrow's OTHER endpoint, or (when that endpoint is also
            // a closest ref to another rim) the JOINT rim-vs-rim nearest pair.
            if (!plugin.closestAnchor)
              throw new Error(`"${slugs.toSlug.get(d.itemId)}" has no computed closest anchor`);
            const owner = state.items?.[selfId];
            const ownerPlugin = selfId != null && typeof owner?.type === "string" ? registry.get(owner.type) : null;
            const toward = ownerPlugin?.closestToward?.(owner, slot.path.slice(2));
            if (!toward)
              throw new Error(`"closest" anchor needs a toward context — only widgets with a closestToward hook (arrows) can use it`);
            const otherRimId = closestPartnerRimId(toward, slugs); // set if the other endpoint is itself a closest ref
            d.otherRimId = otherRimId; // read at eval time to pick joint vs point solve
            dependOnItemGeometry(d.itemId); // this rim's geometry
            if (otherRimId) {
              dependOnItemGeometry(otherRimId); // the other rim's geometry (mutual: JOINT solve)
            } else {
              // Rim-vs-point: the toward endpoint's coordinates feed the
              // projection, so they must evaluate FIRST. Find the sibling
              // endpoint's key by object identity against the owner's state,
              // and depend on its x/y equation slots (plain-number coords have
              // no slot — nothing to wait on).
              const siblingKey = siblingEndpointKey(owner, toward);
              if (siblingKey)
                for (const k of ["x", "y"]) {
                  const towardKey = `items.${selfId}.${siblingKey}.${k}`;
                  if (slots.has(towardKey)) slot.deps.add(towardKey);
                }
            }
          } else {
            if (!(plugin.anchors?.(item) ?? []).some((a) => a.id === d.anchorId))
              throw new Error(`"${slugs.toSlug.get(d.itemId)}" has no anchor "${d.anchorId}"`);
            // A self anchor (rotation pivot) evaluates in the ROTATION-ZEROED base
            // frame from geometry only (x,y,w,h,scale) — never rotation or the
            // rotationAnchor slots — so it depends only on those geometry slots,
            // NOT conservatively on all of the owner's slots. This keeps the
            // default rotationAnchor {x,y} (both = self center) from spuriously
            // depending on each other (which would be a false cycle) and never
            // pivots the pivot on itself.
            const baseKeys = d.selfBase
              ? (itemSlotKeys.get(d.itemId) ?? []).filter((k) => SELF_ANCHOR_DEP_PROPS.has(k.split(".")[2]))
              : (itemSlotKeys.get(d.itemId) ?? []);
            for (const depKey of baseKeys)
              if (depKey !== slot.key) slot.deps.add(depKey);
          }
        }
      }
    } catch (e) {
      fail(slot, e.message);
      slots.delete(slot.key);
    }
  }

  // 3. Rim-solve MEMO (per evaluation pass). Keyed by a canonical string so
  //    from.x and from.y of one closest ref share ONE solve, and the two
  //    symmetric endpoints of a mutual pair share the SAME nearest-pair solve
  //    (each reading its own side). This is what makes both endpoints land on
  //    the true nearest pair with zero wobble across re-evaluations: the answer
  //    is a deterministic function of the two rims' geometry, computed once.
  const pairMemo = new Map(); // "pair:<idLo>|<idHi>" → {lo, hi} (world points, by sorted id)
  const pointMemo = new Map(); // "pt:<rimId>:<tx>:<ty>" → world point
  let capHit = false;
  const solvePair = (idA, idB) => {
    const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
    const memoKey = `pair:${lo}|${hi}`;
    let pair = pairMemo.get(memoKey);
    if (!pair) {
      const loItem = out.items[lo], hiItem = out.items[hi];
      const loPlug = registry.get(loItem.type), hiPlug = registry.get(hiItem.type);
      const projLo = rimProjector(loItem, loPlug), projHi = rimProjector(hiItem, hiPlug);
      const res = nearestRimPair(projLo, projHi, { seedA: rimCenter(loItem), seedB: rimCenter(hiItem) });
      if (!res.converged) capHit = true;
      pair = { lo: res.a, hi: res.b };
      pairMemo.set(memoKey, pair);
    }
    return idA === lo ? pair.lo : pair.hi; // the point on idA's rim
  };
  const solvePoint = (rimId, tx, ty) => {
    const memoKey = `pt:${rimId}:${tx}:${ty}`;
    let pt = pointMemo.get(memoKey);
    if (!pt) {
      const item = out.items[rimId];
      pt = rimProjector(item, registry.get(item.type))(tx, ty);
      pointMemo.set(memoKey, pt);
    }
    return pt;
  };

  // Function-call handler: `closest_to_rim` returns a POINT ({x, y}). Widget
  // args are resolved by position from the arg ASTs (dep collection already
  // validated arity/kinds); numeric args evaluate via the arithmetic lookup.
  // Overloads: (widget, x, y) → rim-vs-point; (widgetA, widgetB) → the point on
  // widgetA's rim of the joint nearest pair.
  const selfIdFor = (slot) => (slot.path[0] === "items" ? slot.path[1] : null);
  const callFor = (slot) => (name, argAsts, evalArg) => {
    const overload = resolveOverload(name, argAsts.length); // loud on unknown fn / bad arity
    // Resolve widget ids by position (dep-time already validated arity/kinds).
    const widgetIds = [];
    const nums = [];
    argAsts.forEach((arg, i) => {
      if (overload.params[i] === "widget")
        widgetIds.push(resolveWidgetArg(widgetArgToken(arg), slugs, selfIdFor(slot)));
      else nums.push(evalArg(arg));
    });
    if (overload.params.length === 3) return solvePoint(widgetIds[0], nums[0], nums[1]); // rim vs point
    return solvePair(widgetIds[0], widgetIds[1]); // rim vs rim (joint)
  };

  // 3b. Evaluation lookup (reads the evolving `out` state).
  const lookupFor = (slot) => (token) => {
    const d = slot.descriptors.get(token);
    if (d.kind === "var") return out.vars[d.name];
    if (d.kind === "prop") return getPath(out.items[d.itemId], d.path);
    const item = out.items[d.itemId];
    const plugin = registry.get(item.type);
    if (d.anchorId === "closest") {
      // The `@id_closest` sugar → the rim solver. Mutual (the other endpoint is
      // itself a closest ref to another rim) → JOINT nearest pair; otherwise the
      // rim-vs-point projection toward the arrow's evaluated other endpoint.
      // Mutual: the joint solve reads only geometry (memoized, so from.x/from.y
      // and the symmetric to-side share ONE solve) — no toward context needed.
      if (d.otherRimId) return solvePair(d.itemId, d.otherRimId)[d.coord];
      const owner = getPath(out, slot.path.slice(0, 2));
      const ownerPlugin = slot.path[0] === "items" ? registry.get(owner.type) : null;
      const toward = ownerPlugin?.closestToward?.(owner, slot.path.slice(2));
      if (!toward)
        throw new Error(`"closest" anchor needs a toward context — only widgets with a closestToward hook (arrows) can use it`);
      const tx = typeof toward.x === "number" ? toward.x : 0;
      const ty = typeof toward.y === "number" ? toward.y : 0;
      return solvePoint(d.itemId, tx, ty)[d.coord];
    }
    // WHICH FRAME a preset anchor maps through:
    //   selfBase (a self.anchors.<id> used as the rotation pivot): the
    //     ROTATION-ZEROED base frame — the pivot must be a FIXED point, not one
    //     that spins with the object (self.anchors.center of a rotated box is
    //     its geometric center).
    //   otherwise (a CROSS-ITEM ref like box.anchors.tr): the item's PAINTED
    //     transform = worldTransform(item), which pivots the rotation about the
    //     item's rotationAnchor exactly as derive.js paints it (registry #2).
    const world = d.selfBase ? { ...T.fromState(item), rotation: 0 } : worldTransform(item);
    const anchor = plugin.anchors(item).find((a) => a.id === d.anchorId);
    return T.apply(world, anchor.x, anchor.y)[d.coord];
  };
  const evalSlot = (slot) => {
    try {
      const v = evalAst(slot.ast, lookupFor(slot), callFor(slot));
      if (!Number.isFinite(v)) throw new Error(`evaluates to ${v}`);
      mutSetPath(out, slot.path, v);
    } catch (e) {
      fail(slot, e.message);
    }
  };

  // 4. Kahn topo sort + evaluate. Dep errors don't block consumers — the
  //    errored dep already holds its fallback number (reported at its source).
  //    Prune deps that point to a slot which FAILED resolution and was deleted
  //    from `slots` (e.g. a rotation anchor reading a sibling w that has a bad
  //    reference): that dep already carries its fallback in `out`, so the edge
  //    is dropped — otherwise its indegree could never reach 0 and Kahn would
  //    stall, misreporting the survivor as a cycle.
  for (const slot of slots.values())
    slot.deps = new Set([...slot.deps].filter((dep) => slots.has(dep)));
  const dependents = new Map(); // key → [keys that depend on it]
  const indegree = new Map();
  for (const slot of slots.values()) indegree.set(slot.key, slot.deps.size);
  for (const slot of slots.values())
    for (const dep of slot.deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(slot.key);
    }
  const remaining = new Set(slots.keys());
  const queue = [...slots.values()].filter((s) => s.deps.size === 0).map((s) => s.key);
  const settle = (key) => {
    remaining.delete(key);
    for (const next of dependents.get(key) ?? []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  };
  for (;;) {
    while (queue.length) {
      const key = queue.shift();
      if (!remaining.has(key)) continue; // already settled (failed cycle member)
      evalSlot(slots.get(key));
      settle(key);
    }
    if (remaining.size === 0) break;
    // 5. A CYCLE blocks progress: fail exactly the slots ON the cycle (loud
    //    error naming the chain), then resume — slots merely DOWNSTREAM of a
    //    cycle still evaluate, reading the failed slots' fallback numbers.
    const chain = cycleChain(slots, remaining, remaining.values().next().value);
    const message = `Cyclic expressions: ${[...chain, chain[0]].join(" → ")}`;
    for (const key of chain) {
      fail(slots.get(key), message);
      settle(key);
    }
  }

  // 6. Rim solves happen INLINE during the Kahn evaluation above (each closest
  //    ref / closest_to_rim call reads the per-pass solve memo), so there is NO
  //    fixpoint sweep anymore — the old Gauss-Seidel loop (which re-evaluated
  //    closest slots until a residual estimate settled) is gone. The joint
  //    nearest-pair solve reads only the two rims' GEOMETRY, so a mutual pair's
  //    endpoints are topologically independent and evaluate exactly once each,
  //    both landing on the true nearest pair with ZERO wobble across re-evals.
  //    A rim pair that did not converge under the generic solver's iteration cap
  //    (near-degenerate/tangent geometry) is REPORTED once, never silently — the
  //    best iterate is kept (outline.nearestRimPair's documented behavior).
  if (capHit) {
    const message = `closest_to_rim nearest-pair solve hit the ${NEAREST_PAIR_MAX_ITERS}-iteration cap (near-degenerate geometry?) — keeping the best iterate`;
    reportOnce(message, `PowerRP expression warning: ${message}`);
  }

  return { state: out, errors };
}

/**
 * Pure function. Walks unresolved deps from `start` until a key repeats,
 * returning exactly the slots ON the cycle (a start that merely depends on
 * the cycle walks into it and is not included), e.g. ["vars.a", "vars.b"].
 * Every unresolved slot has ≥1 unresolved dep (else Kahn would have
 * processed it), so the walk always terminates at a repeat within N steps.
 */
function cycleChain(slots, remaining, start) {
  const chain = [start];
  let cur = start;
  for (;;) {
    const next = [...slots.get(cur).deps].find((d) => remaining.has(d));
    const at = chain.indexOf(next);
    if (at !== -1) return chain.slice(at);
    chain.push(next);
    cur = next;
  }
}

// ── Migration + variable rename ──────────────────────────────────────────────

/**
 * Pure function. Migrates legacy {item, anchor} endpoint bindings in every
 * slide delta to equation pairs — the load-time companion of
 * withCameraEnsured. {x, y} free endpoints stay plain. Any stale x/y keys
 * mixed into a binding subtree (the old detach-after-bind merge bug) are
 * dropped: the binding wins, matching V1 resolveBinding's precedence.
 *
 * @example // withBindingsMigrated(doc) turns delta items.A.from = {item: "c1", anchor: "tm"}
 * @example // into items.A.from = {x: "@c1_tm.x", y: "@c1_tm.y"}
 */
export function withBindingsMigrated(doc) {
  let changed = false;
  const slides = doc.slides.map((slide) => {
    let delta = slide.delta;
    for (const [itemId, sub] of Object.entries(delta.items ?? {})) {
      if (!isTree(sub)) continue;
      for (const [key, value] of Object.entries(sub)) {
        if (!isTree(value) || typeof value.item !== "string" || typeof value.anchor !== "string") continue;
        delta = setPath(delta, ["items", itemId, key], {
          x: `@${value.item}_${value.anchor}.x`,
          y: `@${value.item}_${value.anchor}.y`,
        });
        changed = true;
      }
    }
    return delta === slide.delta ? slide : { ...slide, delta };
  });
  return changed ? { ...doc, slides } : doc;
}

/**
 * Pure function. Renames a variable document-wide: every vars.<oldName>
 * keyframe moves to vars.<newName>, and every equation (numeric-slot string
 * in any slide delta, plus every vars equation) has its bare `oldName`
 * reference tokens rewritten. Variables are referenced BY NAME (their name
 * is their identity), so rename must rewrite — unlike items, which are
 * stored by id and never need this. Throws if newName is not a valid
 * identifier or already exists as a variable.
 *
 * @example // withVariableRenamed(doc, "speed", "velocity", registry):
 * @example //   delta.vars.speed: 5        → delta.vars.velocity: 5
 * @example //   items.a1.x: "speed * 2"    → items.a1.x: "velocity * 2"
 */
export function withVariableRenamed(doc, oldName, newName, registry) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName))
    throw new Error(`"${newName}" is not a valid variable name (letters, digits, _; not starting with a digit)`);
  for (const slide of doc.slides)
    if (slide.delta.vars && newName in slide.delta.vars)
      throw new Error(`A variable named "${newName}" already exists`);
  const renameRefs = (src) => {
    try {
      return mapRefTokens(src, (token) => (token === oldName ? newName : token));
    } catch {
      return src; // not a parseable equation — leave it (its own error affordance reports it)
    }
  };
  const slides = doc.slides.map((slide) => {
    let delta = slide.delta;
    if (delta.vars && oldName in delta.vars) {
      const vars = { ...delta.vars };
      vars[newName] = typeof vars[oldName] === "string" ? renameRefs(vars[oldName]) : vars[oldName];
      delete vars[oldName];
      delta = { ...delta, vars };
    }
    if (delta.vars) {
      const vars = Object.fromEntries(Object.entries(delta.vars).map(([k, v]) =>
        [k, typeof v === "string" ? renameRefs(v) : v]));
      delta = { ...delta, vars };
    }
    for (const [itemId, sub] of Object.entries(delta.items ?? {})) {
      if (!isTree(sub)) continue;
      const type = getPath(sub, ["type"]);
      // The item's plugin is needed for numeric-slot detection; the type may
      // be keyed on an earlier slide, so fall back to scanning all slides.
      const itemType = type ?? findItemType(doc, itemId);
      if (!itemType) continue;
      const plugin = registry.get(itemType);
      for (const [path, value] of leaves(sub))
        if (typeof value === "string" && isNumericSlot(plugin, path)) {
          const renamed = renameRefs(value);
          if (renamed !== value) delta = setPath(delta, ["items", itemId, ...path], renamed);
        }
    }
    return delta === slide.delta ? slide : { ...slide, delta };
  });
  return { ...doc, slides };
}

/** Pure function. The type an item is created with (first slide keying it), or null. */
function findItemType(doc, itemId) {
  for (const slide of doc.slides) {
    const t = getPath(slide.delta, ["items", itemId, "type"]);
    if (typeof t === "string") return t;
  }
  return null;
}
