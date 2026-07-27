/**
 * SHORTCUT REGISTRY guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/shortcut_registry_test.js
 *
 * WHY THIS EXISTS. The manifest invariant is that the shortcut registry is the
 * SINGLE source of truth for inputs: it BOTH dispatches keydowns AND feeds the
 * HintBar, so "a shortcut that isn't registered does not exist". The user's ruling
 * is the enforcement half — "if any part of our app violates that convention, it
 * needs to be solved now" — prompted by a real defect: multi-selection resize reads
 * Shift (uniform) and Cmd (symmetric), the modifiers CHANGE the outcome, and the
 * bar announced nothing.
 *
 * That defect was invisible to every existing test for two structural reasons, and
 * this file closes both:
 *   1. the entries lived inline in web/App.svelte, where no node test could reach
 *      them (they now live in core/shortcut_entries.js); and
 *   2. the only guard was a boot-time console.error walking a HAND-MAINTAINED list
 *      of drag kinds — a list that named "endpoint" (which nothing assigned) and
 *      omitted "multiresize" (which the multi-resize path always assigned). A
 *      hand-maintained list of context values was the root cause, so every axis is
 *      now DERIVED and this suite asserts the derivation holds.
 *
 * WHAT IT PROVES, over the REAL registered population (not a sample):
 *   (1) every entry's key tokens are ones dispatch() can actually match — the
 *       "Esc"/"Plus" class dies at registration;
 *   (2) every entry is SATISFIABLE: some reachable context makes its `when` true;
 *   (3) DRAG_KINDS covers every value CanvasView assigns to app.dragKind (scanned
 *       out of the source), and every declared kind is probed and worded;
 *   (4) the modifier chips for EVERY kind that reads modifiers actually appear —
 *       the direct regression test for the multiresize defect;
 *   (5) TRUTHFULNESS: where the app suppresses dispatch wholesale (a typing target,
 *       an open palette, an open dialog, present mode) the bar shows only entries
 *       CONDITIONAL on a takeover — no ordinary editor chip leaks in;
 *   (6) no context shows two visible chips on the same key combo with different
 *       labels (one of them would be a lie about which meaning wins).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShortcuts, validateShortcutKeys, RETIRED_KEY_TOKENS } from "../core/shortcuts.js";
import { createKeybindings } from "../core/keybindings.js";
import {
  KEYBINDING_DEFAULTS, KEYBINDING_LABELS, WHEN_RESOLVERS,
  handShortcutEntries, hintProbeContexts, canvasModeStepAxis, unsatisfiableEntries,
  SUPPRESSED_AXES, DRAG_MODIFIER_HINTS, ESC_CANCELABLE_DRAG_KINDS,
} from "../core/shortcut_entries.js";
import { DRAG_KINDS, DRAG_KIND_MODIFIERS } from "../web/canvas/dragKinds.js";
import { canvasModes } from "../web/widget_handlers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── the population under test: the registry exactly as App.svelte builds it ──
// wireShortcuts()'s one rewrite (paste rides the native ClipboardEvent) is mirrored
// so the set here IS the set the app registers.
const app = {};
const modes = canvasModes();
const kb = createKeybindings(KEYBINDING_DEFAULTS);
const bound = kb.toShortcutEntries(KEYBINDING_LABELS, WHEN_RESOLVERS)
  .map((e) => (e.command === "paste" ? { ...e, nativeEvent: true } : e));
const hand = handShortcutEntries({ app, canvasModes: modes, dragKindModifiers: DRAG_KIND_MODIFIERS });
const registry = createShortcuts();
for (const e of [...bound, ...hand]) registry.add(e); // add() validates tokens (1)
const entries = registry.all();
const contexts = hintProbeContexts({
  dragKinds: DRAG_KINDS,
  canvasModeIds: [null, ...modes.map((m) => m.handlerId)],
  // DERIVED from the modes' own step lists (canvasModeStepAxis), so a mode that
  // grows a step gets that step probed with no edit here — the same rule every
  // other axis follows, and the reason the multiresize defect cannot recur.
  canvasModeSteps: canvasModeStepAxis(modes),
  app,
});

/**
 * Pure function. The context with every SUPPRESSION and FOCUS axis cleared, but the
 * same ordinary editor state (mode/dragKind/crosshair/canvasMode/selection/drag).
 * An entry that is visible in a takeover context AND in its baseline is an ordinary
 * editor hint leaking into the takeover — the "26 chips while typing" defect.
 */
function baselineOf(ctx) {
  return {
    ...ctx,
    mode: "edit",
    typingTarget: false, dialogOpen: false, paletteOpen: false,
    textEditing: false, textEditingRich: false, latexEditing: false, codeEditing: false,
    numericField: null, numericFieldBounded: false,
  };
}

/** Pure function. Visible [keys, label] pairs for a context (what the bar renders). */
const visible = (ctx) => registry.hints(ctx);

// ── (1) key tokens ───────────────────────────────────────────────────────────
test("every registered entry's key tokens are ones dispatch() can match", () => {
  for (const e of entries) validateShortcutKeys(e.keys, e.label); // throws with the fix named
  assert.ok(entries.length > 0, "no entries registered — the population is empty");
});

test("retired key spellings are rejected at registration", () => {
  for (const [retired, replacement] of Object.entries(RETIRED_KEY_TOKENS))
    assert.throws(
      () => createShortcuts().add({ keys: [retired], label: "x", when: () => true }),
      new RegExp(`"${retired}" is RETIRED`),
      `registering the retired token "${retired}" must throw and name ${replacement}`,
    );
});

test("an unknown key token is rejected at registration", () => {
  assert.throws(
    () => createShortcuts().add({ keys: ["Cmd", "Wibble"], label: "x", when: () => true }),
    /Unknown shortcut key token "Wibble"/,
  );
});

test("a main key before the last position is rejected (dispatch reads keys[-1])", () => {
  assert.throws(
    () => createShortcuts().add({ keys: ["P", "Cmd"], label: "x", when: () => true }),
    /has "P" before the last position/,
  );
});

// ── (2) satisfiability ───────────────────────────────────────────────────────
test("every registered entry is satisfiable in some reachable context", () => {
  const dead = unsatisfiableEntries(entries, contexts);
  assert.deepEqual(
    dead.map((e) => `${e.keys.join("+")} — ${e.label}`),
    [],
    "an entry whose `when` no reachable context satisfies never dispatches and never shows in the HintBar, while looking alive in the source. Compose it from editBase / armed() / inCanvasMode() instead of ANDing editMode with a state editMode excludes.",
  );
});

// ── (3) the drag-kind vocabulary is DERIVED, not hand-maintained ─────────────
test("DRAG_KINDS covers every value CanvasView assigns to app.dragKind", () => {
  const src = fs.readFileSync(path.join(HERE, "../web/CanvasView.svelte"), "utf8");
  const assigned = [...src.matchAll(/app\.dragKind\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(assigned.length > 0, "found no app.dragKind assignments — the scan pattern went stale, which would make this guard vacuous");
  for (const kind of new Set(assigned))
    assert.ok(
      DRAG_KINDS.includes(kind),
      `CanvasView assigns app.dragKind = "${kind}" but DRAG_KIND_MODIFIERS (web/canvas/dragKinds.js) does not declare it — so it gets no modifier chips and the reachability prober never walks it. THIS is the multiresize defect.`,
    );
});

test("CanvasView reads ESC_CANCELABLE_DRAG_KINDS from core and keeps no second copy", () => {
  // This REPLACES a scan-based drift guard between two copies of the list (one
  // here, one declared locally in CanvasView). The guard worked — deliberately
  // diverging the two made it fail with the right message — but a drift guard can
  // only report a divergence that has already shipped, and the divergence it
  // guarded was avoidable: the component now IMPORTS the list, so the mechanism
  // (its capture-phase Escape listener) and the two entries that announce it read
  // the same array. What still needs asserting is that nobody re-introduces the
  // second copy, which is what this checks.
  const src = fs.readFileSync(path.join(HERE, "../web/CanvasView.svelte"), "utf8");
  assert.match(
    src, /import\s*\{[^}]*\bESC_CANCELABLE_DRAG_KINDS\b[^}]*\}\s*from\s*"\.\.\/core\/shortcut_entries\.js"/,
    "CanvasView must IMPORT ESC_CANCELABLE_DRAG_KINDS from core/shortcut_entries.js. Its capture-phase Escape listener and the registry's 'Cancel drag' / withheld-'Deselect' entries must read ONE list, or the bar goes silent on a gesture Escape really does cancel.",
  );
  assert.doesNotMatch(
    src, /(?:const|let|var)\s+ESC_CANCELABLE_DRAG_KINDS\s*=/,
    "CanvasView declares its OWN ESC_CANCELABLE_DRAG_KINDS again. That is the drift this import removed — delete the local copy rather than re-adding a guard over two of them.",
  );
  assert.ok(src.includes("ESC_CANCELABLE_DRAG_KINDS.includes("), "CanvasView no longer tests membership of the imported list — the scan went stale");
  for (const kind of ESC_CANCELABLE_DRAG_KINDS)
    assert.ok(DRAG_KINDS.includes(kind), `ESC_CANCELABLE_DRAG_KINDS names "${kind}", which is not a declared drag kind`);
});

test("Escape shows exactly one meaning during an Esc-cancelable drag", () => {
  for (const kind of ESC_CANCELABLE_DRAG_KINDS) {
    const ctx = contexts.find((c) => c.dragKind === kind && c.mode === "edit" && c.hasSelection
      && !c.crosshairArmed && !c.canvasMode && !c.modalActive && !c.typingTarget && !c.dialogOpen && !c.paletteOpen);
    assert.ok(ctx, `no probe context for an Esc-cancelable "${kind}" drag with a selection`);
    const escapes = visible(ctx).filter(([keys]) => keys.join("+") === "Escape").map(([, l]) => l);
    assert.deepEqual(escapes, ["Cancel drag"], `during a "${kind}" drag the bar must offer Escape ONLY as "Cancel drag" (CanvasView's capture listener claims it), got ${JSON.stringify(escapes)}`);
  }
});

test("every declared drag kind's modifiers have keys + wording", () => {
  for (const [kind, ids] of Object.entries(DRAG_KIND_MODIFIERS))
    for (const id of ids)
      assert.ok(DRAG_MODIFIER_HINTS[id], `drag kind "${kind}" declares modifier "${id}" with no DRAG_MODIFIER_HINTS entry`);
  for (const id of Object.keys(DRAG_MODIFIER_HINTS))
    assert.ok(
      Object.values(DRAG_KIND_MODIFIERS).some((ids) => ids.includes(id)),
      `DRAG_MODIFIER_HINTS declares "${id}" but no drag kind reads it`,
    );
});

test("every declared drag kind is walked by the reachability prober", () => {
  for (const kind of DRAG_KINDS)
    assert.ok(
      contexts.some((c) => c.dragKind === kind),
      `no probe context has dragKind === "${kind}" — a kind that is not probed cannot be proven to announce its modifiers`,
    );
});

// ── (4) the modifier chips actually appear (the V1 regression test) ───────────
test("each drag kind that reads modifiers announces exactly them", () => {
  for (const [kind, ids] of Object.entries(DRAG_KIND_MODIFIERS)) {
    // The band's verbs are announced while ARMED too, so probe it the way it is
    // reached: mid-drag, which both scopings accept.
    const ctx = contexts.find((c) => c.dragKind === kind && c.mode === "edit" && !c.crosshairArmed
      && !c.canvasMode && !c.modalActive && !c.typingTarget && !c.dialogOpen && !c.paletteOpen && c.dragging);
    assert.ok(ctx, `no plain mid-drag probe context for dragKind "${kind}"`);
    const shown = visible(ctx).map(([keys, label]) => `${keys.join("+")}|${label}`);
    for (const id of ids) {
      const want = `${DRAG_MODIFIER_HINTS[id].keys.join("+")}|${DRAG_MODIFIER_HINTS[id].label}`;
      assert.ok(shown.includes(want), `a "${kind}" drag reads modifier "${id}" but the HintBar does not show ${want}. Shown: ${JSON.stringify(shown)}`);
    }
  }
});

test("multi-selection resize announces Shift and Cmd (the reported defect)", () => {
  const ctx = contexts.find((c) => c.dragKind === "multiresize" && c.mode === "edit" && c.dragging
    && !c.crosshairArmed && !c.canvasMode && !c.modalActive && !c.typingTarget && !c.dialogOpen && !c.paletteOpen);
  const shown = visible(ctx).map(([keys, label]) => `${keys.join("+")}|${label}`);
  assert.ok(shown.includes("Shift|Uniform scale"), `multiresize must announce Shift. Shown: ${JSON.stringify(shown)}`);
  assert.ok(shown.includes("Cmd|Symmetric resize"), `multiresize must announce Cmd. Shown: ${JSON.stringify(shown)}`);
});

// ── (5) truthfulness where dispatch is suppressed ────────────────────────────
test("no entry the registry DISPATCHES is live where dispatch is suppressed", () => {
  const live = entries.filter((e) => (e.command || e.run) && !e.nativeEvent);
  for (const { axis, value } of SUPPRESSED_AXES)
    for (const ctx of contexts.filter((c) => c[axis] === value))
      for (const e of live)
        assert.ok(
          !e.when(ctx),
          `"${e.label}" (${e.keys.join("+")}) has a run/command and is live with ${axis} = ${JSON.stringify(value)}, but App.svelte's onKeydown returns before dispatch in that state (or another component claims the key) — so the chip is a promise the app cannot keep.`,
        );
});

test("chips shown during a takeover are conditional on that takeover", () => {
  for (const { axis, value } of SUPPRESSED_AXES)
    for (const ctx of contexts.filter((c) => c[axis] === value)) {
      const base = baselineOf(ctx);
      for (const e of entries.filter((x) => !x.hidden && x.when(ctx)))
        assert.ok(
          !e.when(base),
          `"${e.label}" (${e.keys.join("+")}) shows while ${axis} = ${JSON.stringify(value)} AND in the identical context without it — so it is an ordinary editor hint leaking into a takeover, not something scoped to it. This is the "26 chips while typing, 6 of them real" defect: keys the user can press to no effect.`,
        );
    }
});

// ── (6) one key, one meaning, per context ────────────────────────────────────
test("no context shows two visible chips on one key combo with different labels", () => {
  for (const ctx of contexts) {
    const byCombo = new Map();
    for (const [keys, label] of visible(ctx)) {
      const combo = keys.join("+");
      const seen = byCombo.get(combo);
      if (seen && seen !== label)
        assert.fail(`context ${JSON.stringify({ mode: ctx.mode, dragKind: ctx.dragKind, crosshairArmed: ctx.crosshairArmed, canvasMode: ctx.canvasMode, paletteOpen: ctx.paletteOpen, modalActive: ctx.modalActive, typingTarget: ctx.typingTarget, dialogOpen: ctx.dialogOpen, numericField: ctx.numericField, dragging: ctx.dragging, hasSelection: ctx.hasSelection })} shows "${combo}" twice with different labels ("${seen}" and "${label}") — only one of them can fire, so the other is the bar lying about which meaning wins.`);
      byCombo.set(combo, label);
    }
  }
});

console.log(`\n${passed} shortcut-registry tests passed (${entries.length} entries × ${contexts.length} contexts)`);
