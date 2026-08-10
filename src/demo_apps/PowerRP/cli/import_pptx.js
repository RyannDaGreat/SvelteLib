#!/usr/bin/env node
/**
 * IMPORT PPTX — the CLI half of the 2-stage PowerPoint importer: reads a
 * `.pptx` file, parses it (core/pptx/deck.js, stage 1), translates it
 * (core/pptx_translate/translate.js, stage 2), and writes a PowerRP project
 * folder (`<outDir>/doc.json` + `<outDir>/assets/*`) — printing the report
 * loudly per the task spec ("prints the report").
 *
 * Usage:
 *   node cli/import_pptx.js <in.pptx> <outDir> [--name X] [--slides 1-5,8]
 *
 * `--slides` is 1-BASED (matching how a user reads a slide deck — "slides 1
 * through 5, and 8"), converted to the 0-based `slideIndices` translateDeck
 * expects. Omitted = every slide, per the task's default.
 *
 * The written doc is verified to pass core/document.js's repair pipeline
 * with ZERO repair reports before being written — a translator bug that
 * would need a silent repair on load is refused here instead (loud, not a
 * project that opens "fixed" with no explanation).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parsePptx } from "../core/pptx/deck.js";
import { installPresetDefs } from "../core/pptx/preset_geometry.js";
import { translateDeck } from "../core/pptx_translate/translate.js";
import { repairedDocument, serialize } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { parseArgs } from "./args.js";

/**
 * Pure function. `"1-5,8"` (1-based, inclusive ranges, comma-separated) ->
 * `[0,1,2,3,4,7]` (0-based, deduped, sorted) — the CLI's `--slides` grammar.
 *
 * @param {string} spec
 * @returns {number[]}
 *
 * @example parseSlidesFlag("1-5,8") // [0, 1, 2, 3, 4, 7]
 * @example parseSlidesFlag("3") // [2]
 */
export function parseSlidesFlag(spec) {
  const out = new Set();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = /^(\d+)-(\d+)$/.exec(trimmed);
    if (range) {
      const [, a, b] = range;
      for (let i = Number(a); i <= Number(b); i++) out.add(i - 1);
    } else {
      out.add(Number(trimmed) - 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Pure function. The default project name from a `.pptx` path's basename
 * (extension stripped) — used when `--name` is omitted.
 *
 * @param {string} pptxPath
 * @returns {string}
 *
 * @example defaultProjectName("/a/b/EditGen Explanation.pptx") // "EditGen Explanation"
 */
export function defaultProjectName(pptxPath) {
  const base = basename(pptxPath);
  return base.slice(0, base.length - extname(base).length);
}

/**
 * Command (reads/writes the filesystem, prints to console). The CLI's own
 * body, factored out of the `import.meta.main` guard below so a test can
 * call it directly without spawning a subprocess.
 *
 * @param {string[]} argv - process.argv.slice(2)
 */
export async function main(argv) {
  const { positional, flags } = parseArgs(argv, new Set(["name", "slides"]));
  const [inPath, outDir] = positional;
  if (!inPath || !outDir) {
    console.error("Usage: node cli/import_pptx.js <in.pptx> <outDir> [--name X] [--slides 1-5,8]");
    process.exitCode = 1;
    return;
  }

  const bytes = new Uint8Array(await readFile(inPath));
  console.log(`Parsing ${inPath} (${(bytes.length / 1e6).toFixed(1)} MB)...`);
  const t0 = Date.now();
  const deckIR = parsePptx(bytes);
  console.log(`Parsed in ${Date.now() - t0} ms — ${deckIR.slides.length} slides, ${deckIR.mediaParts.length} media parts, fonts: ${deckIR.fontsUsed.join(", ") || "(none)"}`);
  if (deckIR.refusals.length) {
    console.log(`\n── Parser refusals (${deckIR.refusals.length}) ──`);
    for (const r of deckIR.refusals) console.log(`  [${r.where}] ${r.what}: ${r.sentence}`);
  }

  const defsPath = new URL("../core/pptx/preset_shape_defs.json", import.meta.url);
  installPresetDefs(JSON.parse(await readFile(defsPath, "utf8")).shapes);

  const name = flags.name ?? defaultProjectName(inPath);
  const slideIndices = flags.slides !== undefined ? parseSlidesFlag(flags.slides) : undefined;

  const t1 = Date.now();
  const { doc, assets, report } = translateDeck(deckIR, { name, slideIndices });
  console.log(`\nTranslated in ${Date.now() - t1} ms — ${doc.slides.length} PowerRP slides, ${assets.length} assets`);

  printReport(report);

  const registry = createRegistry();
  registerAll(registry, createCommands());
  const { reports: repairReports } = repairedDocument(doc, registry);
  if (repairReports.length) {
    console.error(`\n── REFUSING TO WRITE: the translated document needs ${repairReports.length} repair(s) on load — this is a translator bug, not an import-time issue to silently fix ──`);
    for (const r of repairReports) console.error(`  ${r}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nRepair check: 0 reports (clean).");

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "doc.json"), serialize(doc));
  if (assets.length) await mkdir(join(outDir, "assets"), { recursive: true });
  for (const asset of assets) await writeFile(join(outDir, "assets", asset.name), asset.bytes);
  console.log(`\nWrote ${join(outDir, "doc.json")} + ${assets.length} asset(s) to ${join(outDir, "assets")}`);
}

/**
 * Command (prints to console). THE progress/report printer — every mapping,
 * substitution, refusal, ambiguity, LOUD per the task spec ("prints the
 * report loudly").
 *
 * @param {{refusals:string[], fontSubstitutions:object[], ambiguities:string[]}} report
 */
export function printReport(report) {
  if (report.fontSubstitutions.length) {
    console.log(`\n── Font substitutions (${report.fontSubstitutions.length}) ──`);
    const seen = new Set();
    for (const s of report.fontSubstitutions) {
      const key = `${s.wanted}->${s.used}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  "${s.wanted}" -> "${s.used}"`);
    }
  }
  if (report.ambiguities.length) {
    console.log(`\n── Morph-match ambiguities (${report.ambiguities.length}) ──`);
    for (const a of report.ambiguities) console.log(`  ${a}`);
  }
  if (report.refusals.length) {
    console.log(`\n── Refusals / fidelity gaps (${report.refusals.length}) ──`);
    for (const r of report.refusals) console.log(`  ${r}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
