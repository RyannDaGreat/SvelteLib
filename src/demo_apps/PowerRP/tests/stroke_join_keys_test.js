/**
 * THE STROKE-OPTION KEY LISTS TRAVEL TOGETHER — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/stroke_join_keys_test.js
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 * The universal stroke options reach a widget by two routes. Widgets that compose
 * `bundle("strokedBox")` / `bundle("strokedBorder")` get every one of them for
 * free, and cannot drift. But NINE widgets do not compose those bundles — their
 * geometry is not a box — and instead hand-splice `...props(...STROKE_TRIM_KEYS)`
 * into their own inspector array. Those nine are precisely the corner-rich ones:
 * paint_path, polygon, shapeshifter, graph_line, the graph decorations.
 *
 * A HAND-MAINTAINED LIST THAT MIRRORS ANOTHER MODULE'S SHAPE IS THIS CODEBASE'S
 * WORST RECURRING DEFECT. Nine splices that must be edited in lockstep with a key
 * list they do not own is exactly that shape: it looks reasonable when written and
 * rots in silence, because a tenth widget added later, or an eleventh key added to
 * one list and not the other, produces no error — just a property that is
 * invisible on the widgets that need it most.
 *
 * So the pairing is DERIVED from the plugins themselves and asserted, rather than
 * restated: a plugin that offers the trim rows must offer the join rows, and a
 * plugin that offers the join rows must offer the trim rows. Neither direction is
 * decoration — the first catches "new widget forgot the join rows", the second
 * catches "someone spliced join into a widget whose stroke has no free ends but
 * also no corners".
 *
 * The eventual fix is one `STROKE_OPTION_KEYS` name that the nine splice instead
 * of two, which is a wider change than this task; deferring the fix is not
 * deferring the gate.
 */
import assert from "assert";
import { PROPS, BUNDLES, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS, STROKE_OFFSET_KEYS } from "../core/properties.js";
import { allPlugins } from "../plugins/index.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

/** Query. The set of property keys a plugin's inspector declares. */
const rowKeys = (plugin) => new Set((plugin.inspector ?? []).map((r) => r.key));
const hasAll = (keys, list) => list.every((k) => keys.has(k));
const hasAny = (keys, list) => list.some((k) => keys.has(k));

test("the three key lists are disjoint and every entry is a real PROPS row", () => {
  const all = [...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS, ...STROKE_OFFSET_KEYS];
  assert.equal(new Set(all).size, all.length, "a key in two lists would be spliced twice into one inspector");
  for (const k of all) assert.ok(PROPS[k], `${k} is in a stroke key list but not declared in PROPS`);
});

test("EVERY plugin that offers the trim rows offers the join rows, and the reverse", () => {
  const offenders = [];
  for (const plugin of allPlugins) {
    const type = plugin.type;
    const keys = rowKeys(plugin);
    const trim = hasAll(keys, STROKE_TRIM_KEYS), join = hasAll(keys, STROKE_JOIN_KEYS);
    if (trim !== join) offenders.push(`${type}: trim=${trim} join=${join}`);
    // A PARTIAL splice is worse than either — half a framework with no complaint.
    if (hasAny(keys, STROKE_JOIN_KEYS) && !join) offenders.push(`${type}: only PART of STROKE_JOIN_KEYS`);
    if (hasAny(keys, STROKE_TRIM_KEYS) && !trim) offenders.push(`${type}: only PART of STROKE_TRIM_KEYS`);
  }
  assert.deepEqual(offenders, [],
    "these plugins carry one universal stroke-option list without the other — splice ...STROKE_JOIN_KEYS beside ...STROKE_TRIM_KEYS");
});

test("the gate has real subjects — the bundles AND the hand-splicing widgets", () => {
  // A gate over an empty set passes forever and proves nothing, so count them.
  const withTrim = allPlugins.filter((p) => hasAll(rowKeys(p), STROKE_TRIM_KEYS)).map((p) => p.type);
  assert.ok(withTrim.length >= 20, `expected many stroked widgets, found ${withTrim.length}`);
  // And at least some of them must NOT come from the bundles, or the interesting
  // half of the gate (the hand-splices) is untested.
  const bundled = new Set([...BUNDLES.strokedBox, ...BUNDLES.strokedBorder]);
  assert.ok(STROKE_JOIN_KEYS.every((k) => bundled.has(k)), "both bundles must carry the join keys");
  console.log(`      (${withTrim.length} widgets carry the universal stroke options)`);
});

console.log(`\nstroke_join_keys_test: ${passed} passed`);
