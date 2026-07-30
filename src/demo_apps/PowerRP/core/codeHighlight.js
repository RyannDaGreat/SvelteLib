/**
 * OFFLINE SYNTAX HIGHLIGHTER — a pure, DOM-free, dependency-free tokenizer for
 * the CODE BLOCK widget (manifest Round 12D). Turns source text into per-line
 * arrays of {text, kind} tokens; the code-block plugin colors each token by its
 * `kind` (colors live in app.css's --a-code-* palette, chained to theme tokens).
 *
 * ── VENDOR-OR-BUILD DECISION (build) ──────────────────────────────────────────
 * The task asked to evaluate vendoring a tokenizer (e.g. Prism). DECISION: BUILD
 * a purpose-built minimal tokenizer. WHY:
 *   - OFFLINE RULE: no CDN, ever. A vendored library must be committed as bytes.
 *   - SIZE: Prism's core + the seven grammars we need (js/ts/python/html/css/
 *     bash/json) is far larger than a keyword/string/comment/number/function
 *     tokenizer, and Prism's grammar model (nested token trees, hooks) is
 *     heavier than we need for coloring flat runs of mono text.
 *   - PURITY / TESTABILITY: our whole core is DOM-free pure JS with doctests;
 *     Prism assumes a token-tree + DOM stringify pipeline. A hand-rolled
 *     regex-per-kind tokenizer is trivially pure and heavily doctestable (this
 *     module IS pure-function country — the task's words).
 *   - NO DEPENDENCY: zero new committed third-party bytes, zero license to
 *     track (this is our own MIT-compatible code under the repo's terms). If we
 *     ever DO vendor, Prism is MIT and JetBrains Mono is OFL-1.1 — but we don't.
 * The tradeoff: this highlighter is intentionally SHALLOW (keywords, strings,
 * comments, numbers, function-call names, a few punctuation/property cues). It
 * is NOT a parser; it will mis-tag pathological code. That is the right level
 * for a presentation figure — readable color, not IDE-grade correctness. Deeper
 * grammars are a future option (documented, not silent).
 *
 * ── OUTPUT SHAPE ──────────────────────────────────────────────────────────────
 * highlightCode(code, langId) → LINE[] where LINE = TOKEN[] and
 * TOKEN = {text, kind}. Concatenating a line's token texts reproduces the line
 * exactly (no characters dropped or added — the plugin relies on this for
 * faithful monospace layout). `kind` is one of KINDS. An unknown/absent langId
 * yields one {text: line, kind: "plain"} token per line — the DECLARED fallback
 * (documented, never an error): unknown languages render as plain monochrome
 * mono text.
 *
 * ── CROSS-LINE STATE ──────────────────────────────────────────────────────────
 * Block constructs (C-style /* *​/ comments, template literals, python triple-
 * quoted strings, HTML/CSS comments) span lines, so tokenizeLine carries a
 * `state` in and out. highlightCode threads it; callers who only want one line
 * with no open block pass the default (null) state.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

/**
 * The token kinds this highlighter emits. Each maps to one --a-code-<kind> CSS
 * token in app.css. `plain` is the fallback (unhighlighted text / unknown
 * language). Keep this list and the app.css palette in lockstep.
 */
export const KINDS = ["keyword", "string", "comment", "number", "function", "property", "punct", "plain"];

// ── language keyword sets ─────────────────────────────────────────────────────
// Small, deliberately non-exhaustive keyword lists — the common control-flow /
// declaration words a reader expects colored. Not a full spec (see the module
// header's "intentionally shallow" note).

/** EXPORTED for web/monacoSetup.js's JavaScript Monarch grammar (THE PROJECT
 *  SCRIPT's editor). Monaco's `editor.api` ships NO built-in languages, so the app
 *  registers its own JS grammar — and it colours the SAME words the canvas code
 *  block colours by reading this one list, rather than keeping a second copy that
 *  could drift into disagreeing with itself about what a keyword is. */
export const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "break", "continue", "switch", "case", "default", "throw", "try", "catch", "finally",
  "new", "delete", "typeof", "instanceof", "in", "of", "class", "extends", "super",
  "this", "import", "export", "from", "as", "async", "await", "yield", "static", "get", "set",
  "true", "false", "null", "undefined", "void", "with",
  // TS-flavored (js/ts share one grammar here — a superset is fine for coloring):
  "interface", "type", "enum", "public", "private", "protected", "readonly", "implements",
  "namespace", "declare", "abstract", "override", "keyof", "infer", "satisfies", "is",
]);

const PYTHON_KEYWORDS = new Set([
  "def", "return", "if", "elif", "else", "for", "while", "break", "continue", "pass",
  "import", "from", "as", "class", "try", "except", "finally", "raise", "with", "lambda",
  "global", "nonlocal", "yield", "async", "await", "del", "assert", "and", "or", "not", "in", "is",
  "True", "False", "None", "self", "cls", "match", "case",
]);

const BASH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
  "function", "in", "select", "return", "break", "continue", "local", "export", "readonly",
  "declare", "echo", "cd", "source", "set", "unset", "exit", "trap", "eval", "test",
]);

const CSS_KEYWORDS = new Set([
  "important", "inherit", "initial", "unset", "auto", "none", "flex", "grid", "block",
  "inline", "absolute", "relative", "fixed", "static", "hidden", "visible",
]);

// ── per-language line tokenizers ──────────────────────────────────────────────
// Each is (text, state) → {tokens, state}. A tokenizer scans left-to-right,
// emitting {text, kind} tokens whose concatenation equals `text`. `state` is
// null in normal flow, or a {block} marker while inside a multi-line construct.

/** Pure helper. Pushes a token unless empty (keeps token lists tight). */
function push(tokens, text, kind) {
  if (text.length > 0) tokens.push({ text, kind });
}

/**
 * Pure helper. Classifies a matched identifier/word in a keyword-based language:
 * a keyword if in `keywords`; else a "function" if the next non-space char is
 * "(" (a call/definition name); else plain. `rest` is the text AFTER the word on
 * the same line (to peek for the paren).
 */
function wordKind(word, keywords, rest) {
  if (keywords.has(word)) return "keyword";
  if (/^\s*\(/.test(rest)) return "function";
  return "plain";
}

/**
 * Pure function. Tokenizes ONE line of a C-family language (js/ts). Handles
 * line comments (//), block comments (/​* ... *​/, cross-line via state),
 * single/double/backtick strings (backtick may span lines via state), numbers,
 * keywords, and function-call names. Backtick template `${...}` interpolation is
 * NOT parsed (the whole template colors as a string — the shallow-highlighter
 * tradeoff).
 *
 * Args:
 *   text (string): the line (no trailing newline)
 *   state (object|null): {block: "comment"|"template"} if a block is open, else null
 *
 * Returns:
 *   {tokens: {text,kind}[], state: object|null}
 *
 * @example cTokenizeLine("const x = 1;", null).tokens[0] // {text: "const", kind: "keyword"}
 * @example cTokenizeLine("foo(1)", null).tokens[0] // {text: "foo", kind: "function"}
 * @example cTokenizeLine("// hi", null).tokens[0] // {text: "// hi", kind: "comment"}
 * @example cTokenizeLine("a /* open", null).state // {block: "comment"}
 * @example cTokenizeLine("still in", {block: "comment"}).tokens[0] // {text: "still in", kind: "comment"}
 */
export function cTokenizeLine(text, state, keywords = JS_KEYWORDS) {
  const tokens = [];
  let i = 0;
  // Resume an open block (comment or template literal) from a previous line.
  if (state && state.block === "comment") {
    const end = text.indexOf("*/");
    if (end === -1) { push(tokens, text, "comment"); return { tokens, state }; }
    push(tokens, text.slice(0, end + 2), "comment");
    i = end + 2;
    state = null;
  } else if (state && state.block === "template") {
    const end = text.indexOf("`");
    if (end === -1) { push(tokens, text, "string"); return { tokens, state }; }
    push(tokens, text.slice(0, end + 1), "string");
    i = end + 1;
    state = null;
  }

  while (i < text.length) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (two === "//") { push(tokens, text.slice(i), "comment"); i = text.length; break; }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) { push(tokens, text.slice(i), "comment"); return { tokens, state: { block: "comment" } }; }
      push(tokens, text.slice(i, end + 2), "comment"); i = end + 2; continue;
    }
    if (ch === '"' || ch === "'") {
      const j = scanQuoted(text, i, ch);
      push(tokens, text.slice(i, j), "string"); i = j; continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) { push(tokens, text.slice(i), "string"); return { tokens, state: { block: "template" } }; }
      push(tokens, text.slice(i, end + 1), "string"); i = end + 1; continue;
    }
    const num = matchNumber(text, i);
    if (num) { push(tokens, num, "number"); i += num.length; continue; }
    const word = matchWord(text, i);
    if (word) { push(tokens, word, wordKind(word, keywords, text.slice(i + word.length))); i += word.length; continue; }
    const punct = matchPunct(text, i);
    if (punct) { push(tokens, punct, "punct"); i += punct.length; continue; }
    push(tokens, ch, "plain"); i += 1;
  }
  return { tokens, state };
}

/**
 * Pure function. Tokenizes ONE line of Python. Handles # comments, single/double
 * strings, triple-quoted strings (cross-line via state — remembers which quote
 * opened it), numbers, keywords, and function-call names.
 *
 * @example pyTokenizeLine("def f():", null).tokens[0] // {text: "def", kind: "keyword"}
 * @example pyTokenizeLine("# note", null).tokens[0] // {text: "# note", kind: "comment"}
 * @example pyTokenizeLine('x = """open', null).state // {block: "triple", q: "\"\"\""}
 * @example pyTokenizeLine("f(2)", null).tokens[0] // {text: "f", kind: "function"}
 */
export function pyTokenizeLine(text, state) {
  const tokens = [];
  let i = 0;
  if (state && state.block === "triple") {
    const end = text.indexOf(state.q);
    if (end === -1) { push(tokens, text, "string"); return { tokens, state }; }
    push(tokens, text.slice(0, end + 3), "string"); i = end + 3; state = null;
  }
  while (i < text.length) {
    const ch = text[i];
    if (ch === "#") { push(tokens, text.slice(i), "comment"); i = text.length; break; }
    const triple = text.slice(i, i + 3);
    if (triple === '"""' || triple === "'''") {
      const end = text.indexOf(triple, i + 3);
      if (end === -1) { push(tokens, text.slice(i), "string"); return { tokens, state: { block: "triple", q: triple } }; }
      push(tokens, text.slice(i, end + 3), "string"); i = end + 3; continue;
    }
    if (ch === '"' || ch === "'") {
      const j = scanQuoted(text, i, ch);
      push(tokens, text.slice(i, j), "string"); i = j; continue;
    }
    const num = matchNumber(text, i);
    if (num) { push(tokens, num, "number"); i += num.length; continue; }
    const word = matchWord(text, i);
    if (word) { push(tokens, word, wordKind(word, PYTHON_KEYWORDS, text.slice(i + word.length))); i += word.length; continue; }
    const punct = matchPunct(text, i);
    if (punct) { push(tokens, punct, "punct"); i += punct.length; continue; }
    push(tokens, ch, "plain"); i += 1;
  }
  return { tokens, state };
}

/**
 * Pure function. Tokenizes ONE line of Bash. Handles # comments (only when the
 * '#' starts a word — not inside `$#` or a value), strings, $VAR / ${VAR}
 * variables (colored as "property"), numbers, keywords, and command names (the
 * first word on a line reads as a "function" — the invoked command).
 *
 * @example bashTokenizeLine("echo hi", null).tokens[0] // {text: "echo", kind: "keyword"}
 * @example bashTokenizeLine("ls -la", null).tokens[0] // {text: "ls", kind: "function"}
 * @example bashTokenizeLine("# comment", null).tokens[0] // {text: "# comment", kind: "comment"}
 * @example bashTokenizeLine("echo $HOME", null).tokens.find((t) => t.kind === "property").text // "$HOME"
 */
export function bashTokenizeLine(text, state) {
  const tokens = [];
  let i = 0;
  let wordIndex = 0; // 0th word on the line is the command (function-colored)
  while (i < text.length) {
    const ch = text[i];
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) { push(tokens, text.slice(i), "comment"); i = text.length; break; }
    if (ch === '"' || ch === "'") {
      const j = scanQuoted(text, i, ch);
      push(tokens, text.slice(i, j), "string"); i = j; continue;
    }
    if (ch === "$") {
      const v = text.slice(i).match(/^\$\{[^}]*\}|^\$[A-Za-z_][A-Za-z0-9_]*|^\$[@*#?$!0-9-]/);
      if (v) { push(tokens, v[0], "property"); i += v[0].length; continue; }
    }
    if (/\s/.test(ch)) { push(tokens, ch, "plain"); i += 1; wordIndex += 1; continue; }
    const num = matchNumber(text, i);
    if (num) { push(tokens, num, "number"); i += num.length; continue; }
    const word = matchWord(text, i);
    if (word) {
      const kind = BASH_KEYWORDS.has(word) ? "keyword" : (wordIndex === 0 ? "function" : "plain");
      push(tokens, word, kind); i += word.length; wordIndex += 1; continue;
    }
    const punct = matchPunct(text, i);
    if (punct) { push(tokens, punct, "punct"); i += punct.length; continue; }
    push(tokens, ch, "plain"); i += 1;
  }
  return { tokens, state };
}

/**
 * Pure function. Tokenizes ONE line of JSON. Object KEYS ("...":) color as
 * "property"; string VALUES as "string"; numbers as "number"; the literals
 * true/false/null as "keyword"; braces/brackets/colons/commas as "punct".
 *
 * @example jsonTokenizeLine('"a": 1', null).tokens[0] // {text: "\"a\"", kind: "property"}
 * @example jsonTokenizeLine('"a": "b"', null).tokens.filter((t) => t.kind === "string").length // 1
 * @example jsonTokenizeLine("true,", null).tokens[0] // {text: "true", kind: "keyword"}
 */
export function jsonTokenizeLine(text, state) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const j = scanQuoted(text, i, '"');
      const str = text.slice(i, j);
      // A string immediately followed (past whitespace) by ':' is a KEY.
      const kind = /^\s*:/.test(text.slice(j)) ? "property" : "string";
      push(tokens, str, kind); i = j; continue;
    }
    const num = matchNumber(text, i);
    if (num) { push(tokens, num, "number"); i += num.length; continue; }
    const word = matchWord(text, i);
    if (word) { push(tokens, word, (word === "true" || word === "false" || word === "null") ? "keyword" : "plain"); i += word.length; continue; }
    const punct = matchPunct(text, i);
    if (punct) { push(tokens, punct, "punct"); i += punct.length; continue; }
    push(tokens, ch, "plain"); i += 1;
  }
  return { tokens, state };
}

/**
 * Pure function. Tokenizes ONE line of CSS. Handles /​* *​/ comments (cross-line
 * via state), strings, selectors/at-rules, property names (before ':'), values,
 * numbers/units, and #hex colors. Property/value split is heuristic: text before
 * the first ':' on a declaration line is a "property"; a #hex is a "number"
 * (numeric literal family); a bare word before '(' is a "function".
 *
 * @example cssTokenizeLine("color: red;", null).tokens[0] // {text: "color", kind: "property"}
 * @example cssTokenizeLine("width: 12px;", null).tokens.find((t) => t.kind === "number").text // "12px"
 * @example cssTokenizeLine(".a { }", null).tokens.some((t) => t.kind === "punct") // true
 * (the block-comment cross-line case is covered in the test file — a literal
 *  CSS block comment can't appear in this JSDoc without closing it)
 */
export function cssTokenizeLine(text, state) {
  const tokens = [];
  let i = 0;
  if (state && state.block === "comment") {
    const end = text.indexOf("*/");
    if (end === -1) { push(tokens, text, "comment"); return { tokens, state }; }
    push(tokens, text.slice(0, end + 2), "comment"); i = end + 2; state = null;
  }
  // A declaration line ("prop: value") — split at the FIRST colon not inside a
  // block/selector. Detected shallowly: if the line has a ':' before any '{'.
  const colon = text.indexOf(":");
  const brace = text.indexOf("{");
  const isDecl = colon !== -1 && (brace === -1 || colon < brace);
  while (i < text.length) {
    const ch = text[i];
    if (text.slice(i, i + 2) === "/*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) { push(tokens, text.slice(i), "comment"); return { tokens, state: { block: "comment" } }; }
      push(tokens, text.slice(i, end + 2), "comment"); i = end + 2; continue;
    }
    if (ch === '"' || ch === "'") {
      const j = scanQuoted(text, i, ch);
      push(tokens, text.slice(i, j), "string"); i = j; continue;
    }
    if (ch === "#") {
      const hex = text.slice(i).match(/^#[0-9a-fA-F]{3,8}\b/);
      if (hex) { push(tokens, hex[0], "number"); i += hex[0].length; continue; }
    }
    const num = matchNumber(text, i);
    if (num) {
      // Consume a trailing unit (px, em, %, ...) into the number token.
      const unit = text.slice(i + num.length).match(/^(px|em|rem|vh|vw|%|s|ms|deg|fr|pt|ch|ex)\b/);
      const full = unit ? num + unit[0] : num;
      push(tokens, full, "number"); i += full.length; continue;
    }
    const word = matchWord(text, i, "-@");
    if (word) {
      let kind = "plain";
      if (word.startsWith("@")) kind = "keyword";              // at-rule (@media)
      else if (isDecl && i < colon) kind = "property";          // property name
      else if (CSS_KEYWORDS.has(word)) kind = "keyword";
      else if (/^\s*\(/.test(text.slice(i + word.length))) kind = "function"; // rgb(, calc(
      push(tokens, word, kind); i += word.length; continue;
    }
    const punct = matchPunct(text, i);
    if (punct) { push(tokens, punct, "punct"); i += punct.length; continue; }
    push(tokens, ch, "plain"); i += 1;
  }
  return { tokens, state };
}

/**
 * Pure function. Tokenizes ONE line of HTML/XML. Handles <!-- --> comments
 * (cross-line via state), tags (<tag ...>), attribute names ("property"),
 * attribute-value strings, and text content (plain). Deliberately coarse: the
 * whole tag opener "<tag" and closer ">" color as punct-adjacent; attribute
 * values are strings.
 *
 * @example htmlTokenizeLine("<div>", null).tokens.some((t) => t.kind === "keyword") // true
 * @example htmlTokenizeLine("<!-- c -->", null).tokens[0] // {text: "<!-- c -->", kind: "comment"}
 * @example htmlTokenizeLine('<a href="x">', null).tokens.some((t) => t.kind === "property") // true
 */
export function htmlTokenizeLine(text, state) {
  const tokens = [];
  let i = 0;
  if (state && state.block === "comment") {
    const end = text.indexOf("-->");
    if (end === -1) { push(tokens, text, "comment"); return { tokens, state }; }
    push(tokens, text.slice(0, end + 3), "comment"); i = end + 3; state = null;
  }
  while (i < text.length) {
    if (text.slice(i, i + 4) === "<!--") {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) { push(tokens, text.slice(i), "comment"); return { tokens, state: { block: "comment" } }; }
      push(tokens, text.slice(i, end + 3), "comment"); i = end + 3; continue;
    }
    if (text[i] === "<") {
      // Tag opener: "<", optional "/", tag name (keyword).
      const m = text.slice(i).match(/^<\/?[A-Za-z][A-Za-z0-9-]*/);
      if (m) {
        push(tokens, m[0][1] === "/" ? "</" : "<", "punct");
        push(tokens, m[0].replace(/^<\/?/, ""), "keyword");
        i += m[0].length; continue;
      }
      push(tokens, "<", "punct"); i += 1; continue;
    }
    if (text[i] === ">" || text.slice(i, i + 2) === "/>") {
      const t = text.slice(i, i + 2) === "/>" ? "/>" : ">";
      push(tokens, t, "punct"); i += t.length; continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const j = scanQuoted(text, i, text[i]);
      push(tokens, text.slice(i, j), "string"); i = j; continue;
    }
    const attr = text.slice(i).match(/^[A-Za-z_:][A-Za-z0-9_:.-]*(?=\s*=)/);
    if (attr) { push(tokens, attr[0], "property"); i += attr[0].length; continue; }
    push(tokens, text[i], "plain"); i += 1;
  }
  return { tokens, state };
}

// ── shared scanning helpers (pure) ────────────────────────────────────────────

/**
 * Pure function. Given a line and the index of an opening quote char, returns
 * the index JUST PAST the closing quote (respecting backslash escapes), or the
 * line length if the string is unterminated on this line (single-line strings
 * don't span lines in these grammars — an unterminated one just runs to EOL).
 *
 * @example scanQuoted('"ab"c', 0, '"') // 4
 * @example scanQuoted('"a\\"b"', 0, '"') // 6  (escaped quote inside)
 * @example scanQuoted('"open', 0, '"') // 5  (unterminated → EOL)
 */
export function scanQuoted(text, start, quote) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

/**
 * Pure function. Matches a numeric literal at `i` (integer, decimal, hex,
 * scientific), or "" if none. Requires a digit start (or 0x); does not consume a
 * leading sign (that's an operator).
 *
 * @example matchNumber("42px", 0) // "42"
 * @example matchNumber("0xFF ", 0) // "0xFF"
 * @example matchNumber("1.5e-3;", 0) // "1.5e-3"
 * @example matchNumber("abc", 0) // ""
 */
export function matchNumber(text, i) {
  const m = text.slice(i).match(/^(0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/);
  return m ? m[0] : "";
}

/**
 * Pure function. Matches an identifier word at `i` (letters, digits, underscore,
 * plus any chars in `extra`), or "" if `i` is not at a word start.
 *
 * @example matchWord("foo(", 0) // "foo"
 * @example matchWord("my-prop:", 0, "-") // "my-prop"
 * @example matchWord("  x", 0) // ""
 */
export function matchWord(text, i, extra = "") {
  const esc = extra.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const re = new RegExp(`^[A-Za-z_${esc}][A-Za-z0-9_${esc}]*`);
  const m = text.slice(i).match(re);
  return m ? m[0] : "";
}

/**
 * Pure function. Matches a run of punctuation/operator characters at `i`, or ""
 * if `i` is not at one. Grouped so a run like "===" is one token, not three.
 *
 * @example matchPunct("=> x", 0) // "=>"
 * @example matchPunct("a", 0) // ""
 * @example matchPunct("{ }", 0) // "{"
 */
export function matchPunct(text, i) {
  const m = text.slice(i).match(/^[{}()[\];:,.<>=!+\-*/%&|^~?@]+/);
  return m ? m[0] : "";
}

// ── the language table + public entry points ──────────────────────────────────

/**
 * langId → the per-line tokenizer. Aliases fold to a canonical grammar (ts→js,
 * yaml→plain-ish is NOT included; only the seven declared languages are here).
 * A langId not in this table falls back to PLAIN (see highlightCode).
 */
const LANGUAGES = {
  js: (t, s) => cTokenizeLine(t, s, JS_KEYWORDS),
  javascript: (t, s) => cTokenizeLine(t, s, JS_KEYWORDS),
  ts: (t, s) => cTokenizeLine(t, s, JS_KEYWORDS),
  typescript: (t, s) => cTokenizeLine(t, s, JS_KEYWORDS),
  jsx: (t, s) => cTokenizeLine(t, s, JS_KEYWORDS),
  tsx: (t, s) => cTokenizeLine(t, s, JS_KEYWORDS),
  py: pyTokenizeLine,
  python: pyTokenizeLine,
  sh: bashTokenizeLine,
  bash: bashTokenizeLine,
  shell: bashTokenizeLine,
  zsh: bashTokenizeLine,
  json: jsonTokenizeLine,
  css: cssTokenizeLine,
  html: htmlTokenizeLine,
  xml: htmlTokenizeLine,
};

/**
 * Pure function. The list of language ids offered in the code-block inspector's
 * language dropdown. "plain" (no highlighting) leads; then the canonical names
 * of every supported grammar (aliases collapsed).
 *
 * @example languageOptions()[0] // {value: "plain", label: "Plain text"}
 * @example languageOptions().some((o) => o.value === "python") // true
 */
export function languageOptions() {
  return [
    { value: "plain", label: "Plain text" },
    { value: "javascript", label: "JavaScript" },
    { value: "typescript", label: "TypeScript" },
    { value: "python", label: "Python" },
    { value: "html", label: "HTML" },
    { value: "css", label: "CSS" },
    { value: "bash", label: "Bash" },
    { value: "json", label: "JSON" },
  ];
}

/**
 * Pure function. Is `langId` a language this highlighter can tokenize? (false →
 * highlightCode returns plain tokens — the declared fallback, not an error.)
 *
 * @example isSupportedLanguage("python") // true
 * @example isSupportedLanguage("PYTHON") // true (case-insensitive)
 * @example isSupportedLanguage("brainfuck") // false
 * @example isSupportedLanguage(undefined) // false
 */
export function isSupportedLanguage(langId) {
  return typeof langId === "string" && langId.toLowerCase() in LANGUAGES;
}

/**
 * Pure function. Tokenizes a whole multi-line code string into per-line token
 * arrays, threading cross-line block state (comments, template/triple strings).
 * The concatenation of a line's token `text`s equals that source line exactly
 * (no chars added/dropped) — the code-block plugin depends on this for faithful
 * monospace layout. An unknown/absent langId yields one {text: line, kind:
 * "plain"} token per line: the DECLARED fallback (unknown languages render as
 * plain monochrome mono text — documented, never a thrown error).
 *
 * Newlines: the input is split on "\n" (a trailing "\n" yields a final empty
 * line, matching how an editor shows a trailing blank line). Empty lines become
 * an empty token array [] (the plugin still advances a line for them).
 *
 * Args:
 *   code (string): the full source text (may contain "\n")
 *   langId (string|undefined): a language id (see languageOptions / aliases)
 *
 * Returns:
 *   {text, kind}[][] — one token array per line
 *
 * @example highlightCode("const x = 1", "js")[0][0] // {text: "const", kind: "keyword"}
 * @example highlightCode("a\nb", "plain") // [[{text: "a", kind: "plain"}], [{text: "b", kind: "plain"}]]
 * @example highlightCode("# hi\nx = 1", "python")[0][0].kind // "comment"
 * @example highlightCode("", "js") // [[]]
 * @example highlightCode("x = 1", "no-such-lang")[0] // [{text: "x = 1", kind: "plain"}]
 * (the multi-line C block-comment case — where a comment opened on line 1 keeps
 *  line 2 comment-colored — is verified in the test file; it can't be written as
 *  a literal doctest here without closing this JSDoc block)
 */
export function highlightCode(code, langId) {
  const src = String(code ?? "");
  const lines = src.split("\n");
  const tokenizer = isSupportedLanguage(langId) ? LANGUAGES[langId.toLowerCase()] : null;
  if (!tokenizer) {
    // Declared plain fallback: each non-empty line is one plain token.
    return lines.map((line) => (line.length ? [{ text: line, kind: "plain" }] : []));
  }
  const out = [];
  let state = null;
  for (const line of lines) {
    const res = tokenizer(line, state);
    state = res.state ?? null;
    out.push(res.tokens);
  }
  return out;
}
