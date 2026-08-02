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
 *   (1) ZERO INVENTED KEYS — every key of every preset's `props` is DECLARED by
 *       the plugin, in its `defaults` or its Inspector rows. A preset writing a
 *       key the widget declares nowhere keyframes a property nothing reads:
 *       invisible, permanent, silent.
 *   (2) A PRESET CAN INTRODUCE ITSELF — non-empty `name` and `description`, and
 *       names unique within a family (the Tools pane keys its cards by name).
 *   (3) EQUATION FORM (R6-25.1) — an equation-valued prop carries the "="
 *       marker, parses, resolves to a declared result kind, and references
 *       NOTHING the target document might not contain.
 *   (4) DATA DISTINCTNESS — no two presets in a family carry identical `props`.
 *       This is the bare-node shadow of the pixel-level pairwise-distinctness
 *       rule (R6-3.13): two presets with the same property-set are provably the
 *       same picture, and proving it needs no renderer.
 *   (5) NO PLACEMENT KEY — a preset changes the LOOK, it never moves something
 *       the user already put somewhere (SPEC.md §5).
 *   (6) EVERY VALUE IS LEGAL FOR ITS OWN INSPECTOR ROW — in range, in the
 *       option list, of the right type.
 *
 * (5) AND (6) WERE HOISTED, NOT INVENTED. They were checks (2) and (4) of
 * tests/frosted_presets_test.js, copied into tests/metaball_presets_test.js, and
 * about to be copied once per family forever. Neither has anything
 * widget-specific in it — one reads a fixed key set, the other reads the
 * plugin's OWN registered rows — so a per-family copy is exactly the
 * hand-maintained-mirror defect this file was written to kill, reproducing
 * itself in the tooling for the second time. Frosted's check (1), "every preset
 * sets every look knob", is NOT hoisted and must stay per-family: SPEC.md §4
 * makes a SPARSE geometry family legal (shapeshifter's cloud presets write three
 * keys and never touch fill), so a universal version would be a false gate.
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
import { parseColor } from "../render_gpu/ir.js";

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
/**
 * Pure function. Every key a plugin DECLARES, from either seam: its `defaults`
 * and its registered Inspector rows.
 *
 * BOTH SEAMS, because a defaults-only reading is wrong and it blocked real work.
 * `STROKE_TRIM_KEYS` / `STROKE_OFFSET_KEYS` / `STROKE_JOIN_KEYS` carry NO default
 * on purpose — `core/properties.js:1568-1570` states the rule verbatim:
 * "absent-is-legacy, so composing them changes no widget's stored state or
 * rendering until a knob moves" — while being declared as rows on 45 plugins. So
 * this check's own premise, "a key nothing reads", is FALSE for them: the
 * Inspector reads them, the renderer reads them, and a circle with
 * `strokeStart`/`strokeEnd` is a progress arc whose rows are otherwise
 * undiscoverable. `rowViolations` below already knew this; check (1) did not.
 *
 * The real target survives: a key declared in NEITHER seam is still refused. And
 * the two other classes of undeclared-but-legal state stay caught, which is the
 * point of widening by exactly one seam rather than removing the check — a list
 * companion (`pointsActive`, core/lists.js:62) and an undeclared structural list
 * (`bento.spans`, plugins/bento.js:35) appear in neither `defaults` nor
 * `inspector`, so a preset naming one must argue for it rather than slip past.
 *
 * @param {object} plugin - a registered (resolved) plugin
 * @returns {Set<string>} every declared top-level key
 *
 * @example declaredKeys({defaults: {fill: "#000"}, inspector: [{key: "strokeStart"}]})
 * // Set { "fill", "strokeStart" }
 * @example declaredKeys({defaults: {w: 10}}) // Set { "w" }
 */
function declaredKeys(plugin) {
  return new Set([
    ...Object.keys(plugin.defaults ?? {}),
    ...(plugin.inspector ?? []).filter((r) => r.key).map((r) => r.key)
  ]);
}

test("every preset prop key is DECLARED — in the plugin's defaults or its Inspector rows", () => {
  for (const entry of ALL) {
    const declared = declaredKeys(entry.plugin);
    for (const key of Object.keys(entry.preset.props ?? {}))
      assert.ok(declared.has(key),
        `${where(entry)} writes "${key}", which ${entry.plugin.type} declares in neither its defaults nor its Inspector rows — a preset key nothing reads keyframes an invisible property forever`);
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

// ── (5) no placement key ─────────────────────────────────────────────────────
// SPEC.md §5, restated at plugins/demo/lens_flare.js:193-208 and
// plugins/demo/sky.js:69-75: "A preset changes the LOOK, it never moves something
// the user already placed."
//
// THE UNIVERSAL SET IS NARROWER THAN ANY PER-FAMILY SET, AND THAT IS THE POINT.
// Only keys with no legitimate exception anywhere in the roster may be banned
// here; a gate that fails a correct shipped table is worse than no gate.
//   `w`/`h` are NOT here. SPEC.md §5's own sentence ends "...unless the whole
//     point of the family is a layout", and the layout wave exercised it: a crop
//     aspect family writes exactly ONE key, `h`, as an "=" equation on `self.w`,
//     so the ratio stays live-locked on resize. Whether a family has earned that
//     is a judgement its own suite makes.
//   The EFFECTS bundle and `opacity` are NOT here either, though
//     tests/frosted_presets_test.js forbids them — correctly, for that widget.
//     all twelve plugins/demo/lens_flare.js presets write `blendMode`, so
//     hoisting the stricter list would take a shipped, correct table red.
//     (plugins/graph_presets.js used to be the second example, writing a `bloom`
//     bundle in "The Valentine Curve"; it no longer writes ANY look key — the
//     equation zoo was narrowed to the curve definition alone by the user ruling
//     of 2026-08-02, pinned in tests/graph_zoo_equation_only_test.js.)
// `type` is included because a preset that rewrites an item's widget TYPE is
// incoherent — and it would pass check (1), since `type` IS in every plugin's
// defaults.
const PLACEMENT_KEYS = ["type", "x", "y", "z", "rotation", "scale", "rotationAnchor"];

/**
 * Pure function. The placement keys a props map writes, in PLACEMENT_KEYS order.
 * Empty is the passing answer.
 *
 * @param {object} props - a preset's props map
 * @returns {string[]} offending keys
 *
 * @example placementViolations({bumps: 5, lobeDepth: 0.34}) // []
 * @example placementViolations({tint: "#fff", rotation: 45}) // ["rotation"]
 * @example // w and h are deliberately legal — a crop-aspect family writes h:
 * placementViolations({h: "= self.w * 9 / 16"}) // []
 */
function placementViolations(props) {
  return PLACEMENT_KEYS.filter((k) => k in (props ?? {}));
}

test("no preset writes a placement key", () => {
  for (const entry of ALL) {
    const illegal = placementViolations(entry.preset.props);
    assert.deepEqual(illegal, [],
      `${where(entry)} writes ${illegal.join(", ")} — applying it would undo framing the author had already done by hand`);
  }
});

// ── (6) every value is legal for its own Inspector row ───────────────────────
/**
 * Pure function. Whether the shipped parser accepts this string as a colour.
 *
 * `parseColor` signals refusal by THROWING ("parseColor: unsupported color …",
 * render_gpu/ir.js:146), which is the right severity for a renderer and the wrong
 * shape for a sweep that must name every bad value rather than die on the first.
 * The catch is for that ONE documented condition and it does not swallow the
 * outcome — the caller turns `false` into a named complaint.
 *
 * @param {string} value - a candidate colour literal
 * @returns {boolean}
 *
 * @example parsesAsColour("#ff2a1a") // true
 * @example parsesAsColour("rgba(0, 0, 0, 0.7)") // true
 * @example parsesAsColour("not a colour") // false
 */
function parsesAsColour(value) {
  try {
    return parseColor(value)?.length >= 3;
  } catch {
    return false;
  }
}

/**
 * Pure function. Complaints about values that their OWN registered Inspector row
 * would refuse. Reads `plugin.inspector`, so a knob whose range changes tomorrow
 * re-checks every preset with no edit here.
 *
 * A key with NO row is SKIPPED rather than failed, and that is load-bearing: this
 * codebase has at least three legitimate classes of writable state declared in
 * neither `defaults` nor `inspector` — trim keys (absent-is-legacy,
 * core/properties.js:1424), list companions (`pointsActive`, core/lists.js:62)
 * and undeclared structural lists (`bento.spans`, plugins/bento.js:35). The
 * presets wave's own mechanical validator flagged one of each and was wrong all
 * three times. Invented keys are caught by check (1) against `defaults`.
 * An equation value is skipped too — its result kind is checked above, and its
 * VALUE is not knowable without evaluating it against a document.
 *
 * @param {object} plugin - a registered (resolved) plugin
 * @param {object} props - a preset's props map
 * @returns {string[]} one sentence per illegal value
 *
 * @example // rowViolations(registry.get("demo_god_rays"), {threshold: 0.62}) // []
 * @example // A number past its row's declared max:
 * // rowViolations(registry.get("demo_god_rays"), {threshold: 1.4})
 * // ['"threshold" = 1.4 is above the row max 1']
 */
function rowViolations(plugin, props) {
  const rows = new Map((plugin.inspector ?? []).filter((r) => r.key).map((r) => [r.key, r]));
  const out = [];
  for (const [key, value] of Object.entries(props ?? {})) {
    const row = rows.get(key);
    if (!row || isEquationValue(plugin, [key], value)) continue;
    if (row.kind === "number" || row.kind === "angle") {
      if (typeof value !== "number" || !Number.isFinite(value)) { out.push(`"${key}" = ${JSON.stringify(value)} is not a finite number`); continue; }
      if (row.min !== undefined && value < row.min) out.push(`"${key}" = ${value} is below the row min ${row.min}`);
      if (row.max !== undefined && value > row.max) out.push(`"${key}" = ${value} is above the row max ${row.max}`);
    } else if (row.kind === "color") {
      // An OBJECT is a full paint slot (gradient/material), not a colour literal,
      // and its own shape is not this check's business.
      if (typeof value !== "object" && !parsesAsColour(value))
        out.push(`"${key}" = ${JSON.stringify(value)} does not parse as a colour`);
    } else if (row.kind === "select" && Array.isArray(row.options)) {
      if (!row.options.includes(value))
        out.push(`"${key}" = ${JSON.stringify(value)} is not one of ${row.options.join("/")}`);
    } else if (row.kind === "boolean") {
      if (typeof value !== "boolean") out.push(`"${key}" = ${JSON.stringify(value)} is not a boolean`);
    }
  }
  return out;
}

test("every preset value is legal for its own Inspector row", () => {
  for (const entry of ALL) {
    const bad = rowViolations(entry.plugin, entry.preset.props);
    assert.deepEqual(bad, [],
      `${where(entry)}: ${bad.join("; ")} — the Inspector would refuse this value, so the preset writes state the user cannot then edit`);
  }
});

// ── (7) THE TWO HOISTED GATES MUST BE ABLE TO FAIL ───────────────────────────
// Four gates were found this round that could not fail, each proving only the
// case its author pictured. tests/square_chrome_test.js's answer is the house
// form and this copies it: run the gate's own logic against fixtures of every
// shape it claims to handle, rather than asserting its own correctness. These
// two now guard every preset in the roster, so a vacuous version would be a
// standing false green over the whole program.
const SELF_CHECK_PLUGIN = {
  type: "__self_check__",
  defaults: { count: 3, hue: "#ff0000", cap: "flat", on: true, label: "hi", span: 1 },
  inspector: [
    { key: "count", kind: "number", min: 1, max: 8 },
    { key: "span", kind: "number", min: 0 },
    { key: "hue", kind: "color" },
    { key: "cap", kind: "select", options: ["flat", "round", "taper"] },
    { key: "on", kind: "boolean" },
    { key: "label", kind: "text" }
  ]
};

test("(self-check) the two hoisted gates catch what they claim to and pass what they must", () => {
  const cases = [
    ["a placement key is caught", () => placementViolations({ tint: "#fff", rotation: 45 }).length === 1],
    ["every placement key is caught", () => placementViolations(Object.fromEntries(PLACEMENT_KEYS.map((k) => [k, 0]))).length === PLACEMENT_KEYS.length],
    ["a pure look map is passed", () => placementViolations({ bumps: 5, lobeDepth: 0.34 }).length === 0],
    ["w/h are deliberately NOT placement", () => placementViolations({ w: 100, h: "= self.w * 9 / 16" }).length === 0],
    ["effects are deliberately NOT placement", () => placementViolations({ blendMode: "screen", bloom: { radius: 14 } }).length === 0],
    ["a number above its max is caught", () => rowViolations(SELF_CHECK_PLUGIN, { count: 9 }).length === 1],
    ["a number below its min is caught", () => rowViolations(SELF_CHECK_PLUGIN, { count: 0 }).length === 1],
    ["a one-sided range checks only its declared side", () => rowViolations(SELF_CHECK_PLUGIN, { span: 1e6 }).length === 0],
    // NOT `"3"`: a bare string on a slot whose default is a number IS an equation
    // (core/expressions.isNumericSlot), so it is skipped here and caught instead
    // by the "=" marker check above. A non-string non-number has no such reading.
    ["a non-number on a number row is caught", () => rowViolations(SELF_CHECK_PLUGIN, { count: true }).length === 1],
    ["an unparseable colour is caught", () => rowViolations(SELF_CHECK_PLUGIN, { hue: "not a colour" }).length === 1],
    ["a paint OBJECT on a colour row is passed", () => rowViolations(SELF_CHECK_PLUGIN, { hue: { kind: "gradient" } }).length === 0],
    ["a value outside a select's options is caught", () => rowViolations(SELF_CHECK_PLUGIN, { cap: "bevel" }).length === 1],
    ["a non-boolean on a boolean row is caught", () => rowViolations(SELF_CHECK_PLUGIN, { on: 1 }).length === 1],
    ["a legal map is passed", () => rowViolations(SELF_CHECK_PLUGIN, { count: 4, hue: "#0f0", cap: "round", on: false, label: "x" }).length === 0],
    ["a key with no row is skipped, never failed", () => rowViolations(SELF_CHECK_PLUGIN, { pointsActive: [true, false] }).length === 0],
    ["a text row is not type-checked", () => rowViolations(SELF_CHECK_PLUGIN, { label: 42 }).length === 0],
    // Check (1)'s two seams, and specifically that widening to Inspector rows did
    // not widen it to everything. A row-without-a-default (the absent-is-legacy
    // trim keys) is DECLARED; a key in neither seam is still refused.
    ["a defaults key is declared", () => declaredKeys(SELF_CHECK_PLUGIN).has("count")],
    ["a row with no default is declared", () => declaredKeys({ defaults: {}, inspector: [{ key: "strokeStart" }] }).has("strokeStart")],
    ["a key in neither seam is NOT declared", () => !declaredKeys(SELF_CHECK_PLUGIN).has("pointsActive")]
  ];
  const broken = cases.filter(([, fn]) => !fn()).map(([name]) => name);
  assert.deepEqual(broken, [], `the gate does not do what it says: ${broken.join("; ")}`);
});

console.log(`\n${passed} preset contract tests passed`);
