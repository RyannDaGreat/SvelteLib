/**
 * COMPUTED-DEFAULT gate — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/computed_default_test.js
 *
 * ── THE RULE, AND WHY IT NEEDED A GATE ───────────────────────────────────────
 * A plugin default may be an EQUATION — `rotationAnchor.x` defaults to
 * "self.anchors.center.x", the video scrubber's `progress` to a whole ternary — and
 * core/expressions.js decides whether a stored string in a slot IS an equation
 * STRUCTURALLY, from the shape of the plugin's own default:
 *
 *   isNumericSlot (core/expressions.js): a string default is a computed default
 *   iff it BEGINS with "self.".
 *
 * That rule is load-bearing and correct — it is what keeps every `name: "Text"` and
 * `fill: "#7aa2f7"` out of the expression system with no per-plugin annotation. But it
 * is a rule about the first five characters of a string, stated in one function, and a
 * widget author reaching for a computed default has no reason to know it.
 *
 * MEASURED, in the browser, on the day this file was written: `labeled_circle` wanted
 * its label size to track the disc and needed the value to survive a vertical FLIP
 * (a stored `h` may be negative), so the obvious default was
 *
 *     size: "Math.abs(self.h) * 0.65"
 *
 * which CONTAINS `self.` but does not begin with it. It is therefore an ordinary
 * string, so nothing evaluated it and the raw text reached the painter: the widget
 * red-boxed with `"size" must be a finite number`. Loud, but only at PAINT time, and
 * only for someone who rendered that widget — every node suite was green.
 *
 * ── WHAT THIS SWEEPS ─────────────────────────────────────────────────────────
 * Every string leaf of every registered plugin's `defaults`. A leaf that mentions
 * `self.` at all is either a computed default (begins with `self.` — fine) or a string
 * that will never be evaluated (does not — almost certainly a mistake, and named here
 * with the fix). Nothing else is asserted: this gate has exactly one opinion.
 *
 * The `=` MARKER is deliberately not a way out. A leading "=" makes any slot an
 * equation, but the RESULT KIND is resolved from the default's own type, so
 * `size: "= Math.abs(self.h) * 0.65"` resolves as a STRING slot and reports
 * "expression result 167.05 is not a valid string value" — measured too. A computed
 * default is `self.`-prefixed or it is not a computed default.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { isNumericSlot } from "../core/expressions.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerPlugins(registry);
const roster = registry.all();

/**
 * Pure function. Every STRING leaf of a defaults object, as [dottedPath, value].
 * An array is a leaf's container rather than a leaf — a list property's default is the
 * whole list, and core/lists.js owns element-level values — so its entries are walked
 * but its own path is not reported.
 *
 * @example stringLeaves({name: "Box", w: 10}) // [["name", "Box"]]
 * @example stringLeaves({rotationAnchor: {x: "self.anchors.center.x"}}) // [["rotationAnchor.x", "self.anchors.center.x"]]
 * @example stringLeaves({frames: [["self.video_start"]]}) // [["frames.0.0", "self.video_start"]]
 */
export function stringLeaves(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([path, v]);
    else if (v != null && typeof v === "object") out.push(...stringLeaves(v, path));
  }
  return out;
}

/**
 * Pure function. Does this string default MENTION `self.` without being a computed
 * default — i.e. will core/expressions.js treat it as inert text while its author
 * plainly meant it to be evaluated?
 *
 * @example mentionsSelfWithoutLeading("self.h * 0.65") // false (a real computed default)
 * @example mentionsSelfWithoutLeading("Math.abs(self.h) * 0.65") // true (inert text — the measured defect)
 * @example mentionsSelfWithoutLeading("= self.h * 0.65") // true (the "=" marker does not resolve the KIND)
 * @example mentionsSelfWithoutLeading("#7aa2f7") // false (an ordinary string default)
 */
export function mentionsSelfWithoutLeading(value) {
  return value.includes("self.") && !value.startsWith("self.");
}

test("no plugin default MENTIONS self. without being a computed default", () => {
  const offenders = [];
  for (const plugin of roster)
    for (const [path, value] of stringLeaves(plugin.defaults))
      if (mentionsSelfWithoutLeading(value))
        offenders.push(`${plugin.type}.${path} = ${JSON.stringify(value)}`);
  assert.deepEqual(offenders, [],
    "core/expressions.js isNumericSlot only treats a string default as an equation when it BEGINS with \"self.\" — " +
    "these would reach the painter as raw text: " + offenders.join("; "));
});

test("the gate has real subjects — computed defaults exist and are recognised", () => {
  // The anti-vacuity floor. If no plugin used a computed default at all, the sweep
  // above would pass forever while saying nothing.
  const computed = [];
  for (const plugin of roster)
    for (const [path, value] of stringLeaves(plugin.defaults))
      if (value.startsWith("self.")) computed.push({ type: plugin.type, path, value });
  assert.ok(computed.length >= 20, `expected many computed defaults across the roster, found ${computed.length}`);
  // And they really are recognised as equation slots — the sweep's premise, checked
  // against core/expressions.js itself rather than restated.
  const unrecognised = computed.filter(({ type, path }) => {
    const plugin = roster.find((p) => p.type === type);
    const segments = path.split(".").map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
    return !isNumericSlot(plugin, segments);
  });
  assert.deepEqual(unrecognised.map((u) => `${u.type}.${u.path}`), [],
    "a self.-prefixed default that isNumericSlot does not recognise would evaluate as text");
  console.log(`      (${computed.length} computed defaults across ${new Set(computed.map((c) => c.type)).size} widget types)`);
});

console.log(`\n${passed} tests passed`);
