/**
 * CODE THEMES — the code block's syntax-colour palettes, VENDORED from the real
 * published VS Code themes (user ask, R7-41: *"Usually editors have color themes,
 * right? Why don't we choose all the popular ones from VS Code and put that in
 * there?"*).
 *
 * ── WHY A MODULE AND NOT A LITERAL IN THE PLUGIN ──────────────────────────────
 * The two legacy palettes lived in plugins/codeblock.js. A fifteen-row table with
 * a provenance record per row is not plugin business, and `core/` is the DOM-free
 * pure-JS layer every renderer already shares (the GPU painter, the PDF/SVG
 * exporters and the bare-node CLI all reach a palette through the plugin's
 * emit()). So the table moves here and the plugin keeps ONE seam: `codeTheme(id)`.
 *
 * ── THE PALETTES ARE MEASURED, NOT INVENTED ───────────────────────────────────
 * Every hex below was read out of the theme's own published JSON — never eyeballed
 * from a screenshot and never approximated. Each entry carries a PROVENANCE line:
 * upstream repo, licence, the exact file, and the commit or released version the
 * bytes came from. This follows the house vendored-defs pattern
 * (render_gpu/skia/blue_noise_512.js), and for the same reason: a palette that
 * claims to be Dracula and is not is a lie nothing in the render path can catch —
 * the picture looks fine, it is simply not the theme it says it is. The blue-noise
 * incident is the standing precedent for exactly that failure.
 *
 * ALL FOURTEEN VENDORED THEMES ARE MIT. Their notices are reproduced in
 * THEME_LICENSES below, which is the MIT attribution obligation discharged in
 * code rather than in a README nobody ships.
 *
 * ── MATERIAL THEME IS DELIBERATELY ABSENT ─────────────────────────────────────
 * It was on the requested roster and it is NOT here. `material-theme/vsc-material-theme`
 * now redirects to `vira-soft/vira-assets`, whose single branch holds a README
 * rebranding it as the commercial "Vira Theme": the theme JSON and the palette
 * source are GONE from the history, and there is NO licence file of any name
 * (GitHub's licence API reports null). With the source withdrawn and no grant of
 * rights, default copyright applies, so its colours are not ours to vendor.
 * Fabricating a "material-ish" palette under that name would be the invented-
 * palette failure this module exists to prevent — a theme is a specific set of
 * numbers by a specific author, not a vibe. If a Material look is wanted, vendor a
 * permissively-licensed successor and name it honestly.
 *
 * ── MAPPING A THEME ONTO OUR EIGHT TOKEN CLASSES ──────────────────────────────
 * A VS Code theme colours TextMate SCOPES — hundreds of them, hierarchical. Our
 * highlighter (core/codeHighlight.js) emits EIGHT flat kinds. So a theme is
 * projected onto our classes, and the projection is stated per row rather than
 * assumed:
 *   keyword  <- keyword.control, else keyword, else storage.type
 *   string   <- string (string.quoted where only the qualified scope exists)
 *   comment  <- comment
 *   number   <- constant.numeric, else the broader constant
 *   function <- entity.name.function, else support.function
 *   property <- variable.other.property / support.type.property-name /
 *               entity.name.tag — whichever the theme actually distinguishes
 *   punct    <- a bare `punctuation` rule where the theme HAS one (rare — Nord
 *               is the only one of the fifteen), otherwise editor.foreground
 *   plain    <- editor.foreground (the theme's base ink)
 *   bg       <- editor.background
 *   gutter   <- editorLineNumber.foreground
 * A DEEP scope was never substituted for a missing shallow one: e.g.
 * `punctuation.definition.comment` is the colour of a comment's `//` marker, not
 * of general punctuation, and taking it would have painted GitHub's braces
 * comment-grey. Where a theme genuinely does not define one of our classes, the
 * fallback is its OWN editor default (never another theme's colour), and the row
 * says so in a comment. Derivations of that kind are noted inline with `<-`.
 *
 * PUBLISHED ALPHA IS COMPOSITED, NOT CARRIED. Three themes publish an 8-digit
 * line-number colour (GitHub Light #1b1f234d, Ayu #5a6378a6, SynthWave #ffffff73).
 * A gutter draw here takes an opaque colour, so each was composited over that
 * theme's own background and the result recorded, with the source value in the
 * comment. Compositing over the theme's own bg is what the editor shows.
 *
 * ── THE TWO LEGACY IDS ARE FROZEN ─────────────────────────────────────────────
 * `dark` and `light` keep their EXACT pre-existing hexes, byte for byte. They are
 * NOT One Dark Pro and One Light even though they were derived from that family
 * years ago and share several values — the real One Dark Pro backdrop is #282c34
 * against legacy dark's #1e222a. Every deck ever saved stores one of these two ids,
 * and a render_gpu PDF parity scene pins `theme: "dark"` against a committed
 * reference PDF, so changing either would silently restyle existing documents and
 * break parity. They stay first in the table, and tests/code_themes_test.js pins
 * their values literally.
 *
 * ── A THEME'S BACKGROUND ONLY SHOWS IF THE BOX LETS IT ────────────────────────
 * A code block is a BOX with its own `fill`, and emit() reads `s.fill ?? palette.bg`.
 * Because the widget's DEFAULT fill is a concrete dark hex, a stored fill wins and
 * `bg` is never consulted on an existing block — switching a block to Solarized
 * Light recolours the TOKENS and leaves the box dark, which is unreadable. `bg` is
 * therefore not decoration: it is what a caller writes INTO `fill` when applying a
 * theme wholesale (`codeThemeProps`), the same way a preset writes theme+fill
 * together. Kept as a first-class field precisely so that a caller has a correct
 * background to write and does not have to invent one.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

/**
 * MIT copyright notices for the vendored palettes, by theme id. Reproducing the
 * notice is the licence's actual requirement, so it ships in the bundle with the
 * colours rather than in a file that could drift away from them.
 */
export const THEME_LICENSES = {
  oneDarkPro: "One Dark Pro — Copyright (c) 2016 binaryify. MIT.",
  dracula: "Dracula — Copyright (c) 2016 Dracula Theme. MIT.",
  monokai: "Monokai (VS Code built-in) — Copyright (c) Microsoft Corporation. MIT.",
  solarizedDark: "Solarized Dark (VS Code built-in) — Copyright (c) Microsoft Corporation; palette (c) 2011 Ethan Schoonover. MIT.",
  solarizedLight: "Solarized Light (VS Code built-in) — Copyright (c) Microsoft Corporation; palette (c) 2011 Ethan Schoonover. MIT.",
  githubDark: "GitHub Dark — Copyright (c) 2018 GitHub Inc. MIT.",
  githubLight: "GitHub Light — Copyright (c) 2018 GitHub Inc. MIT.",
  nord: "Nord — Copyright (c) 2016-present Sven Greb. MIT.",
  gruvboxDark: "Gruvbox Dark — Copyright (c) 2017 Dinh Duy Ky; palette (c) 2012 Pavel Pertsev. MIT.",
  tokyoNight: "Tokyo Night — Copyright (c) 2020 Enkia. MIT.",
  nightOwl: "Night Owl — Copyright (c) 2018 Sarah Drasner. MIT.",
  catppuccinMocha: "Catppuccin Mocha — Copyright (c) 2021-present Catppuccin. MIT.",
  ayuDark: "Ayu Dark — Copyright (c) 2016 Ike Kurghinyan. MIT.",
  synthwave84: "SynthWave '84 — Copyright (c) 2019 Robb Owen. MIT.",
};

/**
 * THE PALETTE TABLE. Keys are the stored `theme` property values (document state
 * — never rename one), values are {bg, gutter, plain, keyword, string, comment,
 * number, function, property, punct}. The two legacy ids come first and are
 * frozen; the vendored roster follows, dark themes then light.
 */
export const CODE_PALETTES = {
  // ── LEGACY (FROZEN — see the header). The app's original two palettes, kept
  // byte-identical so every saved deck and the PDF parity fixture render as they
  // always have. Do not "correct" these toward upstream One Dark/One Light.
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

  // ── VENDORED: DARK ──────────────────────────────────────────────────────────
  // PROVENANCE: github.com/Binaryify/OneDark-Pro, themes/OneDark-Pro.json @98a63df. MIT.
  oneDarkPro: {
    bg: "#282c34", gutter: "#495162",
    plain: "#abb2bf", keyword: "#c678dd", string: "#98c379", comment: "#7f848e",
    number: "#d19a66", function: "#61afef",
    // One Dark Pro's `support.type.property-name` is #abb2bf — identical to plain,
    // i.e. it does not distinguish properties there. Using its DISTINCT property
    // colour instead (meta.object-literal.key / entity.name.tag), which is the
    // red a One Dark user actually sees on an object key.
    property: "#e06c75",
    punct: "#abb2bf", // <- editor.foreground (no bare `punctuation` rule)
  },
  // PROVENANCE: github.com/dracula/visual-studio-code, theme/dracula.json, released
  // v2.25.1 .vsix. MIT. (The JSON is a BUILD ARTIFACT generated from src/dracula.yml
  // and is not committed to git, so this cites the published version, not a SHA.)
  dracula: {
    bg: "#282a36", gutter: "#6272a4",
    plain: "#f8f8f2", keyword: "#ff79c6", string: "#f1fa8c", comment: "#6272a4",
    number: "#bd93f9", // <- `constant` (Dracula defines no bare constant.numeric)
    function: "#50fa7b",
    property: "#ff79c6", // <- entity.name.tag
    punct: "#f8f8f2", // <- editor.foreground (no bare `punctuation` rule)
  },
  // PROVENANCE: github.com/microsoft/vscode, extensions/theme-monokai/themes/
  // monokai-color-theme.json @e85b5d1. MIT.
  monokai: {
    bg: "#272822", gutter: "#90908a",
    plain: "#f8f8f2", keyword: "#f92672", string: "#e6db74", comment: "#88846f",
    number: "#ae81ff", function: "#a6e22e",
    property: "#f92672", // <- entity.name.tag
    punct: "#f8f8f2", // <- editor.foreground (no bare `punctuation` rule)
  },
  // PROVENANCE: github.com/microsoft/vscode, extensions/theme-solarized-dark/themes/
  // solarized-dark-color-theme.json @8b5471c. MIT. Palette by Ethan Schoonover.
  solarizedDark: {
    bg: "#002b36",
    // Solarized's editorLineNumber.foreground is present but an EMPTY STRING —
    // deliberately blank so VS Code applies its own default. Using the theme's own
    // editorLineNumber.activeForeground (#949494) would be brighter than its body
    // text; base01 #586e75 is Solarized's documented "comment / secondary content"
    // tone and is what the gutter reads as in the real editor.
    gutter: "#586e75",
    plain: "#839496", keyword: "#859900", string: "#2aa198", comment: "#586e75",
    number: "#d33682", function: "#268bd2",
    property: "#268bd2", // <- entity.name.tag
    punct: "#839496", // <- editor.foreground (no bare `punctuation` rule)
  },
  // PROVENANCE: github.com/nordtheme/visual-studio-code, themes/nord-color-theme.json
  // @2704585 (branch `develop`). MIT.
  nord: {
    bg: "#2e3440", gutter: "#4c566a",
    plain: "#d8dee9", keyword: "#81a1c1", string: "#a3be8c", comment: "#616e88",
    number: "#b48ead", function: "#88c0d0",
    property: "#81a1c1",
    punct: "#eceff4", // the ONLY theme here with a real bare `punctuation` rule
  },
  // PROVENANCE: github.com/primer/github-vscode-theme, themes/dark.json, released
  // v6.3.5 .vsix. MIT. (Generated from src/*.js; not committed, hence the version.)
  githubDark: {
    bg: "#24292e", gutter: "#444d56",
    plain: "#e1e4e8", keyword: "#f97583", string: "#9ecbff", comment: "#6a737d",
    number: "#79b8ff",
    // The theme defines no entity.name.function; this is its broad `entity,
    // entity.name` rule, which is what colours a function name via TextMate
    // parent-scope inheritance.
    function: "#b392f0",
    property: "#85e89d", // <- entity.name.tag
    punct: "#e1e4e8", // <- editor.foreground (no bare `punctuation` rule)
  },
  // PROVENANCE: github.com/jdinhify/vscode-theme-gruvbox, src/token-colors/base.ts +
  // src/colors/base.ts @ca3b8ad2 (Dark Medium, the first-listed variant). MIT.
  // Palette by Pavel Pertsev (morhetz/gruvbox), against which these cross-check.
  gruvboxDark: {
    bg: "#282828", gutter: "#665c54",
    plain: "#ebdbb2", keyword: "#fb4934", string: "#b8bb26", comment: "#928374",
    number: "#d3869b", // <- `constant` (Gruvbox defines no constant.numeric at all)
    function: "#fabd2f",
    property: "#689d6a", // <- support.type.property-name
    punct: "#a89984", // <- fg4, the theme's punctuation/secondary ink
  },
  // PROVENANCE: github.com/enkia/tokyo-night-vscode-theme,
  // themes/tokyo-night-color-theme.json @7c0f11ea. MIT.
  tokyoNight: {
    bg: "#1a1b26", gutter: "#363b54",
    plain: "#a9b1d6", keyword: "#bb9af7", string: "#9ece6a", comment: "#51597d",
    number: "#ff9e64", function: "#7aa2f7", property: "#7dcfff", punct: "#89ddff",
  },
  // PROVENANCE: github.com/sdras/night-owl-vscode-theme,
  // themes/Night Owl-color-theme.json @cc291eba. MIT.
  nightOwl: {
    bg: "#011627", gutter: "#4b6479",
    plain: "#d6deeb", keyword: "#7fdbca", string: "#ecc48d", comment: "#637777",
    number: "#f78c6c", function: "#c792ea", property: "#baebe2",
    // Night Owl's `punctuation` entry carries no foreground; its `meta.brace`
    // independently resolves to the same #d6deeb as editor.foreground.
    punct: "#d6deeb",
  },
  // PROVENANCE: github.com/catppuccin/vscode, themes/mocha.json from the released
  // catppuccin-vsc-3.19.0 .vsix (the built artifact; the repo generates it). MIT.
  catppuccinMocha: {
    bg: "#1e1e2e", gutter: "#7f849c",
    plain: "#cdd6f4", keyword: "#cba6f7", string: "#a6e3a1", comment: "#9399b2",
    number: "#fab387", function: "#89b4fa",
    // variable.other.property resolves to plain #cdd6f4; this is the theme's
    // distinct entity.name.tag / support.type.property-name blue.
    property: "#89b4fa",
    punct: "#9399b2", // <- the theme's overlay/punctuation tone
  },
  // PROVENANCE: github.com/ayu-theme/vscode-ayu, ayu-dark.json @444ef929 (the file
  // is at the REPO ROOT at that commit; `themes/ayu-dark-color-theme.json`, which
  // this line used to cite, is a 404 there — verified by fetching both). MIT.
  ayuDark: {
    bg: "#10141c",
    gutter: "#404758", // <- published #5a6378a6, composited over this theme's bg
    plain: "#bfbdb6", keyword: "#ff8f40", string: "#aad94c", comment: "#5a6673",
    number: "#d2a6ff", function: "#ffb454", property: "#39bae6",
    punct: "#bfbdb6", // <- punctuation.section, equal to editor.foreground
  },
  // PROVENANCE: github.com/robb0wen/synthwave-vscode,
  // themes/synthwave-color-theme.json @ecfa2fe1. MIT.
  // (Note the org is lowercase `robb0wen`; the capitalised form 404s.)
  synthwave84: {
    bg: "#262335",
    gutter: "#888690", // <- published #ffffff73, composited over this theme's bg
    // SynthWave publishes no editor.foreground; #ffffff is its top-level
    // colors.foreground, which is the ink its code surface actually shows.
    plain: "#ffffff",
    keyword: "#fede5d", string: "#ff8b39", comment: "#848bbd",
    number: "#f97e72", function: "#36f9f6",
    property: "#ff7edb", // <- variable.other.property (the theme's signature pink)
    // SynthWave has NO bare `punctuation` rule — only seven construct-specific
    // deep ones (definition.string #ff8b39, definition.tag #36f9f6, …), and per
    // this module's rule a deep scope is not a substitute for a missing shallow
    // one: colouring every brace with the STRING-quote colour (or the JSX-tag
    // cyan) would be wrong in most code. Falling back to the theme's own ink.
    punct: "#ffffff",
  },

  // ── VENDORED: LIGHT ─────────────────────────────────────────────────────────
  // PROVENANCE: github.com/microsoft/vscode, extensions/theme-solarized-light/themes/
  // solarized-light-color-theme.json @8b5471c. MIT. Palette by Ethan Schoonover.
  solarizedLight: {
    bg: "#fdf6e3",
    gutter: "#93a1a1", // empty-string case as in Solarized Dark; base1, its secondary ink
    plain: "#657b83", keyword: "#859900", string: "#2aa198", comment: "#93a1a1",
    number: "#d33682", function: "#268bd2",
    property: "#268bd2", // <- entity.name.tag
    punct: "#657b83", // <- editor.foreground (no bare `punctuation` rule)
  },
  // PROVENANCE: github.com/primer/github-vscode-theme, themes/light.json, released
  // v6.3.5 .vsix. MIT. (Generated from src/*.js; not committed, hence the version.)
  githubLight: {
    bg: "#ffffff", // published as the 3-digit "#fff"
    gutter: "#babbbd", // <- published #1b1f234d, composited over this theme's white
    plain: "#24292e", keyword: "#d73a49", string: "#032f62", comment: "#6a737d",
    number: "#005cc5",
    function: "#6f42c1", // <- the broad `entity,entity.name` rule, as in GitHub Dark
    property: "#22863a", // <- entity.name.tag
    punct: "#24292e", // <- editor.foreground (no bare `punctuation` rule)
  },
};

/**
 * Display names for the theme dropdown, by id. Separate from the palette table so
 * a name can be written the way its author writes it — "SynthWave '84", not a
 * title-cased key.
 */
export const CODE_THEME_LABELS = {
  dark: "Dark (classic)",
  light: "Light (classic)",
  oneDarkPro: "One Dark Pro",
  dracula: "Dracula",
  monokai: "Monokai",
  solarizedDark: "Solarized Dark",
  nord: "Nord",
  githubDark: "GitHub Dark",
  gruvboxDark: "Gruvbox Dark",
  tokyoNight: "Tokyo Night",
  nightOwl: "Night Owl",
  catppuccinMocha: "Catppuccin Mocha",
  ayuDark: "Ayu Dark",
  synthwave84: "SynthWave '84",
  solarizedLight: "Solarized Light",
  githubLight: "GitHub Light",
};

/** The theme ids, in table order (dropdown order): the two legacy ids, then the
 *  vendored dark roster, then the vendored light ones. */
export const CODE_THEME_IDS = Object.keys(CODE_PALETTES);

/** The default theme id — the legacy dark palette, unchanged. */
export const DEFAULT_CODE_THEME = "dark";

/**
 * Pure function. The palette for a theme id, falling back to the DEFAULT palette
 * for an unknown or absent id (a document may name a theme this build does not
 * have — it must render readable code, not throw or vanish).
 *
 * Args:
 *   id (string): a CODE_PALETTES key, e.g. "dracula"
 *
 * Returns:
 *   object — {bg, gutter, plain, keyword, string, comment, number, function, property, punct}
 *
 * Examples:
 *     >>> codeTheme("dracula").keyword
 *     '#ff79c6'
 *     >>> codeTheme("mystery") === codeTheme("dark")
 *     true
 */
export function codeTheme(id) {
  return CODE_PALETTES[id] ?? CODE_PALETTES[DEFAULT_CODE_THEME];
}

/**
 * Pure function. The colour hex for a token kind in a palette, falling back to
 * `plain` for any unknown kind (defensive — the highlighter only emits KINDS, but
 * a future kind must degrade to readable text, not vanish).
 *
 * Args:
 *   kind (string): a core/codeHighlight.js KIND, e.g. "keyword"
 *   palette (object): a CODE_PALETTES entry
 *
 * Returns:
 *   string — a "#rrggbb" hex
 *
 * Examples:
 *     >>> kindColor("keyword", codeTheme("dark"))
 *     '#c678dd'
 *     >>> kindColor("mystery", codeTheme("dark"))
 *     '#c8ccd4'
 */
export function kindColor(kind, palette) {
  return palette[kind] ?? palette.plain;
}

/**
 * Pure function. The property patch that applies a theme WHOLESALE — the id plus
 * the background it needs to be readable.
 *
 * A code block is a box with its own `fill`, and a stored fill always wins over
 * the palette's `bg` (see the module header), so writing `theme` alone would
 * recolour the tokens and leave the old background — Solarized Light's ink on a
 * near-black box. Callers that mean "switch this block to Dracula" write this
 * patch, exactly as a preset writes theme and fill together.
 *
 * Args:
 *   id (string): a CODE_PALETTES key
 *
 * Returns:
 *   object — {theme, fill}
 *
 * Examples:
 *     >>> codeThemeProps("dracula")
 *     {theme: 'dracula', fill: '#282a36'}
 *     >>> codeThemeProps("githubLight").fill
 *     '#ffffff'
 */
export function codeThemeProps(id) {
  return { theme: id, fill: codeTheme(id).bg };
}
