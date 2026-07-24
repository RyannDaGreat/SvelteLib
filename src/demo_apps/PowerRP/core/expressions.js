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
import { worldTransform, composedMemberInfluence, memberOwnerGroups } from "./derive.js";
import { reportOnce } from "./report.js";
import { nearestRimPair, NEAREST_PAIR_MAX_ITERS } from "./outline.js";
import { isHexColor } from "./interpolators.js";
import { PROPS } from "./properties.js";
import { textDissolve, textType, textScramble } from "./text_transitions.js";

// ── Tokenizer ────────────────────────────────────────────────────────────────

const OP_CHARS = "+-*/()";
const NUM_RE = /^(?:\d+\.?\d*|\.\d+)/;
// A reference token: optional "@" (stored item ref), then an identifier chain.
const REF_RE = /^@?[A-Za-z0-9_]+(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
// Typed-literal tokens (any-type `=` equations): a quoted string (\\ / \" / \'
// escapes only) and a CSS hex color (3/4/6/8 digits — interpolators.isHexColor's set).
const STR_RE = /^"(?:\\.|[^"\\])*"|^'(?:\\.|[^'\\])*'/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})/;

/**
 * Pure function. Tokenizes an expression source string.
 *
 * Returns [{kind: "num"|"ref"|"op"|"comma"|"dot"|"str"|"color", value, start,
 * end}] with source positions (so display↔stored conversion can rewrite refs in
 * place). "comma" separates function-call arguments; "dot" is a STANDALONE "."
 * (member projection after a call/paren, e.g. `f(a).x`) — dots INSIDE an
 * identifier chain (`a.b.c`) are eaten by REF_RE and never surface as a dot
 * token, so a lone dot only appears where a projection can. "str" (a quoted
 * literal, value = the unquoted contents) and "color" (a #hex literal) are the
 * typed-value literals for any-type `=` equations. Throws on any character
 * outside the grammar.
 *
 * @example tokenize("speed * 2").map((t) => t.kind) // ["ref", "op", "num"]
 * @example tokenize("@ab12_tm.x + 10")[0].value // "@ab12_tm.x"
 * @example tokenize("f(a, b).x").map((t) => t.kind) // ["ref", "op", "ref", "comma", "ref", "op", "dot", "ref"]
 * @example tokenize('"hi"')[0] // {kind: "str", value: "hi", start: 0, end: 4}
 * @example tokenize("#ff0080")[0] // {kind: "color", value: "#ff0080", start: 0, end: 7}
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
    } else if (ch === '"' || ch === "'") {
      // STRING literal (typed `=` equations — text/enum results). Scans to the
      // matching quote; \\ and \" / \' are the only escapes (kept minimal).
      const m = STR_RE.exec(src.slice(i));
      if (!m) throw new Error(`Unterminated string at ${i} in "${src}"`);
      const raw = m[0].slice(1, -1).replace(/\\(["'\\])/g, "$1");
      tokens.push({ kind: "str", value: raw, start: i, end: i + m[0].length });
      i += m[0].length;
    } else if (ch === "#") {
      // HEX COLOR literal (typed `=` equations — color results). #rgb/#rgba/
      // #rrggbb/#rrggbbaa, the same forms interpolators.isHexColor accepts.
      const m = COLOR_RE.exec(src.slice(i));
      if (!m) throw new Error(`Malformed color at ${i} in "${src}"`);
      tokens.push({ kind: "color", value: m[0], start: i, end: i + m[0].length });
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
    if (t.kind === "str") return { kind: "str", value: tokens[pos++].value };
    if (t.kind === "color") return { kind: "color", value: tokens[pos++].value };
    if (t.kind === "ref") {
      const tok = tokens[pos++];
      // Reserved literals: `true`/`false` tokenize as identifiers but ARE the
      // boolean literals (not variables) — a variable named `true` is disallowed
      // by this shadowing, matching the loud-typo discipline (there is no such
      // var). A following "(" still makes it a call name (never a bool).
      if ((tok.value === "true" || tok.value === "false") && !(peek()?.kind === "op" && peek().value === "("))
        return { kind: "bool", value: tok.value === "true" };
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
 * @example evalAst(parseExpression("=#ff0000"), () => 0) // "#ff0000" (typed color literal)
 * @example evalAst(parseExpression('="hello"'), () => 0) // "hello" (typed string literal)
 * @example evalAst(parseExpression("=true"), () => 0) // true (typed boolean literal)
 */
export function evalAst(ast, lookup, callFn = null) {
  switch (ast.kind) {
    case "num": return ast.value;
    case "str": return ast.value;   // typed literal (string / enum result)
    case "color": return ast.value; // typed literal (hex color result)
    case "bool": return ast.value;  // typed literal (boolean result)
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
 * value: {doc, overloads: [{params: ("widget"|"string"|"number")[]}]} and,
 * OPTIONALLY, `impl` — a PURE (name, args…) → value function. An entry WITH an
 * `impl` is a plain scalar/string library function: the evaluator coerces each
 * arg to its declared param kind ("number" via Number, "string" via String,
 * both recording ref dependencies) and calls `impl`; the result is validated
 * against the SLOT's result kind like any expression (so a string-returning
 * `impl` is valid in a string slot). An entry WITHOUT an `impl` (closest_to_rim)
 * is a POINT-valued dynamic-anchor function solved in evaluateState's call
 * handler (widget geometry + per-pass solve memo). Exported as the ONE source of
 * truth for autocomplete (equationFunctionNames) — nothing else enumerates
 * function names.
 */
export const FUNCTIONS = {
  closest_to_rim: {
    doc: "The point on a widget's rim nearest a point, or the nearest-pair point between two rims.",
    overloads: [
      { params: ["widget", "number", "number"] }, // rim vs point
      { params: ["widget", "widget"] },            // rim vs rim (joint solve)
    ],
  },
  // STRING-TRANSITION functions (pure, deterministic — core/text_transitions.js).
  // alpha-driven text animation usable from any "=" string slot (esp. plaintext).
  text_dissolve: {
    doc: "Crossfade one string into another by alpha 0..1 (a shuffled per-character swap).",
    overloads: [{ params: ["string", "string", "number"] }],
    impl: textDissolve,
  },
  text_type: {
    doc: "Typewriter reveal — the first floor(alpha*length) characters of a string.",
    overloads: [{ params: ["string", "number"] }],
    impl: textType,
  },
  text_scramble: {
    doc: "Resolve a string from deterministic scramble noise to clear text by alpha 0..1.",
    overloads: [{ params: ["string", "number"] }],
    impl: textScramble,
  },
};

/**
 * Pure function. The function-library names, for equation autocomplete (the ONE
 * exported list — manifest EQUATION DISCOVERABILITY: "expose the function table
 * for equationSuggest"). Each entry is a ready-to-type stub with its first
 * overload's arity, e.g. "closest_to_rim(" — the caller appends args.
 *
 * @example equationFunctionNames() // ["closest_to_rim", "text_dissolve", "text_type", "text_scramble"]
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

// A leading "=" marks ANY property as an equation (the UNIVERSAL any-type
// affordance), regardless of its default kind. Whitespace before "=" is
// tolerated (parseExpression strips `^\s*=\s*`).
const EQ_PREFIX_RE = /^\s*=/;

/**
 * Pure function. Does this stored string value declare an equation? Either the
 * UNIVERSAL leading "=" (any-type: color/string/bool/enum/number), OR — for
 * back-compat — a bare string in a legacy NUMERIC slot (isNumericSlot).
 *
 * @example isEquationValue({defaults: {fill: "#000"}}, ["fill"], "=#ff0000") // true (universal "=")
 * @example isEquationValue({defaults: {fill: "#000"}}, ["fill"], "#ff0000") // false (literal color, not an equation)
 * @example isEquationValue({defaults: {x: 0}}, ["x"], "speed * 2") // true (legacy numeric slot)
 * @example isEquationValue({defaults: {name: "?"}}, ["name"], "Box") // false (plain string)
 */
export function isEquationValue(plugin, path, value) {
  if (typeof value !== "string") return false;
  return EQ_PREFIX_RE.test(value) || isNumericSlot(plugin, path);
}

// PROPS.kind → the JS RESULT TYPE an `=` equation must evaluate to. "string"
// covers text/select(enum)/asset — all string-valued; "select" adds an in-set
// check on top (see resultMatchesKind, which reads the row's options).
const KIND_RESULT = { number: "number", color: "color", boolean: "boolean", select: "select", asset: "string", text: "string" };

/**
 * Pure function. The RESULT TYPE an equation slot must evaluate to. Variables
 * and legacy (non-"=") numeric slots are "number" — byte-identical to the
 * pre-any-type engine. A UNIVERSAL "=" slot's kind comes from PROPS[key].kind
 * (the shared property registry — the manifest's single source of truth) when
 * the key is registered, else is INFERRED from the plugin default's own type
 * (number/boolean, or a hex-vs-plain string → color/string) so a plugin-only
 * property still validates without a PROPS entry.
 *
 * @example resultKindForSlot({defaults: {x: 0}}, ["x"], "speed * 2") // "number" (legacy)
 * @example resultKindForSlot({defaults: {fill: "#000"}}, ["fill"], "=#f00") // "color" (PROPS.fill.kind)
 * @example resultKindForSlot({defaults: {muted: true}}, ["muted"], "=true") // "boolean"
 * @example resultKindForSlot({defaults: {foo: "bar"}}, ["foo"], "=\"x\"") // "string" (inferred: non-hex default)
 */
export function resultKindForSlot(plugin, path, value) {
  if (!EQ_PREFIX_RE.test(value)) return "number"; // legacy numeric / self-anchor slot
  const propDef = PROPS[path.join(".")];
  if (propDef) return KIND_RESULT[propDef.kind] ?? "string";
  const def = getPath(plugin.defaults, path);
  if (typeof def === "number") return "number";
  if (typeof def === "boolean") return "boolean";
  if (typeof def === "string") return isHexColor(def) ? "color" : "string";
  return "string";
}

/**
 * Pure function. Does an evaluated value `v` satisfy the expected result kind?
 * The LOUD-fallback gate for any-type equations: a "=" expr whose result type
 * mismatches its property is reported and replaced by the default (never a
 * silent bad value). `options` (a select row's allowed set) narrows "select".
 *
 * @example resultMatchesKind(5, "number") // true
 * @example resultMatchesKind(Infinity, "number") // false (non-finite)
 * @example resultMatchesKind("#ff0000", "color") // true
 * @example resultMatchesKind("nope", "color") // false (not a hex color)
 * @example resultMatchesKind(true, "boolean") // true
 * @example resultMatchesKind("multiply", "select", ["normal", "multiply"]) // true
 * @example resultMatchesKind("zzz", "select", ["normal", "multiply"]) // false (not an option)
 */
export function resultMatchesKind(v, kind, options = null) {
  switch (kind) {
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "color": return isHexColor(v);
    case "boolean": return typeof v === "boolean";
    case "select": return typeof v === "string" && (!options || options.includes(v));
    case "string": return typeof v === "string";
    default: return false;
  }
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

// ── Full-JS evaluator plumbing (proxy scope + deterministic host) ────────────
//
// THE EVALUATOR (round: full-JS upgrade). An `=`-stripped equation is compiled
// with `new Function("scope", "with(scope){ return (EXPR); }")` and run against
// a Proxy `scope` whose `has` trap returns true for EVERY name — so bare
// identifiers (`shape_2.x`, `speed`, `self.w`, `Math.sin`, plus IIFEs, locals,
// loops, conditionals) all route through the proxy's `get`. `get` is the SINGLE
// gate: it resolves references (recording each as a DYNAMIC dependency), hands
// back a determinism-safe host (Math WITHOUT random, a controlled time/frame, a
// SEEDED random, and the FUNCTIONS registry), and — because `has` is always
// true — leaves NO path to the real globals (Date/window/globalThis/fetch
// resolve to undefined, so `Date.now()` throws loudly rather than reaching the
// wall clock). This keeps RenderTree = pure(document, alpha): evaluation is a
// deterministic function of the folded state alone.
//
// UNTAKEN-BRANCH CAVEAT (by design): dependencies are captured by EXECUTION, not
// by static parsing, so a reference in a branch that does NOT run this pass
// (`cond ? a.x : b.x`) is not recorded until a pass takes that branch. This is
// what lets reactivity survive control flow — the captured set is exactly the
// refs actually read — at the cost that a not-yet-taken branch's refs are
// absent until taken (each fold produces a new state identity, re-evaluated).
//
// BOOLEAN-CONTEXT CAVEAT: a raw reference used directly as a truth test
// (`ref ? … : …`, `!ref`) is the lazy ref proxy (an object) and is therefore
// always truthy; compare explicitly (`ref > 0`, `ref === "x"`). Arithmetic /
// relational operators and the final returned value DO coerce through the proxy.

/** A lazy ref proxy exposes its accumulated path under REF_SEGS (widget-arg
 * extraction) and flags itself under IS_REF (final-result unwrap). */
const REF_SEGS = Symbol("refSegs");
const IS_REF = Symbol("isRef");

/** Math with NO random (determinism): every Math member except `random`. */
const SAFE_MATH = Object.freeze(Object.fromEntries(
  Object.getOwnPropertyNames(Math)
    .filter((k) => k !== "random")
    .map((k) => [k, typeof Math[k] === "function" ? Math[k].bind(Math) : Math[k]]),
));

// Ambient globals that MUST stay unreachable (determinism + sandboxing). They
// resolve to undefined so any member use (Date.now(), window.x) throws loudly;
// `has: () => true` already blocks fall-through to the real globals, so this is
// the explicit, self-documenting half of the guard. `self` is NOT here — it is
// the owning-item keyword and is handled as a reference head.
const BLOCKED_GLOBALS = new Set([
  "Date", "window", "globalThis", "global", "fetch", "XMLHttpRequest", "WebSocket",
  "process", "require", "eval", "Function", "import", "document", "navigator",
  "performance", "setTimeout", "setInterval", "queueMicrotask", "Reflect",
]);

/**
 * Pure function. A tiny deterministic string hash (FNV-1a) → uint32, used to
 * SEED the evaluator's random from the folded state (so randomness is
 * reproducible: same document ⇒ same sequence).
 *
 * @example typeof stringSeed("speed * 2") // "number"
 * @example stringSeed("a") !== stringSeed("b") // true
 */
function stringSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pure function. mulberry32 PRNG: a uint32 seed → a function yielding the next
 * uniform in [0, 1). Deterministic (same seed ⇒ same sequence) — the SEEDED
 * random the evaluator exposes so equations may use randomness without breaking
 * RenderTree = pure(document, alpha).
 *
 * @example // const r = mulberry32(1); const a = r(); 0 <= a && a < 1 // true
 * @example // mulberry32(7)() === mulberry32(7)() // true (reproducible)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure function. Rewrites a restricted-grammar equation into a JS-VALID
 * expression: `#hex` color literals → quoted strings, and stored `@id` item
 * refs → `$id` identifiers (JS-legal; the scope proxy maps `$id` back to `@id`).
 * Bare display slugs (`shape_2.x`), variables, `self.…`, and function calls are
 * already JS-valid and pass through. A source that is NOT restricted-grammar
 * tokenizable (a full-JS expression — IIFE/loop/etc.) is returned verbatim.
 *
 * @example toJsExpr("@a1.x + 10") // "$a1.x + 10"
 * @example toJsExpr("#ff0080") // "\"#ff0080\""
 * @example toJsExpr("(function(){return 1})()") // "(function(){return 1})()" (verbatim — not restricted)
 */
function toJsExpr(clean) {
  let toks;
  try {
    toks = tokenize(clean);
  } catch {
    return clean; // full-JS expression: not restricted-tokenizable, leave verbatim
  }
  let out = "";
  let last = 0;
  for (const t of toks) {
    if (t.kind === "color") {
      out += clean.slice(last, t.start) + JSON.stringify(t.value);
      last = t.end;
    } else if (t.kind === "ref" && t.value[0] === "@") {
      out += clean.slice(last, t.start) + "$" + t.value.slice(1);
      last = t.end;
    }
  }
  return out + clean.slice(last);
}

const jsFnCache = new Map(); // clean src → compiled (scope) → value (pure compile; cache-safe)

/**
 * Near-pure function (memoizes into a module cache). Compiles an `=`-stripped
 * equation into a `(scope) → value` function via `new Function` + `with(scope)`.
 * BACK-COMPAT: when the source is a RESTRICTED-grammar syntax error, the
 * restricted parser's message (e.g. "Unexpected end") is preferred over V8's; a
 * source JS itself cannot compile but the restricted parser ACCEPTS (a bad
 * `@id`, etc.) rethrows V8's. The `\n` before `)` neutralizes a trailing line
 * comment. Throws on a genuine syntax error (→ the slot fails loud).
 *
 * @example // compileEquationFn("speed * 2")(scope) evaluates speed*2 against scope
 */
function compileEquationFn(clean) {
  const cached = jsFnCache.get(clean);
  if (cached) return cached;
  let restrictedErr = null;
  try {
    parseExpression(clean); // restricted-grammar validation, for its nicer error message
  } catch (e) {
    restrictedErr = e;
  }
  let fn;
  try {
    fn = new Function("scope", `with(scope){ return (${toJsExpr(clean)}\n); }`);
  } catch (jsErr) {
    throw restrictedErr ?? jsErr; // prefer the back-compat restricted message
  }
  jsFnCache.set(clean, fn);
  return fn;
}

/** Control-flow sentinel: a detected dependency cycle. Carries the exact chain
 * of slot keys so evaluation aborts cleanly and the cycle's ORIGIN slot absorbs
 * it. NOT an Error subclass — it is instanceof-caught, never shown as an
 * equation message (the members are failed with the "Cyclic expressions" text). */
class CycleAbort {
  constructor(chain) {
    this.chain = chain;
  }
}

/**
 * Pure function. Ref-proxy path segments → a resolver token for resolveRef: a
 * `$`-mangled stored head becomes its `@id` form ("$a1" → "@a1"); display heads
 * and every deeper segment pass through unchanged ("box", "self", "x").
 *
 * @example segsToToken(["$a1", "x"]) // "@a1.x"
 * @example segsToToken(["box", "rotation_anchor", "x"]) // "box.rotation_anchor.x"
 * @example segsToToken(["self", "w"]) // "self.w"
 */
function segsToToken(segs) {
  const head = segs[0][0] === "$" ? "@" + segs[0].slice(1) : segs[0];
  return [head, ...segs.slice(1)].join(".");
}

/**
 * Near-pure function (memoized on state identity; console.errors each NEW
 * error message once — never silently). THE derivation-stage expression
 * pass: folded state → same-shaped state with every equation slot replaced
 * by its evaluated value, plus an error map and the captured dependency graph.
 *
 * Each `=`-stripped equation is compiled to FULL JavaScript (`new Function` +
 * `with(scope)`) and evaluated LAZILY: a slot is settled on first read, so its
 * dependencies (settled first, by recursion) are DISCOVERED as the expression
 * runs — dynamic dep-capture, not static ref-parsing (see the "Full-JS
 * evaluator plumbing" block for the proxy/determinism/untaken-branch details).
 * A dependency cycle is detected on re-entry to an in-progress slot and is
 * LOUD: every slot on the cycle gets the "Cyclic expressions: …" message and
 * falls back to its default; slots merely downstream still evaluate.
 *
 * Returns {state, errors, deps}. `errors` maps "items.a1.x"-style joined paths
 * to human messages; errored slots (syntax errors, unknown references, cycles,
 * wrong-kind or non-finite results, or ANY thrown expression) fall back to the
 * plugin default for the key (0 for variables) — deterministic, never a silent
 * NaN; the UI renders the error affordance from the map. `deps` maps each slot
 * key to the Set of slot keys it read this pass (the dynamically captured
 * dependency graph — the untaken-branch caveat applies: only refs on the
 * executed path are present).
 *
 * Dependency behavior (now emergent from lazy recursion, not a static pass):
 *   - variable / property ref → that slot (settled first if it is an equation)
 *   - anchor ref → ALL equation slots of the referenced item (its transform +
 *     bbox); a base-frame self anchor reads only x/y/w/h/scale (the pivot must
 *     be a fixed point) plus, for a cross-item ref to a grouped member, the
 *     owning groups' transforms (painted, group-influenced world)
 *   - closest_to_rim(W, x, y) / `@id_closest` toward a point → W's geometry +
 *     the toward point's own coordinate slots (a rim-vs-point projection)
 *   - closest_to_rim(A, B) / a MUTUAL `@id_closest` pair → BOTH rims' geometry
 *     and NOTHING else. The nearest PAIR is solved jointly from the two rims'
 *     GEOMETRY, so the two endpoints do NOT depend on each other — no fixpoint,
 *     no wobble. Identical solves within one pass are MEMOIZED, so from.x/from.y
 *     (and the symmetric to-side call) share ONE solve.
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

/** Pure-core of evaluateState (see its docs); uncached. Full-JS, lazy engine. */
function computeEvaluatedState(state, registry) {
  const out = copied(state);
  const errors = new Map();
  const deps = new Map(); // slotKey → Set(depKey): DYNAMIC dependency capture
  const slugs = slugMap(state);
  // memberId → [owning groupIds] (z-order). A CROSS-ITEM anchor ref to a grouped
  // member resolves at the member's GROUP-INFLUENCED world (the painted position);
  // the anchor read below settles each owning group's transform first (recursion)
  // and composes its influence. Empty for group-free documents (the common case).
  const ownerGroups = memberOwnerGroups(state);

  // 1. Collect equation slots. A slot carries its expected result `kind`:
  //    variables + legacy numeric/self-anchor slots are "number" (the pre-
  //    any-type engine, byte-identical); a UNIVERSAL leading "=" opens the slot
  //    to ANY kind (color/string/boolean/select), validated post-eval.
  const slots = new Map(); // key ("items.a1.x") → slot
  for (const [name, value] of Object.entries(state.vars ?? {}))
    if (typeof value === "string")
      slots.set(`vars.${name}`, { key: `vars.${name}`, path: ["vars", name], src: value, kind: "number" });
  for (const [id, item] of Object.entries(state.items ?? {})) {
    // An item whose `type` hasn't folded in yet DOES NOT EXIST YET (the
    // imaginary-slide semantics) — legitimate mid-document state when a creation
    // slide sits BELOW a slide that keyframes the item. Skip, never throw.
    if (typeof item?.type !== "string") continue;
    const plugin = registry.get(item.type);
    for (const [path, value] of leaves(item))
      if (isEquationValue(plugin, path, value)) {
        const key = ["items", id, ...path].join(".");
        slots.set(key, { key, path: ["items", id, ...path], src: value, kind: resultKindForSlot(plugin, path, value) });
      }
  }
  const itemSlotKeys = new Map(); // itemId → [slot keys] (geometry settling for anchors / rim / groups)
  for (const slot of slots.values())
    if (slot.path[0] === "items") {
      if (!itemSlotKeys.has(slot.path[1])) itemSlotKeys.set(slot.path[1], []);
      itemSlotKeys.get(slot.path[1]).push(slot.key);
    }

  const fallbackFor = (path) => {
    if (path[0] !== "items") return 0; // variables have no plugin defaults
    const item = state.items[path[1]];
    return getPath(registry.get(item.type).defaults, path.slice(2)) ?? 0;
  };
  const status = new Map(); // slotKey → "eval" | "done" | "failed"
  const stack = []; // slot keys currently on the evaluation stack (the cycle chain)
  const fail = (slot, message) => {
    if (status.get(slot.key) === "failed") return; // idempotent: a cycle fails its members once
    errors.set(slot.key, message);
    mutSetPath(out, slot.path, fallbackFor(slot.path));
    status.set(slot.key, "failed");
    reportOnce(message, `PowerRP expression error at ${slot.key}: ${message}`);
  };

  // Controlled clock + seeded random (determinism): sourced from the FOLDED
  // state, never wall-clock. The host folds `time`/`frame` into state for
  // animation; absent ⇒ 0. The random seed is a hash of the equation set, so a
  // given document yields a reproducible sequence — RenderTree = pure(document).
  const time = typeof state.time === "number" ? state.time : 0;
  const frame = typeof state.frame === "number" ? state.frame : 0;
  const seededRandom = mulberry32(stringSeed([...slots.keys()].sort().join("|") + "|powerrp"));

  // Rim-solve MEMO (per pass): from.x/from.y of one closest ref share ONE solve;
  // a mutual pair's two endpoints share the SAME joint solve (both read only
  // geometry) — deterministic, wobble-free, computed once.
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

  // ── Dependency-driven, lazy evaluation (recursion settles deps first) ──
  const currentKey = () => stack[stack.length - 1];
  const addDep = (from, to) => {
    if (!deps.has(from)) deps.set(from, new Set());
    deps.get(from).add(to);
  };

  /** Command. Ensures slot `key` is settled in `out` (value OR fallback),
   * recording a dependency from the running slot and detecting cycles. Throws
   * CycleAbort on re-entry to an in-progress slot (the whole chain is failed). */
  const requireSlot = (key) => {
    const from = currentKey();
    if (from && from !== key) addDep(from, key);
    const st = status.get(key);
    if (st === "done" || st === "failed") return; // already settled (value / fallback in `out`)
    if (st === "eval") {
      const chain = stack.slice(stack.indexOf(key));
      const message = `Cyclic expressions: ${[...chain, chain[0]].join(" → ")}`;
      for (const k of chain) fail(slots.get(k), message);
      throw new CycleAbort(chain);
    }
    evalSlot(slots.get(key));
  };

  /** Command. Settles every equation slot of `itemId` a transform/rim read
   * needs, so worldTransform / closestAnchor read final numbers: all of them,
   * or (base-frame self pivot) only x/y/w/h/scale — never rotation/rotationAnchor,
   * keeping the pivot a fixed point and avoiding a false self-cycle. */
  const requireItemGeometry = (itemId, selfBase) => {
    const from = currentKey();
    for (const depKey of itemSlotKeys.get(itemId) ?? []) {
      if (depKey === from) continue; // never wait on the slot currently evaluating
      if (selfBase && !SELF_ANCHOR_DEP_PROPS.has(depKey.split(".")[2])) continue;
      requireSlot(depKey);
    }
  };
  const requireGroups = (itemId) => {
    for (const gid of ownerGroups.get(itemId) ?? []) requireItemGeometry(gid, false);
  };

  /** Query→value (records deps; may recurse). The value of a preset/self/closest
   * anchor descriptor `d`, mapped through the correct frame. */
  const anchorValue = (d, slot) => {
    const item = out.items?.[d.itemId];
    if (!item) throw new Error(`Unknown item "@${d.itemId}"`);
    const plugin = registry.get(item.type);
    if (d.anchorId === "closest") return closestSugar(d, slot);
    if (!(plugin.anchors?.(item) ?? []).some((a) => a.id === d.anchorId))
      throw new Error(`"${slugs.toSlug.get(d.itemId) ?? d.itemId}" has no anchor "${d.anchorId}"`);
    requireItemGeometry(d.itemId, d.selfBase); // settle the target's geometry first
    // selfBase (a self.anchors.<id> rotation pivot): ROTATION-ZEROED base frame —
    // the pivot is a FIXED point. Otherwise (cross-item ref): the PAINTED
    // worldTransform (pivoted about rotationAnchor), PLUS the group influence if
    // the target is a grouped member — byte-identical to derive.js node.world.
    let world = d.selfBase ? { ...T.fromState(out.items[d.itemId]), rotation: 0 } : worldTransform(out.items[d.itemId]);
    if (!d.selfBase) {
      requireGroups(d.itemId);
      const influence = composedMemberInfluence(ownerGroups.get(d.itemId), out);
      if (influence) world = T.compose(influence, world);
    }
    const anchor = plugin.anchors(out.items[d.itemId]).find((a) => a.id === d.anchorId);
    return T.apply(world, anchor.x, anchor.y)[d.coord];
  };

  /** Query→value (records deps; may recurse). The `@id_closest` sugar → the rim
   * solver: mutual (the toward endpoint is itself a closest ref) → JOINT nearest
   * pair; otherwise a rim-vs-point projection toward the arrow's other endpoint. */
  const closestSugar = (d, slot) => {
    const plugin = registry.get(out.items[d.itemId].type);
    if (!plugin.closestAnchor)
      throw new Error(`"${slugs.toSlug.get(d.itemId) ?? d.itemId}" has no computed closest anchor`);
    const selfId = slot.path[0] === "items" ? slot.path[1] : null;
    const owner = selfId != null ? out.items?.[selfId] : null;
    const ownerPlugin = owner && typeof owner.type === "string" ? registry.get(owner.type) : null;
    const toward = ownerPlugin?.closestToward?.(owner, slot.path.slice(2));
    if (!toward)
      throw new Error(`"closest" anchor needs a toward context — only widgets with a closestToward hook (arrows) can use it`);
    requireItemGeometry(d.itemId, false); // this rim's geometry
    const otherRimId = closestPartnerRimId(toward, slugs); // set iff the other endpoint is itself a closest ref
    if (otherRimId) {
      requireItemGeometry(otherRimId, false); // the other rim's geometry (mutual: JOINT solve, no cross-dep)
      return solvePair(d.itemId, otherRimId)[d.coord];
    }
    // Rim-vs-point: settle the sibling endpoint's own x/y slots, then read the
    // (now numeric) toward point and project the rim onto it.
    const siblingKey = siblingEndpointKey(owner, toward);
    if (siblingKey)
      for (const k of ["x", "y"]) {
        const towardKey = `items.${selfId}.${siblingKey}.${k}`;
        if (slots.has(towardKey)) requireSlot(towardKey);
      }
    const tw = ownerPlugin.closestToward(owner, slot.path.slice(2)); // re-read after settle (out mutated in place)
    const tx = typeof tw.x === "number" ? tw.x : 0;
    const ty = typeof tw.y === "number" ? tw.y : 0;
    return solvePoint(d.itemId, tx, ty)[d.coord];
  };

  /** Query→value (records deps; may recurse). Resolves a ref-proxy path (display
   * form, or `$`-mangled stored form) to its value, settling and recording every
   * dependency. Throws loudly on unknown refs / wrong kinds (→ fail-loud). */
  const refValue = (segs, slot) => {
    const selfId = slot.path[0] === "items" ? slot.path[1] : null;
    const token = segsToToken(segs);
    const d = resolveRef(token, slugs, selfId); // handles @ (from $) / self / display
    if (d.kind === "var") {
      const depKey = `vars.${d.name}`;
      if (slots.has(depKey)) requireSlot(depKey);
      if (!(d.name in (out.vars ?? {}))) throw new Error(`Unknown variable "${d.name}"`);
      return out.vars[d.name];
    }
    if (d.kind === "prop") {
      if (!out.items?.[d.itemId]) throw new Error(`Unknown item "@${d.itemId}" in "${token}"`);
      const spath = pathToStored(d.path); // display snake_case → stored camelCase (idempotent on camel)
      const depKey = ["items", d.itemId, ...spath].join(".");
      // A NUMBER-kind slot keeps the strict rule: a non-equation string property
      // cannot feed arithmetic (loud). A TYPED ("=") slot may read a typed
      // property (literal color/string, or another "=" slot) — the post-eval
      // kind check is the loudness gate there, not this read-time throw.
      const folded = getPath(state.items[d.itemId], spath);
      if (slot.kind === "number" && typeof folded === "string" && !slots.has(depKey))
        throw new Error(`"${token}" is not a numeric property`);
      if (slots.has(depKey)) requireSlot(depKey);
      const raw = getPath(out.items[d.itemId], spath);
      if (raw === undefined)
        throw new Error(`Item "${slugs.toSlug.get(d.itemId) ?? d.itemId}" has no property "${d.path.join(".")}"`);
      return raw;
    }
    return anchorValue(d, slot); // anchor (preset / self / closest)
  };

  // A lazy ref proxy: bare `head` accumulates `.seg` accesses; coercion (arithmetic,
  // final return, Number()/String()) resolves the whole path via refValue. A widget
  // arg (a bare item ref passed to a function) is read via REF_SEGS, not coerced.
  const makeRef = (segs, slot) => new Proxy(Object.create(null), {
    get: (_t, prop) => {
      if (prop === IS_REF) return true;
      if (prop === REF_SEGS) return segs;
      if (prop === Symbol.toPrimitive || prop === "valueOf") return () => refValue(segs, slot);
      if (prop === "toString") return () => String(refValue(segs, slot));
      if (typeof prop === "symbol") return undefined;
      return makeRef([...segs, prop], slot);
    },
  });

  // The function-library callable (closest_to_rim, …). Widget args arrive as
  // ref proxies (read via REF_SEGS + validated); numeric args coerce via Number.
  const makeFn = (name, slot, selfId) => (...args) => {
    const overload = resolveOverload(name, args.length); // loud on unknown fn / bad arity
    const spec = FUNCTIONS[name];
    // Library functions with an `impl` (text_dissolve, text_type, …): coerce each
    // arg to its declared param kind — "number" via Number, "string" via String,
    // both of which resolve a ref proxy through refValue and so RECORD its
    // dependency — then call the pure impl. The result rides evalSlot's normal
    // result-kind validation (a string impl is valid in a string slot).
    if (spec.impl) {
      const argv = args.map((arg, i) => {
        const kind = overload.params[i];
        if (kind === "number") return Number(arg);
        if (kind === "string") return String(arg);
        throw new Error(`Argument ${i + 1} of "${name}" has unsupported kind "${kind}"`);
      });
      return spec.impl(...argv);
    }
    const widgetIds = [];
    const nums = [];
    args.forEach((arg, i) => {
      if (overload.params[i] === "widget") {
        const segs = arg == null ? null : arg[REF_SEGS];
        const tok = segs ? widgetArgToken({ kind: "ref", name: segsToToken(segs) }) : null;
        if (tok === null) throw new Error(`Argument ${i + 1} of "${name}" must be a widget name`);
        const wid = resolveWidgetArg(tok, slugs, selfId);
        const witem = out.items?.[wid];
        if (!witem || typeof witem.type !== "string") throw new Error(`Unknown widget "${tok}" in "${name}(…)"`);
        if (!registry.get(witem.type).closestAnchor)
          throw new Error(`"${slugs.toSlug.get(wid) ?? wid}" has no rim (no closestAnchor) for ${name}`);
        requireItemGeometry(wid, false); // widget geometry (deps + cycle detection)
        widgetIds.push(wid);
      } else {
        nums.push(Number(arg)); // coerces a ref proxy (records its dep) or passes a numeric literal
      }
    });
    if (overload.params.length === 3) return solvePoint(widgetIds[0], nums[0], nums[1]); // rim vs point
    return solvePair(widgetIds[0], widgetIds[1]); // rim vs rim (joint)
  };

  // The scope proxy: `has: () => true` routes EVERY free identifier through `get`
  // (no fall-through to real globals — the determinism guard). `get` returns the
  // deterministic host, the function library, or a lazy ref proxy.
  const scopeGet = (name, slot, selfId) => {
    switch (name) {
      case "undefined": return undefined;
      case "NaN": return NaN;
      case "Infinity": return Infinity;
      case "Math": return SAFE_MATH; // no random
      case "time": return time;
      case "frame": return frame;
      case "random": return seededRandom; // seeded, deterministic
    }
    if (name in FUNCTIONS) return makeFn(name, slot, selfId);
    if (BLOCKED_GLOBALS.has(name)) return undefined; // Date/window/… → undefined → member use throws loud
    return makeRef([name], slot); // a reference HEAD
  };
  const makeScope = (slot) => {
    const selfId = slot.path[0] === "items" ? slot.path[1] : null;
    return new Proxy(Object.create(null), {
      has: () => true,
      get: (_t, prop) => (typeof prop === "symbol" ? undefined : scopeGet(prop, slot, selfId)),
    });
  };

  const runExpression = (slot) => {
    const clean = String(slot.src).replace(/^\s*=\s*/, ""); // spreadsheet leading "="
    const fn = compileEquationFn(clean); // throws (syntax) → caught by evalSlot
    const result = fn(makeScope(slot));
    // A lone-ref result (`= box.x`, `speed`) is the ref proxy — coerce it once.
    return result != null && result[IS_REF] ? result[Symbol.toPrimitive]("default") : result;
  };

  const evalSlot = (slot) => {
    status.set(slot.key, "eval");
    stack.push(slot.key);
    try {
      const v = runExpression(slot);
      // RESULT-KIND VALIDATION. Number-kind slots keep the exact legacy message
      // ("evaluates to NaN/Infinity"); any-type "=" slots validate against the
      // property kind and fail LOUDLY on a mismatch (→ default, never a silent
      // bad value).
      if (slot.kind === "number") {
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`evaluates to ${v}`);
      } else if (!resultMatchesKind(v, slot.kind, PROPS[slot.path.slice(2).join(".")]?.options)) {
        throw new Error(`= expression result ${JSON.stringify(v)} is not a valid ${slot.kind} value`);
      }
      mutSetPath(out, slot.path, v);
      status.set(slot.key, "done");
    } catch (e) {
      if (e instanceof CycleAbort) {
        // Cycle members were already failed (fallbacks set in requireSlot). Keep
        // unwinding until the cycle's ORIGIN slot absorbs it; downstream reads
        // then continue with the fallbacks.
        if (slot.key !== e.chain[0]) throw e;
      } else {
        fail(slot, e.message);
      }
    } finally {
      stack.pop();
    }
  };

  // Drive: evaluate every slot. Lazy recursion settles dependencies first and
  // captures the dependency graph; each cycle's origin absorbs its CycleAbort,
  // so this loop never throws.
  for (const key of slots.keys())
    if (!status.has(key)) evalSlot(slots.get(key));

  // Rim solves ran INLINE (each closest ref / closest_to_rim call read the
  // per-pass memo) — no fixpoint sweep. A pair that did not converge under the
  // solver's iteration cap (near-degenerate/tangent geometry) is REPORTED once,
  // never silently (the best iterate is kept — nearestRimPair's behavior).
  if (capHit) {
    const message = `closest_to_rim nearest-pair solve hit the ${NEAREST_PAIR_MAX_ITERS}-iteration cap (near-degenerate geometry?) — keeping the best iterate`;
    reportOnce(message, `PowerRP expression warning: ${message}`);
  }

  return { state: out, errors, deps };
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
