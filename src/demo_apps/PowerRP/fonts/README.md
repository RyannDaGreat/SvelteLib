# PowerRP fonts (committed, offline)

These `.ttf` files ARE the fonts PowerRP ships with. They are committed into the
repo on purpose (manifest "Text fonts"): the app must work with **no internet**,
so there is no Google Fonts CDN, no `@import` from a font host — the editor loads
these local files via `@font-face`, and the PDF exporter embeds the **same file**
so raster text (WebGPU glyph atlas) and vector text (PDF) share metrics.

The single home that names these files and maps them to CSS families is
`web/fonts.js` (the FONTS registry). Nothing else should hardcode a font path.

## Families (all SIL Open Font License 1.1 — redistribution permitted)

| id             | Title          | Kind  | Regular / Bold files                              | License |
|----------------|----------------|-------|---------------------------------------------------|---------|
| `system`       | System UI      | sans  | *(no file — the OS `system-ui, sans-serif` stack; the back-compat default so old docs are unchanged)* | — |
| `inter`        | Inter          | sans  | `Inter-Regular.ttf` / `Inter-Bold.ttf`            | [OFL-Inter.txt](./OFL-Inter.txt) — Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) |
| `source-serif` | Source Serif   | serif | `SourceSerif4-Regular.ttf` / `SourceSerif4-Bold.ttf` | [OFL-SourceSerif4.txt](./OFL-SourceSerif4.txt) — Copyright 2014 The Source Serif 4 Project Authors (https://github.com/adobe-fonts/source-serif) |
| `lora`         | Lora           | serif | `Lora-Regular.ttf` / `Lora-Bold.ttf`              | [OFL-Lora.txt](./OFL-Lora.txt) — Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), RFN "Lora" |
| `jetbrains-mono` | JetBrains Mono | mono | `JetBrainsMono-Regular.ttf` / `JetBrainsMono-Bold.ttf` | [OFL-JetBrainsMono.txt](./OFL-JetBrainsMono.txt) — Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |

The OFL requires the license text to travel with the fonts — that is what the
`OFL-*.txt` files are. Do NOT delete them.

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
