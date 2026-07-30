/**
 * PLUGIN-ASSET EDITING tests — plain node, no DOM, no browser.
 * Run: node src/demo_apps/PowerRP/tests/plugin_asset_edit_test.js
 *
 * WHAT IS UNDER TEST is the VALIDATION RULE behind the user ruling "if I double
 * click a plugin, it should let me edit the JavaScript inside of it": a save must
 * be refused (with the modal kept open) exactly when the loader would refuse to
 * register the result — and NOT otherwise.
 *
 * The subtle half, and the reason this file exists rather than a browser probe
 * alone: the asset being edited is ALREADY REGISTERED, so its own type is in the
 * registry's taken set. Validating a re-save against that set naively refuses every
 * plugin for colliding with itself, i.e. the feature is unusable for the one case it
 * exists for (edit gear.plugin.js, press Save). app.svelte.js commitPluginAssetCode
 * therefore removes THIS asset's currently-declared type from the taken set before
 * validating. That subtraction is what is pinned below, in both directions:
 *   - re-saving a plugin under its own type is ALLOWED
 *   - renaming its type onto a BUILT-IN's (or another asset's) is still REFUSED
 *
 * app.svelte.js itself cannot be imported in bare node (it is a Svelte runes
 * module and reads `location` transitively), so this file exercises the same
 * core/plugin_assets.js primitives in the same order commitPluginAssetCode does.
 * The BROWSER half — that a refusal keeps the dialog open, that a success writes the
 * bytes and re-registers the widget — is verified by the puppeteer probe.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { loadPluginAsset, registerPluginAssets, isPluginAssetName } from "../core/plugin_assets.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const GEAR = `return {
  type: "gear_edit_probe",
  title: "Gear",
  capabilities: { bbox: true },
  defaults: { type: "gear_edit_probe", w: 100, h: 100, fill: "#888" },
  emit: (s) => [{ op: "rect", x: 0, y: 0, w: s.w, h: s.h, fill: s.fill }],
};`;

/** The taken-type set commitPluginAssetCode validates against: everything the
 *  registry holds, MINUS whatever type the asset's CURRENT source declares. Mirrors
 *  the app method's own two steps, so a change to one should break this. */
function takenTypesForEdit(registry, currentSource, filename) {
  const taken = new Set(registry.all().map((p) => p.type));
  try {
    taken.delete(loadPluginAsset(currentSource, filename, new Set()).type);
  } catch {
    // A stored source that is already broken registered nothing and reserves no
    // type — the app's own branch, which discards only that fact.
  }
  return taken;
}

// ── The naming rule the whole feature keys off ───────────────────────────────

test("only a .plugin.js asset is editable as a widget", () => {
  assert.equal(isPluginAssetName("gear.plugin.js"), true);
  assert.equal(isPluginAssetName("helper.js"), false); // a bare .js is not a widget
  assert.equal(isPluginAssetName("sales.csv"), false);
});

// ── The self-collision subtraction ──────────────────────────────────────────

test("re-saving a plugin under its OWN type is allowed", () => {
  const registry = createRegistry();
  const { loaded } = registerPluginAssets(registry, [{ name: "gear.plugin.js", source: GEAR }]);
  assert.deepEqual(loaded, ["gear_edit_probe"]);
  // The naive check — validate against the FULL taken set — refuses this, which is
  // the bug this subtraction exists to prevent.
  const naiveTaken = new Set(registry.all().map((p) => p.type));
  assert.throws(() => loadPluginAsset(GEAR, "gear.plugin.js", naiveTaken), /already registered/);
  // The real check accepts it.
  const edited = GEAR.replace("#888", "#ff8844");
  const plugin = loadPluginAsset(edited, "gear.plugin.js", takenTypesForEdit(registry, GEAR, "gear.plugin.js"));
  assert.equal(plugin.type, "gear_edit_probe");
  assert.equal(plugin.defaults.fill, "#ff8844");
});

test("RENAMING the type onto a built-in's is still REFUSED", () => {
  const registry = createRegistry();
  // Stand in for a built-in: any already-registered type that is not this asset's.
  registerPluginAssets(registry, [
    { name: "gear.plugin.js", source: GEAR },
    { name: "other.plugin.js", source: GEAR.replace(/gear_edit_probe/g, "other_edit_probe") },
  ]);
  const renamed = GEAR.replace(/gear_edit_probe/g, "other_edit_probe");
  assert.throws(
    () => loadPluginAsset(renamed, "gear.plugin.js", takenTypesForEdit(registry, GEAR, "gear.plugin.js")),
    /type "other_edit_probe" is already registered/,
  );
});

test("a plugin whose STORED source is broken can still be saved fixed", () => {
  // The likeliest reason someone opens this editor at all. The stored source
  // registered nothing, so it reserves no type and must not block its own repair.
  const registry = createRegistry();
  const BROKEN = `return {type: "gear_edit_probe"}; // no emit, no defaults, no capabilities`;
  const { loaded, reports } = registerPluginAssets(registry, [{ name: "gear.plugin.js", source: BROKEN }]);
  assert.deepEqual(loaded, []);
  assert.equal(reports.length, 1);
  const fixed = loadPluginAsset(GEAR, "gear.plugin.js", takenTypesForEdit(registry, BROKEN, "gear.plugin.js"));
  assert.equal(fixed.type, "gear_edit_probe");
});

// ── What a refusal must look like (the footer's text) ────────────────────────

test("every refusal names the FILE and the reason", () => {
  const registry = createRegistry();
  for (const [source, pattern] of [
    [`return {type: "x"};`, /is missing|emit/i],
    [`this is not javascript at all (((`, /gear\.plugin\.js/],
    [`return 42;`, /gear\.plugin\.js/],
    [`return null;`, /gear\.plugin\.js/],
  ]) {
    assert.throws(
      () => loadPluginAsset(source, "gear.plugin.js", takenTypesForEdit(registry, GEAR, "gear.plugin.js")),
      (e) => {
        // The message becomes the modal's footer line, so it must name the file —
        // the author may have several plugins open in a session.
        assert.match(e.message, /gear\.plugin\.js/);
        assert.match(e.message, pattern);
        return true;
      },
      `source: ${source.slice(0, 30)}`,
    );
  }
});

test("a REFUSED edit leaves the live registry untouched", () => {
  // The reason validation runs BEFORE the write and before reloadPluginAssets: a
  // half-applied edit would leave items of this type orphaned, and repair drops
  // orphans on the next load (pluginAssetLoader.js's header).
  const registry = createRegistry();
  registerPluginAssets(registry, [{ name: "gear.plugin.js", source: GEAR }]);
  const before = registry.get("gear_edit_probe");
  assert.throws(() => loadPluginAsset(`return {type: "gear_edit_probe"};`, "gear.plugin.js", takenTypesForEdit(registry, GEAR, "gear.plugin.js")));
  assert.equal(registry.get("gear_edit_probe"), before, "the registry entry must be the SAME object");
  assert.equal(registry.get("gear_edit_probe").defaults.fill, "#888");
});

console.log(`\n${passed} plugin-asset editing tests passed.`);
