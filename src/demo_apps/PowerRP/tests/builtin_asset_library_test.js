/**
 * THE BUILT-IN ASSET LIBRARY suite. Plain node, no framework (suite convention):
 *   node src/demo_apps/PowerRP/tests/builtin_asset_library_test.js
 *
 * Covers the four things the built-in-asset pass added, each of which has a
 * specific way of failing SILENTLY — which is why each is pinned here rather than
 * left to the browser probes:
 *
 *   (1) MIGRATION PARITY. The five tier-1 widgets now ship as sandboxed plugin
 *       ASSETS instead of source modules. "Behaviour identical" is only a claim
 *       until the asset's emit() is compared against the retired module's emit()
 *       on fixed states — a migration that changed a default or dropped an
 *       inspector row would otherwise look exactly like a working migration.
 *   (2) THE ROSTER. Those five must register in EVERY mode, and the file→type map
 *       the canvas drop path reads must equal the map registration produces.
 *   (3) THE DROP CLASSIFIER. Three outcomes, including the one that REPORTS.
 *   (4) THE TOTALS LINE + TOGGLE DEFAULT. Formatting goes through fileSize.js and
 *       the toggle defaults OFF (the user's ruling, and the one detail of it a
 *       refactor could quietly flip).
 *
 * WHY PARITY IS TESTED AGAINST THE STILL-PRESENT MODULES: plugins/progress_bar.js,
 * donut.js, clock_digital.js and clock_analog.js are OFF the roster (plugins/index.js
 * no longer imports them) but still on disk. That is deliberate for exactly this
 * test's sake — a parity test needs both sides. They are dead weight the moment this
 * suite stops needing them, and this comment is the record of why they may be deleted
 * (delete this test's parity half at the same time, or it silently degrades into
 * comparing the asset against itself).
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerPlugins, builtinRoster } from "../plugins/index.js";
import {
  BUILTIN_PLUGIN_ASSET_NAMES,
  BUILTIN_PLUGIN_ASSET_TYPES,
  BUILTIN_PLUGIN_ASSET_KINDS,
  builtinPluginAssetSources,
  registerBuiltinPluginAssets,
} from "../core/builtin_plugin_assets.js";
import { assetDropKind } from "../web/pluginAssetLoader.js";
import { materialIds } from "../render_gpu/skia/materials.js";
import { libraryTotalsLine } from "../web/assetRef.js";
import { humanReadableFileSize } from "../web/fileSize.js";
import {
  PLUGIN_WIDGETS_SUBMENU,
  builtinAssetCommands,
  pluginWidgetCommand,
  refreshPluginWidgetCommands,
} from "../plugins/builtin_asset_commands.js";
import { browserSetting } from "../web/settings.js";

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// ── (2) THE ROSTER ───────────────────────────────────────────────────────────

test("the library registers all five widgets AND the glass material, with NO reports", () => {
  const { loaded, types, reports } = registerBuiltinPluginAssets(createRegistry());
  assert.deepEqual(reports, [], "a clean library must produce no refusals and no drift");
  // `glass` is a MATERIAL, not a widget — it registers through the SAME loader and
  // the SAME jail, and the kind-dispatch table (core/plugin_assets.js) is what sends
  // it to the material registry instead of the widget one. Its presence in this list
  // is the proof that a second plugin kind rides the existing library path.
  assert.deepEqual(loaded, ["clock_analog", "clock_digital", "donut", "glass", "number", "progress_bar"]);
  assert.equal(Object.keys(types).length, 6);
});

test("BUILTIN_PLUGIN_ASSET_TYPES equals the map registration actually produces", () => {
  // The declared table is what the canvas DROP path reads synchronously (a type name
  // lives in the source, so reading it for real means evaluating the jail). Declared
  // is only safe if it cannot drift — this is the assertion that makes it so.
  const { types } = registerBuiltinPluginAssets(createRegistry());
  assert.deepEqual({ ...BUILTIN_PLUGIN_ASSET_TYPES }, types,
    "the declared file→type table disagrees with what the library registered — update core/builtin_plugin_assets.js BUILTIN_PLUGIN_ASSET_TYPES");
});

test("the enumeration, the sources and the type table all name the same files", () => {
  const { sources, reports } = builtinPluginAssetSources();
  assert.deepEqual(reports, [], "library drift");
  assert.deepEqual(sources.map((s) => s.name), [...BUILTIN_PLUGIN_ASSET_NAMES]);
  assert.deepEqual(Object.keys(BUILTIN_PLUGIN_ASSET_TYPES).sort(), [...BUILTIN_PLUGIN_ASSET_NAMES].sort());
  for (const { source } of sources)
    assert.ok(source.includes("return {"), "a plugin-asset source is a function BODY and must return its plugin");
});

test("BARE NODE reads the library off disk — the mode cli/render.js runs in", () => {
  // This suite IS bare node, so reaching the sources at all exercises the disk
  // reader (libraryFromDisk). Asserted explicitly because the failure mode is a
  // silently EMPTY roster: cli/render.js would then draw a hole where a donut is
  // and exit 0, which is the exact defect class the CLI renderer's loud omission
  // reporting exists to prevent.
  assert.ok(typeof process !== "undefined" && process.versions?.node, "this suite must be bare node for the assertion below to mean anything");
  const { sources } = builtinPluginAssetSources();
  assert.equal(sources.length, BUILTIN_PLUGIN_ASSET_NAMES.length, "bare node must read every library file off disk");
  assert.equal(sources.length, 6, "five widgets + the glass material");
});

test("the built-in library WIDGETS are on the FULL roster (builtinRoster), not allPlugins", () => {
  const types = new Set(builtinRoster().map((p) => p.type));
  for (const [file, name] of Object.entries(BUILTIN_PLUGIN_ASSET_TYPES)) {
    // A MATERIAL is not on the widget roster by construction — it registers into the
    // material registry, and builtinRoster() enumerates widgets. Skipping it here is
    // the point of BUILTIN_PLUGIN_ASSET_KINDS: the two kinds live in two registries,
    // and asserting a material onto the widget roster would be asserting the bug.
    if (BUILTIN_PLUGIN_ASSET_KINDS[file] === "material") {
      assert.ok(materialIds().includes(name), `${name} is the library's material but is not in the material registry`);
      assert.ok(!types.has(name), `${name} is a MATERIAL and must not be on the widget roster`);
      continue;
    }
    assert.ok(types.has(name), `${name} ships with the app but is not on builtinRoster()`);
  }
});

test("BUILTIN_PLUGIN_ASSET_KINDS names exactly the non-widget library files", () => {
  // The kind table, like the type table, is DECLARED and must not drift: a consumer
  // that must not treat a material as a widget (the canvas drop path) reads it
  // synchronously, without evaluating anything.
  for (const [file, kind] of Object.entries(BUILTIN_PLUGIN_ASSET_KINDS)) {
    assert.ok(BUILTIN_PLUGIN_ASSET_NAMES.includes(file), `${file} is in the kind table but not in the library`);
    assert.notEqual(kind, "widget", "only NON-widget files are listed; widget is the default");
  }
  const declaredMaterials = Object.keys(BUILTIN_PLUGIN_ASSET_KINDS).filter((f) => BUILTIN_PLUGIN_ASSET_KINDS[f] === "material");
  assert.deepEqual(declaredMaterials, ["liquid_glass.material.plugin.js"]);
});

// ── (1) MIGRATION PARITY ─────────────────────────────────────────────────────

/** The migrated widgets whose retired source module is still on disk to compare
 *  against. `number` is absent: its module was removed outright, so there is no
 *  second side to compare and its behaviour is covered by the sweeps.
 *
 *  `progress_bar` HAS LEFT THIS LIST, and the reason is the whole point of the
 *  list rather than an exception to it. This gate asks "did the migration change
 *  the picture BY ACCIDENT", so a widget belongs here exactly as long as the
 *  retired module is still the reference for what the picture should be. The
 *  progress bar's fill was DELIBERATELY redrawn afterwards, on a user report: it
 *  used to be a second rounded rect, which at low progress read as a detached pill
 *  that ignored the track's corners and painted outside them, and it is now the
 *  intersection of the progress rect with the track's rounded rim (an ir.path),
 *  emitting NO fill op at all at fraction 0. So the retired module is now the
 *  thing carrying the defect, and pinning the asset to it would pin the bug.
 *  Its behaviour is covered instead — and far more thoroughly than parity ever
 *  could — by tests/progress_bar_plugin_test.mjs (geometry containment, cap
 *  hugging, the zero case, the handle) and tests/progress_bar_handle_probe.js.
 *  A widget may leave this list ONLY with that kind of replacement in hand.
 *
 *  `clock_analog` HAS LEFT THIS LIST, for exactly the reason stated above and by
 *  the same rule the progress bar left it. The dial was DELIBERATELY extended on a
 *  user request ("more handles and more options for the clock"): it gained tick
 *  thickness/length rows, a minute-tick toggle, a numeral inset, arabic|roman|none
 *  numerals, second-hand taper, hour/minute bezel and a PRESET model, plus winding
 *  drag handles on all three hand tips. Those are new default KEYS, so the
 *  interface-parity assertion below necessarily fails against the retired module —
 *  it is measuring an interface the widget has outgrown on purpose, not a
 *  migration accident.
 *
 *  Note precisely WHICH half broke, because it is the whole argument: the PICTURE
 *  half did not. Every style row defaults to an INHERIT sentinel that resolves to
 *  the frozen `classic` values, so emit() at all-defaults is still byte-identical
 *  to the retired module's — verified over 240 state combinations against git HEAD
 *  rather than against a self-regenerated baseline.
 *
 *  Its replacement coverage, which is what earns the removal:
 *  tests/clock_analog_test.js (the byte-identical gate frozen as DATA, the preset
 *  model, every new row reaching the display list, the roman IIII table, the
 *  retired `showNumerals` migration, and the winding arithmetic driven through
 *  core/derive.js modifierWrite) and tests/clock_wind_probe.js (the same winding
 *  through REAL puppeteer mouse events, asserting the minute carry and the
 *  no-snap-at-wrap property the node test cannot reach). */
const PARITY = [
  ["donut", "../plugins/donut.js", "donutPlugin"],
  ["clock_digital", "../plugins/clock_digital.js", "clockDigitalPlugin"],
];

// The fixed states every migrated widget is compared on. Deliberately NOT just the
// defaults: a migration that hard-coded a value would pass on defaults alone, so
// each widget is also driven at a different size and a different parameter value.
const PARITY_STATES = [
  {},
  { w: 300, h: 40 },
  { w: 120, h: 120, rotation: 30, scale: 1.5 },
];

const registry = createRegistry();
registerPlugins(registry);

/** Query. A migrated widget's ASSET-side plugin, as the app registered it. */
function assetPlugin(type) {
  return registry.get(type);
}

test(`MIGRATION PARITY: emit() is identical to the retired module's, over ${PARITY.length} widgets × ${PARITY_STATES.length} states`, async () => {
  let compared = 0;
  for (const [type, modulePath, exportName] of PARITY) {
    const mod = await import(modulePath);
    const before = mod[exportName];
    const after = assetPlugin(type);
    assert.ok(before, `${modulePath} no longer exports ${exportName} — see this file's header before deleting the parity half`);
    for (const overrides of PARITY_STATES) {
      const world = { x: 0, y: 0, rotation: 0, scale: 1 };
      // BOTH SIDES ARE DRIVEN FROM THE MODULE'S DEFAULTS, which isolates the
      // FUNCTION from the DATA: given identical input the two emits must paint
      // identically, so a difference here is a changed drawing routine and nothing
      // else. (A changed DEFAULT is invisible to this check by construction — it is
      // caught by the defaults assertion in the next test, which is why both exist.
      // Verified by mutation: changing the asset's `inner` default fails that test
      // and not this one.)
      const state = { ...before.defaults, ...overrides };
      const a = JSON.stringify(before.emit(state, null, world));
      const b = JSON.stringify(after.emit(state, null, world));
      assert.equal(b, a, `${type}: the plugin ASSET's emit() differs from the retired module's on ${JSON.stringify(overrides)}`);
      // AND each side from ITS OWN defaults, which is what a user actually gets when
      // they insert the widget. This is the composition of the two properties above,
      // and it fails if EITHER the routine or the data drifted — so it is the check
      // that cannot be satisfied by a migration that moved the difference around.
      const ownA = JSON.stringify(before.emit({ ...before.defaults, ...overrides }, null, world));
      const ownB = JSON.stringify(after.emit({ ...after.defaults, ...overrides }, null, world));
      assert.equal(ownB, ownA, `${type}: inserting the widget paints differently after the migration (its own defaults + ${JSON.stringify(overrides)})`);
      compared += 1;
    }
  }
  assert.equal(compared, PARITY.length * PARITY_STATES.length);
});

test("MIGRATION PARITY: defaults and inspector KEYS survived the move", () => {
  // emit() equality above compares PICTURES. These two compare the widget's
  // INTERFACE — a dropped inspector row or a renamed default key does not change the
  // default rendering at all, so the parity test above cannot see it.
  return Promise.all(PARITY.map(async ([type, modulePath, exportName]) => {
    const before = (await import(modulePath))[exportName];
    const after = assetPlugin(type);
    assert.deepEqual({ ...after.defaults }, { ...before.defaults }, `${type}: defaults changed in the migration`);
    const keysOf = (p) => (p.inspector ?? []).map((r) => r.key ?? r.kind).sort();
    // The REGISTERED form has the universal effects bundle injected into both sides
    // equally (registry.register does it), so comparing registered-vs-authored would
    // show a spurious difference. The module side is put through the same registry.
    const reg2 = createRegistry();
    reg2.register(before);
    assert.deepEqual(keysOf(after), keysOf(reg2.get(type)), `${type}: inspector rows changed in the migration`);
  }));
});

// ── (3) THE DROP CLASSIFIER ──────────────────────────────────────────────────

test("assetDropKind: a *.plugin.js asset is a WIDGET drop", () => {
  assert.equal(assetDropKind({ name: "gear.plugin.js", kind: "plugin" }), "widget");
  // The SUFFIX decides, not the listing's `kind` — the suffix is what the loader
  // itself keys off, so a listing whose kind disagrees must still route as a widget.
  assert.equal(assetDropKind({ name: "donut.plugin.js", kind: "other" }), "widget");
  for (const name of BUILTIN_PLUGIN_ASSET_NAMES)
    assert.equal(assetDropKind({ name, kind: "plugin" }), "widget", `${name} must be droppable as a widget`);
});

test("assetDropKind: media stays media, and everything else REPORTS", () => {
  assert.equal(assetDropKind({ name: "logo.png", kind: "image" }), "media");
  assert.equal(assetDropKind({ name: "clip.mp4", kind: "video" }), "media");
  assert.equal(assetDropKind({ name: "notes.txt", kind: "other" }), "none");
  assert.equal(assetDropKind({ name: "beep.wav", kind: "sound" }), "none");
  assert.equal(assetDropKind({}), "none");
  assert.equal(assetDropKind(null), "none");
  // A BARE .js is NOT a plugin asset (the compound suffix is the rule), so it must
  // not be instantiated as a widget.
  assert.equal(assetDropKind({ name: "notes.js", kind: "other" }), "none");
});

// ── (4) TOTALS LINE + TOGGLE DEFAULT ─────────────────────────────────────────

test("the totals line formats through fileSize.js and never prints raw bytes", () => {
  assert.equal(libraryTotalsLine([{ size: 1024 }, { size: 2048 }], humanReadableFileSize), "2 assets · 3KB");
  assert.equal(libraryTotalsLine([{ size: 10000000 }], humanReadableFileSize), "1 asset · 9.5MB");
  assert.equal(libraryTotalsLine([], humanReadableFileSize), null, "an empty list has nothing to total");
  assert.equal(libraryTotalsLine(null, humanReadableFileSize), null);
  // Singular vs plural, because "1 assets" is the kind of thing that ships.
  assert.ok(libraryTotalsLine([{ size: 1 }], humanReadableFileSize).startsWith("1 asset ·"));
  // A SIZELESS entry contributes 0, never NaN — one undefined in the sum would turn
  // the whole line into "NaN" and take the count down with it.
  const mixed = libraryTotalsLine([{ size: 1024 }, { name: "x.plugin.js" }], humanReadableFileSize);
  assert.equal(mixed, "2 assets · 1KB");
  assert.ok(!/NaN/.test(mixed));
});

test("BUILT-IN ASSETS DEFAULT TO HIDDEN (user ruling), and persist once set", () => {
  // The ruling is explicit: "maybe the asset explorer could have a toggle for
  // built-in assets. By default it's turned off". Pinned because a default is one
  // character to flip and nothing else would notice.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const KEY = "powerrp.showBuiltinAssets";
    assert.equal(browserSetting(KEY, false).initial, false, "the toggle must default to OFF when unset");
    // Turning it on persists as "on" and reads back true on the next construction.
    assert.equal(browserSetting(KEY, false).persist(true), true);
    assert.equal(store.get(KEY), "on");
    assert.equal(browserSetting(KEY, false).initial, true, "an explicit ON must survive a reload");
    // And back off again — an explicit OFF is stored, not merely absent.
    browserSetting(KEY, false).persist(false);
    assert.equal(store.get(KEY), "off");
    assert.equal(browserSetting(KEY, false).initial, false);
  } finally {
    delete globalThis.localStorage;
  }
});

// ── (5) PALETTE SURFACING ────────────────────────────────────────────────────

test('every loaded plugin-asset widget surfaces as "Plugin: <name>"', () => {
  const cmd = pluginWidgetCommand({ type: "gear", title: "Gear" });
  assert.equal(cmd.title, "Plugin: Gear", "the user's ruling names this format exactly");
  assert.equal(cmd.id, "add-plugin-gear");
  assert.ok(!("help" in cmd), "a plugin with no help must not get a placeholder one");
  // A plugin's OWN help text is carried when it declares one.
  assert.equal(pluginWidgetCommand({ type: "sq", title: "Squircle", help: "A rounded superellipse." }).help, "A rounded superellipse.");
  // A plugin with no title falls back to its type rather than "Plugin: undefined".
  assert.equal(pluginWidgetCommand({ type: "gear" }).title, "Plugin: gear");
});

test("the plugin-widget submenu is ONE stable entry whose children are replaceable", () => {
  // The command registry has no `remove` (commands are process-lifetime — that is
  // what fixed the duplicate-id crash on a second project open), so per-project
  // entries have to be submenu CHILDREN. This pins both halves of that: the entry is
  // registered once, and refreshing genuinely changes what the palette would show.
  assert.ok(builtinAssetCommands.includes(PLUGIN_WIDGETS_SUBMENU), "the submenu must be registered with the other built-in asset commands");
  assert.ok(Array.isArray(PLUGIN_WIDGETS_SUBMENU.children), "children is what makes this a submenu (run XOR children)");
  const before = PLUGIN_WIDGETS_SUBMENU.children;
  assert.equal(refreshPluginWidgetCommands([{ type: "gear", title: "Gear" }, { type: "sq", title: "Squircle" }]), 2);
  assert.deepEqual(PLUGIN_WIDGETS_SUBMENU.children.map((c) => c.title), ["Plugin: Gear", "Plugin: Squircle"]);
  // MUTATED IN PLACE, not reassigned: the registry holds a reference to this exact
  // array, so a reassignment would leave the palette reading the original forever —
  // a failure that looks like "the feature does nothing" rather than an error.
  assert.equal(PLUGIN_WIDGETS_SUBMENU.children, before, "children must be the SAME array object (spliced, never reassigned)");
  // A project switch to one with no plugin assets EMPTIES it (the entries go away).
  assert.equal(refreshPluginWidgetCommands([]), 0);
  assert.deepEqual(PLUGIN_WIDGETS_SUBMENU.children, []);
  assert.equal(PLUGIN_WIDGETS_SUBMENU.children, before);
});

test("the three named migrated add-commands kept their EXACT ids", () => {
  // tests/modifier_probe.js and tests/multiresize_place_probe.js drive these by id,
  // and a user keybinding may hold one. Including add-clock_analog's underscore,
  // which is inconsistent with add-clock-digital but is what already exists.
  const ids = builtinAssetCommands.map((c) => c.id);
  for (const id of ["add-donut", "add-clock-digital", "add-clock_analog"])
    assert.ok(ids.includes(id), `${id} is referenced by the browser probes and must keep its id`);
});

console.log(`\nbuiltin_asset_library_test: ${passed} tests passed`);
