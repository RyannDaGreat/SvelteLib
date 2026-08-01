/**
 * THE ARROW-FAMILY PRESET DISTINCTNESS GATE — bare node, real Skia, real pixels.
 *
 * WHAT IT PROVES: no two presets on a connector render the same picture, and none
 * renders the same picture as that widget's own UNTOUCHED DEFAULT.
 *
 * ── WHY THE DEFAULT IS IN THE SWEEP ──────────────────────────────────────────
 * A preset that reproduces the widget's default is a DEAD ROW — it teaches the user
 * nothing an untouched insert does not already show — and no preset-vs-preset
 * comparison can ever see it, because the default is not a preset. This was found
 * for real on another family (a shipped preset byte-identical to its own default),
 * which is why every sweep here starts with `(DEFAULT)`.
 *
 * ── WHY BARE NODE AND NOT A BROWSER PROBE ────────────────────────────────────
 * The sibling preset gates are browser probes because their widgets need a GPU
 * (materials, backdrops, media). A connector is PURE VECTOR — polyline, polygon and
 * path, nothing else — which is exactly the case `cli/render.js`'s software Skia
 * surface exists for. So this runs in node: no Chrome, no capture-hang risk, and
 * deterministic. It uses the SAME shared metric the browser probes use.
 *
 * ── WHY THE LIT SET AND NOT THE WHOLE FRAME ──────────────────────────────────
 * THIS IS THE MEASUREMENT THE GATE TURNS ON, and a whole-frame mean would make it
 * gate nothing. A connector inks under 2% of its canvas, so averaging over every
 * pixel divides every difference by ~50 and reports two completely different arrows
 * as near-identical. `tests/imageDistinctness.js litSetDistance` restricts the
 * comparison to the pixels either frame actually touches — the region the presets
 * are responsible for. (Independently measured on the god-rays family, where the
 * same pairs moved an ORDER OF MAGNITUDE between the two reductions and three real
 * collisions were visible only under this one.)
 *
 * ── HOW THE BOUND WAS CALIBRATED, since it is a judgement and not a derivation ─
 * The module ships only the DERIVABLE floor (one code value = a display can show
 * it). "Far enough apart to be worth a separate row" is a judgement each family
 * calibrates against pairs it has looked at. Two measured anchors bracket it:
 *
 *   5.53  Extension Line <-> Hairline Pointer   A REAL COLLISION. Hairline Pointer's
 *         7x4 head on a 0.75 shaft does not read as a head, so it was within 5.5
 *         levels of the HEADLESS preset. CUT during authoring.
 *   15.14 Flowchart Step <-> Bidirectional Link A REAL DISTINCTION, confirmed by
 *         eye on the contact sheet: the same route with one head versus two. The
 *         narrowest margin that must PASS.
 *
 * So the bound sits between them, and 10 is the midpoint. Anything below it is
 * closer than a pair already judged too close; anything above passes a pair already
 * judged correct. `maxAbs` is reported too because no averaging can hide a
 * single-channel outlier.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());

/** The five connectors, DERIVED from the roster (every plugin spreading the
 *  endpoint-pair hooks and shipping presets) rather than listed, so a sixth is
 *  swept the day it is registered. */
const CONNECTORS = registry.all().filter((p) => p.editPoints && p.moveBy && p.closestToward && (p.presets ?? []).length);

/** Lit-set levels below which two connector renders are the same row. Calibrated
 *  above against one measured collision (5.53) and one measured true distinction
 *  (15.14); this is their midpoint. */
const MIN_SEPARATION = 10;

// A span non-degenerate in BOTH axes: on a purely horizontal one the elbow's "hvh"
// and "vhv" routes coincide and half that widget's table would compare as equal.
const SPAN = { from: { x: 60, y: 70 }, to: { x: 340, y: 190 } };
const W = 400, H = 260;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);

async function frame(plugin, props) {
  return readPng(await renderToPng(plugin.emit({ ...plugin.defaults, ...SPAN, ...props }), VIEW, { width: W, height: H }));
}

// "Nothing applied" for a widget is the canvas with no widget on it.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H }));

test("the sweep found the connector preset tables at all", () => {
  assert.deepEqual(CONNECTORS.map((p) => p.type).sort(),
    ["arrow", "curved_arrow", "elbow_arrow", "fancy_arrow", "line"]);
});

for (const plugin of CONNECTORS) {
  const frames = [{ name: "(DEFAULT)", png: await frame(plugin, {}) }];
  for (const preset of plugin.presets) frames.push({ name: preset.name, png: await frame(plugin, preset.props) });

  test(`${plugin.type}: ${plugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= MIN_SEPARATION,
          `${plugin.type}: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
  });
}

test("EVERY preset in a family writes the IDENTICAL key set", () => {
  // Application is an OVERLAY, so a key one preset omits keeps whatever the
  // previously HOVERED preset left behind. In a family full of on/off switches
  // (`dashed`, a head shape of "none") that is not a subtlety but a wrong picture:
  // hover Realization, click Drafting Leader, and the "drafting" leader is dashed.
  for (const plugin of CONNECTORS) {
    const sets = new Set(plugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `${plugin.type} presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  }
});

test("no connector preset carries a head shape the enum does not have", () => {
  // The retired `headMode` would pass the generic key-exists check on a plugin that
  // still declared it; this is the arrow-specific half. A misspelt shape is a LOUD
  // throw at emit (headDrawing), but a preset is data and would ship unexecuted.
  const shapes = new Set(registry.get("arrow").inspector.find((r) => r.key === "headEnd").options);
  for (const plugin of CONNECTORS)
    for (const preset of plugin.presets)
      for (const key of ["headStart", "headEnd"])
        if (key in preset.props)
          assert.ok(shapes.has(preset.props[key]),
            `${plugin.type} "${preset.name}": ${key} is ${JSON.stringify(preset.props[key])}, not a head shape`);
  for (const plugin of CONNECTORS)
    for (const preset of plugin.presets)
      assert.equal("headMode" in preset.props, false, `${plugin.type} "${preset.name}" writes the RETIRED headMode — a dead key is a silent no-op`);
});

console.log(`\n${passed} arrow-preset tests passed`);
