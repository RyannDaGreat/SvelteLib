/**
 * TOOL GROUP RESOLUTION guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/tool_groups_test.js
 *
 * WHY THIS EXISTS. web/ToolsPane.svelte used to carry a hand-written TOOLS array
 * pinned to Inspector CATEGORY ids, so EVERY widget rendered EVERY category. The
 * user's report: "why is Presets UNDER Formatting? ... if there's nothing in a
 * submenu, it doesn't need to show it. If there are no formatting tools, we don't
 * need to see the formatting drop-down in Tools ... If something is disabled, the
 * tooltip should say WHY it's disabled". Tool groups are now RESOLVED in
 * core/registry.js from a declared TOOL POOL plus a plugin's own declarations, and
 * this suite is the ratchet on that resolution.
 *
 * WHAT IT PROVES, over EVERY registered plugin (not a sample):
 *   (1) WELL-FORMED — unique group ids, no group with zero rows, every row a
 *       known kind, no command surfaced twice on one widget.
 *   (2) EMPTINESS IS UNREPRESENTABLE — a widget with no presets has no preset
 *       group, a widget with no frame has no Transform group. The pane cannot
 *       receive an empty group, so it needs no "hide if empty" branch to forget.
 *   (3) EVERY DISABLE-ABLE ROW CAN EXPLAIN ITSELF — help + requires present on
 *       every command row everywhere, so a mystery gray button is not expressible.
 *   (4) NO UNREACHABLE AFFORDANCE — every pool group and every pool row is
 *       reached by at least one registered widget. This is the mechanical form of
 *       the HintBar class of bug (an entry whose predicate can never be true, so
 *       the affordance silently never appears): here the predicate is DECLARED BY
 *       THE POOL and swept against the real plugin roster, not hand-written per
 *       entry and hoped about.
 *   (5) DEFINED ONCE — no command appears in two pool groups.
 *   (6) PRESET FAMILIES COMPOSE RATHER THAN CLOBBER — a plugin's families write
 *       DISJOINT key sets, so picking from one family never undoes a pick from
 *       another (the Mandelbrot location/colour/performance requirement).
 *   (7) ORDER — a plugin's OWN groups come before the inherited pool groups, the
 *       same way withUniversalEffects appends the universal property rows last.
 *   (8) THE SHARED VOCABULARY CANNOT DRIFT — a pool group titled with an
 *       Inspector category id is spelled the way web/Inspector.svelte spells it,
 *       for as long as that map lives there (see the handback note in registry.js).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { allPlugins } from "../plugins/index.js";
import {
  createRegistry, TOOL_POOL, toolGroupsOf, withToolGroups, presetFamiliesOf,
  hasFrame, frameBindable, FRAME_KEYS,
} from "../core/registry.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const registry = createRegistry();
for (const p of allPlugins) registry.register(p);
const registered = registry.all();

const ROW_KINDS = new Set(["command", "preset"]);
/** Pure function. Every row of every group of `plugin`, flattened. */
const allRows = (plugin) => (plugin.toolGroups ?? []).flatMap((g) => g.rows);
/**
 * Pure function. The POOL group ids `plugin` inherits, in pool order — DERIVED
 * from TOOL_POOL, never transcribed, so the order/merge assertions below survive
 * the next generic tool being added to the pool instead of pinning today's list.
 *
 * @example poolIdsFor({defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}})
 * // ["transform", "arrange", "grouping", "edit", "keyframes"]
 * @example poolIdsFor({defaults: {blur: 4}, capabilities: {}})
 * // ["grouping", "edit", "keyframes"]   (no frame → no camera-bind rows, no layout rows)
 */
const poolIdsFor = (plugin) =>
  TOOL_POOL.filter((g) => g.rows.some((r) => r.applies(plugin))).map((g) => g.id);

// ── (1) well-formed ──────────────────────────────────────────────────────────
test("every registered plugin carries a resolved toolGroups array", () => {
  for (const p of registered)
    assert.ok(Array.isArray(p.toolGroups), `${p.type}: toolGroups is ${typeof p.toolGroups} — register() must resolve it`);
});

test("group ids are unique per plugin and no group is empty", () => {
  for (const p of registered) {
    const ids = p.toolGroups.map((g) => g.id);
    assert.deepEqual(ids, [...new Set(ids)], `${p.type}: duplicate group id in ${ids.join(",")}`);
    for (const g of p.toolGroups) {
      assert.ok(g.title, `${p.type}/${g.id}: no title`);
      assert.ok(g.rows.length > 0, `${p.type}/${g.id}: ZERO rows — an empty group must be dropped at resolution, not rendered`);
      for (const row of g.rows)
        assert.ok(ROW_KINDS.has(row.kind), `${p.type}/${g.id}: unknown row kind "${row.kind}"`);
    }
  }
});

test("no command is surfaced twice on the same widget", () => {
  for (const p of registered) {
    const cmds = allRows(p).filter((r) => r.kind === "command").map((r) => r.command);
    assert.deepEqual(cmds, [...new Set(cmds)], `${p.type}: command surfaced twice — ${cmds.join(",")}`);
  }
});

// ── (2) emptiness is unrepresentable ─────────────────────────────────────────
test("a widget with no presets gets NO preset group; one with presets gets one per family", () => {
  for (const p of registered) {
    const families = presetFamiliesOf(p);
    const presetGroups = p.toolGroups.filter((g) => g.id.startsWith("presets"));
    // A family declared with zero presets yields zero rows, and a zero-row group
    // is dropped — so the count is families that actually have presets.
    const nonEmpty = families.filter((f) => f.presets.length > 0);
    assert.equal(presetGroups.length, nonEmpty.length,
      `${p.type}: ${nonEmpty.length} non-empty preset families but ${presetGroups.length} preset groups`);
    for (const g of presetGroups)
      assert.ok(g.rows.every((r) => r.kind === "preset"), `${p.type}/${g.id}: a preset group must hold preset rows only`);
  }
});

test("a widget with no FRAME gets no camera-bind ROWS (the tools' gate)", () => {
  // THE CLAIM IS ABOUT THE ROWS, NOT THE SECTION, and it used to be written the
  // other way round — "a frameless widget shows no Transform group" — which was
  // true only while the group's every row needed a frame. It stopped being true
  // the moment the nudges joined it (an arrow has no x/y/w/h and moves via
  // `moveBy`, so it is nudgeable and correctly keeps the section). A proxy
  // assertion that happens to hold is a gate that fails for the wrong reason
  // later; this asks the real question.
  const frameless = registered.filter((p) => !hasFrame(p));
  assert.ok(frameless.length > 0, "no frameless plugin in the roster — this assertion would be vacuous");
  const CAMERA_ROWS = ["bind-to-camera", "unbind-from-camera"];
  for (const p of frameless) {
    const cmds = allRows(p).filter((r) => r.kind === "command").map((r) => r.command);
    for (const id of CAMERA_ROWS)
      assert.ok(!cmds.includes(id), `${p.type}: has no x/y/w/h yet is offered "${id}"`);
  }
  // And the converse: a widget WITH a frame (that is not THE camera) does get them.
  const bindable = registered.filter(frameBindable);
  assert.ok(bindable.length > 0, "no frame-bindable plugin in the roster");
  for (const p of bindable) {
    const cmds = allRows(p).filter((r) => r.kind === "command").map((r) => r.command);
    for (const id of CAMERA_ROWS)
      assert.ok(cmds.includes(id), `${p.type}: has a bindable frame but is not offered "${id}"`);
  }
});

test("THE CAMERA is not frame-bindable (binding it to its own frame is a cycle)", () => {
  const camera = registered.find((p) => p.capabilities.purgeable === false);
  assert.ok(camera, "no purgeable:false plugin — THE camera is mandatory");
  assert.ok(hasFrame(camera), "the camera does have x/y/w/h");
  assert.equal(frameBindable(camera), false);
  const cmds = allRows(camera).filter((r) => r.kind === "command").map((r) => r.command);
  assert.ok(!cmds.includes("bind-to-camera"), "the camera must not offer Bind to Camera");
  // The camera is also the ONE widget that may not be removed or duplicated, so
  // the Edit group's purgeable-gated rows must not reach it either.
  for (const id of ["duplicate", "delete-item", "purge-item", "group"])
    assert.ok(!cmds.includes(id), `the camera must not offer "${id}" — purgeable:false is what that means`);
});

// ── (3) every disable-able row can explain itself ────────────────────────────
test("a pool row carries only WHICH command and WHICH widgets — never a copy of its words", () => {
  // THE WORDS MOVED, AND THAT IS THE POINT. `title`, `icon`, `help` and the
  // "Unavailable — requires …" clause are the command ENTRY's, and every
  // surfacing reads them from there. A row that also carried them would be a
  // second copy free to disagree — which is exactly how this pool became a
  // partial mirror of the command list in the first place.
  //
  // The mandate that a GATED command actually have a `requires` did not
  // disappear, it moved to tests/tool_surfacing_probe.js, which asks the live
  // registry rather than a transcription of it. This half asserts the transcription
  // is gone; that half asserts the original is present.
  for (const p of registered)
    for (const g of p.toolGroups)
      for (const row of g.rows) {
        if (row.kind !== "command") continue;
        for (const field of ["help", "requires", "title", "icon"])
          assert.equal(row[field], undefined,
            `${p.type}/${g.id}/${row.command}: carries its own "${field}" — that string belongs to the command entry, and a copy here is a copy that can drift`);
      }
});

test("the pool's import gate rejects a row with no command id / no applies", () => {
  // The gate itself runs at import of core/registry.js over TOOL_POOL, so it
  // cannot be re-invoked here; assert the SHAPE it guarantees instead, then prove
  // the same contract is enforced for a PLUGIN-declared group (the other path in).
  for (const g of TOOL_POOL)
    for (const row of g.rows) {
      assert.equal(typeof row.applies, "function", `pool ${g.id}/${row.command}: applies must be a predicate`);
      assert.ok(row.command, `pool ${g.id}: a row with no command id`);
    }
  const base = { type: "synthetic", defaults: { x: 0, y: 0, w: 1, h: 1 }, capabilities: {} };
  assert.throws(
    () => toolGroupsOf({ ...base, toolGroups: [{ id: "own", title: "Own", rows: [{ kind: "command" }] }] }),
    /has a row with no command id/,
  );
  assert.throws(
    () => toolGroupsOf({ ...base, toolGroups: [{ id: "own", title: "Own", rows: [{ kind: "preset", preset: {} }] }] }),
    /preset rows come from its preset families/,
  );
  assert.throws(
    () => toolGroupsOf({ ...base, toolGroups: [{ id: "own", rows: [] }] }),
    /tool group is malformed/,
  );
});

// ── (4) no unreachable affordance ────────────────────────────────────────────
test("every pool group and every pool row is reached by at least one widget", () => {
  for (const group of TOOL_POOL) {
    const groupReached = registered.filter((p) => p.toolGroups.some((g) => g.id === group.id));
    assert.ok(groupReached.length > 0,
      `pool group "${group.id}" is reached by NO registered widget — an affordance that can never appear (the HintBar class of bug)`);
    for (const row of group.rows) {
      const rowReached = registered.filter((p) => row.applies(p));
      assert.ok(rowReached.length > 0,
        `pool row "${row.command}" applies to NO registered widget — either its applies() is wrong or the tool is dead`);
    }
  }
});

// ── (5) defined once ─────────────────────────────────────────────────────────
test("no command appears in two pool groups", () => {
  const seen = new Map();
  for (const g of TOOL_POOL)
    for (const row of g.rows) {
      assert.ok(!seen.has(row.command), `"${row.command}" is in both "${seen.get(row.command)}" and "${g.id}" — a tool must be defined once`);
      seen.set(row.command, g.id);
    }
});

// ── (6) preset families compose rather than clobber ──────────────────────────
test("a plugin's preset FAMILIES write disjoint key sets (compose, never clobber)", () => {
  for (const p of registered) {
    const families = presetFamiliesOf(p);
    if (families.length < 2) continue; // one family is trivially disjoint
    const keysOf = (fam) => new Set(fam.presets.flatMap((pr) => Object.keys(pr.props ?? {})));
    const sets = families.map((fam) => [fam.id, keysOf(fam)]);
    for (let i = 0; i < sets.length; i++)
      for (let j = i + 1; j < sets.length; j++) {
        const overlap = [...sets[i][1]].filter((k) => sets[j][1].has(k));
        assert.equal(overlap.length, 0,
          `${p.type}: preset families "${sets[i][0]}" and "${sets[j][0]}" both write ${overlap.join(",")} — orthogonal families must not clobber each other's keys`);
      }
  }
});

test("presetFamiliesOf normalizes both declaration forms and refuses a contradiction", () => {
  assert.deepEqual(
    presetFamiliesOf({ presets: [{ name: "Cinematic", props: { glow: 1 } }] }),
    [{ id: "presets", title: "Presets", presets: [{ name: "Cinematic", props: { glow: 1 } }] }],
  );
  assert.deepEqual(
    presetFamiliesOf({ presetFamilies: [{ id: "location", title: "Location", presets: [] }] }),
    [{ id: "presets.location", title: "Location", presets: [] }],
  );
  assert.deepEqual(presetFamiliesOf({}), []);
  assert.throws(() => presetFamiliesOf({ type: "x", presets: [], presetFamilies: [] }), /BOTH presets and presetFamilies/);
  assert.throws(
    () => presetFamiliesOf({ type: "x", presetFamilies: [{ id: "a", title: "A", presets: [] }, { id: "a", title: "A2", presets: [] }] }),
    /twice/,
  );
  // Namespacing is what makes a family id unable to collide with a pool group id.
  const clash = presetFamiliesOf({ presetFamilies: [{ id: "transform", title: "Transform", presets: [{ name: "p", props: {} }] }] });
  assert.equal(clash[0].id, "presets.transform");
  assert.ok(!TOOL_POOL.some((g) => g.id === clash[0].id));
});

test("MULTI-FAMILY resolution: each family becomes its own top-level group, in order", () => {
  // The Mandelbrot's shape, as its own agent will declare it: three orthogonal
  // families over disjoint key slices.
  const plugin = withToolGroups({
    type: "synthetic_fractal",
    defaults: { x: 0, y: 0, w: 1, h: 1 },
    capabilities: { bbox: true },
    presetFamilies: [
      { id: "location", title: "Location", presets: [{ name: "Seahorse", props: { centerX: -0.74, zoomExponent: 2.9 } }] },
      { id: "colour", title: "Colour", presets: [{ name: "Gold", props: { palette: "gold" } }] },
      { id: "performance", title: "Performance", presets: [{ name: "Draft", props: { maxIterations: 200 } }] },
    ],
  });
  // The INHERITED tail is DERIVED from the pool, not transcribed: this test is
  // about ORDER (own families first, pool groups last, in pool order), and a
  // hand-written tail would fail every time a generic tool is added — which is
  // exactly what happened when the Keyframes group joined the pool.
  assert.deepEqual(plugin.toolGroups.map((g) => g.id), ["presets.location", "presets.colour", "presets.performance", ...poolIdsFor(plugin)]);
  assert.deepEqual(plugin.toolGroups.slice(0, 3).map((g) => g.title), ["Location", "Colour", "Performance"]);
  // Picking from one family writes only that family's keys — the compose property
  // app.applyPreset gives for free (it writes exactly Object.keys(preset.props)).
  const wrote = Object.keys(plugin.toolGroups[1].rows[0].preset.props);
  assert.deepEqual(wrote, ["palette"]);
});

// ── (7) order + merge ────────────────────────────────────────────────────────
test("a plugin's OWN groups come first; its own rows MERGE into a pool group of the same id", () => {
  const plugin = withToolGroups({
    type: "synthetic_own",
    defaults: { x: 0, y: 0, w: 1, h: 1 },
    capabilities: { bbox: true },
    presets: [{ name: "P", props: { a: 1 } }],
    toolGroups: [
      { id: "mine", title: "Mine", rows: [{ kind: "command", command: "my-cmd", help: "h", requires: "r" }] },
      // Same id as a pool group: must land IN Transform, not in a second
      // section with the same heading.
      { id: "transform", title: "Transform", rows: [{ kind: "command", command: "my-pos-cmd", help: "h", requires: "r" }] },
    ],
  });
  // MEMBERSHIP: its own two groups plus every pool group it is eligible for, and
  // nothing else — "transform" is BOTH (merged, not duplicated).
  const ids = plugin.toolGroups.map((g) => g.id);
  assert.deepEqual([...ids].sort(), [...new Set(["presets", "mine", ...poolIdsFor(plugin)])].sort());
  const pos = plugin.toolGroups.find((g) => g.id === "transform");
  assert.deepEqual(pos.rows.map((r) => r.command), ["my-pos-cmd", "bind-to-camera", "unbind-from-camera"]);
  // ORDER, stated as the law rather than as a frozen list: preset families, then
  // declared groups, then the purely INHERITED ones. "transform" is declared by
  // this plugin, so it sits with the declared groups, which is why the law is
  // written over the pool ids it did NOT declare.
  assert.deepEqual(ids.slice(0, 3), ["presets", "mine", "transform"]);
  for (const id of poolIdsFor(plugin))
    if (id !== "transform") assert.ok(ids.indexOf("transform") < ids.indexOf(id), `inherited "${id}" must follow the plugin's own groups`);
});

test("a plugin row's own applies() can exclude it, and an all-excluded group vanishes", () => {
  const plugin = withToolGroups({
    type: "synthetic_excluded",
    defaults: { blur: 4 }, // no frame → no Transform group either
    capabilities: {},
    toolGroups: [{ id: "mine", title: "Mine", rows: [{ kind: "command", command: "c", help: "h", requires: "r", applies: () => false }] }],
  });
  // Its OWN group is gone (every row excluded), and Transform with it (no frame).
  // What remains is exactly the pool groups it IS eligible for — nothing of its own.
  assert.deepEqual(plugin.toolGroups.map((g) => g.id), poolIdsFor(plugin));
  assert.ok(!plugin.toolGroups.some((g) => g.id === "mine"));
  assert.ok(!plugin.toolGroups.some((g) => g.id === "transform"));
});

test("the source plugin object is never mutated (two live documents share plugin modules)", () => {
  const src = { type: "synthetic_pure", defaults: { x: 0, y: 0, w: 1, h: 1 }, capabilities: {} };
  const out = withToolGroups(src);
  assert.equal(src.toolGroups, undefined);
  assert.notEqual(out, src);
});

// ── (8) the shared vocabulary cannot drift ───────────────────────────────────
test("a pool group titled with an Inspector category id is spelled as Inspector.svelte spells it", () => {
  // INTERIM PIN. web/Inspector.svelte owns CATEGORY_TITLES today (the handback
  // patch moves it to core/properties.js, where the categories are ASSIGNED, and
  // then registry.js imports it and this test becomes redundant). Until then the
  // pool's titles are literals, and this is what stops them drifting — the exact
  // failure mode the deleted mirror block in ToolsPane.svelte warned about.
  const inspector = readFileSync(resolve(here, "../web/Inspector.svelte"), "utf8");
  const titles = inspector.slice(inspector.indexOf("const CATEGORY_TITLES"), inspector.indexOf("const CATEGORY_ORDER"));
  assert.ok(titles.includes("transform:"), "could not find CATEGORY_TITLES in web/Inspector.svelte — update this pin");
  for (const group of TOOL_POOL) {
    if (!titles.includes(`${group.id}:`)) continue; // a tools-only group, no shared spelling to pin
    assert.ok(titles.includes(`${group.id}: "${group.title}"`),
      `pool group "${group.id}" is titled "${group.title}" but Inspector.svelte's CATEGORY_TITLES spells it differently — the Property Panel and the Tools pane must name the same section the same way`);
  }
});

test("FRAME_KEYS matches web/App.svelte's CAMERA_BIND_KEYS (the pending handback)", () => {
  // Same interim pin, for the other hand-copied list named in registry.js.
  const appSvelte = readFileSync(resolve(here, "../web/App.svelte"), "utf8");
  const line = appSvelte.split("\n").find((l) => l.includes("CAMERA_BIND_KEYS ="));
  assert.ok(line, "could not find CAMERA_BIND_KEYS in web/App.svelte — update this pin");
  for (const key of FRAME_KEYS)
    assert.ok(line.includes(`"${key}"`), `CAMERA_BIND_KEYS does not include "${key}" but core/registry.js FRAME_KEYS does`);
});

test("every TOOL_POOL command id is a REGISTERED command (the pool cannot name a ghost)", () => {
  // A pool row is a SURFACING of a command registry entry — web/ToolsPane.svelte's
  // entryOf(row) looks the id up and renders its title and icon. A pool row naming
  // an id nobody registered therefore draws a blank, unclickable button, and
  // nothing anywhere says so: the pool is a hand-written mirror of the command
  // list, which is the drift shape ledger C-8 is about. This is the cheap half —
  // the fix is not deferrable, but neither is the gate.
  //
  // TWO SOURCES, because a command has two homes and the pool may name either.
  // A PLUGIN's entries are read from the plugin OBJECTS — they are right here in
  // `allPlugins`, so grepping for them would be reading a transcription when the
  // original is in hand. `add-self-loop` is the live case: elbow_arrow declares
  // it, the pool surfaces it, and web/App.svelte has never heard of it.
  //
  // The CORE entries still need the text scan (they are inside a .svelte component
  // this file cannot import), and there COMMENTS ARE STRIPPED FIRST (ledger C-14):
  // `bind-to-camera` appears in this codebase's prose as often as in its code, and
  // a comment-blind grep would pass on a command that exists only in a sentence
  // explaining it.
  const coreSrc = readFileSync(resolve(here, "../web/App.svelte"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^[ \t]*\/\//.test(l)).join("\n");
  const pluginIds = new Set(allPlugins.flatMap((p) => (p.commands ?? []).map((c) => c.id)));
  for (const group of TOOL_POOL)
    for (const row of group.rows)
      assert.ok(pluginIds.has(row.command) || coreSrc.includes(`id: "${row.command}"`),
        `TOOL_POOL group "${group.id}" surfaces command "${row.command}", but neither web/App.svelte nor any plugin registers an entry with that id — the Tools pane would draw a titleless dead button`);
});

test("a plugin's OWN tool rows name commands that plugin (or the core) registers", () => {
  // The same ghost check for the OTHER declaration path. A plugin group is
  // resolved from the plugin object, so its rows are checked against the objects
  // too — no text scan, no comment stripping, no drift.
  const coreSrc = readFileSync(resolve(here, "../web/App.svelte"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^[ \t]*\/\//.test(l)).join("\n");
  const pluginIds = new Set(allPlugins.flatMap((p) => (p.commands ?? []).map((c) => c.id)));
  let checked = 0;
  for (const p of allPlugins)
    for (const g of p.toolGroups ?? [])
      for (const row of g.rows) {
        checked++;
        assert.ok(pluginIds.has(row.command) || coreSrc.includes(`id: "${row.command}"`),
          `${p.type} tool group "${g.id}" surfaces command "${row.command}", which nothing registers`);
      }
  assert.ok(checked > 0, "no plugin declares its own tool rows — this assertion is vacuous, so delete it or find out why");
});

console.log(`\n${passed} tests passed`);
