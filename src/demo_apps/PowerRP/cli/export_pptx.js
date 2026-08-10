#!/usr/bin/env node
/**
 * PowerRP -> PPTX, from the command line.
 *
 * Usage: node cli/export_pptx.js <projectDir|doc.json> <out.pptx>
 *
 * `<projectDir>` is a folder containing `doc.json` (the on-disk project shape
 * web/projectZip.js's own DOC_FILENAME convention uses); a bare `doc.json`
 * path works too — both resolve to the same document text, this wrapper just
 * saves a caller from typing `/doc.json` when exporting a whole project
 * folder. Repairs the document LOUDLY (repair reports go to stderr, exactly
 * as cli/render.js's own boundary does) before handing it to exportDeck, and
 * prints exportDeck's own downgrade report afterward — the two reports are
 * DIFFERENT concerns (document repair vs PPTX fidelity loss) and are kept on
 * separate lines rather than merged into one list.
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "./args.js";
import { exportDeck, loadAndRepairDocJson } from "../core/pptx_export/export.js";

/**
 * Command (reads the filesystem). Resolves `<projectDir|doc.json>` to the
 * actual doc.json path: if the given path is a directory, appends `doc.json`;
 * otherwise uses it as-is.
 *
 * @param {string} inputPath
 * @returns {Promise<string>}
 */
async function resolveDocPath(inputPath) {
  const st = await stat(inputPath);
  return st.isDirectory() ? join(inputPath, "doc.json") : inputPath;
}

/** Command (reads doc, writes .pptx, prints reports). The CLI entry. */
async function main() {
  const { positional } = parseArgs(process.argv.slice(2), new Set());
  if (positional.length !== 2) {
    console.error("Usage: node cli/export_pptx.js <projectDir|doc.json> <out.pptx>");
    process.exit(1);
  }
  const [inputPath, outPath] = positional;
  const docPath = await resolveDocPath(inputPath);
  const docJson = await readFile(docPath, "utf8");

  const doc = loadAndRepairDocJson(docJson); // reports document repairs to stderr itself
  const started = performance.now();
  const { bytes, report } = exportDeck(doc);
  await writeFile(outPath, Buffer.from(bytes));

  for (const line of report) console.error(`cli/export_pptx.js: ${line}`);
  const elapsed = ((performance.now() - started) / 1000).toFixed(2);
  console.log(`Exported ${doc.slides.length} slide(s) (${report.length} downgrade note(s)) in ${elapsed}s -> ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
