/**
 * THE PRESET CONTRACT — plain node, no framework, no browser.
 * Run: node src/demo_apps/PowerRP/tests/preset_contract_test.js
 *
 * WHY THIS EXISTS. Two preset-authoring agents each hand-rolled the SAME check
 * (`.frenzy/round6/presets/scratch_materials.mjs`, `scratch_instruments.mjs`):
 * "diff every designed key against Object.keys(plugin.defaults)". R6-3.14 named
 * that discipline and asked every future family to ship one — at which point the
 * hand-maintained-mirror defect (R6-24.7) had reproduced itself in the TOOLING,
 * two disposable scratch files deep, running against nothing. This is that check,
 * once, inside the gate.
 *
 * IT DISCOVERS ITS SUBJECTS. `builtinRoster()` is the roster sweep seam
 * (plugins/index.js: "A SWEEP MUST USE THIS, NOT allPlugins") and
 * `presetFamiliesOf` is the declaration seam — so a widget that gains presets
 * tomorrow is covered with no edit here. A hardcoded plugin list would BE the
 * mirror defect this file exists to kill, and it would have been wrong already:
 * the manifest's R6-3.2 census says "14 of 73 plugins declare presets", and the
 * registry answers 33 of 96.
 *
 * WHAT IT PROVES, over EVERY plugin the app registers:
 *   (1) ZERO INVENTED KEYS — every key of every preset's `props` exists in the
 *       plugin's `defaults`. A preset writing a key the widget does not have
 *       keyframes a property nothing reads: invisible, permanent, silent.
 *   (2) A PRESET CAN INTRODUCE ITSELF — non-empty `name` and `description`, and
 *       names unique within a family (the Tools pane keys its cards by name).
 *   (3) EQUATION FORM (R6-25.1) — an equation-valued prop carries the "="
 *       marker, parses, resolves to a declared result kind, and references
 *       NOTHING the target document might not contain.
 *   (4) DATA DISTINCTNESS — no two presets in a family carry identical `props`.
 *       This is the bare-node shadow of the pixel-level pairwise-distinctness
 *       rule (R6-3.13): two presets with the same property-set are provably the
 *       same picture, and proving it needs no renderer.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE: that a preset LOOKS different, or that a
 * knob it advertises is visible. Those are pixel questions (R6-25.3, R6-25.4)
 * and belong in the family's own browser probe — this suite has no GPU and must
 * not pretend otherwise.
 *
 * Preset-family DISJOINTNESS (families must not clobber each other's keys) is
 * already proven by tests/tool_groups_test.js and is not repeated here.
 */

import assert from "node:assert/strict";
import { builtinRoster } from "../plugins/index.js";
import { presetFamiliesOf } from "../core/registry.js";
import { compiled, isEquationValue, isNumericSlot, resolveRef, resultKindForSlot, slugMap } from "../core/expressions.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registered = builtinRoster();

// The equation "=" marker, spelled exactly as core/expressions.js's EQ_PREFIX_RE
// spells it (that constant is module-private, so this is the one place the shape
// is restated — a single regex, beside the rule it enforces).
const EQ_MARKER_RE = /^\s*=/;
// A preset is applied to a document it has never seen (web/app.svelte.js
// applyPreset writes `preset.props` RAW), so the only references it may make are
// to the target item itself and to evaluator keywords. Resolved against an EMPTY
// slug map: anything that comes back a variable, or throws, names something the
// preset cannot know exists.
const EMPTY_SLUGS = slugMap({ items: {}, vars: {} });
const SELF_ID = "__preset_target__";
// resultKindForSlot's answer when NOTHING declares a slot's kind. Such an
// equation is reported and discarded at evaluation, so it can never take effect.
const UNRESOLVED_KIND = "unresolved";

/**
 * Pure function. Every preset in the roster, flattened with the context needed to
 * name it in a failure message.
 *
 * @param {object[]} plugins - registered plugin objects
 * @returns {Array<{plugin: object, familyId: string, preset: object}>}
 *
 * @example // eachPreset([{type: "flare", presets: [{name: "Anamorphic", props: {}}]}])
 * // [{plugin: <flare>, familyId: "presets", preset: {name: "Anamorphic", props: {}}}]
 * @example eachPreset([{type: "rect", defaults: {}, capabilities: {}}]).length // 0 (no presets, no rows)
 */
function eachPreset(plugins) {
  return plugins.flatMap((plugin) =>
    presetFamiliesOf(plugin).flatMap((family) =>
      family.presets.map((preset) => ({ plugin, familyId: family.id, preset }))));
}

/**
 * Pure function. A stable label for one preset, for failure messages.
 *
 * @example where({plugin: {type: "demo_crt"}, familyId: "presets", preset: {name: "Sony BVM"}})
 * // 'demo_crt/presets/"Sony BVM"'
 */
function where({ plugin, familyId, preset }) {
  return `${plugin.type}/${familyId}/${JSON.stringify(preset.name)}`;
}

const ALL = eachPreset(registered);
const WITH_PRESETS = registered.filter((p) => presetFamiliesOf(p).length > 0);

// ── (0) the sweep is not vacuous ─────────────────────────────────────────────
test("the roster yields presets to check at all", () => {
  assert.ok(WITH_PRESETS.length > 0, "no registered plugin declares presets — every assertion below would be vacuous");
  assert.ok(ALL.length > 0, "no presets found");
  console.log(`      ${WITH_PRESETS.length} plugins, ${ALL.length} presets`);
});

// ── (1) zero invented keys ───────────────────────────────────────────────────
test("every preset prop key exists in the plugin's defaults", () => {
  for (const entry of ALL) {
    const declared = new Set(Object.keys(entry.plugin.defaults ?? {}));
    for (const key of Object.keys(entry.preset.props ?? {}))
      assert.ok(declared.has(key),
        `${where(entry)} writes "${key}", which is not in ${entry.plugin.type}'s defaults — a preset key nothing reads keyframes an invisible property forever`);
  }
});

test("every preset carries a props object (an empty one is a preset that does nothing)", () => {
  for (const entry of ALL) {
    assert.equal(typeof entry.preset.props, "object", `${where(entry)}: props is ${typeof entry.preset.props}`);
    assert.ok(entry.preset.props !== null && Object.keys(entry.preset.props).length > 0,
      `${where(entry)}: empty props — applying it would change nothing`);
  }
});

// ── (2) a preset can introduce itself ────────────────────────────────────────
test("every preset has a non-empty name AND description", () => {
  for (const entry of ALL)
    for (const field of ["name", "description"]) {
      assert.equal(typeof entry.preset[field], "string",
        `${where(entry)}: ${field} is ${typeof entry.preset[field]}`);
      assert.ok(entry.preset[field].trim().length > 0,
        `${where(entry)}: empty ${field} — a preset that will not say what it models is the "stupid preset" the presets program exists to rule out`);
    }
});

test("preset names are unique within a family", () => {
  for (const plugin of WITH_PRESETS)
    for (const family of presetFamiliesOf(plugin)) {
      const names = family.presets.map((p) => p.name);
      assert.deepEqual(names, [...new Set(names)],
        `${plugin.type}/${family.id}: duplicate preset name in ${names.join(" | ")} — the Tools pane keys its cards by name`);
    }
});

// ── (3) equation form (R6-25.1) ──────────────────────────────────────────────
test('an equation-valued prop carries the "=" marker', () => {
  // WHY THE MARKER AND NOT THE BARE FORM. app.applyPreset writes the value RAW,
  // so the preset's string IS the stored value, and `isEquationValue` reads a
  // stored string as an equation on two grounds: the universal "=" marker, OR a
  // bare string sitting in an isNumericSlot leaf. The bare form is therefore
  // correct on a NUMBER row and, on every other row, silently stores a literal —
  // no error, no equation, the picture just never binds. The marked form has no
  // silent failure mode at all. Age agrees (R6-25.1).
  for (const entry of ALL)
    for (const [key, value] of Object.entries(entry.preset.props ?? {})) {
      if (!isEquationValue(entry.plugin, [key], value)) continue;
      assert.match(String(value), EQ_MARKER_RE,
        `${where(entry)} writes the equation ${JSON.stringify(value)} on "${key}" without the "=" marker — correct today only because "${key}" is a numeric slot, and a silent literal the moment that default's type changes or the same string is copied to any other row`);
    }
});

test("every equation-valued prop parses", () => {
  for (const entry of ALL)
    for (const [key, value] of Object.entries(entry.preset.props ?? {})) {
      if (!isEquationValue(entry.plugin, [key], value)) continue;
      assert.doesNotThrow(() => compiled(String(value).replace(EQ_MARKER_RE, "")),
        `${where(entry)}: "${key}" = ${JSON.stringify(value)} does not parse`);
    }
});

test("every equation-valued prop resolves to a declared result kind", () => {
  // An UNRESOLVED kind matches nothing (resultMatchesKind's default branch), so
  // the equation is reported and discarded at evaluation — a preset that cannot
  // take effect. The measured trap: "points" is a DECLARED LIST name globally
  // (core/lists.js), so on ss_polygonStar / demo_magnify — where "points" is a
  // plain star-point COUNT — the marked form types as "list" and a number result
  // is refused. Loudly, unlike the bare form's silence, and caught here first.
  for (const entry of ALL)
    for (const [key, value] of Object.entries(entry.preset.props ?? {})) {
      if (!isEquationValue(entry.plugin, [key], value)) continue;
      const kind = resultKindForSlot(entry.plugin, [key], value);
      assert.notEqual(kind, UNRESOLVED_KIND,
        `${where(entry)}: nothing declares the result kind of "${key}", so its equation is discarded at evaluation`);
      if (isNumericSlot(entry.plugin, [key]))
        assert.equal(kind, "number",
          `${where(entry)}: "${key}" holds a number by default but its marked equation types as "${kind}" — a global declaration for that key NAME is overriding the plugin's own default (core/lists.js / core/properties.js), so a numeric result would be refused`);
    }
});

test("a preset equation references only the target item and evaluator keywords", () => {
  // A preset ships with the PLUGIN and is applied to a document it has never
  // seen, so a reference to a named widget or a document variable is a promise
  // about someone else's file. `self.…` is identity-stable by construction and a
  // keyword (`time`) is host-provided; everything else resolves to a variable or
  // throws — checked with the SHIPPED resolver against an empty slug map, so this
  // cannot drift from the grammar the way a transcribed keyword list would.
  for (const entry of ALL)
    for (const [key, value] of Object.entries(entry.preset.props ?? {})) {
      if (!isEquationValue(entry.plugin, [key], value)) continue;
      for (const token of compiled(String(value).replace(EQ_MARKER_RE, "")).refs) {
        let descriptor;
        assert.doesNotThrow(() => { descriptor = resolveRef(token, EMPTY_SLUGS, SELF_ID); },
          `${where(entry)}: "${key}" references "${token}", which names no widget the preset can know exists`);
        const ownProperty = (descriptor.kind === "prop" || descriptor.kind === "anchor") && descriptor.itemId === SELF_ID;
        assert.ok(ownProperty || descriptor.kind === "keyword",
          `${where(entry)}: "${key}" references "${token}" (${descriptor.kind}) — a preset may read only self.… and evaluator keywords, never a document variable or another widget`);
      }
    }
});

// ── (4) data distinctness ────────────────────────────────────────────────────
test("no two presets in a family carry identical props", () => {
  for (const plugin of WITH_PRESETS)
    for (const family of presetFamiliesOf(plugin)) {
      const seen = new Map();
      for (const preset of family.presets) {
        // Key ORDER is not distinctness, so compare the sorted entry list.
        const signature = JSON.stringify(Object.entries(preset.props ?? {}).sort());
        assert.ok(!seen.has(signature),
          `${plugin.type}/${family.id}: "${preset.name}" and "${seen.get(signature)}" write identical props — the same picture under two names, which is the near-duplicate failure the presets program rules out`);
        seen.set(signature, preset.name);
      }
    }
});

console.log(`\n${passed} preset contract tests passed`);
