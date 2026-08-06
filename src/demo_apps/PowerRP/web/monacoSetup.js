/**
 * MONACO BOOTSTRAP (BROWSER-ONLY) — the single place that wires Monaco's web
 * worker for Vite and registers the app's custom languages. web/CodeEditorModal.svelte
 * imports this for its side effect (`setupMonacoOnce`), the mermaidRenderer.js
 * precedent of keeping every Vite-only specifier (`?worker`) in ONE browser-facing
 * module.
 *
 * ── THE WORKER (the one wiring Monaco actually needs) ─────────────────────────
 * Monaco offloads tokenization/diffs to a web worker. The documented Vite route is
 * a `?worker` import (Vite bundles it as a separate chunk) handed back through
 * `self.MonacoEnvironment.getWorker`. We import the CORE editor worker only —
 * `editor.api` (imported by the modal) ships NO built-in languages, so there are no
 * per-language workers (json/ts/css/html) to wire; our two grammars are Monarch
 * token providers that run on the main thread. That keeps the bundle to the editor
 * core plus two tiny grammars rather than Monaco's ~80-language kitchen sink.
 *
 * ── OFFLINE + PROBE-SAFE ──────────────────────────────────────────────────────
 * `monaco-editor` is an ordinary npm dependency (no CDN, dump-portable), and
 * web/vite.config.js pre-bundles it in optimizeDeps so its first use never triggers
 * a mid-session dep re-optimize + page reload (the pdfjs/mathjax/mermaid flake class
 * documented there).
 */

// The core editor worker, as a Vite worker chunk. Static import so Vite builds the
// worker at server start (deterministic), not on first modal open (mid-session).
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// ── THE SUGGEST WIDGET IS A CONTRIBUTION, AND IT HAS TO BE ASKED FOR ─────────
// The docblock above says `editor.api` ships no built-in LANGUAGES. It also ships no
// editor CONTRIBUTIONS — suggest, find, hover, folding and the rest live under
// `contrib/` and are pulled in by `editor.main`, not by `editor.api`. So an editor
// built from `editor.api` alone has no suggest CONTROLLER at all: a registered
// CompletionItemProvider is never consulted, and no widget can appear.
//
// MEASURED, 2026-08-06, while wiring the equation language: `registerCompletionItemProvider`
// was live and `suggestEquation` returned five candidates for the exact caret under
// test (verified in bare node), the model's language id read "powerrp-equation", and
// typing "self." produced NO suggest widget and NO error. THIS ALSO MEANS MERMAID'S
// KEYWORD COMPLETION HAS NEVER RUN — that provider has been registered since the
// modal landed, against an editor with nothing to call it. The user's ask for the
// modal was "syntax highlighting, autocomplete, minimap, everything"; the
// highlighting and the minimap arrived, and the autocomplete quietly did not.
//
// Imported HERE rather than in the modal because this file is "the single place that
// wires Monaco", and imported as the CONTROLLER only (not `editor.main`) so the
// bundle takes the one contribution the app actually uses instead of Monaco's whole
// contrib set. It is a side-effect import: loading the module registers the
// contribution with the editor.
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";

import { JS_KEYWORDS } from "../core/codeHighlight.js";
import { EQUATION_LANGUAGE_ID, registerEquationLanguage } from "./equationCode.js";

/**
 * The custom languages this app registers with Monaco. Monarch token rules are
 * declared per-language in registerLanguages() below.
 *
 * `javascript` IS IN THIS LIST, which reads like a mistake and is not: the modal
 * imports `editor.api`, which ships NO built-in languages at all (see the worker
 * note above), so Monaco knows nothing about JavaScript unless this app teaches it.
 * Without the grammar registered here, `language: "javascript"` fell through to
 * plaintext — the editor opened, took the text, and coloured NOTHING, which is the
 * silent-degradation shape this codebase refuses. THE PROJECT SCRIPT
 * (core/project_script.js) is edited in JavaScript, and the user asked for "the
 * modal with full syntax highlighting" in the same sentence that asked for it.
 *
 * THE EQUATION LANGUAGE is in this list but NOT declared in this file: unlike the
 * three above it is not a keyword grammar at all, so it lives in
 * web/equationCode.js with the resolver and suggest plumbing it delegates to (read
 * that file's header for why a Monarch tokenizer cannot express it). Registered
 * from registerLanguages() below so there is still exactly ONE place languages are
 * turned on.
 */
export const MONACO_LANGUAGES = ["mermaid", "latex", "javascript", EQUATION_LANGUAGE_ID];

let didSetup = false;

/**
 * Command (idempotent, browser-only). Wires Monaco's web worker and registers the
 * Mermaid + LaTeX grammars the FIRST time it is called; a no-op thereafter. Safe to
 * call before every editor.create().
 *
 * @param {object} monaco - the `monaco-editor/esm/vs/editor/editor.api` namespace
 */
export function setupMonacoOnce(monaco) {
  if (didSetup) return;
  didSetup = true;
  // The worker factory. label is the language worker id; we ship only the core
  // editor worker, which serves every Monarch language.
  self.MonacoEnvironment = {
    getWorker() {
      return new EditorWorker();
    },
  };
  registerLanguages(monaco);
}

/** Mermaid diagram-type + block keywords (the words worth colouring + completing).
 *  COVERAGE NOTE: this is a pragmatic keyword grammar, NOT a full Mermaid parser —
 *  it colours the diagram-type headers, structural keywords (subgraph/end/loop/…),
 *  arrows and comments, which is what makes a diagram readable while editing. It
 *  does not validate; the widget's own mermaid.parse() is the source of truth for
 *  errors (the in-canvas red affordance). */
const MERMAID_KEYWORDS = [
  "graph", "flowchart", "sequenceDiagram", "classDiagram", "stateDiagram", "stateDiagram-v2",
  "erDiagram", "gantt", "pie", "journey", "gitGraph", "mindmap", "timeline", "quadrantChart",
  "requirementDiagram", "sankey-beta", "xychart-beta", "block-beta", "C4Context",
  "subgraph", "end", "direction", "participant", "actor", "loop", "alt", "else", "opt",
  "par", "and", "critical", "break", "rect", "note", "over", "activate", "deactivate",
  "class", "state", "section", "title", "dateFormat", "axisFormat", "excludes", "todayMarker",
  "click", "callback", "link", "classDef", "style", "linkStyle", "accTitle", "accDescr",
  "TB", "TD", "BT", "RL", "LR",
];

/** Command (browser-only). Registers the Mermaid + LaTeX + JavaScript Monarch
 *  grammars and a keyword completion provider for Mermaid. Called once by
 *  setupMonacoOnce. */
function registerLanguages(monaco) {
  registerJavaScript(monaco);
  // ── Mermaid ────────────────────────────────────────────────────────────────
  monaco.languages.register({ id: "mermaid" });
  monaco.languages.setMonarchTokensProvider("mermaid", {
    keywords: MERMAID_KEYWORDS,
    tokenizer: {
      root: [
        [/%%.*$/, "comment"],                                   // %% line comment
        [/"/, { token: "string.quote", next: "@string" }],       // "quoted label"
        [/[-.=]+>{1,2}|<?[-.=]+[|ox>]?|--[>x)o]?|===|\.\./, "operator"], // arrows/links
        [/[|{}[\]()>]/, "delimiter"],
        [/:::?/, "operator"],                                    // ::: class attach, : label
        [/\b\d+\b/, "number"],
        [/[a-zA-Z_$][\w$-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[;,]/, "delimiter"],
      ],
      string: [
        [/[^"]+/, "string"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
    },
  });
  monaco.languages.registerCompletionItemProvider("mermaid", {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: word.startColumn, endColumn: word.endColumn,
      };
      const suggestions = MERMAID_KEYWORDS.map((kw) => ({
        label: kw,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: kw,
        range,
      }));
      return { suggestions };
    },
  });

  // ── LaTeX ──────────────────────────────────────────────────────────────────
  // A light math-source grammar: backslash commands, braces/brackets, sub/super
  // script operators, $…$ math delimiters, and % comments. Enough to read an
  // equation source; MathJax remains the source of truth for validity.
  monaco.languages.register({ id: "latex" });
  monaco.languages.setMonarchTokensProvider("latex", {
    tokenizer: {
      root: [
        [/%.*$/, "comment"],
        [/\\[a-zA-Z@]+/, "keyword"],   // \frac \sqrt \alpha …
        [/\\[^a-zA-Z]/, "keyword"],    // escaped punctuation (\{ \} \\ …)
        [/[{}[\]]/, "delimiter"],
        [/[&^_]/, "operator"],
        [/\$+/, "string"],             // $ / $$ math delimiters
        [/\d+(\.\d+)?/, "number"],
      ],
    },
  });

  // ── PowerRP equations ──────────────────────────────────────────────────────
  // Declared in web/equationCode.js, not here: it is not a keyword grammar but a
  // DOCUMENT SEMANTIC TOKENS provider over core/expressions.js's real resolver,
  // plus a completion provider over core/equationSuggest.js. Called from here so
  // this function stays the one place a language is turned on.
  registerEquationLanguage(monaco);
}

/**
 * Command (browser-only). Registers the JAVASCRIPT grammar — the language THE
 * PROJECT SCRIPT (core/project_script.js) is written in. See MONACO_LANGUAGES for
 * why this app has to ship its own JS grammar at all.
 *
 * Keywords come from core/codeHighlight.js's JS_KEYWORDS, the SAME list the canvas
 * code-block widget colours by, so the two surfaces cannot disagree about what a
 * keyword is. Like that highlighter, this is deliberately SHALLOW — keywords,
 * strings (including template literals), comments, numbers, regex-free operators
 * and bracket pairs — which is what makes code readable while editing. Monaco's own
 * bracket-pair colourization, folding and word-based autocomplete (all enabled in
 * CodeEditorModal) work off the token stream, so they come along for free.
 *
 * A DIVERGENCE FROM MONACO'S BUNDLED TYPESCRIPT SERVICE, stated rather than
 * implied: there is no type checking, no IntelliSense over the jail's globals and
 * no squiggles. Correctness feedback for a script is the COMPILER's job
 * (compileProjectScript's error, surfaced at the script) — a second, weaker opinion
 * from an editor that does not know about the jail would be worse than none, since
 * it would flag `time` and `random` as undefined while missing every real problem.
 */
function registerJavaScript(monaco) {
  monaco.languages.register({ id: "javascript" });
  monaco.languages.setLanguageConfiguration("javascript", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
      { open: "`", close: "`", notIn: ["string"] },
    ],
  });
  monaco.languages.setMonarchTokensProvider("javascript", {
    keywords: [...JS_KEYWORDS],
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@blockComment" }],
        [/"/, { token: "string.quote", next: "@doubleString" }],
        [/'/, { token: "string.quote", next: "@singleString" }],
        [/`/, { token: "string.quote", next: "@template" }],
        // A NUMBER before the identifier rule, so `0x1f` and `1e3` stay whole.
        [/\b0[xX][0-9a-fA-F]+\b/, "number.hex"],
        [/\b\d+(\.\d+)?([eE][-+]?\d+)?\b/, "number"],
        // A call site (`name(`) is coloured as a function rather than a plain
        // identifier — the one cue that makes a library of helpers readable at a
        // glance, and the same one core/codeHighlight.js emits.
        [/[a-zA-Z_$][\w$]*(?=\s*\()/, { cases: { "@keywords": "keyword", "@default": "type.identifier" } }],
        [/[a-zA-Z_$][\w$]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/=>|[-+*/%=<>!&|^~?:]+/, "operator"],
        [/[;,.]/, "delimiter"],
      ],
      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[/*]/, "comment"],
      ],
      // Each string state pops on its OWN quote and consumes `\"`-style escapes as
      // one unit, so an escaped quote does not end the string.
      doubleString: [
        [/\\./, "string.escape"],
        [/[^\\"]+/, "string"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
      singleString: [
        [/\\./, "string.escape"],
        [/[^\\']+/, "string"],
        [/'/, { token: "string.quote", next: "@pop" }],
      ],
      // A template literal's ${…} is CODE, which is why template literals get their
      // own state: `${a + b}` must colour as an expression, not as string body.
      //
      // The interpolation pushes a DEDICATED state rather than re-entering @root: a
      // `next: "@root"` push has no way back — root's bracket rule matches the
      // closing `}` as an ordinary bracket and never pops — so the rest of the file
      // after the first `${…}` would have been tokenized as if still inside it.
      template: [
        [/\\./, "string.escape"],
        [/\$\{/, { token: "delimiter.bracket", next: "@templateExpr" }],
        [/[^\\`$]+/, "string"],
        [/\$/, "string"],
        [/`/, { token: "string.quote", next: "@pop" }],
      ],
      // Interpolation body: the expression cues worth colouring, and the `}` that
      // hands control back to the surrounding template.
      templateExpr: [
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        [/"/, { token: "string.quote", next: "@doubleString" }],
        [/'/, { token: "string.quote", next: "@singleString" }],
        [/\b\d+(\.\d+)?\b/, "number"],
        [/[a-zA-Z_$][\w$]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[-+*/%=<>!&|^~?:.,]+/, "operator"],
        [/[([\])]/, "@brackets"],
      ],
    },
  });
}
