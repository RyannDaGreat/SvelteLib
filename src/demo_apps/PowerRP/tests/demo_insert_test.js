/**
 * THE DEMO SUBMENUS AND THE ONE INSERT (manifest R7-18) — plain node.
 * Run: node src/demo_apps/PowerRP/tests/demo_insert_test.js
 *
 * WHAT IS PINNED HERE, and why each one is a LAW rather than a behaviour:
 *   - ONE MECHANISM. A demo patch and a demo preset are both TEMPLATES stamped by
 *     `insertDemoTemplate`. Two inserts doing one job is the thing R7-18 removed,
 *     so a second one reappearing must fail rather than be noticed by a reviewer.
 *   - THE SECTIONS ARE THE ONLY GROUPING. Every template belongs to exactly one
 *     DEMO_SECTIONS row, and a templated section's children are GENERATED from the
 *     roster — so authoring patch #51 is one record and nothing else.
 *   - THE DIRECTORY GATE, which is the whole reason this file exists. "Add Demo
 *     Widget" is a submenu whose membership is a DIRECTORY, and a directory cannot
 *     be derived from a plugin object. So the disk is read here: every module in
 *     plugins/demo/ must be in `demoPlugins`, and every type in `demoPlugins` must
 *     appear in the submenu written in web/App.svelte. It caught
 *     `demo_video_time_scrub` — shipped, and in no menu at all — on its first run.
 *   - EVERY INSERTABLE IS REACHABLE. No JSON-only anything: a user who never opens
 *     a file can insert every patch, preset and demo widget the app ships.
 *
 * WHY THE WIDGET GATE READS SOURCE TEXT. The children are declared inside a
 * `.svelte` file, which bare node cannot import, and the alternative — a browser
 * probe — would put a directory-coverage check behind a Chrome that may not be able
 * to screenshot. Source-text assertion is precedented here for exactly this reason
 * (tests/shape_legacy_freeze_test.js asserts on App.svelte's text), and the string
 * being searched for is the widget TYPE, which is the same token the `run` closure
 * must name to insert it.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRegistry } from "../core/registry.js";
import { demoPlugins, registerPlugins } from "../plugins/index.js";
import { DEMO_PATCHES } from "../core/audio_patches.js";
import { DEMO_PRESETS } from "../plugins/demo_presets.js";
import { DEMO_SECTIONS, DEMO_TEMPLATES, demoInsertMenus, demoSectionChildren } from "../web/demoInsert.js";
import { createCommands } from "../core/commands.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerPlugins(registry);

/** A stand-in for the widget section's children — enough to satisfy
 *  `demoInsertMenus`, which refuses a section that opens onto nothing. */
const STUB_WIDGET_CHILDREN = [{ id: "demo-insert-stub", title: "Stub", run: () => {} }];

/** A MEMOIZING stub minter, which is not a detail: `buildPatchItems` asks for a
 *  name once per reference to it, so a minter that answered differently each time
 *  would make every wire target a node that does not exist. */
function memoIdFor(prefix) {
  const minted = new Map();
  return (name) => {
    if (!minted.has(name)) minted.set(name, `${prefix}-${name}`);
    return minted.get(name);
  };
}

await test("ONE MECHANISM — every template is stamped by insertDemoTemplate, patches and presets alike", () => {
  assert.equal(
    DEMO_TEMPLATES.length,
    DEMO_PATCHES.length + DEMO_PRESETS.length,
    "the roster is derived from both blueprint arrays; a mismatch means one of them stopped feeding it"
  );
  // A template's ONLY behavioural surface is `build`. If a record ever grows its own
  // `run` or `insert`, that is a second insert path being reintroduced.
  for (const t of DEMO_TEMPLATES) {
    assert.equal(typeof t.build, "function", `${t.id}: a template stamps through build(app, idFor)`);
    assert.equal(t.run, undefined, `${t.id}: a template must not carry its own run — insertDemoTemplate is the one path`);
  }
});

await test("a patch GROUPS and a preset does not — the one place the two kinds differ in behaviour", () => {
  const patch = DEMO_TEMPLATES.find((t) => t.section === "patch");
  const preset = DEMO_TEMPLATES.find((t) => t.section === "preset");
  // A fake app: build() reads only these four things off it. `slideW/slideH` are
  // what cameraRect falls back to when a state carries no camera item, which is the
  // shape of an empty state — a bare `{width, height}` gets a degenerate 0×0 view
  // and a report, so the key names are load-bearing here.
  const fake = {
    registry,
    doc: { meta: { slideW: 1280, slideH: 720 } },
    state: () => ({ items: {}, vars: {} }),
    nodes: () => [],
  };
  const built = patch.build(fake, memoIdFor("a"));
  assert.ok(built.group, "a patch declares the group it arrives in (user ADDENDUM 10)");
  assert.equal(built.group.name, patch.title);
  assert.ok(built.group.bounds.w > 0 && built.group.bounds.h > 0, "the group's bbox is the patch's own bounds");
  assert.equal(preset.build(fake, memoIdFor("b")).group, undefined, "a preset arrives as loose widgets");
});

await test("THE SECTIONS ARE THE ONLY GROUPING — one section per template, children generated for a templated one", () => {
  const ids = new Set(DEMO_SECTIONS.map((s) => s.id));
  for (const t of DEMO_TEMPLATES) assert.ok(ids.has(t.section), `${t.id} claims section "${t.section}", which is not in DEMO_SECTIONS`);
  for (const s of DEMO_SECTIONS.filter((s) => s.templated))
    assert.deepEqual(
      demoSectionChildren(s.id).map((c) => c.id),
      DEMO_TEMPLATES.filter((t) => t.section === s.id).map((t) => t.id),
      `section "${s.id}": its children are generated from the roster, so these cannot disagree unless a hand-written list replaced the generation`
    );
  // The patch section's children are the patch roster, in roster order — stated
  // explicitly because this is the sentence R7-18 asked for.
  assert.deepEqual(demoSectionChildren("patch").map((c) => c.id), DEMO_PATCHES.map((p) => `demo-patch-${p.id}`));
});

await test("the submenus are well-formed registry containers — run XOR children, no duplicate ids anywhere", () => {
  const menus = demoInsertMenus({ widget: STUB_WIDGET_CHILDREN });
  assert.deepEqual(menus.map((m) => m.id), DEMO_SECTIONS.map((s) => s.commandId));
  const seen = new Set();
  for (const menu of menus) {
    assert.equal(menu.run, undefined, `${menu.id}: core/commands.js enforces run XOR children`);
    assert.ok(menu.children.length > 0, `${menu.id}: a container with no children is a dead end`);
    assert.ok(menu.icon && menu.help, `${menu.id}: a submenu says what it holds`);
    for (const id of [menu.id, ...menu.children.map((c) => c.id)]) {
      assert.ok(!seen.has(id), `duplicate command id "${id}" — the registry throws on this at boot`);
      seen.add(id);
    }
  }
});

await test("a section that opens onto nothing is REFUSED, loudly", () => {
  assert.throws(() => demoInsertMenus({}), /section "widget" has no children/);
});

await test("THE DIRECTORY GATE — plugins/demo/ and `demoPlugins` cannot disagree", async () => {
  const files = (await readdir(resolve(app, "plugins/demo"))).filter((f) => f.endsWith(".js")).sort();
  const onDisk = new Set();
  for (const file of files) {
    const mod = await import(`../plugins/demo/${file}`);
    // A module exports its plugin(s) as objects with a `type`, singly or in a family
    // array (skyPlugins, textMorphPlugins, …). Both shapes are flattened the same way.
    for (const value of Object.values(mod))
      for (const plugin of Array.isArray(value) ? value : [value])
        if (plugin && typeof plugin === "object" && typeof plugin.type === "string") onDisk.add(plugin.type);
  }
  const declared = new Set(demoPlugins.map((p) => p.type));
  for (const type of onDisk)
    assert.ok(declared.has(type), `plugins/demo/ ships "${type}" but plugins/index.js's demoPlugins does not list it — the roster and the directory have drifted`);
  for (const type of declared)
    assert.ok(onDisk.has(type), `demoPlugins lists "${type}" but no module in plugins/demo/ exports it`);
  assert.ok(onDisk.size >= files.length, `${files.length} modules yielded only ${onDisk.size} types — a file exporting no plugin is not what this directory is for`);
});

await test("EVERY DEMO WIDGET IS REACHABLE — the Add Demo Widget submenu covers plugins/demo/", async () => {
  const src = await readFile(resolve(app, "web/App.svelte"), "utf8");
  const open = src.indexOf("...demoInsertMenus({");
  assert.ok(open > 0, "web/App.svelte builds the demo submenus through demoInsertMenus — if it stopped, this gate is measuring nothing");
  const block = src.slice(open, src.indexOf("// INSERT SHAPE", open));
  for (const plugin of demoPlugins)
    assert.ok(
      block.includes(`"${plugin.type}"`),
      `plugins/demo/ ships "${plugin.type}" and no entry in the Add Demo Widget submenu inserts it — a widget nobody can reach. Add a child in web/App.svelte.`
    );
});

await test("NO JSON-ONLY INSERTABLE — every patch and preset in the data has a menu entry", () => {
  const reachable = new Set(demoInsertMenus({ widget: STUB_WIDGET_CHILDREN }).flatMap((m) => m.children.map((c) => c.id)));
  for (const patch of DEMO_PATCHES) assert.ok(reachable.has(`demo-patch-${patch.id}`), `demo patch "${patch.id}" is in the data and in no menu`);
  for (const preset of DEMO_PRESETS) assert.ok(reachable.has(`demo-preset-${preset.id}`), `demo preset "${preset.id}" is in the data and in no menu`);
});

await test("the command ids are UNCHANGED by the move into submenus — probes and scripts name them", () => {
  const ids = DEMO_TEMPLATES.map((t) => t.id);
  assert.ok(ids.includes("demo-patch-whoosh"), "tests/audio_mirror_probe.js inserts this one by id");
  assert.ok(ids.includes("demo-preset-double-pendulum"), "tests/demo_presets_probe.js runs this one by id");
});

await test("a TOP-LEVEL palette query finds a submenu child — being in a menu is not being hidden", () => {
  // USER, 2026-08-06: "I don't see the pendulum widget in the command palette."
  //
  // It was registered the whole time. `search()` pooled `topLevel` flat, so a child was
  // reachable ONLY by knowing which submenu it lived in and drilling in first — and R7-18
  // had just moved 27 audio patches and 3 presets behind submenus. Measured before the
  // fix: "pendulum", "shimmer" and "incanta" all returned NOTHING. A palette whose promise
  // is "type the name of the thing" cannot answer nothing for a command it has registered.
  const commands = createCommands();
  for (const menu of demoInsertMenus({ widget: STUB_WIDGET_CHILDREN })) commands.add(menu);

  const found = (q) => commands.search(q).map((c) => c.id);
  assert.ok(found("pendulum").includes("demo-preset-double-pendulum"), "the reported case");
  assert.ok(found("shimmer").includes("demo-patch-axo-shimmer"), "and an audio patch, which is the same defect at 27x");

  // THE OTHER HALF, and it is the half a careless "just flatten it" would break: an EMPTY
  // top-level query still opens onto the top-level MRU. Flattening there would greet the
  // author with thirty demo rows in front of the commands they actually use.
  const opening = commands.search("");
  assert.deepEqual(opening.map((c) => c.id), demoInsertMenus({ widget: STUB_WIDGET_CHILDREN }).map((m) => m.id),
    "an empty query must not flatten — it shows the submenus themselves");

  // And a DRILLED-IN search stays scoped to that submenu, which is what the pool rule was
  // written for in the first place and is not what was wrong.
  const presets = commands.search("").find((c) => c.id === "demo-insert-preset-menu") ?? commands.search("preset")[0];
  assert.ok(presets?.children, "the preset submenu is a submenu");
  assert.deepEqual(commands.search("whoosh", presets).map((c) => c.id), [],
    "an audio patch must NOT be findable from inside the presets submenu");
});

console.log(`\n${passed} demo insert tests passed`);
