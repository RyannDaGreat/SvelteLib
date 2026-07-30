/**
 * Append slide 5 "CSV Bar Graph (plugin asset)" to the Imitations project.
 *
 * Builds every item by SPREADING the registered plugin's `defaults` and then
 * overriding only what this slide authors — the plugin-defaults spreading pattern
 * AUTHORING.md documents, and the reason the result passes repairedDocument with
 * zero reports (missing keys are impossible when the defaults are the base).
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// RESOLVED RELATIVE TO THIS FILE, never absolute: this directory is a portable
// dump that may be renamed or moved at any time, so an absolute path here would
// break the script for everyone but its author.
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { createRegistry } = await import(`${ROOT}/core/registry.js`);
const { createCommands } = await import(`${ROOT}/core/commands.js`);
const { registerAll } = await import(`${ROOT}/plugins/index.js`);
const { registerPluginAssets } = await import(`${ROOT}/core/plugin_assets.js`);
const { repairedDocument } = await import(`${ROOT}/core/document.js`);

const PROJECT = "Imitations";
const PROJECT_DIR = `${ROOT}/projects/${PROJECT}`;
const ASSETS = `${PROJECT_DIR}/assets`;

// Seed the plugin + its data file into the project (the seed_into_project.sh job,
// done inline so this script is one command).
mkdirSync(ASSETS, { recursive: true });
for (const file of ["csv_bar_graph.plugin.js", "sample_data.csv"])
  copyFileSync(`${ROOT}/plugin_assets/${file}`, `${ASSETS}/${file}`);

const registry = createRegistry();
registerAll(registry, createCommands());
const { loaded, reports } = registerPluginAssets(registry, [
  { name: "csv_bar_graph.plugin.js", source: readFileSync(`${ASSETS}/csv_bar_graph.plugin.js`, "utf8") },
]);
if (reports.length) throw new Error(`plugin asset refused: ${reports.join("; ")}`);
console.log("registered:", loaded.join(", "));

const doc = JSON.parse(readFileSync(`${PROJECT_DIR}/doc.json`, "utf8"));
const SLIDE_ID = "s5csvbar";
doc.slides = doc.slides.filter((s) => s.id !== SLIDE_ID); // idempotent re-run

const chart = registry.get("csv_bar_graph");
const plaintext = registry.get("plaintext");

// THE CAMERA's id, read from slide 0 rather than hardcoded — its background is
// keyframed dark on this slide so the light chart type reads (slides 1-4 are white
// scans of a paper figure). One property, one slide: exactly what a delta is for.
const cameraId = Object.entries(doc.slides[0].delta.items).find(([, v]) => v.type === "camera")[0];

const items = {
  [cameraId]: { background: "#16161e" },
  // The chart. Only the data binding, the geometry and the palette are authored;
  // everything else comes from the plugin's own defaults.
  csvchart: {
    ...chart.defaults,
    name: "CSV Bar Graph",
    x: 260, y: 300, w: 1400, h: 560, z: 20,
    csvUrl: `/asset/${PROJECT}/sample_data.csv`,
    labelColumn: "stage",
    valueColumn: "seconds",
    colorMode: "alternate",
    barColor: "#58c4dd",
    altColor: "#7aa2f7",
    labelSize: 26,
    axisColor: "#c0caf5",
    valueDecimals: 1,
  },
  // The slide title, positioned in absolute canvas units.
  csvtitle: {
    ...plaintext.defaults,
    name: "CSV Slide Title",
    x: 260, y: 150, w: 1400, h: 70, z: 21,
    text: "Render cost per stage — read from sample_data.csv",
    font: "poppins", size: 44, bold: true, fill: "#ffffff",
    align: "left", valign: "middle",
  },
  // The caption, ANCHOR-BOUND to the chart: its x/w track the chart's, and its y
  // is the chart's bottom anchor plus a gap. Move or resize the chart and the
  // caption follows, with nothing to keep in sync by hand.
  csvcap: {
    ...plaintext.defaults,
    name: "CSV Caption",
    x: "@csvchart.x",
    y: "@csvchart_bm.y + 24",
    w: "@csvchart.w",
    h: 44, z: 21,
    text: "The widget is a project asset (csv_bar_graph.plugin.js); the numbers are a project asset too.",
    font: "poppins", size: 22, bold: false, fill: "#a9b1d6",
    align: "left", valign: "middle",
  },
};

// CLEAR THE STAGE. Deltas FOLD: slide 5's state is every earlier slide's state
// plus this slide's delta, so without this every item from slides 1-4 is still on
// stage underneath the chart. `active: false` is the universal way to say "exists,
// but not on this slide" — it keyframes visibility rather than deleting the item,
// so slides 1-4 are untouched. The camera is exempt: it is purgeable:false and
// owns the background and the view, so deactivating it would remove the view.
const carriedOver = new Set();
for (const slide of doc.slides)
  for (const [id, patch] of Object.entries(slide.delta?.items ?? {}))
    if (patch && id !== cameraId) carriedOver.add(id);
for (const id of carriedOver) if (!(id in items)) items[id] = { active: false };

doc.slides.push({
  id: SLIDE_ID,
  name: "CSV Bar Graph (plugin asset)",
  transition: { type: "tween", seconds: 0.5, curve: "smooth", sound: null },
  delta: { items },
});

const { doc: repaired, reports: repairReports } = repairedDocument(doc, registry);
if (repairReports.length) {
  console.error("REPAIR REPORTS (must be zero):");
  for (const r of repairReports) console.error("  -", r);
  process.exit(1);
}
writeFileSync(`${PROJECT_DIR}/doc.json`, JSON.stringify(repaired, null, 1));
console.log(`slide 5 written; ${repaired.slides.length} slides, 0 repair reports`);
