/**
 * Font registry tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/fonts_test.js
 *
 * Covers Round 26 (#26):
 *   1. The committed registry (render_gpu/fonts.js) — the Round 26 batch is
 *      SELECTABLE, every committed TTF exists on disk, and pure resolvers behave.
 *   2. GLYPH COVERAGE (no ☐ tofu) — every committed family AND a simulated
 *      UPLOADED font-asset render real (nonzero) glyph ids for basic Latin via
 *      CanvasKit's Typeface (the same engine the on-screen Skia renderer uses).
 *   3. The DYNAMIC font-asset seam — registerFontFamily makes an uploaded font a
 *      selectable family that resolves through the SAME pure functions, then
 *      clearDynamicFonts drops it (project-switch reset).
 *
 * CanvasKit is loaded exactly like render_gpu/skia/node_render.js (createRequire
 * for the CJS wasm module from an ESM file), so this asserts against the real
 * text engine, not a mock.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  FONTS, DEFAULT_FONT, fontOptions, committedFaces, cssFamilyFor, fontFileFor,
  fontFamilyChain, fontDescriptor, hasEmbeddableFile,
  registerFontFamily, clearDynamicFonts, dynamicFontFaces, fontAssetId, fontAssetCssFamily,
} from "../render_gpu/fonts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.join(HERE, "..", "fonts");
const require = createRequire(import.meta.url);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The Round 26 batch — the families this task bundled + registered as selectable.
const NEW_FAMILIES = ["roboto", "poppins", "montserrat", "oswald", "merriweather", "playfair-display"];

// ── 1. Pure committed registry ───────────────────────────────────────────────
test("Round 26 families are all SELECTABLE (in fontOptions)", () => {
  const values = new Set(fontOptions().map((o) => o.value));
  for (const id of NEW_FAMILIES) assert.ok(values.has(id), `fontOptions missing "${id}"`);
});

test("committedFaces has both weights of every committed family + each file exists", () => {
  const faces = committedFaces();
  const withFiles = Object.keys(FONTS).filter((id) => FONTS[id].files.regular);
  assert.equal(faces.length, withFiles.length * 2, `expected ${withFiles.length}*2 faces, got ${faces.length}`);
  for (const f of faces) {
    assert.ok(fs.existsSync(path.join(FONTS_DIR, f.file)), `committed font file missing on disk: ${f.file}`);
  }
});

test("pure resolvers for a new family (roboto)", () => {
  assert.equal(cssFamilyFor("roboto"), '"PowerRP Roboto", sans-serif');
  assert.equal(fontFileFor("roboto", false), "Roboto-Regular.ttf");
  assert.equal(fontFileFor("roboto", true), "Roboto-Bold.ttf");
  assert.ok(hasEmbeddableFile("roboto"));
  // primary family leads, emoji catch-all is always last (fallback chain present → no tofu)
  assert.equal(fontFamilyChain("roboto")[0], "PowerRP Roboto");
  assert.equal(fontFamilyChain("roboto").at(-1), "Noto Color Emoji");
});

test("system + unknown ids still degrade to the OS stack / Inter stand-in (unchanged)", () => {
  assert.equal(cssFamilyFor("system"), "system-ui, sans-serif");
  assert.equal(fontFamilyChain("system")[0], "PowerRP Inter");
  assert.equal(fontDescriptor("no-such-font-xyz").title, FONTS[DEFAULT_FONT].title);
});

// ── 2. Real glyph coverage (no ☐ tofu) via CanvasKit ─────────────────────────
// A missing glyph resolves to glyph id 0 (.notdef → the ☐ tofu box). So "every
// codepoint of ASCII sample text maps to a NONZERO glyph id" is a direct,
// engine-level assertion that the bundled face actually covers basic Latin.
const SAMPLE = "The quick brown fox 0123";

async function loadCanvasKit() {
  const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
  const BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
  return CanvasKitInit({ locateFile: (f) => path.join(BIN, f) });
}

function assertGlyphCoverage(CanvasKit, file) {
  const buf = fs.readFileSync(path.join(FONTS_DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const tf = CanvasKit.Typeface.MakeFreeTypeFaceFromData(ab);
  assert.ok(tf, `CanvasKit could not parse ${file} (corrupt/unsupported TTF?)`);
  const ids = Array.from(tf.getGlyphIDs(SAMPLE));
  assert.ok(ids.length > 0, `no glyph ids for ${file}`);
  const tofu = ids.filter((g) => g === 0).length;
  assert.equal(tofu, 0, `${file}: ${tofu}/${ids.length} chars of "${SAMPLE}" are ☐ tofu (glyph id 0)`);
}

async function main() {
  const CanvasKit = await loadCanvasKit();

  test("every NEW committed family renders real Latin glyphs (no tofu)", () => {
    for (const id of NEW_FAMILIES) {
      assertGlyphCoverage(CanvasKit, fontFileFor(id, false));
      assertGlyphCoverage(CanvasKit, fontFileFor(id, true));
    }
  });

  // ── 3. Dynamic (uploaded) font-asset seam ──────────────────────────────────
  test("registerFontFamily makes an uploaded font a selectable, resolvable family", () => {
    const id = fontAssetId("Uploaded.ttf");
    const desc = registerFontFamily(id, { filename: "Uploaded.ttf", url: "/asset/P/Uploaded.ttf", kind: "serif", title: "Uploaded" });
    assert.equal(desc.cssFamily, fontAssetCssFamily("Uploaded.ttf"));
    assert.equal(cssFamilyFor(id), '"PowerRP Font Uploaded.ttf", serif');
    assert.equal(fontFamilyChain(id)[0], "PowerRP Font Uploaded.ttf");
    assert.equal(fontFamilyChain(id).at(-1), "Noto Color Emoji"); // fallback chain present → no tofu
    assert.ok(fontOptions().some((o) => o.value === id), "uploaded font not offered in the dropdown");
    assert.deepEqual(dynamicFontFaces().find((f) => f.id === id), { id, cssFamily: fontAssetCssFamily("Uploaded.ttf"), url: "/asset/P/Uploaded.ttf" });
    // Not embeddable via the committed fonts/ glob (bytes live in the project) — PDF/SVG treat like system.
    assert.equal(hasEmbeddableFile(id), false);
  });

  test("an uploaded font's ACTUAL bytes render real glyphs in CanvasKit (no tofu)", () => {
    // Simulate an upload with a real font file (any committed TTF stands in for
    // uploaded bytes): registered as dynamic, its bytes must cover Latin.
    assertGlyphCoverage(CanvasKit, "Poppins-Regular.ttf");
  });

  test("clearDynamicFonts drops every uploaded family (project-switch reset)", () => {
    clearDynamicFonts();
    assert.equal(dynamicFontFaces().length, 0);
    assert.ok(!fontOptions().some((o) => o.value.startsWith("font-asset:")));
  });

  console.log(`\n${passed} font tests passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
