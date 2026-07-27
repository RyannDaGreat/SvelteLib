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
 *       group, a widget with no frame has no Positioning group. The pane cannot
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

test("a widget with no FRAME gets no Positioning group (the camera-bind tools' gate)", () => {
  const frameless = registered.filter((p) => !hasFrame(p));
  assert.ok(frameless.length > 0, "no frameless plugin in the roster — this assertion would be vacuous");
  for (const p of frameless)
    assert.ok(!p.toolGroups.some((g) => g.id === "positioning"),
      `${p.type}: has no x/y/w/h yet shows a Positioning group`);
  // And the converse: a widget WITH a frame (that is not THE camera) does get it.
  const bindable = registered.filter(frameBindable);
  assert.ok(bindable.length > 0, "no frame-bindable plugin in the roster");
  for (const p of bindable)
    assert.ok(p.toolGroups.some((g) => g.id === "positioning"),
      `${p.type}: has a bindable frame but no Positioning group`);
});

test("THE CAMERA is not frame-bindable (binding it to its own frame is a cycle)", () => {
  const camera = registered.find((p) => p.capabilities.purgeable === false);
  assert.ok(camera, "no purgeable:false plugin — THE camera is mandatory");
  assert.ok(hasFrame(camera), "the camera does have x/y/w/h");
  assert.equal(frameBindable(camera), false);
  assert.ok(!camera.toolGroups.some((g) => g.id === "positioning"), "the camera must not offer Bind to Camera");
});

// ── (3) every disable-able row can explain itself ────────────────────────────
test("every command row anywhere declares a non-empty help AND requires", () => {
  for (const p of registered)
    for (const g of p.toolGroups)
      for (const row of g.rows) {
        if (row.kind !== "command") continue;
        for (const field of ["help", "requires"]) {
          assert.equal(typeof row[field], "string", `${p.type}/${g.id}/${row.command}: ${field} is not a string`);
          assert.ok(row[field].length > 0, `${p.type}/${g.id}/${row.command}: empty ${field} — a disabled tool that will not say why is the defect this suite exists for`);
        }
      }
});

test("the pool's import gate rejects a tool with no requires / no applies", () => {
  // The gate itself runs at import of core/registry.js over TOOL_POOL, so it
  // cannot be re-invoked here; assert the SHAPE it guarantees instead, then prove
  // the same contract is enforced for a PLUGIN-declared group (the other path in).
  for (const g of TOOL_POOL)
    for (const row of g.rows) {
      assert.equal(typeof row.applies, "function", `pool ${g.id}/${row.command}: applies must be a predicate`);
      assert.ok(row.requires && row.help, `pool ${g.id}/${row.command}: help + requires are mandatory`);
    }
  const base = { type: "synthetic", defaults: { x: 0, y: 0, w: 1, h: 1 }, capabilities: {} };
  assert.throws(
    () => toolGroupsOf({ ...base, toolGroups: [{ id: "own", title: "Own", rows: [{ kind: "command", command: "c", help: "h" }] }] }),
    /missing the mandatory "requires"/,
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
  const clash = presetFamiliesOf({ presetFamilies: [{ id: "positioning", title: "Positioning", presets: [{ name: "p", props: {} }] }] });
  assert.equal(clash[0].id, "presets.positioning");
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
  assert.deepEqual(plugin.toolGroups.map((g) => g.id), ["presets.location", "presets.colour", "presets.performance", "positioning"]);
  assert.deepEqual(plugin.toolGroups.map((g) => g.title), ["Location", "Colour", "Performance", "Positioning"]);
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
      // Same id as a pool group: must land IN Positioning, not in a second
      // section with the same heading.
      { id: "positioning", title: "Positioning", rows: [{ kind: "command", command: "my-pos-cmd", help: "h", requires: "r" }] },
    ],
  });
  assert.deepEqual(plugin.toolGroups.map((g) => g.id), ["presets", "mine", "positioning"]);
  const pos = plugin.toolGroups.find((g) => g.id === "positioning");
  assert.deepEqual(pos.rows.map((r) => r.command), ["my-pos-cmd", "bind-to-camera", "unbind-from-camera"]);
});

test("a plugin row's own applies() can exclude it, and an all-excluded group vanishes", () => {
  const plugin = withToolGroups({
    type: "synthetic_excluded",
    defaults: { blur: 4 }, // no frame → no pool group either
    capabilities: {},
    toolGroups: [{ id: "mine", title: "Mine", rows: [{ kind: "command", command: "c", help: "h", requires: "r", applies: () => false }] }],
  });
  assert.deepEqual(plugin.toolGroups, []);
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
  assert.ok(titles.includes("positioning:"), "could not find CATEGORY_TITLES in web/Inspector.svelte — update this pin");
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

console.log(`\n${passed} tests passed`);
