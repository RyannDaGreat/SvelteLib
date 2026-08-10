#!/usr/bin/env node
/**
 * DEV SMOKE — parse AND translate the REAL primary deck
 * (.frenzy/r10/primary.pptx, ~109MB, gitignored) end to end, writing the
 * resulting project to .frenzy/translated_deck1/ (doc.json + assets/) and
 * printing the full report. NOT part of the test gate (tests/run_all.mjs)
 * — this deck cannot be a committed fixture (see tests/pptx_translate_test.js
 * for the committed-fixture gate half).
 *
 * Run: node tests/pptx_dev/translate_real_deck.mjs
 *
 * Deck 1 is 18 authored PPT slides; cross-check the printed "PowerRP slides"
 * count against research_10_deck_inventory.md's morph/click-step census —
 * every morph/click-heavy slide should visibly expand THE MECHANISM's 1+N
 * rule. `pptxPreset` items (a plugin landing in parallel — see this app's
 * task brief) will show up as "unknown type" repair reports until that
 * plugin is registered; this script reports that count explicitly so it
 * reads as an expected pending-plugin state, not a translator failure.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePptx } from "../../core/pptx/deck.js";
import { installPresetDefs } from "../../core/pptx/preset_geometry.js";
import { translateDeck } from "../../core/pptx_translate/translate.js";
import { repairedDocument, serialize } from "../../core/document.js";
import { createRegistry } from "../../core/registry.js";
import { createCommands } from "../../core/commands.js";
import { registerAll } from "../../plugins/index.js";
import { printReport } from "../../cli/import_pptx.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = join(__dirname, "..", "..", ".frenzy", "r10", "primary.pptx");
const OUT_DIR = join(__dirname, "..", "..", ".frenzy", "translated_deck1");

if (!existsSync(DECK_PATH)) {
  console.log(`SKIP — real deck not found at ${DECK_PATH} (it is gitignored dev-only material; this script is not part of the test gate).`);
  process.exit(0);
}

const defsPath = join(__dirname, "..", "..", "core", "pptx", "preset_shape_defs.json");
installPresetDefs(JSON.parse(await readFile(defsPath, "utf8")).shapes);

const bytes = new Uint8Array(await readFile(DECK_PATH));
console.log(`Parsing ${DECK_PATH} (${(bytes.length / 1e6).toFixed(1)} MB)...`);
const t0 = Date.now();
const deckIR = parsePptx(bytes);
console.log(`Parsed in ${Date.now() - t0} ms — ${deckIR.slides.length} PPT slides, ${deckIR.mediaParts.length} media parts, ${deckIR.refusals.length} parser refusals`);

const t1 = Date.now();
const { doc, assets, report } = translateDeck(deckIR, { name: "EditGen Explanation" });
const elapsedMs = Date.now() - t1;
const mediaBytes = assets.reduce((n, a) => n + a.bytes.length, 0);

console.log(`\nTranslated in ${elapsedMs} ms`);
console.log(`── Stats ──`);
console.log(`  PPT slides:        ${deckIR.slides.length}`);
console.log(`  PowerRP slides:    ${doc.slides.length} (expanded via THE MECHANISM's click-step rule)`);
console.log(`  Items created:     ${new Set(doc.slides.flatMap((s) => Object.entries(s.delta.items ?? {}).filter(([, v]) => v && typeof v === "object" && typeof v.type === "string").map(([id]) => id))).size}`);
console.log(`  Assets:            ${assets.length} (${(mediaBytes / 1e6).toFixed(1)} MB)`);
console.log(`  Font substitutions:${new Set(report.fontSubstitutions.map((s) => `${s.wanted}->${s.used}`)).size} distinct`);
console.log(`  Refusals:          ${report.refusals.length}`);
console.log(`  Ambiguities:       ${report.ambiguities.length}`);

printReport(report);

console.log(`\n── Per-slide expansion ──`);
for (const s of doc.slides) console.log(`  "${s.name}" — ${Object.keys(s.delta.items ?? {}).length} item(s), transition ${s.transition.type} ${s.transition.seconds}s`);

const registry = createRegistry();
registerAll(registry, createCommands());
const { reports: repairReports } = repairedDocument(doc, registry);
const pendingPluginReports = repairReports.filter((r) => r.includes('unknown type "pptxPreset"'));
const otherReports = repairReports.filter((r) => !r.includes('unknown type "pptxPreset"'));
console.log(`\n── Repair check ──`);
console.log(`  ${repairReports.length} total repair report(s) on load`);
console.log(`  ${pendingPluginReports.length} are the EXPECTED "pptxPreset plugin pending" case`);
if (otherReports.length) {
  console.log(`  ${otherReports.length} are UNEXPECTED — a real translator bug:`);
  for (const r of otherReports) console.log(`    ${r}`);
} else {
  console.log(`  0 unexpected reports.`);
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "doc.json"), serialize(doc));
if (assets.length) await mkdir(join(OUT_DIR, "assets"), { recursive: true });
for (const asset of assets) await writeFile(join(OUT_DIR, "assets", asset.name), asset.bytes);
console.log(`\nWrote ${join(OUT_DIR, "doc.json")} + ${assets.length} asset(s) to ${join(OUT_DIR, "assets")}`);
