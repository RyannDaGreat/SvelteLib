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

/**
 * The custom languages this app registers with Monaco, as `{id, keywords}` so the
 * completion provider and the docs stay in sync. Monarch token rules are declared
 * per-language in registerLanguages() below.
 */
export const MONACO_LANGUAGES = ["mermaid", "latex"];

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

/** Command (browser-only). Registers the Mermaid + LaTeX Monarch grammars and a
 *  keyword completion provider for Mermaid. Called once by setupMonacoOnce. */
function registerLanguages(monaco) {
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
}
