# PowerRP fonts (committed, offline)

These `.ttf` files ARE the fonts PowerRP ships with. They are committed into the
repo on purpose (manifest "Text fonts"): the app must work with **no internet**,
so there is no Google Fonts CDN, no `@import` from a font host — the editor loads
these local files via `@font-face`, and the PDF exporter embeds the **same file**
so raster text (WebGPU glyph atlas) and vector text (PDF) share metrics.

The single home that names these files and maps them to CSS families is
`web/fonts.js` (the FONTS registry). Nothing else should hardcode a font path.

## Families (SIL Open Font License 1.1 unless noted — redistribution permitted)

| id             | Title          | Kind  | Regular / Bold files                              | License |
|----------------|----------------|-------|---------------------------------------------------|---------|
| `system`       | System UI      | sans  | *(no file — the OS `system-ui, sans-serif` stack; the back-compat default so old docs are unchanged)* | — |
| `inter`        | Inter          | sans  | `Inter-Regular.ttf` / `Inter-Bold.ttf`            | [OFL-Inter.txt](./OFL-Inter.txt) — Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) |
| `source-serif` | Source Serif   | serif | `SourceSerif4-Regular.ttf` / `SourceSerif4-Bold.ttf` | [OFL-SourceSerif4.txt](./OFL-SourceSerif4.txt) — Copyright 2014 The Source Serif 4 Project Authors (https://github.com/adobe-fonts/source-serif) |
| `lora`         | Lora           | serif | `Lora-Regular.ttf` / `Lora-Bold.ttf`              | [OFL-Lora.txt](./OFL-Lora.txt) — Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), RFN "Lora" |
| `jetbrains-mono` | JetBrains Mono | mono | `JetBrainsMono-Regular.ttf` / `JetBrainsMono-Bold.ttf` | [OFL-JetBrainsMono.txt](./OFL-JetBrainsMono.txt) — Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |

### Round 26 batch — well-known display/body families

Added by the fonts task (#26): a batch of popular families so the dropdown has
real range beyond the four originals. These are **full static instances** (not
charset-subset like the originals — the rebuild recipe below subsets on demand)
pulled from Google Fonts, each with Regular + Bold, so they flow through every
seam automatically (`committedFaces()` → `web/fontLoader.js` + the Skia providers
+ the PDF/SVG embed path).

| id                 | Title            | Kind  | Regular / Bold files                                    | License |
|--------------------|------------------|-------|---------------------------------------------------------|---------|
| `roboto`           | Roboto           | sans  | `Roboto-Regular.ttf` / `Roboto-Bold.ttf`                | [LICENSE-Roboto-Apache.txt](./LICENSE-Roboto-Apache.txt) — **Apache-2.0**, Copyright 2011 Google Inc. |
| `poppins`          | Poppins          | sans  | `Poppins-Regular.ttf` / `Poppins-Bold.ttf`              | [OFL-Poppins.txt](./OFL-Poppins.txt) — Copyright 2020 The Poppins Project Authors (Indian Type Foundry) |
| `montserrat`       | Montserrat       | sans  | `Montserrat-Regular.ttf` / `Montserrat-Bold.ttf`        | [OFL-Montserrat.txt](./OFL-Montserrat.txt) — Copyright The Montserrat Project Authors (Julieta Ulanovsky) |
| `oswald`           | Oswald           | sans  | `Oswald-Regular.ttf` / `Oswald-Bold.ttf`                | [OFL-Oswald.txt](./OFL-Oswald.txt) — Copyright 2016 The Oswald Project Authors |
| `merriweather`     | Merriweather     | serif | `Merriweather-Regular.ttf` / `Merriweather-Bold.ttf`    | [OFL-Merriweather.txt](./OFL-Merriweather.txt) — Copyright 2020 The Merriweather Project Authors, RFN "Merriweather" |
| `playfair-display` | Playfair Display | serif | `PlayfairDisplay-Regular.ttf` / `PlayfairDisplay-Bold.ttf` | [OFL-PlayfairDisplay.txt](./OFL-PlayfairDisplay.txt) — Copyright 2017 The Playfair Display Project Authors, RFN "Playfair Display" |

The OFL/Apache licenses require the license text to travel with the fonts — that
is what the `OFL-*.txt` / `LICENSE-*.txt` files are. Do NOT delete them.

### Font ASSETS (uploaded, per-project — NOT committed here)

Beyond the committed families, a user can **upload a font file** (`.ttf`/`.otf`/
`.woff`/`.woff2`) as a project asset (server kind `font`). It becomes a
SELECTABLE family for that project only — registered at runtime through
`render_gpu/fonts.js`'s dynamic registry (`registerFontFamily`) so it resolves
through the same pure resolvers as the committed families, and loaded from its
served asset URL (never bundled into `fonts/`). See `render_gpu/fonts.js`.

## Fallback faces (Skia text render — NOT user-selectable)

These faces are the per-codepoint FALLBACK chain the Skia (CanvasKit) screen
renderer appends behind every selectable family, so text the primary font lacks
(Greek/Cyrillic beyond Inter, Arabic, and COLOR EMOJI) renders as real glyphs
instead of `☐` tofu. They are registered into the CanvasKit `FontCollection`
(see `render_gpu/skia/browser_canvaskit.js` + `node_render.js`); they do NOT
appear in the font dropdown. Declared in `render_gpu/fonts.js` (`FALLBACK_FACES`).

All Noto fallback faces share one license file, [OFL-Noto.txt](./OFL-Noto.txt)
(SIL OFL 1.1, The Noto Project Authors — that file lists every per-family upstream).

| Family            | Coverage                          | File(s)                                             | Bundle |
|-------------------|-----------------------------------|-----------------------------------------------------|--------|
| Noto Sans         | Latin / Greek / Cyrillic (+ bold) | `NotoSans-Regular.ttf` / `NotoSans-Bold.ttf`        | ~1.6 MB |
| Noto Sans Arabic  | Arabic (HarfBuzz shaping)         | `NotoSansArabic-Regular.ttf`                        | ~0.27 MB |
| Noto Sans Hebrew  | Hebrew                            | `NotoSansHebrew-Regular.ttf`                        | ~0.05 MB |
| Noto Sans Thai    | Thai                              | `NotoSansThai-Regular.ttf`                          | ~0.05 MB |
| Noto Sans Devanagari | Devanagari (Hindi/Sanskrit)    | `NotoSansDevanagari-Regular.ttf`                    | ~0.22 MB |
| Noto Sans Bengali | Bengali                           | `NotoSansBengali-Regular.ttf`                       | ~0.14 MB |
| Noto Sans Tamil   | Tamil                             | `NotoSansTamil-Regular.ttf`                         | ~0.08 MB |
| Noto Sans Telugu  | Telugu                            | `NotoSansTelugu-Regular.ttf`                        | ~0.21 MB |
| Noto Sans Kannada | Kannada                           | `NotoSansKannada-Regular.ttf`                       | ~0.17 MB |
| Noto Sans Malayalam | Malayalam                       | `NotoSansMalayalam-Regular.ttf`                     | ~0.11 MB |
| Noto Sans Gujarati | Gujarati                         | `NotoSansGujarati-Regular.ttf`                      | ~0.18 MB |
| Noto Sans Gurmukhi | Gurmukhi (Punjabi)               | `NotoSansGurmukhi-Regular.ttf`                      | ~0.07 MB |
| Noto Sans Georgian | Georgian                         | `NotoSansGeorgian-Regular.ttf`                      | ~0.07 MB |
| Noto Sans Armenian | Armenian                         | `NotoSansArmenian-Regular.ttf`                      | ~0.05 MB |
| Noto Sans Khmer   | Khmer                             | `NotoSansKhmer-Regular.ttf`                         | ~0.11 MB |
| Noto Sans Sinhala | Sinhala                           | `NotoSansSinhala-Regular.ttf`                       | ~0.25 MB |
| Noto Sans Lao     | Lao                               | `NotoSansLao-Regular.ttf`                           | ~0.05 MB |
| Noto Sans Myanmar | Myanmar (Burmese)                 | `NotoSansMyanmar-Regular.ttf`                       | ~0.19 MB |
| Noto Sans Ethiopic | Ethiopic (Amharic/Tigrinya)      | `NotoSansEthiopic-Regular.ttf`                      | ~0.37 MB |
| Noto Sans JP      | CJK — kana + Han (Japanese)       | `NotoSansJP-Regular.ttf`                            | ~5.8 MB |
| Noto Sans SC      | CJK — Simplified Chinese Han      | `NotoSansSC-Regular.ttf`                            | ~10.6 MB |
| Noto Sans KR      | CJK — Hangul + Han (Korean)       | `NotoSansKR-Regular.ttf`                            | ~6.2 MB |
| Noto Color Emoji  | COLOR emoji (CBDT/CBLC bitmaps)   | `NotoColorEmoji.ttf`                                | ~10.7 MB |

`NotoColorEmoji.ttf` is the **color** build (CBDT/CBLC color-bitmap tables) — NOT
the monochrome `NotoEmoji` outline font. Color glyphs keep their own multi-color
palette and are never tinted by the run's text color (Skia ignores the fill color
for color-glyph fonts). Total bundle cost of the fallback set: **~37 MB** (CJK is
~22.6 MB of that).

Coverage is deliberately BROAD (manifest rule: **bundle size is irrelevant — no
script should render as `☐` tofu**). CJK (Simplified Chinese / Japanese / Korean),
Hebrew, Thai, and the major Indic + Southeast-Asian + Caucasus + Ethiopic scripts
are all committed and registered. The CJK faces (SC/JP/KR) carry the shared Han
ideographs; `FALLBACK_FAMILIES` orders them JP → SC → KR, so an unlabeled run's
shared ideographs take Japanese shapes (every order is tofu-free — this only picks
the regional glyph shape). To add another script: drop its static `NotoSans*.ttf`
into `fonts/`, add a `FALLBACK_FACES` entry + a `FALLBACK_FAMILIES` name, and cite
the upstream in `OFL-Noto.txt`.

These fallback faces feed ONLY the Skia screen render. The SVG/PDF vector
exporters still layout through `core/richtext.js` + the committed selectable
families, so emoji / Arabic / non-Inter Greek-Cyrillic in **vector export** is a
separate documented follow-up (screen-vs-export parity risk).

`system` has no file: it is the OS default stack (`system-ui, sans-serif`) that
the app used before the fonts task. It stays the default `font` value on the
text widget so existing documents render byte-identically (no migration). The
PDF backend falls back to standard-14 Helvetica for `system` (no committed file
to embed) — the one face that legitimately still substitutes on non-Quartz
rasterizers.

## How these were built (rebuild recipe)

Each file is a **static instance** (single weight, no variable axes) **subset**
to a Latin + Latin-1 + common-punctuation charset, so it is small (~40–100 KB per
face; ~560 KB for all 8) yet covers everything the text widget can currently type.
Static per-weight instances (not a variable font) are used so the browser
`@font-face` face and the pdf-lib `embedFont` face are the *same named instance* —
guaranteed metric parity, no synthetic bold.

To rebuild (e.g. to widen the charset for MSDF / rich text, or add a family):

1. Re-fetch the upstream **variable** OFL sources into `.src/` from the Google
   Fonts mirror (`https://github.com/google/fonts/raw/main/ofl/<family>/...`)
   and their `OFL.txt`.
2. Run the instance+subset script (fonttools; committed as
   `../../../../../../scratchpad_agent_19.py` history — the logic: for each family,
   `instantiateVariableFont(font, {wght: 400|700, opsz: default})` then
   `subset.Subsetter` over the charset, then `font.save()`).
3. Re-run the parity suite (`tests/pdf_parity_test.js`) — floors may shift and
   must be re-measured.

Widening the charset later is safe: it only ADDS glyphs; existing text is
unaffected. MSDF (tier 2) will consume the SAME committed files to generate its
per-font atlases at build time (manifest "Text crispness — TIER 2").
