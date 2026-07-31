/**
 * GOD RAYS FIRST-USE BUG — bare-node regression suite for the shipped defect:
 * "demo_god_rays b405eaa4": failed to emit — materialBackdrop: param "lightOffsetX"
 * is a non-finite number (NaN)", hit on the VERY FIRST insert of a fresh widget.
 *
 * Three claims, matching the three suspects in the bug report:
 *   (1) ROOT CAUSE — the plugin default's expected equation-result KIND. A leading
 *       "=" sends resultKindForSlot past isNumericSlot (which only recognizes a BARE
 *       self.-prefixed string) so it infers "string" instead of "number", and a
 *       correctly-computing equation is then rejected as a kind mismatch. This is
 *       provable directly against core/expressions.js with no document/evaluator
 *       involved at all — the smallest possible reproduction of the shipped bug.
 *   (2) STALE-ITEM HEALING — an item created during the broken window (missing the
 *       light keys outright, since insert-time evaluation never got to persist them)
 *       must have them FILLED by repair, not left broken forever.
 *   (3) THE LANDING BAR — emit() must never hand a non-finite param to
 *       materialBackdrop's validator; an absent/unresolvable light degrades to the
 *       widget's own centre, logged once by name.
 *
 * The end-to-end insert->render->reload path lives in the browser probe
 * (god_rays_insert_probe.mjs) — this file covers what a bare-node test can prove
 * cheaply and precisely.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isNumericSlot, resultKindForSlot, evaluateState } from "../core/expressions.js";
import { missingDefaults, withMissingDefaultsFilled } from "../core/document.js";
import { godRaysPlugin } from "../plugins/demo/god_rays.js";
import { lensFlarePlugin } from "../plugins/demo/lens_flare.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

const registry = createRegistry();
registerAll(registry, createCommands());

// ── (1) ROOT CAUSE: the leading-"=" trap, proven against the CURRENT plugin ────

test("god_rays lightWorldX/Y defaults are BARE self.-prefixed (no leading '='), the numeric-slot form", () => {
  assert.match(godRaysPlugin.defaults.lightWorldX, /^self\./);
  assert.match(godRaysPlugin.defaults.lightWorldY, /^self\./);
  assert.equal(isNumericSlot(godRaysPlugin, ["lightWorldX"]), true);
  assert.equal(isNumericSlot(godRaysPlugin, ["lightWorldY"]), true);
  assert.equal(resultKindForSlot(godRaysPlugin, ["lightWorldX"], godRaysPlugin.defaults.lightWorldX), "number");
});

test("REGRESSION PROOF: the shipped leading-'=' form resolves to kind \"string\", which is the exact defect", () => {
  // This is not a live code path any more (the plugin default is fixed) — it proves
  // the MECHANISM that broke a fresh insert, so a future edit that reintroduces a
  // leading "=" on a self.-prefixed default is caught by re-reading this assertion,
  // not just by re-triggering the bug in the browser.
  const brokenDefault = "= self.x + 0.5 * self.w";
  assert.equal(isNumericSlot({ defaults: { lightWorldX: brokenDefault } }, ["lightWorldX"]), false,
    "a leading '=' is not the bare self.-prefix form isNumericSlot recognizes");
  assert.equal(resultKindForSlot({ defaults: { lightWorldX: brokenDefault } }, ["lightWorldX"], brokenDefault), "string",
    "resultKindForSlot infers \"string\" from the default's own shape once isNumericSlot says no — this is what rejected a correctly-computed NUMBER at evaluation and produced the NaN");
});

test("lens_flare's lightWorldX/Y (the sibling this design is copied from) are ALSO bare-form", () => {
  assert.doesNotMatch(lensFlarePlugin.defaults.lightWorldX, /^\s*=/);
  assert.doesNotMatch(lensFlarePlugin.defaults.lightWorldY, /^\s*=/);
});

// ── fresh insert: the equation actually resolves to finite numbers, no errors ──

test("a FRESH god_rays item (plugin defaults, unmodified) evaluates lightWorldX/Y to finite numbers with zero errors", () => {
  const state = { items: { a: { ...godRaysPlugin.defaults, id: "a" } }, vars: {} };
  const { state: evaluated, errors } = evaluateState(state, registry, "");
  assert.deepEqual([...errors.entries()], []);
  assert.equal(typeof evaluated.items.a.lightWorldX, "number");
  assert.ok(Number.isFinite(evaluated.items.a.lightWorldX));
  assert.equal(typeof evaluated.items.a.lightWorldY, "number");
  assert.ok(Number.isFinite(evaluated.items.a.lightWorldY));
  // The docblock's own claim: upper-middle of the box (x + 0.5w, y + 0.18h).
  assert.equal(evaluated.items.a.lightWorldX, godRaysPlugin.defaults.x + 0.5 * godRaysPlugin.defaults.w);
  assert.equal(evaluated.items.a.lightWorldY, godRaysPlugin.defaults.y + 0.18 * godRaysPlugin.defaults.h);
});

test("emit() on a freshly-evaluated fresh item produces finite light-offset params", () => {
  const state = { items: { a: { ...godRaysPlugin.defaults, id: "a" } }, vars: {} };
  const { state: evaluated } = evaluateState(state, registry, "");
  const ops = godRaysPlugin.emit(evaluated.items.a);
  assert.equal(ops[0].op, "materialBackdrop");
  assert.ok(Number.isFinite(ops[0].params.lightOffsetX));
  assert.ok(Number.isFinite(ops[0].params.lightOffsetY));
});

// ── (2) STALE-ITEM HEALING ──────────────────────────────────────────────────────

test("STALE ITEM (created during the broken window, missing lightWorldX/Y entirely) is reported missing and FILLED on repair", () => {
  const staleItem = { type: "demo_god_rays", x: 60, y: 60, w: 1000, h: 620, z: 200 };
  const doc = { slides: [{ delta: { items: { a: staleItem } } }] };

  const report = missingDefaults(doc, registry).find((r) => r.id === "a");
  assert.ok(report, "a stale god_rays item missing its light keys must be reported");
  const missingPaths = report.missing.map((m) => m.path.join("."));
  assert.ok(missingPaths.includes("lightWorldX"), "lightWorldX must be reported missing");
  assert.ok(missingPaths.includes("lightWorldY"), "lightWorldY must be reported missing");

  const { doc: healed } = withMissingDefaultsFilled(doc, registry);
  const healedItem = healed.slides[0].delta.items.a;
  assert.equal(healedItem.lightWorldX, godRaysPlugin.defaults.lightWorldX);
  assert.equal(healedItem.lightWorldY, godRaysPlugin.defaults.lightWorldY);

  // And it must actually EVALUATE to a finite number afterward — filled-but-broken
  // would not count as healed.
  const state = { items: { a: { ...healedItem, id: "a" } }, vars: {} };
  const { state: evaluated, errors } = evaluateState(state, registry, "");
  assert.deepEqual([...errors.entries()], []);
  assert.ok(Number.isFinite(evaluated.items.a.lightWorldX));
  assert.ok(Number.isFinite(evaluated.items.a.lightWorldY));

  // IDEMPOTENT: a second repair pass has nothing left to report for this item.
  const secondPass = missingDefaults(healed, registry).find((r) => r.id === "a");
  assert.equal(secondPass, undefined, "a healed item must not be reported missing again");
});

test("rotationAnchor.{x,y} still skip the fill (the derivation-stage fallback is genuine — unlike lightWorldX/Y)", () => {
  const staleItem = { type: "demo_god_rays", x: 60, y: 60, w: 1000, h: 620, z: 200, lightWorldX: 100, lightWorldY: 100 };
  const doc = { slides: [{ delta: { items: { a: staleItem } } }] };
  const report = missingDefaults(doc, registry).find((r) => r.id === "a");
  const missingPaths = report ? report.missing.map((m) => m.path.join(".")) : [];
  assert.ok(!missingPaths.includes("rotationAnchor.x"), "rotationAnchor.x has a real derive.js fallback and must stay exempt");
  assert.ok(!missingPaths.includes("rotationAnchor.y"), "rotationAnchor.y has a real derive.js fallback and must stay exempt");
});

// ── (3) THE LANDING BAR: emit() never hands materialBackdrop a non-finite param ──

test("emit() on an item with NaN lightWorldX/Y degrades to the widget's own centre and WARNS ONCE PER FIELD, naming the item", () => {
  const state = {
    ...godRaysPlugin.defaults, id: "a1", x: 0, y: 0, w: 1000, h: 600,
    lightWorldX: NaN, lightWorldY: NaN,
    samples: 64, density: 0.9, decay: 0.96, weight: 0.1, exposure: 0.1,
    threshold: 0.62, maskSoftness: 0.18, maskStrength: 1, dither: 1, tint: "#ffffff",
  };
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  let ops;
  try {
    ops = godRaysPlugin.emit(state);
  } finally {
    console.warn = orig;
  }
  assert.equal(ops[0].op, "materialBackdrop", "must not throw — a red box is exactly what this test guards against");
  assert.equal(ops[0].params.lightOffsetX, 0, "falls back to the region's own centre (offset 0,0)");
  assert.equal(ops[0].params.lightOffsetY, 0);
  assert.equal(warnings.length, 2, "one warning per non-finite field");
  assert.match(warnings[0], /demo_god_rays a1/, "the item must be named");
  assert.match(warnings[0], /lightOffsetX/);
  assert.match(warnings[1], /lightOffsetY/);
});

test("emit() on a well-formed item never warns — no false positives from the guard", () => {
  const state = { items: { a: { ...godRaysPlugin.defaults, id: "a" } }, vars: {} };
  const { state: evaluated } = evaluateState(state, registry, "");
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    godRaysPlugin.emit(evaluated.items.a);
  } finally {
    console.warn = orig;
  }
  assert.deepEqual(warnings, []);
});

test("lens_flare shares the SAME structural hole (NaN lightWorldX/Y) and gets the SAME guard", () => {
  const state = { ...lensFlarePlugin.defaults, id: "f1", x: 0, y: 0, w: 1000, h: 600, lightWorldX: NaN, lightWorldY: NaN };
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  let ops;
  try {
    ops = lensFlarePlugin.emit(state, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  } finally {
    console.warn = orig;
  }
  assert.ok(ops.length >= 1, "must not throw");
  const fillOp = JSON.stringify(ops).includes("materialFill");
  assert.ok(fillOp, "materialFill op must still be produced");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /demo_lens_flare f1/);
});
