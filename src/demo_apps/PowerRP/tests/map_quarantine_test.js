/**
 * map_quarantine_test.js — R6-10.1: THE MAP WIDGET IS WITHHELD, VISIBLY.
 * Run: node src/demo_apps/PowerRP/tests/map_quarantine_test.js
 *
 * The user's ruling on the globe/map widget was one line — it is "a hot mess right
 * now" — with a recorded symptom: it renders correctly in the editor and in a
 * presentation, and NOT to MP4 (R6-10.2, whose mechanism is separately diagnosed as
 * `web/gpuService.js` calling `cameraFrameIR` with no `view`, so the tile pre-pass
 * never runs). Until that is fixed the widget must not be reachable for INSERTION.
 *
 * HOW, AND WHY THIS WAY RATHER THAN DELETING THE COMMAND. The pane's own rule for an
 * action that cannot run is stated in core/registry.js: "Rendered DISABLED, never
 * hidden, with `requires` as the tooltip's reason — hiding it would make the tool
 * unlearnable." A quarantine is exactly that case, so it uses exactly that mechanism:
 * `when: () => false` plus a `requires` sentence, the same pair every other gated
 * command in web/App.svelte uses. Deleting the entry was the alternative and it is
 * the arbitrary one — it shrinks the palette silently, and nothing downstream could
 * then distinguish "withheld on purpose" from "lost in a merge".
 *
 * WHAT IS NOT QUARANTINED, and this half matters more than the other: the PLUGIN. It
 * stays registered, so a document that already contains a map still folds, still
 * renders and still exports. A quarantine that broke saved decks would be a data-loss
 * bug wearing a safety label.
 *
 * IT READS THE SOURCE rather than mounting the app, because App.svelte's command list
 * is built inside the component and a bare-node import cannot reach it — the same
 * reason and the same technique as tests/shortcut_sweep_test.js, which sweeps that
 * file's text for the identical kind of declaration.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { MAP_WIDGET_TYPE } from "../render_gpu/map_display.js";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(resolve(powerRP, "web/App.svelte"), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The palette id of the map's insert command — the ONE surfacing that creates one. */
const INSERT_COMMAND_ID = "demo-insert-globe-map";

/** Pure function. The single source line declaring the command with this id, or null.
 *
 * @param {string} src - web/App.svelte's text
 * @param {string} id - a command id
 * @returns {string|null} the whole declaring line, trimmed
 *
 * @example commandLine('{ id: "x", title: "X" },', "x") // '{ id: "x", title: "X" },'
 * @example commandLine('{ id: "y" },', "x") // null
 */
export function commandLine(src, id) {
  const line = src.split("\n").find((l) => l.includes(`id: "${id}"`));
  return line === undefined ? null : line.trim();
}

test("the map's INSERT command is still declared — quarantine greys it, it does not delete it", () => {
  const line = commandLine(appSource, INSERT_COMMAND_ID);
  assert.ok(
    line,
    `web/App.svelte no longer declares "${INSERT_COMMAND_ID}". If the widget was meant to come back, remove this ` +
    "whole file with the quarantine; if it was meant to stay withheld, grey the command rather than deleting it, " +
    "so the palette can say WHY (core/registry.js: rendered disabled, never hidden).",
  );
});

test("...and it is gated OFF, with a reason a person can act on", () => {
  const line = commandLine(appSource, INSERT_COMMAND_ID);
  assert.match(
    line, /when:\s*\(\)\s*=>\s*false/,
    "the map insert command is RUNNABLE again. R6-10.1 withheld it (the user: \"a hot mess right now\"), and its " +
    "recorded defect — right in the editor and in a presentation, wrong to MP4 — is not fixed by this file.",
  );
  assert.match(line, /requires:\s*REQUIRES_MAP_UNQUARANTINED/, "a permanently-false gate with no `requires` renders as a dead control with no explanation");
  // The sentence completes "Unavailable — requires …", so it must READ as one and must
  // name the defect rather than just asserting the ban.
  const sentence = appSource.split("\n").find((l) => l.includes("const REQUIRES_MAP_UNQUARANTINED"));
  assert.ok(sentence, "REQUIRES_MAP_UNQUARANTINED is not declared");
  assert.match(sentence, /MP4/, "the reason must name the actual defect, or it is an unappealable 'because I said so'");
  assert.match(sentence, /still open, render and export/, "the reason must say that existing maps are unaffected — that is the question a user with one in a deck will ask");
});

test("the PLUGIN is untouched, so a document that already holds a map still works", () => {
  const registry = createRegistry();
  registerPlugins(registry);
  const plugin = registry.get(MAP_WIDGET_TYPE);
  assert.ok(plugin, `${MAP_WIDGET_TYPE} is no longer registered — every saved deck containing a map would fail to fold`);
  assert.ok(typeof plugin.emit === "function", "a registered map must still be able to draw itself");
  const ops = plugin.emit({ ...plugin.defaults, x: 0, y: 0, w: 200, h: 200 }, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  assert.ok(Array.isArray(ops) && ops.length > 0, "a quarantined widget must still render the maps that already exist");
});

console.log(`\nmap quarantine tests: ${passed} passed`);
