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
import fs from "node:fs";
import { createRegistry } from "../core/registry.js";
import {
  loadPluginAsset,
  registerPluginAssets,
  isPluginAssetName,
  retypedPluginSource,
  uniquePluginAssetName,
  uniquePluginType,
} from "../core/plugin_assets.js";
import { builtinPluginAssetSources, registerBuiltinPluginAssets } from "../core/builtin_plugin_assets.js";

/** Query. One built-in library source by filename. Loud when absent — a renamed
 *  library file must fail the test, not silently skip it. */
function builtinSource(name) {
  const { sources } = builtinPluginAssetSources();
  const found = sources.find((s) => s.name === name);
  if (!found) throw new Error(`builtinSource: no built-in named "${name}" (have: ${sources.map((s) => s.name).join(", ")})`);
  return found.source;
}

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

// ── The STORE VERB the save must use ────────────────────────────────────────

test("both asset-store adapters expose `replace`, distinct from `put`", () => {
  // WHY THIS ASSERTION EXISTS: the first version of the plugin editor saved through
  // `put`, which DE-COLLIDES a taken filename. So every save wrote a NEW numbered
  // file ("gear-2.plugin.js") and left the edited asset untouched — the dialog
  // closed, the widget did not change, and nothing reported a problem. Measured on
  // the browser probe: four saves produced four numbered copies.
  //
  // Read as SOURCE TEXT rather than imported: web/assetStore.js reaches
  // projectApi.js, which reads `location` at module scope and cannot load in bare
  // node (the same reason tests/asset_store_test.js imports only assetRef.js).
  const src = fs.readFileSync(new URL("../web/assetStore.js", import.meta.url), "utf8");
  for (const store of ["httpAssetStore", "localAssetStore"]) {
    const body = src.slice(src.indexOf(`export const ${store}`));
    const next = body.slice(1).search(/\nexport const \w+AssetStore|\nexport const \w+ProjectStore/);
    const scoped = next === -1 ? body : body.slice(0, next + 1);
    assert.match(scoped, /\breplace\s*[:(]/, `${store} must define a replace() verb`);
    assert.match(scoped, /replace overwrites, it does not create/, `${store}.replace must be LOUD when the asset is absent`);
  }
});

test("app.svelte.js saves an edited plugin through replace, never put", () => {
  const src = fs.readFileSync(new URL("../web/app.svelte.js", import.meta.url), "utf8");
  const commit = src.slice(src.indexOf("async commitPluginAssetCode"));
  const body = commit.slice(0, commit.indexOf("\n  }\n") + 4);
  assert.match(body, /assetStore\(\)\.replace\(/, "the save must overwrite in place");
  assert.doesNotMatch(body, /assetStore\(\)\.put\(/, "put de-collides and cannot save an edit");
});

// ── EDITING A BUILT-IN: read-only + copy-on-save (the 404 repro) ─────────────
//
// THE BUG: the Asset Explorer lists the built-in widget library in the same grid as
// the project's files, and every plugin-asset method resolved a tile's name against
// the PROJECT's asset store. So double-clicking clock_digital.plugin.js threw
//   httpAssetStore.get(RobotSim, clock_digital.plugin.js): 404
// because those bytes are bundled in the app and have never been in a project folder.
//
// The browser half (read-only Monaco, the footer note, the dialog staying open) is the
// puppeteer probe's. What is pinned HERE is the part that decides whether the copy is a
// WIDGET or a dead file — and it is not obvious in either direction.

test("a VERBATIM copy of a built-in is REFUSED — which is why the copy must be retyped", () => {
  // The trap this whole feature turns on. "Save copies into this project" sounds like
  // it should just write the bytes; it must not. The loader refuses a type that is
  // already registered ("may not shadow a built-in"), so a byte-identical copy would
  // be stored, listed and thumbnailed while silently NOT being a widget — the reason
  // living only in a console report. A distinct FILENAME does not help: the collision
  // is on TYPE.
  const registry = createRegistry();
  registerBuiltinPluginAssets(registry);
  const source = builtinSource("clock_digital.plugin.js");
  const res = registerPluginAssets(registry, [{ name: "clock_digital 2.plugin.js", source }]);
  assert.deepEqual(res.loaded, [], "a verbatim copy must register NOTHING");
  assert.equal(res.reports.length, 1);
  assert.match(res.reports[0], /type "clock_digital" is already registered/);
});

test("uniquePluginAssetName keeps the .plugin.js suffix intact", () => {
  // assetRef.uniqueAssetName splits at the LAST dot, so it would name the copy
  // "clock_digital.plugin 2.js" — which isPluginAssetName REJECTS. The copy would load
  // as an ordinary .js file, i.e. not at all, and its items would become orphans that
  // repair DROPS. A two-dot suffix needs a suffix-aware de-collide.
  assert.equal(uniquePluginAssetName("gear.plugin.js", []), "gear.plugin.js");
  const copy = uniquePluginAssetName("clock_digital.plugin.js", ["clock_digital.plugin.js"]);
  assert.equal(copy, "clock_digital 2.plugin.js");
  assert.ok(isPluginAssetName(copy), "the de-collided name must still BE a plugin asset");
  assert.equal(
    uniquePluginAssetName("donut.plugin.js", ["donut.plugin.js", "donut 2.plugin.js"]),
    "donut 3.plugin.js",
  );
});

test("uniquePluginType numbers a type without leaving lower_snake_case", () => {
  // pluginShapeProblem requires /^[a-z][a-z0-9_]*$/, so the suffix has to be `_2`
  // rather than a dash or a space — a copy whose type fails that check is refused for
  // a second, more confusing reason than the collision it was avoiding.
  assert.equal(uniquePluginType("gear", []), "gear");
  assert.equal(uniquePluginType("clock_digital", ["clock_digital"]), "clock_digital_2");
  assert.equal(uniquePluginType("donut", ["donut", "donut_2"]), "donut_3");
  assert.match(uniquePluginType("clock_digital", ["clock_digital"]), /^[a-z][a-z0-9_]*$/);
});

test("EVERY built-in, retyped, registers as a working widget beside its original", () => {
  // The end-to-end claim of "Save copies into this project", checked against the REAL
  // library rather than a fixture — the copy has to be a widget, not merely a file.
  // Both halves matter: it must register (so the type rewrite reached BOTH `type` and
  // `defaults.type`, which pluginShapeProblem requires to match), and its emit() must
  // run (so wrapping the source did not break the closure over its own helpers).
  const registry = createRegistry();
  registerBuiltinPluginAssets(registry);
  const { sources } = builtinPluginAssetSources();
  assert.ok(sources.length >= 5, "read no built-in library sources — the loader broke, not the copy");
  const taken = new Set(registry.all().map((p) => p.type));
  for (const { name, source } of sources) {
    const baseType = loadPluginAsset(source, name, new Set()).type;
    const newType = uniquePluginType(baseType, taken);
    assert.notEqual(newType, baseType, `${name}: its own type must already be taken by the registered built-in`);
    const file = uniquePluginAssetName(name, sources.map((s) => s.name));
    const res = registerPluginAssets(registry, [{ name: file, source: retypedPluginSource(source, newType) }]);
    assert.deepEqual(res.reports, [], `${name}: the retyped copy must register cleanly`);
    assert.deepEqual(res.loaded, [newType]);
    taken.add(newType);
    // A registered type that cannot draw is still a broken widget.
    const plugin = registry.get(newType);
    const ops = plugin.emit({ ...plugin.defaults });
    assert.ok(Array.isArray(ops) && ops.length > 0, `${name}: the copy's emit() must produce display-list ops`);
    // And the ORIGINAL is untouched — a copy that shadowed its source would defeat
    // the point of refusing verbatim copies in the first place.
    assert.equal(registry.get(baseType).type, baseType);
  }
});

test("retypedPluginSource rewrites the type WITHOUT touching the author's text", () => {
  // WHY WRAPPING, NOT SUBSTITUTION: `type:` occurs at least twice in every real source
  // (the plugin's own and defaults.type) and also inside comments and strings. This
  // fixture has a decoy in both places; a regex rewrite would corrupt one of them.
  const decoy = `
    // A comment mentioning type: "not_the_real_one" on purpose.
    const label = 'type: "also_not_it"';
    return {
      type: "decoy_probe", title: label, capabilities: { bbox: true },
      defaults: { type: "decoy_probe", w: 7 }, emit: () => [{ op: "rect", x: 0, y: 0, w: 1, h: 1 }],
    };`;
  const p = loadPluginAsset(retypedPluginSource(decoy, "decoy_probe_2"), "d.plugin.js", new Set(["decoy_probe"]));
  assert.equal(p.type, "decoy_probe_2");
  assert.equal(p.defaults.type, "decoy_probe_2", "defaults.type must move with it or the shape check fails");
  assert.equal(p.defaults.w, 7, "every other default survives");
  assert.equal(p.title, 'type: "also_not_it"', "a string in the author's code is NOT rewritten");
});

test("app.svelte.js reads a BUILT-IN's source from the catalog, never from the store", () => {
  // The 404 itself. pluginAssetSource must answer a built-in from the bundled entry;
  // asking assetStore().get for it is the live-repro bug.
  const src = fs.readFileSync(new URL("../web/app.svelte.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async pluginAssetSource"));
  const body = fn.slice(0, fn.indexOf("\n  }\n") + 4);
  assert.match(body, /builtinPluginAsset\(/, "it must ask whether the name is a built-in FIRST");
  assert.match(body, /return builtin\.source/, "a built-in's bytes are already in hand");
  // …and the built-in branch must come BEFORE the store read, or the 404 still happens.
  assert.ok(
    body.indexOf("builtin.source") < body.indexOf("assetStore().get"),
    "the built-in branch must return before the store is asked",
  );
});

test("a built-in opens READ-ONLY with the copy note, and Save routes to the copy path", () => {
  const src = fs.readFileSync(new URL("../web/app.svelte.js", import.meta.url), "utf8");
  const open = src.slice(src.indexOf("async openPluginAssetCode"));
  const openBody = open.slice(0, open.indexOf("\n  }\n") + 4);
  assert.match(openBody, /readOnly: builtin/, "a built-in's editor must refuse in-place edits");
  assert.match(openBody, /note: builtin \? BUILTIN_PLUGIN_EDIT_NOTE/, "and must say what Save will do instead");
  // The note is the whole reason a read-only dialog is not a dead end, so its wording
  // is pinned (the user ruling: a visible "Built-in — Save copies into this project").
  assert.match(src, /const BUILTIN_PLUGIN_EDIT_NOTE = "Built-in — Save copies into this project"/);
  const commit = src.slice(src.indexOf("async commitPluginAssetCode"));
  const commitBody = commit.slice(0, commit.indexOf("\n  }\n") + 4);
  assert.match(
    commitBody, /if \(t\.builtin\) return this\.copyBuiltinPluginAssetIntoProject\(source\)/,
    "a built-in Save must be routed out BEFORE the replace-in-place logic",
  );
  // The copy is a NEW file, so it uses put; replace would be loud-and-wrong (there is
  // no existing asset of that name to overwrite).
  const copy = src.slice(src.indexOf("async copyBuiltinPluginAssetIntoProject"));
  const copyBody = copy.slice(0, copy.indexOf("\n  }\n") + 4);
  assert.match(copyBody, /assetStore\(\)\.put\(/, "a copy is an ADD, not an overwrite");
  assert.doesNotMatch(copyBody, /assetStore\(\)\.replace\(/);
  assert.match(copyBody, /uniquePluginAssetName\(/, "the filename must be de-collided");
  assert.match(copyBody, /uniquePluginType\(/, "the type must be de-collided");
  assert.match(copyBody, /loadPluginAsset\(retyped/, "and validated BEFORE the write");
});

test("a built-in tile offers no trash can (it is not in the project to delete)", () => {
  // The same "a built-in is not a project asset" defect as the 404, in the hover
  // chrome: the trash used to render on a built-in tile and call deleteProjectAsset on
  // a file the backend has never heard of.
  const src = fs.readFileSync(new URL("../web/AssetExplorer.svelte", import.meta.url), "utf8");
  const grid = src.slice(src.indexOf("{#snippet assetGrid()}"));
  const trashAt = grid.indexOf("ae-trash");
  assert.ok(trashAt > 0, "the trash button vanished from the grid entirely");
  const guard = grid.lastIndexOf("{#if !a.builtin}", trashAt);
  assert.ok(guard > 0 && guard < trashAt, "the trash can must be inside an {#if !a.builtin} guard");
});

console.log(`\n${passed} plugin-asset editing tests passed.`);
