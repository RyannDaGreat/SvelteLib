/**
 * Keybinding registry tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/keybindings_test.js
 * core/keybindings.js being DOM-free is itself under test: any
 * window/document/localStorage reference would crash this file.
 */

import assert from "node:assert/strict";
import {
  createKeybindings, normalizeCombo, comboEquals, comboToDisplayString, whensOverlap,
} from "../core/keybindings.js";
import { createShortcuts } from "../core/shortcuts.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
/** Runs fn with console.warn captured; returns the warning strings. */
function capturedWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original; // restore even when fn throws (throw still propagates)
  }
  return warnings;
}

const DEFAULTS = [
  { command: "undo", keys: ["Ctrl", "Z"], when: "editMode" },
  { command: "put-on-top", keys: ["Cmd", "Shift", "F"], when: "editMode" },
  { command: "put-on-bottom", keys: ["Cmd", "Shift", "B"], when: "editMode" },
  { command: "toggle-palette", keys: ["Cmd", "Shift", "P"] }, // no when = always
];

// ── pure helpers ─────────────────────────────────────────────────────────────
test("normalizeCombo: canonical Cmd,Ctrl,Alt,Shift order + aliases + casing", () => {
  assert.deepEqual(normalizeCombo(["shift", "cmd", "f"]), ["Cmd", "Shift", "F"]);
  assert.deepEqual(normalizeCombo(["Shift", "Alt", "Ctrl", "Cmd", "x"]), ["Cmd", "Ctrl", "Alt", "Shift", "X"]);
  assert.deepEqual(normalizeCombo(["meta", "z"]), ["Cmd", "Z"]);
  assert.deepEqual(normalizeCombo(["option", "escape"]), ["Alt", "Escape"]);
  assert.deepEqual(normalizeCombo(["control", "F5"]), ["Ctrl", "F5"]);
  assert.deepEqual(normalizeCombo(["Backspace"]), ["Backspace"]);
  assert.deepEqual(normalizeCombo([" ctrl ", " z "]), ["Ctrl", "Z"]); // whitespace tolerated
});
test("normalizeCombo is loud on malformed combos", () => {
  assert.throws(() => normalizeCombo([]), /non-empty array/);
  assert.throws(() => normalizeCombo("Ctrl+Z"), /non-empty array/);
  assert.throws(() => normalizeCombo(["Ctrl", "Shift"]), /exactly one non-modifier/);
  assert.throws(() => normalizeCombo(["Ctrl", "A", "B"]), /exactly one non-modifier/);
  assert.throws(() => normalizeCombo(["Ctrl", "ctrl", "Z"]), /Duplicate modifier/);
  assert.throws(() => normalizeCombo(["Ctrl", 5]), /non-empty string/);
  assert.throws(() => normalizeCombo(["Ctrl", ""]), /non-empty string/);
});
test("comboEquals: order/alias/case-insensitive", () => {
  assert.ok(comboEquals(["Shift", "Cmd", "F"], ["cmd", "shift", "f"]));
  assert.ok(comboEquals(["meta", "Z"], ["Cmd", "z"]));
  assert.ok(!comboEquals(["Ctrl", "Z"], ["Ctrl", "Shift", "Z"]));
  assert.ok(!comboEquals(["Ctrl", "Z"], ["Cmd", "Z"])); // Cmd/Ctrl distinct combos (dispatch conflates; registry doesn't)
});
test("comboToDisplayString", () => {
  assert.equal(comboToDisplayString(["shift", "cmd", "f"]), "Cmd+Shift+F");
  assert.equal(comboToDisplayString(["Backspace"]), "Backspace");
});
test("whensOverlap: same/unscoped overlap, different names don't", () => {
  assert.ok(whensOverlap("editMode", "editMode"));
  assert.ok(whensOverlap("editMode", undefined));
  assert.ok(whensOverlap(undefined, undefined));
  assert.ok(!whensOverlap("editMode", "presentMode"));
});

// ── construction ─────────────────────────────────────────────────────────────
test("createKeybindings is loud on malformed defaults", () => {
  assert.throws(() => createKeybindings([{ keys: ["Ctrl", "Z"] }]), /command id/);
  assert.throws(
    () => createKeybindings([{ command: "a", keys: ["Ctrl", "Z"] }, { command: "a", keys: ["Ctrl", "Y"] }]),
    /Duplicate default/,
  );
  assert.throws(() => createKeybindings([{ command: "a", keys: ["Ctrl"] }]), /exactly one non-modifier/);
  assert.throws(() => createKeybindings([{ command: "a", keys: ["Ctrl", "Z"], when: 5 }]), /context-flag name/);
});
test("createKeybindings rejects conflicting defaults; distinct whens coexist", () => {
  assert.throws( // same combo, same when
    () => createKeybindings([
      { command: "a", keys: ["Ctrl", "Z"], when: "editMode" },
      { command: "b", keys: ["ctrl", "z"], when: "editMode" }, // alias/case still collides
    ]),
    /Conflicting default/,
  );
  assert.throws( // same combo, one unscoped (overlaps everything)
    () => createKeybindings([
      { command: "a", keys: ["Ctrl", "Z"], when: "editMode" },
      { command: "b", keys: ["Ctrl", "Z"] },
    ]),
    /Conflicting default/,
  );
  const kb = createKeybindings([ // same combo, disjoint named contexts — fine
    { command: "prev-slide", keys: ["Left"], when: "editMode" },
    { command: "step-back", keys: ["Left"], when: "presentMode" },
  ]);
  assert.deepEqual(kb.bindingFor("step-back"), ["Left"]);
});

// ── operations ───────────────────────────────────────────────────────────────
test("bindingFor: defaults, normalization, unknown command throws", () => {
  const kb = createKeybindings(DEFAULTS);
  assert.deepEqual(kb.bindingFor("put-on-top"), ["Cmd", "Shift", "F"]);
  assert.throws(() => kb.bindingFor("nope"), /Unknown command "nope"/);
});
test("bind: override, conflict blocks without force, force clobbers", () => {
  const kb = createKeybindings(DEFAULTS);
  assert.equal(kb.bind("put-on-top", ["cmd", "k"]), null); // clean rebind, input normalized
  assert.deepEqual(kb.bindingFor("put-on-top"), ["Cmd", "K"]);
  assert.equal(kb.bind("put-on-bottom", ["Cmd", "K"]), "put-on-top"); // reports conflict...
  assert.deepEqual(kb.bindingFor("put-on-bottom"), ["Cmd", "Shift", "B"]); // ...and does NOT clobber
  assert.equal(kb.bind("put-on-bottom", ["Cmd", "K"], { force: true }), "put-on-top"); // reports what it clobbered
  assert.deepEqual(kb.bindingFor("put-on-bottom"), ["Cmd", "K"]);
  assert.equal(kb.bindingFor("put-on-top"), null); // loser unbound, not silently shadowed
});
test("bind: conflicts respect when-scoping; loud on bad input", () => {
  const kb = createKeybindings(DEFAULTS);
  assert.equal(kb.bind("toggle-palette", ["Ctrl", "Z"]), "undo"); // unscoped overlaps editMode
  const kb2 = createKeybindings([
    { command: "prev-slide", keys: ["Left"], when: "editMode" },
    { command: "step-back", keys: ["Right"], when: "presentMode" },
  ]);
  assert.equal(kb2.bind("step-back", ["Left"]), null); // disjoint contexts: no conflict
  assert.throws(() => kb.bind("nope", ["Ctrl", "K"]), /Unknown command/);
  assert.throws(() => kb.bind("undo", ["Ctrl"]), /exactly one non-modifier/);
});
test("bind back to the default keys drops the override (nothing to persist)", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.bind("undo", ["Cmd", "U"]);
  assert.equal(kb.bind("undo", ["ctrl", "z"]), null);
  assert.deepEqual(kb.serializeOverrides(), {});
  assert.equal(kb.allBindings().find((b) => b.command === "undo").overridden, false);
});
test("unbind + reset + resetAll", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.unbind("undo");
  assert.equal(kb.bindingFor("undo"), null);
  assert.deepEqual(kb.serializeOverrides(), { undo: null }); // unbinding persists
  kb.reset("undo");
  assert.deepEqual(kb.bindingFor("undo"), ["Ctrl", "Z"]);
  kb.bind("put-on-top", ["Cmd", "1"]);
  kb.unbind("put-on-bottom");
  kb.resetAll();
  assert.deepEqual(kb.serializeOverrides(), {});
  assert.deepEqual(kb.bindingFor("put-on-top"), ["Cmd", "Shift", "F"]);
  assert.deepEqual(kb.bindingFor("put-on-bottom"), ["Cmd", "Shift", "B"]);
  assert.throws(() => kb.unbind("nope"), /Unknown command/);
  assert.throws(() => kb.reset("nope"), /Unknown command/);
});
test("reset warns when the restored default collides with an override", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.bind("put-on-top", ["Ctrl", "Z"], { force: true }); // steals undo's default; undo unbound
  const warnings = capturedWarnings(() => kb.reset("undo"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"undo" and "put-on-top" are both bound to Ctrl\+Z/); // pair named in registration order
});
test("allBindings: defaults merged with overrides, declaration order", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.bind("put-on-top", ["Cmd", "K"]);
  kb.unbind("undo");
  assert.deepEqual(kb.allBindings(), [
    { command: "undo", keys: null, when: "editMode", overridden: true },
    { command: "put-on-top", keys: ["Cmd", "K"], when: "editMode", overridden: true },
    { command: "put-on-bottom", keys: ["Cmd", "Shift", "B"], when: "editMode", overridden: false },
    { command: "toggle-palette", keys: ["Cmd", "Shift", "P"], when: undefined, overridden: false },
  ]);
});

// ── persistence ──────────────────────────────────────────────────────────────
test("override persistence round-trip through JSON", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.bind("put-on-top", ["Cmd", "K"]);
  kb.unbind("undo");
  const json = JSON.parse(JSON.stringify(kb.serializeOverrides())); // as via localStorage
  assert.deepEqual(json, { "put-on-top": ["Cmd", "K"], undo: null }); // ONLY overrides, never defaults
  const kb2 = createKeybindings(DEFAULTS);
  kb2.loadOverrides(json);
  assert.deepEqual(kb2.allBindings(), kb.allBindings());
});
test("loadOverrides: unknown commands warned + skipped, replaces prior overrides", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.bind("put-on-bottom", ["Cmd", "2"]); // must NOT survive the load below
  const warnings = capturedWarnings(() => kb.loadOverrides({ "renamed-away": ["Cmd", "K"], undo: ["Cmd", "U"] }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown command "renamed-away"/);
  assert.deepEqual(kb.bindingFor("undo"), ["Cmd", "U"]);
  assert.deepEqual(kb.bindingFor("put-on-bottom"), ["Cmd", "Shift", "B"]);
});
test("loadOverrides: malformed keys throw and apply NOTHING; non-object throws", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.bind("undo", ["Cmd", "U"]);
  assert.throws(() => kb.loadOverrides({ "put-on-top": ["Ctrl"] }), /exactly one non-modifier/);
  assert.throws(() => kb.loadOverrides({ "put-on-top": "Ctrl+K" }), /non-empty array/);
  assert.deepEqual(kb.bindingFor("undo"), ["Cmd", "U"]); // prior overrides intact (all-or-nothing)
  assert.throws(() => kb.loadOverrides(null), /plain \{command/);
  assert.throws(() => kb.loadOverrides([["undo", ["Cmd", "U"]]]), /plain \{command/);
});
test("loadOverrides warns on conflicts smuggled in by hand-edited storage", () => {
  const kb = createKeybindings(DEFAULTS);
  const warnings = capturedWarnings(() => kb.loadOverrides({ "put-on-top": ["Ctrl", "Z"] })); // collides with undo default
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /both bound to Ctrl\+Z/);
});

// ── bridge to the shortcut registry ──────────────────────────────────────────
test("toShortcutEntries: shapes, when-resolvers, unbound skipped, loud on gaps", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.unbind("put-on-bottom");
  const labels = { undo: "Undo", "put-on-top": "Put on Top", "toggle-palette": "Palette" };
  const resolvers = { editMode: (c) => c.mode === "edit" };
  const entries = kb.toShortcutEntries(labels, resolvers);
  assert.deepEqual(entries.map((e) => e.command), ["undo", "put-on-top", "toggle-palette"]); // unbound skipped
  const top = entries.find((e) => e.command === "put-on-top");
  assert.deepEqual(top.keys, ["Cmd", "Shift", "F"]);
  assert.equal(top.label, "Put on Top");
  assert.equal(top.when({ mode: "edit" }), true);
  assert.equal(top.when({ mode: "present" }), false);
  assert.equal(entries.find((e) => e.command === "toggle-palette").when({}), true); // no when = always
  assert.throws(() => kb.toShortcutEntries({ undo: "Undo" }, resolvers), /no label for command "put-on-top"/);
  assert.throws(() => kb.toShortcutEntries(labels, {}), /no when-resolver named "editMode"/);
});
test("bridge end-to-end: entries feed createShortcuts, dispatch runs the command", () => {
  const kb = createKeybindings(DEFAULTS);
  kb.bind("put-on-top", ["Cmd", "T"]); // an override must dispatch, not the default
  const labels = { undo: "Undo", "put-on-top": "Put on Top", "put-on-bottom": "Put on Bottom", "toggle-palette": "Palette" };
  const sc = createShortcuts();
  for (const e of kb.toShortcutEntries(labels, { editMode: (c) => c.mode === "edit" })) sc.add(e);
  const ran = [];
  const ctx = { mode: "edit", app: { runCommand: (id) => ran.push(id) } };
  const cmdT = { key: "t", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
  assert.ok(sc.dispatch(cmdT, ctx));
  const oldDefault = { key: "f", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
  assert.ok(!sc.dispatch(oldDefault, ctx)); // Cmd+Shift+F no longer bound
  assert.ok(!sc.dispatch(cmdT, { ...ctx, mode: "present" })); // when-scoping holds
  assert.deepEqual(ran, ["put-on-top"]);
  assert.equal(sc.commandKeys("put-on-top").join("+"), "Cmd+T"); // palette key display sees the override
  assert.equal(sc.hints(ctx).length, 4);
});

console.log(`\n${passed} tests passed`);
