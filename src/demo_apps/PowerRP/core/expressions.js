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
 *   term    := factor (("*" | "/" | "%") factor)*
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

import { isTree, copied, copiedDeep, getPath, setPath, leaves } from "./deltas.js";
import * as T from "./transform.js";
import { worldTransform, composedMemberInfluence, memberOwnerGroups } from "./derive.js";
import { boxCenter, unsignedState } from "./geometry.js";
import { reportOnce } from "./report.js";
import { nearestRimPair, NEAREST_PAIR_MAX_ITERS } from "./outline.js";
import { isHexColor } from "./interpolators.js";
// linearEndpointsToAngle is the codebase's ONE point-to-point HEADING: the
// gradient direction dial's own math. `direction2` (below) is built on it rather
// than on a second atan2, so the function library and the dial can never disagree
// about which way 90° points.
import { PROPS, GRADIENT_STOPS_LIST, linearEndpointsToAngle } from "./properties.js";
import {
  LIST_ROW_KIND, ACTIVE_FIELD, elementFieldKind, elementFieldValue, elementStorageKey,
  listPathKind, listStoragePath,
} from "./lists.js";
import { textDissolve, textType, textScramble } from "./text_transitions.js";
// THE PROJECT SCRIPT's compiler. A deliberate import CYCLE (project_script.js
// imports this file's jail constants BLOCKED_GLOBALS / SAFE_MATH / FUNCTIONS):
// the script and an equation must share ONE jail definition, and the alternative
// — a third module holding the constants — would put the jail somewhere neither
// the equation reader nor the script reader would look for it. Safe because every
// crossing is at CALL time; see scriptReservedNames for the one place that had to
// be made lazy to stay out of the temporal dead zone.
import { compileProjectScript } from "./project_script.js";
// The presentation clock behind `= time` (see readClock in computeEvaluatedState).
// core/ → render_gpu/ is established (core/registry.js → effects.js, core/clip.js →
// decorate.js), and particle_clock.js is DOM-free bare-node code by its own contract
// (performance.now() is a node global), so core's bare-node requirement holds.
import { particleTime } from "../render_gpu/particle_clock.js";
// THE MATERIAL KNOB SCHEMAS (see §Material param knobs). A paint's material
// params are declared in the material REGISTRY, not in plugin.defaults, so this
// is the only place core can learn their kinds and defaults. Same layering as the
// clock above, and already crossed the other way by core/material_plugins.js —
// which is what proves these two modules stay bare-node loadable.
import { getMaterial, materialIds } from "../render_gpu/skia/materials.js";
import { getStrokeMaterial, hasStrokeMaterial } from "../render_gpu/skia/stroke_materials.js";

// ── Tokenizer ────────────────────────────────────────────────────────────────
//
// THE UNIVERSAL "=" MARKER IS NOT IN THIS GRAMMAR. tokenize() rejects "=" as an
// unexpected character, and it must: its tokens carry SOURCE POSITIONS that the
// rewriters slice the original string with, so a tokenizer that quietly swallowed
// a prefix would hand back offsets into a string its caller never had. The marker
// therefore comes off ABOVE the tokenizer — see withMarkerPreserved (§Equation
// slots), which is the ONE place that splits it.

// "%" is MODULO, at the same precedence tier as "*" and "/" (C-like), parsed in
// term() and evaluated in evalAst's `bin` case. It tokenizes as an ordinary "op"
// (so the highlighter's TOKEN_CLS.op covers it) and passes verbatim through
// toJsExpr into JS's native `%`. It was absent here until manifest item 72 wired
// `time % self.length` scrubbing; the runtime already computed `%` via the full-JS
// fallback for hand-stored equations, so no stored document changes meaning.
const OP_CHARS = "+-*/()%";
const NUM_RE = /^(?:\d+\.?\d*|\.\d+)/;
// A reference token: optional "@" (stored item ref), then an identifier chain.
// A segment AFTER the head may be all digits, so a DECLARED LIST's element can be
// addressed (`self.points.3.x`, `fill.linear.stops.1.offset`). Only the HEAD must
// start with a letter/underscore/@ — the tokenizer only reaches REF_RE for those
// characters, so a bare number is still a number and `2.5` still lexes as one.
// The strings this newly accepts (`a.5`) were a restricted-grammar SYNTAX ERROR
// before, so nothing that used to parse changes meaning.
const REF_RE = /^@?[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/;
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

// ── Reserved literals ────────────────────────────────────────────────────────
//
// `true` / `false` match REF_RE, so the tokenizer hands them back as ordinary
// "ref" tokens — but they are BOOLEAN LITERALS, never references. THREE passes
// walk ref tokens and each must agree on that: the parser (turns them into
// {kind:"bool"}), the display↔stored mappers (must not resolve a literal as a
// variable — that threw `Unknown variable "true"` and blocked every boolean
// equation from round-tripping), and the highlighter (must not paint a literal
// as an unknown-reference error). ONE table, consulted by all three: a second
// keyword list in any of them is exactly the drift this shares away.
const RESERVED_LITERALS = new Map([["true", true], ["false", false]]);

// ── Reserved keywords ────────────────────────────────────────────────────────
//
// Bare identifiers the evaluator's scope proxy (scopeGet, §computeEvaluatedState)
// resolves to a deterministic HOST value rather than a document variable. `time`
// is the ONE such name a user types: the presentation clock (`case "time": return
// readClock()`). Like RESERVED_LITERALS (true/false), it is GRAMMAR, not a
// reference — and the SAME three passes must agree on that: resolveRef (returns a
// {kind:"keyword"} descriptor, never {kind:"var"} so displayToStored does not
// reject it as an unknown variable), the display↔stored mappers (leave it
// verbatim — the clock has no id to rewrite, so its display and stored forms are
// identical and it round-trips unchanged), and the highlighter (paints it as a
// keyword, never an unknown-reference error). Until manifest item 72 the UI-facing
// validator threw `Unknown variable "time"` on it, contradicting the clock
// plugins' own help text (clock_digital.js:221 tells users to type `= time`).
const RESERVED_KEYWORDS = new Set(["time"]);

/**
 * Pure function. Is the ref token at index `i` a RESERVED KEYWORD (`time`) rather
 * than a reference? True for a reserved-keyword identifier NOT immediately
 * followed by "(" — a following "(" makes it a call NAME (`time(...)`), never the
 * keyword — mirroring booleanLiteralAt exactly so the parser, the display↔stored
 * mappers and the highlighter apply the identical rule.
 *
 * @example reservedKeywordAt(tokenize("time"), 0) // true
 * @example reservedKeywordAt(tokenize("time % 12.5"), 0) // true
 * @example reservedKeywordAt(tokenize("time(1)"), 0) // false (a call name, not the keyword)
 * @example reservedKeywordAt(tokenize("speed"), 0) // false (an ordinary reference)
 */
function reservedKeywordAt(tokens, i) {
  if (!RESERVED_KEYWORDS.has(tokens[i].value)) return false;
  const next = tokens[i + 1];
  return !(next?.kind === "op" && next.value === "(");
}

/**
 * Pure function. Is the ref token at index `i` a BOOLEAN LITERAL rather than a
 * reference? True for `true`/`false` NOT immediately followed by "(" — the
 * EXACT test the parser applies, since a following "(" makes the identifier a
 * call NAME (`true(...)`), never a literal. Shared by the parser, the
 * display↔stored mappers and the highlighter so the three can never disagree.
 *
 * @example booleanLiteralAt(tokenize("true"), 0) // true
 * @example booleanLiteralAt(tokenize("false + 1"), 0) // true
 * @example booleanLiteralAt(tokenize("true(1)"), 0) // false (a call name, not a literal)
 * @example booleanLiteralAt(tokenize("speed"), 0) // false (an ordinary reference)
 */
function booleanLiteralAt(tokens, i) {
  if (!RESERVED_LITERALS.has(tokens[i].value)) return false;
  const next = tokens[i + 1];
  return !(next?.kind === "op" && next.value === "(");
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
// EXHAUSTIVE over every kind tokenize() emits except "ref": the typed literals
// "str" and "color" (any-type `=` equations) get their OWN classes rather than
// falling through to the operator color, which is what made a quoted string or a
// #hex read as punctuation once text/color equations existed.
const TOKEN_CLS = { num: "num", op: "op", comma: "punct", dot: "punct", str: "str", color: "color" };
// A token kind with no TOKEN_CLS entry is a REGISTRY GAP (a kind was added to
// the tokenizer without a color). It shows as an ERROR span — visible in the
// field rather than silently mis-colored as something it is not.
const UNMAPPED_TOKEN_CLS = "error";

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
 * text by the caller). Classes: "num", "str" and "color" (typed literals — a
 * quoted string, a #hex), "bool" (the reserved literals `true`/`false`, which
 * are grammar, NOT references), "op", "paren" (a "("/")"), "punct"
 * (comma / projection dot), "call" (a ref immediately followed by "(" — a
 * function name, classified positionally EXACTLY as the parser decides so an
 * unknown function name never looks like an unknown variable), "self", "var",
 * "prop", "anchor" (resolved ref kinds), "error" (a ref that does not resolve
 * to a REAL var/item/anchor/script export, or a source that does not tokenize).
 * `state` is the raw state (for slugs + the vars set); `selfId` (optional) enables
 * `self.…`; `scriptExports` (optional) is THE PROJECT SCRIPT's export OBJECT, so a
 * bare identifier the script provides paints as a "var" instead of red. It is the
 * export object rather than a name set so that every consumer of the exports —
 * this, and equationSuggest, which needs each value's TYPE to decide whether to
 * suggest a call — passes the same thing.
 *
 * WHY scriptExports IS A PARAMETER AND NOT OPTIONAL-IN-SPIRIT: without it, an
 * equation that EVALUATES PERFECTLY was painted entirely red — `= 0 + GUTTER * 4`
 * resolved to 160 on the canvas while the field said the identifier did not exist.
 * A highlighter that disagrees with the evaluator is worse than none, because the
 * author trusts it and goes looking for a bug that is not there. (A script-exported
 * FUNCTION escaped by accident: a ref followed by "(" classifies positionally as a
 * "call", so `ease(0.5)` looked fine while the VALUE beside it did not — which is
 * how the inconsistency was found.)
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
 * @example // typed literals + the reserved booleans classify as themselves, never as punctuation/errors
 * @example equationTokenSpans('"hi"', {items: {}}).map((s) => s.cls) // ["str"]
 * @example equationTokenSpans("#ff0000", {items: {}}).map((s) => s.cls) // ["color"]
 * @example equationTokenSpans("true", {items: {}}).map((s) => s.cls) // ["bool"]
 * @example // the `time` keyword paints as a keyword (like `self`), the `%` as an op — never an error
 * @example equationTokenSpans("time % 2", {items: {}}).map((s) => s.cls) // ["self", "op", "num"]
 */
export function equationTokenSpans(src, state, selfId = null, scriptExports = null) {
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
      const cls = t.kind === "op" && (t.value === "(" || t.value === ")") ? "paren" : TOKEN_CLS[t.kind] ?? UNMAPPED_TOKEN_CLS;
      return { start: t.start, end: t.end, cls };
    }
    // A member-projection coord (the x/y right after a standalone "."): grammar.
    if (tokens[i - 1]?.kind === "dot") return { start: t.start, end: t.end, cls: "member" };
    // A ref immediately followed by "(" is a FUNCTION NAME — classify it exactly
    // as the parser does (primary(): ref then peek() "(" → call), so an unknown
    // function name reads as a call, not as an unknown variable.
    const next = tokens[i + 1];
    if (next?.kind === "op" && next.value === "(") return { start: t.start, end: t.end, cls: "call" };
    // A RESERVED LITERAL (`true`/`false`): the parser reads it as a boolean
    // literal, so it is grammar — never an unknown variable (which is what it
    // used to be painted as, showing a valid boolean equation entirely in red).
    if (booleanLiteralAt(tokens, i)) return { start: t.start, end: t.end, cls: "bool" };
    // A RESERVED KEYWORD (`time`): grammar (the presentation clock), painted like
    // the `self` keyword (both are reserved-keyword suggestions in equationSuggest)
    // — never an unknown variable, which is what it used to be flagged as.
    if (reservedKeywordAt(tokens, i)) return { start: t.start, end: t.end, cls: "self" };
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
      // A PROJECT SCRIPT export counts as existing, in the same precedence order the
      // evaluator uses (a real variable first, an export second), so the paint and
      // the value can never disagree.
      if (d.kind === "var" && !(d.name in vars) && !(scriptExports && d.name in scriptExports))
        return { start: t.start, end: t.end, cls: "error" };
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
 * @example parseExpression("time % 12.5") // {kind: "bin", op: "%", left: {kind: "ref", name: "time", start: 0, end: 4}, right: {kind: "num", value: 12.5}}
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
    while ((op = takeOp("*", "/", "%"))) node = { kind: "bin", op, left: node, right: factor() };
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
      // var). A following "(" still makes it a call name (never a bool). The
      // test lives in booleanLiteralAt so the mappers and the highlighter apply
      // the IDENTICAL rule.
      if (booleanLiteralAt(tokens, pos - 1)) return { kind: "bool", value: RESERVED_LITERALS.get(tok.value) };
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
 * @example evalAst(parseExpression("7 % 3"), () => 0) // 1 (modulo)
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
        case "%": return a % b; // modulo (same tier as * and /); powers `time % length`
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
  // GEOMETRY. The one arity is four NUMBERS, not (point, point): the grammar has
  // no vector primitive — `self.position` is R6-16.2, deliberately plan-only —
  // and a `widget` param is reserved for the rim SOLVE, which returns a point,
  // not a scalar. So the user's "angle2 of self position, flare.x, flare.y" is
  // spelled `direction2(self.x, self.y, flare.x, flare.y)` today, and gains the
  // shorter spelling for free the day vectors land.
  direction2: {
    doc: "The heading in degrees from one point to another — aim a widget or a material's light at something.",
    overloads: [{ params: ["number", "number", "number", "number"] }],
    impl: direction2,
  },
};

/**
 * Pure function. The HEADING IN DEGREES from (fromX, fromY) to (toX, toY), in the
 * app's ONE angle convention: 0° is +x (right), 90° is +y (screen DOWN), wrapped
 * to [0, 360). DEGREES because that is what an `angle` property and a material's
 * `angle` knob both STORE (radians are `rotation`'s private business, behind a
 * display unit) — so this drops straight into the slot it exists to drive.
 *
 * Built on core/properties.js linearEndpointsToAngle — the gradient dial's own
 * math — rather than a second atan2, so the function library and the dial can
 * never disagree about which way 90° points. A degenerate zero-length direction
 * is 0°, which is atan2(0, 0)'s answer and not a special case.
 *
 * @param {number} fromX - the origin's x, in the same space as the target
 * @param {number} fromY - the origin's y
 * @param {number} toX - the target's x
 * @param {number} toY - the target's y
 * @returns {number} degrees in [0, 360)
 *
 * @example direction2(0, 0, 1, 0) // 0 (due right)
 * @example direction2(0, 0, 0, 1) // 90 (down the screen)
 * @example direction2(0, 0, 0, -1) // 270 (up — wrapped, never -90)
 * @example direction2(10, 10, 20, 20) // 45
 * @example // = direction2(self.x, self.y, flare.x, flare.y)  — aim a light at another widget
 */
function direction2(fromX, fromY, toX, toY) {
  return linearEndpointsToAngle({ x: fromX, y: fromY }, { x: toX, y: toY });
}

/**
 * Pure function. The function-library names, for equation autocomplete (the ONE
 * exported list — manifest EQUATION DISCOVERABILITY: "expose the function table
 * for equationSuggest"). Each entry is a ready-to-type stub with its first
 * overload's arity, e.g. "closest_to_rim(" — the caller appends args.
 *
 * @example equationFunctionNames() // ["closest_to_rim", "text_dissolve", "text_type", "text_scramble", "direction2"]
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

// A variable name — and the head of every bare reference token: the ONE spelling
// rule, shared by the resolver's "is this even a token" guard and the rename's
// entry check, so the two can never disagree about what a name is.
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Pure function. Resolves ONE reference token (display or stored form) to a
 * descriptor: {kind: "var", name} | {kind: "prop", itemId, path} |
 * {kind: "anchor", itemId, anchorId, coord} | {kind: "keyword", name} (a reserved
 * host identifier — `time`). Throws with a helpful message
 * when nothing matches. `slugs` is a slugMap(state). `selfId` (optional) is
 * the owner item's id, enabling `self.…` references.
 *
 * A TOKEN, NOT A SOURCE. A dotless token used to be handed back as a variable
 * named whatever it happened to be, so a caller that passed a whole equation
 * SOURCE got `{kind: "var", name: "= speed"}` — a variable that cannot exist —
 * and, because callers treat an unresolved reference as "not a variable", the
 * feature keyed off it silently vanished instead of failing. That is what
 * NumericField's reference SCRUBBER did for every `= speed` value. A name that is
 * not an identifier is now a loud error, which catches the whole category (the
 * "=" marker is the common case, but any source-where-a-token-belongs mistake
 * lands here) rather than one caller of it.
 *
 * @example resolveRef("speed", slugMap({items: {}})) // {kind: "var", name: "speed"}
 * @example resolveRef("box.x", slugMap({items: {a1: {type: "rect", name: "Box"}}})) // {kind: "prop", itemId: "a1", path: ["x"]}
 * @example resolveRef("box_tm.x", slugMap({items: {a1: {type: "rect", name: "Box"}}})) // {kind: "anchor", itemId: "a1", anchorId: "tm", coord: "x"}
 * @example resolveRef("self.w", slugMap({items: {}}), "a1") // {kind: "prop", itemId: "a1", path: ["w"]}
 * @example resolveRef("time", slugMap({items: {}})) // {kind: "keyword", name: "time"}
 * @example // resolveRef("= speed", slugMap({items: {}})) throws: "= speed" is not one reference token
 */
export function resolveRef(token, slugs, selfId = null) {
  if (token.startsWith("@")) return parseStoredRef(token);
  if (token === "self" || token.startsWith("self.")) return parseSelfRef(token, selfId);
  // A reserved KEYWORD (`time`) — the scope proxy resolves it to a host value, not
  // a variable (see RESERVED_KEYWORDS). Its display and stored forms are identical.
  if (RESERVED_KEYWORDS.has(token)) return { kind: "keyword", name: token };
  const [head, ...path] = token.split(".");
  if (path.length === 0) {
    if (!IDENTIFIER_RE.test(token))
      throw new Error(`"${token}" is not one reference token — a variable name must be an identifier (a whole equation source, "=" marker and all, is not a token: split it first)`);
    return { kind: "var", name: token };
  }
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
 * it is left verbatim (the mapper is never called for it). The RESERVED
 * LITERALS `true`/`false` are grammar too (booleanLiteralAt — the parser reads
 * them as boolean literals), so they are likewise left verbatim: without this,
 * displayToStored resolved them as variables and threw `Unknown variable
 * "true"`, which made a boolean equation impossible to store. A function NAME
 * ref (before "(") IS passed to the mapper — the mapper decides what to do with
 * it (displayToStored/storedToDisplay pass known function names through
 * verbatim).
 *
 * THE UNIVERSAL "=" MARKER IS SPLIT OFF AND REJOINED (withMarkerPreserved) — so
 * EVERY rewriter built on this one (withVariableRenamed's rename,
 * withItemRefsRemapped's clone re-pointing, displayToStored) handles the marker
 * form without knowing it exists. This is the seam rather than each caller,
 * because the tokenizer cannot take the marker itself (Tokenizer header) and
 * because a per-caller split is what silently skipped `= speed * 2` on rename.
 *
 * @example mapRefTokens("a + b", (t) => t.toUpperCase()) // "A + B"
 * @example mapRefTokens("f(a).x", (t) => t.toUpperCase()) // "F(A).x" (name + arg mapped; the projection .x is grammar, untouched)
 * @example mapRefTokens("a + b", (v, tok) => `${v}@${tok.start}`) // "a@0 + b@4" (mapper gets the token for its span)
 * @example mapRefTokens("true", (t) => t.toUpperCase()) // "true" (a reserved literal is grammar, never mapped)
 * @example mapRefTokens("time % 2", (t) => t.toUpperCase()) // "time % 2" (the `time` keyword is grammar, never mapped)
 * @example mapRefTokens("= a + b", (t) => t.toUpperCase()) // "= A + B" (the marker survives; token spans stay relative to the body)
 */
export function mapRefTokens(src, mapToken) {
  return withMarkerPreserved(src, (body) => {
    let out = "";
    let last = 0;
    const tokens = tokenize(body);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind !== "ref") continue;
      if (tokens[i - 1]?.kind === "dot") continue; // member projection coord (.x/.y): grammar, not a ref
      if (booleanLiteralAt(tokens, i)) continue; // reserved literal (true/false): grammar, not a ref
      if (reservedKeywordAt(tokens, i)) continue; // reserved keyword (time): grammar, not a ref
      out += body.slice(last, t.start) + mapToken(t.value, t);
      last = t.end;
    }
    return out + body.slice(last);
  });
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
 * @example displayToStored("=true", {items: {}}) // "true" (a reserved literal is grammar, not an unknown variable)
 * @example displayToStored("time % 12.5", {items: {}}) // "time % 12.5" (the `time` keyword + `%` operator both round-trip; NOT an unknown variable)
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
 * error affordance reports them) — that is a HANDOFF, not a silent failure: the
 * field's own invalid affordance is what tells the user.
 *
 * THE UNIVERSAL "=" MARKER SURVIVES (withMarkerPreserved). Without that split
 * this returned `= @a1.x` VERBATIM — the raw internal item id, on screen, in the
 * one place the user reads these strings — because the marker made the whole
 * source untokenizable and it fell into the verbatim branch above.
 *
 * @example storedToDisplay("@a1.x + 10", {items: {a1: {type: "rect", name: "Box"}}}) // "box.x + 10"
 * @example storedToDisplay("= @a1.x", {items: {a1: {type: "rect", name: "Box"}}}) // "= box.x" (marker kept, body mapped)
 * @example storedToDisplay("@a1_tm.y", {items: {a1: {type: "rect", name: "Box"}}}) // "box_tm.y"
 * @example storedToDisplay("@a1.endWidth", {items: {a1: {type: "fancy_arrow", name: "Arrow"}}}) // "arrow.end_width"
 * @example storedToDisplay("self.rotationAnchor.x") // "self.rotation_anchor.x"
 * @example storedToDisplay("closest_to_rim(@a1, @a2).x", {items: {a1: {type: "rect", name: "Box"}, a2: {type: "circle", name: "C"}}}) // "closest_to_rim(box, c).x"
 */
export function storedToDisplay(src, state) {
  return withMarkerPreserved(String(src), (body) => storedBodyToDisplay(body, state));
}

/** Pure function. storedToDisplay for a marker-FREE body (see its docs). */
function storedBodyToDisplay(src, state) {
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
 * @example isNumericSlot({defaults: {}}, ["points", 9, "x"]) // true (a DECLARED list's number field — index-independent)
 * @example isNumericSlot({defaults: {}}, ["points"]) // false (the list itself is not a number)
 * @example // isNumericSlot(rectPlugin, ["fill","material","params","rimStrength"], atmosphereRect) // true (the MATERIAL SCHEMA's default is a number)
 */
export function isNumericSlot(plugin, path, item = null) {
  const def = getPath(plugin.defaults, path);
  if (typeof def === "number") return true;
  if (typeof def === "string" && def.startsWith("self.")) return true;
  // A DECLARED LIST's numeric element field. Its kind comes from the DECLARATION,
  // so the answer does not depend on how many elements the plugin's DEFAULT list
  // happens to hold: `points.9.x` is a number slot on a five-vertex default, and
  // the legacy bare-string equation rule therefore applies uniformly across every
  // index instead of only the ones the default reaches.
  if (listSlotKind(path) === "number") return true;
  // A MATERIAL KNOB whose SCHEMA default is a number (§Material param knobs). The
  // test is on the DEFAULT's type, not on the row's `kind`, so this stays the same
  // structural rule the two branches above use — and it takes an `angle` knob with
  // it, correctly: an angle knob stores raw degrees, which is a number.
  return typeof materialParamDefaultAt(path, item) === "number";
}

// A leading "=" marks ANY property as an equation (the UNIVERSAL any-type
// affordance), regardless of its default kind. Whitespace before "=" is
// tolerated (parseExpression strips `^\s*=\s*`).
const EQ_PREFIX_RE = /^\s*=/;

/**
 * Pure function. Applies `rewrite` to an equation's BODY with the universal "="
 * MARKER split off, and rejoins the marker verbatim.
 *
 * THE ONE PLACE THE MARKER COMES OFF. The marker is not part of the expression
 * grammar (see the Tokenizer header for why it cannot be), so every rewriter that
 * hands a STORED value to tokenize() has to split it first — and every rewriter
 * that split it BY HAND instead was a silent wrong answer waiting to happen:
 * withVariableRenamed left `= speed * 2` pointing at a variable the rename had
 * just deleted, and storedToDisplay showed the raw `@a1.x` internal id in the one
 * place the user reads these strings. Both fell into their own "unparseable →
 * return it unchanged" branch, which is why neither said a word.
 *
 * BECAUSE THIS SITS INSIDE mapRefTokens AND storedToDisplay — the module's only
 * two functions that tokenize a stored value and return a rewritten SOURCE — every
 * rewriter built on them is marker-correct for free, and a new one cannot
 * reintroduce the defect by forgetting.
 *
 * NOT for the display→stored direction: displayToStored deliberately DROPS the
 * marker, because whether a committed value is an equation is the caller's
 * decision, not the converter's (see its docs).
 *
 * @example withMarkerPreserved("= @a.w / 2", (body) => body.replace("@a", "@z")) // "= @z.w / 2"
 * @example withMarkerPreserved("@a.w", (body) => body.replace("@a", "@z")) // "@z.w" (no marker: `rewrite` sees the whole source)
 * @example withMarkerPreserved("  =  @a.w", (body) => body.replace("@a", "@z")) // "  =  @z.w" (the marker's spacing survives; the body keeps its own)
 * @example withMarkerPreserved("=1", (body) => `(${body})`) // "=(1)"
 */
export function withMarkerPreserved(src, rewrite) {
  const marker = EQ_PREFIX_RE.exec(src)?.[0] ?? "";
  return marker + rewrite(src.slice(marker.length));
}

/**
 * Pure function. Does this stored string value declare an equation? Either the
 * UNIVERSAL leading "=" (any-type: color/string/bool/enum/number), OR — for
 * back-compat — a bare string in a legacy NUMERIC slot (isNumericSlot).
 *
 * @example isEquationValue({defaults: {fill: "#000"}}, ["fill"], "=#ff0000") // true (universal "=")
 * @example isEquationValue({defaults: {fill: "#000"}}, ["fill"], "#ff0000") // false (literal color, not an equation)
 * @example isEquationValue({defaults: {x: 0}}, ["x"], "speed * 2") // true (legacy numeric slot)
 * @example isEquationValue({defaults: {name: "?"}}, ["name"], "Box") // false (plain string)
 * @example // isEquationValue(rectPlugin, ["fill","material","params","rimStrength"], "time", atmosphereRect) // true (a MATERIAL KNOB is a legacy numeric slot too — see isNumericSlot)
 *
 * `item` (the FOLDED item state) is OPTIONAL and only ever WIDENS the answer: it
 * is what lets a MATERIAL KNOB be recognised (§Material param knobs), and a
 * caller that has no item in hand — the ones walking a plugin's declarations
 * rather than a document's items — gets exactly the pre-material behaviour.
 */
export function isEquationValue(plugin, path, value, item = null) {
  if (typeof value !== "string") return false;
  // PER-ITEM VARIABLES (manifest item 67): any string under an item's `vars`
  // dict is a numeric equation BY FIAT — the same rule state.vars obeys, one
  // level deeper. No plugin declares `vars` in its defaults, so isNumericSlot
  // below cannot see it; without this line a bare-string per-item var ("0.5",
  // "@b.x") is invisible to every consumer that walks an item's equation slots
  // through this predicate — the paste ref-remap (clonedItemStates), the
  // variable-rename ref rewrite (withVariableRenamed), and the make-static
  // equation-keyframe scans. Slot COLLECTION does NOT rely on this (it has its
  // own dedicated vars loop that forces kind "number" for "="-prefixed vars).
  if (path[0] === "vars") return true;
  return EQ_PREFIX_RE.test(value) || isNumericSlot(plugin, path, item);
}

// PROPS.kind (an INSPECTOR CONTROL kind) → the JS RESULT TYPE an `=` equation
// must evaluate to. "string" covers text/select(enum)/asset — all string-valued;
// "select" adds an in-set check on top (see resultMatchesKind, which reads the
// row's options). "angle" is a heading in RAW DEGREES (core/properties.js: an
// angle kind stores degrees, unlike `rotation`, which is radians with a display
// unit), so it validates as a plain number. The control vocabulary itself is
// core/properties.js ROW_KINDS.
// "list" is its OWN result type, not a coercion of any scalar one: an `=` on a
// whole list must evaluate to an ARRAY of the declared element shape. WHAT SUCH
// AN EQUATION MEANS: the grammar has no array literal, so the only list-valued
// expression it can produce is a REFERENCE to another list slot — `= other.points`
// mirrors one polygon's vertices onto another, `= other.fill.linear.stops` shares
// one gradient's ramp. That is a real, useful binding and it needs no grammar
// change; validation is Array.isArray PLUS a per-element shape check
// (listResultProblem), so a wrong-shaped list is reported rather than rendered.
// A per-ELEMENT slot (`points.3.x`) types as its declared field kind instead —
// see resultKindForSlot / core/lists.js listPathKind.
const KIND_RESULT = {
  number: "number", angle: "number",
  color: "color",
  boolean: "boolean",
  select: "select",
  asset: "string", text: "string",
  [LIST_ROW_KIND]: "list",
};

// LOUD IMPORT-TIME GUARD (the render_settings.js ANTIALIAS_MODES precedent): a
// kind declared in PROPS but missing from KIND_RESULT used to resolve to
// "string" through a `?? "string"` fallback, so a perfectly good numeric result
// was rejected with "is not a valid string value" — a silent wrong-kind guess,
// which is exactly the class of fallback the house rules forbid. Cross-checking
// at import makes the gap impossible to ship instead of merely unlikely: adding
// a kind to core/properties.js without typing it here fails immediately, with
// the fix in the message.
for (const [key, def] of Object.entries(PROPS))
  if (!(def.kind in KIND_RESULT))
    throw new Error(`expressions: PROPS."${key}" declares kind "${def.kind}" but KIND_RESULT does not type it — add its equation RESULT type (one of ${JSON.stringify([...new Set(Object.values(KIND_RESULT))])}) so "=" on that property can be validated.`);

// ── PAINT SUB-STATE kinds ────────────────────────────────────────────────────
//
// A `paint: true` property (PROPS fill / stroke / background) is the ONE
// polymorphic value shape in item state: it does not store a scalar, it stores
// the multi-sub-state record web/PaintField.svelte materializes —
//   {type, solid, linear: {stops, angle, from, to}, radial: {stops, center, r}}
// (a paint that has never been a gradient stays a bare hex STRING). Its LEAVES
// are real keyframable, equation-bindable slots, but the plugin's `defaults`
// for the paint key is that bare hex string, so getPath() finds NOTHING at
// e.g. ["fill","linear","angle"] and the kind cannot be inferred from the
// plugin at all. These two tables type them instead, keyed by the sub-path
// BELOW the paint key. Gradient STOPS are NO LONGER absent: they are a declared
// LIST property (core/properties.js GRADIENT_STOPS_LIST, resolved by listDeclAt
// below), so a stop's offset/color IS an equation slot and so is its visibility
// flag. (The old bound recorded here — "stops are ARRAY elements and leaves()
// keeps arrays opaque, so a stop offset/color is never an equation slot" — was
// the Tier 0 hole this round closed; leaves() still keeps arrays opaque and the
// list DECLARATION is what reaches inside.)
//
// HOME: this describes the paint shape, so it belongs beside the `paint: true`
// flag and the gradient-direction math in core/properties.js. It lives here
// only because that file was owned by another agent when it was written — MOVE IT
// there (exported from properties.js, imported here) as a self-contained cleanup;
// the stop LIST declaration already lives there for exactly that reason.
const PAINT_MODE_KEYS = ["linear", "radial"]; // the two gradient sub-state wrappers
const PAINT_LEAF_KINDS = {
  // Which mode is painted. A string id ("none" | "solid" | "linearGradient" |
  // "radialGradient" | "material"); core has no options list for it, so it
  // validates as a plain string rather than a select with a fake (empty) option
  // set. "none" is the OFF paint (render_gpu/ir.js PAINT_NONE_TYPE): it paints
  // NOTHING, and being a `type` value rather than a separate boolean is what makes
  // it equation-visible here for free — `= fill.type == "none"` reads it like any
  // other leaf, and an equation MAY write it.
  type: "string",
  solid: "color",          // the solid sub-state's color
  angle: "number",         // linear direction, DEGREES (properties.angleToLinearEndpoints)
  r: "number",             // radial radius, objectBoundingBox units
  "center.x": "number", "center.y": "number", // radial center, objectBoundingBox
  // Legacy linear endpoints. Superseded by `angle` but still stored (the
  // migration keeps them so old documents render byte-identically).
  "from.x": "number", "from.y": "number",
  "to.x": "number", "to.y": "number",
};

/**
 * Pure function. The result kind of a leaf INSIDE a paint property's
 * sub-state, or null when `path` is not such a leaf. The optional `linear`/
 * `radial` mode segment is stripped first, so both the current wrapped form
 * (fill.linear.angle) and the LEGACY inline form the angle migration also
 * writes (fill.angle — core/document.js linearGradientAngleMigrations returns
 * relPath ["fill"] for an un-wrapped gradient) resolve identically.
 *
 * @example paintSubKind(["fill", "linear", "angle"]) // "number"
 * @example paintSubKind(["background", "angle"]) // "number" (legacy inline gradient)
 * @example paintSubKind(["stroke", "radial", "center", "x"]) // "number"
 * @example paintSubKind(["fill", "solid"]) // "color"
 * @example paintSubKind(["fill"]) // null (the paint itself — PROPS types it)
 * @example paintSubKind(["shadow", "color"]) // null (a plain color prop, not a paint)
 */
function paintSubKind(path) {
  if (!PROPS[path[0]]?.paint) return null; // every paint: true key is single-segment
  const rest = path.slice(1);
  const leaf = PAINT_MODE_KEYS.includes(rest[0]) ? rest.slice(1) : rest;
  return leaf.length ? PAINT_LEAF_KINDS[leaf.join(".")] ?? null : null;
}

// ── MATERIAL PARAM knobs (the paint's fourth sub-state) ──────────────────────
//
// A paint may hold a MATERIAL: {type: "material", material: {id, params}}, whose
// KNOBS live at `<paint>.material.params.<name>`. They are real keyframable,
// equation-bindable slots — but unlike every other slot in this file their kind
// and their default are declared in the MATERIAL REGISTRY (a descriptor's
// `fillParams`, or `strokeParams` on a stroke slot), not in `plugin.defaults`,
// whose entry for the paint key is a bare hex string. `params` is also SPARSE by
// contract ("no state until written"), so there is nothing at the path to infer
// from either.
//
// THAT IS WHY THESE TAKE THE FOLDED `item`: the plugin alone cannot answer, and
// the stored `material.id` is what names the schema. It is the SAME resolution
// web/PaintField.svelte's matEntry/matValue perform to draw the knob rows, read
// from the SAME registry — so the field and core cannot disagree about a knob's
// kind, which is exactly the hand-maintained-mirror hazard this codebase keeps
// paying for.
//
// THE DEFECT THIS CLOSES (R6-7): without it resultKindForSlot typed all 299
// built-in knobs across 22 materials UNRESOLVED — so `=` was refused on every one
// — and fallbackFor wrote 0 instead of the schema default, so an equation forced
// in by hand evaluated to a silent zero. isNumericSlot needs it too, and for a
// reason only the UI shows: NumericField commits through displayToStored, which
// DROPS the `=` marker, so a knob that is not a NUMERIC slot stores the stripped
// text as a silent literal string.
//
// `strokeParams ?? fillParams` is materials.js materialParamDefaults' own rule,
// restated rather than imported because that function is private there.
const MATERIAL_KEY = "material";
const MATERIAL_PARAMS_KEY = "params";
/** [paintKey, "material", "params", knobName] — the only shape that is a knob. */
const MATERIAL_PARAM_PATH_LEN = 4;

/**
 * Query (reads the two paint-material registries). The registry entry a material
 * id names — a STROKE entry when the stroke registry claims the id, else the FILL
 * descriptor, else null for an id neither registry knows. Non-throwing on
 * purpose: an unknown id here means "this is not a knob slot", which is a
 * question, not a fault (the LOUD refusal for a real paint belongs to
 * materials.resolveMaterialPaint, which renders it).
 *
 * @example materialEntryFor("atmosphere").id // "atmosphere"
 * @example materialEntryFor("wavy").id // "wavy" (the stroke registry)
 * @example materialEntryFor("nope") // null
 */
function materialEntryFor(id) {
  if (typeof id !== "string") return null;
  if (hasStrokeMaterial(id)) return getStrokeMaterial(id);
  return materialIds().includes(id) ? getMaterial(id) : null;
}

/**
 * Query (reads the material registries). The material knob SCHEMA ROW a state
 * path addresses on `item`, or null when the path is not a knob (or `item` is
 * absent, or its paint holds no known material). `path` is relative to the item.
 *
 * @param {string[]} path - e.g. ["fill", "material", "params", "rimStrength"]
 * @param {object|null} item - the FOLDED item state, whose paint carries the id
 * @returns {object|null} the schema row {name, kind, default, min?, max?, …}
 *
 * @example // materialParamRow(["fill", "material", "params", "rimStrength"], atmosphereRect).kind // "number"
 * @example // materialParamRow(["fill", "material", "params", "nope"], atmosphereRect) // null
 * @example // materialParamRow(["fill", "solid"], atmosphereRect) // null (not a knob)
 */
function materialParamRow(path, item) {
  if (!item || path.length !== MATERIAL_PARAM_PATH_LEN) return null;
  if (!PROPS[path[0]]?.paint) return null;
  if (path[1] !== MATERIAL_KEY || path[2] !== MATERIAL_PARAMS_KEY) return null;
  const entry = materialEntryFor(item[path[0]]?.material?.id);
  const schema = entry?.strokeParams ?? entry?.fillParams;
  if (!Array.isArray(schema)) return null;
  return schema.find((row) => row.name === path[3]) ?? null;
}

/**
 * Query (reads the material registries). A material knob's SCHEMA DEFAULT, or
 * undefined when the path is not a knob — the value a sparse (never-written) knob
 * resolves to at render time, and therefore the ONLY correct fallback when its
 * equation fails. `undefined` rather than null so a caller's `??` chain treats
 * "not a knob" and "no such knob" alike, and a knob whose declared default IS
 * null still reads as declared.
 *
 * EXPORTED for the KEYFRAME UPSERT (web/app.svelte.js storedValueAtPath): a new
 * keyframe copies the value the slot currently holds, and for a sparse knob that
 * value lives here and nowhere else — without it the ◆ would key `undefined` and
 * read as a control that does nothing.
 *
 * @example // materialParamDefaultAt(["fill", "material", "params", "rimStrength"], atmosphereRect) // 0.85
 * @example // materialParamDefaultAt(["w"], atmosphereRect) // undefined
 */
export function materialParamDefaultAt(path, item) {
  const row = materialParamRow(path, item);
  return row ? row.default : undefined;
}

// ── LIST PROPERTIES (core/lists.js) ──────────────────────────────────────────
//
// The DECLARED lists a state path can land in, and their visibility companions.
// Two sources, exactly mirroring resultKindForSlot's own resolution order: the
// shared property registry (a PROPS entry whose kind is "list" — `points`), and
// the paint sub-state (GRADIENT_STOPS_LIST under fill/stroke/background
// .linear|.radial .stops). Both are DECLARATIONS: nothing reaches inside an
// UNDECLARED array, so adding a declaration is the one explicit act that opens a
// list's elements to `=` — a rich-text run list or a frame-URL list does not
// silently gain equation semantics.
const LIST_PROPS = Object.fromEntries(Object.entries(PROPS).filter(([, def]) => def.kind === LIST_ROW_KIND));
/** activeKey → the list key whose visibility companion it is. */
const LIST_COMPANIONS = Object.fromEntries(Object.entries(LIST_PROPS).map(([key, def]) => [def.activeKey, key]));

/**
 * Pure function. The LIST DECLARATION a state path lands in, or null:
 * {decl, rel, companion} where `rel` is the path BELOW the list key (or below the
 * companion key) and `companion` says which of the two the path addressed.
 * Longest prefix wins, so a dotted list key would resolve ahead of its own head.
 *
 * @example listDeclAt(["points"]).rel // []
 * @example listDeclAt(["points", 3, "x"]).rel // [3, "x"]
 * @example listDeclAt(["pointsActive", 2]).companion // true
 * @example listDeclAt(["fill", "linear", "stops", 1, "offset"]).rel // [1, "offset"]
 * @example listDeclAt(["fill", "linear", "stopsActive", 1]).companion // true
 * @example listDeclAt(["w"]) // null
 */
export function listDeclAt(path) {
  for (let n = path.length; n >= 1; n--) {
    const key = path.slice(0, n).join(".");
    if (LIST_PROPS[key]) return { decl: LIST_PROPS[key], rel: path.slice(n), companion: false };
    if (LIST_COMPANIONS[key]) return { decl: LIST_PROPS[LIST_COMPANIONS[key]], rel: path.slice(n), companion: true };
  }
  if (!PROPS[path[0]]?.paint) return null;
  const rest = path.slice(1);
  const leaf = PAINT_MODE_KEYS.includes(rest[0]) ? rest.slice(1) : rest;
  const head = path.length - leaf.length;
  if (leaf[0] === "stops") return { decl: GRADIENT_STOPS_LIST, rel: path.slice(head + 1), companion: false };
  if (leaf[0] === GRADIENT_STOPS_LIST.activeKey) return { decl: GRADIENT_STOPS_LIST, rel: path.slice(head + 1), companion: true };
  return null;
}

/**
 * Pure function. The result kind of a slot at/inside a DECLARED list, or null
 * when the path lands in no list. The list itself is "list"; an element FIELD is
 * its declared kind (from the DECLARATION, so index-independent); a whole ELEMENT
 * is null (it has no declared kind of its own — its fields do, so an `=` there
 * stays UNRESOLVED and says so); the visibility companion is a "list" of
 * "boolean" flags.
 *
 * @example listSlotKind(["points"]) // "list"
 * @example listSlotKind(["points", 3, "x"]) // "number" (canonical named field)
 * @example listSlotKind(["points", 3, 0]) // "number" (storage spelling — same slot)
 * @example listSlotKind(["points", 3]) // null (a whole element is not a slot)
 * @example listSlotKind(["pointsActive", 2]) // "boolean"
 * @example listSlotKind(["fill", "linear", "stops", 0, "color"]) // "color"
 * @example listSlotKind(["opacity"]) // null
 */
export function listSlotKind(path) {
  const found = listDeclAt(path);
  if (!found) return null;
  if (!found.companion) return listPathKind(found.decl, found.rel);
  if (found.rel.length === 0) return KIND_RESULT[LIST_ROW_KIND]; // the whole flag list
  return found.rel.length === 1 ? ACTIVE_FIELD.kind : null;
}

/**
 * Pure function. A stored property path with a DECLARED-LIST element field
 * segment converted from its canonical NAME to its STORAGE key
 * (`points.3.x` → points[3][0]) — the ONE place an equation reference crosses
 * that boundary. A path touching no list, or one already spelled with the raw
 * storage index, is returned UNCHANGED: an index was always walkable (getPath
 * descends arrays), so this adds the named spelling rather than aliasing it.
 *
 * @example storedListPath(["points", "3", "x"]) // ["points", "3", 0]
 * @example storedListPath(["points", "3", "0"]) // ["points", "3", "0"] (raw index: already storage)
 * @example storedListPath(["fill", "linear", "stops", "1", "offset"]) // ["fill", "linear", "stops", "1", "offset"] (a record: name IS the key)
 * @example storedListPath(["w"]) // ["w"]
 */
export function storedListPath(path) {
  const found = listDeclAt(path);
  if (!found || found.companion || found.rel.length !== 2) return path;
  if (elementFieldKind(found.decl.element, found.rel[1]) === null) return path;
  return [...path.slice(0, -1), elementStorageKey(found.decl.element, found.rel[1])];
}

/**
 * The result kind of a slot whose value kind NOTHING declares — no PROPS entry,
 * no plugin default, no paint sub-state entry. It is deliberately a kind that
 * resultMatchesKind never matches (its `default` case), so the equation FAILS
 * LOUDLY through the normal report-and-fall-back path with an actionable
 * message, instead of being guessed as "string" and rejecting a good value.
 */
const UNRESOLVED_KIND = "unresolved";

/**
 * Pure function. The RESULT TYPE an equation slot must evaluate to. Variables
 * and legacy (non-"=") numeric slots are "number" — byte-identical to the
 * pre-any-type engine. For a UNIVERSAL "=" slot the kind is resolved in this
 * order, most-declared first:
 *   1. PROPS[key].kind through KIND_RESULT (the shared property registry — the
 *      manifest's single source of truth; the import guard above keeps every
 *      declared kind typed here).
 *   2. listSlotKind(path) — a slot at or inside a DECLARED LIST (core/lists.js):
 *      the list itself is "list", an element FIELD is its declared kind, the
 *      visibility companion's flags are "boolean". Taken from the DECLARATION, so
 *      it is INDEX-INDEPENDENT — which is the point: reading the kind off the
 *      plugin's default list (step 3) runs out of elements, so `points.9.x` on a
 *      five-vertex default used to fall all the way to UNRESOLVED.
 *   3. paintSubKind(path) — a leaf inside a paint property's sub-state, whose
 *      shape the plugin's flat hex default cannot describe.
 *   4. materialParamRow(path, item) — a MATERIAL KNOB, whose kind is declared in
 *      the material REGISTRY rather than by the plugin (§Material param knobs).
 *      Needs the FOLDED ITEM, because the stored material id is what names the
 *      schema. A knob whose declared kind KIND_RESULT does not type falls to
 *      UNRESOLVED rather than being guessed, exactly like an undeclared slot —
 *      the LOUD-import-guard treatment PROPS gets is unavailable here, because
 *      core/material_plugins.js (which owns MATERIAL_PARAM_KINDS) imports
 *      core/plugin_assets.js, which imports THIS file: reading that set at
 *      module-evaluation time would run inside the cycle.
 *   5. INFERRED from the plugin's own default at the path: a NUMERIC slot
 *      (isNumericSlot — a number, or a "self."-prefixed COMPUTED default such
 *      as magnifier `origin.x`) is "number"; else boolean, else a hex-vs-plain
 *      string → color/string.
 *   6. UNRESOLVED — nothing declares this slot's kind. It is NOT guessed:
 *      evaluation reports it loudly and falls back, because a wrong guess
 *      silently rejects a correct value (that is the bug this order fixes).
 *
 * @example resultKindForSlot({defaults: {x: 0}}, ["x"], "speed * 2") // "number" (legacy)
 * @example resultKindForSlot({defaults: {fill: "#000"}}, ["fill"], "=#f00") // "color" (PROPS.fill.kind)
 * @example resultKindForSlot({defaults: {muted: true}}, ["muted"], "=true") // "boolean"
 * @example resultKindForSlot({defaults: {foo: "bar"}}, ["foo"], "=\"x\"") // "string" (inferred: non-hex default)
 * @example resultKindForSlot({defaults: {fill: "#000"}}, ["fill", "linear", "angle"], "=30") // "number" (gradient direction, degrees)
 * @example resultKindForSlot({defaults: {origin: {x: "self.anchors.center.x"}}}, ["origin", "x"], "=self.w") // "number" (computed self. default)
 * @example resultKindForSlot({defaults: {}}, ["mystery"], "=1") // "unresolved" (nothing declares its kind — reported, never guessed)
 * @example resultKindForSlot({defaults: {}}, ["points"], "= other_poly.points") // "list" (a whole list, bound by reference)
 * @example resultKindForSlot({defaults: {}}, ["points", 9, "x"], "= self.w / 2") // "number" (declared element field; index-independent)
 * @example resultKindForSlot({defaults: {}}, ["points", 9], "= 1") // "unresolved" (a whole ELEMENT is not a slot — bind its fields)
 * @example resultKindForSlot({defaults: {}}, ["pointsActive", 2], "= false") // "boolean" (per-element visibility)
 * @example // resultKindForSlot(rectPlugin, ["fill","material","params","glowColor"], "= #f00", atmosphereRect) // "color" (the MATERIAL SCHEMA's kind)
 */
export function resultKindForSlot(plugin, path, value, item = null) {
  if (!EQ_PREFIX_RE.test(value)) return "number"; // legacy numeric / self-anchor slot
  const propDef = PROPS[path.join(".")];
  if (propDef) return KIND_RESULT[propDef.kind];
  const listed = listSlotKind(path);
  if (listed) return listed;
  const painted = paintSubKind(path);
  if (painted) return painted;
  const knob = materialParamRow(path, item);
  if (knob) return KIND_RESULT[knob.kind] ?? UNRESOLVED_KIND;
  if (isNumericSlot(plugin, path, item)) return "number";
  const def = getPath(plugin.defaults, path);
  if (typeof def === "boolean") return "boolean";
  if (typeof def === "string") return isHexColor(def) ? "color" : "string";
  return UNRESOLVED_KIND;
}

/**
 * Pure function. Does an evaluated value `v` satisfy the expected result kind?
 * The LOUD-fallback gate for any-type equations: a "=" expr whose result type
 * mismatches its property is reported and replaced by the default (never a
 * silent bad value). `options` (a select row's allowed set) narrows "select".
 * An UNKNOWN kind — including resultKindForSlot's "unresolved" — matches
 * NOTHING, so an undeclared slot can never quietly accept a value.
 *
 * @example resultMatchesKind(5, "number") // true
 * @example resultMatchesKind(Infinity, "number") // false (non-finite)
 * @example resultMatchesKind("#ff0000", "color") // true
 * @example resultMatchesKind("nope", "color") // false (not a hex color)
 * @example resultMatchesKind(true, "boolean") // true
 * @example resultMatchesKind("multiply", "select", ["normal", "multiply"]) // true
 * @example resultMatchesKind("zzz", "select", ["normal", "multiply"]) // false (not an option)
 * @example resultMatchesKind(30, "unresolved") // false (an undeclared slot matches nothing)
 * @example resultMatchesKind([[0, 0], [1, 1]], "list") // true (shape checked separately — listResultProblem)
 * @example resultMatchesKind(5, "list") // false
 */
export function resultMatchesKind(v, kind, options = null) {
  switch (kind) {
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "color": return isHexColor(v);
    case "boolean": return typeof v === "boolean";
    case "select": return typeof v === "string" && (!options || options.includes(v));
    case "string": return typeof v === "string";
    // A LIST is an array; its ELEMENT SHAPE is checked by listResultProblem,
    // which needs the declaration this signature does not carry (and which
    // reports WHICH element/field is wrong instead of a bare false).
    case "list": return Array.isArray(v);
    default: return false;
  }
}

/**
 * Pure function. Why `value` is not a valid value for list `decl` — a specific,
 * actionable message — or null when it is fine. The element-shape half of
 * validating a whole-list `=` equation (resultMatchesKind only proves it is an
 * array), kept loud and specific because "is not a valid list value" would not
 * tell an author which element they got wrong.
 *
 * @example listResultProblem({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, [[0], [1]]) // null
 * @example listResultProblem({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, 5) // "is not a list"
 * @example listResultProblem({element: {storage: "tuple", fields: [{name: "x", kind: "number"}]}}, [[0], ["nope"]]) // 'element 1\'s "x" is "nope", not a valid number'
 * @example listResultProblem({element: {storage: "record", fields: [{name: "offset", kind: "number"}]}, minLength: 2}, [{offset: 0}]) // "has 1 element, below the declared minimum of 2"
 */
export function listResultProblem(decl, value) {
  if (!Array.isArray(value)) return "is not a list";
  const floor = decl.minLength ?? 0;
  if (value.length < floor)
    return `has ${value.length} element${value.length === 1 ? "" : "s"}, below the declared minimum of ${floor}`;
  for (let i = 0; i < value.length; i++) {
    const el = value[i];
    const shaped = decl.element.storage === "tuple" ? Array.isArray(el) : isTree(el);
    if (!shaped) return `element ${i} is ${JSON.stringify(el)}, not a ${decl.element.storage}`;
    for (const field of decl.element.fields) {
      const fv = elementFieldValue(decl.element, el, field.name);
      if (!resultMatchesKind(fv, KIND_RESULT[field.kind]))
        return `element ${i}'s "${field.name}" is ${JSON.stringify(fv)}, not a valid ${field.kind}`;
    }
  }
  return null;
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
 * @example numericPropertyPaths(rectPlugin) // ["x", "y", "w", "h", "z", "rotation", "scale", "rotation_anchor.x", "rotation_anchor.y", "stroke_width", "corner_radius", "opacity", "cx", "cy"]
 * @example numericPropertyPaths(fancyArrowPlugin) // [..., "start_width", "end_width"] (camelCase startWidth/endWidth shown as snake_case; no cx/cy — an endpoint-pair widget has no box)
 */
export function numericPropertyPaths(plugin) {
  const out = [];
  for (const [path] of leaves(plugin.defaults))
    if (isNumericSlot(plugin, path)) out.push(pathToDisplay(path).join("."));
  // cx/cy: DERIVED, so they own no plugin.defaults leaf for the loop above to
  // find (refValue's dedicated branch answers them; see its comment) — appended
  // here so the "referenceable ⟹ discoverable" law this function exists to
  // enforce still holds. Only for a BBOX plugin (declares both w and h): a
  // two-point widget (arrow/line) has no box and thus no center.
  if (typeof plugin.defaults.w === "number" && typeof plugin.defaults.h === "number") out.push("cx", "cy");
  return out;
}

/**
 * Pure function. The plugin's DECLARED LIST properties, in canonical DISPLAY
 * (snake_case, dot-joined) form — the type-level companion of
 * numericPropertyPaths for a list slot's autocomplete. A list ROOT is offered
 * because it exists on EVERY instance of the type and is bindable by reference
 * (`= other_poly.points`).
 *
 * PER-ELEMENT PATHS ARE DELIBERATELY NOT HERE, and that is the type-vs-instance
 * split, not an omission: `points.4.x` exists only for an item that currently has
 * five vertices, so offering it from the plugin's DEFAULT list would suggest paths
 * that a 3-vertex polygon does not have — worse than not offering them, since a
 * reference to a missing element fails loudly. The Inspector enumerates the real
 * ones from the VALUE instead (core/lists.js listSlotPaths).
 *
 * @example listPropertyPaths({defaults: {points: [[0, 0]], w: 10}}) // ["points"]
 * @example listPropertyPaths({defaults: {w: 10}}) // [] (no list properties)
 */
export function listPropertyPaths(plugin) {
  const out = [];
  for (const key of Object.keys(plugin.defaults ?? {}))
    if (Array.isArray(plugin.defaults[key]) && LIST_PROPS[key]) out.push(pathToDisplay([key]).join("."));
  return out;
}

/**
 * Pure generator. [path, value] for every element-FIELD leaf and every
 * visibility-FLAG leaf of every DECLARED list inside `node` (an item state, or a
 * slide delta's item subtree).
 *
 * WHY THIS EXISTS RATHER THAN AN ARRAY-DESCENDING `leaves()`. core/deltas.js
 * leaves() keeps arrays OPAQUE, and it must: three consumers depend on that —
 * core/document.js missingDefaults (which would see a 3-vertex polygon as
 * "missing" the 4th and 5th vertices of the plugin's 5-vertex DEFAULT and FILL
 * them in, silently appending vertices to the user's shape), the Keyframe Panel
 * (one `points` diamond would become 2N diamonds, and a whole-list keyframe is
 * exactly the leaf that must tween element-wise), and evaluateState. Only the
 * third one wants to reach inside.
 *
 * So the descent is a SEPARATE walk, and it descends ONLY DECLARED lists: adding
 * a declaration is the one explicit act that opens a list's elements to `=`, so no
 * undeclared array (a rich-text run list, a filmstrip's frame URLs) silently gains
 * equation semantics — a run whose text happens to begin with "=" is still text.
 *
 * EXPORTED because `[...leaves(item), ...declaredListLeaves(item)]` filtered by
 * isEquationValue IS the canonical "every equation slot of one item" walk, and a
 * consumer OUTSIDE this module needs it: core/document.js clonedItemStates
 * rewrites the item references inside those slots when a selection is cloned, and
 * a per-VERTEX `@id` reference (polygon points bound to another widget's anchors)
 * lives in exactly the declared-list leaf that leaves() cannot see.
 *
 * @example // for {points: [[0, "=self.w"]], pointsActive: [true, false]} it yields
 * @example //   [["points", 0, 0], 0], [["points", 0, 1], "=self.w"],
 * @example //   [["pointsActive", 0], true], [["pointsActive", 1], false]
 */
export function* declaredListLeaves(node, prefix = []) {
  for (const [key, val] of Object.entries(node)) {
    const path = [...prefix, key];
    if (Array.isArray(val)) {
      const found = listDeclAt(path);
      if (!found || found.rel.length !== 0) continue;
      if (found.companion) {
        for (let i = 0; i < val.length; i++) yield [[...path, i], val[i]];
        continue;
      }
      for (let i = 0; i < val.length; i++) {
        const el = val[i];
        // A non-record/tuple element (someone typed an `=` where a WHOLE ELEMENT
        // goes) is yielded AS the element, so the slot is collected and fails
        // loudly with the "bind one of its fields instead" message rather than
        // being skipped and left in the value for a renderer to choke on.
        if (el === null || typeof el !== "object") { yield [[...path, i], el]; continue; }
        for (const field of found.decl.element.fields) {
          const storageKey = elementStorageKey(found.decl.element, field.name);
          if (storageKey in el) yield [[...path, i, storageKey], el[storageKey]];
        }
      }
    } else if (isTree(val)) {
      yield* declaredListLeaves(val, path);
    }
  }
}

/**
 * Command (mutates tree in place). Sets a leaf at path, creating nodes.
 *
 * ARRAY-AWARE, with COPY-ON-WRITE — the same two rules core/deltas.js setPath and
 * mutBlendApply already obey, and for the same two reasons:
 *   (1) descending an EXISTING array keeps the ARRAY shape. Rebuilding it as an
 *       object (the old `if (!isTree(...)) cur[key] = {}`) turned a `points` list
 *       into `{2: {0: 0.5}}` the moment ONE per-element equation was written,
 *       destroying every other vertex — the same class of bug deltas.setPath's
 *       docstring records for gradient stops.
 *   (2) the tree this walks is `copied(state)`, and copied() SHARES arrays
 *       (treating them as immutable leaves — the fold cache's fast path), so an
 *       in-place write into one would corrupt the cached folded state that
 *       produced it. Clone the array subtree before descending.
 */
function mutSetPath(tree, path, value) {
  let cur = tree;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (Array.isArray(cur[key])) cur[key] = copiedDeep(cur[key]);
    else if (!isTree(cur[key])) cur[key] = {};
    cur = cur[key];
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

// BOTH enter THE FLIP SEAM (core/geometry.js unsignedState) on the way in, because
// this pass runs BEFORE any render node exists and so reads RAW item state, which
// may carry a signed extent. Without it a vertically-flipped rect's rim answered its
// BOTTOM edge for a target level with its middle (measured: 70 units off on a
// 140-tall box) — closestPointOnRoundedRect clamps into [0..h] and a negative h makes
// that range empty. A rim is a question about the widget's SILHOUETTE, which a flip
// does not move, so the unsigned box is the honest input.

/** Pure function. The world-space CENTER of a bbox item (its rim's facing-seed hint). */
function rimCenter(rawItem) {
  const item = unsignedState(rawItem);
  return T.apply(worldTransform(item), (item.w ?? 0) / 2, (item.h ?? 0) / 2);
}

/**
 * Pure function (closure over the item's evaluated state). A world→world
 * closest-point map for one widget's rim: (qx, qy) → the world rim point nearest
 * (qx, qy). Throws if the plugin has no closestAnchor (not a rim widget).
 */
function rimProjector(rawItem, plugin) {
  if (!plugin.closestAnchor) throw new Error(`"${rawItem.type}" has no rim (no closestAnchor) for closest_to_rim`);
  const item = unsignedState(rawItem);
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
// back a determinism-safe host (Math WITHOUT random, the CONTROLLED presentation
// clock as `time`, a SEEDED random, and the FUNCTIONS registry), and — because
// `has` is always true — leaves NO path to the real globals
// (Date/window/globalThis/fetch resolve to undefined, so `Date.now()` throws loudly
// rather than reaching the wall clock).
//
// So evaluation is a deterministic function of (folded state, presentation clock).
// `time` is the ONLY input beyond the state, it is the app-wide controlled clock
// rather than a wall clock (frozen for every still; driven per frame by the MP4
// exporters), and a document that never writes `= time` is a pure function of the
// state alone — the RenderTree = pure(document, [[slide, alpha]]) case. This is the
// same RECORDABLE-state bargain a particle emitter or a video frame already makes.
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

/** Math with NO random (determinism): every Math member except `random`.
 *  EXPORTED for the graph* family's per-sample equation evaluator
 *  (core/graph_equation.js), which reuses this exact host rather than
 *  re-deriving a Math-sans-random (duplicating the excision risks drift). */
export const SAFE_MATH = Object.freeze(Object.fromEntries(
  Object.getOwnPropertyNames(Math)
    .filter((k) => k !== "random")
    .map((k) => [k, typeof Math[k] === "function" ? Math[k].bind(Math) : Math[k]]),
));

// Ambient globals that MUST stay unreachable (determinism + sandboxing). They
// resolve to undefined so any member use (Date.now(), window.x) throws loudly;
// `has: () => true` already blocks fall-through to the real globals, so this is
// the explicit, self-documenting half of the guard. `self` is NOT here — it is
// the owning-item keyword and is handled as a reference head.
// EXPORTED for the graph* family's per-sample evaluator, which runs equations
// against a plain (Proxy-free) scope and so must SHADOW these names to undefined
// itself to keep `with`-fall-through from reaching the real globals — reusing the
// one list here rather than maintaining a second copy that could drift.
export const BLOCKED_GLOBALS = new Set([
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

/** Does a reference token contain an all-digits path segment (a LIST element
 *  index)? `.0` is legal in the equation grammar but NOT in JavaScript, so such a
 *  token must be rewritten to bracket form before compilation. */
const NUMERIC_SEGMENT_RE = /\.\d+(?:\.|$)/;

/**
 * Pure function. One reference token → its JS-VALID spelling: a stored `@id`
 * becomes `$id` (JS-legal; the scope proxy maps it back), and an all-digits path
 * segment becomes a BRACKET index — `self.points.3.x` is valid in the equation
 * grammar but `a.3` is a JavaScript syntax error, so it compiles as
 * `self.points[3].x`. The ref PROXY accumulates a bracket access exactly like a
 * dot access, so the segment list (and therefore the resolved reference) is
 * identical either way.
 *
 * @example refToJs("@a1.x") // "$a1.x"
 * @example refToJs("self.points.3.x") // "self.points[3].x"
 * @example refToJs("fill.linear.stops.1.offset") // "fill.linear.stops[1].offset"
 * @example refToJs("speed") // "speed"
 */
function refToJs(value) {
  const head = value[0] === "@" ? `$${value.slice(1)}` : value;
  const [first, ...rest] = head.split(".");
  return first + rest.map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`)).join("");
}

/**
 * Pure function. Rewrites a restricted-grammar equation into a JS-VALID
 * expression: `#hex` color literals → quoted strings, stored `@id` item
 * refs → `$id` identifiers (JS-legal; the scope proxy maps `$id` back to `@id`),
 * and LIST ELEMENT INDEX segments → bracket form (`points.3.x` → `points[3].x`,
 * which JS requires). Bare display slugs (`shape_2.x`), variables, `self.…`, and
 * function calls are already JS-valid and pass through. A source that is NOT
 * restricted-grammar tokenizable (a full-JS expression — IIFE/loop/etc.) is
 * returned verbatim.
 *
 * @example toJsExpr("@a1.x + 10") // "$a1.x + 10"
 * @example toJsExpr("#ff0080") // "\"#ff0080\""
 * @example toJsExpr("self.points.3.x / 2") // "self.points[3].x / 2"
 * @example toJsExpr("(function(){return 1})()") // "(function(){return 1})()" (verbatim — not restricted)
 */
export function toJsExpr(clean) {
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
    } else if (t.kind === "ref" && (t.value[0] === "@" || NUMERIC_SEGMENT_RE.test(t.value))) {
      out += clean.slice(last, t.start) + refToJs(t.value);
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
export function compileEquationFn(clean) {
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
 * Pure function. A WORLD point expressed in the frame the READING item's own
 * stored coordinates live in — i.e. with the reader's group influence removed.
 *
 * WHY THIS EXISTS. An anchor reference evaluates to a point in PAINTED world
 * space, group influence included (derive.js composedMemberInfluence). But the
 * number is then stored in a slot on the reading item, and derivation composes
 * THAT item's own group influence onto its world a second time
 * (derive.js applyGroupParenting). For a reader that is itself a member, the
 * influence therefore landed TWICE and the reader tore away from the anchor it
 * was bound to — measured at 54 world units for a group translated (50, 20), and
 * 269 for one also scaled and rotated. Mapping the point back through the
 * reader's own influence makes it land exactly once.
 *
 * Three cases, and the first two are why this is a correction rather than a
 * behaviour change:
 *   reader ungrouped         → influence null → the point is returned unchanged,
 *                              BYTE-IDENTICAL to before this function existed
 *                              (this is the case tests/group_anchor_probe.js
 *                              pins, and it does not move).
 *   reader in the SAME group → the reader's influence equals the target's, so
 *                              the two cancel exactly and the read reduces to the
 *                              un-influenced anchor, which applyGroupParenting
 *                              then re-applies once.
 *   reader in a DIFFERENT    → the target's painted anchor, re-expressed in the
 *   group than the target      reader's frame; correct for the first time.
 *
 * @param {{x: number, y: number}} point - the anchor's painted world point
 * @param {{x, y, rotation, scale}|null} readerInfluence - the reading item's own
 *   composed group influence, or null when it belongs to no group
 * @returns {{x: number, y: number}} the point in the reader's stored frame
 *
 * @example inReaderFrame({x: 200, y: 150}, null) // {x: 200, y: 150} (ungrouped reader: unchanged)
 * @example inReaderFrame({x: 200, y: 150}, {x: 50, y: 20, rotation: 0, scale: 1}) // {x: 150, y: 130}
 * @example inReaderFrame({x: 300, y: 200}, {x: 0, y: 0, rotation: 0, scale: 2}) // {x: 150, y: 100}
 */
export function inReaderFrame(point, readerInfluence) {
  return readerInfluence ? T.apply(T.invert(readerInfluence), point.x, point.y) : point;
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
 * Returns {state, errors, deps, clock}. `errors` maps "items.a1.x"-style joined paths
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
 * THE PROJECT SCRIPT (`script`, doc.meta.script — see core/project_script.js) is
 * an optional per-document JavaScript library compiled in THIS SAME JAIL; its
 * exports are merged into the equation scope, so `= ease(t)` can call a function
 * the author wrote once. PRECEDENCE, in scopeGet's order: evaluator keywords
 * (`time`/`random`/`Math`/…) and the FUNCTIONS library win and are NOT shadowable
 * (a colliding export is refused at COMPILE time, loudly, by
 * compileProjectScript); item SLUGS and variables win over an export at READ time
 * (a slug names something on the canvas the author can see); everything else
 * resolves to an export if there is one, and only then becomes a reference head.
 * A script that fails to compile exports NOTHING and its error is reported once —
 * equations calling its exports then fail loudly per the normal equation-error
 * path (never a silent 0).
 *
 * `clock` is the presentation-clock value this pass read (particleTime()), or
 * `null` when no equation mentioned `time`. It is BOTH the memo's invalidation key
 * and the presenter's "does this slide animate off the clock?" answer — derived
 * from the pass that actually ran, so it cannot drift from the equations the way a
 * hand-declared `animated` flag or a static source scan could.
 *
 * @example evaluateState({vars: {speed: 5}, items: {a1: {type: "rect", x: "speed * 2"}}}, registry).state.items.a1.x // 10
 * @example evaluateState({vars: {speed: 5}, items: {}}, registry).clock // null (no equation read the clock)
 * @example // Cycle: {vars: {a: "b", b: "a"}} → errors.get("vars.a") mentions the cycle; values fall back to 0
 */

export function evaluateState(state, registry, script = "") {
  const memo = evalMemo.get(state);
  // A CLOCK-FREE result is cached forever (the overwhelming majority — this is the
  // memo drag latency depends on). A clock-READING one is only reused while the
  // clock still reads the same, so the PAUSED regime (editor/CLI/thumbnails, where
  // particleTime() is a constant) caches exactly as before, while the LIVE presenter
  // and the per-frame export override re-evaluate as the clock advances.
  //
  // THE SCRIPT IS PART OF THE MEMO KEY (project script round): the folded state is
  // unchanged by a script edit — the script lives in doc.meta, not in the fold — so
  // WITHOUT this the editor would serve the pre-edit evaluation from cache and the
  // canvas would silently ignore a saved script until something else moved. Compared
  // by SOURCE STRING rather than by compiled identity because that is what the
  // caller has; compileProjectScript's own cache makes the recompile free.
  if (memo && memo.registry === registry && memo.script === script
    && (memo.result.clock === null || memo.result.clock === particleTime()))
    return memo.result;
  const result = computeEvaluatedState(state, registry, script);
  evalMemo.set(state, { registry, script, result });
  return result;
}

/** Pure-core of evaluateState (see its docs); uncached. Full-JS, lazy engine. */
function computeEvaluatedState(state, registry, script = "") {
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
    // PER-ITEM VARIABLES (manifest item 67): a name-keyed dict `item.vars`
    // mirroring top-level `state.vars`, one level deeper (`items.<id>.vars.<name>`).
    // EVERY string value is a numeric equation slot BY FIAT — identical to a
    // global var (line ~2203) — so vars are collected HERE, not through the
    // generic isEquationValue gate below: no plugin declares `vars` in its
    // defaults, so resultKindForSlot would type an "="-prefixed var as
    // UNRESOLVED (rejected) and isNumericSlot would drop a bare-string one
    // entirely. Kind "number", always. Read back as `self.vars.<name>` (the
    // parseSelfRef prop fall-through) and tweened by the generic nested-leaf
    // delta fold (core/deltas.js mutBlendApply) with zero new code.
    for (const [name, value] of Object.entries(item.vars ?? {}))
      if (typeof value === "string") {
        const key = `items.${id}.vars.${name}`;
        slots.set(key, { key, path: ["items", id, "vars", name], src: value, kind: "number" });
      }
    // leaves() keeps arrays OPAQUE (three other consumers need that — see
    // declaredListLeaves), so DECLARED LIST elements are walked separately. Their
    // slots go through the IDENTICAL gate, so a per-element `=` is an equation on
    // exactly the same terms as any other property. `vars` is skipped: it is
    // collected above as a numeric dict, and isEquationValue now reports vars as
    // an equation (for the paste/rename walks), so WITHOUT this guard an
    // "="-prefixed var would be RE-collected here with an UNRESOLVED kind.
    // `item` goes to BOTH predicates because a MATERIAL KNOB's kind and default
    // are declared by the material its paint names, not by the plugin
    // (§Material param knobs) — this is the ONE production caller of either that
    // has the folded item in hand, which is why the argument is optional there.
    for (const [path, value] of [...leaves(item), ...declaredListLeaves(item)])
      if (path[0] !== "vars" && isEquationValue(plugin, path, value, item)) {
        const key = ["items", id, ...path].join(".");
        slots.set(key, { key, path: ["items", id, ...path], src: value, kind: resultKindForSlot(plugin, path, value, item) });
      }
  }
  const itemSlotKeys = new Map(); // itemId → [slot keys] (geometry settling for anchors / rim / groups)
  for (const slot of slots.values())
    if (slot.path[0] === "items") {
      if (!itemSlotKeys.has(slot.path[1])) itemSlotKeys.set(slot.path[1], []);
      itemSlotKeys.get(slot.path[1]).push(slot.key);
    }

  // THE VALUE A FAILED SLOT FALLS BACK TO — its DECLARED default, because that is
  // what the slot would hold if the equation had never been written. A MATERIAL
  // KNOB's default lives in the material registry, not in plugin.defaults, so
  // without the first branch every failed knob landed on the `?? 0` and rendered
  // as if the author had asked for zero — silently, since the schema default is
  // what a sparse knob resolves to at paint time. That was half of the R6-7 defect.
  const fallbackFor = (path) => {
    if (path[0] !== "items") return 0; // variables have no plugin defaults
    const item = state.items[path[1]];
    const rel = path.slice(2);
    const knobDefault = materialParamDefaultAt(rel, item);
    if (knobDefault !== undefined) return knobDefault;
    return getPath(registry.get(item.type).defaults, rel) ?? 0;
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

  // THE PRESENTATION CLOCK. `time` is RECORDABLE state (manifest THE THREE KINDS
  // OF STATE): not derivable from [[slide, alpha]], but fully deterministic given a
  // timeline. There is exactly ONE answer in this codebase to "what animation time
  // is it right now?" — render_gpu/particle_clock.particleTime() — with a PAUSED
  // regime (a fixed freeze for the editor, CLI, thumbnails, so every still is
  // byte-reproducible), a LIVE regime the presenter opts into, and an override the
  // MP4 exporters already drive per frame. `= time` reads THAT clock, so an
  // equation-driven widget and an ambient one (particles, sky, cursor) can never
  // disagree about the time. A second time source would be a second thing to keep
  // in sync, which is the mirror hazard this codebase keeps paying for.
  //
  // It is read ONCE per pass and handed back to the memo (`clockRead`), so the
  // cache cannot serve a stale clock — see evaluateState.
  //
  // `state.time` is NOT consulted. It never was written by anything, and
  // setParticleTimeOverride is already the one override seam.
  //
  // THERE IS NO `frame`. It resolved to a frozen 0 here for the same reason `time`
  // did, and unlike `time` it cannot be given an honest meaning: a frame number
  // needs a frame rate, `meta.fps` is dead ("presentations are always uncapped",
  // stripped by repairedDocument), and the presenter runs one frame per rAF tick —
  // so the same document would number its frames differently on a 60Hz and a 120Hz
  // display. `= frame` is now an unknown reference and fails LOUDLY, which is the
  // honest answer. Divide `time` by a frame rate you choose if you want frames.
  //
  // The random seed is a hash of the equation set, so a given document yields a
  // reproducible sequence.
  let clockRead = null; // the clock value this pass used, or null if nothing read it
  const readClock = () => (clockRead ??= particleTime());
  const seededRandom = mulberry32(stringSeed([...slots.keys()].sort().join("|") + "|powerrp"));

  // THE PROJECT SCRIPT (core/project_script.js). Compiled ONCE per pass against the
  // SAME deterministic host the slots get — the seeded random and the one clock —
  // so a script and an equation can never disagree about what `random` or `time`
  // means. Its `exports` become scope bindings below (scopeGet). A compile failure
  // exports nothing and is REPORTED once here rather than thrown: the pass must
  // still produce a frame, and every equation calling a missing export then fails
  // loudly on its own line, which is where the fix belongs.
  //
  // `time` is read through readClock, so a script that reads it at TOP LEVEL still
  // marks this pass as clock-reading and the memo invalidates per frame, exactly as
  // an `= time` equation does.
  const projectScript = compileProjectScript(script, { random: seededRandom, time: readClock });
  if (projectScript.error) reportOnce(projectScript.error);

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
    // RE-READ after the settle (out is mutated in place) and enter THE FLIP SEAM
    // (core/geometry.js unsignedState): this pass runs BEFORE derivation, so it is
    // the ONE place a plugin's `anchors` hook can still be handed a signed box.
    // WHY THAT MATTERS AND IS NOT COSMETIC: anchor ids are GEOMETRIC names and a
    // flip does not move the silhouette, so `ml` must stay the left edge (76fd076).
    // The derived path already did that; this one did not, so the `ml` glyph was
    // drawn at the left edge while the equation the user wrote by clicking it
    // evaluated to the RIGHT edge — a bound arrow jumped the widget's whole width
    // on flip. Same map on both sides is what makes the two halves one feature.
    const target = unsignedState(out.items[d.itemId]);
    let world = d.selfBase ? { ...T.fromState(target), rotation: 0 } : worldTransform(target);
    if (!d.selfBase) {
      requireGroups(d.itemId);
      const influence = composedMemberInfluence(ownerGroups.get(d.itemId), out);
      if (influence) world = T.compose(influence, world);
    }
    const anchor = plugin.anchors(target).find((a) => a.id === d.anchorId);
    const point = T.apply(world, anchor.x, anchor.y);
    if (d.selfBase) return point[d.coord]; // base-frame pivot: no reader frame to enter
    // THE READER'S FRAME. The world point above is about to be stored in a slot on
    // the READING item, and derivation will re-influence THAT item by its own
    // groups. Un-apply the reader's influence so it lands once, not twice.
    const readerId = slot.path[0] === "items" ? slot.path[1] : null;
    if (readerId != null) requireGroups(readerId);
    return inReaderFrame(point, readerId == null ? null : composedMemberInfluence(ownerGroups.get(readerId), out))[d.coord];
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
      // cx/cy: THE DERIVED CENTER PAIR, not a stored slot — no plugin's defaults
      // ever declares one (properties.js's row entries are display-only; see
      // its "computed, no default" note), so a raw getPath below would always
      // read undefined and throw "has no property". Caught here, ahead of that
      // generic path, and answered from the SAME base-frame math worldTransform
      // already uses for its own default pivot (core/geometry.js boxCenter) —
      // one formula, read by both the render seam and the equation seam. Only a
      // BARE `self.cx` / `@slug.cx` qualifies (d.path.length === 1): "cx.foo"
      // is not a thing, and falls through to the ordinary prop lookup below,
      // which reports it as the unknown property it is.
      if (d.path.length === 1 && (d.path[0] === "cx" || d.path[0] === "cy")) {
        requireItemGeometry(d.itemId, false); // settle x/y/w/h/scale first
        // NOT requireGroups/world here: cx/cy lives in the SAME (local, stored)
        // frame as x/y themselves — a group's world influence is exactly the
        // thing this pair is NOT (that is what worldTransform/anchors are for).
        const target = unsignedState(out.items[d.itemId]); // enter THE FLIP SEAM, same as every other pre-derivation reader
        const c = boxCenter(target);
        return d.path[0] === "cx" ? c.x : c.y;
      }
      // display snake_case → stored camelCase (idempotent on camel), then a
      // DECLARED-LIST element field's canonical NAME → its storage key
      // (`points.3.x` → points[3][0] for a tuple element; a no-op otherwise).
      const spath = storedListPath(pathToStored(d.path));
      const depKey = ["items", d.itemId, ...spath].join(".");
      // A whole-LIST read settles the equation slots INSIDE the list too, so
      // `= other.points` reads evaluated element values rather than the raw "="
      // strings sitting in them. Cycle detection applies to each as usual.
      if (listDeclAt(spath))
        for (const innerKey of itemSlotKeys.get(d.itemId) ?? [])
          if (innerKey.startsWith(`${depKey}.`)) requireSlot(innerKey);
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

  /** Query. Is this bare identifier a DOCUMENT reference head — a declared
   *  variable, an item slug, or an anchor name's "<slug>_<anchorId>" prefix? Only
   *  these THREE things can be spelled as a bare head, and each of them names
   *  something the author can point at on the canvas or in the variables panel;
   *  everything else is free for a project-script export to claim. Deliberately
   *  narrower than `resolveRef`, which classifies a dotless head as a variable
   *  UNCONDITIONALLY (it has no vars table) — asking it here would make every
   *  export unreachable. */
  const isDocumentRefHead = (name) => {
    if (name in (out.vars ?? {})) return true;
    if (slugs.toId.has(name)) return true;
    const us = name.lastIndexOf("_");
    return us > 0 && slugs.toId.has(name.slice(0, us));
  };

  // The scope proxy: `has: () => true` routes EVERY free identifier through `get`
  // (no fall-through to real globals — the determinism guard). `get` returns the
  // deterministic host, the function library, a PROJECT SCRIPT export, or a lazy
  // ref proxy.
  const scopeGet = (name, slot, selfId) => {
    switch (name) {
      case "undefined": return undefined;
      case "NaN": return NaN;
      case "Infinity": return Infinity;
      case "Math": return SAFE_MATH; // no random
      case "time": return readClock(); // the ONE presentation clock (see readClock)
      case "random": return seededRandom; // seeded, deterministic
    }
    if (name in FUNCTIONS) return makeFn(name, slot, selfId);
    if (BLOCKED_GLOBALS.has(name)) return undefined; // Date/window/… → undefined → member use throws loud
    // PROJECT SCRIPT EXPORTS sit BELOW every built-in above (a colliding export was
    // already refused at compile time, so this order can never silently shadow one)
    // and BELOW document references (a slug or variable wins — it names a thing on
    // the canvas). An export therefore fills exactly the gap where a bare
    // identifier would otherwise have become an "Unknown variable" failure.
    if (name in projectScript.exports && !isDocumentRefHead(name))
      return projectScript.exports[name];
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
      // bad value). An UNRESOLVED slot (nothing declares its kind) gets its own
      // message naming the fix, rather than a confusing type mismatch against a
      // kind that was only ever a guess.
      if (slot.kind === UNRESOLVED_KIND) {
        // A whole ELEMENT of a declared list lands here on purpose: it has no
        // declared kind of its own, so the message names the slots that DO.
        const inList = listDeclAt(slot.path.slice(2));
        throw new Error(inList
          ? `"${slot.path.slice(2).join(".")}" is a whole list ELEMENT, which has no value kind of its own — bind one of its fields instead (${inList.decl.element.fields.map((f) => f.name).join(", ")}), or bind the whole list by reference`
          : `"${slot.path.slice(2).join(".")}" has no declared value kind, so an "=" equation cannot be validated here — give it a core/properties.js PROPS entry, or a plugin default at this path`);
      } else if (slot.kind === "list") {
        // TWO-PART, both loud: an array (resultMatchesKind) whose ELEMENTS match
        // the declared shape (listResultProblem names which element and field is
        // wrong, and the minLength floor).
        const found = listDeclAt(slot.path.slice(2));
        const problem = found ? listResultProblem(found.decl, v) : "has no list declaration to validate against";
        if (problem) throw new Error(`= expression result ${problem}`);
      } else if (slot.kind === "number") {
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

  return { state: out, errors, deps, clock: clockRead };
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
 * Near-pure function (console.errors each NEW unrewritable equation once — never
 * silently). Renames a variable document-wide: every vars.<oldName> keyframe
 * moves to vars.<newName>, and every EQUATION SLOT in any slide delta (the
 * canonical isEquationValue walk — not just the legacy numeric slots) plus every
 * vars equation has its bare `oldName` reference tokens rewritten. Variables are
 * referenced BY NAME (their name is their identity), so rename must rewrite —
 * unlike items, which are stored by id and never need this. Throws if newName is
 * not a valid identifier or already exists as a variable.
 *
 * WHAT IT CANNOT REWRITE, IT REPORTS. Stored equations are FULL JavaScript
 * (computeEvaluatedState), while token-structural rewriting only reaches the
 * RESTRICTED grammar; a textual rewrite is not an option (it would corrupt
 * `"speed wins"` inside a string literal and any identifier with `speed` as a
 * substring). So an IIFE/loop equation that names the variable is left ALONE and
 * console.errored, because the alternative — leaving the document referencing a
 * name that no longer exists, having reported success — is the silent wrong answer
 * this replaced. A source that does not mention `oldName` at all needs no rewrite
 * and says nothing: silent SUCCESS is fine, silent FAILURE is not.
 *
 * SKIPS RATHER THAN THROWS, like the keyframe tools in core/document.js: one
 * unrewritable equation must not abort the rename of a whole document.
 *
 * @example // withVariableRenamed(doc, "speed", "velocity", registry):
 * @example //   delta.vars.speed: 5          → delta.vars.velocity: 5
 * @example //   items.a1.x: "speed * 2"      → items.a1.x: "velocity * 2"
 * @example //   items.a1.y: "= speed * 2"    → items.a1.y: "= velocity * 2"   (marker form)
 * @example //   items.t.text: "= speed"      → items.t.text: "= velocity"     (any-type "=" slot)
 * @example //   items.j.x: "(function () { return speed; })()" → UNCHANGED, and console.errored
 */
export function withVariableRenamed(doc, oldName, newName, registry) {
  if (!IDENTIFIER_RE.test(newName))
    throw new Error(`"${newName}" is not a valid variable name (letters, digits, _; not starting with a digit)`);
  for (const slide of doc.slides)
    if (slide.delta.vars && newName in slide.delta.vars)
      throw new Error(`A variable named "${newName}" already exists`);
  // Only an IDENTIFIER can be a reference token, so a non-identifier oldName
  // cannot be referenced from any equation — there is nothing to rewrite and
  // nothing to report (which is also why the pattern needs no escaping).
  const mentionsOld = IDENTIFIER_RE.test(oldName) ? new RegExp(`\\b${oldName}\\b`) : null;
  const renameRefs = (src) => {
    try {
      return mapRefTokens(src, (token) => (token === oldName ? newName : token));
    } catch (e) {
      if (!mentionsOld?.test(src)) return src; // nothing of ours in there — silent success
      const message = `variable "${oldName}" → "${newName}": the equation ${JSON.stringify(src)} is not restricted-grammar rewritable (${e.message}) — it still names "${oldName}", rewrite it by hand`;
      reportOnce(message, `PowerRP rename incomplete: ${message}`);
      return src;
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
      // The item's plugin is needed to decide which leaves are equation slots; the
      // type may be keyed on an earlier slide, so fall back to scanning all slides.
      const itemType = type ?? findItemType(doc, itemId);
      if (!itemType) continue;
      const plugin = registry.get(itemType);
      // THE CANONICAL "every equation slot of one item" WALK, verbatim (see
      // declaredListLeaves): `[...leaves, ...declaredListLeaves]` filtered by
      // isEquationValue — the same walk computeEvaluatedState and
      // clonedItemStates use. This function used to filter by isNumericSlot
      // instead, which is the LEGACY half of that test: it cannot see a
      // universal `= …` equation in a slot whose default is not a number
      // (`text: "= speed"`), so those were never even visited, let alone
      // rewritten. Declared LIST elements need the second generator because
      // leaves() keeps arrays opaque; a SPARSE per-element delta
      // ({points: {3: {0: "=speed"}}}) is already covered — leaves() descends
      // plain objects.
      for (const [path, value] of [...leaves(sub), ...declaredListLeaves(sub)])
        if (isEquationValue(plugin, path, value)) {
          const renamed = renameRefs(value);
          if (renamed !== value) delta = setPath(delta, ["items", itemId, ...path], renamed);
        }
    }
    return delta === slide.delta ? slide : { ...slide, delta };
  });
  return { ...doc, slides };
}

/**
 * Near-pure function (console.errors each NEW unrewritable equation once — never
 * silently). Renames ONE item's per-item variable (manifest item 67), the
 * item-scoped counterpart to withVariableRenamed — NOT a generalization of it.
 * The two are structurally different rewrites, which is why this is a sibling:
 *
 *   - withVariableRenamed rewrites BARE identifier tokens (`speed`) document-wide,
 *     because a global var IS a bare identifier and its name is its identity.
 *   - A per-item var is spelled `self.vars.<name>` (owner) or `@<id>.vars.<name>`
 *     (cross-item). Both are WHOLE dotted ref tokens (REF_RE matches the dotted
 *     path as one token), so they are invisible to a bare-token rewrite — the very
 *     property that makes per-item names collision-proof. So this rewrites those
 *     WHOLE tokens instead, and touches only THIS item's own vars dict key plus
 *     the references that name it. A global var and a per-item var may share a
 *     name; renaming one never disturbs the other.
 *
 * Three edits per rename: (1) the owning item's `vars.<oldName>` dict key moves to
 * `vars.<newName>` on every slide; (2) every `self.vars.<oldName>` token in the
 * owning item's own equation slots (a var may reference a sibling var) becomes
 * `self.vars.<newName>`; (3) every `@<itemId>.vars.<oldName>` token in ANY item's
 * equation slots (a cross-item read) re-points to the new name. Rewrites are
 * token-structural (mapRefTokens), never textual — a `"self.vars.x wins"` string
 * literal is safe. Throws if newName is not a valid identifier or the item
 * already has a var by that name; an unrewritable (full-JS) equation is left
 * alone and reported, exactly like withVariableRenamed.
 *
 * @example // withItemVariableRenamed(doc, "a1", "lambda", "mu", reg):
 * @example //   items.a1.vars.lambda: 0.5        → items.a1.vars.mu: 0.5
 * @example //   items.a1.x: "self.vars.lambda"   → items.a1.x: "self.vars.mu"
 * @example //   items.b2.x: "@a1.vars.lambda*2"  → items.b2.x: "@a1.vars.mu*2"  (cross-item)
 * @example //   the GLOBAL var "lambda" and OTHER items' "lambda" vars are UNTOUCHED
 */
export function withItemVariableRenamed(doc, itemId, oldName, newName, registry) {
  if (!IDENTIFIER_RE.test(newName))
    throw new Error(`"${newName}" is not a valid variable name (letters, digits, _; not starting with a digit)`);
  if (newName === oldName) return doc;
  for (const slide of doc.slides) {
    const vars = getPath(slide.delta, ["items", itemId, "vars"]);
    if (isTree(vars) && newName in vars)
      throw new Error(`Item already has a variable named "${newName}"`);
  }
  const selfOld = `self.vars.${oldName}`, selfNew = `self.vars.${newName}`;
  const crossOld = `@${itemId}.vars.${oldName}`, crossNew = `@${itemId}.vars.${newName}`;
  // Report guard: the reference tail we rewrite, so an unparseable equation that
  // does NOT name this var stays silent (silent success is fine; silent failure
  // is not — the catch below reports the ones that DO name it).
  const mentionsOld = new RegExp(`\\.vars\\.${oldName}\\b`);
  const renameRefs = (src, isOwner) => {
    try {
      return mapRefTokens(src, (token) =>
        isOwner && token === selfOld ? selfNew : token === crossOld ? crossNew : token);
    } catch (e) {
      if (!mentionsOld.test(src)) return src;
      const message = `item "${itemId}" variable "${oldName}" → "${newName}": the equation ${JSON.stringify(src)} is not restricted-grammar rewritable (${e.message}) — it still names "${oldName}", rewrite it by hand`;
      reportOnce(message, `PowerRP rename incomplete: ${message}`);
      return src;
    }
  };
  const slides = doc.slides.map((slide) => {
    let delta = slide.delta;
    // (1) Move the owning item's own vars dict key on this slide.
    const ownVars = getPath(delta, ["items", itemId, "vars"]);
    if (isTree(ownVars) && oldName in ownVars) {
      const vars = { ...ownVars };
      vars[newName] = vars[oldName];
      delete vars[oldName];
      delta = setPath(delta, ["items", itemId, "vars"], vars);
    }
    // (2)+(3) Rewrite reference tokens in every item's equation slots. Owner
    // slots also get the self.vars.<name> rewrite; every item gets the cross-item
    // @<itemId>.vars.<name> rewrite. `vars` values ARE equation slots here
    // (isEquationValue reports the fiat), so a var referencing a sibling var is
    // covered by the same walk.
    for (const [id, sub] of Object.entries(delta.items ?? {})) {
      if (!isTree(sub)) continue;
      const itemType = getPath(sub, ["type"]) ?? findItemType(doc, id);
      if (!itemType) continue;
      const plugin = registry.get(itemType);
      const isOwner = id === itemId;
      for (const [path, value] of [...leaves(sub), ...declaredListLeaves(sub)])
        if (isEquationValue(plugin, path, value)) {
          const renamed = renameRefs(value, isOwner);
          if (renamed !== value) delta = setPath(delta, ["items", id, ...path], renamed);
        }
    }
    return delta === slide.delta ? slide : { ...slide, delta };
  });
  return { ...doc, slides };
}

/**
 * Pure function. The itemId a STORED "@"-form reference token names, or null
 * when the token is not an item reference at all (a variable, a function name,
 * a `self.` reference).
 *
 * Mirrors parseStoredRef's split rule — "item ids never contain '_', so the
 * split is unambiguous" — but WITHOUT its property requirement, so it also
 * answers for a bare WIDGET-ARGUMENT token (`closest_to_rim(@a, @b)`, where the
 * id carries no ".<prop>" suffix and parseStoredRef therefore throws).
 *
 * @example storedRefItemId("@ab12cd34.x") // "ab12cd34"
 * @example storedRefItemId("@ab12cd34_tm.y") // "ab12cd34" (anchor form: id, then _anchor)
 * @example storedRefItemId("@ab12cd34") // "ab12cd34" (a bare widget argument)
 * @example storedRefItemId("speed") // null (a variable, not an item reference)
 * @example storedRefItemId("self.w") // null (identity-stable; never rewritten)
 */
export function storedRefItemId(token) {
  if (!token.startsWith("@")) return null;
  const dot = token.indexOf(".");
  const head = dot === -1 ? token.slice(1) : token.slice(1, dot);
  if (!head) return null; // a lone "@" names nothing
  const us = head.indexOf("_");
  return us === -1 ? head : head.slice(0, us);
}

/**
 * Pure function. Rewrites an equation's STORED item references for a SUBGRAPH
 * CLONE: every `@<id>` token whose id is a key of `idMap` is re-pointed at the
 * mapped id (keeping its anchor/property suffix verbatim), and every OTHER
 * reference is left exactly as it was. Returns the rewritten source PLUS the
 * itemIds that were deliberately left alone (`external` — the edges that LEAVE
 * the cloned set), which the caller checks for danglers.
 *
 * WHY TOKEN-STRUCTURAL, NOT A STRING REPLACE: a blind replace of "@oldId" also
 * matches inside a string literal ("@ab12 wins") and matches a PREFIX of a
 * longer id, so it can corrupt text and mis-point references. mapRefTokens
 * hands over exactly the REFERENCE tokens (grammar — member projections,
 * boolean literals — is never offered), which is the same guarantee
 * withVariableRenamed's rename relies on.
 *
 * The UNIVERSAL leading "=" marker survives because mapRefTokens splits it off and
 * rejoins it (withMarkerPreserved) — this function no longer does that itself. Two
 * hand-rolled copies of the same split were two chances to forget it, and one of
 * them (storedToDisplay) had.
 *
 * A source that does not tokenize is returned VERBATIM with no external ids, and
 * SILENTLY — unlike withVariableRenamed, which reports. The asymmetry is real: a
 * FULL-JS equation (the untokenizable case that still WORKS) cannot contain a
 * stored `@id` at all, because "@" is not a JavaScript token either, so any
 * untokenizable source with an `@id` in it is already failing loudly at evaluation
 * and a second report would only duplicate it. Full-JS equations reach siblings by
 * SLUG instead, which no id remap can see — a clone-time gap worth knowing about,
 * but not one this function can close.
 *
 * @example withItemRefsRemapped("= @a.w / 2", new Map([["a", "z"]])) // {src: "= @z.w / 2", external: []} (the "=" marker survives)
 * @example withItemRefsRemapped("@a.x + 10", new Map([["a", "z"]])) // {src: "@z.x + 10", external: []}
 * @example withItemRefsRemapped("@a_tm.x", new Map([["a", "z"]])) // {src: "@z_tm.x", external: []} (anchor suffix kept)
 * @example withItemRefsRemapped("@a.x + @c.x", new Map([["a", "z"]])) // {src: "@z.x + @c.x", external: ["c"]} (c is outside the set)
 * @example withItemRefsRemapped("closest_to_rim(@a, @c).x", new Map([["a", "z"]])) // {src: "closest_to_rim(@z, @c).x", external: ["c"]}
 * @example withItemRefsRemapped("speed * 2", new Map([["a", "z"]])) // {src: "speed * 2", external: []}
 */
export function withItemRefsRemapped(src, idMap) {
  const external = new Set();
  try {
    const out = mapRefTokens(src, (token) => {
      const id = storedRefItemId(token);
      if (id === null) return token;
      if (!idMap.has(id)) { external.add(id); return token; }
      return `@${idMap.get(id)}${token.slice(1 + id.length)}`;
    });
    return { src: out, external: [...external] };
  } catch {
    return { src, external: [] }; // not a parseable equation — leave it (its own error affordance reports it)
  }
}

/** Pure function. The type an item is created with (first slide keying it), or null. */
function findItemType(doc, itemId) {
  for (const slide of doc.slides) {
    const t = getPath(slide.delta, ["items", itemId, "type"]);
    if (typeof t === "string") return t;
  }
  return null;
}
