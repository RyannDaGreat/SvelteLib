/**
 * CODE BLOCK widget (manifest Round 12D) — displays syntax-highlighted source
 * code in monospace, optionally with line numbers, INSIDE a stroked box.
 *
 * ── IT IS A BOX ───────────────────────────────────────────────────────────────
 * Per the user's standing box-contract convention, a code block IS a box: it
 * composes the SHARED strokedBox bundle (core/properties.js) so it inherits
 * fill / stroke / strokeWidth / cornerRadius rows + defaults for FREE — rounded
 * corners, borders, and any future stroke aspect (dash/cap/join) reach it with
 * no per-plugin edits, exactly like rect/image/donut. The box is the code's
 * BACKGROUND; the highlighted text paints on top of it.
 *
 * ── LAYOUT (monospace makes it pure + exact) ──────────────────────────────────
 * JetBrains Mono (the committed mono face — render_gpu/fonts.js) advances EVERY
 * glyph by exactly 0.6·em (measured from the committed TTF: 600/1000 units — see
 * MONO_ADVANCE_RATIO). So a column grid is exact with NO atlas/measure
 * dependency: char c on line L sits at x = padLeft + gutterW + c·charW,
 * y = padTop + L·lineH. This keeps emit() a PURE function of state (the render
 * cornerstone) — the browser atlas and the PDF backend both lay the same glyphs
 * on the same grid, so GPU and PDF renders match (parity).
 *
 * ── HIGHLIGHTING ──────────────────────────────────────────────────────────────
 * core/codeHighlight.js (pure, offline, dependency-free — see its header for the
 * vendor-vs-build decision) turns the code into per-line {text, kind} tokens.
 * Each token becomes ONE single-run text IR op colored by kindColor(). One op
 * per token per line is fine: the compositor's text pen and the PDF's Tj both
 * position each op at its own (x, y), and mono's uniform advance means a token
 * starting at column c is exactly at x = ...+ c·charW. Unknown language →
 * one plain token per line (the highlighter's declared fallback; monochrome).
 *
 * ── LONG LINES: CHARACTER-TRUNCATION CLIP (no wrap in v1) ──────────────────────
 * Code does not soft-wrap by default, so v1 does NOT wrap. A line longer than
 * the box's visible column count is TRUNCATED to that many characters (an exact
 * clip because mono columns are exact) rather than pixel-clipped with a
 * cropSubtree — truncation keeps the PDF text real/selectable and needs no
 * offscreen pass. Soft-wrap and true pixel-clip are FLAGGED future options.
 *
 * ── COLORS ────────────────────────────────────────────────────────────────────
 * Token colors come from the theme (app.css --a-code-* palette, chained to the
 * theme's fg/accent tokens). But emit() is DOM-free core-adjacent code and can't
 * read CSS vars, so a code block carries a `theme` string property picking a
 * built-in palette (CODE_PALETTES) whose hex values match the CSS tokens. The
 * default palette is a DARK code palette (readable on ANY app theme — a code
 * block reads as an embedded terminal, the universal convention; the box fill
 * defaults dark to match). The inspector's palette dropdown lets the user pick a
 * light palette for light backgrounds.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect, roundedRectAnchorPoint } from "../core/outline.js";
import { bundle, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { rect, text } from "../render_gpu/ir.js";
import { highlightCode, languageOptions, KINDS } from "../core/codeHighlight.js";

/**
 * JetBrains Mono advance ratio: every glyph advances 0.6·em. MEASURED from the
 * committed TTF (fonts/JetBrainsMono-Regular.ttf + -Bold.ttf: 600/1000 unitsPerEm
 * for all sampled glyphs, regular AND bold) — NOT a guessed constant. This is
 * the mono grid's column width factor: charW = fontSize · MONO_ADVANCE_RATIO.
 */
export const MONO_ADVANCE_RATIO = 0.6;

/**
 * Line height as a multiple of font size. LINKED to core/richtext.js's
 * NATURAL_LINE_HEIGHT (1.2) — the same natural-leading factor the rich-text
 * layout uses, so code lines are spaced like every other text line in the app
 * (one source of truth, not a fresh code-only number).
 */
export const CODE_LINE_HEIGHT = 1.2;

/**
 * Tab width in COLUMNS (spaces a "\t" expands to). 4 is the near-universal
 * default (Python PEP 8, Prettier, most editors) but has no in-repo precedent —
 * FLAGGED PENDING USER RATIFICATION per the no-arbitrary-constants rule.
 */
export const TAB_WIDTH = 4;

/**
 * Built-in code color palettes (hex per token kind). emit() is DOM-free so it
 * cannot read app.css --a-code-* CSS vars; these palettes MIRROR those tokens so
 * the GPU/PDF render matches what the CSS palette would show. `dark` is the
 * default (a dark editor palette, readable over the default dark box fill on any
 * app theme); `light` suits a light box fill. `bg`/`gutter` are the box fill and
 * the line-number color. Colors are a muted, professional set (no neon) — the
 * app's non-garish convention. PENDING USER RATIFICATION (a visual choice).
 */
export const CODE_PALETTES = {
  dark: {
    bg: "#1e222a", gutter: "#5c6370",
    plain: "#c8ccd4", keyword: "#c678dd", string: "#98c379", comment: "#7f848e",
    number: "#d19a66", function: "#61afef", property: "#e5c07b", punct: "#abb2bf",
  },
  light: {
    bg: "#fbfbfa", gutter: "#a0a1a7",
    plain: "#383a42", keyword: "#a626a4", string: "#50a14f", comment: "#a0a1a7",
    number: "#986801", function: "#4078f2", property: "#c18401", punct: "#383a42",
  },
};

/** Pure function. The color hex for a token kind in a palette, falling back to
 * `plain` for any unknown kind (defensive — the highlighter only emits KINDS,
 * but a future kind must degrade to readable text, not vanish).
 *
 * @example kindColor("keyword", CODE_PALETTES.dark) // "#c678dd"
 * @example kindColor("mystery", CODE_PALETTES.dark) // "#c8ccd4" (falls back to plain)
 */
export function kindColor(kind, palette) {
  return palette[kind] ?? palette.plain;
}

/**
 * Pure function. Expands leading + interior tabs in a line to spaces on the mono
 * grid so column math stays exact (a "\t" is not one advance — it snaps to the
 * next TAB_WIDTH multiple). Applied to token TEXT before layout. Returns the
 * de-tabbed string.
 *
 * @example expandTabs("\tx", 4) // "    x"
 * @example expandTabs("ab\tc", 4) // "ab  c"   (tab from col 2 → col 4)
 * @example expandTabs("no tabs", 4) // "no tabs"
 */
export function expandTabs(line, tabWidth) {
  let out = "";
  let col = 0;
  for (const ch of line) {
    if (ch === "\t") {
      const n = tabWidth - (col % tabWidth);
      out += " ".repeat(n); col += n;
    } else { out += ch; col += 1; }
  }
  return out;
}

/**
 * Pure function. The number of gutter columns for `lineCount` line numbers (the
 * widest number's digit count + 1 padding column), or 0 when line numbers are
 * off. Used to offset the code and size the gutter.
 *
 * @example gutterColumns(9, true) // 2   (1 digit + 1 pad)
 * @example gutterColumns(100, true) // 4  (3 digits + 1 pad)
 * @example gutterColumns(50, false) // 0  (line numbers off)
 */
export function gutterColumns(lineCount, lineNumbers) {
  if (!lineNumbers) return 0;
  return String(Math.max(1, lineCount)).length + 1;
}

/**
 * Pure function. Lays a highlighted code value out into positioned text draws on
 * the mono grid — the shared layout BOTH the GPU editor and the PDF backend get
 * (via emit()). Returns background-relative LOCAL coords (top-left origin), so
 * the caller emits a box then these draws on top.
 *
 * Each returned draw is {text, x, y, color, bold}. Line numbers (when enabled)
 * are right-aligned gutter draws in the gutter color. Long lines are TRUNCATED
 * to the visible column count (mono-exact clip; no wrap — see the module header).
 *
 * Args:
 *   lines ({text,kind}[][]): highlighted tokens per line (from highlightCode)
 *   opts ({fontSize, w, padding, lineNumbers, palette, tabWidth}): layout params
 *
 * Returns:
 *   {text, x, y, color, bold}[] — positioned single-run text draws (local space)
 *
 * @example layoutCodeDraws([[{text: "x", kind: "plain"}]], {fontSize: 10, w: 200, padding: 4, lineNumbers: false, palette: CODE_PALETTES.dark, tabWidth: 4})[0].text // "x"
 * @example layoutCodeDraws([[{text: "x", kind: "plain"}]], {fontSize: 10, w: 200, padding: 4, lineNumbers: true, palette: CODE_PALETTES.dark, tabWidth: 4}).some((d) => d.text === "1") // true
 */
export function layoutCodeDraws(lines, opts) {
  const { fontSize, w, padding, lineNumbers, palette, tabWidth } = opts;
  const charW = fontSize * MONO_ADVANCE_RATIO;
  const lineH = fontSize * CODE_LINE_HEIGHT;
  const gutterCols = gutterColumns(lines.length, lineNumbers);
  const gutterW = gutterCols * charW;
  const codeLeft = padding + gutterW;
  // Visible columns for CODE (after gutter + both paddings). Long lines truncate
  // to this many characters (exact mono clip; flagged: no pixel-clip / no wrap).
  const visibleCols = Math.max(0, Math.floor((w - codeLeft - padding) / charW));
  const draws = [];

  lines.forEach((tokens, li) => {
    const y = padding + li * lineH;
    // Line number, right-aligned in the gutter (last gutter col is padding).
    if (lineNumbers && gutterCols > 0) {
      const label = String(li + 1);
      const x = padding + (gutterCols - 1 - label.length) * charW;
      draws.push({ text: label, x, y, color: palette.gutter, bold: false });
    }
    // Walk tokens, tracking the character column; truncate at visibleCols.
    let col = 0;
    for (const tok of tokens) {
      if (col >= visibleCols) break;
      const expanded = expandTabs(tok.text, tabWidth);
      // Clip THIS token so total columns never exceed the visible width.
      const room = visibleCols - col;
      const shown = expanded.length > room ? expanded.slice(0, room) : expanded;
      if (shown.length > 0) {
        draws.push({ text: shown, x: codeLeft + col * charW, y, color: kindColor(tok.kind, palette), bold: false });
      }
      col += expanded.length;
    }
  });
  return draws;
}

export const codeblockPlugin = {
  type: "codeblock",
  title: "Code Block",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK + code button open the reusable full-screen Monaco editor on the
  // `code` (ROUND 2 #33 — a code block is THE "lots of code" widget). The editor
  // language is null (Monaco plaintext): the widget's own `language` picks the
  // CANVAS highlighter, but the modal hosts Monaco's editor CORE (editor.api,
  // deliberately without its ~80-language grammar pack — a bundle decision), so
  // per-language colouring in the modal is a flagged follow-up; it is still a full
  // multi-line editor with minimap/autocomplete, which is the ask.
  activate: "code_modal",
  codeEditor: { property: "code", language: null, title: "Edit Code" },
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js):
  // the positioning bundle + the full strokedBox bundle (fill/stroke/strokeWidth/
  // cornerRadius — a code block IS a box) + opacity. The box is the code's
  // background; fill defaults to the DARK palette bg so a fresh code block reads
  // as an embedded editor on any app theme (see CODE_PALETTES). strokeWidth 1
  // gives a subtle frame; cornerRadius 6 (a code block is deliberately rounded —
  // an editor pane convention, the ONE place rounding is intentional per the
  // box-contract; the user can zero it). fontSize/language/lineNumbers/padding
  // are the code-specific state.
  defaults: {
    type: "codeblock", x: 100, y: 100, w: 360, h: 200, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: CODE_PALETTES.dark.bg, stroke: "#3a3f4b", strokeWidth: 1,
    code: "function greet(name) {\n  return `Hello, ${name}!`;\n}",
    language: "javascript", fontSize: 14, lineNumbers: true, padding: 12, theme: "dark",
    ...defaults("cornerRadius", "opacity"), // filled below with code-specific overrides
    cornerRadius: 6,
  },
  // Rows grouped into the Inspector accordion via each row's `category`. The
  // code content + typography live in the "text" category; the box style in
  // "formatting"; position in "positioning".
  inspector: [
    ...bundle("positioning"),
    // Code content: a multiline STRING. Today it uses the "text" row kind (a
    // single-line field that still round-trips the whole multi-line string) —
    // FLAG: a future dedicated code editor row (a monospace textarea with live
    // highlighting, tying into the rich-text editor wave) supersedes this. The
    // string travels + renders fully regardless of the editor control.
    { key: "code", label: "Code", kind: "text", category: "text", help: "The source code shown in the block. Edit inline here, or open the full-screen code editor with the button below (or by double-clicking the block)." },
    // THE CODE BUTTON (ROUND 2 #33/#35): opens the reusable Monaco editor on the
    // `code` — same `edit-code-source` command + `action` row idiom as mermaid/latex.
    { key: "__editcode", label: "Edit in code editor…", kind: "action", command: "edit-code-source", category: "text", help: "Opens the full-screen editor (multi-line, minimap, autocomplete) on the source code — for entering a lot of code at once." },
    // Language: a select over the highlighter's supported grammars (+ Plain).
    { key: "language", label: "Language", kind: "select", options: languageOptions().map((o) => o.value), optionLabels: Object.fromEntries(languageOptions().map((o) => [o.value, o.label])), category: "text", help: "Which language's syntax colors to apply. Pick Plain text for no highlighting; an unknown language also renders plain." },
    { key: "fontSize", label: "Font size", kind: "number", min: 0, category: "text", help: "Monospace font size for the code, in canvas units. Line height and column width scale with it." },
    { key: "lineNumbers", label: "Line numbers", kind: "boolean", category: "text", help: "Show a dimmed line-number gutter down the left edge." },
    { key: "theme", label: "Code theme", kind: "select", options: Object.keys(CODE_PALETTES), category: "formatting", help: "The syntax color palette. Dark suits a dark box fill (the default); Light suits a light fill." },
    { key: "padding", label: "Padding", kind: "number", min: 0, category: "formatting", help: "Inner space between the box edge and the code, in canvas units." },
    ...bundle("strokedBox"),
    ...props("opacity"),
  ],
  /**
   * Pure function. State → display-list commands (local space, top-left origin).
   * Emits the box (fill + border + rounding) then one colored single-run text op
   * per highlighted token (JetBrains Mono, laid on the mono grid). The text sits
   * ON the box; long lines are character-truncated to the box width (see the
   * module header). Line numbers render in a dimmed gutter when enabled.
   *
   * Bold is NOT used for code tokens (a monospace grid must keep uniform advance;
   * JetBrains Mono Bold shares the 0.6 advance, but v1 keeps all code one weight
   * for a clean grid — a future option could bold keywords).
   */
  emit(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const cornerRadius = s.cornerRadius ?? 0;
    const opacity = s.opacity ?? 1;
    const palette = CODE_PALETTES[s.theme] ?? CODE_PALETTES.dark;
    // The box background (fill + optional border + rounding).
    const box = rect({
      x: 0, y: 0, w, h, cornerRadius,
      fill: s.fill ?? palette.bg,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity,
    });
    const fontSize = s.fontSize ?? 14;
    const lines = highlightCode(s.code ?? "", s.language);
    const draws = layoutCodeDraws(lines, {
      fontSize, w, padding: s.padding ?? 0,
      lineNumbers: s.lineNumbers !== false, palette, tabWidth: TAB_WIDTH,
    });
    const textOps = draws.map((d) =>
      text({ text: d.text, x: d.x, y: d.y, size: fontSize, color: d.color, bold: d.bold, font: "jetbrains-mono", opacity }));
    return [box, ...textOps];
  },
  // Anchors sit on the VISIBLE rounded rim (identical to rect — a code block is a
  // rounded box). r=0 → byte-identical to standardBBoxAnchors.
  anchors(state) {
    const r = state.cornerRadius ?? 0;
    return standardBBoxAnchors(state).map((a) =>
      ({ id: a.id, ...roundedRectAnchorPoint(state.w ?? 0, state.h ?? 0, r, a.id, a.x, a.y) }));
  },
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRoundedRect(state.w ?? 0, state.h ?? 0, state.cornerRadius ?? 0, local.x, local.y);
  },
  commands: [
    // CROSSHAIR PLACEMENT (manifest ARCHITECTURE PLAN #5 — Opus29's generalized
    // descriptor landed: armCrosshairPlacement takes any plugin, CanvasView
    // drives the click-drag-places gesture off type + .defaults).
    { id: "add-codeblock", title: "Add Code Block", icon: "mdi:code-braces-box", run: (app) => app.armCrosshairPlacement(codeblockPlugin) },
  ],
};

// KINDS is imported to keep this file honest against the highlighter's kind set;
// referenced here so a lint/unused check doesn't drop the import and so a future
// exhaustiveness assertion (palette covers every KIND) has the list at hand.
export const CODE_TOKEN_KINDS = KINDS;
