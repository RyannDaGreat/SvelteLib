#!/usr/bin/env node
/**
 * DEV SMOKE — parse the REAL primary deck (.frenzy/r10/primary.pptx, ~109MB,
 * gitignored) and print per-slide one-liners plus every warning/refusal. NOT
 * part of the test gate (tests/run_all.mjs) — this deck cannot be a committed
 * fixture (see tests/pptx_parse_test.js for the committed-fixture gate half).
 *
 * Run: node tests/pptx_dev/parse_real_deck.mjs
 *
 * Cross-check its output against .frenzy/research_10_deck_inventory.md: 18
 * slides, morph on 11-16+18, push on 17, 14 mp4s (33 media parts incl.
 * posters/plain pictures once video/audio+picture references are BOTH
 * counted), etc. The refusals list this script prints is the importer's own
 * feature-gap roadmap — every entry names a real construct this parser did
 * not understand, per deck.js's "parse what you can, report every gap" rule.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePptx } from "../../core/pptx/deck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = join(__dirname, "..", "..", ".frenzy", "r10", "primary.pptx");

if (!existsSync(DECK_PATH)) {
  console.log(`SKIP — real deck not found at ${DECK_PATH} (it is gitignored dev-only material; this script is not part of the test gate).`);
  process.exit(0);
}

const bytes = new Uint8Array(readFileSync(DECK_PATH));
console.log(`Parsing ${DECK_PATH} (${(bytes.length / 1e6).toFixed(1)} MB)...`);

const t0 = Date.now();
const deck = parsePptx(bytes);
const elapsedMs = Date.now() - t0;

console.log(`\nParsed in ${elapsedMs} ms.`);
console.log(`Slide size: ${deck.slideSizeEmu.w} x ${deck.slideSizeEmu.h} EMU (${(deck.slideSizeEmu.w / 914400).toFixed(3)} x ${(deck.slideSizeEmu.h / 914400).toFixed(3)} in)`);
console.log(`Slides: ${deck.slides.length}`);
console.log(`Media parts: ${deck.mediaParts.length}`);
console.log(`Fonts used: ${deck.fontsUsed.join(", ")}`);

console.log(`\n── Per-slide summary ──`);
for (const slide of deck.slides) {
  const countShapes = (list) => list.reduce((n, s) => n + 1 + (s.type === "grpSp" ? countShapes(s.children) : 0), 0);
  const mediaCount = Object.keys(slide.mediaByShapeId).length;
  const transitionStr = slide.transition ? `${slide.transition.type}${slide.transition.morphOption ? `(${slide.transition.morphOption})` : ""} ${slide.transition.durMs}ms` : "none";
  const clickStr = slide.clickSteps.length ? `${slide.clickSteps.length} steps [${slide.clickSteps.map((s) => s.trigger).join(",")}]` : "none";
  console.log(
    `  [${String(slide.index).padStart(2)}] "${slide.name || "(unnamed)"}" — shapes=${countShapes(slide.shapes)} media=${mediaCount} transition=${transitionStr} timing=${clickStr}`,
  );
}

console.log(`\n── Warnings (${deck.warnings.length}) ──`);
for (const w of deck.warnings) console.log(`  ${w}`);

console.log(`\n── Refusals (${deck.refusals.length}) — the importer's feature-gap roadmap ──`);
for (const r of deck.refusals) console.log(`  [${r.where}] ${r.what}: ${r.sentence}`);

console.log(`\nDone.`);
