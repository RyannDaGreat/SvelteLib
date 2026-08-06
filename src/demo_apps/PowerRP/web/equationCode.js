/**
 * THE EQUATION LANGUAGE FOR MONACO (browser-only) — what makes the `{}` button on
 * an equation row open a real editor rather than a big textarea.
 *
 * User, 2026-08-06: "You know how some properties have {} displayed on them when
 * editing code? Equations should always have that option too - a code editing
 * modal, with correct autocomplete/highlighting pops up so u can edit the equation
 * multiline."
 *
 * WHY MULTILINE IS A FEATURE AND NOT A STRETCH: the equation grammar ALREADY
 * accepts newlines — measured in bare node before any of this was written,
 * `= 1 +\n  2 +\n  3` evaluates to 6 with no error, and equationTokenSpans returns
 * correct offsets across the line breaks. So nothing in core changes; the one-line
 * <input> was the only thing standing between an author and an expression they can
 * read. That matters more now that meta.script exists (core/project_script.js) and
 * an equation can call into a whole library.
 *
 * ── NOT A SECOND GRAMMAR ─────────────────────────────────────────────────────
 * The two things that make this useful are the two things it would be easiest to
 * fork, so both delegate to the modules that already own them:
 *
 *   HIGHLIGHTING → core/expressions.js `equationTokenSpans`, the SAME resolver the
 *   inline field's `.eq-highlight` overlay paints from, wired in as a plain Monaco
 *   TOKENS PROVIDER. Deliberately NOT a Monarch grammar: Monarch is a regex machine,
 *   while our classes come from RESOLUTION (is this identifier a slug? a variable? a
 *   script export?), so a Monarch re-spelling could only be an approximation that
 *   disagrees with the evaluator — which the inline field's own docblock already
 *   rules out ("never a regex re-lex").
 *
 *   AUTOCOMPLETE → core/equationSuggest.js `suggestEquation`, the SAME function
 *   web/EquationSuggest.svelte ranks its list from, so the modal offers exactly the
 *   slugs, variables, reserved keywords, FUNCTIONS library and project-script
 *   exports the inline field offers. EquationSuggest.svelte ITSELF is not reused,
 *   deliberately: it is an absolutely-positioned list anchored to an <input>'s
 *   caret rect, and Monaco owns its own suggest widget, keyboard contract and
 *   scrolling. Two overlapping suggest popups in one editor would be the defect,
 *   not the reuse. The GRAMMAR is shared; only the presentation differs.
 *
 * A STATED DIVERGENCE, in the shape monacoSetup.js uses for its JavaScript grammar:
 * the COLOURS are Monaco's theme, not the field's `--a-eq-*` palette. Our resolver
 * classes map onto the same token scopes the sibling grammars use, so the modal
 * follows the editor theme CodeEditorModal switches with the UI. Matching the field's
 * exact hues would mean this module defining and applying its own Monaco theme,
 * fighting that component's theme lifecycle for a cosmetic gain. What must not
 * diverge — WHICH tokens exist and what each one IS — does not, because there is only
 * one tokenizer.
 *
 * ── THE ONE LIVE CONTEXT ─────────────────────────────────────────────────────
 * Monaco's providers are registered ONCE per language, globally, and are handed a
 * model and a position — never the document. So the resolver's inputs (state,
 * registry, self id, script exports) have to reach them some other way, and this
 * module holds them in one module-level slot.
 *
 * That is a global, and it is sound for one specific reason: THERE IS AT MOST ONE
 * CODE MODAL OPEN, APP-WIDE, and that is not a convention this file hopes for — it
 * is structural, because `app.codeModal` is a single field that openCodeModal /
 * openEquationCode overwrite. Same shape as src/lib/Tooltip.svelte's `openTipClose`
 * single-slot global, for the same reason: the invariant is one-at-a-time, so one
 * slot cannot be raced. A provider firing with NO context (a stale registration
 * after close) returns nothing rather than guessing — see the null guards.
 */
import { equationTokenSpans } from "../core/expressions.js";
import { suggestEquation } from "../core/equationSuggest.js";

/** The Monaco language id. Prefixed because Monaco's language registry is a flat
 *  global namespace shared with monacoSetup.js's ids and anything Monaco ships;
 *  "equation" alone is a word another grammar could plausibly claim. */
export const EQUATION_LANGUAGE_ID = "powerrp-equation";

/**
 * THE RESOLVER'S TOKEN CLASSES → Monaco token SCOPE NAMES.
 *
 * THE KEYS ARE THE AUTHORITY AND THEY ARE GATED, not trusted: the class vocabulary
 * lives in core/expressions.js and is painted by app.css's `.eq-tok-*` rules, so a
 * third hand-kept copy here is exactly the mirror this codebase pays for wherever it
 * appears. It cannot be DERIVED (a resolver's class names and a theme's scope names
 * are two vocabularies with no mechanical relation), so per the house rule it is
 * gated instead: tests/equation_code_language_test.js fails if app.css paints an
 * `.eq-tok-*` class this map does not name, or vice versa.
 *
 * THE VALUES ARE DRAWN ONLY FROM SCOPES THIS APP'S OTHER GRAMMARS ALREADY USE
 * (monacoSetup.js: keyword / number / string / identifier / type.identifier /
 * operator / delimiter), and that restraint is the lesson from a measured failure.
 * The first version of this file used a DocumentSemanticTokensProvider with the
 * standard semantic token types — a correct token stream, and the editor rendered
 * every line as a single `mtk1` run, because monaco's bundled vs / vs-dark themes
 * carry no semantic-token rules, so every token resolved to the default foreground.
 * Nothing errored. A scope the sibling grammars demonstrably colour cannot fail that
 * way, and per-line tokenization costs nothing here: the resolver classifies
 * LEXICALLY, so a line is classified identically whether or not it is a complete
 * expression (measured: "  nope" alone still resolves to `error`, "  abs(self.h) +"
 * still gives call/paren/self/paren/op).
 *
 * `op` vs `paren`/`punct` split the way the sibling grammars split arrows from
 * brackets, even though app.css paints all three with `--a-eq-punct`: this is the
 * COLOUR divergence the header states, not a disagreement about what a token is.
 */
export const CLASS_TO_SCOPE = Object.freeze({
  var: "identifier",
  prop: "identifier",
  anchor: "identifier",
  self: "keyword",       // the reserved head, not a user name
  call: "type.identifier", // a call site — monacoSetup's own "readable library" cue
  member: "identifier",  // the .x/.y projection after a call or paren
  num: "number",
  str: "string",
  color: "string",       // a colour literal IS a literal
  bool: "keyword",
  op: "operator",
  paren: "delimiter",
  punct: "delimiter",
  error: "invalid",      // the resolver's own verdict: this name resolves to nothing
});

// The live resolver inputs for the open equation modal, or null when none is open.
// See "THE ONE LIVE CONTEXT" above for why one slot is enough.
let context = null;

/**
 * Command. Publishes the resolver inputs the open equation editor's providers read,
 * or clears them with null. Called by app.svelte.js's openEquationCode and
 * closeCodeModal — nothing else may write this.
 *
 * @param {{state: object, registry: object, selfId: string|null, scriptExports: object}|null} next
 */
export function setEquationCodeContext(next) {
  context = next;
}

/**
 * Pure function. Splits `text` into the leading `=` marker (which is NOT part of the
 * expression grammar) and the expression after it, so an offset inside the expression
 * maps back onto the buffer.
 *
 * Stripped for the SAME reason the inline field strips it (NumericField's
 * buildHighlightPieces): equationTokenSpans and suggestEquation both tokenize what
 * they are handed, and a leading "=" is not a token.
 *
 * @param {string} text Buffer text, with or without a leading "=" marker.
 * @returns {{lead: string, expr: string}} The marker (possibly "") and the rest.
 *
 * @example splitEquationMarker("= self.w * 2") // { lead: "= ", expr: "self.w * 2" }
 * @example splitEquationMarker("1 +\n  2")     // { lead: "", expr: "1 +\n  2" }
 * @example splitEquationMarker("  7")          // { lead: "", expr: "  7" }
 */
export function splitEquationMarker(text) {
  const expr = text.replace(/^\s*=\s*/, "");
  return { lead: text.slice(0, text.length - expr.length), expr };
}

/** A stateless Monaco IState. The resolver needs no carry between lines (it
 *  classifies each line lexically), so every line starts from the same state and
 *  `equals` is always true — which also lets Monaco re-tokenize a single edited
 *  line instead of the whole buffer. */
const STATELESS = { clone: () => STATELESS, equals: () => true };

/**
 * Pure function. One line of equation text → Monaco's per-line token list.
 *
 * Monaco's contract: tokens are sorted by `startIndex`, and a token's scope runs
 * until the NEXT token's startIndex — so every gap needs an explicit empty-scope
 * token or it inherits the previous token's colour.
 *
 * THE `=` MARKER is handled here rather than by the caller because `tokenize` is not
 * told which line it is on. That is sound: `=` is not part of the expression grammar
 * at all, so a leading one can only ever be the marker, on whatever line it appears.
 *
 * @param {string} line One line of the buffer.
 * @param {object} state Resolver inputs {state, selfId, scriptExports}, or null.
 * @returns {Array<{startIndex: number, scopes: string}>}
 *
 * @example
 * // A number, an operator and a number, with the gaps stated explicitly.
 * lineTokens("1 + 2", {state: {items: {}}, selfId: null, scriptExports: {}})
 * // => [{startIndex: 0, scopes: "number"}, {startIndex: 1, scopes: ""},
 * //     {startIndex: 2, scopes: "operator"}, {startIndex: 3, scopes: ""},
 * //     {startIndex: 4, scopes: "number"}]
 * @example
 * // The "= " marker is its own delimiter token and shifts everything after it.
 * lineTokens("= 7", {state: {items: {}}, selfId: null, scriptExports: {}})
 * // => [{startIndex: 0, scopes: "delimiter"}, {startIndex: 2, scopes: "number"}]
 * @example
 * // With no resolver context there is nothing to resolve against, so the line is
 * // left uncoloured rather than guessed at.
 * lineTokens("1 + 2", null)
 * // => [{startIndex: 0, scopes: ""}]
 */
export function lineTokens(line, state) {
  if (!state) return [{ startIndex: 0, scopes: "" }];
  const { lead, expr } = splitEquationMarker(line);
  const spans = equationTokenSpans(expr, state.state, state.selfId, state.scriptExports);
  const tokens = lead.length ? [{ startIndex: 0, scopes: "delimiter" }] : [];
  let last = 0;
  for (const span of spans) {
    // The gap before this token (whitespace) carries no scope of its own.
    if (span.start > last) tokens.push({ startIndex: lead.length + last, scopes: "" });
    tokens.push({ startIndex: lead.length + span.start, scopes: CLASS_TO_SCOPE[span.cls] ?? "" });
    last = span.end;
  }
  if (last < expr.length) tokens.push({ startIndex: lead.length + last, scopes: "" });
  // A line with no spans at all (empty, or all whitespace) still needs one token:
  // Monaco requires the list to start at index 0.
  if (!tokens.length) tokens.push({ startIndex: 0, scopes: "" });
  return tokens;
}

/**
 * Pure function. core/equationSuggest.js's candidate `kind` → Monaco's
 * CompletionItemKind. An unknown kind maps to Text rather than throwing: a new
 * candidate kind should still be OFFERED (a missing suggestion is worse than a
 * generic icon), and the `detail` line carries the kind's real name either way.
 *
 * @param {object} monaco The editor api namespace (holds the enum).
 * @param {string} kind One of "keyword"/"slug"/"variable"/"property"/"function".
 * @returns {number} A monaco.languages.CompletionItemKind value.
 *
 * @example // A function candidate gets the function icon:
 * // completionKind(monaco, "function") === monaco.languages.CompletionItemKind.Function
 * @example // An unrecognised kind still yields a usable icon:
 * // completionKind(monaco, "brand-new") === monaco.languages.CompletionItemKind.Text
 */
export function completionKind(monaco, kind) {
  const K = monaco.languages.CompletionItemKind;
  const byKind = {
    keyword: K.Keyword,
    slug: K.Class,
    variable: K.Variable,
    property: K.Property,
    function: K.Function,
  };
  return byKind[kind] ?? K.Text;
}

/**
 * Command (browser-only). Registers the equation language with its resolver-backed
 * highlighting and its suggest list. Called ONCE from monacoSetup.js's one-time
 * setup, alongside the other grammars.
 *
 * @param {object} monaco The `monaco-editor/esm/vs/editor/editor.api` namespace.
 */
export function registerEquationLanguage(monaco) {
  monaco.languages.register({ id: EQUATION_LANGUAGE_ID });
  // Bracket pairs + auto-closing: an equation is parenthesised arithmetic, so
  // Monaco's bracket matching and pair colourization are worth having — both work
  // off the language CONFIGURATION rather than the token stream.
  // NO COMMENT SYNTAX, deliberately: the equation grammar has none, so offering
  // Cmd+/ would insert text that makes the expression unparseable.
  monaco.languages.setLanguageConfiguration(EQUATION_LANGUAGE_ID, {
    brackets: [["(", ")"], ["[", "]"]],
    autoClosingPairs: [{ open: "(", close: ")" }, { open: "[", close: "]" }],
  });

  monaco.languages.setTokensProvider(EQUATION_LANGUAGE_ID, {
    getInitialState: () => STATELESS,
    tokenize(line) {
      return { tokens: lineTokens(line, context), endState: STATELESS };
    },
  });

  monaco.languages.registerCompletionItemProvider(EQUATION_LANGUAGE_ID, {
    // The characters that OPEN a new fragment: "." is the property/anchor step
    // ("self." → every numeric leaf), and the operators are where a new name can
    // begin — so the list appears without the author pressing Ctrl+Space.
    triggerCharacters: [".", " ", "+", "-", "*", "/", "(", ","],
    provideCompletionItems(model, position) {
      if (!context) return { suggestions: [] };
      const { lead, expr } = splitEquationMarker(model.getValue());
      // suggestEquation works in EXPRESSION offsets; the buffer offset includes the
      // marker. Clamped at 0 so a caret inside the marker itself asks about the
      // expression's start rather than at a negative index.
      const cursor = Math.max(0, model.getOffsetAt(position) - lead.length);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: word.startColumn, endColumn: word.endColumn,
      };
      const suggestions = suggestEquation(
        expr, cursor, context.state, context.registry, context.selfId, context.scriptExports
      ).map((c) => ({
        label: c.text,
        // The KIND is the same distinction EquationSuggest.svelte renders an icon
        // for, carried onto Monaco's icon set so the two surfaces read alike.
        kind: completionKind(monaco, c.kind),
        detail: c.kind,
        insertText: c.text,
        range,
      }));
      return { suggestions };
    },
  });
}
