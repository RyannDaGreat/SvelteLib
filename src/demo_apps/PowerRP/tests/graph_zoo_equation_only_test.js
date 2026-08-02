/**
 * THE EQUATION ZOO WRITES ONLY THE EQUATION.
 *
 * User ruling, 2026-08-02: "The equation zoo should only, in the presets, should
 * only affect the equation. It shouldn't affect whether or not it's closed or
 * other stuff like that."
 *
 * app.applyPreset writes EXACTLY the keys in `preset.props` (web/app.svelte.js:
 * `Object.entries(preset.props)`), so the key SET of a graphLine preset IS the
 * set of properties a user's item loses control of. That makes this a key-set
 * assertion and not a styling opinion: any key here that is not a curve
 * definition would silently overwrite an author's stroke, framing or `closed`
 * flag on every preset switch, which is the behaviour the ruling forbids.
 *
 * Both directions matter:
 *   - the FORBIDDEN keys must be absent (the ruling), and
 *   - `mode` + `source` must be PRESENT (a filter that emptied every props map
 *     would pass a one-sided ban while making the zoo do nothing).
 *
 * Scope is the graphLine roster ONLY. graphBars/graphGrid/graphTickMarks presets
 * are whole-look families by design and are deliberately not swept here.
 */

import assert from "node:assert";
import { GRAPH_LINE_PRESETS } from "../plugins/graph_presets.js";

const ALLOWED = new Set(["mode", "source", "tStart", "tEnd", "numPoints", "jumpThreshold"]);
const REQUIRED = ["mode", "source"];

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("graph zoo: presets write the equation and nothing else");

test("the sweep is not vacuous", () => {
  assert.ok(GRAPH_LINE_PRESETS.length >= 10,
    `only ${GRAPH_LINE_PRESETS.length} graphLine presets — the roster is the equation zoo and should be rich; a shrunken roster means the export broke`);
});

test("no preset writes a styling, framing or closed key", () => {
  for (const preset of GRAPH_LINE_PRESETS) {
    const extra = Object.keys(preset.props).filter((k) => !ALLOWED.has(k));
    assert.deepStrictEqual(extra, [],
      `"${preset.name}" writes ${extra.join(", ")} — a preset may only set the curve DEFINITION (${[...ALLOWED].join(", ")}); applying it must not overwrite the author's styling, framing or closed flag`);
  }
});

test("every preset still defines a curve", () => {
  for (const preset of GRAPH_LINE_PRESETS)
    for (const key of REQUIRED)
      assert.ok(key in preset.props,
        `"${preset.name}" omits ${key} — the filter has emptied the preset, so choosing it would change nothing`);
});

test("presets stay distinct after filtering", () => {
  const seen = new Map();
  for (const preset of GRAPH_LINE_PRESETS) {
    const signature = JSON.stringify(Object.entries(preset.props).sort());
    assert.ok(!seen.has(signature),
      `"${preset.name}" and "${seen.get(signature)}" now write identical props — stripping the styling collapsed two rows into the same picture under two names`);
    seen.set(signature, preset.name);
  }
});

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
