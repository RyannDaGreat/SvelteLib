/**
 * Demo-widget infrastructure tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/demo_widget_test.js
 *
 * Proves the CUSTOM per-widget property mechanism ("self.*", Blender-style) end
 * to end, WITHOUT a browser or any edit to the evaluation engine:
 *   (1) customProps / defaultLabel pure-fn behavior.
 *   (2) the Demo Showcase widget composes its custom `inset` prop into BOTH its
 *       defaults and its inspector (under the "custom" category).
 *   (3) the custom prop is equation-capable + `self.*`-referenceable
 *       (isEquationValue / numericPropertyPaths — the generic gates).
 *   (4) THE load-bearing proof: evaluateState resolves the custom prop as a
 *       literal, a bare arithmetic equation, AND a universal `= …` equation —
 *       flowing entirely through the existing expression pass.
 *
 * The bare-node import of plugins/demo/showcase.js is itself under test here
 * (the demo folder MUST stay DOM-free at import time, like the rest of plugins/).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { customProps, defaultLabel, CUSTOM_CATEGORY, bundle } from "../core/properties.js";
import { allPlugins } from "../plugins/index.js";
import { isEquationValue, numericPropertyPaths, evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { demoShowcasePlugin } from "../plugins/demo/showcase.js";
import { metaballsPlugin, localBalls, metaballRegion } from "../plugins/demo/metaballs.js";
import { MAX_METABALLS } from "../render_gpu/skia/metaballs_shader.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) customProps / defaultLabel ────────────────────────────────────────────
test("defaultLabel: sentence-cases camel/snake/kebab names", () => {
  assert.equal(defaultLabel("inset"), "Inset");
  assert.equal(defaultLabel("cornerCut"), "Corner cut");
  assert.equal(defaultLabel("edge_gap"), "Edge gap");
});

test("customProps: rows carry no `default`, defaults carry only values", () => {
  const { rows, defaults } = customProps([{ name: "inset", kind: "number", default: 16 }]);
  assert.deepEqual(rows[0], { key: "inset", kind: "number", label: "Inset", category: CUSTOM_CATEGORY });
  assert.equal("default" in rows[0], false); // default belongs to defaults(), not the row
  assert.deepEqual(defaults, { inset: 16 });
});

test("customProps: explicit label/category/aspects override + pass through", () => {
  const { rows } = customProps([
    { name: "gap", kind: "number", default: 8, label: "Gap", category: "formatting", min: 0, max: 40 },
  ]);
  assert.equal(rows[0].label, "Gap");
  assert.equal(rows[0].category, "formatting"); // explicit category wins over CUSTOM_CATEGORY
  assert.equal(rows[0].min, 0);
  assert.equal(rows[0].max, 40);
});

test("customProps: LOUD on a malformed def (no silent failure)", () => {
  assert.throws(() => customProps([{ name: "x", kind: "number" }]), /needs a default/); // missing default
  assert.throws(() => customProps([{ kind: "number", default: 1 }]), /string name/); // missing name
});

// ── (2) the Demo Showcase widget composition ──────────────────────────────────
test("demo_showcase: declares the custom `inset` prop in its defaults", () => {
  assert.equal(demoShowcasePlugin.type, "demo_showcase");
  assert.equal(typeof demoShowcasePlugin.defaults.inset, "number"); // a literal number default
});

test("demo_showcase: the custom prop is an Inspector row in the `custom` category", () => {
  const insetRow = demoShowcasePlugin.inspector.find((r) => r.key === "inset");
  assert.ok(insetRow, "inset row present in inspector");
  assert.equal(insetRow.kind, "number");
  assert.equal(insetRow.category, CUSTOM_CATEGORY);
  // Still composes the shared bundles alongside it (transform is present).
  const posKeys = bundle("transform").map((r) => r.key);
  assert.ok(posKeys.every((k) => demoShowcasePlugin.inspector.some((r) => r.key === k)));
});

// ── (3) equation-capable + self.*-referenceable ───────────────────────────────
test("demo_showcase: custom prop is equation-capable (both gates)", () => {
  // Universal `=` gate (any-type) AND legacy numeric-slot bare string (number default).
  assert.equal(isEquationValue(demoShowcasePlugin, ["inset"], "= self.w / 4"), true);
  assert.equal(isEquationValue(demoShowcasePlugin, ["inset"], "self.w / 8"), true);
  // A plain literal number is NOT an equation.
  assert.equal(isEquationValue(demoShowcasePlugin, ["inset"], 20), false);
});

test("demo_showcase: custom prop is referenceable as self.inset", () => {
  // numericPropertyPaths lists exactly what is typeable/referenceable in equations
  // + surfaced by autocomplete — the discoverability guarantee.
  assert.ok(numericPropertyPaths(demoShowcasePlugin).includes("inset"));
});

// ── (4) evaluateState: literal + bare + `=` all resolve through the eval pass ──
const registry = createRegistry();
registry.register(demoShowcasePlugin);

function evalInset(insetValue, extra = {}) {
  const state = { vars: {}, items: { d1: { type: "demo_showcase", w: 240, h: 160, inset: insetValue, ...extra } } };
  const { state: ev, errors } = evaluateState(state, registry);
  return { value: ev.items.d1.inset, errors };
}

test("evaluateState: LITERAL inset passes through unchanged", () => {
  const { value, errors } = evalInset(25);
  assert.equal(value, 25);
  assert.equal(errors.size, 0);
});

test("evaluateState: `= self.w / 4` equation resolves against self", () => {
  const { value, errors } = evalInset("= self.w / 4");
  assert.equal(value, 60); // 240 / 4
  assert.equal(errors.size, 0);
});

test("evaluateState: BARE (no `=`) numeric-slot equation resolves", () => {
  const { value, errors } = evalInset("self.w / 8");
  assert.equal(value, 30); // 240 / 8
  assert.equal(errors.size, 0);
});

test("evaluateState: a bad equation fails LOUD + falls back to the default", () => {
  const { value, errors } = evalInset("= nope_no_such_var + 1");
  assert.equal(value, demoShowcasePlugin.defaults.inset); // deterministic default, never a silent NaN
  assert.ok(errors.size >= 1);
});

// ── metaball archetype: ONE ball per widget + leader/union fusion emit ────────
test("metaball: defaults to a SINGLE sphere droplet with a visible fluid color", () => {
  const d = metaballsPlugin.defaults;
  assert.equal(d.shape, "sphere");     // one ball; shape is the whole geometry knob
  assert.equal(d.count, undefined);    // NO internal roster anymore
  assert.equal(d.b0R, undefined);      // no Ball-0 rows
  assert.equal(typeof d.fluidColor, "string"); // a per-widget fluid color
  assert.ok(d.refraction > 0);         // a per-widget refraction
  assert.equal(metaballsPlugin.capabilities.metaball, true); // marked a fusion participant
  assert.equal(typeof metaballsPlugin.localBalls, "function"); // exposes the source hook for derive
  // Inspector is simple: no "Ball N ·" rows.
  assert.ok(!metaballsPlugin.inspector.some((r) => /^b\d/.test(r.key ?? "")));
});

test("localBalls: ONE ball fitted to the widget bbox (geometry only)", () => {
  assert.deepEqual(
    localBalls({ w: 200, h: 200, shape: "sphere" }),
    [{ type: "sphere", cx: 100, cy: 100, r: 100, len: 0, ang: 0 }], // fills the short half-size
  );
  assert.deepEqual(
    localBalls({ w: 400, h: 200, shape: "tube" }),
    [{ type: "tube", cx: 200, cy: 100, r: 100, len: 100, ang: 0 }], // capsule spans the long axis
  );
  assert.deepEqual(localBalls({ w: 0, h: 0, shape: "sphere" }), []); // degenerate box → nothing
});

test("metaballRegion: single ball → tight region, geometry + appearance as packed floats", () => {
  // no appearance → no-tint fallback (color strength 0, refraction 0), 11 floats/ball
  const region = metaballRegion([{ type: "sphere", x: 0, y: 0, r: 100, len: 0, ang: 0 }], { x: 0, y: 0, rotation: 0, scale: 1 }, 0);
  assert.deepEqual(region, { cx: 0, cy: 0, halfW: 100, halfH: 100, balls: [0, 0.5, 0.5, 1, 0, 0, 0, 0, 0, 0, 0], count: 1, unit: 1 });
  // with appearance → the fluid color + refraction ride in the ball's packed floats
  const colored = metaballRegion([{ type: "sphere", x: 0, y: 0, r: 100, len: 0, ang: 0, fluidColor: "#ff0000", refraction: 0.4 }], { x: 0, y: 0, rotation: 0, scale: 1 }, 0);
  assert.deepEqual(colored.balls, [0, 0.5, 0.5, 1, 0, 0, 1, 0, 0, 1, 0.4]); // red, full strength, refr 0.4
  assert.equal(metaballRegion([], { x: 0, y: 0, rotation: 0, scale: 1 }, 0.6), null); // no balls → nothing
});

test("metaball emit: leader draws the fused union, non-leader draws nothing", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const scene = { balls: [{ type: "sphere", x: 0, y: 0, r: 100, len: 0, ang: 0, fluidColor: "#ff0000", refraction: 0.3 }, { type: "sphere", x: 120, y: 0, r: 100, len: 0, ang: 0, fluidColor: "#0000ff", refraction: 0.1 }] };
  const nonLeader = metaballsPlugin.emit({ ...metaballsPlugin.defaults, metaballScene: scene, metaballLeader: false }, null, world);
  assert.deepEqual(nonLeader, []); // non-leader emits nothing (still a draggable widget)
  const leader = metaballsPlugin.emit({ ...metaballsPlugin.defaults, metaballScene: scene, metaballLeader: true }, null, world);
  assert.equal(leader.length, 1);
  assert.equal(leader[0].op, "materialBackdrop");
  assert.equal(leader[0].material, "metaballs");
  assert.equal(leader[0].params.ballCount, 2);                 // BOTH balls fused into the leader's region
  assert.equal(leader[0].params.balls.length, 2 * 11);         // packed [type,cx,cy,r,len,ang,colR,colG,colB,colA,refr] per ball
  assert.equal(leader[0].params.refraction, undefined);        // refraction is PER-BALL now, not a global param
  assert.equal(leader[0].params.tint, undefined);              // tint replaced by per-ball fluidColor
  assert.ok(leader[0].halfW >= 110);                           // union spans both balls (centres 120 apart, r 100)
});

test("metaball emit: over-cap ball set is CLAMPED + reported LOUD (no silent drop)", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const many = Array.from({ length: MAX_METABALLS + 5 }, (_, i) => ({ type: "sphere", x: i * 10, y: 0, r: 8, len: 0, ang: 0 }));
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    const leader = metaballsPlugin.emit({ ...metaballsPlugin.defaults, metaballScene: { balls: many }, metaballLeader: true }, null, world);
    assert.equal(leader[0].params.ballCount, MAX_METABALLS);   // clamped to the shader budget
  } finally { console.error = orig; }
  assert.ok(errs.some((l) => /exceed the shader cap/.test(l)), "cap overflow must be reported loudly");
});

// ── R6-5: the custom section is named after its WIDGET, never "Custom" ───────
// The user's rule, verbatim: "Custom is supposed to be reserved for what people
// make, or not at all", and "Lens Flare settings" as the worked example. The
// Inspector DERIVES the title as `${plugin.title} settings` rather than listing
// 24 names beside a 96-plugin roster (ledger C-8). Two things can break that:
// the derivation being reverted to a literal, and a plugin arriving with custom
// rows but no title — which would render "undefined settings" with nothing
// saying so, because `title` is NOT mandatory at registration.

test("R6-5: every plugin with a custom section has a `title` to name it with", () => {
  const withCustom = allPlugins.filter((p) => (p.inspector ?? []).some((r) => r.category === CUSTOM_CATEGORY));
  assert.ok(withCustom.length > 0, "no plugin has a custom section — this gate has lost its subject");
  for (const p of withCustom)
    assert.ok(typeof p.title === "string" && p.title.trim(),
      `plugin "${p.type}" declares custom (self.*) rows but no \`title\`, so the Inspector would head that section "undefined settings" (web/Inspector.svelte customCategoryTitle)`);
});

test("R6-5: web/Inspector.svelte titles the custom category by DERIVATION, not a literal", () => {
  // A text pin, the idiom tests/tool_groups_test.js already uses for
  // CATEGORY_TITLES: the map lives inside a .svelte <script> and cannot be
  // imported in bare node. Comments are stripped first (ledger C-14) — this file
  // explains the old name in prose in several places, and a comment-blind grep
  // would fail on the explanation rather than on a regression.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, "../web/Inspector.svelte"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^[ \t]*(\/\/|<!--)/.test(l)).join("\n");
  assert.ok(!/custom:\s*"Custom"/.test(src),
    'web/Inspector.svelte has gone back to a literal `custom: "Custom"` CATEGORY_TITLES entry — R6-5 replaced it with customCategoryTitle(plugin.title)');
  assert.ok(src.includes("customCategoryTitle"),
    "web/Inspector.svelte no longer calls customCategoryTitle — the per-widget section name is gone");
  assert.ok(src.includes('`${widgetTitle ?? "Widget"} settings`'),
    'customCategoryTitle no longer builds "<widget> settings" — R6-5.1 quotes the user asking for exactly "Lens Flare settings"');
});

console.log(`\n${passed} tests passed`);
