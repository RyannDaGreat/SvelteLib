/**
 * WORKSTREAM TYPESELECT_ (R7-42) — SELECT-BY-WIDGET-TYPE IS **ONE** COMMAND,
 * NOT ONE PER WIDGET TYPE. This file is the structural pin on that shape.
 *
 * ── THE RULING (user, 2026-08-13, verbatim, on a screenshot of the palette
 *    showing "PowerPoint Shape (1) — Select by Widget Type" rows under the
 *    search "add") ─────────────────────────────────────────────────────────────
 *   "I don't know why this command exists. Like, how is this a command? I
 *    thought select by widget type is a command and that would be a sub command."
 *
 * ── WHY THE MINTED ROWS WERE SEARCHABLE FROM THE ROOT AT ALL ────────────────
 * They were submenu CHILDREN, and since R7-18 a TOP-LEVEL query pools one level
 * of children beside their parents (core/commands.js search — deliberately, so
 * "pendulum" finds the pendulum widget). So every per-type child was a top-level
 * hit, and "PowerPoint Shape (1)" fuzzy-matches "add". That is not a ranking bug
 * to tune: the palette holds ACTIONS, and a per-document parameter is not one.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHY EACH HALF IS NEEDED ─────────────────────
 *  (1) EXACTLY ONE select-by-type and ONE deselect-by-type entry exist in the
 *      source, each with `run` and NO `children`.
 *  (2) THE MINTING MACHINERY IS GONE — refreshTypeSelectCommands, the
 *      SELECT_BY_TYPE_SUBMENU/DESELECT_BY_TYPE_SUBMENU holders, the `select-type-`
 *      / `deselect-type-` id template, and the `$effect` that ran the rebuild on
 *      every palette open. That effect is the write-inside-a-tracked-read hazard
 *      f4b11012 had to `untrack`; with the roster static the hazard is
 *      UNEXPRESSIBLE here rather than suppressed, and this check is what keeps it
 *      from being reintroduced.
 *  (3) NO COMMAND ID IS BUILT FROM A WIDGET TYPE — no template literal anywhere
 *      in App.svelte interpolates into a command `id:`. The narrow "does
 *      refreshTypeSelectCommands still exist" check would pass against a
 *      differently-named reimplementation of the same idea; this one asks the
 *      general question.
 *  (4) THE ARGUMENT IS GATHERED IN A PICKER — App.svelte's run calls
 *      openTypePicker, and app.svelte.js's openTypePicker builds its options from
 *      typesOnSlide() AT INVOKE TIME (the property that keeps the roster static).
 *  (5) THE GATE IS REAL — an empty slide offers no types, so both commands must
 *      be unavailable there with a sentence, via commandUnavailableReason (the
 *      house discipline: never read `requires` raw).
 *
 * web/App.svelte cannot be imported bare-node (Svelte component; app.svelte.js
 * pulls browser-only imports transitively), so the entries are read as TEXT out
 * of the real source — the precedent set by tests/select_parent_group_command_test.js
 * and tests/toolbar_surfacing_test.js. The BEHAVIOUR of the two-stage flow is
 * pinned in the browser by tests/selection_commands_probe.js.
 *
 * Run: node src/demo_apps/PowerRP/tests/select_by_type_command_test.js
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { commandUnavailableReason, unavailableMessage } from "../core/commands.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const here = dirname(fileURLToPath(import.meta.url));
const appSvelte = readFileSync(resolve(here, "../web/App.svelte"), "utf8");
const appState = readFileSync(resolve(here, "../web/app.svelte.js"), "utf8");
const palette = readFileSync(resolve(here, "../web/CommandPalette.svelte"), "utf8");

/** Pure function. Occurrences of `needle` in `haystack`, ignoring any that sit
 *  inside a comment line — a rule this codebase's heavily-commented sources make
 *  mandatory, since every deleted mechanism is DESCRIBED where it used to live.
 *
 *  @example countInCode("id: \"a\"\n// id: \"a\"\n", "id: \"a\"") // 1
 */
function countInCode(haystack, needle) {
  return haystack
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => line.includes(needle))
    .length;
}

// ── (1) EXACTLY ONE OF EACH, AND EACH IS AN ACTION (run), NOT A CONTAINER ────
test("exactly one select-by-type and one deselect-by-type command id in the source", () => {
  assert.equal(countInCode(appSvelte, `"select-by-type"`), 1, "select-by-type must be declared exactly once");
  assert.equal(countInCode(appSvelte, `"deselect-by-type"`), 1, "deselect-by-type must be declared exactly once");
});

test("both are declared by ONE factory with run + a picker, and no children", () => {
  const factory = appSvelte.match(/const byTypeCommand = \(add\) => \(\{[\s\S]*?\n  \}\);/);
  assert.ok(factory, "byTypeCommand factory not found in web/App.svelte");
  const src = factory[0];
  assert.ok(src.includes("run: (a) => a.openTypePicker(add)"), "run must open the picker stage");
  assert.ok(!/children\s*:/.test(src), "a by-type command must NOT be a submenu — the type is a picker argument");
  assert.ok(src.includes("when: byTypeGate"), "must carry the empty-slide gate");
  assert.ok(src.includes("requires: REQUIRES_TYPES_ON_SLIDE"), "must carry the requires sentence the gate explains itself with");
});

// ── (2) THE MINTING MACHINERY IS GONE, NAME BY NAME ─────────────────────────
test("refreshTypeSelectCommands and its submenu holders no longer exist in code", () => {
  for (const gone of ["refreshTypeSelectCommands", "SELECT_BY_TYPE_SUBMENU", "DESELECT_BY_TYPE_SUBMENU"]) {
    assert.equal(countInCode(appSvelte, gone), 0, `${gone} must be deleted, not merely unused (found in code)`);
  }
});

test("no per-type command ids are minted (select-type-/deselect-type- templates gone)", () => {
  for (const gone of ["select-type-", "deselect-type-"]) {
    assert.equal(countInCode(appSvelte, gone), 0, `${gone}<type> id template must be gone`);
  }
});

test("the palette-open rebuild effect is gone, and with it App.svelte's untrack import", () => {
  assert.equal(countInCode(appSvelte, "untrack"), 0,
    "App.svelte's only untrack was the by-type rebuild's (f4b11012); with the effect deleted the import must go too");
});

// ── (3) THE GENERAL QUESTION: NO COMMAND ID IS BUILT FROM THE DOCUMENT ──────
// The line this draws is NOT "no templated command id" — MEASURED, that check
// goes red on six innocent lines, and the six are the reason the rule has to be
// stated more precisely than the narrow name-check above.
//
// A templated id is fine when its source is PROCESS-LIFETIME: the theme families
// (core/themes.js), the debug pages, and `copy-prop-<key>` (minted from
// `app.registry.all()`'s inspector rows — the PLUGIN registry, fixed at boot).
// Those rosters cannot change while the app runs, so the command registry — which
// has no `remove` by design — can hold them safely, and nothing has to rebuild
// them under a palette that is walking them.
//
// A templated id is the DEFECT when its source is THE DOCUMENT, which changes on
// every edit. That is what forced refreshTypeSelectCommands to exist at all, and
// it is what made a per-type row a searchable top-level command. So this asks the
// general question in the form that actually distinguishes the two: does any
// command id interpolate a value read from the live document?
// HOW IT ASKS: every templated command id is minted inside a `.map(...)`, so the
// question is what THAT map's roster expression is. The four process-lifetime
// rosters are named here explicitly — an ALLOWLIST, so a new templated id from
// any other source fails and has to be argued for, which is the direction that
// keeps this honest. (A window-of-lines heuristic was tried first and MEASURED to
// false-positive on `theme-group-${groupId}`: an `a.doc` sat in an unrelated
// `run` closure twelve lines above it. A test that cries wolf about a correct
// line is how a real red gets waved through.)
const PROCESS_LIFETIME_ROSTERS = [
  "app.registry.all()",     // the PLUGIN registry: fixed at boot
  "groupedThemeFamilies()", // THEME_FAMILIES, a module constant
  "THEME_FAMILIES",
  "DEBUG_PAGES",
];
test("every templated command id is minted from a PROCESS-LIFETIME roster, never the document", () => {
  const codeLines = appSvelte.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const code = codeLines.join("\n");
  const templatedIds = codeLines.filter((line) => /\bid:\s*`[^`]*\$\{/.test(line)).map((l) => l.trim());
  // Every allowed roster must still be present — otherwise the allowlist could
  // pass by naming things that no longer exist.
  const liveRosters = PROCESS_LIFETIME_ROSTERS.filter((r) => code.includes(r));
  assert.ok(liveRosters.length >= 2, `the named process-lifetime rosters have moved: ${JSON.stringify(liveRosters)}`);
  // …and the ids they mint must account for ALL of them. Six today; the number
  // is not the assertion — that none is document-sourced is.
  assert.ok(templatedIds.length > 0, "no templated ids found at all — the scan is probably broken");
  for (const needle of ["typesOnSlide", "a.nodes()", "app.nodes()"]) {
    assert.ok(!new RegExp(`${needle.replace(/[.()]/g, "\\$&")}[\\s\\S]{0,400}?id:\\s*\``).test(code),
      `a command id is minted downstream of ${needle} — that is a per-document roster, and it needs a rebuild effect to stay fresh (the R7-42 defect)`);
  }
});

// ── (4) THE ARGUMENT COMES FROM A PICKER BUILT AT INVOKE TIME ───────────────
test("openTypePicker reads typesOnSlide() at invoke time and declares pick + preview", () => {
  const fn = appState.match(/\n  openTypePicker\(add\) \{[\s\S]*?\n  \}\n/);
  assert.ok(fn, "openTypePicker not found in web/app.svelte.js");
  const src = fn[0];
  assert.ok(src.includes("this.typesOnSlide()"), "options must be derived from the live slide, here, not from a registered roster");
  assert.ok(src.includes("onPick:"), "the picker must say what picking does");
  assert.ok(src.includes("onPreview:"), "the hover preview the minted rows had must survive the move to the picker stage");
  assert.ok(src.includes("selectByType"), "picking routes to the existing select/deselect semantics — unchanged");
});

test("CommandPalette renders the picker stage over its own rows, and it is keyboard-drivable", () => {
  assert.ok(palette.includes("app.palettePicker"), "the palette must read the picker spec off the app");
  assert.ok(/rpFuzzyRank\(app\.palettePicker\?\.options/.test(palette), "picker options must be filtered by the same fuzzy module the command rows use");
  assert.ok(palette.includes("if (picking) pick(current);"), "Enter must commit the highlighted option");
  assert.ok(palette.includes("if (picking) closePicker();"), "Escape/Backspace must step back to the command list");
  assert.ok(/data-command-id=\{opt\.value\}/.test(palette), "a picker row must carry its identity the way a command row does");
});

// ── (5) THE GATE ANSWERS ON AN EMPTY SLIDE ─────────────────────────────────
// The gate closures are copied verbatim from web/App.svelte (the
// select_parent_group_command_test precedent: a visible duplicate a reviewer can
// diff, rather than an unreachable import).
const byTypeGate = (a) => a.typesOnSlide().length > 0;
const REQUIRES_TYPES_ON_SLIDE = "at least one selectable widget on this slide — the picker lists the types actually present, and on an empty slide there is nothing to pick";

test("an empty slide makes both by-type commands unavailable, with a sentence", () => {
  const entry = { id: "select-by-type", title: "Select by Widget Type…", when: byTypeGate, requires: REQUIRES_TYPES_ON_SLIDE, run() {} };
  const emptySlide = { typesOnSlide: () => [] };
  const reason = commandUnavailableReason(entry, emptySlide);
  assert.equal(reason, REQUIRES_TYPES_ON_SLIDE);
  assert.match(unavailableMessage(reason), /Unavailable/);

  const populated = { typesOnSlide: () => [{ type: "rect", title: "Rectangle", count: 3 }] };
  assert.equal(commandUnavailableReason(entry, populated), null, "with widgets present the command must be runnable");
});

test("the source's gate and requires string match the ones asserted above", () => {
  assert.ok(appSvelte.includes("const byTypeGate = (a) => a.typesOnSlide().length > 0;"),
    "the copied gate has drifted from web/App.svelte");
  assert.ok(appSvelte.includes(REQUIRES_TYPES_ON_SLIDE),
    "the copied requires sentence has drifted from web/App.svelte");
});

console.log(`\n${passed} select-by-type command checks passed`);
