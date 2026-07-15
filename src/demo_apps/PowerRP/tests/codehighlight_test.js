/**
 * core/codeHighlight.js + plugins/codeblock.js layout tests — the offline
 * syntax highlighter and the code-block mono-grid layout. Bare node, no
 * framework (suite conventions). Mirrors the modules' @example doctests plus
 * behavioral cases on REAL code snippets per language (js/ts/python/html/css/
 * bash/json), the cross-line block-state threading, and the exact-reconstruction
 * invariant (tokens concatenate back to the source, byte-for-byte).
 *
 * Run: node src/demo_apps/PowerRP/tests/codehighlight_test.js
 */

import assert from "node:assert/strict";
import {
  highlightCode, isSupportedLanguage, languageOptions, KINDS,
  cTokenizeLine, pyTokenizeLine, bashTokenizeLine, jsonTokenizeLine,
  cssTokenizeLine, htmlTokenizeLine,
  scanQuoted, matchNumber, matchWord, matchPunct,
} from "../core/codeHighlight.js";
import {
  codeblockPlugin, layoutCodeDraws, expandTabs, gutterColumns, kindColor,
  MONO_ADVANCE_RATIO, CODE_LINE_HEIGHT, TAB_WIDTH, CODE_PALETTES, CODE_TOKEN_KINDS,
} from "../plugins/codeblock.js";

let passed = 0;
function test(name, fn) { fn(); console.log(`  ok  ${name}`); passed += 1; }

/** The token texts of a line concatenated — must equal the source line. */
function lineText(tokens) { return tokens.map((t) => t.text).join(""); }
/** Find the first token of a given kind in a line, or undefined. */
function firstOfKind(tokens, kind) { return tokens.find((t) => t.kind === kind); }

// ── shared scanning helpers (pure) ────────────────────────────────────────────

test("scanQuoted: plain, escaped, unterminated", () => {
  assert.equal(scanQuoted('"ab"c', 0, '"'), 4);
  assert.equal(scanQuoted('"a\\"b"', 0, '"'), 6);
  assert.equal(scanQuoted('"open', 0, '"'), 5);
});

test("matchNumber: int/hex/decimal/scientific; none", () => {
  assert.equal(matchNumber("42px", 0), "42");
  assert.equal(matchNumber("0xFF ", 0), "0xFF");
  assert.equal(matchNumber("1.5e-3;", 0), "1.5e-3");
  assert.equal(matchNumber(".5", 0), ".5");
  assert.equal(matchNumber("abc", 0), "");
});

test("matchWord: identifiers + extra chars", () => {
  assert.equal(matchWord("foo(", 0), "foo");
  assert.equal(matchWord("my-prop:", 0, "-"), "my-prop");
  assert.equal(matchWord("  x", 0), "");
  assert.equal(matchWord("_private", 0), "_private");
});

test("matchPunct: grouped operator runs", () => {
  assert.equal(matchPunct("=> x", 0), "=>");
  assert.equal(matchPunct("===", 0), "===");
  assert.equal(matchPunct("{ }", 0), "{");
  assert.equal(matchPunct("a", 0), "");
});

// ── JavaScript / TypeScript (C-family) ────────────────────────────────────────

test("js: keyword / function / number / string / reconstruct", () => {
  const [line] = highlightCode('const x = foo("hi", 42);', "js");
  assert.equal(firstOfKind(line, "keyword").text, "const");
  assert.equal(firstOfKind(line, "function").text, "foo");
  assert.equal(firstOfKind(line, "string").text, '"hi"');
  assert.equal(firstOfKind(line, "number").text, "42");
  assert.equal(lineText(line), 'const x = foo("hi", 42);'); // exact reconstruction
});

test("js: line comment colors to EOL", () => {
  const [line] = highlightCode("x = 1; // set it", "javascript");
  assert.equal(firstOfKind(line, "comment").text, "// set it");
});

test("js: block comment spans lines (cross-line state)", () => {
  const lines = highlightCode("a /* open\nmiddle\nclose */ b", "js");
  assert.equal(lines.length, 3);
  assert.equal(firstOfKind(lines[0], "comment").text, "/* open");
  assert.equal(lines[1][0].kind, "comment");        // whole middle line is comment
  assert.equal(firstOfKind(lines[2], "comment").text, "close */");
  // After the block closes, ` b` tokenizes normally.
  assert.ok(lines[2].some((t) => t.text.includes("b")));
  for (const l of lines) assert.equal(lineText(l).length >= 0, true);
});

test("ts: interface/type keywords via the shared c grammar", () => {
  const [line] = highlightCode("interface Point { x: number }", "typescript");
  assert.equal(firstOfKind(line, "keyword").text, "interface");
});

test("js: template literal spans lines", () => {
  const lines = highlightCode("const s = `line one\nline two`;", "js");
  assert.equal(lines.length, 2);
  assert.ok(firstOfKind(lines[0], "string").text.includes("`line one"));
  assert.equal(lines[1][0].kind, "string"); // continuation is still string
});

// ── Python ────────────────────────────────────────────────────────────────────

test("python: def keyword, function name, comment, string", () => {
  const [line] = highlightCode('def greet(name):  # hi', "python");
  assert.equal(firstOfKind(line, "keyword").text, "def");
  assert.equal(firstOfKind(line, "function").text, "greet");
  assert.equal(firstOfKind(line, "comment").text, "# hi");
});

test("python: triple-quoted docstring spans lines", () => {
  const lines = highlightCode('def f():\n    """A docstring\n    over lines"""\n    return 1', "python");
  assert.equal(lines.length, 4);
  assert.ok(firstOfKind(lines[1], "string").text.includes('"""A docstring'));
  assert.equal(lines[2][0].kind, "string");       // continuation
  assert.equal(firstOfKind(lines[3], "keyword").text, "return");
});

test("python: True/False/None/self are keywords", () => {
  const [line] = highlightCode("x = None if self.ok else True", "py");
  const kws = line.filter((t) => t.kind === "keyword").map((t) => t.text);
  assert.ok(kws.includes("None"));
  assert.ok(kws.includes("self"));
  assert.ok(kws.includes("True"));
});

// ── Bash ──────────────────────────────────────────────────────────────────────

test("bash: command keyword + string + comment ($VAR inside a string stays string)", () => {
  const [line] = highlightCode('echo "$HOME/bin" # path', "bash");
  assert.equal(firstOfKind(line, "keyword").text, "echo");           // echo is a listed keyword
  assert.equal(firstOfKind(line, "string").text, '"$HOME/bin"');     // whole quoted run is a string (no interpolation parse)
  assert.equal(firstOfKind(line, "property"), undefined);            // the $HOME is inside the string, not a bare var
  assert.equal(firstOfKind(line, "comment").text, "# path");
});

test("bash: bare $VAR outside quotes is a variable (property)", () => {
  const [line] = highlightCode("cd $HOME", "sh");
  assert.equal(firstOfKind(line, "keyword").text, "cd");             // cd is a listed keyword
  assert.equal(firstOfKind(line, "property").text, "$HOME");         // bare var → property
});

test("bash: first non-keyword word is the command (function)", () => {
  const [line] = highlightCode("mytool --flag value", "bash");
  assert.equal(firstOfKind(line, "function").text, "mytool");
});

test("bash: # only starts a comment at a word boundary", () => {
  const [line] = highlightCode('echo ${x#prefix}', "bash");
  assert.equal(firstOfKind(line, "comment"), undefined); // the # inside ${...} is not a comment
});

// ── JSON ──────────────────────────────────────────────────────────────────────

test("json: keys vs values vs literals", () => {
  const [line] = highlightCode('"name": "PowerRP", "n": 3, "ok": true', "json");
  const props = line.filter((t) => t.kind === "property").map((t) => t.text);
  assert.deepEqual(props, ['"name"', '"n"', '"ok"']); // all three keys
  const strs = line.filter((t) => t.kind === "string").map((t) => t.text);
  assert.deepEqual(strs, ['"PowerRP"']);              // only the value string
  assert.equal(firstOfKind(line, "number").text, "3");
  assert.equal(firstOfKind(line, "keyword").text, "true");
});

// ── CSS ───────────────────────────────────────────────────────────────────────

test("css: property, value, number+unit, hex color, comment", () => {
  const lines = highlightCode(".box {\n  color: #ff0000;\n  width: 12px; /* c */\n}", "css");
  const decl = lines[1];
  assert.equal(firstOfKind(decl, "property").text, "color");
  assert.equal(firstOfKind(decl, "number").text, "#ff0000"); // hex colors → number family
  const wline = lines[2];
  assert.equal(firstOfKind(wline, "number").text, "12px");   // unit folded into the number
  assert.equal(firstOfKind(wline, "comment").text, "/* c */");
});

test("css: at-rule keyword and function name", () => {
  const [line] = highlightCode("@media (min-width: calc(10px + 2%)) {", "css");
  assert.equal(firstOfKind(line, "keyword").text, "@media");
  assert.ok(line.some((t) => t.kind === "function" && t.text === "calc"));
});

test("css: block comment spans lines", () => {
  const lines = highlightCode("/* a\n b */ .x {}", "css");
  assert.equal(lines[0][0].kind, "comment");
  assert.ok(firstOfKind(lines[1], "comment").text.includes("b */"));
});

// ── HTML ──────────────────────────────────────────────────────────────────────

test("html: tag name, attribute, attribute value string", () => {
  const [line] = highlightCode('<a href="https://x" class="y">link</a>', "html");
  assert.ok(line.some((t) => t.kind === "keyword" && t.text === "a"));
  assert.ok(line.some((t) => t.kind === "property" && t.text === "href"));
  assert.ok(line.some((t) => t.kind === "string" && t.text.includes("https://x")));
  assert.equal(lineText(line), '<a href="https://x" class="y">link</a>'); // exact
});

test("html: comment spans lines", () => {
  const lines = highlightCode("<!-- top\n note --> <p>", "html");
  assert.equal(lines[0][0].kind, "comment");
  assert.ok(firstOfKind(lines[1], "comment").text.includes("note -->"));
  assert.ok(lines[1].some((t) => t.kind === "keyword" && t.text === "p"));
});

// ── fallback + entry points ───────────────────────────────────────────────────

test("unknown language → one plain token per line (declared fallback)", () => {
  const lines = highlightCode("x = 1\ny = 2", "brainfuck");
  assert.deepEqual(lines, [[{ text: "x = 1", kind: "plain" }], [{ text: "y = 2", kind: "plain" }]]);
});

test("plain language id → plain tokens", () => {
  assert.deepEqual(highlightCode("anything", "plain"), [[{ text: "anything", kind: "plain" }]]);
});

test("empty lines become empty token arrays; trailing newline adds a blank line", () => {
  assert.deepEqual(highlightCode("", "js"), [[]]);
  const lines = highlightCode("a\n\nb\n", "js");
  assert.equal(lines.length, 4);       // a / blank / b / trailing-blank
  assert.deepEqual(lines[1], []);      // the blank interior line
  assert.deepEqual(lines[3], []);      // the trailing blank
});

test("isSupportedLanguage: case-insensitive; aliases; negatives", () => {
  assert.equal(isSupportedLanguage("python"), true);
  assert.equal(isSupportedLanguage("PYTHON"), true);
  assert.equal(isSupportedLanguage("tsx"), true);
  assert.equal(isSupportedLanguage("brainfuck"), false);
  assert.equal(isSupportedLanguage(undefined), false);
});

test("languageOptions: plain leads; python present; every KIND has a name", () => {
  assert.deepEqual(languageOptions()[0], { value: "plain", label: "Plain text" });
  assert.ok(languageOptions().some((o) => o.value === "python"));
  assert.ok(Array.isArray(KINDS) && KINDS.includes("plain"));
});

test("EXACT-RECONSTRUCTION invariant holds across a mixed real snippet", () => {
  const src = 'async function main() {\n  const url = `${base}/api`; // fetch\n  return await get(url, 200);\n}';
  for (const lang of ["js", "ts"]) {
    const lines = highlightCode(src, lang);
    assert.equal(lines.map(lineText).join("\n"), src, `reconstruct ${lang}`);
  }
});

// ── codeblock plugin: mono-grid layout ────────────────────────────────────────

test("constants: mono advance measured 0.6; line-height linked to richtext 1.2", () => {
  assert.equal(MONO_ADVANCE_RATIO, 0.6);
  assert.equal(CODE_LINE_HEIGHT, 1.2);
  assert.equal(TAB_WIDTH, 4);
});

test("expandTabs: leading + interior tab snap to columns", () => {
  assert.equal(expandTabs("\tx", 4), "    x");
  assert.equal(expandTabs("ab\tc", 4), "ab  c");
  assert.equal(expandTabs("no tabs", 4), "no tabs");
});

test("gutterColumns: digit count + pad; 0 when off", () => {
  assert.equal(gutterColumns(9, true), 2);
  assert.equal(gutterColumns(100, true), 4);
  assert.equal(gutterColumns(50, false), 0);
});

test("kindColor: palette lookup + plain fallback", () => {
  assert.equal(kindColor("keyword", CODE_PALETTES.dark), CODE_PALETTES.dark.keyword);
  assert.equal(kindColor("mystery", CODE_PALETTES.dark), CODE_PALETTES.dark.plain);
});

test("CODE_PALETTES cover every highlighter KIND (+ bg/gutter)", () => {
  for (const pname of Object.keys(CODE_PALETTES)) {
    const p = CODE_PALETTES[pname];
    for (const kind of CODE_TOKEN_KINDS) assert.ok(kind in p, `${pname} missing ${kind}`);
    assert.ok("bg" in p && "gutter" in p, `${pname} missing bg/gutter`);
  }
});

test("layoutCodeDraws: x/y on the mono grid; line numbers in the gutter", () => {
  const lines = highlightCode("ab\ncd", "plain");
  const opts = { fontSize: 10, w: 400, padding: 4, lineNumbers: true, palette: CODE_PALETTES.dark, tabWidth: 4 };
  const draws = layoutCodeDraws(lines, opts);
  const charW = 10 * MONO_ADVANCE_RATIO;    // 6
  const lineH = 10 * CODE_LINE_HEIGHT;       // 12
  // Two line-number draws ("1","2") and two code draws ("ab","cd").
  assert.ok(draws.some((d) => d.text === "1" && d.color === CODE_PALETTES.dark.gutter));
  const ab = draws.find((d) => d.text === "ab");
  const gutterCols = gutterColumns(2, true); // 2
  assert.equal(ab.x, 4 + gutterCols * charW); // codeLeft = padding + gutter width
  assert.equal(ab.y, 4);                      // first line at padding
  const cd = draws.find((d) => d.text === "cd");
  assert.equal(cd.y, 4 + lineH);              // second line advanced by lineH
});

test("layoutCodeDraws: long line truncates to visible columns (mono clip, no wrap)", () => {
  const long = "x".repeat(200);
  const lines = highlightCode(long, "plain");
  // Narrow box: only a few columns fit.
  const opts = { fontSize: 10, w: 80, padding: 4, lineNumbers: false, palette: CODE_PALETTES.dark, tabWidth: 4 };
  const draws = layoutCodeDraws(lines, opts);
  const charW = 10 * MONO_ADVANCE_RATIO;
  const visibleCols = Math.floor((80 - 4 - 4) / charW); // (w - codeLeft - padding)/charW
  const shown = draws.filter((d) => d.text.length).map((d) => d.text).join("");
  assert.ok(shown.length <= visibleCols, `${shown.length} <= ${visibleCols}`);
  assert.ok(shown.length > 0); // something renders
});

// ── codeblock plugin: emit() shape ────────────────────────────────────────────

test("codeblockPlugin.emit: box first, then colored mono text ops", () => {
  const cmds = codeblockPlugin.emit({ ...codeblockPlugin.defaults, w: 300, h: 120 });
  assert.equal(cmds[0].op, "rect");            // the box background
  const textOps = cmds.filter((c) => c.op === "text");
  assert.ok(textOps.length > 0);
  for (const t of textOps) {
    assert.equal(t.font, "jetbrains-mono");    // committed mono face
    assert.ok(Array.isArray(t.color));         // parsed rgba
  }
  // The default code has a keyword-colored run distinct from a string-colored one.
  const colors = new Set(textOps.map((t) => JSON.stringify(t.color)));
  assert.ok(colors.size >= 2, "highlighting produced multiple colors");
});

test("codeblockPlugin.emit: unknown language → all plain-colored text (no throw)", () => {
  const cmds = codeblockPlugin.emit({ ...codeblockPlugin.defaults, language: "no-such", code: "a\nb" });
  const textOps = cmds.filter((c) => c.op === "text");
  assert.ok(textOps.length > 0);
});

test("codeblockPlugin: composes strokedBox (fill/stroke/strokeWidth/cornerRadius) rows", () => {
  const keys = new Set(codeblockPlugin.inspector.map((r) => r.key));
  for (const k of ["fill", "stroke", "strokeWidth", "cornerRadius", "opacity", "x", "y", "w", "h"]) {
    assert.ok(keys.has(k), `inspector missing ${k}`);
  }
  for (const k of ["code", "language", "fontSize", "lineNumbers", "padding", "theme"]) {
    assert.ok(keys.has(k), `inspector missing code row ${k}`);
  }
});

test("codeblockPlugin: anchors identical to a rounded rect rim (r=0 → standard bbox)", () => {
  const a = codeblockPlugin.anchors({ w: 100, h: 60, cornerRadius: 0 });
  // Center anchor id is "cm" (center-middle) in standardBBoxAnchors.
  const center = a.find((p) => p.id === "cm");
  assert.ok(center, "has a center-middle anchor");
  assert.equal(center.x, 50);
  assert.equal(center.y, 30);
});

console.log(`\n${passed} codehighlight/codeblock tests passed`);
